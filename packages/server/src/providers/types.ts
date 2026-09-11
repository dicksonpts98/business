import type { ProviderStatus } from '@sqhq/shared';

export interface ModelMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

export interface ModelRequest {
  /** Stable identifier for what this call is for, e.g. 'research.evidence'. */
  readonly purpose: string;
  readonly system: string;
  readonly messages: readonly ModelMessage[];
  readonly maxOutputTokens: number;
  /**
   * Deterministic seed material. The demo provider derives its output from
   * this, so a demo run is reproducible from the same project and task.
   */
  readonly seed: string;
}

export interface ModelUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface ModelResponse {
  readonly text: string;
  readonly model: string;
  /** Present only when the provider reported it. Never estimated into this field. */
  readonly usage: ModelUsage | null;
  /** Decimal string USD. `measured` says whether the provider supplied usage. */
  readonly costUsd: string | null;
  readonly measured: boolean;
}

export class ProviderDisconnectedError extends Error {
  constructor(public readonly missing: readonly string[]) {
    super(
      `Model provider is not connected. Missing: ${missing.join(', ')}. ` +
      'Live mode does not fall back to demo output, so this run fails rather ' +
      'than producing results that look real.',
    );
    this.name = 'ProviderDisconnectedError';
  }
}

export interface ModelProvider {
  readonly name: string;
  status(): ProviderStatus;
  complete(request: ModelRequest): Promise<ModelResponse>;
}
