import { generateDomain, domainSummary } from './genesis.js';
import { chronicleEntries, newsChronicleEntries } from './models.js';
import { qualitativePopulation } from './stats.js';
import { askLoremaster } from './loremaster.js';
import { newId } from './ids.js';

function characterTools(domain, storage, character, ctx) {
  const save = async () => storage.saveDomain(domain);

  return [
    {
      name: 'read_domain_brief',
      description: 'Кратко: имя, статус, ощущение населения, текущие процессы, pending, крючки',
      parameters: { type: 'object', properties: {} },
      handler: async () => ({
        ok: true,
        name: domain.name,
        status: domain.status,
        populationFeel: qualitativePopulation(domain.population || 0),
        stateEvents: domain.state.events,
        pendingActions: domain.state.pendingActions,
        milestones: (domain.milestones || []).map((m) => ({ text: m.text, status: m.status })),
        _internalStats: domain.stats,
        _internalPopulation: domain.population,
      }),
    },
    {
      name: 'consult_loremaster',
      description:
        'Спросить лормастера о фактах мира (источники воды, люди, места…). Обязательно перед утверждением нового факта.',
      parameters: {
        type: 'object',
        required: ['questions'],
        properties: {
          questions: {
            type: 'array',
            items: { type: 'string' },
            description: '1–5 вопросов',
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
          newFactsCount: result.addedFacts.length,
        };
      },
    },
    {
      name: 'declare_action',
      description: 'Объявить намерение на текущий месяц',
      parameters: {
        type: 'object',
        required: ['summary', 'detail'],
        properties: {
          summary: { type: 'string' },
          detail: { type: 'string' },
          onBehalfOf: {
            type: 'string',
            description: 'ruler | patron | people | other',
            default: 'ruler',
          },
          characterNote: { type: 'string' },
        },
      },
      handler: async ({ summary, detail, onBehalfOf = 'ruler', characterNote }) => {
        const action = {
          id: newId('act'),
          summary,
          detail,
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
        return { ok: true, action };
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

  async handleUserMessage(userId, text, { channel = 'web' } = {}) {
    const world = await this.storage.getWorld();
    const domain = await this.storage.getDomainForUser(userId, world.id);

    if (!domain) {
      if (this.isGenerating(userId)) {
        return {
          reply:
            'Остров ещё создаётся — обычно минута-две. Правитель напишет сам, как будет готов. Подожди немного.',
          agent: 'onboarding',
          generating: true,
          domainId: null,
        };
      }
      return this.runOnboarding(userId, text, { channel });
    }

    return this.runRuler(domain, text, { channel });
  }

  startDomainGeneration(userId, { channel }) {
    const uid = String(userId);
    if (this.generatingUsers.has(uid)) return;
    this.generatingUsers.add(uid);

    const run = async () => {
      try {
        console.log(`[genesis] start user=${uid}`);
        await this.emitOutbound(uid, 'Создаю твой летающий остров… Это займёт около минуты.', {
          channel,
          agent: 'onboarding',
          kind: 'generating',
        });

        const domain = await generateDomain({
          config: this.config,
          runtime: this.runtime,
          storage: this.storage,
          ownerUserId: uid,
          onProgress: (msg) => console.log(`[genesis] ${uid}: ${msg}`),
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
        console.log(`[genesis] done user=${uid} domain=${domain.id} name=${domain.name}`);
      } catch (err) {
        console.error(`[genesis] failed user=${uid}`, err);
        await this.emitOutbound(
          uid,
          `Не удалось создать остров: ${err.message || err}. Попробуй написать «начнём игру» ещё раз.`,
          { channel, agent: 'onboarding', kind: 'generating_error' },
        );
      } finally {
        this.generatingUsers.delete(uid);
      }
    };

    setImmediate(() => {
      run().catch((err) => console.error('[genesis] unhandled', err));
    });
  }

  async runOnboarding(userId, text, { channel }) {
    let startedGenerating = false;

    const tools = [
      {
        name: 'check_player',
        description: 'Проверить, есть ли у игрока домен или идёт генерация',
        parameters: { type: 'object', properties: {} },
        handler: async () => {
          const world = await this.storage.getWorld();
          const domain = await this.storage.getDomainForUser(userId, world.id);
          return {
            ok: true,
            hasDomain: Boolean(domain),
            generating: this.isGenerating(userId),
            worldName: world.name,
            domain: domain ? domainSummary(domain) : null,
          };
        },
      },
      {
        name: 'start_new_game',
        description: 'Запустить создание нового домена (в фоне). Вернёт status=generating.',
        parameters: { type: 'object', properties: {} },
        handler: async () => {
          const world = await this.storage.getWorld();
          const existing = await this.storage.getDomainForUser(userId, world.id);
          if (existing) {
            return { ok: false, error: 'У игрока уже есть домен в этом сезоне' };
          }
          if (this.isGenerating(userId)) {
            return { ok: true, status: 'generating' };
          }
          this.startDomainGeneration(userId, { channel });
          startedGenerating = true;
          return { ok: true, status: 'generating' };
        },
      },
    ];

    const result = await this.runtime.run({
      agentId: 'onboarding',
      userMessages: [{ role: 'user', content: text }],
      tools,
    });

    let reply = result.text;
    if (startedGenerating && !String(reply || '').trim()) {
      reply =
        'Хорошо. Поднимаю остров из облаков — обычно минута-две. Правитель напишет тебе сам, когда город будет готов.';
    }

    return {
      reply,
      domainId: null,
      agent: 'onboarding',
      created: false,
      generating: startedGenerating || this.isGenerating(userId),
      toolTrace: result.toolTrace,
    };
  }

  async runRuler(domain, text, { channel }) {
    const character = domain.characters[0];
    const history = (character.dialogHistory || []).slice(-20).map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content,
    }));

    const extraSystem = [
      `Ты ${character.name}, ${character.title || 'правитель'} города «${domain.name}».`,
      character.description,
      this.config.world.cosmology || '',
      'Не вставляй в ответ длинное описание города и не используй списки.',
    ].join('\n');

    const result = await this.runtime.run({
      agentId: 'ruler',
      userMessages: [...history, { role: 'user', content: text }],
      tools: characterTools(domain, this.storage, character, {
        config: this.config,
        runtime: this.runtime,
      }),
      extraSystem,
    });

    const fresh = await this.storage.getDomain(domain.id);
    await this.persistDialog(fresh, 'user', text);
    await this.persistDialog(fresh, 'assistant', result.text);

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
            `Прошёл месяц (${gameDate.label}). Ниже сухая хроника (не факты лормастера).`,
            'Перескажи покровителю живой речью, без списков и markdown. От первого лица.',
            'Не копируй формулировки дословно. Не упоминай статы и механики.',
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
        'Ты сам пишешь покровителю новости месяца.',
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
