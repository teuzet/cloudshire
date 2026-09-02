/**
 * Авторы хроники. Движок решает, когда писать.
 *   storyStart    — завязка саспенса
 *   mysteryStart  — core тайны: граф, observedFacts, resolutionFacts
 *   mysteryPresentation — entry/synopsis/closeWhen только из публичных фактов
 *   mysteryPresentationJudge — литературный судья подачи (Luna); FAIL → доработка
 *   suspenseJudge — литературный судья завязки саспенса (Luna); FAIL → доработка
 *   storyBeat     — default: поручения, старые нити, зеркала (агент как был)
 *   suspenseBeat  — бит саспенса
 *   mysteryBeat   — бит тайны (граф только у этого агента)
 *   orderBeat     — тик постоянного порядка
 *   storyKeep     — синопсис локальных нитей по свежей хронике
 *   confluxStoryKeep — синопсис общих нитей сопряжения
 *   fillerNews    — быт, когда сюжета не было
 * Главная линия сопряжения пишет confluxBeat; синопсис — confluxStoryKeep.
 * След в статах города ставит отдельный агент (statJudge), не они.
 */

import { newId } from './ids.js';
import {
  createLoreFact,
  createCharacterRecord,
  formatCastForPrompt,
  findCharacterByName,
  chronicleEntries,
  castRecords,
  newCharactersSchema,
  markChroniclePlotClosed,
  formatChroniclePriestMark,
} from './models.js';
import {
  createPlotline,
  findPlotline,
  closePlotline,
  plotHasActiveProcess,
  plotHasAttendingProcess,
  attachChronicleToPlotlines,
  plotConfig,
  clipPlotText,
  mysteryTypeTag,
  formatMysteryAxesForPrompt,
  openingPlotCount,
  judgePlotSeed,
  pickStoryType,
  isThreeActPlot,
  plotBeatAgentId,
  plotScale,
  allowSequelAfter,
  PLOT_SUMMARY_MAX,
  PLOT_HOOK_MAX,
} from './plotlines.js';
import {
  engineSuspenseFromCard,
  formatSuspenseCardSeedForPrompt,
  characterPlotOccupancy,
  formatOccupancyForPrompt,
} from './suspenseSeed.js';
import { normalizeDiscoveryLadder, normalizeHiddenPremises, hiddenPremisesBudget } from './suspenseGraph.js';
import { sharedPlots } from './confluxBoard.js';
import { pickOrderOutcome, markOrderFired } from './orders.js';
import { TINT_LABELS, pickRollStat, rollTint, formatFinishForPrompt } from './rolls.js';
import { offerNames, formatOfferedNamesForPrompt, bindCharacterNames, takeNameAtRandom, seedWorldNamePool } from './names.js';
import { assignPlotStakes } from './plotStakes.js';
import { formatActMoveForPrompt } from './storyActs.js';
import {
  normalizeTruthGraph,
  judgeTruthGraph,
  formatTruthGraphForPrompt,
  graphTexts,
  applyGraphTexts,
  applyEngineReveal,
  pickMysteryGraphShape,
  formatMysteryGraphShapeForPrompt,
  formatMysteryMaskForPrompt,
  mysteryGraphShapeHint,
  graphNodeCount,
  applySeedVisibility,
  graphOverflows,
  normalizeFactList,
  observedFactsIssue,
  resolutionFactsIssue,
  presentationIssue,
  NODE_TEXT_MAX,
  EDGE_REASON_MAX,
  OBSERVED_FACT_MAX,
  RESOLUTION_FACT_MAX,
} from './mysteryGraph.js';
import { formatMysteryJudgeCase, judgeMysteryCascade, summarizeJudgeAttempt, judgeMysteryPresentation, formatMysteryPresentationJudgeCase, formatJudgeRevisionForPrompt, literaryJudgeAccepts } from './mysteryJudge.js';
import { formatSuspenseJudgeCase, judgeSuspenseSeed } from './suspenseJudge.js';
import { ensureCityEntities, pickMysteryAnchors, formatMysteryAnchorsForPrompt } from './cityEntities.js';
import { formatCityForAgents } from './cityContext.js';
import {
  annotationTagsFromCard,
  climateOf,
  formatAnnotationCardForPrompt,
  poolKeyOf,
  recordSeedClimate,
  sampleAnnotationShortlist,
  sortShortlistByNovelty,
  unusedAnnotationPool,
} from './annotationPool.js';
import { refillMysteryAnnotationPool, refillSuspenseAnnotationPool } from './annotationCatalog.js';
import { selectAnnotations } from './annotationSelector.js';
import { maybeAppendStoryCityModifier } from './cityModifier.js';
import { formatOfficersCastHint } from './officers.js';
import { getLogger, truncate } from '../log.js';
import { toolFail } from '../agents/toolResult.js';

function chronicleMaxChars(config) {
  const n = Number(config?.tick?.chronicleEntryMaxChars);
  return Number.isFinite(n) && n >= 80 ? Math.round(n) : 260;
}

function cityBrief(domain) {
  return formatCityForAgents(domain);
}

function extraCity(domain, extras = []) {
  return [`Город «${domain.name}». ${cityBrief(domain)}`, formatOfficersCastHint(domain), ...extras]
    .filter(Boolean)
    .join('\n\n');
}

/** Контекст города для завязки: генезис, свежая хроника, дела, люди. */
function cityStoryContext(domain, { chronicleLimit = 8 } = {}) {
  const recent = chronicleEntries(domain.lore)
    .slice(-chronicleLimit)
    .map((e) => `- ${e.gameDateLabel || '?'}: ${e.text}${formatChroniclePriestMark(e)}`)
    .join('\n');
  const processes = (domain.state?.pendingActions || [])
    .filter((p) => !p.status || p.status === 'active')
    .map((p) => `- ${p.summary}${p.detail ? `. ${p.detail}` : ''}`)
    .join('\n');
  return {
    genesis: cityBrief(domain),
    recent: recent || '- (записей пока нет)',
    processes: processes || '- (сейчас ничего особенного не делают)',
    people: formatCastForPrompt(domain.lore, { limit: 20 }),
  };
}

const CHARACTERS_SCHEMA = newCharactersSchema();

function adoptPeople(domain, list, { world, plotId = null, author = 'storyteller', config = null, texts = [], offered = null }) {
  const bound = bindCharacterNames(world, list, { offered, texts, config });
  const cast = registerCharacters(domain, bound.list, { world, plotId, author });
  return { cast, texts: bound.texts };
}

function peopleNamesBlock(world, config) {
  const offered = offerNames(world, { female: 4, male: 4 }, config);
  return { offered, block: formatOfferedNamesForPrompt(offered) };
}

function rulerName(domain) {
  return String(domain?.characters?.[0]?.name || '').trim();
}

const FALLBACK_SEED_ROLES = [
  { role: 'писец управы', about: 'ведёт списки дворов и пайков' },
  { role: 'дозор у края', about: 'стоит смену на западной тропе' },
  { role: 'смотритель цистерн', about: 'обходит водосборы на рассвете' },
  { role: 'гончар', about: 'обжигает кувшины для цистерн' },
];

function formatSeedCastForPrompt(people) {
  if (!people?.length) return '(людей для этой завязки движок не дал)';
  const sexWord = { male: 'он', female: 'она' };
  return people
    .map((c) => {
      const sex = sexWord[c.gender] ? ` (${sexWord[c.gender]})` : '';
      const age = Number.isFinite(Number(c.ageYears)) ? `, ${c.ageYears} лет` : '';
      const role = c.role ? `, ${c.role}` : '';
      const about = c.about ? `: ${c.about}` : '';
      return `- ${c.name}${sex}${age}${role}${about}`;
    })
    .join('\n');
}

function formatSeedNamesForPrompt(names) {
  if (!names?.length) return '(имён для этой завязки движок не дал)';
  const sexWord = { male: 'он', female: 'она' };
  return names
    .map((n) => `- ${n.name}${sexWord[n.gender] ? ` (${sexWord[n.gender]})` : ''}`)
    .join('\n');
}

function offeredBuckets(names) {
  return {
    female: (names || []).filter((n) => n.gender === 'female').map((n) => n.name),
    male: (names || []).filter((n) => n.gender === 'male').map((n) => n.name),
  };
}

/**
 * 1–2 имени из пула, без роли и возраста. Из пула ещё не вынимаем:
 * заберёт bindCharacterNames, когда агент заведёт человека.
 */
export function offerMysterySeedNames({ world, domain, config, rng = Math.random } = {}) {
  seedWorldNamePool(world, config, rng);
  const n = rng() < 0.5 ? 1 : 2;
  const ruler = rulerName(domain).toLowerCase();
  const names = [];
  const taken = new Set();
  for (let i = 0; i < n; i += 1) {
    const gender = rng() < 0.5 ? 'female' : 'male';
    const key = gender === 'female' ? 'female' : 'male';
    const pool = (world.namePool?.[key] || []).filter((name) => {
      const k = String(name || '').toLowerCase();
      return k && k !== ruler && !taken.has(k);
    });
    if (!pool.length) continue;
    const name = pool[Math.floor(rng() * pool.length)];
    taken.add(String(name).toLowerCase());
    names.push({ name, gender });
  }
  return names;
}

/** 1–2 готовых человека: имя из пула, роль из каталога, возраст ставит движок. */
export function mintSeedCast({ world, domain, config, rng = Math.random, count = null } = {}) {
  seedWorldNamePool(world, config, rng);
  const roles = plotConfig(config).seedRoles;
  const catalog = roles.length ? roles : FALLBACK_SEED_ROLES;
  const n = count === 1 || count === 2 ? count : rng() < 0.5 ? 1 : 2;
  const used = new Set();
  const ruler = rulerName(domain).toLowerCase();
  const people = [];
  for (let i = 0; i < n; i += 1) {
    const gender = rng() < 0.5 ? 'female' : 'male';
    let name = takeNameAtRandom(world, gender, config, rng);
    if (ruler && name.toLowerCase() === ruler) {
      name = takeNameAtRandom(world, gender, config, rng);
    }
    const available = catalog
      .map((_, i) => i)
      .filter((i) => !used.has(i));
    const pool = available.length ? available : catalog.map((_, i) => i);
    const idx = pool[Math.floor(rng() * pool.length)];
    used.add(idx);
    const spec = catalog[idx] || catalog[0];
    people.push({
      name,
      gender,
      role: spec.role,
      about: spec.about,
      ageYears: 18 + Math.floor(rng() * 43),
      status: 'alive',
    });
  }
  return people;
}

function registerCharacters(domain, list, { world, plotId = null, author = 'storyteller' }) {
  const added = [];
  const ruler = rulerName(domain).toLowerCase();
  for (const c of list || []) {
    const name = String(c?.name || '').trim();
    if (!name) continue;
    if (ruler && name.toLowerCase() === ruler) continue;
    const existing = findCharacterByName(domain.lore, name);
    if (existing) {
      if (plotId && !existing.relatedPlotlineIds.includes(plotId)) {
        existing.relatedPlotlineIds.push(plotId);
      }
      // Судьба меняется: живой мог умереть или пропасть — и пропавшего могли найти.
      if (['dead', 'gone'].includes(c.status) && existing.status !== c.status) {
        existing.status = c.status;
      } else if (c.status === 'alive' && ['gone', 'dead'].includes(existing.status)) {
        existing.status = 'alive';
      }
      if (!['male', 'female'].includes(existing.gender) && ['male', 'female'].includes(c.gender)) {
        existing.gender = c.gender;
      }
      continue;
    }
    const record = createCharacterRecord({
      id: newId('lore'),
      name,
      role: c.role,
      about: c.about,
      gender: c.gender,
      status: c.status,
      ageYears: c.ageYears,
      tick: world.tickIndex,
      gameDateLabel: world.gameDate?.label || null,
      author,
      relatedPlotlineIds: plotId ? [plotId] : [],
      world,
    });
    domain.lore.push(record);
    added.push(record);
  }
  return added;
}

