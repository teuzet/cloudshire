import { getLogger } from '../log.js';
import { toolFail } from '../agents/toolResult.js';
import { formatFullChronicleForPrompt } from './memory.js';
import { normalizeConfluxBoard } from './confluxBoard.js';
import { formatContactForPrompt } from './conflux.js';

function clamp100(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  return Math.max(0, Math.min(100, Math.round(v)));
}

/**
 * Только выставляет информированность 0–100 каждой стороне. Только в фазе docked.
 */
export async function scoreConfluxAwareness({
  config,
  runtime,
  conflux,
  domains,
  world,
  log: parentLog,
}) {
  if (!conflux || conflux.status !== 'docked') return conflux?.awareness || {};
  normalizeConfluxBoard(conflux);
  const log = (parentLog || getLogger()).child({ scope: 'conflux.awareness', confluxId: conflux.id });
  const [a, b] = domains || [];
  if (!a || !b) return conflux.awareness;

  const draft = { scores: null };
  const tools = [
    {
      name: 'submit_awareness',
      description: 'Насколько каждый город знает внутреннюю жизнь другого: 0 — ничего, 100 — всё, кроме чужих тайн.',
      parameters: {
        type: 'object',
        required: ['scores'],
        properties: {
          scores: {
            type: 'array',
            minItems: 2,
            maxItems: 2,
            items: {
              type: 'object',
              required: ['domainId', 'value'],
              properties: {
                domainId: { type: 'string' },
                value: { type: 'number', description: '0–100' },
              },
            },
          },
        },
      },
      handler: async ({ scores }) => {
        const list = Array.isArray(scores) ? scores : [];
        const next = {};
        for (const row of list) {
          const id = String(row?.domainId || '');
          const value = clamp100(row?.value);
          if (!id || value == null) {
            return toolFail('bad_score', 'Нужны domainId и value 0–100 для обоих городов.');
          }
          next[id] = value;
        }
        if (next[a.id] == null || next[b.id] == null) {
          return toolFail('both_required', `Нужны оценки для ${a.id} и ${b.id}.`);
        }
        draft.scores = next;
        return { ok: true };
      },
    },
  ];

  const pack = (domain) => {
    const hidden = (domain.lore || []).filter((f) => f?.secret);
    return [
      `Город «${domain.name}» (id: ${domain.id})`,
      formatFullChronicleForPrompt(domain) || '(пусто)',
      hidden.length
        ? `Что этот город прячет от чужих:\n${hidden.map((f) => `- ${f.text}`).join('\n')}`
        : 'От чужих этот город ничего специально не прячет.',
    ].join('\n');
  };

  try {
    await runtime.run({
      agentId: 'confluxAwareness',
      tools,
      maxTurns: 4,
      toolChoice: { type: 'function', function: { name: 'submit_awareness' } },
      log,
      scene: 'conflux_awareness',
      domainId: `${a.id}+${b.id}`,
      userMessages: [
        {
          role: 'user',
          content: [
            `Дата: ${world?.gameDate?.label || ''}.`,
            conflux.contact?.kind ? formatContactForPrompt(conflux.contact) : null,
            `Месяц встречи: ${conflux.monthsDocked || 0} из ${conflux.durationMonths || '?'}.`,
            'Прочитай хроники обоих и оцени, насколько каждый город знает внутреннюю жизнь ДРУГОГО.',
            'То, что город прячет от чужих, в оценку не входит.',
            '',
            pack(a),
            '',
            pack(b),
            '',
            'Вызови submit_awareness. Нужны два числа — по одному на каждый город.',
          ]
            .filter(Boolean)
            .join('\n'),
        },
      ],
    });
  } catch (err) {
    log.warn('conflux.awareness_failed', { error: err.message });
  }

  if (draft.scores) {
    conflux.awareness = { ...conflux.awareness, ...draft.scores };
    log.info('conflux.awareness', { awareness: conflux.awareness });
  }
  return conflux.awareness;
}
