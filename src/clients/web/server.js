import express from 'express';
import path from 'node:path';
import { projectRoot, hasAdminCredentials } from '../../config.js';
import { runWorldTick, emitConfluxAnnouncements } from '../../game/tick.js';
import { runDayLoop } from '../../game/dayLoop.js';
import { recordTickCompleted } from '../../scheduler/ticks.js';
import { domainSummary } from '../../game/genesis.js';
import {
  forceCreateConflux,
  confluxSummary,
  findActiveConfluxForDomain,
  monthsUntilDock,
  dockConfluxNow,
  undockConfluxNow,
} from '../../game/conflux.js';
import { getLogger, requestLogger, truncate } from '../../log.js';
import { statEpithet } from '../../game/stats.js';
import { chronicleEntries, castRecords } from '../../game/models.js';
import { stripPlotSecrets } from '../../game/plotlines.js';
import { FINISH_SHORT } from '../../game/rolls.js';
import { resolveIslandImage } from '../../game/islandImage.js';
import { resolveOfficerPortrait } from '../../game/officerImage.js';
import { domainHasIslandImage, officerHasPortrait } from '../../storage/r2.js';
import { overlayWithPartner, stripConfluxView } from '../../game/confluxBoard.js';
import { deriveOnboardingPhase, normalizeOnboardingDraft } from '../../game/onboarding.js';
import { genesisTutorialText } from '../../game/progressBar.js';
import { miniCityPayload } from '../../game/miniCity.js';
import { cityRules, proxyText } from '../../game/cityRules.js';
import {
  worldDay,
  clockIsHeld,
  skipStoredWorldDays,
  commitWorldChanges,
} from '../../game/scheduler.js';
import { DAYS_PER_MONTH, gameDateFromDay, parseSkipDays } from '../../game/gameClock.js';
import { daysUntilDock, daysUntilUndock } from '../../game/confluxTime.js';
import { DIFFICULTY_SPEC, DURATION_SPEC, normalizeDifficultyBand } from '../../game/bands.js';
import { deedDurationBand, deedRemainingBand, deedRemainingDays } from '../../game/deeds.js';
import { paceLabel } from '../../game/deedMath.js';
import { blessManaCost } from '../../game/mana.js';
import { liveThreats, remainingDays as threatRemainingDays } from '../../game/threats.js';
import { priestOrders } from '../../game/priestOrders.js';
import { visibleDialogHistory } from '../../game/memory.js';
import { notifySettings } from '../../game/notify.js';
import { canDropPlayStory } from '../../game/playDev.js';
import { mountFreeformLab } from './freeformLab.js';
import {
  validateTelegramInitData,
  telegramBotToken,
} from '../telegram/initData.js';
import { isTelegramAllowed, closedTestReply } from '../telegram/access.js';

/**
 * Дело для инспектора: сырое поле плюс то, что считает движок.
 * Считать полосы и цену благословения в браузере — значит завести вторую
 * реализацию правил, которая тихо разойдётся с первой.
 */
function inspectProcess(process, day) {
  if (!process) return process;
  const active = !process.status || process.status === 'active';
  const paused = process.status === 'paused';
  return {
    ...process,
    // Инспектор — отладочный экран, поэтому здесь, в отличие от справочника
    // игрока, дни показываем прямо: иначе нечем проверять сроки.
    remainingLabel: active ? DURATION_SPEC[deedRemainingBand(process, day)].label : null,
    remainingDays: active ? deedRemainingDays(process, day) : null,
    pausedRemainingDays: paused ? Math.round(Number(process.pausedRemainingDays) || 0) : null,
    durationLabel: DURATION_SPEC[deedDurationBand(process)].label,
    difficultyLabel: DIFFICULTY_SPEC[normalizeDifficultyBand(process.difficulty)].label,
    paceLabel: paceLabel(process.paceShift),
    blessCost: blessManaCost(process),
  };
}

/** Скрытый слой нити — только инспектору тестового клиента, не доске и не речи. */
function plotSecrets(plot) {
  if (!plot || typeof plot !== 'object') return {};
  return {
    hiddenAnswer: plot.hiddenAnswer || '',
    hiddenPremises: Array.isArray(plot.hiddenPremises) ? plot.hiddenPremises : [],
    seed: plot.seed || '',
    discoveryLadder: Array.isArray(plot.discoveryLadder) ? plot.discoveryLadder : [],
    truth: plot.truth || null,
  };
}

function loreBelongsToPlot(entry, plot) {
  const pid = String(plot?.id || '');
  if (!pid || !entry) return false;
  if (String(entry.sourcePlotId || '') === pid) return true;
  if ((entry.relatedPlotlineIds || []).map(String).includes(pid)) return true;
  if ((plot.chronicleIds || []).map(String).includes(String(entry.id))) return true;
  return false;
}

function inspectPlotChronicles(plot, lore) {
  return chronicleEntries(lore)
    .filter((e) => loreBelongsToPlot(e, plot))
    .sort(
      (a, b) =>
        (Number(a.day) || 0) - (Number(b.day) || 0) ||
        (Number(a.tick) || 0) - (Number(b.tick) || 0) ||
        String(a.id || '').localeCompare(String(b.id || '')),
    )
    .map((e) => ({
      id: e.id,
      text: e.text,
      day: e.day ?? null,
      tick: e.tick ?? null,
      gameDateLabel: e.gameDateLabel || null,
      importance: e.importance || null,
      author: e.author || null,
    }));
}

/**
 * Нить для инспектора. Речь жреца нависшее не видит; здесь сроки видны,
 * иначе отлаживать часы угроз нечем.
 * Скрытый слой и хроника нити тоже здесь: иначе нечем проследить, как она шла.
 */
function inspectPlot(plot, day, lore = []) {
  const bare = stripPlotSecrets(plot);
  if (!bare) return bare;
  return {
    ...bare,
    ...plotSecrets(plot),
    threats: liveThreats(plot).map((t) => ({
      id: t.id,
      text: t.text,
      band: t.band,
      stage: t.stage || null,
      remainingPct: t.remainingPct ?? null,
      outcome: t.outcome,
      totalDays: t.totalDays,
      remainingDays: threatRemainingDays(t, day),
    })),
    chronicles: inspectPlotChronicles(plot, lore),
  };
}

