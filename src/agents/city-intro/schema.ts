import { z } from 'zod';

export const VIEW_MIN = 600;
export const VIEW_MAX = 900;
export const CALL_MAX = 220;

export const introSchema = z.object({
  view: z.string().trim().min(VIEW_MIN - 100).max(VIEW_MAX + 300).describe(`Что бог видит, впервые взглянув вниз: от ${VIEW_MIN} до ${VIEW_MAX} знаков.`),
  priest_call: z
    .array(z.string().trim().min(1).max(CALL_MAX + 80))
    .min(2)
    .max(4)
    .describe('Первые сообщения жреца: от двух до четырёх коротких, проверка связи.'),
});

export type IntroRaw = z.infer<typeof introSchema>;
