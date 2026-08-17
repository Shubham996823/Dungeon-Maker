import { describe, expect, it } from "vitest";
import { cellCenterToWorld, planYToWorldZ, worldPointToCell } from "./coordinates";
import { buildLayout, rectangleCells } from "./layout";
import type { BuildSettings } from "./types";

const settings: BuildSettings = {
  floorVariant: "A",
  wallVariant: "A",
  cornerVariant: "A",
  pillarVariant: "A",
  randomizeWalls: false,
  randomSeed: 1,
  addPillars: false,
  pillarInset: 0.3,
};

describe("buildLayout", () => {
  it("builds a rectangle with reserved modular corners", () => {
    const layout = buildLayout(rectangleCells(0, 0, 4, 3), settings);
    expect(layout.stats.floorTiles).toBe(12);
    expect(layout.stats.area).toBe(48);
    expect(layout.stats.perimeter).toBe(28);
    expect(layout.stats.straightWallLength).toBe(20);
    expect(layout.stats.wallModules).toBe(6);
    expect(layout.stats.cornerModules).toBe(4);
  });

  it("uses only corner arms around a single cell", () => {
    const layout = buildLayout([{ x: 0, y: 0 }], settings);
    expect(layout.walls).toHaveLength(0);
    expect(layout.corners).toHaveLength(4);
    expect(layout.stats.perimeter).toBe(8);
  });

  it("creates one metre modules at a concave join", () => {
    const layout = buildLayout(
      [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }],
      settings,
    );
    expect(layout.walls.some((wall) => wall.length === 1)).toBe(true);
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
