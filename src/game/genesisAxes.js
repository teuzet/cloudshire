/**
 * Генеративные оси Genesis 2: семпл, интервью, формат для concept.
 */

export const GENESIS_AXIS_ORDER = [
  'landscapeForm',
  'climateBand',
  'settlementPattern',
  'productiveBase',
  'socialOrder',
  'signatureDomain',
  'settlementExtent',
  'historicalCondition',
  'civicTemper',
  'structuralPressure',
];

function pickWeighted(values, rng) {
  const list = values || [];
  if (!list.length) return null;
  const weights = list.map((v) => Math.max(0, Number(v.weight) || 1));
  const sum = weights.reduce((a, b) => a + b, 0) || list.length;
  let r = rng() * sum;
  for (let i = 0; i < list.length; i += 1) {
    r -= weights[i];
    if (r <= 0) return list[i];
  }
  return list[list.length - 1];
}

export function genesisAxisGroups(config) {
  return config?.genesis?.axes || [];
}

export function genesisAxisById(config, axisId) {
  return genesisAxisGroups(config).find((g) => g.id === axisId) || null;
}

export const AXIS_ID_ALIASES = {
  economy: 'productiveBase',
  era: 'historicalCondition',
};

/** Каталожный id или короткий алиас (economy → productiveBase). */
export function resolveAxisId(config, axisId) {
  const raw = String(axisId || '').trim();
  if (!raw) return null;
  if (genesisAxisById(config, raw)) return raw;
  const aliased = AXIS_ID_ALIASES[raw] || AXIS_ID_ALIASES[raw.toLowerCase()];
  if (aliased && genesisAxisById(config, aliased)) return aliased;
  return null;
}

export function formatOnboardingAxesBlank(config, axes) {
  const state = normalizeAxesState(axes);
  const out = {};
  for (const id of GENESIS_AXIS_ORDER) {
    const group = genesisAxisById(config, id);
    if (!group) continue;
    const row = state[id];
    out[id] = {
      name: group.name || id,
      value: row?.value || null,
    };
  }
  return out;
}

function normalizeAxisToken(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/** Сопоставить ответ с id или русским именем значения оси. */
export function matchAxisValue(group, token) {
  const values = group?.values || group?.tags || [];
  const raw = String(token || '').trim();
  if (!raw || !values.length) return null;
  const n = normalizeAxisToken(raw);
  const byId = values.find((v) => v.id === raw || normalizeAxisToken(v.id) === n);
  if (byId) return byId.id;
  const exactName = values.filter((v) => normalizeAxisToken(v.name) === n);
  if (exactName.length === 1) return exactName[0].id;
  const fuzzy = values.filter((v) => {
    const name = normalizeAxisToken(v.name);
    if (!name) return false;
    if (n.includes(name)) return true;
    if (n.length >= 4 && name.includes(n)) return true;
    const words = name.split(' ').filter((w) => w.length > 2);
    return words.length > 0 && words.every((w) => n.includes(w));
  });
  if (fuzzy.length === 1) return fuzzy[0].id;
  return null;
}

const AXIS_VALUE_MAX = 400;

/** Каталог только при точном id или имени; иначе свободная формулировка. */
export function resolveAxisChoice(group, token) {
  const raw = String(token || '').trim();
  if (!raw) return null;
  const values = group?.values || group?.tags || [];
  const n = normalizeAxisToken(raw);
  const byId = values.find((v) => v.id === raw || normalizeAxisToken(v.id) === n);
  if (byId) return { value: byId.id, catalog: true };
  const byName = values.filter((v) => normalizeAxisToken(v.name) === n);
  if (byName.length === 1) return { value: byName[0].id, catalog: true };
  return { value: raw.slice(0, AXIS_VALUE_MAX), catalog: false };
}

/** Текущая незакрытая ось анкеты. Выдуманный axisId модели не используется. */
export function openAxisTarget(config, axes) {
  const offer = nextAxisOffer(config, axes);
  if (!offer) return null;
  const group = genesisAxisById(config, offer.axisId);
  if (!group) return null;
  return { axisId: offer.axisId, group, offer };
}

export function emptyAxesState() {
  return {};
}

export function normalizeAxesState(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const [id, row] of Object.entries(src)) {
    if (!row) continue;
    if (typeof row === 'string') {
      out[id] = { value: row, source: 'sampled' };
      continue;
    }
    const value = String(row.value || row.tagId || '').trim();
    if (!value) continue;
    out[id] = {
      value,
      source: row.source || 'sampled',
      adaptedFrom: row.adaptedFrom || null,
      adaptedReason: row.adaptedReason || null,
    };
  }
  return out;
}

export function sampleGenesisAxes(config, rng = Math.random, { keep = {}, onlyMissing = false } = {}) {
  const held = normalizeAxesState(keep);
  const out = onlyMissing ? { ...held } : {};
  for (const group of genesisAxisGroups(config)) {
    if (out[group.id] || held[group.id]) {
      if (!out[group.id]) out[group.id] = held[group.id];
      continue;
    }
    let values = group.values || group.tags || [];
    if (group.id === 'structuralPressure') {
      const mild = values.find((v) => v.id === 'NONE_OR_MILD');
      if (mild && rng() < 0.5) {
        out[group.id] = { value: mild.id, source: 'sampled' };
        continue;
      }
      values = values.filter((v) => v.id !== 'NONE_OR_MILD');
    }
    const pick = pickWeighted(values, rng);
    if (pick) out[group.id] = { value: pick.id, source: 'sampled' };
  }
  return out;
}

