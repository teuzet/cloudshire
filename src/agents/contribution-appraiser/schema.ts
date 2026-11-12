import { z } from 'zod';
import { GRADES, STAT_IDS } from '../../core/rules.js';

export const contributionSchema = z.object({
  effects: z
    .array(z.object({ stat: z.enum(STAT_IDS), direction: z.enum(['up', 'down']), size: z.enum(GRADES) }))
    .max(STAT_IDS.length)
    .default([]),
  reason: z.string().trim().max(400).default(''),
});

export type ContributionRaw = z.infer<typeof contributionSchema>;
