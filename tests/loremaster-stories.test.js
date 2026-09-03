import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatOpenStoriesBrief,
  formatFocusedStoryForLoremaster,
  formatStoriesForLoremaster,
  storiesForLoremaster,
  resolveLoremasterStory,
  cityTextForLoremaster,
} from '../src/game/loremaster.js';
import { attachFactToPlotlines, closePlotline, createPlotline, normalizePlotlines } from '../src/game/plotlines.js';

const mystery = {
  id: 'plot_cistern',
  title: 'Гул в цистерне',
  kind: 'story',
  storyType: 'mystery',
  synopsis: 'Ночами в нижней цистерне гудит вода.',
  closeWhen: 'Найдут источник гула.',
  truthGraph: {
    nodes: [
      { id: 'A', text: 'Цистерну перестали чистить.', knowledge: 'hidden' },
      { id: 'X', text: 'Ночами вода гудит.', knowledge: 'observed' },
    ],
    edges: [{ from: 'A', to: 'X', reason: 'ил сжимает поток', knowledge: 'hidden' }],
  },
};

test('без фокуса лормастер видит только краткие карточки, без канона тайны', () => {
  const brief = formatOpenStoriesBrief([mystery]);
  assert.match(brief, /plot_cistern/);
  assert.match(brief, /тайна/);
  assert.equal(brief.includes('Цистерну перестали чистить'), false);
  assert.equal(formatStoriesForLoremaster([mystery]).includes('Цистерну перестали чистить'), false);
});

test('фокус на идущей тайне даёт канон и запрет его раскрывать', () => {
  const focused = formatFocusedStoryForLoremaster(mystery, { viewerId: 'city_a' });
  assert.match(focused, /ТАЙНА/);
  assert.match(focused, /Цистерну перестали чистить/);
  assert.match(focused, /скрыто/i);
  assert.match(focused, /не заводят новое направление/);
  assert.equal(focused.includes('«Гул в цистерне»'), false);
});

test('фокус на саспенсе показывает hiddenPremises целиком, только как скрытые', () => {
  const text = formatFocusedStoryForLoremaster(
    {
      id: 'plot_shaft',
      kind: 'story',
      storyType: 'suspense',
      synopsis: 'В шахте тянет холодом.',
      hiddenPremises: ['Холод идёт через древнюю шахту к нижней стороне острова.'],
      discoveryLadder: [{ id: 'r1', promise: 'Найти, откуда тянет', revealed: false }],
    },
    { viewerId: 'city_a' },
  );
  assert.match(text, /древнюю шахту/);
  assert.match(text, /СКРЫТО/);
  assert.match(text, /не в fact/);
});

test('resolve: только открытая история с доски или видимая с конфлюкса', () => {
  const domain = {
    id: 'a',
    plotlines: [
      { id: 'ord', title: 'Налог', kind: 'order', synopsis: 'Собирают налог.' },
      { id: 'loc', title: 'Гул', kind: 'story', synopsis: 'Гудит вода.' },
    ],
    closedPlotlines: [{ id: 'dead', kind: 'story', synopsis: 'Уже разгадали.', status: 'closed' }],
  };
  const conflux = {
    plotlines: [
      {
        id: 'main',
        title: 'Сопряжение',
        kind: 'story',
        isMainConflux: true,
        synopsis: 'Острова сближаются.',
      },
    ],
  };
  const list = storiesForLoremaster(domain, conflux);
  assert.equal(list.some((p) => p.id === 'ord'), false);
  assert.equal(list.some((p) => p.id === 'loc'), true);
  assert.equal(list.some((p) => p.id === 'main'), true);
  assert.equal(resolveLoremasterStory(domain, 'loc', conflux)?.id, 'loc');
  assert.equal(resolveLoremasterStory(domain, 'main', conflux)?.id, 'main');
  assert.equal(resolveLoremasterStory(domain, 'ord', conflux), null);
  assert.equal(resolveLoremasterStory(domain, 'dead', conflux), null);
  assert.equal(resolveLoremasterStory(domain, 'nope', conflux), null);
});

test('факт копится на нити так же, как хроника', () => {
  const domain = { plotlines: [] };
  const plot = createPlotline({ title: 'Гул', synopsis: 'Гудит вода.' });
  domain.plotlines.push(plot);
  normalizePlotlines(domain);
  attachFactToPlotlines(domain, 'lore_fact_1', [plot.id]);
  assert.deepEqual(findOpen(domain, plot.id).factIds, ['lore_fact_1']);
  closePlotline(domain, plot.id, { tick: 3, reason: 'Нашли ил.' });
  const closed = (domain.closedPlotlines || []).find((p) => p.id === plot.id);
  assert.deepEqual(closed.factIds, ['lore_fact_1']);
});

test('лормастер читает бриф города, а не обрезку генезиса с головы', () => {
  const domain = {
    cityBrief: 'Налог зерном, углём или трудом; учёт ведут писцы на глиняных табличках.',
    description: `## Общий облик\n${'хребет '.repeat(400)}\n## Власть и закон\nЭтого абзаца в обрезке с головы не было бы.`,
  };
  const text = cityTextForLoremaster(domain);
  assert.match(text, /глиняных табличках/);
  assert.equal(text.includes('Этого абзаца'), false);
});

test('лормастер видит блок канонических неизвестностей в брифе', () => {
  const domain = {
    cityBrief:
      'Город у Праотца.\n\nНеизвестно (канон):\n- источник набегов чудовищ официально не установлен',
    description: 'Длинный генезис про плато и догадки.',
  };
  const text = cityTextForLoremaster(domain);
  assert.match(text, /Неизвестно \(канон\)/);
  assert.match(text, /источник набегов чудовищ официально не установлен/);
  assert.equal(text.includes('Длинный генезис'), false);
});

function findOpen(domain, id) {
  return (domain.plotlines || []).find((p) => p.id === id);
}
