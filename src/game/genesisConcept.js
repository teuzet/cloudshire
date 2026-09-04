/**
 * Concept Generator: компактный канон до longform.
 */

import { getLogger } from '../log.js';
import { toolFail } from '../agents/toolResult.js';
import { formatWorldContractForPrompt, matchCosmologyHeuristic } from './worldContract.js';
import {
  formatPlayerDirectivesForPrompt,
  normalizePlayerDirectives,
  recordCosmologyConflicts,
} from './playerDirectives.js';
import {
  formatGenesisAxesForPrompt,
  applyAxisAdaptations,
  normalizeAxesState,
} from './genesisAxes.js';
import { isForbiddenDomainName } from './stats.js';

function formatBrief(playerBrief) {
  if (!playerBrief || typeof playerBrief !== 'object') return '(нет)';
  const parts = [playerBrief.city, playerBrief.ruler, playerBrief.freeform]
    .map((s) => String(s || '').trim())
    .filter(Boolean);
  return parts.length ? parts.join('\n') : '(нет)';
}

const TITLE_MAX = 80;

function clip(s, max) {
  const t = String(s ?? '').trim().replace(/\s+/g, ' ');
  if (!t) return '';
  if (t.length <= max) return t;
  return `${t.slice(0, max).replace(/[\s,;:—-]+$/, '')}…`;
}

