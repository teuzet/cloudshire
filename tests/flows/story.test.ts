import { describe, expect, test } from 'vitest';
import { toolReply, toolsReply } from '../../src/adapters/llm/fake.js';
import { scheduleJob } from '../../src/core/jobs.js';
import { findFront } from '../../src/core/world/fronts.js';
import { patronMessage } from '../../src/flows/priest-turn.js';
import { runDueCities } from '../../src/flows/scheduler.js';
import { storyCount, trimFree } from '../../src/flows/seeding.js';
import { parseScenario } from '../../src/core/world/scenario.js';
import { rules } from '../helpers/fixtures.js';
import { createFront } from '../../src/core/world/fronts.js';
import { blankCity } from '../helpers/fixtures.js';
import { lanternIsle, lastUser, scriptFrontAgents, stand } from '../helpers/game.js';

async function plantedCity() {
  const s = await stand();
  const world = (await s.deps.storage.getWorld())!;
  const city = blankCity({ worldId: world.id, ownerId: 'u1', brief: 'Мерв живёт камнем.' });
  scheduleJob(city, { id: 'job_seed', kind: 'seed', dueDay: 3 });
  await s.deps.storage.saveCity(city);
  // Заготовка одна, и она возможность; беду режиссёр заказывает по зерну.
  const blight = { id: 'blight', title: 'Серая ржа', fronts: [{ id: 'rust', title: 'Ржа на зерне', description: 'Ржа ест зерно в амбарах.', impact: 'MINOR', drift: 'SLOW', stake: { stats: { prosperity: -4 } } }] };
  s.llm.always('scenario-writer', (req) => toolReply('submit_scenario', lastUser(req).includes('Зерно истории') ? blight : { ...lanternIsle(), title: 'Островок у Мерва' }));
  scriptFrontAgents(s.llm);
  s.llm.always(
    'stage-planner',
    toolReply('submit_stages', { stages: [{ title: 'Дозор у края', work: 'Стража встаёт в дозор.', result: { kind: 'new_object', type: 'organization', name: 'Дозор у края', description: 'Постоянный дозор.' }, site: null, outcome_known: true }] }),
  );
  return { ...s, cityId: city.id };
}

