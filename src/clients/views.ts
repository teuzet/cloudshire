/**
 * Что игрок видит о своём городе вне разговора: состояние словами, без чисел мира.
 */

import type { City } from '../core/city.js';
import { manaShown } from '../core/mana.js';
import type { Rules } from '../core/rules.js';
import { gameDate } from '../core/time.js';
import { activeAssignments } from '../core/world/assignments.js';
import { activeFronts } from '../core/world/fronts.js';
import { qualitativeStats } from '../core/world/stats.js';

export function cityStatus(rules: Rules, city: City, day: number): string {
  const assignments = activeAssignments(city);
  const officers = city.officers.map((o) => {
    const a = assignments.find((x) => x.id === o.assignmentId);
    return `${o.title} ${o.name} — ${a ? a.text : 'свободен'}`;
  });
  const fronts = activeFronts(city).map((f) => `• ${f.description}`);
  return [
    `${city.name}. ${gameDate(day).label}.`,
    qualitativeStats(rules, city.stats),
    `${rules.mana.name}: ${manaShown(city)} из ${rules.mana.max}.`,
    `Сановники:\n${officers.join('\n')}`,
    fronts.length ? `Что идёт в городе:\n${fronts.join('\n')}` : 'В городе пока тихо.',
  ].join('\n\n');
}
