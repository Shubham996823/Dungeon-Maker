bl_info = {
    "name": "MoR Square Grid Builder",
    "author": "Master of Realms / Codex",
    "version": (0, 5, 0),
    "blender": (3, 6, 0),
    "location": "View3D > Sidebar > MoR Grid",
    "description": "Build multiple rectangular 2 m modular interiors from MoR asset pieces",
    "category": "Object",
}

import random
import re
from math import cos, floor, pi, sin

import bpy
from bpy.app.handlers import persistent
from bpy.props import BoolProperty, EnumProperty, FloatProperty, IntProperty, PointerProperty, StringProperty
from bpy.types import Operator, Panel, PropertyGroup
from bpy_extras import view3d_utils
from mathutils import Matrix, Vector
from mathutils.geometry import intersect_line_plane


ADDON_COLLECTION = "MoR_Grid_Generated"
PREVIEW_COLLECTION = "MoR_Grid_Preview"
CELL_SIZE = 2.0
WALL_HEIGHT = 3
CORNER_ARM = 1
FOOTPRINT_FLAG = "mor_is_footprint"
AUTO_REBUILD_DELAY = 0.25
_auto_rebuild_pending = False
_auto_rebuilding = False
_last_layout_signature = None

FLOOR_RE = re.compile(r"^FL(?P<x>\d+(?:\.\d+)?)x(?P<y>\d+(?:\.\d+)?)(?P<variant>[A-Za-z])$")
WALL_RE = re.compile(r"^W(?P<height>\d+)x(?P<length>\d+)(?P<variant>[A-Za-z])$")
CORNER_RE = re.compile(r"^CW(?P<side>[LR])(?P<height>\d+)x(?P<arm>\d+)(?P<variant>[A-Za-z])$")
PILLAR_RE = re.compile(r"^P(?P<height>\d+)_(?P<variant>[A-Za-z])$")


class MORGridProperties(PropertyGroup):
    asset_collection: PointerProperty(name="Source Collection", description="Collection containing the named modular mesh assets", type=bpy.types.Collection)
    origin_x: IntProperty(name="Start X", default=0)
    origin_y: IntProperty(name="Start Y", default=0)
    width_cells: IntProperty(name="Width", default=4, min=1)
    depth_cells: IntProperty(name="Depth", default=3, min=1)
    footprint_mode: EnumProperty(
        name="Footprint Mode",
        description="Choose how the footprint is defined",
        items=(
            ("NUMERIC", "Numeric", "Set the footprint with width/depth fields"),
            ("DRAW", "Draw", "Set the footprint by dragging a rectangle in the viewport"),
        ),
        default="NUMERIC",
    )
    floor_variant: StringProperty(name="Floor Variant", default="A", maxlen=1)
    wall_variant: StringProperty(name="Wall Variant", default="A", maxlen=1)
    corner_variant: StringProperty(name="Corner Variant", default="A", maxlen=1)
    pillar_variant: StringProperty(name="Pillar Variant", default="A", maxlen=1)
    randomize_walls: BoolProperty(name="Randomize Wall Variants", description="Choose between all available variants of the same wall length", default=True)
    random_seed: IntProperty(name="Random Seed", description="Use a different seed to reshuffle wall variants while keeping results reproducible", default=1, min=0)
    add_pillars: BoolProperty(name="Add Corner Pillars", description="Place a pillar at each outer room corner", default=False)
    pillar_inset: FloatProperty(name="Pillar Inset", description="Move each corner pillar diagonally toward the room interior", default=0.30, min=0.0, max=2.0, unit="LENGTH")
    scan_status: StringProperty(default="Choose the collection that contains your modular pieces.")


def collection_by_name(name):
    return bpy.data.collections.get(name)


def ensure_scene_collection(name):
    collection = collection_by_name(name)
    if collection is None:
        collection = bpy.data.collections.new(name)
        bpy.context.scene.collection.children.link(collection)
    return collection


def clear_collection(name):
    collection = collection_by_name(name)
    if collection is not None:
        for obj in list(collection.objects):
            bpy.data.objects.remove(obj, do_unlink=True)


def scan_assets(collection):
    assets = {"floors": {}, "walls": {}, "corners": {}, "pillars": {}, "unknown": []}
    if collection is None:
        return assets
    for obj in collection.all_objects:
        if obj.type != "MESH":
            continue
        match = FLOOR_RE.match(obj.name)
        if match:
            assets["floors"][(float(match["x"]), float(match["y"]), match["variant"].upper())] = obj
            continue
        match = WALL_RE.match(obj.name)
        if match:
            assets["walls"][(int(match["height"]), int(match["length"]), match["variant"].upper())] = obj
            continue
        match = CORNER_RE.match(obj.name)
        if match:
            assets["corners"][(match["side"], int(match["height"]), int(match["arm"]), match["variant"].upper())] = obj
            continue
        match = PILLAR_RE.match(obj.name)
        if match:
            assets["pillars"][(int(match["height"]), match["variant"].upper())] = obj
            continue
        assets["unknown"].append(obj.name)
    return assets


