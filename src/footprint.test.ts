import { describe, expect, it } from "vitest";
import { splitRuns, unionTagged } from "./clip";
import type { TaggedPoint } from "./clip";
import {
  buildEditedRoomGeometry,
  circleFromDrag,
  circleIntersectsCellBounds,
  circleOverlapsCells,
  circlePolygon,
  circleSegments,
  circlesOverlap,
  MIN_CIRCLE_RADIUS,
  pathLength,
  polygonArea,
  signedArea,
  traceCellBoundaryLoops,
} from "./footprint";
import { buildLayout, CELL_SIZE, normalizeCells, rectangleCells } from "./layout";
import type { BuildSettings, CircleShape, Room } from "./types";

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
  addPillars: true,
  pillarInset: 0,
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

function room(id: string, x: number, y: number, width: number, depth: number): Room {
  return {
    id,
    cells: rectangleCells(x, y, width, depth),
    circles: [],
    style: { innerWallVariant: id === "left" ? "A" : "B", outerWallVariant: "C" },
    cornerEdits: [],
  };
}

function circleRoom(id: string, circle: CircleShape): Room {
  return {
    id,
    cells: [],
    circles: [circle],
    style: { innerWallVariant: "A", outerWallVariant: "C" },
    cornerEdits: [],
  };
}

describe("room footprint geometry", () => {
  it("traces the outer cell union counter-clockwise", () => {
    const loops = traceCellBoundaryLoops(rectangleCells(0, 0, 4, 3));
    expect(loops).toHaveLength(1);
    expect(signedArea(loops[0])).toBe(12);
  });

  it("cuts ground and walls to exact diagonal endpoints", () => {
    const edited = room("edited", 0, 0, 4, 3);
    edited.cornerEdits.push({ vertexX: 0, vertexY: 0, insetCells: 1, shape: "diagonal", inverted: false });
    const geometry = buildEditedRoomGeometry(edited, 64);
    const diagonal = geometry.paths.find((path) => path.kind === "diagonal");
    expect(diagonal?.points).toEqual([{ x: 0, y: 2 }, { x: 2, y: 0 }]);
    expect(pathLength(diagonal!.points)).toBeCloseTo(Math.sqrt(8));
    expect(polygonArea(geometry.grounds[0].outer)).toBeCloseTo(46);
    expect(geometry.pillarAnchors).toHaveLength(5);
  });

  it("samples curved corners continuously at interactive quality", () => {
    const edited = room("curved", 0, 0, 4, 3);
    edited.cornerEdits.push({ vertexX: 0, vertexY: 0, insetCells: 1, shape: "curve", inverted: false });
    const curve = buildEditedRoomGeometry(edited, 64).paths.find((path) => path.kind === "curve");
    expect(curve?.points.length).toBeGreaterThanOrEqual(65);
    expect(curve?.points[0]).toEqual({ x: 0, y: 2 });
    expect(curve?.points.at(-1)).toEqual({ x: 2, y: 0 });
  });

  it("allows one corner edit to consume the full adjoining walls", () => {
    const edited = room("full-cut", 0, 0, 4, 4);
    edited.cornerEdits.push({ vertexX: 0, vertexY: 0, insetCells: 4, shape: "diagonal", inverted: false });
    const diagonal = buildEditedRoomGeometry(edited, 64).paths.find((path) => path.kind === "diagonal");
    expect(diagonal?.points).toEqual([{ x: 0, y: 8 }, { x: 8, y: 0 }]);
  });

  it("shares an edge safely when two corner edits would otherwise cross", () => {
    const edited = room("conflict", 0, 0, 4, 4);
    edited.cornerEdits.push(
      { vertexX: 0, vertexY: 0, insetCells: 4, shape: "diagonal", inverted: false },
      { vertexX: 4, vertexY: 0, insetCells: 4, shape: "diagonal", inverted: false },
    );
    const diagonals = buildEditedRoomGeometry(edited, 64).paths.filter((path) => path.kind === "diagonal");
    expect(diagonals).toHaveLength(2);
    expect(diagonals[0].points[1]).toEqual(diagonals[1].points[0]);
  });

  it("resetting edits restores the original rectangle", () => {
    const geometry = buildEditedRoomGeometry(room("plain", 0, 0, 4, 3), 64);
    expect(polygonArea(geometry.grounds[0].outer)).toBe(48);
    expect(geometry.paths.some((path) => path.kind !== "straight")).toBe(false);
  });
});

