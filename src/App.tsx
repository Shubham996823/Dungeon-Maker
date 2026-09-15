import { GRID_LEVEL_HEIGHT, onGridLevel, visibleAtOrBelowGridLevel } from "./gridLevels";
import { buildingIdForRoom, buildingLevelForRoom, foundationForRoom, foundationHeightForRoom } from "./buildingFoundation";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { reconcileAutoOpenings } from "./autoOpenings";
import { Icon } from "./icons";
import { buildLayout, CELL_SIZE, eraseManualWallModules, MAX_CELLS, normalizeCells, rectangleCells, resizeRoomCells, ROOM_ELEVATION_STEP } from "./layout";
import { circleIntersectsCellBounds, circleOverlapsCells, circlesOverlap, MIN_CIRCLE_RADIUS } from "./footprint";
import { isOpeningAsset, isPillarModuleVariant, isStairAsset, isWallModuleVariant, OPENING_ASSETS, openingIsWindow, openingLabel, PILLAR_MODULE_VARIANTS, STAIR_ASSETS, stairLabel, WALL_MODULE_VARIANTS } from "./moduleAssets";
import { canonicalOpeningRotation, moveOpeningsWithWalls, sharedWindowIds, type OpeningTarget } from "./openings";
import { moveContainedRoomObjects } from "./roomContents";
import { suggestRoomConnections, planRoomConnection, buildConnectionGeometry } from "./roomConnections";
import { applyTerrainSpline, applyTerrainStroke, sanitizeTerrain, sanitizeTerrainRegions } from "./terrain";
import type {
  BuildSettings,
  Cell,
  CircleShape,
  CornerEdit,
  EditorTool,
  FloorAssetVariant,
  FloorRegion,
  ManualWall,
  ManualWallKind,
  WallDrawMode,
  PlanAction,
  OpeningAsset,
  PillarPlacement,
  Room,
  RoomConnection,
  SavedProject,
  StairPlacement,
  StairAsset,
  TerrainBrushMode,
  TerrainCell,
  TerrainRegion,
  TerrainTextureVariant,
  TerrainEdgeProfile,
  Variant,
  WallResizeHandle,
  WallDeletion,
  WallEraseTarget,
} from "./types";

const STORAGE_KEY = "mor-room-planner:project:v10";
const LEGACY_STORAGE_KEYS = ["mor-room-planner:project:v9", "mor-room-planner:project:v8", "mor-room-planner:project:v7", "mor-room-planner:project:v6", "mor-room-planner:project:v5", "mor-room-planner:project:v4", "mor-room-planner:project:v3", "mor-room-planner:project:v2", "mor-room-planner:project:v1"];
const HISTORY_LIMIT = 60;
// Wall transforms are part of the module assembly contract. Keeping them fixed prevents a
// saved project or an accidental slider change from turning the two authored faces away
// from the room or pulling them off its boundary.
const LOCKED_INNER_WALL_FLIP = true;
const LOCKED_OUTER_WALL_FLIP = false;
const LOCKED_INNER_WALL_OFFSET = 0.15;
const LOCKED_OUTER_WALL_OFFSET = 0.25;
const ThreeViewport = lazy(async () => {
  const module = await import("./components/ThreeViewport");
  return { default: module.ThreeViewport };
});

const DEFAULT_SETTINGS: BuildSettings = {
  floorVariant: "A",
  wallVariant: "A",
  innerWallVariant: "A",
  outerWallVariant: "A",
  flipInnerWall: LOCKED_INNER_WALL_FLIP,
  flipOuterWall: LOCKED_OUTER_WALL_FLIP,
  wallOrientationVersion: 1,
  showInnerWalls: true,
  showOuterWalls: true,
  innerWallOffset: LOCKED_INNER_WALL_OFFSET,
  outerWallOffset: LOCKED_OUTER_WALL_OFFSET,
  cornerVariant: "A",
  pillarVariant: "A",
  randomizeWalls: true,
  randomSeed: 1,
  addPillars: false,
  pillarInset: 0.3,
  curveQuality: 64,
  sharedWallSeparation: 0.04,
  dynamicLighting: true,
  timeOfDay: 13,
  ambientLight: 1,
  exposure: 1.05,
  hdriBackground: true,
  hdriIntensity: 1,
  hdriRotation: 0,
  moduleWallVariant: "2",
  modulePillarVariant: "1",
  terrainEnabled: true,
  terrainBrushRadius: 2,
  terrainBrushStep: 0.5,
  terrainTexture: "grass",
  terrainEdgeProfile: "smooth",
  terrainSlopeWidth: 2,
  terrainMeshResolution: 4,
};

const EXAMPLE_CELLS = normalizeCells([
  ...rectangleCells(-3, -2, 5, 4),
  ...rectangleCells(2, -1, 2, 2),
]);

interface ProjectState {
  activeBuildingId?: string | null;
  activeGridLevel?: number;
  name: string;
  cells: Cell[];
  rooms: Room[];
  manualWalls: ManualWall[];
  wallDeletions: WallDeletion[];
  floors: FloorRegion[];
  stairs: StairPlacement[];
  placedPillars: PillarPlacement[];
  terrain: TerrainCell[];
  terrainRegions: TerrainRegion[];
  roomConnections: RoomConnection[];
  settings: BuildSettings;
}

function sanitizeFloors(value: unknown): FloorRegion[] {
  if (!Array.isArray(value)) return [];
  const sanitized = value.flatMap((candidate, index): FloorRegion[] => {
    if (!candidate || typeof candidate !== "object") return [];
    const floor = candidate as Partial<FloorRegion>;
    const floorCells = normalizeCells(Array.isArray(floor.cells) ? floor.cells : []);
    if (!floorCells.length) return [];
    return [{
      id: typeof floor.id === "string" && floor.id ? floor.id : `floor-import-${index}`,
      cells: floorCells,
      cornerEdits: Array.isArray(floor.cornerEdits) ? floor.cornerEdits.map(sanitizeCornerEdit).filter((edit): edit is CornerEdit => edit !== null) : [],
      elevationSteps: Number.isFinite(floor.elevationSteps) ? Number(floor.elevationSteps) : 0,
      variant: floor.variant === "2" ? "2" : "1",
    }];
  });
  // A short-lived marquee implementation persisted selected areas as separate floor
  // objects. Fold those generated IDs back into their original floor on load.
  const merged = new Map<string, FloorRegion>();
  for (const floor of sanitized) {
    const baseId = floor.id.split("-selection-")[0];
    const key = `${baseId}|${floor.elevationSteps}|${floor.variant}`;
    const existing = merged.get(key);
    merged.set(key, existing ? {
      ...existing,
      cells: normalizeCells([...existing.cells, ...floor.cells]),
      cornerEdits: [...existing.cornerEdits, ...floor.cornerEdits],
    } : { ...floor, id: baseId });
  }
  return [...merged.values()];
}

function sanitizeStairs(value: unknown): StairPlacement[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate, index): StairPlacement[] => {
    if (!candidate || typeof candidate !== "object") return [];
    const stair = candidate as Partial<StairPlacement>;
    if (!stair.cell || !Number.isFinite(stair.cell.x) || !Number.isFinite(stair.cell.y)) return [];
    return [{
      id: typeof stair.id === "string" && stair.id ? stair.id : `stair-import-${index}`,
      cell: { x: Math.trunc(stair.cell.x), y: Math.trunc(stair.cell.y) },
      elevationSteps: Number.isFinite(stair.elevationSteps) ? Number(stair.elevationSteps!) : 0,
      rotation: Number.isFinite(stair.rotation) ? Number(stair.rotation) : 0,
      asset: isStairAsset(stair.asset) ? stair.asset : "ST_2.5x2_1",
    }];
  });
}

function sanitizePlacedPillars(value: unknown): PillarPlacement[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate, index): PillarPlacement[] => {
    if (!candidate || typeof candidate !== "object") return [];
    const pillar = candidate as Partial<PillarPlacement>;
    if (!pillar.point || !Number.isFinite(pillar.point.x) || !Number.isFinite(pillar.point.y)) return [];
    return [{
      id: typeof pillar.id === "string" && pillar.id ? pillar.id : `pillar-import-${index}`,
      point: { x: Number(pillar.point.x), y: Number(pillar.point.y) },
      elevationSteps: Number.isFinite(pillar.elevationSteps) ? Number(pillar.elevationSteps!) : 0,
      variant: isVariant(pillar.variant) ? pillar.variant : "A",
    }];
  });
}

function sanitizeRoomConnections(value: unknown): RoomConnection[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate, index): RoomConnection[] => {
    if (!candidate || typeof candidate !== "object") return [];
    const connection = candidate as Partial<RoomConnection>;
    if (![connection.fromRoomId, connection.toRoomId, connection.fromOpeningId, connection.toOpeningId].every((part) => typeof part === "string") || (!connection.pathPoints && (!connection.toRoomId || !connection.toOpeningId))) return [];
    return [{
      id: typeof connection.id === "string" && connection.id ? connection.id : `connection-import-${index}`,
      fromRoomId: connection.fromRoomId!,
      toRoomId: connection.toRoomId!,
      fromOpeningId: connection.fromOpeningId!,
      toOpeningId: connection.toOpeningId!,
      pathPoints: Array.isArray(connection.pathPoints) ? connection.pathPoints.filter(p=>Number.isFinite(p.x)&&Number.isFinite(p.y)&&Number.isFinite(p.elevation)).slice(0,128) : undefined,
      brokenSegments: Array.isArray(connection.brokenSegments) ? connection.brokenSegments.filter(i=>Number.isInteger(i)&&i>=0) : undefined,
      pathOrigin: connection.pathOrigin && Number.isFinite(connection.pathOrigin.x)&&Number.isFinite(connection.pathOrigin.y)&&Number.isFinite(connection.pathOrigin.elevation) ? connection.pathOrigin : undefined,
      bendOffset: connection.bendOffset && Number.isFinite(connection.bendOffset.x) && Number.isFinite(connection.bendOffset.y) ? { x: connection.bendOffset.x, y: connection.bendOffset.y } : undefined,
    }];
  });
}

function sanitizeWallDeletions(value: unknown): WallDeletion[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate, index): WallDeletion[] => {
    if (!candidate || typeof candidate !== "object") return [];
    const deletion = candidate as Partial<WallDeletion>;
    if (!Number.isFinite(deletion.cx) || !Number.isFinite(deletion.cy) || (deletion.axis !== "horizontal" && deletion.axis !== "vertical")) return [];
    return [{
      id: typeof deletion.id === "string" ? deletion.id : `wall-deletion-${index}`,
      cx: Number(deletion.cx),
      cy: Number(deletion.cy),
      axis: deletion.axis,
      roomId: typeof deletion.roomId === "string" ? deletion.roomId : undefined,
      elevation: Number.isFinite(deletion.elevation) ? Number(deletion.elevation) : 0,
    }];
  });
}

function sanitizeManualWalls(value: unknown): ManualWall[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate, index): ManualWall[] => {
    if (!candidate || typeof candidate !== "object") return [];
    const wall = candidate as Partial<ManualWall>;
    if (!wall.start || !wall.end || !Number.isFinite(wall.start.x) || !Number.isFinite(wall.start.y) || !Number.isFinite(wall.end.x) || !Number.isFinite(wall.end.y)) return [];
    const kind: ManualWallKind = wall.kind === "diagonal" || wall.kind === "curve" ? wall.kind : "straight";
    const assembly = wall.assembly === "balcony-railing" ? "balcony-railing" as const : undefined;
    const moduleSize = assembly === "balcony-railing" ? 1 : CELL_SIZE;
    const start = { x: Math.round(Number(wall.start.x) * 10_000) / 10_000, y: Math.round(Number(wall.start.y) * 10_000) / 10_000 };
    const rawEnd = { x: Math.round(Number(wall.end.x) * 10_000) / 10_000, y: Math.round(Number(wall.end.y) * 10_000) / 10_000 };
    const end = kind === "straight"
      ? (Math.abs(rawEnd.x - start.x) >= Math.abs(rawEnd.y - start.y)
        ? { x: start.x + Math.sign(rawEnd.x - start.x) * Math.round(Math.abs(rawEnd.x - start.x) / moduleSize) * moduleSize, y: start.y }
        : { x: start.x, y: start.y + Math.sign(rawEnd.y - start.y) * Math.round(Math.abs(rawEnd.y - start.y) / moduleSize) * moduleSize })
      : rawEnd;
    if (start.x === end.x && start.y === end.y) return [];
    const control = kind === "curve" && wall.control && Number.isFinite(wall.control.x) && Number.isFinite(wall.control.y)
      ? { x: Math.round(Number(wall.control.x) * 2) / 2, y: Math.round(Number(wall.control.y) * 2) / 2 }
      : undefined;
    const arcPoint = kind === "curve" && wall.arcPoint && Number.isFinite(wall.arcPoint.x) && Number.isFinite(wall.arcPoint.y)
      ? { x: Math.round(Number(wall.arcPoint.x) / CELL_SIZE) * CELL_SIZE, y: Math.round(Number(wall.arcPoint.y) / CELL_SIZE) * CELL_SIZE }
      : undefined;
    const id = typeof wall.id === "string" ? wall.id : `wall-import-${index}`;
    const openings = Array.isArray(wall.openings) ? wall.openings.flatMap((candidate, openingIndex) => {
      if (!candidate || typeof candidate !== "object") return [];
      const opening = candidate as Partial<Room["openings"][number]>;
      if (!isOpeningAsset(opening.asset) || !Number.isFinite(opening.cx) || !Number.isFinite(opening.cy) || !Number.isFinite(opening.rotation)) return [];
      return [{ id: typeof opening.id === "string" ? opening.id : `manual-opening-${index}-${openingIndex}`, roomId: `manual-${id}`, manualWallId: id, asset: opening.asset, cx: Number(opening.cx), cy: Number(opening.cy), rotation: Number(opening.rotation) }];
    }) : [];
    return [{ id, assembly, start, end, kind, control, arcPoint, openings, elevationSteps: Number.isFinite(wall.elevationSteps) ? Number(wall.elevationSteps!) : 0 }];
  });
}

interface ToastState {
  id: number;
  message: string;
}

function isVariant(value: unknown): value is Variant {
  return value === "A" || value === "B" || value === "C";
}

