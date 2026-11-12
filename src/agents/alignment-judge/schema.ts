import { z } from 'zod';
import { VERDICTS } from '../../core/rules.js';

export const alignmentSchema = z.object({
  verdict: z.enum(VERDICTS),
  matched_move: z.number().int().positive().nullable().default(null),
});

export type AlignmentRaw = z.infer<typeof alignmentSchema>;
