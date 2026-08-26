/**
 * Трёхтактные истории (саспенс / тайна).
 * Движок прыгает по тактам, считает эскалацию и выбирает узлы тайны; рассказчик только пишет хронику.
 *
 * Такт 1 — экспозиция, полноценная фаза.
 * Такт 2 — кульминация после DIRECT-успеха.
 * Такт 3 в данных — ending; третья эскалация закрывает сюжет провалом.
 */

import { isThreeActPlot } from './plotlines.js';
import { pickFrontierReveal, remainingHiddenNodeIds } from './mysteryGraph.js';

const ENDING_TAG = {
  fail: '[ПРОВАЛ]',
  ok: '[УСПЕХ]',
  crit: '[КРИТИЧЕСКИЙ УСПЕХ]',
};

const FINISH_LABEL = {
  crit: 'КРИТИЧЕСКИЙ УСПЕХ',
  ok: 'УСПЕХ',
  fail: 'ПРОВАЛ',
};

export function actsConfig(cfg) {
  const a = cfg?.acts || {};
  return {
    maxEscalations: Math.max(1, Math.round(Number(a.maxEscalations ?? 3))),
    worsenMin: Number(a.worsenMin ?? 1),
    worsenMax: Number(a.worsenMax ?? 1.5),
    dampMin: Number(a.dampMin ?? 0.8),
    dampMax: Number(a.dampMax ?? 1),
  };
}

function clampStakes(n) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(100, v));
}

function scale(value, lo, hi, rng) {
  const span = Math.max(0, hi - lo);
  const f = lo + rng() * span;
  return clampStakes(value * f);
}

export function worsenStakes(plot, rng, cfg) {
  const acts = actsConfig(cfg);
  const before = { urgency: plot.urgency, gravity: plot.gravity };
  plot.urgency = scale(plot.urgency, acts.worsenMin, acts.worsenMax, rng);
  plot.gravity = scale(plot.gravity, acts.worsenMin, acts.worsenMax, rng);
  return { kind: 'worsen', before, after: { urgency: plot.urgency, gravity: plot.gravity } };
}

export function dampStakes(plot, rng, cfg) {
  const acts = actsConfig(cfg);
  const before = { urgency: plot.urgency, gravity: plot.gravity };
  plot.urgency = scale(plot.urgency, acts.dampMin, acts.dampMax, rng);
  plot.gravity = scale(plot.gravity, acts.dampMin, acts.dampMax, rng);
  return { kind: 'damp', before, after: { urgency: plot.urgency, gravity: plot.gravity } };
}

export function normalizeRelation(raw, { aligned } = {}) {
  const s = String(raw || '').toUpperCase();
  if (s === 'DIRECT' || s === 'RELEVANT' || s === 'UNRELATED') return s;
  if (aligned === true) return 'DIRECT';
  if (aligned === false) return 'UNRELATED';
  return 'UNRELATED';
}

export function escalationWouldFail(plot, cfg) {
  const max = actsConfig(cfg).maxEscalations;
  return Number(plot.escalationLevel) + 1 >= max;
}

function applyStakes(plot, kind, rng, cfg) {
  let result;
  if (kind === 'worsen') result = worsenStakes(plot, rng, cfg);
  else if (kind === 'damp') result = dampStakes(plot, rng, cfg);
  else {
    result = {
      kind: 'none',
      before: { urgency: plot.urgency, gravity: plot.gravity },
      after: { urgency: plot.urgency, gravity: plot.gravity },
    };
  }
  plot.importance = Math.min(100, Number(plot.gravity) || 0);
  return result;
}

function decideSkeleton({ type, act, auto, relation, fin }) {
  if (auto) {
    return { nextAct: act, pressure: 'ESCALATE', reveal: 'none', ending: null };
  }
  if (relation === 'UNRELATED') {
    if (fin === 'crit') return { nextAct: act, pressure: 'DEESCALATE', reveal: 'none', ending: null };
    if (fin === 'fail') return { nextAct: act, pressure: 'ESCALATE', reveal: 'none', ending: null };
    return { nextAct: act, pressure: 'NONE', reveal: 'none', ending: null };
  }
  if (relation === 'RELEVANT') {
    if (fin === 'fail') return { nextAct: act, pressure: 'ESCALATE', reveal: 'none', ending: null };
    if (fin === 'crit') {
      return { nextAct: act, pressure: 'NONE', reveal: type === 'mystery' ? 'partial' : 'none', ending: null };
    }
    return { nextAct: act, pressure: 'ESCALATE', reveal: type === 'mystery' ? 'partial' : 'none', ending: null };
  }
  if (fin === 'crit') {
    return { nextAct: act, pressure: 'NONE', reveal: type === 'mystery' ? 'full' : 'none', ending: 'crit' };
  }
  if (fin === 'ok') {
    if (act === 1) {
      return { nextAct: 2, pressure: 'NONE', reveal: type === 'mystery' ? 'partial' : 'none', ending: null };
    }
    return { nextAct: act, pressure: 'NONE', reveal: type === 'mystery' ? 'full' : 'none', ending: 'ok' };
  }
  return { nextAct: act, pressure: 'ESCALATE', reveal: 'none', ending: null };
}

