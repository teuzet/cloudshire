/**
 * Снимок текущего локального города для лаборатории freeform.
 * Картинки и пулы аннотаций выкидываем — в git они не нужны.
 */
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(root, 'data');
const outDir = path.join(root, 'fixtures', 'freeform');

function loadYaml(file) {
  return yaml.load(fs.readFileSync(file, 'utf8'));
}

const domainsDir = path.join(dataDir, 'domains');
const files = fs.readdirSync(domainsDir).filter((f) => f.endsWith('.yaml'));
if (!files.length) {
  console.error('Нет data/domains/*.yaml — подними локальный город.');
  process.exit(1);
}

const domains = files.map((f) => loadYaml(path.join(domainsDir, f)));
const domain =
  domains.find((d) => String(d.ownerUserId) === '518815155') ||
  domains.find((d) => d.status === 'playing') ||
  domains[0];

const world = loadYaml(path.join(dataDir, 'world.yaml'));
delete world.mysteryAnnotationPool;
delete world.suspenseAnnotationPool;

const slim = structuredClone(domain);
slim.imageBase64 = null;
slim.imagePath = null;
slim.imageUrl = slim.imageUrl || null;
slim.imageKey = null;
for (const o of slim.officers || []) {
  o.portraitBase64 = null;
}

const snapshot = {
  frozenAt: new Date().toISOString(),
  domainId: slim.id,
  cityName: slim.name,
  world: {
    id: world.id,
    seasonKey: world.seasonKey,
    name: world.name,
    description: world.description,
    cosmology: world.cosmology,
    tickIndex: world.tickIndex,
    gameDate: world.gameDate,
    status: world.status,
    namePool: world.namePool || { free: { male: [], female: [] }, taken: [] },
  },
  domain: slim,
};

fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, 'snapshot.json');
fs.writeFileSync(out, `${JSON.stringify(snapshot, null, 2)}\n`);
console.log(`Wrote ${out} (${slim.name}, lore ${slim.lore?.length || 0})`);
