import type { PoolClient } from 'pg';
import { z } from 'zod';
import {
  type ApprovalPayload, type ProvenanceLabel, type ToolName,
  computeContribution, computeLandedCost, isKnownTool, isPrivilegedTool,
} from '@sqhq/shared';
import { enforceToolCall, type RefusalCode } from '../approvals/enforce.js';
import { hashToolRequest } from '../approvals/hash.js';
import { appendEvent } from '../events/append.js';
import { assertFetchAllowed, wrapUntrusted, type UntrustedContent } from './untrusted.js';

export interface ToolContext {
  readonly client: PoolClient;
  readonly workspaceId: string;
  readonly projectId: string | null;
  readonly taskId: string;
  readonly runId: string;
  readonly leaseToken: string;
  readonly agentId: string | null;
  readonly actorLabel: string;
  readonly allowedTools: readonly string[];
  readonly dataLabel: ProvenanceLabel;
  /** Test adapter sink, used instead of a real external integration. */
  readonly externalSink?: ExternalSink;
}

/**
 * Where a privileged action actually goes.
 *
 * This build ships a recording TEST ADAPTER only. There is no real Shopify,
 * email, accounting or supplier API connection, and none is simulated to look
 * connected: the adapter records what WOULD be dispatched, and the connector
 * health table reports `not_configured`. Wiring a real destination is a
 * separate, owner-authorised piece of work.
 */
export interface ExternalSink {
  dispatch(input: {
    readonly tool: ToolName;
    readonly idempotencyKey: string;
    readonly payload: ApprovalPayload;
  }): Promise<{ readonly externalRef: string }>;
}

export type ToolOutcome =
  | { readonly ok: true; readonly result: unknown; readonly externalRef?: string; readonly replayed?: boolean }
  | { readonly ok: false; readonly code: string; readonly reason: string };

export type ToolCallResult =
  | { readonly outcome: 'succeeded'; readonly result: unknown; readonly toolCallId: string; readonly replayed: boolean }
  | { readonly outcome: 'failed'; readonly code: string; readonly reason: string; readonly toolCallId: string }
  | { readonly outcome: 'refused'; readonly code: RefusalCode | string; readonly reason: string; readonly toolCallId: string };

interface ToolDefinition {
  readonly name: ToolName;
  readonly argsSchema: z.ZodType;
  execute(args: unknown, ctx: ToolContext): Promise<ToolOutcome>;
}

/* -------------------------------------------------------------------------- */
/* Unprivileged tools                                                         */
/* -------------------------------------------------------------------------- */

const webFetch: ToolDefinition = {
  name: 'web.fetch',
  argsSchema: z.object({ url: z.string().min(1), purpose: z.string().min(1) }),
  async execute(args, _ctx): Promise<ToolOutcome> {
    const { url } = args as { url: string };
    const decision = await assertFetchAllowed(url);
    if (!decision.allowed) {
      return { ok: false, code: 'FETCH_REFUSED', reason: decision.reason };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(decision.url, {
        signal: controller.signal,
        redirect: 'manual', // A redirect could leave the allowlisted host.
        headers: { accept: 'text/html,text/plain,application/json' },
      });
      if (response.status >= 300 && response.status < 400) {
        return {
          ok: false, code: 'FETCH_REDIRECT_NOT_FOLLOWED',
          reason: `${url} redirected to ${response.headers.get('location') ?? 'an unknown location'}. Redirects are not followed automatically because the target is not re-checked by the caller.`,
        };
      }
      if (!response.ok) {
        return { ok: false, code: 'FETCH_HTTP_ERROR', reason: `HTTP ${response.status} from ${url}` };
      }
      const reader = response.body?.getReader();
      const MAX_BYTES = 2_000_000;
      let received = 0;
      const chunks: Uint8Array[] = [];
      if (reader !== undefined) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value !== undefined) {
            received += value.byteLength;
            if (received > MAX_BYTES) {
              await reader.cancel();
              return { ok: false, code: 'FETCH_TOO_LARGE', reason: `${url} exceeded the 2 MB read limit.` };
            }
            chunks.push(value);
          }
        }
      }
      const text = Buffer.concat(chunks).toString('utf8');
      const content: UntrustedContent = wrapUntrusted(text, decision.url.host, decision.url.toString());
      return { ok: true, result: content };
    } catch (error) {
      return {
        ok: false, code: 'FETCH_FAILED',
        reason: error instanceof Error ? error.message : 'unknown fetch failure',
      };
    } finally {
      clearTimeout(timer);
    }
  },
};

