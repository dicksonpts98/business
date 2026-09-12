import { useState } from 'react';
import type { ConnectionState } from '../state/store.js';
import type { HealthResponse, ProjectRow } from '../api/client.js';

export interface TopBarProps {
  readonly health: HealthResponse | null;
  readonly connection: ConnectionState;
  readonly projects: readonly ProjectRow[];
  readonly activeProjectId: string | null;
  readonly pendingApprovals: number;
  readonly computeBudgetNote: string | null;
  readonly onSelectProject: (id: string) => void;
  readonly onTogglePause: () => void;
  readonly onEmergencyStop: () => void;
  readonly onOpenApprovals: () => void;
}

const CONNECTION_TEXT: Record<ConnectionState, string> = {
  connecting: 'Connecting',
  live: 'Stream live',
  reconnecting: 'Reconnecting, resuming from the last event',
  failed: 'Disconnected',
};

export function TopBar({
  health, connection, projects, activeProjectId, pendingApprovals, computeBudgetNote,
  onSelectProject, onTogglePause, onEmergencyStop, onOpenApprovals,
}: TopBarProps): React.JSX.Element {
  const [confirmStop, setConfirmStop] = useState(false);
  const project = projects.find((p) => p.id === activeProjectId) ?? null;
  const stopEngaged = health?.workspace?.emergency_stop_engaged === true;
  const provider = health?.providerStatus;

  return (
    <header className="topbar">
      <div className="topbar-left">
        <span className="brand">SupplyQuest&nbsp;HQ</span>

        <label className="project-picker">
          <span className="sr-only">Project</span>
          <select
            value={activeProjectId ?? ''}
            onChange={(e) => onSelectProject(e.target.value)}
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} {p.status === 'active' ? '' : `— ${p.status}`}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="topbar-right">
        {/*
          The mode badge is the most load-bearing indicator in the product. In
          demo mode it says so plainly; in live mode with a missing credential it
          says DISCONNECTED rather than implying work is happening.
        */}
        {health !== null && (
          <span
            className={`mode-badge mode-${
              provider?.state === 'demo' ? 'demo'
              : provider?.state === 'ready' ? 'live' : 'disconnected'}`}
            title={
              provider?.state === 'demo' ? provider.seedNote
              : provider?.state === 'ready' ? `Live via ${provider.provider} (${provider.model})`
              : provider?.state === 'disconnected' ? `Missing: ${provider.missing.join(', ')}`
              : ''}
          >
            {provider?.state === 'demo' ? 'DEMO DATA'
              : provider?.state === 'ready' ? 'LIVE'
              : 'LIVE — DISCONNECTED'}
          </span>
        )}

        <span className={`conn conn-${connection}`} aria-live="polite">
          <span className="conn-dot" aria-hidden="true" />
          {CONNECTION_TEXT[connection]}
        </span>

        {computeBudgetNote !== null && (
          <span className="budget" title={computeBudgetNote}>
            Budget: unset
          </span>
        )}

        <button type="button" className="approvals-button" onClick={onOpenApprovals}>
          Approvals
          {pendingApprovals > 0 && <span className="count">{pendingApprovals}</span>}
        </button>

        {project !== null && (
          <button type="button" onClick={onTogglePause}>
            {project.status === 'paused' ? 'Resume project' : 'Pause project'}
          </button>
        )}

        {confirmStop ? (
          <span className="stop-confirm">
            <span>
              {stopEngaged
                ? 'Clear the emergency stop?'
                : 'Stop all new external actions?'}
            </span>
            <button
              type="button"
              className="danger"
              onClick={() => { setConfirmStop(false); onEmergencyStop(); }}
            >
              {stopEngaged ? 'Clear' : 'Stop now'}
            </button>
            <button type="button" onClick={() => setConfirmStop(false)}>Cancel</button>
          </span>
        ) : (
          <button
            type="button"
            className={stopEngaged ? 'danger active' : 'danger'}
            onClick={() => setConfirmStop(true)}
          >
            {stopEngaged ? 'STOPPED' : 'Emergency stop'}
          </button>
        )}
      </div>
    </header>
  );
}
