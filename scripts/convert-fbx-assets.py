"""Convert reusable MoR FBX modules to textured runtime GLBs.

Run with Blender, not system Python:
  blender --background --factory-startup --python scripts/convert-fbx-assets.py

FBX files and PNG trimsheets remain source-of-truth. Output GLBs are consumed by
scripts/optimize-assets.mjs, which externalises and deduplicates their textures.

Openings are cut in the browser at runtime. This script never generates a
wall/opening combination mesh.
"""
from pathlib import Path
import sys
import bpy

ROOT = Path(__file__).resolve().parents[1]
MODELS = ROOT / "assets" / "models"
TEXTURES = ROOT / "assets" / "Texture"
RUNTIME_MODELS = ROOT / "public" / "models"

def reset_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)


def shared_material():
    material = bpy.data.materials.get("MoR_Trimsheet_02") or bpy.data.materials.new("MoR_Trimsheet_02")
    material.use_nodes = True
    nodes = material.node_tree.nodes
    nodes.clear()
    output = nodes.new("ShaderNodeOutputMaterial")
    shader = nodes.new("ShaderNodeBsdfPrincipled")
    material.node_tree.links.new(shader.outputs["BSDF"], output.inputs["Surface"])

    def image_node(filename, colorspace):
        path = TEXTURES / filename
        image = bpy.data.images.get(filename) or bpy.data.images.load(str(path), check_existing=True)
        image.colorspace_settings.name = colorspace
        node = nodes.new("ShaderNodeTexImage")
        node.image = image
        return node

    base = image_node("Trimsheet_02_BaseColor.png", "sRGB")
    roughness = image_node("Trimsheet_02_Roughness.png", "Non-Color")
    metallic = image_node("Trimsheet_02_Metallic.png", "Non-Color")
    normal_image = image_node("Trimsheet_02_Normal.png", "Non-Color")
    normal = nodes.new("ShaderNodeNormalMap")
    material.node_tree.links.new(base.outputs["Color"], shader.inputs["Base Color"])
    material.node_tree.links.new(roughness.outputs["Color"], shader.inputs["Roughness"])
    material.node_tree.links.new(metallic.outputs["Color"], shader.inputs["Metallic"])
    material.node_tree.links.new(normal_image.outputs["Color"], normal.inputs["Color"])
    material.node_tree.links.new(normal.outputs["Normal"], shader.inputs["Normal"])
    return material


def floor_material(index):
    name = f"MoR_Floor_{index}"
    filename = "FLoor_1.jpg" if index == 1 else "Floor_2.jpg"
    material = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    material.use_nodes = True
    nodes = material.node_tree.nodes
    nodes.clear()
    output = nodes.new("ShaderNodeOutputMaterial")
    shader = nodes.new("ShaderNodeBsdfPrincipled")
    shader.inputs["Roughness"].default_value = 0.82
    image = bpy.data.images.get(filename) or bpy.data.images.load(str(TEXTURES / filename), check_existing=True)
    image.colorspace_settings.name = "sRGB"
    texture = nodes.new("ShaderNodeTexImage")
    texture.image = image
    material.node_tree.links.new(texture.outputs["Color"], shader.inputs["Base Color"])
    material.node_tree.links.new(shader.outputs["BSDF"], output.inputs["Surface"])
    return material


MATERIAL = shared_material()
FLOOR_MATERIALS = {
    "FL2x2_1": floor_material(1),
    "FL2x2_2": floor_material(2),
}


def import_fbx(path):
    reset_scene()
    bpy.ops.import_scene.fbx(filepath=str(path))
    meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
    # Some exports contain Blender reference/blockout objects alongside the authored
    # module. When an object is explicitly named after the asset, it is the source of
    # truth and the unrelated helpers must not be shipped with the runtime mesh.
    if path.stem.startswith("FL2x2_") or path.stem == "ST_2.5x4_1":
        named_asset = [obj for obj in meshes if obj.name == path.stem]
        if named_asset:
            meshes = named_asset
    material = FLOOR_MATERIALS.get(path.stem, MATERIAL)
    for obj in meshes:
        obj.select_set(True)
        obj.data.materials.clear()
        obj.data.materials.append(material)
    return meshes


def export_selected(path, objects):
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    bpy.ops.export_scene.gltf(
        filepath=str(path),
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_materials="EXPORT",
    )


requested_stems = {argument for argument in sys.argv[sys.argv.index("--") + 1:]} if "--" in sys.argv else set()
sources = sorted(path for path in MODELS.glob("*.fbx") if "BoxCut" not in path.stem
                 and (not requested_stems or path.stem in requested_stems))
if requested_stems and not sources:
    raise RuntimeError(f"No matching FBX sources found for: {', '.join(sorted(requested_stems))}")

for source in sources:
    RUNTIME_MODELS.mkdir(parents=True, exist_ok=True)
    export_selected(RUNTIME_MODELS / f"{source.stem}.glb", import_fbx(source))
    print("converted", source.name)

print("Converted reusable assets only; openings are subtracted at runtime in the web editor")
