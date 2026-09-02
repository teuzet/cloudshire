import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canStartProcess,
  processStatAverage,
  pauseProcess,
  resumeProcess,
  normalizeProcess,
  applyEngineProgress,
} from '../src/game/processes.js';
import {
  pickRandomFreeOfficer,
  bindOfficerProcess,
  isOffPortfolio,
  freeOfficers,
  formatOfficersForPrompt,
  ensureOfficersFromLore,
  officerBusyAgentMessage,
} from '../src/game/officers.js';
import { findDuplicateProcess } from '../src/game/processes.js';

const cfg = {
  stats: [{ id: 'prosperity' }, { id: 'security' }, { id: 'knowledge' }, { id: 'influence' }],
};

function makeOfficers(busyIds = {}) {
  return [
    { id: 'off_t', office: 'treasurer', statId: 'prosperity', title: 'Казначей', name: 'Элара', processId: busyIds.treasurer || null },
    { id: 'off_m', office: 'marshal', statId: 'security', title: 'Маршал', name: 'Кален', processId: busyIds.marshal || null },
    { id: 'off_k', office: 'keeper', statId: 'knowledge', title: 'Хранитель', name: 'Мира', processId: busyIds.keeper || null },
    { id: 'off_c', office: 'chancellor', statId: 'influence', title: 'Канцлер', name: 'Орен', processId: busyIds.chancellor || null },
  ];
}

function domainWith(officers, processes = []) {
  return {
    officers,
    stats: { prosperity: 60, security: 50, knowledge: 40, influence: 55 },
    state: { pendingActions: processes },
  };
}

test('четыре дела ок, пятое — все сановники заняты', () => {
  const officers = makeOfficers();
  const processes = [];
  const domain = domainWith(officers, processes);
  assert.equal(canStartProcess(domain, cfg).ok, true);
  for (let i = 0; i < 4; i += 1) {
    const p = { id: `act_${i}`, summary: `Дело ${i}`, status: 'active' };
    processes.push(p);
    bindOfficerProcess(domain, officers[i], p);
  }
  const slots = canStartProcess(domain, cfg);
  assert.equal(slots.ok, false);
  assert.equal(slots.max, 4);
  assert.equal(slots.active, 4);
  assert.equal(freeOfficers(domain).length, 0);
});

test('чужое дело: −40 только на броске, стат города тот же', () => {
  const domain = domainWith(makeOfficers());
  const before = { ...domain.stats };
  const process = normalizeProcess(
    {
      id: 'act_1',
      summary: 'Архив',
      linkedStats: ['knowledge'],
      office: 'marshal',
      officerId: 'off_m',
      offPortfolio: true,
    },
    cfg,
  );
  assert.equal(isOffPortfolio(domain.officers[1], 'knowledge'), true);
  assert.equal(processStatAverage(domain, process, cfg), 0);
  assert.deepEqual(domain.stats, before);
  process.offPortfolio = false;
  assert.equal(processStatAverage(domain, process, cfg), 40);
});

test('«разберитесь сами» берёт случайного свободного, не лучшего', () => {
  const domain = domainWith(makeOfficers({ treasurer: 'act_1', marshal: 'act_2', chancellor: 'act_3' }), [
    { id: 'act_1', summary: 'Казна', status: 'active', officerId: 'off_t', office: 'treasurer' },
    { id: 'act_2', summary: 'Стража', status: 'active', officerId: 'off_m', office: 'marshal' },
    { id: 'act_3', summary: 'Суд', status: 'active', officerId: 'off_c', office: 'chancellor' },
  ]);
  const picks = new Set();
  for (let i = 0; i < 20; i += 1) {
    picks.add(pickRandomFreeOfficer(domain, () => 0.9).office);
  }
  assert.deepEqual([...picks], ['keeper']);
});

test('пауза освобождает сановника, возобновление снова занимает того же', () => {
  const officers = makeOfficers();
  const process = normalizeProcess(
    { id: 'act_1', summary: 'Розыск', status: 'active', officerId: 'off_k', office: 'keeper' },
    cfg,
  );
  const domain = domainWith(officers, [process]);
  bindOfficerProcess(domain, officers[2], process);
  assert.equal(officers[2].processId, 'act_1');
  assert.equal(pauseProcess(process, domain).ok, true);
  assert.equal(officers[2].processId, null);
  assert.equal(canStartProcess(domain, cfg).ok, true);
  assert.equal(resumeProcess(process, domain, cfg).ok, true);
  assert.equal(officers[2].processId, 'act_1');
  assert.equal(process.status, 'active');
});

