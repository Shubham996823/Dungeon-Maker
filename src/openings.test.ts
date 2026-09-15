import { describe, expect, it } from "vitest";
import {
  canonicalOpeningRotation,
  openingAllowedOnWall,
  openingForWall,
  openingTargetForWall,
  openingTransformForWall,
  moveOpeningsWithWalls,
  sharedWindowIds,
} from "./openings";
import type { BuildSettings, WallOpening, WallSegment } from "./types";

const settings = { innerWallOffset: 0.15, flipInnerWall: true } as BuildSettings;

function sharedWall(overrides: Partial<WallSegment> = {}): WallSegment {
  return {
    x: 0,
    y: 0,
    length: 2,
    rotation: 0,
    side: "S",
    variant: "A",
    roomId: "room-b",
    opposingRoomId: "room-a",
    ...overrides,
  };
}

describe("shared wall openings", () => {
  it("allows doors but rejects windows", () => {
    const wall = sharedWall();
    expect(openingAllowedOnWall("WD_1", wall)).toBe(false);
    expect(openingAllowedOnWall("DR_2.5x1.5_1", wall)).toBe(true);
    expect(openingAllowedOnWall("DR_2.5x2_1", wall)).toBe(true);
  });

  it("uses a stable owner and tangent for either direction of the same shared wall", () => {
    const forward = sharedWall();
    const reverse = sharedWall({ x: 2, rotation: Math.PI, roomId: "room-a", opposingRoomId: "room-b" });
    const forwardTarget = openingTargetForWall(forward);
    const reverseTarget = openingTargetForWall(reverse);
    expect(forwardTarget?.roomId).toBe("room-a");
    expect(reverseTarget?.roomId).toBe("room-a");
    expect(reverseTarget?.cx).toBeCloseTo(forwardTarget!.cx, 8);
    expect(reverseTarget?.cy).toBeCloseTo(forwardTarget!.cy, 8);
    expect(reverseTarget?.rotation).toBe(forwardTarget?.rotation);
    expect(canonicalOpeningRotation(Math.PI)).toBe(0);
  });

  it("centres a shared door between both wall layers without ownership jitter", () => {
    const forward = openingTransformForWall(sharedWall(), settings);
    const reverse = openingTransformForWall(sharedWall({ x: 2, rotation: Math.PI }), settings);
    expect(forward.x).toBeCloseTo(1, 8);
    expect(forward.y).toBeCloseTo(0, 8);
    expect(reverse.x).toBeCloseTo(forward.x, 8);
    expect(reverse.y).toBeCloseTo(forward.y, 8);
    expect(reverse.rotation).toBe(forward.rotation);
  });

  it("identifies existing windows that become part of a shared wall", () => {
    const openings: WallOpening[] = [
      { id: "window", roomId: "room-a", asset: "WD_2", cx: 1, cy: 0, rotation: 0 },
      { id: "door", roomId: "room-a", asset: "DR_2.5x1.5_1", cx: 1, cy: 0, rotation: 0 },
    ];
    expect([...sharedWindowIds(openings, [sharedWall()])]).toEqual(["window"]);
  });

  it("moves an opening with a resized wall boundary", () => {
    const door: WallOpening = {
      id: "door",
      roomId: "room-a",
      asset: "DR_2.5x1.5_1",
      cx: 2,
      cy: 0,
      rotation: 0,
    };
    const moved = moveOpeningsWithWalls([door], [{
      handle: {
        roomId: "room-a",
        start: { x: 0, y: 0 },
        end: { x: 4, y: 0 },
        outwardX: 0,
        outwardY: -1,
      },
      steps: 1,
    }], 2);
    expect(moved[0].cx).toBe(2);
    expect(moved[0].cy).toBe(-2);
  });

  it("targets and matches openings on a standalone manual wall module", () => {
    const wall = sharedWall({ roomId: undefined, opposingRoomId: undefined, manualWallId: "single-wall", manualWallModuleIndex: 0 });
    const target = openingTargetForWall(wall);
    expect(target).toMatchObject({ manualWallId: "single-wall", cx: 1, cy: 0, shared: false });
    const opening: WallOpening = {
      id: "standalone-window",
      roomId: "manual-single-wall",
      manualWallId: "single-wall",
      asset: "WD_1",
      cx: 1,
      cy: 0,
      rotation: 0,
    };
    expect(openingForWall([opening], wall)).toBe(opening);
  });
});
