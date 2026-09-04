/**
 * Четыре сановника города: слоты дел, характер, формат для промптов.
 */

import { newId } from './ids.js';
import { takeNameAtRandom } from './names.js';
import { stampPersonAge } from './ages.js';
import { createCharacterRecord, inferRulerGender } from './models.js';
import { getLogger, truncate } from '../log.js';
import { toolFail } from '../agents/toolResult.js';
import { formatFrozenConceptForPrompt } from './genesisConcept.js';

export const DEFAULT_OFFICES = [
  {
    office: 'treasurer',
    statId: 'prosperity',
    title: 'Казначей',
    titleGen: 'казначея',
    focus:
      'хозяйство: казна, склады, закуп, раздача, стройка, кровля, укрепление склонов и оград руками мастеров, рынок, цех, голод',
    strategy:
      'В основном интересуется ресурсами, собственностью и инфраструктурой, даже в ущерб людям.',
  },
  {
    office: 'marshal',
    statId: 'security',
    title: 'Маршал',
    titleGen: 'маршала',
    focus:
      'общественный порядок, война, преступления, стража, арест, дозор улиц; не стройка и не укрепление стен',
    strategy: 'Всегда действует решительно, даже не разобравшись в вопросе.',
  },
  {
    office: 'keeper',
    statId: 'knowledge',
    title: 'Хранитель',
    titleGen: 'хранителя',
    focus: 'архив, школа, болезнь, чертёж, исследование, алхимия',
    strategy:
      'Предпочитает сбор сведений. Часто медлит и не всегда действует решительно.',
  },
  {
    office: 'chancellor',
    statId: 'influence',
    title: 'Канцлер',
    titleGen: 'канцлера',
    focus: 'переговоры, гильдия, слух, дипломатия сопряжения, суд чести, указ в народе',
    strategy:
      'В основном интересуется людьми и наплевательски относится к ресурсам и собственности.',
  },
];

const DEFAULT_AXES = {
  will: ['робкий', 'осторожный', 'ровный', 'твёрдый', 'железный'],
  wits: ['простодушный', 'практичный', 'острый', 'блестящий', 'изворотливый'],
  mercy: ['жестокий', 'суровый', 'ровный', 'жалостливый', 'мягкий'],
};

const DEFAULT_LOOKS = {
  hairColor: ['чёрные', 'тёмно-русые', 'русые', 'светлые', 'рыжие', 'седые'],
  hairStyle: ['коротко стриженные', 'в косу', 'собранные', 'волной', 'брито с прядью'],
  build: ['сухощавый', 'крепкий', 'полный', 'жилистый', 'высокий'],
  skin: ['светлая', 'смуглая', 'загорелая', 'бледная'],
  mark: ['шрам на щеке', 'перстни', 'очки', 'родинка у губы', 'лёгкая хромота', 'ничего приметного'],
};

const DEFAULT_CLOTHING = {
  treasurer: ['тёмный кафтан с ключами у пояса', 'суконный сюртук счётчика'],
  marshal: ['военный плащ поверх кольчуги', 'кожаный доспех стражи'],
  keeper: ['простая мантия архива', 'длинный сюртук с чернильными пятнами'],
  chancellor: ['парадный кафтан с цепью', 'строгий городской сюртук'],
};

/** Каталог телосложения в мужском роде; для женщины согласуем. */
const FEMININE_BUILD = {
  сухощавый: 'сухощавая',
  крепкий: 'крепкая',
  полный: 'полная',
  жилистый: 'жилистая',
  высокий: 'высокая',
};

export function officerGender(officer) {
  if (officer?.gender === 'female' || officer?.gender === 'male') return officer.gender;
  const inferred = inferRulerGender(officer || {});
  return inferred === 'female' ? 'female' : 'male';
}

function pick(list, rng) {
  const arr = list || [];
  if (!arr.length) return '';
  return arr[Math.floor(rng() * arr.length)];
}

function rngFromId(id) {
  let h = 2166136261;
  for (const ch of String(id || 'officer')) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h >>> 0) % 1_000_000) / 1_000_000;
  };
}

