import type {
  BuildSettings,
  Cell,
  CircleShape,
  CornerHandle,
  GeneratedLayout,
  FloorGround,
  FloorRegion,
  LayoutBounds,
  ManualWall,
  PlanPoint,
  Pillar,
  RadiusHandle,
  Room,
  RoomGround,
  Side,
  Variant,
  WallPath,
  WallDeletion,
  WallResizeHandle,
  WallSegment,
} from "./types";
import { buildEditedRoomGeometry, circleOverlapsCell, circlesOverlap, pathLength, polygonArea, unionFinishedRoomGeometry } from "./footprint";

export const CELL_SIZE = 2;
export const BALCONY_RAILING_MODULE_SIZE = 1;
export const WALL_HEIGHT = 3;
export const ROOM_ELEVATION_STEP = 0.25;
/** Upper bound on the rectilinear cell count, so a runaway drag can't materialise 250k objects. */
export const MAX_CELLS = 10_000;
export const CORNER_ARM = 1;
export const WALL_THICKNESS = 0.16;

const TAU = Math.PI * 2;

const positiveAngle = (angle: number) => ((angle % TAU) + TAU) % TAU;

export interface CircularArc {
  points: PlanPoint[];
  center: PlanPoint;
  radius: number;
  length: number;
  sweep: number;
}

/** Build the unique circular arc from start to end that passes through arcPoint. */
export function circularArcThroughPoints(start: PlanPoint, arcPoint: PlanPoint, end: PlanPoint): CircularArc | null {
  const determinant = 2 * (
    start.x * (arcPoint.y - end.y)
    + arcPoint.x * (end.y - start.y)
    + end.x * (start.y - arcPoint.y)
  );
  if (Math.abs(determinant) < 1e-6) return null;

  const startSquared = start.x * start.x + start.y * start.y;
  const arcSquared = arcPoint.x * arcPoint.x + arcPoint.y * arcPoint.y;
  const endSquared = end.x * end.x + end.y * end.y;
  const center = {
    x: (startSquared * (arcPoint.y - end.y) + arcSquared * (end.y - start.y) + endSquared * (start.y - arcPoint.y)) / determinant,
    y: (startSquared * (end.x - arcPoint.x) + arcSquared * (start.x - end.x) + endSquared * (arcPoint.x - start.x)) / determinant,
  };
  const radius = Math.hypot(start.x - center.x, start.y - center.y);
  if (!Number.isFinite(radius) || radius < 1e-4) return null;

  const startAngle = Math.atan2(start.y - center.y, start.x - center.x);
  const middleAngle = Math.atan2(arcPoint.y - center.y, arcPoint.x - center.x);
  const endAngle = Math.atan2(end.y - center.y, end.x - center.x);
  const ccwToMiddle = positiveAngle(middleAngle - startAngle);
  const ccwToEnd = positiveAngle(endAngle - startAngle);
  const direction = ccwToMiddle <= ccwToEnd + 1e-7 ? 1 : -1;
  const directedDelta = (from: number, to: number) => direction > 0
    ? positiveAngle(to - from)
    : -positiveAngle(from - to);
  const firstSweep = directedDelta(startAngle, middleAngle);
  const secondSweep = directedDelta(middleAngle, endAngle);
  const sweep = firstSweep + secondSweep;
  const length = Math.abs(sweep) * radius;
  const sampleSpan = (from: number, span: number) => {
    const count = Math.min(256, Math.max(2, Math.ceil(Math.abs(span) * radius * 6)));
    return Array.from({ length: count + 1 }, (_, index) => {
      const angle = from + span * index / count;
      return { x: center.x + Math.cos(angle) * radius, y: center.y + Math.sin(angle) * radius };
    });
  };
  const first = sampleSpan(startAngle, firstSweep);
  const second = sampleSpan(middleAngle, secondSweep);
  // Reconstructed circle samples are subject to floating-point drift. Preserve the
  // three authored clicks exactly so the first anchor can never creep as bulge changes.
  first[0] = { ...start };
  first[first.length - 1] = { ...arcPoint };
  second[0] = { ...arcPoint };
  second[second.length - 1] = { ...end };
  return { points: [...first, ...second.slice(1)], center, radius, length, sweep };
}

const VARIANTS: Variant[] = ["A", "B", "C"];
const SIDE_ORDER: Record<Side, number> = { S: 0, E: 1, N: 2, W: 3 };

interface BoundaryRun {
  side: Side;
  line: number;
  start: number;
  cellLength: number;
}

export const cellKey = (x: number, y: number) => `${x},${y}`;

export function normalizeCells(cells: Cell[]): Cell[] {
  const unique = new Map<string, Cell>();
  for (const cell of cells) {
    if (!Number.isFinite(cell.x) || !Number.isFinite(cell.y)) continue;
    const x = Math.trunc(cell.x);
    const y = Math.trunc(cell.y);
    unique.set(cellKey(x, y), { x, y });
  }
  return [...unique.values()].sort((a, b) => a.y - b.y || a.x - b.x);
}

/** Move one axis-aligned exterior wall by whole 2 m modules. */
export function resizeRoomCells(inputCells: Cell[], handle: WallResizeHandle, steps: number): Cell[] {
  const amount = Math.trunc(steps);
  if (!amount) return normalizeCells(inputCells);
  const cells = new Map(normalizeCells(inputCells).map((cell) => [cellKey(cell.x, cell.y), cell]));
  const horizontal = Math.abs(handle.end.x - handle.start.x) >= Math.abs(handle.end.y - handle.start.y);

  if (horizontal) {
    const outward = Math.sign(handle.outwardY);
    if (!outward) return [...cells.values()];
    const line = Math.round(handle.start.y / CELL_SIZE);
    const inside = outward > 0 ? line - 1 : line;
    const start = Math.round(Math.min(handle.start.x, handle.end.x) / CELL_SIZE);
    const end = Math.round(Math.max(handle.start.x, handle.end.x) / CELL_SIZE);
    for (let layer = amount > 0 ? 1 : 0; layer < (amount > 0 ? amount + 1 : -amount); layer += 1) {
      const y = amount > 0 ? inside + outward * layer : inside - outward * layer;
      for (let x = start; x < end; x += 1) {
        const key = cellKey(x, y);
        if (amount > 0) cells.set(key, { x, y });
        else cells.delete(key);
      }
    }
  } else {
    const outward = Math.sign(handle.outwardX);
    if (!outward) return [...cells.values()];
    const line = Math.round(handle.start.x / CELL_SIZE);
    const inside = outward > 0 ? line - 1 : line;
    const start = Math.round(Math.min(handle.start.y, handle.end.y) / CELL_SIZE);
    const end = Math.round(Math.max(handle.start.y, handle.end.y) / CELL_SIZE);
    for (let layer = amount > 0 ? 1 : 0; layer < (amount > 0 ? amount + 1 : -amount); layer += 1) {
      const x = amount > 0 ? inside + outward * layer : inside - outward * layer;
      for (let y = start; y < end; y += 1) {
        const key = cellKey(x, y);
        if (amount > 0) cells.set(key, { x, y });
        else cells.delete(key);
      }
    }
  }
  return normalizeCells([...cells.values()]);
}

