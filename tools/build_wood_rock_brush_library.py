import bpy
import os
import re


WOOD_ROOT = r"C:\Users\shubh\Downloads\Telegram Desktop\150 WOOD BRUSHES + 4K SEAMLESS ALPHAS - VOL 01"
ROCK_ROOT = r"C:\Users\shubh\Downloads\Telegram Desktop\Essential Rock Brushes Vol1"
OUTPUT_DIR = r"C:\Users\shubh\Documents\Blender\Assets\Nature Brushes"
OUTPUT_FILE = os.path.join(OUTPUT_DIR, "Wood-and-Rock-Brushes.blend")


def number_from_name(path):
    match = re.search(r"(\d+)(?!.*\d)", os.path.splitext(os.path.basename(path))[0])
    return int(match.group(1)) if match else -1


def set_preview(brush, preview_path):
    if not preview_path:
        return
    try:
        preview_image = bpy.data.images.load(preview_path, check_existing=False)
        preview_image.colorspace_settings.name = "sRGB"
        preview = brush.preview_ensure()
        width, height = preview_image.size[:]
        preview.image_size = (width, height)
        preview.image_pixels_float = preview_image.pixels[:]
        bpy.data.images.remove(preview_image)
    except Exception as exc:
        print(f"Preview skipped for {brush.name}: {exc}")


def add_brush(name, alpha_path, preview_path, pack_name):
    image = bpy.data.images.load(alpha_path, check_existing=False)
    image.colorspace_settings.name = "Non-Color"
    texture = bpy.data.textures.new(f"{name} Alpha", type="IMAGE")
    texture.image = image

    brush = bpy.data.brushes.new(name)
    brush.use_paint_sculpt = True
    brush.sculpt_brush_type = "DRAW"
    brush.texture = texture
    brush.strength = 0.35
    brush.size = 120
    brush.texture_slot.map_mode = "VIEW_PLANE"
    brush.asset_mark()
    brush.asset_data.author = pack_name
    brush.asset_data.description = f"{pack_name} sculpt alpha"
    brush.asset_data.tags.new(pack_name)
    brush.use_fake_user = True
    set_preview(brush, preview_path)
    return brush


def files_with_extension(root, extension):
    return sorted(
        [os.path.join(dirpath, filename) for dirpath, _, filenames in os.walk(root)
         for filename in filenames if filename.lower().endswith(extension)],
        key=lambda path: (number_from_name(path), path.lower()),
    )


os.makedirs(OUTPUT_DIR, exist_ok=True)
wood_alphas = files_with_extension(WOOD_ROOT, ".png")
wood_previews = files_with_extension(WOOD_ROOT, ".jpg")
preview_by_number = {number_from_name(path): path for path in wood_previews}
rock_alphas = files_with_extension(ROCK_ROOT, ".psd")

for alpha_path in wood_alphas:
    stem = os.path.splitext(os.path.basename(alpha_path))[0]
    preview = preview_by_number.get(number_from_name(alpha_path))
    add_brush(f"Wood | {stem}", alpha_path, preview, "150 Wood Brushes")

for alpha_path in rock_alphas:
    stem = os.path.splitext(os.path.basename(alpha_path))[0]
    add_brush(f"Rock | {stem}", alpha_path, None, "Essential Rock Brushes")

bpy.ops.wm.save_as_mainfile(filepath=OUTPUT_FILE, compress=True)
print(f"LIBRARY={OUTPUT_FILE}")
print(f"WOOD_BRUSHES={len(wood_alphas)}")
print(f"ROCK_BRUSHES={len(rock_alphas)}")
