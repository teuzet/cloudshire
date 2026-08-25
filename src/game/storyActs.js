/**
 * Трёхтактные истории (саспенс / тайна).
 * Движок прыгает по тактам и меняет urgency/gravity; рассказчик только пишет хронику.
 *
 * Такт 1 — после посева (экспозиция уже в первой хронике).
 * Такт 2 — кульминация, ставки живут здесь.
 * Концовка — не отдельный такт, а закрытие с токеном дел.
 */

import { isThreeActPlot } from './plotlines.js';

const ENDING_TAG = {
  fail: '[ПРОВАЛ]',
  ok: '[УСПЕХ]',
  crit: '[КРИТИЧЕСКИЙ УСПЕХ]',
};

export function actsConfig(cfg) {
  const a = cfg?.acts || {};
  return {
    failMultiplier: Math.max(1, Number(a.failMultiplier ?? 2)),
    worsenMin: Number(a.worsenMin ?? 1),
    worsenMax: Number(a.worsenMax ?? 1.5),
    dampMin: Number(a.dampMin ?? 0.8),
    dampMax: Number(a.dampMax ?? 1),
  };
}

function clampStakes(n) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(200, v));
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

/** Оба параметра выросли в failMultiplier раз от старта — поднимать ставки некуда. */
export function stakesExceeded(plot, cfg) {
  const x = actsConfig(cfg).failMultiplier;
  const u0 = Math.max(1, Number(plot.urgency0) || 1);
  const g0 = Math.max(1, Number(plot.gravity0) || 1);
  return Number(plot.urgency) >= x * u0 && Number(plot.gravity) >= x * g0;
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

/**
 * @param {'auto'|'process_finished'} trigger
 * @param {'crit'|'ok'|'fail'|null} finish
 */
export function applyStoryActMove(
  plot,
  { trigger, aligned = false, finish = null, rng = Math.random, config = null } = {},
) {
  if (!isThreeActPlot(plot) || plot.ending) {
    return {
      ending: plot.ending || null,
      reveal: 'none',
      stakes: null,
      actFrom: plot.act || 1,
      actTo: plot.act || 1,
    };
  }

  const type = plot.storyType;
  const act = Number(plot.act) === 2 ? 2 : 1;
  const auto = trigger === 'auto';
  const fin = finish === 'crit' || finish === 'fail' ? finish : 'ok';

  let nextAct = act;
  let stakesKind = 'none';
  let ending = null;
  let reveal = 'none';

  if (type === 'suspense' && act === 1) {
    if (auto) {
      nextAct = 2;
      stakesKind = 'worsen';
    } else if (aligned && fin === 'crit') {
      ending = 'crit';
    } else if (aligned) {
      nextAct = 2;
      stakesKind = 'worsen';
    } else if (fin === 'crit') {
      nextAct = 1;
    } else {
      nextAct = 2;
      stakesKind = 'worsen';
    }
  } else if (type === 'suspense' && act === 2) {
    if (auto) {
      stakesKind = 'worsen';
    } else if (aligned && fin === 'crit') {
      ending = 'crit';
    } else if (aligned && fin === 'ok') {
      ending = 'ok';
    } else if (aligned) {
      stakesKind = 'worsen';
    } else if (fin === 'crit') {
      stakesKind = 'damp';
    } else if (fin === 'ok') {
      stakesKind = 'none';
    } else {
      stakesKind = 'worsen';
    }
  } else if (type === 'mystery' && act === 1) {
    if (auto) {
      nextAct = 2;
      stakesKind = 'worsen';
    } else if (aligned && fin === 'crit') {
      ending = 'crit';
      reveal = 'full';
    } else if (aligned && fin === 'ok') {
      nextAct = 2;
      stakesKind = 'worsen';
      reveal = 'partial';
    } else if (aligned) {
      nextAct = 2;
      stakesKind = 'worsen';
    } else if (fin === 'crit') {
      nextAct = 2;
      stakesKind = 'worsen';
      reveal = 'partial';
    } else {
      nextAct = 2;
      stakesKind = 'worsen';
    }
  } else if (type === 'mystery' && act === 2) {
    if (auto) {
      stakesKind = 'worsen';
    } else if (aligned && fin === 'crit') {
      ending = 'crit';
      reveal = 'full';
    } else if (aligned && fin === 'ok') {
      ending = 'ok';
      reveal = 'full';
    } else if (aligned) {
      stakesKind = 'worsen';
    } else if (fin === 'crit') {
      stakesKind = 'damp';
      reveal = 'clue';
    } else if (fin === 'ok') {
      stakesKind = 'none';
    } else {
      stakesKind = 'worsen';
    }
  }

  const stakes = applyStakes(plot, stakesKind, rng, config);
  plot.act = nextAct;
  if (!ending && stakesKind === 'worsen' && stakesExceeded(plot, config)) {
    ending = 'fail';
    if (type === 'mystery') reveal = 'none';
  }
  plot.ending = ending;

  return {
    ending,
    reveal,
    stakes,
    actFrom: act,
    actTo: plot.act,
    aligned: Boolean(aligned),
    trigger,
    finish: auto ? null : fin,
  };
}

export function formatActMoveForPrompt(plot, move) {
  if (!move) return '';
  const type = plot.storyType === 'mystery' ? 'тайна' : 'саспенс';
  const lines = [
    `ТАКТОВКА (решил движок, не спорь): тип «${type}», такт ${move.actFrom}→${plot.act}.`,
  ];
  if (move.stakes && move.stakes.kind === 'worsen') {
    lines.push(
      `Конфликт разгорается, ставки растут: urgency ${move.stakes.before.urgency}→${move.stakes.after.urgency}, ` +
        `gravity ${move.stakes.before.gravity}→${move.stakes.after.gravity}. Отрази это в сюжете.`,
    );
  } else if (move.stakes && move.stakes.kind === 'damp') {
    lines.push(
      `Конфликт чуть стих: urgency ${move.stakes.before.urgency}→${move.stakes.after.urgency}, ` +
        `gravity ${move.stakes.before.gravity}→${move.stakes.after.gravity}. Покажи передышку, не развязку.`,
    );
  } else {
    lines.push('Ставки этого месяца не менялись.');
  }

  if (plot.storyType === 'mystery') {
    if (move.reveal === 'full') {
      lines.push('Разгадка: открой тайну целиком в записи. Канон тайны — в системном блоке, из хроники его раньше не было.');
    } else if (move.reveal === 'partial') {
      lines.push('Открой ЧАСТЬ тайны, не всю. Канон — в системном блоке; в хронику целиком не выплёскивай.');
    } else if (move.reveal === 'clue') {
      lines.push('Новая зацепка, если ещё есть куда копать. Саму разгадку не называй.');
    } else {
      lines.push('Новой правды о тайне в этом месяце нет. Разгадку из системного блока в хронику не пиши.');
    }
  }

  if (move.ending) {
    const tag = ENDING_TAG[move.ending] || ENDING_TAG.ok;
    lines.push(`КОНЦОВКА УЖЕ РЕШЕНА ДВИЖКОМ: ${tag}. Напиши развязку в этом ключе. closes не выбирай — история закрывается.`);
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
