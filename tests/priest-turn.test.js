import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { buildRulerTools, formatPriestTurn } from '../src/game/rulerTools.js';

const SYNOPSIS =
  'Три семьи спорят о наследных террасах, и повитухи до сих пор хранят свои записи о том, ' +
  'кто кому рождён и на какой уступ имеет право, хотя суд ещё не назвал наследника.';

function domain() {
  return {
    id: 'd1',
    name: 'Варскен',
    cityBrief: 'Город на террасах Варскена, зерно держат отдельно.',
    description: 'Это описание не должно вытеснить бриф.',
    population: 12000,
    stats: {},
    modifiers: [{ id: 'm1', text: 'Ночной дозор у края.', sinceLabel: 'вчера' }],
    proxyText: 'На стыке не уступай амбары.',
    lore: [
      {
        tags: ['chronicle'],
        gameDateLabel: 'первое цветения',
        text: 'Короткая прошлая запись.',
      },
      {
        tags: ['chronicle'],
        gameDateLabel: 'пятое цветения',
        plotClosed: true,
        plotCloseReason: 'наследник назван',
        text:
          'Полный текст последней хроники без обрезки: суд выслушал три семьи и отложил дележ до описи амбаров.',
      },
      {
        tags: ['character'],
        name: 'Айра',
        gender: 'female',
        role: 'ткачиха',
        about: 'Держит станок у нижнего уступа.',
      },
    ],
    officers: [
      {
        id: 'off1',
        office: 'treasurer',
        title: 'Казначей',
        name: 'Лета',
        gender: 'female',
        nature: 'Считает зерно раньше людей.',
        statId: 'prosperity',
        processId: 'deed1',
      },
      {
        id: 'off2',
        office: 'marshal',
        title: 'Маршал',
        name: 'Горн',
        gender: 'male',
        nature: 'Сначала выставляет стражу.',
        statId: 'security',
        processId: 'deed3',
      },
    ],
    characters: [
      {
        name: 'Елмир',
        title: 'жрец',
        description: 'Говорит коротко и не любит суеты.',
        loyalty: 60,
        terror: 40,
      },
    ],
    plotlines: [
      {
        id: 'plot1',
        title: 'Спор террас',
        synopsis: SYNOPSIS,
        hostDomainId: 'd1',
        relatedProcessIds: ['deed1'],
        threats: [
          {
            id: 't1',
            status: 'live',
            known: true,
            text: 'Обвал нижних террас',
            outcome: 'harm',
            dueDay: 40,
          },
        ],
      },
      {
        id: 'plot2',
        synopsis: 'Мостки над лощиной гниют.',
        hostDomainId: 'd1',
        relatedProcessIds: ['deed2'],
      },
    ],
    state: {
      patronName: 'Орион',
      patronGender: 'male',
      pendingActions: [
        {
          id: 'deed1',
          summary: 'Сторожить амбары',
          status: 'active',
          officerId: 'off1',
          office: 'treasurer',
          plotlineId: 'plot1',
          scheduledDays: 20,
        },
        {
          id: 'deed2',
          summary: 'Чинить мостки',
          status: 'paused',
          plotlineId: 'plot2',
          scheduledDays: 12,
        },
        {
          id: 'deed3',
          summary: 'Считать ночную стражу',
          status: 'active',
          officerId: 'off2',
          office: 'marshal',
          scheduledDays: 8,
        },
      ],
    },
  };
}

