"""Run with Blender --background --factory-startup --python this-file."""
import bpy
import runpy
from pathlib import Path

root = Path(__file__).resolve().parents[1]
a = runpy.run_path(str(root / 'mor_room_builder_addon.py'))
a['register']()
lib = a['ensure_collection']('TestAssets')
for path in [root / 'public/models/FL2x2A.glb', root / 'assets/models/W2.5x2_2.glb', root / 'assets/models/P_2.5_1.glb']:
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=str(path))
    meshes = [o for o in bpy.data.objects if o not in before and o.type == 'MESH']
    print('IMPORTED', path.name, [(o.name, len(o.data.vertices)) for o in meshes])
    for o in meshes:
        a['move_to_collection'](o, lib)
        if len(meshes) == 1:
            o.name = path.stem
p = bpy.context.scene.mor_room_builder
p.asset_collection = lib
p.inner_wall_variant = 2
p.outer_wall_variant = 2
print('SCAN', a['scan_assets'](lib))
bpy.ops.mor.add_room()
a['build_layout'](bpy.context)
objects = list(bpy.data.collections[a['GENERATED_COLLECTION']].objects)
for prefix in ('Floor_', 'Wall_', 'Pillar_'):
    assert any(o.name.startswith(prefix) and o.type == 'MESH' for o in objects), prefix
print('PASS', p.status)

# Decorative overhangs must not determine the structural repeat width.
mesh = bpy.data.meshes.new('OverhangingWall')
mesh.from_pydata([(0, 0, 0), (2, 0, 0), (-0.02, 0, 1), (2.02, 0, 1)], [], [])
source = bpy.data.objects.new('TestWall', mesh)
lib.objects.link(source)
generated = a['ensure_collection']('SeamTest')
for flip in (False, True):
    a['clear_collection']('SeamTest')
    count = a['deform_wall_path'](source, generated, [(0, 0), (2, 1), (4, 0)], 0, flip, 'Seam')
    modules = sorted(generated.objects, key=lambda o: o.name)
    assert count == 3  # ceil prevents stretching beyond the nominal 2 m span.
    for left, right in zip(modules, modules[1:]):
        assert (left.data.vertices[1].co - right.data.vertices[0].co).length < 1e-6
print('PASS nominal 2 m seams, both orientations')

# A finite-thickness wall must close on both faces, not only its centreline.
from math import cos, sin, pi
points = [(4*cos(2*pi*i/96), 4*sin(2*pi*i/96)) for i in range(96)]
points.append(points[0])
segments, total = a['path_metrics'](points)
start, start_tangent = a['point_and_tangent_at'](segments, total, 0)
end, end_tangent = a['point_and_tangent_at'](segments, total, total)
assert (start-end).length < 1e-6
assert (start_tangent-end_tangent).length < 1e-6
for low, high, _, _ in segments:
    _, left = a['point_and_tangent_at'](segments, total, high-1e-8)
    _, right = a['point_and_tangent_at'](segments, total, high+1e-8)
    assert (left-right).length < 1e-5
for v in source.data.vertices:
    v.co.y = 0.25
for flip in (False, True):
    a['clear_collection']('SeamTest')
    a['deform_wall_path'](source, generated, points, 0.15, flip, 'Closed')
    modules = sorted(generated.objects, key=lambda o: o.name)
    for left, right in zip(modules, modules[1:] + modules[:1]):
        assert (left.data.vertices[1].co-right.data.vertices[0].co).length < 1e-5
print('PASS closed-circle seams with thickness, offset, and both orientations')
