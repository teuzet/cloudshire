import express from 'express';
import path from 'node:path';
import { projectRoot, hasAdminCredentials } from '../../config.js';
import { runWorldTick, emitConfluxAnnouncements } from '../../game/tick.js';
import { recordTickCompleted } from '../../scheduler/ticks.js';
import { domainSummary } from '../../game/genesis.js';
import {
  forceCreateConflux,
  confluxSummary,
  findActiveConfluxForDomain,
  monthsUntilDock,
} from '../../game/conflux.js';
import { getLogger, requestLogger, truncate } from '../../log.js';
import { statEpithet } from '../../game/stats.js';
import { chronicleEntries, castRecords } from '../../game/models.js';
import { stripPlotSecrets } from '../../game/plotlines.js';
import { FINISH_SHORT } from '../../game/rolls.js';
import { resolveIslandImage } from '../../game/islandImage.js';
import { knownPartnerLore } from '../../game/confluxBoard.js';
import { genesisTutorialText } from '../../game/progressBar.js';
import { orderMonthsLeft } from '../../game/orders.js';
import { miniCityPayload } from '../../game/miniCity.js';
import {
  validateTelegramInitData,
  telegramBotToken,
} from '../telegram/initData.js';
import { isTelegramAllowed, closedTestReply } from '../telegram/access.js';

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

function publicLore(domain) {
  return (domain?.lore || []).filter((f) => f && !f.secret);
}

function nameForDomain(id, domain, partner) {
  const sid = String(id || '');
  if (sid && sid === String(domain?.id)) return domain.name;
  if (sid && sid === String(partner?.id)) return partner.name;
  return sid || null;
}

