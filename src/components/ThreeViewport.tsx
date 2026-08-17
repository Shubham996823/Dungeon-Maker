import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { CELL_SIZE, CORNER_ARM, WALL_HEIGHT, WALL_THICKNESS, cellKey } from "../layout";
import { cellCenterToWorld, planYToWorldZ, worldPointToCell } from "../coordinates";
import type { BuildSettings, Cell, CornerKind, EditorTool, GeneratedLayout, Variant } from "../types";
import { Icon } from "../icons";

interface ThreeViewportProps {
  layout: GeneratedLayout;
  settings: BuildSettings;
  fitSignal: number;
  tool: EditorTool;
  onCommit: (cells: Cell[]) => void;
  onNotice: (message: string) => void;
}

interface SceneRuntime {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  controls: OrbitControls;
  generated: THREE.Group;
  cube: THREE.BoxGeometry;
  materials: {
    floors: Record<Variant, THREE.MeshStandardMaterial>;
    walls: Record<Variant, THREE.MeshStandardMaterial>;
    corners: Record<Variant, THREE.MeshStandardMaterial>;
    pillars: Record<Variant, THREE.MeshStandardMaterial>;
    trim: THREE.MeshStandardMaterial;
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
  operation: "draw" | "erase";
}

const MAX_CELLS = 10_000;

const CORNER_DIRECTIONS: Record<CornerKind, number[]> = {
  SW: [0, Math.PI / 2],
  SE: [Math.PI, Math.PI / 2],
  NE: [Math.PI, (3 * Math.PI) / 2],
  NW: [0, (3 * Math.PI) / 2],
};

function makeMaterial(color: number, roughness = 0.72) {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness: 0.02 });
}

function addInstances(
  runtime: SceneRuntime,
  transforms: Transform[],
  material: THREE.Material,
  shadows = true,
) {
  if (!transforms.length) return;
  const mesh = new THREE.InstancedMesh(runtime.cube, material, transforms.length);
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const matrix = new THREE.Matrix4();
  for (let index = 0; index < transforms.length; index += 1) {
    const transform = transforms[index];
    position.set(transform.x, transform.y, transform.z);
    quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), transform.rotationY ?? 0);
    scale.set(transform.sx, transform.sy, transform.sz);
    matrix.compose(position, quaternion, scale);
    mesh.setMatrixAt(index, matrix);
  }
  mesh.instanceMatrix.needsUpdate = true;
  mesh.castShadow = shadows;
  mesh.receiveShadow = true;
  mesh.computeBoundingSphere();
  runtime.generated.add(mesh);
}

