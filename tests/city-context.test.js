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

test('агентам только бриф; старые дописки в промпт не идут', () => {
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
  assert.equal(formatCityForAgents(domain), 'Город стоит у цистерн и держит ночной дозор.');
  const leftover = formatCityModifiersForPrompt(domain);
  assert.match(leftover, /Нижний ярус/);
});

test('без брифа — запасной description; указы в state.modifiers не попадают в дописки', () => {
  const domain = {
    description: 'Старое описание.',
    state: { modifiers: [{ id: 'mod_1', kind: 'order', text: 'Налоги вдвое' }] },
    modifiers: [],
  };
  normalizeCityModifiers(domain);
  assert.equal(domain.modifiers.length, 0);
  assert.equal(formatCityForAgents(domain), 'Старое описание.');
  assert.equal(formatCityModifiersForPrompt(domain), '');
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
