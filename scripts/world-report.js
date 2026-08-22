#!/usr/bin/env node
/**
 * Диагностика живого мира: состояние городов, вовлечённость игроков, здоровье
 * процессов/плотлайнов/конфлюксов и расход токенов.
 *
 *   npm run report
 *   npm run report -- --domain domain_abc123
 *   npm run report -- --json
 *
 * Читает то же хранилище, что и сервер (STORAGE_DRIVER / MONGODB_URI из .env).
 */

import { loadConfig } from '../src/config.js';
import { createStorage } from '../src/storage/index.js';
import { plotConfig, plotlineAge, isOverdue } from '../src/game/plotlines.js';
import { activeProcesses } from '../src/game/processes.js';

const GOOD = 'OK  ';
const WARN = 'WARN';
const BAD = 'BAD ';

function parseArgs(argv) {
  const out = { domain: null, json: false, help: false, dialogTail: 0 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--domain') out.domain = argv[++i];
    else if (a === '--json') out.json = true;
    else if (a === '--dialog') out.dialogTail = Math.max(1, Number(argv[++i]) || 6);
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function hoursSince(iso) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return (Date.now() - t) / 3600000;
}

function fmtHours(h) {
  if (h == null) return 'никогда';
  if (h < 1) return `${Math.round(h * 60)} мин назад`;
  if (h < 48) return `${h.toFixed(1)} ч назад`;
  return `${(h / 24).toFixed(1)} дн назад`;
}

function fmtNum(n) {
  return String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Сколько tick_news подряд остались без ответа игрока. */
function unansweredNewsStreak(history = []) {
  let n = 0;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const m = history[i];
    if (m.role === 'user') break;
    if (m.role === 'assistant' && m.kind === 'tick_news') n += 1;
  }
  return n;
}

function chronicleFacts(lore = []) {
  return lore.filter((f) => (f.tags || []).includes('chronicle'));
}

/** Похожие записи хроники — признак «мир повторяется». */
function findNearDuplicates(entries, { minLen = 40, sampleLen = 90 } = {}) {
  const seen = new Map();
  const dupes = [];
  for (const e of entries) {
    const text = String(e.text || '');
    if (text.length < minLen) continue;
    const key = text
      .toLowerCase()
      .replace(/[^\p{L}\p{N} ]+/gu, '')
      .split(/\s+/)
      .slice(0, 12)
      .join(' ');
    if (seen.has(key)) {
      dupes.push({
        a: seen.get(key),
        b: e.gameDateLabel || `tick ${e.tick}`,
        preview: text.slice(0, sampleLen),
      });
    } else {
      seen.set(key, e.gameDateLabel || `tick ${e.tick}`);
    }
  }
  return dupes;
}

function statSummary(stats = {}, config) {
  const defs = config.stats || [];
  const rows = defs
    .map((d) => ({ id: d.id, name: d.name, value: Number(stats[d.id]) }))
    .filter((r) => Number.isFinite(r.value));
  const extras = Object.keys(stats)
    .filter((k) => !defs.some((d) => d.id === k))
    .map((k) => ({ id: k, name: k, value: Number(stats[k]) }))
    .filter((r) => Number.isFinite(r.value));
  return [...rows, ...extras];
}

/** Накопленный сдвиг статов из хроники (сумма statChanges). */
function statDrift(lore = []) {
  const drift = {};
  for (const f of lore) {
    const ch = f.statChanges;
    if (!ch || typeof ch !== 'object') continue;
    for (const [k, v] of Object.entries(ch)) {
      const from = Number(v?.from);
      const to = Number(v?.to);
      if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
      drift[k] = (drift[k] || 0) + (to - from);
    }
  }
  return drift;
}

function analyzeDomain({ domain, config, world, confluxes, usageByDomain }) {
  const flags = [];
  const tick = world.tickIndex || 0;
  const plotCfg = plotConfig(config);
  const ruler = domain.characters?.[0] || null;
  const history = ruler?.dialogHistory || [];
  const userMsgs = history.filter((m) => m.role === 'user');
  const lastUser = userMsgs[userMsgs.length - 1] || null;
  const lastAny = history[history.length - 1] || null;
  const ageMonths = tick - Number(domain.createdTick || 0);

  const chron = chronicleFacts(domain.lore || []);
  const dupes = findNearDuplicates(chron);
  const drift = statDrift(domain.lore || []);
  const stats = statSummary(domain.stats, config);
  const lowStats = stats.filter((s) => s.value <= 20);
  const highStats = stats.filter((s) => s.value >= 85);

  const processes = activeProcesses(domain, config);
  const procName = (p) => p.summary || p.title || p.id;
  const overdue = processes.filter((p) => Number(p.monthsLeft) === 0);
  const longRunning = processes.filter((p) => Number(p.monthsDone) >= 8);

  const plots = domain.plotlines || [];
  const hotPlots = plots.filter((p) => Number(p.temperature) >= 70);
  // Нить пережила отпущенный ей срок — движок обязан её закрыть битом-финалом.
  const stalePlots = plots.filter((p) => isOverdue(p));
  const errands = plots.filter((p) => p.kind === 'errand');
  const boardOverflow = plots.length > (plotCfg.board?.maxOpen ?? 5);

  const myConfluxes = confluxes.filter((c) => (c.domainIds || []).includes(domain.id));
  const active = myConfluxes.find((c) => c.status === 'approaching' || c.status === 'docked');
  const solo = Number(domain.confluxMonthsSolo || 0);
  const docked = Number(domain.confluxMonthsDocked || 0);
  const lifeTotal = solo + docked;
  const dockedPct = lifeTotal ? (docked / lifeTotal) * 100 : 0;
  const partners = Object.keys(domain.confluxPartners || {}).length;

  const unanswered = unansweredNewsStreak(history);
  const hoursSinceUser = hoursSince(lastUser?.at);
  const usage = usageByDomain.get(domain.id) || { runs: 0, tokens: 0, costUsd: 0 };

  // Что правитель заявлял в submit_reply: приказы против реальных действий.
  const turns = history.filter((m) => m.role === 'assistant' && m.meta?.commitment);
  const commitments = {};
  let orders = 0;
  let ordersHonored = 0;
  let impossible = 0;
  let impossibleHeld = 0;
  for (const m of turns) {
    const c = m.meta.commitment;
    commitments[c] = (commitments[c] || 0) + 1;
    if (m.meta.requestKind === 'order_long' || m.meta.requestKind === 'order_instant') {
      orders += 1;
      if (c !== 'none') ordersHonored += 1;
    }
    if (m.meta.requestKind === 'order_impossible') {
      impossible += 1;
      if (c === 'refused') impossibleHeld += 1;
    }
  }
  if (orders && ordersHonored < orders) {
    flags.push([WARN, `приказов ${orders}, из них без действия ${orders - ordersHonored}`]);
  }
  if (impossible) {
    flags.push([
      impossibleHeld === impossible ? GOOD : BAD,
      `приказов вне законов мира ${impossible}, канон устоял ${impossibleHeld}`,
    ]);
  }
  const retiredFacts = (domain.lore || []).filter((f) => f.retiredAt).length;

  // Новые рельсы: кто пишет хронику и как живут нити.
  const byAuthor = {};
  for (const f of chron) {
    const a = String(f.author || '?').replace(/^storyteller:/, '');
    byAuthor[a] = (byAuthor[a] || 0) + 1;
  }
  const castSize = (domain.lore || []).filter(
    (f) => (f.tags || []).includes('character') && !f.retiredAt,
  ).length;
  const closed = domain.closedPlotlines || [];
  const beatsTotal = plots.reduce((sum, p) => sum + (p.beatCount || 0), 0);
  if (byAuthor['month-fallback']) {
    flags.push([WARN, `движок дописывал за рассказчика ${byAuthor['month-fallback']} раз`]);
  }
  if (chron.length && (byAuthor.quiet || 0) / chron.length > 0.6 && ageMonths >= 4) {
    flags.push([WARN, 'больше половины записей — тихие месяцы: сюжет не заводится']);
  }

  // --- Вовлечённость
  if (!userMsgs.length) {
    flags.push([BAD, 'игрок не написал ни одного сообщения — город живёт без покровителя']);
  } else if (unanswered >= 4) {
    flags.push([BAD, `${unanswered} писем месяца подряд без ответа — игрок, похоже, отвалился`]);
  } else if (unanswered >= 2) {
    flags.push([WARN, `${unanswered} письма без ответа — вовлечённость падает`]);
  } else {
    flags.push([GOOD, `игрок в контакте (${userMsgs.length} сообщений)`]);
  }
  if (hoursSinceUser != null && hoursSinceUser > 72 && userMsgs.length) {
    flags.push([WARN, `последнее сообщение игрока ${fmtHours(hoursSinceUser)}`]);
  }

  // --- Статы
  if (lowStats.length) {
    flags.push([
      BAD,
      `критично низкие статы: ${lowStats.map((s) => `${s.name} ${s.value}`).join(', ')}`,
    ]);
  }
  if (highStats.length) {
    flags.push([
      GOOD,
      `сильные стороны: ${highStats.map((s) => `${s.name} ${s.value}`).join(', ')}`,
    ]);
  }
  const totalDrift = Object.values(drift).reduce((a, b) => a + b, 0);
  if (ageMonths >= 4 && Math.abs(totalDrift) <= 2) {
    flags.push([WARN, `статы почти не двигались за ${ageMonths} мес (сумма сдвигов ${totalDrift}) — мир статичен`]);
  }

  // --- Процессы
  if (overdue.length) {
    flags.push([
      BAD,
      `процессы просрочены (monthsLeft=0, но active): ${overdue.map(procName).join('; ')}`,
    ]);
  }
  if (longRunning.length) {
    flags.push([WARN, `процессы тянутся 8+ мес: ${longRunning.map(procName).join('; ')}`]);
  }
  const maxProc = config.tick?.maxActiveProcesses ?? 4;
  if (processes.length === 0 && ageMonths >= 3) {
    flags.push([WARN, 'нет активных процессов — правитель ничего не делает вдолгую']);
  }
  if (processes.length > maxProc) {
    flags.push([BAD, `активных процессов ${processes.length} > лимита ${maxProc}`]);
  }

  // --- Плотлайны
  if (!plots.length && ageMonths >= 3) {
    flags.push([WARN, 'нет открытых плотлайнов — нет сюжетного напряжения']);
  }
  if (boardOverflow) {
    flags.push([BAD, `нитей ${plots.length} > доски ${plotCfg.board?.maxOpen}`]);
  }
  if (errands.length > (plotCfg.board?.maxErrands ?? 2)) {
    flags.push([WARN, `проходных нитей ${errands.length} — доска забита делами`]);
  }
  if (stalePlots.length) {
    flags.push([
      WARN,
      `нити пережили свой срок (нужен финальный бит): ${stalePlots
        .map((p) => `«${p.title}» ${p.ageMonths}/${p.maxAgeMonths}`)
        .join('; ')}`,
    ]);
  }
  if (hotPlots.length) {
    flags.push([
      GOOD,
      `горячие линии: ${hotPlots.map((p) => `«${p.title}» T=${p.temperature}`).join('; ')}`,
    ]);
  }

  // --- Хроника
  const chronPerMonth = ageMonths > 0 ? chron.length / ageMonths : chron.length;
  if (chron.length === 0) {
    flags.push([BAD, 'пустая хроника']);
  } else if (chronPerMonth < 1 && ageMonths >= 3) {
    flags.push([WARN, `хроника редкая: ${chronPerMonth.toFixed(1)} записей/мес`]);
  }
  if (dupes.length) {
    flags.push([
      WARN,
      `похожие записи хроники (${dupes.length}), напр.: «${dupes[0].preview}…» (${dupes[0].a} / ${dupes[0].b})`,
    ]);
  }

  // --- Conflux
  if (ageMonths >= (config.tick?.conflux?.minDomainAgeMonths ?? 6) && !partners && !active) {
    flags.push([WARN, `${ageMonths} мес без конфлюкса и без активного матча`]);
  }
  if (lifeTotal >= 6) {
    const target = (config.tick?.conflux?.targetDockedFraction ?? 0.5) * 100;
    if (Math.abs(dockedPct - target) > 25) {
      flags.push([
        WARN,
        `доля времени в конфлюксе ${dockedPct.toFixed(0)}% против цели ${target.toFixed(0)}%`,
      ]);
    } else {
      flags.push([GOOD, `баланс соло/конфлюкс ${dockedPct.toFixed(0)}% docked`]);
    }
  }

  return {
    id: domain.id,
    name: domain.name,
    status: domain.status,
    channel: domain.channel,
    ownerUserId: domain.ownerUserId,
    ageMonths,
    population: domain.population,
    ruler: ruler
      ? { name: ruler.name, loyalty: ruler.loyalty, terror: ruler.terror }
      : null,
    stats,
    drift,
    engagement: {
      userMessages: userMsgs.length,
      totalMessages: history.length,
      unansweredNews: unanswered,
      lastUserAt: lastUser?.at || null,
      lastAnyAt: lastAny?.at || null,
    },
    story: {
      plots: plots.length,
      errands: errands.length,
      beatsTotal,
      closed: closed.length,
      closeReasons: closed.slice(-6).map((c) => `${c.title}: ${c.reason}`),
      castSize,
      byAuthor,
    },
    turnMeta: {
      turns: turns.length,
      orders,
      ordersHonored,
      impossible,
      impossibleHeld,
      commitments,
    },
    retiredFacts,
    processes: processes.map((p) => ({
      title: procName(p),
      monthsDone: p.monthsDone,
      monthsLeft: p.monthsLeft,
      expectedMonths: p.expectedMonths,
      hardDeadline: Boolean(p.hardDeadline),
    })),
    plotlines: plots.map((p) => ({
      title: p.title,
      temperature: p.temperature,
      importance: p.importance,
      kind: p.kind,
      age: plotlineAge(p),
      maxAge: p.maxAgeMonths,
    })),
    chronicle: { count: chron.length, perMonth: Number(chronPerMonth.toFixed(2)), duplicates: dupes.length },
    conflux: {
      monthsSolo: solo,
      monthsDocked: docked,
      dockedPct: Number(dockedPct.toFixed(1)),
      partners,
      active: active ? { id: active.id, status: active.status, rematch: Boolean(active.rematch) } : null,
      history: myConfluxes.length,
    },
    usage,
    flags,
  };
}

function printDomain(rep, { dialogTail = 0, dialog = [] } = {}) {
  const line = '─'.repeat(72);
  console.log(`\n${line}`);
  console.log(
    `${rep.name}  [${rep.id}]  ${rep.channel || '?'}  owner=${rep.ownerUserId || '?'}`,
  );
  console.log(
    `возраст ${rep.ageMonths} мес · население ${fmtNum(rep.population)} · статус ${rep.status}`,
  );
  if (rep.ruler) {
    console.log(
      `правитель ${rep.ruler.name} · лояльность ${rep.ruler.loyalty} · ужас ${rep.ruler.terror}`,
    );
  }
  console.log(line);

  console.log(
    'статы: ' +
      rep.stats
        .map((s) => {
          const d = rep.drift[s.id];
          const dd = d ? ` (${d > 0 ? '+' : ''}${d})` : '';
          return `${s.name} ${s.value}${dd}`;
        })
        .join(' · '),
  );

  const e = rep.engagement;
  console.log(
    `игрок: ${e.userMessages} сообщений / ${e.totalMessages} всего · ` +
      `без ответа писем: ${e.unansweredNews} · последнее ${fmtHours(hoursSince(e.lastUserAt))}`,
  );

  console.log(
    `хроника: ${rep.chronicle.count} записей (${rep.chronicle.perMonth}/мес)` +
      (rep.chronicle.duplicates ? ` · похожих ${rep.chronicle.duplicates}` : '') +
      (rep.retiredFacts ? ` · снятых фактов ${rep.retiredFacts}` : ''),
  );

  if (rep.story) {
    const authors = Object.entries(rep.story.byAuthor)
      .map(([k, v]) => `${k} ${v}`)
      .join(', ');
    console.log(
      `сюжет: нитей ${rep.story.plots} (проходных ${rep.story.errands}) · битов всего ${rep.story.beatsTotal} · ` +
        `закрыто ${rep.story.closed} · каст ${rep.story.castSize}` +
        (authors ? ` · записи: ${authors}` : ''),
    );
    for (const r of rep.story.closeReasons) console.log(`    закрыта — ${r}`);
  }

  if (rep.turnMeta.turns) {
    const parts = Object.entries(rep.turnMeta.commitments)
      .map(([k, v]) => `${k} ${v}`)
      .join(', ');
    console.log(
      `ходы правителя: ${rep.turnMeta.turns} (${parts}) · приказов ${rep.turnMeta.orders}, ` +
        `с действием ${rep.turnMeta.ordersHonored}` +
        (rep.turnMeta.impossible
          ? ` · невозможных ${rep.turnMeta.impossible}, отбито ${rep.turnMeta.impossibleHeld}`
          : ''),
    );
  }

  if (rep.processes.length) {
    console.log('процессы:');
    for (const p of rep.processes) {
      console.log(`  • ${p.title} — ${p.monthsDone}/${p.expectedMonths} мес (осталось ${p.monthsLeft})`);
    }
  } else {
    console.log('процессы: нет');
  }

  if (rep.plotlines.length) {
    console.log('плотлайны:');
    for (const p of rep.plotlines) {
      console.log(
        `  • «${p.title}»${p.kind === 'errand' ? ' (дело)' : ''} T=${p.temperature} ` +
          `важность=${p.importance} возраст=${p.age ?? '?'}/${p.maxAge ?? '?'}`,
      );
    }
  } else {
    console.log('плотлайны: нет');
  }

  const c = rep.conflux;
  console.log(
    `conflux: соло ${c.monthsSolo} / стык ${c.monthsDocked} (${c.dockedPct}%) · ` +
      `партнёров ${c.partners} · всего ${c.history}` +
      (c.active ? ` · сейчас ${c.active.status}${c.active.rematch ? ' (повтор)' : ''}` : ''),
  );

  if (rep.usage.runs) {
    console.log(
      `llm: ${rep.usage.runs} запусков · ${fmtNum(rep.usage.tokens)} токенов · $${rep.usage.costUsd.toFixed(3)}`,
    );
  }

  console.log('диагноз:');
  for (const [level, text] of rep.flags) {
    console.log(`  [${level}] ${text}`);
  }

  if (dialogTail && dialog.length) {
    console.log(`последние реплики (${dialog.length}):`);
    for (const m of dialog) {
      const who = m.role === 'user' ? 'игрок' : 'правитель';
      const kind = m.kind ? `/${m.kind}` : '';
      console.log(`  ${who}${kind}: ${String(m.content || '').replace(/\s+/g, ' ').slice(0, 200)}`);
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: npm run report -- [--domain id] [--dialog N] [--json]');
    process.exit(0);
  }

  const config = loadConfig();
  const storage = await createStorage(config);

  try {
    const world = await storage.getWorld();
    if (!world) {
      console.log('Мир не найден — база пустая?');
      return;
    }
    let domains = await storage.listDomains();
    if (args.domain) domains = domains.filter((d) => d.id === args.domain);
    const confluxes = await storage.listConfluxes();

    const usageByDomain = new Map();
    let usageTotal = { runs: 0, tokens: 0, costUsd: 0 };
    if (typeof storage.listUsage === 'function') {
      const rows = await storage.listUsage({ worldId: world.id, limit: 50000 });
      for (const r of rows) {
        const t = Number(r.usage?.total_tokens) || 0;
        const c = Number(r.costUsd) || 0;
        usageTotal.runs += 1;
        usageTotal.tokens += t;
        usageTotal.costUsd += c;
        const key = String(r.domainId || '').split('+')[0];
        if (!key) continue;
        const acc = usageByDomain.get(key) || { runs: 0, tokens: 0, costUsd: 0 };
        acc.runs += 1;
        acc.tokens += t;
        acc.costUsd += c;
        usageByDomain.set(key, acc);
      }
    }

    const reports = domains.map((domain) =>
      analyzeDomain({ domain, config, world, confluxes, usageByDomain }),
    );

    const sch = world.scheduler || {};
    const overdueHours = sch.nextTickAt ? -hoursSince(sch.nextTickAt) : null;
    const worldFlags = [];
    if (!sch.nextTickAt) {
      worldFlags.push([WARN, 'nextTickAt не выставлен — расписание тика не закреплено']);
    } else if (overdueHours != null && overdueHours < -0.5) {
      worldFlags.push([BAD, `тик просрочен на ${Math.abs(overdueHours).toFixed(1)} ч — планировщик стоит`]);
    } else {
      worldFlags.push([GOOD, `следующий тик через ${(overdueHours ?? 0).toFixed(1)} ч`]);
    }
    if (sch.tickInProgress) {
      worldFlags.push([WARN, `tickInProgress=true с ${sch.tickStartedAt || '?'}`]);
    }

    const activeCx = confluxes.filter((c) => c.status === 'approaching' || c.status === 'docked');
    const dockedNow = confluxes.filter((c) => c.status === 'docked');
    const totalSolo = reports.reduce((a, r) => a + r.conflux.monthsSolo, 0);
    const totalDocked = reports.reduce((a, r) => a + r.conflux.monthsDocked, 0);
    const worldDockedPct = totalSolo + totalDocked ? (totalDocked / (totalSolo + totalDocked)) * 100 : 0;
    const target = (config.tick?.conflux?.targetDockedFraction ?? 0.5) * 100;
    if (totalSolo + totalDocked >= 12) {
      if (Math.abs(worldDockedPct - target) > 20) {
        worldFlags.push([
          WARN,
          `мир в конфлюксе ${worldDockedPct.toFixed(0)}% времени против цели ${target.toFixed(0)}%`,
        ]);
      } else {
        worldFlags.push([GOOD, `баланс мира ${worldDockedPct.toFixed(0)}% docked`]);
      }
    }
    const eligible = reports.filter(
      (r) =>
        r.ageMonths >= (config.tick?.conflux?.minDomainAgeMonths ?? 6) && !r.conflux.active,
    );
    if (eligible.length >= 2) {
      worldFlags.push([
        WARN,
        `${eligible.length} города готовы к матчу и свободны — матчмейкер их не сводит?`,
      ]);
    }
    const engaged = reports.filter((r) => r.engagement.unansweredNews < 2 && r.engagement.userMessages > 0);
    worldFlags.push([
      engaged.length >= Math.ceil(reports.length / 2) ? GOOD : WARN,
      `активно играют ${engaged.length} из ${reports.length}`,
    ]);

    // Системный перекос резолвера: один и тот же стат ползёт в одну сторону у всех
    const statTrend = new Map();
    for (const r of reports) {
      for (const [id, delta] of Object.entries(r.drift)) {
        const acc = statTrend.get(id) || { sum: 0, down: 0, up: 0, n: 0 };
        acc.sum += delta;
        acc.n += 1;
        if (delta < 0) acc.down += 1;
        if (delta > 0) acc.up += 1;
        statTrend.set(id, acc);
      }
    }
    const statName = (id) => (config.stats || []).find((s) => s.id === id)?.name || id;
    for (const [id, acc] of statTrend) {
      if (acc.n < 3) continue;
      if (acc.down >= acc.n - 1 && acc.sum <= -20) {
        worldFlags.push([
          BAD,
          `«${statName(id)}» падает почти у всех (${acc.down}/${acc.n}, сумма ${acc.sum}) — перекос резолвера`,
        ]);
      } else if (acc.up >= acc.n - 1 && acc.sum >= 20) {
        worldFlags.push([
          WARN,
          `«${statName(id)}» растёт почти у всех (${acc.up}/${acc.n}, сумма +${acc.sum}) — бесплатный прогресс`,
        ]);
      }
    }

    const approaching = confluxes.filter((c) => c.status === 'approaching');
    for (const c of approaching) {
      const waiting = (world.tickIndex || 0) - Number(c.createdTick || 0);
      const left = Number(c.dockAtTick || 0) - (world.tickIndex || 0);
      worldFlags.push([
        left > 0 ? GOOD : WARN,
        `conflux ${c.id}: сближение ${waiting} мес, до стыка ${left} мес (eta ${c.etaMonths}, стык на ${c.durationMonths} мес)`,
      ]);
    }

    if (args.json) {
      console.log(
        JSON.stringify(
          {
            world: {
              id: world.id,
              tickIndex: world.tickIndex,
              gameDate: world.gameDate,
              scheduler: sch,
            },
            usageTotal,
            confluxes: confluxes.map((c) => ({
              id: c.id,
              status: c.status,
              domainIds: c.domainIds,
              rematch: Boolean(c.rematch),
              contactKind: c.contact?.kind || null,
            })),
            worldFlags,
            domains: reports,
          },
          null,
          2,
        ),
      );
      return;
    }

    console.log('═'.repeat(72));
    console.log(`МИР ${world.id} · ${world.gameDate?.label || ''} · тик ${world.tickIndex}`);
    console.log(
      `хранилище ${storage.driver} · городов ${reports.length} · conflux активных ${activeCx.length} (стык ${dockedNow.length})`,
    );
    if (usageTotal.runs) {
      console.log(
        `llm всего: ${usageTotal.runs} запусков · ${fmtNum(usageTotal.tokens)} токенов · $${usageTotal.costUsd.toFixed(2)}`,
      );
    }
    console.log('═'.repeat(72));
    for (const [level, text] of worldFlags) console.log(`  [${level}] ${text}`);

    const byId = new Map(domains.map((d) => [d.id, d]));
    for (const rep of reports) {
      const domain = byId.get(rep.id);
      const hist = domain?.characters?.[0]?.dialogHistory || [];
      printDomain(rep, {
        dialogTail: args.dialogTail,
        dialog: args.dialogTail ? hist.slice(-args.dialogTail) : [],
      });
    }

    console.log(`\n${'═'.repeat(72)}`);
    console.log('СВОДКА');
    const bad = [];
    const warn = [];
    for (const rep of reports) {
      for (const [level, text] of rep.flags) {
        if (level === BAD) bad.push(`${rep.name}: ${text}`);
        else if (level === WARN) warn.push(`${rep.name}: ${text}`);
      }
    }
    for (const [level, text] of worldFlags) {
      if (level === BAD) bad.push(`МИР: ${text}`);
      else if (level === WARN) warn.push(`МИР: ${text}`);
    }
    console.log(`\nПлохо (${bad.length}):`);
    for (const t of bad) console.log(`  • ${t}`);
    console.log(`\nВнимание (${warn.length}):`);
    for (const t of warn) console.log(`  • ${t}`);
  } finally {
    await storage.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
