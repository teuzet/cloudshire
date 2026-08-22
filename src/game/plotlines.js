import { newId } from './ids.js';

/**
 * Сюжетные линии: T → прорыв; attention → право жить; spawn → новая кровь.
 */

function clampTemp(n) {
  return Math.max(0, Math.min(100, Math.round(Number(n) || 0)));
}

function clampAtt(n) {
  return Math.max(0, Math.min(100, Math.round(Number(n) || 0)));
}

/** Обрезка по границе слова: обрубки в середине слова копятся из тика в тик. */
function clipText(s, max) {
  const t = String(s || '').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  const body = lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut;
  return `${body.replace(/[\s,;:—-]+$/, '')}…`;
}

export const PLOT_SUMMARY_MAX = 400;
export { clipText as clipPlotText };

function sliceHook(s, max = 120) {
  return clipText(s, max);
}

export function plotlinesConfig(config) {
  const p = config.tick?.plotlines || {};
  const att = p.attention || {};
  const surv = p.survival || {};
  const spawn = p.spawn || {};
  return {
    enabled: p.enabled !== false,
    heatPerTick: p.heatPerTick ?? 10,
    maxOpen: Math.max(2, Math.min(8, Number(p.maxOpen) || 6)),
    softMax: Math.max(1, Math.min(6, Number(p.softMax) || 4)),
    hooksMaxLen: Math.max(40, Math.min(200, Number(p.hooksMaxLen) || 120)),
    attention: {
      initial: att.initial ?? 20,
      bumpFactor: att.bumpFactor ?? 1,
      chronicleLink: att.chronicleLink ?? 12,
      breakthroughBonus: att.breakthroughBonus ?? 8,
      decayPerTick: att.decayPerTick ?? 3,
    },
    survival: {
      minAgeTicks: surv.minAgeTicks ?? 3,
      keepBarBase: surv.keepBarBase ?? 8,
      keepBarPerAge: surv.keepBarPerAge ?? 4,
    },
    spawn: {
      baseChance: spawn.baseChance ?? 0.1,
      emptyBoardBonus: spawn.emptyBoardBonus ?? 0.25,
      perPlotPenalty: spawn.perPlotPenalty ?? 0.03,
      perTempSumPenalty: spawn.perTempSumPenalty ?? 0.0004,
      softMaxFactor: spawn.softMaxFactor ?? 0.45,
      minChance: spawn.minChance ?? 0.02,
      maxChance: spawn.maxChance ?? 0.45,
    },
    seedTagGroups: Array.isArray(p.seedTagGroups) ? p.seedTagGroups : [],
  };
}

export function normalizePlotlines(domain) {
  if (!domain || typeof domain !== 'object') return domain;
  if (!Array.isArray(domain.plotlines)) domain.plotlines = [];
  domain.plotlines = domain.plotlines
    .filter((p) => p && p.status !== 'completed')
    .map((p) => ({
      id: String(p.id),
      title: String(p.title || 'Без названия').slice(0, 120),
      summary: clipText(p.summary, PLOT_SUMMARY_MAX),
      openHook: sliceHook(p.openHook),
      closeWhen: sliceHook(p.closeWhen),
      temperature: clampTemp(p.temperature ?? 0),
      attention: clampAtt(p.attention ?? 20),
      status: 'open',
      breakthroughThisTick: Boolean(p.breakthroughThisTick),
      lastBreakthroughTick:
        p.lastBreakthroughTick == null ? null : Number(p.lastBreakthroughTick),
      createdTick: p.createdTick == null ? null : Number(p.createdTick),
      updatedTick: p.updatedTick == null ? null : Number(p.updatedTick),
      relatedPendingIds: Array.isArray(p.relatedPendingIds)
        ? p.relatedPendingIds.map(String)
        : [],
      relatedPlotlineIds: Array.isArray(p.relatedPlotlineIds)
        ? p.relatedPlotlineIds.map(String)
        : [],
      seedTags: Array.isArray(p.seedTags) ? p.seedTags.map(String) : [],
    }));
  return domain;
}

