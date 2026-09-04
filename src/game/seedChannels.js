/**
 * Живой посев городских историй: три канала (хроника / пустота / поручение).
 * См. docs/SEED.md. Движок бросает источник и gravity; текст пишет plantStakedStory.
 */

import { chronicleEntries } from './models.js';
import { countOpen, plotConfig } from './plotlines.js';
import { cityGenesisSeedText } from './cityContext.js';
import { FINISH_SHORT } from './rolls.js';
import {
  SEED_SOURCES,
  seedConfig,
  normalizeSeedTemp,
  touchSeedTemp,
  worldSeedChance,
  errandSeedChance,
  pickVoidGrain,
} from './seedTemp.js';

const FINISH_RANK = { fail: 0, ok: 1, crit: 2 };
const YEAR_TICKS = 12;

function weightedPick(pairs, rng) {
  const total = pairs.reduce((sum, [, w]) => sum + Math.max(0, Number(w) || 0), 0);
  if (total <= 0) return pairs[0]?.[0] || 'SITUATION';
  let roll = rng() * total;
  for (const [name, weight] of pairs) {
    roll -= Math.max(0, Number(weight) || 0);
    if (roll <= 0) return name;
  }
  return pairs[pairs.length - 1][0];
}

export function cityAgeDays(domain, world) {
  const born = Number.isFinite(Number(domain?.createdTick)) ? Number(domain.createdTick) : 0;
  const now = Number.isFinite(Number(world?.tickIndex)) ? Number(world.tickIndex) : 0;
  return Math.floor(Math.max(0, now - born) / 12);
}

/** Gravity хроники и пустоты: с возрастом города растут CRISIS / RUPTURE. */
export function pickWorldGravity(domain, world, rng = Math.random) {
  const serious = Math.min(4, 1 + cityAgeDays(domain, world));
  return weightedPick(
    [
      ['SITUATION', 48],
      ['EPISODE', 36],
      ['CRISIS', 13 * serious],
      ['RUPTURE', 3 * serious],
    ],
    rng,
  );
}

/** Gravity поручения — только от длительности дела. */
export function pickErrandGravity(objectiveMonths, rng = Math.random) {
  const months = Math.max(1, Number(objectiveMonths) || 1);
  if (months <= 2) return weightedPick([['SITUATION', 80], ['EPISODE', 20]], rng);
  if (months <= 5) {
    return weightedPick(
      [
        ['EPISODE', 55],
        ['SITUATION', 25],
        ['CRISIS', 20],
      ],
      rng,
    );
  }
  if (months <= 8) {
    return weightedPick(
      [
        ['EPISODE', 45],
        ['CRISIS', 45],
        ['RUPTURE', 10],
      ],
      rng,
    );
  }
  return weightedPick(
    [
      ['CRISIS', 50],
      ['RUPTURE', 35],
      ['EPISODE', 15],
    ],
    rng,
  );
}

/** Год хроники без записей ещё открытых историй. */
export function yearChronicleGrain(domain, world, { yearTicks = YEAR_TICKS } = {}) {
  const now = Number(world?.tickIndex) || 0;
  const live = new Set(
    (domain?.plotlines || []).filter((p) => p.kind === 'story').map((p) => String(p.id)),
  );
  return chronicleEntries(domain?.lore).filter((fact) => {
    if (Number.isFinite(Number(fact.tick)) && now - Number(fact.tick) >= yearTicks) return false;
    const refs = [...(fact.relatedPlotlineIds || []), fact.sourcePlotId]
      .map((id) => String(id || ''))
      .filter((id) => id && id !== 'null' && id !== 'undefined');
    return !refs.some((id) => live.has(id));
  });
}

export function formatChronicleGrain(entries) {
  return (entries || [])
    .map((e) => `- ${e.gameDateLabel || `тик ${e.tick}`}: ${e.text}`)
    .join('\n');
}

export function pickErrandGrain(outcomes = []) {
  const closed = (outcomes || []).filter((o) => o?.finished && !o.intel);
  if (!closed.length) return null;
  return [...closed].sort((a, b) => {
    const da = Number(a.objectiveMonths || a.expectedMonths || 0);
    const db = Number(b.objectiveMonths || b.expectedMonths || 0);
    if (db !== da) return db - da;
    return (FINISH_RANK[b.finish] || 0) - (FINISH_RANK[a.finish] || 0);
  })[0];
}

