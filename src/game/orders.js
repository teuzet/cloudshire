/**
 * Постоянные порядки: заявка правителя, каденс нити, выбор «история или хроника».
 * Карточку пишет агент порядка; тик — агент-рассказчик указа. См. docs/STANDING_ORDERS.md.
 */

import { newId } from './ids.js';
import { textsLookSame } from './processes.js';
import {
  countOpen,
  liveStoryImportance,
  plotConfig,
  findPlotline,
  closePlotline,
} from './plotlines.js';

export function normalizeOrders(domain) {
  if (!domain || typeof domain !== 'object') return domain;
  if (!domain.state || typeof domain.state !== 'object') domain.state = {};
  if (!Array.isArray(domain.state.modifiers)) domain.state.modifiers = [];
  if (!Array.isArray(domain.state.pendingOrderRequests)) domain.state.pendingOrderRequests = [];

  for (const plot of domain.plotlines || []) {
    if (plot?.kind !== 'order' || !plot.modifierId) continue;
    const mod = domain.state.modifiers.find((m) => m && m.id === plot.modifierId);
    if (mod && !mod.plotlineId) mod.plotlineId = plot.id;
  }

  for (const mod of domain.state.modifiers) {
    if (!mod?.id) continue;
    if (mod.plotlineId && findPlotline(domain, mod.plotlineId)) continue;
    const linked = (domain.plotlines || []).find(
      (p) => p.kind === 'order' && p.modifierId === mod.id,
    );
    if (linked) {
      mod.plotlineId = linked.id;
      continue;
    }
    const already = domain.state.pendingOrderRequests.some(
      (r) => r.orderId === mod.id || (r.action === 'adopt' && r.orderId === mod.id),
    );
    if (already) continue;
    domain.state.pendingOrderRequests.push({
      id: newId('ordreq'),
      action: 'adopt',
      text: String(mod.text || '').trim(),
      orderId: mod.id,
      by: mod.by || null,
      initiative: mod.initiative || 'patron',
      requestedTick: Number.isInteger(mod.declaredTick) ? mod.declaredTick : null,
      reason: '',
    });
  }
  return domain;
}

export function findStandingOrder(domain, key) {
  const list = domain?.state?.modifiers || [];
  const k = String(key || '').trim().toLowerCase();
  if (!k) return null;
  return (
    list.find((m) => String(m.id).toLowerCase() === k) ||
    list.find((m) => String(m.text || '').toLowerCase().includes(k.slice(0, 40))) ||
    null
  );
}

export function listStandingOrders(domain) {
  const pending = domain?.state?.pendingOrderRequests || [];
  const revokeIds = new Set(pending.filter((r) => r.action === 'revoke').map((r) => r.orderId));
  const editIds = new Set(pending.filter((r) => r.action === 'edit').map((r) => r.orderId));
  const mods = (domain?.state?.modifiers || []).map((m) => ({
    id: m.id,
    text: m.text,
    pending: revokeIds.has(m.id) ? 'revoke' : editIds.has(m.id) ? 'edit' : false,
    plotlineId: m.plotlineId || null,
    kind: m.kind || 'order',
    since: m.since || null,
    initiative: m.initiative || 'patron',
  }));
  const creating = pending
    .filter((r) => r.action === 'create')
    .map((r) => ({
      id: r.id,
      text: r.text,
      pending: 'create',
      action: 'create',
      kind: 'order',
      since: null,
      initiative: r.initiative || 'patron',
    }));
  return [...mods, ...creating];
}

function replacePendingForOrder(pending, orderId, next) {
  const id = String(orderId || '');
  const kept = pending.filter((r) => String(r.orderId || '') !== id);
  if (next) kept.push(next);
  return kept;
}

export function queueOrderRequest(
  domain,
  {
    action,
    text = '',
    orderId = null,
    by = null,
    initiative = 'patron',
    reason = '',
    tick = null,
  } = {},
) {
  normalizeOrders(domain);
  const pending = domain.state.pendingOrderRequests;
  const body = String(text || '').trim().slice(0, 400);
  const kind = String(action || '');

  if (kind === 'create') {
    if (body.length < 3) return { error: 'too_short', message: 'Слишком короткое правило.' };
    const existingMod =
      findStandingOrder(domain, orderId) ||
      (domain.state.modifiers || []).find((m) => textsLookSame(m.text, body));
    if (existingMod) {
      return queueOrderRequest(domain, {
        action: 'edit',
        text: body,
        orderId: existingMod.id,
        by,
        initiative,
        tick,
      });
    }
    const dupReq = pending.find((r) => r.action === 'create' && textsLookSame(r.text, body));
    if (dupReq) {
      dupReq.text = body;
      dupReq.by = by;
      dupReq.initiative = initiative;
      dupReq.requestedTick = tick;
      return { request: dupReq, created: false };
    }
    const request = {
      id: newId('ordreq'),
      action: 'create',
      text: body,
      orderId: null,
      by,
      initiative,
      requestedTick: tick,
      reason: '',
    };
    pending.push(request);
    return { request, created: true };
  }

  if (kind === 'edit') {
    if (body.length < 3) return { error: 'too_short', message: 'Слишком короткое правило.' };
    const createReq = pending.find(
      (r) =>
        r.action === 'create' &&
        (r.id === orderId || textsLookSame(r.text, body) || String(r.id) === String(orderId)),
    );
    if (createReq && !findStandingOrder(domain, createReq.orderId || orderId)) {
      createReq.text = body;
      createReq.by = by;
      createReq.initiative = initiative;
      createReq.requestedTick = tick;
      return { request: createReq, created: false };
    }
    const mod = findStandingOrder(domain, orderId) || findStandingOrder(domain, body);
    if (!mod) return { error: 'order_not_found', message: 'Такого порядка нет.' };
    const request = {
      id: newId('ordreq'),
      action: 'edit',
      text: body,
      orderId: mod.id,
      by,
      initiative,
      requestedTick: tick,
      reason: '',
    };
    domain.state.pendingOrderRequests = replacePendingForOrder(pending, mod.id, request);
    return { request, created: false };
  }

  if (kind === 'revoke') {
    const createIdx = pending.findIndex(
      (r) =>
        r.action === 'create' &&
        (r.id === orderId ||
          String(r.id).toLowerCase() === String(orderId || '').toLowerCase() ||
          (body && textsLookSame(r.text, body)) ||
          (orderId && String(r.text || '').toLowerCase().includes(String(orderId).toLowerCase().slice(0, 40)))),
    );
    if (createIdx >= 0) {
      const [cancelled] = pending.splice(createIdx, 1);
      return { request: cancelled, cancelled: true };
    }
    const mod = findStandingOrder(domain, orderId) || (body ? findStandingOrder(domain, body) : null);
    if (!mod) return { error: 'order_not_found', message: 'Такого порядка нет.' };
    const request = {
      id: newId('ordreq'),
      action: 'revoke',
      text: mod.text,
      orderId: mod.id,
      by,
      initiative,
      requestedTick: tick,
      reason: String(reason || '').trim(),
    };
    domain.state.pendingOrderRequests = replacePendingForOrder(pending, mod.id, request);
    return { request, created: false };
  }

  return { error: 'bad_action', message: 'action: create, edit или revoke.' };
}

