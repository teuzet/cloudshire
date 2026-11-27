import { z } from 'zod';
import { ARCS } from '../../core/city.js';
import { OBJECT_TYPES } from '../../core/rules.js';
import { profileSchema } from '../_shared/schemas.js';

export const objectListSchema = z.object({
  objects: z.array(
    z.object({
      name: z.string().trim().min(1),
      type: z.enum(OBJECT_TYPES),
      links: z.array(z.string().trim().min(1)).default([]).describe('Имена связанных объектов из этого же списка.'),
      parent: z.string().trim().default('').describe('Имя объекта, внутри которого этот находится; пустая строка, если такого нет.'),
      hidden: z.boolean().default(false).describe('true — горожане об этом не знают.'),
      arc: z.enum(['none', ...ARCS]).default('none').describe('Большая нерешённая вещь: mystery, danger, promise; у остальных none.'),
    }),
  ),
});

export type ObjectListRaw = z.infer<typeof objectListSchema>;

export const objectDetailsSchema = z.object({
  objects: z.array(
    z.object({
      name: z.string().trim().min(1),
      description: z.string().trim().min(1),
      weight: z.enum(['MINOR', 'SIGNIFICANT', 'MAJOR', 'DEFINING']),
      stat_profile: profileSchema,
    }),
  ),
});

export type ObjectDetailsRaw = z.infer<typeof objectDetailsSchema>;
