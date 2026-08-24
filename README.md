# Dungeon-Maker

A browser version of the MoR Square Grid Builder. Users draw occupied 2 m cells directly inside the Three.js assembly viewport while it builds the floor, exterior walls, corner modules, and optional pillars.

## Run locally

```bash
npm install
npm run dev
```

Create an optimized production build with:

```bash
npm run build
```

Run the layout tests with:

```bash
npm test
```

## Browser controls

- Draw: drag a rectangle directly on the 3D ground grid to add cells.
- Erase: drag a rectangle directly on the 3D ground grid to remove cells.
- Pan: hold and drag the middle mouse button.
- Orbit: hold and drag the right mouse button.
- Zoom: use the mouse wheel.
- Perspective and top-view controls remain available while drafting.
- Keyboard: `D` Draw, `E` Erase, `0` Fit, and `Ctrl/Cmd + Z` Undo.

Projects autosave in local browser storage and can be exchanged as versioned JSON files.

## Modular rules

- Cells are fixed at 2 m by 2 m.
- Wall height is fixed at 3 m.
- Only exposed union edges receive walls.
- Convex endpoints reserve 1 m for corner arms.
- Straight runs are greedily packed as 4 m, 2 m, then 1 m modules.
- Overlapping cells are deduplicated and edge-adjacent shapes become open connections.
- A three-cell vertex is treated as a concave pillar junction.

The current renderer uses lightweight procedural modular geometry because no source mesh library accompanies the Blender script. The layout engine is independent of rendering, so the instanced boxes can later be replaced with GLB versions of `FL2x2`, `W3x4`, `W3x2`, `W3x1`, `CWL3x1`, `CWR3x1`, and `P3` assets without changing the drafting behavior.

## Performance

- Floor, wall, corner, trim, and pillar modules use `THREE.InstancedMesh`.
- Rendering is event-driven rather than a permanent animation loop.
- Device pixel ratio is capped in the 3D editor.
- Three.js is isolated from the initial interface bundle as a separate deferred chunk.
- Removed instances release their GPU buffers after every rebuild.
- Plans are capped at 10,000 occupied cells.
