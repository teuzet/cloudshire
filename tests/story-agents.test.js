import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatThreatStageRequest, fillStageThreats } from '../src/game/threatSmith.js';
import { judgeDeed } from '../src/game/deedJudge.js';
import { reconcilePlot, formatReconcilePrompt } from '../src/game/reconciler.js';
import { stagePoolRequest, createThreat, attachThreat, liveThreats, findThreat } from '../src/game/threats.js';
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

test('заявка на стадию называет масштаб и число, но не срок', () => {
  const p = plot({ failCount: 0, maxFails: 2, stage: 0, cause: 'столб трескается' });
  const text = formatThreatStageRequest(stagePoolRequest(p, { rng: () => 0 }), p, loadConfig());
  assert.match(text, /МАСШТАБ СТАДИИ: SITUATION/);
  assert.match(text, /GRAVITY: SITUATION/);
  assert.match(text, /Статус-кво города вследствие этой истории не меняется/);
  assert.match(text, /Вред каждой беды для города держи на этом уровне/);
  assert.doesNotMatch(text, /GRAVITY: CRISIS/);
  assert.match(text, /НУЖНО БЕД/);
  assert.match(text, /не последняя стадия/);
  assert.match(text, /Срок не называй/);
  assert.match(text, /ИЗВЕСТНОЕ/);
  assert.doesNotMatch(text, /АНТИ-ТАРГЕТ|УДАР:|дней/);
});

test('последняя стадия требует снять первопричину', () => {
  const p = plot({ failCount: 2, maxFails: 2, stage: 2, cause: 'столб трескается' });
  const req = stagePoolRequest(p, { rng: () => 0 });
  const text = formatThreatStageRequest(req, p, loadConfig());
  assert.equal(req.final, true);
  assert.match(text, /ПОСЛЕДНЯЯ СТАДИЯ/);
  assert.match(text, /снимает первопричину/);
  assert.match(text, /двумя или тремя предложениями/);
  assert.match(text, /следствие того же события/);
  assert.match(text, /почему она не вернётся долгий срок/);
  assert.match(text, /Срок, на который причина снята, назвать можно/);
  assert.match(text, /в этом списке разные/);
  assert.match(text, /в следующей не повторяется/);
  assert.match(text, /не подсказывают, чем именно кончается причина/);
  assert.doesNotMatch(text, /Срок не называй/);
  assert.match(text, /столб трескается/);
  assert.match(text, /GRAVITY: CRISIS/);
  assert.match(text, /На кону жизни заметной части жителей/);
});

test('автор бед пишет пул одним вызовом', async () => {
  const p = plot({ gravity: 'SITUATION', maxFails: 0, failCount: 0 });
  const runtime = fakeRuntime({
    submit_threats: { threats: ['Пыль забьёт водосборный сток', 'Лестница обвалится на мостки'] },
  });
  const created = await fillStageThreats({
    runtime,
    domain: {
      ...domain,
      lore: [
        {
          tags: ['chronicle'],
          text: 'Дорогу к воротам перерезали.',
          sourcePlotId: p.id,
          relatedPlotlineIds: [p.id],
        },
      ],
    },
    plot: p,
    day: 10,
    config: { tick: { plot: { threats: { perStage: { SITUATION: [2, 2] } } } } },
    rng: () => 0,
  });
  assert.match(runtime.calls[0].prompt, /Дорогу к воротам перерезали/);
  assert.equal(created.length, 2);
  assert.equal(created[0].text, 'Пыль забьёт водосборный сток');
  assert.equal(created[0].final, true);
  assert.equal(liveThreats(p).length, 2);
  assert.equal(runtime.calls[0].agentId, 'threatSmith');
});

test('молчание агента оставляет пул пустым', async () => {
  const p = plot({ gravity: 'SITUATION', maxFails: 0 });
  const runtime = fakeRuntime({}, { throwOn: 'threatSmith' });
  const created = await fillStageThreats({ runtime, domain, plot: p, day: 0, rng: () => 0 });
  assert.equal(created.length, 0);
});

test('без рантайма пул не выдумывается', async () => {
  const p = plot({ gravity: 'EPISODE', maxFails: 1 });
  const created = await fillStageThreats({ domain, plot: p, day: 0, rng: () => 0 });
  assert.equal(created.length, 0);
});

