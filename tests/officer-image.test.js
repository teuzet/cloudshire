import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeOfficerPortraitPrompt } from '../src/game/officerImage.js';
import {
  formatLookForSpeech,
  ensureOfficerLook,
  officerGender,
  ensureOfficersFromLore,
} from '../src/game/officers.js';

test('портрет женщины явно просит женщину и имя из пула', () => {
  const prompt = composeOfficerPortraitPrompt({
    officer: {
      name: 'Елана',
      gender: 'female',
      title: 'Хранитель',
      office: 'keeper',
      look: { ageYears: 40, build: 'сухощавый', hairColor: 'тёмно-русые', hairStyle: 'в косу' },
      nature: 'Осторожна с памятью города.',
    },
    cityName: 'Грасток',
    style: 'oak panel',
  });
  assert.match(prompt, /WOMAN/);
  assert.match(prompt, /woman/);
  assert.doesNotMatch(prompt, /ONE living MAN/);
  assert.match(prompt, /Елана/);
  assert.match(prompt, /сухощавая/);
});

test('портрет мужчины явно просит мужчину', () => {
  const prompt = composeOfficerPortraitPrompt({
    officer: {
      name: 'Делмир',
      gender: 'male',
      title: 'Воевода',
      office: 'marshal',
      look: { ageYears: 54, build: 'высокий' },
    },
    cityName: 'Грасток',
  });
  assert.match(prompt, /MAN/);
  assert.doesNotMatch(prompt, /ONE living WOMAN/);
  assert.match(prompt, /высокий/);
});

test('вид согласуется с полом; неполный look добирается, возраст держится', () => {
  assert.equal(officerGender({ name: 'Елана', title: 'Хранитель' }), 'female');
  assert.match(formatLookForSpeech({ build: 'крепкий', skin: 'бледная' }, 'female'), /крепкая/);
  const officer = { office: 'keeper', look: { ageYears: 40 }, ageYears: 40 };
  ensureOfficerLook(officer, {}, () => 0.2);
  assert.equal(officer.look.ageYears, 40);
  assert.ok(officer.look.hairColor);
  assert.ok(officer.look.clothing);
});

test('восстановленный столп из lore получает полный look', () => {
  const domain = {
    id: 'd1',
    officers: [
      { id: 'off_t', office: 'treasurer', statId: 'prosperity', title: 'Казначей', name: 'Элира' },
    ],
    lore: [
      { kind: 'officer', office: 'keeper', name: 'Елана', gender: 'female', ageYears: 40, tags: ['officer'] },
      { kind: 'officer', office: 'marshal', name: 'Делмир', gender: 'male', tags: ['officer'] },
      { kind: 'officer', office: 'chancellor', name: 'Корн', gender: 'male', tags: ['officer'] },
    ],
    state: { pendingActions: [] },
  };
  ensureOfficersFromLore(domain, {
    stats: [{ id: 'prosperity' }, { id: 'security' }, { id: 'knowledge' }, { id: 'influence' }],
  });
  const elana = domain.officers.find((o) => o.office === 'keeper');
  assert.equal(elana.gender, 'female');
  assert.equal(elana.look.ageYears, 40);
  assert.ok(elana.look.hairColor);
  assert.ok(elana.look.build);
});
