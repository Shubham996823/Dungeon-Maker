import { describe, expect, it } from "vitest";
import { cellCenterToWorld, planYToWorldZ, worldPointToCell } from "./coordinates";
import { buildLayout, normalizeCells, rectangleCells, resizeRoomCells } from "./layout";
import type { BuildSettings, Room, WallResizeHandle } from "./types";

const settings: BuildSettings = {
  floorVariant: "A",
  wallVariant: "A",
  innerWallVariant: "A",
  outerWallVariant: "A",
  flipInnerWall: true,
  flipOuterWall: true,
  wallOrientationVersion: 1,
  showInnerWalls: true,
  showOuterWalls: true,
  innerWallOffset: 0,
  outerWallOffset: 0,
  cornerVariant: "A",
  pillarVariant: "A",
  randomizeWalls: false,
  randomSeed: 1,
  addPillars: false,
  pillarInset: 0.3,
  curveQuality: 64,
  sharedWallSeparation: 0.04,
  dynamicLighting: true,
  timeOfDay: 13,
  ambientLight: 1,
  exposure: 1.05,
  hdriBackground: true,
  hdriIntensity: 1,
  hdriRotation: 0,
};

describe("buildLayout", () => {
  it("builds a rectangle from straight wall runs", () => {
    const layout = buildLayout(rectangleCells(0, 0, 4, 3), settings);
    expect(layout.stats.floorTiles).toBe(12);
    expect(layout.stats.area).toBe(48);
    expect(layout.stats.perimeter).toBe(28);
    expect(layout.stats.straightWallLength).toBe(28);
    expect(layout.stats.wallModules).toBe(14);
    expect(layout.stats.cornerModules).toBe(0);
  });

  it("surrounds a single cell with straight wall pieces", () => {
    const layout = buildLayout([{ x: 0, y: 0 }], settings);
    expect(layout.walls).toHaveLength(4);
    expect(layout.corners).toHaveLength(0);
    expect(layout.stats.perimeter).toBe(8);
  });

  it("keeps a concave join connected with straight wall runs", () => {
    const layout = buildLayout(
      [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }],
      settings,
    );
    expect(layout.walls.every((wall) => wall.length >= 2)).toBe(true);
    expect(layout.stats.connectedRooms).toBe(1);
  });

  it("deduplicates overlaps and counts disconnected areas", () => {
    const layout = buildLayout(
      [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 3, y: 0 }],
      settings,
    );
    expect(layout.cells).toHaveLength(2);
    expect(layout.stats.connectedRooms).toBe(2);
  });

  it("keeps seeded wall randomization deterministic", () => {
    const randomized = { ...settings, randomizeWalls: true, randomSeed: 42 };
    const first = buildLayout(rectangleCells(0, 0, 6, 4), randomized);
    const second = buildLayout(rectangleCells(0, 0, 6, 4), randomized);
    expect(second.walls.map((wall) => wall.variant)).toEqual(first.walls.map((wall) => wall.variant));
  });
});

describe("3D coordinate mapping", () => {
  it("maps plan north to negative world depth without mirroring the cell", () => {
    expect(planYToWorldZ(6)).toBe(-6);
    const cell = { x: -2, y: 3 };
    const world = cellCenterToWorld(cell);
    expect(world).toEqual({ x: -3, z: -7 });
    expect(worldPointToCell(world.x, world.z)).toEqual(cell);
  });
});

describe("wall resizing", () => {
  const northWall: WallResizeHandle = {
    roomId: "room",
    start: { x: 8, y: 6 },
    end: { x: 0, y: 6 },
    outwardX: 0,
    outwardY: 1,
  };

  it("adds complete cell rows when a wall moves outward", () => {
    const resized = resizeRoomCells(rectangleCells(0, 0, 4, 3), northWall, 1);
    expect(resized).toHaveLength(16);
    expect(resized.filter((cell) => cell.y === 3)).toHaveLength(4);
  });

  it("removes complete cell rows when a wall moves inward", () => {
    const resized = resizeRoomCells(rectangleCells(0, 0, 4, 3), northWall, -1);
    expect(resized).toHaveLength(8);
    expect(resized.some((cell) => cell.y === 2)).toBe(false);
  });
});

describe("joined-room editing controls", () => {
  const room = (id: string, x: number): Room => ({
    id,
    cells: rectangleCells(x, 0, 2, 2),
    circles: [],
    style: { innerWallVariant: "A", outerWallVariant: "A" },
    cornerEdits: [],
  });

  it("reports coincident handles for a shared wall and its endpoints", () => {
    const layout = buildLayout(rectangleCells(0, 0, 4, 2), settings, [room("left", 0), room("right", 2)]);
    const sharedWall = layout.wallResizeHandles.filter((handle) =>
      (handle.start.x === 4 && handle.end.x === 4)
      && new Set([handle.start.y, handle.end.y]).size === 2,
    );
    expect(sharedWall).toHaveLength(2);
    expect(layout.cornerHandles.filter((handle) => handle.vertexX === 2 && handle.vertexY === 0)).toHaveLength(2);
  });
});

describe("temporary room unions", () => {
  const makeRoom = (id: string, x: number): Room => ({
    id,
    cells: rectangleCells(x, 0, 2, 2),
    circles: [],
    style: { innerWallVariant: "A", outerWallVariant: "A" },
    cornerEdits: [],
  });

  it("unions overlap only for layout generation, so separated room records render independently again", () => {
    const moved = makeRoom("moved", 1);
    const original = makeRoom("original", 0);
    const overlapLayout = buildLayout(normalizeCells([...moved.cells, ...original.cells]), settings, [moved, original]);
    expect(overlapLayout.roomGrounds).toHaveLength(1);
    expect(overlapLayout.roomGrounds[0].roomId).toBe("moved");
    expect(overlapLayout.roomHitAreas).toHaveLength(2);
    expect(overlapLayout.roomGroups).toEqual([["moved", "original"]]);
    expect(new Set(overlapLayout.cornerHandles.map((handle) => handle.roomId))).toEqual(new Set(["moved", "original"]));
    expect(new Set(overlapLayout.wallResizeHandles.map((handle) => handle.roomId))).toEqual(new Set(["moved", "original"]));

    const separated = makeRoom("moved", 4);
    const separatedLayout = buildLayout(normalizeCells([...separated.cells, ...original.cells]), settings, [separated, original]);
    expect(separatedLayout.roomGrounds).toHaveLength(2);
    expect(separatedLayout.roomHitAreas).toHaveLength(2);
    expect(separatedLayout.roomGroups).toEqual([["moved"], ["original"]]);
  });

  it("unions completed diagonal and curved outlines without rebuilding either room from raw cells", () => {
    const diagonal = makeRoom("diagonal", 0);
    diagonal.cornerEdits = [{ vertexX: 2, vertexY: 0, insetCells: 1, shape: "diagonal", inverted: false }];
    const curved: Room = {
      id: "curved",
      cells: [],
      circles: [{ cx: 1, cy: 5, radius: 3 }],
      style: { innerWallVariant: "A", outerWallVariant: "A" },
      cornerEdits: [],
    };
    const layout = buildLayout(normalizeCells([...diagonal.cells]), settings, [diagonal, curved]);
    expect(layout.roomGroups).toEqual([["diagonal", "curved"]]);
    expect(layout.roomGrounds).toHaveLength(1);
    expect(layout.wallPaths.some((path) => path.kind === "diagonal")).toBe(true);
    expect(layout.wallPaths.some((path) => path.kind === "curve")).toBe(true);
    expect(layout.wallPaths.every((path) => path.points.length >= 2)).toBe(true);
  });
});
