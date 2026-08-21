import { newId } from './ids.js';

/**
 * Сюжетные линии домена: температура → шанс прорыва → обязательный сдвиг в резолве.
 */

export function normalizePlotlines(domain) {
  if (!domain || typeof domain !== 'object') return domain;
  if (!Array.isArray(domain.plotlines)) domain.plotlines = [];
  domain.plotlines = domain.plotlines
    .filter((p) => p && p.status !== 'completed')
    .map((p) => ({
      id: String(p.id),
      title: String(p.title || 'Без названия').slice(0, 120),
      summary: String(p.summary || '').slice(0, 400),
      temperature: clampTemp(p.temperature ?? 0),
      status: 'open',
      breakthroughThisTick: Boolean(p.breakthroughThisTick),
      lastBreakthroughTick:
        p.lastBreakthroughTick == null ? null : Number(p.lastBreakthroughTick),
      createdTick: p.createdTick == null ? null : Number(p.createdTick),
      relatedPendingIds: Array.isArray(p.relatedPendingIds)
        ? p.relatedPendingIds.map(String)
        : [],
    }));
  return domain;
}

function clampTemp(n) {
  return Math.max(0, Math.min(100, Math.round(Number(n) || 0)));
}

export function createPlotline({
  title,
  summary = '',
  temperature = 20,
  tick = null,
  relatedPendingIds = [],
}) {
  return {
    id: newId('plot'),
    title: String(title || 'Сюжет').slice(0, 120),
    summary: String(summary || '').slice(0, 400),
    temperature: clampTemp(temperature),
    status: 'open',
    breakthroughThisTick: false,
    lastBreakthroughTick: null,
    createdTick: tick,
    relatedPendingIds: (relatedPendingIds || []).map(String),
  };
}

/** +heatPerTick к каждому открытому плотлайну (до броска). */
export function heatPlotlines(domain, heatPerTick = 10) {
  normalizePlotlines(domain);
  const heat = Math.max(0, Math.round(Number(heatPerTick) || 0));
  for (const p of domain.plotlines) {
    p.temperature = clampTemp(p.temperature + heat);
    p.breakthroughThisTick = false;
  }
  return domain.plotlines;
}

/**
 * Бросок прорыва: P = temperature/100.
 * При успехе: breakthroughThisTick=true, temperature=0.
 * @returns {object[]} плотлайны с прорывом в этом тике
 */
export function rollBreakthroughs(domain, rng = Math.random) {
  normalizePlotlines(domain);
  const hits = [];
  for (const p of domain.plotlines) {
    const chance = clampTemp(p.temperature) / 100;
    if (rng() < chance) {
      p.breakthroughThisTick = true;
      p.temperature = 0;
      hits.push(p);
    }
  }
  return hits;
}

export function clearBreakthroughFlags(domain, tick = null) {
  normalizePlotlines(domain);
  for (const p of domain.plotlines) {
    if (p.breakthroughThisTick) {
      p.lastBreakthroughTick = tick;
      p.breakthroughThisTick = false;
    }
  }
}

export function formatPlotlinesForPrompt(domain) {
  normalizePlotlines(domain);
  if (!domain.plotlines.length) return '(плотлайнов пока нет)';
  return domain.plotlines
    .map((p) => {
      const bt = p.breakthroughThisTick ? ' ★ПРОРЫВ' : '';
      return (
        `- [${p.id}] «${p.title}» T=${p.temperature}${bt}` +
        (p.summary ? ` — ${p.summary}` : '')
      );
    })
    .join('\n');
}

export function formatBreakthroughMandate(breakthroughs) {
  if (!breakthroughs?.length) return '';
  return [
    'ОБЯЗАТЕЛЬНЫЙ ПРИОРИТЕТ — ПРОРЫВЫ СЮЖЕТА (сделай ПЕРВЫМИ, до прочего):',
    'Для каждого: add_chronicle с явным сильным сдвигом (не «ничего не нашли / всё тихо»).',
    'Можно не завершать сюжет целиком, но мир должен заметно измениться.',
    ...breakthroughs.map(
      (p) =>
        `- ПРОРЫВ [${p.id}] «${p.title}»: ${p.summary || 'сдвинь эту линию вперёд'}`,
    ),
  ].join('\n');
}

export function plotlinesConfig(config) {
  const p = config.tick?.plotlines || {};
  return {
    heatPerTick: p.heatPerTick ?? 10,
    enabled: p.enabled !== false,
  };
}
