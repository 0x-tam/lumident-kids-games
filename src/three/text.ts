/**
 * In-world text, with no font files and no text geometry.
 *
 * Manrope is already loaded for the DOM (index.html), so the cheapest correct way to get
 * brand type into the 3D scene is to draw it on a 2D canvas and upload that. This gives us
 * real hinting, real kerning and real emoji fallback for free, and it costs one texture per
 * distinct label instead of a font atlas plus a shader.
 *
 * Everything is cached by the full option set and marked shared so `disposeObject3D` and
 * `DisposalBag.release()` walk past it — a game must never dispose a texture the cache is
 * still handing out.
 *
 * That `markShared` is also why this cache has to be **scene-registered** (`dispose.ts`).
 * `textures.ts`, `geometry.ts` and `materials.ts` all register; this one did not, so every
 * label a game ever drew stayed resident for the life of the tab and nothing could reach
 * it: `endurance.json` measured `renderer.info.memory.textures` climbing 3 → 9 → 11 across
 * two nine-game loops while `caches.texture` never moved off 1, because the growth was
 * entirely in here. Registration is what makes `markShared` safe rather than permanent:
 * `evict()` below disposes the texture directly, bypassing the shared guard, at the one
 * moment nothing can still be drawing with it.
 */
import { CanvasTexture, LinearFilter, LinearMipmapLinearFilter, SRGBColorSpace } from "three";
import { NEUTRAL } from "./tokens";
import { markShared, registerSceneCache, tagCacheEntry } from "./dispose";

export type TextOptions = {
  fontSize?: number;
  weight?: number;
  color?: string;
  background?: string;
  padding?: number;
  maxWidth?: number;
};

export type TextTexture = {
  texture: CanvasTexture;
  /** width / height of the canvas — multiply a plane's height by this to avoid stretching. */
  aspect: number;
  width: number;
  height: number;
};

/**
 * Hard ceiling on either canvas dimension. A game that asks for a 96px title at 3x DPR would
 * otherwise quietly allocate a 2048px texture per label; nine games' worth of those is how
 * a tablet runs out of GPU memory.
 */
const MAX_DIM = 1024;

/** Only the weights index.html actually requests — asking for 400 would silently synthesise. */
const WEIGHTS = [500, 600, 700, 800] as const;

const FAMILY = '"Manrope", system-ui, -apple-system, sans-serif';
const LINE_HEIGHT = 1.22;

const cache = new Map<string, TextTexture>();

/** Ownership namespace in `dispose.ts`. Must match the `registerSceneCache` name below. */
const CACHE_NAME = "text";

registerSceneCache({
  name: CACHE_NAME,
  // Yields the `CanvasTexture`, not the `TextTexture` wrapper around it. `dispose.ts`
  // decides whether to free or promote an entry by asking whether any *surviving* cache
  // entry still points at the same resource object, and what a material would be holding is
  // the texture. Handing over the wrapper would make that identity check silently miss, and
  // a shared material sampling a game-built label would have its texture freed underneath
  // it. Runs only during eviction, so the generator's allocation is not on a frame path.
  entries: function* (): Iterable<[string, object]> {
    for (const [key, entry] of cache) yield [key, entry.texture];
  },
  size: () => cache.size,
  evict: (key) => {
    const entry = cache.get(key);
    if (entry === undefined) return;
    entry.texture.dispose();
    cache.delete(key);
  },
});

/** One shared 1x1 canvas used only for measurement, so measuring never allocates a surface. */
let measureCtx: CanvasRenderingContext2D | null = null;

const getMeasureCtx = (): CanvasRenderingContext2D | null => {
  if (measureCtx) return measureCtx;
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  measureCtx = canvas.getContext("2d");
  return measureCtx;
};

/* ------------------------------------------------------------------ */
/* Font readiness                                                      */
/* ------------------------------------------------------------------ */

let fontPromise: Promise<void> | null = null;

/**
 * Resolves once Manrope is usable — or once we have waited long enough that continuing with
 * the system stack is better than showing nothing. A label rendered in system-ui is a small
 * brand miss; a game that never starts because a webfont 404'd is a broken product.
 */
