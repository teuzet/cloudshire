import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeCityEntities,
  capCityEntities,
  pickMysteryAnchors,
  formatMysteryAnchorsForPrompt,
  hasCityEntityCatalog,
  ensureCityEntities,
} from '../src/game/cityEntities.js';
import { normalizeDomain } from '../src/game/models.js';
import { plotConfig } from '../src/game/plotlines.js';

function catalog() {
  return [
    { kind: 'place', name: 'Верхний ярус', about: 'Жилые террасы над рыночной лестницей.' },
    { kind: 'institution', name: 'Восемь печатей', about: 'Совет, скрепляющий договоры дворов.' },
    { kind: 'resource', name: 'Стеклодувная шихта', about: 'Песок и щёлок для мастерских среднего уступа.' },
    { kind: 'craft', name: 'Плетение лозы', about: 'Корзины для подъёма груза между ярусами.' },
    { kind: 'infrastructure', name: 'Водяные чаны', about: 'Запас на нижнем ряду после дождя.' },
    { kind: 'custom', name: 'Ночной обход фонарей', about: 'Смена зажигает чаши вдоль мостков.' },
    { kind: 'tension', name: 'Спор о пае дворов', about: 'Верхние дворы тянут воду раньше нижних.' },
  ];
}

test('обрезка каталога снимает частые виды, а не редкие', () => {
  const raw = [
    ...['А', 'Б', 'В', 'Г', 'Д'].map((name) => ({
      kind: 'place',
      name: `Место ${name}`,
      about: 'район города.',
    })),
    { kind: 'tension', name: 'Спор о пае', about: 'дворы тянут воду.' },
    { kind: 'custom', name: 'Обход фонарей', about: 'зажигают чаши.' },
  ];
  const capped = capCityEntities(raw, 5);
  assert.equal(capped.length, 5);
  assert.ok(capped.some((i) => i.kind === 'tension' && i.name === 'Спор о пае'));
  assert.ok(capped.some((i) => i.kind === 'custom' && i.name === 'Обход фонарей'));
  assert.equal(capped.filter((i) => i.kind === 'place').length, 3);
});

test('нормализация отбрасывает людей, пустые и чужие виды', () => {
  const list = normalizeCityEntities([
    { kind: 'place', name: 'Рынок', about: 'Лестница и лавки.' },
    { kind: 'person', name: 'Кайрен', about: 'Правитель.' },
    { kind: 'place', name: '  ', about: 'пусто' },
    { kind: 'place', name: 'Рынок', about: 'дубль' },
    null,
  ]);
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'Рынок');
  assert.ok(list[0].id);
});

test('выборка 1–2 из каталога, полный список в промпт не попадает', () => {
  const cfg = {
    mysteryEntities: { pickMin: 2, pickMax: 2, inventChance: 0 },
  };
  const picked = pickMysteryAnchors(catalog(), cfg, () => 0.1);
  assert.equal(picked.length, 2);
  assert.ok(picked.every((a) => !a.invent && a.name && a.about));
  const text = formatMysteryAnchorsForPrompt(picked);
  assert.match(text, /ЯКОРЯ ЭТОЙ ТАЙНЫ/);
  const named = picked.map((a) => a.name);
  for (const item of catalog()) {
    if (named.includes(item.name)) assert.match(text, new RegExp(item.name));
    else assert.equal(text.includes(item.name), false);
  }
});

test('inventChance 1 и pick 1 даёт только слот изобретения', () => {
  const cfg = { mysteryEntities: { pickMin: 1, pickMax: 1, inventChance: 1 } };
  const picked = pickMysteryAnchors(catalog(), cfg, () => 0, { inventKind: 'cult' });
  assert.equal(picked.length, 1);
  assert.equal(picked[0].invent, true);
  assert.equal(picked[0].kind, 'cult');
  assert.equal(picked[0].name, undefined);
  const text = formatMysteryAnchorsForPrompt(picked);
  assert.match(text, /изобрести/);
  assert.equal(text.includes('Водяные чаны'), false);
  assert.equal(text.includes('Восемь печатей'), false);
});

test('inventChance 1 и pick 2: изобретение плюс один якорь из каталога', () => {
  const cfg = { mysteryEntities: { pickMin: 2, pickMax: 2, inventChance: 1 } };
  const picked = pickMysteryAnchors(catalog(), cfg, () => 0);
  assert.equal(picked.length, 2);
  const invent = picked.filter((a) => a.invent);
  const fromCatalog = picked.filter((a) => !a.invent);
  assert.equal(invent.length, 1);
  assert.equal(fromCatalog.length, 1);
  assert.ok(fromCatalog[0].name);
});

test('второй якорь выпадает редко', () => {
  const one = pickMysteryAnchors(
    catalog(),
    { mysteryEntities: { pickMin: 1, pickMax: 2, twoChance: 0, inventChance: 0 } },
    () => 0.5,
  );
  assert.equal(one.length, 1);
  const two = pickMysteryAnchors(
    catalog(),
    { mysteryEntities: { pickMin: 1, pickMax: 2, twoChance: 1, inventChance: 0 } },
    () => 0,
  );
  assert.equal(two.length, 2);
});

test('пустой каталог не даёт якорей', () => {
  assert.deepEqual(pickMysteryAnchors([], { inventChance: 1 }), []);
  assert.equal(formatMysteryAnchorsForPrompt([]), '');
});

test('нормализация домена поднимает пустой каталог', () => {
  const domain = normalizeDomain({ name: 'Тест' });
  assert.deepEqual(domain.cityEntities, []);
  assert.equal(domain.cityEntitiesReady, false);
  assert.equal(hasCityEntityCatalog(domain), false);
  domain.cityEntities = catalog();
  const again = normalizeDomain(domain);
  assert.equal(again.cityEntities.length, catalog().length);
  assert.equal(again.cityEntitiesReady, true);
});

test('ensure не зовёт агента, если каталог уже есть', async () => {
  let called = 0;
  const domain = { id: 'd1', name: 'Тест', cityEntities: catalog() };
  const runtime = { run: async () => { called += 1; return { text: '', toolTrace: [] }; } };
  const list = await ensureCityEntities({
    domain,
    runtime,
    config: { tick: { plot: { mystery: { entities: { minCatalog: 4, maxCatalog: 20 } } } } },
  });
  assert.equal(list.length, catalog().length);
  assert.equal(called, 0);
  assert.equal(domain.cityEntitiesReady, true);
});

test('ensure после неудачи больше не дёргает агента', async () => {
  let called = 0;
  const domain = { id: 'd1', name: 'Тест', description: 'город' };
  const runtime = { run: async () => { called += 1; return { text: '', toolTrace: [] }; } };
  await ensureCityEntities({ domain, runtime, config: {} });
  const afterFirst = called;
  assert.ok(afterFirst >= 1);
  assert.equal(domain.cityEntitiesReady, true);
  assert.deepEqual(domain.cityEntities, []);
  await ensureCityEntities({ domain, runtime, config: {} });
  assert.equal(called, afterFirst);
});

test('plotConfig читает пороги сущностей', () => {
  const cfg = plotConfig({
    tick: { plot: { mystery: { entities: { minCatalog: 10, pickMax: 2, inventChance: 0.2 } } } },
  });
  assert.equal(cfg.mysteryEntities.minCatalog, 10);
  assert.equal(cfg.mysteryEntities.pickMax, 2);
  assert.equal(cfg.mysteryEntities.inventChance, 0.2);
});
