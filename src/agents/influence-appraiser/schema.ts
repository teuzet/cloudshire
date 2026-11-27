import { z } from 'zod';

export const INFLUENCE_WORDS = ['removes_cause', 'stops', 'slows', 'hurries', 'helps_work', 'hinders_work', 'safer', 'riskier', 'changes_outcome'] as const;
export type InfluenceWord = (typeof INFLUENCE_WORDS)[number];

/** Слова только для того, что надвигается само, и только для того, что ведут люди. */
export const SELF_WORDS: readonly InfluenceWord[] = ['slows', 'hurries'];
export const PEOPLE_WORDS: readonly InfluenceWord[] = ['helps_work', 'hinders_work', 'safer', 'riskier'];
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
        // Что сторона получает от готового результата: loses — теряет, gains — выигрывает.
        stance: z.enum(['loses', 'gains']),
      }),
    )
    .max(8)
    .default([]),
  reason: z.string().trim().max(400).default(''),
});

export type InfluenceRaw = z.infer<typeof influenceSchema>;
