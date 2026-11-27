/**
 * Приказ как правка: на старте этапа узкий агент говорит, как готовый результат повлияет на то,
 * что идёт рядом; код проверяет это, считает цену и дописывает ставку дела.
 */

import type { City, Front, FrontLink, StakeOp, WorldObject } from '../core/city.js';
import type { ObjectType } from '../core/rules.js';
import { FORM_WORDS } from '../core/world/changes.js';
import { activeFronts, frontObjectIds } from '../core/world/fronts.js';
import { ownMotion } from '../core/world/hold.js';
import { linkLines } from '../core/world/links.js';
import { nearFronts, planLinks, type PatchLinks } from '../core/world/patch.js';
import { findObject } from '../core/world/objects.js';
import { appraiseInfluence, type Influence } from '../agents/influence-appraiser/run.js';
import { briefOf } from './briefs.js';
import { tryAgent, type FlowDeps } from './context.js';

/** У кого есть своя воля: такие стороны могут выиграть или потерять от правки. */
const WILLED: readonly ObjectType[] = ['community', 'organization', 'person', 'threat'];
const SIDES_MAX = 8;
const HELPS_MAX = 4;

export interface PatchPlan extends PatchLinks {
  /** Кому из сторон рядом результат вредит и кому помогает. */
  sides: Influence['sides'];
}

const NONE: PatchPlan = { links: [], holds: [], ops: [], price: 0, dropped: [], sides: [] };

/** Стороны рядом с правкой: с волей, открытые, в строю. */
function sidesNear(city: City, objectIds: readonly string[], fronts: readonly Front[]): WorldObject[] {
  const ids = new Set<string>(objectIds);
  for (const f of fronts) for (const id of frontObjectIds(f)) ids.add(id);
  const out: WorldObject[] = [];
  for (const id of ids) {
    const obj = findObject(city, id);
    if (obj && obj.status === 'active' && !obj.hidden && !obj.temporary && !obj.out && WILLED.includes(obj.type)) out.push(obj);
  }
  return out.slice(0, SIDES_MAX);
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
  args: { work: string; result: string; cause: string; objectIds: string[]; named: string | null; settled: string[]; anchor: boolean; day: number; later?: string[] },
): Promise<PatchPlan> {
  // Свои задания при делах сюда не входят: на них влияют через само дело.
  const own = activeFronts(city)
    .filter((f) => f.origin === 'deed')
    .map((f) => f.id);
  const near = nearFronts(city, args.objectIds, { named: args.named, except: [...args.settled, ...own] });
  if (!near.length) return NONE;
  const sides = sidesNear(city, args.objectIds, near);
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
          };
        }),
        sides: sides.map((o) => briefOf(o)),
        later: args.later ?? [],
      }),
    { links: [], sides: [], reason: '' },
  );
  if (!said.links.length && !said.sides.length) return NONE;
  const plan = planLinks(deps.rules, city, said.links, { anchor: args.anchor, cause: args.cause, day: args.day });
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
