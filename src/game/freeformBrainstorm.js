/**
 * Генератор трёх затравок: код бросает оси, модель раскрывает их в четыре поля.
 * Судью и карточку истории не вызывает — лаборатория читает пачку как есть.
 */

import { getLogger } from '../log.js';
import { toolFail } from '../agents/toolResult.js';
import { parseFreeformGravity, formatFreeformGravityForPrompt, freeformConfig } from './freeform.js';
import {
  pickFreeformSeedAxisPairs,
  normalizeSeedBlank,
  captureAgentPrompt,
  formatFreeformArenaRelationCatalogs,
} from './freeformArchitect.js';

export const CONFLICT_SOURCES = [
  {
    id: 'EXTERNAL_THREAT',
    hint: 'угроза снаружи привычного круга: стихия, зверь, чужой интерес, давление с моря или материка. Не чужой остров и не «прибывшие с соседнего острова», если канон не даёт текущего сопряжения',
  },
  {
    id: 'INTERNAL_BETRAYAL',
    hint: 'кто-то внутри круга доверия ломает договор, молчание или долг',
  },
  {
    id: 'SYSTEMIC_CRISIS',
    hint: 'ломается устройство, на котором держится жизнь. Структура, которую чинят делом, не канцелярия и не потерянная бумага',
  },
  {
    id: 'SUPERNATURAL_ANOMALY',
    hint: 'редкий сбой порядка мира. Не уличная магия и не «просто странно»',
  },
  {
    id: 'MORAL_DILEMMA',
    hint: 'два законных требования, нельзя удовлетворить оба. Нет злодея',
  },
  {
    id: 'DELAYED_CONSEQUENCE',
    hint: 'нынешнее — дозревший плод старого решения, уговора или отказа. Ищи причину назад по хронике, не изобретай новую угрозу с нуля',
  },
  {
    id: 'RIVAL_IDEOLOGY',
    hint: 'столкновение двух правд о том, как жить вместе. Не ссора характеров',
  },
];

export const TEMPORAL_SHAPES = [
  {
    id: 'FRESH_INCIDENT',
    hint: 'только что случилось; ещё нет привычки',
  },
  {
    id: 'LONG_SIMMERING',
    hint: 'тлело давно; сейчас нельзя больше делать вид, что этого нет',
  },
  {
    id: 'CYCLICAL_PATTERN',
    hint: 'это уже повторялось, и каждый круг хуже или дороже',
  },
  {
    id: 'DELAYED_BOMB',
    hint: 'решение или повреждение уже есть; разрыв ещё впереди',
  },
  {
    id: 'ALREADY_CLIMAX',
    hint: 'кульминация уже идёт; входишь в неё, а не начинаешь расследование с нуля',
  },
];

function pickWithoutReplacement(items, n, rng) {
  const pool = [...items];
  const out = [];
  for (let i = 0; i < n && pool.length; i += 1) {
    const idx = Math.min(pool.length - 1, Math.max(0, Math.floor(rng() * pool.length)));
    out.push(pool.splice(idx, 1)[0]);
  }
  return out;
}

function formatCatalogBlock(title, entries) {
  const lines = [title];
  for (const entry of entries) {
    lines.push(`${entry.id} — ${entry.hint}`);
  }
  return lines.join('\n');
}

function pairTagName(pair, groupId) {
  const aliases = groupId === 'threatArena' ? ['threatArena', 'truthArena'] : [groupId];
  return (pair || []).find((t) => aliases.includes(t.groupId))?.tagName || '';
}

function axisEcho(raw, key) {
  return String(raw?.[key] || '')
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '_');
}

export function pickFreeformBrainstormRolls(config, count, rng = Math.random) {
  const n = Math.max(1, Math.round(Number(count) || 1));
  const pairs = pickFreeformSeedAxisPairs(config, n, rng);
  const sources = pickWithoutReplacement(CONFLICT_SOURCES, n, rng);
  const shapes = pickWithoutReplacement(TEMPORAL_SHAPES, n, rng);
  return pairs.map((pair, i) => ({
    pair,
    conflictSource: sources[i] || sources[0],
    temporalShape: shapes[i] || shapes[0],
  }));
}

export function formatFreeformBrainstormRollsForPrompt(rolls) {
  if (!rolls?.length) return '';
  const lines = [
    'Оси уже брошены кодом. Не выбирай и не меняй их — раскрой в текст.',
    'Метки — ассоциативные поля, не жанр и не обязательные существительные.',
    '',
    formatFreeformArenaRelationCatalogs(),
    '',
    formatCatalogBlock('conflictSource', CONFLICT_SOURCES),
    '',
    formatCatalogBlock('temporalShape', TEMPORAL_SHAPES),
    '',
    'Наборы. На каждый — четыре поля (затравка, конфликт, динамика, последствия), в этом порядке:',
  ];
  rolls.forEach((roll, i) => {
    const arena = pairTagName(roll.pair, 'threatArena') || '?';
    const rel = pairTagName(roll.pair, 'worldRelation') || '?';
    lines.push(`${i + 1}. ${arena} · ${rel} · ${roll.conflictSource.id} · ${roll.temporalShape.id}`);
  });
  return lines.join('\n').trim();
}

