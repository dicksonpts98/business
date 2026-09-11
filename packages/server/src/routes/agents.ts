import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ROLE_BY_ID, ROLE_TEMPLATES, isKnownTool } from '@sqhq/shared';
import { query, withTransaction } from '../db/pool.js';
import { appendEvent } from '../events/append.js';
import { revokeLease, setTaskState } from '../orchestrator/queue.js';

const CreateAgent = z.object({
  workspaceId: z.string().uuid(),
  templateId: z.string().min(1),
  name: z.string().min(1),
  instructions: z.string().default(''),
  appearance: z.record(z.string(), z.unknown()).default({}),
  model: z.string().nullable().default(null),
  provider: z.string().nullable().default(null),
  allowedTools: z.array(z.string()).optional(),
  maxRunSeconds: z.number().int().min(10).max(3600).default(300),
  maxToolCalls: z.number().int().min(1).max(200).default(25),
  department: z.string().nullable().default(null),
  reviewOfRoleIds: z.array(z.string()).default([]),
  assignedProjectIds: z.array(z.string().uuid()).default([]),
});

const UpdateAgent = z.object({
  instructions: z.string().optional(),
  appearance: z.record(z.string(), z.unknown()).optional(),
  model: z.string().nullable().optional(),
  provider: z.string().nullable().optional(),
  allowedTools: z.array(z.string()).optional(),
  maxRunSeconds: z.number().int().min(10).max(3600).optional(),
  maxToolCalls: z.number().int().min(1).max(200).optional(),
  department: z.string().nullable().optional(),
  reviewOfRoleIds: z.array(z.string()).optional(),
  assignedProjectIds: z.array(z.string().uuid()).optional(),
  name: z.string().min(1).optional(),
});

/** Archive dispositions for an agent's in-flight work. */
const ARCHIVE_DISPOSITIONS = ['finish_current_task', 'cancel_and_reassign', 'pause_dependent_work'] as const;

const ArchiveAgent = z.object({
  disposition: z.enum(ARCHIVE_DISPOSITIONS),
  /** Required for cancel_and_reassign: who picks the work up. */
  reassignToAgentId: z.string().uuid().nullable().default(null),
});

