import { statEpithet } from './stats.js';
import { plotConcerns } from './confluxBoard.js';
import { isStoryPlot, parseFreeformGravity, storyOfficerSlots } from './plotlines.js';
import { activeProcesses, pausedProcesses, processOwnedBy, processStatAverage, processPaceRatio } from './processes.js';
import { finishChancePercents } from './rolls.js';
import { blessManaCost, currentMana } from './mana.js';
import { cityRules, proxyText } from './cityRules.js';
import { gameDateFromTickIndex } from './tickClock.js';
import { gameDateFromDay, realWaitLabel } from './gameClock.js';
import {
  DIFFICULTY_SPEC,
  DURATION_SPEC,
  normalizeDifficultyBand,
  normalizeDurationBand,
} from './bands.js';
import { deedDurationBand, deedRemainingBand, deedRemainingDays } from './deeds.js';
import { paceLabel } from './deedMath.js';
import { chronicleEntries } from './models.js';
import { parseCityBrief } from './cityContext.js';
import { domainHasIslandImage, officerHasPortrait } from '../storage/r2.js';
import { formatAxesForSpeech } from './officers.js';

function clip(text, max = 800) {
  const t = String(text || '').trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max).replace(/\s+\S*$/, '')}…`;
}

const DESC_SECTION_MAX = 8000;

function sectionsFromMarkdown(description) {
  const raw = String(description || '').trim();
  if (!raw) return [];
  if (!/^##\s+/m.test(raw)) {
    return [{ id: 'city', title: 'Город', text: clip(raw, DESC_SECTION_MAX) }];
  }
  return raw
    .split(/^##\s+/m)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk, i) => {
      const nl = chunk.indexOf('\n');
      const title = (nl < 0 ? chunk : chunk.slice(0, nl)).trim() || `Раздел ${i + 1}`;
      const text = nl < 0 ? '' : chunk.slice(nl).trim();
      return { id: `s${i}`, title, text: clip(text, DESC_SECTION_MAX) };
    })
    .filter((s) => s.text);
}

export function cityDescriptionSections(domain, config) {
  const defs = Array.isArray(config?.genesis?.aspects) ? config.genesis.aspects : [];
  const aspects = domain?.aspects && typeof domain.aspects === 'object' ? domain.aspects : {};
  const fromAspects = defs
    .map((def) => {
      const text = String(aspects[def.id] || '').trim();
      if (!text) return null;
      return { id: def.id, title: def.title || def.id, text: clip(text, DESC_SECTION_MAX) };
    })
    .filter(Boolean);
  if (fromAspects.length) return fromAspects;
  return sectionsFromMarkdown(domain?.description);
}

const CHRONICLE_LIMIT = 200;
const PEOPLE_LIMIT = 120;

/** Хроника отдаётся целиком: сюда уходит всё, что не пробилось пушем. */
function chronicleTab(domain, world) {
  const entries = chronicleEntries(domain?.lore)
    .slice(-CHRONICLE_LIMIT)
    .reverse()
    .map((f) => ({
      id: f.id || null,
      text: clip(f.text || '', 1200),
      date: factDateLabel(f, world),
      plotId: f.sourcePlotId || null,
    }))
    .filter((f) => f.text);
  return { id: 'chronicle', title: 'Хроника', entries };
}

/** Каст города: сановники впереди, остальные — как их знает лор. */
function peopleTab(domain) {
  const seen = new Set();
  const people = [];
  for (const officer of domain?.officers || []) {
    if (!officer?.name) continue;
    seen.add(officer.name);
    people.push({
      name: officer.name,
      role: officer.title || officer.office || null,
      about: String(officer.nature || '').trim(),
      officer: true,
      dead: false,
    });
  }
  for (const entry of domain?.lore || []) {
    if (!(entry?.tags || []).includes('character')) continue;
    const name = String(entry.name || '').trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    if (people.length >= PEOPLE_LIMIT) break;
    people.push({
      name,
      role: entry.role || null,
      about: clip(entry.about || entry.text || '', 400),
      ageYears: Number.isFinite(Number(entry.ageYears)) ? Number(entry.ageYears) : null,
      officer: false,
      dead: entry.status === 'dead',
    });
  }
  return { id: 'people', title: 'Люди', people };
}

function briefTab(domain) {
  const { body, unknowns } = parseCityBrief(domain?.cityBrief || '');
  const sections = [];
  if (body) sections.push({ id: 'brief-body', title: 'Как есть сейчас', text: clip(body, DESC_SECTION_MAX) });
  if (unknowns.length) {
    sections.push({
      id: 'brief-unknowns',
      title: 'Неизвестно',
      text: unknowns.map((u) => `— ${u}`).join('\n'),
    });
  }
  const modifiers = (domain?.modifiers || [])
    .map((m) => String(m?.text || '').trim())
    .filter(Boolean);
  if (modifiers.length) {
    sections.push({
      id: 'brief-modifiers',
      title: 'Постоянные изменения',
      text: clip(modifiers.map((t) => `— ${t}`).join('\n'), DESC_SECTION_MAX),
    });
  }
  return { id: 'brief', title: 'Бриф', sections };
}

/**
 * Раздел «город» — меню из вкладок, а не одна простыня описания.
 * Пустые вкладки не отдаём: в мини-аппке нечего листать вслепую.
 */
export function cityTabs(domain, world, config) {
  return [
    { id: 'description', title: 'Описание', sections: cityDescriptionSections(domain, config) },
    briefTab(domain),
    chronicleTab(domain, world),
    peopleTab(domain),
  ].filter((tab) => (tab.sections?.length || tab.entries?.length || tab.people?.length) > 0);
}

export function gameDateLabelAtTick(world, tick) {
  if (!Number.isInteger(Number(tick))) return null;
  return gameDateFromTickIndex(tick).label;
}

/**
 * Дата записи. Записи непрерывного времени знают свой день, старые — только
 * тик; сохранённая подпись важнее обеих, иначе хроника переедет при смене модели.
 */
export function factDateLabel(fact, world) {
  const saved = String(fact?.gameDateLabel || '').trim();
  if (saved) return saved;
  const day = Number(fact?.day);
  if (Number.isFinite(day)) return gameDateFromDay(day).label;
  return gameDateLabelAtTick(world, fact?.tick);
}

/**
 * Текущая дата мира. День и месяц тика идут с одной скоростью — игровой год
 * за реальные сутки, — поэтому одной дневной подписи хватает и на сопряжении.
 */
export function worldDateForView(world, day = null) {
  const d = Number.isFinite(Number(day)) ? Number(day) : Number(world?.dayIndex) || 0;
  return gameDateFromDay(d).label;
}

function durationWord(band) {
  return DURATION_SPEC[normalizeDurationBand(band)].label;
}

function difficultyWord(band) {
  return DIFFICULTY_SPEC[normalizeDifficultyBand(band)].label;
}

function cityParticipates(plot, domainId) {
  if (!isStoryPlot(plot)) return false;
  return plotConcerns(plot, domainId);
}

function statName(config, id) {
  const def = (config?.stats || []).find((s) => s.id === id);
  return def?.name || null;
}

function ownProcesses(domain, conflux) {
  const id = domain.id;
  const local = [...activeProcesses(domain), ...pausedProcesses(domain)];
  const fromBoard = (conflux?.processes || []).filter((p) => processOwnedBy(p, id));
  const seen = new Set();
  const out = [];
  for (const p of [...local, ...fromBoard]) {
    if (!p?.id || seen.has(p.id)) continue;
    if (p.status && p.status !== 'active' && p.status !== 'paused') continue;
    seen.add(p.id);
    out.push(p);
  }
  return out;
}

/**
 * Дело для игрока. Полосы — это язык агентов, чтобы они не считали числа;
 * игроку числа как раз нужны: по ним он решает, заглянуть ли через полчаса
 * или уйти на ночь. Поэтому здесь и игровые дни, и прикидка реального времени.
 */
function slimProcess(process, config, { mana = 0, domain = null, day = 0 } = {}) {
  const names = (process.linkedStats || [])
    .map((id) => statName(config, id))
    .filter(Boolean);
  const cost = blessManaCost(process);
  const active = !process.status || process.status === 'active';
  const paused = process.status === 'paused';
  const left = paused ? null : deedRemainingDays(process, day);
  return {
    id: process.id,
    summary: clip(process.summary || 'Дело', 180),
    detail: clip(process.detail || '', 1200),
    // На паузе остаток не тикает: показывать срок было бы враньём.
    remainingDays: left,
    remainingReal: left == null ? null : realWaitLabel(left, config),
    remaining: paused ? null : durationWord(deedRemainingBand(process, day)),
    totalDays: Math.max(1, Math.round(Number(process.scheduledDays) || 0)) || null,
    duration: durationWord(deedDurationBand(process)),
    difficulty: difficultyWord(process.difficulty),
    pace: paceLabel(process.paceShift),
    impossible: Boolean(process.impossible),
    paused,
    linkedStats: names,
    blessed: Boolean(process.blessed),
    blessCost: cost,
    canBless: active && !paused && !process.blessed && mana >= cost,
    finishChances: (() => {
      const avg = domain ? processStatAverage(domain, process, config) : 50;
      return finishChancePercents(avg, processPaceRatio(process), {
        blessed: Boolean(process.blessed),
        config,
      });
    })(),
  };
}

function officerAgeYears(officer) {
  const n = Number(officer?.look?.ageYears || officer?.ageYears);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : null;
}

function slimOfficerSlot(officer, process, config, mana, domain, day = 0) {
  const ageYears = officerAgeYears(officer);
  const gender = officer?.gender === 'female' || officer?.gender === 'male' ? officer.gender : null;
  return {
    title: officer.title,
    name: officer.name,
    office: officer.office,
    officerId: officer.id,
    hasPortrait: officerHasPortrait(officer),
    portraitUrl: officer.portraitUrl || null,
    nature: String(officer.nature || '').trim(),
    temper: officer?.axes ? clip(formatAxesForSpeech(officer.axes, config), 120) : '',
    ageYears,
    gender,
    process: process ? slimProcess(process, config, { mana, domain, day }) : null,
  };
}

const GRAVITY_RU = {
  SITUATION: 'ситуация',
  EPISODE: 'проблема',
  CRISIS: 'кризис',
  RUPTURE: 'катастрофа',
};

function collectEvents(domain, conflux, config, mana = 0, day = 0) {
  const id = String(domain.id);
  const byId = new Map();
  for (const p of domain.plotlines || []) {
    if (isStoryPlot(p) && p.id) byId.set(p.id, p);
  }
  for (const p of conflux?.plotlines || []) {
    if (!p?.id || !isStoryPlot(p)) continue;
    if (!cityParticipates(p, id)) continue;
    byId.set(p.id, p);
  }

  const procs = ownProcesses(domain, conflux);
  return [...byId.values()].map((plot) => {
    const related = new Set((plot.relatedProcessIds || []).map(String));
    return {
      title: clip(plot.title || 'История', 80),
      synopsis: clip(plot.synopsis || '', 600),
      gravity: plot.gravity || null,
      scale: GRAVITY_RU[parseFreeformGravity(plot.gravity)] || null,
      marks: storyOfficerSlots(plot),
      marksTotal: 4,
      processes: procs
        .filter((pr) => related.has(String(pr.id)))
        .map((pr) => slimProcess(pr, config, { mana, domain, day })),
    };
  });
}

/**
 * Справочник города для мини-аппки: без тайн, id и статов жреца.
 */
export function miniCityPayload({
  domain,
  conflux = null,
  world = null,
  config,
  generating = false,
  day = null,
} = {}) {
  if (!domain) {
    return {
      city: null,
      generating: Boolean(generating),
      gameDate: null,
      stats: [],
      events: [],
      processes: [],
      orders: [],
    };
  }

  const today = Number.isFinite(Number(day))
    ? Math.max(0, Math.round(Number(day)))
    : Math.max(0, Math.round(Number(world?.dayIndex) || 0));
  const mana = currentMana(domain);
  const stats = (config?.stats || []).map((def) => {
    const value = Number(domain.stats?.[def.id]);
    const v = Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : 50;
    const officer = (domain.officers || []).find((o) => o.statId === def.id) || null;
    const proc = officer?.processId
      ? ownProcesses(domain, conflux).find((p) => p.id === officer.processId)
      : null;
    return {
      id: def.id,
      name: def.name,
      value: v,
      epithet: statEpithet(v, config),
      about: clip(def.about || '', 280),
      officer: officer
        ? {
            id: officer.id,
            office: officer.office,
            title: officer.title,
            name: officer.name,
            nature: String(officer.nature || '').trim(),
            hasPortrait: officerHasPortrait(officer),
            portraitUrl: officer.portraitUrl || null,
            busy: Boolean(officer.processId),
            process: proc ? slimProcess(proc, config, { mana, domain, day: today }) : null,
          }
        : null,
    };
  });
  const faithRaw = Number(domain.state?.faith);
  const faith = Number.isFinite(faithRaw)
    ? Math.max(0, Math.min(100, Math.round(faithRaw)))
    : null;

  const proxy = proxyText(domain);
  const orders = [
    ...cityRules(domain).map((m) => ({
      text: clip(m.text || '', 400),
      since: m.sinceLabel || gameDateLabelAtTick(world, m.sinceTick),
    })),
    ...(proxy ? [{ text: `Доверенность: ${clip(proxy, 360)}`, since: null }] : []),
  ];

  return {
    city: {
      name: domain.name || 'Город',
      hasImage: domainHasIslandImage(domain),
      imageUrl: domain.imageUrl || null,
      sections: cityDescriptionSections(domain, config),
      tabs: cityTabs(domain, world, config),
    },
    generating: Boolean(generating),
    gameDate: worldDateForView(world, today),
    faith:
      faith == null
        ? null
        : {
            name: config.faith?.name || 'Вера',
            value: faith,
            epithet: statEpithet(faith, config),
            about: clip(
              config.faith?.about ||
                'Насколько город ещё верит, что ты — его бог.',
              280,
            ),
          },
    mana: {
      name: config.mana?.name || 'Мана',
      // Мана копится непрерывно и дробна; показываем целое вниз, чтобы
      // «есть 8» никогда не значило «на дело за 8 не хватает».
      value: Math.floor(mana),
      max: 100,
      about: clip(
        config.mana?.about || 'Сила, которой ты благословляешь дела города.',
        280,
      ),
    },
    stats,
    events: collectEvents(domain, conflux, config, mana, today),
    processes: (domain.officers || []).map((o) => {
      const proc = o.processId
        ? ownProcesses(domain, conflux).find((p) => p.id === o.processId)
        : null;
      return slimOfficerSlot(o, proc, config, mana, domain, today);
    }),
    orders,
  };
}
