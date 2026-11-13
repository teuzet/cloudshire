/**
 * День города: разобрать задания, чей срок наступил, в порядке наступления.
 *
 *   front_event — ближайшее событие фронта: веха, завершение, срок или месячный бросок;
 *   seed        — проверить, хватает ли городу живых историй.
 *
 * Время не тикает: задание стоит на дне, когда фронт дойдёт до события при нынешней
 * скорости. Скорость меняется — задание переставляется.
 */

import type { City, Front, Job, StakeOp, World, WorldObject } from '../core/city.js';
import { claimJob, completeJob, dueJobs, failJob, pruneJobs, recoverRunningJobs } from '../core/jobs.js';
import { accrueMana } from '../core/mana.js';
import { DAYS_PER_MONTH } from '../core/time.js';
import { describeChanges, type Change } from '../core/world/changes.js';
import { tensionToThreat } from '../core/world/complications.js';
import { dueEvent, findFront, frontGist, frontObjectIds, neighbors, closeFront, settleProgress, shareDone } from '../core/world/fronts.js';
import { attachedTo, findObject, deleteWithChildren, scalePull } from '../core/world/objects.js';
import { applyStake } from '../core/world/stake.js';
import { themeNames } from '../core/world/themes.js';
import type { OutboundMessage } from '../ports/notifier.js';
import type { ObjectBrief } from '../agents/_shared/blocks.js';
import { judgeAlignment } from '../agents/alignment-judge/run.js';
import { writeBeat, type Beat } from '../agents/beat-writer/run.js';
import { rewriteDescription } from '../agents/description-rewriter/run.js';
import { resolveEvent, type Resolution } from '../agents/resolver/run.js';
import { tagThemes } from '../agents/theme-tagger/run.js';
import { appraise, briefOf, leadLabel, situationOf, workWords } from './briefs.js';
import { record, type Happening } from './chronicle.js';
import { complicateRolled, describeHits, refreshAfterChange, resolveModify, rollFor, rollForFailure } from './complications.js';
import { newId, requireWorld, sendAll, today, tryAgent, type FlowDeps } from './context.js';
import { faithEvent, refreshAllFronts, willWords } from './fronts.js';
import { seedStories } from './seeding.js';

/** Сколько заданий разбирать за один проход, чтобы проход не тянулся вечно. */
const MAX_JOBS_PER_PASS = 50;
const MAX_PARTICIPANTS = 6;
/** Скольким соседним делам предложить готовый результат в помощь. */
const MAX_NEIGHBORS = 2;

function stakeCtx(deps: FlowDeps, front: Pick<Front, 'id' | 'scale'>, day: number) {
  return { day, newId: (p: string) => newId(deps, p), frontId: front.id, pull: scalePull(deps.rules, front.scale, day) };
}

/** Кого событие касается: объекты отпечатка, участники, цели ставок. Без места работ. */
function participants(city: City, front: Front): ObjectBrief[] {
  return frontObjectIds(front)
    .filter((id) => id !== front.siteId)
    .map((id) => findObject(city, id))
    .filter((o): o is WorldObject => Boolean(o) && o?.status === 'active' && !o.hidden)
    .slice(0, MAX_PARTICIPANTS)
    .map(briefOf);
}

/** Что получится в конце, словами: чтобы вехи вели к результату. */
function resultWords(city: City, front: Front): string | null {
  for (const op of front.stake) {
    if (op.op === 'create') return `${op.object.name}. ${op.object.description}`;
    if (op.op === 'fact') return op.text;
    if (op.op === 'attach') return `делу помогут: ${op.object.name}. ${op.object.description}`;
    if (op.op === 'reveal') {
      const hidden = findObject(city, op.target);
      if (hidden) return `откроется: ${hidden.name}. ${hidden.description}`;
      continue;
    }
    if (op.op === 'progress') {
      const pushed = findFront(city, op.frontId);
      if (!pushed || pushed.status !== 'active') continue;
      return `шаг к развязке «${pushed.title}»`;
    }
    if (op.op === 'revalue' || op.op === 'modify' || op.op === 'delete') {
      const target = findObject(city, op.target);
      if (!target) continue;
      if (op.op === 'delete') return `${target.name} исчезнет`;
      return `${target.name} изменится${op.op === 'modify' ? (op.intent ? `: ${op.intent}` : '') : op.description ? `: ${op.description}` : ''}`;
    }
  }
  return null;
}

