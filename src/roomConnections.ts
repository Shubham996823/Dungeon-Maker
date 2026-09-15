import { CELL_SIZE, ROOM_ELEVATION_STEP } from "./layout";
import { openingIsWindow } from "./moduleAssets";
import { roomContainsPoint } from "./roomContents";
import { wallModuleCenter } from "./openings";
import { pathwayGeometry, resolvePathPoints } from "./pathways";
import type { GeneratedLayout, PlanPoint, Room, RoomConnection, WallOpening } from "./types";

export interface ConnectionGeometry {
  handle?: PlanPoint;
  stairFlights: Array<{ point: PlanPoint; elevation: number; rotation: number; segmentIndex?:number }>;
  floorTiles: Array<{ point: PlanPoint; elevation: number; rotation?:number; length?:number; segmentIndex?:number }>;
}

const elevationSteps = (room: Room) => room.elevationSteps ?? 0;
const doors = (room: Room) => room.openings.filter((opening) => !opening.suppressed && !openingIsWindow(opening.asset));

export function suggestRoomConnections(selectedRooms: Room[]): RoomConnection[] {
  const levels = [...new Set(selectedRooms.map(elevationSteps))].sort((a, b) => a - b);
  const connections: RoomConnection[] = [];
  for (let index = 0; index < levels.length - 1; index += 1) {
    const lowerRooms = selectedRooms.filter((room) => elevationSteps(room) === levels[index]);
    const upperRooms = selectedRooms.filter((room) => elevationSteps(room) === levels[index + 1]);
    let best: { lower: Room; upper: Room; lowerDoor: WallOpening; upperDoor: WallOpening; distance: number } | null = null;
    for (const lower of lowerRooms) for (const upper of upperRooms) {
      for (const lowerDoor of doors(lower)) for (const upperDoor of doors(upper)) {
        const distance = Math.hypot(upperDoor.cx - lowerDoor.cx, upperDoor.cy - lowerDoor.cy);
        if (!best || distance < best.distance) best = { lower, upper, lowerDoor, upperDoor, distance };
      }
    }
    if (!best) continue;
    connections.push({
      id: `connection-${best.lower.id}-${best.upper.id}-${best.lowerDoor.id}-${best.upperDoor.id}`,
      fromRoomId: best.lower.id,
      toRoomId: best.upper.id,
      fromOpeningId: best.lowerDoor.id,
      toOpeningId: best.upperDoor.id,
    });
  }
  return connections;
}

function outsideNormal(room: Room, opening: WallOpening): PlanPoint {
  const first = { x: -Math.sin(opening.rotation), y: Math.cos(opening.rotation) };
  const sample = { x: opening.cx + first.x * 0.35, y: opening.cy + first.y * 0.35 };
  return roomContainsPoint(room, sample) ? { x: -first.x, y: -first.y } : first;
}

function sampleSegment(start: PlanPoint, end: PlanPoint, spacing: number) {
  const distance = Math.hypot(end.x - start.x, end.y - start.y);
  const count = Math.max(1, Math.ceil(distance / spacing));
  return Array.from({ length: count + 1 }, (_, index) => ({
    x: start.x + (end.x - start.x) * index / count,
    y: start.y + (end.y - start.y) * index / count,
  }));
}

export function buildConnectionGeometry(connection: RoomConnection, rooms: Room[]): ConnectionGeometry | null {
  if(connection.pathPoints) return pathwayGeometry(resolvePathPoints(connection,rooms),connection.brokenSegments);
  const fromRoom = rooms.find((room) => room.id === connection.fromRoomId);
  const toRoom = rooms.find((room) => room.id === connection.toRoomId);
  if (!fromRoom || !toRoom) return null;
  const fromOpening = fromRoom.openings.find((opening) => opening.id === connection.fromOpeningId);
  const toOpening = toRoom.openings.find((opening) => opening.id === connection.toOpeningId);
  if (!fromOpening || !toOpening) return null;
  const lowerRoom = elevationSteps(fromRoom) <= elevationSteps(toRoom) ? fromRoom : toRoom;
  const upperRoom = lowerRoom === fromRoom ? toRoom : fromRoom;
  const lowerDoor = lowerRoom === fromRoom ? fromOpening : toOpening;
  const upperDoor = lowerRoom === fromRoom ? toOpening : fromOpening;
  const lowerElevation = elevationSteps(lowerRoom) * ROOM_ELEVATION_STEP;
  const upperElevation = elevationSteps(upperRoom) * ROOM_ELEVATION_STEP;
  if (Math.abs(upperElevation-lowerElevation)<0.001 && Math.hypot(lowerDoor.cx-upperDoor.cx,lowerDoor.cy-upperDoor.cy)<0.01) return {stairFlights:[],floorTiles:[]};
  const rise = (upperElevation - lowerElevation) / 1.25;
  if (Math.abs(rise - Math.round(rise)) > 0.001) return null;
  const flightCount = Math.round(rise);
  const outward = outsideNormal(lowerRoom, lowerDoor);
  // ST_1.25x1_1: 1 m wide, 1.25 m run/rise, climbs toward local -Z (plan +Y).
  const run = 1.25;
  const rotation = Math.atan2(outward.y, outward.x) - Math.PI / 2;
  const stairFlights = Array.from({ length: flightCount }, (_, index) => ({
    point: { x: lowerDoor.cx + outward.x * (2 + (index + 0.5) * run), y: lowerDoor.cy + outward.y * (2 + (index + 0.5) * run) },
    elevation: lowerElevation + index * 1.25,
    rotation,
  }));
  const landing = { x: lowerDoor.cx + outward.x * (flightCount * run + 3), y: lowerDoor.cy + outward.y * (flightCount * run + 3) };
  const elbow = Math.abs(upperDoor.cx - landing.x) >= Math.abs(upperDoor.cy - landing.y)
    ? { x: upperDoor.cx, y: landing.y }
    : { x: landing.x, y: upperDoor.cy };
  const upperDoorPoint = { x: upperDoor.cx, y: upperDoor.cy };
  const handle = connection.bendOffset ? { x: fromOpening.cx + connection.bendOffset.x, y: fromOpening.cy + connection.bendOffset.y } : elbow;
  const upperNormal = outsideNormal(upperRoom, upperDoor);
  const approach = { x: upperDoor.cx + upperNormal.x, y: upperDoor.cy + upperNormal.y };
  const route = [landing, { x: handle.x, y: landing.y }, handle, { x: approach.x, y: handle.y }, approach, upperDoorPoint];
  const sampled = route.slice(1).flatMap((p, i) => sampleSegment(route[i], p, CELL_SIZE).slice(i ? 1 : 0));
  const floorTiles = sampled.filter((point, index) => index === 0 || Math.hypot(point.x - sampled[index - 1].x, point.y - sampled[index - 1].y) > 0.2)
    .map((point) => ({ point, elevation: upperElevation }));
  if (flightCount) floorTiles.push({ point: { x: lowerDoor.cx + outward.x, y: lowerDoor.cy + outward.y }, elevation: lowerElevation });
  else floorTiles.push(...sampleSegment({x:lowerDoor.cx+outward.x,y:lowerDoor.cy+outward.y},landing,CELL_SIZE).map(point=>({point,elevation:lowerElevation})));
  const seen = new Set<string>();
  const uniqueTiles = floorTiles.filter(t=>{const key=`${t.point.x.toFixed(4)},${t.point.y.toFixed(4)},${t.elevation}`;if(seen.has(key))return false;seen.add(key);return true;});
  return { stairFlights, floorTiles:uniqueTiles, handle };
}

