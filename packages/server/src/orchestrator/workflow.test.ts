import { describe, expect, it } from 'vitest';
import { WorkflowGraph, topologicalOrder, validateWorkflow } from './workflow.js';

const parse = (g: unknown): WorkflowGraph => WorkflowGraph.parse(g);
const codes = (g: unknown) => validateWorkflow(parse(g)).issues.map((i) => i.code);

const linear = {
  nodes: [
    { key: 'a', kind: 'task', title: 'A' },
    { key: 'b', kind: 'task', title: 'B' },
  ],
  edges: [{ from: 'a', to: 'b', kind: 'sequence' }],
};

describe('validateWorkflow', () => {
  it('accepts a linear graph', () => {
    expect(validateWorkflow(parse(linear)).valid).toBe(true);
    expect(validateWorkflow(parse(linear)).issues).toHaveLength(0);
  });

  it('accepts a parallel-then-join graph', () => {
    const g = {
      nodes: [
        { key: 'a', kind: 'task', title: 'A' },
        { key: 'b', kind: 'task', title: 'B' },
        { key: 'j', kind: 'join', title: 'J' },
      ],
      edges: [
        { from: 'a', to: 'j', kind: 'sequence' },
        { from: 'b', to: 'j', kind: 'sequence' },
      ],
    };
    expect(validateWorkflow(parse(g)).valid).toBe(true);
  });

  it('rejects a cycle in sequence edges', () => {
    const g = {
      nodes: [{ key: 'a', kind: 'task', title: 'A' }, { key: 'b', kind: 'task', title: 'B' }],
      edges: [
        { from: 'a', to: 'b', kind: 'sequence' },
        { from: 'b', to: 'a', kind: 'sequence' },
      ],
    };
    expect(codes(g)).toContain('DEPENDENCY_CYCLE');
    expect(validateWorkflow(parse(g)).valid).toBe(false);
  });

  it('accepts a BOUNDED rework edge that points backwards', () => {
    const g = {
      nodes: [
        { key: 'a', kind: 'task', title: 'A' },
        { key: 'r', kind: 'review', title: 'R', reviewsNodeKey: 'a' },
      ],
      edges: [
        { from: 'a', to: 'r', kind: 'sequence' },
        { from: 'r', to: 'a', kind: 'rework', maxTraversals: 2 },
      ],
    };
    const result = validateWorkflow(parse(g));
    expect(result.valid).toBe(true);
    // The regression this guards: a rework edge must not make `a` look non-root
    // and therefore unreachable.
    expect(result.issues).toHaveLength(0);
  });

  it('rejects an UNBOUNDED rework edge', () => {
    const g = {
      nodes: [
        { key: 'a', kind: 'task', title: 'A' },
        { key: 'r', kind: 'review', title: 'R', reviewsNodeKey: 'a' },
      ],
      edges: [
        { from: 'a', to: 'r', kind: 'sequence' },
        { from: 'r', to: 'a', kind: 'rework' },
      ],
    };
    expect(codes(g)).toContain('UNBOUNDED_REWORK');
    expect(validateWorkflow(parse(g)).valid).toBe(false);
  });

  it('rejects dangling edge endpoints', () => {
    const g = {
      nodes: [{ key: 'a', kind: 'task', title: 'A' }],
      edges: [{ from: 'a', to: 'ghost', kind: 'sequence' }],
    };
    expect(codes(g)).toContain('DANGLING_EDGE_TARGET');
  });

  it('rejects duplicate node keys', () => {
    const g = {
      nodes: [{ key: 'a', kind: 'task', title: 'A' }, { key: 'a', kind: 'task', title: 'A2' }],
      edges: [],
    };
    expect(codes(g)).toContain('DUPLICATE_NODE_KEY');
  });

  it('rejects a review node with no or unknown target', () => {
    expect(codes({ nodes: [{ key: 'r', kind: 'review', title: 'R' }], edges: [] }))
      .toContain('REVIEW_WITHOUT_TARGET');
    expect(codes({
      nodes: [{ key: 'r', kind: 'review', title: 'R', reviewsNodeKey: 'nope' }], edges: [],
    })).toContain('REVIEW_TARGET_UNKNOWN');
  });

  it('rejects a conditional with no condition and a timer with no duration', () => {
    expect(codes({ nodes: [{ key: 'c', kind: 'conditional', title: 'C' }], edges: [] }))
      .toContain('CONDITIONAL_WITHOUT_CONDITION');
    expect(codes({ nodes: [{ key: 't', kind: 'timer', title: 'T' }], edges: [] }))
      .toContain('TIMER_WITHOUT_DURATION');
  });

  it('treats a node reached only by a rework edge as a valid entry point', () => {
    // Its only incoming edge is backward, so it has no sequence prerequisite
    // and starts immediately. Reporting it unreachable would be wrong.
    const g = {
      nodes: [
        { key: 'a', kind: 'task', title: 'A' },
        { key: 'b', kind: 'task', title: 'B' },
        { key: 'later', kind: 'task', title: 'Later' },
      ],
      edges: [
        { from: 'a', to: 'b', kind: 'sequence' },
        { from: 'b', to: 'later', kind: 'rework', maxTraversals: 1 },
      ],
    };
    const result = validateWorkflow(parse(g));
    expect(result.issues).toHaveLength(0);
    expect(result.valid).toBe(true);
  });

  it('names the nodes stranded by a cycle', () => {
    // Nodes inside a closed cycle have no path from any entry point, so they
    // are named individually rather than left implied by the cycle error.
    const g = {
      nodes: [
        { key: 'a', kind: 'task', title: 'A' },
        { key: 'b', kind: 'task', title: 'B' },
        { key: 'x', kind: 'task', title: 'X' },
        { key: 'y', kind: 'task', title: 'Y' },
      ],
      edges: [
        { from: 'a', to: 'b', kind: 'sequence' },
        { from: 'x', to: 'y', kind: 'sequence' },
        { from: 'y', to: 'x', kind: 'sequence' },
      ],
    };
    const result = validateWorkflow(parse(g));
    expect(result.valid).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain('DEPENDENCY_CYCLE');
    const unreachable = result.issues
      .filter((i) => i.code === 'UNREACHABLE_NODE')
      .map((i) => i.nodeKey);
    expect(unreachable).toEqual(expect.arrayContaining(['x', 'y']));
  });

  it('reports a graph with no entry point', () => {
    const g = {
      nodes: [{ key: 'a', kind: 'task', title: 'A' }],
      edges: [{ from: 'a', to: 'a', kind: 'sequence' }],
    };
    // A self-edge is a cycle, which is also why nothing can start.
    expect(codes(g)).toContain('DEPENDENCY_CYCLE');
  });
});

