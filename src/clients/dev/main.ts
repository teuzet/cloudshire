/**
 * Dev-клиент: игра в браузере без Telegram. Чат как игрок, инспектор города,
 * промотка дней, сброс. Ходит в настоящие модели — запускать осознанно.
 *
 *   npm run dev  →  http://localhost:3000
 *   PORT, DATA_DIR / MONGODB_URI, OPENAI_API_KEY / ANTHROPIC_API_KEY
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { MemoryNotifier } from '../../adapters/notifier/memory.js';
import { requireWorld, today } from '../../flows/context.js';
import { onboardingMessage, resetPlayer, runGenesis } from '../../flows/onboarding.js';
import { patronMessage } from '../../flows/priest-turn.js';
import { runDueCities } from '../../flows/scheduler.js';
import { exportGame, importGame, type GameSave } from '../../flows/save.js';
import { isPaused, pauseWorld, resumeWorld, skipWorldDays } from '../../flows/world.js';
import { gameDate } from '../../core/time.js';
import { buildApp, loadDotEnv, ROOT } from '../app.js';
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

/** Имя сохранения → безопасное имя файла. */
function saveFile(dir: string, name: string): string {
  const clean = name.trim().replace(/[^\p{L}\p{N}_ .-]+/gu, '_').slice(0, 80);
  if (!clean) throw new Error('пустое имя сохранения');
  return path.join(dir, `${clean}.json`);
}

function listSaves(dir: string) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const save = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as GameSave;
      return { name: f.slice(0, -5), savedAt: new Date(save.savedAtMs).toISOString(), date: gameDate(save.day).label, city: save.city?.name ?? null };
    })
    .sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}

async function main(): Promise<void> {
  loadDotEnv();
  // Журнал вызовов агентов: logs/agents/<время запуска>/, у каждого вызова свой файл.
  process.env.AGENT_LOG_DIR ??= path.join(ROOT, 'logs', 'agents', new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-'));
  const inbox = new MemoryNotifier();
  const app = await buildApp(process.env, inbox);
  const { deps, locks } = app;
  const savesDir = path.resolve(process.env.SAVES_DIR ?? path.join(ROOT, 'saves'));

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
          paused: isPaused(world),
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

      if (req.method === 'POST' && url.pathname === '/api/pause') {
        const body = await readJson(req);
        const world = body.paused ? await pauseWorld(deps) : await resumeWorld(deps);
        return send(res, 200, { paused: isPaused(world) });
      }

      if (req.method === 'GET' && url.pathname === '/api/saves') return send(res, 200, listSaves(savesDir));

      if (req.method === 'POST' && url.pathname === '/api/save') {
        const body = await readJson(req);
        const file = saveFile(savesDir, String(body.name ?? ''));
        fs.mkdirSync(savesDir, { recursive: true });
        fs.writeFileSync(file, JSON.stringify(await exportGame(deps, owner), null, 2));
        return send(res, 200, { ok: true, file: path.relative(ROOT, file) });
      }

      if (req.method === 'POST' && url.pathname === '/api/load') {
        const body = await readJson(req);
        const file = saveFile(savesDir, String(body.name ?? ''));
        if (!fs.existsSync(file)) return send(res, 404, { error: 'нет такого сохранения' });
        await importGame(deps, owner, JSON.parse(fs.readFileSync(file, 'utf8')) as GameSave);
        inbox.drain(owner);
        return send(res, 200, { ok: true });
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
  server.listen(port, () => console.log(`cloudshire dev: http://localhost:${port}\nжурнал агентов: ${process.env.AGENT_LOG_DIR}`));
  setInterval(() => void runDueCities(deps, locks).catch((err) => console.error('[tick]', err)), 10_000);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