describe("shared room boundaries", () => {
  it("stores one canonical wall with both room owners", () => {
    const left = room("left", 0, 0, 2, 2);
    const right = room("right", 2, 0, 2, 2);
    const layout = buildLayout([...left.cells, ...right.cells], settings, [left, right]);
    const shared = layout.walls.filter((wall) => wall.opposingRoomId);
    expect(shared).toHaveLength(2);
    expect(shared.every((wall) => wall.roomId === "left" && wall.opposingRoomId === "right")).toBe(true);
    expect(shared.every((wall) => wall.insideVariant === "A" && wall.opposingVariant === "B")).toBe(true);
  });
});

describe("circular rooms", () => {
  it("emits circle polygons counter-clockwise at the true radius", () => {
    const polygon = circlePolygon({ cx: 4, cy: -6, radius: 6 }, circleSegments(6));
    expect(signedArea(polygon)).toBeGreaterThan(0);
    // A polygon is inscribed, so it always undershoots πr² slightly.
    expect(polygonArea(polygon)).toBeGreaterThan(Math.PI * 36 * 0.999);
    expect(polygonArea(polygon)).toBeLessThanOrEqual(Math.PI * 36);
    expect(pathLength([...polygon, polygon[0]])).toBeCloseTo(2 * Math.PI * 6, 1);
    for (const point of polygon) expect(Math.hypot(point.x - 4, point.y + 6)).toBeCloseTo(6);
  });

  it("holds the chord roughly constant so faceting does not grow with radius", () => {
    for (const radius of [2, 6, 20]) {
      const polygon = circlePolygon({ cx: 0, cy: 0, radius }, circleSegments(radius));
      const chord = pathLength([polygon[0], polygon[1]]);
      const sagitta = radius * (1 - Math.cos(Math.PI / polygon.length));
      expect(chord).toBeLessThanOrEqual(0.36);
      expect(sagitta).toBeLessThan(0.004);
    }
  });

  it("builds one closed curved wall and one ground, bypassing cell tracing", () => {
    const geometry = buildEditedRoomGeometry(circleRoom("rotunda", { cx: 0, cy: 0, radius: 6 }), 64);
    expect(geometry.grounds).toHaveLength(1);
    expect(geometry.grounds[0].holes).toHaveLength(0);
    expect(geometry.paths).toHaveLength(1);
    expect(geometry.paths[0].kind).toBe("curve");
    expect(geometry.paths.some((path) => path.kind === "straight")).toBe(false);
    // The loop is closed explicitly so the last module meets the first.
    expect(geometry.paths[0].points.at(-1)).toEqual(geometry.paths[0].points[0]);
    expect(geometry.handles).toHaveLength(0);
    expect(geometry.radiusHandles).toHaveLength(4);
    expect(geometry.radiusHandles.every((handle) => handle.radius === 6 && handle.circleIndex === 0)).toBe(true);
  });

  it("turns an N-cell square drag into a radius of exactly N metres", () => {
    for (const side of [2, 3, 6, 12]) {
      const circle = circleFromDrag({ x: 0, y: 0 }, { x: side - 1, y: side - 1 });
      expect(circle.radius).toBe(side);
      // Centre sits at the middle of the dragged square, in world metres.
      expect(circle.cx).toBe((side / 2) * CELL_SIZE);
      expect(circle.cy).toBe((side / 2) * CELL_SIZE);
    }
  });

  it("locks the drag square and anchors it at the start cell in every direction", () => {
    expect(circleFromDrag({ x: 0, y: 0 }, { x: 5, y: 1 }).radius).toBe(6);
    const upLeft = circleFromDrag({ x: 0, y: 0 }, { x: -3, y: -1 });
    expect(upLeft.radius).toBe(4);
    // Anchored at start: the square spans cells -3..0, so its centre is at cell -1.
    expect(upLeft.cx).toBe(-1 * CELL_SIZE);
    expect(upLeft.cy).toBe(-1 * CELL_SIZE);
  });

  it("rejects drags below the minimum radius before they become a room", () => {
    expect(circleFromDrag({ x: 0, y: 0 }, { x: 0, y: 0 }).radius).toBeLessThan(MIN_CIRCLE_RADIUS);
    expect(circleFromDrag({ x: 0, y: 0 }, { x: 1, y: 1 }).radius).toBe(MIN_CIRCLE_RADIUS);
  });

  it("compresses wall modules to close the ring and never leaves a gap", () => {
    for (const radius of [2, 4, 6, 10]) {
      const circumference = 2 * Math.PI * radius;
      const modules = Math.ceil(circumference / CELL_SIZE);
      expect(circumference / modules).toBeLessThanOrEqual(CELL_SIZE);
      expect(circumference / modules).toBeGreaterThan(CELL_SIZE * 0.78);
    }
  });

  it("reports circle area from the polygon, not the cell count", () => {
    const rotunda = circleRoom("rotunda", { cx: 0, cy: 0, radius: 6 });
    const layout = buildLayout([], settings, [rotunda]);
    expect(layout.cells).toHaveLength(0);
    expect(layout.stats.area).toBeCloseTo(Math.PI * 36, 0);
    expect(layout.stats.connectedRooms).toBe(1);
    expect(layout.radiusHandles).toHaveLength(4);
    expect(layout.wallPaths).toHaveLength(1);
    expect(layout.wallPaths[0].kind).toBe("curve");
  });

  it("treats an erase rectangle that touches a circle as a hit", () => {
    const circle: CircleShape = { cx: 12, cy: 12, radius: 6 };
    // Cell (3,3) spans 6..8 m, whose nearest corner is 5.66 m from the centre.
    expect(circleIntersectsCellBounds(circle, { minX: 3, maxX: 3, minY: 3, maxY: 3 })).toBe(true);
    // Cell (0,0) spans 0..2 m, 14.1 m away.
    expect(circleIntersectsCellBounds(circle, { minX: 0, maxX: 0, minY: 0, maxY: 0 })).toBe(false);
    // A rectangle that swallows the circle whole still counts.
    expect(circleIntersectsCellBounds(circle, { minX: -5, maxX: 15, minY: -5, maxY: 15 })).toBe(true);
  });

  it("leaves rooms with no circles on the original code path", () => {
    const plain = room("plain", 0, 0, 4, 3);
    const geometry = buildEditedRoomGeometry(plain, 64);
    expect(geometry.radiusHandles).toHaveLength(0);
    expect(geometry.grounds).toHaveLength(1);
    expect(polygonArea(geometry.grounds[0].outer)).toBe(48);
    expect(geometry.paths.every((path) => path.kind === "straight")).toBe(true);
    const layout = buildLayout(plain.cells, settings, [plain]);
    expect(layout.stats.floorTiles).toBe(12);
    expect(layout.stats.area).toBe(48);
  });
});

