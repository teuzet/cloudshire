/**
 * Dev-клиент: игра в браузере без Telegram. Чат как игрок, инспектор города,
 * промотка дней, сброс. Ходит в настоящие модели — запускать осознанно.
 *
 *   npm run dev  →  http://localhost:3000
 *   PORT, DATA_DIR / MONGODB_URI, OPENAI_API_KEY / ANTHROPIC_API_KEY
 */

import http from 'node:http';
import { MemoryNotifier } from '../../adapters/notifier/memory.js';
import { requireWorld, today } from '../../flows/context.js';
import { onboardingMessage, resetPlayer, runGenesis } from '../../flows/onboarding.js';
import { patronMessage } from '../../flows/priest-turn.js';
import { runDueCities } from '../../flows/scheduler.js';
import { skipWorldDays } from '../../flows/world.js';
import { gameDate } from '../../core/time.js';
import { buildApp } from '../app.js';
import { cityStatus } from '../views.js';
import { PAGE } from './page.js';

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

function send(res: http.ServerResponse, status: number, body: unknown, type = 'application/json'): void {
  res.writeHead(status, { 'content-type': `${type}; charset=utf-8` });
  res.end(type === 'application/json' ? JSON.stringify(body) : String(body));
}

async function main(): Promise<void> {
  const inbox = new MemoryNotifier();
  const app = await buildApp(process.env, inbox);
  const { deps, locks } = app;

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const owner = url.searchParams.get('owner') ?? 'dev';
      if (req.method === 'GET' && url.pathname === '/') return send(res, 200, PAGE, 'text/html');

      if (req.method === 'GET' && url.pathname === '/api/state') {
        const world = await requireWorld(deps);
        const day = today(deps, world);
        const city = await deps.storage.getCityByOwner(owner);
        const draft = city ? null : await deps.storage.getDraft(owner);
        return send(res, 200, {
          day,
          date: gameDate(day).label,
          status: city ? cityStatus(deps.rules, city, day) : null,
          city,
          draft,
          inbox: inbox.drain(owner),
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/say') {
        const body = await readJson(req);
        const text = String(body.text ?? '');
        const quote = typeof body.quote === 'string' && body.quote ? body.quote : null;
        if (await deps.storage.getCityByOwner(owner)) {
          const r = await patronMessage(deps, locks, { ownerId: owner, text, quote });
          return send(res, 200, { reply: r.kind === 'no_city' ? null : r.text, kind: r.kind });
        }
        const r = await onboardingMessage(deps, { ownerId: owner, text });
        if (r.kind === 'reply' && r.ready) {
          const city = await runGenesis(deps, owner);
          return send(res, 200, { reply: r.text, kind: city ? 'genesis' : 'genesis_failed' });
        }
        return send(res, 200, { reply: r.kind === 'has_city' ? null : r.text, kind: r.kind });
      }

      if (req.method === 'POST' && url.pathname === '/api/skip') {
        const body = await readJson(req);
        await skipWorldDays(deps, Math.max(0, Math.min(3600, Number(body.days) || 0)));
        const ran = await runDueCities(deps, locks);
        return send(res, 200, ran);
      }

      if (req.method === 'POST' && url.pathname === '/api/reset') {
        await resetPlayer(deps, owner);
        inbox.drain(owner);
        return send(res, 200, { ok: true });
      }
      send(res, 404, { error: 'нет такого' });
    } catch (err) {
      console.error('[dev]', err);
      send(res, 500, { error: String(err) });
    }
  });

  const port = Number(process.env.PORT ?? 3000);
  server.listen(port, () => console.log(`cloudshire dev: http://localhost:${port}`));
  setInterval(() => void runDueCities(deps, locks).catch((err) => console.error('[tick]', err)), 10_000);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
