/**
 * Procedural texture bank.
 *
 * The spec forbids any downloaded image, so every map in the product is generated here
 * from a seeded hash — deterministic across reloads, identical on every device, and free
 * of network cost. Everything is built once, cached by key and `markShared()`, because a
 * child bounces between nine games in one sitting and these maps must survive scene
 * teardown untouched.
 *
 * Colour-space discipline (three's ColorManagement is on):
 *   - normal / mask / grain maps are DATA: `NoColorSpace`, no sRGB decode.
 *   - gradients and sprites are COLOUR: `SRGBColorSpace`.
 * Getting this backwards is the classic reason procedural clay reads as washed-out
 * plastic, so it is set explicitly on every texture rather than left to a default.
 */
import {
  ClampToEdgeWrapping,
  Color,
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  NoColorSpace,
  RGBAFormat,
  RepeatWrapping,
  SRGBColorSpace,
  Texture,
  UnsignedByteType,
} from "three";
import { markShared, registerSceneCache, tagCacheEntry } from "./dispose";
import { ACCENTS, CLAY } from "./tokens";

/* ------------------------------------------------------------------ */
/* Cache                                                               */
/* ------------------------------------------------------------------ */

const cache = new Map<string, Texture>();

function cached(key: string, build: () => Texture): Texture {
  let tex = cache.get(key);
  if (tex === undefined) {
    tex = markShared(build());
    tex.name = key;
    cache.set(key, tex);
  }
  // Attributes the lookup to whichever scene is live. `dispose.ts` never frees a texture a
  // surviving material still points at, so shared maps (grain, blob shadow) are safe.
  tagCacheEntry("texture", key);
  return tex;
}

registerSceneCache({
  name: "texture",
  entries: () => cache.entries(),
  size: () => cache.size,
  evict: (key) => {
    const tex = cache.get(key);
    if (tex === undefined) return;
    tex.dispose();
    cache.delete(key);
  },
});

/** Frees every generated texture. Only the app teardown / leak tests should call this. */
export function disposeTextureCache(): void {
  for (const tex of cache.values()) tex.dispose();
  cache.clear();
}

/* ------------------------------------------------------------------ */
/* Deterministic noise                                                 */
/* ------------------------------------------------------------------ */

const clamp01 = (t: number) => (t < 0 ? 0 : t > 1 ? 1 : t);

/** 32-bit integer hash. `Math.random` is banned here: the same seed must give the same clay. */
function hashU(x: number, y: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x2545f491);
  h ^= h >>> 13;
  return h >>> 0;
}

/**
 * Gradient directions are precomputed. Perlin normally needs two trig calls per lattice
 * corner; at 256x256x4 octaves that is two million `Math.cos` calls and a visible hitch,
 * so the angles are quantised into a table instead.
 */
const GRAD_COUNT = 64;
const GRAD_X = new Float32Array(GRAD_COUNT);
const GRAD_Y = new Float32Array(GRAD_COUNT);
for (let i = 0; i < GRAD_COUNT; i++) {
  const a = (i / GRAD_COUNT) * Math.PI * 2;
  GRAD_X[i] = Math.cos(a);
  GRAD_Y[i] = Math.sin(a);
}

/** Quintic fade — C2 continuous, so derived normals have no lattice banding. */
const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

/** `period <= 0` means "do not tile". */
const wrapLattice = (v: number, period: number) => (period > 0 ? ((v % period) + period) % period : v);

/**
 * Perlin-style gradient noise, output roughly -0.7..0.7.
 * When `period` is a positive integer the lattice wraps, which is what makes
 * `noiseNormalTexture` seamless under `RepeatWrapping`.
 */
function gradNoise(x: number, y: number, period: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const u = fade(fx);
  const v = fade(fy);

  const x0 = wrapLattice(xi, period);
  const x1 = wrapLattice(xi + 1, period);
  const y0 = wrapLattice(yi, period);
  const y1 = wrapLattice(yi + 1, period);

  const g00 = hashU(x0, y0) % GRAD_COUNT;
  const g10 = hashU(x1, y0) % GRAD_COUNT;
  const g01 = hashU(x0, y1) % GRAD_COUNT;
  const g11 = hashU(x1, y1) % GRAD_COUNT;

  const n00 = GRAD_X[g00] * fx + GRAD_Y[g00] * fy;
  const n10 = GRAD_X[g10] * (fx - 1) + GRAD_Y[g10] * fy;
  const n01 = GRAD_X[g01] * fx + GRAD_Y[g01] * (fy - 1);
  const n11 = GRAD_X[g11] * (fx - 1) + GRAD_Y[g11] * (fy - 1);

  const a = n00 + (n10 - n00) * u;
  const b = n01 + (n11 - n01) * u;
  return a + (b - a) * v;
}

