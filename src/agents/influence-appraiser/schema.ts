import { z } from 'zod';

export const INFLUENCE_WORDS = ['removes_cause', 'stops', 'slows', 'hurries', 'safer', 'riskier', 'changes_outcome'] as const;
export type InfluenceWord = (typeof INFLUENCE_WORDS)[number];

export const influenceSchema = z.object({
  effects: z
    .array(
      z.object({
        id: z.string().trim().min(1),
        effect: z.enum(INFLUENCE_WORDS),
        basis: z.enum(['solid', 'word']).default('solid'),
      }),
    )
    .max(8)
    .default([]),
  sides: z
    .array(
      z.object({
        id: z.string().trim().min(1),
        stance: z.enum(['harms', 'helps']),
      }),
    )
    .max(8)
    .default([]),
  reason: z.string().trim().max(400).default(''),
});

export type InfluenceRaw = z.infer<typeof influenceSchema>;
