import { z } from 'zod';
import { EFFICIENCY_LEVELS } from '../../core/rules.js';

export const assignmentEvalSchema = z.object({
  direction: z.enum(['forward', 'backward', 'none']),
  efficiency: z.enum(EFFICIENCY_LEVELS),
  blocks: z.array(z.string()).default([]),
  stop_when: z.enum(['next_result', 'stake', 'cancelled']),
});

export type AssignmentEvalRaw = z.infer<typeof assignmentEvalSchema>;