function mulberry32(seed: number) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function cellsAtVertex(keys: Set<string>, vertexX: number, vertexY: number): Cell[] {
  return [
    { x: vertexX - 1, y: vertexY - 1 },
    { x: vertexX - 1, y: vertexY },
    { x: vertexX, y: vertexY - 1 },
    { x: vertexX, y: vertexY },
  ].filter((cell) => keys.has(cellKey(cell.x, cell.y)));
}

function boundaryRuns(cells: Cell[], keys: Set<string>): BoundaryRun[] {
  const groups = new Map<string, { side: Side; line: number; coordinates: number[] }>();
  const sides: Array<[Side, number, number, (cell: Cell) => number, (cell: Cell) => number]> = [
    ["S", 0, -1, (cell) => cell.y, (cell) => cell.x],
    ["E", 1, 0, (cell) => cell.x + 1, (cell) => cell.y],
    ["N", 0, 1, (cell) => cell.y + 1, (cell) => cell.x],
    ["W", -1, 0, (cell) => cell.x, (cell) => cell.y],
  ];

  for (const cell of cells) {
    for (const [side, dx, dy, getLine, getCoordinate] of sides) {
      if (keys.has(cellKey(cell.x + dx, cell.y + dy))) continue;
      const line = getLine(cell);
      const groupKey = `${side}:${line}`;
      const group = groups.get(groupKey) ?? { side, line, coordinates: [] };
      group.coordinates.push(getCoordinate(cell));
      groups.set(groupKey, group);
    }
  }

  const runs: BoundaryRun[] = [];
  for (const group of groups.values()) {
    group.coordinates.sort((a, b) => a - b);
    let start = group.coordinates[0];
    let previous = start;
    for (const coordinate of group.coordinates.slice(1)) {
      if (coordinate !== previous + 1) {
        runs.push({ side: group.side, line: group.line, start, cellLength: previous - start + 1 });
        start = coordinate;
      }
      previous = coordinate;
    }
    runs.push({ side: group.side, line: group.line, start, cellLength: previous - start + 1 });
  }

  return runs.sort(
    (a, b) => SIDE_ORDER[a.side] - SIDE_ORDER[b.side] || a.line - b.line || a.start - b.start,
  );
}

function packWallRun(length: number): number[] {
  const result: number[] = [];
  let remaining = Math.round(length);
  // Every exposed grid edge is 2 m, so the fixed W3x2 module tiles every
  // straight run exactly without scale distortion.
  while (remaining >= 2) {
    result.push(2);
    remaining -= 2;
  }
  if (remaining) throw new Error("Wall runs must align to the fixed 2 m wall module.");
  return result;
}

function addPerimeterRun(
  walls: WallSegment[],
  run: BoundaryRun,
  settings: BuildSettings,
  random: () => number,
) {
  const { side, line, start, cellLength } = run;
  // This renderer is straight-wall-only: perimeter runs meet directly at
  // vertices instead of reserving arms for separate corner modules.
  const reserveLow = 0;
  const reserveHigh = 0;
  const length = cellLength * CELL_SIZE - reserveLow - reserveHigh;
  if (length <= 0) return;

  let x: number;
  let y: number;
  let rotation: number;
  if (side === "S") {
    [x, y, rotation] = [start * CELL_SIZE + reserveLow, line * CELL_SIZE, 0];
  } else if (side === "N") {
    [x, y, rotation] = [(start + cellLength) * CELL_SIZE - reserveHigh, line * CELL_SIZE, Math.PI];
  } else if (side === "E") {
    [x, y, rotation] = [line * CELL_SIZE, start * CELL_SIZE + reserveLow, Math.PI / 2];
  } else {
    [x, y, rotation] = [line * CELL_SIZE, (start + cellLength) * CELL_SIZE - reserveHigh, (3 * Math.PI) / 2];
  }

  for (const segmentLength of packWallRun(length)) {
    const variant = settings.randomizeWalls
      ? VARIANTS[Math.floor(random() * VARIANTS.length)]
      : settings.wallVariant;
    walls.push({ x, y, length: segmentLength, rotation, side, variant });
    x += Math.cos(rotation) * segmentLength;
    y += Math.sin(rotation) * segmentLength;
  }
}

function buildCornersAndPillars(
  cells: Cell[],
  keys: Set<string>,
  settings: BuildSettings,
): { corners: never[]; pillars: Pillar[] } {
  const vertices = new Set<string>();
  for (const { x, y } of cells) {
    vertices.add(cellKey(x, y));
    vertices.add(cellKey(x + 1, y));
    vertices.add(cellKey(x, y + 1));
    vertices.add(cellKey(x + 1, y + 1));
  }

  const pillars: Pillar[] = [];
  const sortedVertices = [...vertices]
    .map((key) => key.split(",").map(Number) as [number, number])
    .sort((a, b) => a[1] - b[1] || a[0] - b[0]);

  for (const [vertexX, vertexY] of sortedVertices) {
    const adjacent = cellsAtVertex(keys, vertexX, vertexY);
    if (adjacent.length !== 1 && adjacent.length !== 3) continue;
    const worldX = vertexX * CELL_SIZE;
    const worldY = vertexY * CELL_SIZE;

    if (adjacent.length === 1) {
      const cell = adjacent[0];
      if (settings.addPillars) {
        const insetX = cell.x === vertexX ? settings.pillarInset : -settings.pillarInset;
        const insetY = cell.y === vertexY ? settings.pillarInset : -settings.pillarInset;
        pillars.push({
          x: worldX + insetX,
          y: worldY + insetY,
          junction: false,
          variant: settings.pillarVariant,
        });
      }
    } else if (settings.addPillars) {
      pillars.push({ x: worldX, y: worldY, junction: true, variant: settings.pillarVariant });
    }
  }
  return { corners: [], pillars };
}

