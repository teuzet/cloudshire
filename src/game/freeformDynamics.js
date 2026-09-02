/**
 * Динамика хода freeform: драматургическая механика следующего шага.
 * Концовки (GOOD/NEUTRAL/BAD_ENDING) не входят в обычный пул — только по правилам посадки.
 */

export const DEFAULT_BEAT_DYNAMICS = [
  {
    id: 'PLOT_TWIST',
    name: 'Поворот',
    weight: 8,
    polarities: ['good', 'bad'],
    hint: 'то же дело оказывается другим, чем читалось; двигатель не подменяй',
  },
  {
    id: 'POLARIZATION',
    name: 'Поляризация',
    weight: 8,
    polarities: ['good', 'bad'],
    hint: 'лагеря расходятся, середины меньше, выбор жёстче',
  },
  {
    id: 'DEADLOCK',
    name: 'Тупик',
    weight: 6,
    polarities: ['bad'],
    hint: 'попытки блокируют друг друга; стоит, но не отпускает',
  },
  {
    id: 'COMPLICATION',
    name: 'Осложнение',
    weight: 10,
    polarities: ['bad'],
    hint: 'в тот же механизм входит новая помеха, не новая история',
  },
  {
    id: 'REVERSAL',
    name: 'Разворот',
    weight: 8,
    polarities: ['good', 'bad'],
    hint: 'прежнее направление меняется на противоположное',
  },
  {
    id: 'REVELATION',
    name: 'Прояснение',
    weight: 7,
    polarities: ['good', 'bad'],
    hint: 'становится видно уже лежащее в истории; новую тайну не выдумывай',
  },
  {
    id: 'BREAKTHROUGH',
    name: 'Прорыв',
    weight: 8,
    polarities: ['good', 'bad'],
    hint: 'застрявшее приходит в движение',
  },
];

export const ENDING_BEAT_DYNAMICS = [
  {
    id: 'GOOD_ENDING',
    name: 'Хороший конец',
    weight: 1,
    polarities: ['good'],
    ending: true,
    hint: 'случилась хорошая концовка из карточки; история закрывается',
  },
  {
    id: 'NEUTRAL_ENDING',
    name: 'Нейтральный конец',
    weight: 1,
    polarities: ['good', 'bad'],
    ending: true,
    hint: 'случилась нейтральная концовка из карточки; история закрывается',
  },
  {
    id: 'BAD_ENDING',
    name: 'Плохой конец',
    weight: 1,
    polarities: ['bad'],
    ending: true,
    hint: 'случилась плохая концовка из карточки; история закрывается',
  },
];

function asPolarities(raw) {
  const list = Array.isArray(raw) ? raw : String(raw || '').split(/[\s,]+/);
  const out = [];
  for (const item of list) {
    const p = String(item || '')
      .trim()
      .toLowerCase();
    if (p === 'good' || p === 'bad') out.push(p);
  }
  return [...new Set(out)];
}

export function normalizeBeatDynamics(raw) {
  const list = Array.isArray(raw) && raw.length ? raw : DEFAULT_BEAT_DYNAMICS;
  return list
    .map((item, i) => {
      const id = String(item?.id || '')
        .trim()
        .toUpperCase()
        .replace(/[\s-]+/g, '_');
      const name = String(item?.name || id).trim();
      const hint = String(item?.hint || '').trim();
      const weight = Number(item?.weight);
      const polarities = asPolarities(item?.polarities);
      if (!id) return null;
      return {
        id,
        name: name || id,
        hint,
        weight: Number.isFinite(weight) && weight > 0 ? weight : 1,
        polarities: polarities.length ? polarities : ['good', 'bad'],
        ending: Boolean(item?.ending) || id.endsWith('_ENDING'),
        index: i,
      };
    })
    .filter(Boolean);
}

function pickWeighted(tags, rng) {
  const weights = tags.map((t) => {
    const w = Number(t?.weight);
    return Number.isFinite(w) && w > 0 ? w : 1;
  });
  const total = weights.reduce((a, b) => a + b, 0) || tags.length;
  let r = rng() * total;
  for (let i = 0; i < tags.length; i += 1) {
    r -= weights[i];
    if (r <= 0) return tags[i];
  }
  return tags[tags.length - 1];
}

/** Осевой фильтр: пока пустой. POLARIZATION/DEADLOCK режем по осям, не вычёркиваем из каталога. */
export function blockedBeatDynamicsForPlot(_plot) {
  return new Set();
}

export function listLegalBeatDynamics(config, plot = null, { polarity = null, endings = false } = {}) {
  const blocked = blockedBeatDynamicsForPlot(plot);
  const raw = endings
    ? ENDING_BEAT_DYNAMICS
    : config?.tick?.plot?.freeform?.beatDynamics;
  return normalizeBeatDynamics(raw).filter((d) => {
    if (blocked.has(d.id)) return false;
    if (endings ? !d.ending : d.ending) return false;
    if (polarity === 'good' || polarity === 'bad') return (d.polarities || []).includes(polarity);
    return true;
  });
}

export function pickFreeformBeatDynamics(config, n = 3, rng = Math.random, plot = null, { polarity = null } = {}) {
  const want = Math.max(1, Math.round(Number(n) || 3));
  const remaining = [...listLegalBeatDynamics(config, plot, { polarity, endings: false })];
  const out = [];
  for (let i = 0; i < want && remaining.length; i += 1) {
    const picked = pickWeighted(remaining, rng);
    out.push(picked);
    const idx = remaining.findIndex((t) => t.id === picked.id);
    if (idx >= 0) remaining.splice(idx, 1);
  }
  if (out.length < want && remaining.length === 0) {
    const pool = listLegalBeatDynamics(config, plot, { polarity, endings: false });
    while (out.length < want && pool.length) {
      out.push(pickWeighted(pool, rng));
    }
  }
  return out;
}

export function endingDynamicByKind(kind) {
  const id = String(kind || '')
    .trim()
    .toUpperCase();
  return ENDING_BEAT_DYNAMICS.find((d) => d.id === id) || ENDING_BEAT_DYNAMICS[1];
}

export function formatBeatDynamicsForPrompt(dynamics) {
  if (!dynamics?.length) return '';
  return [
    'Способы сдвига — по одному абзацу на каждый, в этом порядке:',
    ...dynamics.map((d, i) => {
      const label = d.name || d.id;
      const hint = d.hint ? ` — ${d.hint}` : '';
      const ending = d.endingText ? ` Концовка, которую надо явить: ${d.endingText}` : '';
      return `${i + 1}. ${label}${hint}.${ending}`;
    }),
  ].join('\n');
}

export function attachBeatDynamics(blank, dynamic) {
  if (!blank) return null;
  if (!dynamic) return blank;
  const id = dynamic.id || dynamic.dynamicId || '';
  const name = dynamic.name || dynamic.dynamicName || '';
  const hint = dynamic.hint || dynamic.dynamicHint || '';
  if (!id && !name) return blank;
  return {
    ...blank,
    dynamicId: id,
    dynamicName: name,
    dynamicHint: hint,
    dynamics: name || blank.dynamics || '',
    endingId: dynamic.endingId || blank.endingId || '',
    endingText: dynamic.endingText || blank.endingText || '',
    endingKind: dynamic.endingKind || blank.endingKind || '',
  };
}
