import { z } from 'zod';
import { FAITH_CASES, FAITH_STRENGTHS } from '../../core/rules.js';

export const faithSchema = z.object({
  case: z.enum(FAITH_CASES),
  strength: z.enum(FAITH_STRENGTHS).default('minor'),
});

export type FaithRaw = z.infer<typeof faithSchema>;
