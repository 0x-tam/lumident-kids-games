/**
 * Turns the flat scene descriptions in `relief.ts` into real, lit, bevelled clay.
 *
 * The brief: the picture is a **rendered relief**, and the tiles are windows onto one
 * continuous relief so a solved board reads as one object. That is exactly what this file
 * does — it clips each outline to a tile's window (`relief.ts` owns the clipping) and
 * extrudes what survives into a prism with a real quarter-round bevel on both faces.
 *
 * Why a hand-rolled extruder rather than `geometry.ts`'s `beveledExtrude`:
 * `beveledExtrude` caches by shape, and every one of these pieces is a different shape.
 * Five scenes x three levels x sixteen tiles x eighteen outlines is thousands of cache
 * entries at the wrong granularity. Building the whole window as one merged geometry
 * instead means a tile is one draw call and one disposable resource — and it is the *board*
 * that is cached, at 15 possible entries and a hard cap of 4 live, attributed to this scene
 * and freed with it. See `boardRelief` below.
 *
 * Colour rides in a vertex attribute rather than in a material per palette entry: eighteen
 * `clayPainted` materials would be eighteen draw calls per tile. One white-based clay
 * material multiplied by a baked linear colour gives the same look for one.
 *
 * **Which attribute matters.** Round 2 baked the palette into `color`, and `materials.ts`
 * reads `color` as a *signed curvature map* and extrapolates it by `uClayAO = 1.45` — which
 * drives any channel under ~0.31 straight to black. Measured on the shipped build:
 * `peach.main #efa160` rendered `(227, 74, 9)`, `mauve.main #c08475` rendered `(143, 12, 6)`,
 * and `NEUTRAL.ink` rendered pure black. Worst case was 31.7 dE2000 off token.
 *
 * The two signals are now separate, and both are used for what they are for:
 *  - `color` carries **only** the contact/wear ramp, greyscale about 1.0 (0.70 at the base of
 *    a piece, 1.06 on the crown of its top bevel), which is exactly the curvature signal
 *    `gClayCrev` and `gClayEdge` are derived from. As a side effect the edge gloss and the
 *    indirect occlusion now work on coloured pieces at all: with the palette baked in, a
 *    dark piece read as `clayLum ≈ 0.03`, i.e. permanently full crevice and zero edge.
 *  - `aAlbedo` (`materials.ts::ALBEDO_ATTRIBUTE`) carries the palette, as a straight multiply
 *    at full strength. The transfer from token to albedo is now the identity.
 *
 * The warm crevice shift stays on `color` on purpose: it is a *relative* tint about neutral,
 * not an albedo, so it survives the extrapolation as the warm deepening it was meant to be.
 *
 * Every number below is world units. Nothing here runs inside a frame.
 */
import { BufferAttribute, BufferGeometry, Color, ShapeUtils, Vector2 } from "three";
import { markShared, registerSceneCache, tagCacheEntry } from "../../three/dispose";
import { ALBEDO_ATTRIBUTE, vertexAlbedoAttribute } from "../../three/materials";
import {
  HALF,
  PLAQUE_DEPTH_SCALE,
  PLAQUE_RELIEF_SKIRT,
  PLAQUE_T,
  PLAQUE_W,
  RELIEF_Y,
  TILE_DEPTH_SCALE,
  cellU,
  cellV,
  reliefSkirt,
  windowHalf,
} from "./layout";
import {
  LADDER_LIMITS,
  MAT_HEX,
  MIN_ALBEDO_LUMA,
  SCENES,
  clipToWindow,
  overlapsInPlan,
  reliefLadder,
  type MatKey,
  type Poly,
  type ReliefScene,
} from "./relief";

/** Two points closer than this, in world units, are the same point. */
const WELD = 2e-4;

/* ------------------------------------------------------------------ */
/* Palette, in linear working space                                    */
/* ------------------------------------------------------------------ */

/**
 * `new Color(hex)` converts sRGB to the linear working space on assignment, which is what
 * `vColor` is multiplied in. Built once, on first use, so importing this module costs
 * nothing until a board is dealt.
 */
const linear = new Map<MatKey, [number, number, number]>();
const matRGB = (key: MatKey): [number, number, number] => {
  let v = linear.get(key);
  if (!v) {
    const c = new Color(MAT_HEX[key]);
    v = [c.r, c.g, c.b];
    linear.set(key, v);
  }
  return v;
};

/* ------------------------------------------------------------------ */
/* Shading constants                                                   */
/* ------------------------------------------------------------------ */

