/**
 * Жрец по наказу покровителя сам ставит свободного сановника на беду без ведущего
 * и сообщает об этом вестью. Кого и куда, решает код (core/world/steward.ts).
 * Раньше наказа — поручения покровителя на потом: их первым берёт освободившийся сановник.
 * Ещё раньше — поручения с условием: сбылось условие, приказ исполняется так, как будто сказан сейчас.
 */

import type { City, Front, Officer } from '../core/city.js';
import { officeDef } from '../core/officers.js';
import { createAssignment } from '../core/world/assignments.js';
import { conditionalOrders, conditionGone, type Conditional } from '../core/world/conditions.js';
import { findFront, frontGist } from '../core/world/fronts.js';
import { stewardOrder, stewardPick } from '../core/world/steward.js';
import type { OutboundMessage } from '../ports/notifier.js';
import { judgeCondition } from '../agents/condition-judge/run.js';
import { record } from './chronicle.js';
import { newId, tryAgent, type FlowDeps } from './context.js';
import { refreshAllFronts } from './fronts.js';
import { answerHindrances } from './hindrances.js';
import { playerWill } from './will.js';

/** Сколько назначений жрец делает за один проход: по одному на свободного сановника. */
const MAX_PER_PASS = 4;

/** Поручения на потом: свободный сановник берётся за первое, что ему по силам, по порядку. */
async function runQueue(deps: FlowDeps, city: City, day: number): Promise<OutboundMessage[]> {
  const out: OutboundMessage[] = [];
  const spare = stewardOrder(deps.rules, city).spare;
  for (const order of (city.queue ?? []).filter((q) => !q.condition)) {
    // Названного сановника ждём, даже если наказ его бережёт: покровитель сам его назвал.
    const officer = order.office
      ? city.officers.find((o) => o.office === order.office && !o.assignmentId)
      : city.officers.find((o) => !o.assignmentId && !spare.includes(o.office));
    if (!officer) continue;
    city.queue = (city.queue ?? []).filter((q) => q.id !== order.id);
    const outcome = await playerWill(deps, city, officer.office, order.task, day);
    const who = `${officeDef(deps.rules, officer.office).title} ${officer.name}`.trim();
    const took = officer.gender === 'female' ? 'взялась' : 'взялся';
    const task = order.task.replace(/[.!]+$/, '');
    // Весть о том, за что сановник взялся на деле: толкователь мог прочесть поручение иначе.
    const asg = city.assignments.find((a) => a.id === officer.assignmentId);
    const front = asg ? findFront(city, asg.frontId) : null;
    const work = front ? frontGist(front).replace(/[.!]+$/, '') : task;
    const gist = outcome.ok
      ? `${who} освободился от прежнего дела и, как велел покровитель, ${took} за отложенное поручение: ${work}.`
      : `Отложенное поручение покровителя не удалось начать: ${task}. ${outcome.say}`;
    const msg = await record(deps, city, {
      gist: officer.gender === 'female' ? gist.replace('освободился', 'освободилась') : gist,
      changes: [],
      source: 'steward',
      frontId: front?.id ?? null,
      day,
      kind: 'beat',
      officer,
      announce: true,
    });
    if (msg) out.push(msg);
  }
  return out;
}

/** Поручения с условием: сверить услышанное с условием, исполнить сбывшееся, снять погасшее. */
async function runConditions(deps: FlowDeps, city: City, day: number): Promise<OutboundMessage[]> {
  const out: OutboundMessage[] = [];
  for (const order of conditionalOrders(city)) {
    const c = order.condition;
    const watched = c.watch.map((id) => findFront(city, id)).filter((f): f is Front => Boolean(f));
    if (c.heard.length) {
      const events = c.heard;
      c.heard = [];
      const ruling = await tryAgent(
        deps,
        'condition-judge',
        () => judgeCondition(deps.agents, { condition: c.text, events }),
        { met: false, reason: '' },
      );
      if (ruling.met) {
        const msg = await fire(deps, city, order, day);
        if (msg) out.push(msg);
        continue;
      }
    }
    if (!conditionGone(city, order)) continue;
    city.queue = (city.queue ?? []).filter((q) => q.id !== order.id);
    const gone = watched.map((f) => frontGist(f).replace(/[.!]+$/, '')).join('; ');
    const msg = await record(deps, city, {
      gist: `Условие покровителя «${c.text}» погасло: того, за чем он велел следить, больше нет (${gone}). Поручение снято: ${order.task.replace(/[.!]+$/, '')}.`,
      changes: [],
      source: 'steward',
      frontId: watched[0]?.id ?? null,
      day,
      kind: 'beat',
      officer: null,
      announce: true,
    });
    if (msg) out.push(msg);
  }
  return out;
}

