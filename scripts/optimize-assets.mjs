/**
 * Asset pipeline: `assets/models/*.glb` (source of truth, untouched) -> `public/`.
 *
 * The source GLBs each embed their own copy of the same 2048x2048 trimsheet pair, so seven
 * models ship 46 MB to deliver 13 MB of unique pixels, and the GPU holds one upload per
 * (file, texture) pair rather than one per image. This script pulls every image out to a
 * single content-addressed file under `public/textures/` and leaves the GLB carrying nothing
 * but geometry and a URI reference.
 *
 * Download shrinks because duplicate bytes are gone and WebP replaces PNG. VRAM shrinks
 * because the runtime can now recognise two GLBs pointing at one URI as one texture --
 * see `canonicalizeTextures` in `src/assets/textures.ts`, which is the other half of this.
 *
 * The emitted GLBs use `images[].uri` with a WebP mime type and no `EXT_texture_webp`
 * declaration. That is deliberate: three's GLTFLoader resolves external URIs through the
 * browser's own image decoder, which handles WebP natively, and these files are build
 * artifacts consumed only by this app. The conformant originals stay in `assets/models/`.
 *
 * Usage: npm run assets            (add --check to verify without writing)
 */
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const SOURCE_MODELS = join(ROOT, "assets", "models");
const SOURCE_THUMBS = join(ROOT, "assets", "Thumbnails");
const OUT_MODELS = join(ROOT, "public", "models");
const OUT_THUMBS = join(ROOT, "public", "Thumbnails");
const OUT_TEXTURES = join(ROOT, "public", "textures");
/** Where the emitted GLB points at a texture, relative to `public/models/`. */
const TEXTURE_HREF_PREFIX = "../textures/";

/**
 * The asset-library thumbnails render at 114 CSS px wide under `object-fit: cover`, so this
 * covers a 3x display and still crops the same way. Sources are only 294-844 px wide, so a
 * cap rather than a resize: nothing is ever scaled up.
 */
const THUMB_MAX_WIDTH = 340;
const THUMB_ENCODE = { quality: 82, effort: 6 };

const GLB_MAGIC = 0x46546c67; // "glTF"
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

/**
 * Normal maps get near-lossless WebP: a plain quality-95 encode leaves 3% of samples off by
 * more than 8/255 and 135 off by more than 64/255, which reads as lighting speckle on trim
 * edges. Near-lossless at 40 holds a hard 4/255 ceiling for ~65% of the lossless size.
 * Base colour is albedo under three lights and tolerates ordinary lossy encoding.
 */
const ENCODE = {
  normal: { nearLossless: true, quality: 40, effort: 6 },
  color: { quality: 90, effort: 6 },
};

const checkOnly = process.argv.includes("--check");

function parseGlb(buffer, label) {
  if (buffer.length < 12 || buffer.readUInt32LE(0) !== GLB_MAGIC) {
    throw new Error(`${label}: not a GLB (bad magic)`);
  }
  let offset = 12;
  let json = null;
  let bin = Buffer.alloc(0);
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32LE(offset);
    const type = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (type === CHUNK_JSON) json = JSON.parse(buffer.subarray(start, start + length).toString("utf8"));
    else if (type === CHUNK_BIN) bin = buffer.subarray(start, start + length);
    offset = start + length;
  }
  if (!json) throw new Error(`${label}: no JSON chunk`);
  return { json, bin };
}

function writeGlb(json, bin) {
  const jsonBytes = Buffer.from(JSON.stringify(json), "utf8");
  const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
  const binPad = (4 - (bin.length % 4)) % 4;
  const jsonChunk = Buffer.concat([jsonBytes, Buffer.alloc(jsonPad, 0x20)]);
  const binChunk = Buffer.concat([bin, Buffer.alloc(binPad, 0)]);
  const hasBin = binChunk.length > 0;
  const total = 12 + 8 + jsonChunk.length + (hasBin ? 8 + binChunk.length : 0);
  const out = Buffer.alloc(total);
  out.writeUInt32LE(GLB_MAGIC, 0);
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(total, 8);
  out.writeUInt32LE(jsonChunk.length, 12);
  out.writeUInt32LE(CHUNK_JSON, 16);
  jsonChunk.copy(out, 20);
  if (hasBin) {
    const at = 20 + jsonChunk.length;
    out.writeUInt32LE(binChunk.length, at);
    out.writeUInt32LE(CHUNK_BIN, at + 4);
    binChunk.copy(out, at + 8);
  }
  return out;
}

/** glTF texture slots that carry colour; everything else is treated as linear data. */
const COLOR_SLOTS = new Set(["baseColorTexture", "emissiveTexture"]);