def get_variants(table, keys):
    compatible = [(key, obj) for key, obj in table.items() if key[:-1] == tuple(keys)]
    return [obj for _, obj in sorted(compatible, key=lambda item: item[0][-1])]


def get_variant(table, keys, requested_variant):
    exact = tuple(keys) + (requested_variant.upper(),)
    return table.get(exact) or (get_variants(table, keys) or [None])[0]


def duplicate_asset(source, target_collection, location, rotation_z=0.0, name=None):
    obj = source.copy()
    obj.data = source.data
    obj.animation_data_clear()
    obj.location = Vector(location)
    obj.rotation_euler = (0.0, 0.0, rotation_z)
    obj.scale = source.scale.copy()
    obj.name = name or source.name
    target_collection.objects.link(obj)
    return obj


def choose_wall_variant(walls, length, variant, randomize, rng):
    return (rng.choice(get_variants(walls, (WALL_HEIGHT, length))) if randomize and get_variants(walls, (WALL_HEIGHT, length)) else get_variant(walls, (WALL_HEIGHT, length), variant))


def pack_wall_run(length, walls, variant, randomize, rng):
    result, remaining = [], int(round(length))
    for segment_length in (4, 2, 1):
        while remaining >= segment_length:
            source = choose_wall_variant(walls, segment_length, variant, randomize, rng)
            if source is None:
                break
            result.append((segment_length, source))
            remaining -= segment_length
    if remaining:
        raise ValueError(f"No compatible wall pieces can fill the final {remaining} m of a wall run.")
    return result


def place_run(target, start, rotation, length, walls, variant, randomize, rng, prefix):
    cursor, direction = Vector(start), Vector((cos(rotation), sin(rotation), 0.0))
    for index, (segment_length, source) in enumerate(pack_wall_run(length, walls, variant, randomize, rng)):
        duplicate_asset(source, target, cursor, rotation, f"{prefix}_{index:02d}_{source.name}")
        cursor += direction * segment_length


def required_assets(assets, props):
    floor = get_variant(assets["floors"], (CELL_SIZE, CELL_SIZE), props.floor_variant)
    cwl = get_variant(assets["corners"], ("L", WALL_HEIGHT, CORNER_ARM), props.corner_variant)
    cwr = get_variant(assets["corners"], ("R", WALL_HEIGHT, CORNER_ARM), props.corner_variant)
    if floor is None:
        raise ValueError("Missing FL2x2 floor mesh. Its object name must match FL2x2A.")
    if cwl is None or cwr is None:
        raise ValueError("Missing CWL3x1 or CWR3x1 corner mesh.")
    for length in (2, 4):
        if get_variant(assets["walls"], (WALL_HEIGHT, length), props.wall_variant) is None:
            raise ValueError(f"Missing W3x{length} wall mesh.")
    return floor, cwl, cwr


