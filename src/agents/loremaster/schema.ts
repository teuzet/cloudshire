import { z } from 'zod';

export const readLoreSchema = z.object({});

export const addFactSchema = z.object({
  text: z
    .string()
    .trim()
    .min(1)
    .describe(
      'Сухой факт: 1–2 короткие фразы, без эпитетов и пафоса. Пример: «Местный продукт — виноград; сладкий, тонкая кожица.» ' +
        'Только утверждение о том, ЧТО ЕСТЬ. Незнание — не факт: «не установлено», «сведений нет», «смерть или исчезновение», ' +
        '«возможно» в факт не пишутся. Не переписывай формулировку вопроса: спросили «смерть или исчезновение» — ' +
        'запиши то, что знаешь («Неван мёртв, тело нашли у соляного поля»), или не пиши ничего.',
    ),
});

export const updateFactSchema = z.object({
  fact_id: z.string().trim().min(1).describe('Id факта из facts.'),
  text: z.string().trim().min(1).describe('Новая формулировка: сухо, 1–2 фразы.'),
  reason: z.string().trim().optional().describe('Чем прежний факт противоречит хронике или состоянию.'),
});

export const retireFactSchema = z.object({
  fact_id: z.string().trim().min(1).describe('Id факта из facts.'),
  reason: z.string().trim().optional(),
});

export const answersSchema = z.object({
  answers: z
    .array(
      z.object({
        question: z.string().trim().min(1),
        answer: z.string().trim().min(1),
        invented: z.boolean().optional().describe('true, если деталь дописана поверх хроники или пробела.'),
      }),
    )
    .min(1),
});

export type AddFactArgs = z.infer<typeof addFactSchema>;
export type UpdateFactArgs = z.infer<typeof updateFactSchema>;
export type RetireFactArgs = z.infer<typeof retireFactSchema>;
export type Answers = z.infer<typeof answersSchema>['answers'];