export function formatErrandGrain(outcome, chronicleAdds = []) {
  if (!outcome) return '';
  const finishNote = (chronicleAdds || []).find(
    (f) => String(f.relatedPendingId || '') === String(outcome.processId || ''),
  );
  const months = outcome.objectiveMonths || outcome.expectedMonths;
  return [
    `Дело «${outcome.summary}» закрылось.`,
    outcome.goal ? `Цель: ${outcome.goal}` : null,
    outcome.detail ? `Поручение: ${outcome.detail}` : null,
    months != null ? `Срок: ${months} мес.` : null,
    outcome.finish ? `Исход: ${outcome.finishLabel || FINISH_SHORT[outcome.finish] || outcome.finish}` : null,
    finishNote ? `Хроника завершения: ${finishNote.text}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

export function voidGrainPack(domain, { config, rng = Math.random } = {}) {
  const grain = pickVoidGrain(config, rng);
  if (grain === 'genesis') {
    const seedText = cityGenesisSeedText(domain);
    if (seedText) return { grain: 'genesis', fromVoid: false, fromGenesis: true, seedText };
  }
  return { grain: 'void', fromVoid: true, fromGenesis: false, seedText: '' };
}

function pickWinner(wants, rng) {
  if (wants.includes('errand')) return 'errand';
  if (!wants.length) return null;
  if (wants.length === 1) return wants[0];
  return rng() < 0.5 ? wants[0] : wants[1];
}

function attachGrain(decision, { domain, world, config, chronicle, errand, chronicleAdds, rng }) {
  if (decision.source === 'errand') {
    decision.gravity = pickErrandGravity(errand?.objectiveMonths || errand?.expectedMonths, rng);
    decision.seedText = formatErrandGrain(errand, chronicleAdds);
    decision.fromVoid = false;
    decision.fromGenesis = false;
    decision.grain = 'errand';
    return decision;
  }
  if (decision.source === 'chronicle') {
    decision.gravity = pickWorldGravity(domain, world, rng);
    decision.seedText = formatChronicleGrain(chronicle);
    decision.fromVoid = false;
    decision.fromGenesis = false;
    decision.grain = 'chronicle';
    return decision;
  }
  if (decision.source === 'void') {
    const pack = voidGrainPack(domain, { config, rng });
    decision.gravity = pickWorldGravity(domain, world, rng);
    decision.seedText = pack.seedText;
    decision.fromVoid = pack.fromVoid;
    decision.fromGenesis = pack.fromGenesis;
    decision.grain = pack.grain;
  }
  return decision;
}

/**
 * Кто сеет в этом месяце. Хроника и пустота — только пока живых историй < 3.
 * Поручение может сеять и при трёх, пока доска не полна (4).
 * Пустая доска и никто не выпал — всё равно сеем.
 */
export function decideMonthSeed({
  domain,
  world,
  config,
  processOutcomes = [],
  chronicleAdds = [],
  rng = Math.random,
} = {}) {
  const parsed = seedConfig(config);
  const maxOpen = plotConfig(config).board.maxOpen;
  const stories = countOpen(domain).stories;
  const temps = normalizeSeedTemp(domain?.state?.seedTemp, parsed);
  const chronicle = yearChronicleGrain(domain, world);
  const errand = pickErrandGrain(processOutcomes);
  const events = { chronicle: 'idle', void: 'idle', errand: 'idle' };
  const wants = [];

  const worldOpen = stories < parsed.worldLiveBelow;
  const boardOpen = stories < maxOpen;

  if (worldOpen) {
    if (chronicle.length) {
      if (rng() < worldSeedChance(temps.chronicle, parsed)) wants.push('chronicle');
      events.chronicle = 'miss';
    }
    if (rng() < worldSeedChance(temps.void, parsed)) wants.push('void');
    events.void = 'miss';
  }
  if (boardOpen && errand) {
    const months = errand.objectiveMonths || errand.expectedMonths;
    if (rng() < errandSeedChance(temps.errand, months, parsed)) wants.push('errand');
    events.errand = 'miss';
  }

  let source = pickWinner(wants, rng);
  if (!source && stories === 0 && boardOpen) {
    source = chronicle.length && rng() < 0.5 ? 'chronicle' : 'void';
  }
  if (source) events[source] = 'seed';

  const decision = {
    source,
    events,
    stories,
    temps,
    gravity: null,
    seedText: '',
    fromVoid: false,
    fromGenesis: false,
    grain: null,
  };
  return attachGrain(decision, { domain, world, config, chronicle, errand, chronicleAdds, rng });
}

export function applyMonthSeedTemps(domain, events, config) {
  if (!domain) return null;
  for (const source of SEED_SOURCES) {
    touchSeedTemp(domain, source, events?.[source] || 'idle', config);
  }
  return domain.state.seedTemp;
}