function pushChronicle(domain, { text, importance, world, plotIds = [], processId = null, processFinish = null, author }) {
  const fact = createLoreFact({
    id: newId('lore'),
    text: String(text || '').trim(),
    tags: ['chronicle'],
    gameDateLabel: world.gameDate.label,
    tick: world.tickIndex,
    author,
    importance: importance || 'minor',
    relatedPlotlineIds: plotIds.length ? plotIds : null,
    relatedPendingId: processId || null,
    processFinish,
  });
  domain.lore = domain.lore || [];
  domain.lore.push(fact);
  attachChronicleToPlotlines(domain, fact.id, plotIds);
  return fact;
}

/** Завязка новой нити по жребию тегов. */
export async function seedPlot({
  config,
  runtime,
  domain,
  world,
  storage = null,
  tags = null,
  fromClosed = null,
  opening = false,
  storyType: forcedType = null,
  log: parentLog,
}) {
  const storyType = pickStoryType();
  const log = (parentLog || getLogger()).child({ scope: 'storyteller.seed', domainId: domain.id, storyType });
  if (storyType === 'story' || storyType === 'freeform') {
    log.info('storyteller.seed_skipped', { reason: 'typed_story_not_in_live_month', storyType });
    return null;
  }
  const cfg = plotConfig(config);
  const maxChars = chronicleMaxChars(config);
  const statIds = (config.stats || []).map((s) => s.id).join(', ');
  const mystery = storyType === 'mystery';
  if (mystery) {
    await ensureCityEntities({ domain, config, runtime, log });
    return seedMysteryPlot({
      config,
      runtime,
      domain,
      world,
      storage,
      tags,
      fromClosed,
      opening,
      log,
      cfg,
      maxChars,
      statIds,
    });
  }

  return seedSuspensePlot({
    config,
    runtime,
    domain,
    world,
    storage,
    fromClosed,
    opening,
    log,
    cfg,
    maxChars,
    statIds,
  });
}

async function pickAnnotationShortlist({ runtime, domain, world, cfg, log, kind = 'mystery' }) {
  const mystery = kind === 'mystery';
  const n = mystery
    ? cfg.mysteryAnnotation?.shortlistSize || 10
    : cfg.suspenseAnnotation?.shortlistSize || 10;
  const nowTick = world?.tickIndex ?? 0;
  const climate = climateOf(domain, kind);
  const pool = unusedAnnotationPool(world?.[poolKeyOf(kind)] || [], climate);
  if (!pool.length) return [];

  const tryOnce = async () => {
    const shortlist = sampleAnnotationShortlist(pool, { n, storyType: kind });
    const approvedIds = await selectAnnotations({
      runtime,
      domain,
      world,
      cards: shortlist,
      kind,
      log,
    });
    const approved = shortlist.filter((c) => approvedIds.includes(c.id));
    return sortShortlistByNovelty(approved, climate, { nowTick, storyType: kind });
  };

  let ranked = await tryOnce();
  if (!ranked.length) ranked = await tryOnce();
  return ranked;
}

async function seedSuspensePlot({
  config,
  runtime,
  domain,
  world,
  storage = null,
  fromClosed = null,
  opening = false,
  log,
  cfg,
  maxChars,
  statIds,
}) {
  if (!opening) {
    await refillSuspenseAnnotationPool({ world, storage, runtime, config, log });
  }
  const cards = await pickAnnotationShortlist({
    runtime,
    domain,
    world,
    cfg,
    log,
    kind: 'suspense',
  });
  if (!cards.length) {
    log.info('storyteller.seed_skipped', { reason: 'seed_skipped', storyType: 'suspense' });
    return { plot: null, attempts: [], skipped: 'seed_skipped' };
  }

  const occupancy = characterPlotOccupancy(domain);
  const maxRevise = cfg.suspense?.judgeAttempts ?? 3;

  for (const card of cards) {
    const seed = engineSuspenseFromCard(card, { domain, cfg, opening, fromClosed });
    const roll = seed.tags;
    let revision = null;
    let lastAsked = null;
    let lastJudge = null;

    for (let attempt = 0; attempt < maxRevise; attempt += 1) {
      const draft = { data: null };
      const asked = await askPlotSeed({
        runtime,
        domain,
        world,
        tags: roll,
        log,
        maxChars,
        statIds,
        draft,
        fromClosed,
        opening,
        storyType: 'suspense',
        seedPeople: [],
        seedNames: [],
        nodeCount: 0,
        anchors: [],
        graphShape: null,
        sideOpen: false,
        suspenseSeed: seed,
        occupancy,
        revision,
        annotation: card,
      });
      if (!asked) {
        log.warn('storyteller.seed_failed', { attempt, annotationId: card.id });
        continue;
      }
      lastAsked = asked;

      const reason = judgePlotSeed(domain, asked, { storyType: 'suspense', depth: seed.depth });
      if (reason) {
        log.info('storyteller.seed_rejected', {
          reason,
          attempt,
          title: asked.title,
          annotationId: card.id,
          depth: seed.depth,
        });
        revision = { mechanical: reason, judge: null, previous: asked };
        continue;
      }

      const caseText = formatSuspenseJudgeCase({ draft: asked, seed, tags: roll });
      lastJudge = await judgeSuspenseSeed({
        runtime,
        caseText,
        log,
        domainId: domain.id,
      });
      log.info('suspense.seed.judge', {
        attempt: attempt + 1,
        title: asked.title,
        annotationId: card.id,
        verdict: lastJudge.verdict,
        issues: lastJudge.issues,
        summary: lastJudge.summary,
      });
      if (!literaryJudgeAccepts(lastJudge.verdict)) {
        revision = { mechanical: null, judge: lastJudge, previous: asked };
        continue;
      }

      if (opening) {
        asked.maxAgeMonths = Math.min(5, Math.max(2, Number(asked.maxAgeMonths) || 4));
      }

      const ladder = normalizeDiscoveryLadder(asked.discoveryLadder, seed.depth);
      const hidden = normalizeHiddenPremises(asked.hiddenPremises, seed.depth);

      const plot = createPlotline({
        title: asked.title,
        synopsis: asked.synopsis,
        closeWhen: asked.closeWhen,
        mootWhen: asked.mootWhen,
        relatedStats: asked.relatedStats,
        maxAgeMonths: asked.maxAgeMonths,
        temperature: cfg.temperature.initial,
        tags: roll,
        tick: world.tickIndex,
        relatedPlotlineIds: fromClosed?.id ? [fromClosed.id] : [],
        storyType: 'suspense',
        act: 1,
        gravity: seed.gravity,
        gravity0: seed.gravity,
        depth: seed.depth,
        hiddenPremises: hidden,
        discoveryLadder: ladder,
        closureGate: asked.closureGate,
        closureUnlocked: seed.depth <= 1,
        tonePrimary: seed.tonePrimary,
        annotationId: card.id,
        ifPrevented: card.ifPrevented || '',
        ifNotPrevented: card.ifNotPrevented || '',
        config,
      });
      domain.plotlines.push(plot);
      recordSeedClimate(domain, {
        tick: world.tickIndex,
        storyType: 'suspense',
        axes: card.axes,
        annotationId: card.id,
      });
      await assignPlotStakes({ runtime, domain, plot, world, log });

      const fact = pushChronicle(domain, {
        text: asked.entry,
        importance: plotScale(plot) >= 70 ? 'major' : 'minor',
        world,
        plotIds: [plot.id],
        author: 'storyteller:seed',
      });
      const cast = registerCharacters(domain, asked.newCharacters, {
        world,
        plotId: plot.id,
        author: 'storyteller:seed',
      });

      log.info('storyteller.seed', {
        plotId: plot.id,
        title: plot.title,
        attempt,
        sequelOf: fromClosed?.id || null,
        storyType: 'suspense',
        urgency: plot.urgency,
        gravity: plot.gravity,
        depth: plot.depth,
        annotationId: card.id,
        tone: plot.tonePrimary,
        maxAgeMonths: plot.maxAgeMonths,
        relatedStats: plot.relatedStats,
        cast: cast.map((c) => c.name),
        ladder: ladder.map((r) => r.id),
        literaryJudge: lastJudge?.verdict,
      });
      return { plot, fact, cast, seed, judge: lastJudge };
    }

    log.info('storyteller.seed_card_failed', {
      storyType: 'suspense',
      annotationId: card.id,
      lastTitle: lastAsked?.title || null,
      literary: lastJudge?.verdict || null,
    });
  }

  log.info('storyteller.seed_skipped', { reason: 'seed_skipped', storyType: 'suspense' });
  return { plot: null, attempts: [], skipped: 'seed_skipped' };
}