/**
 * Tiling fbm. `period` must be an integer; each octave doubles it so every octave wraps
 * on the same boundary and the sum stays seamless.
 */
function fbmTiled(x: number, y: number, period: number, octaves: number): number {
  let sum = 0;
  let norm = 0;
  let amp = 0.5;
  let freq = 1;
  const n = octaves < 1 ? 1 : octaves > 8 ? 8 : octaves | 0;
  for (let o = 0; o < n; o++) {
    sum += gradNoise(x * freq, y * freq, period * freq) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

/**
 * Public fbm, non-tiling, returned in **0..1 with a mean near 0.5**.
 * `geometry.ts` uses it for the hand-pressed surface jitter; anything wanting a signed
 * value should subtract 0.5.
 */
export function fbm2(x: number, y: number, octaves = 4): number {
  return clamp01(fbmTiled(x, y, 0, octaves) * 0.7 + 0.5);
}

/* ------------------------------------------------------------------ */
/* Normal map                                                          */
/* ------------------------------------------------------------------ */

/**
 * Slope gain applied to the height field before encoding.
 *
 * This is the *baked* slope, and it is not the same knob as a material's `normalScale` — the
 * spec's 0.08–0.15 band constrains the latter, and a material can only dial down what the map
 * gives it. Round 2 measured every clay surface in the product at or under one 8-bit code of
 * micro-grain, which is exactly what you get when a map is baked too flat and then scaled
 * down again.
 *
 * Modelled end to end (`fbm → central difference → normalScale → wrapped diffuse → L*`) on
 * the map `materials.ts` actually asks for, for the p99−p1 spread across a flat lit face:
 *
 * | gain | peak tilt | ΔL\* at `normalScale` 0.12 | at 0.18 (rubber) |
 * |---|---|---|---|
 * | 6  | 41° | 1.25 | 1.88 |
 * | **9** | **52°** | **1.67** | **2.50** |
 * | 12 | 60° | 1.96 | 2.94 |
 *
 * 9 clears the audit's ≥1.5 L\* floor with margin; past it the `1/sqrt(gx²+gy²+1)`
 * normalisation saturates and each extra unit of gain buys less than the last. A 52° peak
 * sounds violent for micro-grain and is not: at `normalScale` 0.12 the surface normal moves
 * by about 6°, which is a fingerprint, not a relief map.
 */
const NORMAL_GAIN = 9;

/**
 * Lattice cells of the **low-frequency mottle** carried in the map's alpha channel.
 *
 * The RGB of this texture is a micro-grain normal, and a normal map is only a shading
 * effect: it can only change a pixel by turning the surface, so it does nothing at all on
 * a face whose normal already parallels the key, and nothing on a flat plateau lit
 * head-on. Five games are mostly exactly those surfaces, and round 3 measured the
 * consequence at 1-3 codes of variation over hundreds of pixels — the rubric's "uniform
 * albedo" rejection.
 *
 * An **albedo** mottle has no such blind spot: it multiplies the surface colour, so it
 * survives every light angle, every normal and every tessellation, including the constant
 * vertex colour `bakeCurvatureAO` is obliged to write on a plane or a sphere. It rides in
 * this map's alpha rather than in a second texture because the alpha byte was already
 * allocated and written as a constant 255, so it costs zero bytes of new VRAM and one
 * extra fetch of an already-resident texel.
 *
 * Four cells rather than the grain's eight, and two octaves rather than three, because it
 * is sampled at `CLAY_MOTTLE_RATE` (see `materials.ts`) — a *magnification* — and its job
 * is to break a plateau into hand-pressed patches, not to add a second grain.
 */
const MOTTLE_CELLS = 4;
const MOTTLE_OCTAVES = 2;

/**
 * Tangent-space micro-grain for clay, plus a low-frequency albedo mottle in alpha.
 *
 * Height comes from tiling fbm, normals from central
 * differences with wrapped neighbours, so the map is genuinely seamless under
 * `RepeatWrapping` rather than merely low-contrast at the edges.
 *
 * **`repeat` is part of the cache key, and it is not cosmetic.** A grain map has exactly one
 * job — put a sub-millimetre perturbation on the surface normal — and it can only do that if
 * the framebuffer samples it at roughly one texel per pixel. Left at the default `repeat` of
 * 1 against `geometry.ts`'s world-space UVs, a 512px map spanned half a world unit, which at
 * the product's design framing (~134 screen px per world unit) is **0.13 px per texel**: an
 * eight-fold minification, so every fragment reads mip 3 or lower and a mip of a normal map
 * converges on flat. That is why the grain measured at or below one 8-bit code across every
 * surface in the round-2 audit — it was there in the texture and gone by the framebuffer.
 * Callers therefore state the world footprint they want and size the map to match it.
 *
 * @param opts.scale number of fbm lattice cells across the texture (the tiling period).
 * @param opts.repeat texture repeat on both axes, folded into the cache key.
 */
export function noiseNormalTexture(opts?: {
  size?: number;
  scale?: number;
  octaves?: number;
  repeat?: number;
}): Texture {
  const size = Math.max(16, Math.round(opts?.size ?? 256));
  const scale = Math.max(1, Math.round(opts?.scale ?? 8));
  const octaves = Math.max(1, Math.round(opts?.octaves ?? 4));
  const repeat = Math.max(0.01, opts?.repeat ?? 1);

  return cached(`normal|${size}|${scale}|${octaves}|${repeat.toFixed(4)}`, () => {
    const height = new Float32Array(size * size);
    const step = scale / size;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        height[y * size + x] = fbmTiled(x * step, y * step, scale, octaves);
      }
    }

    const data = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
      const ym = ((y - 1 + size) % size) * size;
      const yp = ((y + 1) % size) * size;
      const yc = y * size;
      for (let x = 0; x < size; x++) {
        const xm = (x - 1 + size) % size;
        const xp = (x + 1) % size;
        const gx = (height[yc + xp] - height[yc + xm]) * 0.5 * NORMAL_GAIN;
        const gy = (height[yp + x] - height[ym + x]) * 0.5 * NORMAL_GAIN;
        // OpenGL-style tangent normals (green up), matching three's normal map convention.
        const inv = 1 / Math.sqrt(gx * gx + gy * gy + 1);
        const i = (yc + x) * 4;
        data[i] = Math.round((-gx * inv * 0.5 + 0.5) * 255);
        data[i + 1] = Math.round((-gy * inv * 0.5 + 0.5) * 255);
        data[i + 2] = Math.round((inv * 0.5 + 0.5) * 255);
        // Alpha: the low-frequency albedo mottle. Independent lattice count, so it is not
        // a blurred copy of the grain in the RGB above; tiled on the same period, so it is
        // seamless under the same `RepeatWrapping`. Centred on 128 by construction —
        // `fbmTiled` is symmetric about 0 — so `alpha - 0.5` is a signed, zero-mean signal
        // and a material that dials it to zero renders exactly as it did before.
        const mot = fbmTiled(
          (x * MOTTLE_CELLS) / size,
          (y * MOTTLE_CELLS) / size,
          MOTTLE_CELLS,
          MOTTLE_OCTAVES
        );
        data[i + 3] = Math.round(clamp01(mot * 0.5 + 0.5) * 255);
      }
    }

    const tex = new DataTexture(data, size, size, RGBAFormat, UnsignedByteType);
    tex.wrapS = RepeatWrapping;
    tex.wrapT = RepeatWrapping;
    tex.magFilter = LinearFilter;
    tex.minFilter = LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    tex.colorSpace = NoColorSpace;
    tex.repeat.set(repeat, repeat);
    tex.needsUpdate = true;
    return tex;
  });
}

