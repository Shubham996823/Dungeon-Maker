import * as THREE from "three";
import { Brush, Evaluator, SUBTRACTION } from "three-bvh-csg";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import type { OpeningAsset } from "./types";

export type ApertureKind = "window" | "door-1.5";

interface ApertureBounds { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number; }

const MODULE_WIDTH = 2;

// Measured from the authored FBX helpers after Blender's axis conversion.
// Width and height come from the authored helpers. Horizontal placement is normalized
// to the exact centre of the selected 2 m module; vertical placement remains authored.
export const APERTURE_BOUNDS: Record<ApertureKind, ApertureBounds> = {
  window: { minX: 0.55175, maxX: 1.445713, minY: 1.438267, maxY: 2.638268, minZ: -0.705623, maxZ: 0.18834 },
  "door-1.5": { minX: 0.342418, maxX: 1.735853, minY: -0.102109, maxY: 2.671389, minZ: -1.1302, maxZ: 0.869801 },
};

export const apertureKind = (asset: OpeningAsset): ApertureKind | null => {
  if (asset.startsWith("WD_")) return "window";
  if (asset === "DR_2.5x1.5_1") return "door-1.5";
  return null;
};

/**
 * Put an authored opening under a wall-centre pivot. The child offset must remain local:
 * changing the model root's position directly would leave that offset in parent X, so it
 * would stop following the wall when the pivot rotates onto its left/right edges.
 */
export function centerOpeningOnWall(model: THREE.Group) {
  model.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(model);
  const pivot = new THREE.Group();
  pivot.name = `${model.name || "Opening"}_WallCentrePivot`;
  pivot.userData.openingDepthCenter = (bounds.min.z + bounds.max.z) / 2;
  pivot.add(model);
  model.position.x -= (bounds.min.x + bounds.max.x) / 2;
  pivot.updateMatrixWorld(true);
  return pivot;
}

/** Clone an opening and optionally centre its visible depth around a shared boundary. */
export function cloneOpeningForWall(template: THREE.Group, centerDepth: boolean) {
  const model = template.clone(true);
  if (!centerDepth) return model;
  const depthCenter = Number(template.userData.openingDepthCenter);
  if (!Number.isFinite(depthCenter) || Math.abs(depthCenter) < 1e-8) return model;
  const anchor = new THREE.Group();
  anchor.name = `${template.name || "Opening"}_SharedWallAnchor`;
  anchor.add(model);
  model.position.z -= depthCenter;
  anchor.updateMatrixWorld(true);
  return anchor;
}

interface BooleanResources {
  geometries: THREE.BufferGeometry[];
  materials: THREE.Material[];
}

const booleanResources = new WeakMap<THREE.Group, BooleanResources>();

function flattenTemplate(template: THREE.Group) {
  template.updateMatrixWorld(true);
  const inverseRoot = template.matrixWorld.clone().invert();
  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];
  template.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    if (Array.isArray(object.material) && object.material.length !== 1) {
      throw new Error("Multi-material wall meshes are not supported by the runtime Boolean yet");
    }
    const geometry = object.geometry.clone();
    geometry.applyMatrix4(inverseRoot.clone().multiply(object.matrixWorld));
    geometries.push(geometry);
    const source = Array.isArray(object.material) ? object.material[0] : object.material;
    // The Boolean template owns these material objects, while textures remain shared.
    materials.push(source.clone());
  });
  if (!geometries.length) throw new Error("Wall template has no mesh geometry");
  const geometry = mergeGeometries(geometries, true);
  geometries.forEach((item) => item.dispose());
  if (!geometry) {
    materials.forEach((material) => material.dispose());
    throw new Error("Wall meshes have incompatible vertex attributes");
  }
  return { geometry, materials };
}

/** Build a local-space wall once; callers cache the returned template. */
export function subtractOpening(template: THREE.Group, kind: ApertureKind) {
  const { geometry, materials } = flattenTemplate(template);
  geometry.computeVertexNormals();
  const bounds = geometry.boundingBox ?? (geometry.computeBoundingBox(), geometry.boundingBox!);
  const authored = APERTURE_BOUNDS[kind];
  const width = authored.maxX - authored.minX;
  const height = authored.maxY - authored.minY;
  // Ensure the helper passes through this wall even if a wall variant has
  // slightly deeper decoration than the cutter FBX.
  const depth = Math.max(authored.maxZ - authored.minZ, bounds.max.z - bounds.min.z + 0.04);
  const cutterGeometry = new THREE.BoxGeometry(width, height, depth);
  cutterGeometry.translate(
    MODULE_WIDTH / 2,
    (authored.minY + authored.maxY) / 2,
    (authored.minZ + authored.maxZ) / 2,
  );

  const wall = new Brush(geometry, materials);
  const cutMaterial = materials[0].clone();
  const cutter = new Brush(cutterGeometry, cutMaterial);
  wall.updateMatrixWorld(true);
  cutter.updateMatrixWorld(true);
  const evaluator = new Evaluator();
  evaluator.attributes = ["position", "normal", "uv"];
  evaluator.useGroups = true;
  const result = evaluator.evaluate(wall, cutter, SUBTRACTION);
  result.geometry.computeBoundingBox();
  result.geometry.computeBoundingSphere();
  result.castShadow = true;
  result.receiveShadow = true;
  const group = new THREE.Group();
  group.add(result);
  booleanResources.set(group, {
    geometries: [result.geometry],
    materials: [...materials, cutMaterial],
  });
  geometry.dispose();
  cutterGeometry.dispose();
  return group;
}

/** Release a cached Boolean template after all of its scene clones have been removed. */
export function disposeBooleanTemplate(template: THREE.Group) {
  const resources = booleanResources.get(template);
  if (!resources) return;
  resources.geometries.forEach((geometry) => geometry.dispose());
  resources.materials.forEach((material) => material.dispose());
  booleanResources.delete(template);
}
