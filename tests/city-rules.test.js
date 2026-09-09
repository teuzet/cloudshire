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
  confluxDirective,
  setConfluxDirective,
  clearConfluxDirective,
  fireConfluxDirective,
  formatCityRulesForPrompt,
} from '../src/game/cityRules.js';
import { seedQueue, enqueueSeedRequest } from '../src/game/seedSchedule.js';
import { startDeed } from '../src/game/deeds.js';
import { officerActiveProcess } from '../src/game/officers.js';

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

// ─────────────────────── наказ на сопряжение ───────────────────────

test('наказ ставится и снимается', () => {
  const domain = makeDomain();
  assert.equal(confluxDirective(domain), null);
  const set = setConfluxDirective(domain, { text: 'Слать посольство первым', office: 'influence' });
  assert.equal(set.ok, true);
  assert.equal(confluxDirective(domain).office, 'influence');
  assert.equal(clearConfluxDirective(domain).ok, true);
  assert.equal(confluxDirective(domain), null);
  assert.equal(clearConfluxDirective(domain).ok, false);
});

test('пустой наказ не ставится', () => {
  const domain = makeDomain();
  assert.equal(setConfluxDirective(domain, { text: '  ' }).ok, false);
});

test('наказ заводит обычное дело и называет столп', () => {
  const domain = makeDomain();
  setConfluxDirective(domain, { text: 'Слать посольство первым', office: 'influence' });
  const res = fireConfluxDirective(domain, { day: 300, partnerName: 'Гряда Ветров', plotId: 'main1', rng: () => 0.5 });
  assert.equal(res.ok, true);
  assert.equal(res.officer.id, 'off2');
  assert.equal(res.process.officerId, 'off2');
  assert.equal(res.process.plotlineId, 'main1');
  assert.match(res.process.detail, /Гряда Ветров/);
  assert.ok(res.process.dueDay > 300, 'дело идёт по дням, а не срабатывает мгновенно');
});

test('занятый столп прерывается паузой, о которой докладывают', () => {
  const domain = makeDomain();
  const busy = startDeed(
    { id: 'old', summary: 'вести тяжбу', status: 'active', officerId: 'off2', office: 'influence' },
    { day: 200, judged: { durationBand: 'SEASON', objectiveDays: 100 } },
  );
  domain.state.pendingActions.push(busy);
  domain.officers[1].processId = 'old';
  setConfluxDirective(domain, { text: 'Слать посольство первым', office: 'influence' });

  const res = fireConfluxDirective(domain, { day: 250, plotId: 'main1', rng: () => 0.5 });
  assert.equal(res.paused.id, 'old');
  assert.equal(busy.status, 'paused');
  assert.equal(busy.pausedBy, 'order', 'такая пауза не истлевает молча');
  assert.equal(busy.pausedRemainingDays, 50, 'проделанное не пропадает');
  assert.equal(officerActiveProcess(domain, domain.officers[1])?.id, res.process.id);
});

test('наказ не срабатывает дважды на одной встрече', () => {
  const domain = makeDomain();
  setConfluxDirective(domain, { text: 'Слать посольство первым' });
  fireConfluxDirective(domain, { day: 300, plotId: 'main1', rng: () => 0.5 });
  const again = fireConfluxDirective(domain, { day: 305, plotId: 'main1', rng: () => 0.5 });
  assert.equal(again.ok, false);
  assert.equal(again.error, 'already_acting');
});

test('без наказа ничего не заводится', () => {
  const domain = makeDomain();
  const res = fireConfluxDirective(domain, { day: 300, plotId: 'main1' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'no_directive');
  assert.equal(domain.state.pendingActions.length, 0);
});

// ───────────────────────────── речь жреца ─────────────────────────────

test('порядок для промпта собирает правила и наказ', () => {
  const domain = makeDomain();
  assert.equal(formatCityRulesForPrompt(domain), '');
  applyRuleDeed(domain, ruleDeed(), { finish: 'ok', day: 120, rng: () => 0.9 });
  setConfluxDirective(domain, { text: 'Слать посольство первым' });
  const text = formatCityRulesForPrompt(domain);
  assert.match(text, /Подать удвоена/);
  assert.match(text, /при сопряжении: Слать посольство первым/);
});
