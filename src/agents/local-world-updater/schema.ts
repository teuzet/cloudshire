import { z } from 'zod';

export const localUpdateSchema = z.object({
  verdict: z.enum(['unchanged', 'updated', 'invalid', 'resolved']),
  text: z.string().optional(),
});

export type LocalUpdateRaw = z.infer<typeof localUpdateSchema>;
