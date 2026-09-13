/**
 * Прогноз пары, синопсис по городам и редкие угрозы тишины.
 *
 * Прогноз игроку не показывают: он кормит расставание и угрозы.
 * Синопсис на карточке — свой у каждого города, из его летописи о паре.
 */

import { keepStories } from './storyteller.js';
import { confluxConfig, pairPrimaryId } from './confluxTime.js';
import { attachThreat, createThreat, findThreat, liveThreats } from './threats.js';
import { scheduleJob, cancelJobs, cancelJobsForThreat } from './scheduler.js';
import { getLogger } from '../log.js';
import { toolFail } from '../agents/toolResult.js';

function archiveForForecast(conflux, domains = []) {
  const names = new Map((domains || []).map((d) => [String(d.id), d.name]));
  return (conflux?.lore || [])
    .map((f) => {
      const where =
        !f.place || f.place === 'pair' ? 'на проходе' : names.get(String(f.place)) || 'в городе';
      const frozen = f.frozenSynopsis ? ' [архив]' : '';
      return `- (${f.gameDateLabel || '?'}, ${where}${frozen}) ${f.text}`;
    })
    .join('\n');
}

export const SILENCE_EVENT = 'pair_silence';
export const SILENCE_THREAT_TEXT =
  'Пока оба берега молчат, на проходе само назреет столкновение.';

export function silenceThreatId(confluxId) {
  return `thr_quiet_${String(confluxId || 'pair')}`;
}

export function ensurePairState(conflux) {
  if (!conflux || typeof conflux !== 'object') return conflux;
  if (!conflux.forecast || typeof conflux.forecast !== 'object') conflux.forecast = {};
  if (!conflux.synopsis || typeof conflux.synopsis !== 'object') conflux.synopsis = {};
  if (!conflux.quiet || typeof conflux.quiet !== 'object') {
    conflux.quiet = { nextAttemptDay: null, cooldownUntilDay: null };
  }
  if (!('nextAttemptDay' in conflux.quiet)) conflux.quiet.nextAttemptDay = null;
  if (!('cooldownUntilDay' in conflux.quiet)) conflux.quiet.cooldownUntilDay = null;
  return conflux;
}

export function pairChronicleEntries(conflux) {
  return (conflux?.lore || []).filter((f) => f && !f.frozenSynopsis);
}

export function lastPairChronicleDay(conflux, fallback = null) {
  const days = pairChronicleEntries(conflux)
    .map((f) => Number(f.day))
    .filter((n) => Number.isFinite(n));
  if (!days.length) return fallback == null ? null : Math.round(Number(fallback) || 0);
  return Math.max(...days);
}

export function cityPairChronicleAdds(domain, conflux) {
  const tag = conflux?.id ? `conflux:${conflux.id}` : null;
  return (domain?.lore || []).filter((f) => {
    const tags = f?.tags || [];
    if (tags.includes('conflux')) return true;
    if (tag && tags.includes(tag)) return true;
    return false;
  });
}

function pairCard(conflux, domain) {
  const plot = conflux?.container;
  if (!plot) return null;
  ensurePairState(conflux);
  return {
    id: plot.id,
    title: plot.title,
    synopsis: conflux.synopsis[domain.id] || plot.synopsis || '',
    kind: 'story',
    storyType: 'freeform',
    isMainConflux: true,
  };
}

/**
 * Пересобрать синопсис нити пары для одного города из его собственных записей.
 * Тот же агент, что сжимает обычные нити. Нейтральный текст не переводим.
 */
export async function refreshCityPairSynopsis({
  runtime,
  conflux,
  domain,
  world,
  chronicleAdds = [],
  log,
} = {}) {
  if (!runtime || !conflux?.container || !domain) return null;
  ensurePairState(conflux);
  const card = pairCard(conflux, domain);
  if (!card) return null;
  const adds = (chronicleAdds.length ? chronicleAdds : cityPairChronicleAdds(domain, conflux)).map((f) => ({
    ...f,
    relatedPlotlineIds: [card.id],
  }));
  if (!adds.length && !conflux.synopsis[domain.id]) return null;
  const board = { id: domain.id, name: domain.name, plotlines: [card] };
  try {
    await keepStories({
      runtime,
      domain: board,
      world,
      chronicleAdds: adds,
      plots: [card],
      log,
    });
  } catch (err) {
    (log || getLogger()).warn('conflux.synopsis_failed', { domainId: domain.id, error: err.message });
    return null;
  }
  const next = String(card.synopsis || '').trim();
  if (next) conflux.synopsis[domain.id] = next;
  return next || null;
}

