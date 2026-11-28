/**
 * Бесшовный мир: стороны уходят, а не стираются, и помнят, что сделал покровитель; развязка истории
 * всегда оставляет след; узел с прошлым ждёт, и каждый второй посев растёт из него.
 */

import { describe, expect, test } from 'vitest';
import { toolReply } from '../../src/adapters/llm/fake.js';
import { priestTurnBlock } from '../../src/agents/priest/run.js';
import type { City, Front } from '../../src/core/city.js';
import { createFront, nextEventDay } from '../../src/core/world/fronts.js';
import { holdFront } from '../../src/core/world/links.js';
import { createObject, findObject } from '../../src/core/world/objects.js';
import { nodesWithPast } from '../../src/core/world/seamless.js';
import { applyStake } from '../../src/core/world/stake.js';
import { recomputeStats } from '../../src/core/world/stats.js';
import { newId, today } from '../../src/flows/context.js';
import { processDue } from '../../src/flows/day.js';
import { refreshAllFronts } from '../../src/flows/fronts.js';
import { plantStory } from '../../src/flows/seeding.js';
import { playerWill } from '../../src/flows/will.js';
import { blankCity } from '../helpers/fixtures.js';
import { lastUser, scriptFrontAgents, stand } from '../helpers/game.js';

/** Прибившийся островок с башней прикован цепями; в башне засели бунтовщики. */
async function islandTown() {
  const s = await stand();
  const world = (await s.deps.storage.getWorld())!;
  const city: City = blankCity({ worldId: world.id });
  city.steward = { mode: 'report', wait: 'weeks', spare: [], text: '' };
  scriptFrontAgents(s.llm);
  city.objects.push(
    createObject(s.r, { id: 'island', type: 'structure', name: 'Островок с башней', description: 'Прибившийся к городу островок.', day: 0 }),
    createObject(s.r, { id: 'tower', type: 'structure', name: 'Башня на островке', description: 'Старая каменная башня.', parentId: 'island', day: 0 }),
    createObject(s.r, { id: 'rebels', type: 'community', name: 'Бунтовщики в башне', description: 'Беглые кузнецы засели в башне.', parentId: 'tower', day: 0 }),
    createObject(s.r, { id: 'chains', type: 'structure', name: 'Цепи у причала', description: 'Цепи держат островок у города.', day: 0 }),
  );
  const drift = createFront({ id: 'drift', form: 'clock', origin: 'story', title: 'Островок уходит', description: 'Островок вот-вот отчалит.', capacity: 0, deadlineDay: 60, refs: ['island'], failStake: [{ op: 'delete', target: 'island' }], day: 0 });
  city.fronts.push(drift);
  recomputeStats(city, s.r);
  holdFront(s.r, city, findObject(city, 'chains')!, { frontId: 'drift', effect: 'stop' }, 0);
  refreshAllFronts(s.deps, city, 0);
  return { ...s, city, drift };
}

async function finish(s: Awaited<ReturnType<typeof stand>> & { city: City }, front: Front) {
  for (let i = 0; i < 30 && front.status === 'active'; i++) {
    const world = (await s.deps.storage.getWorld())!;
    const next = nextEventDay(front);
    if (next == null) break;
    s.passDays(Math.max(0, next - today(s.deps, world)));
    await processDue(s.deps, world, s.city);
  }
}

