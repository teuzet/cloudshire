import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { parseRules, type Rules } from '../../src/core/rules.js';
import { emptyStatMap } from '../../src/core/rules.js';
import type { City } from '../../src/core/city.js';
import { createOfficers } from '../../src/core/officers.js';
import { makeId, seededRng, type Rng } from '../../src/core/random.js';

const root = path.resolve(import.meta.dirname, '../..');

let cached: Rules | null = null;

/** Настоящие правила из config/game.yaml: тесты ломаются, если конфиг сломан. */
export function rules(): Rules {
  cached ??= parseRules(yaml.load(fs.readFileSync(path.join(root, 'config/game.yaml'), 'utf8')));
  return cached;
}

/** Генератор id для тестов: детерминированный. */
export function ids(seed = 1): (prefix?: string) => string {
  const rng = seededRng(seed);
  return (prefix = 'id') => makeId(prefix, rng);
}

/** Пустой город с четырьмя сановниками и ровными статами 50. */
export function blankCity(overrides: Partial<City> = {}): City {
  const r = rules();
  const officers = createOfficers(r, {
    treasurer: { name: 'Ада', gender: 'female', nature: 'скупа' },
    marshal: { name: 'Борислав', gender: 'male', nature: 'резок' },
    keeper: { name: 'Вета', gender: 'female', nature: 'медлит' },
    chancellor: { name: 'Гордей', gender: 'male', nature: 'любезен' },
  });
  return {
    id: 'city_test',
    worldId: 'world_test',
    ownerId: 'user_test',
    name: 'Туманск',
    patronName: 'Астра',
    description: 'Туманный торговый город у края обрыва.',
    brief: 'Туманный торговый город у края обрыва.',
    unknowns: [],
    facts: [],
    priest: { name: 'Илан', gender: 'male', nature: 'тих и внимателен' },
    officers,
    stats: { prosperity: 50, security: 50, knowledge: 50, influence: 50 },
    statScale: 1,
    statLedger: { prosperity: 50, security: 50, knowledge: 50, influence: 50 },
    mana: { value: 50, day: 0 },
    faith: { value: 50, day: 0 },
    objects: [],
    fronts: [],
    assignments: [],
    projects: [],
    dynamicsUsed: {},
    unattainableWarning: null,
    chronicle: [],
    dialog: [],
    notes: [],
    jobs: [],
    scenariosUsed: [],
    createdDay: 0,
    revision: 0,
    ...overrides,
  };
}

export function zeroLedgerCity(): City {
  return blankCity({ statLedger: emptyStatMap(), stats: emptyStatMap() });
}

export function rng(seed = 7): Rng {
  return seededRng(seed);
}
