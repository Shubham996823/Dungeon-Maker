bl_info = {
    "name": "MoR Room Builder",
    "author": "Master of Realms / Codex",
    "version": (2, 0, 8),
    "blender": (3, 6, 0),
    "location": "View3D > Sidebar > MoR Builder",
    "description": "Build merged 2 m modular rooms with layered walls and corner pillars",
    "category": "Object",
}

import json
import re
from math import atan2, ceil, cos, floor, hypot, pi, sin, sqrt
from pathlib import Path

import bpy
from bpy.props import BoolProperty, FloatProperty, IntProperty, PointerProperty, StringProperty
from bpy.types import Operator, Panel, PropertyGroup
from bpy_extras import view3d_utils
from mathutils import Vector
from mathutils.geometry import intersect_line_plane, tessellate_polygon


CELL = 2.0
ROOM_FLAG = "mor_room"
ROOM_CELLS = "mor_cells"
ROOM_CORNERS = "mor_corner_edits"
ROOM_CIRCLES = "mor_circles"
ROOMS_COLLECTION = "MoR_Rooms"
ASSET_COLLECTION = "MoR_Asset_Library"
GENERATED_COLLECTION = "MoR_Room_Generated"
DRAW_PREVIEW_COLLECTION = "MoR_Room_Draw_Preview"
FLOOR_RE = re.compile(r"^FL2x2_?(?P<v>[0-9]+|[A-Za-z])$", re.IGNORECASE)
WALL_RE = re.compile(r"^(?:W2\.5x2_|W3x2)(?P<v>[0-9]+|[A-Za-z])$", re.IGNORECASE)
PILLAR_RE = re.compile(r"^(?:P_?2\.5_|P3_)(?P<v>[0-9]+|[A-Za-z])$", re.IGNORECASE)


def asset_name(name):
    # Strip only Blender's duplicate suffix, never the decimal height in W2.5.
    return re.sub(r"\.\d{3,}$", "", name)


def library_files(folder):
    """Accept the assets root or models folder; recover legacy project floors."""
    model_folder = folder / "models" if (folder / "models").is_dir() else folder
    files = sorted(p for p in model_folder.iterdir()
                   if p.suffix.lower() in {".glb", ".gltf"}
                   and any(pattern.fullmatch(p.stem) for pattern in (FLOOR_RE, WALL_RE, PILLAR_RE)))
    if not any(FLOOR_RE.fullmatch(p.stem) for p in files):
        # This project moved walls/pillars to assets/models but retained floors
        # in public/models. Do not search arbitrary folders or import cut walls.
        if model_folder.name == "models" and model_folder.parent.name == "assets":
            legacy = model_folder.parent.parent / "public" / "models"
            if legacy.is_dir():
                files.extend(sorted(p for p in legacy.iterdir()
                                    if p.suffix.lower() in {".glb", ".gltf"}
                                    and FLOOR_RE.fullmatch(p.stem)))
    return files


def ensure_collection(name, hide=False):
    collection = bpy.data.collections.get(name)
    if collection is None:
        collection = bpy.data.collections.new(name)
        bpy.context.scene.collection.children.link(collection)
    collection.hide_render = hide
    collection.hide_viewport = hide
    return collection


def clear_collection(name):
    collection = bpy.data.collections.get(name)
    if collection:
        for obj in list(collection.objects):
            bpy.data.objects.remove(obj, do_unlink=True)


def move_to_collection(obj, collection):
    for old in list(obj.users_collection):
        old.objects.unlink(obj)
    collection.objects.link(obj)


def scan_assets(collection):
    found = {"floor": {}, "wall": {}, "pillar": {}}
    if not collection:
        return found
    for obj in collection.all_objects:
        if obj.type != "MESH":
            continue
        name = asset_name(obj.name)
        match = FLOOR_RE.match(name)
        if match:
            found["floor"][match["v"].upper()] = obj
            continue
        match = WALL_RE.match(name)
        if match:
            found["wall"][match["v"].upper()] = obj
            continue
        match = PILLAR_RE.match(name)
        if match:
            found["pillar"][match["v"].upper()] = obj
    return found


def variant(table, requested):
    requested = str(requested or "A").strip().upper()
    if requested in table:
        return table[requested]
    # Old saved rooms request A/B/C. Resolve these to numbered variants when
    # using a new library, without overriding an explicitly named legacy asset.
    if len(requested) == 1 and "A" <= requested <= "Z":
        numbered = str(ord(requested) - ord("A") + 1)
        if numbered in table:
            return table[numbered]
    if requested.isdigit() and 1 <= int(requested) <= 26:
        letter = chr(ord("A") + int(requested) - 1)
        if letter in table:
            return table[letter]
    keys = sorted(table, key=lambda key: (0, int(key)) if key.isdigit() else (1, key))
    return table.get("A") or (table[keys[0]] if keys else None)


def duplicate(source, collection, location, rotation, name):
    obj = source.copy()
    if source.data:
        obj.data = source.data
    collection.objects.link(obj)
    obj.hide_viewport = False
    obj.hide_render = False
    obj.hide_set(False)
    obj.location = location
    obj.rotation_euler = (0.0, 0.0, rotation)
    obj.scale = source.scale.copy()  # never stretch the 3x2 module
    obj.name = name
    return obj


def wall_module_depth(source):
    """Physical transverse depth used to keep opposing shared meshes disjoint."""
    if not source or source.type != "MESH" or not source.data.vertices:
        return 0.0
    values = [vertex.co.y for vertex in source.data.vertices]
    return (max(values) - min(values)) * abs(source.scale.y)


def room_objects():
    collection = bpy.data.collections.get(ROOMS_COLLECTION)
    return [obj for obj in collection.objects if obj.get(ROOM_FLAG)] if collection else []


def read_cells(room):
    try:
        return {tuple(item) for item in json.loads(room.get(ROOM_CELLS, "[]"))}
    except (TypeError, ValueError):
        return set()


def write_cells(room, cells):
    room[ROOM_CELLS] = json.dumps(sorted([list(cell) for cell in cells]))


def room_style(room, props):
    return {
        "inner": str(room.get("mor_inner", props.inner_wall_variant)).upper(),
        "outer": str(room.get("mor_outer", props.outer_wall_variant)).upper(),
    }


def read_corner_edits(room):
    try:
        value = json.loads(room.get(ROOM_CORNERS, "{}"))
        return value if isinstance(value, dict) else {}
    except (TypeError, ValueError):
        return {}


def write_corner_edits(room, edits):
    room[ROOM_CORNERS] = json.dumps(edits)


def read_circles(room):
    try:
        value = json.loads(room.get(ROOM_CIRCLES, "[]"))
        return [
            {"cx": float(circle["cx"]), "cy": float(circle["cy"]), "radius": float(circle["radius"])}
            for circle in value
            if isinstance(circle, dict) and float(circle.get("radius", 0)) >= CELL
        ]
    except (TypeError, ValueError, KeyError):
        return []


def write_circles(room, circles):
    room[ROOM_CIRCLES] = json.dumps(circles)


def circle_overlaps_cell(circle, cell):
    x0, y0 = cell[0] * CELL, cell[1] * CELL
    x1, y1 = x0 + CELL, y0 + CELL
    nearest_x = max(x0, min(circle["cx"], x1))
    nearest_y = max(y0, min(circle["cy"], y1))
    return hypot(circle["cx"] - nearest_x, circle["cy"] - nearest_y) < circle["radius"] - 1e-6


def circles_overlap(a, b):
    return hypot(a["cx"] - b["cx"], a["cy"] - b["cy"]) < a["radius"] + b["radius"] - 1e-6


def point_in_room_parts(point, cells, circles, skip_circle=None):
    x, y = point
    if any(cell[0] * CELL < x < (cell[0] + 1) * CELL and cell[1] * CELL < y < (cell[1] + 1) * CELL for cell in cells):
        return True
    return any(
        index != skip_circle and hypot(x - circle["cx"], y - circle["cy"]) < circle["radius"] - 1e-5
        for index, circle in enumerate(circles)
    )


def cells_at_vertex(cells, vertex):
    vx, vy = vertex
    return [cell for cell in cells if cell[0] in {vx - 1, vx} and cell[1] in {vy - 1, vy}]


def convex_room_corners(cells):
    vertices = set()
    for x, y in cells:
        vertices.update(((x, y), (x + 1, y), (x, y + 1), (x + 1, y + 1)))
    return [vertex for vertex in sorted(vertices) if len(cells_at_vertex(cells, vertex)) == 1]


def create_room(context, cells):
    if not cells:
        return None
    props = context.scene.mor_room_builder
    rooms = room_objects()
    overlapping = [room for room in rooms if read_cells(room) & cells or any(
        circle_overlaps_cell(circle, cell) for circle in read_circles(room) for cell in cells
    )]
    merged = set(cells)
    merged_circles = []
    style = {"inner": str(props.inner_wall_variant), "outer": str(props.outer_wall_variant)}
    for room in overlapping:
        merged |= read_cells(room)
        merged_circles.extend(read_circles(room))
        style = room_style(room, props)
        bpy.data.objects.remove(room, do_unlink=True)
    collection = ensure_collection(ROOMS_COLLECTION)
    room = bpy.data.objects.new(f"Room_{len(room_objects()) + 1:03d}", None)
    collection.objects.link(room)
    room.empty_display_type = "CUBE"
    room.empty_display_size = 0.45
    room[ROOM_FLAG] = True
    room["mor_inner"] = style["inner"]
    room["mor_outer"] = style["outer"]
    room[ROOM_CORNERS] = "{}"
    write_cells(room, merged)
    write_circles(room, merged_circles)
    xs = [cell[0] for cell in merged]
    ys = [cell[1] for cell in merged]
    room.location = ((min(xs) + max(xs) + 1) * CELL / 2, (min(ys) + max(ys) + 1) * CELL / 2, 0)
    props.active_room = room
    return room