function getBounds(cells: Cell[]): LayoutBounds {
  if (!cells.length) return { minX: -2, minY: -2, maxX: 2, maxY: 2 };
  return {
    minX: Math.min(...cells.map((cell) => cell.x)) * CELL_SIZE,
    minY: Math.min(...cells.map((cell) => cell.y)) * CELL_SIZE,
    maxX: (Math.max(...cells.map((cell) => cell.x)) + 1) * CELL_SIZE,
    maxY: (Math.max(...cells.map((cell) => cell.y)) + 1) * CELL_SIZE,
  };
}

/**
 * Connected floor regions. Cells join across shared edges, and a circle joins any cell or
 * other circle it overlaps — which is what lets a rotunda bridge two otherwise separate halls
 * into a single zone. Plain cell adjacency cannot see that bridge, so it would report two
 * zones for a room the boolean union renders as one continuous footprint.
 *
 * Tangency does not join, matching the strict test the boolean union itself uses.
 */
function countFloorZones(cells: Cell[], keys: Set<string>, circles: CircleShape[]): number {
  const parent = new Map<string, string>();
  const add = (id: string) => { if (!parent.has(id)) parent.set(id, id); };
  const find = (id: string) => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    // Path compression, so this stays near-linear at the MAX_CELLS ceiling.
    let walk = id;
    while (walk !== root) {
      const next = parent.get(walk)!;
      parent.set(walk, root);
      walk = next;
    }
    return root;
  };
  const union = (a: string, b: string) => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent.set(rootA, rootB);
  };

  for (const cell of cells) add(cellKey(cell.x, cell.y));
  // A zero-radius circle contributes no floor, so it is not a zone of its own.
  const shapes = circles.filter((circle) => circle.radius > 0);
  shapes.forEach((_, index) => add(`circle:${index}`));

  for (const cell of cells) {
    // Only two directions: the reverse pair is covered when the neighbour is visited.
    for (const [dx, dy] of [[1, 0], [0, 1]] as const) {
      const neighbour = cellKey(cell.x + dx, cell.y + dy);
      if (keys.has(neighbour)) union(cellKey(cell.x, cell.y), neighbour);
    }
  }
  shapes.forEach((circle, index) => {
    for (const cell of cells) {
      if (circleOverlapsCell(circle, cell)) union(`circle:${index}`, cellKey(cell.x, cell.y));
    }
    for (let other = index + 1; other < shapes.length; other += 1) {
      if (circlesOverlap(circle, shapes[other])) union(`circle:${index}`, `circle:${other}`);
    }
  });

  const roots = new Set<string>();
  for (const id of parent.keys()) roots.add(find(id));
  return roots.size;
}

function roundedPoint(point: PlanPoint) {
  return `${point.x.toFixed(4)},${point.y.toFixed(4)}`;
}

function getGroundBounds(grounds: RoomGround[], fallback: LayoutBounds): LayoutBounds {
  const points = grounds.flatMap((ground) => ground.outer);
  if (!points.length) return fallback;
  return {
    minX: Math.min(...points.map((point) => point.x)),
    minY: Math.min(...points.map((point) => point.y)),
    maxX: Math.max(...points.map((point) => point.x)),
    maxY: Math.max(...points.map((point) => point.y)),
  };
}

/** Remove one targeted fixed 2 m module while preserving every other part of the run. */
export function eraseManualWallModule(manualWalls: ManualWall[], wallId: string, moduleIndex: number): ManualWall[] {
  return eraseManualWallModules(manualWalls, wallId, [moduleIndex]);
}

/** Remove several modules from one authored run in a single stable split operation. */
export function eraseManualWallModules(manualWalls: ManualWall[], wallId: string, moduleIndices: Iterable<number>): ManualWall[] {
  const removed = new Set(moduleIndices);
  const kept: ManualWall[] = [];
  for (const wall of manualWalls) {
    if (wall.id !== wallId) {
      kept.push(wall);
      continue;
    }
    if ((wall.kind ?? "straight") !== "straight") continue;
    const dx = wall.end.x - wall.start.x;
    const dy = wall.end.y - wall.start.y;
    const horizontal = Math.abs(dx) >= Math.abs(dy);
    const length = horizontal ? Math.abs(dx) : Math.abs(dy);
    const moduleSize = wall.assembly === "balcony-railing" ? BALCONY_RAILING_MODULE_SIZE : CELL_SIZE;
    const count = Math.round(length / moduleSize);
    const direction = horizontal ? Math.sign(dx) : Math.sign(dy);
    for (let index = 0; index < count; index += 1) {
      const start = {
        x: wall.start.x + (horizontal ? direction * index * moduleSize : 0),
        y: wall.start.y + (horizontal ? 0 : direction * index * moduleSize),
      };
      const end = {
        x: start.x + (horizontal ? direction * moduleSize : 0),
        y: start.y + (horizontal ? 0 : direction * moduleSize),
      };
      if (removed.has(index)) continue;
      const id = `${wall.id}:${index}`;
      const center = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
      const openings = wall.openings?.filter((opening) => Math.hypot(opening.cx - center.x, opening.cy - center.y) < moduleSize * 0.51)
        .map((opening) => ({ ...opening, roomId: `manual-${id}`, manualWallId: id }));
      kept.push({ ...wall, id, start, end, ...(openings ? { openings } : {}) });
    }
  }
  return kept;
}

