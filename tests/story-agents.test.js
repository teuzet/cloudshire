import { test } from 'node:test';
import assert from 'node:assert/strict';
import { draftThreatText, formatThreatRequest, replenishPlotThreats } from '../src/game/threatSmith.js';
import { judgeDeed } from '../src/game/deedJudge.js';
import { reconcilePlot, formatReconcilePrompt } from '../src/game/reconciler.js';
import { nextObligationRequest, createThreat, attachThreat, liveThreats, findThreat } from '../src/game/threats.js';
import { reconcileRequest, reconcileScope } from '../src/game/reconcile.js';
import { MIN_OFFICER_DAYS, DURATION_SPEC } from '../src/game/bands.js';
import { loadConfig } from '../src/config.js';

/** Рантайм, который зовёт тул с заранее заданными аргументами. */
function fakeRuntime(argsByTool, { throwOn = null } = {}) {
  const calls = [];
  return {
    calls,
    async run(opts) {
      calls.push({ agentId: opts.agentId, scene: opts.scene, prompt: opts.userMessages?.[0]?.content || '' });
      if (throwOn && throwOn === opts.agentId) throw new Error('модель отвалилась');
      for (const tool of opts.tools || []) {
        const args = argsByTool[tool.name];
        if (args) await tool.handler(args);
      }
      return { text: '' };
    },
  };
}

function plot(extra = {}) {
  return {
    id: 'p1',
    kind: 'story',
    storyType: 'story',
    title: 'Трещина в опорном столбе',
    synopsis: 'северное крыло ведёт',
    gravity: 'CRISIS',
    depth: 0,
    maxDepth: 3,
    failCount: 0,
    defenseCount: 0,
    threats: [],
    endings: [{ id: 'e1', kind: 'BAD_ENDING', text: 'Северное крыло рушится вместе с людьми' }],
    ...extra,
  };
}

const domain = { id: 'd1', state: { pendingActions: [] } };

// ───────────────────────────── автор беды ─────────────────────────────

test('заявка на беду несёт долю пути и анти-таргет, но не срок', () => {
  const p = plot({ failCount: 1 });
  const text = formatThreatRequest(nextObligationRequest(p, { rng: () => 0.5 }), p);
  assert.match(text, /УДАР: промежуточный/);
  assert.match(text, /50%/);
  assert.match(text, /АНТИ-ТАРГЕТ/);
  assert.match(text, /Северное крыло рушится вместе с людьми/);
  assert.match(text, /Срок не называй/);
  assert.match(text, /ИЗВЕСТНОЕ И НЕИЗВЕСТНОЕ/);
  assert.ok(!/дней/.test(text));
  assert.doesNotMatch(text, /ПОЛОСА ТЯЖЕСТИ|ТРЕВОГА|УЩЕРБ|УТРАТА|КАТАСТРОФА|dread/i);
});

test('на исчерпанных ранах автор пишет событие утраты, а не ещё одно ухудшение', () => {
  const p = plot({
    cause: 'опорный столб держит всё северное крыло и трескается сам по себе',
    failCount: 2,
    endings: [
      {
        id: 'e1',
        kind: 'BAD_ENDING',
        text: 'Северное крыло рушится вместе с людьми',
        questionGone: 'крыла больше нет, спорить не о чем',
        nowDifferent: 'город потерял четверть жилых дворов',
      },
    ],
  });
  const req = nextObligationRequest(p, { rng: () => 0.5 });
  const text = formatThreatRequest(req, p);
  assert.equal(req.finale, true);
  assert.match(text, /ЭТИМ ИСТОРИЯ КОНЧАЕТСЯ/);
  assert.match(text, /необратимо лишается/);
  assert.match(text, /Северное крыло рушится вместе с людьми/);
  assert.match(text, /крыла больше нет/);
  assert.match(text, /четверть жилых дворов/);
  assert.match(text, /опорный столб держит всё северное крыло/);
  assert.match(text, /Никаких «к зиме»/, 'горизонт последствий запрещён прямо');
  assert.doesNotMatch(text, /АНТИ-ТАРГЕТ/);
});

test('заявка на разрешение просит нейтральный конец', () => {
  const p = plot({ depth: 3, maxDepth: 3, defenseCount: 3 });
  const req = nextObligationRequest(p, { rng: () => 0.5 });
  const text = formatThreatRequest(req, p);
  assert.equal(req.outcome, 'neutral');
  assert.match(text, /НУЖНО РАЗРЕШЕНИЕ/);
  assert.doesNotMatch(text, /УДАР:|ПОЛОСА ТЯЖЕСТИ/);
});