/**
 * Which encoder each image needs, decided by the material slot that references it rather
 * than by filename — an image called `..._Normal` plugged into base colour would still be
 * colour data, and guessing from the name is how normal maps end up gamma-mangled.
 *
 * Also reports whether the alpha channel can be dropped. That is a spec question, not a
 * pixel-statistics question: `normalTexture` is defined to read RGB only, and an OPAQUE
 * material ignores base-colour alpha outright. These trimsheets ship an alpha channel that
 * sits at 253-255 — export padding that would otherwise cost a quarter of every upload.
 */
function classifyImages(json) {
  const kinds = new Map();
  const needsAlpha = new Set();
  const mark = (textureIndex, kind, alpha) => {
    const texture = json.textures?.[textureIndex];
    if (!texture || texture.source == null) return;
    // A normal-map use wins: encoding colour data near-losslessly only costs bytes,
    // while encoding normals lossily costs visible quality.
    if (kind === "normal" || !kinds.has(texture.source)) kinds.set(texture.source, kind);
    if (alpha) needsAlpha.add(texture.source);
  };
  for (const material of json.materials ?? []) {
    const pbr = material.pbrMetallicRoughness ?? {};
    const blends = material.alphaMode === "BLEND" || material.alphaMode === "MASK";
    for (const [slot, value] of Object.entries({ ...material, ...pbr })) {
      if (!value || typeof value !== "object" || value.index == null) continue;
      const isColor = COLOR_SLOTS.has(slot);
      mark(value.index, isColor ? "color" : "normal", isColor && slot === "baseColorTexture" && blends);
    }
  }
  return { kinds, needsAlpha };
}

async function encodeImage(bytes, kind, keepAlpha, name) {
  const { hasAlpha } = await sharp(bytes).metadata();
  let pipeline = sharp(bytes);
  if (hasAlpha && !keepAlpha) {
    pipeline = pipeline.removeAlpha();
  } else if (hasAlpha) {
    const stats = await sharp(bytes).stats();
    const alpha = stats.channels[stats.channels.length - 1];
    if (alpha.min >= 250) console.warn(`  ! ${name}: alpha kept for a blended material but never drops below ${alpha.min}`);
  }
  return pipeline.webp(ENCODE[kind]).toBuffer();
}

async function convertThumbnails() {
  let names = [];
  try {
    names = (await readdir(SOURCE_THUMBS)).filter((name) => /\.(png|jpe?g)$/i.test(name)).sort();
  } catch {
    return [];
  }
  if (!checkOnly && names.length) await mkdir(OUT_THUMBS, { recursive: true });
  const rows = [];
  for (const name of names) {
    const source = await readFile(join(SOURCE_THUMBS, name));
    const { width, hasAlpha } = await sharp(source).metadata();
    let pipeline = sharp(source);
    if (hasAlpha) {
      const { isOpaque } = await sharp(source).stats();
      if (isOpaque) pipeline = pipeline.removeAlpha();
    }
    if (width > THUMB_MAX_WIDTH) pipeline = pipeline.resize({ width: THUMB_MAX_WIDTH });
    const encoded = await pipeline.webp(THUMB_ENCODE).toBuffer();
    const out = name.replace(/\.(png|jpe?g)$/i, ".webp");
    if (!checkOnly) await writeFile(join(OUT_THUMBS, out), encoded);
    rows.push({ name, out, from: source.length, to: encoded.length });
  }
  return rows;
}

