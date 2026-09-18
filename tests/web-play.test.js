/**
 * Тестовый веб-клиент на непрерывном времени.
 *
 * Проверяем не вёрстку, а то, что играть через браузер по-прежнему можно:
 * дата приходит дневная, дела и нависшее — в новых полях, справочник города
 * открывается тем же путём, что мини-аппка в Telegram (слот через ?userId=).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createWebServer } from '../src/clients/web/server.js';
import { dropPlayStory } from '../src/game/playDev.js';

const config = {
  web: { play: true, admin: false },
  telegram: {},
  faith: { name: 'Вера', about: 'Верит ли город.' },
  mana: { name: 'Мана', about: 'Сила жреца.' },
  stats: [
    { id: 'prosperity', name: 'Благосостояние', about: 'Сыты ли дворы.' },
    { id: 'security', name: 'Безопасность', about: 'Спит ли улица.' },
  ],
  statEpithets: { 0: 'ужасающе', 50: 'обычно', 100: 'божественно' },
};

const WORLD_DAY = 125;

function makeWorld() {
  return {
    id: 'w1',
    dayIndex: WORLD_DAY,
    tickIndex: 5,
    gameDate: { year: 1, month: 6, label: 'Год 1, месяц 6', tick: 5 },
  };
}

function makeDomain() {
  return {
    id: 'd1',
    worldId: 'w1',
    name: 'Саркум',
    status: 'playing',
    ownerUserId: 'local-user',
    population: 900,
    description: '## Облик\nГород на скале.',
    stats: { prosperity: 55, security: 40 },
    officers: [
      { id: 'off_m', office: 'marshal', statId: 'security', title: 'Маршал', name: 'Кален', processId: 'act_1' },
    ],
    characters: [{ name: 'Ирна', title: 'правительница', dialogHistory: [] }],
    modifiers: [{ id: 'cmod_1', text: 'Ночной дозор у края', sinceLabel: 'Год 1, месяц 4' }],
    lore: [
      {
        id: 'lore_1',
        text: 'Колодец загудел в ночь.',
        tags: ['chronicle'],
        day: 120,
        gameDateLabel: 'Год 1, месяц 5, день 1',
        sourcePlotId: 'plot_well',
      },
      {
        id: 'lore_old',
        text: 'Межа высохла за ночь.',
        tags: ['chronicle'],
        day: 80,
        gameDateLabel: 'Год 1, месяц 3, день 21',
        sourcePlotId: 'plot_old',
      },
    ],
    closedPlotlines: [
      {
        id: 'plot_old',
        kind: 'story',
        title: 'Сухая межа',
        synopsis: 'Трава легла.',
        reason: 'lives',
        closeReason: 'lives',
        hiddenPremises: ['ветер с края сдул посев'],
        chronicleIds: ['lore_old'],
      },
    ],
    plotlines: [
      {
        id: 'plot_well',
        kind: 'story',
        title: 'Гул колодца',
        synopsis: 'Вода поёт.',
        cause: 'под срубом чужая кладка, и колодец держится на ней',
        gravity: 'CRISIS',
        depth: 1,
        maxDepth: 3,
        relatedProcessIds: ['act_1'],
        hiddenAnswer: 'кладку клали не городские, а чужие',
        hiddenPremises: ['под срубом чужая кладка, не городская'],
        revealedAnswer: 'воду ведёт подземный ход за межой',
        revealedPremises: ['воду мутит не сруб, а подземный сток'],
        discoveryLadder: [{ id: 'rung_1', promise: 'кто клал камень', revealed: false }],
        endings: [
          {
            id: 'end_good',
            kind: 'GOOD_ENDING',
            text: 'Сруб держит, вода снова чистая',
            questionGone: 'колодец починен, спорить не о чем',
            nowDifferent: 'двор знает, как чинить сруб',
          },
          {
            id: 'end_neutral',
            kind: 'NEUTRAL_ENDING',
            text: 'Колодец забросили и роют новый',
            questionGone: 'о старом колодце больше не спрашивают',
            nowDifferent: 'воду берут из новой ямы за межой',
          },
          {
            id: 'end_bad',
            kind: 'BAD_ENDING',
            text: 'Колодец обрушился вместе с водовозами',
            questionGone: 'колодца нет, спорить не о чем',
            nowDifferent: 'северные дворы остались без воды',
          },
        ],
        closeWhen: [
          'Сруб держит, вода снова чистая',
          'Колодец забросили и роют новый',
          'Колодец обрушился вместе с водовозами',
        ],
        threats: [
          {
            id: 'thr_known',
            text: 'Колодец обвалится',
            band: 'WEEKS',
            outcome: 'harm',
            known: true,
            startDay: 100,
            totalDays: 40,
            dueDay: 130,
            status: 'live',
          },
          {
            id: 'thr_hidden',
            text: 'Вода уйдёт совсем',
            band: 'SEASON',
            outcome: 'harm',
            known: false,
            startDay: 100,
            totalDays: 100,
            dueDay: 190,
            status: 'live',
          },
        ],
      },
    ],
    proxyText: 'Не пускать чужих в город',
    state: {
      faith: 52,
      mana: 40.4,
      patronName: 'Безымянный',
      pendingActions: [
        {
          id: 'act_1',
          summary: 'Укрепить колодец',
          detail: 'Подвести сруб.',
          durationBand: 'WEEKS',
          difficulty: 'HARD',
          objectiveDays: 40,
          scheduledDays: 40,
          startDay: 100,
          dueDay: 140,
          status: 'active',
          officerId: 'off_m',
          linkedStats: ['security'],
          plotEngagement: 'DIRECT',
          premiseText: 'под срубом чужая кладка, не городская',
          reachesAnswer: true,
        },
      ],
      priestOrders: [{ id: 'po_1', subject: 'как идут дела в порту', lastEventNo: null }],
    },
  };
}

function makeStorage(domain, world, extra = {}) {
  const confluxes = extra.confluxes || [];
  const domains = [domain, ...(extra.domains || []).filter((d) => d.id !== domain.id)];
  return {
    getWorld: async () => world,
    listDomains: async () => domains,
    getDomain: async (id) => domains.find((d) => d.id === id) || null,
    getDomainForUser: async (userId) => (userId === 'local-user' ? domain : null),
    getUserBinding: async () => ({ userId: 'local-user', domainId: domain.id }),
    listUserBindings: async () => [{ userId: 'local-user', domainId: domain.id }],
    listConfluxes: async (opts = {}) => {
      const wanted = opts.status ? [].concat(opts.status) : null;
      return confluxes.filter((c) => !wanted || wanted.includes(c.status));
    },
    getConflux: async (id) => confluxes.find((c) => c.id === id) || null,
    saveDomain: async () => {},
    saveWorld: async () => {},
    updateWorld: async (mutate) => {
      await mutate(world);
      return world;
    },
  };
}

function makeApp(calls = [], hooks = {}) {
  return {
    onOutbound() {},
    isGenerating: () => false,
    isWorldTicking: () => Boolean(hooks.ticking),
    generatingProgress: new Map(),
    handleUserMessage: async (userId, text, opts) => {
      calls.push({ kind: 'chat', userId, text, opts });
      return { reply: 'Слышу тебя.', agent: 'ruler' };
    },
    blessOwnProcess: async (userId, processId) => {
      calls.push({ kind: 'bless', userId, processId });
      return { ok: true, mana: 25, cost: 8 };
    },
    forceSeedStory: async (userId, opts) => {
      calls.push({ kind: 'seed', userId, ...opts });
      if (hooks.forceSeedStory) return hooks.forceSeedStory(userId, opts);
      return {
        ok: true,
        grain: opts.grain || 'void',
        gravity: opts.gravity || 'EPISODE',
        plot: { id: 'plot_new', title: 'Новая', synopsis: '', gravity: opts.gravity || 'EPISODE' },
      };
    },
    dropPlayStory: async (userId, plotId) => {
      calls.push({ kind: 'drop', userId, plotId });
      if (hooks.dropPlayStory) return hooks.dropPlayStory(userId, plotId);
      return dropPlayStory(hooks.domain, hooks.world, plotId, { day: WORLD_DAY });
    },
    forcePlayThreat: async (userId, opts) => {
      calls.push({ kind: 'force-threat', userId, ...opts });
      if (hooks.forcePlayThreat) return hooks.forcePlayThreat(userId, opts);
      return { ok: true, plotId: opts.plotId, threatId: opts.threatId, title: 'Гул колодца', closed: false };
    },
    forcePlayDeed: async (userId, opts) => {
      calls.push({ kind: 'force-deed', userId, ...opts });
      if (hooks.forcePlayDeed) return hooks.forcePlayDeed(userId, opts);
      return { ok: true, processId: opts.processId, finish: opts.finish, summary: 'Укрепить колодец', closed: false };
    },
    setClockHeld: async (held) => {
      calls.push({ kind: 'clock', held });
      if (hooks.world) hooks.world.clockHeldAt = held ? Date.now() : null;
      return { ok: true, clockHeld: Boolean(held), day: WORLD_DAY };
    },
    savePlaySnapshot: async ({ label = '' } = {}) => {
      calls.push({ kind: 'save', label });
      return {
        ok: true,
        id: 'save_abc',
        label: String(label || ''),
        savedAt: '2026-09-12T00:00:00.000Z',
        dayIndex: WORLD_DAY,
        dateLabel: 'Год 1, месяц 5, день 6',
        cityNames: ['Саркум'],
        domainCount: 1,
      };
    },
    listPlaySnapshots: async () => hooks.snapshots || [],
    loadPlaySnapshot: async (id) => {
      calls.push({ kind: 'load', id });
      if (hooks.ticking) return { ok: false, error: 'ticking', message: 'сейчас идёт шаг времени' };
      if (hooks.loadPlaySnapshot) return hooks.loadPlaySnapshot(id);
      return {
        ok: true,
        id,
        worldId: 'w1',
        clockHeld: false,
        dayIndex: WORLD_DAY,
        dateLabel: 'Год 1, месяц 5, день 6',
        cityNames: ['Саркум'],
        domainCount: 1,
      };
    },
    deletePlaySnapshot: async (id) => {
      calls.push({ kind: 'delete-save', id });
      return { ok: true, id };
    },
  };
}

async function withServer(run, { calls = [], hooks = {}, playDev, domain: givenDomain, extraStorage } = {}) {
  const world = makeWorld();
  const domain = givenDomain || makeDomain();
  const cfg = playDev === false ? { ...config, web: { ...config.web, playDev: false } } : config;
  const server = createWebServer({
    config: cfg,
    app: makeApp(calls, { ...hooks, domain, world }),
    runtime: {},
    storage: makeStorage(domain, world, extraStorage),
  });
  const http = await new Promise((resolve) => {
    const s = server.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${http.address().port}`;
  try {
    return await run({ base, domain, world });
  } finally {
    await new Promise((resolve) => http.close(resolve));
  }
}

const get = async (base, path) => {
  const res = await fetch(`${base}${path}`);
  assert.equal(res.status, 200, path);
  return res.json();
};

test('страница клиента открывает справочник города тем же путём, что Telegram', async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}/play/`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /id="btnCity"/, 'кнопка справочника на месте');
    assert.match(html, /id="cityFrame"/, 'мини-аппка встроена, а не переписана заново');
    assert.match(html, /id="btnInspect"/, 'отладочные данные — отдельной кнопкой');
    assert.match(html, /id="btnSeed"/, 'принудительный посев — отдельной кнопкой');
    assert.match(html, /id="btnClock"/, 'пауза времени на месте');
    assert.match(html, /id="skipDays"/, 'промотка на заданные дни');
    assert.match(html, /id="savesBox"/, 'снимки мира в слотах');
    assert.match(html, /состояние мира целиком/);
  });
});

test('состояние клиента приходит с дневной датой', async () => {
  await withServer(async ({ base }) => {
    const state = await get(base, '/api/play/state?userId=local-user');
    assert.equal(state.gameDate.day, WORLD_DAY);
    assert.equal(state.gameDate.label, 'Год 1, месяц 5, день 6');
    assert.equal(state.tickDate.label, 'Год 1, месяц 6', 'месячная метка остаётся для сопряжения');
    assert.equal(state.domain.name, 'Саркум');
    assert.equal(state.canForceTick, true);
    assert.equal(state.clockHeld, false);
  });
});

test('инспектор показывает дела в полосах и днях, а не в месяцах', async () => {
  await withServer(async ({ base }) => {
    const data = await get(base, '/api/play/inspect?userId=local-user');
    const deed = data.domain.processes[0];
    assert.equal(deed.remainingDays, 15, 'срок 140-й день, сейчас 125-й');
    assert.equal(deed.remainingLabel, 'дни');
    assert.equal(deed.durationLabel, 'недели');
    assert.equal(deed.difficultyLabel, 'трудное');
    assert.equal(deed.paceLabel, 'обычно');
    assert.equal(deed.blessCost, 8);
    assert.equal(deed.plotEngagement, 'DIRECT');
    assert.equal(deed.premiseText, 'под срубом чужая кладка, не городская');
    assert.equal(deed.reachesAnswer, true);
  });
});

test('инспектор показывает и скрытое нависшее — иначе угрозы нечем отлаживать', async () => {
  await withServer(async ({ base }) => {
    const data = await get(base, '/api/play/inspect?userId=local-user');
    const plot = data.domain.plotlines[0];
    assert.deepEqual(
      plot.threats.map((t) => [t.text, t.known, t.remainingDays]),
      [
        ['Колодец обвалится', true, 5],
        ['Вода уйдёт совсем', false, 65],
      ],
    );
    assert.equal(plot.depth, 1);
    assert.equal(plot.canDrop, false, 'на нити живое дело — снимать нельзя');
    assert.equal(plot.hiddenAnswer, 'кладку клали не городские, а чужие');
    assert.deepEqual(plot.hiddenPremises, ['под срубом чужая кладка, не городская']);
    assert.equal(plot.revealedAnswer, 'воду ведёт подземный ход за межой');
    assert.deepEqual(plot.revealedPremises, ['воду мутит не сруб, а подземный сток']);
    assert.equal(plot.discoveryLadder[0].promise, 'кто клал камень');
    assert.deepEqual(
      plot.chronicles.map((e) => e.text),
      ['Колодец загудел в ночь.'],
    );
    const closed = data.domain.closedPlotlines[0];
    assert.equal(closed.title, 'Сухая межа');
    assert.deepEqual(closed.hiddenPremises, ['ветер с края сдул посев']);
    assert.deepEqual(
      closed.chronicles.map((e) => e.text),
      ['Межа высохла за ночь.'],
    );
  });
});

test('концовки приходят разобранными, а не одной строкой closeWhen', async () => {
  await withServer(async ({ base }) => {
    const data = await get(base, '/api/play/inspect?userId=local-user');
    const plot = data.domain.plotlines[0];
    // closeWhen у нити со ставками — это все её концовки сразу; склеенный
    // в строку он читался как один длинный исход и ничего не объяснял.
    assert.deepEqual(
      plot.endings.map((e) => [e.kind, e.text, e.questionGone, e.nowDifferent]),
      [
        ['GOOD_ENDING', 'Сруб держит, вода снова чистая', 'колодец починен, спорить не о чем', 'двор знает, как чинить сруб'],
        ['NEUTRAL_ENDING', 'Колодец забросили и роют новый', 'о старом колодце больше не спрашивают', 'воду берут из новой ямы за межой'],
        ['BAD_ENDING', 'Колодец обрушился вместе с водовозами', 'колодца нет, спорить не о чем', 'северные дворы остались без воды'],
      ],
    );
    assert.equal(plot.cause, 'под срубом чужая кладка, и колодец держится на ней');
    assert.equal(plot.whyMoves, undefined);
  });
});

test('инспектор не показывает нить сопряжения: это объект пары, прогноз на месте', async () => {
  const partner = {
    id: 'd2',
    worldId: 'w1',
    name: 'Керсай',
    lore: [],
    plotlines: [],
  };
  const conflux = {
    id: 'cf1',
    status: 'docked',
    domainIds: ['d1', 'd2'],
    container: null,
    mainPlotId: null,
    plotlines: [],
    closedPlotlines: [],
    processes: [],
    lore: [],
    forecast: {
      d1: 'Саркум останется с пустыми складами.',
      d2: 'Керсай уйдёт с зерном.',
      neutral: 'Один берег взял у другого.',
    },
    synopsis: {
      d1: 'Нас заняли с прохода.',
    },
    partingDueDay: 305,
  };
  await withServer(
    async ({ base, domain }) => {
      const data = await get(base, '/api/play/inspect?userId=local-user');
      const pair = data.domain.conflux;
      assert.equal(pair.plotlines.some((p) => p.id === 'plot_pair' || p.type === 'conflux'), false);
      assert.equal(pair.forecast.neutral, 'Один берег взял у другого.');
      assert.equal(pair.forecast.byCity[0].text, 'Саркум останется с пустыми складами.');
      assert.equal(
        data.domain.plotlines.some((p) => p.type === 'conflux'),
        false,
      );
      assert.equal(
        (domain.plotlines || []).some((p) => p.type === 'conflux'),
        false,
        'оверлей после инспектора снят',
      );
    },
    { extraStorage: { confluxes: [conflux], domains: [partner] } },
  );
});

test('клиент рисует концовки списком с пометкой рода', async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}/play/app.js`);
    assert.equal(res.status, 200);
    const js = await res.text();
    assert.match(js, /function endingsBlock/);
    assert.match(js, /GOOD_ENDING: 'хорошая'/);
    assert.match(js, /вопрос снят:/);
    assert.match(js, /теперь иначе:/);
    assert.match(js, /первопричина:/);
    assert.doesNotMatch(js, /если не займутся:/);
    assert.match(js, /data-seed-form/);
    assert.match(js, /посеять с тайной/);
    assert.match(js, /name="mystery"/);
    assert.match(js, /data-drop/);
    assert.match(js, /data-fire-threat/);
    assert.match(js, /data-finish/);
    assert.match(js, /на самом деле:/);
    assert.match(js, /город выяснил:/);
    assert.match(js, /разгадка:/);
    assert.match(js, /разгадано:/);
    assert.match(js, /подступ:/);
    assert.match(js, /целится в разгадку/);
    assert.match(js, /хроника нити/);
    assert.match(js, /function plotChroniclesBlock/);
    assert.match(js, /\/api\/play\/clock/);
    assert.match(js, /\/api\/play\/snapshots/);
    assert.match(js, /skipDays/);
    assert.match(js, /Если острова разойдутся сейчас/);
    assert.match(js, /прогноза ещё нет/);
    assert.match(js, /function daysWord/);
    assert.match(js, /до сопряжения, дн\./);
    assert.match(js, /осталось в сопряжении, дн\./);
    assert.doesNotMatch(js, /до сопряжения, мес\./);
    assert.match(js, /Время стоит/);
    assert.match(js, /островов:/);
    assert.match(js, /Состояние мира сохранено/);
    assert.match(js, /Загрузить состояние мира/);
  });
});

test('порядок города, доверенность и темы докладов видны клиенту', async () => {
  await withServer(async ({ base }) => {
    const data = await get(base, '/api/play/inspect?userId=local-user');
    assert.equal(data.domain.standingRules[0].text, 'Ночной дозор у края');
    assert.equal(data.domain.proxyText, 'Не пускать чужих в город');
    assert.deepEqual(
      data.domain.priestOrders.map((o) => o.subject),
      ['как идут дела в порту'],
    );
    assert.equal(typeof data.domain.notify.intensity, 'string');
    // Клиент однажды принял это за список и упал на .join — форму фиксируем.
    assert.equal(Array.isArray(data.domain.notify.triggers), false);
    assert.equal(data.domain.notify.triggers.threatFired, true);
    assert.equal('standingOrders' in data.domain, false, 'указов больше нет');
  });
});

test('справочник города открывается по слоту, без Telegram', async () => {
  await withServer(async ({ base }) => {
    const view = await get(base, '/api/mini/state?userId=local-user');
    assert.equal(view.gameDate, 'Год 1, месяц 5, день 6');
    assert.deepEqual(
      view.city.tabs.map((t) => t.id),
      ['description', 'brief', 'chronicle', 'people'],
    );
    const well = view.events.find((e) => e.title === 'Гул колодца');
    assert.equal(well.threats, undefined);
    assert.equal(well.processes[0].remaining, 'дни');
    assert.equal(view.orders[0].text, 'Ночной дозор у края');
    assert.match(view.orders[1].text, /Не пускать чужих/);
  });
});

test('чужой слот справочник не отдаёт', async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}/api/mini/state?userId=someone-else`);
    assert.equal(res.status, 200);
    const view = await res.json();
    assert.equal(view.city, null, 'города у этого слота нет');
  });
});

test('разговор и благословение идут через тот же фасад, что Telegram', async () => {
  const calls = [];
  await withServer(
    async ({ base }) => {
      const chat = await fetch(`${base}/api/play/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 'local-user', text: 'Укрепите колодец' }),
      });
      assert.equal(chat.status, 200);
      assert.equal((await chat.json()).reply, 'Слышу тебя.');

      const bless = await fetch(`${base}/api/mini/bless?userId=local-user`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ processId: 'act_1' }),
      });
      assert.equal(bless.status, 200);
      assert.deepEqual(await bless.json(), { ok: true, mana: 25, cost: 8 });
    },
    { calls },
  );
  assert.deepEqual(
    calls.map((c) => c.kind),
    ['chat', 'bless'],
  );
  assert.equal(calls[0].opts.channel, 'web');
  assert.equal(calls[1].processId, 'act_1');
});

test('принудительный посев принимает gravity и зерно', async () => {
  const calls = [];
  await withServer(
    async ({ base }) => {
      const res = await fetch(`${base}/api/play/seed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 'local-user', gravity: 'SITUATION', grain: 'genesis', mystery: true }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.ok, true);
      assert.equal(body.grain, 'genesis');
      assert.equal(body.plot.title, 'Новая');
    },
    { calls },
  );
  assert.deepEqual(calls[0], {
    kind: 'seed',
    userId: 'local-user',
    gravity: 'SITUATION',
    grain: 'genesis',
    mystery: true,
  });
});

test('снятие истории без дел и отказ, если дело ещё идёт', async () => {
  await withServer(async ({ base, domain }) => {
    domain.plotlines.push({
      id: 'plot_free',
      kind: 'story',
      title: 'Птицы у межи',
      synopsis: 'Стая не уходит.',
      relatedProcessIds: [],
      chronicleIds: ['lore_birds'],
    });
    domain.lore.push({
      id: 'lore_birds',
      text: 'Стая села на межу.',
      tags: ['chronicle'],
      sourcePlotId: 'plot_free',
    });
    const blocked = await fetch(`${base}/api/play/drop-story`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'local-user', plotId: 'plot_well' }),
    });
    assert.equal(blocked.status, 400);
    assert.equal((await blocked.json()).error, 'has_deeds');

    const ok = await fetch(`${base}/api/play/drop-story`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'local-user', plotId: 'plot_free' }),
    });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.ok, true);
    assert.equal(body.title, 'Птицы у межи');
    assert.equal(
      domain.plotlines.some((p) => p.id === 'plot_free'),
      false,
    );
  });
});

test('без playDev посев и снятие не торчат', async () => {
  await withServer(
    async ({ base }) => {
      const seed = await fetch(`${base}/api/play/seed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 'local-user', grain: 'void' }),
      });
      assert.equal(seed.status, 404);
      const drop = await fetch(`${base}/api/play/drop-story`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 'local-user', plotId: 'plot_well' }),
      });
      assert.equal(drop.status, 404);
      const threat = await fetch(`${base}/api/play/force-threat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 'local-user', plotId: 'plot_well', threatId: 'thr_known' }),
      });
      assert.equal(threat.status, 404);
      const deed = await fetch(`${base}/api/play/force-deed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 'local-user', processId: 'act_1', finish: 'ok' }),
      });
      assert.equal(deed.status, 404);
      const clock = await fetch(`${base}/api/play/clock`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 'local-user', held: true }),
      });
      assert.equal(clock.status, 404);
      const snaps = await fetch(`${base}/api/play/snapshots`);
      assert.equal(snaps.status, 404);
      const tick = await fetch(`${base}/api/play/tick`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 'local-user', days: 3 }),
      });
      assert.equal(tick.status, 404);
    },
    { playDev: false },
  );
});

test('кнопки инспектора срабатывают угрозу и закрывают дело выбранным исходом', async () => {
  const calls = [];
  await withServer(
    async ({ base }) => {
      const threat = await fetch(`${base}/api/play/force-threat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 'local-user', plotId: 'plot_well', threatId: 'thr_hidden' }),
      });
      assert.equal(threat.status, 200);
      assert.equal((await threat.json()).threatId, 'thr_hidden');

      const deed = await fetch(`${base}/api/play/force-deed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 'local-user', processId: 'act_1', finish: 'crit' }),
      });
      assert.equal(deed.status, 200);
      assert.equal((await deed.json()).finish, 'crit');
    },
    { calls },
  );
  assert.deepEqual(
    calls.map((c) => c.kind),
    ['force-threat', 'force-deed'],
  );
  assert.equal(calls[0].threatId, 'thr_hidden');
  assert.equal(calls[1].finish, 'crit');
});

test('пауза времени и снимки мира доступны тестовому клиенту', async () => {
  const calls = [];
  const hooks = {
    snapshots: [
      {
        id: 'save_abc',
        label: 'перед развилкой',
        savedAt: '2026-09-12T00:00:00.000Z',
        dayIndex: WORLD_DAY,
        dateLabel: 'Год 1, месяц 5, день 6',
        cityNames: ['Саркум'],
        domainCount: 1,
      },
    ],
  };
  await withServer(
    async ({ base, world }) => {
      const paused = await fetch(`${base}/api/play/clock`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 'local-user', held: true }),
      });
      assert.equal(paused.status, 200);
      assert.equal((await paused.json()).clockHeld, true);
      assert.ok(world.clockHeldAt);

      const state = await get(base, '/api/play/state?userId=local-user');
      assert.equal(state.clockHeld, true);

      const listed = await get(base, '/api/play/snapshots');
      assert.equal(listed.snapshots[0].id, 'save_abc');

      const saved = await fetch(`${base}/api/play/snapshots`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 'local-user', label: 'перед развилкой' }),
      });
      assert.equal(saved.status, 200);
      assert.equal((await saved.json()).id, 'save_abc');

      const loaded = await fetch(`${base}/api/play/snapshots/load`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 'local-user', id: 'save_abc' }),
      });
      assert.equal(loaded.status, 200);
      assert.equal((await loaded.json()).worldId, 'w1');

      const dropped = await fetch(`${base}/api/play/snapshots/save_abc`, { method: 'DELETE' });
      assert.equal(dropped.status, 200);
    },
    { calls, hooks },
  );
  assert.deepEqual(
    calls.map((c) => c.kind),
    ['clock', 'save', 'load', 'delete-save'],
  );
  assert.equal(calls[0].held, true);
  assert.equal(calls[1].label, 'перед развилкой');
  assert.equal(calls[2].id, 'save_abc');
});

test('тестовый клиент проматывает заданное число дней', async () => {
  await withServer(async ({ base, world }) => {
    const bad = await fetch(`${base}/api/play/tick`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'local-user', days: 0 }),
    });
    assert.equal(bad.status, 400);
    const started = await fetch(`${base}/api/play/tick`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'local-user', days: 7 }),
    });
    assert.equal(started.status, 200);
    assert.equal((await started.json()).days, 7);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(world.dayIndex, WORLD_DAY + 7);
  });
});

test('загрузка снимка во время шага времени отклоняется', async () => {
  await withServer(
    async ({ base }) => {
      const res = await fetch(`${base}/api/play/snapshots/load`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 'local-user', id: 'save_abc' }),
      });
      assert.equal(res.status, 409);
      assert.equal((await res.json()).error, 'ticking');
    },
    { hooks: { ticking: true } },
  );
});