export function officeCatalog(config) {
  const raw = config?.genesis?.officers?.offices;
  if (Array.isArray(raw) && raw.length) {
    return raw.map((o) => {
      const fallback = DEFAULT_OFFICES.find((d) => d.office === o.office);
      return {
        office: o.office,
        statId: o.statId,
        title: o.title,
        titleGen: o.titleGen || String(o.title || '').toLowerCase(),
        focus: String(o.focus || o.about || fallback?.focus || '').trim(),
        strategy: String(o.strategy || fallback?.strategy || '').trim(),
      };
    });
  }
  return DEFAULT_OFFICES.map((o) => ({ ...o }));
}

export function officeByStat(config, statId) {
  return officeCatalog(config).find((o) => o.statId === statId) || null;
}

export function officeById(config, office) {
  return officeCatalog(config).find((o) => o.office === office) || null;
}

export function officeStrategy(officerOrOffice, config = null) {
  const office = typeof officerOrOffice === 'string' ? officerOrOffice : officerOrOffice?.office;
  const def = officeById(config, office) || DEFAULT_OFFICES.find((d) => d.office === office);
  return def?.strategy || '';
}

export function axisLabels(config) {
  return config?.genesis?.officers?.axes || DEFAULT_AXES;
}

function lookCatalog(config) {
  return {
    ...DEFAULT_LOOKS,
    ...(config?.genesis?.officers?.looks || {}),
  };
}

export function rollOfficerAxes(rng = Math.random) {
  return {
    will: 1 + Math.floor(rng() * 5),
    wits: 1 + Math.floor(rng() * 5),
    mercy: 1 + Math.floor(rng() * 5),
  };
}

export function rollOfficerLook(office, config, rng = Math.random) {
  const looks = lookCatalog(config);
  const clothes = looks.clothing?.[office] || DEFAULT_CLOTHING[office] || ['городской кафтан'];
  return {
    ageYears: 28 + Math.floor(rng() * 33),
    hairColor: pick(looks.hairColor, rng),
    hairStyle: pick(looks.hairStyle, rng),
    build: pick(looks.build, rng),
    skin: pick(looks.skin, rng),
    clothing: pick(clothes, rng),
    mark: pick(looks.mark, rng),
  };
}

export function formatAxesForSpeech(axes, config) {
  const labels = axisLabels(config);
  const word = (key) => {
    const n = Math.max(1, Math.min(5, Math.round(Number(axes?.[key]) || 3)));
    return (labels[key] || DEFAULT_AXES[key])[n - 1];
  };
  return `${word('will')}, ${word('wits')}, ${word('mercy')}`;
}

export function formatLookForSpeech(look, gender = null) {
  if (!look) return '';
  const build =
    gender === 'female' && look.build ? FEMININE_BUILD[look.build] || look.build : look.build;
  return [
    build,
    look.skin ? `кожа ${look.skin}` : '',
    look.hairColor ? `волосы ${look.hairColor}, ${look.hairStyle}` : '',
    look.clothing,
    look.mark && look.mark !== 'ничего приметного' ? look.mark : '',
  ]
    .filter(Boolean)
    .join('; ');
}

/** Добрать недостающие черты вида; возраст и уже заданное не перебрасываем. */
export function ensureOfficerLook(officer, config, rng = Math.random) {
  if (!officer) return null;
  const rolled = rollOfficerLook(officer.office, config, rng);
  const prev = officer.look && typeof officer.look === 'object' ? officer.look : {};
  const kept = Object.fromEntries(
    Object.entries(prev).filter(([, v]) => v != null && String(v).trim() !== ''),
  );
  officer.look = { ...rolled, ...kept };
  const age = Number(kept.ageYears || officer.ageYears);
  if (Number.isFinite(age)) officer.look.ageYears = age;
  return officer.look;
}

export function listOfficers(domain) {
  return Array.isArray(domain?.officers) ? domain.officers : [];
}

export function findOfficer(domain, { officerId, office, statId } = {}) {
  const list = listOfficers(domain);
  if (officerId) return list.find((o) => o.id === officerId) || null;
  if (office) return list.find((o) => o.office === office) || null;
  if (statId) return list.find((o) => o.statId === statId) || null;
  return null;
}

export function freeOfficers(domain) {
  syncOfficerSlots(domain);
  return listOfficers(domain).filter((o) => !officerActiveProcess(domain, o));
}

export function pickRandomFreeOfficer(domain, rng = Math.random) {
  const free = freeOfficers(domain);
  if (!free.length) return null;
  return free[Math.floor(rng() * free.length)];
}

