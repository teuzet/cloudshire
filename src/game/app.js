import { generateDomain, domainSummary } from './genesis.js';
import {
  chronicleEntries,
  newsChronicleEntries,
  filterChronicleForDomain,
  formatChronicleScope,
  normalizeDomain,
  formatCastForPrompt,
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
import { assertsIslandsParted, monthsUntilDock, findActiveConfluxForDomain } from './conflux.js';
import {
  emptyOnboardingDraft,
  validateCityName,
  listTagCatalog,
  formatPlayerBrief,
  formatTagCatalogForPrompt,
  inferTagChoicesFromText,
  collectOnboardingPreferenceText,
  randomizeAllTags,
  formatTagChoicesForPlayer,
  claimsOnboardingGenerating,
  claimsOnboardingAlreadyCreated,
  extractPitchedCityName,
  lastPitchedCityName,
  playerAsksReroll,
  planOnboardingAutoStart,
  formatOnboardingStartReply,
  ONBOARDING_FALSE_START_REPLY,
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
} from './processes.js';
import { formatBoardForSpeech, warmPlotlines, plotConfig, findPlotline, clipPlotText, PLOT_TITLE_MAX, PLOT_SUMMARY_MAX } from './plotlines.js';
import { queueOrderRequest, listStandingOrders } from './orders.js';
import { islandDeleteCheck } from '../clients/telegram/access.js';
import { generateIslandImage, removeIslandImage } from './islandImage.js';
import { formatIslandReveal } from './islandReveal.js';
import { formatProgressBar } from './progressBar.js';
import { estimateProcessDuration } from './durationJudge.js';
import { ensureErrandForProcess, linkProcessToPlotline } from './plotEngine.js';
import { dialogHistoryForPrompt } from './memory.js';
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
  if (/declare_action|declare_process|consult_loremaster|set_patron_name|read_domain_brief/i.test(t) && /\{/.test(t)) {
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
  const save = async () => storage.saveDomain(domain);
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
          monthsLeft: a.monthsLeft,
          expectedMonths: a.expectedMonths,
          objectiveMonths: a.objectiveMonths || a.expectedMonths,
          pace: processPaceFeel(a),
          linkedStats: a.linkedStats,
          initiative: a.initiative || 'patron',
          fresh: processIsFresh(a),
          progress: processProgressFeel(a),
        })),
        recentlyClosed: recentlyClosedProcesses(domain, world?.tickIndex),
        processSlots: canStartProcess(domain, ctx.config),
        plots: (domain.plotlines || []).map((p) => ({
          id: p.id,
          title: p.title,
          kind: p.kind === 'errand' ? 'errand' : p.kind === 'order' ? 'order' : 'story',
          hasProcess: Boolean((p.relatedProcessIds || []).length),
        })),
        guidanceProcesses:
          'processes[].progress — как дело шло в прошлом месяце: так и отвечай, если спрашивают. ' +
          'objectiveMonths — честная оценка срока, monthsLeft — сколько ещё ждут. ' +
          'pace=hurried — покровитель торопит, предупреди о риске; pace=careful — не спорь. ' +
          'fresh=true — дело ещё не сдвинулось: update_process может переписать его целиком. ' +
          'fresh=false — только дополни поручение и при нужде поменяй оставшийся срок (не меньше 1 мес.). ' +
          'recentlyClosed — недавно законченные дела: про них не говори «не знаю». ' +
          'Для update_process / revoke_process бери id из processes[].id. ' +
          'Если id не помнишь — передай краткий смысл дела в processId (например «университет»), система найдёт. ' +
          'Покровитель уточняет уже идущую ту же работу (новый вопрос к тому же дознанию, другой темп) — update_process, commitment=process. Не отказывай и не заводи второе. ' +
          'Общий храм, общий двор или общие имена — не дубль и не повод слить РАЗНЫЕ работы. ' +
          'initiative=ruler — это дело ты завёл сам, пока покровитель молчал; на вопрос «что ты решал» называй их.',
        guidancePlots:
          'plots[] — живые нити. kind=errand уже привязана к делу; kind=story может быть без поручения; kind=order — постоянный порядок, дело на него не заводи. ' +
          'Приказ по истории без дела — declare_process с plotId этой истории. ' +
          'Не бери id соседней нити из-за общего места или общих людей.',
      }),
    },
    {
      name: 'set_patron_name',
      description:
        'Запомнить или сменить имя/обращение к божеству-покровителю. Вызови, когда покровитель впервые назвал, как к нему обращаться, или попросил сменить имя.',
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
        const cleaned = String(name || '')
          .trim()
          .replace(/\s+/g, ' ')
          .slice(0, 64);
        if (cleaned.length < 2) {
          return toolFail(
            'too_short',
            'Имя покровителя слишком короткое. Передай нормальное имя или титул (от 2 символов).',
          );
        }
        if (!domain.state) domain.state = { events: [], modifiers: [], pendingActions: [], patronName: null };
        const prev = domain.state.patronName || null;
        domain.state.patronName = cleaned;
        await save();
        return {
          ok: true,
          patronName: cleaned,
          previous: prev,
          hint:
            `Дальше обращайся только так: «${cleaned}». ` +
            'Имена богов из хроник соседей и чужих храмов не используй.',
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
          { summary, detail, addDetail, remainingMonths, linkedStats, characterNote },
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
  ];
}

