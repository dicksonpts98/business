import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  DEFAULT_SCORING_POLICY, assessDeliveryWindow, auditScenarioSet, computeBreakEven,
  computeCashExposure, computeContribution, computeLandedCost, computeSellThrough,
  isPrivilegedTool, runScenarioSet, scoreOpportunity,
} from '@sqhq/shared';
import { query, withTransaction } from '../db/pool.js';
import { hashApprovalPayload } from '../approvals/hash.js';
import { invalidateApprovalsForChangedContent } from '../approvals/enforce.js';
import { appendEvent } from '../events/append.js';
import { setTaskState } from '../orchestrator/queue.js';

const ApprovalPayloadSchema = z.object({
  tool: z.string().min(1),
  action: z.string().min(1),
  destination: z.string().nullable(),
  content: z.string().nullable(),
  amountMinor: z.number().int().nullable(),
  currency: z.string().nullable(),
  productRef: z.string().nullable(),
  quantity: z.number().int().nullable(),
  supplierRef: z.string().nullable(),
  expiresAt: z.string().min(1),
});

export async function registerGovernanceRoutes(app: FastifyInstance): Promise<void> {
  /* --------------------------------------------------------------- approvals */

  app.get<{ Querystring: { workspaceId: string; state?: string } }>(
    '/api/approvals', async (request) => {
      const approvals = await query(
        `SELECT a.*, t.title AS task_title, p.name AS project_name
           FROM approval a
           LEFT JOIN task t ON t.id = a.task_id
           LEFT JOIN project p ON p.id = a.project_id
          WHERE a.workspace_id = $1
            AND ($2::text IS NULL OR a.state = $2)
          ORDER BY a.created_at DESC LIMIT 200`,
        [request.query.workspaceId, request.query.state ?? null],
      );
      return { approvals };
    });

  /**
   * Request an approval. An agent may request; only the owner may grant. The
   * payload is hashed on arrival, and that hash is what the enforcement path
   * matches at execution time.
   */
  app.post('/api/approvals', async (request, reply) => {
    const Body = z.object({
      workspaceId: z.string().uuid(),
      projectId: z.string().uuid().nullable().default(null),
      taskId: z.string().uuid().nullable().default(null),
      requestedByRunId: z.string().uuid().nullable().default(null),
      payload: ApprovalPayloadSchema,
    });
    const parsed = Body.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid approval request', issues: parsed.error.issues });
    const input = parsed.data;

    if (!isPrivilegedTool(input.payload.tool)) {
      return reply.code(400).send({
        error: `${input.payload.tool} is not a privileged tool and does not require approval. Requesting one would teach the owner to rubber-stamp.`,
      });
    }

    const hash = hashApprovalPayload(input.payload as Parameters<typeof hashApprovalPayload>[0]);
    return withTransaction(async (client) => {
      const row = await client.query<{ id: string }>(
        `INSERT INTO approval (workspace_id, project_id, task_id, requested_by_run_id,
           tool_name, payload, payload_hash, state, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8) RETURNING id`,
        [input.workspaceId, input.projectId, input.taskId, input.requestedByRunId,
         input.payload.tool, JSON.stringify(input.payload), hash, input.payload.expiresAt],
      );
      const approvalId = row.rows[0]!.id;
      await appendEvent(client, {
        workspaceId: input.workspaceId, projectId: input.projectId, taskId: input.taskId,
        runId: input.requestedByRunId, type: 'approval.requested',
        actorKind: 'agent', actorLabel: 'Agent', dataLabel: 'OWNER_CONFIRMED_ACTUAL',
        summary: `Approval requested for ${input.payload.tool}: ${input.payload.action}`,
        detail: { approvalId, payloadHash: hash, expiresAt: input.payload.expiresAt },
      });
      return { approvalId, payloadHash: hash };
    });
  });

  /**
   * Grant or reject.
   *
   * The grant carries the payload hash the owner believes they are approving.
   * If it no longer matches what is stored, the grant is refused: that mismatch
   * means the content changed between display and decision, and consent to the
   * old content is not consent to the new.
   */
  app.post<{ Params: { id: string } }>('/api/approvals/:id/decide', async (request, reply) => {
    const Body = z.object({
      decision: z.enum(['granted', 'rejected']),
      note: z.string().optional(),
      /** Hash of the payload as shown to the owner. */
      expectedPayloadHash: z.string().min(16),
    });
    const parsed = Body.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid decision', issues: parsed.error.issues });
    const { decision, note, expectedPayloadHash } = parsed.data;

    return withTransaction(async (client) => {
      const row = await client.query<{
        workspace_id: string; project_id: string | null; task_id: string | null;
        tool_name: string; payload_hash: string; state: string; expires_at: Date;
      }>(
        'SELECT workspace_id, project_id, task_id, tool_name, payload_hash, state, expires_at FROM approval WHERE id = $1 FOR UPDATE',
        [request.params.id],
      );
      const a = row.rows[0];
      if (a === undefined) { reply.code(404); return { error: 'Approval not found' }; }
      if (a.state !== 'pending') {
        reply.code(409);
        return { error: `Approval is already ${a.state}.` };
      }
      if (a.payload_hash !== expectedPayloadHash) {
        reply.code(409);
        return {
          error: 'The approval content changed since it was displayed. The decision was NOT recorded. Re-read the action and decide again.',
          storedHash: a.payload_hash,
        };
      }
      if (a.expires_at.getTime() <= Date.now()) {
        await client.query(`UPDATE approval SET state = 'expired' WHERE id = $1`, [request.params.id]);
        reply.code(409);
        return { error: 'Approval expired before a decision was recorded.' };
      }

      await client.query(
        `UPDATE approval SET state = $2, decided_at = now(), decision_note = $3 WHERE id = $1`,
        [request.params.id, decision, note ?? null],
      );
      await appendEvent(client, {
        workspaceId: a.workspace_id, projectId: a.project_id, taskId: a.task_id,
        type: decision === 'granted' ? 'approval.granted' : 'approval.rejected',
        actorKind: 'owner', actorLabel: 'Owner', dataLabel: 'OWNER_CONFIRMED_ACTUAL',
        summary: `Owner ${decision} ${a.tool_name}`,
        detail: { approvalId: request.params.id, note: note ?? null, payloadHash: a.payload_hash },
      });
      await client.query(
        `INSERT INTO audit_entry (workspace_id, actor_kind, actor_label, action, subject_kind, subject_id, after)
         VALUES ($1,'owner','Owner',$2,'approval',$3,$4)`,
        [a.workspace_id, `approval.${decision}`, request.params.id,
         JSON.stringify({ note: note ?? null, payloadHash: a.payload_hash })],
      );

      if (decision === 'granted' && a.task_id !== null) {
        const task = await client.query<{ state: string }>('SELECT state FROM task WHERE id = $1', [a.task_id]);
        if (task.rows[0]?.state === 'waiting_approval') {
          await setTaskState(client, a.workspace_id, a.task_id, 'queued', {
            actorLabel: 'Owner', actorKind: 'owner',
            reason: 'Owner granted the scoped approval; the workflow resumes from its saved version.',
          });
        }
      }
      return { state: decision };
    });
  });

  /**
   * Edit a pending or granted action's content. This invalidates the approval
   * by design: the whole point of binding consent to a hash is that editing
   * the content withdraws the consent.
   */
  app.post<{ Params: { id: string } }>('/api/approvals/:id/amend', async (request, reply) => {
    const Body = z.object({ payload: ApprovalPayloadSchema });
    const parsed = Body.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid payload', issues: parsed.error.issues });

    return withTransaction(async (client) => {
      const row = await client.query<{
        workspace_id: string; project_id: string | null; task_id: string | null; state: string; tool_name: string;
      }>(
        'SELECT workspace_id, project_id, task_id, state, tool_name FROM approval WHERE id = $1 FOR UPDATE',
        [request.params.id],
      );
      const a = row.rows[0];
      if (a === undefined) { reply.code(404); return { error: 'Approval not found' }; }
      if (a.state === 'consumed') {
        reply.code(409);
        return { error: 'This approval was already used; the action has been dispatched and cannot be amended.' };
      }

      await client.query(
        `UPDATE approval SET state = 'invalidated',
                invalidated_reason = 'Content was amended after the approval was created. Consent does not carry over to new content.'
          WHERE id = $1`,
        [request.params.id],
      );
      const newHash = hashApprovalPayload(parsed.data.payload as Parameters<typeof hashApprovalPayload>[0]);
      const replacement = await client.query<{ id: string }>(
        `INSERT INTO approval (workspace_id, project_id, task_id, tool_name, payload,
           payload_hash, state, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,'pending',$7) RETURNING id`,
        [a.workspace_id, a.project_id, a.task_id, parsed.data.payload.tool,
         JSON.stringify(parsed.data.payload), newHash, parsed.data.payload.expiresAt],
      );
      await appendEvent(client, {
        workspaceId: a.workspace_id, projectId: a.project_id, taskId: a.task_id,
        type: 'approval.invalidated', actorKind: 'owner', actorLabel: 'Owner',
        dataLabel: 'OWNER_CONFIRMED_ACTUAL',
        summary: `Approval for ${a.tool_name} invalidated by an amendment. A fresh approval is required for the new content.`,
        detail: { previousApprovalId: request.params.id, replacementApprovalId: replacement.rows[0]!.id, newHash },
      });
      return {
        invalidatedApprovalId: request.params.id,
        replacementApprovalId: replacement.rows[0]!.id,
        payloadHash: newHash,
      };
    });
  });

  /** Invalidate every approval attached to a task whose draft changed. */
  app.post<{ Params: { id: string }; Body: { reason: string } }>(
    '/api/tasks/:id/invalidate-approvals', async (request) => {
      return withTransaction(async (client) => {
        const t = await client.query<{ workspace_id: string }>(
          'SELECT workspace_id FROM task WHERE id = $1', [request.params.id],
        );
        const workspaceId = t.rows[0]?.workspace_id;
        if (workspaceId === undefined) return { invalidated: [] };
        const ids = await invalidateApprovalsForChangedContent(
          client, workspaceId, request.params.id, request.body.reason,
        );
        if (ids.length > 0) {
          await appendEvent(client, {
            workspaceId, taskId: request.params.id, type: 'approval.invalidated',
            actorKind: 'system', actorLabel: 'Content guard',
            dataLabel: 'OWNER_CONFIRMED_ACTUAL',
            summary: `${ids.length} approval(s) invalidated: ${request.body.reason}`,
            detail: { approvalIds: ids },
          });
        }
        return { invalidated: ids };
      });
    });

  /* ------------------------------------------------------ evidence, artifacts */

  app.get<{ Querystring: { projectId?: string; workspaceId?: string } }>(
    '/api/evidence', async (request) => {
      const evidence = await query(
        `SELECT * FROM evidence
          WHERE ($1::uuid IS NULL OR project_id = $1)
            AND ($2::uuid IS NULL OR workspace_id = $2)
          ORDER BY fetched_at DESC LIMIT 500`,
        [request.query.projectId ?? null, request.query.workspaceId ?? null],
      );
      return { evidence };
    });

  app.get<{ Querystring: { projectId?: string; workspaceId?: string; kind?: string } }>(
    '/api/artifacts', async (request) => {
      const artifacts = await query(
        `SELECT * FROM artifact_version
          WHERE ($1::uuid IS NULL OR project_id = $1)
            AND ($2::uuid IS NULL OR workspace_id = $2)
            AND ($3::text IS NULL OR kind = $3)
          ORDER BY created_at DESC LIMIT 300`,
        [request.query.projectId ?? null, request.query.workspaceId ?? null, request.query.kind ?? null],
      );
      return { artifacts };
    });

  app.get<{ Querystring: { workspaceId: string } }>('/api/opportunities', async (request) => {
    const opportunities = await query(
      'SELECT * FROM opportunity WHERE workspace_id = $1 ORDER BY created_at',
      [request.query.workspaceId],
    );
    return { opportunities };
  });

  app.get<{ Querystring: { workspaceId: string } }>('/api/suppliers', async (request) => {
    const suppliers = await query(
      `SELECT s.*, (SELECT json_agg(q.*) FROM quote q WHERE q.supplier_id = s.id) AS quotes
         FROM supplier s WHERE s.workspace_id = $1 ORDER BY s.name`,
      [request.query.workspaceId],
    );
    return { suppliers };
  });

  app.get<{ Querystring: { workspaceId: string } }>('/api/compliance', async (request) => {
    const issues = await query(
      'SELECT * FROM compliance_issue WHERE workspace_id = $1 ORDER BY topic',
      [request.query.workspaceId],
    );
    return {
      issues,
      disclaimer: 'This is a research register produced by a research assistant. It is not legal advice, not a regulatory determination, and confers no authorisation. Items requiring professional review are marked as such.',
    };
  });

  app.get<{ Querystring: { workspaceId: string } }>('/api/cost-scenarios', async (request) => {
    const scenarios = await query(
      'SELECT * FROM cost_scenario WHERE workspace_id = $1 ORDER BY opportunity_id, kind',
      [request.query.workspaceId],
    );
    return { scenarios };
  });

  app.get<{ Querystring: { workspaceId: string } }>('/api/agent-costs', async (request) => {
    const costs = await query(
      `SELECT a.name, a.template_id, count(r.id) AS runs,
              sum(coalesce(r.input_tokens,0)) AS input_tokens,
              sum(coalesce(r.output_tokens,0)) AS output_tokens,
              sum(coalesce(r.cost_usd,0)) AS cost_usd,
              bool_and(coalesce(r.cost_measured,false)) AS all_measured
         FROM agent_instance a LEFT JOIN run r ON r.agent_id = a.id
        WHERE a.workspace_id = $1 GROUP BY a.id, a.name, a.template_id ORDER BY a.name`,
      [request.query.workspaceId],
    );
    return {
      costs,
      note: 'Token counts are reported by the provider where available. Currency cost is only shown when the provider reports it; it is never derived from a guessed price table.',
    };
  });

  /* ----------------------------------------------------------------- finance */

  /**
   * Finance endpoints are thin wrappers over the deterministic engine. No model
   * is involved: the same inputs always produce the same figures, and every
   * result carries its own auditable trace and diagnostics.
   */
  app.post('/api/finance/landed-cost', async (request, reply) => {
    try {
      return { result: computeLandedCost((request.body as { input: Parameters<typeof computeLandedCost>[0] }).input) };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'invalid input' });
    }
  });

  app.post('/api/finance/contribution', async (request, reply) => {
    try {
      const body = request.body as {
        input: Parameters<typeof computeContribution>[0];
        fixed?: Parameters<typeof computeBreakEven>[1];
      };
      const contribution = computeContribution(body.input);
      const breakEven = body.fixed === undefined ? null : computeBreakEven(contribution, body.fixed);
      return { contribution, breakEven };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'invalid input' });
    }
  });

  app.post('/api/finance/scenarios', async (request, reply) => {
    try {
      const body = request.body as {
        base: Parameters<typeof runScenarioSet>[0];
        scenarios: Parameters<typeof runScenarioSet>[1];
      };
      const results = runScenarioSet(body.base, body.scenarios);
      return { results, audit: auditScenarioSet(results) };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'invalid input' });
    }
  });

  app.post('/api/finance/cash-exposure', async (request, reply) => {
    try {
      return { result: computeCashExposure((request.body as { input: Parameters<typeof computeCashExposure>[0] }).input) };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'invalid input' });
    }
  });

  app.post('/api/finance/sell-through', async (request, reply) => {
    try {
      const body = request.body as {
        input: Parameters<typeof computeSellThrough>[0];
        window?: Parameters<typeof assessDeliveryWindow>[0];
      };
      return {
        sellThrough: computeSellThrough(body.input),
        deliveryWindow: body.window === undefined ? null : assessDeliveryWindow(body.window),
      };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'invalid input' });
    }
  });

  app.post('/api/score/opportunity', async (request, reply) => {
    try {
      const body = request.body as {
        scores: Parameters<typeof scoreOpportunity>[0];
        policy?: Parameters<typeof scoreOpportunity>[1];
      };
      return { result: scoreOpportunity(body.scores, body.policy ?? DEFAULT_SCORING_POLICY) };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'invalid input' });
    }
  });
}
