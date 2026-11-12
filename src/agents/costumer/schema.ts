import { z } from 'zod';
import { OBJECT_TYPES } from '../../core/rules.js';

export const costumeSchema = z.object({
  title: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(560),
  rumor: z.string().trim().min(1).max(560),
  outburst: z.string().trim().min(1).max(560),
  new_object: z
    .object({
      type: z.enum(OBJECT_TYPES),
      name: z.string().trim().min(1).max(80),
      description: z.string().trim().min(1).max(560),
    })
    .nullable()
    .default(null),
});

export type CostumeRaw = z.infer<typeof costumeSchema>;
