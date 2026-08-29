/**
 * Phase 1 mystery architect: абстрактный A→B→C→X без города.
 * Судья отдельный (Luna). Максимум 3 генерации с одними тегами; в следующую попытку
 * проваленную историю не передаём.
 */

import { getLogger } from '../log.js';
import { toolFail } from '../agents/toolResult.js';
import {
  plotConfig,
  pickMysteryArchitectSeed,
  formatMysteryArchitectAxesForPrompt,
  mysteryTypeTag,
  mysteryAssociationTag,
  gravityBand,
} from './plotlines.js';
import {
  NODE_TEXT_MAX,
  EDGE_REASON_MAX,
  OBSERVED_FACT_MAX,
  RESOLUTION_FACT_MAX,
  normalizeTruthGraph,
  judgeTruthGraph,
  applySeedVisibility,
  normalizeFactList,
  observedFactsIssue,
  formatTruthGraphForPrompt,
  graphOverflows,
} from './mysteryGraph.js';
import { runVerdictJudge } from './mysteryJudge.js';

export const ARCHITECT_JUDGE_CODES = [
  'CITY_SPECIFIC_INSTANTIATION',
  'EXOTIC_BINDING',
  'BROKEN_CAUSAL_EDGE',
  'TEMPORAL_CONTRADICTION',
  'UNEXPLAINED_ENTITY',
  'UNEXPLAINED_KNOWLEDGE',
  'IMPLAUSIBLE_ACTION',
  'UNSUPPORTED_PHYSICAL_EFFECT',
  'UNSUPPORTED_MAGIC',
  'UNSUPPORTED_X',
  'MYSTERY_INCOMPLETE',
  'WRONG_MYSTERY_TYPE',
  'RESOLUTION_INVENTION',
  'REDUNDANT_STRUCTURE',
  'OTHER',
];

export const MEDIUM_CLASSES = [
  'SHARED_CONSUMABLE',
  'BODY',
  'ATMOSPHERE',
  'SIGNAL',
  'POPULATION',
  'STRUCTURE',
];

const MEDIUM_SET = new Set(MEDIUM_CLASSES);

const ROLE_MAX = 80;
const SLOT_FN_MAX = 200;

function clip(s, max) {
  const t = String(s ?? '').trim().replace(/\s+/g, ' ');
  if (t.length <= max) return t;
  return `${t.slice(0, max).replace(/[\s,;:—-]+$/, '')}…`;
}

function asSlots(raw) {
  const out = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    const role = clip(item?.role, 40);
    const fn = clip(item?.function, SLOT_FN_MAX);
    if (!role || !fn) continue;
    out.push({ role, function: fn });
  }
  return out;
}

function nodeText(node) {
  const role = clip(node?.role, ROLE_MAX);
  const event = clip(node?.event || node?.text || node?.observedEffect, NODE_TEXT_MAX);
  return [role, event].filter(Boolean).join(' — ');
}

function edgeReason(edge) {
  const mech = clip(edge?.mechanism || edge?.reason, EDGE_REASON_MAX);
  const cf = clip(edge?.counterfactual, EDGE_REASON_MAX);
  return [mech, cf ? `Без parent: ${cf}` : ''].filter(Boolean).join(' ');
}

export function skeletonToGraph(draft) {
  const nodes = (draft?.nodes || []).map((n) => ({
    id: n.id,
    text: nodeText(n),
    role: clip(n.role, ROLE_MAX) || null,
  }));
  const edges = (draft?.edges || []).map((e) => ({
    from: e.from,
    to: e.to,
    reason: edgeReason(e),
    mechanism: clip(e.mechanism, EDGE_REASON_MAX) || null,
    counterfactual: clip(e.counterfactual, EDGE_REASON_MAX) || null,
  }));
  const graph = normalizeTruthGraph({ nodes, edges });
  if (!graph) return null;
  applySeedVisibility(graph, { shape: 'linear_4' });
  return graph;
}

