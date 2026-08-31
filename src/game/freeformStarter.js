import { getLogger } from '../log.js';
import { toolFail } from '../agents/toolResult.js';
import { clipPlotText, PLOT_TITLE_MAX, PLOT_SUMMARY_MAX } from './plotlines.js';
import { normalizeHiddenPremises } from './suspenseGraph.js';
import {
  freeformConfig,
  cityStateForPrompt,
  parseFreeformGravity,
  formatFreeformGravityForPrompt,
  normalizeCloseWhenList,
  openStoryTitlesLine,
} from './freeform.js';
import { pickFreeformVariant, judgeFreeformCard, formatFreeformCardJudgeRepair } from './freeformJudge.js';
import { architectFreeformBlanks, packRejectedBlanks, architectShortText } from './freeformArchitect.js';

export function normalizeSeedVariant(raw, cfg) {
  const title = clipPlotText(raw?.title, PLOT_TITLE_MAX);
  const synopsis = clipPlotText(raw?.synopsis, PLOT_SUMMARY_MAX);
  const entry = clipPlotText(raw?.entry, cfg.chronicleMaxChars);
  const closeWhen = normalizeCloseWhenList(raw?.closeWhen);
  const hiddenPremises = normalizeHiddenPremises(raw?.hiddenPremises, 1);
  const whyMoves = clipPlotText(raw?.whyMoves || raw?.motion, PLOT_SUMMARY_MAX);
  if (!title || !synopsis || closeWhen.length < 1) return null;
  return {
    title,
    synopsis,
    entry: entry || '',
    closeWhen,
    whyMoves,
    hiddenPremises,
  };
}

export function seedCardFromBlank(blank, cfg) {
  if (!blank) return null;
  const synopsis = blank.synopsis || blank.hook || blank.text || blank.premise || '';
  return normalizeSeedVariant(
    {
      title: blank.title || clipPlotText(synopsis, PLOT_TITLE_MAX) || 'История',
      synopsis,
      entry: '',
      closeWhen: blank.closeWhen?.length ? blank.closeWhen : ['Ситуация исчерпала себя', 'Принять произошедшее как новый порядок'],
      whyMoves: blank.whyMoves || blank.dynamics || '',
      hiddenPremises: blank.hiddenPremises,
    },
    cfg,
  );
}

async function constructSeed({ runtime, domain, world, seedText, blank, repair = '', gravity, cfg, config, log }) {
  const draft = { card: null };
  await runtime.run({
    agentId: 'freeformStart',
    tools: [
      {
        name: 'submit_freeform_seed',
        description: 'Одна карточка: поля архитектора, посаженные в город.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['title', 'synopsis', 'closeWhen', 'whyMoves'],
          properties: {
            title: { type: 'string' },
            synopsis: { type: 'string' },
            entry: {
              type: 'string',
              description: 'Опциональная вторая запись этого месяца. Не пересказ затравки.',
            },
            closeWhen: {
              type: 'array',
              items: { type: 'string' },
              description: '2–4 разных исхода. Хотя бы один закрывает историю на масштабе последствий.',
            },
            whyMoves: {
              type: 'string',
              description:
                'Одно предложение: почему история сама развивается, если ей никто не занимается. Реальный процесс, не «напряжение растёт».',
            },
            hiddenPremises: {
              type: 'array',
              items: { type: 'string' },
              description:
                'Пустой массив, если в полях архитектора нет загадки. Не выдумывай скрытые мотивы и закулисные факты. Максимум один пункт.',
            },
          },
        },
        handler: async (args) => {
          const card = normalizeSeedVariant(args, cfg);
          if (!card) {
            return toolFail('thin', 'Нужны title, synopsis, closeWhen и whyMoves.');
          }
          if (!card.whyMoves) {
            return toolFail('thin', 'Нужен whyMoves: почему история движется, если ей не занимаются.');
          }
          draft.card = card;
          return { ok: true };
        },
      },
    ],
    maxTurns: 3,
    toolChoice: { type: 'function', function: { name: 'submit_freeform_seed' } },
    log,
    scene: 'freeform_start',
    domainId: domain?.id,
    extraSystem: cityStateForPrompt(domain, world),
    userMessages: [
      {
        role: 'user',
        content: [
          'Затравка уже в хронике:',
          seedText,
          '',
          'Победившие поля архитектора (сохрани ход и давление; город даёт где и кто):',
          architectShortText(blank) || JSON.stringify(blank, null, 2),
          blank.arena ? `arena: ${blank.arena}` : '',
          blank.worldRelation ? `worldRelation: ${blank.worldRelation}` : '',
          gravity != null ? `\n${formatFreeformGravityForPrompt(gravity, config)}` : '',
          repair ? `\nЗамечание судьи (минимальная поправка, не новая история):\n${repair}` : '',
          '',
          'Посади ЭТОТ сюжет в город через submit_freeform_seed.',
          'synopsis — затравка и конфликт в этом городе; он может остаться в масштабе затравки.',
          'whyMoves — из динамики: путь к посадке. Не «напряжение растёт».',
          'Хотя бы один closeWhen — исход на масштабе последствий. Не ужимай посадку до двора затравки.',
          'Gravity относится к последствиям. Синопсис не обязан уже показывать разрыв.',
          'hiddenPremises — [] если в полях нет загадки. Не додумывай закулисье. Если тайна уже есть — один пункт, не в хронике.',
          'Если по А судят о Б — сохрани почему; не выкидывай шарнир.',
          'Людей и товар с другого острова сейчас не бывает: посади на жителей этого острова.',
          'Urgency не ставь. entry — только если город ответил в этом же месяце; иначе пусто.',
        ]
          .filter(Boolean)
          .join('\n'),
      },
    ],
  });
  return draft.card;
}

