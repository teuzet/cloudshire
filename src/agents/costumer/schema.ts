import { z } from 'zod';
import { HINDRANCE_EFFECTS, OBJECT_TYPES } from '../../core/rules.js';

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
  hindrance: z
    .object({
      effect: z.enum(HINDRANCE_EFFECTS),
      counters: z.array(z.string().trim().min(1).max(200)).min(2).max(3),
    })
    .nullable()
    .default(null),
});

export type CostumeRaw = z.infer<typeof costumeSchema>;
