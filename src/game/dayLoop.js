/**
 * Дневной ход города. Сопряжённая пара идёт тем же движком: задания пары
 * разбираются до шага доменов, нити остаются у хозяина.
 */

import { normalizeDomain } from './models.js';
import { ageDomainPeople } from './ages.js';
import { startClock, syncWorldClock, gameDateFromDay } from './gameClock.js';
import {
  DomainQueue,
  endRulerTurn,
  mergeWorldJobs,
  pruneJobs,
  rulerTurnHolds,
  rulerTurnStale,
  worldDay,
  clockIsHeld,
} from './scheduler.js';
import { StaleWriteError } from '../storage/revision.js';
import {
  armDomainSchedule,
  askForEvent,
  attachReport,
  drainDomainJobs,
  scheduleDeedJob,
  sweepOrphanJobs,
} from './worldLoop.js';
import { narrateEvent } from './herald.js';
import { markPushed, shouldPush } from './notify.js';
import { scoreChronicleStats, factsForStatJudge } from './statJudge.js';
import { keepStories } from './storyteller.js';
import { formatRulerVoiceForPrompt } from './rulerMemory.js';
import { runOfficerAct, stewardOffCooldown, markStewardRan } from './steward.js';
import { maybeMatchmakeConfluxes } from './conflux.js';
import { drainConfluxJobs } from './confluxJobs.js';
import { emitConfluxAnnouncements } from './tick.js';
import { maybeRewriteCityGenesis } from './genesisRewrite.js';
import { otherDomainId, overlayConfluxView, stampNewBoardItems, stripConfluxView } from './confluxBoard.js';
import { maybeNudgeProxy } from './proxyJudge.js';
import { getLogger } from '../log.js';

/** Какая настройка уведомлений отвечает за это событие. */
export function triggerForEvent(event) {
  if (!event) return 'deedDone';
  if (event.hostileFromNeighbor) return 'confluxHostile';
  if (event.fromPair || event.occasion === 'сопряжение' || event.occasion === 'расстыковка' || event.occasion === 'касание') {
    return 'conflux';
  }
  if (event.surfaced) return 'threatSurfaced';
  if (event.occasion === 'новая история') return 'newStory';
  if (event.occasion === 'угроза') return 'threatFired';
  if (event.occasion === 'развязка' || event.occasion === 'разрешение' || event.closed) return 'plotClosed';
  if (event.occasion === 'доклад') return 'priestReport';
  if (event.outcome?.finish === 'fail') return 'deedFailed';
  return event.plotId ? 'deedDone' : 'errandDone';
}

/** Всплывшая беда рассказывается сама по себе: записи в хронике у неё нет. */
function factForEvent(event) {
  if (event.fact) return event.fact;
  if (event.surfaced) return { text: event.surfaced.text };
  return null;
}

/**
 * Рассказать об одном событии и, если настройки позволяют, разбудить телефон.
 * Хроника уже написана движком: молчание уведомлений событие не отменяет.
 */
export async function deliverEvent({
  config,
  runtime,
  app,
  domain,
  world,
  event,
  day = 0,
  log: parentLog,
} = {}) {
  const log = (parentLog || getLogger()).child({ scope: 'dayLoop.say', domainId: domain?.id });
  const fact = factForEvent(event);
  if (!fact && !event.reportSubject) return { skipped: 'nothing_to_say' };

  const said = await narrateEvent({
    runtime,
    domain,
    log,
    plot: event.plot || null,
    fact,
    occasion: event.occasion,
    closed: Boolean(event.closed),
    ask: askForEvent(domain, event, config),
    actor: event.actor || '',
    actorGender: event.actorGender || null,
    day,
    memory: formatRulerVoiceForPrompt(domain),
    reportSubject: event.reportSubject || '',
  });
  const text = String(said?.text || '').trim();
  if (!text) return { skipped: 'no_text' };

  const trigger = triggerForEvent(event);
  const gate = shouldPush(domain, { trigger, day });
  await app.persistDialog(domain, 'assistant', text, {
    kind: 'event',
    meta: { occasion: event.occasion, trigger, pushed: gate.push, day },
  });

  if (!gate.push) {
    log.info('dayLoop.muted', { trigger, reason: gate.reason });
    return { text, pushed: false, reason: gate.reason };
  }

  markPushed(domain, day);
  if (domain.ownerUserId) {
    await app.emitOutbound(domain.ownerUserId, text, {
      agent: 'ruler',
      domainId: domain.id,
      kind: 'event',
      chronicleId: fact?.id || null,
      plotId: event.plotId || null,
      threatId: event.surfaced?.id || null,
      processId: event.outcome?.processId || null,
    });
  }
  log.info('dayLoop.said', { trigger, occasion: event.occasion, day, wouldMute: gate.wouldMute });
  return { text, pushed: true, wouldMute: gate.wouldMute || null };
}

