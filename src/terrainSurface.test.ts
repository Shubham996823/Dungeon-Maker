import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { createTerrainHeightSampler, PAINT_RESOLUTION, prepareTerrainRegion, TerrainPaintMask, TerrainSurface } from "./terrainSurface";
import type { BuildSettings, GeneratedLayout, TerrainRegion } from "./types";

const stroke = (id: string, x: number, texture: TerrainRegion["texture"] = "grass"): TerrainRegion => ({ id, controlPoints: [{ x, y: 4 }], texture, brush: { radius: 2, intensity: 0.5, falloff: 1 }, height: 0, mode: "raise", edgeProfile: "smooth", slopeWidth: 1 });
const settings = { terrainEnabled: true, terrainTexture: "ground-rocks", terrainMeshResolution: 10 } as BuildSettings;
const layout = { bounds: { minX: 0, minY: 0, maxX: 8, maxY: 8 } } as GeneratedLayout;
const textures = { grass: null, "ground-rocks": null, "cliff-rocks": null };

describe("terrain chunks and masks", () => {
  it("covers underground rooms at surface levels and restores their cutaway below zero", () => {
    const surface = new TerrainSurface(new THREE.PerspectiveCamera());
    const ground = { roomId: "basement", outer: [{x:2,y:2},{x:6,y:2},{x:6,y:6},{x:2,y:6}], holes: [], elevation: -2.5 };
    const world = {...layout,roomHitAreas:[ground]};
    const hill:TerrainRegion={id:"hill",controlPoints:[{x:-8,y:-8},{x:16,y:-8},{x:16,y:16},{x:-8,y:16}],mode:"raise",height:3,edgeProfile:"cliff",slopeWidth:1};
    const height=()=>{
      surface.group.updateMatrixWorld(true);
      return new THREE.Raycaster(new THREE.Vector3(4,20,-4),new THREE.Vector3(0,-1,0)).intersectObjects(surface.group.children)[0].point.y;
    };
    for(const regions of [[],[hill]]) {
      const expected=regions.length?2.84:-0.16;
      for(const level of [0,-2.5,2.5,-2.5,0]) {
        surface.update(world,[],regions,settings,textures,level);
        expect(height()).toBeCloseTo(level<0?-2.66:expected);
      }
    }
    expect(ground.elevation).toBe(-2.5);expect(hill.height).toBe(3);
    surface.dispose();
  });
  it("does not generate foundation panels around room footprints", () => {
    const surface = new TerrainSurface(new THREE.PerspectiveCamera());
    const ground = { roomId: "base", outer: [{ x: 2, y: 2 }, { x: 6, y: 2 }, { x: 6, y: 6 }, { x: 2, y: 6 }], holes: [], elevation: 0 };
    surface.update({ ...layout, roomHitAreas: [ground], foundationGrounds: [ground] }, [], [], settings, textures);
    expect(surface.group.children.length).toBeGreaterThan(0);
    expect(surface.group.children.every((child) => child.userData.terrain === true)).toBe(true);
    surface.dispose();
  });
  it("preserves lower-room cutouts when upper rooms are removed", () => {
    const surface = new TerrainSurface(new THREE.PerspectiveCamera());
    const ground = { roomId: "ground", outer: [{ x: 2, y: 2 }, { x: 6, y: 2 }, { x: 6, y: 6 }, { x: 2, y: 6 }], holes: [], elevation: 0 };
    const upper = { ...ground, roomId: "upper", elevation: 2.5 };
    const hill: TerrainRegion = { id: "hill", controlPoints: [{ x: -8, y: -8 }, { x: 16, y: -8 }, { x: 16, y: 16 }, { x: -8, y: 16 }], mode: "raise", height: 4, edgeProfile: "cliff", slopeWidth: 1 };
    const height = () => {
      surface.group.updateMatrixWorld(true);
      const ray = new THREE.Raycaster(new THREE.Vector3(4, 20, -4), new THREE.Vector3(0, -1, 0));
      return ray.intersectObjects(surface.group.children.filter((child) => child.userData.terrain))[0].point.y;
    };
    for (const grounds of [[ground, upper], [upper, ground], [ground]]) {
      surface.update({ ...layout, roomHitAreas: grounds }, [], [hill], settings, textures);
      expect(height()).toBeCloseTo(-0.16);
    }
    surface.update({ ...layout, roomHitAreas: [] }, [], [hill], settings, textures);
    expect(height()).toBeCloseTo(3.84);
    surface.dispose();
  });
  it("matches a fresh replay after append, live stroke extension, undo and redo", () => {
    const mask = new TerrainPaintMask(0, 0);
    const a = stroke("a", 4), b = stroke("b", 5, "cliff-rocks");
    const histories = [[a], [a, b], [a, { ...b, controlPoints: [...b.controlPoints, { x: 7, y: 4 }] }], [a], [a, b], []];
    for (const regions of histories) {
      const prepared = regions.map(prepareTerrainRegion);
      mask.update(prepared, 1);
      const fresh = new TerrainPaintMask(0, 0); fresh.update(prepared, 1);
      expect(mask.data).toEqual(fresh.data);
      expect(mask.update(prepared, 1)).toBe(false);
    }
  });
  it("uses matching border texels on neighboring chunks", () => {
    const paint = prepareTerrainRegion(stroke("seam", 8));
    const a = new TerrainPaintMask(0, 0), b = new TerrainPaintMask(8, 0);
    a.update([paint], 1); b.update([paint], 1);
    const size = PAINT_RESOLUTION + 2;
    for (let y = 0; y < size; y++) for (let c = 0; c < 4; c++) {
      expect(a.data[(y * size + PAINT_RESOLUTION) * 4 + c]).toBe(b.data[(y * size) * 4 + c]);
      expect(a.data[(y * size + PAINT_RESOLUTION + 1) * 4 + c]).toBe(b.data[(y * size + 1) * 4 + c]);
    }
  });
  it("samples spline detail inside a single coarse grid cell and honors heights over 4 m", () => {
    const region: TerrainRegion = { id: "hill", controlPoints: [{ x: 0, y: 0 }, { x: 8, y: 0 }, { x: 8, y: 8 }, { x: 0, y: 8 }], mode: "raise", height: 8, edgeProfile: "smooth", slopeWidth: 2 };
    const height = createTerrainHeightSampler([], [prepareTerrainRegion(region)]);
    expect(height(4, 4)).toBeCloseTo(7.84);
    expect(height(0.3, 4)).not.toBeCloseTo(height(0.7, 4));
    expect(height(20, 20)).toBeCloseTo(-0.16);
  });
  it("keeps geometry and materials when painting and reduces geometry at distance", () => {
    const camera = new THREE.PerspectiveCamera(); camera.position.set(0, 10, 0);
    const surface = new TerrainSurface(camera);
    surface.update(layout, [], [], settings, textures);
    const mesh = surface.group.children.find((child) => child.userData.terrain) as THREE.Mesh;
    const geometry = mesh.geometry, material = mesh.material;
    const count = geometry.attributes.position.count;
    const builds = surface.stats.geometryBuilds, uploads = surface.stats.maskUploads;
    surface.update(layout, [], [stroke("paint", 4)], settings, textures);
    expect(mesh.geometry).toBe(geometry); expect(mesh.material).toBe(material);
    expect(surface.stats.geometryBuilds).toBe(builds);
    expect(surface.stats.maskUploads - uploads).toBe(1);
    camera.position.set(0, 200, 0); surface.updateLOD();
    expect(mesh.geometry.attributes.position.count).toBeLessThan(count);
    surface.dispose(); expect(surface.group.children).toHaveLength(0);
  });
});