/* ------------------------------------------------------------------ */
/* Contact shadow                                                      */
/* ------------------------------------------------------------------ */

/**
 * Weight of the tight contact lobe in the blob profile, against the wide skirt.
 *
 * The two lobes are the *whole* of `3D-SPEC §2`'s contact rule expressed as a decal: a
 * shadow has to be darkest and tightest exactly where the prop touches, and to spread and
 * thin as it leaves. The previous profile could not express that at all — it held alpha at
 * **1.0 flat** out to 0.47 of the radius and only then ramped, which is a plateau, and
 * round 3 photographed the result: three samples under a tooth's root prongs, between the
 * prongs and 20 px away at the blob's centre all read `164,96,71`, **bit-identical**, with
 * a ~24 px ramp at the rim. A shadow with a plateau in it is a decal.
 */
const BLOB_CORE_WEIGHT = 0.45;
/** Radius of the tight lobe, as a fraction of the quad's half-width. */
const BLOB_CORE_R = 0.45;

/** Wyvill's compact-support falloff: 1 at the centre, 0 value *and* 0 slope at `d = 1`. */
const blobLobe = (d: number): number => {
  if (d >= 1) return 0;
  const k = 1 - d * d;
  return k * k * k;
};

/** The blob profile itself, as a pure function of normalised radius. Strictly decreasing. */
export function contactBlobAlpha(d: number): number {
  if (d <= 0) return 1;
  return clamp01(
    (1 - BLOB_CORE_WEIGHT) * blobLobe(d) + BLOB_CORE_WEIGHT * blobLobe(Math.min(1, d / BLOB_CORE_R))
  );
}

