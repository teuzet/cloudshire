import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { GameApp } from '../src/game/app.js';
import { genesisTutorialText } from '../src/game/progressBar.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = yaml.load(fs.readFileSync(path.join(root, 'config/default.yaml'), 'utf8'));

test('тутор генезиса — статичный текст в конфиге', () => {
  const text = genesisTutorialText(config);
  assert.ok(text.length > 200);
  assert.match(text, /два реальных часа/);
  assert.match(text, /сопряжен/);
  assert.match(text, /лояльност/);
  assert.match(text, /ужас/);
  assert.match(text, /Дело/);
  assert.match(text, /Указ/);
  assert.match(text, /поторопить/);
  assert.match(text, /\/city/);
  assert.match(text, /информаци[яи] о городе/i);
  assert.doesNotMatch(text, /^\s*\d+\)/m);
  assert.doesNotMatch(text, /столп|сановник|казнач|воевод|маршал|хранитель|канцлер/i);
});

test('в начале генезиса тутор уходит отдельным сообщением, не правкой полоски', async () => {
  const app = new GameApp({
    config: { genesis: { tutorial: 'Пока остров поднимается.\n\nВремя одно на все города.' } },
    storage: {
      async getWorld() {
        throw new Error('stop-genesis');
      },
    },
    runtime: {},
  });
  const out = [];
  app.onOutbound(async (m) => {
    out.push(m);
  });
  app.startDomainGeneration('u1', { channel: 'web' });
  await new Promise((r) => setTimeout(r, 80));
  assert.ok(out.length >= 1);
  assert.equal(out[0].kind, 'genesis_tutorial');
  assert.equal(out[0].edit, undefined);
  assert.match(out[0].message, /Пока остров поднимается/);
  const progress = out.find((m) => m.kind === 'progress');
  assert.ok(progress);
  assert.equal(progress.edit, 'genesis');
});