function pointOnSegment(point: PlanPoint, start: PlanPoint, end: PlanPoint) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared < 1e-8) return false;
  const ratio = ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared;
  if (ratio < -1e-5 || ratio > 1 + 1e-5) return false;
  return Math.hypot(point.x - (start.x + dx * ratio), point.y - (start.y + dy * ratio)) < 1e-4;
}

/** Build the authored 1 m balcony modules and only the structurally meaningful posts. */
export function buildBalconyAssembly(manualRailings: ManualWall[]) {
  const balconyRailings: WallSegment[] = [];
  const candidates = new Map<string, PlanPoint>();
  for (const railing of manualRailings) {
    candidates.set(roundedPoint(railing.start), railing.start);
    candidates.set(roundedPoint(railing.end), railing.end);
    const dx = railing.end.x - railing.start.x;
    const dy = railing.end.y - railing.start.y;
    const length = Math.hypot(dx, dy);
    if (length < 1e-5) continue;
    const count = Math.max(1, Math.round(length / BALCONY_RAILING_MODULE_SIZE));
    const moduleLength = length / count;
    const rotation = Math.atan2(dy, dx);
    const elevation = (railing.elevationSteps ?? 0) * ROOM_ELEVATION_STEP;
    for (let index = 0; index < count; index += 1) {
      balconyRailings.push({
        x: railing.start.x + Math.cos(rotation) * moduleLength * index,
        y: railing.start.y + Math.sin(rotation) * moduleLength * index,
        length: moduleLength,
        rotation,
        side: sideFromDirection(dx, dy),
        variant: "A",
        manualWallId: railing.id,
        manualWallModuleIndex: index,
        ...(elevation ? { elevation } : {}),
      });
    }
  }

  const balconyPillars: Pillar[] = [];
  for (const point of candidates.values()) {
    const elevations = new Set(manualRailings.filter((railing) => pointOnSegment(point, railing.start, railing.end))
      .map((railing) => (railing.elevationSteps ?? 0) * ROOM_ELEVATION_STEP));
    for (const elevation of elevations) {
      const directions: PlanPoint[] = [];
      for (const railing of manualRailings) {
        if ((railing.elevationSteps ?? 0) * ROOM_ELEVATION_STEP !== elevation || !pointOnSegment(point, railing.start, railing.end)) continue;
        for (const endpoint of [railing.start, railing.end]) {
          const dx = endpoint.x - point.x;
          const dy = endpoint.y - point.y;
          const magnitude = Math.hypot(dx, dy);
          if (magnitude < 1e-5) continue;
          const direction = { x: dx / magnitude, y: dy / magnitude };
          if (!directions.some((other) => Math.abs(other.x - direction.x) < 1e-4 && Math.abs(other.y - direction.y) < 1e-4)) directions.push(direction);
        }
      }
      const nonCollinear = directions.some((first, index) => directions.slice(index + 1)
        .some((second) => Math.abs(first.x * second.y - first.y * second.x) > 1e-4));
      if (directions.length === 1 || nonCollinear) balconyPillars.push({ x: point.x, y: point.y, junction: true, variant: "A", ...(elevation ? { elevation } : {}) });
    }
  }
  return { balconyRailings, balconyPillars };
}

function canonicalEdgeKey(a: PlanPoint, b: PlanPoint) {
  const forward = `${roundedPoint(a)}>${roundedPoint(b)}`;
  const reverse = `${roundedPoint(b)}>${roundedPoint(a)}`;
  return forward < reverse ? forward : reverse;
}

function canonicalPathKey(points: PlanPoint[]) {
  const forward = points.map(roundedPoint).join(">");
  const reverse = [...points].reverse().map(roundedPoint).join(">");
  return forward < reverse ? forward : reverse;
}

function sideFromDirection(dx: number, dy: number): Side {
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? "S" : "N";
  return dy >= 0 ? "E" : "W";
}

function addCanonicalStraightWall(
  walls: WallSegment[],
  byEdge: Map<string, WallSegment>,
  start: PlanPoint,
  end: PlanPoint,
  room: Room,
) {
  const key = canonicalEdgeKey(start, end);
  const existing = byEdge.get(key);
  if (existing) {
    if (existing.roomId !== room.id && !existing.opposingRoomId) {
      existing.opposingRoomId = room.id;
      existing.opposingVariant = room.style.innerWallVariant;
    }
    return;
  }
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const wall: WallSegment = {
    x: start.x,
    y: start.y,
    length: Math.hypot(dx, dy),
    rotation: Math.atan2(dy, dx),
    side: sideFromDirection(dx, dy),
    variant: room.style.innerWallVariant,
    roomId: room.id,
    insideVariant: room.style.innerWallVariant,
    outsideVariant: room.style.outerWallVariant,
  };
  walls.push(wall);
  byEdge.set(key, wall);
}

function addCanonicalPath(
  wallPaths: WallPath[],
  byPath: Map<string, WallPath>,
  points: PlanPoint[],
  kind: WallPath["kind"],
  room: Room,
) {
  const key = canonicalPathKey(points);
  const existing = byPath.get(key);
  if (existing) {
    if (existing.roomId !== room.id && !existing.opposingRoomId) {
      existing.opposingRoomId = room.id;
      existing.opposingVariant = room.style.innerWallVariant;
    }
    return;
  }
  const path: WallPath = {
    points,
    kind,
    roomId: room.id,
    insideVariant: room.style.innerWallVariant,
    outsideVariant: room.style.outerWallVariant,
  };
  wallPaths.push(path);
  byPath.set(key, path);
}

/**
 * Geometry-only union: overlapping room records render as one footprint, while the app
 * still retains every original room so dragging one away restores its previous identity.
 */
function geometryArea(geometry: ReturnType<typeof buildEditedRoomGeometry>) {
  return geometry.grounds.reduce((total, ground) => total + polygonArea(ground.outer)
    - ground.holes.reduce((holes, hole) => holes + polygonArea(hole), 0), 0);
}

