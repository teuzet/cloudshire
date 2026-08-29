/**
 * Причинный граф тайны: канон мира + информационная маска.
 * Узлы и рёбра после посева не переписываем — меняются только статусы знания.
 *
 * Форму графа выбирает движок. Маску на посеве тоже: видим X — последнее
 * наблюдаемое следствие главной цепи; в linear_side с шансом ещё боковую причину E.
 * в linear_side с шансом ещё и боковую причину E. Агент knowledge не ставит.
 * Дальше маску двигает applyEngineReveal: фронтир (причина известного) или полное resolved.
 */

export const MASK_STATES = ['hidden', 'observed'];
export const KNOWLEDGE_STATES = [...MASK_STATES, 'resolved'];

const KNOWLEDGE_LABEL = {
  hidden: 'скрыто',
  observed: 'замечено',
  resolved: 'понято',
};

const RANK = { hidden: 0, observed: 1, resolved: 2 };
const LEGACY_KNOWLEDGE = { misread: 'observed', connected: 'observed' };

export const NODE_TEXT_MAX = 720;
export const EDGE_REASON_MAX = 400;
export const OBSERVED_FACT_MAX = 240;
export const RESOLUTION_FACT_MAX = 180;

export const GRAPH_SHAPE_DEFAULTS = [
  { id: 'linear_4', weight: 1 },
  { id: 'linear_5', weight: 0 },
  { id: 'linear_side', weight: 0 },
];

export const GRAPH_SHAPES = GRAPH_SHAPE_DEFAULTS.map((s) => s.id);

const SHAPE_IDS = new Set(GRAPH_SHAPES);