/** How dark a piece goes where it meets the surface it stands on. */
const CONTACT = 0.3;
/** Warm shift in the crevice: green and blue fall further than red (CLAY.crevice's ratio). */
const CONTACT_G = 0.06;
const CONTACT_B = 0.14;

/*
 * Ring layout note. The wear peak below is sampled at `sin(2 * theta)`, which is 1 at
 * `theta = PI/4` — a ring that only *exists* when `bevelSteps >= 2`. At `bevelSteps = 1` the
 * top bevel's two rings land at `theta = 0` and `theta = PI/2`, where `sin(2 * theta)` is
 * exactly zero, so the edge gloss would silently vanish rather than get cheaper. `scene.tsx`
 * pins `BEVEL_STEPS = 2` for that reason and `buildRelief` refuses anything lower.
 */

/**
 * Edge wear on the rolled top bevel, peaking halfway round it — and the one term in this file
 * that a dark piece of clay can actually be read by.
 *
 * `materials.ts` turns this attribute into two things: a multiply on the albedo
 * (`1 + (vColor - 1) * uClayAO`) and an **edge gloss**,
 * `gClayEdge = saturate((clayLum - 1) * 10)`, which drops roughness by `uClayEdgeGloss` on the
 * bevel crown so the key catches it as a specular line.
 *
 * The albedo multiply is worth nothing on `ink`. Round 4's SP4 measured the shipped frame:
 * the interior of a 25x18 px ink capsule on a board tile varies by **sigma 2.7-3.6 codes**
 * against ivory's 7.4 in the same frame, and the arithmetic says it cannot do better —
 * `NEUTRAL.ink` is 0.032 in linear luminance, so the full crevice-to-crown ramp spans
 * 15.6 sRGB codes / **7.5 dL\*** where the same ramp on ivory spans 63.6 codes / 23.0 dL\*.
 * sRGB's slope, not the bevel: the pieces are all >= 0.0216 units of real quarter-round.
 *
 * The **edge gloss is albedo-independent** — a specular highlight adds light whatever the
 * surface is painted — and at 0.06 it was only reaching `saturate(0.6)`, six tenths of the
 * one term that works on black. 0.11 saturates it: measured over the built attribute of a
 * whole 4x4 board, `clayLum` now reaches 1.139 and `gClayEdge` is **1.000 on 16.7 % of the
 * vertices** — the entire top-bevel crown ring — against 0.6 before, so every rolled crown in
 * the picture gets the full roughness drop and a dark silhouette *rolls* instead of ending. The paired albedo lift is +16 % on the crown, and it is **desaturating** as well as
 * lightening — §3 asks for worn edges that go "lighter and desaturated", and the old term
 * scaled all three channels equally, i.e. lightened without ever desaturating anything.
 *
 * The other half of SP4 is the albedo floor itself, and it is in `relief.ts::MAT_HEX`.
 */
const WEAR = 0.11;
/** How much of the crown's lift is spent pulling the three channels together. */
const WEAR_DESAT = 0.45;

/** Largest bevel a piece is allowed, and the share of its own depth it may spend on one. */
const MAX_BEVEL = 0.045;
const BEVEL_OF_DEPTH = 0.45;

/**
 * Oblique UV projection, matching `geometry.ts::UV_U`/`UV_V` so the clay grain runs
 * continuously from the tile the picture is printed on into the picture itself.
 *
 * Copied, and it had gone stale: round 4's A14 replaced the shared pair with the orthonormal
 * basis of the plane perpendicular to `(1, 1, 1)` — worst-case anisotropic stretch 1.73
 * against the old pair's 2.84 — and this file kept the old numbers, so every relief piece was
 * grained on a different projection from the plate underneath it. These are the shared
 * values; they must be re-copied whenever that pair moves.
 */
const UV_U = [0.7071068, -0.7071068, 0] as const;
const UV_V = [0.4082483, 0.4082483, -0.8164966] as const;
const UV_SCALE = 2;

/* ------------------------------------------------------------------ */
/* Scratch (build time only — this file is never called from a frame)  */
/* ------------------------------------------------------------------ */

const px: number[] = [];
const py: number[] = [];
const nx: number[] = [];
const ny: number[] = [];
const mx: number[] = [];
const my: number[] = [];
const mlen: number[] = [];
const mmax: number[] = [];
const elen: number[] = [];
const icap: number[] = [];
const contour: Vector2[] = [];

export type ReliefWindow = {
  /** Centre of the window in board space. */
  cu: number;
  cv: number;
  /** Half-extent of the (square) window in board space. */
  half: number;
};

