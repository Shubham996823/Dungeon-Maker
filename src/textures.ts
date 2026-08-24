import * as THREE from "three";

/**
 * One GPU upload per image, however many models reference it.
 *
 * The asset pipeline (`scripts/optimize-assets.mjs`) pulls the shared trimsheets out of the
 * GLBs so six models point at one URL instead of embedding six copies. HTTP caching makes
 * that a download win on its own, but not a memory win: `GLTFLoader` keeps its image cache
 * per parse, so each file would still decode the image and build its own `THREE.Texture`,
 * and three allocates a `WebGLTexture` per distinct `Texture.source`. Six files, six uploads
 * of the same 2048x2048 pixels.
 *
 * This loader closes that gap. It fetches each URL once and hands out `clone()`s, and
 * `Texture.copy` assigns `source` by reference — so every clone shares one `Source` and
 * therefore one upload. Clones stay separate `Texture` objects on purpose: three's GPU cache
 * key covers the sampler state and colour space, so a file that legitimately wants different
 * wrapping (or reads the image as linear data rather than sRGB) still gets its own upload
 * instead of silently corrupting the other users of that image.
 *
 * Register it on the manager that `GLTFLoader` is constructed with:
 *
 *     const manager = new THREE.LoadingManager();
 *     manager.addHandler(/\.webp$/i, new SharedTextureLoader(manager, maxAnisotropy));
 *     const loader = new GLTFLoader(manager);
 */
export class SharedTextureLoader extends THREE.Loader<THREE.Texture> {
  private readonly masters = new Map<string, Promise<THREE.Texture>>();
  private readonly anisotropy: number;
  private handedOut = 0;

  constructor(manager: THREE.LoadingManager, anisotropy = 1) {
    super(manager);
    this.anisotropy = Math.max(1, Math.floor(anisotropy));
  }

  /**
   * `GLTFLoader` builds image URLs by concatenating the glTF `uri` onto the resource path,
   * so a perfectly ordinary `../textures/x.webp` arrives here as `/models/../textures/x.webp`.
   * Browsers resolve that fine, but two spellings of one path would be two cache misses, so
   * the key is the normalised pathname rather than whatever string we were handed.
   */
  private static key(url: string) {
    try {
      return new URL(url, globalThis.location?.href ?? "http://local/").pathname;
    } catch {
      return url;
    }
  }

  load(
    url: string,
    onLoad?: (texture: THREE.Texture) => void,
    onProgress?: (event: ProgressEvent) => void,
    onError?: (error: unknown) => void,
  ): THREE.Texture {
    const key = SharedTextureLoader.key(url);
    let master = this.masters.get(key);
    if (!master) {
      master = new Promise<THREE.Texture>((resolve, reject) => {
        new THREE.TextureLoader(this.manager).load(
          url,
          (texture) => {
            // Anisotropy belongs on the master so every clone inherits it. Floors are read at
            // grazing angles almost all the time, which is exactly the case plain mipmapping
            // blurs into mush, and it is the cheapest quality win available here.
            texture.anisotropy = this.anisotropy;
            resolve(texture);
          },
          onProgress,
          reject,
        );
      });
      this.masters.set(key, master);
    }

    // A placeholder is returned synchronously to honour the Loader contract; callers that
    // care (GLTFLoader among them) use the onLoad callback, which receives the real clone.
    const placeholder = new THREE.Texture();
    master.then(
      (texture) => {
        this.handedOut += 1;
        // `copy` assigns `source` by reference and flags `needsUpdate`, so the clone is
        // renderable immediately and adds no second upload.
        onLoad?.(texture.clone());
      },
      (error) => onError?.(error),
    );
    return placeholder;
  }

  /** Unique images fetched vs. texture instances issued — the deduplication, measured. */
  stats() {
    return { unique: this.masters.size, issued: this.handedOut };
  }

  dispose() {
    for (const master of this.masters.values()) {
      master.then((texture) => texture.dispose()).catch(() => undefined);
    }
    this.masters.clear();
  }
}
