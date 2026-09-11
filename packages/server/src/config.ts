import 'dotenv/config';
import { z } from 'zod';
import type { ExecutionMode, ProviderStatus } from '@sqhq/shared';

/**
 * Configuration is parsed once, strictly, at boot. An absent credential is
 * represented as absent — never as an empty string that later behaves like a
 * working key, and never as a silent switch to demo output.
 */
const RawEnv = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required. See .env.example.'),
  PORT: z.coerce.number().int().positive().default(8787),
  HOST: z.string().default('127.0.0.1'),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  EXECUTION_MODE: z.enum(['demo', 'live']).default('demo'),
  MODEL_PROVIDER: z.enum(['demo', 'anthropic', 'openai-compatible']).default('demo'),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default('claude-sonnet-5'),
  OPENAI_COMPATIBLE_BASE_URL: z.string().optional(),
  OPENAI_COMPATIBLE_API_KEY: z.string().optional(),
  OPENAI_COMPATIBLE_MODEL: z.string().optional(),
  COMPUTE_BUDGET_USD_TOTAL: z.string().optional(),
  COMPUTE_BUDGET_USD_PER_RUN: z.string().optional(),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(3),
  RUN_LEASE_SECONDS: z.coerce.number().int().min(10).default(90),
  RUN_HEARTBEAT_SECONDS: z.coerce.number().int().min(5).default(15),
});

/** Treat whitespace-only values as absent, so a blank .env line is honest. */
function blankToUndefined(v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  const t = v.trim();
  return t.length === 0 ? undefined : t;
}

export interface AppConfig {
  readonly databaseUrl: string;
  readonly port: number;
  readonly host: string;
  readonly corsOrigins: readonly string[];
  readonly executionMode: ExecutionMode;
  readonly provider: {
    readonly kind: 'demo' | 'anthropic' | 'openai-compatible';
    readonly anthropicApiKey: string | undefined;
    readonly anthropicModel: string;
    readonly openAiBaseUrl: string | undefined;
    readonly openAiApiKey: string | undefined;
    readonly openAiModel: string | undefined;
  };
  readonly computeBudget: {
    readonly totalUsd: string | undefined;
    readonly perRunUsd: string | undefined;
  };
  readonly worker: {
    readonly concurrency: number;
    readonly leaseSeconds: number;
    readonly heartbeatSeconds: number;
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = RawEnv.parse(env);
  return {
    databaseUrl: parsed.DATABASE_URL,
    port: parsed.PORT,
    host: parsed.HOST,
    corsOrigins: parsed.CORS_ORIGIN.split(',').map((s) => s.trim()).filter((s) => s.length > 0),
    executionMode: parsed.EXECUTION_MODE,
    provider: {
      kind: parsed.MODEL_PROVIDER,
      anthropicApiKey: blankToUndefined(parsed.ANTHROPIC_API_KEY),
      anthropicModel: parsed.ANTHROPIC_MODEL,
      openAiBaseUrl: blankToUndefined(parsed.OPENAI_COMPATIBLE_BASE_URL),
      openAiApiKey: blankToUndefined(parsed.OPENAI_COMPATIBLE_API_KEY),
      openAiModel: blankToUndefined(parsed.OPENAI_COMPATIBLE_MODEL),
    },
    computeBudget: {
      totalUsd: blankToUndefined(parsed.COMPUTE_BUDGET_USD_TOTAL),
      perRunUsd: blankToUndefined(parsed.COMPUTE_BUDGET_USD_PER_RUN),
    },
    worker: {
      concurrency: parsed.WORKER_CONCURRENCY,
      leaseSeconds: parsed.RUN_LEASE_SECONDS,
      heartbeatSeconds: parsed.RUN_HEARTBEAT_SECONDS,
    },
  };
}

/**
 * Report exactly what is and is not wired up.
 *
 * This is the function that keeps the application honest about live mode: it
 * enumerates the missing pieces by name instead of degrading quietly. Callers
 * must refuse a live run when the state is 'disconnected'.
 */
export function providerStatus(config: AppConfig): ProviderStatus {
  if (config.executionMode === 'demo') {
    return {
      state: 'demo',
      seedNote: 'Deterministic seeded executor. Every artifact and event is labelled SYNTHETIC_DEMO.',
    };
  }
  switch (config.provider.kind) {
    case 'demo':
      return {
        state: 'disconnected', provider: 'demo',
        missing: ['MODEL_PROVIDER is "demo" while EXECUTION_MODE is "live". Live mode will not use the demo provider.'],
      };
    case 'anthropic': {
      const missing: string[] = [];
      if (config.provider.anthropicApiKey === undefined) missing.push('ANTHROPIC_API_KEY');
      return missing.length === 0
        ? { state: 'ready', provider: 'anthropic', model: config.provider.anthropicModel }
        : { state: 'disconnected', provider: 'anthropic', missing };
    }
    case 'openai-compatible': {
      const missing: string[] = [];
      if (config.provider.openAiBaseUrl === undefined) missing.push('OPENAI_COMPATIBLE_BASE_URL');
      if (config.provider.openAiApiKey === undefined) missing.push('OPENAI_COMPATIBLE_API_KEY');
      if (config.provider.openAiModel === undefined) missing.push('OPENAI_COMPATIBLE_MODEL');
      return missing.length === 0
        ? {
            state: 'ready', provider: 'openai-compatible',
            model: config.provider.openAiModel ?? 'unspecified',
          }
        : { state: 'disconnected', provider: 'openai-compatible', missing };
    }
  }
}

/** Budget gate: a live run needs an explicit ceiling, not an assumed one. */
export function computeBudgetStatus(
  config: AppConfig,
): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  if (config.executionMode === 'demo') return { ok: true };
  if (config.computeBudget.totalUsd === undefined) {
    return {
      ok: false,
      reason: 'COMPUTE_BUDGET_USD_TOTAL is unset. Live runs are blocked until the owner sets an explicit compute budget; no default is assumed.',
    };
  }
  return { ok: true };
}
