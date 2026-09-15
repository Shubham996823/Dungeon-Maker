import { CELL_SIZE } from "./layout";
import type { Cell, PlanPoint, TerrainBrushMode, TerrainCell, TerrainEdgeProfile, TerrainRegion } from "./types";

export const MAX_TERRAIN_HEIGHT = 20;
export const MAX_TERRAIN_CELLS = 12_000;
export const MAX_TERRAIN_COORDINATE = 256;
export const MAX_TERRAIN_RENDER_VERTICES = 500_000;

/** Keeps dense terrain practical when a sparse edit stretches the rendered map bounds. */
export function resolveTerrainSubdivisions(widthCells: number, depthCells: number, requested: number) {
  const desired = Math.max(1, Math.min(10, Math.round(requested)));
  const cellArea = Math.max(1, Math.ceil(widthCells)) * Math.max(1, Math.ceil(depthCells));
  const safe = Math.max(1, Math.floor(Math.sqrt(MAX_TERRAIN_RENDER_VERTICES / cellArea)));
  return Math.min(desired, safe);
}

const key = (x: number, y: number) => `${x},${y}`;
const roundHeight = (height: number) => Math.round(height * 100) / 100;

/** Samples one continuous closed curve from editable control points. */
export function sampleClosedTerrainSpline(controlPoints: PlanPoint[], samplesPerPoint = 18): PlanPoint[] {
  if (controlPoints.length < 3) return [];
  const samples: PlanPoint[] = [];
  const count = Math.max(4, Math.min(64, Math.round(samplesPerPoint)));
  for (let index = 0; index < controlPoints.length; index += 1) {
    const p0 = controlPoints[(index - 1 + controlPoints.length) % controlPoints.length];
    const p1 = controlPoints[index];
    const p2 = controlPoints[(index + 1) % controlPoints.length];
    const p3 = controlPoints[(index + 2) % controlPoints.length];
    for (let sample = 0; sample < count; sample += 1) {
      const t = sample / count;
      const t2 = t * t;
      const t3 = t2 * t;
      samples.push({
        x: 0.5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        y: 0.5 * (2 * p1.y + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
      });
    }
  }
  return samples;
}

export function sanitizeTerrainRegions(value: unknown): TerrainRegion[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate, index): TerrainRegion[] => {
    if (!candidate || typeof candidate !== "object") return [];
    const region = candidate as Partial<TerrainRegion>;
    if (!Array.isArray(region.controlPoints)) return [];
    const controlPoints = region.controlPoints.flatMap((point): PlanPoint[] => {
      if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return [];
      return [{
        x: Math.max(-MAX_TERRAIN_COORDINATE * CELL_SIZE, Math.min(MAX_TERRAIN_COORDINATE * CELL_SIZE, Number(point.x))),
        y: Math.max(-MAX_TERRAIN_COORDINATE * CELL_SIZE, Math.min(MAX_TERRAIN_COORDINATE * CELL_SIZE, Number(point.y))),
      }];
    }).slice(0, region.brush ? 4096 : 64);
    if (controlPoints.length < (region.brush ? 1 : 3)) return [];
    const mode: TerrainBrushMode = region.mode === "lower" || region.mode === "flatten" ? region.mode : "raise";
    const fallbackHeight = mode === "lower" ? -0.5 : mode === "flatten" ? 0 : 0.5;
    return [{
      id: typeof region.id === "string" && region.id ? region.id : `terrain-region-${index}`,
      controlPoints,
      ...(region.brush ? { brush: {
        radius: Math.max(0.25, Math.min(20, Number(region.brush.radius) || 2)),
        intensity: Math.max(0.01, Math.min(1, Number(region.brush.intensity) || 0.5)),
        falloff: Math.max(0, Math.min(1, Number(region.brush.falloff) || 0)),
      } } : {}),
      ...(region.texture === "grass" || region.texture === "ground-rocks" || region.texture === "cliff-rocks" ? { texture: region.texture } : {}),
      mode,
      height: roundHeight(Math.max(-MAX_TERRAIN_HEIGHT, Math.min(MAX_TERRAIN_HEIGHT, Number.isFinite(region.height) ? Number(region.height) : fallbackHeight))),
      edgeProfile: region.edgeProfile === "cliff" ? "cliff" : "smooth",
      slopeWidth: Math.max(0.25, Math.min(8, Number.isFinite(region.slopeWidth) ? Number(region.slopeWidth) : 2)),
    }];
  });
}

