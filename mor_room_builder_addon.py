bl_info = {
    "name": "MoR Room Builder",
    "author": "Master of Realms / Codex",
    "version": (1, 8, 1),
    "blender": (3, 6, 0),
    "location": "View3D > Sidebar > MoR Builder",
    "description": "Build merged 2 m modular rooms with layered walls and corner pillars",
    "category": "Object",
}

import json
import re
from math import atan2, ceil, cos, floor, hypot, pi, sin
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
ROOMS_COLLECTION = "MoR_Rooms"
ASSET_COLLECTION = "MoR_Asset_Library"
GENERATED_COLLECTION = "MoR_Room_Generated"
DRAW_PREVIEW_COLLECTION = "MoR_Room_Draw_Preview"
FLOOR_RE = re.compile(r"^FL2x2(?P<v>[A-Za-z])$")
WALL_RE = re.compile(r"^W3x2(?P<v>[A-Za-z])$")
PILLAR_RE = re.compile(r"^P3_(?P<v>[A-Za-z])$")


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
        if obj.type not in {"MESH", "EMPTY"}:
            continue
        name = obj.name.split(".")[0]
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
    requested = (requested or "A").upper()
    return table.get(requested) or table.get("A") or next(iter(table.values()), None)


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
        "inner": room.get("mor_inner", props.inner_wall_variant).upper(),
        "outer": room.get("mor_outer", props.outer_wall_variant).upper(),
    }


def read_corner_edits(room):
    try:
        value = json.loads(room.get(ROOM_CORNERS, "{}"))
        return value if isinstance(value, dict) else {}
    except (TypeError, ValueError):
        return {}


def write_corner_edits(room, edits):
    room[ROOM_CORNERS] = json.dumps(edits)


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
    overlapping = [room for room in rooms if read_cells(room) & cells]
    merged = set(cells)
    style = {"inner": props.inner_wall_variant.upper(), "outer": props.outer_wall_variant.upper()}
    for room in overlapping:
        merged |= read_cells(room)
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
    xs = [cell[0] for cell in merged]
    ys = [cell[1] for cell in merged]
    room.location = ((min(xs) + max(xs) + 1) * CELL / 2, (min(ys) + max(ys) + 1) * CELL / 2, 0)
    props.active_room = room
    return room


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
    distance = max(0.0, min(total, distance))
    segment = segments[-1]
    for candidate in segments:
        if candidate[1] >= distance:
            segment = candidate
            break
    low, high, a, b = segment
    ratio = 0.0 if high == low else (distance - low) / (high - low)
    point = a.lerp(b, ratio)
    tangent = (b - a).normalized()
    return point, tangent


def deform_wall_path(source, collection, points, offset, flip, name_prefix):
    """Bend subdivided wall meshes continuously along a path without changing UVs."""
    segments, total = path_metrics(points)
    if not segments or total <= 0.000001:
        return 0
    count = max(1, int(round(total / CELL)))
    min_x = min(vertex.co.x for vertex in source.data.vertices)
    max_x = max(vertex.co.x for vertex in source.data.vertices)
    source_length = max(0.000001, max_x - min_x)
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
            fraction = (vertex.co.x - min_x) / source_length
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
        raise RuntimeError("Assign or import a library containing FL2x2A and W3x2A/B/C")
    rooms = room_objects()
    if not rooms:
        raise RuntimeError("Add or draw at least one room")

    clear_collection(GENERATED_COLLECTION)
    generated = ensure_collection(GENERATED_COLLECTION)
    owners = {}
    styles = {}
    for room_index, room in enumerate(rooms):
        styles[room_index] = room_style(room, props)
        for cell in read_cells(room):
            owners[cell] = room_index

    floor_source = variant(assets["floor"], props.floor_variant)
    floor_objects = {}
    for x, y in sorted(owners):
        owner = owners[(x, y)]
        floor_obj = duplicate(floor_source, generated, (x * CELL, y * CELL, 0), 0, f"Floor_X{x}_Y{y}")
        floor_objects.setdefault(owner, []).append(floor_obj)

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
    for cell, owner in owners.items():
        for side, delta in directions.items():
            neighbor = (cell[0] + delta[0], cell[1] + delta[1])
            other = owners.get(neighbor)
            if other == owner:
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
            for face_index, (face_cell, face_side, face_owner) in enumerate(sides[:2]):
                face_start, face_angle = wall_pose(face_cell, face_side)
                source = variant(assets["wall"], styles[face_owner]["inner"])
                place_wall(
                    source, generated, face_start, face_angle,
                    props.inner_wall_offset + props.shared_wall_gap,
                    props.flip_inner_walls,
                    f"SharedWall_E{edge_index}_Face{face_index}_R{face_owner}",
                )
                walls += 1

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
        # A single occupied quadrant is a true outside corner. Four occupied
        # quadrants is interior space and must never receive four pillars.
        for (x, y), count in sorted(vertices.items()):
            if count != 1 or (x, y) in edited_vertices:
                continue
            adjacent = next(cell for cell in owners if x in {cell[0], cell[0] + 1} and y in {cell[1], cell[1] + 1})
            inset_x = props.pillar_offset if adjacent[0] == x else -props.pillar_offset
            inset_y = props.pillar_offset if adjacent[1] == y else -props.pillar_offset
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
    floor_variant: StringProperty(name="Ground", default="A", maxlen=1)
    clip_edited_ground: BoolProperty(name="Clip Ground to Shape", description="Remove floor geometry outside diagonal and curved corner boundaries", default=True)
    inner_wall_variant: StringProperty(name="Inside Wall", default="A", maxlen=1)
    outer_wall_variant: StringProperty(name="Outside Wall", default="A", maxlen=1)
    pillar_variant: StringProperty(name="Pillar", default="A", maxlen=1)
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
        files = sorted(list(folder.glob("*.glb")) + list(folder.glob("*.gltf")))
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
        props.status = f"Imported {len(files)} asset files."
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
        room["mor_inner"] = props.inner_wall_variant.upper()
        room["mor_outer"] = props.outer_wall_variant.upper()
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
        row = layout.row(align=True); row.operator("mor.build_rooms"); row.operator("mor.clear_rooms")
        layout.label(text=props.status, icon="INFO")


CLASSES = (
    MORRoomProperties, MOR_OT_import_assets, MOR_OT_scan_assets, MOR_OT_add_room,
    MOR_OT_draw_room, MOR_OT_edit_corner, MOR_OT_reset_corners, MOR_OT_build, MOR_OT_use_selected_room,
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
