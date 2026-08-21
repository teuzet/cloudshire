import { generateDomain, domainSummary } from './genesis.js';
import {
  chronicleEntries,
  newsChronicleEntries,
  filterChronicleForDomain,
  formatChronicleScope,
  normalizeDomain,
} from './models.js';
import {
  qualitativePopulation,
  qualitativeStatsBrief,
  formatRulerAttitudes,
  adjustAttitude,
  normalizeRulerAttitudes,
} from './stats.js';
import { askLoremaster } from './loremaster.js';
import { newId } from './ids.js';
import { assertsIslandsParted } from './conflux.js';
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
} from './onboarding.js';
import {
  normalizeDomainProcesses,
  normalizeProcess,
  guessProcessDuration,
  hasHardPatronDeadline,
  findDuplicateProcess,
  resolveLinkedStats,
  resolveActiveProcess,
  formatActiveProcessesForAgent,
  activeProcesses,
  canStartProcess,
} from './processes.js';
import { formatPlotBriefForSpeech } from './plotlines.js';
import { dialogHistoryForPrompt } from './memory.js';
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

function claimsOnboardingGenerating(text) {
  return /созда(ёт|ется|ётся|ю)|начинается\s+процесс|поднимаю\s+остров|остров.{0,30}созда|правитель.{0,50}(напиш|свяж)|жди.{0,30}минут/i.test(
    String(text || ''),
  );
}

function claimsOnboardingAlreadyCreated(text) {
  return /успешно\s+создан|уже\s+создан|остров.{0,20}готов|был\s+создан/i.test(String(text || ''));
}