test('автор беды получает правило независимых параллельных часов', () => {
  const ins = loadConfig().agents.threatSmith.instructions;
  assert.match(ins, /независим/);
  assert.match(ins, /параллельные часы/);
  assert.match(ins, /даже если остальные/);
  assert.match(ins, /ещё 50%/);
  assert.match(ins, /скрытый слой не сливай/);
  assert.doesNotMatch(ins, /known=/);
  assert.doesNotMatch(ins, /ТРЕВОГА|УЩЕРБ|КАТАСТРОФА|dread/i);
});

test('автор видит уже висящие беды, чтобы не повторяться', () => {
  const p = plot({ gravity: 'RUPTURE' });
  attachThreat(p, createThreat({ plot: p, text: 'фундамент садится', band: 'SEASON', rng: () => 0.5 }));
  const text = formatThreatRequest(nextObligationRequest(p, { rng: () => 0.5 }), p);
  assert.match(text, /УЖЕ ВИСИТ/);
  assert.match(text, /независим/);
  assert.match(text, /фундамент садится/);
});

test('текст беды приходит от агента и обрезается', async () => {
  const p = plot();
  const runtime = fakeRuntime({ submit_threat: { text: 'Осевшая опора уронит лестницу северного крыла' } });
  const res = await draftThreatText({
    runtime,
    domain,
    plot: p,
    request: nextObligationRequest(p, { rng: () => 0.5 }),
  });
  assert.equal(res.text, 'Осевшая опора уронит лестницу северного крыла');
  assert.equal(runtime.calls[0].agentId, 'threatSmith');
});

test('автор не задаёт видимость беды', async () => {
  const p = plot({ gravity: 'EPISODE' });
  const runtime = fakeRuntime({
    submit_threat: { text: 'Пыль забьёт водосборный сток', known: false },
  });
  const created = await replenishPlotThreats({ runtime, domain, plot: p, day: 10, rng: () => 0.5 });
  assert.equal(created.length, 1);
  assert.equal(created[0].known, undefined);
  assert.equal(created[0].text, 'Пыль забьёт водосборный сток');
  assert.doesNotMatch(runtime.calls[0].prompt, /Верни known|\[скрыта\]|\[видна\]/);
});

test('дозаполнение с агентом ставит обязательства с его текстом', async () => {
  const p = plot({ gravity: 'CRISIS' });
  const runtime = fakeRuntime({ submit_threat: { text: 'Лестница северного крыла обвалится' } });
  const created = await replenishPlotThreats({ runtime, domain, plot: p, day: 10, rng: () => 0.5 });
  assert.equal(created.length, 2, 'у кризиса два слота');
  assert.ok(created.every((t) => t.text === 'Лестница северного крыла обвалится'));
  assert.ok(created.every((t) => t.dueDay > 10));
  assert.equal(liveThreats(p).length, 2);
});

test('молчание агента не оставляет историю без счётчика', async () => {
  const p = plot({ gravity: 'EPISODE' });
  const runtime = fakeRuntime({}, { throwOn: 'threatSmith' });
  const created = await replenishPlotThreats({ runtime, domain, plot: p, day: 0, rng: () => 0.5 });
  assert.equal(created.length, 1);
  assert.equal(created[0].status, 'live');
  assert.ok(created[0].text.length > 0, 'падаем на анти-таргет, а не на пустоту');
});

test('дозаполнение без рантайма работает вовсе без модели', async () => {
  const p = plot({ gravity: 'EPISODE' });
  const created = await replenishPlotThreats({ domain, plot: p, day: 0, rng: () => 0.5 });
  assert.equal(created.length, 1);
});

// ───────────────────────────── оценщик дела ─────────────────────────────

test('оценщик возвращает две независимые оси и срок внутри полосы', async () => {
  const runtime = fakeRuntime({
    submit_deed: { duration: 'SEASON', difficulty: 'HARD', note: 'камень везут с дальнего склона' },
  });
  const res = await judgeDeed({ runtime, domain, summary: 'построить каменный храм', rng: () => 0.5 });
  assert.equal(res.durationBand, 'SEASON');
  assert.equal(res.difficulty, 'HARD');
  assert.ok(res.objectiveDays >= DURATION_SPEC.SEASON.min && res.objectiveDays <= DURATION_SPEC.SEASON.max);
  assert.equal(res.impossible, false);
  assert.equal(res.note, 'камень везут с дальнего склона');
  assert.equal(res.fallback, false);
});