/** Rebuilds editable terrain regions over legacy/baked terrain. */
export function applyTerrainRegions(terrain: TerrainCell[], regions: TerrainRegion[]): TerrainCell[] {
  return regions.reduce((current, region) => {
    if (region.texture) return current;
    const polygon = sampleClosedTerrainSpline(region.controlPoints);
    if (!polygon.length) return current;
    if (region.mode !== "flatten" && Math.abs(region.height) < 0.01) return current;
    const mode = region.mode === "flatten" ? "flatten" : region.height < 0 ? "lower" : "raise";
    return applyTerrainSpline(current, polygon, mode, Math.max(0.05, Math.abs(region.height)), region.edgeProfile, region.slopeWidth);
  }, terrain);
}

export function sanitizeTerrain(value: unknown): TerrainCell[] {
  if (!Array.isArray(value)) return [];
  const cells = new Map<string, TerrainCell>();
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object") continue;
    const cell = candidate as Partial<TerrainCell>;
    if (!Number.isFinite(cell.x) || !Number.isFinite(cell.y) || !Number.isFinite(cell.height)) continue;
    const x = Math.max(-MAX_TERRAIN_COORDINATE, Math.min(MAX_TERRAIN_COORDINATE, Math.trunc(Number(cell.x))));
    const y = Math.max(-MAX_TERRAIN_COORDINATE, Math.min(MAX_TERRAIN_COORDINATE, Math.trunc(Number(cell.y))));
    const height = roundHeight(Math.max(-MAX_TERRAIN_HEIGHT, Math.min(MAX_TERRAIN_HEIGHT, Number(cell.height))));
    if (Math.abs(height) >= 0.01) cells.set(key(x, y), { x, y, height });
    if (cells.size >= MAX_TERRAIN_CELLS) break;
  }
  return [...cells.values()].sort((a, b) => a.y - b.y || a.x - b.x);
}

/** Applies a complete drag as one deterministic, undoable brush stroke. */
export function applyTerrainStroke(
  terrain: TerrainCell[],
  centres: Cell[],
  mode: TerrainBrushMode,
  radiusCells: number,
  step: number,
): TerrainCell[] {
  if (!centres.length) return terrain;
  const radius = Math.max(1, Math.min(8, Math.round(radiusCells)));
  const amount = Math.max(0.05, Math.min(4, step));
  const heights = new Map(terrain.map((cell) => [key(cell.x, cell.y), cell.height]));
  const influence = new Map<string, { x: number; y: number; weight: number }>();

  for (const centre of centres) {
    for (let y = centre.y - radius; y <= centre.y + radius; y += 1) {
      for (let x = centre.x - radius; x <= centre.x + radius; x += 1) {
        const distance = Math.hypot(x - centre.x, y - centre.y);
        if (distance > radius + 0.25) continue;
        const weight = Math.max(0.12, 1 - distance / (radius + 0.5));
        const cellKey = key(x, y);
        const previous = influence.get(cellKey);
        if (!previous || weight > previous.weight) influence.set(cellKey, { x, y, weight });
      }
    }
  }

  const first = centres[0];
  const flattenTarget = heights.get(key(first.x, first.y)) ?? 0;
  for (const affected of influence.values()) {
    const cellKey = key(affected.x, affected.y);
    const current = heights.get(cellKey) ?? 0;
    const next = mode === "flatten"
      ? current + (flattenTarget - current) * affected.weight
      : current + (mode === "raise" ? 1 : -1) * amount * affected.weight;
    const clamped = roundHeight(Math.max(-MAX_TERRAIN_HEIGHT, Math.min(MAX_TERRAIN_HEIGHT, next)));
    if (Math.abs(clamped) < 0.01) heights.delete(cellKey);
    else heights.set(cellKey, clamped);
  }

  return sanitizeTerrain([...heights].map(([cellKey, height]) => {
    const [x, y] = cellKey.split(",").map(Number);
    return { x, y, height };
  }));
}

