/**
 * Информатор: ответы на вопросы о другом городе, пока края островов вместе.
 */

import { newId } from './ids.js';
import { createLoreFact, formatCastForPrompt, chronicleEntries } from './models.js';
import { findActiveConfluxForDomain } from './conflux.js';
import { cityRules } from './cityRules.js';
import { parseCityBrief, normalizeCanonicalUnknowns } from './cityContext.js';
import { isStoryPlot } from './plotlines.js';
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
  const list = (plots || []).filter((p) => p && isStoryPlot(p));
  if (!list.length) return 'Открытых бед и дел у того города нет.';
  return [
    'Текущие беды и дела того города — коротко, без скрытых подробностей:',
    ...list.map((p) => `- ${p.id} «${p.title || 'история'}»: ${p.synopsis || ''}`),
  ].join('\n');
}

function formatUnknownsForInformant(unknowns = []) {
  const items = normalizeCanonicalUnknowns(unknowns);
  if (!items.length) return '';
  return [
    'В этом городе есть установленные пробелы — их не раскрывай и не выдумывай причину:',
    ...items.map((u) => `- ${u}`),
  ].join('\n');
}

function formatCityForInformant(domain) {
  const raw = String(domain?.cityBrief || '').trim();
  const body = raw
    ? String(parseCityBrief(raw).body || '').trim()
    : String(domain?.description || '').trim();
  const mods = (domain?.modifiers || [])
    .map((m) => String(m?.text || '').trim())
    .filter(Boolean)
    .map((text) => `- ${text}`);
  const parts = [body || '(описание пусто)'];
  if (mods.length) parts.push('Постоянный порядок:', ...mods);
  return parts.join('\n');
}

function formatChronicleForInformant(lore) {
  const chron = chronicleEntries(lore);
  if (!chron.length) return '(записей о прошлом нет)';
  return chron
    .map((e) => `- ${e.gameDateLabel || 'без даты'}: ${String(e.text || '').trim()}`)
    .join('\n');
}

function formatFactsForInformant(lore) {
  const facts = (lore || []).filter((f) => {
    const tags = f?.tags || [];
    if (!tags.includes('fact')) return false;
    if (tags.includes('chronicle')) return false;
    return true;
  });
  if (!facts.length) return '(коротких фактов пока нет — смотри описание и записи о прошлом)';
  return facts
    .map((f) => `- ${f.id} (${f.gameDateLabel || 'без даты'}): ${String(f.text || '').trim()}`)
    .join('\n');
}

function formatTogetherForInformant(conflux, domains) {
  const raw = (formatPairArchive(conflux, domains) || '').replace(
    / \[архив: не новость\]/g,
    ', уже отошло',
  );
  return raw || '(ещё ничего не случилось, пока острова вместе)';
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
  const unknownsPrompt = formatUnknownsForInformant(parseCityBrief(partner.cityBrief).unknowns);

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
      description: 'Открывает сведения о другом городе — том, о котором тебя спрашивают. Только чтение.',
      parameters: { type: 'object', properties: {} },
      handler: async () => ({
        ok: true,
        gameDate: world?.gameDate?.label || null,
        cityName: partner.name,
        ruler: partner.characters?.[0]?.name,
        description: formatCityForInformant(partner),
        past: formatChronicleForInformant(visible),
        facts: formatFactsForInformant(visible),
        knownPeople: formatCastForPrompt(visible, { limit: 30 }),
        standingRules: cityRules(partner).map((m) => m.text),
        currentEvents: (partner.state?.events || []).map((e) => (typeof e === 'string' ? e : e?.text)),
        currentTroubles: formatNeighborPlotList(partner.plotlines),
        whileTogether: formatTogetherForInformant(conflux, [domain, partner]),
        unknowns: unknownsPrompt || undefined,
        reminder:
          'Это сведения о другом городе, не о том, кто спрашивает. ' +
          'Если чего-то нет — так и скажи в submit_answers, не заполняй пробелы. ' +
          'Людей называй только из этих сведений. ' +
          'Список бед — чтобы указать одну по id, если спросят. Разгадок там нет. ' +
          'add_fact — только то, что здесь уже сказано прямо. ' +
          (unknownsPrompt ? 'То, что помечено неизвестным, не раскрывай.' : ''),
      }),
    },
    {
      name: 'add_fact',
      description: 'Записывает сухой факт о том городе, о котором спрашивают. Только то, что уже есть в сведениях.',
      parameters: {
        type: 'object',
        required: ['text'],
        properties: {
          text: {
            type: 'string',
            description: 'Сухой факт о том городе. Незнание в факт не пишется.',
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
        return { ok: true, factId: fact.id };
      },
    },
    {
      name: 'update_fact',
      description: 'Переписать устаревший факт о том городе. factId — из списка фактов.',
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
        if (!fact) return toolFail('fact_not_found', 'Факт с таким id у того города не найден.');
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
      description: 'Снять факт о том городе, который больше не верен.',
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
        if (!fact) return toolFail('fact_not_found', 'Факт с таким id у того города не найден.');
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
            `Город «${domain.name}» спрашивает о городе «${partner.name}».`,
            'Края островов сейчас вместе, между ними есть проход.',
            '',
            'Вопросы:',
            qText || '(нет вопросов)',
            '',
            'Сначала read_neighbor. Если не знаешь — так и скажи. Пробелы не заполняй. Тайны того города не выдумывай.',
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
      .map((a) => `Q: ${a.question}\nA: ${a.answer}`)
      .join('\n\n'),
  };
}