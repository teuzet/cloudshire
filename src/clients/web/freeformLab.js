/**
 * Лаборатория freeform: изолированный слепок города, не живой домен.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import { projectRoot } from '../../config.js';
import { getLogger } from '../../log.js';
import { normalizeDomain, chronicleEntries } from '../../game/models.js';
import { normalizePlotlines, closePlotline, isStakedStory, stripPlotSecrets } from '../../game/plotlines.js';
import {
  advanceWorldMonths,
  appendChronicle,
  applyFreeformState,
  createFreeformPlot,
  findFreeformPlot,
  formatFreeformChronicleSeed,
  freeformChronicles,
  normalizeFinish,
  parseFreeformGravity,
} from '../../game/freeform.js';
import { brainstormFreeformPack } from '../../game/freeformBrainstorm.js';
import { assembleFreeformLabStory } from '../../game/freeformAssemble.js';
import { tellFreeformBeat } from '../../game/freeformTeller.js';
import { judgeFreeformRelated, parseFreeformRelation } from '../../game/freeformAlign.js';
import { refreshFreeformEndings } from '../../game/freeformEndings.js';
import { setFreeformUrgency } from '../../game/freeformUrgency.js';
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
    lastFinalJudgePrompt: '',
    lastAssemblePrompt: '',
    lastEndingsPrompt: '',
    lastUrgencyPrompt: '',
    lastAlignPrompt: '',
    lastAlignRelation: null,
    lastAlignEndingId: null,
    lastBeatArchitectPrompt: '',
    lastBeatJudgePrompt: '',
    lastBeatRepairPrompt: '',
    lastBeatFinalJudgePrompt: '',
    lastBeatTellPrompt: '',
    lastBeatVariants: [],
    lastBeatPickedIndex: null,
    lastMoveKind: null,
    lastChronicle: '',
    lastGravity: null,
    lastDrafts: [],
    lastCandidates: [],
    lastJudgeReviews: [],
    lastFinalReviews: [],
    lastPickedIndex: null,
    lastWarning: null,
    undoStack: [],
    frozenAt: snapshot.frozenAt || null,
    cityName: snapshot.cityName || domain.name,
  };
}

const UNDO_LIMIT = 8;

export function snapshotForUndo(session) {
  const { undoStack: _stack, ...rest } = session;
  return structuredClone(rest);
}

export function pushUndo(session, previous) {
  const stack = Array.isArray(session.undoStack) ? session.undoStack : [];
  session.undoStack = [...stack, previous].slice(-UNDO_LIMIT);
  return session;
}

export function popUndo(session) {
  const stack = Array.isArray(session.undoStack) ? [...session.undoStack] : [];
  if (!stack.length) return null;
  const prev = stack.pop();
  prev.undoStack = stack;
  return prev;
}

function beatVariantsPayload(told) {
  return (told?.variants || []).map((v, i) => {
    const index = i + 1;
    const picked = index === Number(told.pickedIndex);
    return {
      index,
      title: v.title || v.dynamicName || '',
      text: v.text || v.whatHappens || '',
      dynamicId: v.dynamicId || '',
      dynamicName: v.dynamicName || v.dynamics || '',
      dynamicHint: v.dynamicHint || '',
      endingId: v.endingId || '',
      endingText: v.endingText || '',
      endingKind: v.endingKind || '',
      picked,
      chronicle: picked ? told.winner?.chronicle || '' : '',
    };
  });
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
    endings: Array.isArray(plot.endings) ? plot.endings : [],
    urgency: plot.urgency || null,
    countdown: plot.countdown ?? null,
    depth: plot.depth ?? 0,
    maxDepth: plot.maxDepth ?? null,
    failCount: plot.failCount ?? 0,
    maxFails: plot.maxFails ?? null,
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
    lastFinalJudgePrompt: session.lastFinalJudgePrompt || '',
    lastAssemblePrompt: session.lastAssemblePrompt || '',
    lastEndingsPrompt: session.lastEndingsPrompt || '',
    lastUrgencyPrompt: session.lastUrgencyPrompt || '',
    lastAlignPrompt: session.lastAlignPrompt || '',
    lastAlignRelation: session.lastAlignRelation || null,
    lastAlignEndingId: session.lastAlignEndingId || null,
    lastBeatArchitectPrompt: session.lastBeatArchitectPrompt || '',
    lastBeatJudgePrompt: session.lastBeatJudgePrompt || '',
    lastBeatRepairPrompt: session.lastBeatRepairPrompt || '',
    lastBeatFinalJudgePrompt: session.lastBeatFinalJudgePrompt || '',
    lastBeatTellPrompt: session.lastBeatTellPrompt || '',
    lastBeatVariants: session.lastBeatVariants || [],
    lastBeatPickedIndex: session.lastBeatPickedIndex ?? null,
    lastMoveKind: session.lastMoveKind || null,
    lastChronicle: session.lastChronicle || '',
    lastGravity: session.lastGravity || null,
    lastDrafts: session.lastDrafts || [],
    lastCandidates: session.lastCandidates || [],
    lastJudgeReviews: session.lastJudgeReviews || [],
    lastFinalReviews: session.lastFinalReviews || [],
    lastPickedIndex: session.lastPickedIndex ?? null,
    lastWarning: session.lastWarning,
    canUndo: Array.isArray(session.undoStack) && session.undoStack.length > 0,
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
    const previous = snapshotForUndo(session);
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
    session.lastFinalJudgePrompt = drafted.finalJudgePrompt || '';
    session.lastDrafts = drafted.drafts || [];
    session.lastCandidates = drafted.candidates || [];
    session.lastJudgeReviews = drafted.reviews || [];
    session.lastFinalReviews = drafted.finalReviews || [];
    session.lastPickedIndex = drafted.pickedIndex ?? null;
    session.lastRejected = [];
    session.lastJudge = null;
    session.lastAssemblePrompt = '';
    session.lastEndingsPrompt = '';
    session.lastUrgencyPrompt = '';
    session.lastAlignPrompt = '';
    session.lastAlignRelation = null;
    session.lastAlignEndingId = null;
    session.lastBeatArchitectPrompt = '';
    session.lastBeatJudgePrompt = '';
    session.lastBeatRepairPrompt = '';
    session.lastBeatFinalJudgePrompt = '';
    session.lastBeatTellPrompt = '';
    session.lastBeatVariants = [];
    session.lastBeatPickedIndex = null;
    session.lastMoveKind = null;

    if (!drafted.candidates?.length) {
      session.lastWarning = 'Не получилось породить затравки. Попробуй другую хронику или ещё раз.';
      if (session.mode === 'idle') session.mode = 'seeds';
      pushUndo(session, previous);
      await writeSession(session);
      const err = new Error(session.lastWarning);
      err.status = 502;
      err.payload = sessionPayload(session);
      throw err;
    }

    if (!drafted.winner) {
      session.mode = 'seeds';
      session.lastWarning = 'Судья не пропустил ни одну хронику. Попробуй другую затравку или ещё раз.';
      pushUndo(session, previous);
      await writeSession(session);
      log.info('freeform.lab.brainstormed.no_pass', { gravity: g, count: drafted.candidates.length });
      return sessionPayload(session);
    }

    session.domain.plotlines = (session.domain.plotlines || []).filter((p) => !isStakedStory(p));
    session.plotId = null;

    const assembled = await assembleFreeformLabStory({
      config,
      runtime,
      domain: session.domain,
      world: session.world,
      candidate: drafted.winner,
      gravity: g,
      log,
    });
    session.lastAssemblePrompt = assembled.assemblePrompt || '';
    session.lastEndingsPrompt = '';
    session.lastUrgencyPrompt = '';

    const plot = createFreeformPlot({
      domain: session.domain,
      world: session.world,
      variant: assembled,
      config,
    });
    appendChronicle(session.domain, session.world, {
      text: assembled.chronicle,
      plotId: plot.id,
      author: 'freeform:seed',
    });
    const ended = await refreshFreeformEndings({
      runtime,
      domain: session.domain,
      plot,
      log,
    });
    const urgent = await setFreeformUrgency({
      runtime,
      domain: session.domain,
      plot,
      log,
    });
    session.lastEndingsPrompt = ended.prompt || '';
    session.lastUrgencyPrompt = urgent.prompt || '';
    session.plotId = plot.id;
    session.mode = 'story';
    session.lastWarning = null;
    pushUndo(session, previous);
    await writeSession(session);
    log.info('freeform.lab.assembled', {
      gravity: g,
      plotId: plot.id,
      pickedIndex: drafted.pickedIndex,
      countdown: plot.countdown,
    });
    return sessionPayload(session);
  });
}

export async function playFreeformDeed({
  config,
  runtime,
  summary,
  detail,
  durationMonths,
  finish,
  relation: relationRaw = '',
  endingId: endingIdRaw = '',
  log: parentLog,
}) {
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
    if (!plot || !isStakedStory(plot)) {
      const err = new Error('Нет живой freeform-истории.');
      err.status = 409;
      throw err;
    }

    const months = Math.max(1, Math.round(Number(durationMonths) || 1));
    const outcome = normalizeFinish(finish);
    const previous = snapshotForUndo(session);
    advanceWorldMonths(session.world, months);

    const overrideRelation = parseFreeformRelation(relationRaw);
    let related;
    if (overrideRelation) {
      related = {
        related: overrideRelation !== 'UNRELATED',
        relation: overrideRelation,
        endingId: overrideRelation === 'DIRECT' ? String(endingIdRaw || '').trim() : '',
        why: 'лаборатория: связь задана вручную',
        prompt: '',
      };
    } else {
      related = await judgeFreeformRelated({
        runtime,
        domain: session.domain,
        plot,
        summary: text,
        detail,
        log,
      });
    }
    session.lastAlignPrompt = related.prompt || '';
    session.lastAlignRelation = related.relation || null;
    session.lastAlignEndingId = related.endingId || null;
    session.lastBeatArchitectPrompt = '';
    session.lastBeatJudgePrompt = '';
    session.lastBeatRepairPrompt = '';
    session.lastBeatFinalJudgePrompt = '';
    session.lastBeatTellPrompt = '';
    session.lastEndingsPrompt = '';
    session.lastUrgencyPrompt = '';
    session.lastBeatVariants = [];
    session.lastBeatPickedIndex = null;
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
      session.lastMoveKind = 'unrelated';
      pushUndo(session, previous);
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
      trigger: 'deed',
      relation: related.relation,
      endingId: related.endingId,
      log,
    });
    if (!told.ok) {
      session.lastBeatArchitectPrompt = told.architectPrompt || '';
      session.lastBeatJudgePrompt = told.judgePrompt || '';
      session.lastBeatRepairPrompt = told.repairPrompt || '';
      session.lastBeatFinalJudgePrompt = told.finalJudgePrompt || '';
      session.lastBeatTellPrompt = told.tellPrompt || '';
      session.lastWarning = 'Не получилось продолжить историю. Попробуй другую формулировку дела.';
      session.lastMoveKind = 'deed';
      pushUndo(session, previous);
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
    session.lastBeatArchitectPrompt = told.architectPrompt || '';
    session.lastBeatJudgePrompt = told.judgePrompt || '';
    session.lastBeatRepairPrompt = told.repairPrompt || '';
    session.lastBeatFinalJudgePrompt = told.finalJudgePrompt || '';
    session.lastBeatTellPrompt = told.tellPrompt || '';
    session.lastEndingsPrompt = told.endingsPrompt || '';
    session.lastUrgencyPrompt = told.urgencyPrompt || '';
    session.lastBeatVariants = beatVariantsPayload(told);
    session.lastBeatPickedIndex = told.pickedIndex ?? null;
    session.lastMoveKind = 'deed';

    if (told.winner.closed) {
      closePlotline(session.domain, plot.id, {
        tick: session.world.tickIndex,
        reason: told.winner.closedBy || 'resolved',
      });
      session.mode = 'closed';
    }

    pushUndo(session, previous);
    await writeSession(session);
    log.info('freeform.lab.beat', {
      plotId: plot.id,
      closed: Boolean(told.winner.closed),
      relation: related.relation,
      decision: told.decision?.kind,
    });
    return sessionPayload(session);
  });
}

export async function playFreeformAutotick({ config, runtime, log: parentLog }) {
  return serialize(async () => {
    const log = (parentLog || getLogger()).child({ scope: 'freeform.lab.autotick' });
    const session = await loadSession();
    if (session.mode !== 'story') {
      const err = new Error(
        session.mode === 'closed' ? 'История уже закончена.' : 'Сначала породите историю затравкой.',
      );
      err.status = 409;
      throw err;
    }
    const plot = plotOf(session);
    if (!plot || !isStakedStory(plot)) {
      const err = new Error('Нет живой freeform-истории.');
      err.status = 409;
      throw err;
    }

    const previous = snapshotForUndo(session);
    advanceWorldMonths(session.world, 1);
    session.lastAlignPrompt = '';
    session.lastAlignRelation = 'RELATED';
    session.lastAlignEndingId = null;
    session.lastWarning = null;

    const told = await tellFreeformBeat({
      config,
      runtime,
      domain: session.domain,
      world: session.world,
      plot,
      deed: null,
      trigger: 'auto',
      relation: 'RELATED',
      log,
    });
    if (!told.ok) {
      session.lastBeatArchitectPrompt = told.architectPrompt || '';
      session.lastBeatJudgePrompt = told.judgePrompt || '';
      session.lastBeatRepairPrompt = told.repairPrompt || '';
      session.lastBeatFinalJudgePrompt = told.finalJudgePrompt || '';
      session.lastBeatTellPrompt = told.tellPrompt || '';
      session.lastBeatVariants = [];
      session.lastBeatPickedIndex = null;
      session.lastMoveKind = 'auto';
      session.lastWarning = 'Не получилось сделать автотик. Попробуй ещё раз.';
      pushUndo(session, previous);
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
      author: 'freeform:auto',
    });
    session.lastRejected = told.rejected;
    session.lastJudge = told.judge;
    session.lastBeatArchitectPrompt = told.architectPrompt || '';
    session.lastBeatJudgePrompt = told.judgePrompt || '';
    session.lastBeatRepairPrompt = told.repairPrompt || '';
    session.lastBeatFinalJudgePrompt = told.finalJudgePrompt || '';
    session.lastBeatTellPrompt = told.tellPrompt || '';
    session.lastEndingsPrompt = told.endingsPrompt || '';
    session.lastUrgencyPrompt = told.urgencyPrompt || '';
    session.lastBeatVariants = beatVariantsPayload(told);
    session.lastBeatPickedIndex = told.pickedIndex ?? null;
    session.lastMoveKind = 'auto';

    if (told.winner.closed) {
      closePlotline(session.domain, plot.id, {
        tick: session.world.tickIndex,
        reason: told.winner.closedBy || 'resolved',
      });
      session.mode = 'closed';
    }

    pushUndo(session, previous);
    await writeSession(session);
    log.info('freeform.lab.autotick', { plotId: plot.id, closed: Boolean(told.winner.closed) });
    return sessionPayload(session);
  });
}

export async function undoFreeformLab() {
  return serialize(async () => {
    const session = await loadSession();
    const prev = popUndo(session);
    if (!prev) {
      const err = new Error('Нечего откатывать.');
      err.status = 409;
      throw err;
    }
    await writeSession(prev);
    return sessionPayload(prev);
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
          relation: req.body?.relation,
          endingId: req.body?.endingId,
          log: req.log,
        }),
      );
    } catch (err) {
      req.log?.error('freeform.deed', { error: err.message });
      sendLabError(res, err);
    }
  });

  server.post('/api/freeform/autotick', async (req, res) => {
    try {
      res.json(await playFreeformAutotick({ config, runtime, log: req.log }));
    } catch (err) {
      req.log?.error('freeform.autotick', { error: err.message });
      sendLabError(res, err);
    }
  });

  server.post('/api/freeform/undo', async (req, res) => {
    try {
      res.json(await undoFreeformLab());
    } catch (err) {
      req.log?.error('freeform.undo', { error: err.message });
      sendLabError(res, err);
    }
  });
}
