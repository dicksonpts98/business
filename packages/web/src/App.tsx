import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react';
import { ZONE_LABEL, ZONE_LAYOUT, type ZoneSpec } from '@sqhq/shared';
import { api } from './api/client.js';
import { Inspector } from './panels/Inspector.js';
import { Timeline } from './panels/Timeline.js';
import { TopBar } from './panels/TopBar.js';
// The 3D scene carries three.js and drei. Loading it lazily means a viewer who
// stays in the table, board or approvals views — or whose browser has no WebGL —
// never downloads a megabyte of renderer they cannot use.
const Office = lazy(async () => ({ default: (await import('./scene/Office.js')).Office }));
type Quality = 'low' | 'medium' | 'high';
import {
  useDocumentVisible, usePrefersReducedMotion, useWebglSupported, useWorkspaceStore,
} from './state/store.js';
import { AgentBuilderView } from './views/AgentBuilderView.js';
import { ApprovalsView } from './views/ApprovalsView.js';
import { type DashboardKey, DashboardView } from './views/DashboardView.js';
import { GraphView } from './views/GraphView.js';
import { KanbanView } from './views/KanbanView.js';
import { TableView } from './views/TableView.js';

type MainView = 'office' | 'table' | 'board' | 'workflow' | 'agents' | 'approvals' | 'dashboard';

interface Toast {
  readonly id: number;
  readonly message: string;
  readonly kind: 'ok' | 'error';
}

const VIEWS: readonly { key: MainView; label: string; hint: string }[] = [
  { key: 'office', label: 'Office', hint: '3D workspace' },
  { key: 'table', label: 'Table', hint: 'All tasks, sortable' },
  { key: 'board', label: 'Board', hint: 'Kanban by state' },
  { key: 'workflow', label: 'Workflow', hint: 'Graph editor' },
  { key: 'agents', label: 'Agents', hint: 'Roster and builder' },
  { key: 'approvals', label: 'Approvals', hint: 'Owner decisions' },
];

