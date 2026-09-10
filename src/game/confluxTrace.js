/**
 * След расстыковки: зараза, перенос вещи или идеи, перманентная правка города.
 */

import { addCityEntity } from './cityEntities.js';
import { appendCityModifier } from './cityContext.js';
import { enqueueSeedRequest } from './seedSchedule.js';
import { isStakedStory } from './plotlines.js';
import { liveThreats } from './threats.js';

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

export function collectContagionThreats(domain) {
  const out = [];
  for (const plot of domain?.plotlines || []) {
    if (!isStakedStory(plot)) continue;
    for (const threat of liveThreats(plot)) {
      out.push({ plot, threat });
    }
  }
  return out;
}

export function applyUndockTrace({ a, b, conflux, world, day, rng = Math.random }) {
  const traces = [];
  const fromA = pickTransferEntity(a, rng);
  const fromB = pickTransferEntity(b, rng);
  if (fromA) traces.push({ to: b.id, entity: applyEntityTransfer(b, fromA, { fromName: a.name }) });
  if (fromB) traces.push({ to: a.id, entity: applyEntityTransfer(a, fromB, { fromName: b.name }) });

  if (!fromA && !fromB) {
    appendCityModifier(a, { text: `После сопряжения с «${b.name}» в городе иначе говорят о чужих краях.` });
    appendCityModifier(b, { text: `После сопряжения с «${a.name}» в городе иначе говорят о чужих краях.` });
  }

  for (const { plot, threat } of collectContagionThreats(a)) {
    if (rng() < 0.5) {
      enqueueSeedRequest(b, {
        grain: threat.text || plot.synopsis,
        source: 'chronicle',
        day,
      });
      traces.push({ to: b.id, contagion: threat.id || plot.id });
    }
  }
  for (const { plot, threat } of collectContagionThreats(b)) {
    if (rng() < 0.5) {
      enqueueSeedRequest(a, {
        grain: threat.text || plot.synopsis,
        source: 'chronicle',
        day,
      });
      traces.push({ to: a.id, contagion: threat.id || plot.id });
    }
  }

  void conflux;
  void world;
  return traces;
}
