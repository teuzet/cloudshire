import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inferRulerGender, normalizeDomain } from '../src/game/models.js';
import { dialogHistoryForPrompt } from '../src/game/memory.js';
import { loadConfig } from '../src/config.js';
import { rulerHoldLine, rulerFailLine } from '../src/game/app.js';

test('пол жреца — male|female, не boolean; без поля — по титулу и имени', () => {
  assert.equal(inferRulerGender({ gender: 'female' }), 'female');
  assert.equal(inferRulerGender({ gender: 'male' }), 'male');
  assert.equal(inferRulerGender({ title: 'верховная жрица', name: 'Кальдр' }), 'female');
  assert.equal(inferRulerGender({ name: 'Морена' }), 'female');
  assert.equal(inferRulerGender({ name: 'Фендри' }), 'male');
});

test('normalizeDomain дописывает gender старому правителю', () => {
  const domain = normalizeDomain({
    characters: [{ name: 'Морена', title: 'жрица', loyalty: 50, terror: 50 }],
  });
  assert.equal(domain.characters[0].gender, 'female');
});

test('hold и fail берутся из конфига по полу', () => {
  const config = loadConfig();
  const female = rulerHoldLine(config, { name: 'Морена', gender: 'female' });
  const male = rulerHoldLine(config, { name: 'Фендри', gender: 'male' });
  assert.match(female, /услышала/);
  assert.match(male, /услышал/);
  assert.match(rulerFailLine(config), /система не сохранила/);
});

test('системный отказ не попадает в промпт жреца', () => {
  const prompt = dialogHistoryForPrompt([
    { role: 'user', content: 'патруль по краю' },
    { role: 'assistant', content: 'Жрец не ответил.', kind: 'system' },
    { role: 'user', content: 'ещё раз: патруль' },
    { role: 'assistant', content: 'Будет сделано.' },
  ]);
  assert.deepEqual(
    prompt.map((m) => m.content),
    ['ещё раз: патруль', 'Будет сделано.'],
  );
});