def build_rectangle(props):
    assets = scan_assets(props.asset_collection)
    floor, cwl, cwr = required_assets(assets, props)
    generated = ensure_scene_collection(ADDON_COLLECTION)
    x0, y0 = props.origin_x * CELL_SIZE, props.origin_y * CELL_SIZE
    room_width, room_depth = props.width_cells * CELL_SIZE, props.depth_cells * CELL_SIZE
    rng = random.Random(props.random_seed)
    room_tag = f"X{props.origin_x}_Y{props.origin_y}"
    new_room_objects = []

    def add_part(source, position, rotation, name):
        part = duplicate_asset(source, generated, position, rotation, name)
        new_room_objects.append(part)
        return part

    for row in range(props.depth_cells):
        for column in range(props.width_cells):
            add_part(floor, (x0 + column * CELL_SIZE, y0 + row * CELL_SIZE, 0.0), 0.0, f"{room_tag}_Floor_{column:02d}_{row:02d}_{floor.name}")

    for label, source, position, rotation in (
        ("SW", cwl, (x0, y0, 0.0), 0.0), ("SE", cwr, (x0 + room_width, y0, 0.0), 0.0),
        ("NE", cwl, (x0 + room_width, y0 + room_depth, 0.0), pi), ("NW", cwr, (x0, y0 + room_depth, 0.0), pi),
    ):
        add_part(source, position, rotation, f"{room_tag}_Corner_{label}_{source.name}")

    horizontal_run, vertical_run = room_width - 2 * CORNER_ARM, room_depth - 2 * CORNER_ARM
    if horizontal_run > 0:
        for start, rotation, label in (((x0 + CORNER_ARM, y0, 0.0), 0.0, "S"), ((x0 + room_width - CORNER_ARM, y0 + room_depth, 0.0), pi, "N")):
            before = set(generated.objects)
            place_run(generated, start, rotation, horizontal_run, assets["walls"], props.wall_variant, props.randomize_walls, rng, f"{room_tag}_Wall_{label}")
            new_room_objects.extend(set(generated.objects) - before)
    if vertical_run > 0:
        for start, rotation, label in (((x0 + room_width, y0 + CORNER_ARM, 0.0), pi / 2, "E"), ((x0, y0 + room_depth - CORNER_ARM, 0.0), 3 * pi / 2, "W")):
            before = set(generated.objects)
            place_run(generated, start, rotation, vertical_run, assets["walls"], props.wall_variant, props.randomize_walls, rng, f"{room_tag}_Wall_{label}")
            new_room_objects.extend(set(generated.objects) - before)

    if props.add_pillars:
        pillar = get_variant(assets["pillars"], (WALL_HEIGHT,), props.pillar_variant)
        if pillar is None:
            raise ValueError("Pillars are enabled but no P3_A-style mesh was found.")
        inset = props.pillar_inset
        for label, position in (("SW", (x0 + inset, y0 + inset, 0.0)), ("SE", (x0 + room_width - inset, y0 + inset, 0.0)), ("NE", (x0 + room_width - inset, y0 + room_depth - inset, 0.0)), ("NW", (x0 + inset, y0 + room_depth - inset, 0.0))):
            add_part(pillar, position, 0.0, f"{room_tag}_Pillar_{label}_{pillar.name}")

    # Build every modular piece first. Only then create the room pivot and parent
    # the completed room, so parenting cannot influence the placement calculations.
    footprint_pivot = build_preview(props)
    for part in new_room_objects:
        part.parent = footprint_pivot
        part.matrix_parent_inverse = footprint_pivot.matrix_world.inverted()
    return len(generated.objects)


def build_preview(props):
    preview = ensure_scene_collection(PREVIEW_COLLECTION)
    pivot_name = f"Footprint_X{props.origin_x}_Y{props.origin_y}"
    pivot = preview.objects.get(pivot_name)
    if pivot is not None and pivot.type != "EMPTY":
        pivot.name = f"{pivot_name}_Preview"
        pivot = None
    if pivot is None:
        pivot = bpy.data.objects.new(pivot_name, None)
        pivot.empty_display_type = "PLAIN_AXES"
        pivot.empty_display_size = 0.6
        preview.objects.link(pivot)
    pivot.location = (
        (props.origin_x + props.width_cells / 2) * CELL_SIZE,
        (props.origin_y + props.depth_cells / 2) * CELL_SIZE,
        0.0,
    )
    # These values make the footprint self-contained: it can be moved later
    # without relying on the sidebar's current width/depth fields.
    pivot[FOOTPRINT_FLAG] = True
    pivot["mor_width_cells"] = props.width_cells
    pivot["mor_depth_cells"] = props.depth_cells

    preview_name = f"{pivot_name}_Outline"
    obj = preview.objects.get(preview_name)
    if obj is None:
        mesh = bpy.data.meshes.new(preview_name)
        obj = bpy.data.objects.new(preview_name, mesh)
        obj.display_type, obj.show_in_front = "WIRE", True
        preview.objects.link(obj)
    obj.parent = pivot
    obj.matrix_parent_inverse = Matrix.Identity(4)
    obj.location = (0.0, 0.0, 0.0)
    x0, y0, z = -props.width_cells * CELL_SIZE / 2, -props.depth_cells * CELL_SIZE / 2, 0.02
    vertices, edges = [], []
    for row in range(props.depth_cells):
        for column in range(props.width_cells):
            x, y, start = x0 + column * CELL_SIZE, y0 + row * CELL_SIZE, len(vertices)
            vertices.extend(((x, y, z), (x + CELL_SIZE, y, z), (x + CELL_SIZE, y + CELL_SIZE, z), (x, y + CELL_SIZE, z)))
            edges.extend(((start, start + 1), (start + 1, start + 2), (start + 2, start + 3), (start + 3, start)))
    obj.data.clear_geometry()
    obj.data.from_pydata(vertices, edges, [])
    obj.data.update()
    return pivot


