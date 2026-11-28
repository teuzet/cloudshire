import { z } from 'zod';
import { OFFICES, STEWARD_MODES, STEWARD_WAITS } from '../../core/rules.js';

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

export const unqueueSchema = z.object({
  number: z.number().int().min(1).describe('Номер поручения из списка «Поручения на потом» в блоке хода.'),
});

export const queueOrderSchema = z.object({
  office: z
    .enum(OFFICES)
    .nullable()
    .describe('Кому поручено, когда освободится. null — первому, кто освободится.'),
  task: z.string().trim().min(1).max(400).describe('Что поручено, одной-двумя фразами, как приказ сановнику.'),
  condition: z
    .string()
    .trim()
    .max(300)
    .optional()
    .describe('Условие словами покровителя, если поручение ждёт события: «если бунтовщики пойдут на склады». Тогда в task только само поручение, без условия. Без условия поле пустое.'),
  watch: z
    .array(z.string().trim().min(1))
    .max(4)
    .optional()
    .describe('Id того, что идёт в городе (из блока хода) и о чём условие. Пусто, если условие ни о чём из идущего.'),
});

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

export const standingOrderSchema = z.object({
  mode: z
    .enum(STEWARD_MODES)
    .describe('act — ставить свободного сановника на новую беду в тот же день и сообщать; wait — сперва ждать слова покровителя срок из поля wait, хоть день, потом ставить самой; report — только сообщать и ждать слова.'),
  wait: z.enum(STEWARD_WAITS).describe('Сколько ждать слова покровителя при wait: days — считанные дни, weeks — недели, season — сезон.'),
  spare: z.array(z.enum(OFFICES)).describe('Сановники, которых покровитель велел самой не трогать. Пустой список — можно любого.'),
  text: z.string().trim().min(1).max(300).describe('Наказ словами покровителя.'),
});

export const replySchema = z.object({ text: z.string().trim().min(1).max(4000) });

export type AssignOfficerArgs = z.infer<typeof assignOfficerSchema>;
export type OrderChangeArgs = z.infer<typeof orderChangeSchema>;
export type WithdrawArgs = z.infer<typeof withdrawSchema>;
export type NoteArgs = z.infer<typeof noteSchema>;
export type QueueOrderArgs = z.infer<typeof queueOrderSchema>;
export type UnqueueArgs = z.infer<typeof unqueueSchema>;
export type ConsultArgs = z.infer<typeof consultSchema>;
export type StandingOrderArgs = z.infer<typeof standingOrderSchema>;
export type ExistenceCheckArgs = z.infer<typeof existenceCheckSchema>;
