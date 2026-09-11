import type { PoolClient } from 'pg';
import { assertTaskTransition, type QuarantineReason, type TaskState } from '@sqhq/shared';
import { appendEvent } from '../events/append.js';
import { withTransaction } from '../db/pool.js';

export interface ClaimedRun {
  readonly runId: string;
  readonly leaseToken: string;
  readonly attempt: number;
  readonly taskId: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly title: string;
  readonly instruction: string;
  readonly nodeKind: string;
  readonly agentId: string | null;
  readonly agentName: string;
  readonly agentConfigVersionId: string | null;
  readonly allowedTools: readonly string[];
  readonly instructions: string;
  readonly model: string | null;
  readonly maxRunSeconds: number;
  readonly maxToolCalls: number;
  readonly executionMode: 'demo' | 'live';
  readonly templateId: string;
  readonly nodeConfig: Readonly<Record<string, unknown>>;
}

/**
 * Claim one ready task and open a run for it.
 *
 * FOR UPDATE SKIP LOCKED lets several workers claim concurrently without
 * blocking each other or handing the same task to two workers. The lease is
 * written in the same transaction as the state change, so a worker that dies
 * immediately after claiming still leaves a reapable lease rather than a task
 * stuck in `running` forever.
 *
 * Readiness is computed in SQL rather than in the worker so that adding a
 * dependency, pausing a project or engaging the emergency stop takes effect on
 * the very next claim without any in-memory state to invalidate.
 */
