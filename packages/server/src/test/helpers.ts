import type { PoolClient } from 'pg';
import { ROLE_TEMPLATES, type ToolName } from '@sqhq/shared';
import { getPool, query, withTransaction } from '../db/pool.js';
import { migrate } from '../db/migrate.js';

let migrated = false;

export async function resetDatabase(): Promise<void> {
  if (!migrated) {
    await migrate(() => { /* quiet in tests */ });
    migrated = true;
  }
  // Truncate rather than drop: keeps the migration cost to once per run.
  await getPool().query(`
    TRUNCATE workspace, agent_template RESTART IDENTITY CASCADE;
  `);
}

export interface Fixture {
  readonly workspaceId: string;
  readonly ownerId: string;
  readonly projectId: string;
  readonly agentId: string;
  readonly configVersionId: string;
  readonly taskId: string;
}

/** A minimal workspace with one agent holding the given tool permissions. */
export async function makeFixture(
  allowedTools: readonly ToolName[] = ['draft.write', 'order.place'],
): Promise<Fixture> {
  return withTransaction(async (client) => {
    const ws = await client.query<{ id: string }>(
      `INSERT INTO workspace (name, execution_mode) VALUES ('test', 'demo') RETURNING id`,
    );
    const workspaceId = ws.rows[0]!.id;
    await client.query('INSERT INTO workspace_event_seq (workspace_id, last_seq) VALUES ($1,0)', [workspaceId]);

    const owner = await client.query<{ id: string }>(
      `INSERT INTO app_user (workspace_id, email, display_name, is_owner)
       VALUES ($1,'owner@test.invalid','Owner',true) RETURNING id`, [workspaceId],
    );
    const role = ROLE_TEMPLATES[0]!;
    await client.query(
      `INSERT INTO agent_template (id, workspace_id, title, responsibilities, home_zone,
         visual, default_tools, reviews, authority_limits, is_builtin)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true) ON CONFLICT (id) DO NOTHING`,
      [role.id, workspaceId, role.title, role.responsibilities, role.homeZone,
       JSON.stringify(role.visual), role.defaultTools, role.reviews, role.authorityLimits],
    );
    const project = await client.query<{ id: string }>(
      `INSERT INTO project (workspace_id, name, owner_objective, status, data_label)
       VALUES ($1,'test project','objective','active','OWNER_CONFIRMED_ACTUAL') RETURNING id`,
      [workspaceId],
    );
    const agent = await client.query<{ id: string }>(
      `INSERT INTO agent_instance (workspace_id, template_id, name, status)
       VALUES ($1,$2,'Test Agent','active') RETURNING id`, [workspaceId, role.id],
    );
    const config = await client.query<{ id: string }>(
      `INSERT INTO agent_config_version (agent_id, version, instructions, appearance, allowed_tools)
       VALUES ($1,1,'test','{}'::jsonb,$2) RETURNING id`, [agent.rows[0]!.id, allowedTools],
    );
    await client.query('UPDATE agent_instance SET current_config_version_id = $2 WHERE id = $1',
      [agent.rows[0]!.id, config.rows[0]!.id]);
    const task = await client.query<{ id: string }>(
      `INSERT INTO task (workspace_id, project_id, title, instruction, state, assigned_agent_id)
       VALUES ($1,$2,'test task','do the thing','running',$3) RETURNING id`,
      [workspaceId, project.rows[0]!.id, agent.rows[0]!.id],
    );
    return {
      workspaceId, ownerId: owner.rows[0]!.id, projectId: project.rows[0]!.id,
      agentId: agent.rows[0]!.id, configVersionId: config.rows[0]!.id,
      taskId: task.rows[0]!.id,
    };
  });
}

export async function openRun(
  fixture: Fixture, leaseSeconds = 300,
): Promise<{ runId: string; leaseToken: string }> {
  const rows = await query<{ id: string; lease_token: string }>(
    `INSERT INTO run (workspace_id, task_id, agent_id, agent_config_version_id, attempt,
                      state, lease_expires_at, execution_mode)
     VALUES ($1,$2,$3,$4,
             (SELECT COALESCE(MAX(attempt),0)+1 FROM run WHERE task_id = $2),
             'leased', now() + ($5 || ' seconds')::interval, 'demo')
     RETURNING id, lease_token`,
    [fixture.workspaceId, fixture.taskId, fixture.agentId, fixture.configVersionId, String(leaseSeconds)],
  );
  return { runId: rows[0]!.id, leaseToken: rows[0]!.lease_token };
}

export function toolContext(
  client: PoolClient, fixture: Fixture, run: { runId: string; leaseToken: string },
  allowedTools: readonly string[], externalSink?: import('../tools/registry.js').ExternalSink,
): import('../tools/registry.js').ToolContext {
  return {
    client,
    workspaceId: fixture.workspaceId,
    projectId: fixture.projectId,
    taskId: fixture.taskId,
    runId: run.runId,
    leaseToken: run.leaseToken,
    agentId: fixture.agentId,
    actorLabel: 'Test Agent',
    allowedTools,
    dataLabel: 'SYNTHETIC_DEMO',
    ...(externalSink !== undefined ? { externalSink } : {}),
  };
}

export function approvalPayload(
  overrides: Partial<import('@sqhq/shared').ApprovalPayload> = {},
): import('@sqhq/shared').ApprovalPayload {
  return {
    tool: 'order.place',
    action: 'Place a sample order for 5 units.',
    destination: 'DEMO supplier',
    content: 'Sample order: 5 units to specification v1.',
    amountMinor: 42000,
    currency: 'CAD',
    productRef: 'carrier v1',
    quantity: 5,
    supplierRef: 'DEMO Hangzhou Garment Case Works',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    ...overrides,
  };
}
