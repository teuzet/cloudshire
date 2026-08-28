import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractPitchedCityName,
  extractUserCityName,
  lastPitchedCityName,
  playerConsentsToStart,
  playerAsksReroll,
  planOnboardingAutoStart,
  claimsOnboardingGenerating,
  applyUserNamedCity,
  applyUserNamedPatron,
  deriveOnboardingPhase,
  formatOnboardingStatusCard,
  hasPitchedCity,
  maybeSwitchToDossier,
  rememberLongUserBrief,
  emptyOnboardingDraft,
  formatPlayerBrief,
  collectOccupiedCityNames,
  isCityNameOccupied,
  validateCityNameAvailable,
  ONBOARDING_NEED_NAME_NOTE,
} from '../src/game/onboarding.js';

const varkenPitch = `Твой город — **Варкен**.

Он лежит в глубокой кальдере, куда ветры приносят вулканическую пыль.
Твоим голосом среди смертных станет верховный жрец **Саэрн**.`;

const noxLore = `Нокс создаёт новых разумных существ из биомассы.
Ноксианцы создаются у Чёрного озера. Мать создаёт солдат из подручных материалов.
Я пока не создаю остров и не финализирую концепт.`;

test('достаёт имя города из питча и не путает со жрецом', () => {
  assert.equal(extractPitchedCityName(varkenPitch), 'Варкен');
  assert.equal(extractPitchedCityName('Город будет называться **Сарвел**.'), 'Сарвел');
  assert.equal(extractPitchedCityName('у тебя будет город **Нарвел**: мягкий климат'), 'Нарвел');
  assert.equal(extractPitchedCityName('Отлично. Поднимаю остров «Элвар» — обычно минута-две.'), 'Элвар');
  assert.equal(extractPitchedCityName('Верховный жрец **Саэрн** ждёт тебя.'), null);
});

test('имя из реплики игрока — Цитадель Нокс', () => {
  assert.equal(
    extractUserCityName('Столица острова (как и сам остров) называется Цитадель Нокс.'),
    'Цитадель Нокс',
  );
  assert.equal(
    extractUserCityName('я сказал, что город называется Цитадель Нокс, как и сам остров.'),
    'Цитадель Нокс',
  );
  const draft = emptyOnboardingDraft();
  assert.equal(applyUserNamedCity(draft, 'город называется Цитадель Нокс'), 'Цитадель Нокс');
  assert.equal(draft.pitchedName, 'Цитадель Нокс');
  assert.equal(deriveOnboardingPhase(draft), 'pitched');
});

test('согласие на питч — да/начинаем/готов, не быстрый старт и не «создаётся?»', () => {
  const pitched = { pitched: true };
  assert.equal(playerConsentsToStart('Начинаем', pitched), true);
  assert.equal(playerConsentsToStart('да', pitched), true);
  assert.equal(playerConsentsToStart('да, Сарвел', pitched), true);
  assert.equal(playerConsentsToStart('создавай', pitched), true);
  assert.equal(playerConsentsToStart('готов', pitched), true);
  assert.equal(playerConsentsToStart('я готов', pitched), true);
  assert.equal(playerConsentsToStart('Давай быстрый старт', pitched), false);
  assert.equal(playerConsentsToStart('создается остров?', pitched), false);
  assert.equal(playerConsentsToStart('начинаем, но другой климат', pitched), false);
  assert.equal(playerConsentsToStart('Начинаем', { pitched: false }), false);
  assert.equal(
    playerConsentsToStart('Представь мне полное описание текущей концепции', pitched),
    false,
  );
});

test('полный реролл только по явной просьбе другого города', () => {
  assert.equal(playerAsksReroll('другой'), true);
  assert.equal(playerAsksReroll('не нравится, заново'), true);
  assert.equal(playerAsksReroll('Начинаем'), false);
  assert.equal(playerAsksReroll('создается остров?'), false);
  assert.equal(playerAsksReroll('давай быстрый старт'), false);
});

test('«Начинаем» после питча без имени бога не стартует', () => {
  const draft = {
    pitched: true,
    pitchedName: 'Варкен',
    messages: [{ role: 'assistant', content: varkenPitch }],
  };
  const plan = planOnboardingAutoStart({
    userText: 'Начинаем',
    reply: 'Тогда начинаем. Твой город — **Элвар**. Остров начинает создаваться.',
    draft,
  });
  assert.equal(plan.start, false);
  assert.equal(plan.appendNeedPatron, true);
  assert.equal(plan.name, 'Варкен');
  assert.equal(plan.reason, 'consent_without_patron');
});

test('«Начинаем» после питча и имени бога стартует старое имя города', () => {
  const draft = {
    pitched: true,
    pitchedName: 'Варкен',
    patronName: 'Астра',
    patronNameApproved: true,
    messages: [{ role: 'assistant', content: varkenPitch }],
  };
  const plan = planOnboardingAutoStart({
    userText: 'Начинаем',
    reply: 'Тогда начинаем. Твой город — **Элвар**. Остров начинает создаваться.',
    draft,
  });
  assert.deepEqual(plan, {
    start: true,
    name: 'Варкен',
    stripFalseStart: false,
    appendNeedName: false,
    appendNeedPatron: false,
    appendNameTaken: false,
    takenName: null,
    reason: 'player_consent',
  });
});

