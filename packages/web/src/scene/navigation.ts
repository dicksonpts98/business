import { NAV_EDGES, ZONE_LAYOUT, type Zone } from '@sqhq/shared';

export type Vec3 = readonly [number, number, number];

const CENTRE = new Map<Zone, Vec3>(
  ZONE_LAYOUT.map((z) => [z.zone, z.position as Vec3]),
);

export function zoneCentre(zone: Zone): Vec3 {
  return CENTRE.get(zone) ?? [0, 0, 0];
}

const ADJACENCY = ((): Map<Zone, Zone[]> => {
  const map = new Map<Zone, Zone[]>(ZONE_LAYOUT.map((z) => [z.zone, []]));
  for (const [a, b] of NAV_EDGES) {
    map.get(a)?.push(b);
    map.get(b)?.push(a);
  }
  return map;
})();

/**
 * Shortest path between two zones by breadth-first search.
 *
 * This is purely cosmetic. Walking is how a handoff is DRAWN; it never gates,
 * delays or orders backend execution. If a result arrives while an avatar is
 * still mid-corridor, the inspector and the timeline show the new state
 * immediately and the walk simply finishes on its own.
 */
export function findPath(from: Zone, to: Zone): Zone[] {
  if (from === to) return [from];
  const queue: Zone[] = [from];
  const previous = new Map<Zone, Zone>();
  const seen = new Set<Zone>([from]);
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const next of ADJACENCY.get(current) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      previous.set(next, current);
      if (next === to) {
        const path: Zone[] = [to];
        let step: Zone = to;
        while (previous.has(step)) {
          step = previous.get(step)!;
          path.unshift(step);
        }
        return path;
      }
      queue.push(next);
    }
  }
  // Disconnected zones: walk straight there rather than refusing to move.
  return [from, to];
}

/** Deterministic desk offset so agents in one room do not stand inside each other. */
export function deskOffset(index: number, total: number): Vec3 {
  if (total <= 1) return [0, 0, 0];
  const perRow = Math.ceil(Math.sqrt(total));
  const row = Math.floor(index / perRow);
  const column = index % perRow;
  const rows = Math.ceil(total / perRow);
  const spacing = 1.75;
  return [
    (column - (perRow - 1) / 2) * spacing,
    0,
    (row - (rows - 1) / 2) * spacing,
  ];
}

export function addVec(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** Total length of a polyline, used to pace a walk at constant speed. */
export function pathLength(points: readonly Vec3[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    total += distance(points[i - 1]!, points[i]!);
  }
  return total;
}

/** Position at a normalised distance `t` (0..1) along a polyline. */
export function pointAlong(points: readonly Vec3[], t: number): Vec3 {
  if (points.length === 0) return [0, 0, 0];
  if (points.length === 1) return points[0]!;
  const total = pathLength(points);
  if (total === 0) return points[0]!;
  let remaining = Math.max(0, Math.min(1, t)) * total;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const segment = distance(a, b);
    if (remaining <= segment || i === points.length - 1) {
      const f = segment === 0 ? 0 : remaining / segment;
      return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
    }
    remaining -= segment;
  }
  return points.at(-1)!;
}

export function headingBetween(a: Vec3, b: Vec3): number {
  return Math.atan2(b[0] - a[0], b[2] - a[2]);
}
