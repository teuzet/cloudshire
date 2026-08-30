import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createLoreFact,
  markChroniclePlotClosed,
  formatChroniclePriestMark,
  loreToPromptText,
  CHRONICLE_PLOT_CLOSED_MARK,
} from '../src/game/models.js';
import { formatFullChronicleForPrompt } from '../src/game/memory.js';

test('закрывающая хроника получает жреческую пометку', () => {
  const fact = createLoreFact({
    id: 'lore_close',
    text: 'Смещение грунта прекратилось.',
    tags: ['chronicle'],
    gameDateLabel: 'Год 1, месяц 9',
    tick: 8,
    author: 'storyteller:beat',
    importance: 'major',
    sourcePlotId: 'plot_x',
  });
  markChroniclePlotClosed(fact, { reason: 'критический успех' });
  assert.equal(fact.plotClosed, true);
  assert.equal(fact.plotCloseReason, 'критический успех');
  assert.match(formatChroniclePriestMark(fact), new RegExp(CHRONICLE_PLOT_CLOSED_MARK));
  assert.match(formatChroniclePriestMark(fact), /критический успех/);
});

test('пометка попадает в промпт хроники и не теряется при создании с полями', () => {
  const fact = createLoreFact({
    id: 'lore_close2',
    text: 'Стая ушла.',
    tags: ['chronicle'],
    gameDateLabel: 'Год 1, месяц 2',
    tick: 1,
    plotClosed: true,
    plotCloseReason: 'успех',
  });
  const prompt = loreToPromptText([fact]);
  assert.match(prompt, new RegExp(CHRONICLE_PLOT_CLOSED_MARK));
  assert.match(prompt, /успех/);
  const full = formatFullChronicleForPrompt({ lore: [fact] });
  assert.match(full, new RegExp(CHRONICLE_PLOT_CLOSED_MARK));
});

test('обычная хроника без пометки', () => {
  const fact = createLoreFact({
    id: 'lore_open',
    text: 'Дерн вспучился.',
    tags: ['chronicle'],
    gameDateLabel: 'Год 1, месяц 7',
    tick: 6,
  });
  assert.equal(formatChroniclePriestMark(fact), '');
  assert.doesNotMatch(loreToPromptText([fact]), new RegExp(CHRONICLE_PLOT_CLOSED_MARK));
});