/**
 * The fraction of the quad's half-width the blob is still *visible* over.
 *
 * Derived, not chosen: solved once at module load as the largest `d` whose alpha still
 * moves an 8-bit output byte at the blob's typical strength, so `Rig.tsx::contactRadiusFor`
 * can size a quad from a prop's real footprint instead of from a hand-set multiple. Round 3
 * measured a blob three times the prop's footprint spilling off the receiver and onto the
 * page; that happened because nothing in the product could answer "how big is this blob,
 * actually".
 */
export const CONTACT_BLOB_VISIBLE_FRACTION = (() => {
  // 2/255 against the 0.45-0.86 opacity band `materials.ts::blobMaterial` quantises into:
  // at the band's floor an alpha under this cannot change the receiver by one code.
  const floor = 2 / 255 / 0.45;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 40; i++) {
    const m = (lo + hi) / 2;
    if (contactBlobAlpha(m) > floor) lo = m;
    else hi = m;
  }
  return (lo + hi) / 2;
})();

/**
 * Soft contact blob — a strictly monotonic two-lobe profile, no plateau anywhere.
 *
 * A tight core lobe (`BLOB_CORE_R` of the radius) supplies the near-black pinch at the
 * contact point; a wide lobe running out to the quad's inscribed circle supplies the skirt.
 * Both are Wyvill falloffs, so the sum is smooth, strictly decreasing on `0 < d < 1`, and
 * reaches zero value *and* zero slope at the quad's edge — the blob can never print its own
 * rim. Sampled at the quarter points the profile reads 1.000 / 0.719 / 0.279 / 0.062 / 0.000,
 * i.e. it loses 28 % of its darkness over the first fifth of the radius, which is the
 * gradient the spec asks a contact shadow to have and the old plateau did not.
 *
 * RGB is white so the material can tint it warm; the falloff lives in alpha.
 *
 * @param opts.softness 0..1 — widens the core lobe and thins the pinch.
 */
