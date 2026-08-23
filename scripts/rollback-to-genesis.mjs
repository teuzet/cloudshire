/**
 * Откат города в состояние сразу после генезиса: остаются имя, описание, правитель,
 * теги и факты генезиса. Всё, что нажил мир, снимается — хроника, нити, дела, указы,
 * каст, письма и статы (восстанавливаются по statChanges хроники, шаг за шагом назад).
 *
 * Использование:
 *   node scripts/rollback-to-genesis.mjs                  # что будет сделано (dry run)
 *   node scripts/rollback-to-genesis.mjs --yes            # применить ко всем городам
 *   node scripts/rollback-to-genesis.mjs --domain <id> --yes
 *   node scripts/rollback-to-genesis.mjs --yes --keep-dialog   # оставить переписку
 */

import { loadConfig } from '../src/config.js';
import { createStorage } from '../src/storage/index.js';
import { chronicleEntries, normalizeDomain } from '../src/game/models.js';

const args = process.argv.slice(2);
const apply = args.includes('--yes');
const keepDialog = args.includes('--keep-dialog');
const keepWorldDate = args.includes('--keep-date');
const only = (() => {
  const i = args.indexOf('--domain');
  return i >= 0 ? args[i + 1] : null;
})();

const config = loadConfig();
const storage = await createStorage(config);
const world = await storage.getWorld();
const domains = (await storage.listDomains()).filter((d) => !only || d.id === only);

if (!domains.length) {
  console.log(only ? `домен ${only} не найден` : 'городов нет');
  process.exit(0);
}

/**
 * Статы генезиса = самое раннее «from» в записях хроники.
 * Идём строго от последней записи к первой: сортировка по тику здесь не годится —
 * в одном месяце бывает несколько записей на один стат, и порядок внутри месяца важен.
 */
function rewindStats(domain) {
  const stats = { ...(domain.stats || {}) };
  const entries = chronicleEntries(domain.lore).filter((e) => e.statChanges);
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    for (const [id, change] of Object.entries(entries[i].statChanges)) {
      if (change && Number.isFinite(Number(change.from))) stats[id] = Number(change.from);
    }
  }
  return stats;
}

for (const domain of domains) {
  normalizeDomain(domain);
  const before = {
    chronicle: chronicleEntries(domain.lore).length,
    lore: (domain.lore || []).length,
    cast: (domain.lore || []).filter((f) => (f.tags || []).includes('character')).length,
    plots: (domain.plotlines || []).length,
    closed: (domain.closedPlotlines || []).length,
    processes: (domain.state?.pendingActions || []).length,
    orders: (domain.state?.modifiers || []).length,
    dialog: (domain.characters?.[0]?.dialogHistory || []).length,
    stats: { ...domain.stats },
  };

  const genesisLore = (domain.lore || []).filter((f) => (f.tags || []).includes('genesis'));
  const stats = rewindStats(domain);

  console.log(`\n${domain.name} [${domain.id}]`);
  console.log(
    `  лор: ${before.lore} → ${genesisLore.length} (хроника ${before.chronicle} → 0, каст ${before.cast} → 0)`,
  );
  console.log(`  нити: ${before.plots} открытых + ${before.closed} закрытых → 0`);
  console.log(`  дела: ${before.processes} → 0 · указы: ${before.orders} → 0`);
  console.log(`  переписка: ${before.dialog} реплик → ${keepDialog ? 'без изменений' : '1 (приветствие)'}`);
  console.log(
    '  статы: ' +
      Object.keys(stats)
        .map((id) => `${id} ${before.stats[id]}→${stats[id]}`)
        .join(', '),
  );

  if (!apply) continue;

  domain.lore = genesisLore;
  domain.plotlines = [];
  domain.closedPlotlines = [];
  domain.stats = stats;
  domain.state.pendingActions = [];
  domain.state.modifiers = [];
  domain.state.events = [];
  domain.state.monthLog = [];
  domain.state.quietPicks = [];
  domain.chronicleDigest = '';
  domain.chronicleDigestThroughTick = null;
  domain.confluxMonthsSolo = 0;
  domain.confluxMonthsDocked = 0;
  domain.confluxPartners = {};
  domain.createdTick = keepWorldDate ? domain.createdTick : 0;
  domain.lastTickAt = null;

  const ruler = domain.characters?.[0];
  if (ruler) {
    ruler.loyalty = 50;
    ruler.terror = 50;
    if (!keepDialog) {
      const greeting = (ruler.dialogHistory || []).find((m) => m.role === 'assistant');
      ruler.dialogHistory = greeting ? [greeting] : [];
    }
  }
  if (!keepDialog) domain.state.patronName = null;

  await storage.saveDomain(domain);
  console.log('  ✓ откатан');
}

if (apply && !keepWorldDate) {
  world.tickIndex = 0;
  world.gameDate = { year: 1, month: 1, label: 'Год 1, месяц 1', tick: 0 };
  world.globalEvents = [];
  await storage.saveWorld(world);
  console.log('\nмир: дата сброшена на Год 1, месяц 1');
}

if (!apply) console.log('\n(dry run: ничего не записано, добавь --yes)');
process.exit(0);
