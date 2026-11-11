/**
 * Правила слоёв v2. Импорт только вниз:
 *   clients → flows → agents → core
 * ports — интерфейсы, adapters — их реализации.
 */
const SDKS = '^(openai|@anthropic-ai/sdk|mongodb|node-telegram-bot-api|express)$';

module.exports = {
  forbidden: [
    {
      name: 'core-is-pure',
      comment: 'core не знает ни о чём, кроме себя: ни портов, ни агентов, ни IO.',
      severity: 'error',
      from: { path: '^src/core/' },
      to: { path: '^src/(?!core/)' },
    },
    {
      name: 'core-no-node-io',
      comment: 'core не трогает файлы, сеть и процесс.',
      severity: 'error',
      from: { path: '^src/core/' },
      to: { dependencyTypes: ['core'], path: '^(fs|node:fs|path|node:path|http|https|net|child_process|node:child_process|process|node:process)$' },
    },
    {
      name: 'ports-only-core',
      severity: 'error',
      from: { path: '^src/ports/' },
      to: { path: '^src/(?!ports/|core/)' },
    },
    {
      name: 'agents-down-only',
      comment: 'Агент видит только core и порты.',
      severity: 'error',
      from: { path: '^src/agents/' },
      to: { path: '^src/(flows|clients|adapters)/' },
    },
    {
      name: 'agents-isolated',
      comment: 'Агенты не импортируют друг друга. Общее — только agents/_shared.',
      severity: 'error',
      from: { path: '^src/agents/([^/_][^/]*)/' },
      to: { path: '^src/agents/(?!$1/|_shared/)[^/]+/' },
    },
    {
      name: 'flows-down-only',
      severity: 'error',
      from: { path: '^src/flows/' },
      to: { path: '^src/(clients|adapters)/' },
    },
    {
      name: 'adapters-implement-ports',
      severity: 'error',
      from: { path: '^src/adapters/' },
      to: { path: '^src/(agents|flows|clients)/' },
    },
    {
      name: 'sdk-only-in-adapters',
      comment: 'SDK провайдеров, Mongo, Telegram и HTTP-сервер — только в adapters/ и clients/.',
      severity: 'error',
      from: { path: '^src/(core|ports|agents|flows)/' },
      to: { path: SDKS },
    },
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsConfig: { fileName: 'tsconfig.json' },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: { exportsFields: ['exports'], conditionNames: ['import', 'require', 'node', 'default'] },
  },
};