def create_circle_room(context, circle):
    """Create a circle or merge it into every room whose finished parts overlap it."""
    props = context.scene.mor_room_builder
    rooms = room_objects()
    overlapping = [room for room in rooms if any(circle_overlaps_cell(circle, cell) for cell in read_cells(room))
                   or any(circles_overlap(circle, other) for other in read_circles(room))]
    cells = set()
    circles = [circle]
    edits = {}
    style = {"inner": str(props.inner_wall_variant), "outer": str(props.outer_wall_variant)}
    for room in overlapping:
        cells |= read_cells(room)
        circles[:0] = read_circles(room)
        edits.update(read_corner_edits(room))
        style = room_style(room, props)
        bpy.data.objects.remove(room, do_unlink=True)
    collection = ensure_collection(ROOMS_COLLECTION)
    room = bpy.data.objects.new(f"Room_{len(room_objects()) + 1:03d}", None)
    collection.objects.link(room)
    room.empty_display_type = "CIRCLE"
    room.empty_display_size = max(CELL, circle["radius"])
    room[ROOM_FLAG] = True
    room["mor_inner"], room["mor_outer"] = style["inner"], style["outer"]
    write_cells(room, cells)
    write_circles(room, circles)
    write_corner_edits(room, edits)
    room.location = (circle["cx"], circle["cy"], 0)
    props.active_room = room
    return room


def rooms_overlap(a, b):
    cells_a, cells_b = read_cells(a), read_cells(b)
    circles_a, circles_b = read_circles(a), read_circles(b)
    return bool(cells_a & cells_b) or any(
        circle_overlaps_cell(circle, cell) for circle in circles_a for cell in cells_b
    ) or any(
        circle_overlaps_cell(circle, cell) for circle in circles_b for cell in cells_a
    ) or any(circles_overlap(a_circle, b_circle) for a_circle in circles_a for b_circle in circles_b)


def consolidate_overlapping_rooms(context, preferred=None):
    """Merge overlapping logical records transitively; touching rooms stay separate."""
    rooms = room_objects()
    if len(rooms) < 2:
        return preferred
    groups = []
    pending = list(rooms)
    while pending:
        group = [pending.pop(0)]
        changed = True
        while changed:
            changed = False
            for candidate in list(pending):
                if any(rooms_overlap(candidate, member) for member in group):
                    group.append(candidate)
                    pending.remove(candidate)
                    changed = True
        groups.append(group)
    active = preferred
    for group in groups:
        if len(group) == 1:
            continue
        keeper = preferred if preferred in group else group[0]
        cells, circles, edits = set(), [], {}
        for room in group:
            cells |= read_cells(room)
            circles.extend(read_circles(room))
            edits.update(read_corner_edits(room))
        write_cells(keeper, cells)
        write_circles(keeper, circles)
        write_corner_edits(keeper, edits)
        for room in group:
            if room != keeper:
                bpy.data.objects.remove(room, do_unlink=True)
        active = keeper
    context.scene.mor_room_builder.active_room = active
    return active


def rectangle_cells(x, y, width, depth):
    return {(x + dx, y + dy) for dx in range(width) for dy in range(depth)}


def build_drag_preview(x, y, width, depth):
    clear_collection(DRAW_PREVIEW_COLLECTION)
    collection = ensure_collection(DRAW_PREVIEW_COLLECTION)
    x0, y0 = x * CELL, y * CELL
    x1, y1 = (x + width) * CELL, (y + depth) * CELL
    z = 0.04
    mesh = bpy.data.meshes.new("MoR_Draw_Preview_Mesh")
    mesh.from_pydata(
        [(x0, y0, z), (x1, y0, z), (x1, y1, z), (x0, y1, z)],
        [(0, 1), (1, 2), (2, 3), (3, 0)],
        [],
    )
    mesh.update()
    preview = bpy.data.objects.new("MoR_Draw_Preview", mesh)
    preview.display_type = "WIRE"
    preview.color = (0.1, 0.8, 1.0, 1.0)
    collection.objects.link(preview)


def circle_points(circle, segments=128):
    count = max(32, min(360, int(ceil(2 * pi * circle["radius"] / 0.35)), segments))
    return [(
        circle["cx"] + cos(2 * pi * index / count) * circle["radius"],
        circle["cy"] + sin(2 * pi * index / count) * circle["radius"],
    ) for index in range(count)]


def build_circle_preview(circle):
    clear_collection(DRAW_PREVIEW_COLLECTION)
    collection = ensure_collection(DRAW_PREVIEW_COLLECTION)
    points = circle_points(circle, 96)
    mesh = bpy.data.meshes.new("MoR_Circle_Preview_Mesh")
    edges = [(index, (index + 1) % len(points)) for index in range(len(points))]
    mesh.from_pydata([(x, y, 0.04) for x, y in points], edges, [])
    mesh.update()
    preview = bpy.data.objects.new("MoR_Circle_Preview", mesh)
    preview.display_type = "WIRE"
    preview.color = (0.35, 0.85, 1.0, 1.0)
    collection.objects.link(preview)


def create_circle_floor(collection, circle, material_source, name):
    points = circle_points(circle)
    mesh = bpy.data.meshes.new(f"{name}_Mesh")
    mesh.from_pydata([(x, y, 0) for x, y in points], [], [tuple(range(len(points)))])
    mesh.update()
    # The source tile's material expects UVs. World-aligned 2 m UVs preserve
    # the same scale and repeat continuously across circles and merged rooms.
    uv_layer = mesh.uv_layers.new(name="UVMap")
    for polygon in mesh.polygons:
        for loop_index in polygon.loop_indices:
            vertex = mesh.vertices[mesh.loops[loop_index].vertex_index]
            uv_layer.data[loop_index].uv = (vertex.co.x / CELL, vertex.co.y / CELL)
    obj = bpy.data.objects.new(name, mesh)
    collection.objects.link(obj)
    if material_source and material_source.data:
        for material in material_source.data.materials:
            obj.data.materials.append(material)
    return obj


def visible_circle_paths(circle, cells, circles, circle_index):
    """Return sampled arc runs not swallowed by another part of the same room."""
    points = circle_points(circle)
    visible = []
    for index, point in enumerate(points):
        following = points[(index + 1) % len(points)]
        midpoint = ((point[0] + following[0]) / 2, (point[1] + following[1]) / 2)
        visible.append(not point_in_room_parts(midpoint, cells, circles, circle_index))
    if not any(visible):
        return []
    if all(visible):
        return [points + [points[0]]]
    first_hidden = next(index for index, value in enumerate(visible) if not value)
    paths, current = [], []
    for step in range(1, len(points) + 1):
        index = (first_hidden + step) % len(points)
        if visible[index]:
            if not current:
                current = [points[index]]
            current.append(points[(index + 1) % len(points)])
        elif current:
            paths.append(current)
            current = []
    if current:
        paths.append(current)
    return paths


def exposed_segment_paths(start, end, circles):
    """Subtract circle interiors from a straight segment, exactly at intersections."""
    dx, dy = end[0] - start[0], end[1] - start[1]
    length_squared = dx * dx + dy * dy
    cuts = {0.0, 1.0}
    for circle in circles:
        ox, oy = start[0] - circle["cx"], start[1] - circle["cy"]
        b = 2 * (ox * dx + oy * dy)
        c = ox * ox + oy * oy - circle["radius"] * circle["radius"]
        discriminant = b * b - 4 * length_squared * c
        if discriminant < 0:
            continue
        root = sqrt(max(0.0, discriminant))
        for value in ((-b - root) / (2 * length_squared), (-b + root) / (2 * length_squared)):
            if 1e-6 < value < 1 - 1e-6:
                cuts.add(value)
    values = sorted(cuts)
    result = []
    for low, high in zip(values, values[1:]):
        middle = (low + high) / 2
        point = (start[0] + dx * middle, start[1] + dy * middle)
        if any(hypot(point[0] - circle["cx"], point[1] - circle["cy"]) < circle["radius"] - 1e-6 for circle in circles):
            continue
        result.append([
            (start[0] + dx * low, start[1] + dy * low),
            (start[0] + dx * high, start[1] + dy * high),
        ])
    return result


def wall_pose(cell, side):
    x, y = cell[0] * CELL, cell[1] * CELL
    return {
        "S": ((x, y, 0), 0.0),
        "E": ((x + CELL, y, 0), pi / 2),
        "N": ((x + CELL, y + CELL, 0), pi),
        "W": ((x, y + CELL, 0), 3 * pi / 2),
    }[side]


