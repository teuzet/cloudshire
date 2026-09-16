import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  miniCityPayload,
  gameDateLabelAtTick,
  cityDescriptionSections,
  cityTabs,
} from '../src/game/miniCity.js';
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
      {
        id: 'off_k',
        office: 'keeper',
        statId: 'knowledge',
        title: 'Хранитель',
        name: 'Мира',
        processId: 'act_1',
        nature: 'осторожна и памятлива',
        gender: 'female',
        ageYears: 40,
        look: {
          ageYears: 40,
          build: 'сухощавый',
          skin: 'смуглая',
          hairColor: 'тёмные',
          hairStyle: 'пучок',
          clothing: 'мантия архива',
          mark: 'шрам у виска',
        },
        axes: { will: 3, wits: 4, mercy: 2 },
      },
      { id: 'off_c', office: 'chancellor', statId: 'influence', title: 'Канцлер', name: 'Орен', processId: null },
    ],
    plotlines: [
      {
        id: 'local',
        kind: 'story',
        title: 'Гул колодца',
        synopsis: 'Вода поёт.',
        gravity: 'CRISIS',
        depth: 1,
        maxDepth: 3,
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
    modifiers: [{ id: 'cmod_1', text: 'Ночной дозор у края', sinceLabel: 'Год 1, месяц 4' }],
    state: {
      pendingActions: [
        {
          id: 'act_1',
          summary: 'Осмотреть колодец',
          detail: 'Спуститься ночью.',
          durationBand: 'SEASON',
          difficulty: 'HARD',
          objectiveDays: 90,
          scheduledDays: 90,
          startDay: 100,
          dueDay: 190,
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
        durationBand: 'WEEKS',
        difficulty: 'PLAIN',
        objectiveDays: 40,
        scheduledDays: 40,
        startDay: 100,
        dueDay: 140,
        status: 'active',
        ownerDomainId: 'd1',
        linkedStats: ['security'],
      },
    ],
  };
  const world = { dayIndex: 125, tickIndex: 5, gameDate: { year: 1, month: 6, label: 'Год 1, месяц 6', tick: 5 } };
  const view = miniCityPayload({ domain, conflux, world, config: statsCfg, day: 125 });
  assert.equal(view.city.name, 'Саркум');
  assert.deepEqual(
    view.events.map((e) => e.title).sort(),
    ['Гул колодца', 'Общая драка'].sort(),
  );
  assert.equal(view.events.some((e) => e.title === 'Чужой храм'), false);
  const fight = view.events.find((e) => e.title === 'Общая драка');
  assert.equal(fight.processes[0].summary, 'Сторожить проход');
  assert.equal(view.processes.length, 4);
  assert.equal(
    view.processes.some((p) => 'monthsLeft' in (p.process || {})),
    false,
    'месячных полей в справочнике больше нет',
  );
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
  assert.equal(well.process.blessCost, 15, 'сезон — полоса SEASON');
  assert.equal(well.process.canBless, true);
  assert.equal(well.process.detail, 'Спуститься ночью.');
  assert.equal(well.process.duration, 'сезон');
  assert.equal(well.process.difficulty, 'трудное');
  assert.equal(well.process.pace, 'обычно');
  // Игроку — числа: по ним он решает, заглядывать ли через полчаса.
  assert.equal(well.process.remainingDays, 65);
  assert.equal(well.process.totalDays, 90);
  assert.equal(well.process.remainingReal, '~4,3 ч', '65 игровых дней это 260 реальных минут');
  assert.equal(well.nature, 'осторожна и памятлива');
  assert.equal(well.ageYears, 40);
  assert.equal(well.gender, 'female');
  assert.equal(well.look, undefined);
  assert.ok(well.process.finishChances);
  assert.equal(typeof well.process.finishChances.fail, 'number');
  assert.equal(well.temper, 'ровный, блестящий, суровый');
  assert.equal(fight.processes[0].blessCost, 8, 'недели — полоса WEEKS');
  assert.equal(fight.processes[0].canBless, true);
  assert.equal(knowledge.about, 'Помнит ли город, как лечить и читать.');
  assert.equal(view.orders[0].text, 'Ночной дозор у края');
  assert.match(view.orders[0].since, /Год 1, месяц 4/);
  assert.equal(view.gameDate, 'Год 1, месяц 5, день 6');

  const well2 = view.events.find((e) => e.title === 'Гул колодца');
  assert.equal(well2.threats, undefined, 'конкретные угрозы в справочник не кладём');
  assert.equal(typeof well2.dread, 'string', 'скрытая беда видна только как чутьё');
  assert.equal('loyalty' in (view.city || {}), false);
  assert.equal(view.city.hasImage, false);
  assert.equal(view.city.imageUrl, null);
  assert.deepEqual(view.city.sections, []);
  assert.equal(knowledge.officer.portraitUrl, null);
});

