# Interior tool audit — 2026-09-08

## Test setup and result

Used the current application through its browser UI on http://127.0.0.1:5174/. This separate origin preserves the user's saved project on port 5173. No production source was changed. The original port 5173 preview was unreachable at the start.

Built a reference-inspired structural blockout: a 10 × 10 m main hall, two adjoining side rooms, a circular alcove, doors/windows, and an L-shaped floor raised to 2.5 m. Separate straight/diagonal and arc walls remain outside as test specimens. The reference's complete interior cannot yet be reproduced: the editor lacks stairs between stories, railings, beams, furnishings and open-underneath balcony support options.

## Hands-on coverage

| Tool/workflow | Result |
|---|---|
| Square rooms and adjoining rooms | Created successfully; shared partitions generated. |
| Circle room | Created and merged into hall. Small radius attempt gave useful minimum-radius feedback. |
| Room erase | Small erase area intersecting circle removed the entire circular component. Undo restored it. |
| Room selection/movement/elevation | Selected side room, moved it, tested 0 → 2.5 → 0 m, restored movement. |
| Room boundary resize | Changed side-room footprint; restored with undo. Dense joined-room handles made precise targeting difficult. |
| Room corner diagonal/curve/invert/reset | All changed generated shape; reset restored baseline area. |
| Room doors/windows | Placed shared-wall doors, exterior entrance and windows. Shared-wall window attempt correctly rejected with a message. Not every mesh variant or orientation was exhaustively checked. |
| Wall path | Chained straight and diagonal segments; double-click committed. Right-click cancelled a new draft without adding a wall. |
| Arc wall | Start/end/arc-point double-click produced a curved wall. Console warned about insufficient geometry buffer capacity during draft editing. |
| Wall Select | Click/drag on standalone wall did not select or move it; UI changed to SELECT ROOM / CORNER. |
| Wall openings | Attempt on standalone straight wall produced no visible opening or useful feedback. Source confirms opening ownership requires a room ID. |
| Wall erase | Click removed a 2 m straight module. Box erased paths, but also removed the hall's nearby front wall beyond the literal dragged rectangle. Undo restored. |
| Floor draw | Overlapping strips combined into an L-shaped region at 0 m. |
| Floor select/move/elevation | Selected and moved floor; exercised +0.75, -0.75 and +2.5 m. Negative floor under the hall was occluded by the existing room floor. |
| Floor supports | +0.75 m gave stair tiers. +2.5 m gave solid panels underneath balcony, blocking an open mezzanine. |
| Floor corners/finish | Diagonal, curve, inversion, reset and both finish buttons exercised. |
| Floor erase | Removed one tile from balcony. Separate stacked fixture proved the same click deletes both heights. |
| Undo/redo | Geometry changes restored/reapplied, including stacked-floor erase. Import undo did not restore previous name/settings. |
| Materials/structure/lighting | Ground selection, pillars, outside-wall visibility, noon/sunset exercised. |
| Camera | Top/perspective/fit and wheel zoom exercised. Automatic framing clipped part of the layout at the tested narrow viewport; manual zoom-out fixed view. |
| Save/reload | Test name/layout/settings survived reload. |
| Export/import | Export displayed success; downloaded file contents were not independently inspected. Imported local stacked-floor fixture successfully. |

Not covered: HDR/EXR and six-face skybox file loads (no suitable supplied environment files), every material/mesh variant, exhaustive opening alignment, every keyboard shortcut, long-duration performance, or exact preview-to-final geometric comparison. These are not marked as passing.

## Prioritized fixes

1. **Scope floor erasure to the selected floor/active height.** Import `stacked-floor-import.json`: two 16 m² floors total 32 m². One erase click reduces total to 24 m², showing a 4 m² tile removed on each story. Expected 28 m² for one targeted floor. `src/App.tsx` erase-floor branch filters every floor with only XY bounds.
2. **Implement standalone wall selection and opening ownership.** Wall Select currently routes to room editing; manual walls lack room ownership for openings. Add independent wall selection, endpoint/path editing, move and wall-owned openings.
3. **Make erase preview match committed scope.** Room-wall erase uses inclusive cell-expanded bounds; this captured the nearby hall boundary. Highlight exact affected modules before commit and define clear containment/intersection behavior.
4. **Repair path/arc draft geometry allocation.** Runtime repeatedly logged `THREE.BufferGeometry: Buffer size too small for points data`. Inspect reused `curveDraftGeometry.setFromPoints` in `ThreeViewport.tsx`; resize/recreate buffer when point count grows. Warning is confirmed; exact visible corruption was not measured.
5. **Undo complete project changes.** Import undo restores geometry only, leaving imported name/settings. Preserve a complete project snapshot for import and define undo behavior for material/settings edits.
6. **Improve circular erasure.** Partial erase currently deletes the complete circular component. Support polygon subtraction or clearly preview whole-circle deletion.

## Improvements needed for the reference layout

- Active story/elevation for drawing, selection and erasing. Source inspection shows new floors always start at zero and merge only with zero-height floors; extending an elevated balcony creates ground-level content instead.
- Floor support modes: open underside, fascia only, posts/brackets, solid panels, stair tiers. Apply treatments per edge and relative to a chosen supporting surface, not always world zero.
- Named rooms/floors and an object list; current selected-room labels expose timestamp IDs and selection across overlapping surfaces is difficult.
- Numeric dimensions and elevation entry, alongside existing snapping. Repeated quarter-metre button clicks are cumbersome for stories.
- Hide/isolate levels and temporary wall cutaway views. Camera fit should consider viewport aspect ratio.
- Clear tool-specific help. Wall Select currently displays room instructions; unrelated room/opening sections remain visible in floor workflows.

## Additions in recommended order

1. Active levels, scoped edits, floor holes, optional supports.
2. Straight stairs and landings connecting chosen floor surfaces; edge railings.
3. Posts, beams, braces and arches with consistent attachment points.
4. Furniture placement/rotation/duplication and reusable groups for taverns, libraries, guild halls and bedrooms.

Existing automated suite: 70 tests passed. This does not override the interactive defects above. First acceptance scene should be the current L-shaped mezzanine with a genuinely open underside, a stair connection, railing and independently editable upper/lower floors.
