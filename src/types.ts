export type Variant = "A" | "B" | "C";

export interface PlanPoint { x: number; y: number; }
export interface Cell { x: number; y: number; }
export type CornerShape = "diagonal" | "curve";

export interface CornerEdit {
  vertexX: number;
  vertexY: number;
  insetCells: number;
  shape: CornerShape;
  inverted: boolean;
}

export interface BuildSettings {
  floorVariant: Variant;
  wallVariant: Variant;
  innerWallVariant: Variant;
  outerWallVariant: Variant;
  flipInnerWall: boolean;
  flipOuterWall: boolean;
  wallOrientationVersion: 1;
  showInnerWalls: boolean;
  showOuterWalls: boolean;
  innerWallOffset: number;
  outerWallOffset: number;
  cornerVariant: Variant;
  pillarVariant: Variant;
  randomizeWalls: boolean;
  randomSeed: number;
  addPillars: boolean;
  pillarInset: number;
  curveQuality: number;
  sharedWallSeparation: number;
}

export type Side = "S" | "E" | "N" | "W";

export interface WallSegment {
  x: number;
  y: number;
  length: number;
  rotation: number;
  side: Side;
  variant: Variant;
  roomId?: string;
  opposingRoomId?: string;
  insideVariant?: Variant;
  outsideVariant?: Variant;
  opposingVariant?: Variant;
}

export interface WallPath {
  points: PlanPoint[];
  kind: "diagonal" | "curve" | "straight-exact";
  roomId: string;
  opposingRoomId?: string;
  insideVariant: Variant;
  outsideVariant: Variant;
  opposingVariant?: Variant;
}

export type CornerKind = "SW" | "SE" | "NE" | "NW";
export interface Corner { x: number; y: number; kind: CornerKind; variant: Variant; }
export interface Pillar { x: number; y: number; junction: boolean; variant: Variant; }
export interface RoomGround { roomId: string; outer: PlanPoint[]; holes: PlanPoint[][]; }

export interface CornerHandle {
  roomId: string;
  vertexX: number;
  vertexY: number;
  inwardX: number;
  inwardY: number;
  maxInsetCells: number;
  edit?: CornerEdit;
}

/** A circular room part. Centre and radius are world metres; radius is a whole number by construction. */
export interface CircleShape {
  cx: number;
  cy: number;
  radius: number;
}

export interface RadiusHandle {
  roomId: string;
  circleIndex: number;
  cx: number;
  cy: number;
  radius: number;
  /** Radians around the centre where this grab point sits. */
  angle: number;
}

export interface LayoutBounds { minX: number; minY: number; maxX: number; maxY: number; }

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
  wallPaths: WallPath[];
  corners: Corner[];
  pillars: Pillar[];
  roomGrounds: RoomGround[];
  cornerHandles: CornerHandle[];
  radiusHandles: RadiusHandle[];
  bounds: LayoutBounds;
  stats: LayoutStats;
}

export type EditorTool = "draw" | "erase" | "select" | "circle";
export interface RoomStyle { innerWallVariant: Variant; outerWallVariant: Variant; }

export interface Room {
  id: string;
  /** Rectilinear part of the room. May be empty when the room is purely circular. */
  cells: Cell[];
  /** Circular parts of the room. Empty for every plain grid room. */
  circles: CircleShape[];
  style: RoomStyle;
  cornerEdits: CornerEdit[];
}

export interface CellBounds { minX: number; minY: number; maxX: number; maxY: number; }

export type PlanAction =
  | { type: "draw"; cells: Cell[] }
  | { type: "erase"; bounds: CellBounds }
  | { type: "circle"; circle: CircleShape };

export interface SavedProject {
  format: "mor-room-planner";
  version: 1 | 2 | 3;
  name: string;
  cells: Cell[];
  settings: BuildSettings;
  rooms?: Room[];
}
