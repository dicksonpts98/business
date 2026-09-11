import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ROLE_BY_ID } from '@sqhq/shared';
import { query, withTransaction } from '../db/pool.js';
import { appendEvent } from '../events/append.js';
import { revokeLease, setTaskState } from '../orchestrator/queue.js';
import { WorkflowGraph, topologicalOrder, validateWorkflow } from '../orchestrator/workflow.js';

export async function registerWorkRoutes(app: FastifyInstance): Promise<void> {
  /* ---------------------------------------------------------------- projects */

  app.get<{ Querystring: { workspaceId: string } }>('/api/projects', async (request) => {
    const projects = await query(
      `SELECT p.*,
              (SELECT count(*) FROM task t WHERE t.project_id = p.id) AS task_count,
              (SELECT count(*) FROM task t WHERE t.project_id = p.id AND t.state = 'completed') AS completed_count,
              (SELECT count(*) FROM approval a WHERE a.project_id = p.id AND a.state = 'pending') AS pending_approvals
         FROM project p WHERE p.workspace_id = $1 ORDER BY p.created_at DESC`,
      [request.query.workspaceId],
    );
    return { projects };
  });

  app.post('/api/projects', async (request, reply) => {
    const Body = z.object({
      workspaceId: z.string().uuid(),
      name: z.string().min(1),
      ownerObjective: z.string().min(1),
      geography: z.array(z.string()).default([]),
    });
    const parsed = Body.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid project', issues: parsed.error.issues });
    const input = parsed.data;

    return withTransaction(async (client) => {
      const row = await client.query<{ id: string }>(
        `INSERT INTO project (workspace_id, name, owner_objective, geography, status, data_label)
         VALUES ($1,$2,$3,$4,'active','OWNER_CONFIRMED_ACTUAL') RETURNING id`,
        [input.workspaceId, input.name, input.ownerObjective, input.geography],
      );
      const projectId = row.rows[0]!.id;
      await appendEvent(client, {
        workspaceId: input.workspaceId, projectId, type: 'project.created',
        actorKind: 'owner', actorLabel: 'Owner', dataLabel: 'OWNER_CONFIRMED_ACTUAL',
        summary: `Project "${input.name}" created`,
        detail: {
          geography: input.geography,
          geographyNote: 'Geography is an editable hypothesis. Nothing here treats it as validated.',
        },
      });
      return { projectId };
    });
  });

  app.post<{ Params: { id: string }; Body: { paused: boolean; reason?: string } }>(
    '/api/projects/:id/pause', async (request, reply) => {
      return withTransaction(async (client) => {
        const row = await client.query<{ workspace_id: string; name: string }>(
          'SELECT workspace_id, name FROM project WHERE id = $1 FOR UPDATE', [request.params.id],
        );
        const p = row.rows[0];
        if (p === undefined) { reply.code(404); return { error: 'Project not found' }; }
        const status = request.body.paused ? 'paused' : 'active';
        await client.query('UPDATE project SET status = $2, paused_reason = $3, updated_at = now() WHERE id = $1',
          [request.params.id, status, request.body.reason ?? null]);
        await appendEvent(client, {
          workspaceId: p.workspace_id, projectId: request.params.id,
          type: request.body.paused ? 'project.paused' : 'project.resumed',
          actorKind: 'owner', actorLabel: 'Owner', dataLabel: 'OWNER_CONFIRMED_ACTUAL',
          summary: `Project "${p.name}" ${status}`,
          detail: { reason: request.body.reason ?? null },
        });
        return { status };
      });
    });

  /* ------------------------------------------------------------------- tasks */

  app.get<{ Querystring: { projectId?: string; workspaceId?: string } }>('/api/tasks', async (request) => {
    const { projectId, workspaceId } = request.query;
    const tasks = await query(
      `SELECT t.*, a.name AS agent_name, a.template_id AS agent_role,
              (SELECT array_agg(d.depends_on_task_id) FROM task_dependency d WHERE d.task_id = t.id) AS depends_on,
              (SELECT count(*) FROM run r WHERE r.task_id = t.id) AS run_count,
              (SELECT r2.state FROM run r2 WHERE r2.task_id = t.id ORDER BY r2.attempt DESC LIMIT 1) AS latest_run_state,
              (SELECT r3.error_message FROM run r3 WHERE r3.task_id = t.id ORDER BY r3.attempt DESC LIMIT 1) AS latest_error
         FROM task t
         LEFT JOIN agent_instance a ON a.id = t.assigned_agent_id
        WHERE ($1::uuid IS NULL OR t.project_id = $1)
          AND ($2::uuid IS NULL OR t.workspace_id = $2)
        ORDER BY t.priority, t.created_at`,
      [projectId ?? null, workspaceId ?? null],
    );
    return { tasks };
  });

  app.get<{ Params: { id: string } }>('/api/tasks/:id/runs', async (request) => {
    const runs = await query(
      `SELECT r.*, (SELECT count(*) FROM tool_call tc WHERE tc.run_id = r.id) AS tool_call_count
         FROM run r WHERE r.task_id = $1 ORDER BY r.attempt DESC`,
      [request.params.id],
    );
    const toolCalls = await query(
      `SELECT tc.* FROM tool_call tc JOIN run r ON r.id = tc.run_id
        WHERE r.task_id = $1 ORDER BY tc.created_at`,
      [request.params.id],
    );
    return { runs, toolCalls };
  });

  app.post('/api/tasks', async (request, reply) => {
    const Body = z.object({
      workspaceId: z.string().uuid(),
      projectId: z.string().uuid(),
      title: z.string().min(1),
      instruction: z.string().default(''),
      nodeKind: z.string().default('task'),
      assignedAgentId: z.string().uuid().nullable().default(null),
      dependsOn: z.array(z.string().uuid()).default([]),
      priority: z.number().int().default(100),
      queue: z.boolean().default(true),
    });
    const parsed = Body.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid task', issues: parsed.error.issues });
    const input = parsed.data;

    return withTransaction(async (client) => {
      const hasUnmet = input.dependsOn.length > 0 && (await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM task WHERE id = ANY($1::uuid[]) AND state <> 'completed'`,
        [input.dependsOn],
      )).rows[0]!.count !== '0';

      const state = !input.queue ? 'draft' : hasUnmet ? 'waiting_dependency' : 'queued';
      const row = await client.query<{ id: string }>(
        `INSERT INTO task (workspace_id, project_id, title, instruction, node_kind,
           state, assigned_agent_id, priority)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [input.workspaceId, input.projectId, input.title, input.instruction,
         input.nodeKind, state, input.assignedAgentId, input.priority],
      );
      const taskId = row.rows[0]!.id;
      for (const dep of input.dependsOn) {
        await client.query(
          'INSERT INTO task_dependency (task_id, depends_on_task_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
          [taskId, dep],
        );
      }
      await appendEvent(client, {
        workspaceId: input.workspaceId, projectId: input.projectId, taskId,
        type: 'task.created', actorKind: 'owner', actorLabel: 'Owner',
        dataLabel: 'OWNER_CONFIRMED_ACTUAL',
        summary: `Task "${input.title}" created (${state})`,
        detail: { dependsOn: input.dependsOn, nodeKind: input.nodeKind },
      });
      return { taskId, state };
    });
  });

  app.post<{ Params: { id: string }; Body: { reason?: string } }>(
    '/api/tasks/:id/cancel', async (request, reply) => {
      return withTransaction(async (client) => {
        const row = await client.query<{ workspace_id: string; state: string }>(
          'SELECT workspace_id, state FROM task WHERE id = $1 FOR UPDATE', [request.params.id],
        );
        const t = row.rows[0];
        if (t === undefined) { reply.code(404); return { error: 'Task not found' }; }
        const live = await client.query<{ id: string }>(
          `SELECT id FROM run WHERE task_id = $1 AND state = 'leased'`, [request.params.id],
        );
        for (const run of live.rows) {
          await revokeLease(client, t.workspace_id, run.id, 'lease_revoked');
        }
        await setTaskState(client, t.workspace_id, request.params.id, 'cancelled', {
          actorLabel: 'Owner', actorKind: 'owner',
          reason: request.body.reason ?? 'Cancelled by owner.',
        });
        return { cancelled: true, revokedRuns: live.rows.length };
      });
    });

  /** Explicit, bounded rework. A retry creates a new run; it never erases one. */
  app.post<{ Params: { id: string } }>('/api/tasks/:id/retry', async (request, reply) => {
    return withTransaction(async (client) => {
      const row = await client.query<{ workspace_id: string; state: string; rework_count: number; max_rework: number; title: string }>(
        'SELECT workspace_id, state, rework_count, max_rework, title FROM task WHERE id = $1 FOR UPDATE',
        [request.params.id],
      );
      const t = row.rows[0];
      if (t === undefined) { reply.code(404); return { error: 'Task not found' }; }
      if (t.rework_count >= t.max_rework) {
        reply.code(409);
        return {
          error: `Rework limit reached (${t.rework_count}/${t.max_rework}). Raise max_rework deliberately rather than looping indefinitely.`,
        };
      }
      await client.query('UPDATE task SET rework_count = rework_count + 1 WHERE id = $1', [request.params.id]);
      await setTaskState(client, t.workspace_id, request.params.id, 'queued', {
        actorLabel: 'Owner', actorKind: 'owner',
        reason: `Rework ${t.rework_count + 1} of ${t.max_rework}. Prior runs and artifacts are retained.`,
      });
      return { requeued: true, reworkCount: t.rework_count + 1 };
    });
  });

  app.post<{ Params: { id: string }; Body: { answer: string } }>(
    '/api/tasks/:id/provide-input', async (request, reply) => {
      return withTransaction(async (client) => {
        const row = await client.query<{ workspace_id: string; state: string }>(
          'SELECT workspace_id, state FROM task WHERE id = $1 FOR UPDATE', [request.params.id],
        );
        const t = row.rows[0];
        if (t === undefined) { reply.code(404); return { error: 'Task not found' }; }
        if (t.state !== 'waiting_input') {
          reply.code(409);
          return { error: `Task is ${t.state}, not waiting_input.` };
        }
        await client.query(
          `UPDATE task SET instruction = instruction || E'\n\nOwner input: ' || $2 WHERE id = $1`,
          [request.params.id, request.body.answer],
        );
        await setTaskState(client, t.workspace_id, request.params.id, 'queued', {
          actorLabel: 'Owner', actorKind: 'owner', reason: 'Owner supplied the requested input.',
        });
        return { requeued: true };
      });
    });

  /* --------------------------------------------------------------- workflows */

  app.post('/api/workflows/validate', async (request, reply) => {
    const parsed = WorkflowGraph.safeParse((request.body as { graph?: unknown })?.graph);
    if (!parsed.success) {
      return reply.code(400).send({ valid: false, issues: parsed.error.issues.map((i) => ({
        code: 'SCHEMA', severity: 'error', message: `${i.path.join('.')}: ${i.message}`,
      })) });
    }
    return validateWorkflow(parsed.data);
  });

  app.get<{ Querystring: { projectId: string } }>('/api/workflows', async (request) => {
    const versions = await query(
      `SELECT id, name, version, graph, validation, created_at
         FROM workflow_version WHERE project_id = $1 ORDER BY version DESC`,
      [request.query.projectId],
    );
    return { versions };
  });

  /**
   * Save a workflow version and instantiate its tasks.
   *
   * An invalid graph is refused before it is stored, so no run can ever start
   * under a graph with a cycle or a dangling reference. The saved version is
   * immutable; instantiated tasks point at it, which is what lets a paused
   * workflow resume from the version it began under after the graph is edited.
   */
  app.post('/api/workflows', async (request, reply) => {
    const Body = z.object({
      workspaceId: z.string().uuid(),
      projectId: z.string().uuid(),
      name: z.string().min(1),
      graph: WorkflowGraph,
      instantiate: z.boolean().default(true),
    });
    const parsed = Body.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid workflow', issues: parsed.error.issues });
    const input = parsed.data;

    const validation = validateWorkflow(input.graph);
    if (!validation.valid) {
      return reply.code(400).send({
        error: 'Workflow is invalid and was not saved.',
        validation,
      });
    }

    return withTransaction(async (client) => {
      const nextVersion = (await client.query<{ v: number }>(
        'SELECT COALESCE(MAX(version),0)+1 AS v FROM workflow_version WHERE project_id = $1',
        [input.projectId],
      )).rows[0]!.v;

      const wf = await client.query<{ id: string }>(
        `INSERT INTO workflow_version (workspace_id, project_id, name, version, graph, validation)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [input.workspaceId, input.projectId, input.name, nextVersion,
         JSON.stringify(input.graph), JSON.stringify(validation)],
      );
      const workflowVersionId = wf.rows[0]!.id;

      const created: { key: string; taskId: string }[] = [];
      if (input.instantiate) {
        const order = topologicalOrder(input.graph);
        const byKey = new Map(input.graph.nodes.map((n) => [n.key, n]));
        const taskIdByKey = new Map<string, string>();

        for (const key of order) {
          const node = byKey.get(key);
          if (node === undefined) continue;

          // Resolve an active agent for the node's role, if one exists. A node
          // with no available agent is created unassigned rather than silently
          // dropped, so the gap is visible in the board.
          let agentId: string | null = null;
          if (node.roleId !== undefined) {
            const agent = await client.query<{ id: string }>(
              `SELECT id FROM agent_instance
                WHERE workspace_id = $1 AND template_id = $2 AND status = 'active'
                ORDER BY created_at LIMIT 1`,
              [input.workspaceId, node.roleId],
            );
            agentId = agent.rows[0]?.id ?? null;
          }

          const incoming = input.graph.edges
            .filter((e) => e.to === key && e.kind === 'sequence')
            .map((e) => taskIdByKey.get(e.from))
            .filter((v): v is string => v !== undefined);

          const state = incoming.length > 0 ? 'waiting_dependency' : 'queued';
          // Structural nodes need their graph configuration at execution time,
          // so it travels with the task rather than being re-read from the graph.
          const nodeConfig = {
            roleId: node.roleId ?? null,
            condition: node.condition ?? null,
            timerSeconds: node.timerSeconds ?? null,
            reviewsNodeKey: node.reviewsNodeKey ?? null,
          };
          const row = await client.query<{ id: string }>(
            `INSERT INTO task (workspace_id, project_id, workflow_version_id, node_key,
               title, instruction, node_kind, state, assigned_agent_id, priority, node_config)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
            [
              input.workspaceId, input.projectId, workflowVersionId, key,
              node.title, node.instruction, node.kind, state, agentId,
              order.indexOf(key) * 10, JSON.stringify(nodeConfig),
            ],
          );
          const taskId = row.rows[0]!.id;
          taskIdByKey.set(key, taskId);
          created.push({ key, taskId });

          for (const dep of incoming) {
            await client.query(
              'INSERT INTO task_dependency (task_id, depends_on_task_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
              [taskId, dep],
            );
          }
          await appendEvent(client, {
            workspaceId: input.workspaceId, projectId: input.projectId, taskId,
            type: 'task.created', actorKind: 'system', actorLabel: 'Workflow engine',
            dataLabel: 'OWNER_CONFIRMED_ACTUAL',
            summary: `Instantiated "${node.title}" from workflow ${input.name} v${nextVersion}`,
            detail: {
              nodeKey: key, nodeKind: node.kind, roleId: node.roleId ?? null,
              roleTitle: node.roleId !== undefined ? ROLE_BY_ID.get(node.roleId)?.title ?? null : null,
              assigned: agentId !== null,
            },
          });
        }
      }
      return { workflowVersionId, version: nextVersion, validation, tasks: created };
    });
  });

  app.post<{ Params: { id: string } }>('/api/runs/:id/cancel', async (request, reply) => {
    return withTransaction(async (client) => {
      const row = await client.query<{ workspace_id: string }>(
        'SELECT workspace_id FROM run WHERE id = $1', [request.params.id],
      );
      const r = row.rows[0];
      if (r === undefined) { reply.code(404); return { error: 'Run not found' }; }
      await revokeLease(client, r.workspace_id, request.params.id, 'lease_revoked');
      return { cancelled: true };
    });
  });
}
