import { z } from 'zod';

export const CANON_VERDICTS = ['possible', 'amended', 'unattainable'] as const;
export type CanonVerdict = (typeof CANON_VERDICTS)[number];

export const canonSchema = z.object({
  verdict: z.enum(CANON_VERDICTS),
  reason: z.string().trim().min(1).max(400),
  amended_goal: z.string().trim().max(400).nullable().default(null),
  gaps: z.array(z.string().trim().min(1).max(200)).max(3).default([]),
});

export type CanonRaw = z.infer<typeof canonSchema>;
