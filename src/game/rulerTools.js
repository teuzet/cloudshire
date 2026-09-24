/**
 * Тулы жреца: дела, постоянный порядок, лормастер, память.
 * Состояние города собирает readDomainBrief и кладётся в блок хода, отдельного тула нет.
 * Вызываются из GameApp.runRuler; submit_reply собирается отдельно.
 *
 * Месяцев здесь нет. Дело живёт в игровых днях, а наружу отдаются полосы:
 * жрец не знает точного срока и потому не может его пообещать.
 */

import { formatCastForPrompt, chronicleEntries, formatChroniclePriestMark } from './models.js';
import {
  qualitativePopulation,
  normalizeRulerAttitudes,
} from './stats.js';
import { askLoremaster } from './loremaster.js';
import { askInformant } from './informant.js';
import {
  applyCrossIslandJudged,
  remainingWindowBand,
  isConflictOfInterestDeed,
} from './deedConflux.js';
import { newId } from './ids.js';
import {
  overlayConfluxView,
  stripConfluxView,
  stampNewBoardItems,
  sharePlotWithDomain,
  plotConcerns,
  plotHostId,
  findPlotByChronicleId,
} from './confluxBoard.js';
import {
  DURATION_SPEC,
  DIFFICULTY_SPEC,
  normalizeDurationBand,
  normalizeDifficultyBand,
  durationBandIndex,
  difficultyBandIndex,
} from './bands.js';
import { paceLabel, normalizePaceShift } from './deedMath.js';
import {
  applyPace,
  deedRemainingBand,
  deedElapsedDays,
  normalizeDeed,
  pauseDeedClock,
  resumeDeedClock,
  startDeed,
} from './deeds.js';
import { judgeDeed } from './deedJudge.js';
import { scheduleDeedJob, cancelDeedJobs } from './worldLoop.js';
import {
  cityRules,
  isRuleDeed,
  markRuleDeed,
  parseRuleAction,
  findRule,
  proxyText,
  setProxyText,
} from './cityRules.js';
import { holdPassageShut } from './passage.js';
import {
  normalizeDomainProcesses,
  normalizeProcess,
  findDuplicateProcess,
  resolveLinkedStats,
  resolveActiveProcess,
  formatActiveProcessesForAgent,
  activeProcesses,
  canStartProcess,
  recentlyClosedProcesses,
  reviseProcess,
  processIsFresh,
  blessProcess,
  processOwnedBy,
  pauseProcess,
  resumeProcess,
  pausedProcesses,
} from './processes.js';
import {
  plotsForPriest,
  warmPlotlines,
  plotConfig,
  findPlotline,
  findVisiblePlot,
  clipPlotText,
  PLOT_TITLE_MAX,
  PLOT_SUMMARY_MAX,
  isStakedStory,
  isErrandPlot,
  isConfluxPlot,
} from './plotlines.js';
import {
  findOfficer,
  listOfficers,
  officeById,
  officeStrategy,
  formatAxesForSpeech,
  pickRandomFreeOfficer,
  bindOfficerProcess,
  releaseOfficerProcess,
  isOffPortfolio,
  officerActiveProcess,
  officerBusyAgentMessage,
  ensureOfficersFromLore,
} from './officers.js';
import {
  ensureErrandForProcess,
  linkProcessToPlotline,
  rehomeUnrelatedProcess,
  detachProcessFromPlots,
} from './plotEngine.js';
import { judgeProcessAlignment, engagementOf } from './plotAlign.js';
import { stableCityProse, formatCityModifiersForPrompt } from './cityContext.js';
import { writeRulerMemory, forgetRulerMemory, formatRulerVoiceForPrompt } from './rulerMemory.js';
import { toolFail } from '../agents/toolResult.js';

/** Полоса срока словами — единственное, что жрец знает о времени дела. */
function bandWord(band) {
  return DURATION_SPEC[normalizeDurationBand(band)].label;
}

/** На постановке: конфликт интересов → кросс-островное, цель — сосед, без id от жреца. */
function applyDockedDeedClassification(judged, { action, domain, ctx, day, targetPlot = null }) {
  if (ctx.conflux?.status !== 'docked' || !ctx.partner) return { judged, error: null };
  const partnerHostedPlot = Boolean(
    targetPlot && plotHostId(targetPlot) === String(ctx.partner.id),
  );
  if (
    !isConflictOfInterestDeed({
      judged,
      process: action,
      partnerName: ctx.partner.name,
      partnerHostedPlot,
    })
  ) {
    return { judged, error: null };
  }
  action.opposedStat = judged?.opposedStat || action.opposedStat || null;
  return applyCrossIslandJudged(judged, {
    process: action,
    actor: domain,
    target: ctx.partner,
    conflux: ctx.conflux,
    day,
    config: ctx.config,
  });
}

function difficultyWord(band) {
  return DIFFICULTY_SPEC[normalizeDifficultyBand(band)].label;
}

/**
 * Подсказка о темпе. Чисел не даём: спешка и обстоятельность — это разница
 * в риске, а не в календаре, и жрец должен говорить именно о риске.
 */
function paceHint(action, note = null) {
  const shift = normalizePaceShift(action?.paceShift);
  const why = String(note || action?.durationNote || '').trim();
  const reason = why ? ` ${why.replace(/\.*$/, '.')}` : '';
  const span = `Работы примерно на ${bandWord(action?.durationBand)}, дело ${difficultyWord(action?.difficulty)}.`;
  const tail = 'Итог придёт, когда работа кончится, — не рапортуй его сейчас.';
  if (shift < 0) {
    return (
      `${span}${reason} Покровитель торопит: в речи ПРИМИ его темп и ПРЕДУПРЕДИ, ` +
      `что спешка повышает риск тяжёлого исхода. Ещё быстрее уже нельзя. ${tail}`
    );
  }
  if (shift > 0) {
    return `${span}${reason} Велено не спешить: не спорь, риск провала ниже. ${tail}`;
  }
  return `${span}${reason} ${tail}`;
}

function syncErrandFromProcess(domain, action) {
  const plot = findPlotline(domain, action.plotlineId);
  if (!plot || !isErrandPlot(plot)) return;
  if (action.summary) plot.title = clipPlotText(action.summary, PLOT_TITLE_MAX);
  if (action.detail) plot.synopsis = clipPlotText(action.detail, PLOT_SUMMARY_MAX);
}

function unlinkProcessFromAllPlots(domain, processId) {
  const id = String(processId);
  for (const plot of domain.plotlines || []) {
    plot.relatedProcessIds = (plot.relatedProcessIds || []).filter((x) => String(x) !== id);
  }
}

/**
 * Дело заведено, но названную беду не двигает.
 *
 * Что оно перевешено на отдельное поручение, жрецу не сообщаем: это механика,
 * и от неё он начинает извиняться за собственное непонимание и сворачивать
 * только что отданный приказ. Ему нужно одно — предупредить покровителя.
 */