export function App(): React.JSX.Element {
  const store = useWorkspaceStore();
  const reducedMotion = usePrefersReducedMotion();
  const visible = useDocumentVisible();
  const webgl = useWebglSupported();

  const [view, setView] = useState<MainView>('office');
  const [dashboard, setDashboard] = useState<DashboardKey>('evidence');
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [selectedZone, setSelectedZone] = useState<string | null>(null);
  const [navOpen, setNavOpen] = useState(true);
  const [quality, setQuality] = useState<Quality>('high');
  const [showLabels, setShowLabels] = useState(true);
  const [follow, setFollow] = useState(false);
  const [resetSignal, setResetSignal] = useState(0);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);

  /* Default to the first active project once projects load. */
  useEffect(() => {
    if (activeProjectId !== null || store.projects.length === 0) return;
    const active = store.projects.find((p) => p.status === 'active') ?? store.projects[0];
    setActiveProjectId(active?.id ?? null);
  }, [store.projects, activeProjectId]);

  const notify = useCallback((message: string, kind: 'ok' | 'error'): void => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { id, message, kind }]);
    window.setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 7000);
  }, []);

  /** Run an owner action, reporting the real outcome rather than assuming success. */
  const onAction = useCallback((label: string, run: () => Promise<unknown>): void => {
    void run()
      .then(() => { notify(`${label}: done.`, 'ok'); return store.refresh(); })
      .catch((error: unknown) => {
        notify(`${label} failed — ${error instanceof Error ? error.message : 'unknown error'}`, 'error');
      });
  }, [notify, store]);

  const projectTasks = useMemo(
    () => (activeProjectId === null
      ? store.tasks
      : store.tasks.filter((t) => t.project_id === activeProjectId)),
    [store.tasks, activeProjectId],
  );

  const pendingApprovals = useMemo(
    () => store.approvals.filter((a) => a.state === 'pending').length,
    [store.approvals],
  );

  /** Attention badges per zone, so a room shows it needs the owner. */
  const badgeByZone = useMemo(() => {
    const badges: Record<string, number> = {};
    const add = (zone: string): void => { badges[zone] = (badges[zone] ?? 0) + 1; };
    for (const agent of store.presence) {
      const kind = agent.activity.kind;
      if (kind === 'waiting_approval' || kind === 'waiting_input' || kind === 'errored') add(agent.zone);
    }
    if (pendingApprovals > 0) badges['founderCommandDesk'] = (badges['founderCommandDesk'] ?? 0) + pendingApprovals;
    return badges;
  }, [store.presence, pendingApprovals]);

  /* Keyboard shortcuts. Every one of them has a visible control as well. */
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      if (target !== null && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      switch (event.key) {
        case '1': setView('office'); break;
        case '2': setView('table'); break;
        case '3': setView('board'); break;
        case '4': setView('workflow'); break;
        case '5': setView('agents'); break;
        case '6': setView('approvals'); break;
        case 'r': setResetSignal((n) => n + 1); break;
        case 'f': setFollow((v) => !v); break;
        case 'l': setShowLabels((v) => !v); break;
        case '[': setNavOpen((v) => !v); break;
        case 'Escape':
          setSelectedTaskId(null);
          setSelectedAgentId(null);
          setSelectedZone(null);
          break;
        default: return;
      }
      event.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const openZone = useCallback((spec: ZoneSpec): void => {
    setSelectedZone(spec.zone);
    setDashboard(spec.dashboard as DashboardKey);
    setView('dashboard');
  }, []);

  if (store.error !== null && store.health === null) {
    return (
      <div className="fatal">
        <h1>SupplyQuest HQ cannot reach its API</h1>
        <p>{store.error}</p>
        <ol>
          <li>Start PostgreSQL and set <code>DATABASE_URL</code> in <code>.env</code>.</li>
          <li>Run <code>npm run migrate</code> then <code>npm run seed</code>.</li>
          <li>Run <code>npm run dev</code> and reload this page.</li>
        </ol>
      </div>
    );
  }

  const workspaceId = store.workspaceId;

  return (
    <div className={`app${navOpen ? '' : ' nav-collapsed'}`}>
      <a className="skip-link" href="#main">Skip to main content</a>

      <TopBar
        health={store.health}
        connection={store.connection}
        projects={store.projects}
        activeProjectId={activeProjectId}
        pendingApprovals={pendingApprovals}
        computeBudgetNote={
          store.health?.providerStatus.state === 'demo'
            ? null
            : 'No compute budget configured. Live runs stay blocked until the owner sets one; no default is assumed.'}
        onSelectProject={setActiveProjectId}
        onTogglePause={() => {
          const project = store.projects.find((p) => p.id === activeProjectId);
          if (project === undefined || workspaceId === null) return;
          const paused = project.status !== 'paused';
          onAction(paused ? 'Pause project' : 'Resume project',
            () => api.pauseProject(project.id, paused, paused ? 'Paused by owner.' : undefined));
        }}
        onEmergencyStop={() => {
          if (workspaceId === null) return;
          const engaged = store.health?.workspace?.emergency_stop_engaged !== true;
          onAction(engaged ? 'Engage emergency stop' : 'Clear emergency stop',
            () => api.emergencyStop(workspaceId, engaged, 'Owner used the emergency stop.'));
        }}
        onOpenApprovals={() => setView('approvals')}
      />

      <nav className="leftnav" aria-label="Views and departments">
        <button
          type="button"
          className="nav-toggle"
          onClick={() => setNavOpen((v) => !v)}
          aria-expanded={navOpen}
        >
          {navOpen ? '‹ Collapse' : '›'}
        </button>

        <ul className="nav-views">
          {VIEWS.map((item, index) => (
            <li key={item.key}>
              <button
                type="button"
                className={view === item.key ? 'active' : undefined}
                onClick={() => setView(item.key)}
                aria-current={view === item.key ? 'page' : undefined}
                title={`${item.hint} (${index + 1})`}
              >
                <span className="nav-key" aria-hidden="true">{index + 1}</span>
                <span className="nav-label">{item.label}</span>
                {item.key === 'approvals' && pendingApprovals > 0 && (
                  <span className="count">{pendingApprovals}</span>
                )}
              </button>
            </li>
          ))}
        </ul>

        <h2 className="nav-heading">Departments</h2>
        <ul className="nav-zones">
          {ZONE_LAYOUT.map((spec) => (
            <li key={spec.zone}>
              <button
                type="button"
                className={view === 'dashboard' && selectedZone === spec.zone ? 'active' : undefined}
                onClick={() => openZone(spec)}
              >
                <span className={`nav-accent accent-${spec.accent}`} aria-hidden="true" />
                <span className="nav-label">{ZONE_LABEL[spec.zone]}</span>
                {(badgeByZone[spec.zone] ?? 0) > 0 && (
                  <span className="count">{badgeByZone[spec.zone]}</span>
                )}
              </button>
            </li>
          ))}
        </ul>

        {view === 'office' && (
          <fieldset className="scene-settings">
            <legend>Scene</legend>
            <label>
              <span>Quality</span>
              <select value={quality} onChange={(e) => setQuality(e.target.value as Quality)}>
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low (no shadows)</option>
              </select>
            </label>
            <label className="check">
              <input type="checkbox" checked={showLabels} onChange={(e) => setShowLabels(e.target.checked)} />
              Labels <kbd>L</kbd>
            </label>
            <label className="check">
              <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
              Follow selected <kbd>F</kbd>
            </label>
            <button type="button" onClick={() => setResetSignal((n) => n + 1)}>
              Reset camera <kbd>R</kbd>
            </button>
            {reducedMotion && (
              <p className="muted small">
                Reduced motion is on, so avatars move instantly instead of walking.
              </p>
            )}
          </fieldset>
        )}
      </nav>

      <main id="main" className="main">
        {view === 'office' && (
          webgl === false ? (
            <div className="webgl-fallback">
              <h2>WebGL is unavailable in this browser</h2>
              <p>
                The 3D office cannot render, so it has been replaced by the table
                view. Nothing is lost: no business action requires the 3D scene.
              </p>
              <TableView
                tasks={projectTasks}
                selectedTaskId={selectedTaskId}
                onSelectTask={(id) => { setSelectedTaskId(id); setSelectedAgentId(null); }}
              />
            </div>
          ) : webgl === null ? (
            <p className="muted center">Checking graphics support…</p>
          ) : (
            <div className="office-wrap">
              <Suspense fallback={<p className="muted center">Loading the office…</p>}>
                <Office
                  presence={store.presence}
                  selectedAgentId={selectedAgentId}
                  selectedZone={selectedZone}
                  badgeByZone={badgeByZone}
                  quality={quality}
                  reducedMotion={reducedMotion}
                  showLabels={showLabels}
                  followSelected={follow}
                  paused={!visible}
                  resetSignal={resetSignal}
                  onSelectAgent={(id) => { setSelectedAgentId(id); setSelectedTaskId(null); }}
                  onOpenZone={openZone}
                  onOpenPrototype={() => { setDashboard('opportunities'); setView('dashboard'); }}
                />
              </Suspense>
              {!visible && (
                <p className="office-paused">Rendering paused while this tab is in the background.</p>
              )}
              {/*
                A keyboard-reachable list of every agent in the scene. The 3D view
                is a pointer affordance; this is the same information without one.
              */}
              <details className="office-roster" open>
                <summary>Agents ({store.presence.length})</summary>
                <ul>
                  {store.presence.map((agent) => (
                    <li key={agent.agentId}>
                      <button
                        type="button"
                        className={agent.agentId === selectedAgentId ? 'active' : undefined}
                        onClick={() => { setSelectedAgentId(agent.agentId); setSelectedTaskId(null); }}
                      >
                        {agent.name}
                        <span className={`dot dot-${agent.activity.kind}`} aria-hidden="true" />
                        <span className="sr-only">{agent.activity.kind.replace(/_/g, ' ')}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </details>
            </div>
          )
        )}

        {view === 'table' && (
          <TableView
            tasks={projectTasks}
            selectedTaskId={selectedTaskId}
            onSelectTask={(id) => { setSelectedTaskId(id); setSelectedAgentId(null); }}
          />
        )}

        {view === 'board' && (
          <KanbanView
            tasks={projectTasks}
            selectedTaskId={selectedTaskId}
            onSelectTask={(id) => { setSelectedTaskId(id); setSelectedAgentId(null); }}
          />
        )}

        {view === 'workflow' && workspaceId !== null && (
          <GraphView
            workspaceId={workspaceId}
            projectId={activeProjectId}
            onSaved={() => { void store.refresh(); }}
            onNotify={notify}
          />
        )}

        {view === 'agents' && workspaceId !== null && (
          <AgentBuilderView
            workspaceId={workspaceId}
            agents={store.agents}
            onAction={onAction}
            onSelectAgent={(id) => { setSelectedAgentId(id); setSelectedTaskId(null); }}
          />
        )}

        {view === 'approvals' && (
          <ApprovalsView approvals={store.approvals} onAction={onAction} />
        )}

        {view === 'dashboard' && workspaceId !== null && (
          dashboard === 'tasks' ? (
            <TableView
              tasks={projectTasks}
              selectedTaskId={selectedTaskId}
              onSelectTask={(id) => { setSelectedTaskId(id); setSelectedAgentId(null); }}
            />
          ) : (
            <DashboardView
              workspaceId={workspaceId}
              dashboard={dashboard}
              evidence={store.evidence}
            />
          )
        )}
      </main>

      <Inspector
        presence={store.presence}
        agents={store.agents}
        tasks={store.tasks}
        artifacts={store.artifacts}
        evidence={store.evidence}
        selectedAgentId={selectedAgentId}
        selectedTaskId={selectedTaskId}
        onSelectTask={(id) => { setSelectedTaskId(id); if (id !== null) setSelectedAgentId(null); }}
        onSelectAgent={setSelectedAgentId}
        onAction={onAction}
      />

      <Timeline
        events={store.events}
        cursor={store.cursor}
        duplicatesIgnored={store.duplicatesIgnored}
        onSelectTask={(id) => { setSelectedTaskId(id); setSelectedAgentId(null); }}
      />

      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast toast-${toast.kind}`}>{toast.message}</div>
        ))}
      </div>
    </div>
  );
}
