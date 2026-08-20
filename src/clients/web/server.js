import express from 'express';
import path from 'node:path';
import { projectRoot } from '../../config.js';
import { runWorldTick } from '../../game/tick.js';
import { domainSummary } from '../../game/genesis.js';
import { getLogger, requestLogger, truncate } from '../../log.js';

export function createWebServer({ config, app, runtime, storage }) {
  const server = express();
  server.use(express.json({ limit: '1mb' }));
  server.use(express.static(path.join(projectRoot(), 'public')));

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

  server.get('/api/status', async (_req, res) => {
    try {
      res.json(await app.getStatus());
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
      res.json({ userId, hint: 'Напиши проводнику, чтобы создать город для этого слота' });
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

  server.post('/api/chat', async (req, res) => {
    try {
      const userId = String(req.body.userId || 'local-user');
      const text = String(req.body.text || '').trim();
      const bootstrap = Boolean(req.body.bootstrap);
      if (!text && !bootstrap) return res.status(400).json({ error: 'text required' });
      req.log?.info('http.chat', {
        userId,
        bootstrap,
        text: truncate(text, 300),
      });
      const result = await app.handleUserMessage(userId, text, {
        channel: 'web',
        bootstrap,
      });
      req.log?.info('http.chat.done', {
        agent: result.agent,
        generating: result.generating,
        domainId: result.domainId,
        replyPreview: truncate(result.reply, 300),
      });
      res.json(result);
    } catch (err) {
      req.log?.error('http.error', { error: err.message, stack: err.stack });
      res.status(500).json({ error: err.message });
    }
  });

  server.post('/api/tick', async (req, res) => {
    try {
      getLogger().info('http.tick');
      const result = await runWorldTick({ config, runtime, storage, app });
      res.json(result);
    } catch (err) {
      req.log?.error('http.error', { error: err.message, stack: err.stack });
      res.status(500).json({ error: err.message });
    }
  });

  return server;
}