function unrelatedAttachHint(paceLine = '') {
  return (
    'В речи: приказ принят и пошёл в работу. ' +
    (paceLine ? `${paceLine} ` : '') +
    'Но предупреди покровителя: той беде, о которой он говорил, это дело не поможет — ' +
    'его исполнят, а беда останется где была. Скажи прямо и коротко, истории заголовком не называй. ' +
    'Если видишь, чем взяться за саму беду, предложи одно такое дело. Решает покровитель: ' +
    'велит оставить как есть — оставляй. ' +
    'Приказ ты только что отдал, поэтому сам его не сворачивай: revoke_process не вызывай. ' +
    'commitment=process.'
  );
}

function deedsTiedToPlot(actions, plot) {
  const ids = new Set((plot?.relatedProcessIds || []).map(String));
  const pid = String(plot?.id || '');
  return (actions || []).filter(
    (action) => ids.has(String(action.id)) || (pid && String(action.plotlineId || '') === pid),
  );
}

function deedPhrase(action, day) {
  const remaining = DURATION_SPEC[deedRemainingBand(action, day)].label;
  const pace = paceLabel(action.paceShift);
  const hard = DIFFICULTY_SPEC[normalizeDifficultyBand(action.difficulty)].label;
  const moved = processIsFresh(action, day) ? 'ещё не сдвинулось' : 'уже идёт';
  const hurry =
    normalizePaceShift(action.paceShift) === 0
      ? 'темп ещё можно сдвинуть один раз'
      : 'темп уже задан, второй раз не сдвинуть';
  const blessed = action.blessed ? ' Покровитель это дело благословил.' : '';
  const started =
    action.initiative === 'ruler'
      ? ' Ты завёл это сам, пока покровитель молчал.'
      : action.initiative === 'officer'
        ? ' Сановник начал это сам, пока покровитель молчал.'
        : '';
  return `«${action.summary}» (id ${action.id}): ждать ещё ${remaining}, трудность ${hard}, темп ${pace}, ${moved}, ${hurry}.${blessed}${started}`;
}

function officerDeedShownOnStory(deedId, plots) {
  const id = String(deedId || '');
  if (!id) return false;
  return (plots || []).some((plot) => (plot.deeds || []).some((action) => String(action.id) === id));
}

function uniqueDeeds(actions) {
  const seen = new Set();
  const out = [];
  for (const action of actions || []) {
    const id = String(action?.id || '');
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    out.push(action);
  }
  return out;
}

/**
 * Сборка состояния города, которую раньше отдавал тул read_domain_brief.
 * Жрецу этот тул больше не регистрируется: текст хода строится отсюда.
 */
export function readDomainBrief(domain, character, ctx = {}) {
  const config = ctx.config;
  const partner = ctx.partner || null;
  const day = Number.isFinite(Number(ctx.day))
    ? Math.max(0, Math.round(Number(ctx.day)))
    : Math.max(0, Math.round(Number(ctx.world?.dayIndex) || 0));
  if (character) normalizeRulerAttitudes(character);
  normalizeDomainProcesses(domain, config);
  const ownActive = activeProcesses(domain, config);
  const paused = pausedProcesses(domain, config);
  const partnerActive = (partner?.state?.pendingActions || []).filter(
    (action) => action && (!action.status || action.status === 'active'),
  );
  const plots = plotsForPriest(domain.plotlines, { partner }).map((plot) => {
    const host = String(plot.hostDomainId || domain.id);
    return {
      id: plot.id,
      foreign: Boolean(partner && host === String(partner.id)),
      synopsis: String(plot.synopsis || '').trim(),
      deeds: uniqueDeeds(
        deedsTiedToPlot(ownActive, plot).concat(deedsTiedToPlot(partnerActive, plot)),
      ),
      pausedHere: deedsTiedToPlot(paused, plot).length > 0,
    };
  });
  const people = formatCastForPrompt(domain.lore, { limit: 20 });
  return {
    name: domain.name,
    status: domain.status,
    day,
    dateLabel: ctx.world?.gameDate?.label || '',
    patronName: domain.state?.patronName || null,
    patronGender: domain.state?.patronGender || null,
    populationFeel: qualitativePopulation(domain.population || 0),
    knownPeople: people === '(названных людей пока нет)' ? '' : people,
    plots,
    officers: listOfficers(domain).map((officer) => {
      const def = officeById(config, officer.office);
      const duty = officerActiveProcess(domain, officer);
      const onStory = duty ? officerDeedShownOnStory(duty.id, plots) : false;
      return {
        title: officer.title,
        name: officer.name,
        gender: officer.gender,
        nature: String(officer.nature || '').trim() || formatAxesForSpeech(officer.axes, config),
        strategy: officeStrategy(officer, config),
        focus: String(def?.focus || '').trim(),
        deed: duty && !onStory ? duty : null,
        busyOnStory: Boolean(duty && onStory),
      };
    }),
    paused,
    recentlyClosed: recentlyClosedProcesses(domain, ctx.world?.tickIndex, { day }).filter(
      (action) => action.status !== 'paused',
    ),
    proxyText: proxyText(domain) || '',
    modifiers: formatCityModifiersForPrompt(domain),
  };
}

function storyParagraph(plot, day) {
  const kind = plot.foreign ? 'История соседа' : 'Своя история';
  const now = plot.synopsis || 'только началось';
  const parts = [`[${plot.id}] ${kind}. Сейчас: ${now}`];
  if (plot.deeds?.length) {
    parts.push(`По этой истории идёт ${plot.deeds.map((action) => deedPhrase(action, day)).join(' ')}`);
  } else if (plot.pausedHere) {
    parts.push('Дело по этой истории на паузе.');
  } else {
    parts.push('Поручения по этой истории нет.');
  }
  return parts.join(' ');
}

function officerParagraph(officer, day) {
  const sex =
    officer.gender === 'female' ? 'женщина' : officer.gender === 'male' ? 'мужчина' : 'пол не задан';
  const free = officer.gender === 'female' ? 'Сейчас свободна.' : 'Сейчас свободен.';
  let duty = free;
  if (officer.deed) duty = `Сейчас ведёт ${deedPhrase(officer.deed, day)}`;
  else if (officer.busyOnStory) duty = 'Сейчас занят делом, оно написано при истории.';
  return [
    `${officer.title} ${officer.name}, ${sex}.`,
    officer.nature ? `Нрав: ${officer.nature}.` : '',
    officer.strategy ? `Как действует: ${officer.strategy}` : '',
    officer.focus ? `Ведает: ${officer.focus}.` : '',
    duty,
  ]
    .filter(Boolean)
    .join(' ');
}

function pausedParagraph(action, day) {
  const where = action.plotlineId ? `, история ${action.plotlineId}` : '';
  return `«${action.summary}» (id ${action.id}${where}), осталось ${DURATION_SPEC[deedRemainingBand(action, day)].label}.`;
}

const PRIEST_CHRONICLE_LIMIT = 10;

function recentChronicleParagraph(domain) {
  const rows = chronicleEntries(domain?.lore).slice(-PRIEST_CHRONICLE_LIMIT);
  if (!rows.length) return 'НЕДАВНЯЯ ХРОНИКА: записей ещё нет.';
  const body = rows
    .map((entry) => {
      const date = entry.gameDateLabel || 'без даты';
      const text = String(entry.text || '').trim();
      return `${date}: ${text}${formatChroniclePriestMark(entry)}`;
    })
    .join('\n\n');
  return `НЕДАВНЯЯ ХРОНИКА\n${body}`;
}