/** Живая доска конфлюкса и корпус информатора этого города. */
function inspectConfluxBoard(conflux, domain, partner, world) {
  if (!conflux) return null;
  const viewerId = String(domain.id);
  const partnerId = partner ? String(partner.id) : null;
  const names = Object.fromEntries(
    (conflux.domainIds || []).map((id) => [String(id), nameForDomain(id, domain, partner) || String(id)]),
  );
  const known = partner ? knownPartnerLore(partner, conflux, viewerId) : [];
  const theyKnow = partnerId ? knownPartnerLore(domain, conflux, partnerId) : [];
  const byTick = (a, b) => (Number(b.tick) || 0) - (Number(a.tick) || 0);
  return {
    ...confluxSummary(conflux, world, {
      [domain.id]: domain,
      ...(partner ? { [partner.id]: partner } : {}),
    }),
    partnerName: partner?.name || partnerId,
    mainPlotId: conflux.mainPlotId || null,
    awareness: {
      ours: Number(conflux.awareness?.[viewerId] || 0),
      theirs: partnerId ? Number(conflux.awareness?.[partnerId] || 0) : 0,
    },
    informant: {
      knownCount: known.length,
      publicCount: publicLore(partner).length,
      known: [...known].sort(byTick).map(slimLore),
      theyKnowCount: theyKnow.length,
      theyPublicCount: publicLore(domain).length,
      theyKnow: [...theyKnow].sort(byTick).map(slimLore),
    },
    plotlines: (conflux.plotlines || []).map(stripPlotSecrets),
    closedPlotlines: (conflux.closedPlotlines || []).slice(-20).map(stripPlotSecrets),
    processes: conflux.processes || [],
    lore: [...(conflux.lore || [])].slice(-40).map(slimLore),
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

/** Острова текущего мира для переключателя тестового клиента. */
async function listPlayIslands(storage, world) {
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
            monthsUntilDock:
              cf.status === 'approaching' ? monthsUntilDock(cf, world) : null,
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
function statsWithEpithets(stats, config) {
  return (config.stats || []).map((def) => {
    const value = Number(stats?.[def.id]);
    const v = Number.isFinite(value) ? value : 50;
    return { id: def.id, name: def.name, value: v, epithet: statEpithet(v, config) };
  });
}

function adminBasicAuth(config) {
  const user = config.admin?.user || '';
  const password = config.admin?.password || '';
    const required = hasAdminCredentials(config) || Boolean(process.env.DYNO || process.env.RAILWAY_ENVIRONMENT);

  return (req, res, next) => {
    if (req.path === '/health') return next();

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
      const payload = miniCityPayload({
        domain,
        conflux,
        world,
        config,
        generating: app.isGenerating(who.userId),
      });
      res.json(payload);
    } catch (err) {
      req.log?.error('http.error', { error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  server.get('/api/mini/island-image', async (req, res) => {
    try {
      const who = resolveMiniUser(req);
      if (!who.ok) return res.status(who.status).end();
      const world = await storage.getWorld();
      const domain = await storage.getDomainForUser(who.userId, world.id);
      if (!domain?.imagePath && !domain?.imageBase64) return res.status(404).end();
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
        const history = source.slice(-40).map((m) => ({
          role: m.role,
          content: m.content,
          kind: m.kind || (domain ? null : 'onboarding'),
          at: m.at || null,
        }));
        const islands = await listPlayIslands(storage, world);
        res.json({
          userId,
          gameDate: world.gameDate,
          scheduler: world.scheduler || null,
          generating: app.isGenerating(userId),
          generatingProgress: app.generatingProgress.get(String(userId)) || null,
          genesisTutorial: app.isGenerating(userId) ? genesisTutorialText(config) || null : null,
          ticking: app.isWorldTicking(),
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
                imageUrl: domain.imagePath || domain.imageBase64
                  ? `/api/play/island-image?userId=${encodeURIComponent(userId)}`
                  : null,
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
        if (!domain?.imagePath && !domain?.imageBase64) return res.status(404).end();
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
        const conflux = await findActiveConfluxForDomain(storage, domain.id);
        const partner = conflux
          ? (conflux.domainIds || []).find((id) => id !== domain.id)
          : null;
        const partnerDomain = partner ? await storage.getDomain(partner) : null;

        res.json({
          userId,
          gameDate: world.gameDate,
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
            tags: (domain.tags || []).map((t) => t.tagName || t.tagId),
            processes: domain.state?.pendingActions || [],
            standingOrders: (domain.state?.modifiers || []).map((m) => ({
              ...m,
              remainingMonths: orderMonthsLeft(m.expiresTick, world?.tickIndex),
            })),
            monthLog: domain.state?.monthLog || [],
            plotlines: (domain.plotlines || []).map(stripPlotSecrets),
            closedPlotlines: (domain.closedPlotlines || []).slice(-20).map(stripPlotSecrets),
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
            conflux: inspectConfluxBoard(conflux, domain, partnerDomain, world),
            confluxHistory: {
              monthsSolo: domain.confluxMonthsSolo ?? 0,
              monthsDocked: domain.confluxMonthsDocked ?? 0,
              partners: domain.confluxPartners || {},
            },
          },
        });
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
        const runTick = req.app.get('runTick');
        const start = async () => {
          if (typeof runTick === 'function') return runTick('play-force');
          const result = await runWorldTick({ config, runtime, storage, app });
          await recordTickCompleted(storage, config);
          return result;
        };
        getLogger().info('play.force_tick', { userId: String(req.body?.userId || '') });
        setImmediate(() => {
          start().catch((err) =>
            getLogger().error('play.force_tick.failed', { error: err.message, stack: err.stack }),
          );
        });
        res.json({ ok: true, started: true });
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
              .json({ error: 'ticking', message: 'Идёт шаг времени — дождись конца месяца.' });
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
    }

    server.post('/api/play/slot', async (_req, res) => {
      const userId = `local-${Date.now().toString(36)}-${Math.floor(Math.random() * 1000)}`;
      getLogger().info('play.new_slot', { userId });
      res.json({ userId });
    });
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
      res.json(domain);
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
      const domains = await storage.listDomains();
      const byId = Object.fromEntries(domains.map((d) => [d.id, d]));
      const activeOnly = req.query.all !== '1';
      const list = await storage.listConfluxes(
        activeOnly ? { status: ['approaching', 'docked'] } : {},
      );
      res.json({
        confluxes: list.map((c) => confluxSummary(c, world, byId)),
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
      const etaMonths = Number(req.body.etaMonths ?? 3);
      const durationMonths = Number(req.body.durationMonths ?? 3);
      if (!domainIdA || !domainIdB) {
        return res.status(400).json({ error: 'domainIdA and domainIdB required' });
      }
      const created = await forceCreateConflux({
        storage,
        domainIdA,
        domainIdB,
        etaMonths,
        durationMonths,
        config,
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

  return server;
}
