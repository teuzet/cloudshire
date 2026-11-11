/**
 * Четыре сановника. Каждый олицетворяет стат и ведёт одно поручение за раз.
 */

import type { Office, Rules } from './rules.js';
import type { City, Officer } from './city.js';
import type { Rng } from './random.js';
import { pickOne } from './random.js';

export function createOfficers(rules: Rules, people: Record<Office, { name: string; nature: string }>): Officer[] {
  return rules.officers.map((def) => ({
    office: def.office,
    statId: def.statId,
    title: def.title,
    name: people[def.office].name,
    nature: people[def.office].nature,
    assignmentId: null,
  }));
}

export function findOfficer(city: Pick<City, 'officers'>, office: Office): Officer | null {
  return city.officers.find((o) => o.office === office) ?? null;
}

export function freeOfficers(city: Pick<City, 'officers'>): Officer[] {
  return city.officers.filter((o) => !o.assignmentId);
}

export function pickFreeOfficer(city: Pick<City, 'officers'>, rng: Rng): Officer | null {
  return pickOne(freeOfficers(city), rng) ?? null;
}

export function officeDef(rules: Rules, office: Office) {
  const def = rules.officers.find((o) => o.office === office);
  if (!def) throw new Error(`нет должности ${office}`);
  return def;
}
