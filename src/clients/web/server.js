import express from 'express';
import path from 'node:path';
import { projectRoot } from '../../config.js';
import { runWorldTick } from '../../game/tick.js';
import { domainSummary } from '../../game/genesis.js';

export function createWebServer({ config, app, runtime, storage }) {
  const server = express();
  server.use(express.json({ limit: '1mb' }));
  server.use(express.static(path.join(projectRoot(), 'public')));

  // In-memory push log for local UI (also filled by outbound)
  const pushLogs = new Map(); // userId -> messages[]

  app.onOutbound(async ({ userId, message, kind, domainId }) => {
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
      res.status(500).json({ error: err.message });
    }
  });

  server.get('/api/domains', async (_req, res) => {
    try {
      const domains = await app.listDomains();
      res.json(domains.map(domainSummary));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  server.get('/api/domains/:id', async (req, res) => {
    try {
      const domain = await app.inspectDomain(req.params.id);
      if (!domain) return res.status(404).json({ error: 'not found' });
      res.json(domain);
    } catch (err) {
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
      res.status(500).json({ error: err.message });
    }
  });

  server.post('/api/dev/new-slot', async (_req, res) => {
    try {
      const userId = `local-${Date.now().toString(36)}-${Math.floor(Math.random() * 1000)}`;
      res.json({ userId, hint: 'Напиши проводнику, чтобы создать город для этого слота' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  server.post('/api/dev/wipe', async (_req, res) => {
    try {
      const status = await app.wipeAll();
      pushLogs.clear();
      res.json({ ok: true, status });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  });

  server.post('/api/chat', async (req, res) => {
    try {
      const userId = String(req.body.userId || 'local-user');
      const text = String(req.body.text || '').trim();
      if (!text) return res.status(400).json({ error: 'text required' });
      const result = await app.handleUserMessage(userId, text, { channel: 'web' });
      res.json(result);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  });

  server.post('/api/tick', async (_req, res) => {
    try {
      const result = await runWorldTick({ config, runtime, storage, app });
      res.json(result);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  });

  return server;
}
