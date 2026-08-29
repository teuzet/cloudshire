#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';

const src = process.argv[2] || 'cloudshire_mystery_starting_pool_curated_worldrelation_fixed.md';
const dest = process.argv[3] || 'config/mystery-annotation-pool.json';
const md = readFileSync(src, 'utf8').replace(/\r\n/g, '\n');

const HEADER = /^(Наблюдаемое|Истина|Почему не очевидно|Если разгадана|Если не разгадана)\s*:?\s*$/i;
const map = {
  наблюдаемое: 'observed',
  истина: 'truth',
  'почему не очевидно': 'hiddenness',
  'если разгадана': 'ifSolved',
  'если не разгадана': 'ifUnsolved',
};

function parseAxes(block) {
  const axes = {};
  for (const line of String(block || '').split('\n')) {
    const m = line.match(/^([A-Za-z]+):\s*(.+)$/);
    if (!m) continue;
    const key = m[1].trim();
    let val = m[2].trim();
    if (key === 'gravity') val = Number(val);
    axes[key] = val;
  }
  return axes;
}

function parseBody(body) {
  const out = {};
  let current = null;
  const buf = [];
  const flush = () => {
    if (!current) return;
    out[current] = buf.join('\n').trim();
    buf.length = 0;
  };
  for (const line of body.split('\n')) {
    const m = line.trim().match(HEADER);
    if (m) {
      flush();
      current = map[m[1].toLowerCase()];
      continue;
    }
    if (current) buf.push(line);
  }
  flush();
  return out;
}

const chunks = md.split(/^## \d+\.\s+/m).slice(1);
const cards = [];
for (const chunk of chunks) {
  const nl = chunk.indexOf('\n');
  const title = chunk.slice(0, nl).trim();
  const rest = chunk.slice(nl + 1);
  const yamlMatch = rest.match(/```yaml\n([\s\S]*?)```/);
  if (!yamlMatch) throw new Error(`no yaml for ${title}`);
  const axes = parseAxes(yamlMatch[1]);
  const sections = parseBody(rest.slice(rest.indexOf('```', yamlMatch.index + 6) + 3));
  for (const key of ['observed', 'truth', 'hiddenness', 'ifSolved', 'ifUnsolved']) {
    if (!sections[key]) throw new Error(`missing ${key} in ${title}`);
  }
  const slug = title
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9]+/gi, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  const hash = createHash('sha1').update(title).digest('hex').slice(0, 8);
  cards.push({
    id: `ann_${hash}_${slug}`.replace(/-+/g, '-').slice(0, 56),
    kind: 'mystery',
    source: 'starter',
    title,
    axes,
    ...sections,
  });
}

writeFileSync(dest, `${JSON.stringify({ version: 1, kind: 'mystery', cards }, null, 2)}\n`);
console.log(`wrote ${cards.length} cards → ${dest}`);
