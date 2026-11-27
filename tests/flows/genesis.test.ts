import { describe, expect, test } from 'vitest';
import { toolReply } from '../../src/adapters/llm/fake.js';
import { STAT_IDS } from '../../src/core/rules.js';
import { onboardingMessage, runGenesis } from '../../src/flows/onboarding.js';
import { ASPECTS } from '../../src/agents/city-genesis/aspects.js';
import { scriptGenesis } from '../helpers/genesis.js';
import { lastUser, stand } from '../helpers/game.js';

describe('онбординг → генезис', () => {
  test('город поднимается из разговора, статы в бюджете, первое слово доходит', async () => {
    const s = await stand();
    s.llm
      .script(
        'onboarding-guide',
        toolReply('submit_onboarding', { path: 'knows', reply: 'Каким ты видишь город?', ready: false }),
        toolReply('submit_onboarding', { path: 'knows', reply: 'Вот что вышло. Всё так?', pitch: 'Каменотёсы', city_name: 'Мерв', patron_name: 'Алаэр', patron_gender: 'female', ready: false }),
        toolReply('submit_onboarding', { path: 'knows', reply: 'Записано.', pitch: 'Каменотёсы', city_name: 'Мерв', patron_name: 'Алаэр', patron_gender: 'female', ready: true }),
      );
    scriptGenesis(s.llm, s.r, { cityName: 'Мерв', patronName: 'Алаэр', unknowns: [{ text: 'Кто вырезал знаки в первой мастерской, не установлено.', object_ids: ['$first'] }] });

    expect(await onboardingMessage(s.deps, { ownerId: 'u1', text: 'привет' })).toMatchObject({ kind: 'reply', ready: false });
    // Питч показывается игроку один раз, пока не изменится; сборка стартует только после согласия.
    expect(await onboardingMessage(s.deps, { ownerId: 'u1', text: 'Я Алаэр, город каменотёсов Мерв' })).toMatchObject({ ready: false, pitch: 'Каменотёсы' });
    expect(await onboardingMessage(s.deps, { ownerId: 'u1', text: 'Да, начинай' })).toMatchObject({ ready: true, pitch: null });
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
    // Характер-темп брошен кодом при рождении города.
    for (const o of city!.officers) expect(['slow', 'even', 'hasty']).toContain(o.temper);
    expect(city!.faith).toEqual({ value: expect.any(Number), day: city!.createdDay });
    expect(world!.namePool.length + people.length).toBe(10);
    expect(await onboardingMessage(s.deps, { ownerId: 'u1', text: 'ещё' })).toEqual({ kind: 'has_city' });
  });

  test('сломанный генезис: черновик failed, имена вернулись, игрок предупреждён', async () => {
    const s = await stand();
    s.llm
      .script(
        'onboarding-guide',
        toolReply('submit_onboarding', { path: 'knows', reply: 'Всё так?', pitch: 'x', patron_name: 'Алаэр', patron_gender: 'male', ready: false }),
        toolReply('submit_onboarding', { path: 'knows', reply: 'Записано.', pitch: 'x', patron_name: 'Алаэр', patron_gender: 'male', ready: true }),
      )
      .always('city-genesis', toolReply('submit_core', { city_name: 'М' }));
    await onboardingMessage(s.deps, { ownerId: 'u1', text: 'город x, я Алаэр' });
    await onboardingMessage(s.deps, { ownerId: 'u1', text: 'старт' });
    expect(await runGenesis(s.deps, 'u1')).toBeNull();
    expect((await s.deps.storage.getDraft('u1'))?.status).toBe('failed');
    expect((await s.deps.storage.getWorld())?.namePool).toHaveLength(10);
    expect(s.inbox.sent[0]?.kind).toBe('system');
    // После сбоя игрок может говорить дальше.
    s.llm.script('onboarding-guide', toolReply('submit_onboarding', { path: 'knows', reply: 'Ещё раз?', ready: false }));
    expect(await onboardingMessage(s.deps, { ownerId: 'u1', text: 'давай' })).toMatchObject({ kind: 'reply' });
  });
});

describe('клерк: питч, наброски, вопросы', () => {
  test('правка показывает питч заново, наброски меняют настроения, заданный вопрос не возвращается', async () => {
    const s = await stand();
    const say = (text: string) => onboardingMessage(s.deps, { ownerId: 'u1', text });
    const lastRequest = () => lastUser(s.llm.requests[s.llm.requests.length - 1]!);
    const moods = (text: string) => text.split('ВОПРОСЫ НА ВЫБОР')[0] ?? '';
    const questionIds = (text: string) => [...text.matchAll(/^- (q\d+):/gm)].map((m) => m[1]);

    s.llm.script('onboarding-guide', toolReply('submit_onboarding', { path: 'knows', reply: 'Вот три города. Какой берёшь?', used_sketches: true, ready: false }));
    await say('удиви меня');
    const firstMoods = moods(lastRequest());
    expect(questionIds(lastRequest())).toHaveLength(1);

    s.llm.script('onboarding-guide', (req) => toolReply('submit_onboarding', { path: 'knows', reply: 'А вот вопрос.', used_question: questionIds(lastUser(req))[0], themes_heard: ['island'], ready: false }));
    await say('второй');
    expect(moods(lastRequest())).not.toBe(firstMoods);
    const asked = questionIds(lastRequest())[0]!;

    s.llm.script('onboarding-guide', toolReply('submit_onboarding', { path: 'knows', reply: 'Вот питч.', pitch: 'Первый текст', ready: false }));
    expect(await say('грибы')).toMatchObject({ pitch: 'Первый текст', ready: false });
    expect(questionIds(lastRequest())).not.toContain(asked);
    expect(questionIds(lastRequest()).length).toBeGreaterThan(1);

    s.llm.script('onboarding-guide', toolReply('submit_onboarding', { path: 'knows', reply: 'Имя?', pitch: 'Первый текст', ready: false }));
    expect(await say('норм')).toMatchObject({ pitch: null });
    expect(lastRequest()).toContain('ПИТЧ, КОТОРЫЙ ИГРОК УЖЕ ВИДЕЛ:\nПервый текст');

    s.llm.script('onboarding-guide', toolReply('submit_onboarding', { path: 'knows', reply: 'Поправил.', pitch: 'Второй текст', patron_name: 'Ила', patron_gender: 'female', ready: false }));
    expect(await say('Я Ила. Добавь туман')).toMatchObject({ pitch: 'Второй текст', ready: false });

    s.llm.script('onboarding-guide', toolReply('submit_onboarding', { path: 'knows', reply: 'Записано.', pitch: 'Второй текст', patron_name: 'Ила', patron_gender: 'female', ready: true }));
    expect(await say('да, начинай')).toMatchObject({ ready: true });
    expect((await s.deps.storage.getDraft('u1'))?.seed).toEqual({ cityName: null, patronName: 'Ила', patronGender: 'female', pitch: 'Второй текст' });
  });
});