/**
 * Разбор последствий пачки событий: статы, синопсисы, описание города.
 *
 * Вынесено из шага дня, потому что тестовый клиент форсирует события в обход
 * дневного цикла. Пока это жило внутри `stepDomain`, форсированная угроза не
 * двигала статы, не обновляла синопсис и не правила описание города — то есть
 * проверяла не тот путь, который работает в игре.
 */
export async function settleEvents({
  config,
  runtime,
  domain,
  world,
  events = [],
  day = 0,
  rng = Math.random,
  log: parentLog,
} = {}) {
  const log = (parentLog || getLogger()).child({ scope: 'dayLoop.settle', domainId: domain?.id });
  const list = (events || []).filter((e) => e && !e.skipped);
  if (!list.length) return { scored: 0, catastrophe: null };

  for (const event of list) attachReport(domain, event, { day });

  const facts = factsForStatJudge(list.map((e) => e.fact).filter(Boolean));
  const scored = facts.length
    ? await scoreChronicleStats({ config, runtime, domain, world, chronicleAdds: facts, log })
    : { scored: 0, catastrophe: null };

  const plotIds = [...new Set(list.map((e) => e.plotId).filter(Boolean))];
  if (plotIds.length) {
    await maybeNudgeProxy({
      runtime,
      config,
      world,
      day,
      domains: [domain],
      trigger: 'plot_tick',
      context: `Сдвинулись нити: ${plotIds.join(', ')}`,
      rng,
      log,
    });
  }

  // Синопсис обновляем только у тех нитей, которые сегодня сдвинулись.
  const moved = plotIds
    .map((id) => (domain.plotlines || []).find((p) => p.id === id))
    .filter(Boolean);
  if (moved.length) {
    await keepStories({
      config,
      runtime,
      domain,
      world,
      chronicleAdds: facts,
      plots: moved,
      log,
    });
  }

  await maybeRewriteCityGenesis({
    runtime,
    domain,
    world,
    chronicleAdds: facts,
    config,
    log,
  });

  if (domain.stats && typeof domain.stats === 'object') {
    for (const key of Object.keys(domain.stats)) {
      const n = Number(domain.stats[key]);
      if (!Number.isFinite(n)) continue;
      domain.stats[key] = Math.max(0, Math.min(100, n));
    }
  }
  return scored;
}

/**
 * Один шаг города: разобрать назревшее, дать сановнику походить, посчитать
 * статы. Ввода-вывода здесь нет — только домен, мир и вызовы моделей.
 */
