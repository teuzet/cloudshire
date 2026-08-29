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

test('mysteryStart, presentation и литературные судьи без reasoningEffort', () => {
  const config = loadConfig();
  assert.equal(config.agents.mysteryStart.reasoningEffort, undefined);
  assert.equal(config.agents.mysteryPresentation.reasoningEffort, undefined);
  assert.equal(config.agents.mysteryPresentationJudge.reasoningEffort, undefined);
  assert.equal(config.agents.suspenseJudge.reasoningEffort, undefined);
  assert.equal(config.agents.mysteryArchitect.reasoningEffort, undefined);
  assert.equal(config.agents.mysteryArchitectJudge.reasoningEffort, undefined);
  assert.equal(config.agents.mysteryArchitect.model, 'gpt-5.6-terra');
  assert.equal(config.agents.mysteryArchitectJudge.model, 'gpt-5.6-luna');
  assert.equal(config.agents.mysteryAnnotation.reasoningEffort, undefined);
  assert.equal(config.agents.mysteryAnnotation.model, 'claude-sonnet-4-6');
  assert.equal(config.agents.mysteryAnnotation.provider, 'anthropic');
  assert.equal(config.agents.mysteryAnnotationJudge.reasoningEffort, undefined);
  assert.equal(config.agents.mysteryAnnotationJudge.model, 'gpt-5.6-luna');
  assert.equal(config.agents.mysteryAnnotationJudge.provider, 'openai');
});