test('маршал — порядок и война, не стройка; казначей — укрепления как работы; у каждого своя стратегия', () => {
  const text = formatOfficersForPrompt(domainWith(makeOfficers()), cfg);
  assert.match(text, /Маршал — общественный порядок, война, преступления/);
  assert.match(text, /не стройка и не укрепление стен/);
  assert.match(text, /Казначей — хозяйство/);
  assert.match(text, /укрепление склонов/);
  assert.match(text, /САНОВНИКИ ГОРОДА/);
  assert.match(text, /Маршал всегда: Всегда действует решительно/);
  assert.match(text, /Хранитель всегда: Предпочитает сбор сведений/);
  assert.match(text, /Канцлер всегда: В основном интересуется людьми/);
  assert.match(text, /Казначей всегда: В основном интересуется ресурсами/);
  assert.doesNotMatch(text, /Воевода/);
  assert.doesNotMatch(text, /столп/i);
});

test('дедуп поручений выключен: разные и одинаковые summary не склеиваются', () => {
  const domain = domainWith(makeOfficers(), [
    {
      id: 'act_1',
      summary: 'Осмотр и укрепление северного склона',
      detail: 'Послать маршала на пастбище.',
      status: 'active',
    },
  ]);
  assert.equal(
    findDuplicateProcess(domain, 'Наблюдение за бело-серой стаей', 'Послать хранителя к деревушкам добытчиков.'),
    null,
  );
  assert.equal(
    findDuplicateProcess(domain, 'Осмотр и укрепление северного склона', 'Послать маршала на пастбище.'),
    null,
  );
});

test('закончившееся дело освобождает сановника, промпт не держит его занятым', () => {
  const officers = makeOfficers();
  const process = {
    id: 'act_flock',
    summary: 'Исследование бело-серой стаи',
    status: 'active',
    expectedMonths: 1,
    monthsLeft: 1,
    linkedStats: ['knowledge'],
  };
  const domain = domainWith(officers, [process]);
  bindOfficerProcess(domain, officers[2], process);
  applyEngineProgress(
    domain,
    [{ processId: 'act_flock', kind: 'normal', advance: 1 }],
    { tick: 9, rng: () => 0.5, config: cfg },
  );
  assert.equal(process.status, 'resolved');
  assert.equal(officers[2].processId, null);
  const prompt = formatOfficersForPrompt(domain, cfg);
  assert.match(prompt, /Хранитель Мира.*свободен/);
  assert.doesNotMatch(prompt, /занят идущим делом «Исследование бело-серой стаи»/);
});

test('битый сейв добирает сановников из lore и не считает закрытое дело занятостью', () => {
  const domain = {
    id: 'domain_x',
    officers: [
      {
        id: 'off_t',
        office: 'treasurer',
        statId: 'prosperity',
        title: 'Казначей',
        name: 'Элира',
        processId: 'act_old',
      },
    ],
    lore: [
      { kind: 'officer', office: 'keeper', name: 'Елана', about: 'осторожна', gender: 'female', tags: ['officer'] },
      { kind: 'officer', office: 'marshal', name: 'Делмир', gender: 'male', tags: ['officer'] },
      { kind: 'officer', office: 'chancellor', name: 'Корн', gender: 'male', tags: ['officer'] },
    ],
    state: {
      pendingActions: [
        { id: 'act_old', status: 'resolved', office: 'treasurer', officerId: 'off_t', summary: 'Склон' },
        { id: 'act_k', status: 'resolved', office: 'keeper', officerId: 'officer_58', summary: 'Стая' },
      ],
    },
  };
  ensureOfficersFromLore(domain, cfg);
  assert.equal(domain.officers.length, 4);
  const elana = domain.officers.find((o) => o.office === 'keeper');
  assert.equal(elana.name, 'Елана');
  assert.equal(elana.id, 'officer_58');
  assert.equal(elana.processId, null);
  const prompt = formatOfficersForPrompt(domain, cfg);
  assert.match(prompt, /Елана/);
  assert.match(prompt, /свободен/);
  assert.doesNotMatch(prompt, /занят идущим делом «Стая»/);
});

test('отказ занятому сановнику предлагает паузу или отмену текущего дела', () => {
  const officer = { title: 'Хранитель', name: 'Елана' };
  const msg = officerBusyAgentMessage(officer, { id: 'act_1', summary: 'Наблюдение за стаей' });
  assert.match(msg, /Наблюдение за стаей/);
  assert.match(msg, /pause_process/);
  assert.match(msg, /revoke_process/);
});
