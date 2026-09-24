import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  appendCityAgentTranscript,
  cityAgentLogPath,
  cityLogDomainIds,
  formatCityAgentTranscript,
  formatCityLogStamp,
  initCityAgentLogRecording,
  shouldLogLiveCityAgent,
} from '../src/game/cityAgentLog.js';
import { AgentRuntime } from '../src/agents/runtime.js';

function packedPrompt() {
  return {
    agentId: 'chronicler',
    provider: 'openai',
    model: 'gpt-4o-mini',
    systemContent: 'Ты хронист города. Пиши сухую запись.',
    messages: [
      { role: 'system', content: 'Ты хронист города. Пиши сухую запись.' },
      { role: 'user', content: 'Случилось: смола на восточном откосе ожила.' },
    ],
    tools: [
      {
        type: 'function',
        function: { name: 'submit_chronicle', parameters: { type: 'object' } },
      },
    ],
  };
}

test('живой город логируется, онбординг и генезис — нет', () => {
  const config = { logging: { file: true, dir: '/tmp', cityAgent: true } };
  assert.equal(
    shouldLogLiveCityAgent({ config, domainId: 'domain_1', agentId: 'chronicler', scene: 'chronicle_deed' }),
    true,
  );
  assert.equal(
    shouldLogLiveCityAgent({
      config,
      domainId: 'domain_1',
      agentId: 'freeformBrainstorm',
      scene: 'freeform_brainstorm_seed',
    }),
    true,
  );
  assert.equal(
    shouldLogLiveCityAgent({
      config,
      domainId: 'domain_1',
      agentId: 'freeformBrainstormJudge',
      scene: 'freeform_brainstorm_judge',
    }),
    true,
  );
  assert.equal(
    shouldLogLiveCityAgent({
      config,
      domainId: 'domain_1',
      agentId: 'freeformEndings',
      scene: 'freeform_endings',
    }),
    true,
  );
  assert.equal(
    shouldLogLiveCityAgent({
      config,
      domainId: 'domain_1',
      agentId: 'freeformUrgency',
      scene: 'freeform_urgency',
    }),
    true,
  );
  assert.equal(
    shouldLogLiveCityAgent({ config, domainId: null, agentId: 'chronicler', scene: 'chronicle_deed' }),
    false,
  );
  assert.equal(
    shouldLogLiveCityAgent({ config, domainId: 'domain_1', agentId: 'onboarding', scene: 'onboarding' }),
    false,
  );
  assert.equal(
    shouldLogLiveCityAgent({ config, domainId: 'domain_1', agentId: 'genesis', scene: 'genesis_core' }),
    false,
  );
  assert.equal(
    shouldLogLiveCityAgent({ config, domainId: 'domain_1', agentId: 'cityBrief', scene: 'city_brief' }),
    false,
  );
  assert.equal(
    shouldLogLiveCityAgent({ config, domainId: 'domain_1', agentId: 'cityGenesisRewrite', scene: 'city_genesis_rewrite' }),
    true,
  );
  assert.equal(
    shouldLogLiveCityAgent({
      config: { logging: { file: false, cityAgent: true } },
      domainId: 'domain_1',
      agentId: 'ruler',
      scene: 'ruler',
    }),
    false,
  );
});

test('штамп читаемый, не ISO с T и Z', () => {
  const stamp = formatCityLogStamp(new Date('2026-09-17T01:15:32.903+02:00'));
  assert.match(stamp, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/);
  assert.doesNotMatch(stamp, /T|Z/);
});

