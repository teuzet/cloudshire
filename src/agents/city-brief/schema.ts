import { z } from 'zod';

export const BRIEF_MAX = 3500;

export const cityBriefSchema = z.object({
  brief: z
    .string()
    .trim()
    .min(80)
    .max(BRIEF_MAX + 500)
    .describe(`Сухие постоянные факты города, до ${BRIEF_MAX} символов: места, институты, ресурсы, уклады, напряжения. Без сиюминутного, без сюжета и без пересказа неизвестностей.`),
  unknowns: z
    .array(
      z.object({
        text: z.string().trim().min(1),
        object_ids: z.array(z.string().trim().min(1)).default([]),
      }),
    )
    .default([])
    .describe('Узкие канонические неизвестности из описания (что в мире официально не установлено). Не слухи, не календарь, не бытовые дыры. Пустой массив, если таких нет.'),
});

export type CityBriefRaw = z.infer<typeof cityBriefSchema>;