export type ReliefOptions = {
  /** World units per board unit. */
  scale: number;
  /** Multiplier on every `lift` and `depth` — the plaque is a shrunken copy. */
  depthScale: number;
  /** World Y the relief's base plane sits at, in the parent's local space. */
  y0: number;
  /**
   * How far a **ground-layer** piece's bottom cap is pushed below `y0`, so it meets the clay
   * it stands on out to the very edge of the window rather than floating over the receiver's
   * rolled rim. See `layout.ts::reliefSkirt` for the derivation and the measurement.
   *
   * The extra wall is buried in the receiver everywhere inboard of the roll, it costs no
   * triangles (the ring count is unchanged — one ring moves), and it does not change the
   * shading ramp: `y0` stays the reference the contact darkening is measured from.
   */
  skirt: number;
  /** Quarter-round segments per bevel. Never below 2 — see the ring layout note above. */
  bevelSteps: number;
};

/**
 * Builds one merged geometry for everything visible through `win`.
 *
 * Returns `null` when the window is empty — an all-sky tile draws nothing at all, which is
 * where most of this game's draw-call headroom comes from.
 */
export function buildRelief(
  polys: readonly Poly[],
  win: ReliefWindow,
  opts: ReliefOptions
): BufferGeometry | null {
  const pos: number[] = [];
  const nor: number[] = [];
  /** Curvature only — see the header. Never a palette colour. */
  const col: number[] = [];
  /** The palette, on its own attribute. */
  const alb: number[] = [];
  const uvs: number[] = [];
  const idx: number[] = [];

  // 2, not 1: at K = 1 the top bevel has no ring at `theta = PI/4` and the edge gloss the
  // dark clay is read by evaluates to exactly zero. See the ring layout note by `WEAR`.
  const K = Math.max(2, Math.round(opts.bevelSteps));
  const rings = 2 * (K + 1);
  /**
   * Half-extent of the window in local units.
   *
   * A miter that rolls a vertex inward along one axis pushes it *outward* along the other,
   * so a vertex already sitting on the clip line can let its bevel bulge past the tile's
   * edge and overhang the neighbouring tile. Each vertex's travel along its own miter ray
   * is therefore capped at the point where the ray leaves this box (`mmax`), which pins
   * those vertices onto the cut — which is what a cut piece of clay looks like anyway —
   * without knocking any of them off their ray and folding the ring.
   */
  const lim = win.half * opts.scale;

  for (let p = 0; p < polys.length; p++) {
    const poly = polys[p];
    const clipped = clipToWindow(
      poly.pts,
      win.cu - win.half,
      win.cu + win.half,
      win.cv - win.half,
      win.cv + win.half
    );
    if (clipped.length < 6) continue;

    // Board space -> the parent's local plane. `py` stays picture-up; world z is -py.
    //
    // Near-coincident points are dropped here, not in `relief.ts`: its dedupe works in board
    // space at 1e-5, which after scaling still leaves edges a fraction of a micron long, and
    // an edge that short has a normal made entirely of rounding error. Averaging one of
    // those into a vertex normal is what flips a bevel quad inside out.
    px.length = 0;
    py.length = 0;
    for (let i = 0; i < clipped.length / 2; i++) {
      const x = (clipped[i * 2] - win.cu) * opts.scale;
      const y = (clipped[i * 2 + 1] - win.cv) * opts.scale;
      const last = px.length - 1;
      if (last >= 0 && Math.abs(px[last] - x) < WELD && Math.abs(py[last] - y) < WELD) continue;
      px.push(x);
      py.push(y);
    }
    while (
      px.length > 2 &&
      Math.abs(px[0] - px[px.length - 1]) < WELD &&
      Math.abs(py[0] - py[py.length - 1]) < WELD
    ) {
      px.pop();
      py.pop();
    }
    const n = px.length;
    if (n < 3) continue;
    // Sutherland-Hodgman preserves winding, but a sliver can come back inverted; the cap
    // triangulation and the side winding both depend on it, so normalise here.
    let area2 = 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      area2 += px[i] * py[j] - px[j] * py[i];
    }
    area2 *= 0.5;
    if (area2 < 0) {
      area2 = -area2;
      for (let i = 0, j = n - 1; i < j; i++, j--) {
        const tx = px[i];
        const ty = py[i];
        px[i] = px[j];
        py[i] = py[j];
        px[j] = tx;
        py[j] = ty;
      }
    }

    const depth = Math.max(0.004, poly.depth * opts.depthScale);
    const y0 = opts.y0 + poly.lift * opts.depthScale;
    const y1 = y0 + depth;

    // Outward 2D edge normals, and the perimeter, in one pass.
    nx.length = 0;
    ny.length = 0;
    elen.length = 0;
    let perimeter = 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ex = px[j] - px[i];
      const ey = py[j] - py[i];
      const len = Math.hypot(ex, ey) || 1e-6;
      perimeter += len;
      elen.push(len);
      // (dy, -dx) is outward for a counter-clockwise outline.
      nx.push(ey / len);
      ny.push(-ex / len);
    }

    // A quarter-round can never eat more than the piece's own inradius, or the inset ring
    // turns itself inside out and the cap triangulates into confetti.
    const area = area2;
    const inradius = perimeter > 1e-6 ? (2 * area) / perimeter : 0;
    const bevel = Math.min(depth * BEVEL_OF_DEPTH, MAX_BEVEL, inradius * 0.5);
    if (bevel <= 1e-5) continue;

    // Miter directions: how far each vertex travels per unit of inset.
    mx.length = 0;
    my.length = 0;
    mlen.length = 0;
    mmax.length = 0;
    icap.length = 0;
    for (let i = 0; i < n; i++) {
      const h = (i - 1 + n) % n;
      const ax = nx[h] + nx[i];
      const ay = ny[h] + ny[i];
      const len = Math.hypot(ax, ay) || 1e-6;
      const ux = ax / len;
      const uy = ay / len;
      // Reciprocal of the half-angle cosine, floored at 0.5 so a sharp corner offsets by at
      // most twice the inset instead of shooting off to infinity. `raw` is (1 + n_h·n_i) /
      // |n_h + n_i| and so can only reach zero when the two edges double back on each other
      // — a needle whose bisector is pure rounding error. Those vertices get no inset at
      // all, which is the only safe answer.
      const raw = ux * nx[i] + uy * ny[i];
      const cos = raw > 1e-4 ? Math.max(0.5, raw) : 1e9;
      mx.push(ux);
      my.push(uy);
      mlen.push(1 / cos);
      // How far this vertex may travel before it leaves the window. Limiting the *distance*
      // along the miter ray, rather than clamping the resulting x and y independently,
      // keeps every ring vertex on its own ray and so keeps the ring from folding over
      // itself where a piece is cut by the tile's edge.
      let cap = Infinity;
      if (ux > 1e-6) cap = Math.min(cap, (px[i] + lim) / ux);
      else if (ux < -1e-6) cap = Math.min(cap, (lim - px[i]) / -ux);
      if (uy > 1e-6) cap = Math.min(cap, (py[i] + lim) / uy);
      else if (uy < -1e-6) cap = Math.min(cap, (lim - py[i]) / -uy);
      mmax.push(cap < 0 ? 0 : cap);
      icap.push(Infinity);
    }

    /*
     * Local inset limit.
     *
     * Offsetting a polygon inward shrinks each edge at a rate that depends on both of its
     * miters; when an edge reaches zero length the ring folds through itself and the quad
     * above it turns inside out. A single global "half the inradius" clamp cannot see that
     * — the offender is always one short edge next to a sharp corner, which is exactly what
     * clipping a smooth curve against a tile boundary produces. So each edge's own collapse
     * distance is solved and capped at 50% for the two vertices that share it. On a smooth
     * curve the collapse distance works out to the local radius, so this costs nothing
     * there; it only bites at corners, which is the whole point.
     */
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const len = elen[i];
      const ex = (px[j] - px[i]) / len;
      const ey = (py[j] - py[i]) / len;
      const rate =
        (mx[j] * mlen[j] - mx[i] * mlen[i]) * ex + (my[j] * mlen[j] - my[i] * mlen[i]) * ey;
      if (rate <= 1e-6) continue;
      const d = (len / rate) * 0.5;
      if (d < icap[i]) icap[i] = d;
      if (d < icap[j]) icap[j] = d;
    }

    const [mr, mg, mb] = matRGB(poly.mat);
    /**
     * Per-channel wear strength: the crown lightens by `WEAR` everywhere and, on top of that,
     * each channel that sits below this clay's brightest one gets up to `WEAR * WEAR_DESAT`
     * more — so the crown desaturates as well as lightens (§3), bounded at 4.5 % however
     * saturated the clay is. On a near-neutral clay the deficits are ~0 and this collapses to
     * the plain lift, which is the right answer: worn ink does not turn a colour.
     */
    const mMax = Math.max(mr, Math.max(mg, mb)) || 1;
    const wr = WEAR * (1 + WEAR_DESAT * (1 - mr / mMax));
    const wg = WEAR * (1 + WEAR_DESAT * (1 - mg / mMax));
    const wb = WEAR * (1 + WEAR_DESAT * (1 - mb / mMax));
    /*
     * Ground layer only: a piece with `lift > 0` stands on the piece below it, which
     * `relief.ts::ladder` has already sunk `WORLD.embed` into.
     *
     * `- bevel` as well as `- skirt`, and that extra term is what makes the fit exact. The
     * bottom bevel insets the plan silhouette as it descends, so the piece is only at its
     * full window width at ring `K`, which sits `bevel` above the bottom cap. Dropping the
     * cap by the piece's own bevel puts that full-width ring exactly on `y0 - skirt` — the top
     * of the receiver's widest band, the one height at which the tile really is `tileSize`
     * across. Without it the widest ring lands `bevel` higher, where the tile has rolled in by
     * ~1.2 screen px, and the piece keeps a hairline flange over its own tile's rim.
     */
    const skirt = poly.lift <= 1e-9 ? Math.max(0, opts.skirt) + bevel : 0;
    const yFloor = y0 - skirt;
    const base = pos.length / 3;

    for (let r = 0; r < rings; r++) {
      // Rings run bottom cap -> bottom bevel -> straight wall -> top bevel -> top cap.
      const top = r > K;
      const theta = top ? ((r - K - 1) / K) * (Math.PI / 2) : ((K - r) / K) * (Math.PI / 2);
      const sin = Math.sin(theta);
      const cos = Math.cos(theta);
      const inset = bevel * (1 - cos);
      const y = top ? y1 - bevel + bevel * sin : yFloor + bevel - bevel * sin;

      // Clamped, not raw: the skirt puts `y` below `y0`, where `k` would run past 1 and the
      // quadratic contact term would invert. Those rings are buried in the receiver, so the
      // only requirement is that they carry the darkest colour of the ramp rather than a
      // nonsense one.
      const t = (y - y0) / depth;
      const k = t < 0 ? 1 : t > 1 ? 0 : 1 - t;
      const shade = 1 - CONTACT * k * k;
      const s2 = top ? Math.sin(2 * theta) : 0;
      const cr = shade * (1 + wr * s2);
      const cg = shade * (1 - CONTACT_G * k) * (1 + wg * s2);
      const cb = shade * (1 - CONTACT_B * k) * (1 + wb * s2);

      const ny3 = top ? sin : -sin;

      for (let i = 0; i < n; i++) {
        let travel = mlen[i] * (inset < icap[i] ? inset : icap[i]);
        if (travel > mmax[i]) travel = mmax[i];
        const x = px[i] - mx[i] * travel;
        const z = -(py[i] - my[i] * travel);
        pos.push(x, y, z);
        // The *averaged* vertex normal, not the edge normal, and the same direction the
        // miter travels — so the bevel shades as one continuous rolled surface.
        nor.push(mx[i] * cos, ny3, -my[i] * cos);
        col.push(cr, cg, cb);
        alb.push(mr, mg, mb);
        uvs.push(
          (x * UV_U[0] + y * UV_U[1] + z * UV_U[2]) * UV_SCALE,
          (x * UV_V[0] + y * UV_V[1] + z * UV_V[2]) * UV_SCALE
        );
      }
    }

    // Side bands. `rings - 1` of them, which includes the straight wall between the two
    // bevels, so the whole silhouette is one smooth surface with no crease anywhere.
    for (let r = 0; r < rings - 1; r++) {
      const lo = base + r * n;
      const hi = lo + n;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        idx.push(lo + i, lo + j, hi + j, lo + i, hi + j, hi + i);
      }
    }

    // Caps. Both bevels end at exactly (0, ±1, 0), so the outermost bevel ring *is* the cap
    // boundary and no extra vertices are needed.
    contour.length = 0;
    const capBase = base + (rings - 1) * n;
    for (let i = 0; i < n; i++) {
      contour.push(new Vector2(pos[(capBase + i) * 3], -pos[(capBase + i) * 3 + 2]));
    }
    let faces: number[][] = [];
    try {
      faces = ShapeUtils.triangulateShape(contour, []);
    } catch {
      faces = [];
    }
    if (faces.length === 0) {
      // Fan fallback: these outlines are convex by construction (relief.ts §Outlines), so a
      // fan is correct whenever earcut declines a numerically awkward sliver.
      for (let i = 1; i < n - 1; i++) faces.push([0, i, i + 1]);
    } else {
      // Earcut does not promise to preserve the input winding, and the caps are the only
      // triangles here whose orientation is not derived from the ring order. Measure the
      // first non-degenerate triangle in picture space and flip the whole set if needed.
      for (let f = 0; f < faces.length; f++) {
        const a = faces[f][0];
        const b = faces[f][1];
        const c = faces[f][2];
        const cross =
          (contour[b].x - contour[a].x) * (contour[c].y - contour[a].y) -
          (contour[b].y - contour[a].y) * (contour[c].x - contour[a].x);
        if (Math.abs(cross) < 1e-12) continue;
        if (cross < 0) {
          for (let g = 0; g < faces.length; g++) {
            const t = faces[g][1];
            faces[g][1] = faces[g][2];
            faces[g][2] = t;
          }
        }
        break;
      }
    }
    const bottom = base;
    for (let f = 0; f < faces.length; f++) {
      const a = faces[f][0];
      const b = faces[f][1];
      const c = faces[f][2];
      idx.push(capBase + a, capBase + b, capBase + c);
      idx.push(bottom + c, bottom + b, bottom + a);
    }
  }

  if (idx.length === 0) return null;

  const geo = new BufferGeometry();
  geo.setAttribute("position", new BufferAttribute(new Float32Array(pos), 3));
  geo.setAttribute("normal", new BufferAttribute(new Float32Array(nor), 3));
  geo.setAttribute("color", new BufferAttribute(new Float32Array(col), 3));
  geo.setAttribute(ALBEDO_ATTRIBUTE, vertexAlbedoAttribute(new Float32Array(alb)));
  geo.setAttribute("uv", new BufferAttribute(new Float32Array(uvs), 2));
  geo.setIndex(pos.length / 3 > 65535 ? new BufferAttribute(new Uint32Array(idx), 1) : new BufferAttribute(new Uint16Array(idx), 1));
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

