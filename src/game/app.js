import { buildOnboardingTools } from './onboardingTools.js';
import {
  chronicleEntries,
  newsChronicleEntries,
  filterChronicleForDomain,
  formatChronicleScope,
  formatChroniclePriestMark,
  normalizeDomain,
  formatCastForPrompt,
  applyPatronName,
  firstMentionHintForSpeech,
  peopleNamedInTexts,
  inferRulerGender,
} from './models.js';
import {
  qualitativePopulation,
  qualitativeStatsBrief,
  statEpithetsShort,
  formatRulerAttitudes,
  adjustAttitude,
  normalizeRulerAttitudes,
} from './stats.js';
import { askLoremaster } from './loremaster.js';
import { newId } from './ids.js';
import { assertsIslandsParted, monthsUntilDock, findActiveConfluxForDomain, formatContactForPrompt } from './conflux.js';
import {
  hydrateDomainFromConflux,
  dehydrateDomainToConflux,
  sharePlotWithDomain,
  plotConcerns,
  cityKnowsPlot,
  findPlotByChronicleId,
  leakedTracesForViewer,
  takeIntelOffer,
} from './confluxBoard.js';
import { askInformant } from './informant.js';
import {
  emptyOnboardingDraft,
  normalizeOnboardingDraft,
  validateCityNameAvailable,
  validatePatronName,
  collectOccupiedCityNames,
  isCityNameOccupied,
  occupiedCityNameError,
  extractUserCityName,
  formatPlayerBrief,
  claimsOnboardingAlreadyCreated,
  extractPitchedCityName,
  lastPitchedCityName,
  playerAsksReroll,
  planOnboardingAutoStart,
  formatOnboardingStartReply,
  formatOnboardingStatusCard,
  deriveOnboardingPhase,
  hasPitchedCity,
  hasReadyConcept,
  canStartOnboarding,
  applyUserNamedCity,
  applyUserNamedPatron,
  maybeSwitchToDossier,
  rememberLongUserBrief,
  clipOnboardingBrief,
  appendNeedNameNote,
  appendNeedPatronNote,
  appendNameTakenNote,
  ONBOARDING_NEED_NAME_NOTE,
  ONBOARDING_BUSY_REPLY,
  ONBOARDING_HISTORY_MESSAGES,
  LONG_USER_MESSAGE_MIN,
  BRIEF_CITY_MAX,
  BRIEF_RULER_MAX,
  BRIEF_FREEFORM_MAX,
} from './onboarding.js';
import {
  normalizeDomainProcesses,
  normalizeProcess,
  hasHardPatronDeadline,
  findDuplicateProcess,
  resolveLinkedStats,
  resolveActiveProcess,
  formatActiveProcessesForAgent,
  activeProcesses,
  canStartProcess,
  processProgressFeel,
  recentlyClosedProcesses,
  textsLookSame,
  reviseProcess,
  applyObjectiveSchedule,
  processIsFresh,
  processPaceRatio,
  blessProcess,
  processOwnedBy,
  pauseProcess,
  resumeProcess,
  pausedProcesses,
} from './processes.js';
import { formatBoardForSpeech, warmPlotlines, plotConfig, findPlotline, clipPlotText, PLOT_TITLE_MAX, PLOT_SUMMARY_MAX, isOrderPlot, isThreeActPlot } from './plotlines.js';
import { queueOrderRequest, listStandingOrders } from './orders.js';
import { islandDeleteCheck } from '../clients/telegram/access.js';
import { generateIslandImage, removeIslandImage } from './islandImage.js';
import { generateOfficerPortraits } from './officerImage.js';
import { generateDomain } from './genesis.js';
import {
  formatOfficersForPrompt,
  findOfficer,
  pickRandomFreeOfficer,
  bindOfficerProcess,
  releaseOfficerProcess,
  isOffPortfolio,
  officerActiveProcess,
  officerBusyAgentMessage,
  ensureOfficersFromLore,
} from './officers.js';
import { formatIslandReveal } from './islandReveal.js';
import { formatProgressBar, genesisTutorialText } from './progressBar.js';
import { genesisDateMessage } from './tickClock.js';
import { estimateProcessDuration } from './durationJudge.js';
import { ensureErrandForProcess, linkProcessToPlotline, rehomeUnrelatedProcess, plotSituationForSpeech, attendingQueueForPlot, detachProcessFromPlots } from './plotEngine.js';
import { judgeProcessAlignment, engagementOf, engagementAttends } from './plotAlign.js';
import { dialogHistoryForPrompt } from './memory.js';
import {
  newsScheduleOf,
  setNewsSchedule,
  shouldSendTickNews,
  tickNewsStyleHint,
} from './newsSchedule.js';
import {
  formatRulerVoiceForPrompt,
  writeRulerMemory,
  forgetRulerMemory,
  shouldRulerAskPatron,
  markRulerAsked,
} from './rulerMemory.js';
import {
  shouldAskPatronPresence,
  markPatronPresenceAsked,
  clearPatronPresenceAsked,
} from './steward.js';
import { getLogger, truncate, setLoggerWorldId } from '../log.js';
import { initUsageRecording } from '../llm/usage.js';
import { toolFail } from '../agents/toolResult.js';

/** Недавняя запись расстыковки из хроники домена (если есть). */
function recentUndockFact(domain) {
  const lore = domain.lore || [];
  const byUndock = chronicleEntries(lore).filter((f) => (f.tags || []).includes('undock'));
  if (byUndock.length) return byUndock[byUndock.length - 1];
  const byEnded = chronicleEntries(lore).filter(
    (f) =>
      (f.tags || []).includes('ended') &&
      (f.tags || []).some((t) => String(t).startsWith('conflux:')),
  );
  return byEnded.length ? byEnded[byEnded.length - 1] : null;
}

/** Ответ агента похож на сырой tool-call / JSON, а не на речь. */
function looksLikeToolDump(text) {
  const t = String(text || '');
  if (!t.trim()) return false;
  if (/tools\.\w+/i.test(t)) return true;
  if (/天天送json|комментary|commentary\s+json/i.test(t)) return true;
  if (/declare_action|declare_process|consult_loremaster|consult_informant|set_patron_name|read_domain_brief/i.test(t) && /\{/.test(t)) {
    return true;
  }
  if (/"summary"\s*:/.test(t) && (/"durationMonths"\s*:/.test(t) || /"expectedMonths"\s*:/.test(t))) return true;
  return false;
}

const DEFAULT_RULER_FAIL =
  'Жрец не ответил вовремя. Этот ход система не сохранила — повтори волю, когда будешь готов.';

export function rulerHoldLine(config, character) {
  const gender = inferRulerGender(character);
  const pack = config?.agents?.ruler?.holdMessage || {};
  return String(pack[gender] || pack.male || pack.female || '').trim();
}

export function rulerFailLine(config) {
  return String(config?.agents?.ruler?.failMessage || '').trim() || DEFAULT_RULER_FAIL;
}

function processPaceFeel(process) {
  const ratio = processPaceRatio(process);
  if (ratio < 0.95) return 'hurried';
  if (ratio > 1.05) return 'careful';
  return 'steady';
}

function paceHint(action) {
  const obj = action.objectiveMonths || action.expectedMonths;
  const left = action.monthsLeft;
  const ratio = processPaceRatio(action);
  if (ratio < 0.95) {
    return (
      `Честная оценка ${obj} мес., назначено ${action.expectedMonths} (осталось ${left}). ` +
      'В речи ПРИМИ срок покровителя и ПРЕДУПРЕДИ: спешка повышает риск тяжёлого исхода. ' +
      'Если настаивает — согласись, не торгуйся дальше.'
    );
  }
  if (ratio > 1.05) {
    return (
      `Честная оценка ${obj} мес., отвели ${action.expectedMonths}. ` +
      'Не спорь: будут делать обстоятельнее, риск провала ниже.'
    );
  }
  return `Работа займёт около ${obj} мес., пока ничего не сделано.`;
}

function syncErrandFromProcess(domain, action) {
  const plot = findPlotline(domain, action.plotlineId);
  if (!plot || plot.kind !== 'errand') return;
  if (action.summary) plot.title = clipPlotText(action.summary, PLOT_TITLE_MAX);
  if (action.detail) plot.synopsis = clipPlotText(action.detail, PLOT_SUMMARY_MAX);
}

function unlinkProcessFromAllPlots(domain, processId) {
  const id = String(processId);
  for (const plot of domain.plotlines || []) {
    plot.relatedProcessIds = (plot.relatedProcessIds || []).filter((x) => String(x) !== id);
  }
}

function unrelatedAttachHint(originPlot) {
  const situation = plotSituationForSpeech(originPlot);
  return (
    'Дело заведено, но к названной истории оно не относится — снято на отдельное поручение. ' +
    'В речи: приказ отдан, однако ты сомневаешься, что это поможет с той бедой, о которой говорил покровитель' +
    (situation ? ` (${situation})` : '') +
    '. Не уверен, что правильно понял замысел. Спроси коротко: это отдельное дело или всё же про ту беду? ' +
    'Не называй историю заголовком. commitment=process — работа уже началась. ' +
    'Если подтвердит, что отдельно — ничего не перевешивай. ' +
    'Если настаивает, что про ту беду — не перевешивай это поручение: revoke_process его (карточка поручения снимется), ' +
    'затем declare_process с УТОЧНЁННОЙ целью, которая реально двигает ту историю, и plotId той нити. commitment=process.'
  );
}

function queueAttachHint(domain, plot, action) {
  if (!plot || !isThreeActPlot(plot) || !engagementAttends(engagementOf(action))) return '';
  const head = attendingQueueForPlot(domain, plot)[0];
  if (!head || String(head.id) === String(action.id)) return '';
  return (
    ` На этой беде уже идёт «${head.summary}». Новое дело в очереди: сдвинется, когда прежнее завершит месяц ` +
    '(или сразу в тот месяц, когда прежнее закончится). В речи можно сказать, что сначала доведут прежнее.'
  );
}

/** Убрать префикс «Имя:» / «Имя —» из речи правителя. */
function stripSpeakerPrefix(text, characterName) {
  let t = String(text || '').trim();
  const name = String(characterName || '').trim();
  if (name) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    t = t.replace(new RegExp(`^${esc}\\s*[:：—\\-]\\s*`, 'i'), '');
  }
  return t.trim();
}

/**
 * Речь правителя уходит через submit_reply, поэтому обещание дела проверяется
 * структурно: заявленный commitment сверяется с успешными вызовами хода.
 */
