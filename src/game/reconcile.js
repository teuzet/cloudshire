/**
 * Разбор нити: что стало с остальными обязательствами, когда одно разрешилось.
 *
 * Два сановника, посланные за одним преступником — один казнить, другой
 * арестовать. Состоялась казнь — арест невозможен, отменяем. Состоялся арест —
 * казнь возможна, но обстановка другая: пауза и вопрос покровителю.
 *
 * Словари вердиктов закрыты и различаются по типу: у дела есть пауза и
 * перенацеливание, у угрозы — только отмена и отсрочка.
 */

import { cancelThreat, delayThreat, findThreat, liveThreats } from './threats.js';

export const DEED_VERDICTS = ['CONTINUE', 'PAUSE', 'CANCEL', 'RETARGET'];
export const THREAT_VERDICTS = ['CONTINUE', 'CANCEL', 'DELAY'];

export const DEED_VERDICT_GUIDANCE = {
  CONTINUE: 'Дело всё ещё имеет смысл в том же виде.',
  PAUSE: 'Дело физически возможно, но обстановка изменилась настолько, что нужно спросить покровителя.',
  CANCEL: 'Дело стало невозможным: цели больше нет, предмета больше нет.',
  RETARGET: 'Дело осмысленно, но его цель нужно переписать. Проделанное не пропадает.',
};

export const THREAT_VERDICT_GUIDANCE = {
  CONTINUE: 'Беда идёт своим ходом.',
  CANCEL: 'Беда больше не может случиться — её предмет исчез.',
  DELAY: 'Беда осталась, но отодвинулась.',
};

/** Молча удаляем брошенную паузу только после этого срока. */
export const PAUSE_EXPIRY_DAYS = 60;

export function parseDeedVerdict(raw, fallback = 'CONTINUE') {
  const key = String(raw || '').trim().toUpperCase();
  return DEED_VERDICTS.includes(key) ? key : fallback;
}

export function parseThreatVerdict(raw, fallback = 'CONTINUE') {
  const key = String(raw || '').trim().toUpperCase();
  return THREAT_VERDICTS.includes(key) ? key : fallback;
}

/**
 * Что вообще есть на нити, кроме только что разрешившегося.
 * Если пусто — разбор не нужен, и вызывать модель незачем.
 */
export function reconcileScope({ plot, processes = [], resolvedId = null } = {}) {
  const deeds = (processes || []).filter(
    (p) =>
      p &&
      String(p.id) !== String(resolvedId) &&
      (p.status === 'active' || p.status == null) &&
      (p.plotIds || []).includes(plot?.id),
  );
  const threats = liveThreats(plot).filter((t) => t.id !== resolvedId);
  return { deeds, threats, needed: deeds.length + threats.length > 0 };
}

/** Применить вердикт к делу. Прогресс при `RETARGET` сохраняется. */
export function applyDeedVerdict(process, verdict, { day = 0, goal = '', reason = '', by = null } = {}) {
  const v = parseDeedVerdict(verdict);
  if (!process) return { ok: false, verdict: v };
  if (v === 'CONTINUE') return { ok: true, verdict: v };

  if (v === 'CANCEL') {
    process.status = 'cancelled';
    process.cancelledDay = Math.round(Number(day) || 0);
    process.cancelReason = String(reason || '').slice(0, 200);
    return { ok: true, verdict: v, freesOfficer: true };
  }

  if (v === 'PAUSE') {
    process.status = 'paused';
    process.pausedDay = Math.round(Number(day) || 0);
    process.pauseReason = String(reason || '').slice(0, 200);
    process.pausedBy = by || 'reconcile';
    return { ok: true, verdict: v, freesOfficer: true, needsConfirmation: true };
  }

  process.goal = String(goal || process.goal || '').slice(0, 300);
  process.retargetedDay = Math.round(Number(day) || 0);
  process.retargetReason = String(reason || '').slice(0, 200);
  return { ok: true, verdict: v };
}

/** Применить вердикт к угрозе. Снятая разбором угроза защитой не считается. */
export function applyThreatVerdict(plot, threatId, verdict, { day = 0, reason = '' } = {}) {
  const v = parseThreatVerdict(verdict);
  const threat = findThreat(plot, threatId);
  if (!threat) return { ok: false, verdict: v };
  if (v === 'CANCEL') return { ...cancelThreat(plot, threat, { day, reason }), verdict: v };
  if (v === 'DELAY') return { ...delayThreat(threat, { day }), verdict: v };
  return { ok: true, verdict: v };
}

/**
 * Пауза без ответа истлевает. Наказ на сопряжение — исключение:
 * о такой паузе доложено, и она ждёт освобождения столпа, а не забыта.
 */
export function expirePauses(processes = [], day = 0) {
  const dropped = [];
  for (const p of processes) {
    if (!p || p.status !== 'paused') continue;
    if (p.pausedBy === 'order') continue;
    const since = Math.round(Number(day) || 0) - Math.round(Number(p.pausedDay) || 0);
    if (since >= PAUSE_EXPIRY_DAYS) {
      p.status = 'expired';
      p.expiredDay = Math.round(Number(day) || 0);
      dropped.push(p);
    }
  }
  return dropped;
}

/** Заявка для агента разбора. Дни не отдаём — только полосы и формулировки. */
export function reconcileRequest({ plot, resolved, scope, day = 0 } = {}) {
  return {
    plotId: plot?.id || null,
    plotTitle: plot?.title || '',
    synopsis: plot?.synopsis || '',
    resolved: {
      summary: resolved?.summary || resolved?.text || '',
      kind: resolved?.kind || 'deed',
      finish: resolved?.finish || null,
    },
    deeds: (scope?.deeds || []).map((p) => ({
      id: p.id,
      summary: p.summary || '',
      goal: p.goal || '',
      officer: p.officerName || p.officerId || '',
    })),
    threats: (scope?.threats || []).map((t) => ({
      id: t.id,
      text: t.text,
      known: !!t.known,
    })),
  };
}