/**
 * Блок хода жреца. stable — текст города, его ставят сразу после инструкций.
 * dynamic — всё, что меняется чаще.
 */
export function formatPriestTurn(domain, character, ctx = {}) {
  const brief = readDomainBrief(domain, character, ctx);
  const stable = `ГОРОД\n${stableCityProse(domain)}`;
  const patronGenderWord =
    brief.patronGender === 'female' ? 'женщина' : brief.patronGender === 'male' ? 'мужчина' : '';
  const patronLine = brief.patronName
    ? `Имя покровителя: «${brief.patronName}»${patronGenderWord ? `, пол: ${patronGenderWord}` : ''}. Обращайся только так.`
    : 'Имя покровителя ещё не названо.';
  const stories = brief.plots.length
    ? brief.plots.map((plot) => storyParagraph(plot, brief.day)).join('\n\n')
    : 'Живых историй нет.';
  const officers = brief.officers.length
    ? brief.officers.map((officer) => officerParagraph(officer, brief.day)).join('\n\n')
    : 'Сановников нет.';
  const paused = brief.paused.length
    ? `НА ПАУЗЕ\n${brief.paused.map((action) => pausedParagraph(action, brief.day)).join('\n')}`
    : '';
  const closed = brief.recentlyClosed.length
    ? `НЕДАВНО ЗАКРЫТЫЕ ДЕЛА\n${brief.recentlyClosed
        .map((action) => `«${action.summary}» — ${action.outcome}.`)
        .join('\n')}`
    : '';
  const proxy = brief.proxyText ? `ДОВЕРЕННОСТЬ\n${brief.proxyText}` : '';
  const people = brief.knownPeople ? `ИЗВЕСТНЫЕ ЛЮДИ\n${brief.knownPeople}` : '';
  const dynamic = [
    formatRulerVoiceForPrompt(domain, { writable: true }),
    brief.dateLabel ? `ДАТА СЕЙЧАС: ${brief.dateLabel}.` : '',
    patronLine,
    `Население: ${brief.populationFeel}`,
    brief.modifiers,
    `ЖИВЫЕ ИСТОРИИ\n${stories}`,
    `САНОВНИКИ\n${officers}`,
    paused,
    closed,
    proxy,
    people,
    recentChronicleParagraph(domain),
  ]
    .filter(Boolean)
    .join('\n\n');
  return { stable, dynamic, brief };
}

export function rulerReplyCommitError({
  requestKind,
  commitment,
  okTools = new Set(),
} = {}) {
  const succeeded = (...names) => names.some((n) => okTools.has(n));
  if (commitment === 'process' && !succeeded('declare_process', 'update_process')) {
    return {
      error: 'process_missing',
      message:
        'Ты заявил commitment=process, но дело не создано: declare_process/update_process не выполнен успешно. ' +
        'Либо вызови declare_process сейчас, либо смени commitment (refused — если отговариваешь, ' +
        'clarify — если сначала нужно уточнить волю, none — если дела не нужно) ' +
        'и убери из речи обещание долгого дела.',
    };
  }
  if (commitment === 'proxy' && !succeeded('set_proxy')) {
    return {
      error: 'proxy_missing',
      message:
        'commitment=proxy, но set_proxy не выполнен. Прими доверенность через tool или смени commitment. ' +
        'Постоянное правило города — это не доверенность: оно заводится declare_process с rule, commitment=process.',
    };
  }
  if (commitment === 'revoked' && !succeeded('revoke_process', 'set_proxy')) {
    return {
      error: 'revoke_missing',
      message:
        'commitment=revoked, но отмена не выполнена. Сверни дело (revoke_process), сними доверенность ' +
        '(set_proxy с clear=true) или отмените правило (declare_process с rule и ruleAction=revoke, ' +
        'тогда commitment=process), либо смени commitment.',
    };
  }
  if (commitment === 'clarify') {
    if (succeeded('declare_process', 'update_process', 'set_proxy')) {
      return {
        error: 'clarify_after_act',
        message:
          'Дело или доверенность уже заведены этим ходом. commitment=process или proxy, не clarify.',
      };
    }
    if (requestKind === 'order_impossible') {
      return {
        error: 'impossible_not_refused',
        message:
          'Такой приказ смертному не исполнить. Поставь commitment=refused, не уточняй, как его выполнить.',
      };
    }
    if (requestKind !== 'order_long') {
      return {
        error: 'clarify_not_order',
        message:
          'clarify — только когда покровитель отдал приказ, который ещё нельзя облечь в дело или порядок. ' +
          'Для беседы и вопросов — commitment=none.',
      };
    }
    return null;
  }
  if (requestKind === 'order_long' && commitment === 'none') {
    return {
      error: 'order_ignored',
      message:
        'Покровитель отдал долгий приказ, а ты ничего не предпринял. ' +
        'Либо declare_process / update_process (commitment=process), ' +
        'либо спроси, чего не хватает, чтобы исполнить (commitment=clarify), ' +
        'либо честно откажи в речи и поставь commitment=refused.',
    };
  }
  if (requestKind === 'order_impossible' && commitment !== 'refused') {
    return {
      error: 'impossible_not_refused',
      message:
        'Такой приказ смертному не исполнить. Поставь commitment=refused. ' +
        'В речи — не объяснение устройства мира, а твоё простое «не умею», «не понимаю этих слов», ' +
        '«там ветер и бездна»; предложи то, что можешь: послать людей, объявить обряд, начать дело. ' +
        'Сцену, будто это происходит, не отыгрывай.',
    };
  }
  return null;
}

/** Латиница и десятичные цифры в речи жреца. Кириллица и знаки проходят. */
export function replyHasLatinOrDigits(text) {
  return /[A-Za-z0-9]/.test(String(text || ''));
}