test('блок хода: бриф города раньше даты, истории и сановники собраны абзацами', () => {
  const d = domain();
  d.stats = { prosperity: 20 };
  const turn = formatPriestTurn(d, d.characters[0], {
    config: {
      stats: [
        {
          id: 'prosperity',
          name: 'Благосостояние',
          about: 'Сыты ли дворы.',
          covers: 'Еда',
          changeWhen: 'Урожай',
          scale: { 50: 'Скудная жизнь' },
        },
      ],
    },
    world: { dayIndex: 10, gameDate: { label: 'десятое цветения' } },
    day: 10,
  });
  assert.match(turn.stable, /^ГОРОД\nГород на террасах Варскена/);
  assert.doesNotMatch(turn.stable, /Ночной дозор/);
  assert.doesNotMatch(turn.stable, /Это описание не должно/);
  const dynamic = turn.dynamic;
  const dateAt = dynamic.indexOf('ДАТА СЕЙЧАС: десятое цветения');
  const storiesAt = dynamic.indexOf('ЖИВЫЕ ИСТОРИИ');
  const officersAt = dynamic.indexOf('САНОВНИКИ');
  const pausedAt = dynamic.indexOf('НА ПАУЗЕ');
  const chronicleAt = dynamic.indexOf('НЕДАВНЯЯ ХРОНИКА');
  assert.ok(dateAt >= 0 && dateAt < storiesAt && storiesAt < officersAt);
  assert.ok(officersAt < pausedAt && pausedAt < chronicleAt);
  assert.match(dynamic, /Имя покровителя: «Орион», пол: мужчина/);
  assert.doesNotMatch(dynamic, /Ночной дозор/);
  assert.match(dynamic, new RegExp(SYNOPSIS.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(dynamic, /Обвал нижних террас/);
  assert.match(dynamic, /Сторожить амбары/);
  assert.match(dynamic, /Дело по этой истории на паузе/);
  assert.match(dynamic, /Чинить мостки/);
  assert.match(dynamic, /На стыке не уступай амбары/);
  assert.match(dynamic, /Айра/);
  assert.match(dynamic, /Короткая прошлая запись/);
  assert.match(
    dynamic,
    /Полный текст последней хроники без обрезки: суд выслушал три семьи и отложил дележ до описи амбаров/,
  );
  assert.ok(
    dynamic.indexOf('Короткая прошлая запись') <
      dynamic.indexOf('Полный текст последней хроники без обрезки'),
  );
  assert.match(dynamic, /ЭТА ЗАПИСЬ ЗАКРЫЛА ПРОБЛЕМУ: наследник назван/);
  assert.doesNotMatch(dynamic, /ОТНОШЕНИЕ К ПОКРОВИТЕЛЮ|Лояльность|Ужас|Благосостояние/);

  const officers = dynamic.slice(officersAt, pausedAt);
  const leta = officers.split('\n\n').find((block) => block.includes('Лета'));
  const gorn = officers.split('\n\n').find((block) => block.includes('Горн'));
  assert.match(leta, /Считает зерно раньше людей/);
  assert.match(leta, /Ведает:/);
  assert.match(leta, /Как действует:/);
  assert.match(leta, /занят делом, оно написано при истории/);
  assert.doesNotMatch(leta, /Сторожить амбары/);
  assert.match(gorn, /Считать ночную стражу/);
  assert.doesNotMatch(dynamic.slice(storiesAt, officersAt), /Считать ночную стражу/);
});

test('жрецу видны десять последних записей хроники целиком', () => {
  const d = domain();
  d.lore = [
    ...Array.from({ length: 12 }, (_, i) => ({
      tags: ['chronicle'],
      gameDateLabel: `день ${i + 1}`,
      text: `Запись номер ${i + 1} без обрезки.`,
    })),
    ...d.lore.filter((f) => !(f.tags || []).includes('chronicle')),
  ];
  d.stats = { prosperity: 20 };
  const turn = formatPriestTurn(d, d.characters[0], {
    config: {
      stats: [
        {
          id: 'prosperity',
          name: 'Благосостояние',
          about: 'Сыты ли дворы.',
          scale: { 0: 'Скудная жизнь' },
        },
      ],
    },
    world: { dayIndex: 10 },
    day: 10,
  });
  assert.match(turn.dynamic, /НЕДАВНЯЯ ХРОНИКА/);
  assert.doesNotMatch(turn.dynamic, /Запись номер 1 /);
  assert.doesNotMatch(turn.dynamic, /Запись номер 2 /);
  assert.match(turn.dynamic, /Запись номер 3 без обрезки/);
  assert.match(turn.dynamic, /Запись номер 12 без обрезки/);
  assert.ok(
    turn.dynamic.indexOf('Запись номер 3') < turn.dynamic.indexOf('Запись номер 12'),
  );
  assert.doesNotMatch(turn.dynamic, /Благосостояние|Лояльность/);
});

test('у жреца нет снятых тулов, лормастеру один вопрос', () => {
  const d = domain();
  const tools = buildRulerTools(d, { async saveDomain() {} }, d.characters[0], {
    config: { stats: [] },
    world: { dayIndex: 10 },
    day: 10,
  });
  const names = tools.map((tool) => tool.name);
  for (const gone of [
    'read_domain_brief',
    'set_patron_name',
    'set_notify',
    'set_quiet_hours',
    'read_notify',
    'add_report_subject',
    'drop_report_subject',
    'adjust_loyalty',
    'adjust_terror',
  ]) {
    assert.equal(names.includes(gone), false, gone);
  }
  for (const kept of [
    'write_memory',
    'forget_memory',
    'consult_loremaster',
    'consult_informant',
    'declare_process',
    'set_proxy',
  ]) {
    assert.equal(names.includes(kept), true, kept);
  }
  const lore = tools.find((tool) => tool.name === 'consult_loremaster');
  assert.deepEqual(lore.parameters.required, ['question']);
  assert.equal(lore.parameters.properties.questions, undefined);
  assert.match(lore.parameters.properties.question.description, /факт/);
  const informant = tools.find((tool) => tool.name === 'consult_informant');
  assert.equal(informant.parameters.properties.questions.type, 'array');
});

test('инструкции жреца и лормастера про фактический вопрос, без снятых тулов', () => {
  const config = loadConfig();
  const ruler = config.agents.ruler.instructions;
  const lore = config.agents.loremaster.instructions;
  assert.match(ruler, /целиком выводится из данных блока хода/);
  assert.match(ruler, /Один вопрос за вызов/);
  assert.match(lore, /Если ответ целиком выводится из них/);
  assert.match(lore, /уточнение уже существующего факта — update_fact, иначе add_fact/);
  assert.doesNotMatch(lore, /зафиксируй его/);
  assert.doesNotMatch(ruler, /read_domain_brief|set_notify|add_report_subject|set_quiet_hours|read_notify/);
  assert.doesNotMatch(ruler, /adjust_loyalty|adjust_terror|Лояльность влияет|Ужас влияет/);
  assert.doesNotMatch(ruler, /Скрытую причину/);
  assert.match(lore, /что если/);
  assert.match(lore, /не записывай факт/);
});
