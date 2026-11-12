import { z } from 'zod';

export const themesSchema = z.object({
  existing: z.array(z.string().trim().min(1).max(60)).max(2).default([]),
  fresh: z.string().trim().min(2).max(60).nullable().default(null),
});

export type ThemesRaw = z.infer<typeof themesSchema>;
