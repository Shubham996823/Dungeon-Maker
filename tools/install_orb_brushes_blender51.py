import bpy
import os
import shutil


output_dir = os.path.join(os.path.expanduser("~"), "Documents", "Blender", "Assets", "Orb Brushes")
output_file = os.path.join(output_dir, "OrbBrushes-5.1.blend")
os.makedirs(output_dir, exist_ok=True)

source_dir = os.path.dirname(bpy.data.filepath)
for folder_name in ("textures", "Icons"):
    source_folder = os.path.join(source_dir, folder_name)
    target_folder = os.path.join(output_dir, folder_name)
    if os.path.isdir(source_folder):
        shutil.copytree(source_folder, target_folder, dirs_exist_ok=True)

orb_brushes = [brush for brush in bpy.data.brushes if "Orb" in brush.name]

for brush in orb_brushes:
    if brush.asset_data is None:
        brush.asset_mark()
    brush.asset_data.author = "Orb brush pack"
    brush.asset_data.description = "Converted for Blender 5.1 sculpt mode"
    brush.use_fake_user = True

for image in bpy.data.images:
    target_image = os.path.join(output_dir, "textures", os.path.basename(bpy.path.abspath(image.filepath)))
    if os.path.isfile(target_image):
        image.filepath = target_image

for brush in list(bpy.data.brushes):
    if brush not in orb_brushes and brush.asset_data is None and brush.users == 0:
        bpy.data.brushes.remove(brush)

bpy.ops.wm.save_as_mainfile(filepath=output_file, compress=True)
print(f"INSTALLED_FILE={output_file}")
print(f"INSTALLED_BRUSHES={len(orb_brushes)}")
