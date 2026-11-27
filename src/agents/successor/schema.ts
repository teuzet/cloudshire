import { z } from 'zod';

export const successorSchema = z.object({
  name: z.string().trim().min(1).describe('Одно имя из списка ИМЕНА.'),
  nature: z.string().trim().min(1).max(500).describe('Какой это человек и как ведёт дела: два предложения.'),
  arrival: z.string().trim().min(1).max(300).describe('Одно предложение для хроники: как он занял место.'),
});

export type SuccessorRaw = z.infer<typeof successorSchema>;
