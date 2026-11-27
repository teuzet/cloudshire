/**
 * Узнать скрытое: обычное малое дело сановника. Итог берёт то, что в мире действительно скрыто,
 * сначала улики, потом участников. Жрец знает, где есть неузнанное, но не знает что.
 */

import { describe, expect, test } from 'vitest';
import { toolReply } from '../../src/adapters/llm/fake.js';
import { priestTurnBlock } from '../../src/agents/priest/run.js';
import type { City, Front } from '../../src/core/city.js';
import { createFront, nextEventDay } from '../../src/core/world/fronts.js';
import { hiddenAbout } from '../../src/core/world/hidden.js';
import { basePrice } from '../../src/core/world/numbers.js';
import { createObject } from '../../src/core/world/objects.js';
import { recomputeStats } from '../../src/core/world/stats.js';
import { today } from '../../src/flows/context.js';
import { processDue } from '../../src/flows/day.js';
import { refreshAllFronts } from '../../src/flows/fronts.js';
import { playerWill } from '../../src/flows/will.js';
import { blankCity } from '../helpers/fixtures.js';
import { lastUser, scriptFrontAgents, stand } from '../helpers/game.js';

type Stand = Awaited<ReturnType<typeof stand>> & { city: City; grain: Front };

/** Зерно пропадает из амбаров; за этим стоит приказчик Ордена весов, о котором город не знает. */
async function granary(opts: { clues?: string[] } = {}): Promise<Stand> {
  const s = await stand();
  const city = blankCity();
  city.steward = { mode: 'report', wait: 'weeks', spare: [], text: '' };
  scriptFrontAgents(s.llm);
  city.objects.push(
    createObject(s.r, { id: 'barns', type: 'building', name: 'Нижние амбары', description: 'Три амбара с зерном у канала.', statEffect: { prosperity: 6 }, day: 0 }),
    createObject(s.r, { id: 'clerk', type: 'person', name: 'Приказчик Ордена весов', description: 'Тихий человек, который ведёт весовые книги амбаров и по ночам вывозит мешки.', hidden: true, day: 0 }),
    createObject(s.r, { id: 'mill', type: 'building', name: 'Старая мельница', description: 'Мельница на ручье за городом.', day: 0 }),
    createObject(s.r, { id: 'hall', type: 'building', name: 'Ратуша', description: 'Каменная ратуша на площади.', day: 0 }),
    createObject(s.r, { id: 'cellar', type: 'resource', name: 'Тайный погреб', description: 'Погреб под мельницей, где лежат краденые мешки.', parentId: 'mill', hidden: true, day: 0 }),
  );
  const grain = createFront({
    id: 'grain',
    form: 'threat',
    origin: 'story',
    title: 'Пропажа зерна',
    description: 'Из нижних амбаров пропадает зерно: к зиме хлеба не хватит.',
    capacity: 6,
    deadlineDay: 120,
    refs: ['barns', 'clerk'],
    failStake: [{ op: 'stats', points: { prosperity: -3 } }],
    day: 0,
  });
  if (opts.clues) grain.script = { events: [], clues: opts.clues.map((fact, i) => ({ id: `c${i}`, fact, revealed: false })) };
  city.fronts.push(grain);
  recomputeStats(city, s.r);
  refreshAllFronts(s.deps, city, 0);
  return { ...s, city, grain };
}

async function finish(s: Stand, front: Front) {
  for (let i = 0; i < 30 && front.status === 'active'; i++) {
    const world = (await s.deps.storage.getWorld())!;
    s.passDays(Math.max(0, nextEventDay(front)! - today(s.deps, world)));
    await processDue(s.deps, world, s.city);
  }
}

const ask = (s: Stand, frontId: string | null, objectId: string | null, goal: string) =>
  s.llm
    .script('will-interpreter', toolReply('submit_will', { label: 'project', front_id: frontId, goal }))
    .script(
      'stage-planner',
      toolReply('submit_stages', {
        stages: [{ title: 'Расспросы', work: 'Хранитель расспрашивает сторожей и сверяет весовые книги.', result: { kind: 'reveal', object_id: objectId, name: goal, description: goal }, site: { name: 'Расспросы', description: '' }, outcome_known: true }],
      }),
    );

