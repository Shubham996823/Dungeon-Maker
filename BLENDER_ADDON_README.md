# MoR Room Builder Blender add-on

Current version: **1.8.1**, compatible with Blender's Vector-based and Blender 5.1 index-based polygon tessellation results.

`mor_room_builder_addon.py` converts the current room-building rules into an installable Blender add-on.

## Install

1. In Blender, open **Edit > Preferences > Add-ons**.
2. Choose **Install…** and select `mor_room_builder_addon.py`.
3. Enable **MoR Room Builder**.
4. Open the 3D View sidebar with **N**, then select **MoR Builder**.

## Load the models

Set **GLB Folder** to the project's `public/models` directory and click **Import GLB Library**. The importer recognizes:

- `FL2x2A.glb` — ground
- `W3x2A.glb`, `W3x2B.glb`, `W3x2C.glb` — fixed-size wall variants
- `P3_A.glb` — pillar

The add-on instances these source meshes and never stretches a wall module.

## Use

- Enter grid coordinates and room dimensions, then click **Add Room**, or use **Draw Room** in a top/angled 3D view.
- Overlapping room footprints merge into one cell region.
- Adjacent rooms receive one shared wall edge, with an independently selectable inside face for each room.
- Select a room empty, click **Use Selected Room**, choose inside/outside variants, then click **Apply Walls to Active Room**.
- Inside and outside layers have independent visibility, 180-degree rotation, and offset controls.
- Pillars are generated only at true outside corners, not in fully occupied interior space. **Pillar Offset** moves them diagonally toward or away from the room.
- A shared boundary is built as one canonical wall edge. It has one independently styled interior face for each adjoining room, no exterior face, and a small **Shared Face Gap** to prevent overlapping meshes.

Use **Rebuild** after changing global layer controls. Generated geometry lives in `MoR_Room_Generated`; editable room records live in `MoR_Rooms`.

## Diagonal and curved corners

1. Select the room empty and click **Use Selected Room**.
2. Enable **Corner Points**, then click **Edit Corner Shape**.
3. Click a yellow corner point and drag. The edit distance snaps to the 2 m grid.
4. Drag toward the room for a diagonal cut. Cross outside the original corner to switch to a curve.
5. While dragging, press **C** to toggle diagonal/curve explicitly or **I** to invert the curve.

The add-on removes the original straight boundary modules covered by the edit. Diagonal paths distribute a small fitting adjustment across the subdivided 3x2 modules so the run ends exactly at its pillars. Curved paths deform those subdivided meshes continuously along the curve. Both preserve UVs, materials, wall thickness, and vertical proportions. **Reset Active Room Corners** restores the rectangular boundary.

With **Clip Ground to Shape** enabled, the add-on traces the room's final boundary—including straight, diagonal, and curved sections—and turns it into a temporary closed 3D footprint volume. Every generated 2x2 floor tile is Boolean-intersected with that footprint. Partially covered tiles are cut at the footprint, completely outside tiles are removed, and the original source asset is not modified. The temporary footprint is deleted after rebuilding.
