import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  appendCityModifier,
  formatCityForAgents,
  formatCityModifiersForPrompt,
  normalizeCityModifiers,
  parseCityBrief,
  formatCityBrief,
  CANONICAL_UNKNOWNS_HEADING,
  CITY_BRIEF_MAX,
  CITY_BRIEF_AGENT_MAX,
} from '../src/game/cityContext.js';

test('агентам бриф и дописки в хвосте', () => {
  const domain = {
    cityBrief: 'Город стоит у цистерн и держит ночной дозор.',
    description: 'Длинный генезис, который агентам тика не нужен.',
    modifiers: [],
  };
  assert.equal(formatCityForAgents(domain), 'Город стоит у цистерн и держит ночной дозор.');
  appendCityModifier(domain, {
    text: 'Нижний ярус пьёт воду из соседней цистерны.',
    sinceTick: 4,
    sinceLabel: 'Год 1, месяц 4',
  });
  const withMods = formatCityForAgents(domain);
  assert.match(withMods, /Город стоит у цистерн и держит ночной дозор/);
  assert.match(withMods, /Нижний ярус/);
  const leftover = formatCityModifiersForPrompt(domain);
  assert.match(leftover, /Нижний ярус/);
});

test('без брифа — запасной description; старый порядок из state.modifiers переезжает в правила', () => {
  const domain = {
    description: 'Старое описание.',
    state: { modifiers: [{ id: 'mod_1', text: 'Налоги вдвое' }] },
    modifiers: [],
  };
  normalizeCityModifiers(domain);
  assert.equal(domain.modifiers.length, 1);
  assert.equal(domain.modifiers[0].text, 'Налоги вдвое');
  const forAgents = formatCityForAgents(domain);
  assert.match(forAgents, /Старое описание/);
  assert.match(forAgents, /Налоги вдвое/);
  assert.match(formatCityModifiersForPrompt(domain), /Налоги вдвое/);
});

test('канонические неизвестности живут в брифе отдельным блоком и не отрезаются с хвоста', () => {
  const assembled = formatCityBrief({
    body: `${'ярус '.repeat(400)}конец тела`,
    unknowns: ['источник набегов чудовищ официально не установлен', 'что на северном плато, люди не видели'],
  });
  assert.match(assembled, new RegExp(CANONICAL_UNKNOWNS_HEADING.replace(/[()]/g, '\\$&')));
  assert.match(assembled, /источник набегов чудовищ официально не установлен/);
  const parsed = parseCityBrief(assembled);
  assert.equal(parsed.unknowns.length, 2);
  assert.match(formatCityForAgents({ cityBrief: assembled }), /Неизвестно \(канон\)/);
});

test('агентам бриф уходит целиком: без потолка обрезки и без схлопывания абзацев', () => {
  const body = `Первый абзац.\n\n${'ярус '.repeat(800)}хвост брифа`;
  const brief = `${body}\n\n${CANONICAL_UNKNOWNS_HEADING}\n- источник набегов чудовищ официально не установлен`;
  assert.ok(brief.length > CITY_BRIEF_MAX);
  const sent = formatCityForAgents({ cityBrief: brief });
  assert.equal(sent, brief);
  assert.match(sent, /хвост брифа/);
  assert.match(sent, /Первый абзац\.\n\n/);
  assert.doesNotMatch(sent, /…/);
});

test('хранение брифа режет на 4000, писателю говорят 3500', () => {
  assert.equal(CITY_BRIEF_MAX, 4000);
  assert.equal(CITY_BRIEF_AGENT_MAX, 3500);
  const kept = formatCityBrief({ body: 'а'.repeat(3600) });
  assert.equal(kept.length, 3600);
  const clipped = formatCityBrief({ body: 'а'.repeat(4500) });
  assert.match(clipped, /…$/);
  assert.ok(clipped.length <= CITY_BRIEF_MAX + 1);
  assert.ok(clipped.length < 4500);
});
