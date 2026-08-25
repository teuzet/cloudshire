import { generateDomain, domainSummary } from './genesis.js';
import {
  chronicleEntries,
  newsChronicleEntries,
  filterChronicleForDomain,
  formatChronicleScope,
  normalizeDomain,
  formatCastForPrompt,
  applyPatronName,
  firstMentionHintForSpeech,
  peopleNamedInTexts,
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
} from './confluxBoard.js';
import { askInformant } from './informant.js';
import {
  emptyOnboardingDraft,
  normalizeOnboardingDraft,
  validateCityName,
  validatePatronName,
  listTagCatalog,
  formatPlayerBrief,
  formatTagCatalogForPrompt,
  inferTagChoicesFromText,
  collectOnboardingPreferenceText,
  randomizeAllTags,
  claimsOnboardingAlreadyCreated,
  extractPitchedCityName,
  lastPitchedCityName,
  playerAsksReroll,
  planOnboardingAutoStart,
  formatOnboardingStartReply,
  formatOnboardingStatusCard,
  deriveOnboardingPhase,
  hasPitchedCity,
  canStartOnboarding,
  applyUserNamedCity,
  applyUserNamedPatron,
  maybeSwitchToDossier,
  rememberLongUserBrief,
  clipOnboardingBrief,
  appendNeedNameNote,
  appendNeedPatronNote,
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
import { formatIslandReveal } from './islandReveal.js';
import { formatProgressBar } from './progressBar.js';
import { estimateProcessDuration } from './durationJudge.js';
import { ensureErrandForProcess, linkProcessToPlotline } from './plotEngine.js';
import { judgeProcessAlignment } from './plotAlign.js';
import { dialogHistoryForPrompt } from './memory.js';
import {
  newsScheduleOf,
  setNewsSchedule,
  shouldSendTickNews,
  tickNewsStyleHint,
} from './newsSchedule.js';
import {
  formatRulerMemoryForPrompt,
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
function submitReplyTool(turn, character) {
  const succeeded = (...names) => names.some((n) => turn.okTools.has(n));
  return {
    name: 'submit_reply',
    description:
      'ЕДИНСТВЕННЫЙ способ ответить покровителю. Вызывай последним, когда все нужные действия уже сделаны. ' +
      'text — сама речь; requestKind — чего просил покровитель; commitment — что ты реально сделал этим ходом.',
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
            'кто-то отказался, куда-то сходили. Пусто, если был только разговор.',
        },
        commitment: {
          type: 'string',
          enum: ['none', 'process', 'standing_order', 'revoked', 'refused'],
          description:
            'Что сделано этим ходом: process (declare_process/update_process), standing_order, ' +
            'revoked (отменил указ или свернул дело), refused (честно отказал или отговорил), ' +
            'none (действий не требовалось).',
        },
      },
    },
    handler: async ({ text, requestKind, commitment, touchedPlotIds, dayNote }) => {
      const body = String(text || '').trim();
      if (body.length < 2) {
        return toolFail('too_short', 'Речь пустая. Напиши ответ покровителю в text.');
      }
      if (commitment === 'process' && !succeeded('declare_process', 'update_process')) {
        return toolFail(
          'process_missing',
          'Ты заявил commitment=process, но дело не создано: declare_process/update_process не выполнен успешно. ' +
            'Либо вызови declare_process сейчас, либо смени commitment (refused — если отговариваешь, none — если дела не нужно) ' +
            'и убери из речи обещание долгого дела.',
        );
      }
      if (commitment === 'standing_order' && !succeeded('declare_standing_order')) {
        return toolFail(
          'order_missing',
          'commitment=standing_order, но declare_standing_order не выполнен. Объяви порядок через tool или смени commitment.',
        );
      }
      if (commitment === 'revoked' && !succeeded('revoke_order', 'revoke_process')) {
        return toolFail(
          'revoke_missing',
          'commitment=revoked, но отмена не выполнена. Вызови revoke_order (указ) или revoke_process (дело), либо смени commitment.',
        );
      }
      if (requestKind === 'order_long' && commitment === 'none') {
        return toolFail(
          'order_ignored',
          'Покровитель отдал долгий приказ, а ты ничего не предпринял. Либо declare_process / update_process (и commitment=process), ' +
          'либо честно откажи/отговори в речи и поставь commitment=refused.',
        );
      }
      if (requestKind === 'order_instant' && commitment === 'none') {
        return toolFail(
          'instant_ignored',
          'Покровитель велел решение сейчас, а в мире ничего не заведено. У тебя два способа: ' +
            'declare_standing_order — если это порядок, который теперь соблюдают всегда; ' +
            'declare_process на 1 месяц — если это дело, у которого будет исход (послать людей, ' +
            'разобрать спор, провести обряд, найти виновного). Разовых «сделал и забыли» не бывает: ' +
            'у любого приказа есть последствия, и город должен их отследить. ' +
            'Либо откажи в речи с commitment=refused.',
        );
      }
      if (requestKind === 'order_impossible' && commitment !== 'refused') {
        return toolFail(
          'impossible_not_refused',
          'Такой приказ смертному не исполнить. Поставь commitment=refused. ' +
            'В речи — не объяснение устройства мира, а твоё простое «не умею», «не понимаю этих слов», ' +
            '«там ветер и бездна»; предложи то, что можешь: послать людей, объявить обряд, начать дело. ' +
            'Сцену, будто это происходит, не отыгрывай.',
        );
      }
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
        guidance:
          'Отвечай в духе conditionFeel: качественно, без чисел и без имён статов. ' +
          'О делах — по-человечески: что делается и сколько примерно ждать.',
        guidancePeople:
          'knownPeople — люди, которых город уже знает: имя, пол, ремесло и что о них известно. ' +
          'Это правда, а не слухи. Не переспрашивай о том, что здесь написано, и не придумывай ' +
          'им другую судьбу.',
        standingOrders: listStandingOrders(domain),
        guidanceOrders:
          'standingOrders — действующие указы/порядки. pending=create/edit/revoke — заявка ещё не вступила, вступит с новостями месяца. ' +
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
          'Для update_process / revoke_process бери id из processes[].id. ' +
          'Если id не помнишь — передай краткий смысл дела в processId (например «университет»), система найдёт. ' +
          'Покровитель уточняет уже идущую ту же работу (новый вопрос к тому же дознанию, другой темп) — update_process, commitment=process. Не отказывай и не заводи второе. ' +
          'Общий храм, общий двор или общие имена — не дубль и не повод слить РАЗНЫЕ работы. ' +
          'initiative=ruler — это дело ты завёл сам, пока покровитель молчал; на вопрос «что ты решал» называй их.',
        guidancePlots:
          'plots[] — живые нити. kind=errand уже привязана к делу; kind=story может быть без поручения; kind=order — постоянный порядок, дело на него не заводи. ' +
          'foreign=true — история СОСЕДА, ещё не общая: если покровитель в неё вмешивается, declare_process с её plotId — тогда она станет общей. ' +
          'shared=true — общая история сопряжения, дело можно заводить с обеих сторон. ' +
          'Приказ по истории без дела — declare_process с plotId этой истории. ' +
          'Не бери id соседней нити из-за общего места или общих людей.',
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
        'Спросить лормастера о фактах мира (имена, места, детали недавних событий, слухи…). Обязательно, когда покровитель просит подробности.',
      parameters: {
        type: 'object',
        required: ['questions'],
        properties: {
          questions: {
            type: 'array',
            items: { type: 'string' },
            description: '1–5 конкретных вопросов',
          },
        },
      },
      handler: async ({ questions }) => {
        const result = await askLoremaster({
          config: ctx.config,
          runtime: ctx.runtime,
          storage,
          domain,
          questions: questions || [],
          asker: `ruler:${character.name}`,
        });
        return {
          ok: true,
          answers: result.answers,
          summary: result.loreTextForAsker,
          newFactsCount: result.addedFacts.length,
          newFactTexts: result.addedFacts.map((f) => f.text),
          hint:
            'Перескажи суть своими словами и своим тоном, не цитируя карточки фактов. ' +
            'Если answers заполнены, «неизвестно» покровителю не говори.',
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
        return {
          ok: true,
          answers: result.answers,
          summary: result.summary,
          hint:
            'Перескажи своими словами. Если informant сказал «неизвестно» — так и скажи покровителю. ' +
            'Предположение помечай как догадку, не как факт.',
        };
      },
    },
    {
      name: 'declare_process',
      description:
        'Длительное дело: стройка, суд, поход, снабжение. Не для мгновенных постоянных приказов — declare_standing_order. ' +
        'Срок сам не оценивай: его посчитает отдельный оценщик. ' +
        'Отказы: too_many_processes (лимит слотов) vs duplicate_process (та же нить) — разные отговорки в речи.',
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
            description: `Статы, от которых зависит ход дела (1+ из: ${(ctx.config.stats || [])
              .map((s) => s.id)
              .join(', ')})`,
          },
          onBehalfOf: { type: 'string', default: 'patron' },
          characterNote: { type: 'string' },
          plotId: {
            type: 'string',
            description:
              'id истории с доски, О КОТОРОЙ говорит покровитель. ' +
              'Если у этой истории ещё нет дела — укажи её id. ' +
              'Не подставляй соседнюю нить из-за общего места или общих людей. ' +
              'Если приказ не про живую историю — оставь пустым, дело заведёт свою нить само.',
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
        goal,
      }) => {
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
              'ОТКАЗ: лимит параллельных дел (' +
              `${slots.active}/${slots.max}` +
              '). Это НЕ «похожее дело». ' +
              'В речи: люди/мастера уже заняты перечисленными делами — назови их по смыслу; ' +
              'предложи дождаться или свернуть одно через revoke_process. ' +
              'Не говори «лимит», process, tool. Новое дело НЕ объявляй и НЕ путай с дублем.',
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
            `linkedStats обязательны — выбери 1+ id из: ${(ctx.config.stats || []).map((s) => s.id).join(', ')}. ` +
              'Повтори declare_process с валидными linkedStats.',
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
        const action = {
          id: newId('act'),
          summary,
          detail,
          goal: String(goal || '').trim() || null,
          expectedMonths: 1,
          durationMonths: 1,
          monthsLeft: 1,
          monthsDone: 0,
          linkedStats: linked,
          onBehalfOf,
          characterId: character.id,
          characterName: character.name,
          characterNote: characterNote || null,
          hardDeadline: hard,
          status: 'active',
          initiative: 'patron',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        domain.state.pendingActions.push(action);
        const estimated = await estimateProcessDuration({
          config: ctx.config,
          runtime: ctx.runtime,
          domain,
          summary,
          detail,
          log: ctx.log,
        });
        applyObjectiveSchedule(action, estimated.months, askedRemaining);
        // У каждого дела есть нить: либо та, что назвал правитель, либо проходная.
        let plot = plotId ? linkProcessToPlotline(domain, action.id, String(plotId)) : null;
        if (!plot) {
          plot = ensureErrandForProcess(domain, action, {
            tick: world?.tickIndex ?? null,
            config: ctx.config,
          }).plot;
        }
        action.plotlineId = plot?.id || null;
        if (plot && isThreeActPlot(plot)) {
          await judgeProcessAlignment({
            runtime: ctx.runtime,
            domain,
            process: action,
            plot,
            log: ctx.log,
          });
        }
        if (ctx.conflux && plot && !isOrderPlot(plot)) {
          action.confluxId = ctx.conflux.id;
          action.ownerDomainId = domain.id;
          if (!plotConcerns(plot, domain.id) && !plot.isMainConflux) {
            sharePlotWithDomain(plot, domain.id, { reason: 'process' });
          }
        }
        await save();
        return {
          ok: true,
          process: action,
          hint:
            `В речи: принял повеление. ${paceHint(action)} ` +
            'Не говори «уже строим» и не рапортуй механику; итог придёт с новостями месяца, ' +
            'а не в этой переписке.',
        };
      },
    },
    {
      name: 'declare_standing_order',
      description:
        'Заявка на постоянный порядок / правило (запрет, осмотр, регулярный обряд). ' +
        'Карточку и каденс соберёт город к новостям месяца. Не для строек, судов, походов — те через declare_process.',
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
        },
      },
      handler: async ({ text, id }) => {
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
        return {
          ok: true,
          created: Boolean(queued.created),
          request: queued.request,
          hint:
            'В речи: принял как постоянный порядок, начнут соблюдать. Не объявляй многомесячный срок и не говори «процесс». ' +
            'Последствия указа город увидит к концу месяца.',
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
        await save();
        const mode = revised.fresh ? 'дело ещё не сдвинулось, можно было переписать' : 'дело уже шло, текст только дополнен';
        return {
          ok: true,
          process: action,
          hint:
            `${mode}. ${paceHint(action)} ` +
            'В речи не обещай, что уже сделано; итог придёт с новостями месяца.',
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
        await save();
        return {
          ok: true,
          revokedId: action.id,
          summary: action.summary,
          hint: 'В речи: дело свёрнуто/отложено по воле покровителя. Без id/process.',
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
        const result = pauseProcess(action);
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

      return await this.runRuler(domain, text, { channel, log, world });
    } finally {
      this.busyUsers.delete(uid);
    }
  }

  startDomainGeneration(userId, { channel, forcedName, forcedPatronName, forcedTagChoices, playerBrief }) {
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
          tagChoices: forcedTagChoices || {},
          playerBrief: truncate(playerBrief, 500),
        });
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
          forcedTagChoices: forcedTagChoices || {},
          playerBrief: playerBrief || null,
          log,
          onProgress: async (msg) => {
            const label = String(msg || '').trim();
            let step = 2;
            if (/ядро/i.test(label)) step = 1;
            else if (/описание|аспект/i.test(label)) step = 2;
            else if (/истори/i.test(label)) step = 3;
            else if (/собран|готов/i.test(label)) step = 3;
            await pushProgress(step, label);
          },
        });

        const intro = domain._greeting.startsWith(domain.characters[0].name)
          ? domain._greeting
          : `${domain.characters[0].name}: ${domain._greeting}`;

        await pushProgress(4, 'рисую вид острова…');
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
          `Не удалось создать остров: ${err.message || err}. Можно поправить имя/теги и снова попросить старт.`,
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

    const rawUser = String(text || '').trim();
    if (!bootstrap && rawUser) {
      maybeSwitchToDossier(draft, rawUser);
      applyUserNamedCity(draft, rawUser);
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
      tags: draft.tagChoices,
    });

    const saveDraft = async () => {
      binding.onboarding = draft;
      binding.channel = channel || binding.channel || null;
      binding.updatedAt = new Date().toISOString();
      await this.storage.saveUserBinding(binding);
    };

    const tools = [
      {
        name: 'get_setup',
        description: 'Текущий черновик старта: теги, brief, имя, готовность',
        parameters: { type: 'object', properties: {} },
        handler: async () => ({
          ok: true,
          mode: draft.mode || null,
          phase: deriveOnboardingPhase(draft, { generating: this.isGenerating(userId) }),
          tagChoices: draft.tagChoices,
          playerBrief: {
            city: String(draft.playerBrief?.city || '').slice(0, BRIEF_CITY_MAX),
            ruler: String(draft.playerBrief?.ruler || '').slice(0, BRIEF_RULER_MAX),
            freeform: String(draft.playerBrief?.freeform || '').slice(0, BRIEF_FREEFORM_MAX),
          },
          cityName: draft.cityName,
          cityNameApproved: draft.cityNameApproved,
          patronName: draft.patronName,
          patronNameApproved: Boolean(draft.patronNameApproved),
          canStart: canStartOnboarding(draft),
          pitchedName: draft.pitchedName || null,
          pitched: hasPitchedCity(draft),
          modes: {
            quick: 'Рандом черт → предложить имя+атмосферу+все черты → аппрув/правки → старт',
            brief: 'Игрок дал краткое описание → додумать → аппрув → старт',
            questions: 'Наводящие вопросы по ходу, tools по ответам',
            dossier: 'Игрок несёт длинное ТЗ: пересказ, дыры, противоречия; старт только по «создавай»',
          },
        }),
      },
      {
        name: 'set_onboarding_mode',
        description: 'Зафиксировать режим онбординга: quick | brief | questions | dossier',
        parameters: {
          type: 'object',
          required: ['mode'],
          properties: {
            mode: {
              type: 'string',
              enum: ['quick', 'brief', 'questions', 'dossier'],
            },
          },
        },
        handler: async ({ mode }) => {
          draft.mode = mode;
          draft.phase = deriveOnboardingPhase(draft);
          await saveDraft();
          return { ok: true, mode: draft.mode, phase: draft.phase };
        },
      },
      {
        name: 'randomize_all_tags',
        description:
          'Быстрый режим: ОДИН раз заполнить все группы черт. Повторять только если игрок просит другой город. После питча forPlayer перескажи целиком.',
        parameters: { type: 'object', properties: {} },
        handler: async () => {
          const alreadyPitched = hasPitchedCity(draft);
          if (alreadyPitched && !playerAsksReroll(text)) {
            const held = draft.pitchedName || draft.cityName || lastPitchedCityName(draft);
            return toolFail(
              'already_pitched',
              `Город уже предложен${held ? ` («${held}»)` : ''}. Не бросай теги заново. ` +
                'Если игрок согласен — set_city_name(это имя) и start_new_game. ' +
                'randomize_all_tags — только после явной просьбы «другой город / заново».',
            );
          }
          const { chosen, applied, forPlayer } = randomizeAllTags(this.config);
          draft.tagChoices = chosen;
          draft.pitchedName = null;
          draft.pitched = false;
          draft.cityName = null;
          draft.cityNameApproved = false;
          draft.pitchedTagChoices = { ...chosen };
          draft.phase = deriveOnboardingPhase(draft);
          await saveDraft();
          return {
            ok: true,
            applied,
            chosen: draft.tagChoices,
            forPlayer,
            next:
              'Запиши атмосферу и правителя в set_player_brief. Сам придумай звучный топоним (не из списка — списка нет). ' +
              'В речи игроку: имя + ВСЕ черты из forPlayer своими словами + атмосфера + правитель. ' +
              'Без слов «теги/изюминка/пакет/рандом». Этот набор держи, пока игрок не попросит другой город.',
          };
        },
      },
      {
        name: 'set_player_brief',
        description:
          'Записать/обновить бриф пожеланий для генезиса (город и правитель-связной). Для длинного ТЗ пиши подробно: детали игрока важнее краткости. Можно вызывать несколько раз.',
        parameters: {
          type: 'object',
          properties: {
            city: {
              type: 'string',
              description: 'Пожелания к городу/острову: тон, проблемы, атмосфера…',
            },
            ruler: {
              type: 'string',
              description: 'Каким видит правителя-связного: характер, титул, слабости…',
            },
            freeform: {
              type: 'string',
              description: 'Прочие пожелания одной прозой',
            },
            replace: {
              type: 'boolean',
              description: 'Если true — заменить brief целиком; иначе дополнить непустые поля',
            },
          },
        },
        handler: async ({ city, ruler, freeform, replace = false }) => {
          if (!draft.playerBrief) {
            draft.playerBrief = { city: '', ruler: '', freeform: '' };
          }
          if (replace) {
            draft.playerBrief = {
              city: city || '',
              ruler: ruler || '',
              freeform: freeform || '',
            };
          } else {
            if (city) draft.playerBrief.city = city;
            if (ruler) draft.playerBrief.ruler = ruler;
            if (freeform) draft.playerBrief.freeform = freeform;
          }
          clipOnboardingBrief(draft.playerBrief);
          draft.phase = deriveOnboardingPhase(draft);
          await saveDraft();
          return { ok: true, playerBrief: draft.playerBrief };
        },
      },
      {
        name: 'set_city_name',
        description:
          'Проверить и зафиксировать имя города (ты сам его придумал или игрок предложил). После согласия / в конце онбординга.',
        parameters: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string' },
          },
        },
        handler: async ({ name }) => {
          const v = validateCityName(name);
          if (!v.ok) {
            draft.cityNameApproved = false;
            await saveDraft();
            return toolFail('invalid_city_name', v.reason, { reason: v.reason });
          }
          draft.cityName = v.name;
          draft.cityNameApproved = true;
          draft.pitchedName = v.name;
          draft.pitched = true;
          draft.phase = deriveOnboardingPhase(draft);
          await saveDraft();
          return { ok: true, cityName: v.name };
        },
      },
      {
        name: 'set_patron_name',
        description:
          'Зафиксировать имя бога-покровителя, как его назвал игрок. Не выдумывай имя сам. Без этого start_new_game нельзя.',
        parameters: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string', description: 'Как к игроку будут обращаться в городе' },
          },
        },
        handler: async ({ name }) => {
          const v = validatePatronName(name);
          if (!v.ok) {
            draft.patronNameApproved = false;
            await saveDraft();
            return toolFail('invalid_patron_name', v.reason, { reason: v.reason });
          }
          draft.patronName = v.name;
          draft.patronNameApproved = true;
          await saveDraft();
          return { ok: true, patronName: v.name };
        },
      },
      {
        name: 'list_tag_groups',
        description: 'Показать группы характеристик острова и варианты (климат, уклад…)',
        parameters: { type: 'object', properties: {} },
        handler: async () => ({
          ok: true,
          groups: listTagCatalog(this.config),
          chosen: draft.tagChoices,
        }),
      },
      {
        name: 'set_tag_choices',
        description:
          'Задать теги по группам. Можно tagId из каталога ИЛИ свободные слова (tagLabel) — любые формулировки игрока. Остальные группы — random из каталога.',
        parameters: {
          type: 'object',
          required: ['choices'],
          properties: {
            choices: {
              type: 'array',
              items: {
                type: 'object',
                required: ['groupId'],
                properties: {
                  groupId: { type: 'string' },
                  tagId: {
                    type: 'string',
                    description: 'id из каталога (опционально)',
                  },
                  tagLabel: {
                    type: 'string',
                    description: 'Свободные слова игрока (предпочтительно, если говорил своими словами)',
                  },
                },
              },
            },
          },
        },
        handler: async ({ choices }) => {
          const applied = [];
          const errors = [];
          for (const c of choices || []) {
            const group = (this.config.genesis.tagGroups || []).find((g) => g.id === c.groupId);
            if (!group) {
              errors.push(`неизвестная группа «${c.groupId}»`);
              continue;
            }
            const label = String(c.tagLabel || '').trim();
            if (label) {
              draft.tagChoices[c.groupId] = label;
              applied.push({ group: group.name, tag: label, freeform: true });
              continue;
            }
            const tag = group.tags.find((t) => t.id === c.tagId);
            if (!tag) {
              errors.push(`для «${c.groupId}» нужен tagId из каталога или свободный tagLabel`);
              continue;
            }
            draft.tagChoices[c.groupId] = c.tagId;
            applied.push({ group: group.name, tag: tag.name, freeform: false });
          }
          await saveDraft();
          const total = (this.config.genesis.tagGroups || []).length;
          if (errors.length) {
            const groupIds = (this.config.genesis.tagGroups || []).map((g) => g.id).join(', ');
            return toolFail(
              'tag_choices_partial',
              'Часть choices не применена. Для каждой группы нужен известный groupId и tagId из каталога ' +
                `или свободный tagLabel. Допустимые groupId: ${groupIds}. Смотри errors[].`,
              { applied, errors, chosen: draft.tagChoices },
            );
          }
          return {
            ok: true,
            applied,
            errors,
            chosen: draft.tagChoices,
            note: `${Object.keys(draft.tagChoices).length}/${total} групп задано; остальное random из каталога.`,
          };
        },
      },
      {
        name: 'set_tag_choice',
        description:
          'Один тег в группе: либо tagId из каталога, либо свободные слова (tagLabel). Без выбора — random.',
        parameters: {
          type: 'object',
          required: ['groupId'],
          properties: {
            groupId: { type: 'string' },
            tagId: { type: 'string' },
            tagLabel: {
              type: 'string',
              description: 'Свободные слова (не обязаны совпадать с каталогом)',
            },
          },
        },
        handler: async ({ groupId, tagId, tagLabel }) => {
          const group = (this.config.genesis.tagGroups || []).find((g) => g.id === groupId);
          if (!group) {
            const groupIds = (this.config.genesis.tagGroups || []).map((g) => g.id).join(', ');
            return toolFail(
              'unknown_group',
              `Неизвестная группа «${groupId}». Допустимые groupId: ${groupIds}. Вызови list_tag_groups.`,
            );
          }
          const label = String(tagLabel || '').trim();
          if (label) {
            draft.tagChoices[groupId] = label;
            await saveDraft();
            return {
              ok: true,
              group: group.name,
              tag: label,
              freeform: true,
              chosen: draft.tagChoices,
            };
          }
          const tag = group.tags.find((t) => t.id === tagId);
          if (!tag) {
            return toolFail(
              'tag_required',
              `Для группы «${group.name}» нужен tagId из каталога или свободный tagLabel. Вызови list_tag_groups.`,
            );
          }
          draft.tagChoices[groupId] = tagId;
          await saveDraft();
          const totalGroups = (this.config.genesis.tagGroups || []).length;
          const chosenCount = Object.keys(draft.tagChoices).length;
          return {
            ok: true,
            group: group.name,
            tag: tag.name,
            freeform: false,
            chosen: draft.tagChoices,
            note: `Выбрано ${chosenCount} из ${totalGroups} групп; остальные — random из каталога.`,
          };
        },
      },
      {
        name: 'clear_tag_choice',
        description: 'Сбросить ручной выбор тега в группе — снова случайный',
        parameters: {
          type: 'object',
          required: ['groupId'],
          properties: { groupId: { type: 'string' } },
        },
        handler: async ({ groupId }) => {
          delete draft.tagChoices[groupId];
          await saveDraft();
          return { ok: true, chosen: draft.tagChoices };
        },
      },
      {
        name: 'start_new_game',
        description:
          'Запуск генерации. Нужны утверждённые имя города и имя бога. Невыбранные теги — случайные. Brief уходит в генезис.',
        parameters: { type: 'object', properties: {} },
        handler: async () => {
          const world = await this.storage.getWorld();
          const existing = await this.storage.getDomainForUser(userId, world.id);
          if (existing) {
            return toolFail(
              'already_has_domain',
              'У игрока уже есть домен в этом сезоне. Не запускай генерацию повторно; направь к правителю города.',
            );
          }
          if (!draft.cityNameApproved || !draft.cityName) {
            const fallback = lastPitchedCityName(draft);
            const v = fallback ? validateCityName(fallback) : { ok: false };
            if (v.ok) {
              draft.cityName = v.name;
              draft.cityNameApproved = true;
              await saveDraft();
            } else {
              return toolFail(
                'city_name_required',
                'Сначала утверди имя города через set_city_name (с согласия игрока), затем start_new_game.',
              );
            }
          }
          if (!draft.patronName) {
            return toolFail(
              'patron_name_required',
              'Сначала спроси, как к игроку-богу обращаться, вызови set_patron_name с его именем, затем start_new_game. Имя бога игрок придумывает сам.',
            );
          }

          if (this.isGenerating(userId)) {
            return { ok: true, status: 'generating' };
          }

          // Если агент назвал теги словами, но не вызвал tools — добираем из brief/реплик.
          const prefText = collectOnboardingPreferenceText(draft);
          const before = { ...draft.tagChoices };
          draft.tagChoices = inferTagChoicesFromText(
            this.config,
            prefText,
            draft.tagChoices || {},
          );
          if (Object.keys(draft.tagChoices).length !== Object.keys(before).length) {
            await saveDraft();
          }

          this.startDomainGeneration(userId, {
            channel,
            forcedName: draft.cityName,
            forcedPatronName: draft.patronName,
            forcedTagChoices: { ...draft.tagChoices },
            playerBrief: { ...(draft.playerBrief || {}) },
          });
          startedGenerating = true;
          const forced = Object.keys(draft.tagChoices).length;
          const total = (this.config.genesis.tagGroups || []).length;
          return {
            ok: true,
            status: 'generating',
            cityName: draft.cityName,
            tagsForced: forced,
            tagsRandom: Math.max(0, total - forced),
            briefPreview: formatPlayerBrief(draft.playerBrief),
            inferredTags: draft.tagChoices,
          };
        },
      },
    ];

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
      'КАТАЛОГ ТЕГОВ (базис для random / быстрой генерации; группы не выдумывай):',
      formatTagCatalogForPrompt(this.config),
      '',
      isIntroPitch
        ? [
            'ПЕРВЫЙ КОНТАКТ — только речь, без tools (кроме set_onboarding_mode после явного выбора — можно отложить).',
            'Расскажи: игрок — бог-покровитель; город-государство на изолированном летающем острове;',
            'правитель — НПС-связной; дальше диалог с ним; месяц сдвигает мир.',
            'Предложи пути (своими словами, без нумерации 1.2.3.):',
            'быстрая генерация; краткое описание «чего хочу»; наводящие вопросы;',
            'или пусть пришлёт готовое подробное описание — тогда не стартуй, а разбери его.',
            'Не вызывай start_new_game и не рандомь теги в питче.',
          ].join(' ')
        : formatOnboardingStatusCard(draft, this.config, { generating: this.isGenerating(userId) }),
    ].join('\n');
    const result = await this.runtime.run({
      agentId: 'onboarding',
      userMessages: [...history, { role: 'user', content: userContent }],
      tools,
      extraSystem,
      log,
      scene: 'onboarding',
    });

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
    if (
      userSaidSomething &&
      !usedTools.has('set_tag_choices') &&
      !usedTools.has('set_tag_choice') &&
      !usedTools.has('start_new_game')
    ) {
      const prefText = collectOnboardingPreferenceText(draft);
      draft.tagChoices = inferTagChoicesFromText(this.config, prefText, draft.tagChoices || {});
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
    });
    if (auto.start) {
      if (usedTools.has('randomize_all_tags') && Object.keys(draft.pitchedTagChoices || {}).length) {
        draft.tagChoices = { ...draft.pitchedTagChoices };
      }
      draft.cityName = auto.name;
      draft.cityNameApproved = true;
      draft.pitchedName = auto.name;
      draft.pitched = true;
      const prefText = collectOnboardingPreferenceText(draft);
      draft.tagChoices = inferTagChoicesFromText(
        this.config,
        prefText,
        draft.tagChoices || {},
      );
      log.warn('onboarding.auto_start_new_game', {
        cityName: draft.cityName,
        patronName: draft.patronName,
        reason: auto.reason,
      });
      this.startDomainGeneration(userId, {
        channel,
        forcedName: draft.cityName,
        forcedPatronName: draft.patronName,
        forcedTagChoices: { ...draft.tagChoices },
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
      if (Object.keys(draft.tagChoices || {}).length) {
        draft.pitchedTagChoices = { ...draft.tagChoices };
      }
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
        tagChoices: draft.tagChoices,
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
        tagChoices: draft.tagChoices,
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
      `Ты ${character.name}, ${character.title || 'правитель'} города «${domain.name}».`,
      character.description,
      world?.gameDate?.label ? `ДАТА СЕЙЧАС: ${world.gameDate.label}.` : '',
      patronLine,
      confluxCanon,
      undockCanon,
      formatRulerMemoryForPrompt(domain),
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
            'Каждая нить сама по себе. Общее место или общие люди не делают их одним делом.',
            'Приказ по истории без поручения — новое дело с plotId этой истории, не правка соседнего.',
            conflux
              ? 'Чужая нить соседа, ещё не общая: если покровитель в неё вмешивается — declare_process с её plotId, и она станет общей.'
              : '',
          ]
            .filter(Boolean)
            .join('\n')
        : '',
      `Известные люди города:\n${formatCastForPrompt(domain.lore, { limit: 16 })}`,
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

    const result = await this.runtime.run({
      agentId: 'ruler',
      userMessages: [...history, { role: 'user', content: text }],
      tools,
      extraSystem,
      maxTurns: 10,
      log,
      scene: 'ruler',
      domainId: domain.id,
    });

    if (!turn.reply) {
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
              'Если дела ты не заводил — commitment=none (или refused, если отговариваешь), ' +
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
      });
    }

    let reply = turn.reply || result.text || '';
    if (!String(reply).trim() || looksLikeToolDump(reply)) {
      log.warn('ruler.reply_unusable', { preview: truncate(reply, 200) });
      reply =
        `${patronName || 'Покровитель'}, прости — мысль сбилась. ` +
        'Повтори волю коротко, и я исполню без путаницы.';
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
      .map((c) => `- [${c.importance || 'event'}] ${formatChronicleScope(c)}${c.text}`)
      .join('\n');
    const foreignBlock = foreign.length
      ? [
          'ЧУЖОЙ ГОРОД (это НЕ новости твоего города):',
          ...foreign.map((c) => `- ${formatChronicleScope(c)}${c.text}`),
        ].join('\n')
      : '';
    const patronName = domain.state?.patronName || null;
    const addressHint = patronName
      ? `Обращайся к покровителю как «${patronName}». Не подменяй чужим именем бога.`
      : 'Имя покровителя неизвестно — обратись «покровитель», без выдуманных имён.';

    const scopeHint = foreign.length
      ? [
          'О делах соседнего города НЕ отчитывайся покровителю: это чужое хозяйство, не твоя служба.',
          'Упомянуть можно одной фразой — как слух с той стороны и только если это задевает нас',
          '(проход, вода, торговля, чужие люди на нашем краю). Иначе просто опусти.',
          'Не называй чужие тяготы «вестью» и не разбирай их подробно.',
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
          'В этом месяце ТЫ САМ отдал приказ — совета покровителя не дождался. Это правда, так и скажи.',
          ...stewardActs.map((a) =>
            a.kind === 'standing_order'
              ? `- постоянный порядок: ${a.text}`
              : `- дело: ${a.summary}`,
          ),
          'Коротко признайся: решил сам, потому что от него совета не дождался. Не прячь это за «город сам».',
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
          `Ты ${character.name}, ${character.title || 'правитель'} города «${domain.name}».`,
          character.description,
          addressHint,
          undockSystem,
          'Ты пишешь покровителю новости месяца живой речью, как человек, а не сводку событий.',
          firstMentionHintForSpeech(),
          peopleHint,
          `Не начинай письмо с «${character.name}:».`,
          (() => {
            const board = formatBoardForSpeech(domain, {
              statsFeel: (ids) => statEpithetsShort(domain.stats || {}, this.config, ids),
            });
            return board ? `Живые нити города (для памяти, не пересказывай списком):\n${board}` : '';
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
          `Ты ${character.name}, ${character.title || 'правитель'} города «${domain.name}».`,
          character.description || '',
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
