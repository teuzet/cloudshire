/**
 * Справляется ли способ работы ведущего с помехами на деле. Судья сверяет способ
 * с тем, как с помехой можно справиться по ходу работы; обойдённая помеха этому делу
 * больше не мешает. Числа удара считает ядро (core/world/hindrance.ts).
 */
import type { City, Front } from '../core/city.js';
import { frontGist } from '../core/world/fronts.js';
import { EFFECT_WORDS, effectOf, hindrancesOf, setAnswered } from '../core/world/hindrance.js';
import { judgeAlignment } from '../agents/alignment-judge/run.js';
import { tryAgent, type FlowDeps } from './context.js';

export interface HindranceAnswer {
  answered: string[];
  biting: string[];
}

/** Пересудить помехи дела под нынешний способ работы. Без способа помехи бьют. */
export async function answerHindrances(deps: FlowDeps, city: City, front: Front, manner: string | null, day: number): Promise<HindranceAnswer> {
  const out: HindranceAnswer = { answered: [], biting: [] };
  for (const obj of hindrancesOf(city, front.id)) {
    const counters = obj.attach?.counters ?? [];
    let answered = false;
    if (manner?.trim() && counters.length) {
      const ruling = await tryAgent(
        deps,
        'alignment-judge',
        () =>
          judgeAlignment(deps.agents, {
            situation: `Работе «${frontGist(front)}» мешает: ${obj.name} — ${obj.description} Из-за этого ${EFFECT_WORDS[effectOf(obj)]}.`,
            moves: counters,
            proposal: manner,
          }),
        { verdict: 'off' as const, matchedMove: null },
      );
      answered = ruling.verdict !== 'off';
    }
    setAnswered(deps.rules, front, obj, answered, day);
    (answered ? out.answered : out.biting).push(obj.name);
  }
  return out;
}

/** Слова для ответа жреца: что из помех нынешний способ обходит, а что нет. */
export function answerWords(a: HindranceAnswer): string {
  return [
    a.answered.length ? `Этот способ работы справляется с тем, что мешало: ${a.answered.join(', ')}.` : '',
    a.biting.length ? `Делу по-прежнему мешает: ${a.biting.join(', ')}.` : '',
  ]
    .filter(Boolean)
    .join(' ');
}