test('транскрипт держит полный промпт, вызов tool и результат подряд', () => {
  const text = formatCityAgentTranscript({
    startedAt: new Date('2026-09-17T01:15:32.903+02:00'),
    domainId: 'domain_test',
    domainName: 'Аллерия',
    agentId: 'chronicler',
    scene: 'chronicle_deed',
    model: 'gpt-4o-mini',
    provider: 'openai',
    runId: 'abc123',
    packed: packedPrompt(),
    events: [
      {
        type: 'llm',
        turn: 1,
        at: new Date('2026-09-17T01:15:33.100+02:00'),
        content: '',
        toolCalls: [{ name: 'submit_chronicle', args: { entry: 'Смола на откосе ожила и пошла к цистернам.' } }],
      },
      {
        type: 'tool',
        turn: 1,
        at: new Date('2026-09-17T01:15:33.180+02:00'),
        name: 'submit_chronicle',
        args: { entry: 'Смола на откосе ожила и пошла к цистернам.' },
        result: { ok: true },
      },
    ],
    turns: 1,
    ms: 420,
    toolsUsed: ['submit_chronicle'],
  });
  assert.match(text, /chronicler/);
  assert.match(text, /Аллерия/);
  assert.match(text, /=== SYSTEM ===/);
  assert.match(text, /Ты хронист города/);
  assert.match(text, /смола на восточном откосе ожила/);
  assert.match(text, /вызов submit_chronicle/);
  assert.match(text, /пошла к цистернам/);
  assert.match(text, /"ok": true/);
  assert.match(text, /ИТОГ/);
  assert.doesNotMatch(text, /…\[\+/);
});

test('пара городов даёт два id, запись идёт в оба файла', async () => {
  assert.deepEqual(cityLogDomainIds('domain_a+domain_b'), ['domain_a', 'domain_b']);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cloudshire-city-log-'));
  const config = { logging: { file: true, dir, cityAgent: true } };
  try {
    const paths = await appendCityAgentTranscript({
      config,
      domainId: 'domain_a+domain_b',
      domainName: 'Пара',
      agentId: 'statJudge',
      scene: 'stat_judge_pair',
      worldId: 'world_test',
      packed: packedPrompt(),
      events: [
        {
          type: 'tool',
          turn: 1,
          name: 'submit_stats',
          args: { food: -2 },
          result: { ok: true },
        },
      ],
      turns: 1,
      ms: 10,
    });
    assert.equal(paths.length, 2);
    const a = await readFile(cityAgentLogPath(config, { domainId: 'domain_a', worldId: 'world_test' }), 'utf8');
    const b = await readFile(cityAgentLogPath(config, { domainId: 'domain_b', worldId: 'world_test' }), 'utf8');
    assert.match(a, /stat_judge_pair/);
    assert.match(b, /submit_stats/);
    assert.match(a, /# Лог агентов живого города/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('runtime пишет лог живого города и молчит на генезисе', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cloudshire-city-log-rt-'));
  const config = {
    logging: { file: true, dir, cityAgent: true },
    llm: { defaultProvider: 'openai', openai: { apiKeyEnv: 'OPENAI_API_KEY' } },
    agents: {
      chronicler: { provider: 'openai', model: 'gpt-4o-mini', instructions: 'Пиши хронику.' },
      genesis: { provider: 'openai', model: 'gpt-4o-mini', instructions: 'Собери город.' },
    },
  };
  const runtime = new AgentRuntime(config);
  runtime.getProvider = () => ({
    defaultModel: 'gpt-4o-mini',
    async chat({ messages }) {
      const last = messages[messages.length - 1];
      if (last?.role === 'tool') {
        return { message: { content: 'готово', tool_calls: [] }, usage: {} };
      }
      return {
        message: {
          content: '',
          tool_calls: [
            {
              id: 'c1',
              function: { name: 'submit_chronicle', arguments: JSON.stringify({ entry: 'Полная запись без обрезки.' }) },
            },
          ],
        },
        usage: {},
      };
    },
  });
  try {
    await runtime.run({
      agentId: 'chronicler',
      domainId: 'domain_live',
      scene: 'chronicle_deed',
      userMessages: [{ role: 'user', content: 'Опиши случившееся в цистернах.' }],
      tools: [
        {
          name: 'submit_chronicle',
          description: 'запись',
          parameters: { type: 'object', properties: { entry: { type: 'string' } } },
          handler: async () => ({ ok: true }),
        },
      ],
      log: { context: { domainName: 'Аллерия' }, child() { return this; }, info() {}, warn() {}, error() {}, debug() {} },
    });
    const filePath = cityAgentLogPath(config, { domainId: 'domain_live' });
    const saved = await readFile(filePath, 'utf8');
    assert.match(saved, /Аллерия/);
    assert.match(saved, /Опиши случившееся в цистернах/);
    assert.match(saved, /Полная запись без обрезки/);
    assert.match(saved, /вызов submit_chronicle/);
    assert.match(saved, /"ok": true/);

    await runtime.run({
      agentId: 'genesis',
      domainId: 'domain_live',
      scene: 'genesis_core',
      userMessages: [{ role: 'user', content: 'Собери ядро города. Этого в логе быть не должно.' }],
    });
    const after = await readFile(filePath, 'utf8');
    assert.doesNotMatch(after, /этого в логе быть не должно/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('mongo хранит каждый прогон отдельным документом, включая генезис', async () => {
  const docs = [];
  initCityAgentLogRecording({
    appendAgentLog: async (doc) => {
      docs.push(doc);
    },
  });
  const config = { logging: { file: false, cityAgent: true } };
  try {
    await appendCityAgentTranscript({
      config,
      domainId: 'domain_a+domain_b',
      domainName: 'Пара',
      worldId: 'world_srv',
      agentId: 'genesis',
      scene: 'genesis_core',
      provider: 'openai',
      model: 'gpt-4o-mini',
      runId: 'run1',
      packed: packedPrompt(),
      events: [],
      turns: 1,
      ms: 12,
    });
    await appendCityAgentTranscript({
      config,
      domainId: null,
      agentId: 'onboarding',
      scene: 'onboarding',
      worldId: 'world_srv',
      packed: packedPrompt(),
      events: [],
    });
    assert.equal(docs.length, 2);
    assert.equal(docs[0].agentId, 'genesis');
    assert.deepEqual(docs[0].domainIds, ['domain_a', 'domain_b']);
    assert.equal(docs[0].worldId, 'world_srv');
    assert.match(docs[0].text, /Ты хронист города/);
    assert.equal(docs[1].agentId, 'onboarding');
    assert.equal(docs[1].domainId, null);
  } finally {
    initCityAgentLogRecording(null);
  }
});
