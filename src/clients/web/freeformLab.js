/**
 * Лаборатория freeform: изолированный слепок города, не живой домен.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import { projectRoot } from '../../config.js';
import { getLogger } from '../../log.js';
import { normalizeDomain, chronicleEntries } from '../../game/models.js';
import { normalizePlotlines, closePlotline, isFreeformPlot, stripPlotSecrets } from '../../game/plotlines.js';
import {
  advanceWorldMonths,
  appendChronicle,
  applyFreeformState,
  findFreeformPlot,
  formatFreeformChronicleSeed,
  freeformChronicles,
  normalizeFinish,
  parseFreeformGravity,
} from '../../game/freeform.js';
import { brainstormFreeformPack } from '../../game/freeformBrainstorm.js';
import { tellFreeformBeat } from '../../game/freeformTeller.js';
import { judgeFreeformRelated } from '../../game/freeformAlign.js';
import { worldDateLabel } from '../../game/tickClock.js';

const SNAPSHOT = path.join(projectRoot(), 'fixtures', 'freeform', 'snapshot.json');
const SESSION_DIR = path.join(projectRoot(), 'data-freeform');
const SESSION_FILE = path.join(SESSION_DIR, 'session.json');

function emptySession(snapshot) {
  const world = structuredClone(snapshot.world);
  const domain = normalizeDomain(structuredClone(snapshot.domain));
  normalizePlotlines(domain);
  return {
    mode: 'idle',
    plotId: null,
    world,
    domain,
    lastRejected: [],
    lastJudge: null,
    lastArchitectPrompt: '',
    lastJudgePrompt: '',
    lastRepairPrompt: '',
    lastChronicle: '',
    lastGravity: null,
    lastDrafts: [],
    lastCandidates: [],
    lastJudgeReviews: [],
    lastWarning: null,
    frozenAt: snapshot.frozenAt || null,
    cityName: snapshot.cityName || domain.name,
  };
}

async function readJson(file) {
  const raw = await fs.readFile(file, 'utf8');
  return JSON.parse(raw);
}

async function writeSession(session) {
  await fs.mkdir(SESSION_DIR, { recursive: true });
  const tmp = `${SESSION_FILE}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(session, null, 2)}\n`);
  await fs.rename(tmp, SESSION_FILE);
}

export async function loadSnapshot() {
  return readJson(SNAPSHOT);
}

export async function loadSession() {
  try {
    const session = await readJson(SESSION_FILE);
    normalizeDomain(session.domain);
    normalizePlotlines(session.domain);
    return session;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    const snapshot = await loadSnapshot();
    const session = emptySession(snapshot);
    await writeSession(session);
    return session;
  }
}

function plotOf(session) {
  const id = session.plotId;
  if (!id) return findFreeformPlot(session.domain);
  return (
    (session.domain.plotlines || []).find((p) => p.id === id) ||
    (session.domain.closedPlotlines || []).find((p) => p.id === id) ||
    null
  );
}

function labPlot(plot) {
  if (!plot) return null;
  const publicPlot = stripPlotSecrets(plot);
  return {
    ...publicPlot,
    hiddenPremises: plot.hiddenPremises || [],
    closeWhen: Array.isArray(plot.closeWhen) ? plot.closeWhen : plot.closeWhen ? [plot.closeWhen] : [],
  };
}

export function sessionPayload(session) {
  const plot = plotOf(session);
  const lore = chronicleEntries(session.domain?.lore || []).slice(-80);
  return {
    mode: session.mode,
    cityName: session.domain?.name || session.cityName,
    date: worldDateLabel(session.world),
    tick: session.world?.tickIndex ?? 0,
    frozenAt: session.frozenAt,
    plot: labPlot(plot),
    chronicles: lore.map((e) => ({
      id: e.id,
      text: e.text,
      tick: e.tick,
      gameDateLabel: e.gameDateLabel,
      author: e.author,
      relatedPlotlineIds: e.relatedPlotlineIds || [],
    })),
    plotChronicles: plot ? freeformChronicles(session.domain, plot) : [],
    lastRejected: session.lastRejected || [],
    lastJudge: session.lastJudge,
    lastArchitectPrompt: session.lastArchitectPrompt || '',
    lastJudgePrompt: session.lastJudgePrompt || '',
    lastRepairPrompt: session.lastRepairPrompt || '',
    lastChronicle: session.lastChronicle || '',
    lastGravity: session.lastGravity || null,
    lastDrafts: session.lastDrafts || [],
    lastCandidates: session.lastCandidates || [],
    lastJudgeReviews: session.lastJudgeReviews || [],
    lastWarning: session.lastWarning,
  };
}

let chain = Promise.resolve();
function serialize(fn) {
  const run = chain.then(fn, fn);
  chain = run.then(
    () => {},
    () => {},
  );
  return run;
}

export async function resetFreeformLab() {
  return serialize(async () => {
    const snapshot = await loadSnapshot();
    const session = emptySession(snapshot);
    await writeSession(session);
    return sessionPayload(session);
  });
}

export async function seedFreeformLab({ config, runtime, text, gravity, fromCity, log: parentLog }) {
  return serialize(async () => {
    const log = (parentLog || getLogger()).child({ scope: 'freeform.lab.seed' });
    const session = await loadSession();
    let seedText;
    if (fromCity) {
      seedText = formatFreeformChronicleSeed(chronicleEntries(session.domain?.lore || []).slice(-80));
      if (!seedText) {
        const err = new Error('В хронике города нет записей.');
        err.status = 400;
        throw err;
      }
    } else {
      seedText = String(text || '').trim();
      if (seedText.length < 20) {
        const err = new Error('Хроника слишком короткая.');
        err.status = 400;
        throw err;
      }
      session.lastChronicle = seedText;
    }
    const g = parseFreeformGravity(gravity);
    session.lastGravity = g;

    const drafted = await brainstormFreeformPack({
      config,
      runtime,
      seedText,
      gravity: g,
      log,
    });
    session.lastArchitectPrompt = drafted.prompt || '';
    session.lastJudgePrompt = drafted.judgePrompt || '';
    session.lastRepairPrompt = drafted.repairPrompt || '';
    if (!drafted.ok) {
      session.lastDrafts = [];
      session.lastCandidates = [];
      session.lastJudgeReviews = [];
      session.lastWarning = 'Не получилось породить затравки. Попробуй другую хронику или ещё раз.';
      await writeSession(session);
      const err = new Error(session.lastWarning);
      err.status = 502;
      err.payload = sessionPayload(session);
      throw err;
    }

    session.lastDrafts = drafted.drafts;
    session.lastCandidates = drafted.candidates;
    session.lastJudgeReviews = drafted.reviews;
    session.lastRejected = [];
    session.lastJudge = null;
    session.lastWarning = null;
    if (session.mode === 'idle' || session.mode === 'seeds') session.mode = 'seeds';
    await writeSession(session);
    log.info('freeform.lab.brainstormed', { gravity: g, count: drafted.candidates.length });
    return sessionPayload(session);
  });
}

export async function playFreeformDeed({ config, runtime, summary, detail, durationMonths, finish, log: parentLog }) {
  return serialize(async () => {
    const log = (parentLog || getLogger()).child({ scope: 'freeform.lab.deed' });
    const text = String(summary || '').trim();
    if (text.length < 8) {
      const err = new Error('Опиши дело.');
      err.status = 400;
      throw err;
    }
    const session = await loadSession();
    if (session.mode !== 'story') {
      const err = new Error(
        session.mode === 'closed' ? 'История уже закончена.' : 'Сначала породите историю затравкой.',
      );
      err.status = 409;
      throw err;
    }
    const plot = plotOf(session);
    if (!plot || !isFreeformPlot(plot)) {
      const err = new Error('Нет живой freeform-истории.');
      err.status = 409;
      throw err;
    }

    const months = Math.max(1, Math.round(Number(durationMonths) || 1));
    const outcome = normalizeFinish(finish);
    advanceWorldMonths(session.world, months);

    const related = await judgeFreeformRelated({
      runtime,
      domain: session.domain,
      plot,
      summary: text,
      detail,
      log,
    });
    if (!related.related) {
      appendChronicle(session.domain, session.world, {
        text: `Поручение в сторону: ${text}. К истории «${plot.title}» это не относится.`,
        author: 'lab:errand',
        importance: 'minor',
      });
      session.lastWarning =
        'Дело UNRELATED — история не сдвинулась. В живой игре жрец предупредил бы и завёл отдельное поручение.';
      session.lastRejected = [];
      session.lastJudge = { why: related.why || 'UNRELATED', repair: '', issues: [] };
      await writeSession(session);
      return sessionPayload(session);
    }

    session.lastWarning = null;
    const told = await tellFreeformBeat({
      config,
      runtime,
      domain: session.domain,
      world: session.world,
      plot,
      deed: { summary: text, detail: detail || '', durationMonths: months, finish: outcome },
      log,
    });
    if (!told.ok) {
      session.lastWarning = 'Не получилось продолжить историю. Попробуй другую формулировку дела.';
      await writeSession(session);
      const err = new Error(session.lastWarning);
      err.status = 502;
      err.payload = sessionPayload(session);
      throw err;
    }

    applyFreeformState(plot, told.winner);
    appendChronicle(session.domain, session.world, {
      text: told.winner.chronicle,
      plotId: plot.id,
      author: 'freeform:beat',
    });
    session.lastRejected = told.rejected;
    session.lastJudge = told.judge;

    if (told.winner.closed) {
      closePlotline(session.domain, plot.id, {
        tick: session.world.tickIndex,
        reason: told.winner.closedBy || 'resolved',
      });
      session.mode = 'closed';
    }

    await writeSession(session);
    log.info('freeform.lab.beat', { plotId: plot.id, closed: Boolean(told.winner.closed) });
    return sessionPayload(session);
  });
}

function sendLabError(res, err) {
  const status = err.status || 500;
  const body = { error: err.message };
  if (err.payload) body.state = err.payload;
  res.status(status).json(body);
}

export function mountFreeformLab(server, { config, runtime }) {
  const staticDir = path.join(projectRoot(), 'public', 'freeform');
  const sendLab = (_req, res) => res.sendFile(path.join(staticDir, 'index.html'));
  server.get('/freeform', sendLab);
  server.get('/freeform/', sendLab);
  server.use('/freeform', express.static(staticDir, { redirect: false, index: false }));

  server.get('/api/freeform/state', async (req, res) => {
    try {
      const session = await loadSession();
      res.json(sessionPayload(session));
    } catch (err) {
      req.log?.error('freeform.state', { error: err.message });
      sendLabError(res, err);
    }
  });

  server.post('/api/freeform/reset', async (req, res) => {
    try {
      res.json(await resetFreeformLab());
    } catch (err) {
      req.log?.error('freeform.reset', { error: err.message });
      sendLabError(res, err);
    }
  });

  server.post('/api/freeform/seed', async (req, res) => {
    try {
      res.json(
        await seedFreeformLab({
          config,
          runtime,
          text: req.body?.text,
          gravity: req.body?.gravity,
          fromCity: Boolean(req.body?.fromCity),
          log: req.log,
        }),
      );
    } catch (err) {
      req.log?.error('freeform.seed', { error: err.message });
      sendLabError(res, err);
    }
  });

  server.post('/api/freeform/deed', async (req, res) => {
    try {
      res.json(
        await playFreeformDeed({
          config,
          runtime,
          summary: req.body?.summary,
          detail: req.body?.detail,
          durationMonths: req.body?.durationMonths,
          finish: req.body?.finish,
          log: req.log,
        }),
      );
    } catch (err) {
      req.log?.error('freeform.deed', { error: err.message });
      sendLabError(res, err);
    }
  });
}