export function submitReplyTool(turn, character) {
  return {
    name: 'submit_reply',
    description:
      'ЕДИНСТВЕННЫЙ способ ответить покровителю. Когда воля ясна, вызывай в том же ответе модели, что и действие, последним. ' +
      'text — сама речь; requestKind — чего просил покровитель; commitment — что ты реально сделал этим ходом. ' +
      'Если приказ ещё нельзя облечь в дело или порядок — спроси и поставь commitment=clarify.',
    parameters: {
      type: 'object',
      required: ['text', 'requestKind', 'commitment'],
      properties: {
        text: {
          type: 'string',
          description: `Речь правителя, 1–3 абзаца, без префикса «${character.name}:», без механики и JSON.`,
        },
        requestKind: {
          type: 'string',
          enum: [
            'order_long',
            'order_impossible',
            'question',
            'smalltalk',
            'other',
          ],
          description:
            'order_long — велел работу: стройку, суд, поход, разовое дело, а также объявить постоянное ' +
            'правило (всё это declare_process). ' +
            '«Так и оставить / сами справятся» — commitment=none. ' +
            'order_impossible — велел то, чего в этом мире не бывает ' +
            '(отправить тебя за край или в пустоту, воскресить мёртвых, стереть память, космос, перенос); ' +
            'question — спросил: ответь на вопрос, не пиши «приказа не было»; ' +
            'smalltalk — беседа; other — прочее.',
        },
        touchedPlotIds: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Id живых нитей, которых покровитель коснулся в этом разговоре (расспрашивал, велел, тревожился). ' +
            'Пусто, если разговор был не о них.',
        },
        dayNote: {
          type: 'string',
          description:
            'Одна короткая фраза: что произошло сегодня в мире — появился человек, отдан приказ, ' +
            'кто-то отказался, куда-то сходили. Пусто, если был только разговор или уточняющий вопрос.',
        },
        commitment: {
          type: 'string',
          enum: ['none', 'process', 'proxy', 'revoked', 'refused', 'clarify'],
          description:
            'Что сделано этим ходом: process (declare_process/update_process, в том числе правило через rule), ' +
            'proxy (принял или снял доверенность), ' +
            'revoked (свернул дело или снял доверенность), refused (честно отказал или отговорил), ' +
            'clarify (приказ есть, но воля неясна — спросил, дело ещё не заводил), ' +
            'none (действий не требовалось).',
        },
      },
    },
    handler: async ({ text, requestKind, commitment, touchedPlotIds, dayNote }) => {
      const body = String(text || '').trim();
      if (!body) {
        return toolFail('empty', 'Речь пустая. Напиши ответ покровителю в text.');
      }
      if (replyHasLatinOrDigits(body)) {
        return toolFail(
          'latin_or_digits',
          'В речи только кириллица и знаки. Латиницу и цифры убери.',
        );
      }
      const commitErr = rulerReplyCommitError({
        requestKind,
        commitment,
        okTools: turn.okTools,
      });
      if (commitErr) return toolFail(commitErr.error, commitErr.message);
      turn.reply = body;
      turn.meta = {
        requestKind,
        commitment,
        touchedPlotIds: Array.isArray(touchedPlotIds) ? touchedPlotIds.map(String) : [],
        dayNote: String(dayNote || '').trim().slice(0, 160) || null,
      };
      return { ok: true };
    },
  };
}

