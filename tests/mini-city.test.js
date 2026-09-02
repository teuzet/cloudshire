import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { miniCityPayload, gameDateLabelAtTick } from '../src/game/miniCity.js';
import { validateTelegramInitData, miniAppUrl } from '../src/clients/telegram/initData.js';
import { createWebServer } from '../src/clients/web/server.js';

const statsCfg = {
  faith: {
    name: 'Вера',
    about: 'Насколько город ещё верит, что ты — его бог.',
  },
  mana: {
    name: 'Мана',
    about: 'Сила, которой ты благословляешь дела.',
  },
  stats: [
    { id: 'prosperity', name: 'Благосостояние', about: 'Сыты ли дворы и полны ли склады.' },
    { id: 'security', name: 'Безопасность', about: 'Спит ли улица спокойно.' },
    { id: 'knowledge', name: 'Знание', about: 'Помнит ли город, как лечить и читать.' },
    { id: 'influence', name: 'Влияние', about: 'Слушают ли город его собственные дома.' },
  ],
  statEpithets: { 0: 'ужасающе', 50: 'обычно', 100: 'божественно' },
};

function signInitData(token, fields) {
  const params = new URLSearchParams(fields);
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
  params.set('hash', hash);
  return params.toString();
}

test('initData принимает подпись Telegram и достаёт user id', () => {
  const token = '123:abc';
  const user = JSON.stringify({ id: 518815155, first_name: 'Тест' });
  const raw = signInitData(token, { auth_date: '1700000000', user });
  const ok = validateTelegramInitData(raw, token, { nowSec: 1700000100 });
  assert.equal(ok.ok, true);
  assert.equal(ok.userId, '518815155');
});

test('initData отвергает битую подпись и просрочку', () => {
  const token = '123:abc';
  const raw = signInitData(token, {
    auth_date: '100',
    user: JSON.stringify({ id: 1 }),
  });
  assert.equal(validateTelegramInitData(raw, 'other-token').ok, false);
  assert.equal(validateTelegramInitData(raw, token, { nowSec: 200000, maxAgeSec: 60 }).error, 'expired');
});

test('адрес мини-аппки из явного URL и из Railway', () => {
  const prevUrl = process.env.TELEGRAM_MINI_APP_URL;
  const prevRail = process.env.RAILWAY_PUBLIC_DOMAIN;
  delete process.env.TELEGRAM_MINI_APP_URL;
  delete process.env.RAILWAY_PUBLIC_DOMAIN;
  try {
    assert.equal(miniAppUrl({ telegram: { miniAppUrl: 'https://ex.example/mini' } }), 'https://ex.example/mini/');
    process.env.RAILWAY_PUBLIC_DOMAIN = 'cloudshire.up.railway.app';
    assert.equal(miniAppUrl({ telegram: {} }), 'https://cloudshire.up.railway.app/mini/');
  } finally {
    if (prevUrl == null) delete process.env.TELEGRAM_MINI_APP_URL;
    else process.env.TELEGRAM_MINI_APP_URL = prevUrl;
    if (prevRail == null) delete process.env.RAILWAY_PUBLIC_DOMAIN;
    else process.env.RAILWAY_PUBLIC_DOMAIN = prevRail;
  }
});

test('дата по тику совпадает с календарём мира', () => {
  assert.equal(gameDateLabelAtTick({ tickIndex: 0 }, 0), 'Год 1, месяц 1');
  assert.equal(gameDateLabelAtTick({}, 12), 'Год 2, месяц 1');
});