export function radialShadowTexture(opts?: { size?: number; softness?: number }): Texture {
  const size = Math.max(16, Math.round(opts?.size ?? 128));
  const softness = clamp01(opts?.softness ?? 0.55);

  return cached(`shadow|${size}|${softness.toFixed(3)}`, () => {
    const data = new Uint8Array(size * size * 4);
    // Softness only moves the *core* lobe's width. The skirt always runs to the quad edge,
    // because that is what keeps the profile's support inside its own geometry.
    const coreR = BLOB_CORE_R * (0.72 + 0.56 * softness);
    const coreW = BLOB_CORE_WEIGHT * (1.15 - 0.4 * softness);
    const inv = 2 / size;
    for (let y = 0; y < size; y++) {
      const dy = (y + 0.5) * inv - 1;
      for (let x = 0; x < size; x++) {
        const dx = (x + 0.5) * inv - 1;
        const d = Math.sqrt(dx * dx + dy * dy);
        const a = clamp01((1 - coreW) * blobLobe(d) + coreW * blobLobe(Math.min(1, d / coreR)));
        const i = (y * size + x) * 4;
        data[i] = 255;
        data[i + 1] = 255;
        data[i + 2] = 255;
        data[i + 3] = Math.round(a * 255);
      }
    }
    const tex = new DataTexture(data, size, size, RGBAFormat, UnsignedByteType);
    tex.wrapS = ClampToEdgeWrapping;
    tex.wrapT = ClampToEdgeWrapping;
    tex.magFilter = LinearFilter;
    tex.minFilter = LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    tex.colorSpace = NoColorSpace;
    tex.needsUpdate = true;
    return tex;
  });
}

/* ------------------------------------------------------------------ */
/* Gradient                                                            */
/* ------------------------------------------------------------------ */

/** Parses any CSS colour three understands and returns **sRGB** bytes (not linear). */
function srgbBytes(css: string): [number, number, number] {
  const hex = new Color(css).getHex(SRGBColorSpace);
  return [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];
}

/**
 * A 1-D colour ramp, used for skies, backdrops and gradient-tinted sprites.
 * `stops` are `[position 0..1, css colour]` and are sorted here, so callers may pass them
 * in any order.
 */
export function gradientTexture(
  stops: [number, string][],
  opts?: { size?: number; vertical?: boolean }
): Texture {
  const size = Math.max(4, Math.round(opts?.size ?? 256));
  const vertical = opts?.vertical ?? true;
  const sorted = stops.slice().sort((a, b) => a[0] - b[0]);
  const key = `grad|${size}|${vertical ? "v" : "h"}|${sorted.map((s) => `${s[0].toFixed(3)}:${s[1]}`).join(",")}`;

  return cached(key, () => {
    const parsed = sorted.map((s) => ({ at: clamp01(s[0]), rgb: srgbBytes(s[1]) }));
    if (parsed.length === 0) parsed.push({ at: 0, rgb: [255, 255, 255] });

    // Two texels across the ramp: 1-wide data textures are legal but a few mobile drivers
    // sample them unevenly, and the extra column costs nothing.
    const width = vertical ? 2 : size;
    const heightPx = vertical ? size : 2;
    const data = new Uint8Array(width * heightPx * 4);

    const ramp = new Uint8Array(size * 3);
    let seg = 0;
    for (let i = 0; i < size; i++) {
      const t = size === 1 ? 0 : i / (size - 1);
      while (seg < parsed.length - 2 && t > parsed[seg + 1].at) seg++;
      const a = parsed[seg];
      const b = parsed[Math.min(seg + 1, parsed.length - 1)];
      const span = b.at - a.at;
      const k = span <= 1e-6 ? (t >= b.at ? 1 : 0) : clamp01((t - a.at) / span);
      ramp[i * 3] = Math.round(a.rgb[0] + (b.rgb[0] - a.rgb[0]) * k);
      ramp[i * 3 + 1] = Math.round(a.rgb[1] + (b.rgb[1] - a.rgb[1]) * k);
      ramp[i * 3 + 2] = Math.round(a.rgb[2] + (b.rgb[2] - a.rgb[2]) * k);
    }

    for (let y = 0; y < heightPx; y++) {
      for (let x = 0; x < width; x++) {
        const t = vertical ? y : x;
        const i = (y * width + x) * 4;
        data[i] = ramp[t * 3];
        data[i + 1] = ramp[t * 3 + 1];
        data[i + 2] = ramp[t * 3 + 2];
        data[i + 3] = 255;
      }
    }

    const tex = new DataTexture(data, width, heightPx, RGBAFormat, UnsignedByteType);
    tex.wrapS = ClampToEdgeWrapping;
    tex.wrapT = ClampToEdgeWrapping;
    tex.magFilter = LinearFilter;
    tex.minFilter = LinearFilter;
    tex.generateMipmaps = false;
    tex.colorSpace = SRGBColorSpace;
    tex.needsUpdate = true;
    return tex;
  });
}