async function seedMysteryPlot({
  config,
  runtime,
  domain,
  world,
  storage = null,
  tags = null,
  fromClosed = null,
  opening = false,
  log,
  cfg,
  maxChars,
  statIds,
}) {
  if (!opening) {
    await refillMysteryAnnotationPool({ world, storage, runtime, config, log });
  }
  const cards = await pickAnnotationShortlist({
    runtime,
    domain,
    world,
    cfg,
    log,
    kind: 'mystery',
  });
  if (!cards.length) {
    log.info('storyteller.seed_skipped', { reason: 'seed_skipped', storyType: 'mystery' });
    return { plot: null, attempts: [], skipped: 'seed_skipped' };
  }
  const maxJudged = cfg.mysteryGraph?.judgeAttempts ?? 3;
  const maxGen = cfg.mysteryGraph?.generateTries ?? 6;
  const maxPres = cfg.mysteryGraph?.presentationTries ?? 3;
  const attempts = [];

  for (const card of cards) {
  const roll = annotationTagsFromCard(card);
  let judged = 0;

  for (let genTry = 0; genTry < maxGen && judged < maxJudged; genTry += 1) {
    const seedNames = offerMysterySeedNames({ world, domain, config });
    const mysteryKind = mysteryTypeTag(roll);
    const graphShape = pickMysteryGraphShape(cfg);
    const nodeCount = graphNodeCount(graphShape);
    const sideOpen =
      graphShape === 'linear_side' && Math.random() < Number(cfg.mysteryGraph?.sideRevealChance ?? 0.5);
    const anchors = pickMysteryAnchors(domain.cityEntities, cfg, Math.random, {
      inventKind: mysteryKind?.kind,
    });
    const coreDraft = { data: null };
    const asked = await askMysteryCore({
      runtime,
      domain,
      world,
      tags: roll,
      annotation: card,
      log,
      draft: coreDraft,
      fromClosed,
      opening,
      seedNames,
      nodeCount,
      anchors,
      graphShape,
      sideOpen,
    });
    if (!asked) {
      attempts.push({ genTry, skip: 'no_seed', accepted: false, lunaJudge: null, terraJudge: null });
      log.warn('storyteller.seed_failed', { genTry, judged });
      continue;
    }

    const overflow = graphOverflows(asked.truthGraph || asked);
    let graph = overflow ? null : normalizeTruthGraph(asked.truthGraph || asked);
    const observed = normalizeFactList(asked.observedFacts, { maxLen: OBSERVED_FACT_MAX });
    const resolution = normalizeFactList(asked.resolutionFacts, {
      maxItems: 5,
      maxLen: RESOLUTION_FACT_MAX,
    });
    const factReason =
      overflow ||
      (!graph ? 'missing_graph' : null) ||
      observed.reason ||
      resolution.reason ||
      observedFactsIssue(observed.facts, graph) ||
      resolutionFactsIssue(resolution.facts, graph);
    if (factReason) {
      attempts.push({
        genTry,
        skip: factReason,
        title: asked.title || null,
        accepted: false,
        lunaJudge: null,
        terraJudge: null,
      });
      log.info('storyteller.seed_rejected', { reason: factReason, genTry });
      continue;
    }
    asked.observedFacts = observed.facts;
    asked.resolutionFacts = resolution.facts;

    const bound = bindCharacterNames(world, asked.newCharacters, {
      offered: offeredBuckets(seedNames),
      texts: [
        asked.title,
        ...graphTexts(graph),
        ...asked.observedFacts,
        ...asked.resolutionFacts,
      ],
      config,
    });
    asked.newCharacters = bound.list;
    asked.title = bound.texts[0];
    const nGraph = graphTexts(graph).length;
    graph = applyGraphTexts(graph, bound.texts.slice(1, 1 + nGraph));
    const afterGraph = 1 + nGraph;
    asked.observedFacts = bound.texts.slice(afterGraph, afterGraph + asked.observedFacts.length);
    asked.resolutionFacts = bound.texts.slice(afterGraph + asked.observedFacts.length);
    asked.truthGraph = graph;

    judged += 1;
    const caseText = formatMysteryJudgeCase({
      tags: roll,
      anchors,
      graphShape,
      graph,
      draft: asked,
    });
    const cascade = await judgeMysteryCascade({
      runtime,
      caseText,
      log,
      domainId: domain.id,
    });
    const rec = {
      genTry,
      attempt: judged,
      skip: null,
      title: asked.title,
      tags: roll,
      graphShape,
      anchors,
      graph,
      observedFacts: asked.observedFacts,
      resolutionFacts: asked.resolutionFacts,
      people: (asked.newCharacters || []).map((c) => c.name).filter(Boolean),
      ...summarizeJudgeAttempt(cascade),
    };
    attempts.push(rec);
    log.info('mystery.seed.judge', {
      attempt: rec.attempt,
      genTry,
      title: rec.title,
      accepted: rec.accepted,
      luna: rec.lunaJudge,
      terra: rec.terraJudge,
    });
    if (!cascade.accepted) continue;

    let presented = null;
    let lastPres = null;
    let literary = null;
    let revision = null;
    for (let presTry = 0; presTry < maxPres; presTry += 1) {
      const presDraft = { data: null };
      const pres = await askMysteryPresentation({
        runtime,
        domain,
        world,
        tags: roll,
        log,
        draft: presDraft,
        core: asked,
        maxChars,
        statIds,
        opening,
        revision,
      });
      if (!pres) {
        log.info('storyteller.presentation_rejected', { reason: 'no_presentation', genTry, presTry });
        continue;
      }
      const presReason = presentationIssue({
        synopsis: pres.synopsis,
        entry: pres.entry,
        closeWhen: pres.closeWhen,
        graph,
      });
      if (presReason) {
        log.info('storyteller.presentation_rejected', { reason: presReason, genTry, presTry });
        revision = { mechanical: presReason, judge: null, previous: pres };
        continue;
      }
      lastPres = pres;
      const presCase = formatMysteryPresentationJudgeCase({
        graph,
        presentation: pres,
        observedFacts: asked.observedFacts,
        resolutionFacts: asked.resolutionFacts,
        title: asked.title,
      });
      literary = await judgeMysteryPresentation({
        runtime,
        caseText: presCase,
        log,
        domainId: domain.id,
      });
      if (literaryJudgeAccepts(literary.verdict)) {
        presented = pres;
        break;
      }
      log.info('storyteller.presentation_revise', {
        genTry,
        presTry,
        verdict: literary.verdict,
        issues: literary.issues,
        summary: literary.summary,
      });
      revision = { mechanical: null, judge: literary, previous: pres };
    }
    if (!presented) presented = lastPres;
    if (presented && literary && !literaryJudgeAccepts(literary.verdict)) {
      log.info('storyteller.presentation_kept', {
        title: asked.title,
        verdict: literary.verdict,
        issues: (literary.issues || []).map((i) => i.code),
      });
    }
    if (!presented) {
      rec.accepted = false;
      rec.skip = 'presentation_failed';
      log.info('storyteller.seed_rejected', { reason: 'presentation_failed', judged, title: asked.title });
      continue;
    }
    rec.literaryJudge = literary
      ? { verdict: literary.verdict, issues: literary.issues, summary: literary.summary }
      : null;
    asked.entry = presented.entry;
    asked.synopsis = presented.synopsis;
    asked.closeWhen = presented.closeWhen;
    asked.mootWhen = presented.mootWhen;
    asked.relatedStats = presented.relatedStats;
    asked.maxAgeMonths = presented.maxAgeMonths;

    const twin = judgePlotSeed(domain, asked, { storyType: 'mystery' });
    if (twin === 'twin') {
      rec.accepted = false;
      rec.skip = 'twin';
      log.info('storyteller.seed_rejected', { reason: 'twin', judged, title: asked.title });
      continue;
    }

    if (opening) {
      asked.maxAgeMonths = Math.min(5, Math.max(2, Number(asked.maxAgeMonths) || 4));
    }

    const plot = createPlotline({
      title: asked.title,
      synopsis: asked.synopsis,
      closeWhen: asked.closeWhen,
      mootWhen: asked.mootWhen,
      relatedStats: asked.relatedStats,
      maxAgeMonths: asked.maxAgeMonths,
      temperature: cfg.temperature.initial,
      tags: roll,
      tick: world.tickIndex,
      relatedPlotlineIds: fromClosed?.id ? [fromClosed.id] : [],
      storyType: 'mystery',
      act: 1,
      truthGraph: asked.truthGraph,
      observedFacts: asked.observedFacts,
      resolutionFacts: asked.resolutionFacts,
      asksSequel: asked.asksSequel === true || asked.asksSequel === 'true',
      annotationId: card.id,
      ifSolved: card.ifSolved || '',
      ifUnsolved: card.ifUnsolved || '',
      gravity: Number.isFinite(Number(card.axes?.gravity)) ? Number(card.axes.gravity) : null,
      gravity0: Number.isFinite(Number(card.axes?.gravity)) ? Number(card.axes.gravity) : null,
      config,
    });
    domain.plotlines.push(plot);
    recordSeedClimate(domain, {
      tick: world.tickIndex,
      storyType: 'mystery',
      axes: card.axes,
      annotationId: card.id,
    });
    await assignPlotStakes({ runtime, domain, plot, world, log });

    const fact = pushChronicle(domain, {
      text: asked.entry,
      importance: plotScale(plot) >= 70 ? 'major' : 'minor',
      world,
      plotIds: [plot.id],
      author: 'storyteller:seed',
    });
    const cast = registerCharacters(domain, asked.newCharacters, {
      world,
      plotId: plot.id,
      author: 'storyteller:seed',
    });

    log.info('storyteller.seed', {
      plotId: plot.id,
      title: plot.title,
      attempt: judged,
      sequelOf: fromClosed?.id || null,
      storyType: 'mystery',
      urgency: plot.urgency,
      gravity: plot.gravity,
      maxAgeMonths: plot.maxAgeMonths,
      relatedStats: plot.relatedStats,
      cast: cast.map((c) => c.name),
      graphNodes: asked.truthGraph?.nodes?.length,
      graphShape,
      sideOpen,
      mysteryKind: mysteryKind?.tagId,
      annotationId: card.id,
      asksSequel: asked.asksSequel === true || asked.asksSequel === 'true',
      anchors: anchors.map((a) => (a.invent ? `invent:${a.kind}` : a.name)),
      lunaJudge: rec.lunaJudge?.verdict,
      terraJudge: rec.terraJudge?.verdict,
      literaryJudge: rec.literaryJudge?.verdict,
    });
    return { plot, fact, cast, anchors, graphShape, mysteryKind, sideOpen, judge: rec, attempts };
  }
  }

  log.info('storyteller.seed_skipped', {
    reason: 'generation_failed',
    storyType: 'mystery',
    judged,
    attempts: attempts.map((a) => ({
      attempt: a.attempt,
      skip: a.skip,
      accepted: a.accepted,
      luna: a.lunaJudge?.verdict,
      terra: a.terraJudge?.verdict,
      literary: a.literaryJudge?.verdict,
      title: a.title,
      issues: [...(a.lunaJudge?.issues || []), ...(a.terraJudge?.issues || []), ...(a.literaryJudge?.issues || [])].map(
        (i) => i.code,
      ),
    })),
  });
  return { plot: null, attempts, skipped: 'generation_failed' };
}

/** 1–2 коротких истории сразу после генезиса. Ошибка посева город не ломает. */
export async function seedOpeningPlots({ config, runtime, domain, world, storage = null, log: parentLog, rng = Math.random }) {
  const log = (parentLog || getLogger()).child({ scope: 'storyteller.opening', domainId: domain.id });
  const want = openingPlotCount(config, rng);
  if (want <= 0) return [];
  const seeded = [];
  for (let i = 0; i < want; i += 1) {
    try {
      const one = await seedPlot({
        config,
        runtime,
        domain,
        world,
        storage,
        opening: true,
        log,
      });
      if (one?.plot) seeded.push(one);
    } catch (err) {
      log.warn('storyteller.opening_failed', { error: err.message, index: i });
    }
  }
  log.info('storyteller.opening_done', {
    wanted: want,
    got: seeded.length,
    titles: seeded.map((s) => s.plot.title),
  });
  return seeded;
}

