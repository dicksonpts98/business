import { useMemo, useState } from 'react';
import type { WireEvent } from '@sqhq/shared';

export interface TimelineProps {
  readonly events: readonly WireEvent[];
  readonly cursor: number;
  readonly duplicatesIgnored: number;
  readonly onSelectTask: (taskId: string) => void;
}

const SEVERITY: Record<string, 'bad' | 'warn' | 'good' | 'info'> = {
  'run.failed': 'bad',
  'run.timed_out': 'bad',
  'tool.refused': 'warn',
  'run.quarantined': 'warn',
  'approval.invalidated': 'warn',
  'budget.exhausted': 'bad',
  'emergency_stop.engaged': 'bad',
  'connector.health_changed': 'warn',
  'review.dissent_recorded': 'warn',
  'approval.requested': 'warn',
  'approval.granted': 'good',
  'run.succeeded': 'good',
  'artifact.created': 'good',
  'handoff.completed': 'good',
};

export function Timeline({
  events, cursor, duplicatesIgnored, onSelectTask,
}: TimelineProps): React.JSX.Element {
  const [filter, setFilter] = useState('');
  const [onlyAttention, setOnlyAttention] = useState(false);

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return [...events].reverse().filter((e) => {
      if (onlyAttention) {
        const severity = SEVERITY[e.type];
        if (severity !== 'bad' && severity !== 'warn') return false;
      }
      if (needle === '') return true;
      return `${e.summary} ${e.type} ${e.actorLabel}`.toLowerCase().includes(needle);
    });
  }, [events, filter, onlyAttention]);

  return (
    <section className="timeline" aria-label="Live event timeline">
      <div className="timeline-head">
        <h2>Event timeline</h2>
        <input
          type="search"
          placeholder="Filter events"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label="Filter events"
        />
        <label className="check">
          <input
            type="checkbox"
            checked={onlyAttention}
            onChange={(e) => setOnlyAttention(e.target.checked)}
          />
          Needs attention
        </label>
        {/*
          The resume cursor and duplicate count are shown rather than hidden, so
          the claim that reconnect does not double the history is checkable.
        */}
        <span className="timeline-meta" title="The highest event sequence this client has applied. Reconnect resumes from here.">
          seq {cursor}
        </span>
        {duplicatesIgnored > 0 && (
          <span className="timeline-meta" title="Duplicate deliveries discarded by event id. Delivery is not exactly-once.">
            {duplicatesIgnored} duplicate{duplicatesIgnored === 1 ? '' : 's'} ignored
          </span>
        )}
      </div>

      <ol className="timeline-list">
        {visible.length === 0 && <li className="timeline-empty">No events match.</li>}
        {visible.map((event) => (
          <li key={event.id} className={`timeline-item sev-${SEVERITY[event.type] ?? 'info'}`}>
            <span className="timeline-seq">{event.seq}</span>
            <time dateTime={event.occurredAt}>
              {new Date(event.occurredAt).toLocaleTimeString()}
            </time>
            <span className={`label label-${event.dataLabel}`}>{event.dataLabel}</span>
            <span className="timeline-actor">{event.actorLabel}</span>
            {event.taskId === null ? (
              <span className="timeline-summary">{event.summary}</span>
            ) : (
              <button
                type="button"
                className="timeline-summary link"
                onClick={() => onSelectTask(event.taskId!)}
              >
                {event.summary}
              </button>
            )}
            <span className="timeline-type">{event.type}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
