import { useEffect, useState } from 'react';
import { ROLE_BY_ID, ZONE_LABEL, type AgentPresence } from '@sqhq/shared';
import {
  type AgentRow, type ArtifactRow, type EvidenceRow, type RunRow, type TaskRow,
  type ToolCallRow, api,
} from '../api/client.js';
import { STATUS } from '../scene/palette.js';

export interface InspectorProps {
  readonly presence: readonly AgentPresence[];
  readonly agents: readonly AgentRow[];
  readonly tasks: readonly TaskRow[];
  readonly artifacts: readonly ArtifactRow[];
  readonly evidence: readonly EvidenceRow[];
  readonly selectedAgentId: string | null;
  readonly selectedTaskId: string | null;
  readonly onSelectTask: (taskId: string | null) => void;
  readonly onSelectAgent: (agentId: string | null) => void;
  readonly onAction: (label: string, run: () => Promise<unknown>) => void;
}

function formatElapsed(ms: number | null): string {
  if (ms === null) return '—';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

export function Inspector(props: InspectorProps): React.JSX.Element {
  const { selectedAgentId, selectedTaskId } = props;
  if (selectedTaskId !== null) return <TaskInspector {...props} taskId={selectedTaskId} />;
  if (selectedAgentId !== null) return <AgentInspector {...props} agentId={selectedAgentId} />;
  return (
    <aside className="inspector" aria-label="Inspector">
      <div className="inspector-empty">
        <h2>Inspector</h2>
        <p>
          Select an agent or a task — in the office, the table, the board or the
          timeline — to see its role, current work, tools used, sources,
          deliverables, blockers and cost.
        </p>
        <p className="muted">
          Nothing here shows an agent&rsquo;s private reasoning. What is shown is
          what it actually did: the tools it called, the artifacts it produced and
          the sources it recorded.
        </p>
      </div>
    </aside>
  );
}

function AgentInspector({
  presence, agents, tasks, artifacts, agentId, onSelectTask, onAction, onSelectAgent,
}: InspectorProps & { agentId: string }): React.JSX.Element {
  const agent = agents.find((a) => a.id === agentId);
  const live = presence.find((p) => p.agentId === agentId);
  const role = agent === undefined ? undefined : ROLE_BY_ID.get(agent.template_id);
  const myTasks = tasks.filter((t) => t.assigned_agent_id === agentId);
  const myArtifacts = artifacts.filter((a) =>
    myTasks.some((t) => t.id === a.task_id));
  const status = live === undefined ? STATUS.idle : STATUS[live.activity.kind];

  if (agent === undefined) {
    return (
      <aside className="inspector"><p>That agent is no longer in the roster.</p></aside>
    );
  }

  return (
    <aside className="inspector" aria-label={`Inspector for ${agent.name}`}>
      <header className="inspector-head">
        <div>
          <h2>{agent.name}</h2>
          <p className="inspector-role">{role?.title ?? agent.template_id}</p>
        </div>
        <button type="button" className="close" onClick={() => onSelectAgent(null)} aria-label="Close inspector">×</button>
      </header>

      <p className={`status-line status-${live?.activity.kind ?? 'idle'}`}>
        <span aria-hidden="true">{status.glyph}</span> {status.label}
      </p>

      {live?.activity.kind === 'working' && (
        <p className="inspector-current">{live.activity.summary}</p>
      )}
      {live?.activity.kind === 'waiting_approval' && (
        <p className="inspector-blocker">
          Waiting on your approval. Nothing is dispatched until you decide.
        </p>
      )}
      {live?.activity.kind === 'waiting_input' && (
        <p className="inspector-blocker">Waiting for your input: {live.activity.question}</p>
      )}
      {live?.activity.kind === 'waiting_dependency' && (
        <p className="inspector-blocker">Blocked until an upstream task completes.</p>
      )}
      {live?.activity.kind === 'errored' && (
        <p className="inspector-error">Errored: {live.activity.error}</p>
      )}

      <dl className="inspector-facts">
        <div><dt>Zone</dt><dd>{ZONE_LABEL[live?.zone ?? role?.homeZone ?? 'projectMeetingRoom']}</dd></div>
        <div><dt>Status</dt><dd>{agent.status}</dd></div>
        <div><dt>Config version</dt><dd>v{agent.config_version ?? 1}</dd></div>
        <div><dt>Model</dt><dd>{live?.model ?? agent.model ?? 'workspace default'}</dd></div>
        <div><dt>Elapsed</dt><dd>{formatElapsed(live?.elapsedMs ?? null)}</dd></div>
        <div>
          <dt>Run cost</dt>
          <dd>
            {live?.cost === null || live?.cost === undefined
              ? '—'
              : `${live.cost.amountUsd} USD ${live.cost.measured ? '(measured)' : '(not reported by provider)'}`}
          </dd>
        </div>
      </dl>

      <section>
        <h3>Authority limits</h3>
        <p className="muted">{role?.authorityLimits ?? 'Not specified.'}</p>
      </section>

      <section>
        <h3>Tool permissions</h3>
        <ul className="chips">
          {(agent.allowed_tools ?? []).map((tool) => (
            <li key={tool} className="chip">{tool}</li>
          ))}
          {(agent.allowed_tools ?? []).length === 0 && <li className="muted">None granted.</li>}
        </ul>
      </section>

      {live !== undefined && live.toolsUsed.length > 0 && (
        <section>
          <h3>Tools used this run</h3>
          <ul className="chips">
            {live.toolsUsed.map((tool) => <li key={tool} className="chip chip-used">{tool}</li>)}
          </ul>
        </section>
      )}

      <section>
        <h3>Instructions</h3>
        <p className="pre">{agent.instructions ?? '—'}</p>
      </section>

      <section>
        <h3>Assigned tasks ({myTasks.length})</h3>
        <ul className="list">
          {myTasks.map((task) => (
            <li key={task.id}>
              <button type="button" className="link" onClick={() => onSelectTask(task.id)}>
                {task.title}
              </button>
              <span className={`pill pill-${task.state}`}>{task.state}</span>
            </li>
          ))}
          {myTasks.length === 0 && <li className="muted">No assigned tasks. This agent is genuinely idle.</li>}
        </ul>
      </section>

      <section>
        <h3>Deliverables ({myArtifacts.length})</h3>
        <ul className="list">
          {myArtifacts.slice(0, 8).map((artifact) => (
            <li key={artifact.id}>
              <span className={`label label-${artifact.data_label}`}>{artifact.data_label}</span>
              {artifact.title} <span className="muted">v{artifact.version}</span>
            </li>
          ))}
          {myArtifacts.length === 0 && <li className="muted">Nothing produced yet.</li>}
        </ul>
      </section>

      <div className="inspector-actions">
        {agent.status === 'active' && (
          <button
            type="button"
            onClick={() => onAction(`Pause ${agent.name}`, () => api.setAgentStatus(agent.id, 'paused'))}
          >
            Pause
          </button>
        )}
        {agent.status === 'paused' && (
          <button
            type="button"
            onClick={() => onAction(`Resume ${agent.name}`, () => api.setAgentStatus(agent.id, 'active'))}
          >
            Resume
          </button>
        )}
        {agent.status === 'archived' && (
          <button
            type="button"
            onClick={() => onAction(`Reactivate ${agent.name}`, () => api.reactivateAgent(agent.id))}
          >
            Reactivate
          </button>
        )}
        <button
          type="button"
          onClick={() => onAction(`Clone ${agent.name}`,
            () => api.cloneAgent(agent.id, `${agent.name} (copy)`))}
        >
          Clone
        </button>
      </div>
    </aside>
  );
}

function TaskInspector({
  tasks, artifacts, evidence, taskId, onSelectTask, onAction,
}: InspectorProps & { taskId: string }): React.JSX.Element {
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [toolCalls, setToolCalls] = useState<ToolCallRow[]>([]);
  const [inputAnswer, setInputAnswer] = useState('');
  const task = tasks.find((t) => t.id === taskId);
  const taskArtifacts = artifacts.filter((a) => a.task_id === taskId);

  useEffect(() => {
    let cancelled = false;
    void api.taskRuns(taskId).then((data) => {
      if (cancelled) return;
      setRuns(data.runs);
      setToolCalls(data.toolCalls);
    }).catch(() => { /* the panel degrades to showing no runs */ });
    return () => { cancelled = true; };
  }, [taskId, tasks]);

  if (task === undefined) {
    return <aside className="inspector"><p>That task no longer exists.</p></aside>;
  }

  const blockers = (task.depends_on ?? [])
    .map((id) => tasks.find((t) => t.id === id))
    .filter((t): t is TaskRow => t !== undefined && t.state !== 'completed');

  return (
    <aside className="inspector" aria-label={`Inspector for task ${task.title}`}>
      <header className="inspector-head">
        <div>
          <h2>{task.title}</h2>
          <p className="inspector-role">
            {task.node_kind}{task.node_key === null ? '' : ` · ${task.node_key}`}
          </p>
        </div>
        <button type="button" className="close" onClick={() => onSelectTask(null)} aria-label="Close inspector">×</button>
      </header>

      <p className={`status-line pill-${task.state}`}>{task.state.replace(/_/g, ' ')}</p>
      {task.waiting_reason !== null && <p className="inspector-blocker">{task.waiting_reason}</p>}
      {task.latest_error !== null && <p className="inspector-error">{task.latest_error}</p>}

      <dl className="inspector-facts">
        <div><dt>Assigned</dt><dd>{task.agent_name ?? 'Unassigned'}</dd></div>
        <div><dt>Attempts</dt><dd>{task.run_count}</dd></div>
        <div><dt>Rework</dt><dd>{task.rework_count} of {task.max_rework}</dd></div>
        <div><dt>Latest run</dt><dd>{task.latest_run_state ?? '—'}</dd></div>
      </dl>

      <section>
        <h3>Instruction</h3>
        <p className="pre">{task.instruction || '—'}</p>
      </section>

      {blockers.length > 0 && (
        <section>
          <h3>Blocked by</h3>
          <ul className="list">
            {blockers.map((b) => (
              <li key={b.id}>
                <button type="button" className="link" onClick={() => onSelectTask(b.id)}>{b.title}</button>
                <span className={`pill pill-${b.state}`}>{b.state}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h3>Runs ({runs.length})</h3>
        <ul className="list">
          {runs.map((run) => (
            <li key={run.id} className={`run run-${run.state}`}>
              <strong>Attempt {run.attempt}</strong> — {run.state}
              {run.quarantine_reason !== null && <> · quarantined: {run.quarantine_reason}</>}
              <div className="muted">
                {run.execution_mode} · {run.model ?? 'no model'} ·{' '}
                {run.input_tokens === null
                  ? 'no usage reported'
                  : `${run.input_tokens} in / ${run.output_tokens ?? 0} out tokens ${run.cost_measured ? '(measured)' : ''}`}
              </div>
              {run.error_message !== null && <div className="error-text">{run.error_code}: {run.error_message}</div>}
            </li>
          ))}
          {runs.length === 0 && <li className="muted">No run has been opened for this task yet.</li>}
        </ul>
      </section>

      <section>
        <h3>Tool calls ({toolCalls.length})</h3>
        <ul className="list dense">
          {toolCalls.map((call) => (
            <li key={call.id} className={`tool-${call.outcome}`}>
              <code>{call.tool_name}</code>
              {call.privileged && <span className="chip chip-privileged">privileged</span>}
              <span className={`pill pill-${call.outcome}`}>{call.outcome}</span>
              {call.refusal_reason !== null && <div className="error-text">{call.refusal_code}: {call.refusal_reason}</div>}
            </li>
          ))}
          {toolCalls.length === 0 && <li className="muted">No tool calls recorded.</li>}
        </ul>
      </section>

      <section>
        <h3>Deliverables ({taskArtifacts.length})</h3>
        {taskArtifacts.map((artifact) => (
          <article key={artifact.id} className="artifact">
            <header>
              <span className={`label label-${artifact.data_label}`}>{artifact.data_label}</span>
              <strong>{artifact.title}</strong>
              <span className="muted">v{artifact.version} · {artifact.review_state}</span>
            </header>
            <ArtifactBody body={artifact.body} />
          </article>
        ))}
        {taskArtifacts.length === 0 && <p className="muted">Nothing produced yet.</p>}
      </section>

      {evidence.length > 0 && (
        <section>
          <h3>Sources on this project</h3>
          <ul className="list dense">
            {evidence.slice(0, 6).map((item) => (
              <li key={item.id}>
                <span className={`label label-${item.data_label}`}>{item.data_label}</span>
                {item.url === null
                  ? item.title
                  : <a href={item.url} target="_blank" rel="noreferrer noopener">{item.title}</a>}
                <div className="muted">
                  {item.publisher} · fetched {new Date(item.fetched_at).toLocaleDateString()}
                  {item.published_at === null ? ' · publication date unknown' : ''}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="inspector-actions">
        {task.state === 'waiting_input' && (
          <form
            className="input-form"
            onSubmit={(e) => {
              e.preventDefault();
              const answer = inputAnswer.trim();
              if (answer === '') return;
              setInputAnswer('');
              onAction('Provide input', () => api.provideInput(task.id, answer));
            }}
          >
            <label>
              <span>Your answer</span>
              <textarea
                value={inputAnswer}
                onChange={(e) => setInputAnswer(e.target.value)}
                rows={3}
                required
              />
            </label>
            <button type="submit">Submit and resume</button>
          </form>
        )}
        {(task.state === 'failed' || task.state === 'completed') && (
          <button
            type="button"
            onClick={() => onAction('Retry task', () => api.retryTask(task.id))}
            disabled={task.rework_count >= task.max_rework}
            title={task.rework_count >= task.max_rework
              ? 'Rework limit reached. Raise it deliberately rather than looping.'
              : 'Creates a new run; prior runs and artifacts are kept.'}
          >
            Rework ({task.rework_count}/{task.max_rework})
          </button>
        )}
        {!['completed', 'cancelled', 'failed'].includes(task.state) && (
          <button
            type="button"
            className="danger"
            onClick={() => onAction('Cancel task',
              () => api.cancelTask(task.id, 'Cancelled by owner from the inspector.'))}
          >
            Cancel task
          </button>
        )}
      </div>
    </aside>
  );
}

/** Render an artifact body as readable fields rather than raw JSON. */
function ArtifactBody({ body }: { body: Record<string, unknown> }): React.JSX.Element {
  const entries = Object.entries(body);
  return (
    <dl className="artifact-body">
      {entries.map(([key, value]) => (
        <div key={key}>
          <dt>{key.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase())}</dt>
          <dd>
            {Array.isArray(value) ? (
              <ul>
                {value.map((item, index) => (
                  <li key={index}>
                    {typeof item === 'object' && item !== null
                      ? Object.entries(item as Record<string, unknown>)
                          .map(([k, v]) => `${k}: ${String(v)}`).join(' · ')
                      : String(item)}
                  </li>
                ))}
              </ul>
            ) : typeof value === 'object' && value !== null ? (
              <code className="json">{JSON.stringify(value)}</code>
            ) : (
              String(value)
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}