/* ------------------------------------------------------------------ */
/* The board cache                                                     */
/* ------------------------------------------------------------------ */

/**
 * A whole board's relief, cached by the three things that decide it.
 *
 * Round 3 built these inside the `tiles` `useMemo` in `scene.tsx` — that is, synchronously
 * inside a React render — on scene entry, on every "Next picture" and on every difficulty
 * change. Measured here, warm, on an Apple-silicon laptop: a whole board is **0.8–3.8 ms**
 * depending on the picture, worst case `family` at 4x4. On the mid-range Android tablet
 * §4 actually targets that is comfortably a dropped frame, mid-session, in the middle of a
 * child pressing a button.
 *
 * (One claim in the round-3 fix list is not reproducible and should not be chased: *"4x4 is
 * 5x the work"*. It is not — it is **less**. Each outline's geometry is built once across
 * the whole picture whatever the tile count, because a tile only extrudes the part of an
 * outline that falls inside its own window; more tiles only add clipping, and clipping
 * against a smaller window throws more away. Measured over all five scenes at K=2:
 * 2x2 = 0.96 ms, 3x3 = 0.96 ms, 4x4 = 0.43 ms warm; cold-per-scene 0.81–2.69 ms at 2x2
 * against 0.96–3.82 ms at 4x4, i.e. within 1.4x, not 5x.)
 *
 * So the fix is the cache, not a smaller build. A board is ~210 KB of vertex and index data
 * for a typical picture and ~420 KB for `family`; `MAX_BOARDS` of 4 bounds this at well
 * under 2 MB and covers the picture on screen, the one prefetched behind it, and two the
 * child has recently been on. It is a **registered scene cache**, so `dispose.ts` attributes
 * every entry to `sliding-puzzle` and frees the lot when the game unmounts — the reason the
 * header above rejected caching in round 2 ("a memory-baseline leak dressed up as a cache")
 * is exactly the thing round 3's A1 fixed.
 *
 * One honest caveat, so nobody has to discover it from a memory report: `dispose.ts` deletes
 * a key from its ownership map only when *it* evicts the entry, and there is no exported way
 * to tell it about a local eviction. So an LRU drop here leaves the key behind in
 * `cacheOwnership().byCache["sliding-puzzle/relief"]`, which can therefore read as high as
 * the 20 keys this cache can ever mint (15 boards + 5 plaques) while at most `MAX_BOARDS`
 * are alive. `sceneCacheSizes()` reports `boards.size` and is exact; the renderer's own
 * geometry count is exact; the residue is ~20 short strings that never grows past that, and
 * it cannot cause a false promotion to the shared tier, because a re-tag of a key this scene
 * already owns is a no-op.
 */
