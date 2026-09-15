import { describe, expect, it } from "vitest";
import { onGridLevel, visibleAtOrBelowGridLevel } from "./gridLevels";
import { cellCenterToWorld, planYToWorldZ, worldPointToCell } from "./coordinates";
import { buildLayout, circularArcThroughPoints, eraseManualWallModule, eraseManualWallModules, normalizeCells, rectangleCells, resizeRoomCells } from "./layout";
import type { BuildSettings, FloorRegion, Room, WallResizeHandle } from "./types";

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
  moduleWallVariant: "2",
  modulePillarVariant: "1",
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
    openings: [],
  });

  it("reports coincident handles for a shared wall and its endpoints", () => {
    const layout = buildLayout(rectangleCells(0, 0, 4, 2), settings, [room("left", 0), room("right", 2)]);
    const sharedWall = layout.wallResizeHandles.filter((handle) =>
      (handle.start.x === 4 && handle.end.x === 4)
      && new Set([handle.start.y, handle.end.y]).size === 2,
    );
    expect(sharedWall).toHaveLength(2);
    const sharedSegments = layout.walls.filter((wall) => wall.opposingRoomId);
    expect(sharedSegments).toHaveLength(2);
    expect(sharedSegments.every((wall) => new Set([wall.roomId, wall.opposingRoomId]).size === 2)).toBe(true);
    expect(sharedSegments.reduce((total, wall) => total + wall.length, 0)).toBe(4);
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
    openings: [],
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
    openings: [],
    };
    const layout = buildLayout(normalizeCells([...diagonal.cells]), settings, [diagonal, curved]);
    expect(layout.roomGroups).toEqual([["diagonal", "curved"]]);
    expect(layout.roomGrounds).toHaveLength(1);
    expect(layout.wallPaths.some((path) => path.kind === "diagonal")).toBe(true);
    expect(layout.wallPaths.some((path) => path.kind === "curve")).toBe(true);
    // A curve is sampled for its shape, not converted into one path/pillar per sample.
    expect(layout.wallPaths.filter((path) => path.kind === "curve")).toHaveLength(2);
    expect(layout.wallPaths.every((path) => path.points.length >= 2)).toBe(true);
  });

  it("keeps identical footprints separate when their elevations differ", () => {
    const ground = makeRoom("ground", 0);
    const raised = { ...makeRoom("raised", 0), elevationSteps: 4 };
    const layout = buildLayout(ground.cells, settings, [ground, raised]);

    expect(layout.roomGroups).toEqual([["ground"], ["raised"]]);
    expect(layout.roomGrounds.map((item) => item.elevation)).toEqual([0, 1]);
    expect(layout.roomHitAreas.map((item) => item.elevation)).toEqual([0, 1]);
    expect(layout.walls.filter((wall) => wall.roomId === "ground").every((wall) => wall.elevation === 0)).toBe(true);
    expect(layout.walls.filter((wall) => wall.roomId === "raised").every((wall) => wall.elevation === 1)).toBe(true);
    expect(layout.cornerHandles.filter((handle) => handle.roomId === "raised").every((handle) => handle.elevation === 1)).toBe(true);
    expect(layout.wallResizeHandles.filter((handle) => handle.roomId === "raised").every((handle) => handle.elevation === 1)).toBe(true);
    expect(layout.stats.connectedRooms).toBe(2);
  });

  it("builds independent raised floors without generating room walls", () => {
    const floor: FloorRegion = {
      id: "balcony",
      cells: rectangleCells(0, 0, 3, 2),
      cornerEdits: [{ vertexX: 0, vertexY: 0, insetCells: 1, shape: "diagonal", inverted: false }],
      elevationSteps: 3,
      variant: "2",
    };
    const layout = buildLayout([], settings, [], [], [], [floor]);
    expect(layout.floorGrounds).toHaveLength(1);
    expect(layout.floorGrounds[0]).toMatchObject({ floorId: "balcony", elevation: 0.75, variant: "2" });
    expect(layout.floorCornerHandles.every((handle) => handle.roomId === "balcony" && handle.elevation === 0.75)).toBe(true);
    expect(layout.walls).toHaveLength(0);
    expect(layout.roomGrounds).toHaveLength(0);
    expect(layout.stats.area).toBeGreaterThan(0);
  });

  it("carries wall openings into the generated layout", () => {
    const cells = rectangleCells(0, 0, 2, 2);
    const opening = { id: "window", roomId: "room", asset: "WD_2" as const, cx: 1, cy: 0, rotation: 0 };
    const room: Room = { id: "room", cells, circles: [], style: { innerWallVariant: "A", outerWallVariant: "A" }, cornerEdits: [], openings: [opening] };
    expect(buildLayout(cells, settings, [room]).openings).toEqual([opening]);
  });
});

