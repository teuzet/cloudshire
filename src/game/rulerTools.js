/**
 * Тулы жреца: чтение города, дела, указы, ломастер, информатор, память.
 * Вызываются из GameApp.runRuler; submit_reply собирается отдельно.
 */

import { formatCastForPrompt, applyPatronName } from './models.js';
import {
  qualitativePopulation,
  qualitativeStatsBrief,
  formatRulerAttitudes,
  adjustAttitude,
  normalizeRulerAttitudes,
} from './stats.js';
import { askLoremaster } from './loremaster.js';
import { newId } from './ids.js';
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
import {
  formatBoardForSpeech,
  warmPlotlines,
  plotConfig,
  findPlotline,
  clipPlotText,
  PLOT_TITLE_MAX,
  PLOT_SUMMARY_MAX,
  isOrderPlot,
  isStakedStory,
  plotHasLiveProcess,
} from './plotlines.js';
import { queueOrderRequest, listStandingOrders } from './orders.js';
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
import { estimateProcessDuration } from './durationJudge.js';
import {
  ensureErrandForProcess,
  linkProcessToPlotline,
  rehomeUnrelatedProcess,
  plotSituationForSpeech,
  attendingQueueForPlot,
  detachProcessFromPlots,
} from './plotEngine.js';
import { judgeProcessAlignment, engagementOf, engagementAttends } from './plotAlign.js';
import { setNewsSchedule } from './newsSchedule.js';
import { writeRulerMemory, forgetRulerMemory } from './rulerMemory.js';
import { toolFail } from '../agents/toolResult.js';

function processPaceFeel(process) {
  const ratio = processPaceRatio(process);
  if (ratio < 0.95) return 'hurried';
  if (ratio > 1.05) return 'careful';
  return 'steady';
}

function paceHint(action, note = null) {
  const obj = action.objectiveMonths || action.expectedMonths;
  const left = action.monthsLeft;
  const ratio = processPaceRatio(action);
  const why = String(note || action.durationNote || '').trim();
  const reason = why ? ` ${why.replace(/\.*$/, '.')}` : '';
  if (ratio < 0.95) {
    return (
      `Честная оценка ${obj} мес., назначено ${action.expectedMonths} (осталось ${left}).${reason} ` +
      'В речи ПРИМИ срок покровителя и ПРЕДУПРЕДИ: спешка повышает риск тяжёлого исхода. ' +
      'Если настаивает — согласись, не торгуйся дальше. ' +
      'Не рапортуй итог до письма месяца.'
    );
  }
  if (ratio > 1.05) {
    return (
      `Честная оценка ${obj} мес., отвели ${action.expectedMonths}.${reason} ` +
      'Не спорь: будут делать обстоятельнее, риск провала ниже. Не рапортуй итог до письма месяца.'
    );
  }
  return `Работа займёт около ${obj} мес.${reason} Не рапортуй итог до письма месяца.`;
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
  if (!plot || !isStakedStory(plot) || !engagementAttends(engagementOf(action))) return '';
  const head = attendingQueueForPlot(domain, plot)[0];
  if (!head || String(head.id) === String(action.id)) return '';
  return (
    ` На этой беде уже идёт «${head.summary}». Новое дело в очереди: сдвинется, когда прежнее завершит месяц ` +
    '(или сразу в тот месяц, когда прежнее закончится). В речи можно сказать, что сначала доведут прежнее.'
  );
}

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
    if (requestKind !== 'order_long') {
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
            'order_long — велел работу (стройка, суд, поход, разовое дело — declare_process); ' +
            'постоянное правило — standing_order, не этот вид. ' +
            '«Так и оставить / сами справятся» — commitment=none. ' +
            'order_impossible — велел то, чего в этом мире не бывает ' +
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

export function buildRulerTools(domain, storage, character, ctx) {
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
          hasProcess: plotHasLiveProcess(domain, p),
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
          'blessed=true — покровитель благословил это дело: исход сдвинется на ступень вверх (провал→успех, успех→крит). ' +
          'pausedProcesses — на паузе: прогресс жив, слот свободен, тик не идёт. Снять паузу — resume_process, если есть слот. ' +
          'recentlyClosed[].outcome — итог [ПРОВАЛ] / [УСПЕХ] / [КРИТИЧЕСКИЙ УСПЕХ]; про них не говори «не знаю». ' +
          'Недавно закрытое дело сановника не занимает: он свободен для нового поручения. ' +
          'Если покровитель хочет сановника, у которого в officers/processes уже есть ИДУЩЕЕ дело — назови это дело и предложи pause_process или revoke_process, затем declare_process. ' +
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
        'Канонические неизвестности из брифа и скрытое открытой нити он не раскрывает; соседние бытовые пробелы может установить.',
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
        if (estimated.note) action.durationNote = estimated.note;
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
          : `В речи: принял повеление. ${paceHint(action, estimated.note)} ` +
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
        'НЕ закрывает и НЕ двигает открытую живую нить (плотлайн); это закрепляет правило на будущие месяцы. ' +
        'Если покровитель хочет сдвинуть открытую историю — используй declare_process с plotId. ' +
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
          if (estimated.note) action.durationNote = estimated.note;
        }
        syncErrandFromProcess(domain, action);
        if (plotId) {
          const current = findPlotline(domain, action.plotlineId);
          const target = findPlotline(domain, String(plotId));
          if (current?.kind === 'errand' && target && isStakedStory(target)) {
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
