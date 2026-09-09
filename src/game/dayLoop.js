/**
 * Дневной ход одиночного города.
 *
 * Тик был всем сразу: календарём, батчером событий и рейт-лимитером пушей.
 * Здесь остаётся только третья роль — просыпаться и разбирать то, что уже
 * назрело. Что назрело, решает не этот файл, а сроки дел и бед: обработчики
 * живут в `worldLoop`, очередь — в `scheduler`, часы — в `gameClock`.
 *
 * Сопряжённые города пока идут прежним месячным путём (`tick.js`): общая доска
 * двух игроков — отдельная задача, и ломать её заодно смысла нет.
 */

import { normalizeDomain } from './models.js';
import { ageDomainPeople } from './ages.js';
import { startClock, gameDateFromDay } from './gameClock.js';
import {
  DomainQueue,
  endRulerTurn,
  pruneJobs,
  rulerTurnStale,
  worldDay,
} from './scheduler.js';
import {
  armDomainSchedule,
  askForEvent,
  attachReport,
  drainDomainJobs,
  scheduleDeedJob,
} from './worldLoop.js';
import { narrateEvent } from './herald.js';
import { markPushed, shouldPush } from './notify.js';
import { scoreChronicleStats, factsForStatJudge } from './statJudge.js';
import { keepStories } from './storyteller.js';
import { formatRulerVoiceForPrompt } from './rulerMemory.js';
import { runOfficerAct, stewardOffCooldown, markStewardRan } from './steward.js';
import { findActiveConfluxForDomain } from './conflux.js';
import { getLogger } from '../log.js';

/** Какая настройка уведомлений отвечает за это событие. */
export function triggerForEvent(event) {
  if (!event) return 'deedDone';
  if (event.surfaced) return 'threatSurfaced';
  if (event.occasion === 'новая история') return 'newStory';
  if (event.occasion === 'угроза') return 'threatFired';
  if (event.occasion === 'разрешение' || event.closed) return 'plotClosed';
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
    ask: askForEvent(domain, event, config),
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
} = {}) {
  const log = (parentLog || getLogger()).child({ scope: 'dayLoop', domainId: domain?.id });
  normalizeDomain(domain, config);
  ageDomainPeople(domain, world);
  startClock(world);

  await armDomainSchedule({ runtime, domain, world, day, rng, log });
  const events = await drainDomainJobs({ config, runtime, domain, world, day, rng, log });

  // Сановник ходит сам только в тишину: если события есть, покровителю и так есть что читать.
  let stewardAct = null;
  if (!events.length && stewardOffCooldown(domain, day, config)) {
    const acted = await runOfficerAct({ config, runtime, domain, world, day, rng, log });
    if (acted?.act?.kind === 'process') {
      markStewardRan(domain, day);
      stewardAct = acted.act;
      const started = (domain.state?.pendingActions || []).find((a) => a.id === acted.act.id);
      if (started) scheduleDeedJob(world, domain, started);
    }
  }

  for (const event of events) attachReport(domain, event, { day });

  const facts = factsForStatJudge(events.map((e) => e.fact).filter(Boolean));
  const scored = facts.length
    ? await scoreChronicleStats({ config, runtime, domain, world, chronicleAdds: facts, log })
    : { scored: 0 };

  // Синопсис обновляем только у тех нитей, которые сегодня сдвинулись.
  const moved = [...new Set(events.map((e) => e.plotId).filter(Boolean))]
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

  domain.state = domain.state || {};
  domain.state.lastDay = day;
  log.info('dayLoop.step', {
    day,
    events: events.length,
    steward: stewardAct ? stewardAct.summary : null,
    statsScored: scored?.scored ?? 0,
  });
  return { events, stewardAct, scored };
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
} = {}) {
  const log = (parentLog || getLogger()).child({ scope: 'dayLoop' });
  const world = await storage.getWorld();
  startClock(world, now);

  if (rulerTurnStale(world, now)) {
    log.warn('dayLoop.turn_failsafe', { turnStartedAt: world.turnStartedAt });
    endRulerTurn(world, now);
  } else if (world.turnStartedAt != null) {
    return { day: worldDay(world, { now, config }), skipped: 'ruler_turn', results: [] };
  }

  const day = worldDay(world, { now, config });
  world.dayIndex = day;

  const domains = await storage.listDomains();
  const results = [];
  const jobs = queue || new DomainQueue();

  for (const stale of domains) {
    if (stale.status && stale.status !== 'playing') continue;
    // Сопряжённый город живёт месячной доской: его ведёт tick.js.
    const conflux = await findActiveConfluxForDomain(storage, stale.id);
    if (conflux) {
      results.push({ domainId: stale.id, skipped: 'conflux', confluxId: conflux.id });
      continue;
    }

    const step = await jobs.run(stale.id, async () => {
      const domain = await storage.getDomain(stale.id);
      if (!domain) return { domainId: stale.id, skipped: 'gone' };
      const out = await stepDomain({ config, runtime, domain, world, day, rng, log });
      await storage.saveDomain(domain);

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

  pruneJobs(world);
  await storage.saveWorld(world);

  log.info('dayLoop.done', {
    day,
    label: gameDateFromDay(day).label,
    domains: results.length,
    events: results.reduce((n, r) => n + (r.events || 0), 0),
  });
  return { day, label: gameDateFromDay(day).label, results };
}
