import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./icons";
import { buildLayout, MAX_CELLS, normalizeCells, rectangleCells } from "./layout";
import { circleIntersectsCellBounds, circleOverlapsCells, circlesOverlap, MIN_CIRCLE_RADIUS } from "./footprint";
import type {
  BuildSettings,
  Cell,
  CircleShape,
  CornerEdit,
  EditorTool,
  PlanAction,
  Room,
  SavedProject,
  Variant,
} from "./types";

const STORAGE_KEY = "mor-room-planner:project:v3";
const LEGACY_STORAGE_KEYS = ["mor-room-planner:project:v2", "mor-room-planner:project:v1"];
const HISTORY_LIMIT = 60;
const ThreeViewport = lazy(async () => {
  const module = await import("./components/ThreeViewport");
  return { default: module.ThreeViewport };
});

const DEFAULT_SETTINGS: BuildSettings = {
  floorVariant: "A",
  wallVariant: "A",
  innerWallVariant: "A",
  outerWallVariant: "A",
  flipInnerWall: true,
  flipOuterWall: true,
  wallOrientationVersion: 1,
  showInnerWalls: true,
  showOuterWalls: true,
  innerWallOffset: 0,
  outerWallOffset: 0,
  cornerVariant: "A",
  pillarVariant: "A",
  randomizeWalls: true,
  randomSeed: 1,
  addPillars: false,
  pillarInset: 0.3,
  curveQuality: 64,
  sharedWallSeparation: 0.04,
};

const EXAMPLE_CELLS = normalizeCells([
  ...rectangleCells(-3, -2, 5, 4),
  ...rectangleCells(2, -1, 2, 2),
]);

interface ProjectState {
  name: string;
  cells: Cell[];
  rooms: Room[];
  settings: BuildSettings;
}

interface ToastState {
  id: number;
  message: string;
}

function isVariant(value: unknown): value is Variant {
  return value === "A" || value === "B" || value === "C";
}

function sanitizeSettings(value: unknown): BuildSettings {
  if (!value || typeof value !== "object") return DEFAULT_SETTINGS;
  const input = value as Partial<BuildSettings>;
  const orientationMigrated = input.wallOrientationVersion === 1;
  return {
    floorVariant: isVariant(input.floorVariant) ? input.floorVariant : DEFAULT_SETTINGS.floorVariant,
    wallVariant: isVariant(input.wallVariant) ? input.wallVariant : DEFAULT_SETTINGS.wallVariant,
    innerWallVariant: isVariant(input.innerWallVariant) ? input.innerWallVariant : DEFAULT_SETTINGS.innerWallVariant,
    outerWallVariant: isVariant(input.outerWallVariant) ? input.outerWallVariant : DEFAULT_SETTINGS.outerWallVariant,
    flipInnerWall: orientationMigrated && typeof input.flipInnerWall === "boolean" ? input.flipInnerWall : true,
    flipOuterWall: orientationMigrated && typeof input.flipOuterWall === "boolean" ? input.flipOuterWall : true,
    wallOrientationVersion: 1,
    showInnerWalls: typeof input.showInnerWalls === "boolean" ? input.showInnerWalls : DEFAULT_SETTINGS.showInnerWalls,
    showOuterWalls: typeof input.showOuterWalls === "boolean" ? input.showOuterWalls : DEFAULT_SETTINGS.showOuterWalls,
    innerWallOffset: Number.isFinite(input.innerWallOffset) ? Math.min(1, Math.max(-1, Number(input.innerWallOffset))) : DEFAULT_SETTINGS.innerWallOffset,
    outerWallOffset: Number.isFinite(input.outerWallOffset) ? Math.min(1, Math.max(-1, Number(input.outerWallOffset))) : DEFAULT_SETTINGS.outerWallOffset,
    cornerVariant: isVariant(input.cornerVariant) ? input.cornerVariant : DEFAULT_SETTINGS.cornerVariant,
    pillarVariant: isVariant(input.pillarVariant) ? input.pillarVariant : DEFAULT_SETTINGS.pillarVariant,
    randomizeWalls: typeof input.randomizeWalls === "boolean" ? input.randomizeWalls : DEFAULT_SETTINGS.randomizeWalls,
    randomSeed: Number.isInteger(input.randomSeed) && Number(input.randomSeed) >= 0 ? Number(input.randomSeed) : DEFAULT_SETTINGS.randomSeed,
    addPillars: typeof input.addPillars === "boolean" ? input.addPillars : DEFAULT_SETTINGS.addPillars,
    pillarInset: Number.isFinite(input.pillarInset) ? Math.min(2, Math.max(0, Number(input.pillarInset))) : DEFAULT_SETTINGS.pillarInset,
    curveQuality: Number.isFinite(input.curveQuality) ? Math.min(128, Math.max(64, Math.trunc(Number(input.curveQuality)))) : DEFAULT_SETTINGS.curveQuality,
    sharedWallSeparation: Number.isFinite(input.sharedWallSeparation) ? Math.min(0.25, Math.max(0, Number(input.sharedWallSeparation))) : DEFAULT_SETTINGS.sharedWallSeparation,
  };
}

