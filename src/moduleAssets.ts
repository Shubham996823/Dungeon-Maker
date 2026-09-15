import type { OpeningAsset, PillarModuleVariant, StairAsset, WallModuleVariant } from "./types";

export const WALL_MODULE_VARIANTS = ["2", "3", "4", "5", "7", "8", "9", "10", "11", "12", "13", "14", "15"] as const;
export const PILLAR_MODULE_VARIANTS = ["1", "2", "3", "4"] as const;
export const OPENING_ASSETS = ["WD_1", "WD_2", "WD_3", "DR_2.5x1.5_1", "DR_2.5x2_1", "DR_2.5x2_2"] as const;
export const STAIR_ASSETS = ["ST_2.5x2_1", "ST_2.5x4_1"] as const;

export const isWallModuleVariant = (value: unknown): value is WallModuleVariant =>
  WALL_MODULE_VARIANTS.includes(value as WallModuleVariant);
export const isPillarModuleVariant = (value: unknown): value is PillarModuleVariant =>
  PILLAR_MODULE_VARIANTS.includes(value as PillarModuleVariant);
export const isOpeningAsset = (value: unknown): value is OpeningAsset =>
  OPENING_ASSETS.includes(value as OpeningAsset);
export const isStairAsset = (value: unknown): value is StairAsset =>
  STAIR_ASSETS.includes(value as StairAsset);

export const openingIsWindow = (asset: OpeningAsset) => asset.startsWith("WD_");
export const openingIsFullReplacement = (asset: OpeningAsset) => asset.startsWith("DR_2.5x2_");
export const openingLabel = (asset: OpeningAsset) => ({
  WD_1: "Window · 1", WD_2: "Window · 2", WD_3: "Window · 3",
  "DR_2.5x1.5_1": "Door · 1.5 m", "DR_2.5x2_1": "Door · 2 m · 1", "DR_2.5x2_2": "Door · 2 m · 2",
}[asset]);
export const wallModelUrl = (variant: WallModuleVariant) => `/models/W2.5x2_${variant}.glb`;
export const pillarModelUrl = (variant: PillarModuleVariant) => `/models/P_2.5_${variant}.glb`;
export const openingModelUrl = (asset: OpeningAsset) => `/models/${asset}.glb`;
export const stairModelUrl = (asset: StairAsset) => `/models/${asset}.glb`;
export const stairFootprintSize = (asset: StairAsset) => asset === "ST_2.5x4_1" ? 4 : 2;
export const stairLabel = (asset: StairAsset) => asset === "ST_2.5x4_1" ? "ST 2.5 × 4 · 1" : "ST 2.5 × 2 · 1";
export const balconyPillarModelUrl = () => "/models/BP_1_1.glb";
export const balconyRailingModelUrl = () => "/models/BR_1x1_1.glb";
