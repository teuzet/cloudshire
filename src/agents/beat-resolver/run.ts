/**
 * Выбор бита на пороге фронта: одно событие или одна улика из пула.
 */

import type { ChronicleEntry, Front } from '../../core/city.js';
import type { BeatPick, BeatStart } from '../../core/world/beats.js';
import { composeSystem, loadPrompt } from '../_shared/canon.js';
import { bullets, chronicleBlock, section } from '../_shared/format.js';
import { runStructured, type AgentDeps, type StructuredAgent } from '../_shared/runtime.js';
import { beatPickSchema, type BeatPickRaw } from './schema.js';

export interface BeatResolverInput {
  front: Front;
  start: Pick<BeatStart, 'events' | 'clues'>;
  /** Недавние записи хроники этого фронта. */
  history: ChronicleEntry[];
}

const prompt = loadPrompt(import.meta.url);

export const beatResolver: StructuredAgent<BeatResolverInput, BeatPickRaw, BeatPick> = {
  name: 'beat-resolver',
  tool: 'submit_beat_pick',
  description: 'Одно событие или одна улика.',
  schema: beatPickSchema,
  system: ({ front, start, history }) =>
    composeSystem(
      ['world'],
      prompt,
      `Фронт: ${front.description}`,
      section('События', bullets(start.events.map((e) => `${e.id} [${e.status}]: ${e.description}`))),
      section('Улики', bullets(start.clues.map((c) => `${c.id}: ${c.fact}`))),
      section('Что уже было', chronicleBlock(history)),
    ),
  user: ({ front }) => front.description,
  check: (raw, { start }) => {
    const eventId = raw.event_id?.trim() || null;
    const clueId = raw.clue_id?.trim() || null;
    if (!eventId && !clueId) return 'нужен event_id или clue_id';
    if (eventId && clueId) return 'только одно: event_id или clue_id';
    if (eventId && !start.events.some((e) => e.id === eventId)) return `нет события ${eventId}`;
    if (clueId && !start.clues.some((c) => c.id === clueId)) return `нет улики ${clueId}`;
    return null;
  },
  finish: (raw) => ({ eventId: raw.event_id?.trim() || null, clueId: raw.clue_id?.trim() || null }),
};

export async function resolveBeat(deps: AgentDeps, input: BeatResolverInput): Promise<BeatPick> {
  return (await runStructured(deps, beatResolver, input)).value;
}
