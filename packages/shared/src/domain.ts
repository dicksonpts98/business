import type { ProvenanceLabel } from './provenance.js';
import type { ToolName } from './tools.js';
import type { Zone } from './zones.js';

/* -------------------------------------------------------------------------- */
/* Execution mode                                                             */
/* -------------------------------------------------------------------------- */

/**
 * DEMO uses a deterministic seeded executor; every artifact and event it
 * produces is labelled SYNTHETIC_DEMO. LIVE uses real adapters. There is no
 * third mode and no fallback path from LIVE to DEMO: a live run without
 * credentials fails as DISCONNECTED rather than quietly producing demo output.
 */
export type ExecutionMode = 'demo' | 'live';

export type ProviderStatus =
  | { readonly state: 'ready'; readonly provider: string; readonly model: string }
  | { readonly state: 'disconnected'; readonly provider: string; readonly missing: readonly string[] }
  | { readonly state: 'demo'; readonly seedNote: string };

/* -------------------------------------------------------------------------- */
/* Task and run lifecycle                                                     */
/* -------------------------------------------------------------------------- */

export const TASK_STATES = [
  'draft', 'queued', 'running', 'waiting_dependency', 'waiting_input',
  'waiting_approval', 'completed', 'failed', 'cancelled',
] as const;
export type TaskState = (typeof TASK_STATES)[number];

export const TERMINAL_TASK_STATES: readonly TaskState[] = ['completed', 'failed', 'cancelled'];

/** Legal task transitions. Enforced in the database layer and unit-tested. */
const TASK_TRANSITIONS: Record<TaskState, readonly TaskState[]> = {
  draft: ['queued', 'cancelled'],
  queued: ['running', 'waiting_dependency', 'cancelled', 'failed'],
  running: ['completed', 'failed', 'waiting_input', 'waiting_approval', 'waiting_dependency', 'cancelled'],
  waiting_dependency: ['queued', 'cancelled', 'failed'],
  waiting_input: ['queued', 'cancelled', 'failed'],
  waiting_approval: ['queued', 'cancelled', 'failed'],
  // A completed task may be reopened for rework, but only into an explicit,
  // bounded rework loop that creates a new run rather than erasing the old one.
  completed: ['queued'],
  failed: ['queued', 'cancelled'],
  cancelled: [],
};

export function canTransitionTask(from: TaskState, to: TaskState): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

export function assertTaskTransition(from: TaskState, to: TaskState): void {
  if (!canTransitionTask(from, to)) {
    throw new Error(`Illegal task transition ${from} -> ${to}`);
  }
}

/**
 * A run is an attempt at a task. It is deliberately a separate record: an
 * artifact can be sent back for changes without pretending the run that
 * produced it never happened.
 */
export const RUN_STATES = [
  'leased', 'succeeded', 'failed', 'timed_out', 'cancelled', 'quarantined',
] as const;
export type RunState = (typeof RUN_STATES)[number];

/**
 * Output that arrived from an agent whose lease had already been revoked, e.g.
 * the agent was archived mid-flight. It is preserved for review rather than
 * silently accepted or silently discarded.
 */
export const QUARANTINE_REASONS = [
  'lease_revoked', 'agent_archived', 'config_superseded', 'emergency_stop',
] as const;
export type QuarantineReason = (typeof QUARANTINE_REASONS)[number];

/* -------------------------------------------------------------------------- */
/* Events                                                                     */
/* -------------------------------------------------------------------------- */

