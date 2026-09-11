import { z } from 'zod';

/**
 * Workflow graph definition and validation.
 *
 * Validation runs before a version is saved, so an invalid graph never becomes
 * something a run can start under. Rework loops are the one legal cycle and
 * must be declared explicitly with a bound, because an undeclared cycle is how
 * an agent workflow silently spends a budget forever.
 */
export const NODE_KINDS = [
  'task', 'parallel', 'join', 'conditional', 'review', 'owner_approval',
  'timer', 'connector_action',
] as const;

export const WorkflowNode = z.object({
  key: z.string().min(1),
  kind: z.enum(NODE_KINDS),
  title: z.string().min(1),
  instruction: z.string().default(''),
  /** Role template id whose agent should run this node. */
  roleId: z.string().optional(),
  /** For conditional nodes: the expression evaluated against prior artifacts. */
  condition: z.string().optional(),
  timerSeconds: z.number().int().positive().optional(),
  /** For review nodes: the node whose artifact is reviewed. */
  reviewsNodeKey: z.string().optional(),
  position: z.object({ x: z.number(), y: z.number() }).default({ x: 0, y: 0 }),
});

export const WorkflowEdge = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  /** A rework edge is the only legal backward edge, and must carry a bound. */
  kind: z.enum(['sequence', 'rework']).default('sequence'),
  maxTraversals: z.number().int().min(1).max(10).optional(),
  label: z.string().optional(),
});

export const WorkflowGraph = z.object({
  nodes: z.array(WorkflowNode).min(1),
  edges: z.array(WorkflowEdge),
});

export type WorkflowGraph = z.infer<typeof WorkflowGraph>;
export type WorkflowNode = z.infer<typeof WorkflowNode>;

export interface ValidationIssue {
  readonly code: string;
  readonly severity: 'error' | 'warning';
  readonly message: string;
  readonly nodeKey?: string;
}

export interface ValidationResult {
  readonly valid: boolean;
  readonly issues: readonly ValidationIssue[];
}

