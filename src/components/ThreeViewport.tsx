import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { RGBELoader } from "three/addons/loaders/RGBELoader.js";
import { EXRLoader } from "three/addons/loaders/EXRLoader.js";
import { BALCONY_RAILING_MODULE_SIZE, CELL_SIZE, circularArcThroughPoints, MAX_CELLS, ROOM_ELEVATION_STEP, WALL_HEIGHT, WALL_THICKNESS } from "../layout";
import { GRID_LEVEL_HEIGHT, visibleGridHeight } from "../gridLevels";
import { circleFromDrag, MIN_CIRCLE_RADIUS, pointInPolygon } from "../footprint";
import { cellCenterToWorld, planYToWorldZ, worldPointToCell } from "../coordinates";
import { SharedTextureLoader } from "../textures";
import { balconyPillarModelUrl, balconyRailingModelUrl, openingIsFullReplacement, openingModelUrl, OPENING_ASSETS, pillarModelUrl, PILLAR_MODULE_VARIANTS, STAIR_ASSETS, stairFootprintSize, stairModelUrl, wallModelUrl, WALL_MODULE_VARIANTS } from "../moduleAssets";
import { openingForWall, openingTargetForWall, openingTransformForWall, type OpeningTarget } from "../openings";
import { apertureKind, centerOpeningOnWall, cloneOpeningForWall, disposeBooleanTemplate, subtractOpening } from "../runtimeBoolean";
import { sampleClosedTerrainSpline } from "../terrain";
import { TerrainSurface } from "../terrainSurface";
import { buildConnectionGeometry, planRoomConnection } from "../roomConnections";
import { resolvePathPoints, pathwayGeometry, insertPathPoint, deletePathPoint, type PathPoint } from "../pathways";
import type {
  BuildSettings,
  Cell,
  CellBounds,
  CornerEdit,
  CornerHandle,
  EditorTool,
  FloorAssetVariant,
  FloorGround,
  GeneratedLayout,
  OpeningAsset,
  PillarPlacement,
  PillarModuleVariant,
  PlanAction,
  PlanPoint,
  RadiusHandle,
  Room,
  RoomConnection,
  StairPlacement,
  StairAsset,
  TerrainBrushMode,
  TerrainCell,
  TerrainEdgeProfile,
  TerrainRegion,
  TerrainTextureVariant,
  Variant,
  WallModuleVariant,
  WallPath,
  WallOpening,
  WallResizeHandle,
  WallSegment,
  WallEraseTarget,
  WallDrawMode,
} from "../types";
import { Icon } from "../icons";

interface CornerIdentity { roomId: string; vertexX: number; vertexY: number; }

interface ThreeViewportProps {
  /** Active-level geometry used for picking and editing. */
  layout: GeneratedLayout;
  /** Active and lower-level geometry rendered as context. */
  displayLayout: GeneratedLayout;
  /** Complete world geometry: terrain cutouts must not depend on the active level. */
  terrainLayout: GeneratedLayout;
  rooms: Room[];
  roomConnections: RoomConnection[];
  stairs: StairPlacement[];
  stairAsset: StairAsset;
  placedPillars: PillarPlacement[];
  terrain: TerrainCell[];
  terrainRegions: TerrainRegion[];
  terrainMode: TerrainBrushMode;
  gridElevation: number;
  settings: BuildSettings;
  hdriUrl: string | null;
  hdriKind: "hdr" | "exr" | null;
  cubeMapUrls: [string, string, string, string, string, string] | null;
  fitSignal: number;
  tool: EditorTool;
  eraseScope: "room" | "wall" | "floor";
  wallDrawMode: WallDrawMode;
  openingAsset: OpeningAsset | null;
  selectedRoomId: string | null;
  selectedRoomIds: string[];
  selectedFloorCells: Cell[] | null;
  selectedFloorAreas: Array<{ floorId: string; cells: Cell[] }>;
  activeCorner: CornerIdentity | null;
  onCommit: (action: PlanAction) => void;
  onTerrainRegionEdit: (id: string, patch: Partial<Pick<TerrainRegion, "controlPoints" | "height" | "slopeWidth" | "edgeProfile">>) => void;
  onSelectRoom: (roomId: string | null, additive?: boolean) => void;
  onSelectFloorArea: (floorId: string | null, bounds: CellBounds | null) => void;
  onActiveCorner: (corner: CornerIdentity | null) => void;
  onCornerEdit: (roomId: string, edit: CornerEdit) => void;
  onCornerRemove: (roomId: string, vertexX: number, vertexY: number) => void;
  onCircleResize: (roomId: string, circleIndex: number, radius: number) => void;
  onRoomMove: (roomId: string, dxCells: number, dyCells: number) => void;
  onWallResize: (updates: Array<{ handle: WallResizeHandle; steps: number }>) => void;
  onPlaceOpening: (target: OpeningTarget, asset: OpeningAsset | null) => void;
  onNotice: (message: string) => void;
}

interface SceneRuntime {
  terrainLayout: GeneratedLayout;
  terrainSurface: TerrainSurface;
  terrainVariant: TerrainTextureVariant;
  gridElevation: number;
  setGridElevation: (elevation: number) => void;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  controls: OrbitControls;
  hemisphere: THREE.HemisphereLight;
  sun: THREE.DirectionalLight;
  hdriBackgroundMap: THREE.Texture | null;
  hdriEnvironmentMap: THREE.Texture | null;
  hdriLoadVersion: number;
  generated: THREE.Group;
  handles: THREE.Group;
  terrainGuides: THREE.Group;
  terrainTextures: Record<TerrainTextureVariant, TerrainTextureSet | null>;
  assets: {
    grounds: Record<Variant, THREE.Group | null>;
    pillar: THREE.Group | null;
    walls: Record<Variant, THREE.Group | null>;
    moduleWalls: Record<WallModuleVariant, THREE.Group | null>;
    modulePillars: Record<PillarModuleVariant, THREE.Group | null>;
    openingModels: Record<OpeningAsset, THREE.Group | null>;
    platformFloors: Record<FloorAssetVariant, THREE.Group | null>;
    stairs: Record<StairAsset, THREE.Group | null>;
    connectionStair: THREE.Group | null;
    balconyRailing: THREE.Group | null;
    balconyPillar: THREE.Group | null;
    cutWalls: Map<string, THREE.Group>;
  };
  cube: THREE.BoxGeometry;
  materials: {
    floors: Record<Variant, THREE.MeshStandardMaterial>;
    walls: Record<Variant, THREE.MeshStandardMaterial>;
    pillars: Record<Variant, THREE.MeshStandardMaterial>;
    trim: THREE.MeshStandardMaterial;
    handle: THREE.MeshBasicMaterial;
    handleActive: THREE.MeshBasicMaterial;
    wallHandle: THREE.MeshBasicMaterial;
    floorSelection: THREE.MeshBasicMaterial;
    terrain: THREE.MeshStandardMaterial;
    terrainSpline: THREE.LineBasicMaterial;
    terrainControl: THREE.MeshBasicMaterial;
  };
  render: () => void;
  setTool: (tool: EditorTool) => void;
}

interface Transform {
  x: number;
  y: number;
  z: number;
  sx: number;
  sy: number;
  sz: number;
  rotationY?: number;
}

interface DrawState {
  pointerId: number;
  start: Cell;
  current: Cell;
  operation: "draw" | "draw-floor" | "erase" | "erase-floor" | "erase-wall-area" | "select-floor" | "circle";
  wallTarget?: WallEraseTarget;
  selectionFloorId?: string;
}

interface TerrainTextureSet {
  color: THREE.Texture;
  normal: THREE.Texture;
  height: THREE.Texture;
}

interface TerrainSplinePendingState {
  points: PlanPoint[];
  current: PlanPoint;
}

interface TerrainControlDragState {
  pointerId: number;
  regionId: string;
  controlIndex: number;
  originalPoints: PlanPoint[];
}

interface TerrainAdjustDragState {
  pointerId: number;
  regionId: string;
  startClientX: number;
  startClientY: number;
  originalHeight: number;
  originalSlopeWidth: number;
  originalEdgeProfile: TerrainEdgeProfile;
}

interface CornerDragState {
  pointerId: number;
  handle: CornerHandle;
  original: CornerEdit | null;
  current: CornerEdit | null;
}

interface RadiusDragState {
  pointerId: number;
  handle: RadiusHandle;
  original: number;
  current: number;
}

interface RoomMoveDragState {
  pointerId: number;
  roomId: string;
  start: Cell;
  dxCells: number;
  dyCells: number;
}

interface WallResizeDragState {
  pointerId: number;
  handles: WallResizeHandle[];
  start: PlanPoint;
  steps: number;
}

interface MergedWallResizeControl {
  /** One or more room-owned handles that occupy the exact same shared wall. */
  handles: WallResizeHandle[];
}

function pointKey(point: PlanPoint) {
  return `${point.x.toFixed(4)},${point.y.toFixed(4)}`;
}

/** Direction-independent key, so the two faces of a shared wall collapse into one control. */
function wallHandleKey(handle: WallResizeHandle) {
  const start = pointKey(handle.start);
  const end = pointKey(handle.end);
  const edge = start < end ? `${start}|${end}` : `${end}|${start}`;
  return `${(handle.elevation ?? 0).toFixed(4)}|${edge}`;
}

function joinedRoomIds(layout: GeneratedLayout, selectedRoomId: string) {
  const roomsByWall = new Map<string, Set<string>>();
  for (const handle of layout.wallResizeHandles) {
    const roomIds = roomsByWall.get(wallHandleKey(handle)) ?? new Set<string>();
    roomIds.add(handle.roomId);
    roomsByWall.set(wallHandleKey(handle), roomIds);
  }
  const joined = new Set([selectedRoomId]);
  const visualGroup = layout.roomGroups.find((roomIds) => roomIds.includes(selectedRoomId));
  visualGroup?.forEach((roomId) => joined.add(roomId));
  let changed = true;
  while (changed) {
    changed = false;
    for (const roomIds of roomsByWall.values()) {
      if (![...roomIds].some((roomId) => joined.has(roomId))) continue;
      for (const roomId of roomIds) {
        if (!joined.has(roomId)) {
          joined.add(roomId);
          changed = true;
        }
      }
    }
  }
  return joined;
}

function mergeWallResizeControls(handles: WallResizeHandle[]) {
  const controls = new Map<string, MergedWallResizeControl>();
  for (const handle of handles) {
    const key = wallHandleKey(handle);
    const control = controls.get(key) ?? { handles: [] };
    control.handles.push(handle);
    controls.set(key, control);
  }
  return [...controls.values()];
}

/** Pick the floor with the greatest cell-centre coverage inside a drag marquee. */
export function floorIdInCellBounds(floors: FloorGround[], bounds: CellBounds, preferredFloorId: string | null = null) {
  const scores = new Map<string, { cells: Set<string>; elevation: number }>();
  for (const floor of floors) {
    const score = scores.get(floor.floorId) ?? { cells: new Set<string>(), elevation: floor.elevation ?? 0 };
    score.elevation = Math.max(score.elevation, floor.elevation ?? 0);
    for (let y = bounds.minY; y <= bounds.maxY; y += 1) {
      for (let x = bounds.minX; x <= bounds.maxX; x += 1) {
        const point = { x: (x + 0.5) * CELL_SIZE, y: (y + 0.5) * CELL_SIZE };
        if (pointInPolygon(point, floor.outer) && !floor.holes.some((hole) => pointInPolygon(point, hole))) {
          score.cells.add(`${x},${y}`);
        }
      }
    }
    if (score.cells.size) scores.set(floor.floorId, score);
  }
  return [...scores.entries()].sort(([leftId, left], [rightId, right]) => (
    right.cells.size - left.cells.size
    || Number(rightId === preferredFloorId) - Number(leftId === preferredFloorId)
    || right.elevation - left.elevation
    || leftId.localeCompare(rightId)
  ))[0]?.[0] ?? null;
}

/** The drag is bounding-box, but locked square, so the inscribed circle is the room. */
const circleFromDraft = (draft: DrawState) => circleFromDrag(draft.start, draft.current);

function makeMaterial(color: number, roughness = 0.72) {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness: 0.02 });
}

function addInstances(runtime: SceneRuntime, transforms: Transform[], material: THREE.Material, shadows = true) {
  if (!transforms.length) return;
  const mesh = new THREE.InstancedMesh(runtime.cube, material, transforms.length);
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const matrix = new THREE.Matrix4();
  transforms.forEach((transform, index) => {
    position.set(transform.x, transform.y, transform.z);
    quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), transform.rotationY ?? 0);
    scale.set(transform.sx, transform.sy, transform.sz);
    matrix.compose(position, quaternion, scale);
    mesh.setMatrixAt(index, matrix);
  });
  mesh.instanceMatrix.needsUpdate = true;
  mesh.castShadow = shadows;
  mesh.receiveShadow = true;
  mesh.computeBoundingSphere();
  runtime.generated.add(mesh);
}

export function prepareTemplate(model: THREE.Group, centered = false, floorSurface = false) {
  model.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(model);
  if (centered) {
    const center = bounds.getCenter(new THREE.Vector3());
    model.position.x -= center.x;
    model.position.z -= center.z;
  }
  // The walking surface shares the level datum with the bases of standing meshes.
  model.position.y -= floorSurface ? bounds.max.y : bounds.min.y;
  model.traverse((object) => {
    if (object instanceof THREE.Mesh) {
      object.castShadow = true;
      object.receiveShadow = true;
    }
  });
  model.updateMatrixWorld(true);
  return model;
}

interface WallPathPendingState { points: PlanPoint[]; current: PlanPoint; }
interface ArcChordPendingState { readonly start: PlanPoint; current: PlanPoint; }
interface ArcPendingState { readonly start: PlanPoint; readonly end: PlanPoint; arcPoint: PlanPoint; }

function prepareOpeningTemplate(model: THREE.Group) {
  // Opening records store the wall-module centre. The wrapper keeps the horizontal
  // correction local so it rotates with every wall; authored Y/depth stay untouched.
  const pivot = centerOpeningOnWall(model);
  pivot.traverse((object) => {
    if (object instanceof THREE.Mesh) {
      object.castShadow = true;
      object.receiveShadow = true;
    }
  });
  return pivot;
}

function addModel(runtime: SceneRuntime, template: THREE.Group | null, x: number, z: number, rotation = 0, elevation = 0, sourceWall?: WallSegment) {
  if (!template) return false;
  const model = template.clone(true);
  model.position.x += x;
  model.position.y += elevation;
  model.position.z += z;
  model.rotation.y += rotation;
  if (sourceWall) {
    const target: WallEraseTarget = {
      cx: sourceWall.x + Math.cos(sourceWall.rotation) * sourceWall.length / 2,
      cy: sourceWall.y + Math.sin(sourceWall.rotation) * sourceWall.length / 2,
      axis: Math.abs(Math.cos(sourceWall.rotation)) >= Math.abs(Math.sin(sourceWall.rotation)) ? "horizontal" : "vertical",
      manualWallId: sourceWall.manualWallId,
      manualWallModuleIndex: sourceWall.manualWallModuleIndex,
      roomWall: !sourceWall.manualWallId,
      roomId: sourceWall.roomId,
      elevation: sourceWall.elevation ?? 0,
    };
    model.traverse((object) => {
      object.userData.wallEraseTarget = target;
    });
  }
  runtime.generated.add(model);
  return model;
}

function addOpeningModel(runtime: SceneRuntime, template: THREE.Group | null, wall: WallSegment, x: number, z: number, rotation: number) {
  if (!template) return false;
  const model = cloneOpeningForWall(template, Boolean(wall.opposingRoomId));
  model.position.set(x, wall.elevation ?? 0, z);
  model.rotation.y = rotation;
  runtime.generated.add(model);
  return true;
}

function wallTransform(x: number, planY: number, length: number, rotation: number, elevation = 0): Transform {
  return {
    x: x + Math.cos(rotation) * length / 2,
    y: elevation + WALL_HEIGHT / 2,
    z: planYToWorldZ(planY + Math.sin(rotation) * length / 2),
    sx: length,
    sy: WALL_HEIGHT,
    sz: WALL_THICKNESS,
    rotationY: rotation,
  };
}

function pathDistance(points: PlanPoint[]) {
  const cumulative = [0];
  for (let index = 1; index < points.length; index += 1) {
    cumulative.push(cumulative[index - 1] + Math.hypot(points[index].x - points[index - 1].x, points[index].y - points[index - 1].y));
  }
  return cumulative;
}

function samplePath(points: PlanPoint[], cumulative: number[], distance: number) {
  const total = cumulative[cumulative.length - 1] || 1;
  const target = Math.min(total, Math.max(0, distance));
  // Binary search, not a scan: a circle polyline is hundreds of points and this is
  // called once per wall vertex per module repeat, so a linear walk dominates rebuilds.
  let low = 1;
  let high = cumulative.length - 1;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (cumulative[middle] < target) low = middle + 1;
    else high = middle;
  }
  const index = low;
  const start = points[index - 1];
  const end = points[index];
  const segmentLength = cumulative[index] - cumulative[index - 1] || 1;
  const ratio = (target - cumulative[index - 1]) / segmentLength;
  return {
    point: { x: start.x + (end.x - start.x) * ratio, y: start.y + (end.y - start.y) * ratio },
    tangent: (() => {
      const magnitude = Math.hypot(end.x - start.x, end.y - start.y) || 1;
      return { x: (end.x - start.x) / magnitude, y: (end.y - start.y) / magnitude };
    })(),
  };
}

function addDeformedWall(
  runtime: SceneRuntime,
  template: THREE.Group | null,
  sourcePoints: PlanPoint[],
  flipped: boolean,
  signedOffset: number,
  sourceWall?: WallPath,
) {
  if (!template || sourcePoints.length < 2) return false;
  const points = flipped ? [...sourcePoints].reverse() : sourcePoints;
  const physicalOffset = flipped ? -signedOffset : signedOffset;
  const cumulative = pathDistance(points);
  const total = cumulative[cumulative.length - 1];
  if (total < 1e-5) return false;
  template.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(template);
  const sourceLength = Math.max(1e-5, bounds.max.x - bounds.min.x);
  const repeats = Math.max(1, Math.ceil(total / CELL_SIZE));

  template.traverse((object) => {
    if (!(object instanceof THREE.Mesh) || !object.geometry) return;
    const baked = object.geometry.clone();
    baked.applyMatrix4(object.matrixWorld);
    for (let repeat = 0; repeat < repeats; repeat += 1) {
      const geometry = baked.clone();
      const positions = geometry.getAttribute("position");
      for (let vertex = 0; vertex < positions.count; vertex += 1) {
        const longitudinal = (positions.getX(vertex) - bounds.min.x) / sourceLength;
        const distance = ((repeat + longitudinal) / repeats) * total;
        const sample = samplePath(points, cumulative, distance);
        const normal = { x: -sample.tangent.y, y: sample.tangent.x };
        const thickness = -positions.getZ(vertex) + physicalOffset;
        const planX = sample.point.x + normal.x * thickness;
        const planY = sample.point.y + normal.y * thickness;
        positions.setXYZ(vertex, planX, positions.getY(vertex) + (sourceWall?.elevation ?? 0), planYToWorldZ(planY));
      }
      positions.needsUpdate = true;
      geometry.computeVertexNormals();
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
      geometry.userData.morGenerated = true;
      const mesh = new THREE.Mesh(geometry, object.material);
      if (sourceWall?.manualWallId) {
        const first = sourceWall.points[0];
        const last = sourceWall.points[sourceWall.points.length - 1];
        mesh.userData.wallEraseTarget = {
          cx: (first.x + last.x) / 2,
          cy: (first.y + last.y) / 2,
          axis: Math.abs(last.x - first.x) >= Math.abs(last.y - first.y) ? "horizontal" : "vertical",
          manualWallId: sourceWall.manualWallId,
          manualWallModuleIndex: 0,
        } satisfies WallEraseTarget;
      }
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      runtime.generated.add(mesh);
    }
    baked.dispose();
  });
  return true;
}

function firstGroundMaterial(template: THREE.Group | null, fallback: THREE.Material) {
  let material: THREE.Material = fallback;
  template?.traverse((object) => {
    if (material !== fallback || !(object instanceof THREE.Mesh)) return;
    material = Array.isArray(object.material) ? object.material[0] : object.material;
  });
  return material;
}

function isWholeCellFloor(ground: Pick<FloorGround, "outer" | "holes">) {
  const loops = [ground.outer, ...ground.holes];
  return loops.every((loop) => loop.every((point, index) => {
    const next = loop[(index + 1) % loop.length];
    const onGrid = Math.abs(point.x / CELL_SIZE - Math.round(point.x / CELL_SIZE)) < 1e-5
      && Math.abs(point.y / CELL_SIZE - Math.round(point.y / CELL_SIZE)) < 1e-5;
    const axisAligned = Math.abs(point.x - next.x) < 1e-5 || Math.abs(point.y - next.y) < 1e-5;
    return onGrid && axisAligned;
  }));
}

