/**
 * После месяца с critical-хроникой или закрытием CRISIS/RUPTURE —
 * агент может поправить кусок cityBrief, не переписывая его целиком.
 */

import { getLogger } from '../log.js';
import { toolFail } from '../agents/toolResult.js';
import { clipCityText, CITY_BRIEF_MAX, formatCityForAgents } from './cityContext.js';
import { isStakedStory, parseFreeformGravity } from './plotlines.js';

const BIG_GRAVITY = new Set(['CRISIS', 'RUPTURE']);
const FIND_MIN = 16;

export function monthClosedBigStories(domain, tick) {
  const t = Number(tick);
  if (!Number.isInteger(t)) return [];
  return (domain?.closedPlotlines || []).filter((p) => {
    if (Number(p?.closedTick) !== t) return false;
    if (!isStakedStory(p)) return false;
    return BIG_GRAVITY.has(parseFreeformGravity(p.gravity, ''));
  });
}

export function monthCriticalChronicles(chronicleAdds) {
  return (chronicleAdds || []).filter((f) => String(f?.importance || '').toLowerCase() === 'critical');
}

export function shouldConsiderGenesisRewrite({ domain, tick, chronicleAdds } = {}) {
  if (monthCriticalChronicles(chronicleAdds).length) return true;
  return monthClosedBigStories(domain, tick).length > 0;
}

function collapse(s) {
  return String(s || '').trim().replace(/\s+/g, ' ');
}

/** Подмена одного куска брифа. Весь текст целиком подменять нельзя. */
export function applyCityBriefEdit(brief, { find, replace } = {}) {
  const current = clipCityText(brief, CITY_BRIEF_MAX);
  const needle = collapse(find);
  const nextChunk = collapse(replace);
  if (!current) return { ok: false, error: 'no_brief' };
  if (!needle) return { ok: false, error: 'no_find' };
  if (needle.length < FIND_MIN) return { ok: false, error: 'find_thin' };
  if (needle === current) return { ok: false, error: 'whole_brief' };
  const idx = current.indexOf(needle);
  if (idx < 0) return { ok: false, error: 'not_found' };
  if (current.indexOf(needle, idx + needle.length) >= 0) return { ok: false, error: 'ambiguous' };
  const next = clipCityText(
    `${current.slice(0, idx)}${nextChunk}${current.slice(idx + needle.length)}`,
    CITY_BRIEF_MAX,
  );
  if (!next) return { ok: false, error: 'empty' };
  if (next === current) return { ok: false, error: 'unchanged' };
  return { ok: true, brief: next };
}

export async function maybeRewriteCityGenesis({
  runtime,
  domain,
  world,
  chronicleAdds = [],
  log: parentLog,
} = {}) {
  if (!domain) return null;
  const tick = world?.tickIndex;
  if (!shouldConsiderGenesisRewrite({ domain, tick, chronicleAdds })) return null;

  const log = (parentLog || getLogger()).child({ scope: 'genesis.rewrite', domainId: domain.id });
  const critical = monthCriticalChronicles(chronicleAdds);
  const closed = monthClosedBigStories(domain, tick);
  const sinceLabel = world?.gameDate?.label || null;

  if (!runtime) return null;

  const current = clipCityText(domain.cityBrief, CITY_BRIEF_MAX);
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
                .map((p) => `- «${p.title}» gravity=${p.gravity} исход=${p.ending || '—'}`)
                .join('\n')}`
            : null,
          'ТЕКУЩИЙ БРИФ — правится один кусок, не весь текст:',
          current || '(бриф пуст)',
          'Править, только если в город вошло перманентное значимое глобальное изменение: институты, рельеф, хозяйство, власть, постоянный уклад.',
          'find — дословная цитата из брифа. replace — новый текст этого куска. Остальное не трогай и не переписывай бриф с нуля.',
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
  log.info('genesis.rewritten', {
    prevChars: String(prev || '').length,
    nextChars: draft.edit.brief.length,
  });
  return { brief: draft.edit.brief };
}
