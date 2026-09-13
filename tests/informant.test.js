import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  visibleNeighborLore,
  formatNeighborPlotList,
  askInformant,
} from '../src/game/informant.js';
import { createPlotline } from '../src/game/plotlines.js';
import { createLoreFact } from '../src/game/models.js';

function city(id, name, extra = {}) {
  return {
    id,
    name,
    lore: [],
    plotlines: [],
    characters: [{ name: `Правитель ${name}` }],
    state: { events: [], pendingActions: [] },
    modifiers: [],
    cityBrief: '',
    ...extra,
  };
}

test('информатор не видит тайные факты и канон нитей соседа', () => {
  const lore = [
    createLoreFact({ id: 'lore_pub', text: 'На площади рынок.', tags: ['fact'] }),
    createLoreFact({ id: 'lore_sec', text: 'Тайный склад.', tags: ['fact'], secret: true }),
  ];
  const visible = visibleNeighborLore(lore);
  assert.equal(visible.length, 1);
  assert.equal(visible[0].id, 'lore_pub');

  const plot = createPlotline({
    title: 'Гул',
    synopsis: 'В цистерне гудит вода.',
    storyType: 'mystery',
  });
  plot.truth = 'Ил в трубах.';
  plot.truthGraph = { nodes: [{ id: 'A', text: 'Цистерну не чистили.', knowledge: 'hidden' }] };
  const list = formatNeighborPlotList([plot]);
  assert.match(list, /Гул/);
  assert.match(list, /гудит вода/);
  assert.equal(list.includes('Ил в трубах'), false);
  assert.equal(list.includes('не чистили'), false);
});

test('без стыковки информатора нет', async () => {
  const domain = city('a', 'Аллерия');
  const result = await askInformant({
    domain,
    questions: ['Что у соседа?'],
    conflux: { status: 'approaching', domainIds: ['a', 'b'] },
    storage: {
      async getWorld() {
        return { gameDate: { label: 'Год 1' } };
      },
    },
  });
  assert.equal(result.error, 'no_informant');
  assert.match(result.loreTextForAsker, /не состыкованы/);
});

test('новый факт о соседе лежит у соседа, у спросившего — ссылка', async () => {
  const asker = city('a', 'Аллерия');
  const partner = city('b', 'Керсай');
  partner.lore = [createLoreFact({ id: 'lore_old', text: 'У Керсая крепость.', tags: ['fact'] })];
  const conflux = { id: 'cf1', status: 'docked', domainIds: ['a', 'b'], lore: [] };
  const storage = {
    async getWorld() {
      return { gameDate: { label: 'Год 1, месяц 2, день 3' }, tickIndex: 1 };
    },
    async getDomain(id) {
      return id === 'b' ? partner : asker;
    },
    async updateDomain(id, mutate) {
      const d = id === 'b' ? partner : asker;
      await mutate(d);
      return d;
    },
    async saveDomain() {},
    async saveConflux() {},
  };
  const runtime = {
    async run({ tools }) {
      const add = tools.find((t) => t.name === 'add_fact');
      const submit = tools.find((t) => t.name === 'submit_answers');
      await add.handler({ text: 'В Керсае держат запас зерна на год.' });
      await submit.handler({
        answers: [{ question: 'Есть ли запас?', answer: 'Держат запас зерна на год.' }],
      });
    },
  };
  const result = await askInformant({
    runtime,
    storage,
    domain: asker,
    questions: ['Есть ли запас?'],
    conflux,
  });
  assert.equal(result.ok, true);
  assert.equal(result.addedFacts.length, 1);
  assert.ok(partner.lore.some((f) => f.text.includes('запас зерна')));
  const original = partner.lore.find((f) => f.text.includes('запас зерна'));
  const link = asker.lore.find((f) => f.leakedFromId === original.id);
  assert.ok(link);
  assert.equal(link.text, original.text);
  assert.ok((link.tags || []).includes('informant-link'));
});