def footprint_pivots(scene):
    """Return all saved room parents, sorted for deterministic rebuilds."""
    preview = collection_by_name(PREVIEW_COLLECTION)
    if preview is None:
        return []
    pivots = []
    for obj in preview.objects:
        if obj.type != "EMPTY":
            continue
        # Upgrade footprint parents created by the previous script revision.
        if not obj.get(FOOTPRINT_FLAG) and obj.name.startswith("Footprint_X"):
            outline = next((child for child in obj.children if child.type == "MESH"), None)
            if outline is not None and outline.data.vertices:
                xs = [vertex.co.x for vertex in outline.data.vertices]
                ys = [vertex.co.y for vertex in outline.data.vertices]
                obj[FOOTPRINT_FLAG] = True
                obj["mor_width_cells"] = max(1, round((max(xs) - min(xs)) / CELL_SIZE))
                obj["mor_depth_cells"] = max(1, round((max(ys) - min(ys)) / CELL_SIZE))
        if obj.get(FOOTPRINT_FLAG):
            pivots.append(obj)
    return sorted(pivots, key=lambda obj: obj.name)


def layout_signature(scene):
    return tuple(
        (pivot.name, round(pivot.location.x, 4), round(pivot.location.y, 4),
         int(pivot.get("mor_width_cells", 0)), int(pivot.get("mor_depth_cells", 0)))
        for pivot in footprint_pivots(scene)
    )


def footprint_grid_origin(pivot):
    """Snap a footprint parent to the 2 m grid and return its lower-left cell."""
    width = int(pivot["mor_width_cells"])
    depth = int(pivot["mor_depth_cells"])
    origin_x = round(pivot.location.x / CELL_SIZE - width / 2)
    origin_y = round(pivot.location.y / CELL_SIZE - depth / 2)
    pivot.location.x = (origin_x + width / 2) * CELL_SIZE
    pivot.location.y = (origin_y + depth / 2) * CELL_SIZE
    return origin_x, origin_y, width, depth


def parent_preserving_world_transform(obj, parent):
    obj.parent = parent
    obj.matrix_parent_inverse = parent.matrix_world.inverted()
    obj.hide_viewport = False
    obj.hide_render = False


def rebuild_merged_outline(cells):
    """Show one wire outline around the union, not one rectangle per room."""
    preview = ensure_scene_collection(PREVIEW_COLLECTION)
    obj = preview.objects.get("MoR_Merged_Footprint_Outline")
    if obj is None:
        mesh = bpy.data.meshes.new("MoR_Merged_Footprint_Outline")
        obj = bpy.data.objects.new("MoR_Merged_Footprint_Outline", mesh)
        obj.display_type, obj.show_in_front = "WIRE", True
        preview.objects.link(obj)
    vertices, edges = [], []
    for (cell_x, cell_y) in cells:
        x, y = cell_x * CELL_SIZE, cell_y * CELL_SIZE
        for dx, dy, points in (
            (0, -1, ((x, y, 0.02), (x + CELL_SIZE, y, 0.02))),
            (1, 0, ((x + CELL_SIZE, y, 0.02), (x + CELL_SIZE, y + CELL_SIZE, 0.02))),
            (0, 1, ((x + CELL_SIZE, y + CELL_SIZE, 0.02), (x, y + CELL_SIZE, 0.02))),
            (-1, 0, ((x, y + CELL_SIZE, 0.02), (x, y, 0.02))),
        ):
            if (cell_x + dx, cell_y + dy) not in cells:
                start = len(vertices)
                vertices.extend(points)
                edges.append((start, start + 1))
    obj.data.clear_geometry()
    obj.data.from_pydata(vertices, edges, [])
    obj.data.update()
    for pivot in cells.values():
        for child in pivot.children:
            # Keep only the old, per-room wire previews hidden. Generated
            # floors and walls are also children of the footprint parent.
            if child.type == "MESH" and child.name.endswith("_Outline"):
                child.hide_viewport = True


def boundary_runs(cells):
    """Join exposed cell edges into directional, continuous wall runs."""
    groups = {}
    for (cell_x, cell_y), owner in cells.items():
        for side, dx, dy, line, coordinate in (
            ("S", 0, -1, cell_y, cell_x),
            ("E", 1, 0, cell_x + 1, cell_y),
            ("N", 0, 1, cell_y + 1, cell_x),
            ("W", -1, 0, cell_x, cell_y),
        ):
            if (cell_x + dx, cell_y + dy) not in cells:
                groups.setdefault((side, line), []).append((coordinate, owner))
    runs = []
    for (side, line), segments in groups.items():
        segments.sort(key=lambda item: item[0])
        start, owner = segments[0]
        previous = start
        for coordinate, next_owner in segments[1:]:
            if coordinate != previous + 1:
                runs.append((side, line, start, previous - start + 1, owner))
                start, owner = coordinate, next_owner
            previous = coordinate
        runs.append((side, line, start, previous - start + 1, owner))
    return runs