export async function stepDomain({
  config,
  runtime,
  domain,
  world,
  day = 0,
  rng = Math.random,
  log: parentLog,
  conflux = null,
  partner = null,
  storage = null,
} = {}) {
  const log = (parentLog || getLogger()).child({ scope: 'dayLoop', domainId: domain?.id });
  normalizeDomain(domain, config);
  ageDomainPeople(domain, world);
  startClock(world);
  if (conflux) overlayConfluxView(domain, conflux, partner);

  await armDomainSchedule({ runtime, domain, world, day, rng, log });
  const events = await drainDomainJobs({
    config,
    runtime,
    domain,
    world,
    day,
    rng,
    log,
    conflux,
    partner,
    storage,
  });

  // Сановник ходит сам только в тишину: если события есть, покровителю и так есть что читать.
  let stewardAct = null;
  if (!events.length && stewardOffCooldown(domain, day, config)) {
    const acted = await runOfficerAct({ config, runtime, domain, world, day, rng, log, conflux, partner });
    if (acted?.act?.kind === 'process') {
      markStewardRan(domain, day);
      stewardAct = acted.act;
      const started = (domain.state?.pendingActions || []).find((a) => a.id === acted.act.id);
      if (started) scheduleDeedJob(world, domain, started);
    }
  }

  const scored = await settleEvents({ config, runtime, domain, world, events, day, rng, log });

  domain.state = domain.state || {};
  domain.state.lastDay = day;
  // Пока наложение сопряжения ещё на месте: нити соседа тоже считаются живыми.
  const orphans = sweepOrphanJobs(world, domain, { conflux, log });
  if (conflux) {
    stampNewBoardItems(domain, conflux);
    stripConfluxView(domain);
  }
  log.info('dayLoop.step', {
    day,
    events: events.length,
    steward: stewardAct ? stewardAct.summary : null,
    statsScored: scored?.scored ?? 0,
    orphanJobs: orphans.length,
  });
  return { events, stewardAct, scored, orphans };
}

/**
 * Записать город, не роняя проход мира.
 *
 * Отказ по ревизии означает, что копию города кто-то обогнал. Молчать нельзя —
 * ровно так в живой партии исчез шаг Керсая, — но и валить весь проход мира
 * из-за одного города незачем.
 */
async function saveDomainOrShout(storage, domain, log, where) {
  try {
    await storage.saveDomain(domain);
    return true;
  } catch (err) {
    if (!(err instanceof StaleWriteError)) throw err;
    log.error('dayLoop.lost_write', {
      where,
      domainId: domain?.id || null,
      mine: err.mine,
      stored: err.stored,
    });
    return false;
  }
}

/**
 * Пройти мир на текущий игровой день.
 *
 * Ход правителя останавливает время: пока жрец думает, мир не должен уехать
 * вперёд, иначе ответ будет про мир, которого уже нет. Зависший ход снимает
 * предохранитель — иначе одна упавшая реплика заморозила бы город навсегда.
 */
