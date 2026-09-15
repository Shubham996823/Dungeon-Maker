import { CELL_SIZE } from "./layout";
import type { FloorRegion, ManualWall, PillarPlacement, PlanPoint, Room, StairPlacement } from "./types";

const roomElevation = (room: Room) => room.elevationSteps ?? 0;

export function roomContainsPoint(room: Room, point: PlanPoint) {
  const inCell = room.cells.some((cell) => point.x >= cell.x * CELL_SIZE - 1e-6
    && point.x <= (cell.x + 1) * CELL_SIZE + 1e-6
    && point.y >= cell.y * CELL_SIZE - 1e-6
    && point.y <= (cell.y + 1) * CELL_SIZE + 1e-6);
  return inCell || room.circles.some((circle) => Math.hypot(point.x - circle.cx, point.y - circle.cy) <= circle.radius + 1e-6);
}

function translatePoint(point: PlanPoint, dx: number, dy: number): PlanPoint {
  return { x: point.x + dx, y: point.y + dy };
}

/** Moves authored objects wholly contained by the selected room footprint and level. */
export function moveContainedRoomObjects(
  rooms: Room[],
  selectedRoomIds: Set<string>,
  dxCells: number,
  dyCells: number,
  manualWalls: ManualWall[],
  floors: FloorRegion[],
  stairs: StairPlacement[],
  pillars: PillarPlacement[],
) {
  const selectedRooms = rooms.filter((room) => selectedRoomIds.has(room.id));
  const dx = dxCells * CELL_SIZE;
  const dy = dyCells * CELL_SIZE;
  const contained = (point: PlanPoint, elevationSteps: number) => selectedRooms.some((room) =>
    roomElevation(room) === elevationSteps && roomContainsPoint(room, point));

  const nextManualWalls = manualWalls.map((wall) => {
    const elevationSteps = wall.elevationSteps ?? 0;
    const points = [wall.start, wall.end, ...(wall.control ? [wall.control] : []), ...(wall.arcPoint ? [wall.arcPoint] : [])];
    if (!points.every((point) => contained(point, elevationSteps))) return wall;
    return {
      ...wall,
      start: translatePoint(wall.start, dx, dy),
      end: translatePoint(wall.end, dx, dy),
      control: wall.control ? translatePoint(wall.control, dx, dy) : undefined,
      arcPoint: wall.arcPoint ? translatePoint(wall.arcPoint, dx, dy) : undefined,
      openings: wall.openings?.map((opening) => ({ ...opening, cx: opening.cx + dx, cy: opening.cy + dy })),
    };
  });

  const nextFloors = floors.map((floor) => {
    if (!floor.cells.length || !floor.cells.every((cell) => contained({ x: (cell.x + 0.5) * CELL_SIZE, y: (cell.y + 0.5) * CELL_SIZE }, floor.elevationSteps))) return floor;
    return {
      ...floor,
      cells: floor.cells.map((cell) => ({ x: cell.x + dxCells, y: cell.y + dyCells })),
      cornerEdits: floor.cornerEdits.map((edit) => ({ ...edit, vertexX: edit.vertexX + dxCells, vertexY: edit.vertexY + dyCells })),
    };
  });

  const nextStairs = stairs.map((stair) => contained({ x: (stair.cell.x + 0.5) * CELL_SIZE, y: (stair.cell.y + 0.5) * CELL_SIZE }, stair.elevationSteps)
    ? { ...stair, cell: { x: stair.cell.x + dxCells, y: stair.cell.y + dyCells } }
    : stair);
  const nextPillars = pillars.map((pillar) => contained(pillar.point, pillar.elevationSteps)
    ? { ...pillar, point: translatePoint(pillar.point, dx, dy) }
    : pillar);

  return { manualWalls: nextManualWalls, floors: nextFloors, stairs: nextStairs, pillars: nextPillars };
}
