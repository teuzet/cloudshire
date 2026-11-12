import { z } from 'zod';
import { RELATIONS } from '../../core/rules.js';

export const footprintSchema = z.object({
  relations: z
    .array(
      z.object({
        object_id: z.string().trim().min(1),
        relation: z.enum(RELATIONS),
        reason: z.string().trim().max(240).default(''),
      }),
    )
    .max(6)
    .default([]),
});

export type FootprintRaw = z.infer<typeof footprintSchema>;
