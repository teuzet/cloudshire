import { z } from 'zod';

export const fitSchema = z.object({
  fits: z.boolean(),
  reason: z.string().trim().max(240).default(''),
});

export type FitRaw = z.infer<typeof fitSchema>;
