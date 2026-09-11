import type { PoolClient } from 'pg';
import { type ApprovalPayload, isPrivilegedTool } from '@sqhq/shared';
import { hashApprovalPayload } from './hash.js';

export type EnforcementResult =
  | { readonly allowed: true; readonly approvalId: string | null }
  | { readonly allowed: false; readonly code: RefusalCode; readonly reason: string };

export type RefusalCode =
  | 'TOOL_NOT_PERMITTED_FOR_AGENT'
  | 'APPROVAL_REQUIRED'
  | 'APPROVAL_NOT_GRANTED'
  | 'APPROVAL_CONTENT_MISMATCH'
  | 'APPROVAL_EXPIRED'
  | 'APPROVAL_ALREADY_CONSUMED'
  | 'EMERGENCY_STOP_ENGAGED'
  | 'BUDGET_EXHAUSTED'
  | 'RUN_LEASE_LOST'
  | 'UNKNOWN_TOOL';

/**
 * The only gate that matters.
 *
 * Every privileged tool call passes through here at the moment of execution.
 * A disabled button in the UI is a courtesy; this is the control. The checks
 * run in a fixed order so a refusal names the first real reason rather than a
 * downstream symptom.
 *
 * Deliberate properties:
 *   * The approval is matched by HASH of the exact payload, so editing the
 *     content after approval fails closed rather than sending the new version.
 *   * A granted approval is consumed atomically, so a replayed tool call
 *     cannot spend the same consent twice.
 *   * Nothing in the tool arguments, the task instruction or any retrieved
 *     document can influence the outcome: only workspace state and the
 *     agent's stored permission list are consulted.
 */