export class GameApp {
  constructor({ config, storage, runtime }) {
    this.config = config;
    this.storage = storage;
    this.runtime = runtime;
    this.outboundHandlers = new Set();
    this.generatingUsers = new Set();
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
    const log = getLogger().child({ userId: String(userId), channel, scope: 'chat' });
    const world = await this.storage.getWorld();
    const domain = await this.storage.getDomainForUser(userId, world.id);

    log.info('chat.inbound', {
      bootstrap,
      text: truncate(text, 400),
      hasDomain: Boolean(domain),
      domainId: domain?.id || null,
      generating: this.isGenerating(userId),
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
      if (this.isGenerating(userId)) {
        log.info('chat.busy_generating');
        return {
          reply:
            'Остров ещё создаётся — обычно минута-две. Правитель напишет сам, как будет готов. Подожди немного.',
          agent: 'onboarding',
          generating: true,
          domainId: null,
        };
      }
      return this.runOnboarding(userId, text, { channel, bootstrap, log });
    }

    return this.runRuler(domain, text, { channel, log, world });
  }

  startDomainGeneration(userId, { channel, forcedName, forcedTagChoices, playerBrief }) {
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
    if (!binding.onboarding.playerBrief) {
      binding.onboarding.playerBrief = { city: '', ruler: '', freeform: '' };
    }
    if (!('mode' in binding.onboarding)) binding.onboarding.mode = null;
    if (!('pitchedName' in binding.onboarding)) binding.onboarding.pitchedName = null;
    if (!binding.onboarding.pitchedTagChoices) binding.onboarding.pitchedTagChoices = {};
    return binding;
  }

  async runOnboarding(userId, text, { channel, bootstrap = false, log: parentLog } = {}) {
    const log = (parentLog || getLogger()).child({ scope: 'onboarding' });
    const binding = await this.getOrCreateOnboardingBinding(userId);
    const draft = binding.onboarding;
    let startedGenerating = false;

    log.info('onboarding.turn', {
      bootstrap,
      historyLen: (draft.messages || []).length,
      cityName: draft.cityName,
      approved: draft.cityNameApproved,
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
          tagChoices: draft.tagChoices,
          playerBrief: draft.playerBrief,
          cityName: draft.cityName,
          cityNameApproved: draft.cityNameApproved,
          canStart: Boolean(draft.cityNameApproved && draft.cityName),
          pitchedName: draft.pitchedName || null,
          modes: {
            quick: 'Рандом черт → предложить имя+атмосферу+все черты → аппрув/правки → старт',
            brief: 'Игрок дал краткое описание → додумать → аппрув → старт',
            questions: 'Наводящие вопросы по ходу, tools по ответам',
          },
        }),
      },
      {
        name: 'set_onboarding_mode',
        description: 'Зафиксировать режим онбординга: quick | brief | questions',
        parameters: {
          type: 'object',
          required: ['mode'],
          properties: {
            mode: {
              type: 'string',
              enum: ['quick', 'brief', 'questions'],
            },
          },
        },
        handler: async ({ mode }) => {
          draft.mode = mode;
          await saveDraft();
          return { ok: true, mode: draft.mode };
        },
      },
      {
        name: 'randomize_all_tags',
        description:
          'Быстрый режим: ОДИН раз заполнить все группы черт. Повторять только если игрок просит другой город. После питча forPlayer перескажи целиком.',
        parameters: { type: 'object', properties: {} },
        handler: async () => {
          const alreadyPitched = Boolean(
            draft.pitchedName ||
              draft.cityName ||
              Object.keys(draft.tagChoices || {}).length,
          );
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
          'Записать/обновить саммари пожеланий игрока для генезиса (город и правитель-связной). Можно вызывать несколько раз.',
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
          await saveDraft();
          return { ok: true, cityName: v.name };
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
          'Запуск генерации. Нужно утверждённое имя. Невыбранные теги — случайные. Brief уходит в генезис.',
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

    const history = (draft.messages || []).slice(-16).map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content,
    }));

