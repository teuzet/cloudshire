import { test } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import {
  r2Settings,
  r2Enabled,
  islandObjectKey,
  officerObjectKey,
  r2PublicUrl,
  domainHasIslandImage,
  officerHasPortrait,
  putR2Object,
  deleteR2Object,
} from '../src/storage/r2.js';
import { stripOfficerPortraitPayload } from '../src/game/officers.js';

dotenv.config();

const live = r2Settings();

const R2_ENV = [
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_BUCKET',
  'R2_PUBLIC_BASE_URL',
];

function withClearedR2(fn) {
  const prev = Object.fromEntries(R2_ENV.map((k) => [k, process.env[k]]));
  for (const k of R2_ENV) delete process.env[k];
  try {
    return fn();
  } finally {
    for (const k of R2_ENV) {
      if (prev[k] == null) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

test('ключи объектов и публичный URL', () => {
  assert.equal(islandObjectKey('dom_1'), 'islands/dom_1.png');
  assert.equal(officerObjectKey('dom_1', 'keeper'), 'officers/dom_1_keeper.png');
  assert.equal(
    r2PublicUrl({ publicBaseUrl: 'https://pub-test.r2.dev' }, 'islands/dom_1.png'),
    'https://pub-test.r2.dev/islands/dom_1.png',
  );
});

test('без env R2 выключен', () => {
  withClearedR2(() => {
    assert.equal(r2Enabled(), false);
    assert.equal(r2Settings(), null);
  });
});

test('картина есть, если есть публичный URL', () => {
  assert.equal(domainHasIslandImage({ imageUrl: 'https://x/a.png' }), true);
  assert.equal(domainHasIslandImage({}), false);
  assert.equal(officerHasPortrait({ portraitUrl: 'https://x/p.png' }), true);
});

test('strip убирает base64, когда есть URL', () => {
  const domain = {
    imageUrl: 'https://pub.example/islands/a.png',
    imageBase64: 'AAAA',
    officers: [{ portraitUrl: 'https://pub.example/p.png', portraitBase64: 'BBBB' }],
  };
  stripOfficerPortraitPayload(domain);
  assert.equal(domain.imageBase64, null);
  assert.equal(domain.officers[0].portraitBase64, null);
});

test('живой PUT/GET/DELETE в бакет', { skip: !live }, async () => {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  const key = '_health/cloudshire-r2-ping.png';
  const url = await putR2Object(null, { key, buffer: png });
  try {
    const res = await fetch(url);
    assert.equal(res.status, 200, await res.text().then((t) => t.slice(0, 120)));
  } finally {
    await deleteR2Object(null, key);
  }
});