const webSearch: ToolDefinition = {
  name: 'web.search',
  argsSchema: z.object({ query: z.string().min(1) }),
  async execute(): Promise<ToolOutcome> {
    // No search provider is configured in this build. Returning fabricated
    // results here would be the single most damaging dishonesty available to
    // this application, so the tool reports itself unavailable instead.
    return {
      ok: false,
      code: 'TOOL_NOT_CONFIGURED',
      reason: 'No search provider is configured. web.search is unavailable in this build; it does not return invented results. Use web.fetch against a specific URL, or upload documents.',
    };
  },
};

const evidenceRecord: ToolDefinition = {
  name: 'evidence.record',
  argsSchema: z.object({
    claim: z.string().min(1),
    url: z.string().nullable(),
    uploadedDocumentId: z.string().uuid().nullable(),
    title: z.string().min(1),
    publisher: z.string().min(1),
    publishedAt: z.string().nullable(),
    sourceType: z.string().min(1),
    excerpt: z.string().min(1),
    geographicRelevance: z.array(z.string()),
    confidenceRationale: z.string().min(1),
    dataLabel: z.string().min(1),
  }).refine((v) => v.url !== null || v.uploadedDocumentId !== null, {
    message: 'Evidence must cite a URL or an uploaded document. An uncited claim is not evidence.',
  }),
  async execute(args, ctx): Promise<ToolOutcome> {
    const a = args as {
      claim: string; url: string | null; uploadedDocumentId: string | null;
      title: string; publisher: string; publishedAt: string | null; sourceType: string;
      excerpt: string; geographicRelevance: string[]; confidenceRationale: string; dataLabel: string;
    };
    const row = await ctx.client.query<{ id: string }>(
      `INSERT INTO evidence (workspace_id, project_id, claim, url, uploaded_document_id,
         title, publisher, published_at, fetched_at, source_type, excerpt,
         geographic_relevance, confidence_rationale, data_label, recorded_by_run_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now(),$9,$10,$11,$12,$13,$14)
       RETURNING id`,
      [
        ctx.workspaceId, ctx.projectId, a.claim, a.url, a.uploadedDocumentId,
        a.title, a.publisher, a.publishedAt, a.sourceType, a.excerpt,
        a.geographicRelevance, a.confidenceRationale, a.dataLabel, ctx.runId,
      ],
    );
    return { ok: true, result: { evidenceId: row.rows[0]?.id } };
  },
};

const calcFinance: ToolDefinition = {
  name: 'calc.finance',
  argsSchema: z.object({
    kind: z.enum(['landed_cost', 'contribution']),
    input: z.unknown(),
  }),
  async execute(args): Promise<ToolOutcome> {
    // The model supplies inputs; this deterministic code does the arithmetic.
    // No model ever computes a figure that reaches a decision packet.
    const a = args as { kind: 'landed_cost' | 'contribution'; input: unknown };
    try {
      const result = a.kind === 'landed_cost'
        ? computeLandedCost(a.input as Parameters<typeof computeLandedCost>[0])
        : computeContribution(a.input as Parameters<typeof computeContribution>[0]);
      return { ok: true, result };
    } catch (error) {
      return {
        ok: false, code: 'FINANCE_INPUT_INVALID',
        reason: error instanceof Error ? error.message : 'unknown finance error',
      };
    }
  },
};

