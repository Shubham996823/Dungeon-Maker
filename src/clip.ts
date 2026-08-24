import { ClipType, Clipper64, FillRule, PathType } from "clipper2-ts";
import type { Path64, Paths64 } from "clipper2-ts";
import type { PlanPoint } from "./types";

/**
 * Clipper2 works in integers, which is what makes it immune to the coincident-edge
 * failures that plague floating-point clippers. Plan coordinates are metres, so one
 * clipper unit is one millimetre — far finer than the 1–3 mm sagitta of our circle
 * polylines, and comfortably inside the safe integer range for any plausible plan.
 */
const SCALE = 1000;

/** Rings below this area are clipper slivers, not floor. */
const MIN_RING_AREA = 1e-6;

const EPSILON = 1e-9;

/**
 * Tag reserved for vertices the clipper invents where two source outlines cross. A junction
 * belongs to the runs on both sides of it, so it is never a run's identity.
 *
 * Zero is deliberate: Clipper2 leaves `z` undefined on some synthesised points, and an
 * undefined tag reads as a junction, which is the safe default.
 */
export const JUNCTION_TAG = 0;

export interface TaggedPoint extends PlanPoint {
  /**
   * Positive integer naming the source run this vertex came from. Tags are per-vertex
   * rather than per-polygon because an edited cell outline is already a mix of straight,
   * diagonal and curved runs before it ever reaches the union.
   */
  tag: number;
}

export interface ClipRing {
  points: TaggedPoint[];
  /**
   * Counter-clockwise rings bound floor, clockwise rings are holes — the same convention
   * `traceCellBoundaryLoops` already produces for cell loops.
   */
  outer: boolean;
}

export interface ClipRun {
  /** Tag of the source run, or `JUNCTION_TAG` for a sliver between two crossings. */
  tag: number;
  points: TaggedPoint[];
  /** True when the run is the entire ring, so its wall has to close on itself. */
  closed: boolean;
}

function signedAreaOf(points: PlanPoint[]) {
  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    area += current.x * next.y - next.x * current.y;
  }
  return area / 2;
}

/**
 * Drop vertices sitting on a straight line between their neighbours. Clipper keeps the
 * midpoints where two abutting cells met, and each would otherwise become its own
 * single-segment wall run. A vertex is only dropped when both neighbours share its tag, so
 * no run boundary — and so no junction — is ever collapsed away.
 */
function simplifySameTag(points: TaggedPoint[]) {
  if (points.length < 4) return points;
  return points.filter((current, index) => {
    const previous = points[(index - 1 + points.length) % points.length];
    const next = points[(index + 1) % points.length];
    if (current.tag !== previous.tag || current.tag !== next.tag) return true;
    const cross = (current.x - previous.x) * (next.y - current.y)
      - (current.y - previous.y) * (next.x - current.x);
    return Math.abs(cross) > EPSILON;
  });
}

function dropRepeats(points: TaggedPoint[]) {
  return points.filter((current, index) => {
    const previous = points[(index - 1 + points.length) % points.length];
    return Math.abs(current.x - previous.x) > EPSILON || Math.abs(current.y - previous.y) > EPSILON;
  });
}

/**
 * N-way union of tagged outlines, carrying each vertex's provenance through the boolean op.
 *
 * Provenance rides on Clipper2's per-vertex `z` payload: vertices that survive keep the tag
 * they went in with, and the `zCallback` stamps `JUNCTION_TAG` on points the clipper invents
 * where two outlines cross. That is what lets a caller tell an arc run from a straight one
 * afterwards — a "distance to centre ≈ radius" test could not, because intersection points
 * land on the polygon *chord*, not the true circle (24 mm out at r = 20 m).
 *
 * Feed outer outlines counter-clockwise and holes clockwise; with `NonZero` that yields the
 * expected donut. Holes come back clockwise, so callers keep using the signed-area test.
 */
export function unionTagged(polygons: TaggedPoint[][]): ClipRing[] {
  const subjects: Paths64 = polygons
    .filter((points) => points.length >= 3)
    .map((points) => points.map((point) => ({
      x: Math.round(point.x * SCALE),
      y: Math.round(point.y * SCALE),
      z: point.tag,
    })));
  if (!subjects.length) return [];

  const clipper = new Clipper64();
  clipper.zCallback = (_bottom1, _top1, _bottom2, _top2, intersection) => {
    intersection.z = JUNCTION_TAG;
  };
  clipper.addPaths(subjects, PathType.Subject);

  const solution: Paths64 = [];
  if (!clipper.execute(ClipType.Union, FillRule.NonZero, solution)) return [];

  const rings: ClipRing[] = [];
  for (const path of solution as Path64[]) {
    const scaled = path.map((point) => ({
      x: point.x / SCALE,
      y: point.y / SCALE,
      tag: point.z ?? JUNCTION_TAG,
    }));
    const points = simplifySameTag(dropRepeats(scaled));
    if (points.length < 3) continue;
    const area = signedAreaOf(points);
    if (Math.abs(area) < MIN_RING_AREA) continue;
    rings.push({ points, outer: area > 0 });
  }
  // Largest first, matching the order `traceCellBoundaryLoops` returns.
  return rings.sort((a, b) => Math.abs(signedAreaOf(b.points)) - Math.abs(signedAreaOf(a.points)));
}

/**
 * Split a ring into maximal runs of one provenance. Cuts fall on junction vertices and on
 * every tag change, and **each run repeats its neighbour's boundary vertex**, so consecutive
 * wall runs meet exactly instead of leaving a hairline gap.
 *
 * A ring of a single provenance returns one run flagged `closed` — a circle that survived the
 * union untouched still wants one continuous curved wall rather than an open polyline.
 */
export function splitRuns(ring: ClipRing): ClipRun[] {
  const { points } = ring;
  const count = points.length;
  const cuts: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const previous = points[(index - 1 + count) % count];
    const current = points[index];
    if (current.tag === JUNCTION_TAG || current.tag !== previous.tag) cuts.push(index);
  }

  if (!cuts.length) return [{ tag: points[0].tag, points: [...points, points[0]], closed: true }];

  const runs: ClipRun[] = [];
  for (let cut = 0; cut < cuts.length; cut += 1) {
    const start = cuts[cut];
    const end = cuts[(cut + 1) % cuts.length];
    const slice: TaggedPoint[] = [];
    let index = start;
    // Walk forward to the next cut inclusive, so adjacent runs share that vertex.
    for (let guard = 0; guard <= count; guard += 1) {
      slice.push(points[index]);
      if (index === end && slice.length > 1) break;
      index = (index + 1) % count;
    }
    if (slice.length < 2) continue;
    // A run's identity is its first non-junction vertex. An all-junction run is a
    // degenerate sliver between two crossings, and straight is the safe reading.
    const identity = slice.find((point) => point.tag !== JUNCTION_TAG)?.tag ?? JUNCTION_TAG;
    runs.push({ tag: identity, points: slice, closed: false });
  }
  return runs;
}