export function normalizeMysterySkeleton(raw) {
  if (!raw || typeof raw !== 'object') return { skeleton: null, reason: 'no_seed' };
  const nodesIn = Array.isArray(raw.nodes) ? raw.nodes : [];
  const nodes = ['A', 'B', 'C', 'X'].map((id) => {
    const found =
      nodesIn.find((n) => String(n?.id || '').toUpperCase() === id) ||
      raw.nodes?.[id] ||
      null;
    return {
      id,
      role: clip(found?.role, ROLE_MAX),
      event: clip(found?.event || found?.observedEffect || found?.text, NODE_TEXT_MAX),
    };
  });
  if (nodes.some((n) => !n.event)) return { skeleton: null, reason: 'thin_nodes' };

  const mediumClass = String(raw.mediumClass || '').trim().toUpperCase();
  if (!MEDIUM_SET.has(mediumClass)) return { skeleton: null, reason: 'thin_medium' };

  const edges = (Array.isArray(raw.edges) ? raw.edges : []).map((e) => ({
    from: String(e?.from || '').trim().toUpperCase(),
    to: String(e?.to || '').trim().toUpperCase(),
    mechanism: clip(e?.mechanism || e?.reason, EDGE_REASON_MAX),
    counterfactual: clip(e?.counterfactual, EDGE_REASON_MAX),
  }));

  const graph = skeletonToGraph({ nodes, edges });
  const overflow = graphOverflows({
    nodes: nodes.map((n) => ({ id: n.id, text: nodeText(n) })),
    edges: edges.map((e) => ({ from: e.from, to: e.to, reason: edgeReason(e) })),
  });
  const shapeReason = overflow || (!graph ? 'missing_graph' : judgeTruthGraph(graph, { shape: 'linear_4' }));
  if (shapeReason) return { skeleton: null, reason: shapeReason };

  const observed = normalizeFactList(raw.observedProjection || raw.observedFacts, {
    maxLen: OBSERVED_FACT_MAX,
  });
  const resolution = normalizeFactList(raw.resolutionFacts, {
    maxItems: 5,
    maxLen: RESOLUTION_FACT_MAX,
  });
  const factReason =
    observed.reason ||
    resolution.reason ||
    observedFactsIssue(observed.facts, graph) ||
    // лексический overlap resolutionFacts режет русские формы; изобретение смотрит судья
    (resolution.facts.length < 2 ? 'thin_resolution' : null);
  if (factReason) return { skeleton: null, reason: factReason };

  const required = asSlots(raw.bindingSlots?.required);
  const optional = asSlots(raw.bindingSlots?.optional);
  if (required.length < 2) return { skeleton: null, reason: 'thin_slots' };

  const skeleton = {
    workingTitle: clip(raw.workingTitle || raw.title, 80) || 'без названия',
    mediumClass,
    premise: clip(raw.premise || raw.storyCore?.premise, 400),
    mysteryQuestion: clip(raw.mysteryQuestion || raw.storyCore?.mysteryQuestion, 240),
    stakes: clip(raw.stakes || raw.storyCore?.stakes, 240),
    nodes,
    edges,
    graph,
    observedProjection: observed.facts,
    resolutionFacts: resolution.facts,
    bindingSlots: { required, optional },
    legacyPotential: (Array.isArray(raw.legacyPotential?.axes)
      ? raw.legacyPotential.axes
      : Array.isArray(raw.legacyPotential)
        ? raw.legacyPotential
        : []
    )
      .map((a) => clip(a, 120))
      .filter(Boolean)
      .slice(0, 6),
  };
  return { skeleton, reason: null };
}

function slotSchema(description) {
  return {
    type: 'array',
    items: {
      type: 'object',
      required: ['role', 'function'],
      properties: {
        role: { type: 'string', description: 'Функциональная роль, не профессия и не имя.' },
        function: { type: 'string', description },
      },
    },
  };
}

export function classifyArchitectSkip({ data, run, error } = {}) {
  if (data) return null;
  if (error) return 'GENERATOR_ERROR';
  const last = [...(run?.toolTrace || [])]
    .reverse()
    .find((t) => t.name === 'submit_mystery_skeleton');
  const err = last?.result?.error;
  if (err === 'invalid_json_args') return 'SCHEMA_INVALID';
  if (err) return `PRECHECK_FAIL:${err}`;
  if (run?.truncated) return 'TRUNCATED';
  return 'NO_OUTPUT';
}

