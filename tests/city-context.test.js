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