def place_wall(source, collection, start, angle, offset, flip, name):
    along = Vector((cos(angle), sin(angle), 0))
    normal = Vector((-sin(angle), cos(angle), 0))
    position = Vector(start) + normal * offset
    rotation = angle
    if flip:
        position += along * CELL
        rotation += pi
    return duplicate(source, collection, position, rotation, name)


def place_wall_path(source, collection, points, offset, flip, name_prefix):
    """Approximate a freeform wall with unscaled 3x2 modules tangent to a path."""
    if len(points) < 2:
        return 0
    distances = []
    total = 0.0
    for a, b in zip(points, points[1:]):
        length = hypot(b[0] - a[0], b[1] - a[1])
        distances.append((total, total + length, a, b))
        total += length
    count = max(1, int(ceil(total / CELL)))
    for index in range(count):
        target = min(index * CELL, max(0.0, total - 0.001))
        segment = next(item for item in distances if item[1] >= target)
        low, high, a, b = segment
        ratio = 0.0 if high == low else (target - low) / (high - low)
        point = Vector((a[0] + (b[0] - a[0]) * ratio, a[1] + (b[1] - a[1]) * ratio, 0))
        angle = atan2(b[1] - a[1], b[0] - a[0])
        place_wall(source, collection, point, angle, offset, flip, f"{name_prefix}_{index:02d}")
    return count


def path_metrics(points):
    segments = []
    total = 0.0
    for a, b in zip(points, points[1:]):
        length = hypot(b[0] - a[0], b[1] - a[1])
        if length > 0.000001:
            segments.append((total, total + length, Vector(a), Vector(b)))
            total += length
    return segments, total


def point_and_tangent_at(segments, total, distance):
    closed = (segments[0][2] - segments[-1][3]).length < 1e-6
    # At a closed seam, both sides must use the same point AND normal.
    # Wrapping also preserves trim that overhangs the nominal module span.
    distance = distance % total if closed else max(0.0, min(total, distance))
    segment_index = len(segments) - 1
    for index, candidate in enumerate(segments):
        if candidate[1] >= distance:
            segment_index = index
            break
    low, high, a, b = segments[segment_index]
    ratio = 0.0 if high == low else (distance - low) / (high - low)
    point = a.lerp(b, ratio)
    direction = (b - a).normalized()
    previous = segments[(segment_index - 1) % len(segments)]
    following = segments[(segment_index + 1) % len(segments)]
    start_tangent = direction
    end_tangent = direction
    if closed or segment_index > 0:
        blended = direction + (previous[3] - previous[2]).normalized()
        if blended.length > 1e-6:
            start_tangent = blended.normalized()
    if closed or segment_index < len(segments) - 1:
        blended = direction + (following[3] - following[2]).normalized()
        if blended.length > 1e-6:
            end_tangent = blended.normalized()
    tangent = start_tangent.lerp(end_tangent, ratio).normalized()
    return point, tangent


def deform_wall_path(source, collection, points, offset, flip, name_prefix):
    """Bend subdivided wall meshes continuously along a path without changing UVs."""
    segments, total = path_metrics(points)
    if not segments or total <= 0.000001:
        return 0
    # The kit's structural span is x=0..2 m, as in place_wall. Trim and
    # irregular stonework extend beyond it. Normalizing by mesh bounds shrinks
    # the structural faces and leaves a visible gap at every repeat.
    count = max(1, int(ceil(total / CELL)))
    source_x_scale = source.scale.x
    source_y_scale = source.scale.y
    source_z_scale = source.scale.z
    for module_index in range(count):
        obj = source.copy()
        obj.data = source.data.copy()
        collection.objects.link(obj)
        obj.hide_viewport = False
        obj.hide_render = False
        obj.hide_set(False)
        obj.name = f"{name_prefix}_{module_index:02d}"
        obj.location = (0, 0, 0)
        obj.rotation_euler = (0, 0, 0)
        obj.scale = (1, 1, 1)
        for vertex in obj.data.vertices:
            fraction = vertex.co.x * source_x_scale / CELL
            path_fraction = (module_index + fraction) / count
            if flip:
                path_fraction = 1.0 - path_fraction
            center, path_tangent = point_and_tangent_at(segments, total, path_fraction * total)
            local_tangent = -path_tangent if flip else path_tangent
            local_normal = Vector((-local_tangent.y, local_tangent.x))
            offset_normal = Vector((-path_tangent.y, path_tangent.x))
            lateral = vertex.co.y * source_y_scale
            vertex.co = (
                center.x + local_normal.x * lateral + offset_normal.x * offset,
                center.y + local_normal.y * lateral + offset_normal.y * offset,
                vertex.co.z * source_z_scale,
            )
        obj.data.update()
    return count


def point_key(point):
    return (round(point[0], 5), round(point[1], 5))


def room_footprint_loop(cells, edits):
    """Trace the final CCW room boundary, including diagonal/curved edits."""
    directed = []
    for x, y in cells:
        for neighbor, start, end in (
            ((x, y - 1), (x, y), (x + 1, y)),
            ((x + 1, y), (x + 1, y), (x + 1, y + 1)),
            ((x, y + 1), (x + 1, y + 1), (x, y + 1)),
            ((x - 1, y), (x, y + 1), (x, y)),
        ):
            if neighbor not in cells:
                directed.append((start, end))

    edit_data = []
    removed = set()
    for vertex in convex_room_corners(cells):
        edit = edits.get(f"{vertex[0]},{vertex[1]}")
        if not edit:
            continue
        adjacent = cells_at_vertex(cells, vertex)[0]
        vx, vy = vertex
        sx = 1 if adjacent[0] == vx else -1
        sy = 1 if adjacent[1] == vy else -1
        inset = max(1, int(edit.get("inset", 1)))
        actual = 0
        for step in range(inset):
            horizontal = frozenset(((vx + sx * step, vy), (vx + sx * (step + 1), vy)))
            vertical = frozenset(((vx, vy + sy * step), (vx, vy + sy * (step + 1))))
            available = {frozenset(edge) for edge in directed}
            if horizontal not in available or vertical not in available:
                break
            removed.update((horizontal, vertical))
            actual += 1
        if actual:
            actual_edit = dict(edit)
            actual_edit["inset"] = actual
            edit_data.append((vertex, adjacent, actual_edit))

    segments = []
    for start, end in directed:
        if frozenset((start, end)) not in removed:
            segments.append(((start[0] * CELL, start[1] * CELL), (end[0] * CELL, end[1] * CELL)))
    for vertex, adjacent, edit in edit_data:
        path = edited_corner_path(vertex, adjacent, edit)
        segments.extend(zip(path, path[1:]))
    if not segments:
        return []

    outgoing = {}
    for start, end in segments:
        outgoing.setdefault(point_key(start), []).append((start, end))
    unused = {(point_key(start), point_key(end)) for start, end in segments}
    loops = []
    while unused:
        first_key = next(iter(unused))[0]
        current_key = first_key
        loop = []
        while True:
            choices = [item for item in outgoing.get(current_key, []) if (point_key(item[0]), point_key(item[1])) in unused]
            if not choices:
                break
            start, end = choices[0]
            unused.discard((point_key(start), point_key(end)))
            if not loop:
                loop.append(start)
            loop.append(end)
            current_key = point_key(end)
            if current_key == first_key:
                break
        if len(loop) >= 4:
            loops.append(loop[:-1] if point_key(loop[0]) == point_key(loop[-1]) else loop)
    if not loops:
        return []
    return max(loops, key=lambda loop: abs(sum(
        a[0] * b[1] - b[0] * a[1] for a, b in zip(loop, loop[1:] + loop[:1])
    )))


def create_footprint_volume(collection, name, loop):
    if len(loop) < 3:
        return None
    vectors = [Vector((x, y, 0)) for x, y in loop]
    triangles = tessellate_polygon([vectors])
    index_by_key = {point_key(point): index for index, point in enumerate(loop)}
    count = len(loop)
    vertices = [(x, y, -1.0) for x, y in loop] + [(x, y, 1.0) for x, y in loop]
    faces = []
    for triangle in triangles:
        # Blender 3.x/4.x commonly returns Vector triangles here, while
        # Blender 5.1 may return integer indices for the same call.
        indices = [
            int(point) if isinstance(point, int)
            else index_by_key[point_key((point.x, point.y))]
            for point in triangle
        ]
        faces.append(tuple(reversed(indices)))
        faces.append(tuple(index + count for index in indices))
    for index in range(count):
        following = (index + 1) % count
        faces.append((index, following, following + count, index + count))
    mesh = bpy.data.meshes.new(f"{name}_Mesh")
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    footprint = bpy.data.objects.new(name, mesh)
    collection.objects.link(footprint)
    footprint.display_type = "WIRE"
    footprint.hide_render = True
    return footprint


def intersect_floor_tile(context, floor_obj, footprint):
    z_values = [vertex.co.z for vertex in floor_obj.data.vertices]
    if not z_values or max(z_values) - min(z_values) < 0.0001:
        solidify = floor_obj.modifiers.new("MoR_Floor_Thickness", "SOLIDIFY")
        solidify.thickness = 0.02
        solidify.offset = -0.5
    boolean = floor_obj.modifiers.new("MoR_Footprint_Intersect", "BOOLEAN")
    boolean.operation = "INTERSECT"
    boolean.solver = "EXACT"
    boolean.object = footprint
    context.view_layer.update()
    depsgraph = context.evaluated_depsgraph_get()
    evaluated = floor_obj.evaluated_get(depsgraph)
    result = bpy.data.meshes.new_from_object(evaluated, preserve_all_data_layers=True, depsgraph=depsgraph)
    floor_obj.modifiers.clear()
    if result is None or not result.polygons:
        if result:
            bpy.data.meshes.remove(result)
        bpy.data.objects.remove(floor_obj, do_unlink=True)
        return False
    floor_obj.data = result
    return True


