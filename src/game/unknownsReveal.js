/**
 * Каждый тик: по хронике месяца решить, закрылась ли каноническая неизвестность брифа.
 * Скрытый канон нити сюда не даём — только то, что город уже установил.
 */

import { getLogger, truncate } from '../log.js';
import { toolFail } from '../agents/toolResult.js';
import {
  parseCityBrief,
  formatCanonicalUnknownsForPrompt,
  applyCanonicalUnknownReveal,
} from './cityContext.js';

export function monthClosedPlots(domain, tick) {
  const t = Number(tick);
  if (!Number.isInteger(t)) return [];
  return (domain?.closedPlotlines || []).filter((p) => Number(p?.closedTick) === t);
}

export function chronicleForUnknownsReveal(chronicleAdds = []) {
  return (chronicleAdds || []).filter(
    (f) => f && f.author !== 'storyteller:quiet' && String(f.text || '').trim(),
  );
}

export function shouldConsiderUnknownsReveal({ domain, tick, chronicleAdds } = {}) {
  const parsed = parseCityBrief(domain?.cityBrief);
  if (!parsed.unknowns.length) return false;
  if (chronicleForUnknownsReveal(chronicleAdds).length) return true;
  return monthClosedPlots(domain, tick).length > 0;
}

export async function maybeRevealCanonicalUnknowns({
  runtime,
  domain,
  world,
  chronicleAdds = [],
  log: parentLog,
} = {}) {
  if (!domain) return null;
  const tick = world?.tickIndex;
  if (!shouldConsiderUnknownsReveal({ domain, tick, chronicleAdds })) return null;
  if (!runtime) return null;

  const parsed = parseCityBrief(domain.cityBrief);
  const events = chronicleForUnknownsReveal(chronicleAdds);
  const closed = monthClosedPlots(domain, tick);
  const log = (parentLog || getLogger()).child({
    scope: 'unknowns.reveal',
    domainId: domain.id,
  });

  const draft = { skip: true, edit: null };
  await runtime.run({
    agentId: 'cityUnknownsReveal',
    tools: [
      {
        name: 'submit_unknowns_reveal',
        description:
          'skip, если месяц не утвердил ни один пункт списка. Иначе один пункт дословно и факт, который город теперь знает.',
        parameters: {
          type: 'object',
          required: ['skip'],
          properties: {
            skip: {
              type: 'boolean',
              description: 'true, если хроника и исходы нитей не устанавливают ни один пункт.',
            },
            unknown: {
              type: 'string',
              description: 'Дословный пункт из списка канонических неизвестностей.',
            },
            revealed: {
              type: 'string',
              description: 'Сухой факт, который город теперь знает. Не слух и не «неизвестно».',
            },
          },
        },
        handler: async (args) => {
          if (args.skip === true || args.skip === 'true') {
            draft.skip = true;
            draft.edit = null;
            return { ok: true };
          }
          const edited = applyCanonicalUnknownReveal(domain.cityBrief, {
            unknown: args.unknown,
            revealed: args.revealed,
          });
          if (!edited.ok) {
            const msg = {
              unknown_not_found:
                'Такого пункта в списке нет. Скопируй unknown дословно или skip=true.',
              revealed_thin: 'revealed слишком короткий: одна-две фразы установленного факта.',
              still_unknown:
                'revealed не должен оставлять неизвестность. Либо утверждение, либо skip=true.',
            }[edited.error];
            return toolFail(edited.error, msg || 'Раскрытие не принято.');
          }
          draft.skip = false;
          draft.edit = edited;
          return { ok: true, unknown: edited.unknown };
        },
      },
    ],
    maxTurns: 3,
    toolChoice: { type: 'function', function: { name: 'submit_unknowns_reveal' } },
    log,
    scene: 'city_unknowns_reveal',
    domainId: domain.id,
    extraSystem: formatCanonicalUnknownsForPrompt(parsed.unknowns),
    userMessages: [
      {
        role: 'user',
        content: [
          world?.gameDate?.label ? `Месяц: ${world.gameDate.label}.` : null,
          'Канонические неизвестности:',
          ...parsed.unknowns.map((u) => `- ${u}`),
          events.length
            ? `Хроника этого месяца (утверждения, не слухи):\n${events
                .map((f) => `- ${f.text}`)
                .join('\n')}`
            : 'Хроники этого месяца нет.',
          closed.length
            ? `Закрылись истории:\n${closed
                .map((p) => `- исход=${p.ending || '—'} синопсис=${p.synopsis || p.title || ''}`)
                .join('\n')}`
            : null,
          'Закрой пункт, только если месяц УСТАНОВИЛ ответ утверждением. Намёк, догадка, «ходили смотреть» без находки — skip.',
          'Не угадывай из старого слуха. Не раскрывай то, чего нет в хронике и исходах.',
          'Один пункт за месяц. Вызови submit_unknowns_reveal.',
        ]
          .filter(Boolean)
          .join('\n'),
      },
    ],
  });

  if (draft.skip || !draft.edit?.brief) {
    log.info('unknowns.reveal_skipped');
    return null;
  }
  domain.cityBrief = draft.edit.brief;
  log.info('unknowns.revealed', {
    unknown: truncate(draft.edit.unknown, 160),
    revealed: truncate(draft.edit.revealed, 200),
  });
  return {
    brief: draft.edit.brief,
    unknown: draft.edit.unknown,
    revealed: draft.edit.revealed,
  };
}
