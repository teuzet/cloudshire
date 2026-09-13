import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const RAW_DAY = [
  /день \$\{(ctx\.day|event\.day|world\.dayIndex|dayIndex)/,
  /на \$\{(dayIndex|world\.dayIndex|ctx\.day)\}-й/,
  /`день \$\{dayIndex/,
];

test('в промптах нет голого номера игрового дня', () => {
  const dirs = [path.join(root, 'src', 'game'), path.join(root, 'config')];
  const hits = [];
  for (const dir of dirs) {
    for (const name of readdirSync(dir)) {
      if (!/\.(js|yaml)$/.test(name)) continue;
      const file = path.join(dir, name);
      const src = readFileSync(file, 'utf8');
      for (const re of RAW_DAY) {
        const m = src.match(re);
        if (m) hits.push(`${path.relative(root, file)}: ${m[0]}`);
      }
    }
  }
  assert.deepEqual(hits, []);
});
