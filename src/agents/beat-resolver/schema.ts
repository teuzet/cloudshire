import { z } from 'zod';

export const beatPickSchema = z.object({
  event_id: z.string().optional(),
  clue_id: z.string().optional(),
});

export type BeatPickRaw = z.infer<typeof beatPickSchema>;