def clip_room_floors(context, generated, floor_objects, rooms, corner_paths):
    edits_by_owner = {}
    for owner, vertex, adjacent, edit in corner_paths:
        edits_by_owner.setdefault(owner, {})[f"{vertex[0]},{vertex[1]}"] = edit
    footprints = []
    try:
        for owner, edits in edits_by_owner.items():
            loop = room_footprint_loop(read_cells(rooms[owner]), edits)
            footprint = create_footprint_volume(generated, f"MoR_Footprint_R{owner}", loop)
            if footprint is None:
                continue
            footprints.append(footprint)
            for floor_obj in list(floor_objects.get(owner, [])):
                intersect_floor_tile(context, floor_obj, footprint)
    finally:
        for footprint in footprints:
            mesh = footprint.data
            bpy.data.objects.remove(footprint, do_unlink=True)
            if mesh and mesh.users == 0:
                bpy.data.meshes.remove(mesh)


def edited_corner_path(vertex, adjacent_cell, edit):
    inset = max(1, int(edit.get("inset", 1)))
    vx, vy = vertex
    sx = 1 if adjacent_cell[0] == vx else -1
    sy = 1 if adjacent_cell[1] == vy else -1
    a = ((vx + sx * inset) * CELL, vy * CELL)
    b = (vx * CELL, (vy + sy * inset) * CELL)
    inside = Vector((sx, sy))
    direction = Vector((b[0] - a[0], b[1] - a[1]))
    if Vector((-direction.y, direction.x)).dot(inside) < 0:
        a, b = b, a
    if edit.get("kind") != "CURVE":
        return [a, b]
    control_scale = -1 if edit.get("invert") else 0
    control = (
        (vx + (sx * inset if control_scale < 0 else 0)) * CELL,
        (vy + (sy * inset if control_scale < 0 else 0)) * CELL,
    )
    points = []
    for step in range(65):
        t = step / 64
        u = 1.0 - t
        points.append((
            u * u * a[0] + 2 * u * t * control[0] + t * t * b[0],
            u * u * a[1] + 2 * u * t * control[1] + t * t * b[1],
        ))
    return points


def build_layout(context):
    props = context.scene.mor_room_builder
    assets = scan_assets(props.asset_collection)
    if not assets["floor"] or not assets["wall"]:
        raise RuntimeError(f"Asset library incomplete: {len(assets['floor'])} grounds, {len(assets['wall'])} walls, {len(assets['pillar'])} pillars. Import the assets folder again; ground requires FL2x2A/B/C or FL2x2_<number>.")
    rooms = room_objects()
    if not rooms:
        raise RuntimeError("Add or draw at least one room")

    clear_collection(GENERATED_COLLECTION)
    generated = ensure_collection(GENERATED_COLLECTION)
    owners = {}
    styles = {}
    circles_by_owner = {}
    for room_index, room in enumerate(rooms):
        styles[room_index] = room_style(room, props)
        circles_by_owner[room_index] = read_circles(room)
        for cell in read_cells(room):
            owners[cell] = room_index

    floor_source = variant(assets["floor"], props.floor_variant)
    floor_objects = {}
    for x, y in sorted(owners):
        owner = owners[(x, y)]
        floor_obj = duplicate(floor_source, generated, (x * CELL, y * CELL, 0), 0, f"Floor_X{x}_Y{y}")
        floor_objects.setdefault(owner, []).append(floor_obj)
    for owner, circles in circles_by_owner.items():
        for circle_index, circle in enumerate(circles):
            create_circle_floor(generated, circle, floor_source, f"CircleFloor_R{owner}_C{circle_index}")

    # Canonical edge records ensure that an edge between two rooms is emitted
    # once, regardless of room creation order or which cell is visited first.
    edges = {}
    directions = {"S": (0, -1), "E": (1, 0), "N": (0, 1), "W": (-1, 0)}
    edge_vertices = {
        "S": lambda x, y: ((x, y), (x + 1, y)),
        "E": lambda x, y: ((x + 1, y), (x + 1, y + 1)),
        "N": lambda x, y: ((x, y + 1), (x + 1, y + 1)),
        "W": lambda x, y: ((x, y), (x, y + 1)),
    }
    rect_circle_paths = []
    for cell, owner in owners.items():
        for side, delta in directions.items():
            neighbor = (cell[0] + delta[0], cell[1] + delta[1])
            other = owners.get(neighbor)
            if other == owner:
                continue
            start_vertex, end_vertex = edge_vertices[side](*cell)
            circles = circles_by_owner.get(owner, [])
            if circles:
                world_start = (start_vertex[0] * CELL, start_vertex[1] * CELL)
                world_end = (end_vertex[0] * CELL, end_vertex[1] * CELL)
                exposed = exposed_segment_paths(world_start, world_end, circles)
                if len(exposed) != 1 or exposed[0] != [world_start, world_end]:
                    rect_circle_paths.extend((owner, path) for path in exposed)
                    continue
            key = tuple(sorted(edge_vertices[side](*cell)))
            record = edges.setdefault(key, {"sides": []})
            record["sides"].append((cell, side, owner))

    corner_paths = []
    for owner, room in enumerate(rooms):
        cells = read_cells(room)
        edits = read_corner_edits(room)
        for vertex in convex_room_corners(cells):
            edit = edits.get(f"{vertex[0]},{vertex[1]}")
            if not edit:
                continue
            adjacent = cells_at_vertex(cells, vertex)[0]
            vx, vy = vertex
            sx = 1 if adjacent[0] == vx else -1
            sy = 1 if adjacent[1] == vy else -1
            requested = max(1, int(edit.get("inset", 1)))
            removable = []
            for step in range(requested):
                horizontal = tuple(sorted(((vx + sx * step, vy), (vx + sx * (step + 1), vy))))
                vertical = tuple(sorted(((vx, vy + sy * step), (vx, vy + sy * (step + 1)))))
                if horizontal not in edges or vertical not in edges:
                    break
                if len(edges[horizontal]["sides"]) != 1 or len(edges[vertical]["sides"]) != 1:
                    break
                removable.extend((horizontal, vertical))
            actual = len(removable) // 2
            if not actual:
                continue
            for key in removable:
                edges.pop(key, None)
            actual_edit = dict(edit)
            actual_edit["inset"] = actual
            corner_paths.append((owner, vertex, adjacent, actual_edit))

    if props.clip_edited_ground and corner_paths:
        clip_room_floors(context, generated, floor_objects, rooms, corner_paths)

    walls = 0
    shared_edges = 0
    for edge_index, record in enumerate(edges.values()):
        sides = record["sides"]
        cell, side, owner = sides[0]
        start, angle = wall_pose(cell, side)
        if len(sides) == 1:
            style = styles[owner]
            if props.show_inner_walls:
                source = variant(assets["wall"], style["inner"])
                place_wall(source, generated, start, angle, props.inner_wall_offset,
                           props.flip_inner_walls, f"Wall_Inner_R{owner}_E{edge_index}")
                walls += 1
            if props.show_outer_walls:
                source = variant(assets["wall"], style["outer"])
                place_wall(source, generated, start, angle, -props.outer_wall_offset,
                           props.flip_outer_walls, f"Wall_Outer_R{owner}_E{edge_index}")
                walls += 1
            continue

        # One shared structural edge, with one visible interior face owned by
        # each adjoining room. No exterior wall is allowed on this edge.
        shared_edges += 1
        if props.show_inner_walls:
            # Each room owns one inward-facing pose. Opposite cells naturally
            # traverse the edge in opposite directions, keeping the decorated
            # side of this asymmetric GLB visible from both rooms.
            for face_index, (face_cell, face_side, face_owner) in enumerate(sides[:2]):
                face_start, face_angle = wall_pose(face_cell, face_side)
                source = variant(assets["wall"], styles[face_owner]["inner"])
                place_wall(
                    source, generated, face_start, face_angle,
                    wall_module_depth(source) + props.shared_wall_gap / 2,
                    props.flip_inner_walls,
                    f"SharedWall_E{edge_index}_Face{face_index}_R{face_owner}",
                )
                walls += 1

    circle_junction_points = []
    # Circular boundaries use the same fixed wall asset, continuously deformed
    # along exposed arcs. Any arc lying inside another part of its room is omitted,
    # so mixed rooms have an open junction instead of a doubled wall.
    for owner, room in enumerate(rooms):
        cells = read_cells(room)
        circles = circles_by_owner[owner]
        style = styles[owner]
        for circle_index, circle in enumerate(circles):
            for run_index, points in enumerate(visible_circle_paths(circle, cells, circles, circle_index)):
                if point_key(points[0]) != point_key(points[-1]):
                    circle_junction_points.extend((points[0], points[-1]))
                if props.show_inner_walls:
                    source = variant(assets["wall"], style["inner"])
                    walls += deform_wall_path(
                        source, generated, points, props.inner_wall_offset,
                        props.flip_inner_walls, f"Circle_Inner_R{owner}_C{circle_index}_{run_index}",
                    )
                if props.show_outer_walls:
                    source = variant(assets["wall"], style["outer"])
                    walls += deform_wall_path(
                        source, generated, points, -props.outer_wall_offset,
                        props.flip_outer_walls, f"Circle_Outer_R{owner}_C{circle_index}_{run_index}",
                    )

    for path_index, (owner, points) in enumerate(rect_circle_paths):
        style = styles[owner]
        if props.show_inner_walls:
            walls += deform_wall_path(
                variant(assets["wall"], style["inner"]), generated, points,
                props.inner_wall_offset, props.flip_inner_walls,
                f"CircleJunction_Inner_R{owner}_{path_index}",
            )
        if props.show_outer_walls:
            walls += deform_wall_path(
                variant(assets["wall"], style["outer"]), generated, points,
                -props.outer_wall_offset, props.flip_outer_walls,
                f"CircleJunction_Outer_R{owner}_{path_index}",
            )

    for path_index, (owner, vertex, adjacent, edit) in enumerate(corner_paths):
        points = edited_corner_path(vertex, adjacent, edit)
        style = styles[owner]
        # Map subdivided geometry to the exact endpoint distance for both
        # shapes. This prevents the final fixed-size module protruding beyond
        # the new corner pillar; curves additionally bend at every edge loop.
        path_builder = deform_wall_path
        if props.show_inner_walls:
            source = variant(assets["wall"], style["inner"])
            walls += path_builder(
                source, generated, points, props.inner_wall_offset,
                props.flip_inner_walls, f"CornerPath_Inner_R{owner}_{path_index}",
            )
        if props.show_outer_walls:
            source = variant(assets["wall"], style["outer"])
            walls += path_builder(
                source, generated, points, -props.outer_wall_offset,
                props.flip_outer_walls, f"CornerPath_Outer_R{owner}_{path_index}",
            )

    pillars = 0
    pillar_source = variant(assets["pillar"], props.pillar_variant)
    if props.show_pillars and pillar_source:
        edited_vertices = {vertex for _owner, vertex, _adjacent, _edit in corner_paths}
        placed_pillars = set()
        vertices = {}
        for cell in owners:
            x, y = cell
            for vertex in ((x, y), (x + 1, y), (x, y + 1), (x + 1, y + 1)):
                vertices.setdefault(vertex, 0)
                vertices[vertex] += 1
        shared_degree = {}
        for edge, record in edges.items():
            if len(record["sides"]) < 2:
                continue
            for vertex in edge:
                shared_degree[vertex] = shared_degree.get(vertex, 0) + 1
        # Degree one means the endpoint of a contiguous shared-wall run. Interior
        # module joins have degree two and must not receive redundant pillars.
        shared_endpoints = {vertex for vertex, degree in shared_degree.items() if degree == 1}
        # A single occupied quadrant is a true outside corner. Four occupied
        # quadrants is interior space and must never receive four pillars.
        for (x, y), count in sorted(vertices.items()):
            shared_endpoint = (x, y) in shared_endpoints
            # One occupied quadrant is an outside corner; three is a concave
            # junction created by an L-shape or a merged-room intersection.
            if (count not in {1, 3} and not shared_endpoint) or (x, y) in edited_vertices:
                continue
            adjacent = next(cell for cell in owners if x in {cell[0], cell[0] + 1} and y in {cell[1], cell[1] + 1})
            junction = shared_endpoint or count == 3
            inset_x = 0 if junction else (props.pillar_offset if adjacent[0] == x else -props.pillar_offset)
            inset_y = 0 if junction else (props.pillar_offset if adjacent[1] == y else -props.pillar_offset)
            duplicate(pillar_source, generated, (x * CELL + inset_x, y * CELL + inset_y, 0), 0, f"Pillar_X{x}_Y{y}")
            placed_pillars.add((round(x * CELL + inset_x, 4), round(y * CELL + inset_y, 4)))
            pillars += 1
        for path_index, (_owner, vertex, adjacent, edit) in enumerate(corner_paths):
            points = edited_corner_path(vertex, adjacent, edit)
            for endpoint_index, (point, neighbor) in enumerate(((points[0], points[1]), (points[-1], points[-2]))):
                tangent = Vector((neighbor[0] - point[0], neighbor[1] - point[1]))
                if tangent.length:
                    tangent.normalize()
                inward = Vector((-tangent.y, tangent.x))
                position = Vector(point) + inward * props.pillar_offset
                key = (round(position.x, 4), round(position.y, 4))
                if key in placed_pillars:
                    continue
                duplicate(pillar_source, generated, (position.x, position.y, 0), 0,
                          f"Pillar_CornerPath_{path_index}_{endpoint_index}")
                placed_pillars.add(key)
                pillars += 1
        # Boolean circle/rectangle junctions are not grid vertices. The open arc
        # endpoints are the exact new corners and need their own pillar anchors.
        for junction_index, point in enumerate(circle_junction_points):
            key = (round(point[0], 4), round(point[1], 4))
            if key in placed_pillars:
                continue
            duplicate(
                pillar_source, generated, (point[0], point[1], 0), 0,
                f"Pillar_CircleJunction_{junction_index}",
            )
            placed_pillars.add(key)
            pillars += 1

    if props.show_corner_handles:
        for room_index, room in enumerate(rooms):
            for x, y in convex_room_corners(read_cells(room)):
                handle = bpy.data.objects.new(f"Corner_Handle_R{room_index}_X{x}_Y{y}", None)
                generated.objects.link(handle)
                handle.empty_display_type = "SPHERE"
                handle.empty_display_size = props.corner_handle_size
                handle.color = (1.0, 0.55, 0.0, 1.0)
                handle.location = (x * CELL, y * CELL, 0.12)
                handle["mor_corner_handle"] = True
                handle["mor_room_name"] = room.name
                handle["mor_vertex"] = f"{x},{y}"

    props.status = f"Built {len(owners)} cells, {len(edges)} wall edges ({shared_edges} shared), {walls} faces, {pillars} pillars."