async function askMysterySkeleton({ runtime, seed, log }) {
  const draft = { data: null };
  const tools = [
    {
      name: 'submit_mystery_skeleton',
      description:
        'Абстрактный skeleton тайны. Без города, имён и профессий. closeWhen не пиши.',
      parameters: {
        type: 'object',
        required: [
          'workingTitle',
          'mediumClass',
          'premise',
          'mysteryQuestion',
          'stakes',
          'nodes',
          'edges',
          'observedProjection',
          'resolutionFacts',
          'bindingSlots',
        ],
        properties: {
          workingTitle: { type: 'string', description: 'Рабочее название, 1–6 слов, без имени города.' },
          mediumClass: {
            type: 'string',
            enum: MEDIUM_CLASSES,
            description:
              'Класс носителя, не городской инстанс. SHARED_CONSUMABLE: еда/вода/топливо/ткань (ресурс выберет Phase 2). STRUCTURE: несущая конструкция. SIGNAL: мера/запись/ритм. Не цистерна, не водосбор, не амбар.',
          },
          premise: { type: 'string', description: 'Одной-двумя фразами: что это за mystery.' },
          mysteryQuestion: { type: 'string', description: 'Главный вопрос, на который отвечает граф.' },
          stakes: { type: 'string', description: 'Чего стоит не узнать причину, без городских имён.' },
          nodes: {
            type: 'array',
            minItems: 4,
            maxItems: 4,
            description: 'Ровно A, B, C, X. Roles and mechanisms, not city nouns.',
            items: {
              type: 'object',
              required: ['id', 'role', 'event'],
              properties: {
                id: { type: 'string', enum: ['A', 'B', 'C', 'X'] },
                role: { type: 'string' },
                event: { type: 'string', maxLength: NODE_TEXT_MAX },
              },
            },
          },
          edges: {
            type: 'array',
            minItems: 3,
            maxItems: 3,
            description: 'Ровно A→B, B→C, C→X.',
            items: {
              type: 'object',
              required: ['from', 'to', 'mechanism', 'counterfactual'],
              properties: {
                from: { type: 'string', enum: ['A', 'B', 'C'] },
                to: { type: 'string', enum: ['B', 'C', 'X'] },
                mechanism: {
                  type: 'string',
                  description: 'Как parent вызывает child: физика, социальная передача, знание.',
                },
                counterfactual: {
                  type: 'string',
                  description: 'Если убрать parent, произойдёт ли child почти тем же способом?',
                },
              },
            },
          },
          observedProjection: {
            type: 'array',
            minItems: 2,
            maxItems: 4,
            items: { type: 'string', maxLength: OBSERVED_FACT_MAX },
            description: '2–4 наблюдаемых факта, каждый сказан в X почти дословно.',
          },
          resolutionFacts: {
            type: 'array',
            minItems: 2,
            maxItems: 4,
            items: { type: 'string', maxLength: RESOLUTION_FACT_MAX },
            description:
              '2–4 неизвестных уже из графа: что игрок должен установить. Не новые объекты. Вопросительный знак не обязателен.',
          },
          bindingSlots: {
            type: 'object',
            required: ['required'],
            properties: {
              required: slotSchema('Зачем этот слот нужен причине. Не профессия.'),
              optional: slotSchema('Необязательный слот для Phase 2.'),
            },
          },
          legacyPotential: {
            type: 'object',
            properties: {
              axes: {
                type: 'array',
                items: { type: 'string' },
                description: 'Какие оси могут дать сиквел, если разгадка сама оставит узел.',
              },
            },
          },
        },
      },
      handler: async (args) => {
        const { skeleton, reason } = normalizeMysterySkeleton(args);
        if (reason) {
          return toolFail(
            reason,
            'Нужны A→B→C→X, mediumClass, mechanism+counterfactual, observed из X, resolutionFacts — неизвестные уже из узлов.',
          );
        }
        draft.data = skeleton;
        return { ok: true };
      },
    },
  ];

  const run = await runtime.run({
    agentId: 'mysteryArchitect',
    tools,
    maxTurns: 3,
    toolChoice: { type: 'function', function: { name: 'submit_mystery_skeleton' } },
    log,
    scene: 'mystery_architect',
    extraSystem: '',
    userMessages: [
      {
        role: 'user',
        content: [
          'Построй абстрактный skeleton mystery. Города нет.',
          'Граф строго A → B → C → X. Causal functions + один mediumClass, не городской инстанс.',
          'resolutionFacts — неизвестные уже из узлов: что игрок должен установить. Не разгадка и не новые объекты.',
          '',
          formatMysteryArchitectAxesForPrompt(seed),
          '',
          'Вызови submit_mystery_skeleton.',
        ].join('\n'),
      },
    ],
  });

  return { skeleton: draft.data, skip: classifyArchitectSkip({ data: draft.data, run }) };
}