const CACHE_NAME = "sliding-puzzle/relief";
/**
 * **Must stay strictly greater than the number of `take`s one deal performs**, which is
 * three: the board, its plaque, and the prefetch of the next picture. Eviction always drops
 * the least recently used key, so with 4 > 3 the two boards that are actually mounted are
 * always among the last three touched and can never be disposed out from under a live mesh.
 * Anything that adds a fourth `take` per deal has to raise this in the same change.
 */
const MAX_BOARDS = 4;

/** Insertion-ordered, so the first key is the least recently used. */
const boards = new Map<string, (BufferGeometry | null)[]>();

const evictBoard = (key: string): void => {
  const board = boards.get(key);
  if (board === undefined) return;
  for (const geo of board) geo?.dispose();
  boards.delete(key);
};

registerSceneCache({
  name: CACHE_NAME,
  entries: () => boards.entries(),
  size: () => boards.size,
  evict: evictBoard,
});

const take = (key: string, build: () => (BufferGeometry | null)[]): (BufferGeometry | null)[] => {
  const hit = boards.get(key);
  if (hit !== undefined) {
    // Re-insert so the most recently used key sorts last.
    boards.delete(key);
    boards.set(key, hit);
    tagCacheEntry(CACHE_NAME, key);
    return hit;
  }
  const board = build();
  // `markShared` so `disposeObject3D` walks past them when the view unmounts: these outlive
  // any one board and are freed by the scene eviction above, or by `disposeReliefCache`.
  for (const geo of board) if (geo) markShared(geo);
  boards.set(key, board);
  while (boards.size > MAX_BOARDS) {
    const oldest = boards.keys().next();
    if (oldest.done || oldest.value === key) break;
    evictBoard(oldest.value);
  }
  tagCacheEntry(CACHE_NAME, key);
  return board;
};

