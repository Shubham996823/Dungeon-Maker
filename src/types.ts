export type Variant = "A" | "B" | "C";
export type WallModuleVariant = "2" | "3" | "4" | "5" | "7" | "8" | "9" | "10" | "11" | "12" | "13" | "14" | "15";
export type PillarModuleVariant = "1" | "2" | "3" | "4";
export type OpeningAsset = "WD_1" | "WD_2" | "WD_3" | "DR_2.5x1.5_1" | "DR_2.5x2_1" | "DR_2.5x2_2";
export type FloorAssetVariant = "1" | "2";
export type StairAsset = "ST_2.5x2_1" | "ST_2.5x4_1";

export interface PlanPoint { x: number; y: number; }
export type ManualWallKind = "straight" | "diagonal" | "curve";
export type ManualAssembly = "wall" | "balcony-railing";
export type WallDrawMode = "path" | "arc";
export interface ManualWall {
  id: string;
  /** Omitted by legacy projects; an omitted value is a standard wall. */
  assembly?: ManualAssembly;
  elevationSteps?: number;
  start: PlanPoint;
  end: PlanPoint;
  kind?: ManualWallKind;
  /** Legacy quadratic Bezier control point retained for old saved projects. */
  control?: PlanPoint;
  /** A point that the authored circular arc must pass through. */
  arcPoint?: PlanPoint;
  /** Openings authored on standalone wall modules. */
  openings?: WallOpening[];
}
export interface WallDeletion { id: string; cx: number; cy: number; axis: "horizontal" | "vertical"; roomId?: string; elevation?: number; }
export interface WallEraseTarget {
  cx: number;
  cy: number;
  axis: "horizontal" | "vertical";
  manualWallId?: string;
  manualWallModuleIndex?: number;
  roomWall?: boolean;
  roomId?: string;
  elevation?: number;
}
export interface Cell { x: number; y: number; }
/** Height stored at one 2 m terrain tile. Missing tiles use the 0 m datum. */
export interface TerrainCell extends Cell { height: number; }
export type TerrainBrushMode = "raise" | "lower" | "flatten";
export type TerrainTextureVariant = "grass" | "ground-rocks" | "cliff-rocks";
export type TerrainEdgeProfile = "smooth" | "cliff";
export interface TerrainRegion {
  /** When present, this spline paints the surface without changing height. */
  texture?: TerrainTextureVariant;
  brush?: { radius: number; intensity: number; falloff: number };
  id: string;
  controlPoints: PlanPoint[];
  mode: TerrainBrushMode;
  /** Signed metres applied inside the spline; flatten regions ignore this value. */
  height: number;
  edgeProfile: TerrainEdgeProfile;
  slopeWidth: number;
}
export interface RoomConnection {
  pathPoints?: Array<PlanPoint & { elevation: number }>;
  brokenSegments?: number[];
  pathOrigin?: PlanPoint & { elevation: number };
  bendOffset?: PlanPoint;
  id: string;
  fromRoomId: string;
  toRoomId: string;
  fromOpeningId: string;
  toOpeningId: string;
}
export interface StairPlacement {
  id: string;
  cell: Cell;
  elevationSteps: number;
  rotation: number;
  asset: StairAsset;
}
export interface PillarPlacement {
  id: string;
  point: PlanPoint;
  elevationSteps: number;
  variant: Variant;
}
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
  dynamicLighting: boolean;
  timeOfDay: number;
  ambientLight: number;
  exposure: number;
  hdriBackground: boolean;
  hdriIntensity: number;
  hdriRotation: number;
  moduleWallVariant: WallModuleVariant;
  modulePillarVariant: PillarModuleVariant;
  terrainEnabled?: boolean;
  gridVisible?: boolean;
  /** Brush radius in 2 m grid cells. */
  terrainBrushRadius?: number;
  /** Maximum height change applied by one stroke, in metres. */
  terrainBrushStep?: number;
  terrainTexture?: TerrainTextureVariant;
  terrainEdgeProfile?: TerrainEdgeProfile;
  /** Width of a smooth spline transition in grid cells. */
  terrainSlopeWidth?: number;
  /** Render subdivisions per 2 m terrain cell. Higher values smooth silhouettes and lighting. */
  terrainMeshResolution?: number;
  terrainPaintMode?: boolean;
  terrainPaintSize?: number;
  terrainPaintIntensity?: number;
  terrainPaintFalloff?: number;
  terrainPaintTexture?: TerrainTextureVariant;
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
  manualWallId?: string;
  manualWallModuleIndex?: number;
  /** Vertical world offset in metres. Zero for existing ground-level content. */
  elevation?: number;
}

export interface WallPath {
  points: PlanPoint[];
  kind: "diagonal" | "curve" | "straight-exact";
  roomId: string;
  opposingRoomId?: string;
  insideVariant: Variant;
  outsideVariant: Variant;
  opposingVariant?: Variant;
  manualWallId?: string;
  elevation?: number;
}

export type CornerKind = "SW" | "SE" | "NE" | "NW";
export interface Corner { x: number; y: number; kind: CornerKind; variant: Variant; }
export interface Pillar { x: number; y: number; junction: boolean; variant: Variant; elevation?: number; }
export interface RoomGround { roomId: string; outer: PlanPoint[]; holes: PlanPoint[][]; elevation?: number; }

