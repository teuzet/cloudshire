import { describe, expect, test } from 'vitest';
import { FakeLlm, toolReply, toolsReply } from '../../src/adapters/llm/fake.js';
import { fixedSettings } from '../../src/agents/_shared/settings.js';
import { askLoremaster, lorePayload } from '../../src/agents/loremaster/run.js';
import { addFact, mysteryObjectIds, newFact, normalizeUnknowns, retireFact, updateFact } from '../../src/core/lore.js';
import { createFront } from '../../src/core/world/fronts.js';
import { blankCity, rules } from '../helpers/fixtures.js';

const r = rules();
const deps = (llm: FakeLlm) => ({ llm, settings: fixedSettings() });

function cityWithStory() {
  const city = blankCity();
  city.facts.push(newFact({ id: 'fact_salt', text: 'Соль добывают на северном поле.', day: 0, author: 'genesis' }));
  city.unknowns = [{ text: 'Откуда приходят ночные огни, не установлено.', objectIds: [] }];
  const front = createFront(r, {
    id: 'f1',
    description: 'Добраться до рецепта в башне',
    stake: { reveal: { text: 'ТАЙНА_СТАВКИ' } },
    effort: 10,
    driftBand: 'NONE',
    beatCount: 1,
    events: [],
    clues: [
      { id: 'c1', fact: 'ТАЙНАЯ_УЛИКА', alignment: '' },
      { id: 'c2', fact: 'ВЫЯСНЕННОЕ', alignment: '' },
    ],
    alignment: 'СКРЫТАЯ_ЛОГИКА',
    day: 0,
  });
  front.clues[1]!.status = 'revealed';
  city.fronts.push(front);
  return city;
}

describe('факты мира в ядре', () => {
  test('незнание не пишется фактом, уточнение переписывает, снятый факт не правится', () => {
    const city = blankCity();
    expect(addFact(city, { id: 'a', text: 'Причина пожара не установлена.', day: 1, author: 'loremaster' })).toMatchObject({ ok: false, error: 'not_a_fact' });
    expect(addFact(city, { id: 'a', text: 'Храм сгорел зимой.', day: 1, author: 'loremaster' }).ok).toBe(true);
    expect(updateFact(city, 'a', 'Храм сгорел зимой и отстроен весной.', 'отстроили')).toMatchObject({ ok: true });
    expect(city.facts[0]).toMatchObject({ previousText: 'Храм сгорел зимой.', text: 'Храм сгорел зимой и отстроен весной.' });
    expect(retireFact(city, 'a', 'снесли').ok).toBe(true);
    expect(updateFact(city, 'a', 'Новое.', null)).toMatchObject({ ok: false, error: 'fact_not_found' });
  });

  test('неизвестности: чистка списка и только живые объекты', () => {
    const list = normalizeUnknowns(
      [{ text: '- Кто строил башню, не установлено.', objectIds: ['tower', 'nowhere'] }, { text: 'нет' }, { text: 'кто строил башню, не установлено.' }],
      new Set(['tower']),
    );
    expect(list).toEqual([{ text: 'Кто строил башню, не установлено.', objectIds: ['tower'] }]);
    expect([...mysteryObjectIds({ unknowns: list })]).toEqual(['tower']);
  });
});

describe('лормастер', () => {
  test('без фокуса скрытый слой истории не виден, неизвестности под замком', () => {
    const city = cityWithStory();
    const text = JSON.stringify(lorePayload({ city, day: 3, questions: [], asker: 'priest', frontId: null, newFactId: () => 'x' }, null));
    for (const secret of ['СКРЫТАЯ_ЛОГИКА', 'ТАЙНАЯ_УЛИКА', 'ТАЙНА_СТАВКИ']) expect(text).not.toContain(secret);
    expect(text).toContain('fact_salt: Соль добывают на северном поле.');
    expect(text).toContain('Откуда приходят ночные огни');
    expect(text).toContain('canonicalUnknowns — установленный пробел мира');
  });

  test('сначала read_lore, новый факт привязан к истории под фокусом', async () => {
    const city = cityWithStory();
    let n = 0;
    const llm = new FakeLlm().script(
      'loremaster',
      toolReply('read_lore', {}),
      toolsReply(
        ['add_fact', { text: 'Сведений нет, возможно, башню строили пришлые.' }],
        ['add_fact', { text: 'Дверь башни обита медью.' }],
        ['update_fact', { fact_id: 'fact_salt', text: 'Соль добывают на северном и южном полях.' }],
      ),
      toolReply('submit_answers', { answers: [{ question: 'Чем обита дверь?', answer: 'Медью.', invented: true }] }),
    );
    const out = await askLoremaster(deps(llm), { city, day: 4, questions: ['Чем обита дверь?'], asker: 'priest', frontId: 'f1', newFactId: () => `fact_${++n}` });

    expect(llm.requests[0]?.toolChoice).toEqual({ name: 'read_lore' });
    const lore = JSON.stringify(llm.requests[1]?.messages.at(-1));
    expect(lore).toContain('ФОКУС: история f1');
    expect(lore).toContain('ГОРОД ЭТО УЖЕ ВЫЯСНИЛ');
    expect(lore).toContain('ВЫЯСНЕННОЕ');
    expect(lore).toContain('ТАЙНАЯ_УЛИКА');
    expect(out.added.map((f) => f.text)).toEqual(['Дверь башни обита медью.']);
    expect(out.added[0]).toMatchObject({ frontId: 'f1', author: 'loremaster', day: 4 });
    expect(city.facts.find((f) => f.id === 'fact_salt')?.text).toBe('Соль добывают на северном и южном полях.');
    expect(JSON.stringify(llm.requests[2]?.messages)).toContain('not_a_fact');
    expect(out.text).toContain('О: Медью. (уточнено)');
  });

  test('закрытая или чужая история — без фокуса', async () => {
    const city = cityWithStory();
    const llm = new FakeLlm().script(
      'loremaster',
      toolReply('read_lore', {}),
      toolReply('submit_answers', { answers: [{ question: 'Что в башне?', answer: 'Не знаю.' }] }),
    );
    const out = await askLoremaster(deps(llm), { city, day: 4, questions: ['Что в башне?'], asker: 'priest', frontId: 'nope', newFactId: () => 'x' });
    expect(out.focusFrontId).toBeNull();
    expect(JSON.stringify(llm.requests[1]?.messages)).not.toContain('ТАЙНАЯ_УЛИКА');
  });
});