def cells_at_vertex(cells, vertex_x, vertex_y):
    return [
        (cell_x, cell_y) for cell_x, cell_y in (
            (vertex_x - 1, vertex_y - 1), (vertex_x - 1, vertex_y),
            (vertex_x, vertex_y - 1), (vertex_x, vertex_y),
        ) if (cell_x, cell_y) in cells
    ]


def add_perimeter_run(generated, cells, side, line, start, cell_length, owner, assets, props, rng):
    """Place a run with 1 m corner reservations at its convex endpoints."""
    if side in {"S", "N"}:
        low_vertex, high_vertex = (start, line), (start + cell_length, line)
    else:
        low_vertex, high_vertex = (line, start), (line, start + cell_length)
    reserve_low = CORNER_ARM if len(cells_at_vertex(cells, *low_vertex)) == 1 else 0
    reserve_high = CORNER_ARM if len(cells_at_vertex(cells, *high_vertex)) == 1 else 0
    length = cell_length * CELL_SIZE - reserve_low - reserve_high
    if length <= 0:
        return
    if side == "S":
        position, rotation = ((start * CELL_SIZE + reserve_low, line * CELL_SIZE, 0.0), 0.0)
    elif side == "N":
        position, rotation = (((start + cell_length) * CELL_SIZE - reserve_high, line * CELL_SIZE, 0.0), pi)
    elif side == "E":
        position, rotation = ((line * CELL_SIZE, start * CELL_SIZE + reserve_low, 0.0), pi / 2)
    else:
        position, rotation = ((line * CELL_SIZE, (start + cell_length) * CELL_SIZE - reserve_high, 0.0), 3 * pi / 2)
    cursor = Vector(position)
    direction = Vector((cos(rotation), sin(rotation), 0.0))
    for index, (segment_length, source) in enumerate(
        pack_wall_run(length, assets["walls"], props.wall_variant, props.randomize_walls, rng)
    ):
        part = duplicate_asset(source, generated, cursor, rotation, f"Wall_{side}_{start}_{line}_{index:02d}_{source.name}")
        parent_preserving_world_transform(part, owner)
        cursor += direction * segment_length


def add_union_corners_and_pillars(generated, cells, assets, props):
    cwl = get_variant(assets["corners"], ("L", WALL_HEIGHT, CORNER_ARM), props.corner_variant)
    cwr = get_variant(assets["corners"], ("R", WALL_HEIGHT, CORNER_ARM), props.corner_variant)
    pillar = get_variant(assets["pillars"], (WALL_HEIGHT,), props.pillar_variant) if props.add_pillars else None
    vertices = {(x, y) for x, y in cells}
    vertices.update((x + 1, y) for x, y in cells)
    vertices.update((x, y + 1) for x, y in cells)
    vertices.update((x + 1, y + 1) for x, y in cells)
    for vertex_x, vertex_y in vertices:
        adjacent = cells_at_vertex(cells, vertex_x, vertex_y)
        count = len(adjacent)
        if count not in {1, 3}:
            continue
        world = (vertex_x * CELL_SIZE, vertex_y * CELL_SIZE, 0.0)
        owner = cells[adjacent[0]]
        if count == 1:
            cell_x, cell_y = adjacent[0]
            if (cell_x, cell_y) == (vertex_x, vertex_y):
                corner, rotation = cwl, 0.0          # SW
            elif (cell_x, cell_y) == (vertex_x - 1, vertex_y):
                corner, rotation = cwr, 0.0          # SE
            elif (cell_x, cell_y) == (vertex_x - 1, vertex_y - 1):
                corner, rotation = cwl, pi           # NE
            else:
                corner, rotation = cwr, pi           # NW
            if corner is not None:
                part = duplicate_asset(corner, generated, world, rotation, f"Corner_X{vertex_x}_Y{vertex_y}_{corner.name}")
                parent_preserving_world_transform(part, owner)
            if pillar is not None:
                inset_x = props.pillar_inset if cell_x == vertex_x else -props.pillar_inset
                inset_y = props.pillar_inset if cell_y == vertex_y else -props.pillar_inset
                part = duplicate_asset(pillar, generated, (world[0] + inset_x, world[1] + inset_y, 0.0), 0.0, f"Pillar_Corner_X{vertex_x}_Y{vertex_y}_{pillar.name}")
                parent_preserving_world_transform(part, owner)
        elif pillar is not None:
            # A three-cell vertex is the inside corner created where rooms join.
            part = duplicate_asset(pillar, generated, world, 0.0, f"Pillar_Junction_X{vertex_x}_Y{vertex_y}_{pillar.name}")
            parent_preserving_world_transform(part, owner)


