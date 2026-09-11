import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, withTransaction } from '../db/pool.js';
import { RecordingSink, callTool } from '../tools/registry.js';
import { hashApprovalPayload } from './hash.js';
import {
  type Fixture, approvalPayload, makeFixture, openRun, resetDatabase, toolContext,
} from '../test/helpers.js';

let fixture: Fixture;

beforeEach(async () => {
  await resetDatabase();
  fixture = await makeFixture(['draft.write', 'order.place']);
});

afterAll(async () => { await closePool(); });

async function grant(payload: ReturnType<typeof approvalPayload>): Promise<string> {
  return withTransaction(async (client) => {
    const hash = hashApprovalPayload(payload);
    const row = await client.query<{ id: string }>(
      `INSERT INTO approval (workspace_id, project_id, task_id, tool_name, payload,
         payload_hash, state, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,'granted',$7) RETURNING id`,
      [fixture.workspaceId, fixture.projectId, fixture.taskId, payload.tool,
       JSON.stringify(payload), hash, payload.expiresAt],
    );
    return row.rows[0]!.id;
  });
}

describe('privileged tool calls are refused without an approval', () => {
  it('refuses order.place with no approval at all', async () => {
    const run = await openRun(fixture);
    const result = await withTransaction((client) =>
      callTool(
        toolContext(client, fixture, run, ['draft.write', 'order.place'], new RecordingSink()),
        'order.place',
        { approvalPayload: approvalPayload(), idempotencyKey: 'key-no-approval-1' },
        approvalPayload(),
      ));
    expect(result.outcome).toBe('refused');
    if (result.outcome === 'refused') expect(result.code).toBe('APPROVAL_REQUIRED');
  });

  it('refuses when the call carries no approval payload', async () => {
    const run = await openRun(fixture);
    const result = await withTransaction((client) =>
      callTool(
        toolContext(client, fixture, run, ['draft.write', 'order.place'], new RecordingSink()),
        'order.place', { approvalPayload: null, idempotencyKey: 'key-null-payload' }, null,
      ));
    expect(result.outcome).toBe('refused');
    if (result.outcome === 'refused') expect(result.code).toBe('APPROVAL_REQUIRED');
  });

  it('nothing reaches the external adapter when refused', async () => {
    const sink = new RecordingSink();
    const run = await openRun(fixture);
    await withTransaction((client) =>
      callTool(
        toolContext(client, fixture, run, ['draft.write', 'order.place'], sink),
        'order.place',
        { approvalPayload: approvalPayload(), idempotencyKey: 'key-nothing-sent' },
        approvalPayload(),
      ));
    expect(sink.dispatches).toHaveLength(0);
  });
});

describe('an approval binds to exact content', () => {
  it('allows the call when the payload matches the granted hash', async () => {
    const payload = approvalPayload();
    await grant(payload);
    const sink = new RecordingSink();
    const run = await openRun(fixture);
    const result = await withTransaction((client) =>
      callTool(
        toolContext(client, fixture, run, ['draft.write', 'order.place'], sink),
        'order.place', { approvalPayload: payload, idempotencyKey: 'key-match-1' }, payload,
      ));
    expect(result.outcome).toBe('succeeded');
    expect(sink.dispatches).toHaveLength(1);
  });

  it('refuses when the amount is edited after approval', async () => {
    const approved = approvalPayload({ amountMinor: 42000 });
    await grant(approved);
    const edited = approvalPayload({ amountMinor: 4_200_000 }); // 420.00 -> 42,000.00
    const sink = new RecordingSink();
    const run = await openRun(fixture);
    const result = await withTransaction((client) =>
      callTool(
        toolContext(client, fixture, run, ['draft.write', 'order.place'], sink),
        'order.place', { approvalPayload: edited, idempotencyKey: 'key-edited-amount' }, edited,
      ));
    expect(result.outcome).toBe('refused');
    if (result.outcome === 'refused') {
      expect(result.code).toBe('APPROVAL_CONTENT_MISMATCH');
      expect(result.reason).toMatch(/edited after approval/);
    }
    expect(sink.dispatches).toHaveLength(0);
  });

  it('refuses when only the destination is changed', async () => {
    const approved = approvalPayload({ destination: 'DEMO supplier A' });
    await grant(approved);
    const redirected = approvalPayload({ destination: 'DEMO supplier B' });
    const sink = new RecordingSink();
    const run = await openRun(fixture);
    const result = await withTransaction((client) =>
      callTool(
        toolContext(client, fixture, run, ['draft.write', 'order.place'], sink),
        'order.place', { approvalPayload: redirected, idempotencyKey: 'key-redirect' }, redirected,
      ));
    expect(result.outcome).toBe('refused');
    expect(sink.dispatches).toHaveLength(0);
  });

  it('refuses when only the quantity is changed by one', async () => {
    const approved = approvalPayload({ quantity: 5 });
    await grant(approved);
    const more = approvalPayload({ quantity: 6 });
    const run = await openRun(fixture);
    const result = await withTransaction((client) =>
      callTool(
        toolContext(client, fixture, run, ['draft.write', 'order.place'], new RecordingSink()),
        'order.place', { approvalPayload: more, idempotencyKey: 'key-quantity-changed' }, more,
      ));
    expect(result.outcome).toBe('refused');
  });

  it('hashes independently of key order', async () => {
    const a = approvalPayload();
    const reordered = Object.fromEntries(
      Object.entries(a).reverse(),
    ) as typeof a;
    expect(hashApprovalPayload(reordered)).toBe(hashApprovalPayload(a));
  });
});

