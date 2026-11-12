import { z } from 'zod';

export const EXISTENCE_VERDICTS = ['exists', 'invent', 'absent', 'unknown'] as const;
export type ExistenceVerdict = (typeof EXISTENCE_VERDICTS)[number];

export const existenceSchema = z.object({
  verdict: z.enum(EXISTENCE_VERDICTS),
  object_id: z.string().trim().min(1).nullable().default(null),
  reason: z.string().trim().max(300).default(''),
});

export type ExistenceRaw = z.infer<typeof existenceSchema>;
