import { z } from 'zod';
import { OBJECT_TYPES } from '../../core/rules.js';

export const RESULT_KINDS = ['new_object', 'change_object', 'remove_object', 'fact'] as const;
export type ResultKind = (typeof RESULT_KINDS)[number];

const resultSchema = z.object({
  kind: z.enum(RESULT_KINDS),
  object_id: z.string().trim().min(1).nullable().default(null),
  type: z.enum(OBJECT_TYPES).nullable().default(null),
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(560),
  parent_id: z.string().trim().min(1).nullable().default(null),
});

export const stageSchema = z.object({
  title: z.string().trim().min(1).max(80),
  work: z.string().trim().min(1).max(400),
  result: resultSchema,
  site: z.object({ name: z.string().trim().min(1).max(80), description: z.string().trim().max(400).default('') }).nullable().default(null),
  outcome_known: z.boolean(),
});

export const stagesSchema = z.object({ stages: z.array(stageSchema).min(1).max(4) });

export type StagesRaw = z.infer<typeof stagesSchema>;
