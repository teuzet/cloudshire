import { z } from 'zod';
import { OFFICES } from '../../core/rules.js';

export const officerNaturesSchema = z.object({
  officers: z
    .array(
      z.object({
        office: z.enum(OFFICES),
        name: z.string().trim().min(1),
        gender: z.enum(['female', 'male']),
        nature: z.string().trim().min(20).max(400),
      }),
    )
    .length(OFFICES.length),
});

export type OfficerNaturesRaw = z.infer<typeof officerNaturesSchema>;