export async function claimNextRun(
  client: PoolClient, workspaceId: string, leaseSeconds: number,
): Promise<ClaimedRun | null> {
  const task = await client.query<{
    id: string; project_id: string; title: string; instruction: string;
    node_kind: string; assigned_agent_id: string | null;
    node_config: Record<string, unknown>;
  }>(
    `SELECT t.id, t.project_id, t.title, t.instruction, t.node_kind, t.assigned_agent_id,
              t.node_config
       FROM task t
       JOIN project p ON p.id = t.project_id
       JOIN workspace w ON w.id = t.workspace_id
      WHERE t.workspace_id = $1
        AND t.state = 'queued'
        AND p.status = 'active'
        AND w.emergency_stop_engaged = false
        AND (t.scheduled_for IS NULL OR t.scheduled_for <= now())
        AND NOT EXISTS (
              SELECT 1 FROM task_dependency d
                JOIN task dep ON dep.id = d.depends_on_task_id
               WHERE d.task_id = t.id AND dep.state <> 'completed'
            )
        AND (
              t.assigned_agent_id IS NULL
              OR EXISTS (SELECT 1 FROM agent_instance a
                          WHERE a.id = t.assigned_agent_id AND a.status = 'active')
            )
      ORDER BY t.priority ASC, t.created_at ASC
      LIMIT 1
      FOR UPDATE OF t SKIP LOCKED`,
    [workspaceId],
  );
  const row = task.rows[0];
  if (row === undefined) return null;

  const mode = await client.query<{ execution_mode: 'demo' | 'live' }>(
    'SELECT execution_mode FROM workspace WHERE id = $1', [workspaceId],
  );
  const executionMode = mode.rows[0]?.execution_mode ?? 'demo';

  let agentName = 'Unassigned';
  let allowedTools: readonly string[] = [];
  let instructions = '';
  let model: string | null = null;
  let maxRunSeconds = 300;
  let maxToolCalls = 25;
  let agentConfigVersionId: string | null = null;
  let templateId = 'chief-of-staff';

  if (row.assigned_agent_id !== null) {
    const agent = await client.query<{
      name: string; template_id: string; config_id: string | null;
      instructions: string | null; allowed_tools: string[] | null;
      model: string | null; max_run_seconds: number | null; max_tool_calls: number | null;
    }>(
      `SELECT a.name, a.template_id, c.id AS config_id, c.instructions,
              c.allowed_tools, c.model, c.max_run_seconds, c.max_tool_calls
         FROM agent_instance a
         LEFT JOIN agent_config_version c ON c.id = a.current_config_version_id
        WHERE a.id = $1`,
      [row.assigned_agent_id],
    );
    const a = agent.rows[0];
    if (a !== undefined) {
      agentName = a.name;
      templateId = a.template_id;
      agentConfigVersionId = a.config_id;
      instructions = a.instructions ?? '';
      allowedTools = a.allowed_tools ?? [];
      model = a.model;
      maxRunSeconds = a.max_run_seconds ?? 300;
      maxToolCalls = a.max_tool_calls ?? 25;
    }
  }

  const attemptRow = await client.query<{ attempt: number }>(
    'SELECT COALESCE(MAX(attempt), 0) + 1 AS attempt FROM run WHERE task_id = $1', [row.id],
  );
  const attempt = attemptRow.rows[0]?.attempt ?? 1;

  // The run pins the config version. A later edit creates a new version and
  // cannot rewrite the instructions this attempt is executing under.
  const run = await client.query<{ id: string; lease_token: string }>(
    `INSERT INTO run (workspace_id, task_id, agent_id, agent_config_version_id, attempt,
                      state, lease_expires_at, execution_mode, model)
     VALUES ($1,$2,$3,$4,$5,'leased', now() + ($6 || ' seconds')::interval, $7, $8)
     RETURNING id, lease_token`,
    [workspaceId, row.id, row.assigned_agent_id, agentConfigVersionId, attempt,
     String(leaseSeconds), executionMode, model],
  );
  const runRow = run.rows[0];
  if (runRow === undefined) throw new Error('Failed to open a run.');

  await setTaskState(client, workspaceId, row.id, 'running', {
    actorLabel: agentName, actorKind: 'agent', runId: runRow.id,
    agentId: row.assigned_agent_id,
  });

  await appendEvent(client, {
    workspaceId, projectId: row.project_id, taskId: row.id, runId: runRow.id,
    type: 'run.started', actorKind: 'agent', actorId: row.assigned_agent_id,
    actorLabel: agentName,
    dataLabel: executionMode === 'demo' ? 'SYNTHETIC_DEMO' : 'UNVERIFIED_LEAD',
    summary: `${agentName} started "${row.title}" (attempt ${attempt})`,
    detail: { attempt, executionMode, templateId },
  });

  return {
    runId: runRow.id, leaseToken: runRow.lease_token, attempt,
    taskId: row.id, projectId: row.project_id, workspaceId,
    title: row.title, instruction: row.instruction, nodeKind: row.node_kind,
    agentId: row.assigned_agent_id, agentName, agentConfigVersionId,
    allowedTools, instructions, model, maxRunSeconds, maxToolCalls,
    executionMode, templateId, nodeConfig: row.node_config ?? {},
  };
}

/** Transition a task, validating against the state machine, and log it. */
export async function setTaskState(
  client: PoolClient, workspaceId: string, taskId: string, to: TaskState,
  ctx: {
    actorLabel: string; actorKind: 'owner' | 'agent' | 'system';
    runId?: string | null; agentId?: string | null; reason?: string | null;
  },
): Promise<void> {
  const current = await client.query<{ state: TaskState; project_id: string; title: string }>(
    'SELECT state, project_id, title FROM task WHERE id = $1 FOR UPDATE', [taskId],
  );
  const row = current.rows[0];
  if (row === undefined) throw new Error(`Task ${taskId} not found.`);
  if (row.state === to) return;
  assertTaskTransition(row.state, to);

  await client.query(
    'UPDATE task SET state = $2, waiting_reason = $3, updated_at = now() WHERE id = $1',
    [taskId, to, ctx.reason ?? null],
  );
  await appendEvent(client, {
    workspaceId, projectId: row.project_id, taskId,
    runId: ctx.runId ?? null, type: 'task.state_changed',
    actorKind: ctx.actorKind, actorId: ctx.agentId ?? null, actorLabel: ctx.actorLabel,
    dataLabel: 'OWNER_CONFIRMED_ACTUAL',
    summary: `"${row.title}" ${row.state} -> ${to}`,
    detail: { from: row.state, to, reason: ctx.reason ?? null },
  });
}