function slimLore(f) {
  if (!f) return null;
  return {
    id: f.id,
    text: f.text,
    tick: f.tick ?? null,
    gameDateLabel: f.gameDateLabel || null,
    importance: f.importance || null,
    author: f.author || null,
    tags: f.tags || [],
    secret: Boolean(f.secret),
  };
}

function nameForDomain(id, domain, partner) {
  const sid = String(id || '');
  if (sid && sid === String(domain?.id)) return domain.name;
  if (sid && sid === String(partner?.id)) return partner.name;
  return sid || null;
}

/**
 * Нити пары для инспектора. Контейнер живёт отдельно от plotlines и на оверлее
 * правителя с него снимают концовки — здесь нужна живая карточка, иначе
 * тестовый клиент показывает сопряжение без исхода.
 */
function inspectPairPlotlines(conflux, day, boardLore, viewer, partner) {
  const seen = new Set();
  const out = [];
  const add = (plot) => {
    if (!plot?.id || seen.has(plot.id)) return;
    seen.add(plot.id);
    out.push(inspectPlot(plot, day, boardLore));
  };
  for (const plot of viewer?.plotlines || []) add(plot);
  for (const plot of partner?.plotlines || []) add(plot);
  for (const plot of conflux?.plotlines || []) add(plot);
  return out;
}

function inspectForecast(conflux, domain, partner) {
  const src = conflux?.forecast;
  if (!src || typeof src !== 'object') return null;
  const names = {
    ...(domain?.id ? { [String(domain.id)]: domain.name } : {}),
    ...(partner?.id ? { [String(partner.id)]: partner.name } : {}),
  };
  const byCity = [];
  let neutral = '';
  for (const [id, value] of Object.entries(src)) {
    const text = String(value || '').trim();
    if (!text) continue;
    if (id === 'neutral') {
      neutral = text;
      continue;
    }
    byCity.push({ id, name: names[String(id)] || id, text });
  }
  if (!byCity.length && !neutral) return null;
  return { byCity, neutral: neutral || null };
}

/** Живая доска сопряжения для инспектора. */
function inspectConfluxBoard(conflux, domain, partner, world, day) {
  if (!conflux) return null;
  const partnerId = partner ? String(partner.id) : null;
  const names = Object.fromEntries(
    (conflux.domainIds || []).map((id) => [String(id), nameForDomain(id, domain, partner) || String(id)]),
  );
  const known = (partner?.lore || []).filter((f) => !f.secret);
  const byTick = (a, b) => (Number(b.tick) || 0) - (Number(a.tick) || 0);
  const boardLore = [...(conflux.lore || []), ...(domain.lore || []), ...(partner?.lore || [])];
  return {
    ...confluxSummary(
      conflux,
      world,
      {
        [domain.id]: domain,
        ...(partner ? { [partner.id]: partner } : {}),
      },
      day,
    ),
    partnerName: partner?.name || partnerId,
    mainPlotId: conflux.mainPlotId || null,
    knownAboutPartner: [...known].sort(byTick).map(slimLore),
    plotlines: inspectPairPlotlines(conflux, day, boardLore, domain, partner),
    closedPlotlines: (conflux.closedPlotlines || []).map((p) => inspectPlot(p, day, boardLore)),
    processes: (conflux.processes || []).map((p) => inspectProcess(p, day)),
    lore: [...(conflux.lore || [])].slice(-40).map(slimLore),
    forecast: inspectForecast(conflux, domain, partner),
    domainNames: names,
  };
}

/** Заголовки нитей и дел для карточек хроники в тестовом клиенте. */
function chronicleRelations(entry, domain, extra = {}) {
  const plotsById = new Map();
  for (const p of [
    ...(domain.plotlines || []),
    ...(domain.closedPlotlines || []),
    ...(extra.plotlines || []),
    ...(extra.closedPlotlines || []),
  ]) {
    if (p?.id) plotsById.set(String(p.id), p.title || p.id);
  }
  const processesById = new Map();
  for (const p of [...(domain.state?.pendingActions || []), ...(extra.processes || [])]) {
    if (p?.id) processesById.set(String(p.id), p);
  }
  const relatedPlots = [...new Set((entry.relatedPlotlineIds || []).map(String))].map((id) => ({
    id,
    title: plotsById.get(id) || id,
  }));
  const processId = entry.relatedPendingId ? String(entry.relatedPendingId) : null;
  const process = processId ? processesById.get(processId) : null;
  const finish = entry.processFinish || process?.finishKind || null;
  return {
    relatedPlots,
    relatedProcess: processId
      ? { id: processId, title: process?.summary || process?.title || processId }
      : null,
    processFinish: finish,
    processFinishLabel: finish ? FINISH_SHORT[finish] || finish : null,
  };
}

async function bindingForDomain(storage, domain) {
  const ownerId = domain?.ownerUserId ? String(domain.ownerUserId) : '';
  if (ownerId) {
    const owned = await storage.getUserBinding(ownerId);
    if (owned) return owned;
  }
  const all = await storage.listUserBindings();
  return all.find((b) => String(b.domainId || '') === String(domain?.id || '')) || null;
}

function onboardingArchive(binding, { userId = null, domainId = null, generating = false } = {}) {
  const draft = normalizeOnboardingDraft(binding?.onboarding);
  const uid = userId || binding?.userId || null;
  return {
    userId: uid ? String(uid) : null,
    domainId: domainId || binding?.domainId || null,
    channel: binding?.channel || null,
    generating: Boolean(generating),
    phase: deriveOnboardingPhase(draft, { generating }),
    mode: draft.mode || null,
    cityName: draft.cityName || null,
    cityNameApproved: Boolean(draft.cityNameApproved),
    patronName: draft.patronName || null,
    patronNameApproved: Boolean(draft.patronNameApproved),
    pitchedName: draft.pitchedName || null,
    messageCount: (draft.messages || []).length,
    messages: (draft.messages || []).map((m) => ({
      role: m.role === 'user' ? 'user' : 'assistant',
      content: String(m.content || ''),
      at: m.at || null,
      kind: m.kind || 'onboarding',
    })),
  };
}

