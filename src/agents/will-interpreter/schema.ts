import { z } from 'zod';
import { TEMPO_WORDS } from '../../core/rules.js';

export const WILL_LABELS = ['project', 'strategy', 'deed', 'tempo', 'cancel', 'continue'] as const;
export type WillLabel = (typeof WILL_LABELS)[number];

export const DEED_KINDS = ['push', 'helper', 'clear'] as const;
export type DeedKind = (typeof DEED_KINDS)[number];

const tempo = z.enum(TEMPO_WORDS).nullable().default(null);

export const willSchema = z.object({
  label: z.enum(WILL_LABELS),
  front_id: z.string().trim().min(1).nullable().default(null),
  project_id: z.string().trim().min(1).nullable().default(null),
  deed_kind: z.enum(DEED_KINDS).nullable().default(null),
  goal: z.string().trim().min(1).max(400),
  manner: z.string().trim().max(400).nullable().default(null),
  project_tempo: tempo,
  work_tempo: tempo,
});

export type WillRaw = z.infer<typeof willSchema>;
