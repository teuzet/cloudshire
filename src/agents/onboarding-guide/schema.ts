import { z } from 'zod';
import { CLERK_THEMES } from '../../core/clerk.js';

export const PITCH_MAX = 2500;

export const onboardingSchema = z.object({
  /** Реплика игроку. Текста питча в ней нет: его показывает система. */
  reply: z.string().trim().min(1),
  /** Полный текущий текст питча; пусто, пока питча нет. */
  pitch: z.string().trim().max(PITCH_MAX).nullable().optional(),
  city_name: z.string().trim().max(40).nullable().optional(),
  patron_name: z.string().trim().max(40).nullable().optional(),
  patron_gender: z.enum(['female', 'male']).nullable().optional(),
  /** Игрок видел нынешний питч, назвал покровителя и прямо согласился начать. */
  ready: z.boolean(),
  /** Номер вопроса из выданного списка, если клерк его сейчас задал. */
  used_question: z.string().trim().nullable().optional(),
  /** В этой реплике клерк показал наброски городов по выданным настроениям. */
  used_sketches: z.boolean().optional(),
  /** Темы, о которых в разговоре уже шла речь. */
  themes_heard: z.array(z.enum(CLERK_THEMES)).optional(),
});

export type OnboardingRaw = z.infer<typeof onboardingSchema>;
