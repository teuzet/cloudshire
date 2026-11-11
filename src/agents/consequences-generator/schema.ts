import { z } from 'zod';

export const consequencesSchema = z.object({
  items: z
    .array(
      z.object({
        description: z.string().trim().min(1),
        impact: z.enum(['MINOR', 'SIGNIFICANT']),
        drift: z.enum(['SLOW', 'STEADY', 'FAST']),
      }),
    )
    .min(1),
});

export type ConsequencesRaw = z.infer<typeof consequencesSchema>;
