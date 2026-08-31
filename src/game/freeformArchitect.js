import { getLogger } from '../log.js';
import { toolFail } from '../agents/toolResult.js';
import { clipPlotText, PLOT_TITLE_MAX, PLOT_SUMMARY_MAX } from './plotlines.js';
import { normalizeHiddenPremises } from './suspenseGraph.js';
import {
  freeformConfig,
  clampUrgency,
  formatFreeformGravityForPrompt,
  formatFreeformSeedBlank,
  normalizeCloseWhenList,
  plotCardForPrompt,
  plotChronicleForPrompt,
  finishLabel,
} from './freeform.js';
import { repairFreeformVariant } from './freeformJudge.js';
import { plotConfig, pickSuspenseAnnotationSeed } from './plotlines.js';

export function pickFreeformSeedAxes(config, rng = Math.random) {
  const ids = new Set(freeformConfig(config).seedAxes);
  const seed = pickSuspenseAnnotationSeed(plotConfig(config), rng);
  return (seed.tags || []).filter((t) => ids.has(t.groupId));
}

export function freeformFreePair() {
  return [
    { groupId: 'truthArena', tagId: 'free', tagName: 'FREE' },
    { groupId: 'worldRelation', tagId: 'free', tagName: 'FREE' },
  ];
}

export function pickFreeformSeedAxisPairs(config, count, rng = Math.random) {
  const n = Math.max(1, Math.round(Number(count) || 1));
  const pairs = Array.from({ length: n }, () => pickFreeformSeedAxes(config, rng));
  const slot = Math.min(n - 1, Math.max(0, Math.floor(rng() * n)));
  pairs[slot] = freeformFreePair();
  return pairs;
}

const ARENA_ORDER = ['human', 'creature', 'ecology', 'material', 'built', 'earth', 'sky', 'free'];
const RELATION_ORDER = ['native', 'contact', 'legacy', 'free'];

const ARENA_HINT = {
  human: 'решения, обещания, стыд, долг, мода, слух, статус, отказ, союз, разлад, подражание',
  creature: 'зверь, стая, гнездо, нрав, голод, путь, линька, скот, существо у порога или на тропе',
  ecology: 'виды, заросли, пустоши, цветение, миграция, кто кого ест, смена склона',
  material: 'вещество, вкус, цвет, жар, липкость, звон, порча, примесь, жила, осадок',
  built: 'дом, путь, колодец, мост, печь, ворота, лестница, сруб, тень постройки',
  earth: 'склон, край, камень, грунт, пласт, осыпь, трещина, родник в породе',
  sky: 'погодные явления, движение небесных тел, небо, существа живущие в небесах, звёзды',
  free: 'вайлдкард: причинный центр на твоё усмотрение',
};

const WORLD_RELATION_HINT = {
  native: 'своё со своим: уклад, люди, места, твари, обычаи, долги, права',
  contact: 'в привычное вошло новое: идея, обычай, значение, факт, слово — не обязательно тело и не обязательно снаружи',
  legacy: 'нынешние с долгим следом прошлого: уговор, статус, посадка, осуждение, срок',
  free: 'вайлдкард: тип отношений на твоё усмотрение',
};

function hintKey(tag) {
  return String(tag?.tagId || tag?.tagName || '')
    .trim()
    .toLowerCase();
}

function isFreeTag(tag) {
  return hintKey(tag) === 'free';
}

function formatCatalogBlock(title, order, hints) {
  const lines = [title];
  for (const id of order) {
    const hint = hints[id];
    if (!hint) continue;
    lines.push(`${id.toUpperCase()} — ${hint}`);
  }
  return lines.join('\n');
}

function formatAxisHint(tag) {
  const name = tag?.tagName || tag?.tagId || '';
  if (!name) return '';
  const axis = tag.groupId === 'truthArena' || tag.groupId === 'threatArena' ? 'threatArena' : tag.groupId;
  const pack =
    tag.groupId === 'worldRelation' ? WORLD_RELATION_HINT[hintKey(tag)] : ARENA_HINT[hintKey(tag)];
  return pack ? `${axis}: ${name} — ${pack}` : `${axis}: ${name}`;
}

export function formatFreeformSeedAxesForPrompt(tags) {
  if (!tags?.length) return '';
  return tags.map((t) => formatAxisHint(t)).filter(Boolean).join('\n');
}

