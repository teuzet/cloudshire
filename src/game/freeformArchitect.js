import { getLogger } from '../log.js';
import { toolFail } from '../agents/toolResult.js';
import { clipPlotText, PLOT_TITLE_MAX, PLOT_SUMMARY_MAX } from './plotlines.js';
import {
  freeformConfig,
  formatFreeformGravityForPrompt,
  formatFreeformSeedBlank,
  formatStoryForBeatArchitect,
  finishLabel,
} from './freeform.js';
import { repairFreeformVariant } from './freeformJudge.js';
import { plotConfig, pickSuspenseAnnotationSeed } from './plotlines.js';
import { captureAgentPrompt } from './agentPrompt.js';
import {
  attachBeatDynamics,
  formatBeatDynamicsForPrompt,
  pickFreeformBeatDynamics,
  endingDynamicByKind,
} from './freeformDynamics.js';

export { formatAgentPrompt, captureAgentPrompt } from './agentPrompt.js';

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
  if (blank?.text && !blank?.hook && !blank?.conflict) return String(blank.text).trim();
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
      dynamicId: v.dynamicId || '',
      dynamicName: v.dynamicName || '',
      dynamicHint: v.dynamicHint || '',
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
  const text = clipPlotText(raw?.text || raw?.whatHappens || raw?.chronicle, PLOT_SUMMARY_MAX);
  if (!text) return null;
  const dynamicId = String(raw?.dynamicId || '').trim();
  const dynamicName = clipPlotText(raw?.dynamicName || raw?.dynamics, 80);
  const index = Number.isInteger(Number(raw?.index)) ? Number(raw.index) : undefined;
  return {
    text,
    index,
    dynamicId,
    dynamicName: dynamicName || '',
    dynamicHint: clipPlotText(raw?.dynamicHint, 200),
    dynamics: dynamicName || '',
    endingId: String(raw?.endingId || '').trim(),
    endingText: clipPlotText(raw?.endingText, PLOT_SUMMARY_MAX),
    endingKind: String(raw?.endingKind || '').trim(),
  };
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

async function askBeatBlanks({ runtime, cfg, dynamics, log, userContent }) {
  const draft = { variants: null };
  const n = dynamics?.length ? dynamics.length : cfg.variantsMax;
  const runOpts = {
    agentId: 'freeformArchitectTell',
    tools: [
      {
        name: 'submit_freeform_beat_blanks',
        description: `Ровно ${n} абзацев продолжения, по одному на каждый способ сдвига, в том же порядке.`,
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
                required: ['text'],
                properties: {
                  text: {
                    type: 'string',
                    description: 'Один абзац: что произошло дальше при этом способе сдвига.',
                  },
                },
              },
            },
          },
        },
        handler: async (args) => {
          const list = Array.isArray(args?.variants) ? args.variants : [];
          const variants = list
            .map((v, i) => {
              const blank = attachBeatDynamics(normalizeBeatBlank(v), dynamics?.[i]);
              if (!blank) return null;
              blank.index = Number(dynamics?.[i]?.index) || i + 1;
              return blank;
            })
            .filter(Boolean);
          if (variants.length < n) {
            return toolFail('thin', `Нужно ровно ${n} абзацев: по одному на каждый способ сдвига, в том же порядке.`);
          }
          draft.variants = variants.slice(0, n);
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
  };
  const prompt = captureAgentPrompt(runtime, runOpts);
  try {
    await runtime.run(runOpts);
  } catch (err) {
    log.warn('freeform.architect_beat_failed', { error: err.message });
  }
  return { variants: draft.variants || [], prompt };
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