describe('an approval authorises exactly one act', () => {
  it('is consumed on use and refuses a second call', async () => {
    const payload = approvalPayload();
    await grant(payload);
    const sink = new RecordingSink();
    const run = await openRun(fixture);

    const first = await withTransaction((client) =>
      callTool(
        toolContext(client, fixture, run, ['draft.write', 'order.place'], sink),
        'order.place', { approvalPayload: payload, idempotencyKey: 'key-once-1' }, payload,
      ));
    expect(first.outcome).toBe('succeeded');

    // A different idempotency key, so this is a genuinely new act, not a replay.
    const second = await withTransaction((client) =>
      callTool(
        toolContext(client, fixture, run, ['draft.write', 'order.place'], sink),
        'order.place', { approvalPayload: payload, idempotencyKey: 'key-once-2' }, payload,
      ));
    expect(second.outcome).toBe('refused');
    if (second.outcome === 'refused') expect(second.code).toBe('APPROVAL_ALREADY_CONSUMED');
    expect(sink.dispatches).toHaveLength(1);
  });

  it('refuses an expired approval and marks it expired', async () => {
    const payload = approvalPayload({ expiresAt: new Date(Date.now() - 1000).toISOString() });
    await grant(payload);
    const run = await openRun(fixture);
    const result = await withTransaction((client) =>
      callTool(
        toolContext(client, fixture, run, ['draft.write', 'order.place'], new RecordingSink()),
        'order.place', { approvalPayload: payload, idempotencyKey: 'key-expired' }, payload,
      ));
    expect(result.outcome).toBe('refused');
    if (result.outcome === 'refused') expect(result.code).toBe('APPROVAL_EXPIRED');
  });
});

