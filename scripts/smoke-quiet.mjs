/**
 * Смоук тихих месяцев: несколько подряд на копии живого домена.
 * Ничего не сохраняет — только печатает записи, дрифт и повторы тем.
 *   node scripts/smoke-quiet.mjs [userId] [сколько]
 */
import { loadConfig } from '../src/config.js';
import { createStorage } from '../src/storage/index.js';
import { AgentRuntime } from '../src/agents/runtime.js';
import { normalizeDomain } from '../src/game/models.js';
import { quietMonth } from '../src/game/storyteller.js';
import { createStatBudget } from '../src/game/plotEngine.js';
import { initLogger } from '../src/log.js';

const config = loadConfig();
initLogger({ ...config, logging: { ...config.logging, level: process.env.SMOKE_LOG || 'warn', file: false } });
const storage = await createStorage(config);
const runtime = new AgentRuntime(config);
const world = await storage.getWorld();
const userId = process.argv[2] || 'local-user';
const rounds = Number(process.argv[3] || 5);

const source = await storage.getDomainForUser(userId, world.id);
if (!source) throw new Error(`нет домена у ${userId}`);
const domain = structuredClone(source);
normalizeDomain(domain);

console.log(`город: ${domain.name}`);
console.log('статы до:', JSON.stringify(domain.stats));

for (let i = 0; i < rounds; i += 1) {
  const budget = createStatBudget(config);
  const fakeWorld = {
    ...world,
    tickIndex: (world.tickIndex || 0) + i,
    gameDate: { ...world.gameDate, label: `Год 1, месяц ${(world.gameDate.month || 1) + i}` },
  };
  const result = await quietMonth({ config, runtime, domain, world: fakeWorld, budget });
  const changes = result?.fact?.statChanges
    ? Object.entries(result.fact.statChanges)
        .map(([k, v]) => `${k} ${v.from}→${v.to}`)
        .join(', ')
    : 'без сдвига';
  console.log(`\n[${i + 1}] ${changes}`);
  console.log(result?.fact?.text || '(пусто)');
}

console.log('\nстаты после:', JSON.stringify(domain.stats));
console.log('темы:', (domain.state.quietPicks || []).map((p) => p.topic).join(' → '));
console.log('каст:', (domain.lore || []).filter((f) => (f.tags || []).includes('character')).map((c) => c.name).join(', ') || '—');
process.exit(0);
