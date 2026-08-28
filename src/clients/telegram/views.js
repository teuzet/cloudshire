import { formatStatValue } from '../../game/stats.js';
import { normalizePlotlines } from '../../game/plotlines.js';

export function formatIslandStats(domain, config) {
  const name = domain?.name || 'Остров';
  const lines = (config?.stats || []).map((def) => {
    const value = Number(domain?.stats?.[def.id]);
    return `${def.name}: ${formatStatValue(value, config)}`;
  });
  return [`${name}`, ...lines].join('\n');
}

export function formatIslandPlotlines(domain) {
  normalizePlotlines(domain);
  const list = domain?.plotlines || [];
  if (!list.length) return `${domain?.name || 'Остров'}: открытых историй нет.`;
  const blocks = list.map((p) => {
    const kind = p.kind === 'errand' ? 'поручение' : p.kind === 'order' ? 'порядок' : 'история';
    const age =
      p.kind === 'order'
        ? p.durationMonths
          ? `${p.durationMonths} мес.`
          : 'бессрочно'
        : `${p.ageMonths}/${p.maxAgeMonths} мес.`;
    const head =
      p.urgency != null || p.gravity != null
        ? `«${p.title}» (${kind}) · срочность ${p.urgency ?? '—'} · масштаб ${p.gravity ?? '—'} · ${age}`
        : `«${p.title}» (${kind}) · ${age}`;
    const parts = [head];
    if (p.synopsis) parts.push(p.synopsis);
    if (p.closeWhen) parts.push(`закроется, когда: ${p.closeWhen}`);
    return parts.join('\n');
  });
  return [`${domain.name} · ${list.length}`, ...blocks].join('\n\n');
}