export function pointInPolygon(point: PlanPoint, polygon: PlanPoint[]) {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    const a = polygon[index];
    const b = polygon[previous];
    if ((a.y > point.y) !== (b.y > point.y)
      && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export function terrainPaintInfluence(point: PlanPoint, region: TerrainRegion): number {
  if (!region.brush || !region.controlPoints.length) return 0;
  let distance = Math.hypot(point.x - region.controlPoints[0].x, point.y - region.controlPoints[0].y);
  for (let i = 1; i < region.controlPoints.length; i++) distance = Math.min(distance, distanceToSegment(point, region.controlPoints[i - 1], region.controlPoints[i]));
  const { radius, intensity, falloff } = region.brush;
  if (distance >= radius) return 0;
  const t = Math.min(1, (radius - distance) / Math.max(0.0001, radius * falloff));
  return intensity * t * t * (3 - 2 * t);
}

function distanceToSegment(point: PlanPoint, start: PlanPoint, end: PlanPoint) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (!lengthSquared) return Math.hypot(point.x - start.x, point.y - start.y);
  const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared));
  return Math.hypot(point.x - (start.x + dx * t), point.y - (start.y + dy * t));
}

/** Applies a sampled closed spline to every terrain cell enclosed by the curve. */
export function applyTerrainSpline(
  terrain: TerrainCell[],
  polygon: PlanPoint[],
  mode: TerrainBrushMode,
  amount: number,
  edgeProfile: TerrainEdgeProfile,
  slopeWidthCells: number,
): TerrainCell[] {
  if (polygon.length < 3) return terrain;
  const heights = new Map(terrain.map((cell) => [key(cell.x, cell.y), cell.height]));
  const minX = Math.floor(Math.min(...polygon.map((point) => point.x)) / CELL_SIZE);
  const maxX = Math.ceil(Math.max(...polygon.map((point) => point.x)) / CELL_SIZE) - 1;
  const minY = Math.floor(Math.min(...polygon.map((point) => point.y)) / CELL_SIZE);
  const maxY = Math.ceil(Math.max(...polygon.map((point) => point.y)) / CELL_SIZE) - 1;
  const change = Math.max(0.05, Math.min(4, amount));
  const slopeWidth = Math.max(0.25, Math.min(8, slopeWidthCells)) * CELL_SIZE;

  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const centre = { x: (x + 0.5) * CELL_SIZE, y: (y + 0.5) * CELL_SIZE };
      if (!pointInPolygon(centre, polygon)) continue;
      const boundaryDistance = polygon.reduce((nearest, start, index) =>
        Math.min(nearest, distanceToSegment(centre, start, polygon[(index + 1) % polygon.length])), Infinity);
      const weight = edgeProfile === "cliff" ? 1 : Math.min(1, boundaryDistance / slopeWidth);
      const cellKey = key(x, y);
      const current = heights.get(cellKey) ?? 0;
      const next = mode === "flatten" ? current * (1 - weight) : current + (mode === "raise" ? 1 : -1) * change * weight;
      const clamped = roundHeight(Math.max(-MAX_TERRAIN_HEIGHT, Math.min(MAX_TERRAIN_HEIGHT, next)));
      if (Math.abs(clamped) < 0.01) heights.delete(cellKey);
      else heights.set(cellKey, clamped);
    }
  }
  return sanitizeTerrain([...heights].map(([cellKey, height]) => {
    const [x, y] = cellKey.split(",").map(Number);
    return { x, y, height };
  }));
}