export function officerActiveProcess(domain, officer) {
  if (!officer?.processId) return null;
  const a = (domain?.state?.pendingActions || []).find((p) => String(p.id) === String(officer.processId));
  if (!a) return null;
  if (a.status && a.status !== 'active') return null;
  return a;
}

export function officerBusy(officer, domain = null) {
  if (domain) return Boolean(officerActiveProcess(domain, officer));
  return Boolean(officer?.processId);
}

export function officerBusyAgentMessage(officer, process) {
  const who = `${officer?.title || 'Сановник'} ${officer?.name || ''}`.trim();
  const duty = String(process?.summary || '').trim() || 'другое поручение';
  return (
    `ОТКАЗ: ${who} уже ведёт дело «${duty}» (id ${process?.id || '?'}). ` +
    'Если покровитель хочет именно этого сановника на новое — в речи назови текущее дело и спроси: ' +
    'приостановить (pause_process) или свернуть (revoke_process), и только потом declare_process. ' +
    'Не обещай новое, пока старое не снято. Не путай с недавно закрытым: законченное сановника не занимает.'
  );
}

/** Если сановников меньше каталога — добрать из lore (битый сейв не должен терять хранителя). */
export function ensureOfficersFromLore(domain, config = null) {
  if (!domain || typeof domain !== 'object') return domain;
  const catalog = officeCatalog(config);
  if (!catalog.length) return domain;
  domain.officers = Array.isArray(domain.officers) ? domain.officers : [];
  for (const o of domain.officers) {
    const def = catalog.find((d) => d.office === o.office);
    if (!def) continue;
    o.title = def.title;
    o.titleGen = def.titleGen;
  }
  const have = new Set(domain.officers.map((o) => o.office));
  const loreOfficers = (domain.lore || []).filter(
    (f) => f && (f.kind === 'officer' || (f.tags || []).includes('officer')),
  );
  const actions = domain.state?.pendingActions || [];
  for (const def of catalog) {
    if (have.has(def.office)) continue;
    const rec = loreOfficers.find((f) => f.office === def.office) || null;
    const fromProc = actions.find((a) => a.office === def.office && a.officerId) || null;
    domain.officers.push({
      id: String(fromProc?.officerId || rec?.officerId || newId('officer')),
      office: def.office,
      statId: def.statId,
      name: rec?.name || def.title,
      gender:
        rec?.gender === 'male' || rec?.gender === 'female'
          ? rec.gender
          : officerGender({ name: rec?.name, title: def.title }),
      title: def.title,
      nature: String(rec?.about || rec?.text || '').trim(),
      axes: { will: 3, wits: 3, mercy: 3 },
      look: Number.isFinite(Number(rec?.ageYears)) ? { ageYears: Number(rec.ageYears) } : {},
      portraitPath: domain.id ? `data/images/officers/${domain.id}_${def.office}.png` : null,
      portraitUrl: null,
      portraitKey: null,
      portraitBase64: null,
      processId: null,
    });
    const restored = domain.officers[domain.officers.length - 1];
    ensureOfficerLook(restored, config, rngFromId(restored.id));
  }
  syncOfficerSlots(domain);
  return domain;
}

export function stripOfficerPortraitPayload(domain) {
  if (domain?.imageUrl || domain?.imagePath) domain.imageBase64 = null;
  for (const o of domain?.officers || []) {
    if (o.portraitPath || o.portraitUrl) o.portraitBase64 = null;
  }
  return domain;
}

export function bindOfficerProcess(domain, officer, process) {
  if (!officer || !process) return;
  officer.processId = process.id;
  process.officerId = officer.id;
  process.office = officer.office;
}

export function releaseOfficerProcess(domain, process) {
  if (!process) return;
  const officer = findOfficer(domain, { officerId: process.officerId, office: process.office });
  if (officer && officer.processId === process.id) officer.processId = null;
}

export function syncOfficerSlots(domain) {
  if (!domain) return;
  const active = new Set(
    (domain.state?.pendingActions || [])
      .filter((a) => a && (a.status === 'active' || !a.status) && !a.slotless)
      .map((a) => a.id),
  );
  for (const o of listOfficers(domain)) {
    if (o.processId && !active.has(o.processId)) o.processId = null;
  }
  for (const a of domain.state?.pendingActions || []) {
    if (!a || a.slotless) continue;
    if (a.status === 'active' || !a.status) {
      const o = findOfficer(domain, { officerId: a.officerId, office: a.office });
      if (o) o.processId = a.id;
    }
  }
}

