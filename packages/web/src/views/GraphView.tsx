import {
  Background, Controls, type Edge, MiniMap, type Node, type NodeChange, type EdgeChange,
  ReactFlow, addEdge, applyEdgeChanges, applyNodeChanges, type Connection,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ROLE_TEMPLATES } from '@sqhq/shared';
import { api } from '../api/client.js';

const NODE_KINDS = [
  'task', 'parallel', 'join', 'conditional', 'review', 'owner_approval',
  'timer', 'connector_action',
] as const;
type NodeKind = (typeof NODE_KINDS)[number];

interface NodeData extends Record<string, unknown> {
  label: string;
  kind: NodeKind;
  instruction: string;
  roleId: string | null;
  condition: string | null;
  timerSeconds: number | null;
  reviewsNodeKey: string | null;
}

export interface GraphViewProps {
  readonly workspaceId: string;
  readonly projectId: string | null;
  readonly onSaved: () => void;
  readonly onNotify: (message: string, kind: 'ok' | 'error') => void;
}

const KIND_COLOR: Record<NodeKind, string> = {
  task: '#0f7b7b', parallel: '#2a5cc8', join: '#2a5cc8', conditional: '#c9891f',
  review: '#8c3a6b', owner_approval: '#e0654f', timer: '#6f6a65', connector_action: '#3a4047',
};

/**
 * Drag-and-drop workflow editor.
 *
 * Validation runs against the SERVER before anything is saved, using the same
 * validator the orchestrator uses, so the editor cannot show a graph as
 * acceptable that the engine would then reject.
 */
