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

const words = (text: string): string[] => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/**
 * Насколько текст отличается от показанного игроку: число слов, которые появились или пропали.
 * Мелкая правка в момент согласия (имя бога, род слов о нём) не требует нового показа.
 */
export function pitchDrift(shown: string, next: string): number {
  const left = new Map<string, number>();
  for (const w of words(shown)) left.set(w, (left.get(w) ?? 0) + 1);
  let added = 0;
  for (const w of words(next)) {
    const n = left.get(w) ?? 0;
    if (n > 0) left.set(w, n - 1);
    else added += 1;
  }
  let removed = 0;
  for (const n of left.values()) removed += n;
  return added + removed;
}

/** Сколько изменённых слов питч терпит без нового показа: имя и род слов о боге, не правка по существу. */
const DRIFT_FREE = 12;

export const onboardingGuide: StructuredAgent<OnboardingInput, OnboardingRaw, OnboardingReply> = {
  name: 'onboarding-guide',
  tool: 'submit_onboarding',
  description: 'Реплика игроку, текущий текст питча города и то, что уже известно об именах.',
  schema: onboardingSchema,
  system: () => composeSystem(['safety', 'world'], prompt),
  user: ({ turns, pitch, spirits, questions }) =>
    [
      section('НАСТРОЕНИЯ ДЛЯ НАБРОСКОВ (второй путь: игрок просит выбрать за него)', (spirits ?? []).map((s) => `- ${s.family}: ${s.name.toLowerCase()}`).join('\n')),
      section('ВОПРОСЫ НА ВЫБОР (третий путь: игрок затрудняется описать свой город; и один вопрос после выбора наброска)', (questions ?? []).map((q) => `- ${q.id}: ${q.text}`).join('\n')),
      section('ПИТЧ, КОТОРЫЙ ИГРОК УЖЕ ВИДЕЛ', pitch?.trim() || 'Питча ещё нет.'),
      `Разговор:\n${transcript(turns)}`,
    ]
      .filter(Boolean)
      .join('\n\n'),
  check: (raw, { pitch, questions, spirits }) => {
    // Настроение — зерно для клерка, игрок видит только придуманный по нему город.
    const leaked = (spirits ?? []).find((sp) => raw.reply.toLowerCase().includes(sp.name.toLowerCase()));
    if (leaked) return `в реплике стоит название настроения «${leaked.name}»: опиши придуманный по нему город своими словами, со своим местом, занятием и странностью`;
    if (raw.used_question && !(questions ?? []).some((q) => q.id === raw.used_question)) {
      return `в списке вопросов нет номера ${raw.used_question}: укажи номер из списка или оставь used_question пустым`;
    }
    if (raw.used_sketches && raw.path === 'needs_help') {
      return 'этот игрок хочет город из своих ответов: вместо набросков задай ему один вопрос из списка ВОПРОСЫ НА ВЫБОР и верни used_sketches = false';
    }
    if (!raw.ready) return null;
    const shown = pitch?.trim();
    if (!shown) return 'ready = true рано: игрок ещё не видел питч. Положи текст в pitch, спроси, всё ли так, и верни ready = false';
    if (raw.pitch?.trim() && pitchDrift(shown, raw.pitch) > DRIFT_FREE) {
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
