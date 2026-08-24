import type {
  BuildSettings,
  Cell,
  CircleShape,
  CornerHandle,
  GeneratedLayout,
  LayoutBounds,
  PlanPoint,
  Pillar,
  RadiusHandle,
  Room,
  RoomGround,
  Side,
  Variant,
  WallPath,
  WallSegment,
} from "./types";
import { buildEditedRoomGeometry, circleOverlapsCell, circlesOverlap, pathLength, polygonArea } from "./footprint";

export const CELL_SIZE = 2;
export const WALL_HEIGHT = 3;
/** Upper bound on the rectilinear cell count, so a runaway drag can't materialise 250k objects. */
export const MAX_CELLS = 10_000;
export const CORNER_ARM = 1;
export const WALL_THICKNESS = 0.16;

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

function addRoomGeometry(
  rooms: Room[],
  settings: BuildSettings,
  walls: WallSegment[],
  wallPaths: WallPath[],
  pillars: Pillar[],
  roomGrounds: RoomGround[],
  cornerHandles: CornerHandle[],
  radiusHandles: RadiusHandle[],
) {
  const byEdge = new Map<string, WallSegment>();
  const byPath = new Map<string, WallPath>();
  const pillarKeys = new Set<string>();
  for (const room of rooms) {
    const geometry = buildEditedRoomGeometry(room, settings.curveQuality);
    roomGrounds.push(...geometry.grounds);
    cornerHandles.push(...geometry.handles);
    radiusHandles.push(...geometry.radiusHandles);
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

export function buildLayout(inputCells: Cell[], settings: BuildSettings, rooms: Room[] = []): GeneratedLayout {
  const cells = normalizeCells(inputCells);
  const keys = new Set(cells.map((cell) => cellKey(cell.x, cell.y)));
  const random = mulberry32(settings.randomSeed);
  const walls: WallSegment[] = [];
  const wallPaths: WallPath[] = [];
  const roomGrounds: RoomGround[] = [];
  const cornerHandles: CornerHandle[] = [];
  const radiusHandles: RadiusHandle[] = [];
  let corners: never[] = [];
  let pillars: Pillar[] = [];
  if (rooms.length) {
    addRoomGeometry(rooms, settings, walls, wallPaths, pillars, roomGrounds, cornerHandles, radiusHandles);
  } else {
    const runs = boundaryRuns(cells, keys);
    for (const run of runs) addPerimeterRun(walls, run, settings, random);
    ({ corners, pillars } = buildCornersAndPillars(cells, keys, settings));
  }
  const externalWalls = walls.filter((wall) => !wall.opposingRoomId);
  const externalPaths = wallPaths.filter((path) => !path.opposingRoomId);
  const perimeter = externalWalls.reduce((sum, wall) => sum + wall.length, 0)
    + externalPaths.reduce((sum, path) => sum + pathLength(path.points), 0);
  const pathModules = wallPaths.reduce((sum, path) => sum + Math.max(1, Math.ceil(pathLength(path.points) / CELL_SIZE)), 0);
  const wallModules = walls.length + pathModules;
  const shapeArea = roomGrounds.length
    ? roomGrounds.reduce((sum, ground) => sum + polygonArea(ground.outer) - ground.holes.reduce((holeSum, hole) => holeSum + polygonArea(hole), 0), 0)
    : cells.length * CELL_SIZE * CELL_SIZE;
  // Room grounds are triangulated meshes, not discrete tiles, so the count comes from the
  // rendered area. A plain grid plan gives back exactly cells.length, while a merged room
  // counts its overlap once — which a per-part sum could not.
  const floorTiles = Math.round(shapeArea / (CELL_SIZE * CELL_SIZE));
  const totalModules = floorTiles + wallModules + corners.length + pillars.length;

  return {
    cells,
    cellKeys: keys,
    walls,
    wallPaths,
    corners,
    pillars,
    roomGrounds,
    cornerHandles,
    radiusHandles,
    bounds: getGroundBounds(roomGrounds, getBounds(cells)),
    stats: {
      area: shapeArea,
      perimeter,
      straightWallLength: walls.reduce((sum, wall) => sum + wall.length, 0),
      floorTiles,
      wallModules,
      cornerModules: corners.length,
      pillarModules: pillars.length,
      connectedRooms: countFloorZones(cells, keys, rooms.flatMap((room) => room.circles ?? [])),
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