export function formatMysteryArchitectJudgeCase({ seed = {}, skeleton = null } = {}) {
  const tags = seed.tags || [];
  const type = mysteryTypeTag(tags);
  const assoc = mysteryAssociationTag(tags);
  const slots = skeleton?.bindingSlots || { required: [], optional: [] };
  return [
    'ПАКЕТ НА ПРОВЕРКУ (абстрактный skeleton; города нет).',
    Number.isFinite(Number(seed.gravity))
      ? `GRAVITY: ${seed.gravity} (${gravityBand(seed.gravity)})`
      : null,
    `ТИП: ${type?.tagName || '—'}`,
    type?.about ? `about: ${type.about}` : null,
    skeleton?.mediumClass ? `mediumClass: ${skeleton.mediumClass}` : null,
    `ASSOCIATION (слабый импульс): «${assoc?.tagName || '—'}»`,
    formatMysteryArchitectAxesForPrompt(seed),
    '',
    skeleton?.workingTitle ? `workingTitle: ${skeleton.workingTitle}` : null,
    skeleton?.premise ? `premise: ${skeleton.premise}` : null,
    skeleton?.mysteryQuestion ? `mysteryQuestion: ${skeleton.mysteryQuestion}` : null,
    skeleton?.stakes ? `stakes: ${skeleton.stakes}` : null,
    '',
    formatTruthGraphForPrompt(skeleton?.graph) || '(графа нет)',
    '',
    'observedProjection:',
    ...(skeleton?.observedProjection || []).length
      ? skeleton.observedProjection.map((f, i) => `${i + 1}. ${f}`)
      : ['- (нет)'],
    'resolutionFacts (неизвестные уже из узлов; что игрок должен установить; «?» не обязателен):',
    ...(skeleton?.resolutionFacts || []).length
      ? skeleton.resolutionFacts.map((f, i) => `${i + 1}. ${f}`)
      : ['- (нет)'],
    '',
    'bindingSlots (НЕ сущности истины; заказ Phase 2):',
    'required:',
    ...(slots.required || []).length
      ? slots.required.map((s) => `- ${s.role}: ${s.function}`)
      : ['- (нет)'],
    'optional:',
    ...(slots.optional || []).length
      ? slots.optional.map((s) => `- ${s.role}: ${s.function}`)
      : ['- (нет)'],
  ]
    .filter((line) => line != null)
    .join('\n');
}

export async function judgeMysteryArchitect({ runtime, caseText, log: parentLog } = {}) {
  const log = (parentLog || getLogger()).child({ scope: 'mystery.architect.judge' });
  const verdict = await runVerdictJudge({
    runtime,
    agentId: 'mysteryArchitectJudge',
    caseText,
    extraUser:
      'PASS только если цепь целая, X объясняется, тип — форма наблюдаемой mystery, нет CITY_SPECIFIC_INSTANTIATION и EXOTIC_BINDING, жители не игнорируют бытовое знание без причины, мотив не авторский. Не FAIL за слово «город», тег CITY, generic roles, bindingSlots или отсутствие «?» у resolutionFacts. Иначе FAIL. UNCERTAIN пайплайн не принимает.',
    log,
    codes: ARCHITECT_JUDGE_CODES,
    scene: 'mystery_architect_judge',
    scope: 'mystery.architect.judge',
    toolName: 'submit_mystery_verdict',
    toolDescription: 'Вердикт по абстрактному skeleton. Историю не чини.',
  });
  const accepted = verdict.verdict === 'PASS';
  log.info('mystery.architect.judge', {
    verdict: verdict.verdict,
    issues: verdict.issues,
    summary: verdict.summary,
    accepted,
  });
  return { accepted, judge: verdict };
}

