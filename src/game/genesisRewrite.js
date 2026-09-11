/**
 * После месяца с critical-хроникой или закрытием CRISIS/RUPTURE —
 * агент может поправить кусок cityBrief, не переписывая его целиком.
 */

import { getLogger } from '../log.js';
import { toolFail } from '../agents/toolResult.js';
import {
  formatCityForAgents,
  parseCityBrief,
  formatCityBrief,
  formatCityModifiersForPrompt,
  normalizeCityModifiers,
} from './cityContext.js';
import { isStakedStory, parseFreeformGravity } from './plotlines.js';

const BIG_GRAVITY = new Set(['CRISIS', 'RUPTURE']);
const FIND_MIN = 16;
const COMPACT_COUNT = 4;
const COMPACT_CHARS = 800;

function modifierLoad(domain) {
  normalizeCityModifiers(domain);
  const list = domain?.modifiers || [];
  const chars = list.reduce((n, m) => n + String(m?.text || '').length, 0);
  return { count: list.length, chars, list };
}

export function modifiersNeedCompact(domain, config = null) {
  const { count, chars } = modifierLoad(domain);
  const minCount = Number(config?.tick?.genesisRewrite?.compactAfterModifiers) || COMPACT_COUNT;
  const minChars = Number(config?.tick?.genesisRewrite?.compactAfterChars) || COMPACT_CHARS;
  return count >= minCount || chars >= minChars;
}

export function monthClosedBigStories(domain, tick) {
  const t = Number(tick);
  if (!Number.isInteger(t)) return [];
  return (domain?.closedPlotlines || []).filter((p) => {
    if (Number(p?.closedTick) !== t) return false;
    if (!isStakedStory(p)) return false;
    return BIG_GRAVITY.has(parseFreeformGravity(p.gravity, ''));
  });
}

/** Крупные нити, которые закрылись в этой пачке хроники — не «все закрытые в этом месяце». */
export function closedBigStoriesFromAdds(domain, chronicleAdds = []) {
  const ids = new Set();
  for (const fact of chronicleAdds || []) {
    if (!fact?.plotClosed) continue;
    for (const id of fact.relatedPlotlineIds || []) ids.add(String(id));
    if (fact.sourcePlotId) ids.add(String(fact.sourcePlotId));
  }
  if (!ids.size) return [];
  return (domain?.closedPlotlines || []).filter((p) => {
    if (!ids.has(String(p?.id))) return false;
    if (!isStakedStory(p)) return false;
    return BIG_GRAVITY.has(parseFreeformGravity(p.gravity, ''));
  });
}

export function endingLabel(ending) {
  if (ending == null || ending === '') return '—';
  if (typeof ending === 'string' || typeof ending === 'number') return String(ending);
  const kind = String(ending.kind || ending.endingId || '').trim();
  const text = String(ending.text || '').trim();
  if (kind && text) return `${kind}: ${text}`;
  return text || kind || '—';
}

export function monthCriticalChronicles(chronicleAdds) {
  return (chronicleAdds || []).filter((f) => String(f?.importance || '').toLowerCase() === 'critical');
}

export function shouldConsiderGenesisRewrite({ domain, tick, chronicleAdds, config } = {}) {
  void tick;
  if (modifiersNeedCompact(domain, config)) return true;
  if (monthCriticalChronicles(chronicleAdds).length) return true;
  return closedBigStoriesFromAdds(domain, chronicleAdds).length > 0;
}

function collapse(s) {
  return String(s || '').trim().replace(/\s+/g, ' ');
}

/** Подмена одного куска тела брифа. Блок канонических неизвестностей не трогаем. */
export function applyCityBriefEdit(brief, { find, replace } = {}) {
  const parsed = parseCityBrief(brief);
  const current = parsed.body;
  const needle = collapse(find);
  const nextChunk = collapse(replace);
  if (!current) return { ok: false, error: 'no_brief' };
  if (!needle) return { ok: false, error: 'no_find' };
  if (needle.length < FIND_MIN) return { ok: false, error: 'find_thin' };
  if (needle === current) return { ok: false, error: 'whole_brief' };
  const idx = current.indexOf(needle);
  if (idx < 0) return { ok: false, error: 'not_found' };
  if (current.indexOf(needle, idx + needle.length) >= 0) return { ok: false, error: 'ambiguous' };
  const nextBody = collapse(
    `${current.slice(0, idx)}${nextChunk}${current.slice(idx + needle.length)}`,
  );
  if (!nextBody) return { ok: false, error: 'empty' };
  if (nextBody === current) return { ok: false, error: 'unchanged' };
  const next = formatCityBrief({ body: nextBody, unknowns: parsed.unknowns });
  return { ok: true, brief: next };
}