describe("standalone wall drawing", () => {
  it("keeps walls and pillars at independent grid heights after splitting", () => {
    const walls = [
      { id: "base", start: { x: 0, y: 0 }, end: { x: 6, y: 0 }, elevationSteps: 0 },
      { id: "upper", start: { x: 0, y: 0 }, end: { x: 6, y: 0 }, elevationSteps: 10 },
      { id: "lower", start: { x: 0, y: 0 }, end: { x: 6, y: 0 }, elevationSteps: -10 },
    ];
    const split = eraseManualWallModule(walls, "upper", 1);
    const layout = buildLayout([], settings, [], split);
    expect(layout.walls.filter(wall => wall.elevation === 2.5)).toHaveLength(2);
    expect(layout.walls.filter(wall => wall.elevation === 0)).toHaveLength(3);
    expect(layout.walls.filter(wall => wall.elevation === -2.5)).toHaveLength(3);
    expect(new Set(layout.pillars.map(pillar => pillar.elevation ?? 0))).toEqual(new Set([0, 2.5, -2.5]));
  });

  it("assigns quarter-metre offsets to one active grid including negative levels", () => {
    expect(onGridLevel(undefined, 0)).toBe(true);
    expect(onGridLevel(13, 1)).toBe(true);
    expect(onGridLevel(13, 0)).toBe(false);
    expect(onGridLevel(-10, -1)).toBe(true);
    expect(onGridLevel(-1, -1)).toBe(true);
    expect(onGridLevel(-11, -1)).toBe(false);
  });

  it("shows the active grid and all levels below it", () => {
    expect(visibleAtOrBelowGridLevel(20, 1)).toBe(false);
    expect(visibleAtOrBelowGridLevel(10, 1)).toBe(true);
    expect(visibleAtOrBelowGridLevel(0, 1)).toBe(true);
    expect(visibleAtOrBelowGridLevel(-10, 1)).toBe(true);
    expect(visibleAtOrBelowGridLevel(0, -1)).toBe(false);
    expect(visibleAtOrBelowGridLevel(-10, -1)).toBe(true);
  });
  it("splits a snapped run into reusable two-metre wall modules without creating floor", () => {
    const layout = buildLayout([], settings, [], [{ id: "wall-1", start: { x: 0, y: 0 }, end: { x: 6, y: 0 } }]);
    expect(layout.walls).toHaveLength(3);
    expect(layout.walls.map((wall) => [wall.x, wall.y, wall.length])).toEqual([[0, 0, 2], [2, 0, 2], [4, 0, 2]]);
    expect(layout.roomGrounds).toHaveLength(0);
    expect(layout.stats.wallModules).toBe(3);
  });

  it("places one pillar where perpendicular wall runs form a corner", () => {
    const layout = buildLayout([], settings, [], [
      { id: "horizontal", start: { x: 0, y: 0 }, end: { x: 4, y: 0 } },
      { id: "vertical", start: { x: 4, y: 0 }, end: { x: 4, y: 4 } },
    ]);
    expect(layout.pillars).toEqual([
      { x: 0, y: 0, junction: true, variant: settings.pillarVariant },
      { x: 4, y: 0, junction: true, variant: settings.pillarVariant },
      { x: 4, y: 4, junction: true, variant: settings.pillarVariant },
    ]);
  });

  it("places pillars at open ends but not at a straight wall join", () => {
    const layout = buildLayout([], settings, [], [
      { id: "left", start: { x: 0, y: 0 }, end: { x: 4, y: 0 } },
      { id: "right", start: { x: 4, y: 0 }, end: { x: 8, y: 0 } },
    ]);
    expect(layout.pillars).toEqual([
      { x: 0, y: 0, junction: true, variant: settings.pillarVariant },
      { x: 8, y: 0, junction: true, variant: settings.pillarVariant },
    ]);
  });

  it("builds balcony railings from one-metre modules with posts at ends, L corners, and T joints", () => {
    const layout = buildLayout([], settings, [], [
      { id: "rail-main", assembly: "balcony-railing", start: { x: 0, y: 0 }, end: { x: 4, y: 0 } },
      { id: "rail-branch", assembly: "balcony-railing", start: { x: 2, y: 0 }, end: { x: 2, y: 2 } },
      { id: "rail-corner", assembly: "balcony-railing", start: { x: 4, y: 0 }, end: { x: 4, y: 1 } },
    ]);
    expect(layout.walls).toHaveLength(0);
    expect(layout.balconyRailings).toHaveLength(7);
    expect(layout.balconyRailings.every((railing) => Math.abs(railing.length - 1) < 1e-5)).toBe(true);
    expect(layout.balconyPillars.map((pillar) => [pillar.x, pillar.y])).toEqual([
      [0, 0],
      [4, 0],
      [2, 0],
      [2, 2],
      [4, 1],
    ]);
  });

  it("erases one balcony railing module without changing its one-metre sizing", () => {
    const railings = eraseManualWallModule(
      [{ id: "rail", assembly: "balcony-railing", start: { x: 0, y: 0 }, end: { x: 3, y: 0 } }],
      "rail",
      1,
    );
    expect(railings.map((railing) => [railing.start, railing.end])).toEqual([
      [{ x: 0, y: 0 }, { x: 1, y: 0 }],
      [{ x: 2, y: 0 }, { x: 3, y: 0 }],
    ]);
    expect(railings.every((railing) => railing.assembly === "balcony-railing")).toBe(true);
  });

  it("erases several modules from the same railing marquee in one pass", () => {
    const railings = eraseManualWallModules(
      [{ id: "rail", assembly: "balcony-railing", start: { x: 0, y: 0 }, end: { x: 4, y: 0 } }],
      "rail",
      [0, 1, 3],
    );
    expect(railings.map((railing) => [railing.start, railing.end])).toEqual([
      [{ x: 2, y: 0 }, { x: 3, y: 0 }],
    ]);
  });

  it("erases covered modules while preserving the rest of a longer wall", () => {
    const walls = eraseManualWallModule(
      [{ id: "run", start: { x: 0, y: 0 }, end: { x: 8, y: 0 } }],
      "run",
      1,
    );
    expect(walls.map((wall) => [wall.start, wall.end])).toEqual([
      [{ x: 0, y: 0 }, { x: 2, y: 0 }],
      [{ x: 4, y: 0 }, { x: 6, y: 0 }],
      [{ x: 6, y: 0 }, { x: 8, y: 0 }],
    ]);
  });

  it("keeps a deleted room-wall module suppressed when the room layout rebuilds", () => {
    const cells = rectangleCells(0, 0, 2, 2);
    const original = buildLayout(cells, settings);
    const removed = original.walls[0];
    const cx = removed.x + Math.cos(removed.rotation) * removed.length / 2;
    const cy = removed.y + Math.sin(removed.rotation) * removed.length / 2;
    const axis = Math.abs(Math.cos(removed.rotation)) >= Math.abs(Math.sin(removed.rotation)) ? "horizontal" as const : "vertical" as const;
    const rebuilt = buildLayout(cells, settings, [], [], [{ id: "deleted", cx, cy, axis }]);
    expect(rebuilt.walls).toHaveLength(original.walls.length - 1);
    expect(rebuilt.walls.some((wall) => Math.hypot(wall.x + Math.cos(wall.rotation) * wall.length / 2 - cx, wall.y + Math.sin(wall.rotation) * wall.length / 2 - cy) < 0.05)).toBe(false);
  });

  it("renders a diagonal manual wall as one exact path", () => {
    const layout = buildLayout([], settings, [], [{ id: "diagonal", kind: "diagonal", start: { x: 0, y: 0 }, end: { x: 4, y: 4 } }]);
    expect(layout.walls).toHaveLength(0);
    expect(layout.wallPaths).toEqual([expect.objectContaining({ kind: "straight-exact", manualWallId: "diagonal", points: [{ x: 0, y: 0 }, { x: 4, y: 4 }] })]);
    expect(layout.pillars.map((pillar) => [pillar.x, pillar.y])).toEqual([[0, 0], [4, 4]]);
  });

  it("samples a circular manual wall through its authored arc point", () => {
    const layout = buildLayout([], settings, [], [{ id: "curve", kind: "curve", start: { x: 0, y: 0 }, arcPoint: { x: 2, y: 4 }, end: { x: 4, y: 0 } }]);
    expect(layout.wallPaths).toHaveLength(1);
    expect(layout.wallPaths[0].kind).toBe("curve");
    expect(layout.wallPaths[0].points.length).toBeGreaterThan(12);
    expect(Math.min(...layout.wallPaths[0].points.map((point) => Math.hypot(point.x - 2, point.y - 4)))).toBeLessThan(1e-5);
  });

  it("preserves legacy quadratic walls that only have a control point", () => {
    const layout = buildLayout([], settings, [], [{ id: "legacy", kind: "curve", start: { x: 0, y: 0 }, control: { x: 2, y: 4 }, end: { x: 4, y: 0 } }]);
    expect(Math.max(...layout.wallPaths[0].points.map((point) => point.y))).toBeCloseTo(2, 5);
  });

});

describe("circular wall arcs", () => {
  it("creates a circle segment that interpolates all three authored points", () => {
    const start = { x: 0, y: 0 };
    const arcPoint = { x: 2, y: 4 };
    const end = { x: 4, y: 0 };
    const arc = circularArcThroughPoints(start, arcPoint, end);
    expect(arc).not.toBeNull();
    expect(arc!.points[0]).toEqual(start);
    expect(arc!.points.at(-1)).toEqual(end);
    expect(Math.min(...arc!.points.map((point) => Math.hypot(point.x - arcPoint.x, point.y - arcPoint.y)))).toBeLessThan(1e-8);
  });

  it("keeps the authored start point exact while the arc point changes", () => {
    const start = { x: -4, y: 2 };
    const end = { x: 6, y: 2 };
    const shallow = circularArcThroughPoints(start, { x: 0, y: 4 }, end);
    const deep = circularArcThroughPoints(start, { x: 0, y: 10 }, end);
    expect(shallow!.points[0]).toEqual(start);
    expect(deep!.points[0]).toEqual(start);
  });

  it("rejects a collinear bulge point", () => {
    expect(circularArcThroughPoints({ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 4, y: 0 })).toBeNull();
  });
});
