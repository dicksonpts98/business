import type { PoolClient } from 'pg';
import type { EventType, ProvenanceLabel, WireEvent } from '@sqhq/shared';

export interface AppendEventInput {
  readonly workspaceId: string;
  readonly type: EventType;
  readonly summary: string;
  readonly actorKind: 'owner' | 'agent' | 'system';
  readonly actorLabel: string;
  readonly dataLabel: ProvenanceLabel;
  readonly projectId?: string | null;
  readonly taskId?: string | null;
  readonly runId?: string | null;
  readonly actorId?: string | null;
  readonly artifactId?: string | null;
  readonly detail?: Readonly<Record<string, unknown>>;
}

interface EventRow {
  id: string;
  seq: string;
  occurred_at: Date;
  workspace_id: string;
  project_id: string | null;
  task_id: string | null;
  run_id: string | null;
  actor_kind: 'owner' | 'agent' | 'system';
  actor_id: string | null;
  actor_label: string;
  type: string;
  summary: string;
  artifact_id: string | null;
  data_label: string;
  detail: Record<string, unknown>;
}

export function toWireEvent(row: EventRow): WireEvent {
  return {
    id: row.id,
    seq: Number(row.seq),
    occurredAt: row.occurred_at.toISOString(),
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    taskId: row.task_id,
    runId: row.run_id,
    actorKind: row.actor_kind,
    actorId: row.actor_id,
    actorLabel: row.actor_label,
    type: row.type as EventType,
    summary: row.summary,
    artifactId: row.artifact_id,
    dataLabel: row.data_label as ProvenanceLabel,
    detail: row.detail,
  };
}

/**
 * Append an event inside the caller's transaction.
 *
 * The sequence is allocated by UPDATE ... RETURNING on a per-workspace counter
 * row, which both serialises concurrent appenders and makes the sequence
 * gap-free. Gap-free matters because the client uses "I have up to seq N" to
 * resume: with gaps it could not distinguish a missing event from a skipped
 * number and would have to refetch everything.
 *
 * The event must be appended in the SAME transaction as the state change it
 * describes. An event visible for a change that later rolled back would leave
 * the timeline permanently wrong.
 */
export async function appendEvent(
  client: PoolClient, input: AppendEventInput,
): Promise<WireEvent> {
  const seqRow = await client.query<{ last_seq: string }>(
    `INSERT INTO workspace_event_seq (workspace_id, last_seq)
          VALUES ($1, 1)
     ON CONFLICT (workspace_id)
     DO UPDATE SET last_seq = workspace_event_seq.last_seq + 1
       RETURNING last_seq`,
    [input.workspaceId],
  );
  const seq = seqRow.rows[0]?.last_seq;
  if (seq === undefined) throw new Error('Failed to allocate an event sequence number.');

  const inserted = await client.query<EventRow>(
    `INSERT INTO event (workspace_id, seq, project_id, task_id, run_id,
                        actor_kind, actor_id, actor_label, type, summary,
                        artifact_id, data_label, detail)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING *`,
    [
      input.workspaceId, seq, input.projectId ?? null, input.taskId ?? null,
      input.runId ?? null, input.actorKind, input.actorId ?? null, input.actorLabel,
      input.type, input.summary, input.artifactId ?? null, input.dataLabel,
      JSON.stringify(input.detail ?? {}),
    ],
  );
  const row = inserted.rows[0];
  if (row === undefined) throw new Error('Event insert returned no row.');
  return toWireEvent(row);
}

/** Read a page of events after a sequence number, oldest first. */
export async function readEventsAfter(
  client: Pick<PoolClient, 'query'>,
  workspaceId: string, afterSeq: number, limit = 500,
): Promise<WireEvent[]> {
  const rows = await client.query<EventRow>(
    `SELECT * FROM event
      WHERE workspace_id = $1 AND seq > $2
      ORDER BY seq ASC
      LIMIT $3`,
    [workspaceId, afterSeq, limit],
  );
  return rows.rows.map(toWireEvent);
}

export async function latestSeq(
  client: Pick<PoolClient, 'query'>, workspaceId: string,
): Promise<number> {
  const rows = await client.query<{ last_seq: string }>(
    'SELECT last_seq FROM workspace_event_seq WHERE workspace_id = $1', [workspaceId],
  );
  return Number(rows.rows[0]?.last_seq ?? 0);
}