async function askMysteryCore({
  runtime,
  domain,
  world,
  tags,
  annotation = null,
  log,
  draft,
  fromClosed = null,
  opening = false,
  seedNames = [],
  nodeCount = 4,
  anchors = [],
  graphShape = null,
  sideOpen = false,
}) {
  const tools = [
    {
      name: 'submit_mystery_core',
      description: 'Истинный причинный граф тайны. Экспозицию и closeWhen не пиши.',
      parameters: {
        type: 'object',
        required: ['title', 'nodes', 'edges', 'observedFacts', 'resolutionFacts', 'asksSequel', 'newCharacters'],
        properties: {
          title: { type: 'string', description: 'Название, 1–4 слова' },
          nodes: {
            type: 'array',
            description: `3–8 узлов истины (предпочтительно ${nodeCount}). Последний главной цепи — X. Текст узла до ${NODE_TEXT_MAX} символов, не обрывай.`,
            items: {
              type: 'object',
              required: ['id', 'text'],
              properties: {
                id: {
                  type: 'string',
                  description: 'Короткий id. Главная цепь кончается на X.',
                },
                text: {
                  type: 'string',
                  maxLength: NODE_TEXT_MAX,
                  description:
                    `Полное событие: кто, что, зачем, откуда знает и предмет. До ${NODE_TEXT_MAX} символов. Не обрывай фразу.`,
                },
              },
            },
          },
          edges: {
            type: 'array',
            description: `Причинные связи шаблона. reason — два коротких предложения, до ${EDGE_REASON_MAX} символов.`,
            items: {
              type: 'object',
              required: ['from', 'to', 'reason'],
              properties: {
                from: { type: 'string' },
                to: { type: 'string' },
                reason: {
                  type: 'string',
                  maxLength: EDGE_REASON_MAX,
                  description:
                    '1) механизм parent→child. 2) counterfactual: что было бы без parent. Без новых сущностей.',
                },
              },
            },
          },
          observedFacts: {
            type: 'array',
            minItems: 2,
            maxItems: 5,
            items: { type: 'string', maxLength: OBSERVED_FACT_MAX },
            description:
              '2–4 коротких факта, которые город уже заметил. Каждый должен быть сказан в X. Не из A/B/C.',
          },
          resolutionFacts: {
            type: 'array',
            minItems: 2,
            maxItems: 5,
            items: { type: 'string', maxLength: RESOLUTION_FACT_MAX },
            description:
              '2–4 неизвестных, уже названных в графе: кого/что/какой механизм установить. Не ответы и не новые объекты.',
          },
          asksSequel: {
            type: 'boolean',
            description:
              'true только если сама разгадка вскрывает новую неизвестную проблему. Иначе false.',
          },
          newCharacters: CHARACTERS_SCHEMA,
        },
      },
      handler: async (args) => {
        const overflow = graphOverflows(args);
        if (overflow) {
          return toolFail(overflow, 'Укороти текст узла или ребра, не обрывай фразу посередине.');
        }
        const graph = normalizeTruthGraph(args);
        const shapeReason = judgeTruthGraph(graph, {
          minNodes: 3,
          maxNodes: 8,
          shape: graphShape,
          allowCustom: true,
        });
        if (shapeReason) return toolFail(shapeReason, mysteryGraphShapeHint(graphShape, { allowCustom: true }));
        applySeedVisibility(graph, { shape: graphShape, sideOpen });
        const observed = normalizeFactList(args.observedFacts, { maxLen: OBSERVED_FACT_MAX });
        const resolution = normalizeFactList(args.resolutionFacts, { maxLen: RESOLUTION_FACT_MAX });
        const factsReason =
          observed.reason ||
          resolution.reason ||
          observedFactsIssue(observed.facts, graph) ||
          resolutionFactsIssue(resolution.facts, graph);
        if (factsReason) {
          return toolFail(
            factsReason,
            'observedFacts — только из X, 2–4 пункта. resolutionFacts — неизвестные уже из узлов, не новые объекты.',
          );
        }
        args.truthGraph = graph;
        args.observedFacts = observed.facts;
        args.resolutionFacts = resolution.facts;
        draft.data = args;
        return { ok: true };
      },
    },
  ];

  const city = cityStoryContext(domain);
  const ruler = rulerName(domain);

  await runtime.run({
    agentId: 'mysteryStart',
    tools,
    maxTurns: 3,
    toolChoice: { type: 'function', function: { name: 'submit_mystery_core' } },
    log,
    scene: 'mystery_core',
    domainId: domain.id,
    extraSystem: extraCity(domain),
    userMessages: [
      {
        role: 'user',
        content: [
          `Построй CORE новой тайны города (${world.gameDate.label}). Аннотация обязательна: воплоти её в этом городе, не пиши другую тайну.`,
          formatMysteryGraphShapeForPrompt(graphShape, { soft: true }),
          formatMysteryMaskForPrompt(graphShape, { sideOpen, forCore: true }),
          'Не пиши synopsis, entry и closeWhen. Только истину, observedFacts из X и resolutionFacts из графа.',
          '`asksSequel` — true, только если разгадка вскрывает новую неизвестную проблему.',
          opening
            ? 'Масштаб — квартал или большая группа, ставки ощутимы. Не канцелярия и не конец острова.'
            : 'Масштаб — весь город или несущая жизнь острова.',
          'Оси аннотации — направление, не второй сюжет. Ассоциативное поле — слабый импульс.',
          annotation ? formatAnnotationCardForPrompt(annotation, 0) : null,
          anchors.length
            ? 'Якоря ниже обязательны: причинная модель висит на них, а не на самом громком риске из описания города.'
            : null,
          fromClosed
            ? [
                `Только что закрылась история «${fromClosed.title}».`,
                fromClosed.reason ? `Развязка: ${fromClosed.reason}` : null,
                `Что осталось нерешённым: ${fromClosed.hook}`,
                'Новая тайна растёт из этого остатка, не повтор уже закрытого.',
              ]
                .filter(Boolean)
                .join('\n')
            : null,
          '',
          formatMysteryAxesForPrompt(tags, { opening }),
          '',
          anchors.length ? formatMysteryAnchorsForPrompt(anchors) : null,
          'Имена для завязки (бери только их). Заведи этих людей в newCharacters:',
          formatSeedNamesForPrompt(seedNames),
          ruler
            ? `Правитель города — ${ruler}. Этого человека двигателем не ставь и второго с тем же именем не заводи.`
            : null,
          'Вызови submit_mystery_core.',
        ]
          .filter(Boolean)
          .join('\n'),
      },
    ],
  });

  return draft.data;
}

async function askMysteryPresentation({
  runtime,
  domain,
  world,
  tags,
  log,
  draft,
  core,
  maxChars,
  statIds,
  opening = false,
  revision = null,
}) {
  const x = (core.truthGraph?.nodes || []).find((n) => String(n.id).toUpperCase() === 'X');
  const tools = [
    {
      name: 'submit_mystery_presentation',
      description: 'Экспозиция тайны только из уже данных публичных фактов. Новых фактов не создавай.',
      parameters: {
        type: 'object',
        required: ['synopsis', 'entry', 'closeWhen', 'mootWhen', 'maxAgeMonths', 'relatedStats'],
        properties: {
          synopsis: {
            type: 'string',
            description: `Как город сейчас понимает уже замеченное, до ${PLOT_SUMMARY_MAX} символов. Только FACTS ALLOWED.`,
          },
          entry: {
            type: 'string',
            description: `Первая хроника жреца, до ${maxChars} символов. Только FACTS ALLOWED.`,
          },
          closeWhen: {
            type: 'string',
            description: `Один успешный исход: projection resolutionFacts, до ${PLOT_HOOK_MAX} символов. Без разгадки, без «и … и», без новых объектов.`,
          },
          mootWhen: {
            type: 'string',
            description: `Когда расследование потеряло смысл. Одно условие, не дубль closeWhen, до ${PLOT_HOOK_MAX} символов.`,
          },
          maxAgeMonths: {
            type: 'number',
            description: 'Сколько месяцев история живёт без внимания (1–12).',
          },
          relatedStats: {
            type: 'array',
            items: { type: 'string' },
            description: `Каких сторон жизни касается, 1–3 из: ${statIds}. Первый — главный.`,
          },
        },
      },
      handler: async (args) => {
        if (!String(args.synopsis || '').trim() || !String(args.entry || '').trim() || !String(args.closeWhen || '').trim()) {
          return toolFail('empty', 'Нужны synopsis, entry и closeWhen.');
        }
        const reason = presentationIssue({
          synopsis: args.synopsis,
          entry: args.entry,
          closeWhen: args.closeWhen,
          graph: core.truthGraph,
        });
        if (reason) {
          return toolFail(reason, 'Не раскрывай скрытые узлы и не добавляй фактов вне списка.');
        }
        draft.data = args;
        return { ok: true };
      },
    },
  ];

  await runtime.run({
    agentId: 'mysteryPresentation',
    tools,
    maxTurns: 3,
    toolChoice: { type: 'function', function: { name: 'submit_mystery_presentation' } },
    log,
    scene: 'mystery_presentation',
    domainId: domain.id,
    extraSystem: extraCity(domain),
    userMessages: [
      {
        role: 'user',
        content: [
          `Подача уже готовой тайны «${core.title}» (${world.gameDate.label}). Новых фактов не создавай.`,
          opening ? 'Старт города: срок 2–5 месяцев, масштаб соседства или нескольких человек.' : null,
          formatMysteryAxesForPrompt(tags, { opening }),
          '',
          'FACTS ALLOWED BELOW — единственный источник synopsis и entry:',
          `X: ${x?.text || '—'}`,
          'observedFacts:',
          ...(core.observedFacts || []).map((f) => `- ${f}`),
          '',
          'closeWhen — только перефразировка resolutionFacts:',
          ...(core.resolutionFacts || []).map((f) => `- ${f}`),
          '',
          'Можно сокращать, менять порядок, перефразировать, писать голосом жреца.',
          'Нельзя: новый предмет, след, реакцию города, гипотезу как факт, вывод из скрытого.',
          'Группу называй из FACTS ALLOWED: местом, должностью, именем. Не голое «соседи», «его люди», «остальные», если из видимого не ясно, чьи.',
          'Хроника — видимое плюс зацепка: странность, по которой захочется поручить проверку. Не разгадка.',
          formatJudgeRevisionForPrompt(revision),
          'Вызови submit_mystery_presentation.',
        ]
          .filter(Boolean)
          .join('\n'),
      },
    ],
  });

  return draft.data;
}

