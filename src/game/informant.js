/**
 * Информатор: справка о соседе во время стыковки.
 * Близнец лормастера: те же add/refine/drop, другой предмет и правило
 * «не знаешь — так и скажи».
 */

import { newId } from './ids.js';
import { createLoreFact, formatCastForPrompt } from './models.js';
import { formatFullChronicleForPrompt, formatFactsForPrompt } from './memory.js';
import { findActiveConfluxForDomain } from './conflux.js';
import { cityRules } from './cityRules.js';
import { formatCityForAgents, parseCityBrief, formatCanonicalUnknownsForPrompt } from './cityContext.js';
import { formatPairArchive } from './confluxCanon.js';
import { getLogger, truncate } from '../log.js';
import { toolFail } from '../agents/toolResult.js';

export function visibleNeighborLore(lore) {
  return (lore || []).filter((f) => {
    if (!f) return false;
    if (f.secret) return false;
    if (f.retiredAt) return false;
    if ((f.tags || []).includes('retired')) return false;
    return true;
  });
}

export function formatNeighborPlotList(plots = []) {
  const list = (plots || []).filter((p) => p && p.kind !== 'errand' && !p.isMainConflux);
  if (!list.length) return 'Открытых историй у соседа нет.';
  return [
    'Нити соседа — только список. Канон истины и скрытые посылки не даны. Не решай их.',
    ...list.map((p) => `- ${p.id} «${p.title || 'история'}»: ${p.synopsis || ''}`),
  ].join('\n');
}

function linkFactOnAsker(asker, original, { world, askerTag }) {
  const link = createLoreFact({
    id: newId('lore'),
    text: original.text,
    tags: ['fact', 'informant-link'],
    gameDateLabel: world?.gameDate?.label || original.gameDateLabel,
    tick: world?.tickIndex ?? original.tick,
    author: askerTag,
    leakedFromId: original.id,
  });
  asker.lore = asker.lore || [];
  asker.lore.push(link);
  return link;
}

function syncLinkedText(asker, original) {
  for (const fact of asker.lore || []) {
    if (String(fact.leakedFromId || '') !== String(original.id)) continue;
    fact.previousText = fact.text;
    fact.text = original.text;
    fact.updatedAt = new Date().toISOString();
  }
}

/**
 * Спросить информатора о соседе. Факт пишется у города-предмета, у спросившего — ссылка.
 */