export function orderWantsTick(plot, tick, rng = Math.random) {
  if (!plot || plot.kind !== 'order') return { want: false, scheduled: false };
  const due = Number.isInteger(plot.nextDueTick) && Number(tick) >= plot.nextDueTick;
  if (due) return { want: true, scheduled: true };
  const chance = Number(plot.fireChance);
  if (Number.isFinite(chance) && chance > 0 && rng() < chance) {
    return { want: true, scheduled: false };
  }
  return { want: false, scheduled: false };
}

/**
 * Пустая доска историй → история (если есть слот доски).
 * Полная → хроника. Середина — как посев мира.
 */
export function pickOrderOutcome(domain, cfg, rng = Math.random) {
  const { stories, total } = countOpen(domain);
  if (stories === 0) return total < cfg.board.maxOpen ? 'story' : 'chronicle';
  if (total >= cfg.board.maxOpen) return 'chronicle';
  const target = Math.max(1, Number(cfg.board.targetImportance) || 100);
  const sum = liveStoryImportance(domain);
  if (sum >= target) return 'chronicle';
  const missing = (target - sum) / target;
  const floor = Number(cfg.beats.baseChance ?? 0);
  const ceil = Number(cfg.board.seedMaxChance ?? 0.5);
  const chance = floor + missing * Math.max(0, ceil - floor);
  return rng() < Math.max(0, Math.min(ceil, chance)) ? 'story' : 'chronicle';
}

export function planOrderTicks({ domain, config, slotsLeft, tick, rng = Math.random }) {
  const cap = Math.max(0, Math.round(Number(slotsLeft) || 0));
  const orders = (domain.plotlines || []).filter((p) => p.kind === 'order');
  const wanted = [];
  for (const plot of orders) {
    const w = orderWantsTick(plot, tick, rng);
    if (w.want) wanted.push({ plot, scheduled: w.scheduled });
  }
  wanted.sort((a, b) => Number(b.scheduled) - Number(a.scheduled));
  const taken = wanted.slice(0, cap);
  for (const skipped of wanted.slice(cap)) {
    if (skipped.scheduled) skipped.plot.nextDueTick = Number(tick) + 1;
  }
  return taken.map((t) => ({
    plotId: t.plot.id,
    title: t.plot.title,
    scheduled: t.scheduled,
  }));
}

export function markOrderFired(plot, tick) {
  if (!plot) return;
  plot.lastBeatTick = tick;
  plot.beatCount = Math.max(0, Math.round(Number(plot.beatCount) || 0)) + 1;
  const every = Number(plot.scheduleEveryMonths);
  if (Number.isInteger(every) && every >= 1) {
    plot.nextDueTick = Number(tick) + every;
    return;
  }
  if (plot.nextDueTick != null && Number(tick) >= plot.nextDueTick) {
    plot.nextDueTick = null;
  }
}

export function unlinkOrderModifier(domain, plot) {
  const id = plot?.modifierId;
  if (!id || !domain?.state?.modifiers) return;
  domain.state.modifiers = domain.state.modifiers.filter((m) => m.id !== id);
}

export function closeOrderPair(domain, { modifierId = null, plotlineId = null, tick = null, reason = '' } = {}) {
  const mod =
    (modifierId && (domain.state?.modifiers || []).find((m) => m.id === modifierId)) ||
    (plotlineId && (domain.state?.modifiers || []).find((m) => m.plotlineId === plotlineId)) ||
    null;
  const plot =
    (plotlineId && findPlotline(domain, plotlineId)) ||
    (mod?.plotlineId && findPlotline(domain, mod.plotlineId)) ||
    (mod && (domain.plotlines || []).find((p) => p.kind === 'order' && p.modifierId === mod.id)) ||
    null;
  if (plot) closePlotline(domain, plot.id, { tick, reason: reason || 'порядок отменён' });
  if (mod && domain.state?.modifiers) {
    domain.state.modifiers = domain.state.modifiers.filter((m) => m.id !== mod.id);
  }
  return { modifier: mod, plot };
}

export function eventCap(config) {
  return plotConfig(config || {}).beats.maxPerTick;
}
