import { getLogger } from '../log.js';
import { toolFail } from '../agents/toolResult.js';
import { captureAgentPrompt } from './agentPrompt.js';
import { newId } from './ids.js';
import {
  FREEFORM_ENDING_KINDS,
  normalizeFreeformEndings,
  parseFreeformEndingKind,
} from './plotlines.js';
import { plotCardForPrompt, plotChronicleForPrompt } from './freeform.js';

export function fallbackFreeformEndings() {
  return normalizeFreeformEndings([
    { id: 'end_good', kind: 'GOOD_ENDING', text: 'Ставки истории сыграли.' },
    { id: 'end_neutral', kind: 'NEUTRAL_ENDING', text: 'Дело сошлось без победы и крушения.' },
    { id: 'end_bad', kind: 'BAD_ENDING', text: 'Ставки истории проиграны.' },
  ]);
}

function ensureEndingKinds(list) {
  const have = new Set((list || []).map((e) => e.kind));
  const out = [...(list || [])];
  for (const kind of FREEFORM_ENDING_KINDS) {
    if (have.has(kind)) continue;
    const fb = fallbackFreeformEndings().find((e) => e.kind === kind);
    if (fb) out.push({ ...fb, id: newId('end') });
  }
  return out;
}

function applyEndings(plot, list) {
  const endings = ensureEndingKinds(normalizeFreeformEndings(list));
  plot.endings = endings;
  plot.closeWhen = endings.map((e) => e.text);
  return endings;
}

export async function refreshFreeformEndings({ runtime, domain, plot, log: parentLog } = {}) {
  const log = (parentLog || getLogger()).child({ scope: 'freeform.endings', plotId: plot?.id });
  if (!plot) return { endings: [], keep: false, prompt: '' };
  const draft = { keep: false, endings: null };
  const runOpts = {
    agentId: 'freeformEndings',
    tools: [
      {
        name: 'submit_freeform_endings',
        description: 'Актуальный список концовок. Хотя бы одна GOOD, NEUTRAL и BAD.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['keep', 'endings'],
          properties: {
            keep: {
              type: 'boolean',
              description: 'true, если текущий список ещё держит историю.',
            },
            endings: {
              type: 'array',
              items: {
                type: 'object',
                required: ['text', 'kind'],
                properties: {
                  id: { type: 'string' },
                  text: { type: 'string', description: 'Короткое ёмкое описание концовки.' },
                  kind: { type: 'string', enum: [...FREEFORM_ENDING_KINDS] },
                },
              },
            },
          },
        },
        handler: async (args) => {
          const keep = Boolean(args?.keep);
          const raw = Array.isArray(args?.endings) ? args.endings : [];
          const endings = normalizeFreeformEndings(
            raw.map((e) => ({
              id: e?.id,
              text: e?.text,
              kind: parseFreeformEndingKind(e?.kind),
            })),
          );
          if (!keep && !endings.length) {
            return toolFail('thin', 'Нужен список концовок или keep=true.');
          }
          draft.keep = keep;
          draft.endings = endings;
          return { ok: true };
        },
      },
    ],
    maxTurns: 2,
    toolChoice: { type: 'function', function: { name: 'submit_freeform_endings' } },
    log,
    scene: 'freeform_endings',
    extraSystem: '',
    userMessages: [
      {
        role: 'user',
        content: [
          plotCardForPrompt(plot, { revealHidden: true }),
          '',
          plotChronicleForPrompt(domain, plot),
          '',
          'Скрытое учти как «На самом деле», в формулировку концовки его не пиши.',
          'Верни submit_freeform_endings. Нужна хотя бы одна концовка каждого типа.',
        ]
          .filter(Boolean)
          .join('\n'),
      },
    ],
  };
  const prompt = captureAgentPrompt(runtime, runOpts);
  try {
    await runtime.run(runOpts);
  } catch (err) {
    log.warn('freeform.endings_failed', { error: err.message });
  }

  const current = Array.isArray(plot.endings) ? plot.endings : [];
  if (draft.keep && current.length) {
    const endings = applyEndings(plot, current);
    return { endings, keep: true, prompt };
  }
  const source = draft.endings?.length ? draft.endings : current.length ? current : fallbackFreeformEndings();
  const endings = applyEndings(plot, source);
  log.info('freeform.endings', { count: endings.length, keep: Boolean(draft.keep) });
  return { endings, keep: Boolean(draft.keep), prompt };
}
