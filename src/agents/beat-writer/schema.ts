import { z } from 'zod';

export const BEAT_EFFECTS = ['none', 'reveal'] as const;
export type BeatEffect = (typeof BEAT_EFFECTS)[number];

export const beatSchema = z.object({
  text: z.string().trim().min(1).max(900),
  effect: z.enum(BEAT_EFFECTS).default('none'),
});

export type BeatRaw = z.infer<typeof beatSchema>;