export async function registerAgentRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { workspaceId: string } }>('/api/agents', async (request) => {
    const agents = await query(
      `SELECT a.id, a.name, a.template_id, a.status, a.created_at, a.archived_at,
              c.id AS config_version_id, c.version AS config_version,
              c.instructions, c.allowed_tools, c.model, c.provider,
              c.max_run_seconds, c.max_tool_calls, c.department,
              c.review_of_role_ids, c.assigned_project_ids, c.appearance
         FROM agent_instance a
         LEFT JOIN agent_config_version c ON c.id = a.current_config_version_id
        WHERE a.workspace_id = $1
        ORDER BY a.status, a.name`,
      [request.query.workspaceId],
    );
    return { agents };
  });

  /** Full config history: an audit trail of what each run actually ran under. */
  app.get<{ Params: { id: string } }>('/api/agents/:id/config-versions', async (request) => {
    const versions = await query(
      `SELECT id, version, instructions, allowed_tools, model, provider,
              max_run_seconds, max_tool_calls, department, created_at
         FROM agent_config_version WHERE agent_id = $1 ORDER BY version DESC`,
      [request.params.id],
    );
    return { versions };
  });

  app.post('/api/agents', async (request, reply) => {
    const parsed = CreateAgent.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid agent', issues: parsed.error.issues });
    }
    const input = parsed.data;

    // A custom role is allowed, but it must name a template that exists. Adding
    // a "Punjabi Copy Reviewer" means creating a template row, not a code change.
    const template = ROLE_BY_ID.get(input.templateId);
    const dbTemplate = await query<{ id: string; default_tools: string[] }>(
      'SELECT id, default_tools FROM agent_template WHERE id = $1', [input.templateId],
    );
    if (template === undefined && dbTemplate.length === 0) {
      return reply.code(400).send({
        error: `Unknown role template "${input.templateId}".`,
        available: ROLE_TEMPLATES.map((r) => r.id),
      });
    }

    const requestedTools = input.allowedTools
      ?? template?.defaultTools
      ?? dbTemplate[0]?.default_tools
      ?? [];
    const unknownTools = requestedTools.filter((t) => !isKnownTool(t));
    if (unknownTools.length > 0) {
      return reply.code(400).send({
        error: `Unknown tools: ${unknownTools.join(', ')}. Permissions must name catalogued tools.`,
      });
    }

    return withTransaction(async (client) => {
      const agent = await client.query<{ id: string }>(
        `INSERT INTO agent_instance (workspace_id, template_id, name, status)
         VALUES ($1,$2,$3,'active') RETURNING id`,
        [input.workspaceId, input.templateId, input.name],
      );
      const agentId = agent.rows[0]!.id;
      const config = await client.query<{ id: string }>(
        `INSERT INTO agent_config_version (agent_id, version, instructions, appearance,
           model, provider, allowed_tools, max_run_seconds, max_tool_calls,
           department, review_of_role_ids, assigned_project_ids)
         VALUES ($1,1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [
          agentId, input.instructions, JSON.stringify(input.appearance), input.model,
          input.provider, requestedTools, input.maxRunSeconds, input.maxToolCalls,
          input.department, input.reviewOfRoleIds, input.assignedProjectIds,
        ],
      );
      await client.query('UPDATE agent_instance SET current_config_version_id = $2 WHERE id = $1',
        [agentId, config.rows[0]!.id]);
      await appendEvent(client, {
        workspaceId: input.workspaceId, type: 'agent.created', actorKind: 'owner',
        actorLabel: 'Owner', dataLabel: 'OWNER_CONFIRMED_ACTUAL',
        summary: `Created agent "${input.name}" (${input.templateId})`,
        detail: { agentId, templateId: input.templateId, allowedTools: requestedTools },
      });
      return { agentId, configVersionId: config.rows[0]!.id, version: 1 };
    });
  });

  /** Clone: a new agent with the source's current configuration as version 1. */
  app.post<{ Params: { id: string }; Body: { name: string } }>(
    '/api/agents/:id/clone', async (request, reply) => {
      const source = await query<{
        workspace_id: string; template_id: string; instructions: string;
        appearance: unknown; model: string | null; provider: string | null;
        allowed_tools: string[]; max_run_seconds: number; max_tool_calls: number;
        department: string | null; review_of_role_ids: string[]; assigned_project_ids: string[];
      }>(
        `SELECT a.workspace_id, a.template_id, c.instructions, c.appearance, c.model,
                c.provider, c.allowed_tools, c.max_run_seconds, c.max_tool_calls,
                c.department, c.review_of_role_ids, c.assigned_project_ids
           FROM agent_instance a
           JOIN agent_config_version c ON c.id = a.current_config_version_id
          WHERE a.id = $1`,
        [request.params.id],
      );
      const s = source[0];
      if (s === undefined) return reply.code(404).send({ error: 'Agent not found' });

      return withTransaction(async (client) => {
        const agent = await client.query<{ id: string }>(
          `INSERT INTO agent_instance (workspace_id, template_id, name, status)
           VALUES ($1,$2,$3,'active') RETURNING id`,
          [s.workspace_id, s.template_id, request.body.name],
        );
        const agentId = agent.rows[0]!.id;
        const config = await client.query<{ id: string }>(
          `INSERT INTO agent_config_version (agent_id, version, instructions, appearance,
             model, provider, allowed_tools, max_run_seconds, max_tool_calls,
             department, review_of_role_ids, assigned_project_ids)
           VALUES ($1,1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
          [agentId, s.instructions, JSON.stringify(s.appearance), s.model, s.provider,
           s.allowed_tools, s.max_run_seconds, s.max_tool_calls, s.department,
           s.review_of_role_ids, s.assigned_project_ids],
        );
        await client.query('UPDATE agent_instance SET current_config_version_id = $2 WHERE id = $1',
          [agentId, config.rows[0]!.id]);
        await appendEvent(client, {
          workspaceId: s.workspace_id, type: 'agent.created', actorKind: 'owner',
          actorLabel: 'Owner', dataLabel: 'OWNER_CONFIRMED_ACTUAL',
          summary: `Cloned agent "${request.body.name}" from ${request.params.id}`,
          detail: { agentId, clonedFrom: request.params.id },
        });
        return { agentId, configVersionId: config.rows[0]!.id, version: 1 };
      });
    });

  /**
   * Edit an agent. This NEVER mutates a config version: it appends a new one
   * and repoints the agent. Runs already in flight keep the version they
   * started under, so an instruction or permission change cannot alter what an
   * executing attempt is doing.
   */
  app.patch<{ Params: { id: string } }>('/api/agents/:id', async (request, reply) => {
    const parsed = UpdateAgent.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid update', issues: parsed.error.issues });
    }
    const patch = parsed.data;
    if (patch.allowedTools !== undefined) {
      const unknownTools = patch.allowedTools.filter((t) => !isKnownTool(t));
      if (unknownTools.length > 0) {
        return reply.code(400).send({ error: `Unknown tools: ${unknownTools.join(', ')}` });
      }
    }

    return withTransaction(async (client) => {
      const current = await client.query<{
        workspace_id: string; name: string; version: number; instructions: string;
        appearance: unknown; model: string | null; provider: string | null;
        allowed_tools: string[]; max_run_seconds: number; max_tool_calls: number;
        department: string | null; review_of_role_ids: string[]; assigned_project_ids: string[];
      }>(
        `SELECT a.workspace_id, a.name, c.version, c.instructions, c.appearance, c.model,
                c.provider, c.allowed_tools, c.max_run_seconds, c.max_tool_calls,
                c.department, c.review_of_role_ids, c.assigned_project_ids
           FROM agent_instance a
           JOIN agent_config_version c ON c.id = a.current_config_version_id
          WHERE a.id = $1 FOR UPDATE OF a`,
        [request.params.id],
      );
      const c = current.rows[0];
      if (c === undefined) {
        reply.code(404);
        return { error: 'Agent not found' };
      }

      const next = await client.query<{ id: string; version: number }>(
        `INSERT INTO agent_config_version (agent_id, version, instructions, appearance,
           model, provider, allowed_tools, max_run_seconds, max_tool_calls,
           department, review_of_role_ids, assigned_project_ids)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id, version`,
        [
          request.params.id, c.version + 1,
          patch.instructions ?? c.instructions,
          JSON.stringify(patch.appearance ?? c.appearance),
          patch.model === undefined ? c.model : patch.model,
          patch.provider === undefined ? c.provider : patch.provider,
          patch.allowedTools ?? c.allowed_tools,
          patch.maxRunSeconds ?? c.max_run_seconds,
          patch.maxToolCalls ?? c.max_tool_calls,
          patch.department === undefined ? c.department : patch.department,
          patch.reviewOfRoleIds ?? c.review_of_role_ids,
          patch.assignedProjectIds ?? c.assigned_project_ids,
        ],
      );
      await client.query(
        'UPDATE agent_instance SET current_config_version_id = $2, name = $3 WHERE id = $1',
        [request.params.id, next.rows[0]!.id, patch.name ?? c.name],
      );
      await appendEvent(client, {
        workspaceId: c.workspace_id, type: 'agent.updated', actorKind: 'owner',
        actorLabel: 'Owner', dataLabel: 'OWNER_CONFIRMED_ACTUAL',
        summary: `Agent "${patch.name ?? c.name}" updated to config version ${next.rows[0]!.version}. Runs in flight keep version ${c.version}.`,
        detail: { agentId: request.params.id, newVersion: next.rows[0]!.version, previousVersion: c.version },
      });
      return { configVersionId: next.rows[0]!.id, version: next.rows[0]!.version };
    });
  });

  app.post<{ Params: { id: string }; Body: { status: 'paused' | 'active' } }>(
    '/api/agents/:id/status', async (request, reply) => {
      const { status } = request.body;
      if (status !== 'paused' && status !== 'active') {
        return reply.code(400).send({ error: 'status must be "paused" or "active"' });
      }
      return withTransaction(async (client) => {
        const row = await client.query<{ workspace_id: string; name: string; status: string }>(
          'SELECT workspace_id, name, status FROM agent_instance WHERE id = $1 FOR UPDATE',
          [request.params.id],
        );
        const a = row.rows[0];
        if (a === undefined) { reply.code(404); return { error: 'Agent not found' }; }
        if (a.status === 'archived') {
          reply.code(409);
          return { error: 'Archived agents are reactivated with POST /api/agents/:id/reactivate.' };
        }
        await client.query('UPDATE agent_instance SET status = $2 WHERE id = $1', [request.params.id, status]);
        await appendEvent(client, {
          workspaceId: a.workspace_id, type: status === 'paused' ? 'agent.paused' : 'agent.resumed',
          actorKind: 'owner', actorLabel: 'Owner', dataLabel: 'OWNER_CONFIRMED_ACTUAL',
          summary: `Agent "${a.name}" ${status === 'paused' ? 'paused' : 'resumed'}`,
          detail: { agentId: request.params.id },
        });
        return { status };
      });
    });

  /** What archiving this agent would disturb. Shown before the owner chooses. */
  app.get<{ Params: { id: string } }>('/api/agents/:id/archive-impact', async (request) => {
    const activeTasks = await query(
      `SELECT t.id, t.title, t.state,
              (SELECT count(*) FROM task_dependency d WHERE d.depends_on_task_id = t.id) AS dependents
         FROM task t
        WHERE t.assigned_agent_id = $1
          AND t.state IN ('queued','running','waiting_dependency','waiting_input','waiting_approval')
        ORDER BY t.created_at`,
      [request.params.id],
    );
    const reviewDuties = await query(
      `SELECT c.review_of_role_ids
         FROM agent_instance a JOIN agent_config_version c ON c.id = a.current_config_version_id
        WHERE a.id = $1`,
      [request.params.id],
    );
    return {
      activeTasks,
      reviewResponsibilities: reviewDuties[0] ?? null,
      dispositions: ARCHIVE_DISPOSITIONS,
      note: 'Archiving preserves every prior output and audit entry. Removing a reviewer does not remove a required review: the review task remains and must be reassigned.',
    };
  });

  /**
   * Archive an agent.
   *
   * Three properties are load-bearing here:
   *   * Prior outputs and audit history are never deleted.
   *   * A run in flight has its LEASE REVOKED, so the archived agent cannot
   *     keep making tool calls. Work it had already produced is quarantined
   *     for review rather than accepted or discarded.
   *   * Reassignment creates a NEW run identity. It never replays the old run's
   *     external effects, so nothing is dispatched twice.
   */
  app.post<{ Params: { id: string } }>('/api/agents/:id/archive', async (request, reply) => {
    const parsed = ArchiveAgent.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid archive request', issues: parsed.error.issues });
    }
    const { disposition, reassignToAgentId } = parsed.data;
    if (disposition === 'cancel_and_reassign' && reassignToAgentId === null) {
      return reply.code(400).send({
        error: 'cancel_and_reassign requires reassignToAgentId. Work is not silently orphaned.',
      });
    }

    return withTransaction(async (client) => {
      const row = await client.query<{ workspace_id: string; name: string }>(
        'SELECT workspace_id, name FROM agent_instance WHERE id = $1 FOR UPDATE', [request.params.id],
      );
      const agent = row.rows[0];
      if (agent === undefined) { reply.code(404); return { error: 'Agent not found' }; }

      if (reassignToAgentId !== null) {
        const target = await client.query<{ status: string }>(
          'SELECT status FROM agent_instance WHERE id = $1 AND workspace_id = $2',
          [reassignToAgentId, agent.workspace_id],
        );
        if (target.rows[0]?.status !== 'active') {
          reply.code(400);
          return { error: 'Reassignment target must be an active agent in the same workspace.' };
        }
      }

      const tasks = await client.query<{ id: string; title: string; state: string }>(
        `SELECT id, title, state FROM task
          WHERE assigned_agent_id = $1
            AND state IN ('queued','running','waiting_dependency','waiting_input','waiting_approval')
          FOR UPDATE`,
        [request.params.id],
      );

      const actions: { taskId: string; title: string; action: string }[] = [];

      for (const task of tasks.rows) {
        if (disposition === 'finish_current_task' && task.state === 'running') {
          actions.push({ taskId: task.id, title: task.title, action: 'left running to completion' });
          continue;
        }

        // Revoke any live lease so the archived agent stops acting immediately.
        const live = await client.query<{ id: string }>(
          `SELECT id FROM run WHERE task_id = $1 AND state = 'leased'`, [task.id],
        );
        for (const run of live.rows) {
          await revokeLease(client, agent.workspace_id, run.id, 'agent_archived');
        }

        if (disposition === 'cancel_and_reassign') {
          // New assignee, and the task returns to the queue. The next claim
          // opens a NEW run with a new identity; the revoked run's effects are
          // not replayed.
          await client.query('UPDATE task SET assigned_agent_id = $2 WHERE id = $1',
            [task.id, reassignToAgentId]);
          if (task.state === 'running') {
            await setTaskState(client, agent.workspace_id, task.id, 'queued', {
              actorLabel: 'Owner', actorKind: 'owner',
              reason: `Reassigned from archived agent "${agent.name}". A new run will be opened; the revoked run is quarantined.`,
            });
          }
          actions.push({ taskId: task.id, title: task.title, action: 'cancelled and reassigned' });
        } else if (disposition === 'pause_dependent_work') {
          if (task.state === 'running' || task.state === 'queued') {
            await setTaskState(client, agent.workspace_id, task.id, 'waiting_input', {
              actorLabel: 'Owner', actorKind: 'owner',
              reason: `Paused: the assigned agent "${agent.name}" was archived and no replacement was named.`,
            });
          }
          actions.push({ taskId: task.id, title: task.title, action: 'paused pending an owner decision' });
        } else {
          actions.push({ taskId: task.id, title: task.title, action: 'left in place' });
        }
      }

      await client.query(
        `UPDATE agent_instance SET status = 'archived', archived_at = now() WHERE id = $1`,
        [request.params.id],
      );
      await appendEvent(client, {
        workspaceId: agent.workspace_id, type: 'agent.archived', actorKind: 'owner',
        actorLabel: 'Owner', dataLabel: 'OWNER_CONFIRMED_ACTUAL',
        summary: `Archived "${agent.name}" with disposition ${disposition}. ${actions.length} active task(s) handled. All prior outputs retained.`,
        detail: { agentId: request.params.id, disposition, actions, reassignToAgentId },
      });
      await client.query(
        `INSERT INTO audit_entry (workspace_id, actor_kind, actor_label, action, subject_kind, subject_id, after)
         VALUES ($1,'owner','Owner','agent.archived','agent_instance',$2,$3)`,
        [agent.workspace_id, request.params.id, JSON.stringify({ disposition, actions })],
      );
      return { archived: true, disposition, actions };
    });
  });

  app.post<{ Params: { id: string } }>('/api/agents/:id/reactivate', async (request, reply) => {
    return withTransaction(async (client) => {
      const row = await client.query<{ workspace_id: string; name: string; status: string }>(
        'SELECT workspace_id, name, status FROM agent_instance WHERE id = $1 FOR UPDATE',
        [request.params.id],
      );
      const a = row.rows[0];
      if (a === undefined) { reply.code(404); return { error: 'Agent not found' }; }
      await client.query(
        `UPDATE agent_instance SET status = 'active', archived_at = NULL WHERE id = $1`,
        [request.params.id],
      );
      await appendEvent(client, {
        workspaceId: a.workspace_id, type: 'agent.resumed', actorKind: 'owner',
        actorLabel: 'Owner', dataLabel: 'OWNER_CONFIRMED_ACTUAL',
        summary: `Reactivated agent "${a.name}". Its full config and output history are intact.`,
        detail: { agentId: request.params.id },
      });
      return { status: 'active' };
    });
  });
}