function wallTransform(x: number, planY: number, length: number, rotation: number, height = WALL_HEIGHT): Transform {
  return {
    x: x + Math.cos(rotation) * length / 2,
    y: height / 2,
    z: planYToWorldZ(planY + Math.sin(rotation) * length / 2),
    sx: length,
    sy: height,
    sz: WALL_THICKNESS,
    rotationY: rotation,
  };
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

function rebuildScene(runtime: SceneRuntime, layout: GeneratedLayout, settings: BuildSettings) {
  for (const child of runtime.generated.children) {
    if (child instanceof THREE.InstancedMesh) child.dispose();
  }
  runtime.generated.clear();

  const floorTransforms: Transform[] = layout.cells.map((cell) => {
    const center = cellCenterToWorld(cell);
    return {
      x: center.x,
      y: 0,
      z: center.z,
      sx: CELL_SIZE - 0.06,
      sy: 0.12,
      sz: CELL_SIZE - 0.06,
    };
  });
  const floorMaterial = runtime.materials.floors[settings.floorVariant];
  addInstances(runtime, floorTransforms, floorMaterial, false);

  for (const variant of ["A", "B", "C"] as Variant[]) {
    const transforms = layout.walls
      .filter((wall) => wall.variant === variant)
      .map((wall) => wallTransform(wall.x, wall.y, wall.length, wall.rotation));
    addInstances(runtime, transforms, runtime.materials.walls[variant]);
  }

  const trimTransforms = layout.walls.map((wall) => {
    const transform = wallTransform(wall.x, wall.y, wall.length, wall.rotation, 0.1);
    return { ...transform, y: WALL_HEIGHT - 0.05, sy: 0.1, sz: WALL_THICKNESS + 0.035 };
  });
  addInstances(runtime, trimTransforms, runtime.materials.trim, false);

  for (const variant of ["A", "B", "C"] as Variant[]) {
    const transforms: Transform[] = [];
    for (const corner of layout.corners.filter((item) => item.variant === variant)) {
      for (const direction of CORNER_DIRECTIONS[corner.kind]) {
        transforms.push(wallTransform(corner.x, corner.y, CORNER_ARM, direction));
      }
    }
    addInstances(runtime, transforms, runtime.materials.corners[variant]);
  }

  for (const variant of ["A", "B", "C"] as Variant[]) {
    const transforms = layout.pillars
      .filter((pillar) => pillar.variant === variant)
      .map((pillar) => {
        const width = pillar.junction ? 0.32 : variant === "B" ? 0.42 : variant === "C" ? 0.28 : 0.35;
        return {
          x: pillar.x,
          y: WALL_HEIGHT / 2,
          z: planYToWorldZ(pillar.y),
          sx: width,
          sy: WALL_HEIGHT + 0.05,
          sz: width,
        };
      });
    addInstances(runtime, transforms, runtime.materials.pillars[variant]);
  }

  runtime.render();
}

export function ThreeViewport({ layout, settings, fitSignal, tool, onCommit, onNotice }: ThreeViewportProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<SceneRuntime | null>(null);
  const layoutRef = useRef(layout);
  const settingsRef = useRef(settings);
  const toolRef = useRef(tool);
  const onCommitRef = useRef(onCommit);
  const onNoticeRef = useRef(onNotice);

  onCommitRef.current = onCommit;
  onNoticeRef.current = onNotice;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x131715);
    // Keep fog beyond the orbit limit so zooming out never fades the model to black.
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
    controls.enableRotate = true;
    controls.enablePan = true;
    controls.mouseButtons.LEFT = null;
    controls.mouseButtons.MIDDLE = THREE.MOUSE.PAN;
    controls.mouseButtons.RIGHT = THREE.MOUSE.ROTATE;
    controls.touches.ONE = null;
    controls.touches.TWO = THREE.TOUCH.DOLLY_PAN;

    const generated = new THREE.Group();
    scene.add(generated);
    const cube = new THREE.BoxGeometry(1, 1, 1);
    const materials = {
      floors: {
        A: makeMaterial(0xb9b2a5, 0.88),
        B: makeMaterial(0x8d9690, 0.82),
        C: makeMaterial(0xa56c56, 0.84),
      },
      walls: {
        A: makeMaterial(0xd9d3c7, 0.78),
        B: makeMaterial(0x87978a, 0.82),
        C: makeMaterial(0xb66c52, 0.8),
      },
      corners: {
        A: makeMaterial(0xcfc7b9, 0.76),
        B: makeMaterial(0x738379, 0.8),
        C: makeMaterial(0xa95e48, 0.78),
      },
      pillars: {
        A: makeMaterial(0x343a35, 0.66),
        B: makeMaterial(0x6f785f, 0.72),
        C: makeMaterial(0x9c503c, 0.74),
      },
      trim: makeMaterial(0x2d342f, 0.62),
    };
    const runtime: SceneRuntime = {
      scene,
      camera,
      renderer,
      controls,
      generated,
      cube,
      materials,
      render: () => renderer.render(scene, camera),
      setTool: () => undefined,
    };
    runtimeRef.current = runtime;

    const hemisphere = new THREE.HemisphereLight(0xf2eee4, 0x1a211d, 2.25);
    scene.add(hemisphere);
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
    const hoverMaterial = new THREE.MeshBasicMaterial({
      color: 0xcf5c3d,
      transparent: true,
      opacity: 0.24,
      depthTest: false,
      depthWrite: false,
    });
    const draftMaterial = new THREE.MeshBasicMaterial({
      color: 0xcf5c3d,
      transparent: true,
      opacity: 0.34,
      depthTest: false,
      depthWrite: false,
    });
    const outlineMaterial = new THREE.LineBasicMaterial({
      color: 0xf0a386,
      transparent: true,
      opacity: 0.95,
      depthTest: false,
    });
    const hoverMesh = new THREE.Mesh(cube, hoverMaterial);
    hoverMesh.scale.set(CELL_SIZE - 0.08, 0.035, CELL_SIZE - 0.08);
    hoverMesh.position.y = 0.11;
    hoverMesh.visible = false;
    hoverMesh.renderOrder = 20;
    interaction.add(hoverMesh);
    const draftMesh = new THREE.Mesh(cube, draftMaterial);
    draftMesh.visible = false;
    draftMesh.renderOrder = 21;
    interaction.add(draftMesh);
    const outlineGeometry = new THREE.EdgesGeometry(cube);
    const draftOutline = new THREE.LineSegments(outlineGeometry, outlineMaterial);
    draftOutline.visible = false;
    draftOutline.renderOrder = 22;
    interaction.add(draftOutline);

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const hit = new THREE.Vector3();
    const drawingPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    let drawState: DrawState | null = null;

    const pointerToCell = (event: PointerEvent): Cell | null => {
      const rect = renderer.domElement.getBoundingClientRect();
      if (!rect.width || !rect.height) return null;
      pointer.set(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(pointer, camera);
      if (!raycaster.ray.intersectPlane(drawingPlane, hit)) return null;
      return worldPointToCell(hit.x, hit.z);
    };

    const setInteractionColor = (operation: "draw" | "erase") => {
      const color = operation === "draw" ? 0xcf5c3d : 0xa2382c;
      const outline = operation === "draw" ? 0xf0a386 : 0xff8b7d;
      hoverMaterial.color.setHex(color);
      draftMaterial.color.setHex(color);
      outlineMaterial.color.setHex(outline);
    };

    const showHover = (cell: Cell | null) => {
      hoverMesh.visible = cell !== null && drawState === null;
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
      if (measureRef.current) measureRef.current.hidden = true;
    };

    const showDraft = (draft: DrawState) => {
      const minX = Math.min(draft.start.x, draft.current.x);
      const maxX = Math.max(draft.start.x, draft.current.x);
      const minY = Math.min(draft.start.y, draft.current.y);
      const maxY = Math.max(draft.start.y, draft.current.y);
      const widthCells = maxX - minX + 1;
      const depthCells = maxY - minY + 1;
      const centerX = (minX + (maxX + 1)) * CELL_SIZE / 2;
      const centerZ = planYToWorldZ((minY + (maxY + 1)) * CELL_SIZE / 2);
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

    const cancelDrawing = () => {
      if (drawState && renderer.domElement.hasPointerCapture(drawState.pointerId)) {
        renderer.domElement.releasePointerCapture(drawState.pointerId);
      }
      drawState = null;
      hideDraft();
      runtime.render();
    };

    const handlePointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      const cell = pointerToCell(event);
      if (!cell) return;
      const operation = toolRef.current === "erase" ? "erase" : "draw";
      setInteractionColor(operation);
      drawState = { pointerId: event.pointerId, start: cell, current: cell, operation };
      hoverMesh.visible = false;
      renderer.domElement.setPointerCapture(event.pointerId);
      showDraft(drawState);
      event.preventDefault();
    };

    const handlePointerMove = (event: PointerEvent) => {
      const cell = pointerToCell(event);
      if (drawState?.pointerId === event.pointerId) {
        if (cell) {
          drawState.current = cell;
          showDraft(drawState);
        }
        return;
      }
      setInteractionColor(toolRef.current === "erase" ? "erase" : "draw");
      showHover(cell);
    };

    const commitDrawing = (event: PointerEvent) => {
      const draft = drawState;
      if (!draft || draft.pointerId !== event.pointerId) return;
      drawState = null;
      hideDraft();
      if (renderer.domElement.hasPointerCapture(event.pointerId)) {
        renderer.domElement.releasePointerCapture(event.pointerId);
      }
      const minX = Math.min(draft.start.x, draft.current.x);
      const maxX = Math.max(draft.start.x, draft.current.x);
      const minY = Math.min(draft.start.y, draft.current.y);
      const maxY = Math.max(draft.start.y, draft.current.y);
      const result = new Map(layoutRef.current.cells.map((cell) => [cellKey(cell.x, cell.y), cell]));
      const area = (maxX - minX + 1) * (maxY - minY + 1);
      if (draft.operation === "draw" && area > MAX_CELLS) {
        onNoticeRef.current(`Plans are limited to ${MAX_CELLS.toLocaleString()} cells for browser performance.`);
        showHover(pointerToCell(event));
        return;
      }
      if (draft.operation === "erase") {
        for (const cell of result.values()) {
          if (cell.x >= minX && cell.x <= maxX && cell.y >= minY && cell.y <= maxY) {
            result.delete(cellKey(cell.x, cell.y));
          }
        }
      } else {
        for (let y = minY; y <= maxY; y += 1) {
          for (let x = minX; x <= maxX; x += 1) {
            result.set(cellKey(x, y), { x, y });
          }
        }
      }
      if (result.size > MAX_CELLS) {
        onNoticeRef.current(`Plans are limited to ${MAX_CELLS.toLocaleString()} cells for browser performance.`);
      } else {
        onCommitRef.current([...result.values()]);
      }
      showHover(pointerToCell(event));
      event.preventDefault();
    };

    const handlePointerCancel = (event: PointerEvent) => {
      if (drawState?.pointerId !== event.pointerId) return;
      cancelDrawing();
    };

    const handlePointerLeave = () => {
      if (!drawState) showHover(null);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && drawState) cancelDrawing();
    };

    const preventContextMenu = (event: MouseEvent) => event.preventDefault();
    runtime.setTool = (nextTool) => {
      cancelDrawing();
      setInteractionColor(nextTool === "erase" ? "erase" : "draw");
      runtime.render();
    };
    runtime.setTool(toolRef.current);
    renderer.domElement.addEventListener("pointerdown", handlePointerDown);
    renderer.domElement.addEventListener("pointermove", handlePointerMove);
    renderer.domElement.addEventListener("pointerup", commitDrawing);
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

    rebuildScene(runtime, layoutRef.current, settingsRef.current);
    fitCamera(runtime, layoutRef.current);

    return () => {
      resizeObserver.disconnect();
      renderer.domElement.removeEventListener("pointerdown", handlePointerDown);
      renderer.domElement.removeEventListener("pointermove", handlePointerMove);
      renderer.domElement.removeEventListener("pointerup", commitDrawing);
      renderer.domElement.removeEventListener("pointercancel", handlePointerCancel);
      renderer.domElement.removeEventListener("pointerleave", handlePointerLeave);
      renderer.domElement.removeEventListener("contextmenu", preventContextMenu);
      window.removeEventListener("keydown", handleKeyDown);
      controls.removeEventListener("change", runtime.render);
      controls.dispose();
      for (const child of generated.children) {
        if (child instanceof THREE.InstancedMesh) child.dispose();
      }
      cube.dispose();
      groundGeometry.dispose();
      groundMaterial.dispose();
      outlineGeometry.dispose();
      hoverMaterial.dispose();
      draftMaterial.dispose();
      outlineMaterial.dispose();
      Object.values(materials.floors).forEach((material) => material.dispose());
      Object.values(materials.walls).forEach((material) => material.dispose());
      Object.values(materials.corners).forEach((material) => material.dispose());
      Object.values(materials.pillars).forEach((material) => material.dispose());
      materials.trim.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      runtimeRef.current = null;
    };
  }, []);

  useEffect(() => {
    layoutRef.current = layout;
    settingsRef.current = settings;
    if (runtimeRef.current) rebuildScene(runtimeRef.current, layout, settings);
  }, [layout, settings]);

  useEffect(() => {
    toolRef.current = tool;
    const runtime = runtimeRef.current;
    if (!runtime) return;
    runtime.setTool(tool);
  }, [tool]);

  useEffect(() => {
    if (runtimeRef.current) fitCamera(runtimeRef.current, layoutRef.current);
  }, [fitSignal]);

  const setView = (top: boolean) => {
    if (runtimeRef.current) fitCamera(runtimeRef.current, layoutRef.current, top);
  };

  return (
    <div className={`three-viewport tool-${tool}`} ref={hostRef}>
      <div className="view-controls" aria-label="Three dimensional view controls">
        <button type="button" onClick={() => setView(false)} aria-label="Perspective view"><Icon name="cube" /></button>
        <button type="button" onClick={() => setView(true)} aria-label="Top view"><Icon name="top" /></button>
        <button type="button" onClick={() => setView(false)} aria-label="Fit three dimensional view"><Icon name="fit" /></button>
      </div>
      <div className={`active-tool-label ${tool}`}><i />{tool === "erase" ? "Erase cells" : "Draw cells"}</div>
      <div ref={measureRef} className="draft-measure" hidden />
      <div className="orbit-hint">Left: {tool === "erase" ? "erase" : "draw"} · Middle: pan · Right: orbit · Wheel: zoom</div>
      {!layout.cells.length && <div className="empty-3d"><Icon name="cube" /><span>Drag on the grid to draw your room</span></div>}
    </div>
  );
}
