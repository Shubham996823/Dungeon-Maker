# MoR Room Planner — Unreal feature-parity inventory 

This is the implementation inventory for recreating the current browser room planner in Unreal. 
## 1. Project and persistence

- Editable project name (maximum 64 characters).
- Autosave the current project locally.
- Import a versioned JSON project.
- Export the complete project as JSON.
- Import compatibility for project schemas 1, 2, and 3; missing modern fields receive safe defaults.
- A saved project contains: project name, all occupied grid cells, logical rooms, circles, corner edits, per-room wall styles, and all non-lighting build settings.
- Load an example plan.
- Clear the entire plan; the clear operation can be undone.
- Undo and redo whole-plan changes, including rooms/cells. Keyboard: `Ctrl/Cmd+Z`, `Ctrl/Cmd+Shift+Z`, and `Ctrl/Cmd+Y`.

## 2. Viewport and navigation

- Interactive 3D assembly viewport.
- Perspective view button.
- Orthographic/top view button.
- Fit camera to the generated layout. Keyboard: `0`.
- Middle mouse drag pans.
- Right mouse drag orbits.
- Mouse wheel zooms.
- Live hover cell and drag-preview overlay.
- Live dimensions/status overlay while moving a room, resizing a wall, or resizing a circle.

## 3. Grid and basic room creation

- Plan grid is fixed at 2 m × 2 m per cell.
- World-space mouse raycast resolves pointer positions to grid cells.
- Maximum 10,000 occupied cells.
- **Draw mode** (`D`): left-drag a rectangular area to create floor cells/a room.
- Drawing over a room extends/merges its grid footprint instead of keeping duplicate cells.
- **Erase mode** (`E`): left-drag a rectangle to remove its cells.
- Erasing a circle with a rectangle that intersects it removes that whole circle part.
- **Circle mode** (`R`): left-drag a square to create a circular room; it uses the square's inscribed circle.
- Circle radius snaps to whole metres and has a minimum radius of 2 m.
- A room can contain rectangular cells, circles, or both.

## 4. Logical room model and merging

- Each logical room has a stable ID, grid cells, circles, corner edits, and independent inside/outside wall variants.
- A room may be moved without losing its original identity.
- Rooms that truly overlap in area render as one temporary merged footprint.
- Rooms that only touch/tangent remain separate; they do not automatically merge.
- The temporary merged footprint contains only the exterior boundary: overlap walls and interior pillars are removed.
- Moving a previously overlapped room away restores the original separate room records.
- Final-footprint merging occurs after diagonal/curve edits, not on raw grid cells.
- Shared straight boundaries between adjacent logical rooms use one canonical boundary record with both room owners.
- A shared boundary renders two inward-facing wall layers (one per adjoining room) and no exterior face.
- Shared-wall mesh separation is configurable to prevent z-fighting.
- The selected room remains selectable by raycasting each original room footprint even while the display is temporarily merged.

## 5. Select, move, and resize

- **Select mode** (`S`): raycast the floor to select a logical room.
- Selected room is visually identified and exposes its controls.
- Drag a selected room's floor to move it in 2 m increments.
- Blue wall grips appear on eligible exterior straight walls.
- Drag a blue grip perpendicular to its wall to expand or contract the room in 2 m rows/columns.
- A shared grip moves one shared boundary: one room expands while the other contracts.
- Resize is rejected if it would delete a room that has no remaining cells or circles.
- Wall resizing clears corner edits on the affected room because the original edited corners no longer match the resized grid footprint.
- Corner handles and blue wall grips are deduplicated/merged for temporary overlapping room groups wherever they represent the same visible exterior feature.

## 6. Corner editing, diagonals, and curves

- Every selectable convex grid corner exposes a corner control point.
- Dragging a corner control snaps its inset distance to the 2 m grid.
- Dragging toward the room creates a diagonal corner cut.
- Dragging away from the room creates a curved corner cut.
- The edited corner data is: vertex, inset in cells, shape (`diagonal`/`curve`), and curve inversion.
- Toggle the active corner between diagonal and curve. Keyboard: `C`.
- Invert an active curve. Keyboard: `I`.
- Reset the active corner.
- Reset all corner edits on the selected room.
- Curve sampling quality is configurable from 64 to 128 samples.
- Diagonal/curve endpoints replace the covered straight boundary, remove floor outside the final footprint, and receive endpoint pillars.
- Pillars at coincident endpoints are deduplicated.
- Circle radius controls appear at the four cardinal directions of every circle; drag to resize the radius in whole metres.
- Pointer cancel/right-click while dragging a corner, circle, room, or wall restores its previous value.

## 7. Final footprint, floor, walls, and pillars

- Generate a closed 2D room footprint from straight boundaries, diagonal paths, curved paths, and circles.
- Boolean-union finished room footprints using integer-safe 2D clipping; holes/courtyards are retained.
- Ground is triangulated from the final footprint, including holes.
- Ground UVs are world-aligned at the 2 m tile scale.
- Only exterior boundary sections receive exterior walls.
- Straight walls use fixed 3 m × 2 m wall modules; straight runs are not stretched.
- Diagonal and curve boundary paths are separate path-wall records.
- Wall and pillar placement updates whenever rooms are drawn, erased, moved, resized, merged, or corner-edited.
- Corner pillars can be enabled/disabled globally.
- Pillar asset variant is selectable.
- Pillar inset is adjustable from 0 to 2 m in 0.05 m increments.
- Pillars appear at meaningful exterior corners and curve/straight junctions, not in fully occupied interior space.

## 8. Materials and modular assets

- Three asset variants: A, B, C.
- Ground variant selector.
- Global inside-wall variant selector.
- Global outside-wall variant selector.
- Show/hide inside-wall layer.
- Show/hide outside-wall layer.
- Per-room inside-wall variant selector.
- Per-room outside-wall variant selector.
- Asset-library cards for ground, pillar, and wall variants.
- Selecting a ground variant from its asset card changes the active ground asset.
- Selecting a wall asset's **Inside** or **Outside** action changes the active global wall asset for that side.
- Wall variant randomisation can be enabled/disabled.
- Randomisation is deterministic from a numeric seed; the seed can be edited or incremented to reshuffle.
- Wall transforms are intentionally locked: inside layer = 180° rotation and 0.15 m offset; outside layer = 0° rotation and 0.25 m offset.

## 9. Statistics and feedback

- Live area in square metres.
- Live exterior perimeter in metres.
- Floor-tile estimate from generated area.
- Wall-module count.
- Total-module count.
- Connected-zone count.
- Toast/status feedback for validation failures, import/export, clear, example load, and other edits.

## 10. Performance and rendering constraints

- Geometry rebuild is event-driven; it does not require an always-running animation loop.
- Device pixel ratio is capped.
- Generated geometry is disposed on rebuild to avoid GPU memory leaks.
- Repeated modular assets are instanced where suitable.
- The current asset system loads GLB/GLTF modular assets and associated thumbnails from the project asset folders.

## Explicitly excluded from this inventory

- Dynamic sun and sky.
- Time-of-day presets/control.
- Ambient-light and exposure controls.
- HDR and EXR environment loading.
- Six-face skybox loading.
- Environment background visibility, intensity, and rotation.