/**
 * Every tile's relief for one picture at one board size, in tile-id order.
 *
 * `null` where a tile's window contains nothing but sky — that tile builds no geometry and
 * costs no draw call, which is where most of this game's headroom comes from.
 */
export function boardRelief(
  sceneIdx: number,
  size: number,
  bevelSteps: number
): (BufferGeometry | null)[] {
  return take(`tiles|${sceneIdx}|${size}|${bevelSteps}`, () => {
    const polys = SCENES[sceneIdx].polys;
    const half = windowHalf(size);
    const skirt = reliefSkirt(size);
    const out: (BufferGeometry | null)[] = [];
    for (let id = 0; id < size * size; id++) {
      out.push(
        buildRelief(
          polys,
          { cu: cellU(id, size), cv: cellV(id, size), half },
          { scale: HALF, depthScale: TILE_DEPTH_SCALE, y0: RELIEF_Y, skirt, bevelSteps }
        )
      );
    }
    return out;
  });
}

/** The reference plaque's relief: the same picture, uncut, at the plaque's own scale. */
export function plaqueRelief(sceneIdx: number, bevelSteps: number): BufferGeometry | null {
  return take(`plaque|${sceneIdx}|${bevelSteps}`, () => [
    buildRelief(
      SCENES[sceneIdx].polys,
      { cu: 0, cv: 0, half: 1 },
      {
        scale: PLAQUE_W / 2,
        depthScale: PLAQUE_DEPTH_SCALE,
        y0: PLAQUE_T / 2,
        skirt: PLAQUE_RELIEF_SKIRT,
        bevelSteps,
      }
    ),
  ])[0];
}