export async function enforceToolCall(
  client: PoolClient,
  input: {
    readonly workspaceId: string;
    readonly runId: string;
    readonly leaseToken: string;
    readonly toolName: string;
    readonly allowedTools: readonly string[];
    readonly payload: ApprovalPayload | null;
  },
): Promise<EnforcementResult> {
  // 1. Emergency stop halts new external calls outright.
  const stop = await client.query<{ emergency_stop_engaged: boolean; emergency_stop_reason: string | null }>(
    'SELECT emergency_stop_engaged, emergency_stop_reason FROM workspace WHERE id = $1',
    [input.workspaceId],
  );
  const stopRow = stop.rows[0];
  if (stopRow === undefined) {
    return { allowed: false, code: 'EMERGENCY_STOP_ENGAGED', reason: 'Workspace not found.' };
  }
  if (stopRow.emergency_stop_engaged && isPrivilegedTool(input.toolName)) {
    return {
      allowed: false, code: 'EMERGENCY_STOP_ENGAGED',
      reason: `Emergency stop is engaged: ${stopRow.emergency_stop_reason ?? 'no reason recorded'}. No new external actions are dispatched.`,
    };
  }

  // 2. The run must still hold its lease and not be cancelled. This is how an
  //    archived agent stops acting on the world mid-flight.
  const run = await client.query<{ state: string; cancel_requested: boolean; lease_token: string; lease_expires_at: Date }>(
    'SELECT state, cancel_requested, lease_token, lease_expires_at FROM run WHERE id = $1 FOR UPDATE',
    [input.runId],
  );
  const runRow = run.rows[0];
  if (runRow === undefined) {
    return { allowed: false, code: 'RUN_LEASE_LOST', reason: 'Run not found.' };
  }
  if (runRow.state !== 'leased' || runRow.cancel_requested
      || runRow.lease_token !== input.leaseToken
      || runRow.lease_expires_at.getTime() <= Date.now()) {
    return {
      allowed: false, code: 'RUN_LEASE_LOST',
      reason: 'This run no longer holds a valid lease (cancelled, expired, superseded or archived). Its output is quarantined for review rather than acted upon.',
    };
  }

  // 3. The agent's stored permission list. Permissions come from owner
  //    configuration only; nothing at runtime can widen them.
  if (!input.allowedTools.includes(input.toolName)) {
    return {
      allowed: false, code: 'TOOL_NOT_PERMITTED_FOR_AGENT',
      reason: `This agent's configuration does not grant ${input.toolName}. Permission expansion requires owner configuration, not a request at run time.`,
    };
  }

  // 4. Unprivileged tools stop here.
  if (!isPrivilegedTool(input.toolName)) {
    return { allowed: true, approvalId: null };
  }

  // 5. Privileged tools require a matching, granted, unexpired, unconsumed
  //    approval whose hash equals the hash of this exact payload.
  if (input.payload === null) {
    return {
      allowed: false, code: 'APPROVAL_REQUIRED',
      reason: `${input.toolName} is a privileged action and was called without an approval payload.`,
    };
  }
  if (input.payload.tool !== input.toolName) {
    return {
      allowed: false, code: 'APPROVAL_CONTENT_MISMATCH',
      reason: `Approval payload names tool ${input.payload.tool} but the call is ${input.toolName}.`,
    };
  }

  const hash = hashApprovalPayload(input.payload);
  const found = await client.query<{ id: string; state: string; expires_at: Date }>(
    `SELECT id, state, expires_at FROM approval
      WHERE workspace_id = $1 AND payload_hash = $2 AND tool_name = $3
      ORDER BY created_at DESC
      FOR UPDATE`,
    [input.workspaceId, hash, input.toolName],
  );

  const match = found.rows[0];
  if (match === undefined) {
    // Distinguish "never approved" from "approved, then edited": the second is
    // the more dangerous case and deserves its own message.
    const sameTool = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM approval
        WHERE workspace_id = $1 AND tool_name = $2 AND state = 'granted'`,
      [input.workspaceId, input.toolName],
    );
    const hasOtherGrants = (sameTool.rows[0]?.count ?? '0') !== '0';
    return {
      allowed: false,
      code: hasOtherGrants ? 'APPROVAL_CONTENT_MISMATCH' : 'APPROVAL_REQUIRED',
      reason: hasOtherGrants
        ? 'A granted approval exists for this tool but not for this content. The payload was edited after approval, which invalidates it. Request approval for the new content.'
        : `No approval exists for this ${input.toolName} action.`,
    };
  }
  if (match.state === 'consumed') {
    return {
      allowed: false, code: 'APPROVAL_ALREADY_CONSUMED',
      reason: 'This approval has already been used. A single consent authorises a single act; replaying it cannot dispatch the action twice.',
    };
  }
  if (match.state !== 'granted') {
    return {
      allowed: false, code: 'APPROVAL_NOT_GRANTED',
      reason: `Approval is in state "${match.state}", not "granted".`,
    };
  }
  if (match.expires_at.getTime() <= Date.now()) {
    await client.query(
      `UPDATE approval SET state = 'expired' WHERE id = $1 AND state = 'granted'`,
      [match.id],
    );
    return {
      allowed: false, code: 'APPROVAL_EXPIRED',
      reason: `Approval expired at ${match.expires_at.toISOString()}. Time-boxing consent prevents an old approval authorising a later, different situation.`,
    };
  }

  // Consume atomically: the WHERE clause makes a concurrent second consumer fail.
  const consumed = await client.query(
    `UPDATE approval SET state = 'consumed' WHERE id = $1 AND state = 'granted'`,
    [match.id],
  );
  if (consumed.rowCount !== 1) {
    return {
      allowed: false, code: 'APPROVAL_ALREADY_CONSUMED',
      reason: 'Approval was consumed concurrently by another call.',
    };
  }

  return { allowed: true, approvalId: match.id };
}

/**
 * Invalidate every pending or granted approval whose content no longer matches
 * the artifact it authorised. Called whenever an approved draft is edited.
 */
export async function invalidateApprovalsForChangedContent(
  client: PoolClient,
  workspaceId: string,
  taskId: string,
  reason: string,
): Promise<string[]> {
  const rows = await client.query<{ id: string }>(
    `UPDATE approval
        SET state = 'invalidated', invalidated_reason = $3
      WHERE workspace_id = $1 AND task_id = $2 AND state IN ('pending','granted')
      RETURNING id`,
    [workspaceId, taskId, reason],
  );
  return rows.rows.map((r) => r.id);
}