function sanitizeSettings(value: unknown): BuildSettings {
  if (!value || typeof value !== "object") return DEFAULT_SETTINGS;
  const input = value as Partial<BuildSettings>;
  return {
    floorVariant: isVariant(input.floorVariant) ? input.floorVariant : DEFAULT_SETTINGS.floorVariant,
    wallVariant: isVariant(input.wallVariant) ? input.wallVariant : DEFAULT_SETTINGS.wallVariant,
    innerWallVariant: isVariant(input.innerWallVariant) ? input.innerWallVariant : DEFAULT_SETTINGS.innerWallVariant,
    outerWallVariant: isVariant(input.outerWallVariant) ? input.outerWallVariant : DEFAULT_SETTINGS.outerWallVariant,
    flipInnerWall: LOCKED_INNER_WALL_FLIP,
    flipOuterWall: LOCKED_OUTER_WALL_FLIP,
    wallOrientationVersion: 1,
    showInnerWalls: typeof input.showInnerWalls === "boolean" ? input.showInnerWalls : DEFAULT_SETTINGS.showInnerWalls,
    showOuterWalls: typeof input.showOuterWalls === "boolean" ? input.showOuterWalls : DEFAULT_SETTINGS.showOuterWalls,
    innerWallOffset: LOCKED_INNER_WALL_OFFSET,
    outerWallOffset: LOCKED_OUTER_WALL_OFFSET,
    cornerVariant: isVariant(input.cornerVariant) ? input.cornerVariant : DEFAULT_SETTINGS.cornerVariant,
    pillarVariant: isVariant(input.pillarVariant) ? input.pillarVariant : DEFAULT_SETTINGS.pillarVariant,
    randomizeWalls: typeof input.randomizeWalls === "boolean" ? input.randomizeWalls : DEFAULT_SETTINGS.randomizeWalls,
    randomSeed: Number.isInteger(input.randomSeed) && Number(input.randomSeed) >= 0 ? Number(input.randomSeed) : DEFAULT_SETTINGS.randomSeed,
    addPillars: typeof input.addPillars === "boolean" ? input.addPillars : DEFAULT_SETTINGS.addPillars,
    pillarInset: Number.isFinite(input.pillarInset) ? Math.min(2, Math.max(0, Number(input.pillarInset))) : DEFAULT_SETTINGS.pillarInset,
    curveQuality: Number.isFinite(input.curveQuality) ? Math.min(128, Math.max(64, Math.trunc(Number(input.curveQuality)))) : DEFAULT_SETTINGS.curveQuality,
    sharedWallSeparation: Number.isFinite(input.sharedWallSeparation) ? Math.min(0.25, Math.max(0, Number(input.sharedWallSeparation))) : DEFAULT_SETTINGS.sharedWallSeparation,
    dynamicLighting: typeof input.dynamicLighting === "boolean" ? input.dynamicLighting : DEFAULT_SETTINGS.dynamicLighting,
    timeOfDay: Number.isFinite(input.timeOfDay) ? Math.min(24, Math.max(0, Number(input.timeOfDay))) : DEFAULT_SETTINGS.timeOfDay,
    ambientLight: Number.isFinite(input.ambientLight) ? Math.min(2.5, Math.max(0.1, Number(input.ambientLight))) : DEFAULT_SETTINGS.ambientLight,
    exposure: Number.isFinite(input.exposure) ? Math.min(1.6, Math.max(0.5, Number(input.exposure))) : DEFAULT_SETTINGS.exposure,
    hdriBackground: typeof input.hdriBackground === "boolean" ? input.hdriBackground : DEFAULT_SETTINGS.hdriBackground,
    hdriIntensity: Number.isFinite(input.hdriIntensity) ? Math.min(3, Math.max(0, Number(input.hdriIntensity))) : DEFAULT_SETTINGS.hdriIntensity,
    hdriRotation: Number.isFinite(input.hdriRotation) ? Math.min(360, Math.max(0, Number(input.hdriRotation))) : DEFAULT_SETTINGS.hdriRotation,
    moduleWallVariant: isWallModuleVariant(input.moduleWallVariant) ? input.moduleWallVariant : DEFAULT_SETTINGS.moduleWallVariant,
    modulePillarVariant: isPillarModuleVariant(input.modulePillarVariant) ? input.modulePillarVariant : DEFAULT_SETTINGS.modulePillarVariant,
    terrainEnabled: typeof input.terrainEnabled === "boolean" ? input.terrainEnabled : DEFAULT_SETTINGS.terrainEnabled,
    gridVisible: input.gridVisible !== false,
    terrainBrushRadius: Number.isFinite(input.terrainBrushRadius) ? Math.min(8, Math.max(1, Math.round(Number(input.terrainBrushRadius)))) : DEFAULT_SETTINGS.terrainBrushRadius,
    terrainBrushStep: Number.isFinite(input.terrainBrushStep) ? Math.min(4, Math.max(0.05, Number(input.terrainBrushStep))) : DEFAULT_SETTINGS.terrainBrushStep,
    terrainTexture: input.terrainTexture === "ground-rocks" || input.terrainTexture === "cliff-rocks" ? input.terrainTexture : "grass",
    terrainEdgeProfile: input.terrainEdgeProfile === "cliff" ? "cliff" : "smooth",
    terrainSlopeWidth: Number.isFinite(input.terrainSlopeWidth) ? Math.min(8, Math.max(0.25, Number(input.terrainSlopeWidth))) : 2,
    terrainMeshResolution: Number.isFinite(input.terrainMeshResolution) ? Math.min(10, Math.max(1, Math.round(Number(input.terrainMeshResolution)))) : DEFAULT_SETTINGS.terrainMeshResolution,
    terrainPaintMode: input.terrainPaintMode === true,
    terrainPaintSize: Math.max(0.5, Math.min(40, Number(input.terrainPaintSize) || 4)),
    terrainPaintIntensity: Math.max(0.01, Math.min(1, Number(input.terrainPaintIntensity) || 0.5)),
    terrainPaintFalloff: Number.isFinite(input.terrainPaintFalloff) ? Math.max(0, Math.min(1, Number(input.terrainPaintFalloff))) : 0.75,
    terrainPaintTexture: input.terrainPaintTexture === "ground-rocks" || input.terrainPaintTexture === "cliff-rocks" ? input.terrainPaintTexture : "grass",
  };
}

function sanitizeCornerEdit(value: unknown): CornerEdit | null {
  if (!value || typeof value !== "object") return null;
  const edit = value as Partial<CornerEdit>;
  if (!Number.isInteger(edit.vertexX) || !Number.isInteger(edit.vertexY)) return null;
  if (edit.shape !== "diagonal" && edit.shape !== "curve") return null;
  return {
    vertexX: Number(edit.vertexX),
    vertexY: Number(edit.vertexY),
    insetCells: Math.max(1, Math.trunc(Number(edit.insetCells) || 1)),
    shape: edit.shape,
    inverted: edit.inverted === true,
  };
}

function connectedComponents(cells: Cell[]) {
  const byKey = new Map(cells.map((cell) => [`${cell.x},${cell.y}`, cell]));
  const remaining = new Set(byKey.keys());
  const components: Cell[][] = [];
  for (const key of byKey.keys()) {
    if (!remaining.delete(key)) continue;
    const component: Cell[] = [];
    const queue = [byKey.get(key)!];
    while (queue.length) {
      const cell = queue.pop()!;
      component.push(cell);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const neighborKey = `${cell.x + dx},${cell.y + dy}`;
        if (!remaining.delete(neighborKey)) continue;
        queue.push(byKey.get(neighborKey)!);
      }
    }
    components.push(normalizeCells(component));
  }
  return components;
}

/** Circles carry their own geometry, so they survive sanitising even when the room owns no cells. */
function sanitizeCircles(value: unknown): CircleShape[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate): CircleShape[] => {
    if (!candidate || typeof candidate !== "object") return [];
    const { cx, cy, radius } = candidate as Partial<CircleShape>;
    if (!Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(radius)) return [];
    const clamped = Math.max(MIN_CIRCLE_RADIUS, Math.round(radius as number));
    return [{ cx: cx as number, cy: cy as number, radius: clamped }];
  });
}

function sanitizeRooms(value: unknown, cells: Cell[], settings: BuildSettings): Room[] {
  const validCells = new Set(cells.map((cell) => `${cell.x},${cell.y}`));
  const source = Array.isArray(value) ? value : [];
  const rooms = source.flatMap((candidate, index): Room[] => {
    if (!candidate || typeof candidate !== "object") return [];
    const input = candidate as Partial<Room>;
    const roomCells = normalizeCells(Array.isArray(input.cells) ? input.cells : [])
      .filter((cell) => validCells.has(`${cell.x},${cell.y}`));
    const circles = sanitizeCircles(input.circles);
    if (!roomCells.length && !circles.length) return [];
    return [{
      id: typeof input.id === "string" && input.id ? input.id : `room-import-${index}`,
      cells: roomCells,
      autoOpenings: input.autoOpenings === true,
      circles,
      style: {
        innerWallVariant: isVariant(input.style?.innerWallVariant) ? input.style.innerWallVariant : settings.innerWallVariant,
        outerWallVariant: isVariant(input.style?.outerWallVariant) ? input.style.outerWallVariant : settings.outerWallVariant,
      },
      cornerEdits: Array.isArray(input.cornerEdits) ? input.cornerEdits.map(sanitizeCornerEdit).filter((edit): edit is CornerEdit => edit !== null) : [],
      openings: Array.isArray(input.openings) ? input.openings.flatMap((candidate) => {
        if (!candidate || typeof candidate !== "object") return [];
        const opening = candidate as Partial<Room["openings"][number]>;
        if (!isOpeningAsset(opening.asset) || !Number.isFinite(opening.cx) || !Number.isFinite(opening.cy) || !Number.isFinite(opening.rotation)) return [];
        return [{ id: typeof opening.id === "string" ? opening.id : `opening-${index}-${Date.now()}`, roomId: typeof opening.roomId === "string" ? opening.roomId : input.id ?? `room-import-${index}`, asset: opening.asset, cx: Number(opening.cx), cy: Number(opening.cy), rotation: Number(opening.rotation), automatic: opening.automatic === true, suppressed: opening.suppressed === true }];
      }) : [],
      elevationSteps: Number.isFinite(input.elevationSteps) ? Number(input.elevationSteps) : 0,
      buildingId: typeof input.buildingId === "string" ? input.buildingId : undefined,
      foundationHeight: Number.isFinite(input.foundationHeight) ? Number(input.foundationHeight) : undefined,
    }];
  });
  if (rooms.length) return rooms;
  return connectedComponents(cells).map((roomCells, index) => ({
    id: `room-migrated-${index + 1}`,
    cells: roomCells,
    circles: [],
    style: { innerWallVariant: settings.innerWallVariant, outerWallVariant: settings.outerWallVariant },
    cornerEdits: [],
    openings: [],
    elevationSteps: 0,
  }));
}

function loadProject(): ProjectState {
  try {
    const raw = [STORAGE_KEY, ...LEGACY_STORAGE_KEYS].reduce<string | null>(
      (found, key) => found ?? localStorage.getItem(key),
      null,
    );
    if (!raw) throw new Error("No saved project");
    const saved = JSON.parse(raw) as Partial<SavedProject>;
    if (!Array.isArray(saved.cells)) throw new Error("Invalid saved project");
    const settings = sanitizeSettings(saved.settings);
    const cells = normalizeCells(saved.cells).slice(0, MAX_CELLS);
    return {
      name: typeof saved.name === "string" && saved.name.trim() ? saved.name.slice(0, 64) : "Untitled interior",
      cells,
      rooms: sanitizeRooms(saved.rooms, cells, settings),
      manualWalls: sanitizeManualWalls(saved.manualWalls),
      wallDeletions: sanitizeWallDeletions(saved.wallDeletions),
      floors: sanitizeFloors(saved.floors),
      stairs: sanitizeStairs(saved.stairs),
      placedPillars: sanitizePlacedPillars(saved.placedPillars),
      terrain: sanitizeTerrain(saved.terrain),
      terrainRegions: sanitizeTerrainRegions(saved.terrainRegions),
      roomConnections: sanitizeRoomConnections(saved.roomConnections),
      activeGridLevel: Number.isFinite(saved.activeGridLevel) ? Math.trunc(saved.activeGridLevel!) : 0,
      activeBuildingId: typeof saved.activeBuildingId === "string" ? saved.activeBuildingId : null,
      settings,
    };
  } catch {
    return { name: "Atrium study", cells: EXAMPLE_CELLS, rooms: sanitizeRooms([], EXAMPLE_CELLS, DEFAULT_SETTINGS), manualWalls: [], wallDeletions: [], floors: [], stairs: [], placedPillars: [], terrain: [], terrainRegions: [], roomConnections: [], settings: DEFAULT_SETTINGS };
  }
}

function sameCells(a: Cell[], b: Cell[]) {
  if (a.length !== b.length) return false;
  return a.every((cell, index) => cell.x === b[index]?.x && cell.y === b[index]?.y);
}

/** Undo has to carry rooms as well as cells, or corner edits and circles are lost on the way back. */
interface HistoryEntry {
  cells: Cell[];
  rooms: Room[];
  manualWalls: ManualWall[];
  wallDeletions: WallDeletion[];
  floors: FloorRegion[];
  stairs: StairPlacement[];
  placedPillars: PillarPlacement[];
  terrain: TerrainCell[];
  terrainRegions: TerrainRegion[];
  roomConnections: RoomConnection[];
}

/**
 * A drawn rectangle that lands on an existing room extends it rather than stacking a second
 * room on the same footprint. Overlapping a circular part counts too: the boolean union then
 * renders the pair as one continuous boundary.
 */
function mergeDrawnRoom(rooms: Room[], drawn: Cell[], settings: BuildSettings, elevationSteps = 0, buildingId = "world", foundationHeight = 0): Room[] {
  const incoming = normalizeCells(drawn);
  if (!incoming.length) return rooms;
  const incomingKeys = new Set(incoming.map((cell) => `${cell.x},${cell.y}`));
  const overlapping = rooms.filter((room) => buildingIdForRoom(room) === buildingId && (room.elevationSteps ?? 0) === elevationSteps && (room.cells.some((cell) => incomingKeys.has(`${cell.x},${cell.y}`))
    || room.circles.some((circle) => circleOverlapsCells(circle, incoming))));
  const separate = rooms.filter((room) => !overlapping.includes(room));
  if (overlapping.length) {
    separate.push({
      ...overlapping[0],
      autoOpenings: overlapping.some(room => room.autoOpenings),
      cells: normalizeCells([...incoming, ...overlapping.flatMap((room) => room.cells)]),
      circles: overlapping.flatMap((room) => room.circles),
      cornerEdits: overlapping.flatMap((room) => room.cornerEdits),
      openings: overlapping.flatMap((room) => room.openings),
    });
  } else {
    separate.push({
      id: `room-${Date.now()}`,
      cells: incoming,
      circles: [],
      style: { innerWallVariant: settings.innerWallVariant, outerWallVariant: settings.outerWallVariant },
      cornerEdits: [],
      openings: [],
      elevationSteps,
      buildingId,
      foundationHeight,
    });
  }
  return separate;
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("en", { maximumFractionDigits: 1 }).format(value);
}

function formatTimeOfDay(value: number) {
  const minutes = Math.round(value * 60) % (24 * 60);
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  return `${hour.toString().padStart(2, "0")}:${minute.toString().padStart(2, "0")}`;
}

function SelectField({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: Variant;
  options: Array<{ value: Variant; label: string }>;
  onChange: (value: Variant) => void;
  disabled?: boolean;
}) {
  return (
    <label className={`field-row${disabled ? " is-disabled" : ""}`}>
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value as Variant)} disabled={disabled}>
        {options.map((option) => <option key={option.value} value={option.value}>{option.value} · {option.label}</option>)}
      </select>
    </label>
  );
}

function Switch({ checked, onChange, label }: { checked: boolean; onChange: (value: boolean) => void; label: string }) {
  return (
    <label className="switch-row">
      <span>{label}</span>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <i aria-hidden="true"><b /></i>
    </label>
  );
}

