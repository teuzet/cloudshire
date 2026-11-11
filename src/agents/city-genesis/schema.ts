import { z } from 'zod';

const person = z.object({
  name: z.string().trim().min(1),
  gender: z.enum(['female', 'male']),
  nature: z.string().trim().min(1),
});

export const genesisSchema = z.object({
  city_name: z.string().trim().min(2).max(40),
  description: z.string().trim().min(200),
  brief: z.string().trim().min(100).max(3500),
  priest: person,
  officers: z.object({ treasurer: person, marshal: person, keeper: person, chancellor: person }),
  greeting: z.string().trim().min(1),
});

export type GenesisRaw = z.infer<typeof genesisSchema>;