function sanitizeCornerEdit(value: unknown): CornerEdit | null {
  if (!value || typeof value !== "object") return null;
  const edit = value as Partial<CornerEdit>;
  if (!Number.isInteger(edit.vertexX) || !Number.isInteger(edit.vertexY)) return null;
  if (edit.shape !== "diagonal" && edit.shape !== "curve") return null;
  return {
    vertexX: Number(edit.vertexX),
    vertexY: Number(edit.vertexY),
    insetCells: Math.max(1, Math.trunc(Number(edit.insetCells) || 1)),
    shape: edit.shape,
    inverted: edit.inverted === true,
  };
}

function connectedComponents(cells: Cell[]) {
  const byKey = new Map(cells.map((cell) => [`${cell.x},${cell.y}`, cell]));
  const remaining = new Set(byKey.keys());
  const components: Cell[][] = [];
  for (const key of byKey.keys()) {
    if (!remaining.delete(key)) continue;
    const component: Cell[] = [];
    const queue = [byKey.get(key)!];
    while (queue.length) {
      const cell = queue.pop()!;
      component.push(cell);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const neighborKey = `${cell.x + dx},${cell.y + dy}`;
        if (!remaining.delete(neighborKey)) continue;
        queue.push(byKey.get(neighborKey)!);
      }
    }
    components.push(normalizeCells(component));
  }
  return components;
}

/** Circles carry their own geometry, so they survive sanitising even when the room owns no cells. */
function sanitizeCircles(value: unknown): CircleShape[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate): CircleShape[] => {
    if (!candidate || typeof candidate !== "object") return [];
    const { cx, cy, radius } = candidate as Partial<CircleShape>;
    if (!Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(radius)) return [];
    const clamped = Math.max(MIN_CIRCLE_RADIUS, Math.round(radius as number));
    return [{ cx: cx as number, cy: cy as number, radius: clamped }];
  });
}

function sanitizeRooms(value: unknown, cells: Cell[], settings: BuildSettings): Room[] {
  const validCells = new Set(cells.map((cell) => `${cell.x},${cell.y}`));
  const source = Array.isArray(value) ? value : [];
  const rooms = source.flatMap((candidate, index): Room[] => {
    if (!candidate || typeof candidate !== "object") return [];
    const input = candidate as Partial<Room>;
    const roomCells = normalizeCells(Array.isArray(input.cells) ? input.cells : [])
      .filter((cell) => validCells.has(`${cell.x},${cell.y}`));
    const circles = sanitizeCircles(input.circles);
    if (!roomCells.length && !circles.length) return [];
    return [{
      id: typeof input.id === "string" && input.id ? input.id : `room-import-${index}`,
      cells: roomCells,
      circles,
      style: {
        innerWallVariant: isVariant(input.style?.innerWallVariant) ? input.style.innerWallVariant : settings.innerWallVariant,
        outerWallVariant: isVariant(input.style?.outerWallVariant) ? input.style.outerWallVariant : settings.outerWallVariant,
      },
      cornerEdits: Array.isArray(input.cornerEdits) ? input.cornerEdits.map(sanitizeCornerEdit).filter((edit): edit is CornerEdit => edit !== null) : [],
    }];
  });
  if (rooms.length) return rooms;
  return connectedComponents(cells).map((roomCells, index) => ({
    id: `room-migrated-${index + 1}`,
    cells: roomCells,
    circles: [],
    style: { innerWallVariant: settings.innerWallVariant, outerWallVariant: settings.outerWallVariant },
    cornerEdits: [],
  }));
}