export function GraphView({
  workspaceId, projectId, onSaved, onNotify,
}: GraphViewProps): React.JSX.Element {
  const [nodes, setNodes] = useState<Node<NodeData>[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [name, setName] = useState('Opportunity research to dossier');
  const [issues, setIssues] = useState<{ code: string; severity: string; message: string; nodeKey?: string }[]>([]);
  const [valid, setValid] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [versions, setVersions] = useState<Record<string, unknown>[]>([]);

  useEffect(() => {
    if (projectId === null) return;
    void api.workflows(projectId).then((d) => setVersions(d.versions)).catch(() => setVersions([]));
  }, [projectId, saving]);

  /** Load the default product workflow, which mirrors the documented sequence. */
  const loadDefault = useCallback(() => {
    const seed: { key: string; kind: NodeKind; title: string; roleId: string | null; x: number; y: number; extra?: Partial<NodeData> }[] = [
      { key: 'demand', kind: 'task', title: 'Collect customer need evidence', roleId: 'customer-discovery', x: 0, y: 0 },
      { key: 'competition', kind: 'task', title: 'Check substitutes and delivered prices', roleId: 'market-analyst', x: 0, y: 150 },
      { key: 'spec', kind: 'task', title: 'Define use case and specification', roleId: 'product-manager', x: 260, y: 0 },
      { key: 'cultural', kind: 'review', title: 'Cultural and localisation review', roleId: 'cultural-reviewer', x: 260, y: 150, extra: { reviewsNodeKey: 'spec' } },
      { key: 'sourcing', kind: 'task', title: 'Find supplier leads', roleId: 'china-sourcing', x: 520, y: 0 },
      { key: 'compliance', kind: 'task', title: 'Screen the specification', roleId: 'compliance-research', x: 520, y: 150 },
      { key: 'quotes', kind: 'task', title: 'Prepare comparable quote requests', roleId: 'procurement', x: 780, y: 0 },
      { key: 'finance', kind: 'task', title: 'Model landed cost and cash', roleId: 'finance-pricing', x: 1040, y: 0 },
      { key: 'logistics', kind: 'task', title: 'Test timing and fulfillment', roleId: 'logistics', x: 1040, y: 150 },
      { key: 'join', kind: 'join', title: 'Combine economics and timing', roleId: null, x: 1300, y: 75 },
      { key: 'challenge', kind: 'review', title: 'Independent challenger review', roleId: 'challenger', x: 1560, y: 75, extra: { reviewsNodeKey: 'join' } },
      { key: 'decide', kind: 'owner_approval', title: 'Owner reviews a concrete proposal', roleId: null, x: 1820, y: 75 },
    ];
    setNodes(seed.map((n) => ({
      id: n.key,
      position: { x: n.x, y: n.y },
      data: {
        label: n.title, kind: n.kind, instruction: n.title, roleId: n.roleId,
        condition: null, timerSeconds: null, reviewsNodeKey: null, ...n.extra,
      },
      type: 'default',
      style: { borderColor: KIND_COLOR[n.kind] },
    })));
    setEdges([
      ['demand', 'spec'], ['competition', 'spec'], ['spec', 'cultural'],
      ['spec', 'sourcing'], ['spec', 'compliance'], ['sourcing', 'quotes'],
      ['quotes', 'finance'], ['quotes', 'logistics'], ['finance', 'join'],
      ['logistics', 'join'], ['join', 'challenge'], ['challenge', 'decide'],
    ].map(([from, to]) => ({
      id: `${from}->${to}`, source: from!, target: to!,
      data: { kind: 'sequence' },
    })));
    setValid(null);
    setIssues([]);
  }, []);

  const graph = useMemo(() => ({
    nodes: nodes.map((n) => ({
      key: n.id,
      kind: n.data.kind,
      title: n.data.label,
      instruction: n.data.instruction,
      ...(n.data.roleId !== null ? { roleId: n.data.roleId } : {}),
      ...(n.data.condition !== null ? { condition: n.data.condition } : {}),
      ...(n.data.timerSeconds !== null ? { timerSeconds: n.data.timerSeconds } : {}),
      ...(n.data.reviewsNodeKey !== null ? { reviewsNodeKey: n.data.reviewsNodeKey } : {}),
      position: { x: n.position.x, y: n.position.y },
    })),
    edges: edges.map((e) => ({
      from: e.source,
      to: e.target,
      kind: ((e.data as { kind?: string } | undefined)?.kind ?? 'sequence') as 'sequence' | 'rework',
      ...((e.data as { maxTraversals?: number } | undefined)?.maxTraversals !== undefined
        ? { maxTraversals: (e.data as { maxTraversals: number }).maxTraversals } : {}),
    })),
  }), [nodes, edges]);

  const validate = useCallback(async () => {
    try {
      const result = await api.validateWorkflow(graph);
      setValid(result.valid);
      setIssues(result.issues);
    } catch (error) {
      onNotify(error instanceof Error ? error.message : 'Validation failed', 'error');
    }
  }, [graph, onNotify]);

  const save = useCallback(async () => {
    if (projectId === null) { onNotify('Select a project first.', 'error'); return; }
    setSaving(true);
    try {
      const result = await api.saveWorkflow({
        workspaceId, projectId, name, graph, instantiate: true,
      });
      onNotify(`Saved version ${result.version} and instantiated ${result.tasks.length} tasks.`, 'ok');
      onSaved();
    } catch (error) {
      onNotify(error instanceof Error ? error.message : 'Save failed', 'error');
    } finally {
      setSaving(false);
    }
  }, [projectId, workspaceId, name, graph, onNotify, onSaved]);

  const selected = nodes.find((n) => n.id === selectedId) ?? null;

  const updateSelected = (patch: Partial<NodeData>): void => {
    if (selectedId === null) return;
    setNodes((prev) => prev.map((n) => (n.id === selectedId
      ? { ...n, data: { ...n.data, ...patch }, style: { borderColor: KIND_COLOR[(patch.kind ?? n.data.kind)] } }
      : n)));
    setValid(null);
  };

  const addNode = (kind: NodeKind): void => {
    const key = `${kind}-${nodes.length + 1}`;
    setNodes((prev) => [...prev, {
      id: key,
      position: { x: 80 + (prev.length % 6) * 180, y: 320 + Math.floor(prev.length / 6) * 120 },
      data: {
        label: `New ${kind.replace(/_/g, ' ')}`, kind, instruction: '', roleId: null,
        condition: kind === 'conditional' ? 'artifact.demand.recommendation == "continue_research"' : null,
        timerSeconds: kind === 'timer' ? 3600 : null,
        reviewsNodeKey: null,
      },
      type: 'default',
      style: { borderColor: KIND_COLOR[kind] },
    }]);
    setSelectedId(key);
    setValid(null);
  };

  return (
    <div className="view view-graph">
      <div className="graph-toolbar">
        <label>
          <span className="sr-only">Workflow name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Workflow name" />
        </label>
        <button type="button" onClick={loadDefault}>Load default product workflow</button>
        <span className="divider" aria-hidden="true" />
        {NODE_KINDS.map((kind) => (
          <button key={kind} type="button" onClick={() => addNode(kind)}>
            + {kind.replace(/_/g, ' ')}
          </button>
        ))}
        <span className="divider" aria-hidden="true" />
        <button type="button" onClick={() => void validate()}>Validate</button>
        <button
          type="button"
          className="primary"
          onClick={() => void save()}
          disabled={saving || nodes.length === 0 || valid === false}
          title={valid === false ? 'Fix the validation errors first.' : 'Saves an immutable version and instantiates its tasks.'}
        >
          {saving ? 'Saving…' : 'Save and instantiate'}
        </button>
        {versions.length > 0 && (
          <span className="muted">{versions.length} saved version{versions.length === 1 ? '' : 's'}</span>
        )}
      </div>

      {valid !== null && (
        <div className={`graph-validation ${valid ? 'ok' : 'bad'}`} role="status">
          <strong>{valid ? 'Valid' : 'Invalid — not saveable'}</strong>
          {issues.length === 0 && <span> · no issues</span>}
          <ul>
            {issues.map((issue, index) => (
              <li key={index} className={`sev-${issue.severity}`}>
                <code>{issue.code}</code> {issue.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="graph-canvas">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={(changes: NodeChange<Node<NodeData>>[]) =>
            setNodes((prev) => applyNodeChanges(changes, prev))}
          onEdgesChange={(changes: EdgeChange[]) =>
            setEdges((prev) => applyEdgeChanges(changes, prev))}
          onConnect={(connection: Connection) => {
            setEdges((prev) => addEdge({ ...connection, data: { kind: 'sequence' } }, prev));
            setValid(null);
          }}
          onNodeClick={(_, node) => setSelectedId(node.id)}
          onEdgeClick={(_, edge) => {
            // Toggle an edge between a forward sequence edge and a bounded
            // rework edge. An unbounded rework edge is rejected by validation.
            setEdges((prev) => prev.map((e) => {
              if (e.id !== edge.id) return e;
              const isRework = (e.data as { kind?: string } | undefined)?.kind === 'rework';
              if (isRework) {
                // Back to a plain forward edge. The optional presentation keys
                // are DELETED rather than set to undefined: with
                // exactOptionalPropertyTypes an explicit undefined is not the
                // same as absent.
                const { label: _label, style: _style, ...rest } = e;
                return { ...rest, data: { kind: 'sequence' }, animated: false };
              }
              return {
                ...e,
                data: { kind: 'rework', maxTraversals: 2 },
                label: 'rework ×2',
                animated: true,
                style: { stroke: '#c9891f' },
              };
            }));
            setValid(null);
          }}
          fitView
          proOptions={{ hideAttribution: false }}
        >
          <Background />
          <Controls />
          <MiniMap pannable zoomable />
        </ReactFlow>
      </div>

      {selected !== null && (
        <div className="graph-node-editor">
          <h3>Node: {selected.id}</h3>
          <label>
            <span>Title</span>
            <input value={selected.data.label} onChange={(e) => updateSelected({ label: e.target.value })} />
          </label>
          <label>
            <span>Kind</span>
            <select
              value={selected.data.kind}
              onChange={(e) => updateSelected({ kind: e.target.value as NodeKind })}
            >
              {NODE_KINDS.map((k) => <option key={k} value={k}>{k.replace(/_/g, ' ')}</option>)}
            </select>
          </label>
          <label>
            <span>Role</span>
            <select
              value={selected.data.roleId ?? ''}
              onChange={(e) => updateSelected({ roleId: e.target.value === '' ? null : e.target.value })}
            >
              <option value="">No agent (control flow only)</option>
              {ROLE_TEMPLATES.map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}
            </select>
          </label>
          <label>
            <span>Instruction</span>
            <textarea
              rows={3}
              value={selected.data.instruction}
              onChange={(e) => updateSelected({ instruction: e.target.value })}
            />
          </label>
          {selected.data.kind === 'conditional' && (
            <label>
              <span>Condition</span>
              <input
                value={selected.data.condition ?? ''}
                onChange={(e) => updateSelected({ condition: e.target.value })}
                placeholder='artifact.demand.recommendation == "continue_research"'
              />
              <small className="muted">
                A single comparison over a prior node&rsquo;s artifact. Not a JavaScript
                expression: an evaluator here would be remote code execution.
              </small>
            </label>
          )}
          {selected.data.kind === 'timer' && (
            <label>
              <span>Delay (seconds)</span>
              <input
                type="number"
                min={1}
                value={selected.data.timerSeconds ?? 3600}
                onChange={(e) => updateSelected({ timerSeconds: Number(e.target.value) })}
              />
            </label>
          )}
          {selected.data.kind === 'review' && (
            <label>
              <span>Reviews node</span>
              <select
                value={selected.data.reviewsNodeKey ?? ''}
                onChange={(e) => updateSelected({ reviewsNodeKey: e.target.value === '' ? null : e.target.value })}
              >
                <option value="">Select a node</option>
                {nodes.filter((n) => n.id !== selected.id).map((n) => (
                  <option key={n.id} value={n.id}>{n.id}</option>
                ))}
              </select>
            </label>
          )}
          <button
            type="button"
            className="danger"
            onClick={() => {
              setNodes((prev) => prev.filter((n) => n.id !== selected.id));
              setEdges((prev) => prev.filter((e) => e.source !== selected.id && e.target !== selected.id));
              setSelectedId(null);
              setValid(null);
            }}
          >
            Delete node
          </button>
        </div>
      )}
    </div>
  );
}
