import { z } from 'zod';

export const feasibilitySchema = z.object({
  verdict: z.enum(['FEASIBLE', 'LOCKED', 'IMPOSSIBLE']),
  missing: z.string().optional(),
  reason: z.string().optional(),
});

export type FeasibilityRaw = z.infer<typeof feasibilitySchema>;
