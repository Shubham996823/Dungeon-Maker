import type {
  BuildSettings,
  Cell,
  Corner,
  CornerKind,
  GeneratedLayout,
  LayoutBounds,
  Pillar,
  Side,
  Variant,
  WallSegment,
} from "./types";

export const CELL_SIZE = 2;
export const WALL_HEIGHT = 3;
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
  for (const segmentLength of [4, 2, 1]) {
    while (remaining >= segmentLength) {
      result.push(segmentLength);
      remaining -= segmentLength;
    }
  }
  return result;
}

function addPerimeterRun(
  walls: WallSegment[],
  keys: Set<string>,
  run: BoundaryRun,
  settings: BuildSettings,
  random: () => number,
) {
  const { side, line, start, cellLength } = run;
  const lowVertex: [number, number] = side === "S" || side === "N" ? [start, line] : [line, start];
  const highVertex: [number, number] =
    side === "S" || side === "N" ? [start + cellLength, line] : [line, start + cellLength];
  const reserveLow = cellsAtVertex(keys, ...lowVertex).length === 1 ? CORNER_ARM : 0;
  const reserveHigh = cellsAtVertex(keys, ...highVertex).length === 1 ? CORNER_ARM : 0;
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
): { corners: Corner[]; pillars: Pillar[] } {
  const vertices = new Set<string>();
  for (const { x, y } of cells) {
    vertices.add(cellKey(x, y));
    vertices.add(cellKey(x + 1, y));
    vertices.add(cellKey(x, y + 1));
    vertices.add(cellKey(x + 1, y + 1));
  }

  const corners: Corner[] = [];
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
      let kind: CornerKind;
      if (cell.x === vertexX && cell.y === vertexY) kind = "SW";
      else if (cell.x === vertexX - 1 && cell.y === vertexY) kind = "SE";
      else if (cell.x === vertexX - 1 && cell.y === vertexY - 1) kind = "NE";
      else kind = "NW";
      corners.push({ x: worldX, y: worldY, kind, variant: settings.cornerVariant });

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
  return { corners, pillars };
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

function countConnectedRooms(cells: Cell[], keys: Set<string>): number {
  const unvisited = new Set(keys);
  let count = 0;
  for (const cell of cells) {
    const startKey = cellKey(cell.x, cell.y);
    if (!unvisited.has(startKey)) continue;
    count += 1;
    const queue = [cell];
    unvisited.delete(startKey);
    while (queue.length) {
      const current = queue.pop()!;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const next = { x: current.x + dx, y: current.y + dy };
        const nextKey = cellKey(next.x, next.y);
        if (!unvisited.delete(nextKey)) continue;
        queue.push(next);
      }
    }
  }
  return count;
}

export function buildLayout(inputCells: Cell[], settings: BuildSettings): GeneratedLayout {
  const cells = normalizeCells(inputCells);
  const keys = new Set(cells.map((cell) => cellKey(cell.x, cell.y)));
  const random = mulberry32(settings.randomSeed);
  const walls: WallSegment[] = [];
  const runs = boundaryRuns(cells, keys);
  for (const run of runs) addPerimeterRun(walls, keys, run, settings, random);
  const { corners, pillars } = buildCornersAndPillars(cells, keys, settings);
  const perimeter = cells.reduce((total, cell) => {
    const exposedEdges = [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(
      ([dx, dy]) => !keys.has(cellKey(cell.x + dx, cell.y + dy)),
    ).length;
    return total + exposedEdges * CELL_SIZE;
  }, 0);
  const totalModules = cells.length + walls.length + corners.length + pillars.length;

  return {
    cells,
    cellKeys: keys,
    walls,
    corners,
    pillars,
    bounds: getBounds(cells),
    stats: {
      area: cells.length * CELL_SIZE * CELL_SIZE,
      perimeter,
      straightWallLength: walls.reduce((sum, wall) => sum + wall.length, 0),
      floorTiles: cells.length,
      wallModules: walls.length,
      cornerModules: corners.length,
      pillarModules: pillars.length,
      connectedRooms: countConnectedRooms(cells, keys),
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