export async function refreshPairForecast({
  runtime,
  conflux,
  domains = [],
  world,
  log,
} = {}) {
  if (!runtime || !conflux) return null;
  ensurePairState(conflux);
  const pair = (domains || []).filter(Boolean);
  if (pair.length < 2) return conflux.forecast;
  const draft = { byCity: {}, neutral: '' };
  try {
    await runtime.run({
      agentId: 'confluxForecast',
      scene: 'conflux_forecast',
      log,
      maxTurns: 2,
      toolChoice: { type: 'function', function: { name: 'submit_forecast' } },
      tools: [
        {
          name: 'submit_forecast',
          description:
            'Что останется каждому городу, если острова разойдутся сейчас. Игроку это не показывают.',
          parameters: {
            type: 'object',
            additionalProperties: false,
            required: ['forecasts', 'neutral'],
            properties: {
              forecasts: {
                type: 'array',
                items: {
                  type: 'object',
                  required: ['domainId', 'text'],
                  properties: {
                    domainId: { type: 'string' },
                    text: { type: 'string' },
                  },
                },
              },
              neutral: {
                type: 'string',
                description: 'Нейтральное объединение для архива, без суда кто прав.',
              },
            },
          },
          handler: async (args) => {
            const rows = Array.isArray(args?.forecasts) ? args.forecasts : [];
            if (!rows.length) return toolFail('empty', 'Нужен прогноз для каждого города.');
            for (const row of rows) {
              const id = String(row?.domainId || '').trim();
              const text = String(row?.text || '').trim();
              if (id && text) draft.byCity[id] = text;
            }
            draft.neutral = String(args?.neutral || '').trim();
            return { ok: true };
          },
        },
      ],
      extraSystem:
        'Ты пишешь внутренний прогноз сопряжения: что станет фактом, если острова разойдутся СЕЙЧАС. ' +
        'Для каждого города — свой текст: одно и то же событие для одного беда, для другого удача. ' +
        'neutral — сухая сводка без суда. Не пиши хронику. Не датируй голым номером дня. Верни submit_forecast.',
      userMessages: [
        {
          role: 'user',
          content: [
            world?.gameDate?.label ? `Сейчас ${world.gameDate.label}.` : '',
            `Города: ${pair.map((d) => `«${d.name}» (${d.id})`).join(' и ')}.`,
            'Полный архив пары:',
            archiveForForecast(conflux, pair) || '(пусто)',
            conflux.forecast?.neutral ? `Прежний нейтральный прогноз: ${conflux.forecast.neutral}` : '',
            'Если острова разойдутся прямо сейчас — что останется каждому? Вызови submit_forecast.',
          ]
            .filter(Boolean)
            .join('\n'),
        },
      ],
    });
  } catch (err) {
    (log || getLogger()).warn('conflux.forecast_failed', { error: err.message });
    return conflux.forecast;
  }
  for (const domain of pair) {
    const text = draft.byCity[domain.id];
    if (text) conflux.forecast[domain.id] = text;
  }
  if (draft.neutral) conflux.forecast.neutral = draft.neutral;
  return conflux.forecast;
}

export function dropSilenceThreat(conflux, world) {
  const plot = conflux?.container;
  if (!plot) return null;
  const threat = findThreat(plot, silenceThreatId(conflux.id));
  if (!threat || threat.status !== 'live') return null;
  threat.status = 'dropped';
  if (world) cancelJobsForThreat(world, threat.id);
  return threat;
}

function liveSilenceThreat(conflux) {
  return liveThreats(conflux?.container).find((t) => t.id === silenceThreatId(conflux.id)) || null;
}

export function scheduleSilenceAttempt(world, conflux, dueDay) {
  if (!world || !conflux) return null;
  ensurePairState(conflux);
  const day = Math.max(0, Math.round(Number(dueDay) || 0));
  conflux.quiet.nextAttemptDay = day;
  cancelJobs(
    world,
    (j) =>
      j.kind === 'conflux_contact' &&
      String(j.payload?.confluxId || '') === String(conflux.id) &&
      j.state === 'pending',
  );
  return scheduleJob(world, {
    domainId: pairPrimaryId(conflux),
    kind: 'conflux_contact',
    dueDay: day,
    payload: { confluxId: conflux.id },
  });
}

