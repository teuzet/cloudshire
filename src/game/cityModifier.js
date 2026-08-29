/**
 * После закрытия тяжёлой тайны или саспенса — постоянная дописка к городу.
 * Не пересобирает бриф: агенты видят modifiers сразу после cityBrief.
 */

import { getLogger } from '../log.js';
import { toolFail } from '../agents/toolResult.js';
import { plotConfig } from './plotlines.js';
import { appendCityModifier, CITY_MODIFIER_MAX, clipCityText, formatCityForAgents } from './cityContext.js';
import { chronicleEntries } from './models.js';

function lastPlotChronicle(domain, plot) {
  const ids = new Set((plot?.chronicleIds || []).map(String));
  const rows = chronicleEntries(domain?.lore)
    .filter((e) => ids.has(String(e.id)) || (e.relatedPlotlineIds || []).includes(plot?.id))
    .sort((a, b) => (Number(a.tick) || 0) - (Number(b.tick) || 0));
  return rows.length ? rows[rows.length - 1] : null;
}

function modifierGravityMin(cfg, storyType) {
  if (storyType === 'suspense') return Number(cfg.suspenseAnnotation?.modifierGravityMin ?? 40);
  return Number(cfg.mysteryAnnotation?.modifierGravityMin ?? 40);
}

function outcomeBranch(plot) {
  if (plot?.storyType === 'suspense') {
    const prevented = plot.ending === 'ok' || plot.ending === 'crit' || plot.ending === 'prevented';
    return {
      prevented,
      branch: prevented ? plot.ifPrevented : plot.ifNotPrevented,
      label: prevented ? 'Угрозу предотвратили.' : 'Угрозу не предотвратили.',
    };
  }
  const solved = plot.ending === 'ok' || plot.ending === 'crit';
  return {
    prevented: solved,
    branch: solved ? plot.ifSolved : plot.ifUnsolved,
    label: solved ? 'Тайну разгадали целиком.' : 'Тайну не разгадали.',
  };
}

export async function maybeAppendStoryCityModifier({
  runtime,
  domain,
  world,
  plot,
  config,
  log: parentLog,
} = {}) {
  if (plot?.storyType !== 'mystery' && plot?.storyType !== 'suspense') return null;
  const cfg = plotConfig(config);
  const minG = modifierGravityMin(cfg, plot.storyType);
  if (Number(plot.gravity) <= minG) return null;

  const log = (parentLog || getLogger()).child({ scope: 'city.modifier', plotId: plot.id });
  const { branch, label } = outcomeBranch(plot);
  const last = lastPlotChronicle(domain, plot);
  const sinceLabel = world?.gameDate?.label || null;
  const sinceTick = Number.isInteger(Number(world?.tickIndex)) ? Number(world.tickIndex) : null;
  const kindLabel = plot.storyType === 'suspense' ? 'Саспенс' : 'Тайна';

  if (!runtime) {
    const fallback = clipCityText(branch, CITY_MODIFIER_MAX);
    return fallback
      ? appendCityModifier(domain, {
          text: fallback,
          sinceTick,
          sinceLabel,
          plotId: plot.id,
          gravity: plot.gravity,
        })
      : null;
  }

  const draft = { text: null, skip: false };
  await runtime.run({
    agentId: 'cityCloseModifier',
    tools: [
      {
        name: 'submit_city_modifier',
        description: 'Постоянная дописка к описанию города или отказ.',
        parameters: {
          type: 'object',
          required: ['skip'],
          properties: {
            skip: {
              type: 'boolean',
              description: 'true, если след слишком мелкий или уже содержится в брифе.',
            },
            text: {
              type: 'string',
              description: `Одна-две фразы настоящего: что в городе теперь иначе. До ${CITY_MODIFIER_MAX} символов. Без сюжета и без «если».`,
            },
          },
        },
        handler: async (args) => {
          if (args.skip === true || args.skip === 'true') {
            draft.skip = true;
            draft.text = null;
            return { ok: true };
          }
          const text = clipCityText(args.text, CITY_MODIFIER_MAX);
          if (!text) return toolFail('empty', 'Нужен text или skip=true.');
          draft.text = text;
          draft.skip = false;
          return { ok: true };
        },
      },
    ],
    maxTurns: 3,
    toolChoice: { type: 'function', function: { name: 'submit_city_modifier' } },
    log,
    scene: 'city_close_modifier',
    domainId: domain?.id,
    extraSystem: `Город «${domain?.name || ''}».\n${formatCityForAgents(domain)}`,
    userMessages: [
      {
        role: 'user',
        content: [
          `${kindLabel} «${plot.title}» закрыт (${sinceLabel || 'этот месяц'}). Исход: ${plot.ending || 'неизвестен'}. gravity=${plot.gravity}.`,
          label,
          branch ? `Заготовка исхода:\n${branch}` : 'Заготовки исхода нет — опирайся на хронику.',
          last?.text ? `Последняя запись хроники:\n${last.text}` : null,
          'Напиши постоянный факт города, который теперь верно годами, или skip=true.',
          'Не переписывай бриф. Не дублируй уже стоящие дописки. Не ставь указ и не пиши сюжет.',
          'Вызови submit_city_modifier.',
        ]
          .filter(Boolean)
          .join('\n'),
      },
    ],
  });

  if (draft.skip || !draft.text) return null;
  const mod = appendCityModifier(domain, {
    text: draft.text,
    sinceTick,
    sinceLabel,
    plotId: plot.id,
    gravity: plot.gravity,
  });
  if (mod) log.info('city.modifier_appended', { id: mod.id, gravity: plot.gravity, storyType: plot.storyType });
  return mod;
}

export async function maybeAppendMysteryCityModifier(opts = {}) {
  return maybeAppendStoryCityModifier(opts);
}