/** Area of the polygon the builder would actually emit for this circle, not the ideal πr². */
function discArea(circle: CircleShape) {
  return polygonArea(circlePolygon(circle, circleSegments(circle.radius, 64)));
}

/**
 * The clipper works on a millimetre integer grid, which is what makes it immune to
 * coincident-edge failures. Unioned geometry is therefore exact to ~1 mm per vertex, not to
 * float precision, and an area can drift by roughly perimeter × 1 mm. These budgets say so
 * explicitly rather than hiding behind a `toBeCloseTo` digit count.
 */
const MM = 1e-3;
const AREA_SLACK = 0.05;

function mixedRoom(cells: Room["cells"], circles: CircleShape[]): Room {
  return {
    id: "mixed",
    cells,
    circles,
    style: { innerWallVariant: "A", outerWallVariant: "C" },
    cornerEdits: [],
  };
}

describe("merged rooms (boolean union)", () => {
  // Rect spans 0..8 x 0..6 m. The circle is centred on the middle of its right edge, so
  // exactly half the disc sticks out and the expected area is an exact half-disc.
  const rectCells = rectangleCells(0, 0, 4, 3);
  const edgeCircle: CircleShape = { cx: 8, cy: 3, radius: 2 };

  it("unions an overlapping circle and rectangle into one ring", () => {
    const geometry = buildEditedRoomGeometry(mixedRoom(rectCells, [edgeCircle]), 64);
    expect(geometry.grounds).toHaveLength(1);
    expect(geometry.grounds[0].holes).toHaveLength(0);
    expect(Math.abs(polygonArea(geometry.grounds[0].outer) - (48 + discArea(edgeCircle) / 2))).toBeLessThan(AREA_SLACK);
  });

  it("emits both curved and straight runs around the merged boundary", () => {
    const geometry = buildEditedRoomGeometry(mixedRoom(rectCells, [edgeCircle]), 64);
    expect(geometry.paths.some((path) => path.kind === "curve")).toBe(true);
    expect(geometry.paths.some((path) => path.kind === "straight")).toBe(true);
    // Every curved run must stay on the circle: an arc mis-tagged as straight would be
    // rebuilt as a chord, and a chord mis-tagged as an arc would bow outwards.
    for (const path of geometry.paths.filter((candidate) => candidate.kind === "curve")) {
      for (const point of path.points) {
        expect(Math.abs(Math.hypot(point.x - edgeCircle.cx, point.y - edgeCircle.cy) - edgeCircle.radius)).toBeLessThan(MM);
      }
    }
    expect(geometry.wallResizeHandles.length).toBeGreaterThan(0);
    expect(geometry.wallResizeHandles.every((handle) => handle.roomId === "mixed")).toBe(true);
  });

  it("never carries a straight run around a corner after a circle/square union", () => {
    const geometry = buildEditedRoomGeometry(mixedRoom(rectCells, [edgeCircle]), 64);
    for (const path of geometry.paths.filter((candidate) => candidate.kind === "straight")) {
      expect(path.points.length).toBeGreaterThanOrEqual(2);
      const start = path.points[0];
      const end = path.points[path.points.length - 1];
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      for (const point of path.points.slice(1, -1)) {
        const cross = dx * (point.y - start.y) - dy * (point.x - start.x);
        expect(Math.abs(cross)).toBeLessThan(MM);
      }
    }
  });

  it("places pillars at both circle/square merge junctions", () => {
    const room = mixedRoom(rectCells, [edgeCircle]);
    const geometry = buildEditedRoomGeometry(room, 64);
    const junctions = geometry.pillarAnchors.filter((anchor) => anchor.junction);
    expect(junctions).toHaveLength(2);
    expect(junctions.every((anchor) => Math.abs(Math.hypot(
      anchor.point.x - edgeCircle.cx,
      anchor.point.y - edgeCircle.cy,
    ) - edgeCircle.radius) < MM)).toBe(true);

    const layout = buildLayout(room.cells, settings, [room]);
    expect(layout.pillars.filter((pillar) => pillar.junction)).toHaveLength(2);
  });

  it("puts no wall through the junction", () => {
    const geometry = buildEditedRoomGeometry(mixedRoom(rectCells, [edgeCircle]), 64);
    // The Phase A failure mode was two separate wall runs meeting at the seam, which left
    // wall vertices inside the merged floor. After the union none may be strictly inside.
    for (const path of geometry.paths) {
      for (const point of path.points) {
        const insideCircle = Math.hypot(point.x - edgeCircle.cx, point.y - edgeCircle.cy) < edgeCircle.radius - MM;
        const insideRect = point.x > MM && point.x < 8 - MM && point.y > MM && point.y < 6 - MM;
        expect(insideCircle && insideRect).toBe(false);
      }
    }
  });

  it("keeps a courtyard as exactly one hole", () => {
    // 5x5 cells with the middle removed: outer 0..10 m, hole 4..6 m.
    const ring = rectangleCells(0, 0, 5, 5).filter((cell) => !(cell.x === 2 && cell.y === 2));
    const farCircle: CircleShape = { cx: 0, cy: 5, radius: 2 };
    const geometry = buildEditedRoomGeometry(mixedRoom(ring, [farCircle]), 64);
    expect(geometry.grounds).toHaveLength(1);
    expect(geometry.grounds[0].holes).toHaveLength(1);
    expect(polygonArea(geometry.grounds[0].holes[0])).toBeCloseTo(4, 6);
    const net = polygonArea(geometry.grounds[0].outer) - polygonArea(geometry.grounds[0].holes[0]);
    expect(Math.abs(net - (96 + discArea(farCircle) / 2))).toBeLessThan(AREA_SLACK);
  });

  it("merges two overlapping circles into one curved ring", () => {
    const pair: CircleShape[] = [{ cx: 0, cy: 0, radius: 3 }, { cx: 5, cy: 0, radius: 3 }];
    const geometry = buildEditedRoomGeometry(mixedRoom([], pair), 64);
    expect(geometry.grounds).toHaveLength(1);
    expect(geometry.paths.every((path) => path.kind === "curve")).toBe(true);
    // Two r=3 discs 5 m apart: 2*pi*9 minus a 2.25 m^2 lens.
    expect(polygonArea(geometry.grounds[0].outer)).toBeCloseTo(54.3, 0);
    expect(geometry.radiusHandles).toHaveLength(8);
  });

  it("drops a corner handle the circle swallowed but keeps the edit", () => {
    const swallowed = mixedRoom(rectCells, [{ cx: 0, cy: 0, radius: 3 }]);
    swallowed.cornerEdits.push({ vertexX: 0, vertexY: 0, insetCells: 1, shape: "diagonal", inverted: false });
    const geometry = buildEditedRoomGeometry(swallowed, 64);
    expect(geometry.handles.map((handle) => `${handle.vertexX},${handle.vertexY}`)).not.toContain("0,0");
    expect(geometry.handles).toHaveLength(3);
    // The edit survives in room state, so shrinking the circle brings the corner back.
    expect(swallowed.cornerEdits).toHaveLength(1);
  });

  it("keeps every radius handle pointing at its own circle", () => {
    // `resizeCircle` looks circles up by position in `room.circles`, so a handle's
    // circleIndex has to survive the union untouched or a drag resizes the wrong circle.
    const merged = mixedRoom(rectCells, [edgeCircle, { cx: 0, cy: 6, radius: 3 }]);
    const geometry = buildEditedRoomGeometry(merged, 64);
    expect(geometry.radiusHandles).toHaveLength(8);
    for (const handle of geometry.radiusHandles) {
      const source = merged.circles[handle.circleIndex];
      expect(source).toBeDefined();
      expect([handle.cx, handle.cy, handle.radius]).toEqual([source.cx, source.cy, source.radius]);
    }
    expect(new Set(geometry.radiusHandles.map((handle) => handle.circleIndex))).toEqual(new Set([0, 1]));
  });

  it("does not renumber circles when a degenerate one is skipped", () => {
    // A radius-0 circle contributes no geometry, but dropping it must not slide the
    // real circle down to index 0 — that is the off-by-one a plain map/filter invites.
    const merged = mixedRoom(rectCells, [{ cx: 0, cy: 0, radius: 0 }, edgeCircle]);
    const geometry = buildEditedRoomGeometry(merged, 64);
    expect(geometry.radiusHandles).toHaveLength(4);
    expect(geometry.radiusHandles.every((handle) => handle.circleIndex === 1)).toBe(true);
    expect(geometry.radiusHandles.every((handle) => handle.radius === edgeCircle.radius)).toBe(true);
  });

  it("rebuilds the union when one circle of a merged room is resized", () => {
    // The drag path: resizeCircle swaps one entry, then geometry is rebuilt from scratch.
    // Taller rect (0..8 x 0..10) so the disc still clears the top and bottom edges at the
    // grown radius — the part sticking out past x = 8 stays an exact half-disc either way.
    const tallCells = rectangleCells(0, 0, 4, 5);
    const seed: CircleShape = { cx: 8, cy: 5, radius: 2 };
    const grown: CircleShape = { ...seed, radius: 4 };
    const before = buildEditedRoomGeometry(mixedRoom(tallCells, [seed]), 64);
    const after = buildEditedRoomGeometry(mixedRoom(tallCells, [grown]), 64);
    expect(after.grounds).toHaveLength(1);
    expect(polygonArea(after.grounds[0].outer)).toBeGreaterThan(polygonArea(before.grounds[0].outer));
    expect(Math.abs(polygonArea(before.grounds[0].outer) - (80 + discArea(seed) / 2))).toBeLessThan(AREA_SLACK);
    expect(Math.abs(polygonArea(after.grounds[0].outer) - (80 + discArea(grown) / 2))).toBeLessThan(AREA_SLACK);
    expect(after.radiusHandles.every((handle) => handle.radius === 4 && handle.circleIndex === 0)).toBe(true);
  });

  it("counts a circle-bridged pair of halls as one zone", () => {
    // Two cell clusters that share no edge, joined only through the disc. Cell adjacency
    // alone reads this as two zones while the union renders one continuous footprint.
    const left = rectangleCells(-4, 1, 3, 1);
    const right = rectangleCells(2, -1, 2, 2);
    const bridged = mixedRoom([...left, ...right], [{ cx: 0, cy: 0, radius: 6 }]);
    const geometry = buildEditedRoomGeometry(bridged, 64);
    expect(geometry.grounds).toHaveLength(1);
    expect(buildLayout(bridged.cells, settings, [bridged]).stats.connectedRooms).toBe(1);
  });

  it("still separates parts that only touch", () => {
    // Tangency must not join: this circle sits flush against the cluster's left edge.
    const cells = rectangleCells(2, 0, 2, 2);
    const tangent = mixedRoom(cells, [{ cx: 2, cy: 2, radius: 2 }]);
    expect(buildLayout(tangent.cells, settings, [tangent]).stats.connectedRooms).toBe(2);
    // Two disjoint circles in one room are two zones, not one.
    const apart = mixedRoom([], [{ cx: 0, cy: 0, radius: 2 }, { cx: 20, cy: 0, radius: 2 }]);
    expect(buildLayout([], settings, [apart]).stats.connectedRooms).toBe(2);
  });

  it("counts overlapping floor once", () => {
    const merged = mixedRoom(rectCells, [edgeCircle]);
    const layout = buildLayout(merged.cells, settings, [merged]);
    const area = 48 + discArea(edgeCircle) / 2;
    expect(Math.abs(layout.stats.area - area)).toBeLessThan(AREA_SLACK);
    expect(layout.stats.floorTiles).toBe(Math.round(area / (CELL_SIZE * CELL_SIZE)));
    // The old per-part sum counted the submerged half of the disc as well.
    expect(layout.stats.floorTiles).toBeLessThan(12 + Math.round(discArea(edgeCircle) / 4));
  });
});