describe('история от посева до развязки', () => {
  test('посев → стратегия → вехи с уликами → ставка → развязка', async () => {
    const s = await plantedCity();
    s.passDays(2);
    expect((await runDueCities(s.deps, s.locks)).cities).toBe(0);

    s.passDays(1);
    await runDueCities(s.deps, s.locks);
    let city = (await s.deps.storage.getCity(s.cityId))!;
    const story = city.fronts.find((f) => f.origin === 'story' && f.form === 'find')!;
    // За проверку приходят беда и возможность: беда по зерну (заготовок-бед нет), возможность из заготовки.
    expect(city.scenariosUsed[0]).toMatch(/^story_/);
    expect(city.scenariosUsed[1]).toBe('lantern-isle');
    expect(lastUser(s.llm.callsTo('scenario-writer')[0]!)).toContain('Зерно истории');
    expect(city.storyLog?.map((m) => m.kind)).toEqual(['trouble', 'chance']);
    // Возможность живёт окно и уходит, если её не довели.
    expect(story).toMatchObject({ form: 'find', plus: true, capacity: s.r.seeding.capacity.SIGNIFICANT, milestones: 3, ratePerDay: 0 });
    expect(story.deadlineDay).toBe(3 + 120);
    expect(city.objects.map((o) => o.name)).toContain('Башня на островке');
    expect(s.inbox.sent).toHaveLength(2);
    expect(city.fronts.filter((f) => f.origin === 'story')).toHaveLength(2);
    expect(city.jobs.find((j) => j.kind === 'seed' && j.state === 'pending')?.dueDay).toBe(3 + s.r.seeding.checkEveryDays);

    // Жрец поручает хранителю надписи; Толкователь видит в этом стратегию для идущей истории.
    s.llm
      .script('priest', toolsReply(['assign_officer', { office: 'keeper', task: 'Разобрать надписи на башне' }], ['submit_reply', { text: 'Вета возьмётся.' }]))
      .script('will-interpreter', toolReply('submit_will', { label: 'strategy', front_id: story.id, goal: 'Разобрать надписи на башне', manner: 'Расшифровать надписи на башне' }))
      .script('alignment-judge', toolReply('submit_alignment', { verdict: 'spot_on', matched_move: 4 }));
    const reply = await patronMessage(s.deps, s.locks, { ownerId: 'u1', text: 'Пусть хранитель разберёт надписи' });
    expect(reply).toMatchObject({ kind: 'reply', text: 'Вета возьмётся.', acted: true });
    city = (await s.deps.storage.getCity(s.cityId))!;
    expect(city.mana.value).toBeCloseTo(50 - s.r.mana.turnCostWithAction, 0);
    expect(findFront(city, story.id)!.ratePerDay * 30).toBeCloseTo(4 * 1.25 * 0.9);
    const keeper = city.officers.find((o) => o.office === 'keeper')!;
    expect(keeper.assignmentId).not.toBeNull();
    // Судья сверял стратегию со скрытой логикой заготовки и подходами к уликам.
    const judged = lastUser(s.llm.callsTo('alignment-judge')[0]!);
    expect(judged).toContain('Расшифровка надписей, языков и символов.');
    expect(judged).toContain('Предложено: «Расшифровать надписи на башне»');

    // Время идёт: две вехи открывают улики, третья приносит ставку.
    for (let i = 0; i < 400 && findFront(city, story.id)!.status === 'active'; i++) {
      s.passDays(1);
      await runDueCities(s.deps, s.locks);
      city = (await s.deps.storage.getCity(s.cityId))!;
    }
    const done = findFront(city, story.id)!;
    expect(done).toMatchObject({ status: 'done', milestonesFired: 3 });
    expect(done.script?.clues.every((c) => c.revealed)).toBe(true);
    const storyEntries = city.chronicle.filter((e) => e.frontId === story.id).map((e) => e.source);
    expect(storyEntries).toEqual(['scenario', 'milestone', 'milestone', 'completion']);
    const known = city.facts.filter((f) => f.frontId === story.id).map((f) => f.text);
    expect(known).toEqual([
      'Надписи перечисляют травы и соли, смешанные в одном котле.',
      'Механизм башни по трубкам разносит светящийся состав к фонарям.',
      'Рецепт — состав, который светится без огня; им заправлены фонари островка.',
    ]);
    expect(lastUser(s.llm.callsTo('chronicler').at(-1)!)).toContain('Стало известно: Рецепт — состав, который светится без огня; им заправлены фонари островка.');
    expect(city.officers.find((o) => o.office === 'keeper')!.assignmentId).toBeNull();
    // Вести: две посадки, две вехи, развязка; остальное — беды по зерну, которые режиссёр досадил за это время.
    expect(s.inbox.sent.length).toBeGreaterThanOrEqual(5);
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
      .always('will-interpreter', toolReply('submit_will', { label: 'project', goal: 'Поставить дозор у края' }));
    const reply = await patronMessage(s.deps, s.locks, { ownerId: 'u1', text: 'Дозор!' });
    expect(reply.kind).toBe('failed');
    expect(s.llm.callsTo('stage-planner').length).toBeGreaterThan(0);
    const city = (await s.deps.storage.getCity(s.cityId))!;
    expect(city.assignments).toHaveLength(0);
    expect(city.fronts).toHaveLength(0);
    expect(city.projects).toHaveLength(0);
    expect(city.officers.every((o) => !o.assignmentId)).toBe(true);
    expect(city.mana.value).toBe(50);
  });

  test('занятый сановник: инструмент отказывает, ход не считается действием', async () => {
    const s = await plantedCity();
    s.llm
      .script(
        'priest',
        toolsReply(['assign_officer', { office: 'marshal', task: 'Дозор у края' }], ['submit_reply', { text: 'Маршал выйдет.' }]),
        toolsReply(['order_change', { office: 'marshal', intent: 'Ещё один дозор' }], ['submit_reply', { text: 'Маршал занят.' }]),
      )
      .always('will-interpreter', toolReply('submit_will', { label: 'project', goal: 'Поставить дозор у края' }));
    const first = await patronMessage(s.deps, s.locks, { ownerId: 'u1', text: 'Дозор!' });
    expect(first).toMatchObject({ acted: true });
    const second = await patronMessage(s.deps, s.locks, { ownerId: 'u1', text: 'Ещё дозор!' });
    expect(second).toMatchObject({ acted: false });
    const city = (await s.deps.storage.getCity(s.cityId))!;
    expect(city.assignments).toHaveLength(1);
    expect(city.fronts.filter((f) => f.origin === 'player')).toHaveLength(1);
    expect(city.dialog.filter((d) => d.kind === 'reply')).toHaveLength(4);
  });
});

test('посев: поиск, за который никто не взялся, считается половиной истории', () => {
  const city = blankCity();
  const make = (id: string, form: 'find' | 'threat') => createFront({ id, form, origin: 'story', title: id, description: id, capacity: 4, milestones: 1, risk: 'safe', footprint: [], day: 0 });
  city.fronts.push(make('a', 'find'), make('b', 'find'));
  expect(storyCount(city)).toBe(1);
  city.fronts.push(make('c', 'threat'));
  expect(storyCount(city)).toBe(2);
});

test('история по зерну: не больше трёх фронтов и одного, что идёт к сроку сам', () => {
  const f = (id: string, drift: string, closes: Array<{ target: string; share: number }> = []) => ({ id, description: id, impact: 'MINOR', drift, closes });
  const raw = parseScenario({ id: 's', title: 'S', fronts: [{ ...f('a', 'FAST'), impact: 'DEFINING' }, f('b', 'NONE', [{ target: 'c', share: 0.5 }]), f('c', 'STEADY'), f('d', 'NONE'), f('e', 'NONE')] });
  const out = trimFree({ rules: rules() }, raw);
  expect(out.fronts.map((x) => x.id)).toEqual(['a', 'b', 'd']);
  expect(out.fronts[1]!.closes).toEqual([]);
  expect(out.fronts[0]!.impact).toBe('SIGNIFICANT');
});
