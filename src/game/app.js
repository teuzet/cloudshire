import { buildOnboardingTools } from './onboardingTools.js';
import {
  chronicleEntries,
  newsChronicleEntries,
  filterChronicleForDomain,
  formatChronicleScope,
  formatChroniclePriestMark,
  normalizeDomain,
  formatCastForPrompt,
  firstMentionHintForSpeech,
  peopleNamedInTexts,
  inferRulerGender,
} from './models.js';
import {
  qualitativePopulation,
  qualitativeStatsBrief,
  statEpithetsShort,
  formatRulerAttitudes,
  normalizeRulerAttitudes,
} from './stats.js';
import { assertsIslandsParted, monthsUntilDock, findActiveConfluxForDomain, formatContactForPrompt } from './conflux.js';
import {
  hydrateDomainFromConflux,
  dehydrateDomainToConflux,
} from './confluxBoard.js';
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
import { formatBoardForSpeech, warmPlotlines, plotConfig } from './plotlines.js';
import { islandDeleteCheck } from '../clients/telegram/access.js';
import { generateIslandImage, removeIslandImage } from './islandImage.js';
import { generateOfficerPortraits, removeOfficerPortraits } from './officerImage.js';
import { generateDomain } from './genesis.js';
import { formatOfficersForPrompt } from './officers.js';
import { formatIslandReveal } from './islandReveal.js';
import { formatProgressBar, genesisTutorialText } from './progressBar.js';
import { genesisDateMessage } from './tickClock.js';
import { dialogHistoryForPrompt } from './memory.js';
import {
  newsScheduleOf,
  tickNewsStyleHint,
} from './newsSchedule.js';
import {
  formatRulerVoiceForPrompt,
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
import { purgeDomainMedia } from '../storage/r2.js';
import { buildRulerTools, submitReplyTool } from './rulerTools.js';
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
        await this.persistDialog(domain, 'assistant', reveal, { kind: 'island_reveal' });
        await this.emitOutbound(uid, reveal, {
          channel,
          agent: 'onboarding',
          domainId: domain.id,
          kind: 'island_reveal',
          photoUrl: picture?.url || null,
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
        const officerIntro = domain._officerIntro;
        if (officerIntro) {
          const officerLine = officerIntro.startsWith(domain.characters[0].name)
            ? officerIntro
            : `${domain.characters[0].name}: ${officerIntro}`;
          await this.persistDialog(domain, 'assistant', officerLine);
          await this.emitOutbound(uid, officerLine, {
            channel,
            agent: 'ruler',
            domainId: domain.id,
            kind: 'officer_intro',
          });
        }
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
    const patronGender = domain.state?.patronGender || null;
    const patronGenderWord =
      patronGender === 'female' ? 'женщина' : patronGender === 'male' ? 'мужчина' : null;
    const patronLine = patronName
      ? `Имя покровителя: «${patronName}»${patronGenderWord ? `, пол: ${patronGenderWord}` : ''} — обращайся только так. Не предлагай другое и не вызывай set_patron_name.`
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
    const baseTools = buildRulerTools(domain, this.storage, character, {
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
      await holdTask;
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
    const patronGenderWord =
      domain.state?.patronGender === 'female'
        ? 'женщина'
        : domain.state?.patronGender === 'male'
          ? 'мужчина'
          : null;
    const addressHint = patronName
      ? `Обращайся к покровителю как «${patronName}»${patronGenderWord ? ` (${patronGenderWord})` : ''}. Не подменяй чужим именем бога.`
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
          'В этом месяце, пока покровитель молчал, действовал сановник — не ты сам. Назови его должность и имя.',
          ...stewardActs.map((a) =>
            a.kind === 'process'
              ? `- ${a.office ? `${a.office} ` : ''}${a.officerName || ''} взялся за дело: ${a.summary}`
              : `- ${a.kind}: ${a.summary || a.text || ''}`,
          ),
          'Не приписывай решение себе. Жрец только передаёт, что сановник распорядился.',
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
    const patronGenderWord =
      domain.state?.patronGender === 'female'
        ? 'женщина'
        : domain.state?.patronGender === 'male'
          ? 'мужчина'
          : null;
    const addressHint = patronName
      ? `Обращайся к покровителю как «${patronName}»${patronGenderWord ? ` (${patronGenderWord})` : ''}. Не подменяй чужим именем бога.`
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
    if (conflux) hydrateDomainFromConflux(domain, conflux, { mode: 'ruler' });

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
      dehydrateDomainToConflux(domain, conflux);
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
    }
    getLogger().info('world.rotated', {
      archivedWorldId: result.archivedWorldId || null,
      newWorldId: newWorldId || null,
      archiveDir: result.archiveDir || null,
    });
    return result;
  }
}