/** Острова текущего мира для переключателя тестового клиента. */
async function listPlayIslands(storage, world, day) {
  const nowDay = Number.isFinite(Number(day))
    ? Math.round(Number(day))
    : Math.round(Number(world?.dayIndex) || 0);
  const domains = await storage.listDomains();
  const bindings = await storage.listUserBindings();
  const confluxes = await storage.listConfluxes({ status: ['approaching', 'docked'] }).catch(() => []);
  const ownerByDomain = new Map();
  for (const b of bindings || []) {
    if (b?.domainId) ownerByDomain.set(String(b.domainId), b);
  }
  const byId = new Map(domains.map((d) => [d.id, d]));

  const islands = [];
  for (const domain of domains) {
    if (world?.id && domain.worldId && domain.worldId !== world.id) continue;
    if (domain.status && domain.status !== 'playing') continue;
    const owner = ownerByDomain.get(domain.id);
    const userId = String(domain.ownerUserId || owner?.userId || '');
    if (!userId) continue;
    const cf = (confluxes || []).find((c) => (c.domainIds || []).includes(domain.id));
    const partnerId = cf ? (cf.domainIds || []).find((id) => id !== domain.id) : null;
    const partner = partnerId ? byId.get(partnerId) : null;
    const partnerOwner = partner ? ownerByDomain.get(partner.id) : null;
    islands.push({
      userId,
      domainId: domain.id,
      name: domain.name,
      ruler: domain.characters?.[0]?.name || null,
      draft: false,
      conflux: cf
        ? {
            status: cf.status,
            partnerName: partner?.name || null,
            partnerUserId: partner
              ? String(partner.ownerUserId || partnerOwner?.userId || '')
              : null,
            daysUntilDock: cf.status === 'approaching' ? daysUntilDock(cf, nowDay) : null,
            remainingDockDays: cf.status === 'docked' ? daysUntilUndock(cf, nowDay) : null,
            monthsUntilDock:
              cf.status === 'approaching' ? monthsUntilDock(cf, world, nowDay) : null,
          }
        : null,
    });
  }

  for (const b of bindings || []) {
    if (b?.domainId) continue;
    if (world?.id && b.worldId && b.worldId !== world.id) continue;
    islands.push({
      userId: String(b.userId),
      domainId: null,
      name: b.onboarding?.cityName || 'черновик',
      ruler: null,
      draft: true,
      conflux: null,
    });
  }

  islands.sort((a, b) => {
    if (a.draft !== b.draft) return a.draft ? 1 : -1;
    return String(a.name).localeCompare(String(b.name), 'ru');
  });
  return islands;
}

/** Числа игроку видны, но рядом с ними — то же слово, которым говорит правитель. */
/**
 * Статы для показа. Внутри они дробные, игроку показываем целое — но точное
 * значение отдаём рядом, иначе в инспекторе не видно, как копится дробь.
 */
function statsWithEpithets(stats, config) {
  return (config.stats || []).map((def) => {
    const value = Number(stats?.[def.id]);
    const v = Number.isFinite(value) ? value : 50;
    return {
      id: def.id,
      name: def.name,
      value: Math.round(v),
      exact: Math.round(v * 100) / 100,
      epithet: statEpithet(v, config),
    };
  });
}

function isFreeformPath(req) {
  const path = String(req.path || '');
  const url = String(req.originalUrl || '').split('?')[0];
  return (
    path === '/freeform' ||
    path.startsWith('/freeform/') ||
    path.startsWith('/api/freeform') ||
    url === '/freeform' ||
    url.startsWith('/freeform/') ||
    url.startsWith('/api/freeform')
  );
}

function adminBasicAuth(config) {
  const user = config.admin?.user || '';
  const password = config.admin?.password || '';
    const required = hasAdminCredentials(config) || Boolean(process.env.DYNO || process.env.RAILWAY_ENVIRONMENT);

  return (req, res, next) => {
    if (req.path === '/health') return next();
    if (isFreeformPath(req)) return next();

    if (!user || !password) {
      if (required) {
        res.set('WWW-Authenticate', 'Basic realm="Cloudshire Admin"');
        return res.status(401).send('Admin credentials required (ADMIN_USER / ADMIN_PASSWORD)');
      }
      return next();
    }

    const hdr = req.headers.authorization || '';
    if (!hdr.startsWith('Basic ')) {
      res.set('WWW-Authenticate', 'Basic realm="Cloudshire Admin"');
      return res.status(401).send('Authentication required');
    }
    let decoded = '';
    try {
      decoded = Buffer.from(hdr.slice(6), 'base64').toString('utf8');
    } catch {
      res.set('WWW-Authenticate', 'Basic realm="Cloudshire Admin"');
      return res.status(401).send('Invalid authorization');
    }
    const sep = decoded.indexOf(':');
    const u = sep >= 0 ? decoded.slice(0, sep) : decoded;
    const p = sep >= 0 ? decoded.slice(sep + 1) : '';
    if (u !== user || p !== password) {
      res.set('WWW-Authenticate', 'Basic realm="Cloudshire Admin"');
      return res.status(401).send('Invalid credentials');
    }
    return next();
  };
}