class MORRoomProperties(PropertyGroup):
    asset_collection: PointerProperty(name="Asset Collection", type=bpy.types.Collection)
    asset_folder: StringProperty(name="GLB Folder", subtype="DIR_PATH")
    origin_x: IntProperty(name="Grid X", default=0)
    origin_y: IntProperty(name="Grid Y", default=0)
    width_cells: IntProperty(name="Width", default=4, min=1)
    depth_cells: IntProperty(name="Depth", default=3, min=1)
    circle_radius: FloatProperty(name="Circle Radius", default=4.0, min=CELL, step=100, unit="LENGTH")
    floor_variant: IntProperty(name="Ground", description="Asset variant number; legacy A/B/C assets map to 1/2/3", default=1, min=1)
    clip_edited_ground: BoolProperty(name="Clip Ground to Shape", description="Remove floor geometry outside diagonal and curved corner boundaries", default=True)
    inner_wall_variant: IntProperty(name="Inside Wall", description="Asset variant number; legacy A/B/C assets map to 1/2/3", default=1, min=1)
    outer_wall_variant: IntProperty(name="Outside Wall", description="Asset variant number; legacy A/B/C assets map to 1/2/3", default=1, min=1)
    pillar_variant: IntProperty(name="Pillar", description="Asset variant number; legacy A/B/C assets map to 1/2/3", default=1, min=1)
    show_inner_walls: BoolProperty(name="Inside Walls", default=True)
    show_outer_walls: BoolProperty(name="Outside Walls", default=True)
    flip_inner_walls: BoolProperty(name="Rotate Inside 180°", default=False)
    flip_outer_walls: BoolProperty(name="Rotate Outside 180°", default=True)
    inner_wall_offset: FloatProperty(name="Inside Offset", default=0.0, min=-1.0, max=1.0, unit="LENGTH")
    outer_wall_offset: FloatProperty(name="Outside Offset", default=0.0, min=-1.0, max=1.0, unit="LENGTH")
    shared_wall_gap: FloatProperty(name="Shared Face Gap", description="Separates the two room-facing meshes on one shared wall to prevent overlap", default=0.04, min=0.0, max=0.5, unit="LENGTH")
    show_pillars: BoolProperty(name="Pillars", default=True)
    pillar_offset: FloatProperty(name="Pillar Offset", description="Move outside-corner pillars diagonally into the occupied room", default=0.0, min=-1.0, max=1.0, unit="LENGTH")
    show_corner_handles: BoolProperty(name="Corner Points", description="Show editable points at every convex room corner", default=True)
    corner_handle_size: FloatProperty(name="Point Size", default=0.18, min=0.03, max=1.0, unit="LENGTH")
    active_room: PointerProperty(name="Active Room", type=bpy.types.Object)
    status: StringProperty(default="Import the GLB folder or choose an asset collection.")


