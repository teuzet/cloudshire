import { newId } from './ids.js';
import {
  rollDomainStats,
  rollPopulation,
  pickTags,
  pickMilestones,
  formatStatsForPrompt,
  formatTagsForPrompt,
  isForbiddenDomainName,
} from './stats.js';
import {
  createCharacter,
  createDomainRecord,
  createLoreFact,
  assembleDescription,
} from './models.js';

function aspectDefs(config) {
  return config.genesis.aspects || [];
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function fallbackName() {
  const names = ['Ветроград', 'Острокрыл', 'Туманск', 'Крутолом', 'Яснояр', 'Шипоград', 'Небокрай'];
  return names[Math.floor(Math.random() * names.length)];
}

/**
 * Step 1: имя, правитель, факты, приветствие.
 */
async function generateCore({ config, runtime, stats, population, tags, milestones, onProgress }) {
  const loreMin = config.genesis.openingLoreCount?.min || 12;
  const draft = { submitted: null };

  const tools = [
    {
      name: 'submit_core',
      description: 'Ядро домена: имя, правитель, greeting, openingLore',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: [
          'domainName',
          'rulerName',
          'rulerTitle',
          'rulerDescription',
          'greeting',
          'openingLore',
        ],
        properties: {
          domainName: { type: 'string' },
          rulerName: { type: 'string' },
          rulerTitle: { type: 'string' },
          rulerDescription: { type: 'string' },
          greeting: { type: 'string' },
          openingLore: { type: 'array', items: { type: 'string' } },
        },
      },
      handler: async (args) => {
        if (isForbiddenDomainName(args.domainName)) {
          return { ok: false, error: 'Имя запрещено. Придумай другое фэнтезийное по-русски.' };
        }
        if ((args.openingLore || []).length < loreMin) {
          return { ok: false, error: `Нужно ≥ ${loreMin} openingLore` };
        }
        if (!String(args.greeting || '').trim() || String(args.greeting).length > 600) {
          return { ok: false, error: 'greeting: 2–4 коротких предложения' };
        }
        draft.submitted = args;
        return { ok: true };
      },
    },
  ];

  onProgress?.('Шаг 1/2: ядро города…');
  await runtime.run({
    agentId: 'genesis',
    userMessages: [
      {
        role: 'user',
        content: [
          'Создай ЯДРО нового города на летающем острове. Вызови submit_core.',
          config.world.cosmology || '',
          `Население (внутреннее): ${population}`,
          'Имя — фэнтезийное по-русски, не Cloudshire.',
          'Сезонные цели (майлстоуны) уже заданы — отрази их намёками в характере города и openingLore, но не копируй тексты целей дословно списком.',
          '',
          'Статы (не называй в текстах):',
          formatStatsForPrompt(stats, config),
          '',
          'Теги:',
          formatTagsForPrompt(tags),
          '',
          'Майлстоуны сезона:',
          milestones.map((m) => `- ${m.text} (${m.points} очков)`).join('\n'),
        ].join('\n'),
      },
    ],
    tools,
    maxTurns: 4,
    toolChoice: { type: 'function', function: { name: 'submit_core' } },
  });

  if (!draft.submitted) {
    throw new Error('genesis core: модель не вернула submit_core');
  }
  return draft.submitted;
}

/**
 * Step 2: аспекты пачками по 4.
 */
async function generateAspectBatch({
  config,
  runtime,
  core,
  stats,
  tags,
  population,
  milestones,
  batch,
  already,
  onProgress,
}) {
  const minChars = config.genesis.aspectMinChars || 280;
  const draft = { texts: null };

  const props = {};
  for (const def of batch) {
    props[def.id] = {
      type: 'string',
      description: `${def.title}. ${def.hint}. Минимум ${minChars} символов, 2–4 абзаца. Уникально, не копируй другие разделы.`,
    };
  }

  const tools = [
    {
      name: 'submit_aspects',
      description: 'Заполнить очередную пачку аспектов описания города',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: batch.map((b) => b.id),
        properties: props,
      },
      handler: async (args) => {
        const weak = [];
        for (const def of batch) {
          const text = String(args[def.id] || '').trim();
          if (text.length < minChars) {
            weak.push({ id: def.id, title: def.title, length: text.length, need: minChars });
          }
        }
        const norms = batch.map((d) => String(args[d.id] || '').replace(/\s+/g, ' ').slice(0, 120));
        const dupes = norms.filter((t, i) => t && norms.indexOf(t) !== i);
        if (weak.length || dupes.length) {
          return {
            ok: false,
            error: 'Слишком коротко или разделы повторяют друг друга. Перепиши.',
            weak,
          };
        }
        draft.texts = args;
        return { ok: true };
      },
    },
  ];

  const titles = batch.map((b) => `- ${b.id} «${b.title}»: ${b.hint}`).join('\n');
  const known = Object.entries(already)
    .slice(0, 3)
    .map(([id, text]) => `### уже есть ${id}\n${String(text).slice(0, 200)}…`)
    .join('\n');

  onProgress?.(`Аспекты: ${batch.map((b) => b.title).join(', ')}`);

  await runtime.run({
    agentId: 'genesis',
    userMessages: [
      {
        role: 'user',
        content: [
          `Город «${core.domainName}», правитель ${core.rulerName}.`,
          config.world.cosmology || '',
          `Население ~${population}. Теги: ${formatTagsForPrompt(tags)}`,
          'Статы (скрыто):',
          formatStatsForPrompt(stats, config),
          '',
          'Майлстоуны сезона (отражай в лоре намёками, не списками целей):',
          (milestones || []).map((m) => `- ${m.text}`).join('\n'),
          '',
          known ? `Контекст уже написанных разделов (не копируй):\n${known}` : '',
          '',
          'Заполни ТОЛЬКО эти аспекты через submit_aspects. Каждый уникален и конкретен:',
          titles,
        ].join('\n'),
      },
    ],
    tools,
    maxTurns: 5,
    toolChoice: { type: 'function', function: { name: 'submit_aspects' } },
  });

  if (!draft.texts) {
    throw new Error(`genesis aspects failed: ${batch.map((b) => b.id).join(',')}`);
  }
  return draft.texts;
}

