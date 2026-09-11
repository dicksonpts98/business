import type { FastifyInstance } from 'fastify';
import { ROLE_TEMPLATES, ZONE_LAYOUT, type AgentPresence, type AgentActivity, type Zone } from '@sqhq/shared';
import { type AppConfig, providerStatus } from '../config.js';
import { query, withTransaction } from '../db/pool.js';
import { latestSeq, readEventsAfter } from '../events/append.js';
import { getPool } from '../db/pool.js';
import { appendEvent } from '../events/append.js';
import { streamEvents } from '../events/sse.js';
import type { ModelProvider } from '../providers/index.js';

export async function registerCoreRoutes(
  app: FastifyInstance, config: AppConfig, provider: ModelProvider,
): Promise<void> {
  /**
   * Honest capability report. This is the endpoint the UI's DEMO/LIVE badge and
   * connection-health indicator read; it never claims a capability the build
   * does not have.
   */
  app.get('/api/health', async () => {
    const workspaces = await query<{ id: string; name: string; execution_mode: string; emergency_stop_engaged: boolean }>(
      'SELECT id, name, execution_mode, emergency_stop_engaged FROM workspace ORDER BY created_at LIMIT 1',
    );
    const connectors = await query<{ kind: string; display_name: string; health: string; health_detail: string | null }>(
      'SELECT kind, display_name, health, health_detail FROM connector ORDER BY display_name',
    );
    return {
      ok: true,
      executionMode: config.executionMode,
      providerStatus: providerStatus(config),
      providerReportedStatus: provider.status(),
      workspace: workspaces[0] ?? null,
      connectors,
      implemented: {
        modelProviders: ['demo (deterministic)', 'anthropic'],
        unimplemented: [
          'openai-compatible model endpoint (declared in config, adapter not built)',
          'web search provider (web.search reports itself unavailable rather than inventing results)',
          'Shopify / accounting / email / supplier APIs (no real connector; privileged actions reach a recording test adapter only)',
        ],
      },
    };
  });

  app.get('/api/role-templates', async () => ROLE_TEMPLATES);
  app.get('/api/zones', async () => ZONE_LAYOUT);

  /** Paged event history, for rebuilding state after a refresh. */
  app.get<{ Querystring: { workspaceId: string; afterSeq?: string; limit?: string } }>(
    '/api/events', async (request) => {
      const afterSeq = Number(request.query.afterSeq ?? '0');
      const limit = Math.min(Number(request.query.limit ?? '500'), 1000);
      const events = await readEventsAfter(getPool(), request.query.workspaceId, afterSeq, limit);
      const head = await latestSeq(getPool(), request.query.workspaceId);
      return { events, latestSeq: head, hasMore: events.length === limit };
    });

  app.get('/api/events/stream', streamEvents);

  /**
   * Scene presence. The 3D office subscribes to the same events as every other
   * view and reads this for initial state; there is no separate activity engine
   * generating motion that the backend does not know about.
   */
  app.get<{ Querystring: { workspaceId: string } }>('/api/scene/presence', async (request) => {
    const rows = await query<{
      agent_id: string; name: string; template_id: string; status: string;
      task_id: string | null; task_title: string | null; task_state: string | null;
      waiting_reason: string | null; run_id: string | null; run_state: string | null;
      run_started_at: Date | null; model: string | null; cost_usd: string | null;
      cost_measured: boolean | null; error_message: string | null;
      approval_id: string | null; tools_used: string[] | null;
    }>(
      `SELECT a.id AS agent_id, a.name, a.template_id, a.status,
              t.id AS task_id, t.title AS task_title, t.state AS task_state, t.waiting_reason,
              r.id AS run_id, r.state AS run_state, r.started_at AS run_started_at,
              r.model, r.cost_usd, r.cost_measured, r.error_message,
              ap.id AS approval_id,
              (SELECT array_agg(DISTINCT tc.tool_name) FROM tool_call tc WHERE tc.run_id = r.id) AS tools_used
         FROM agent_instance a
         LEFT JOIN task t ON t.assigned_agent_id = a.id
              AND t.state IN ('running','waiting_approval','waiting_input','waiting_dependency')
         LEFT JOIN run r ON r.task_id = t.id AND r.state = 'leased'
         LEFT JOIN approval ap ON ap.task_id = t.id AND ap.state = 'pending'
        WHERE a.workspace_id = $1
        ORDER BY a.name`,
      [request.query.workspaceId],
    );

    const homeZone = new Map(ROLE_TEMPLATES.map((r) => [r.id, r.homeZone]));
    const presence: AgentPresence[] = rows.map((row) => {
      let activity: AgentActivity;
      if (row.status === 'archived') activity = { kind: 'archived' };
      else if (row.status === 'paused') activity = { kind: 'paused' };
      else if (row.error_message !== null && row.task_state === 'failed') {
        activity = { kind: 'errored', taskId: row.task_id ?? '', error: row.error_message };
      } else if (row.task_state === 'waiting_approval') {
        activity = { kind: 'waiting_approval', taskId: row.task_id ?? '', approvalId: row.approval_id ?? '' };
      } else if (row.task_state === 'waiting_input') {
        activity = { kind: 'waiting_input', taskId: row.task_id ?? '', question: row.waiting_reason ?? 'Input required.' };
      } else if (row.task_state === 'waiting_dependency') {
        activity = { kind: 'waiting_dependency', taskId: row.task_id ?? '', blockedBy: [] };
      } else if (row.task_state === 'running' && row.task_title !== null) {
        activity = { kind: 'working', taskId: row.task_id ?? '', summary: row.task_title };
      } else {
        activity = { kind: 'idle' };
      }
      return {
        agentId: row.agent_id,
        name: row.name,
        roleId: row.template_id,
        zone: (homeZone.get(row.template_id) ?? 'projectMeetingRoom') as Zone,
        activity,
        toolsUsed: (row.tools_used ?? []) as AgentPresence['toolsUsed'],
        elapsedMs: row.run_started_at === null ? null : Date.now() - row.run_started_at.getTime(),
        model: row.model,
        cost: row.cost_usd === null ? null
          : { amountUsd: row.cost_usd, measured: row.cost_measured === true },
      };
    });
    return { presence };
  });

  /**
   * Emergency stop. Prevents NEW external calls immediately. It deliberately
   * reports actions already dispatched instead of claiming to have recalled
   * them, because a message already sent cannot be unsent.
   */
  app.post<{ Body: { workspaceId: string; engaged: boolean; reason?: string } }>(
    '/api/workspace/emergency-stop', async (request) => {
      const { workspaceId, engaged, reason } = request.body;
      return withTransaction(async (client) => {
        await client.query(
          'UPDATE workspace SET emergency_stop_engaged = $2, emergency_stop_reason = $3 WHERE id = $1',
          [workspaceId, engaged, engaged ? (reason ?? 'Engaged by owner.') : null],
        );
        const inFlight = await client.query<{ key: string; tool_name: string; outcome_state: string; external_ref: string | null }>(
          `SELECT key, tool_name, outcome_state, external_ref FROM idempotency_key
            WHERE workspace_id = $1 AND outcome_state IN ('in_flight','uncertain','succeeded')
            ORDER BY created_at DESC LIMIT 50`,
          [workspaceId],
        );
        await appendEvent(client, {
          workspaceId, type: engaged ? 'emergency_stop.engaged' : 'emergency_stop.cleared',
          actorKind: 'owner', actorLabel: 'Owner', dataLabel: 'OWNER_CONFIRMED_ACTUAL',
          summary: engaged
            ? 'Emergency stop engaged. No new external actions will be dispatched.'
            : 'Emergency stop cleared.',
          detail: { reason: reason ?? null, alreadyDispatchedCount: inFlight.rows.length },
        });
        return {
          engaged,
          alreadyDispatched: inFlight.rows,
          note: engaged
            ? 'New external calls are blocked. The actions listed were already dispatched and must be reconciled against the destination before any retry: this application cannot unsend them.'
            : 'Emergency stop cleared.',
        };
      });
    });
}