export function isOffPortfolio(officer, linkedStat) {
  if (!officer || !linkedStat) return false;
  return String(officer.statId) !== String(linkedStat);
}

export function formatOfficersForPrompt(domain, config) {
  ensureOfficersFromLore(domain, config);
  const list = listOfficers(domain);
  if (!list.length) return '(сановников ещё нет)';
  const lines = [
    'САНОВНИКИ ГОРОДА (жрец только передаёт им волю; игрок с сановниками не говорит; не герои историй):',
  ];
  for (const o of list) {
    const duty = officerActiveProcess(domain, o);
    const busy = duty ? `занят идущим делом «${duty.summary}»` : 'свободен';
    const strategy = officeStrategy(o, config);
    lines.push(
      `- ${o.title} ${o.name} (${o.gender === 'female' ? 'женщина' : o.gender === 'male' ? 'мужчина' : 'пол не задан'}, ${o.office}, стат ${o.statId}): ${o.nature || formatAxesForSpeech(o.axes, config)}. ` +
        (strategy ? `Как действует: ${strategy} ` : '') +
        `Сейчас ${busy}.`,
    );
  }
  const catalog = officeCatalog(config);
  for (const def of catalog) {
    if (def.focus) lines.push(`${def.title} — ${def.focus}.`);
    if (def.strategy) lines.push(`${def.title} всегда: ${def.strategy}`);
  }
  if (!catalog.some((d) => d.focus)) {
    for (const def of DEFAULT_OFFICES) {
      lines.push(`${def.title} — ${def.focus}.`);
      if (def.strategy) lines.push(`${def.title} всегда: ${def.strategy}`);
    }
  }
  lines.push(
    'Стройка, кровля, укрепление склона или ограды — казначей и мастера, не маршал.',
    'Маршал — порядок, война и преступления; стены стережёт, но не возводит.',
    'Если покровитель шлёт не того сановника — сначала поспорь и предупреди, что справится плохо.',
    '«Разберитесь сами» — не выбирай лучшего: движок даст случайного свободного.',
    'Занятость — только идущее дело. Недавно закрытое сановника не занимает.',
    'Если покровитель хочет занятого сановника на новое: назови текущее дело и предложи паузу или отмену, затем новое.',
  );
  return lines.join('\n');
}

export function formatOfficerIntroSpeech(domain) {
  const list = listOfficers(domain);
  if (!list.length) return null;
  const bits = list.map((o) => {
    const nature = String(o.nature || '')
      .trim()
      .replace(/\s+/g, ' ')
      .replace(/[.!?]+$/, '');
    const who = nature || o.office || o.title;
    return `${o.title} ${o.name} — ${who}`;
  });
  return `Пока назову тех, кто держит город: ${bits.join('; ')}.`;
}

export function formatOfficersCastHint(domain) {
  const list = listOfficers(domain);
  if (!list.length) return '';
  return [
    'САНОВНИКИ НЕ ГЕРОИ ИСТОРИЙ:',
    list.map((o) => `${o.title} ${o.name}`).join(', ') +
      ' — могут мелькнуть в отчёте («казначей велела…»), но не действующие лица тайны/распри.',
  ].join('\n');
}

function pendingActionsOf(board) {
  if (Array.isArray(board?.state?.pendingActions)) return board.state.pendingActions;
  if (Array.isArray(board?.processes)) return board.processes;
  return [];
}

function processLooksLive(process) {
  const status = process?.status;
  return !status || status === 'active' || status === 'paused';
}

/** Дело бита: сначала исход этого месяца, иначе живое на нити. */
export function findProcessForOfficerHint(domain, { plot, outcome, boards } = {}) {
  const homes = [domain, ...(boards || [])].filter(Boolean);
  const wantId = String(outcome?.processId || '');
  if (wantId) {
    for (const home of homes) {
      const process = pendingActionsOf(home).find((a) => String(a.id) === wantId);
      if (process) return { process, domain: home };
    }
  }
  const related = new Set((plot?.relatedProcessIds || []).map(String));
  if (related.size) {
    for (const home of homes) {
      const process = pendingActionsOf(home).find(
        (a) => related.has(String(a.id)) && processLooksLive(a),
      );
      if (process) return { process, domain: home };
    }
  }
  if (outcome?.officerId || outcome?.office) {
    return { process: outcome, domain };
  }
  return null;
}