export default function App() {
  const initialProject = useMemo(loadProject, []);
  const [projectName, setProjectName] = useState(initialProject.name);
  const [cells, setCells] = useState(initialProject.cells);
  const [rooms, setRooms] = useState(initialProject.rooms);
  const [manualWalls, setManualWalls] = useState(initialProject.manualWalls);
  const [wallDeletions, setWallDeletions] = useState(initialProject.wallDeletions);
  const [floors, setFloors] = useState(initialProject.floors);
  const [stairs, setStairs] = useState(initialProject.stairs);
  const [placedPillars, setPlacedPillars] = useState(initialProject.placedPillars);
  const [terrain, setTerrain] = useState(initialProject.terrain);
  const [terrainRegions, setTerrainRegions] = useState(initialProject.terrainRegions);
  const [roomConnections, setRoomConnections] = useState(initialProject.roomConnections);
  const [settings, setSettings] = useState(initialProject.settings);
  const [activeGridLevel, setActiveGridLevel] = useState(initialProject.activeGridLevel ?? 0);
  const [activeBuildingId, setActiveBuildingId] = useState<string | null>(initialProject.activeBuildingId ?? null);
  const activeBuilding = rooms.find((room) => buildingIdForRoom(room) === activeBuildingId);
  const activeContextId = activeBuilding ? activeBuildingId : activeBuildingId === "world" ? "world" : null;
  const activeFoundation = activeBuilding ? foundationHeightForRoom(activeBuilding) : 0;
  const activeGridElevation = activeFoundation + activeGridLevel * GRID_LEVEL_HEIGHT;
  const [tool, setTool] = useState<EditorTool>("draw");
  const [wallDrawMode, setWallDrawMode] = useState<WallDrawMode>("path");
  const [toolGroup, setToolGroup] = useState<"room" | "wall" | "floor" | "terrain">("room");
  const [terrainMode, setTerrainMode] = useState<TerrainBrushMode>("raise");
  const [openingAsset, setOpeningAsset] = useState<OpeningAsset | null>("WD_1");
  const [stairAsset, setStairAsset] = useState<StairAsset>("ST_2.5x2_1");
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);
  const [selectedRoomIds, setSelectedRoomIds] = useState<string[]>([]);
  const [activeCorner, setActiveCorner] = useState<{ roomId: string; vertexX: number; vertexY: number } | null>(null);
  const [selectedFloorId, setSelectedFloorId] = useState<string | null>(null);
  const [selectedFloorCells, setSelectedFloorCells] = useState<Cell[] | null>(null);
  const [selectedFloorAreas, setSelectedFloorAreas] = useState<Array<{ floorId: string; cells: Cell[] }>>([]);
  const [activeFloorCorner, setActiveFloorCorner] = useState<{ roomId: string; vertexX: number; vertexY: number } | null>(null);
  const [fitSignal, setFitSignal] = useState(0);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [saveStatus, setSaveStatus] = useState<"saved" | "saving">("saved");
  const undoStack = useRef<HistoryEntry[]>([]);
  const redoStack = useRef<HistoryEntry[]>([]);
  const cellsRef = useRef(cells);
  const roomsRef = useRef(rooms);
  const manualWallsRef = useRef(manualWalls);
  const wallDeletionsRef = useRef(wallDeletions);
  const floorsRef = useRef(floors);
  const stairsRef = useRef(stairs);
  const placedPillarsRef = useRef(placedPillars);
  const terrainRef = useRef(terrain);
  const terrainRegionsRef = useRef(terrainRegions);
  const roomConnectionsRef = useRef(roomConnections);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const hdriInputRef = useRef<HTMLInputElement>(null);
  const cubeMapInputRef = useRef<HTMLInputElement>(null);
  const toastTimeoutRef = useRef<number | null>(null);
  const [hdriUrl, setHdriUrl] = useState<string | null>(null);
  const [hdriName, setHdriName] = useState<string | null>(null);
  const [hdriKind, setHdriKind] = useState<"hdr" | "exr" | null>(null);
  const [cubeMapUrls, setCubeMapUrls] = useState<[string, string, string, string, string, string] | null>(null);
  const layoutSettingsKey = JSON.stringify(Object.fromEntries(Object.entries(settings).filter(([key]) => !key.startsWith("terrain"))));
  const layoutSettings = useMemo(() => JSON.parse(layoutSettingsKey) as BuildSettings, [layoutSettingsKey]);
  const layout = useMemo(() => buildLayout(cells, layoutSettings, rooms, manualWalls, wallDeletions, floors), [cells, layoutSettings, rooms, manualWalls, wallDeletions, floors]);
  const gridLayout = useMemo(() => {
    const levelRooms = rooms.filter(room => onGridLevel(room.elevationSteps, activeGridLevel, activeFoundation));
    return buildLayout(normalizeCells(levelRooms.flatMap(room => room.cells)), layoutSettings, levelRooms,
      manualWalls.filter(wall => onGridLevel(wall.elevationSteps, activeGridLevel, activeFoundation)), wallDeletions,
      floors.filter(floor => onGridLevel(floor.elevationSteps, activeGridLevel, activeFoundation)));
  }, [rooms, manualWalls, wallDeletions, floors, layoutSettings, activeGridLevel, activeFoundation]);
  const visibleGridLayout = useMemo(() => {
    const visibleRooms = rooms.filter(room => visibleAtOrBelowGridLevel(room.elevationSteps, activeGridLevel, room.foundationHeight ?? 0));
    return buildLayout(normalizeCells(visibleRooms.flatMap(room => room.cells)), layoutSettings, visibleRooms,
      manualWalls.filter(wall => visibleAtOrBelowGridLevel(wall.elevationSteps, activeGridLevel, activeFoundation)), wallDeletions,
      floors.filter(floor => visibleAtOrBelowGridLevel(floor.elevationSteps, activeGridLevel, activeFoundation)));
  }, [rooms, manualWalls, wallDeletions, floors, layoutSettings, activeGridLevel, activeFoundation]);
  const visibleStairs = useMemo(() => stairs.filter((stair) =>
    visibleAtOrBelowGridLevel(stair.elevationSteps, activeGridLevel, activeFoundation)), [stairs, activeGridLevel, activeFoundation]);
  const visiblePlacedPillars = useMemo(() => placedPillars.filter((pillar) =>
    visibleAtOrBelowGridLevel(pillar.elevationSteps, activeGridLevel, activeFoundation)), [placedPillars, activeGridLevel, activeFoundation]);
  const switchGrid = (level: number) => {
    setActiveGridLevel(Math.trunc(level));
    setSelectedFloorId(null);
    setSelectedFloorCells(null);
    setSelectedFloorAreas([]);
    setActiveFloorCorner(null);
  };
  cellsRef.current = cells;
  roomsRef.current = rooms;
  manualWallsRef.current = manualWalls;
  wallDeletionsRef.current = wallDeletions;
  floorsRef.current = floors;
  stairsRef.current = stairs;
  placedPillarsRef.current = placedPillars;
  terrainRef.current = terrain;
  terrainRegionsRef.current = terrainRegions;
  roomConnectionsRef.current = roomConnections;

  const notify = useCallback((message: string) => {
    if (toastTimeoutRef.current) window.clearTimeout(toastTimeoutRef.current);
    setToast({ id: Date.now(), message });
    toastTimeoutRef.current = window.setTimeout(() => setToast(null), 3200);
  }, []);

  useEffect(() => {
    const invalidIds = sharedWindowIds(layout.openings, layout.walls);
    if (!invalidIds.size) return;
    const nextRooms = roomsRef.current.map((room) => ({
      ...room,
      openings: room.openings.filter((opening) => !invalidIds.has(opening.id)),
    }));
    roomsRef.current = nextRooms;
    setRooms(nextRooms);
    notify(`${invalidIds.size} window${invalidIds.size === 1 ? " was" : "s were"} removed from shared walls.`);
  }, [layout.openings, layout.walls, notify]);

  useEffect(() => () => {
    if (hdriUrl) URL.revokeObjectURL(hdriUrl);
  }, [hdriUrl]);
  useEffect(() => () => {
    cubeMapUrls?.forEach((url) => URL.revokeObjectURL(url));
  }, [cubeMapUrls]);

  /** Room-only changes (corner edits, circle resize) deliberately do not touch history. */
  const updateRooms = useCallback((updater: (current: Room[]) => Room[]) => {
    const edited = updater(roomsRef.current);
    const next = reconcileAutoOpenings(cellsRef.current, edited, settings, manualWallsRef.current, wallDeletionsRef.current, floorsRef.current, terrainRef.current, terrainRegionsRef.current);
    if (edited.some(room => room.openings.some(o => !o.automatic && !o.suppressed && !next.some(r => r.openings.some(n => n.id === o.id))))) notify("A manual opening no longer fits a surviving wall and was removed.");
    roomsRef.current = next;
    setRooms(next);
  }, [settings, notify]);

  const commitPlan = useCallback((nextCells: Cell[], nextRooms: Room[], nextManualWalls = manualWallsRef.current, nextWallDeletions = wallDeletionsRef.current, nextFloors = floorsRef.current, nextStairs = stairsRef.current, nextPlacedPillars = placedPillarsRef.current, nextTerrain = terrainRef.current, nextTerrainRegions = terrainRegionsRef.current, nextRoomConnections = roomConnectionsRef.current) => {
    const beforeOpenings = nextRooms.flatMap(room => room.openings).filter(o => !o.automatic && !o.suppressed);
    nextRooms = reconcileAutoOpenings(nextCells, nextRooms.map(room => roomsRef.current.some(previous => previous.id === room.id) ? room : { ...room, autoOpenings: true }), settings, nextManualWalls, nextWallDeletions, nextFloors, nextTerrain, nextTerrainRegions);
    if (beforeOpenings.some(o => !nextRooms.some(r => r.openings.some(n => n.id === o.id)))) notify("A manual opening no longer fits a surviving wall and was removed. Undo restores it.");
    else if (nextRooms.some(room => room.autoOpenings && !roomsRef.current.some(r => r.id === room.id) && !room.openings.some(o => !o.suppressed && !openingIsWindow(o.asset)))) notify("No terrain-clear entrance fits this room. Add access manually after adjusting terrain or walls.");
    const candidateCells = normalizeCells(nextCells);
    const normalized = sameCells(cellsRef.current, candidateCells) ? cellsRef.current : candidateCells;
    if (sameCells(cellsRef.current, normalized) && nextRooms === roomsRef.current && nextManualWalls === manualWallsRef.current && nextWallDeletions === wallDeletionsRef.current && nextFloors === floorsRef.current && nextStairs === stairsRef.current && nextPlacedPillars === placedPillarsRef.current && nextTerrain === terrainRef.current && nextTerrainRegions === terrainRegionsRef.current && nextRoomConnections === roomConnectionsRef.current) return;
    undoStack.current.push({ cells: cellsRef.current, rooms: roomsRef.current, manualWalls: manualWallsRef.current, wallDeletions: wallDeletionsRef.current, floors: floorsRef.current, stairs: stairsRef.current, placedPillars: placedPillarsRef.current, terrain: terrainRef.current, terrainRegions: terrainRegionsRef.current, roomConnections: roomConnectionsRef.current });
    if (undoStack.current.length > HISTORY_LIMIT) undoStack.current.shift();
    redoStack.current = [];
    cellsRef.current = normalized;
    roomsRef.current = nextRooms;
    manualWallsRef.current = nextManualWalls;
    wallDeletionsRef.current = nextWallDeletions;
    floorsRef.current = nextFloors;
    stairsRef.current = nextStairs;
    placedPillarsRef.current = nextPlacedPillars;
    terrainRef.current = nextTerrain;
    terrainRegionsRef.current = nextTerrainRegions;
    roomConnectionsRef.current = nextRoomConnections;
    setCells(normalized);
    setRooms(nextRooms);
    setManualWalls(nextManualWalls);
    setWallDeletions(nextWallDeletions);
    setFloors(nextFloors);
    setStairs(nextStairs);
    setPlacedPillars(nextPlacedPillars);
    setTerrain(nextTerrain);
    setTerrainRegions(nextTerrainRegions);
    setRoomConnections(nextRoomConnections);
  }, [settings, notify]);

  const applyPlanAction = useCallback((action: PlanAction) => {
    const currentCells = cellsRef.current;
    const currentRooms = roomsRef.current;
    if(action.type === "save-pathway") {
      const openings=action.openings??[];
      const nextRooms=currentRooms.map(room=>({...room,openings:[...room.openings.filter(o=>!openings.some(n=>n.roomId===room.id&&Math.hypot(o.cx-n.cx,o.cy-n.cy)<0.05)),...openings.filter(o=>o.roomId===room.id)]}));
      const connections=roomConnectionsRef.current.some(c=>c.id===action.connection.id)?roomConnectionsRef.current.map(c=>c.id===action.connection.id?action.connection:c):[...roomConnectionsRef.current,action.connection];
      commitPlan(currentCells,nextRooms,manualWallsRef.current,wallDeletionsRef.current,floorsRef.current,stairsRef.current,placedPillarsRef.current,terrainRef.current,terrainRegionsRef.current,connections);
      return;
    }
    if (action.type === "connect-rooms") {
      if (roomConnectionsRef.current.some(c => [c.fromRoomId,c.toRoomId].includes(action.fromRoomId) && [c.fromRoomId,c.toRoomId].includes(action.toRoomId))) { notify("These rooms already have a connection."); return; }
      const fullLayout = buildLayout(currentCells, settings, currentRooms, manualWallsRef.current, wallDeletionsRef.current, floorsRef.current);
      const planned = planRoomConnection(action.fromRoomId, action.toRoomId, currentRooms, fullLayout);
      if (!planned) { notify("No route fits. Use straight exterior walls and a height difference in 1.25 m increments."); return; }
      commitPlan(currentCells, planned.rooms, manualWallsRef.current, wallDeletionsRef.current, floorsRef.current, stairsRef.current, placedPillarsRef.current, terrainRef.current, terrainRegionsRef.current, [...roomConnectionsRef.current, planned.connection]);
      return;
    }
    if (action.type === "remove-connection" || action.type === "bend-connection") {
      const existing = roomConnectionsRef.current.find(c => c.id === action.id);
      if (!existing) return;
      let next = roomConnectionsRef.current.filter(c => c.id !== action.id);
      if (action.type === "bend-connection") {
        const opening = currentRooms.find(r => r.id === existing.fromRoomId)?.openings.find(o => o.id === existing.fromOpeningId);
        if (!opening) return;
        const edited = { ...existing, bendOffset: { x: action.point.x-opening.cx, y:action.point.y-opening.cy } };
        if (!buildConnectionGeometry(edited,currentRooms)) { notify("This route is no longer valid."); return; }
        next = roomConnectionsRef.current.map(c => c.id === action.id ? edited : c);
      }
      commitPlan(currentCells,currentRooms,manualWallsRef.current,wallDeletionsRef.current,floorsRef.current,stairsRef.current,placedPillarsRef.current,terrainRef.current,terrainRegionsRef.current,next);
      return;
    }
    let foundationHeight = activeFoundation;
    const buildingId = activeContextId ?? `building-${Date.now()}`;
    if ((action.type === "draw" || action.type === "circle") && !activeContextId) {
      const candidate: Room = { id: "placement", cells: action.type === "draw" ? action.cells : [], circles: action.type === "circle" ? [action.circle] : [], cornerEdits: [], openings: [], style: { innerWallVariant: settings.innerWallVariant, outerWallVariant: settings.outerWallVariant } };
      foundationHeight = foundationForRoom(candidate, terrainRef.current, terrainRegionsRef.current);
    }
    const elevationSteps = (foundationHeight + activeGridLevel * GRID_LEVEL_HEIGHT) / ROOM_ELEVATION_STEP;

    if (action.type === "terrain-stroke") {
      const nextTerrain = applyTerrainStroke(terrainRef.current, action.cells, action.mode, settings.terrainBrushRadius ?? 2, settings.terrainBrushStep ?? 0.5);
      commitPlan(currentCells, currentRooms, manualWallsRef.current, wallDeletionsRef.current, floorsRef.current, stairsRef.current, placedPillarsRef.current, nextTerrain);
      return;
    }

    if (action.type === "terrain-spline") {
      const nextTerrain = applyTerrainSpline(terrainRef.current, action.points, action.mode, settings.terrainBrushStep ?? 0.5, action.edgeProfile, settings.terrainSlopeWidth ?? 2);
      commitPlan(currentCells, currentRooms, manualWallsRef.current, wallDeletionsRef.current, floorsRef.current, stairsRef.current, placedPillarsRef.current, nextTerrain);
      return;
    }

    if (action.type === "add-terrain-region") {
      commitPlan(currentCells, currentRooms, manualWallsRef.current, wallDeletionsRef.current, floorsRef.current, stairsRef.current, placedPillarsRef.current, terrainRef.current, [...terrainRegionsRef.current, action.region]);
      return;
    }

    if (action.type === "replace-terrain-region" || action.type === "remove-terrain-region") {
      const next = action.type === "remove-terrain-region"
        ? terrainRegionsRef.current.filter((region) => region.id !== action.id)
        : terrainRegionsRef.current.map((region) => region.id === action.region.id ? action.region : region);
      commitPlan(currentCells, currentRooms, manualWallsRef.current, wallDeletionsRef.current, floorsRef.current, stairsRef.current, placedPillarsRef.current, terrainRef.current, next);
      return;
    }

    if (action.type === "clear-terrain") {
      if (terrainRef.current.length || terrainRegionsRef.current.length) commitPlan(currentCells, currentRooms, manualWallsRef.current, wallDeletionsRef.current, floorsRef.current, stairsRef.current, placedPillarsRef.current, [], []);
      return;
    }

    if (action.type === "place-stair") {
      const nextStairs = [...stairsRef.current, {
        id: `stair-${Date.now()}`,
        cell: action.cell,
        elevationSteps,
        rotation: 0,
        asset: action.asset,
      }];
      commitPlan(currentCells, currentRooms, manualWallsRef.current, wallDeletionsRef.current, floorsRef.current, nextStairs);
      return;
    }

    if (action.type === "remove-stair") {
      const nextStairs = stairsRef.current.filter((stair) => stair.id !== action.id);
      if (nextStairs.length !== stairsRef.current.length) {
        commitPlan(currentCells, currentRooms, manualWallsRef.current, wallDeletionsRef.current, floorsRef.current, nextStairs);
      }
      return;
    }

    if (action.type === "rotate-stair") {
      const nextStairs = stairsRef.current.map((stair) => stair.id === action.id
        ? { ...stair, rotation: (stair.rotation + Math.PI / 2) % (Math.PI * 2) } : stair);
      commitPlan(currentCells, currentRooms, manualWallsRef.current, wallDeletionsRef.current, floorsRef.current, nextStairs);
      return;
    }

    if (action.type === "place-pillar") {
      const nextPlacedPillars = [...placedPillarsRef.current, {
        id: `pillar-${Date.now()}`,
        point: action.point,
        elevationSteps,
        variant: settings.pillarVariant,
      }];
      commitPlan(currentCells, currentRooms, manualWallsRef.current, wallDeletionsRef.current, floorsRef.current, stairsRef.current, nextPlacedPillars);
      return;
    }

    if (action.type === "remove-pillar") {
      const nextPlacedPillars = placedPillarsRef.current.filter((pillar) => pillar.id !== action.id);
      if (nextPlacedPillars.length !== placedPillarsRef.current.length) {
        commitPlan(currentCells, currentRooms, manualWallsRef.current, wallDeletionsRef.current, floorsRef.current, stairsRef.current, nextPlacedPillars);
      }
      return;
    }

    if (action.type === "draw-floor") {
      const incoming = normalizeCells(action.cells);
      if (!incoming.length) return;
      const incomingKeys = new Set(incoming.map((cell) => `${cell.x},${cell.y}`));
      const overlapping = floorsRef.current.filter((floor) => floor.elevationSteps === elevationSteps
        && floor.cells.some((cell) => incomingKeys.has(`${cell.x},${cell.y}`)));
      const nextFloors = floorsRef.current.filter((floor) => !overlapping.includes(floor));
      if (overlapping.length) {
        nextFloors.push({
          ...overlapping[0],
          cells: normalizeCells([...incoming, ...overlapping.flatMap((floor) => floor.cells)]),
          cornerEdits: overlapping.flatMap((floor) => floor.cornerEdits),
        });
      } else {
        nextFloors.push({ id: `floor-${Date.now()}`, cells: incoming, cornerEdits: [], elevationSteps, variant: "1" });
      }
      commitPlan(currentCells, currentRooms, manualWallsRef.current, wallDeletionsRef.current, nextFloors);
      return;
    }

    if (action.type === "erase-floor") {
      const inside = (cell: Cell) => cell.x >= action.bounds.minX && cell.x <= action.bounds.maxX
        && cell.y >= action.bounds.minY && cell.y <= action.bounds.maxY;
      const nextFloors = floorsRef.current.flatMap((floor): FloorRegion[] => {
        if (!onGridLevel(floor.elevationSteps, activeGridLevel, activeFoundation) || (selectedFloorId && floor.id !== selectedFloorId)) return [floor];
        const floorCells = floor.cells.filter((cell) => !inside(cell));
        return floorCells.length ? [{ ...floor, cells: floorCells }] : [];
      });
      if (nextFloors.some((floor, index) => floor !== floorsRef.current[index]) || nextFloors.length !== floorsRef.current.length) {
        commitPlan(currentCells, currentRooms, manualWallsRef.current, wallDeletionsRef.current, nextFloors);
      }
      return;
    }

    if (action.type === "erase-wall" || action.type === "erase-walls") {
      const targets: WallEraseTarget[] = action.type === "erase-wall" ? [action.target] : [[...gridLayout.walls, ...gridLayout.balconyRailings].flatMap((wall): WallEraseTarget[] => {
        const cx = wall.x + Math.cos(wall.rotation) * wall.length / 2;
        const cy = wall.y + Math.sin(wall.rotation) * wall.length / 2;
        const inside = cx >= action.bounds.minX * CELL_SIZE && cx <= (action.bounds.maxX + 1) * CELL_SIZE
          && cy >= action.bounds.minY * CELL_SIZE && cy <= (action.bounds.maxY + 1) * CELL_SIZE;
        if (!inside) return [];
        return [{
          cx,
          cy,
          axis: Math.abs(Math.cos(wall.rotation)) >= Math.abs(Math.sin(wall.rotation)) ? "horizontal" : "vertical",
          manualWallId: wall.manualWallId,
          manualWallModuleIndex: wall.manualWallModuleIndex,
          roomWall: !wall.manualWallId,
          roomId: wall.roomId,
          elevation: wall.elevation ?? 0,
        }];
      }), ...gridLayout.wallPaths.flatMap((path): WallEraseTarget[] => {
        if (!path.manualWallId) return [];
        const minX = action.bounds.minX * CELL_SIZE;
        const minY = action.bounds.minY * CELL_SIZE;
        const maxX = (action.bounds.maxX + 1) * CELL_SIZE;
        const maxY = (action.bounds.maxY + 1) * CELL_SIZE;
        if (!path.points.some((point) => point.x >= minX && point.x <= maxX && point.y >= minY && point.y <= maxY)) return [];
        const first = path.points[0];
        const last = path.points[path.points.length - 1];
        return [{ cx: (first.x + last.x) / 2, cy: (first.y + last.y) / 2, axis: Math.abs(last.x - first.x) >= Math.abs(last.y - first.y) ? "horizontal" : "vertical", manualWallId: path.manualWallId, manualWallModuleIndex: 0 }];
      })].flat();
      let nextManualWalls = manualWallsRef.current;
      let nextWallDeletions = wallDeletionsRef.current;
      const manualTargets = new Map<string, Set<number>>();
      for (const target of targets) if (target.manualWallId && target.manualWallModuleIndex !== undefined) {
        const indices = manualTargets.get(target.manualWallId) ?? new Set<number>();
        indices.add(target.manualWallModuleIndex);
        manualTargets.set(target.manualWallId, indices);
      }
      for (const [wallId, indices] of manualTargets) nextManualWalls = eraseManualWallModules(nextManualWalls, wallId, indices);
      for (const target of targets) {
        if (!target.manualWallId && target.roomWall && !nextWallDeletions.some((deletion) => deletion.axis === target.axis
          && Math.abs((deletion.elevation ?? 0) - (target.elevation ?? 0)) < 1e-5
          && Math.hypot(deletion.cx - target.cx, deletion.cy - target.cy) < 0.05)) {
          nextWallDeletions = [...nextWallDeletions, { id: `wall-deletion-${Date.now()}-${nextWallDeletions.length}`, cx: target.cx, cy: target.cy, axis: target.axis, roomId: target.roomId, elevation: target.elevation ?? 0 }];
        }
      }
      if (nextManualWalls !== manualWallsRef.current || nextWallDeletions !== wallDeletionsRef.current) {
        commitPlan(currentCells, currentRooms, nextManualWalls, nextWallDeletions);
      }
      return;
    }

    if (action.type === "wall" || action.type === "wall-path" || action.type === "railing-path") {
      const timestamp = Date.now();
      const candidates = action.type === "wall"
        ? [{ id: `wall-${timestamp}`, start: action.start, end: action.end, kind: action.kind, control: action.control, arcPoint: action.arcPoint }]
        : action.points.slice(0, -1).map((start, index) => {
          const end = action.points[index + 1];
          const axisAligned = Math.abs(start.x - end.x) < 1e-6 || Math.abs(start.y - end.y) < 1e-6;
          return { id: `${action.type === "railing-path" ? "railing" : "wall"}-${timestamp}-${index}`, assembly: action.type === "railing-path" ? "balcony-railing" as const : undefined, start, end, kind: axisAligned ? "straight" as const : "diagonal" as const };
        });
      const next = sanitizeManualWalls(candidates.map(wall => ({ ...wall, elevationSteps })));
      if (next.length) commitPlan(currentCells, currentRooms, [...manualWallsRef.current, ...next]);
      return;
    }

    if (action.type === "circle") {
      const { circle } = action;
      // A circle that overlaps existing parts joins that room, so the union renders one
      // continuous boundary instead of a doubled wall through the junction.
      const overlapping = currentRooms.filter((room) => buildingIdForRoom(room) === buildingId && (room.elevationSteps ?? 0) === elevationSteps
        && (circleOverlapsCells(circle, room.cells) || room.circles.some((other) => circlesOverlap(circle, other))));
      const separate = currentRooms.filter((room) => !overlapping.includes(room));
      if (overlapping.length) {
        separate.push({
          ...overlapping[0],
          cells: normalizeCells(overlapping.flatMap((room) => room.cells)),
          circles: [...overlapping.flatMap((room) => room.circles), circle],
          cornerEdits: overlapping.flatMap((room) => room.cornerEdits),
          openings: overlapping.flatMap((room) => room.openings),
        });
      } else {
        separate.push({
          id: `room-${Date.now()}`,
          cells: [],
          circles: [circle],
          style: { innerWallVariant: settings.innerWallVariant, outerWallVariant: settings.outerWallVariant },
          cornerEdits: [],
          openings: [],
          elevationSteps,
          buildingId,
          foundationHeight,
        });
      }
      commitPlan(currentCells, separate);
      setActiveBuildingId(buildingId);
      return;
    }

    if (action.type === "erase") {
      const { bounds } = action;
      const inside = (cell: Cell) => cell.x >= bounds.minX && cell.x <= bounds.maxX && cell.y >= bounds.minY && cell.y <= bounds.maxY;
      let removedCells = 0;
      // A circle has no cells to clip, so an erase that touches it removes it whole.
      let removedCircles = 0;
      const nextRooms = currentRooms.flatMap((room): Room[] => {
        if (!onGridLevel(room.elevationSteps, activeGridLevel, activeFoundation)) return [room];
        const roomCells = room.cells.filter((cell) => !inside(cell));
        const circles = room.circles.filter((circle) => !circleIntersectsCellBounds(circle, bounds));
        removedCircles += room.circles.length - circles.length;
        removedCells += room.cells.length - roomCells.length;
        if (!roomCells.length && !circles.length) return [];
        return [{ ...room, cells: roomCells, circles }];
      });
      if (!removedCells && !removedCircles) return;
      commitPlan(normalizeCells(nextRooms.flatMap(room => room.cells)), nextRooms);
      return;
    }

    const merged = new Map(currentCells.map((cell) => [`${cell.x},${cell.y}`, cell]));
    for (const cell of action.cells) merged.set(`${cell.x},${cell.y}`, cell);
    if (merged.size > MAX_CELLS) {
      notify(`Plans are limited to ${MAX_CELLS.toLocaleString()} cells for browser performance.`);
      return;
    }
    commitPlan([...merged.values()], mergeDrawnRoom(currentRooms, action.cells, settings, elevationSteps, buildingId, foundationHeight));
    setActiveBuildingId(buildingId);
  }, [commitPlan, gridLayout.wallPaths, gridLayout.walls, notify, settings, activeGridLevel, selectedFloorId, activeFoundation, activeContextId]);

  const updateFloors = useCallback((updater: (current: FloorRegion[]) => FloorRegion[]) => {
    const next = updater(floorsRef.current);
    floorsRef.current = next;
    setFloors(next);
  }, []);

  const moveFloor = useCallback((floorId: string, dxCells: number, dyCells: number) => {
    const dx = Math.trunc(dxCells);
    const dy = Math.trunc(dyCells);
    if (!dx && !dy) return;
    const areaMap = new Map(selectedFloorAreas.map((area) => [area.floorId, new Set(area.cells.map((cell) => `${cell.x},${cell.y}`))]));
    const moveSelection = areaMap.size > 0 && areaMap.has(floorId);
    const nextFloors = floorsRef.current.map((floor): FloorRegion => {
      const selectedKeys = moveSelection ? areaMap.get(floor.id) : floor.id === floorId ? new Set(floor.cells.map((cell) => `${cell.x},${cell.y}`)) : undefined;
      if (!selectedKeys?.size) return floor;
      const moving = floor.cells.filter((cell) => selectedKeys.has(`${cell.x},${cell.y}`));
      const staying = floor.cells.filter((cell) => !selectedKeys.has(`${cell.x},${cell.y}`));
      const moved = moving.map((cell) => ({ x: cell.x + dx, y: cell.y + dy }));
      return {
        ...floor,
        cells: normalizeCells([...staying, ...moved]),
        cornerEdits: staying.length ? [] : floor.cornerEdits.map((edit) => ({ ...edit, vertexX: edit.vertexX + dx, vertexY: edit.vertexY + dy })),
      };
    });
    commitPlan(cellsRef.current, roomsRef.current, manualWallsRef.current, wallDeletionsRef.current, nextFloors);
    if (moveSelection) {
      const movedAreas = selectedFloorAreas.map((area) => ({ ...area, cells: area.cells.map((cell) => ({ x: cell.x + dx, y: cell.y + dy })) }));
      setSelectedFloorAreas(movedAreas);
      setSelectedFloorCells(movedAreas.flatMap((area) => area.cells));
    }
  }, [commitPlan, selectedFloorAreas]);

  const splitSelectedFloor = useCallback((variant?: FloorAssetVariant) => {
    if (!selectedFloorId || !selectedFloorCells?.length) return;
    const selectedKeys = new Set(selectedFloorCells.map((cell) => `${cell.x},${cell.y}`));
    const target = floorsRef.current.find((floor) => floor.id === selectedFloorId);
    if (!target) return;
    const selectedCells = target.cells.filter((cell) => selectedKeys.has(`${cell.x},${cell.y}`));
    if (!selectedCells.length) return;
    const remainingCells = target.cells.filter((cell) => !selectedKeys.has(`${cell.x},${cell.y}`));
    const nextFloors = floorsRef.current.flatMap((floor): FloorRegion[] => {
      if (floor.id !== target.id) return [floor];
      const selectedRegion = { ...floor, cells: selectedCells, variant: variant ?? floor.variant };
      return remainingCells.length
        ? [{ ...floor, id: `${floor.id}-remainder-${Date.now()}`, cells: remainingCells }, selectedRegion]
        : [selectedRegion];
    });
    commitPlan(cellsRef.current, roomsRef.current, manualWallsRef.current, wallDeletionsRef.current, nextFloors);
    setSelectedFloorCells(null);
    setSelectedFloorAreas([]);
    setActiveFloorCorner(null);
  }, [commitPlan, selectedFloorCells, selectedFloorId]);

  const updateSelectedFloorVariant = useCallback((variant: FloorAssetVariant) => {
    if (!selectedFloorId) return;
    if (selectedFloorCells?.length) {
      splitSelectedFloor(variant);
      return;
    }
    updateFloors((current) => current.map((floor) => floor.id === selectedFloorId ? { ...floor, variant } : floor));
  }, [selectedFloorCells, selectedFloorId, splitSelectedFloor, updateFloors]);

  const updateFloorCornerEdit = useCallback((floorId: string, edit: CornerEdit) => {
    updateFloors((current) => current.map((floor) => floor.id === floorId ? {
      ...floor,
      cornerEdits: [...floor.cornerEdits.filter((item) => item.vertexX !== edit.vertexX || item.vertexY !== edit.vertexY), edit],
    } : floor));
  }, [updateFloors]);

  const removeFloorCornerEdit = useCallback((floorId: string, vertexX: number, vertexY: number) => {
    updateFloors((current) => current.map((floor) => floor.id === floorId ? {
      ...floor,
      cornerEdits: floor.cornerEdits.filter((item) => item.vertexX !== vertexX || item.vertexY !== vertexY),
    } : floor));
  }, [updateFloors]);

  const resizeCircle = useCallback((roomId: string, circleIndex: number, radius: number) => {
    const snapped = Math.max(MIN_CIRCLE_RADIUS, Math.round(radius));
    updateRooms((current) => current.map((room) => room.id === roomId
      ? { ...room, circles: room.circles.map((circle, index) => index === circleIndex ? { ...circle, radius: snapped } : circle) }
      : room));
  }, [updateRooms]);

  const moveRoom = useCallback((roomId: string, dxCells: number, dyCells: number) => {
    const dx = Math.trunc(dxCells);
    const dy = Math.trunc(dyCells);
    if (!dx && !dy) return;
    const idsToMove = new Set(selectedRoomIds.includes(roomId) ? selectedRoomIds : [roomId]);
    const movedContents = moveContainedRoomObjects(
      roomsRef.current,
      idsToMove,
      dx,
      dy,
      manualWallsRef.current,
      floorsRef.current,
      stairsRef.current,
      placedPillarsRef.current,
    );
    const nextRooms = roomsRef.current.map((room): Room => idsToMove.has(room.id) ? {
      ...room,
      cells: room.cells.map((cell) => ({ x: cell.x + dx, y: cell.y + dy })),
      circles: room.circles.map((circle) => ({ ...circle, cx: circle.cx + dx * CELL_SIZE, cy: circle.cy + dy * CELL_SIZE })),
      cornerEdits: room.cornerEdits.map((edit) => ({ ...edit, vertexX: edit.vertexX + dx, vertexY: edit.vertexY + dy })),
      openings: room.openings.map((opening) => ({ ...opening, cx: opening.cx + dx * CELL_SIZE, cy: opening.cy + dy * CELL_SIZE })),
    } : room);
    const nextCells = normalizeCells(nextRooms.flatMap((room) => room.cells));
    if (nextCells.length > MAX_CELLS) {
      notify(`Plans are limited to ${MAX_CELLS.toLocaleString()} cells for browser performance.`);
      return;
    }
    const offsetX = dx * CELL_SIZE;
    const offsetY = dy * CELL_SIZE;
    const nextWallDeletions = wallDeletionsRef.current.map((deletion) => idsToMove.has(deletion.roomId ?? "")
      ? { ...deletion, cx: deletion.cx + offsetX, cy: deletion.cy + offsetY }
      : deletion);
    commitPlan(nextCells, nextRooms, movedContents.manualWalls, nextWallDeletions, movedContents.floors, movedContents.stairs, movedContents.pillars);
  }, [commitPlan, notify, selectedRoomIds]);

  const changeRoomElevation = useCallback((roomId: string, deltaSteps: number) => {
    const stepChange = Math.trunc(deltaSteps);
    if (!stepChange) return;
    const currentRooms = roomsRef.current;
    const idsToMove = new Set(selectedRoomIds.includes(roomId) ? selectedRoomIds : [roomId]);
    const nextRooms = currentRooms.map((room) => idsToMove.has(room.id)
      ? { ...room, elevationSteps: (room.elevationSteps ?? 0) + stepChange }
      : room);
    if (nextRooms.some((room, index) => room !== currentRooms[index])) {
      const elevations = new Map(nextRooms.map((room) => [room.id, (room.elevationSteps ?? 0) * ROOM_ELEVATION_STEP]));
      const nextWallDeletions = wallDeletionsRef.current.map((deletion) => idsToMove.has(deletion.roomId ?? "")
        ? { ...deletion, elevation: elevations.get(deletion.roomId!) ?? deletion.elevation } : deletion);
      commitPlan(cellsRef.current, nextRooms, manualWallsRef.current, nextWallDeletions);
    }
  }, [commitPlan, selectedRoomIds]);

  const placeOpening = useCallback((target: OpeningTarget, asset: OpeningAsset | null) => {
    if (target.shared && asset && openingIsWindow(asset)) {
      notify("Shared walls can contain doors, but not windows.");
      return;
    }
    const angle = canonicalOpeningRotation(target.rotation);
    const sameSlot = (opening: Room["openings"][number]) => Math.hypot(opening.cx - target.cx, opening.cy - target.cy) < 0.05
      && Math.abs(Math.sin(opening.rotation - angle)) < 0.01;
    if (target.manualWallId) {
      let changed = false;
      const nextManualWalls = manualWallsRef.current.map((wall) => {
        if (wall.id !== target.manualWallId) return wall;
        const current = wall.openings ?? [];
        const filtered = current.filter((opening) => !sameSlot(opening));
        if (filtered.length !== current.length) changed = true;
        if (!asset) return changed ? { ...wall, openings: filtered } : wall;
        changed = true;
        return { ...wall, openings: [...filtered, { id: `opening-${Date.now()}`, roomId: `manual-${wall.id}`, manualWallId: wall.id, asset, cx: target.cx, cy: target.cy, rotation: angle }] };
      });
      if (changed) commitPlan(cellsRef.current, roomsRef.current, nextManualWalls);
      return;
    }
    if (!target.roomId) return;
    let changed = false;
    const nextRooms = roomsRef.current.map((room) => {
      const filtered = room.openings.filter((opening) => !sameSlot(opening));
      if (filtered.length !== room.openings.length) changed = true;
      if (!asset && room.autoOpenings) {
        const removed = room.openings.filter(sameSlot).map(opening => ({ ...opening, automatic: false, suppressed: true }));
        return { ...room, openings: [...filtered, ...removed] };
      }
      if (room.id !== target.roomId || !asset) return filtered === room.openings ? room : { ...room, openings: filtered };
      changed = true;
      return { ...room, openings: [...filtered, { id: `opening-${Date.now()}`, roomId: room.id, asset, cx: target.cx, cy: target.cy, rotation: angle }] };
    });
    if (changed) commitPlan(cellsRef.current, nextRooms);
  }, [commitPlan, notify]);

  const resizeRoomWall = useCallback((updates: Array<{ handle: WallResizeHandle; steps: number }>) => {
    const changesByRoom = new Map<string, Array<{ handle: WallResizeHandle; steps: number }>>();
    for (const update of updates) {
      if (!update.steps) continue;
      const changes = changesByRoom.get(update.handle.roomId) ?? [];
      changes.push(update);
      changesByRoom.set(update.handle.roomId, changes);
    }
    if (!changesByRoom.size) return;
    const nextRooms = roomsRef.current.map((room) => {
      const changes = changesByRoom.get(room.id);
      if (!changes) return room;
      const resized = changes.reduce((roomCells, change) => resizeRoomCells(roomCells, change.handle, change.steps), room.cells);
      if (!resized.length && !room.circles.length) return null;
      return {
        ...room,
        cells: resized,
        cornerEdits: [],
        openings: moveOpeningsWithWalls(room.openings, changes, CELL_SIZE),
      };
    });
    if (nextRooms.some((room) => room === null)) {
      notify("A shared wall cannot be moved past the opposite side of a room.");
      return;
    }
    const resolvedRooms = nextRooms as Room[];
    const nextCells = normalizeCells(resolvedRooms.flatMap((candidate) => candidate.cells));
    if (nextCells.length > MAX_CELLS) {
      notify(`Plans are limited to ${MAX_CELLS.toLocaleString()} cells for browser performance.`);
      return;
    }
    commitPlan(nextCells, resolvedRooms);
  }, [commitPlan, notify]);

  const updateTerrainRegion = useCallback((id: string, patch: Partial<Pick<TerrainRegion, "controlPoints" | "height" | "slopeWidth" | "edgeProfile">>) => {
    const next = terrainRegionsRef.current.map((region) => region.id === id ? { ...region, ...patch } : region);
    terrainRegionsRef.current = next;
    setTerrainRegions(next);
  }, []);

  const undo = useCallback(() => {
    const previous = undoStack.current.pop();
    if (!previous) return;
    redoStack.current.push({ cells: cellsRef.current, rooms: roomsRef.current, manualWalls: manualWallsRef.current, wallDeletions: wallDeletionsRef.current, floors: floorsRef.current, stairs: stairsRef.current, placedPillars: placedPillarsRef.current, terrain: terrainRef.current, terrainRegions: terrainRegionsRef.current, roomConnections: roomConnectionsRef.current });
    cellsRef.current = previous.cells;
    roomsRef.current = previous.rooms;
    manualWallsRef.current = previous.manualWalls;
    wallDeletionsRef.current = previous.wallDeletions;
    floorsRef.current = previous.floors;
    stairsRef.current = previous.stairs;
    placedPillarsRef.current = previous.placedPillars;
    terrainRef.current = previous.terrain;
    terrainRegionsRef.current = previous.terrainRegions;
    roomConnectionsRef.current = previous.roomConnections;
    setCells(previous.cells);
    setRooms(previous.rooms);
    setManualWalls(previous.manualWalls);
    setWallDeletions(previous.wallDeletions);
    setFloors(previous.floors);
    setStairs(previous.stairs);
    setPlacedPillars(previous.placedPillars);
    setTerrain(previous.terrain);
    setTerrainRegions(previous.terrainRegions);
    setRoomConnections(previous.roomConnections);
  }, []);

  const redo = useCallback(() => {
    const next = redoStack.current.pop();
    if (!next) return;
    undoStack.current.push({ cells: cellsRef.current, rooms: roomsRef.current, manualWalls: manualWallsRef.current, wallDeletions: wallDeletionsRef.current, floors: floorsRef.current, stairs: stairsRef.current, placedPillars: placedPillarsRef.current, terrain: terrainRef.current, terrainRegions: terrainRegionsRef.current, roomConnections: roomConnectionsRef.current });
    cellsRef.current = next.cells;
    roomsRef.current = next.rooms;
    manualWallsRef.current = next.manualWalls;
    wallDeletionsRef.current = next.wallDeletions;
    floorsRef.current = next.floors;
    stairsRef.current = next.stairs;
    placedPillarsRef.current = next.placedPillars;
    terrainRef.current = next.terrain;
    terrainRegionsRef.current = next.terrainRegions;
    roomConnectionsRef.current = next.roomConnections;
    setCells(next.cells);
    setRooms(next.rooms);
    setManualWalls(next.manualWalls);
    setWallDeletions(next.wallDeletions);
    setFloors(next.floors);
    setStairs(next.stairs);
    setPlacedPillars(next.placedPillars);
    setTerrain(next.terrain);
    setTerrainRegions(next.terrainRegions);
    setRoomConnections(next.roomConnections);
  }, []);

  const updateSetting = <Key extends keyof BuildSettings>(key: Key, value: BuildSettings[Key]) => {
    setSettings((current) => ({ ...current, [key]: value }));
  };

  const updateCornerEdit = useCallback((roomId: string, edit: CornerEdit | null) => {
    updateRooms((current) => current.map((room) => {
      if (room.id !== roomId) return room;
      if (!edit) return room;
      const remaining = room.cornerEdits.filter(
        (candidate) => candidate.vertexX !== edit.vertexX || candidate.vertexY !== edit.vertexY,
      );
      return { ...room, cornerEdits: [...remaining, edit] };
    }));
  }, [updateRooms]);

  const removeCornerEdit = useCallback((roomId: string, vertexX: number, vertexY: number) => {
    updateRooms((current) => current.map((room) => room.id === roomId
      ? { ...room, cornerEdits: room.cornerEdits.filter((edit) => edit.vertexX !== vertexX || edit.vertexY !== vertexY) }
      : room));
  }, [updateRooms]);

  const activeEdit = useMemo(() => {
    if (!activeCorner) return null;
    return rooms.find((room) => room.id === activeCorner.roomId)?.cornerEdits.find(
      (edit) => edit.vertexX === activeCorner.vertexX && edit.vertexY === activeCorner.vertexY,
    ) ?? null;
  }, [activeCorner, rooms]);
  const activeFloorEdit = useMemo(() => {
    if (!activeFloorCorner) return null;
    return floors.find((floor) => floor.id === activeFloorCorner.roomId)?.cornerEdits.find(
      (edit) => edit.vertexX === activeFloorCorner.vertexX && edit.vertexY === activeFloorCorner.vertexY,
    ) ?? null;
  }, [activeFloorCorner, floors]);

  const updateSelectedRoomStyle = (side: "inner" | "outer", variant: Variant) => {
    if (!selectedRoomId) {
      updateSetting(side === "inner" ? "innerWallVariant" : "outerWallVariant", variant);
      return;
    }
    const key = side === "inner" ? "innerWallVariant" : "outerWallVariant";
    const selected = new Set(selectedRoomIds.length ? selectedRoomIds : [selectedRoomId]);
    updateRooms((current) => current.map((room) => selected.has(room.id)
      ? { ...room, style: { ...room.style, [key]: variant } }
      : room));
  };

  useEffect(() => {
    setSaveStatus("saving");
    const timer = window.setTimeout(() => {
      const project: SavedProject = {
        activeBuildingId,
        activeGridLevel,
        format: "mor-room-planner",
        version: 10,
        name: projectName.trim() || "Untitled interior",
        cells,
        rooms,
        manualWalls,
        wallDeletions,
        floors,
        stairs,
        placedPillars,
        terrain,
        terrainRegions,
        roomConnections,
        settings,
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(project));
      setSaveStatus("saved");
    }, 300);
    return () => window.clearTimeout(timer);
  }, [cells, floors, manualWalls, placedPillars, projectName, roomConnections, rooms, settings, stairs, terrain, terrainRegions, wallDeletions, activeGridLevel, activeBuildingId]);

  useEffect(() => () => {
    if (toastTimeoutRef.current) window.clearTimeout(toastTimeoutRef.current);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target instanceof HTMLElement && target.matches("input, select, textarea")) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "y") {
        event.preventDefault();
        redo();
        return;
      }
      if (event.key.toLowerCase() === "d") { setToolGroup("room"); setTool("draw"); }
      if (event.key.toLowerCase() === "w") { setToolGroup("wall"); setWallDrawMode("path"); setTool("wall"); }
      if (event.key.toLowerCase() === "b") { setToolGroup("wall"); setWallDrawMode("path"); setTool("railing"); }
      if (event.key.toLowerCase() === "e") setTool("erase");
      if (event.key.toLowerCase() === "s") setTool("select");
      if (event.key.toLowerCase() === "r") setTool("circle");
      if (event.key.toLowerCase() === "o") setTool("opening");
      if (event.key.toLowerCase() === "t") { setToolGroup("terrain"); setTool("terrain"); }
      if (event.key.toLowerCase() === "c" && activeCorner) {
        event.preventDefault();
        updateCornerEdit(activeCorner.roomId, {
          vertexX: activeCorner.vertexX,
          vertexY: activeCorner.vertexY,
          insetCells: activeEdit?.insetCells ?? 1,
          shape: activeEdit?.shape === "curve" ? "diagonal" : "curve",
          inverted: activeEdit?.inverted ?? false,
        });
      }
      if (event.key.toLowerCase() === "i" && activeCorner && activeEdit?.shape === "curve") {
        event.preventDefault();
        updateCornerEdit(activeCorner.roomId, { ...activeEdit, inverted: !activeEdit.inverted });
      }
      if (event.key === "0") setFitSignal((value) => value + 1);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeCorner, activeEdit, redo, undo, updateCornerEdit]);

  const exportProject = () => {
    const project: SavedProject = {
      activeBuildingId,
      activeGridLevel,
      format: "mor-room-planner",
      version: 10,
      name: projectName.trim() || "Untitled interior",
      cells,
      rooms,
      manualWalls,
      wallDeletions,
      floors,
      stairs,
      placedPillars,
      terrain,
      terrainRegions,
      roomConnections,
      settings,
    };
    const blob = new Blob([JSON.stringify(project, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${project.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "mor-room"}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    notify("Project exported as JSON.");
  };

  const importProject = async (file: File) => {
    try {
      const imported = JSON.parse(await file.text()) as Partial<SavedProject>;
      if (imported.format !== "mor-room-planner" || ![1, 2, 3, 4, 5, 6, 7, 8, 9].includes(imported.version as number) || !Array.isArray(imported.cells)) {
        throw new Error("This is not a valid MoR Room Planner file.");
      }
      const importedCells = normalizeCells(imported.cells);
      if (importedCells.length > MAX_CELLS) throw new Error(`This project exceeds the ${MAX_CELLS.toLocaleString()} cell browser limit.`);
      undoStack.current.push({ cells: cellsRef.current, rooms: roomsRef.current, manualWalls: manualWallsRef.current, wallDeletions: wallDeletionsRef.current, floors: floorsRef.current, stairs: stairsRef.current, placedPillars: placedPillarsRef.current, terrain: terrainRef.current, terrainRegions: terrainRegionsRef.current, roomConnections: roomConnectionsRef.current });
      redoStack.current = [];
      setCells(importedCells);
      const importedSettings = sanitizeSettings(imported.settings);
      setSettings(importedSettings);
      setRooms(sanitizeRooms(imported.rooms, importedCells, importedSettings));
      const importedWalls = sanitizeManualWalls(imported.manualWalls);
      const importedDeletions = sanitizeWallDeletions(imported.wallDeletions);
      const importedFloors = sanitizeFloors(imported.floors);
      const importedStairs = sanitizeStairs(imported.stairs);
      const importedPillars = sanitizePlacedPillars(imported.placedPillars);
      const importedTerrain = sanitizeTerrain(imported.terrain);
      const importedTerrainRegions = sanitizeTerrainRegions(imported.terrainRegions);
      const importedRoomConnections = sanitizeRoomConnections(imported.roomConnections);
      manualWallsRef.current = importedWalls;
      wallDeletionsRef.current = importedDeletions;
      floorsRef.current = importedFloors;
      stairsRef.current = importedStairs;
      placedPillarsRef.current = importedPillars;
      terrainRef.current = importedTerrain;
      terrainRegionsRef.current = importedTerrainRegions;
      roomConnectionsRef.current = importedRoomConnections;
      setManualWalls(importedWalls);
      setWallDeletions(importedDeletions);
      setFloors(importedFloors);
      setStairs(importedStairs);
      setPlacedPillars(importedPillars);
      setTerrain(importedTerrain);
      setTerrainRegions(importedTerrainRegions);
      setRoomConnections(importedRoomConnections);
      switchGrid(Number.isFinite(imported.activeGridLevel) ? Math.trunc(imported.activeGridLevel!) : 0);
      setActiveBuildingId(typeof imported.activeBuildingId === "string" ? imported.activeBuildingId : null);
      setSelectedRoomId(null);
      setSelectedRoomIds([]);
      setActiveCorner(null);
      setSelectedFloorId(null);
      setSelectedFloorAreas([]);
      setSelectedFloorCells(null);
      setActiveFloorCorner(null);
      if (typeof imported.name === "string" && imported.name.trim()) setProjectName(imported.name.slice(0, 64));
      setFitSignal((value) => value + 1);
      notify("Project imported successfully.");
    } catch (error) {
      notify(error instanceof Error ? error.message : "The project could not be imported.");
    }
  };

  const loadExample = () => {
    commitPlan(EXAMPLE_CELLS, sanitizeRooms([], EXAMPLE_CELLS, settings), [], [], [], [], [], [], [], []);
    setFitSignal((value) => value + 1);
    notify("Example assembly loaded.");
  };

  const clearPlan = () => {
    if (!cells.length && !rooms.length && !manualWalls.length && !wallDeletions.length && !floors.length && !stairs.length && !placedPillars.length && !terrain.length && !terrainRegions.length && !roomConnections.length) return;
    commitPlan([], [], [], [], [], [], [], [], [], []);
    setSelectedRoomId(null);
    setSelectedRoomIds([]);
    setActiveCorner(null);
    setSelectedFloorId(null);
    setSelectedFloorAreas([]);
    setSelectedFloorCells(null);
    setActiveFloorCorner(null);
    notify("Plan cleared. Undo is available.");
  };

  const variantOptions = [
    { value: "A" as const, label: "Linen" },
    { value: "B" as const, label: "Sage" },
    { value: "C" as const, label: "Clay" },
  ];
  const selectedRoom = rooms.find((room) => room.id === selectedRoomId) ?? null;
  const selectedFloor = floors.find((floor) => floor.id === selectedFloorId) ?? null;
  const roomsForConnection = rooms.filter((room) => selectedRoomIds.includes(room.id));
  const selectedConnectionLevels = [...new Set(roomsForConnection.map((room) => room.elevationSteps ?? 0))];
  const connectionSuggestions = selectedConnectionLevels.length > 1 ? suggestRoomConnections(roomsForConnection) : [];
  const expectedConnectionCount = Math.max(0, selectedConnectionLevels.length - 1);
  const selectedRoomIdSet = new Set(selectedRoomIds);
  const selectedConnections = roomConnections.filter((connection) => selectedRoomIdSet.has(connection.fromRoomId) && selectedRoomIdSet.has(connection.toRoomId));
  const connectSelectedRooms = () => {
    if (connectionSuggestions.length !== expectedConnectionCount) {
      notify("Add a door to a selected room on every level first.");
      return;
    }
    const existing = new Set(roomConnectionsRef.current.map((connection) => connection.id));
    const additions = connectionSuggestions.filter((connection) => !existing.has(connection.id));
    if (!additions.length) {
      notify(connectionSuggestions.length ? "These selected levels are already connected." : "Add a door to a room on each selected level first.");
      return;
    }
    commitPlan(cellsRef.current, roomsRef.current, manualWallsRef.current, wallDeletionsRef.current, floorsRef.current, stairsRef.current, placedPillarsRef.current, terrainRef.current, terrainRegionsRef.current, [...roomConnectionsRef.current, ...additions]);
    notify(`${additions.length} room connection${additions.length === 1 ? "" : "s"} created.`);
  };
  const disconnectSelectedRooms = () => {
    const removing = new Set(selectedConnections.map((connection) => connection.id));
    if (!removing.size) return;
    commitPlan(cellsRef.current, roomsRef.current, manualWallsRef.current, wallDeletionsRef.current, floorsRef.current, stairsRef.current, placedPillarsRef.current, terrainRef.current, terrainRegionsRef.current, roomConnectionsRef.current.filter((connection) => !removing.has(connection.id)));
    notify("Selected room connections removed.");
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark"><i /><i /><i /></span>
          <div><strong>Room planner</strong></div>
        </div>
        <label className="project-title">
          <span>Project</span>
          <input value={projectName} maxLength={64} onChange={(event) => setProjectName(event.target.value)} aria-label="Project name" />
        </label>
        <div className="top-actions">
          <span className={`save-state ${saveStatus}`}><i />{saveStatus === "saved" ? "Saved locally" : "Saving"}</span>
          <button type="button" className="header-button" onClick={() => fileInputRef.current?.click()}><Icon name="upload" />Import</button>
          <button type="button" className="header-button primary" onClick={exportProject}><Icon name="download" />Export</button>
          <input
            ref={fileInputRef}
            className="visually-hidden"
            type="file"
            accept="application/json,.json"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void importProject(file);
              event.target.value = "";
            }}
          />
        </div>
      </header>

      <main className="app-main">
        <aside className="sidebar">
          <section className="control-section">
            <div className="section-heading"><span>01</span><h2>Edit assembly</h2></div>
            <div className="tool-launcher">
              <button
                type="button"
                className={`tool-category ${toolGroup === "room" ? "active" : ""}`}
                aria-expanded={toolGroup === "room"}
                onClick={() => { setToolGroup("room"); setTool("draw"); setSelectedFloorId(null); setActiveFloorCorner(null); }}
              >
                <Icon name="brush" />
                <span><strong>Room draw</strong><small>Square, circle, edit, openings</small></span>
                <i className={toolGroup === "room" ? "expanded" : ""}>⌄</i>
              </button>
              <button
                type="button"
                className={`tool-category wall-category ${toolGroup === "wall" ? "active" : ""}`}
                aria-expanded={toolGroup === "wall"}
                onClick={() => { setToolGroup("wall"); setTool("wall"); setSelectedFloorId(null); setActiveFloorCorner(null); }}
              >
                <Icon name="cube" />
                <span><strong>Wall draw</strong><small>Draw and edit walls</small></span>
                <i className={toolGroup === "wall" ? "expanded" : ""}>⌄</i>
              </button>
              <button
                type="button"
                className={`tool-category floor-category ${toolGroup === "floor" ? "active" : ""}`}
                aria-expanded={toolGroup === "floor"}
                onClick={() => { setToolGroup("floor"); setTool("draw"); setActiveCorner(null); }}
              >
                <Icon name="grid" />
                <span><strong>Floor draw</strong><small>Floors and balconies</small></span>
                <i className={toolGroup === "floor" ? "expanded" : ""}>⌄</i>
              </button>
              <button
                type="button"
                className={`tool-category terrain-category ${toolGroup === "terrain" ? "active" : ""}`}
                aria-expanded={toolGroup === "terrain"}
                onClick={() => { setToolGroup("terrain"); setTool("terrain"); setSelectedFloorId(null); setActiveCorner(null); }}
              >
                <Icon name="brush" />
                <span><strong>Terrain</strong><small>Sculpt the ground</small></span>
                <i className={toolGroup === "terrain" ? "expanded" : ""}>⌄</i>
              </button>
            </div>
            <div className="grid-level-control">
              <button type="button" className={tool === "connect" ? "active" : ""} onClick={() => { setTool("connect"); setToolGroup("room"); }}>Connect rooms</button>
              {tool === "connect" && <p>Hover a wall or door, then drag its handle to start a pathway. Click to add points; finish on another wall, or double-click for an open end. Drag squares to reshape and arrows to change height. Double-click a segment to insert a point. Right-click for point, segment, or pathway actions. Escape cancels.</p>}
              <strong>Active grid</strong>
              <Switch label="Show grid" checked={settings.gridVisible !== false} onChange={value=>updateSetting("gridVisible",value)} />
              <small>Visible grid: {Math.min(0,activeGridElevation).toFixed(2)} m · Placement level: {activeGridElevation.toFixed(2)} m</small>
              <div className="grid-level-buttons">
                <button type="button" aria-label="Lower grid by 2.5 metres" onClick={() => switchGrid(activeGridLevel - 1)}>−</button>
                <output aria-live="polite">{activeGridElevation.toFixed(2)} m</output>
                <button type="button" aria-label="Raise grid by 2.5 metres" onClick={() => switchGrid(activeGridLevel + 1)}>+</button>
                <button type="button" onClick={() => switchGrid(0)} disabled={activeGridLevel === 0}>Base grid</button>
              </div>
              <button type="button" className="terrain-clear" onClick={() => { setActiveBuildingId(null); switchGrid(0); setSelectedRoomId(null); setSelectedRoomIds([]); setToolGroup("room"); setTool("draw"); }}>New building</button>
              <p>{activeContextId ? `Building foundation ${activeFoundation.toFixed(2)} m · Level ${activeGridLevel}. Select another room to follow its building.` : "New building: draw its first room to anchor it to the terrain."} Levels are 2.5 m apart. New building starts a separate terrain anchor.</p>
            </div>
            {toolGroup === "room" && <div className="tool-grid subtool-grid">
              <button type="button" className={tool === "draw" ? "active" : ""} onClick={() => setTool("draw")}><Icon name="brush" /><span>Square room</span><kbd>D</kbd></button>
              <button type="button" className={tool === "circle" ? "active" : ""} onClick={() => setTool("circle")}><Icon name="circle" /><span>Circle room</span><kbd>R</kbd></button>
              <button type="button" className={tool === "erase" ? "active" : ""} onClick={() => setTool("erase")}><Icon name="erase" /><span>Erase</span><kbd>E</kbd></button>
              <button type="button" className={tool === "select" ? "active" : ""} onClick={() => setTool("select")}><Icon name="grid" /><span>Select</span><kbd>S</kbd></button>
              <button type="button" className={tool === "opening" ? "active" : ""} onClick={() => setTool("opening")}><Icon name="cube" /><span>Openings</span><kbd>O</kbd></button>
            </div>}
            {toolGroup === "wall" && <div className="tool-grid wall-subtool-grid subtool-grid">
              <button type="button" className={tool === "wall" && wallDrawMode === "path" ? "active" : ""} onClick={() => { setWallDrawMode("path"); setTool("wall"); }}><Icon name="brush" /><span>Wall path</span><kbd>W</kbd></button>
              <button type="button" className={tool === "railing" ? "active" : ""} onClick={() => { setWallDrawMode("path"); setTool("railing"); }}><Icon name="cube" /><span>Balcony rail</span><kbd>B</kbd></button>
              <button type="button" className={tool === "wall" && wallDrawMode === "arc" ? "active" : ""} onClick={() => { setWallDrawMode("arc"); setTool("wall"); }}><Icon name="circle" /><span>Arc wall</span></button>
              <button type="button" className={tool === "erase" ? "active" : ""} onClick={() => setTool("erase")}><Icon name="erase" /><span>Erase</span><kbd>E</kbd></button>
              <button type="button" className={tool === "select" ? "active" : ""} onClick={() => setTool("select")}><Icon name="grid" /><span>Select</span><kbd>S</kbd></button>
              <button type="button" className={tool === "opening" ? "active" : ""} onClick={() => setTool("opening")}><Icon name="cube" /><span>Openings</span><kbd>O</kbd></button>
            </div>}
            {toolGroup === "floor" && <div className="tool-grid floor-subtool-grid subtool-grid">
              <button type="button" className={tool === "draw" ? "active" : ""} onClick={() => setTool("draw")}><Icon name="brush" /><span>Draw floor</span></button>
              <button type="button" className={tool === "erase" ? "active" : ""} onClick={() => setTool("erase")}><Icon name="erase" /><span>Erase floor</span></button>
              <button type="button" className={tool === "select" ? "active" : ""} onClick={() => setTool("select")}><Icon name="grid" /><span>Select floor</span></button>
              <button type="button" className={tool === "stairs" ? "active" : ""} onClick={() => setTool("stairs")}><Icon name="cube" /><span>Place stairs</span></button>
            </div>}
            {toolGroup === "floor" && <label className="field-row"><span>Stair asset</span><select value={stairAsset} onChange={(event) => { setStairAsset(event.target.value as StairAsset); setTool("stairs"); }}>{STAIR_ASSETS.map((asset) => <option key={asset} value={asset}>{stairLabel(asset)}</option>)}</select></label>}
            {tool === "stairs" && <p className="tool-help">Click an existing stair to rotate it 90°. Right-click, then choose Delete to remove it. Click empty space to place stairs.</p>}
            {toolGroup === "terrain" && <>
              <div className="tool-grid terrain-subtool-grid subtool-grid">
                {(["raise", "lower", "flatten"] as TerrainBrushMode[]).map((mode) => (
                  <button type="button" key={mode} className={!settings.terrainPaintMode && terrainMode === mode ? "active" : ""} onClick={() => { updateSetting("terrainPaintMode", false); setTerrainMode(mode); setTool("terrain"); }}>
                    <Icon name={mode === "flatten" ? "grid" : mode === "raise" ? "brush" : "erase"} /><span>{mode[0].toUpperCase() + mode.slice(1)}</span>
                  </button>
                ))}
              </div>
              <Switch label="Show terrain" checked={settings.terrainEnabled !== false} onChange={(value) => updateSetting("terrainEnabled", value)} />
              <Switch label="Texture paint brush" checked={settings.terrainPaintMode === true} onChange={(value) => updateSetting("terrainPaintMode", value)} />
              {settings.terrainPaintMode && <>
                <label className="field-row"><span>Paint texture</span><select value={settings.terrainPaintTexture ?? "grass"} onChange={(event) => updateSetting("terrainPaintTexture", event.target.value as TerrainTextureVariant)}><option value="grass">Grass</option><option value="ground-rocks">Ground with rocks</option><option value="cliff-rocks">Cliff rocks</option></select></label>
                <label className="range-field"><span><b>Brush size</b><output>{settings.terrainPaintSize ?? 4} m</output></span><input type="range" min="0.5" max="40" step="0.5" value={settings.terrainPaintSize ?? 4} onChange={(event) => updateSetting("terrainPaintSize", Number(event.target.value))} /></label>
                <label className="range-field"><span><b>Intensity</b><output>{Math.round((settings.terrainPaintIntensity ?? 0.5) * 100)}%</output></span><input type="range" min="0.01" max="1" step="0.01" value={settings.terrainPaintIntensity ?? 0.5} onChange={(event) => updateSetting("terrainPaintIntensity", Number(event.target.value))} /></label>
                <label className="range-field"><span><b>Soft falloff</b><output>{Math.round((settings.terrainPaintFalloff ?? 0.75) * 100)}%</output></span><input type="range" min="0" max="1" step="0.01" value={settings.terrainPaintFalloff ?? 0.75} onChange={(event) => updateSetting("terrainPaintFalloff", Number(event.target.value))} /></label>
                <p className="control-help">Click and drag on terrain to paint. Size is the brush diameter; falloff softens its edges. Repeated strokes build up intensity. Undo removes one stroke.</p>
              </>}
              <label className="field-row"><span>Terrain surface</span><select value={settings.terrainTexture ?? "grass"} onChange={(event) => updateSetting("terrainTexture", event.target.value as TerrainTextureVariant)}><option value="grass">Grass</option><option value="ground-rocks">Ground with rocks</option><option value="cliff-rocks">Cliff rocks</option></select></label>
              <label className="field-row"><span>Edge profile</span><select value={settings.terrainEdgeProfile ?? "smooth"} onChange={(event) => updateSetting("terrainEdgeProfile", event.target.value as TerrainEdgeProfile)}><option value="smooth">Smooth slope</option><option value="cliff">Sheer cliff</option></select></label>
              {(settings.terrainEdgeProfile ?? "smooth") === "smooth" && <label className="range-field">
                <span><b>Slope width</b><output>{(settings.terrainSlopeWidth ?? 2) * CELL_SIZE} m</output></span>
                <input type="range" min="0.5" max="8" step="0.5" value={settings.terrainSlopeWidth ?? 2} onChange={(event) => updateSetting("terrainSlopeWidth", Number(event.target.value))} />
              </label>}
              <label className="range-field">
                <span><b>Height per spline</b><output>{(settings.terrainBrushStep ?? 0.5).toFixed(2)} m</output></span>
                <input type="range" min="0.25" max="4" step="0.25" value={settings.terrainBrushStep ?? 0.5} onChange={(event) => updateSetting("terrainBrushStep", Number(event.target.value))} />
              </label>
              <label className="range-field">
                <span><b>Mesh density</b><output>{settings.terrainMeshResolution ?? 4}× · {(CELL_SIZE / (settings.terrainMeshResolution ?? 4)).toFixed(2)} m</output></span>
                <input type="range" min="1" max="10" step="1" value={settings.terrainMeshResolution ?? 4} onChange={(event) => updateSetting("terrainMeshResolution", Number(event.target.value))} />
              </label>
              <button type="button" className="terrain-clear" disabled={!terrain.length && !terrainRegions.length} onClick={() => applyPlanAction({ type: "clear-terrain" })}>Reset terrain</button>
            </>}
            <p className="control-help">{toolGroup === "terrain"
              ? "Click points around an area, then double-click to close it. The orange spline remains editable: drag a yellow point to reshape it; drag the orange curve up/down to change height and left/right to widen the smooth slope. Drag the width fully inward for a sheer cliff. Right-click cancels and Backspace removes the last point."
              : toolGroup === "floor"
              ? "Drag on the grid to create floor-only regions. Select floor can split and move floor tiles. Choose a stair asset, then place it on the active level; its exact footprint is cut from the floor above. Right-click a stair to remove it."
              : toolGroup === "wall"
                ? "Wall Path uses fixed 2 m modules. Balcony Rail uses the 1 m BR module and automatically adds BP pillars at corners, L/T joints, and open endpoints. Double-click confirms; Backspace removes the last point; right-click cancels."
                : "Rooms keep their original click-drag rectangle. In Select, Shift/Ctrl-click adds rooms from any visible grid level; dragging one selected room moves the whole selection and any contained stairs, pillars, floors, or manual walls."}</p>
            <div className="history-row">
              <button type="button" onClick={undo} disabled={!undoStack.current.length}><Icon name="undo" />Undo</button>
              <button type="button" onClick={redo} disabled={!redoStack.current.length}><Icon name="redo" />Redo</button>
            </div>
          </section>

          <section className="control-section opening-editor">
            <div className="section-heading"><span>02</span><h2>Doors and windows</h2></div>
            <p className="control-help">Choose an asset, then click any straight 2 m room wall or standalone wall. Windows sit 1 m above the floor and are limited to exterior walls. Shared walls accept doors only; 1.5 m doors cut the wall and 2 m doors replace it.</p>
            <div className="opening-assets">
              {OPENING_ASSETS.map((asset) => <button type="button" key={asset} className={openingAsset === asset ? "active" : ""} onClick={() => { setOpeningAsset(asset); setTool("opening"); }}>{openingLabel(asset)}</button>)}
              <button type="button" className={openingAsset === null ? "active danger" : "danger"} onClick={() => { setOpeningAsset(null); setTool("opening"); }}>Remove opening</button>
            </div>
          </section>

          <section className="control-section corner-editor">
            <div className="section-heading"><span>02</span><h2>Room corner editor</h2></div>
            {!selectedRoom && <p className="control-help">Choose Select, then click a room to display its move, wall-resize, corner, or radius handles.</p>}
            {selectedRoom && (
              <>
                <div className="selected-room-label"><span>{selectedRoomIds.length > 1 ? "Selected rooms" : "Selected room"}</span><b>{selectedRoomIds.length > 1 ? selectedRoomIds.length : selectedRoom.id.replace(/^room-/, "")}</b></div>
                <p className="control-help">Drag the floor to move this room in 2 m steps. Room elevation moves its full assembly in fixed 2.5 m storey steps. Drag a blue edge grip perpendicular to its wall to add or remove floor rows.</p>
                <div className="elevation-row">
                  <span>Room elevation</span>
                  <div>
                    <button type="button" aria-label="Lower room by 2.5 metres" onClick={() => changeRoomElevation(selectedRoom.id, -10)}>−</button>
                    <output>{((selectedRoom.elevationSteps ?? 0) * ROOM_ELEVATION_STEP).toFixed(2)} m</output>
                    <button type="button" aria-label="Raise room by 2.5 metres" onClick={() => changeRoomElevation(selectedRoom.id, 10)}>+</button>
                  </div>
                </div>
                <SelectField label="Room inside wall" value={selectedRoom.style.innerWallVariant} options={variantOptions} onChange={(value) => updateSelectedRoomStyle("inner", value)} />
                <SelectField label="Room outside wall" value={selectedRoom.style.outerWallVariant} options={variantOptions} onChange={(value) => updateSelectedRoomStyle("outer", value)} />
                <div className="corner-actions">
                  <button
                    type="button"
                    disabled={!activeCorner}
                    onClick={() => activeCorner && updateCornerEdit(activeCorner.roomId, {
                      vertexX: activeCorner.vertexX,
                      vertexY: activeCorner.vertexY,
                      insetCells: activeEdit?.insetCells ?? 1,
                      shape: activeEdit?.shape === "curve" ? "diagonal" : "curve",
                      inverted: activeEdit?.inverted ?? false,
                    })}
                  >Toggle diagonal / curve <kbd>C</kbd></button>
                  <button
                    type="button"
                    disabled={!activeCorner || activeEdit?.shape !== "curve"}
                    onClick={() => activeCorner && activeEdit && updateCornerEdit(activeCorner.roomId, { ...activeEdit, inverted: !activeEdit.inverted })}
                  >Invert curve <kbd>I</kbd></button>
                  <button
                    type="button"
                    disabled={!activeCorner || !activeEdit}
                    onClick={() => activeCorner && removeCornerEdit(activeCorner.roomId, activeCorner.vertexX, activeCorner.vertexY)}
                  >Reset corner</button>
                  <button type="button" onClick={() => updateRooms((current) => current.map((room) => room.id === selectedRoom.id ? { ...room, cornerEdits: [] } : room))}>Reset all corners</button>
                  <button type="button" onClick={() => commitPlan(cellsRef.current, roomsRef.current.map(room => room.id === selectedRoom.id ? { ...room, autoOpenings: !room.autoOpenings, openings: room.openings.map(o => ({ ...o, automatic: false })) } : room))}>{selectedRoom.autoOpenings ? "Stop automatic openings" : "Enable automatic openings"}</button>
                </div>
                <label className="range-field"><span><b>Curve quality</b><output>{settings.curveQuality} samples</output></span><input type="range" min="64" max="128" step="8" value={settings.curveQuality} onChange={(event) => updateSetting("curveQuality", Number(event.target.value))} /></label>
              </>
            )}
          </section>

          <section className="control-section corner-editor floor-editor">
            <div className="section-heading"><span>03</span><h2>Floor and balcony editor</h2></div>
            {!selectedFloor && <p className="control-help">Open Floor draw, choose Select floor, then click a platform or balcony.</p>}
            {selectedFloor && <>
              <div className="selected-room-label"><span>Selected floor</span><b>{selectedFloor.id.replace(/^floor-/, "")}</b></div>
              <p className="control-help">{selectedFloorCells?.length
                ? `${selectedFloorCells.length} floor tile${selectedFloorCells.length === 1 ? "" : "s"} selected. Drag the highlighted tiles to split and move them, or change their finish to split them in place.`
                : "The floor stays on the grid level where it was drawn. Alt-drag the selected floor to move it in 2 m grid steps."}</p>
              {selectedFloorCells?.length && selectedFloorCells.length < selectedFloor.cells.length
                ? <button type="button" className="split-floor-selection" onClick={() => splitSelectedFloor()}>Split selected tiles</button>
                : null}
              <div className="field-row"><span>Floor finish</span><div className="compact-options">
                {(["1", "2"] as FloorAssetVariant[]).map((variant) => <button type="button" key={variant} className={selectedFloor.variant === variant ? "active" : ""} onClick={() => updateSelectedFloorVariant(variant)}>Floor {variant}</button>)}
              </div></div>
              <div className="corner-actions">
                <button type="button" disabled={!activeFloorCorner} onClick={() => activeFloorCorner && updateFloorCornerEdit(activeFloorCorner.roomId, {
                  vertexX: activeFloorCorner.vertexX,
                  vertexY: activeFloorCorner.vertexY,
                  insetCells: activeFloorEdit?.insetCells ?? 1,
                  shape: activeFloorEdit?.shape === "curve" ? "diagonal" : "curve",
                  inverted: activeFloorEdit?.inverted ?? false,
                })}>Toggle diagonal / curve</button>
                <button type="button" disabled={!activeFloorCorner || activeFloorEdit?.shape !== "curve"} onClick={() => activeFloorCorner && activeFloorEdit && updateFloorCornerEdit(activeFloorCorner.roomId, { ...activeFloorEdit, inverted: !activeFloorEdit.inverted })}>Invert curve</button>
                <button type="button" disabled={!activeFloorCorner || !activeFloorEdit} onClick={() => activeFloorCorner && removeFloorCornerEdit(activeFloorCorner.roomId, activeFloorCorner.vertexX, activeFloorCorner.vertexY)}>Reset corner</button>
                <button type="button" onClick={() => updateFloors((current) => current.map((floor) => floor.id === selectedFloor.id ? { ...floor, cornerEdits: [] } : floor))}>Reset all corners</button>
              </div>
            </>}
          </section>

          <section className="control-section">
            <div className="section-heading"><span>03</span><h2>Material system</h2></div>
            <SelectField label="Ground" value={settings.floorVariant} options={variantOptions} onChange={(value) => updateSetting("floorVariant", value)} />
            <SelectField label="Inside wall" value={settings.innerWallVariant} options={variantOptions} onChange={(value) => updateSetting("innerWallVariant", value)} />
            <Switch label="Inside walls" checked={settings.showInnerWalls} onChange={(value) => updateSetting("showInnerWalls", value)} />
            <SelectField label="Outside wall" value={settings.outerWallVariant} options={variantOptions} onChange={(value) => updateSetting("outerWallVariant", value)} />
            <Switch label="Outside walls" checked={settings.showOuterWalls} onChange={(value) => updateSetting("showOuterWalls", value)} />
            <div className="fixed-specs wall-transform-locks" aria-label="Locked wall transforms">
              <span><i>Inside locked</i><b>180° · {settings.innerWallOffset.toFixed(2)} m</b></span>
              <span><i>Outside locked</i><b>0° · {settings.outerWallOffset.toFixed(2)} m</b></span>
            </div>
            <Switch label="Shuffle wall variants" checked={settings.randomizeWalls} onChange={(value) => updateSetting("randomizeWalls", value)} />
            {settings.randomizeWalls && (
              <label className="seed-row">
                <span>Random seed</span>
                <input
                  type="number"
                  min="0"
                  value={settings.randomSeed}
                  onChange={(event) => updateSetting("randomSeed", Math.max(0, Math.trunc(Number(event.target.value) || 0)))}
                />
                <button type="button" onClick={() => updateSetting("randomSeed", settings.randomSeed + 1)} aria-label="Shuffle wall variants"><Icon name="shuffle" /></button>
              </label>
            )}
          </section>

          <section className="control-section">
            <div className="section-heading"><span>04</span><h2>Structure</h2></div>
            <button type="button" className={tool === "pillar" ? "active" : ""} onClick={() => { setToolGroup("room"); setTool("pillar"); }}><Icon name="cube" /> Place pillar</button>
            <p className="control-help">Place pillars anywhere on the map. They snap to grid intersections or cell centres; right-click a placed pillar to remove it.</p>
            <Switch label="Corner pillars" checked={settings.addPillars} onChange={(value) => updateSetting("addPillars", value)} />
            <label className="field-row"><span>Wall module</span><select value={settings.moduleWallVariant} onChange={(event) => updateSetting("moduleWallVariant", event.target.value as BuildSettings["moduleWallVariant"])}>{WALL_MODULE_VARIANTS.map((variant) => <option key={variant} value={variant}>W2.5×2 · {variant}</option>)}</select></label>
            <label className="field-row"><span>Pillar module</span><select value={settings.modulePillarVariant} onChange={(event) => updateSetting("modulePillarVariant", event.target.value as BuildSettings["modulePillarVariant"])}>{PILLAR_MODULE_VARIANTS.map((variant) => <option key={variant} value={variant}>P2.5 · {variant}</option>)}</select></label>
            {settings.addPillars && (
              <>
                <SelectField label="Pillar module" value={settings.pillarVariant} options={variantOptions} onChange={(value) => updateSetting("pillarVariant", value)} />
                <label className="range-field">
                  <span><b>Pillar inset</b><output>{settings.pillarInset.toFixed(2)} m</output></span>
                  <input type="range" min="0" max="2" step="0.05" value={settings.pillarInset} onChange={(event) => updateSetting("pillarInset", Number(event.target.value))} />
                </label>
              </>
            )}
            <label className="range-field">
              <span><b>Shared wall gap</b><output>{settings.sharedWallSeparation.toFixed(2)} m</output></span>
              <input type="range" min="0" max="0.25" step="0.01" value={settings.sharedWallSeparation} onChange={(event) => updateSetting("sharedWallSeparation", Number(event.target.value))} />
            </label>
            <div className="fixed-specs">
              <span><i>Grid</i><b>2 × 2 m</b></span>
              <span><i>Wall</i><b>3 m</b></span>
              <span><i>Module</i><b>2 m fixed</b></span>
            </div>
          </section>

          <section className="control-section lighting-system">
            <div className="section-heading"><span>05</span><h2>Dynamic lighting</h2></div>
            <Switch label="Sun and sky" checked={settings.dynamicLighting} onChange={(value) => updateSetting("dynamicLighting", value)} />
            <label className="range-field">
              <span><b>Time of day</b><output>{formatTimeOfDay(settings.timeOfDay)}</output></span>
              <input type="range" min="0" max="24" step="0.25" value={settings.timeOfDay} onChange={(event) => updateSetting("timeOfDay", Number(event.target.value))} />
            </label>
            <div className="lighting-presets" aria-label="Time of day presets">
              {([['Dawn', 6.5], ['Noon', 12], ['Sunset', 18], ['Night', 22]] as const).map(([label, hour]) => (
                <button type="button" key={label} onClick={() => updateSetting("timeOfDay", hour)}>{label}</button>
              ))}
            </div>
            <label className="range-field">
              <span><b>Ambient light</b><output>{settings.ambientLight.toFixed(2)}</output></span>
              <input type="range" min="0.1" max="2.5" step="0.05" value={settings.ambientLight} onChange={(event) => updateSetting("ambientLight", Number(event.target.value))} />
            </label>
            <label className="range-field">
              <span><b>Exposure</b><output>{settings.exposure.toFixed(2)}</output></span>
              <input type="range" min="0.5" max="1.6" step="0.05" value={settings.exposure} onChange={(event) => updateSetting("exposure", Number(event.target.value))} />
            </label>
            <div className="hdri-upload-row">
              <button type="button" onClick={() => hdriInputRef.current?.click()}>{hdriUrl ? 'Replace HDR/EXR' : 'Load HDR/EXR'}</button>
              <span title={hdriName ?? undefined}>{hdriName ?? 'Single environment file'}</span>
              <input
                ref={hdriInputRef}
                className="visually-hidden"
                type="file"
                accept=".hdr,.exr,image/vnd.radiance"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) {
                    const kind = file.name.toLowerCase().endsWith('.exr') ? 'exr' : 'hdr';
                    setHdriUrl(URL.createObjectURL(file));
                    setHdriName(file.name);
                    setHdriKind(kind);
                    setCubeMapUrls(null);
                    notify(`${kind.toUpperCase()} environment loaded: ${file.name}`);
                  }
                  event.target.value = '';
                }}
              />
            </div>
            <div className="hdri-upload-row">
              <button type="button" onClick={() => cubeMapInputRef.current?.click()}>{cubeMapUrls ? 'Replace skybox' : 'Load 6-face skybox'}</button>
              <span>{cubeMapUrls ? 'px · nx · py · ny · pz · nz' : 'Select all six PNG/JPG faces'}</span>
              <input
                ref={cubeMapInputRef}
                className="visually-hidden"
                type="file"
                accept=".png,.jpg,.jpeg,image/png,image/jpeg"
                multiple
                onChange={(event) => {
                  const files = [...(event.target.files ?? [])];
                  const axes = ['px', 'nx', 'py', 'ny', 'pz', 'nz'] as const;
                  const byAxis = axes.map((axis) => files.find((file) => {
                    const base = file.name.toLowerCase().replace(/\.[^.]+$/, '');
                    return base === axis || new RegExp(`(^|[_-])${axis}($|[_-])`).test(base);
                  }));
                  if (byAxis.some((file) => !file)) {
                    notify('Select six images named px, nx, py, ny, pz and nz.');
                  } else {
                    setCubeMapUrls(byAxis.map((file) => URL.createObjectURL(file!)) as [string, string, string, string, string, string]);
                    setHdriUrl(null);
                    setHdriName(null);
                    setHdriKind(null);
                    notify('Six-face skybox loaded.');
                  }
                  event.target.value = '';
                }}
              />
            </div>
            {(hdriUrl || cubeMapUrls) && (
              <>
                <button type="button" className="environment-clear" onClick={() => { setHdriUrl(null); setHdriName(null); setHdriKind(null); setCubeMapUrls(null); }}>Clear environment</button>
                <Switch label="Show environment background" checked={settings.hdriBackground} onChange={(value) => updateSetting("hdriBackground", value)} />
                <label className="range-field">
                  <span><b>HDRI strength</b><output>{settings.hdriIntensity.toFixed(2)}</output></span>
                  <input type="range" min="0" max="3" step="0.05" value={settings.hdriIntensity} onChange={(event) => updateSetting("hdriIntensity", Number(event.target.value))} />
                </label>
                <label className="range-field">
                  <span><b>HDRI rotation</b><output>{Math.round(settings.hdriRotation)}°</output></span>
                  <input type="range" min="0" max="360" step="1" value={settings.hdriRotation} onChange={(event) => updateSetting("hdriRotation", Number(event.target.value))} />
                </label>
              </>
            )}
          </section>

          <section className="control-section asset-library">
            <div className="section-heading"><span>06</span><h2>Asset library</h2></div>
            <div className="asset-grid">
              {([
                { label: "Ground", file: "FL2x2A.webp", variant: null, grounds: true },
                { label: "Pillar", file: "P3_A.webp", variant: null, grounds: false },
                { label: "Wall · A", file: "W3x2A.webp", variant: "A", grounds: false },
                { label: "Wall · B", file: "W3x2B.webp", variant: "B", grounds: false },
                { label: "Wall · C", file: "W3x2C.webp", variant: "C", grounds: false },
              ] as const).map(({ label, file, variant, grounds }) => (
                <figure key={file}>
                  <img src={`/Thumbnails/${file}`} alt={`${label} asset`} />
                  <figcaption>{label}</figcaption>
                  {variant && (
                    <div className="asset-actions">
                      <button type="button" onClick={() => updateSelectedRoomStyle("inner", variant)}>Inside</button>
                      <button type="button" onClick={() => updateSelectedRoomStyle("outer", variant)}>Outside</button>
                    </div>
                  )}
                  {grounds && (
                    <div className="asset-actions ground-actions">
                      {(["A", "B", "C"] as Variant[]).map((option) => <button type="button" key={option} onClick={() => updateSetting("floorVariant", option)}>{option}</button>)}
                    </div>
                  )}
                </figure>
              ))}
              <figure>
                <div className="asset-preview-icon" aria-hidden="true"><Icon name="cube" /></div>
                <figcaption>Stairs</figcaption>
                <div className="asset-actions stair-actions">
                  {STAIR_ASSETS.map((asset) => <button type="button" key={asset} className={stairAsset === asset ? "active" : ""} onClick={() => { setStairAsset(asset); setToolGroup("floor"); setTool("stairs"); }}>{asset === "ST_2.5x4_1" ? "4 × 4 m" : "2 × 2 m"}</button>)}
                </div>
              </figure>
            </div>
          </section>

          <section className="plan-actions">
            <button type="button" onClick={loadExample}><Icon name="grid" />Load example</button>
            <button type="button" className="danger" onClick={clearPlan} disabled={!cells.length && !rooms.length && !manualWalls.length && !floors.length && !stairs.length && !placedPillars.length && !terrain.length && !terrainRegions.length && !roomConnections.length}><Icon name="clear" />Clear plan</button>
          </section>
        </aside>

        <section className="workspace">
          <div className="workbench">
            <article className="workspace-pane model-pane">
              <header className="pane-heading dark">
                <div><span>INTERACTIVE MODEL / 3D</span><strong>Live assembly</strong></div>
                <small><i />Level {activeGridLevel} · Grid {activeGridElevation.toFixed(2)} m · {tool === "railing" ? "1 m rail snap" : "2 m snap"}</small>
              </header>
              <Suspense fallback={<div className="three-loading"><Icon name="cube" /><span>Loading 3D workspace</span></div>}>
                <ThreeViewport
                  layout={gridLayout}
                  displayLayout={visibleGridLayout}
                  terrainLayout={layout}
                  rooms={rooms.filter((room) => visibleAtOrBelowGridLevel(room.elevationSteps, activeGridLevel, room.foundationHeight ?? 0))}
                  roomConnections={roomConnections}
                  stairs={visibleStairs}
                  stairAsset={stairAsset}
                  placedPillars={visiblePlacedPillars}
                  terrain={terrain}
                  terrainRegions={terrainRegions}
                  terrainMode={terrainMode}
                  gridElevation={activeGridElevation}
                  settings={settings}
                  hdriUrl={hdriUrl}
                  hdriKind={hdriKind}
                  cubeMapUrls={cubeMapUrls}
                  fitSignal={fitSignal}
                  tool={tool}
                  eraseScope={toolGroup === "terrain" ? "room" : toolGroup}
                  wallDrawMode={wallDrawMode}
                  openingAsset={openingAsset}
                  selectedRoomId={toolGroup === "floor" ? selectedFloorId : selectedRoomId}
                  selectedRoomIds={toolGroup === "floor" ? [] : selectedRoomIds}
                  selectedFloorCells={toolGroup === "floor" ? selectedFloorCells : null}
                  selectedFloorAreas={toolGroup === "floor" ? selectedFloorAreas : []}
                  activeCorner={toolGroup === "floor" ? activeFloorCorner : activeCorner}
                  onCommit={applyPlanAction}
                  onTerrainRegionEdit={updateTerrainRegion}
                  onSelectRoom={(roomId, additive = false) => {
                    if (toolGroup !== "floor" && roomId) {
                      const chosen = rooms.find((room) => room.id === roomId);
                      if (chosen) { setActiveBuildingId(buildingIdForRoom(chosen)); setActiveGridLevel(buildingLevelForRoom(chosen)); }
                    }
                    if (toolGroup === "floor") {
                      setSelectedFloorId(roomId);
                      if (!roomId) {
                        setSelectedFloorCells(null);
                        setActiveFloorCorner(null);
                      }
                    } else {
                      if (!roomId) {
                        if (!additive) { setSelectedRoomId(null); setSelectedRoomIds([]); }
                        setActiveCorner(null);
                      } else if (additive) {
                        setSelectedRoomIds((current) => {
                          const next = current.includes(roomId) ? current.filter((id) => id !== roomId) : [...current, roomId];
                          setSelectedRoomId(next.includes(roomId) ? roomId : next[next.length - 1] ?? null);
                          return next;
                        });
                      } else {
                        setSelectedRoomId(roomId);
                        setSelectedRoomIds([roomId]);
                      }
                    }
                  }}
                  onSelectFloorArea={(floorId, bounds) => {
                    if (!floorId || !bounds) {
                      setSelectedFloorCells(null);
                      setSelectedFloorAreas([]);
                      return;
                    }
                    const areas = floorsRef.current
                      .filter((floor) => onGridLevel(floor.elevationSteps, activeGridLevel, activeFoundation))
                      .map((floor) => ({ floorId: floor.id, cells: floor.cells.filter((cell) =>
                        cell.x >= bounds.minX && cell.x <= bounds.maxX
                        && cell.y >= bounds.minY && cell.y <= bounds.maxY) }))
                      .filter((area) => area.cells.length);
                    setSelectedFloorAreas(areas);
                    setSelectedFloorCells(areas.flatMap((area) => area.cells));
                  }}
                  onActiveCorner={toolGroup === "floor" ? setActiveFloorCorner : setActiveCorner}
                  onCornerEdit={toolGroup === "floor" ? updateFloorCornerEdit : updateCornerEdit}
                  onCornerRemove={toolGroup === "floor" ? removeFloorCornerEdit : removeCornerEdit}
                  onCircleResize={resizeCircle}
                  onRoomMove={toolGroup === "floor" ? moveFloor : moveRoom}
                  onWallResize={resizeRoomWall}
                  onPlaceOpening={placeOpening}
                  onNotice={notify}
                />
              </Suspense>
              {toolGroup === "room" && selectedConnectionLevels.length > 1 && (
                <aside className="connection-panel" aria-label="Connect selected room levels">
                  <span>LEVEL CONNECTION</span>
                  <strong>{selectedConnectionLevels.length} selected levels</strong>
                  <p>{connectionSuggestions.length === expectedConnectionCount
                    ? "Connect the nearest doors with 1.25 m stair flights and floor-mesh landings."
                    : "Each adjacent selected level needs at least one room with a door."}</p>
                  <button type="button" onClick={connectSelectedRooms} disabled={connectionSuggestions.length !== expectedConnectionCount}>Connect rooms</button>
                  {selectedConnections.length > 0 && <button type="button" className="secondary" onClick={disconnectSelectedRooms}>Remove connection</button>}
                </aside>
              )}
            </article>
          </div>

          <footer className="metrics-strip">
            <div><span>Area</span><strong>{formatNumber(layout.stats.area)} <small>m²</small></strong></div>
            <div><span>Perimeter</span><strong>{formatNumber(layout.stats.perimeter)} <small>m</small></strong></div>
            <div><span>Floor tiles</span><strong>{layout.stats.floorTiles}</strong></div>
            <div><span>Wall modules</span><strong>{layout.stats.wallModules}</strong></div>
            <div><span>Total modules</span><strong>{layout.stats.totalModules}</strong></div>
            <div><span>Zones</span><strong>{layout.stats.connectedRooms}</strong></div>
          </footer>
        </section>
      </main>

      {toast && <div key={toast.id} className="toast" role="status"><span />{toast.message}</div>}
    </div>
  );
}