export function ensureManrope(): Promise<void> {
  if (fontPromise) return fontPromise;

  fontPromise = new Promise<void>((resolve) => {
    const fonts = typeof document !== "undefined" ? document.fonts : undefined;
    if (!fonts || typeof fonts.load !== "function") {
      resolve();
      return;
    }

    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    // Hard deadline: whatever the network is doing, in-world text appears.
    const timer = setTimeout(finish, 1500);

    Promise.all(WEIGHTS.map((w) => fonts.load(`${w} 64px "Manrope"`).catch(() => undefined)))
      .then(() => (fonts.ready ? fonts.ready.catch(() => undefined) : undefined))
      .catch(() => undefined)
      .then(() => {
        clearTimeout(timer);
        finish();
      });
  });

  return fontPromise;
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

/** Greedy wrap. Honours explicit newlines first so a caller can force a break. */
function layout(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, out: string[]): number {
  out.length = 0;
  let widest = 0;

  for (const paragraph of text.split("\n")) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      out.push("");
      continue;
    }
    let line = words[0];
    for (let i = 1; i < words.length; i++) {
      const candidate = `${line} ${words[i]}`;
      if (maxWidth > 0 && ctx.measureText(candidate).width > maxWidth) {
        out.push(line);
        line = words[i];
      } else {
        line = candidate;
      }
    }
    out.push(line);
  }

  for (let i = 0; i < out.length; i++) {
    const w = ctx.measureText(out[i]).width;
    if (w > widest) widest = w;
  }
  return widest;
}

const lines: string[] = [];

export function textTexture(text: string, opts?: TextOptions): TextTexture {
  const fontSize = opts?.fontSize ?? 64;
  const weight = opts?.weight ?? 700;
  const color = opts?.color ?? NEUTRAL.ink;
  const background = opts?.background ?? "";
  const padding = opts?.padding ?? Math.round(fontSize * 0.28);
  const maxWidth = opts?.maxWidth ?? 0;

  const key = `${text}|${fontSize}|${weight}|${color}|${background}|${padding}|${maxWidth}`;
  // Tagged on *every* lookup, hit or miss: a hit from a second scene is what promotes a
  // label to the genuinely-shared tier and stops it being evicted under the scene that
  // happened to ask first.
  tagCacheEntry(CACHE_NAME, key);
  const hit = cache.get(key);
  if (hit) return hit;

  const ctx = getMeasureCtx();
  // Server-side / test environments without a 2D context still get a valid, disposable
  // object rather than an exception halfway through building a scene.
  if (!ctx) {
    const empty: TextTexture = {
      texture: markShared(new CanvasTexture(undefined as never)),
      aspect: 1,
      width: 1,
      height: 1,
    };
    cache.set(key, empty);
    return empty;
  }

  // Device-appropriate resolution, then a single exact rescale if that blows the cap.
  const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
  let scale = dpr > 2 ? 2 : dpr < 1 ? 1 : dpr;

  const measureAt = (s: number) => {
    ctx.font = `${weight} ${fontSize * s}px ${FAMILY}`;
    const widest = layout(ctx, text, maxWidth * s, lines);
    const w = widest + padding * s * 2;
    const h = lines.length * fontSize * s * LINE_HEIGHT + padding * s * 2;
    return { w, h };
  };

  let dims = measureAt(scale);
  const largest = Math.max(dims.w, dims.h);
  if (largest > MAX_DIM) {
    // Every term above is linear in `scale`, so one correction lands exactly on the cap.
    scale *= MAX_DIM / largest;
    dims = measureAt(scale);
  }

  const width = Math.max(1, Math.min(MAX_DIM, Math.ceil(dims.w)));
  const height = Math.max(1, Math.min(MAX_DIM, Math.ceil(dims.h)));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const draw = canvas.getContext("2d");
  if (!draw) {
    const fallback: TextTexture = { texture: markShared(new CanvasTexture(canvas)), aspect: width / height, width, height };
    cache.set(key, fallback);
    return fallback;
  }

  if (background) {
    draw.fillStyle = background;
    draw.fillRect(0, 0, width, height);
  }

  const px = fontSize * scale;
  draw.font = `${weight} ${px}px ${FAMILY}`;
  draw.fillStyle = color;
  draw.textAlign = "center";
  draw.textBaseline = "middle";

  const lineStep = px * LINE_HEIGHT;
  const top = (height - lines.length * lineStep) * 0.5;
  for (let i = 0; i < lines.length; i++) {
    draw.fillText(lines[i], width * 0.5, top + lineStep * (i + 0.5));
  }

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.generateMipmaps = true;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.magFilter = LinearFilter;
  // 4 is the sweet spot: labels lying flat on a tray stay readable, and it is cheap enough
  // that a mid-tier mobile GPU does not notice. Three clamps this to the device maximum.
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  markShared(texture);

  const result: TextTexture = { texture, aspect: width / height, width, height };
  cache.set(key, result);
  return result;
}

/**
 * Frees every generated label. The teardown twin of `disposeTextureCache()` and
 * `disposeGeometryCache()` — app teardown and leak tests only. Per-scene reclamation goes
 * through `evict` above, driven by `dispose.ts`, not through this.
 */
export function disposeTextCache(): void {
  for (const entry of cache.values()) entry.texture.dispose();
  cache.clear();
}
