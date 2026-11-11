/**
 * Онбординг: разговор с игроком до готовой «рыбы» для генезиса.
 */

import type { CitySeed } from '../../core/city.js';
import { composeSystem, loadPrompt } from '../_shared/canon.js';
import { runStructured, type AgentDeps, type StructuredAgent } from '../_shared/runtime.js';
import { onboardingSchema, type OnboardingRaw } from './schema.js';

export interface OnboardingTurn {
  role: 'patron' | 'guide';
  text: string;
}

export interface OnboardingInput {
  turns: OnboardingTurn[];
}

export interface OnboardingReply {
  reply: string;
  seed: CitySeed | null;
}

const prompt = loadPrompt(import.meta.url);

function transcript(turns: OnboardingTurn[]): string {
  return turns.map((t) => `${t.role === 'patron' ? 'Игрок' : 'Ты'}: ${t.text}`).join('\n\n') || '(игрок только пришёл)';
}

export const onboardingGuide: StructuredAgent<OnboardingInput, OnboardingRaw, OnboardingReply> = {
  name: 'onboarding-guide',
  tool: 'submit_onboarding',
  description: 'Реплика игроку и, когда готово, заготовка города.',
  schema: onboardingSchema,
  system: () => composeSystem(['safety', 'world'], prompt),
  user: ({ turns }) => `Разговор:\n${transcript(turns)}`,
  finish: (raw) => ({
    reply: raw.reply,
    seed: raw.seed
      ? {
          cityName: raw.seed.city_name?.trim() || null,
          patronName: raw.seed.patron_name,
          patronGender: raw.seed.patron_gender,
          pitch: raw.seed.pitch,
        }
      : null,
  }),
};

export async function guideOnboarding(deps: AgentDeps, input: OnboardingInput): Promise<OnboardingReply> {
  return (await runStructured(deps, onboardingGuide, input)).value;
}