export async function maybeRewriteCityGenesis({
  runtime,
  domain,
  world,
  chronicleAdds = [],
  config = null,
  log: parentLog,
} = {}) {
  if (!domain) return null;
  const tick = world?.tickIndex;
  const compacting = modifiersNeedCompact(domain, config);
  if (!shouldConsiderGenesisRewrite({ domain, tick, chronicleAdds, config })) return null;

  const log = (parentLog || getLogger()).child({ scope: 'genesis.rewrite', domainId: domain.id });
  const critical = monthCriticalChronicles(chronicleAdds);
  const closed = closedBigStoriesFromAdds(domain, chronicleAdds);
  const sinceLabel = world?.gameDate?.label || null;
  const mods = formatCityModifiersForPrompt(domain);

  if (!runtime) return null;

  const current = formatCityBrief(parseCityBrief(domain.cityBrief));
  const draft = { skip: true, edit: null };
  await runtime.run({
    agentId: 'cityGenesisRewrite',
    tools: [
      {
        name: 'submit_city_brief_rewrite',
        description: 'Правка одного куска брифа или отказ, если город как место не изменился. Весь бриф подменять нельзя.',
        parameters: {
          type: 'object',
          required: ['skip'],
          properties: {
            skip: {
              type: 'boolean',
              description: 'true, если след мелкий, временный или уже есть в брифе.',
            },
            find: {
              type: 'string',
              description: `Дословный кусок текущего брифа (не меньше ${FIND_MIN} символов, не весь бриф).`,
            },
            replace: {
              type: 'string',
              description: 'Новый текст этого куска. Остальной бриф не переписывать.',
            },
          },
        },
        handler: async (args) => {
          if (args.skip === true || args.skip === 'true') {
            draft.skip = true;
            draft.edit = null;
            return { ok: true };
          }
          const edited = applyCityBriefEdit(current, { find: args.find, replace: args.replace });
          if (!edited.ok) {
            const msg = {
              no_brief: 'Брифа нет.',
              no_find: 'Нужен find — дословный кусок текущего брифа.',
              find_thin: `find слишком короткий: скопируй узнаваемый кусок, не меньше ${FIND_MIN} знаков.`,
              whole_brief: 'Нельзя подменить весь бриф. Правится один кусок.',
              not_found: 'Такого куска в брифе нет. Скопируй find дословно.',
              ambiguous: 'Этот кусок встречается дважды — уточни find.',
              empty: 'После правки бриф не должен стать пустым.',
              unchanged: 'Правка ничего не меняет. Уточни replace или skip=true.',
            }[edited.error];
            return toolFail(edited.error, msg || 'Правка не принята.');
          }
          draft.edit = edited;
          draft.skip = false;
          return { ok: true };
        },
      },
    ],
    maxTurns: 3,
    toolChoice: { type: 'function', function: { name: 'submit_city_brief_rewrite' } },
    log,
    scene: 'city_genesis_rewrite',
    domainId: domain.id,
    extraSystem: `Город «${domain.name || ''}».\n${formatCityForAgents(domain)}`,
    userMessages: [
      {
        role: 'user',
        content: [
          sinceLabel ? `Месяц: ${sinceLabel}.` : null,
          critical.length
            ? `Critical-хроника этого месяца:\n${critical.map((f) => `- ${f.text}`).join('\n')}`
            : null,
          closed.length
            ? `Закрылись крупные истории (CRISIS/RUPTURE):\n${closed
                .map((p) => `- «${p.title}» gravity=${p.gravity} исход=${endingLabel(p.ending)}`)
                .join('\n')}`
            : null,
          mods
            ? `Дописки к городу — сверни их в бриф, если они перманентны:\n${mods}`
            : null,
          compacting ? 'Дописок накопилось достаточно: это повод свернуть их в бриф.' : null,
          'ТЕКУЩИЙ БРИФ — правится один кусок, не весь текст:',
          current || '(бриф пуст)',
          'Править, только если в город вошло перманентное значимое глобальное изменение: институты, рельеф, хозяйство, власть, постоянный уклад.',
          'find — дословная цитата из тела брифа, не из блока «Неизвестно (канон)». replace — новый текст этого куска. Остальное не трогай и не переписывай бриф с нуля.',
          'Блок канонических неизвестностей не правь и не раскрывай — это другой ход.',
          'Не пиши сюжет, не дублируй хронику месяца, не добавляй тайну. Не выдумывай сановников и статы.',
          'Если изменения нет или оно уже в брифе — skip=true.',
          'Вызови submit_city_brief_rewrite.',
        ]
          .filter(Boolean)
          .join('\n'),
      },
    ],
  });

  if (draft.skip || !draft.edit?.brief) {
    log.info('genesis.rewrite_skipped');
    return null;
  }
  const prev = domain.cityBrief;
  domain.cityBrief = draft.edit.brief;
  if (compacting || (domain.modifiers || []).length) {
    domain.modifiers = [];
  }
  log.info('genesis.rewritten', {
    prevChars: String(prev || '').length,
    nextChars: draft.edit.brief.length,
    compacted: compacting,
  });
  return { brief: draft.edit.brief, compacted: compacting };
}
