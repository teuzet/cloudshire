import { z } from 'zod';

export const PORTRAIT_MIN = 2500;
export const PORTRAIT_MAX = 6000;

export const portraitSchema = z.object({
  city_name: z.string().trim().min(2).max(40),
  priest_name: z.string().trim().min(1).describe('Одно имя из списка ИМЕНА, без фамилии и отчества.'),
  priest_nature: z.string().trim().min(1).max(600).describe('Какой человек верховный жрец и как правит: два-три предложения.'),
  portrait: z
    .string()
    .trim()
    .min(PORTRAIT_MIN)
    .max(PORTRAIT_MAX + 1000)
    .describe(`Портрет города: свободная проза, от ${PORTRAIT_MIN} до ${PORTRAIT_MAX} знаков.`),
  hidden: z.string().trim().min(1).max(2500).describe('Чего горожане не знают: правда за загадками и природа опасностей.'),
});

export type PortraitRaw = z.infer<typeof portraitSchema>;