describe("merged square-room pillars", () => {
  it("places a pillar on every convex and concave corner of an overlapping square union", () => {
    // Two overlapping rectangles form an L outline with five convex corners and one
    // concave merge corner. All six direction changes need a pillar.
    const cells = normalizeCells([
      ...rectangleCells(0, 0, 4, 2),
      ...rectangleCells(0, 0, 2, 4),
    ]);
    const room = mixedRoom(cells, []);
    const geometry = buildEditedRoomGeometry(room, 64);
    expect(geometry.pillarAnchors).toHaveLength(6);
    expect(geometry.pillarAnchors.some((anchor) => anchor.point.x === 4 && anchor.point.y === 4)).toBe(true);
    expect(buildLayout(cells, settings, [room]).pillars).toHaveLength(6);
  });
});

describe("union overlap detection", () => {
  it("treats tangency as separate rooms, not one", () => {
    expect(circlesOverlap({ cx: 0, cy: 0, radius: 2 }, { cx: 3, cy: 0, radius: 2 })).toBe(true);
    expect(circlesOverlap({ cx: 0, cy: 0, radius: 2 }, { cx: 4, cy: 0, radius: 2 })).toBe(false);
    // Cell (3,1) spans 6..8 x 2..4 m. A circle centred on its edge overlaps it.
    expect(circleOverlapsCells({ cx: 8, cy: 3, radius: 2 }, [{ x: 3, y: 1 }])).toBe(true);
    // Moved right so it only just touches x = 8.
    expect(circleOverlapsCells({ cx: 10, cy: 3, radius: 2 }, [{ x: 3, y: 1 }])).toBe(false);
    expect(circleOverlapsCells({ cx: 8, cy: 3, radius: 2 }, [])).toBe(false);
  });
});

