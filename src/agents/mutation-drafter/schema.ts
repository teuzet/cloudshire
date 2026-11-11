import { z } from 'zod';
import { OBJECT_TYPES } from '../../core/rules.js';

export const mutationSchema = z.object({
  kind: z.enum(['create', 'modify', 'delete']),
  type: z.enum(OBJECT_TYPES).optional(),
  name: z.string().optional(),
  target: z.string().optional(),
  description: z.string().trim().min(1),
});

export type MutationRaw = z.infer<typeof mutationSchema>;