class MOR_OT_import_assets(Operator):
    bl_idname = "mor.import_room_assets"
    bl_label = "Import GLB Library"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        props = context.scene.mor_room_builder
        folder = Path(bpy.path.abspath(props.asset_folder))
        if not folder.is_dir():
            self.report({"ERROR"}, "Choose an existing asset folder")
            return {"CANCELLED"}
        files = library_files(folder)
        if not files:
            self.report({"ERROR"}, "No GLB or GLTF files found in that folder")
            return {"CANCELLED"}
        library = ensure_collection(ASSET_COLLECTION)
        library.hide_viewport = False
        for path in files:
            before = set(bpy.data.objects)
            bpy.ops.import_scene.gltf(filepath=str(path))
            imported = [obj for obj in bpy.data.objects if obj not in before]
            meshes = [obj for obj in imported if obj.type == "MESH"]
            for index, obj in enumerate(meshes):
                move_to_collection(obj, library)
                if len(meshes) == 1:
                    obj.name = path.stem
            for obj in imported:
                if obj.type != "MESH" and not obj.children:
                    bpy.data.objects.remove(obj, do_unlink=True)
        props.asset_collection = library
        assets = scan_assets(library)
        props.status = f"Imported {len(files)} files: {len(assets['floor'])} grounds, {len(assets['wall'])} walls, {len(assets['pillar'])} pillars."
        if not assets['floor'] or not assets['wall']:
            self.report({"WARNING"}, props.status + " Ground and wall assets are both required.")
        return {"FINISHED"}


class MOR_OT_scan_assets(Operator):
    bl_idname = "mor.scan_room_assets"
    bl_label = "Scan Assets"

    def execute(self, context):
        props = context.scene.mor_room_builder
        assets = scan_assets(props.asset_collection)
        props.status = f"Floors {len(assets['floor'])} | Walls {len(assets['wall'])} | Pillars {len(assets['pillar'])}"
        return {"FINISHED"}


class MOR_OT_add_room(Operator):
    bl_idname = "mor.add_room"
    bl_label = "Add Room"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        props = context.scene.mor_room_builder
        create_room(context, rectangle_cells(props.origin_x, props.origin_y, props.width_cells, props.depth_cells))
        try:
            build_layout(context)
        except RuntimeError as error:
            props.status = str(error)
        return {"FINISHED"}


NAV_PASSTHROUGH_TYPES = {
    "MIDDLEMOUSE", "WHEELUPMOUSE", "WHEELDOWNMOUSE",
    "NUMPAD_0", "NUMPAD_1", "NUMPAD_2", "NUMPAD_3", "NUMPAD_4",
    "NUMPAD_5", "NUMPAD_6", "NUMPAD_7", "NUMPAD_8", "NUMPAD_9",
    "NUMPAD_PERIOD", "NUMPAD_PLUS", "NUMPAD_MINUS",
}


class MOR_OT_draw_room(Operator):
    bl_idname = "mor.draw_room"
    bl_label = "Draw Room"
    bl_options = {"REGISTER", "UNDO", "BLOCKING"}
    _start_cell = None
    _current_cell = None
    _dragging = False

    def grid_point(self, context, event):
        region, rv3d = context.region, context.region_data
        if region is None or region.type != "WINDOW" or rv3d is None:
            return None
        coord = (event.mouse_region_x, event.mouse_region_y)
        origin = view3d_utils.region_2d_to_origin_3d(region, rv3d, coord)
        direction = view3d_utils.region_2d_to_vector_3d(region, rv3d, coord)
        hit = intersect_line_plane(origin, origin + direction, Vector((0, 0, 0)), Vector((0, 0, 1)))
        return (floor(hit.x / CELL), floor(hit.y / CELL)) if hit else None

    def rectangle(self):
        (x0, y0), (x1, y1) = self._start_cell, self._current_cell
        min_x, max_x = sorted((x0, x1))
        min_y, max_y = sorted((y0, y1))
        return min_x, min_y, max_x - min_x + 1, max_y - min_y + 1

    def invoke(self, context, event):
        if context.area is None or context.area.type != "VIEW_3D":
            self.report({"ERROR"}, "Run Draw Room from the 3D Viewport")
            return {"CANCELLED"}
        self._start_cell = self._current_cell = None
        self._dragging = False
        context.window_manager.modal_handler_add(self)
        context.workspace.status_text_set("MoR Builder: click and drag a room | middle mouse navigates | Esc cancels")
        context.window.cursor_modal_set("CROSSHAIR")
        return {"RUNNING_MODAL"}

    def modal(self, context, event):
        if event.type in NAV_PASSTHROUGH_TYPES:
            return {"PASS_THROUGH"}
        if event.type == "MOUSEMOVE":
            cell = self.grid_point(context, event)
            if cell is not None:
                self._current_cell = cell
                if self._dragging:
                    build_drag_preview(*self.rectangle())
            return {"RUNNING_MODAL"}
        if event.type in {"ESC", "RIGHTMOUSE"}:
            clear_collection(DRAW_PREVIEW_COLLECTION)
            context.workspace.status_text_set(None)
            context.window.cursor_modal_restore()
            return {"CANCELLED"}
        if event.type == "LEFTMOUSE" and event.value == "PRESS":
            cell = self.grid_point(context, event)
            if cell is not None:
                self._start_cell = self._current_cell = cell
                self._dragging = True
                build_drag_preview(*self.rectangle())
            return {"RUNNING_MODAL"}
        if event.type == "LEFTMOUSE" and event.value == "RELEASE" and self._dragging:
            origin_x, origin_y, width, depth = self.rectangle()
            clear_collection(DRAW_PREVIEW_COLLECTION)
            context.workspace.status_text_set(None)
            context.window.cursor_modal_restore()
            props = context.scene.mor_room_builder
            props.origin_x, props.origin_y = origin_x, origin_y
            props.width_cells, props.depth_cells = width, depth
            create_room(context, rectangle_cells(origin_x, origin_y, width, depth))
            try:
                build_layout(context)
            except RuntimeError as error:
                props.status = str(error)
            self.report({"INFO"}, f"Added {width}×{depth} cell room at ({origin_x}, {origin_y})")
            return {"FINISHED"}
        return {"RUNNING_MODAL"}


class MOR_OT_draw_circle(Operator):
    bl_idname = "mor.draw_circle"
    bl_label = "Draw Circle"
    bl_description = "Drag a square footprint; the inscribed radius snaps to whole metres"
    bl_options = {"REGISTER", "UNDO", "BLOCKING"}
    _start_cell = None
    _current_cell = None
    _dragging = False

    def grid_point(self, context, event):
        region, rv3d = context.region, context.region_data
        if region is None or rv3d is None:
            return None
        coord = (event.mouse_region_x, event.mouse_region_y)
        origin = view3d_utils.region_2d_to_origin_3d(region, rv3d, coord)
        direction = view3d_utils.region_2d_to_vector_3d(region, rv3d, coord)
        hit = intersect_line_plane(origin, origin + direction, Vector((0, 0, 0)), Vector((0, 0, 1)))
        return (floor(hit.x / CELL), floor(hit.y / CELL)) if hit else None

    def circle(self):
        x0, y0 = self._start_cell
        x1, y1 = self._current_cell
        side = max(abs(x1 - x0), abs(y1 - y0)) + 1
        min_x = x0 if x1 >= x0 else x0 - side + 1
        min_y = y0 if y1 >= y0 else y0 - side + 1
        return {"cx": (min_x + side / 2) * CELL, "cy": (min_y + side / 2) * CELL, "radius": float(side)}

    def finish(self, context):
        clear_collection(DRAW_PREVIEW_COLLECTION)
        context.workspace.status_text_set(None)
        context.window.cursor_modal_restore()

    def invoke(self, context, event):
        if context.area is None or context.area.type != "VIEW_3D":
            self.report({"ERROR"}, "Run Draw Circle from the 3D Viewport")
            return {"CANCELLED"}
        self._start_cell = self._current_cell = None
        self._dragging = False
        context.window_manager.modal_handler_add(self)
        context.workspace.status_text_set("MoR Builder: drag a locked square for a circular room | minimum radius 2 m | Esc cancels")
        context.window.cursor_modal_set("CROSSHAIR")
        return {"RUNNING_MODAL"}

    def modal(self, context, event):
        if event.type in NAV_PASSTHROUGH_TYPES:
            return {"PASS_THROUGH"}
        if event.type in {"ESC", "RIGHTMOUSE"}:
            self.finish(context)
            return {"CANCELLED"}
        if event.type == "MOUSEMOVE":
            cell = self.grid_point(context, event)
            if cell is not None:
                self._current_cell = cell
                if self._dragging:
                    build_circle_preview(self.circle())
            return {"RUNNING_MODAL"}
        if event.type == "LEFTMOUSE" and event.value == "PRESS":
            cell = self.grid_point(context, event)
            if cell is not None:
                self._start_cell = self._current_cell = cell
                self._dragging = True
                build_circle_preview(self.circle())
            return {"RUNNING_MODAL"}
        if event.type == "LEFTMOUSE" and event.value == "RELEASE" and self._dragging:
            circle = self.circle()
            self.finish(context)
            if circle["radius"] < CELL:
                self.report({"WARNING"}, "Circle radius must be at least 2 m")
                return {"CANCELLED"}
            create_circle_room(context, circle)
            context.scene.mor_room_builder.circle_radius = circle["radius"]
            build_layout(context)
            self.report({"INFO"}, f"Added circular room, diameter {circle['radius'] * 2:g} m")
            return {"FINISHED"}
        return {"RUNNING_MODAL"}