/** Шпаргалка рассказчику: кто ведёт связанное дело — сан, имя, пол. */
export function formatProcessOfficerHint(domain, { plot, outcome, boards } = {}) {
  const found = findProcessForOfficerHint(domain, { plot, outcome, boards });
  if (!found?.process) return '';
  const homes = [found.domain, domain, ...(boards || [])].filter(Boolean);
  let officer = null;
  for (const home of homes) {
    officer = findOfficer(home, {
      officerId: found.process.officerId,
      office: found.process.office,
    });
    if (officer) break;
  }
  if (!officer?.name) return '';
  const who = officerGender(officer) === 'female' ? 'женщина' : 'мужчина';
  return [
    'САНОВНИК ПО ДЕЛУ (сан, имя, пол — для рода в речи; не герой истории, может мелькнуть в отчёте):',
    `${officer.title} ${officer.name} (${who}).`,
  ].join('\n');
}

/** Кратко для письма месяца: сан, имя, пол — чтобы род не угадывать. */
export function formatOfficersBriefForNews(domain) {
  const list = listOfficers(domain);
  if (!list.length) return '';
  const bits = list.map((o) => {
    const gender = officerGender(o);
    const who = gender === 'female' ? 'женщина' : 'мужчина';
    return `${o.title} ${o.name} (${who})`;
  });
  return [
    'САНОВНИКИ (сан, имя, пол — для рода в речи; не герои письма, могут мелькнуть в отчёте):',
    bits.join('; ') + '.',
  ].join('\n');
}

function fallbackNature(officer, config) {
  const axes = formatAxesForSpeech(officer.axes, config);
  return `${officer.title} ${officer.name} — ${axes}. Решения принимает в рамках своей должности.`;
}

export async function requestCityStrengths({ runtime, config, description, frozenConcept, log: parentLog } = {}) {
  const ids = (config?.stats || []).map((s) => s.id);
  const fallback = Object.fromEntries(ids.map((id) => [id, 5]));
  if (!runtime || !ids.length) return fallback;
  const log = (parentLog || getLogger()).child({ scope: 'city_strengths' });
  const draft = { scores: null };
  const props = {};
  for (const id of ids) {
    props[id] = { type: 'number', description: `Относительная сила 0–10 для ${id}` };
  }
  try {
    await runtime.run({
      agentId: 'cityStrengths',
      tools: [
        {
          name: 'submit_strengths',
          description: 'Относительные силы четырёх областей города, не абсолютные статы.',
          parameters: {
            type: 'object',
            additionalProperties: false,
            required: ids,
            properties: props,
          },
          handler: async (args) => {
            const scores = {};
            for (const id of ids) {
              const n = Number(args[id]);
              scores[id] = Number.isFinite(n) ? Math.max(0, Math.min(10, n)) : 5;
            }
            draft.scores = scores;
            return { ok: true };
          },
        },
      ],
      maxTurns: 3,
      toolChoice: { type: 'function', function: { name: 'submit_strengths' } },
      log,
      scene: 'city_strengths',
      userMessages: [
        {
          role: 'user',
          content: [
            'Оцени ОТНОСИТЕЛЬНЫЕ силы четырёх областей этого города по шкале 0–10.',
            'Это не итоговые статы и не проценты. Сравни области между собой.',
            'Равные оценки допустимы, если город ровный.',
            'Не выдумывай того, чего нет в тексте.',
            frozenConcept ? formatFrozenConceptForPrompt(frozenConcept) : '',
            '',
            'ОПИСАНИЕ ГОРОДА:',
            String(description || '').slice(0, 8000),
            '',
            `Вызови submit_strengths с полями: ${ids.join(', ')}.`,
          ]
            .filter(Boolean)
            .join('\n'),
        },
      ],
    });
  } catch (err) {
    log.warn('city_strengths.failed', { error: String(err?.message || err) });
  }
  if (!draft.scores) {
    log.warn('city_strengths.fallback');
    return fallback;
  }
  log.info('city_strengths.ok', { scores: draft.scores });
  return draft.scores;
}

