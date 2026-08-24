import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyPatronName,
  ensurePatronFact,
  findPatronFact,
  normalizeDomain,
} from '../src/game/models.js';

test('имя покровителя становится фактом города', () => {
  const domain = {
    name: 'Саркум',
    lore: [],
    state: { events: [], modifiers: [], pendingActions: [], patronName: null },
  };
  const set = applyPatronName(domain, 'Астра');
  assert.equal(set.ok, true);
  assert.equal(domain.state.patronName, 'Астра');
  const fact = findPatronFact(domain);
  assert.ok(fact);
  assert.match(fact.text, /Астра является покровителем города «Саркум»/);
});

test('уже данное имя покровителя нельзя сменить', () => {
  const domain = {
    name: 'Саркум',
    lore: [],
    state: { patronName: 'Астра' },
  };
  ensurePatronFact(domain);
  const again = applyPatronName(domain, 'Лаэна');
  assert.equal(again.error, 'locked');
  assert.equal(domain.state.patronName, 'Астра');
});

test('нормализация дописывает факт, если имя уже есть', () => {
  const domain = {
    name: 'Саркум',
    lore: [],
    state: { patronName: 'Астра' },
  };
  normalizeDomain(domain);
  const fact = findPatronFact(domain);
  assert.ok(fact);
  assert.match(fact.text, /Астра/);
});
