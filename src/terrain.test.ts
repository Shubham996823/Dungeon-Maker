import { describe, expect, it } from "vitest";
import { applyTerrainRegions, applyTerrainSpline, applyTerrainStroke, resolveTerrainSubdivisions, sampleClosedTerrainSpline, sanitizeTerrain, sanitizeTerrainRegions, terrainPaintInfluence } from "./terrain";

describe("terrain brushes", () => {
  it("saves single brush dabs and produces smooth intensity falloff", () => {
    const [dab] = sanitizeTerrainRegions([{ id: "dab", texture: "grass", controlPoints: [{ x: 0, y: 0 }], brush: { radius: 2, intensity: 0.6, falloff: 1 } }]);
    expect(dab).toBeDefined();
    expect(terrainPaintInfluence({ x: 0, y: 0 }, dab)).toBeCloseTo(0.6);
    expect(terrainPaintInfluence({ x: 1, y: 0 }, dab)).toBeCloseTo(0.3);
    expect(terrainPaintInfluence({ x: 2, y: 0 }, dab)).toBe(0);
    expect(applyTerrainRegions([], [dab])).toEqual([]);
    expect(sanitizeTerrainRegions(JSON.parse(JSON.stringify([dab])))).toEqual([dab]);
  });
  it("paints continuously between pointer samples without stacking opacity within a stroke", () => {
    const [stroke] = sanitizeTerrainRegions([{ texture: "cliff-rocks", controlPoints: [{ x: 0, y: 0 }, { x: 10, y: 0 }], brush: { radius: 2, intensity: 0.4, falloff: 0.5 } }]);
    expect(terrainPaintInfluence({ x: 5, y: 0 }, stroke)).toBeCloseTo(0.4);
    expect(terrainPaintInfluence({ x: 5, y: 1.5 }, stroke)).toBeCloseTo(0.2);
    expect(terrainPaintInfluence({ x: 5, y: 3 }, stroke)).toBe(0);
  });
  it("uses dense terrain subdivisions while capping very large surfaces", () => {
    expect(resolveTerrainSubdivisions(20, 20, 4)).toBe(4);
    expect(resolveTerrainSubdivisions(20, 20, 10)).toBe(10);
    expect(resolveTerrainSubdivisions(500, 500, 6)).toBe(1);
  });

  it("preserves painted splines through save/load without changing terrain heights", () => {
    const regions = sanitizeTerrainRegions([{ id: "paint", controlPoints: [{ x: 0, y: 0 }, { x: 8, y: 0 }, { x: 8, y: 8 }], texture: "ground-rocks", mode: "raise", height: 2 }]);
    expect(regions[0].texture).toBe("ground-rocks");
    const terrain = [{ x: 1, y: 1, height: 3 }];
    expect(applyTerrainRegions(terrain, JSON.parse(JSON.stringify(regions)))).toEqual(terrain);
  });

  it("raises the centre most and keeps a radial falloff", () => {
    const result = applyTerrainStroke([], [{ x: 0, y: 0 }], "raise", 2, 1);
    const height = (x: number, y: number) => result.find((cell) => cell.x === x && cell.y === y)?.height ?? 0;
    expect(height(0, 0)).toBe(1);
    expect(height(1, 0)).toBeGreaterThan(0);
    expect(height(1, 0)).toBeLessThan(height(0, 0));
    expect(height(3, 0)).toBe(0);
  });

  it("raises only cells enclosed by a closed terrain spline", () => {
    const result = applyTerrainSpline([], [{ x: 0, y: 0 }, { x: 8, y: 0 }, { x: 8, y: 8 }, { x: 0, y: 8 }], "raise", 2, "cliff", 2);
    expect(result.find((cell) => cell.x === 1 && cell.y === 1)?.height).toBe(2);
    expect(result.some((cell) => cell.x === 5 && cell.y === 5)).toBe(false);
  });

  it("supports smooth spline slopes and flattening", () => {
    const polygon = [{ x: 0, y: 0 }, { x: 12, y: 0 }, { x: 12, y: 12 }, { x: 0, y: 12 }];
    const raised = applyTerrainSpline([], polygon, "raise", 2, "smooth", 2);
    const edge = raised.find((cell) => cell.x === 0 && cell.y === 2)?.height ?? 0;
    const centre = raised.find((cell) => cell.x === 2 && cell.y === 2)?.height ?? 0;
    expect(centre).toBeGreaterThan(edge);
    expect(applyTerrainSpline(raised, polygon, "flatten", 2, "cliff", 2)).toEqual([]);
  });

  it("lowers terrain and flattens toward the stroke's starting height", () => {
    const lowered = applyTerrainStroke([], [{ x: 0, y: 0 }], "lower", 1, 0.5);
    expect(lowered.find((cell) => cell.x === 0 && cell.y === 0)?.height).toBe(-0.5);
    const flattened = applyTerrainStroke([{ x: 0, y: 0, height: 2 }, { x: 1, y: 0, height: 4 }], [{ x: 0, y: 0 }], "flatten", 1, 1);
    expect(flattened.find((cell) => cell.x === 1 && cell.y === 0)!.height).toBeLessThan(4);
  });

  it("sanitizes duplicates, zeroes, and unsafe values", () => {
    expect(sanitizeTerrain([{ x: 1.9, y: 2.2, height: 30 }, { x: 1, y: 2, height: 0 }, { x: "bad", y: 0, height: 1 }])).toEqual([{ x: 1, y: 2, height: 20 }]);
    expect(sanitizeTerrain([{ x: 1, y: 2, height: 30 }])).toEqual([{ x: 1, y: 2, height: 20 }]);
  });

  it("keeps editable spline control points and samples a closed curve", () => {
    const controls = [{ x: 0, y: 0 }, { x: 8, y: 0 }, { x: 8, y: 8 }, { x: 0, y: 8 }];
    const sampled = sampleClosedTerrainSpline(controls, 8);
    expect(sampled).toHaveLength(32);
    expect(sampled[0]).toEqual(controls[0]);
    expect(sampled.some((point) => point.x < 0)).toBe(true);
  });

  it("rebuilds terrain when a persistent region's height and profile change", () => {
    const baseRegion = {
      id: "hill",
      controlPoints: [{ x: 0, y: 0 }, { x: 12, y: 0 }, { x: 12, y: 12 }, { x: 0, y: 12 }],
      mode: "raise" as const,
      height: 1,
      edgeProfile: "smooth" as const,
      slopeWidth: 2,
    };
    const smooth = applyTerrainRegions([], [baseRegion]);
    const cliff = applyTerrainRegions([], [{ ...baseRegion, height: -2, edgeProfile: "cliff", slopeWidth: 0.25 }]);
    expect(smooth.some((cell) => cell.height > 0)).toBe(true);
    expect(cliff.every((cell) => cell.height === -2)).toBe(true);
  });

  it("sanitizes imported persistent terrain regions", () => {
    const result = sanitizeTerrainRegions([{ id: "safe", controlPoints: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 0, y: 4 }], mode: "lower", height: -99, edgeProfile: "cliff", slopeWidth: 0 }]);
    expect(result[0]).toMatchObject({ id: "safe", height: -20, edgeProfile: "cliff", slopeWidth: 0.25 });
  });
});
