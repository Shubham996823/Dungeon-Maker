import { JUNCTION_TAG, splitRuns, unionTagged } from "./clip";
import type { TaggedPoint } from "./clip";
import { CELL_SIZE, cellKey, normalizeCells } from "./layout";
import type {
  Cell,
  CellBounds,
  CircleShape,
  CornerEdit,
  CornerHandle,
  PlanPoint,
  RadiusHandle,
  Room,
  RoomGround,
} from "./types";

const EPSILON = 1e-6;

/**
 * Below 2 m the fixed 2 m wall module has to squash more than 10 % to close the
 * ring, which reads as a modelling error rather than a curve.
 */
export const MIN_CIRCLE_RADIUS = 2;

/** Longest chord we allow on a circle, in metres. Keeps the sagitta near 1–3 mm at any radius. */
const MAX_CIRCLE_CHORD = 0.35;

interface DirectedEdge {
  start: PlanPoint;
  end: PlanPoint;
  used: boolean;
}

export interface FootprintPath {
  points: PlanPoint[];
  kind: "straight" | "diagonal" | "curve";
}

export interface PillarAnchor {
  point: PlanPoint;
  inward: PlanPoint;
  /** True when this anchor joins unlike boundary types, such as a circle and square. */
  junction?: boolean;
}

export interface EditedRoomGeometry {
  roomId: string;
  grounds: RoomGround[];
  paths: FootprintPath[];
  handles: CornerHandle[];
  radiusHandles: RadiusHandle[];
  pillarAnchors: PillarAnchor[];
}

const pointKey = (point: PlanPoint) => `${point.x},${point.y}`;

export function signedArea(points: PlanPoint[]) {
  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    area += current.x * next.y - next.x * current.y;
  }
  return area / 2;
}

export function pointInPolygon(point: PlanPoint, polygon: PlanPoint[]) {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    const a = polygon[index];
    const b = polygon[previous];
    const intersects = ((a.y > point.y) !== (b.y > point.y))
      && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y || EPSILON) + a.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

function edgeTurn(previous: DirectedEdge, next: DirectedEdge) {
  const ax = previous.end.x - previous.start.x;
  const ay = previous.end.y - previous.start.y;
  const bx = next.end.x - next.start.x;
  const by = next.end.y - next.start.y;
  return Math.atan2(ax * by - ay * bx, ax * bx + ay * by);
}

function simplifyCollinear(points: PlanPoint[]) {
  if (points.length < 4) return points;
  return points.filter((current, index) => {
    const previous = points[(index - 1 + points.length) % points.length];
    const next = points[(index + 1) % points.length];
    const cross = (current.x - previous.x) * (next.y - current.y) - (current.y - previous.y) * (next.x - current.x);
    return Math.abs(cross) > EPSILON;
  });
}

/** Outer loops are counter-clockwise; hole loops are clockwise. */
export function traceCellBoundaryLoops(inputCells: Room["cells"]): PlanPoint[][] {
  const cells = normalizeCells(inputCells);
  const keys = new Set(cells.map((cell) => cellKey(cell.x, cell.y)));
  const edges: DirectedEdge[] = [];
  for (const cell of cells) {
    if (!keys.has(cellKey(cell.x, cell.y - 1))) edges.push({ start: { x: cell.x, y: cell.y }, end: { x: cell.x + 1, y: cell.y }, used: false });
    if (!keys.has(cellKey(cell.x + 1, cell.y))) edges.push({ start: { x: cell.x + 1, y: cell.y }, end: { x: cell.x + 1, y: cell.y + 1 }, used: false });
    if (!keys.has(cellKey(cell.x, cell.y + 1))) edges.push({ start: { x: cell.x + 1, y: cell.y + 1 }, end: { x: cell.x, y: cell.y + 1 }, used: false });
    if (!keys.has(cellKey(cell.x - 1, cell.y))) edges.push({ start: { x: cell.x, y: cell.y + 1 }, end: { x: cell.x, y: cell.y }, used: false });
  }

  const byStart = new Map<string, DirectedEdge[]>();
  for (const edge of edges) byStart.set(pointKey(edge.start), [...(byStart.get(pointKey(edge.start)) ?? []), edge]);
  const loops: PlanPoint[][] = [];
  for (const initial of edges) {
    if (initial.used) continue;
    const loop: PlanPoint[] = [];
    let edge = initial;
    while (!edge.used) {
      edge.used = true;
      loop.push(edge.start);
      const candidates = (byStart.get(pointKey(edge.end)) ?? []).filter((candidate) => !candidate.used);
      if (!candidates.length) break;
      candidates.sort((a, b) => edgeTurn(edge, b) - edgeTurn(edge, a));
      edge = candidates[0];
    }
    if (loop.length >= 3) loops.push(simplifyCollinear(loop));
  }
  return loops.sort((a, b) => Math.abs(signedArea(b)) - Math.abs(signedArea(a)));
}

