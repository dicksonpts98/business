import { useMemo, useState } from 'react';
import type { TaskRow } from '../api/client.js';

export interface TableViewProps {
  readonly tasks: readonly TaskRow[];
  readonly selectedTaskId: string | null;
  readonly onSelectTask: (taskId: string) => void;
}

type SortKey = 'title' | 'state' | 'agent_name' | 'node_kind' | 'priority';

/**
 * The table view is deliberately capable of everything the 3D office can do:
 * selecting a task, seeing its state, its assignee, its blockers and its
 * attempt count. No business action requires the 3D scene.
 */
export function TableView({
  tasks, selectedTaskId, onSelectTask,
}: TableViewProps): React.JSX.Element {
  const [sortKey, setSortKey] = useState<SortKey>('priority');
  const [ascending, setAscending] = useState(true);
  const [query, setQuery] = useState('');
  const [stateFilter, setStateFilter] = useState('');

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = tasks.filter((task) => {
      if (stateFilter !== '' && task.state !== stateFilter) return false;
      if (needle === '') return true;
      return `${task.title} ${task.agent_name ?? ''} ${task.node_kind}`.toLowerCase().includes(needle);
    });
    return [...filtered].sort((a, b) => {
      const av = a[sortKey] ?? '';
      const bv = b[sortKey] ?? '';
      const cmp = typeof av === 'number' && typeof bv === 'number'
        ? av - bv
        : String(av).localeCompare(String(bv));
      return ascending ? cmp : -cmp;
    });
  }, [tasks, sortKey, ascending, query, stateFilter]);

  const states = useMemo(
    () => [...new Set(tasks.map((t) => t.state))].sort(),
    [tasks],
  );

  const toggleSort = (key: SortKey): void => {
    if (key === sortKey) setAscending((v) => !v);
    else { setSortKey(key); setAscending(true); }
  };

  return (
    <div className="view view-table">
      <div className="view-toolbar">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter tasks"
          aria-label="Filter tasks"
        />
        <label>
          <span className="sr-only">State</span>
          <select value={stateFilter} onChange={(e) => setStateFilter(e.target.value)}>
            <option value="">All states</option>
            {states.map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
          </select>
        </label>
        <span className="muted">{rows.length} of {tasks.length}</span>
      </div>

      <table className="data-table">
        <caption className="sr-only">
          Tasks with state, assignee, attempts and blockers. Activate a row to open it in the inspector.
        </caption>
        <thead>
          <tr>
            {([
              ['title', 'Task'],
              ['node_kind', 'Kind'],
              ['state', 'State'],
              ['agent_name', 'Assigned'],
              ['priority', 'Order'],
            ] as const).map(([key, label]) => (
              <th key={key} scope="col">
                <button
                  type="button"
                  onClick={() => toggleSort(key)}
                  aria-sort={sortKey === key ? (ascending ? 'ascending' : 'descending') : 'none'}
                >
                  {label}
                  {sortKey === key && <span aria-hidden="true">{ascending ? ' ▲' : ' ▼'}</span>}
                </button>
              </th>
            ))}
            <th scope="col">Attempts</th>
            <th scope="col">Blockers</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((task) => {
            const blockers = (task.depends_on ?? [])
              .map((id) => tasks.find((t) => t.id === id))
              .filter((t): t is TaskRow => t !== undefined && t.state !== 'completed');
            return (
              <tr
                key={task.id}
                className={task.id === selectedTaskId ? 'selected' : undefined}
                onClick={() => onSelectTask(task.id)}
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelectTask(task.id);
                  }
                }}
                aria-selected={task.id === selectedTaskId}
              >
                <th scope="row">{task.title}</th>
                <td>{task.node_kind}</td>
                <td><span className={`pill pill-${task.state}`}>{task.state.replace(/_/g, ' ')}</span></td>
                <td>{task.agent_name ?? <span className="muted">unassigned</span>}</td>
                <td>{task.priority}</td>
                <td>{task.run_count}</td>
                <td>
                  {blockers.length === 0
                    ? <span className="muted">none</span>
                    : blockers.map((b) => b.title).join(', ')}
                </td>
              </tr>
            );
          })}
          {rows.length === 0 && (
            <tr><td colSpan={7} className="muted">No tasks match the current filter.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