export function rulerReplyCommitError({
  requestKind,
  commitment,
  text = '',
  okTools = new Set(),
} = {}) {
  const succeeded = (...names) => names.some((n) => okTools.has(n));
  const asked = /[?]/.test(String(text || ''));
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
  if (commitment === 'standing_order' && !succeeded('declare_standing_order')) {
    return {
      error: 'order_missing',
      message:
        'commitment=standing_order, но declare_standing_order не выполнен. Объяви порядок через tool или смени commitment.',
    };
  }
  if (commitment === 'revoked' && !succeeded('revoke_order', 'revoke_process')) {
    return {
      error: 'revoke_missing',
      message:
        'commitment=revoked, но отмена не выполнена. Вызови revoke_order (указ) или revoke_process (дело), либо смени commitment.',
    };
  }
  if (commitment === 'clarify') {
    if (succeeded('declare_process', 'update_process', 'declare_standing_order')) {
      return {
        error: 'clarify_after_act',
        message:
          'Дело или порядок уже заведены этим ходом. commitment=process или standing_order, не clarify.',
      };
    }
    if (requestKind === 'order_impossible') {
      return {
        error: 'impossible_not_refused',
        message:
          'Такой приказ смертному не исполнить. Поставь commitment=refused, не уточняй, как его выполнить.',
      };
    }
    if (requestKind !== 'order_long' && requestKind !== 'order_instant') {
      return {
        error: 'clarify_not_order',
        message:
          'clarify — только когда покровитель отдал приказ, который ещё нельзя облечь в дело или порядок. ' +
          'Для беседы и вопросов — commitment=none.',
      };
    }
    if (!asked) {
      return {
        error: 'clarify_no_question',
        message:
          'commitment=clarify: в речи должен быть вопрос покровителю (со знаком вопроса). ' +
          'Не додумывай недостающее и не обещай, что дело уже начато.',
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
  if (requestKind === 'order_instant' && commitment === 'none') {
    return {
      error: 'instant_ignored',
      message:
        'Покровитель велел решение сейчас, а в мире ничего не заведено. ' +
        'declare_standing_order — если это порядок, который теперь соблюдают всегда; ' +
        'declare_process на 1 месяц — если это дело с исходом. ' +
        'Если воля ещё неясна (разовое это или всегда, кого, до какой меры) — спроси, commitment=clarify. ' +
        'Либо откажи в речи с commitment=refused.',
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

function submitReplyTool(turn, character) {
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
            'order_instant',
            'order_impossible',
            'question',
            'smalltalk',
            'other',
          ],
          description:
            'order_long — велел долгое дело (стройка, суд, поход); order_instant — велел решение сейчас ' +
            '(закон, казнь, обряд, назначение); order_impossible — велел то, чего в этом мире не бывает ' +
            '(отправить тебя за край или в пустоту, воскресить мёртвых, стереть память, космос, перенос); ' +
            'question — спросил; smalltalk — беседа; other — прочее.',
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
          enum: ['none', 'process', 'standing_order', 'revoked', 'refused', 'clarify'],
          description:
            'Что сделано этим ходом: process (declare_process/update_process), standing_order, ' +
            'revoked (отменил указ или свернул дело), refused (честно отказал или отговорил), ' +
            'clarify (приказ есть, но воля неясна — спросил, дело ещё не заводил), ' +
            'none (действий не требовалось).',
        },
      },
    },
    handler: async ({ text, requestKind, commitment, touchedPlotIds, dayNote }) => {
      const body = String(text || '').trim();
      if (body.length < 2) {
        return toolFail('too_short', 'Речь пустая. Напиши ответ покровителю в text.');
      }
      const commitErr = rulerReplyCommitError({
        requestKind,
        commitment,
        text: body,
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

function characterTools(domain, storage, character, ctx) {
  const save = async () => {
    if (ctx.conflux) {
      dehydrateDomainToConflux(domain, ctx.conflux);
      await storage.saveDomain(domain);
      await storage.saveConflux(ctx.conflux);
      hydrateDomainFromConflux(domain, ctx.conflux, { mode: 'ruler' });
      return;
    }
    await storage.saveDomain(domain);
  };
  normalizeRulerAttitudes(character);
  normalizeDomainProcesses(domain, ctx.config);

  const world = ctx.world || null;

  return [
    {
      name: 'read_domain_brief',
      description:
        'Состояние города: население, статы (эпитеты), активные дела, указы, нити. ' +
        'Нужен и для «как дела», и для «что ты решил / какие приказы действуют».',
      parameters: { type: 'object', properties: {} },
      handler: async () => ({
        ok: true,
        name: domain.name,
        status: domain.status,
        patronName: domain.state?.patronName || null,
        populationFeel: qualitativePopulation(domain.population || 0),
        conditionFeel: qualitativeStatsBrief(domain.stats || {}, ctx.config),
        attitudes: formatRulerAttitudes(character, ctx.config),
        // Без каста правитель не знает своих же людей и додумывает за них.
        knownPeople: formatCastForPrompt(domain.lore, { limit: 20 }),
        officers: formatOfficersForPrompt(domain, ctx.config),
        guidance:
          'Отвечай в духе conditionFeel: качественно, без чисел и без имён статов. ' +
          'О делах — по-человечески: что делается и сколько примерно ждать.',
        guidancePeople:
          'knownPeople — люди, которых город уже знает: имя, пол, ремесло и что о них известно. ' +
          'Это правда, а не слухи. Не переспрашивай о том, что здесь написано, и не придумывай ' +
          'им другую судьбу.',
        standingOrders: listStandingOrders(domain, { tick: world?.tickIndex ?? null }),
        guidanceOrders:
          'standingOrders — действующие указы/порядки. pending=create/edit/revoke — заявка ещё не вступила, вступит с новостями месяца. ' +
          'indefinite=true — бессрочно; durationMonths и remainingMonths — срок в игровых месяцах, если он задан. ' +
          'Для отмены — revoke_order с этим id или кратким смыслом. Не объявляй новый указ, если он противоречит действующему: ' +
          'сначала отмени старый или обнови его.',
        processes: activeProcesses(domain, ctx.config).map((a) => ({
          id: a.id,
          summary: a.summary,
          detail: a.detail,
          goal: a.goal || null,
          monthsLeft: a.monthsLeft,
          expectedMonths: a.expectedMonths,
          objectiveMonths: a.objectiveMonths || a.expectedMonths,
          pace: processPaceFeel(a),
          linkedStats: a.linkedStats,
          initiative: a.initiative || 'patron',
          fresh: processIsFresh(a),
          progress: processProgressFeel(a),
          blessed: Boolean(a.blessed),
          intel: Boolean(a.intel),
        })),
        pausedProcesses: pausedProcesses(domain, ctx.config).map((a) => ({
          id: a.id,
          summary: a.summary,
          monthsLeft: a.monthsLeft,
          detail: a.detail,
        })),
        recentlyClosed: recentlyClosedProcesses(domain, world?.tickIndex),
        processSlots: canStartProcess(domain, ctx.config),
        plots: (domain.plotlines || []).map((p) => ({
          id: p.id,
          title: p.title,
          kind: p.kind === 'errand' ? 'errand' : p.kind === 'order' ? 'order' : 'story',
          hasProcess: Boolean((p.relatedProcessIds || []).length),
          shared: Boolean(p.shared || p.isMainConflux),
          foreign: Boolean(
            ctx.conflux &&
              !isOrderPlot(p) &&
              !p.isMainConflux &&
              !plotConcerns(p, domain.id),
          ),
        })),
        leakedTraces:
          ctx.conflux && ctx.partner
            ? leakedTracesForViewer(ctx.conflux, domain.id, [domain, ctx.partner])
            : [],
        guidanceProcesses:
          'processes[].progress — как дело шло в прошлом месяце: так и отвечай, если спрашивают. ' +
          'objectiveMonths — честная оценка срока, monthsLeft — сколько ещё ждут. ' +
          'pace=hurried — покровитель торопит, предупреди о риске; pace=careful — не спорь. ' +
          'fresh=true — дело ещё не сдвинулось: update_process может переписать его целиком. ' +
          'fresh=false — только дополни поручение и при нужде поменяй оставшийся срок (не меньше 1 мес.). ' +
          'goal — одной фразой, что считается достигнутой целью; можно не заполнять. ' +
          'blessed=true — покровитель уже благословил это дело; исход будет [КРИТИЧЕСКИЙ УСПЕХ], так и помни. ' +
          'pausedProcesses — на паузе: прогресс жив, слот свободен, тик не идёт. Снять паузу — resume_process, если есть слот. ' +
          'recentlyClosed[].outcome — итог [ПРОВАЛ] / [УСПЕХ] / [КРИТИЧЕСКИЙ УСПЕХ]; про них не говори «не знаю». ' +
          'Недавно закрытое дело столпа не занимает: он свободен для нового поручения. ' +
          'Если покровитель хочет столпа, у которого в officers/processes уже есть ИДУЩЕЕ дело — назови это дело и предложи pause_process или revoke_process, затем declare_process. ' +
          'Для update_process / revoke_process бери id из processes[].id. ' +
          'Если id не помнишь — передай краткий смысл дела в processId (например «университет»), система найдёт. ' +
          'Покровитель уточняет уже идущую ту же работу (новый вопрос к тому же дознанию, другой темп) — update_process, commitment=process. Не отказывай и не заводи второе. ' +
          'Общий храм, общий двор или общие имена — не дубль и не повод слить РАЗНЫЕ работы. ' +
          'initiative=ruler — это дело ты завёл сам, пока покровитель молчал; на вопрос «что ты решал» называй их.',
        guidancePlots:
          'plots[] — живые нити, которые этот город знает как линии. kind=errand уже привязана к делу; kind=story может быть без поручения; kind=order — постоянный порядок, дело на него не заводи. ' +
          'foreign=true — история соседа, уже раскрытая нам: дело с plotId вмешивается в неё по существу. ' +
          'shared=true — общая история сопряжения, дело можно заводить с обеих сторон. ' +
          'leakedTraces[] — голые факты о соседе, сюжетной карточки нет. Не называй это историей по имени. ' +
          'Если покровитель хочет «узнать, что это» — declare_process с intel=true и chronicleId (или plotId, если карточка уже известна). ' +
          'intel нельзя на указ и на уже раскрытую нить. Шпионы «на остров вообще» — обычное дело без intel и без plotId. ' +
          'Приказ по известной истории без дела — declare_process с plotId этой истории. ' +
          'plotId — нить, которую покровитель этим делом пытается решить, судя по разговору, а не соседняя из-за места или людей. ' +
          'Закрытую не подставляй. Сомнение — commitment=clarify, не угадывай id. ' +
          'Если declare_process вернул, что дело снято с истории — так и скажи покровителю: приказ отдан, но ты не уверен, что это поможет с той бедой. ' +
          'Если он имел в виду ту историю — revoke_process поручение, затем declare_process с уточнённой целью и plotId. Не перевешивай старое поручение.',
      }),
    },
    !domain.state?.patronName && {
      name: 'set_patron_name',
      description:
        'Запомнить имя/обращение к божеству-покровителю. Только если имени ещё нет.',
      parameters: {
        type: 'object',
        required: ['name'],
        properties: {
          name: {
            type: 'string',
            description: 'Имя или культовый титул обращения к покровителю',
          },
        },
      },
      handler: async ({ name }) => {
        const result = applyPatronName(domain, name, { world, allowReplace: false });
        if (result.error === 'too_short') {
          return toolFail(
            'too_short',
            'Имя покровителя слишком короткое. Передай нормальное имя или титул (от 2 символов).',
          );
        }
        if (result.error === 'locked') {
          return toolFail(
            'locked',
            `Имя уже дано: «${result.patronName}». Его нельзя сменить.`,
            { patronName: result.patronName },
          );
        }
        await save();
        return {
          ok: true,
          patronName: result.patronName,
          previous: result.previous,
          hint: `Дальше обращайся только так: «${result.patronName}».`,
        };
      },
    },
    {
      name: 'adjust_loyalty',
      description:
        'Изменить лояльность к покровителю (−25…+25). Милость, доверие, общая цель → вверх; насмешка, унижение слуги, бессмысленная жестокость → вниз.',
      parameters: {
        type: 'object',
        required: ['delta'],
        properties: {
          delta: { type: 'number', description: 'Обычно ±5…15 за заметный жест' },
          reason: { type: 'string' },
        },
      },
      handler: async ({ delta, reason }) => {
        const result = adjustAttitude(character, 'loyalty', delta);
        if (!result.ok) return result;
        await save();
        return {
          ...result,
          reason: reason || null,
          feel: formatRulerAttitudes(character, ctx.config),
        };
      },
    },
    {
      name: 'adjust_terror',
      description:
        'Изменить ужас/благоговение перед покровителем (−25…+25). Явление силы, угроза, чудо → вверх; панибратство, бессилие божества → вниз.',
      parameters: {
        type: 'object',
        required: ['delta'],
        properties: {
          delta: { type: 'number', description: 'Обычно ±5…15 за заметный жест' },
          reason: { type: 'string' },
        },
      },
      handler: async ({ delta, reason }) => {
        const result = adjustAttitude(character, 'terror', delta);
        if (!result.ok) return result;
        await save();
        return {
          ...result,
          reason: reason || null,
          feel: formatRulerAttitudes(character, ctx.config),
        };
      },
    },
    {
      name: 'consult_loremaster',
      description:
        'Справка о фактах мира: имена, места, устройство города, прошлое, уже установленный канон. ' +
        'Если вопрос про идущую историю — передай plotId этой нити: лормастер увидит её канон и сможет дописать детали, не ломая повествование. ' +
        'Закрытую или сыгранную нить не передавай — тогда он читает только хронику. ' +
        'Не расследование: то, что уже является тайной или предметом текущего выбора, он может оставить неизвестным.',
      parameters: {
        type: 'object',
        required: ['questions'],
        properties: {
          questions: {
            type: 'array',
            items: { type: 'string' },
            description: '1–5 конкретных вопросов',
          },
          plotId: {
            type: 'string',
            description:
              'id идущей истории или сопряжения. Только открытая нить: закрытую не передавай.',
          },
        },
      },
      handler: async ({ questions, plotId }) => {
        const result = await askLoremaster({
          config: ctx.config,
          runtime: ctx.runtime,
          storage,
          domain,
          questions: questions || [],
          asker: `ruler:${character.name}`,
          plotId: plotId || null,
          conflux: ctx.conflux || null,
          maxTurns: 4,
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
    ctx.conflux && ctx.partner && {
      name: 'consult_informant',
      description:
        'Спросить информатора о соседнем острове при сопряжении. Он знает только уже известные вам факты и честно говорит «неизвестно».',
      parameters: {
        type: 'object',
        required: ['questions'],
        properties: {
          questions: {
            type: 'array',
            items: { type: 'string' },
            description: '1–5 вопросов о соседнем городе',
          },
        },
      },
      handler: async ({ questions }) => {
        const result = await askInformant({
          config: ctx.config,
          runtime: ctx.runtime,
          conflux: ctx.conflux,
          viewer: domain,
          partner: ctx.partner,
          questions: questions || [],
        });
        const traces = leakedTracesForViewer(ctx.conflux, domain.id, [domain, ctx.partner]);
        const knownHit = (result.answers || []).some((a) => a && a.known);
        const freshOffers = [];
        if (knownHit) {
          for (const t of traces) {
            if (takeIntelOffer(ctx.conflux, domain.id, t.plotId || t.chronicleId)) {
              freshOffers.push(t);
            }
          }
        }
        if (freshOffers.length) await save();
        return {
          ok: true,
          answers: result.answers,
          summary: result.summary,
          leakedTraces: traces,
          hint:
            'Перескажи своими словами. Если informant сказал «неизвестно» — так и скажи покровителю. ' +
            'Предположение помечай как догадку, не как факт.' +
            (freshOffers.length
              ? ' Покровитель задел чужой след, сюжетной карточки ещё нет. ОДИН раз предложи узнать больше: declare_process с intel=true и chronicleId из leakedTraces. Не предлагай это каждый ход и не называй чужое дело по титулу.'
              : ''),
        };
      },
    },
    {
      name: 'declare_process',
      description:
        'Длительное дело: стройка, суд, поход, снабжение. Не для мгновенных постоянных приказов — declare_standing_order. ' +
        'Если воля ещё неясна — не вызывай, спроси покровителя (commitment=clarify). ' +
        'Срок сам не оценивай: его посчитает отдельный оценщик. ' +
        'Отказы: too_many_processes (все столпы заняты), officer_busy (названный столп уже ведёт другое). ' +
        'В речи — человеческая причина; предложи паузу или отмену текущего, не «доска» и не «слот».',
      parameters: {
        type: 'object',
        required: ['summary', 'detail', 'linkedStats'],
        properties: {
          summary: { type: 'string' },
          detail: {
            type: 'string',
            description:
              'Если покровитель задал жёсткий срок («в этом месяце») — отрази это в detail дословно по смыслу.',
          },
          goal: {
            type: 'string',
            description:
              'Одной фразой: что считается достигнутой целью дела (для исхода в хронике). Не обязательно.',
          },
          remainingMonths: {
            type: 'number',
            description:
              'Только если покровитель велел торопиться или не спешить: сколько месяцев ОСТАЛОСЬ ждать (не меньше 1). ' +
              'Сам срок не оценивай.',
          },
          expectedMonths: {
            type: 'number',
            description:
              'Устарело: то же, что remainingMonths — только воля покровителя к темпу, не твоя оценка.',
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
              'Должность столпа, если покровитель назвал конкретного (treasurer/marshal/keeper/chancellor). ' +
              'Пусто + randomOfficer — движок выберет случайного свободного.',
          },
          randomOfficer: {
            type: 'boolean',
            description: 'true, если покровитель сказал «разберитесь сами» / не назвал столпа.',
          },
          insistOffPortfolio: {
            type: 'boolean',
            description:
              'true только после спора: покровитель настаивает отправить не того столпа.',
          },
          onBehalfOf: { type: 'string', default: 'patron' },
          characterNote: { type: 'string' },
          plotId: {
            type: 'string',
            description:
              'id живой истории, которую покровитель этим делом пытается сдвинуть. ' +
              'Смотри на замысел из разговора, не на общее место и не на «единственную открытую» нить. ' +
              'Закрытую историю не подставляй: продолжение закрытого — пустой plotId, своё поручение. ' +
              'Если неясно, про какую беду речь или это вообще новое хозяйство — спроси (commitment=clarify), не гадай. ' +
              'Если приказ не про живую историю — оставь пустым, дело заведёт свою нить само.',
          },
          chronicleId: {
            type: 'string',
            description:
              'id просочившейся записи из leakedTraces[] или известной хроники соседа. ' +
              'Для intel=true, если карточки сюжета ещё нет — передай chronicleId вместо plotId.',
          },
          intel: {
            type: 'boolean',
            description:
              'true — целенаправленно разведать конкретный чужой сюжет (нужен plotId или chronicleId). ' +
              'Не для вмешательства и не для «пошлите шпионов на остров вообще».',
          },
        },
      },
      handler: async ({
        summary,
        detail,
        remainingMonths,
        expectedMonths,
        linkedStats,
        onBehalfOf = 'patron',
        characterNote,
        plotId,
        chronicleId,
        intel = false,
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
              'ОТКАЗ: все столпы заняты (' +
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
            monthsLeft: dup.monthsLeft,
            agentMessage:
              'ОТКАЗ: похожее дело уже идёт — «' +
              dup.summary +
              `» (id ${dup.id}, ещё ~${dup.monthsLeft} мес.). ` +
              'Это НЕ нехватка слотов и НЕ общая занятость города. ' +
              'Покровитель, скорее всего, уточняет его: вызови update_process с этим id, ' +
              'допиши новый вопрос (addDetail) и при нужде remainingMonths. commitment=process. ' +
              'Не выдумывай отговорку про «слишком много дел» и не обещай вторую такую же нить.',
          };
        }
        const hard = hasHardPatronDeadline(summary, detail);
        const linked = resolveLinkedStats(linkedStats, ctx.config);
        if (!linked.length) {
          return toolFail(
            'linked_stats_required',
            `linkedStats обязательны — ровно один id из: ${(ctx.config.stats || []).map((s) => s.id).join(', ')}. ` +
              'Это стат характера задачи, не должности столпа.',
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
              : 'Нет свободного столпа. Предложи паузу или отмену одного из идущих дел.',
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
        const askedRemaining =
          remainingMonths != null
            ? remainingMonths
            : expectedMonths != null
              ? expectedMonths
              : hard
                ? 1
                : null;
        const wantIntel = Boolean(intel);
        const partners = ctx.conflux && ctx.partner ? [domain, ctx.partner] : [domain];
        let targetPlot = null;
        if (plotId) {
          targetPlot =
            findPlotline(domain, String(plotId)) ||
            (ctx.conflux?.plotlines || []).find((p) => String(p.id) === String(plotId)) ||
            null;
        } else if (chronicleId && ctx.conflux) {
          targetPlot = findPlotByChronicleId(ctx.conflux, String(chronicleId), partners);
        }
        if (wantIntel) {
          if (!ctx.conflux) {
            return toolFail('intel_needs_conflux', 'Разведка конкретного сюжета только во время сопряжения.');
          }
          if (!targetPlot) {
            return toolFail(
              'intel_needs_target',
              'Для intel=true нужен plotId известной нити или chronicleId просочившейся записи.',
            );
          }
          if (isOrderPlot(targetPlot)) {
            return toolFail('intel_forbidden_order', 'Целенаправленная разведка указов запрещена.');
          }
          if (cityKnowsPlot(targetPlot, domain.id)) {
            return toolFail(
              'intel_already_known',
              'Эта история уже известна городу как линия. intel не нужен — заведи обычное дело, если вмешиваетесь.',
            );
          }
          const traces = leakedTracesForViewer(ctx.conflux, domain.id, partners);
          const heard =
            traces.some((t) => t.plotId === targetPlot.id) ||
            traces.some((t) => String(t.chronicleId) === String(chronicleId || '')) ||
            Boolean(chronicleId && findPlotByChronicleId(ctx.conflux, String(chronicleId), partners));
          if (!heard) {
            return toolFail(
              'plot_unknown',
              'Город не знает эту нить. Для разведки возьми chronicleId из leakedTraces.',
            );
          }
        }
        const action = {
          id: newId('act'),
          summary,
          detail,
          goal: String(goal || '').trim() || null,
          expectedMonths: 1,
          durationMonths: 1,
          monthsLeft: 1,
          monthsDone: 0,
          linkedStats: [linkedStat],
          officerId: officer.id,
          office: officer.office,
          offPortfolio: mismatch,
          onBehalfOf,
          characterId: character.id,
          characterName: character.name,
          characterNote: characterNote || null,
          hardDeadline: hard,
          status: 'active',
          initiative: 'patron',
          intel: wantIntel,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        domain.state.pendingActions.push(action);
        bindOfficerProcess(domain, officer, action);
        const estimated = await estimateProcessDuration({
          config: ctx.config,
          runtime: ctx.runtime,
          domain,
          summary,
          detail,
          log: ctx.log,
        });
        applyObjectiveSchedule(action, estimated.months, askedRemaining);
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
        let originPlot = null;
        let rehomed = false;
        if (plot && isThreeActPlot(plot) && !wantIntel) {
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
            originPlot = moved.originPlot;
            rehomed = moved.rehomed;
            action.plotlineId = plot?.id || null;
          }
        }
        if (ctx.conflux && plot && !isOrderPlot(plot) && !rehomed) {
          action.confluxId = ctx.conflux.id;
          action.ownerDomainId = domain.id;
          if (!wantIntel && !plotConcerns(plot, domain.id) && !plot.isMainConflux) {
            sharePlotWithDomain(plot, domain.id, {
              reason: 'process',
              conflux: ctx.conflux,
              domains: partners,
            });
          }
        }
        await save();
        const hint = rehomed
          ? unrelatedAttachHint(originPlot)
          : `В речи: принял повеление. ${paceHint(action)} ` +
            'Не говори «уже строим» и не рапортуй механику; итог придёт с новостями месяца, ' +
            'а не в этой переписке.' +
            queueAttachHint(domain, plot, action);
        return {
          ok: true,
          process: action,
          rehomed,
          hint,
        };
      },
    },
    {
      name: 'declare_standing_order',
      description:
        'Заявка на постоянный порядок / правило (запрет, осмотр, регулярный обряд, «при каждом сопряжении делайте X»). ' +
        'Карточку и каденс соберёт город к новостям месяца. Не для разовой стройки, суда, похода — те через declare_process. ' +
        'Если неясно, разовый это труд или всегдашнее правило — спроси (commitment=clarify), не выбирай сам. ' +
        'Срок (durationMonths) ставь только если покровитель его назвал; иначе бессрочно.',
      parameters: {
        type: 'object',
        required: ['text'],
        properties: {
          text: {
            type: 'string',
            description: 'Краткая формулировка постоянного порядка',
          },
          id: {
            type: 'string',
            description: 'Id существующего порядка при обновлении',
          },
          durationMonths: {
            type: 'number',
            description:
              'Сколько игровых месяцев порядок действует. Не передавай — бессрочно. ' +
              '0 — сделать бессрочным (при правке). Ставь число только если покровитель явно назвал срок ' +
              '(три месяца, год = 12, сезон = 3). Сам срок не выдумывай.',
          },
        },
      },
      handler: async ({ text, id, durationMonths }) => {
        const body = String(text || '').trim().slice(0, 400);
        if (body.length < 3) {
          return toolFail(
            'too_short',
            'Текст постоянного порядка слишком короткий. Сформулируй правило (≥3 символа) и вызови снова.',
          );
        }
        const queued = queueOrderRequest(domain, {
          action: id ? 'edit' : 'create',
          text: body,
          orderId: id || null,
          by: character.name,
          initiative: 'patron',
          tick: world?.tickIndex ?? null,
          durationMonths,
        });
        if (queued.error === 'order_not_found') {
          return {
            ok: false,
            error: 'order_not_found',
            standingOrders: listStandingOrders(domain),
            agentMessage:
              'Указ не найден. Возьми id из списка ниже и вызови declare_standing_order снова.\n' +
              (listStandingOrders(domain).map((m) => `- ${m.id}: ${m.text}`).join('\n') || '(указов нет)'),
          };
        }
        if (queued.error) {
          return toolFail(queued.error, queued.message || 'Не удалось принять порядок.');
        }
        await save();
        const term = queued.request?.durationMonths;
        const termHint =
          term
            ? `будут соблюдать ${term} мес., затем порядок сам спадёт. Срок в речи назови, механику нет. `
            : queued.request?.durationSet
              ? 'бессрочно, пока не отменят. Не назначай срок, если покровитель его не назвал. '
              : 'как постоянный порядок без срока, начнут соблюдать. Не назначай срок, если покровитель его не назвал. ';
        return {
          ok: true,
          created: Boolean(queued.created),
          request: queued.request,
          hint:
            `В речи: принял порядок — ${termHint}` +
            'Не говори «процесс». Последствия указа город увидит к концу месяца.',
        };
      },
    },
    {
      name: 'revoke_order',
      description:
        'Заявка отменить действующий указ / постоянный порядок. orderId — id из read_domain_brief.standingOrders или краткий смысл указа.',
      parameters: {
        type: 'object',
        required: ['orderId'],
        properties: {
          orderId: { type: 'string', description: 'Id (mod_… / ordreq_…) или ключевые слова указа' },
          reason: { type: 'string' },
        },
      },
      handler: async ({ orderId, reason }) => {
        const key = String(orderId || '').trim();
        if (!key) {
          return toolFail('order_required', 'Передай orderId указа из read_domain_brief.standingOrders.');
        }
        const queued = queueOrderRequest(domain, {
          action: 'revoke',
          orderId: key,
          text: key,
          reason,
          by: character.name,
          initiative: 'patron',
          tick: world?.tickIndex ?? null,
        });
        if (queued.error === 'order_not_found') {
          const list = listStandingOrders(domain);
          return {
            ok: false,
            error: 'order_not_found',
            standingOrders: list,
            agentMessage:
              'Указ не найден. Возьми id из списка ниже и вызови revoke_order снова. ' +
              'Не говори покровителю, что такого порядка нет, если список не пуст.\n' +
              (list.map((m) => `- ${m.id}: ${m.text}`).join('\n') || '(указов нет)'),
          };
        }
        if (queued.error) {
          return toolFail(queued.error, queued.message || 'Не удалось отменить порядок.');
        }
        await save();
        return {
          ok: true,
          cancelled: Boolean(queued.cancelled),
          request: queued.request,
          hint: queued.cancelled
            ? 'В речи: передумал, этот порядок так и не вступил. Коротко.'
            : 'В речи: порядок будет снят. Коротко, без механики. Город увидит это к концу месяца.',
        };
      },
    },
    {
      name: 'update_process',
      description:
        'Уточнить активное длительное дело. На нулевом месяце можно переписать целиком; ' +
        'если дело уже шло — только дополни поручение. processId — id или несколько слов из summary.',
      parameters: {
        type: 'object',
        required: ['processId'],
        properties: {
          processId: {
            type: 'string',
            description: 'Id процесса (act_…) или ключевые слова из summary',
          },
          summary: { type: 'string', description: 'На нулевом месяце заменяет название; иначе дописывается.' },
          detail: { type: 'string', description: 'На нулевом месяце заменяет поручение; иначе дописывается.' },
          goal: {
            type: 'string',
            description: 'Одной фразой: что считается достигнутой целью. Можно уточнить в любой месяц.',
          },
          addDetail: {
            type: 'string',
            description: 'Дополнить поручение новой оговоркой или вопросом, не затирая старое.',
          },
          remainingMonths: {
            type: 'number',
            description:
              'Сколько месяцев ещё ждать. Не меньше 1. Ставь, если покровитель велел торопиться или не спешить.',
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
        remainingMonths,
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
          { summary, detail, addDetail, remainingMonths, linkedStats, characterNote, goal },
          ctx.config,
        );
        if (revised.rewritten) {
          const estimated = await estimateProcessDuration({
            config: ctx.config,
            runtime: ctx.runtime,
            domain,
            summary: action.summary,
            detail: action.detail,
          });
          applyObjectiveSchedule(action, estimated.months, remainingMonths);
        }
        syncErrandFromProcess(domain, action);
        if (plotId) {
          const current = findPlotline(domain, action.plotlineId);
          const target = findPlotline(domain, String(plotId));
          if (current?.kind === 'errand' && target && isThreeActPlot(target)) {
            return toolFail(
              'retarget_needs_new_process',
              'Это поручение снято с истории. Не перевешивай его. revoke_process это дело, затем declare_process с уточнённой целью и plotId той нити.',
            );
          }
          unlinkProcessFromAllPlots(domain, action.id);
          const linked = linkProcessToPlotline(domain, action.id, String(plotId));
          if (linked) {
            action.plotlineId = linked.id;
          }
        }
        let plot = findPlotline(domain, action.plotlineId);
        let rehomed = false;
        let originPlot = null;
        if (
          plot &&
          isThreeActPlot(plot) &&
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
            originPlot = moved.originPlot;
            rehomed = moved.rehomed;
            action.plotlineId = plot?.id || action.plotlineId;
          }
        }
        await save();
        const mode = revised.fresh ? 'дело ещё не сдвинулось, можно было переписать' : 'дело уже шло, текст только дополнен';
        return {
          ok: true,
          process: action,
          rehomed,
          hint: rehomed
            ? unrelatedAttachHint(originPlot)
            : `${mode}. ${paceHint(action)} ` +
              'В речи не обещай, что уже сделано; итог придёт с новостями месяца.' +
              queueAttachHint(domain, plot, action),
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
        action.updatedAt = new Date().toISOString();
        releaseOfficerProcess(domain, action);
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
        'Поставить дело на паузу: прогресс не теряется, тик не идёт, слот освобождается. Не отмена.',
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
        await save();
        return {
          ok: true,
          pausedId: action.id,
          summary: action.summary,
          hint: 'Дело на паузе. В речи: работы остановили, к ним можно вернуться. Слот свободен.',
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
        await save();
        return {
          ok: true,
          resumedId: action.id,
          summary: action.summary,
          hint: 'Дело снова идёт. В речи без id.',
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
    {
      name: 'set_news_schedule',
      description:
        'Настроить письма о месяце покровителю. Движок сам решает, слать ли письмо. ' +
        'Сближение островов этими настройками не глушится.',
      parameters: {
        type: 'object',
        properties: {
          months: {
            type: 'array',
            items: { type: 'number' },
            description:
              'Месяцы года (1–12), в которые писать. Пустой массив — не писать по календарю. ' +
              '«Каждый месяц» — [1,2,3,4,5,6,7,8,9,10,11,12]. «В 1, 4 и 8» — [1,4,8].',
          },
          alsoOnCritical: {
            type: 'boolean',
            description:
              'Писать также, если в месяце есть хроника с важностью critical — даже если месяц не в списке.',
          },
          detail: {
            type: 'string',
            enum: ['full', 'brief', 'essence'],
            description: 'full — подробный отчёт; brief — выжимка; essence — супер-кратко, только суть.',
          },
          clickbait: { type: 'boolean', description: 'Кликбейтный зачин.' },
          ask: { type: 'boolean', description: 'Заканчивать вопросом, что делать.' },
        },
      },
      handler: async (args) => {
        const patch = {};
        if (args.months) patch.months = args.months;
        if (args.alsoOnCritical != null) patch.alsoOnCritical = args.alsoOnCritical;
        if (args.detail) patch.detail = args.detail;
        if (args.clickbait != null) patch.clickbait = args.clickbait;
        if (args.ask != null) patch.ask = args.ask;
        const schedule = setNewsSchedule(domain, patch);
        await save();
        return {
          ok: true,
          schedule,
          hint:
            'В речи: как теперь будешь писать о месяце. Не называй поля движка. ' +
            'Сближение островов всё равно доложишь, это не письмо месяца.',
        };
      },
    },
  ].filter(Boolean);
}

export class GameApp {
  constructor({ config, storage, runtime }) {
    this.config = config;
    this.storage = storage;
    this.runtime = runtime;
    this.outboundHandlers = new Set();
    this.generatingUsers = new Set();
    /** Пока обрабатывается сообщение пользователя — второй апдейт не стартует параллельный ход. */
    this.busyUsers = new Set();
    /** Текст прогресса генезиса (для Telegram edit и баннера /play). */
    this.generatingProgress = new Map();
    /** Пока идёт world tick — чат с доменом отвечает системно. */
    this.worldTicking = false;
  }

  beginWorldTick() {
    this.worldTicking = true;
  }

  endWorldTick() {
    this.worldTicking = false;
  }

  isWorldTicking() {
    return Boolean(this.worldTicking);
  }

  onOutbound(handler) {
    this.outboundHandlers.add(handler);
    return () => this.outboundHandlers.delete(handler);
  }

  async emitOutbound(userId, message, meta = {}) {
    const uid = String(userId);
    if (meta.kind === 'progress') this.generatingProgress.set(uid, message);
    if (meta.kind === 'game_start' || meta.kind === 'generating_error' || meta.kind === 'island_reveal') {
      this.generatingProgress.delete(uid);
    }
    for (const handler of this.outboundHandlers) {
      await handler({ userId: uid, message, ...meta });
    }
  }

  async getStatus() {
    const world = await this.storage.getWorld();
    const domains = await this.storage.listDomains();
    return {
      storage: this.storage.driver,
      world: {
        id: world.id,
        seasonKey: world.seasonKey || null,
        name: world.name,
        tickIndex: world.tickIndex,
        gameDate: world.gameDate,
        status: world.status || 'active',
        scheduler: world.scheduler || null,
      },
      domainCount: domains.length,
      tickIntervalHours: this.config.tick.intervalHours,
      worldTicking: this.isWorldTicking(),
      generatingCount: this.generatingUsers.size,
      telegram: {
        enabled: Boolean(this.config.telegram?.enabled),
      },
    };
  }

  isGenerating(userId) {
    return this.generatingUsers.has(String(userId));
  }

  async handleUserMessage(userId, text, { channel = 'web', bootstrap = false } = {}) {
    const uid = String(userId);
    const log = getLogger().child({ userId: uid, channel, scope: 'chat' });
    if (this.busyUsers.has(uid)) {
      log.info('chat.busy_turn');
      return {
        reply: ONBOARDING_BUSY_REPLY,
        agent: 'system',
        busy: true,
        generating: this.isGenerating(uid),
        domainId: null,
      };
    }
    this.busyUsers.add(uid);
    try {
      const world = await this.storage.getWorld();
      const domain = await this.storage.getDomainForUser(uid, world.id);

      log.info('chat.inbound', {
        bootstrap,
        text: truncate(text, 400),
        hasDomain: Boolean(domain),
        domainId: domain?.id || null,
        generating: this.isGenerating(uid),
        worldTicking: this.isWorldTicking(),
      });

      if (domain && this.isWorldTicking()) {
        const label = world.gameDate?.label || 'новый месяц';
        log.info('chat.busy_ticking');
        return {
          reply:
            `Сейчас идёт шаг времени (${label}). Правитель занят делами острова — ` +
            'напишет сам, когда месяц закроется. Твоё сообщение я увидел; повтори его после новостей, если нужно.',
          agent: 'system',
          generating: false,
          ticking: true,
          domainId: domain.id,
        };
      }

      if (!domain) {
        if (this.isGenerating(uid)) {
          log.info('chat.busy_generating');
          return {
            reply:
              'Остров ещё создаётся — обычно минута-две. Правитель напишет сам, как будет готов. Подожди немного.',
            agent: 'onboarding',
            generating: true,
            domainId: null,
          };
        }
        return await this.runOnboarding(uid, text, { channel, bootstrap, log });
      }

      try {
        return await this.runRuler(domain, text, { channel, log, world });
      } catch (err) {
        log.error('ruler.turn_failed', { error: err.message, stack: err.stack });
        return await this.persistRulerSystemFail(domain, text, { channel, log });
      }
    } finally {
      this.busyUsers.delete(uid);
    }
  }

  startDomainGeneration(userId, { channel, forcedName, forcedPatronName, frozenConcept, axes, playerDirectives, playerBrief }) {
    const uid = String(userId);
    if (this.generatingUsers.has(uid)) {
      getLogger().warn('genesis.already_running', { userId: uid });
      return;
    }
    this.generatingUsers.add(uid);
    const log = getLogger().child({ userId: uid, scope: 'genesis' });

    const run = async () => {
      try {
        log.info('genesis.start', {
          forcedName: forcedName || null,
          forcedPatronName: forcedPatronName || null,
          concept: frozenConcept?.name || null,
          playerBrief: truncate(playerBrief, 500),
        });
        const tutorial = genesisTutorialText(this.config);
        if (tutorial) {
          await this.emitOutbound(uid, tutorial, {
            channel,
            agent: 'onboarding',
            kind: 'genesis_tutorial',
          });
        }
        if (forcedName) {
          const occupied = await this.occupiedCityNames(uid);
          const taken = validateCityNameAvailable(forcedName, occupied);
          if (!taken.ok) throw new Error(taken.reason);
        }
        const total = 5;
        const pushProgress = async (step, label) => {
          const text = formatProgressBar(step, total, label);
          log.info('genesis.progress', { step, total, label });
          await this.emitOutbound(uid, text, {
            channel,
            agent: 'onboarding',
            kind: 'progress',
            edit: 'genesis',
          });
        };

        await pushProgress(0, 'начинаю…');

        const domain = await generateDomain({
          config: this.config,
          runtime: this.runtime,
          storage: this.storage,
          ownerUserId: uid,
          channel,
          forcedName: forcedName || null,
          forcedPatronName: forcedPatronName || null,
          frozenConcept,
          axes,
          playerDirectives,
          playerBrief: playerBrief || null,
          log,
          onProgress: async (msg) => {
            const label = String(msg || '').trim();
            let step = 2;
            if (/ядро/i.test(label)) step = 1;
            else if (/описание|аспект/i.test(label)) step = 2;
            else if (/сил|столп/i.test(label)) step = 3;
            else if (/истори/i.test(label)) step = 3;
            else if (/собран|готов/i.test(label)) step = 3;
            await pushProgress(step, label);
          },
        });

        const intro = domain._greeting.startsWith(domain.characters[0].name)
          ? domain._greeting
          : `${domain.characters[0].name}: ${domain._greeting}`;

        await pushProgress(4, 'рисую вид острова…');
        generateOfficerPortraits({
          config: this.config,
          domain,
          log,
        })
          .then(async () => {
            await this.storage.saveDomain(domain);
          })
          .catch((err) => {
            log.warn('officer_portraits.failed', { error: String(err?.message || err) });
          });
        const picture = await generateIslandImage({
          config: this.config,
          domain,
          runtime: this.runtime,
          playerBrief: playerBrief || domain.playerBrief || null,
          log,
        });
        if (picture?.path) {
          domain.imagePath = picture.path;
          if (picture.base64) domain.imageBase64 = picture.base64;
          await this.storage.saveDomain(domain);
        }

        await pushProgress(5, 'остров готов');
        const reveal = formatIslandReveal(domain);
        await this.persistDialog(domain, 'assistant', reveal, { kind: 'island_reveal' });
        await this.emitOutbound(uid, reveal, {
          channel,
          agent: 'onboarding',
          domainId: domain.id,
          kind: 'island_reveal',
          photoPath: picture?.abs || null,
        });
        const dateNote = genesisDateMessage(await this.storage.getWorld());
        await this.persistDialog(domain, 'assistant', dateNote, { kind: 'game_date' });
        await this.emitOutbound(uid, dateNote, {
          channel,
          agent: 'onboarding',
          domainId: domain.id,
          kind: 'game_date',
        });
        await this.persistDialog(domain, 'assistant', intro);
        await this.emitOutbound(uid, intro, {
          channel,
          agent: 'ruler',
          domainId: domain.id,
          kind: 'game_start',
        });
        log.info('genesis.done', {
          domainId: domain.id,
          name: domain.name,
          greetingPreview: truncate(intro, 300),
          imagePath: domain.imagePath || null,
        });
      } catch (err) {
        log.error('genesis.failed', {
          error: err.message,
          stack: err.stack,
        });
        await this.emitOutbound(
          uid,
          `Не удалось создать остров: ${err.message || err}. Можно поправить имя или концепт и снова попросить старт.`,
          { channel, agent: 'onboarding', kind: 'generating_error', edit: 'genesis' },
        );
      } finally {
        this.generatingUsers.delete(uid);
      }
    };

    setImmediate(() => {
      run().catch((err) =>
        log.error('genesis.unhandled', { error: err.message, stack: err.stack }),
      );
    });
  }

  async getOrCreateOnboardingBinding(userId) {
    const world = await this.storage.getWorld();
    let binding = await this.storage.getUserBinding(userId);
    if (!binding || binding.worldId !== world.id) {
      binding = {
        userId: String(userId),
        worldId: world.id,
        domainId: null,
        onboarding: emptyOnboardingDraft(),
        createdAt: new Date().toISOString(),
      };
    }
    if (!binding.onboarding) binding.onboarding = emptyOnboardingDraft();
    binding.onboarding = normalizeOnboardingDraft(binding.onboarding);
    return binding;
  }

  async runOnboarding(userId, text, { channel, bootstrap = false, log: parentLog } = {}) {
    const log = (parentLog || getLogger()).child({ scope: 'onboarding' });
    const binding = await this.getOrCreateOnboardingBinding(userId);
    const draft = binding.onboarding;
    let startedGenerating = false;
    const occupiedByKey = await this.occupiedCityNames(userId);

    const rawUser = String(text || '').trim();
    let takenAttempt = null;
    if (!bootstrap && rawUser) {
      maybeSwitchToDossier(draft, rawUser);
      const proposed = extractUserCityName(rawUser);
      if (proposed && isCityNameOccupied(proposed, occupiedByKey)) {
        takenAttempt = proposed;
      } else {
        applyUserNamedCity(draft, rawUser, occupiedByKey);
      }
      applyUserNamedPatron(draft, rawUser);
    }
    draft.phase = deriveOnboardingPhase(draft, { generating: this.isGenerating(userId) });

    log.info('onboarding.turn', {
      bootstrap,
      historyLen: (draft.messages || []).length,
      cityName: draft.cityName,
      approved: draft.cityNameApproved,
      pitchedName: draft.pitchedName,
      mode: draft.mode,
      phase: draft.phase,
      tags: Object.keys(draft.axes || {}).length,
    });

    const saveDraft = async () => {
      binding.onboarding = draft;
      binding.channel = channel || binding.channel || null;
      binding.updatedAt = new Date().toISOString();
      await this.storage.saveUserBinding(binding);
    };

    const startFlag = { started: false };
    const tools = buildOnboardingTools({
      app: this,
      draft,
      userId,
      channel,
      text,
      saveDraft,
      startFlag,
    });
    const markStarted = () => {
      if (startFlag.started) startedGenerating = true;
    };

    const history = (draft.messages || []).slice(-ONBOARDING_HISTORY_MESSAGES).map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content,
    }));

    const isIntroPitch =
      history.length === 0 &&
      (bootstrap || !String(text || '').trim() || String(text || '').trim().length < 80);
    const userContent = bootstrap || !String(text || '').trim()
      ? '[Игрок только что открыл чат. Это первый контакт — нужна вступительная речь.]'
      : text;

    const extraSystem = [
      isIntroPitch
        ? [
            'ПЕРВЫЙ КОНТАКТ — только речь, без tools (кроме set_onboarding_mode после явного выбора — можно отложить).',
            'Расскажи: игрок — бог-покровитель; город-государство на изолированном летающем острове;',
            'правитель — НПС-связной; дальше диалог с ним; месяц сдвигает мир.',
            'Предложи пути (своими словами, без нумерации 1.2.3.):',
            'быстрый город — всё само; описание любой длины — собираем заготовку, по пробелам спрашиваем;',
            'анкета — вопросы по осям, в конце можно добавить изюминку.',
            'Не вызывай start_new_game и не семплируй оси в питче.',
          ].join(' ')
        : formatOnboardingStatusCard(draft, this.config, {
            generating: this.isGenerating(userId),
            occupiedByKey,
          }),
      takenAttempt
        ? `\nИгрок назвал «${takenAttempt}», но оно уже занято. Скажи, что имя занято, и предложи или спроси другое. Чужие города не перечисляй.`
        : '',
    ].join('\n');
    const result = await this.runtime.run({
      agentId: 'onboarding',
      userMessages: [...history, { role: 'user', content: userContent }],
      tools,
      extraSystem,
      log,
      scene: 'onboarding',
    });
    if (startFlag.started) startedGenerating = true;

    // Страховка: агент сказал «записал», но не вызвал tools.
    const usedTools = new Set((result.toolTrace || []).map((t) => t.name));
    const userSaidSomething =
      !bootstrap && String(text || '').trim().length >= 8 && !/^\[Игрок/.test(String(text));
    const chunk = String(text || '').trim();
    if (userSaidSomething && !usedTools.has('set_player_brief') && !usedTools.has('start_new_game')) {
      const looksLikeNameOnly =
        draft.cityNameApproved ||
        /^(давай|ок|хорошо|ладно|этот|выбираю|создавай|начинаем|готов)\b/i.test(chunk) ||
        (chunk.length < 40 && /^[\p{L}\p{M}\d\s\-']+$/u.test(chunk));
      if (!looksLikeNameOnly && chunk.length < LONG_USER_MESSAGE_MIN) {
        if (!draft.playerBrief) draft.playerBrief = { city: '', ruler: '', freeform: '' };
        const prev = draft.playerBrief.freeform || '';
        if (!prev.includes(chunk.slice(0, 40))) {
          draft.playerBrief.freeform = prev ? `${prev}\n${chunk}` : chunk;
          clipOnboardingBrief(draft.playerBrief);
        }
      }
      rememberLongUserBrief(draft, chunk, { usedBriefTool: usedTools.has('set_player_brief') });
    }

    let reply = result.text;
    const rawReply = String(reply || '');
    if (startedGenerating && !rawReply.trim()) {
      reply = formatOnboardingStartReply(draft.cityName);
    }

    const auto = planOnboardingAutoStart({
      userText: text,
      reply,
      draft,
      usedStart: usedTools.has('start_new_game'),
      generating: this.isGenerating(userId),
      occupiedByKey,
    });
    if (auto.start) {
      draft.cityName = auto.name;
      draft.cityNameApproved = true;
      draft.pitchedName = auto.name;
      draft.pitched = true;
      if (draft.concept?.status === 'READY') draft.concept.name = auto.name;
      log.warn('onboarding.auto_start_new_game', {
        cityName: draft.cityName,
        patronName: draft.patronName,
        reason: auto.reason,
      });
      this.startDomainGeneration(userId, {
        channel,
        forcedName: draft.cityName,
        forcedPatronName: draft.patronName,
        frozenConcept: draft.concept,
        axes: draft.axes,
        playerDirectives: draft.playerDirectives,
        playerBrief: { ...(draft.playerBrief || {}) },
      });
      startedGenerating = true;
      reply = formatOnboardingStartReply(draft.cityName);
    } else if (auto.stripFalseStart) {
      log.warn('onboarding.false_start_claim', {
        reason: auto.reason,
        replyPreview: truncate(rawReply, 400),
      });
      reply = ONBOARDING_NEED_NAME_NOTE;
    } else if (auto.appendNeedName) {
      log.warn('onboarding.false_start_claim', {
        reason: auto.reason,
        keptReply: true,
        replyPreview: truncate(rawReply, 400),
      });
      reply = appendNeedNameNote(rawReply);
    } else if (auto.appendNeedPatron) {
      log.warn('onboarding.need_patron', {
        reason: auto.reason,
        cityName: auto.name,
      });
      if (auto.name) {
        draft.cityName = auto.name;
        draft.cityNameApproved = true;
        draft.pitchedName = auto.name;
        draft.pitched = true;
      }
      reply = appendNeedPatronNote(rawReply);
    } else if (auto.appendNameTaken) {
      log.warn('onboarding.name_taken', {
        reason: auto.reason,
        takenName: auto.takenName,
      });
      if (draft.cityName && isCityNameOccupied(draft.cityName, occupiedByKey)) {
        draft.cityNameApproved = false;
      }
      if (draft.pitchedName && isCityNameOccupied(draft.pitchedName, occupiedByKey)) {
        draft.pitchedName = null;
        draft.pitched = false;
      }
      reply = appendNameTakenNote(rawReply, auto.takenName);
    }

    // Нельзя говорить «уже создан», пока генезис только стартовал.
    if (startedGenerating || this.isGenerating(userId)) {
      if (claimsOnboardingAlreadyCreated(reply) || !String(reply || '').trim()) {
        reply = formatOnboardingStartReply(draft.cityName);
      }
    }

    draft.messages = draft.messages || [];
    if (!bootstrap || String(text || '').trim()) {
      draft.messages.push({ role: 'user', content: text || userContent, at: new Date().toISOString() });
    }
    draft.messages.push({ role: 'assistant', content: reply, at: new Date().toISOString() });
    if (draft.messages.length > 40) draft.messages = draft.messages.slice(-30);
    const nameInReply = extractPitchedCityName(reply);
    if (nameInReply && !draft.cityNameApproved) {
      draft.pitchedName = nameInReply;
      draft.pitched = true;
    }
    draft.phase = deriveOnboardingPhase(draft, {
      generating: startedGenerating || this.isGenerating(userId),
    });
    await saveDraft();

    log.info('onboarding.reply', {
      generating: startedGenerating || this.isGenerating(userId),
      replyPreview: truncate(reply, 400),
      tools: (result.toolTrace || []).map((t) => ({
        name: t.name,
        ok: t.result?.ok !== false,
        error: t.result?.error || t.result?.reason,
      })),
      setup: {
        cityName: draft.cityName,
        cityNameApproved: draft.cityNameApproved,
        concept: draft.concept?.name || null,
      },
    });

    return {
      reply,
      domainId: null,
      agent: 'onboarding',
      created: false,
      generating: startedGenerating || this.isGenerating(userId),
      setup: {
        cityName: draft.cityName,
        cityNameApproved: draft.cityNameApproved,
        concept: draft.concept?.name || null,
        playerBrief: draft.playerBrief,
      },
      toolTrace: result.toolTrace,
    };
  }

  /**
   * Канон текущей стыковки для речи правителя: сосед реальный, его имя можно называть.
   * Без этого блока safety-контракт заставляет правителя отмалчиваться про чужой остров.
   */
  async buildConfluxCanon(domain, world) {
    let list = [];
    try {
      list = await this.storage.listConfluxes({ status: ['approaching', 'docked'] });
    } catch {
      return '';
    }
    const conflux = list.find((c) => (c.domainIds || []).includes(domain.id));
    if (!conflux) return '';

    const partnerId = (conflux.domainIds || []).find((id) => id !== domain.id);
    let partnerName = 'чужой остров';
    if (partnerId) {
      const partner = await this.storage.getDomain(partnerId).catch(() => null);
      if (partner?.name) partnerName = `«${partner.name}»`;
    }

    if (conflux.status === 'approaching') {
      const left = monthsUntilDock(conflux, world);
      return [
        'КАНОН СОПРЯЖЕНИЯ (реальность, не слух — говори об этом открыто и по имени):',
        `К острову приближается чужой летающий остров — город ${partnerName}.`,
        `До сопряжения примерно ${left} мес. Событие неизбежно, это крупнейшая новость города.`,
        conflux.rematch
          ? 'Это ПОВТОРНОЕ сопряжение: острова уже сходились раньше, город это помнит.'
          : 'Такого сближения город прежде не знал (с этим соседом).',
        'Если покровитель спрашивает про чужой остров — отвечай прямо: имя, срок, что это значит.',
        'Факты внутренней жизни соседа — только через consult_informant, не через лормастера.',
        'ЗАПРЕЩЕНО говорить «не готов называть имя», «лишь слухи», «не знаю о чужих островах».',
        'Этот канон СИЛЬНЕЕ ответов лормастера: если он скажет «не подтверждено» — верь канону.',
      ]
        .filter(Boolean)
        .join('\n');
    }

    const contact = conflux.contact ? formatContactForPrompt(conflux.contact) : '';
    return [
      'КАНОН СОПРЯЖЕНИЯ (идёт СЕЙЧАС — говори открыто и по имени):',
      `Остров в сопряжении с чужим островом — городом ${partnerName}.`,
      contact,
      `Сопряжение длится ${conflux.monthsDocked || 0} мес. из ожидаемых ${conflux.durationMonths || '?'}.`,
      conflux.rematch ? 'Это повторное сопряжение с этим соседом.' : '',
      'ЗАПРЕЩЕНО отрицать существование соседа или отказываться называть его имя.',
      'Факты внутренней жизни соседа — только через consult_informant.',
    ]
      .filter(Boolean)
      .join('\n');
  }

  async runRuler(domain, text, { channel, log: parentLog, world: worldArg = null }) {
    const log = (parentLog || getLogger()).child({
      scope: 'ruler',
      domainId: domain.id,
      domainName: domain.name,
    });
    const world = worldArg || (await this.storage.getWorld());
    log.info('ruler.turn', { text: truncate(text, 400) });
    normalizeDomain(domain);
    const conflux = await findActiveConfluxForDomain(this.storage, domain.id);
    let partner = null;
    if (conflux) {
      const partnerId = (conflux.domainIds || []).find((id) => id !== domain.id);
      if (partnerId) partner = await this.storage.getDomain(partnerId);
      hydrateDomainFromConflux(domain, conflux, { mode: 'ruler' });
    }
    const character = domain.characters[0];
    normalizeRulerAttitudes(character);
    const history = dialogHistoryForPrompt(character.dialogHistory || [], this.config);

    const conditionFeel = qualitativeStatsBrief(domain.stats || {}, this.config);
    const attitudes = formatRulerAttitudes(character, this.config);
    const patronName = domain.state?.patronName || null;
    const patronLine = patronName
      ? `Имя покровителя: «${patronName}» — обращайся только так. Не предлагай другое и не вызывай set_patron_name.`
      : 'Имя покровителя ещё не названо.';
    const undock = recentUndockFact(domain);
    const undockCanon = undock
      ? [
          'КАНОН НЕДАВНЕЙ РАССТЫКОВКИ:',
          undock.text,
          'Чужой остров ушёл в небо; перехода нет, потому что края разъехались.',
        ].join('\n')
      : '';
    const confluxCanon = await this.buildConfluxCanon(domain, world);
    const plotBrief = formatBoardForSpeech(domain, {
      statsFeel: (ids) => statEpithetsShort(domain.stats || {}, this.config, ids),
      viewerId: domain.id,
    });

    const askNow = shouldRulerAskPatron(domain, world);
    const newsSched = newsScheduleOf(domain);
    const newsMonths =
      newsSched.months.length === 12
        ? 'каждый месяц'
        : newsSched.months.length
          ? `в месяцы ${newsSched.months.join(', ')}`
          : 'не по календарю';

    // Здесь только данные хода. Правила поведения живут в instructions агента.
    const extraSystem = [
      formatRulerVoiceForPrompt(domain, { writable: true }),
      world?.gameDate?.label ? `ДАТА СЕЙЧАС: ${world.gameDate.label}.` : '',
      patronLine,
      confluxCanon,
      undockCanon,
      `Письма о месяце (движок шлёт сам): ${newsMonths}` +
        `${newsSched.alsoOnCritical ? '; также если случится совсем важное' : ''}. ` +
        'Покровитель просит иначе — set_news_schedule. Сближение островов не глуши.',
      askNow
        ? 'В ЭТОЙ реплике задай покровителю один короткий живой вопрос: о его воле, о страхе за нынешнее или о том, как жить. Не лекцию и не каждый раз — сейчас как раз тот случай.'
        : '',
      'ОБСТОЯТЕЛЬСТВА ГОРОДА (внутренняя правда):',
      `Население: ${qualitativePopulation(domain.population || 0)}`,
      conditionFeel,
      'ОТНОШЕНИЕ К ПОКРОВИТЕЛЮ (внутренняя правда):',
      attitudes,
      plotBrief
        ? [
            'ЖИВЫЕ НИТИ СЮЖЕТА (внутренняя правда; вплетай в речь, не рапортуй списком):',
            plotBrief,
            'id нити — только в инструменты (plotId). В речи не называй историю заголовком и не бери название в кавычки: говори о месте, людях и случившемся. Не говори «доска» и «карточка».',
            'Каждая нить сама по себе. Общее место или общие люди не делают их одним делом.',
            'plotId вешай на ту живую историю, которую покровитель этим делом пытается сдвинуть — читай замысел из разговора, не «единственную открытую» карточку. Закрытую нить не подставляй: продолжение закрытого — новое поручение без plotId.',
            'Если неясно, про какую беду приказ или это отдельное хозяйство — спроси (commitment=clarify), не гадай id. Лучше спросить до приказа, чем потом снимать дело с истории.',
            'Приказ по истории без поручения — новое дело с plotId этой истории, не правка соседнего.',
            conflux
              ? 'Чужой след без карточки — не история. Если покровитель хочет знать, что это, intel=true с chronicleId. Вмешательство в уже раскрытую чужую нить — обычное дело с plotId.'
              : '',
          ]
            .filter(Boolean)
            .join('\n')
        : '',
      `Известные люди города:\n${formatCastForPrompt(domain.lore, { limit: 16 })}`,
      formatOfficersForPrompt(domain, this.config),
      firstMentionHintForSpeech(),
      conflux
        ? [
            'ИНФОРМАТОР: факты и хроника соседнего острова — только через consult_informant.',
            'Он не выдумывает: если не знает, так и скажи покровителю. Ломастер про соседа не спрашивай.',
          ].join(' ')
        : '',
    ]
      .filter(Boolean)
      .join('\n');

    const turn = { okTools: new Set(), reply: null, meta: null };
    const baseTools = characterTools(domain, this.storage, character, {
      config: this.config,
      runtime: this.runtime,
      world,
      conflux,
      partner,
      log,
    });
    const tools = [
      ...baseTools.map((tool) => ({
        ...tool,
        handler: async (...args) => {
          const res = await tool.handler(...args);
          if (res && res.ok !== false) turn.okTools.add(tool.name);
          return res;
        },
      })),
      submitReplyTool(turn, character),
    ];

    const holdMs = Number(this.config.agents?.ruler?.holdAfterMs);
    const holdDelay = Number.isFinite(holdMs) && holdMs > 0 ? holdMs : 10_000;
    const holdTimer = setTimeout(() => {
      const line = rulerHoldLine(this.config, character);
      if (!line) return;
      void this.emitOutbound(domain.ownerUserId, line, {
        channel,
        kind: 'ruler_hold',
        domainId: domain.id,
      }).catch((err) => log.warn('ruler.hold_failed', { error: err.message }));
    }, holdDelay);

    try {
      const deadlineAt = Date.now() + (Number(this.config.agents?.ruler?.turnBudgetMs) || 120_000);
      let result = { text: '', toolTrace: [] };
      try {
        result = await this.runtime.run({
          agentId: 'ruler',
          userMessages: [...history, { role: 'user', content: text }],
          tools,
          extraSystem,
          maxTurns: 10,
          log,
          scene: 'ruler',
          domainId: domain.id,
          deadlineAt,
        });

        if (!turn.reply && Date.now() < deadlineAt - 5000) {
          log.warn('ruler.no_submit_reply', { preview: truncate(result.text, 200) });
          await this.runtime.run({
            agentId: 'ruler',
            userMessages: [
              ...history,
              { role: 'user', content: text },
              {
                role: 'user',
                content:
                  'Ответ не принят: речь передаётся только через submit_reply. Вызови его сейчас. ' +
                  'Если дела ты не заводил — commitment=none (или refused, если отговариваешь; ' +
                  'clarify — если приказ есть, но нужно уточнить волю), ' +
                  'и в речи не обещай долгих работ.',
              },
            ],
            tools,
            maxTurns: 4,
            toolChoice: { type: 'function', function: { name: 'submit_reply' } },
            extraSystem,
            log,
            scene: 'ruler_submit_retry',
            domainId: domain.id,
            deadlineAt,
          });
        } else if (!turn.reply) {
          log.warn('ruler.no_submit_reply', { preview: truncate(result.text, 200) });
        }
      } catch (err) {
        log.error('ruler.llm_failed', { error: err.message });
      }

      let reply = turn.reply || result.text || '';
      if (!String(reply).trim() || looksLikeToolDump(reply)) {
        log.warn('ruler.reply_unusable', { preview: truncate(reply, 200) });
        return await this.persistRulerSystemFail(domain, text, { channel, log });
      }
      reply = stripSpeakerPrefix(reply, character.name);

      const fresh = await this.storage.getDomain(domain.id);
      const plotCfg = plotConfig(this.config);
      const warmed = warmPlotlines(fresh, turn.meta?.touchedPlotIds || [], plotCfg);
      let warmedConflux = [];
      const liveConflux = conflux
        ? (await this.storage.getConflux(conflux.id)) || conflux
        : null;
      if (liveConflux) {
        warmedConflux = warmPlotlines(liveConflux, turn.meta?.touchedPlotIds || [], plotCfg);
        if (warmedConflux.length) await this.storage.saveConflux(liveConflux);
      }
      if (turn.meta?.dayNote) {
        fresh.state.monthLog = Array.isArray(fresh.state.monthLog) ? fresh.state.monthLog : [];
        fresh.state.monthLog.push({
          tick: world?.tickIndex ?? null,
          at: new Date().toISOString(),
          text: turn.meta.dayNote,
          plotIds: turn.meta.touchedPlotIds || [],
        });
        if (fresh.state.monthLog.length > 12) {
          fresh.state.monthLog = fresh.state.monthLog.slice(-12);
        }
      }
      if (askNow) markRulerAsked(fresh, world);
      await this.persistDialog(fresh, 'user', text);
      await this.persistDialog(fresh, 'assistant', reply, { meta: turn.meta });

      log.info('ruler.reply', {
        replyPreview: truncate(reply, 400),
        touchedPlots: [...warmed, ...warmedConflux].map((w) => `${w.id}:${w.from}→${w.to}`),
        dayNote: turn.meta?.dayNote || null,
        requestKind: turn.meta?.requestKind || null,
        commitment: turn.meta?.commitment || null,
        tools: (result.toolTrace || []).map((t) => ({
          name: t.name,
          ok: t.result?.ok !== false,
        })),
      });

      return {
        reply,
        domainId: fresh.id,
        agent: 'ruler',
        turnMeta: turn.meta,
        toolTrace: result.toolTrace,
        channel,
      };
    } finally {
      clearTimeout(holdTimer);
    }
  }

  async narrateTickNews(domain, chronicleAdds, gameDate, opts = {}) {
    const character = domain.characters[0];
    const forNews = filterChronicleForDomain(
      newsChronicleEntries(chronicleAdds),
      domain.id,
    );
    if (!character) {
      return forNews.map((c) => c.text).join('\n');
    }
    if (!forNews.length) {
      return 'Покровитель, месяц прошёл тихо — рассказывать почти нечего.';
    }

    // Дела соседа — не новости города: их можно упомянуть слухом, но не отчитываться о них.
    const isForeign = (c) => {
      const ids = Array.isArray(c.concernsDomainIds) ? c.concernsDomainIds.map(String) : [];
      return ids.length > 0 && !ids.includes(String(domain.id));
    };
    const mine = forNews.filter((c) => !isForeign(c));
    const foreign = forNews.filter(isForeign);
    const quietOnly = mine.length > 0 && mine.every((c) => c.author === 'storyteller:quiet');
    const schedule = newsScheduleOf(domain);
    const styleHint = tickNewsStyleHint(schedule);

    const named = peopleNamedInTexts(
      domain.lore,
      (mine.length ? mine : forNews).map((c) => c.text),
    );
    const peopleHint = named.length
      ? [
          'ЛЮДИ ЭТОГО МЕСЯЦА (первое имя в письме — с должностью, покровитель их не помнит наизусть):',
          ...named.map((c) => {
            const bits = [c.name, Number.isFinite(Number(c.ageYears)) ? `${c.ageYears} лет` : null, c.role, c.about]
              .filter(Boolean);
            return `- ${bits.join(', ')}`;
          }),
        ].join('\n')
      : '';
    const facts = (mine.length ? mine : forNews)
      .map((c) => `- [${c.importance || 'event'}] ${formatChronicleScope(c)}${c.text}${formatChroniclePriestMark(c)}`)
      .join('\n');
    const foreignBlock = foreign.length
      ? [
          'ЧУЖОЙ ГОРОД (это НЕ новости твоего города):',
          ...foreign.map((c) => `- ${formatChronicleScope(c)}${c.text}${formatChroniclePriestMark(c)}`),
        ].join('\n')
      : '';
    const patronName = domain.state?.patronName || null;
    const addressHint = patronName
      ? `Обращайся к покровителю как «${patronName}». Не подменяй чужим именем бога.`
      : 'Имя покровителя неизвестно — обратись «покровитель», без выдуманных имён.';

    const scopeHint = foreign.length
      ? [
          'Пиши о своём городе.',
          'О соседнем — только если там произошло действительно важное: угроза, разрыв, общая беда, крупный переворот, то, что нельзя не заметить с вашего берега.',
          'Чужие рутинные дела, мелкие поручения и быт соседа не пересказывай и не разбирай подробно.',
        ].join(' ')
      : '';

    // Эмоциональный регистр письма: тяжесть месяца + отношение к покровителю.
    const worstDrop = forNews.reduce((min, c) => {
      if (!c.statChanges) return min;
      for (const v of Object.values(c.statChanges)) {
        const delta = Number(v?.to) - Number(v?.from);
        if (Number.isFinite(delta) && delta < min) min = delta;
      }
      return min;
    }, 0);
    const hasCritical = mine.some((c) => c.importance === 'critical');
    const loyalty = Number(character.loyalty ?? 50);
    const terror = Number(character.terror ?? 50);
    const moodHint = [
      hasCritical || worstDrop <= -6
        ? 'Месяц тяжёлый: пиши тяжело, без утешительных формул и сглаживания.'
        : 'Месяц без катастроф: тон спокойнее, но не безразличный.',
      loyalty >= 70
        ? 'Ты преданно любишь покровителя — пиши теплее и откровеннее, можно личное признание.'
        : loyalty <= 30
          ? 'Ты разочарован в покровителе — суше, с горечью, без лести.'
          : '',
      terror >= 70
        ? 'Ты боишься его гнева — осторожность, оглядка, страх сказать лишнее.'
        : terror <= 25
          ? 'Ты почти не трепещешь — говоришь прямее, местами устало.'
          : '',
      'Смени зачин: не начинай так же, как в прошлых письмах.',
    ]
      .filter(Boolean)
      .join(' ');

    // С третьего тихого письма — один раз спросить, куда делся покровитель.
    const presence = shouldAskPatronPresence(domain, this.config);
    const unanswered = presence.silent;
    const askPresence = presence.ok;
    const stewardActs = (opts.stewardActs || []).filter((a) => a && a.kind && a.kind !== 'none');
    const stewardHint = stewardActs.length
      ? [
          'В этом месяце, пока покровитель молчал, действовал столп — не ты сам. Назови его должность и имя.',
          ...stewardActs.map((a) =>
            a.kind === 'process'
              ? `- ${a.office ? `${a.office} ` : ''}${a.officerName || ''} взялся за дело: ${a.summary}`
              : `- ${a.kind}: ${a.summary || a.text || ''}`,
          ),
          'Не приписывай решение себе. Жрец только передаёт, что столп распорядился.',
        ].join('\n')
      : '';
    const silenceAngles = [
      'спроси, слышит ли он тебя ещё',
      'скажи, что люди спрашивают, не отвернулся ли покровитель, и ты не знаешь, что отвечать',
      'скажи, что вёл уже начатые дела и ждал его голоса',
      'скажи, что оставил у алтаря знак и ждёшь ответа',
      'обмолвись, что давно не слышал его голоса, и вернись к делам',
    ];
    const presenceHint = askPresence
      ? [
          `ОБЯЗАТЕЛЬНО: покровитель молчит ${unanswered} месяца подряд. Ты его теряешь.`,
          `В конце письма отдельной фразой-вопросом: ${
            silenceAngles[Math.floor(Math.random() * silenceAngles.length)]
          }.`,
          'Нужен именно вопрос к нему (со знаком вопроса), своими словами. Без истерики, 1–2 предложения.',
        ].join(' ')
      : '';

    // Записи про стыковку (сближение/стык) — главная нить письма, если они есть.
    const confluxAdds = forNews.filter((c) => (c.tags || []).includes('conflux'));
    const confluxLead = confluxAdds.length && !opts.undock
      ? [
          'ГЛАВНОЕ СОБЫТИЕ МЕСЯЦА — чужой летающий остров (сближение или сопряжение).',
          'Начни письмо с него и говори прямо: назови город соседа, срок или характер сопряжения.',
          'Это не примета и не слух — покровитель должен понять масштаб.',
          'Прочие дела — коротко, после.',
        ].join(' ')
      : '';

    const seedAdds = mine.filter((c) => c.author === 'storyteller:seed');
    const seedLead = seedAdds.length
      ? [
          'В этом месяце НАЧАЛАСЬ новая история.',
          'Представь её с нуля, будто покровитель ничего о ней не слышал.',
          'Крючок, не очередь и не новый порядок.',
        ].join(' ')
      : '';

    // Развязка, катастрофа или взятая цель сезона — с этого письмо и начинается.
    const highlight = opts.highlight;
    const highlightLead = highlight
      ? [
          `ГЛАВНОЕ СОБЫТИЕ МЕСЯЦА — ${highlight.note || `история «${highlight.title}» дошла до конца`}.`,
          'Начни письмо с него и дай ему место: кто был, что сделали, чем это кончилось.',
          highlight.kind === 'catastrophe'
            ? 'Не смягчай: покровитель должен понять, что город потерял.'
            : 'Не отчитывайся о работах — расскажи, чем дело кончилось для людей.',
          'Прочие дела — коротко, после.',
        ].join(' ')
      : '';

    const partner = opts.partnerName ? `«${opts.partnerName}»` : 'чужой город';
    const undockHint = opts.undock
      ? [
          'ГЛАВНОЕ СОБЫТИЕ МЕСЯЦА — острова разошлись: сопряжение кончилось.',
          `Чужой остров (${partner}) УЛЕТЕЛ / ушёл в небо: пути между вами больше нет.`,
          'В письме ОБЯЗАТЕЛЬНО скажи прямо: острова разошлись в небе; силуэт чужого края ушёл в даль.',
          'Мост/переход можно упомянуть только как следствие: он исчез, ПОТОМУ ЧТО острова разъехались.',
          'ЗАПРЕЩЕНО оставлять впечатление, будто «просто мостик обвалился», а острова на месте.',
          `Назови ${partner} или «чужой остров» и глагол ухода (ушёл, улетел, растворился вдали, разошлись).`,
        ].join(' ')
      : '';

    const undockSystem = opts.undock
      ? [
          'Этот месяц — конец сопряжения: два летающих острова РАЗОШЛИСЬ.',
          'Письмо покровителю должно сделать это очевидным с первого абзаца.',
          'Нельзя звучать так, будто рухнул только мост, а соседний остров всё ещё рядом.',
        ].join(' ')
      : '';

    const runLetter = async (extraUserNote = '') => {
      const result = await this.runtime.run({
        agentId: 'tickNews',
        userMessages: [
          {
            role: 'user',
            content: [
              `Прошёл месяц (${gameDate.label}). Ниже — ЧТО ДЕЙСТВИТЕЛЬНО СЛУЧИЛОСЬ в городе за этот месяц.`,
              'Это не слухи и не донесения, ждущие проверки: так было. Не сомневайся в записях, ' +
                'не проси подтверждений и не отказывайся о них говорить — просто расскажи об этом покровителю.',
              'Напиши покровителю письмо о месяце — живую речь, НЕ сводку и НЕ отчёт.',
              styleHint,
              undockHint
                ? 'Сделай уход чужого острова в небо центральной нитью письма.'
                : confluxLead
                  ? 'Сделай чужой остров центральной нитью письма.'
                  : highlightLead
                    ? 'Главное событие месяца веди первым и подробнее прочего.'
                    : seedLead
                      ? 'Новую историю представь так, чтобы покровитель понял её без прошлого письма.'
                      : 'Только самое важное. Мелочь опусти.',
              'ОБЯЗАТЕЛЬНО упомяни каждую [critical] запись СВОЕГО города — такое не заметить нельзя.',
              schedule.detail === 'essence'
                ? 'Один короткий абзац, лучше два-три предложения. Можно два крошечных абзаца, как пишет человек.'
                : schedule.detail === 'brief'
                  ? 'Коротко: один абзац о главном, второй только если нужно.'
                  : 'Связная проза от первого лица, 1–3 коротких абзаца.',
              'Без списков, markdown, нумерации, канцелярита.',
              `Не начинай с «${character.name}:» — сразу текст письма.`,
              'Хроника нарочно сухая — это заметки, а не письмо. Оживи их своей речью, ' +
                'но не додумывай событий и не копируй формулировки. Статы и механики не упоминай.',
              addressHint,
              moodHint,
              stewardHint,
              presenceHint,
              scopeHint,
              quietOnly
                ? 'Месяц без сюжета: не называй людей по имени. Ремесло, место, случай — достаточно.'
                : '',
              confluxLead || undockHint ? '' : highlightLead || seedLead,
              confluxLead,
              undockHint,
              extraUserNote,
              '',
              facts,
              foreignBlock,
            ]
              .filter(Boolean)
              .join('\n'),
          },
        ],
        tools: [],
        maxTurns: 1,
        extraSystem: [
          formatRulerVoiceForPrompt(domain, { writable: false }),
          addressHint,
          undockSystem,
          'Ты пишешь покровителю новости месяца живой речью, как человек, а не сводку событий.',
          'Если у записи есть пометка [ЭТА ЗАПИСЬ ЗАКРЫЛА ПРОБЛЕМУ] — эта хроника закрыла историю. ' +
            'Начни с исхода как с завершения, не как с текущей работы. Пометку вслух не произноси. ' +
            'Бытовой вопрос после закрытия — последствия, не продолжение беды.',
          firstMentionHintForSpeech(),
          peopleHint,
          `Не начинай письмо с «${character.name}:».`,
          (() => {
            const board = formatBoardForSpeech(domain, {
              statsFeel: (ids) => statEpithetsShort(domain.stats || {}, this.config, ids),
            });
            return board
              ? `Живые нити города (для памяти, не пересказывай списком; в речи без заголовков в кавычках):\n${board}`
              : '';
          })(),
        ]
          .filter(Boolean)
          .join('\n'),
        scene: opts.undock ? 'tick_news_undock' : 'tick_news',
        domainId: domain.id,
      });
      return stripSpeakerPrefix(
        result.text || 'Покровитель, за месяц многое сдвинулось.',
        character.name,
      );
    };

    let letter = await runLetter();
    if (askPresence && !/[?]/.test(letter)) {
      letter = await runLetter(
        'ПЕРЕПИСИ: в черновике не было вопроса покровителю. Добавь в конец прямой вопрос: слышит ли он ещё, куда делся.',
      );
    }
    if (askPresence && !/[?]/.test(letter)) {
      letter = `${letter.trim()} Слышишь ли ты меня ещё? Город ждёт твоего слова.`;
    }
    if (askPresence) markPatronPresenceAsked(domain);
    if (opts.undock && !assertsIslandsParted(letter)) {
      letter = await runLetter(
        'ПЕРЕПИСИ: в прошлом черновике событие звучало как обвал моста. ' +
          `Нужно ясно: остров ${partner} ушёл в небо, края разошлись, пути нет. ` +
          'Мост — только следствие ухода островов.',
      );
    }
    if (opts.undock && !assertsIslandsParted(letter) && opts.partnerName) {
      // Жёсткий хвост, если модель снова свела к мосту
      letter = `${letter.trim()} Чужой остров «${opts.partnerName}» ушёл в небо — края разошлись, и пути между нами больше нет.`;
    } else if (opts.undock && !assertsIslandsParted(letter)) {
      letter = `${letter.trim()} Чужой остров ушёл в небо — края разошлись, и пути между нами больше нет.`;
    }

    return stripSpeakerPrefix(letter, character.name);
  }

  /**
   * Отдельное слово правителя покровителю: на горизонте чужой остров
   * или он уже близко. Не письмо месяца — тот же голос.
   */
  async narrateConfluxSighting(domain, { kind, fact, partnerName, remaining, rematch } = {}) {
    const character = domain.characters?.[0];
    const fallback = String(fact || '').trim();
    if (!character) return fallback;
    const patronName = domain.state?.patronName || null;
    const addressHint = patronName
      ? `Обращайся к покровителю как «${patronName}». Не подменяй чужим именем бога.`
      : 'Имя покровителя неизвестно — обратись «покровитель», без выдуманных имён.';
    const months = Math.max(0, Math.round(Number(remaining) || 0));
    const when =
      months <= 0
        ? 'сопряжение уже в этом месяце'
        : months === 1
          ? 'до сопряжения около месяца'
          : `до сопряжения по приметам примерно ${months} мес.`;
    const partner = partnerName ? `«${partnerName}»` : 'чужой город';
    const firstSight = kind !== 'approach';
    try {
      const result = await this.runtime.run({
        agentId: 'tickNews',
        tools: [],
        maxTurns: 1,
        scene: firstSight ? 'conflux_announce' : 'conflux_approach',
        domainId: domain.id,
        extraSystem: [
          formatRulerVoiceForPrompt(domain, { writable: false }),
          addressHint,
          'Ты пишешь покровителю живой речью, как человек, а не сводку.',
          `Не начинай письмо с «${character.name}:».`,
        ]
          .filter(Boolean)
          .join('\n'),
        userMessages: [
          {
            role: 'user',
            content: [
              firstSight
                ? 'Это не письмо месяца. Срочное слово покровителю: на горизонте впервые виден чужой летающий остров, сопряжение неизбежно.'
                : 'Это не письмо месяца. Срочное слово покровителю: чужой остров уже близко, до сопряжения около месяца. Край чужой земли уже различим.',
              `Соседний город зовут ${partner}.`,
              `Срок: ${when}.`,
              rematch ? 'Острова уже сходились с этим соседом раньше — город это помнит.' : '',
              'Факт (так было, не слух):',
              fallback,
              'Напиши короткое живое письмо от первого лица: 1–2 коротких абзаца.',
              `Назови ${partner} и срок прямо. Это не примета и не слух — покровитель должен понять масштаб.`,
              'Внутренней жизни соседа ещё не видно — не выдумывай, что у них там происходит.',
              'Не заканчивай служебной формулой. Без списков, markdown, механики.',
              addressHint,
            ]
              .filter(Boolean)
              .join('\n'),
          },
        ],
      });
      return (
        stripSpeakerPrefix(result.text || fallback, character.name) || fallback
      );
    } catch (err) {
      getLogger().warn('conflux.sighting_letter_failed', {
        domainId: domain.id,
        error: err.message,
      });
      return fallback;
    }
  }

  async persistRulerSystemFail(domain, text, { channel, log } = {}) {
    const reply = rulerFailLine(this.config);
    const fresh = (await this.storage.getDomain(domain.id)) || domain;
    await this.persistDialog(fresh, 'user', text);
    await this.persistDialog(fresh, 'assistant', reply, { kind: 'system' });
    log?.warn?.('ruler.system_fail', { domainId: domain.id, preview: truncate(reply, 200) });
    return {
      reply,
      agent: 'system',
      failed: true,
      domainId: domain.id,
      channel,
    };
  }

  async persistDialog(domain, role, content, { kind = null, meta = null } = {}) {
    const character = domain.characters[0];
    if (!character) return;
    if (role === 'user') clearPatronPresenceAsked(domain);
    character.dialogHistory = character.dialogHistory || [];
    const entry = {
      role,
      content,
      at: new Date().toISOString(),
    };
    if (kind) entry.kind = kind;
    if (meta) entry.meta = meta;
    character.dialogHistory.push(entry);
    if (character.dialogHistory.length > 200) {
      character.dialogHistory = character.dialogHistory.slice(-150);
    }
    await this.storage.saveDomain(domain);
  }

  async inspectDomain(domainId) {
    return this.storage.getDomain(domainId);
  }

  async listUsers() {
    const bindings = await this.storage.listUserBindings();
    const domains = await this.storage.listDomains();
    const byId = new Map(domains.map((d) => [d.id, d]));
    return bindings.map((b) => {
      const domain = b.domainId ? byId.get(b.domainId) : null;
      const channel =
        b.channel ||
        (domain?.channel) ||
        (/^\d+$/.test(String(b.userId || '')) ? 'telegram' : null);
      return {
        userId: String(b.userId),
        channel: channel || 'unknown',
        domainId: b.domainId || null,
        domainName: domain?.name || null,
        cityName: b.onboarding?.cityName || null,
        cityNameApproved: Boolean(b.onboarding?.cityNameApproved),
        onboarding: !b.domainId,
        telegramChatId: b.telegramChatId ?? null,
        updatedAt: b.updatedAt || null,
      };
    });
  }

  async listDomains() {
    return this.storage.listDomains();
  }

  async occupiedCityNames(excludeUserId) {
    const [domains, bindings] = await Promise.all([
      this.storage.listDomains(),
      this.storage.listUserBindings(),
    ]);
    return collectOccupiedCityNames({ domains, bindings, excludeUserId });
  }

  async getOwnDomain(userId) {
    const world = await this.storage.getWorld();
    return this.storage.getDomainForUser(userId, world.id);
  }

  async deleteOwnDomain(userId, confirmName) {
    const uid = String(userId);
    const domain = await this.getOwnDomain(uid);
    const conflux = domain ? await findActiveConfluxForDomain(this.storage, domain.id) : null;
    const check = islandDeleteCheck({
      domain,
      conflux,
      confirmName,
    });
    if (!check.ok) return check;
    if (this.generatingUsers?.has(uid)) {
      return { ok: false, reason: 'generating', name: domain.name };
    }
    await removeIslandImage(this.config, domain);
    await this.storage.deleteDomain(domain.id);
    const binding = await this.storage.getUserBinding(uid);
    if (binding) {
      binding.domainId = null;
      binding.onboarding = emptyOnboardingDraft();
      await this.storage.saveUserBinding(binding);
    }
    getLogger().info('island.deleted', { userId: uid, domainId: domain.id, name: domain.name });
    return { ok: true, name: domain.name };
  }

  /**
   * Покровитель благословляет своё ещё идущее дело: при завершении исход будет критическим.
   */
  async blessOwnProcess(userId, processId) {
    const uid = String(userId || '').trim();
    const id = String(processId || '').trim();
    if (!id) return { ok: false, error: 'not_found', message: 'не указано дело' };
    if (this.isWorldTicking()) {
      return { ok: false, error: 'ticking', message: 'сейчас идёт месяц' };
    }
    const world = await this.storage.getWorld();
    const domain = await this.storage.getDomainForUser(uid, world.id);
    if (!domain) return { ok: false, error: 'no_domain', message: 'города ещё нет' };
    normalizeDomain(domain);
    const conflux = await findActiveConfluxForDomain(this.storage, domain.id);
    if (conflux) hydrateDomainFromConflux(domain, conflux, { mode: 'ruler' });

    const process = (domain.state?.pendingActions || []).find((p) => String(p.id) === id);
    if (!process) return { ok: false, error: 'not_found', message: 'такого дела нет' };
    if (!processOwnedBy(process, domain.id)) {
      return { ok: false, error: 'not_own', message: 'благословить можно только своё дело' };
    }
    const result = blessProcess(process, { tick: world.tickIndex });
    if (!result.ok) {
      const message =
        result.error === 'already_blessed'
          ? 'это дело уже благословлено'
          : result.error === 'not_active'
            ? 'дело уже закрыто'
            : 'не удалось благословить';
      return { ok: false, error: result.error, message };
    }

    domain.state.monthLog = Array.isArray(domain.state.monthLog) ? domain.state.monthLog : [];
    domain.state.monthLog.push({
      tick: world.tickIndex ?? null,
      at: new Date().toISOString(),
      text: `Покровитель благословил дело «${process.summary}».`,
      plotIds: process.plotlineId ? [process.plotlineId] : [],
    });
    if (domain.state.monthLog.length > 12) {
      domain.state.monthLog = domain.state.monthLog.slice(-12);
    }

    if (conflux) {
      dehydrateDomainToConflux(domain, conflux);
      await this.storage.saveConflux(conflux);
    }
    await this.storage.saveDomain(domain);
    getLogger().info('process.blessed', {
      userId: uid,
      domainId: domain.id,
      processId: process.id,
      summary: process.summary,
    });
    return { ok: true, process };
  }

  async getChronicle(domainId) {
    const domain = await this.storage.getDomain(domainId);
    if (!domain) return null;
    return {
      domainId: domain.id,
      name: domain.name,
      entries: chronicleEntries(domain.lore),
      facts: (domain.lore || []).filter((f) => (f.tags || []).includes('fact')),
    };
  }

  async wipeAll() {
    const result = await this.storage.wipeAll({ reason: 'wipe' });
    const newWorldId = result.newWorldId || result.world?.id;
    if (newWorldId) {
      setLoggerWorldId(newWorldId);
      initUsageRecording(this.config, newWorldId, this.storage);
    }
    getLogger().info('world.rotated', {
      archivedWorldId: result.archivedWorldId || null,
      newWorldId: newWorldId || null,
      archiveDir: result.archiveDir || null,
    });
    return result;
  }
}
