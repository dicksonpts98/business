import type { AgentPresence, WireEvent } from '@sqhq/shared';

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: { accept: 'application/json' } });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText} for ${path}`);
  }
  return response.json() as Promise<T>;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = (payload as { error?: string }).error ?? `${response.status} ${response.statusText}`;
    throw new Error(message);
  }
  return payload as T;
}

export interface HealthResponse {
  ok: boolean;
  executionMode: 'demo' | 'live';
  providerStatus:
    | { state: 'ready'; provider: string; model: string }
    | { state: 'disconnected'; provider: string; missing: string[] }
    | { state: 'demo'; seedNote: string };
  workspace: { id: string; name: string; execution_mode: string; emergency_stop_engaged: boolean } | null;
  connectors: { kind: string; display_name: string; health: string; health_detail: string | null }[];
  implemented: { modelProviders: string[]; unimplemented: string[] };
}

export interface TaskRow {
  id: string;
  project_id: string;
  title: string;
  instruction: string;
  node_kind: string;
  node_key: string | null;
  state: string;
  waiting_reason: string | null;
  assigned_agent_id: string | null;
  agent_name: string | null;
  agent_role: string | null;
  depends_on: string[] | null;
  run_count: string;
  latest_run_state: string | null;
  latest_error: string | null;
  priority: number;
  rework_count: number;
  max_rework: number;
}

export interface ProjectRow {
  id: string;
  name: string;
  owner_objective: string;
  geography: string[];
  status: string;
  paused_reason: string | null;
  data_label: string;
  task_count: string;
  completed_count: string;
  pending_approvals: string;
}

export interface AgentRow {
  id: string;
  name: string;
  template_id: string;
  status: string;
  config_version_id: string | null;
  config_version: number | null;
  instructions: string | null;
  allowed_tools: string[] | null;
  model: string | null;
  max_run_seconds: number | null;
  max_tool_calls: number | null;
  appearance: Record<string, unknown> | null;
}

export interface ApprovalRow {
  id: string;
  project_id: string | null;
  task_id: string | null;
  tool_name: string;
  payload: Record<string, unknown>;
  payload_hash: string;
  state: string;
  expires_at: string;
  decision_note: string | null;
  invalidated_reason: string | null;
  task_title: string | null;
  project_name: string | null;
  created_at: string;
}

export interface EvidenceRow {
  id: string;
  claim: string;
  url: string | null;
  title: string;
  publisher: string;
  published_at: string | null;
  fetched_at: string;
  source_type: string;
  excerpt: string;
  geographic_relevance: string[];
  confidence_rationale: string;
  data_label: string;
  contradicts: string[];
  duplicate_of: string | null;
}

export interface ArtifactRow {
  id: string;
  artifact_key: string;
  version: number;
  task_id: string | null;
  run_id: string | null;
  kind: string;
  title: string;
  body: Record<string, unknown>;
  data_label: string;
  review_state: string;
  created_at: string;
}

export interface RunRow {
  id: string;
  attempt: number;
  state: string;
  quarantine_reason: string | null;
  model: string | null;
  execution_mode: string;
  cost_usd: string | null;
  cost_measured: boolean;
  input_tokens: number | null;
  output_tokens: number | null;
  error_code: string | null;
  error_message: string | null;
  started_at: string;
  finished_at: string | null;
  tool_call_count: string;
}

export interface ToolCallRow {
  id: string;
  run_id: string;
  tool_name: string;
  privileged: boolean;
  outcome: string;
  refusal_code: string | null;
  refusal_reason: string | null;
  duration_ms: number | null;
  created_at: string;
}

export const api = {
  health: () => getJson<HealthResponse>('/api/health'),
  config: () => getJson<Record<string, unknown>>('/api/config'),
  roleTemplates: () => getJson<unknown[]>('/api/role-templates'),
  zones: () => getJson<unknown[]>('/api/zones'),
  projects: (workspaceId: string) =>
    getJson<{ projects: ProjectRow[] }>(`/api/projects?workspaceId=${workspaceId}`),
  tasks: (workspaceId: string) =>
    getJson<{ tasks: TaskRow[] }>(`/api/tasks?workspaceId=${workspaceId}`),
  agents: (workspaceId: string) =>
    getJson<{ agents: AgentRow[] }>(`/api/agents?workspaceId=${workspaceId}`),
  presence: (workspaceId: string) =>
    getJson<{ presence: AgentPresence[] }>(`/api/scene/presence?workspaceId=${workspaceId}`),
  approvals: (workspaceId: string) =>
    getJson<{ approvals: ApprovalRow[] }>(`/api/approvals?workspaceId=${workspaceId}`),
  evidence: (workspaceId: string) =>
    getJson<{ evidence: EvidenceRow[] }>(`/api/evidence?workspaceId=${workspaceId}`),
  artifacts: (workspaceId: string) =>
    getJson<{ artifacts: ArtifactRow[] }>(`/api/artifacts?workspaceId=${workspaceId}`),
  opportunities: (workspaceId: string) =>
    getJson<{ opportunities: Record<string, unknown>[] }>(`/api/opportunities?workspaceId=${workspaceId}`),
  suppliers: (workspaceId: string) =>
    getJson<{ suppliers: Record<string, unknown>[] }>(`/api/suppliers?workspaceId=${workspaceId}`),
  compliance: (workspaceId: string) =>
    getJson<{ issues: Record<string, unknown>[]; disclaimer: string }>(`/api/compliance?workspaceId=${workspaceId}`),
  costScenarios: (workspaceId: string) =>
    getJson<{ scenarios: Record<string, unknown>[] }>(`/api/cost-scenarios?workspaceId=${workspaceId}`),
  agentCosts: (workspaceId: string) =>
    getJson<{ costs: Record<string, unknown>[]; note: string }>(`/api/agent-costs?workspaceId=${workspaceId}`),
  workflows: (projectId: string) =>
    getJson<{ versions: Record<string, unknown>[] }>(`/api/workflows?projectId=${projectId}`),
  taskRuns: (taskId: string) =>
    getJson<{ runs: RunRow[]; toolCalls: ToolCallRow[] }>(`/api/tasks/${taskId}/runs`),
  events: (workspaceId: string, afterSeq: number, limit = 500) =>
    getJson<{ events: WireEvent[]; latestSeq: number; hasMore: boolean }>(
      `/api/events?workspaceId=${workspaceId}&afterSeq=${afterSeq}&limit=${limit}`),

  decideApproval: (id: string, decision: 'granted' | 'rejected', expectedPayloadHash: string, note?: string) =>
    postJson<{ state: string }>(`/api/approvals/${id}/decide`, { decision, expectedPayloadHash, note }),
  amendApproval: (id: string, payload: Record<string, unknown>) =>
    postJson<{ invalidatedApprovalId: string; replacementApprovalId: string; payloadHash: string }>(
      `/api/approvals/${id}/amend`, { payload }),
  cancelTask: (id: string, reason: string) =>
    postJson<{ cancelled: boolean }>(`/api/tasks/${id}/cancel`, { reason }),
  retryTask: (id: string) => postJson<{ requeued: boolean }>(`/api/tasks/${id}/retry`, {}),
  provideInput: (id: string, answer: string) =>
    postJson<{ requeued: boolean }>(`/api/tasks/${id}/provide-input`, { answer }),
  pauseProject: (id: string, paused: boolean, reason?: string) =>
    postJson<{ status: string }>(`/api/projects/${id}/pause`, { paused, reason }),
  emergencyStop: (workspaceId: string, engaged: boolean, reason?: string) =>
    postJson<{ engaged: boolean; alreadyDispatched: unknown[]; note: string }>(
      '/api/workspace/emergency-stop', { workspaceId, engaged, reason }),
  createAgent: (body: Record<string, unknown>) =>
    postJson<{ agentId: string; version: number }>('/api/agents', body),
  cloneAgent: (id: string, name: string) =>
    postJson<{ agentId: string }>(`/api/agents/${id}/clone`, { name }),
  setAgentStatus: (id: string, status: 'paused' | 'active') =>
    postJson<{ status: string }>(`/api/agents/${id}/status`, { status }),
  archiveImpact: (id: string) =>
    getJson<{ activeTasks: Record<string, unknown>[]; dispositions: string[]; note: string }>(
      `/api/agents/${id}/archive-impact`),
  archiveAgent: (id: string, disposition: string, reassignToAgentId: string | null) =>
    postJson<{ archived: boolean; actions: { taskId: string; title: string; action: string }[] }>(
      `/api/agents/${id}/archive`, { disposition, reassignToAgentId }),
  reactivateAgent: (id: string) =>
    postJson<{ status: string }>(`/api/agents/${id}/reactivate`, {}),
  validateWorkflow: (graph: unknown) =>
    postJson<{ valid: boolean; issues: { code: string; severity: string; message: string; nodeKey?: string }[] }>(
      '/api/workflows/validate', { graph }),
  saveWorkflow: (body: Record<string, unknown>) =>
    postJson<{ workflowVersionId: string; version: number; validation: unknown; tasks: unknown[] }>(
      '/api/workflows', body),
  createTask: (body: Record<string, unknown>) =>
    postJson<{ taskId: string; state: string }>('/api/tasks', body),
  createProject: (body: Record<string, unknown>) =>
    postJson<{ projectId: string }>('/api/projects', body),
};