export async function heartbeat(
  client: PoolClient, runId: string, leaseToken: string, leaseSeconds: number,
): Promise<boolean> {
  const updated = await client.query(
    `UPDATE run
        SET last_heartbeat_at = now(),
            lease_expires_at = now() + ($3 || ' seconds')::interval
      WHERE id = $1 AND lease_token = $2 AND state = 'leased' AND cancel_requested = false`,
    [runId, leaseToken, String(leaseSeconds)],
  );
  return updated.rowCount === 1;
}

/**
 * Reap runs whose lease expired without a heartbeat.
 *
 * This is what makes a killed worker or a crashed container recoverable: the
 * task returns to `queued` for a bounded retry rather than sitting in `running`
 * with nobody executing it.
 */
export async function reapExpiredLeases(
  workspaceId: string, maxAttempts = 3,
): Promise<number> {
  return withTransaction(async (client) => {
    const expired = await client.query<{ id: string; task_id: string; attempt: number; project_id: string }>(
      `SELECT r.id, r.task_id, r.attempt, t.project_id
         FROM run r JOIN task t ON t.id = r.task_id
        WHERE r.workspace_id = $1 AND r.state = 'leased' AND r.lease_expires_at < now()
        FOR UPDATE OF r SKIP LOCKED`,
      [workspaceId],
    );
    for (const run of expired.rows) {
      await client.query(
        `UPDATE run SET state = 'timed_out', finished_at = now(),
               error_code = 'LEASE_EXPIRED',
               error_message = 'No heartbeat before the lease expired. The worker died, hung, or lost its connection.'
          WHERE id = $1`,
        [run.id],
      );
      await appendEvent(client, {
        workspaceId, projectId: run.project_id, taskId: run.task_id, runId: run.id,
        type: 'run.timed_out', actorKind: 'system', actorLabel: 'Lease reaper',
        dataLabel: 'OWNER_CONFIRMED_ACTUAL',
        summary: `Run timed out after its lease expired (attempt ${run.attempt})`,
        detail: { attempt: run.attempt },
      });
      // Bounded retry. Beyond the cap the task fails visibly rather than
      // looping forever and quietly burning budget.
      const nextState: TaskState = run.attempt >= maxAttempts ? 'failed' : 'queued';
      await setTaskState(client, workspaceId, run.task_id, nextState, {
        actorLabel: 'Lease reaper', actorKind: 'system',
        reason: nextState === 'failed'
          ? `Gave up after ${run.attempt} attempts, each of which lost its lease.`
          : `Requeued for attempt ${run.attempt + 1} after a lost lease.`,
      });
    }
    return expired.rows.length;
  });
}

/**
 * Revoke a run's lease. Used when an agent is archived, its config superseded,
 * or the emergency stop is engaged. Output that arrives afterwards is
 * quarantined for review rather than accepted or silently dropped.
 */
export async function revokeLease(
  client: PoolClient, workspaceId: string, runId: string, reason: QuarantineReason,
): Promise<void> {
  const run = await client.query<{ task_id: string; project_id: string; attempt: number }>(
    `SELECT r.task_id, t.project_id, r.attempt FROM run r JOIN task t ON t.id = r.task_id WHERE r.id = $1`,
    [runId],
  );
  const row = run.rows[0];
  await client.query(
    `UPDATE run SET cancel_requested = true, state = 'quarantined',
            quarantine_reason = $2, finished_at = now()
      WHERE id = $1 AND state = 'leased'`,
    [runId, reason],
  );
  if (row !== undefined) {
    await appendEvent(client, {
      workspaceId, projectId: row.project_id, taskId: row.task_id, runId,
      type: 'run.quarantined', actorKind: 'system', actorLabel: 'Lease control',
      dataLabel: 'OWNER_CONFIRMED_ACTUAL',
      summary: `Run quarantined: ${reason}. Any output it already produced is held for review.`,
      detail: { reason, attempt: row.attempt },
    });
  }
}