export function createWebServer({ config, app, runtime, storage }) {
  const server = express();
  const playEnabled = config.web?.play !== false;
  const adminEnabled = config.web?.admin !== false;
  const playDevEnabled = playEnabled && config.web?.playDev !== false;
  server.use(express.json({ limit: '1mb' }));

  server.get('/health', (_req, res) => {
    res.json({ ok: true, play: playEnabled, admin: adminEnabled, mini: true });
  });

  // Корень — публичный указатель: игра важнее админки, если включена.
  server.get('/', (_req, res) => {
    if (playEnabled) return res.redirect('/play/');
    if (adminEnabled) return res.redirect('/admin/');
    res.status(404).send('Ничего не включено: задай WEB_PLAY=1 или WEB_ADMIN=1');
  });

  server.use((req, res, next) => {
    if (!req.path.startsWith('/api/')) return next();
    const log = requestLogger().child({ scope: 'http', method: req.method, path: req.path });
    req.log = log;
    const started = Date.now();
    res.on('finish', () => {
      log.info('http.request', {
        status: res.statusCode,
        ms: Date.now() - started,
        userId: req.body?.userId || req.params?.userId || null,
      });
    });
    next();
  });

  const pushLogs = new Map(); // userId -> messages[]

  app.onOutbound(async ({ userId, message, kind, domainId, photoPath }) => {
    getLogger().info('outbound', {
      userId,
      kind,
      domainId,
      preview: truncate(message, 300),
      photoPath: photoPath || null,
    });
    if (!message) return;
    const list = pushLogs.get(String(userId)) || [];
    list.push({
      role: 'assistant',
      content: message,
      kind: kind || 'outbound',
      domainId,
      at: new Date().toISOString(),
    });
    pushLogs.set(String(userId), list.slice(-100));
  });

  function readInitData(req) {
    return String(
      req.get('x-telegram-init-data') || req.query.initData || req.body?.initData || '',
    ).trim();
  }

  function resolveMiniUser(req) {
    const initData = readInitData(req);
    const token = telegramBotToken(config);
    if (initData && token) {
      const checked = validateTelegramInitData(initData, token);
      if (!checked.ok) return { ok: false, status: 401, error: checked.error };
      if (!isTelegramAllowed(config, checked.userId)) {
        return { ok: false, status: 403, error: 'closed_test', message: closedTestReply(config) };
      }
      return { ok: true, userId: checked.userId };
    }
    if (playDevEnabled) {
      const userId = String(req.query.userId || req.body?.userId || '').trim();
      if (userId) return { ok: true, userId, preview: true };
    }
    return { ok: false, status: 401, error: 'need_telegram' };
  }

  // Без redirect: Express по умолчанию считает /mini и /mini/ одним маршрутом,
  // и 302 на /mini/ зацикливается (ERR_TOO_MANY_REDIRECTS в Telegram).
  const miniDir = path.join(projectRoot(), 'public', 'mini');
  server.use('/mini', express.static(miniDir, { redirect: false, index: false }));
  server.get('/mini', (_req, res) => {
    res.sendFile(path.join(miniDir, 'index.html'));
  });

  server.get('/api/mini/state', async (req, res) => {
    try {
      const who = resolveMiniUser(req);
      if (!who.ok) return res.status(who.status).json({ error: who.error, message: who.message || null });
      const world = await storage.getWorld();
      const domain = await storage.getDomainForUser(who.userId, world.id);
      const conflux = domain ? await findActiveConfluxForDomain(storage, domain.id) : null;
      if (domain && conflux) await overlayWithPartner(storage, domain, conflux);
      const payload = miniCityPayload({
        domain,
        conflux,
        world,
        config,
        day: worldDay(world, { config }),
        generating: app.isGenerating(who.userId),
      });
      res.json(payload);
    } catch (err) {
      req.log?.error('http.error', { error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  server.post('/api/mini/bless', async (req, res) => {
    try {
      const who = resolveMiniUser(req);
      if (!who.ok) return res.status(who.status).json({ error: who.error, message: who.message || null });
      const processId = String(req.body?.processId || '').trim();
      const result = await app.blessOwnProcess(who.userId, processId);
      if (!result.ok) {
        const status =
          result.error === 'ticking'
            ? 409
            : result.error === 'not_found' || result.error === 'no_domain'
              ? 404
              : 400;
        return res.status(status).json({
          ...result,
          error: result.error,
          message: result.message || result.error,
        });
      }
      res.json({ ok: true, mana: result.mana, cost: result.cost });
    } catch (err) {
      req.log?.error('http.error', { error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  server.get('/api/mini/officer-portrait/:officerId', async (req, res) => {
    try {
      const who = resolveMiniUser(req);
      if (!who.ok) return res.status(who.status).end();
      const world = await storage.getWorld();
      const domain = await storage.getDomainForUser(who.userId, world.id);
      const officer = (domain?.officers || []).find((o) => o.id === req.params.officerId);
      if (!officer || !officerHasPortrait(officer)) return res.status(404).end();
      if (officer.portraitUrl) return res.redirect(officer.portraitUrl);
      const picture = await resolveOfficerPortrait({ domain, officer, config });
      if (!picture?.abs) return res.status(404).end();
      res.type('png').sendFile(picture.abs);
    } catch (err) {
      if (err.code === 'ENOENT') return res.status(404).end();
      req.log?.error('http.error', { error: err.message });
      res.status(500).end();
    }
  });

  server.get('/api/mini/island-image', async (req, res) => {
    try {
      const who = resolveMiniUser(req);
      if (!who.ok) return res.status(who.status).end();
      const world = await storage.getWorld();
      const domain = await storage.getDomainForUser(who.userId, world.id);
      if (!domainHasIslandImage(domain)) return res.status(404).end();
      if (domain.imageUrl) return res.redirect(domain.imageUrl);
      const picture = await resolveIslandImage({ domain, config });
      if (!picture?.abs) return res.status(404).end();
      res.type('png').sendFile(picture.abs);
    } catch (err) {
      if (err.code === 'ENOENT') return res.status(404).end();
      req.log?.error('http.error', { error: err.message });
      res.status(500).end();
    }
  });

  // ------------------------------------------------------------------
  // Игровой клиент (локальная игра). Без пароля, включается WEB_PLAY.
  // ------------------------------------------------------------------
  if (playEnabled) {
    server.use('/play', express.static(path.join(projectRoot(), 'public', 'play')));

    server.get('/api/play/state', async (req, res) => {
      try {
        const userId = String(req.query.userId || 'local-user');
        const world = await storage.getWorld();
        const domain = await storage.getDomainForUser(userId, world.id);
        const character = domain?.characters?.[0] || null;
        // До появления города переписка живёт в черновике онбординга, а не у правителя.
        const source = domain
          ? character?.dialogHistory || []
          : (await storage.getUserBinding(userId))?.onboarding?.messages || [];
        const history = visibleDialogHistory(source).slice(-40).map((m) => ({
          role: m.role,
          content: m.content,
          kind: m.kind || (domain ? null : 'onboarding'),
          at: m.at || null,
        }));
        const day = worldDay(world, { config });
        const islands = await listPlayIslands(storage, world, day);
        res.json({
          userId,
          gameDate: { ...(world.gameDate || {}), ...gameDateFromDay(day), day },
          tickDate: world.gameDate || null,
          scheduler: world.scheduler || null,
          generating: app.isGenerating(userId),
          generatingProgress: app.generatingProgress.get(String(userId)) || null,
          genesisTutorial: app.isGenerating(userId) ? genesisTutorialText(config) || null : null,
          ticking: app.isWorldTicking(),
          clockHeld: clockIsHeld(world),
          canForceTick: playDevEnabled,
          canWipe: playDevEnabled,
          islands,
          domain: domain
            ? {
                id: domain.id,
                name: domain.name,
                population: domain.population,
                patronName: domain.state?.patronName || null,
                ruler: character
                  ? { name: character.name, title: character.title }
                  : null,
                stats: statsWithEpithets(domain.stats, config),
                imageUrl: domain.imageUrl
                  || (domain.imagePath || domain.imageBase64
                    ? `/api/play/island-image?userId=${encodeURIComponent(userId)}`
                    : null),
              }
            : null,
          history,
          pushes: (pushLogs.get(userId) || []).slice(-10),
        });
      } catch (err) {
        req.log?.error('http.error', { error: err.message });
        res.status(500).json({ error: err.message });
      }
    });

    server.get('/api/play/island-image', async (req, res) => {
      try {
        const userId = String(req.query.userId || 'local-user');
        const world = await storage.getWorld();
        const domain = await storage.getDomainForUser(userId, world.id);
        if (!domainHasIslandImage(domain)) return res.status(404).end();
        if (domain.imageUrl) return res.redirect(domain.imageUrl);
        const picture = await resolveIslandImage({ domain, config });
        if (!picture?.abs) return res.status(404).end();
        res.type('png').sendFile(picture.abs);
      } catch (err) {
        if (err.code === 'ENOENT') return res.status(404).end();
        req.log?.error('http.error', { error: err.message });
        res.status(500).json({ error: err.message });
      }
    });

    server.post('/api/play/chat', async (req, res) => {
      try {
        const userId = String(req.body.userId || 'local-user');
        const text = String(req.body.text || '').trim();
        const bootstrap = Boolean(req.body.bootstrap);
        if (!text && !bootstrap) return res.status(400).json({ error: 'text required' });
        const result = await app.handleUserMessage(userId, text, {
          channel: 'web',
          bootstrap,
        });
        res.json(result);
      } catch (err) {
        req.log?.error('http.error', { error: err.message, stack: err.stack });
        res.status(500).json({ error: err.message });
      }
    });

    // Полная картина своего города для тестового клиента: то же, что видит админка,
    // но только по домену этого слота и без пароля.
    server.get('/api/play/inspect', async (req, res) => {
      try {
        const userId = String(req.query.userId || 'local-user');
        const world = await storage.getWorld();
        const domain = await storage.getDomainForUser(userId, world.id);
        if (!domain) {
          return res.json({ userId, gameDate: world.gameDate, domain: null });
        }

        const lore = domain.lore || [];
        const chronicle = chronicleEntries(lore);
        const day = worldDay(world, { config });
        const conflux = await findActiveConfluxForDomain(storage, domain.id);
        const { partner: partnerDomain } = conflux
          ? await overlayWithPartner(storage, domain, conflux)
          : { partner: null };
        const overlay = new Set(domain._confluxOverlayIds || []);
        const cityPlots = (domain.plotlines || []).filter((p) => !overlay.has(p.id));

        res.json({
          userId,
          gameDate: { ...(world.gameDate || {}), ...gameDateFromDay(day), day },
          domain: {
            id: domain.id,
            name: domain.name,
            status: domain.status,
            channel: domain.channel,
            population: domain.population,
            description: domain.description || '',
            createdTick: domain.createdTick ?? null,
            lastTickAt: domain.lastTickAt || null,
            patronName: domain.state?.patronName || null,
            characters: (domain.characters || []).map((ch) => ({
              name: ch.name,
              title: ch.title,
              loyalty: ch.loyalty,
              terror: ch.terror,
              ageYears: ch.ageYears ?? null,
            })),
            stats: statsWithEpithets(domain.stats, config),
            faith: domain.state?.faith ?? null,
            mana: domain.state?.mana ?? 0,
            tags: (domain.tags || []).map((t) => t.tagName || t.tagId),
            processes: (domain.state?.pendingActions || []).map((p) => inspectProcess(p, day)),
            standingRules: cityRules(domain),
            proxyText: proxyText(domain) || null,
            priestOrders: priestOrders(domain),
            notify: notifySettings(domain),
            monthLog: domain.state?.monthLog || [],
            plotlines: cityPlots.map((p) => ({
              ...inspectPlot(p, day, lore),
              canDrop: canDropPlayStory(domain, p),
            })),
            closedPlotlines: (domain.closedPlotlines || []).map((p) => ({
              ...inspectPlot(p, day, lore),
              canDrop: false,
            })),
            cast: castRecords(lore),
            facts: lore
              .filter((f) => (f.tags || []).includes('fact'))
              .map((f) => ({
                id: f.id,
                text: f.text,
                gameDateLabel: f.gameDateLabel || null,
                author: f.author || null,
                retiredAt: f.retiredAt || null,
              })),
            chronicleCount: chronicle.length,
            chronicle: chronicle.slice(-60).map((e) => ({
              id: e.id,
              text: e.text,
              gameDateLabel: e.gameDateLabel || null,
              importance: e.importance || null,
              author: e.author || null,
              ...chronicleRelations(e, domain, conflux || {}),
              statChanges: e.statChanges || null,
            })),
            conflux: inspectConfluxBoard(conflux, domain, partnerDomain, world, day),
            confluxHistory: {
              monthsSolo: domain.confluxMonthsSolo ?? 0,
              monthsDocked: domain.confluxMonthsDocked ?? 0,
              partners: domain.confluxPartners || {},
            },
          },
        });
        if (conflux) stripConfluxView(domain);
      } catch (err) {
        req.log?.error('http.error', { error: err.message });
        res.status(500).json({ error: err.message });
      }
    });

    server.post('/api/play/bless', async (req, res) => {
      try {
        const userId = String(req.body?.userId || 'local-user');
        const processId = String(req.body?.processId || '').trim();
        const result = await app.blessOwnProcess(userId, processId);
        if (!result.ok) {
          const status =
            result.error === 'ticking'
              ? 409
              : result.error === 'not_found' || result.error === 'no_domain'
                ? 404
                : 400;
          return res.status(status).json({
            ...result,
            error: result.message || result.error,
          });
        }
        res.json(result);
      } catch (err) {
        req.log?.error('http.error', { error: err.message, stack: err.stack });
        res.status(500).json({ error: err.message });
      }
    });

    // Форс-тик для тестов: запускаем в фоне и сразу отвечаем — сам тик идёт минуты,
    // клиент следит за ним по флагу ticking в /api/play/state.
    if (playDevEnabled) {
      server.post('/api/play/tick', async (req, res) => {
        if (app.isWorldTicking()) {
          return res.status(409).json({ error: 'already_ticking', message: 'Шаг времени уже идёт.' });
        }
        const days = parseSkipDays(req.body?.days, { fallback: DAYS_PER_MONTH });
        if (days == null) {
          return res.status(400).json({ error: 'bad_days', message: 'дни: целое от 1 до 360' });
        }
        const runTick = req.app.get('runTick');
        const start = async () => {
          if (typeof runTick === 'function') return runTick('play-force', { days });
          await skipStoredWorldDays(storage, days, { config });
          return runDayLoop({
            config,
            runtime,
            storage,
            app,
            allowWhileHeld: true,
            log: getLogger().child({ scope: 'dayLoop', reason: 'play-force' }),
          });
        };
        getLogger().info('play.force_tick', { userId: String(req.body?.userId || ''), days });
        setImmediate(() => {
          start().catch((err) =>
            getLogger().error('play.force_tick.failed', { error: err.message, stack: err.stack }),
          );
        });
        res.json({ ok: true, started: true, days });
      });

      // Вайп мира из клиента: тот же путь, что в админке, но с явным подтверждением.
      server.post('/api/play/wipe', async (req, res) => {
        try {
          if (req.body?.confirm !== true) {
            return res.status(400).json({ error: 'confirm_required' });
          }
          if (app.isWorldTicking()) {
            return res
              .status(409)
              .json({ error: 'ticking', message: 'Идёт шаг времени — дождись его конца.' });
          }
          const status = await app.wipeAll();
          pushLogs.clear();
          const resync = req.app.get('resyncScheduler');
          if (typeof resync === 'function') await resync();
          getLogger().warn('play.wipe', { userId: String(req.body?.userId || ''), status });
          res.json({ ok: true, status });
        } catch (err) {
          req.log?.error('http.error', { error: err.message, stack: err.stack });
          res.status(500).json({ error: err.message });
        }
      });

      server.post('/api/play/clock', async (req, res) => {
        try {
          const held = req.body?.held;
          if (typeof held !== 'boolean') {
            return res.status(400).json({ error: 'held_required', message: 'нужно held: true или false' });
          }
          const result = await app.setClockHeld(held);
          getLogger().info('play.clock', {
            userId: String(req.body?.userId || ''),
            clockHeld: result.clockHeld,
            day: result.day,
          });
          res.json(result);
        } catch (err) {
          req.log?.error('http.error', { error: err.message, stack: err.stack });
          res.status(500).json({ error: err.message });
        }
      });

      server.get('/api/play/snapshots', async (_req, res) => {
        try {
          res.json({ ok: true, snapshots: await app.listPlaySnapshots() });
        } catch (err) {
          _req.log?.error('http.error', { error: err.message });
          res.status(500).json({ error: err.message });
        }
      });

      server.post('/api/play/snapshots', async (req, res) => {
        try {
          const result = await app.savePlaySnapshot({ label: req.body?.label });
          if (!result.ok) {
            const status = result.error === 'too_many' ? 409 : 400;
            return res.status(status).json(result);
          }
          getLogger().info('play.snapshot_save', {
            userId: String(req.body?.userId || ''),
            id: result.id,
            label: result.label,
          });
          res.json(result);
        } catch (err) {
          req.log?.error('http.error', { error: err.message, stack: err.stack });
          res.status(500).json({ error: err.message });
        }
      });

      server.post('/api/play/snapshots/load', async (req, res) => {
        try {
          const id = String(req.body?.id || '').trim();
          const result = await app.loadPlaySnapshot(id);
          if (!result.ok) {
            const status =
              result.error === 'ticking' || result.error === 'busy'
                ? 409
                : result.error === 'not_found'
                  ? 404
                  : 400;
            return res.status(status).json(result);
          }
          const resync = req.app.get('resyncScheduler');
          if (typeof resync === 'function') await resync();
          getLogger().info('play.snapshot_load', {
            userId: String(req.body?.userId || ''),
            id,
            worldId: result.worldId,
          });
          res.json(result);
        } catch (err) {
          req.log?.error('http.error', { error: err.message, stack: err.stack });
          res.status(500).json({ error: err.message });
        }
      });

      server.delete('/api/play/snapshots/:id', async (req, res) => {
        try {
          const result = await app.deletePlaySnapshot(req.params.id);
          if (!result.ok) {
            const status = result.error === 'not_found' ? 404 : 400;
            return res.status(status).json(result);
          }
          res.json(result);
        } catch (err) {
          req.log?.error('http.error', { error: err.message, stack: err.stack });
          res.status(500).json({ error: err.message });
        }
      });

      server.post('/api/play/seed', async (req, res) => {
        try {
          const userId = String(req.body?.userId || 'local-user');
          const result = await app.forceSeedStory(userId, {
            gravity: req.body?.gravity,
            grain: req.body?.grain,
            mystery: req.body?.mystery,
          });
          if (!result.ok) {
            const status =
              result.error === 'ticking' || result.error === 'busy' || result.error === 'board_full'
                ? 409
                : result.error === 'no_domain'
                  ? 404
                  : result.error === 'plant_failed'
                    ? 502
                    : 400;
            return res.status(status).json(result);
          }
          getLogger().info('play.force_seed', {
            userId,
            grain: result.grain,
            gravity: result.gravity,
            mystery: Boolean(result.requireMystery),
            title: result.plot?.title,
          });
          res.json(result);
        } catch (err) {
          req.log?.error('http.error', { error: err.message, stack: err.stack });
          res.status(500).json({ error: err.message });
        }
      });

      server.post('/api/play/force-threat', async (req, res) => {
        try {
          const userId = String(req.body?.userId || 'local-user');
          const result = await app.forcePlayThreat(userId, {
            plotId: req.body?.plotId,
            threatId: req.body?.threatId,
          });
          if (!result.ok) {
            const status =
              result.error === 'ticking'
                ? 409
                : result.error === 'not_found' || result.error === 'no_domain'
                  ? 404
                  : 400;
            return res.status(status).json(result);
          }
          res.json(result);
        } catch (err) {
          req.log?.error('http.error', { error: err.message, stack: err.stack });
          res.status(500).json({ error: err.message });
        }
      });

      server.post('/api/play/force-deed', async (req, res) => {
        try {
          const userId = String(req.body?.userId || 'local-user');
          const result = await app.forcePlayDeed(userId, {
            processId: req.body?.processId,
            finish: req.body?.finish,
          });
          if (!result.ok) {
            const status =
              result.error === 'ticking'
                ? 409
                : result.error === 'not_found' || result.error === 'no_domain'
                  ? 404
                  : 400;
            return res.status(status).json(result);
          }
          res.json(result);
        } catch (err) {
          req.log?.error('http.error', { error: err.message, stack: err.stack });
          res.status(500).json({ error: err.message });
        }
      });

      server.post('/api/play/notify-chronicle', async (req, res) => {
        try {
          const userId = String(req.body?.userId || 'local-user');
          const result = await app.notifyPlayChronicle(userId, {
            factId: req.body?.factId,
          });
          if (!result.ok) {
            const status =
              result.error === 'ticking'
                ? 409
                : result.error === 'not_found' || result.error === 'no_domain'
                  ? 404
                  : 400;
            return res.status(status).json(result);
          }
          res.json(result);
        } catch (err) {
          req.log?.error('http.error', { error: err.message, stack: err.stack });
          res.status(500).json({ error: err.message });
        }
      });

      server.post('/api/play/drop-story', async (req, res) => {
        try {
          const userId = String(req.body?.userId || 'local-user');
          const plotId = String(req.body?.plotId || '').trim();
          const result = await app.dropPlayStory(userId, plotId);
          if (!result.ok) {
            const status =
              result.error === 'ticking'
                ? 409
                : result.error === 'not_found' || result.error === 'no_domain'
                  ? 404
                  : 400;
            return res.status(status).json(result);
          }
          res.json(result);
        } catch (err) {
          req.log?.error('http.error', { error: err.message, stack: err.stack });
          res.status(500).json({ error: err.message });
        }
      });
    }

    server.post('/api/play/slot', async (_req, res) => {
      const userId = `local-${Date.now().toString(36)}-${Math.floor(Math.random() * 1000)}`;
      getLogger().info('play.new_slot', { userId });
      res.json({ userId });
    });
  }

  const onPaaS = Boolean(process.env.DYNO || process.env.RAILWAY_ENVIRONMENT);
  if (playEnabled || !onPaaS) {
    mountFreeformLab(server, { config, runtime });
  }

  // ------------------------------------------------------------------
  // Админка: всё ниже за Basic auth, включается WEB_ADMIN.
  // ------------------------------------------------------------------
  if (!adminEnabled) return server;

  server.use(adminBasicAuth(config));
  server.use('/admin', express.static(path.join(projectRoot(), 'public', 'admin')));

  server.get('/api/status', async (_req, res) => {
    try {
      res.json(await app.getStatus());
    } catch (err) {
      _req.log?.error('http.error', { error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  server.get('/api/users', async (_req, res) => {
    try {
      res.json(await app.listUsers());
    } catch (err) {
      _req.log?.error('http.error', { error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  server.get('/api/domains', async (_req, res) => {
    try {
      const domains = await app.listDomains();
      res.json(domains.map(domainSummary));
    } catch (err) {
      _req.log?.error('http.error', { error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  server.get('/api/domains/:id', async (req, res) => {
    try {
      const domain = await app.inspectDomain(req.params.id);
      if (!domain) return res.status(404).json({ error: 'not found' });
      res.json({
        ...domain,
        characters: (domain.characters || []).map((ch) => ({
          ...ch,
          dialogHistory: visibleDialogHistory(ch.dialogHistory),
        })),
      });
    } catch (err) {
      req.log?.error('http.error', { error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  server.get('/api/domains/:id/image', async (req, res) => {
    try {
      const domain = await app.inspectDomain(req.params.id);
      if (!domainHasIslandImage(domain)) return res.status(404).end();
      if (domain.imageUrl) return res.redirect(domain.imageUrl);
      const picture = await resolveIslandImage({ domain, config });
      if (!picture?.abs) return res.status(404).end();
      res.type('png').sendFile(picture.abs);
    } catch (err) {
      if (err.code === 'ENOENT') return res.status(404).end();
      req.log?.error('http.error', { error: err.message });
      res.status(500).end();
    }
  });

  server.get('/api/domains/:id/onboarding', async (req, res) => {
    try {
      const domain = await app.inspectDomain(req.params.id);
      if (!domain) return res.status(404).json({ error: 'not found' });
      const binding = await bindingForDomain(storage, domain);
      const userId = binding?.userId || domain.ownerUserId;
      res.json(
        onboardingArchive(binding, {
          userId,
          domainId: domain.id,
          generating: userId ? app.isGenerating(userId) : false,
        }),
      );
    } catch (err) {
      req.log?.error('http.error', { error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  server.get('/api/users/:userId/onboarding', async (req, res) => {
    try {
      const userId = String(req.params.userId || '').trim();
      if (!userId) return res.status(400).json({ error: 'userId required' });
      const binding = await storage.getUserBinding(userId);
      if (!binding) return res.status(404).json({ error: 'not found' });
      res.json(
        onboardingArchive(binding, {
          userId,
          generating: app.isGenerating(userId),
        }),
      );
    } catch (err) {
      req.log?.error('http.error', { error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  server.get('/api/users/:userId/domain', async (req, res) => {
    try {
      const world = await storage.getWorld();
      const userId = req.params.userId;
      const domain = await storage.getDomainForUser(userId, world.id);
      res.json({
        domain: domain || null,
        generating: app.isGenerating(userId),
        ticking: app.isWorldTicking(),
      });
    } catch (err) {
      req.log?.error('http.error', { error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  server.get('/api/users/:userId/pushes', async (req, res) => {
    const list = pushLogs.get(String(req.params.userId)) || [];
    res.json({ messages: list });
  });

  server.get('/api/domains/:id/chronicle', async (req, res) => {
    try {
      const data = await app.getChronicle(req.params.id);
      if (!data) return res.status(404).json({ error: 'not found' });
      res.json(data);
    } catch (err) {
      req.log?.error('http.error', { error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  server.post('/api/dev/new-slot', async (_req, res) => {
    try {
      const userId = `local-${Date.now().toString(36)}-${Math.floor(Math.random() * 1000)}`;
      getLogger().info('dev.new_slot', { userId });
      res.json({
        userId,
        hint: 'Слот для отладки; игроки входят через Telegram.',
      });
    } catch (err) {
      _req.log?.error('http.error', { error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  server.post('/api/dev/wipe', async (req, res) => {
    try {
      const status = await app.wipeAll();
      pushLogs.clear();
      const resync = req.app.get('resyncScheduler');
      if (typeof resync === 'function') await resync();
      getLogger().warn('dev.wipe', { status });
      res.json({ ok: true, status });
    } catch (err) {
      req.log?.error('http.error', { error: err.message, stack: err.stack });
      res.status(500).json({ error: err.message });
    }
  });

  // Игровой чат живёт в клиенте (/api/play/chat), в админке его нет.
  server.post('/api/chat', (_req, res) => {
    res.status(404).json({
      error: 'use_play_client',
      message: 'Чат — в игровом клиенте (/play) или в Telegram. Админка только смотрит.',
    });
  });

  server.post('/api/tick', async (req, res) => {
    try {
      getLogger().info('http.tick');
      const runTick = req.app.get('runTick');
      let result;
      if (typeof runTick === 'function') {
        result = await runTick('manual');
      } else {
        result = await runWorldTick({ config, runtime, storage, app });
        await recordTickCompleted(storage, config);
      }
      res.json(result);
    } catch (err) {
      req.log?.error('http.error', { error: err.message, stack: err.stack });
      res.status(500).json({ error: err.message });
    }
  });

  server.get('/api/confluxes', async (req, res) => {
    try {
      const world = await storage.getWorld();
      const day = worldDay(world, { config });
      const domains = await storage.listDomains();
      const byId = Object.fromEntries(domains.map((d) => [d.id, d]));
      const activeOnly = req.query.all !== '1';
      const list = await storage.listConfluxes(
        activeOnly ? { status: ['approaching', 'docked'] } : {},
      );
      res.json({
        confluxes: list.map((c) => confluxSummary(c, world, byId, day)),
      });
    } catch (err) {
      req.log?.error('http.error', { error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  server.post('/api/dev/conflux', async (req, res) => {
    try {
      const domainIdA = String(req.body.domainIdA || '').trim();
      const domainIdB = String(req.body.domainIdB || '').trim();
      const prepDays = req.body.prepDays != null ? Number(req.body.prepDays) : null;
      const dockDays = req.body.dockDays != null ? Number(req.body.dockDays) : null;
      const etaMonths = req.body.etaMonths != null ? Number(req.body.etaMonths) : null;
      const durationMonths = req.body.durationMonths != null ? Number(req.body.durationMonths) : null;
      if (!domainIdA || !domainIdB) {
        return res.status(400).json({ error: 'domainIdA and domainIdB required' });
      }
      const created = await forceCreateConflux({
        storage,
        domainIdA,
        domainIdB,
        prepDays,
        dockDays,
        etaMonths,
        durationMonths,
        config,
        runtime,
      });
      const { conflux, domains, announce } = created;
      if (announce) {
        await emitConfluxAnnouncements({
          app,
          storage,
          items: [
            {
              confluxId: conflux.id,
              rematch: conflux.rematch,
              etaMonths: conflux.etaMonths,
              announce,
            },
          ],
        });
      }
      const world = await storage.getWorld();
      const byId = Object.fromEntries(domains.map((d) => [d.id, d]));
      getLogger().info('dev.conflux', {
        id: conflux.id,
        domainIdA,
        domainIdB,
        etaMonths: conflux.etaMonths,
      });
      res.json({
        ok: true,
        conflux: confluxSummary(conflux, world, byId),
      });
    } catch (err) {
      req.log?.error('http.error', { error: err.message, stack: err.stack });
      res.status(400).json({ error: err.message });
    }
  });

  async function loadDevPair(confluxId) {
    const conflux = await storage.getConflux(confluxId);
    if (!conflux) return null;
    const world = await storage.getWorld();
    const domains = [];
    for (const id of conflux.domainIds || []) {
      const d = await storage.getDomain(id);
      if (d) domains.push(d);
    }
    return { conflux, world, domains };
  }

  server.post('/api/dev/conflux/:id/dock', async (req, res) => {
    try {
      const loaded = await loadDevPair(req.params.id);
      if (!loaded) return res.status(404).json({ error: 'conflux not found' });
      const { conflux, world, domains } = loaded;
      await dockConfluxNow({
        config,
        runtime,
        conflux,
        domains,
        world,
        day: world.dayIndex,
      });
      for (const d of domains) await storage.saveDomain(d);
      await storage.saveConflux(conflux);
      const byId = Object.fromEntries(domains.map((d) => [d.id, d]));
      res.json({ ok: true, conflux: confluxSummary(conflux, world, byId) });
    } catch (err) {
      req.log?.error('http.error', { error: err.message });
      res.status(400).json({ error: err.message });
    }
  });

  server.post('/api/dev/conflux/:id/undock', async (req, res) => {
    try {
      const loaded = await loadDevPair(req.params.id);
      if (!loaded) return res.status(404).json({ error: 'conflux not found' });
      const { conflux, world, domains } = loaded;
      await undockConfluxNow({
        runtime,
        conflux,
        domains,
        world,
        day: world.dayIndex,
        config,
      });
      for (const d of domains) await storage.saveDomain(d);
      await storage.saveConflux(conflux);
      await storage.updateWorld((fresh) => commitWorldChanges(fresh, world));
      const byId = Object.fromEntries(domains.map((d) => [d.id, d]));
      res.json({ ok: true, conflux: confluxSummary(conflux, world, byId) });
    } catch (err) {
      req.log?.error('http.error', { error: err.message });
      res.status(400).json({ error: err.message });
    }
  });

  server.post('/api/dev/conflux/:id/crystallize', async (req, res) => {
    try {
      const loaded = await loadDevPair(req.params.id);
      if (!loaded) return res.status(404).json({ error: 'conflux not found' });
      return res.status(400).json({ error: 'сопряжение не нить' });
    } catch (err) {
      req.log?.error('http.error', { error: err.message });
      res.status(400).json({ error: err.message });
    }
  });

  return server;
}
