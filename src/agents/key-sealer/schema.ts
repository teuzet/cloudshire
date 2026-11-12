import { z } from 'zod';

export const keySchema = z.object({
  moves: z.array(z.string().trim().min(3).max(160)).min(3).max(5),
  twist: z.string().trim().max(400).nullable().default(null),
});

export type KeyRaw = z.infer<typeof keySchema>;