function addAuthoredFloorTiles(
  runtime: SceneRuntime,
  ground: Pick<FloorGround, "outer" | "holes" | "elevation">,
  stairHoles: PlanPoint[][],
  material: THREE.Material,
  userData: Record<string, string>,
) {
  const floorTemplate = runtime.assets.platformFloors["1"];
  if (!floorTemplate || !isWholeCellFloor(ground)) return false;
  const minX = Math.floor(Math.min(...ground.outer.map((point) => point.x)) / CELL_SIZE);
  const maxX = Math.ceil(Math.max(...ground.outer.map((point) => point.x)) / CELL_SIZE) - 1;
  const minY = Math.floor(Math.min(...ground.outer.map((point) => point.y)) / CELL_SIZE);
  const maxY = Math.ceil(Math.max(...ground.outer.map((point) => point.y)) / CELL_SIZE) - 1;
  let placed = false;
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const center = { x: (x + 0.5) * CELL_SIZE, y: (y + 0.5) * CELL_SIZE };
      if (!pointInPolygon(center, ground.outer)
        || ground.holes.some((hole) => pointInPolygon(center, hole))
        || stairHoles.some((hole) => pointInPolygon(center, hole))) continue;
      const model = floorTemplate.clone(true);
      model.position.x += x * CELL_SIZE;
      model.position.y += ground.elevation ?? 0;
      model.position.z += planYToWorldZ(y * CELL_SIZE);
      model.traverse((object) => {
        Object.assign(object.userData, userData);
        if (object instanceof THREE.Mesh) object.material = material;
      });
      runtime.generated.add(model);
      placed = true;
    }
  }
  return placed;
}

/** The 2.5 m stair rises from its authored level through the floor one storey above. */
export function stairOpeningsAtElevation(stairs: StairPlacement[], elevation: number): PlanPoint[][] {
  return stairs.flatMap((stair) => {
    const openingElevation = stair.elevationSteps * ROOM_ELEVATION_STEP + GRID_LEVEL_HEIGHT;
    if (Math.abs(openingElevation - elevation) > 1e-4) return [];
    const minX = stair.cell.x * CELL_SIZE;
    const minY = stair.cell.y * CELL_SIZE;
    const size = stairFootprintSize(stair.asset);
    const cx = minX + size / 2, cy = minY + size / 2;
    const cos = Math.cos(stair.rotation), sin = Math.sin(stair.rotation);
    return [[
      { x: minX, y: minY },
      { x: minX + size, y: minY },
      { x: minX + size, y: minY + size },
      { x: minX, y: minY + size },
    ].map((point) => ({
      x: cx + (point.x - cx) * cos - (point.y - cy) * sin,
      y: cy + (point.x - cx) * sin + (point.y - cy) * cos,
    }))];
  });
}

function shapeForGround(ground: { outer: PlanPoint[]; holes: PlanPoint[][]; elevation?: number }, stairs: StairPlacement[]) {
  const shape = new THREE.Shape(ground.outer.map((point) => new THREE.Vector2(point.x, point.y)));
  const holes = [...ground.holes, ...stairOpeningsAtElevation(stairs, ground.elevation ?? 0)];
  for (const hole of holes) {
    const center = hole.reduce((sum, point) => ({ x: sum.x + point.x / hole.length, y: sum.y + point.y / hole.length }), { x: 0, y: 0 });
    if (!pointInPolygon(center, ground.outer) || ground.holes.some((existing) => pointInPolygon(center, existing))) continue;
    shape.holes.push(new THREE.Path(hole.map((point) => new THREE.Vector2(point.x, point.y))));
  }
  return shape;
}

function addRoomGround(runtime: SceneRuntime, layout: GeneratedLayout, stairs: StairPlacement[], settings: BuildSettings) {
  const material = firstGroundMaterial(runtime.assets.grounds[settings.floorVariant], runtime.materials.floors[settings.floorVariant]);
  for (const ground of layout.roomGrounds) {
    if (ground.outer.length < 3) continue;
    const stairHoles = stairOpeningsAtElevation(stairs, ground.elevation ?? 0);
    if (addAuthoredFloorTiles(runtime, ground, stairHoles, material, { roomId: ground.roomId })) continue;
    const shape = shapeForGround(ground, stairs);
    const geometry = new THREE.ShapeGeometry(shape);
    const position = geometry.getAttribute("position");
    const uv = geometry.getAttribute("uv");
    for (let index = 0; index < position.count; index += 1) uv.setXY(index, position.getX(index) / CELL_SIZE, position.getY(index) / CELL_SIZE);
    uv.needsUpdate = true;
    geometry.userData.morGenerated = true;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = ground.elevation ?? 0;
    mesh.receiveShadow = true;
    mesh.userData.roomId = ground.roomId;
    runtime.generated.add(mesh);
  }
}

function disposeGenerated(group: THREE.Group) {
  group.traverse((object) => {
    if(object instanceof THREE.Line && object.userData.pathGuide) {object.geometry.dispose();(object.material as THREE.Material).dispose();}
    if (object instanceof THREE.InstancedMesh) object.dispose();
    if (object instanceof THREE.Mesh && object.geometry.userData.morGenerated) object.geometry.dispose();
    if (object instanceof THREE.Mesh && object.userData.terrainPaintMaterials) {
      for (const material of object.userData.terrainPaintMaterials as THREE.Material[]) material.dispose();
    }
  });
  group.clear();
}

function fitCamera(runtime: SceneRuntime, layout: GeneratedLayout, top = false) {
  const { minX, minY, maxX, maxY } = layout.bounds;
  const centerX = (minX + maxX) / 2;
  const centerZ = planYToWorldZ((minY + maxY) / 2);
  const elevations = [...layout.roomGrounds, ...layout.floorGrounds].map((ground) => ground.elevation ?? 0);
  const minElevation = elevations.length ? Math.min(...elevations) : runtime.gridElevation;
  const maxElevation = elevations.length ? Math.max(...elevations) : runtime.gridElevation;
  const centerElevation = (minElevation + maxElevation) / 2;
  const span = Math.max(maxX - minX, maxY - minY, (maxElevation - minElevation) * 1.5, 7);
  runtime.controls.target.set(centerX, centerElevation + 0.85, centerZ);
  if (top) {
    runtime.camera.up.set(0, 0, -1);
    runtime.camera.position.set(centerX, centerElevation + span * 1.55, centerZ);
  } else {
    runtime.camera.up.set(0, 1, 0);
    runtime.camera.position.set(centerX + span * 0.92, centerElevation + span * 0.82, centerZ + span * 1.05);
  }
  runtime.camera.near = Math.max(0.05, span / 500);
  runtime.camera.far = Math.max(1200, span * 30);
  runtime.camera.updateProjectionMatrix();
  runtime.controls.update();
  runtime.render();
}

function addStraightLayer(runtime: SceneRuntime, wall: WallSegment, variant: Variant, flipped: boolean, signedOffset: number, template?: THREE.Group | null) {
  const alongX = flipped ? wall.x + Math.cos(wall.rotation) * wall.length : wall.x;
  const alongY = flipped ? wall.y + Math.sin(wall.rotation) * wall.length : wall.y;
  const x = alongX - Math.sin(wall.rotation) * signedOffset;
  const y = alongY + Math.cos(wall.rotation) * signedOffset;
  return addModel(runtime, template === undefined ? runtime.assets.walls[variant] : template, x, planYToWorldZ(y), wall.rotation + (flipped ? Math.PI : 0), wall.elevation ?? 0, wall);
}

function addTerrain(runtime: SceneRuntime, layout: GeneratedLayout, terrain: TerrainCell[], enabled: boolean, requestedSubdivisions: number, regions: TerrainRegion[]) {
  runtime.terrainSurface.update(runtime.terrainLayout ?? layout, terrain, regions, { terrainEnabled: enabled, terrainMeshResolution: requestedSubdivisions, terrainTexture: runtime.terrainVariant } as BuildSettings, runtime.terrainTextures, runtime.gridElevation);
}

function rebuildTerrainGuides(runtime: SceneRuntime, regions: TerrainRegion[]) {
  for (const child of [...runtime.terrainGuides.children]) {
    const geometry = (child as THREE.Mesh | THREE.Line).geometry;
    geometry?.dispose();
    if (child.userData.terrainOwnMaterial) {
      const material = (child as THREE.Line).material;
      if (Array.isArray(material)) material.forEach((candidate) => candidate.dispose());
      else material.dispose();
    }
    runtime.terrainGuides.remove(child);
  }
  for (const region of regions) {
    if (region.brush) continue;
    const sampled = sampleClosedTerrainSpline(region.controlPoints);
    if (sampled.length < 3) continue;
    const geometry = new THREE.BufferGeometry().setFromPoints(sampled.map((point) =>
      new THREE.Vector3(point.x, 0.36, planYToWorldZ(point.y))));
    const lineMaterial = runtime.materials.terrainSpline.clone();
    const line = new THREE.LineLoop(geometry, lineMaterial);
    line.renderOrder = 45;
    line.userData.terrainRegionId = region.id;
    line.userData.terrainOwnMaterial = true;
    runtime.terrainGuides.add(line);
    region.controlPoints.forEach((point, controlIndex) => {
      const handle = new THREE.Mesh(runtime.cube.clone(), runtime.materials.terrainControl.clone());
      handle.userData.terrainOwnMaterial = true;
      handle.position.set(point.x, 0.38, planYToWorldZ(point.y));
      handle.scale.set(0.34, 0.12, 0.34);
      handle.renderOrder = 46;
      handle.userData.terrainControl = { regionId: region.id, controlIndex };
      runtime.terrainGuides.add(handle);
    });
  }
  runtime.render();
}

function applyTerrainTexture(runtime: SceneRuntime, variant: TerrainTextureVariant) {
  runtime.terrainVariant = variant;
  const textures = runtime.terrainTextures[variant];
  const material = runtime.materials.terrain;
  material.map = textures?.color ?? null;
  material.normalMap = textures?.normal ?? null;
  material.bumpMap = textures?.height ?? null;
  material.bumpScale = textures ? 0.14 : 0;
  material.normalScale.setScalar(textures ? 0.75 : 1);
  material.color.setHex(textures ? 0xffffff : 0x66745a);
  material.needsUpdate = true;
}

function addPlatformFloors(runtime: SceneRuntime, layout: GeneratedLayout, stairs: StairPlacement[]) {
  for (const ground of layout.floorGrounds) {
    if (ground.outer.length < 3) continue;
    const material = firstGroundMaterial(runtime.assets.platformFloors[ground.variant], runtime.materials.floors.A);
    const stairHoles = stairOpeningsAtElevation(stairs, ground.elevation ?? 0);
    if (addAuthoredFloorTiles(runtime, ground, stairHoles, material, { floorId: ground.floorId })) continue;

    // Keep a lightweight fallback while the authored tile is loading.
    const shape = shapeForGround(ground, stairs);
    const geometry = new THREE.ShapeGeometry(shape);
    const position = geometry.getAttribute("position");
    const uv = geometry.getAttribute("uv");
    for (let index = 0; index < position.count; index += 1) uv.setXY(index, position.getX(index) / CELL_SIZE, position.getY(index) / CELL_SIZE);
    uv.needsUpdate = true;
    geometry.userData.morGenerated = true;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = ground.elevation ?? 0;
    mesh.receiveShadow = true;
    mesh.userData.floorId = ground.floorId;
    runtime.generated.add(mesh);
  }

}

function addStairs(runtime: SceneRuntime, stairs: StairPlacement[]) {
  for (const stair of stairs) {
    const size = stairFootprintSize(stair.asset);
    const center = { x: stair.cell.x * CELL_SIZE + size / 2, y: stair.cell.y * CELL_SIZE + size / 2 };
    const template = runtime.assets.stairs[stair.asset];
    if (!template) continue;
    // Keep the imported centering offset inside the pivot so it rotates too.
    const pivot = new THREE.Group();
    pivot.add(template.clone(true));
    pivot.position.set(center.x, stair.elevationSteps * ROOM_ELEVATION_STEP, planYToWorldZ(center.y));
    pivot.rotation.y = stair.rotation;
    pivot.traverse((object) => { object.userData.stairPlacementId = stair.id; });
    runtime.generated.add(pivot);
  }
}

function addRoomConnections(runtime: SceneRuntime, connections: RoomConnection[], rooms: Room[]) {
  for (const connection of connections) {
    const geometry = buildConnectionGeometry(connection, rooms);
    if (!geometry) continue;
    if(connection.pathPoints) {
      const points=resolvePathPoints(connection,rooms);
      const invalid=pathwayGeometry(points,connection.brokenSegments).invalidSegments;
      for(let i=0;i<points.length-1;i++) {
        const a=points[i],b=points[i+1],broken=connection.brokenSegments?.includes(i);
        const material=new THREE.LineDashedMaterial({color:invalid.includes(i)?0xff4433:broken?0xdd7766:0xffdd55,depthTest:false,depthWrite:false,dashSize:broken?0.25:10000,gapSize:broken?0.25:0});
        const line=new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(a.x,a.elevation+0.1,-a.y),new THREE.Vector3(b.x,b.elevation+0.1,-b.y)]),material);
        line.computeLineDistances();line.renderOrder=999;line.userData.pathGuide=true;line.userData.pathSegment=i;line.userData.roomConnectionId=connection.id;line.userData.keepFloorElevation=true;runtime.generated.add(line);
      }
      points.forEach((p,index)=>{
        for(const vertical of [false,true]) {
          const arrow=vertical?new THREE.ConeGeometry(0.25,0.7,4):null;
          if(arrow)arrow.userData.morGenerated=true;
          const handle=new THREE.Mesh(arrow??runtime.cube,runtime.materials.terrainControl);
          handle.position.set(p.x,p.elevation+(vertical?1:0.2),planYToWorldZ(p.y));
          handle.scale.set(vertical?1:0.4,vertical?1:0.2,vertical?1:0.4);
          handle.renderOrder=1000;handle.userData.connectionHandle=connection.id;handle.userData.roomConnectionId=connection.id;
          handle.userData.pathIndex=index;handle.userData.pathVertical=vertical;handle.userData.keepFloorElevation=true;
          if(vertical)handle.userData.pathVerticalBase=[p.x,p.elevation+1,planYToWorldZ(p.y)];
          runtime.generated.add(handle);
        }
      });
    }
    if (geometry.handle) {
      const handle = new THREE.Mesh(runtime.cube, runtime.materials.terrainControl);
      handle.position.set(geometry.handle.x, Math.max(...geometry.floorTiles.map(t=>t.elevation)) + 0.3, planYToWorldZ(geometry.handle.y));
      handle.scale.set(0.5,0.5,0.5);
      handle.renderOrder = 1000;
      handle.userData.connectionHandle = connection.id;
      handle.userData.roomConnectionId = connection.id;
      handle.userData.keepFloorElevation = true;
      runtime.generated.add(handle);
    }
    for (const flight of geometry.stairFlights) {
      if (!runtime.assets.connectionStair) continue;
      const pivot=new THREE.Group(); pivot.add(runtime.assets.connectionStair.clone(true));
      pivot.position.set(flight.point.x,flight.elevation,planYToWorldZ(flight.point.y)); pivot.rotation.y=flight.rotation;
      pivot.userData.keepFloorElevation = true;
      pivot.traverse(object=>{object.userData.roomConnectionId=connection.id;object.userData.pathSegment=flight.segmentIndex;});runtime.generated.add(pivot);
    }
    for (const tile of geometry.floorTiles) {
      if(tile.length!==undefined) {
        const pivot=new THREE.Group();
        const template=runtime.assets.platformFloors["1"];
        if(template) { const model=template.clone(true);model.position.x-=1;model.position.z+=1;pivot.add(model); }
        else {const model=new THREE.Mesh(runtime.cube,runtime.materials.floors.A);model.scale.set(2,0.1,2);pivot.add(model);}
        pivot.position.set(tile.point.x,tile.elevation,planYToWorldZ(tile.point.y));pivot.rotation.y=tile.rotation??0;pivot.scale.x=tile.length/2;
        pivot.userData.keepFloorElevation=true;pivot.traverse(o=>{o.userData.roomConnectionId=connection.id;o.userData.pathSegment=tile.segmentIndex;});runtime.generated.add(pivot);continue;
      }
      const template = runtime.assets.platformFloors["1"];
      if (template) {
        const model = template.clone(true);
        model.position.x += tile.point.x - CELL_SIZE / 2;
        model.position.y += tile.elevation;
        model.userData.keepFloorElevation = true;
        model.position.z += planYToWorldZ(tile.point.y - CELL_SIZE / 2);
        model.traverse((object) => { object.userData.roomConnectionId = connection.id; });
        runtime.generated.add(model);
      } else {
        const mesh = new THREE.Mesh(runtime.cube, runtime.materials.floors.A);
        mesh.position.set(tile.point.x, tile.elevation, planYToWorldZ(tile.point.y));
        mesh.scale.set(CELL_SIZE, 0.12, CELL_SIZE);
        mesh.userData.roomConnectionId = connection.id;
        mesh.userData.keepFloorElevation = true;
        runtime.generated.add(mesh);
      }
    }
  }
}

export function snapPillarPoint(point: PlanPoint): PlanPoint {
  const cellX = Math.floor(point.x / CELL_SIZE);
  const cellY = Math.floor(point.y / CELL_SIZE);
  const candidates = [
    { x: cellX * CELL_SIZE, y: cellY * CELL_SIZE },
    { x: (cellX + 1) * CELL_SIZE, y: cellY * CELL_SIZE },
    { x: cellX * CELL_SIZE, y: (cellY + 1) * CELL_SIZE },
    { x: (cellX + 1) * CELL_SIZE, y: (cellY + 1) * CELL_SIZE },
    { x: (cellX + 0.5) * CELL_SIZE, y: (cellY + 0.5) * CELL_SIZE },
  ];
  return candidates.sort((a, b) => Math.hypot(point.x - a.x, point.y - a.y) - Math.hypot(point.x - b.x, point.y - b.y))[0];
}

function addPlacedPillars(runtime: SceneRuntime, pillars: PillarPlacement[], settings: BuildSettings) {
  for (const pillar of pillars) {
    const elevation = pillar.elevationSteps * ROOM_ELEVATION_STEP;
    const model = addModel(runtime, runtime.assets.modulePillars[settings.modulePillarVariant] ?? runtime.assets.pillar,
      pillar.point.x, planYToWorldZ(pillar.point.y), 0, elevation);
    if (model) model.traverse((object) => { object.userData.pillarPlacementId = pillar.id; });
  }
}

function addBalconyAssembly(runtime: SceneRuntime, layout: GeneratedLayout) {
  for (const railing of layout.balconyRailings) {
    const model = addModel(runtime, runtime.assets.balconyRailing, railing.x, planYToWorldZ(railing.y), railing.rotation, railing.elevation ?? 0, railing);
    if (model) model.scale.x *= railing.length / BALCONY_RAILING_MODULE_SIZE;
  }
  for (const pillar of layout.balconyPillars) {
    addModel(runtime, runtime.assets.balconyPillar, pillar.x, planYToWorldZ(pillar.y), 0, pillar.elevation ?? 0);
  }
}

function addRoomSelections(runtime: SceneRuntime, layout: GeneratedLayout, stairs: StairPlacement[], roomIds: string[]) {
  const selected = new Set(roomIds);
  for (const ground of layout.roomGrounds.filter((candidate) => selected.has(candidate.roomId))) {
    if (ground.outer.length < 3) continue;
    const geometry = new THREE.ShapeGeometry(shapeForGround(ground, stairs));
    geometry.userData.morGenerated = true;
    const mesh = new THREE.Mesh(geometry, runtime.materials.floorSelection);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = (ground.elevation ?? 0) + 0.065;
    mesh.renderOrder = 24;
    runtime.generated.add(mesh);
  }
}

function addFloorSelection(runtime: SceneRuntime, layout: GeneratedLayout, stairs: StairPlacement[], floorId: string, selectedAreas: Array<{ floorId: string; cells: Cell[] }>) {
  if (selectedAreas.length) {
    for (const area of selectedAreas) {
      const elevation = layout.floorHitAreas.find((candidate) => candidate.floorId === area.floorId)?.elevation ?? 0;
      for (const cell of area.cells) {
      const mesh = new THREE.Mesh(runtime.cube, runtime.materials.floorSelection);
      mesh.position.set((cell.x + 0.5) * CELL_SIZE, elevation + 0.075, planYToWorldZ((cell.y + 0.5) * CELL_SIZE));
      mesh.scale.set(CELL_SIZE - 0.08, 0.025, CELL_SIZE - 0.08);
      mesh.renderOrder = 19;
      mesh.userData.floorSelection = true;
      runtime.generated.add(mesh);
      }
    }
    return;
  }
  for (const ground of layout.floorGrounds.filter((candidate) => candidate.floorId === floorId)) {
    if (ground.outer.length < 3) continue;
    const shape = shapeForGround(ground, stairs);
    const geometry = new THREE.ShapeGeometry(shape);
    geometry.userData.morGenerated = true;
    const mesh = new THREE.Mesh(geometry, runtime.materials.floorSelection);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = (ground.elevation ?? 0) + 0.065;
    mesh.renderOrder = 24;
    runtime.generated.add(mesh);
  }
}