def rebuild_merged_layout(scene):
    """Rebuild all rooms as one union of grid cells.

    A cell edge gets a wall only when the neighbouring cell is empty. Therefore
    rooms that touch share an open connection automatically, while separated
    rooms retain their complete exterior perimeter.
    """
    global _auto_rebuilding, _last_layout_signature
    props = scene.mor_grid
    if props.asset_collection is None:
        return 0
    pivots = footprint_pivots(scene)
    if not pivots:
        return 0
    assets = scan_assets(props.asset_collection)
    floor = get_variant(assets["floors"], (CELL_SIZE, CELL_SIZE), props.floor_variant)
    if floor is None:
        raise ValueError("Automatic room merging requires an FL2x2 floor mesh.")

    # A cell belongs to the first footprint that claims it. Overlaps therefore
    # never create duplicate floor tiles or duplicate walls.
    cells = {}
    for pivot in pivots:
        origin_x, origin_y, width, depth = footprint_grid_origin(pivot)
        for row in range(depth):
            for column in range(width):
                cells.setdefault((origin_x + column, origin_y + row), pivot)

    generated = ensure_scene_collection(ADDON_COLLECTION)
    _auto_rebuilding = True
    try:
        clear_collection(ADDON_COLLECTION)
        for (cell_x, cell_y), pivot in cells.items():
            x, y = cell_x * CELL_SIZE, cell_y * CELL_SIZE
            part = duplicate_asset(floor, generated, (x, y, 0.0), 0.0, f"Floor_X{cell_x}_Y{cell_y}_{floor.name}")
            parent_preserving_world_transform(part, pivot)
        rng = random.Random(props.random_seed)
        for run in boundary_runs(cells):
            add_perimeter_run(generated, cells, *run, assets, props, rng)
        add_union_corners_and_pillars(generated, cells, assets, props)
        rebuild_merged_outline(cells)
    finally:
        _auto_rebuilding = False
    _last_layout_signature = layout_signature(scene)
    return len(generated.objects)


def _auto_rebuild_timer():
    global _auto_rebuild_pending
    _auto_rebuild_pending = False
    if _auto_rebuilding:
        return None
    try:
        rebuild_merged_layout(bpy.context.scene)
    except (ReferenceError, ValueError):
        # Missing assets are reported by the manual build button instead.
        pass
    return None


@persistent
def mor_footprint_move_handler(scene, depsgraph):
    global _auto_rebuild_pending
    if _auto_rebuilding or _auto_rebuild_pending:
        return
    for update in depsgraph.updates:
        obj = update.id
        if isinstance(obj, bpy.types.Object) and obj.type == "EMPTY" and obj.get(FOOTPRINT_FLAG):
            if layout_signature(scene) == _last_layout_signature:
                return
            _auto_rebuild_pending = True
            bpy.app.timers.register(_auto_rebuild_timer, first_interval=AUTO_REBUILD_DELAY)
            break


def build_drag_preview(origin_x, origin_y, width_cells, depth_cells):
    """Refresh only the active drag outline; saved previews are never touched."""
    preview = ensure_scene_collection(PREVIEW_COLLECTION)
    obj = preview.objects.get("MoR_Drawing_Preview")
    if obj is None:
        mesh = bpy.data.meshes.new("MoR_Drawing_Preview")
        obj = bpy.data.objects.new("MoR_Drawing_Preview", mesh)
        obj.display_type = "WIRE"
        obj.show_in_front = True
        preview.objects.link(obj)
    x0, y0, z = origin_x * CELL_SIZE, origin_y * CELL_SIZE, 0.03
    vertices, edges = [], []
    for row in range(depth_cells):
        for column in range(width_cells):
            x, y, start = x0 + column * CELL_SIZE, y0 + row * CELL_SIZE, len(vertices)
            vertices.extend(((x, y, z), (x + CELL_SIZE, y, z), (x + CELL_SIZE, y + CELL_SIZE, z), (x, y + CELL_SIZE, z)))
            edges.extend(((start, start + 1), (start + 1, start + 2), (start + 2, start + 3), (start + 3, start)))
    obj.data.clear_geometry()
    obj.data.from_pydata(vertices, edges, [])
    obj.data.update()


def clear_drag_preview():
    obj = bpy.data.objects.get("MoR_Drawing_Preview")
    if obj is not None:
        bpy.data.objects.remove(obj, do_unlink=True)