const draftWrite: ToolDefinition = {
  name: 'draft.write',
  argsSchema: z.object({
    kind: z.string().min(1),
    title: z.string().min(1),
    body: z.unknown(),
    artifactKey: z.string().uuid().optional(),
  }),
  async execute(args, ctx): Promise<ToolOutcome> {
    const a = args as { kind: string; title: string; body: unknown; artifactKey?: string };
    const key = a.artifactKey ?? crypto.randomUUID();
    const next = await ctx.client.query<{ version: number }>(
      'SELECT COALESCE(MAX(version), 0) + 1 AS version FROM artifact_version WHERE artifact_key = $1',
      [key],
    );
    const version = next.rows[0]?.version ?? 1;
    // Append-only: a new version, never an update of the previous one.
    const row = await ctx.client.query<{ id: string }>(
      `INSERT INTO artifact_version (workspace_id, artifact_key, version, project_id,
         task_id, run_id, kind, title, body, data_label, review_state)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'submitted')
       RETURNING id`,
      [
        ctx.workspaceId, key, version, ctx.projectId, ctx.taskId, ctx.runId,
        a.kind, a.title, JSON.stringify(a.body), ctx.dataLabel,
      ],
    );
    return { ok: true, result: { artifactId: row.rows[0]?.id, artifactKey: key, version } };
  },
};

const taskComment: ToolDefinition = {
  name: 'task.comment',
  argsSchema: z.object({ note: z.string().min(1) }),
  async execute(args, ctx): Promise<ToolOutcome> {
    const { note } = args as { note: string };
    await appendEvent(ctx.client, {
      workspaceId: ctx.workspaceId, projectId: ctx.projectId, taskId: ctx.taskId,
      runId: ctx.runId, type: 'task.state_changed', actorKind: 'agent',
      actorId: ctx.agentId, actorLabel: ctx.actorLabel, dataLabel: ctx.dataLabel,
      summary: note.slice(0, 280), detail: { note },
    });
    return { ok: true, result: { recorded: true } };
  },
};

/* -------------------------------------------------------------------------- */
/* Privileged tools — all dispatch through the recording test adapter         */
/* -------------------------------------------------------------------------- */

function privilegedDispatch(name: ToolName): ToolDefinition {
  return {
    name,
    argsSchema: z.object({
      approvalPayload: z.unknown(),
      idempotencyKey: z.string().min(8),
    }),
    async execute(args, ctx): Promise<ToolOutcome> {
      const a = args as { approvalPayload: ApprovalPayload; idempotencyKey: string };
      if (ctx.externalSink === undefined) {
        return {
          ok: false, code: 'CONNECTOR_NOT_CONFIGURED',
          reason: `${name} passed approval enforcement, but no external destination is configured in this build. Nothing was dispatched. This is reported rather than simulated as success.`,
        };
      }
      const dispatched = await ctx.externalSink.dispatch({
        tool: name, idempotencyKey: a.idempotencyKey, payload: a.approvalPayload,
      });
      return { ok: true, result: { dispatched: true }, externalRef: dispatched.externalRef };
    },
  };
}

const DEFINITIONS: ReadonlyMap<string, ToolDefinition> = new Map(
  [
    webFetch, webSearch, evidenceRecord, calcFinance, draftWrite, taskComment,
    privilegedDispatch('message.send.supplier'),
    privilegedDispatch('message.send.customer'),
    privilegedDispatch('order.place'),
    privilegedDispatch('refund.issue'),
    privilegedDispatch('listing.publish'),
    privilegedDispatch('ads.launch'),
    privilegedDispatch('payment.move'),
    privilegedDispatch('contract.sign'),
    privilegedDispatch('filing.submit'),
    privilegedDispatch('social.post'),
  ].map((d) => [d.name, d]),
);

/* -------------------------------------------------------------------------- */
/* The single entry point for every tool call                                 */
/* -------------------------------------------------------------------------- */

/**
 * Execute a tool call.
 *
 * Order is deliberate:
 *
 *   1. Shape validation. A malformed call is rejected without consuming an
 *      approval, so a typo never spends the owner's consent.
 *   2. Idempotency REPLAY CHECK. If this exact (key, request-hash) pair already
 *      completed, the recorded outcome is returned and nothing else happens.
 *      This is a pure read of an effect this workspace already produced: it
 *      dispatches nothing and creates nothing. It must come before approval
 *      consumption, because the first call consumed the approval — so checking
 *      enforcement first would refuse every legitimate retry with
 *      APPROVAL_ALREADY_CONSUMED, and a caller that cannot distinguish "already
 *      done" from "refused" will either duplicate the action through another
 *      path or abandon completed work.
 *   3. Enforcement: emergency stop, lease validity, agent permissions, and
 *      atomic consumption of a content-matched approval.
 *   4. Idempotency registration, then execution, then finalisation.
 *
 * Replay safety therefore has two independent layers: the key check short-
 * circuits known requests, and single-use approval consumption stops an unknown
 * key from spending the same consent twice.
 */