export function formatFreeformArenaRelationCatalogs() {
  return [
    formatCatalogBlock('threatArena', ARENA_ORDER, ARENA_HINT),
    '',
    formatCatalogBlock('worldRelation', RELATION_ORDER, WORLD_RELATION_HINT),
  ].join('\n');
}

export function formatFreeformSeedAxisPairsForPrompt(pairs) {
  if (!pairs?.length) return '';
  const lines = [
    'Метки — ассоциативные поля, не жанр и не обязательные существительные.',
    '',
    formatFreeformArenaRelationCatalogs(),
    '',
    'Пары. На каждую — четыре поля (затравка, конфликт, динамика, последствия), в этом порядке:',
  ];
  pairs.forEach((tags, i) => {
    const arena = (tags || []).find((t) => t.groupId === 'truthArena' || t.groupId === 'threatArena');
    const rel = (tags || []).find((t) => t.groupId === 'worldRelation');
    const a = arena?.tagName || arena?.tagId || '?';
    const r = rel?.tagName || rel?.tagId || '?';
    lines.push(`${i + 1}. ${a} · ${r}`);
  });
  return lines.join('\n').trim();
}

function axisTagName(tags, groupId) {
  return (tags || []).find((t) => t.groupId === groupId)?.tagName || '';
}

export function freeformArchitectAgentId(kind) {
  return kind === 'beat' ? 'freeformArchitectTell' : 'freeformArchitectStart';
}

export function architectShortText(blank) {
  if (blank?.whatHappens) return String(blank.whatHappens).trim();
  return formatFreeformSeedBlank(blank) || String(blank?.text || blank?.premise || '').trim();
}

export function packRejectedBlanks(variants, chosenIndex) {
  return variants
    .map((v, i) => ({
      index: i + 1,
      title: v.title || '',
      text: architectShortText(v),
      hook: v.hook || '',
      conflict: v.conflict || '',
      dynamics: v.dynamics || '',
      consequences: v.consequences || '',
      arena: v.arena || '',
      worldRelation: v.worldRelation || '',
      chosen: i === chosenIndex,
    }))
    .filter((v) => !v.chosen);
}

export function normalizeSeedBlank(raw, pair = []) {
  const hook = clipPlotText(raw?.hook || raw?.text || raw?.premise, PLOT_SUMMARY_MAX);
  const conflict = clipPlotText(raw?.conflict, PLOT_SUMMARY_MAX);
  const dynamics = clipPlotText(raw?.dynamics, PLOT_SUMMARY_MAX);
  const consequences = clipPlotText(raw?.consequences, PLOT_SUMMARY_MAX);
  if (!hook || !conflict || !dynamics || !consequences) return null;
  return {
    title: clipPlotText(raw?.title, PLOT_TITLE_MAX) || '',
    hook,
    conflict,
    dynamics,
    consequences,
    text: hook,
    premise: hook,
    arena: axisTagName(pair, 'truthArena'),
    worldRelation: axisTagName(pair, 'worldRelation'),
  };
}

export function normalizeBeatBlank(raw) {
  const title = clipPlotText(raw?.title, PLOT_TITLE_MAX);
  const whatHappens = clipPlotText(raw?.whatHappens, PLOT_SUMMARY_MAX);
  const situationNow = clipPlotText(raw?.situationNow, PLOT_SUMMARY_MAX);
  if (!whatHappens || !situationNow) return null;
  const closed = Boolean(raw?.closed);
  return {
    title: title || '',
    whatHappens,
    situationNow,
    closeWhen: raw?.closeWhen ? normalizeCloseWhenList(raw.closeWhen) : null,
    hiddenPremises: raw?.hiddenPremises ? normalizeHiddenPremises(raw.hiddenPremises) : null,
    urgency: Number.isFinite(Number(raw?.urgency)) ? clampUrgency(raw.urgency, null) : null,
    closed,
    closedBy: closed ? clipPlotText(raw?.closedBy, 200) : '',
  };
}