/** Что случилось по ставке, словами кода: Развязчик пишет вокруг этого. */
function consequenceWords(city: City, ops: readonly StakeOp[]): string | null {
  const parts: string[] = [];
  for (const op of ops) {
    switch (op.op) {
      case 'revalue':
        parts.push(`задето: ${findObject(city, op.target)?.name ?? 'часть города'}`);
        break;
      case 'delete':
        parts.push(`утрачено: ${findObject(city, op.target)?.name ?? 'часть города'}`);
        break;
      case 'create':
        parts.push(`появилось: ${op.object.name}`);
        break;
      case 'rollback':
        parts.push('дело, которому это грозило, откатилось на шаг назад');
        break;
      case 'cancel':
        parts.push('дело, которому это грозило, остановлено');
        break;
      case 'attach':
        parts.push(op.rate < 0 ? `делу теперь мешает: ${op.object.name}` : `делу теперь помогает: ${op.object.name}`);
        break;
      case 'fact':
        parts.push(`стало известно: ${op.text}`);
        break;
      case 'stats':
        parts.push('город ощутил это на себе');
        break;
      default:
        break;
    }
  }
  return parts.length ? parts.join('; ') : null;
}

/** Проект, чьё дело оборвалось, тоже оборван. */
function syncProjects(city: City): void {
  for (const project of city.projects) {
    if (project.status !== 'running' || !project.frontId) continue;
    const front = findFront(city, project.frontId);
    if (front && front.status === 'active') continue;
    project.status = 'cancelled';
    project.frontId = null;
  }
}

/** Одно последствие развязки, которое выбрал Развязчик, исполняет код. */
async function applyEffect(deps: FlowDeps, city: City, front: Front, resolution: Resolution, day: number): Promise<Change[]> {
  const ctx = stakeCtx(deps, front, day);
  if (resolution.effect === 'fact') return applyStake(deps.rules, city, [{ op: 'fact', text: resolution.fact }], ctx).changes;
  if (resolution.effect === 'link') return applyStake(deps.rules, city, [{ op: 'link', a: resolution.a, b: resolution.b }], ctx).changes;
  if (resolution.effect === 'gone') return applyStake(deps.rules, city, [{ op: 'delete', target: resolution.objectId }], ctx).changes;
  if (resolution.effect === 'trace') {
    const { points } = await appraise(deps, city, resolution.trace);
    return applyStake(deps.rules, city, [{ op: 'create', object: { ...resolution.trace, points, refs: front.footprint.map((f) => f.objectId) } }], ctx).changes;
  }
  return [];
}

/**
 * Записать случившееся и обновить дела, которых коснулась перемена.
 * `source` — перемены самой ставки: обновление идёт только от них, а не от осложнений,
 * которые родились в том же событии. Сами перемены новых фронтов не рождают:
 * последствия рождает фронт в свои моменты (веха, завершение, срыв) через словарь динамик.
 */
async function finish(deps: FlowDeps, city: City, h: Happening, source: readonly Change[], except: string[], out: OutboundMessage[]): Promise<void> {
  syncProjects(city);
  const msg = await record(deps, city, h);
  if (msg) out.push(msg);
  const lines = describeChanges(deps.rules, source);
  await refreshAfterChange(deps, city, source, except, lines.length ? lines.join('. ') : h.gist, h.day);
}

// ───────────────────────────── веха ─────────────────────────────

/** Последние записи хроники об этом деле: новая веха продолжает их, а не пересказывает. */
function earlierBeats(city: City, front: Front): string[] {
  // Осложнение родилось из родителя: его прошлое — и последние записи родителя.
  const ids = new Set([front.id, ...(front.parentId ? [front.parentId] : [])]);
  // Побочная беда без родителя: её рождение записано днём появления.
  return city.chronicle
    .filter((e) => (e.frontId != null && ids.has(e.frontId)) || (front.origin === 'complication' && e.day === front.createdDay))
    .slice(-3)
    .map((e) => e.text);
}

