import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  closedTestReply,
  islandDeleteCheck,
  islandNamesMatch,
  isTelegramAllowed,
  parseSlashCommand,
} from '../src/clients/telegram/access.js';
import { formatIslandPlotlines, formatIslandStats } from '../src/clients/telegram/views.js';

test('закрытый тест пускает только список, пустой список — всех', () => {
  assert.equal(isTelegramAllowed({ telegram: { allowIds: [] } }, '1'), true);
  assert.equal(isTelegramAllowed({ telegram: { allowIds: ['10', '20'] } }, '10'), true);
  assert.equal(isTelegramAllowed({ telegram: { allowIds: ['10', '20'] } }, '99'), false);
  assert.match(closedTestReply({}), /закрытый тест/);
});

test('команды с аргументом и хвостом бота', () => {
  assert.deepEqual(parseSlashCommand('/delete'), { name: 'delete', arg: '' });
  assert.deepEqual(parseSlashCommand('/delete@cloudshire_bot Талиндор'), {
    name: 'delete',
    arg: 'Талиндор',
  });
  assert.equal(parseSlashCommand('просто текст'), null);
});

test('имя острова для удаления сравнивается без регистра и лишних пробелов', () => {
  assert.equal(islandNamesMatch('Талиндор', 'талиндор'), true);
  assert.equal(islandNamesMatch('Талиндор', '  Талиндор  '), true);
  assert.equal(islandNamesMatch('Талиндор', 'Талиндорск'), false);
});

test('удаление острова требует имя и отказывается в стыке', () => {
  const domain = { name: 'Талиндор' };
  assert.equal(islandDeleteCheck({ domain: null }).reason, 'no_island');
  assert.equal(islandDeleteCheck({ domain, conflux: { status: 'approaching' } }).reason, 'conflux');
  assert.equal(islandDeleteCheck({ domain, conflux: { status: 'docked' } }).reason, 'conflux');
  assert.equal(islandDeleteCheck({ domain, conflux: null }).reason, 'need_confirm');
  assert.equal(islandDeleteCheck({ domain, conflux: null, confirmName: 'нет' }).reason, 'name_mismatch');
  assert.equal(islandDeleteCheck({ domain, conflux: null, confirmName: 'Талиндор' }).ok, true);
});

test('сводка статов и нитей читается без механики движка', () => {
  const config = {
    stats: [
      { id: 'faith', name: 'Вера' },
      { id: 'might', name: 'Мощь' },
    ],
  };
  const domain = {
    name: 'Талиндор',
    stats: { faith: 62, might: 40 },
    plotlines: [
      {
        title: 'Пустая келья',
        kind: 'story',
        synopsis: 'Иару ищут в лестницах.',
        closeWhen: 'Найдут или похоронят.',
        importance: 40,
        ageMonths: 2,
        maxAgeMonths: 6,
      },
    ],
  };
  const stats = formatIslandStats(domain, config);
  assert.match(stats, /Талиндор/);
  assert.match(stats, /Вера: 62/);
  const board = formatIslandPlotlines(domain);
  assert.match(board, /Пустая келья/);
  assert.match(board, /закроется, когда/);
});
