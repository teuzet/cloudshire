/**
 * Жрец по наказу покровителя сам ставит свободного сановника на беду без ведущего
 * и сообщает об этом вестью. Кого и куда, решает код (core/world/steward.ts).
 */

import type { City } from '../core/city.js';
import { officeDef } from '../core/officers.js';
import { createAssignment } from '../core/world/assignments.js';
import { frontGist } from '../core/world/fronts.js';
import { stewardPick } from '../core/world/steward.js';
import type { OutboundMessage } from '../ports/notifier.js';
import { record } from './chronicle.js';
import { newId, type FlowDeps } from './context.js';
import { refreshAllFronts } from './fronts.js';

/** Сколько назначений жрец делает за один проход: по одному на свободного сановника. */
const MAX_PER_PASS = 4;

export async function runSteward(deps: FlowDeps, city: City, day: number): Promise<OutboundMessage[]> {
  const out: OutboundMessage[] = [];
  for (let n = 0; n < MAX_PER_PASS; n++) {
    const pick = stewardPick(deps.rules, city, day);
    if (!pick) break;
    const { front, officer, move } = pick;
    createAssignment(city, { id: newId(deps, 'asg'), front, officer, text: move, verdict: deps.rules.fronts.steward.verdict, day });
    refreshAllFronts(deps, city, day);
    const who = `${officeDef(deps.rules, officer.office).title} ${officer.name}`.trim();
    const msg = await record(deps, city, {
      gist: `Не дождавшись слова покровителя, ${who} по воле жреца сам взялся за дело: ${move.replace(/[.!]+$/, '')}. Речь о том, что ${frontGist(front)}.`,
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
