/**
 * Трёхтактные истории (саспенс / тайна).
 * Движок прыгает по тактам, считает эскалацию и выбирает узлы тайны; рассказчик только пишет хронику.
 *
 * Такт 1 — экспозиция, полноценная фаза.
 * Такт 2 — кульминация после DIRECT-успеха.
 * Такт 3 в данных — ending; третья эскалация закрывает сюжет провалом.
 *
 * Саспенс: gravity не растёт; depth решает, закрывает ли крит всю историю;
 * discovery ladder продвигается ровно на одну ступень за beat.
 */

import { isThreeActPlot } from './plotlines.js';
import { pickFrontierReveal, remainingHiddenNodeIds } from './mysteryGraph.js';
import {
  autoTickPrefersDeepen,
  pickFrontierAdvance,
  applyLadderReveal,
  ladderFullyRevealed,
  formatLadderForPrompt,
  hiddenIndexForRung,
} from './suspenseGraph.js';

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

function freezeGravity(plot) {
  return plot?.storyType === 'suspense';
}

export function worsenStakes(plot, rng, cfg) {
  const acts = actsConfig(cfg);
  const before = { urgency: plot.urgency, gravity: plot.gravity };
  plot.urgency = scale(plot.urgency, acts.worsenMin, acts.worsenMax, rng);
  if (!freezeGravity(plot)) {
    plot.gravity = scale(plot.gravity, acts.worsenMin, acts.worsenMax, rng);
  }
  return { kind: 'worsen', before, after: { urgency: plot.urgency, gravity: plot.gravity } };
}

export function dampStakes(plot, rng, cfg) {
  const acts = actsConfig(cfg);
  const before = { urgency: plot.urgency, gravity: plot.gravity };
  plot.urgency = scale(plot.urgency, acts.dampMin, acts.dampMax, rng);
  if (!freezeGravity(plot)) {
    plot.gravity = scale(plot.gravity, acts.dampMin, acts.dampMax, rng);
  }
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

function suspenseDepth(plot) {
  const d = Math.round(Number(plot?.depth));
  if (d >= 1 && d <= 4) return d;
  return 1;
}

/** Текущий decideSkeleton тайны — без изменений. */
function decideMysterySkeleton({ act, auto, relation, fin }) {
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
      return { nextAct: act, pressure: 'NONE', reveal: 'partial', ending: null };
    }
    return { nextAct: act, pressure: 'ESCALATE', reveal: 'partial', ending: null };
  }
  if (fin === 'crit') {
    return { nextAct: act, pressure: 'NONE', reveal: 'full', ending: 'crit' };
  }
  if (fin === 'ok') {
    if (act === 1) {
      return { nextAct: 2, pressure: 'NONE', reveal: 'partial', ending: null };
    }
    return { nextAct: act, pressure: 'NONE', reveal: 'full', ending: 'ok' };
  }
  return { nextAct: act, pressure: 'ESCALATE', reveal: 'none', ending: null };
}

