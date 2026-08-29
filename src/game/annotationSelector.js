/**
 * Селектор: 10 карточек + бриф города → одобренные id.
 */

import { getLogger } from '../log.js';
import { formatCityForAgents } from './cityContext.js';
import { annotationKindOf, formatAnnotationCardForPrompt } from './annotationPool.js';

export async function selectAnnotations({
  runtime,
  domain,
  world,
  cards = [],
  kind = 'mystery',
  log: parentLog,
} = {}) {
  const known = (cards || []).filter((c) => c?.id);
  if (!known.length) return [];
  if (!runtime) return known.map((c) => c.id);

  const k = annotationKindOf(kind);
  const mystery = k === 'mystery';
  const agentId = mystery ? 'mysteryAnnotationSelector' : 'suspenseAnnotationSelector';
  const log = (parentLog || getLogger()).child({
    scope: 'annotation.selector',
    kind: k,
    domainId: domain?.id,
  });
  const draft = { ids: null };
  const idSet = new Set(known.map((c) => c.id));

  await runtime.run({
    agentId,
    tools: [
      {
        name: 'submit_annotation_shortlist',
        description: mystery
          ? 'Какие карточки из десятки подходят этому городу.'
          : 'Какие suspense-карточки из десятки подходят этому городу.',
        parameters: {
          type: 'object',
          required: ['approvedIds'],
          properties: {
            approvedIds: {
              type: 'array',
              items: { type: 'string' },
              description: 'id карточек, которые можно посеять в этом городе. Пустой массив — ни одна не подходит.',
            },
          },
        },
        handler: async (args) => {
          const ids = (args.approvedIds || []).map(String).filter((id) => idSet.has(id));
          draft.ids = ids;
          return { ok: true };
        },
      },
    ],
    maxTurns: 3,
    toolChoice: { type: 'function', function: { name: 'submit_annotation_shortlist' } },
    log,
    scene: mystery ? 'mystery_annotation_select' : 'suspense_annotation_select',
    domainId: domain?.id,
    extraSystem: `Город «${domain?.name || ''}».\n${formatCityForAgents(domain)}`,
    userMessages: [
      {
        role: 'user',
        content: [
          mystery
            ? `Выбери из десятки карточки, которые естественно лягут на этот город (${world?.gameDate?.label || 'этот месяц'}).`
            : `Выбери из десятки suspense-карточки, которые естественно лягут на этот город (${world?.gameDate?.label || 'этот месяц'}).`,
          mystery
            ? 'Одобряй те, чья наблюдаемая странность и истина могут вырасти из якорей, институтов, ремесла или напряжения города.'
            : 'Одобряй те, чья уже идущая ситуация и будущая угроза могут вырасти из якорей, институтов, ремесла или напряжения города.',
          'Не одобряй то, что требует чужой географии, другого уклада или ломает канон острова.',
          'Можно одобрить несколько или ни одной. Не выдумывай id.',
          '',
          ...known.map((card, i) => formatAnnotationCardForPrompt(card, i)),
          '',
          'Вызови submit_annotation_shortlist.',
        ].join('\n'),
      },
    ],
  });

  if (!Array.isArray(draft.ids)) {
    log.info('annotation.selector_fallback', { n: known.length, kind: k });
    return known.map((c) => c.id);
  }
  return draft.ids;
}

export async function selectMysteryAnnotations(opts = {}) {
  return selectAnnotations({ ...opts, kind: 'mystery' });
}

export async function selectSuspenseAnnotations(opts = {}) {
  return selectAnnotations({ ...opts, kind: 'suspense' });
}
