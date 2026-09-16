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
import { overlayConfluxView } from '../src/game/confluxBoard.js';
import { attachFactToPlotlines, closePlotline, createPlotline, normalizePlotlines } from '../src/game/plotlines.js';

const story = {
  id: 'plot_cistern',
  title: 'Гул в цистерне',
  type: 'story',
  synopsis: 'Ночами в нижней цистерне гудит вода.',
  closeWhen: 'Найдут источник гула.',
  hiddenAnswer: 'Цистерну перестали чистить, ил сжимает поток.',
};

test('без фокуса лормастер видит только краткие карточки, без разгадки', () => {
  const brief = formatOpenStoriesBrief([story]);
  assert.match(brief, /plot_cistern/);
  assert.match(brief, /история/);
  assert.equal(brief.includes('Цистерну перестали чистить'), false);
  assert.equal(formatStoriesForLoremaster([story]).includes('Цистерну перестали чистить'), false);
});

test('фокус на идущей истории не выдаёт скрытую разгадку', () => {
  const focused = formatFocusedStoryForLoremaster(story, { viewerId: 'city_a' });
  assert.match(focused, /история/);
  assert.doesNotMatch(focused, /Цистерну перестали чистить/);
  assert.match(focused, /не заводят новое направление/);
  assert.equal(focused.includes('«Гул в цистерне»'), false);
});

test('скрытая разгадка не торчит в «успешном исходе» фокуса', () => {
  const focused = formatFocusedStoryForLoremaster(
    {
      id: 'plot_sap',
      type: 'story',
      synopsis: 'Из коры течёт густая тёмная смола, у смолокуров немеют пальцы.',
      closeWhen: [
        'Развилки вскрывают и очищают от насекомых и поражённой коры.',
      ],
      hiddenAnswer: 'Мелкие паразитические насекомые выходят из-под коры.',
    },
    { viewerId: 'city_a' },
  );
  assert.doesNotMatch(focused, /насеком/i);
  assert.doesNotMatch(focused, /Успешный исход/);
  assert.match(focused, /густая тёмная смола/);
});

test('resolve: открытая история с доски; контейнер пары лормастеру не виден', () => {
  const domain = {
    id: 'a',
    plotlines: [{ id: 'loc', title: 'Гул', type: 'story', synopsis: 'Гудит вода.' }],
    closedPlotlines: [{ id: 'dead', type: 'story', synopsis: 'Уже разгадали.', status: 'closed' }],
  };
  const conflux = {
    container: {
      id: 'main',
      title: 'Сопряжение',
      type: 'conflux',
      synopsis: 'Острова сближаются.',
    },
    plotlines: [],
  };
  overlayConfluxView(domain, conflux);
  const list = storiesForLoremaster(domain, conflux);
  assert.equal(list.some((p) => p.id === 'loc'), true);
  assert.equal(list.some((p) => p.id === 'main'), false);
  assert.equal(resolveLoremasterStory(domain, 'loc', conflux)?.id, 'loc');
  assert.equal(resolveLoremasterStory(domain, 'main', conflux), null);
  assert.equal(resolveLoremasterStory(domain, 'dead', conflux), null);
  assert.equal(resolveLoremasterStory(domain, 'nope', conflux), null);
  const partner = {
    id: 'b',
    plotlines: [{ id: 'theirs', title: 'Чужой колодец', type: 'story', synopsis: 'Сосед ищет воду.' }],
  };
  const both = storiesForLoremaster(domain, conflux, partner);
  assert.equal(both.some((p) => p.id === 'theirs'), true);
  assert.equal(resolveLoremasterStory(domain, 'theirs', conflux, partner)?.id, 'theirs');
});

test('факт копится на нити так же, как хроника', () => {
  const domain = { plotlines: [] };
  const plot = createPlotline({ title: 'Гул', synopsis: 'Гудит вода.', type: 'story' });
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
