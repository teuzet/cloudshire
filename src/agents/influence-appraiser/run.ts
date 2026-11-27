import type { LinkEffect } from '../../core/rules.js';
import { block, briefList, join, type ObjectBrief } from '../_shared/blocks.js';
import { canon, composeSystem, loadPrompt } from '../_shared/canon.js';
import { runStructured, type AgentDeps, type StructuredAgent } from '../_shared/runtime.js';
import { influenceSchema, PEOPLE_WORDS, SELF_WORDS, type InfluenceRaw, type InfluenceWord } from './schema.js';

const prompt = loadPrompt(import.meta.url);

export interface InfluenceInput {
  /** Что делают. */
  work: string;
  /** Каким результат будет, когда работа закончена: название, вид и описание. */
  result: string;
  /** Что идёт рядом с работой. */
  nearby: Array<{
    id: string;
    /** Род словами: «угроза со сроком», «дело», «удобный случай». */
    kind: string;
    description: string;
    /** true — это ведут люди города (дело, поиск); false — надвигается само (беда, перемена). */
    people: boolean;
    /** На чём это держится, если известно. */
    carrier: string | null;
    /** Что против этого на деле помогает или что двигает это дело. */
    helps: string[];
    /** Как запись держит сейчас сам изменяемый предмет, если держит. */
    now?: string | null;
  }>;
  /** Те, кто рядом и имеет свою волю. */
  sides: ObjectBrief[];
  /** Шаги замысла, которые будут после этой работы. */
  later?: string[];
  /** Что из-за результата случится само: код делает это без чьих-либо усилий. Нужно, чтобы судить о сторонах. */
  follows?: string[];
}

export interface Influence {
  links: Array<{ frontId: string; effect: LinkEffect; word: boolean }>;
  /** Кому из сторон готовый результат вредит и кому помогает. */
  sides: Array<{ objectId: string; stance: 'harms' | 'helps' }>;
  reason: string;
}

const EFFECT: Record<InfluenceWord, LinkEffect> = {
  removes_cause: 'removes',
  stops: 'stop',
  slows: 'slow',
  hurries: 'hurry',
  helps_work: 'hurry',
  hinders_work: 'slow',
  safer: 'safer',
  riskier: 'riskier',
  changes_outcome: 'outcome',
};

function nearbyLine(n: InfluenceInput['nearby'][number]): string {
  return [`- ${n.id} (${n.kind}, ${n.people ? 'ведут люди' : 'надвигается само'}): ${n.description}`, n.carrier ? `Держится на: ${n.carrier}.` : '', n.helps.length ? `Что тут на деле помогает: ${n.helps.join('; ')}.` : '', n.now ? `Сейчас так: ${n.now}.` : '']
    .filter(Boolean)
    .join(' ');
}

export const influenceAppraiser: StructuredAgent<InfluenceInput, InfluenceRaw, Influence> = {
  name: 'influence-appraiser',
  tool: 'submit_influence',
  description: 'Как готовый результат работы влияет на то, что идёт рядом, и на тех, кто рядом.',
  schema: influenceSchema,
  system: () => composeSystem([], prompt, canon('setting')),
  user: ({ work, result, nearby, sides, later, follows }) =>
    join(
      `Работа: «${work}»`,
      `Результат: ${result}`,
      later?.length ? `Впереди ещё шаги: ${later.map((t) => `«${t}»`).join('; ')}.` : null,
      follows?.length ? `Само случится: ${follows.join('; ')}.` : null,
      block('Что идёт рядом', nearby.length ? nearby.map(nearbyLine).join('\n') : 'ничего'),
      block('Кто рядом', sides.length ? briefList(sides) : 'никого'),
    ),
  check: (raw, input) => {
    const fronts = new Set(input.nearby.map((n) => n.id));
    const alien = raw.effects.find((e) => !fronts.has(e.id));
    if (alien) return `id «${alien.id}» нет в списке «Что идёт рядом»; бери id только оттуда`;
    // Слово должно подходить к записи: то, что надвигается само, и работа людей описываются разными словами.
    for (const e of raw.effects) {
      const people = input.nearby.find((n) => n.id === e.id)?.people;
      if (people && SELF_WORDS.includes(e.effect)) return `${e.id} ведут люди: вместо ${e.effect} бери helps_work, если результат их работе помогает, или hinders_work, если мешает`;
      if (people === false && PEOPLE_WORDS.includes(e.effect)) return `${e.id} надвигается само: для него годятся removes_cause, stops, slows, hurries, changes_outcome`;
    }
    const sides = new Set(input.sides.map((s) => s.id));
    const stranger = raw.sides.find((s) => !sides.has(s.id));
    return stranger ? `id «${stranger.id}» нет в списке «Кто рядом»; бери id только оттуда` : null;
  },
  finish: (raw) => {
    const seen = new Set<string>();
    const links: Influence['links'] = [];
    for (const e of raw.effects) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      links.push({ frontId: e.id, effect: EFFECT[e.effect], word: e.basis === 'word' && e.effect !== 'removes_cause' });
    }
    const who = new Set<string>();
    const sides: Influence['sides'] = [];
    for (const s of raw.sides) {
      if (who.has(s.id)) continue;
      who.add(s.id);
      sides.push({ objectId: s.id, stance: s.stance === 'loses' ? 'harms' : 'helps' });
    }
    return { links, sides, reason: raw.reason };
  },
};

export async function appraiseInfluence(deps: AgentDeps, input: InfluenceInput): Promise<Influence> {
  return (await runStructured(deps, influenceAppraiser, input)).value;
}
