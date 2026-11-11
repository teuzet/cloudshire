import { describe, expect, test } from 'vitest';
import { toolReply } from '../../src/adapters/llm/fake.js';
import { STAT_IDS } from '../../src/core/rules.js';
import { onboardingMessage, runGenesis } from '../../src/flows/onboarding.js';
import { ASPECTS } from '../../src/agents/city-genesis/aspects.js';
import { scriptGenesis } from '../helpers/genesis.js';
import { stand } from '../helpers/game.js';

describe('онбординг → генезис', () => {
  test('город поднимается из разговора, статы в бюджете, первое слово доходит', async () => {
    const s = await stand();
    s.llm
      .script(
        'onboarding-guide',
        toolReply('submit_onboarding', { reply: 'Как тебя звать?' }),
        toolReply('submit_onboarding', { reply: 'Поднимаю.', seed: { city_name: 'Мерв', patron_name: 'Алаэр', patron_gender: 'female', pitch: 'Каменотёсы' } }),
      );
    scriptGenesis(s.llm, s.r, { cityName: 'Мерв', patronName: 'Алаэр', unknowns: [{ text: 'Кто вырезал знаки в первой мастерской, не установлено.', object_ids: ['$first'] }] });

    expect(await onboardingMessage(s.deps, { ownerId: 'u1', text: 'привет' })).toMatchObject({ kind: 'reply', ready: false });
    expect(await onboardingMessage(s.deps, { ownerId: 'u1', text: 'Я Алаэр, город каменотёсов' })).toMatchObject({ ready: true });
    expect(await onboardingMessage(s.deps, { ownerId: 'u1', text: 'ну что?' })).toMatchObject({ kind: 'busy' });

    const city = await runGenesis(s.deps, 'u1');
    expect(city?.name).toBe('Мерв');
    expect(city?.patronName).toBe('Алаэр');
    const sum = STAT_IDS.reduce((a, id) => a + city!.stats[id], 0);
    expect(sum).toBe(s.r.genesis.statBudget);
    for (const id of STAT_IDS) {
      expect(city!.stats[id]).toBeGreaterThanOrEqual(s.r.genesis.statMin);
      expect(city!.stats[id]).toBeLessThanOrEqual(s.r.genesis.statMax);
    }
    // Конвейер старого генезиса: ядро, аспекты пачками, объекты, сановники, бриф.
    const genesisCalls = s.llm.callsTo('city-genesis').map((q) => q.tools![0]!.name);
    expect(genesisCalls).toEqual(['submit_core', ...Array(Math.ceil(ASPECTS.length / 4)).fill('submit_aspects')]);
    for (const a of ASPECTS) expect(city!.description).toContain(`## ${a.title}`);
    expect(city!.facts).toHaveLength(8);
    expect(city!.facts.every((f) => f.author === 'genesis' && f.status === 'active')).toBe(true);
    expect(city!.unknowns).toEqual([{ text: 'Кто вырезал знаки в первой мастерской, не установлено.', objectIds: [city!.objects[0]!.id] }]);
    expect(city!.brief).toContain('Мерв живёт камнем.');
    expect(city!.jobs.find((j) => j.kind === 'seed')?.dueDay).toBe(s.r.seeding.firstStoryDay);
    expect(s.inbox.sent.map((m) => m.text)).toEqual(['Алаэр, город слышит тебя.']);
    expect(await s.deps.storage.getDraft('u1')).toBeNull();

    // Пять человек взяли имена из пула мира, остальные имена вернулись.
    const world = await s.deps.storage.getWorld();
    const people = [city!.priest.name, ...city!.officers.map((o) => o.name)];
    for (const n of people) expect(world!.namePool.map((p) => p.name)).not.toContain(n);
    // Пол людей — из пула имён.
    const female = new Set(s.names.female);
    expect(city!.priest.gender).toBe(female.has(city!.priest.name) ? 'female' : 'male');
    for (const o of city!.officers) expect(o.gender).toBe(female.has(o.name) ? 'female' : 'male');
    expect(world!.namePool.length + people.length).toBe(10);
    expect(await onboardingMessage(s.deps, { ownerId: 'u1', text: 'ещё' })).toEqual({ kind: 'has_city' });
  });

  test('сломанный генезис: черновик failed, имена вернулись, игрок предупреждён', async () => {
    const s = await stand();
    s.llm
      .script('onboarding-guide', toolReply('submit_onboarding', { reply: 'Поднимаю.', seed: { patron_name: 'Алаэр', patron_gender: 'male', pitch: 'x' } }))
      .always('city-genesis', toolReply('submit_core', { city_name: 'М' }));
    await onboardingMessage(s.deps, { ownerId: 'u1', text: 'старт' });
    expect(await runGenesis(s.deps, 'u1')).toBeNull();
    expect((await s.deps.storage.getDraft('u1'))?.status).toBe('failed');
    expect((await s.deps.storage.getWorld())?.namePool).toHaveLength(10);
    expect(s.inbox.sent[0]?.kind).toBe('system');
    // После сбоя игрок может говорить дальше.
    s.llm.script('onboarding-guide', toolReply('submit_onboarding', { reply: 'Ещё раз?' }));
    expect(await onboardingMessage(s.deps, { ownerId: 'u1', text: 'давай' })).toMatchObject({ kind: 'reply' });
  });
});