function roomsOverlap(
  a: Room,
  b: Room,
  geometryByRoom: Map<string, ReturnType<typeof buildEditedRoomGeometry>>,
) {
  const aGeometry = geometryByRoom.get(a.id);
  const bGeometry = geometryByRoom.get(b.id);
  if (!aGeometry || !bGeometry) return false;
  // Compare the unioned finished outlines with their separate areas. This is a strict
  // area test, so adjacent/tangent rooms do not silently merge.
  const union = unionFinishedRoomGeometry("overlap-probe", [aGeometry, bGeometry]);
  return geometryArea(union) < geometryArea(aGeometry) + geometryArea(bGeometry) - 1e-4;
}

interface LayoutRoomGroup {
  room: Room;
  members: Room[];
}

function mergeOverlappingRoomsForLayout(
  rooms: Room[],
  geometryByRoom: Map<string, ReturnType<typeof buildEditedRoomGeometry>>,
): LayoutRoomGroup[] {
  const pending = [...rooms];
  const merged: LayoutRoomGroup[] = [];
  while (pending.length) {
    const group = [pending.shift()!];
    let changed = true;
    while (changed) {
      changed = false;
      for (let index = pending.length - 1; index >= 0; index -= 1) {
        if (!group.some((room) => roomsOverlap(room, pending[index], geometryByRoom))) continue;
        group.push(pending[index]);
        pending.splice(index, 1);
        changed = true;
      }
    }
    if (group.length === 1) {
      merged.push({ room: group[0], members: group });
      continue;
    }
    merged.push({ members: group, room: group[0] });
  }
  return merged;
}

function sameGridVertex(a: CornerHandle, b: CornerHandle) {
  return a.vertexX === b.vertexX && a.vertexY === b.vertexY;
}

function sourceOwnsVisualWall(source: WallResizeHandle, visual: WallResizeHandle) {
  const sourceHorizontal = Math.abs(source.end.x - source.start.x) >= Math.abs(source.end.y - source.start.y);
  const visualHorizontal = Math.abs(visual.end.x - visual.start.x) >= Math.abs(visual.end.y - visual.start.y);
  if (sourceHorizontal !== visualHorizontal) return false;
  const dot = source.outwardX * visual.outwardX + source.outwardY * visual.outwardY;
  if (dot < 0.9) return false;
  if (sourceHorizontal) {
    if (Math.abs(source.start.y - visual.start.y) > 1e-4) return false;
    const sourceMin = Math.min(source.start.x, source.end.x) - 1e-4;
    const sourceMax = Math.max(source.start.x, source.end.x) + 1e-4;
    return Math.min(visual.start.x, visual.end.x) >= sourceMin && Math.max(visual.start.x, visual.end.x) <= sourceMax;
  }
  if (Math.abs(source.start.x - visual.start.x) > 1e-4) return false;
  const sourceMin = Math.min(source.start.y, source.end.y) - 1e-4;
  const sourceMax = Math.max(source.start.y, source.end.y) + 1e-4;
  return Math.min(visual.start.y, visual.end.y) >= sourceMin && Math.max(visual.start.y, visual.end.y) <= sourceMax;
}

function addRoomGeometry(
  rooms: Room[],
  settings: BuildSettings,
  walls: WallSegment[],
  wallPaths: WallPath[],
  pillars: Pillar[],
  roomGrounds: RoomGround[],
  roomHitAreas: RoomGround[],
  roomGroups: string[][],
  cornerHandles: CornerHandle[],
  radiusHandles: RadiusHandle[],
  wallResizeHandles: WallResizeHandle[],
) {
  const byEdge = new Map<string, WallSegment>();
  const byPath = new Map<string, WallPath>();
  const pillarKeys = new Set<string>();

  const interactionByRoom = new Map<string, ReturnType<typeof buildEditedRoomGeometry>>();
  // Hit areas and radius controls always belong to original logical rooms.
  for (const room of rooms) {
    const interactionGeometry = buildEditedRoomGeometry(room, settings.curveQuality);
    interactionByRoom.set(room.id, interactionGeometry);
    roomHitAreas.push(...interactionGeometry.grounds);
    radiusHandles.push(...interactionGeometry.radiusHandles);
  }

  // Render geometry may union several overlapping logical rooms into one continuous shell.
  for (const group of mergeOverlappingRoomsForLayout(rooms, interactionByRoom)) {
    const { room } = group;
    roomGroups.push(group.members.map((member) => member.id));
    const geometry = group.members.length === 1
      ? interactionByRoom.get(room.id)!
      : unionFinishedRoomGeometry(room.id, group.members.map((member) => interactionByRoom.get(member.id)!));
    roomGrounds.push(...geometry.grounds);

    const sourceCorners = group.members.flatMap((member) => interactionByRoom.get(member.id)?.handles ?? []);
    if (geometry.handles.length) {
      for (const visualCorner of geometry.handles) {
        const owners = sourceCorners.filter((source) => sameGridVertex(source, visualCorner));
        cornerHandles.push(...(owners.length ? owners : [visualCorner]));
      }
    } else {
      // A final-footprint union has no synthetic grid-corner handles of its own. Retain
      // only original corners that still land on the visible exterior boundary.
      const boundaryVertices = new Set(geometry.grounds.flatMap((ground) => ground.outer)
        .map((point) => `${point.x.toFixed(4)},${point.y.toFixed(4)}`));
      cornerHandles.push(...sourceCorners.filter((corner) =>
        // An edited vertex can be cut away from the resulting exterior boundary,
        // but its control must remain available so the edit can be changed or reset.
        Boolean(corner.edit) || boundaryVertices.has(`${(corner.vertexX * CELL_SIZE).toFixed(4)},${(corner.vertexY * CELL_SIZE).toFixed(4)}`),
      ));
    }

    const sourceWalls = group.members.flatMap((member) => interactionByRoom.get(member.id)?.wallResizeHandles ?? []);
    for (const visualWall of geometry.wallResizeHandles) {
      const owners = sourceWalls.filter((source) => sourceOwnsVisualWall(source, visualWall));
      if (!owners.length) {
        wallResizeHandles.push(visualWall);
        continue;
      }
      wallResizeHandles.push(...owners.map((owner) => ({
        ...visualWall,
        roomId: owner.roomId,
        outwardX: owner.outwardX,
        outwardY: owner.outwardY,
      })));
    }
    for (const path of geometry.paths) {
      if (path.kind !== "straight") {
        addCanonicalPath(wallPaths, byPath, path.points, path.kind, room);
        continue;
      }
      const start = path.points[0];
      const end = path.points[path.points.length - 1];
      const total = pathLength(path.points);
      const count = Math.floor((total + 1e-5) / CELL_SIZE);
      const exactModules = count > 0 && Math.abs(count * CELL_SIZE - total) < 1e-4;
      if (!exactModules) {
        addCanonicalPath(wallPaths, byPath, path.points, "straight-exact", room);
        continue;
      }
      for (let index = 0; index < count; index += 1) {
        const fromRatio = index / count;
        const toRatio = (index + 1) / count;
        addCanonicalStraightWall(
          walls,
          byEdge,
          { x: start.x + (end.x - start.x) * fromRatio, y: start.y + (end.y - start.y) * fromRatio },
          { x: start.x + (end.x - start.x) * toRatio, y: start.y + (end.y - start.y) * toRatio },
          room,
        );
      }
    }
    if (!settings.addPillars) continue;
    for (const anchor of geometry.pillarAnchors) {
      const x = anchor.point.x + anchor.inward.x * settings.pillarInset;
      const y = anchor.point.y + anchor.inward.y * settings.pillarInset;
      const key = `${x.toFixed(4)},${y.toFixed(4)}`;
      if (pillarKeys.has(key)) continue;
      pillarKeys.add(key);
      pillars.push({ x, y, junction: anchor.junction ?? false, variant: settings.pillarVariant });
    }
  }
}

