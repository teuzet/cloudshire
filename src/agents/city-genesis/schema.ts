import { z } from 'zod';
import { ASPECT_MIN_CHARS, type AspectDef } from './aspects.js';

export const OPENING_LORE_MIN = 8;
export const OPENING_LORE_MAX = 20;

export const coreSchema = z.object({
  city_name: z.string().trim().min(2).max(40),
  priest_name: z.string().trim().min(1).describe('Одно имя из списка ИМЕНА, без фамилии и отчества.'),
  priest_description: z.string().trim().min(1).describe('Характер верховного жреца-связного; учти пожелания игрока.'),
  greeting: z.string().trim().min(1).max(600),
  opening_lore: z.array(z.string().trim().min(1)).min(OPENING_LORE_MIN).max(OPENING_LORE_MAX).describe(`Массив из ≥${OPENING_LORE_MIN} сухих постоянных фактов.`),
});

export type CoreRaw = z.infer<typeof coreSchema>;

export function aspectsSchema(batch: readonly AspectDef[]): z.ZodType<Record<string, string>, z.ZodTypeDef, unknown> {
  return z
    .object(
      Object.fromEntries(
        batch.map((def) => [
          def.id,
          z
            .string()
            .trim()
            .min(ASPECT_MIN_CHARS)
            .describe(`${def.title}. ${def.hint}. Минимум ${ASPECT_MIN_CHARS} символов, 2–4 абзаца. Уникально, не копируй другие разделы.`),
        ]),
      ),
    )
    .strict() as unknown as z.ZodType<Record<string, string>, z.ZodTypeDef, unknown>;
}
