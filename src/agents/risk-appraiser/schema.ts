import { z } from 'zod';
import { RISK_STEPS } from '../../core/rules.js';

export const riskSchema = z.object({
  step: z.enum(RISK_STEPS),
  reason: z.string().trim().max(400).default(''),
});

export type RiskRaw = z.infer<typeof riskSchema>;