export async function generateOfficers({ domain, world, config, runtime, log: parentLog, rng = Math.random } = {}) {
  const log = (parentLog || getLogger()).child({ scope: 'officers', domainId: domain?.id });
  const offices = officeCatalog(config);
  const officers = [];
  for (const def of offices) {
    const gender = rng() < 0.5 ? 'female' : 'male';
    const name = takeNameAtRandom(world, gender, config, rng);
    const axes = rollOfficerAxes(rng);
    const look = rollOfficerLook(def.office, config, rng);
    const officer = {
      id: newId('officer'),
      office: def.office,
      statId: def.statId,
      name,
      gender,
      title: def.title,
      nature: '',
      axes,
      look,
      portraitPath: null,
      portraitUrl: null,
      portraitKey: null,
      portraitBase64: null,
      processId: null,
    };
    stampPersonAge(officer, world, { ageYears: look.ageYears, rng });
    look.ageYears = officer.ageYears;
    officers.push(officer);
  }

  const natures = await requestOfficerNatures({ runtime, domain, officers, config, log });
  for (const o of officers) {
    o.nature = natures[o.office] || fallbackNature(o, config);
    domain.lore = domain.lore || [];
    domain.lore.push(
      createCharacterRecord({
        id: newId('lore'),
        name: o.name,
        role: o.title,
        about: o.nature,
        gender: o.gender,
        ageYears: o.look?.ageYears,
        tick: world?.tickIndex ?? null,
        gameDateLabel: world?.gameDate?.label || null,
        author: 'genesis',
        world,
      }),
    );
    const rec = domain.lore[domain.lore.length - 1];
    rec.tags = [...new Set([...(rec.tags || []), 'character', 'officer'])];
    rec.kind = 'officer';
    rec.office = o.office;
  }
  domain.officers = officers;
  log.info('officers.ready', {
    names: officers.map((o) => `${o.office}:${o.name}`),
  });
  return officers;
}

async function requestOfficerNatures({ runtime, domain, officers, config, log }) {
  const out = {};
  if (!runtime) {
    for (const o of officers) out[o.office] = fallbackNature(o, config);
    return out;
  }
  const draft = { rows: null };
  const offices = officers.map((o) => o.office);
  try {
    await runtime.run({
      agentId: 'officerNature',
      tools: [
        {
          name: 'submit_officer_natures',
          description: 'Характер каждого сановника: 1–2 предложения, не биография.',
          parameters: {
            type: 'object',
            additionalProperties: false,
            required: ['officers'],
            properties: {
              officers: {
                type: 'array',
                items: {
                  type: 'object',
                  required: ['office', 'nature'],
                  properties: {
                    office: { type: 'string', enum: offices },
                    nature: { type: 'string' },
                  },
                },
              },
            },
          },
          handler: async ({ officers: rows }) => {
            const map = {};
            for (const row of rows || []) {
              const text = String(row.nature || '').trim();
              if (offices.includes(row.office) && text.length >= 20) {
                map[row.office] = text.slice(0, 400);
              }
            }
            if (offices.some((id) => !map[id])) {
              return toolFail('thin', 'Нужен nature на каждого сановника, 1–2 предложения.');
            }
            draft.rows = map;
            return { ok: true };
          },
        },
      ],
      maxTurns: 3,
      toolChoice: { type: 'function', function: { name: 'submit_officer_natures' } },
      log,
      scene: 'officer_nature',
      domainId: domain?.id,
      userMessages: [
        {
          role: 'user',
          content: [
            `Город «${domain?.name}». Напиши характер четырёх сановников: как решают, чего не выносят, чем славятся.`,
            'По 1–2 предложения. Не биография, не диалоговая карточка. Не делай их героями историй.',
            '',
            ...officers.map(
              (o) =>
                `- ${o.office} / ${o.title} ${o.name} (${officerGender(o) === 'female' ? 'она' : 'он'}, ${o.look?.ageYears} лет). ` +
                `Оси: ${formatAxesForSpeech(o.axes, config)}. Вид: ${formatLookForSpeech(o.look, officerGender(o))}.`,
            ),
            '',
            String(domain?.description || '').slice(0, 2500),
            '',
            'Вызови submit_officer_natures для всех четырёх.',
          ].join('\n'),
        },
      ],
    });
  } catch (err) {
    log.warn('officer_nature.failed', { error: String(err?.message || err) });
  }
  if (!draft.rows) {
    log.warn('officer_nature.fallback');
    for (const o of officers) out[o.office] = fallbackNature(o, config);
    return out;
  }
  log.info('officer_nature.ok', { preview: truncate(Object.values(draft.rows).join(' | '), 300) });
  return draft.rows;
}
