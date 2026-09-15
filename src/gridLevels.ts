/** Horizontal grid spacing stays unchanged; levels are 2.5 metres apart. */
export const GRID_LEVEL_HEIGHT = 2.5;
export const GRID_LEVEL_STEPS = 10;

/** Visual datum only; never changes placement or snapping elevation. */
export function visibleGridHeight(activeElevation:number):number {
  return Math.min(0,activeElevation);
}

export function onGridLevel(elevationSteps: number | undefined, level: number, foundationHeight = 0): boolean {
  return Math.floor(((elevationSteps ?? 0) - foundationHeight * 4) / GRID_LEVEL_STEPS + 1e-8) === level;
}

/** Show the active level and every completed level beneath it. */
export function visibleAtOrBelowGridLevel(elevationSteps: number | undefined, level: number, foundationHeight = 0): boolean {
  return (elevationSteps ?? 0) - foundationHeight * 4 < (level + 1) * GRID_LEVEL_STEPS - 0.00001;
}
