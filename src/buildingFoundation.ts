import { buildEditedRoomGeometry, pointInPolygon } from "./footprint";
import { createTerrainHeightSampler, prepareTerrainRegion } from "./terrainSurface";
import type { Room, TerrainCell, TerrainRegion } from "./types";

export const buildingIdForRoom = (room: Room) => room.buildingId ?? room.id;
export const foundationHeightForRoom = (room: Room) => room.foundationHeight ?? (((room.elevationSteps ?? 0) % 10 + 10) % 10) * 0.25;
export const buildingLevelForRoom = (room: Room) => Math.round(((room.elevationSteps ?? 0) * 0.25 - foundationHeightForRoom(room)) / 2.5);

/** Sample the actual outline before inserting the room into terrain protection. */
export function foundationForRoom(room: Room, cells: TerrainCell[], regions: TerrainRegion[]): number {
  if (!cells.length && !regions.some((r) => !r.texture)) return 0;
  const sample = createTerrainHeightSampler(cells, regions.filter((r) => !r.texture).map(prepareTerrainRegion));
  let highest = -Infinity;
  for (const ground of buildEditedRoomGeometry(room, 64).grounds) {
    const xs = ground.outer.map((p) => p.x), ys = ground.outer.map((p) => p.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const step = Math.max(0.2, Math.sqrt((maxX - minX) * (maxY - minY) / 40000));
    for (let y = minY; y <= maxY; y += step) for (let x = minX; x <= maxX; x += step) {
      if (pointInPolygon({ x, y }, ground.outer) && !ground.holes.some((hole) => pointInPolygon({ x, y }, hole))) highest = Math.max(highest, sample(x, y));
    }
    for (const p of ground.outer) highest = Math.max(highest, sample(p.x, p.y));
  }
  // The terrain's 0.16 m rendering clearance sits below the floor datum.
  return Number.isFinite(highest) ? Math.ceil((highest + 0.16) * 100 - 1e-8) / 100 : 0;
}