async function onMilestone(deps: FlowDeps, city: City, front: Front, day: number, out: OutboundMessage[]): Promise<void> {
  front.milestonesFired += 1;
  const lead = leadLabel(city, front);
  // Работа над посаженной историей сначала находит улики, потом застаёт события.
  const clue = front.script?.clues.find((c) => !c.revealed) ?? null;
  const event = clue ? null : (front.script?.events.find((e) => !e.fired) ?? null);
  const reveal = clue?.fact ?? event?.description ?? null;
  const beat = await tryAgent<Beat>(
    deps,
    'beat-writer',
    () =>
      writeBeat(deps.agents, {
        title: frontGist(front),
        description: workWords(front),
        share: shareDone(front, day),
        lead: lead.label,
        manner: lead.manner,
        result: front.unattainable ? null : resultWords(city, front),
        reveal,
        allowed: reveal ? ['none', 'reveal'] : ['none'],
        before: earlierBeats(city, front),
      }),
    { text: reveal ?? `Работа идёт: ${frontGist(front)}.`, effect: reveal ? 'reveal' : 'none' },
  );
  const changes: Change[] = [];
  if (beat.effect === 'reveal') {
    if (event) event.fired = true;
    if (clue) {
      clue.revealed = true;
      changes.push(...applyStake(deps.rules, city, [{ op: 'fact', text: clue.fact }], stakeCtx(deps, front, day)).changes);
    }
  }
  const rolled = front.origin === 'player' ? rollFor(deps, city, front) : null;
  const trouble = await complicateRolled(deps, city, front, rolled, { moment: 'milestone' }, day);
  if (trouble) changes.push(...trouble.changes);
  const msg = await record(deps, city, {
    gist: [beat.text, trouble?.gist].filter(Boolean).join(' '),
    changes,
    source: 'milestone',
    frontId: front.id,
    day,
    kind: 'beat',
    officer: lead.officer,
    announce: true,
  });
  if (msg) out.push(msg);
}

// ───────────────────────────── завершение ─────────────────────────────

/** Беду отвели: угроза снята или напряжение погашено до прорыва. */
function hiddenRefs(city: City, front: Front): WorldObject[] {
  return front.refs.flatMap((id) => {
    const o = findObject(city, id);
    return o && o.status === 'active' && o.hidden ? [o] : [];
  });
}

async function avert(deps: FlowDeps, city: City, front: Front, day: number, out: OutboundMessage[]): Promise<void> {
  const lead = leadLabel(city, front);
  const will = willWords(city, front);
  // Скрытый виновник осложнения открывается, когда беду отвели: тайна осложнения в этом и состоит.
  const unmasked = front.origin === 'complication' ? applyStake(deps.rules, city, hiddenRefs(city, front).map((o) => ({ op: 'reveal' as const, target: o.id })), stakeCtx(deps, front, day)).changes : [];
  const culprits = unmasked.flatMap((c) => (c.kind === 'object_revealed' ? [`${c.name}: ${c.description ?? ''}`.trim()] : []));
  const description = culprits.length ? `${front.description} Выяснилось, кто за этим стоял: ${culprits.join('; ')}.` : front.description;
  const helpers = attachedTo(city, front.id).filter((o) => o.temporary && (o.attach?.rate ?? 0) > 0);
  const people = [...participants(city, front), ...helpers.map(briefOf)];
  const resolution = await tryAgent<Resolution>(
    deps,
    'resolver',
    () =>
      resolveEvent(deps.agents, {
        before: earlierBeats(city, front),
        title: frontGist(front),
        description,
        ending: 'averted',
        consequence: null,
        participants: people,
        keepable: helpers.map((h) => h.id),
        lead: lead.label,
        manner: lead.manner,
        allowed: ['none', 'fact', 'gone', ...(people.length >= 2 ? (['link'] as const) : []), ...(helpers.length ? (['keep'] as const) : [])],
      }),
    { text: `Обошлось: ${frontGist(front)}.`, effect: 'none' },
  );
  const changes: Change[] = [...unmasked];
  // Того, кого решено оставить городу, надо отвязать до закрытия фронта: иначе он исчезнет вместе с ним.
  if (resolution.effect === 'keep') {
    const kept = findObject(city, resolution.objectId);
    if (kept && kept.status === 'active') {
      kept.temporary = false;
      kept.attach = null;
      kept.parentId = null;
      kept.freshDay = day;
      changes.push({ kind: 'object_created', objectId: kept.id, name: kept.name, type: kept.type, points: { prosperity: 0, security: 0, knowledge: 0, influence: 0 }, temporary: false, hidden: false });
    }
  }
  changes.push(...closeFront(deps.rules, city, front, 'done', day, { outcome: 'averted' }));
  changes.push(...(await applyEffect(deps, city, front, resolution, day)));
  await faithEvent(deps, city, { event: resolution.text, will, day });
  await finish(deps, city, { gist: resolution.text, changes, source: 'completion', frontId: front.id, day, kind: 'resolution', officer: lead.officer, announce: true }, changes, [front.id], out);
}