async function main() {
  const files = (await readdir(SOURCE_MODELS)).filter((name) => name.toLowerCase().endsWith(".glb")).sort();
  if (!files.length) throw new Error(`no .glb files in ${SOURCE_MODELS}`);
  if (!checkOnly) {
    await mkdir(OUT_MODELS, { recursive: true });
    await mkdir(OUT_TEXTURES, { recursive: true });
  }

  /** hash -> { href, bytes, kind, sourceBytes, usedBy[] } — one entry per unique image. */
  const textures = new Map();
  const report = [];

  for (const file of files) {
    const source = await readFile(join(SOURCE_MODELS, file));
    const { json, bin } = parseGlb(source, file);
    if ((json.buffers?.length ?? 0) > 1) throw new Error(`${file}: multiple buffers are not handled`);
    if (json.buffers?.[0]?.uri) throw new Error(`${file}: external buffer is not handled`);

    const { kinds, needsAlpha } = classifyImages(json);
    const imageViews = new Set();

    for (const [index, image] of (json.images ?? []).entries()) {
      if (image.uri) continue; // already external
      if (image.bufferView == null) throw new Error(`${file}: image ${index} has neither uri nor bufferView`);
      const view = json.bufferViews[image.bufferView];
      const bytes = bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
      const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
      const kind = kinds.get(index) ?? "color";

      let entry = textures.get(hash);
      if (!entry) {
        const stem = (image.name ?? `image-${hash}`).replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/\.png$/i, "");
        entry = {
          href: `${stem}.${hash.slice(0, 8)}.webp`,
          kind,
          keepAlpha: needsAlpha.has(index),
          sourceBytes: bytes.length,
          encoded: null,
          raw: bytes,
          usedBy: [],
        };
        textures.set(hash, entry);
      } else if (entry.kind !== kind) {
        throw new Error(`${file}: image ${image.name} is used as ${kind} here but ${entry.kind} elsewhere`);
      } else if (needsAlpha.has(index)) {
        // One blended use anywhere means the channel has to survive for every use.
        entry.keepAlpha = true;
      }
      entry.usedBy.push(file);

      imageViews.add(image.bufferView);
      json.images[index] = { name: image.name, mimeType: "image/webp", uri: TEXTURE_HREF_PREFIX + entry.href };
    }

    // Repack the BIN chunk without the image bytes, remapping every bufferView reference.
    const keep = json.bufferViews.map((_, index) => index).filter((index) => !imageViews.has(index));
    const remap = new Map(keep.map((oldIndex, newIndex) => [oldIndex, newIndex]));
    const chunks = [];
    const nextViews = [];
    let cursor = 0;
    for (const index of keep) {
      const view = json.bufferViews[index];
      const bytes = bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
      const pad = (4 - (cursor % 4)) % 4;
      if (pad) {
        chunks.push(Buffer.alloc(pad, 0));
        cursor += pad;
      }
      chunks.push(bytes);
      nextViews.push({ ...view, byteOffset: cursor });
      cursor += bytes.length;
    }
    for (const accessor of json.accessors ?? []) {
      if (accessor.bufferView == null) continue;
      const mapped = remap.get(accessor.bufferView);
      if (mapped == null) throw new Error(`${file}: accessor points at a stripped bufferView`);
      accessor.bufferView = mapped;
    }
    json.bufferViews = nextViews;
    const nextBin = Buffer.concat(chunks);
    if (json.buffers?.[0]) json.buffers[0].byteLength = nextBin.length;
    if (!nextBin.length) json.buffers = [];

    const out = writeGlb(json, nextBin);
    if (!checkOnly) await writeFile(join(OUT_MODELS, file), out);
    report.push({ file, from: source.length, to: out.length });
  }

  for (const entry of textures.values()) {
    entry.encoded = await encodeImage(entry.raw, entry.kind, entry.keepAlpha, entry.href);
    if (!checkOnly) await writeFile(join(OUT_TEXTURES, entry.href), entry.encoded);
  }

  const modelsFrom = report.reduce((sum, row) => sum + row.from, 0);
  const modelsTo = report.reduce((sum, row) => sum + row.to, 0);
  const texturesTo = [...textures.values()].reduce((sum, entry) => sum + entry.encoded.length, 0);
  const thumbs = await convertThumbnails();
  const thumbsFrom = thumbs.reduce((sum, row) => sum + row.from, 0);
  const thumbsTo = thumbs.reduce((sum, row) => sum + row.to, 0);
  const kb = (bytes) => `${(bytes / 1024).toFixed(0)} kB`;
  const mb = (bytes) => `${(bytes / 1048576).toFixed(2)} MB`;

  console.log(`\nmodels  ${SOURCE_MODELS} -> ${OUT_MODELS}`);
  for (const row of report) console.log(`  ${row.file.padEnd(14)} ${kb(row.from).padStart(9)} -> ${kb(row.to).padStart(8)}`);
  console.log(`\ntextures  ${OUT_TEXTURES}`);
  for (const entry of textures.values()) {
    console.log(`  ${entry.href.padEnd(34)} ${entry.kind.padEnd(6)} ${kb(entry.sourceBytes).padStart(8)} -> ${kb(entry.encoded.length).padStart(8)}  x${entry.usedBy.length} models`);
  }
  if (thumbs.length) {
    console.log(`\nthumbnails  ${SOURCE_THUMBS} -> ${OUT_THUMBS}`);
    for (const row of thumbs) console.log(`  ${row.out.padEnd(34)} ${" ".repeat(6)} ${kb(row.from).padStart(8)} -> ${kb(row.to).padStart(8)}`);
  }
  const from = modelsFrom + thumbsFrom;
  const to = modelsTo + texturesTo + thumbsTo;
  console.log(`\n  models      ${mb(modelsFrom)} -> ${mb(modelsTo)}`);
  console.log(`  textures           -> ${mb(texturesTo)}`);
  console.log(`  thumbnails  ${mb(thumbsFrom)} -> ${mb(thumbsTo)}`);
  console.log(`  shipped     ${mb(from)} -> ${mb(to)}  (${(from / to).toFixed(1)}x smaller)`);
  if (checkOnly) console.log("\n--check: nothing written");
}

await main();
