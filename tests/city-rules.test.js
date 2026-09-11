import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RULE_DURATION_BAND,
  RULE_DIFFICULTY,
  parseRuleAction,
  isRuleDeed,
  markRuleDeed,
  cityRules,
  findRule,
  removeRule,
  applyRuleDeed,
  proxyText,
  setProxyText,
  formatCityRulesForPrompt,
} from '../src/game/cityRules.js';
import { seedQueue, enqueueSeedRequest } from '../src/game/seedSchedule.js';

function makeDomain() {
  return {
    id: 'd1',
    name: 'Тихая Гряда',
    stats: { prosperity: 70, security: 55 },
    modifiers: [],
    lore: [],
    officers: [
      { id: 'off1', office: 'prosperity', statId: 'prosperity', title: 'Казначей', name: 'Ждан', processId: null },
      { id: 'off2', office: 'influence', statId: 'influence', title: 'Канцлер', name: 'Мирава', processId: null },
    ],
    characters: [{ name: 'Малуша', dialogHistory: [] }],
    plotlines: [],
    state: { pendingActions: [] },
  };
}

function ruleDeed(extra = {}) {
  return markRuleDeed(
    { id: 'proc1', summary: 'объявить удвоенную подать', status: 'active', linkedStats: ['prosperity'], ...extra },
    { text: 'Подать удвоена', action: extra.ruleAction || 'declare' },
  );
}

// ───────────────────────────── разметка дела ─────────────────────────────

test('дело о правиле всегда полосы дней', () => {
  const p = ruleDeed();
  assert.equal(p.durationBand, RULE_DURATION_BAND);
  assert.equal(p.difficulty, RULE_DIFFICULTY);
  assert.equal(isRuleDeed(p), true);
});

test('обычное дело правилом не считается', () => {
  assert.equal(isRuleDeed({ id: 'x', summary: 'починить стену' }), false);
  assert.equal(isRuleDeed(null), false);
});

test('пустой текст правила дело не размечает', () => {
  const p = markRuleDeed({ id: 'x' }, { text: '   ' });
  assert.equal(isRuleDeed(p), false);
});

test('мусорное действие читается как объявление', () => {
  assert.equal(parseRuleAction('чтотоне'), 'declare');
  assert.equal(parseRuleAction('revoke'), 'revoke');
});

// ───────────────────────────── объявление ─────────────────────────────

test('успех дописывает правило в постоянные изменения города', () => {
  const domain = makeDomain();
  const res = applyRuleDeed(domain, ruleDeed(), { finish: 'ok', day: 120, rng: () => 0.9 });
  assert.equal(res.applied, true);
  assert.equal(cityRules(domain).length, 1);
  assert.equal(cityRules(domain)[0].text, 'Подать удвоена');
  assert.match(cityRules(domain)[0].sinceLabel, /Год 1, месяц 5/);
  assert.match(res.text, /Город живёт по новому порядку/);
});

test('объявленное правило ставит отложенные последствия в очередь посева', () => {
  const domain = makeDomain();
  applyRuleDeed(domain, ruleDeed(), { finish: 'ok', day: 120, rng: () => 0.9 });
  const queue = seedQueue(domain);
  assert.equal(queue.length, 1);
  assert.equal(queue[0].sourceOrderId, cityRules(domain)[0].id);
  assert.ok(queue[0].appearDay >= 120, 'полная казна и бунт бедняков приходят позже');
});

test('провал объявления — это событие, а не тишина', () => {
  const domain = makeDomain();
  const res = applyRuleDeed(domain, ruleDeed(), { finish: 'fail', day: 120 });
  assert.equal(res.applied, false);
  assert.match(res.text, /город её не принял/);
  assert.equal(cityRules(domain).length, 0);
  assert.equal(seedQueue(domain).length, 0);
});

test('дважды объявленное правило не удваивается', () => {
  const domain = makeDomain();
  applyRuleDeed(domain, ruleDeed(), { finish: 'ok', day: 120, rng: () => 0.9 });
  applyRuleDeed(domain, ruleDeed({ id: 'proc2' }), { finish: 'ok', day: 200, rng: () => 0.9 });
  assert.equal(cityRules(domain).length, 1);
});

// ───────────────────────────── отмена ─────────────────────────────

test('отмена убирает правило и гасит его отложенные последствия', () => {
  const domain = makeDomain();
  applyRuleDeed(domain, ruleDeed(), { finish: 'ok', day: 120, rng: () => 0.9 });
  const ruleId = cityRules(domain)[0].id;
  enqueueSeedRequest(domain, { source: 'errand', sourceOrderId: ruleId, day: 130, delayDays: 200 });

  const res = applyRuleDeed(domain, ruleDeed({ id: 'proc2', ruleAction: 'revoke' }), {
    finish: 'ok',
    day: 200,
  });
  assert.equal(res.applied, true);
  assert.equal(cityRules(domain).length, 0);
  assert.equal(res.droppedSeeds, 2, 'отменённое правило не догоняет игрока последствиями');
  assert.equal(seedQueue(domain).length, 0);
});

test('отмена того, чего нет, честно говорит об этом', () => {
  const domain = makeDomain();
  const res = applyRuleDeed(domain, ruleDeed({ ruleAction: 'revoke' }), { finish: 'ok', day: 120 });
  assert.equal(res.applied, false);
  assert.match(res.text, /уже нет/);
});

test('провал отмены оставляет правило в силе', () => {
  const domain = makeDomain();
  applyRuleDeed(domain, ruleDeed(), { finish: 'ok', day: 120, rng: () => 0.9 });
  const res = applyRuleDeed(domain, ruleDeed({ id: 'proc2', ruleAction: 'revoke' }), {
    finish: 'fail',
    day: 200,
  });
  assert.equal(res.applied, false);
  assert.equal(cityRules(domain).length, 1);
});

test('правило находится по смыслу, а не только по id', () => {
  const domain = makeDomain();
  applyRuleDeed(domain, ruleDeed(), { finish: 'ok', day: 120, rng: () => 0.9 });
  assert.ok(findRule(domain, { text: 'подать удвоена' }));
  assert.ok(findRule(domain, { text: 'Подать' }));
  assert.equal(findRule(domain, { text: 'запрет на охоту' }), null);
  assert.equal(removeRule(domain, 'нет такого'), null);
});

// ─────────────────────── доверенность ───────────────────────

test('доверенность ставится и снимается', () => {
  const domain = makeDomain();
  assert.equal(proxyText(domain), '');
  const set = setProxyText(domain, 'Слать посольство первым');
  assert.equal(set.ok, true);
  assert.equal(proxyText(domain), 'Слать посольство первым');
  setProxyText(domain, '');
  assert.equal(proxyText(domain), '');
});

test('пустая доверенность не ставится', () => {
  const domain = makeDomain();
  assert.equal(setProxyText(domain, '  ').proxyText, '');
});

test('старый наказ читается как доверенность', () => {
  const domain = makeDomain();
  domain.state.confluxDirective = { text: 'Не пускать чужих' };
  assert.equal(proxyText(domain), 'Не пускать чужих');
});

// ───────────────────────────── речь жреца ─────────────────────────────

test('порядок для промпта собирает только правила', () => {
  const domain = makeDomain();
  assert.equal(formatCityRulesForPrompt(domain), '');
  applyRuleDeed(domain, ruleDeed(), { finish: 'ok', day: 120, rng: () => 0.9 });
  setProxyText(domain, 'Слать посольство первым');
  const text = formatCityRulesForPrompt(domain);
  assert.match(text, /Подать удвоена/);
  assert.equal(text.includes('посольство'), false);
});