async function askPlotSeed({
  runtime,
  domain,
  world,
  tags,
  log,
  maxChars,
  statIds,
  draft,
  fromClosed = null,
  opening = false,
  storyType = 'suspense',
  seedPeople = [],
  seedNames = [],
  nodeCount = 4,
  anchors = [],
  graphShape = null,
  sideOpen = false,
  suspenseSeed = null,
  occupancy = null,
  revision = null,
  annotation = null,
}) {
  const mystery = storyType === 'mystery';
  const depth = Math.max(1, Math.min(4, Math.round(Number(suspenseSeed?.depth) || 1)));
  const budget = hiddenPremisesBudget(depth);
  const hiddenDesc =
    depth >= 2
      ? `Скрытые факты НАСТОЯЩЕГО, заранее установленные. От ${budget.min} до ${budget.max}. Конкретный ответ на странность, не «просто сквозняк». В entry/synopsis не пиши.`
      : `Не больше ${budget.max}: скрытый факт настоящего, если в premise есть неизвестность. Короткой истории не нужны три посылки.`;
  const required = ['title', 'synopsis', 'closeWhen', 'mootWhen', 'maxAgeMonths', 'relatedStats', 'entry'];
  if (mystery) required.push('nodes', 'edges', 'asksSequel', 'newCharacters');
  if (!mystery && depth >= 2) required.push('hiddenPremises', 'discoveryLadder', 'closureGate');
  const tools = [
    {
      name: 'submit_plot_seed',
      description: mystery
        ? 'Новая тайна: истинный причинный граф и экспозиция из того, что система уже сделала видимым.'
        : 'Новая история-саспенс: завязка, как она начинается в этом месяце, и карточка для продолжения.',
      parameters: {
        type: 'object',
        required,
        properties: {
          title: { type: 'string', description: 'Название, 1–4 слова' },
          synopsis: {
            type: 'string',
            description: mystery
              ? `Как город СЕЙЧАС понимает случившееся из уже видимого, до ${PLOT_SUMMARY_MAX} символов. ` +
                'Только известная часть тайны. Скрытые узлы, причины и разгадку сюда не пиши даже намёком.'
              : `Как сейчас обстоят дела, до ${PLOT_SUMMARY_MAX} символов. ` +
                'По этому тексту историю будут продолжать. Не прогнозируй сюжет.',
          },
          closeWhen: {
            type: 'string',
            description: mystery
              ? `Один успешный исход: когда причинную модель считают раскрытой. Требовать можно только то, что уже названо в узлах ` +
                `(текст, вещество, имя, место). Без разгадки. Без «и … и». Одна фраза, до ${PLOT_HOOK_MAX} символов.`
              : `Один успешный исход истории. Не список условий через «и». Одна фраза, до ${PLOT_HOOK_MAX} символов.`,
          },
          mootWhen: {
            type: 'string',
            description:
              `Когда задача потеряла смысл: явление само прошло, предмет исчез, обряд больше не держат. ` +
              `Одно условие, не дубль closeWhen. Одна фраза, до ${PLOT_HOOK_MAX} символов.`,
          },
          maxAgeMonths: {
            type: 'number',
            description: 'Сколько месяцев история живёт без внимания (1–12).',
          },
          relatedStats: {
            type: 'array',
            items: { type: 'string' },
            description: `Каких сторон жизни касается, 1–3 из: ${statIds}. Первый — главный.`,
          },
          entry: {
            type: 'string',
            description: mystery
              ? `Первая запись хроники, до ${maxChars} символов. Только то, что город уже заметил ` +
                '(видимый узел маски). Без скрытой причины, мотива и виновного.'
              : `Что случилось в этом месяце, до ${maxChars} символов. Сухой факт.`,
          },
          nodes: mystery
            ? {
                type: 'array',
                description: `Ровно ${nodeCount} утверждений истины. Последний узел главной цепи — всегда X.`,
                items: {
                  type: 'object',
                  required: ['id', 'text'],
                  properties: {
                    id: {
                      type: 'string',
                      description: 'Короткий id. Главная цепь кончается на X — завязка для игрока, последнее наблюдаемое следствие.',
                    },
                    text: {
                      type: 'string',
                      description:
                        'Что произошло на самом деле. Одно полное событие: кто, что сделал, зачем, откуда знает, ' +
                        'откуда предмет. Не ярлык и не атмосфера.',
                    },
                  },
                },
              }
            : undefined,
          edges: mystery
            ? {
                type: 'array',
                description: 'Причинные связи. Хотя бы одна. from и to — id узлов.',
                items: {
                  type: 'object',
                  required: ['from', 'to'],
                  properties: {
                    from: { type: 'string' },
                    to: { type: 'string' },
                    reason: {
                      type: 'string',
                      description: 'Почему from вызывает to: знание, действие или физика. Не «и тогда случилось».',
                    },
                  },
                },
              }
            : undefined,
          asksSequel: mystery
            ? {
                type: 'boolean',
                description:
                  'true только если разгадка этой тайны сама вскрывает новую, доселе неизвестную проблему или конфликт. ' +
                  'Если разгадка гармонично закрывает историю — false. Сиквел сейчас не пиши.',
              }
            : undefined,
          newCharacters: CHARACTERS_SCHEMA,
          hiddenPremises: mystery
            ? undefined
            : {
                type: 'array',
                items: { type: 'string' },
                description: hiddenDesc,
              },
          discoveryLadder: mystery
            ? undefined
            : {
                type: 'array',
                items: {
                  type: 'object',
                  required: ['id', 'promise'],
                  properties: {
                    id: { type: 'string' },
                    promise: { type: 'string', description: 'Какой слой откроется на этой ступени.' },
                  },
                },
                description:
                  depth >= 2
                    ? `Ровно ${depth} ступени драматургической ёмкости. Это не сценарий финала.`
                    : 'Для короткой истории можно не заполнять.',
              },
          closureGate: mystery
            ? undefined
            : {
                type: 'string',
                description:
                  'Какой содержательный уровень должен быть достигнут, прежде чем сюжет закрываем. Не конкретное решение игрока.',
              },
          legacyAxes: mystery
            ? undefined
            : {
                type: 'array',
                items: { type: 'string' },
                description: 'Возможные оси долгого следа: geography, institution, religion, population, technology, ecology, external_relation, political_order, resource_base, supernatural_order, infrastructure, culture. Не фиксируй итог.',
              },
        },
      },
      handler: async (args) => {
        if (!String(args.title || '').trim() || !String(args.entry || '').trim() || !String(args.synopsis || '').trim()) {
          return toolFail('empty', 'Нужны название, синопсис и запись хроники.');
        }
        if (mystery) {
          const graph = normalizeTruthGraph(args);
          const reason = judgeTruthGraph(graph, {
            minNodes: 3,
            maxNodes: 8,
            shape: graphShape,
            allowCustom: true,
          });
          if (reason) {
            return toolFail(reason, mysteryGraphShapeHint(graphShape, { allowCustom: true }));
          }
          applySeedVisibility(graph, { shape: graphShape, sideOpen });
          args.truthGraph = graph;
        } else {
          const reason = judgePlotSeed({ plotlines: [] }, args, { storyType: 'suspense', depth });
          if (reason && reason !== 'twin' && reason !== 'empty' && reason !== 'thin_hook') {
            return toolFail(
              reason,
              depth >= 2
                ? 'Нужны hiddenPremises, discoveryLadder длины depth и closureGate. В хронику скрытое не пиши.'
                : 'Для короткой истории не больше одной скрытой посылки. closeWhen — одно условие успеха, mootWhen — одно условие бессмысленности.',
            );
          }
        }
        draft.data = args;
        return { ok: true };
      },
    },
  ];
  if (!mystery) {
    delete tools[0].parameters.properties.nodes;
    delete tools[0].parameters.properties.edges;
    delete tools[0].parameters.properties.asksSequel;
  } else {
    delete tools[0].parameters.properties.hiddenPremises;
    delete tools[0].parameters.properties.discoveryLadder;
    delete tools[0].parameters.properties.closureGate;
    delete tools[0].parameters.properties.legacyAxes;
  }

  const city = cityStoryContext(domain);
  const ruler = rulerName(domain);

  await runtime.run({
    agentId: mystery ? 'mysteryStart' : 'storyStart',
    tools,
    maxTurns: 3,
    toolChoice: { type: 'function', function: { name: 'submit_plot_seed' } },
    log,
    scene: 'plot_seed',
    domainId: domain.id,
    extraSystem: extraCity(domain),
    userMessages: [
      {
        role: 'user',
        content: [
          mystery
            ? `Придумай новую историю-ТАЙНУ города (${world.gameDate.label}). Тип уже выбран движком.`
            : `Придумай новую историю-саспенс города (${world.gameDate.label}). Тип уже выбран движком.`,
          mystery
            ? [
                formatMysteryGraphShapeForPrompt(graphShape),
                formatMysteryMaskForPrompt(graphShape, { sideOpen }),
                '`entry` и `synopsis` — только известная часть тайны (видимые узлы). Скрытое туда не пиши даже другими словами.',
                '`closeWhen` — когда модель считают раскрытой, без самой разгадки.',
                '`asksSequel` — true, только если разгадка вскрывает новую неизвестную проблему или конфликт. Если разгадка гармонично закрывает историю — false.',
                opening
                  ? 'Масштаб — квартал или большая группа, ставки ощутимы. Не канцелярия и не конец острова.'
                  : 'Масштаб — весь город или несущая жизнь острова. Много людей, общая судьба — не двор, не смена и не учётная книга.',
                'Тип тайны ниже обязателен. Ассоциативное поле — слабый импульс, не обязательная тема.',
                anchors.length
                  ? 'Якоря ниже обязательны: причинная модель висит на них, а не на самом громком риске из описания города.'
                  : null,
              ]
                .filter(Boolean)
                .join('\n')
            : [
                'Фокусируйся на саспенсе: нестабильное настоящее, открытое будущее.',
                'Не задерживай раскрытие — углубляй его. Каждый слой даёт payoff.',
                'Это не поручение правителя и не сопряжение — сюжет, который остров проживает сам.',
                'Сначала событие (source + tone + gravity), потом как оно входит в этот город.',
              ].join('\n'),
          fromClosed
            ? [
                `Только что закрылась история «${fromClosed.title}».`,
                fromClosed.synopsis ? `Как она шла: ${fromClosed.synopsis}` : null,
                fromClosed.lastEntry ? `Чем кончилась в этом месяце: ${fromClosed.lastEntry}` : null,
                fromClosed.reason ? `Развязка: ${fromClosed.reason}` : null,
                `Что осталось нерешённым: ${fromClosed.hook}`,
                'Новая история растёт из этого остатка: свой предмет и своя развязка, не повтор уже закрытого.',
              ]
                .filter(Boolean)
                .join('\n')
            : opening
              ? [
                  'Это СТАРТ нового города: короткая живая завязка, не катастрофа и не тайна мироздания.',
                  'Масштаб — соседство или несколько человек. Срок 2–5 месяцев.',
                  'Игрок сразу должен понять, куда можно вмешаться: решение, поручение или вопрос правителю.',
                  'Не делай проклятие всего острова, войну, мор и конец света.',
                ].join(' ')
              : 'Завязка должна быть оригинальной и интересной — такой, чтобы захотелось узнать, что будет дальше.',
          '',
          mystery
            ? formatMysteryAxesForPrompt(tags, { opening })
            : formatSuspenseCardSeedForPrompt(suspenseSeed, { opening, fromClosed }),
          '',
          mystery && anchors.length ? formatMysteryAnchorsForPrompt(anchors) : null,
          mystery && anchors.length ? '' : null,
          mystery
            ? [
                'Имена для завязки (бери только их, своих не выдумывай). Карточки не готовы — заведи этих людей в newCharacters с ролью и коротко кто они:',
                formatSeedNamesForPrompt(seedNames),
              ].join('\n')
            : formatOccupancyForPrompt(occupancy || characterPlotOccupancy(domain)),
          ruler
            ? `Правитель города — ${ruler}. Этого человека в завязку двигателем не ставь и второго с тем же именем не заводи.`
            : null,
          '',
          mystery
            ? 'Напиши ПЕРВУЮ хронику и синопсис только из известной городу части тайны: то, что маска назвала видимым. Скрытые узлы — не в текст.'
            : 'Напиши первую запись: что увидели в этом месяце. Скрытые premises в хронику и синопсис не пиши.',
          mystery
            ? 'Синопсис — как город сейчас понимает уже замеченное, чтобы по нему можно было продолжить, не зная скрытого.'
            : 'Синопсис — как обстоят дела сейчас, чтобы по нему можно было продолжить.',
          'closeWhen — один успешный исход, не список через «и». mootWhen — когда задача потеряла смысл. Тоже одно условие. ' +
            'Если closeWhen выполнится раньше срока — историю можно закрыть сразу.',
          formatJudgeRevisionForPrompt(revision),
          'Вызови submit_plot_seed.',
        ]
          .filter(Boolean)
          .join('\n'),
      },
    ],
  });

  return draft.data;
}

const PRIOR_CHRONICLE_LIMIT = 30;
const WATCH_RE = /розыск|задерж|пойм|арест|угроз|подозрева|разыск/i;

/** Уже записанное по этой нити — иначе следующий бит сочиняет поиск заново. */
export function priorPlotChronicle(domain, plot, limit = PRIOR_CHRONICLE_LIMIT) {
  if (!plot) return [];
  const ids = new Set((plot.chronicleIds || []).map(String));
  return chronicleEntries(domain?.lore)
    .filter((e) => ids.has(String(e.id)) || (e.relatedPlotlineIds || []).includes(plot.id))
    .sort((a, b) => (Number(a.tick) || 0) - (Number(b.tick) || 0))
    .slice(-limit)
    .map((e) => `- ${e.gameDateLabel || '?'}: ${e.text}${formatChroniclePriestMark(e)}`);
}

/** Имя в поручении может стоять в падеже: Левра / Левры / Иару. */
function nameMentioned(text, name) {
  const blob = String(text || '').toLowerCase();
  const n = String(name || '').trim().toLowerCase();
  if (!n || n.length < 2) return false;
  if (blob.includes(n)) return true;
  const stem = n.replace(/[аяуюиеыоь]+$/u, '');
  return stem.length >= 3 && blob.includes(stem);
}

/** Кого сейчас ищут или держат — им нельзя отдавать бумаги и доверие города. */
export function peopleUnderWatch(domain) {
  const procs = (domain?.state?.pendingActions || []).filter((p) => !p.status || p.status === 'active');
  if (!procs.length) return [];
  const hits = [];
  const seen = new Set();
  for (const c of castRecords(domain?.lore)) {
    const name = String(c.name || '').trim();
    if (!name) continue;
    for (const p of procs) {
      const blob = `${p.summary || ''} ${p.detail || ''}`;
      if (!nameMentioned(blob, name)) continue;
      if (!WATCH_RE.test(blob)) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push({ name, process: p.summary || p.detail || '' });
    }
  }
  return hits;
}