export function createPlotline({
  title,
  summary = '',
  openHook = '',
  closeWhen = '',
  temperature = 20,
  attention = 20,
  tick = null,
  relatedPendingIds = [],
  relatedPlotlineIds = [],
  seedTags = [],
}) {
  return {
    id: newId('plot'),
    title: clipText(title || 'Сюжет', 120),
    summary: clipText(summary, PLOT_SUMMARY_MAX),
    openHook: sliceHook(openHook),
    closeWhen: sliceHook(closeWhen),
    temperature: clampTemp(temperature),
    attention: clampAtt(attention),
    status: 'open',
    breakthroughThisTick: false,
    lastBreakthroughTick: null,
    createdTick: tick,
    updatedTick: tick,
    relatedPendingIds: (relatedPendingIds || []).map(String),
    relatedPlotlineIds: (relatedPlotlineIds || []).map(String),
    seedTags: (seedTags || []).map(String),
  };
}

export function plotlineAge(plotline, tickIndex) {
  const created = plotline?.createdTick;
  if (created == null || tickIndex == null) return 0;
  return Math.max(0, Math.round(Number(tickIndex) - Number(created)));
}

export function keepBarForAge(ageTicks, cfg) {
  const surv = cfg?.survival || plotlinesConfig({}).survival;
  const age = Math.max(0, Math.round(Number(ageTicks) || 0));
  return Math.round(surv.keepBarBase + age * surv.keepBarPerAge);
}

/** +heatPerTick к T; decay attention; сброс флага прорыва перед броском. */
export function heatPlotlines(domain, heatPerTick = 10, cfg = null) {
  normalizePlotlines(domain);
  const conf = cfg || plotlinesConfig({});
  const heat = Math.max(0, Math.round(Number(heatPerTick) || 0));
  const decay = Math.max(0, Math.round(Number(conf.attention?.decayPerTick) || 0));
  for (const p of domain.plotlines) {
    p.temperature = clampTemp(p.temperature + heat);
    if (decay) p.attention = clampAtt(p.attention - decay);
    p.breakthroughThisTick = false;
  }
  return domain.plotlines;
}

export function grantAttention(plotline, amount) {
  if (!plotline) return 0;
  const n = Math.round(Number(amount) || 0);
  if (!n) return 0;
  const from = plotline.attention ?? 0;
  plotline.attention = clampAtt(from + n);
  return plotline.attention - from;
}

export function grantAttentionToIds(domain, plotlineIds, amount) {
  normalizePlotlines(domain);
  const ids = [...new Set((plotlineIds || []).map(String).filter(Boolean))];
  const granted = [];
  for (const id of ids) {
    const p = domain.plotlines.find((x) => x.id === id);
    if (!p) continue;
    const delta = grantAttention(p, amount);
    if (delta) granted.push({ id, delta, attention: p.attention });
  }
  return granted;
}

/**
 * Бросок прорыва: P = temperature/100.
 * При успехе: breakthroughThisTick=true, temperature=0, +attention bonus.
 */
export function rollBreakthroughs(domain, rng = Math.random, cfg = null) {
  normalizePlotlines(domain);
  const bonus = cfg?.attention?.breakthroughBonus ?? 8;
  const hits = [];
  for (const p of domain.plotlines) {
    const chance = clampTemp(p.temperature) / 100;
    if (rng() < chance) {
      p.breakthroughThisTick = true;
      p.temperature = 0;
      grantAttention(p, bonus);
      hits.push(p);
    }
  }
  return hits;
}

export function clearBreakthroughFlags(domain, tick = null) {
  normalizePlotlines(domain);
  for (const p of domain.plotlines) {
    if (p.breakthroughThisTick) {
      p.lastBreakthroughTick = tick;
      p.breakthroughThisTick = false;
    }
  }
}

