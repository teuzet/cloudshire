import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  appendCityModifier,
  formatCityForAgents,
  formatCityModifiersForPrompt,
  normalizeCityModifiers,
} from '../src/game/cityContext.js';

test('агентам бриф, сразу после него — постоянные дописки с датой', () => {
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
  const text = formatCityForAgents(domain);
  assert.match(text, /Город стоит у цистерн/);
  assert.match(text, /Постоянные изменения города/);
  assert.match(text, /Год 1, месяц 4/);
  assert.match(text, /Нижний ярус/);
  assert.equal(text.indexOf('Город стоит') < text.indexOf('Постоянные изменения'), true);
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
