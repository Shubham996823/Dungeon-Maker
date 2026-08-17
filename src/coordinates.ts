import { CELL_SIZE } from "./layout";
import type { Cell } from "./types";

export function planYToWorldZ(planY: number) {
  return -planY;
}

export function cellCenterToWorld(cell: Cell) {
  return {
    x: cell.x * CELL_SIZE + CELL_SIZE / 2,
    z: planYToWorldZ(cell.y * CELL_SIZE + CELL_SIZE / 2),
  };
}

export function worldPointToCell(worldX: number, worldZ: number): Cell {
  return {
    x: Math.floor(worldX / CELL_SIZE),
    y: Math.floor(planYToWorldZ(worldZ) / CELL_SIZE),
  };
}
