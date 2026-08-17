export type Variant = "A" | "B" | "C";

export interface Cell {
  x: number;
  y: number;
}

export interface BuildSettings {
  floorVariant: Variant;
  wallVariant: Variant;
  cornerVariant: Variant;
  pillarVariant: Variant;
  randomizeWalls: boolean;
  randomSeed: number;
  addPillars: boolean;
  pillarInset: number;
}

export interface WallSegment {
  x: number;
  y: number;
  length: number;
  rotation: number;
  side: Side;
  variant: Variant;
}

export type Side = "S" | "E" | "N" | "W";
export type CornerKind = "SW" | "SE" | "NE" | "NW";

export interface Corner {
  x: number;
  y: number;
  kind: CornerKind;
  variant: Variant;
}

export interface Pillar {
  x: number;
  y: number;
  junction: boolean;
  variant: Variant;
}

export interface LayoutBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface LayoutStats {
  area: number;
  perimeter: number;
  straightWallLength: number;
  floorTiles: number;
  wallModules: number;
  cornerModules: number;
  pillarModules: number;
  connectedRooms: number;
  totalModules: number;
}

export interface GeneratedLayout {
  cells: Cell[];
  cellKeys: Set<string>;
  walls: WallSegment[];
  corners: Corner[];
  pillars: Pillar[];
  bounds: LayoutBounds;
  stats: LayoutStats;
}

export type EditorTool = "draw" | "erase";

export interface SavedProject {
  format: "mor-room-planner";
  version: 1;
  name: string;
  cells: Cell[];
  settings: BuildSettings;
}
