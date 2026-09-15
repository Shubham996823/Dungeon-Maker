import { describe, expect, it } from "vitest";
import { foundationForRoom, buildingLevelForRoom, foundationHeightForRoom } from "./buildingFoundation";
import { onGridLevel, visibleAtOrBelowGridLevel } from "./gridLevels";
import { protectRoomTerrain } from "./terrainProtection";
import type { Room, RoomGround, TerrainRegion } from "./types";

const room: Room = { id: "test", cells: [{ x: 0, y: 0 }], circles: [], style: { innerWallVariant: "A", outerWallVariant: "A" }, cornerEdits: [], openings: [] };
const ground: RoomGround = { roomId: room.id, outer: [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 2 }], holes: [], elevation: 0 };
describe("building-relative levels and foundations", () => {
  it("anchors a building on terrain and keeps upper levels exactly 2.5 m apart", () => {
    const region: TerrainRegion = { id: "hill", controlPoints: [{ x: -10, y: -10 }, { x: 10, y: -10 }, { x: 10, y: 10 }, { x: -10, y: 10 }], mode: "raise", height: 3.2, edgeProfile: "cliff", slopeWidth: 1 };
    const base = foundationForRoom(room, [], [region]);
    expect(base).toBe(3.2);
    const upper = { ...room, buildingId: "building", foundationHeight: base, elevationSteps: (base + 2.5) * 4 };
    expect(buildingLevelForRoom(upper)).toBe(1);
    expect(onGridLevel(upper.elevationSteps, 1, base)).toBe(true);
    expect(onGridLevel(upper.elevationSteps, 1, 0)).toBe(false);
    expect(visibleAtOrBelowGridLevel(upper.elevationSteps, 0, base)).toBe(false);
    expect(visibleAtOrBelowGridLevel(upper.elevationSteps, 1, base)).toBe(true);
    expect(JSON.parse(JSON.stringify(upper)).elevationSteps * 0.25).toBe(5.7);
  });
  it("keeps legacy room elevations and handles a quarter-metre offset", () => {
    expect(foundationForRoom(room, [], [])).toBe(0);
    const legacy = { ...room, elevationSteps: 21 };
    expect(foundationHeightForRoom(legacy)).toBe(0.25);
    expect(buildingLevelForRoom(legacy)).toBe(2);
  });
  it("protects existing floors without lifting low terrain or changing the source", () => {
    expect(protectRoomTerrain(5, { x: 1, y: 1 }, [ground])).toBeCloseTo(-0.16);
    expect(protectRoomTerrain(-2, { x: 1, y: 1 }, [ground])).toBe(-2);
    expect(protectRoomTerrain(5, { x: 4, y: 1 }, [ground])).toBe(5);
    expect(protectRoomTerrain(5, { x: 1, y: 1 }, [])).toBe(5);
    expect(protectRoomTerrain(0, { x: 1, y: 1 }, [{ ...ground, elevation: 5 }])).toBe(0);
  });
});