    const isFirst = history.length === 0;
    const userContent = bootstrap || !String(text || '').trim()
      ? '[Игрок только что открыл чат. Это первый контакт — нужна вступительная речь.]'
      : text;

    const extraSystem = [
      'КАТАЛОГ ТЕГОВ (базис для random / быстрой генерации; группы не выдумывай):',
      formatTagCatalogForPrompt(this.config),
      '',
      isFirst
        ? [
            'ПЕРВЫЙ КОНТАКТ — только речь, без tools (кроме set_onboarding_mode после явного выбора — можно отложить).',
            'Расскажи: игрок — бог-покровитель; город-государство на изолированном летающем острове;',
            'правитель — НПС-связной; дальше диалог с ним; месяц сдвигает мир.',
            'Предложи ТРИ пути (своими словами, без нумерации 1.2.3.):',
            'быстрая генерация; краткое описание «чего хочу»; наводящие вопросы.',
            'Не вызывай start_new_game и не рандомь теги в питче.',
          ].join(' ')
        : [
            `Режим=${draft.mode || 'не выбран'};`,
            `черты=${formatTagChoicesForPlayer(this.config, draft.tagChoices)};`,
            `brief=${JSON.stringify(draft.playerBrief || {})};`,
            `питч=${draft.pitchedName || lastPitchedCityName(draft) || '—'};`,
            `имя=${draft.cityName || '—'} approved=${draft.cityNameApproved}.`,
            draft.pitchedName || Object.keys(draft.tagChoices || {}).length
              ? 'Город уже предложен. НЕ вызывай randomize_all_tags и не выдумывай новый. Согласие («да/начинаем/создавай») → set_city_name(питч) и start_new_game. Новый набор — только если игрок просит другой город. Вопрос «создаётся?» — не рандомь, либо стартуй уже предложенный, либо честно скажи что ждёшь подтверждения имени.'
              : 'Питча ещё нет. В quick один раз вызови randomize_all_tags, опиши город и спроси согласия.',
          ].join(' '),
    ].join('\n');
    const result = await this.runtime.run({
      agentId: 'onboarding',
      userMessages: [...history, { role: 'user', content: userContent }],
      tools,
      extraSystem,
      log,
      scene: 'onboarding',
    });

