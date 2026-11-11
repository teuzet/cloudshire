import { z } from 'zod';
import { OBJECT_TYPES } from '../../core/rules.js';
import { profileSchema } from '../_shared/schemas.js';

export const worldObjectsSchema = z.object({
  objects: z.array(
    z.object({
      type: z.enum(OBJECT_TYPES),
      name: z.string().trim().min(1),
      description: z.string().trim().min(1),
      weight: z.enum(['MINOR', 'SIGNIFICANT', 'MAJOR', 'DEFINING']),
      stat_profile: profileSchema,
    }),
  ),
});

export type WorldObjectsRaw = z.infer<typeof worldObjectsSchema>;