export function listClosureCandidates(domain, tickIndex, cfg = null) {
  normalizePlotlines(domain);
  const conf = cfg || plotlinesConfig({});
  const minAge = conf.survival.minAgeTicks;
  const out = [];
  for (const p of domain.plotlines) {
    const age = plotlineAge(p, tickIndex);
    if (age < minAge) continue;
    const bar = keepBarForAge(age, conf);
    if ((p.attention ?? 0) < bar) {
      out.push({
        id: p.id,
        title: p.title,
        ageTicks: age,
        attention: p.attention,
        keepBar: bar,
        openHook: p.openHook || '',
        closeWhen: p.closeWhen || '',
        reason: `attention ${p.attention} < keepBar ${bar} (возраст ${age} тиков)`,
      });
    }
  }
  return out;
}

/** Вероятность мандата «новая самостоятельная нить». */
export function spawnChance(domain, cfg = null) {
  normalizePlotlines(domain);
  const conf = cfg || plotlinesConfig({});
  const s = conf.spawn;
  const n = domain.plotlines.length;
  if (n >= conf.maxOpen) return 0;
  const tempSum = domain.plotlines.reduce((a, p) => a + (p.temperature || 0), 0);
  let p =
    s.baseChance +
    (n === 0 ? s.emptyBoardBonus : 0) -
    n * s.perPlotPenalty -
    tempSum * s.perTempSumPenalty;
  if (n >= conf.softMax) p *= s.softMaxFactor;
  return Math.max(s.minChance, Math.min(s.maxChance, p));
}

export function pickSeedTags(configOrCfg, rng = Math.random) {
  const groups =
    configOrCfg?.seedTagGroups ||
    configOrCfg?.tick?.plotlines?.seedTagGroups ||
    [];
  const picked = [];
  const coreIds = ['spark_source', 'phenomenon', 'stakeholders', 'stake', 'tone'];
  const extraIds = ['scale', 'urgency'];
  for (const gid of [...coreIds, ...extraIds]) {
    const g = groups.find((x) => x.id === gid);
    if (!g?.tags?.length) continue;
    // core — всегда; extra — ~70%
    if (extraIds.includes(gid) && rng() > 0.7) continue;
    const tag = g.tags[Math.floor(rng() * g.tags.length)];
    if (!tag) continue;
    picked.push({
      groupId: g.id,
      groupName: g.name || g.id,
      tagId: tag.id,
      tagName: tag.name,
    });
  }
  return picked;
}

export function formatSeedTagsForPrompt(seeds) {
  if (!seeds?.length) return '(нет посева)';
  return seeds.map((s) => `${s.groupName}: «${s.tagName}»`).join(' · ');
}

/**
 * Бросок мандата новой крови. Не создаёт плотлайн — только указание режиссёру.
 */
export function rollPlotSpawn(domain, cfg = null, rng = Math.random, config = null) {
  const conf = cfg || plotlinesConfig(config || {});
  const chance = spawnChance(domain, conf);
  const roll = rng();
  const hit = roll < chance;
  const seeds = hit ? pickSeedTags(conf.seedTagGroups?.length ? conf : config, rng) : [];
  return {
    hit,
    chance,
    roll,
    openCount: domain.plotlines?.length || 0,
    softMax: conf.softMax,
    maxOpen: conf.maxOpen,
    seeds,
    seedText: formatSeedTagsForPrompt(seeds),
  };
}

export function formatPlotlinesForPrompt(domain, tickIndex = null) {
  normalizePlotlines(domain);
  if (!domain.plotlines.length) return '(плотлайнов пока нет)';
  return domain.plotlines
    .map((p) => {
      const bt = p.breakthroughThisTick ? ' ★ПРОРЫВ' : '';
      const age = tickIndex != null ? plotlineAge(p, tickIndex) : null;
      const ageBit = age != null ? ` age=${age}` : '';
      const hooks =
        (p.openHook ? ` | дальше: ${p.openHook}` : '') +
        (p.closeWhen ? ` | закрыть если: ${p.closeWhen}` : '');
      const relP =
        p.relatedPendingIds?.length > 0
          ? ` | процессы: ${p.relatedPendingIds.join(', ')}`
          : '';
      const relL =
        p.relatedPlotlineIds?.length > 0
          ? ` | нити: ${p.relatedPlotlineIds.join(', ')}`
          : '';
      return (
        `- [${p.id}] «${p.title}» T=${p.temperature} A=${p.attention}${ageBit}${bt}` +
        (p.summary ? ` — ${p.summary}` : '') +
        hooks +
        relP +
        relL
      );
    })
    .join('\n');
}

