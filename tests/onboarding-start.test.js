import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractPitchedCityName,
  lastPitchedCityName,
  playerConsentsToStart,
  playerAsksReroll,
  planOnboardingAutoStart,
  claimsOnboardingGenerating,
} from '../src/game/onboarding.js';

const varkenPitch = `Твой город — **Варкен**.

Он лежит в глубокой кальдере, куда ветры приносят вулканическую пыль.
Твоим голосом среди смертных станет верховный жрец **Саэрн**.`;

test('достаёт имя города из питча и не путает со жрецом', () => {
  assert.equal(extractPitchedCityName(varkenPitch), 'Варкен');
  assert.equal(extractPitchedCityName('Город будет называться **Сарвел**.'), 'Сарвел');
  assert.equal(extractPitchedCityName('у тебя будет город **Нарвел**: мягкий климат'), 'Нарвел');
  assert.equal(extractPitchedCityName('Отлично. Поднимаю остров «Элвар» — обычно минута-две.'), 'Элвар');
  assert.equal(extractPitchedCityName('Верховный жрец **Саэрн** ждёт тебя.'), null);
});

test('согласие на питч — да/начинаем, не быстрый старт и не «создаётся?»', () => {
  const pitched = { pitched: true };
  assert.equal(playerConsentsToStart('Начинаем', pitched), true);
  assert.equal(playerConsentsToStart('да', pitched), true);
  assert.equal(playerConsentsToStart('да, Сарвел', pitched), true);
  assert.equal(playerConsentsToStart('Давай быстрый старт', pitched), false);
  assert.equal(playerConsentsToStart('создается остров?', pitched), false);
  assert.equal(playerConsentsToStart('начинаем, но другой климат', pitched), false);
  assert.equal(playerConsentsToStart('Начинаем', { pitched: false }), false);
});

test('полный реролл только по явной просьбе другого города', () => {
  assert.equal(playerAsksReroll('другой'), true);
  assert.equal(playerAsksReroll('не нравится, заново'), true);
  assert.equal(playerAsksReroll('Начинаем'), false);
  assert.equal(playerAsksReroll('создается остров?'), false);
  assert.equal(playerAsksReroll('давай быстрый старт'), false);
});

test('«Начинаем» после питча стартует старое имя, даже если агент выдумал новое', () => {
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
  assert.deepEqual(plan, {
    start: true,
    name: 'Варкен',
    stripFalseStart: false,
    reason: 'player_consent',
  });
});

test('агент сказал «создаётся» без имени — ложь убираем, генезис не стартует', () => {
  const plan = planOnboardingAutoStart({
    userText: 'создается остров?',
    reply: 'Да, остров сейчас создаётся. Жди письма.',
    draft: { pitched: false, messages: [] },
  });
  assert.equal(plan.start, false);
  assert.equal(plan.stripFalseStart, true);
  assert.equal(claimsOnboardingGenerating('Да, остров сейчас создаётся. Жди письма.'), true);
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