class MOR_OT_move_room(Operator):
    bl_idname = "mor.move_room"
    bl_label = "Move Active Room"
    bl_description = "Move the active logical room in 2 m snapped steps"
    bl_options = {"REGISTER", "UNDO", "BLOCKING"}
    _room = None
    _start = None
    _cells = None
    _circles = None
    _location = None

    def grid_point(self, context, event):
        coord = (event.mouse_region_x, event.mouse_region_y)
        origin = view3d_utils.region_2d_to_origin_3d(context.region, context.region_data, coord)
        direction = view3d_utils.region_2d_to_vector_3d(context.region, context.region_data, coord)
        hit = intersect_line_plane(origin, origin + direction, Vector((0, 0, 0)), Vector((0, 0, 1)))
        return (round(hit.x / CELL), round(hit.y / CELL)) if hit else None

    def invoke(self, context, event):
        self._room = context.scene.mor_room_builder.active_room
        if not self._room or not self._room.get(ROOM_FLAG):
            self.report({"ERROR"}, "Choose an active room first")
            return {"CANCELLED"}
        self._start = self.grid_point(context, event)
        self._cells, self._circles = read_cells(self._room), read_circles(self._room)
        self._location = self._room.location.copy()
        context.window_manager.modal_handler_add(self)
        context.workspace.status_text_set("Move room: drag in 2 m steps | Esc restores")
        context.window.cursor_modal_set("SCROLL_XY")
        return {"RUNNING_MODAL"}

    def restore(self, context):
        write_cells(self._room, self._cells)
        write_circles(self._room, self._circles)
        self._room.location = self._location
        build_layout(context)

    def modal(self, context, event):
        if event.type in {"ESC", "RIGHTMOUSE"}:
            self.restore(context)
            context.workspace.status_text_set(None)
            context.window.cursor_modal_restore()
            return {"CANCELLED"}
        if event.type == "MOUSEMOVE" and self._start:
            current = self.grid_point(context, event)
            if current:
                dx, dy = current[0] - self._start[0], current[1] - self._start[1]
                write_cells(self._room, {(x + dx, y + dy) for x, y in self._cells})
                write_circles(self._room, [{**circle, "cx": circle["cx"] + dx * CELL, "cy": circle["cy"] + dy * CELL} for circle in self._circles])
                self._room.location = (self._location.x + dx * CELL, self._location.y + dy * CELL, self._location.z)
                build_layout(context)
            return {"RUNNING_MODAL"}
        if event.type == "LEFTMOUSE" and event.value == "RELEASE":
            self._room = consolidate_overlapping_rooms(context, self._room) or self._room
            build_layout(context)
            context.workspace.status_text_set(None)
            context.window.cursor_modal_restore()
            return {"FINISHED"}
        return {"RUNNING_MODAL"}


class MOR_OT_erase_room(Operator):
    bl_idname = "mor.erase_room"
    bl_label = "Erase Active Room"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        props = context.scene.mor_room_builder
        room = props.active_room
        if not room or not room.get(ROOM_FLAG):
            self.report({"ERROR"}, "Choose an active room first")
            return {"CANCELLED"}
        bpy.data.objects.remove(room, do_unlink=True)
        props.active_room = None
        if room_objects():
            build_layout(context)
        else:
            clear_collection(GENERATED_COLLECTION)
        props.status = "Room erased. Blender Undo can restore it."
        return {"FINISHED"}


class MOR_OT_set_circle_radius(Operator):
    bl_idname = "mor.set_circle_radius"
    bl_label = "Apply Radius to Active Circle"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        props = context.scene.mor_room_builder
        room = props.active_room
        circles = read_circles(room) if room else []
        if not circles:
            self.report({"ERROR"}, "The active room has no circle")
            return {"CANCELLED"}
        circles[-1]["radius"] = max(CELL, round(props.circle_radius))
        write_circles(room, circles)
        build_layout(context)
        return {"FINISHED"}


class MOR_OT_export_project(Operator):
    bl_idname = "mor.export_project"
    bl_label = "Export MoR Project"
    bl_options = {"REGISTER"}
    filepath: StringProperty(subtype="FILE_PATH", default="mor-room-project.json")

    def invoke(self, context, event):
        context.window_manager.fileselect_add(self)
        return {"RUNNING_MODAL"}

    def execute(self, context):
        props = context.scene.mor_room_builder
        payload = {
            "format": "mor-room-planner",
            "version": 3,
            "name": Path(self.filepath).stem,
            "rooms": [{
                "id": room.name,
                "cells": [{"x": x, "y": y} for x, y in sorted(read_cells(room))],
                "circles": read_circles(room),
                "cornerEdits": [{"vertexX": int(key.split(",")[0]), "vertexY": int(key.split(",")[1]), **value}
                                for key, value in read_corner_edits(room).items()],
                "style": {"innerWallVariant": room_style(room, props)["inner"],
                          "outerWallVariant": room_style(room, props)["outer"]},
            } for room in room_objects()],
        }
        Path(self.filepath).write_text(json.dumps(payload, indent=2), encoding="utf-8")
        props.status = f"Exported {len(payload['rooms'])} room(s)."
        return {"FINISHED"}


class MOR_OT_import_project(Operator):
    bl_idname = "mor.import_project"
    bl_label = "Import MoR Project"
    bl_options = {"REGISTER", "UNDO"}
    filepath: StringProperty(subtype="FILE_PATH")

    def invoke(self, context, event):
        context.window_manager.fileselect_add(self)
        return {"RUNNING_MODAL"}

    def execute(self, context):
        try:
            payload = json.loads(Path(self.filepath).read_text(encoding="utf-8"))
        except (OSError, ValueError) as error:
            self.report({"ERROR"}, f"Could not read project: {error}")
            return {"CANCELLED"}
        if payload.get("format") != "mor-room-planner" or payload.get("version") not in {1, 2, 3}:
            self.report({"ERROR"}, "Unsupported MoR project")
            return {"CANCELLED"}
        clear_collection(ROOMS_COLLECTION)
        collection = ensure_collection(ROOMS_COLLECTION)
        props = context.scene.mor_room_builder
        for index, data in enumerate(payload.get("rooms", [])):
            room = bpy.data.objects.new(str(data.get("id") or f"Room_{index + 1:03d}"), None)
            collection.objects.link(room)
            room.empty_display_type = "CUBE"
            room.empty_display_size = 0.45
            room[ROOM_FLAG] = True
            style = data.get("style") or {}
            room["mor_inner"] = str(style.get("innerWallVariant", "A")).upper()
            room["mor_outer"] = str(style.get("outerWallVariant", "A")).upper()
            write_cells(room, {(int(cell["x"]), int(cell["y"])) for cell in data.get("cells", [])})
            write_circles(room, data.get("circles", []))
            edits = {f"{int(edit['vertexX'])},{int(edit['vertexY'])}": {
                "inset": int(edit.get("insetCells", edit.get("inset", 1))),
                "kind": str(edit.get("kind", "diagonal")).upper(),
                "invert": bool(edit.get("inverted", edit.get("invert", False))),
            } for edit in data.get("cornerEdits", [])}
            write_corner_edits(room, edits)
            props.active_room = room
        if room_objects():
            build_layout(context)
        props.status = f"Imported {len(room_objects())} room(s)."
        return {"FINISHED"}