describe("clip wrapper", () => {
  it("hands consecutive runs a shared boundary vertex", () => {
    const square: TaggedPoint[] = [
      { x: 0, y: 0, tag: 1 }, { x: 8, y: 0, tag: 2 }, { x: 8, y: 6, tag: 3 }, { x: 0, y: 6, tag: 4 },
    ];
    const disc = circlePolygon({ cx: 8, cy: 3, radius: 2 }, 64).map((point) => ({ ...point, tag: 5 }));
    const rings = unionTagged([square, disc]);
    expect(rings).toHaveLength(1);
    expect(rings[0].outer).toBe(true);

    const runs = splitRuns(rings[0]);
    expect(runs.length).toBeGreaterThan(1);
    // A gap here would show up in the viewport as a hairline seam between wall runs.
    runs.forEach((run, index) => {
      const next = runs[(index + 1) % runs.length];
      expect(run.points.at(-1)!.x).toBeCloseTo(next.points[0].x, 9);
      expect(run.points.at(-1)!.y).toBeCloseTo(next.points[0].y, 9);
    });
    expect(runs.some((run) => run.tag === 5)).toBe(true);
  });

  it("reports holes clockwise so the signed-area convention still holds", () => {
    const outer: TaggedPoint[] = [
      { x: 0, y: 0, tag: 1 }, { x: 6, y: 0, tag: 1 }, { x: 6, y: 6, tag: 1 }, { x: 0, y: 6, tag: 1 },
    ];
    const hole: TaggedPoint[] = [
      { x: 2, y: 2, tag: 2 }, { x: 2, y: 4, tag: 2 }, { x: 4, y: 4, tag: 2 }, { x: 4, y: 2, tag: 2 },
    ];
    const rings = unionTagged([outer, hole]);
    expect(rings).toHaveLength(2);
    expect(rings[0].outer).toBe(true);
    expect(rings[1].outer).toBe(false);
    expect(signedArea(rings[1].points)).toBeCloseTo(-4, 6);
  });
});