function formatEdge(edge) {
  if (!edge) return null;
  if (typeof edge === 'string') return edge;
  if (edge.from && edge.to) return `${edge.from} → ${edge.to}`;
  return null;
}

/**
 * @param {'auto'|'process_finished'} trigger
 * @param {'crit'|'ok'|'fail'|null} finish
 */
export function applyStoryActMove(
  plot,
  { trigger, relation = null, aligned = false, finish = null, rng = Math.random, config = null } = {},
) {
  if (!isThreeActPlot(plot) || plot.ending) {
    return {
      ending: plot.ending || null,
      reveal: 'none',
      stakes: null,
      actFrom: plot.act || 1,
      actTo: plot.act || 1,
      relation: null,
      pressure: 'NONE',
      openedNodes: [],
      openedEdges: [],
    };
  }

  const type = plot.storyType;
  const act = Number(plot.act) === 2 ? 2 : 1;
  const auto = trigger === 'auto';
  const fin = finish === 'crit' || finish === 'fail' ? finish : 'ok';
  const rel = auto ? 'UNRELATED' : normalizeRelation(relation, { aligned });
  const decided = decideSkeleton({ type, act, auto, relation: rel, fin });

  let { nextAct, pressure, reveal, ending } = decided;
  let openedNodes = [];
  let openedEdges = [];

  if (type === 'mystery' && reveal === 'partial' && plot.truthGraph) {
    const picked = pickFrontierReveal(plot.truthGraph, rng);
    if (picked?.nodeId) {
      openedNodes = [picked.nodeId];
      const edgeLabel = formatEdge(picked.edge);
      if (edgeLabel) openedEdges = [edgeLabel];
      if (!remainingHiddenNodeIds(plot.truthGraph, openedNodes).length) {
        reveal = 'full';
        ending = fin === 'crit' ? 'crit' : 'ok';
        nextAct = act;
        pressure = 'NONE';
      }
    }
  }

  if (ending === 'fail') {
    reveal = 'none';
    openedNodes = [];
    openedEdges = [];
  }

  const levelBefore = Math.max(0, Number(plot.escalationLevel) || 0);
  const maxEsc = actsConfig(config).maxEscalations;
  let stakesKind = 'none';
  if (pressure === 'ESCALATE') {
    if (escalationWouldFail(plot, config)) {
      ending = 'fail';
      reveal = type === 'mystery' ? 'none' : reveal;
      openedNodes = [];
      openedEdges = [];
      nextAct = act;
      plot.escalationLevel = maxEsc;
      stakesKind = 'worsen';
    } else {
      plot.escalationLevel = levelBefore + 1;
      stakesKind = 'worsen';
    }
  } else if (pressure === 'DEESCALATE') {
    plot.escalationLevel = Math.max(0, levelBefore - 1);
    stakesKind = 'damp';
  }

  const stakes = applyStakes(plot, stakesKind, rng, config);
  if (!ending) plot.act = nextAct;
  plot.ending = ending;
  plot.maxEscalations = maxEsc;

  return {
    ending,
    reveal,
    stakes,
    actFrom: act,
    actTo: ending ? 3 : plot.act,
    relation: auto ? null : rel,
    pressure: ending === 'fail' && pressure === 'ESCALATE' ? 'ESCALATE' : pressure,
    trigger,
    finish: auto ? null : fin,
    openedNodes,
    openedEdges,
    escalationLevelBefore: levelBefore,
    escalationLevelAfter: Number(plot.escalationLevel) || 0,
    maxEscalations: maxEsc,
  };
}

function pressureInstructions(move) {
  const change = move.pressure;
  if (change === 'ESCALATE') {
    const du = (move.stakes?.after?.urgency ?? 0) - (move.stakes?.before?.urgency ?? 0);
    const dg = (move.stakes?.after?.gravity ?? 0) - (move.stakes?.before?.gravity ?? 0);
    const lines = [
      'Если pressure.change = ESCALATE: покажи НОВОЕ конкретное изменение ситуации, из-за которого история стала срочнее и/или тяжелее.',
      'Не пиши абстрактно: «напряжение выросло», «ставки повысились», «ситуация ухудшилась». Покажи, ЧТО именно произошло.',
    ];
    if (du > dg) {
      lines.push('Urgency выросла сильнее gravity: в первую очередь объясни, почему стало меньше времени или проблема стала быстрее развиваться.');
    } else if (dg > du) {
      lines.push('Gravity выросла сильнее urgency: в первую очередь объясни, почему возможные последствия стали тяжелее или затронули больше важного.');
    }
    return lines;
  }
  if (change === 'DEESCALATE') {
    return [
      'Если pressure.change = DEESCALATE: конфликт НЕ решён.',
      'Покажи конкретное текущее изменение, которое выиграло время, уменьшило текущий риск, ограничило распространение, временно стабилизировало ситуацию или снизило возможный ущерб.',
      'Не превращай деэскалацию в победу или закрытие plot.',
    ];
  }
  return ['Если pressure.change = NONE: не добавляй отдельное повышение или снижение ставок.'];
}

