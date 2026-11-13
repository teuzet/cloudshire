import { z } from 'zod';
import { OBJECT_TYPES } from '../../core/rules.js';

export const RESOLUTION_EFFECTS = ['none', 'fact', 'link', 'keep', 'trace', 'gone'] as const;
export type ResolutionEffect = (typeof RESOLUTION_EFFECTS)[number];

export const resolutionSchema = z.object({
  text: z.string().trim().min(1).max(900),
  effect: z.enum(RESOLUTION_EFFECTS).default('none'),
  fact: z.string().trim().max(400).nullable().default(null),
  object_ids: z.array(z.string().trim().min(1)).max(2).default([]),
  lost_forever: z.array(z.string().trim().min(1)).max(6).default([]),
  trace: z
    .object({
      type: z.enum(OBJECT_TYPES),
      name: z.string().trim().min(1).max(80),
      description: z.string().trim().min(1).max(560),
    })
    .nullable()
    .default(null),
});

export type ResolutionRaw = z.infer<typeof resolutionSchema>;
