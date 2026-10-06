import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addObjectVersion,
  activeObjects,
  createWorldObject,
  deleteWorldObject,
  findObject,
  normalizeWorldObject,
  normalizeWorldObjects,
} from '../src/world/objects.js';
import { testConfig } from './helpers/config.js';

const cfg = testConfig();

test('новый объект начинается с первой версии', () => {
  const obj = createWorldObject(cfg, {
    type: 'structure',
    name: 'Великая баллиста',
    description: 'Дальнобойная баллиста.',
    statEffect: { security: 6, prosperity: -1 },
  });
  assert.equal(obj.version, 1);
  assert.equal(obj.versions.length, 1);
  assert.equal(obj.versions[0].version, 1);
  assert.equal(obj.description, obj.versions[0].description);
});

test('новая версия становится текущим состоянием', () => {
  const obj = createWorldObject(cfg, {
    type: 'structure',
    name: 'Великая баллиста',
    statEffect: { security: 6 },
  });
  addObjectVersion(obj, {
    description: 'Баллиста на поворотной платформе.',
    statEffect: { security: 8, prosperity: -2 },
    day: 4,
  });
  assert.equal(obj.version, 2);
  assert.equal(obj.versions.length, 2);
  assert.deepEqual(obj.statEffect, obj.versions[1].statEffect);
  assert.equal(obj.description, 'Баллиста на поворотной платформе.');
});

test('неизвестный тип отбрасывается, когда конфиг известен', () => {
  assert.equal(
    normalizeWorldObject({ type: 'airship', name: 'Корабль' }, cfg),
    null,
  );
});

test('разошедшийся верхний уровень чинится по последней версии', () => {
  const [obj] = normalizeWorldObjects([
    {
      id: 'obj_ballista',
      type: 'structure',
      name: 'Баллиста',
      description: 'устаревшее описание',
      statEffect: { security: 1 },
      version: 1,
      versions: [
        { version: 1, description: 'первая', statEffect: { security: 1 }, createdDay: 0 },
        { version: 2, description: 'поворотная', statEffect: { security: 8 }, createdDay: 3 },
      ],
    },
  ]);
  assert.equal(obj.version, 2);
  assert.equal(obj.description, 'поворотная');
  assert.equal(obj.statEffect.security, 8);
});

test('удалённый объект остаётся находимым, но выпадает из живых', () => {
  const obj = createWorldObject(cfg, { type: 'site', name: 'Островок' });
  const domain = { worldObjects: [obj] };
  deleteWorldObject(obj, 9);
  assert.equal(activeObjects(domain).length, 0);
  assert.equal(findObject(domain, obj.id)?.status, 'deleted');
  assert.equal(obj.deletedDay, 9);
});
