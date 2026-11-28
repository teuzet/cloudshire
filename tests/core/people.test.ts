import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { describe, expect, test } from 'vitest';
import type { Gender } from '../../src/core/city.js';
import { hasPersonalName, namePerson, roleGender, type Namer } from '../../src/core/people.js';
import { parseScenario, plantScenario } from '../../src/core/world/scenario.js';
import { applyStake } from '../../src/core/world/stake.js';
import { withNamer } from '../../src/flows/context.js';
import { blankCity, ids, rules } from '../helpers/fixtures.js';
import { stand } from '../helpers/game.js';

const pool: Record<Gender, string[]> = { female: ['Айра', 'Вена'], male: ['Орм', 'Кайр'] };
const namer = (): Namer => {
  const left = { female: [...pool.female], male: [...pool.male] };
  return { known: new Set([...pool.female, ...pool.male, 'Лира']), take: (g) => left[g].shift() ?? null };
};

describe('имена людей', () => {
  test('пол по роли', () => {
    expect(roleGender('Старшая наследница')).toBe('female');
    expect(roleGender('Отшельница')).toBe('female');
    expect(roleGender('Дочь красильщика')).toBe('female');
    expect(roleGender('Ткачиха из верхней слободы')).toBe('female');
    expect(roleGender('Младший архивариус')).toBe('male');
    expect(roleGender('Поджигатель')).toBe('male');
    expect(roleGender('Судья с рынка')).toBe('male');
    expect(roleGender('Голос общины')).toBe('male');
  });

  test('безымянный человек получает имя, роль остаётся; группа и названный человек как есть', () => {
    const n = namer();
    expect(namePerson('person', 'Старшая наследница', n)).toBe('Айра, старшая наследница');
    expect(namePerson('person', 'Поджигатель', n)).toBe('Орм, поджигатель');
    expect(namePerson('person', 'Лира, ткачиха', n)).toBe('Лира, ткачиха');
    expect(namePerson('person', 'Лира', n)).toBe('Лира');
    expect(namePerson('community', 'Пороховщики', n)).toBe('Пороховщики');
    expect(namePerson('person', 'Поджигатель', null)).toBe('Поджигатель');
    expect(hasPersonalName('Старый Орм', n.known)).toBe(true);
  });

  test('ставка и посадка истории называют новых людей', () => {
    const r = rules();
    const city = blankCity();
    const n = namer();
    applyStake(r, city, [{ op: 'create', object: { type: 'person', name: 'Младший архивариус', description: 'Служит в архиве.', points: { prosperity: 0, security: 0, knowledge: 0, influence: 0 } } }], { day: 1, newId: ids(), namer: n });
    expect(city.objects.at(-1)?.name).toBe('Орм, младший архивариус');
    const scenario = parseScenario(yaml.load(fs.readFileSync(path.join(process.cwd(), 'scenarios/hermit-cure.yaml'), 'utf8')));
    const { objects } = plantScenario(r, city, scenario, { day: 1, newId: ids(2), namer: n });
    expect(objects.find((o) => o.type === 'person')?.name).toBe('Айра, отшельница');
  });

  test('поток забирает из пула мира только розданные имена', async () => {
    const s = await stand();
    const before = (await s.deps.storage.getWorld())!.namePool.map((p) => p.name);
    const given = await withNamer(s.deps, async (d) => d.namer!.take('female'));
    const after = (await s.deps.storage.getWorld())!.namePool.map((p) => p.name);
    expect(before).toContain(given);
    expect(after).toEqual(before.filter((x) => x !== given));
    await withNamer(s.deps, async () => null);
    expect((await s.deps.storage.getWorld())!.namePool).toHaveLength(after.length);
  });
});