export function normalizeBrainstormCandidate(raw, roll, index = 1) {
  const blank = normalizeSeedBlank(raw, roll?.pair || []);
  if (!blank) return null;
  return {
    ...blank,
    index,
    conflictSource: roll.conflictSource.id,
    temporalShape: roll.temporalShape.id,
  };
}

function logAxisEchoMismatch(log, index, raw, roll) {
  const expected = {
    threatArena: pairTagName(roll.pair, 'threatArena'),
    worldRelation: pairTagName(roll.pair, 'worldRelation'),
    conflictSource: roll.conflictSource.id,
    temporalShape: roll.temporalShape.id,
  };
  const got = {
    threatArena: axisEcho(raw, 'threatArena') || axisEcho(raw, 'arena'),
    worldRelation: axisEcho(raw, 'worldRelation'),
    conflictSource: axisEcho(raw, 'conflictSource'),
    temporalShape: axisEcho(raw, 'temporalShape'),
  };
  const mismatched = Object.keys(expected).filter((key) => got[key] && got[key] !== expected[key]);
  if (!mismatched.length) return;
  log.warn('freeform.brainstorm.axis_echo_mismatch', { index, expected, got, mismatched });
}

export async function brainstormFreeformSeeds({ runtime, seedText, gravity, config, log: parentLog }) {
  const log = (parentLog || getLogger()).child({ scope: 'freeform.brainstorm' });
  const cfg = freeformConfig(config);
  const n = cfg.variantsMax;
  const g = parseFreeformGravity(gravity);
  const rolls = pickFreeformBrainstormRolls(config, n);
  log.info('freeform.brainstorm.rolls', {
    count: rolls.length,
    gravity: g,
    tags: rolls.map((roll) =>
      [
        ...(roll.pair || []).map((t) => `${t.groupId}:${t.tagId}`),
        roll.conflictSource.id,
        roll.temporalShape.id,
      ].join('+'),
    ),
  });

  const draft = { variants: null };
  const runOpts = {
    agentId: 'freeformBrainstorm',
    tools: [
      {
        name: 'emit_freeform_candidates',
        description: `Ровно ${n} кандидатов: четыре поля на каждый набор осей, в том же порядке. Оси в ответе — эхо входа, не новый выбор.`,
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['candidates'],
          properties: {
            candidates: {
              type: 'array',
              minItems: n,
              maxItems: n,
              items: {
                type: 'object',
                required: ['hook', 'conflict', 'dynamics', 'consequences'],
                properties: {
                  hook: {
                    type: 'string',
                    description: 'Затравка: компактная сцена, 1–2 предложения. Что уже произошло. Фитиль, не взрыв.',
                  },
                  conflict: {
                    type: 'string',
                    description: 'Конфликт: что сейчас двигает сюжет.',
                  },
                  dynamics: {
                    type: 'string',
                    description: 'Динамика: процесс, которым ситуация вырастет до посадки Gravity.',
                  },
                  consequences: {
                    type: 'string',
                    description: 'Последствия: посадка истории на уровне Gravity. Динамика должна её зарабатывать, не приклеивать.',
                  },
                  threatArena: { type: 'string', description: 'Эхо оси threatArena этого набора.' },
                  worldRelation: { type: 'string', description: 'Эхо оси worldRelation этого набора.' },
                  conflictSource: { type: 'string', description: 'Эхо оси conflictSource этого набора.' },
                  temporalShape: { type: 'string', description: 'Эхо оси temporalShape этого набора.' },
                },
              },
            },
          },
        },
        handler: async (args) => {
          const list = Array.isArray(args?.candidates) ? args.candidates : [];
          const variants = rolls
            .map((roll, i) => {
              logAxisEchoMismatch(log, i + 1, list[i], roll);
              return normalizeBrainstormCandidate(list[i], roll, i + 1);
            })
            .filter(Boolean);
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
    toolChoice: { type: 'function', function: { name: 'emit_freeform_candidates' } },
    log,
    scene: 'freeform_brainstorm_seed',
    extraSystem: '',
    userMessages: [
      {
        role: 'user',
        content: [
          '====================',
          'ХРОНИКА',
          '====================',
          seedText,
          '',
          formatFreeformGravityForPrompt(g),
          '',
          formatFreeformBrainstormRollsForPrompt(rolls),
          '',
          `Верни ровно ${n} кандидатов через emit_freeform_candidates, в порядке наборов.`,
          'У каждого: затравка, конфликт, динамика, последствия. Gravity — посадка в поле «последствия», не размер затравки.',
          'Оси в ответе верни такими, какими получил.',
        ].join('\n'),
      },
    ],
  };

  const prompt = captureAgentPrompt(runtime, runOpts);
  try {
    await runtime.run(runOpts);
  } catch (err) {
    log.warn('freeform.brainstorm_failed', { error: err.message });
  }

  const candidates = draft.variants || [];
  return {
    ok: candidates.length >= n,
    gravity: g,
    rolls,
    candidates,
    prompt,
  };
}
