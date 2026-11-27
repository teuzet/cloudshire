import { describe, expect, test } from 'vitest';
import { FakeLlm, textReply, toolReply, toolsReply } from '../../src/adapters/llm/fake.js';
import { fixedSettings } from '../../src/agents/_shared/settings.js';
import { writeCityPortrait } from '../../src/agents/city-genesis/run.js';
import { auditPitch } from '../../src/agents/pitch-auditor/run.js';
import { writeCityIntro } from '../../src/agents/city-intro/run.js';
import { writeOfficerNatures } from '../../src/agents/officer-nature/run.js';
import { writeCityBrief } from '../../src/agents/city-brief/run.js';
import { createObject } from '../../src/core/world/objects.js';
import { PORTRAIT } from '../helpers/genesis.js';
import { guideOnboarding } from '../../src/agents/onboarding-guide/run.js';
import { writeNews } from '../../src/agents/herald/run.js';
import { priestTurnBlock, runPriestTurn, type PriestHandlers } from '../../src/agents/priest/run.js';
import { createFront } from '../../src/core/world/fronts.js';
import { blankCity, rules } from '../helpers/fixtures.js';

const r = rules();
const deps = (llm: FakeLlm) => ({ llm, settings: fixedSettings() });
const tower = () =>
  createObject(r, { id: 'tower', type: 'structure', name: 'Башня', description: 'Старая башня.', statEffect: { prosperity: 0, security: 0, knowledge: 1, influence: 0 }, day: 0 });

