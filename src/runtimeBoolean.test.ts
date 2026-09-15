import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { computeMeshVolume } from "three-bvh-csg";
import { APERTURE_BOUNDS, apertureKind, centerOpeningOnWall, cloneOpeningForWall, subtractOpening } from "./runtimeBoolean";

describe("runtime wall booleans", () => {
  it("shares one aperture shape across window frame variants", () => {
    expect(apertureKind("WD_1")).toBe("window");
    expect(apertureKind("WD_3")).toBe("window");
    expect(apertureKind("DR_2.5x1.5_1")).toBe("door-1.5");
    expect(apertureKind("DR_2.5x2_1")).toBeNull();
  });

  it("keeps the centering offset local when an opening rotates to another wall", () => {
    const source = new THREE.Group();
    const geometry = new THREE.BoxGeometry(1, 1, 0.4);
    geometry.translate(1.5, 1, -0.2);
    source.add(new THREE.Mesh(geometry, new THREE.MeshStandardMaterial()));
    const pivot = centerOpeningOnWall(source);
    pivot.position.set(8, 0, 4);
    pivot.rotation.y = Math.PI / 2;
    pivot.updateMatrixWorld(true);
    const center = new THREE.Box3().setFromObject(pivot).getCenter(new THREE.Vector3());
    expect(center.x).toBeCloseTo(7.8, 6); // authored depth centre rotates around the wall pivot
    expect(center.z).toBeCloseTo(4, 6); // horizontal centering does not remain stuck in world X
  });

  it("centres the visible opening depth only for a shared wall", () => {
    const source = new THREE.Group();
    const geometry = new THREE.BoxGeometry(1, 1, 0.4);
    geometry.translate(1, 1, -0.3);
    source.add(new THREE.Mesh(geometry, new THREE.MeshStandardMaterial()));
    const template = centerOpeningOnWall(source);
    const exterior = cloneOpeningForWall(template, false);
    const shared = cloneOpeningForWall(template, true);
    exterior.updateMatrixWorld(true);
    shared.updateMatrixWorld(true);
    expect(new THREE.Box3().setFromObject(exterior).getCenter(new THREE.Vector3()).z).toBeCloseTo(-0.3, 6);
    expect(new THREE.Box3().setFromObject(shared).getCenter(new THREE.Vector3()).z).toBeCloseTo(0, 6);
  });

  it("subtracts a window volume from a watertight wall", () => {
    const template = new THREE.Group();
    const material = new THREE.MeshStandardMaterial();
    const geometry = new THREE.BoxGeometry(2, 2.5, 0.3);
    geometry.translate(1, 1.25, 0);
    template.add(new THREE.Mesh(geometry, material));
    const result = subtractOpening(template, "window");
    const mesh = result.children[0] as THREE.Mesh;
    const cut = APERTURE_BOUNDS.window;
    const removed = (cut.maxX - cut.minX) * (2.5 - cut.minY) * 0.3;
    const positions = mesh.geometry.attributes.position;
    const apertureMinX = 1 - (cut.maxX - cut.minX) / 2;
    const apertureMaxX = 1 + (cut.maxX - cut.minX) / 2;
    expect(computeMeshVolume(mesh)).toBeLessThan(2 * 2.5 * 0.3 - removed + 1e-4);
    expect(positions.count).toBeGreaterThan(geometry.attributes.position.count);
    expect(Array.from({ length: positions.count }, (_, index) => positions.getX(index))
      .some((x) => Math.abs(x - apertureMinX) < 1e-5)).toBe(true);
    expect(Array.from({ length: positions.count }, (_, index) => positions.getX(index))
      .some((x) => Math.abs(x - apertureMaxX) < 1e-5)).toBe(true);
  });
});