function loadProject(): ProjectState {
  try {
    const raw = [STORAGE_KEY, ...LEGACY_STORAGE_KEYS].reduce<string | null>(
      (found, key) => found ?? localStorage.getItem(key),
      null,
    );
    if (!raw) throw new Error("No saved project");
    const saved = JSON.parse(raw) as Partial<SavedProject>;
    if (!Array.isArray(saved.cells)) throw new Error("Invalid saved project");
    const settings = sanitizeSettings(saved.settings);
    const cells = normalizeCells(saved.cells).slice(0, MAX_CELLS);
    return {
      name: typeof saved.name === "string" && saved.name.trim() ? saved.name.slice(0, 64) : "Untitled interior",
      cells,
      rooms: sanitizeRooms(saved.rooms, cells, settings),
      settings,
    };
  } catch {
    return { name: "Atrium study", cells: EXAMPLE_CELLS, rooms: sanitizeRooms([], EXAMPLE_CELLS, DEFAULT_SETTINGS), settings: DEFAULT_SETTINGS };
  }
}

function sameCells(a: Cell[], b: Cell[]) {
  if (a.length !== b.length) return false;
  return a.every((cell, index) => cell.x === b[index]?.x && cell.y === b[index]?.y);
}

/** Undo has to carry rooms as well as cells, or corner edits and circles are lost on the way back. */
interface HistoryEntry {
  cells: Cell[];
  rooms: Room[];
}

/**
 * A drawn rectangle that lands on an existing room extends it rather than stacking a second
 * room on the same footprint. Overlapping a circular part counts too: the boolean union then
 * renders the pair as one continuous boundary.
 */
function mergeDrawnRoom(rooms: Room[], drawn: Cell[], settings: BuildSettings): Room[] {
  const incoming = normalizeCells(drawn);
  if (!incoming.length) return rooms;
  const incomingKeys = new Set(incoming.map((cell) => `${cell.x},${cell.y}`));
  const overlapping = rooms.filter((room) => room.cells.some((cell) => incomingKeys.has(`${cell.x},${cell.y}`))
    || room.circles.some((circle) => circleOverlapsCells(circle, incoming)));
  const separate = rooms.filter((room) => !overlapping.includes(room));
  if (overlapping.length) {
    separate.push({
      ...overlapping[0],
      cells: normalizeCells([...incoming, ...overlapping.flatMap((room) => room.cells)]),
      circles: overlapping.flatMap((room) => room.circles),
      cornerEdits: overlapping.flatMap((room) => room.cornerEdits),
    });
  } else {
    separate.push({
      id: `room-${Date.now()}`,
      cells: incoming,
      circles: [],
      style: { innerWallVariant: settings.innerWallVariant, outerWallVariant: settings.outerWallVariant },
      cornerEdits: [],
    });
  }
  return separate;
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("en", { maximumFractionDigits: 1 }).format(value);
}

function SelectField({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: Variant;
  options: Array<{ value: Variant; label: string }>;
  onChange: (value: Variant) => void;
  disabled?: boolean;
}) {
  return (
    <label className={`field-row${disabled ? " is-disabled" : ""}`}>
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value as Variant)} disabled={disabled}>
        {options.map((option) => <option key={option.value} value={option.value}>{option.value} · {option.label}</option>)}
      </select>
    </label>
  );
}

function Switch({ checked, onChange, label }: { checked: boolean; onChange: (value: boolean) => void; label: string }) {
  return (
    <label className="switch-row">
      <span>{label}</span>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <i aria-hidden="true"><b /></i>
    </label>
  );
}

