/**
 * Жрец по наказу покровителя сам ставит свободного сановника на беду без ведущего
 * и сообщает об этом вестью. Кого и куда, решает код (core/world/steward.ts).
 * Раньше наказа — поручения покровителя на потом: их первым берёт освободившийся сановник.
 */

import type { City } from '../core/city.js';
import { officeDef } from '../core/officers.js';
import { createAssignment } from '../core/world/assignments.js';
import { findFront, frontGist } from '../core/world/fronts.js';
import { stewardOrder, stewardPick } from '../core/world/steward.js';
import type { OutboundMessage } from '../ports/notifier.js';
import { record } from './chronicle.js';
import { newId, type FlowDeps } from './context.js';
import { refreshAllFronts } from './fronts.js';
import { answerHindrances } from './hindrances.js';
import { playerWill } from './will.js';

/** Сколько назначений жрец делает за один проход: по одному на свободного сановника. */
const MAX_PER_PASS = 4;

/** Поручения на потом: свободный сановник берётся за первое, что ему по силам, по порядку. */
async function runQueue(deps: FlowDeps, city: City, day: number): Promise<OutboundMessage[]> {
  const out: OutboundMessage[] = [];
  const spare = stewardOrder(deps.rules, city).spare;
  for (const order of [...(city.queue ?? [])]) {
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

export async function runSteward(deps: FlowDeps, city: City, day: number): Promise<OutboundMessage[]> {
  const out: OutboundMessage[] = [];
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
