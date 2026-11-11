import { describe, expect, test } from 'vitest';
import { toolReply, toolsReply } from '../../src/adapters/llm/fake.js';
import { scheduleJob } from '../../src/core/jobs.js';
import { findFront } from '../../src/core/world/fronts.js';
import { patronMessage } from '../../src/flows/priest-turn.js';
import { runDueCities } from '../../src/flows/scheduler.js';
import { blankCity } from '../helpers/fixtures.js';
import { lanternIsle, stand } from '../helpers/game.js';

async function plantedCity() {
  const s = await stand();
  const world = (await s.deps.storage.getWorld())!;
  const city = blankCity({ worldId: world.id, ownerId: 'u1', brief: 'Мерв живёт камнем.' });
  scheduleJob(city, { id: 'job_seed', kind: 'seed', dueDay: 3 });
  await s.deps.storage.saveCity(city);
  s.llm.always('scenario-writer', toolReply('submit_scenario', { ...lanternIsle(), title: 'Островок у Мерва' }));
  return { ...s, cityId: city.id };
}

describe('история от посева до развязки', () => {
  test('посев → поручение → биты → ставка → развязка', async () => {
    const s = await plantedCity();
    s.passDays(2);
    expect((await runDueCities(s.deps, s.locks)).cities).toBe(0);

    s.passDays(1);
    await runDueCities(s.deps, s.locks);
    let city = (await s.deps.storage.getCity(s.cityId))!;
    const story = city.fronts.find((f) => f.origin === 'story')!;
    // Норма — две истории: первая из заготовки, вторая по зерну (заготовок больше нет).
    expect(city.scenariosUsed[0]).toBe('lantern-isle');
    expect(city.scenariosUsed[1]).toMatch(/^story_/);
    expect(s.llm.callsTo('scenario-writer')[1]?.messages[0]?.content).toContain('Зерно истории');
    expect(story.ratePerDay).toBe(0);
    expect(city.objects.map((o) => o.name)).toContain('Башня на островке');
    expect(s.inbox.sent).toHaveLength(2);
    expect(city.fronts.filter((f) => f.origin === 'story')).toHaveLength(2);
    expect(city.jobs.find((j) => j.kind === 'seed' && j.state === 'pending')?.dueDay).toBe(3 + s.r.seeding.checkEveryDays);

    // Жрец поручает хранителю надписи; оценщик видит, что это двигает историю.
    s.llm
      .script('priest', toolsReply(['assign_officer', { office: 'keeper', task: 'Разобрать надписи на башне' }], ['submit_reply', { text: 'Вета возьмётся.' }]))
      .always('assignment-evaluator', toolReply('submit_assignment_eval', { direction: 'forward', efficiency: 'strong', blocks: [], stop_when: 'stake' }))
      .always('beat-resolver', (req) => {
        const clue = /- (\w+): /.exec(req.system.split('Улики:\n')[1] ?? '')?.[1];
        return toolReply('submit_beat_pick', { clue_id: clue });
      });
    const reply = await patronMessage(s.deps, s.locks, { ownerId: 'u1', text: 'Пусть хранитель разберёт надписи' });
    expect(reply).toMatchObject({ kind: 'reply', text: 'Вета возьмётся.', acted: true });
    city = (await s.deps.storage.getCity(s.cityId))!;
    expect(city.mana.value).toBeCloseTo(50 - s.r.mana.turnCostWithAction, 0);
    expect(findFront(city, story.id)!.ratePerDay).toBeGreaterThan(0);
    const keeper = city.officers.find((o) => o.office === 'keeper')!;
    expect(keeper.assignmentId).not.toBeNull();

    // Время идёт: два порога, потом ставка.
    for (let i = 0; i < 400 && findFront(city, story.id)!.status === 'active'; i++) {
      s.passDays(1);
      await runDueCities(s.deps, s.locks);
      city = (await s.deps.storage.getCity(s.cityId))!;
    }
    const done = findFront(city, story.id)!;
    expect(done.status).toBe('resolved');
    expect(done.beatsFired).toEqual([0, 1]);
    expect(done.clues.every((c) => c.status === 'revealed')).toBe(true);
    const storyEntries = city.chronicle.filter((e) => e.frontId === story.id).map((e) => e.source);
    expect(storyEntries).toEqual(['scenario', 'beat', 'beat', 'stake']);
    expect(city.chronicle.at(-1)?.text).toContain('Рецепт был способом удерживать островок на месте');
    expect(city.officers.find((o) => o.office === 'keeper')!.assignmentId).toBeNull();
    expect(s.inbox.sent).toHaveLength(5);
    expect(s.llm.callsTo('herald').at(-1)?.messages[0]?.content).toContain('развязка');
  });

  test('без маны жрец не слышит и модель не зовётся', async () => {
    const s = await plantedCity();
    const city = (await s.deps.storage.getCity(s.cityId))!;
    await s.deps.storage.saveCity({ ...city, mana: { value: 0, day: 0 } });
    const reply = await patronMessage(s.deps, s.locks, { ownerId: 'u1', text: 'эй' });
    expect(reply.kind).toBe('no_mana');
    expect(s.llm.callsTo('priest')).toHaveLength(0);
  });

  test('сорванный ход откатывает заведённые дела', async () => {
    const s = await plantedCity();
    s.llm
      .always('priest', toolReply('assign_officer', { office: 'marshal', task: 'Дозор у края' }))
      .always('assignment-evaluator', toolReply('submit_assignment_eval', { direction: 'none', efficiency: 'normal', blocks: [], stop_when: 'stake' }));
    const reply = await patronMessage(s.deps, s.locks, { ownerId: 'u1', text: 'Дозор!' });
    expect(reply.kind).toBe('failed');
    const city = (await s.deps.storage.getCity(s.cityId))!;
    expect(city.assignments).toHaveLength(0);
    expect(city.officers.every((o) => !o.assignmentId)).toBe(true);
    expect(city.mana.value).toBe(50);
  });

  test('занятый сановник: инструмент отказывает, ход не считается действием', async () => {
    const s = await plantedCity();
    s.llm
      .script(
        'priest',
        toolsReply(['assign_officer', { office: 'marshal', task: 'Дозор у края' }], ['submit_reply', { text: 'Маршал выйдет.' }]),
        toolsReply(['assign_officer', { office: 'marshal', task: 'Ещё дозор' }], ['submit_reply', { text: 'Маршал занят.' }]),
      )
      .always('assignment-evaluator', toolReply('submit_assignment_eval', { direction: 'none', efficiency: 'normal', blocks: [], stop_when: 'stake' }));
    await patronMessage(s.deps, s.locks, { ownerId: 'u1', text: 'Дозор!' });
    const second = await patronMessage(s.deps, s.locks, { ownerId: 'u1', text: 'Ещё дозор!' });
    expect(second).toMatchObject({ acted: false });
    const toolResult = s.llm.callsTo('priest')[1]; // второй ход сдан с первого ответа
    expect(toolResult).toBeDefined();
    const city = (await s.deps.storage.getCity(s.cityId))!;
    expect(city.assignments).toHaveLength(1);
    expect(city.dialog.filter((d) => d.kind === 'reply')).toHaveLength(4);
  });
});
