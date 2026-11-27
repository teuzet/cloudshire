/**
 * Приказ как правка: на старте этапа узкий агент говорит, как готовый результат повлияет на то,
 * что идёт рядом; код проверяет это, считает цену и дописывает ставку дела.
 */

import type { City, Front, FrontLink, Hold, Resist, StakeOp, WorldObject } from '../core/city.js';
import { FORM_WORDS, HELD_WORDS } from '../core/world/changes.js';
import { activeFronts, frontGist, frontObjectIds } from '../core/world/fronts.js';
import { ownMotion } from '../core/world/hold.js';
import { linkLines } from '../core/world/links.js';
import { onSite, WILLED } from '../core/world/resist.js';
import { nearFronts, planLinks, type PatchLinks } from '../core/world/patch.js';
import { findObject } from '../core/world/objects.js';
import { appraiseInfluence, type Influence } from '../agents/influence-appraiser/run.js';
import { fitRole } from '../agents/role-fitter/run.js';
import { briefOf } from './briefs.js';
import { tryAgent, type FlowDeps } from './context.js';

const SIDES_MAX = 8;
const HELPS_MAX = 4;

export interface PatchPlan extends PatchLinks {
  /** Кому из сторон рядом результат вредит и кому помогает. */
  sides: Influence['sides'];
}

const NONE: PatchPlan = { links: [], holds: [], ops: [], price: 0, dropped: [], released: [], sides: [] };

/**
 * Стороны рядом с правкой: с волей и в строю. Первыми те, что стоят на месте работ (только они
 * могут сопротивляться), потом участники того, что идёт в городе.
 */
function sidesNear(city: City, objectIds: readonly string[], fronts: readonly Front[]): WorldObject[] {
  const willed = (obj: WorldObject | null | undefined): obj is WorldObject => Boolean(obj && obj.status === 'active' && !obj.temporary && !obj.out && WILLED.includes(obj.type));
  const out = new Map<string, WorldObject>();
  // Скрытые стороны тоже здесь: они сопротивляются, хотя жрец о них не знает.
  for (const obj of city.objects) if (willed(obj) && onSite(city, obj.id, objectIds)) out.set(obj.id, obj);
  for (const f of fronts) {
    for (const id of frontObjectIds(f)) {
      const obj = findObject(city, id);
      if (willed(obj)) out.set(obj.id, obj);
    }
  }
  return [...out.values()].slice(0, SIDES_MAX);
}

/**
 * Как результат этапа повлияет на идущее рядом. `objectIds` — объекты правки: то, что она меняет,
 * и то, с чем работа связана. `anchor` — останется ли вещь, которая может держать.
 * Фронты из `settled` уже решены самой правкой (живут на том, что она убирает): о них не спрашивают.
 * `later` — следующие шаги замысла: чего результат достигнет только вместе с ними, посчитают при них.
 */
export async function influenceOf(
  deps: FlowDeps,
  city: City,
  args: {
    work: string;
    result: string;
    cause: string;
    objectIds: string[];
    named: string | null;
    settled: string[];
    anchor: boolean;
    day: number;
    later?: string[];
    shielded?: string[];
    workers?: string[];
    follows?: string[];
    /** Изменяемый объект и то, что он держит сейчас: оценщик решает, держит ли он это и после правки. */
    held?: { objectId: string; holds: readonly Hold[] };
  },
): Promise<PatchPlan> {
  // Свои задания при делах сюда не входят: на них влияют через само дело.
  const own = activeFronts(city)
    .filter((f) => f.origin === 'deed')
    .map((f) => f.id);
  const held = args.held?.holds.length ? args.held : undefined;
  const heldIds = new Set(held?.holds.map((h) => h.frontId) ?? []);
  const holder = held ? findObject(city, held.objectId) : null;
  // То, что изменяемое держит сейчас, оценщик видит первым: без этого правка «перерубить цепи» держала бы их и дальше.
  const near = nearFronts(city, args.objectIds, { named: args.named, except: [...args.settled, ...own], first: [...heldIds] });
  // Те, кого работа занимает, её и делают: о них оценщика не спрашивают.
  const sides = sidesNear(city, args.objectIds, near).filter((o) => !(args.workers ?? []).includes(o.id));
  if (!near.length && !sides.length) return NONE;
  const nowWords = (f: Front): string | null => {
    const hold = held?.holds.find((h) => h.frontId === f.id);
    if (!hold || !holder) return null;
    const words = HELD_WORDS[ownMotion(f)][hold.effect](frontGist(f), holder.name);
    return `${words}${hold.word ? ' (держится на слове)' : ''}`;
  };
  const said = await tryAgent<Influence>(
    deps,
    'influence-appraiser',
    () =>
      appraiseInfluence(deps.agents, {
        work: args.work,
        result: args.result,
        nearby: near.map((f) => {
          const carrier = f.livesOn ? findObject(city, f.livesOn) : null;
          return {
            id: f.id,
            kind: f.plus ? 'удобный случай' : FORM_WORDS[f.form],
            people: ownMotion(f) === 'work',
            description: f.description || f.title,
            carrier: carrier && carrier.status === 'active' && !carrier.hidden ? carrier.name : null,
            // Ходы из заготовок бывают целыми фразами: в перечень они идут без точки на конце.
            helps: (f.key?.moves ?? []).slice(0, HELPS_MAX).map((m) => m.trim().replace(/[.,;:]+$/, '')).filter(Boolean),
            now: nowWords(f),
          };
        }),
        sides: sides.map((o) => briefOf(o)),
        later: args.later ?? [],
        follows: args.follows ?? [],
      }),
    // Оценщик не ответил: изменённое держит то же, что держало, а не отпускает всё разом.
    { links: (held?.holds ?? []).map((h) => ({ frontId: h.frontId, effect: h.effect, word: Boolean(h.word) })), sides: [], reason: '' },
  );
  if (!said.links.length && !said.sides.length && !held) return NONE;
  const plan = planLinks(deps.rules, city, said.links, { anchor: args.anchor, cause: args.cause, day: args.day, shielded: args.shielded ?? [], held });
  // Влияние названо, а исполнить его нечем: это пробел словаря, он идёт в лог для разбора.
  // То, что фронту просто ничего не меняет (обезопасить и без того спокойное), пробелом не считается.
  const gaps = plan.dropped.filter((d) => d.why !== 'no_effect');
  if (gaps.length) deps.log?.warn('influence_gap', { cityId: city.id, work: args.work, dropped: gaps, reason: said.reason });
  return { ...plan, sides: said.sides };
}

