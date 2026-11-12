import { z } from 'zod';

export const descriptionSchema = z.object({
  description: z.string().trim().min(1).max(560),
});

export type DescriptionRaw = z.infer<typeof descriptionSchema>;
