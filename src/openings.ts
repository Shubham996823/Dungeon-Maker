import { openingIsWindow } from "./moduleAssets";
import type { BuildSettings, OpeningAsset, WallOpening, WallResizeHandle, WallSegment } from "./types";

const POSITION_EPSILON = 0.08;
const ROTATION_EPSILON = 0.02;

export interface OpeningTarget {
  roomId?: string;
  manualWallId?: string;
  cx: number;
  cy: number;
  rotation: number;
  shared: boolean;
}

/** Wall tangents are directionless for openings, so opposite room ownership is identical. */
export function canonicalOpeningRotation(rotation: number) {
  const normalized = ((rotation % Math.PI) + Math.PI) % Math.PI;
  return Math.abs(normalized - Math.PI) < 1e-8 || normalized < 1e-8 ? 0 : normalized;
}

export function wallModuleCenter(wall: WallSegment) {
  return {
    x: wall.x + Math.cos(wall.rotation) * wall.length / 2,
    y: wall.y + Math.sin(wall.rotation) * wall.length / 2,
  };
}

export function openingMatchesWall(opening: WallOpening, wall: WallSegment) {
  const center = wallModuleCenter(wall);
  const belongsToWall = (Boolean(opening.manualWallId) && opening.manualWallId === wall.manualWallId)
    || opening.roomId === wall.roomId || opening.roomId === wall.opposingRoomId;
  return belongsToWall
    && Math.hypot(opening.cx - center.x, opening.cy - center.y) < POSITION_EPSILON
    && Math.abs(Math.sin(opening.rotation - wall.rotation)) < ROTATION_EPSILON;
}

export function openingAllowedOnWall(asset: OpeningAsset, wall: WallSegment) {
  return !wall.opposingRoomId || !openingIsWindow(asset);
}

export function openingForWall(openings: WallOpening[], wall: WallSegment) {
  return openings.find((opening) => openingMatchesWall(opening, wall) && openingAllowedOnWall(opening.asset, wall));
}

export function openingTargetForWall(wall: WallSegment): OpeningTarget | null {
  const owners = [wall.roomId, wall.opposingRoomId].filter((id): id is string => Boolean(id)).sort();
  if (!owners.length && !wall.manualWallId) return null;
  const center = wallModuleCenter(wall);
  return {
    roomId: owners[0],
    manualWallId: wall.manualWallId,
    cx: center.x,
    cy: center.y,
    rotation: canonicalOpeningRotation(wall.rotation),
    shared: Boolean(wall.opposingRoomId),
  };
}

/**
 * Exterior openings use the authored inside-face pivot. Shared doors instead sit on the
 * exact common boundary, midway between the two inside wall layers. Their rotation is
 * canonical so swapping which room owns the shared segment cannot flip their placement.
 */
export function openingTransformForWall(wall: WallSegment, settings: BuildSettings) {
  const shared = Boolean(wall.opposingRoomId);
  const center = wallModuleCenter(wall);
  const rotation = shared ? canonicalOpeningRotation(wall.rotation) : wall.rotation;
  const offset = shared ? 0 : settings.innerWallOffset;
  return {
    x: center.x - Math.sin(rotation) * offset,
    y: center.y + Math.cos(rotation) * offset,
    rotation: rotation + (settings.flipInnerWall ? Math.PI : 0),
  };
}

export function sharedWindowIds(openings: WallOpening[], walls: WallSegment[]) {
  const sharedWalls = walls.filter((wall) => wall.opposingRoomId);
  return new Set(openings
    .filter((opening) => openingIsWindow(opening.asset) && sharedWalls.some((wall) => openingMatchesWall(opening, wall)))
    .map((opening) => opening.id));
}

export function openingIsOnResizeHandle(opening: WallOpening, handle: WallResizeHandle) {
  const dx = handle.end.x - handle.start.x;
  const dy = handle.end.y - handle.start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared < 1e-8) return false;
  const relativeX = opening.cx - handle.start.x;
  const relativeY = opening.cy - handle.start.y;
  const along = (relativeX * dx + relativeY * dy) / lengthSquared;
  const perpendicularDistance = Math.abs(relativeX * dy - relativeY * dx) / Math.sqrt(lengthSquared);
  const tangent = Math.atan2(dy, dx);
  return along >= -1e-4 && along <= 1 + 1e-4
    && perpendicularDistance < POSITION_EPSILON
    && Math.abs(Math.sin(opening.rotation - tangent)) < ROTATION_EPSILON;
}

export function moveOpeningsWithWalls(
  openings: WallOpening[],
  changes: Array<{ handle: WallResizeHandle; steps: number }>,
  cellSize: number,
) {
  return openings.map((opening) => {
    const change = changes.find(({ handle }) => openingIsOnResizeHandle(opening, handle));
    if (!change) return opening;
    const distance = change.steps * cellSize;
    return {
      ...opening,
      cx: opening.cx + change.handle.outwardX * distance,
      cy: opening.cy + change.handle.outwardY * distance,
    };
  });
}