describe('генезис и онбординг', () => {
  const seed = { cityName: 'Мерв', patronName: 'Алаэр', patronGender: 'female' as const, pitch: 'Город каменотёсов' };
  const pool = ['Таэн', 'Иса', 'Орм', 'Лиэ', 'Кайр', 'Вэс'].map((name, i) => ({ name, gender: i % 2 ? ('male' as const) : ('female' as const) }));
  const portrait = (over: Record<string, unknown> = {}) => ({
    city_name: 'Мерв',
    priest_name: 'Таэн',
    priest_nature: 'Тиха и внимательна к знамениям.',
    portrait: PORTRAIT,
    hidden: 'Под башней спит старая жила.',
    ...over,
  });

  test('city-genesis портрет: имя города как дал игрок, жрец из пула, правила сезона в контексте', async () => {
    const llm = new FakeLlm().script(
      'city-genesis',
      toolReply('submit_portrait', portrait({ city_name: 'Другое' })),
      toolReply('submit_portrait', portrait({ priest_name: 'Чужой' })),
      toolReply('submit_portrait', portrait()),
    );
    const c = await writeCityPortrait(deps(llm), { seed, names: pool, seasonRules: ['Через месяц придут драконы'] });
    // Пол жреца — из пула мира, не от модели.
    expect(c).toMatchObject({ cityName: 'Мерв', priest: { name: 'Таэн', gender: 'female' }, hidden: 'Под башней спит старая жила.' });
    const sent = JSON.stringify(llm.requests.map((q) => q.messages));
    expect(sent).toContain('ровно «Мерв»');
    expect(sent).toContain('Чужой нет в списке');
    expect(llm.requests[0]?.system).toContain('драконы');
    expect(llm.requests[0]?.messages[0]?.content).toContain('Город каменотёсов');
  });

  test('pitch-auditor: место детали — объект из списка, brief или missing', async () => {
    const llm = new FakeLlm().script(
      'pitch-auditor',
      toolReply('submit_audit', { details: [{ detail: 'башня', place: 'Колокольня' }] }),
      toolReply('submit_audit', { details: [{ detail: 'башня', place: 'Башня' }, { detail: 'колокол', place: 'missing' }, { detail: 'камень', place: 'brief' }] }),
    );
    const out = await auditPitch(deps(llm), { pitch: 'Башня, колокол, камень', brief: 'Камень.', objects: [tower()] });
    expect(out.missing).toEqual(['колокол']);
    expect(out.found.map((f) => f.place)).toEqual(['Башня', 'brief']);
    expect(JSON.stringify(llm.requests[1]?.messages)).toContain('таких объектов нет в списке: Колокольня');
  });

  test('city-intro: вид сверху нужного объёма, зов жреца короткими сообщениями', async () => {
    const view = 'Внизу плывёт остров, в его середине город каменотёсов. '.repeat(13);
    const llm = new FakeLlm().script(
      'city-intro',
      toolReply('submit_intro', { view: 'Остров.'.repeat(20), priest_call: ['Алаэр?', 'Слышишь?'] }),
      toolReply('submit_intro', { view, priest_call: ['Алаэр? '.repeat(40), 'Слышишь?'] }),
      toolReply('submit_intro', { view, priest_call: ['Алаэр?', 'Слышишь меня?'] }),
    );
    const out = await writeCityIntro(deps(llm), {
      cityName: 'Мерв',
      patronName: 'Алаэр',
      patronGender: 'female',
      brief: 'Камень.',
      objects: [tower()],
      priest: { name: 'Таэн', nature: 'Тиха.' },
    });
    expect(out.priestCall).toEqual(['Алаэр?', 'Слышишь меня?']);
    expect(JSON.stringify(llm.requests[1]?.messages)).toContain('view');
    expect(JSON.stringify(llm.requests[2]?.messages)).toContain('длиннее');
  });

  test('officer-nature: четыре должности, имена из пула без жреца и повторов', async () => {
    const row = (office: string, name: string) => ({ office, name, gender: 'male', nature: 'Решает быстро и не выносит пустых слов.' });
    const llm = new FakeLlm().script(
      'officer-nature',
      toolReply('submit_officer_natures', { officers: [row('treasurer', 'Таэн'), row('marshal', 'Орм'), row('keeper', 'Лиэ'), row('chancellor', 'Кайр')] }),
      toolReply('submit_officer_natures', { officers: [row('treasurer', 'Иса'), row('marshal', 'Орм'), row('keeper', 'Лиэ'), row('chancellor', 'Кайр')] }),
    );
    const out = await writeOfficerNatures(deps(llm), { rules: r, cityName: 'Мерв', description: 'Город', names: pool, taken: ['Таэн'] });
    expect(out.treasurer).toMatchObject({ name: 'Иса', gender: 'male' });
    expect(out.keeper).toMatchObject({ name: 'Лиэ', gender: 'male' });
    expect(out.marshal).toMatchObject({ name: 'Орм', gender: 'female' });
    expect(JSON.stringify(llm.requests[1]?.messages)).toContain('уже занято: Таэн');
  });

  test('city-brief: неизвестности привязаны только к настоящим объектам', async () => {
    const objects = [tower()];
    const brief = 'Мерв живёт камнем. '.repeat(90);
    const llm = new FakeLlm().script(
      'city-brief',
      toolReply('submit_city_brief', { brief, unknowns: [{ text: 'Кто построил башню, не установлено.', object_ids: ['nowhere'] }] }),
      toolReply('submit_city_brief', { brief, unknowns: [{ text: '- Кто построил башню, не установлено.', object_ids: ['tower'] }, { text: 'нет' }] }),
    );
    const out = await writeCityBrief(deps(llm), { cityName: 'Мерв', patronName: 'Алаэр', patronGender: 'female', description: 'Город', objects });
    expect(out.unknowns).toEqual([{ text: 'Кто построил башню, не установлено.', objectIds: ['tower'] }]);
    expect(llm.requests[0]?.system).toContain('ОБЪЕКТЫ');
  });

  test('city-brief: бриф не называет людей и объекты с собственными именами', async () => {
    const gate = createObject(r, { id: 'gate', type: 'structure', name: 'Ворота Ирмы', description: 'Ворота.', statEffect: { security: 1 }, day: 0 });
    const brief = 'Мерв живёт камнем и помнит прошлое. '.repeat(45);
    const llm = new FakeLlm().script(
      'city-brief',
      toolReply('submit_city_brief', { brief: `${brief} Жрица Таэн правит у ворот Ирмы.`, unknowns: [] }),
      toolReply('submit_city_brief', { brief, unknowns: [] }),
    );
    const out = await writeCityBrief(deps(llm), { cityName: 'Мерв', patronName: 'Алаэр', patronGender: 'female', description: 'Город', objects: [gate, tower()], people: ['Таэн'] });
    expect(out.brief).toBe(brief.trim());
    expect(JSON.stringify(llm.requests[1]?.messages)).toContain('Ворота Ирмы, Таэн');
  });

  test('onboarding-guide: seed появляется, только когда игрок видел питч и согласился', async () => {
    const pitch = 'Город каменотёсов на крутом острове.';
    const llm = new FakeLlm().script(
      'onboarding-guide',
      toolReply('submit_onboarding', { path: 'knows', reply: 'Каким ты видишь город?', ready: false }),
      // Клерк торопится: питча игрок ещё не видел — поправляется после замечания.
      toolReply('submit_onboarding', { path: 'knows', reply: 'Начинаем.', pitch, patron_name: 'Алаэр', patron_gender: 'female', ready: true }),
      toolReply('submit_onboarding', { path: 'knows', reply: 'Вот что вышло. Всё так?', pitch, patron_name: 'Алаэр', patron_gender: 'female', ready: false }),
      toolReply('submit_onboarding', { path: 'knows', reply: 'Записано.', pitch, patron_name: 'Алаэр', patron_gender: 'female', ready: true }),
    );
    expect((await guideOnboarding(deps(llm), { turns: [] })).seed).toBeNull();
    const shown = await guideOnboarding(deps(llm), { turns: [{ role: 'patron', text: 'Я Алаэр, город каменотёсов' }] });
    expect(shown).toMatchObject({ seed: null, pitch });
    const done = await guideOnboarding(deps(llm), { turns: [{ role: 'patron', text: 'Да, начинай' }], pitch });
    expect(done.seed).toEqual({ cityName: null, patronName: 'Алаэр', patronGender: 'female', pitch });
    expect(llm.requests[0]?.system).toContain('КОНТРАКТ БЕЗОПАСНОСТИ');
  });

  test('onboarding-guide: вопрос только из выданного списка, питч после показа не подменяется', async () => {
    const questions = [{ id: 'q1', kind: 'open' as const, theme: 'people' as const, text: 'Про что здесь шутят?' }];
    const llm = new FakeLlm().script(
      'onboarding-guide',
      toolReply('submit_onboarding', { path: 'knows', reply: 'А про что шутят?', used_question: 'q9', ready: false }),
      toolReply('submit_onboarding', { path: 'knows', reply: 'А про что шутят?', used_question: 'q1', themes_heard: ['people'], ready: false }),
      toolReply('submit_onboarding', { path: 'knows', reply: 'Начинаем.', pitch: 'Другой текст', patron_name: 'Тарн', patron_gender: 'male', ready: true }),
      toolReply('submit_onboarding', { path: 'knows', reply: 'Поправил, глянь.', pitch: 'Другой текст', patron_name: 'Тарн', patron_gender: 'male', ready: false }),
    );
    const asked = await guideOnboarding(deps(llm), { turns: [], questions });
    expect(asked).toMatchObject({ usedQuestion: 'q1', themesHeard: ['people'] });
    expect(llm.requests[0]?.messages[0]?.content).toContain('q1: Про что здесь шутят?');
    const old = 'Город рыбаков на краю острова, где сети закидывают прямо в облака и ловят серебристых летучих рыб, а по вечерам чинят снасти у храма.';
    const edited = await guideOnboarding(deps(llm), { turns: [], pitch: old });
    expect(edited).toMatchObject({ seed: null, pitch: 'Другой текст' });
    // Имя и род слов о боге в момент согласия нового показа не требуют.
    const named = old.replace('у храма', 'у храма своей богини Илы');
    llm.script('onboarding-guide', toolReply('submit_onboarding', { path: 'knows', reply: 'Записано.', pitch: named, patron_name: 'Ила', patron_gender: 'female', ready: true }));
    expect((await guideOnboarding(deps(llm), { turns: [], pitch: old })).seed?.pitch).toBe(named);
  });
});

