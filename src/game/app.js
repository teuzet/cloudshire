import { generateDomain, domainSummary } from './genesis.js';
import { chronicleEntries, newsChronicleEntries } from './models.js';
import { qualitativePopulation, qualitativeStatsBrief } from './stats.js';
import { askLoremaster } from './loremaster.js';
import { newId } from './ids.js';
import {
  emptyOnboardingDraft,
  validateCityName,
  suggestCityNames,
  listTagCatalog,
  formatPlayerBrief,
  formatTagCatalogForPrompt,
} from './onboarding.js';
import { getLogger, truncate } from '../log.js';

function characterTools(domain, storage, character, ctx) {
  const save = async () => storage.saveDomain(domain);

  return [
    {
      name: 'read_domain_brief',
      description:
        'Текущее состояние города: население, качественная картина благосостояния/веры/мощи и т.д., pending, процессы. Вызови, когда спрашивают «как дела / богаты ли / сыты ли / спокойно ли».',
      parameters: { type: 'object', properties: {} },
      handler: async () => ({
        ok: true,
        name: domain.name,
        status: domain.status,
        populationFeel: qualitativePopulation(domain.population || 0),
        conditionFeel: qualitativeStatsBrief(domain.stats || {}, ctx.config),
        guidance:
          'Отвечай СТРОГО в духе conditionFeel. Если благосостояние «скорее слабо / скудная жизнь» — не говори, что народ сыт и хлеба вдоволь. Числа и названия статов игроку не называй.',
        stateEvents: domain.state.events,
        stateModifiers: domain.state.modifiers || [],
        pendingActions: (domain.state.pendingActions || [])
          .filter((a) => a.status === 'active')
          .map((a) => ({
            summary: a.summary,
            detail: a.detail,
            monthsDone: a.monthsDone ?? 0,
            durationMonths: a.durationMonths ?? 1,
          })),
      }),
    },
    {
      name: 'consult_loremaster',
      description:
        'Спросить лормастера о фактах мира (имена, места, детали недавних событий, слухи…). Обязательно, когда покровитель просит подробности.',
      parameters: {
        type: 'object',
        required: ['questions'],
        properties: {
          questions: {
            type: 'array',
            items: { type: 'string' },
            description: '1–5 конкретных вопросов',
          },
        },
      },
      handler: async ({ questions }) => {
        const result = await askLoremaster({
          config: ctx.config,
          runtime: ctx.runtime,
          storage,
          domain,
          questions: questions || [],
          asker: `ruler:${character.name}`,
        });
        return {
          ok: true,
          answers: result.answers,
          summary: result.loreTextForAsker,
          newFactsCount: result.addedFacts.length,
          newFactTexts: result.addedFacts.map((f) => f.text),
          hint:
            'Перескажи СУТЬ своими словами и тоном правителя. Не копируй текст фактов/answers дословно. Не говори «неизвестно», если answers заполнены.',
        };
      },
    },
    {
      name: 'declare_action',
      description:
        'Обязательно для строек/проектов до ответа. Укажи durationMonths (реалистично: винодельня 3–6, мелочь 1).',
      parameters: {
        type: 'object',
        required: ['summary', 'detail', 'durationMonths'],
        properties: {
          summary: { type: 'string', description: 'Кратко: «Винодельня»…' },
          detail: { type: 'string', description: 'Что делать и зачем' },
          durationMonths: {
            type: 'number',
            description: 'Оценка длительности в игровых месяцах (1–12)',
          },
          onBehalfOf: {
            type: 'string',
            description: 'ruler | patron | people | other',
            default: 'patron',
          },
          characterNote: { type: 'string' },
        },
      },
      handler: async ({ summary, detail, durationMonths, onBehalfOf = 'patron', characterNote }) => {
        const duration = Math.max(1, Math.min(12, Math.round(Number(durationMonths) || 1)));
        const action = {
          id: newId('act'),
          summary,
          detail,
          durationMonths: duration,
          monthsDone: 0,
          onBehalfOf,
          characterId: character.id,
          characterName: character.name,
          characterNote: characterNote || null,
          status: 'active',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        domain.state.pendingActions.push(action);
        await save();
        return {
          ok: true,
          action,
          hint: `В речи: намерение на ~${duration} мес., ещё НЕ «уже строим». Только русский.`,
        };
      },
    },
    {
      name: 'update_action',
      description: 'Уточнить pending-действие',
      parameters: {
        type: 'object',
        required: ['actionId'],
        properties: {
          actionId: { type: 'string' },
          summary: { type: 'string' },
          detail: { type: 'string' },
        },
      },
      handler: async ({ actionId, summary, detail }) => {
        const action = domain.state.pendingActions.find((a) => a.id === actionId && a.status === 'active');
        if (!action) return { ok: false, error: 'Действие не найдено' };
        if (summary) action.summary = summary;
        if (detail) action.detail = detail;
        action.updatedAt = new Date().toISOString();
        await save();
        return { ok: true, action };
      },
    },
    {
      name: 'revoke_action',
      description: 'Отозвать pending-действие',
      parameters: {
        type: 'object',
        required: ['actionId'],
        properties: {
          actionId: { type: 'string' },
          reason: { type: 'string' },
        },
      },
      handler: async ({ actionId, reason }) => {
        const action = domain.state.pendingActions.find((a) => a.id === actionId && a.status === 'active');
        if (!action) return { ok: false, error: 'Действие не найдено' };
        action.status = 'revoked';
        action.revokeReason = reason || '';
        action.updatedAt = new Date().toISOString();
        await save();
        return { ok: true, action };
      },
    },
  ];
}

export class GameApp {
  constructor({ config, storage, runtime }) {
    this.config = config;
    this.storage = storage;
    this.runtime = runtime;
    this.outboundHandlers = new Set();
    this.generatingUsers = new Set();
  }

  onOutbound(handler) {
    this.outboundHandlers.add(handler);
    return () => this.outboundHandlers.delete(handler);
  }

  async emitOutbound(userId, message, meta = {}) {
    for (const handler of this.outboundHandlers) {
      await handler({ userId: String(userId), message, ...meta });
    }
  }

  async getStatus() {
    const world = await this.storage.getWorld();
    const domains = await this.storage.listDomains();
    return {
      storage: this.storage.driver,
      world: {
        id: world.id,
        name: world.name,
        tickIndex: world.tickIndex,
        gameDate: world.gameDate,
      },
      domainCount: domains.length,
      tickIntervalHours: this.config.tick.intervalHours,
      generatingCount: this.generatingUsers.size,
    };
  }

  isGenerating(userId) {
    return this.generatingUsers.has(String(userId));
  }

  async handleUserMessage(userId, text, { channel = 'web', bootstrap = false } = {}) {
    const log = getLogger().child({ userId: String(userId), channel, scope: 'chat' });
    const world = await this.storage.getWorld();
    const domain = await this.storage.getDomainForUser(userId, world.id);

    log.info('chat.inbound', {
      bootstrap,
      text: truncate(text, 400),
      hasDomain: Boolean(domain),
      domainId: domain?.id || null,
      generating: this.isGenerating(userId),
    });

    if (!domain) {
      if (this.isGenerating(userId)) {
        log.info('chat.busy_generating');
        return {
          reply:
            'Остров ещё создаётся — обычно минута-две. Правитель напишет сам, как будет готов. Подожди немного.',
          agent: 'onboarding',
          generating: true,
          domainId: null,
        };
      }
      return this.runOnboarding(userId, text, { channel, bootstrap, log });
    }

    return this.runRuler(domain, text, { channel, log });
  }

  startDomainGeneration(userId, { channel, forcedName, forcedTagChoices, playerBrief }) {
    const uid = String(userId);
    if (this.generatingUsers.has(uid)) {
      getLogger().warn('genesis.already_running', { userId: uid });
      return;
    }
    this.generatingUsers.add(uid);
    const log = getLogger().child({ userId: uid, scope: 'genesis' });

    const run = async () => {
      try {
        log.info('genesis.start', {
          forcedName: forcedName || null,
          tagChoices: forcedTagChoices || {},
          playerBrief: truncate(playerBrief, 500),
        });
        await this.emitOutbound(uid, 'Создаю твой летающий остров… Это займёт около минуты-двух.', {
          channel,
          agent: 'onboarding',
          kind: 'generating',
        });

        const domain = await generateDomain({
          config: this.config,
          runtime: this.runtime,
          storage: this.storage,
          ownerUserId: uid,
          forcedName: forcedName || null,
          forcedTagChoices: forcedTagChoices || {},
          playerBrief: playerBrief || null,
          log,
          onProgress: (msg) => log.info('genesis.progress', { message: msg }),
        });

        const intro = domain._greeting.startsWith(domain.characters[0].name)
          ? domain._greeting
          : `${domain.characters[0].name}: ${domain._greeting}`;

        await this.persistDialog(domain, 'assistant', intro);
        await this.emitOutbound(uid, intro, {
          channel,
          agent: 'ruler',
          domainId: domain.id,
          kind: 'game_start',
        });
        log.info('genesis.done', {
          domainId: domain.id,
          name: domain.name,
          greetingPreview: truncate(intro, 300),
        });
      } catch (err) {
        log.error('genesis.failed', {
          error: err.message,
          stack: err.stack,
        });
        await this.emitOutbound(
          uid,
          `Не удалось создать остров: ${err.message || err}. Можно поправить имя/теги и снова попросить старт.`,
          { channel, agent: 'onboarding', kind: 'generating_error' },
        );
      } finally {
        this.generatingUsers.delete(uid);
      }
    };

    setImmediate(() => {
      run().catch((err) =>
        log.error('genesis.unhandled', { error: err.message, stack: err.stack }),
      );
    });
  }

  async getOrCreateOnboardingBinding(userId) {
    const world = await this.storage.getWorld();
    let binding = await this.storage.getUserBinding(userId);
    if (!binding || binding.worldId !== world.id) {
      binding = {
        userId: String(userId),
        worldId: world.id,
        domainId: null,
        onboarding: emptyOnboardingDraft(),
        createdAt: new Date().toISOString(),
      };
    }
    if (!binding.onboarding) binding.onboarding = emptyOnboardingDraft();
    if (!binding.onboarding.playerBrief) {
      binding.onboarding.playerBrief = { city: '', ruler: '', freeform: '' };
    }
    return binding;
  }

  async runOnboarding(userId, text, { channel, bootstrap = false, log: parentLog } = {}) {
    const log = (parentLog || getLogger()).child({ scope: 'onboarding' });
    const binding = await this.getOrCreateOnboardingBinding(userId);
    const draft = binding.onboarding;
    let startedGenerating = false;

    log.info('onboarding.turn', {
      bootstrap,
      historyLen: (draft.messages || []).length,
      cityName: draft.cityName,
      approved: draft.cityNameApproved,
      tags: draft.tagChoices,
    });

    const saveDraft = async () => {
      binding.onboarding = draft;
      binding.updatedAt = new Date().toISOString();
      await this.storage.saveUserBinding(binding);
    };

    const tools = [
      {
        name: 'get_setup',
        description: 'Текущий черновик старта: теги, brief, имя, готовность',
        parameters: { type: 'object', properties: {} },
        handler: async () => ({
          ok: true,
          tagChoices: draft.tagChoices,
          playerBrief: draft.playerBrief,
          cityName: draft.cityName,
          cityNameApproved: draft.cityNameApproved,
          canStart: Boolean(draft.cityNameApproved && draft.cityName),
        }),
      },
      {
        name: 'set_player_brief',
        description:
          'Записать/обновить саммари пожеланий игрока для генезиса (город и правитель-связной). Можно вызывать несколько раз.',
        parameters: {
          type: 'object',
          properties: {
            city: {
              type: 'string',
              description: 'Пожелания к городу/острову: тон, проблемы, атмосфера…',
            },
            ruler: {
              type: 'string',
              description: 'Каким видит правителя-связного: характер, титул, слабости…',
            },
            freeform: {
              type: 'string',
              description: 'Прочие пожелания одной прозой',
            },
            replace: {
              type: 'boolean',
              description: 'Если true — заменить brief целиком; иначе дополнить непустые поля',
            },
          },
        },
        handler: async ({ city, ruler, freeform, replace = false }) => {
          if (!draft.playerBrief) {
            draft.playerBrief = { city: '', ruler: '', freeform: '' };
          }
          if (replace) {
            draft.playerBrief = {
              city: city || '',
              ruler: ruler || '',
              freeform: freeform || '',
            };
          } else {
            if (city) draft.playerBrief.city = city;
            if (ruler) draft.playerBrief.ruler = ruler;
            if (freeform) draft.playerBrief.freeform = freeform;
          }
          await saveDraft();
          return { ok: true, playerBrief: draft.playerBrief };
        },
      },
      {
        name: 'suggest_city_names',
        description: 'Предложить варианты имён города (обычно ближе к концу онбординга)',
        parameters: {
          type: 'object',
          properties: {
            count: { type: 'number', description: 'Сколько вариантов (3–7)' },
          },
        },
        handler: async ({ count = 5 }) => ({
          ok: true,
          suggestions: suggestCityNames(Math.max(3, Math.min(7, count || 5))),
        }),
      },
      {
        name: 'set_city_name',
        description: 'Проверить и зафиксировать имя города после согласия игрока (в конце онбординга)',
        parameters: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string' },
          },
        },
        handler: async ({ name }) => {
          const v = validateCityName(name);
          if (!v.ok) {
            draft.cityNameApproved = false;
            await saveDraft();
            return { ok: false, reason: v.reason };
          }
          draft.cityName = v.name;
          draft.cityNameApproved = true;
          await saveDraft();
          return { ok: true, cityName: v.name };
        },
      },
      {
        name: 'list_tag_groups',
        description: 'Показать группы характеристик острова и варианты (климат, уклад…)',
        parameters: { type: 'object', properties: {} },
        handler: async () => ({
          ok: true,
          groups: listTagCatalog(this.config),
          chosen: draft.tagChoices,
        }),
      },
      {
        name: 'set_tag_choices',
        description:
          'Задать сразу несколько тегов из РЕАЛЬНОГО каталога (после свободного пожелания игрока). Остальное — random.',
        parameters: {
          type: 'object',
          required: ['choices'],
          properties: {
            choices: {
              type: 'array',
              items: {
                type: 'object',
                required: ['groupId', 'tagId'],
                properties: {
                  groupId: { type: 'string' },
                  tagId: { type: 'string' },
                },
              },
            },
          },
        },
        handler: async ({ choices }) => {
          const applied = [];
          const errors = [];
          for (const c of choices || []) {
            const group = (this.config.genesis.tagGroups || []).find((g) => g.id === c.groupId);
            if (!group) {
              errors.push(`unknown group ${c.groupId}`);
              continue;
            }
            const tag = group.tags.find((t) => t.id === c.tagId);
            if (!tag) {
              errors.push(`unknown tag ${c.tagId} in ${c.groupId}`);
              continue;
            }
            draft.tagChoices[c.groupId] = c.tagId;
            applied.push({ group: group.name, tag: tag.name });
          }
          await saveDraft();
          const total = (this.config.genesis.tagGroups || []).length;
          return {
            ok: errors.length === 0,
            applied,
            errors,
            chosen: draft.tagChoices,
            note: `${Object.keys(draft.tagChoices).length}/${total} групп задано; остальное random.`,
          };
        },
      },
      {
        name: 'set_tag_choice',
        description:
          'Выбрать один тег в группе из каталога. Остальные без выбора — случайные.',
        parameters: {
          type: 'object',
          required: ['groupId', 'tagId'],
          properties: {
            groupId: { type: 'string' },
            tagId: { type: 'string' },
          },
        },
        handler: async ({ groupId, tagId }) => {
          const group = (this.config.genesis.tagGroups || []).find((g) => g.id === groupId);
          if (!group) return { ok: false, error: 'Неизвестная группа' };
          const tag = group.tags.find((t) => t.id === tagId);
          if (!tag) return { ok: false, error: 'Неизвестный тег в группе' };
          draft.tagChoices[groupId] = tagId;
          await saveDraft();
          const totalGroups = (this.config.genesis.tagGroups || []).length;
          const chosenCount = Object.keys(draft.tagChoices).length;
          return {
            ok: true,
            group: group.name,
            tag: tag.name,
            chosen: draft.tagChoices,
            note: `Выбрано ${chosenCount} из ${totalGroups} групп; остальные будут случайными.`,
          };
        },
      },
      {
        name: 'clear_tag_choice',
        description: 'Сбросить ручной выбор тега в группе — снова случайный',
        parameters: {
          type: 'object',
          required: ['groupId'],
          properties: { groupId: { type: 'string' } },
        },
        handler: async ({ groupId }) => {
          delete draft.tagChoices[groupId];
          await saveDraft();
          return { ok: true, chosen: draft.tagChoices };
        },
      },
      {
        name: 'start_new_game',
        description:
          'Запуск генерации. Нужно утверждённое имя. Невыбранные теги — случайные. Brief уходит в генезис.',
        parameters: { type: 'object', properties: {} },
        handler: async () => {
          const world = await this.storage.getWorld();
          const existing = await this.storage.getDomainForUser(userId, world.id);
          if (existing) {
            return { ok: false, error: 'У игрока уже есть домен в этом сезоне' };
          }
          if (!draft.cityNameApproved || !draft.cityName) {
            return {
              ok: false,
              error: 'Сначала утверди имя города через set_city_name (с согласия игрока).',
            };
          }
          if (this.isGenerating(userId)) {
            return { ok: true, status: 'generating' };
          }
          this.startDomainGeneration(userId, {
            channel,
            forcedName: draft.cityName,
            forcedTagChoices: { ...draft.tagChoices },
            playerBrief: { ...(draft.playerBrief || {}) },
          });
          startedGenerating = true;
          const forced = Object.keys(draft.tagChoices).length;
          const total = (this.config.genesis.tagGroups || []).length;
          return {
            ok: true,
            status: 'generating',
            cityName: draft.cityName,
            tagsForced: forced,
            tagsRandom: Math.max(0, total - forced),
            briefPreview: formatPlayerBrief(draft.playerBrief),
          };
        },
      },
    ];

    const history = (draft.messages || []).slice(-16).map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content,
    }));

    const isFirst = history.length === 0;
    const userContent = bootstrap || !String(text || '').trim()
      ? '[Игрок только что открыл чат. Это первый контакт.]'
      : text;

    const extraSystem = [
      'КАТАЛОГ ТЕГОВ (единственный допустимый; не выдумывай другие группы):',
      formatTagCatalogForPrompt(this.config),
      '',
      isFirst
        ? 'ПЕРВЫЙ КОНТАКТ: питч — игрок БОЖЕСТВО-покровитель, правитель будет НПС. Предложи описать характер острова свободно или пропустить теги.'
        : [
            `Черновик: теги=${JSON.stringify(draft.tagChoices)};`,
            `brief=${JSON.stringify(draft.playerBrief || {})};`,
            `имя=${draft.cityName || '—'} approved=${draft.cityNameApproved}`,
          ].join(' '),
    ].join('\n');
    const result = await this.runtime.run({
      agentId: 'onboarding',
      userMessages: [...history, { role: 'user', content: userContent }],
      tools,
      extraSystem,
      log,
    });

    let reply = result.text;
    if (startedGenerating && !String(reply || '').trim()) {
      reply = `Отлично. Поднимаю остров «${draft.cityName}» — обычно минута-две. Правитель напишет сам.`;
    }

    draft.messages = draft.messages || [];
    if (!bootstrap || String(text || '').trim()) {
      draft.messages.push({ role: 'user', content: text || userContent, at: new Date().toISOString() });
    }
    draft.messages.push({ role: 'assistant', content: reply, at: new Date().toISOString() });
    if (draft.messages.length > 40) draft.messages = draft.messages.slice(-30);
    draft.pitched = true;
    await saveDraft();

    log.info('onboarding.reply', {
      generating: startedGenerating || this.isGenerating(userId),
      replyPreview: truncate(reply, 400),
      tools: (result.toolTrace || []).map((t) => ({
        name: t.name,
        ok: t.result?.ok !== false,
        error: t.result?.error || t.result?.reason,
      })),
      setup: {
        cityName: draft.cityName,
        cityNameApproved: draft.cityNameApproved,
        tagChoices: draft.tagChoices,
      },
    });

    return {
      reply,
      domainId: null,
      agent: 'onboarding',
      created: false,
      generating: startedGenerating || this.isGenerating(userId),
      setup: {
        cityName: draft.cityName,
        cityNameApproved: draft.cityNameApproved,
        tagChoices: draft.tagChoices,
        playerBrief: draft.playerBrief,
      },
      toolTrace: result.toolTrace,
    };
  }

  async runRuler(domain, text, { channel, log: parentLog }) {
    const log = (parentLog || getLogger()).child({
      scope: 'ruler',
      domainId: domain.id,
      domainName: domain.name,
    });
    log.info('ruler.turn', { text: truncate(text, 400) });
    const character = domain.characters[0];
    const history = (character.dialogHistory || []).slice(-20).map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content,
    }));

    const conditionFeel = qualitativeStatsBrief(domain.stats || {}, this.config);
    const extraSystem = [
      `Ты ${character.name}, ${character.title || 'правитель'} города «${domain.name}».`,
      character.description,
      this.config.world.cosmology || '',
      'ОБСТОЯТЕЛЬСТВА ГОРОДА СЕЙЧАС (внутренняя правда; числа игроку не называй):',
      `Население: ${qualitativePopulation(domain.population || 0)}`,
      conditionFeel,
      'На вопросы о сытости, богатстве, вере, порядке, силе, знаниях опирайся на эти ориентиры.',
      'Пример: благосостояние «скорее слабо / скудная жизнь» → люди едва сводят концы, запасы тонкие; не «сыты и хватает».',
      'Форма: 1–3 абзаца прозы. Без списков, markdown, английских слов, сервисных «чем помочь».',
      'Стройки/проекты: сначала declare_action с durationMonths, потом: намерение на N месяцев — НЕ «уже строим».',
      'Факты лормастера перескажи своими словами.',
    ].join('\n');

    const result = await this.runtime.run({
      agentId: 'ruler',
      userMessages: [...history, { role: 'user', content: text }],
      tools: characterTools(domain, this.storage, character, {
        config: this.config,
        runtime: this.runtime,
      }),
      extraSystem,
      log,
    });

    const fresh = await this.storage.getDomain(domain.id);
    await this.persistDialog(fresh, 'user', text);
    await this.persistDialog(fresh, 'assistant', result.text);

    log.info('ruler.reply', {
      replyPreview: truncate(result.text, 400),
      tools: (result.toolTrace || []).map((t) => ({
        name: t.name,
        ok: t.result?.ok !== false,
      })),
    });

    return {
      reply: result.text,
      domainId: fresh.id,
      agent: 'ruler',
      toolTrace: result.toolTrace,
      channel,
    };
  }

  async narrateTickNews(domain, chronicleAdds, gameDate) {
    const character = domain.characters[0];
    const forNews = newsChronicleEntries(chronicleAdds);
    if (!character) {
      return forNews.map((c) => c.text).join('\n');
    }
    if (!forNews.length) {
      return `${character.name}: Покровитель, месяц прошёл тихо — рассказывать почти нечего.`;
    }

    const facts = forNews.map((c) => `- [${c.importance || 'event'}] ${c.text}`).join('\n');

    const result = await this.runtime.run({
      agentId: 'ruler',
      userMessages: [
        {
          role: 'user',
          content: [
            `Прошёл месяц (${gameDate.label}). Ниже сырая хроника для тебя (не факты лормастера).`,
            'Напиши покровителю письмо о месяце — вольный пересказ, НЕ дайджест.',
            'Выбери одну-две нити, что важнее всего; остальное можно опустить или мельком.',
            'Связная проза от первого лица, 1–3 коротких абзаца. Без списков, markdown, нумерации.',
            'Не копируй формулировки хроники. Не упоминай статы и механики.',
            '',
            facts,
          ].join('\n'),
        },
      ],
      tools: [],
      maxTurns: 1,
      extraSystem: [
        `Ты ${character.name}, ${character.title || 'правитель'} города «${domain.name}».`,
        character.description,
        'Ты пишешь покровителю новости месяца живой речью, как человек, а не сводку событий.',
      ].join('\n'),
    });

    return result.text || 'Покровитель, за месяц многое сдвинулось.';
  }

  async persistDialog(domain, role, content) {
    const character = domain.characters[0];
    if (!character) return;
    character.dialogHistory = character.dialogHistory || [];
    character.dialogHistory.push({
      role,
      content,
      at: new Date().toISOString(),
    });
    if (character.dialogHistory.length > 200) {
      character.dialogHistory = character.dialogHistory.slice(-150);
    }
    await this.storage.saveDomain(domain);
  }

  async inspectDomain(domainId) {
    return this.storage.getDomain(domainId);
  }

  async listDomains() {
    return this.storage.listDomains();
  }

  async getChronicle(domainId) {
    const domain = await this.storage.getDomain(domainId);
    if (!domain) return null;
    return {
      domainId: domain.id,
      name: domain.name,
      entries: chronicleEntries(domain.lore),
      facts: (domain.lore || []).filter((f) => (f.tags || []).includes('fact')),
    };
  }

  async wipeAll() {
    await this.storage.wipeAll();
    return this.getStatus();
  }
}