/** Атомарное дело сделано: его ставка двигает родителя, а бросок риска идёт против родителя. */
async function completeDeed(deps: FlowDeps, city: City, front: Front, day: number, out: OutboundMessage[]): Promise<void> {
  const parent = front.parentId ? findFront(city, front.parentId) : null;
  const target = parent && parent.status === 'active' ? parent : null;
  const lead = leadLabel(city, front);
  const result = resultWords(city, front);
  const rolled = target && target.origin === 'player' ? rollFor(deps, city, front, target) : null;
  const changes = closeFront(deps.rules, city, front, 'done', day);
  changes.push(...applyStake(deps.rules, city, front.stake, stakeCtx(deps, target ?? front, day)).changes);
  // Задание — часть большого дела: в списке перемен и в сути видно, что большое дело идёт дальше.
  if (target && !changes.some((c) => c.kind === 'front_moved' && c.frontId === target.id)) changes.push({ kind: 'front_moved', frontId: target.id, title: frontGist(target), how: front.stake.some((op) => op.op === 'progress') ? 'pushed' : front.stake.some((op) => op.op === 'delete') ? 'cleared' : 'helped' });
  // Задание приближает большое дело, но не решает его: найденное и узнанное приходит только с вехами большого дела.
  const description = target
    ? `${front.description}. Это шаг в работе над «${target.title}»: ответ и итог «${target.title}» ещё впереди.`
    : front.description;
  const beat = await tryAgent<Beat>(
    deps,
    'beat-writer',
    () => writeBeat(deps.agents, { title: frontGist(front), description, share: 1, lead: lead.label, manner: lead.manner, result, reveal: null, allowed: ['none'] }),
    { text: `Сделано: ${frontGist(front)}.`, effect: 'none' },
  );
  const trouble = target ? await complicateRolled(deps, city, target, rolled, { moment: 'milestone' }, day) : null;
  await finish(
    deps,
    city,
    { gist: [beat.text, trouble?.gist].filter(Boolean).join(' '), changes: [...changes, ...(trouble?.changes ?? [])], source: 'completion', frontId: target?.id ?? front.id, day, kind: 'beat', officer: lead.officer, announce: true },
    changes,
    [front.id, ...(target ? [target.id] : [])],
    out,
  );
}

/** Недостижимое дело дошло до последней вехи: крах со следом. */
async function collapse(deps: FlowDeps, city: City, front: Front, day: number, out: OutboundMessage[]): Promise<void> {
  const lead = leadLabel(city, front);
  const resolution = await tryAgent<Resolution>(
    deps,
    'resolver',
    () =>
      resolveEvent(deps.agents, {
        before: earlierBeats(city, front),
        title: frontGist(front),
        description: front.description,
        ending: 'collapsed',
        consequence: front.unattainable,
        participants: participants(city, front),
        keepable: [],
        lead: lead.label,
        manner: lead.manner,
        allowed: ['fact', 'trace'],
      }),
    { text: `Затея рухнула: ${frontGist(front)}. ${front.unattainable ?? ''}`.trim(), effect: 'none' },
  );
  const changes = closeFront(deps.rules, city, front, 'failed', day);
  changes.push(...(await applyEffect(deps, city, front, resolution, day)));
  await faithEvent(deps, city, { event: resolution.text, will: 'Дело велел бог, хотя его предупреждали, что довести его до конца город не сможет.', day });
  await finish(deps, city, { gist: resolution.text, changes, source: 'completion', frontId: front.id, day, kind: 'resolution', officer: lead.officer, announce: true }, changes, [front.id], out);
}