    // Страховка: агент сказал «записал», но не вызвал tools — сохраняем freeform сами.
    const usedTools = new Set((result.toolTrace || []).map((t) => t.name));
    const userSaidSomething =
      !bootstrap && String(text || '').trim().length >= 8 && !/^\[Игрок/.test(String(text));
    if (userSaidSomething && !usedTools.has('set_player_brief') && !usedTools.has('start_new_game')) {
      const looksLikeNameOnly =
        draft.cityNameApproved ||
        /^(давай|ок|хорошо|ладно|этот|выбираю)\b/i.test(String(text).trim()) ||
        (String(text).trim().length < 40 &&
          /^[\p{L}\p{M}\d\s\-']+$/u.test(String(text).trim()));
      if (!looksLikeNameOnly) {
        if (!draft.playerBrief) draft.playerBrief = { city: '', ruler: '', freeform: '' };
        const prev = draft.playerBrief.freeform || '';
        const chunk = String(text).trim();
        if (!prev.includes(chunk.slice(0, 40))) {
          draft.playerBrief.freeform = prev ? `${prev}\n${chunk}` : chunk;
        }
      }
    }
    if (
      userSaidSomething &&
      !usedTools.has('set_tag_choices') &&
      !usedTools.has('set_tag_choice') &&
      !usedTools.has('start_new_game')
    ) {
      const prefText = [
        draft.playerBrief?.city,
        draft.playerBrief?.freeform,
        text,
      ]
        .filter(Boolean)
        .join('\n');
      draft.tagChoices = inferTagChoicesFromText(this.config, prefText, draft.tagChoices || {});
    }

    let reply = result.text;
    if (startedGenerating && !String(reply || '').trim()) {
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
      const prefText = collectOnboardingPreferenceText(draft);
      draft.tagChoices = inferTagChoicesFromText(
        this.config,
        prefText,
        draft.tagChoices || {},
      );
      log.warn('onboarding.auto_start_new_game', {
        cityName: draft.cityName,
        reason: auto.reason,
      });
      this.startDomainGeneration(userId, {
        channel,
        forcedName: draft.cityName,
        forcedTagChoices: { ...draft.tagChoices },
        playerBrief: { ...(draft.playerBrief || {}) },
      });
      startedGenerating = true;
      reply = formatOnboardingStartReply(draft.cityName);
    } else if (auto.stripFalseStart) {
      log.warn('onboarding.false_start_claim', { replyPreview: truncate(reply, 200) });
      reply = ONBOARDING_FALSE_START_REPLY;
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
    if (nameInReply) {
      draft.pitchedName = nameInReply;
      draft.pitched = true;
      if (Object.keys(draft.tagChoices || {}).length) {
        draft.pitchedTagChoices = { ...draft.tagChoices };
      }
    }
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
        'КАНОН СТЫКОВКИ (реальность, не слух — говори об этом открыто и по имени):',
        `К острову приближается чужой летающий остров — город ${partnerName}.`,
        `До стыковки примерно ${left} мес. Событие неизбежно, это крупнейшая новость города.`,
        conflux.rematch
          ? 'Это ПОВТОРНАЯ стыковка: острова уже сходились раньше, город это помнит.'
          : 'Такого сближения город прежде не знал (с этим соседом).',
        'Если покровитель спрашивает про чужой остров — отвечай прямо: имя, срок, что это значит.',
        'ЗАПРЕЩЕНО говорить «не готов называть имя», «лишь слухи», «не знаю о чужих островах».',
        'Этот канон СИЛЬНЕЕ ответов лормастера: если он скажет «не подтверждено» — верь канону.',
      ]
        .filter(Boolean)
        .join('\n');
    }

    const contact = conflux.contact?.description
      ? `Характер стыка: ${conflux.contact.description}`
      : '';
    return [
      'КАНОН СТЫКОВКИ (идёт СЕЙЧАС — говори открыто и по имени):',
      `Остров состыкован с чужим островом — городом ${partnerName}.`,
      contact,
      `Стык длится ${conflux.monthsDocked || 0} мес. из ожидаемых ${conflux.durationMonths || '?'}.`,
      conflux.rematch ? 'Это повторная стыковка с этим соседом.' : '',
      'ЗАПРЕЩЕНО отрицать существование соседа или отказываться называть его имя.',
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
    const character = domain.characters[0];
    normalizeRulerAttitudes(character);
    const history = dialogHistoryForPrompt(character.dialogHistory || [], this.config);

    const conditionFeel = qualitativeStatsBrief(domain.stats || {}, this.config);
    const attitudes = formatRulerAttitudes(character, this.config);
    const patronName = domain.state?.patronName || null;
    const patronLine = patronName
      ? `Имя покровителя: «${patronName}» — обращайся так.`
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
    });

    // Здесь только данные хода. Правила поведения живут в instructions агента.
    const extraSystem = [
      `Ты ${character.name}, ${character.title || 'правитель'} города «${domain.name}».`,
      character.description,
      world?.gameDate?.label ? `ДАТА СЕЙЧАС: ${world.gameDate.label}.` : '',
      patronLine,
      confluxCanon,
      undockCanon,
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
          ].join('\n')
        : '',
    ]
      .filter(Boolean)
      .join('\n');

