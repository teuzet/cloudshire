import { describe, expect, test } from 'vitest';
import { FakeLlm, textReply, toolReply, toolsReply } from '../../src/adapters/llm/fake.js';
import { fixedSettings } from '../../src/agents/_shared/settings.js';
import { writeCityGenesis } from '../../src/agents/city-genesis/run.js';
import { guideOnboarding } from '../../src/agents/onboarding-guide/run.js';
import { writeNews } from '../../src/agents/herald/run.js';
import { priestTurnBlock, runPriestTurn, type PriestHandlers } from '../../src/agents/priest/run.js';
import { createFront } from '../../src/core/world/fronts.js';
import { blankCity, rules } from '../helpers/fixtures.js';

const r = rules();
const deps = (llm: FakeLlm) => ({ llm, settings: fixedSettings() });

describe('генезис и онбординг', () => {
  const person = (name: string) => ({ name, gender: 'female', nature: 'тиха' });
  const genesis = (names: string[]) => ({
    city_name: 'Мерв',
    description: 'Город на краю. '.repeat(30),
    brief: 'Бриф города Мерв. '.repeat(10),
    priest: person(names[0]!),
    officers: { treasurer: person(names[1]!), marshal: person(names[2]!), keeper: person(names[3]!), chancellor: person(names[4]!) },
    greeting: 'Покровительница, город слышит тебя.',
  });
  const seed = { cityName: 'Мерв', patronName: 'Алаэр', patronGender: 'female' as const, pitch: 'Город каменотёсов' };
  const pool = ['Таэн', 'Иса', 'Орм', 'Лиэ', 'Кайр', 'Вэс'];

  test('city-genesis: имена только из пула и без повторов, имя города — как дал игрок', async () => {
    const llm = new FakeLlm().script(
      'city-genesis',
      toolReply('submit_genesis', genesis(['Таэн', 'Таэн', 'Орм', 'Лиэ', 'Кайр'])),
      toolReply('submit_genesis', genesis(['Таэн', 'Чужой', 'Орм', 'Лиэ', 'Кайр'])),
      toolReply('submit_genesis', genesis(pool)),
    );
    const g = await writeCityGenesis(deps(llm), { seed, names: pool, seasonRules: ['Через месяц придут драконы'] });
    expect(g.cityName).toBe('Мерв');
    expect(g.officers.keeper.name).toBe('Лиэ');
    expect(llm.requests).toHaveLength(3);
    expect(llm.requests[0]?.system).toContain('драконы');
  });

  test('city-genesis: имя города, данное игроком, не подменяется', async () => {
    const llm = new FakeLlm().script(
      'city-genesis',
      toolReply('submit_genesis', { ...genesis(pool), city_name: 'Другое' }),
      toolReply('submit_genesis', genesis(pool)),
    );
    expect((await writeCityGenesis(deps(llm), { seed, names: pool, seasonRules: [] })).cityName).toBe('Мерв');
    expect(JSON.stringify(llm.requests[1]?.messages)).toContain('ровно «Мерв»');
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
      entry: { id: 'c1', day: 3, text: 'Хранитель вскрыл башню.', source: 'stake', frontId: 'f1' },
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
      createFront(r, {
        id: 'f1',
        description: 'Добраться до рецепта в башне',
        stake: { reveal: { text: 'ТАЙНА_СТАВКИ' } },
        effort: 10,
        driftBand: 'NONE',
        beatCount: 1,
        events: [{ id: 'e', description: 'ТАЙНОЕ_СОБЫТИЕ' }],
        clues: [{ id: 'c', fact: 'ТАЙНАЯ_УЛИКА', alignment: '' }],
        alignment: 'СКРЫТАЯ_ЛОГИКА',
        day: 0,
      }),
    );
    const block = priestTurnBlock(r, city, 5);
    expect(block).toContain('Добраться до рецепта в башне');
    for (const secret of ['СКРЫТАЯ_ЛОГИКА', 'ТАЙНОЕ_СОБЫТИЕ', 'ТАЙНАЯ_УЛИКА', 'ТАЙНА_СТАВКИ']) expect(block).not.toContain(secret);
  });
});