export default function App() {
  const initialProject = useMemo(loadProject, []);
  const [projectName, setProjectName] = useState(initialProject.name);
  const [cells, setCells] = useState(initialProject.cells);
  const [rooms, setRooms] = useState(initialProject.rooms);
  const [settings, setSettings] = useState(initialProject.settings);
  const [tool, setTool] = useState<EditorTool>("draw");
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);
  const [activeCorner, setActiveCorner] = useState<{ roomId: string; vertexX: number; vertexY: number } | null>(null);
  const [fitSignal, setFitSignal] = useState(0);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [saveStatus, setSaveStatus] = useState<"saved" | "saving">("saved");
  const undoStack = useRef<HistoryEntry[]>([]);
  const redoStack = useRef<HistoryEntry[]>([]);
  const cellsRef = useRef(cells);
  const roomsRef = useRef(rooms);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const toastTimeoutRef = useRef<number | null>(null);
  const layout = useMemo(() => buildLayout(cells, settings, rooms), [cells, settings, rooms]);
  cellsRef.current = cells;
  roomsRef.current = rooms;

  const notify = useCallback((message: string) => {
    if (toastTimeoutRef.current) window.clearTimeout(toastTimeoutRef.current);
    setToast({ id: Date.now(), message });
    toastTimeoutRef.current = window.setTimeout(() => setToast(null), 3200);
  }, []);

  /** Room-only changes (corner edits, circle resize) deliberately do not touch history. */
  const updateRooms = useCallback((updater: (current: Room[]) => Room[]) => {
    const next = updater(roomsRef.current);
    roomsRef.current = next;
    setRooms(next);
  }, []);

  const commitPlan = useCallback((nextCells: Cell[], nextRooms: Room[]) => {
    const normalized = normalizeCells(nextCells);
    if (sameCells(cellsRef.current, normalized) && nextRooms === roomsRef.current) return;
    undoStack.current.push({ cells: cellsRef.current, rooms: roomsRef.current });
    if (undoStack.current.length > HISTORY_LIMIT) undoStack.current.shift();
    redoStack.current = [];
    cellsRef.current = normalized;
    roomsRef.current = nextRooms;
    setCells(normalized);
    setRooms(nextRooms);
  }, []);

  const applyPlanAction = useCallback((action: PlanAction) => {
    const currentCells = cellsRef.current;
    const currentRooms = roomsRef.current;

    if (action.type === "circle") {
      const { circle } = action;
      // A circle that overlaps existing parts joins that room, so the union renders one
      // continuous boundary instead of a doubled wall through the junction.
      const overlapping = currentRooms.filter((room) => circleOverlapsCells(circle, room.cells)
        || room.circles.some((other) => circlesOverlap(circle, other)));
      const separate = currentRooms.filter((room) => !overlapping.includes(room));
      if (overlapping.length) {
        separate.push({
          ...overlapping[0],
          cells: normalizeCells(overlapping.flatMap((room) => room.cells)),
          circles: [...overlapping.flatMap((room) => room.circles), circle],
          cornerEdits: overlapping.flatMap((room) => room.cornerEdits),
        });
      } else {
        separate.push({
          id: `room-${Date.now()}`,
          cells: [],
          circles: [circle],
          style: { innerWallVariant: settings.innerWallVariant, outerWallVariant: settings.outerWallVariant },
          cornerEdits: [],
        });
      }
      commitPlan(currentCells, separate);
      return;
    }

    if (action.type === "erase") {
      const { bounds } = action;
      const inside = (cell: Cell) => cell.x >= bounds.minX && cell.x <= bounds.maxX && cell.y >= bounds.minY && cell.y <= bounds.maxY;
      const nextCells = currentCells.filter((cell) => !inside(cell));
      // A circle has no cells to clip, so an erase that touches it removes it whole.
      let removedCircles = 0;
      const nextRooms = currentRooms.flatMap((room): Room[] => {
        const roomCells = room.cells.filter((cell) => !inside(cell));
        const circles = room.circles.filter((circle) => !circleIntersectsCellBounds(circle, bounds));
        removedCircles += room.circles.length - circles.length;
        if (!roomCells.length && !circles.length) return [];
        return [{ ...room, cells: roomCells, circles }];
      });
      if (nextCells.length === currentCells.length && !removedCircles) return;
      commitPlan(nextCells, nextRooms);
      return;
    }

    const merged = new Map(currentCells.map((cell) => [`${cell.x},${cell.y}`, cell]));
    for (const cell of action.cells) merged.set(`${cell.x},${cell.y}`, cell);
    if (merged.size > MAX_CELLS) {
      notify(`Plans are limited to ${MAX_CELLS.toLocaleString()} cells for browser performance.`);
      return;
    }
    commitPlan([...merged.values()], mergeDrawnRoom(currentRooms, action.cells, settings));
  }, [commitPlan, notify, settings]);

  const resizeCircle = useCallback((roomId: string, circleIndex: number, radius: number) => {
    const snapped = Math.max(MIN_CIRCLE_RADIUS, Math.round(radius));
    updateRooms((current) => current.map((room) => room.id === roomId
      ? { ...room, circles: room.circles.map((circle, index) => index === circleIndex ? { ...circle, radius: snapped } : circle) }
      : room));
  }, [updateRooms]);

  const undo = useCallback(() => {
    const previous = undoStack.current.pop();
    if (!previous) return;
    redoStack.current.push({ cells: cellsRef.current, rooms: roomsRef.current });
    cellsRef.current = previous.cells;
    roomsRef.current = previous.rooms;
    setCells(previous.cells);
    setRooms(previous.rooms);
  }, []);

  const redo = useCallback(() => {
    const next = redoStack.current.pop();
    if (!next) return;
    undoStack.current.push({ cells: cellsRef.current, rooms: roomsRef.current });
    cellsRef.current = next.cells;
    roomsRef.current = next.rooms;
    setCells(next.cells);
    setRooms(next.rooms);
  }, []);

  const updateSetting = <Key extends keyof BuildSettings>(key: Key, value: BuildSettings[Key]) => {
    setSettings((current) => ({ ...current, [key]: value }));
  };

  const updateCornerEdit = useCallback((roomId: string, edit: CornerEdit | null) => {
    updateRooms((current) => current.map((room) => {
      if (room.id !== roomId) return room;
      if (!edit) return room;
      const remaining = room.cornerEdits.filter(
        (candidate) => candidate.vertexX !== edit.vertexX || candidate.vertexY !== edit.vertexY,
      );
      return { ...room, cornerEdits: [...remaining, edit] };
    }));
  }, [updateRooms]);

  const removeCornerEdit = useCallback((roomId: string, vertexX: number, vertexY: number) => {
    updateRooms((current) => current.map((room) => room.id === roomId
      ? { ...room, cornerEdits: room.cornerEdits.filter((edit) => edit.vertexX !== vertexX || edit.vertexY !== vertexY) }
      : room));
  }, [updateRooms]);

  const activeEdit = useMemo(() => {
    if (!activeCorner) return null;
    return rooms.find((room) => room.id === activeCorner.roomId)?.cornerEdits.find(
      (edit) => edit.vertexX === activeCorner.vertexX && edit.vertexY === activeCorner.vertexY,
    ) ?? null;
  }, [activeCorner, rooms]);

  const updateSelectedRoomStyle = (side: "inner" | "outer", variant: Variant) => {
    if (!selectedRoomId) {
      updateSetting(side === "inner" ? "innerWallVariant" : "outerWallVariant", variant);
      return;
    }
    const key = side === "inner" ? "innerWallVariant" : "outerWallVariant";
    updateRooms((current) => current.map((room) => room.id === selectedRoomId
      ? { ...room, style: { ...room.style, [key]: variant } }
      : room));
  };

  useEffect(() => {
    setSaveStatus("saving");
    const timer = window.setTimeout(() => {
      const project: SavedProject = {
        format: "mor-room-planner",
        version: 3,
        name: projectName.trim() || "Untitled interior",
        cells,
        rooms,
        settings,
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(project));
      setSaveStatus("saved");
    }, 300);
    return () => window.clearTimeout(timer);
  }, [cells, projectName, rooms, settings]);

  useEffect(() => () => {
    if (toastTimeoutRef.current) window.clearTimeout(toastTimeoutRef.current);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target instanceof HTMLElement && target.matches("input, select, textarea")) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "y") {
        event.preventDefault();
        redo();
        return;
      }
      if (event.key.toLowerCase() === "d") setTool("draw");
      if (event.key.toLowerCase() === "e") setTool("erase");
      if (event.key.toLowerCase() === "s") setTool("select");
      if (event.key.toLowerCase() === "r") setTool("circle");
      if (event.key.toLowerCase() === "c" && activeCorner) {
        event.preventDefault();
        updateCornerEdit(activeCorner.roomId, {
          vertexX: activeCorner.vertexX,
          vertexY: activeCorner.vertexY,
          insetCells: activeEdit?.insetCells ?? 1,
          shape: activeEdit?.shape === "curve" ? "diagonal" : "curve",
          inverted: activeEdit?.inverted ?? false,
        });
      }
      if (event.key.toLowerCase() === "i" && activeCorner && activeEdit?.shape === "curve") {
        event.preventDefault();
        updateCornerEdit(activeCorner.roomId, { ...activeEdit, inverted: !activeEdit.inverted });
      }
      if (event.key === "0") setFitSignal((value) => value + 1);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeCorner, activeEdit, redo, undo, updateCornerEdit]);

  const exportProject = () => {
    const project: SavedProject = {
      format: "mor-room-planner",
      version: 3,
      name: projectName.trim() || "Untitled interior",
      cells,
      rooms,
      settings,
    };
    const blob = new Blob([JSON.stringify(project, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${project.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "mor-room"}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    notify("Project exported as JSON.");
  };

  const importProject = async (file: File) => {
    try {
      const imported = JSON.parse(await file.text()) as Partial<SavedProject>;
      if (imported.format !== "mor-room-planner" || ![1, 2, 3].includes(imported.version as number) || !Array.isArray(imported.cells)) {
        throw new Error("This is not a valid MoR Room Planner file.");
      }
      const importedCells = normalizeCells(imported.cells);
      if (importedCells.length > MAX_CELLS) throw new Error(`This project exceeds the ${MAX_CELLS.toLocaleString()} cell browser limit.`);
      undoStack.current.push({ cells: cellsRef.current, rooms: roomsRef.current });
      redoStack.current = [];
      setCells(importedCells);
      const importedSettings = sanitizeSettings(imported.settings);
      setSettings(importedSettings);
      setRooms(sanitizeRooms(imported.rooms, importedCells, importedSettings));
      setSelectedRoomId(null);
      setActiveCorner(null);
      if (typeof imported.name === "string" && imported.name.trim()) setProjectName(imported.name.slice(0, 64));
      setFitSignal((value) => value + 1);
      notify("Project imported successfully.");
    } catch (error) {
      notify(error instanceof Error ? error.message : "The project could not be imported.");
    }
  };

  const loadExample = () => {
    commitPlan(EXAMPLE_CELLS, sanitizeRooms([], EXAMPLE_CELLS, settings));
    setFitSignal((value) => value + 1);
    notify("Example assembly loaded.");
  };

  const clearPlan = () => {
    if (!cells.length && !rooms.length) return;
    commitPlan([], []);
    setSelectedRoomId(null);
    setActiveCorner(null);
    notify("Plan cleared. Undo is available.");
  };

  const variantOptions = [
    { value: "A" as const, label: "Linen" },
    { value: "B" as const, label: "Sage" },
    { value: "C" as const, label: "Clay" },
  ];
  const selectedRoom = rooms.find((room) => room.id === selectedRoomId) ?? null;

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark"><i /><i /><i /></span>
          <div><strong>Room planner</strong></div>
        </div>
        <label className="project-title">
          <span>Project</span>
          <input value={projectName} maxLength={64} onChange={(event) => setProjectName(event.target.value)} aria-label="Project name" />
        </label>
        <div className="top-actions">
          <span className={`save-state ${saveStatus}`}><i />{saveStatus === "saved" ? "Saved locally" : "Saving"}</span>
          <button type="button" className="header-button" onClick={() => fileInputRef.current?.click()}><Icon name="upload" />Import</button>
          <button type="button" className="header-button primary" onClick={exportProject}><Icon name="download" />Export</button>
          <input
            ref={fileInputRef}
            className="visually-hidden"
            type="file"
            accept="application/json,.json"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void importProject(file);
              event.target.value = "";
            }}
          />
        </div>
      </header>

      <main className="app-main">
        <aside className="sidebar">
          <section className="control-section">
            <div className="section-heading"><span>01</span><h2>Edit assembly</h2></div>
            <div className="tool-grid">
              <button type="button" className={tool === "draw" ? "active" : ""} onClick={() => setTool("draw")}><Icon name="brush" /><span>Draw</span><kbd>D</kbd></button>
              <button type="button" className={tool === "circle" ? "active" : ""} onClick={() => setTool("circle")}><Icon name="circle" /><span>Circle</span><kbd>R</kbd></button>
              <button type="button" className={tool === "erase" ? "active" : ""} onClick={() => setTool("erase")}><Icon name="erase" /><span>Erase</span><kbd>E</kbd></button>
              <button type="button" className={tool === "select" ? "active" : ""} onClick={() => setTool("select")}><Icon name="grid" /><span>Select</span><kbd>S</kbd></button>
            </div>
            <p className="control-help">Draw or erase with left drag. Circle drags stay square, so the inscribed room snaps to whole-metre radii (minimum {MIN_CIRCLE_RADIUS} m). Select a room to edit its corners or drag a circle's radius. Middle mouse pans, right mouse orbits, and the wheel zooms.</p>
            <div className="history-row">
              <button type="button" onClick={undo} disabled={!undoStack.current.length}><Icon name="undo" />Undo</button>
              <button type="button" onClick={redo} disabled={!redoStack.current.length}><Icon name="redo" />Redo</button>
            </div>
          </section>

          <section className="control-section corner-editor">
            <div className="section-heading"><span>02</span><h2>Room corner editor</h2></div>
            {!selectedRoom && <p className="control-help">Choose Select, then click a room to display its editable convex corners.</p>}
            {selectedRoom && (
              <>
                <div className="selected-room-label"><span>Selected room</span><b>{selectedRoom.id.replace(/^room-/, "")}</b></div>
                <SelectField label="Room inside wall" value={selectedRoom.style.innerWallVariant} options={variantOptions} onChange={(value) => updateSelectedRoomStyle("inner", value)} />
                <SelectField label="Room outside wall" value={selectedRoom.style.outerWallVariant} options={variantOptions} onChange={(value) => updateSelectedRoomStyle("outer", value)} />
                <div className="corner-actions">
                  <button
                    type="button"
                    disabled={!activeCorner}
                    onClick={() => activeCorner && updateCornerEdit(activeCorner.roomId, {
                      vertexX: activeCorner.vertexX,
                      vertexY: activeCorner.vertexY,
                      insetCells: activeEdit?.insetCells ?? 1,
                      shape: activeEdit?.shape === "curve" ? "diagonal" : "curve",
                      inverted: activeEdit?.inverted ?? false,
                    })}
                  >Toggle diagonal / curve <kbd>C</kbd></button>
                  <button
                    type="button"
                    disabled={!activeCorner || activeEdit?.shape !== "curve"}
                    onClick={() => activeCorner && activeEdit && updateCornerEdit(activeCorner.roomId, { ...activeEdit, inverted: !activeEdit.inverted })}
                  >Invert curve <kbd>I</kbd></button>
                  <button
                    type="button"
                    disabled={!activeCorner || !activeEdit}
                    onClick={() => activeCorner && removeCornerEdit(activeCorner.roomId, activeCorner.vertexX, activeCorner.vertexY)}
                  >Reset corner</button>
                  <button type="button" onClick={() => setRooms((current) => current.map((room) => room.id === selectedRoom.id ? { ...room, cornerEdits: [] } : room))}>Reset all corners</button>
                </div>
                <label className="range-field"><span><b>Curve quality</b><output>{settings.curveQuality} samples</output></span><input type="range" min="64" max="128" step="8" value={settings.curveQuality} onChange={(event) => updateSetting("curveQuality", Number(event.target.value))} /></label>
              </>
            )}
          </section>

          <section className="control-section">
            <div className="section-heading"><span>03</span><h2>Material system</h2></div>
            <SelectField label="Ground" value={settings.floorVariant} options={variantOptions} onChange={(value) => updateSetting("floorVariant", value)} />
            <SelectField label="Inside wall" value={settings.innerWallVariant} options={variantOptions} onChange={(value) => updateSetting("innerWallVariant", value)} />
            <Switch label="Inside walls" checked={settings.showInnerWalls} onChange={(value) => updateSetting("showInnerWalls", value)} />
            <Switch label="Rotate inside wall 180°" checked={settings.flipInnerWall} onChange={(value) => updateSetting("flipInnerWall", value)} />
            <label className="range-field"><span><b>Inside offset</b><output>{settings.innerWallOffset.toFixed(2)} m</output></span><input type="range" min="-1" max="1" step="0.05" value={settings.innerWallOffset} onChange={(event) => updateSetting("innerWallOffset", Number(event.target.value))} /></label>
            <SelectField label="Outside wall" value={settings.outerWallVariant} options={variantOptions} onChange={(value) => updateSetting("outerWallVariant", value)} />
            <Switch label="Outside walls" checked={settings.showOuterWalls} onChange={(value) => updateSetting("showOuterWalls", value)} />
            <Switch label="Rotate outside wall 180°" checked={settings.flipOuterWall} onChange={(value) => updateSetting("flipOuterWall", value)} />
            <label className="range-field"><span><b>Outside offset</b><output>{settings.outerWallOffset.toFixed(2)} m</output></span><input type="range" min="-1" max="1" step="0.05" value={settings.outerWallOffset} onChange={(event) => updateSetting("outerWallOffset", Number(event.target.value))} /></label>
            <Switch label="Shuffle wall variants" checked={settings.randomizeWalls} onChange={(value) => updateSetting("randomizeWalls", value)} />
            {settings.randomizeWalls && (
              <label className="seed-row">
                <span>Random seed</span>
                <input
                  type="number"
                  min="0"
                  value={settings.randomSeed}
                  onChange={(event) => updateSetting("randomSeed", Math.max(0, Math.trunc(Number(event.target.value) || 0)))}
                />
                <button type="button" onClick={() => updateSetting("randomSeed", settings.randomSeed + 1)} aria-label="Shuffle wall variants"><Icon name="shuffle" /></button>
              </label>
            )}
          </section>

          <section className="control-section">
            <div className="section-heading"><span>04</span><h2>Structure</h2></div>
            <Switch label="Corner pillars" checked={settings.addPillars} onChange={(value) => updateSetting("addPillars", value)} />
            {settings.addPillars && (
              <>
                <SelectField label="Pillar module" value={settings.pillarVariant} options={variantOptions} onChange={(value) => updateSetting("pillarVariant", value)} />
                <label className="range-field">
                  <span><b>Pillar inset</b><output>{settings.pillarInset.toFixed(2)} m</output></span>
                  <input type="range" min="0" max="2" step="0.05" value={settings.pillarInset} onChange={(event) => updateSetting("pillarInset", Number(event.target.value))} />
                </label>
              </>
            )}
            <label className="range-field">
              <span><b>Shared wall gap</b><output>{settings.sharedWallSeparation.toFixed(2)} m</output></span>
              <input type="range" min="0" max="0.25" step="0.01" value={settings.sharedWallSeparation} onChange={(event) => updateSetting("sharedWallSeparation", Number(event.target.value))} />
            </label>
            <div className="fixed-specs">
              <span><i>Grid</i><b>2 × 2 m</b></span>
              <span><i>Wall</i><b>3 m</b></span>
              <span><i>Module</i><b>2 m fixed</b></span>
            </div>
          </section>

          <section className="control-section asset-library">
            <div className="section-heading"><span>05</span><h2>Asset library</h2></div>
            <div className="asset-grid">
              {([
                { label: "Ground", file: "FL2x2A.webp", variant: null, grounds: true },
                { label: "Pillar", file: "P3_A.webp", variant: null, grounds: false },
                { label: "Wall · A", file: "W3x2A.webp", variant: "A", grounds: false },
                { label: "Wall · B", file: "W3x2B.webp", variant: "B", grounds: false },
                { label: "Wall · C", file: "W3x2C.webp", variant: "C", grounds: false },
              ] as const).map(({ label, file, variant, grounds }) => (
                <figure key={file}>
                  <img src={`/Thumbnails/${file}`} alt={`${label} asset`} />
                  <figcaption>{label}</figcaption>
                  {variant && (
                    <div className="asset-actions">
                      <button type="button" onClick={() => updateSelectedRoomStyle("inner", variant)}>Inside</button>
                      <button type="button" onClick={() => updateSelectedRoomStyle("outer", variant)}>Outside</button>
                    </div>
                  )}
                  {grounds && (
                    <div className="asset-actions ground-actions">
                      {(["A", "B", "C"] as Variant[]).map((option) => <button type="button" key={option} onClick={() => updateSetting("floorVariant", option)}>{option}</button>)}
                    </div>
                  )}
                </figure>
              ))}
            </div>
          </section>

          <section className="plan-actions">
            <button type="button" onClick={loadExample}><Icon name="grid" />Load example</button>
            <button type="button" className="danger" onClick={clearPlan} disabled={!cells.length && !rooms.length}><Icon name="clear" />Clear plan</button>
          </section>
        </aside>

        <section className="workspace">
          <div className="workbench">
            <article className="workspace-pane model-pane">
              <header className="pane-heading dark">
                <div><span>INTERACTIVE MODEL / 3D</span><strong>Live assembly</strong></div>
                <small><i />2 m snap · Instanced</small>
              </header>
              <Suspense fallback={<div className="three-loading"><Icon name="cube" /><span>Loading 3D workspace</span></div>}>
                <ThreeViewport
                  layout={layout}
                  settings={settings}
                  fitSignal={fitSignal}
                  tool={tool}
                  selectedRoomId={selectedRoomId}
                  activeCorner={activeCorner}
                  onCommit={applyPlanAction}
                  onSelectRoom={(roomId) => { setSelectedRoomId(roomId); if (!roomId) setActiveCorner(null); }}
                  onActiveCorner={setActiveCorner}
                  onCornerEdit={updateCornerEdit}
                  onCornerRemove={removeCornerEdit}
                  onCircleResize={resizeCircle}
                  onNotice={notify}
                />
              </Suspense>
            </article>
          </div>

          <footer className="metrics-strip">
            <div><span>Area</span><strong>{formatNumber(layout.stats.area)} <small>m²</small></strong></div>
            <div><span>Perimeter</span><strong>{formatNumber(layout.stats.perimeter)} <small>m</small></strong></div>
            <div><span>Floor tiles</span><strong>{layout.stats.floorTiles}</strong></div>
            <div><span>Wall modules</span><strong>{layout.stats.wallModules}</strong></div>
            <div><span>Total modules</span><strong>{layout.stats.totalModules}</strong></div>
            <div><span>Zones</span><strong>{layout.stats.connectedRooms}</strong></div>
          </footer>
        </section>
      </main>

      {toast && <div key={toast.id} className="toast" role="status"><span />{toast.message}</div>}
    </div>
  );
}
