import express from 'express';
import path from 'node:path';
import { projectRoot, hasAdminCredentials } from '../../config.js';
import { runWorldTick } from '../../game/tick.js';
import { recordTickCompleted } from '../../scheduler/ticks.js';
import { domainSummary } from '../../game/genesis.js';
import {
  forceCreateConflux,
  confluxSummary,
  findActiveConfluxForDomain,
} from '../../game/conflux.js';
import { getLogger, requestLogger, truncate } from '../../log.js';
import { statEpithet } from '../../game/stats.js';
import { chronicleEntries, castRecords } from '../../game/models.js';

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
    res.json({ ok: true, play: playEnabled, admin: adminEnabled });
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

  app.onOutbound(async ({ userId, message, kind, domainId }) => {
    getLogger().info('outbound', {
      userId,
      kind,
      domainId,
      preview: truncate(message, 300),
    });
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
        res.json({
          userId,
          gameDate: world.gameDate,
          scheduler: world.scheduler || null,
          generating: app.isGenerating(userId),
          ticking: app.isWorldTicking(),
          canForceTick: playDevEnabled,
          canWipe: playDevEnabled,
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
            })),
            stats: statsWithEpithets(domain.stats, config),
            tags: (domain.tags || []).map((t) => t.tagName || t.tagId),
            processes: domain.state?.pendingActions || [],
            standingOrders: domain.state?.modifiers || [],
            monthLog: domain.state?.monthLog || [],
            plotlines: domain.plotlines || [],
            closedPlotlines: (domain.closedPlotlines || []).slice(-20),
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
              plotlineId: e.plotlineId || null,
              statChanges: e.statChanges || null,
            })),
            conflux: conflux
              ? {
                  ...confluxSummary(conflux, world, {
                    [domain.id]: domain,
                    ...(partnerDomain ? { [partnerDomain.id]: partnerDomain } : {}),
                  }),
                  partnerName: partnerDomain?.name || partner || null,
                }
              : null,
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
      const { conflux, domains } = await forceCreateConflux({
        storage,
        domainIdA,
        domainIdB,
        etaMonths,
        durationMonths,
      });
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