export async function askInformant({
  config,
  runtime,
  storage,
  domain,
  questions,
  asker = 'agent',
  conflux: confluxArg = null,
  maxTurns = 8,
} = {}) {
  const log = getLogger().child({ scope: 'informant', domainId: domain.id, asker });
  const world = storage ? await storage.getWorld() : null;
  const conflux = confluxArg || (storage ? await findActiveConfluxForDomain(storage, domain.id) : null);
  if (!conflux || conflux.status !== 'docked') {
    return {
      ok: false,
      error: 'no_informant',
      answers: [],
      addedFacts: [],
      loreTextForAsker: 'Информатора нет: острова не состыкованы. О внутренней жизни соседа сведений нет.',
    };
  }
  const otherId = (conflux.domainIds || []).find((id) => id !== domain.id);
  let partner = otherId && storage ? await storage.getDomain(otherId) : null;
  if (!partner) {
    return {
      ok: false,
      error: 'no_partner',
      answers: [],
      addedFacts: [],
      loreTextForAsker: 'Соседа сейчас не видно.',
    };
  }

  const askerTag = `informant:${asker}`;
  const addedFacts = [];
  const addedLinks = [];
  let answers = null;
  const visible = visibleNeighborLore(partner.lore);
  const canonicalUnknowns = parseCityBrief(partner.cityBrief).unknowns;
  const unknownsPrompt = formatCanonicalUnknownsForPrompt(canonicalUnknowns);

  const persistPartner = async () => {
    if (!storage?.updateDomain) {
      if (storage?.saveDomain) await storage.saveDomain(partner);
      return;
    }
    const written = await storage.updateDomain(partner.id, (fresh) => {
      fresh.lore = Array.isArray(fresh.lore) ? fresh.lore : [];
      const have = new Map(fresh.lore.map((f) => [String(f.id), f]));
      for (const fact of partner.lore || []) {
        const id = String(fact.id);
        if (!have.has(id)) {
          fresh.lore.push(fact);
          have.set(id, fact);
        } else {
          Object.assign(have.get(id), fact);
        }
      }
    });
    if (written) {
      partner.lore = written.lore;
      partner.rev = written.rev;
    }
  };

  const tools = [
    {
      name: 'read_neighbor',
      description: 'Прочитать то, что об этом соседе уже известно: описание, публичные факты, летопись, люди, порядки, нити списком.',
      parameters: { type: 'object', properties: {} },
      handler: async () => ({
        ok: true,
        cosmology: config?.world?.cosmology,
        gameDate: world?.gameDate,
        neighborName: partner.name,
        neighborId: partner.id,
        ruler: partner.characters?.[0]?.name,
        description: formatCityForAgents(partner),
        chronicle: formatFullChronicleForPrompt({ ...partner, lore: visible }),
        facts: formatFactsForPrompt(visible, { limit: 60 }),
        knownPeople: formatCastForPrompt(visible, { limit: 30 }),
        standingRules: cityRules(partner).map((m) => m.text),
        currentEvents: (partner.state?.events || []).map((e) => (typeof e === 'string' ? e : e?.text)),
        neighborPlots: formatNeighborPlotList(partner.plotlines),
        pairArchive: formatPairArchive(conflux, [domain, partner]),
        canonicalUnknowns: unknownsPrompt,
        reminder:
          'Это ЧУЖОЙ город. Не знаешь — так и скажи в submit_answers. Пробелы не заполняй. ' +
          'Тайные факты, скрытые посылки и канон истины нитей тебе не даны — не выдумывай их. ' +
          'Нити — только список, чтобы можно было назначить дело. ' +
          'Новый факт пиши через add_fact: он ляжет у соседа, спросившему уйдёт ссылка. ' +
          (unknownsPrompt ? ' canonicalUnknowns соседа не раскрывай.' : ''),
      }),
    },
    {
      name: 'add_fact',
      description: 'Зафиксировать факт О СОСЕДЕ. Запись живёт у соседа; спросивший получает ссылку.',
      parameters: {
        type: 'object',
        required: ['text'],
        properties: {
          text: {
            type: 'string',
            description: 'Сухой факт о соседнем городе. Незнание в факт не пишется.',
          },
        },
      },
      handler: async ({ text }) => {
        const body = String(text || '').trim();
        if (/не установлен|сведений нет|неизвестн|возможно,|предположительно/i.test(body)) {
          return toolFail(
            'not_a_fact',
            'Это незнание, а не факт. Если не знаешь — скажи это в submit_answers, без add_fact.',
          );
        }
        const fact = createLoreFact({
          id: newId('lore'),
          text: body,
          tags: ['fact'],
          gameDateLabel: world?.gameDate?.label,
          tick: world?.tickIndex,
          author: askerTag,
        });
        partner.lore = partner.lore || [];
        partner.lore.push(fact);
        const link = linkFactOnAsker(domain, fact, { world, askerTag });
        addedFacts.push(fact);
        addedLinks.push(link);
        await persistPartner();
        log.info('informant.add_fact', { factId: fact.id, text: truncate(body, 300) });
        return { ok: true, factId: fact.id, linkedFactId: link.id };
      },
    },
    {
      name: 'update_fact',
      description: 'Переписать устаревший факт соседа. factId — id из facts соседа.',
      parameters: {
        type: 'object',
        required: ['factId', 'text'],
        properties: {
          factId: { type: 'string' },
          text: { type: 'string' },
          reason: { type: 'string' },
        },
      },
      handler: async ({ factId, text, reason }) => {
        const body = String(text || '').trim();
        const fact = (partner.lore || []).find((f) => f.id === factId);
        if (!fact) return toolFail('fact_not_found', 'Факт с таким id у соседа не найден.');
        if (body.length < 3) return toolFail('too_short', 'Новая формулировка слишком короткая.');
        fact.previousText = fact.text;
        fact.text = body;
        fact.updatedTick = world?.tickIndex;
        fact.updatedAt = new Date().toISOString();
        if (reason) fact.updateReason = String(reason).slice(0, 300);
        syncLinkedText(domain, fact);
        await persistPartner();
        return { ok: true, factId };
      },
    },
    {
      name: 'retire_fact',
      description: 'Снять факт соседа, который больше не верен.',
      parameters: {
        type: 'object',
        required: ['factId'],
        properties: {
          factId: { type: 'string' },
          reason: { type: 'string' },
        },
      },
      handler: async ({ factId, reason }) => {
        const fact = (partner.lore || []).find((f) => f.id === factId);
        if (!fact) return toolFail('fact_not_found', 'Факт с таким id у соседа не найден.');
        fact.retiredAt = new Date().toISOString();
        fact.retiredTick = world?.tickIndex;
        if (reason) fact.retireReason = String(reason).slice(0, 300);
        if (!Array.isArray(fact.tags)) fact.tags = [];
        if (!fact.tags.includes('retired')) fact.tags.push('retired');
        syncLinkedText(domain, fact);
        await persistPartner();
        return { ok: true, factId };
      },
    },
    {
      name: 'submit_answers',
      description: 'Итоговые ответы. Если не знаешь — так и напиши, не выдумывай.',
      parameters: {
        type: 'object',
        required: ['answers'],
        properties: {
          answers: {
            type: 'array',
            items: {
              type: 'object',
              required: ['question', 'answer'],
              properties: {
                question: { type: 'string' },
                answer: { type: 'string' },
                invented: { type: 'boolean' },
              },
            },
          },
        },
      },
      handler: async (args) => {
        answers = args.answers;
        return { ok: true };
      },
    },
  ];

  const qText = (questions || []).map((q, i) => `${i + 1}. ${q}`).join('\n');
  log.info('informant.ask', { questions: questions || [], partnerId: partner.id });

  if (runtime?.run) {
    await runtime.run({
      agentId: 'informant',
      userMessages: [
        {
          role: 'user',
          content: [
            `Спрашивает: ${asker}`,
            `Свой город: ${domain.name}. Предмет вопроса — сосед «${partner.name}».`,
            '',
            'Вопросы:',
            qText || '(нет вопросов)',
            '',
            'Порядок: read_neighbor → при нужде add_fact / update_fact / retire_fact → submit_answers.',
            'Не знаешь — так и скажи. Пробелы не заполняй. Тайны нитей соседа не раскрывай.',
          ].join('\n'),
        },
      ],
      tools,
      maxTurns,
      toolChoice: { type: 'function', function: { name: 'read_neighbor' } },
      log,
      scene: 'informant',
      domainId: domain.id,
    });
  }

  if (storage?.saveDomain) await storage.saveDomain(domain);
  if (storage?.saveConflux && conflux) await storage.saveConflux(conflux);

  log.info('informant.done', {
    answerCount: (answers || []).length,
    newFacts: addedFacts.length,
    answers: truncate(answers, 800),
  });

  return {
    ok: true,
    answers: answers || [],
    addedFacts,
    addedLinks,
    partnerId: partner.id,
    loreTextForAsker: (answers || [])
      .map((a) => `Q: ${a.question}\nA: ${a.answer}${a.invented ? ' (уточнено)' : ''}`)
      .join('\n\n'),
  };
}