/**
 * Every relief clay whose linear luminance is under `relief.ts::MIN_ALBEDO_LUMA`.
 *
 * The floor is what stops a picture reaching for a token so dark that no bevel can be seen in
 * it — round 4's SP4, whose arithmetic is on `MAT_HEX`. Checked rather than claimed, on the
 * same dev boot as the layer and ladder assertions below.
 */
export function reliefAlbedoFaults(): string[] {
  const out: string[] = [];
  for (const key of Object.keys(MAT_HEX) as MatKey[]) {
    const [r, g, b] = matRGB(key);
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (luma < MIN_ALBEDO_LUMA - 1e-6) {
      out.push(
        `${key} (${MAT_HEX[key]}) has linear luminance ${luma.toFixed(4)}, under the ` +
          `${MIN_ALBEDO_LUMA} floor — its crevice-to-crown ramp spans too few sRGB codes to ` +
          `read as clay at any bevel width.`
      );
    }
  }
  return out;
}

/** Frees every cached board. App teardown and leak tests only. */
export function disposeReliefCache(): void {
  for (const key of [...boards.keys()]) evictBoard(key);
}

/* ------------------------------------------------------------------ */
/* Build-time layer assertion                                          */
/* ------------------------------------------------------------------ */

/**
 * How close two top faces may come before they are treated as coplanar, in world units.
 *
 * Round 2 shipped `familyScene` with the head at `lift 0.045 + depth 0.100` and the hair at
 * `lift 0.050 + depth 0.095` — both exactly 0.145, over a 0.56 x 0.28 board-space overlap, on
 * three figures, in the hero scene. Two front-facing caps at the same depth with different
 * albedos is a hard black-and-white dither punched through the hair, and it was visible at 1x
 * in six of the captured frames. 0.012 world units is 1.2 mm at the product's scale — a
 * separation the depth buffer resolves at every distance the camera is allowed to sit at, and
 * still small enough to read as two layers of clay pressed together.
 */
