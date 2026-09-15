import {describe,it,expect} from "vitest";
import {pathwayGeometry,resolvePathPoints,insertPathPoint,deletePathPoint} from "./pathways";
import type {RoomConnection,Room} from "./types";
const connection:RoomConnection={id:"path",fromRoomId:"a",fromOpeningId:"door",toRoomId:"",toOpeningId:"",pathOrigin:{x:0,y:0,elevation:0},pathPoints:[{x:0,y:0,elevation:0},{x:8,y:0,elevation:0},{x:8,y:8,elevation:0}]};
describe("editable pathways",()=>{
  it("builds flat segments without stairs",()=>{
    const g=pathwayGeometry(connection.pathPoints!);expect(g.invalidSegments).toEqual([]);expect(g.stairFlights).toEqual([]);expect(g.floorTiles).toHaveLength(9);
  });
  it("fills both left and right corners with a landing without overlapping strips",()=>{
    for(const direction of [-1,1]) {
      const g=pathwayGeometry([{x:0,y:0,elevation:0},{x:8,y:0,elevation:0},{x:8,y:8*direction,elevation:0}]);
      const landing=g.floorTiles.filter(t=>t.point.x===8&&t.point.y===0);
      expect(landing).toHaveLength(1);expect(landing[0].length).toBe(2);
      for(const tile of g.floorTiles.filter(t=>t!==landing[0])) {
        if(tile.segmentIndex===0)expect(tile.point.x+tile.length!/2).toBeLessThanOrEqual(7);
        else expect(Math.abs(tile.point.y)-tile.length!/2).toBeGreaterThanOrEqual(1);
      }
    }
  });
  it("does not rebuild a corner landing across an intentional break",()=>{
    const g=pathwayGeometry(connection.pathPoints!,[1]);
    expect(g.floorTiles.some(t=>t.point.x===8&&t.point.y===0)).toBe(false);
  });
  it("fits uphill and downhill flights with landing clearance",()=>{
    for(const heights of [[0,2.5],[2.5,0]]) {
      const g=pathwayGeometry([{x:0,y:0,elevation:heights[0]},{x:8,y:0,elevation:heights[1]}]);
      expect(g.invalidSegments).toEqual([]);expect(g.stairFlights).toHaveLength(2);
      expect(g.stairFlights.map(s=>s.elevation)).toEqual([0,1.25]);
      expect(g.floorTiles.some(t=>t.elevation===0)).toBe(true);expect(g.floorTiles.some(t=>t.elevation===2.5)).toBe(true);
    }
  });
  it("rejects short and unsupported stair rises",()=>{
    expect(pathwayGeometry([{x:0,y:0,elevation:0},{x:2,y:0,elevation:2.5}]).invalidSegments).toEqual([0]);
    expect(pathwayGeometry([{x:0,y:0,elevation:0},{x:8,y:0,elevation:0.6}]).invalidSegments).toEqual([0]);
  });
  it("breaks only the selected segment and retains gaps when inserting points",()=>{
    const broken={...connection,brokenSegments:[0]};
    expect(pathwayGeometry(broken.pathPoints!,broken.brokenSegments).floorTiles.every(t=>t.segmentIndex===1)).toBe(true);
    const inserted=insertPathPoint(broken,0);expect(inserted.brokenSegments).toEqual([0,1]);expect(inserted.pathPoints).toHaveLength(4);
    const removed=deletePathPoint(inserted,1);expect(removed.pathPoints).toEqual(connection.pathPoints);expect(removed.brokenSegments).toEqual([0]);
  });
  it("follows the source room and preserves saved open endpoints",()=>{
    const room={id:"a",elevationSteps:10,openings:[{id:"door",cx:4,cy:2}]} as Room;
    const restored=JSON.parse(JSON.stringify(connection));
    expect(resolvePathPoints(restored,[room])).toEqual([{x:4,y:2,elevation:2.5},{x:12,y:2,elevation:2.5},{x:12,y:10,elevation:2.5}]);
  });
  it("keeps the destination endpoint attached independently",()=>{
    const target={id:"b",elevationSteps:20,openings:[{id:"end",cx:20,cy:10}]} as Room;
    expect(resolvePathPoints({...connection,toRoomId:"b",toOpeningId:"end"},[target]).at(-1)).toEqual({x:20,y:10,elevation:5});
  });
});