/** Choose existing doors first; otherwise preview explicit new door slots. */
export function planRoomConnection(fromId: string, toId: string, rooms: Room[], layout: GeneratedLayout) {
  const from = rooms.find(r => r.id === fromId), to = rooms.find(r => r.id === toId);
  if (!from || !to || from === to) return null;
  const common = layout.walls.find(w => (w.roomId===fromId && w.opposingRoomId===toId || w.roomId===toId && w.opposingRoomId===fromId) && w.length>=1.99);
  if(common) {
    const point=wallModuleCenter(common);
    const updated=rooms.map(r=>r.id===fromId||r.id===toId?{...r,openings:[...r.openings.filter(o=>Math.hypot(o.cx-point.x,o.cy-point.y)>0.05),{id:`link-door-${r.id}-${point.x}-${point.y}`,roomId:r.id,asset:"DR_2.5x1.5_1" as const,cx:point.x,cy:point.y,rotation:common.rotation}]}:r);
    const connection:RoomConnection={id:`connection-${fromId}-${toId}`,fromRoomId:fromId,toRoomId:toId,fromOpeningId:`link-door-${fromId}-${point.x}-${point.y}`,toOpeningId:`link-door-${toId}-${point.x}-${point.y}`};
    return {connection,rooms:updated,geometry:{stairFlights:[],floorTiles:[]} as ConnectionGeometry};
  }
  const candidates = (room: Room): WallOpening[] => {
    const existing = doors(room).filter(o => layout.walls.some(w => !w.opposingRoomId && w.roomId === room.id && Math.hypot(wallModuleCenter(w).x-o.cx, wallModuleCenter(w).y-o.cy) < 0.1));
    if (existing.length) return existing;
    return layout.walls.filter(w => w.roomId === room.id && !w.opposingRoomId && w.length >= 1.99).map(w => {
      const p = wallModuleCenter(w);
      return { id: `link-door-${room.id}-${p.x}-${p.y}`, roomId: room.id, cx:p.x, cy:p.y, rotation:w.rotation, asset:"DR_2.5x1.5_1" };
    });
  };
  const pairs = candidates(from).flatMap(a => candidates(to).map(b => ({ a,b,d:Math.hypot(a.cx-b.cx,a.cy-b.cy) }))).sort((a,b)=>a.d-b.d);
  for (const {a,b} of pairs) {
    const updated = rooms.map(r => r.id === fromId || r.id === toId ? { ...r, openings: [...r.openings.filter(o => Math.hypot(o.cx-(r.id===fromId?a:b).cx,o.cy-(r.id===fromId?a:b).cy)>0.05), { ...(r.id===fromId?a:b), automatic:false, suppressed:false }] } : r);
    const connection: RoomConnection = { id:`connection-${fromId}-${toId}`, fromRoomId:fromId,toRoomId:toId,fromOpeningId:a.id,toOpeningId:b.id };
    const geometry = buildConnectionGeometry(connection, updated);
    if (!geometry) continue;
    // Reject paths through unrelated rooms at the same walking height.
    if (geometry.floorTiles.some(t => updated.some(r => r.id!==fromId && r.id!==toId && Math.abs((r.elevationSteps??0)*ROOM_ELEVATION_STEP-t.elevation)<2.5 && roomContainsPoint(r,t.point)))) continue;
    return { connection, rooms:updated, geometry };
  }
  return null;
}
