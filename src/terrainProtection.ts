import { pointInPolygon } from "./footprint";
import type { PlanPoint, RoomGround } from "./types";

/** Non-destructive room exclusion: never lift low terrain to an elevated room. */
export function protectRoomTerrain(height: number, point: PlanPoint, grounds: RoomGround[]): number {
  let result = height;
  for (const ground of grounds) {
    if (ground.outer.length < 3) continue;
    const floor = (ground.elevation ?? 0) - 0.16;
    if (result <= floor) continue;
    const inside = pointInPolygon(point, ground.outer) && !ground.holes.some((hole) => pointInPolygon(point, hole));
    let distance = Infinity;
    for (const loop of [ground.outer, ...ground.holes]) for (let i = 0; i < loop.length; i++) {
      const a = loop[i], b = loop[(i + 1) % loop.length], dx = b.x - a.x, dy = b.y - a.y;
      const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / Math.max(1e-12, dx * dx + dy * dy)));
      distance = Math.min(distance, Math.hypot(point.x - a.x - t * dx, point.y - a.y - t * dy));
    }
    // Lower the outside rim smoothly as well, including the boundary itself.
    const t = Math.max(0, Math.min(1, (distance - 0.3) / 0.75));
    const weight = inside ? 1 : 1 - t * t * (3 - 2 * t);
    result = Math.min(result, result + (floor - result) * weight);
  }
  return result;
}