describe('topologicalOrder', () => {
  it('orders dependencies before dependents', () => {
    const order = topologicalOrder(parse(linear));
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('b'));
  });

  it('places both parallel branches before their join', () => {
    const g = parse({
      nodes: [
        { key: 'a', kind: 'task', title: 'A' },
        { key: 'b', kind: 'task', title: 'B' },
        { key: 'j', kind: 'join', title: 'J' },
      ],
      edges: [
        { from: 'a', to: 'j', kind: 'sequence' },
        { from: 'b', to: 'j', kind: 'sequence' },
      ],
    });
    const order = topologicalOrder(g);
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('j'));
    expect(order.indexOf('b')).toBeLessThan(order.indexOf('j'));
  });

  it('ignores rework edges, so a bounded loop still orders', () => {
    const g = parse({
      nodes: [
        { key: 'a', kind: 'task', title: 'A' },
        { key: 'r', kind: 'review', title: 'R', reviewsNodeKey: 'a' },
      ],
      edges: [
        { from: 'a', to: 'r', kind: 'sequence' },
        { from: 'r', to: 'a', kind: 'rework', maxTraversals: 2 },
      ],
    });
    expect(topologicalOrder(g)).toEqual(['a', 'r']);
  });

  it('is deterministic for independent nodes', () => {
    const g = parse({
      nodes: [
        { key: 'z', kind: 'task', title: 'Z' },
        { key: 'a', kind: 'task', title: 'A' },
        { key: 'm', kind: 'task', title: 'M' },
      ],
      edges: [],
    });
    expect(topologicalOrder(g)).toEqual(topologicalOrder(g));
    expect(topologicalOrder(g)).toEqual(['a', 'm', 'z']);
  });
});