describe('голос жреца', () => {
  test('herald: развязка и сановник в запросе', async () => {
    const city = blankCity();
    const llm = new FakeLlm().script('herald', toolReply('submit_news', { text: 'Башня открыта.' }));
    const text = await writeNews(deps(llm), {
      city,
      entry: { id: 'c1', day: 3, text: 'Хранитель вскрыл башню.', source: 'completion', frontId: 'f1' },
      kind: 'resolution',
      officer: city.officers[2]!,
      history: [],
      day: 3,
    });
    expect(text).toBe('Башня открыта.');
    const user = llm.requests[0]!.messages[0]!.content;
    expect(user).toContain('развязка');
    expect(user).toContain('Вета');
  });

  function handlers(log: string[]): PriestHandlers {
    return {
      assignOfficer: async (a) => (log.push(`assign:${a.office}:${a.task}`), { ok: true, say: 'Хранитель взялся.' }),
      orderChange: async (a) => (log.push(`change:${a.intent}`), { ok: false, error: 'busy', say: 'Казначей занят.' }),
      withdraw: async (a) => (log.push(`withdraw:${a.office}`), { ok: true, say: 'Снят.' }),
      writeNote: async (a) => (log.push(`note:${a.text}`), { ok: true, say: 'Запомнил.' }),
      queueOrder: async (a) => (log.push(`queue:${a.office ?? 'any'}:${a.task}`), { ok: true, say: 'В очереди.' }),
      unqueue: async (a) => (log.push(`unqueue:${a.number}`), { ok: true, say: 'Убрано.' }),
      setStandingOrder: async (a) => (log.push(`order:${a.mode}`), { ok: true, say: 'Наказ принят.' }),
      consultLoremaster: async (a) => (log.push(`lore:${a.question}:${a.story_id ?? ''}`), { ok: true, say: 'В: что\nО: так' }),
      checkExistence: async (a) => (log.push(`exists:${a.thing}`), { ok: true, say: 'Неизвестно.' }),
    };
  }

  test('priest: дело и речь, acted от успешного дела', async () => {
    const city = blankCity();
    const log: string[] = [];
    const llm = new FakeLlm().script(
      'priest',
      toolsReply(['assign_officer', { office: 'keeper', task: 'Изучить надписи' }], ['submit_reply', { text: 'Вета возьмётся.' }]),
    );
    const turn = await runPriestTurn(deps(llm), { rules: r, city, day: 10, message: 'Пусть хранитель изучит надписи', quote: null }, handlers(log));
    expect(turn.reply).toBe('Вета возьмётся.');
    expect(turn.acted).toBe(true);
    expect(log).toEqual(['assign:keeper:Изучить надписи']);
  });

  test('priest: отказ дела и заметка не делают ход действием', async () => {
    const log: string[] = [];
    const llm = new FakeLlm().script(
      'priest',
      toolsReply(['order_change', { office: 'treasurer', intent: 'Построить мост' }], ['write_note', { text: 'Звать Алаэр' }]),
      textReply('Казначей занят, покровитель.'),
      toolReply('submit_reply', { text: 'Казначей занят, покровитель.' }),
    );
    const turn = await runPriestTurn(deps(llm), { rules: r, city: blankCity(), day: 1, message: 'Мост!', quote: null }, handlers(log));
    expect(turn.acted).toBe(false);
    expect(log).toEqual(['change:Построить мост', 'note:Звать Алаэр']);
    expect(llm.requests[2]?.messages.at(-1)).toMatchObject({ role: 'user', content: expect.stringContaining('submit_reply') });
  });

  test('priest: лормастер за конкретикой, ответ уходит жрецу результатом тула', async () => {
    const log: string[] = [];
    const llm = new FakeLlm().script(
      'priest',
      toolReply('consult_loremaster', { question: 'Кто построил башню?', story_id: 'f1' }),
      toolReply('submit_reply', { text: 'Так говорят старые записи.' }),
    );
    const turn = await runPriestTurn(deps(llm), { rules: r, city: blankCity(), day: 1, message: 'Кто построил башню?', quote: null }, handlers(log));
    expect(log).toEqual(['lore:Кто построил башню?:f1']);
    expect(turn.acted).toBe(false);
    expect(JSON.stringify(llm.requests[1]?.messages.at(-1))).toContain('О: так');
  });

  test('priest: цитата и разговор уходят сообщениями, разговор начинается с user', async () => {
    const city = blankCity();
    city.dialog.push({ role: 'priest', text: 'Приветствую.', day: 0, kind: 'news' });
    const llm = new FakeLlm().script('priest', toolReply('submit_reply', { text: 'Да.' }));
    await runPriestTurn(deps(llm), { rules: r, city, day: 1, message: 'Что это?', quote: 'Башня\nоткрыта' }, handlers([]));
    const msgs = llm.requests[0]!.messages;
    expect(msgs[0]?.role).toBe('user');
    expect(msgs[1]).toMatchObject({ role: 'assistant', content: 'Приветствую.' });
    expect(msgs.at(-1)?.content).toContain('> Башня\n> открыта');
  });

  test('блок хода жреца не выдаёт скрытого слоя фронта', () => {
    const city = blankCity();
    city.fronts.push(
      createFront({
        id: 'f1',
        form: 'find',
        origin: 'story',
        title: 'Рецепт в башне',
        description: 'Добраться до рецепта в башне',
        capacity: 10,
        stake: [{ op: 'fact', text: 'ТАЙНА_СТАВКИ' }],
        key: { moves: ['СКРЫТАЯ_ЛОГИКА'], twist: 'ТАЙНЫЙ_ПОДВОХ' },
        script: { events: [{ id: 'e', description: 'ТАЙНОЕ_СОБЫТИЕ', fired: false }], clues: [{ id: 'c', fact: 'ТАЙНАЯ_УЛИКА', revealed: false }] },
        outburst: 'ТАЙНЫЙ_ПРОРЫВ',
        day: 0,
      }),
    );
    const block = priestTurnBlock(r, city, 5);
    expect(block).toContain('Добраться до рецепта в башне');
    for (const secret of ['СКРЫТАЯ_ЛОГИКА', 'ТАЙНОЕ_СОБЫТИЕ', 'ТАЙНАЯ_УЛИКА', 'ТАЙНА_СТАВКИ', 'ТАЙНЫЙ_ПОДВОХ', 'ТАЙНЫЙ_ПРОРЫВ']) expect(block).not.toContain(secret);
  });
});
