import { z } from 'zod';
import { profileSchema } from '../_shared/schemas.js';

export const objectVersionSchema = z.object({
  description: z.string().trim().min(1),
  weight: z.enum(['MINOR', 'SIGNIFICANT', 'MAJOR', 'DEFINING']),
  stat_profile: profileSchema,
});

export type ObjectVersionRaw = z.infer<typeof objectVersionSchema>;
