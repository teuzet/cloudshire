import { z } from 'zod';

export const auditSchema = z.object({
  details: z
    .array(
      z.object({
        detail: z.string().trim().min(1).describe('Деталь питча коротко, словами игрока.'),
        place: z.string().trim().min(1).describe('Имя объекта ровно как в списке, brief или missing.'),
      }),
    )
    .min(1),
});

export type AuditRaw = z.infer<typeof auditSchema>;
