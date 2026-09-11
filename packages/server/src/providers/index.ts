import type { AppConfig } from '../config.js';
import { AnthropicProvider } from './anthropic.js';
import { DemoProvider } from './demo.js';
import type { ModelProvider } from './types.js';

export * from './types.js';
export { DemoProvider } from './demo.js';
export { AnthropicProvider } from './anthropic.js';

/**
 * Build the provider for a workspace's execution mode.
 *
 * In demo mode this is always the deterministic executor. In live mode it is
 * the configured real provider — and if that provider is not connected, the
 * caller receives it anyway and its `complete` throws. The failure is loud and
 * attributable. Returning the demo provider here instead would be the exact
 * silent fallback the application forbids.
 */
export function createProvider(config: AppConfig): ModelProvider {
  if (config.executionMode === 'demo') return new DemoProvider();
  switch (config.provider.kind) {
    case 'anthropic':
      return new AnthropicProvider(config.provider.anthropicApiKey, config.provider.anthropicModel);
    case 'openai-compatible':
      throw new Error(
        'MODEL_PROVIDER=openai-compatible is declared in configuration but no adapter is implemented in this build. ' +
        'It is listed as unimplemented in the README rather than stubbed to look functional.',
      );
    case 'demo':
      throw new Error(
        'EXECUTION_MODE=live with MODEL_PROVIDER=demo is refused: live mode must not serve deterministic demo output.',
      );
  }
}
