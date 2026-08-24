import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
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
  WallSegment,
} from "../types";
import { Icon } from "../icons";

interface CornerIdentity { roomId: string; vertexX: number; vertexY: number; }

interface ThreeViewportProps {
  layout: GeneratedLayout;
  settings: BuildSettings;
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
  onNotice: (message: string) => void;
}

interface SceneRuntime {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  controls: OrbitControls;
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
    for (const handle of layout.cornerHandles.filter((candidate) => candidate.roomId === selectedRoomId)) {
      const active = activeCorner?.roomId === handle.roomId && activeCorner.vertexX === handle.vertexX && activeCorner.vertexY === handle.vertexY;
      const mesh = new THREE.Mesh(runtime.cube, active ? runtime.materials.handleActive : runtime.materials.handle);
      mesh.position.set(handle.vertexX * CELL_SIZE, 0.52, planYToWorldZ(handle.vertexY * CELL_SIZE));
      mesh.scale.setScalar(active ? 0.38 : 0.3);
      mesh.renderOrder = 30;
      mesh.userData.cornerHandle = handle;
      runtime.handles.add(mesh);
    }
    // Four grab points around the circumference; each resizes the radius identically.
    for (const handle of layout.radiusHandles.filter((candidate) => candidate.roomId === selectedRoomId)) {
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
  }
  runtime.render();
}

export function ThreeViewport({
  layout,
  settings,
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

  onCommitRef.current = onCommit;
  onNoticeRef.current = onNotice;
  onSelectRoomRef.current = onSelectRoom;
  onActiveCornerRef.current = onActiveCorner;
  onCornerEditRef.current = onCornerEdit;
  onCornerRemoveRef.current = onCornerRemove;
  onCircleResizeRef.current = onCircleResize;

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
    };
    const runtime: SceneRuntime = { scene, camera, renderer, controls, generated, handles, assets, cube, materials, render: () => renderer.render(scene, camera), setTool: () => undefined };
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

    scene.add(new THREE.HemisphereLight(0xf2eee4, 0x1a211d, 2.25));
    const keyLight = new THREE.DirectionalLight(0xfff3dc, 3.2);
    keyLight.position.set(18, 28, 14);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(1024, 1024);
    keyLight.shadow.camera.left = -45;
    keyLight.shadow.camera.right = 45;
    keyLight.shadow.camera.top = 45;
    keyLight.shadow.camera.bottom = -45;
    keyLight.shadow.bias = -0.0003;
    scene.add(keyLight);
    const rimLight = new THREE.DirectionalLight(0xb7c7b8, 1.2);
    rimLight.position.set(-20, 12, -24);
    scene.add(rimLight);

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
    const roomAtPoint = (point: PlanPoint) => layoutRef.current.roomGrounds.find(
      (groundShape) => pointInPolygon(point, groundShape.outer) && !groundShape.holes.some((hole) => pointInPolygon(point, hole)),
    )?.roomId ?? null;

    const handlePointerDown = (event: PointerEvent) => {
      if (event.button === 2 && (cornerDrag || radiusDrag)) {
        finishCornerDrag(true);
        finishRadiusDrag(true);
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
        const point = pointerToPlan(event);
        const roomId = point ? roomAtPoint(point) : null;
        onSelectRoomRef.current(roomId);
        onActiveCornerRef.current(null);
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
      if (drawState?.pointerId === event.pointerId) cancelDrawing();
    };
    const handlePointerLeave = () => { if (!drawState && !cornerDrag && !radiusDrag) showHover(null); };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (cornerDrag) finishCornerDrag(true);
        else if (radiusDrag) finishRadiusDrag(true);
        else if (drawState) cancelDrawing();
      }
    };
    const preventContextMenu = (event: MouseEvent) => event.preventDefault();
    runtime.setTool = (nextTool) => {
      cancelDrawing();
      if (cornerDrag) finishCornerDrag(true);
      if (radiusDrag) finishRadiusDrag(true);
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
      sharedTextures.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      runtimeRef.current = null;
    };
  }, []);

  useEffect(() => {
    layoutRef.current = layout;
    settingsRef.current = settings;
    selectedRoomRef.current = selectedRoomId;
    activeCornerRef.current = activeCorner;
    if (runtimeRef.current) rebuildScene(runtimeRef.current, layout, settings, selectedRoomId, activeCorner);
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
    ? "select / drag handle"
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