export function setAxisValue(axes, axisId, value, source = 'player') {
  const next = normalizeAxesState(axes);
  const v = String(value || '').trim();
  if (!v) {
    delete next[axisId];
    return next;
  }
  next[axisId] = { value: v, source };
  return next;
}

export function applyAxisAdaptations(axes, adaptations = []) {
  const next = normalizeAxesState(axes);
  for (const a of adaptations) {
    const id = a.axisId || a.id;
    const value = a.value || a.to;
    if (!id || !value) continue;
    const prev = next[id]?.value || null;
    next[id] = {
      value: String(value),
      source: 'adapted',
      adaptedFrom: a.adaptedFrom || prev,
      adaptedReason: a.adaptedReason || a.reason || null,
    };
  }
  return next;
}

export function formatGenesisAxesForPrompt(config, axes) {
  const state = normalizeAxesState(axes);
  const lines = ['GENERATION AXES (soft, если не PLAYER_REQUIRED):'];
  for (const group of genesisAxisGroups(config)) {
    const row = state[group.id];
    if (!row) continue;
    const val = (group.values || group.tags || []).find((v) => v.id === row.value);
    const custom = !val;
    const name = val?.name || row.value;
    const about = val?.about ? ` — ${val.about}` : custom ? ' — свободная формулировка, держись её' : '';
    const src = row.source ? ` [${row.source}]` : '';
    const adapted = row.adaptedFrom ? ` (сдвинуто с ${row.adaptedFrom}: ${row.adaptedReason || ''})` : '';
    lines.push(`- ${group.id}: ${name}${about}${src}${adapted}`);
  }
  return lines.join('\n');
}

export function axesSnapshotTags(config, axes) {
  const state = normalizeAxesState(axes);
  return genesisAxisGroups(config)
    .map((group) => {
      const row = state[group.id];
      if (!row) return null;
      const val = (group.values || group.tags || []).find((v) => v.id === row.value);
      return {
        groupId: group.id,
        groupName: group.name || group.id,
        tagId: row.value,
        tagName: val?.name || row.value,
        source: row.source || 'sampled',
      };
    })
    .filter(Boolean);
}

const AXIS_QUESTIONS = {
  landscapeForm: 'Какая макроформа острова ближе?',
  climateBand: 'Какой климат?',
  settlementPattern: 'Как сидит город на острове?',
  productiveBase: 'Чем в основном живут?',
  socialOrder: 'Кто держит порядок в городе?',
  signatureDomain: 'Что на острове узнаваемо с первого взгляда? Назови конкретную вещь, не тип вроде «ландшафт».',
  settlementExtent: 'Насколько остров освоен?',
  historicalCondition: 'Какое сейчас время города?',
  civicTemper: 'Какой нрав горожан?',
  structuralPressure: 'Какое напряжение уже давит на город?',
};

export function emptyAxisInterview() {
  return { uniqueFeatureAsked: false, uniqueFeature: null };
}

export function normalizeAxisInterview(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  return {
    uniqueFeatureAsked: Boolean(s.uniqueFeatureAsked),
    uniqueFeature: s.uniqueFeature ? String(s.uniqueFeature) : null,
  };
}

export function missingAxisIds(config, axes) {
  const state = normalizeAxesState(axes);
  return GENESIS_AXIS_ORDER.filter((id) => genesisAxisById(config, id) && !state[id]?.value);
}

export function sampleOneAxis(config, axisId, rng = Math.random) {
  const group = genesisAxisById(config, axisId);
  if (!group) return null;
  const one = sampleGenesisAxes({ genesis: { axes: [group] } }, rng);
  return one[axisId] || null;
}

export function formatAxisOffer(config, axisId) {
  const group = genesisAxisById(config, axisId);
  if (!group) return null;
  const open = Boolean(group.open);
  return {
    axisId,
    name: group.name || axisId,
    open,
    prompt: AXIS_QUESTIONS[axisId] || `Как быть с «${group.name || axisId}»?`,
    options: open
      ? []
      : (group.values || []).map((v) => ({
          id: v.id,
          label: v.name,
          about: v.about || '',
        })),
    extras: [
      { id: 'random', label: 'случайное — тип из каталога' },
      { id: 'agent', label: 'на усмотрение ведущего — можно придумать конкретное' },
    ],
  };
}

export function nextAxisOffer(config, axes) {
  const id = missingAxisIds(config, axes)[0];
  return id ? formatAxisOffer(config, id) : null;
}

export function axesReadyForConcept(config, axes, interview = {}, { uniqueFeatureRequired = false } = {}) {
  if (missingAxisIds(config, axes).length) return false;
  if (uniqueFeatureRequired && !normalizeAxisInterview(interview).uniqueFeatureAsked) return false;
  return true;
}