test('невозможное дело помечается флагом, а не огромным сроком', async () => {
  const runtime = fakeRuntime({
    submit_deed: { duration: 'YEARS', difficulty: 'IMPOSSIBLE', note: 'такого знания нет ни у кого' },
  });
  const res = await judgeDeed({ runtime, domain, summary: 'изобрести дальнюю говорильную нить' });
  assert.equal(res.impossible, true);
  assert.equal(res.difficulty, 'IMPOSSIBLE');
});

test('мгновенное дело всё равно занимает столп', async () => {
  const runtime = fakeRuntime({ submit_deed: { duration: 'INSTANT', difficulty: 'TRIVIAL', note: 'слово сказано' } });
  const res = await judgeDeed({ runtime, domain, summary: 'объявить волю', rng: () => 0 });
  assert.equal(res.objectiveDays, DURATION_SPEC.INSTANT.min);
  assert.equal(res.officerDays, MIN_OFFICER_DAYS);
});

test('сбой оценщика даёт разумный дефолт, а не падение', async () => {
  const runtime = fakeRuntime({}, { throwOn: 'deedJudge' });
  const res = await judgeDeed({ runtime, domain, summary: 'починить стену', rng: () => 0.5 });
  assert.equal(res.durationBand, 'WEEKS');
  assert.equal(res.difficulty, 'PLAIN');
  assert.equal(res.fallback, true);
});

test('мусор от оценщика нормализуется', async () => {
  const runtime = fakeRuntime({ submit_deed: { duration: 'вечность', difficulty: 'ужас', note: '' } });
  const res = await judgeDeed({ runtime, domain, summary: 'что-то', rng: () => 0.5 });
  assert.equal(res.durationBand, 'WEEKS');
  assert.equal(res.difficulty, 'PLAIN');
});

test('при соседе оценщик решает, кросс-островное ли дело', async () => {
  const runtime = fakeRuntime({
    submit_deed: {
      duration: 'WEEKS',
      difficulty: 'HARD',
      note: 'идти через проход ночью',
      crossIsland: true,
      opposedStat: 'security',
    },
  });
  const res = await judgeDeed({
    runtime,
    domain,
    summary: 'Ночное нападение на Аллерию',
    partnerName: 'Аллерия',
    rng: () => 0.5,
  });
  assert.equal(res.crossIsland, true);
  assert.equal(res.opposedStat, 'security');
  assert.match(String(runtime.calls[0].prompt), /Аллерия/);
  assert.match(String(runtime.calls[0].prompt), /crossIsland/);
});

test('местное дело при соседе не кросс-островное', async () => {
  const runtime = fakeRuntime({
    submit_deed: {
      duration: 'WEEKS',
      difficulty: 'PLAIN',
      note: 'свои камни',
      crossIsland: false,
      opposedStat: 'none',
    },
  });
  const res = await judgeDeed({
    runtime,
    domain,
    summary: 'починить северную стену',
    partnerName: 'Аллерия',
  });
  assert.equal(res.crossIsland, false);
  assert.equal(res.opposedStat, null);
});

// ───────────────────────────── разбор нити ─────────────────────────────

function withDeeds(p, deeds) {
  return { id: 'd1', state: { pendingActions: deeds }, plotlines: [p] };
}

test('разбор не зовёт модель, если разбирать нечего', async () => {
  const p = plot();
  const runtime = fakeRuntime({});
  const res = await reconcilePlot({
    runtime,
    domain: withDeeds(p, [{ id: 'proc1', plotlineId: 'p1', status: 'active', summary: 'казнить' }]),
    plot: p,
    resolved: { id: 'proc1', summary: 'казнить' },
  });
  assert.equal(res.skipped, 'nothing_to_reconcile');
  assert.equal(runtime.calls.length, 0);
});

test('казнь состоялась — арест отменён по вердикту агента', async () => {
  const p = plot();
  const arrest = { id: 'proc2', plotlineId: 'p1', status: 'active', summary: 'арестовать мздоимца' };
  const runtime = fakeRuntime({
    submit_reconcile: {
      deeds: [{ id: 'proc2', verdict: 'CANCEL', why: 'преступник мёртв' }],
      threats: [],
    },
  });
  const res = await reconcilePlot({
    runtime,
    domain: withDeeds(p, [{ id: 'proc1', plotlineId: 'p1', status: 'active', summary: 'казнить' }, arrest]),
    plot: p,
    resolved: { id: 'proc1', summary: 'казнить', finish: 'ok' },
    day: 40,
  });
  assert.equal(arrest.status, 'cancelled');
  assert.equal(arrest.cancelReason, 'преступник мёртв');
  assert.deepEqual(res.applied.map((a) => [a.kind, a.verdict]), [['deed', 'CANCEL']]);
});