test('агент сказал «создаётся» без имени — короткую ложь убираем, генезис не стартует', () => {
  const plan = planOnboardingAutoStart({
    userText: 'создается остров?',
    reply: 'Да, остров сейчас создаётся. Жди письма.',
    draft: { pitched: false, messages: [] },
  });
  assert.equal(plan.start, false);
  assert.equal(plan.stripFalseStart, true);
  assert.equal(plan.appendNeedName, false);
  assert.equal(claimsOnboardingGenerating('Да, остров сейчас создаётся. Жди письма.'), true);
});

test('длинный пересказ с «создаёт» в лоре не стрипается и не стартует', () => {
  const recap = `${noxLore}\n\n${'Подробности концепции. '.repeat(40)}`;
  assert.equal(claimsOnboardingGenerating(recap), false);
  const plan = planOnboardingAutoStart({
    userText: 'Представь полное описание текущей концепции',
    reply: recap,
    draft: { pitched: false, messages: [], tagChoices: { terrain: 'кальдера / кратер' } },
  });
  assert.equal(plan.start, false);
  assert.equal(plan.stripFalseStart, false);
  assert.equal(plan.appendNeedName, false);
});

test('детектор ловит старт острова и игнорирует лор и отрицания', () => {
  assert.equal(claimsOnboardingGenerating('Поднимаю остров «Элвар» — обычно минута-две.'), true);
  assert.equal(claimsOnboardingGenerating('Остров начинает создаваться. Правитель напишет сам.'), true);
  assert.equal(claimsOnboardingGenerating('Нокс создаёт новых разумных существ из биомассы.'), false);
  assert.equal(claimsOnboardingGenerating('Ноксианцы создаются у Чёрного озера.'), false);
  assert.equal(claimsOnboardingGenerating('Мать создаёт солдат из подручных материалов.'), false);
  assert.equal(claimsOnboardingGenerating('Я не создаю остров, пока ты не подтвердишь имя.'), false);
  assert.equal(
    claimsOnboardingGenerating(
      'Остров ещё не начал создаваться: имя города не зафиксировано. Подтверди название.',
    ),
    false,
  );
  assert.equal(claimsOnboardingGenerating(ONBOARDING_NEED_NAME_NOTE), false);
});

test('вопрос «создаётся?» сам по себе не запускает новый питч', () => {
  const draft = {
    pitchedName: 'Сарвел',
    messages: [{ role: 'assistant', content: 'Город будет называться **Сарвел**.' }],
  };
  const plan = planOnboardingAutoStart({
    userText: 'остров создается?',
    reply: 'Пока нет. Город будет называться **Сарвел**. Подходит ли тебе?',
    draft,
  });
  assert.equal(plan.start, false);
  assert.equal(plan.stripFalseStart, false);
  assert.equal(lastPitchedCityName(draft), 'Сарвел');
});

test('теги без имени — не питч; карточка не врёт «город уже предложен»', () => {
  const draft = emptyOnboardingDraft();
  draft.tagChoices = { terrain: 'кальдера / кратер', temper: 'набожный' };
  draft.messages = [{ role: 'user', content: 'лонгрид' }];
  assert.equal(hasPitchedCity(draft), false);
  assert.equal(deriveOnboardingPhase(draft), 'collecting');
  const card = formatOnboardingStatusCard(draft, {
    genesis: { tagGroups: [{ id: 'terrain' }, { id: 'temper' }] },
  });
  assert.match(card, /это не питч/);
  assert.match(card, /Город ещё не предложен/);
  assert.doesNotMatch(card, /Имя уже названо/);
});

test('анкета: ответы не стартуют; после имени «начинаем» стартует', () => {
  const collecting = {
    mode: 'questions',
    pitched: false,
    messages: [],
  };
  const noStart = planOnboardingAutoStart({
    userText: 'На остальные вопросы ответь самостоятельно, опираясь на текущий концепт.',
    reply: 'Принял. Нокс создаёт тела у озера. Финализацию не начинаю.',
    draft: collecting,
  });
  assert.equal(noStart.start, false);

  const named = {
    pitched: true,
    pitchedName: 'Цитадель Нокс',
    patronName: 'Нокс',
    patronNameApproved: true,
    mode: 'dossier',
    messages: [{ role: 'user', content: 'город называется Цитадель Нокс' }],
  };
  const go = planOnboardingAutoStart({
    userText: 'создавай',
    reply: 'Хорошо, фиксирую имя.',
    draft: named,
  });
  assert.equal(go.start, true);
  assert.equal(go.name, 'Цитадель Нокс');
});

