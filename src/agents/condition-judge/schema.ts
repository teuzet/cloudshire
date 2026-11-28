import { z } from 'zod';

export const conditionSchema = z.object({
  met: z.boolean(),
  reason: z.string().trim().max(240).default(''),
});

export type ConditionRaw = z.infer<typeof conditionSchema>;