/**
 * Promote tasks whose dependencies have all completed.
 *
 * Without this, a join node waits forever: the claim query only considers
 * `queued`, and nothing else moves a task out of `waiting_dependency`. It is
 * written as an idempotent sweep rather than a hook on task completion so that
 * every path into a satisfied dependency set is covered — a completion, a
 * manual retry, a reassignment, or a dependency cancelled by the owner.
 *
 * A task whose dependency ended in a NON-completed terminal state (failed or
 * cancelled) is not promoted and not silently skipped either: it is failed with
 * the reason, because running a join whose input never arrived would produce a
 * conclusion drawn from missing work.
 */
export async function promoteReadyTasks(workspaceId: string): Promise<number> {
  return withTransaction(async (client) => {
    const ready = await client.query<{ id: string }>(
      `SELECT t.id
         FROM task t
         JOIN project p ON p.id = t.project_id
        WHERE t.workspace_id = $1
          AND t.state = 'waiting_dependency'
          AND p.status = 'active'
          AND NOT EXISTS (
                SELECT 1 FROM task_dependency d
                  JOIN task dep ON dep.id = d.depends_on_task_id
                 WHERE d.task_id = t.id AND dep.state <> 'completed'
              )
        FOR UPDATE OF t SKIP LOCKED`,
      [workspaceId],
    );
    for (const row of ready.rows) {
      await setTaskState(client, workspaceId, row.id, 'queued', {
        actorLabel: 'Dependency resolver', actorKind: 'system',
        reason: 'All dependencies completed.',
      });
    }

    // Dependencies that ended badly block their dependents permanently. Say so
    // rather than leaving the board quietly stalled.
    const blocked = await client.query<{ id: string; blockers: string[] }>(
      `SELECT t.id,
              array_agg(dep.title || ' (' || dep.state || ')') AS blockers
         FROM task t
         JOIN task_dependency d ON d.task_id = t.id
         JOIN task dep ON dep.id = d.depends_on_task_id
        WHERE t.workspace_id = $1
          AND t.state = 'waiting_dependency'
          AND dep.state IN ('failed','cancelled')
        GROUP BY t.id`,
      // No FOR UPDATE here: PostgreSQL forbids row locking with GROUP BY, and
      // setTaskState takes its own FOR UPDATE on each task row it changes.

      [workspaceId],
    );
    for (const row of blocked.rows) {
      await setTaskState(client, workspaceId, row.id, 'failed', {
        actorLabel: 'Dependency resolver', actorKind: 'system',
        reason: `Cannot run: a dependency ended without completing (${row.blockers.join(', ')}). A conclusion drawn from missing work would be worse than no conclusion.`,
      });
    }

    // Timer nodes park with a scheduled_for in the database rather than a
    // setTimeout in a process, so the wait survives a restart.
    const elapsed = await client.query<{ id: string }>(
      `SELECT id FROM task
        WHERE workspace_id = $1 AND state = 'waiting_dependency'
          AND scheduled_for IS NOT NULL AND scheduled_for <= now()
        FOR UPDATE SKIP LOCKED`,
      [workspaceId],
    );
    for (const row of elapsed.rows) {
      await client.query('UPDATE task SET scheduled_for = NULL WHERE id = $1', [row.id]);
      await setTaskState(client, workspaceId, row.id, 'queued', {
        actorLabel: 'Timer', actorKind: 'system',
        reason: 'Timer elapsed.',
      });
    }

    return ready.rows.length + blocked.rows.length + elapsed.rows.length;
  });
}