test('мини-аппка: свои истории и участие в сопряжении, без чужой осведомлённости', () => {
  const domain = {
    id: 'd1',
    name: 'Саркум',
    stats: { prosperity: 55, security: 40, knowledge: 62, influence: 50 },
    officers: [
      { id: 'off_t', office: 'treasurer', statId: 'prosperity', title: 'Казначей', name: 'Элара', processId: null },
      { id: 'off_m', office: 'marshal', statId: 'security', title: 'Маршал', name: 'Кален', processId: 'act_cf' },
      { id: 'off_k', office: 'keeper', statId: 'knowledge', title: 'Хранитель', name: 'Мира', processId: 'act_1' },
      { id: 'off_c', office: 'chancellor', statId: 'influence', title: 'Канцлер', name: 'Орен', processId: null },
    ],
    plotlines: [
      { id: 'local', kind: 'story', title: 'Гул колодца', synopsis: 'Вода поёт.' },
      {
        id: 'ord_1',
        kind: 'order',
        title: 'Ночной дозор',
        orderText: 'Ночной дозор у края',
        createdTick: 3,
        durationMonths: 4,
        expiresTick: 7,
      },
    ],
    state: {
      pendingActions: [
        {
          id: 'act_1',
          summary: 'Осмотреть колодец',
          detail: 'Спуститься ночью.',
          monthsLeft: 2,
          expectedMonths: 3,
          objectiveMonths: 3,
          status: 'active',
          linkedStats: ['knowledge'],
        },
      ],
      modifiers: [],
      faith: 52,
      mana: 40,
    },
  };
  const conflux = {
    plotlines: [
      {
        id: 'main',
        kind: 'story',
        isMainConflux: true,
        title: 'Сопряжение',
        synopsis: 'Края сходятся.',
        concernsDomainIds: ['d1', 'd2'],
      },
      {
        id: 'ours',
        kind: 'story',
        title: 'Общая драка',
        synopsis: 'Дворы спорят у прохода.',
        concernsDomainIds: ['d1', 'd2'],
        relatedProcessIds: ['act_cf'],
      },
      {
        id: 'theirs',
        kind: 'story',
        title: 'Чужой храм',
        synopsis: 'Сосед прячет обряд.',
        hostDomainId: 'd2',
        concernsDomainIds: ['d2'],
        plotAwareness: { d1: true },
      },
    ],
    processes: [
      {
        id: 'act_cf',
        summary: 'Сторожить проход',
        detail: 'Дозор на мосту.',
        monthsLeft: 1,
        expectedMonths: 2,
        objectiveMonths: 2,
        status: 'active',
        ownerDomainId: 'd1',
        linkedStats: ['security'],
      },
    ],
  };
  const world = { tickIndex: 5, gameDate: { year: 1, month: 6, label: 'Год 1, месяц 6', tick: 5 } };
  const view = miniCityPayload({ domain, conflux, world, config: statsCfg });
  assert.equal(view.city.name, 'Саркум');
  assert.deepEqual(
    view.events.map((e) => e.title).sort(),
    ['Гул колодца', 'Общая драка', 'Сопряжение'].sort(),
  );
  assert.equal(view.events.some((e) => e.title === 'Чужой храм'), false);
  const fight = view.events.find((e) => e.title === 'Общая драка');
  assert.equal(fight.processes[0].summary, 'Сторожить проход');
  assert.equal(view.processes.length, 4);
  assert.equal(view.processes.some((p) => p.process?.monthsLeft === 2), true);
  const knowledge = view.stats.find((s) => s.id === 'knowledge');
  assert.equal(knowledge.value, 62);
  assert.equal(knowledge.officer.name, 'Мира');
  assert.equal(view.faith.value, 52);
  assert.equal(view.faith.name, 'Вера');
  assert.match(view.faith.about, /верит/);
  assert.equal(view.mana.name, 'Мана');
  assert.equal(view.mana.value, 40);
  assert.equal(view.mana.max, 100);
  const well = view.processes.find((p) => p.process?.summary === 'Осмотреть колодец');
  assert.equal(well.process.blessCost, 30);
  assert.equal(well.process.canBless, true);
  assert.equal(fight.processes[0].blessCost, 20);
  assert.equal(fight.processes[0].canBless, true);
  assert.equal(knowledge.about, 'Помнит ли город, как лечить и читать.');
  assert.equal(view.orders[0].indefinite, false);
  assert.equal(view.orders[0].remainingMonths, 2);
  assert.match(view.orders[0].since, /Год 1, месяц 4/);
  assert.equal(view.gameDate, 'Год 1, месяц 6');
  assert.equal('loyalty' in (view.city || {}), false);
  assert.equal(view.city.hasImage, false);
  assert.equal(view.city.imageUrl, null);
  assert.equal(knowledge.officer.portraitUrl, null);
});

test('GET /mini и /mini/ отдают страницу без редиректа', async () => {
  const server = createWebServer({
    config: { web: { play: false, admin: false }, telegram: {} },
    app: { onOutbound() {} },
    runtime: {},
    storage: {},
  });
  const http = await new Promise((resolve) => {
    const s = server.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const port = http.address().port;
    for (const path of ['/mini', '/mini/']) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, { redirect: 'manual' });
      assert.equal(res.status, 200, path);
      assert.equal(res.headers.get('location'), null);
      assert.match(await res.text(), /<title>Город<\/title>/);
    }
    const css = await fetch(`http://127.0.0.1:${port}/mini/style.css`, { redirect: 'manual' });
    assert.equal(css.status, 200);
  } finally {
    await new Promise((resolve, reject) => http.close((err) => (err ? reject(err) : resolve())));
  }
});