/** Очередной поворот нити: окраска уже брошена движком. */
export async function beatPlot({
  config,
  runtime,
  domain,
  world,
  beat,
  logLine = null,
  partner = null,
  confluxId = null,
  log: parentLog,
}) {
  const plot = findPlotline(domain, beat.plotId);
  if (!plot) return null;
  const log = (parentLog || getLogger()).child({ scope: 'storyteller.beat', domainId: domain.id });
  const maxChars = chronicleMaxChars(config);
  const statIds = (config.stats || []).map((s) => s.id).join(', ');
  const draft = { data: null };

  const threeAct = isThreeActPlot(plot);
  const mystery = threeAct && plot.storyType === 'mystery';
  const engineEnding = beat.actMove?.ending || null;
  const finale = Boolean(beat.finale || engineEnding);
  // У финала своя длина и свой контракт: развязка не влезает в сухую строку.
  const entryMax = finale ? Math.round(maxChars * 1.6) : maxChars;

  const tools = [
    {
      name: 'submit_plot_beat',
      description: 'Запись хроники этого месяца по уже идущей истории.',
      parameters: {
        type: 'object',
        required: ['entry'],
        properties: {
          entry: {
            type: 'string',
            description: finale
              ? `Чем история кончилась, до ${entryMax} символов: кто был, что сделали, что теперь иначе.`
              : `Что случилось в этом месяце, до ${entryMax} символов. Сухой факт.`,
          },
          relatedStats: {
            type: 'array',
            items: { type: 'string' },
            description: `Каких сторон жизни касается теперь, 1–3 из: ${statIds}. Первый — главный.`,
          },
          newCharacters: CHARACTERS_SCHEMA,
          closes: {
            type: 'boolean',
            description: threeAct
              ? 'Игнорируется: закрытие трёхтактной истории решает движок, не ты.'
              : 'true только если в ЭТОМ месяце случилось условие закрытия истории. ' +
                'Срок нити сам по себе не повод. Не выдумывай развязку, потому что «пора кончать».',
          },
          closeReason: { type: 'string' },
          sequelHook: {
            type: 'string',
            description: threeAct
              ? 'Только если история закрывается: если развязка сама оставила новый нерешённый узел — одна фраза, что осталось. ' +
                'Нет узла — оставь пустым. Это не пересказ конца и не готовая следующая история.'
              : 'Только при closes=true: если развязка сама оставила новый нерешённый узел — одна фраза, что осталось. ' +
                'Нет узла — оставь пустым. Это не пересказ конца и не готовая следующая история.',
          },
          touchesNeighbor: {
            type: 'boolean',
            description:
              'Только при сопряжении: правда ли этот поворот задел соседний город ' +
              '(люди перешли, спор у прохода, слухи, общий вред). Обычные внутренние дела — нет.',
          },
          neighborNote: {
            type: 'string',
            description: 'Если задел: одной фразой, что видит и говорит сосед.',
          },
        },
      },
      handler: async (args) => {
        if (!String(args.entry || '').trim()) return toolFail('empty', 'Нужна запись хроники.');
        draft.data = args;
        return { ok: true };
      },
    },
  ];

  const outcome = beat.processOutcome;
  const processLine = outcome
    ? outcome.finished
      ? [
          `Связанное дело «${outcome.summary}» ЗАВЕРШЕНО в этом месяце.`,
          `Исход броска (не спорь): ${formatFinishForPrompt(outcome.finish, { blessed: outcome.blessed })}.`,
          outcome.goal ? `Цель дела: ${outcome.goal}` : null,
          outcome.detail ? `Поручение было: ${outcome.detail}` : null,
        ]
          .filter(Boolean)
          .join(' ')
      : outcome.kind === 'stall'
        ? threeAct
          ? `Связанное дело «${outcome.summary}» встало: месяц без сдвига — расскажи, что помешало. Такт и ставки не меняй.`
          : `Связанное дело «${outcome.summary}» встало: месяц без сдвига — расскажи, что помешало.`
        : threeAct
          ? `Связанное дело «${outcome.summary}» пошло быстрее обычного — расскажи, что позволило. Такт и ставки не меняй.`
          : `Связанное дело «${outcome.summary}» пошло быстрее обычного — расскажи, что позволило.`
    : null;

  const prior = priorPlotChronicle(domain, plot);
  const watched = peopleUnderWatch(domain);
  const names = peopleNamesBlock(world);
  const ruler = rulerName(domain);
  const actBlock = threeAct ? formatActMoveForPrompt(plot, beat.actMove) : '';
  const occupancy = !mystery && threeAct ? characterPlotOccupancy(domain) : null;

  const closeHint = threeAct
    ? engineEnding
      ? mystery
        ? plot.asksSequel && (engineEnding === 'ok' || engineEnding === 'crit')
          ? 'Движок уже закрывает историю. closes не выбирай. Тайну разгадали, и стартер пометил новую проблему. Если она в этом месяце вышла наружу — sequelHook одной фразой. Если развязка сама гармонично всё закрыла — поле пустое.'
          : 'Движок уже закрывает историю. closes не выбирай. Сиквел этой тайны не будет. sequelHook не ставь.'
        : 'Движок уже закрывает историю. closes не выбирай. Если развязка оставила новый нерешённый узел — sequelHook одной фразой, иначе пусто. Сиквел или след в каноне решает движок.'
      : 'Историю этим месяцем не закрывай. closes не выбирай.'
    : finale
      ? 'Проходное дело закончилось: покажи итог. closes=true.'
      : outcome?.finished
        ? 'Дело закончилось. Напиши его итог, не отменяя уже записанную хронику: если человека нашли — не пиши, что его всё ещё ищут. closes=true, только если этим исполнилось условие закрытия самой истории.'
        : 'Сдвинь историю по исходу броска. closes=true — только если в этом месяце случилось условие закрытия, даже если до срока ещё далеко. Не закрывай и не выдумывай развязку просто потому что нить старая. Если закрываешь и после развязки остался новый нерешённый узел — sequelHook одной фразой, иначе пусто.';

  await runtime.run({
    agentId: plotBeatAgentId(plot),
    tools,
    maxTurns: 3,
    toolChoice: { type: 'function', function: { name: 'submit_plot_beat' } },
    log,
    scene: 'plot_beat',
    domainId: domain.id,
    extraSystem: [
      extraCity(domain, [
        ruler ? `Правитель города — ${ruler}. Этого человека в newCharacters не заводи, второго с тем же именем тоже.` : null,
        `Известные люди города:\n${formatCastForPrompt(domain.lore, { limit: 12 })}`,
      ]),
      occupancy ? formatOccupancyForPrompt(occupancy) : null,
      mystery && plot.truthGraph
        ? `${formatTruthGraphForPrompt(plot.truthGraph)}\nСкрытое в запись не выноси, кроме узлов и рёбер, которые блок ТАКТОВКА открывает в этом месяце.`
        : mystery && plot.truth
          ? `ТАЙНА (канон, не в хронику пока движок не велел):\n${plot.truth}`
          : null,
    ]
      .filter(Boolean)
      .join('\n\n'),
    userMessages: [
      {
        role: 'user',
        content: [
          `История «${plot.title}» (${world.gameDate.label}).`,
          `Сейчас: ${plot.synopsis || 'только началась'}`,
          plot.closeWhen
            ? `Успешный исход: ${plot.closeWhen}. История теряет смысл, когда: ${plot.mootWhen || '—'}. Это условия развязки, не срок.`
            : null,
          prior.length ? `\nУже записано по этой истории (не отменяй):\n${prior.join('\n')}` : null,
          watched.length
            ? `\nСейчас ищут или держат: ${watched.map((w) => `${w.name} («${w.process}»)`).join('; ')}. ` +
              'Им нельзя отдавать бумаги, ключи и доверие города, пока запись сама не скажет, что их поймали или сняли подозрение.'
            : null,
          '',
          actBlock || null,
          !threeAct && !beat.skipTint ? `ИСХОД ЭТОГО МЕСЯЦА (решено броском, не спорь): ${TINT_LABELS[beat.tint]}.` : null,
          !threeAct && beat.statId ? `Решала сторона города: ${beat.statId}.` : null,
          processLine,
          closeHint,
          partner
            ? `Города сейчас в сопряжении с «${partner.name}». Если поворот реально задел соседа — ` +
              'touchesNeighbor=true и одна фраза в neighborNote. Внутренние дела соседа не касаются.'
            : null,
          logLine ? `В городе этим месяцем: ${logLine}` : null,
          '',
          names.block,
          '',
          'Вызови submit_plot_beat. Только запись этого месяца; карточку истории и граф истины не переписывай. Синопсис не обновляй — это делает storyKeep.',
        ]
          .filter(Boolean)
          .join('\n'),
      },
    ],
  });

  if (!draft.data) {
    log.warn('storyteller.beat_failed', { plotId: plot.id });
    return null;
  }

  const d = draft.data;
  const finishToken = engineEnding || (outcome?.finished ? outcome.finish || null : null);
  const major =
    Boolean(engineEnding) ||
    (!threeAct && (beat.finale || d.closes)) ||
    plotScale(plot) >= 70;

  const fact = pushChronicle(domain, {
    text: d.entry,
    importance: major ? 'major' : 'minor',
    world,
    plotIds: [plot.id],
    processId: outcome?.processId || null,
    processFinish: finishToken,
    author: 'storyteller:beat',
  });

  const adopted = adoptPeople(domain, d.newCharacters, {
    world,
    plotId: plot.id,
    author: 'storyteller:beat',
    texts: [d.entry, d.synopsis],
    offered: names.offered,
  });
  if (adopted.texts[0]) fact.text = adopted.texts[0];
  if (adopted.texts[1]) d.synopsis = adopted.texts[1];
  const cast = adopted.cast;

  if (mystery && plot.truthGraph) {
    applyEngineReveal(plot.truthGraph, {
      reveal: beat.actMove?.reveal || 'none',
      ending: engineEnding,
      openedNodes: beat.actMove?.openedNodes || [],
      openedEdges: beat.actMove?.openedEdges || [],
    });
  }

  if (Array.isArray(d.relatedStats) && d.relatedStats.length) {
    const allowed = new Set((config.stats || []).map((s) => s.id));
    const next = d.relatedStats.map(String).filter((id) => allowed.has(id));
    if (next.length) plot.relatedStats = next;
  }
  plot.lastBeatTick = world.tickIndex;
  plot.beatCount += 1;

  const wantClose = threeAct ? Boolean(engineEnding) : Boolean(d.closes || beat.finale);
  const stillBusy = threeAct ? plotHasAttendingProcess(domain, plot) : plotHasActiveProcess(domain, plot);
  const closed = wantClose && !stillBusy;
  if (engineEnding && !plot.ending) plot.ending = engineEnding;
  const closeReason = threeAct
    ? engineEnding === 'crit'
      ? 'критический успех'
      : engineEnding === 'fail'
        ? 'провал'
        : 'успех'
    : d.closeReason || (beat.finale ? 'дело закончилось' : 'условие закрытия исполнилось');
  const sequelHook =
    closed && allowSequelAfter(plot) ? clipPlotText(String(d.sequelHook || '').trim(), PLOT_HOOK_MAX) : '';
  if (closed) {
    closePlotline(domain, plot.id, {
      tick: world.tickIndex,
      reason: closeReason,
      sequelHook,
    });
    markChroniclePlotClosed(fact, { reason: closeReason });
    await maybeAppendStoryCityModifier({ runtime, domain, world, plot, config, log });
  } else if (wantClose) {
    log.info('storyteller.beat_close_held', { plotId: plot.id, reason: 'active_process' });
  }

  // Зеркало у соседа: одна и та же правда с двух сторон, без второго вызова модели.
  let mirror = null;
  if (partner && d.touchesNeighbor) {
    mirror = mirrorBeatToPartner({
      partner,
      domain,
      plot,
      fact,
      note: d.neighborNote,
      world,
      confluxId,
      config,
    });
  }

  log.info('storyteller.beat', {
    plotId: plot.id,
    title: plot.title,
    tint: beat.tint,
    finale: Boolean(beat.finale),
    closed,
    sequelHook: sequelHook || null,
    cast: cast.map((c) => c.name),
    mirrored: mirror?.plot?.id || null,
    textPreview: truncate(d.entry, 160),
  });

  return { fact, plot, closed, closeReason, sequelHook, mirror };
}

function statValue(domain, statId) {
  const v = Number(domain?.stats?.[statId]);
  return Number.isFinite(v) ? v : 50;
}

/**
 * Тик постоянного порядка. Формат (история | хроника) уже брошен движком.
 * Историю пишем как обычный story; хронику — на нити указа. Синопсис указа не трогаем.
 */