class MOR_OT_scan_assets(Operator):
    bl_idname, bl_label = "mor_grid.scan_assets", "Scan Modular Assets"
    def execute(self, context):
        props = context.scene.mor_grid
        if props.asset_collection is None:
            self.report({"ERROR"}, "Choose a source collection first.")
            return {"CANCELLED"}
        assets = scan_assets(props.asset_collection)
        props.scan_status = f"Floors: {len(assets['floors'])} | Walls: {len(assets['walls'])} | Corners: {len(assets['corners'])} | Pillars: {len(assets['pillars'])}"
        self.report({"INFO"}, props.scan_status)
        return {"FINISHED"}


class MOR_OT_preview_footprint(Operator):
    bl_idname, bl_label = "mor_grid.preview_footprint", "Add Footprint Preview"
    def execute(self, context):
        build_preview(context.scene.mor_grid)
        return {"FINISHED"}


class MOR_OT_clear_preview(Operator):
    bl_idname, bl_label = "mor_grid.clear_preview", "Clear All Previews"
    def execute(self, context):
        clear_collection(PREVIEW_COLLECTION)
        return {"FINISHED"}


NAV_PASSTHROUGH_TYPES = {
    "MIDDLEMOUSE", "WHEELUPMOUSE", "WHEELDOWNMOUSE",
    "NUMPAD_0", "NUMPAD_1", "NUMPAD_2", "NUMPAD_3", "NUMPAD_4",
    "NUMPAD_5", "NUMPAD_6", "NUMPAD_7", "NUMPAD_8", "NUMPAD_9",
    "NUMPAD_PERIOD", "NUMPAD_PLUS", "NUMPAD_MINUS",
}


class MOR_OT_draw_footprint(Operator):
    bl_idname = "mor_grid.draw_footprint"
    bl_label = "Draw Footprint"
    bl_description = "Click and drag in the viewport to add a rectangular footprint of 2 m cells"

    _start_cell = None
    _current_cell = None
    _dragging = False

    def _mouse_to_cell(self, context, event):
        region = context.region
        rv3d = context.region_data
        if region is None or region.type != "WINDOW" or rv3d is None:
            return None
        coord = (event.mouse_region_x, event.mouse_region_y)
        origin = view3d_utils.region_2d_to_origin_3d(region, rv3d, coord)
        direction = view3d_utils.region_2d_to_vector_3d(region, rv3d, coord)
        hit = intersect_line_plane(origin, origin + direction, Vector((0.0, 0.0, 0.0)), Vector((0.0, 0.0, 1.0)))
        return None if hit is None else (floor(hit.x / CELL_SIZE), floor(hit.y / CELL_SIZE))

    def _rect_from_cells(self):
        (col_a, row_a), (col_b, row_b) = self._start_cell, self._current_cell
        col_min, col_max = sorted((col_a, col_b))
        row_min, row_max = sorted((row_a, row_b))
        return col_min, row_min, col_max - col_min + 1, row_max - row_min + 1

    def invoke(self, context, event):
        if context.area is None or context.area.type != "VIEW_3D":
            self.report({"ERROR"}, "Run this from the 3D Viewport.")
            return {"CANCELLED"}
        self._start_cell = self._current_cell = None
        self._dragging = False
        context.workspace.status_text_set("MoR Grid: click and drag to draw a room footprint | Esc / right-click to cancel")
        context.window_manager.modal_handler_add(self)
        return {"RUNNING_MODAL"}

    def modal(self, context, event):
        if event.type in NAV_PASSTHROUGH_TYPES:
            return {"PASS_THROUGH"}
        if event.type == "MOUSEMOVE":
            cell = self._mouse_to_cell(context, event)
            if cell is not None:
                self._current_cell = cell
                if self._dragging:
                    build_drag_preview(*self._rect_from_cells())
            return {"RUNNING_MODAL"}
        if event.type == "LEFTMOUSE" and event.value == "PRESS":
            cell = self._mouse_to_cell(context, event)
            if cell is not None:
                self._start_cell = self._current_cell = cell
                self._dragging = True
                build_drag_preview(*self._rect_from_cells())
            return {"RUNNING_MODAL"}
        if event.type == "LEFTMOUSE" and event.value == "RELEASE" and self._dragging:
            origin_x, origin_y, width_cells, depth_cells = self._rect_from_cells()
            props = context.scene.mor_grid
            props.origin_x, props.origin_y = origin_x, origin_y
            props.width_cells, props.depth_cells = width_cells, depth_cells
            clear_drag_preview()
            build_preview(props)
            context.workspace.status_text_set(None)
            self.report({"INFO"}, f"Added {width_cells}×{depth_cells} cell footprint at ({origin_x}, {origin_y}).")
            return {"FINISHED"}
        if event.type in {"RIGHTMOUSE", "ESC"}:
            clear_drag_preview()
            context.workspace.status_text_set(None)
            self.report({"INFO"}, "Footprint drawing cancelled.")
            return {"CANCELLED"}
        return {"RUNNING_MODAL"}


