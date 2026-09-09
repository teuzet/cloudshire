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
      },
    ],
    plotlines: [
      {
        id: 'plot_well',
        kind: 'story',
        title: 'Гул колодца',
        synopsis: 'Вода поёт.',
        gravity: 'CRISIS',
        depth: 1,
        maxDepth: 3,
        relatedProcessIds: ['act_1'],
        endings: [
          { id: 'end_good', kind: 'GOOD_ENDING', text: 'Сруб держит, вода снова чистая' },
          { id: 'end_neutral', kind: 'NEUTRAL_ENDING', text: 'Колодец забросили и роют новый' },
          { id: 'end_bad', kind: 'BAD_ENDING', text: 'Колодец обрушился вместе с водовозами' },
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
        },
      ],
      confluxDirective: { text: 'Не пускать чужих в город', office: 'marshal', sinceDay: 90 },
      priestOrders: [{ id: 'po_1', subject: 'как идут дела в порту', lastEventNo: null }],
    },
  };
}

function makeStorage(domain, world) {
  return {
    getWorld: async () => world,
    listDomains: async () => [domain],
    getDomain: async (id) => (id === domain.id ? domain : null),
    getDomainForUser: async (userId) => (userId === 'local-user' ? domain : null),
    getUserBinding: async () => ({ userId: 'local-user', domainId: domain.id }),
    listUserBindings: async () => [{ userId: 'local-user', domainId: domain.id }],
    listConfluxes: async () => [],
    saveDomain: async () => {},
    saveWorld: async () => {},
  };
}

function makeApp(calls = [], hooks = {}) {
  return {
    onOutbound() {},
    isGenerating: () => false,
    isWorldTicking: () => false,
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
  };
}

async function withServer(run, { calls = [], hooks = {}, playDev, domain: givenDomain } = {}) {
  const world = makeWorld();
  const domain = givenDomain || makeDomain();
  const cfg = playDev === false ? { ...config, web: { ...config.web, playDev: false } } : config;
  const server = createWebServer({
    config: cfg,
    app: makeApp(calls, { ...hooks, domain, world }),
    runtime: {},
    storage: makeStorage(domain, world),
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
  });
});

test('концовки приходят разобранными, а не одной строкой closeWhen', async () => {
  await withServer(async ({ base }) => {
    const data = await get(base, '/api/play/inspect?userId=local-user');
    const plot = data.domain.plotlines[0];
    // closeWhen у нити со ставками — это все её концовки сразу; склеенный
    // в строку он читался как один длинный исход и ничего не объяснял.
    assert.deepEqual(
      plot.endings.map((e) => [e.kind, e.text]),
      [
        ['GOOD_ENDING', 'Сруб держит, вода снова чистая'],
        ['NEUTRAL_ENDING', 'Колодец забросили и роют новый'],
        ['BAD_ENDING', 'Колодец обрушился вместе с водовозами'],
      ],
    );
  });
});

test('клиент рисует концовки списком с пометкой рода', async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}/play/app.js`);
    assert.equal(res.status, 200);
    const js = await res.text();
    assert.match(js, /function endingsBlock/);
    assert.match(js, /GOOD_ENDING: 'хорошая'/);
    assert.match(js, /data-seed-form/);
    assert.match(js, /data-drop/);
  });
});

test('порядок города, наказ на сопряжение и темы докладов видны клиенту', async () => {
  await withServer(async ({ base }) => {
    const data = await get(base, '/api/play/inspect?userId=local-user');
    assert.equal(data.domain.standingRules[0].text, 'Ночной дозор у края');
    assert.equal(data.domain.confluxDirective.text, 'Не пускать чужих в город');
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
        body: JSON.stringify({ userId: 'local-user', gravity: 'SITUATION', grain: 'genesis' }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.ok, true);
      assert.equal(body.grain, 'genesis');
      assert.equal(body.plot.title, 'Новая');
    },
    { calls },
  );
  assert.deepEqual(calls[0], { kind: 'seed', userId: 'local-user', gravity: 'SITUATION', grain: 'genesis' });
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
    },
    { playDev: false },
  );
});

