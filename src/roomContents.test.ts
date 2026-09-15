import { describe, expect, it } from "vitest";
import { moveContainedRoomObjects } from "./roomContents";
import type { Room } from "./types";

const room: Room = {
  id: "room-a",
  cells: [{ x: 0, y: 0 }, { x: 1, y: 0 }],
  circles: [],
  style: { innerWallVariant: "A", outerWallVariant: "A" },
  cornerEdits: [],
  openings: [],
  elevationSteps: 0,
};

describe("moving room contents", () => {
  it("moves contained stairs, pillars, floors, and walls while leaving outside objects", () => {
    const moved = moveContainedRoomObjects(
      [room], new Set([room.id]), 2, -1,
      [{ id: "wall-in", start: { x: 0.5, y: 1 }, end: { x: 3.5, y: 1 }, openings: [], elevationSteps: 0 }, { id: "wall-out", start: { x: 8, y: 8 }, end: { x: 10, y: 8 }, openings: [], elevationSteps: 0 }],
      [{ id: "floor-in", cells: [{ x: 0, y: 0 }], cornerEdits: [], elevationSteps: 0, variant: "1" }],
      [{ id: "stair-in", cell: { x: 0, y: 0 }, elevationSteps: 0, rotation: 0, asset: "ST_2.5x2_1" }, { id: "stair-out", cell: { x: 8, y: 8 }, elevationSteps: 0, rotation: 0, asset: "ST_2.5x2_1" }],
      [{ id: "pillar-in", point: { x: 2, y: 1 }, elevationSteps: 0, variant: "A" }, { id: "pillar-out", point: { x: 9, y: 9 }, elevationSteps: 0, variant: "A" }],
    );
    expect(moved.manualWalls[0].start).toEqual({ x: 4.5, y: -1 });
    expect(moved.manualWalls[1].start).toEqual({ x: 8, y: 8 });
    expect(moved.floors[0].cells).toEqual([{ x: 2, y: -1 }]);
    expect(moved.stairs[0].cell).toEqual({ x: 2, y: -1 });
    expect(moved.stairs[1].cell).toEqual({ x: 8, y: 8 });
    expect(moved.pillars[0].point).toEqual({ x: 6, y: -1 });
    expect(moved.pillars[1].point).toEqual({ x: 9, y: 9 });
  });

  it("does not move an object on another grid level", () => {
    const moved = moveContainedRoomObjects([room], new Set([room.id]), 1, 0, [], [], [{ id: "upper", cell: { x: 0, y: 0 }, elevationSteps: 10, rotation: 0, asset: "ST_2.5x2_1" }], []);
    expect(moved.stairs[0].cell).toEqual({ x: 0, y: 0 });
  });
});
