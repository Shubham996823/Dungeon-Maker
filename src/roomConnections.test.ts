import { describe, expect, it } from "vitest";
import { buildConnectionGeometry, suggestRoomConnections, planRoomConnection } from "./roomConnections";
import { buildLayout } from "./layout";
import type { Room, BuildSettings } from "./types";

const makeRoom = (id: string, elevationSteps: number, x: number): Room => ({
  id, elevationSteps, cells: [{ x: x / 2, y: 0 }], circles: [], cornerEdits: [],
  style: { innerWallVariant: "A", outerWallVariant: "A" },
  openings: [{ id: `${id}-door`, roomId: id, asset: "DR_2.5x2_1", cx: x, cy: 1, rotation: Math.PI / 2 }],
});

describe("automatic room connections", () => {
  it("plans new doors without changing the original rooms", () => {
    const rooms=[{...makeRoom("a",0,0),openings:[]},{...makeRoom("b",10,12),openings:[]}];
    const settings={floorVariant:"A",wallVariant:"A",innerWallVariant:"A",outerWallVariant:"A",innerWallOffset:0,outerWallOffset:0,curveQuality:64} as BuildSettings;
    const layout=buildLayout(rooms.flatMap(r=>r.cells),settings,rooms);
    const planned=planRoomConnection("a","b",rooms,layout)!;
    expect(planned).not.toBeNull();
    expect(planned.rooms.every(r=>r.openings.length===1)).toBe(true);
    expect(rooms.every(r=>r.openings.length===0)).toBe(true);
    expect(planned.geometry.stairFlights).toHaveLength(2);
  });
  it("pairs the nearest doors on each adjacent selected level", () => {
    const rooms = [makeRoom("low", 0, 0), makeRoom("high", 10, 8)];
    const suggestions = suggestRoomConnections(rooms);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({ fromRoomId: "low", toRoomId: "high", fromOpeningId: "low-door", toOpeningId: "high-door" });
  });

  it("uses two 1.25 m flights for one 2.5 m storey and adds a floor bridge", () => {
    const rooms = [makeRoom("low", 0, 0), makeRoom("high", 10, 8)];
    const connection = suggestRoomConnections(rooms)[0];
    const geometry = buildConnectionGeometry(connection, rooms)!;
    expect(geometry.stairFlights.map((flight) => flight.elevation)).toEqual([0, 1.25]);
    expect(geometry.floorTiles.length).toBeGreaterThan(1);
    expect(geometry.floorTiles.some((tile) => tile.elevation === 2.5)).toBe(true);
    expect(geometry.floorTiles.some((tile) => tile.elevation === 0)).toBe(true);
    const [first,second]=geometry.stairFlights;
    const uphill={x:-Math.sin(first.rotation),y:Math.cos(first.rotation)};
    expect(second.point.x-first.point.x).toBeCloseTo(uphill.x*1.25);
    expect(second.point.y-first.point.y).toBeCloseTo(uphill.y*1.25);
    expect(second.elevation-first.elevation).toBeCloseTo(1.25);
    // Adjacent flight ends touch; the upper landing starts at the final top edge.
    const top={x:second.point.x+uphill.x*0.625,y:second.point.y+uphill.y*0.625};
    expect(geometry.floorTiles.some(t=>t.elevation===2.5 && Math.abs(t.point.x-(top.x+uphill.x))<1e-5 && Math.abs(t.point.y-(top.y+uphill.y))<1e-5)).toBe(true);
  });

  it("does not suggest a connection when either level has no door", () => {
    const upper = { ...makeRoom("high", 10, 8), openings: [] };
    expect(suggestRoomConnections([makeRoom("low", 0, 0), upper])).toEqual([]);
  });
  it("builds a flat route without stairs and preserves a saved bend", () => {
    const rooms=[makeRoom("a",0,0),makeRoom("b",0,12)];
    const connection={id:"route",fromRoomId:"a",toRoomId:"b",fromOpeningId:"a-door",toOpeningId:"b-door",bendOffset:{x:6,y:6}};
    const geometry=buildConnectionGeometry(JSON.parse(JSON.stringify(connection)),rooms)!;
    expect(geometry.stairFlights).toHaveLength(0);
    expect(geometry.handle).toEqual({x:6,y:7});
    expect(geometry.floorTiles.every(t=>t.elevation===0)).toBe(true);
    const moved=rooms.map(r=>({...r,cells:r.cells.map(c=>({...c,x:c.x+2})),openings:r.openings.map(o=>({...o,cx:o.cx+4}))}));
    expect(buildConnectionGeometry(connection,moved)!.handle).toEqual({x:10,y:7});
  });
  it("rejects unsupported rises instead of rounding stair height", () => {
    const rooms=[makeRoom("a",0,0),makeRoom("b",3,12)];
    const connection={id:"route",fromRoomId:"a",toRoomId:"b",fromOpeningId:"a-door",toOpeningId:"b-door"};
    expect(buildConnectionGeometry(connection,rooms)).toBeNull();
  });
});
