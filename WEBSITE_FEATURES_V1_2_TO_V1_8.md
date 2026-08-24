# Website feature specification from Blender add-on 1.2–1.8.1

This document collects the accepted room-builder behavior developed in the Blender add-on and maps it to the React/Three.js website. The restored Blender baseline is **1.8.1**. Failed floor experiments from 1.5–1.7 and 1.8.2–1.9 are lessons, not website requirements.

## Already present on the website

- 2 m grid raycasting and drag-to-create rooms.
- Overlapping room footprints merge instead of occupying the same cells twice.
- Adjacent rooms can emit shared-wall records with both room IDs.
- Fixed 3x2 wall GLBs without whole-run stretching.
- Separate inside/outside wall variants, visibility, offsets, and 180-degree orientation.
- Pillar visibility, variant, and inset controls.
- Room ownership and per-room inside/outside style data.
- Project save/load using the current version-1 JSON format.

## 1.2 — Interactive corner editing

Add a visible control point at every convex corner of each selected room footprint.

- Clicking and dragging a point edits that corner.
- The edit distance snaps to the 2 m grid.
- Dragging toward the room produces a diagonal cut.
- Crossing outside the original corner switches to a curved cut.
- Provide explicit UI actions equivalent to Blender's `C` and `I` controls:
  - Toggle diagonal/curve.
  - Invert curve.
- A reset action restores all corners of the selected room.
- Corner edits belong to the room, not to global build settings.

Suggested data model:

```ts
type CornerShape = "diagonal" | "curve";

interface CornerEdit {
  vertexX: number;
  vertexY: number;
  insetCells: number;
  shape: CornerShape;
  inverted: boolean;
}

interface Room {
  id: string;
  cells: Cell[];
  style: RoomStyle;
  cornerEdits: CornerEdit[];
}
```

## 1.3 — Smooth curved wall deformation

Curved walls must not be made from visibly rotated rigid segments.

- Generate one continuous sampled path for the edited corner.
- Clone the selected 3x2 wall geometry before modifying it.
- Map each vertex's longitudinal coordinate onto distance along the curve.
- Use the curve tangent and normal to preserve wall thickness.
- Preserve UV coordinates, materials, height, and vertical proportions.
- Use at least 64 path samples for interactive quality.
- Apply inside/outside offsets along the curve normal.
- Reverse path traversal for independent 180-degree wall orientation.
- Dispose cloned `BufferGeometry` objects whenever the room rebuilds.

## 1.4 — Exact diagonal endpoints

- Remove straight boundary modules covered by a diagonal or curve.
- Fit the replacement wall run exactly between its two new endpoints.
- Distribute the small fitting difference across subdivided wall geometry.
- Do not allow the final module to extend past an endpoint pillar.
- Keep fixed 3x2 modules on unchanged straight runs.

## Pillars on edited corners

- Remove the pillar at the original rectangular corner after a cut.
- Place pillars at both new diagonal/curve endpoints.
- Apply the existing pillar inset/offset relative to the new boundary normal.
- Deduplicate coincident endpoint pillars.
- Do not generate pillars in fully occupied interior space.

## 1.8–1.8.1 — Final footprint and ground

Build a final closed 2D footprint for every room from:

- Remaining straight cell-boundary edges.
- Diagonal replacement paths.
- Curved replacement paths.

For the website, do not reproduce Blender's mesh Boolean implementation. Use deterministic 2D geometry:

1. Trace the final ordered footprint loop counter-clockwise.
2. Convert it into a `THREE.Shape`.
3. Triangulate it with `THREE.ShapeGeometry`/Earcut.
4. Reuse the selected ground material from `FL2x2A.glb`.
5. Generate world-aligned UVs at the same scale as the original 2x2 tiles.
6. Remove ground outside diagonal and curved boundaries automatically.

This produces the intended 1.8 result without Blender's intermittent Boolean failures, missing tiles, or temporary solid boxes.

## Shared walls and edited boundaries

- Continue using one canonical edge record for a boundary shared by two rooms.
- A shared edge has one inside face owned by each adjoining room and no outside face.
- Do not create a shared edge through a curved/diagonal exterior cut.
- If a future edit affects an interior shared boundary, both room IDs must reference the same path record.
- Keep a small configurable separation between the two room-facing meshes to avoid z-fighting.

## Website interaction flow

1. Draw mode creates or extends a room as it does now.
2. Select mode raycasts the ground and resolves the owning room.
3. Selecting a room displays its corner handles.
4. Dragging a handle shows a live diagonal/curve preview.
5. Pointer release commits one `CornerEdit` and rebuilds walls, pillars, and ground.
6. Escape/right-click cancels and restores the previous edit.
7. Orbit controls remain available when no handle is being dragged.

## Persistence migration

Increase the saved-project schema to version 2.

- Version-1 projects import with `cornerEdits: []` for every room.
- Version-2 projects persist corner edits and any curve quality setting.
- Existing room styles and build settings remain backward compatible.

## Recommended implementation order

1. Extend room types and save/load migration.
2. Add boundary-loop and corner-path functions with unit tests.
3. Add selected-room corner handles and drag interaction.
4. Replace affected straight wall segments with diagonal paths.
5. Add curved `BufferGeometry` deformation.
6. Generate shape-aware room ground.
7. Move/deduplicate endpoint pillars.
8. Test shared rooms, overlapping rooms, multiple edited corners, save/load, and cleanup.

## Acceptance checks

- A diagonal cut removes both the old corner walls and ground outside the diagonal.
- A curve looks continuous rather than faceted and contains no ground outside it.
- No wall extends beyond either endpoint pillar.
- Inside and outside wall variants still work on edited paths.
- Two adjacent rooms still use one shared boundary record.
- Overlapping rooms still merge correctly.
- Editing one room does not alter another room's wall variants or corner data.
- Reset restores the original rectangular room.
- Saving and reopening produces the same edited footprint.
- Repeated editing does not leak Three.js geometry or materials.
