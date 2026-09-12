import { useEffect, useState } from 'react';
import { ALL_TOOLS, DEFAULT_AGENT_TOOLS, ROLE_TEMPLATES, TOOL_DESCRIPTION, isPrivilegedTool } from '@sqhq/shared';
import { type AgentRow, api } from '../api/client.js';

export interface AgentBuilderViewProps {
  readonly workspaceId: string;
  readonly agents: readonly AgentRow[];
  readonly onAction: (label: string, run: () => Promise<unknown>) => void;
  readonly onSelectAgent: (agentId: string) => void;
}

/**
 * Agent builder.
 *
 * The number of agents and their desks are never hardcoded: a custom role such
 * as "Punjabi Copy Reviewer" is created here, with no code change, by naming a
 * role template and writing instructions. Extra agents consume budget only when
 * a task is actually assigned to them.
 */
export function AgentBuilderView({
  workspaceId, agents, onAction, onSelectAgent,
}: AgentBuilderViewProps): React.JSX.Element {
  const [templateId, setTemplateId] = useState(ROLE_TEMPLATES[0]?.id ?? '');
  const [name, setName] = useState('');
  const [instructions, setInstructions] = useState('');
  const [tools, setTools] = useState<string[]>([...DEFAULT_AGENT_TOOLS]);
  const [maxRunSeconds, setMaxRunSeconds] = useState(300);
  const [maxToolCalls, setMaxToolCalls] = useState(25);
  const [archiveFor, setArchiveFor] = useState<AgentRow | null>(null);

  const template = ROLE_TEMPLATES.find((r) => r.id === templateId);

  useEffect(() => {
    if (template !== undefined) setTools([...template.defaultTools]);
  }, [template]);

  return (
    <div className="view view-agents">
      <section className="agent-roster">
        <h2>Roster ({agents.length})</h2>
        <p className="muted">
          Twenty-one role templates describe business responsibilities, not
          twenty-one continuously running model loops. Only an assigned task
          invokes an agent, and worker concurrency defaults to three.
        </p>
        <ul className="roster-list">
          {agents.map((agent) => {
            const role = ROLE_TEMPLATES.find((r) => r.id === agent.template_id);
            return (
              <li key={agent.id} className={`roster-item status-${agent.status}`}>
                <button type="button" className="link" onClick={() => onSelectAgent(agent.id)}>
                  {agent.name}
                </button>
                <span className="muted">{role?.title ?? agent.template_id}</span>
                <span className={`pill pill-${agent.status}`}>{agent.status}</span>
                <span className="muted">v{agent.config_version ?? 1}</span>
                <span className="roster-actions">
                  {agent.status !== 'archived' && (
                    <button type="button" onClick={() => setArchiveFor(agent)}>Archive…</button>
                  )}
                  {agent.status === 'archived' && (
                    <button
                      type="button"
                      onClick={() => onAction(`Reactivate ${agent.name}`, () => api.reactivateAgent(agent.id))}
                    >
                      Reactivate
                    </button>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="agent-create">
        <h2>Add an agent</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const trimmed = name.trim();
            if (trimmed === '') return;
            onAction(`Create ${trimmed}`, () => api.createAgent({
              workspaceId, templateId, name: trimmed, instructions,
              allowedTools: tools, maxRunSeconds, maxToolCalls,
              appearance: template?.visual ?? {},
            }));
            setName('');
            setInstructions('');
          }}
        >
          <label>
            <span>Name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Punjabi Copy Reviewer"
              required
            />
          </label>
          <label>
            <span>Role template</span>
            <select value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
              {ROLE_TEMPLATES.map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}
            </select>
          </label>
          {template !== undefined && (
            <p className="muted authority">
              <strong>Authority limits:</strong> {template.authorityLimits}
            </p>
          )}
          <label>
            <span>Instructions</span>
            <textarea
              rows={4}
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder="What this agent should do, and what it must not assume."
            />
          </label>
          <fieldset className="tool-grid">
            <legend>Tool permissions</legend>
            <p className="muted">
              Privileged tools still require a scoped owner approval at execution
              time. Granting one here does not authorise any individual act.
            </p>
            {ALL_TOOLS.map((tool) => (
              <label key={tool} className={`tool-check${isPrivilegedTool(tool) ? ' privileged' : ''}`}>
                <input
                  type="checkbox"
                  checked={tools.includes(tool)}
                  onChange={(e) => setTools((prev) =>
                    e.target.checked ? [...prev, tool] : prev.filter((t) => t !== tool))}
                />
                <code>{tool}</code>
                {isPrivilegedTool(tool) && <span className="chip chip-privileged">privileged</span>}
                <small>{TOOL_DESCRIPTION[tool]}</small>
              </label>
            ))}
          </fieldset>
          <div className="limits">
            <label>
              <span>Max run seconds</span>
              <input type="number" min={10} max={3600} value={maxRunSeconds}
                onChange={(e) => setMaxRunSeconds(Number(e.target.value))} />
            </label>
            <label>
              <span>Max tool calls</span>
              <input type="number" min={1} max={200} value={maxToolCalls}
                onChange={(e) => setMaxToolCalls(Number(e.target.value))} />
            </label>
          </div>
          <button type="submit" className="primary">Create agent</button>
        </form>
      </section>

      {archiveFor !== null && (
        <ArchiveDialog
          agent={archiveFor}
          agents={agents}
          onClose={() => setArchiveFor(null)}
          onAction={onAction}
        />
      )}
    </div>
  );
}

/**
 * Archiving shows its consequences BEFORE the owner chooses, and the three
 * dispositions are the spec's: finish the current task, cancel and reassign, or
 * pause dependent work. Prior outputs and audit history are kept in all cases.
 */
function ArchiveDialog({
  agent, agents, onClose, onAction,
}: {
  agent: AgentRow;
  agents: readonly AgentRow[];
  onClose: () => void;
  onAction: AgentBuilderViewProps['onAction'];
}): React.JSX.Element {
  const [impact, setImpact] = useState<{ activeTasks: Record<string, unknown>[]; note: string } | null>(null);
  const [disposition, setDisposition] = useState('finish_current_task');
  const [reassignTo, setReassignTo] = useState('');

  useEffect(() => {
    void api.archiveImpact(agent.id)
      .then((data) => setImpact({ activeTasks: data.activeTasks, note: data.note }))
      .catch(() => setImpact({ activeTasks: [], note: 'Could not load the impact summary.' }));
  }, [agent.id]);

  const candidates = agents.filter((a) => a.id !== agent.id && a.status === 'active');

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={`Archive ${agent.name}`}>
      <div className="modal">
        <h2>Archive {agent.name}</h2>
        {impact === null ? <p>Checking what this would disturb…</p> : (
          <>
            <p className="muted">{impact.note}</p>
            <h3>Active work ({impact.activeTasks.length})</h3>
            <ul className="list">
              {impact.activeTasks.map((task, index) => (
                <li key={index}>
                  {String(task['title'])}
                  <span className={`pill pill-${String(task['state'])}`}>{String(task['state'])}</span>
                  {Number(task['dependents']) > 0 && (
                    <span className="muted">{String(task['dependents'])} dependent task(s)</span>
                  )}
                </li>
              ))}
              {impact.activeTasks.length === 0 && <li className="muted">No active work.</li>}
            </ul>

            <fieldset>
              <legend>What should happen to its in-flight work?</legend>
              {([
                ['finish_current_task', 'Finish the current task', 'A running task is left to complete. Queued work stops.'],
                ['cancel_and_reassign', 'Cancel and reassign', 'The lease is revoked and the work moves to another agent as a NEW run. Nothing is dispatched twice.'],
                ['pause_dependent_work', 'Pause dependent work', 'Work parks for an owner decision rather than being orphaned.'],
              ] as const).map(([value, label, description]) => (
                <label key={value} className="radio">
                  <input
                    type="radio"
                    name="disposition"
                    value={value}
                    checked={disposition === value}
                    onChange={() => setDisposition(value)}
                  />
                  <span>
                    <strong>{label}</strong>
                    <small>{description}</small>
                  </span>
                </label>
              ))}
            </fieldset>

            {disposition === 'cancel_and_reassign' && (
              <label>
                <span>Reassign to</span>
                <select value={reassignTo} onChange={(e) => setReassignTo(e.target.value)} required>
                  <option value="">Select an active agent</option>
                  {candidates.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </label>
            )}

            <div className="modal-actions">
              <button
                type="button"
                className="danger"
                disabled={disposition === 'cancel_and_reassign' && reassignTo === ''}
                onClick={() => {
                  onClose();
                  onAction(`Archive ${agent.name}`, () => api.archiveAgent(
                    agent.id, disposition, disposition === 'cancel_and_reassign' ? reassignTo : null));
                }}
              >
                Archive
              </button>
              <button type="button" onClick={onClose}>Cancel</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