export async function callTool(
  ctx: ToolContext,
  toolName: string,
  rawArgs: unknown,
  approvalPayload: ApprovalPayload | null,
): Promise<ToolCallResult> {
  const privileged = isPrivilegedTool(toolName);

  const record = async (
    outcome: 'succeeded' | 'failed' | 'refused',
    detail: { code?: string; reason?: string; approvalId?: string | null; idempotencyKey?: string | null },
  ): Promise<string> => {
    const row = await ctx.client.query<{ id: string }>(
      `INSERT INTO tool_call (workspace_id, run_id, tool_name, privileged, arguments,
         outcome, refusal_code, refusal_reason, approval_id, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [
        ctx.workspaceId, ctx.runId, toolName, privileged, JSON.stringify(rawArgs ?? {}),
        outcome, detail.code ?? null, detail.reason ?? null,
        detail.approvalId ?? null, detail.idempotencyKey ?? null,
      ],
    );
    return row.rows[0]?.id ?? '';
  };

  if (!isKnownTool(toolName)) {
    const id = await record('refused', { code: 'UNKNOWN_TOOL', reason: `No tool named ${toolName}.` });
    return { outcome: 'refused', code: 'UNKNOWN_TOOL', reason: `No tool named ${toolName}.`, toolCallId: id };
  }
  const definition = DEFINITIONS.get(toolName);
  if (definition === undefined) {
    const reason = `${toolName} is catalogued but not implemented in this build.`;
    const id = await record('refused', { code: 'TOOL_NOT_IMPLEMENTED', reason });
    return { outcome: 'refused', code: 'TOOL_NOT_IMPLEMENTED', reason, toolCallId: id };
  }

  const parsed = definition.argsSchema.safeParse(rawArgs);
  if (!parsed.success) {
    const reason = `Arguments rejected: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`;
    const id = await record('refused', { code: 'ARGS_INVALID', reason });
    return { outcome: 'refused', code: 'ARGS_INVALID', reason, toolCallId: id };
  }

  // Step 2: replay check. Reads only; never dispatches.
  let requestHash: string | null = null;
  let idempotencyKey: string | null = null;
  if (privileged) {
    const args = parsed.data as { idempotencyKey: string };
    idempotencyKey = args.idempotencyKey;
    requestHash = hashToolRequest(toolName, parsed.data);
    const existing = await ctx.client.query<{
      outcome_state: string; response: unknown; request_hash: string; external_ref: string | null;
    }>(
      'SELECT outcome_state, response, request_hash, external_ref FROM idempotency_key WHERE workspace_id = $1 AND key = $2 FOR UPDATE',
      [ctx.workspaceId, idempotencyKey],
    );
    const prior = existing.rows[0];
    if (prior !== undefined) {
      if (prior.request_hash !== requestHash) {
        const reason = 'This idempotency key was already used for a DIFFERENT request. Reusing a key with new content would make the replay guarantee meaningless.';
        const id = await record('refused', { code: 'IDEMPOTENCY_KEY_REUSED', reason, idempotencyKey });
        return { outcome: 'refused', code: 'IDEMPOTENCY_KEY_REUSED', reason, toolCallId: id };
      }
      const id = await record('succeeded', { idempotencyKey });
      return {
        outcome: 'succeeded',
        result: {
          replayed: true, response: prior.response,
          externalRef: prior.external_ref, outcomeState: prior.outcome_state,
        },
        toolCallId: id, replayed: true,
      };
    }
  }

  const enforcement = await enforceToolCall(ctx.client, {
    workspaceId: ctx.workspaceId,
    runId: ctx.runId,
    leaseToken: ctx.leaseToken,
    toolName,
    allowedTools: ctx.allowedTools,
    payload: approvalPayload,
  });

  if (!enforcement.allowed) {
    const id = await record('refused', { code: enforcement.code, reason: enforcement.reason });
    await appendEvent(ctx.client, {
      workspaceId: ctx.workspaceId, projectId: ctx.projectId, taskId: ctx.taskId,
      runId: ctx.runId, type: 'tool.refused', actorKind: 'system',
      actorLabel: 'Permission enforcement', dataLabel: ctx.dataLabel,
      summary: `Refused ${toolName}: ${enforcement.code}`,
      detail: { toolName, code: enforcement.code, reason: enforcement.reason },
    });
    return { outcome: 'refused', code: enforcement.code, reason: enforcement.reason, toolCallId: id };
  }

  // Step 4: register the key now that the call is authorised. The primary key
  // on (workspace_id, key) means a concurrent duplicate loses this insert
  // rather than both proceeding to dispatch.
  if (privileged && idempotencyKey !== null && requestHash !== null) {
    await ctx.client.query(
      `INSERT INTO idempotency_key (workspace_id, key, tool_name, request_hash, outcome_state)
       VALUES ($1,$2,$3,$4,'in_flight')`,
      [ctx.workspaceId, idempotencyKey, toolName, requestHash],
    );
  }

  const started = Date.now();
  const outcome = await definition.execute(parsed.data, ctx);
  const duration = Date.now() - started;

  if (!outcome.ok) {
    if (privileged && idempotencyKey !== null) {
      // 'uncertain' is deliberate: a failure after dispatch may or may not have
      // reached the outside world, and reconciliation must look rather than assume.
      await ctx.client.query(
        `UPDATE idempotency_key SET outcome_state = 'uncertain', response = $3, updated_at = now()
          WHERE workspace_id = $1 AND key = $2`,
        [ctx.workspaceId, idempotencyKey, JSON.stringify({ code: outcome.code, reason: outcome.reason })],
      );
    }
    const id = await record('failed', { code: outcome.code, reason: outcome.reason, approvalId: enforcement.approvalId, idempotencyKey });
    await ctx.client.query('UPDATE tool_call SET duration_ms = $2 WHERE id = $1', [id, duration]);
    return { outcome: 'failed', code: outcome.code, reason: outcome.reason, toolCallId: id };
  }

  if (privileged && idempotencyKey !== null) {
    await ctx.client.query(
      `UPDATE idempotency_key SET outcome_state = 'succeeded', response = $3,
             external_ref = $4, updated_at = now()
        WHERE workspace_id = $1 AND key = $2`,
      [ctx.workspaceId, idempotencyKey, JSON.stringify(outcome.result), outcome.externalRef ?? null],
    );
  }

  const id = await record('succeeded', { approvalId: enforcement.approvalId, idempotencyKey });
  await ctx.client.query('UPDATE tool_call SET duration_ms = $2 WHERE id = $1', [id, duration]);

  if (enforcement.approvalId !== null) {
    await ctx.client.query('UPDATE approval SET consumed_by_tool_call_id = $2 WHERE id = $1', [enforcement.approvalId, id]);
  }

  await appendEvent(ctx.client, {
    workspaceId: ctx.workspaceId, projectId: ctx.projectId, taskId: ctx.taskId,
    runId: ctx.runId, type: 'tool.called', actorKind: 'agent',
    actorId: ctx.agentId, actorLabel: ctx.actorLabel, dataLabel: ctx.dataLabel,
    summary: `${toolName} succeeded`,
    detail: { toolName, privileged, externalRef: outcome.externalRef ?? null },
  });

  return { outcome: 'succeeded', result: outcome.result, toolCallId: id, replayed: false };
}

/** Recording test adapter. Never presented as a real integration. */
export class RecordingSink implements ExternalSink {
  readonly dispatches: { tool: ToolName; idempotencyKey: string; payload: ApprovalPayload }[] = [];
  async dispatch(input: { tool: ToolName; idempotencyKey: string; payload: ApprovalPayload }): Promise<{ externalRef: string }> {
    this.dispatches.push(input);
    return { externalRef: `test-adapter:${input.tool}:${this.dispatches.length}` };
  }
}