function clip(s, max) {
  const t = String(s || '').trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max).replace(/[\s,;:—-]+$/, '')}…`;
}

function asState(raw, fallback = 'hidden') {
  const s = String(raw || '').trim().toLowerCase();
  if (LEGACY_KNOWLEDGE[s]) return LEGACY_KNOWLEDGE[s];
  return KNOWLEDGE_STATES.includes(s) ? s : fallback;
}

function nodeId(raw) {
  return String(raw || '')
    .trim()
    .replace(/\s+/g, '_')
    .slice(0, 24);
}

function edgeKey(from, to) {
  return `${from}→${to}`;
}

function bump(current, next) {
  const a = asState(current);
  const b = asState(next, a);
  return RANK[b] > RANK[a] ? b : a;
}

export function parseMysteryShapes(raw) {
  const src = Array.isArray(raw) && raw.length ? raw : GRAPH_SHAPE_DEFAULTS;
  const out = [];
  for (const item of src) {
    const id = String(item?.id || item || '').trim();
    if (!SHAPE_IDS.has(id)) continue;
    const weight = Math.max(0, Number(item?.weight ?? 1));
    out.push({ id, weight: Number.isFinite(weight) ? weight : 1 });
  }
  return out.length ? out : GRAPH_SHAPE_DEFAULTS.map((s) => ({ ...s }));
}

export function graphNodeCount(shape) {
  return shape === 'linear_5' || shape === 'linear_side' ? 5 : 4;
}

export function pickMysteryGraphShape(cfg, rng = Math.random) {
  const list = parseMysteryShapes(cfg?.mysteryGraph?.shapes);
  const live = list.filter((s) => s.weight > 0);
  const pool = live.length ? live : list;
  const total = pool.reduce((sum, s) => sum + s.weight, 0) || pool.length;
  let r = rng() * total;
  for (const item of pool) {
    r -= item.weight || 1;
    if (r < 0) return item.id;
  }
  return pool[pool.length - 1].id;
}

export function pickMysteryGraphSize(_cfg, _rng, shape = 'linear_4') {
  return graphNodeCount(shape);
}

export function formatMysteryCausalContractForPrompt() {
  return [
    'КОНТРАКТ УЗЛА (жёстко):',
    'Узел — полное событие: кто, что сделал, зачем, как. Не атмосфера и не ярлык. Краткость не оправдывает дыру.',
    'Предмет, вещество, текст, группа: что это и откуда взялись — в этом узле или в предыдущем. «Нашёл лежащее» без того, кто положил, нельзя.',
    'Если человек знает, что нечто опасно, запретно или нужно скрыть — откуда знает (видел печать, сказали по должности, сам делал). Без источника нельзя.',
    'Физическое следствие — физическая или ремесленная причина. Обряд и «воздействие» не заменяют механизм. Магия не склеивает цепь.',
    'Не вводи вещь, которой нет в якорях и в других узлах. A — причина, не находка необъяснённого; такая находка для игрока — X.',
    'Не сшивай два разных сюжета паникой одного человека. Ассоциативное поле — слабый импульс, не вторая завязка.',
    'Ребро reason — два коротких предложения: механизм parent → child и counterfactual (что было бы без parent). Без новых сущностей. resolutionFacts опираются только на то, что уже названо в узлах.',
  ].join('\n');
}

export function formatMysteryGraphShapeForPrompt(shape, _opts = {}) {
  const xLine = 'X — завязка для игрока: последнее наблюдаемое следствие, к которому всё привело. Этот id обязателен.';
  const contract = formatMysteryCausalContractForPrompt();
  if (shape === 'linear_5') {
    return [
      'ШАБЛОН ГРАФА (обязателен): линейный из 5 узлов. A → B → C → D → X.',
      'Рёбер ровно 4. Без ответвлений и без параллельных причин.',
      xLine,
      contract,
    ].join('\n');
  }
  if (shape === 'linear_side') {
    return [
      'ШАБЛОН ГРАФА (обязателен): главная цепь A → B → C → X и дополнительная ПРИЧИНА E.',
      'E → B или E → C. E — отдельная причина одного из средних узлов, не следствие из цепи.',
      'Ровно 5 узлов и 4 ребра. У E нет входа и нет продолжения дальше B/C.',
      xLine,
      contract,
    ].join('\n');
  }
  return [
    'ШАБЛОН ГРАФА (обязателен): линейный из 4 узлов. A → B → C → X.',
    'Рёбер ровно 3. Без ответвлений и без параллельных причин.',
    xLine,
    contract,
  ].join('\n');
}

export function formatMysteryMaskForPrompt(shape, { sideOpen = false, forCore = false } = {}) {
  const hard = forCore
    ? [
        'ВИДИМОЕ ДЛЯ ИГРОКА — ТОЛЬКО X. observedFacts бери только из текста X, почти дословно.',
        'Скрытые узлы, связи, мотив, виновный, вещество — в observedFacts нельзя даже намёком.',
        'Граф истины пиши полностью. Не пиши synopsis, entry, closeWhen.',
      ]
    : [
        'ПЕРВАЯ ХРОНИКА И СИНОПСИС — ТОЛЬКО ИЗВЕСТНАЯ ЧАСТЬ ТАЙНЫ (жёстко).',
        'entry — что город УЖЕ заметил: симптом, слух, странность на поверхности. Без причины.',
        'synopsis — как город это сейчас понимает из того же видимого. Не полный сюжет и не разгадка.',
        'Скрытые узлы, скрытые связи, мотив, виновный, вещество, замысел — в entry и synopsis нельзя даже намёком.',
        'Не пересказывай скрытый узел другими словами. Граф истины пиши полностью, повествование — только из видимого.',
      ];
  if (shape === 'linear_5') {
    return [
      'МАСКА ЗНАНИЯ (решила система, не выбирай её):',
      'Видимо городу: только X — последнее наблюдаемое следствие, завязка тайны.',
      'Скрыто: A, B, C, D и все связи.',
      ...hard,
    ].join('\n');
  }
  if (shape === 'linear_side') {
    return sideOpen
      ? [
          'МАСКА ЗНАНИЯ (решила система, не выбирай её):',
          'Видимо городу: X (последнее наблюдаемое следствие) и E (боковая причина).',
          'Скрыто: A, B, C и все связи.',
          ...hard,
          'X и E можно показать как два замеченных факта. Скрытую связь между ними не называй.',
        ].join('\n')
      : [
          'МАСКА ЗНАНИЯ (решила система, не выбирай её):',
          'Видимо городу: только X — последнее наблюдаемое следствие, завязка тайны.',
          'Скрыто: A, B, C, E и все связи.',
          ...hard,
          'E не упоминай.',
        ].join('\n');
  }
  return [
    'МАСКА ЗНАНИЯ (решила система, не выбирай её):',
    'Видимо городу: только X — последнее наблюдаемое следствие, завязка тайны.',
    'Скрыто: A, B, C и все связи.',
    ...hard,
  ].join('\n');
}

/** Если в публичном тексте есть скрытый узел — его id; иначе null. */
export function mysteryPublicLeak(graph, texts) {
  const pub = foldMysteryText([].concat(texts || []).join(' '));
  if (!pub) return null;
  for (const n of graph?.nodes || []) {
    if (n.knowledge !== 'hidden') continue;
    if (hiddenSpanLeaks(pub, n.text)) return n.id;
  }
  for (const e of graph?.edges || []) {
    if (e.knowledge !== 'hidden') continue;
    if (hiddenSpanLeaks(pub, e.reason, 16)) return `${e.from}→${e.to}`;
  }
  return null;
}

export function graphOverflows(raw) {
  for (const n of raw?.nodes || []) {
    const t = String(n?.text || n?.description || '').trim();
    if (t.length > NODE_TEXT_MAX) return 'truncated_node';
  }
  for (const e of raw?.edges || []) {
    const t = String(e?.reason || '').trim();
    if (t.length > EDGE_REASON_MAX) return 'truncated_edge';
  }
  return null;
}

export function normalizeFactList(raw, { maxItems = 5, maxLen = OBSERVED_FACT_MAX } = {}) {
  const out = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    const t = String(item?.text || item || '')
      .trim()
      .replace(/\s+/g, ' ');
    if (!t) continue;
    if (t.length > maxLen) return { facts: out, reason: 'truncated_fact' };
    out.push(t);
    if (out.length >= maxItems) break;
  }
  return { facts: out, reason: null };
}

export function terminalNode(graph) {
  return (
    (graph?.nodes || []).find((n) => String(n.id).toUpperCase() === 'X') ||
    (graph?.nodes || []).find((n) => n.knowledge === 'observed') ||
    null
  );
}

function backedBy(sourceText, fact, minLen = 10) {
  const src = foldMysteryText(sourceText);
  const t = foldMysteryText(fact);
  if (!src || !t) return false;
  if (src.includes(t) || t.includes(src)) return true;
  return hiddenSpanLeaks(src, fact, minLen);
}

/** observedFacts — 2–5 пунктов, каждый из X, без скрытых узлов. */
export function observedFactsIssue(facts, graph) {
  if (!Array.isArray(facts) || facts.length < 2) return 'thin_observed';
  const x = terminalNode(graph);
  if (!x?.text) return 'missing_x';
  for (const f of facts) {
    const leak = mysteryPublicLeak(graph, [f]);
    if (leak) return 'observed_leak';
    if (!backedBy(x.text, f, 10)) return 'observed_not_in_x';
  }
  return null;
}

/** resolutionFacts — 2–5 неизвестных; ключевые слова уже есть в узлах. */
export function resolutionFactsIssue(facts, graph) {
  if (!Array.isArray(facts) || facts.length < 2) return 'thin_resolution';
  const all = foldMysteryText((graph?.nodes || []).map((n) => n.text).join(' '));
  for (const f of facts) {
    const words = foldMysteryText(f)
      .split(' ')
      .filter((w) => w.length >= 5);
    if (!words.length) continue;
    if (!words.some((w) => all.includes(w))) return 'resolution_invention';
  }
  return null;
}

/** Подача: не раскрывать скрытое. Перефраз разрешён. */
export function presentationIssue({ synopsis, entry, closeWhen, graph }) {
  if (!String(synopsis || '').trim() || !String(entry || '').trim()) return 'empty_presentation';
  if (!String(closeWhen || '').trim()) return 'empty_close';
  const leak = mysteryPublicLeak(graph, [synopsis, entry, closeWhen]);
  if (leak) return 'mask_leak';
  return null;
}

function foldMysteryText(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hiddenSpanLeaks(pub, raw, minLen = 12) {
  const t = foldMysteryText(raw);
  if (t.length < minLen) return false;
  if (pub.includes(t)) return true;
  const words = t.split(' ').filter((w) => w.length >= 4);
  if (words.length < 3) return false;
  for (let i = 0; i <= words.length - 3; i += 1) {
    const span = words.slice(i, i + 3).join(' ');
    if (span.length >= minLen && pub.includes(span)) return true;
  }
  return false;
}

export function mysteryGraphShapeHint(shape) {
  if (shape === 'linear_5') {
    return 'Нужен линейный граф из 5 узлов: A → B → C → D → X, ровно 4 ребра. X — последнее наблюдаемое следствие.';
  }
  if (shape === 'linear_side') {
    return 'Нужна цепь A → B → C → X и дополнительная причина E → B или E → C (не следствие из цепи). Ровно 5 узлов и 4 ребра. X — последнее наблюдаемое следствие.';
  }
  return 'Нужен линейный граф из 4 узлов: A → B → C → X, ровно 3 ребра. X — последнее наблюдаемое следствие.';
}

function outgoingMap(nodes, edges) {
  const outs = new Map(nodes.map((n) => [n.id, []]));
  for (const e of edges) {
    if (outs.has(e.from)) outs.get(e.from).push(e.to);
  }
  return outs;
}

function longestNodePath(nodes, edges) {
  const outs = outgoingMap(nodes, edges);
  let best = [];
  function dfs(id, path) {
    const next = (outs.get(id) || []).filter((t) => !path.includes(t));
    if (!next.length) {
      if (path.length > best.length) best = path.slice();
      return;
    }
    for (const t of next) {
      path.push(t);
      dfs(t, path);
      path.pop();
    }
  }
  for (const n of nodes) dfs(n.id, [n.id]);
  return best;
}

function inspectLinearChain(nodes, edges, wantLen) {
  if (nodes.length !== wantLen) return null;
  if (edges.length !== wantLen - 1) return null;
  const path = longestNodePath(nodes, edges);
  if (path.length !== wantLen) return null;
  if (String(path[path.length - 1]).toUpperCase() !== 'X') return null;
  return { path, sideId: null };
}

/** Главная цепь и боковая причина, если форма совпала. */
export function inspectGraphShape(graph, shape) {
  const g = graph?.nodes ? graph : normalizeTruthGraph(graph);
  if (!g) return null;
  if (shape === 'linear_4') return inspectLinearChain(g.nodes, g.edges, 4);
  if (shape === 'linear_5') return inspectLinearChain(g.nodes, g.edges, 5);
  if (shape === 'linear_side') {
    if (g.nodes.length !== 5 || g.edges.length !== 4) return null;
    for (const side of g.nodes) {
      const nodes = g.nodes.filter((n) => n.id !== side.id);
      const edges = g.edges.filter((e) => e.from !== side.id && e.to !== side.id);
      const chain = inspectLinearChain(nodes, edges, 4);
      if (!chain) continue;
      const incident = g.edges.filter((e) => e.from === side.id || e.to === side.id);
      if (incident.length !== 1) continue;
      const edge = incident[0];
      if (edge.from !== side.id) continue;
      const pos = chain.path.indexOf(edge.to);
      if (pos !== 1 && pos !== 2) continue;
      return { path: chain.path, sideId: side.id };
    }
    return null;
  }
  return null;
}

/** null — форма совпала; иначе код отказа. */
export function judgeGraphShape(graph, shape) {
  if (!shape) return null;
  const g = normalizeTruthGraph(graph);
  if (!g) return 'missing_graph';
  return inspectGraphShape(g, shape) ? null : 'wrong_shape';
}

/**
 * Принимает ответ агента (nodes/edges) или уже собранный граф.
 * Маску из knowledge[] агента не берём — её ставит applySeedVisibility.
 * knowledge на самих узлах/рёбрах сохраняем (уже посеянный граф).
 */
export function normalizeTruthGraph(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const nodes = [];
  const seen = new Set();
  for (const item of raw.nodes || []) {
    const id = nodeId(item?.id);
    const text = clip(item?.text || item?.description, NODE_TEXT_MAX);
    if (!id || !text || seen.has(id)) continue;
    seen.add(id);
    nodes.push({
      id,
      text,
      knowledge: asState(item?.knowledge || item?.status, 'hidden'),
    });
  }
  if (nodes.length < 2) return null;
  const ids = new Set(nodes.map((n) => n.id));
  const edges = [];
  const edgeSeen = new Set();
  for (const item of raw.edges || []) {
    const from = nodeId(item?.from);
    const to = nodeId(item?.to);
    if (!ids.has(from) || !ids.has(to) || from === to) continue;
    const key = edgeKey(from, to);
    if (edgeSeen.has(key)) continue;
    edgeSeen.add(key);
    edges.push({
      from,
      to,
      reason: clip(item?.reason, EDGE_REASON_MAX),
      knowledge: asState(item?.knowledge || item?.status, 'hidden'),
    });
  }
  if (!edges.length) return null;
  return { nodes, edges };
}

/** Система: видим последний узел главной цепи; в linear_side иногда ещё E. */
export function applySeedVisibility(graph, { shape, sideOpen = false } = {}) {
  if (!graph?.nodes) return graph;
  for (const n of graph.nodes) n.knowledge = 'hidden';
  for (const e of graph.edges) e.knowledge = 'hidden';
  const info = inspectGraphShape(graph, shape);
  const lastId = info?.path?.[info.path.length - 1];
  const last = lastId ? graph.nodes.find((n) => n.id === lastId) : graph.nodes[graph.nodes.length - 1];
  if (last) last.knowledge = 'observed';
  if (shape === 'linear_side' && sideOpen && info?.sideId) {
    const side = graph.nodes.find((n) => n.id === info.sideId);
    if (side) side.knowledge = 'observed';
  }
  return graph;
}

export function judgeTruthGraph(graph, { minNodes = 4, maxNodes = 6, shape = null } = {}) {
  const g = normalizeTruthGraph(graph);
  if (!g) return 'missing_graph';
  const want = shape ? graphNodeCount(shape) : null;
  const lo = want || minNodes;
  const hi = want || maxNodes;
  if (g.nodes.length < lo) return 'thin_graph';
  if (g.nodes.length > hi) return 'fat_graph';
  return judgeGraphShape(g, shape);
}

export function formatTruthGraphForPrompt(graph) {
  const g = normalizeTruthGraph(graph);
  if (!g) return '';
  const nodeLines = g.nodes.map(
    (n) => `- ${n.id} [${KNOWLEDGE_LABEL[n.knowledge] || n.knowledge}]: ${n.text}`,
  );
  const edgeLines = g.edges.map((e) => {
    const why = e.reason ? ` — ${e.reason}` : '';
    return `- ${e.from} → ${e.to} [${KNOWLEDGE_LABEL[e.knowledge] || e.knowledge}]${why}`;
  });
  return [
    'ПРИЧИННЫЙ ГРАФ (канон истины; узлы и рёбра не переписывай, меняй только статусы знания):',
    'Узлы:',
    ...nodeLines,
    'Связи:',
    ...edgeLines,
  ]
    .filter(Boolean)
    .join('\n');
}

export function graphTexts(graph) {
  const g = graph?.nodes ? graph : null;
  if (!g) return [];
  return [...g.nodes.map((n) => n.text), ...g.edges.map((e) => e.reason)];
}

export function applyGraphTexts(graph, texts) {
  if (!graph?.nodes) return graph;
  const next = {
    nodes: graph.nodes.map((n) => ({ ...n })),
    edges: graph.edges.map((e) => ({ ...e })),
  };
  const list = Array.isArray(texts) ? texts : [];
  let i = 0;
  for (const n of next.nodes) {
    if (list[i] != null) n.text = String(list[i]);
    i += 1;
  }
  for (const e of next.edges) {
    if (list[i] != null) e.reason = String(list[i]);
    i += 1;
  }
  return next;
}

function findNode(graph, id) {
  const key = nodeId(id);
  return graph.nodes.find((n) => n.id === key) || null;
}

function findEdge(graph, from, to) {
  const a = nodeId(from);
  const b = nodeId(to);
  return graph.edges.find((e) => e.from === a && e.to === b) || null;
}

/** Агент сообщает, какие узлы/рёбра стали доступнее. Понижать статус нельзя. */
export function applyKnowledgeUpdates(graph, updates = []) {
  if (!graph?.nodes) return graph;
  delete graph.hypothesis;
  for (const u of Array.isArray(updates) ? updates : []) {
    const status = asState(u?.status, '');
    if (!status) continue;
    if (u.kind === 'edge' || u.to || String(u.id || '').includes('→')) {
      const [from, to] = u.to ? [u.from || u.id, u.to] : String(u.id).split('→');
      const edge = findEdge(graph, from, to);
      if (edge) edge.knowledge = bump(edge.knowledge, status);
      continue;
    }
    const node = findNode(graph, u.id);
    if (node) node.knowledge = bump(node.knowledge, status);
  }
  return graph;
}

function isKnown(node) {
  return node?.knowledge === 'observed' || node?.knowledge === 'resolved';
}

function knownIds(graph) {
  return new Set((graph?.nodes || []).filter(isKnown).map((n) => n.id));
}

/** Скрытые непосредственные причины уже известных узлов. */
export function listFrontierNodes(graph) {
  if (!graph?.nodes) return [];
  const known = knownIds(graph);
  const out = [];
  for (const n of graph.nodes) {
    if (n.knowledge !== 'hidden') continue;
    const edges = (graph.edges || []).filter((e) => e.from === n.id && known.has(e.to));
    if (edges.length) out.push({ node: n, edges });
  }
  return out;
}

export function remainingHiddenNodeIds(graph, extraOpen = []) {
  const extra = new Set((extraOpen || []).map(String));
  return (graph?.nodes || [])
    .filter((n) => n.knowledge === 'hidden' && !extra.has(n.id))
    .map((n) => n.id);
}

/**
 * Ближайшая к известному концу скрытая причина; при нескольких — случайная.
 * На линейной цепи это всегда следующий узел к корню от X.
 */
export function pickFrontierReveal(graph, rng = Math.random) {
  if (!graph?.nodes) return null;
  let list = listFrontierNodes(graph);
  if (!list.length) {
    const hidden = graph.nodes.filter((n) => n.knowledge === 'hidden');
    if (!hidden.length) return null;
    const n = hidden[Math.min(hidden.length - 1, Math.floor(rng() * hidden.length))];
    return { nodeId: n.id, edge: null };
  }
  const pick = list[Math.min(list.length - 1, Math.floor(rng() * list.length))];
  const edge = pick.edges[0] || null;
  return {
    nodeId: pick.node.id,
    edge: edge ? { from: edge.from, to: edge.to } : null,
  };
}

function openEdge(graph, from, to) {
  const edge = findEdge(graph, from, to);
  if (edge) edge.knowledge = bump(edge.knowledge, 'observed');
}

function resolveAll(graph) {
  for (const n of graph.nodes) n.knowledge = 'resolved';
  for (const e of graph.edges) e.knowledge = 'resolved';
}

/**
 * Движок сказал, что открыть.
 * none — маска не двигается.
 * full при не-fail — всё resolved. full при fail не сбрасывает маску.
 * partial — указанные фронтирные узлы, иначе один фронтир; при fail не resolveAll.
 */
export function applyEngineReveal(
  graph,
  { reveal = 'none', ending = null, openedNodes = [], openedEdges = [], rng = Math.random } = {},
) {
  if (!graph?.nodes) return graph;
  delete graph.hypothesis;
  if (reveal === 'none') return graph;
  if (reveal === 'full') {
    if (ending === 'fail') return graph;
    resolveAll(graph);
    return graph;
  }

  const nodeIds = (Array.isArray(openedNodes) ? openedNodes : []).map(String).filter(Boolean);
  const edges = Array.isArray(openedEdges) ? openedEdges : [];
  if (!nodeIds.length) {
    const picked = pickFrontierReveal(graph, rng);
    if (picked?.nodeId) nodeIds.push(picked.nodeId);
    if (picked?.edge) edges.push(picked.edge);
  }
  for (const id of nodeIds) {
    const node = findNode(graph, id);
    if (node) node.knowledge = bump(node.knowledge, 'observed');
  }
  for (const e of edges) {
    if (!e) continue;
    if (typeof e === 'string' && e.includes('→')) {
      const [from, to] = e.split('→').map((s) => s.trim());
      openEdge(graph, from, to);
    } else if (e.from && e.to) {
      openEdge(graph, e.from, e.to);
    }
  }
  if (ending !== 'fail' && !remainingHiddenNodeIds(graph).length) resolveAll(graph);
  return graph;
}