function renderStraightWall(runtime: SceneRuntime, layout: GeneratedLayout, wall: WallSegment, settings: BuildSettings, fallbackWalls: Transform[]) {
  const opening = wall.length <= CELL_SIZE + 1e-4 ? openingForWall(layout.openings, wall) : undefined;
  const wallTemplate = runtime.assets.moduleWalls[settings.moduleWallVariant];
  let layerTemplate = wallTemplate;
  if (opening && !openingIsFullReplacement(opening.asset)) {
    const kind = apertureKind(opening.asset);
    const key = `${settings.moduleWallVariant}:${kind}`;
    if (kind && wallTemplate && !runtime.assets.cutWalls.has(key)) {
      try {
        runtime.assets.cutWalls.set(key, subtractOpening(wallTemplate, kind));
      } catch (error) {
        console.error(`[boolean] failed for wall ${settings.moduleWallVariant} and ${kind}`, error);
      }
    }
    layerTemplate = runtime.assets.cutWalls.get(key) ?? wallTemplate;
  }
  let added = true;
  if (!opening || !openingIsFullReplacement(opening.asset)) if (wall.opposingRoomId) {
    if (settings.showInnerWalls) {
      const separation = settings.sharedWallSeparation / 2;
      // Shared layers straddle the exact common boundary. The normal inner-wall
      // offset belongs to exterior boundaries; applying it here leaves a hollow gap.
      added = addStraightLayer(runtime, wall, wall.insideVariant ?? wall.variant, settings.flipInnerWall, separation, layerTemplate) && added;
      added = addStraightLayer(runtime, wall, wall.opposingVariant ?? wall.variant, !settings.flipInnerWall, -separation, layerTemplate) && added;
    }
  } else {
    if (settings.showInnerWalls) added = addStraightLayer(runtime, wall, wall.insideVariant ?? settings.innerWallVariant, settings.flipInnerWall, settings.innerWallOffset, layerTemplate) && added;
    if (settings.showOuterWalls) added = addStraightLayer(runtime, wall, wall.outsideVariant ?? settings.outerWallVariant, settings.flipOuterWall, -settings.outerWallOffset, layerTemplate) && added;
  }
  if (opening) {
    const model = runtime.assets.openingModels[opening.asset];
    // Door, window and cutter FBXs use the inside wall as their authored depth
    // reference. Keep that exact offset and flip; the asset itself spans toward
    // the outside layer while its normalized X remains centred in the module.
    const transform = openingTransformForWall(wall, settings);
    addOpeningModel(runtime, model, wall, transform.x, planYToWorldZ(transform.y), transform.rotation);
  }
  if (!added && !opening) fallbackWalls.push(wallTransform(wall.x, wall.y, wall.length, wall.rotation, wall.elevation ?? 0));
}

function renderPathWall(runtime: SceneRuntime, wall: WallPath, settings: BuildSettings) {
  const template = runtime.assets.moduleWalls[settings.moduleWallVariant] ?? runtime.assets.walls[wall.insideVariant];
  if (wall.opposingRoomId) {
    if (!settings.showInnerWalls) return;
    const separation = settings.sharedWallSeparation / 2;
    // Curved and edited shared boundaries follow the same canonical-edge rule.
    addDeformedWall(runtime, template, wall.points, settings.flipInnerWall, separation, wall);
    addDeformedWall(runtime, template, wall.points, !settings.flipInnerWall, -separation, wall);
    return;
  }
  if (settings.showInnerWalls) addDeformedWall(runtime, template, wall.points, settings.flipInnerWall, settings.innerWallOffset, wall);
  if (settings.showOuterWalls) addDeformedWall(runtime, template, wall.points, settings.flipOuterWall, -settings.outerWallOffset, wall);
}

function updateDynamicLighting(runtime: SceneRuntime, layout: GeneratedLayout, settings: BuildSettings) {
  const { scene, renderer, hemisphere, sun } = runtime;
  renderer.toneMappingExposure = settings.exposure;

  const centerX = (layout.bounds.minX + layout.bounds.maxX) / 2;
  const centerY = (layout.bounds.minY + layout.bounds.maxY) / 2;
  const centerZ = planYToWorldZ(centerY);
  const elevations = [...layout.roomGrounds, ...layout.floorGrounds].map((ground) => ground.elevation ?? 0);
  const centerElevation = elevations.length ? (Math.min(...elevations) + Math.max(...elevations)) / 2 : 0;
  const span = Math.max(layout.bounds.maxX - layout.bounds.minX, layout.bounds.maxY - layout.bounds.minY, 20);
  const shadowSpan = Math.max(45, span * 0.72 + 12);
  sun.shadow.camera.left = -shadowSpan;
  sun.shadow.camera.right = shadowSpan;
  sun.shadow.camera.top = shadowSpan;
  sun.shadow.camera.bottom = -shadowSpan;
  sun.shadow.camera.near = 0.5;
  sun.shadow.camera.far = Math.max(350, span * 8);
  sun.shadow.camera.updateProjectionMatrix();
  sun.target.position.set(centerX, centerElevation, centerZ);
  sun.target.updateMatrixWorld();

  const applyHdri = () => {
    scene.environment = runtime.hdriEnvironmentMap;
    scene.environmentIntensity = settings.hdriIntensity;
    const rotation = THREE.MathUtils.degToRad(settings.hdriRotation);
    scene.environmentRotation.set(0, rotation, 0);
    scene.backgroundRotation.set(0, rotation, 0);
    if (settings.hdriBackground && runtime.hdriBackgroundMap) scene.background = runtime.hdriBackgroundMap;
  };

  if (!settings.dynamicLighting) {
    scene.background = new THREE.Color(0x131715);
    if (scene.fog instanceof THREE.Fog) scene.fog.color.set(0x131715);
    hemisphere.color.set(0xf2eee4);
    hemisphere.groundColor.set(0x1a211d);
    hemisphere.intensity = 2.25 * settings.ambientLight;
    sun.color.set(0xfff3dc);
    sun.intensity = 3.2;
    sun.position.set(centerX + span * 0.9, centerElevation + span * 1.4, centerZ + span * 0.7);
    applyHdri();
    return;
  }

  const hour = ((settings.timeOfDay % 24) + 24) % 24;
  const solarAngle = ((hour - 6) / 24) * Math.PI * 2;
  const elevation = Math.sin(solarAngle);
  const daylight = THREE.MathUtils.smoothstep(elevation, -0.14, 0.34);
  const horizonGlow = 1 - THREE.MathUtils.smoothstep(Math.abs(elevation), 0.03, 0.42);
  const azimuth = solarAngle + Math.PI * 0.18;
  const orbitRadius = Math.max(70, span * 2.4);
  const lightElevation = elevation >= -0.08 ? Math.max(0.08, elevation) : Math.max(0.12, -elevation);
  const horizontalDirection = elevation >= -0.08 ? 1 : -1;
  sun.position.set(
    centerX + Math.cos(azimuth) * orbitRadius * horizontalDirection,
    centerElevation + lightElevation * orbitRadius,
    centerZ + Math.sin(azimuth) * orbitRadius * horizontalDirection,
  );

  const nightSky = new THREE.Color(0x070d18);
  const daySky = new THREE.Color(0x7893a4);
  const twilightSky = new THREE.Color(0x8b5046);
  const sky = nightSky.clone().lerp(daySky, daylight).lerp(twilightSky, horizonGlow * 0.58);
  scene.background = sky;
  if (scene.fog instanceof THREE.Fog) scene.fog.color.copy(sky);

  const warmSun = new THREE.Color(0xff8a5a);
  const highSun = new THREE.Color(0xfff2d6);
  const moon = new THREE.Color(0x91aee0);
  sun.color.copy(elevation >= -0.08
    ? warmSun.clone().lerp(highSun, THREE.MathUtils.smoothstep(elevation, 0.05, 0.75))
    : moon);
  sun.intensity = elevation >= -0.08 ? 0.35 + daylight * 3.4 : 0.55;

  hemisphere.color.copy(new THREE.Color(0x91a7bc).lerp(new THREE.Color(0xe9edf0), daylight));
  hemisphere.groundColor.copy(new THREE.Color(0x101722).lerp(new THREE.Color(0x31372f), daylight));
  hemisphere.intensity = settings.ambientLight * (0.38 + daylight * 1.55);
  applyHdri();
}

function rebuildScene(runtime: SceneRuntime, layout: GeneratedLayout, rooms: Room[], roomConnections: RoomConnection[], stairs: StairPlacement[], placedPillars: PillarPlacement[], terrain: TerrainCell[], regions: TerrainRegion[], settings: BuildSettings, selectedRoomId: string | null, selectedRoomIds: string[], selectedFloorCells: Cell[] | null, selectedFloorAreas: Array<{ floorId: string; cells: Cell[] }>, activeCorner: CornerIdentity | null) {
  disposeGenerated(runtime.generated);
  runtime.handles.clear();
  addTerrain(runtime, layout, terrain, settings.terrainEnabled !== false, settings.terrainMeshResolution ?? 4, regions);

  if (layout.roomGrounds.length) {
    addRoomGround(runtime, layout, stairs, settings);
  } else {
    const floorTransforms: Transform[] = [];
    for (const cell of layout.cells) {
      const center = cellCenterToWorld(cell);
      if (addModel(runtime, runtime.assets.grounds[settings.floorVariant], center.x, center.z)) continue;
      floorTransforms.push({ x: center.x, y: 0, z: center.z, sx: CELL_SIZE - 0.06, sy: 0.12, sz: CELL_SIZE - 0.06 });
    }
    addInstances(runtime, floorTransforms, runtime.materials.floors[settings.floorVariant], false);
  }
  addPlatformFloors(runtime, layout, stairs);
  const standingStart = runtime.generated.children.length;
  addStairs(runtime, stairs);
  addRoomConnections(runtime, roomConnections, rooms);
  addPlacedPillars(runtime, placedPillars, settings);
  addBalconyAssembly(runtime, layout);
  for (const mesh of runtime.generated.children.slice(standingStart)) {
    if (!mesh.userData.keepFloorElevation) mesh.position.y -= 0.16;
  }
  if (selectedRoomIds.length) addRoomSelections(runtime, layout, stairs, selectedRoomIds);
  if (selectedRoomId && layout.floorHitAreas.some((ground) => ground.floorId === selectedRoomId)) {
    addFloorSelection(runtime, layout, stairs, selectedRoomId, selectedFloorAreas);
  }

  const wallStart = runtime.generated.children.length;
  const fallbackWalls: Transform[] = [];
  layout.walls.forEach((wall) => renderStraightWall(runtime, layout, wall, settings, fallbackWalls));
  layout.wallPaths.forEach((wall) => renderPathWall(runtime, wall, settings));
  addInstances(runtime, fallbackWalls, runtime.materials.walls[settings.wallVariant]);
  addInstances(runtime, fallbackWalls.map((transform) => ({ ...transform, y: transform.y + WALL_HEIGHT / 2 - 0.05, sy: 0.1, sz: WALL_THICKNESS + 0.035 })), runtime.materials.trim, false);

  for (const variant of ["A", "B", "C"] as Variant[]) {
    const transforms = layout.pillars.filter((pillar) => pillar.variant === variant).flatMap((pillar) => {
      if (addModel(runtime, runtime.assets.modulePillars[settings.modulePillarVariant] ?? runtime.assets.pillar, pillar.x, planYToWorldZ(pillar.y), 0, pillar.elevation ?? 0)) return [];
      const width = pillar.junction ? 0.32 : variant === "B" ? 0.42 : variant === "C" ? 0.28 : 0.35;
      return [{ x: pillar.x, y: (pillar.elevation ?? 0) + WALL_HEIGHT / 2, z: planYToWorldZ(pillar.y), sx: width, sy: WALL_HEIGHT + 0.05, sz: width }];
    });
    addInstances(runtime, transforms, runtime.materials.pillars[variant]);
  }

  for (const mesh of runtime.generated.children.slice(wallStart)) mesh.position.y -= 0.16;

  if (selectedRoomId) {
    // Selecting one room exposes the connected assembly. Shared room boundaries and
    // vertices collapse to a single control instead of drawing controls on top of each other.
    const floorSelected = layout.floorHitAreas.some((ground) => ground.floorId === selectedRoomId);
    const visibleRoomIds = floorSelected ? new Set([selectedRoomId]) : joinedRoomIds(layout, selectedRoomId);
    const visibleCorners = (floorSelected
      ? (selectedFloorCells?.length ? [] : layout.floorCornerHandles)
      : layout.cornerHandles).filter((candidate) => visibleRoomIds.has(candidate.roomId));
    const mergedCorners = new Map<string, CornerHandle[]>();
    for (const handle of visibleCorners) {
      const key = `${handle.vertexX},${handle.vertexY},${(handle.elevation ?? 0).toFixed(4)}`;
      const cornerGroup = mergedCorners.get(key) ?? [];
      cornerGroup.push(handle);
      mergedCorners.set(key, cornerGroup);
    }
    for (const cornerGroup of mergedCorners.values()) {
      // Prefer the currently selected room, so the corner editor always stays focused
      // on the room the user originally clicked.
      const handle = cornerGroup.find((candidate) => candidate.roomId === selectedRoomId) ?? cornerGroup[0];
      const active = activeCorner?.roomId === handle.roomId && activeCorner.vertexX === handle.vertexX && activeCorner.vertexY === handle.vertexY;
      const mesh = new THREE.Mesh(runtime.cube, active ? runtime.materials.handleActive : runtime.materials.handle);
      mesh.position.set(handle.vertexX * CELL_SIZE, (handle.elevation ?? 0) + 0.7, planYToWorldZ(handle.vertexY * CELL_SIZE));
      mesh.scale.setScalar(active ? 0.86 : 0.72);
      mesh.renderOrder = 30;
      mesh.userData.cornerHandle = handle;
      runtime.handles.add(mesh);
    }
    // Four grab points around the circumference; each resizes the radius identically.
    for (const handle of (floorSelected ? [] : layout.radiusHandles).filter((candidate) => visibleRoomIds.has(candidate.roomId))) {
      const mesh = new THREE.Mesh(runtime.cube, runtime.materials.handle);
      mesh.position.set(
        handle.cx + Math.cos(handle.angle) * handle.radius,
        (handle.elevation ?? 0) + 0.52,
        planYToWorldZ(handle.cy + Math.sin(handle.angle) * handle.radius),
      );
      mesh.scale.setScalar(0.32);
      mesh.renderOrder = 30;
      mesh.userData.radiusHandle = handle;
      runtime.handles.add(mesh);
    }
    // Long blue grips sit on each straight room edge. Dragging one perpendicular
    // to itself adds or removes a complete row of 2 m cells.
    for (const control of mergeWallResizeControls((floorSelected ? [] : layout.wallResizeHandles).filter((candidate) => visibleRoomIds.has(candidate.roomId)))) {
      const handle = control.handles.find((candidate) => candidate.roomId === selectedRoomId) ?? control.handles[0];
      const dx = handle.end.x - handle.start.x;
      const dy = handle.end.y - handle.start.y;
      const length = Math.hypot(dx, dy);
      const mesh = new THREE.Mesh(runtime.cube, runtime.materials.wallHandle);
      mesh.position.set(
        (handle.start.x + handle.end.x) / 2,
        (handle.elevation ?? 0) + 0.4,
        planYToWorldZ((handle.start.y + handle.end.y) / 2),
      );
      mesh.rotation.y = Math.atan2(dy, dx);
      mesh.scale.set(Math.max(0.7, length - 0.55), 0.14, 0.3);
      mesh.renderOrder = 29;
      mesh.userData.wallResizeControl = control;
      runtime.handles.add(mesh);
    }
  }
  runtime.render();
}