export async function runDayLoop({
  config,
  runtime,
  storage,
  app,
  queue = null,
  now = Date.now(),
  rng = Math.random,
  log: parentLog,
  allowWhileHeld = false,
} = {}) {
  const log = (parentLog || getLogger()).child({ scope: 'dayLoop' });
  const world = await storage.getWorld();
  startClock(world, now, config);

  // Зависший ход снимается и в своей копии (чтобы часы этого прохода считались
  // верно), и в хранилище (чтобы он не держал город вечно).
  if (rulerTurnStale(world, now)) {
    log.warn('dayLoop.turn_failsafe', { turnStartedAt: world.turnStartedAt });
    endRulerTurn(world, now);
    await storage.updateWorld((fresh) => endRulerTurn(fresh, now));
  }

  if (clockIsHeld(world) && !allowWhileHeld) {
    return { day: worldDay(world, { now, config }), skipped: 'clock_held', results: [] };
  }

  const day = worldDay(world, { now, config });
  syncWorldClock(world, { now, config, day });

  const matchmake = await maybeMatchmakeConfluxes({ config, runtime, storage, world, rng, now });
  if (matchmake.notes?.length) {
    await emitConfluxAnnouncements({ app, storage, items: matchmake.notes });
  }

  const pairEvents = await drainConfluxJobs({
    config,
    runtime,
    storage,
    world,
    day,
    rng,
    log,
  });
  const results = [];
  const jobs = queue || new DomainQueue();

  for (const event of pairEvents || []) {
    for (const domain of event.domains || []) {
      const bundled = (event.facts || []).find((f) => f.domainId === domain.id);
      const fact = bundled?.fact || null;
      if (!fact && !event.occasion) continue;
      await jobs.run(domain.id, async () => {
        await deliverEvent({
          config,
          runtime,
          app,
          domain,
          world,
          event: {
            occasion: event.occasion,
            fact,
            plotId: event.plotId || null,
          },
          day,
          log,
        });
        await saveDomainOrShout(storage, domain, log, 'pair_event');
      });
    }
  }

  const domains = await storage.listDomains();
  const confluxes = await storage.listConfluxes({ status: ['approaching', 'docked'] }).catch(() => []);

  for (const stale of domains) {
    if (stale.status && stale.status !== 'playing') continue;
    if (stale.state?.genesisPending) {
      log.info('dayLoop.yield_genesis', { domainId: stale.id });
      results.push({ domainId: stale.id, name: stale.name, skipped: 'genesis' });
      continue;
    }

    // Ход правителя важнее прохода мира, но только в своём городе: ждать
    // минуту, пока жрец думает, остальные города не обязаны.
    const live = await storage.getWorld();
    if (rulerTurnHolds(live, stale.id, now) || jobs.busy(stale.id)) {
      log.info('dayLoop.yield_turn', { domainId: stale.id });
      results.push({ domainId: stale.id, name: stale.name, skipped: 'ruler_turn' });
      continue;
    }

    const step = await jobs.run(stale.id, async () => {
      const domain = await storage.getDomain(stale.id);
      if (!domain) return { domainId: stale.id, skipped: 'gone' };
      const conflux = (confluxes || []).find((c) => (c.domainIds || []).includes(domain.id)) || null;
      let partner = null;
      if (conflux) {
        const partnerId = otherDomainId(conflux, domain.id);
        if (partnerId) partner = await storage.getDomain(partnerId);
      }
      const out = await stepDomain({
        config,
        runtime,
        domain,
        world,
        day,
        rng,
        log,
        conflux,
        partner,
        storage,
      });
      await storage.saveDomain(domain);
      if (conflux && storage.saveConflux) await storage.saveConflux(conflux);

      const said = [];
      for (const event of out.events) {
        const res = await deliverEvent({
          config,
          runtime,
          app,
          domain,
          world,
          event,
          day,
          log,
        });
        said.push(res);
        if (event.secretVictim?.fact && partner) {
          await jobs.run(partner.id, async () => {
            await deliverEvent({
              config,
              runtime,
              app,
              domain: partner,
              world,
              event: {
                occasion: 'сопряжение',
                fact: event.secretVictim.fact,
                plotId: event.plotId || null,
                fromPair: true,
                hostileFromNeighbor: true,
              },
              day,
              log,
            });
            await saveDomainOrShout(storage, partner, log, 'secret_victim');
          });
        }
        if (event.pairSpread?.cityFact && partner) {
          await jobs.run(partner.id, async () => {
            await deliverEvent({
              config,
              runtime,
              app,
              domain: partner,
              world,
              event: {
                occasion: 'сопряжение',
                fact: event.pairSpread.cityFact,
                plotId: event.plotId || null,
                fromPair: true,
                hostileFromNeighbor: Boolean(event.pairSpread.hostile),
              },
              day,
              log,
            });
            await saveDomainOrShout(storage, partner, log, 'pair_spread');
          });
        }
      }
      await storage.saveDomain(domain);
      return {
        domainId: domain.id,
        name: domain.name,
        events: out.events.length,
        pushed: said.filter((s) => s?.pushed).length,
        stewardAct: out.stewardAct?.summary || null,
      };
    });
    results.push(step);
  }

  // Мир держали весь проход, а чат в это время ставил свои задания. Пишем
  // слиянием: иначе дело, заведённое в разговоре, потеряет срок и не кончится.
  await storage.updateWorld((fresh) => {
    mergeWorldJobs(fresh, world);
    // Промотка двигает якорь, пока этот проход ещё идёт. Нельзя записать
    // день начала шага поверх уже перемотанных часов: иначе календарь в
    // шапке уедет, а сроки сопряжения останутся на старом dayIndex.
    const live = worldDay(fresh, { now, config });
    syncWorldClock(fresh, { now, config, day: Math.max(day, live) });
    pruneJobs(fresh);
  });

  log.info('dayLoop.done', {
    day,
    label: gameDateFromDay(day).label,
    domains: results.length,
    events: results.reduce((n, r) => n + (r.events || 0), 0),
  });
  return { day, label: gameDateFromDay(day).label, results };
}
