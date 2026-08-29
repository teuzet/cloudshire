import { OpenAiProvider, LlmError } from './openai.js';
import { AnthropicProvider } from './anthropic.js';

export { LlmError };

export function createLlmProvider(config, providerName = 'openai') {
  const name = String(providerName || config?.llm?.defaultProvider || 'openai').toLowerCase();
  if (name === 'openai') return new OpenAiProvider(config);
  if (name === 'anthropic' || name === 'claude') return new AnthropicProvider(config);
  throw new Error(`Unknown LLM provider: ${providerName}`);
}

export {
  normalizeUsage,
  addUsage,
  estimateCostUsd,
  lookupPricing,
  measureRequestFootprint,
  initUsageRecording,
  getUsageFilePath,
  getCurrentWorldId,
  worldLogsDir,
} from './usage.js';
