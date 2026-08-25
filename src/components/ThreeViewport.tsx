import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { RGBELoader } from "three/addons/loaders/RGBELoader.js";
import { EXRLoader } from "three/addons/loaders/EXRLoader.js";
import { CELL_SIZE, MAX_CELLS, WALL_HEIGHT, WALL_THICKNESS } from "../layout";
import { circleFromDrag, MIN_CIRCLE_RADIUS, pointInPolygon } from "../footprint";
import { cellCenterToWorld, planYToWorldZ, worldPointToCell } from "../coordinates";
import { SharedTextureLoader } from "../textures";
import type {
  BuildSettings,
  Cell,
  CornerEdit,
  CornerHandle,
  EditorTool,
  GeneratedLayout,
  PlanAction,
  PlanPoint,
  RadiusHandle,
  Variant,
  WallPath,
  WallResizeHandle,
  WallSegment,
} from "../types";
import { Icon } from "../icons";

interface CornerIdentity { roomId: string; vertexX: number; vertexY: number; }

interface ThreeViewportProps {
  layout: GeneratedLayout;
  settings: BuildSettings;
  hdriUrl: string | null;
  hdriKind: "hdr" | "exr" | null;
  cubeMapUrls: [string, string, string, string, string, string] | null;
  fitSignal: number;
  tool: EditorTool;
  selectedRoomId: string | null;
  activeCorner: CornerIdentity | null;
  onCommit: (action: PlanAction) => void;
  onSelectRoom: (roomId: string | null) => void;
  onActiveCorner: (corner: CornerIdentity | null) => void;
  onCornerEdit: (roomId: string, edit: CornerEdit) => void;
  onCornerRemove: (roomId: string, vertexX: number, vertexY: number) => void;
  onCircleResize: (roomId: string, circleIndex: number, radius: number) => void;
  onRoomMove: (roomId: string, dxCells: number, dyCells: number) => void;
  onWallResize: (updates: Array<{ handle: WallResizeHandle; steps: number }>) => void;
  onNotice: (message: string) => void;
}

