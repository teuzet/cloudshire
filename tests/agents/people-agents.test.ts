import { describe, expect, test } from 'vitest';
import { FakeLlm, textReply, toolReply, toolsReply } from '../../src/adapters/llm/fake.js';
import { fixedSettings } from '../../src/agents/_shared/settings.js';
import { writeGenesisAspects, writeGenesisCore } from '../../src/agents/city-genesis/run.js';
import { aspectBatches } from '../../src/agents/city-genesis/aspects.js';
import { writeOfficerNatures } from '../../src/agents/officer-nature/run.js';
import { writeCityBrief } from '../../src/agents/city-brief/run.js';
import { createObject } from '../../src/core/world/objects.js';
import { aspectText } from '../helpers/genesis.js';
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
  const core = (over: Record<string, unknown> = {}) => ({
    city_name: 'Мерв',
    priest_name: 'Таэн',
    priest_description: 'Тиха и внимательна к знамениям.',
    greeting: 'Алаэр, город слышит тебя.',
    opening_lore: Array.from({ length: 8 }, (_, i) => `Факт ${i + 1}.`),
    ...over,
  });

  test('city-genesis ядро: имя жреца из пула, имя города как дал игрок, приветствие слуги по имени', async () => {
    const llm = new FakeLlm().script(
      'city-genesis',
      toolReply('submit_core', core({ city_name: 'Другое' })),
      toolReply('submit_core', core({ priest_name: 'Чужой' })),
      toolReply('submit_core', core({ greeting: 'Добро пожаловать в Мерв!' })),
    );
    await expect(writeGenesisCore(deps(llm), { seed, names: pool, seasonRules: [] })).rejects.toThrow(/greeting/);
    const sent = JSON.stringify(llm.requests.map((q) => q.messages));
    expect(sent).toContain('ровно «Мерв»');
    expect(sent).toContain('Чужой нет в списке');
  });

  test('city-genesis ядро: правила сезона в контексте, факты и жрец в ответе', async () => {
    const llm = new FakeLlm().script('city-genesis', toolReply('submit_core', core()));
    const c = await writeGenesisCore(deps(llm), { seed, names: pool, seasonRules: ['Через месяц придут драконы'] });
    // Пол жреца — из пула мира, не от модели.
    expect(c).toMatchObject({ cityName: 'Мерв', priest: { name: 'Таэн', gender: 'female' } });
    expect(c.openingLore).toHaveLength(8);
    expect(llm.requests[0]?.system).toContain('драконы');
    expect(llm.requests[0]?.messages[0]?.content).toContain('ИЗОЛЯЦИЯ ДЛЯ ГЕНЕЗИСА');
  });

  test('city-genesis аспекты: короткий или повторённый раздел отбивается', async () => {
    const batch = aspectBatches()[0]!;
    const good = Object.fromEntries(batch.map((a) => [a.id, aspectText(a.id)]));
    const dup = Object.fromEntries(batch.map((a) => [a.id, aspectText('одно')]));
    const llm = new FakeLlm().script(
      'city-genesis',
      toolReply('submit_aspects', { ...good, [batch[0]!.id]: 'коротко' }),
      toolReply('submit_aspects', dup),
      toolReply('submit_aspects', good),
    );
    const out = await writeGenesisAspects(deps(llm), {
      seed,
      core: { cityName: 'Мерв', priest: { name: 'Таэн', gender: 'female', nature: '' }, greeting: '', openingLore: [] },
      batch,
      already: {},
    });
    expect(Object.keys(out)).toEqual(batch.map((a) => a.id));
    expect(JSON.stringify(llm.requests[2]?.messages)).toContain('повторяют');
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
    const brief = 'Мерв живёт камнем. '.repeat(10);
    const llm = new FakeLlm().script(
      'city-brief',
      toolReply('submit_city_brief', { brief, unknowns: [{ text: 'Кто построил башню, не установлено.', object_ids: ['nowhere'] }] }),
      toolReply('submit_city_brief', { brief, unknowns: [{ text: '- Кто построил башню, не установлено.', object_ids: ['tower'] }, { text: 'нет' }] }),
    );
    const out = await writeCityBrief(deps(llm), { cityName: 'Мерв', patronName: 'Алаэр', patronGender: 'female', description: 'Город', objects });
    expect(out.unknowns).toEqual([{ text: 'Кто построил башню, не установлено.', objectIds: ['tower'] }]);
    expect(llm.requests[0]?.system).toContain('ОБЪЕКТЫ');
  });

  test('onboarding-guide: seed появляется, только когда агент его дал', async () => {
    const llm = new FakeLlm().script(
      'onboarding-guide',
      toolReply('submit_onboarding', { reply: 'Как тебя звать?' }),
      toolReply('submit_onboarding', { reply: 'Начинаем.', seed: { patron_name: 'Алаэр', patron_gender: 'female', pitch: 'Город каменотёсов' } }),
    );
    expect((await guideOnboarding(deps(llm), { turns: [] })).seed).toBeNull();
    const done = await guideOnboarding(deps(llm), { turns: [{ role: 'patron', text: 'Я Алаэр' }] });
    expect(done.seed).toEqual({ cityName: null, patronName: 'Алаэр', patronGender: 'female', pitch: 'Город каменотёсов' });
    expect(llm.requests[0]?.system).toContain('КОНТРАКТ БЕЗОПАСНОСТИ');
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
      consultLoremaster: async (a) => (log.push(`lore:${a.question}:${a.story_id ?? ''}`), { ok: true, say: 'В: что\nО: так' }),
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