test('CONTINUE ничего не трогает и в отчёт не попадает', async () => {
  const p = plot();
  const other = { id: 'proc2', plotlineId: 'p1', status: 'active', summary: 'укрепить опору' };
  const runtime = fakeRuntime({
    submit_reconcile: { deeds: [{ id: 'proc2', verdict: 'CONTINUE' }], threats: [] },
  });
  const res = await reconcilePlot({
    runtime,
    domain: withDeeds(p, [{ id: 'proc1', plotlineId: 'p1', status: 'active' }, other]),
    plot: p,
    resolved: { id: 'proc1', summary: 'осмотреть' },
  });
  assert.equal(other.status, 'active');
  assert.deepEqual(res.applied, []);
});

test('вердикт по беде отменяет её без начисления обороны', async () => {
  const p = plot();
  const t = attachThreat(p, createThreat({ plot: p, text: 'уйдёт с острова', band: 'SEASON', rng: () => 0.5 }));
  const runtime = fakeRuntime({
    submit_reconcile: { deeds: [], threats: [{ id: t.id, verdict: 'CANCEL', why: 'ловить некого' }] },
  });
  await reconcilePlot({
    runtime,
    domain: withDeeds(p, [{ id: 'proc1', plotlineId: 'p1', status: 'active' }]),
    plot: p,
    resolved: { id: 'proc1', summary: 'казнить' },
    day: 10,
  });
  assert.equal(findThreat(p, t.id).status, 'cancelled');
  assert.equal(p.defenseCount, 0);
});

test('вердикт по чужому делу или несуществующей беде игнорируется', async () => {
  const p = plot();
  attachThreat(p, createThreat({ plot: p, text: 'беда', band: 'SEASON', rng: () => 0.5 }));
  const foreign = { id: 'procX', plotlineId: 'other', status: 'active', summary: 'чужое' };
  const runtime = fakeRuntime({
    submit_reconcile: {
      deeds: [{ id: 'procX', verdict: 'CANCEL' }],
      threats: [{ id: 'нет такой', verdict: 'CANCEL' }],
    },
  });
  const res = await reconcilePlot({
    runtime,
    domain: { id: 'd1', state: { pendingActions: [{ id: 'proc1', plotlineId: 'p1', status: 'active' }, foreign] } },
    plot: p,
    resolved: { id: 'proc1', summary: 'казнить' },
  });
  assert.equal(foreign.status, 'active');
  assert.deepEqual(res.applied, []);
});

test('сбой разбора оставляет всё как было', async () => {
  const p = plot();
  const other = { id: 'proc2', plotlineId: 'p1', status: 'active', summary: 'арестовать' };
  const runtime = fakeRuntime({}, { throwOn: 'reconciler' });
  const res = await reconcilePlot({
    runtime,
    domain: withDeeds(p, [{ id: 'proc1', plotlineId: 'p1', status: 'active' }, other]),
    plot: p,
    resolved: { id: 'proc1', summary: 'казнить' },
  });
  assert.equal(res.failed, true);
  assert.equal(other.status, 'active', 'молчаливая отмена приказа хуже лишнего дела');
});

test('промпт разбора не отдаёт агенту чисел механики', () => {
  const p = plot();
  const t = attachThreat(p, createThreat({ plot: p, text: 'уйдёт с острова', band: 'SEASON', rng: () => 0.5 }));
  const scope = reconcileScope({
    plot: p,
    processes: [{ id: 'proc2', plotlineId: 'p1', status: 'active', summary: 'арестовать', officerName: 'Малуша' }],
    resolvedId: 'proc1',
  });
  const text = formatReconcilePrompt(
    reconcileRequest({ plot: p, resolved: { summary: 'казнить', finish: 'ok' }, scope, day: 10 }),
  );
  assert.match(text, /ТОЛЬКО ЧТО РАЗРЕШИЛОСЬ: казнить/);
  assert.match(text, /\[proc2\] арестовать/);
  assert.match(text, new RegExp(`\\[${t.id}\\] уйдёт с острова`));
  assert.ok(!/dueDay|totalDays/.test(text));
});