/** Минимальная длительность процесса по смыслу поручения. */
function clampPendingDuration(summary, detail, duration) {
  return guessProcessDuration(summary, detail, duration);
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

/** Сколько подряд tick_news в конце истории без ответа игрока. */
function countTrailingUnansweredDigests(dialogHistory = []) {
  let n = 0;
  for (let i = dialogHistory.length - 1; i >= 0; i -= 1) {
    const m = dialogHistory[i];
    if (m.role === 'user') break;
    if (m.role === 'assistant' && m.kind === 'tick_news') n += 1;
  }
  return n;
}

function characterTools(domain, storage, character, ctx) {
  const save = async () => storage.saveDomain(domain);
  normalizeRulerAttitudes(character);
  normalizeDomainProcesses(domain, ctx.config);

  return [
    {
      name: 'read_domain_brief',
      description:
        'Состояние города: население, статы (эпитеты), активные дела/процессы. Для вопросов «как дела / сыты ли».',
      parameters: { type: 'object', properties: {} },
      handler: async () => ({
        ok: true,
        name: domain.name,
        status: domain.status,
        patronName: domain.state?.patronName || null,
        populationFeel: qualitativePopulation(domain.population || 0),
        conditionFeel: qualitativeStatsBrief(domain.stats || {}, ctx.config),
        attitudes: formatRulerAttitudes(character, ctx.config),
        guidance:
          'Отвечай в духе conditionFeel. Числа/id статов и «процесс/pending» игроку не называй. О делах говори по-человечески: что делается и сколько примерно ждать.',
        stateEvents: domain.state.events,
        stateModifiers: domain.state.modifiers || [],
        processes: activeProcesses(domain, ctx.config).map((a) => ({
          id: a.id,
          summary: a.summary,
          detail: a.detail,
          monthsLeft: a.monthsLeft,
          expectedMonths: a.expectedMonths,
          linkedStats: a.linkedStats,
        })),
        processSlots: canStartProcess(domain, ctx.config),
        guidanceProcesses:
          'Для update_process / revoke_process бери id из processes[].id. ' +
          'Если id не помнишь — передай краткий смысл дела в processId (например «университет»), система найдёт.',
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
          hint: `Дальше обращайся так: «${cleaned}». Не путай с чужими богами.`,
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
            'Перескажи СУТЬ своими словами и тоном правителя. Не копируй текст фактов/answers дословно. Не говори «неизвестно», если answers заполнены.',
        };
      },
    },
    {
      name: 'declare_process',
      description:
        'Длительное дело: стройка, суд, поход, снабжение. Не для мгновенных постоянных приказов — declare_standing_order. ' +
        'Отказы: too_many_processes (лимит слотов) vs duplicate_process (та же нить) — разные отговорки в речи.',
      parameters: {
        type: 'object',
        required: ['summary', 'detail', 'expectedMonths', 'linkedStats'],
        properties: {
          summary: { type: 'string' },
          detail: {
            type: 'string',
            description:
              'Если покровитель задал жёсткий срок («в этом месяце») — отрази это в detail дословно по смыслу.',
          },
          expectedMonths: {
            type: 'number',
            description:
              'Срок в месяцах (1–12). При жёстком дедлайне покровителя — его срок, не раздувай «типичным».',
          },
          linkedStats: {
            type: 'array',
            items: { type: 'string' },
            minItems: 1,
            description: 'Статы прогресса: prosperity|faith|culture|stability|knowledge|might',
          },
          onBehalfOf: { type: 'string', default: 'patron' },
          characterNote: { type: 'string' },
        },
      },
      handler: async ({
        summary,
        detail,
        expectedMonths,
        linkedStats,
        onBehalfOf = 'patron',
        characterNote,
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
              'В речи: отчитайся об уже идущем деле; при нужде update_process или revoke_process. ' +
              'Не выдумывай отговорку про «слишком много дел» и не обещай вторую такую же нить.',
          };
        }
        const asked = Math.max(1, Math.min(12, Math.round(Number(expectedMonths) || 1)));
        const hard = hasHardPatronDeadline(summary, detail);
        const duration = hard ? asked : clampPendingDuration(summary, detail, asked);
        const linked = resolveLinkedStats(linkedStats, ctx.config);
        if (!linked.length) {
          return toolFail(
            'linked_stats_required',
            `linkedStats обязательны — выбери 1+ id из: ${(ctx.config.stats || []).map((s) => s.id).join(', ')}. ` +
              'Повтори declare_process с валидными linkedStats.',
          );
        }
        const action = {
          id: newId('act'),
          summary,
          detail,
          expectedMonths: duration,
          durationMonths: duration,
          monthsLeft: duration,
          monthsDone: 0,
          linkedStats: linked,
          onBehalfOf,
          characterId: character.id,
          characterName: character.name,
          characterNote: characterNote || null,
          hardDeadline: hard,
          status: 'active',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        domain.state.pendingActions.push(action);
        await save();
        const clamped =
          duration > asked ? ` Оценка срока ${duration} мес. (было ${asked}).` : '';
        const deadlineHint = hard
          ? ` Жёсткий срок покровителя соблюдён: ${duration} мес. Если считаешь нереалистичным — скажи честно в речи (риск срыва), но не раздувай срок.`
          : '';
        return {
          ok: true,
          process: action,
          hint:
            `В речи: принял дело, примерно ${duration} мес., ещё не сделано. ` +
            `ЗАПРЕЩЕНО говорить «намерение объявлено», «процесс запущен», pending, declare.${clamped}${deadlineHint}`,
        };
      },
    },
    {
      name: 'declare_standing_order',
      description:
        'Постоянный порядок / правило без многомесячной подготовки (запрет, осмотр, правило улиц). ' +
        'Пишет в state.modifiers. Не для строек, судов, походов — те через declare_process.',
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
        if (!domain.state) domain.state = { events: [], modifiers: [], pendingActions: [], patronName: null };
        if (!Array.isArray(domain.state.modifiers)) domain.state.modifiers = [];
        const list = domain.state.modifiers;
        let mod = id ? list.find((m) => m.id === id) : null;
        if (!mod) {
          const dup = list.find(
            (m) =>
              String(m.text || '')
                .toLowerCase()
                .includes(body.toLowerCase().slice(0, 40)) ||
              body.toLowerCase().includes(String(m.text || '').toLowerCase().slice(0, 40)),
          );
          if (dup) {
            dup.text = body;
            dup.kind = 'order';
            dup.updatedAt = new Date().toISOString();
            await save();
            return {
              ok: true,
              created: false,
              modifier: dup,
              hint: 'Порядок обновлён. В речи: коротко подтверди, что так и будет соблюдаться. Без «процесс»/месяцев.',
            };
          }
          mod = {
            id: newId('mod'),
            text: body,
            kind: 'order',
            since: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            by: character.name,
          };
          list.push(mod);
          await save();
          return {
            ok: true,
            created: true,
            modifier: mod,
            hint:
              'В речи: принял как постоянный порядок, начнут соблюдать. Не объявляй многомесячный срок и не говори «процесс».',
          };
        }
        mod.text = body;
        mod.kind = 'order';
        mod.updatedAt = new Date().toISOString();
        await save();
        return {
          ok: true,
          created: false,
          modifier: mod,
          hint: 'Порядок обновлён. Подтверди в речи коротко.',
        };
      },
    },
    {
      name: 'update_process',
      description:
        'Уточнить активное длительное дело. processId — id из read_domain_brief или краткий смысл («университет»).',
      parameters: {
        type: 'object',
        required: ['processId'],
        properties: {
          processId: {
            type: 'string',
            description: 'Id процесса (act_…) или ключевые слова из summary',
          },
          summary: { type: 'string' },
          detail: { type: 'string' },
          linkedStats: { type: 'array', items: { type: 'string' } },
          characterNote: { type: 'string' },
        },
      },
      handler: async ({ processId, summary, detail, linkedStats, characterNote }) => {
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
        if (summary) action.summary = summary;
        if (detail) action.detail = detail;
        if (linkedStats) {
          const linked = resolveLinkedStats(linkedStats, ctx.config);
          if (linked.length) action.linkedStats = linked;
        }
        if (characterNote !== undefined) action.characterNote = characterNote;
        action.updatedAt = new Date().toISOString();
        normalizeProcess(action, ctx.config);
        await save();
        return { ok: true, process: action };
      },
    },
    {
      name: 'revoke_process',
      description:
        'Отозвать / свернуть длительное дело. processId — id из brief или смысл («университет», «учебная программа»).',
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
      name: 'declare_action',
      description: 'Устарело — вызови declare_process (нужны linkedStats)',
      parameters: {
        type: 'object',
        required: ['summary', 'detail', 'durationMonths'],
        properties: {
          summary: { type: 'string' },
          detail: { type: 'string' },
          durationMonths: { type: 'number' },
          linkedStats: { type: 'array', items: { type: 'string' } },
          onBehalfOf: { type: 'string' },
          characterNote: { type: 'string' },
        },
      },
      handler: async (args) => {
        const declare = characterTools(domain, storage, character, ctx).find((t) => t.name === 'declare_process');
        return declare.handler({
          ...args,
          expectedMonths: args.durationMonths,
          linkedStats: args.linkedStats?.length ? args.linkedStats : ['stability'],
        });
      },
    },
    {
      name: 'update_action',
      description: 'Устарело — update_process',
      parameters: {
        type: 'object',
        required: ['actionId'],
        properties: {
          actionId: { type: 'string' },
          summary: { type: 'string' },
          detail: { type: 'string' },
          characterNote: { type: 'string' },
        },
      },
      handler: async ({ actionId, ...rest }) => {
        const t = characterTools(domain, storage, character, ctx).find((x) => x.name === 'update_process');
        return t.handler({ processId: actionId, ...rest });
      },
    },
    {
      name: 'revoke_action',
      description: 'Устарело — revoke_process',
      parameters: {
        type: 'object',
        required: ['actionId'],
        properties: {
          actionId: { type: 'string' },
          reason: { type: 'string' },
        },
      },
      handler: async ({ actionId, reason }) => {
        const t = characterTools(domain, storage, character, ctx).find((x) => x.name === 'revoke_process');
        return t.handler({ processId: actionId, reason });
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
  }

  onOutbound(handler) {
    this.outboundHandlers.add(handler);
    return () => this.outboundHandlers.delete(handler);
  }

  async emitOutbound(userId, message, meta = {}) {
    for (const handler of this.outboundHandlers) {
      await handler({ userId: String(userId), message, ...meta });
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
      },
      domainCount: domains.length,
      tickIntervalHours: this.config.tick.intervalHours,
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
    });

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

    return this.runRuler(domain, text, { channel, log });
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
        await this.emitOutbound(uid, 'Создаю твой летающий остров… Это займёт около минуты-двух.', {
          channel,
          agent: 'onboarding',
          kind: 'generating',
        });

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
          onProgress: (msg) => log.info('genesis.progress', { message: msg }),
        });

        const intro = domain._greeting.startsWith(domain.characters[0].name)
          ? domain._greeting
          : `${domain.characters[0].name}: ${domain._greeting}`;

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
        });
      } catch (err) {
        log.error('genesis.failed', {
          error: err.message,
          stack: err.stack,
        });
        await this.emitOutbound(
          uid,
          `Не удалось создать остров: ${err.message || err}. Можно поправить имя/теги и снова попросить старт.`,
          { channel, agent: 'onboarding', kind: 'generating_error' },
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
          'Быстрый режим: случайно заполнить ВСЕ группы черт из каталога. В ответе forPlayer — текст, который ОБЯЗАТЕЛЬНО перескажи игроку вместе с именем и атмосферой.',
        parameters: { type: 'object', properties: {} },
        handler: async () => {
          const { chosen, applied, forPlayer } = randomizeAllTags(this.config);
          draft.tagChoices = chosen;
          await saveDraft();
          return {
            ok: true,
            applied,
            chosen: draft.tagChoices,
            forPlayer,
            next:
              'Запиши атмосферу и правителя в set_player_brief. Сам придумай звучный топоним (не из списка — списка нет). ' +
              'В речи игроку: имя + ВСЕ черты из forPlayer своими словами + атмосфера + правитель. ' +
              'Без слов «теги/изюминка/пакет/рандом».',
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
            return toolFail(
              'city_name_required',
              'Сначала утверди имя города через set_city_name (с согласия игрока), затем start_new_game.',
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
            `имя=${draft.cityName || '—'} approved=${draft.cityNameApproved}`,
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
      reply = `Отлично. Поднимаю остров «${draft.cityName}» — обычно минута-две. Правитель напишет сам.`;
    }

    // Страховка: агент написал «создаётся», но не вызвал start_new_game.
    if (
      draft.cityNameApproved &&
      draft.cityName &&
      !usedTools.has('start_new_game') &&
      !this.isGenerating(userId) &&
      (claimsOnboardingGenerating(reply) || claimsOnboardingAlreadyCreated(reply))
    ) {
      log.warn('onboarding.auto_start_new_game', {
        cityName: draft.cityName,
        reason: 'reply claimed generating without tool',
      });
      const prefText = collectOnboardingPreferenceText(draft);
      draft.tagChoices = inferTagChoicesFromText(
        this.config,
        prefText,
        draft.tagChoices || {},
      );
      this.startDomainGeneration(userId, {
        channel,
        forcedName: draft.cityName,
        forcedTagChoices: { ...draft.tagChoices },
        playerBrief: { ...(draft.playerBrief || {}) },
      });
      startedGenerating = true;
      reply = `Отлично. Поднимаю остров «${draft.cityName}» — обычно минута-две. Правитель напишет сам.`;
    }

    // Нельзя говорить «уже создан», пока генезис только стартовал.
    if (startedGenerating || this.isGenerating(userId)) {
      if (claimsOnboardingAlreadyCreated(reply) || !String(reply || '').trim()) {
        reply = `Отлично. Поднимаю остров «${draft.cityName}» — обычно минута-две. Правитель напишет сам.`;
      }
    }

    draft.messages = draft.messages || [];
    if (!bootstrap || String(text || '').trim()) {
      draft.messages.push({ role: 'user', content: text || userContent, at: new Date().toISOString() });
    }
    draft.messages.push({ role: 'assistant', content: reply, at: new Date().toISOString() });
    if (draft.messages.length > 40) draft.messages = draft.messages.slice(-30);
    draft.pitched = true;
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

  async runRuler(domain, text, { channel, log: parentLog }) {
    const log = (parentLog || getLogger()).child({
      scope: 'ruler',
      domainId: domain.id,
      domainName: domain.name,
    });
    log.info('ruler.turn', { text: truncate(text, 400) });
    normalizeDomain(domain);
    const character = domain.characters[0];
    normalizeRulerAttitudes(character);
    const history = dialogHistoryForPrompt(character.dialogHistory || [], this.config);

    const conditionFeel = qualitativeStatsBrief(domain.stats || {}, this.config);
    const attitudes = formatRulerAttitudes(character, this.config);
    const patronName = domain.state?.patronName || null;
    const patronLine = patronName
      ? `Имя покровителя (обращение): «${patronName}». Обращайся так. Чужих богов и имён с других островов НЕ используй.`
      : 'Имя покровителя ещё НЕ названо — коротко спроси, как к нему обращаться; когда скажет — сразу set_patron_name.';
    const undock = recentUndockFact(domain);
    const undockCanon = undock
      ? [
          'КАНОН НЕДАВНЕЙ РАССТЫКОВКИ (если спрашивают про мост/соседа/конец стыка — опирайся на это):',
          undock.text,
          'Суть: чужой ЛЕТАЮЩИЙ ОСТРОВ ушёл в небо. Мост/переход кончился потому, что края островов разъехались — не «просто мостик обвалился».',
        ].join('\n')
      : '';
    const plotBrief = formatPlotBriefForSpeech(domain);
    const extraSystem = [
      `Ты ${character.name}, ${character.title || 'правитель'} города «${domain.name}».`,
      character.description,
      this.config.world.cosmology || '',
      patronLine,
      undockCanon,
      'ОБСТОЯТЕЛЬСТВА ГОРОДА СЕЙЧАС (внутренняя правда; числа игроку не называй):',
      `Население: ${qualitativePopulation(domain.population || 0)}`,
      conditionFeel,
      'ОТНОШЕНИЕ К ПОКРОВИТЕЛЮ (внутренняя правда; цифры игроку не называй):',
      attitudes,
      plotBrief
        ? [
            'ЖИВЫЕ НИТИ СЮЖЕТА (внутренняя правда; не рапортуй списком — вплетай в речь, если уместно):',
            plotBrief,
          ].join('\n')
        : '',
      'На вопросы о сытости, богатстве, вере, порядке, силе, знаниях опирайся на эпитеты обстоятельств.',
      'Высокая лояльность или ужас → охотнее соглашайся и исполняй, особенно при должном тоне; меньше торгов и отговорок.',
      'Низкие оба → больше сомнений и торгов (пока нет жёсткого приказа).',
      'По ходу разговора при заметном жесте — adjust_loyalty и/или adjust_terror.',
      'Форма: 1–3 абзаца живой прозы. Без списков, markdown, канцелярита, английских слов, сервисных «чем помочь».',
      `ЗАПРЕЩЕНО начинать ответ с «${character.name}:» или любого «Имя:» — пиши сразу речь.`,
      'Постоянные приказы без стройки (запреты, осмотры, правила) → declare_standing_order, не declare_process.',
      'Долгие дела: declare_process (срок + linkedStats). Если покровитель сказал «в этом месяце» — отрази в detail, expectedMonths=1; не раздувай срок. Если нереально — честно возрази ДО declare.',
      'Не дублируй уже идущую смысловую нить (второй суд, вторая та же стройка) — update/revoke.',
      'Если declare_process вернул отказ (слишком много дел) — придумай отмазку; новое дело не обещай.',
      'ЗАПРЕЩЕНО в речи: «намерение объявлено», «процесс запущен», pending, declare, JSON.',
      'Факты лормастера перескажи своими словами.',
      'Если покровитель просит сменить имя/обращение — set_patron_name, затем подтверди.',
    ]
      .filter(Boolean)
      .join('\n');

    const result = await this.runtime.run({
      agentId: 'ruler',
      userMessages: [...history, { role: 'user', content: text }],
      tools: characterTools(domain, this.storage, character, {
        config: this.config,
        runtime: this.runtime,
      }),
      extraSystem,
      log,
      scene: 'ruler',
      domainId: domain.id,
    });

    let reply = result.text || '';
    if (looksLikeToolDump(reply)) {
      log.warn('ruler.tool_dump_sanitized', { preview: truncate(reply, 200) });
      const retry = await this.runtime.run({
        agentId: 'ruler',
        userMessages: [
          ...history,
          { role: 'user', content: text },
          {
            role: 'assistant',
            content: '(черновик отклонён: похож на вызов инструмента, не на речь)',
          },
          {
            role: 'user',
            content:
              'Перепиши ответ обычной речью правителя по-русски, 1–3 абзаца. ' +
              'Без tools.*, JSON, declare_action и англоязычного мусора. ' +
              `Не начинай с «${character.name}:». ` +
              'Если нужно действие — оно уже могло уйти через tools; в речи только намерение.',
          },
        ],
        tools: [],
        maxTurns: 1,
        extraSystem,
        log,
        scene: 'ruler_retry',
        domainId: domain.id,
      });
      reply = retry.text || '';
      if (looksLikeToolDump(reply) || !String(reply).trim()) {
        reply =
          `${patronName || 'Покровитель'}, прости — мысль сбилась. ` +
          'Повтори волю коротко, и я исполню без путаницы.';
      }
    }
    reply = stripSpeakerPrefix(reply, character.name);

    const fresh = await this.storage.getDomain(domain.id);
    await this.persistDialog(fresh, 'user', text);
    await this.persistDialog(fresh, 'assistant', reply);

    log.info('ruler.reply', {
      replyPreview: truncate(reply, 400),
      tools: (result.toolTrace || []).map((t) => ({
        name: t.name,
        ok: t.result?.ok !== false,
      })),
    });

    return {
      reply,
      domainId: fresh.id,
      agent: 'ruler',
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

    const facts = forNews
      .map((c) => {
        const scope = formatChronicleScope(c);
        const onlyOther =
          Array.isArray(c.concernsDomainIds) &&
          c.concernsDomainIds.length === 1 &&
          String(c.concernsDomainIds[0]) !== String(domain.id);
        const framing = onlyOther
          ? ' [чужой город — перескажи как новость ОТТУДА, кратко кто/что; НЕ говори «я сделал»]'
          : '';
        return `- [${c.importance || 'event'}] ${scope}${c.text}${framing}`;
      })
      .join('\n');
    const patronName = domain.state?.patronName || null;
    const addressHint = patronName
      ? `Обращайся к покровителю как «${patronName}». Не подменяй чужим именем бога.`
      : 'Имя покровителя неизвестно — обратись «покровитель», без выдуманных имён.';

    const scopeHint = forNews.some((c) => c.location || c.concernsDomainNames?.length)
      ? [
          'У записей есть пометки «где» и «касается».',
          'События только чужого города — новости с соседнего острова: назови город, коротко представь незнакомых людей.',
          'Не присваивай чужие дела себе и своему городу.',
        ].join(' ')
      : '';

    const unanswered = countTrailingUnansweredDigests(character.dialogHistory || []);
    const askPresence = unanswered >= 2;
    const presenceHint = askPresence
      ? [
          'ВАЖНО: покровитель молчит уже несколько месяцев подряд (не отвечал после прошлых писем о месяце).',
          'В конце письма коротко, по-человечески спроси: слышит ли он тебя ещё, не оставил ли город без знака.',
          'Без истерики и без сервисного тона — тревога слуги, 1–2 предложения.',
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
              `Прошёл месяц (${gameDate.label}). Ниже сырая хроника для тебя (не факты лормастера).`,
              'Напиши покровителю письмо о месяце — вольный пересказ, НЕ дайджест и НЕ отчёт.',
              undockHint
                ? 'Сделай уход чужого острова в небо центральной нитью письма.'
                : 'Бюджет письма: одна главная нить (дело/прорыв) и при желании один побочный штрих. Остальное опусти.',
              'Связная проза от первого лица, 1–3 коротких абзаца. Без списков, markdown, нумерации, канцелярита.',
              `Не начинай с «${character.name}:» — сразу текст письма.`,
              'Не копируй формулировки хроники. Не упоминай статы и механики.',
              addressHint,
              presenceHint,
              scopeHint,
              undockHint,
              extraUserNote,
              '',
              facts,
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
          formatPlotBriefForSpeech(domain)
            ? `Если уместно, вплети живые нити (не списком):\n${formatPlotBriefForSpeech(domain)}`
            : '',
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

  async persistDialog(domain, role, content, { kind = null } = {}) {
    const character = domain.characters[0];
    if (!character) return;
    character.dialogHistory = character.dialogHistory || [];
    const entry = {
      role,
      content,
      at: new Date().toISOString(),
    };
    if (kind) entry.kind = kind;
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
      initUsageRecording(this.config, newWorldId);
    }
    getLogger().info('world.rotated', {
      archivedWorldId: result.archivedWorldId || null,
      newWorldId: newWorldId || null,
      archiveDir: result.archiveDir || null,
    });
    return result;
  }
}