export async function generateDomain({ config, runtime, storage, ownerUserId, onProgress }) {
  const world = await storage.getWorld();
  const stats = rollDomainStats(config);
  const population = rollPopulation(config);
  const tags = pickTags(config);
  const milestones = pickMilestones(config);
  const aspectsConfig = aspectDefs(config);
  const batchSize = config.genesis.aspectBatchSize || 4;

  const core = await generateCore({
    config,
    runtime,
    stats,
    population,
    tags,
    milestones,
    onProgress,
  });

  const aspects = {};
  const batches = chunk(aspectsConfig, batchSize);
  onProgress?.(`Шаг 2/2: описание (${batches.length} пачек)…`);

  for (const batch of batches) {
    const part = await generateAspectBatch({
      config,
      runtime,
      core,
      stats,
      tags,
      population,
      milestones,
      batch,
      already: aspects,
      onProgress,
    });
    Object.assign(aspects, part);
  }

  // Sanity: no global identical paste
  const samples = Object.values(aspects).map((t) => String(t).replace(/\s+/g, ' ').slice(0, 80));
  const unique = new Set(samples);
  if (unique.size < Math.min(5, samples.length)) {
    throw new Error('genesis produced too many identical aspect texts');
  }

  const description = assembleDescription(aspects, aspectsConfig);

  const character = createCharacter({
    id: newId('char'),
    name: core.rulerName,
    title: core.rulerTitle || 'Правитель',
    description: core.rulerDescription,
    role: 'ruler',
  });

  const lore = (core.openingLore || []).map((text) =>
    createLoreFact({
      id: newId('lore'),
      text,
      tags: ['genesis', 'fact'],
      gameDateLabel: world.gameDate.label,
      tick: world.tickIndex,
      author: 'genesis',
    }),
  );

  const domainName = isForbiddenDomainName(core.domainName) ? fallbackName() : core.domainName;

  lore.unshift(
    createLoreFact({
      id: newId('lore'),
      text: `Город «${domainName}» принял покровительство. Население около ${population}.`,
      tags: ['genesis', 'meta', 'fact'],
      gameDateLabel: world.gameDate.label,
      tick: world.tickIndex,
      author: 'system',
    }),
  );

  const domain = createDomainRecord({
    id: newId('domain'),
    worldId: world.id,
    ownerUserId: String(ownerUserId),
    name: domainName,
    description,
    aspects,
    milestones,
    stats,
    population,
    character,
    lore,
  });

  await storage.saveDomain(domain);
  await storage.saveUserBinding({
    userId: String(ownerUserId),
    worldId: world.id,
    domainId: domain.id,
    createdAt: new Date().toISOString(),
  });

  domain._greeting =
    core.greeting ||
    `${character.name}: Покровитель, я слышу тебя. Город «${domain.name}» ждёт твоей воли.`;

  onProgress?.(`Остров «${domain.name}» готов.`);
  return domain;
}

export function domainSummary(domain) {
  return {
    id: domain.id,
    name: domain.name,
    status: domain.status,
    ownerUserId: domain.ownerUserId,
    population: domain.population,
    stats: domain.stats,
    milestones: domain.milestones || [],
    character: domain.characters[0]
      ? {
          id: domain.characters[0].id,
          name: domain.characters[0].name,
          title: domain.characters[0].title,
          role: domain.characters[0].role,
        }
      : null,
    pendingCount: (domain.state?.pendingActions || []).filter((a) => a.status === 'active').length,
    loreCount: domain.lore?.length || 0,
    chronicleCount: (domain.lore || []).filter((f) => (f.tags || []).includes('chronicle')).length,
  };
}