export async function inventBeatBlanks({
  runtime,
  domain,
  plot,
  deed,
  trigger = 'deed',
  cfg,
  config,
  log,
  polarity = null,
  endingSlots = null,
  rng = Math.random,
}) {
  const slots = Array.isArray(endingSlots) && endingSlots.length ? endingSlots : null;
  const n = slots ? slots.length : cfg.variantsMax;
  const dynamics = slots
    ? slots.map((ending, i) => ({
        ...endingDynamicByKind(ending.kind),
        endingId: ending.id,
        endingText: ending.text,
        endingKind: ending.kind,
        index: i + 1,
      }))
    : pickFreeformBeatDynamics(config, n, rng, plot, { polarity }).map((d, i) => ({
        ...d,
        index: i + 1,
      }));
  const auto = trigger === 'auto';
  return askBeatBlanks({
    runtime,
    cfg: { ...cfg, variantsMax: dynamics.length },
    dynamics,
    log,
    userContent: [
      formatStoryForBeatArchitect(domain, plot),
      '',
      auto
        ? [
            'Городом эту историю не занимались. Ситуация сама сдвинулась.',
            plot?.whyMoves ? `Она клонилась к тому, что: ${plot.whyMoves}` : '',
          ]
            .filter(Boolean)
            .join('\n')
        : [
            `Поступок: ${deed?.summary || ''}`,
            deed?.detail ? `Подробности: ${deed.detail}` : '',
            `Длительность: ${deed?.durationMonths || 1} мес.`,
            `Исход (уже случился): ${finishLabel(deed?.finish)}.`,
          ]
            .filter(Boolean)
            .join('\n'),
      '',
      formatBeatDynamicsForPrompt(dynamics),
    ]
      .filter(Boolean)
      .join('\n'),
  });
}

export async function repairBeatBlanks({ runtime, drafts, reviews, log, extra = '' }) {
  const n = drafts.length;
  if (!n) return { variants: [], prompt: '' };
  const notes = (reviews || []).slice(0, n);
  const dynamics = drafts.map((blank, i) => ({
    id: blank.dynamicId,
    name: blank.dynamicName,
    hint: blank.dynamicHint,
    endingId: blank.endingId,
    endingText: blank.endingText,
    endingKind: blank.endingKind,
    index: Number(blank.index) || i + 1,
  }));
  const pack = drafts
    .map((blank, i) => {
      const review = notes[i] || { index: Number(blank.index) || i + 1, verdict: 'PASS', repair: '', summary: '' };
      return [
        `=== Кандидат ${review.index} ===`,
        blank.dynamicName ? `способ сдвига: ${blank.dynamicName}` : null,
        blank.endingText ? `концовка: ${blank.endingText}` : null,
        blank.text,
        `вердикт: ${review.verdict}`,
        review.summary ? `кратко: ${review.summary}` : null,
        review.repair ? `правка:\n${review.repair}` : 'правка: без изменений',
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n\n');
  return askBeatBlanks({
    runtime,
    cfg: { variantsMax: n },
    dynamics,
    log,
    userContent: [
      extra,
      '',
      'Доработка уже написанных абзацев по замечаниям судьи. Способ сдвига и концовку не меняй.',
      'Кандидат без правки верни тем же текстом.',
      '',
      pack,
    ]
      .filter(Boolean)
      .join('\n'),
  });
}

export async function repairFreeformBlank({ runtime, blank, repair, kind, log }) {
  const normalize = kind === 'beat' ? normalizeBeatBlank : (raw) => normalizeSeedBlank(raw);
  const { variant: patched, prompt } = await repairFreeformVariant({
    runtime,
    agentId: freeformArchitectAgentId(kind),
    variant: blank,
    repair,
    extraSystem: '',
    kind,
    log,
  });
  const next = normalize(patched) || blank;
  return {
    blank: kind === 'beat' ? attachBeatDynamics(next, blank) : next,
    prompt: prompt || '',
  };
}

export async function architectFreeformBlanks({
  runtime,
  domain,
  plot,
  seedText,
  deed,
  trigger = 'deed',
  kind,
  config,
  gravity,
  polarity = null,
  endingSlots = null,
  rng = Math.random,
  log: parentLog,
}) {
  const log = (parentLog || getLogger()).child({ scope: 'freeform.architect', kind });
  const cfg = freeformConfig(config);
  let variants = [];
  let prompt = '';
  try {
    if (kind === 'beat') {
      const beaten = await inventBeatBlanks({
        runtime,
        domain,
        plot,
        deed,
        trigger,
        cfg,
        config,
        log,
        polarity,
        endingSlots,
        rng,
      });
      variants = beaten?.variants || [];
      prompt = beaten?.prompt || '';
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