describe('бесшовный мир', () => {
  test('узлы с прошлым: якорь и то, что спит под ним; сыгранный снова узел больше не ждёт', async () => {
    const { city } = await islandTown();
    expect([...nodesWithPast(city).keys()].sort()).toEqual(['chains', 'island']);
    findObject(city, 'chains')!.playedDay = 5;
    expect([...nodesWithPast(city).keys()]).toEqual(['island']);
  });

  test('сторона уходит, а не стирается: островок ушёл, бунтовщики ушли с ним и стали узлом', async () => {
    const s = await islandTown();
    const { city } = s;
    city.fronts.push(createFront({ id: 'cut', form: 'deed', origin: 'player', title: 'Сбить цепи', description: 'Сбить цепи ночью, с лодок.', capacity: 2, day: 0 }));
    applyStake(s.r, city, [{ op: 'delete', target: 'island' }], { day: 10, newId: (p) => newId(s.deps, p), frontId: 'cut' });
    const rebels = findObject(city, 'rebels')!;
    expect(rebels.status).toBe('deleted');
    expect(rebels.out).toMatchObject({ forever: true, cause: 'Сбить цепи ночью, с лодок', day: 10 });
    // Башня — не сторона: она просто ушла.
    expect(findObject(city, 'tower')!.out ?? null).toBeNull();
    expect(priestTurnBlock(s.r, city, 10)).toContain('Бунтовщики в башне: ушли из города');
    expect(nodesWithPast(city).get('rebels')).toBe(10);
  });

  test('приказ покровителя ложится в память стороны, которой он во вред', async () => {
    const s = await islandTown();
    const { city } = s;
    s.llm
      .script('will-interpreter', toolReply('submit_will', { label: 'project', front_id: null, goal: 'Заколотить башню' }))
      .script(
        'stage-planner',
        toolReply('submit_stages', {
          stages: [{ title: 'Заколотить башню', work: 'Плотники заколачивают окна и двери башни.', result: { kind: 'change_object', object_id: 'tower', name: 'Башня на островке', description: 'Окна и двери башни заколочены.' }, site: { name: 'Леса у башни', description: '' }, outcome_known: true }],
        }),
      )
      .script('influence-appraiser', toolReply('submit_influence', { effects: [], sides: [{ id: 'rebels', stance: 'loses' }], reason: 'Бунтовщиков запирают.' }));
    expect((await playerWill(s.deps, city, 'marshal', 'Заколотите башню на островке', 0)).ok).toBe(true);
    const deed = city.fronts.at(-1)!;
    expect(deed.sides).toEqual([{ objectId: 'rebels', stance: 'harms' }]);
    await finish(s, deed);
    expect(deed.status).toBe('done');
    expect(findObject(city, 'rebels')!.log?.at(-1)?.text).toBe('По воле покровителя сделано: Плотники заколачивают окна и двери башни. Им это во вред.');
  });

  test('развязка истории всегда оставляет след; у осложнения «следа нет» бывает', async () => {
    const s = await islandTown();
    const { city } = s;
    const hit = [{ op: 'stats' as const, points: { prosperity: -2 } }];
    city.fronts.push(
      createFront({ id: 'storm', form: 'threat', origin: 'story', title: 'Буря', description: 'Буря идёт на город.', capacity: 4, deadlineDay: 20, failStake: hit, day: 0 }),
      createFront({ id: 'leak', form: 'threat', origin: 'complication', title: 'Течь', description: 'Течёт крыша склада.', capacity: 4, deadlineDay: 20, failStake: hit, day: 0 }),
    );
    refreshAllFronts(s.deps, city, 0);
    await finish(s, city.fronts.find((f) => f.id === 'storm')!);
    const said = s.llm.callsTo('resolver').map((r) => /Разрешённые последствия: (.*)/.exec(lastUser(r))?.[1] ?? '');
    expect(said).toHaveLength(2);
    expect(said.filter((a) => a.split(', ').includes('none'))).toHaveLength(1);
    expect(said.some((a) => !a.split(', ').includes('none') && a.includes('fact'))).toBe(true);
  });

  test('каждый второй посев растёт из узла: ушедшая сторона возвращается с новой историей', async () => {
    const s = await islandTown();
    const { city } = s;
    city.fronts.push(createFront({ id: 'cut', form: 'deed', origin: 'player', title: 'Сбить цепи', description: 'Сбить цепи ночью, с лодок.', capacity: 2, day: 0 }));
    applyStake(s.r, city, [{ op: 'delete', target: 'island' }], { day: 10, newId: (p) => newId(s.deps, p), frontId: 'cut' });
    findObject(city, 'rebels')!.log = [{ day: 10, text: 'Покровитель пустил их по ветру вместе с островком.' }];
    const raid = (refs: string[]) => ({ id: 'raid', title: 'Обида с моря', fronts: [{ id: 'return', title: 'Островок вернулся', description: 'Островок вернулся с попутным ветром, башня стала крепостью.', impact: 'MINOR', drift: 'SLOW', refs, stake: { stats: { security: -3 } } }] });
    s.llm.script('scenario-writer', toolReply('submit_scenario', raid([])), toolReply('submit_scenario', raid(['rebels'])));
    city.seeded = 1;
    await plantStory(s.deps, city, 200, 'trouble');
    const calls = s.llm.callsTo('scenario-writer');
    expect(calls).toHaveLength(2);
    expect(calls[0]!.system).toContain('Эта история вырастает из того, что уже было в городе');
    expect(calls[0]!.system).toContain('rebels — Бунтовщики в башне');
    // Ушедшая сторона видна посевщику вместе с памятью.
    expect(calls[0]!.system).toContain('Сейчас их в городе нет: ушли после «Сбить цепи ночью, с лодок»');
    expect(calls[0]!.system).toContain('Покровитель пустил их по ветру');
    const rebels = findObject(city, 'rebels')!;
    expect(rebels).toMatchObject({ status: 'active', out: null, parentId: null, playedDay: 200 });
    expect(city.seeded).toBe(2);
    expect(nodesWithPast(city).has('rebels')).toBe(false);

    // Следующий посев узла не требует.
    s.llm.script('scenario-writer', toolReply('submit_scenario', { ...raid([]), id: 'calm' }));
    await plantStory(s.deps, city, 260, 'trouble');
    expect(s.llm.callsTo('scenario-writer').at(-1)!.system).not.toContain('Эта история вырастает');
  });
});