test('автор не получает отдельный список прошлых бед', () => {
  const p = plot({ gravity: 'RUPTURE', maxFails: 3 });
  attachThreat(p, createThreat(p, { text: 'фундамент садится' }));
  p.threats[0].status = 'fired';
  const text = formatThreatStageRequest(stagePoolRequest(p, { rng: () => 0 }), p);
  assert.doesNotMatch(text, /УЖЕ СЛУЧИЛОСЬ/);
  assert.doesNotMatch(text, /фундамент садится/);
});

test('автор бед видит факты, привязанные к этой истории', async () => {
  const p = plot({ gravity: 'SITUATION', maxFails: 0, failCount: 0, factIds: ['lore_linked'] });
  const runtime = fakeRuntime({
    submit_threats: { threats: ['Пыль забьёт водосборный сток'] },
  });
  await fillStageThreats({
    runtime,
    domain: {
      ...domain,
      lore: [
        { id: 'lore_linked', tags: ['fact'], text: 'Под лестницей пустота на два роста.', sourcePlotId: p.id },
        { id: 'lore_other', tags: ['fact'], text: 'Этот факт в список не клали.', sourcePlotId: 'p9' },
        { id: 'lore_chron', tags: ['chronicle'], text: 'Дорогу уже перерезали.', sourcePlotId: p.id },
      ],
    },
    plot: p,
    day: 10,
    config: { tick: { plot: { threats: { perStage: { SITUATION: [1, 1] } } } } },
    rng: () => 0,
  });
  const text = runtime.calls[0].prompt;
  const factsAt = text.indexOf('ФАКТЫ ЭТОЙ ИСТОРИИ');
  const orderAt = text.indexOf('ЗАКАЗ');
  assert.ok(factsAt >= 0 && orderAt > factsAt);
  assert.match(text, /Под лестницей пустота на два роста/);
  assert.match(text, /не отменяй и не выдавай за новую новость/);
  assert.doesNotMatch(text, /Этот факт в список не клали/);
  const facts = text.slice(factsAt, orderAt);
  assert.doesNotMatch(facts, /Дорогу уже перерезали/);
});

test('автор бед видит хронику, которая уже случилась', () => {
  const p = plot({ failCount: 0, maxFails: 2, stage: 0 });
  const text = formatThreatStageRequest(stagePoolRequest(p, { rng: () => 0 }), p, loadConfig(), {
    chronicle: ['Стая перерезала дорогу между деревушкой и воротами.'],
  });
  const chronicleAt = text.indexOf('ХРОНИКА');
  const orderAt = text.indexOf('ЗАКАЗ');
  assert.ok(chronicleAt >= 0 && orderAt > chronicleAt);
  assert.match(text, /Стая перерезала дорогу между деревушкой и воротами/);
  assert.match(text, /пиши беды после этих записей/);
});

test('автор бед получает брошенного автора, как завязка', () => {
  const p = plot({ failCount: 0, maxFails: 2, stage: 0 });
  const text = formatThreatStageRequest(stagePoolRequest(p, { rng: () => 0 }), p, loadConfig(), {
    author: { id: 'poe', name: 'Эдгар Аллан По' },
  });
  assert.match(text, /Эдгар Аллан По/);
  assert.match(text, /нарративную эстетику/);
  assert.match(text, /самого автора в тексте не поминай/i);
});

test('инструкция автора бед больше не говорит про часы и анти-таргет', () => {
  const agent = loadConfig().agents.threatSmith;
  assert.match(agent.instructions, /submit_threats/);
  assert.match(agent.instructions, /Хроника в заказе уже случилась/);
  assert.match(agent.instructions, /известн[а-я]* автор/);
  assert.match(agent.instructions, /нарративную эстетику/);
  assert.doesNotMatch(agent.instructions, /анти-таргет|ещё 50%|параллельные часы/i);
  assert.match(agent.prompts.wound, /не последняя стадия/);
  assert.match(agent.prompts.wound, /Срок не называй/);
  assert.match(agent.prompts.finale, /двумя или тремя предложениями/);
  assert.match(agent.prompts.finale, /следствие того же события/);
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
  const t = attachThreat(p, createThreat(p, { text: 'уйдёт с острова' }));
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
  attachThreat(p, createThreat(p, { text: 'беда' }));
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
  const t = attachThreat(p, createThreat(p, { text: 'уйдёт с острова' }));
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