function decideSuspenseSkeleton({ act, auto, relation, fin, depth, unlocked, dynamic, unattendedBeats }) {
  if (auto) {
    const deepen = autoTickPrefersDeepen(dynamic, { closureUnlocked: unlocked, unattendedBeats });
    if (deepen) {
      return { nextAct: act, pressure: 'NONE', progress: 'DEEPEN', ending: null };
    }
    return { nextAct: act, pressure: 'ESCALATE', progress: 'SETBACK', ending: null };
  }
  if (relation === 'UNRELATED') {
    if (fin === 'crit') {
      return { nextAct: act, pressure: 'DEESCALATE', progress: 'NO_PLOT_CHANGE', ending: null };
    }
    if (fin === 'fail') {
      return { nextAct: act, pressure: 'ESCALATE', progress: 'SETBACK', ending: null };
    }
    return { nextAct: act, pressure: 'NONE', progress: 'NO_PLOT_CHANGE', ending: null };
  }
  if (relation === 'RELEVANT') {
    if (fin === 'fail') {
      return { nextAct: 2, pressure: 'ESCALATE', progress: 'SETBACK', ending: null };
    }
    if (depth <= 1 && act === 2) {
      return {
        nextAct: 2,
        pressure: fin === 'crit' ? 'DEESCALATE' : 'NONE',
        progress: 'RESOLVE',
        ending: fin === 'crit' ? 'crit' : 'ok',
      };
    }
    if (fin === 'crit') {
      return { nextAct: 2, pressure: 'DEESCALATE', progress: 'ADVANCE', ending: null };
    }
    return { nextAct: 2, pressure: 'NONE', progress: 'ADVANCE', ending: null };
  }
  if (fin === 'fail') {
    return { nextAct: act === 1 ? 2 : act, pressure: 'ESCALATE', progress: 'SETBACK', ending: null };
  }
  if (act === 1) {
    if (depth <= 1) {
      return {
        nextAct: 1,
        pressure: 'NONE',
        progress: 'RESOLVE',
        ending: fin === 'crit' ? 'crit' : 'ok',
      };
    }
    return {
      nextAct: 2,
      pressure: fin === 'crit' ? 'DEESCALATE' : 'NONE',
      progress: fin === 'crit' ? 'BREAKTHROUGH' : 'ADVANCE',
      ending: null,
    };
  }
  if (unlocked) {
    return {
      nextAct: 2,
      pressure: 'NONE',
      progress: 'RESOLVE',
      ending: fin === 'crit' ? 'crit' : 'ok',
    };
  }
  return {
    nextAct: 2,
    pressure: fin === 'crit' ? 'DEESCALATE' : 'NONE',
    progress: fin === 'crit' ? 'BREAKTHROUGH' : 'ADVANCE',
    ending: null,
  };
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
      progress: 'NO_PLOT_CHANGE',
      openedLadder: [],
      closureUnlockedBefore: Boolean(plot.closureUnlocked),
      closureUnlockedAfter: Boolean(plot.closureUnlocked),
    };
  }

  const type = plot.storyType;
  const act = Number(plot.act) === 2 ? 2 : 1;
  const auto = trigger === 'auto';
  const fin = finish === 'crit' || finish === 'fail' ? finish : 'ok';
  const rel = auto ? 'UNRELATED' : normalizeRelation(relation, { aligned });
  const depth = type === 'suspense' ? suspenseDepth(plot) : null;
  const unlockedBefore = type === 'suspense' ? (depth <= 1 ? true : Boolean(plot.closureUnlocked)) : false;

  const decided =
    type === 'mystery'
      ? decideMysterySkeleton({ act, auto, relation: rel, fin })
      : decideSuspenseSkeleton({
          act,
          auto,
          relation: rel,
          fin,
          depth,
          unlocked: unlockedBefore,
          dynamic: plot.dynamic,
          unattendedBeats: Number(plot.unattendedBeats) || 0,
        });

  let { nextAct, pressure, reveal = 'none', ending, progress = 'NO_PLOT_CHANGE' } = decided;
  let openedNodes = [];
  let openedEdges = [];
  let openedLadder = [];
  let allowedHiddenIndex = null;

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

  if (type === 'suspense' && (progress === 'ADVANCE' || progress === 'BREAKTHROUGH')) {
    const picked = pickFrontierAdvance(plot.discoveryLadder || []);
    if (picked?.rungId) {
      applyLadderReveal(plot.discoveryLadder, picked.rungId);
      openedLadder = [picked.rungId];
      allowedHiddenIndex = hiddenIndexForRung(plot.discoveryLadder, picked.rungId);
    }
    if (ladderFullyRevealed(plot.discoveryLadder || [])) {
      plot.closureUnlocked = true;
    }
  }

  if (ending === 'fail') {
    reveal = 'none';
    openedNodes = [];
    openedEdges = [];
    openedLadder = [];
    allowedHiddenIndex = null;
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
      openedLadder = [];
      allowedHiddenIndex = null;
      nextAct = act;
      plot.escalationLevel = maxEsc;
      stakesKind = 'worsen';
      if (type === 'suspense') progress = 'RESOLVE';
    } else {
      plot.escalationLevel = levelBefore + 1;
      stakesKind = 'worsen';
    }
  } else if (pressure === 'DEESCALATE') {
    plot.escalationLevel = Math.max(0, levelBefore - 1);
    stakesKind = 'damp';
  }

  if (type === 'suspense') {
    if (auto) plot.unattendedBeats = (Number(plot.unattendedBeats) || 0) + 1;
    else if (rel === 'DIRECT' || rel === 'RELEVANT') plot.unattendedBeats = 0;
  }

  const stakes = applyStakes(plot, stakesKind, rng, config);
  if (!ending) plot.act = nextAct;
  plot.ending = ending;
  plot.maxEscalations = maxEsc;
  const unlockedAfter =
    type === 'suspense' ? (depth <= 1 ? true : Boolean(plot.closureUnlocked)) : false;

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
    openedLadder,
    allowedHiddenIndex,
    progress,
    depth,
    closureUnlockedBefore: unlockedBefore,
    closureUnlockedAfter: unlockedAfter,
    escalationLevelBefore: levelBefore,
    escalationLevelAfter: Number(plot.escalationLevel) || 0,
    maxEscalations: maxEsc,
  };
}

