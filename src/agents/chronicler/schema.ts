import { z } from 'zod';

export const chronicleSchema = z.object({
  text: z.string().trim().min(1).max(1500),
});

export type ChronicleRaw = z.infer<typeof chronicleSchema>;