describe('replay safety', () => {
  it('a replayed request with the same key does not dispatch twice', async () => {
    const payload = approvalPayload();
    await grant(payload);
    const sink = new RecordingSink();
    const run = await openRun(fixture);
    const args = { approvalPayload: payload, idempotencyKey: 'replay-key-identical' };

    const first = await withTransaction((client) =>
      callTool(toolContext(client, fixture, run, ['draft.write', 'order.place'], sink),
        'order.place', args, payload));
    const second = await withTransaction((client) =>
      callTool(toolContext(client, fixture, run, ['draft.write', 'order.place'], sink),
        'order.place', args, payload));

    expect(first.outcome).toBe('succeeded');
    expect(second.outcome).toBe('succeeded');
    if (second.outcome === 'succeeded') expect(second.replayed).toBe(true);
    // The decisive assertion: exactly one order reached the adapter.
    expect(sink.dispatches).toHaveLength(1);
  });

  it('refuses a reused key carrying different content', async () => {
    const payload = approvalPayload();
    await grant(payload);
    const sink = new RecordingSink();
    const run = await openRun(fixture);
    await withTransaction((client) =>
      callTool(toolContext(client, fixture, run, ['draft.write', 'order.place'], sink),
        'order.place', { approvalPayload: payload, idempotencyKey: 'shared-key' }, payload));

    const other = approvalPayload({ quantity: 50, amountMinor: 420000 });
    await grant(other);
    const result = await withTransaction((client) =>
      callTool(toolContext(client, fixture, run, ['draft.write', 'order.place'], sink),
        'order.place', { approvalPayload: other, idempotencyKey: 'shared-key' }, other));

    expect(result.outcome).toBe('refused');
    if (result.outcome === 'refused') expect(result.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(sink.dispatches).toHaveLength(1);
  });
});

describe('permission and lease boundaries', () => {
  it('refuses a tool the agent config does not grant', async () => {
    const restricted = await makeFixture(['draft.write']);
    const run = await openRun(restricted);
    const payload = approvalPayload();
    const result = await withTransaction((client) =>
      callTool(toolContext(client, restricted, run, ['draft.write'], new RecordingSink()),
        'order.place', { approvalPayload: payload, idempotencyKey: 'k-nogrant' }, payload));
    expect(result.outcome).toBe('refused');
    if (result.outcome === 'refused') {
      expect(result.code).toBe('TOOL_NOT_PERMITTED_FOR_AGENT');
      expect(result.reason).toMatch(/requires owner configuration/);
    }
  });

  it('refuses when the run lease has expired', async () => {
    const payload = approvalPayload();
    await grant(payload);
    const run = await openRun(fixture, -10); // already expired
    const result = await withTransaction((client) =>
      callTool(toolContext(client, fixture, run, ['draft.write', 'order.place'], new RecordingSink()),
        'order.place', { approvalPayload: payload, idempotencyKey: 'k-expired-lease' }, payload));
    expect(result.outcome).toBe('refused');
    if (result.outcome === 'refused') expect(result.code).toBe('RUN_LEASE_LOST');
  });

  it('refuses when cancellation has been requested', async () => {
    const payload = approvalPayload();
    await grant(payload);
    const run = await openRun(fixture);
    await withTransaction((client) =>
      client.query('UPDATE run SET cancel_requested = true WHERE id = $1', [run.runId]));
    const result = await withTransaction((client) =>
      callTool(toolContext(client, fixture, run, ['draft.write', 'order.place'], new RecordingSink()),
        'order.place', { approvalPayload: payload, idempotencyKey: 'k-cancelled' }, payload));
    expect(result.outcome).toBe('refused');
    if (result.outcome === 'refused') expect(result.code).toBe('RUN_LEASE_LOST');
  });

  it('blocks privileged calls while the emergency stop is engaged', async () => {
    const payload = approvalPayload();
    await grant(payload);
    await withTransaction((client) =>
      client.query(
        `UPDATE workspace SET emergency_stop_engaged = true, emergency_stop_reason = 'test halt' WHERE id = $1`,
        [fixture.workspaceId]));
    const sink = new RecordingSink();
    const run = await openRun(fixture);
    const result = await withTransaction((client) =>
      callTool(toolContext(client, fixture, run, ['draft.write', 'order.place'], sink),
        'order.place', { approvalPayload: payload, idempotencyKey: 'k-stopped' }, payload));
    expect(result.outcome).toBe('refused');
    if (result.outcome === 'refused') expect(result.code).toBe('EMERGENCY_STOP_ENGAGED');
    expect(sink.dispatches).toHaveLength(0);
  });

  it('still allows unprivileged work while the emergency stop is engaged', async () => {
    await withTransaction((client) =>
      client.query(`UPDATE workspace SET emergency_stop_engaged = true WHERE id = $1`, [fixture.workspaceId]));
    const run = await openRun(fixture);
    const result = await withTransaction((client) =>
      callTool(toolContext(client, fixture, run, ['draft.write', 'order.place']),
        'draft.write', { kind: 'note', title: 'Still thinking', body: { summary: 'analysis continues' } }, null));
    expect(result.outcome).toBe('succeeded');
  });
});

describe('argument validation runs before enforcement', () => {
  it('rejects a malformed call without consuming the approval', async () => {
    const payload = approvalPayload();
    const approvalId = await grant(payload);
    const sink = new RecordingSink();
    const run = await openRun(fixture);
    // Too short to be a usable idempotency key.
    const result = await withTransaction((client) =>
      callTool(toolContext(client, fixture, run, ['draft.write', 'order.place'], sink),
        'order.place', { approvalPayload: payload, idempotencyKey: 'short' }, payload));

    expect(result.outcome).toBe('refused');
    if (result.outcome === 'refused') expect(result.code).toBe('ARGS_INVALID');
    expect(sink.dispatches).toHaveLength(0);

    // The approval must still be spendable: a malformed call is not consent used.
    const state = await withTransaction((client) =>
      client.query<{ state: string }>('SELECT state FROM approval WHERE id = $1', [approvalId]));
    expect(state.rows[0]!.state).toBe('granted');
  });
});

describe('every attempt is recorded', () => {
  it('writes a tool_call row for refusals as well as successes', async () => {
    const run = await openRun(fixture);
    const payload = approvalPayload();
    await withTransaction((client) =>
      callTool(toolContext(client, fixture, run, ['draft.write', 'order.place'], new RecordingSink()),
        'order.place', { approvalPayload: payload, idempotencyKey: 'key-audit-trail' }, payload));
    const rows = await withTransaction((client) =>
      client.query<{ outcome: string; refusal_code: string | null; privileged: boolean }>(
        'SELECT outcome, refusal_code, privileged FROM tool_call WHERE run_id = $1', [run.runId]));
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.outcome).toBe('refused');
    expect(rows.rows[0]!.privileged).toBe(true);
    expect(rows.rows[0]!.refusal_code).toBe('APPROVAL_REQUIRED');
  });
});
