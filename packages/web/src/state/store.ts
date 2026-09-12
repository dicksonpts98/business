import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentPresence, WireEvent } from '@sqhq/shared';
import {
  type AgentRow, type ApprovalRow, type ArtifactRow, type EvidenceRow,
  type HealthResponse, type ProjectRow, type TaskRow, api,
} from '../api/client.js';

export type ConnectionState = 'connecting' | 'live' | 'reconnecting' | 'failed';

export interface WorkspaceSnapshot {
  health: HealthResponse | null;
  projects: ProjectRow[];
  tasks: TaskRow[];
  agents: AgentRow[];
  presence: AgentPresence[];
  approvals: ApprovalRow[];
  evidence: EvidenceRow[];
  artifacts: ArtifactRow[];
}

const EMPTY: WorkspaceSnapshot = {
  health: null, projects: [], tasks: [], agents: [],
  presence: [], approvals: [], evidence: [], artifacts: [],
};

export interface WorkspaceStore extends WorkspaceSnapshot {
  workspaceId: string | null;
  events: WireEvent[];
  connection: ConnectionState;
  cursor: number;
  /** Events discarded as duplicates. Surfaced so the claim is checkable. */
  duplicatesIgnored: number;
  error: string | null;
  refresh: () => Promise<void>;
}

const MAX_TIMELINE = 400;

/**
 * Event-sourced client state.
 *
 * Two properties matter and are both visible in the UI:
 *
 *  * RESUME. The stream carries a gap-free per-workspace sequence. The client
 *    records the highest sequence it has applied and reconnects from there, so a
 *    refresh, a dropped connection or a server restart all converge on the same
 *    state rather than starting from an empty timeline.
 *
 *  * DEDUPLICATION. Delivery is not exactly-once, so the same event can arrive
 *    twice — on reconnect, most obviously. Events are keyed by id, and a repeat
 *    is counted rather than appended. This is why a reconnect does not produce a
 *    doubled visual history.
 */
export function useWorkspaceStore(): WorkspaceStore {
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot>(EMPTY);
  const [events, setEvents] = useState<WireEvent[]>([]);
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [cursor, setCursor] = useState(0);
  const [duplicatesIgnored, setDuplicatesIgnored] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const seenIds = useRef<Set<string>>(new Set());
  const cursorRef = useRef(0);
  const workspaceId = snapshot.health?.workspace?.id ?? null;

  const loadSnapshot = useCallback(async (id: string): Promise<void> => {
    const [projects, tasks, agents, presence, approvals, evidence, artifacts] = await Promise.all([
      api.projects(id), api.tasks(id), api.agents(id), api.presence(id),
      api.approvals(id), api.evidence(id), api.artifacts(id),
    ]);
    setSnapshot((prev) => ({
      ...prev,
      projects: projects.projects,
      tasks: tasks.tasks,
      agents: agents.agents,
      presence: presence.presence,
      approvals: approvals.approvals,
      evidence: evidence.evidence,
      artifacts: artifacts.artifacts,
    }));
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    const health = await api.health();
    setSnapshot((prev) => ({ ...prev, health }));
    if (health.workspace !== null) await loadSnapshot(health.workspace.id);
  }, [loadSnapshot]);

  /** Apply an event, ignoring one already seen. */
  const applyEvent = useCallback((event: WireEvent): boolean => {
    if (seenIds.current.has(event.id)) {
      setDuplicatesIgnored((n) => n + 1);
      return false;
    }
    seenIds.current.add(event.id);
    setEvents((prev) => {
      const next = [...prev, event];
      next.sort((a, b) => a.seq - b.seq);
      return next.length > MAX_TIMELINE ? next.slice(next.length - MAX_TIMELINE) : next;
    });
    if (event.seq > cursorRef.current) {
      cursorRef.current = event.seq;
      setCursor(event.seq);
    }
    return true;
  }, []);

  /* Initial load: health, snapshot, then the recent event history. */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const health = await api.health();
        if (cancelled) return;
        setSnapshot((prev) => ({ ...prev, health }));
        if (health.workspace === null) {
          setConnection('failed');
          setError('No workspace found. Run `npm run seed` to create the demo company.');
          return;
        }
        const id = health.workspace.id;
        await loadSnapshot(id);
        if (cancelled) return;
        // Rebuild the timeline from the durable log, so a refresh loses nothing.
        const history = await api.events(id, 0, MAX_TIMELINE);
        if (cancelled) return;
        for (const event of history.events) applyEvent(event);
        cursorRef.current = history.latestSeq;
        setCursor(history.latestSeq);
        setConnection('live');
      } catch (cause) {
        if (cancelled) return;
        setConnection('failed');
        setError(cause instanceof Error ? cause.message : 'Could not reach the API.');
      }
    })();
    return () => { cancelled = true; };
  }, [applyEvent, loadSnapshot]);

  /* Live stream, resuming from the cursor. */
  useEffect(() => {
    if (workspaceId === null) return;
    let source: EventSource | null = null;
    let closed = false;
    let reconnectTimer: number | undefined;
    let pendingRefresh: number | undefined;

    const scheduleRefresh = (): void => {
      // Coalesce: a burst of events causes one snapshot refetch, not twenty.
      window.clearTimeout(pendingRefresh);
      pendingRefresh = window.setTimeout(() => {
        void loadSnapshot(workspaceId).catch(() => { /* the stream will retry */ });
      }, 350);
    };

    const connect = (): void => {
      if (closed) return;
      source = new EventSource(
        `/api/events/stream?workspaceId=${workspaceId}&afterSeq=${cursorRef.current}`,
      );
      source.onopen = () => { if (!closed) setConnection('live'); };
      source.onmessage = (message: MessageEvent<string>) => {
        try {
          const event = JSON.parse(message.data) as WireEvent;
          if (applyEvent(event)) scheduleRefresh();
        } catch { /* a malformed frame must not kill the stream */ }
      };
      // Named event types arrive as their own listeners, so subscribe generically.
      source.addEventListener('stream.opened', () => { if (!closed) setConnection('live'); });
      source.onerror = () => {
        if (closed) return;
        setConnection('reconnecting');
        source?.close();
        // Explicit reconnect from the recorded cursor rather than relying on the
        // browser's own retry, so the resume point is always ours.
        reconnectTimer = window.setTimeout(connect, 1200);
      };
    };

    connect();
    return () => {
      closed = true;
      window.clearTimeout(reconnectTimer);
      window.clearTimeout(pendingRefresh);
      source?.close();
    };
  }, [workspaceId, applyEvent, loadSnapshot]);

  return useMemo(() => ({
    ...snapshot, workspaceId, events, connection, cursor, duplicatesIgnored, error, refresh,
  }), [snapshot, workspaceId, events, connection, cursor, duplicatesIgnored, error, refresh]);
}

/** Pause rendering when the tab is hidden, so a background tab costs nothing. */
export function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(() =>
    typeof document === 'undefined' ? true : document.visibilityState === 'visible');
  useEffect(() => {
    const onChange = (): void => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);
  return visible;
}

/** Honour the viewer's reduced-motion preference for every animation. */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() =>
    typeof window !== 'undefined'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = (e: MediaQueryListEvent): void => setReduced(e.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

/** Detect WebGL support up front so the fallback is a choice, not a crash. */
export function useWebglSupported(): boolean | null {
  const [supported, setSupported] = useState<boolean | null>(null);
  useEffect(() => {
    try {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
      setSupported(gl !== null);
    } catch {
      setSupported(false);
    }
  }, []);
  return supported;
}