class MOR_OT_build_grid(Operator):
    bl_idname, bl_label = "mor_grid.build_grid", "Build / Rebuild Layout"
    def execute(self, context):
        props = context.scene.mor_grid
        if props.asset_collection is None:
            self.report({"ERROR"}, "Choose the modular asset source collection first.")
            return {"CANCELLED"}
        try:
            build_preview(props)
            count = rebuild_merged_layout(context.scene)
        except ValueError as error:
            self.report({"ERROR"}, str(error))
            return {"CANCELLED"}
        self.report({"INFO"}, f"Built merged layout with {count} linked modular objects.")
        return {"FINISHED"}


class MOR_OT_clear_generated(Operator):
    bl_idname, bl_label = "mor_grid.clear_generated", "Clear Entire Building"
    def execute(self, context):
        clear_collection(ADDON_COLLECTION)
        self.report({"INFO"}, "Removed all generated MoR grid objects.")
        return {"FINISHED"}


class MOR_PT_square_grid(Panel):
    bl_label, bl_idname = "MoR Square Grid", "MOR_PT_square_grid"
    bl_space_type, bl_region_type, bl_category = "VIEW_3D", "UI", "MoR Grid"
    def draw(self, context):
        layout, props = self.layout, context.scene.mor_grid
        box = layout.box(); box.label(text="Asset Library", icon="OUTLINER_COLLECTION"); box.prop(props, "asset_collection"); box.operator("mor_grid.scan_assets", icon="VIEWZOOM"); box.label(text=props.scan_status, icon="INFO")
        box = layout.box(); box.label(text="Grid & Footprint", icon="GRID"); box.label(text="Floor cells: 2 m × 2 m")
        box.row(align=True).prop(props, "footprint_mode", expand=True)
        if props.footprint_mode == "NUMERIC":
            row = box.row(align=True); row.prop(props, "origin_x"); row.prop(props, "origin_y")
            row = box.row(align=True); row.prop(props, "width_cells"); row.prop(props, "depth_cells")
        else:
            box.label(text=f"Current: {props.width_cells} × {props.depth_cells} cells at ({props.origin_x}, {props.origin_y})", icon="INFO")
            box.operator("mor_grid.draw_footprint", icon="GREASEPENCIL")
        row = box.row(align=True); row.operator("mor_grid.preview_footprint", icon="HIDE_OFF"); row.operator("mor_grid.clear_preview", icon="X")
        box = layout.box(); box.label(text="Build Settings", icon="MOD_BUILD"); box.prop(props, "floor_variant"); box.prop(props, "wall_variant"); box.prop(props, "randomize_walls")
        if props.randomize_walls: box.prop(props, "random_seed")
        box.prop(props, "corner_variant"); box.prop(props, "add_pillars")
        if props.add_pillars: box.prop(props, "pillar_variant"); box.prop(props, "pillar_inset")
        box.label(text="Straight walls: 4 m → 2 m → 1 m", icon="SORTSIZE")
        box.label(text="Auto-merge uses 2 m perimeter wall segments.", icon="INFO")
        layout.separator(); layout.operator("mor_grid.build_grid", icon="OUTLINER_OB_MESH"); layout.operator("mor_grid.clear_generated", icon="TRASH")


CLASSES = (MORGridProperties, MOR_OT_scan_assets, MOR_OT_preview_footprint, MOR_OT_clear_preview, MOR_OT_draw_footprint, MOR_OT_build_grid, MOR_OT_clear_generated, MOR_PT_square_grid)

def register():
    for cls in CLASSES: bpy.utils.register_class(cls)
    bpy.types.Scene.mor_grid = PointerProperty(type=MORGridProperties)
    if mor_footprint_move_handler not in bpy.app.handlers.depsgraph_update_post:
        bpy.app.handlers.depsgraph_update_post.append(mor_footprint_move_handler)

def unregister():
    if mor_footprint_move_handler in bpy.app.handlers.depsgraph_update_post:
        bpy.app.handlers.depsgraph_update_post.remove(mor_footprint_move_handler)
    del bpy.types.Scene.mor_grid
    for cls in reversed(CLASSES): bpy.utils.unregister_class(cls)

if __name__ == "__main__":
    register()