export async function tickOrder({
  config,
  runtime,
  domain,
  world,
  plot,
  mode,
  event = null,
  log: parentLog,
}) {
  if (!plot || plot.kind !== 'order') return null;
  const log = (parentLog || getLogger()).child({ scope: 'storyteller.order', domainId: domain.id });
  const cfg = plotConfig(config);
  const resolvedMode = mode === 'story' || mode === 'chronicle' ? mode : pickOrderOutcome(domain, cfg);
  const maxChars = chronicleMaxChars(config);
  const statIds = (config.stats || []).map((s) => s.id).join(', ');
  const draft = { data: null };

  const statId = pickRollStat(plot.relatedStats, Math.random, cfg.roll);
  const tintRoll = rollTint(statValue(domain, statId), Math.random, cfg.roll);
  const tint = tintRoll.tint;
  const ruler = rulerName(domain);
  const prior = priorPlotChronicle(domain, plot);
  const toolName = resolvedMode === 'story' ? 'submit_order_story' : 'submit_order_chronicle';

  const chronicleFields = {
    entry: {
      type: 'string',
      description: `Что случилось в этом месяце из-за этого порядка, до ${maxChars} символов. Сухой факт.`,
    },
    relatedStats: {
      type: 'array',
      items: { type: 'string' },
      description: `Каких сторон жизни касается, 1–3 из: ${statIds}. Первый — главный.`,
    },
    newCharacters: CHARACTERS_SCHEMA,
  };

  const tools =
    resolvedMode === 'story'
      ? [
          {
            name: 'submit_order_story',
            description: 'Завязка обычной истории, которая выросла из этого постоянного порядка.',
            parameters: {
              type: 'object',
              required: ['title', 'synopsis', 'closeWhen', 'maxAgeMonths', 'relatedStats', 'entry'],
              properties: {
                title: { type: 'string', description: 'Название, 1–4 слова' },
                synopsis: {
                  type: 'string',
                  description: `Как сейчас обстоят дела, до ${PLOT_SUMMARY_MAX} символов. Только сжатие уже установленного, без прогноза.`,
                },
                closeWhen: {
                  type: 'string',
                  description: `Что должно произойти, чтобы эту историю закрыть. До ${PLOT_HOOK_MAX} символов.`,
                },
                maxAgeMonths: {
                  type: 'number',
                  description: 'Сколько месяцев история живёт без внимания (1–12).',
                },
                ...chronicleFields,
              },
            },
            handler: async (args) => {
              if (!String(args.title || '').trim() || !String(args.entry || '').trim() || !String(args.synopsis || '').trim()) {
                return toolFail('empty', 'Нужны название, синопсис и запись хроники.');
              }
              draft.data = args;
              return { ok: true };
            },
          },
        ]
      : [
          {
            name: 'submit_order_chronicle',
            description: 'Запись хроники о том, как в этом месяце жил постоянный порядок.',
            parameters: {
              type: 'object',
              required: ['entry'],
              properties: chronicleFields,
            },
            handler: async (args) => {
              if (!String(args.entry || '').trim()) return toolFail('empty', 'Нужна запись хроники.');
              draft.data = args;
              return { ok: true };
            },
          },
        ];

  const rule = plot.orderText || plot.title;

  await runtime.run({
    agentId: 'orderBeat',
    tools,
    maxTurns: 3,
    toolChoice: { type: 'function', function: { name: toolName } },
    log,
    scene: resolvedMode === 'story' ? 'order_story' : 'order_chronicle',
    domainId: domain.id,
    extraSystem: [
      extraCity(domain, [
        ruler ? `Правитель города — ${ruler}. Этого человека в newCharacters не заводи.` : null,
        `Известные люди города:\n${formatCastForPrompt(domain.lore, { limit: 12 })}`,
      ]),
    ]
      .filter(Boolean)
      .join('\n\n'),
    userMessages: [
      {
        role: 'user',
        content: [
          `Постоянный порядок «${plot.title}» (${world.gameDate.label}).`,
          `Правило: ${rule}`,
          `Как устроен: ${plot.synopsis || 'только объявлен'}`,
          plot.closeWhen ? `Порядок снимут, когда: ${plot.closeWhen}` : null,
          prior.length ? `\nУже писали про этот порядок:\n${prior.join('\n')}` : null,
          event?.kind === 'conflux_dock'
            ? [
                '',
                'Сейчас сопряжение с соседним островом. Этот порядок срабатывает на сопряжении, не по календарю.',
                event.partnerName ? `Соседний остров: «${event.partnerName}».` : null,
                event.processSummary
                  ? `Город уже начал дело: «${event.processSummary}». Хроника — что отправили и зачем, сухим фактом.`
                  : 'Напиши, как город исполнил это правило на этой встрече.',
              ]
                .filter(Boolean)
                .join(' ')
            : null,
          '',
          `ИСХОД ЭТОГО МЕСЯЦА (решено броском, не спорь): ${TINT_LABELS[tint]}.`,
          resolvedMode === 'story'
            ? [
                'Формат уже решён: заведи ОБЫЧНУЮ историю, которая выросла из этого порядка.',
                'Это не продолжение карточки указа и не новое правило. Конкретный случай: бунт из-за налога, ложный избранный, саботаж осмотра.',
                'Первая запись — что увидели в этом месяце. Синопсис — сжатие уже установленного у ЭТОЙ истории, не у указа.',
                'Карточку самого порядка не переписывай.',
                'Вызови submit_order_story.',
              ].join(' ')
            : [
                'Формат уже решён: одна запись хроники на нити этого порядка, без новой истории.',
                event?.kind === 'conflux_dock'
                  ? 'Это исполнение постоянного правила на сопряжении. Не заводи отдельную интригу и не пиши завязку новой истории.'
                  : 'Покажи, как правило отозвалось в жизни города в этом месяце. Не развивай интригу к развязке.',
                'Карточку порядка не переписывай.',
                'Вызови submit_order_chronicle.',
              ].join(' '),
        ]
          .filter(Boolean)
          .join('\n'),
      },
    ],
  });

  if (!draft.data) {
    log.warn('storyteller.order_failed', { plotId: plot.id, mode: resolvedMode });
    const fact = pushChronicle(domain, {
      text: `Порядок «${plot.title}» снова дал о себе знать.`,
      importance: 'minor',
      world,
      plotIds: [plot.id],
      author: 'storyteller:order-fallback',
    });
    markOrderFired(plot, world.tickIndex, { confluxId: event?.confluxId });
    return { fact, plot, mode: 'chronicle', spawned: null };
  }

  const d = draft.data;
  let spawned = null;
  let fact = null;

  if (resolvedMode === 'story') {
    const reason = judgePlotSeed(domain, d);
    if (!reason) {
      spawned = createPlotline({
        title: d.title,
        synopsis: d.synopsis,
        closeWhen: d.closeWhen,
        relatedStats: d.relatedStats,
        maxAgeMonths: d.maxAgeMonths,
        temperature: cfg.temperature.initial,
        tick: world.tickIndex,
        relatedPlotlineIds: [plot.id],
        config,
      });
      domain.plotlines.push(spawned);
      if (!plot.relatedPlotlineIds.includes(spawned.id)) plot.relatedPlotlineIds.push(spawned.id);
      fact = pushChronicle(domain, {
        text: d.entry,
        importance: plotScale(spawned) >= 70 ? 'major' : 'minor',
        world,
        plotIds: [spawned.id],
        author: 'storyteller:order-story',
      });
    } else {
      log.info('storyteller.order_story_rejected', { reason, title: d.title });
    }
  }

  if (!fact) {
    fact = pushChronicle(domain, {
      text: d.entry,
      importance: 'minor',
      world,
      plotIds: [plot.id],
      author: 'storyteller:order',
    });
  }

  const plotIdForCast = spawned?.id || plot.id;
  registerCharacters(domain, d.newCharacters, { world, plotId: plotIdForCast, author: 'storyteller:order' });
  if (Array.isArray(d.relatedStats) && d.relatedStats.length) {
    const allowed = new Set((config.stats || []).map((s) => s.id));
    const next = d.relatedStats.map(String).filter((id) => allowed.has(id));
    if (next.length && !spawned) plot.relatedStats = next;
  }
  markOrderFired(plot, world.tickIndex, { confluxId: event?.confluxId });

  log.info('storyteller.order', {
    plotId: plot.id,
    title: plot.title,
    mode: spawned ? 'story' : 'chronicle',
    spawnedId: spawned?.id || null,
    tint,
    textPreview: truncate(d.entry, 160),
  });
  return { fact, plot, mode: spawned ? 'story' : 'chronicle', spawned };
}

/** Забытую нить закрываем без развязки: игроку она была не нужна. */
export function fadeQuietPlot({ domain, plot, world }) {
  const fact = pushChronicle(domain, {
    text: `Про историю «${plot.title}» в городе перестали говорить.`,
    importance: 'minor',
    world,
    plotIds: [plot.id],
    author: 'storyteller:fade',
  });
  plot.lastBeatTick = world.tickIndex;
  plot.beatCount += 1;
  closePlotline(domain, plot.id, {
    tick: world.tickIndex,
    reason: 'угасла: город перестал о ней говорить',
  });
  markChroniclePlotClosed(fact, { reason: 'угасла: город перестал о ней говорить' });
  return { fact, plot, closed: true, fade: true };
}

/**
 * Разнести поворот соседу: запись видна обоим, у соседа заводится своя нить
 * поменьше — при расстыковке каждый останется со своей версией истории.
 */
function mirrorBeatToPartner({ partner, domain, plot, fact, note, world, confluxId, config }) {
  const text = String(note || '').trim()
    ? `С той стороны, в «${domain.name}»: ${String(note).trim()}`
    : `С той стороны, в «${domain.name}»: ${fact.text}`;

  let mirrorPlot = (partner.plotlines || []).find((p) => p.mirrorOf === plot.id);
  if (!mirrorPlot) {
    mirrorPlot = createPlotline({
      title: plot.title,
      synopsis: text,
      closeWhen: 'Сосед ушёл в небо или дело у них кончилось.',
      relatedStats: plot.relatedStats,
      maxAgeMonths: Math.max(2, Math.round(plot.maxAgeMonths * 0.6)),
      temperature: plotConfig(config).temperature.initial,
      tick: world.tickIndex,
      mirrorOf: plot.id,
      confluxId,
      config,
    });
    partner.plotlines = partner.plotlines || [];
    partner.plotlines.push(mirrorPlot);
  } else {
    mirrorPlot.synopsis = clipPlotText(text, PLOT_SUMMARY_MAX);
    mirrorPlot.lastBeatTick = world.tickIndex;
    mirrorPlot.beatCount += 1;
  }

    const copy = createLoreFact({
    id: newId('lore'),
    text,
    tags: ['chronicle', 'conflux', confluxId ? `conflux:${confluxId}` : 'conflux', 'shared'],
    gameDateLabel: world.gameDate.label,
    tick: world.tickIndex,
    author: 'storyteller:mirror',
    importance: fact.importance,
    relatedPlotlineIds: [mirrorPlot.id],
    location: domain.name,
    concernsDomainIds: [domain.id, partner.id],
    concernsDomainNames: [domain.name, partner.name],
    plotClosed: Boolean(fact.plotClosed),
    plotCloseReason: fact.plotCloseReason || null,
  });
  partner.lore = partner.lore || [];
  partner.lore.push(copy);
  attachChronicleToPlotlines(partner, copy.id, [mirrorPlot.id]);
  return { plot: mirrorPlot, fact: copy };
}

// Оптику тихого месяца жребий собирает из трёх осей: о чём, через кого и какой формы факт.
// Одна фиксированная тема давала однообразие; сочетаний хватает, чтобы месяцы не совпадали.
const QUIET_TOPICS = [
  { id: 'weather', text: 'погода и небо над островом' },
  { id: 'market', text: 'цены и товар на рынке' },
  { id: 'water', text: 'вода: колодцы, водосборы, очереди' },
  { id: 'craft', text: 'ремесло: мастерская, инструмент, ученик' },
  { id: 'rite', text: 'храм и обряд, к которому все привыкли' },
  { id: 'family', text: 'дети, старики, семейный быт' },
  { id: 'beasts', text: 'скот, птицы, звери у края' },
  { id: 'roads', text: 'дороги, тропы, подъёмники' },
  { id: 'quarrel', text: 'соседская ссора из-за пустяка' },
  { id: 'repair', text: 'починка того, что давно ждало рук' },
  { id: 'stores', text: 'запасы, склады, счёт мешков' },
  { id: 'talk', text: 'песня, слух или байка, что ходит по городу' },
  { id: 'watch', text: 'дозор, ночные смены, порядок на улицах' },
  { id: 'edge', text: 'край острова: ветер, туман, что видно в небе' },
  { id: 'work', text: 'наём и плата: кто кого нанял и за сколько' },
  { id: 'ledger', text: 'записи и счёт: писцы, тяжбы о меже, недоимки' },
  { id: 'fields', text: 'поля, огороды, сады за городской чертой' },
  { id: 'guests', text: 'приезжие с окрестных деревень, торг на въезде' },
  { id: 'sick', text: 'хвори, знахарки, снадобья' },
  { id: 'stone', text: 'камень, лес, глина: откуда берут и как везут' },
];

