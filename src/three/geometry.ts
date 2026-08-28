/**
 * Every prop in the product is built here.
 *
 * Three rules shape this file:
 *
 * 1. **No hard edges.** The spec forbids a 90-degree silhouette corner anywhere, so the
 *    "box" is a real filleted solid, cylinders get rounded rims, and extrusions always
 *    carry a bevel. Fake bevels drawn into a normal map are not allowed.
 * 2. **Every geometry ships a baked curvature-AO colour attribute.** That vertex tint is
 *    the single strongest "hand-pressed clay" tell — crevices go warm-dark, exposed edges
 *    lift slightly — and `materials.ts` multiplies by it unconditionally, so a geometry
 *    without one would render flat-lit and wrong.
 * 3. **Build once, share forever.** Nine games run inside one WebGL context that is never
 *    torn down; everything here is cached by an argument-derived key and `markShared()` so
 *    leaving a game cannot dispose a mesh another game still needs.
 *
 * Everything in this file runs at build time, never inside `useFrame`, so ordinary
 * allocation is fine here. The per-frame zero-allocation rule applies to callers.
 */
import {
  BufferAttribute,
  BufferGeometry,
  CapsuleGeometry,
  Color,
  Euler,
  ExtrudeGeometry,
  IcosahedronGeometry,
  LatheGeometry,
  Matrix3,
  Matrix4,
  Quaternion,
  Shape,
  SplineCurve,
  TorusGeometry,
  Vector2,
  Vector3,
  type Material,
} from "three";
import { mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { markShared, registerSceneCache, tagCacheEntry } from "./dispose";
import { ALBEDO_ATTRIBUTE, clayAccent, clayEnamel, clayIvory, clayPainted } from "./materials";
import { getQuality } from "./quality";
import { fbm2 } from "./textures";
import { CLAY, NEUTRAL } from "./tokens";

/* ------------------------------------------------------------------ */
/* Cache                                                               */
/* ------------------------------------------------------------------ */

const cache = new Map<string, BufferGeometry>();

/**
 * Memoises a geometry under `key`. The result is marked shared, so `disposeObject3D` and
 * `DisposalBag` walk straight past it when a game unmounts.
 */
export function cachedGeometry(key: string, build: () => BufferGeometry): BufferGeometry {
  let geo = cache.get(key);
  if (geo === undefined) {
    geo = markShared(build());
    geo.name = key;
    cache.set(key, geo);
  }
  // Attributes the lookup to whichever scene is live, so a game's private geometry is
  // reclaimed when it leaves and genuinely shared geometry is not. See `dispose.ts`.
  tagCacheEntry("geometry", key);
  return geo;
}

registerSceneCache({
  name: "geometry",
  entries: () => cache.entries(),
  size: () => cache.size,
  evict: (key) => {
    const geo = cache.get(key);
    if (geo === undefined) return;
    geo.dispose();
    cache.delete(key);
  },
});

/** Frees every cached geometry. App teardown and leak tests only. */
export function disposeGeometryCache(): void {
  for (const geo of cache.values()) geo.dispose();
  cache.clear();
}

/* ------------------------------------------------------------------ */
/* Shared constants + small helpers                                    */
/* ------------------------------------------------------------------ */

/** Spec §3: no geometry ships with a 90-degree silhouette corner. */
const MIN_BEVEL = 0.02;

/** Weld/merge tolerance. Two orders of magnitude below the minimum bevel. */
const WELD_EPS = 1e-4;

/**
 * UV projection direction pair. Deliberately affine (a skewed planar projection) rather
 * than triplanar: a triplanar or box-projected map has a hard UV discontinuity wherever
 * the dominant axis flips, which prints a visible smear line across a big clay face, and it
 * costs three texture fetches on a shader `BUDGETS.desktopGpuMsP95` already calls
 * fragment-bound. An affine map is continuous everywhere and costs one.
 *
 * **The pair is the isotropic optimum over the three axis-aligned planes**, which is what
 * round 4's A14 was measuring when it reported the grain "streaks in a single direction
 * across an entire 12-unit maze board (visible as one diagonal streak on every wall)". A
 * planar projection restricted to a plane is a 2x2 linear map, and the thing that prints as
 * a streak is its **condition number** — the ratio of its singular values — not its
 * determinant. The old pair was picked on the determinant alone and left the condition
 * number unbounded:
 *
 *   | axis plane | old determinant | old stretch | new determinant | new stretch |
 *   |---|---|---|---|---|
 *   | x (normal +X) | 0.355 | **2.84** | 0.577 | 1.73 |
 *   | y (normal +Y) | 0.443 | 1.99 | 0.577 | 1.73 |
 *   | z (normal +Z) | 0.710 | 1.97 | 0.577 | 1.73 |
 *
 * A 2.84:1 stretch is exactly a streak: the noise's correlation length is nearly three times longer
 * along one in-plane direction than the other, so a wall carries elongated smears instead of
 * a print.
 *
 * The new pair is `U = (1,-1,0)/sqrt2`, `V = (1,1,-2)/sqrt6` — an orthonormal basis of the
 * plane perpendicular to `(1,1,1)`. `U x V` is then exactly `(1,1,1)/sqrt3`, so all three
 * axis planes get the same determinant (0.577, up 63 % from the old worst) and the same
 * stretch (`sqrt3`, down 39 % from the old worst), and the arithmetic is symmetric under
 * permuting the axes rather than accidental.
 *
 * Any single planar projection has a degenerate family — the planes whose normal is
 * perpendicular to `U x V`. Moving `U x V` onto the body diagonal moves that family off every
 * axis direction, so no face of an axis-aligned box (which is most of this product: boards,
 * trays, walls, card faces, the ground) can land in it. The old pair's degenerate family
 * contained normals like `(0.78, 0, 0.39)` — a wall facing between +X and +Z, which several
 * games ship.
 *
 * Reproduce with `scratchpad/uvbasis.mjs`.
 */
const UV_U = [0.7071068, -0.7071068, 0] as const;
const UV_V = [0.4082483, 0.4082483, -0.8164966] as const;
/** Grain repeats roughly every half world unit (5 cm at product scale). */
const UV_SCALE = 2;

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Quality-driven subdivision. Callers may override per prop. */
const detailOf = (detail?: number) => (detail === undefined ? getQuality().detail : detail);
const pick3 = <T,>(d: number, lo: T, mid: T, hi: T): T => (d <= 1 ? lo : d < 3 ? mid : hi);

/**
 * The floor under every count that decides a **silhouette**, at every tier.
 *
 * Round 4 photographed the low tier and found what a tier table can do to a look when the
 * cheapest entry is allowed to decide an outline rather than a shading rate: a 12-sided
 * turntable with visible facet planes, a stair-stepped tray rim, a lathe reading as a prism.
 * `3D-SPEC §0` ("no hard edge anywhere in this product") and `§3` ("no geometry ships with a
 * 90° silhouette corner") are not tiered statements — a facet plane is a hard edge on any
 * device, and the device that boots the low tier is the *target* device, so it is the one
 * frame that matters most.
 *
 * 24 is derived, not chosen. At design framing (28° lens, ~12 units out, ~134 screen px per
 * world unit) a 1-unit-diameter prop is ~134 px across, so an `n`-gon's facet chord subtends
 * `134 · sin(π/n)` px and its sagitta — the gap between the polygon and the circle it is
 * standing in for, which is what the eye actually reads as a flat spot — is
 * `67 · (1 − cos(π/n))` px:
 *
 *   | n | facet chord | sagitta |
 *   |---|---|---|
 *   | 12 | 34.7 px | 2.28 px  ← what the low tier shipped |
 *   | 16 | 26.1 px | 1.28 px |
 *   | 20 | 21.0 px | 0.82 px |
 *   | **24** | **17.5 px** | **0.57 px** |
 *   | 32 | 13.1 px | 0.32 px |
 *
 * Half a pixel of sagitta is under the antialiasing floor: the outline cannot print a flat
 * spot the resolve does not smear away. 32 would be free too, but 24 is where the curve stops
 * paying — and the whole floor costs a few hundred triangles on a scene measured at 14.7 k
 * against §9's 180 k.
 *
 * Applies to the *resolved* count, so it raises a coarse tier without ever lowering a fine
 * one: `silhouetteSegments` is `max`, never `min`.
 */
const MIN_SILHOUETTE_SEGMENTS = 24;

/** A radial/tubular count that decides an outline. Never below `MIN_SILHOUETTE_SEGMENTS`. */
const silhouetteSegments = (n: number): number =>
  Math.max(MIN_SILHOUETTE_SEGMENTS, Math.round(n));

/**
 * The floor under a *fillet* arc — the quarter-round that turns a rim, a lip or a bevel.
 *
 * A fillet is a silhouette too, but a much shorter one: it spans 90° over a radius of
 * `MIN_BEVEL`..a few hundredths of a unit rather than over a whole prop, so the sagitta
 * arithmetic above lands at 3 segments for the same half-pixel bound at the largest bevel the
 * product ships (0.06 units ≈ 8 px: `4 · (1 − cos(π/6))` = 0.54 px). The low tier shipped 2,
 * which is a 45° facet — the "stair-stepped tray rim" the audit photographed.
 */
const MIN_FILLET_SEGMENTS = 3;

const filletSegments = (n: number): number => Math.max(MIN_FILLET_SEGMENTS, Math.round(n));

/** Key fragment: rounds so 3.0000001 and 3 do not build two copies of the same prop. */
const kf = (n: number) => (Math.round(n * 1000) / 1000).toString();

/* ------------------------------------------------------------------ */
/* Position welding                                                    */
/* ------------------------------------------------------------------ */

type Weld = { map: Int32Array; count: number };

/**
 * Groups vertices that share a position regardless of their other attributes.
 *
 * `mergeVertices` only welds vertices whose *every* attribute matches, so a UV or normal
 * seam leaves duplicated vertices behind. Curvature AO and surface jitter both need the
 * true one-ring across such a seam — otherwise the AO prints a bright line down the seam
 * and jitter tears the mesh open. This gives them seam-blind topology.
 *
 * The key packs three 16-bit quantised coordinates into one float (< 2^48, safely below
 * 2^53), which is several times faster than string keys on a 20k-vertex mesh.
 */
function buildWeld(pos: ArrayLike<number>, count: number): Weld {
  const map = new Int32Array(count);
  const lookup = new Map<number, number>();
  const inv = 1 / WELD_EPS;
  let next = 0;
  for (let i = 0; i < count; i++) {
    const qx = clamp(Math.round(pos[i * 3] * inv), -32000, 32000) + 32768;
    const qy = clamp(Math.round(pos[i * 3 + 1] * inv), -32000, 32000) + 32768;
    const qz = clamp(Math.round(pos[i * 3 + 2] * inv), -32000, 32000) + 32768;
    const key = qx * 4294967296 + qy * 65536 + qz;
    let w = lookup.get(key);
    if (w === undefined) {
      w = next++;
      lookup.set(key, w);
    }
    map[i] = w;
  }
  return { map, count: next };
}

/** Averaged, renormalised normal per welded position — a crack-free displacement basis. */
function weldedNormals(weld: Weld, normals: ArrayLike<number>, vertexCount: number): Float32Array {
  const out = new Float32Array(weld.count * 3);
  for (let i = 0; i < vertexCount; i++) {
    const w = weld.map[i] * 3;
    out[w] += normals[i * 3];
    out[w + 1] += normals[i * 3 + 1];
    out[w + 2] += normals[i * 3 + 2];
  }
  for (let w = 0; w < weld.count; w++) {
    const o = w * 3;
    const len = Math.hypot(out[o], out[o + 1], out[o + 2]);
    if (len > 1e-8) {
      out[o] /= len;
      out[o + 1] /= len;
      out[o + 2] /= len;
    } else {
      out[o + 1] = 1;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Curvature AO — the hero pass                                        */
/* ------------------------------------------------------------------ */

// Token colours read through THREE.Color, so these are already in the linear working
// space the shader multiplies in. Never hand-convert.
const CREVICE_LINEAR = new Color(CLAY.crevice);
const WEAR_LINEAR = new Color(CLAY.wear);
const WEAR_PEAK = Math.max(WEAR_LINEAR.r, WEAR_LINEAR.g, WEAR_LINEAR.b);
/** Deep crease darkens ~45%; going all the way to the crevice colour reads as soot. */
const CREVICE_MIX = 0.55;
/** Exposed edges lift above 1 — a multiplicative tint can only brighten by exceeding it. */
const WEAR_LIFT = 0.1;
/**
 * World-space feature size the AO is tuned to: anything with a radius of curvature at or
 * below this saturates. 0.05 units is 5 mm at product scale — the size of a thumb-pressed
 * bevel, which is exactly the feature the effect exists to draw.
 */
const AO_REFERENCE = 0.05;
const WEAR_R = (WEAR_LINEAR.r / WEAR_PEAK) * WEAR_LIFT;
const WEAR_G = (WEAR_LINEAR.g / WEAR_PEAK) * WEAR_LIFT;
const WEAR_B = (WEAR_LINEAR.b / WEAR_PEAK) * WEAR_LIFT;

/**
 * Writes a per-vertex curvature/occlusion tint into a `color` attribute.
 *
 * For each vertex the one-ring is compared two ways:
 *   - every neighbour offset `d` contributes a normal curvature `2 * (d . N) / |d|^2`,
 *     whose magnitude is 1 / radius-of-curvature and whose sign says which way the surface
 *     bends: positive when neighbours sit *above* the tangent plane (a crease), negative
 *     when the vertex bulges over an exposed edge. Averaging the per-neighbour values
 *     rather than pooling into one centroid-over-mean-edge term matters wherever the
 *     tessellation is anisotropic — on a lathed rim the arc edges are three times shorter
 *     than the circumferential ones, and the pooled form underestimated the rim by 4x,
 *     which erased the edge highlight that sells a clay bevel. It is also independent of
 *     triangle density, so a prop looks the same on every quality tier.
 *   - the divergence between the vertex normal and the mean neighbour normal, which is
 *     unsigned curvature magnitude and sharpens genuine creases over smooth bulges.
 *
 * Adjacency is built once as a CSR array from the index buffer; a 20k-vertex mesh costs
 * well under a millisecond, so this is safe to run inside a lazy game chunk's first frame.
 */
export function bakeCurvatureAO(
  geo: BufferGeometry,
  opts?: { strength?: number; radius?: number }
): BufferGeometry {
  const strength = opts?.strength ?? 1;
  const radius = opts?.radius ?? 1;

  const posAttr = geo.getAttribute("position");
  if (!posAttr || posAttr.itemSize !== 3) return geo;
  if (!geo.getAttribute("normal")) geo.computeVertexNormals();
  const nrmAttr = geo.getAttribute("normal");

  const vertexCount = posAttr.count;
  const px = posAttr.array as ArrayLike<number>;
  const nx = nrmAttr.array as ArrayLike<number>;

  const index = geo.getIndex();
  const ia = index ? (index.array as ArrayLike<number>) : null;
  const triCount = Math.floor((ia ? ia.length : vertexCount) / 3);

  const weld = buildWeld(px, vertexCount);
  const wn = weld.count;

  // Welded positions (identical by construction) and averaged normals.
  const wP = new Float32Array(wn * 3);
  const hits = new Int32Array(wn);
  for (let i = 0; i < vertexCount; i++) {
    const w = weld.map[i] * 3;
    wP[w] += px[i * 3];
    wP[w + 1] += px[i * 3 + 1];
    wP[w + 2] += px[i * 3 + 2];
    hits[weld.map[i]]++;
  }
  for (let w = 0; w < wn; w++) {
    const c = hits[w] || 1;
    wP[w * 3] /= c;
    wP[w * 3 + 1] /= c;
    wP[w * 3 + 2] /= c;
  }
  const wN = weldedNormals(weld, nx, vertexCount);

  // CSR one-ring. Interior edges are visited from both incident triangles; on a closed
  // mesh that double-count is uniform and cancels out of every average below.
  const deg = new Int32Array(wn);
  const bump = (a: number, b: number) => {
    if (a !== b) {
      deg[a]++;
      deg[b]++;
    }
  };
  for (let t = 0; t < triCount; t++) {
    const a = weld.map[ia ? ia[t * 3] : t * 3];
    const b = weld.map[ia ? ia[t * 3 + 1] : t * 3 + 1];
    const c = weld.map[ia ? ia[t * 3 + 2] : t * 3 + 2];
    bump(a, b);
    bump(b, c);
    bump(c, a);
  }
  const start = new Int32Array(wn + 1);
  for (let w = 0; w < wn; w++) start[w + 1] = start[w] + deg[w];
  const adj = new Int32Array(start[wn]);
  const cursor = Int32Array.from(start.subarray(0, wn));
  const link = (a: number, b: number) => {
    if (a !== b) {
      adj[cursor[a]++] = b;
      adj[cursor[b]++] = a;
    }
  };
  for (let t = 0; t < triCount; t++) {
    const a = weld.map[ia ? ia[t * 3] : t * 3];
    const b = weld.map[ia ? ia[t * 3 + 1] : t * 3 + 1];
    const c = weld.map[ia ? ia[t * 3 + 2] : t * 3 + 2];
    link(a, b);
    link(b, c);
    link(c, a);
  }

  const wCol = new Float32Array(wn * 3);
  for (let w = 0; w < wn; w++) {
    const o = w * 3;
    const s = start[w];
    const e = start[w + 1];
    const n = e - s;

    let r = 1;
    let g = 1;
    let b = 1;

    if (n > 0) {
      const pxw = wP[o];
      const pyw = wP[o + 1];
      const pzw = wP[o + 2];
      const nxw = wN[o];
      const nyw = wN[o + 1];
      const nzw = wN[o + 2];

      let curvatureSum = 0;
      let curvatureCount = 0;
      let mx = 0;
      let my = 0;
      let mz = 0;
      for (let k = s; k < e; k++) {
        const j = adj[k] * 3;
        const dx = wP[j] - pxw;
        const dy = wP[j + 1] - pyw;
        const dz = wP[j + 2] - pzw;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > 1e-12) {
          curvatureSum += (2 * (dx * nxw + dy * nyw + dz * nzw)) / d2;
          curvatureCount++;
        }
        mx += wN[j];
        my += wN[j + 1];
        mz += wN[j + 2];
      }

      // Signed mean curvature: +1/R in a crease, -1/R over an exposed edge, 0 on a plane.
      const meanCurvature = curvatureCount > 0 ? curvatureSum / curvatureCount : 0;

      const mLen = Math.hypot(mx, my, mz);
      const divergence = mLen > 1e-8 ? clamp01(1 - (mx * nxw + my * nyw + mz * nzw) / mLen) : 0;
      // Real creases (neighbour normals fanning apart) read a little harder than a smooth
      // bulge of the same curvature.
      const sharpen = 0.85 + 0.5 * divergence;

      const signal = clamp(meanCurvature * AO_REFERENCE * radius, -1, 1);
      const occ = clamp01(signal > 0 ? signal * sharpen : 0);
      const wear = clamp01(signal < 0 ? -signal * sharpen : 0);

      const dark = occ * strength * CREVICE_MIX;
      const lift = wear * strength;
      r = clamp(1 + (CREVICE_LINEAR.r - 1) * dark + WEAR_R * lift, 0, 2);
      g = clamp(1 + (CREVICE_LINEAR.g - 1) * dark + WEAR_G * lift, 0, 2);
      b = clamp(1 + (CREVICE_LINEAR.b - 1) * dark + WEAR_B * lift, 0, 2);
    }

    wCol[o] = r;
    wCol[o + 1] = g;
    wCol[o + 2] = b;
  }

  const colors = new Float32Array(vertexCount * 3);
  for (let i = 0; i < vertexCount; i++) {
    const w = weld.map[i] * 3;
    colors[i * 3] = wCol[w];
    colors[i * 3 + 1] = wCol[w + 1];
    colors[i * 3 + 2] = wCol[w + 2];
  }
  geo.setAttribute("color", new BufferAttribute(colors, 3));
  return geo;
}

/* ------------------------------------------------------------------ */
/* Hand-pressed jitter                                                 */
/* ------------------------------------------------------------------ */

/**
 * Pushes vertices along their normals by low-frequency fbm so a shape reads as pressed by
 * a thumb rather than lathed by a machine. Call it *after* `mergeVertices` — displacing a
 * split-attribute mesh along per-vertex normals opens cracks, which is why the direction
 * comes from the position-welded average normal here.
 *
 * `amount` is a world-unit peak displacement; `frequency` is lumps per world unit.
 */
export function jitterSurface(
  geo: BufferGeometry,
  amount: number,
  frequency: number,
  seed = 0
): BufferGeometry {
  const posAttr = geo.getAttribute("position");
  if (!posAttr || posAttr.itemSize !== 3 || amount === 0) return geo;
  if (!geo.getAttribute("normal")) geo.computeVertexNormals();

  const count = posAttr.count;
  const p = posAttr.array as Float32Array;
  const weld = buildWeld(p, count);
  const dir = weldedNormals(weld, geo.getAttribute("normal").array as ArrayLike<number>, count);

  // Three decorrelated 2D slices stand in for 3D noise: cheaper than a real 3D fbm and,
  // because each slice is a pure function of position, welded vertices always agree.
  const s1 = seed * 13.13 + 4.7;
  const s2 = seed * 7.77 - 2.3;
  const s3 = seed * 21.1 + 9.4;
  const f = frequency;

  for (let i = 0; i < count; i++) {
    const o = i * 3;
    const x = p[o];
    const y = p[o + 1];
    const z = p[o + 2];
    const n =
      (fbm2(x * f + s1, y * f - s1, 3) +
        fbm2(y * f + s2, z * f + s2, 3) +
        fbm2(z * f - s3, x * f + s3, 3)) /
        3 -
      0.5;
    const d = n * 2 * amount;
    const w = weld.map[i] * 3;
    p[o] = x + dir[w] * d;
    p[o + 1] = y + dir[w + 1] * d;
    p[o + 2] = z + dir[w + 2] * d;
  }
  posAttr.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

/* ------------------------------------------------------------------ */
/* Internal finishing pipeline                                         */
/* ------------------------------------------------------------------ */

/** Drops zero-area triangles — lathe poles and cap fans generate them by construction. */
function dropDegenerate(geo: BufferGeometry): void {
  const index = geo.getIndex();
  if (!index) return;
  const ia = index.array as ArrayLike<number>;
  const kept: number[] = [];
  for (let t = 0; t < ia.length; t += 3) {
    const a = ia[t];
    const b = ia[t + 1];
    const c = ia[t + 2];
    if (a !== b && b !== c && c !== a) kept.push(a, b, c);
  }
  if (kept.length !== ia.length) geo.setIndex(kept);
}

/**
 * Flips winding when a closed mesh came out inside-out.
 *
 * The generalised-lathe builders below emit rings in whichever direction reads clearly in
 * the source, and getting that sign wrong silently produces inverted normals that only
 * show up as a black prop at runtime. Signed volume is an objective check, so the builders
 * do not have to be clever. Open meshes have a meaningless signed volume, hence the
 * threshold against bounding-box volume: only a clearly negative solid gets flipped.
 */
function ensureOutward(geo: BufferGeometry): void {
  const index = geo.getIndex();
  const posAttr = geo.getAttribute("position");
  if (!index || !posAttr) return;
  const p = posAttr.array as ArrayLike<number>;
  const ia = index.array as ArrayLike<number>;

  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < posAttr.count; i++) {
    const x = p[i * 3];
    const y = p[i * 3 + 1];
    const z = p[i * 3 + 2];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  const boxVolume = Math.max(1e-9, (maxX - minX) * (maxY - minY) * (maxZ - minZ));

  let volume = 0;
  for (let t = 0; t < ia.length; t += 3) {
    const a = ia[t] * 3;
    const b = ia[t + 1] * 3;
    const c = ia[t + 2] * 3;
    const ax = p[a];
    const ay = p[a + 1];
    const az = p[a + 2];
    const bx = p[b];
    const by = p[b + 1];
    const bz = p[b + 2];
    const cx = p[c];
    const cy = p[c + 1];
    const cz = p[c + 2];
    volume += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  volume /= 6;

  if (volume < -0.02 * boxVolume) {
    const flipped = new Uint32Array(ia.length);
    for (let t = 0; t < ia.length; t += 3) {
      flipped[t] = ia[t];
      flipped[t + 1] = ia[t + 2];
      flipped[t + 2] = ia[t + 1];
    }
    geo.setIndex(new BufferAttribute(flipped, 1));
  }
}

/** Continuous affine UVs — see UV_U/UV_V for why this is not a box projection. */
function applyPlanarUV(geo: BufferGeometry, scale: number): void {
  const posAttr = geo.getAttribute("position");
  if (!posAttr) return;
  const p = posAttr.array as ArrayLike<number>;
  const count = posAttr.count;
  const uv = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    const x = p[i * 3];
    const y = p[i * 3 + 1];
    const z = p[i * 3 + 2];
    uv[i * 2] = (x * UV_U[0] + y * UV_U[1] + z * UV_U[2]) * scale;
    uv[i * 2 + 1] = (x * UV_V[0] + y * UV_V[1] + z * UV_V[2]) * scale;
  }
  geo.setAttribute("uv", new BufferAttribute(uv, 2));
}

type FinishOptions = {
  jitter?: { amount: number; frequency: number; seed?: number };
  ao?: { strength?: number; radius?: number };
  uvScale?: number;
};

/**
 * The contract every exported builder ends with: weld on position only, drop degenerates,
 * fix winding, smooth normals, optional hand-press, UVs, curvature AO, bounds.
 *
 * Attributes are stripped before merging on purpose. `mergeVertices` compares every
 * attribute, so leaving the source UVs on would refuse to weld across a UV seam and
 * `computeVertexNormals` would then crease the model along it. Welding on bare positions
 * guarantees one continuous smooth surface; UVs are regenerated afterwards from position,
 * which cannot reintroduce a seam.
 */
function finish(src: BufferGeometry, options: FinishOptions = {}): BufferGeometry {
  src.deleteAttribute("uv");
  src.deleteAttribute("uv1");
  src.deleteAttribute("uv2");
  src.deleteAttribute("normal");
  src.deleteAttribute("tangent");
  src.deleteAttribute("color");
  src.clearGroups();

  const geo = mergeVertices(src, WELD_EPS);
  if (geo !== src) src.dispose();

  dropDegenerate(geo);
  ensureOutward(geo);
  geo.computeVertexNormals();

  if (options.jitter) {
    jitterSurface(geo, options.jitter.amount, options.jitter.frequency, options.jitter.seed ?? 0);
  }

  applyPlanarUV(geo, options.uvScale ?? UV_SCALE);
  bakeCurvatureAO(geo, options.ao);
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

/* ------------------------------------------------------------------ */
/* Ring / row scaffolding for the generalised lathe builders           */
/* ------------------------------------------------------------------ */

/**
 * Stitches an ordered stack of closed vertex loops into triangles. A row of length 1 is a
 * pole and becomes a fan. All rows except poles must share the same length.
 */
function stitchRows(rows: number[][], index: number[]): void {
  for (let r = 0; r + 1 < rows.length; r++) {
    const a = rows[r];
    const b = rows[r + 1];
    if (a.length === 1 && b.length === 1) continue;
    if (a.length === 1) {
      for (let i = 0; i < b.length; i++) index.push(a[0], b[(i + 1) % b.length], b[i]);
      continue;
    }
    if (b.length === 1) {
      for (let i = 0; i < a.length; i++) index.push(a[i], a[(i + 1) % a.length], b[0]);
      continue;
    }
    for (let i = 0; i < a.length; i++) {
      const j = (i + 1) % a.length;
      index.push(a[i], a[j], b[j]);
      index.push(a[i], b[j], b[i]);
    }
  }
}

/**
 * One sample of a rounded-rectangle outline: an anchor on the core rectangle plus the
 * outward direction. Any offset from the core rectangle is then `anchor + offset * dir`,
 * which stays a valid convex rounded rectangle for every positive offset — that is what
 * lets `clayTray` sweep a whole cross-section profile around a rounded rectangle without
 * any CSG.
 */
type RingSample = { ax: number; az: number; dx: number; dz: number };

function roundedRectRing(A: number, B: number, cornerSegs: number, edgeSegs: number): RingSample[] {
  const anchors: [number, number][] = [
    [A, B],
    [-A, B],
    [-A, -B],
    [A, -B],
  ];
  const out: RingSample[] = [];
  for (let q = 0; q < 4; q++) {
    const [ax, az] = anchors[q];
    for (let i = 0; i < cornerSegs; i++) {
      const a = (q + i / cornerSegs) * (Math.PI / 2);
      out.push({ ax, az, dx: Math.cos(a), dz: Math.sin(a) });
    }
    const a = (q + 1) * (Math.PI / 2);
    const dx = Math.cos(a);
    const dz = Math.sin(a);
    const [nx2, nz2] = anchors[(q + 1) % 4];
    for (let i = 0; i < edgeSegs; i++) {
      const t = i / edgeSegs;
      out.push({ ax: ax + (nx2 - ax) * t, az: az + (nz2 - az) * t, dx, dz });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Rounded box                                                         */
/* ------------------------------------------------------------------ */

/**
 * A genuinely filleted box: every one of the 12 edges is a cylindrical quarter-round and
 * every corner a sphere octant, with exact analytic positions.
 *
 * Each face is a graded grid on the full-size box, then projected onto the true rounded
 * surface by `P = clamp(p, core) + r * normalize(p - clamp(p, core))`. The grading is what
 * makes it work: a uniformly subdivided cube puts no vertex inside a 0.02 fillet on a 1.0
 * box, so the "rounded" edge collapses back to a crease. Here `arc` samples land inside
 * each fillet band at even angular spacing, and adjacent faces meet exactly at 45 degrees
 * on the fillet so `mergeVertices` welds them into one smooth shell.
 */
export function roundedBox(
  w: number,
  h: number,
  d: number,
  radius: number,
  detail?: number
): BufferGeometry {
  const dt = detailOf(detail);
  const key = `rbox|${kf(w)}|${kf(h)}|${kf(d)}|${kf(radius)}|${dt}`;
  return cachedGeometry(key, () => finish(buildRoundedBox(w, h, d, radius, dt)));
}

function buildRoundedBox(w: number, h: number, d: number, radius: number, dt: number): BufferGeometry {
  const half = [Math.max(w, 0.01) / 2, Math.max(h, 0.01) / 2, Math.max(d, 0.01) / 2];
  const smallest = Math.min(half[0], half[1], half[2]);
  const r = clamp(radius, Math.min(MIN_BEVEL, smallest * 0.9), smallest * 0.9);
  const core = [half[0] - r, half[1] - r, half[2] - r];

  // The fillet band is the box's silhouette wherever the box is not seen face-on, so it
  // takes the fillet floor: at 2 the quarter-round was three 30° facets and every "rounded"
  // box in the product printed a visible crease line down its edges on the low tier.
  const arcSegs = filletSegments(pick3(dt, 2, 3, 4));
  const flatSegs = pick3(dt, 1, 2, 3);

  const axisSamples = (axis: number): number[] => {
    const c = core[axis];
    const out: number[] = [];
    for (let i = arcSegs; i >= 1; i--) out.push(-c - r * Math.tan((i / arcSegs) * (Math.PI / 4)));
    out.push(-c);
    for (let i = 1; i < flatSegs; i++) out.push(-c + 2 * c * (i / flatSegs));
    out.push(c);
    for (let i = 1; i <= arcSegs; i++) out.push(c + r * Math.tan((i / arcSegs) * (Math.PI / 4)));
    return out;
  };
  const samples = [axisSamples(0), axisSamples(1), axisSamples(2)];

  // fixed axis, sign, then the two tangent axes ordered so tangentU x tangentV = outward.
  const faces: [number, number, number, number][] = [
    [0, 1, 1, 2],
    [0, -1, 2, 1],
    [1, 1, 2, 0],
    [1, -1, 0, 2],
    [2, 1, 0, 1],
    [2, -1, 1, 0],
  ];

  const positions: number[] = [];
  const index: number[] = [];
  const p = [0, 0, 0];

  for (const [fixed, sign, uAxis, vAxis] of faces) {
    const us = samples[uAxis];
    const vs = samples[vAxis];
    const base = positions.length / 3;
    for (let i = 0; i < us.length; i++) {
      for (let j = 0; j < vs.length; j++) {
        p[fixed] = sign * half[fixed];
        p[uAxis] = us[i];
        p[vAxis] = vs[j];
        const qx = clamp(p[0], -core[0], core[0]);
        const qy = clamp(p[1], -core[1], core[1]);
        const qz = clamp(p[2], -core[2], core[2]);
        let ox = p[0] - qx;
        let oy = p[1] - qy;
        let oz = p[2] - qz;
        const len = Math.hypot(ox, oy, oz) || 1;
        ox /= len;
        oy /= len;
        oz /= len;
        positions.push(qx + ox * r, qy + oy * r, qz + oz * r);
      }
    }
    const stride = vs.length;
    for (let i = 0; i + 1 < us.length; i++) {
      for (let j = 0; j + 1 < vs.length; j++) {
        const a = base + i * stride + j;
        const b = base + (i + 1) * stride + j;
        const c = base + (i + 1) * stride + j + 1;
        const e = base + i * stride + j + 1;
        index.push(a, b, c, a, c, e);
      }
    }
  }

  const geo = new BufferGeometry();
  geo.setAttribute("position", new BufferAttribute(new Float32Array(positions), 3));
  geo.setIndex(index);
  return geo;
}

/* ------------------------------------------------------------------ */
/* Extrusions                                                          */
/* ------------------------------------------------------------------ */

/** Stable cache key for a Shape, sampled densely enough to separate real variants. */
function shapeKey(shape: Shape): string {
  let h = 2166136261;
  const acc = (v: number) => {
    h = Math.imul(h ^ (Math.round(v * 4096) | 0), 16777619);
  };
  for (const pt of shape.getPoints(16)) {
    acc(pt.x);
    acc(pt.y);
  }
  acc(shape.holes.length);
  for (const hole of shape.holes) {
    for (const pt of hole.getPoints(16)) {
      acc(pt.x);
      acc(pt.y);
    }
  }
  return (h >>> 0).toString(36);
}

/**
 * A rounded rectangle as an explicit, **duplicate-free** point list.
 *
 * It was four `absarc` calls joined by `lineTo`, which is the obvious way to write it and
 * shipped a visible spike. `CurvePath.getPoints` drops a point only when it is *bit*-equal
 * to the previous one, and an arc's endpoint computed as `cx + r cos(theta)` misses the
 * `lineTo` literal it meets by about 1e-11 — so every line/arc junction survived as a pair
 * of coincident points. `ExtrudeGeometry::getBevelVec` then saw a zero-length incoming edge
 * at those vertices, fell into its collinear branch, and emitted a miter of length
 * `sqrt(2) x bevelSize` instead of `bevelSize`.
 *
 * Measured, on `roundedPlate(1, 1.5, 0.185, 0.15)`: three duplicate points in the contour,
 * and a bounding box of `y in [-0.7768, 0.7500]` against a documented `+-0.7500` — the low
 * edge pushed out by **0.0268, which is exactly `(sqrt(2) - 1) x bevel`**. That is a hard
 * point on the bottom rim of every non-square plate in the product, including the memory
 * cards, and it is the other half of what round 3 photographed as "a razor-straight dark
 * seam with an ivory sliver across the bottom of every face-up card".
 *
 * Sampling the four corner arcs directly and handing the result to `Shape` as points makes
 * every edge a real `LineCurve` between two distinct vertices, so the miter is always the
 * genuine one and the outer dimensions come out at exactly `w x h`. `arcSegments` matches
 * what `ExtrudeGeometry` used to produce for these arcs — `curveSegments x 2`, because an
 * `ArcCurve` is an `EllipseCurve` and `CurvePath.getPoints` doubles their resolution — so
 * the vertex count is unchanged bar the three duplicates.
 */
function roundedRectShape(w: number, h: number, r: number, arcSegments: number): Shape {
  const x = w / 2;
  const y = h / 2;
  const rr = clamp(r, 0.0005, Math.min(x, y) - 0.0005);
  const n = Math.max(2, Math.round(arcSegments));
  const pts: Vector2[] = [];
  // Counter-clockwise from the bottom-right corner: [centre x, centre y, start angle].
  const corners: readonly (readonly [number, number, number])[] = [
    [x - rr, -y + rr, -Math.PI / 2],
    [x - rr, y - rr, 0],
    [-x + rr, y - rr, Math.PI / 2],
    [-x + rr, -y + rr, Math.PI],
  ];
  for (const [cx, cy, a0] of corners) {
    for (let i = 0; i <= n; i++) {
      const a = a0 + (i / n) * (Math.PI / 2);
      pts.push(new Vector2(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr));
    }
  }
  return new Shape(pts);
}

/** Arc resolution `roundedRectShape` needs to match what `curveSegments` used to give it. */
const rectArcSegments = (dt: number) => pick3(dt, 6, 10, 16) * 2;

function extrudeSlab(shape: Shape, depth: number, bevel: number, steps: number, dt: number): BufferGeometry {
  const geo = new ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelOffset: 0,
    // The extrusion's bevel is the slab's silhouette edge — a card's, a tile's, a sign's —
    // so it takes the fillet floor rather than the tier's cheapest entry.
    bevelSegments: filletSegments(pick3(dt, 2, 3, 5)),
    curveSegments: pick3(dt, 6, 10, 16),
    steps,
  });
  // ExtrudeGeometry spans z from -bevel to depth + bevel; centre it so callers can place
  // the slab by its middle instead of guessing at the bevel.
  geo.translate(0, 0, -depth / 2);
  return geo;
}

/**
 * Extrudes a caller-supplied shape with a bevel on both faces, centred on z = 0.
 *
 * Note the bevel grows the silhouette outward by `bevel` (three's `bevelSize`) and the
 * total depth is `depth + 2 * bevel`. Material groups are cleared: everything in this
 * product draws with one clay material per prop to stay inside the draw-call budget.
 */
/** The bevel may take at most this fraction of an extrusion's depth. */
const EXTRUDE_BEVEL_FRACTION = 0.9;
/** Thinnest extrusion that can carry `MIN_BEVEL`. See `MIN_PLATE_THICKNESS` for the argument. */
const MIN_EXTRUDE_DEPTH = MIN_BEVEL / EXTRUDE_BEVEL_FRACTION;

export function beveledExtrude(
  shape: Shape,
  opts: { depth: number; bevel: number; steps?: number }
): BufferGeometry {
  const dt = getQuality().detail;
  // Same contradiction, same resolution as `roundedPlate` — see `MIN_PLATE_THICKNESS`. The
  // floor was `MIN_BEVEL * 0.5`, i.e. half of §3's hard minimum, which meant a thin enough
  // extrusion shipped a 0.01 roll and said nothing. No caller in the product is under
  // `MIN_EXTRUDE_DEPTH` today (the thinnest is Smile Maker's cape hem at 0.045 asking for
  // exactly 0.02), so this closes the hole rather than changing any prop.
  const depth = Math.max(opts.depth, MIN_EXTRUDE_DEPTH);
  if (import.meta.env.DEV && opts.depth < MIN_EXTRUDE_DEPTH) {
    console.error(
      `[lumident/geometry] beveledExtrude depth ${opts.depth} cannot carry the ${MIN_BEVEL}-unit ` +
        `minimum bevel 3D-SPEC §3 requires; raised to ${MIN_EXTRUDE_DEPTH.toFixed(4)}. Fix the caller.`
    );
  }
  const bevel = clamp(opts.bevel, MIN_BEVEL, depth * EXTRUDE_BEVEL_FRACTION);
  const steps = Math.max(1, Math.round(opts.steps ?? 1));
  const key = `bextrude|${shapeKey(shape)}|${kf(depth)}|${kf(bevel)}|${steps}|${dt}`;
  return cachedGeometry(key, () => finish(extrudeSlab(shape, depth, bevel, steps, dt)));
}

/**
 * The bevel may take at most this fraction of a plate's thickness, per face.
 *
 * Above ~0.45 the two rim rolls meet in the middle and the plate becomes a lens with no
 * flat face left to catch the key — which is why the cap exists at all.
 */
const PLATE_BEVEL_FRACTION = 0.45;

/**
 * The thinnest plate that can carry `MIN_BEVEL` on both faces, derived from the cap above:
 * `MIN_BEVEL / PLATE_BEVEL_FRACTION` = 0.0444 units.
 *
 * Below it the two constraints are contradictory, and the old code resolved the
 * contradiction silently in favour of the *cap*:
 *
 * ```ts
 * const bevel = Math.min(Math.max(MIN_BEVEL, ...), t * 0.45);   // <- t * 0.45 wins
 * ```
 *
 * so a caller asking for a thinner plate got a bevel under the spec's floor with no warning.
 * Tooth Match's `INLAY_T = 0.036` resolved to **0.0162** against `3D-SPEC §3`'s hard 0.02,
 * and it shipped as a razor-straight dark seam across the bottom of every face-up card — a
 * visible hard edge on the surface a child looks at longest, in the most-used geometry
 * builder in the product.
 *
 * A geometry builder cannot honour both, so it now resolves the contradiction in favour of
 * the *spec* and says so: the thickness is clamped up, and dev gets an error naming the
 * caller's number so the caller can be fixed rather than the floor quietly lowered.
 */
const MIN_PLATE_THICKNESS = MIN_BEVEL / PLATE_BEVEL_FRACTION;

/**
 * A card / tile / lid: a rounded rectangle with real thickness and a bevelled rim, lying
 * in the XY plane with `thickness` along Z and centred on the origin.
 *
 * Outer dimensions come out at exactly `w x h x thickness` — the shape is pre-shrunk by
 * the bevel so the bevel does not inflate it — **except** for a `thickness` under
 * `MIN_PLATE_THICKNESS`, which is raised to it. See that constant.
 */
export function roundedPlate(
  w: number,
  h: number,
  thickness: number,
  cornerRadius: number,
  detail?: number
): BufferGeometry {
  const dt = detailOf(detail);
  const t = Math.max(thickness, MIN_PLATE_THICKNESS);
  if (import.meta.env.DEV && thickness < MIN_PLATE_THICKNESS) {
    console.error(
      `[lumident/geometry] roundedPlate(${w}, ${h}, ${thickness}, ${cornerRadius}): a plate ` +
        `${thickness} thick cannot carry the ${MIN_BEVEL}-unit minimum bevel 3D-SPEC §3 ` +
        `requires (the bevel may take at most ${PLATE_BEVEL_FRACTION} of the thickness per ` +
        `face). Thickness raised to ${MIN_PLATE_THICKNESS.toFixed(4)}. Fix the caller: pass ` +
        `a thickness of at least ${MIN_PLATE_THICKNESS.toFixed(4)}, or use a builder that is ` +
        `meant to be thin.`
    );
  }
  // Keyed on the *clamped* thickness, so two callers asking for different sub-minimum
  // thicknesses share one geometry instead of building two identical ones.
  const key = `plate|${kf(w)}|${kf(h)}|${kf(t)}|${kf(cornerRadius)}|${dt}`;
  return cachedGeometry(key, () => {
    const corner = clamp(cornerRadius, MIN_BEVEL, Math.min(w, h) * 0.48);
    // With `t >= MIN_PLATE_THICKNESS` the cap can no longer undercut the floor, so this is
    // now a real clamp into [MIN_BEVEL, t * PLATE_BEVEL_FRACTION] rather than a silent
    // override of the first term by the second.
    const bevel = clamp(
      Math.min(t * 0.35, corner * 0.55),
      MIN_BEVEL,
      t * PLATE_BEVEL_FRACTION
    );
    const shape = roundedRectShape(w - 2 * bevel, h - 2 * bevel, corner - bevel, rectArcSegments(dt));
    return finish(extrudeSlab(shape, t - 2 * bevel, bevel, 1, dt));
  });
}

/**
 * A bevelled chip, hand-built at 6x-per-`sides` triangles instead of the ~644 an
 * `ExtrudeGeometry` costs.
 *
 * `roundedPlate` is the right tool for a card a child looks at from 30 cm; it is the wrong
 * tool for a celebration confetti flake that covers about twelve screen pixels. Round 2
 * measured that exact mistake: 260 chips x 644 triangles, submitted twice with `castShadow`
 * on, was 334,880 triangles of the 338,178 the celebration added — on its own nearly double
 * the whole 180k scene budget.
 *
 * The bevel stays, because `3D-SPEC §3` has no exemption for small props and a chip with a
 * 90-degree rim reads as a paper cutout. It is just built for the size it renders at: three
 * closed rings (front face inset by `bevel`, the full-size silhouette at mid-depth, back face
 * inset again) plus a fan cap on each face. At `sides = 8` that is exactly **48 triangles**
 * and 26 vertices, and `finish()`'s smooth normals carry the rim as a rounded roll rather
 * than as two creases.
 *
 * Lies in the XY plane, `thickness` along Z, centred on the origin — same convention as
 * `roundedPlate`, so it is a drop-in for anything small enough to want it.
 */
export function bevelChip(
  w: number,
  h: number,
  thickness: number,
  bevel: number,
  sides = 8
): BufferGeometry {
  const n = Math.max(4, Math.round(sides));
  const key = `chip|${kf(w)}|${kf(h)}|${kf(thickness)}|${kf(bevel)}|${n}`;
  return cachedGeometry(key, () => finish(buildBevelChip(w, h, thickness, bevel, n)));
}

/**
 * A confetti flake: `bevelChip`'s solid with a smooth lobed outline instead of a rounded
 * rectangle.
 *
 * The celebration's chips were rounded octagons stretched by a per-instance aspect of up to
 * 3:1, and round 3 read the result as "a dense spray of small elongated capsule-shaped
 * chips" — spatter rather than confetti. Two things fix that and this is one of them (the
 * other is the scale composition in `celebrate.tsx`): a five-lobed outline breaks the
 * silhouette, so a flake reads as a petal or a star rather than as a sliver however it
 * tumbles.
 *
 * The lobes are a **cosine** modulation of the radius, not alternating long and short
 * corners. That matters for `3D-SPEC §3`: a real star has sharp in-plane points, which are
 * hard silhouette corners the spec has no exemption for. `r(a) * (1 + depth * cos(lobes*a))`
 * is smooth everywhere, and at 12 screen pixels it reads as a star anyway.
 *
 * @param lobes how many points. 5 reads as a star, 6 as a flower, 3 as a petal.
 * @param depth lobe amplitude as a fraction of the radius. Past ~0.3 the waist gets thin
 *              enough that the bevel eats it.
 */
export function flakeChip(
  w: number,
  h: number,
  thickness: number,
  bevel: number,
  lobes = 5,
  depth = 0.18,
  segments = 16
): BufferGeometry {
  const n = Math.max(8, Math.round(segments));
  const lb = Math.max(0, Math.round(lobes));
  const dp = clamp(depth, 0, 0.3);
  const key = `flake|${kf(w)}|${kf(h)}|${kf(thickness)}|${kf(bevel)}|${lb}|${kf(dp)}|${n}`;
  return cachedGeometry(key, () => finish(buildBevelChip(w, h, thickness, bevel, n, lb, dp)));
}

function buildBevelChip(
  w: number,
  h: number,
  thickness: number,
  bevel: number,
  n: number,
  lobes = 0,
  lobeDepth = 0
): BufferGeometry {
  const hw = Math.max(w, 0.004) / 2;
  const hh = Math.max(h, 0.004) / 2;
  const t = Math.max(thickness, 0.002);
  // The bevel may not eat the face, and may not exceed half the thickness or the two rims
  // would meet and the chip would be a lens with no flat face to catch the key.
  const b = clamp(bevel, 0.0006, Math.min(t * 0.45, Math.min(hw, hh) * 0.45));

  const positions: number[] = [];
  const index: number[] = [];
  const rows: number[][] = [];

  // A superellipse outline: at n = 8 it is a rounded octagon, which is what a clay flake
  // looks like at this size, and it never produces the parallel-sided rectangle whose
  // corners would be the hard edges the spec forbids.
  const ring = (sx: number, sy: number, z: number) => {
    const row: number[] = [];
    for (let i = 0; i < n; i++) {
      const a = ((i + 0.5) / n) * Math.PI * 2;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      let k = 1 / Math.pow(Math.pow(Math.abs(ca), 4) + Math.pow(Math.abs(sa), 4), 0.25);
      // Smooth lobes. Normalised by `1 + lobeDepth` so the outline still fits exactly inside
      // `w x h` — a flake must not grow when it gains points, or every caller's framing moves.
      if (lobes > 0 && lobeDepth > 0) {
        k *= (1 + lobeDepth * Math.cos(lobes * a)) / (1 + lobeDepth);
      }
      row.push(positions.length / 3);
      positions.push(ca * k * sx, sa * k * sy, z);
    }
    rows.push(row);
  };
  const pole = (z: number) => {
    rows.push([positions.length / 3]);
    positions.push(0, 0, z);
  };

  pole(-t / 2);
  ring(hw - b, hh - b, -t / 2);
  ring(hw, hh, 0);
  ring(hw - b, hh - b, t / 2);
  pole(t / 2);

  stitchRows(rows, index);

  const geo = new BufferGeometry();
  geo.setAttribute("position", new BufferAttribute(new Float32Array(positions), 3));
  geo.setIndex(index);
  return geo;
}

/* ------------------------------------------------------------------ */
/* Lathes                                                              */
/* ------------------------------------------------------------------ */

function latheFrom(points: [number, number][], segments: number, smooth: boolean): BufferGeometry {
  let pts = points.map(([x, y]) => new Vector2(Math.max(0, x), y));
  if (smooth && pts.length > 2) {
    // Resampling through a spline is what "smooth" buys: the caller can describe a profile
    // with a handful of control points and still get a curve with no visible facets.
    pts = new SplineCurve(pts).getPoints(Math.max(pts.length * 6, 24));
    for (const p of pts) if (p.x < 0) p.x = 0;
  }
  return new LatheGeometry(pts, segments);
}

/**
 * Surface of revolution from a 2D profile (`[radius, height]` pairs, bottom to top).
 * Points at radius 0 cap the pole; the degenerate fan triangles they produce are removed
 * by the finishing pass, so a profile may start and end on the axis without penalty.
 */
export function latheProfile(
  points: [number, number][],
  segments?: number,
  smooth = true
): BufferGeometry {
  const dt = getQuality().detail;
  // A lathe *is* a silhouette: this count is the outline, not a shading rate.
  //
  // The tier-chosen count takes the full floor — round 4 photographed the 12 the low tier
  // handed out as a faceted turntable and a milk bottle reading as a hexagonal prism, and
  // both were on the default path. An *explicit* count is an art decision about a prop whose
  // on-screen size the caller knows (a 0.15-unit candy is 20 px across, where a 14-gon's
  // sagitta is 0.25 px and already invisible), so it only takes the hard floor that keeps §3's
  // "no 90° silhouette corner" true — a 12-gon's interior angle is 150°.
  const segs =
    segments === undefined
      ? silhouetteSegments(pick3(dt, 12, 20, 32))
      : Math.max(12, Math.round(segments));
  const key = `lathe|${points.map(([x, y]) => `${kf(x)},${kf(y)}`).join(";")}|${segs}|${smooth ? 1 : 0}`;
  return cachedGeometry(key, () => finish(latheFrom(points, segs, smooth)));
}

/** Cylinder with a rounded rim top and bottom — a puck, a button, a plate of food. */
export function roundedCylinder(
  radius: number,
  height: number,
  edge: number,
  detail?: number
): BufferGeometry {
  const dt = detailOf(detail);
  const key = `rcyl|${kf(radius)}|${kf(height)}|${kf(edge)}|${dt}`;
  return cachedGeometry(key, () => {
    const rad = Math.max(radius, 0.01);
    const hh = Math.max(height, 0.02) / 2;
    const e = clamp(edge, Math.min(MIN_BEVEL, Math.min(rad, hh) * 0.9), Math.min(rad, hh) * 0.9);
    // The rolled rim is this prop's silhouette in profile — the "stair-stepped tray rim" the
    // low-tier capture photographed was this at 2, i.e. two 45° facets across a quarter-round.
    const arcSegs = filletSegments(pick3(dt, 2, 3, 5));

    const profile: [number, number][] = [[0, -hh]];
    for (let i = 0; i <= arcSegs; i++) {
      const a = -Math.PI / 2 + (i / arcSegs) * (Math.PI / 2);
      profile.push([rad - e + Math.cos(a) * e, -hh + e + Math.sin(a) * e]);
    }
    for (let i = 0; i <= arcSegs; i++) {
      const a = (i / arcSegs) * (Math.PI / 2);
      profile.push([rad - e + Math.cos(a) * e, hh - e + Math.sin(a) * e]);
    }
    profile.push([0, hh]);

    return finish(latheFrom(profile, silhouetteSegments(pick3(dt, 14, 22, 36)), false));
  });
}

/* ------------------------------------------------------------------ */
/* Primitives                                                          */
/* ------------------------------------------------------------------ */

/**
 * Icosphere rather than a UV sphere: uniform triangles, no pinched poles and no UV seam
 * to crease during the weld.
 */
export function softSphere(radius: number, detail?: number): BufferGeometry {
  const dt = detailOf(detail);
  const key = `sphere|${kf(radius)}|${dt}`;
  return cachedGeometry(key, () =>
    // 320 / 500 / 980 triangles — see TOOTH_SUBDIV on how three counts icosphere detail.
    finish(new IcosahedronGeometry(Math.max(radius, 0.005), pick3(dt, 3, 4, 6)))
  );
}

/** Capsule along Y. `length` is the straight section between the two hemispherical caps. */
export function softCapsule(radius: number, length: number, detail?: number): BufferGeometry {
  const dt = detailOf(detail);
  const key = `capsule|${kf(radius)}|${kf(length)}|${dt}`;
  return cachedGeometry(key, () =>
    finish(
      new CapsuleGeometry(
        Math.max(radius, 0.005),
        Math.max(length, 0.001),
        // cap rings (a fillet: the hemispherical end) and radial segments (the outline).
        filletSegments(pick3(dt, 3, 5, 8)),
        silhouetteSegments(pick3(dt, 10, 16, 24))
      )
    )
  );
}

/** Torus with a fat tube — rings, handles, the halo under a celebrating tooth. */
export function torusSoft(radius: number, tube: number, detail?: number): BufferGeometry {
  const dt = detailOf(detail);
  const key = `torus|${kf(radius)}|${kf(tube)}|${dt}`;
  return cachedGeometry(key, () =>
    finish(
      new TorusGeometry(
        Math.max(radius, 0.01),
        clamp(tube, 0.005, Math.max(radius, 0.01) * 0.95),
        // Both counts are outline: the tube's cross-section is the silhouette where the ring
        // turns toward the camera, and the tubular count is the ring itself. The tube is the
        // smaller circle of the two, so it takes the fillet floor doubled rather than the
        // full one — a `radialSegments` of 8 printed an octagonal cross-section on every
        // halo and handle in the product at the low tier.
        Math.max(12, pick3(dt, 8, 12, 18)),
        silhouetteSegments(pick3(dt, 16, 26, 40))
      )
    )
  );
}

/* ------------------------------------------------------------------ */
/* Clay tray                                                           */
/* ------------------------------------------------------------------ */

/**
 * The Sliding Puzzle tray, and the generic "things sit in this" prop: rounded outer
 * corners, a raised rim rolled over at the top, an inner well and a fillet where the well
 * wall meets its floor.
 *
 * Built as a generalised lathe — one cross-section profile swept around a rounded
 * rectangle instead of around an axis — so it is a single watertight geometry with no CSG
 * and no boolean seams. Both flat caps are closed by scaling the ring toward the centre,
 * which is safe because the rounded rectangle is convex and contains the origin.
 *
 * @param w outer width (X), @param d outer depth (Z), @param h outer height (Y),
 * @param rim wall thickness. Origin sits at the centre of the underside, y = 0.
 */
export function clayTray(
  w: number,
  d: number,
  h: number,
  rim: number,
  detail?: number
): BufferGeometry {
  const dt = detailOf(detail);
  const key = `tray|${kf(w)}|${kf(d)}|${kf(h)}|${kf(rim)}|${dt}`;
  return cachedGeometry(key, () =>
    finish(buildClayTray(w, d, h, rim, dt), {
      jitter: { amount: Math.min(h, Math.min(w, d)) * 0.004, frequency: 2.4, seed: 3 },
      // The well fillet scales with the rim, so it lands well above the 0.05 default
      // feature size; widening the AO radius to match is what keeps the well reading as a
      // well rather than as a faint smudge.
      ao: { radius: 1.4 },
    })
  );
}

function buildClayTray(w: number, d: number, h: number, rim: number, dt: number): BufferGeometry {
  const width = Math.max(w, 0.05);
  const depth = Math.max(d, 0.05);
  const height = Math.max(h, 0.03);
  const halfMin = Math.min(width, depth) * 0.5;

  const wall = clamp(rim, MIN_BEVEL, halfMin * 0.45);
  const topRoll = Math.min(wall * 0.45, height * 0.22);
  const baseRoll = Math.min(wall * 0.35, height * 0.2);
  const innerTop = height - topRoll;
  const floorTop = Math.min(Math.max(height * 0.3, baseRoll + 0.01), innerTop - 0.03);
  const fillet = Math.max(0.006, Math.min(wall * 0.6, (innerTop - floorTop) * 0.4));
  // The ring offset must stay positive all the way to the innermost profile point, so the
  // outer corner radius is never allowed below the total inward reach of the cross-section.
  const corner = Math.min(Math.max(halfMin * 0.28, (wall + fillet) * 1.2), halfMin * 0.92);

  const A = width / 2 - corner;
  const B = depth / 2 - corner;

  // Cross-section in (inward distance from the outer silhouette, height).
  const profile: [number, number][] = [];
  // Every arc in this cross-section is a rolled lip or a fillet, i.e. the tray's silhouette
  // in profile — the low tier's 2 turned each of them into two 45° facets.
  const arcSegs = filletSegments(pick3(dt, 2, 3, 4));
  const push = (din: number, y: number) => {
    const last = profile[profile.length - 1];
    if (!last || Math.abs(last[0] - din) > 1e-6 || Math.abs(last[1] - y) > 1e-6) profile.push([din, y]);
  };
  const arc = (cx: number, cy: number, r: number, a0: number, a1: number) => {
    for (let i = 0; i <= arcSegs; i++) {
      const a = a0 + (a1 - a0) * (i / arcSegs);
      push(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    }
  };
  const line = (x0: number, y0: number, x1: number, y1: number, segs: number) => {
    for (let i = 0; i <= segs; i++) push(x0 + (x1 - x0) * (i / segs), y0 + (y1 - y0) * (i / segs));
  };

  const wallSegs = pick3(dt, 1, 2, 3);
  arc(baseRoll, baseRoll, baseRoll, -Math.PI / 2, Math.PI); // underside edge -> outer wall
  line(0, baseRoll, 0, innerTop, wallSegs); // outer wall
  arc(topRoll, innerTop, topRoll, Math.PI, Math.PI / 2); // rolled outer lip
  line(topRoll, height, wall - topRoll, height, 1); // rim top
  arc(wall - topRoll, innerTop, topRoll, Math.PI / 2, 0); // rolled inner lip
  line(wall, innerTop, wall, floorTop + fillet, wallSegs); // well wall
  arc(wall + fillet, floorTop + fillet, fillet, Math.PI, Math.PI * 1.5); // well fillet

  // `cornerSegs` is the tray's outline in plan — the rounded corner a child looks straight
  // down at — so it takes the fillet floor; `edgeSegs` only subdivides a straight run.
  const ring = roundedRectRing(A, B, filletSegments(pick3(dt, 3, 4, 6)), pick3(dt, 2, 3, 5));
  const capRings = pick3(dt, 2, 3, 4);

  const positions: number[] = [];
  const index: number[] = [];
  const rows: number[][] = [];

  const addPole = (y: number) => {
    const i = positions.length / 3;
    positions.push(0, y, 0);
    rows.push([i]);
  };
  const addRing = (din: number, y: number, shrink: number) => {
    const off = corner - din;
    const row: number[] = [];
    for (const s of ring) {
      row.push(positions.length / 3);
      positions.push((s.ax + off * s.dx) * shrink, y, (s.az + off * s.dz) * shrink);
    }
    rows.push(row);
  };

  // Underside: centre pole outward to the first profile ring.
  addPole(0);
  for (let i = 1; i < capRings; i++) addRing(profile[0][0], 0, i / capRings);
  // The swept cross-section.
  for (const [din, y] of profile) addRing(din, y, 1);
  // Well floor: last profile ring inward to a centre pole.
  const floorY = profile[profile.length - 1][1];
  const floorDin = profile[profile.length - 1][0];
  for (let i = capRings - 1; i >= 1; i--) addRing(floorDin, floorY, i / capRings);
  addPole(floorY);

  stitchRows(rows, index);

  const geo = new BufferGeometry();
  geo.setAttribute("position", new BufferAttribute(new Float32Array(positions), 3));
  geo.setIndex(index);
  return geo;
}

/* ------------------------------------------------------------------ */
/* The mascot                                                          */
/* ------------------------------------------------------------------ */

type Ball = readonly [number, number, number, number, number]; // x, y, z, radius, strength

/** Compact-support blob kernel; the sum of these is what gets iso-surfaced. */
const ISO = 0.45;

function metaField(balls: readonly Ball[], x: number, y: number, z: number): number {
  let f = 0;
  for (let i = 0; i < balls.length; i++) {
    const b = balls[i];
    const dx = x - b[0];
    const dy = y - b[1];
    const dz = z - b[2];
    const q = (dx * dx + dy * dy + dz * dz) / (b[3] * b[3]);
    if (q < 1) {
      const k = 1 - q;
      f += b[4] * k * k;
    }
  }
  return f;
}

/**
 * Distance from `origin` along `dir` to the **outermost** iso-crossing.
 *
 * Taking the outermost crossing rather than bisecting blindly matters: the crown dimple
 * makes the field non-monotonic along a few rays, and a plain bisection would sometimes
 * land on an inner crossing and punch a spike into the mesh. Marching outward and keeping
 * the last inside-to-outside transition always returns the silhouette, and a feature too
 * thin to be caught by the march is simply skipped rather than turned into a spike.
 */
function surfaceRadius(
  balls: readonly Ball[],
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  maxR: number,
  march: number,
  bisect: number
): number {
  let lo = 0;
  let hi = maxR / march;
  let prevInside = true;
  for (let i = 1; i <= march; i++) {
    const t = (i / march) * maxR;
    const inside = metaField(balls, ox + dx * t, oy + dy * t, oz + dz * t) >= ISO;
    if (prevInside && !inside) {
      lo = ((i - 1) / march) * maxR;
      hi = t;
    }
    prevInside = inside;
  }
  for (let k = 0; k < bisect; k++) {
    const m = (lo + hi) / 2;
    if (metaField(balls, ox + dx * m, oy + dy * m, oz + dz * m) >= ISO) lo = m;
    else hi = m;
  }
  return (lo + hi) / 2;
}

export type ToothKind = "molar" | "incisor" | "baby";

/**
 * Ball layouts, tuned numerically against cross-sections rather than eyeballed. Metaballs
 * are used instead of a lathe plus welded root capsules precisely because the spec demands
 * no visible seam where the roots meet the crown: the blend produces a real fillet at the
 * neck for free, and the whole tooth comes out as one continuous surface.
 */
const TOOTH_BALLS: Record<ToothKind, readonly Ball[]> = {
  baby: [
    // Crown: widest just above the neck, gently domed.
    [0.0, 0.835, 0.0, 0.558, 1.0],
    [-0.105, 0.82, 0.0, 0.47, 0.85],
    [0.108, 0.822, 0.0, 0.465, 0.85],
    [0.0, 0.815, -0.095, 0.43, 0.75],
    [0.0, 0.812, 0.098, 0.43, 0.75],
    // Neck: pinches the crown into the roots.
    [0.0, 0.56, 0.0, 0.25, 0.9],
    // Two short stubby roots. The right one is a touch shorter and nudged in Z — the
    // asymmetry is what stops the mascot reading as machined.
    [-0.13, 0.44, 0.0, 0.175, 1.0],
    [-0.145, 0.3, 0.0, 0.158, 1.0],
    [-0.16, 0.165, 0.0, 0.14, 1.0],
    [-0.172, 0.06, 0.0, 0.115, 1.0],
    [0.14, 0.43, -0.006, 0.168, 1.0],
    [0.156, 0.295, -0.006, 0.15, 1.0],
    [0.17, 0.17, -0.006, 0.132, 1.0],
    [0.181, 0.078, -0.006, 0.108, 1.0],
    // Soft dimple in the crown top: tight radius so it dents the middle instead of
    // flattening the whole dome. Measured depth ~4% of total height.
    [0.012, 1.135, 0.0, 0.255, -1.45],
  ],
  molar: [
    [0.0, 0.76, 0.0, 0.6, 1.0],
    [-0.15, 0.745, 0.0, 0.5, 0.85],
    [0.152, 0.748, 0.0, 0.498, 0.85],
    [0.0, 0.742, -0.14, 0.48, 0.82],
    [0.0, 0.74, 0.142, 0.48, 0.82],
    // Four cusps around a central fissure.
    [-0.175, 0.965, -0.17, 0.3, 0.62],
    [0.178, 0.96, -0.168, 0.298, 0.62],
    [-0.172, 0.958, 0.174, 0.298, 0.62],
    [0.18, 0.962, 0.172, 0.296, 0.62],
    [0.0, 1.03, 0.0, 0.3, -1.1],
    [0.0, 0.5, 0.0, 0.29, 0.9],
    // Three splayed roots.
    [-0.185, 0.38, -0.075, 0.185, 1.0],
    [-0.215, 0.235, -0.09, 0.16, 1.0],
    [-0.238, 0.095, -0.1, 0.125, 1.0],
    [0.19, 0.375, -0.072, 0.182, 1.0],
    [0.22, 0.23, -0.088, 0.158, 1.0],
    [0.243, 0.09, -0.098, 0.122, 1.0],
    [0.005, 0.375, 0.19, 0.18, 1.0],
    [0.005, 0.23, 0.222, 0.156, 1.0],
    [0.005, 0.092, 0.246, 0.12, 1.0],
  ],
  incisor: [
    [0.0, 0.88, 0.0, 0.52, 1.0],
    [-0.135, 0.87, 0.0, 0.43, 0.9],
    [0.137, 0.872, 0.0, 0.428, 0.9],
    [-0.15, 1.045, 0.0, 0.3, 0.55],
    [0.152, 1.048, 0.0, 0.298, 0.55],
    [0.0, 1.055, 0.0, 0.31, 0.55],
    // Negative pads front and back keep the chisel thin without flattening the edges.
    [0.0, 0.9, -0.3, 0.3, -0.45],
    [0.0, 0.9, 0.3, 0.3, -0.45],
    [0.0, 0.575, 0.0, 0.25, 0.92],
    // A single conical root.
    [-0.005, 0.45, 0.004, 0.21, 1.0],
    [-0.01, 0.31, 0.006, 0.185, 1.0],
    [-0.016, 0.17, 0.008, 0.155, 1.0],
    [-0.022, 0.055, 0.01, 0.12, 1.0],
  ],
};

/** Ray origin per variant: inside the crown, above the root junction. */
const TOOTH_ORIGIN: Record<ToothKind, readonly [number, number, number]> = {
  baby: [0, 0.62, 0],
  molar: [0, 0.6, 0],
  incisor: [0, 0.66, 0],
};

/**
 * Icosphere subdivision by quality detail 1..4 — 980 / 980 / 1620 / 2880 triangles.
 * Note three's `IcosahedronGeometry` detail is `20 * (detail + 1)^2` faces, not a
 * quadrupling per level, so these numbers look higher than they cost.
 *
 * **The first entry is 6, not 4, and it is pinned rather than tiered.** This is the mascot's
 * body — the shape a child reads a face off — and the iso-surface is sampled *on* the
 * icosphere's vertices, so the subdivision is simultaneously the silhouette resolution and
 * the resolution of the dimple, the neck pinch and the root fillets. At 4 the low tier
 * photographed a crown whose facet planes cut across the mouth: round 4's
 * `count-the-teeth-tier-low.png` shows the mouth ball clipped by two facets into a straight
 * downturned dash — the mascot frowning, on the one device `3D-SPEC §1.4` names as the
 * target. A face is the last thing a tier table may spend.
 *
 * The cost of pinning it is 480 triangles per cached tooth geometry (500 → 980), shared
 * across every caller of that kind and detail. Count the Teeth is the heaviest user at
 * fourteen instanced teeth: +6.7 k triangles against §9's 180 k ceiling, on a scene the
 * round-4 capture measured at 14.7 k.
 */
const TOOTH_SUBDIV = [6, 6, 8, 11] as const;

/**
 * The mascot: a friendly clay tooth, normalised to **exactly 1.0 world unit tall with its
 * origin at the base of the roots** so every game can place and scale it identically.
 *
 * Sampled as a radial iso-surface over an icosphere: uniform triangles, no pole pinch, no
 * UV seam and — unlike marching cubes — no staircase artefacts and no unbounded vertex
 * count. `detail` overrides the quality tier (1..4); pass 4 for Smile Maker's hero tooth.
 */
export function toothGeometry(kind: ToothKind = "baby", detail?: number): BufferGeometry {
  const dt = detailOf(detail);
  const key = `tooth|${kind}|${dt}`;
  return cachedGeometry(key, () =>
    finish(buildTooth(kind, dt), {
      // Enough press to catch the light, far too little to disturb the silhouette.
      jitter: { amount: 0.006, frequency: 3.2, seed: kind === "molar" ? 5 : kind === "incisor" ? 11 : 2 },
      ao: { strength: 1.15 },
    })
  );
}

function buildTooth(kind: ToothKind, dt: number): BufferGeometry {
  const balls = TOOTH_BALLS[kind];
  const [ox, oy, oz] = TOOTH_ORIGIN[kind];
  const subdiv = TOOTH_SUBDIV[clamp(Math.round(dt), 1, 4) - 1];

  const sphere = new IcosahedronGeometry(1, subdiv);
  const dirs = sphere.getAttribute("position").array as ArrayLike<number>;
  const count = sphere.getAttribute("position").count;
  const out = new Float32Array(count * 3);

  // IcosahedronGeometry is non-indexed, so every direction appears about six times.
  // Solving each ray once and reusing the answer cuts the build from 16 ms to ~3 ms at
  // hero detail — worth it, because this runs on a game chunk's first frame.
  const dirWeld = buildWeld(dirs, count);
  const solved = new Float32Array(dirWeld.count);
  const done = new Uint8Array(dirWeld.count);

  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;

  for (let i = 0; i < count; i++) {
    const o = i * 3;
    const len = Math.hypot(dirs[o], dirs[o + 1], dirs[o + 2]) || 1;
    const dx = dirs[o] / len;
    const dy = dirs[o + 1] / len;
    const dz = dirs[o + 2] / len;
    const slot = dirWeld.map[i];
    if (done[slot] === 0) {
      // 48 march steps put the sample spacing at 0.035 — well under the thinnest root
      // chord — and 16 bisections resolve far past what float32 positions can hold.
      solved[slot] = surfaceRadius(balls, ox, oy, oz, dx, dy, dz, 1.7, 48, 16);
      done[slot] = 1;
    }
    const r = solved[slot];
    const x = ox + dx * r;
    const y = oy + dy * r;
    const z = oz + dz * r;
    out[o] = x;
    out[o + 1] = y;
    out[o + 2] = z;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  sphere.dispose();

  const scale = 1 / Math.max(maxY - minY, 1e-6);
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  for (let i = 0; i < count; i++) {
    const o = i * 3;
    out[o] = (out[o] - cx) * scale;
    out[o + 1] = (out[o + 1] - minY) * scale;
    out[o + 2] = (out[o + 2] - cz) * scale;
  }

  const geo = new BufferGeometry();
  geo.setAttribute("position", new BufferAttribute(out, 3));
  return geo;
}

/**
 * `buildTooth`'s normalisation for `TOOTH_BALLS.baby`, as constants.
 *
 * The builder measures the raw iso-surface's bounding box and maps it to "1.0 unit tall,
 * origin at the base of the roots, centred in x and z". Every anchor on `MASCOT_FACE` is
 * expressed in *that* space, so anything that wants to ask the crown a question — "where is
 * your front surface under this point" — has to go back the other way. These four numbers are
 * that map, measured once rather than recomputed at runtime (the measurement walks every
 * vertex of a subdiv-8 icosphere through a 48-step march, which is ~150 ms).
 *
 * Reproduce with `scratchpad/crown.mjs`, which runs the same `metaField`/`surfaceRadius` this
 * file builds the body with. The subdiv-8 and subdiv-11 normalisations differ by 0.85 %, which
 * on the mouth's `z ≈ 0.36` is 0.003 units — an order under the depth the mouth is pressed in
 * by, which is why one table serves every tier.
 */
const BABY_NORM = { scale: 0.88053, cx: -0.00006, cz: 0.0005, minY: 0.00652 } as const;

/**
 * The crown's front surface (max z) at a point on the face, in the tooth's own normalised
 * space. Exact — it marches the same field the mesh is sampled from — and build-time only.
 *
 * Verified against the `MASCOT_SURFACE` table this file already carried: `crownFrontZ(0, 0.7)`
 * returns 0.3581 against the table's 0.3581, and `crownFrontZ(0, 0.875)` returns 0.3183.
 */
function crownFrontZ(xn: number, yn: number): number {
  const x = xn / BABY_NORM.scale + BABY_NORM.cx;
  const y = yn / BABY_NORM.scale + BABY_NORM.minY;
  // `surfaceRadius` marches outward from a point it assumes is inside the solid. On the
  // body axis at the mouth's height that holds for every |x| the face can reach, but a
  // caller off the end of the crown would get an undefined answer rather than an error, so
  // it is checked rather than assumed.
  if (metaField(TOOTH_BALLS.baby, x, y, BABY_NORM.cz) < ISO) return 0;
  return surfaceRadius(TOOTH_BALLS.baby, x, y, BABY_NORM.cz, 0, 0, 1, 1.2, 48, 20) * BABY_NORM.scale;
}

/* ------------------------------------------------------------------ */
/* The mascot, assembled                                               */
/* ------------------------------------------------------------------ */

/**
 * Face and limb anchors, in units of the tooth's own height, measured against
 * `toothGeometry("baby")`'s normalised surface rather than eyeballed.
 *
 * The face numbers are the ones Healthy or Not? already ships (`healthy-or-not/layout.ts`),
 * which is the only face in the product that was art-directed; they are promoted here
 * verbatim so every tooth in the product wears the *same* face rather than a new
 * approximation per game. Each was re-checked against a numeric cross-section of the
 * metaball surface, so every feature sits a few millimetres proud of the body it is pressed
 * onto and none of them sinks inside it:
 *
 * Re-derived for round 3 by marching the *same* `metaField` / `surfaceRadius` this file
 * builds the body with (48 march steps, 16 bisections) through the normalisation
 * `buildTooth` applies, so these are the surface the mesh actually has rather than a
 * remembered one:
 *
 * | anchor | surface z there | feature front z at k = 1 | proud by |
 * |---|---|---|---|
 * | eye `(0.150, 0.875)`   | 0.2837 | 0.3150 | 0.0313 (grows with k, by design) |
 * | cheek `(0.235, 0.790)` | 0.2675 | 0.2700 | 0.0025 |
 * | mouth `(0.000, 0.700)` | 0.3581 | 0.3600 | 0.0019 |
 * | tongue `(0.000, 0.668)`| 0.3547 | 0.3750 | 0.0203 |
 *
 * `arm` and `foot` are new, and they are the point of the whole exercise. A bare
 * `toothGeometry("baby")` is a crown plus two splayed roots: anatomically that is an
 * *extracted* tooth, which is the last thing a paediatric dental product should present as a
 * reward or as a character. Two little feet at the root tips and two arms off the crown's
 * flanks turn the same silhouette into somebody standing up. The foot pads sit at
 * `y = 0.04 ± 0.04`, so their underside is exactly the tooth's own origin plane and a mascot
 * placed at ground level stands on its feet and not through them.
 *
 * **The clearances above are only valid at `featureScale = 1`, and that was the bug.** See
 * `MASCOT_SILHOUETTE` and `pressIn` below for the two rules that make them hold at every
 * scale, and for what shipped while they did not.
 */
export const MASCOT_FACE = {
  eye: { x: 0.15, y: 0.875, z: 0.247, r: 0.068 },
  glint: { dx: -0.022, dy: 0.024, dz: 0.05, r: 0.021 },
  cheek: { x: 0.235, y: 0.79, z: 0.235, w: 0.085, h: 0.06, d: 0.035 },
  /**
   * The smile. `y` is the arc's *mid-height*, not its lowest point; `w` its half-width;
   * `d` its half-depth into the clay; `shut`/`open` the half-thickness of the stroke at the
   * centre at `open = 0` and `open = 1`. See `mouthArcGeometry` for `curve`, and for why
   * this stopped being a scaled ball.
   */
  mouth: { y: 0.7, z: 0.305, w: 0.155, d: 0.055, shut: 0.026, open: 0.1, curve: 0.5 },
  tongue: { y: 0.668, z: 0.345, w: 0.085, h: 0.042, d: 0.03 },
  arm: { x: 0.345, y: 0.62, z: 0.03, r: 0.05, len: 0.16, tilt: 0.9 },
  foot: { x: 0.155, y: 0.04, z: 0.035, w: 0.105, h: 0.04, d: 0.125 },
} as const;

/**
 * The crown's silhouette half-width in x, at each face anchor's own height — i.e. the
 * outline a camera in front of the mascot sees, `max` over z, in units of the tooth's
 * height.
 *
 * Measured the same way as the surface-z table above: `surfaceRadius` marched along +x from
 * the body axis through `buildTooth`'s normalisation, 48 steps and 16 bisections on the
 * shipped `TOOTH_BALLS.baby`. Reproduce with the script in
 * `scratchpad/verify/tooth.mjs`; the subdiv-8 and subdiv-11 normalisations differ by 0.85 %,
 * which is two orders below the headroom these numbers are used with.
 *
 * They exist because a feature that reaches past this line is drawn over the cream page with
 * nothing behind it, which is what round 3 photographed on Tooth Rescue's `featureScale: 1.6`
 * cheeks.
 */
/**
 * The crown's surface depth under each face anchor, in units of the tooth's height —
 * the middle column of the table on `MASCOT_FACE`, as constants rather than as prose.
 * Same derivation: `surfaceRadius` marched along +z from the anchor through `buildTooth`'s
 * normalisation, 48 steps and 16 bisections on `TOOTH_BALLS.baby`.
 */
const MASCOT_SURFACE = {
  eye: 0.2837,
  cheek: 0.2675,
  mouth: 0.3581,
} as const;

/**
 * The smallest fraction of an eye's radius that may stand proud of the crown.
 *
 * `featureScale` is documented as a boost, but nothing stopped a caller passing a value
 * *below* 1, and the eye is anchored 0.0367 H **inside** the surface it is pressed into —
 * so at `k = 0.54` its front pole reaches exactly the crown and below that the pupil
 * disappears into the head entirely. At `k = 0.5` it sits 0.0027 H under the surface: a
 * blank face. No caller in the product is under 1 today (Tooth Match 1.15, Tooth Runner
 * 1.18, Count the Teeth 1.3, Tooth Rescue 1.6, Maze Escape 1.62), so this closes a hole
 * rather than changing a prop — but "a mascot with no eyes" is not a failure mode this
 * product may reach by passing a number.
 */
const EYE_CAP_MIN = 0.25;

const MASCOT_SILHOUETTE = {
  /** half-width in x at `eye.y = 0.875` */
  eyeX: 0.3293,
  /** half-width in x at `cheek.y = 0.790` */
  cheekX: 0.3615,
  /** half-width in x at `mouth.y = 0.700` */
  mouthX: 0.3681,
  /** highest y at `x = eye.x = 0.150` */
  eyeTopY: 0.989,
  /** highest y at `x = cheek.x = 0.235` */
  cheekTopY: 0.981,
  /** highest y on the centre line — off-axis in z, because the crown carries a dimple */
  mouthTopY: 0.993,
} as const;

/**
 * Ceiling on `featureScale`, derived rather than chosen.
 *
 * Two of the three face features grow *along* the body rather than off it, so their lateral
 * anchor is left alone (see `pressIn` for the ones that do not) and the only thing keeping
 * them inside the outline is how big they are allowed to get. Every clearance against the
 * silhouette table above contributes a limit — "this feature's outer edge reaches the
 * outline" — and the ceiling is the smallest of them:
 *
 *   | feature | axis | limit |
 *   |---|---|---|
 *   | eye   | x | `(0.3293 - 0.150) / 0.068` | 2.64 |
 *   | mouth | x | `0.3681 / 0.155`           | 2.37 |
 *   | cheek | y | `(0.9810 - 0.790) / 0.060` | 3.18 |
 *   | mouth | y | `(0.9930 - 0.700) / 0.100` | 2.93 |
 *   | **eye** | **y** | `(0.9890 - 0.875) / 0.068` | **1.68  <- binding** |
 *
 * The eye is the tightest because it is the highest feature on the face and the crown is
 * already curving away above it: at `k = 1` its top pole sits 0.046 H below the outline, and
 * that margin is 0.68 of its own radius. Past this an eye breaks the head's outline
 * vertically — the same failure the cheeks were producing sideways, and just as unpleasant.
 * Its `y` anchor is not pressed in for the same reason its `x` is not: sliding the eyes down
 * the face as they grow walks them into the mouth (at `k = 2` a pressed eye's lower pole
 * lands at y = 0.671 against a mouth anchored at 0.700).
 *
 * Every `featureScale` the product ships is under it — Count the Teeth 1.3, Tooth Rescue 1.6
 * — so this clamps a future caller rather than a current one, which is the point of stating
 * it as a number the geometry produced instead of as a comment.
 */
/**
 * Floor on `featureScale`: the smallest k whose eye still shows `EYE_CAP_MIN` of its own
 * radius above the crown. `(0.2837 - 0.247) / (0.068 x 0.75)` = **0.72**.
 */
const MASCOT_FEATURE_SCALE_MIN =
  (MASCOT_SURFACE.eye - MASCOT_FACE.eye.z) / (MASCOT_FACE.eye.r * (1 - EYE_CAP_MIN));

const MASCOT_FEATURE_SCALE_MAX = Math.min(
  (MASCOT_SILHOUETTE.eyeX - MASCOT_FACE.eye.x) / MASCOT_FACE.eye.r,
  MASCOT_SILHOUETTE.mouthX / MASCOT_FACE.mouth.w,
  (MASCOT_SILHOUETTE.eyeTopY - MASCOT_FACE.eye.y) / MASCOT_FACE.eye.r,
  (MASCOT_SILHOUETTE.cheekTopY - MASCOT_FACE.cheek.y) / MASCOT_FACE.cheek.h,
  (MASCOT_SILHOUETTE.mouthTopY - MASCOT_FACE.mouth.y) / MASCOT_FACE.mouth.open
);

/**
 * How a face feature grows.
 *
 * Every feature is a lens of clay pressed into the crown, anchored so that its outward face
 * stands a fraction of a millimetre proud of the surface underneath it (the table above).
 * `featureScale` multiplies the *radii*, and a lens scaled about its own centre grows in
 * both directions — so half of every increase went **outward, off the body**, and every
 * clearance in that table stopped being true the moment `k != 1`. Measured, as shipped:
 *
 *  - Tooth Rescue at `k = 1.6`: the mouth's front face stood 0.0349 H proud of a surface it
 *    is anchored 0.0019 H off — an eighteen-fold overshoot, which reads as a lozenge stuck
 *    on rather than a mouth pressed in. The cheek's outer edge reached
 *    `0.235 + 0.085 x 1.6 = 0.371` against a silhouette half-width of 0.3615 at its own
 *    height, so a twentieth of the cheek hung over the page with no head behind it.
 *  - Count the Teeth at `k = 1.3`: see `mascotParts`' glint block — a separate arithmetic
 *    error, same root cause (an offset that had to scale and did not).
 *
 * The rule is one line and it applies on every axis that points out of the body: **the
 * feature's outer extreme stays where it was at `k = 1`, and the extra size goes inward,
 * into the clay.** A cheek twice the size is a cheek pressed twice as deep, not a ball
 * balanced on the surface — which is also what it physically is.
 */
const pressIn = (anchor: number, half: number, k: number): number => anchor - half * (k - 1);

/* ------------------------------------------------------------------ */
/* The smile                                                           */
/* ------------------------------------------------------------------ */

/**
 * Samples along the smile. Odd, so one ring lands exactly on the centre line and the two
 * halves are mirror images rather than a half-step apart.
 */
const MOUTH_ARC_RINGS = 17;
/** Samples around the stroke's cross-section. 12 is 30° per facet on a ~10 px tube. */
const MOUTH_TUBE_SEGS = 12;
/**
 * Taper exponent on `(1 - u²)`. Below 0.5 the stroke stays full through the middle and still
 * closes with a *blunt* rounded tip rather than a point — the taper's slope at the end is
 * infinite, so the surface turns over instead of coming to a corner. §0 forbids a hard edge
 * on a 3 px feature exactly as much as on a 300 px one.
 */
const MOUTH_TIP_POWER = 0.42;
/** How far the stroke's front face stands proud of the crown it is pressed into. */
const MOUTH_PROUD = 0.002;
/**
 * How far the tongue stands proud of the crown. Larger than `MOUTH_PROUD` by exactly enough
 * that it is always in front of the stroke and never sorted into it, and small enough that
 * the whole open mouth stays inside the 0.006-unit "pressed into the clay" band the rest of
 * the face holds.
 */
const TONGUE_PROUD = 0.005;
/** Clearance the smile's corners keep under the eyes above them, in tooth heights. */
const MOUTH_EYE_GAP = 0.012;

/** The solved shape of one smile, in the tooth's own normalised space. */
type MouthSolve = {
  /** Corner lift above the arc's mid-height. Always > 0: the mascot always smiles. */
  rise: number;
  /** Half-thickness of the stroke at the centre, after the fit below. */
  thick: number;
  /** Y of the arc's mid-height — the aim point, and where `open` grows from. */
  midY: number;
  /** Front face z at the centre line, i.e. where a tongue has to sit to be seen. */
  frontZ: number;
  /** How much of the wanted size the face had room for. 1 = unconstrained. */
  fit: number;
};

const mouthU = (i: number) => -1 + (2 * i) / (MOUTH_ARC_RINGS - 1);
const mouthTaper = (u: number) => Math.pow(Math.max(0, 1 - u * u), MOUTH_TIP_POWER);

/**
 * Fits a smile under the eyes.
 *
 * The mouth wants a corner lift of `curve × halfWidth` and a half-thickness of `thickWant`.
 * What it may have is bounded by the eye above it: at every sample along the arc, the top of
 * the stroke — `rise · (u² − ½) + thick · taper(u)` above `MASCOT_FACE.mouth.y` — has to stay
 * `MOUTH_EYE_GAP` clear of the eye disc `(x − eye.x)² + (y − eye.y)² = (r · k)²`. The binding
 * clearance is *not* under the eye's lowest point: the arc passes beneath the eye's rim, where
 * the disc's underside is much higher, so the constraint is evaluated per sample against the
 * real circle.
 *
 * When it does not fit, **both** terms are scaled by one factor rather than the lift being
 * given up. Round 4's whole finding was a mascot that could not smile; a solve that answers a
 * crowded face by flattening the arc first would reintroduce exactly that at the two
 * `featureScale` values (1.60, 1.62) where the audit photographed the failure. Scaling both
 * keeps the smile's *shape* — the ratio of lift to stroke — identical at every scale, and
 * makes a big-featured face wear a slightly smaller mouth instead of a straight one.
 *
 * Measured on the shipped anchors: `fit` is 1.00 up to `featureScale` 1.30 at `open` 0.5, and
 * bottoms out at 0.50 at 1.62 / `open` 1.0 — where the mouth is still 0.16 of the tooth's
 * height tall and the corners still lift 0.062 above its middle.
 */
function solveMouth(halfW: number, thickWant: number, curve: number, eyeR: number): MouthSolve {
  const F = MASCOT_FACE;
  const riseWant = curve * halfW;
  let fit = 1;
  for (let i = 0; i < MOUTH_ARC_RINGS; i++) {
    const u = mouthU(i);
    const reach = riseWant * (u * u - 0.5) + thickWant * mouthTaper(u);
    if (reach <= 0) continue;
    const dx = Math.abs(Math.abs(halfW * u) - F.eye.x);
    if (dx >= eyeR) continue;
    const headroom = F.eye.y - Math.sqrt(eyeR * eyeR - dx * dx) - MOUTH_EYE_GAP - F.mouth.y;
    const limit = headroom / reach;
    if (limit < fit) fit = limit;
  }
  // A face so crowded that the mouth would vanish is a worse answer than a small mouth that
  // still reads; the floor is the smallest smile whose stroke is still ~1 px at the smallest
  // prop in the product (Maze Escape's 30 px hero: 0.2 x 0.026 x 30 = 0.16 px is not it).
  if (!(fit > 0.35)) fit = 0.35;
  if (fit > 1) fit = 1;
  const rise = riseWant * fit;
  return {
    rise,
    thick: thickWant * fit,
    // `y(u) = mouth.y + rise·(u² − ½)` runs from `mouth.y − rise/2` at the centre to
    // `mouth.y + rise/2` at the corners, so the arc's mid-height is `mouth.y` exactly —
    // which is the point of the `− ½`: the aim point every game's ballistics already use
    // does not move when the corners lift.
    midY: MASCOT_FACE.mouth.y,
    frontZ: crownFrontZ(0, MASCOT_FACE.mouth.y - rise * 0.5) + MOUTH_PROUD,
    fit,
  };
}

/**
 * The mascot's mouth: a tapered stroke swept along an upward-curving arc that **lies on the
 * crown's own surface**.
 *
 * It replaces a `softSphere` scaled `[w, thickness, d]` — a flat horizontal ellipsoid with
 * zero curvature and a fixed z. Round 4's finding was that the product's shared character
 * physically could not smile, and at the two largest `featureScale` values the product ships
 * (Tooth Rescue 1.60, Maze Escape 1.62) the result was two large dark eyes over a dead
 * straight bar — a skull, in a paediatric dental product whose whole premise is that a child
 * walks into the chair feeling good about teeth. Two things were wrong and both are fixed
 * here:
 *
 *  - **No curvature.** The centre line is now `y(u) = y0 + rise · (u² − ½)` over
 *    `u ∈ [−1, 1]`, so the corners sit `rise` **above** the middle at every `open` value —
 *    including `open = 0`, where the stroke collapses to a thin curved line and reads as a
 *    closed smile instead of a lipless slot. The arc is pivoted about its own mid-height
 *    (hence the `− ½`) so lifting the corners does not also raise the whole mouth into the
 *    eyes, and the aim point every game's ballistics use (`MASCOT_FACE.mouth.y`) stays where
 *    it was.
 *  - **Fixed z on a curved head.** The crown's front surface falls away fast across the face
 *    — measured on the shipped iso-surface at `y = 0.70`: `z = 0.3581` on the centre line,
 *    0.3275 at `x = 0.15`, 0.2643 at `x = 0.25` — so a flat ellipsoid at a single z had its
 *    corners standing further and further off the head as `featureScale` grew. Every ring
 *    now sits at `crownFrontZ(x, y) − depth + MOUTH_PROUD`, i.e. the stroke is pressed into
 *    the clay along its whole length and stands a fixed 0.002 proud of whatever is under it.
 *
 * `rise` is derived, not dialled. It wants to be `curve × halfWidth`, and it is allowed that
 * unless a corner would come within `MOUTH_EYE_GAP` of the eye disc above it — checked per
 * ring against the *actual* circle `mascotParts` draws, `(x − eye.x)² + (y − eye.y)² = (r·k)²`,
 * because the binding clearance is not under the eye's lowest point but wherever the arc
 * passes beneath its rim. At `k = 1` nothing binds and the corners lift `0.078` (an 18° tangent
 * at the tip); at `k = 1.62` the eye has grown to `r = 0.110` and the clamp holds the lift to
 * what still clears it.
 *
 * Build-time only, cached by the shape it produces. About 400 triangles.
 *
 * @param halfW    half-width `w · k`
 * @param thick    half-thickness of the stroke at its centre
 * @param depth    half-depth into the clay
 * @param eyeR     the eye's radius at this `featureScale`, for the clearance solve
 */
function mouthArcGeometry(
  halfW: number,
  thick: number,
  depth: number,
  curve: number,
  eyeR: number
): BufferGeometry {
  const F = MASCOT_FACE;
  const key =
    `mouth|${kf(halfW)}|${kf(thick)}|${kf(depth)}|${kf(curve)}|${kf(eyeR)}|` +
    `${MOUTH_ARC_RINGS}|${MOUTH_TUBE_SEGS}`;
  return cachedGeometry(key, () => {
    const uAt = mouthU;
    const taperAt = mouthTaper;
    const solved = solveMouth(halfW, thick, curve, eyeR);
    const rise = solved.rise;
    const stroke = solved.thick;

    // --- loft ---------------------------------------------------------
    const positions: number[] = [];
    const index: number[] = [];
    const rows: number[][] = [];
    const addPole = (x: number, y: number, z: number) => {
      rows.push([positions.length / 3]);
      positions.push(x, y, z);
    };
    for (let i = 0; i < MOUTH_ARC_RINGS; i++) {
      const u = uAt(i);
      const cx = halfW * u;
      const cy = F.mouth.y + rise * (u * u - 0.5);
      const t = taperAt(u);
      const ry = stroke * t;
      // The stroke's front face holds a constant offset off the crown, so the *centre* of a
      // thinner ring has to move back with it rather than staying on one plane.
      const cz = crownFrontZ(cx, cy) - depth * t + MOUTH_PROUD;
      if (t <= 1e-4) {
        addPole(cx, cy, cz);
        continue;
      }
      // Cross-section normal, in the arc's own plane: perpendicular to (dx, dy).
      const dy = 2 * rise * u;
      const len = Math.hypot(halfW, dy) || 1;
      const nx = -dy / len;
      const ny = halfW / len;
      const rz = depth * t;
      const row: number[] = [];
      for (let j = 0; j < MOUTH_TUBE_SEGS; j++) {
        const a = (j / MOUTH_TUBE_SEGS) * Math.PI * 2;
        const c = Math.cos(a);
        const s = Math.sin(a);
        const vx = cx + nx * ry * c;
        const vy = cy + ny * ry * c;
        // Each vertex is pressed against the surface *under itself*, not against the one
        // under the ring's centre. The crown peaks near y = 0.715 and falls away above and
        // below it, so a wide-open stroke spans a surface that is up to 0.03 lower at its
        // edges than at its middle; sizing the whole ring off the lowest of those sinks the
        // mouth into the head (the tongue then draws in front of it and the smile reads as
        // two dashes and a blob), and sizing it off the centre alone leaves the upper edge
        // standing 0.010 clear. Clamping per vertex does neither: the front face stays
        // `MOUTH_PROUD` off the clay everywhere and the parts that would have stood off it
        // are pulled back onto it.
        const lid = crownFrontZ(vx, vy) + MOUTH_PROUD;
        const vz = cz + rz * s;
        row.push(positions.length / 3);
        positions.push(vx, vy, vz > lid ? lid : vz);
      }
      rows.push(row);
    }
    stitchRows(rows, index);

    const geo = new BufferGeometry();
    geo.setAttribute("position", new BufferAttribute(new Float32Array(positions), 3));
    geo.setIndex(index);
    // No hand-press jitter: at 0.006 units it would be a quarter of the closed stroke's own
    // thickness, and a wobbly smile line is not the same thing as hand-pressed clay.
    return finish(geo, { ao: { strength: 0.9 } });
  });
}

/** One mesh of an assembled mascot. Render with a plain `<mesh {...part} />`. */
export type MascotPart = {
  /** Stable React key, and the handle a game uses to find a part it wants to animate. */
  key: string;
  geometry: BufferGeometry;
  material: Material;
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
  castShadow: boolean;
};

export type MascotOptions = {
  /** World height of the tooth body. Everything else is derived from it. Default 1. */
  height?: number;
  /** Body subdivision. Face parts stay cheap whatever this is. */
  detail?: number;
  /**
   * Multiplies feature *size* without moving a feature's anchor.
   *
   * `3D-SPEC` wants a face that reads, and a face that reads is a fixed fraction of the
   * *screen*, not of the prop: Maze Escape's 30 px hero with a 6 px face is invisible, and
   * scaling the prop up does not fix it on its own. A game that knows its prop's on-screen
   * size passes a boost here — e.g. `48 / measuredPropPx` — and gets eyes big enough to see
   * without moving them off the anchors above. Clamped into
   * `[MASCOT_FEATURE_SCALE_MIN, MASCOT_FEATURE_SCALE_MAX]` = **[0.72, 1.68]**, both derived
   * from the crown's own surface and outline rather than chosen: see those two constants.
   */
  featureScale?: number;
  /** 0 = a closed smile, 1 = a wide open grin. The tongue shows above ~0.3. */
  open?: number;
  /** Arms and feet. On by default: a rooted tooth with no limbs reads as extracted. */
  limbs?: boolean;
  kind?: ToothKind;
};

const NO_ROT: [number, number, number] = [0, 0, 0];

/**
 * The product's mascot, as a flat list of meshes.
 *
 * This is the shared answer to "four games present bare, faceless teeth with exposed roots
 * as the subject". Any game that counts, catches, rolls or drives a tooth calls this instead
 * of `toothGeometry` directly, renders the parts, and gets the same character everywhere:
 *
 * ```tsx
 * const parts = useMemo(() => mascotParts({ height: 1.2, featureScale: 1.4 }), []);
 * // …
 * <group ref={heroRef}>
 *   {parts.map((p) => <mesh key={p.key} {...p} />)}
 * </group>
 * ```
 *
 * For a prop that tumbles or rolls, put this group on a node *outside* the roll node so the
 * face stays toward camera; the parts themselves carry no animation.
 *
 * Every geometry and material here comes from the shared caches, so calling it from nine
 * games costs nine lookups and no extra GPU memory. Parts are ordered body-first.
 */
export function mascotParts(opts: MascotOptions = {}): MascotPart[] {
  const H = opts.height ?? 1;
  const F = MASCOT_FACE;
  // Clamped at both ends. The ceiling is derived from the crown's own outline — see
  // `MASCOT_FEATURE_SCALE_MAX` — so a caller cannot ask for a mouth wider than the head.
  const k = clamp(opts.featureScale ?? 1, MASCOT_FEATURE_SCALE_MIN, MASCOT_FEATURE_SCALE_MAX);
  const open = clamp01(opts.open ?? 0);
  const limbs = opts.limbs ?? true;

  // Face pieces are all the same 0.1-radius ball scaled per feature: one geometry, one draw
  // setup, and small enough on screen that detail 1 (320 triangles) is indistinguishable
  // from detail 3. The eyes are the exception — they are the read — so they get detail 2.
  const ball = softSphere(0.1, 1);
  const eyeBall = softSphere(0.1, 2);
  const s = (v: number) => (v * H * k) / 0.1;
  /** Same, for a length that already carries `featureScale`. */
  const sk = (v: number) => (v * H) / 0.1;

  const enamel = clayEnamel();
  const parts: MascotPart[] = [
    {
      key: "body",
      geometry: toothGeometry(opts.kind ?? "baby", opts.detail),
      material: enamel,
      position: [0, 0, 0],
      rotation: NO_ROT,
      scale: [H, H, H],
      castShadow: true,
    },
  ];

  const eyeMat = clayPainted(NEUTRAL.ink);
  const glintMat = clayIvory();
  const cheekMat = clayAccent("coral", "soft");

  for (const side of [-1, 1] as const) {
    parts.push({
      key: side < 0 ? "eye-l" : "eye-r",
      geometry: eyeBall,
      material: eyeMat,
      // The eye is the one feature that is **not** pressed in, on either axis, and both
      // exceptions are deliberate:
      //
      //  - **z.** What a child sees of an eye is the spherical cap standing proud of the
      //    crown, and holding the front face fixed would hold that cap fixed too — which is
      //    the whole thing `featureScale` exists to grow. Maze Escape measured it and solved
      //    its own `FEATURE_SCALE` against it (`maze-escape/props.ts:148`): the visible eye
      //    disc runs 0.0572 -> 0.1039 of the tooth's height between k = 1 and k = 1.62, and
      //    on its 13-cell board that is the difference between two eyes and one dark visor.
      //    Pressing z would have cut it to 0.0769 — a 26 % regression in the one measurement
      //    that game's face is tuned against. An eye that bulges is a cartoon eye; a cheek
      //    that bulges is a growth, which is why the cheek below is pressed and this is not.
      //  - **x.** Pressing eyes toward each other as they grow walks them across the midline.
      //
      // `MASCOT_FEATURE_SCALE_MAX` is what keeps both inside the crown's outline instead.
      position: [side * F.eye.x * H, F.eye.y * H, F.eye.z * H],
      rotation: NO_ROT,
      scale: [s(F.eye.r), s(F.eye.r), s(F.eye.r)],
      castShadow: false,
    });
    // The catchlight sits up and inboard on both eyes — a single light source, so both
    // glints are on the same side of their pupil. Mirroring it is the classic tell that a
    // face was assembled rather than lit.
    //
    // `glint.d*` is an offset in the **eye's** frame, not an anchor on the body, so it has to
    // scale with the eye or the eye swallows it. It did not, and the arithmetic is exact:
    // the offset's length is `|(-0.022, 0.024, 0.05)| = 0.0597`, so the glint's outer reach
    // was `0.0597 + 0.021 k` against a pupil radius of `0.068 k` — which crosses at
    // **k = 1.27**. At Count the Teeth's 1.3 the reach was 0.0870 against a radius of 0.0884:
    // the catchlight sphere was *entirely enclosed by the pupil* and never rendered, leaving
    // two solid matte-black discs which, over a lipless mouth line and two exposed root
    // prongs, read as a skull — on a board of fourteen of them. Scaling the offset with the
    // eye keeps the visible catchlight at a constant **27.4 % of the pupil radius** at every
    // k (it was 27.4 % at k = 1 and 0 % at every k >= 1.27).
    parts.push({
      key: side < 0 ? "glint-l" : "glint-r",
      geometry: ball,
      material: glintMat,
      position: [
        (side * F.eye.x + F.glint.dx * k) * H,
        (F.eye.y + F.glint.dy * k) * H,
        (F.eye.z + F.glint.dz * k) * H,
      ],
      rotation: NO_ROT,
      scale: [s(F.glint.r), s(F.glint.r), s(F.glint.r)],
      castShadow: false,
    });
    parts.push({
      key: side < 0 ? "cheek-l" : "cheek-r",
      geometry: ball,
      material: cheekMat,
      // Pressed in on both outward axes: x, because the cheek sits on the crown's flank and
      // is the one feature whose growth would otherwise leave the silhouette (it did, at
      // k = 1.6); and z, for the same reason as every other feature. Its outer edge therefore
      // holds at x = 0.320 against a 0.3615 half-width, at every scale.
      position: [
        side * pressIn(F.cheek.x, F.cheek.w, k) * H,
        F.cheek.y * H,
        pressIn(F.cheek.z, F.cheek.d, k) * H,
      ],
      rotation: NO_ROT,
      scale: [s(F.cheek.w), s(F.cheek.h), s(F.cheek.d)],
      castShadow: false,
    });
  }

  // Warm crevice brown, never black: the mouth is a recess in clay, and every other recess
  // in the product is this colour.
  //
  // The geometry is built in the tooth's own normalised space and placed by `H` alone —
  // `mouthArcGeometry` has to solve the crown's surface and the eye clearance at this exact
  // `featureScale`, so a uniform scale is the only transform that can be applied afterwards
  // without breaking either. One geometry per (halfWidth, thickness, depth, eyeRadius)
  // combination; the product ships seven.
  const mouthHalfW = F.mouth.w * k;
  const mouthThick = (F.mouth.shut + (F.mouth.open - F.mouth.shut) * open) * k;
  const mouth = solveMouth(mouthHalfW, mouthThick, F.mouth.curve, F.eye.r * k);
  parts.push({
    key: "mouth",
    geometry: mouthArcGeometry(mouthHalfW, mouthThick, F.mouth.d * k, F.mouth.curve, F.eye.r * k),
    material: clayPainted(CLAY.crevice),
    position: [0, 0, 0],
    rotation: NO_ROT,
    scale: [H, H, H],
    castShadow: false,
  });

  if (open > 0.3) {
    const show = (open - 0.3) / 0.7;
    // Placed against the *solved* mouth rather than against a fixed anchor.
    //
    // `MASCOT_FACE.tongue` describes a tongue inside a flat ellipsoid mouth pinned at one z:
    // it sat 0.032 below `mouth.y` and 0.040 in front of `mouth.z`, and both of those numbers
    // stopped meaning anything the moment the mouth became an arc that curves and a surface
    // that recedes. Left alone at `featureScale` 1.6 the tongue's front reached z 0.375
    // against a crown surface of 0.354 — a rose blob standing two millimetres off the chin.
    // Derived instead: it sits just inside the arc's lowest point, and just proud of the
    // stroke's own front face, so it reads as the inside of an open smile at every scale.
    // The tongue sits in the *bottom* of the open smile, the way a cartoon tongue does —
    // not centred in it, where it covers the stroke that makes the mouth read as a mouth.
    const tongueHalfH = Math.min(F.tongue.h * k, mouth.thick * 0.42) * show;
    const tongueY = mouth.midY - mouth.rise * 0.5 - mouth.thick + tongueHalfH * 1.15;
    const tongueZ = crownFrontZ(0, tongueY) + TONGUE_PROUD - F.tongue.d * k;
    parts.push({
      key: "tongue",
      geometry: ball,
      material: clayAccent("rose", "main"),
      position: [0, tongueY * H, tongueZ * H],
      rotation: NO_ROT,
      // Depth is fixed and only the face-on size grows, so the tongue can never retreat
      // behind the mouth's front surface part-way through an open.
      // `sk` takes a length that already carries `k` (the mouth's solved sizes do); `s`
      // applies it. Mixing the two is how a cap silently squares the feature scale.
      scale: [sk(Math.min(F.tongue.w * k, mouthHalfW * 0.5) * show), sk(tongueHalfH), s(F.tongue.d)],
      castShadow: false,
    });
  }

  if (limbs) {
    const armGeo = softCapsule(F.arm.r * H, F.arm.len * H, 1);
    for (const side of [-1, 1] as const) {
      parts.push({
        key: side < 0 ? "arm-l" : "arm-r",
        geometry: armGeo,
        material: enamel,
        position: [side * F.arm.x * H, F.arm.y * H, F.arm.z * H],
        // A capsule runs along +Y; rotating about Z by -tilt swings the right arm up and
        // out, so both arms come off the crown's flank rather than out of its jaw.
        rotation: [0, 0, -side * F.arm.tilt],
        scale: [1, 1, 1],
        castShadow: true,
      });
      parts.push({
        key: side < 0 ? "foot-l" : "foot-r",
        geometry: ball,
        material: enamel,
        position: [side * F.foot.x * H, F.foot.y * H, F.foot.z * H],
        rotation: NO_ROT,
        scale: [(F.foot.w * H) / 0.1, (F.foot.h * H) / 0.1, (F.foot.d * H) / 0.1],
        castShadow: true,
      });
    }
  }

  return parts;
}

/* ------------------------------------------------------------------ */
/* The mascot, as one draw call                                        */
/* ------------------------------------------------------------------ */

/** Scratch for the merge below. Build-time only — never touched inside `useFrame`. */
const _mMat = new Matrix4();
const _mNrm = new Matrix3();
const _mPos = new Vector3();
const _mScale = new Vector3();
const _mQuat = new Quaternion();
const _mEuler = new Euler();
const _mV = new Vector3();

type Colored = { color?: unknown };

/** A clay factory's own base colour, in the linear space the shader multiplies in. */
const materialColor = (m: Material): Color | null => {
  const c = (m as unknown as Colored).color;
  return c instanceof Color ? c : null;
};

/**
 * The mascot merged into **one geometry, one material, one draw call**, with the face
 * carried on `ALBEDO_ATTRIBUTE`.
 *
 * `mascotParts` is the right shape for a hero a game animates part by part. It is the wrong
 * shape for a screen that wants nine of them at once: twelve meshes each against the hub's
 * §9 ceiling of 60 draw calls, which is why four hub cards were still showing bare rooted
 * teeth long after the games had been fixed — a face there cost more calls than the whole
 * budget had left. Merging removes that trade entirely: a faced, limbed mascot costs exactly
 * what a bare `toothGeometry` costs in calls, and about 4.7k triangles at detail 2.
 *
 * The face survives the merge because the clay shader already has a per-vertex colour
 * channel that is a **straight multiply** — `aAlbedo`, added precisely so a palette would
 * stop being run through `bakeCurvatureAO`'s curvature extrapolation. Each part's own
 * material colour is divided by the carrier's (`clayEnamel`) and written into that
 * attribute, so an eye renders `NEUTRAL.ink` and a cheek `coral.soft` off one
 * `MeshPhysicalMaterial`. The baked curvature AO rides along untouched in `color`, so the
 * merged prop keeps its crevice darkening and its edge gloss.
 *
 * What is lost, and when not to use this: the parts can no longer move independently. A game
 * that blinks, opens a mouth over time or waves an arm needs `mascotParts`. A game (or a
 * menu) that wants a lot of static characters wants this.
 *
 * Render it with `clayEnamel()` — `mascotMaterial()` returns the same thing and exists so a
 * caller cannot pair the geometry with a different carrier and silently re-tint every face.
 */
export function mascotGeometry(opts: MascotOptions = {}): BufferGeometry {
  const kind = opts.kind ?? "baby";
  const key =
    `mascot|${kind}|${kf(opts.height ?? 1)}|${kf(opts.featureScale ?? 1)}|` +
    `${kf(opts.open ?? 0)}|${opts.limbs === false ? 0 : 1}|${detailOf(opts.detail)}`;
  return cachedGeometry(key, () => buildMascotMesh(opts));
}

/** The one material `mascotGeometry` is colour-calibrated against. */
export function mascotMaterial(): Material {
  return clayEnamel();
}

function buildMascotMesh(opts: MascotOptions): BufferGeometry {
  const parts = mascotParts(opts);
  const base = materialColor(mascotMaterial());
  // Guarding rather than asserting: if the carrier ever loses its colour the mascot should
  // render in flat enamel, not vanish.
  const bR = base && base.r > 1e-4 ? base.r : 1;
  const bG = base && base.g > 1e-4 ? base.g : 1;
  const bB = base && base.b > 1e-4 ? base.b : 1;

  let vTotal = 0;
  let iTotal = 0;
  for (const p of parts) {
    const n = p.geometry.getAttribute("position").count;
    vTotal += n;
    iTotal += p.geometry.index ? p.geometry.index.count : n;
  }

  const pos = new Float32Array(vTotal * 3);
  const nrm = new Float32Array(vTotal * 3);
  const col = new Float32Array(vTotal * 3);
  const alb = new Float32Array(vTotal * 3);
  const idx = vTotal > 65535 ? new Uint32Array(iTotal) : new Uint16Array(iTotal);

  let vOff = 0;
  let iOff = 0;
  for (const p of parts) {
    const g = p.geometry;
    const src = g.getAttribute("position");
    const srcN = g.getAttribute("normal");
    const srcC = g.getAttribute("color");
    const n = src.count;

    _mPos.set(p.position[0], p.position[1], p.position[2]);
    _mEuler.set(p.rotation[0], p.rotation[1], p.rotation[2]);
    _mQuat.setFromEuler(_mEuler);
    _mScale.set(p.scale[0], p.scale[1], p.scale[2]);
    _mMat.compose(_mPos, _mQuat, _mScale);
    // Inverse-transpose, because the cheeks and the mouth are genuinely non-uniform scales
    // and rotating their normals with the model matrix would tilt them off the surface.
    _mNrm.getNormalMatrix(_mMat);

    const c = materialColor(p.material);
    const aR = c ? c.r / bR : 1;
    const aG = c ? c.g / bG : 1;
    const aB = c ? c.b / bB : 1;

    for (let i = 0; i < n; i++) {
      const o = (vOff + i) * 3;
      _mV.fromBufferAttribute(src, i).applyMatrix4(_mMat);
      pos[o] = _mV.x;
      pos[o + 1] = _mV.y;
      pos[o + 2] = _mV.z;
      if (srcN) {
        _mV.fromBufferAttribute(srcN, i).applyMatrix3(_mNrm).normalize();
        nrm[o] = _mV.x;
        nrm[o + 1] = _mV.y;
        nrm[o + 2] = _mV.z;
      }
      if (srcC) {
        col[o] = srcC.getX(i);
        col[o + 1] = srcC.getY(i);
        col[o + 2] = srcC.getZ(i);
      } else {
        col[o] = 1;
        col[o + 1] = 1;
        col[o + 2] = 1;
      }
      alb[o] = aR;
      alb[o + 1] = aG;
      alb[o + 2] = aB;
    }

    const si = g.index;
    if (si) {
      for (let i = 0; i < si.count; i++) idx[iOff + i] = si.getX(i) + vOff;
      iOff += si.count;
    } else {
      for (let i = 0; i < n; i++) idx[iOff + i] = vOff + i;
      iOff += n;
    }
    vOff += n;
  }

  const geo = new BufferGeometry();
  geo.setAttribute("position", new BufferAttribute(pos, 3));
  geo.setAttribute("normal", new BufferAttribute(nrm, 3));
  geo.setAttribute("color", new BufferAttribute(col, 3));
  geo.setAttribute(ALBEDO_ATTRIBUTE, new BufferAttribute(alb, 3));
  geo.setIndex(new BufferAttribute(idx, 1));
  // Re-projected over the assembled prop rather than copied per part, so the micro-grain
  // runs continuously across a cheek and the crown it sits on instead of restarting at
  // every seam. `finish()` is deliberately NOT used here: it welds on position, which would
  // fuse a feature into the body and average the two albedos across the join.
  applyPlanarUV(geo, UV_SCALE);
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}
