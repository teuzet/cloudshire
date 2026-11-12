import { z } from 'zod';

export const FREE_SHAPES = ['tension', 'threat', 'hindrance'] as const;

export const dynamicSchema = z.object({
  shape: z.enum(FREE_SHAPES),
  target: z.enum(['deed', 'object']),
  object_id: z.string().trim().min(1).nullable().default(null),
  skeleton: z.string().trim().min(1).max(400),
  helps: z.string().trim().max(240).default(''),
});

export type DynamicRaw = z.infer<typeof dynamicSchema>;