export function formatActMoveForPrompt(plot, move) {
  if (!move) return '';
  const type = plot.storyType === 'mystery' ? 'тайна' : 'саспенс';
  const endingLabel = move.ending ? ENDING_TAG[move.ending] || ENDING_TAG.ok : 'нет';
  const triggerKind = move.trigger === 'auto' ? 'auto' : 'process';
  const relation = move.relation || '—';
  const outcome = move.finish ? FINISH_LABEL[move.finish] || move.finish : '—';
  const opened = (move.openedNodes || []).join(', ') || '—';
  const edges = (move.openedEdges || []).join(', ') || '—';
  const u0 = move.stakes?.before?.urgency ?? plot.urgency;
  const u1 = move.stakes?.after?.urgency ?? plot.urgency;
  const g0 = move.stakes?.before?.gravity ?? plot.gravity;
  const g1 = move.stakes?.after?.gravity ?? plot.gravity;
  const level0 = move.escalationLevelBefore ?? plot.escalationLevel ?? 0;
  const level1 = move.escalationLevelAfter ?? plot.escalationLevel ?? 0;
  const maxEsc = move.maxEscalations ?? plot.maxEscalations ?? 3;

  const lines = [
    '==================================================',
    'ТАКТОВКА И ДАВЛЕНИЕ',
    '==================================================',
    'Движок уже решил. Эти решения не меняй.',
    `тип: ${type}`,
    `фаза: ${move.actFrom} → ${move.actTo}`,
    `trigger: ${triggerKind} / ${relation} / ${outcome}`,
    `revelation: ${move.reveal || 'none'}; узлы: ${opened}; рёбра: ${edges}`,
    `pressure: ${move.pressure || 'NONE'}; escalation ${level0} → ${level1} / ${maxEsc}`,
    `urgency ${u0} → ${u1}; gravity ${g0} → ${g1}`,
    `ending: ${endingLabel}`,
    '',
    'Напиши конкретное событие текущего месяца, которое правдоподобно реализует уже принятое решение движка.',
    ...pressureInstructions(move),
  ];

  if (plot.storyType === 'mystery') {
    if (move.reveal === 'none') {
      lines.push('Не раскрывай новую информацию: revelation.mode = none. Скрытые узлы в хронику не пиши.');
    } else if (move.reveal === 'full') {
      lines.push(
        'Разгадка: открой оставшиеся скрытые узлы и связи графа. Канон — в системном блоке; раньше из хроники его не было.',
      );
    } else {
      lines.push(
        'Покажи, как город в этом месяце узнал ИМЕННО открытые узлы. Соседние скрытые узлы «за компанию» не открывай.',
      );
    }
    if (move.pressure === 'ESCALATE' && !move.ending) {
      lines.push(
        '',
        '==================================================',
        'ЭСКАЛАЦИЯ ТАЙНЫ',
        '==================================================',
        'Истинное прошлое mystery уже полностью задано truth graph.',
        'Создай новое последствие В ТЕКУЩЕМ МЕСЯЦЕ: хуже стало существующее, персонаж отреагировал, след начал исчезать, окно сузилось, реакция усилилась, власти ошиблись, ущерб распространился, виновник сейчас защищает уже существующую тайну.',
        'Запрещено: новое прошлое событие, новый старый участник, новый скрытый мотив, новая причина исходной аномалии, новый механизм, новый предмет «всегда бывший частью разгадки», перепись узлов или рёбер.',
        'Проверка: то, что ты добавил, происходит ПОСЛЕ начала mystery? Если нет — это запрещённый реткон.',
        'Эскалация тайны: NEW CONSEQUENCE NOW, а не NEW CAUSE THEN.',
      );
    }
  }

  if (move.ending) {
    lines.push(`КОНЦОВКА УЖЕ РЕШЕНА ДВИЖКОМ: ${endingLabel}. Напиши развязку в этом ключе. closes не выбирай — история закрывается.`);
    if (plot.storyType === 'suspense') {
      if (move.ending === 'crit') lines.push('Конфликт решён. Город получает только плюсы.');
      else if (move.ending === 'ok') lines.push('Конфликт решён, плюсы есть, но небольшая негативная побочность обязательна.');
      else lines.push('Конфликт кончился плохо. Негативные последствия для города.');
    } else if (move.ending === 'crit') {
      lines.push('Тайна разгадана целиком, успели вовремя. Только хорошее для города.');
    } else if (move.ending === 'ok') {
      lines.push('Тайна разгадана целиком, но поздно или дорогой ценой. Негативная побочка есть, плюсы перевешивают.');
    } else {
      lines.push('Тайна не разгадана до конца — и это уже ударило по городу. Саму разгадку не выдавай.');
    }
  } else {
    lines.push('Историю этим месяцем не закрывай.');
  }
  return lines.join('\n');
}
