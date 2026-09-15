import { describe, expect, it } from "vitest";
import { floorIdInCellBounds, snapPillarPoint, stairOpeningsAtElevation } from "./components/ThreeViewport";
import type { FloorGround, StairPlacement } from "./types";

const floor = (floorId: string, minX: number, minY: number, maxX: number, maxY: number, elevation = 0): FloorGround => ({
  floorId,
  roomId: floorId,
  variant: "1",
  elevation,
  outer: [
    { x: minX * 2, y: minY * 2 },
    { x: maxX * 2, y: minY * 2 },
    { x: maxX * 2, y: maxY * 2 },
    { x: minX * 2, y: maxY * 2 },
  ],
  holes: [],
});

describe("floor marquee selection", () => {
  it("selects the floor covering the most cells in the dragged bounds", () => {
    const floors = [floor("small", 0, 0, 1, 1), floor("large", 1, 0, 4, 2)];
    expect(floorIdInCellBounds(floors, { minX: 0, minY: 0, maxX: 3, maxY: 1 })).toBe("large");
  });

  it("uses the floor under the initial press to break an equal-coverage tie", () => {
    const floors = [floor("left", 0, 0, 1, 1), floor("right", 1, 0, 2, 1)];
    expect(floorIdInCellBounds(floors, { minX: 0, minY: 0, maxX: 1, maxY: 0 }, "right")).toBe("right");
  });

  it("clears the selection when the marquee misses every floor", () => {
    expect(floorIdInCellBounds([floor("floor", 0, 0, 1, 1)], { minX: 3, minY: 3, maxX: 4, maxY: 4 })).toBeNull();
  });
});

describe("stair floor openings", () => {
  const stair: StairPlacement = { id: "stair", cell: { x: 2, y: 3 }, elevationSteps: 0, rotation: 0, asset: "ST_2.5x2_1" };

  it("cuts one 2 m grid cell from the floor one storey above", () => {
    expect(stairOpeningsAtElevation([stair], 2.5)).toEqual([[
      { x: 4, y: 6 },
      { x: 6, y: 6 },
      { x: 6, y: 8 },
      { x: 4, y: 8 },
    ]]);
  });

  it("does not cut the stair's starting floor or unrelated levels", () => {
    expect(stairOpeningsAtElevation([stair], 0)).toEqual([]);
    expect(stairOpeningsAtElevation([stair], 5)).toEqual([]);
  });

  it("cuts a 4 m square opening for the ST_2.5x4_1 stair", () => {
    const wideStair: StairPlacement = { ...stair, asset: "ST_2.5x4_1" };
    expect(stairOpeningsAtElevation([wideStair], 2.5)).toEqual([[
      { x: 4, y: 6 },
      { x: 8, y: 6 },
      { x: 8, y: 10 },
      { x: 4, y: 10 },
    ]]);
  });
});

describe("individual pillar snapping", () => {
  it("snaps near a grid crossing to the crossing", () => {
    expect(snapPillarPoint({ x: 4.15, y: 5.9 })).toEqual({ x: 4, y: 6 });
  });

  it("snaps inside a cell to its centre", () => {
    expect(snapPillarPoint({ x: 5.1, y: 7.05 })).toEqual({ x: 5, y: 7 });
  });
});