/** Исход с подвохом: результат выходит не таким, как ждали. Переписчик и Оценщик вклада дают, каким именно. */
async function applyTwist(deps: FlowDeps, city: City, ops: readonly StakeOp[], twist: string): Promise<StakeOp[]> {
  const out: StakeOp[] = [];
  const rewrite = (name: string, description: string) =>
    tryAgent(deps, 'description-rewriter', () => rewriteDescription(deps.agents, { name, description, change: twist }), description);
  for (const op of ops) {
    if (op.op === 'create' && op.result) {
      const description = await rewrite(op.object.name, op.object.description);
      const { points } = await appraise(deps, city, { type: op.object.type, name: op.object.name, description }, { points: op.object.points, event: twist });
      out.push({ ...op, object: { ...op.object, description, points } });
    } else if (op.op === 'revalue') {
      const target = findObject(city, op.target);
      if (!target) continue;
      const description = await rewrite(target.name, op.description ?? target.description);
      const { points } = await appraise(deps, city, { type: target.type, name: target.name, description }, { points: op.points, event: twist });
      out.push({ ...op, points, description });
    } else {
      out.push(op);
    }
  }
  out.push({ op: 'fact', text: twist });
  return out;
}

/** Готовый результат может оказаться кстати соседнему делу: тогда он становится его постоянным помощником. */
async function offerHelp(deps: FlowDeps, city: City, result: WorldObject, near: readonly Front[]): Promise<Change[]> {
  for (const front of near) {
    if (front.status !== 'active' || result.attach) break;
    const moves = front.key?.moves ?? [];
    if (!moves.length) continue;
    const ruling = await tryAgent(
      deps,
      'alignment-judge',
      () => judgeAlignment(deps.agents, { situation: situationOf(front), moves, proposal: `В городе появилось новое, и его пускают в ход: ${result.name}. ${result.description}` }),
      { verdict: 'fits' as const, matchedMove: null },
    );
    if (ruling.verdict !== 'spot_on') continue;
    result.attach = { frontId: front.id, rate: deps.rules.fronts.helper.unitsPerMonth };
    return [{ kind: 'front_moved', frontId: front.id, title: frontGist(front), how: 'helped' }];
  }
  return [];
}

/** Шкала заполнена: дело, поиск или удобный случай приносят свою ставку. */
async function complete(deps: FlowDeps, city: City, front: Front, day: number, out: OutboundMessage[]): Promise<void> {
  const lead = leadLabel(city, front);
  const will = willWords(city, front);
  const expected = resultWords(city, front);
  const rolled = front.origin === 'player' ? rollFor(deps, city, front) : null;
  const twist = front.key?.twist ?? null;
  let ops = await resolveModify(deps, city, front.stake, (front.description || frontGist(front)));
  if (twist) ops = await applyTwist(deps, city, ops, twist);
  const near = neighbors(city, front)
    .filter((n) => n.capacity > 0)
    .slice(0, MAX_NEIGHBORS);

  const changes = closeFront(deps.rules, city, front, 'done', day);
  const applied = applyStake(deps.rules, city, ops, stakeCtx(deps, front, day));
  changes.push(...applied.changes);
  const result = applied.resultId ? findObject(city, applied.resultId) : null;
  if (result) {
    result.themes = await tryAgent(deps, 'theme-tagger', () => tagThemes(deps.agents, { subject: briefOf(result), themes: themeNames(city) }), []);
  }

  const project = front.projectId ? (city.projects.find((p) => p.id === front.projectId) ?? null) : null;
  let finished = true;
  if (project) {
    project.frontId = null;
    project.stageIndex += 1;
    finished = project.stageIndex >= project.stages.length;
    project.status = finished ? 'done' : 'waiting';
  }
  const next = project && !finished ? project.stages[project.stageIndex] : null;

  const beat = await tryAgent<Beat>(
    deps,
    'beat-writer',
    () =>
      writeBeat(deps.agents, {
        title: frontGist(front),
        description: front.description,
        share: 1,
        lead: lead.label,
        manner: lead.manner,
        result: expected,
        reveal: twist,
        allowed: twist ? ['reveal'] : ['none'],
      }),
    { text: `Сделано: ${frontGist(front)}.${twist ? ` ${twist}` : ''}`, effect: 'none' },
  );
  await faithEvent(deps, city, { event: beat.text, will, day });
  const trouble = await complicateRolled(deps, city, front, rolled, { moment: 'completion', resultId: applied.resultId }, day);
  const helped = result ? await offerHelp(deps, city, result, near) : [];

  const gist = [beat.text, trouble?.gist, next && project ? `Замысел «${project.title}» ждёт слова покровителя. Следующий шаг: ${next.title}.` : null].filter(Boolean).join(' ');
  await finish(
    deps,
    city,
    { gist, changes: [...changes, ...(trouble?.changes ?? []), ...helped], source: 'completion', frontId: front.id, day, kind: finished ? 'resolution' : 'beat', officer: lead.officer, announce: true },
    changes,
    [front.id],
    out,
  );
}