export const EVENT_TYPES = [
  'project.created', 'project.paused', 'project.resumed',
  'task.created', 'task.state_changed', 'task.assigned',
  'run.started', 'run.heartbeat', 'run.succeeded', 'run.failed',
  'run.timed_out', 'run.cancelled', 'run.quarantined',
  'tool.called', 'tool.refused',
  'artifact.created', 'artifact.revision_requested',
  'evidence.recorded',
  'handoff.completed',
  'approval.requested', 'approval.granted', 'approval.rejected', 'approval.invalidated',
  'agent.created', 'agent.updated', 'agent.paused', 'agent.resumed', 'agent.archived',
  'budget.warning', 'budget.exhausted',
  'connector.health_changed',
  'emergency_stop.engaged', 'emergency_stop.cleared',
  'review.dissent_recorded',
  'agent.moved',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/**
 * The wire shape of an event. `seq` is a per-workspace monotonic integer used by
 * clients to resume after reconnect and to deduplicate. Exactly-once delivery is
 * never promised; clients deduplicate by `id` and reconcile by `seq`.
 */
export interface WireEvent {
  readonly id: string;
  readonly seq: number;
  readonly occurredAt: string;
  readonly workspaceId: string;
  readonly projectId: string | null;
  readonly taskId: string | null;
  readonly runId: string | null;
  readonly actorKind: 'owner' | 'agent' | 'system';
  readonly actorId: string | null;
  readonly actorLabel: string;
  readonly type: EventType;
  readonly summary: string;
  readonly artifactId: string | null;
  readonly dataLabel: ProvenanceLabel;
  /** Structured detail. Never contains hidden reasoning, only observable facts. */
  readonly detail: Readonly<Record<string, unknown>>;
}

/* -------------------------------------------------------------------------- */
/* Agent presence, used by the 3D scene                                       */
/* -------------------------------------------------------------------------- */

/**
 * Observable agent state. Deliberately distinguishes idle, waiting and errored:
 * an avatar that looks busy while its task is blocked is a lie the scene must
 * not tell.
 */
export type AgentActivity =
  | { readonly kind: 'idle' }
  | { readonly kind: 'working'; readonly taskId: string; readonly summary: string }
  | { readonly kind: 'waiting_dependency'; readonly taskId: string; readonly blockedBy: readonly string[] }
  | { readonly kind: 'waiting_approval'; readonly taskId: string; readonly approvalId: string }
  | { readonly kind: 'waiting_input'; readonly taskId: string; readonly question: string }
  | { readonly kind: 'errored'; readonly taskId: string; readonly error: string }
  | { readonly kind: 'paused' }
  | { readonly kind: 'archived' };

export interface AgentPresence {
  readonly agentId: string;
  readonly name: string;
  readonly roleId: string;
  readonly zone: Zone;
  readonly activity: AgentActivity;
  readonly toolsUsed: readonly ToolName[];
  readonly elapsedMs: number | null;
  readonly model: string | null;
  /** Measured when the provider reports it; estimated otherwise, and said so. */
  readonly cost: { readonly amountUsd: string; readonly measured: boolean } | null;
}

/* -------------------------------------------------------------------------- */
/* Approvals                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The exact, content-bound description of an action awaiting approval. The
 * payload is hashed; editing any field invalidates the approval, because an
 * approval is consent to a specific act, not a standing licence for a category.
 */
export interface ApprovalPayload {
  readonly tool: ToolName;
  readonly action: string;
  readonly destination: string | null;
  readonly content: string | null;
  readonly amountMinor: number | null;
  readonly currency: string | null;
  readonly productRef: string | null;
  readonly quantity: number | null;
  readonly supplierRef: string | null;
  readonly expiresAt: string;
}

export const APPROVAL_STATES = [
  'pending', 'granted', 'rejected', 'expired', 'invalidated', 'consumed',
] as const;
export type ApprovalState = (typeof APPROVAL_STATES)[number];

/* -------------------------------------------------------------------------- */
/* Evidence                                                                   */
/* -------------------------------------------------------------------------- */

export const SOURCE_TYPES = [
  'retailer_site', 'marketplace_listing', 'public_review', 'search_result',
  'social_public', 'supplier_listing', 'government_publication',
  'news_article', 'uploaded_document', 'first_party_data', 'owner_statement',
] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export interface EvidenceRecord {
  readonly id: string;
  readonly claim: string;
  readonly url: string | null;
  readonly uploadedDocumentId: string | null;
  readonly title: string;
  readonly publisher: string;
  /** When the source says it was published. Distinct from fetchedAt. */
  readonly publishedAt: string | null;
  /** When this application actually retrieved it. */
  readonly fetchedAt: string;
  readonly sourceType: SourceType;
  readonly excerpt: string;
  readonly geographicRelevance: readonly string[];
  readonly confidenceRationale: string;
  readonly dataLabel: ProvenanceLabel;
  /** IDs of evidence this contradicts. Disagreement stays visible. */
  readonly contradicts: readonly string[];
  /** Set when this claim is a syndicated copy of another record. */
  readonly duplicateOf: string | null;
}

/* -------------------------------------------------------------------------- */
/* Compliance register                                                        */
/* -------------------------------------------------------------------------- */

export const COMPLIANCE_STATUSES = [
  'not_assessed', 'research_incomplete', 'professional_review_needed',
  'evidence_recorded', 'owner_decision_recorded',
] as const;
export type ComplianceStatus = (typeof COMPLIANCE_STATUSES)[number];

export interface ComplianceIssue {
  readonly id: string;
  readonly productSpecId: string | null;
  readonly jurisdiction: string;
  readonly topic: string;
  readonly authoritativeSourceUrl: string | null;
  readonly effectiveDate: string | null;
  readonly accessedAt: string | null;
  readonly apparentApplicability: string;
  readonly unresolvedQuestions: readonly string[];
  readonly requiredDocumentsOrTesting: readonly string[];
  readonly reviewer: string | null;
  readonly status: ComplianceStatus;
}