/** Короткий бриф для речи правителя / письма месяца — без id и температур. */
export function formatPlotBriefForSpeech(domain, { max = 4 } = {}) {
  normalizePlotlines(domain);
  const list = (domain.plotlines || []).slice(0, max);
  if (!list.length) return '';
  return list
    .map((p) => {
      const s = String(p.summary || '').trim();
      return s ? `«${p.title}»: ${s}` : `«${p.title}»`;
    })
    .join('\n');
}

export function formatBreakthroughMandate(breakthroughs, domainOrDomains = null) {
  if (!breakthroughs?.length) return '';
  const processIndex = new Map();
  const domains = Array.isArray(domainOrDomains)
    ? domainOrDomains
    : domainOrDomains
      ? [domainOrDomains]
      : [];
  for (const domain of domains) {
    for (const a of domain?.state?.pendingActions || []) {
      if (a?.id) processIndex.set(String(a.id), a);
    }
  }
  return [
    'ОБЯЗАТЕЛЬНЫЙ ПРИОРИТЕТ — ПРОРЫВЫ СЮЖЕТА (сделай ПЕРВЫМИ, до прочего):',
    'Для каждого: add_chronicle с явным сильным сдвигом (не «ничего не нашли / всё тихо»).',
    'Если указаны связанные процессы — затронь их (chronicle + advance/cancel); не игнорируй.',
    'Можно не завершать сюжет целиком, но мир должен заметно измениться.',
    'Если событие явно продолжает нить — можно relatedPlotlineIds (необязательно).',
    ...breakthroughs.map((p) => {
      const relIds = p.relatedPendingIds || [];
      let rel = '';
      if (relIds.length) {
        const parts = relIds.map((id) => {
          const a = processIndex.get(String(id));
          return a ? `${id} «${a.summary}»` : String(id);
        });
        rel = ` | связанные процессы: ${parts.join('; ')}`;
      }
      return `- ПРОРЫВ [${p.id}] «${p.title}»: ${p.summary || 'сдвинь эту линию вперёд'}${rel}`;
    }),
  ].join('\n');
}

export function formatDirectorMetaForPrompt({ spawn, closureCandidates, softMax, maxOpen, openCount }) {
  const lines = [];
  lines.push(
    `ДОСКА: открытых ${openCount}/${maxOpen} (комфорт ≤${softMax}). ` +
      'T — котёл к прорыву; A (attention) — право жить (растёт от bump и добровольных relatedPlotlineIds в хронике).',
  );
  if (closureCandidates?.length) {
    lines.push('КАНДИДАТЫ НА ЗАКРЫТИЕ (attention ниже планки возраста — complete или сильно оправдай upsert+bump):');
    for (const c of closureCandidates) {
      lines.push(
        `- [${c.id}] «${c.title}»: ${c.reason}` +
          (c.closeWhen ? ` | closeWhen: ${c.closeWhen}` : ''),
      );
    }
  } else {
    lines.push('Кандидатов на закрытие по attention нет.');
  }
  if (spawn?.hit) {
    lines.push(
      'МАНДАТ НОВОЙ КРОВИ (движок): создай ОДНУ новую самостоятельную нить через upsert_plotline БЕЗ relatedPlotlineIds. ' +
        `Посев: ${spawn.seedText}. Придумай культ/артефакт/аномалию и т.п. — не цепляй к текущим нитям.`,
    );
  } else if (spawn) {
    lines.push(
      `Мандат новой крови в этом тике не выпал (P≈${(spawn.chance * 100).toFixed(0)}%, roll=${spawn.roll?.toFixed?.(2) ?? '?'}).`,
    );
  }
  if (openCount >= softMax) {
    lines.push(
      `Открытых ≥${softMax}: перед submit_direction закрой (complete) хотя бы одну слабую/дублирующую нить, если есть кандидаты или бессмысленные.`,
    );
  }
  return lines.join('\n');
}