describe('узнать скрытое', () => {
  test('кто стоит за пропажей зерна: малое дело ценой факта открывает приказчика; жрец до того знает, что знает не всё', async () => {
    const s = await granary();
    const { city, grain } = s;
    expect(priestTurnBlock(s.r, city, 0)).toContain('об этом знают не всё');
    expect(priestTurnBlock(s.r, city, 0)).not.toContain('Приказчик');

    ask(s, 'grain', null, 'Узнать, кто стоит за пропажей зерна');
    const out = await playerWill(s.deps, city, 'keeper', 'Выясни, кто стоит за пропажей зерна', 0);
    expect(out.ok).toBe(true);
    const deed = city.fronts.at(-1)!;
    expect(deed.capacity).toBe(basePrice(s.r, 'fact'));
    expect(deed.stake).toEqual([{ op: 'uncover', frontId: 'grain', objectId: null }]);
    // Знание ничего не держит: оценщика влияния не зовут, и подвоха у узнанного нет.
    expect(s.llm.callsTo('influence-appraiser')).toHaveLength(0);
    expect(deed.key?.twist ?? null).toBeNull();

    await finish(s, deed);
    const clerk = city.objects.find((o) => o.id === 'clerk')!;
    expect(clerk.hidden).toBe(false);
    expect(lastUser(s.llm.callsTo('beat-writer').at(-1)!)).toContain('Открылось: Приказчик Ордена весов');
    expect(priestTurnBlock(s.r, city, 30)).not.toContain('об этом знают не всё');
    expect(grain.status).toBe('active');
  });

  test('улики идут первыми, по одной за дело; участник — когда улик не осталось', async () => {
    const s = await granary({ clues: ['На мешках из амбаров стоит клеймо Ордена весов.', 'Сторож видел телегу у мельницы в полночь.'] });
    const { city, grain } = s;
    expect(hiddenAbout(city, { frontId: 'grain', objectId: null }).map((h) => h.kind)).toEqual(['clue', 'clue', 'object']);

    ask(s, 'grain', null, 'Узнать, куда уходит зерно');
    await playerWill(s.deps, city, 'keeper', 'Узнай, куда уходит зерно', 0);
    await finish(s, city.fronts.at(-1)!);
    expect(grain.script?.clues.map((c) => c.revealed)).toEqual([true, false]);
    expect(city.facts.some((f) => f.text === 'На мешках из амбаров стоит клеймо Ордена весов.')).toBe(true);
    expect(city.objects.find((o) => o.id === 'clerk')!.hidden).toBe(true);
  });

  test('о части города: что под мельницей, открывает спрятанное в ней', async () => {
    const s = await granary();
    const { city } = s;
    ask(s, null, 'mill', 'Узнать, что творится в старой мельнице');
    expect((await playerWill(s.deps, city, 'keeper', 'Выясни, что творится в старой мельнице по ночам', 0)).ok).toBe(true);
    await finish(s, city.fronts.at(-1)!);
    expect(city.objects.find((o) => o.id === 'cellar')!.hidden).toBe(false);
    expect(city.objects.find((o) => o.id === 'clerk')!.hidden).toBe(true);
  });

  test('об амбарах: скрытое в беде, которая их касается, — тоже о них', async () => {
    const s = await granary();
    expect(hiddenAbout(s.city, { frontId: null, objectId: 'barns' })).toEqual([{ kind: 'object', objectId: 'clerk' }]);
  });

  test('приз поиска открывает только сам поиск: расспросы дают улики, но не того, кого поиск ищет', async () => {
    const s = await granary();
    const { city } = s;
    city.fronts.push(createFront({ id: 'hunt', form: 'find', origin: 'story', title: 'Найти вора', description: 'Стража ищет, кто ворует зерно.', capacity: 8, refs: ['clerk'], stake: [{ op: 'reveal', target: 'clerk' }], day: 0 }));
    refreshAllFronts(s.deps, city, 0);
    expect(hiddenAbout(city, { frontId: 'grain', objectId: null })).toEqual([]);
    // Жрец по-прежнему знает, что знает не всё.
    expect(priestTurnBlock(s.r, city, 0)).toContain('об этом знают не всё');
    ask(s, 'grain', null, 'Узнать, кто стоит за пропажей зерна');
    const out = await playerWill(s.deps, city, 'keeper', 'Выясни, кто стоит за пропажей зерна', 0);
    expect(out).toMatchObject({ ok: false });
    expect(out.say).toContain('остальное откроется, только когда будет доведено до конца «Стража ищет, кто ворует зерно»');
  });

  test('узнавать нечего: жрец слышит это до начала дела', async () => {
    const s = await granary();
    const { city } = s;
    ask(s, null, 'hall', 'Узнать, что творится в ратуше');
    const before = city.fronts.length;
    const out = await playerWill(s.deps, city, 'keeper', 'Узнай, что творится в ратуше', 0);
    expect(out).toMatchObject({ ok: false });
    expect(out.say).toContain('Узнавать больше нечего: всё, что можно узнать здесь (Ратуша), городу уже известно.');
    expect(city.fronts).toHaveLength(before);
  });
});