async function onCompletion(deps: FlowDeps, city: City, front: Front, day: number, out: OutboundMessage[]): Promise<void> {
  front.milestonesFired = front.milestones;
  if (front.form === 'threat' || front.form === 'tension') return avert(deps, city, front, day, out);
  if (front.origin === 'deed') return completeDeed(deps, city, front, day, out);
  if (front.unattainable) return collapse(deps, city, front, day, out);
  return complete(deps, city, front, day, out);
}

// ───────────────────────────── срок ─────────────────────────────

/** Беда случилась (или пришёл час отложенной перемены): ставка исполняется. */
async function strike(deps: FlowDeps, city: City, front: Front, stake: readonly StakeOp[], status: 'failed' | 'done', day: number, out: OutboundMessage[]): Promise<void> {
  const lead = leadLabel(city, front);
  const will = willWords(city, front);
  const event = front.outburst ?? front.description;
  const ops = await describeHits(deps, city, await resolveModify(deps, city, stake, event), event);
  const people = participants(city, front);
  const resolution = await tryAgent<Resolution>(
    deps,
    'resolver',
    () =>
      resolveEvent(deps.agents, {
        before: earlierBeats(city, front),
        title: frontGist(front),
        description: front.description,
        ending: 'struck',
        consequence: consequenceWords(city, ops),
        participants: people,
        keepable: [],
        lead: lead.label,
        manner: lead.manner,
        allowed: ['none', 'fact', ...(people.length >= 2 ? (['link'] as const) : [])],
      }),
    { text: event, effect: 'none' },
  );
  const changes = closeFront(deps.rules, city, front, status, day, { outcome: 'failed' });
  // Беда выводит объекты из строя, а не стирает: их можно вернуть делом. Что утрачено
  // безвозвратно, решил Развязчик; такое уходит из города и остаётся только в памяти.
  changes.push(...applyStake(deps.rules, city, ops, { ...stakeCtx(deps, front, day), trouble: front.title }).changes);
  for (const id of resolution.lostForever ?? []) {
    const obj = findObject(city, id);
    if (!obj?.out || obj.protected) continue;
    obj.out.forever = true;
    deleteWithChildren(city, obj, day);
  }
  changes.push(...(await applyEffect(deps, city, front, resolution, day)));
  await faithEvent(deps, city, { event: resolution.text, will, day });
  // Срыв — свой момент жизни фронта: беда может потянуть за собой новую.
  const trouble = status === 'failed' ? await complicateRolled(deps, city, front, rollForFailure(deps, city), { moment: 'failure' }, day) : null;
  const gist = [resolution.text, trouble?.gist].filter(Boolean).join(' ');
  await finish(
    deps,
    city,
    { gist, changes: [...changes, ...(trouble?.changes ?? [])], source: 'deadline', frontId: front.id, day, kind: 'resolution', officer: lead.officer, announce: true },
    changes,
    [front.id],
    out,
  );
}

async function onDeadline(deps: FlowDeps, city: City, front: Front, day: number, out: OutboundMessage[]): Promise<void> {
  // Удобный случай просто уходит.
  if (front.plus) {
    const changes = closeFront(deps.rules, city, front, 'cancelled', day, { outcome: 'expired' });
    await record(deps, city, { gist: `Случай упущен: ${frontGist(front)}.`, changes, source: 'deadline', frontId: front.id, day, kind: 'resolution', officer: null, announce: false });
    return;
  }
  if (front.form === 'clock') return strike(deps, city, front, front.stake, 'done', day, out);
  // Напряжение прорывается: мелкое сразу бьёт, остальное становится угрозой с коротким сроком.
  if (front.form === 'tension' && front.bound !== 'slow') {
    const parent = front.parentId ? findFront(city, front.parentId) : null;
    tensionToThreat(deps.rules, front, day);
    const changes: Change[] = [{ kind: 'front_moved', frontId: front.id, title: frontGist(front), how: 'burst' }];
    if (parent && parent.status === 'active' && front.bound) changes.push({ kind: 'front_moved', frontId: parent.id, title: frontGist(parent), how: 'frozen' });
    const msg = await record(deps, city, {
      gist: front.outburst ?? front.description,
      changes,
      source: 'deadline',
      frontId: front.id,
      day,
      kind: 'beat',
      officer: leadLabel(city, front).officer,
      announce: true,
    });
    if (msg) out.push(msg);
    return;
  }
  return strike(deps, city, front, front.failStake, 'failed', day, out);
}