function pressureInstructions(plot, move) {
  const change = move.pressure;
  const suspense = plot.storyType === 'suspense';
  if (change === 'ESCALATE') {
    const du = (move.stakes?.after?.urgency ?? 0) - (move.stakes?.before?.urgency ?? 0);
    const dg = (move.stakes?.after?.gravity ?? 0) - (move.stakes?.before?.gravity ?? 0);
    const lines = [
      'Если pressure.change = ESCALATE: покажи НОВОЕ конкретное изменение ситуации, из-за которого история стала срочнее и/или тяжелее.',
      'Не пиши абстрактно: «напряжение выросло», «ставки повысились», «ситуация ухудшилась». Покажи, ЧТО именно произошло.',
    ];
    if (suspense) {
      lines.push('Gravity этой истории не меняй и не объявляй более судьбоносной. Давление — в urgency и конкретном событии.');
    } else if (du > dg) {
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

function suspenseMomentumInstructions(plot, move) {
  const lines = [
    '',
    '==================================================',
    'САСПЕНС: MOMENTUM',
    '==================================================',
    'Каждый beat обязан существенно изменить состояние story: новый факт, результат действия, объект, риск, возможность, frontier или реальное ухудшение/улучшение.',
    'Не заменяй завершённое действие подготовкой к нему. «Исследовать» ≠ «подготовиться исследовать».',
    'Провал — плохое изменение состояния, а не отсутствие события.',
    'Не задерживай раскрытие — углубляй его. Не сохраняй интересное «на потом», если такт разрешил payoff.',
    `progress.mode = ${move.progress || 'NO_PLOT_CHANGE'}`,
    `depth ${move.depth ?? plot.depth ?? 1}; closure ${move.closureUnlockedBefore ? 'open' : 'locked'} → ${move.closureUnlockedAfter ? 'open' : 'locked'}`,
  ];
  if (plot.discoveryLadder?.length) {
    lines.push('discoveryLadder:');
    lines.push(formatLadderForPrompt(plot.discoveryLadder));
  }
  if (move.openedLadder?.length) {
    lines.push(`В этом месяце закрой ровно эту ступень и открой следующий вопрос: ${move.openedLadder.join(', ')}.`);
    if (Number.isInteger(move.allowedHiddenIndex) && plot.hiddenPremises?.[move.allowedHiddenIndex]) {
      lines.push(`Можно раскрыть hidden premise [${move.allowedHiddenIndex}]: ${plot.hiddenPremises[move.allowedHiddenIndex]}`);
    }
  } else if (move.progress === 'DEEPEN') {
    lines.push('DEEPEN: ситуация стала интереснее или больше, не обязательно опаснее. Новый слой настоящего. Скрытую природу целиком не выдавай.');
  } else if (move.progress === 'SETBACK') {
    lines.push('SETBACK: конкретная неудача в мире. Не «экспедиция не собралась» — они пошли и поплатились.');
  }
  if (move.trigger === 'process_finished' && move.finish && move.finish !== 'fail') {
    lines.push('Связанное дело завершилось успешно: заявленная цель реально осуществлена. Характер NPC не отменяет процесс.');
  }
  if (plot.closureGate && !move.closureUnlockedAfter) {
    lines.push(`closureGate ещё не снят: ${plot.closureGate}`);
  }
  return lines;
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
    ...pressureInstructions(plot, move),
  ];

  if (plot.storyType === 'suspense') {
    lines.push(...suspenseMomentumInstructions(plot, move));
  }

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
      lines.push('Если развязка оставила новый нерешённый узел — sequelHook одной фразой, иначе пусто. Сиквел решает движок.');
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
