import { z } from 'zod';
import { OFFICES } from '../../core/rules.js';

export const assignOfficerSchema = z.object({
  office: z.enum(OFFICES),
  task: z.string().trim().min(1).describe('Что поручено, одной-двумя фразами, как приказ сановнику.'),
});

export const orderChangeSchema = z.object({
  office: z.enum(OFFICES),
  intent: z.string().trim().min(1).describe('Что должно появиться, измениться или исчезнуть в городе.'),
});

export const withdrawSchema = z.object({ office: z.enum(OFFICES) });

export const noteSchema = z.object({ text: z.string().trim().min(1).max(300) });

export const replySchema = z.object({ text: z.string().trim().min(1).max(4000) });

export type AssignOfficerArgs = z.infer<typeof assignOfficerSchema>;
export type OrderChangeArgs = z.infer<typeof orderChangeSchema>;
export type WithdrawArgs = z.infer<typeof withdrawSchema>;
export type NoteArgs = z.infer<typeof noteSchema>;
