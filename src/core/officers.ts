/**
 * Четыре сановника. Каждый олицетворяет стат и ведёт одно поручение за раз.
 */

import { TEMPERS, type Office, type Rules, type Temper } from './rules.js';
import type { City, Gender, Officer, Post, WorldObject } from './city.js';
import { createObject } from './world/objects.js';
import type { Rng } from './random.js';
import { pickOne } from './random.js';

/** Характер-темп сановника: случайный, от должности не зависит. */
export function rollTemper(rng: Rng): Temper {
  return pickOne(TEMPERS, rng) ?? 'even';
}

export function createOfficers(
  rules: Rules,
  people: Record<Office, { name: string; gender: Gender; nature: string; temper?: Temper }>,
): Officer[] {
  return rules.officers.map((def) => ({
    office: def.office,
    statId: def.statId,
    title: def.title,
    name: people[def.office].name,
    gender: people[def.office].gender,
    nature: people[def.office].nature,
    temper: people[def.office].temper ?? 'even',
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

/** Должность словами: «верховный жрец» или название сановника в нижнем регистре. */
export function postTitle(rules: Rules, post: Post, gender: Gender): string {
  if (post === 'priest') return gender === 'female' ? 'верховная жрица' : 'верховный жрец';
  return (rules.officers.find((o) => o.office === post)?.title ?? post).toLowerCase();
}

/** Человек на должности как объект города: тип person, без собственного вклада в статы. */
export function createHolder(rules: Rules, args: { id: string; post: Post; name: string; gender: Gender; nature: string; day: number }): WorldObject {
  const title = postTitle(rules, args.post, args.gender);
  const obj = createObject(rules, {
    id: args.id,
    type: 'person',
    name: args.name,
    description: `${title[0]!.toUpperCase()}${title.slice(1)} города. ${args.nature}`,
    day: args.day,
  });
  obj.post = args.post;
  return obj;
}