export function ThreeViewport({
  layout,
  displayLayout,
  terrainLayout,
  rooms,
  roomConnections,
  stairs,
  stairAsset,
  placedPillars,
  terrain,
  terrainRegions,
  terrainMode,
  gridElevation,
  settings,
  hdriUrl,
  hdriKind,
  cubeMapUrls,
  fitSignal,
  tool,
  eraseScope,
  wallDrawMode,
  openingAsset,
  selectedRoomId,
  selectedRoomIds,
  selectedFloorCells,
  selectedFloorAreas,
  activeCorner,
  onCommit,
  onTerrainRegionEdit,
  onSelectRoom,
  onSelectFloorArea,
  onActiveCorner,
  onCornerEdit,
  onCornerRemove,
  onCircleResize,
  onRoomMove,
  onWallResize,
  onPlaceOpening,
  onNotice,
}: ThreeViewportProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [terrainMenu, setTerrainMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [objectMenu, setObjectMenu] = useState<{ id: string; type: "remove-stair" | "remove-pillar" | "remove-connection"; x: number; y: number } | null>(null);
  const [pathMenu,setPathMenu]=useState<{connection:RoomConnection;index?:number;segment?:number;x:number;y:number}|null>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<SceneRuntime | null>(null);
  const layoutRef = useRef(layout);
  const displayLayoutRef = useRef(displayLayout);
  const roomsRef = useRef(rooms);
  const roomConnectionsRef = useRef(roomConnections);
  const stairsRef = useRef(stairs);
  const stairAssetRef = useRef(stairAsset);
  const placedPillarsRef = useRef(placedPillars);
  const terrainRef = useRef(terrain);
  const terrainRegionsRef = useRef(terrainRegions);
  const terrainModeRef = useRef(terrainMode);
  const settingsRef = useRef(settings);
  const toolRef = useRef(tool);
  const eraseScopeRef = useRef(eraseScope);
  const wallDrawModeRef = useRef(wallDrawMode);
  const openingAssetRef = useRef(openingAsset);
  const selectedRoomRef = useRef(selectedRoomId);
  const selectedRoomIdsRef = useRef(selectedRoomIds);
  const selectedFloorCellsRef = useRef(selectedFloorCells);
  const selectedFloorAreasRef = useRef(selectedFloorAreas);
  const activeCornerRef = useRef(activeCorner);
  const onCommitRef = useRef(onCommit);
  const onTerrainRegionEditRef = useRef(onTerrainRegionEdit);
  const onNoticeRef = useRef(onNotice);
  const onSelectRoomRef = useRef(onSelectRoom);
  const onSelectFloorAreaRef = useRef(onSelectFloorArea);
  const onActiveCornerRef = useRef(onActiveCorner);
  const onCornerEditRef = useRef(onCornerEdit);
  const onCornerRemoveRef = useRef(onCornerRemove);
  const onCircleResizeRef = useRef(onCircleResize);
  const onRoomMoveRef = useRef(onRoomMove);
  const onWallResizeRef = useRef(onWallResize);
  const onPlaceOpeningRef = useRef(onPlaceOpening);

  onCommitRef.current = onCommit;
  onTerrainRegionEditRef.current = onTerrainRegionEdit;
  eraseScopeRef.current = eraseScope;
  wallDrawModeRef.current = wallDrawMode;
  onNoticeRef.current = onNotice;
  onSelectRoomRef.current = onSelectRoom;
  onSelectFloorAreaRef.current = onSelectFloorArea;
  onActiveCornerRef.current = onActiveCorner;
  onCornerEditRef.current = onCornerEdit;
  onCornerRemoveRef.current = onCornerRemove;
  onCircleResizeRef.current = onCircleResize;
  onRoomMoveRef.current = onRoomMove;
  onWallResizeRef.current = onWallResize;
  openingAssetRef.current = openingAsset;
  terrainModeRef.current = terrainMode;
  onPlaceOpeningRef.current = onPlaceOpening;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x131715);
    scene.fog = new THREE.Fog(0x131715, 240, 700);
    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 500);
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    host.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = false;
    controls.minDistance = 3;
    controls.maxDistance = 180;
    controls.maxPolarAngle = Math.PI / 2 - 0.025;
    controls.screenSpacePanning = true;
    controls.mouseButtons.LEFT = null;
    controls.mouseButtons.MIDDLE = THREE.MOUSE.PAN;
    controls.mouseButtons.RIGHT = THREE.MOUSE.ROTATE;
    controls.touches.ONE = null;
    controls.touches.TWO = THREE.TOUCH.DOLLY_PAN;

    const generated = new THREE.Group();
    const handles = new THREE.Group();
    const terrainGuides = new THREE.Group();
    handles.renderOrder = 30;
    terrainGuides.renderOrder = 45;
    scene.add(generated, handles, terrainGuides);
    const assets: SceneRuntime["assets"] = {
      grounds: { A: null, B: null, C: null }, pillar: null, walls: { A: null, B: null, C: null },
      moduleWalls: Object.fromEntries(WALL_MODULE_VARIANTS.map((variant) => [variant, null])) as Record<WallModuleVariant, THREE.Group | null>,
      modulePillars: Object.fromEntries(PILLAR_MODULE_VARIANTS.map((variant) => [variant, null])) as Record<PillarModuleVariant, THREE.Group | null>,
      openingModels: Object.fromEntries(OPENING_ASSETS.map((asset) => [asset, null])) as Record<OpeningAsset, THREE.Group | null>,
      platformFloors: { "1": null, "2": null },
      stairs: Object.fromEntries(STAIR_ASSETS.map((asset) => [asset, null])) as Record<StairAsset, THREE.Group | null>,
      connectionStair: null,
      balconyRailing: null,
      balconyPillar: null,
      cutWalls: new Map(),
    };
    const cube = new THREE.BoxGeometry(1, 1, 1);
    const materials: SceneRuntime["materials"] = {
      floors: { A: makeMaterial(0xb9b2a5, 0.88), B: makeMaterial(0x8d9690, 0.82), C: makeMaterial(0xa56c56, 0.84) },
      walls: { A: makeMaterial(0xd9d3c7, 0.78), B: makeMaterial(0x87978a, 0.82), C: makeMaterial(0xb66c52, 0.8) },
      pillars: { A: makeMaterial(0x343a35, 0.66), B: makeMaterial(0x6f785f, 0.72), C: makeMaterial(0x9c503c, 0.74) },
      trim: makeMaterial(0x2d342f, 0.62),
      handle: new THREE.MeshBasicMaterial({ color: 0xc6d36e, depthTest: false, depthWrite: false }),
      handleActive: new THREE.MeshBasicMaterial({ color: 0xcf5c3d, depthTest: false, depthWrite: false }),
      wallHandle: new THREE.MeshBasicMaterial({ color: 0x48a9c5, transparent: true, opacity: 0.9, depthTest: false, depthWrite: false }),
      floorSelection: new THREE.MeshBasicMaterial({ color: 0x48a9c5, transparent: true, opacity: 0.34, depthTest: true, depthWrite: false }),
      terrain: new THREE.MeshStandardMaterial({ color: 0x66745a, roughness: 0.96, metalness: 0, side: THREE.DoubleSide }),
      terrainSpline: new THREE.LineBasicMaterial({ color: 0xff7a32, depthTest: false, depthWrite: false }),
      terrainControl: new THREE.MeshBasicMaterial({ color: 0xffc247, depthTest: false, depthWrite: false }),
    };
    const hemisphere = new THREE.HemisphereLight(0xf2eee4, 0x1a211d, 2.25);
    const sun = new THREE.DirectionalLight(0xfff3dc, 3.2);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.0003;
    scene.add(hemisphere, sun, sun.target);
    let displayGrid:THREE.GridHelper|undefined;
    const runtime: SceneRuntime = {
      terrainLayout,
      terrainSurface: new TerrainSurface(camera),
      terrainVariant: settingsRef.current.terrainTexture ?? "grass",
      scene,
      camera,
      renderer,
      controls,
      hemisphere,
      sun,
      hdriBackgroundMap: null,
      hdriEnvironmentMap: null,
      hdriLoadVersion: 0,
      generated,
      handles,
      terrainGuides,
      terrainTextures: { grass: null, "ground-rocks": null, "cliff-rocks": null },
      assets,
      cube,
      materials,
      render: () => {
        if(displayGrid) {displayGrid.visible=settingsRef.current.gridVisible!==false;displayGrid.position.y=visibleGridHeight(runtime.gridElevation)-0.005;}
        for(const child of runtime.generated.children) {
          if(child.userData.connectionHandle||child.userData.pathGuide) child.visible=toolRef.current==="connect";
          if(child.visible&&child.userData.pathVerticalBase) {
            const projected=new THREE.Vector3().fromArray(child.userData.pathVerticalBase).project(camera);
            // Separate the height arrow from the move point even in a straight top view.
            projected.x+=48/Math.max(1,renderer.domElement.clientWidth);
            child.position.copy(projected.unproject(camera));
          }
        }
        runtime.terrainSurface.updateLOD(); renderer.render(scene, camera);
      },
      setTool: () => undefined,
      gridElevation,
      setGridElevation: () => undefined,
    };
    runtimeRef.current = runtime;
    scene.add(runtime.terrainSurface.group);

    // The GLBs carry geometry only; their shared trimsheets live in /textures and are
    // referenced by URL, so SharedTextureLoader can collapse them to one upload apiece.
    const manager = new THREE.LoadingManager();
    const sharedTextures = new SharedTextureLoader(manager, Math.min(8, renderer.capabilities.getMaxAnisotropy()));
    manager.addHandler(/\.webp$/i, sharedTextures);
    const loader = new GLTFLoader(manager);
    const loadModel = (url: string, assign: (gltf: { scene: THREE.Group }) => void) =>
      loader.loadAsync(url).then(assign, (error) => {
        // Textures are separate files now, so a model can arrive while its trimsheet 404s.
        // Swallowing that silently would show an untextured room with no explanation.
        console.error(`[assets] failed to load ${url}`, error);
      });
    const refreshLoadedBalconyAssets = () => {
      if (runtimeRef.current !== runtime) return;
      rebuildScene(runtime, displayLayoutRef.current, roomsRef.current, roomConnectionsRef.current, stairsRef.current, placedPillarsRef.current, terrainRef.current, terrainRegionsRef.current, settingsRef.current, selectedRoomRef.current, selectedRoomIdsRef.current, selectedFloorCellsRef.current, selectedFloorAreasRef.current, activeCornerRef.current);
    };
    let floorTexture: THREE.Texture | null = null;
    const terrainLoader = new THREE.TextureLoader(manager);
    const loadTerrainTextureSet = async (variant: TerrainTextureVariant): Promise<TerrainTextureSet> => {
      const [color, normal, height] = await Promise.all([
        terrainLoader.loadAsync(`/textures/terrain-${variant}-color.png`),
        terrainLoader.loadAsync(`/textures/terrain-${variant}-normal.png`),
        terrainLoader.loadAsync(`/textures/terrain-${variant}-height.png`),
      ]);
      color.colorSpace = THREE.SRGBColorSpace;
      for (const texture of [color, normal, height]) {
        texture.wrapS = THREE.RepeatWrapping;
        texture.wrapT = THREE.RepeatWrapping;
        texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
        texture.needsUpdate = true;
      }
      return { color, normal, height };
    };
    const loadFloorMaterial = new THREE.TextureLoader(manager).loadAsync("/textures/Tiles074_2K-PNG_Color.56a8bc47.webp").then((texture) => {
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.wrapS = THREE.RepeatWrapping;
      texture.wrapT = THREE.RepeatWrapping;
      texture.repeat.set(0.5, 0.5);
      texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
      floorTexture = texture;
      for (const material of Object.values(materials.floors)) {
        material.color.setHex(0xffffff);
        material.map = texture;
        material.needsUpdate = true;
      }
    });
    void Promise.all([
      loadFloorMaterial,
      ...(["grass", "ground-rocks", "cliff-rocks"] as TerrainTextureVariant[]).map(async (variant) => {
        runtime.terrainTextures[variant] = await loadTerrainTextureSet(variant);
        if ((settingsRef.current.terrainTexture ?? "grass") === variant) {
          applyTerrainTexture(runtime, variant);
          runtime.render();
        }
      }),
      ...WALL_MODULE_VARIANTS.map((variant) => loadModel(wallModelUrl(variant), (gltf) => { assets.moduleWalls[variant] = prepareTemplate(gltf.scene); })),
      ...PILLAR_MODULE_VARIANTS.map((variant) => loadModel(pillarModelUrl(variant), (gltf) => { assets.modulePillars[variant] = prepareTemplate(gltf.scene); })),
      ...OPENING_ASSETS.map((asset) => loadModel(openingModelUrl(asset), (gltf) => { assets.openingModels[asset] = prepareOpeningTemplate(gltf.scene); })),
      loadModel("/models/FL2x2_1.glb", (gltf) => { assets.platformFloors["1"] = prepareTemplate(gltf.scene, false, true); }),
      loadModel("/models/FL2x2_2.glb", (gltf) => { assets.platformFloors["2"] = prepareTemplate(gltf.scene, false, true); }),
      ...STAIR_ASSETS.map((asset) => loadModel(stairModelUrl(asset), (gltf) => { assets.stairs[asset] = prepareTemplate(gltf.scene, true); })),
      loadModel("/models/ST_1.25x1_1.glb", (gltf) => { assets.connectionStair = prepareTemplate(gltf.scene, true); }),
      loadModel(balconyRailingModelUrl(), (gltf) => { assets.balconyRailing = prepareTemplate(gltf.scene); refreshLoadedBalconyAssets(); }),
      loadModel(balconyPillarModelUrl(), (gltf) => { assets.balconyPillar = prepareTemplate(gltf.scene); refreshLoadedBalconyAssets(); }),
    ]).then(() => {
      if (runtimeRef.current !== runtime) return;
      rebuildScene(runtime, displayLayoutRef.current, roomsRef.current, roomConnectionsRef.current, stairsRef.current, placedPillarsRef.current, terrainRef.current, terrainRegionsRef.current, settingsRef.current, selectedRoomRef.current, selectedRoomIdsRef.current, selectedFloorCellsRef.current, selectedFloorAreasRef.current, activeCornerRef.current);
      const { unique, issued } = sharedTextures.stats();
      console.info(`[assets] ${issued} texture slots served by ${unique} unique images; ${renderer.info.memory.textures} GPU textures live`);
    });

    // Keep the datum open: an opaque infinite plane hides every sunken floor. The grid
    // still marks 0 m while allowing floors below it to remain visible from above.
    const grid = new THREE.GridHelper(800, 400, 0x4f5c52, 0x303832);
    displayGrid=grid;
    grid.position.y = -0.005;
    scene.add(grid);

    const interaction = new THREE.Group();
    interaction.renderOrder = 20;
    scene.add(interaction);
    const hoverMaterial = new THREE.MeshBasicMaterial({ color: 0xcf5c3d, transparent: true, opacity: 0.24, depthTest: false, depthWrite: false });
    const draftMaterial = new THREE.MeshBasicMaterial({ color: 0xcf5c3d, transparent: true, opacity: 0.34, depthTest: false, depthWrite: false });
    const outlineMaterial = new THREE.LineBasicMaterial({ color: 0xf0a386, transparent: true, opacity: 0.95, depthTest: false });
    const hoverMesh = new THREE.Mesh(cube, hoverMaterial);
    hoverMesh.scale.set(CELL_SIZE - 0.08, 0.035, CELL_SIZE - 0.08);
    hoverMesh.position.y = 0.11;
    hoverMesh.visible = false;
    interaction.add(hoverMesh);
    const draftMesh = new THREE.Mesh(cube, draftMaterial);
    draftMesh.visible = false;
    interaction.add(draftMesh);
    const outlineGeometry = new THREE.EdgesGeometry(cube);
    const draftOutline = new THREE.LineSegments(outlineGeometry, outlineMaterial);
    draftOutline.visible = false;
    interaction.add(draftOutline);
    // Unit-radius disc and ring, built once and scaled per frame like the rect draft.
    const discGeometry = new THREE.CircleGeometry(1, 96);
    const circleDraftMesh = new THREE.Mesh(discGeometry, draftMaterial);
    circleDraftMesh.rotation.x = -Math.PI / 2;
    circleDraftMesh.visible = false;
    interaction.add(circleDraftMesh);
    const ringPositions = new Float32Array(96 * 3);
    for (let index = 0; index < 96; index += 1) {
      const angle = (index / 96) * Math.PI * 2;
      ringPositions[index * 3] = Math.cos(angle);
      ringPositions[index * 3 + 2] = Math.sin(angle);
    }
    const ringGeometry = new THREE.BufferGeometry();
    ringGeometry.setAttribute("position", new THREE.BufferAttribute(ringPositions, 3));
    const circleDraftOutline = new THREE.LineLoop(ringGeometry, outlineMaterial);
    circleDraftOutline.visible = false;
    interaction.add(circleDraftOutline);
    const curveDraftGeometry = new THREE.BufferGeometry();
    const curveDraftLine = new THREE.Line(curveDraftGeometry, outlineMaterial);
    curveDraftLine.visible = false;
    interaction.add(curveDraftLine);
    const arcAnchorGeometry = new THREE.RingGeometry(0.13, 0.23, 24);
    const arcAnchorMesh = new THREE.Mesh(arcAnchorGeometry, draftMaterial);
    arcAnchorMesh.rotation.x = -Math.PI / 2;
    arcAnchorMesh.position.y = 0.25;
    arcAnchorMesh.visible = false;
    interaction.add(arcAnchorMesh);
    const wallFootprintGeometry = new THREE.BufferGeometry();
    const wallFootprintMesh = new THREE.Mesh(wallFootprintGeometry, draftMaterial);
    wallFootprintMesh.visible = false;
    interaction.add(wallFootprintMesh);
    const wallFootprintOutlineGeometry = new THREE.BufferGeometry();
    const wallFootprintOutline = new THREE.LineSegments(wallFootprintOutlineGeometry, outlineMaterial);
    wallFootprintOutline.visible = false;
    interaction.add(wallFootprintOutline);

    const raycaster = new THREE.Raycaster();
    raycaster.params.Line.threshold = 0.4;
    const pointer = new THREE.Vector2();
    const hit = new THREE.Vector3();
    const drawingPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const terrainPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    let drawState: DrawState | null = null;
    let terrainSplinePending: TerrainSplinePendingState | null = null;
    let paintStroke: { pointerId: number; region: TerrainRegion } | null = null;
    let lastPaintPreview = 0;
    const brushCursor = new THREE.Mesh(new THREE.RingGeometry(0.97, 1, 64), new THREE.MeshBasicMaterial({ color: 0xffc766, side: THREE.DoubleSide, depthTest: false, transparent: true, opacity: 0.8 }));
    brushCursor.rotation.x = -Math.PI / 2;
    brushCursor.renderOrder = 100;
    brushCursor.visible = false;
    scene.add(brushCursor);
    const previewPaint = () => {
      runtime.terrainSurface.update(runtime.terrainLayout, terrainRef.current, paintStroke ? [...terrainRegionsRef.current, { ...paintStroke.region, controlPoints: [...paintStroke.region.controlPoints] }] : terrainRegionsRef.current, settingsRef.current, runtime.terrainTextures, runtime.gridElevation);
      runtime.render();
    };
    let terrainControlDrag: TerrainControlDragState | null = null;
    let terrainAdjustDrag: TerrainAdjustDragState | null = null;
    let hoveredTerrainLine: THREE.Line | null = null;
    let wallPathPending: WallPathPendingState | null = null;
    let arcChordPending: ArcChordPendingState | null = null;
    let arcPending: ArcPendingState | null = null;
    let lastWallClick: { point: PlanPoint; time: number } | null = null;
    let cornerDrag: CornerDragState | null = null;
    let radiusDrag: RadiusDragState | null = null;
    let roomMoveDrag: RoomMoveDragState | null = null;
    let wallResizeDrag: WallResizeDragState | null = null;

    const setRay = (event: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      if (!rect.width || !rect.height) return false;
      pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(pointer, camera);
      return true;
    };
    const pointerToPlan = (event: PointerEvent): PlanPoint | null => {
      if (!setRay(event) || !raycaster.ray.intersectPlane(drawingPlane, hit)) return null;
      return { x: hit.x, y: planYToWorldZ(hit.z) };
    };
    const pointerToCell = (event: PointerEvent) => {
      const plan = pointerToPlan(event);
      return plan ? worldPointToCell(plan.x, planYToWorldZ(plan.y)) : null;
    };
    const pointerToTerrainPlan = (event: PointerEvent): PlanPoint | null => {
      if (settingsRef.current.terrainPaintMode && setRay(event)) {
        const surface = runtime.terrainSurface.raycast(raycaster);
        return surface ? { x: surface.point.x, y: planYToWorldZ(surface.point.z) } : null;
      }
      if (!setRay(event) || !raycaster.ray.intersectPlane(terrainPlane, hit)) return null;
      return { x: hit.x, y: planYToWorldZ(hit.z) };
    };
    const snapTerrainPoint = (point: PlanPoint): PlanPoint => ({ x: Math.round(point.x), y: Math.round(point.y) });
    const snapWallPoint = (point: PlanPoint, start?: PlanPoint, angleSnap = false): PlanPoint => {
      const moduleSize = toolRef.current === "railing" ? BALCONY_RAILING_MODULE_SIZE : CELL_SIZE;
      if (start && angleSnap) {
        const rawLength = Math.hypot(point.x - start.x, point.y - start.y);
        const length = Math.max(moduleSize, Math.round(rawLength / moduleSize) * moduleSize);
        const angleStep = Math.PI / 12;
        const angle = Math.round(Math.atan2(point.y - start.y, point.x - start.x) / angleStep) * angleStep;
        return { x: start.x + Math.cos(angle) * length, y: start.y + Math.sin(angle) * length };
      }
      return {
        x: Math.round(point.x / moduleSize) * moduleSize,
        y: Math.round(point.y / moduleSize) * moduleSize,
      };
    };
    const isRepeatedWallClick = (point: PlanPoint) => {
      const now = performance.now();
      const repeated = Boolean(lastWallClick
        && now - lastWallClick.time <= 450
        && Math.hypot(point.x - lastWallClick.point.x, point.y - lastWallClick.point.y) < 1e-4);
      lastWallClick = { point: { ...point }, time: now };
      return repeated;
    };

    const showHover = (cell: Cell | null) => {
      hoverMesh.visible = cell !== null && drawState === null && wallPathPending === null && arcChordPending === null && arcPending === null && toolRef.current !== "wall" && toolRef.current !== "railing" && toolRef.current !== "select" && toolRef.current !== "opening";
      if (cell) {
        const size = toolRef.current === "stairs" ? stairFootprintSize(stairAssetRef.current) : CELL_SIZE;
        hoverMesh.position.x = cell.x * CELL_SIZE + size / 2;
        hoverMesh.position.z = planYToWorldZ(cell.y * CELL_SIZE + size / 2);
        hoverMesh.scale.set(size - 0.08, 0.035, size - 0.08);
      }
      runtime.render();
    };
    const showTerrainPointHover = (point: PlanPoint | null) => {
      hoverMesh.visible = point !== null && terrainSplinePending === null;
      if (point) {
        hoverMesh.position.set(point.x, 0.08, planYToWorldZ(point.y));
        hoverMesh.scale.set(0.3, 0.04, 0.3);
      }
      runtime.render();
    };
    const showPillarHover = (point: PlanPoint | null) => {
      hoverMesh.visible = point !== null;
      if (point) {
        hoverMesh.position.set(point.x, 0.11, planYToWorldZ(point.y));
        hoverMesh.scale.set(0.22, 0.045, 0.22);
      }
      runtime.render();
    };
    const hideDraft = () => {
      draftMesh.visible = false;
      draftOutline.visible = false;
      circleDraftMesh.visible = false;
      circleDraftOutline.visible = false;
      curveDraftLine.visible = false;
      arcAnchorMesh.visible = false;
      wallFootprintMesh.visible = false;
      wallFootprintOutline.visible = false;
      if (measureRef.current) measureRef.current.hidden = true;
    };
    const showCircleDraft = (draft: DrawState) => {
      const circle = circleFromDraft(draft);
      const centerZ = planYToWorldZ(circle.cy);
      draftMesh.visible = false;
      draftOutline.visible = false;
      circleDraftMesh.position.set(circle.cx, 0.14, centerZ);
      circleDraftMesh.scale.set(circle.radius, circle.radius, 1);
      circleDraftOutline.position.set(circle.cx, 0.145, centerZ);
      circleDraftOutline.scale.set(circle.radius, 1, circle.radius);
      circleDraftMesh.visible = true;
      circleDraftOutline.visible = true;
      if (measureRef.current) {
        measureRef.current.hidden = false;
        measureRef.current.textContent = circle.radius < MIN_CIRCLE_RADIUS
          ? `⌀ ${circle.radius * 2} m · too small`
          : `⌀ ${circle.radius * 2} m`;
      }
      runtime.render();
    };
    const showDraft = (draft: DrawState) => {
      if (draft.operation === "circle") {
        showCircleDraft(draft);
        return;
      }
      const minX = Math.min(draft.start.x, draft.current.x);
      const maxX = Math.max(draft.start.x, draft.current.x);
      const minY = Math.min(draft.start.y, draft.current.y);
      const maxY = Math.max(draft.start.y, draft.current.y);
      const widthCells = maxX - minX + 1;
      const depthCells = maxY - minY + 1;
      const centerX = (minX + maxX + 1) * CELL_SIZE / 2;
      const centerZ = planYToWorldZ((minY + maxY + 1) * CELL_SIZE / 2);
      circleDraftMesh.visible = false;
      circleDraftOutline.visible = false;
      for (const object of [draftMesh, draftOutline]) {
        object.position.set(centerX, 0.14, centerZ);
        object.rotation.y = 0;
        object.scale.set(widthCells * CELL_SIZE - 0.06, 0.045, depthCells * CELL_SIZE - 0.06);
        object.visible = true;
      }
      if (measureRef.current) {
        measureRef.current.hidden = false;
        measureRef.current.textContent = `${widthCells * CELL_SIZE} m × ${depthCells * CELL_SIZE} m`;
      }
      runtime.render();
    };
    const setWallFootprint = (points: PlanPoint[]) => {
      const usable = points.filter((point, index) => index === 0 || Math.hypot(point.x - points[index - 1].x, point.y - points[index - 1].y) > 1e-5);
      if (usable.length < 2) {
        wallFootprintMesh.visible = false;
        wallFootprintOutline.visible = false;
        return;
      }
      const halfWidth = WALL_THICKNESS;
      const left: PlanPoint[] = [];
      const right: PlanPoint[] = [];
      for (let index = 0; index < usable.length; index += 1) {
        const point = usable[index];
        const previous = usable[Math.max(0, index - 1)];
        const next = usable[Math.min(usable.length - 1, index + 1)];
        const previousLength = Math.hypot(point.x - previous.x, point.y - previous.y);
        const nextLength = Math.hypot(next.x - point.x, next.y - point.y);
        const previousNormal = previousLength > 1e-5
          ? { x: -(point.y - previous.y) / previousLength, y: (point.x - previous.x) / previousLength }
          : { x: -(next.y - point.y) / nextLength, y: (next.x - point.x) / nextLength };
        const nextNormal = nextLength > 1e-5
          ? { x: -(next.y - point.y) / nextLength, y: (next.x - point.x) / nextLength }
          : previousNormal;
        let miterX = previousNormal.x + nextNormal.x;
        let miterY = previousNormal.y + nextNormal.y;
        const miterLength = Math.hypot(miterX, miterY);
        if (miterLength < 1e-5) {
          miterX = nextNormal.x;
          miterY = nextNormal.y;
        } else {
          miterX /= miterLength;
          miterY /= miterLength;
        }
        const projection = Math.max(0.34, Math.abs(miterX * nextNormal.x + miterY * nextNormal.y));
        const offset = Math.min(halfWidth * 3, halfWidth / projection);
        left.push({ x: point.x + miterX * offset, y: point.y + miterY * offset });
        right.push({ x: point.x - miterX * offset, y: point.y - miterY * offset });
      }

      const positions: number[] = [];
      for (let index = 0; index < usable.length; index += 1) {
        positions.push(left[index].x, 0.18, planYToWorldZ(left[index].y));
        positions.push(right[index].x, 0.18, planYToWorldZ(right[index].y));
      }
      const indices: number[] = [];
      for (let index = 0; index < usable.length - 1; index += 1) {
        const base = index * 2;
        indices.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
      }
      wallFootprintGeometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
      wallFootprintGeometry.setIndex(indices);
      wallFootprintGeometry.computeBoundingSphere();

      const outline: number[] = [];
      const addEdge = (a: PlanPoint, b: PlanPoint) => outline.push(a.x, 0.19, planYToWorldZ(a.y), b.x, 0.19, planYToWorldZ(b.y));
      for (let index = 0; index < usable.length - 1; index += 1) {
        addEdge(left[index], left[index + 1]);
        addEdge(right[index], right[index + 1]);
      }
      addEdge(left[0], right[0]);
      addEdge(left[left.length - 1], right[right.length - 1]);
      wallFootprintOutlineGeometry.setAttribute("position", new THREE.Float32BufferAttribute(outline, 3));
      wallFootprintOutlineGeometry.computeBoundingSphere();
      wallFootprintMesh.visible = true;
      wallFootprintOutline.visible = true;
    };
    const showWallDraft = (draft: { start: PlanPoint; current: PlanPoint }) => {
      const dx = draft.current.x - draft.start.x;
      const dy = draft.current.y - draft.start.y;
      const length = Math.hypot(dx, dy);
      circleDraftMesh.visible = false;
      circleDraftOutline.visible = false;
      wallFootprintMesh.visible = false;
      wallFootprintOutline.visible = false;
      for (const object of [draftMesh, draftOutline]) {
        object.position.set((draft.start.x + draft.current.x) / 2, 0.14, planYToWorldZ((draft.start.y + draft.current.y) / 2));
        // Plan Y maps to negative world Z. A positive Three.js Y rotation already
        // sends local +X toward negative Z, so using -dy mirrors the draft chord.
        object.rotation.y = Math.atan2(dy, dx);
        object.scale.set(Math.max(0.06, length), 0.045, WALL_THICKNESS * 2);
        object.visible = length > 0;
      }
      if (measureRef.current) {
        measureRef.current.hidden = length === 0;
        const angle = Math.round(Math.atan2(dy, dx) * 180 / Math.PI);
        measureRef.current.textContent = `${length.toFixed(2).replace(/\.00$/, "")} m · ${angle}°`;
      }
      runtime.render();
    };
    const showWallPathDraft = (draft: WallPathPendingState) => {
      const points = [...draft.points, draft.current];
      curveDraftGeometry.setFromPoints(points.map((point) => new THREE.Vector3(point.x, 0.22, planYToWorldZ(point.y))));
      curveDraftLine.visible = true;
      const start = draft.points[draft.points.length - 1];
      const length = Math.hypot(draft.current.x - start.x, draft.current.y - start.y);
      const angle = Math.round(Math.atan2(draft.current.y - start.y, draft.current.x - start.x) * 180 / Math.PI);
      setWallFootprint(points);
      draftMesh.visible = false;
      draftOutline.visible = false;
      circleDraftMesh.visible = false;
      circleDraftOutline.visible = false;
      if (measureRef.current) {
        measureRef.current.hidden = length === 0;
        measureRef.current.textContent = `${length.toFixed(2).replace(/\.00$/, "")} m · ${angle}° · click next point`;
      }
      runtime.render();
    };
    const sampledTerrainSpline = (points: PlanPoint[]): THREE.Vector3[] => {
      if (points.length < 3) return points.map((point) => new THREE.Vector3(point.x, 0.18, planYToWorldZ(point.y)));
      return sampleClosedTerrainSpline(points).map((point) => new THREE.Vector3(point.x, 0.18, planYToWorldZ(point.y)));
    };
    const showTerrainSplineDraft = (draft: TerrainSplinePendingState) => {
      const last = draft.points[draft.points.length - 1];
      const previewPoints = last.x === draft.current.x && last.y === draft.current.y ? draft.points : [...draft.points, draft.current];
      const sampled = sampledTerrainSpline(previewPoints);
      curveDraftGeometry.setFromPoints(sampled.length >= 3 ? [...sampled, sampled[0]] : sampled);
      curveDraftLine.visible = true;
      hoverMesh.visible = false;
      if (measureRef.current) {
        measureRef.current.hidden = false;
        measureRef.current.textContent = previewPoints.length < 3
          ? `${previewPoints.length} control point${previewPoints.length === 1 ? "" : "s"} · add at least 3`
          : `${previewPoints.length} control points · double-click to close`;
      }
      runtime.render();
    };
    const showArcDraft = (draft: ArcPendingState) => {
      const arc = circularArcThroughPoints(draft.start, draft.arcPoint, draft.end);
      const points = arc?.points ?? [draft.start, draft.end];
      curveDraftGeometry.setFromPoints(points.map((point) => new THREE.Vector3(point.x, 0.22, planYToWorldZ(point.y))));
      curveDraftLine.visible = true;
      setWallFootprint(points);
      draftMesh.visible = false;
      draftOutline.visible = false;
      circleDraftMesh.visible = false;
      circleDraftOutline.visible = false;
      if (measureRef.current) {
        measureRef.current.hidden = false;
        measureRef.current.textContent = arc
          ? `Radius ${arc.radius.toFixed(2)} m · arc ${arc.length.toFixed(2)} m · double-click to confirm`
          : "Move off the centre line to create an arc";
      }
      runtime.render();
    };
    const setInteractionColor = (operation: "draw" | "erase" | "select") => {
      const fill = operation === "draw" ? 0xcf5c3d : operation === "erase" ? 0xa2382c : 0x48a9c5;
      const outline = operation === "draw" ? 0xf0a386 : operation === "erase" ? 0xff8b7d : 0x9be4f4;
      hoverMaterial.color.setHex(fill);
      draftMaterial.color.setHex(fill);
      outlineMaterial.color.setHex(outline);
    };
    const cancelDrawing = () => {
      if (drawState && renderer.domElement.hasPointerCapture(drawState.pointerId)) renderer.domElement.releasePointerCapture(drawState.pointerId);
      drawState = null;
      terrainSplinePending = null;
      wallPathPending = null;
      arcChordPending = null;
      arcPending = null;
      lastWallClick = null;
      controls.enabled = true;
      hideDraft();
      runtime.render();
    };
    const finishTerrainSpline = () => {
      if (!terrainSplinePending) return;
      const controlsPoints = terrainSplinePending.points;
      terrainSplinePending = null;
      controls.enabled = true;
      hideDraft();
      if (controlsPoints.length < 3) {
        onNoticeRef.current("A closed terrain spline needs at least 3 control points.");
        return;
      }
      const mode = terrainModeRef.current;
      const step = settingsRef.current.terrainBrushStep ?? 0.5;
      onCommitRef.current({
        type: "add-terrain-region",
        region: {
          id: `terrain-region-${Date.now()}`,
          controlPoints: controlsPoints,
          mode,
          height: mode === "flatten" ? 0 : mode === "lower" ? -step : step,
          edgeProfile: settingsRef.current.terrainEdgeProfile ?? "smooth",
          slopeWidth: settingsRef.current.terrainSlopeWidth ?? 2,
        },
      });
    };
    const cancelTerrainEdit = () => {
      if (terrainControlDrag) {
        onTerrainRegionEditRef.current(terrainControlDrag.regionId, { controlPoints: terrainControlDrag.originalPoints });
        if (renderer.domElement.hasPointerCapture(terrainControlDrag.pointerId)) renderer.domElement.releasePointerCapture(terrainControlDrag.pointerId);
        terrainControlDrag = null;
      }
      if (terrainAdjustDrag) {
        onTerrainRegionEditRef.current(terrainAdjustDrag.regionId, {
          height: terrainAdjustDrag.originalHeight,
          slopeWidth: terrainAdjustDrag.originalSlopeWidth,
          edgeProfile: terrainAdjustDrag.originalEdgeProfile,
        });
        if (renderer.domElement.hasPointerCapture(terrainAdjustDrag.pointerId)) renderer.domElement.releasePointerCapture(terrainAdjustDrag.pointerId);
        terrainAdjustDrag = null;
      }
      controls.enabled = true;
      if (measureRef.current) measureRef.current.hidden = true;
      runtime.render();
    };
    const finishWallPath = () => {
      if (!wallPathPending) return;
      const points = wallPathPending.points;
      wallPathPending = null;
      lastWallClick = null;
      controls.enabled = true;
      hideDraft();
      if (points.length >= 2) onCommitRef.current({ type: toolRef.current === "railing" ? "railing-path" : "wall-path", points });
      runtime.render();
    };
    const finishCornerDrag = (cancel: boolean) => {
      if (!cornerDrag) return;
      if (cancel) {
        if (cornerDrag.original) onCornerEditRef.current(cornerDrag.handle.roomId, cornerDrag.original);
        else onCornerRemoveRef.current(cornerDrag.handle.roomId, cornerDrag.handle.vertexX, cornerDrag.handle.vertexY);
      }
      if (renderer.domElement.hasPointerCapture(cornerDrag.pointerId)) renderer.domElement.releasePointerCapture(cornerDrag.pointerId);
      cornerDrag = null;
      controls.enabled = true;
      runtime.render();
    };
    const finishRadiusDrag = (cancel: boolean) => {
      if (!radiusDrag) return;
      if (cancel && radiusDrag.current !== radiusDrag.original) {
        onCircleResizeRef.current(radiusDrag.handle.roomId, radiusDrag.handle.circleIndex, radiusDrag.original);
      }
      if (renderer.domElement.hasPointerCapture(radiusDrag.pointerId)) renderer.domElement.releasePointerCapture(radiusDrag.pointerId);
      radiusDrag = null;
      controls.enabled = true;
      if (measureRef.current) measureRef.current.hidden = true;
      runtime.render();
    };
    const finishRoomMove = (cancel: boolean) => {
      if (!roomMoveDrag) return;
      const drag = roomMoveDrag;
      if (!cancel && (drag.dxCells !== 0 || drag.dyCells !== 0)) {
        onRoomMoveRef.current(drag.roomId, drag.dxCells, drag.dyCells);
      }
      if (renderer.domElement.hasPointerCapture(drag.pointerId)) renderer.domElement.releasePointerCapture(drag.pointerId);
      roomMoveDrag = null;
      controls.enabled = true;
      if (measureRef.current) measureRef.current.hidden = true;
      runtime.render();
    };
    const finishWallResize = (cancel: boolean) => {
      if (!wallResizeDrag) return;
      const drag = wallResizeDrag;
      if (!cancel && drag.steps !== 0) {
        const reference = drag.handles[0];
        onWallResizeRef.current(drag.handles.map((handle) => ({
          handle,
          // The two sides of a shared wall face in opposite directions. A positive
          // movement expands one room and contracts the neighbour, moving one wall.
          steps: Math.round(drag.steps * (handle.outwardX * reference.outwardX + handle.outwardY * reference.outwardY)),
        }))); 
      }
      if (renderer.domElement.hasPointerCapture(drag.pointerId)) renderer.domElement.releasePointerCapture(drag.pointerId);
      wallResizeDrag = null;
      controls.enabled = true;
      if (measureRef.current) measureRef.current.hidden = true;
      runtime.render();
    };
    const roomAtPoint = (point: PlanPoint) => {
      const candidates = (eraseScopeRef.current === "floor" ? layoutRef.current.floorHitAreas : displayLayoutRef.current.roomHitAreas).filter(
        (groundShape) => pointInPolygon(point, groundShape.outer) && !groundShape.holes.some((hole) => pointInPolygon(point, hole)),
      ).sort((a, b) => (b.elevation ?? 0) - (a.elevation ?? 0));
      // In an overlap, keep the currently selected logical room under the pointer. Clicking
      // an exposed part of another member still selects it normally.
      const selected = candidates.find((groundShape) => groundShape.roomId === selectedRoomRef.current);
      return selected?.roomId ?? candidates[0]?.roomId ?? null;
    };
    const renderedRoomAtPointer = (event: PointerEvent): string | null => {
      if (!setRay(event)) return null;
      for (const hit of raycaster.intersectObjects(runtime.generated.children, true)) {
        let object: THREE.Object3D | null = hit.object;
        while (object && object !== runtime.generated) {
          if (typeof object.userData.roomId === "string"
            && displayLayoutRef.current.roomHitAreas.some((area) => area.roomId === object!.userData.roomId)) return object.userData.roomId;
          object = object.parent;
        }
      }
      return null;
    };
    let connectionDrag: { pointerId:number; fromId?:string; connectionId?:string; elevation:number; targetId?:string; point?:PlanPoint } | null = null;
    let pathDraft:{opening:WallOpening;points:PathPoint[];current?:PathPoint;dragging?:number}|null=null;
    let pathEdit:{pointerId:number;connection:RoomConnection;index:number;vertical:boolean;startY:number;original:PathPoint[];points:PathPoint[]}|null=null;
    const connectionPreview = new THREE.Group();
    scene.add(connectionPreview);
    const connectionPreviewMaterial = new THREE.MeshBasicMaterial({ color:0x55e6e0, transparent:true, opacity:0.55, depthWrite:false });
    const anchorMesh=new THREE.Mesh(runtime.cube,runtime.materials.terrainControl);
    anchorMesh.scale.set(0.5,0.5,0.5);anchorMesh.renderOrder=1001;anchorMesh.visible=false;scene.add(anchorMesh);
    const wallAnchor=(event:PointerEvent):{opening:WallOpening;point:PathPoint}|null=>{
      if(!setRay(event)) return null;
      const hit=raycaster.intersectObjects(runtime.generated.children,true)[0];
      if(!hit) return null;
      const p={x:hit.point.x,y:-hit.point.z};
      const walls=displayLayoutRef.current.walls.filter(w=>w.roomId&&!w.manualWallId&&w.length>=1.99);
      const wall=walls.map(w=>({w,p:{x:w.x+Math.cos(w.rotation)*w.length/2,y:w.y+Math.sin(w.rotation)*w.length/2}})).filter(v=>Math.hypot(v.p.x-p.x,v.p.y-p.y)<1.3&&Math.abs(hit.point.y-(v.w.elevation??0))<2.8).sort((a,b)=>Math.hypot(a.p.x-p.x,a.p.y-p.y)-Math.hypot(b.p.x-p.x,b.p.y-p.y))[0];
      if(!wall) return null;
      const room=roomsRef.current.find(r=>r.id===wall.w.roomId)!;
      const existing=room.openings.find(o=>!o.suppressed&&o.asset.startsWith("DR")&&Math.hypot(o.cx-wall.p.x,o.cy-wall.p.y)<0.1);
      const opening:WallOpening=existing?{...existing,automatic:false}:{id:`path-door-${room.id}-${wall.p.x}-${wall.p.y}`,roomId:room.id,cx:wall.p.x,cy:wall.p.y,rotation:wall.w.rotation,asset:"DR_2.5x1.5_1"};
      return {opening,point:{x:opening.cx,y:opening.cy,elevation:(room.elevationSteps??0)*0.25}};
    };
    const mousePathPoint=(event:PointerEvent,height:number):PathPoint|null=>{
      if(!setRay(event))return null;
      const p=raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0,1,0),-height),new THREE.Vector3());
      return p?{x:Math.round(p.x),y:Math.round(-p.z),elevation:height}:null;
    };
    const clearConnectionPreview = () => { connectionPreview.clear(); runtime.render(); };
    const cancelConnection = () => {
      const pointerId=pathEdit?.pointerId??pathDraft?.dragging;
      if(pointerId!==undefined&&renderer.domElement.hasPointerCapture(pointerId))renderer.domElement.releasePointerCapture(pointerId);
      pathDraft=null;pathEdit=null;anchorMesh.visible=false;
      if (connectionDrag && renderer.domElement.hasPointerCapture(connectionDrag.pointerId)) renderer.domElement.releasePointerCapture(connectionDrag.pointerId);
      connectionDrag = null; controls.enabled = true; clearConnectionPreview();
      if (measureRef.current) measureRef.current.hidden = true;
    };
    const connectionAtPointer = (event:PointerEvent) => {
      if (!setRay(event)) return null;
      const bounds=renderer.domElement.getBoundingClientRect();
      let nearest:THREE.Object3D|null=null, distance=16;
      for(const child of runtime.generated.children) {
        if(!child.userData.connectionHandle || !child.visible) continue;
        const projected=child.getWorldPosition(new THREE.Vector3()).project(camera);
        if(projected.z < -1 || projected.z > 1) continue;
        const d=Math.hypot(bounds.left+(projected.x+1)*bounds.width/2-event.clientX,bounds.top+(1-projected.y)*bounds.height/2-event.clientY);
        if(d<distance) {nearest=child;distance=d;}
      }
      if(nearest) return {id:nearest.userData.connectionHandle as string,handle:true,elevation:nearest.position.y,index:nearest.userData.pathIndex as number|undefined,vertical:Boolean(nearest.userData.pathVertical),segment:undefined as number|undefined};
      for (const hit of raycaster.intersectObjects(runtime.generated.children,true)) {
        let object:THREE.Object3D|null = hit.object;
        while(object && object!==runtime.generated) {
          if (object.userData.roomConnectionId) return { id:object.userData.roomConnectionId as string, handle:Boolean(object.userData.connectionHandle), elevation:hit.point.y,index:object.userData.pathIndex as number|undefined,vertical:Boolean(object.userData.pathVertical),segment:object.userData.pathSegment as number|undefined };
          object=object.parent;
        }
      }
      return null;
    };
    const previewConnection = (geometry: ReturnType<typeof buildConnectionGeometry>) => {
      clearConnectionPreview();
      if (!geometry) return;
      for (const tile of geometry.floorTiles) {
        const mesh = new THREE.Mesh(runtime.cube,connectionPreviewMaterial);
        mesh.position.set(tile.point.x,tile.elevation+0.03,planYToWorldZ(tile.point.y)); mesh.scale.set(tile.length??2,0.1,2);mesh.rotation.y=tile.rotation??0; connectionPreview.add(mesh);
      }
      for (const flight of geometry.stairFlights) {
        const template = runtime.assets.connectionStair;
        const pivot = new THREE.Group();
        const mesh = template ? template.clone(true) : new THREE.Mesh(runtime.cube,connectionPreviewMaterial);
        mesh.traverse(o=>{ if(o instanceof THREE.Mesh) o.material=connectionPreviewMaterial; });
        pivot.add(mesh); pivot.position.set(flight.point.x,flight.elevation,planYToWorldZ(flight.point.y)); pivot.rotation.y=flight.rotation; connectionPreview.add(pivot);
      }
      runtime.render();
    };
    const showPath=(points:PathPoint[],broken:number[]=[])=>{
      const geometry=pathwayGeometry(points,broken);
      connectionPreviewMaterial.color.setHex(geometry.invalidSegments.length?0xff4433:0x55e6e0);
      previewConnection(geometry);
      for(const i of geometry.invalidSegments) {
        const a=points[i],b=points[i+1],mesh=new THREE.Mesh(runtime.cube,connectionPreviewMaterial);
        mesh.position.set((a.x+b.x)/2,(a.elevation+b.elevation)/2,-(a.y+b.y)/2);
        mesh.scale.set(Math.hypot(b.x-a.x,b.y-a.y),0.12,0.2);mesh.rotation.y=Math.atan2(b.y-a.y,b.x-a.x);connectionPreview.add(mesh);
      }
      runtime.render();return geometry.invalidSegments.length===0;
    };
    const finishPath=(target?:ReturnType<typeof wallAnchor>)=>{
      if(!pathDraft)return;
      const points=[...pathDraft.points];
      if(target) points.push(target.point);
      if(points.length<2||!showPath(points)) {onNoticeRef.current("Path needs at least two points and enough space for stairs and landings.");return;}
      const connection:RoomConnection={id:`path-${Date.now()}`,fromRoomId:pathDraft.opening.roomId,fromOpeningId:pathDraft.opening.id,toRoomId:target?.opening.roomId??"",toOpeningId:target?.opening.id??"",pathPoints:points,pathOrigin:points[0],brokenSegments:[]};
      const openings=[pathDraft.opening,...(target?[target.opening]:[])];cancelConnection();onCommitRef.current({type:"save-pathway",connection,openings});
    };
    const wallAtPoint = (point: PlanPoint): WallEraseTarget | null => {
      let best: { wall: WallSegment; distance: number } | null = null;
      for (const wall of [...layoutRef.current.walls, ...layoutRef.current.balconyRailings]) {
        const endX = wall.x + Math.cos(wall.rotation) * wall.length;
        const endY = wall.y + Math.sin(wall.rotation) * wall.length;
        const vx = endX - wall.x;
        const vy = endY - wall.y;
        const lengthSquared = vx * vx + vy * vy;
        const ratio = lengthSquared ? Math.max(0, Math.min(1, ((point.x - wall.x) * vx + (point.y - wall.y) * vy) / lengthSquared)) : 0;
        const distance = Math.hypot(point.x - (wall.x + vx * ratio), point.y - (wall.y + vy * ratio));
        if (distance <= 0.7 && (!best || distance < best.distance)) best = { wall, distance };
      }
      if (!best) return null;
      const { wall } = best;
      return {
        cx: wall.x + Math.cos(wall.rotation) * wall.length / 2,
        cy: wall.y + Math.sin(wall.rotation) * wall.length / 2,
        axis: Math.abs(Math.cos(wall.rotation)) >= Math.abs(Math.sin(wall.rotation)) ? "horizontal" : "vertical",
        manualWallId: wall.manualWallId,
        manualWallModuleIndex: wall.manualWallModuleIndex,
        roomWall: !wall.manualWallId,
        roomId: wall.roomId,
        elevation: wall.elevation ?? 0,
      };
    };
    const renderedWallAtPointer = (event: PointerEvent): WallEraseTarget | null => {
      if (!setRay(event)) return null;
      for (const hit of raycaster.intersectObjects(runtime.generated.children, true)) {
        let object: THREE.Object3D | null = hit.object;
        while (object && object !== runtime.generated) {
          const target = object.userData.wallEraseTarget as WallEraseTarget | undefined;
          const elevation = target?.elevation ?? 0;
          if (target && elevation >= runtime.gridElevation - 1e-5 && elevation < runtime.gridElevation + 2.5 - 1e-5) return target;
          object = object.parent;
        }
      }
      return null;
    };
    const renderedFloorAtPointer = (event: PointerEvent): string | null => {
      if (!setRay(event)) return null;
      for (const hit of raycaster.intersectObjects(runtime.generated.children, true)) {
        let object: THREE.Object3D | null = hit.object;
        while (object && object !== runtime.generated) {
          if (typeof object.userData.floorId === "string"
            && layoutRef.current.floorHitAreas.some((area) => area.floorId === object!.userData.floorId)) return object.userData.floorId;
          object = object.parent;
        }
      }
      return null;
    };
    const renderedPillarAtPointer = (event: PointerEvent): string | null => {
      if (!setRay(event)) return null;
      for (const hit of raycaster.intersectObjects(runtime.generated.children, true)) {
        let object: THREE.Object3D | null = hit.object;
        while (object && object !== runtime.generated) {
          if (typeof object.userData.pillarPlacementId === "string") return object.userData.pillarPlacementId;
          object = object.parent;
        }
      }
      return null;
    };
    const renderedStairAtPointer = (event: PointerEvent): string | null => {
      if (!setRay(event)) return null;
      for (const hit of raycaster.intersectObjects(runtime.generated.children, true)) {
        let object: THREE.Object3D | null = hit.object;
        while (object && object !== runtime.generated) {
          if (typeof object.userData.stairPlacementId === "string") return object.userData.stairPlacementId;
          object = object.parent;
        }
      }
      return null;
    };
    const terrainGuideAtPointer = (event: PointerEvent): { regionId: string; controlIndex?: number; sampleIndex?: number; point?: PlanPoint } | null => {
      if (!setRay(event)) return null;
      // Screen-space picking keeps points easy to grab at every zoom level.
      const bounds = renderer.domElement.getBoundingClientRect();
      let nearest: THREE.Object3D | null = null;
      let distance = 14;
      for (const child of runtime.terrainGuides.children) {
        if (!child.userData.terrainControl) continue;
        const projected = child.getWorldPosition(new THREE.Vector3()).project(camera);
        if (projected.z < -1 || projected.z > 1) continue;
        const d = Math.hypot(bounds.left + (projected.x + 1) * bounds.width / 2 - event.clientX, bounds.top + (1 - projected.y) * bounds.height / 2 - event.clientY);
        if (d < distance) { distance = d; nearest = child; }
      }
      if (nearest) return nearest.userData.terrainControl;
      const intersections = raycaster.intersectObjects(runtime.terrainGuides.children, false);
      const controlHit = intersections.find((intersection) => intersection.object.userData.terrainControl);
      if (controlHit) return controlHit.object.userData.terrainControl as { regionId: string; controlIndex: number };
      const lineHit = intersections.find((intersection) => typeof intersection.object.userData.terrainRegionId === "string");
      return lineHit ? { regionId: lineHit.object.userData.terrainRegionId as string, sampleIndex: lineHit.index ?? 0, point: { x: lineHit.point.x, y: -lineHit.point.z } } : null;
    };
    const highlightTerrainRegion = (regionId: string | null, controlIndex?: number) => {
      for (const child of runtime.terrainGuides.children) {
        const identity = child.userData.terrainControl;
        if (!identity) continue;
        const active = identity.regionId === regionId && identity.controlIndex === controlIndex;
        child.scale.set(active ? 0.55 : 0.34, 0.12, active ? 0.55 : 0.34);
        ((child as THREE.Mesh).material as THREE.MeshBasicMaterial).color.setHex(active ? 0x65ffff : 0xffc247);
      }
      renderer.domElement.style.cursor = controlIndex !== undefined ? "move" : regionId ? "grab" : "crosshair";
      runtime.render();
      const line = regionId
        ? runtime.terrainGuides.children.find((child) => child instanceof THREE.Line && child.userData.terrainRegionId === regionId) as THREE.Line | undefined
        : undefined;
      if (hoveredTerrainLine === line) return;
      if (hoveredTerrainLine) {
        (hoveredTerrainLine.material as THREE.LineBasicMaterial).color.setHex(0xff7a32);
        (hoveredTerrainLine.material as THREE.LineBasicMaterial).opacity = 1;
      }
      hoveredTerrainLine = line ?? null;
      if (hoveredTerrainLine) {
        (hoveredTerrainLine.material as THREE.LineBasicMaterial).color.setHex(0xffd36a);
        (hoveredTerrainLine.material as THREE.LineBasicMaterial).opacity = 1;
      }
      renderer.domElement.style.cursor = controlIndex !== undefined ? "move" : hoveredTerrainLine ? "grab" : toolRef.current === "terrain" ? "crosshair" : "";
      runtime.render();
    };

    const handlePointerDown = (event: PointerEvent) => {
      setTerrainMenu(null);
      setObjectMenu(null);
      setPathMenu(null);
      if (toolRef.current === "connect") {
        const hit = connectionAtPointer(event);
        if(event.button===2 && pathDraft){cancelConnection();event.preventDefault();event.stopImmediatePropagation();return;}
        if (event.button===2 && hit) {
          const bounds=renderer.domElement.getBoundingClientRect();
          const connection=roomConnectionsRef.current.find(c=>c.id===hit.id);
          if(connection?.pathPoints) {
            const points=resolvePathPoints(connection,roomsRef.current);
            setPathMenu({connection:{...connection,pathPoints:points,pathOrigin:points[0]},index:hit.index,segment:hit.segment,x:Math.max(0,Math.min(bounds.width-180,event.clientX-bounds.left)),y:Math.max(0,Math.min(bounds.height-130,event.clientY-bounds.top))});
            event.preventDefault();event.stopImmediatePropagation();return;
          }
          setObjectMenu({id:hit.id,type:"remove-connection",x:Math.max(0,Math.min(bounds.width-110,event.clientX-bounds.left)),y:Math.max(0,Math.min(bounds.height-44,event.clientY-bounds.top))});
          event.preventDefault(); event.stopImmediatePropagation(); return;
        }
        if (event.button===0) {
          const anchor=wallAnchor(event);
          if(pathDraft) {
            if(anchor && anchor.opening.id!==pathDraft.opening.id) finishPath(anchor);
            else {const point=mousePathPoint(event,pathDraft.points[pathDraft.points.length-1].elevation);if(point&&Math.hypot(point.x-pathDraft.points.at(-1)!.x,point.y-pathDraft.points.at(-1)!.y)>0.1)pathDraft.points.push(point);}
            event.preventDefault();event.stopImmediatePropagation();return;
          }
          if(hit?.index!==undefined) {
            const connection=roomConnectionsRef.current.find(c=>c.id===hit.id)!;const points=resolvePathPoints(connection,roomsRef.current);
            if(hit.index===0 || (hit.index===points.length-1&&connection.toRoomId)) {onNoticeRef.current("This endpoint follows its doorway. Edit an interior point instead.");return;}
            pathEdit={pointerId:event.pointerId,connection,index:hit.index,vertical:hit.vertical,startY:event.clientY,original:points,points:points.map(p=>({...p}))};controls.enabled=false;renderer.domElement.setPointerCapture(event.pointerId);event.preventDefault();event.stopImmediatePropagation();return;
          }
          if (hit?.handle) connectionDrag={pointerId:event.pointerId,connectionId:hit.id,elevation:hit.elevation-0.3};
          else if(anchor) {pathDraft={opening:anchor.opening,points:[anchor.point],dragging:event.pointerId};controls.enabled=false;renderer.domElement.setPointerCapture(event.pointerId);event.preventDefault();event.stopImmediatePropagation();return;}
          if(connectionDrag) { controls.enabled=false; renderer.domElement.setPointerCapture(event.pointerId); event.preventDefault(); event.stopImmediatePropagation(); }
          return;
        }
      }
      if (event.button === 2 && toolRef.current === "terrain" && !settingsRef.current.terrainPaintMode && !terrainSplinePending && !terrainControlDrag && !terrainAdjustDrag) {
        const guide = terrainGuideAtPointer(event);
        const region = guide && terrainRegionsRef.current.find((candidate) => candidate.id === guide.regionId);
        if (guide && region) {
          event.preventDefault(); event.stopImmediatePropagation();
          if (guide.controlIndex !== undefined) {
            if (region.controlPoints.length <= 3) onNoticeRef.current("A closed spline needs at least 3 points.");
            else onCommitRef.current({ type: "replace-terrain-region", region: { ...region, controlPoints: region.controlPoints.filter((_, index) => index !== guide.controlIndex) } });
          } else {
            const bounds = renderer.domElement.getBoundingClientRect();
            setTerrainMenu({ id: region.id, x: Math.max(0, Math.min(bounds.width - 160, event.clientX - bounds.left)), y: Math.max(0, Math.min(bounds.height - 44, event.clientY - bounds.top)) });
          }
          return;
        }
      }
      if (event.button === 0 && toolRef.current === "terrain" && settingsRef.current.terrainPaintMode) {
        const point = pointerToTerrainPlan(event);
        if (!point) return;
        paintStroke = { pointerId: event.pointerId, region: { id: `paint-${Date.now()}`, controlPoints: [point], texture: settingsRef.current.terrainPaintTexture ?? "grass", mode: "raise", height: 0, edgeProfile: "smooth", slopeWidth: 1, brush: { radius: (settingsRef.current.terrainPaintSize ?? 4) / 2, intensity: settingsRef.current.terrainPaintIntensity ?? 0.5, falloff: settingsRef.current.terrainPaintFalloff ?? 0.75 } } };
        controls.enabled = false;
        renderer.domElement.setPointerCapture(event.pointerId);
        event.preventDefault(); event.stopPropagation();
        return;
      }
      if (event.button === 2) {
        const stairId = renderedStairAtPointer(event);
        if (stairId) {
          const bounds = renderer.domElement.getBoundingClientRect();
          setObjectMenu({ type: "remove-stair", id: stairId, x: Math.max(0, Math.min(bounds.width - 110, event.clientX - bounds.left)), y: Math.max(0, Math.min(bounds.height - 44, event.clientY - bounds.top)) });
          event.preventDefault();
          event.stopImmediatePropagation();
          return;
        }
        const pillarId = renderedPillarAtPointer(event);
        if (pillarId) {
          const bounds = renderer.domElement.getBoundingClientRect();
          setObjectMenu({ type: "remove-pillar", id: pillarId, x: Math.max(0, Math.min(bounds.width - 110, event.clientX - bounds.left)), y: Math.max(0, Math.min(bounds.height - 44, event.clientY - bounds.top)) });
          event.preventDefault();
          event.stopImmediatePropagation();
          return;
        }
      }
      if (event.button === 2 && toolRef.current === "wall" && (wallPathPending || arcChordPending || arcPending)) {
        cancelDrawing();
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (event.button === 2 && terrainSplinePending) {
        cancelDrawing();
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (event.button === 2 && (terrainControlDrag || terrainAdjustDrag)) {
        cancelTerrainEdit();
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (event.button === 2 && (cornerDrag || radiusDrag || roomMoveDrag || wallResizeDrag)) {
        finishCornerDrag(true);
        finishRadiusDrag(true);
        finishRoomMove(true);
        finishWallResize(true);
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (event.button !== 0) return;
      if (toolRef.current === "terrain") {
        const guide = terrainGuideAtPointer(event);
        const region = guide ? terrainRegionsRef.current.find((candidate) => candidate.id === guide.regionId) : null;
        if (guide && region) {
          highlightTerrainRegion(region.id, guide.controlIndex);
          controls.enabled = false;
          renderer.domElement.setPointerCapture(event.pointerId);
          if (guide.controlIndex !== undefined) {
            terrainControlDrag = {
              pointerId: event.pointerId,
              regionId: region.id,
              controlIndex: guide.controlIndex,
              originalPoints: region.controlPoints.map((point) => ({ ...point })),
            };
          } else if (!region.texture) {
            terrainAdjustDrag = {
              pointerId: event.pointerId,
              regionId: region.id,
              startClientX: event.clientX,
              startClientY: event.clientY,
              originalHeight: region.height,
              originalSlopeWidth: region.slopeWidth,
              originalEdgeProfile: region.edgeProfile,
            };
            if (measureRef.current) {
              measureRef.current.hidden = false;
              measureRef.current.textContent = "Drag ↑↓ for height · drag ←→ for smooth slope / sheer cliff";
            }
          }
          hoverMesh.visible = false;
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        const point = pointerToTerrainPlan(event);
        if (!point) return;
        const snapped = snapTerrainPoint(point);
        if (!terrainSplinePending) {
          terrainSplinePending = { points: [snapped], current: snapped };
          controls.enabled = false;
        } else {
          const last = terrainSplinePending.points[terrainSplinePending.points.length - 1];
          if (last.x !== snapped.x || last.y !== snapped.y) terrainSplinePending.points.push(snapped);
          terrainSplinePending.current = snapped;
        }
        showTerrainSplineDraft(terrainSplinePending);
        event.preventDefault();
        return;
      }
      if (toolRef.current === "erase" && eraseScopeRef.current === "wall") {
        const renderedWall = renderedWallAtPointer(event);
        const point = pointerToPlan(event);
        const target = renderedWall ?? (point ? wallAtPoint(point) : null);
        const cell = pointerToCell(event);
        if (!cell) return;
        setInteractionColor("erase");
        drawState = { pointerId: event.pointerId, start: cell, current: cell, operation: "erase-wall-area", wallTarget: target ?? undefined };
        hoverMesh.visible = false;
        renderer.domElement.setPointerCapture(event.pointerId);
        showDraft(drawState);
        event.preventDefault();
        return;
      }
      if (toolRef.current === "wall" || toolRef.current === "railing") {
        const point = pointerToPlan(event);
        if (!point) return;
        if (toolRef.current === "wall" && wallDrawModeRef.current === "arc" && arcPending) {
          const arcPoint = snapWallPoint(point);
          const confirm = isRepeatedWallClick(arcPoint);
          arcPending.arcPoint = arcPoint;
          const arc = circularArcThroughPoints(arcPending.start, arcPoint, arcPending.end);
          if (!arc) {
            onNoticeRef.current("Place the third point away from the straight centre line.");
            event.preventDefault();
            return;
          }
          showArcDraft(arcPending);
          if (confirm) {
            onCommitRef.current({ type: "wall", kind: "curve", start: arcPending.start, end: arcPending.end, arcPoint });
            arcPending = null;
            lastWallClick = null;
            controls.enabled = true;
            hideDraft();
          }
          event.preventDefault();
          return;
        }
        if (toolRef.current === "wall" && wallDrawModeRef.current === "arc") {
          const snapped = snapWallPoint(point);
          isRepeatedWallClick(snapped);
          if (!arcChordPending) {
            const anchoredStart = { ...snapped };
            arcChordPending = { start: anchoredStart, current: anchoredStart };
            controls.enabled = false;
            arcAnchorMesh.position.set(anchoredStart.x, 0.25, planYToWorldZ(anchoredStart.y));
            arcAnchorMesh.visible = true;
            showWallDraft({ start: snapped, current: snapped });
          } else if (arcChordPending.start.x !== snapped.x || arcChordPending.start.y !== snapped.y) {
            const start = { ...arcChordPending.start };
            arcChordPending = null;
            arcPending = {
              start,
              end: { ...snapped },
              arcPoint: { x: (start.x + snapped.x) / 2, y: (start.y + snapped.y) / 2 },
            };
            showArcDraft(arcPending);
          }
          event.preventDefault();
          return;
        }
        const last = wallPathPending?.points.at(-1);
        const snapped = snapWallPoint(point, last, event.shiftKey);
        const confirm = isRepeatedWallClick(snapped);
        if (!wallPathPending) {
          wallPathPending = { points: [snapped], current: snapped };
          controls.enabled = false;
        } else if (last && (last.x !== snapped.x || last.y !== snapped.y)) {
          wallPathPending.points.push(snapped);
          wallPathPending.current = snapped;
        }
        if (confirm && wallPathPending.points.length >= 2) {
          finishWallPath();
          event.preventDefault();
          return;
        }
        hoverMesh.visible = false;
        if (wallPathPending) showWallPathDraft(wallPathPending);
        event.preventDefault();
        return;
      }
      if (toolRef.current === "opening") {
        const point = pointerToPlan(event);
        if (!point) return;
        let best: { wall: WallSegment; distance: number } | null = null;
        for (const wall of layoutRef.current.walls) {
          if (Math.abs(wall.length - CELL_SIZE) > 1e-3) continue;
          const cx = wall.x + Math.cos(wall.rotation) * wall.length / 2;
          const cy = wall.y + Math.sin(wall.rotation) * wall.length / 2;
          const distance = Math.hypot(point.x - cx, point.y - cy);
          if (distance <= 1.05 && (!best || distance < best.distance)) best = { wall, distance };
        }
        if (!best) onNoticeRef.current("Click the centre of a straight 2 m room wall or standalone wall module.");
        else {
          const target = openingTargetForWall(best.wall);
          if (target) onPlaceOpeningRef.current(target, openingAssetRef.current);
        }
        event.preventDefault();
        return;
      }
      if (toolRef.current === "stairs") {
        const stairId = renderedStairAtPointer(event);
        if (stairId) {
          onCommitRef.current({ type: "rotate-stair", id: stairId });
          event.preventDefault();
          return;
        }
        const cell = pointerToCell(event);
        if (!cell) return;
        onCommitRef.current({ type: "place-stair", cell, asset: stairAssetRef.current });
        event.preventDefault();
        return;
      }
      if (toolRef.current === "pillar") {
        const point = pointerToPlan(event);
        if (!point) return;
        onCommitRef.current({ type: "place-pillar", point: snapPillarPoint(point) });
        event.preventDefault();
        return;
      }
      if (toolRef.current === "select") {
        if (!setRay(event)) return;
        const handleHit = raycaster.intersectObjects(handles.children, false)[0];
        const handle = handleHit?.object.userData.cornerHandle as CornerHandle | undefined;
        if (handle) {
          const identity = { roomId: handle.roomId, vertexX: handle.vertexX, vertexY: handle.vertexY };
          onSelectRoomRef.current(handle.roomId);
          onActiveCornerRef.current(identity);
          cornerDrag = { pointerId: event.pointerId, handle, original: handle.edit ?? null, current: handle.edit ?? null };
          controls.enabled = false;
          renderer.domElement.setPointerCapture(event.pointerId);
          event.preventDefault();
          return;
        }
        const radius = handleHit?.object.userData.radiusHandle as RadiusHandle | undefined;
        if (radius) {
          onSelectRoomRef.current(radius.roomId);
          onActiveCornerRef.current(null);
          radiusDrag = { pointerId: event.pointerId, handle: radius, original: radius.radius, current: radius.radius };
          controls.enabled = false;
          renderer.domElement.setPointerCapture(event.pointerId);
          event.preventDefault();
          return;
        }
        const wallControl = handleHit?.object.userData.wallResizeControl as MergedWallResizeControl | undefined;
        const wallStart = wallControl ? pointerToPlan(event) : null;
        if (wallControl && wallStart) {
          const primaryHandle = wallControl.handles.find((handle) => handle.roomId === selectedRoomRef.current) ?? wallControl.handles[0];
          onSelectRoomRef.current(primaryHandle.roomId);
          onActiveCornerRef.current(null);
          wallResizeDrag = { pointerId: event.pointerId, handles: wallControl.handles, start: wallStart, steps: 0 };
          controls.enabled = false;
          renderer.domElement.setPointerCapture(event.pointerId);
          event.preventDefault();
          return;
        }
        const point = pointerToPlan(event);
        const roomId = eraseScopeRef.current === "floor"
          ? renderedFloorAtPointer(event) ?? (point ? roomAtPoint(point) : null)
          : renderedRoomAtPointer(event) ?? (point ? roomAtPoint(point) : null);
        const startCell = pointerToCell(event);
        const selectedCellHit = eraseScopeRef.current === "floor"
          && !!startCell
          && !!roomId
          && selectedFloorAreasRef.current.some((area) => area.floorId === roomId
            && area.cells.some((cell) => cell.x === startCell.x && cell.y === startCell.y));
        if (selectedCellHit && roomId && startCell) {
          onActiveCornerRef.current(null);
          roomMoveDrag = { pointerId: event.pointerId, roomId, start: startCell, dxCells: 0, dyCells: 0 };
          controls.enabled = false;
          renderer.domElement.setPointerCapture(event.pointerId);
          event.preventDefault();
          return;
        }
        if (eraseScopeRef.current === "floor" && startCell && !event.altKey) {
          setInteractionColor("select");
          drawState = {
            pointerId: event.pointerId,
            start: startCell,
            current: startCell,
            operation: "select-floor",
            selectionFloorId: roomId ?? undefined,
          };
          hoverMesh.visible = false;
          controls.enabled = false;
          renderer.domElement.setPointerCapture(event.pointerId);
          showDraft(drawState);
          event.preventDefault();
          return;
        }
        onSelectRoomRef.current(roomId, event.shiftKey || event.ctrlKey || event.metaKey);
        onActiveCornerRef.current(null);
        if (roomId && startCell) {
          roomMoveDrag = { pointerId: event.pointerId, roomId, start: startCell, dxCells: 0, dyCells: 0 };
          controls.enabled = false;
          renderer.domElement.setPointerCapture(event.pointerId);
        }
        event.preventDefault();
        return;
      }
      const cell = pointerToCell(event);
      if (!cell) return;
      const operation = eraseScopeRef.current === "floor"
        ? (toolRef.current === "erase" ? "erase-floor" : "draw-floor")
        : toolRef.current === "erase" ? "erase" : toolRef.current === "circle" ? "circle" : "draw";
      setInteractionColor(operation === "erase" || operation === "erase-floor" ? "erase" : "draw");
      drawState = { pointerId: event.pointerId, start: cell, current: cell, operation };
      hoverMesh.visible = false;
      renderer.domElement.setPointerCapture(event.pointerId);
      showDraft(drawState);
      event.preventDefault();
    };

    const handlePointerMove = (event: PointerEvent) => {
      if(toolRef.current==="connect"&&!connectionDrag) {
        if(pathEdit) {
          const original=pathEdit.original[pathEdit.index];
          const point=pathEdit.vertical?{...original,elevation:original.elevation+Math.round((pathEdit.startY-event.clientY)/40)*1.25}:mousePathPoint(event,original.elevation);
          if(point) {pathEdit.points[pathEdit.index]=point;showPath(pathEdit.points,pathEdit.connection.brokenSegments);}return;
        }
        const anchor=wallAnchor(event);
        anchorMesh.visible=Boolean(anchor);if(anchor)anchorMesh.position.set(anchor.point.x,anchor.point.elevation+0.5,-anchor.point.y);
        renderer.domElement.style.cursor=anchor?"crosshair":"default";
        if(pathDraft) {
          pathDraft.current=anchor?.point??mousePathPoint(event,pathDraft.points.at(-1)!.elevation)??undefined;
          if(pathDraft.current)showPath([...pathDraft.points,pathDraft.current]);
        }
        runtime.render();return;
      }
      if (connectionDrag) {
        let geometry:ReturnType<typeof buildConnectionGeometry>=null;
        if(connectionDrag.fromId) {
          const target=renderedRoomAtPointer(event);
          const planned=target && target!==connectionDrag.fromId ? planRoomConnection(connectionDrag.fromId,target,roomsRef.current,runtime.terrainLayout) : null;
          connectionDrag.targetId=planned ? target! : undefined;
          geometry=planned?.geometry ?? null;
        } else if(setRay(event)) {
          const point=raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0,1,0),-connectionDrag.elevation),new THREE.Vector3());
          const connection=roomConnectionsRef.current.find(c=>c.id===connectionDrag!.connectionId);
          const opening=connection && roomsRef.current.find(r=>r.id===connection.fromRoomId)?.openings.find(o=>o.id===connection.fromOpeningId);
          if(point && connection && opening) {
            connectionDrag.point={x:Math.round(point.x),y:Math.round(-point.z)};
            geometry=buildConnectionGeometry({...connection,bendOffset:{x:connectionDrag.point.x-opening.cx,y:connectionDrag.point.y-opening.cy}},roomsRef.current);
          }
        }
        previewConnection(geometry);
        if(measureRef.current) { measureRef.current.hidden=false; measureRef.current.textContent=geometry ? "Release to create route · Escape cancels" : "Drag to another visible room · No valid route yet"; }
        return;
      }
      brushCursor.visible = false;
      if (toolRef.current === "terrain" && settingsRef.current.terrainPaintMode && setRay(event)) {
        const surface = runtime.terrainSurface.raycast(raycaster);
        if (surface) {
          brushCursor.position.copy(surface.point); brushCursor.position.y += 0.03;
          brushCursor.scale.setScalar((settingsRef.current.terrainPaintSize ?? 4) / 2);
          brushCursor.visible = true;
          runtime.render();
        }
      }
      if (paintStroke?.pointerId === event.pointerId) {
        const point = pointerToTerrainPlan(event);
        const points = paintStroke.region.controlPoints;
        const last = points[points.length - 1];
        if (point && points.length < 4096 && Math.hypot(point.x - last.x, point.y - last.y) >= 0.15) points.push(point);
        if (performance.now() - lastPaintPreview > 32) { lastPaintPreview = performance.now(); previewPaint(); }
        if (measureRef.current) { measureRef.current.hidden = false; measureRef.current.textContent = `Painting · ${(paintStroke.region.brush!.radius * 2).toFixed(1)} m · ${Math.round(paintStroke.region.brush!.intensity * 100)}%`; }
        event.preventDefault(); return;
      }
      if (toolRef.current === "terrain" && settingsRef.current.terrainPaintMode) return;
      if (terrainControlDrag?.pointerId === event.pointerId) {
        const point = pointerToTerrainPlan(event);
        const region = terrainRegionsRef.current.find((candidate) => candidate.id === terrainControlDrag!.regionId);
        if (!point || !region) return;
        const controlPoints = region.controlPoints.map((candidate, index) =>
          index === terrainControlDrag!.controlIndex ? snapTerrainPoint(point) : candidate);
        onTerrainRegionEditRef.current(region.id, { controlPoints });
        if (measureRef.current) {
          measureRef.current.hidden = false;
          measureRef.current.textContent = `Control point ${terrainControlDrag.controlIndex + 1} · ${controlPoints[terrainControlDrag.controlIndex].x} m, ${controlPoints[terrainControlDrag.controlIndex].y} m`;
        }
        event.preventDefault();
        return;
      }
      if (terrainAdjustDrag?.pointerId === event.pointerId) {
        const region = terrainRegionsRef.current.find((candidate) => candidate.id === terrainAdjustDrag!.regionId);
        if (!region) return;
        const verticalSteps = Math.round((terrainAdjustDrag.startClientY - event.clientY) / 18);
        const horizontalSteps = Math.round((event.clientX - terrainAdjustDrag.startClientX) / 22);
        const height = THREE.MathUtils.clamp(terrainAdjustDrag.originalHeight + verticalSteps * 0.25, -20, 20);
        const rawSlopeWidth = terrainAdjustDrag.originalSlopeWidth + horizontalSteps * 0.25;
        const edgeProfile: TerrainEdgeProfile = rawSlopeWidth <= 0.25 ? "cliff" : "smooth";
        const slopeWidth = THREE.MathUtils.clamp(rawSlopeWidth, 0.25, 8);
        onTerrainRegionEditRef.current(region.id, { height, slopeWidth, edgeProfile });
        if (measureRef.current) {
          measureRef.current.hidden = false;
          measureRef.current.textContent = `${height >= 0 ? "Raise" : "Lower"} ${Math.abs(height).toFixed(2)} m · ${edgeProfile === "cliff" ? "Sheer cliff" : `Smooth slope ${slopeWidth.toFixed(2)} m`}`;
        }
        event.preventDefault();
        return;
      }
      if (cornerDrag?.pointerId === event.pointerId) {
        const point = pointerToPlan(event);
        if (!point) return;
        const origin = { x: cornerDrag.handle.vertexX * CELL_SIZE, y: cornerDrag.handle.vertexY * CELL_SIZE };
        const dx = point.x - origin.x;
        const dy = point.y - origin.y;
        const inwardDistance = dx * cornerDrag.handle.inwardX + dy * cornerDrag.handle.inwardY;
        const insetCells = Math.min(cornerDrag.handle.maxInsetCells, Math.max(1, Math.round(Math.max(Math.abs(dx), Math.abs(dy)) / CELL_SIZE)));
        const edit: CornerEdit = {
          vertexX: cornerDrag.handle.vertexX,
          vertexY: cornerDrag.handle.vertexY,
          insetCells,
          shape: inwardDistance >= 0 ? "diagonal" : "curve",
          inverted: cornerDrag.current?.inverted ?? false,
        };
        if (!cornerDrag.current || JSON.stringify(edit) !== JSON.stringify(cornerDrag.current)) {
          cornerDrag.current = edit;
          onCornerEditRef.current(cornerDrag.handle.roomId, edit);
        }
        event.preventDefault();
        return;
      }
      if (radiusDrag?.pointerId === event.pointerId) {
        const point = pointerToPlan(event);
        if (!point) return;
        const reach = Math.hypot(point.x - radiusDrag.handle.cx, point.y - radiusDrag.handle.cy);
        const radius = Math.max(MIN_CIRCLE_RADIUS, Math.round(reach));
        if (measureRef.current) {
          measureRef.current.hidden = false;
          measureRef.current.textContent = `⌀ ${radius * 2} m`;
        }
        if (radius !== radiusDrag.current) {
          radiusDrag.current = radius;
          onCircleResizeRef.current(radiusDrag.handle.roomId, radiusDrag.handle.circleIndex, radius);
        }
        event.preventDefault();
        return;
      }
      if (wallResizeDrag?.pointerId === event.pointerId) {
        const point = pointerToPlan(event);
        if (!point) return;
        const reference = wallResizeDrag.handles[0];
        const { start } = wallResizeDrag;
        const distance = (point.x - start.x) * reference.outwardX + (point.y - start.y) * reference.outwardY;
        wallResizeDrag.steps = Math.round(distance / CELL_SIZE);
        if (measureRef.current) {
          measureRef.current.hidden = false;
          measureRef.current.textContent = wallResizeDrag.steps === 0
            ? "Drag perpendicular to resize"
            : `${wallResizeDrag.steps > 0 ? "Expand" : "Contract"} ${Math.abs(wallResizeDrag.steps) * CELL_SIZE} m`;
        }
        event.preventDefault();
        return;
      }
      if (roomMoveDrag?.pointerId === event.pointerId) {
        const cell = pointerToCell(event);
        if (!cell) return;
        roomMoveDrag.dxCells = cell.x - roomMoveDrag.start.x;
        roomMoveDrag.dyCells = cell.y - roomMoveDrag.start.y;
        if (measureRef.current) {
          measureRef.current.hidden = false;
          measureRef.current.textContent = roomMoveDrag.dxCells === 0 && roomMoveDrag.dyCells === 0
            ? `Drag to move ${eraseScopeRef.current === "floor" ? "floor" : "room"}`
            : `Move ${roomMoveDrag.dxCells * CELL_SIZE} m, ${roomMoveDrag.dyCells * CELL_SIZE} m`;
        }
        event.preventDefault();
        return;
      }
      if (arcPending && toolRef.current === "wall" && wallDrawModeRef.current === "arc") {
        const point = pointerToPlan(event);
        if (point) {
          arcPending.arcPoint = snapWallPoint(point);
          showArcDraft(arcPending);
        }
        return;
      }
      if (arcChordPending && toolRef.current === "wall" && wallDrawModeRef.current === "arc") {
        const point = pointerToPlan(event);
        if (point) {
          arcChordPending.current = snapWallPoint(point);
          showWallDraft({ start: arcChordPending.start, current: arcChordPending.current });
        }
        return;
      }
      if (wallPathPending && (toolRef.current === "wall" || toolRef.current === "railing") && wallDrawModeRef.current === "path") {
        const point = pointerToPlan(event);
        if (point) {
          const last = wallPathPending.points[wallPathPending.points.length - 1];
          wallPathPending.current = snapWallPoint(point, last, event.shiftKey);
          showWallPathDraft(wallPathPending);
        }
        return;
      }
      if (toolRef.current === "pillar") {
        const point = pointerToPlan(event);
        showPillarHover(point ? snapPillarPoint(point) : null);
        return;
      }
      if (toolRef.current === "terrain") {
        const guide = terrainSplinePending ? null : terrainGuideAtPointer(event);
        highlightTerrainRegion(guide?.regionId ?? null, guide?.controlIndex);
        const point = pointerToTerrainPlan(event);
        const snapped = point ? snapTerrainPoint(point) : null;
        if (terrainSplinePending && snapped) {
          terrainSplinePending.current = snapped;
          showTerrainSplineDraft(terrainSplinePending);
        } else showTerrainPointHover(guide ? null : snapped);
        event.preventDefault();
        return;
      }
      const cell = pointerToCell(event);
      if (drawState?.pointerId === event.pointerId) {
        if (cell) { drawState.current = cell; showDraft(drawState); }
        return;
      }
      setInteractionColor(toolRef.current === "erase"
        ? "erase"
        : toolRef.current === "select" && eraseScopeRef.current === "floor" ? "select" : "draw");
      showHover(cell);
    };

    const commitPointer = (event: PointerEvent) => {
      if(pathEdit?.pointerId===event.pointerId) {
        const edit=pathEdit;
        const valid=showPath(edit.points,edit.connection.brokenSegments);
        if(renderer.domElement.hasPointerCapture(event.pointerId))renderer.domElement.releasePointerCapture(event.pointerId);
        cancelConnection();
        if(valid)onCommitRef.current({type:"save-pathway",connection:{...edit.connection,pathPoints:edit.points,pathOrigin:edit.points[0]}});
        else onNoticeRef.current("Not enough room for these stairs. Move points farther apart.");return;
      }
      if(pathDraft?.dragging===event.pointerId) {
        pathDraft.dragging=undefined;
        if(renderer.domElement.hasPointerCapture(event.pointerId))renderer.domElement.releasePointerCapture(event.pointerId);
        const target=wallAnchor(event);
        if(target&&target.opening.id!==pathDraft.opening.id)finishPath(target);
        else if(pathDraft.current&&Math.hypot(pathDraft.current.x-pathDraft.points[0].x,pathDraft.current.y-pathDraft.points[0].y)>0.1)pathDraft.points.push(pathDraft.current);
        return;
      }
      if(connectionDrag?.pointerId===event.pointerId) {
        const drag=connectionDrag; cancelConnection();
        if(drag.fromId && drag.targetId) onCommitRef.current({type:"connect-rooms",fromRoomId:drag.fromId,toRoomId:drag.targetId});
        else if(drag.connectionId && drag.point) onCommitRef.current({type:"bend-connection",id:drag.connectionId,point:drag.point});
        return;
      }
      if (paintStroke?.pointerId === event.pointerId) {
        onCommitRef.current({ type: "add-terrain-region", region: paintStroke.region });
        paintStroke = null; controls.enabled = true;
        if (renderer.domElement.hasPointerCapture(event.pointerId)) renderer.domElement.releasePointerCapture(event.pointerId);
        if (measureRef.current) measureRef.current.hidden = true;
        event.preventDefault(); return;
      }
      if (terrainControlDrag?.pointerId === event.pointerId || terrainAdjustDrag?.pointerId === event.pointerId) {
        terrainControlDrag = null;
        terrainAdjustDrag = null;
        controls.enabled = true;
        if (renderer.domElement.hasPointerCapture(event.pointerId)) renderer.domElement.releasePointerCapture(event.pointerId);
        if (measureRef.current) measureRef.current.hidden = true;
        runtime.render();
        event.preventDefault();
        return;
      }
      if (cornerDrag?.pointerId === event.pointerId) {
        finishCornerDrag(false);
        event.preventDefault();
        return;
      }
      if (radiusDrag?.pointerId === event.pointerId) {
        finishRadiusDrag(false);
        event.preventDefault();
        return;
      }
      if (wallResizeDrag?.pointerId === event.pointerId) {
        finishWallResize(false);
        event.preventDefault();
        return;
      }
      if (roomMoveDrag?.pointerId === event.pointerId) {
        finishRoomMove(false);
        event.preventDefault();
        return;
      }
      const draft = drawState;
      if (!draft || draft.pointerId !== event.pointerId) return;
      drawState = null;
      hideDraft();
      if (renderer.domElement.hasPointerCapture(event.pointerId)) renderer.domElement.releasePointerCapture(event.pointerId);
      event.preventDefault();
      if (draft.operation === "circle") {
        const circle = circleFromDraft(draft);
        if (circle.radius < MIN_CIRCLE_RADIUS) {
          onNoticeRef.current(`Circular rooms need a radius of at least ${MIN_CIRCLE_RADIUS} m, so the fixed 2 m wall module still reads as a curve.`);
          return;
        }
        onCommitRef.current({ type: "circle", circle });
        return;
      }
      const bounds = {
        minX: Math.min(draft.start.x, draft.current.x),
        maxX: Math.max(draft.start.x, draft.current.x),
        minY: Math.min(draft.start.y, draft.current.y),
        maxY: Math.max(draft.start.y, draft.current.y),
      };
      if (draft.operation === "erase-wall-area") {
        const clicked = draft.start.x === draft.current.x && draft.start.y === draft.current.y;
        if (clicked) {
          if (draft.wallTarget) onCommitRef.current({ type: "erase-wall", target: draft.wallTarget });
        } else {
          onCommitRef.current({ type: "erase-walls", bounds });
        }
        return;
      }
      if (draft.operation === "select-floor") {
        const area =
          (bounds.maxX - bounds.minX + 1) *
          (bounds.maxY - bounds.minY + 1);
        if (area > MAX_CELLS) {
          onNoticeRef.current(`Selection is too large (${area} cells).`);
          controls.enabled = true;
          runtime.render();
          return;
        }
        const clicked = draft.start.x === draft.current.x && draft.start.y === draft.current.y;
        const floorId = clicked && draft.selectionFloorId
          ? draft.selectionFloorId
          : floorIdInCellBounds(layoutRef.current.floorHitAreas, bounds, draft.selectionFloorId ?? null);
        onSelectRoomRef.current(floorId);
        onSelectFloorAreaRef.current(floorId, !clicked && floorId ? bounds : null);
        onActiveCornerRef.current(null);
        controls.enabled = true;
        runtime.render();
        return;
      }
      if (draft.operation === "erase" || draft.operation === "erase-floor") {
        if (draft.operation === "erase-floor") {
          onCommitRef.current({ type: "erase-floor", bounds });
          return;
        }
        onCommitRef.current({ type: "erase", bounds });
        return;
      }
      const area = (bounds.maxX - bounds.minX + 1) * (bounds.maxY - bounds.minY + 1);
      if (area > MAX_CELLS) {
        onNoticeRef.current(`Plans are limited to ${MAX_CELLS.toLocaleString()} cells for browser performance.`);
        return;
      }
      const drawn: Cell[] = [];
      for (let y = bounds.minY; y <= bounds.maxY; y += 1) for (let x = bounds.minX; x <= bounds.maxX; x += 1) drawn.push({ x, y });
      onCommitRef.current(draft.operation === "draw-floor" ? { type: "draw-floor", cells: drawn } : { type: "draw", cells: drawn });
    };

    const handlePointerCancel = (event: PointerEvent) => {
      if(pathEdit?.pointerId===event.pointerId||pathDraft?.dragging===event.pointerId)cancelConnection();
      if(connectionDrag?.pointerId===event.pointerId) cancelConnection();
      if (paintStroke?.pointerId === event.pointerId) { paintStroke = null; controls.enabled = true; previewPaint(); }
      if (terrainControlDrag?.pointerId === event.pointerId) {
        onTerrainRegionEditRef.current(terrainControlDrag.regionId, { controlPoints: terrainControlDrag.originalPoints });
        terrainControlDrag = null;
        controls.enabled = true;
      }
      if (terrainAdjustDrag?.pointerId === event.pointerId) {
        onTerrainRegionEditRef.current(terrainAdjustDrag.regionId, {
          height: terrainAdjustDrag.originalHeight,
          slopeWidth: terrainAdjustDrag.originalSlopeWidth,
          edgeProfile: terrainAdjustDrag.originalEdgeProfile,
        });
        terrainAdjustDrag = null;
        controls.enabled = true;
      }
      if (cornerDrag?.pointerId === event.pointerId) finishCornerDrag(true);
      if (radiusDrag?.pointerId === event.pointerId) finishRadiusDrag(true);
      if (roomMoveDrag?.pointerId === event.pointerId) finishRoomMove(true);
      if (wallResizeDrag?.pointerId === event.pointerId) finishWallResize(true);
      if (drawState?.pointerId === event.pointerId) cancelDrawing();
      if (terrainSplinePending || wallPathPending || arcChordPending || arcPending) cancelDrawing();
    };
    const handlePointerLeave = () => {
      brushCursor.visible = false;
      runtime.render();
      if (!drawState && !terrainSplinePending && !terrainControlDrag && !terrainAdjustDrag && !wallPathPending && !arcChordPending && !arcPending && !cornerDrag && !radiusDrag && !roomMoveDrag && !wallResizeDrag) {
        if (toolRef.current === "terrain") {
          highlightTerrainRegion(null);
          showTerrainPointHover(null);
        }
        else showHover(null);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setPathMenu(null);
        cancelConnection();
        setTerrainMenu(null);
        setObjectMenu(null);
        if (paintStroke) { paintStroke = null; controls.enabled = true; previewPaint(); }
        if (terrainControlDrag || terrainAdjustDrag) cancelTerrainEdit();
        else if (cornerDrag) finishCornerDrag(true);
        else if (radiusDrag) finishRadiusDrag(true);
        else if (wallResizeDrag) finishWallResize(true);
        else if (roomMoveDrag) finishRoomMove(true);
        else if (terrainSplinePending || wallPathPending || arcChordPending || arcPending) cancelDrawing();
        else if (drawState) cancelDrawing();
      }
      if (event.key === "Backspace" && terrainSplinePending) {
        event.preventDefault();
        if (terrainSplinePending.points.length > 1) terrainSplinePending.points.pop();
        terrainSplinePending.current = terrainSplinePending.points[terrainSplinePending.points.length - 1];
        showTerrainSplineDraft(terrainSplinePending);
      }
      if (event.key === "Backspace" && wallPathPending) {
        event.preventDefault();
        if (wallPathPending.points.length > 1) wallPathPending.points.pop();
        const last = wallPathPending.points[wallPathPending.points.length - 1];
        wallPathPending.current = last;
        showWallPathDraft(wallPathPending);
      }
    };
    const handleDoubleClick = (event: MouseEvent) => {
      if(toolRef.current==="connect"&&event.button===0) {
        event.preventDefault();event.stopImmediatePropagation();
        if(pathDraft){finishPath();return;}
        const hit=connectionAtPointer(event as PointerEvent);
        const connection=hit&&roomConnectionsRef.current.find(c=>c.id===hit.id);
        if(connection?.pathPoints&&hit?.segment!==undefined) {
          const points=resolvePathPoints(connection,roomsRef.current);
          const edited=insertPathPoint({...connection,pathPoints:points,pathOrigin:points[0]},hit.segment);
          if(!pathwayGeometry(edited.pathPoints!,edited.brokenSegments).invalidSegments.length)onCommitRef.current({type:"save-pathway",connection:edited});
          else onNoticeRef.current("This stair section is too short for another landing point. Lengthen it first.");
        }
        return;
      }
      if (event.button === 0 && toolRef.current === "terrain" && !settingsRef.current.terrainPaintMode) {
        event.preventDefault();
        event.stopPropagation();
        if (!terrainSplinePending) {
          const guide = terrainGuideAtPointer(event as PointerEvent);
          const region = guide && terrainRegionsRef.current.find((candidate) => candidate.id === guide.regionId);
          if (guide?.point && region && guide.controlIndex === undefined) {
            if (region.controlPoints.length >= 64) { onNoticeRef.current("A spline supports up to 64 points."); return; }
            const controlPoints = [...region.controlPoints];
            controlPoints.splice(Math.floor((guide.sampleIndex ?? 0) / 18) + 1, 0, guide.point);
            onCommitRef.current({ type: "replace-terrain-region", region: { ...region, controlPoints } });
          }
          return;
        }
        finishTerrainSpline();
        return;
      }
      if (event.button !== 0 || (toolRef.current !== "wall" && toolRef.current !== "railing")) return;
      event.preventDefault();
      event.stopPropagation();
      if (toolRef.current === "railing" || wallDrawModeRef.current === "path") {
        if (wallPathPending) {
          const point = pointerToPlan(event as unknown as PointerEvent);
          const last = wallPathPending.points[wallPathPending.points.length - 1];
          if (point && last) {
            const snapped = snapWallPoint(point, last, event.shiftKey);
            if (last.x !== snapped.x || last.y !== snapped.y) wallPathPending.points.push(snapped);
          }
        }
        finishWallPath();
        return;
      }
      if (!arcPending) return;
      const point = pointerToPlan(event as unknown as PointerEvent);
      if (!point) return;
      const arcPoint = snapWallPoint(point);
      const arc = circularArcThroughPoints(arcPending.start, arcPoint, arcPending.end);
      if (!arc) {
        onNoticeRef.current("Place the third point away from the straight centre line.");
        return;
      }
      onCommitRef.current({ type: "wall", kind: "curve", start: arcPending.start, end: arcPending.end, arcPoint });
      arcPending = null;
      controls.enabled = true;
      hideDraft();
    };
    const preventContextMenu = (event: MouseEvent) => {
      if (!(event.target instanceof Node) || !host.contains(event.target)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    runtime.setTool = (nextTool) => {
      setPathMenu(null);
      cancelConnection();
      setTerrainMenu(null);
      setObjectMenu(null);
      brushCursor.visible = false;
      if (paintStroke) { paintStroke = null; controls.enabled = true; previewPaint(); }
      cancelDrawing();
      if (nextTool !== "terrain") highlightTerrainRegion(null);
      if (terrainControlDrag || terrainAdjustDrag) cancelTerrainEdit();
      if (cornerDrag) finishCornerDrag(true);
      if (radiusDrag) finishRadiusDrag(true);
      if (roomMoveDrag) finishRoomMove(true);
      if (wallResizeDrag) finishWallResize(true);
      setInteractionColor(nextTool === "erase"
        ? "erase"
        : nextTool === "select" && eraseScopeRef.current === "floor" ? "select" : "draw");
      hoverMesh.visible = false;
      const editElevation = nextTool === "terrain" ? 0 : runtime.gridElevation;
      grid.position.y = visibleGridHeight(runtime.gridElevation) - 0.005;
      interaction.position.y = editElevation;
      runtime.terrainGuides.visible = nextTool === "terrain";
      renderer.domElement.style.cursor = nextTool === "terrain" ? "crosshair" : "";
      runtime.render();
    };

    runtime.setGridElevation = (elevation) => {
      const delta = elevation - runtime.gridElevation;
      runtime.gridElevation = elevation;
      runtime.terrainSurface.update(runtime.terrainLayout, terrainRef.current, terrainRegionsRef.current, settingsRef.current, runtime.terrainTextures, elevation);
      drawingPlane.constant = -elevation;
      camera.position.y += delta;
      controls.target.y += delta;
      controls.update();
      runtime.setTool(toolRef.current);
      runtime.render();
    };
    runtime.setGridElevation(gridElevation);

    renderer.domElement.addEventListener("pointerdown", handlePointerDown, { capture: true });
    renderer.domElement.addEventListener("pointermove", handlePointerMove);
    renderer.domElement.addEventListener("pointerup", commitPointer);
    renderer.domElement.addEventListener("pointercancel", handlePointerCancel);
    renderer.domElement.addEventListener("pointerleave", handlePointerLeave);
    renderer.domElement.addEventListener("dblclick", handleDoubleClick);
    window.addEventListener("contextmenu", preventContextMenu, true);
    window.addEventListener("keydown", handleKeyDown);
    controls.addEventListener("change", runtime.render);
    const resizeObserver = new ResizeObserver(([entry]) => {
      const width = Math.max(1, entry.contentRect.width);
      const height = Math.max(1, entry.contentRect.height);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      runtime.render();
    });
    resizeObserver.observe(host);
    updateDynamicLighting(runtime, displayLayoutRef.current, settingsRef.current);
    rebuildScene(runtime, displayLayoutRef.current, roomsRef.current, roomConnectionsRef.current, stairsRef.current, placedPillarsRef.current, terrainRef.current, terrainRegionsRef.current, settingsRef.current, selectedRoomRef.current, selectedRoomIdsRef.current, selectedFloorCellsRef.current, selectedFloorAreasRef.current, activeCornerRef.current);
    rebuildTerrainGuides(runtime, terrainRegionsRef.current);
    fitCamera(runtime, displayLayoutRef.current);

    return () => {
      resizeObserver.disconnect();
      renderer.domElement.removeEventListener("pointerdown", handlePointerDown, { capture: true });
      renderer.domElement.removeEventListener("pointermove", handlePointerMove);
      renderer.domElement.removeEventListener("pointerup", commitPointer);
      renderer.domElement.removeEventListener("pointercancel", handlePointerCancel);
      renderer.domElement.removeEventListener("pointerleave", handlePointerLeave);
      scene.remove(connectionPreview);scene.remove(anchorMesh); connectionPreviewMaterial.dispose();
      renderer.domElement.removeEventListener("dblclick", handleDoubleClick);
      window.removeEventListener("contextmenu", preventContextMenu, true);
      window.removeEventListener("keydown", handleKeyDown);
      controls.removeEventListener("change", runtime.render);
      controls.dispose();
      runtime.terrainSurface.dispose();
      brushCursor.geometry.dispose(); brushCursor.material.dispose(); scene.remove(brushCursor);
      disposeGenerated(generated);
      rebuildTerrainGuides(runtime, []);
      cube.dispose();
      outlineGeometry.dispose();
      discGeometry.dispose();
      ringGeometry.dispose();
      curveDraftGeometry.dispose();
      arcAnchorGeometry.dispose();
      wallFootprintGeometry.dispose();
      wallFootprintOutlineGeometry.dispose();
      hoverMaterial.dispose();
      draftMaterial.dispose();
      outlineMaterial.dispose();
      Object.values(materials.floors).forEach((material) => material.dispose());
      Object.values(materials.walls).forEach((material) => material.dispose());
      Object.values(materials.pillars).forEach((material) => material.dispose());
      materials.trim.dispose();
      materials.handle.dispose();
      materials.handleActive.dispose();
      materials.wallHandle.dispose();
      materials.floorSelection.dispose();
      materials.terrain.dispose();
      materials.terrainSpline.dispose();
      materials.terrainControl.dispose();
      for (const textures of Object.values(runtime.terrainTextures)) {
        textures?.color.dispose();
        textures?.normal.dispose();
        textures?.height.dispose();
      }
      floorTexture?.dispose();
      assets.cutWalls.forEach(disposeBooleanTemplate);
      assets.cutWalls.clear();
      sharedTextures.dispose();
      runtime.hdriBackgroundMap?.dispose();
      runtime.hdriEnvironmentMap?.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      runtimeRef.current = null;
    };
  }, []);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    const version = ++runtime.hdriLoadVersion;
    if (!hdriUrl && !cubeMapUrls) {
      runtime.hdriBackgroundMap?.dispose();
      runtime.hdriEnvironmentMap?.dispose();
      runtime.hdriBackgroundMap = null;
      runtime.hdriEnvironmentMap = null;
      updateDynamicLighting(runtime, displayLayoutRef.current, settingsRef.current);
      runtime.render();
      return;
    }

    const sourcePromise: Promise<THREE.Texture> = cubeMapUrls
      ? new THREE.CubeTextureLoader().loadAsync(cubeMapUrls)
      : hdriKind === "exr"
        ? new EXRLoader().loadAsync(hdriUrl!)
        : new RGBELoader().loadAsync(hdriUrl!);
    void sourcePromise.then((texture) => {
      if (runtimeRef.current !== runtime || runtime.hdriLoadVersion !== version) {
        texture.dispose();
        return;
      }
      const isCubeMap = texture instanceof THREE.CubeTexture;
      if (isCubeMap) {
        texture.mapping = THREE.CubeReflectionMapping;
        texture.colorSpace = THREE.SRGBColorSpace;
      } else {
        texture.mapping = THREE.EquirectangularReflectionMapping;
      }
      const pmrem = new THREE.PMREMGenerator(runtime.renderer);
      pmrem.compileEquirectangularShader();
      const environment = isCubeMap
        ? pmrem.fromCubemap(texture as THREE.CubeTexture).texture
        : pmrem.fromEquirectangular(texture).texture;
      pmrem.dispose();
      runtime.hdriBackgroundMap?.dispose();
      runtime.hdriEnvironmentMap?.dispose();
      runtime.hdriBackgroundMap = texture;
      runtime.hdriEnvironmentMap = environment;
      updateDynamicLighting(runtime, displayLayoutRef.current, settingsRef.current);
      runtime.render();
    }, (error) => {
      if (runtime.hdriLoadVersion === version) console.error("[lighting] failed to load HDRI", error);
    });
  }, [hdriUrl, hdriKind, cubeMapUrls]);

  useEffect(() => {
    layoutRef.current = layout;
    const buildingSettings = (value: BuildSettings) => JSON.stringify(Object.fromEntries(Object.entries(value).filter(([key]) => !key.startsWith("terrain"))));
    const buildingsChanged = displayLayoutRef.current !== displayLayout || roomsRef.current !== rooms || roomConnectionsRef.current !== roomConnections || stairsRef.current !== stairs || placedPillarsRef.current !== placedPillars || selectedRoomRef.current !== selectedRoomId || selectedRoomIdsRef.current !== selectedRoomIds || selectedFloorCellsRef.current !== selectedFloorCells || selectedFloorAreasRef.current !== selectedFloorAreas || activeCornerRef.current !== activeCorner || buildingSettings(settingsRef.current) !== buildingSettings(settings);
    displayLayoutRef.current = displayLayout;
    roomsRef.current = rooms;
    roomConnectionsRef.current = roomConnections;
    stairsRef.current = stairs;
    stairAssetRef.current = stairAsset;
    placedPillarsRef.current = placedPillars;
    terrainRef.current = terrain;
    terrainRegionsRef.current = terrainRegions;
    settingsRef.current = settings;
    selectedRoomRef.current = selectedRoomId;
    selectedRoomIdsRef.current = selectedRoomIds;
    selectedFloorCellsRef.current = selectedFloorCells;
    selectedFloorAreasRef.current = selectedFloorAreas;
    activeCornerRef.current = activeCorner;
    if (runtimeRef.current) {
      runtimeRef.current.terrainLayout = terrainLayout;
      applyTerrainTexture(runtimeRef.current, settings.terrainTexture ?? "grass");
      updateDynamicLighting(runtimeRef.current, displayLayout, settings);
      if (buildingsChanged) rebuildScene(runtimeRef.current, displayLayout, rooms, roomConnections, stairs, placedPillars, terrain, terrainRegions, settings, selectedRoomId, selectedRoomIds, selectedFloorCells, selectedFloorAreas, activeCorner);
      else runtimeRef.current.terrainSurface.update(terrainLayout, terrain, terrainRegions, settings, runtimeRef.current.terrainTextures, runtimeRef.current.gridElevation);
      rebuildTerrainGuides(runtimeRef.current, terrainRegions);
    }
  }, [layout, displayLayout, terrainLayout, rooms, roomConnections, stairs, stairAsset, placedPillars, terrain, terrainRegions, settings, selectedRoomId, selectedRoomIds, selectedFloorCells, selectedFloorAreas, activeCorner]);

  useEffect(() => { runtimeRef.current?.setGridElevation(gridElevation); }, [gridElevation]);

  useEffect(() => {
    toolRef.current = tool;
    runtimeRef.current?.setTool(tool);
  }, [tool, wallDrawMode]);

  useEffect(() => { if (runtimeRef.current) fitCamera(runtimeRef.current, displayLayoutRef.current); }, [fitSignal]);
  const setView = (top: boolean) => { if (runtimeRef.current) fitCamera(runtimeRef.current, displayLayoutRef.current, top); };
  const toolLabel = tool === "connect" ? "Connect rooms" : tool === "erase"
    ? (eraseScope === "floor" ? "Erase floors" : eraseScope === "wall" ? "Erase walls" : "Erase rooms")
    : tool === "select"
      ? (eraseScope === "floor" ? "Select floor / corner" : "Select room / corner")
      : tool === "circle"
        ? "Draw circular room"
        : tool === "opening" ? "Place door / window" : tool === "stairs" ? "Place stairs" : tool === "pillar" ? "Place pillar" : tool === "terrain" ? (settings.terrainPaintMode ? "Paint terrain" : `${terrainMode} terrain spline`) : tool === "railing" ? "Balcony railing path" : tool === "wall" ? (wallDrawMode === "path" ? "Wall path" : "Arc wall") : eraseScope === "floor" ? "Draw floors" : "Draw rooms";
  const leftHint = tool === "connect" ? "wall handle starts path · click adds point · arrow changes height · double-click finishes" : tool === "select"
    ? (eraseScope === "floor" ? "click: whole / drag: area / Alt-drag: move" : "move room / resize wall")
    : tool === "erase"
      ? "erase"
      : tool === "circle"
        ? "drag circle"
        : tool === "opening" ? "place opening" : tool === "stairs" ? "place stair · click stair to rotate · right-click for Delete" : tool === "pillar" ? "place snapped pillar · right-click for Delete" : tool === "terrain" ? (settings.terrainPaintMode ? "drag to paint · Escape cancels stroke" : "drag points to reshape · drag curve ↑↓ height / ←→ slope") : tool === "railing" ? "1 m snap · double-click confirms" : tool === "wall" ? (wallDrawMode === "path" ? "click points · double-click confirms" : "click start / end · double-click arc point") : "draw";

  return (
    <div className={`three-viewport tool-${tool}`} ref={hostRef}>
      {pathMenu && <div style={{position:"absolute",left:pathMenu.x,top:pathMenu.y,zIndex:101,display:"grid",gap:4,background:"#242824",padding:8}}>
        {pathMenu.index!==undefined&&pathMenu.index>0&&pathMenu.index<(pathMenu.connection.pathPoints?.length??0)-1&&<button onClick={()=>{const c=deletePathPoint(pathMenu.connection,pathMenu.index!);if(!pathwayGeometry(c.pathPoints!,c.brokenSegments).invalidSegments.length)onCommit({type:"save-pathway",connection:c});else onNotice("Removing this point would create invalid stairs.");setPathMenu(null);}}>Delete point</button>}
        {pathMenu.segment!==undefined&&<button onClick={()=>{onCommit({type:"save-pathway",connection:{...pathMenu.connection,brokenSegments:[...new Set([...(pathMenu.connection.brokenSegments??[]),pathMenu.segment!])]}});setPathMenu(null);}}>Break segment</button>}
        <button onClick={()=>{onCommit({type:"remove-connection",id:pathMenu.connection.id});setPathMenu(null);}}>Delete pathway</button>
      </div>}
      {objectMenu && <button type="button" style={{ position: "absolute", left: objectMenu.x, top: objectMenu.y, zIndex: 100, padding: "10px 16px" }} onClick={() => { onCommit({ type: objectMenu.type, id: objectMenu.id }); setObjectMenu(null); }}>Delete</button>}
      {terrainMenu && <button type="button" style={{ position: "absolute", left: terrainMenu.x, top: terrainMenu.y, zIndex: 100, padding: "10px 16px" }} onClick={() => { onCommit({ type: "remove-terrain-region", id: terrainMenu.id }); setTerrainMenu(null); }}>Delete spline</button>}
      <div className="view-controls" aria-label="Three dimensional view controls">
        <button type="button" onClick={() => setView(false)} aria-label="Perspective view"><Icon name="cube" /></button>
        <button type="button" onClick={() => setView(true)} aria-label="Top view"><Icon name="top" /></button>
        <button type="button" onClick={() => setView(false)} aria-label="Fit three dimensional view"><Icon name="fit" /></button>
      </div>
      <div className={`active-tool-label ${tool}`}><i />{toolLabel}</div>
      <div ref={measureRef} className="draft-measure" hidden />
      <div className="orbit-hint">Left: {leftHint} · Middle: pan · Right: {tool === "wall" || tool === "terrain" ? "cancel / orbit when idle" : "orbit"} · Wheel: zoom</div>
      {!terrain.length && !terrainRegions.length && !displayLayout.cells.length && !displayLayout.roomGrounds.length && !displayLayout.floorGrounds.length && !displayLayout.walls.length && <div className="empty-3d"><Icon name="cube" /><span>Drag on the grid to draw your room, wall, floor, or terrain</span></div>}
    </div>
  );
}
