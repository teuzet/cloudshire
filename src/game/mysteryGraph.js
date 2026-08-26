/**
 * Причинный граф тайны: канон мира + информационная маска.
 * Узлы и рёбра после посева не переписываем — меняются только статусы знания.
 *
 * Форму графа выбирает движок. Маску на посеве тоже: видим последний узел главной цепи,
 * в linear_side с шансом ещё и боковую причину E. Агент knowledge не ставит.
 * Дальше маску двигает applyEngineReveal. resolved — только полная разгадка движком.
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

const NODE_TEXT_MAX = 280;
const EDGE_REASON_MAX = 200;

export const GRAPH_SHAPE_DEFAULTS = [
  { id: 'linear_4', weight: 2 },
  { id: 'linear_5', weight: 1 },
  { id: 'linear_side', weight: 1 },
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
    const weight = Math.max(0, Number(item?.weight ?? 1) || 0);
    out.push({ id, weight: weight > 0 ? weight : 1 });
  }
  return out.length ? out : GRAPH_SHAPE_DEFAULTS.map((s) => ({ ...s }));
}

export function graphNodeCount(shape) {
  return shape === 'linear_5' || shape === 'linear_side' ? 5 : 4;
}

export function pickMysteryGraphShape(cfg, rng = Math.random) {
  const list = parseMysteryShapes(cfg?.mysteryGraph?.shapes);
  const total = list.reduce((sum, s) => sum + s.weight, 0);
  let r = rng() * total;
  for (const item of list) {
    r -= item.weight;
    if (r < 0) return item.id;
  }
  return list[list.length - 1].id;
}

export function pickMysteryGraphSize(_cfg, _rng, shape = 'linear_4') {
  return graphNodeCount(shape);
}

export function formatMysteryGraphShapeForPrompt(shape, _opts = {}) {
  if (shape === 'linear_5') {
    return [
      'ШАБЛОН ГРАФА (обязателен): линейный из 5 узлов. A → B → C → D → E.',
      'Рёбер ровно 4. Без ответвлений и без параллельных причин.',
    ].join('\n');
  }
  if (shape === 'linear_side') {
    return [
      'ШАБЛОН ГРАФА (обязателен): главная цепь A → B → C → D и дополнительная ПРИЧИНА E.',
      'E → B или E → C. E — отдельная причина одного из средних узлов, не следствие из цепи.',
      'Ровно 5 узлов и 4 ребра. У E нет входа и нет продолжения дальше B/C.',
    ].join('\n');
  }
  return [
    'ШАБЛОН ГРАФА (обязателен): линейный из 4 узлов. A → B → C → D.',
    'Рёбер ровно 3. Без ответвлений и без параллельных причин.',
  ].join('\n');
}

export function formatMysteryMaskForPrompt(shape, { sideOpen = false } = {}) {
  const hard = [
    'ПЕРВАЯ ХРОНИКА И СИНОПСИС — ТОЛЬКО ИЗВЕСТНАЯ ЧАСТЬ ТАЙНЫ (жёстко).',
    'entry — что город УЖЕ заметил: симптом, слух, странность на поверхности. Без причины.',
    'synopsis — как город это сейчас понимает из того же видимого. Не полный сюжет и не разгадка.',
    'Скрытые узлы, скрытые связи, мотив, виновный, вещество, замысел — в entry и synopsis нельзя даже намёком.',
    'Не пересказывай скрытый узел другими словами. Граф истины пиши полностью, повествование — только из видимого.',
  ];
  if (shape === 'linear_5') {
    return [
      'МАСКА ЗНАНИЯ (решила система, не выбирай её):',
      'Видимо городу: только E — последний узел цепи.',
      'Скрыто: A, B, C, D и все связи.',
      ...hard,
    ].join('\n');
  }
  if (shape === 'linear_side') {
    return sideOpen
      ? [
          'МАСКА ЗНАНИЯ (решила система, не выбирай её):',
          'Видимо городу: D (последний узел цепи) и E (боковая причина).',
          'Скрыто: A, B, C и все связи.',
          ...hard,
          'D и E можно показать как два замеченных факта. Скрытую связь между ними не называй.',
        ].join('\n')
      : [
          'МАСКА ЗНАНИЯ (решила система, не выбирай её):',
          'Видимо городу: только D — последний узел цепи.',
          'Скрыто: A, B, C, E и все связи.',
          ...hard,
          'E не упоминай.',
        ].join('\n');
  }
  return [
    'МАСКА ЗНАНИЯ (решила система, не выбирай её):',
    'Видимо городу: только D — последний узел цепи.',
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
    return 'Нужен линейный граф из 5 узлов: A → B → C → D → E, ровно 4 ребра.';
  }
  if (shape === 'linear_side') {
    return 'Нужна цепь A → B → C → D и дополнительная причина E → B или E → C (не следствие из цепи). Ровно 5 узлов и 4 ребра.';
  }
  return 'Нужен линейный граф из 4 узлов: A → B → C → D, ровно 3 ребра.';
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

function firstHidden(items) {
  return items.filter((x) => x.knowledge === 'hidden');
}

/**
 * Движок сказал, сколько открыть. Если агент сам не разметил — двигаем маску.
 * full + не провал: всё resolved. fail: граф не раскрываем.
 */
export function applyEngineReveal(graph, { reveal = 'none', ending = null } = {}) {
  if (!graph?.nodes) return graph;
  delete graph.hypothesis;
  if (ending === 'fail' || reveal === 'none') return graph;
  if (reveal === 'full') {
    for (const n of graph.nodes) n.knowledge = 'resolved';
    for (const e of graph.edges) e.knowledge = 'resolved';
    return graph;
  }
  const want = reveal === 'partial' ? 2 : 1;
  const hiddenNodes = firstHidden(graph.nodes);
  const hiddenEdges = firstHidden(graph.edges);
  let left = want;
  for (const n of hiddenNodes) {
    if (left <= 0) break;
    n.knowledge = 'observed';
    left -= 1;
  }
  for (const e of hiddenEdges) {
    if (left <= 0) break;
    e.knowledge = 'observed';
    left -= 1;
  }
  return graph;
}