test('мини-аппка отдаёт разделы описания города', () => {
  const sections = cityDescriptionSections(
    {
      aspects: {
        overview: 'Ствол шире башни, мостки вокруг Праотца.',
        history: 'Первый мосток протянул Ваш.',
      },
      description: '## Чужое\nЭто не должно попасть в выдачу, если есть аспекты.',
    },
    {
      genesis: {
        aspects: [
          { id: 'overview', title: 'Общий облик' },
          { id: 'history', title: 'История и основание' },
          { id: 'geography', title: 'География и климат' },
        ],
      },
    },
  );
  assert.deepEqual(
    sections.map((s) => s.title),
    ['Общий облик', 'История и основание'],
  );
  assert.match(sections[0].text, /Праотца/);
  const fromMd = cityDescriptionSections({
    description: '## Облик\n\nГород на дереве.\n\n## Край\n\nОбрыв в облака.',
  });
  assert.equal(fromMd.length, 2);
  assert.equal(fromMd[0].title, 'Облик');
  assert.match(fromMd[1].text, /Обрыв/);
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
      const html = await res.text();
      assert.match(html, /<title>Город<\/title>/);
      assert.match(html, /data-tab="city"/);
      assert.match(html, /id="sheet"/);
    }
    const css = await fetch(`http://127.0.0.1:${port}/mini/style.css`, { redirect: 'manual' });
    assert.equal(css.status, 200);
    const js = await fetch(`http://127.0.0.1:${port}/mini/app.js`, { redirect: 'manual' });
    assert.equal(js.status, 200);
    const script = await js.text();
    assert.match(script, /data-open-officer/);
    assert.match(script, /function openOfficerSheet/);
    assert.doesNotMatch(script, /class="threat"/);
    assert.match(script, /ещё \$\{waitText\(p\.remainingDays/);
  } finally {
    await new Promise((resolve, reject) => http.close((err) => (err ? reject(err) : resolve())));
  }
});

test('раздел «Город» — меню из вкладок, а не одна простыня', () => {
  const domain = {
    id: 'd1',
    name: 'Ствол',
    description: '## Облик\n\nГород на дереве.',
    cityBrief: 'Город держится на одном стволе.\nНеизвестно (канон):\n- кто прорубил нижние мостки',
    modifiers: [{ text: 'подать удвоена' }],
    officers: [{ id: 'o1', office: 'treasurer', title: 'Казначей', name: 'Малуша', nature: 'суха и точна' }],
    lore: [
      { id: 'f1', tags: ['chronicle'], text: 'Мостки просели', gameDateLabel: 'Год 1, месяц 3, день 4' },
      { id: 'f2', tags: ['chronicle'], text: 'Досмотрщика нашли мёртвым', tick: 5 },
      { id: 'l1', tags: ['character'], name: 'Ваш', role: 'плотник', about: 'первый мосточник', ageYears: 61 },
      { id: 'l2', tags: ['fact'], text: 'это не человек и не хроника' },
    ],
  };
  const tabs = cityTabs(domain, { tickIndex: 5 }, {});
  assert.deepEqual(tabs.map((t) => t.id), ['description', 'brief', 'chronicle', 'people']);

  const brief = tabs.find((t) => t.id === 'brief');
  assert.deepEqual(brief.sections.map((s) => s.id), ['brief-body', 'brief-unknowns', 'brief-modifiers']);
  assert.match(brief.sections[1].text, /нижние мостки/);
  assert.match(brief.sections[2].text, /подать удвоена/);

  const chronicle = tabs.find((t) => t.id === 'chronicle');
  assert.deepEqual(chronicle.entries.map((f) => f.id), ['f2', 'f1'], 'свежее сверху');
  assert.equal(chronicle.entries[1].date, 'Год 1, месяц 3, день 4');
  assert.ok(chronicle.entries[0].date, 'дата выводится из тика, если метки нет');

  const people = tabs.find((t) => t.id === 'people');
  assert.deepEqual(people.people.map((p) => p.name), ['Малуша', 'Ваш'], 'сановники впереди');
  assert.equal(people.people[0].officer, true);
  assert.equal(people.people[1].ageYears, 61);
});

test('пустые вкладки в меню не показываем', () => {
  const tabs = cityTabs({ id: 'd1', name: 'Пусто' }, {}, {});
  assert.deepEqual(tabs, []);
});

test('сановник не дублируется человеком из лора с тем же именем', () => {
  const tabs = cityTabs(
    {
      id: 'd1',
      officers: [{ id: 'o1', name: 'Малуша', title: 'Казначей' }],
      lore: [{ id: 'l1', tags: ['character'], name: 'Малуша', role: 'счётчица' }],
    },
    {},
    {},
  );
  const people = tabs.find((t) => t.id === 'people');
  assert.deepEqual(people.people.map((p) => p.role), ['Казначей']);
});
