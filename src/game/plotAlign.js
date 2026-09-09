import { isStakedStory, plotsForProcess } from './plotlines.js';
import { liveThreats } from './threats.js';
import { getLogger } from '../log.js';

export const PLOT_ENGAGEMENTS = ['DIRECT', 'RELEVANT', 'DANGEROUS', 'UNRELATED'];

/**
 * DIRECT / RELEVANT / DANGEROUS / UNRELATED.
 * Старый boolean: true → DIRECT, false → RELEVANT (дело на нити, но не closeWhen).
 * Пустое поле — вердикта ещё нет, это не UNRELATED.
 */
export function engagementOf(process) {
  const raw = String(process?.plotEngagement || '').toUpperCase();
  if (PLOT_ENGAGEMENTS.includes(raw)) return raw;
  if (process?.plotAligned === true) return 'DIRECT';
  if (process?.plotAligned === false) return 'RELEVANT';
  return null;
}

/** Опасное дело тоже висит на нити: оно её двигает, только не в ту сторону. */
export function engagementAttends(engagement) {
  return engagement === 'DIRECT' || engagement === 'RELEVANT' || engagement === 'DANGEROUS';
}

export function applyEngagement(process, engagement, { endingId = '', threatId = '' } = {}) {
  const value = PLOT_ENGAGEMENTS.includes(engagement) ? engagement : 'UNRELATED';
  if (process) {
    process.plotEngagement = value;
    process.plotAligned = value === 'DIRECT';
    process.endingId = value === 'DIRECT' ? String(endingId || '') : '';
    process.threatId = value === 'RELEVANT' || value === 'DANGEROUS' ? String(threatId || '') : '';
  }
  return value;
}

/**
 * Крошечный судья: цель дела к closeWhen — DIRECT / RELEVANT / UNRELATED.
 * На старте — чтобы не глушить urgency посторонним делом.
 * На финише вызывается снова: closeWhen и цель могли измениться.
 * Ошибка агента → UNRELATED, иначе сломанный align заморозит сюжет.
 */
/** Беды показываем формулировкой и полосой остатка: дней агенту знать не нужно. */
function threatsBrief(plot) {
  return liveThreats(plot)
    .filter((t) => t.outcome !== 'neutral')
    .map((t) => `- [${t.id}] ${t.text}`)
    .join('\n');
}

function endingsBrief(plot) {
  const rows = Array.isArray(plot?.endings) ? plot.endings : [];
  if (!rows.length) return '';
  return rows
    .slice(0, 6)
    .map((e) => `- ${e.kind || e.type || ''}: ${e.text || e.summary || e.title || ''}`)
    .filter((line) => line.replace(/^-\s*/, '').trim())
    .join('\n');
}

export async function judgeProcessAlignment({ runtime, domain, process, plot, log: parentLog }) {
  if (!process || !isStakedStory(plot)) return null;
  const log = (parentLog || getLogger()).child({ scope: 'plot.align', plotId: plot.id });
  const draft = { engagement: null, endingId: '', threatId: '' };

  try {
    await runtime.run({
      agentId: 'plotAlign',
      tools: [
        {
          name: 'submit_alignment',
          description: 'Отношение цели дела к условию закрытия истории.',
          parameters: {
            type: 'object',
            required: ['relation'],
            properties: {
              relation: {
                type: 'string',
                enum: PLOT_ENGAGEMENTS,
                description:
                  'DIRECT — успех сам ставит концовку. RELEVANT — успех снимает нависшую беду. ' +
                  'DANGEROUS — успех сам вызывает беду или плохую концовку. UNRELATED — сюжет не двигает.',
              },
              endingId: { type: 'string', description: 'id концовки, если relation=DIRECT.' },
              threatId: {
                type: 'string',
                description: 'id беды, если relation=RELEVANT (снимает) или DANGEROUS (вызывает).',
              },
            },
          },
          handler: async (args) => {
            const rel = String(args?.relation || '').toUpperCase();
            draft.engagement = PLOT_ENGAGEMENTS.includes(rel) ? rel : 'UNRELATED';
            draft.endingId = String(args?.endingId || '').trim();
            draft.threatId = String(args?.threatId || '').trim();
            return { ok: true };
          },
        },
      ],
      maxTurns: 2,
      toolChoice: { type: 'function', function: { name: 'submit_alignment' } },
      log,
      scene: 'plot_align',
      domainId: domain?.id,
      userMessages: [
        {
          role: 'user',
          content: [
            `История (${plot.storyType || plot.kind || ''}).`,
            plot.closeWhen ? `Закрывается, когда: ${plot.closeWhen}` : '',
            endingsBrief(plot) ? `Концовки карточки:\n${endingsBrief(plot)}` : '',
            plot.mootWhen ? `История теряет смысл, когда: ${plot.mootWhen}` : '',
            threatsBrief(plot) ? `Нависшие беды:\n${threatsBrief(plot)}` : 'Нависших бед в карточке нет.',
            plot.synopsis ? `Сейчас: ${plot.synopsis}` : '',
            `Дело: ${process.summary || ''}`,
            process.goal ? `Цель дела: ${process.goal}` : '',
            process.detail ? `Поручение: ${process.detail}` : '',
            'Верни один вердикт по цели process, не по броску.',
            'DIRECT: успех сам ставит концовку карточки — укажи endingId.',
            'RELEVANT: успех делает одну из перечисленных бед невозможной — укажи threatId.',
            'DANGEROUS: успех сам вызывает одну из бед или плохую концовку — укажи threatId.',
            'UNRELATED: даже полный успех историю не двигает. Не ставь RELEVANT за случайную улику.',
          ]
            .filter(Boolean)
            .join('\n'),
        },
      ],
    });
  } catch (err) {
    log.warn('plot.align_failed', { error: err.message });
  }

  if (!draft.engagement) {
    log.info('plot.align_pending', { summary: process.summary });
    return null;
  }
  const engagement = applyEngagement(process, draft.engagement, {
    endingId: draft.endingId,
    threatId: draft.threatId,
  });
  log.info('plot.align', { summary: process.summary, engagement, threatId: process.threatId || null });
  return engagement;
}

function findProcess(domain, processId) {
  return (domain?.state?.pendingActions || []).find((a) => String(a.id) === String(processId)) || null;
}

/** Пересчитать relation завершившихся дел к текущему closeWhen. */
export async function realignFinishedOutcomes({ runtime, domain, outcomes = [], log } = {}) {
  for (const outcome of outcomes) {
    if (!outcome?.finished) continue;
    const process = findProcess(domain, outcome.processId);
    if (!process) continue;
    const plot = plotsForProcess(domain, outcome.processId).find((p) => isStakedStory(p));
    if (!plot) continue;
    const engagement = await judgeProcessAlignment({ runtime, domain, process, plot, log });
    if (!engagement) continue;
    outcome.plotEngagement = engagement;
    outcome.plotAligned = engagement === 'DIRECT';
  }
  return outcomes;
}