/**
 * Условие сбылось: приказ идёт тем же путём, что сказанный сейчас. Занятый сановник отвлекается
 * на малое дело, как всегда; на большое рук нет — поручение встаёт первым в обычную очередь.
 */
async function fire(deps: FlowDeps, city: City, order: Conditional, day: number): Promise<OutboundMessage | null> {
  city.queue = (city.queue ?? []).filter((q) => q.id !== order.id);
  const spare = stewardOrder(deps.rules, city).spare;
  const officer = order.office ? city.officers.find((o) => o.office === order.office) : city.officers.find((o) => !o.assignmentId && !spare.includes(o.office));
  const met = `Сбылось условие покровителя «${order.condition.text}».`;
  const task = order.task.replace(/[.!]+$/, '');
  const later = (who: Officer | null) => {
    city.queue = [{ id: order.id, office: who?.office ?? null, task: order.task, day }, ...(city.queue ?? [])];
    return who
      ? `${met} ${title(deps, who)} ${who.gender === 'female' ? 'занята' : 'занят'} большим делом и возьмётся за поручение, как только освободится: ${task}.`
      : `${met} Свободных рук сейчас нет: поручение возьмёт первый, кто освободится: ${task}.`;
  };
  let gist: string;
  let frontId: string | null = order.condition.watch[0] ?? null;
  if (!officer) gist = later(null);
  else {
    const outcome = await playerWill(deps, city, officer.office, order.task, day);
    const asg = city.assignments.find((a) => a.id === officer.assignmentId);
    const front = asg ? findFront(city, asg.frontId) : null;
    if (outcome.ok) {
      frontId = front?.id ?? frontId;
      const work = front ? frontGist(front).replace(/[.!]+$/, '') : task;
      gist = `${met} Как он велел, ${title(deps, officer)} ${officer.gender === 'female' ? 'взялась' : 'взялся'} за дело: ${work}.`;
    } else if (outcome.error === 'officer_busy') gist = later(officer);
    else gist = `${met} Но поручение не удалось начать: ${task}. ${outcome.say}`;
  }
  return record(deps, city, { gist, changes: [], source: 'steward', frontId, day, kind: 'beat', officer: officer ?? null, announce: true });
}

const title = (deps: FlowDeps, officer: Officer) => `${officeDef(deps.rules, officer.office).title} ${officer.name}`.trim();

export async function runSteward(deps: FlowDeps, city: City, day: number): Promise<OutboundMessage[]> {
  const out: OutboundMessage[] = [];
  if (conditionalOrders(city).length) out.push(...(await runConditions(deps, city, day)));
  if (city.queue?.length) out.push(...(await runQueue(deps, city, day)));
  for (let n = 0; n < MAX_PER_PASS; n++) {
    const pick = stewardPick(deps.rules, city, day);
    if (!pick) break;
    const { front, officer, move } = pick;
    createAssignment(city, { id: newId(deps, 'asg'), front, officer, text: move, verdict: deps.rules.fronts.steward.verdict, day });
    await answerHindrances(deps, city, front, move, day);
    refreshAllFronts(deps, city, day);
    const who = `${officeDef(deps.rules, officer.office).title} ${officer.name}`.trim();
    const she = city.priest.gender === 'female';
    const gist = frontGist(front).replace(/[.!]+$/, '');
    const msg = await record(deps, city, {
      gist:
        `${city.priest.name} не ${she ? 'дождалась' : 'дождался'} слова покровителя, и по ${she ? 'её' : 'его'} слову ` +
        `${who} ${officer.gender === 'female' ? 'встала' : 'встал'} на беду: ${gist.charAt(0).toLowerCase()}${gist.slice(1)}. ` +
        `${officer.gender === 'female' ? 'Она начала' : 'Он начал'} так: ${move.replace(/[.!]+$/, '')}.`,
      changes: [],
      source: 'steward',
      frontId: front.id,
      day,
      kind: 'beat',
      officer,
      announce: true,
    });
    if (msg) out.push(msg);
  }
  return out;
}