/**
 * @returns {Promise<{ ok: boolean, seed: object, skeleton: object|null, judge: object|null, attempts: object[] }>}
 */
export async function seedMysterySkeleton({
  config,
  runtime,
  log: parentLog,
  seed: seedArg = null,
  rng = Math.random,
} = {}) {
  const cfg = plotConfig(config);
  const seed = seedArg || pickMysteryArchitectSeed(cfg, rng);
  const max = cfg.mysteryArchitect?.judgeAttempts || 3;
  const log = (parentLog || getLogger()).child({ scope: 'mystery.architect' });
  const attempts = [];

  for (let genTry = 0; genTry < max; genTry += 1) {
    let asked = null;
    try {
      asked = await askMysterySkeleton({ runtime, seed, log });
    } catch (err) {
      attempts.push({
        genTry,
        skip: classifyArchitectSkip({ error: err }),
        accepted: false,
        judge: null,
      });
      log.warn('mystery.architect.failed', { genTry, error: err.message });
      continue;
    }
    const skeletonIn = asked?.skeleton || null;
    if (!skeletonIn) {
      attempts.push({
        genTry,
        skip: asked?.skip || 'NO_OUTPUT',
        accepted: false,
        judge: null,
      });
      continue;
    }
    const { skeleton, reason } = skeletonIn.graph
      ? { skeleton: skeletonIn, reason: null }
      : normalizeMysterySkeleton(skeletonIn);
    if (reason || !skeleton) {
      attempts.push({
        genTry,
        skip: reason ? `PRECHECK_FAIL:${reason}` : 'NO_OUTPUT',
        title: skeletonIn.workingTitle || null,
        accepted: false,
        judge: null,
      });
      continue;
    }
    const caseText = formatMysteryArchitectJudgeCase({ seed, skeleton });
    const judged = await judgeMysteryArchitect({ runtime, caseText, log });
    const rec = {
      genTry,
      skip: null,
      title: skeleton.workingTitle,
      skeleton,
      accepted: judged.accepted,
      judge: judged.judge,
    };
    attempts.push(rec);
    if (judged.accepted) {
      return { ok: true, seed, skeleton, judge: judged.judge, attempts };
    }
  }

  const last = [...attempts].reverse().find((a) => a.skeleton) || null;
  return {
    ok: false,
    seed,
    skeleton: last?.skeleton || null,
    judge: last?.judge || null,
    attempts,
  };
}

export function formatMysterySkeletonCard(skeleton) {
  if (!skeleton) return '(пусто)';
  const lines = [
    skeleton.workingTitle ? `«${skeleton.workingTitle}»` : null,
    skeleton.mediumClass ? `mediumClass: ${skeleton.mediumClass}` : null,
    skeleton.premise ? `premise: ${skeleton.premise}` : null,
    skeleton.mysteryQuestion ? `вопрос: ${skeleton.mysteryQuestion}` : null,
    skeleton.stakes ? `ставки: ${skeleton.stakes}` : null,
    '',
    formatTruthGraphForPrompt(skeleton.graph),
    '',
    'observedProjection:',
    ...(skeleton.observedProjection || []).map((f) => `- ${f}`),
    'resolutionFacts:',
    ...(skeleton.resolutionFacts || []).map((f) => `- ${f}`),
    '',
    'bindingSlots:',
    ...(skeleton.bindingSlots?.required || []).map((s) => `- required ${s.role}: ${s.function}`),
    ...(skeleton.bindingSlots?.optional || []).map((s) => `- optional ${s.role}: ${s.function}`),
  ];
  if (skeleton.legacyPotential?.length) {
    lines.push('', 'legacyPotential:');
    for (const a of skeleton.legacyPotential) lines.push(`- ${a}`);
  }
  return lines.filter((l) => l != null).join('\n');
}
