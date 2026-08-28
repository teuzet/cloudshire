/**
 * После закрытия саспенса без сиквела — устойчивый след в каноне города.
 * Не трогает тайну. Gravity < порога — не зовём.
 */

import { newId } from './ids.js';
import { createLoreFact } from './models.js';
import { addCityEntity } from './cityEntities.js';
import { getLogger, truncate } from '../log.js';
import { toolFail } from '../agents/toolResult.js';

function clip(s, max) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  return t.length > max ? t.slice(0, max).trim() : t;
}

function asList(raw, maxItems, maxLen) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const item of list) {
    const text = clip(typeof item === 'string' ? item : item?.text || item?.name || '', maxLen);
    if (text.length < 8) continue;
    out.push(text);
    if (out.length >= maxItems) break;
  }
  return out;
}

export async function resolveSuspenseLegacy({
  runtime,
  domain,
  world,
  closed,
  config = null,
  log: parentLog,
}) {
  const minG = Math.max(0, Number(config?.tick?.plot?.suspense?.legacyMinGravity ?? 25));
  const gravity = Math.round(Number(closed?.gravity) || 0);
  if (!closed || gravity < minG) return null;

  const log = (parentLog || getLogger()).child({
    scope: 'legacy.resolver',
    plotId: closed.id,
    domainId: domain.id,
  });
  const draft = { data: null };

  try {
    await runtime.run({
      agentId: 'legacyResolver',
      tools: [
        {
          name: 'submit_legacy',
          description: 'Устойчивое изменение города после закрытой истории. Не новая история.',
          parameters: {
            type: 'object',
            required: ['newFacts'],
            properties: {
              newFacts: {
                type: 'array',
                items: { type: 'string' },
                description: '1–4 сухих факта о том, что теперь иначе в городе.',
              },
              retiredFacts: {
                type: 'array',
                items: { type: 'string' },
                description: 'Id или точные формулировки фактов, которые больше неверны. Можно пусто.',
              },
              newEntities: {
                type: 'array',
                items: {
                  type: 'object',
                  required: ['kind', 'name', 'about'],
                  properties: {
                    kind: {
                      type: 'string',
                      enum: [
                        'place',
                        'institution',
                        'resource',
                        'craft',
                        'infrastructure',
                        'custom',
                        'tension',
                        'cult',
                        'artifact',
                        'substance',
                        'secret_place',
                      ],
                    },
                    name: { type: 'string' },
                    about: { type: 'string' },
                  },
                },
              },
              longTermRisks: { type: 'array', items: { type: 'string' } },
              longTermOpportunities: { type: 'array', items: { type: 'string' } },
            },
          },
          handler: async (args) => {
            const facts = asList(args.newFacts, 4, 280);
            if (!facts.length) return toolFail('empty', 'Нужен хотя бы один устойчивый факт.');
            draft.data = { ...args, newFacts: facts };
            return { ok: true };
          },
        },
      ],
      maxTurns: 2,
      toolChoice: { type: 'function', function: { name: 'submit_legacy' } },
      log,
      scene: 'plot_legacy',
      domainId: domain.id,
      extraSystem: `Город «${domain.name}».`,
      userMessages: [
        {
          role: 'user',
          content: [
            `История «${closed.title}» закрылась (${world?.gameDate?.label || ''}).`,
            `gravity ${gravity}. Чем выше — тем крупнее и долговечнее след.`,
            closed.synopsis ? `Как шла: ${closed.synopsis}` : null,
            closed.lastEntry ? `Чем кончилась: ${closed.lastEntry}` : null,
            closed.closeReason ? `Исход: ${closed.closeReason}` : null,
            closed.hook ? `Хук, который НЕ стал сиквелом (можно превратить в факт мира, не в новую нить): ${closed.hook}` : null,
            gravity >= 75
              ? 'Судьбоносный масштаб: ответь, что теперь навсегда иначе в этом городе.'
              : gravity >= 50
                ? 'Значимый след в устройстве города обязателен.'
                : 'Локальное устойчивое изменение. Не переписывай весь остров.',
            'Не придумывай следующую историю. Не отменяй исход. Только то, что уже стало частью города.',
            'Вызови submit_legacy.',
          ]
            .filter(Boolean)
            .join('\n'),
        },
      ],
    });
  } catch (err) {
    log.warn('legacy.failed', { error: err.message, title: closed.title });
    return null;
  }

  const data = draft.data;
  if (!data) {
    log.info('legacy.skipped', { reason: 'no_draft', title: closed.title });
    return null;
  }

  const added = [];
  for (const text of data.newFacts || []) {
    const fact = createLoreFact({
      id: newId('lore'),
      text,
      tags: ['fact', 'legacy'],
      gameDateLabel: world?.gameDate?.label,
      tick: world?.tickIndex,
      author: 'legacyResolver',
      relatedPlotlineIds: closed.id ? [closed.id] : null,
    });
    domain.lore = domain.lore || [];
    domain.lore.push(fact);
    added.push(fact);
  }

  const entities = [];
  for (const raw of data.newEntities || []) {
    const one = addCityEntity(domain, raw);
    if (one) entities.push(one);
  }

  log.info('legacy.applied', {
    plotId: closed.id,
    title: closed.title,
    gravity,
    facts: added.length,
    entities: entities.map((e) => e.name),
    preview: truncate(data.newFacts?.[0] || '', 160),
  });
  return { facts: added, entities };
}
