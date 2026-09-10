/**
 * Проход сопряжения: машинное состояние и абзац для агентов.
 * state ставится делами, не прозой. Абзац — тон, не механика.
 */

import { getLogger } from '../log.js';

export const PASSAGE_STATES = ['open', 'watched', 'contested', 'shut'];

const STATE_LABEL = {
  open: 'открыт',
  watched: 'под стражей',
  contested: 'оспорен',
  shut: 'временно закрыт',
};

const UNLOCKABLE = new Set(['causeway', 'landmass']);

export function normalizePassageState(raw, fallback = 'open') {
  const key = String(raw || '').trim().toLowerCase();
  return PASSAGE_STATES.includes(key) ? key : fallback;
}

export function passageCanShut(contact) {
  const kind = contact?.kind || contact?.contact?.kind;
  if (UNLOCKABLE.has(kind)) return false;
  return true;
}

export function clampPassageState(state, contact) {
  const next = normalizePassageState(state);
  if (next === 'shut' && !passageCanShut(contact)) return 'watched';
  return next;
}

export function ensurePassage(conflux) {
  if (!conflux) return null;
  if (!conflux.passage || typeof conflux.passage !== 'object') {
    conflux.passage = {
      text: String(conflux.contact?.description || '').trim(),
      state: 'open',
      contact: conflux.contact || null,
      relief: conflux.contact?.relief || null,
      heldByProcessId: null,
    };
  }
  conflux.passage.state = clampPassageState(conflux.passage.state, conflux.contact || conflux.passage.contact);
  if (conflux.passage.heldByProcessId == null) conflux.passage.heldByProcessId = null;
  return conflux.passage;
}

export function formatPassageForPrompt(conflux) {
  ensurePassage(conflux);
  const passage = conflux?.passage;
  if (!passage) return '';
  const text = String(passage.text || '').trim();
  const state = normalizePassageState(passage.state);
  const bits = [
    text ? `Проход сейчас: ${text}` : '',
    `Состояние прохода: ${STATE_LABEL[state] || state}.`,
  ];
  return bits.filter(Boolean).join('\n');
}

/**
 * Переписать абзац о проходе. Не сюжет и не хроника — место.
 * Промпт не предлагает закрыть проход.
 */
export async function rewritePassageText({ runtime, conflux, reason = '', log: parentLog } = {}) {
  const passage = ensurePassage(conflux);
  if (!passage || !runtime) return passage;
  const log = (parentLog || getLogger()).child({ scope: 'passage.scribe' });
  const draft = { text: passage.text || '' };
  try {
    await runtime.run({
      agentId: 'passageScribe',
      scene: 'passage_scribe',
      log,
      maxTurns: 2,
      toolChoice: { type: 'function', function: { name: 'submit_passage' } },
      tools: [
        {
          name: 'submit_passage',
          description: 'Один абзац: как выглядит проход между островами сейчас.',
          parameters: {
            type: 'object',
            additionalProperties: false,
            required: ['text'],
            properties: { text: { type: 'string' } },
          },
          handler: async (args) => {
            draft.text = String(args?.text || '').trim();
            return { ok: true };
          },
        },
      ],
      extraSystem:
        'Ты описываешь проход между двумя летающими островами как место. ' +
        'Не пиши сюжет, хронику и поручения. Не советуй ничего запирать.',
      userMessages: [
        {
          role: 'user',
          content: [
            passage.text ? `Было: ${passage.text}` : 'Описания ещё нет.',
            `Состояние: ${STATE_LABEL[passage.state] || passage.state}.`,
            reason ? `Что случилось: ${reason}` : '',
            'Верни submit_passage — один абзац.',
          ]
            .filter(Boolean)
            .join('\n'),
        },
      ],
    });
  } catch (err) {
    log.warn?.('passage.scribe_failed', { error: err.message });
  }
  if (draft.text) passage.text = draft.text.slice(0, 800);
  return passage;
}

export async function setPassageState({ runtime, conflux, state, reason = '', heldByProcessId = null, log } = {}) {
  const passage = ensurePassage(conflux);
  if (!passage) return null;
  const next = clampPassageState(state, conflux.contact || passage.contact);
  const prev = passage.state;
  passage.state = next;
  if (next === 'shut') passage.heldByProcessId = heldByProcessId || passage.heldByProcessId;
  else if (heldByProcessId && passage.heldByProcessId === heldByProcessId) passage.heldByProcessId = null;
  if (next === 'shut' && !passage.heldByProcessId) passage.heldByProcessId = heldByProcessId;
  if (next !== prev || reason) {
    await rewritePassageText({ runtime, conflux, reason: reason || `Состояние сменилось на ${STATE_LABEL[next]}.`, log });
  }
  return passage;
}

export async function holdPassageShut({ runtime, conflux, process, log } = {}) {
  if (!conflux || !process) return null;
  return setPassageState({
    runtime,
    conflux,
    state: 'shut',
    heldByProcessId: process.id,
    reason: process.summary ? `На проходе держат пост: ${process.summary}.` : 'На проходе держат пост.',
    log,
  });
}

export async function releasePassageHold({ runtime, conflux, processId, log } = {}) {
  const passage = ensurePassage(conflux);
  if (!passage) return null;
  if (passage.heldByProcessId && processId && String(passage.heldByProcessId) !== String(processId)) {
    return passage;
  }
  if (passage.state !== 'shut' && !passage.heldByProcessId) return passage;
  passage.heldByProcessId = null;
  return setPassageState({
    runtime,
    conflux,
    state: 'contested',
    reason: 'Дело-охрана кончилось; проход снова оспорен, не заперт.',
    log,
  });
}
