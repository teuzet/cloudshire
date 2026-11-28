import { z } from 'zod';

export const BRIEF_MIN = 1500;
export const BRIEF_MAX = 2000;

export const cityBriefSchema = z.object({
  brief: z
    .string()
    .trim()
    .min(BRIEF_MIN - 300)
    .max(BRIEF_MAX + 800)
    .describe(`Неизменное в городе: от ${BRIEF_MIN} до ${BRIEF_MAX} знаков связного текста.`),
  unknowns: z
    .array(
      z.object({
        text: z.string().trim().min(1),
        object_ids: z.array(z.string().trim().min(1)).default([]),
      }),
    )
    .default([])
    .describe('Что в мире прямо не установлено, с привязкой к объектам. Пустой массив, если такого нет.'),
});

export type CityBriefRaw = z.infer<typeof cityBriefSchema>;