/* ------------------------------------------------------------------ */
/* Grain                                                               */
/* ------------------------------------------------------------------ */

/**
 * Fine monochrome tooth, centred on mid-grey so materials can use it as a roughness or
 * sheen modulator without shifting the average. Tileable: the white-noise term hashes
 * wrapped integer coordinates, the fbm term uses the tiling lattice.
 *
 * @param opts.strength 0..1 deviation from mid-grey.
 */
export function grainTexture(opts?: { size?: number; strength?: number }): Texture {
  const size = Math.max(16, Math.round(opts?.size ?? 256));
  const strength = clamp01(opts?.strength ?? 0.5);

  return cached(`grain|${size}|${strength.toFixed(3)}`, () => {
    const data = new Uint8Array(size * size * 4);
    const lattice = 16;
    const step = lattice / size;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        // Two scales: per-texel speckle for the tooth, fbm for the blotchy pressed feel.
        const speckle = hashU(x, y) / 4294967295 - 0.5;
        const blotch = fbmTiled(x * step, y * step, lattice, 3);
        const v = clamp01(0.5 + (speckle * 0.7 + blotch * 0.55) * strength);
        const b = Math.round(v * 255);
        const i = (y * size + x) * 4;
        data[i] = b;
        data[i + 1] = b;
        data[i + 2] = b;
        data[i + 3] = 255;
      }
    }
    const tex = new DataTexture(data, size, size, RGBAFormat, UnsignedByteType);
    tex.wrapS = RepeatWrapping;
    tex.wrapT = RepeatWrapping;
    tex.magFilter = LinearFilter;
    tex.minFilter = LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    tex.colorSpace = NoColorSpace;
    tex.needsUpdate = true;
    return tex;
  });
}

/* ------------------------------------------------------------------ */
/* Sparkle sprite                                                      */
/* ------------------------------------------------------------------ */

/**
 * Warm four-point star for celebration sparkles — a soft core, two tapered spikes and a
 * wide bloom, tinted from the enamel/peach tokens so it belongs to the brand rather than
 * reading as a generic white flare. Premultiplied-friendly: RGB is already faded by the
 * same falloff as alpha, so it composites cleanly additively *and* with normal blending.
 */
export function sparkleTexture(opts?: { size?: number }): Texture {
  const size = Math.max(16, Math.round(opts?.size ?? 128));

  return cached(`sparkle|${size}`, () => {
    const core = srgbBytes(CLAY.enamel);
    const edge = srgbBytes(ACCENTS.peach.soft);
    const data = new Uint8Array(size * size * 4);
    const inv = 2 / size;
    for (let y = 0; y < size; y++) {
      const dy = (y + 0.5) * inv - 1;
      for (let x = 0; x < size; x++) {
        const dx = (x + 0.5) * inv - 1;
        const r2 = dx * dx + dy * dy;
        const taperX = Math.max(0, 1 - Math.abs(dx));
        const taperY = Math.max(0, 1 - Math.abs(dy));
        const hot = Math.exp(-r2 * 42);
        const bloom = Math.exp(-r2 * 4.5) * 0.22;
        const spikeH = Math.exp(-dy * dy * 700) * taperX * taperX * taperX * 0.7;
        const spikeV = Math.exp(-dx * dx * 700) * taperY * taperY * taperY * 0.7;
        const a = clamp01(hot + bloom + spikeH + spikeV);
        // Hot centre keeps the enamel tint; the falling tail drifts warm.
        const warm = clamp01(1 - a);
        const i = (y * size + x) * 4;
        data[i] = Math.round((core[0] + (edge[0] - core[0]) * warm) * a);
        data[i + 1] = Math.round((core[1] + (edge[1] - core[1]) * warm) * a);
        data[i + 2] = Math.round((core[2] + (edge[2] - core[2]) * warm) * a);
        data[i + 3] = Math.round(a * 255);
      }
    }
    const tex = new DataTexture(data, size, size, RGBAFormat, UnsignedByteType);
    tex.wrapS = ClampToEdgeWrapping;
    tex.wrapT = ClampToEdgeWrapping;
    tex.magFilter = LinearFilter;
    tex.minFilter = LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    tex.colorSpace = SRGBColorSpace;
    tex.needsUpdate = true;
    return tex;
  });
}
