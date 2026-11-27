import { z } from 'zod';
import { CLERK_THEMES } from '../../core/clerk.js';

export const PITCH_MAX = 2500;

export const onboardingSchema = z.object({
  path: z
    .enum(['opening', 'knows', 'hands_over', 'needs_help'])
    .describe(
      'Каким путём идёт разговор. opening — игрок только пришёл и ещё ничего не сказал о городе. knows — игрок описал свой город, подробно или в общих чертах. hands_over — игрок прямо отдал выбор тебе или случаю и своих пожеланий к городу не высказал. needs_help — игрок хочет город по своему вкусу и затрудняется его описать.',
    ),
  reply: z.string().trim().min(1).describe('Реплика игроку. Текст питча в неё не входит: его показывает система.'),
  pitch: z.string().trim().max(PITCH_MAX).nullable().optional().describe('Полный текущий текст питча. Пусто, пока питча нет.'),
  city_name: z.string().trim().max(40).nullable().optional().describe('Имя города, которое назвал игрок. Пусто, если игрок оставил выбор миру или ещё не ответил.'),
  patron_name: z.string().trim().max(40).nullable().optional().describe('Имя покровителя, которое назвал игрок. Пусто, пока игрок его не назвал.'),
  patron_gender: z.enum(['female', 'male']).nullable().optional().describe('female — покровительница, male — покровитель. Пусто, пока неизвестно.'),
  ready: z.boolean().describe('true, когда игрок видел нынешний питч, назвал покровителя и прямо согласился начать.'),
  used_question: z.string().trim().nullable().optional().describe('Номер вопроса из списка ВОПРОСЫ НА ВЫБОР, который задан игроку именно в этой реплике. Во всех остальных репликах пусто.'),
  used_sketches: z.boolean().optional().describe('true, когда именно в этой реплике игроку показаны новые наброски городов. Во всех остальных репликах false.'),
  themes_heard: z.array(z.enum(CLERK_THEMES)).optional().describe('Темы, о которых в разговоре уже шла речь.'),
});

export type OnboardingRaw = z.infer<typeof onboardingSchema>;
