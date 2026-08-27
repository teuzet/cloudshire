import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { resolveReasoningEffort } from '../src/llm/openai.js';

test('gpt-5 с тулами без настройки остаётся none', () => {
  assert.equal(
    resolveReasoningEffort({ model: 'gpt-5.6-terra', tools: [{}] }),
    'none',
  );
  assert.equal(resolveReasoningEffort({ model: 'gpt-4o-mini', tools: [{}] }), undefined);
});

test('явный reasoningEffort агента перекрывает дефолт', () => {
  assert.equal(
    resolveReasoningEffort({
      model: 'gpt-5.6-terra',
      tools: [{}],
      reasoningEffort: 'high',
    }),
    'high',
  );
  assert.equal(resolveReasoningEffort({ reasoningEffort: 'MEDIUM' }), 'medium');
  assert.equal(resolveReasoningEffort({ reasoningEffort: 'wat' }), undefined);
});

test('mysteryStart и mysteryPresentation без reasoningEffort', () => {
  const config = loadConfig();
  assert.equal(config.agents.mysteryStart.reasoningEffort, undefined);
  assert.equal(config.agents.mysteryPresentation.reasoningEffort, undefined);
});
