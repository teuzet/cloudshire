import { z } from 'zod';

/** Относительный профиль по статам: знак и сравнительная сила, не очки. */
export const profileSchema = z.object({
  prosperity: z.number().int().min(-5).max(5).default(0),
  security: z.number().int().min(-5).max(5).default(0),
  knowledge: z.number().int().min(-5).max(5).default(0),
  influence: z.number().int().min(-5).max(5).default(0),
});

export function isZeroProfile(p: z.infer<typeof profileSchema>): boolean {
  return !p.prosperity && !p.security && !p.knowledge && !p.influence;
}
