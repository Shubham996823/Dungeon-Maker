import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./icons";
import { buildLayout, normalizeCells, rectangleCells } from "./layout";
import type { BuildSettings, Cell, EditorTool, SavedProject, Variant } from "./types";

const STORAGE_KEY = "mor-room-planner:project:v1";
const HISTORY_LIMIT = 60;
const ThreeViewport = lazy(async () => {
  const module = await import("./components/ThreeViewport");
  return { default: module.ThreeViewport };
});

const DEFAULT_SETTINGS: BuildSettings = {
  floorVariant: "A",
  wallVariant: "A",
  cornerVariant: "A",
  pillarVariant: "A",
  randomizeWalls: true,
  randomSeed: 1,
  addPillars: false,
  pillarInset: 0.3,
};

const EXAMPLE_CELLS = normalizeCells([
  ...rectangleCells(-3, -2, 5, 4),
  ...rectangleCells(2, -1, 2, 2),
]);

interface ProjectState {
  name: string;
  cells: Cell[];
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
  return {
    floorVariant: isVariant(input.floorVariant) ? input.floorVariant : DEFAULT_SETTINGS.floorVariant,
    wallVariant: isVariant(input.wallVariant) ? input.wallVariant : DEFAULT_SETTINGS.wallVariant,
    cornerVariant: isVariant(input.cornerVariant) ? input.cornerVariant : DEFAULT_SETTINGS.cornerVariant,
    pillarVariant: isVariant(input.pillarVariant) ? input.pillarVariant : DEFAULT_SETTINGS.pillarVariant,
    randomizeWalls: typeof input.randomizeWalls === "boolean" ? input.randomizeWalls : DEFAULT_SETTINGS.randomizeWalls,
    randomSeed: Number.isInteger(input.randomSeed) && Number(input.randomSeed) >= 0 ? Number(input.randomSeed) : DEFAULT_SETTINGS.randomSeed,
    addPillars: typeof input.addPillars === "boolean" ? input.addPillars : DEFAULT_SETTINGS.addPillars,
    pillarInset: Number.isFinite(input.pillarInset) ? Math.min(2, Math.max(0, Number(input.pillarInset))) : DEFAULT_SETTINGS.pillarInset,
  };
}

function loadProject(): ProjectState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) throw new Error("No saved project");
    const saved = JSON.parse(raw) as Partial<SavedProject>;
    if (!Array.isArray(saved.cells)) throw new Error("Invalid saved project");
    return {
      name: typeof saved.name === "string" && saved.name.trim() ? saved.name.slice(0, 64) : "Untitled interior",
      cells: normalizeCells(saved.cells).slice(0, 10_000),
      settings: sanitizeSettings(saved.settings),
    };
  } catch {
    return { name: "Atrium study", cells: EXAMPLE_CELLS, settings: DEFAULT_SETTINGS };
  }
}