function distance(a: PlanPoint, b: PlanPoint) {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function normalize(point: PlanPoint): PlanPoint {
  const magnitude = Math.hypot(point.x, point.y) || 1;
  return { x: point.x / magnitude, y: point.y / magnitude };
}

function samePoint(a: PlanPoint, b: PlanPoint) {
  return Math.abs(a.x - b.x) < EPSILON && Math.abs(a.y - b.y) < EPSILON;
}

function pushUnique(target: PlanPoint[], point: PlanPoint) {
  if (!target.length || !samePoint(target[target.length - 1], point)) target.push(point);
}

function averageInward(previous: PlanPoint, current: PlanPoint, next: PlanPoint) {
  const incoming = normalize({ x: current.x - previous.x, y: current.y - previous.y });
  const outgoing = normalize({ x: next.x - current.x, y: next.y - current.y });
  return normalize({ x: -incoming.y - outgoing.y, y: incoming.x + outgoing.x });
}

function curvePoints(entry: PlanPoint, corner: PlanPoint, exit: PlanPoint, edit: CornerEdit, quality: number) {
  const control = edit.inverted
    ? { x: entry.x + exit.x - corner.x, y: entry.y + exit.y - corner.y }
    : corner;
  const points: PlanPoint[] = [];
  const samples = Math.max(64, Math.trunc(quality));
  for (let index = 0; index <= samples; index += 1) {
    const t = index / samples;
    const inverse = 1 - t;
    points.push({
      x: inverse * inverse * entry.x + 2 * inverse * t * control.x + t * t * exit.x,
      y: inverse * inverse * entry.y + 2 * inverse * t * control.y + t * t * exit.y,
    });
  }
  return points;
}

interface CornerReplacement {
  entry: PlanPoint;
  exit: PlanPoint;
  points: PlanPoint[];
  kind: "diagonal" | "curve";
}

function nearestIndex(points: PlanPoint[], target: PlanPoint) {
  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  points.forEach((point, index) => {
    const candidate = distance(point, target);
    if (candidate < bestDistance) {
      bestDistance = candidate;
      bestIndex = index;
    }
  });
  return bestIndex;
}

function buildOuterLoop(room: Room, gridLoop: PlanPoint[], curveQuality: number) {
  const edits = new Map(room.cornerEdits.map((edit) => [`${edit.vertexX},${edit.vertexY}`, edit]));
  const replacements: Array<CornerReplacement | null> = [];
  const handles: CornerHandle[] = [];
  const pillarTargets: PlanPoint[] = [];
  const requestedInsets = gridLoop.map((current, index) => {
    const previous = gridLoop[(index - 1 + gridLoop.length) % gridLoop.length];
    const next = gridLoop[(index + 1) % gridLoop.length];
    const cross = (current.x - previous.x) * (next.y - current.y) - (current.y - previous.y) * (next.x - current.x);
    const edit = edits.get(`${current.x},${current.y}`);
    if (cross <= EPSILON || !edit || edit.insetCells <= 0) return 0;
    return Math.min(
      edit.insetCells * CELL_SIZE,
      distance(previous, current) * CELL_SIZE,
      distance(current, next) * CELL_SIZE,
    );
  });
  const insetScales = requestedInsets.map(() => 1);
  for (let index = 0; index < gridLoop.length; index += 1) {
    const nextIndex = (index + 1) % gridLoop.length;
    const requested = requestedInsets[index] + requestedInsets[nextIndex];
    const available = distance(gridLoop[index], gridLoop[nextIndex]) * CELL_SIZE;
    if (requested <= available + EPSILON) continue;
    const scale = available / requested;
    insetScales[index] = Math.min(insetScales[index], scale);
    insetScales[nextIndex] = Math.min(insetScales[nextIndex], scale);
  }
  const effectiveInsets = requestedInsets.map((inset, index) => inset * insetScales[index]);

  for (let index = 0; index < gridLoop.length; index += 1) {
    const previous = gridLoop[(index - 1 + gridLoop.length) % gridLoop.length];
    const current = gridLoop[index];
    const next = gridLoop[(index + 1) % gridLoop.length];
    const cross = (current.x - previous.x) * (next.y - current.y) - (current.y - previous.y) * (next.x - current.x);
    if (cross <= EPSILON) {
      replacements.push(null);
      continue;
    }

    const inward = averageInward(previous, current, next);
    const incomingLengthCells = distance(previous, current);
    const outgoingLengthCells = distance(current, next);
    const edit = edits.get(`${current.x},${current.y}`);
    handles.push({
      roomId: room.id,
      vertexX: current.x,
      vertexY: current.y,
      inwardX: inward.x,
      inwardY: inward.y,
      maxInsetCells: Math.max(1, Math.floor(Math.min(incomingLengthCells, outgoingLengthCells))),
      edit,
    });

    const cornerWorld = { x: current.x * CELL_SIZE, y: current.y * CELL_SIZE };
    if (!edit || edit.insetCells <= 0) {
      replacements.push(null);
      pillarTargets.push(cornerWorld);
      continue;
    }

    const previousWorld = { x: previous.x * CELL_SIZE, y: previous.y * CELL_SIZE };
    const nextWorld = { x: next.x * CELL_SIZE, y: next.y * CELL_SIZE };
    const incoming = normalize({ x: cornerWorld.x - previousWorld.x, y: cornerWorld.y - previousWorld.y });
    const outgoing = normalize({ x: nextWorld.x - cornerWorld.x, y: nextWorld.y - cornerWorld.y });
    const inset = effectiveInsets[index];
    const entry = { x: cornerWorld.x - incoming.x * inset, y: cornerWorld.y - incoming.y * inset };
    const exit = { x: cornerWorld.x + outgoing.x * inset, y: cornerWorld.y + outgoing.y * inset };
    const points = edit.shape === "curve" ? curvePoints(entry, cornerWorld, exit, edit, curveQuality) : [entry, exit];
    replacements.push({ entry, exit, points, kind: edit.shape });
    pillarTargets.push(entry, exit);
  }

  const worldLoop = gridLoop.map((point) => ({ x: point.x * CELL_SIZE, y: point.y * CELL_SIZE }));
  const paths: FootprintPath[] = [];
  for (let index = 0; index < worldLoop.length; index += 1) {
    const previousIndex = (index - 1 + worldLoop.length) % worldLoop.length;
    const start = replacements[previousIndex]?.exit ?? worldLoop[previousIndex];
    const end = replacements[index]?.entry ?? worldLoop[index];
    if (distance(start, end) > EPSILON) paths.push({ points: [start, end], kind: "straight" });
    const replacement = replacements[index];
    if (replacement) paths.push({ points: replacement.points, kind: replacement.kind });
  }

  const points: PlanPoint[] = [];
  for (const path of paths) for (const point of path.points) pushUnique(points, point);
  if (points.length > 1 && samePoint(points[0], points[points.length - 1])) points.pop();
  const pillarAnchors = pillarTargets.map((point) => {
    const index = nearestIndex(points, point);
    return {
      point,
      inward: averageInward(points[(index - 1 + points.length) % points.length], points[index], points[(index + 1) % points.length]),
    };
  });
  return { points, paths, handles, pillarAnchors };
}

/**
 * Segment count for a circle. Derived from circumference so the chord — and so the
 * visible faceting — stays constant at any radius, floored by the user-facing quality
 * setting and capped so huge circles stay affordable.
 */
export function circleSegments(radius: number, quality = 64) {
  const circumference = 2 * Math.PI * Math.max(EPSILON, radius);
  return Math.min(360, Math.max(Math.trunc(quality), Math.ceil(circumference / MAX_CIRCLE_CHORD)));
}

/** Counter-clockwise, matching the winding `traceCellBoundaryLoops` produces for outer loops. */
export function circlePolygon(circle: CircleShape, segments: number): PlanPoint[] {
  const points: PlanPoint[] = [];
  const count = Math.max(3, Math.trunc(segments));
  for (let index = 0; index < count; index += 1) {
    const angle = (index / count) * Math.PI * 2;
    points.push({
      x: circle.cx + Math.cos(angle) * circle.radius,
      y: circle.cy + Math.sin(angle) * circle.radius,
    });
  }
  return points;
}

/**
 * The circle tool drags a bounding box but locks it square, so the room is the box's
 * inscribed circle. A square of N cells is 2N m across, which puts the inscribed radius
 * at exactly N metres — the whole-metre snap falls out of the gesture with no extra
 * quantisation. `start` stays anchored, so dragging up or left grows away from it.
 */
export function circleFromDrag(start: Cell, current: Cell): CircleShape {
  const side = Math.max(Math.abs(current.x - start.x), Math.abs(current.y - start.y)) + 1;
  const minX = current.x >= start.x ? start.x : start.x - side + 1;
  const minY = current.y >= start.y ? start.y : start.y - side + 1;
  return { cx: (minX + side / 2) * CELL_SIZE, cy: (minY + side / 2) * CELL_SIZE, radius: side };
}

/** Distance from a circle's centre to the nearest point of a cell rectangle's world extent. */
function centreToCellBounds(circle: CircleShape, bounds: CellBounds) {
  const nearestX = Math.min((bounds.maxX + 1) * CELL_SIZE, Math.max(bounds.minX * CELL_SIZE, circle.cx));
  const nearestY = Math.min((bounds.maxY + 1) * CELL_SIZE, Math.max(bounds.minY * CELL_SIZE, circle.cy));
  return Math.hypot(circle.cx - nearestX, circle.cy - nearestY);
}

/** Cell-rectangle bounds are inclusive; the tested box is their world extent. Touching counts. */
export function circleIntersectsCellBounds(circle: CircleShape, bounds: CellBounds) {
  return centreToCellBounds(circle, bounds) <= circle.radius;
}

/**
 * Strict overlap, for deciding whether two parts belong to one room. Tangency deliberately
 * does *not* count: a circle sitting flush against a hall is two rooms sharing a wall, which
 * the existing `opposingRoomId` logic already renders correctly, and feeding a tangent pair
 * to the clipper would only produce a pinched ring.
 */
export function circleOverlapsCell(circle: CircleShape, cell: Cell) {
  return centreToCellBounds(circle, { minX: cell.x, maxX: cell.x, minY: cell.y, maxY: cell.y })
    < circle.radius - EPSILON;
}

export function circleOverlapsCells(circle: CircleShape, cells: Cell[]) {
  return cells.some((cell) => circleOverlapsCell(circle, cell));
}

/** Strict circle-to-circle overlap; tangency counts as separate, as in `circleOverlapsCells`. */
export function circlesOverlap(a: CircleShape, b: CircleShape) {
  return Math.hypot(a.cx - b.cx, a.cy - b.cy) < a.radius + b.radius - EPSILON;
}

/**
 * A corner whose vertex ends up strictly inside a circle has been swallowed by the union,
 * so it must stop offering a handle and a pillar. The `CornerEdit` itself stays in room
 * state, which means shrinking or deleting the circle brings the corner straight back.
 */
function insideAnyCircle(point: PlanPoint, circles: CircleShape[]) {
  return circles.some((circle) => Math.hypot(point.x - circle.cx, point.y - circle.cy) < circle.radius - EPSILON);
}

function pushUniqueTagged(target: TaggedPoint[], point: TaggedPoint) {
  if (!target.length || !samePoint(target[target.length - 1], point)) target.push(point);
}

export function buildEditedRoomGeometry(room: Room, curveQuality = 64): EditedRoomGeometry {
  const loops = traceCellBoundaryLoops(room.cells);
  const outerLoops = loops.filter((loop) => signedArea(loop) > 0);
  const holeLoops = loops.filter((loop) => signedArea(loop) < 0);
  const result: EditedRoomGeometry = { roomId: room.id, grounds: [], paths: [], handles: [], radiusHandles: [], pillarAnchors: [] };

  // Keep the original index: `resizeCircle` addresses circles by their position in room.circles.
  const circleParts = (room.circles ?? [])
    .map((circle, circleIndex) => ({ circle, circleIndex }))
    .filter((part) => part.circle.radius > 0);
  const circleShapes = circleParts.map((part) => part.circle);

  for (const part of circleParts) {
    for (const angle of [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]) {
      result.radiusHandles.push({
        roomId: room.id,
        circleIndex: part.circleIndex,
        cx: part.circle.cx,
        cy: part.circle.cy,
        radius: part.circle.radius,
        angle,
      });
    }
  }

  // ── Cell-only rooms: the original pipeline, untouched. Zero regression risk. ─────────
  if (!circleParts.length) {
    for (const outer of outerLoops) {
      const built = buildOuterLoop(room, outer, curveQuality);
      result.paths.push(...built.paths);
      result.handles.push(...built.handles);
      result.pillarAnchors.push(...built.pillarAnchors);
      result.grounds.push({
        roomId: room.id,
        outer: built.points,
        holes: holeLoops
          .filter((hole) => pointInPolygon(hole[0], outer))
          .map((hole) => hole.map((point) => ({ x: point.x * CELL_SIZE, y: point.y * CELL_SIZE }))),
      });
    }
    for (const hole of holeLoops) {
      const world = hole.map((point) => ({ x: point.x * CELL_SIZE, y: point.y * CELL_SIZE }));
      for (let index = 0; index < world.length; index += 1) {
        result.paths.push({ points: [world[index], world[(index + 1) % world.length]], kind: "straight" });
      }
    }
    return result;
  }

  // ── A single circle with no cells: Phase A's exact output. Deliberately kept off the
  // clipper, which rotates a lone ring's start vertex rather than returning it unchanged. ──
  if (!outerLoops.length && circleParts.length === 1) {
    const { circle } = circleParts[0];
    const polygon = circlePolygon(circle, circleSegments(circle.radius, curveQuality));
    result.grounds.push({ roomId: room.id, outer: polygon, holes: [] });
    result.paths.push({ points: [...polygon, polygon[0]], kind: "curve" });
    return result;
  }

  // ── Mixed room: boolean union of every part, with per-vertex provenance so the arc runs
  // can still be told from the straight ones on the far side. ─────────────────────────────
  const polygons: TaggedPoint[][] = [];
  const tagKinds = new Map<number, FootprintPath["kind"]>();
  let nextTag = JUNCTION_TAG + 1;
  const claimTag = (kind: FootprintPath["kind"]) => {
    const tag = nextTag;
    nextTag += 1;
    tagKinds.set(tag, kind);
    return tag;
  };

  for (const outer of outerLoops) {
    // Corner edits are baked in *before* the union, so the diagonal and curve code needs no
    // changes — the union simply sees an already-edited outline.
    const built = buildOuterLoop(room, outer, curveQuality);
    result.handles.push(...built.handles);
    result.pillarAnchors.push(...built.pillarAnchors);
    const tagged: TaggedPoint[] = [];
    for (const path of built.paths) {
      const tag = claimTag(path.kind);
      // Tags describe the edge that LEAVES a vertex. Do not append the final point of a
      // run: it is also the first point of the following run and must receive that run's
      // tag. Keeping the previous run's tag on the shared point made `splitRuns` carry a
      // straight wall around the next corner after a circle/square union. The layout then
      // measured the bent polyline but placed modules along only its first edge, creating
      // the visible gaps and overlapping wall pieces at merge junctions.
      for (const point of path.points.slice(0, -1)) {
        pushUniqueTagged(tagged, { x: point.x, y: point.y, tag });
      }
    }
    if (tagged.length > 1 && samePoint(tagged[0], tagged[tagged.length - 1])) tagged.pop();
    if (tagged.length >= 3) polygons.push(tagged);
  }

  // Holes go in clockwise; with NonZero that carves them back out of the union. One tag per
  // edge, so a hole boundary still breaks into per-edge runs the way it does today.
  for (const hole of holeLoops) {
    polygons.push(hole.map((point) => ({
      x: point.x * CELL_SIZE,
      y: point.y * CELL_SIZE,
      tag: claimTag("straight"),
    })));
  }

  for (const part of circleParts) {
    const tag = claimTag("curve");
    const polygon = circlePolygon(part.circle, circleSegments(part.circle.radius, curveQuality));
    polygons.push(polygon.map((point) => ({ x: point.x, y: point.y, tag })));
  }

  const rings = unionTagged(polygons);
  const outerRings = rings.filter((ring) => ring.outer);
  const holeRings = rings.filter((ring) => !ring.outer);
  const bare = (points: TaggedPoint[]) => points.map((point) => ({ x: point.x, y: point.y }));

  for (const ring of outerRings) {
    result.grounds.push({
      roomId: room.id,
      outer: bare(ring.points),
      holes: holeRings
        .filter((hole) => pointInPolygon(hole.points[0], ring.points))
        .map((hole) => bare(hole.points)),
    });
  }

  for (const ring of rings) {
    const runs = splitRuns(ring);
    for (const run of runs) {
      result.paths.push({ points: bare(run.points), kind: tagKinds.get(run.tag) ?? "straight" });
    }

    // A curved room part meeting a rectilinear part needs a structural/visual terminator.
    // Add one pillar at each change between a curve run and a non-curve run. Using the
    // final union ring (rather than the original circle) places it at the exact clipped
    // junction and also works when the circle cuts through a corner instead of a wall.
    for (let index = 0; index < runs.length; index += 1) {
      const current = runs[index];
      const nextRun = runs[(index + 1) % runs.length];
      const currentKind = tagKinds.get(current.tag) ?? "straight";
      const nextKind = tagKinds.get(nextRun.tag) ?? "straight";
      if ((currentKind === "curve") === (nextKind === "curve")) continue;
      const junction = current.points[current.points.length - 1];
      const ringIndex = ring.points.findIndex((point) => samePoint(point, junction));
      if (ringIndex < 0) continue;
      const anchor: PillarAnchor = {
        point: { x: junction.x, y: junction.y },
        inward: averageInward(
          ring.points[(ringIndex - 1 + ring.points.length) % ring.points.length],
          ring.points[ringIndex],
          ring.points[(ringIndex + 1) % ring.points.length],
        ),
        junction: true,
      };
      const existing = result.pillarAnchors.find((candidate) => samePoint(candidate.point, anchor.point));
      if (existing) {
        existing.junction = true;
        existing.inward = anchor.inward;
      } else {
        result.pillarAnchors.push(anchor);
      }
    }
  }

  result.handles = result.handles.filter(
    (handle) => !insideAnyCircle({ x: handle.vertexX * CELL_SIZE, y: handle.vertexY * CELL_SIZE }, circleShapes),
  );
  result.pillarAnchors = result.pillarAnchors.filter(
    (anchor) => anchor.junction || !insideAnyCircle(anchor.point, circleShapes),
  );

  return result;
}

export function polygonArea(points: PlanPoint[]) {
  return Math.abs(signedArea(points));
}

export function pathLength(points: PlanPoint[]) {
  let total = 0;
  for (let index = 1; index < points.length; index += 1) total += distance(points[index - 1], points[index]);
  return total;
}