export function buildRulerTools(domain, storage, character, ctx) {
  const save = async () => {
    if (ctx.conflux) {
      stampNewBoardItems(domain, ctx.conflux);
      stripConfluxView(domain);
      await storage.saveDomain(domain);
      if (ctx.partner) await storage.saveDomain(ctx.partner);
      await storage.saveConflux(ctx.conflux);
      overlayConfluxView(domain, ctx.conflux, ctx.partner);
      return;
    }
    await storage.saveDomain(domain);
  };
  normalizeRulerAttitudes(character);
  normalizeDomainProcesses(domain, ctx.config);

  const world = ctx.world || null;
  // Текущий игровой день: по нему считаются полосы остатка у дел и у нависшего.
  const day = Number.isFinite(Number(ctx.day))
    ? Math.max(0, Math.round(Number(ctx.day)))
    : Math.max(0, Math.round(Number(world?.dayIndex) || 0));

  return [
    {
      name: 'consult_loremaster',
      description:
        'Только если этой конкретики нет в блоке хода. Если ответ из него выводится целиком — не вызывай. ' +
        'Один фактический вопрос о том, что есть, что произошло, кто, где и как устроен этот мир. ' +
        'Не просьба выбрать действие, оценить волю покровителя или разобрать предположение. ' +
        'Справка о фактах мира: имена, места, устройство города, прошлое, уже установленный канон. ' +
        'Если вопрос про идущую историю — передай plotId этой нити: лормастер увидит её скрытый слой и сможет ответить только косвенно, не называя разгадку. ' +
        'Закрытую или сыгранную нить не передавай — тогда он читает только хронику. ' +
        'Канонические неизвестности из брифа он не раскрывает. Из нераскрытого слоя — только косвенное. Соседние бытовые пробелы может установить.',
      parameters: {
        type: 'object',
        required: ['question'],
        properties: {
          question: {
            type: 'string',
            description:
              'Один вопрос о факте этого мира: что есть, что произошло, кто, где, как устроено. ' +
              'Не выбор действия, не оценка воли покровителя и не разбор предположения.',
          },
          plotId: {
            type: 'string',
            description:
              'id идущей истории или сопряжения. Только открытая нить: закрытую не передавай.',
          },
        },
      },
      handler: async ({ question, plotId }) => {
        const q = String(question || '').trim();
        if (!q) return toolFail('empty_question', 'Нужен один фактический вопрос в поле question.');
        const result = await askLoremaster({
          config: ctx.config,
          runtime: ctx.runtime,
          storage,
          domain,
          questions: [q],
          asker: `ruler:${character.name}`,
          plotId: plotId || null,
          conflux: ctx.conflux || null,
          maxTurns: 8,
        });
        const wanted = String(plotId || '').trim();
        const focused = Boolean(result.focusPlotId);
        return {
          ok: true,
          answers: result.answers,
          summary: result.loreTextForAsker,
          newFactsCount: result.addedFacts.length,
          newFactTexts: result.addedFacts.map((f) => f.text),
          plotId: result.focusPlotId,
          focusNote:
            wanted && !focused
              ? 'Эта нить сейчас закрыта. Лормастер ответил по хронике и общим фактам, без канона тайны.'
              : null,
          hint:
            'Перескажи суть своими словами и своим тоном, не цитируя карточки фактов. ' +
            'Если Лормастер установил новый факт — считай его реальным. ' +
            'Если он оставил конкретную вещь неизвестной: не додумывай, не превращай гипотезу в факт ' +
            'и не спрашивай то же самое другими словами. Чтобы установить такое — declare_process (розыск, осмотр, исследование).',
        };
      },
    },
    {
      name: 'consult_informant',
      description:
        'Справка о СОСЕДНЕМ городе во время сопряжения: устройство, летопись, люди, порядки, список его историй. ' +
        'Доступен только пока острова состыкованы. Если не состыкованы — информатора нет, так и скажи. ' +
        'Не путай с consult_loremaster: лормастер знает свой город, информатор — соседа.',
      parameters: {
        type: 'object',
        required: ['questions'],
        properties: {
          questions: {
            type: 'array',
            items: { type: 'string' },
            description: '1–5 конкретных вопросов о соседе',
          },
        },
      },
      handler: async ({ questions }) => {
        const result = await askInformant({
          config: ctx.config,
          runtime: ctx.runtime,
          storage,
          domain,
          questions: questions || [],
          asker: `ruler:${character.name}`,
          conflux: ctx.conflux || null,
          maxTurns: 8,
        });
        if (result.error === 'no_informant') {
          return {
            ok: false,
            error: 'no_informant',
            agentMessage:
              'Информатора нет: острова не состыкованы. О внутренней жизни соседа сведений нет — так и скажи покровителю, не выдумывай.',
          };
        }
        return {
          ok: true,
          answers: result.answers,
          summary: result.loreTextForAsker,
          newFactsCount: (result.addedFacts || []).length,
          newFactTexts: (result.addedFacts || []).map((f) => f.text),
          hint:
            'Перескажи суть своими словами. Новый факт о соседе уже записан у него; у нас — ссылка на ту же формулировку. ' +
            'Если информатор сказал, что не знает — не додумывай.',
        };
      },
    },
    {
      name: 'declare_process',
      description:
        'Дело: стройка, суд, поход, снабжение, а также объявление или отмена постоянного правила (через rule). ' +
        'Если воля ещё неясна — не вызывай, спроси покровителя (commitment=clarify). ' +
        'Срок и трудность сам не оценивай: их посчитает отдельный оценщик. ' +
        'Отказы: too_many_processes (все сановники заняты), officer_busy (названный сановник уже ведёт другое). ' +
        'В речи — человеческая причина; предложи паузу или отмену текущего, не «доска» и не «слот».',
      parameters: {
        type: 'object',
        required: ['summary', 'detail', 'linkedStats'],
        properties: {
          summary: { type: 'string' },
          detail: {
            type: 'string',
            description:
              'Если покровитель торопит или велит не спешить — отрази это в detail дословно по смыслу.',
          },
          goal: {
            type: 'string',
            description:
              'Одной фразой: что считается достигнутой целью дела (для исхода в хронике). Не обязательно.',
          },
          pace: {
            type: 'string',
            enum: ['спешка', 'обстоятельно'],
            description:
              'Только воля покровителя к темпу, не твоя оценка. «спешка» — велел быстрее (риск выше), ' +
              '«обстоятельно» — велел не спешить. Не назвал темпа — поле не передавай.',
          },
          rule: {
            type: 'string',
            description:
              'Формулировка ПОСТОЯННОГО правила города (запрет, закон, регулярный обряд, порядок службы). ' +
              'Передавай, только если покровитель хочет всегдашний порядок, а не разовую работу. ' +
              'Дело объявляет волю: успех вписывает правило в порядок города, провал — «объявили, но не приняли».',
          },
          ruleAction: {
            type: 'string',
            enum: ['declare', 'revoke'],
            description: 'declare — ввести правило (по умолчанию), revoke — отменить уже действующее.',
          },
          linkedStats: {
            type: 'array',
            items: { type: 'string' },
            minItems: 1,
            description: `Ровно один стат характера ДЕЛА из: ${(ctx.config.stats || [])
              .map((s) => s.id)
              .join(', ')}`,
          },
          office: {
            type: 'string',
            description:
              'Должность сановника, если покровитель назвал конкретного (treasurer/marshal/keeper/chancellor). ' +
              'Пусто + randomOfficer — движок выберет случайного свободного.',
          },
          randomOfficer: {
            type: 'boolean',
            description: 'true, если покровитель сказал «разберитесь сами» / не назвал сановника.',
          },
          insistOffPortfolio: {
            type: 'boolean',
            description:
              'true только после спора: покровитель настаивает отправить не того сановника.',
          },
          onBehalfOf: { type: 'string', default: 'patron' },
          characterNote: { type: 'string' },
          plotId: {
            type: 'string',
            description:
              'id живой истории, которую покровитель этим делом пытается сдвинуть. ' +
              'Смотри на замысел из разговора, не на общее место и не на «единственную открытую» нить. ' +
              'Пока острова состыкованы, можно передать id нити соседа (из ответа информатора). ' +
              'Закрытую историю не подставляй: продолжение закрытого — пустой plotId, своё поручение. ' +
              'Если неясно, про какую беду речь или это вообще новое хозяйство — спроси (commitment=clarify), не гадай. ' +
              'Если приказ не про живую историю — оставь пустым, дело заведёт свою нить само.',
          },
          chronicleId: {
            type: 'string',
            description:
              'id известной хроники соседа. Для intel=true, если карточки сюжета ещё нет — передай chronicleId вместо plotId.',
          },
          intel: {
            type: 'boolean',
            description:
              'true — целенаправленно разведать конкретный чужой сюжет (нужен plotId или chronicleId). ' +
              'Не для вмешательства и не для «пошлите шпионов на остров вообще».',
          },
          secret: {
            type: 'boolean',
            description:
              'true — дело скрыто от соседнего города до разрешения. Не для обычных поручений в своём городе.',
          },
          guardPassage: {
            type: 'boolean',
            description: 'true — дело держит проход (дорого: сезон и не легче HARD). Не предлагай это сам.',
          },
          abortOutcome: {
            type: 'string',
            description: 'Что будет, если острова разойдутся до конца дела. Для дел через проход обязательно по смыслу.',
          },
        },
      },
      handler: async ({
        summary,
        detail,
        pace = null,
        rule = null,
        ruleAction = 'declare',
        linkedStats,
        onBehalfOf = 'patron',
        characterNote,
        plotId,
        chronicleId,
        intel = false,
        secret = false,
        guardPassage = false,
        abortOutcome = null,
        goal,
        office = null,
        randomOfficer = false,
        insistOffPortfolio = false,
      }) => {
        ensureOfficersFromLore(domain, ctx.config);
        const named = office ? findOfficer(domain, { office: String(office) }) : null;
        if (named) {
          const current = officerActiveProcess(domain, named);
          if (current) {
            return toolFail('officer_busy', officerBusyAgentMessage(named, current));
          }
        }
        const slots = canStartProcess(domain, ctx.config);
        if (!slots.ok) {
          return {
            ok: false,
            error: 'too_many_processes',
            reason: 'limit',
            active: slots.active,
            max: slots.max,
            busyWith: slots.busy,
            agentMessage:
              'ОТКАЗ: все сановники заняты (' +
              `${slots.active}/${slots.max}` +
              '). Это НЕ «похожее дело». ' +
              'В речи: назови, кто чем занят; предложи приостановить (pause_process) или свернуть (revoke_process) одно, ' +
              'затем отправить освободившегося на новое. Не говори «лимит», process, tool. Новое дело НЕ объявляй, пока старое не снято.',
          };
        }
        const dup = findDuplicateProcess(domain, summary, detail);
        if (dup) {
          normalizeProcess(dup, ctx.config);
          return {
            ok: false,
            error: 'duplicate_process',
            reason: 'duplicate',
            existingProcessId: dup.id,
            existingSummary: dup.summary,
            remaining: bandWord(deedRemainingBand(dup, day)),
            agentMessage:
              'ОТКАЗ: похожее дело уже идёт — «' +
              dup.summary +
              `» (id ${dup.id}, ждать ещё ${bandWord(deedRemainingBand(dup, day))}). ` +
              'Это НЕ нехватка слотов и НЕ общая занятость города. ' +
              'Покровитель, скорее всего, уточняет его: вызови update_process с этим id, ' +
              'допиши новый вопрос (addDetail) и при нужде pace. commitment=process. ' +
              'Не выдумывай отговорку про «слишком много дел» и не обещай вторую такую же нить.',
          };
        }
        const linked = resolveLinkedStats(linkedStats, ctx.config);
        if (!linked.length) {
          return toolFail(
            'linked_stats_required',
            `linkedStats обязательны — ровно один id из: ${(ctx.config.stats || []).map((s) => s.id).join(', ')}. ` +
              'Это стат характера задачи, не должности сановника.',
          );
        }
        const linkedStat = linked[0];
        let officer = named;
        if (!officer && (randomOfficer || !office)) {
          officer = pickRandomFreeOfficer(domain);
        }
        if (!officer) {
          return toolFail(
            'officer_required',
            named
              ? officerBusyAgentMessage(named, officerActiveProcess(domain, named) || { summary: 'другое поручение' })
              : 'Нет свободного сановника. Предложи паузу или отмену одного из идущих дел.',
          );
        }
        const stillBusy = officerActiveProcess(domain, officer);
        if (stillBusy) {
          return toolFail('officer_busy', officerBusyAgentMessage(officer, stillBusy));
        }
        const mismatch = isOffPortfolio(officer, linkedStat);
        if (mismatch && named && !insistOffPortfolio && !randomOfficer) {
          return toolFail(
            'off_portfolio_warn',
            `Покровитель шлёт ${officer.title} ${officer.name} на чужое (дело про ${linkedStat}, должность — ${officer.statId}). ` +
              'Сначала поспорь и предупреди, что справится плохо. Если настаивает — повтори declare_process с insistOffPortfolio=true.',
          );
        }
        const ruleText = String(rule || '').trim();
        const ruleKind = ruleText ? parseRuleAction(ruleAction) : null;
        if (ruleText && ruleText.length < 3) {
          return toolFail(
            'rule_too_short',
            'Формулировка постоянного правила слишком короткая. Скажи правило целиком и вызови снова.',
          );
        }
        let revoking = null;
        if (ruleKind === 'revoke') {
          revoking = findRule(domain, { text: ruleText });
          if (!revoking) {
            const list = cityRules(domain);
            return {
              ok: false,
              error: 'rule_not_found',
              standingRules: list.map((m) => ({ id: m.id, text: m.text })),
              agentMessage:
                'Такого постоянного правила в городе нет. Возьми формулировку из списка ниже и вызови снова, ' +
                'либо скажи покровителю, что этот порядок и так не действует.\n' +
                (list.map((m) => `- ${m.text}`).join('\n') || '(постоянных правил нет)'),
            };
          }
        }
        const paceShift = pace === 'спешка' ? -1 : pace === 'обстоятельно' ? 1 : 0;
        const wantIntel = Boolean(intel);
        const partners = ctx.conflux && ctx.partner ? [domain, ctx.partner] : [domain];
        let targetPlot = null;
        if (plotId) {
          targetPlot = findVisiblePlot(domain, String(plotId), ctx.partner);
        } else if (chronicleId && ctx.conflux) {
          targetPlot = findPlotByChronicleId(ctx.conflux, String(chronicleId), partners);
        }
        if (isConfluxPlot(targetPlot)) {
          return toolFail(
            'pair_thread_no_deeds',
            'Нить сопряжения — состояние отношений, не история. Дело в неё ставить нельзя. ' +
              'Назначь дело в свою нить, в нить соседа (id из информатора) или оставь без plotId.',
          );
        }
        if (wantIntel) {
          if (!ctx.conflux) {
            return toolFail('intel_needs_conflux', 'Разведка конкретного сюжета только во время сопряжения.');
          }
          if (!targetPlot) {
            return toolFail(
              'intel_needs_target',
              'Для intel=true нужен plotId нити или chronicleId известной записи.',
            );
          }
          if (plotHostId(targetPlot) === String(domain.id) || plotConcerns(targetPlot, domain.id) || isConfluxPlot(targetPlot)) {
            return toolFail(
              'intel_already_known',
              'Эта история уже известна городу как линия. intel не нужен — заведи обычное дело, если вмешиваетесь.',
            );
          }
        }
        const action = {
          id: newId('act'),
          summary,
          detail,
          goal: String(goal || '').trim() || null,
          linkedStats: [linkedStat],
          officerId: officer.id,
          office: officer.office,
          offPortfolio: mismatch,
          onBehalfOf,
          characterId: character.id,
          characterName: character.name,
          characterNote: characterNote || null,
          status: 'active',
          initiative: 'patron',
          intel: wantIntel,
          secret: Boolean(secret) && Boolean(ctx.conflux),
          secretForDomainId: secret && ctx.conflux ? domain.id : null,
          passageGuard: Boolean(guardPassage) && ctx.conflux?.status === 'docked',
          abortOutcome: abortOutcome ? String(abortOutcome).trim() : null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        domain.state.pendingActions.push(action);
        bindOfficerProcess(domain, officer, action);

        // Объявление воли — дело считанных дней и посильное; оценщик тут не нужен.
        let judged = null;
        if (ruleKind) {
          markRuleDeed(action, {
            text: ruleText,
            action: ruleKind,
            modifierId: revoking?.id || null,
          });
        } else {
          judged = await judgeDeed({
            runtime: ctx.runtime,
            domain,
            summary,
            detail,
            goal: action.goal || '',
            remainingWindowBand:
              ctx.conflux?.status === 'docked' ? remainingWindowBand(ctx.conflux, day) : '',
            partnerName: ctx.partner?.name || '',
            log: ctx.log,
          });
          if (judged.note) action.durationNote = judged.note;
          if (action.passageGuard) {
            if (durationBandIndex(judged.durationBand) < durationBandIndex('SEASON')) {
              judged.durationBand = 'SEASON';
            }
            if (difficultyBandIndex(judged.difficulty) < difficultyBandIndex('HARD')) {
              judged.difficulty = 'HARD';
            }
          }
          const applied = applyDockedDeedClassification(judged, {
            action,
            domain,
            ctx,
            day,
            targetPlot,
          });
          if (applied.error === 'window') {
            domain.state.pendingActions = (domain.state.pendingActions || []).filter((p) => p.id !== action.id);
            releaseOfficerProcess(domain, action);
            return toolFail('window', applied.message);
          }
          judged = applied.judged;
        }
        startDeed(action, { day, judged });
        if (paceShift) applyPace(action, paceShift, { day });
        scheduleDeedJob(world, domain, action);
        if (action.passageGuard && ctx.conflux) {
          await holdPassageShut({
            runtime: ctx.runtime,
            conflux: ctx.conflux,
            process: action,
            log: ctx.log,
          });
        }
        let plot = null;
        if (targetPlot) {
          targetPlot.relatedProcessIds = targetPlot.relatedProcessIds || [];
          if (!targetPlot.relatedProcessIds.includes(action.id)) {
            targetPlot.relatedProcessIds.push(action.id);
          }
          plot = targetPlot;
        } else if (plotId) {
          plot = linkProcessToPlotline(domain, action.id, String(plotId));
        }
        if (!plot) {
          plot = ensureErrandForProcess(domain, action, {
            tick: world?.tickIndex ?? null,
            config: ctx.config,
          }).plot;
        }
        action.plotlineId = plot?.id || null;
        let rehomed = false;
        if (plot && isStakedStory(plot) && !wantIntel) {
          await judgeProcessAlignment({
            runtime: ctx.runtime,
            domain,
            process: action,
            plot,
            log: ctx.log,
          });
          if (engagementOf(action) === 'UNRELATED') {
            const moved = rehomeUnrelatedProcess(domain, action, {
              tick: world?.tickIndex ?? null,
              config: ctx.config,
            });
            plot = moved.plot;
            rehomed = moved.rehomed;
            action.plotlineId = plot?.id || null;
          }
        }
        if (ctx.conflux && plot && !rehomed) {
          action.confluxId = ctx.conflux.id;
          action.ownerDomainId = domain.id;
          if (!wantIntel && !plotConcerns(plot, domain.id) && !isConfluxPlot(plot)) {
            sharePlotWithDomain(plot, domain.id, {
              reason: 'process',
              conflux: ctx.conflux,
              domains: partners,
            });
          }
        }
        await save();
        const impossibleWarn = action.impossible
          ? ' Это дело смертным не по силам: людей займут, а толку не будет. Предупреди заранее.'
          : '';
        const ruleWarn = ruleKind
          ? ruleKind === 'revoke'
            ? ' Это отмена постоянного правила: объявить недолго, но город ещё должен отвыкнуть.'
            : ' Это объявление постоянного правила: если город его примет, оно останется в порядке города.'
          : '';
        const hint = rehomed
          ? unrelatedAttachHint(paceHint(action, judged?.note))
          : `В речи: принял повеление. ${paceHint(action, judged?.note)}` +
            ruleWarn +
            impossibleWarn +
            ' Не говори «уже сделали» и не рапортуй механику: весть об исходе принесёшь сам, когда работа кончится.';
        return {
          ok: true,
          process: action,
          duration: bandWord(action.durationBand),
          difficulty: difficultyWord(action.difficulty),
          rule: ruleKind,
          rehomed,
          hint,
        };
      },
    },
    {
      name: 'set_proxy',
      description:
        'Доверенность правителя: свободный текст, как городу вести себя при сопряжении и на ходе нити. ' +
        'Не дело и не постоянное правило. Сановник может по ней действовать или нет. ' +
        'clear=true — снять прежнюю доверенность.',
      parameters: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description: 'Как городу себя вести. Одна ясная фраза от лица правителя.',
          },
          clear: { type: 'boolean', description: 'true — отменить действующую доверенность.' },
        },
      },
      handler: async ({ text, clear = false }) => {
        if (clear) {
          if (!proxyText(domain)) {
            return toolFail('proxy_not_found', 'Доверенности и не было. Скажи об этом покровителю.');
          }
          setProxyText(domain, '');
          await save();
          return {
            ok: true,
            cleared: true,
            hint: 'В речи: доверенность снята. Коротко, без механики.',
          };
        }
        const res = setProxyText(domain, text);
        if (!res.proxyText) {
          return toolFail('proxy_empty', 'Пустая доверенность. Сформулируй, как городу себя вести, и вызови снова.');
        }
        await save();
        return {
          ok: true,
          proxyText: res.proxyText,
          hint: 'В речи: доверенность принята. Не обещай, что город обязательно вмешается — сановник решит сам.',
        };
      },
    },
    {
      name: 'update_process',
      description:
        'Уточнить идущее дело. Пока оно не сдвинулось (fresh=true) — можно переписать целиком; ' +
        'дальше только дополни поручение. processId — id или несколько слов из summary.',
      parameters: {
        type: 'object',
        required: ['processId'],
        properties: {
          processId: {
            type: 'string',
            description: 'Id процесса (act_…) или ключевые слова из summary',
          },
          summary: { type: 'string', description: 'Пока дело не сдвинулось — заменяет название; иначе дописывается.' },
          detail: { type: 'string', description: 'Пока дело не сдвинулось — заменяет поручение; иначе дописывается.' },
          goal: {
            type: 'string',
            description: 'Одной фразой: что считается достигнутой целью. Можно уточнить когда угодно.',
          },
          addDetail: {
            type: 'string',
            description: 'Дополнить поручение новой оговоркой или вопросом, не затирая старое.',
          },
          pace: {
            type: 'string',
            enum: ['спешка', 'обстоятельно'],
            description:
              'Воля покровителя к темпу. Сдвинуть можно один раз: если pace уже стоит, инструмент откажет, ' +
              'и ты честно скажешь, что быстрее (или медленнее) уже некуда.',
          },
          linkedStats: { type: 'array', items: { type: 'string' } },
          characterNote: { type: 'string' },
          plotId: {
            type: 'string',
            description:
              'Не для поручения, снятого с истории. Если покровитель имел в виду живую историю — ' +
              'сначала revoke_process это поручение, затем declare_process с уточнённой целью и plotId.',
          },
        },
      },
      handler: async ({
        processId,
        summary,
        detail,
        addDetail,
        pace = null,
        linkedStats,
        characterNote,
        goal,
        plotId,
      }) => {
        const { process: action, candidates } = resolveActiveProcess(domain, processId, ctx.config);
        if (!action) {
          return {
            ok: false,
            error: 'process not found',
            activeProcesses: candidates.map((a) => ({ id: a.id, summary: a.summary })),
            agentMessage:
              'Дело не найдено по processId. Возьми id из списка ниже и вызови update_process снова. ' +
              'Игроку не говори «не среди дел», если список не пуст — сначала уточни id.\n' +
              formatActiveProcessesForAgent(domain, ctx.config),
          };
        }
        const revised = reviseProcess(
          action,
          { summary, detail, addDetail, linkedStats, characterNote, goal, day },
          ctx.config,
        );
        // Переписанное дело — другая работа: срок и трудность считаются заново.
        if (revised.rewritten && !isRuleDeed(action)) {
          if (ctx.conflux?.status === 'docked') {
            action.crossIsland = false;
            action.targetDomainId = null;
            action.opposedStat = null;
          }
          let judged = await judgeDeed({
            runtime: ctx.runtime,
            domain,
            summary: action.summary,
            detail: action.detail,
            goal: action.goal || '',
            remainingWindowBand:
              ctx.conflux?.status === 'docked' ? remainingWindowBand(ctx.conflux, day) : '',
            partnerName: ctx.partner?.name || '',
            log: ctx.log,
          });
          const rewritePlot = findVisiblePlot(domain, action.plotlineId, ctx.partner);
          const applied = applyDockedDeedClassification(judged, {
            action,
            domain,
            ctx,
            day,
            targetPlot: rewritePlot,
          });
          if (applied.error === 'window') {
            return toolFail('window', applied.message);
          }
          judged = applied.judged;
          startDeed(action, { day, judged });
          if (judged.note) action.durationNote = judged.note;
          scheduleDeedJob(world, domain, action);
        }
        let paceResult = null;
        if (pace) {
          const wanted = pace === 'спешка' ? -1 : 1;
          paceResult = applyPace(action, wanted, { day });
          if (!paceResult.ok) {
            const already = paceLabel(action.paceShift);
            return toolFail(
              'pace_locked',
              `Темп этого дела уже сдвинут (${already}), второй раз его не поменять. ` +
                'В речи честно скажи: быстрее (или медленнее) уже некуда, люди и так на пределе. ' +
                'Ничего не обещай и не заводи второе дело о том же.',
            );
          }
          scheduleDeedJob(world, domain, action);
        }
        syncErrandFromProcess(domain, action);
        if (plotId) {
          const current = findVisiblePlot(domain, action.plotlineId, ctx.partner);
          const target = findVisiblePlot(domain, String(plotId), ctx.partner);
          if (isErrandPlot(current) && target && isStakedStory(target)) {
            return toolFail(
              'retarget_needs_new_process',
              'Это поручение снято с истории. Не перевешивай его. revoke_process это дело, затем declare_process с уточнённой целью и plotId той нити.',
            );
          }
          unlinkProcessFromAllPlots(domain, action.id);
          if (ctx.partner) unlinkProcessFromAllPlots(ctx.partner, action.id);
          if (target && isStakedStory(target)) {
            target.relatedProcessIds = target.relatedProcessIds || [];
            if (!target.relatedProcessIds.includes(action.id)) {
              target.relatedProcessIds.push(action.id);
            }
            action.plotlineId = target.id;
          } else {
            const linked = linkProcessToPlotline(domain, action.id, String(plotId));
            action.plotlineId = linked?.id || null;
          }
        }
        let plot = findVisiblePlot(domain, action.plotlineId, ctx.partner);
        let rehomed = false;
        if (
          plot &&
          isStakedStory(plot) &&
          (goal != null || revised.rewritten || summary || detail || addDetail || plotId)
        ) {
          await judgeProcessAlignment({
            runtime: ctx.runtime,
            domain,
            process: action,
            plot,
            log: ctx.log,
          });
          if (engagementOf(action) === 'UNRELATED') {
            const moved = rehomeUnrelatedProcess(domain, action, {
              tick: world?.tickIndex ?? null,
              config: ctx.config,
            });
            plot = moved.plot;
            rehomed = moved.rehomed;
            action.plotlineId = plot?.id || null;
          }
        }
        await save();
        const mode = revised.fresh ? 'дело ещё не сдвинулось, можно было переписать' : 'дело уже шло, текст только дополнен';
        return {
          ok: true,
          process: action,
          pace: paceLabel(action.paceShift),
          remaining: bandWord(deedRemainingBand(action, day)),
          rehomed,
          hint: rehomed
            ? unrelatedAttachHint(paceHint(action))
            : `${mode}. ${paceHint(action)}` +
              ' В речи не обещай, что уже сделано: весть об исходе принесёшь сам.',
        };
      },
    },
    {
      name: 'revoke_process',
      description:
        'Отозвать / свернуть длительное дело. processId — id из brief или несколько слов из summary ' +
        'по-русски («университет», «учебная программа»); латинские ключи не выдумывай.',
      parameters: {
        type: 'object',
        required: ['processId'],
        properties: {
          processId: {
            type: 'string',
            description: 'Id процесса (act_…) или ключевые слова из summary',
          },
          reason: { type: 'string' },
        },
      },
      handler: async ({ processId, reason }) => {
        const { process: action, candidates } = resolveActiveProcess(domain, processId, ctx.config);
        if (!action) {
          return {
            ok: false,
            error: 'process not found',
            activeProcesses: candidates.map((a) => ({ id: a.id, summary: a.summary })),
            agentMessage:
              'Дело не найдено по processId. Не говори покровителю, что приказа нет, если ниже есть активные дела — ' +
              'вызови revoke_process с верным id из списка.\n' +
              formatActiveProcessesForAgent(domain, ctx.config),
          };
        }
        action.status = 'revoked';
        action.revokeReason = reason || '';
        action.resolvedDay = day;
        action.updatedAt = new Date().toISOString();
        releaseOfficerProcess(domain, action);
        cancelDeedJobs(world, action.id);
        const dropped = detachProcessFromPlots(domain, action, { tick: world?.tickIndex ?? null });
        await save();
        return {
          ok: true,
          revokedId: action.id,
          summary: action.summary,
          closedErrands: dropped.closedErrands.map((p) => p.id),
          hint: dropped.closedErrands.length
            ? 'В речи: поручение свёрнуто, карточку убрали. Без id/process.'
            : 'В речи: дело свёрнуто/отложено по воле покровителя. Без id/process.',
        };
      },
    },
    {
      name: 'pause_process',
      description:
        'Поставить дело на паузу: проделанное не теряется, срок не идёт, сановник освобождается. Не отмена.',
      parameters: {
        type: 'object',
        required: ['processId'],
        properties: {
          processId: { type: 'string', description: 'Id дела или слова из названия' },
        },
      },
      handler: async ({ processId }) => {
        const { process: action, candidates } = resolveActiveProcess(domain, processId, ctx.config);
        if (!action) {
          return {
            ok: false,
            error: 'process not found',
            activeProcesses: candidates.map((a) => ({ id: a.id, summary: a.summary })),
          };
        }
        const result = pauseProcess(action, domain);
        if (!result.ok) return { ok: false, error: result.error };
        pauseDeedClock(action, day);
        cancelDeedJobs(world, action.id);
        await save();
        return {
          ok: true,
          pausedId: action.id,
          summary: action.summary,
          hint: 'Дело на паузе. В речи: работы остановили, к ним можно вернуться. Сановник свободен.',
        };
      },
    },
    {
      name: 'resume_process',
      description:
        'Снять дело с паузы, если есть свободный слот (не больше лимита параллельных дел).',
      parameters: {
        type: 'object',
        required: ['processId'],
        properties: {
          processId: { type: 'string', description: 'Id паузы из pausedProcesses или слова из названия' },
        },
      },
      handler: async ({ processId }) => {
        const paused = pausedProcesses(domain, ctx.config);
        const raw = String(processId || '').trim().toLowerCase();
        const action =
          paused.find((a) => a.id === processId) ||
          paused.find((a) => String(a.summary || '').toLowerCase().includes(raw));
        if (!action) {
          return {
            ok: false,
            error: 'not_paused',
            pausedProcesses: paused.map((a) => ({ id: a.id, summary: a.summary })),
          };
        }
        const result = resumeProcess(action, domain, ctx.config);
        if (!result.ok) {
          return {
            ok: false,
            error: result.error,
            active: result.active,
            max: result.max,
            agentMessage:
              result.error === 'too_many_processes'
                ? `Слот занят (${result.active}/${result.max}). Сначала сверни или поставь на паузу другое дело.`
                : result.error,
          };
        }
        resumeDeedClock(action, day);
        scheduleDeedJob(world, domain, action);
        await save();
        return {
          ok: true,
          resumedId: action.id,
          summary: action.summary,
          remaining: bandWord(deedRemainingBand(action, day)),
          hint: 'Дело снова идёт, срок пошёл с того же места. В речи без id.',
        };
      },
    },
    {
      name: 'write_memory',
      description:
        'Записать себе на память короткую заметку: как звать покровителя, чего не делать, о чём не будить. Не дневник.',
      parameters: {
        type: 'object',
        required: ['text'],
        properties: {
          text: { type: 'string', description: 'Одна фраза, до 280 знаков.' },
        },
      },
      handler: async ({ text }) => {
        const result = writeRulerMemory(domain, text, { tick: ctx.world?.tickIndex ?? null });
        if (!result.ok) return { ok: false, error: result.error };
        await save();
        return { ok: true, memory: result.note, hint: 'Держись этой заметки в дальнейшем.' };
      },
    },
    {
      name: 'forget_memory',
      description: 'Стереть заметку памяти по id из списка памяти.',
      parameters: {
        type: 'object',
        required: ['memoryId'],
        properties: { memoryId: { type: 'string' } },
      },
      handler: async ({ memoryId }) => {
        const result = forgetRulerMemory(domain, memoryId);
        if (!result.ok) return { ok: false, error: result.error };
        await save();
        return { ok: true };
      },
    },
  ].filter(Boolean);
}