/** A floor or balcony authored independently from rooms and walls. */
export interface FloorRegion {
  id: string;
  cells: Cell[];
  cornerEdits: CornerEdit[];
  /** Fixed quarter-metre steps above or below the map datum. */
  elevationSteps: number;
  variant: FloorAssetVariant;
}

export interface FloorGround extends RoomGround {
  floorId: string;
  variant: FloorAssetVariant;
}

export interface CornerHandle {
  roomId: string;
  vertexX: number;
  vertexY: number;
  inwardX: number;
  inwardY: number;
  maxInsetCells: number;
  edit?: CornerEdit;
  elevation?: number;
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
  elevation?: number;
}

export interface WallResizeHandle {
  roomId: string;
  start: PlanPoint;
  end: PlanPoint;
  /** Unit vector pointing away from the room footprint. */
  outwardX: number;
  outwardY: number;
  elevation?: number;
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
  balconyRailings: WallSegment[];
  balconyPillars: Pillar[];
  /** Unioned shapes used to render floors for overlapping rooms. */
  roomGrounds: RoomGround[];
  foundationGrounds?: RoomGround[];
  floorGrounds: FloorGround[];
  floorHitAreas: FloorGround[];
  floorCornerHandles: CornerHandle[];
  /** Original per-room shapes retained for raycast selection while rooms overlap. */
  roomHitAreas: RoomGround[];
  /** Logical room IDs represented by each temporary visual union. */
  roomGroups: string[][];
  cornerHandles: CornerHandle[];
  radiusHandles: RadiusHandle[];
  wallResizeHandles: WallResizeHandle[];
  openings: WallOpening[];
  bounds: LayoutBounds;
  stats: LayoutStats;
}

export type EditorTool = "draw" | "wall" | "railing" | "erase" | "select" | "circle" | "opening" | "stairs" | "pillar" | "terrain" | "connect";
export interface RoomStyle { innerWallVariant: Variant; outerWallVariant: Variant; }

export interface WallOpening {
  automatic?: boolean;
  suppressed?: boolean;
  id: string;
  roomId: string;
  /** Present when this opening belongs to an independently drawn wall. */
  manualWallId?: string;
  asset: OpeningAsset;
  /** Centre of one fixed 2 m wall module in plan metres. */
  cx: number;
  cy: number;
  /** Wall tangent, canonical modulo PI. */
  rotation: number;
}

export interface Room {
  autoOpenings?: boolean;
  buildingId?: string;
  /** World-space foundation in metres; level numbering is relative to this datum. */
  foundationHeight?: number;
  id: string;
  /** Rectilinear part of the room. May be empty when the room is purely circular. */
  cells: Cell[];
  /** Circular parts of the room. Empty for every plain grid room. */
  circles: CircleShape[];
  style: RoomStyle;
  cornerEdits: CornerEdit[];
  openings: WallOpening[];
  /** World elevation in quarter-metre units; fractional units preserve terrain anchors. */
  elevationSteps?: number;
}

export interface CellBounds { minX: number; minY: number; maxX: number; maxY: number; }

export type PlanAction =
  | { type: "save-pathway"; connection: RoomConnection; openings?: WallOpening[] }
  | { type: "connect-rooms"; fromRoomId: string; toRoomId: string }
  | { type: "bend-connection"; id: string; point: PlanPoint }
  | { type: "remove-connection"; id: string }
  | { type: "draw"; cells: Cell[] }
  | { type: "erase"; bounds: CellBounds }
  | { type: "circle"; circle: CircleShape }
  | { type: "wall"; start: PlanPoint; end: PlanPoint; kind?: ManualWallKind; control?: PlanPoint; arcPoint?: PlanPoint }
  | { type: "wall-path"; points: PlanPoint[] }
  | { type: "railing-path"; points: PlanPoint[] }
  | { type: "erase-wall"; target: WallEraseTarget }
  | { type: "erase-walls"; bounds: CellBounds }
  | { type: "draw-floor"; cells: Cell[] }
  | { type: "place-stair"; cell: Cell; asset: StairAsset }
  | { type: "remove-stair"; id: string }
  | { type: "rotate-stair"; id: string }
  | { type: "place-pillar"; point: PlanPoint }
  | { type: "remove-pillar"; id: string }
  | { type: "terrain-stroke"; cells: Cell[]; mode: TerrainBrushMode }
  | { type: "terrain-spline"; points: PlanPoint[]; mode: TerrainBrushMode; edgeProfile: TerrainEdgeProfile }
  | { type: "add-terrain-region"; region: TerrainRegion }
  | { type: "replace-terrain-region"; region: TerrainRegion }
  | { type: "remove-terrain-region"; id: string }
  | { type: "clear-terrain" }
  | { type: "erase-floor"; bounds: CellBounds };

export interface SavedProject {
  activeBuildingId?: string | null;
  activeGridLevel?: number;
  format: "mor-room-planner";
  version: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;
  name: string;
  cells: Cell[];
  settings: BuildSettings;
  rooms?: Room[];
  manualWalls?: ManualWall[];
  wallDeletions?: WallDeletion[];
  floors?: FloorRegion[];
  stairs?: StairPlacement[];
  placedPillars?: PillarPlacement[];
  terrain?: TerrainCell[];
  terrainRegions?: TerrainRegion[];
  roomConnections?: RoomConnection[];
}
