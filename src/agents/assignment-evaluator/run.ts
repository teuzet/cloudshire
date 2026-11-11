/**
 * Оценщик поручения: как текст поручения относится к одному фронту.
 * Числа (скорость, effort) считает ядро по вердикту.
 */

import type { Front, Officer } from '../../core/city.js';
import type { AssignmentVerdict } from '../../core/world/assignments.js';
import { composeSystem, loadPrompt } from '../_shared/canon.js';
import { frontBlock, officerLine } from '../_shared/format.js';
import { runStructured, type AgentDeps, type StructuredAgent } from '../_shared/runtime.js';
import { assignmentEvalSchema, type AssignmentEvalRaw } from './schema.js';

export interface AssignmentEvalInput {
  front: Front;
  officer: Officer;
  text: string;
}

const prompt = loadPrompt(import.meta.url);

export const assignmentEvaluator: StructuredAgent<AssignmentEvalInput, AssignmentEvalRaw, AssignmentVerdict> = {
  name: 'assignment-evaluator',
  tool: 'submit_assignment_eval',
  description: 'Как поручение относится к фронту.',
  schema: assignmentEvalSchema,
  system: ({ front, officer }) => composeSystem(['world'], prompt, frontBlock(front), `Сановник: ${officerLine(officer)}`),
  user: ({ text }) => `Поручение: ${text}`,
  check: (raw, { front }) => {
    const live = new Set(front.events.filter((e) => e.status !== 'fired').map((e) => e.id));
    const foreign = raw.blocks.filter((id) => !live.has(id));
    return foreign.length ? `нет таких событий: ${foreign.join(', ')}` : null;
  },
  finish: (raw) => ({ direction: raw.direction, efficiency: raw.efficiency, blocks: raw.blocks, stopWhen: raw.stop_when }),
};

export async function evaluateAssignment(deps: AgentDeps, input: AssignmentEvalInput): Promise<AssignmentVerdict> {
  return (await runStructured(deps, assignmentEvaluator, input)).value;
}