test('длинное ТЗ переключает в dossier и кладёт саммари в city, не в бесконечный freeform', () => {
  const draft = emptyOnboardingDraft();
  const wall = `С тех пор прошли многие столетия. ${'Липкая Тьма. '.repeat(80)}`;
  assert.equal(maybeSwitchToDossier(draft, wall), true);
  assert.equal(draft.mode, 'dossier');
  rememberLongUserBrief(draft, wall);
  assert.ok(draft.playerBrief.city.length > 200);
  assert.equal(draft.playerBrief.freeform, '');
});

test('подробное ТЗ игрока целиком уходит в бриф генезиса, потолок свободный', () => {
  const draft = emptyOnboardingDraft();
  const spec = `Ноксианская Цитадель. ${'Липкая Тьма покрывает остров. '.repeat(400)}`;
  assert.ok(spec.length > 8000);
  rememberLongUserBrief(draft, spec);
  const more = `Дополнение про таблички и Чёрное озеро. ${'Жрец толкует волю Нокс. '.repeat(200)}`;
  rememberLongUserBrief(draft, more);
  const brief = formatPlayerBrief(draft.playerBrief);
  assert.ok(draft.playerBrief.city.includes('Ноксианская Цитадель'));
  assert.ok(draft.playerBrief.city.includes('Чёрное озеро') || brief.includes('таблички'));
  assert.ok(brief.length > 8000);
  assert.ok(brief.length <= 32000);
  const card = formatOnboardingStatusCard(draft, { genesis: { tagGroups: [] } });
  assert.ok(card.includes('Ноксианская Цитадель'));
  assert.match(card, /бриф города для генезиса/);
});

test('агент соврал про старт в длинном ответе — текст оставляем, дописываем просьбу об имени', () => {
  const recap = `${'Описание острова. '.repeat(50)}\nПоднимаю остров, жди минуту.`;
  const plan = planOnboardingAutoStart({
    userText: 'покажи концепцию',
    reply: recap,
    draft: emptyOnboardingDraft(),
  });
  assert.equal(plan.start, false);
  assert.equal(plan.stripFalseStart, false);
  assert.equal(plan.appendNeedName, true);
});

test('игрок сам называет имя бога', () => {
  const draft = emptyOnboardingDraft();
  draft.pitched = true;
  draft.pitchedName = 'Саркум';
  assert.equal(applyUserNamedPatron(draft, 'зови меня Астра'), 'Астра');
  assert.equal(draft.patronName, 'Астра');
  assert.equal(draft.patronNameApproved, true);
});

test('занятое имя: уникальность без списка чужих городов', () => {
  const occupied = collectOccupiedCityNames({
    domains: [{ name: 'Севрайн' }],
    bindings: [
      { userId: 'other', onboarding: { cityName: 'Варкен', cityNameApproved: true } },
      { userId: 'other2', onboarding: { pitchedName: 'Нарвел', cityNameApproved: false } },
      { userId: 'me', onboarding: { pitchedName: 'Элвар', cityNameApproved: false } },
    ],
    excludeUserId: 'me',
  });
  assert.equal(isCityNameOccupied('севрайн', occupied), true);
  assert.equal(isCityNameOccupied('  Севрайн  ', occupied), true);
  assert.equal(isCityNameOccupied('Варкен', occupied), true);
  assert.equal(isCityNameOccupied('Нарвел', occupied), false);
  assert.equal(isCityNameOccupied('Элвар', occupied), false);

  const taken = validateCityNameAvailable('Севрайн', occupied);
  assert.equal(taken.ok, false);
  assert.match(taken.reason, /занято/);
  const free = validateCityNameAvailable('Элвар', occupied);
  assert.equal(free.ok, true);
  assert.equal(free.name, 'Элвар');

  assert.equal(extractPitchedCityName('Твой город — **Севрайн**.', occupied), null);
  assert.equal(extractPitchedCityName('Твой город — **Элвар**.', occupied), 'Элвар');

  const draft = emptyOnboardingDraft();
  assert.equal(applyUserNamedCity(draft, 'город называется Севрайн', occupied), null);
  assert.equal(applyUserNamedCity(draft, 'город называется Элвар', occupied), 'Элвар');

  const plan = planOnboardingAutoStart({
    userText: 'создавай',
    reply: 'Хорошо, фиксирую имя.',
    draft: {
      pitched: true,
      pitchedName: 'Севрайн',
      patronName: 'Нокс',
      patronNameApproved: true,
    },
    occupiedByKey: occupied,
  });
  assert.equal(plan.start, false);
  assert.equal(plan.appendNameTaken, true);
  assert.equal(plan.takenName, 'Севрайн');

  const card = formatOnboardingStatusCard(
    { pitchedName: 'Севрайн', pitched: true },
    { genesis: { tagGroups: [] } },
    { occupiedByKey: occupied },
  );
  assert.match(card, /Севрайн/);
  assert.match(card, /занят/);
  assert.equal(card.includes('Варкен'), false);
});