const LAYER_EPS = 0.012;

/**
 * Every pair of overlapping pieces in `scenes` whose **top** faces land within `LAYER_EPS`
 * of each other while carrying different clay.
 *
 * Top faces only, and different clay only, both on purpose:
 *  - the bottom cap of a piece is wound to face down and is culled by `FrontSide` at every
 *    camera angle this game allows, so two coincident bottoms cannot fight;
 *  - two coincident tops of the *same* clay are the same colour with the same normal, which
 *    is what the two halves of every smile in this file are, and they cannot show a seam.
 *    (`reliefMesh` projects UVs from world position, so coincident points also carry
 *    identical grain — there is no second signal for a seam to appear in.)
 *
 * The overlap test is `relief.ts::overlapsInPlan`, and it has to be *that* function rather
 * than a local one. Since round 3 the layering is derived from the same predicate: what this
 * asserts and what `ladder()` built are then the same proposition, and the assertion cannot
 * fire on a pair the ladder deliberately merged. It used to be a bounding-box test, chosen
 * for a conservative bias that made sense while the tops were hand-authored — against a
 * derived ladder that bias is just eight false alarms from long diagonal capsules whose
 * boxes clip a corner they never touch.
 */
export function reliefLayerFaults(scenes: readonly ReliefScene[]): string[] {
  const out: string[] = [];
  for (const scene of scenes) {
    for (let i = 0; i < scene.polys.length; i++) {
      for (let j = i + 1; j < scene.polys.length; j++) {
        const a = scene.polys[i];
        const b = scene.polys[j];
        if (a.mat === b.mat) continue;
        const delta = Math.abs(a.lift + a.depth - (b.lift + b.depth));
        if (delta >= LAYER_EPS) continue;
        if (!overlapsInPlan(a.pts, b.pts)) continue;
        out.push(
          `${scene.id}: poly ${i} (${a.mat}) and poly ${j} (${b.mat}) overlap with tops ` +
            `${(a.lift + a.depth).toFixed(3)} and ${(b.lift + b.depth).toFixed(3)} — ` +
            `${delta.toFixed(4)} apart, under the ${LAYER_EPS} minimum.`
        );
      }
    }
  }
  return out;
}

/**
 * The two numbers the ladder exists to hold, checked rather than claimed.
 *
 * Both are stated in world units at `TILE_DEPTH_SCALE`, which is the space they mean
 * something in: `minWall` is the silhouette a child can actually see and the cast shadow it
 * throws, and `topBudget` is what bounds the apparent overhang onto the tile in front. A
 * picture that cannot satisfy both has a stacking chain too deep for the budget, and the
 * answer is to fix the *artwork* — find the accidental intersection that added a layer —
 * not to widen the budget.
 */
export function reliefLadderFaults(): string[] {
  const out: string[] = [];
  for (const r of reliefLadder()) {
    if (r.wallWorld < LADDER_LIMITS.minWall - 1e-9) {
      out.push(
        `${r.id}: ${r.layers} stacked clay changes give a ${r.wallWorld.toFixed(4)} u wall, ` +
          `under the ${LADDER_LIMITS.minWall} u floor — its relief will read as a cutout.`
      );
    }
    if (r.topWorld > LADDER_LIMITS.topBudget + 1e-9) {
      out.push(
        `${r.id}: ${r.layers} stacked clay changes reach ${r.topWorld.toFixed(4)} u, over the ` +
          `${LADDER_LIMITS.topBudget} u budget — the tallest piece would overhang ` +
          `${((r.topWorld * 1.1106) / 0.67) * 100}% of a 4x4 tile.`
      );
    }
  }
  return out;
}

// Runs once, on the first import of this module, over all five scenes. It is a pure loop over
// a few hundred pairs of numbers, and it is stripped from the production bundle.
if (import.meta.env.DEV) {
  const faults = [
    ...reliefLayerFaults(SCENES),
    ...reliefLadderFaults(),
    ...reliefAlbedoFaults(),
  ];
  if (faults.length > 0) {
    console.error(`[sliding-puzzle/relief] ${faults.length} relief fault(s):\n` + faults.join("\n"));
  }
}