    const turn = { okTools: new Set(), reply: null, meta: null };
    const baseTools = characterTools(domain, this.storage, character, {
      config: this.config,
      runtime: this.runtime,
      world,
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
    // Внимание игрока → температура нитей числом; сцена дня → журнал месяца.
    const plotCfg = plotConfig(this.config);
    const warmed = warmPlotlines(fresh, turn.meta?.touchedPlotIds || [], plotCfg);
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
    await this.persistDialog(fresh, 'user', text);
    await this.persistDialog(fresh, 'assistant', reply, { meta: turn.meta });

    log.info('ruler.reply', {
      replyPreview: truncate(reply, 400),
      touchedPlots: warmed.map((w) => `${w.id}:${w.from}→${w.to}`),
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
          'ГЛАВНОЕ СОБЫТИЕ МЕСЯЦА — чужой летающий остров (сближение или стык).',
          'Начни письмо с него и говори прямо: назови город соседа, срок или характер стыка.',
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
          'ГЛАВНОЕ СОБЫТИЕ МЕСЯЦА — расстыковка летающих островов.',
          `Чужой остров (${partner}) УЛЕТЕЛ / ушёл в небо: пути между вами больше нет.`,
          'В письме ОБЯЗАТЕЛЬНО скажи прямо: острова разошлись в небе; силуэт чужого края ушёл в даль.',
          'Мост/переход можно упомянуть только как следствие: он исчез, ПОТОМУ ЧТО острова разъехались.',
          'ЗАПРЕЩЕНО оставлять впечатление, будто «просто мостик обвалился», а острова на месте.',
          `Назови ${partner} или «чужой остров» и глагол ухода (ушёл, улетел, растворился вдали, разошлись).`,
        ].join(' ')
      : '';

    const undockSystem = opts.undock
      ? [
          'Этот месяц — конец стыковки: два летающих острова РАЗОШЛИСЬ.',
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
              'Напиши покровителю письмо о месяце — вольный пересказ, НЕ дайджест и НЕ отчёт.',
              undockHint
                ? 'Сделай уход чужого острова в небо центральной нитью письма.'
                : confluxLead
                  ? 'Сделай чужой остров центральной нитью письма.'
                  : highlightLead
                    ? 'Главное событие месяца веди первым и подробнее прочего.'
                    : seedLead
                      ? 'Новую историю представь так, чтобы покровитель понял её без прошлого письма.'
                      : 'Бюджет письма: одна-две нити (дело, прорыв, беда) и при желании штрих. Мелочь опусти.',
              'ОБЯЗАТЕЛЬНО упомяни каждую [critical] запись СВОЕГО города — такое не заметить нельзя.',
              'Связная проза от первого лица, 1–3 коротких абзаца. Без списков, markdown, нумерации, канцелярита.',
              `Не начинай с «${character.name}:» — сразу текст письма.`,
              'Хроника нарочно сухая — это заметки, а не письмо. Оживи их своей речью, ' +
                'но не додумывай событий и не копируй формулировки. Статы и механики не упоминай.',
              addressHint,
              moodHint,
              stewardHint,
              presenceHint,
              scopeHint,
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