export function formatAgentPrompt(packed) {
  if (!packed) return '';
  const lines = [];
  if (packed.agentId) lines.push(`agent: ${packed.agentId}`);
  if (packed.provider || packed.model) {
    lines.push(`model: ${[packed.provider, packed.model].filter(Boolean).join('/')}`);
  }
  lines.push('', '=== SYSTEM ===', packed.systemContent || '');
  for (const msg of packed.messages || []) {
    if (msg.role === 'system') continue;
    lines.push('', `=== ${String(msg.role || 'user').toUpperCase()} ===`, msg.content || '');
  }
  if (packed.tools?.length) {
    lines.push('', '=== TOOLS ===', JSON.stringify(packed.tools, null, 2));
  }
  return lines.join('\n').trim();
}

export function captureAgentPrompt(runtime, opts) {
  const userOnly = (opts?.userMessages || [])
    .map((m) => m.content || '')
    .filter(Boolean)
    .join('\n\n');
  if (typeof runtime?.assembleChat !== 'function') return userOnly;
  try {
    return formatAgentPrompt(
      runtime.assembleChat({
        agentId: opts.agentId,
        extraSystem: opts.extraSystem || '',
        userMessages: opts.userMessages || [],
        tools: opts.tools || [],
      }),
    );
  } catch {
    return userOnly;
  }
}

async function askSeedParagraphs({ runtime, seedText, pairs, gravity, config, log }) {
  const draft = { variants: null };
  const n = pairs.length;
  const runOpts = {
    agentId: 'freeformArchitectStart',
    tools: [
      {
        name: 'submit_freeform_seed_blanks',
        description: `Ровно ${n} кандидатов: четыре поля на каждую генеративную пару, в том же порядке.`,
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['variants'],
          properties: {
            variants: {
              type: 'array',
              minItems: n,
              maxItems: n,
              items: {
                type: 'object',
                required: ['hook', 'conflict', 'dynamics', 'consequences'],
                properties: {
                  hook: {
                    type: 'string',
                    description: 'Затравка: компактная сцена, 1–2 предложения. Что уже произошло.',
                  },
                  conflict: {
                    type: 'string',
                    description: 'Конфликт: что сейчас двигает сюжет.',
                  },
                  dynamics: {
                    type: 'string',
                    description: 'Динамика: как ситуация будет развиваться дальше.',
                  },
                  consequences: {
                    type: 'string',
                    description: 'Последствия: посадка истории на уровне Gravity. Динамика должна её зарабатывать, не приклеивать.',
                  },
                },
              },
            },
          },
        },
        handler: async (args) => {
          const list = Array.isArray(args?.variants) ? args.variants : [];
          const variants = pairs.map((pair, i) => normalizeSeedBlank(list[i], pair)).filter(Boolean);
          if (variants.length < n) {
            return toolFail(
              'thin',
              `Нужно ровно ${n} кандидатов: у каждого затравка, конфликт, динамика и последствия.`,
            );
          }
          draft.variants = variants;
          return { ok: true, count: n };
        },
      },
    ],
    maxTurns: 3,
    toolChoice: { type: 'function', function: { name: 'submit_freeform_seed_blanks' } },
    log,
    scene: 'freeform_architect_seed',
    extraSystem: '',
    userMessages: [
      {
        role: 'user',
        content: [
          '====================',
          'ДЕЙСТВИЕ ИГРОКА (стартовая хроника)',
          '====================',
          seedText,
          '',
          formatFreeformGravityForPrompt(gravity, config),
          '',
          formatFreeformSeedAxisPairsForPrompt(pairs),
          '',
          `Верни ровно ${n} кандидатов через submit_freeform_seed_blanks, в порядке пар.`,
          'У каждого: затравка, конфликт, динамика, последствия. Gravity — посадка в поле «последствия», не размер затравки.',
        ].join('\n'),
      },
    ],
  };
  const prompt = captureAgentPrompt(runtime, runOpts);
  try {
    await runtime.run(runOpts);
  } catch (err) {
    log.warn('freeform.architect_seed_failed', { error: err.message });
  }
  return { variants: draft.variants || [], prompt };
}

