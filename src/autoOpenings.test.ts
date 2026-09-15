import { describe, expect, it } from "vitest";
import { reconcileAutoOpenings } from "./autoOpenings";
import { buildLayout, rectangleCells } from "./layout";
import { openingMatchesWall } from "./openings";
import type { BuildSettings, Room, TerrainRegion } from "./types";
const settings = { floorVariant: "A", wallVariant: "A", innerWallVariant: "A", outerWallVariant: "A", innerWallOffset: 0, outerWallOffset: 0, curveQuality: 64, randomSeed: 1, pillarInset: 0.3 } as BuildSettings;
const room = (id: string, x = 0): Room => ({ id, cells: rectangleCells(x, 0, x + 4, 4), circles: [], cornerEdits: [], openings: [], style: { innerWallVariant: "A", outerWallVariant: "A" }, autoOpenings: true });
const run = (rooms: Room[], regions: TerrainRegion[] = []) => reconcileAutoOpenings(rooms.flatMap(r => r.cells), rooms, settings, [], [], [], [], regions);
describe("automatic room openings", () => {
  it("creates a door and windows and is deterministic", () => {
    const result = run([room("a")]);
    expect(result[0].openings.some(o => o.asset.startsWith("DR"))).toBe(true);
    expect(result[0].openings.some(o => o.asset.startsWith("WD"))).toBe(true);
    expect(run(result)).toEqual(result);
  });
  it("reconciles movement and shared walls without shared windows", () => {
    const initial = run([room("a")]);
    const moved = run([{ ...initial[0], cells: room("a", 5).cells }]);
    expect(moved[0].openings.every(o => o.cx >= 10)).toBe(true);
    const joined = run([room("a"), room("b", 4)]);
    const layout = buildLayout(joined.flatMap(r => r.cells), settings, joined);
    const shared = layout.walls.filter(w => w.opposingRoomId);
    expect(layout.openings.some(o => o.asset.startsWith("DR") && shared.some(w => openingMatchesWall(o,w)))).toBe(true);
    expect(layout.openings.some(o => o.asset.startsWith("WD") && shared.some(w => openingMatchesWall(o,w)))).toBe(false);
  });
  it("preserves overrides and suppressed slots", () => {
    const initial = run([room("a")])[0];
    const chosen = { ...initial.openings[0], automatic: false, suppressed: true };
    const result = run([{ ...initial, openings: [chosen, ...initial.openings.slice(1)] }])[0];
    expect(result.openings).toContainEqual(chosen);
    expect(result.openings.filter(o => o.cx === chosen.cx && o.cy === chosen.cy)).toHaveLength(1);
  });
  it("does not create buried openings", () => {
    const hill: TerrainRegion = { id: "hill", controlPoints: [{x:-20,y:-20},{x:20,y:-20},{x:20,y:20},{x:-20,y:20}], height: 5, mode: "raise", edgeProfile: "cliff", slopeWidth: 1 };
    expect(run([room("a")], [hill])[0].openings).toHaveLength(0);
    const connected = run([room("a"), room("b", 4)], [hill]);
    const layout = buildLayout(connected.flatMap(r => r.cells), settings, connected);
    for (const current of connected) {
      expect(layout.walls.some(w => w.opposingRoomId && (w.roomId === current.id || w.opposingRoomId === current.id)
        && layout.openings.some(o => o.asset.startsWith("DR") && openingMatchesWall(o, w)))).toBe(true);
    }
  });
});