export async function startFreeformStory({ config, runtime, domain, world, seedText, gravity, log: parentLog }) {
  const log = (parentLog || getLogger()).child({ scope: 'freeform.start', domainId: domain?.id });
  const g = parseFreeformGravity(gravity);
  const gravityLine = formatFreeformGravityForPrompt(g, config);
  const { cfg, variants, prompt: architectPrompt = '' } = await architectFreeformBlanks({
    runtime,
    seedText,
    kind: 'seed',
    config,
    gravity: g,
    log,
  });
  if (!variants.length) {
    return { ok: false, error: 'architect_empty', variants: [], rejected: [], architectPrompt };
  }

  const city = cityStateForPrompt(domain, world);
  const verdict = await pickFreeformVariant({
    runtime,
    domainId: domain?.id,
    kind: 'seed',
    variants,
    extraSystem: city,
    caseText: [
      'Затравка игрока (уже в хронике):',
      seedText,
      openStoryTitlesLine(domain),
      'Город и космология — чтобы отсечь прямое противоречие фактам и нерушимым правилам.',
      'Главное — интерес: какой сюжет хочется увидеть дальше. То, насколько он «ложится» на ремёсла и должности города, не довод за него.',
      'Отсей выдуманный чужой остров и людей, которые сейчас прибыли с него: прибыть нельзя.',
      'Если по А судят о Б, а почему — не сказано, это дыра, не острота.',
      gravityLine,
    ]
      .filter(Boolean)
      .join('\n'),
    log,
  });

  const blank = variants[verdict.index];
  const builtCfg = cfg || freeformConfig(config);
  let winner = null;
  try {
    winner = await constructSeed({
      runtime,
      domain,
      world,
      seedText,
      blank,
      repair: verdict.repair || '',
      gravity: g,
      cfg: builtCfg,
      config,
      log,
    });
  } catch (err) {
    log.warn('freeform.construct_seed_failed', { error: err.message });
  }
  winner = winner || seedCardFromBlank(blank, builtCfg);
  if (!winner) {
    return { ok: false, error: 'constructor_empty', variants, rejected: [], architectPrompt };
  }

  let cardJudge = null;
  let cardRepaired = false;
  try {
    const judged = await judgeFreeformCard({
      runtime,
      domainId: domain?.id,
      extraSystem: city,
      seedText,
      blank,
      card: winner,
      gravity: g,
      config,
      log,
    });
    cardJudge = judged.judge;
    if (!judged.accepted) {
      const repair = formatFreeformCardJudgeRepair(judged.judge);
      if (repair) {
        try {
          const patched = await constructSeed({
            runtime,
            domain,
            world,
            seedText,
            blank,
            repair,
            gravity: g,
            cfg: builtCfg,
            config,
            log,
          });
          if (patched) {
            winner = patched;
            cardRepaired = true;
          }
        } catch (err) {
          log.warn('freeform.construct_seed_repair_failed', { error: err.message });
        }
      }
    }
  } catch (err) {
    log.warn('freeform.card_judge_failed', { error: err.message });
  }
  winner.arena = blank.arena || '';
  winner.worldRelation = blank.worldRelation || '';
  winner.gravity = g;
  winner.hook = blank.hook || '';
  winner.conflict = blank.conflict || '';
  winner.dynamics = blank.dynamics || '';
  winner.consequences = blank.consequences || '';

  const rejected = packRejectedBlanks(variants, verdict.index);

  return {
    ok: true,
    winner,
    rejected,
    judge: {
      why: verdict.why,
      repair: verdict.repair,
      issues: verdict.issues,
      card: cardJudge
        ? {
            verdict: cardJudge.verdict,
            summary: cardJudge.summary,
            issues: cardJudge.issues,
            repaired: cardRepaired,
          }
        : null,
    },
    variants,
    architectPrompt,
  };
}
