/**
 * Клерк онбординга: разговор с игроком до питча города и имён.
 * Клерк пишет реплику и держит текст питча; что показать игроку и когда запускать сборку, решает поток.
 */

import type { CitySeed, Gender } from '../../core/city.js';
import type { ClerkQuestion, ClerkSpirit, ClerkTheme } from '../../core/clerk.js';
import { composeSystem, loadPrompt } from '../_shared/canon.js';
import { section } from '../_shared/format.js';
import { runStructured, type AgentDeps, type StructuredAgent } from '../_shared/runtime.js';
import { onboardingSchema, type OnboardingRaw } from './schema.js';

export interface OnboardingTurn {
  role: 'patron' | 'guide';
  text: string;
}

export interface OnboardingInput {
  turns: OnboardingTurn[];
  /** Питч, который игрок уже видел. */
  pitch?: string | null;
  /** Настроения для набросков городов. */
  spirits?: readonly ClerkSpirit[];
  /** Вопросы на выбор. */
  questions?: readonly ClerkQuestion[];
}

export interface OnboardingReply {
  reply: string;
  /** Текущий текст питча (новый или прежний). */
  pitch: string | null;
  cityName: string | null;
  patronName: string | null;
  patronGender: Gender | null;
  /** Готовая «рыба», когда игрок согласился начать. */
  seed: CitySeed | null;
  usedQuestion: string | null;
  usedSketches: boolean;
  themesHeard: ClerkTheme[];
}

const prompt = loadPrompt(import.meta.url);

function transcript(turns: OnboardingTurn[]): string {
  return turns.map((t) => `${t.role === 'patron' ? 'Игрок' : 'Ты'}: ${t.text}`).join('\n\n') || '(игрок только пришёл)';
}

const same = (a: string, b: string): boolean => a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim();

export const onboardingGuide: StructuredAgent<OnboardingInput, OnboardingRaw, OnboardingReply> = {
  name: 'onboarding-guide',
  tool: 'submit_onboarding',
  description: 'Реплика игроку, текущий текст питча города и то, что уже известно об именах.',
  schema: onboardingSchema,
  system: () => composeSystem(['safety', 'world'], prompt),
  user: ({ turns, pitch, spirits, questions }) =>
    [
      section('НАСТРОЕНИЯ ДЛЯ НАБРОСКОВ', (spirits ?? []).map((s) => `- ${s.name}: ${s.line}`).join('\n')),
      section('ВОПРОСЫ НА ВЫБОР', (questions ?? []).map((q) => `- ${q.id}: ${q.text}`).join('\n')),
      section('ПИТЧ, КОТОРЫЙ ИГРОК УЖЕ ВИДЕЛ', pitch?.trim() || 'Питча ещё нет.'),
      `Разговор:\n${transcript(turns)}`,
    ]
      .filter(Boolean)
      .join('\n\n'),
  check: (raw, { pitch, questions }) => {
    if (raw.used_question && !(questions ?? []).some((q) => q.id === raw.used_question)) {
      return `в списке вопросов нет номера ${raw.used_question}: укажи номер из списка или оставь used_question пустым`;
    }
    if (!raw.ready) return null;
    const shown = pitch?.trim();
    if (!shown) return 'ready = true рано: игрок ещё не видел питч. Положи текст в pitch, спроси, всё ли так, и верни ready = false';
    if (raw.pitch?.trim() && !same(raw.pitch, shown)) {
      return 'ready = true рано: текст в pitch отличается от того, что видел игрок. Верни новый текст с ready = false и дождись согласия';
    }
    if (!raw.patron_name?.trim() || !raw.patron_gender) return 'ready = true рано: спроси имя покровителя и обращение к нему, верни ready = false';
    return null;
  },
  finish: (raw, { pitch }) => {
    const text = raw.pitch?.trim() || pitch?.trim() || null;
    const patronName = raw.patron_name?.trim() || null;
    const cityName = raw.city_name?.trim() || null;
    return {
      reply: raw.reply,
      pitch: text,
      cityName,
      patronName,
      patronGender: raw.patron_gender ?? null,
      seed: raw.ready && text && patronName && raw.patron_gender ? { cityName, patronName, patronGender: raw.patron_gender, pitch: text } : null,
      usedQuestion: raw.used_question?.trim() || null,
      usedSketches: raw.used_sketches === true,
      themesHeard: raw.themes_heard ?? [],
    };
  },
};

export async function guideOnboarding(deps: AgentDeps, input: OnboardingInput): Promise<OnboardingReply> {
  return (await runStructured(deps, onboardingGuide, input)).value;
}