/**
 * Попытка тишины: давно ли что-то пересекало границу. Часы расставания не трогаем.
 * Личность угрозы стабильна: один id на пару, срок живой угрозы не переназначаем.
 */
export function attemptPairSilence({
  conflux,
  world,
  day = 0,
  config = null,
  rng = Math.random,
  log,
} = {}) {
  ensurePairState(conflux);
  const cfg = confluxConfig(config);
  const today = Math.round(Number(day) || 0);
  const last = lastPairChronicleDay(
    conflux,
    Number.isFinite(Number(conflux?.dockedDay)) ? Math.round(Number(conflux.dockedDay)) : today,
  );
  const silentFor = Math.max(0, today - (last ?? today));
  const nextFromActivity = (last ?? today) + cfg.quietSilenceDays;

  if (silentFor < cfg.quietSilenceDays) {
    dropSilenceThreat(conflux, world);
    scheduleSilenceAttempt(world, conflux, nextFromActivity);
    return { skipped: 'active', silentFor, nextAttemptDay: nextFromActivity };
  }

  const coolUntil = Number(conflux.quiet.cooldownUntilDay);
  if (Number.isFinite(coolUntil) && today < coolUntil) {
    scheduleSilenceAttempt(world, conflux, coolUntil);
    return { skipped: 'cooldown', nextAttemptDay: coolUntil };
  }

  if (rng() >= cfg.quietChance) {
    const retry = today + cfg.quietCooldownDays;
    conflux.quiet.cooldownUntilDay = retry;
    scheduleSilenceAttempt(world, conflux, retry);
    (log || getLogger()).info('conflux.silence_miss', { confluxId: conflux.id, retry });
    return { skipped: 'roll', nextAttemptDay: retry };
  }

  const existing = liveSilenceThreat(conflux);
  if (existing) {
    scheduleSilenceAttempt(world, conflux, today + cfg.quietCooldownDays);
    return { skipped: 'already', threatId: existing.id, dueDay: existing.dueDay };
  }

  const plot = conflux.container;
  if (!plot) return { skipped: 'no_container' };
  const threat = createThreat({
    plot,
    text: SILENCE_THREAT_TEXT,
    band: 'SEASON',
    day: today,
    outcome: 'harm',
    known: true,
    eventKind: SILENCE_EVENT,
  });
  threat.id = silenceThreatId(conflux.id);
  attachThreat(plot, threat);
  const retry = today + cfg.quietCooldownDays;
  conflux.quiet.cooldownUntilDay = retry;
  scheduleSilenceAttempt(world, conflux, retry);
  (log || getLogger()).info('conflux.silence_armed', { confluxId: conflux.id, threatId: threat.id, dueDay: threat.dueDay });
  return { threat, nextAttemptDay: retry };
}

/**
 * После записи в архив пары: прогноз, синопсис задетых городов, сдвиг попытки тишины.
 */
export async function afterPairLoreWrite({
  runtime,
  conflux,
  domains = [],
  world,
  day = null,
  cityFacts = [],
  log,
  config = null,
} = {}) {
  if (!conflux) return null;
  ensurePairState(conflux);
  const pair = (domains || []).filter(Boolean);
  await refreshPairForecast({ runtime, conflux, domains: pair, world, log });
  const touched = new Set((cityFacts || []).map((row) => String(row?.domainId || '')).filter(Boolean));
  for (const domain of pair) {
    if (touched.size && !touched.has(String(domain.id))) continue;
    const adds = (cityFacts || [])
      .filter((row) => String(row.domainId) === String(domain.id) && row.fact)
      .map((row) => row.fact);
    await refreshCityPairSynopsis({
      runtime,
      conflux,
      domain,
      world,
      chronicleAdds: adds,
      log,
    });
  }
  const today = day != null ? Math.round(Number(day) || 0) : Math.round(Number(world?.dayIndex) || 0);
  const cfg = confluxConfig(config);
  const last = lastPairChronicleDay(conflux, today);
  const next = (last ?? today) + cfg.quietSilenceDays;
  if (world && conflux.status === 'docked') {
    dropSilenceThreat(conflux, world);
    if (next > today) scheduleSilenceAttempt(world, conflux, next);
  }
  return { forecast: conflux.forecast, synopsis: conflux.synopsis };
}
