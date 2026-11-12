import type { Verdict } from '../../core/rules.js';
import { block, join } from '../_shared/blocks.js';
import { composeSystem, loadPrompt } from '../_shared/canon.js';
import { runStructured, type AgentDeps, type StructuredAgent } from '../_shared/runtime.js';
import { alignmentSchema, type AlignmentRaw } from './schema.js';

const prompt = loadPrompt(import.meta.url);

export interface AlignmentInput {
  /** «Стройка башни с баллистой. Артель кладёт цоколь…» */
  situation: string;
  moves: string[];
  /** Стратегия, атомарное дело или описание нового объекта рядом. */
  proposal: string;
}

export interface AlignmentRuling {
  verdict: Verdict;
  matchedMove: number | null;
}

export const alignmentJudge: StructuredAgent<AlignmentInput, AlignmentRaw, AlignmentRuling> = {
  name: 'alignment-judge',
  tool: 'submit_alignment',
  description: 'Насколько предложенный способ совпадает с заведомо хорошими.',
  schema: alignmentSchema,
  system: () => composeSystem([], prompt),
  user: ({ situation, moves, proposal }) =>
    join(`Ситуация: ${situation}`, block('Хорошие способы', moves.map((m, i) => `${i + 1}) ${m}`).join('\n')), `Предложено: «${proposal}»`),
  check: (raw, input) => {
    if (raw.verdict !== 'spot_on') return null;
    if (raw.matched_move == null || raw.matched_move > input.moves.length) return 'для spot_on нужен номер совпавшего способа из списка';
    return null;
  },
  finish: (raw) => ({ verdict: raw.verdict, matchedMove: raw.verdict === 'spot_on' ? raw.matched_move : null }),
};

export async function judgeAlignment(deps: AgentDeps, input: AlignmentInput): Promise<AlignmentRuling> {
  if (!input.moves.length) return { verdict: 'fits', matchedMove: null };
  return (await runStructured(deps, alignmentJudge, input)).value;
}
