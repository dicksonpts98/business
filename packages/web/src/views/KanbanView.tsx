import type { TaskRow } from '../api/client.js';

export interface KanbanViewProps {
  readonly tasks: readonly TaskRow[];
  readonly selectedTaskId: string | null;
  readonly onSelectTask: (taskId: string) => void;
}

/** Column order follows the task lifecycle, with the waiting states grouped. */
const COLUMNS: readonly { key: string; label: string; states: readonly string[] }[] = [
  { key: 'draft', label: 'Draft', states: ['draft'] },
  { key: 'queued', label: 'Queued', states: ['queued'] },
  { key: 'running', label: 'Running', states: ['running'] },
  { key: 'waiting', label: 'Waiting', states: ['waiting_dependency', 'waiting_input', 'waiting_approval'] },
  { key: 'completed', label: 'Completed', states: ['completed'] },
  { key: 'stopped', label: 'Failed or cancelled', states: ['failed', 'cancelled'] },
];

export function KanbanView({
  tasks, selectedTaskId, onSelectTask,
}: KanbanViewProps): React.JSX.Element {
  return (
    <div className="view view-kanban">
      {COLUMNS.map((column) => {
        const columnTasks = tasks.filter((t) => column.states.includes(t.state));
        return (
          <section key={column.key} className="kanban-column" aria-label={`${column.label}, ${columnTasks.length} tasks`}>
            <h3>
              {column.label}
              <span className="count">{columnTasks.length}</span>
            </h3>
            <ul>
              {columnTasks.map((task) => (
                <li key={task.id}>
                  <button
                    type="button"
                    className={`kanban-card${task.id === selectedTaskId ? ' selected' : ''}`}
                    onClick={() => onSelectTask(task.id)}
                  >
                    <span className="kanban-title">{task.title}</span>
                    <span className="kanban-meta">
                      <span className={`pill pill-${task.state}`}>{task.state.replace(/_/g, ' ')}</span>
                      {task.agent_name !== null && <span className="muted">{task.agent_name}</span>}
                    </span>
                    {task.waiting_reason !== null && (
                      <span className="kanban-reason">{task.waiting_reason}</span>
                    )}
                    {task.latest_error !== null && (
                      <span className="kanban-error">{task.latest_error}</span>
                    )}
                  </button>
                </li>
              ))}
              {columnTasks.length === 0 && <li className="muted kanban-empty">Empty</li>}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