// ───────────────────────────── месячный бросок ─────────────────────────────

async function onPulse(deps: FlowDeps, city: City, front: Front, day: number, out: OutboundMessage[]): Promise<void> {
  // Посаженная история развивается сама: её события наступают по времени, даже если никто не вмешался.
  if (front.script) {
    const event = front.script.events.find((e) => !e.fired) ?? null;
    if (event) event.fired = true;
    const left = front.script.events.filter((e) => !e.fired).length;
    front.pulseDay = left && front.deadlineDay != null ? day + Math.max(1, Math.floor((front.deadlineDay - day) / (left + 1))) : null;
    if (!event) return;
    const lead = leadLabel(city, front);
    const beat = await tryAgent<Beat>(
      deps,
      'beat-writer',
      () =>
        writeBeat(deps.agents, {
          title: frontGist(front),
          description: front.description,
          share: shareDone(front, day),
          lead: lead.label,
          manner: lead.manner,
          result: null,
          reveal: event.description,
          allowed: ['reveal'],
        }),
      { text: event.description, effect: 'reveal' },
    );
    const msg = await record(deps, city, { gist: beat.text, changes: [], source: 'scenario', frontId: front.id, day, kind: 'beat', officer: lead.officer, announce: true });
    if (msg) out.push(msg);
    return;
  }
  front.pulseDay = day + DAYS_PER_MONTH;
  if (front.origin !== 'player') return;
  const trouble = await complicateRolled(deps, city, front, rollFor(deps, city, front), { moment: 'milestone' }, day);
  if (!trouble) return;
  const msg = await record(deps, city, {
    gist: trouble.gist,
    changes: trouble.changes,
    source: 'complication',
    frontId: front.id,
    day,
    kind: 'beat',
    officer: leadLabel(city, front).officer,
    announce: true,
  });
  if (msg) out.push(msg);
}

// ───────────────────────────── очередь ─────────────────────────────

async function frontEvent(deps: FlowDeps, city: City, job: Job, out: OutboundMessage[]): Promise<void> {
  const front = job.payload.frontId ? findFront(city, job.payload.frontId) : null;
  if (!front || front.status !== 'active') return;
  const day = job.dueDay;
  settleProgress(front, day);
  switch (dueEvent(front, day)) {
    case 'milestone':
      await onMilestone(deps, city, front, day, out);
      break;
    case 'completion':
      await onCompletion(deps, city, front, day, out);
      break;
    case 'deadline':
      await onDeadline(deps, city, front, day, out);
      break;
    case 'pulse':
      await onPulse(deps, city, front, day, out);
      break;
    default:
      break;
  }
  syncProjects(city);
  refreshAllFronts(deps, city, day);
}

async function handle(deps: FlowDeps, city: City, job: Job, out: OutboundMessage[]): Promise<void> {
  if (job.kind === 'front_event') return frontEvent(deps, city, job, out);
  out.push(...(await seedStories(deps, city, job.dueDay)));
}

/**
 * Разобрать наступившие задания уже загруженного города. Город меняется
 * в памяти; вести возвращаются, чтобы отправить их после сохранения.
 */
export async function processDue(deps: FlowDeps, world: World, city: City): Promise<OutboundMessage[]> {
  const now = today(deps, world);
  const out: OutboundMessage[] = [];
  recoverRunningJobs(city);
  for (let n = 0; n < MAX_JOBS_PER_PASS; n++) {
    const job = dueJobs(city, now)[0];
    if (!job || !claimJob(job)) break;
    try {
      await handle(deps, city, job, out);
      completeJob(job);
    } catch (err) {
      failJob(job, String(err));
      deps.log?.warn('job_failed', { cityId: city.id, job: job.kind, error: String(err) });
    }
  }
  accrueMana(deps.rules, city, now);
  pruneJobs(city);
  return out;
}

/** Догнать город до текущего дня, сохранить и разослать вести. */
export async function advanceCity(deps: FlowDeps, cityId: string): Promise<number> {
  const world = await requireWorld(deps);
  const city = await deps.storage.getCity(cityId);
  if (!city) return 0;
  const out = await processDue(deps, world, city);
  await deps.storage.saveCity(city);
  await sendAll(deps, out);
  return out.length;
}
