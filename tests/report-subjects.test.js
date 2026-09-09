import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRulerTools } from '../src/game/rulerTools.js';
import { MAX_PRIEST_ORDERS, priestOrders, addPriestOrder } from '../src/game/priestOrders.js';

const config = { stats: [{ id: 'prosperity' }, { id: 'security' }], tick: {} };

function makeDomain() {
  return {
    id: 'd1',
    name: 'Тихая Гряда',
    stats: { prosperity: 70, security: 55 },
    modifiers: [],
    lore: [],
    officers: [],
    characters: [{ name: 'Малуша', dialogHistory: [] }],
    plotlines: [],
    closedPlotlines: [],
    state: { pendingActions: [] },
  };
}

/** Хранилище-заглушка: считает, сколько раз домен реально сохранили. */
function storageOf() {
  return { saves: 0, async saveDomain() { this.saves += 1; } };
}

function toolsFor(domain, storage, { day = 120 } = {}) {
  const list = buildRulerTools(domain, storage, domain.characters[0], {
    config,
    world: { id: 'w1', dayIndex: day },
    day,
  });
  return Object.fromEntries(list.map((t) => [t.name, t]));
}

test('наказ заводится тулом и сразу лежит на домене', async () => {
  const domain = makeDomain();
  const storage = storageOf();
  const tools = toolsFor(domain, storage);
  const res = await tools.add_report_subject.handler({ subject: '  как идут дела в порту  ' });
  assert.equal(res.ok, true);
  assert.equal(res.subject, 'как идут дела в порту');
  assert.match(res.hint, /не обещай срок/i);
  assert.equal(priestOrders(domain).length, 1);
  assert.equal(storage.saves, 1);
});

test('повторный наказ не плодит вторую тему и не считается ошибкой', async () => {
  const domain = makeDomain();
  const storage = storageOf();
  const tools = toolsFor(domain, storage);
  await tools.add_report_subject.handler({ subject: 'дела в порту' });
  const again = await tools.add_report_subject.handler({ subject: 'ДЕЛА В ПОРТУ' });
  assert.equal(again.ok, true, 'жрецу нечего объяснять покровителю');
  assert.equal(priestOrders(domain).length, 1);
  assert.equal(storage.saves, 1, 'второй раз писать нечего');
});

test('переполнение возвращает список тем, чтобы жрец спросил, что снять', async () => {
  const domain = makeDomain();
  for (let i = 0; i < MAX_PRIEST_ORDERS; i += 1) {
    addPriestOrder(domain, { subject: `тема ${i}`, day: 0 });
  }
  const tools = toolsFor(domain, storageOf());
  const res = await tools.add_report_subject.handler({ subject: 'ещё одна' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'too_many');
  assert.equal(res.limit, MAX_PRIEST_ORDERS);
  assert.equal(res.subjects.length, MAX_PRIEST_ORDERS);
  assert.match(res.hint, /спроси/i);
});

test('пустой наказ не заводится', async () => {
  const domain = makeDomain();
  const storage = storageOf();
  const tools = toolsFor(domain, storage);
  const res = await tools.add_report_subject.handler({ subject: '   ' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'empty_subject');
  assert.equal(storage.saves, 0);
});

test('наказ снимается по словам покровителя, а не только по id', async () => {
  const domain = makeDomain();
  const storage = storageOf();
  const tools = toolsFor(domain, storage);
  await tools.add_report_subject.handler({ subject: 'как идут дела в порту' });
  const res = await tools.drop_report_subject.handler({ subject: 'порт' });
  assert.equal(res.ok, true);
  assert.equal(res.subject, 'как идут дела в порту');
  assert.equal(priestOrders(domain).length, 0);
});

test('несуществующий наказ снять нельзя, но жрецу видно, что у него есть', async () => {
  const domain = makeDomain();
  const tools = toolsFor(domain, storageOf());
  await tools.add_report_subject.handler({ subject: 'дела в порту' });
  const res = await tools.drop_report_subject.handler({ subject: 'рудники' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'not_found');
  assert.deepEqual(
    res.subjects.map((s) => s.subject),
    ['дела в порту'],
  );
});

test('read_notify отдаёт и настройки вестей, и наказы', async () => {
  const domain = makeDomain();
  const tools = toolsFor(domain, storageOf());
  await tools.add_report_subject.handler({ subject: 'дела в порту' });
  const res = await tools.read_notify.handler({});
  assert.equal(res.ok, true);
  assert.ok(res.notify.intensity, 'настройки на месте');
  assert.deepEqual(
    res.reportSubjects.map((s) => s.subject),
    ['дела в порту'],
  );
});

test('наказ помнит день, в который его дали', async () => {
  const domain = makeDomain();
  const tools = toolsFor(domain, storageOf(), { day: 205 });
  await tools.add_report_subject.handler({ subject: 'дела в порту' });
  assert.equal(priestOrders(domain)[0].sinceDay, 205);
});

test('расписания у наказа нет ни в схеме тула, ни в результате', async () => {
  const domain = makeDomain();
  const tools = toolsFor(domain, storageOf());
  const schema = tools.add_report_subject.parameters.properties;
  assert.deepEqual(Object.keys(schema), ['subject']);
  assert.match(tools.add_report_subject.description, /не расписание/i);
  const res = await tools.add_report_subject.handler({ subject: 'дела в порту' });
  assert.equal('everyDays' in res, false);
  assert.equal('nextDay' in res, false);
});
