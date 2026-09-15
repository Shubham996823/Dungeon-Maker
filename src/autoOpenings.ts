import { buildLayout } from "./layout";
import { canonicalOpeningRotation, openingAllowedOnWall, openingMatchesWall, wallModuleCenter } from "./openings";
import { openingIsWindow } from "./moduleAssets";
import { createTerrainHeightSampler, prepareTerrainRegion } from "./terrainSurface";
import type { BuildSettings, Cell, FloorRegion, ManualWall, Room, TerrainCell, TerrainRegion, WallDeletion, WallOpening, WallSegment } from "./types";

/** Reconcile against the complete world, never the currently visible grid level. */
export function reconcileAutoOpenings(cells: Cell[], rooms: Room[], settings: BuildSettings, manualWalls: ManualWall[], deletions: WallDeletion[], floors: FloorRegion[], terrain: TerrainCell[], regions: TerrainRegion[]): Room[] {
  if (!rooms.some(room => room.autoOpenings)) return rooms;
  rooms = rooms.map(room => ({ ...room, openings: room.openings.map(o => ({ ...o, roomId: room.id })) }));
  const layout = buildLayout(cells, settings, rooms, manualWalls, deletions, floors);
  const walls = layout.walls.filter(w => !w.manualWallId && w.length >= 1.99);
  const sample = createTerrainHeightSampler(terrain, regions.filter(r => !r.texture).map(prepareTerrainRegion));
  const retained = rooms.flatMap(room => room.openings.filter(o => !o.automatic));
  const generated: WallOpening[] = [];
  const occupied = (w: WallSegment) => [...retained, ...generated].some(o => openingMatchesWall(o, w));
  const available = (w: WallSegment, window: boolean) => {
    const p = wallModuleCenter(w), y = (w.elevation ?? 0) - 0.16;
    // Test both sides of the wall; don't put openings into buried terrain.
    return [-0.6, 0, 0.6].every(d => sample(p.x - Math.sin(w.rotation) * d, p.y + Math.cos(w.rotation) * d) <= y + (window ? 0.85 : 0.25));
  };
  const add = (w: WallSegment, roomId: string, window: boolean) => {
    const p = wallModuleCenter(w);
    generated.push({ id: `auto-${roomId}-${p.x.toFixed(3)}-${p.y.toFixed(3)}`, roomId, asset: window ? "WD_1" : "DR_2.5x1.5_1", cx: p.x, cy: p.y, rotation: canonicalOpeningRotation(w.rotation), automatic: true });
  };
  const shared = new Set<string>();
  for (const room of rooms.filter(r => r.autoOpenings)) {
    const own = walls.filter(w => w.roomId === room.id || w.opposingRoomId === room.id);
    const groups = new Map<string, WallSegment[]>();
    for (const wall of own.filter(w => w.opposingRoomId)) {
      const key = [wall.roomId, wall.opposingRoomId].sort().join("|");
      groups.set(key, [...(groups.get(key) ?? []), wall]);
    }
    for (const [key, candidates] of groups) {
      if (shared.has(key)) continue;
      shared.add(key);
      if (candidates.some(w => [...retained, ...generated].some(o => !o.suppressed && !openingIsWindow(o.asset) && openingMatchesWall(o, w)))) continue;
      // Interior connections sit within the room cutouts. Raw terrain may be above
      // both rooms (especially underground), so exterior clearance must not veto them.
      const wall = candidates.find(w => !occupied(w));
      if (wall) add(wall, room.id, false);
    }
    const exterior = own.filter(w => !w.opposingRoomId).sort((a,b) => a.y-b.y || a.x-b.x);
    const hasDoor = own.some(w => [...retained, ...generated].some(o => !o.suppressed && !openingIsWindow(o.asset) && openingMatchesWall(o,w)));
    if (!hasDoor) {
      const wall = exterior.find(w => !occupied(w) && available(w, false));
      if (wall) add(wall, room.id, false);
    }
    for (const wall of exterior) {
      const p = wallModuleCenter(wall);
      if (occupied(wall) || !available(wall, true)) continue;
      if ([...retained, ...generated].some(o => o.roomId === room.id && Math.hypot(o.cx-p.x,o.cy-p.y) < 3.9)) continue;
      add(wall, room.id, true);
    }
  }
  return rooms.map(room => ({ ...room, openings: [
    ...room.openings.filter(o => !o.automatic && (o.suppressed || walls.some(w => openingMatchesWall(o,w) && openingAllowedOnWall(o.asset,w)))),
    ...generated.filter(o => o.roomId === room.id),
  ] }));
}