export function validateWorkflow(graph: WorkflowGraph): ValidationResult {
  const issues: ValidationIssue[] = [];
  const keys = new Set<string>();

  for (const node of graph.nodes) {
    if (keys.has(node.key)) {
      issues.push({ code: 'DUPLICATE_NODE_KEY', severity: 'error', message: `Node key "${node.key}" appears more than once.`, nodeKey: node.key });
    }
    keys.add(node.key);
  }

  for (const edge of graph.edges) {
    if (!keys.has(edge.from)) {
      issues.push({ code: 'DANGLING_EDGE_SOURCE', severity: 'error', message: `Edge references unknown source node "${edge.from}".` });
    }
    if (!keys.has(edge.to)) {
      issues.push({ code: 'DANGLING_EDGE_TARGET', severity: 'error', message: `Edge references unknown target node "${edge.to}".` });
    }
    if (edge.kind === 'rework' && edge.maxTraversals === undefined) {
      issues.push({ code: 'UNBOUNDED_REWORK', severity: 'error', message: `Rework edge ${edge.from} -> ${edge.to} has no maxTraversals. An unbounded rework loop can spend budget indefinitely.` });
    }
  }

  for (const node of graph.nodes) {
    if (node.kind === 'review') {
      if (node.reviewsNodeKey === undefined) {
        issues.push({ code: 'REVIEW_WITHOUT_TARGET', severity: 'error', message: `Review node "${node.key}" does not say which node it reviews.`, nodeKey: node.key });
      } else if (!keys.has(node.reviewsNodeKey)) {
        issues.push({ code: 'REVIEW_TARGET_UNKNOWN', severity: 'error', message: `Review node "${node.key}" reviews unknown node "${node.reviewsNodeKey}".`, nodeKey: node.key });
      }
    }
    if (node.kind === 'conditional' && node.condition === undefined) {
      issues.push({ code: 'CONDITIONAL_WITHOUT_CONDITION', severity: 'error', message: `Conditional node "${node.key}" has no condition.`, nodeKey: node.key });
    }
    if (node.kind === 'timer' && node.timerSeconds === undefined) {
      issues.push({ code: 'TIMER_WITHOUT_DURATION', severity: 'error', message: `Timer node "${node.key}" has no duration.`, nodeKey: node.key });
    }
  }

  // Cycle detection over sequence edges only. Rework edges are intentional
  // backward edges and are excluded, which is exactly why they must be bounded.
  const sequence = graph.edges.filter((e) => e.kind === 'sequence');
  const adjacency = new Map<string, string[]>();
  for (const key of keys) adjacency.set(key, []);
  for (const edge of sequence) adjacency.get(edge.from)?.push(edge.to);

  const WHITE = 0, GREY = 1, BLACK = 2;
  const colour = new Map<string, number>([...keys].map((k) => [k, WHITE]));
  const stack: string[] = [];

  const visit = (key: string): string[] | null => {
    colour.set(key, GREY);
    stack.push(key);
    for (const next of adjacency.get(key) ?? []) {
      const c = colour.get(next);
      if (c === GREY) return [...stack.slice(stack.indexOf(next)), next];
      if (c === WHITE) {
        const found = visit(next);
        if (found !== null) return found;
      }
    }
    stack.pop();
    colour.set(key, BLACK);
    return null;
  };

  for (const key of keys) {
    if (colour.get(key) === WHITE) {
      const cycle = visit(key);
      if (cycle !== null) {
        issues.push({
          code: 'DEPENDENCY_CYCLE', severity: 'error',
          message: `Sequence edges form a cycle: ${cycle.join(' -> ')}. If this is intended rework, mark the backward edge kind:"rework" with a maxTraversals bound.`,
        });
        break;
      }
    }
  }

  // Unreachable nodes are a warning: they may be work in progress, but they
  // will never run, and silently never running is worse than being told.
  //
  // Roots are computed over SEQUENCE edges only. A rework edge points backwards
  // by definition, so counting it as an incoming edge would disqualify a
  // legitimate entry point and report a reachable node as unreachable.
  const hasIncoming = new Set(sequence.map((e) => e.to));
  const roots = [...keys].filter((k) => !hasIncoming.has(k));
  if (roots.length === 0 && keys.size > 0) {
    issues.push({ code: 'NO_ENTRY_NODE', severity: 'error', message: 'Every node has an incoming edge, so the workflow has no entry point.' });
  }
  const reachable = new Set<string>();
  const walk = (key: string): void => {
    if (reachable.has(key)) return;
    reachable.add(key);
    for (const next of adjacency.get(key) ?? []) walk(next);
  };
  for (const root of roots) walk(root);
  for (const key of keys) {
    if (!reachable.has(key)) {
      issues.push({ code: 'UNREACHABLE_NODE', severity: 'warning', message: `Node "${key}" is unreachable from any entry point and will never run.`, nodeKey: key });
    }
  }

  return { valid: !issues.some((i) => i.severity === 'error'), issues };
}

/** Topological order over sequence edges; used to seed task dependencies. */
export function topologicalOrder(graph: WorkflowGraph): string[] {
  const indegree = new Map<string, number>(graph.nodes.map((n) => [n.key, 0]));
  const adjacency = new Map<string, string[]>(graph.nodes.map((n) => [n.key, []]));
  for (const edge of graph.edges.filter((e) => e.kind === 'sequence')) {
    adjacency.get(edge.from)?.push(edge.to);
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  }
  const queue = [...indegree.entries()].filter(([, d]) => d === 0).map(([k]) => k).sort();
  const out: string[] = [];
  while (queue.length > 0) {
    const key = queue.shift()!;
    out.push(key);
    for (const next of adjacency.get(key) ?? []) {
      const d = (indegree.get(next) ?? 1) - 1;
      indegree.set(next, d);
      if (d === 0) queue.push(next);
    }
  }
  return out;
}
