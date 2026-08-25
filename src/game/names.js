/**
 * Глобальный пул имён мира. Источник — отдельный файл config/names.yaml,
 * не игровой конфиг. При создании мира список копируется в world.namePool
 * и дальше вынимается по одному. Пустой пол мгновенно наполняется из того же файла.
 */

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { projectRoot } from '../config.js';

const DEFAULT_FILE = 'config/names.yaml';

function shuffle(list, rng = Math.random) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function cleanList(raw) {
  const seen = new Set();
  const out = [];
  for (const item of raw || []) {
    const name = String(item || '').trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

export function namesFilePath(config = null) {
  const rel = config?.namesFile || DEFAULT_FILE;
  const root = config?.__rootDir || projectRoot();
  return path.isAbsolute(rel) ? rel : path.join(root, rel);
}

export function loadNameLists(config = null) {
  const file = namesFilePath(config);
  const raw = yaml.load(fs.readFileSync(file, 'utf8')) || {};
  return {
    female: cleanList(raw.female),
    male: cleanList(raw.male),
  };
}

function emptyPool() {
  return { female: [], male: [] };
}

export function normalizeNamePool(world) {
  if (!world || typeof world !== 'object') return world;
  if (!world.namePool || typeof world.namePool !== 'object') world.namePool = emptyPool();
  world.namePool.female = cleanList(world.namePool.female);
  world.namePool.male = cleanList(world.namePool.male);
  return world;
}

/** Заполнить пул из файла, если его ещё нет (новый мир или старый сейв). */
export function seedWorldNamePool(world, config = null, rng = Math.random) {
  if (!world || typeof world !== 'object') return world;
  const has =
    Array.isArray(world.namePool?.female) &&
    world.namePool.female.length + (world.namePool.male?.length || 0) > 0;
  if (has) {
    normalizeNamePool(world);
    return world;
  }
  const lists = loadNameLists(config);
  world.namePool = {
    female: shuffle(lists.female, rng),
    male: shuffle(lists.male, rng),
  };
  return world;
}

function bucket(gender) {
  return gender === 'female' ? 'female' : 'male';
}

/** Пустой пол — сразу новая колода из того же файла. Дубликаты с уже живущими именами допустимы. */
function refillBucket(world, key, config, rng = Math.random) {
  const lists = loadNameLists(config);
  const source = lists[key]?.length ? lists[key] : lists.female;
  world.namePool[key] = shuffle(source, rng);
}

function ensureBucket(world, key, config, rng = Math.random) {
  seedWorldNamePool(world, config, rng);
  if (!Array.isArray(world.namePool[key])) world.namePool[key] = [];
  if (!world.namePool[key].length) refillBucket(world, key, config, rng);
}

export function takeName(world, gender, config = null) {
  const key = bucket(gender);
  ensureBucket(world, key, config);
  return world.namePool[key].shift() || (key === 'female' ? 'Айра' : 'Кален');
}

/** Несколько имён на бит: агент берёт только отсюда. Из пула ещё не вынимаем. */
export function offerNames(world, { female = 4, male = 4 } = {}, config = null) {
  ensureBucket(world, 'female', config);
  ensureBucket(world, 'male', config);
  return {
    female: world.namePool.female.slice(0, Math.max(0, female)),
    male: world.namePool.male.slice(0, Math.max(0, male)),
  };
}

export function formatOfferedNamesForPrompt(offered) {
  if (!offered) return '';
  const f = (offered.female || []).join(', ') || '—';
  const m = (offered.male || []).join(', ') || '—';
  return [
    'ИМЕНА НА ЭТОТ БИТ (бери только отсюда, каждое не больше одного раза):',
    `женщины: ${f}`,
    `мужчины: ${m}`,
    'Своих имён не выдумывай. Назвал человека — обязан внести его в newCharacters с этим именем.',
  ].join('\n');
}

function consumeExact(world, name) {
  const needle = String(name || '').trim().toLowerCase();
  if (!needle) return false;
  for (const key of ['female', 'male']) {
    const i = (world.namePool?.[key] || []).findIndex((n) => String(n).toLowerCase() === needle);
    if (i >= 0) {
      world.namePool[key].splice(i, 1);
      return true;
    }
  }
  return false;
}

/**
 * Выдать канонические имена из пула. Если агент взял предложенное — вынимаем его.
 * Чужое имя заменяем и правим текст записи.
 */
export function bindCharacterNames(world, list, { offered = null, texts = [], config = null } = {}) {
  seedWorldNamePool(world, config);
  const offeredSet = new Set(
    [...(offered?.female || []), ...(offered?.male || [])].map((n) => String(n).toLowerCase()),
  );
  const replacements = [];
  for (const person of list || []) {
    if (!person || typeof person !== 'object') continue;
    const gender = person.gender === 'female' ? 'female' : 'male';
    const asked = String(person.name || '').trim();
    const askedKey = asked.toLowerCase();
    let next = asked;
    if (asked && offeredSet.has(askedKey) && consumeExact(world, asked)) {
      next = asked;
    } else {
      next = takeName(world, gender, config);
      if (asked && askedKey !== next.toLowerCase()) {
        replacements.push({ from: asked, to: next });
      }
    }
    person.name = next;
    offeredSet.delete(String(next).toLowerCase());
  }
  const patched = (texts || []).map((text) => {
    let out = String(text || '');
    for (const { from, to } of replacements) {
      if (!from || from === to) continue;
      out = out.split(from).join(to);
    }
    return out;
  });
  return { list, replacements, texts: patched };
}
