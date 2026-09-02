import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import {
  closedTestReply,
  islandDeleteCheck,
  islandNamesMatch,
  isTelegramAllowed,
  isTelegramForceTickAllowed,
  isForceTickCommand,
  parseSlashCommand,
} from '../src/clients/telegram/access.js';
import { formatIslandPlotlines, formatIslandStats } from '../src/clients/telegram/views.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = yaml.load(fs.readFileSync(path.join(root, 'config/default.yaml'), 'utf8'));

test('в меню бота только /city — информация о городе', () => {
  const commands = config.telegram.commands.map((c) => c.command);
  assert.deepEqual(commands, ['city']);
  assert.match(config.telegram.commands[0].description, /информация о городе/i);
});

test('закрытый тест пускает только список, пустой список — всех', () => {
  assert.equal(isTelegramAllowed({ telegram: { allowIds: [] } }, '1'), true);
  assert.equal(isTelegramAllowed({ telegram: { allowIds: ['10', '20'] } }, '10'), true);
  assert.equal(isTelegramAllowed({ telegram: { allowIds: ['10', '20'] } }, '99'), false);
  assert.match(closedTestReply({}), /закрытый тест/);
});

test('forcetick только из своего списка, пустой список — никому', () => {
  const cfg = { telegram: { forceTickIds: ['518815155'] } };
  assert.equal(isTelegramForceTickAllowed(cfg, '518815155'), true);
  assert.equal(isTelegramForceTickAllowed(cfg, '99'), false);
  assert.equal(isTelegramForceTickAllowed({ telegram: { forceTickIds: [] } }, '518815155'), false);
  assert.equal(isForceTickCommand({ name: 'forcetick' }), true);
  assert.equal(isForceTickCommand({ name: 'force_tick' }), true);
  assert.equal(isForceTickCommand({ name: 'stats' }), false);
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
      { id: 'knowledge', name: 'Знание' },
      { id: 'security', name: 'Безопасность' },
    ],
  };
  const domain = {
    name: 'Талиндор',
    stats: { knowledge: 62, security: 40 },
    plotlines: [
      {
        title: 'Пустая келья',
        kind: 'story',
        synopsis: 'Иару ищут в лестницах.',
        closeWhen: 'Найдут или похоронят.',
        ageMonths: 2,
        maxAgeMonths: 6,
      },
    ],
  };
  const stats = formatIslandStats(domain, config);
  assert.match(stats, /Талиндор/);
  assert.match(stats, /Знание: 62/);
  const board = formatIslandPlotlines(domain);
  assert.match(board, /Пустая келья/);
  assert.match(board, /закроется, когда/);
});
