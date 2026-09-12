import cors from '@fastify/cors';
import Fastify from 'fastify';
import { loadConfig, providerStatus } from './config.js';
import { closePool, query } from './db/pool.js';
import { createProvider } from './providers/index.js';
import { WorkerPool } from './orchestrator/worker.js';
import { registerAgentRoutes } from './routes/agents.js';
import { registerCoreRoutes } from './routes/core.js';
import { registerGovernanceRoutes } from './routes/governance.js';
import { registerWorkRoutes } from './routes/work.js';
import { RecordingSink } from './tools/registry.js';

const config = loadConfig();
const app = Fastify({ logger: { level: 'info' }, bodyLimit: 5_000_000 });

// Spread to a mutable array: @fastify/cors types reject a readonly origin list.
await app.register(cors, { origin: [...config.corsOrigins], credentials: true });

// Privileged actions reach a recording test adapter. This build ships no real
// external integration, and the /api/health response says so explicitly.
const externalSink = new RecordingSink();

const provider = createProviderSafely();

function createProviderSafely(): ReturnType<typeof createProvider> {
  try {
    return createProvider(config);
  } catch (error) {
    // A misconfigured live provider must not silently become the demo provider.
    // The server starts so the owner can see and fix the configuration, and
    // every run fails with the reason until they do.
    app.log.error(
      { error: error instanceof Error ? error.message : error },
      'Model provider could not be constructed. Runs will fail with this reason rather than falling back to demo output.',
    );
    const message = error instanceof Error ? error.message : 'provider construction failed';
    return {
      name: 'misconfigured',
      status: () => ({ state: 'disconnected', provider: 'misconfigured', missing: [message] }),
      complete: async () => { throw new Error(message); },
    };
  }
}

await registerCoreRoutes(app, config, provider);
await registerAgentRoutes(app);
await registerWorkRoutes(app);
await registerGovernanceRoutes(app);

app.get('/api/config', async () => ({
  executionMode: config.executionMode,
  providerStatus: providerStatus(config),
  worker: config.worker,
  computeBudget: {
    totalUsd: config.computeBudget.totalUsd ?? null,
    perRunUsd: config.computeBudget.perRunUsd ?? null,
    note: config.computeBudget.totalUsd === null || config.computeBudget.totalUsd === undefined
      ? 'No compute budget configured. Live runs are blocked until the owner sets one; no default is assumed.'
      : 'Compute budget applies to research spend only. Business spending is separate and requires its own approvals.',
  },
}));

/**
 * Look up the workspace, failing with an explanation rather than a stack trace.
 * "ECONNREFUSED 127.0.0.1:5432" followed by twelve frames of pg internals tells
 * the reader nothing they can act on; the three commands below do.
 */
let workspace: { id: string; name: string } | undefined;
try {
  const workspaces = await query<{ id: string; name: string }>(
    'SELECT id, name FROM workspace ORDER BY created_at LIMIT 1',
  );
  workspace = workspaces[0];
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  const isRefused = detail.includes('ECONNREFUSED');
  const isMissingTable = detail.includes('relation "workspace" does not exist');
  console.error([
    '',
    'SupplyQuest HQ could not reach its database.',
    `  ${detail}`,
    '',
    isRefused
      ? 'PostgreSQL does not appear to be accepting connections. Start it, then retry:\n'
        + '  docker compose up -d db        (or start your own PostgreSQL 16)\n'
        + `  DATABASE_URL is currently: ${config.databaseUrl.replace(/:[^:@/]*@/, ':****@')}`
      : isMissingTable
        ? 'The database is reachable but has no schema yet:\n'
          + '  npm run migrate\n  npm run seed'
        : 'Check DATABASE_URL in your .env against .env.example.',
    '',
  ].join('\n'));
  await app.close();
  await closePool();
  process.exit(1);
}

let pool: WorkerPool | null = null;
if (workspace !== undefined) {
  pool = new WorkerPool(
    { config, provider, externalSink },
    workspace.id,
  );
  pool.start();
  app.log.info(
    { workspace: workspace.name, concurrency: config.worker.concurrency, mode: config.executionMode },
    'Worker pool started',
  );
} else {
  app.log.warn('No workspace found. Run `npm run seed` to create the demo company.');
}

const shutdown = async (signal: string): Promise<void> => {
  app.log.info({ signal }, 'Shutting down');
  await pool?.stop();
  await app.close();
  await closePool();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ port: config.port, host: config.host });
app.log.info(
  { providerStatus: providerStatus(config) },
  `SupplyQuest HQ API listening on http://${config.host}:${config.port}`,
);