interface SceneRuntime {
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
  assets: {
    grounds: Record<Variant, THREE.Group | null>;
    pillar: THREE.Group | null;
    walls: Record<Variant, THREE.Group | null>;
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
  operation: "draw" | "erase" | "circle";
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
  return start < end ? `${start}|${end}` : `${end}|${start}`;
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

function prepareTemplate(model: THREE.Group, centered = false) {
  model.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(model);
  if (centered) {
    const center = bounds.getCenter(new THREE.Vector3());
    model.position.x -= center.x;
    model.position.z -= center.z;
  }
  model.position.y -= bounds.min.y;
  model.traverse((object) => {
    if (object instanceof THREE.Mesh) {
      object.castShadow = true;
      object.receiveShadow = true;
    }
  });
  model.updateMatrixWorld(true);
  return model;
}

function addModel(runtime: SceneRuntime, template: THREE.Group | null, x: number, z: number, rotation = 0) {
  if (!template) return false;
  const model = template.clone(true);
  model.position.x += x;
  model.position.z += z;
  model.rotation.y += rotation;
  runtime.generated.add(model);
  return true;
}

function wallTransform(x: number, planY: number, length: number, rotation: number): Transform {
  return {
    x: x + Math.cos(rotation) * length / 2,
    y: WALL_HEIGHT / 2,
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
        positions.setXYZ(vertex, planX, positions.getY(vertex), planYToWorldZ(planY));
      }
      positions.needsUpdate = true;
      geometry.computeVertexNormals();
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
      geometry.userData.morGenerated = true;
      const mesh = new THREE.Mesh(geometry, object.material);
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

function addRoomGround(runtime: SceneRuntime, layout: GeneratedLayout, settings: BuildSettings) {
  const material = firstGroundMaterial(runtime.assets.grounds[settings.floorVariant], runtime.materials.floors[settings.floorVariant]);
  for (const ground of layout.roomGrounds) {
    if (ground.outer.length < 3) continue;
    const shape = new THREE.Shape(ground.outer.map((point) => new THREE.Vector2(point.x, point.y)));
    for (const hole of ground.holes) shape.holes.push(new THREE.Path(hole.map((point) => new THREE.Vector2(point.x, point.y))));
    const geometry = new THREE.ShapeGeometry(shape);
    const position = geometry.getAttribute("position");
    const uv = geometry.getAttribute("uv");
    for (let index = 0; index < position.count; index += 1) uv.setXY(index, position.getX(index) / CELL_SIZE, position.getY(index) / CELL_SIZE);
    uv.needsUpdate = true;
    geometry.userData.morGenerated = true;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = 0.01;
    mesh.receiveShadow = true;
    runtime.generated.add(mesh);
  }
}

function disposeGenerated(group: THREE.Group) {
  group.traverse((object) => {
    if (object instanceof THREE.InstancedMesh) object.dispose();
    if (object instanceof THREE.Mesh && object.geometry.userData.morGenerated) object.geometry.dispose();
  });
  group.clear();
}

function fitCamera(runtime: SceneRuntime, layout: GeneratedLayout, top = false) {
  const { minX, minY, maxX, maxY } = layout.bounds;
  const centerX = (minX + maxX) / 2;
  const centerZ = planYToWorldZ((minY + maxY) / 2);
  const span = Math.max(maxX - minX, maxY - minY, 7);
  runtime.controls.target.set(centerX, 0.85, centerZ);
  if (top) {
    runtime.camera.up.set(0, 0, -1);
    runtime.camera.position.set(centerX, span * 1.55, centerZ);
  } else {
    runtime.camera.up.set(0, 1, 0);
    runtime.camera.position.set(centerX + span * 0.92, span * 0.82, centerZ + span * 1.05);
  }
  runtime.camera.near = Math.max(0.05, span / 500);
  runtime.camera.far = Math.max(1200, span * 30);
  runtime.camera.updateProjectionMatrix();
  runtime.controls.update();
  runtime.render();
}

function addStraightLayer(runtime: SceneRuntime, wall: WallSegment, variant: Variant, flipped: boolean, signedOffset: number) {
  const alongX = flipped ? wall.x + Math.cos(wall.rotation) * wall.length : wall.x;
  const alongY = flipped ? wall.y + Math.sin(wall.rotation) * wall.length : wall.y;
  const x = alongX - Math.sin(wall.rotation) * signedOffset;
  const y = alongY + Math.cos(wall.rotation) * signedOffset;
  return addModel(runtime, runtime.assets.walls[variant], x, planYToWorldZ(y), wall.rotation + (flipped ? Math.PI : 0));
}

function renderStraightWall(runtime: SceneRuntime, wall: WallSegment, settings: BuildSettings, fallbackWalls: Transform[]) {
  let added = true;
  if (wall.opposingRoomId) {
    if (settings.showInnerWalls) {
      const separation = settings.sharedWallSeparation / 2;
      added = addStraightLayer(runtime, wall, wall.insideVariant ?? wall.variant, settings.flipInnerWall, settings.innerWallOffset + separation) && added;
      added = addStraightLayer(runtime, wall, wall.opposingVariant ?? wall.variant, !settings.flipInnerWall, -settings.innerWallOffset - separation) && added;
    }
  } else {
    if (settings.showInnerWalls) added = addStraightLayer(runtime, wall, wall.insideVariant ?? settings.innerWallVariant, settings.flipInnerWall, settings.innerWallOffset) && added;
    if (settings.showOuterWalls) added = addStraightLayer(runtime, wall, wall.outsideVariant ?? settings.outerWallVariant, settings.flipOuterWall, -settings.outerWallOffset) && added;
  }
  if (!added) fallbackWalls.push(wallTransform(wall.x, wall.y, wall.length, wall.rotation));
}

function renderPathWall(runtime: SceneRuntime, wall: WallPath, settings: BuildSettings) {
  if (wall.opposingRoomId) {
    if (!settings.showInnerWalls) return;
    const separation = settings.sharedWallSeparation / 2;
    addDeformedWall(runtime, runtime.assets.walls[wall.insideVariant], wall.points, settings.flipInnerWall, settings.innerWallOffset + separation);
    addDeformedWall(runtime, runtime.assets.walls[wall.opposingVariant ?? wall.insideVariant], wall.points, !settings.flipInnerWall, -settings.innerWallOffset - separation);
    return;
  }
  if (settings.showInnerWalls) addDeformedWall(runtime, runtime.assets.walls[wall.insideVariant], wall.points, settings.flipInnerWall, settings.innerWallOffset);
  if (settings.showOuterWalls) addDeformedWall(runtime, runtime.assets.walls[wall.outsideVariant], wall.points, settings.flipOuterWall, -settings.outerWallOffset);
}

function updateDynamicLighting(runtime: SceneRuntime, layout: GeneratedLayout, settings: BuildSettings) {
  const { scene, renderer, hemisphere, sun } = runtime;
  renderer.toneMappingExposure = settings.exposure;

  const centerX = (layout.bounds.minX + layout.bounds.maxX) / 2;
  const centerY = (layout.bounds.minY + layout.bounds.maxY) / 2;
  const centerZ = planYToWorldZ(centerY);
  const span = Math.max(layout.bounds.maxX - layout.bounds.minX, layout.bounds.maxY - layout.bounds.minY, 20);
  const shadowSpan = Math.max(45, span * 0.72 + 12);
  sun.shadow.camera.left = -shadowSpan;
  sun.shadow.camera.right = shadowSpan;
  sun.shadow.camera.top = shadowSpan;
  sun.shadow.camera.bottom = -shadowSpan;
  sun.shadow.camera.near = 0.5;
  sun.shadow.camera.far = Math.max(350, span * 8);
  sun.shadow.camera.updateProjectionMatrix();
  sun.target.position.set(centerX, 0, centerZ);
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
    sun.position.set(centerX + span * 0.9, span * 1.4, centerZ + span * 0.7);
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
    lightElevation * orbitRadius,
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

function rebuildScene(runtime: SceneRuntime, layout: GeneratedLayout, settings: BuildSettings, selectedRoomId: string | null, activeCorner: CornerIdentity | null) {
  disposeGenerated(runtime.generated);
  runtime.handles.clear();

  if (layout.roomGrounds.length) {
    addRoomGround(runtime, layout, settings);
  } else {
    const floorTransforms: Transform[] = [];
    for (const cell of layout.cells) {
      const center = cellCenterToWorld(cell);
      if (addModel(runtime, runtime.assets.grounds[settings.floorVariant], center.x, center.z)) continue;
      floorTransforms.push({ x: center.x, y: 0, z: center.z, sx: CELL_SIZE - 0.06, sy: 0.12, sz: CELL_SIZE - 0.06 });
    }
    addInstances(runtime, floorTransforms, runtime.materials.floors[settings.floorVariant], false);
  }

  const fallbackWalls: Transform[] = [];
  layout.walls.forEach((wall) => renderStraightWall(runtime, wall, settings, fallbackWalls));
  layout.wallPaths.forEach((wall) => renderPathWall(runtime, wall, settings));
  addInstances(runtime, fallbackWalls, runtime.materials.walls[settings.wallVariant]);
  addInstances(runtime, fallbackWalls.map((transform) => ({ ...transform, y: WALL_HEIGHT - 0.05, sy: 0.1, sz: WALL_THICKNESS + 0.035 })), runtime.materials.trim, false);

  for (const variant of ["A", "B", "C"] as Variant[]) {
    const transforms = layout.pillars.filter((pillar) => pillar.variant === variant).flatMap((pillar) => {
      if (addModel(runtime, runtime.assets.pillar, pillar.x, planYToWorldZ(pillar.y))) return [];
      const width = pillar.junction ? 0.32 : variant === "B" ? 0.42 : variant === "C" ? 0.28 : 0.35;
      return [{ x: pillar.x, y: WALL_HEIGHT / 2, z: planYToWorldZ(pillar.y), sx: width, sy: WALL_HEIGHT + 0.05, sz: width }];
    });
    addInstances(runtime, transforms, runtime.materials.pillars[variant]);
  }

  if (selectedRoomId) {
    // Selecting one room exposes the connected assembly. Shared room boundaries and
    // vertices collapse to a single control instead of drawing controls on top of each other.
    const visibleRoomIds = joinedRoomIds(layout, selectedRoomId);
    const visibleCorners = layout.cornerHandles.filter((candidate) => visibleRoomIds.has(candidate.roomId));
    const mergedCorners = new Map<string, CornerHandle[]>();
    for (const handle of visibleCorners) {
      const key = `${handle.vertexX},${handle.vertexY}`;
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
      mesh.position.set(handle.vertexX * CELL_SIZE, 0.7, planYToWorldZ(handle.vertexY * CELL_SIZE));
      mesh.scale.setScalar(active ? 0.86 : 0.72);
      mesh.renderOrder = 30;
      mesh.userData.cornerHandle = handle;
      runtime.handles.add(mesh);
    }
    // Four grab points around the circumference; each resizes the radius identically.
    for (const handle of layout.radiusHandles.filter((candidate) => visibleRoomIds.has(candidate.roomId))) {
      const mesh = new THREE.Mesh(runtime.cube, runtime.materials.handle);
      mesh.position.set(
        handle.cx + Math.cos(handle.angle) * handle.radius,
        0.52,
        planYToWorldZ(handle.cy + Math.sin(handle.angle) * handle.radius),
      );
      mesh.scale.setScalar(0.32);
      mesh.renderOrder = 30;
      mesh.userData.radiusHandle = handle;
      runtime.handles.add(mesh);
    }
    // Long blue grips sit on each straight room edge. Dragging one perpendicular
    // to itself adds or removes a complete row of 2 m cells.
    for (const control of mergeWallResizeControls(layout.wallResizeHandles.filter((candidate) => visibleRoomIds.has(candidate.roomId)))) {
      const handle = control.handles.find((candidate) => candidate.roomId === selectedRoomId) ?? control.handles[0];
      const dx = handle.end.x - handle.start.x;
      const dy = handle.end.y - handle.start.y;
      const length = Math.hypot(dx, dy);
      const mesh = new THREE.Mesh(runtime.cube, runtime.materials.wallHandle);
      mesh.position.set(
        (handle.start.x + handle.end.x) / 2,
        0.4,
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
  settings,
  hdriUrl,
  hdriKind,
  cubeMapUrls,
  fitSignal,
  tool,
  selectedRoomId,
  activeCorner,
  onCommit,
  onSelectRoom,
  onActiveCorner,
  onCornerEdit,
  onCornerRemove,
  onCircleResize,
  onRoomMove,
  onWallResize,
  onNotice,
}: ThreeViewportProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<SceneRuntime | null>(null);
  const layoutRef = useRef(layout);
  const settingsRef = useRef(settings);
  const toolRef = useRef(tool);
  const selectedRoomRef = useRef(selectedRoomId);
  const activeCornerRef = useRef(activeCorner);
  const onCommitRef = useRef(onCommit);
  const onNoticeRef = useRef(onNotice);
  const onSelectRoomRef = useRef(onSelectRoom);
  const onActiveCornerRef = useRef(onActiveCorner);
  const onCornerEditRef = useRef(onCornerEdit);
  const onCornerRemoveRef = useRef(onCornerRemove);
  const onCircleResizeRef = useRef(onCircleResize);
  const onRoomMoveRef = useRef(onRoomMove);
  const onWallResizeRef = useRef(onWallResize);

  onCommitRef.current = onCommit;
  onNoticeRef.current = onNotice;
  onSelectRoomRef.current = onSelectRoom;
  onActiveCornerRef.current = onActiveCorner;
  onCornerEditRef.current = onCornerEdit;
  onCornerRemoveRef.current = onCornerRemove;
  onCircleResizeRef.current = onCircleResize;
  onRoomMoveRef.current = onRoomMove;
  onWallResizeRef.current = onWallResize;

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
    handles.renderOrder = 30;
    scene.add(generated, handles);
    const assets: SceneRuntime["assets"] = { grounds: { A: null, B: null, C: null }, pillar: null, walls: { A: null, B: null, C: null } };
    const cube = new THREE.BoxGeometry(1, 1, 1);
    const materials: SceneRuntime["materials"] = {
      floors: { A: makeMaterial(0xb9b2a5, 0.88), B: makeMaterial(0x8d9690, 0.82), C: makeMaterial(0xa56c56, 0.84) },
      walls: { A: makeMaterial(0xd9d3c7, 0.78), B: makeMaterial(0x87978a, 0.82), C: makeMaterial(0xb66c52, 0.8) },
      pillars: { A: makeMaterial(0x343a35, 0.66), B: makeMaterial(0x6f785f, 0.72), C: makeMaterial(0x9c503c, 0.74) },
      trim: makeMaterial(0x2d342f, 0.62),
      handle: new THREE.MeshBasicMaterial({ color: 0xc6d36e, depthTest: false, depthWrite: false }),
      handleActive: new THREE.MeshBasicMaterial({ color: 0xcf5c3d, depthTest: false, depthWrite: false }),
      wallHandle: new THREE.MeshBasicMaterial({ color: 0x48a9c5, transparent: true, opacity: 0.9, depthTest: false, depthWrite: false }),
    };
    const hemisphere = new THREE.HemisphereLight(0xf2eee4, 0x1a211d, 2.25);
    const sun = new THREE.DirectionalLight(0xfff3dc, 3.2);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.0003;
    scene.add(hemisphere, sun, sun.target);
    const runtime: SceneRuntime = {
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
      assets,
      cube,
      materials,
      render: () => renderer.render(scene, camera),
      setTool: () => undefined,
    };
    runtimeRef.current = runtime;

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
    void Promise.all([
      ...(["A", "B", "C"] as Variant[]).map((variant) => loadModel(`/models/FL2x2${variant}.glb`, (gltf) => { assets.grounds[variant] = prepareTemplate(gltf.scene, true); })),
      loadModel("/models/P3_A.glb", (gltf) => { assets.pillar = prepareTemplate(gltf.scene); }),
      ...(["A", "B", "C"] as Variant[]).map((variant) => loadModel(`/models/W3x2${variant}.glb`, (gltf) => { assets.walls[variant] = prepareTemplate(gltf.scene); })),
    ]).then(() => {
      if (runtimeRef.current !== runtime) return;
      rebuildScene(runtime, layoutRef.current, settingsRef.current, selectedRoomRef.current, activeCornerRef.current);
      const { unique, issued } = sharedTextures.stats();
      console.info(`[assets] ${issued} texture slots served by ${unique} unique images; ${renderer.info.memory.textures} GPU textures live`);
    });

    const groundMaterial = new THREE.MeshStandardMaterial({ color: 0x202622, roughness: 0.96 });
    const groundGeometry = new THREE.PlaneGeometry(1000, 1000);
    const ground = new THREE.Mesh(groundGeometry, groundMaterial);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.07;
    ground.receiveShadow = true;
    scene.add(ground);
    const grid = new THREE.GridHelper(800, 400, 0x4f5c52, 0x303832);
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

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const hit = new THREE.Vector3();
    const drawingPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    let drawState: DrawState | null = null;
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

    const showHover = (cell: Cell | null) => {
      hoverMesh.visible = cell !== null && drawState === null && toolRef.current !== "select";
      if (cell) {
        const center = cellCenterToWorld(cell);
        hoverMesh.position.x = center.x;
        hoverMesh.position.z = center.z;
      }
      runtime.render();
    };
    const hideDraft = () => {
      draftMesh.visible = false;
      draftOutline.visible = false;
      circleDraftMesh.visible = false;
      circleDraftOutline.visible = false;
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
        object.scale.set(widthCells * CELL_SIZE - 0.06, 0.045, depthCells * CELL_SIZE - 0.06);
        object.visible = true;
      }
      if (measureRef.current) {
        measureRef.current.hidden = false;
        measureRef.current.textContent = `${widthCells * CELL_SIZE} m × ${depthCells * CELL_SIZE} m`;
      }
      runtime.render();
    };
    const setInteractionColor = (operation: "draw" | "erase") => {
      hoverMaterial.color.setHex(operation === "draw" ? 0xcf5c3d : 0xa2382c);
      draftMaterial.color.setHex(operation === "draw" ? 0xcf5c3d : 0xa2382c);
      outlineMaterial.color.setHex(operation === "draw" ? 0xf0a386 : 0xff8b7d);
    };
    const cancelDrawing = () => {
      if (drawState && renderer.domElement.hasPointerCapture(drawState.pointerId)) renderer.domElement.releasePointerCapture(drawState.pointerId);
      drawState = null;
      hideDraft();
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
      const candidates = layoutRef.current.roomHitAreas.filter(
        (groundShape) => pointInPolygon(point, groundShape.outer) && !groundShape.holes.some((hole) => pointInPolygon(point, hole)),
      );
      // In an overlap, keep the currently selected logical room under the pointer. Clicking
      // an exposed part of another member still selects it normally.
      const selected = candidates.find((groundShape) => groundShape.roomId === selectedRoomRef.current);
      return selected?.roomId ?? candidates[0]?.roomId ?? null;
    };

    const handlePointerDown = (event: PointerEvent) => {
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
        const roomId = point ? roomAtPoint(point) : null;
        onSelectRoomRef.current(roomId);
        onActiveCornerRef.current(null);
        const startCell = roomId ? pointerToCell(event) : null;
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
      const operation = toolRef.current === "erase" ? "erase" : toolRef.current === "circle" ? "circle" : "draw";
      setInteractionColor(operation === "erase" ? "erase" : "draw");
      drawState = { pointerId: event.pointerId, start: cell, current: cell, operation };
      hoverMesh.visible = false;
      renderer.domElement.setPointerCapture(event.pointerId);
      showDraft(drawState);
      event.preventDefault();
    };

    const handlePointerMove = (event: PointerEvent) => {
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
            ? "Drag to move room"
            : `Move ${roomMoveDrag.dxCells * CELL_SIZE} m, ${roomMoveDrag.dyCells * CELL_SIZE} m`;
        }
        event.preventDefault();
        return;
      }
      const cell = pointerToCell(event);
      if (drawState?.pointerId === event.pointerId) {
        if (cell) { drawState.current = cell; showDraft(drawState); }
        return;
      }
      setInteractionColor(toolRef.current === "erase" ? "erase" : "draw");
      showHover(cell);
    };

    const commitPointer = (event: PointerEvent) => {
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
      if (draft.operation === "erase") {
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
      onCommitRef.current({ type: "draw", cells: drawn });
    };

    const handlePointerCancel = (event: PointerEvent) => {
      if (cornerDrag?.pointerId === event.pointerId) finishCornerDrag(true);
      if (radiusDrag?.pointerId === event.pointerId) finishRadiusDrag(true);
      if (roomMoveDrag?.pointerId === event.pointerId) finishRoomMove(true);
      if (wallResizeDrag?.pointerId === event.pointerId) finishWallResize(true);
      if (drawState?.pointerId === event.pointerId) cancelDrawing();
    };
    const handlePointerLeave = () => { if (!drawState && !cornerDrag && !radiusDrag && !roomMoveDrag && !wallResizeDrag) showHover(null); };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (cornerDrag) finishCornerDrag(true);
        else if (radiusDrag) finishRadiusDrag(true);
        else if (wallResizeDrag) finishWallResize(true);
        else if (roomMoveDrag) finishRoomMove(true);
        else if (drawState) cancelDrawing();
      }
    };
    const preventContextMenu = (event: MouseEvent) => event.preventDefault();
    runtime.setTool = (nextTool) => {
      cancelDrawing();
      if (cornerDrag) finishCornerDrag(true);
      if (radiusDrag) finishRadiusDrag(true);
      if (roomMoveDrag) finishRoomMove(true);
      if (wallResizeDrag) finishWallResize(true);
      setInteractionColor(nextTool === "erase" ? "erase" : "draw");
      hoverMesh.visible = false;
      runtime.render();
    };

    renderer.domElement.addEventListener("pointerdown", handlePointerDown);
    renderer.domElement.addEventListener("pointermove", handlePointerMove);
    renderer.domElement.addEventListener("pointerup", commitPointer);
    renderer.domElement.addEventListener("pointercancel", handlePointerCancel);
    renderer.domElement.addEventListener("pointerleave", handlePointerLeave);
    renderer.domElement.addEventListener("contextmenu", preventContextMenu);
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
    updateDynamicLighting(runtime, layoutRef.current, settingsRef.current);
    rebuildScene(runtime, layoutRef.current, settingsRef.current, selectedRoomRef.current, activeCornerRef.current);
    fitCamera(runtime, layoutRef.current);

    return () => {
      resizeObserver.disconnect();
      renderer.domElement.removeEventListener("pointerdown", handlePointerDown);
      renderer.domElement.removeEventListener("pointermove", handlePointerMove);
      renderer.domElement.removeEventListener("pointerup", commitPointer);
      renderer.domElement.removeEventListener("pointercancel", handlePointerCancel);
      renderer.domElement.removeEventListener("pointerleave", handlePointerLeave);
      renderer.domElement.removeEventListener("contextmenu", preventContextMenu);
      window.removeEventListener("keydown", handleKeyDown);
      controls.removeEventListener("change", runtime.render);
      controls.dispose();
      disposeGenerated(generated);
      cube.dispose();
      groundGeometry.dispose();
      groundMaterial.dispose();
      outlineGeometry.dispose();
      discGeometry.dispose();
      ringGeometry.dispose();
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
      updateDynamicLighting(runtime, layoutRef.current, settingsRef.current);
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
      updateDynamicLighting(runtime, layoutRef.current, settingsRef.current);
      runtime.render();
    }, (error) => {
      if (runtime.hdriLoadVersion === version) console.error("[lighting] failed to load HDRI", error);
    });
  }, [hdriUrl, hdriKind, cubeMapUrls]);

  useEffect(() => {
    layoutRef.current = layout;
    settingsRef.current = settings;
    selectedRoomRef.current = selectedRoomId;
    activeCornerRef.current = activeCorner;
    if (runtimeRef.current) {
      updateDynamicLighting(runtimeRef.current, layout, settings);
      rebuildScene(runtimeRef.current, layout, settings, selectedRoomId, activeCorner);
    }
  }, [layout, settings, selectedRoomId, activeCorner]);

  useEffect(() => {
    toolRef.current = tool;
    runtimeRef.current?.setTool(tool);
  }, [tool]);

  useEffect(() => { if (runtimeRef.current) fitCamera(runtimeRef.current, layoutRef.current); }, [fitSignal]);
  const setView = (top: boolean) => { if (runtimeRef.current) fitCamera(runtimeRef.current, layoutRef.current, top); };
  const toolLabel = tool === "erase"
    ? "Erase cells"
    : tool === "select"
      ? "Select room / corner"
      : tool === "circle"
        ? "Draw circular room"
        : "Draw cells";
  const leftHint = tool === "select"
    ? "move room / resize wall"
    : tool === "erase"
      ? "erase"
      : tool === "circle"
        ? "drag circle"
        : "draw";

  return (
    <div className={`three-viewport tool-${tool}`} ref={hostRef}>
      <div className="view-controls" aria-label="Three dimensional view controls">
        <button type="button" onClick={() => setView(false)} aria-label="Perspective view"><Icon name="cube" /></button>
        <button type="button" onClick={() => setView(true)} aria-label="Top view"><Icon name="top" /></button>
        <button type="button" onClick={() => setView(false)} aria-label="Fit three dimensional view"><Icon name="fit" /></button>
      </div>
      <div className={`active-tool-label ${tool}`}><i />{toolLabel}</div>
      <div ref={measureRef} className="draft-measure" hidden />
      <div className="orbit-hint">Left: {leftHint} · Middle: pan · Right: orbit · Wheel: zoom</div>
      {!layout.cells.length && !layout.roomGrounds.length && <div className="empty-3d"><Icon name="cube" /><span>Drag on the grid to draw your room</span></div>}
    </div>
  );
}