function sameCells(a: Cell[], b: Cell[]) {
  if (a.length !== b.length) return false;
  return a.every((cell, index) => cell.x === b[index]?.x && cell.y === b[index]?.y);
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
  const [settings, setSettings] = useState(initialProject.settings);
  const [tool, setTool] = useState<EditorTool>("draw");
  const [fitSignal, setFitSignal] = useState(0);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [saveStatus, setSaveStatus] = useState<"saved" | "saving">("saved");
  const undoStack = useRef<Cell[][]>([]);
  const redoStack = useRef<Cell[][]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const toastTimeoutRef = useRef<number | null>(null);
  const layout = useMemo(() => buildLayout(cells, settings), [cells, settings]);

  const notify = useCallback((message: string) => {
    if (toastTimeoutRef.current) window.clearTimeout(toastTimeoutRef.current);
    setToast({ id: Date.now(), message });
    toastTimeoutRef.current = window.setTimeout(() => setToast(null), 3200);
  }, []);

  const commitCells = useCallback((nextCells: Cell[]) => {
    const normalized = normalizeCells(nextCells);
    setCells((current) => {
      if (sameCells(current, normalized)) return current;
      undoStack.current.push(current);
      if (undoStack.current.length > HISTORY_LIMIT) undoStack.current.shift();
      redoStack.current = [];
      return normalized;
    });
  }, []);

  const undo = useCallback(() => {
    setCells((current) => {
      const previous = undoStack.current.pop();
      if (!previous) return current;
      redoStack.current.push(current);
      return previous;
    });
  }, []);

  const redo = useCallback(() => {
    setCells((current) => {
      const next = redoStack.current.pop();
      if (!next) return current;
      undoStack.current.push(current);
      return next;
    });
  }, []);

  const updateSetting = <Key extends keyof BuildSettings>(key: Key, value: BuildSettings[Key]) => {
    setSettings((current) => ({ ...current, [key]: value }));
  };

  useEffect(() => {
    setSaveStatus("saving");
    const timer = window.setTimeout(() => {
      const project: SavedProject = {
        format: "mor-room-planner",
        version: 1,
        name: projectName.trim() || "Untitled interior",
        cells,
        settings,
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(project));
      setSaveStatus("saved");
    }, 300);
    return () => window.clearTimeout(timer);
  }, [cells, projectName, settings]);

  useEffect(() => () => {
    if (toastTimeoutRef.current) window.clearTimeout(toastTimeoutRef.current);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, select, textarea")) return;
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
      if (event.key === "0") setFitSignal((value) => value + 1);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [redo, undo]);

  const exportProject = () => {
    const project: SavedProject = {
      format: "mor-room-planner",
      version: 1,
      name: projectName.trim() || "Untitled interior",
      cells,
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
      if (imported.format !== "mor-room-planner" || imported.version !== 1 || !Array.isArray(imported.cells)) {
        throw new Error("This is not a valid MoR Room Planner file.");
      }
      const importedCells = normalizeCells(imported.cells);
      if (importedCells.length > 10_000) throw new Error("This project exceeds the 10,000 cell browser limit.");
      undoStack.current.push(cells);
      redoStack.current = [];
      setCells(importedCells);
      setSettings(sanitizeSettings(imported.settings));
      if (typeof imported.name === "string" && imported.name.trim()) setProjectName(imported.name.slice(0, 64));
      setFitSignal((value) => value + 1);
      notify("Project imported successfully.");
    } catch (error) {
      notify(error instanceof Error ? error.message : "The project could not be imported.");
    }
  };

  const loadExample = () => {
    commitCells(EXAMPLE_CELLS);
    setFitSignal((value) => value + 1);
    notify("Example assembly loaded.");
  };

  const clearPlan = () => {
    if (!cells.length) return;
    commitCells([]);
    notify("Plan cleared. Undo is available.");
  };

  const variantOptions = [
    { value: "A" as const, label: "Linen" },
    { value: "B" as const, label: "Sage" },
    { value: "C" as const, label: "Clay" },
  ];

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
              <button type="button" className={tool === "erase" ? "active" : ""} onClick={() => setTool("erase")}><Icon name="erase" /><span>Erase</span><kbd>E</kbd></button>
            </div>
            <p className="control-help">Left drag edits cells. Hold middle mouse to pan, right mouse to orbit, and use the wheel to zoom.</p>
            <div className="history-row">
              <button type="button" onClick={undo} disabled={!undoStack.current.length}><Icon name="undo" />Undo</button>
              <button type="button" onClick={redo} disabled={!redoStack.current.length}><Icon name="redo" />Redo</button>
            </div>
          </section>

          <section className="control-section">
            <div className="section-heading"><span>02</span><h2>Material system</h2></div>
            <SelectField label="Floor tile" value={settings.floorVariant} options={variantOptions} onChange={(value) => updateSetting("floorVariant", value)} />
            <SelectField label="Wall module" value={settings.wallVariant} options={variantOptions} onChange={(value) => updateSetting("wallVariant", value)} disabled={settings.randomizeWalls} />
            <SelectField label="Corner module" value={settings.cornerVariant} options={variantOptions} onChange={(value) => updateSetting("cornerVariant", value)} />
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
            <div className="section-heading"><span>03</span><h2>Structure</h2></div>
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
            <div className="fixed-specs">
              <span><i>Grid</i><b>2 × 2 m</b></span>
              <span><i>Wall</i><b>3 m</b></span>
              <span><i>Pack</i><b>4 / 2 / 1 m</b></span>
            </div>
          </section>

          <section className="plan-actions">
            <button type="button" onClick={loadExample}><Icon name="grid" />Load example</button>
            <button type="button" className="danger" onClick={clearPlan} disabled={!cells.length}><Icon name="clear" />Clear plan</button>
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
                  onCommit={commitCells}
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
