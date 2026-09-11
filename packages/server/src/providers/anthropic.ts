import Anthropic from '@anthropic-ai/sdk';
import type { ProviderStatus } from '@sqhq/shared';
import { type ModelProvider, type ModelRequest, type ModelResponse, ProviderDisconnectedError } from './types.js';

/**
 * Real Anthropic adapter.
 *
 * Constructed only when a key is present. If the key is absent, every call
 * throws ProviderDisconnectedError: there is no path from here to demo output.
 */
export class AnthropicProvider implements ModelProvider {
  readonly name = 'anthropic';
  private readonly client: Anthropic | null;

  constructor(
    private readonly apiKey: string | undefined,
    private readonly model: string,
  ) {
    this.client = apiKey === undefined ? null : new Anthropic({ apiKey });
  }

  status(): ProviderStatus {
    return this.client === null
      ? { state: 'disconnected', provider: 'anthropic', missing: ['ANTHROPIC_API_KEY'] }
      : { state: 'ready', provider: 'anthropic', model: this.model };
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    if (this.client === null) throw new ProviderDisconnectedError(['ANTHROPIC_API_KEY']);

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: request.maxOutputTokens,
      system: request.system,
      messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
    });

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');

    // Usage is reported by the API, so token counts are measured. Cost in
    // currency is NOT reported, so it is left null rather than multiplied by a
    // price table this application would have to guess and keep current.
    const usage = {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    };

    return {
      text,
      model: response.model,
      usage,
      costUsd: null,
      measured: true,
    };
  }
}