class MOR_OT_edit_corner(Operator):
    bl_idname = "mor.edit_room_corner"
    bl_label = "Edit Corner Shape"
    bl_description = "Click a yellow corner point and drag: inside makes a diagonal; crossing outside makes a curve"
    bl_options = {"REGISTER", "UNDO", "BLOCKING"}

    _room = None
    _vertex = None
    _dragging = False
    _original_edits = None
    _last_state = None

    def grid_point(self, context, event):
        region, rv3d = context.region, context.region_data
        if region is None or rv3d is None:
            return None
        coord = (event.mouse_region_x, event.mouse_region_y)
        origin = view3d_utils.region_2d_to_origin_3d(region, rv3d, coord)
        direction = view3d_utils.region_2d_to_vector_3d(region, rv3d, coord)
        hit = intersect_line_plane(origin, origin + direction, Vector((0, 0, 0)), Vector((0, 0, 1)))
        return (floor(hit.x / CELL), floor(hit.y / CELL)) if hit else None

    def nearest_corner(self, context, event):
        mouse = Vector((event.mouse_region_x, event.mouse_region_y))
        nearest = None
        nearest_distance = 32.0
        preferred = context.scene.mor_room_builder.active_room
        candidates = [preferred] if preferred and preferred.get(ROOM_FLAG) else room_objects()
        for room in candidates:
            for vertex in convex_room_corners(read_cells(room)):
                screen = view3d_utils.location_3d_to_region_2d(
                    context.region, context.region_data,
                    Vector((vertex[0] * CELL, vertex[1] * CELL, 0)),
                )
                if screen is None:
                    continue
                distance = (screen - mouse).length
                if distance < nearest_distance:
                    nearest = (room, vertex)
                    nearest_distance = distance
        return nearest

    def invoke(self, context, event):
        if context.area is None or context.area.type != "VIEW_3D":
            self.report({"ERROR"}, "Run Edit Corner from the 3D Viewport")
            return {"CANCELLED"}
        if not room_objects():
            self.report({"ERROR"}, "Create a room first")
            return {"CANCELLED"}
        self._room = self._vertex = None
        self._dragging = False
        self._original_edits = None
        self._last_state = None
        context.workspace.status_text_set(
            "Click a yellow point and drag | inside = diagonal | outside = curve | C toggles curve | I inverts | Esc cancels"
        )
        context.window.cursor_modal_set("CROSSHAIR")
        context.window_manager.modal_handler_add(self)
        return {"RUNNING_MODAL"}

    def finish(self, context, cancelled=False):
        if cancelled and self._room and self._original_edits is not None:
            write_corner_edits(self._room, self._original_edits)
            build_layout(context)
        context.workspace.status_text_set(None)
        context.window.cursor_modal_restore()

    def update_edit(self, context, grid, force_kind=None, toggle_invert=False):
        cells = read_cells(self._room)
        adjacent = cells_at_vertex(cells, self._vertex)[0]
        vx, vy = self._vertex
        sx = 1 if adjacent[0] == vx else -1
        sy = 1 if adjacent[1] == vy else -1
        local_x = (grid[0] - vx) * sx
        local_y = (grid[1] - vy) * sy
        inset = max(1, min(12, max(abs(local_x), abs(local_y))))
        key = f"{vx},{vy}"
        edits = read_corner_edits(self._room)
        previous = edits.get(key, {})
        kind = force_kind or ("CURVE" if local_x < 0 or local_y < 0 else "DIAGONAL")
        invert = bool(previous.get("invert", False))
        if toggle_invert:
            invert = not invert
        state = (inset, kind, invert)
        if state == self._last_state:
            return
        edits[key] = {"inset": inset, "kind": kind, "invert": invert}
        write_corner_edits(self._room, edits)
        self._last_state = state
        build_layout(context)
        context.scene.mor_room_builder.status = f"Corner {key}: {kind.lower()}, {inset} grid cell(s)"

    def modal(self, context, event):
        if event.type in NAV_PASSTHROUGH_TYPES and not self._dragging:
            return {"PASS_THROUGH"}
        if event.type in {"ESC", "RIGHTMOUSE"}:
            self.finish(context, cancelled=True)
            return {"CANCELLED"}
        if event.type == "LEFTMOUSE" and event.value == "PRESS":
            selected = self.nearest_corner(context, event)
            if selected:
                self._room, self._vertex = selected
                context.scene.mor_room_builder.active_room = self._room
                self._original_edits = read_corner_edits(self._room)
                self._last_state = None
                self._dragging = True
            return {"RUNNING_MODAL"}
        if event.type == "MOUSEMOVE" and self._dragging:
            grid = self.grid_point(context, event)
            if grid:
                self.update_edit(context, grid)
            return {"RUNNING_MODAL"}
        if event.type == "C" and event.value == "PRESS" and self._dragging:
            grid = self.grid_point(context, event) or self._vertex
            current = read_corner_edits(self._room).get(f"{self._vertex[0]},{self._vertex[1]}", {})
            self.update_edit(context, grid, "DIAGONAL" if current.get("kind") == "CURVE" else "CURVE")
            return {"RUNNING_MODAL"}
        if event.type == "I" and event.value == "PRESS" and self._dragging:
            grid = self.grid_point(context, event) or self._vertex
            self.update_edit(context, grid, "CURVE", True)
            return {"RUNNING_MODAL"}
        if event.type == "LEFTMOUSE" and event.value == "RELEASE" and self._dragging:
            self.finish(context)
            return {"FINISHED"}
        return {"RUNNING_MODAL"}


class MOR_OT_reset_corners(Operator):
    bl_idname = "mor.reset_room_corners"
    bl_label = "Reset Active Room Corners"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        props = context.scene.mor_room_builder
        room = props.active_room
        if not room or not room.get(ROOM_FLAG):
            self.report({"ERROR"}, "Choose an active room")
            return {"CANCELLED"}
        write_corner_edits(room, {})
        build_layout(context)
        return {"FINISHED"}


class MOR_OT_build(Operator):
    bl_idname = "mor.build_rooms"
    bl_label = "Rebuild"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        try:
            build_layout(context)
        except RuntimeError as error:
            self.report({"ERROR"}, str(error))
            return {"CANCELLED"}
        return {"FINISHED"}


class MOR_OT_use_selected_room(Operator):
    bl_idname = "mor.use_selected_room"
    bl_label = "Use Selected Room"

    def execute(self, context):
        room = context.active_object
        if not room or not room.get(ROOM_FLAG):
            self.report({"ERROR"}, "Select a MoR room empty")
            return {"CANCELLED"}
        context.scene.mor_room_builder.active_room = room
        return {"FINISHED"}


class MOR_OT_apply_room_style(Operator):
    bl_idname = "mor.apply_room_style"
    bl_label = "Apply Walls to Active Room"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        props = context.scene.mor_room_builder
        room = props.active_room
        if not room or not room.get(ROOM_FLAG):
            self.report({"ERROR"}, "Choose an active room")
            return {"CANCELLED"}
        room["mor_inner"] = str(props.inner_wall_variant)
        room["mor_outer"] = str(props.outer_wall_variant)
        build_layout(context)
        return {"FINISHED"}


class MOR_OT_clear(Operator):
    bl_idname = "mor.clear_rooms"
    bl_label = "Clear Rooms"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        clear_collection(GENERATED_COLLECTION)
        clear_collection(ROOMS_COLLECTION)
        clear_collection(DRAW_PREVIEW_COLLECTION)
        context.scene.mor_room_builder.active_room = None
        context.scene.mor_room_builder.status = "Rooms cleared."
        return {"FINISHED"}


class MOR_PT_room_builder(Panel):
    bl_label = "MoR Room Builder"
    bl_idname = "MOR_PT_room_builder"
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "MoR Builder"

    def draw(self, context):
        layout = self.layout
        props = context.scene.mor_room_builder
        box = layout.box()
        box.label(text="Asset Library")
        box.prop(props, "asset_folder")
        box.operator("mor.import_room_assets")
        box.prop(props, "asset_collection")
        box.operator("mor.scan_room_assets")
        box = layout.box()
        box.label(text="New Room (2 m cells)")
        row = box.row(align=True); row.prop(props, "origin_x"); row.prop(props, "origin_y")
        row = box.row(align=True); row.prop(props, "width_cells"); row.prop(props, "depth_cells")
        row = box.row(align=True); row.operator("mor.add_room"); row.operator("mor.draw_room")
        row = box.row(align=True); row.operator("mor.draw_circle", icon="MESH_CIRCLE"); row.operator("mor.move_room", icon="ORIENTATION_GLOBAL")
        row = box.row(align=True); row.operator("mor.erase_room", icon="TRASH"); row.prop(props, "circle_radius")
        box.operator("mor.set_circle_radius")
        box = layout.box()
        box.label(text="Room Wall Library")
        box.prop(props, "active_room")
        box.operator("mor.use_selected_room")
        row = box.row(align=True); row.prop(props, "inner_wall_variant"); row.prop(props, "outer_wall_variant")
        box.operator("mor.apply_room_style")
        box = layout.box()
        box.label(text="Corner Shape")
        row = box.row(align=True); row.operator("mor.edit_room_corner"); row.operator("mor.reset_room_corners")
        row = box.row(align=True); row.prop(props, "show_corner_handles"); row.prop(props, "corner_handle_size")
        box = layout.box()
        box.label(text="Layers")
        row = box.row(align=True); row.prop(props, "show_inner_walls"); row.prop(props, "show_outer_walls")
        row = box.row(align=True); row.prop(props, "flip_inner_walls"); row.prop(props, "flip_outer_walls")
        row = box.row(align=True); row.prop(props, "inner_wall_offset"); row.prop(props, "outer_wall_offset")
        box.prop(props, "shared_wall_gap")
        row = box.row(align=True); row.prop(props, "floor_variant"); row.prop(props, "show_pillars")
        box.prop(props, "clip_edited_ground")
        if props.show_pillars:
            row = box.row(align=True); row.prop(props, "pillar_variant"); row.prop(props, "pillar_offset")
        box = layout.box()
        box.label(text="Project")
        row = box.row(align=True); row.operator("mor.import_project", icon="IMPORT"); row.operator("mor.export_project", icon="EXPORT")
        row = layout.row(align=True); row.operator("mor.build_rooms"); row.operator("mor.clear_rooms")
        layout.label(text=props.status, icon="INFO")


CLASSES = (
    MORRoomProperties, MOR_OT_import_assets, MOR_OT_scan_assets, MOR_OT_add_room,
    MOR_OT_draw_room, MOR_OT_draw_circle, MOR_OT_move_room, MOR_OT_erase_room,
    MOR_OT_set_circle_radius, MOR_OT_export_project, MOR_OT_import_project,
    MOR_OT_edit_corner, MOR_OT_reset_corners, MOR_OT_build, MOR_OT_use_selected_room,
    MOR_OT_apply_room_style, MOR_OT_clear, MOR_PT_room_builder,
)


def register():
    for cls in CLASSES:
        bpy.utils.register_class(cls)
    bpy.types.Scene.mor_room_builder = PointerProperty(type=MORRoomProperties)


def unregister():
    del bpy.types.Scene.mor_room_builder
    for cls in reversed(CLASSES):
        bpy.utils.unregister_class(cls)


if __name__ == "__main__":
    register()
