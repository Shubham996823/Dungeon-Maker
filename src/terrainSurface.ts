import * as THREE from "three";
import { CELL_SIZE } from "./layout";
import { protectRoomTerrain } from "./terrainProtection";
import { pointInPolygon, sampleClosedTerrainSpline, terrainPaintInfluence } from "./terrain";
import type { BuildSettings, GeneratedLayout, PlanPoint, TerrainCell, TerrainRegion, TerrainTextureVariant } from "./types";

export const TERRAIN_CHUNK_SIZE = 8;
export const PAINT_RESOLUTION = 64;
const variants: TerrainTextureVariant[] = ["grass", "ground-rocks", "cliff-rocks"];
type Bounds = { minX: number; minY: number; maxX: number; maxY: number };
type TextureSet = { color: THREE.Texture; normal: THREE.Texture; height: THREE.Texture };
type Prepared = { region: TerrainRegion; polygon: PlanPoint[]; bounds: Bounds; signature: string };
const overlap = (a: Bounds, b: Bounds) => a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;

export function prepareTerrainRegion(region: TerrainRegion): Prepared {
  const polygon = region.brush ? region.controlPoints : sampleClosedTerrainSpline(region.controlPoints);
  const radius = region.brush?.radius ?? 0;
  const bounds = polygon.reduce((b, p) => ({ minX: Math.min(b.minX, p.x - radius), minY: Math.min(b.minY, p.y - radius), maxX: Math.max(b.maxX, p.x + radius), maxY: Math.max(b.maxY, p.y + radius) }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
  return { region, polygon, bounds, signature: JSON.stringify(region) };
}

/** Sample authored splines directly; subdivision now adds actual silhouette detail. */
export function createTerrainHeightSampler(cells: TerrainCell[], regions: Prepared[]) {
  const heights = new Map(cells.map((c) => [`${c.x},${c.y}`, c.height]));
  const at = (x: number, y: number) => heights.get(`${x},${y}`) ?? 0;
  return (x: number, y: number) => {
    const gx = x / CELL_SIZE - 0.5, gy = y / CELL_SIZE - 0.5;
    const ix = Math.floor(gx), iy = Math.floor(gy);
    let height = THREE.MathUtils.lerp(THREE.MathUtils.lerp(at(ix, iy), at(ix + 1, iy), gx - ix), THREE.MathUtils.lerp(at(ix, iy + 1), at(ix + 1, iy + 1), gx - ix), gy - iy);
    for (const { region, polygon, bounds } of regions) {
      if (region.texture || x < bounds.minX || x > bounds.maxX || y < bounds.minY || y > bounds.maxY || !pointInPolygon({ x, y }, polygon)) continue;
      let distance = Infinity;
      for (let i = 0; i < polygon.length; i++) {
        const a = polygon[i], b = polygon[(i + 1) % polygon.length];
        const dx = b.x - a.x, dy = b.y - a.y;
        const t = THREE.MathUtils.clamp(((x - a.x) * dx + (y - a.y) * dy) / Math.max(1e-12, dx * dx + dy * dy), 0, 1);
        distance = Math.min(distance, Math.hypot(x - a.x - t * dx, y - a.y - t * dy));
      }
      const t = Math.min(1, distance / Math.max(0.001, region.slopeWidth * CELL_SIZE));
      const weight = region.edgeProfile === "cliff" ? 1 : t * t * (3 - 2 * t);
      height = region.mode === "flatten" ? height * (1 - weight) : height + region.height * weight;
      height = THREE.MathUtils.clamp(height, -20, 20);
    }
    return height - 0.16;
  };
}

/** A persistent mask per chunk; append-only strokes do not replay older history. */
export class TerrainPaintMask {
  readonly data = new Uint8Array((PAINT_RESOLUTION + 2) ** 2 * 4);
  private signatures: string[] = [];
  private beforeLast = this.data.slice();
  private coverage = new Float32Array((PAINT_RESOLUTION + 2) ** 2);
  private lastPaint?: Prepared;
  private base = -1;
  constructor(readonly x: number, readonly y: number) {}
  update(paints: Prepared[], base: number) {
    if (base === this.base && paints.length === this.signatures.length && paints.every((p, i) => p.signature === this.signatures[i])) return false;
    const last = paints[paints.length - 1], previous = this.lastPaint;
    if (base === this.base && last?.region.brush && previous?.region.brush && paints.length === this.signatures.length
      && paints.slice(0, -1).every((p, i) => p.signature === this.signatures[i])
      && last.region.id === previous.region.id && last.region.texture === previous.region.texture
      && JSON.stringify(last.region.brush) === JSON.stringify(previous.region.brush)
      && last.region.controlPoints.length >= previous.region.controlPoints.length
      && previous.region.controlPoints.every((point, i) => point.x === last.region.controlPoints[i].x && point.y === last.region.controlPoints[i].y)) {
      const tail = prepareTerrainRegion({ ...last.region, controlPoints: last.region.controlPoints.slice(Math.max(0, previous.region.controlPoints.length - 1)) });
      const changed = this.extendLastStroke(tail);
      this.signatures = paints.map((p) => p.signature); this.lastPaint = last;
      return changed;
    }
    let start = 0;
    if (base === this.base && paints.length >= this.signatures.length && this.signatures.every((s, i) => paints[i]?.signature === s)) start = this.signatures.length;
    else if (base === this.base && paints.length === this.signatures.length && paints.slice(0, -1).every((p, i) => p.signature === this.signatures[i])) {
      this.data.set(this.beforeLast); start = Math.max(0, paints.length - 1);
    } else {
      this.data.fill(0);
      for (let i = 0; i < this.data.length; i += 4) { this.data[i + base] = 255; this.data[i + 3] = 255; }
    }
    const size = PAINT_RESOLUTION + 2, step = TERRAIN_CHUNK_SIZE / PAINT_RESOLUTION;
    for (let p = start; p < paints.length; p++) {
      if (p === paints.length - 1) { this.beforeLast = this.data.slice(); this.coverage.fill(0); }
      const { region, polygon, bounds } = paints[p];
      const target = variants.indexOf(region.texture!);
      const minX = Math.max(0, Math.floor((bounds.minX - this.x) / step));
      const maxX = Math.min(size - 1, Math.ceil((bounds.maxX - this.x) / step) + 1);
      const minY = Math.max(0, Math.floor((bounds.minY - this.y) / step));
      const maxY = Math.min(size - 1, Math.ceil((bounds.maxY - this.y) / step) + 1);
      for (let row = minY; row <= maxY; row++) for (let col = minX; col <= maxX; col++) {
        const point = { x: this.x + (col - 0.5) * step, y: this.y + (row - 0.5) * step };
        const alpha = region.brush ? terrainPaintInfluence(point, region) : pointInPolygon(point, polygon) ? 1 : 0;
        if (!alpha) continue;
        const index = (row * size + col) * 4;
        if (p === paints.length - 1) this.coverage[index / 4] = alpha;
        for (let k = 0; k < 3; k++) this.data[index + k] = Math.round(this.data[index + k] * (1 - alpha) + (k === target ? 255 * alpha : 0));
      }
    }
    this.base = base; this.signatures = paints.map((p) => p.signature); this.lastPaint = last;
    return true;
  }
  private extendLastStroke(paint: Prepared) {
    const size = PAINT_RESOLUTION + 2, step = TERRAIN_CHUNK_SIZE / PAINT_RESOLUTION;
    const { bounds, region } = paint, target = variants.indexOf(region.texture!);
    let changed = false;
    for (let row = Math.max(0, Math.floor((bounds.minY - this.y) / step)); row <= Math.min(size - 1, Math.ceil((bounds.maxY - this.y) / step) + 1); row++) {
      for (let col = Math.max(0, Math.floor((bounds.minX - this.x) / step)); col <= Math.min(size - 1, Math.ceil((bounds.maxX - this.x) / step) + 1); col++) {
        const pixel = row * size + col;
        const alpha = terrainPaintInfluence({ x: this.x + (col - 0.5) * step, y: this.y + (row - 0.5) * step }, region);
        if (alpha <= this.coverage[pixel]) continue;
        this.coverage[pixel] = alpha;
        for (let k = 0; k < 3; k++) {
          const index = pixel * 4 + k, value = Math.round(this.beforeLast[index] * (1 - alpha) + (k === target ? 255 * alpha : 0));
          if (this.data[index] !== value) changed = true;
          this.data[index] = value;
        }
      }
    }
    return changed;
  }
}

type Chunk = { mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>; mask: TerrainPaintMask; texture: THREE.DataTexture; bounds: Bounds; shapeKey: string; segments: number; lod: number; sample: (x: number, y: number) => number };

export class TerrainSurface {
  readonly group = new THREE.Group();
  readonly stats = { geometryBuilds: 0, maskUploads: 0 };
  private chunks = new Map<string, Chunk>();
  private resolution = 4;
  private textureKey = "";
  private cellsKey = "";
  private preparedCache = new WeakMap<TerrainRegion, Prepared>();
  private cameraPosition = new THREE.Vector3(Infinity, Infinity, Infinity);
  private textures: Record<TerrainTextureVariant, TextureSet | null> = { grass: null, "ground-rocks": null, "cliff-rocks": null };
  constructor(private camera: THREE.PerspectiveCamera) { this.group.name = "terrain"; }
  update(layout: GeneratedLayout, cells: TerrainCell[], regions: TerrainRegion[], settings: BuildSettings, textures: Record<TerrainTextureVariant, TextureSet | null>, viewElevation = 0) {
    this.group.visible = settings.terrainEnabled !== false;
    if (!this.group.visible) return;
    const prepared = regions.map((region) => {
      let value = this.preparedCache.get(region);
      if (!value) { value = prepareTerrainRegion(region); this.preparedCache.set(region, value); }
      return value;
    });
    const sculpt = prepared.filter((p) => !p.region.texture), paints = prepared.filter((p) => p.region.texture);
    // Underground excavation is an editing cutaway, not a permanent hole in the surface.
    const protectedGrounds = (layout.roomHitAreas ?? layout.roomGrounds ?? []).filter(ground => (ground.elevation ?? 0) >= -1e-5 || viewElevation < -1e-5).map((ground) => ({ ground, bounds: ground.outer.reduce((b, p) => ({ minX: Math.min(b.minX, p.x - 1), minY: Math.min(b.minY, p.y - 1), maxX: Math.max(b.maxX, p.x + 1), maxY: Math.max(b.maxY, p.y + 1) }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }) }));
    const nextCellsKey = JSON.stringify(cells), cellsChanged = this.cellsKey !== nextCellsKey;
    this.cellsKey = nextCellsKey;
    this.resolution = Math.max(1, Math.min(10, settings.terrainMeshResolution ?? 4));
    this.textures = textures;
    const textureKey = variants.map((v) => textures[v]?.color.uuid ?? "").join();
    const texturesChanged = textureKey !== this.textureKey; this.textureKey = textureKey;
    const base = Math.max(0, variants.indexOf(settings.terrainTexture ?? "grass"));
    // Allocate occupied chunks only, rather than a rectangle spanning distant edits.
    const wanted = new Map<string, Bounds>();
    const include = (b: Bounds) => {
      for (let y = Math.floor(b.minY / 8); y <= Math.floor(b.maxY / 8); y++) for (let x = Math.floor(b.minX / 8); x <= Math.floor(b.maxX / 8); x++) wanted.set(`${x},${y}`, { minX: x * 8, minY: y * 8, maxX: x * 8 + 8, maxY: y * 8 + 8 });
    };
    include({ minX: Math.min(0, layout.bounds.minX) - 8, minY: Math.min(0, layout.bounds.minY) - 8, maxX: Math.max(0, layout.bounds.maxX) + 8, maxY: Math.max(0, layout.bounds.maxY) + 8 });
    for (const c of cells) include({ minX: c.x * CELL_SIZE - 2, minY: c.y * CELL_SIZE - 2, maxX: (c.x + 1) * CELL_SIZE + 2, maxY: (c.y + 1) * CELL_SIZE + 2 });
    for (const p of prepared) {
      if (p.region.brush) {
        const points = p.region.controlPoints, radius = p.region.brush.radius + 2;
        for (let i = 0; i < points.length; i++) {
          const a = points[Math.max(0, i - 1)], b = points[i];
          const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 4));
          for (let j = 0; j <= steps; j++) {
            const x = THREE.MathUtils.lerp(a.x, b.x, j / steps), y = THREE.MathUtils.lerp(a.y, b.y, j / steps);
            include({ minX: x - radius, minY: y - radius, maxX: x + radius, maxY: y + radius });
          }
        }
      } else include({ minX: p.bounds.minX - 2, minY: p.bounds.minY - 2, maxX: p.bounds.maxX + 2, maxY: p.bounds.maxY + 2 });
    }
    for (const [key, chunk] of this.chunks) if (!wanted.has(key)) { this.destroy(chunk); this.chunks.delete(key); }
    for (const [key, bounds] of wanted) {
      let chunk = this.chunks.get(key);
      if (!chunk) {
        const mask = new TerrainPaintMask(bounds.minX, bounds.minY);
        const texture = new THREE.DataTexture(mask.data, PAINT_RESOLUTION + 2, PAINT_RESOLUTION + 2);
        texture.magFilter = texture.minFilter = THREE.LinearFilter;
        texture.generateMipmaps = false;
        const mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial());
        mesh.userData.terrain = true; mesh.receiveShadow = true;
        chunk = { mesh, mask, texture, bounds, shapeKey: "", segments: 0, lod: -1, sample: () => -0.16 };
        this.chunks.set(key, chunk); this.group.add(mesh);
        mesh.material.dispose(); mesh.material = this.material(chunk);
      } else if (texturesChanged) { chunk.mesh.material.dispose(); chunk.mesh.material = this.material(chunk); }
      const nearby = sculpt.filter((p) => overlap(p.bounds, { minX: bounds.minX - 0.1, minY: bounds.minY - 0.1, maxX: bounds.maxX + 0.1, maxY: bounds.maxY + 0.1 }));
      const localGrounds = protectedGrounds.filter((p) => overlap(p.bounds, bounds)).map((p) => p.ground);
      const shapeKey = nearby.map((p) => p.signature).join("|") + JSON.stringify(localGrounds);
      if (cellsChanged || chunk.shapeKey !== shapeKey || !chunk.segments) {
        const sample = createTerrainHeightSampler(cells, nearby);
        chunk.sample = (x, y) => protectRoomTerrain(sample(x, y), { x, y }, localGrounds); chunk.shapeKey = shapeKey; chunk.segments = 0;
      }
      const maskBounds = { minX: bounds.minX - 0.125, minY: bounds.minY - 0.125, maxX: bounds.maxX + 0.125, maxY: bounds.maxY + 0.125 };
      if (chunk.mask.update(paints.filter((p) => overlap(p.bounds, maskBounds)), base)) { chunk.texture.needsUpdate = true; this.stats.maskUploads++; }
    }
    this.updateLOD(true);
  }
  updateLOD(force = false) {
    if (!this.group.visible || (!force && this.cameraPosition.distanceToSquared(this.camera.position) < 4)) return;
    this.cameraPosition.copy(this.camera.position);
    for (const chunk of this.chunks.values()) {
      const b = chunk.bounds;
      const distance = this.camera.position.distanceTo(new THREE.Vector3((b.minX + b.maxX) / 2, chunk.sample((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2), -(b.minY + b.maxY) / 2));
      let lod = chunk.lod < 0 ? (distance > 120 ? 2 : distance > 60 ? 1 : 0) : chunk.lod;
      if (lod === 0 && distance > 70) lod = 1;
      if (lod === 1 && distance > 140) lod = 2;
      if (lod === 2 && distance < 110) lod = 1;
      if (lod === 1 && distance < 50) lod = 0;
      chunk.lod = lod;
      const segments = Math.max(4, Math.round(4 * this.resolution / 2 ** lod));
      if (chunk.segments === segments) continue;
      chunk.mesh.geometry.dispose(); chunk.mesh.geometry = this.geometry(chunk, segments); chunk.segments = segments; this.stats.geometryBuilds++;
    }
  }
  private geometry(chunk: Chunk, n: number) {
    const vertices: number[] = [], normals: number[] = [], indices: number[] = [];
    const { minX, minY } = chunk.bounds, sample = chunk.sample;
    const add = (x: number, y: number, drop = 0) => {
      vertices.push(x, sample(x, y) - drop, -y);
      const e = 0.05, normal = new THREE.Vector3(sample(x - e, y) - sample(x + e, y), 2 * e, sample(x, y + e) - sample(x, y - e)).normalize();
      normals.push(normal.x, normal.y, normal.z);
    };
    for (let y = 0; y <= n; y++) for (let x = 0; x <= n; x++) add(minX + x * 8 / n, minY + y * 8 / n);
    let minimum = Infinity, maximum = -Infinity;
    for (let i = 1; i < vertices.length; i += 3) { minimum = Math.min(minimum, vertices[i]); maximum = Math.max(maximum, vertices[i]); }
    const skirtDepth = Math.max(2, maximum - minimum + 0.5);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const a = y * (n + 1) + x, b = a + 1, c = a + n + 1, d = c + 1;
      indices.push(a, b, c, b, d, c);
    }
    // Skirts cover T-junctions between adjacent detail levels.
    const perimeter: number[] = [];
    for (let x = 0; x < n; x++) perimeter.push(x);
    for (let y = 0; y < n; y++) perimeter.push(y * (n + 1) + n);
    for (let x = n; x > 0; x--) perimeter.push(n * (n + 1) + x);
    for (let y = n; y > 0; y--) perimeter.push(y * (n + 1));
    for (let i = 0; i < perimeter.length; i++) {
      const a = perimeter[i], b = perimeter[(i + 1) % perimeter.length], c = vertices.length / 3;
      add(vertices[a * 3], -vertices[a * 3 + 2], skirtDepth); add(vertices[b * 3], -vertices[b * 3 + 2], skirtDepth);
      indices.push(a, c, b, b, c, c + 1);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
    geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
    geometry.setIndex(indices); geometry.computeBoundingSphere(); geometry.computeBoundingBox();
    return geometry;
  }
  private material(chunk: Chunk) {
    const material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, side: THREE.DoubleSide });
    if (!variants.every((v) => this.textures[v])) { material.color.setHex(0x66745a); return material; }
    material.onBeforeCompile = (shader) => {
      shader.uniforms.paintMask = { value: chunk.texture };
      shader.uniforms.maskOrigin = { value: new THREE.Vector2(chunk.bounds.minX, chunk.bounds.minY) };
      variants.forEach((v, i) => {
        shader.uniforms[`color${i}`] = { value: this.textures[v]!.color };
        shader.uniforms[`normal${i}`] = { value: this.textures[v]!.normal };
        shader.uniforms[`height${i}`] = { value: this.textures[v]!.height };
      });
      shader.vertexShader = "varying vec3 terrainPosition; varying vec3 terrainNormal;\n" + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace("#include <begin_vertex>", "#include <begin_vertex>\nterrainPosition = position; terrainNormal = normal;");
      shader.fragmentShader = `varying vec3 terrainPosition; varying vec3 terrainNormal;
        uniform sampler2D paintMask; uniform vec2 maskOrigin;
        uniform sampler2D color0; uniform sampler2D color1; uniform sampler2D color2;
        uniform sampler2D normal0; uniform sampler2D normal1; uniform sampler2D normal2;
        uniform sampler2D height0; uniform sampler2D height1; uniform sampler2D height2;
        vec3 surfaceNormal() {
          vec3 n=normalize(cross(dFdx(terrainPosition),dFdy(terrainPosition)));
          if(dot(n,terrainNormal)<0.) n=-n;
          return abs(n.y)<0.7 ? n : normalize(terrainNormal);
        }
        vec3 triWeights() { vec3 w = pow(abs(surfaceNormal()), vec3(4.)); return w / max(dot(w,vec3(1.)),0.001); }
        vec4 triSample(sampler2D tex) { vec3 p=terrainPosition/4.; vec3 w=triWeights(); return texture2D(tex,p.zy)*w.x + texture2D(tex,p.xz)*w.y + texture2D(tex,p.xy)*w.z; }
        vec3 triNormal(sampler2D tex) {
          vec3 w=triWeights(), p=terrainPosition/4.;
          vec3 a=texture2D(tex,p.zy).xyz*2.-1., b=texture2D(tex,p.xz).xyz*2.-1., c=texture2D(tex,p.xy).xyz*2.-1.;
          // Project tangent perturbations onto the three world-aligned planes.
          return normalize(surfaceNormal() + (vec3(0.,a.y,a.x)*w.x + vec3(b.x,0.,b.y)*w.y + vec3(c.x,c.y,0.)*w.z)*0.75);
        }
        ` + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace("#include <map_fragment>", `
        vec2 maskUV=((vec2(terrainPosition.x,-terrainPosition.z)-maskOrigin)/8.*64.+1.)/66.;
        vec3 blend=texture2D(paintMask,maskUV).rgb;
        blend/=max(dot(blend,vec3(1.)),0.001);
        vec4 terrainColor=vec4(0.);
        if(blend.x>0.001) terrainColor+=triSample(color0)*blend.x;
        if(blend.y>0.001) terrainColor+=triSample(color1)*blend.y;
        if(blend.z>0.001) terrainColor+=triSample(color2)*blend.z;
        diffuseColor*=terrainColor;
      `);
      shader.fragmentShader = shader.fragmentShader.replace("#include <normal_fragment_maps>", `
        vec3 detailNormal=vec3(0.); float relief=0.;
        if(blend.x>0.001) { detailNormal+=triNormal(normal0)*blend.x; relief+=triSample(height0).r*blend.x; }
        if(blend.y>0.001) { detailNormal+=triNormal(normal1)*blend.y; relief+=triSample(height1).r*blend.y; }
        if(blend.z>0.001) { detailNormal+=triNormal(normal2)*blend.z; relief+=triSample(height2).r*blend.z; }
        detailNormal=normalize(detailNormal);
        vec3 viewN=normalize(mat3(viewMatrix)*detailNormal)*faceDirection;
        vec3 surfX=dFdx(-vViewPosition), surfY=dFdy(-vViewPosition);
        vec3 r1=cross(surfY,viewN), r2=cross(viewN,surfX);
        float det=dot(surfX,r1);
        normal=normalize(abs(det)*viewN-sign(det)*(dFdx(relief)*r1+dFdy(relief)*r2)*0.14);
      `);
    };
    material.customProgramCacheKey = () => "chunk-terrain-triplanar-v1";
    return material;
  }
  raycast(raycaster: THREE.Raycaster) { return this.group.visible ? raycaster.intersectObjects(this.group.children.filter((child) => child.userData.terrain), false)[0] : undefined; }
  private destroy(chunk: Chunk) { chunk.mesh.geometry.dispose(); chunk.mesh.material.dispose(); chunk.texture.dispose(); this.group.remove(chunk.mesh); }
  dispose() { for (const chunk of this.chunks.values()) this.destroy(chunk); this.chunks.clear(); this.group.removeFromParent(); }
}
