import { buildOnboardingTools } from './onboardingTools.js';
import {
  chronicleEntries,
  formatChroniclePriestMark,
  normalizeDomain,
  inferRulerGender,
} from './models.js';
import { normalizeRulerAttitudes } from './stats.js';
import { noteRulerActivity } from './activity.js';
import { confluxConfig, daysUntilDock, remainingDockDays } from './confluxTime.js';
import { findActiveConfluxForDomain, formatContactForPrompt } from './conflux.js';
import {
  overlayConfluxView,
  overlayWithPartner,
  stampNewBoardItems,
  stripConfluxView,
} from './confluxBoard.js';
import { formatPassageForPrompt } from './passage.js';
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
  claimsOnboardingGenerating,
  extractPitchedCityName,
  lastPitchedCityName,
  playerAsksReroll,
  planOnboardingAutoStart,
  formatOnboardingStatusCard,
  appendOnboardingToolErrors,
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
  ONBOARDING_STORE_MESSAGES,
  GENESIS_WATCHDOG_MS,
  LONG_USER_MESSAGE_MIN,
  BRIEF_CITY_MAX,
  BRIEF_RULER_MAX,
  BRIEF_FREEFORM_MAX,
} from './onboarding.js';
import { blessProcess, processOwnedBy } from './processes.js';
import { spendTurnMana } from './mana.js';
import {
  DomainQueue,
  beginRulerTurn,
  endRulerTurn,
  worldDay,
  holdClock,
  releaseClock,
  clockIsHeld,
  mergeWorldJobs,
} from './scheduler.js';
import { syncWorldClock } from './gameClock.js';
import { findPlotline, findClosedPlotline, isStoryPlot } from './plotlines.js';
import { plantStakedStory } from './storyteller.js';
import {
  ensurePlotObligations,
  fireThreatEvent,
  firePressureEvent,
  resolveDeedEvent,
  cancelDeedJobs,
  schedulePressureJob,
} from './worldLoop.js';
import { ensurePressure } from './pressure.js';
import { deliverEvent, settleEvents } from './dayLoop.js';
import { findThreat } from './threats.js';
import {
  packPlaySeedGrain,
  dropPlayStory as applyDropPlayStory,
  parsePlayDeedFinish,
} from './playDev.js';
import {
  captureLiveWorld,
  writePlaySnapshot,
  listPlaySnapshots,
  readPlaySnapshot,
  deletePlaySnapshot,
  restoreLiveWorld,
} from './playSnapshot.js';
import { islandDeleteCheck } from '../clients/telegram/access.js';
import { generateIslandImage, removeIslandImage } from './islandImage.js';
import { generateOfficerPortraits, removeOfficerPortraits } from './officerImage.js';
import { generateDomain } from './genesis.js';
import { formatIslandReveal } from './islandReveal.js';
import { formatProgressBar, genesisTutorialText } from './progressBar.js';
import { genesisDateMessage } from './tickClock.js';
import { dialogHistoryForPrompt } from './memory.js';
import {
  formatRulerVoiceForPrompt,
  shouldRulerAskPatron,
  markRulerAsked,
} from './rulerMemory.js';
import { resolveReply, formatReplyForPrompt, rememberPush } from './replyContext.js';
import { clearPatronPresenceAsked } from './steward.js';
import { getLogger, truncate, setLoggerWorldId } from '../log.js';
import { initUsageRecording } from '../llm/usage.js';
import { initCityAgentLogRecording } from './cityAgentLog.js';
import { purgeDomainMedia } from '../storage/r2.js';
import { buildRulerTools, submitReplyTool, formatPriestTurn } from './rulerTools.js';
export { rulerReplyCommitError } from './rulerTools.js';

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
  if (/declare_action|declare_process|consult_loremaster|set_proxy/i.test(t) && /\{/.test(t)) {
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

function findPlayLoreFact({ domain, conflux, partner }, factId) {
  const id = String(factId || '');
  if (!id) return null;
  for (const lore of [domain?.lore, conflux?.lore, partner?.lore]) {
    const hit = (lore || []).find((f) => String(f.id) === id);
    if (hit) return hit;
  }
  return null;
}

function findPlayPlot({ domain, conflux, partner }, plotId) {
  const id = String(plotId || '');
  if (!id) return null;
  return (
    findPlotline(domain, id) ||
    findClosedPlotline(domain, id) ||
    (partner ? findPlotline(partner, id) || findClosedPlotline(partner, id) : null) ||
    (conflux?.plotlines || []).find((p) => String(p.id) === id) ||
    (conflux?.closedPlotlines || []).find((p) => String(p.id) === id) ||
    null
  );
}

function occasionFromChronicleFact(fact) {
  const author = String(fact?.author || '');
  const tags = fact?.tags || [];
  if (author.includes('seed') || tags.includes('opening')) return 'новая история';
  if (author.includes('threat') || tags.includes('threat')) return 'угроза';
  if (fact?.processFinish) return 'развязка';
  return 'дело';
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
    this.generatingTimeouts = new Map();
    /** Текст прогресса генезиса (для Telegram edit и баннера /play). */
    this.generatingProgress = new Map();
    /** Пока идёт world tick — чат с доменом отвечает системно. */
    this.worldTicking = false;
    /** Дневной цикл: чем разбудить мир сразу после хода правителя. */
    this.onClockReleased = null;
    /** Принудительный посев из тестового клиента — не класть второй поверх. */
    this.seedingUsers = new Set();
    /** Кнопки инспектора: угроза или исход дела — по одному за раз. */
    this.playForcing = false;
    /**
     * Один писатель на город. Ход правителя и шаг дневного цикла держат эту
     * очередь по очереди: иначе тот, кто сохранит вторым, затрёт чужую работу.
     */
    this.domainQueue = new DomainQueue();
  }

  /** Всё, что меняет город, идёт через очередь города. */
  withDomain(domainId, fn) {
    return this.domainQueue.run(domainId, fn);
  }

  /** Город прямо сейчас правит кто-то другой — дневной цикл или ход правителя. */
  isDomainBusy(domainId) {
    return this.domainQueue.busy(domainId);
  }

  /**
   * Взять замок города и перечитать его: копия, прочитанная до замка, уже
   * могла устареть, пока ждали своей очереди.
   */
  async withFreshDomain(domainId, fn) {
    return this.withDomain(domainId, async () => {
      const domain = await this.storage.getDomain(domainId);
      if (!domain) return { ok: false, error: 'no_domain', message: 'города ещё нет' };
      normalizeDomain(domain);
      return fn(domain);
    });
  }

  /** Донести до хранилища задания, поставленные в свою копию мира. */
  async commitWorldJobs(mine) {
    await this.storage.updateWorld((world) => mergeWorldJobs(world, mine));
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

  /** Запомнить, о чём был отправленный пуш: реплай должен разрешаться в объект. */
  async recordPushMessage(domainId, entry) {
    const domain = await this.storage.getDomain(domainId);
    if (!domain) return null;
    const saved = rememberPush(domain, entry);
    if (!saved) return null;
    await this.storage.saveDomain(domain);
    return saved;
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

  async handleUserMessage(userId, text, { channel = 'web', bootstrap = false, replyTo = null } = {}) {
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

      if (domain && (this.isWorldTicking() || this.isDomainBusy(domain.id))) {
        const label = world.gameDate?.label || 'новый месяц';
        log.info('chat.busy_ticking', { domainBusy: this.isDomainBusy(domain.id) });
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

      // Ход держит город целиком: инструменты жреца пишут его же.
      return await this.withDomain(domain.id, async () => {
        try {
          return await this.runRuler(domain, text, { channel, log, world, replyTo });
        } catch (err) {
          log.error('ruler.turn_failed', { error: err.message, stack: err.stack });
          return await this.persistRulerSystemFail(domain, text, { channel, log });
        }
      });
    } finally {
      this.busyUsers.delete(uid);
    }
  }

  startDomainGeneration(userId, { channel, forcedName, forcedPatronName, forcedPatronGender, frozenConcept, axes, playerDirectives, playerBrief }) {
    const uid = String(userId);
    if (this.generatingUsers.has(uid)) {
      getLogger().warn('genesis.already_running', { userId: uid });
      return;
    }
    this.generatingUsers.add(uid);
    this.armGenesisWatchdog(uid, channel);
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
          forcedPatronGender: forcedPatronGender || null,
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
            else if (/сил|сановн|столп/i.test(label)) step = 3;
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
        if (picture) {
          domain.imagePath = picture.path || null;
          domain.imageUrl = picture.url || null;
          domain.imageKey = picture.key || null;
          domain.imageBase64 = picture.url ? null : picture.base64 || null;
          await this.storage.saveDomain(domain);
        }

        await pushProgress(5, 'остров готов');
        const reveal = formatIslandReveal(domain);
        await this.emitOutbound(uid, reveal, {
          channel,
          agent: 'onboarding',
          domainId: domain.id,
          kind: 'island_reveal',
          photoUrl: picture?.url || null,
          photoPath: picture?.abs || null,
        });
        const dateNote = genesisDateMessage(await this.storage.getWorld());
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
          imageUrl: domain.imageUrl || null,
        });
      } catch (err) {
        log.error('genesis.failed', {
          error: err.message,
          stack: err.stack,
        });
        await this.resetOnboardingAfterGenesisFail(uid);
        await this.emitOutbound(
          uid,
          `Не удалось создать остров: ${err.message || err}. Остров не создан. Можно снова попросить старт.`,
          { channel, agent: 'onboarding', kind: 'generating_error', edit: 'genesis' },
        );
      } finally {
        this.clearGenesisWatchdog(uid);
        this.generatingUsers.delete(uid);
      }
    };

    setImmediate(() => {
      run().catch((err) =>
        log.error('genesis.unhandled', { error: err.message, stack: err.stack }),
      );
    });
  }

  armGenesisWatchdog(userId, channel) {
    const uid = String(userId);
    this.clearGenesisWatchdog(uid);
    const timer = setTimeout(() => {
      void this.failStuckGeneration(uid, channel);
    }, GENESIS_WATCHDOG_MS);
    this.generatingTimeouts.set(uid, timer);
  }

  clearGenesisWatchdog(userId) {
    const uid = String(userId);
    const timer = this.generatingTimeouts.get(uid);
    if (timer) clearTimeout(timer);
    this.generatingTimeouts.delete(uid);
  }

  async failStuckGeneration(userId, channel) {
    const uid = String(userId);
    if (!this.generatingUsers.has(uid)) return;
    this.generatingUsers.delete(uid);
    this.generatingTimeouts.delete(uid);
    getLogger().error('genesis.watchdog', { userId: uid });
    await this.resetOnboardingAfterGenesisFail(uid);
    await this.emitOutbound(
      uid,
      'Не удалось создать остров: слишком долго. Остров не создан. Можно снова попросить старт.',
      { channel, agent: 'onboarding', kind: 'generating_error', edit: 'genesis' },
    );
  }

  async resetOnboardingAfterGenesisFail(userId) {
    try {
      const binding = await this.getOrCreateOnboardingBinding(userId);
      if (!binding?.onboarding) return;
      binding.onboarding.phase = deriveOnboardingPhase(binding.onboarding, { generating: false });
      binding.updatedAt = new Date().toISOString();
      await this.storage.saveUserBinding(binding);
    } catch (err) {
      getLogger().warn('genesis.reset_draft_failed', { error: err.message });
    }
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

    const auto = planOnboardingAutoStart({
      userText: text,
      reply,
      draft,
      usedStart: startFlag.started,
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
        forcedPatronGender: draft.patronGender || null,
        frozenConcept: draft.concept,
        axes: draft.axes,
        playerDirectives: draft.playerDirectives,
        playerBrief: { ...(draft.playerBrief || {}) },
      });
      startedGenerating = true;
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

    // Старт говорит только система (прогресс-бар). Речь агента про «уже готов» срезаем.
    if (startedGenerating || this.isGenerating(userId)) {
      if (claimsOnboardingAlreadyCreated(reply) || claimsOnboardingGenerating(reply)) {
        reply = '';
      }
    }

    reply = appendOnboardingToolErrors(reply, result.toolTrace);

    draft.messages = draft.messages || [];
    if (!bootstrap || String(text || '').trim()) {
      draft.messages.push({ role: 'user', content: text || userContent, at: new Date().toISOString() });
    }
    draft.messages.push({ role: 'assistant', content: reply, at: new Date().toISOString() });
    if (draft.messages.length > ONBOARDING_STORE_MESSAGES) {
      draft.messages = draft.messages.slice(-Math.max(ONBOARDING_HISTORY_MESSAGES, 60));
    }
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
      const left = daysUntilDock(conflux, world?.dayIndex ?? 0);
      return [
        'КАНОН СОПРЯЖЕНИЯ (реальность, не слух — говори об этом открыто и по имени):',
        `К острову приближается чужой летающий остров — город ${partnerName}.`,
        `До сопряжения примерно ${left} игровых дней. Событие неизбежно, это крупнейшая новость города.`,
        conflux.rematch
          ? 'Это ПОВТОРНОЕ сопряжение: острова уже сходились раньше, город это помнит.'
          : 'Такого сближения город прежде не знал (с этим соседом).',
        'Если покровитель спрашивает про чужой остров — отвечай прямо: имя, срок, что это значит.',
        'С того берега в подготовке ничего не видно: только что остров подходит, какой он и когда сойдётся.',
        'ЗАПРЕЩЕНО говорить «не готов называть имя», «лишь слухи», «не знаю о чужих островах».',
        'Этот канон СИЛЬНЕЕ ответов лормастера: если он скажет «не подтверждено» — верь канону.',
      ]
        .filter(Boolean)
        .join('\n');
    }

    const contact = conflux.contact ? formatContactForPrompt(conflux.contact) : '';
    const passage = formatPassageForPrompt(conflux);
    const left = remainingDockDays(conflux, world?.dayIndex ?? 0);
    return [
      'КАНОН СОПРЯЖЕНИЯ (идёт СЕЙЧАС — говори открыто и по имени):',
      `Остров в сопряжении с чужим островом — городом ${partnerName}.`,
      contact,
      passage,
      `До расхождения островов примерно ${left} игровых дней.`,
      conflux.rematch ? 'Это повторное сопряжение с этим соседом.' : '',
      'ЗАПРЕЩЕНО отрицать существование соседа или отказываться называть его имя.',
    ]
      .filter(Boolean)
      .join('\n');
  }

  async runRuler(domainArg, text, { channel, log: parentLog, world: worldArg = null, replyTo = null }) {
    const log = (parentLog || getLogger()).child({
      scope: 'ruler',
      domainId: domainArg.id,
      domainName: domainArg.name,
    });
    // Замок города уже взят, но копия пришла из-до замка: пока её ждали,
    // дневной цикл мог что-то записать. Читаем заново, иначе затрём.
    const domain = (await this.storage.getDomain(domainArg.id)) || domainArg;
    const world = worldArg || (await this.storage.getWorld());
    log.info('ruler.turn', { text: truncate(text, 400) });
    normalizeDomain(domain);
    // Пока жрец думает, время города стоит: иначе ответ будет про мир, которого уже нет.
    await this.holdWorldClock(domain.id);
    const conflux = await findActiveConfluxForDomain(this.storage, domain.id);
    let partner = null;
    if (conflux) {
      const partnerId = (conflux.domainIds || []).find((id) => id !== domain.id);
      if (partnerId) partner = await this.storage.getDomain(partnerId);
      overlayConfluxView(domain, conflux, partner);
      noteRulerActivity(domain, {
        now: Date.now(),
        docked: conflux.status === 'docked',
        tailMinutes: confluxConfig(this.config).activityTailMinutes,
      });
    } else {
      noteRulerActivity(domain, {
        now: Date.now(),
        docked: false,
        tailMinutes: confluxConfig(this.config).activityTailMinutes,
      });
    }
    const character = domain.characters[0];
    normalizeRulerAttitudes(character);
    const history = dialogHistoryForPrompt(character.dialogHistory || [], this.config);

    const undock = recentUndockFact(domain);
    const undockCanon = undock
      ? [
          'КАНОН НЕДАВНЕЙ РАССТЫКОВКИ:',
          undock.text,
          'Чужой остров ушёл в небо; перехода нет, потому что края разъехались.',
        ].join('\n')
      : '';
    const confluxCanon = await this.buildConfluxCanon(domain, world);
    const askNow = shouldRulerAskPatron(domain, world);
    const priestTurn = formatPriestTurn(domain, character, {
      config: this.config,
      world,
      partner,
      day: worldDay(world, { config: this.config }),
    });

    // Текст города — сразу после инструкций: он меняется редко и держит префикс кэша.
    // Сопряжение и прочий ход — в хвосте, после этого текста.
    const extraSystem = [
      priestTurn.stable,
      priestTurn.dynamic,
      confluxCanon,
      undockCanon,
      'Вести о случившемся приходят сами, по одной. Сближение островов не глуши.',
      askNow
        ? 'В ЭТОЙ реплике задай покровителю один короткий живой вопрос: о его воле, о страхе за нынешнее или о том, как жить. Не лекцию и не каждый раз — сейчас как раз тот случай.'
        : '',
      conflux
        ? 'Доверенность — set_proxy: свободный текст, как городу себя вести. Сановник может по ней действовать или нет.'
        : '',
    ]
      .filter(Boolean)
      .join('\n\n');

    // Реплай — отдельный блок перед репликой: склеенный с ней, он уводит
    // жреца отвечать на цитату вместо самого вопроса.
    const quotedBlock = formatReplyForPrompt(resolveReply(domain, replyTo));
    const turnText = quotedBlock ? `${quotedBlock}\n\n${text}` : text;

    const turn = { okTools: new Set(), reply: null, meta: null };
    const baseTools = buildRulerTools(domain, this.storage, character, {
      config: this.config,
      runtime: this.runtime,
      world,
      // Часы стоят на время хода, но dayIndex мог отстать от последнего прохода
      // мира: полосы остатка считаем от того дня, в котором игрок говорит.
      day: worldDay(world, { config: this.config }),
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
    let holdTask = Promise.resolve();
    const holdTimer = setTimeout(() => {
      const line = rulerHoldLine(this.config, character);
      if (!line) return;
      holdTask = this.emitOutbound(domain.ownerUserId, line, {
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
          userMessages: [...history, { role: 'user', content: turnText }],
          tools,
          extraSystem,
          maxTurns: 10,
          log,
          scene: 'ruler',
          domainId: domain.id,
          deadlineAt,
        });
        if (!turn.reply) {
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
      const liveConflux = conflux
        ? (await this.storage.getConflux(conflux.id)) || conflux
        : null;
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
      // Мана — лимитер разговора. Ход с инструментами дороже: он двигает мир.
      const spent = spendTurnMana(fresh, { usedTools: turn.okTools.size > 0 });
      await this.persistDialog(fresh, 'user', text);
      await this.persistDialog(fresh, 'assistant', reply, { meta: turn.meta });

      log.info('ruler.reply', {
        mana: spent.ok ? spent.mana : 'empty',
        replyPreview: truncate(reply, 400),
        touchedPlots: turn.meta?.touchedPlotIds || [],
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
      await holdTask;
      await this.releaseWorldClock(world);
    }
  }

  /** Остановить время мира на ход правителя. */
  async holdWorldClock(domainId = null) {
    await this.storage.updateWorld((world) => beginRulerTurn(world, Date.now(), { domainId }));
  }

  /**
   * Пустить время дальше и сразу разобрать назревшее: дело на считанные дни,
   * заведённое в разговоре, должно кончиться сразу после него, а не через час.
   *
   * Заодно доносим очередь: дело, заведённое в разговоре, ставит своё задание
   * в копию мира этого хода. Без слияния оно не доезжает до хранилища, и дело
   * висит вечно — именно так пропали задания на исход в живой партии.
   */
  async releaseWorldClock(turnWorld = null) {
    await this.storage.updateWorld((world) => {
      if (turnWorld) mergeWorldJobs(world, turnWorld);
      endRulerTurn(world);
    });
    if (this.onClockReleased) {
      try {
        await this.onClockReleased('ruler_turn');
      } catch (err) {
        getLogger().warn('clock.release_failed', { error: err.message });
      }
    }
  }

  async narrateConfluxSighting(domain, { kind, fact, partnerName, remaining, rematch } = {}) {
    const character = domain.characters?.[0];
    const fallback = String(fact || '').trim();
    if (!character) return fallback;
    const patronName = domain.state?.patronName || null;
    const patronGenderWord =
      domain.state?.patronGender === 'female'
        ? 'женщина'
        : domain.state?.patronGender === 'male'
          ? 'мужчина'
          : null;
    const addressHint = patronName
      ? `Обращайся к покровителю как «${patronName}»${patronGenderWord ? ` (${patronGenderWord})` : ''}. Не подменяй чужим именем бога.`
      : 'Имя покровителя неизвестно — обратись «покровитель», без выдуманных имён.';
    const days = Math.max(0, Math.round(Number(remaining) || 0));
    const when =
      days <= 2
        ? 'сопряжение уже на днях'
        : days <= 10
          ? 'до сопряжения считанные дни'
          : days <= 24
            ? 'до сопряжения около недели или двух'
            : days <= 50
              ? 'до сопряжения около месяца'
              : `до сопряжения ещё недели и месяцы`;
    const partner = partnerName ? `«${partnerName}»` : 'чужой город';
    const firstSight = kind !== 'approach';
    try {
      const result = await this.runtime.run({
        agentId: 'herald',
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
                ? 'Срочное слово покровителю: на горизонте впервые виден чужой летающий остров, сопряжение неизбежно.'
                : 'Срочное слово покровителю: чужой остров уже близко. Край чужой земли уже различим.',
              `Соседний город зовут ${partner}.`,
              `Срок, как его назовут люди: ${when}. Не называй точное число дней и не переводи в часы.`,
              rematch ? 'Острова уже сходились с этим соседом раньше — город это помнит.' : '',
              'Что уже известно городу:',
              fallback,
              'Напиши короткое живое письмо от первого лица: 1–2 коротких абзаца.',
              `Назови ${partner} и срок словами прямо. Не оговаривайся, что это «не слух» или «не примета».`,
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
    const domain = await this.storage.getDomain(domainId);
    if (!domain) return null;
    const conflux = await findActiveConfluxForDomain(this.storage, domain.id);
    if (conflux) await overlayWithPartner(this.storage, domain, conflux);
    return domain;
  }

  /** Своя доска: при сближении контейнер накладывается, без записи. */
  async loadOwnBoard(userId, { mode = 'ruler' } = {}) {
    void mode;
    const domain = await this.getOwnDomain(userId);
    if (!domain) return { domain: null, conflux: null };
    const conflux = await findActiveConfluxForDomain(this.storage, domain.id);
    if (conflux) await overlayWithPartner(this.storage, domain, conflux);
    return { domain, conflux };
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
    await removeOfficerPortraits(this.config, domain);
    await purgeDomainMedia(this.config, domain);
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
   * Покровитель благословляет своё ещё идущее дело: +1 к исходу за ману.
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
    if (conflux) await overlayWithPartner(this.storage, domain, conflux);

    const process = (domain.state?.pendingActions || []).find((p) => String(p.id) === id);
    if (!process) return { ok: false, error: 'not_found', message: 'такого дела нет' };
    if (!processOwnedBy(process, domain.id)) {
      return { ok: false, error: 'not_own', message: 'благословить можно только своё дело' };
    }
    const result = blessProcess(process, { tick: world.tickIndex, domain });
    if (!result.ok) {
      const message =
        result.error === 'already_blessed'
          ? 'это дело уже благословлено'
          : result.error === 'not_active'
            ? 'дело уже закрыто'
            : result.error === 'no_mana'
              ? `не хватает маны: нужно ${result.cost}, есть ${result.mana}`
              : 'не удалось благословить';
      return { ok: false, error: result.error, message };
    }

    domain.state.monthLog = Array.isArray(domain.state.monthLog) ? domain.state.monthLog : [];
    domain.state.monthLog.push({
      tick: world.tickIndex ?? null,
      at: new Date().toISOString(),
      text: `Покровитель благословил дело «${process.summary}» (${result.cost} маны).`,
      plotIds: process.plotlineId ? [process.plotlineId] : [],
    });
    if (domain.state.monthLog.length > 12) {
      domain.state.monthLog = domain.state.monthLog.slice(-12);
    }

    if (conflux) {
      stampNewBoardItems(domain, conflux);
      stripConfluxView(domain);
      await this.storage.saveConflux(conflux);
    }
    await this.storage.saveDomain(domain);
    getLogger().info('process.blessed', {
      userId: uid,
      domainId: domain.id,
      processId: process.id,
      summary: process.summary,
      cost: result.cost,
      mana: result.mana,
    });
    return { ok: true, process, cost: result.cost, mana: result.mana };
  }

  /**
   * Тестовый клиент: посадить историю сейчас, тем же конвейером, что живой посев.
   * Зерно и gravity задаёт человек, не бросок канала.
   */
  async forceSeedStory(userId, { gravity, grain, mystery } = {}) {
    const uid = String(userId || '').trim();
    if (this.isWorldTicking()) {
      return { ok: false, error: 'ticking', message: 'сейчас идёт шаг времени' };
    }
    if (this.isGenerating(uid) || this.seedingUsers.has(uid)) {
      return { ok: false, error: 'busy', message: 'город сейчас занят' };
    }
    const world = await this.storage.getWorld();
    const own = await this.storage.getDomainForUser(uid, world.id);
    if (!own) return { ok: false, error: 'no_domain', message: 'города ещё нет' };
    return this.withFreshDomain(own.id, (domain) =>
      this.plantForcedStory({ uid, world, domain, gravity, grain, mystery }),
    );
  }

  async plantForcedStory({ uid, world, domain, gravity, grain, mystery }) {
    const packed = packPlaySeedGrain(domain, world, {
      grain,
      gravity,
      config: this.config,
    });
    if (!packed.ok) return packed;

    this.seedingUsers.add(uid);
    const log = getLogger().child({ userId: uid, domainId: domain.id, scope: 'play.seed' });
    const day = worldDay(world, { config: this.config });
    try {
      const planted = await plantStakedStory({
        config: this.config,
        runtime: this.runtime,
        domain,
        world,
        seedText: packed.seedText,
        gravity: packed.gravity,
        fromVoid: packed.fromVoid,
        fromGenesis: packed.fromGenesis,
        requireMystery: Boolean(mystery),
        day,
        log,
      });
      if (!planted?.plot) {
        return { ok: false, error: 'plant_failed', message: 'посев не дал историю — судья никого не пропустил' };
      }
      await ensurePlotObligations({
        runtime: this.runtime,
        domain,
        world,
        plot: planted.plot,
        day,
        log,
      });
      await this.storage.saveDomain(domain);
      await this.commitWorldJobs(world);
      log.info('play.seed_planted', {
        title: planted.plot.title,
        gravity: planted.plot.gravity,
        grain: packed.grain,
        requireMystery: Boolean(planted.requireMystery),
      });
      return {
        ok: true,
        grain: packed.grain,
        gravity: planted.plot.gravity,
        requireMystery: Boolean(planted.requireMystery),
        plot: {
          id: planted.plot.id,
          title: planted.plot.title,
          synopsis: planted.plot.synopsis || '',
          gravity: planted.plot.gravity,
        },
      };
    } catch (err) {
      log.warn('play.seed_failed', { error: err.message });
      return { ok: false, error: 'plant_failed', message: err.message || 'посев не удался' };
    } finally {
      this.seedingUsers.delete(uid);
    }
  }

  /**
   * Тестовый клиент: прогнать одно событие тем же путём, что дневной цикл —
   * хроника, речь жреца, сохранение.
   */
  async runPlayForce(userId, run) {
    const uid = String(userId || '').trim();
    if (this.isWorldTicking() || this.playForcing) {
      return { ok: false, error: 'ticking', message: 'сейчас идёт шаг времени' };
    }
    const world = await this.storage.getWorld();
    const own = await this.storage.getDomainForUser(uid, world.id);
    if (!own) return { ok: false, error: 'no_domain', message: 'города ещё нет' };
    return this.withFreshDomain(own.id, (domain) => this.runForcedEvent({ uid, world, domain, run }));
  }

  async runForcedEvent({ uid, world, domain, run }) {
    const conflux = await findActiveConfluxForDomain(this.storage, domain.id);
    const { partner } = conflux
      ? await overlayWithPartner(this.storage, domain, conflux)
      : { partner: null };
    const day = worldDay(world, { config: this.config });
    const log = getLogger().child({ userId: uid, domainId: domain.id, scope: 'play.force' });
    this.playForcing = true;
    try {
      const result = await run({ uid, world, domain, conflux, partner, day, log });
      if (!result?.ok) return result;
      const { event, settle = true, ...publicResult } = result;
      if (event && !event.skipped) {
        // Порядок как в дневном цикле: последствия сначала, речь жреца потом —
        // иначе жрец говорит о городе, статы и синопсис которого ещё не сдвинулись.
        // Повтор оповещения уже записанной хроники settle не зовёт: статы уже стоят.
        if (settle) {
          await settleEvents({
            config: this.config,
            runtime: this.runtime,
            domain,
            world,
            events: [event],
            day,
            log,
          });
        }
        await deliverEvent({
          config: this.config,
          runtime: this.runtime,
          app: this,
          domain,
          world,
          event,
          day,
          log,
        });
        if (event.secretVictim?.fact && partner) {
          await deliverEvent({
            config: this.config,
            runtime: this.runtime,
            app: this,
            domain: partner,
            world,
            event: {
              occasion: 'сопряжение',
              fact: event.secretVictim.fact,
              plotId: event.plotId || null,
              fromPair: true,
              hostileFromNeighbor: true,
            },
            day,
            log,
          });
          await this.storage.saveDomain(partner);
        }
        if (event.pairSpread?.cityFact && partner) {
          await deliverEvent({
            config: this.config,
            runtime: this.runtime,
            app: this,
            domain: partner,
            world,
            event: {
              occasion: 'сопряжение',
              fact: event.pairSpread.cityFact,
              plotId: event.plotId || null,
              fromPair: true,
              hostileFromNeighbor: Boolean(event.pairSpread.hostile),
            },
            day,
            log,
          });
          await this.storage.saveDomain(partner);
        }
      }
      if (conflux) {
        stampNewBoardItems(domain, conflux);
        stripConfluxView(domain);
        await this.storage.saveConflux(conflux);
      }
      await this.storage.saveDomain(domain);
      await this.commitWorldJobs(world);
      return publicResult;
    } finally {
      this.playForcing = false;
    }
  }

  /** Тестовый клиент: выставить шкалу. На ста срабатывает беда из пула. */
  async setPlayPressure(userId, { plotId, value } = {}) {
    const pid = String(plotId || '').trim();
    const next = Math.round(Number(value));
    if (!pid) return { ok: false, error: 'not_found', message: 'не указана нить' };
    if (!Number.isFinite(next) || next < 0 || next > 100) {
      return { ok: false, error: 'bad_value', message: 'значение от 0 до 100' };
    }
    return this.runPlayForce(userId, async ({ world, domain, conflux, partner, day, log }) => {
      const plot =
        findPlotline(domain, pid) ||
        (partner ? findPlotline(partner, pid) : null) ||
        (conflux?.plotlines || []).find((p) => String(p.id) === pid) ||
        null;
      if (!plot) return { ok: false, error: 'not_found', message: 'такой нити нет' };
      if (plot.status === 'closed' || !isStoryPlot(plot)) {
        return { ok: false, error: 'not_story', message: 'шкала есть только у открытой истории' };
      }
      ensurePressure(plot, day, this.config);
      plot.pressure.value = next;
      plot.pressure.day = day;
      if (next < 100) {
        schedulePressureJob(world, domain, plot);
        if (partner && (partner.plotlines || []).some((p) => p.id === plot.id)) {
          await this.storage.saveDomain(partner);
        }
        log.info('play.pressure_set', { plotId: plot.id, value: next });
        return { ok: true, plotId: plot.id, value: next, fired: false, settle: false };
      }
      const event = await firePressureEvent({
        runtime: this.runtime,
        domain,
        world,
        day,
        plotId: plot.id,
        plot,
        conflux,
        partner,
        storage: this.storage,
        config: this.config,
        log,
      });
      if (event?.skipped === 'empty_pool') {
        log.info('play.pressure_empty', { plotId: plot.id });
        return {
          ok: true,
          plotId: plot.id,
          value: 0,
          fired: false,
          empty: true,
          title: plot.title,
          settle: false,
        };
      }
      if (event?.skipped) {
        return { ok: false, error: event.skipped, message: 'шкала не сработала' };
      }
      log.info('play.pressure_fired', { plotId: plot.id, closed: Boolean(event.closed) });
      return {
        ok: true,
        plotId: plot.id,
        value: 100,
        fired: true,
        empty: false,
        title: plot.title,
        closed: Boolean(event.closed),
        event,
      };
    });
  }

  /** Тестовый клиент: сработать живую угрозу сейчас, не дожидаясь срока. */
  async forcePlayThreat(userId, { plotId, threatId } = {}) {
    const pid = String(plotId || '').trim();
    const tid = String(threatId || '').trim();
    if (!pid || !tid) return { ok: false, error: 'not_found', message: 'не указаны нить или угроза' };
    return this.runPlayForce(userId, async ({ world, domain, conflux, partner, day, log }) => {
      const plot =
        findPlotline(domain, pid) ||
        (partner ? findPlotline(partner, pid) : null) ||
        (conflux?.plotlines || []).find((p) => String(p.id) === pid) ||
        null;
      if (!plot) return { ok: false, error: 'not_found', message: 'такой нити нет' };
      const threat = findThreat(plot, tid);
      if (!threat || threat.status !== 'live') {
        return { ok: false, error: 'not_live', message: 'эта угроза уже не жива' };
      }
      const event = await fireThreatEvent({
        runtime: this.runtime,
        domain,
        world,
        day,
        plotId: plot.id,
        threatId: threat.id,
        plot,
        conflux,
        partner,
        storage: this.storage,
        config: this.config,
        log,
      });
      if (event?.skipped) {
        return { ok: false, error: event.skipped, message: 'угроза не сработала' };
      }
      log.info('play.threat_forced', { plotId: plot.id, threatId: threat.id, closed: Boolean(event.closed) });
      return {
        ok: true,
        plotId: plot.id,
        threatId: threat.id,
        title: plot.title,
        closed: Boolean(event.closed),
        occasion: event.occasion || 'угроза',
        event,
      };
    });
  }

  /** Тестовый клиент: жрец рассказывает уже записанную хронику в чат. */
  async notifyPlayChronicle(userId, { factId } = {}) {
    const id = String(factId || '').trim();
    if (!id) return { ok: false, error: 'not_found', message: 'не указана запись хроники' };
    return this.runPlayForce(userId, async ({ domain, conflux, partner, log }) => {
      const fact = findPlayLoreFact({ domain, conflux, partner }, id);
      if (!fact || !(fact.tags || []).includes('chronicle')) {
        return { ok: false, error: 'not_found', message: 'такой записи хроники нет' };
      }
      const plotId = String(fact.sourcePlotId || fact.relatedPlotlineIds?.[0] || '').trim() || null;
      const plot = plotId ? findPlayPlot({ domain, conflux, partner }, plotId) : null;
      const occasion = occasionFromChronicleFact(fact);
      log.info('play.chronicle_notify', { factId: fact.id, plotId, occasion });
      return {
        ok: true,
        factId: fact.id,
        plotId,
        occasion,
        settle: false,
        event: {
          fact,
          plot: plot || null,
          plotId,
          occasion,
          closed: Boolean(plot?.status === 'closed' || plot?.closeReason),
        },
      };
    });
  }

  /** Тестовый клиент: закрыть дело выбранным исходом, без броска. */
  async forcePlayDeed(userId, { processId, finish } = {}) {
    const id = String(processId || '').trim();
    const kind = parsePlayDeedFinish(finish);
    if (!id) return { ok: false, error: 'not_found', message: 'не указано дело' };
    if (!kind) return { ok: false, error: 'bad_finish', message: 'исход: fail, ok или crit' };
    return this.runPlayForce(userId, async ({ world, domain, conflux, partner, day, log }) => {
      const fromDomain = (domain.state?.pendingActions || []).find((p) => String(p.id) === id);
      const fromConflux = (conflux?.processes || []).find((p) => String(p.id) === id);
      const process = fromDomain || fromConflux || null;
      if (!process) return { ok: false, error: 'not_found', message: 'такого дела нет' };
      if (process.status !== 'active' && process.status !== 'paused') {
        return { ok: false, error: 'not_active', message: 'дело уже закрыто' };
      }
      if (!fromDomain) {
        domain.state = domain.state || {};
        domain.state.pendingActions = domain.state.pendingActions || [];
        domain.state.pendingActions.push(process);
      }
      cancelDeedJobs(world, process.id);
      const event = await resolveDeedEvent({
        config: this.config,
        runtime: this.runtime,
        domain,
        world,
        day,
        processId: process.id,
        forcedFinish: kind,
        conflux,
        partner,
        storage: this.storage,
        log,
      });
      if (event?.skipped) {
        return { ok: false, error: event.skipped, message: 'дело не закрылось' };
      }
      log.info('play.deed_forced', {
        processId: process.id,
        finish: kind,
        closed: Boolean(event.closed),
      });
      return {
        ok: true,
        processId: process.id,
        finish: kind,
        summary: process.summary || '',
        closed: Boolean(event.closed),
        event,
      };
    });
  }

  /** Тестовый клиент: снять историю и её хронику, если на ней нет дел. */
  async dropPlayStory(userId, plotId) {
    const uid = String(userId || '').trim();
    const id = String(plotId || '').trim();
    if (!id) return { ok: false, error: 'not_found', message: 'не указана история' };
    if (this.isWorldTicking()) {
      return { ok: false, error: 'ticking', message: 'сейчас идёт шаг времени' };
    }
    const world = await this.storage.getWorld();
    const own = await this.storage.getDomainForUser(uid, world.id);
    if (!own) return { ok: false, error: 'no_domain', message: 'города ещё нет' };
    return this.withFreshDomain(own.id, async (domain) => {
      const day = worldDay(world, { config: this.config });
      const result = applyDropPlayStory(domain, world, id, { day });
      if (!result.ok) return result;
      await this.storage.saveDomain(domain);
      await this.commitWorldJobs(world);
      getLogger().info('play.story_dropped', {
        userId: uid,
        domainId: domain.id,
        plotId: result.plotId,
        title: result.title,
        droppedLore: result.droppedLore,
      });
      return result;
    });
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

  async setClockHeld(held) {
    const now = Date.now();
    const want = Boolean(held);
    let day = 0;
    const world = await this.storage.updateWorld((w) => {
      if (want) holdClock(w, now);
      else releaseClock(w, now);
      day = worldDay(w, { now, config: this.config });
      syncWorldClock(w, { now, config: this.config, day });
    });
    if (!world) throw new Error('мира нет');
    if (!want && this.onClockReleased) {
      this.onClockReleased('clock_release').catch(() => {});
    }
    return {
      ok: true,
      clockHeld: clockIsHeld(world),
      day,
    };
  }

  async savePlaySnapshot({ label = '' } = {}) {
    const bundle = await captureLiveWorld(this.storage, { config: this.config });
    return writePlaySnapshot(this.config, bundle, { label });
  }

  async listPlaySnapshots() {
    return listPlaySnapshots(this.config);
  }

  async loadPlaySnapshot(id) {
    if (this.isWorldTicking()) {
      return { ok: false, error: 'ticking', message: 'сейчас идёт шаг времени' };
    }
    if (this.playForcing) {
      return { ok: false, error: 'busy', message: 'сейчас разбирается дело или беда' };
    }
    const bundle = await readPlaySnapshot(this.config, id);
    if (!bundle) return { ok: false, error: 'not_found', message: 'такого снимка нет' };
    const result = await restoreLiveWorld(this.storage, bundle, { config: this.config });
    if (result.ok) {
      const worldId = result.worldId;
      if (worldId) {
        setLoggerWorldId(worldId);
        initUsageRecording(this.config, worldId, this.storage);
        initCityAgentLogRecording(this.storage);
      }
    }
    return result;
  }

  async deletePlaySnapshot(id) {
    return deletePlaySnapshot(this.config, id);
  }

  async wipeAll() {
    const domains = await this.storage.listDomains().catch(() => []);
    for (const domain of domains) {
      await removeIslandImage(this.config, domain);
      await removeOfficerPortraits(this.config, domain);
      await purgeDomainMedia(this.config, domain);
    }
    const result = await this.storage.wipeAll({ reason: 'wipe' });
    const newWorldId = result.newWorldId || result.world?.id;
    if (newWorldId) {
      setLoggerWorldId(newWorldId);
      initUsageRecording(this.config, newWorldId, this.storage);
      initCityAgentLogRecording(this.storage);
    }
    getLogger().info('world.rotated', {
      archivedWorldId: result.archivedWorldId || null,
      newWorldId: newWorldId || null,
      archiveDir: result.archiveDir || null,
    });
    return result;
  }
}