const QUIET_FOCUS = [
  'мастер и его ученик',
  'торговка на лотке',
  'стражник в дозоре',
  'жрец или служка',
  'ребёнок и его родня',
  'старик, который всё помнит',
  'писец с ведомостью',
  'пастух или птичник',
  'лодочник у причала',
  'артель работников',
  'вдова или сирота на попечении',
  'сосед, который вечно недоволен',
];

const QUIET_SHAPES = [
  'мелкая удача: нашлось, наладилось, привезли',
  'починили то, что давно не работало',
  'спор кончился миром, договорились',
  'кто-то взялся за дело сам, без приказа',
  'вернулся тот, кого не ждали',
  'мелкая потеря: испортилось, разбилось, пропало',
  'поломка в неудобный час',
  'спор кончился ничем, разошлись злые',
  'кто-то не вышел на работу, дело встало',
  'подорожало или стало меньше, чем считали',
  'счёт и цена: сколько чего и по чём',
  'привычный порядок дня, никто не удивился',
  'работа шла как всегда, без событий',
  'разговор на площади, из которого ничего не вышло',
  'мелкая суета, которую к вечеру забыли',
];

function pickFrom(list, rng = Math.random) {
  return list[Math.floor(rng() * list.length)];
}

/** Жребий с оглядкой на прошлые тихие месяцы: не повторять тему подряд. */
function pickAvoiding(list, usedIds, rng = Math.random) {
  const fresh = list.filter((item) => !usedIds.includes(item.id ?? item));
  return pickFrom(fresh.length ? fresh : list, rng);
}

function rememberQuietPick(domain, pick, keep) {
  if (!domain.state) return;
  const list = Array.isArray(domain.state.quietPicks) ? domain.state.quietPicks : [];
  list.push(pick);
  domain.state.quietPicks = keep > 0 ? list.slice(-keep) : [];
}

/**
 * Тихий месяц: сюжет не стрелял, но месяц не пустой.
 * Оптику решает жребий движка, рассказчик только пишет факт. След в статах — оценщик.
 */
export async function quietMonth({ config, runtime, domain, world, log: parentLog }) {
  const log = (parentLog || getLogger()).child({ scope: 'storyteller.quiet', domainId: domain.id });
  const maxChars = chronicleMaxChars(config);
  const cfg = plotConfig(config);
  const draft = { text: null };

  const used = (domain.state?.quietPicks || []).slice(-cfg.quiet.avoidRepeat);
  const topic = pickAvoiding(
    QUIET_TOPICS,
    used.map((p) => p.topic),
  );
  const shape = pickFrom(QUIET_SHAPES);
  const focus = pickFrom(QUIET_FOCUS);

  const tools = [
    {
      name: 'submit_quiet_month',
      description: 'Одна запись о тихом месяце: погода, цены, быт. Без личных имён.',
      parameters: {
        type: 'object',
        required: ['entry'],
        properties: {
          entry: { type: 'string', description: `Сухой факт быта, до ${maxChars} символов. Без личных имён.` },
        },
      },
      handler: async ({ entry }) => {
        if (!String(entry || '').trim()) return toolFail('empty', 'Нужна запись.');
        draft.text = entry;
        return { ok: true };
      },
    },
  ];

  const season = domain.currentSeason || world.currentSeason || '';
  const recentQuiet = (domain.lore || [])
    .filter((f) => f.author === 'storyteller:quiet')
    .slice(-3)
    .map((f) => `- ${String(f.text).slice(0, 100)}`)
    .join('\n');

  await runtime.run({
    agentId: 'fillerNews',
    tools,
    maxTurns: 2,
    toolChoice: { type: 'function', function: { name: 'submit_quiet_month' } },
    log,
    scene: 'quiet_month',
    domainId: domain.id,
    extraSystem: `Город «${domain.name}». ${cityBrief(domain)}`,
    userMessages: [
      {
        role: 'user',
        content: [
          `Месяц ${world.gameDate.label} прошёл без больших событий${season ? ` (${season})` : ''}.`,
          `О чём запись: ${topic.text}.`,
          `Кто в кадре: ${focus}.`,
          `Что за случай: ${shape}.`,
          'Одна запись: место этого города, ремесло или случай, предметный исход.',
          'Людей по имени не называй — ни известных, ни новых.',
          'Никаких предвестий и намёков на будущее — это не завязка истории.',
          recentQuiet ? `Так уже писали в прошлые тихие месяцы — не повторяйся:\n${recentQuiet}` : null,
          '',
          'Вызови submit_quiet_month.',
        ]
          .filter(Boolean)
          .join('\n'),
      },
    ],
  });

  if (!draft.text) return null;

  const fact = pushChronicle(domain, {
    text: draft.text,
    importance: 'minor',
    world,
    author: 'storyteller:quiet',
  });
  rememberQuietPick(domain, { topic: topic.id, tick: world.tickIndex }, cfg.quiet.avoidRepeat);

  log.info('storyteller.quiet', {
    topic: topic.id,
    shape,
    focus,
    textPreview: truncate(draft.text, 140),
  });
  return { fact };
}

/**
 * Конец месяца: обновить синопсисы по свежей хронике.
 * Reducer: ничего нового не придумывает. Ставки и интерес — не его работа.
 */
async function runStoryKeep({
  agentId,
  scene,
  board,
  plots,
  chronicleAdds = [],
  extraSystem,
  userLead,
  runtime,
  world,
  log,
  domainId,
}) {
  if (!plots.length) return null;
  const draft = { plots: null };
  const tools = [
    {
      name: 'submit_story_keep',
      description: 'Обновлённые синопсисы. Только сжатие уже установленного. Новую хронику не пиши.',
      parameters: {
        type: 'object',
        required: ['plots'],
        properties: {
          plots: {
            type: 'array',
            description: 'Только те истории, чей синопсис реально изменился. Пустой массив, если ничего не сдвинулось.',
            items: {
              type: 'object',
              required: ['plotId', 'synopsis'],
              properties: {
                plotId: { type: 'string' },
                synopsis: {
                  type: 'string',
                  description:
                    `Сжатие уже установленного, до ${PLOT_SUMMARY_MAX} символов. ` +
                    'Сначала что уже произошло, затем как ситуация выглядит сейчас. Без прогноза и нового мотива. ' +
                    'Без «Год N, месяц M», «в месяц 5» и прочих нумерованных дат.',
                },
              },
            },
          },
        },
      },
      handler: async (args) => {
        draft.plots = Array.isArray(args.plots) ? args.plots : [];
        return { ok: true };
      },
    },
  ];

  const byPlot = new Map(plots.map((p) => [p.id, []]));
  const otherLines = [];
  for (const fact of chronicleAdds) {
    const ids = fact.relatedPlotlineIds || [];
    const line = `- ${fact.text}`;
    if (!ids.length) {
      otherLines.push(line);
      continue;
    }
    let linked = false;
    for (const id of ids) {
      if (byPlot.has(id)) {
        byPlot.get(id).push(line);
        linked = true;
      }
    }
    if (!linked) otherLines.push(line);
  }

  const plotBlocks = plots
    .map((p) => {
      const fresh = byPlot.get(p.id) || [];
      return [
        `id ${p.id} — «${p.title}»`,
        `Сейчас: ${p.synopsis || 'только началась'}`,
        p.closeWhen ? `Успешный исход: ${p.closeWhen}` : null,
        p.mootWhen ? `Теряет смысл, когда: ${p.mootWhen}` : null,
        fresh.length ? `В этом месяце:\n${fresh.join('\n')}` : 'В этом месяце своей записи не было.',
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n\n');

  await runtime.run({
    agentId,
    tools,
    maxTurns: 3,
    toolChoice: { type: 'function', function: { name: 'submit_story_keep' } },
    log,
    scene,
    domainId,
    extraSystem,
    userMessages: [
      {
        role: 'user',
        content: [
          ...userLead,
          'Ты reducer, не рассказчик. Ничего нового в историю не добавляй: ни будущего, ни мотива, ни скрытого смысла.',
          'Синопсис — только сжатие уже установленного: сначала что произошло за всё время, затем как ситуация выглядит сейчас.',
          'Не датируй календарём: не пиши «Год 3, месяц 6», «в месяц 5», номера лет и месяцев. Перескажи сюжет.',
          'Если уместно, одной фразой назови, что остаётся нерешённым — только если это уже следует из самой истории.',
          'Не пиши, куда история может пойти. Не прогнозируй сюжет.',
          'Для тайны: не раскрывай скрытый канон, если его ещё нет в хронике. Не достраивай разгадку из догадок.',
          'Развязка из хроники (нашли, умер, под стражей, в бегах) должна остаться в синопсисе.',
          'Если у истории не было новой записи и картина не сдвинулась — не включай её.',
          'Новую хронику не пиши. Вызови submit_story_keep.',
          '',
          'Открытые истории:',
          plotBlocks,
          otherLines.length ? `\nПрочие записи месяца:\n${otherLines.join('\n')}` : null,
        ]
          .filter(Boolean)
          .join('\n'),
      },
    ],
  });

  let updated = 0;
  for (const item of draft.plots || []) {
    const plot = findPlotline(board, item.plotId);
    if (!plot || plot.kind === 'order') continue;
    const next = clipPlotText(item.synopsis, PLOT_SUMMARY_MAX);
    if (!next) continue;
    plot.synopsis = next;
    updated += 1;
  }

  log.info(`${scene}.done`, { plots: plots.length, updated });
  return { updated };
}

export async function keepStories({
  config,
  runtime,
  domain,
  world,
  chronicleAdds = [],
  log: parentLog,
}) {
  const plots = (domain.plotlines || []).filter((p) => p.kind !== 'order');
  if (!plots.length) return null;
  const log = (parentLog || getLogger()).child({ scope: 'storyteller.keep', domainId: domain.id });
  return runStoryKeep({
    agentId: 'storyKeep',
    scene: 'story_keep',
    board: domain,
    plots,
    chronicleAdds,
    extraSystem: `Город «${domain.name}».`,
    userLead: [`Конец месяца ${world.gameDate.label}. Обнови карточки открытых историй этого города.`],
    runtime,
    world,
    log,
    domainId: domain.id,
  });
}

/** Синопсисы общих нитей сопряжения. Вызывать после confluxBeat, не вместо него. */
export async function keepSharedStories({
  runtime,
  conflux,
  domains = [],
  world,
  chronicleAdds = [],
  log: parentLog,
}) {
  const plots = sharedPlots(conflux);
  if (!plots.length) return null;
  const log = (parentLog || getLogger()).child({ scope: 'conflux.keep', confluxId: conflux.id });
  const names = (domains || []).map((d) => `«${d.name}»`).join(' и ');
  return runStoryKeep({
    agentId: 'confluxStoryKeep',
    scene: 'conflux_story_keep',
    board: conflux,
    plots,
    chronicleAdds,
    extraSystem: [
      names ? `Города: ${names}.` : 'История на сопряжении двух островов.',
      'Оба берега равноправны. Не суди, кто прав, и не пиши письмо одного правителя.',
    ].join(' '),
    userLead: [
      `Конец месяца ${world.gameDate.label}. Обнови карточки общих историй сопряжения.`,
      names ? `Истории касаются ${names}.` : null,
      'Синопсис общий для обоих городов: назови оба, если событие задело оба.',
    ].filter(Boolean),
    runtime,
    world,
    log,
    domainId: (conflux.domainIds || []).join('+'),
  });
}
