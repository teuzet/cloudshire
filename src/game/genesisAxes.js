/**
 * Генеративные оси Genesis 2: семпл, анкета, формат для concept.
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
    const name = val?.name || row.value;
    const about = val?.about ? ` — ${val.about}` : '';
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

/** Hardcoded дерево 4–7 вопросов. Первый всегда «что важнее». */
export const QUESTIONNAIRE_ROOT = 'root';

export function questionnaireNode(nodeId, config) {
  const axisChoice = (id, axisId, prompt, next) => {
    const group = genesisAxisById(config, axisId);
    const values = group?.values || [];
    return {
      id,
      kind: 'axis',
      axisId,
      prompt,
      next,
      options: values.map((v) => ({ id: v.id, label: v.name, about: v.about || '' })),
    };
  };
  const nodes = {
    root: {
      id: 'root',
      kind: 'branch',
      prompt: 'Что тебе важнее определить самому?',
      options: [
        { id: 'nature', label: 'природу острова', next: 'nature_land' },
        { id: 'city', label: 'сам город', next: 'city_pattern' },
        { id: 'society', label: 'общество', next: 'society_order' },
        { id: 'economy', label: 'хозяйство', next: 'economy_base' },
        { id: 'history', label: 'историю', next: 'history_cond' },
        { id: 'feature', label: 'хочу странную местную особенность', next: 'feature_text' },
        { id: 'surprise', label: 'удиви меня', next: null, sampleRest: true },
      ],
    },
    nature_land: axisChoice('nature_land', 'landscapeForm', 'Какая макроформа острова ближе?', 'nature_climate'),
    nature_climate: axisChoice('nature_climate', 'climateBand', 'Какой климат?', 'nature_extent'),
    nature_extent: {
      ...axisChoice('nature_extent', 'settlementExtent', 'Насколько остров освоен?', null),
      options: [
        { id: 'skip', label: 'не важно — реши сам', about: '' },
        ...(genesisAxisById(config, 'settlementExtent')?.values || []).map((v) => ({
          id: v.id,
          label: v.name,
          about: v.about || '',
        })),
      ],
    },
    city_pattern: axisChoice('city_pattern', 'settlementPattern', 'Как сидит город на острове?', 'city_extent'),
    city_extent: axisChoice('city_extent', 'settlementExtent', 'Насколько плотно освоена земля?', null),
    society_order: axisChoice('society_order', 'socialOrder', 'Кто держит порядок в городе?', 'society_temper'),
    society_temper: axisChoice('society_temper', 'civicTemper', 'Какой нрав горожан?', null),
    economy_base: axisChoice('economy_base', 'productiveBase', 'Чем в основном живут?', null),
    history_cond: axisChoice('history_cond', 'historicalCondition', 'Какое сейчас время города?', null),
    feature_text: {
      id: 'feature_text',
      kind: 'freeform',
      prompt: 'Опиши особенность своими словами. Это станет обязательным фактом города.',
      next: null,
      required: true,
    },
  };
  return nodes[nodeId] || null;
}

export function emptyQuestionnaire() {
  return { path: [], answers: [], next: QUESTIONNAIRE_ROOT };
}

export function normalizeQuestionnaire(raw) {
  const q = raw && typeof raw === 'object' ? raw : {};
  return {
    path: Array.isArray(q.path) ? q.path.map(String) : [],
    answers: Array.isArray(q.answers)
      ? q.answers.map((a) => ({
          nodeId: String(a.nodeId || ''),
          optionId: a.optionId != null ? String(a.optionId) : null,
          text: a.text ? String(a.text) : null,
        }))
      : [],
    next: q.next == null ? null : String(q.next),
    sampleRest: Boolean(q.sampleRest),
  };
}