export function buildLayout(inputCells: Cell[], settings: BuildSettings, rooms: Room[] = [], manualWalls: ManualWall[] = [], wallDeletions: WallDeletion[] = [], floors: FloorRegion[] = []): GeneratedLayout {
  const cells = normalizeCells(inputCells);
  const keys = new Set(cells.map((cell) => cellKey(cell.x, cell.y)));
  const random = mulberry32(settings.randomSeed);
  const walls: WallSegment[] = [];
  const wallPaths: WallPath[] = [];
  const roomGrounds: RoomGround[] = [];
  const floorGrounds: FloorGround[] = [];
  const floorHitAreas: FloorGround[] = [];
  const floorCornerHandles: CornerHandle[] = [];
  const roomHitAreas: RoomGround[] = [];
  const roomGroups: string[][] = [];
  const cornerHandles: CornerHandle[] = [];
  const radiusHandles: RadiusHandle[] = [];
  const wallResizeHandles: WallResizeHandle[] = [];
  let corners: never[] = [];
  let pillars: Pillar[] = [];
  const wallManuals = manualWalls.filter((manual) => manual.assembly !== "balcony-railing");
  const railingManuals = manualWalls.filter((manual) => manual.assembly === "balcony-railing");
  const { balconyRailings, balconyPillars } = buildBalconyAssembly(railingManuals);
  const elevationGroups = new Map<number, Room[]>();
  for (const room of rooms) {
    const elevationSteps = Number.isFinite(room.elevationSteps) ? (room.elevationSteps ?? 0) : 0;
    const group = elevationGroups.get(elevationSteps) ?? [];
    group.push(room);
    elevationGroups.set(elevationSteps, group);
  }
  if (rooms.length) {
    // Each height is built as an independent footprint. Rooms still union and share walls
    // exactly as before when they are on the same level, while stacked rooms never merge.
    for (const [elevationSteps, levelRooms] of elevationGroups) {
      const elevation = elevationSteps * ROOM_ELEVATION_STEP;
      const starts = {
        walls: walls.length,
        wallPaths: wallPaths.length,
        pillars: pillars.length,
        roomGrounds: roomGrounds.length,
        roomHitAreas: roomHitAreas.length,
        cornerHandles: cornerHandles.length,
        radiusHandles: radiusHandles.length,
        wallResizeHandles: wallResizeHandles.length,
      };
      addRoomGeometry(levelRooms, settings, walls, wallPaths, pillars, roomGrounds, roomHitAreas, roomGroups, cornerHandles, radiusHandles, wallResizeHandles);
      walls.slice(starts.walls).forEach((item) => { item.elevation = elevation; });
      wallPaths.slice(starts.wallPaths).forEach((item) => { item.elevation = elevation; });
      pillars.slice(starts.pillars).forEach((item) => { item.elevation = elevation; });
      roomGrounds.slice(starts.roomGrounds).forEach((item) => { item.elevation = elevation; });
      roomHitAreas.slice(starts.roomHitAreas).forEach((item) => { item.elevation = elevation; });
      cornerHandles.slice(starts.cornerHandles).forEach((item) => { item.elevation = elevation; });
      radiusHandles.slice(starts.radiusHandles).forEach((item) => { item.elevation = elevation; });
      wallResizeHandles.slice(starts.wallResizeHandles).forEach((item) => { item.elevation = elevation; });
    }
  } else {
    const runs = boundaryRuns(cells, keys);
    for (const run of runs) addPerimeterRun(walls, run, settings, random);
    ({ corners, pillars } = buildCornersAndPillars(cells, keys, settings));
  }
  // Independent floors use the room footprint editor only for its proven polygon and
  // corner-edit maths. They never produce room walls, pillars, openings, or room unions.
  for (const floor of floors) {
    const elevationSteps = Number.isFinite(floor.elevationSteps) ? floor.elevationSteps : 0;
    const elevation = elevationSteps * ROOM_ELEVATION_STEP;
    const geometry = buildEditedRoomGeometry({
      id: floor.id,
      cells: floor.cells,
      circles: [],
      style: { innerWallVariant: settings.innerWallVariant, outerWallVariant: settings.outerWallVariant },
      cornerEdits: floor.cornerEdits,
      openings: [],
      elevationSteps,
    }, settings.curveQuality);
    for (const ground of geometry.grounds) {
      const stamped: FloorGround = { ...ground, floorId: floor.id, roomId: floor.id, variant: floor.variant, elevation };
      floorGrounds.push(stamped);
      floorHitAreas.push(stamped);
    }
    floorCornerHandles.push(...geometry.handles.map((handle) => ({ ...handle, elevation })));
  }
  for (const manual of wallManuals) {
    const kind = manual.kind ?? "straight";
    if (kind !== "straight") {
      const sampleCount = Math.max(12, Math.ceil(Math.hypot(manual.end.x - manual.start.x, manual.end.y - manual.start.y) * 6));
      const circular = kind === "curve" && manual.arcPoint
        ? circularArcThroughPoints(manual.start, manual.arcPoint, manual.end)
        : null;
      const points = circular?.points ?? (kind === "curve" && manual.control
        ? Array.from({ length: sampleCount + 1 }, (_, index) => {
          const t = index / sampleCount;
          const inverse = 1 - t;
          return {
            x: inverse * inverse * manual.start.x + 2 * inverse * t * manual.control!.x + t * t * manual.end.x,
            y: inverse * inverse * manual.start.y + 2 * inverse * t * manual.control!.y + t * t * manual.end.y,
          };
        })
        : [manual.start, manual.end]);
      if (pathLength(points) >= 0.2) wallPaths.push({
        points,
        kind: kind === "curve" ? "curve" : "straight-exact",
        roomId: `manual-${manual.id}`,
        insideVariant: settings.innerWallVariant,
        outsideVariant: settings.outerWallVariant,
        manualWallId: manual.id,
        elevation: (manual.elevationSteps ?? 0) * ROOM_ELEVATION_STEP,
      });
      continue;
    }
    const dx = manual.end.x - manual.start.x;
    const dy = manual.end.y - manual.start.y;
    const horizontal = Math.abs(dx) >= Math.abs(dy);
    const length = horizontal ? Math.abs(dx) : Math.abs(dy);
    if (length < CELL_SIZE - 1e-3) continue;
    const count = Math.round(length / CELL_SIZE);
    const rotation = horizontal ? (dx >= 0 ? 0 : Math.PI) : (dy >= 0 ? Math.PI / 2 : 3 * Math.PI / 2);
    const side: Side = horizontal ? (dx >= 0 ? "S" : "N") : (dy >= 0 ? "E" : "W");
    for (let index = 0; index < count; index += 1) {
      walls.push({
        x: manual.start.x + Math.cos(rotation) * index * CELL_SIZE,
        y: manual.start.y + Math.sin(rotation) * index * CELL_SIZE,
        length: CELL_SIZE,
        rotation,
        side,
        variant: settings.wallVariant,
        manualWallId: manual.id,
        manualWallModuleIndex: index,
        elevation: (manual.elevationSteps ?? 0) * ROOM_ELEVATION_STEP,
      });
    }
  }
  const manualJunctions = new Map<string, Set<"horizontal" | "vertical">>();
  const manualConnections = new Map<string, Set<"E" | "W" | "N" | "S">>();
  const addConnection = (x: number, y: number, direction: "E" | "W" | "N" | "S", elevation: number) => {
    const key = `${x.toFixed(4)},${y.toFixed(4)},${elevation}`;
    const directions = manualConnections.get(key) ?? new Set<"E" | "W" | "N" | "S">();
    directions.add(direction);
    manualConnections.set(key, directions);
  };
  for (const manual of wallManuals) {
    if ((manual.kind ?? "straight") !== "straight") {
      for (const point of [manual.start, manual.end]) {
        const elevation = (manual.elevationSteps ?? 0) * ROOM_ELEVATION_STEP;
        if (pillars.some((pillar) => Math.abs((pillar.elevation ?? 0) - elevation) < 1e-5 && Math.hypot(pillar.x - point.x, pillar.y - point.y) < 1e-3)) continue;
        pillars.push({ x: point.x, y: point.y, junction: true, variant: settings.pillarVariant, ...(elevation ? { elevation } : {}) });
      }
      continue;
    }
    const dx = manual.end.x - manual.start.x;
    const dy = manual.end.y - manual.start.y;
    const horizontal = Math.abs(dx) >= Math.abs(dy);
    const length = horizontal ? Math.abs(dx) : Math.abs(dy);
    const count = Math.round(length / CELL_SIZE);
    const direction = horizontal ? Math.sign(dx) : Math.sign(dy);
    if (!direction || count < 1) continue;
    for (let index = 0; index <= count; index += 1) {
      const x = manual.start.x + (horizontal ? direction * index * CELL_SIZE : 0);
      const y = manual.start.y + (horizontal ? 0 : direction * index * CELL_SIZE);
      const key = `${x.toFixed(4)},${y.toFixed(4)},${(manual.elevationSteps ?? 0) * ROOM_ELEVATION_STEP}`;
      const axes = manualJunctions.get(key) ?? new Set<"horizontal" | "vertical">();
      axes.add(horizontal ? "horizontal" : "vertical");
      manualJunctions.set(key, axes);
    }
    for (let index = 0; index < count; index += 1) {
      const x = manual.start.x + (horizontal ? direction * index * CELL_SIZE : 0);
      const y = manual.start.y + (horizontal ? 0 : direction * index * CELL_SIZE);
      const nextX = x + (horizontal ? direction * CELL_SIZE : 0);
      const nextY = y + (horizontal ? 0 : direction * CELL_SIZE);
      if (horizontal) {
        addConnection(x, y, direction > 0 ? "E" : "W", (manual.elevationSteps ?? 0) * ROOM_ELEVATION_STEP);
        addConnection(nextX, nextY, direction > 0 ? "W" : "E", (manual.elevationSteps ?? 0) * ROOM_ELEVATION_STEP);
      } else {
        addConnection(x, y, direction > 0 ? "N" : "S", (manual.elevationSteps ?? 0) * ROOM_ELEVATION_STEP);
        addConnection(nextX, nextY, direction > 0 ? "S" : "N", (manual.elevationSteps ?? 0) * ROOM_ELEVATION_STEP);
      }
    }
  }
  for (const [key, connections] of manualConnections) {
    const axes = manualJunctions.get(key);
    const isCornerOrJunction = Boolean(axes && axes.size >= 2);
    const isOpenEnd = connections.size === 1;
    if (!isCornerOrJunction && !isOpenEnd) continue;
    const [x, y, elevation] = key.split(",").map(Number);
    if (pillars.some((pillar) => Math.abs((pillar.elevation ?? 0) - elevation) < 1e-5 && Math.hypot(pillar.x - x, pillar.y - y) < 1e-3)) continue;
    pillars.push({ x, y, junction: true, variant: settings.pillarVariant, ...(elevation ? { elevation } : {}) });
  }
  if (wallDeletions.length) {
    const visible = walls.filter((wall) => {
      const cx = wall.x + Math.cos(wall.rotation) * wall.length / 2;
      const cy = wall.y + Math.sin(wall.rotation) * wall.length / 2;
      const axis = Math.abs(Math.cos(wall.rotation)) >= Math.abs(Math.sin(wall.rotation)) ? "horizontal" : "vertical";
      return !wallDeletions.some((deletion) => deletion.axis === axis
        && (!deletion.roomId || deletion.roomId === wall.roomId || deletion.roomId === wall.opposingRoomId)
        && Math.abs((deletion.elevation ?? 0) - (wall.elevation ?? 0)) < 1e-5
        && Math.hypot(deletion.cx - cx, deletion.cy - cy) < 0.05);
    });
    walls.splice(0, walls.length, ...visible);
  }
  const externalWalls = walls.filter((wall) => !wall.opposingRoomId);
  const externalPaths = wallPaths.filter((path) => !path.opposingRoomId);
  const perimeter = externalWalls.reduce((sum, wall) => sum + wall.length, 0)
    + externalPaths.reduce((sum, path) => sum + pathLength(path.points), 0);
  const pathModules = wallPaths.reduce((sum, path) => sum + Math.max(1, Math.ceil(pathLength(path.points) / CELL_SIZE)), 0);
  const wallModules = walls.length + pathModules;
  const roomArea = roomGrounds.length
    ? roomGrounds.reduce((sum, ground) => sum + polygonArea(ground.outer) - ground.holes.reduce((holeSum, hole) => holeSum + polygonArea(hole), 0), 0)
    : cells.length * CELL_SIZE * CELL_SIZE;
  const floorArea = floorGrounds.reduce((sum, ground) => sum + polygonArea(ground.outer) - ground.holes.reduce((holeSum, hole) => holeSum + polygonArea(hole), 0), 0);
  const shapeArea = roomArea + floorArea;
  // Room grounds are triangulated meshes, not discrete tiles, so the count comes from the
  // rendered area. A plain grid plan gives back exactly cells.length, while a merged room
  // counts its overlap once — which a per-part sum could not.
  const floorTiles = Math.round(shapeArea / (CELL_SIZE * CELL_SIZE));
  const totalModules = floorTiles + wallModules + corners.length + pillars.length + balconyRailings.length + balconyPillars.length;

  return {
    cells,
    cellKeys: keys,
    walls,
    wallPaths,
    corners,
    pillars,
    balconyRailings,
    balconyPillars,
    roomGrounds,
    foundationGrounds: roomHitAreas.filter((ground) => rooms.some((room) => room.id === ground.roomId && (room.foundationHeight !== undefined ? Math.abs((ground.elevation ?? 0) - room.foundationHeight) < 0.00001 : (ground.elevation ?? 0) <= 0))),
    floorGrounds,
    floorHitAreas,
    floorCornerHandles,
    roomHitAreas,
    roomGroups,
    cornerHandles,
    radiusHandles,
    wallResizeHandles,
    openings: [...rooms.flatMap((room) => room.openings ?? []), ...wallManuals.flatMap((wall) => wall.openings ?? [])].filter((opening) => !opening.suppressed),
    bounds: manualWalls.length ? {
      minX: Math.min(getGroundBounds([...roomGrounds, ...floorGrounds], getBounds(cells)).minX, ...manualWalls.flatMap((wall) => [wall.start.x, wall.end.x, wall.arcPoint?.x ?? wall.control?.x ?? wall.start.x])),
      minY: Math.min(getGroundBounds([...roomGrounds, ...floorGrounds], getBounds(cells)).minY, ...manualWalls.flatMap((wall) => [wall.start.y, wall.end.y, wall.arcPoint?.y ?? wall.control?.y ?? wall.start.y])),
      maxX: Math.max(getGroundBounds([...roomGrounds, ...floorGrounds], getBounds(cells)).maxX, ...manualWalls.flatMap((wall) => [wall.start.x, wall.end.x, wall.arcPoint?.x ?? wall.control?.x ?? wall.start.x])),
      maxY: Math.max(getGroundBounds([...roomGrounds, ...floorGrounds], getBounds(cells)).maxY, ...manualWalls.flatMap((wall) => [wall.start.y, wall.end.y, wall.arcPoint?.y ?? wall.control?.y ?? wall.start.y])),
    } : getGroundBounds([...roomGrounds, ...floorGrounds], getBounds(cells)),
    stats: {
      area: shapeArea,
      perimeter,
      straightWallLength: walls.reduce((sum, wall) => sum + wall.length, 0),
      floorTiles,
      wallModules,
      cornerModules: corners.length,
      pillarModules: pillars.length + balconyPillars.length,
      connectedRooms: rooms.length
        ? [...elevationGroups.values()].reduce((total, levelRooms) => {
          const levelCells = normalizeCells(levelRooms.flatMap((room) => room.cells));
          const levelKeys = new Set(levelCells.map((cell) => cellKey(cell.x, cell.y)));
          return total + countFloorZones(levelCells, levelKeys, levelRooms.flatMap((room) => room.circles ?? []));
        }, 0)
        : countFloorZones(cells, keys, []),
      totalModules,
    },
  };
}

export function rectangleCells(originX: number, originY: number, width: number, depth: number): Cell[] {
  const cells: Cell[] = [];
  for (let row = 0; row < depth; row += 1) {
    for (let column = 0; column < width; column += 1) {
      cells.push({ x: originX + column, y: originY + row });
    }
  }
  return cells;
}
