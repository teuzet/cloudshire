/**
 * След расстыковки: зараза, перенос вещи или идеи, перманентная правка города.
 */

import { addCityEntity } from './cityEntities.js';
import { appendCityModifier } from './cityContext.js';
import { enqueueSeedRequest } from './seedSchedule.js';
import { isStakedStory } from './plotlines.js';

function originWeight(entity) {
  const src = String(entity?.origin || entity?.source || 'genesis');
  if (src === 'player' || src === 'achieved') return 8;
  if (src === 'story' || src === 'plot') return 3;
  return 1;
}

export function pickTransferEntity(domain, rng = Math.random) {
  const list = (domain?.cityEntities || []).filter((e) => e && e.name);
  if (!list.length) return null;
  const weights = list.map(originWeight);
  const total = weights.reduce((s, w) => s + w, 0);
  let r = rng() * total;
  for (let i = 0; i < list.length; i++) {
    r -= weights[i];
    if (r <= 0) return list[i];
  }
  return list[list.length - 1];
}

export function applyEntityTransfer(toDomain, entity, { fromName } = {}) {
  if (!entity) return null;
  const added = addCityEntity(toDomain, {
    kind: entity.kind,
    name: entity.name,
    about: entity.about
      ? `${entity.about} Пришло с острова «${fromName || 'соседа'}».`
      : `Пришло с острова «${fromName || 'соседа'}».`,
  });
  appendCityModifier(toDomain, {
    text: `С острова «${fromName || 'соседа'}» осталось: ${entity.name}.`,
  });
  return added;
}

/** Одна история — одно семя соседу, не по беде из пула. */
export function collectContagionStories(domain) {
  return (domain?.plotlines || []).filter((plot) => isStakedStory(plot) && plot.status !== 'closed');
}

export function applyUndockTrace({ a, b, conflux, world, day, rng = Math.random, contagion = true }) {
  const traces = [];
  const fromA = pickTransferEntity(a, rng);
  const fromB = pickTransferEntity(b, rng);
  if (fromA) traces.push({ to: b.id, entity: applyEntityTransfer(b, fromA, { fromName: a.name }) });
  if (fromB) traces.push({ to: a.id, entity: applyEntityTransfer(a, fromB, { fromName: b.name }) });

  if (!fromA && !fromB) {
    appendCityModifier(a, { text: `После сопряжения с «${b.name}» в городе иначе говорят о чужих краях.` });
    appendCityModifier(b, { text: `После сопряжения с «${a.name}» в городе иначе говорят о чужих краях.` });
  }

  if (contagion) {
    for (const plot of collectContagionStories(a)) {
      if (rng() < 0.5) {
        enqueueSeedRequest(b, {
          grain: plot.synopsis || plot.title,
          source: 'chronicle',
          day,
        });
        traces.push({ to: b.id, contagion: plot.id });
      }
    }
    for (const plot of collectContagionStories(b)) {
      if (rng() < 0.5) {
        enqueueSeedRequest(a, {
          grain: plot.synopsis || plot.title,
          source: 'chronicle',
          day,
        });
        traces.push({ to: a.id, contagion: plot.id });
      }
    }
  }

  void conflux;
  void world;
  return traces;
}
