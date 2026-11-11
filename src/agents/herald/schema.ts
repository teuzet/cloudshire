import { z } from 'zod';

export const newsSchema = z.object({ text: z.string().trim().min(1).max(2500) });

export type NewsRaw = z.infer<typeof newsSchema>;