/** Дописать влияния в ставку: якоря к новому объекту или к изменённому, закрытия после результата. */
export function withLinks(stake: readonly StakeOp[], plan: PatchLinks, targetId: string | null): StakeOp[] {
  const out: StakeOp[] = [];
  let anchored = !plan.holds.length;
  for (const op of stake) {
    if (!anchored && op.op === 'create' && op.result) {
      out.push({ ...op, object: { ...op.object, holds: [...(op.object.holds ?? []), ...plan.holds] } });
      anchored = true;
      continue;
    }
    out.push(op);
  }
  if (!anchored && targetId) for (const hold of plan.holds) out.push({ op: 'hold', target: targetId, ...hold });
  return [...out, ...plan.ops];
}

/** Что изменится, когда дело будет готово: словами мира, для ответа жреца. */
export function linkWords(city: City, links: readonly FrontLink[], name: string): string {
  const lines = linkLines(city, links, name);
  return lines.length ? `Когда будет готово: ${lines.join('; ')}.` : '';
}

// ───────────────────────────── сопротивление ─────────────────────────────

/**
 * Кто будет сопротивляться делу: стороны, которым готовый результат во вред и которые стоят на месте работ.
 * Если в приказе назван способ, узкий агент для каждой отвечает, сможет ли она помешать работе, если вести её так.
 */
export async function resistOf(
  deps: FlowDeps,
  city: City,
  args: { plan: Pick<PatchPlan, 'sides'>; objectIds: readonly string[]; work: string; result: string; manner: string | null },
): Promise<Resist[]> {
  const resist: Resist[] = [];
  for (const side of args.plan.sides) {
    if (side.stance === 'harms' && onSite(city, side.objectId, args.objectIds)) resist.push({ objectId: side.objectId, answered: false });
  }
  return answerResist(deps, city, resist, args);
}

/** Пересмотреть сопротивление под способ работы: способ без слов ничего не снимает. */
export async function answerResist(
  deps: FlowDeps,
  city: City,
  resist: readonly Resist[],
  args: { work: string; result: string; manner: string | null },
): Promise<Resist[]> {
  const manner = args.manner?.trim();
  if (!manner) return resist.map((r) => ({ ...r, answered: false }));
  const out: Resist[] = [];
  for (const r of resist) {
    const side = findObject(city, r.objectId);
    if (!side) continue;
    const can = await tryAgent(
      deps,
      'role-fitter',
      () =>
        fitRole(deps.agents, {
          question: 'Сможет ли эта сторона помешать работе, если вести её так?',
          subject: `${side.name}: ${side.description}`,
          context: `Работа: ${args.work} Готовый результат этой стороне во вред: ${args.result} Как ведут работу: ${manner}`,
        }),
      { fits: true, reason: '' },
    );
    out.push({ objectId: r.objectId, answered: !can.fits });
  }
  return out;
}

/** Кто против дела, словами для жреца. Скрытых жрец не знает. */
export function resistWords(city: City, resist: readonly Resist[]): string {
  const named = (answered: boolean) =>
    resist
      .filter((r) => r.answered === answered)
      .map((r) => findObject(city, r.objectId))
      .filter((o): o is WorldObject => Boolean(o && o.status === 'active' && !o.hidden))
      .map((o) => o.name);
  const against = named(false);
  const held = named(true);
  return [
    against.length ? `Готовое во вред тем, кто рядом, и они будут мешать работе: ${against.join(', ')}.` : '',
    held.length ? `Против и ${held.join(', ')}, но так, как велено вести работу, помешать им не удастся.` : '',
  ]
    .filter(Boolean)
    .join(' ');
}