function normOpt(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/** Сопоставить optionId или свободный текст с вариантом узла. Без уникального попадания — null. */
export function matchQuestionnaireOption(node, { optionId, text } = {}) {
  const opts = node?.options || [];
  if (!opts.length) return null;
  const idRaw = String(optionId || '').trim();
  if (idRaw) {
    const byId = opts.find((o) => o.id === idRaw || normOpt(o.id) === normOpt(idRaw));
    if (byId) return byId;
  }
  const raw = normOpt(text);
  if (!raw) return null;
  const exactId = opts.find((o) => normOpt(o.id) === raw);
  if (exactId) return exactId;
  const exactLabel = opts.find((o) => normOpt(o.label) === raw);
  if (exactLabel) return exactLabel;
  const contained = opts.filter((o) => {
    const label = normOpt(o.label);
    return label.length >= 4 && raw.includes(label);
  });
  if (contained.length === 1) return contained[0];
  if (contained.length > 1) {
    contained.sort((a, b) => normOpt(b.label).length - normOpt(a.label).length);
    if (normOpt(contained[0].label).length > normOpt(contained[1].label).length) return contained[0];
  }
  return null;
}

export function formatQuestionnaireNode(node) {
  if (!node) return null;
  return {
    id: node.id,
    prompt: node.prompt,
    kind: node.kind,
    options: (node.options || []).map((o) => ({ id: o.id, label: o.label })),
  };
}

function questionnaireReachedLeaf(q) {
  const cur = normalizeQuestionnaire(q);
  if (cur.sampleRest) return true;
  if (cur.next) return false;
  if (!cur.answers.length) return false;
  if (cur.path.some((id) => id !== QUESTIONNAIRE_ROOT)) return true;
  return cur.answers.some((a) => a.nodeId === QUESTIONNAIRE_ROOT && a.optionId === 'surprise');
}

export function questionnaireComplete(q) {
  return questionnaireReachedLeaf(q);
}

/** Текущий узел дерева или null, если анкета закрыта. */
export function questionnaireCurrentNodeId(q) {
  const cur = normalizeQuestionnaire(q);
  if (questionnaireReachedLeaf(cur)) return null;
  return cur.next || QUESTIONNAIRE_ROOT;
}

export function applyQuestionnaireAnswer(q, config, { nodeId, optionId, text } = {}) {
  const cur = normalizeQuestionnaire(q);
  const node = questionnaireNode(nodeId || questionnaireCurrentNodeId(cur) || QUESTIONNAIRE_ROOT, config);
  if (!node) return cur;

  if (node.kind === 'freeform') {
    const body = String(text || '').trim();
    if (!body) return cur;
    cur.answers.push({ nodeId: node.id, optionId: null, text: body });
    cur.path.push(node.id);
    cur.next = node.next || null;
    return cur;
  }

  const opt = matchQuestionnaireOption(node, { optionId, text });
  if (!opt) return cur;

  cur.answers.push({
    nodeId: node.id,
    optionId: opt.id,
    text: text ? String(text) : null,
  });
  cur.path.push(node.id);
  if (node.kind === 'branch') {
    cur.next = opt.next ?? null;
    if (opt.sampleRest) cur.sampleRest = true;
    return cur;
  }
  cur.next = node.next || null;
  return cur;
}

export function applyQuestionnaireToAxes(config, axes, q, directives) {
  let nextAxes = normalizeAxesState(axes);
  const d = { required: [...(directives?.required || [])] };
  const quiz = normalizeQuestionnaire(q);
  for (const a of quiz.answers) {
    const node = questionnaireNode(a.nodeId, config);
    if (!node) continue;
    if (node.kind === 'axis' && a.optionId && a.optionId !== 'skip') {
      nextAxes = setAxisValue(nextAxes, node.axisId, a.optionId, 'player');
    }
    if (node.kind === 'freeform' && a.text) d.required.push(a.text);
    if (node.kind === 'branch' && a.optionId === 'feature' && a.text) d.required.push(a.text);
  }
  return { axes: nextAxes, extraRequired: d.required };
}

const AXIS_QUESTIONS = {
  landscapeForm: 'Какая макроформа острова ближе?',
  climateBand: 'Какой климат?',
  settlementPattern: 'Как сидит город на острове?',
  productiveBase: 'Чем в основном живут?',
  socialOrder: 'Кто держит порядок в городе?',
  signatureDomain: 'Какая местная особенность узнаваема с первого взгляда?',
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
  return {
    axisId,
    name: group.name || axisId,
    prompt: AXIS_QUESTIONS[axisId] || `Как быть с «${group.name || axisId}»?`,
    options: (group.values || []).map((v) => ({
      id: v.id,
      label: v.name,
      about: v.about || '',
    })),
    extras: [
      { id: 'random', label: 'случайное — пусть система выберет' },
      { id: 'agent', label: 'на усмотрение ведущего' },
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
