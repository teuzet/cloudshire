import { z } from 'zod';

export const onboardingSchema = z.object({
  reply: z.string().trim().min(1),
  seed: z
    .object({
      city_name: z.string().trim().max(40).nullable().optional(),
      patron_name: z.string().trim().min(1).max(40),
      patron_gender: z.enum(['female', 'male']),
      pitch: z.string().trim().min(1),
    })
    .nullable()
    .optional(),
});

export type OnboardingRaw = z.infer<typeof onboardingSchema>;
