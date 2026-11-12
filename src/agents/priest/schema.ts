import { z } from 'zod';
import { OFFICES } from '../../core/rules.js';

export const assignOfficerSchema = z.object({
  office: z.enum(OFFICES),
  task: z.string().trim().min(1).describe('Что поручено, одной-двумя фразами, как приказ сановнику. Одна работа на вызов: отмена идущего дела — отдельный вызов order_change.'),
});

export const orderChangeSchema = z.object({
  office: z.enum(OFFICES),
  intent: z.string().trim().min(1).describe('Что должно появиться, измениться или исчезнуть в городе. Отменить идущее дело — тоже сюда, отдельным вызовом: «отменить дело …» с названием дела.'),
});

export const withdrawSchema = z.object({ office: z.enum(OFFICES) });

export const noteSchema = z.object({ text: z.string().trim().min(1).max(300) });

export const consultSchema = z.object({
  question: z.string().trim().min(1).describe('Один вопрос о факте мира: что есть, что было, кто, где, как устроено.'),
  story_id: z
    .string()
    .trim()
    .optional()
    .describe('Id идущей истории из блока хода, если вопрос про неё. Закрытую не передавай.'),
});

export const existenceCheckSchema = z.object({
  thing: z.string().trim().min(1).max(160).describe('Тот предмет из слов покровителя, которого нет в блоке хода: место, люди, вещь, обычай.'),
  context: z.string().trim().min(1).max(400).describe('Слова покровителя, в которых он прозвучал.'),
});

export const replySchema = z.object({ text: z.string().trim().min(1).max(4000) });

export type AssignOfficerArgs = z.infer<typeof assignOfficerSchema>;
export type OrderChangeArgs = z.infer<typeof orderChangeSchema>;
export type WithdrawArgs = z.infer<typeof withdrawSchema>;
export type NoteArgs = z.infer<typeof noteSchema>;
export type ConsultArgs = z.infer<typeof consultSchema>;
export type ExistenceCheckArgs = z.infer<typeof existenceCheckSchema>;