function clipPara(s, max = 800) {
  const t = String(s ?? '').trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max).replace(/[\s,;:—-]+$/, '')}…`;
}

export function openingLoreFromConcept(concept, { min = 8, max = 12 } = {}) {
  if (!concept || typeof concept !== 'object') return [];
  const name = concept.name || 'город';
  const lines = [];
  const push = (s) => {
    const t = clip(String(s || '').split('%cityName').join(name), 220);
    if (t && !lines.includes(t)) lines.push(t);
  };
  push(`Город «${name}» стоит в центре летающего острова.`);
  if (concept.identity?.oneLine) push(concept.identity.oneLine);
  if (concept.landscape) push(concept.landscape);
  if (concept.settlement) push(concept.settlement);
  if (concept.livelihood) push(concept.livelihood);
  for (const f of concept.definingFeatures || []) {
    if (f?.description) push(f.description);
  }
  if (concept.society) push(concept.society);
  if (concept.unknownOrWildAreas) push(concept.unknownOrWildAreas);
  const v = concept.backgroundViability || {};
  if (v.water) push(v.water);
  if (v.food) push(v.food);
  if (v.fuel) push(v.fuel);
  if (concept.preview) {
    for (const part of String(concept.preview).split(/(?<=[.!?])\s+/)) push(part);
  }
  const fillers = [
    `Жители «${name}» чтят покровителя и местные обряды.`,
    'За обрывом — облака и ветер.',
    `Город «${name}» живёт со своим островом и никуда с него не ходит.`,
    'Дальше края — бездна облаков, не соседние земли.',
  ];
  let guard = 0;
  while (lines.length < min && guard < fillers.length) {
    push(fillers[guard]);
    guard += 1;
  }
  return lines.slice(0, max);
}

export function normalizeConcept(raw) {
  if (!raw || typeof raw !== 'object') return { concept: null, reason: 'no_concept' };
  const status = String(raw.status || '').toUpperCase() === 'NEEDS_PLAYER_REVISION'
    ? 'NEEDS_PLAYER_REVISION'
    : 'READY';
  const conflicts = Array.isArray(raw.conflicts)
    ? raw.conflicts
        .map((c) => ({
          requested: clip(c.requested || c.requestedText, 200),
          reason: clip(c.reason, 300),
          adaptations: (c.adaptations || []).map((a) => clip(a, 200)).filter(Boolean),
        }))
        .filter((c) => c.requested || c.reason)
    : [];
  if (status === 'NEEDS_PLAYER_REVISION') {
    return {
      concept: {
        status,
        conflicts,
        suggestedAdaptations: (raw.suggestedAdaptations || []).map((a) => clip(a, 200)).filter(Boolean),
        name: null,
        preview: null,
      },
      reason: null,
    };
  }
  const name = clip(raw.name, TITLE_MAX);
  if (!name) return { concept: null, reason: 'no_name' };
  if (isForbiddenDomainName(name)) return { concept: null, reason: 'forbidden_name' };
  const radiusKm = Math.max(20, Math.min(50, Math.round(Number(raw.radiusKm) || 30)));
  const features = Array.isArray(raw.definingFeatures)
    ? raw.definingFeatures
        .map((f, i) => ({
          id: String(f.id || `f${i + 1}`),
          domain: clip(f.domain, 40),
          source: String(f.source || 'GENERATED').toUpperCase(),
          description: clipPara(f.description, 500),
        }))
        .filter((f) => f.description)
        .slice(0, 4)
    : [];
  const preview = clipPara(raw.preview, 1400);
  if (preview.length < 80) return { concept: null, reason: 'thin_preview' };
  const viability = raw.backgroundViability && typeof raw.backgroundViability === 'object'
    ? {
        water: clip(raw.backgroundViability.water, 220),
        food: clip(raw.backgroundViability.food, 220),
        fuel: clip(raw.backgroundViability.fuel, 220),
        construction: clip(raw.backgroundViability.construction, 220),
      }
    : {};
  const ruler = raw.ruler && typeof raw.ruler === 'object'
    ? {
        title: clip(raw.ruler.title, 80),
        description: clipPara(raw.ruler.description, 500),
      }
    : {};
  return {
    concept: {
      status: 'READY',
      conflicts: [],
      suggestedAdaptations: [],
      name,
      radiusKm,
      identity: { oneLine: clip(raw.identity?.oneLine || raw.oneLine, 240) },
      definingFeatures: features,
      landscape: clipPara(raw.landscape, 700),
      settlement: clipPara(raw.settlement, 700),
      livelihood: clipPara(raw.livelihood, 700),
      society: clipPara(raw.society, 700),
      history: clipPara(raw.history, 700),
      culture: clipPara(raw.culture, 700),
      patronCult: clipPara(raw.patronCult, 700),
      ruler,
      unknownOrWildAreas: clipPara(raw.unknownOrWildAreas, 500),
      backgroundViability: viability,
      axisAdaptations: Array.isArray(raw.axisAdaptations) ? raw.axisAdaptations : [],
      preview,
    },
    reason: null,
  };
}

export async function requestCityConcept({
  config,
  runtime,
  axes,
  directives,
  playerBrief,
  axisInterview = null,
  occupiedNames = [],
  lockedName = null,
  lockedPatronName = null,
  lockedPatronGender = null,
  log: parentLog,
} = {}) {
  const log = (parentLog || getLogger()).child({ scope: 'genesis.concept' });
  const draft = { data: null, fail: null };
  const occupied = Array.isArray(occupiedNames)
    ? occupiedNames.filter(Boolean).map(String).slice(0, 40)
    : occupiedNames instanceof Map
      ? [...occupiedNames.values()].map(String).filter(Boolean).slice(0, 40)
      : [];
  const tools = [
    {
      name: 'submit_concept',
      description: 'Краткий питч города или конфликт космологии. Не longform.',
      parameters: {
        type: 'object',
        required: ['status'],
        properties: {
          status: { type: 'string', description: 'READY или NEEDS_PLAYER_REVISION' },
          conflicts: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                requested: { type: 'string' },
                reason: { type: 'string' },
                adaptations: { type: 'array', items: { type: 'string' } },
              },
            },
          },
          suggestedAdaptations: { type: 'array', items: { type: 'string' } },
          name: { type: 'string', description: 'Кириллический топоним, не имя игры' },
          identity: {
            type: 'object',
            properties: { oneLine: { type: 'string' } },
          },
          preview: { type: 'string', description: '80–200 слов для игрока' },
        },
      },
      handler: async (args) => {
        const { concept, reason } = normalizeConcept(lockedName ? { ...args, name: lockedName } : args);
        if (reason) {
          draft.fail = reason;
          const why =
            reason === 'forbidden_name'
              ? 'Имя запрещено. Дай кириллический топоним места, не имя игры и не кальку с английского.'
              : 'Нужен READY питч (имя + preview 80+ слов) или NEEDS_PLAYER_REVISION с conflicts.';
          return toolFail(reason, why);
        }
        if (concept.status === 'READY') {
          const hits = matchCosmologyHeuristic(
            [concept.identity?.oneLine, concept.preview].filter(Boolean).join('\n'),
          );
          if (hits.length) {
            draft.data = {
              status: 'NEEDS_PLAYER_REVISION',
              conflicts: hits.map((h) => ({
                requested: h.requested || h.id,
                reason: h.reason,
                adaptations: h.adaptations || [],
              })),
              suggestedAdaptations: hits.flatMap((h) => h.adaptations || []),
              name: null,
              preview: null,
            };
            return { ok: true };
          }
          if (occupied.some((n) => n.toLowerCase() === concept.name.toLowerCase())) {
            draft.fail = 'name_taken';
            return toolFail('name_taken', `Имя «${concept.name}» занято. Дай другое.`);
          }
        }
        draft.data = concept;
        return { ok: true };
      },
    },
  ];

  await runtime.run({
    agentId: 'genesisConcept',
    tools,
    maxTurns: 2,
    toolChoice: { type: 'function', function: { name: 'submit_concept' } },
    log,
    scene: 'genesis_concept',
    userMessages: [
      {
        role: 'user',
        content: [
          'Напиши краткий питч города по осям. Не полный Genesis и не энциклопедию.',
          lockedName
            ? `Имя города УЖЕ дано игроком: «${lockedName}». Поле name = точно это. Это данное: не поднимай конфликт космологии из-за звучания.`
            : 'Имя: 1–3 слова кириллицей, как топоним места. Не русское земное (не Белогорье). Не про небо/полёт. Не имя игры и не латинская калька.',
          lockedPatronName
            ? `Имя покровителя уже дано: «${lockedPatronName}»${
                lockedPatronGender === 'female'
                  ? ' (женщина)'
                  : lockedPatronGender === 'male'
                    ? ' (мужчина)'
                    : ''
              }. Не отвергай его из-за звучания.`
            : '',
          'Поле name отдельно. В preview / identity и прочей прозе только плейсхолдер %cityName в именительном («город %cityName стоит…»). Косвенные падежи обходи («здесь», «этот город»).',
          'preview 80–200 слов: силуэт острова, чем живут, характер. Без списка «1. 2. 3.».',
          'Если PLAYER_REQUIRED ломает космологию — status NEEDS_PLAYER_REVISION, не чини молча.',
          occupied.length ? `Занятые имена, не предлагай: ${occupied.join(', ')}` : '',
          '',
          formatWorldContractForPrompt(config),
          '',
          formatPlayerDirectivesForPrompt(directives),
          '',
          'RAW PLAYER BRIEF:',
          formatBrief(playerBrief),
          axisInterview?.uniqueFeature
            ? `UNIQUE FEATURE (обязательно впиши в preview конкретно):\n${axisInterview.uniqueFeature}`
            : '',
          '',
          formatGenesisAxesForPrompt(config, axes),
          '',
          'Вызови submit_concept.',
        ]
          .filter(Boolean)
          .join('\n'),
      },
    ],
  });

  if (!draft.data) {
    log.warn('genesis.concept.failed', { fail: draft.fail });
    return { ok: false, concept: null, skip: draft.fail || 'NO_OUTPUT', axes };
  }
  let nextAxes = normalizeAxesState(axes);
  if (draft.data.status === 'READY' && draft.data.axisAdaptations?.length) {
    nextAxes = applyAxisAdaptations(nextAxes, draft.data.axisAdaptations);
  }
  let nextDirs = normalizePlayerDirectives(directives);
  if (draft.data.status === 'NEEDS_PLAYER_REVISION' && draft.data.conflicts?.length) {
    nextDirs = recordCosmologyConflicts(nextDirs, draft.data.conflicts);
  }
  log.info('genesis.concept.ok', {
    status: draft.data.status,
    name: draft.data.name,
    features: draft.data.definingFeatures?.length || 0,
  });
  return { ok: draft.data.status === 'READY', concept: draft.data, axes: nextAxes, directives: nextDirs, skip: null };
}

export function formatFrozenConceptForPrompt(concept) {
  if (!concept || concept.status !== 'READY') return '(нет frozen concept)';
  const feats = (concept.definingFeatures || [])
    .map((f) => `- [${f.source}] ${f.domain}: ${f.description}`)
    .join('\n');
  const v = concept.backgroundViability || {};
  return [
    `FROZEN CONCEPT «${concept.name}», радиус ~${concept.radiusKm} км.`,
    concept.identity?.oneLine || '',
    'DEFINING FEATURES (не удалять, не ослаблять, 2–5 проявлений на каждую):',
    feats,
    `LANDSCAPE: ${concept.landscape}`,
    `SETTLEMENT: ${concept.settlement}`,
    `LIVELIHOOD: ${concept.livelihood}`,
    `SOCIETY: ${concept.society}`,
    `HISTORY: ${concept.history}`,
    `CULTURE: ${concept.culture}`,
    `PATRON CULT: ${concept.patronCult}`,
    concept.ruler?.title ? `RULER: ${concept.ruler.title}. ${concept.ruler.description || ''}` : '',
    `UNKNOWN/WILD: ${concept.unknownOrWildAreas}`,
    `VIABILITY: water=${v.water || '—'}; food=${v.food || '—'}; fuel=${v.fuel || '—'}; construction=${v.construction || '—'}`,
  ]
    .filter(Boolean)
    .join('\n');
}
