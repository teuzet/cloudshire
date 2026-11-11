import { z } from 'zod';

export const consequenceVerdictSchema = z.object({ ok: z.boolean(), reason: z.string().optional() });

export type ConsequenceVerdictRaw = z.infer<typeof consequenceVerdictSchema>;
