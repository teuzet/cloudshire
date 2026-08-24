const REVEAL_MAX = 3200;

function clipProse(text, max) {
  const t = String(text || '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!t) return '';
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const last = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('\n'), cut.lastIndexOf(' '));
  return (last > max * 0.55 ? cut.slice(0, last) : cut).replace(/[\s,;:—-]+$/, '');
}

function overviewText(domain) {
  const overview = String(domain?.aspects?.overview || '').trim();
  if (overview) return clipProse(overview, REVEAL_MAX);
  const facts = (domain?.lore || [])
    .filter((f) => !(f.tags || []).includes('meta'))
    .map((f) => String(f.text || '').trim())
    .filter(Boolean)
    .slice(0, 5);
  if (facts.length) return facts.join(' ');
  return clipProse(domain?.description, REVEAL_MAX);
}

/** Короткий рассказ об острове после генезиса: фишки, не теги и не приветствие правителя. */
export function formatIslandReveal(domain) {
  const name = String(domain?.name || 'Остров').trim();
  const ruler = domain?.characters?.[0];
  const body = overviewText(domain);
  const lines = [`Остров «${name}» готов.`];
  if (body) lines.push('', body);
  if (ruler?.name) {
    const title = ruler.title || 'Правитель';
    lines.push('', `С тобой будет говорить ${title} ${ruler.name}.`);
  }
  return lines.join('\n');
}
