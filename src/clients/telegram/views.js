import { formatStatValue } from '../../game/stats.js';
import { isStoryPlot } from '../../world/legacyHooks.js';

export function formatIslandStats(domain, config) {
  const name = domain?.name || 'Остров';
  const lines = (config?.stats || []).map((def) => {
    const value = Number(domain?.stats?.[def.id]);
    return `${def.name}: ${formatStatValue(value, config)}`;
  });
  return [`${name}`, ...lines].join('\n');
}

export function formatIslandPlotlines(domain) {
  const list = (domain?.plotlines || []).filter((plot) => plot && isStoryPlot(plot));
  const fronts = (domain?.fronts || []).filter((front) => front && front.status !== 'resolved');
  const frontBlocks = fronts.map((front) => {
    const effort = Number(front.effort) || 0;
    const progress = Number(front.progress) || 0;
    const pct = effort > 0 ? Math.round((100 * progress) / effort) : 0;
    const shown = Math.round(progress * 10) / 10;
    return `«${front.description || 'дело города'}» · ${pct}% · ${shown} / ${effort}`;
  });
  if (!list.length && !frontBlocks.length) return `${domain?.name || 'Остров'}: открытых историй нет.`;
  const blocks = list.map((p) => {
    const head =
      p.urgency != null || p.gravity != null
        ? `«${p.title}» (история) · срочность ${p.urgency ?? '—'} · масштаб ${p.gravity ?? '—'}`
        : `«${p.title}» (история)`;
    const parts = [head];
    if (p.synopsis) parts.push(p.synopsis);
    if (p.closeWhen) parts.push(`закроется, когда: ${p.closeWhen}`);
    return parts.join('\n');
  });
  return [`${domain.name} · ${list.length}`, ...frontBlocks, ...blocks].join('\n\n');
}