async function askBeatBlanks({ runtime, cfg, log, userContent }) {
  const draft = { variants: null };
  const min = cfg.variantsMin;
  const max = cfg.variantsMax;
  await runtime.run({
    agentId: 'freeformArchitectTell',
    tools: [
      {
        name: 'submit_freeform_beat_blanks',
        description: `От ${min} до ${max} разных продолжений.`,
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['variants'],
          properties: {
            variants: {
              type: 'array',
              minItems: min,
              maxItems: max,
              items: {
                type: 'object',
                required: ['whatHappens', 'situationNow', 'closed'],
                properties: {
                  title: { type: 'string' },
                  whatHappens: { type: 'string' },
                  situationNow: { type: 'string' },
                  closeWhen: { type: 'array', items: { type: 'string' } },
                  hiddenPremises: { type: 'array', items: { type: 'string' } },
                  urgency: { type: 'integer' },
                  closed: { type: 'boolean' },
                  closedBy: { type: 'string' },
                },
              },
            },
          },
        },
        handler: async (args) => {
          const list = Array.isArray(args?.variants) ? args.variants : [];
          const variants = list.map((v) => normalizeBeatBlank(v)).filter(Boolean);
          if (variants.length < min) {
            return toolFail('thin', `Нужно ${min}–${max} разных продолжений с whatHappens и situationNow.`);
          }
          draft.variants = variants.slice(0, max);
          return { ok: true, count: draft.variants.length };
        },
      },
    ],
    maxTurns: 3,
    toolChoice: { type: 'function', function: { name: 'submit_freeform_beat_blanks' } },
    log,
    scene: 'freeform_architect_beat',
    extraSystem: '',
    userMessages: [{ role: 'user', content: userContent }],
  });
  return draft.variants;
}

export async function inventSeedBlanks({ runtime, seedText, cfg, config, gravity, log }) {
  const n = cfg.variantsMax;
  const pairs = pickFreeformSeedAxisPairs(config, n);
  log.info('freeform.architect.seed_pairs', {
    count: pairs.length,
    gravity,
    tags: pairs.map((tags) => tags.map((t) => `${t.groupId}:${t.tagId}`).join('+')),
  });
  return askSeedParagraphs({ runtime, seedText, pairs, gravity, config, log });
}

export async function inventBeatBlanks({ runtime, domain, plot, deed, cfg, log }) {
  const min = cfg.variantsMin;
  const max = cfg.variantsMax;
  return askBeatBlanks({
    runtime,
    cfg,
    log,
    userContent: [
      plotChronicleForPrompt(domain, plot),
      '',
      plotCardForPrompt(plot, { revealHidden: true }),
      '',
      `Дело: ${deed.summary}`,
      deed.detail ? `Подробности: ${deed.detail}` : '',
      `Длительность: ${deed.durationMonths} мес.`,
      `Исход дела (уже брошен системой, не перерешай): ${finishLabel(deed.finish)}.`,
      '',
      `Придумай ${min}–${max} РАЗНЫХ продолжений через submit_freeform_beat_blanks.`,
      'Главная задача — разнообразие: разное ЧТО случилось после этого исхода, не разные процедуры вокруг одного хода.',
      'Города у тебя нет. Не выдумывай службы и ремёсла. Люди — из хроники и карточки, иначе роли.',
      'closeWhen/hiddenPremises/urgency — только если ход их реально сдвинул, иначе опусти.',
      'closed=true только если один из closeWhen уже произошёл в whatHappens. Не закрывай рано.',
    ]
      .filter(Boolean)
      .join('\n'),
  });
}

export async function repairFreeformBlank({ runtime, blank, repair, kind, log }) {
  const normalize = kind === 'beat' ? normalizeBeatBlank : (raw) => normalizeSeedBlank(raw);
  const patched = await repairFreeformVariant({
    runtime,
    agentId: freeformArchitectAgentId(kind),
    variant: blank,
    repair,
    extraSystem: '',
    log,
  });
  return normalize(patched) || blank;
}

export async function architectFreeformBlanks({
  runtime,
  domain,
  plot,
  seedText,
  deed,
  kind,
  config,
  gravity,
  log: parentLog,
}) {
  const log = (parentLog || getLogger()).child({ scope: 'freeform.architect', kind });
  const cfg = freeformConfig(config);
  let variants = [];
  let prompt = '';
  try {
    if (kind === 'beat') {
      variants = (await inventBeatBlanks({ runtime, domain, plot, deed, cfg, log })) || [];
    } else {
      const seeded = await inventSeedBlanks({ runtime, seedText, cfg, config, gravity, log });
      variants = seeded?.variants || [];
      prompt = seeded?.prompt || '';
    }
  } catch (err) {
    log.warn('freeform.architect_failed', { error: err.message });
  }
  return { cfg, variants, prompt };
}
