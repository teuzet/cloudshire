import { z } from 'zod';
import { IMPACT_LEVELS } from '../../core/rules.js';
import { profileSchema } from '../_shared/schemas.js';

export const impactSchema = z.object({
  impact: z.enum(IMPACT_LEVELS),
  stat_profile: profileSchema,
});

export type ImpactRaw = z.infer<typeof impactSchema>;
