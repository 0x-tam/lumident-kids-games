/**
 * Tooth Rescue's alcove, as **one** continuous surface.
 *
 * ---------------------------------------------------------------------------
 * What this replaces, and why
 * ---------------------------------------------------------------------------
 *
 * Round 3 filed the backdrop five times — the game critic, the performance critic, the
 * brand critic, the accessibility critic and the content-safety critic all reached it
 * independently — and every one of the measurements is reproducible from the geometry that
 * produced it. The set was five `roundedBox` slabs abutting in mid-air:
 *
 *   `panelGeo` (`CLAY.crevice`, at `PANEL_Z`) behind a rectangular hole left between two
 *   `wingGeo` and a `lintelGeo` (`CLAY.ivoryDeep`, half a unit in front of it).
 *
 * Five failures, one cause — **nothing joined anything**:
 *
 *  - **sigma 1.3/255 over a 40x40 patch, 3 % luminance variation over 500 px.** The panel
 *    is a plane; a plane under a *directional* key has one normal, so `N.L` is a constant
 *    and the surface has no shading gradient at all. Not a tuning failure — an arithmetic
 *    one.
 *  - **One-pixel silhouette transitions with zero AO at both junctions**, measured at the
 *    shelf (`(124,86,56) -> (234,213,185)` at x = 560) and at the wing (`(138,129,116) ->
 *    `(127,88,59)` at y = 400). A `roundedBox`'s side face points *away* from the recess,
 *    so a camera on the axis sees the wing's front face, then its 1-px bevel roll, then the
 *    panel — with 0.475 units of air between them that nothing occupies.
 *  - **Razor 90-degree silhouette corners at 3x zoom**, against `3D-SPEC §3`'s flat ban.
 *  - **13 % in-family pixels**, because the largest surface in the frame was
 *    `CLAY.crevice` — a neutral, not one of the five accent families.
 *  - **Relative luminance 0.112 across a quarter of the desktop frame** where every other
 *    surface in the product sits at 0.68-0.80.
 *
 * The contrast reasoning underneath it was sound and was independently re-verified: a
 * falling ivory tooth renders at L 0.663, and against the cream shelf that is **1.09:1** —
 * genuinely invisible. The separation has to stay. What had to go is the execution.
 *
 * ---------------------------------------------------------------------------
 * What it is now
 * ---------------------------------------------------------------------------
 *
 * One height field, `z(x, y)`, over the whole back of the set — wall face, reveal, soffit
 * and recess are the *same* surface, so there is no junction anywhere for a hard edge or a
 * missing contact gradient to live in. Three terms:
 *
 *  1. **Openness.** `s(x, y) = Sx(x) * Sy(y)`, each a quintic smootherstep. `s = 0` is the
 *     pale wall face at `NICHE_MOUTH_Z`; `s = 1` is the recess. The product form rounds the
 *     opening's top corners for free.
 *  2. **The dish.** Inside the recess the back bows forward toward the reveals by
 *     `nicheDish(openHalfX) * (x / openHalfX)^2`, which is what gives the back wall a
 *     horizontal shading gradient where a plane has none.
 *  3. **The cove.** `Sy` spans `nicheCoveSpan` — up to 1.15 units, against the reveal's 0.44
 *     — so the head of the alcove is a deep coved soffit rather than a lintel butted onto a
 *     panel. `nicheCoveSpan` solves to 1.04-1.08 at every viewport tested, where the soffit
 *     reaches **54.4 degrees** at its steepest, the surface faces the floor, and the wrapped
 *     `N.L` reaches **-0.293**: it keeps the environment and none of the key.
 *
 * Every derivative is continuous because a quintic smootherstep has zero first *and* second
 * derivative at both ends, so the surface is C2 where it meets the flat wall and C2 where
 * it meets the flat recess: not merely "no 90-degree corner", but no curvature step either.
 * `turnRadius` below states the tightest radius of curvature anywhere on it — **0.242 units**
 * at the reveal, 0.394 at the cove the shipped viewports solve to, 0.242 at the tightest cove
 * the clamp permits — and `buildAlcove` asserts both against `3D-SPEC §3`'s 0.02 floor on
 * every build in dev rather than trusting this sentence. Measured on the built mesh, the
 * worst angle between two adjacent vertex normals anywhere is 18.4 degrees.
 *
 * Colour rides on `ALBEDO_ATTRIBUTE`, never on the `color` attribute: `color` is
 * `bakeCurvatureAO`'s signed curvature and the clay shader extrapolates it by
 * `uClayAO = 1.45`, which turns a token colour into mud or into black. See
 * `materials.ts: ALBEDO_ATTRIBUTE`.
 *
 * ---------------------------------------------------------------------------
 * Why the set still does not cast
 * ---------------------------------------------------------------------------
 *
 * The fix list asked for `castShadow` on the set plus a wider ortho frustum, so every
 * junction would gain a contact gradient. Worked through, that does not do anything here,
 * and the arithmetic says why: the studio key arrives from `normalize(-4, 7, 5)`, i.e. from
 * **in front of** the set. A shadow cast by the wall face travels backwards (`dz < 0`) and
 * lands on the wall's own back, out of shot; the plinth, which stands 0.30 proud of the
 * shelf at `z = -1.93`, throws its shadow into the strip behind itself that the plinth
 * already occludes. Widening `shadowArea` from 7 to the ~10 the set's extent needs would
 * drop the map from 146 to 102 texels per unit — a 30 % loss on the basket and on every
 * falling tooth, which are the only casters in the scene whose shadow a child sees — and
 * buy nothing.
 *
 * So the fix list's own stated alternative is what ships: the junctions are *dissolved*
 * rather than shadowed, and `bakeCurvatureAO` runs across the whole welded surface, so
 * every concave turn (the back of the reveal, the throat of the cove) darkens and every
 * convex one (the lip of the opening) picks up the edge gloss the clay shader drives from
 * the same attribute.
 */
import { BufferAttribute, BufferGeometry, Color } from "three";

import { bakeCurvatureAO } from "../../three/geometry";
import { ALBEDO_ATTRIBUTE, vertexAlbedoAttribute } from "../../three/materials";
import { ACCENTS, CLAY, color } from "../../three/tokens";
import { FRAME_T, FRAME_Z, NICHE_BACK_Z, NICHE_MOUTH_Z, NICHE_SIDE_FILLET, RAIL_H, nicheDish } from "./layout";

/**
 * The product's one UV projection, mirrored from `geometry.ts`.
 *
 * Duplicated rather than imported because `geometry.ts` keeps it private and the clay
 * shader's grain, mottle and mottle-roughness all read `vNormalMapUv`: a surface built here
 * with a different projection would carry visibly different grain from every other clay
 * surface in the same frame. Three numbers and a scale, held identical on purpose.
 */
const UV_U = [0.904, 0.362, 0.226] as const;
const UV_V = [0.218, 0.873, -0.436] as const;
const UV_SCALE = 2;

/** Quintic smootherstep. Zero first *and* second derivative at both ends. */
const qstep = (t: number): number => {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t * t * t * (t * (t * 6 - 15) + 10);
};

/**
 * Peak |S''| of the quintic on [0,1], and the |S'| at the same parameter.
 *
 * `S''(t) = 60 t (2t - 1)(t - 1)` peaks at `t = (3 ± sqrt(3)) / 6`, where `|S''| = 10/sqrt(3)`
 * = 5.7735 and `S'(t) = 30 t^2 (t-1)^2` = 5/6 = 0.8333. Both are needed to state the radius
 * of curvature of a turn, so both are constants rather than remembered numbers.
 */
const Q_D2_PEAK = 10 / Math.sqrt(3);
const Q_D1_AT_D2_PEAK = 5 / 6;

/** `3D-SPEC §3`'s hard floor. A surface tighter than this ships a visible hard edge. */
const MIN_BEVEL = 0.02;

/**
 * Radius of curvature of a quintic turn of `depth` over `span`, at the point where the
 * curvature is worst. `R = (1 + z'^2)^1.5 / |z''|` with `z' = S' * depth / span` and
 * `z'' = S'' * depth / span^2`.
 */
export function turnRadius(depth: number, span: number): number {
  const d1 = (Q_D1_AT_D2_PEAK * depth) / span;
  const d2 = (Q_D2_PEAK * depth) / (span * span);
  return Math.pow(1 + d1 * d1, 1.5) / d2;
}

/**
 * Grid grading.
 *
 * The flat wall outside the opening is planar and needs almost nothing; everything is spent
 * on the two turns. `REVEAL_CELLS` is set from a measurement rather than a feel: at 12 the
 * worst angle between two *adjacent vertex normals* anywhere on the built mesh was 25.8
 * degrees — the same resolution as a `roundedCylinder` at the low tier, which is fine for a
 * 2 cm puck and not fine for the surface that fills a quarter of this game's frame. At 18 it
 * is 17.4, for about 750 extra triangles on a mesh that totals ~4,000. Reported by
 * `scratchpad/verify/alcove-run.ts`, which builds the real geometry.
 */
const CELL_FLAT = 0.9;
const REVEAL_CELLS = 18;
const COVE_CELLS = 18;
const INTERIOR_CELLS = 26;
const CELL_BODY = 0.28;

/**
 * ---------------------------------------------------------------------------
 * Round 4 (B6.1): the recess had form, and it still had no *occupancy*
 * ---------------------------------------------------------------------------
 *
 * Round 3 gave the back wall a dish and a cove and re-measured the result as a 10.6 %
 * horizontal sweep and a 0.155 -> 0.095 -> 0.165 vertical one. Both are real, and both are
 * **low-frequency**: they are one gradient across 900 screen pixels. Round 4 measured what a
 * child actually sees on it — luminance mean 83.9, sigma **1.77**, full range 79-90, and
 * high-frequency energy sigma **0.628** against 5.434 on the basket in the same frame, over
 * a surface holding **22.6 % of the play area**. A single smooth gradient over a fifth of the
 * picture is, to the eye, a flat slab; the grain the clay shader binds at 0.11-0.14 cannot
 * rescue it, because a normal-map wobble on a camera-facing plane at this albedo is worth
 * about one code (see `3D-SPEC §3`'s own strength band and A14).
 *
 * What was missing is not contrast, it is *stuff*. The recess is now **fluted**: a run of
 * rounded vertical ribs, `RIB_DEPTH` peak-to-trough, that the 47.6-degree key rakes across —
 * so the wall carries a real high-frequency signal made of geometry rather than of texture,
 * and it reads as a pressed clay chute rather than as paint.
 *
 * Three properties are load-bearing and all three are arithmetic, not taste:
 *
 *  - **It cannot ship a hard edge.** A rib is `A cos(k x)`; its tightest radius of curvature
 *    is `1 / (A k^2)` at the crest, and `buildAlcove` asserts it against the same 0.02 floor
 *    the reveal and the cove are asserted against. At the shipped depth and pitch that is
 *    **0.097 units**, five times the floor.
 *  - **It is sampled properly.** A rib carried on three grid columns is a triangle, not a
 *    rib. `INTERIOR_CELLS` is raised to `RIB_SAMPLES` per rib, so the crest and both flanks
 *    always have vertices, and the mesh's own normals do the rounding.
 *  - **It rides the openness, not the geometry.** The rib term is multiplied into
 *    `zInterior`, which the field already fades by `s`, so it is full depth in the recess,
 *    half in the throat of the cove and exactly zero on the flat wall face and at the arris
 *    of the reveal. The surface stays C2 where round 3 made it C2.
 */
/** Peak-to-trough relief of a rib. `3D-SPEC` wants form you can read; B6.1 asked for 0.15-0.25. */
const RIB_DEPTH = 0.2;
/** Target rib pitch in world units — 6 cm, a thumb's width of pressed clay. */
const RIB_PITCH = 0.62;
/** Grid columns per rib. Below about six a cosine samples as a zig-zag. */
const RIB_SAMPLES = 8;
const RIB_MIN = 5;
const RIB_MAX = 21;

/**
 * How many ribs the opening gets, always odd so one sits on the centre line and the two
 * reveals are symmetric.
 */
export function ribCount(openHalfX: number): number {
  const raw = Math.round((openHalfX * 2) / RIB_PITCH);
  const odd = raw % 2 === 0 ? raw + 1 : raw;
  return odd < RIB_MIN ? RIB_MIN : odd > RIB_MAX ? RIB_MAX : odd;
}

/** Tightest radius of curvature anywhere on a rib run of `n` ribs across `openHalfX`. */
export function ribRadius(openHalfX: number, n: number): number {
  const a = RIB_DEPTH / 2;
  const k = (Math.PI * n) / openHalfX;
  return 1 / (a * k * k);
}

/**
 * Where, along the turn, the ivory of the wall face gives way to the accent of the recess.
 *
 * A painted alcove has its paint line a little way *inside* the reveal, not on the arris, so
 * the opening keeps a pale lit lip. `s` here is the openness, so the band is placed early in
 * the turn — by the time the surface is 30 % of the way in, it is the accent — which matters
 * because the coved soffit never gets past `s = 0.5` at its steepest and must still be
 * painted.
 *
 * This is the direct answer to the one-pixel `(138,129,116) -> (127,88,59)` transition round
 * 3 measured at the wing junction: the same step is now a quintic ramp spread across roughly
 * four grid columns of a twelve-column reveal — **0.084 world units, ~11 screen px at design
 * framing** — over a surface that is itself turning, with `bakeCurvatureAO` darkening the
 * concave end of it.
 */
const PAINT_LOW = 0.03;
const PAINT_HIGH = 0.3;

/**
 * How far the recess is lifted from `ALCOVE_DEEP` toward `ALCOVE_MAIN` *where the cove is
 * steepest*, and only there.
 *
 * The cove costs the surface all of the key — at its 54.4-degree steepest the wrapped `N.L`
 * reaches **-0.293** and the clay keeps nothing but the environment — so an unlifted albedo
 * renders a near-black band across the head of the alcove, which is the other way to fail
 * the same rubric line. The lift is therefore driven by the cove's own slope
 * (`16 p^2 (1-p)^2`, which is `S'(p)` normalised to peak at 1), not by height: it is full
 * exactly where the light is gone and zero at both ends of the cove, where the light is back.
 *
 * Round 4 re-measured the whole thing on rendered pixels rather than on stations, over the
 * **97,608-pixel** patch of back wall the audit measured (`scratchpad/tr/alcove.mjs`, which
 * builds the real geometry and rasterises it through the same wrapped-diffuse response), and
 * lowered the lift from 0.55 to 0.28 on the evidence: at 0.55 the lift cancelled most of the
 * cove's own darkening and the alcove's top-to-bottom sweep fell to 5 levels. At 0.28 the cove
 * throat renders at **56.7 against the back wall's 72.7 — a 16.0-level sweep** at both the
 * desktop and the phone framing, which is the number B6.1 asked for, and the throat is nowhere
 * near black.
 */
const COVE_LIFT = 0.28;

/**
 * The recess's two tones, and the one place this game's accent family is declared.
 *
 * **A15.** The registry entry is `red` (`src/games/index.ts`) and the shell paints the pill,
 * the score chip and the celebration in it; the recess was `coral`, and it is 22.6 % of the
 * play area, so 76.9 % of this game's saturated pixels classified nearest coral. A child saw
 * a coral pill 250 px above a red world. `scene.tsx` now audits every accent hex it ships
 * against `GAMES["tooth-rescue"].accent` in DEV with `auditSceneAccents`, so this cannot drift
 * back silently.
 *
 * **Why `deep` and not something lighter.** B6.1 asked for the recess to be dropped toward
 * `coral.soft` and for "form, not saturation" to carry the separation from the ivory teeth.
 * The first half of that is now true — the fluting above is the form — but the token move
 * cannot be taken, and the arithmetic is the same arithmetic the alcove was built from. A
 * falling tooth renders at relative luminance **0.663**. Against `red.soft` (albedo L 0.7457)
 * that is **1.11:1**; against the cream shelf it was 1.09-1.22:1, which is the invisibility
 * this whole surface exists to fix. Against `red.deep` (0.1253) it is **4.08:1** — better than
 * the 3.33:1 `coral.deep` was giving, because red.deep is the darkest tone in the palette
 * after `rose.deep`. So the recess keeps a deep tone and spends the audit's point on relief
 * instead, which is where the measurement said the failure was.
 */
/**
 * The recess base is the red family **at the luminance the contrast solve already required**,
 * which is what makes this a family change rather than a mood change. `red.deep` alone is
 * L\* 42.0 against `coral.deep`'s 47.6 — five and a half points darker across 22.6 % of the
 * play area — and `red.main` is L\* 54.3, which puts a falling tooth at **2.63:1**. Mixed
 * 42 % of the way from one to the other:
 *
 * | tone | hex | L\* | C\* | hue | vs a tooth at 0.663 |
 * |---|---|---|---|---|---|
 * | `coral.deep` (shipped) | `#c74430` | 47.6 | 64.8 | 38.1 | 3.32:1 |
 * | **this** | `#d22f37` | **47.0** | 72.0 | **30.0** | **3.39:1** |
 * | `red.deep` | `#c21e25` | 42.0 | 73.4 | 33.0 | 4.08:1 |
 * | `red.main` | `#e8474f` | 54.3 | 69.7 | 27.1 | 2.63:1 |
 *
 * Same lightness to within 0.6 L\*, a hue that `classifyAccent` puts in `red` rather than
 * `coral`, and marginally *more* separation from the subject than what shipped. An
 * off-token mix rather than a token is the same mechanism the cove lift below already uses,
 * and it is the only way to hold both the family and the luminance at once.
 */
const RECESS_LIFT = 0.42;
/** sRGB mix of two brand tones, so the result is a real quotable hex rather than a shader term. */
function mixHex(a: string, b: string, t: number): string {
  let out = "#";
  for (let i = 1; i < 7; i += 2) {
    const av = parseInt(a.slice(i, i + 2), 16);
    const bv = parseInt(b.slice(i, i + 2), 16);
    out += Math.round(av + (bv - av) * t)
      .toString(16)
      .padStart(2, "0");
  }
  return out;
}
export const ALCOVE_DEEP = mixHex(ACCENTS.red.deep, ACCENTS.red.main, RECESS_LIFT);
export const ALCOVE_MAIN = ACCENTS.red.main;
export const ALCOVE_HEXES: readonly string[] = [ALCOVE_DEEP, ALCOVE_MAIN];


/**
 * The accent rail's own shadow, painted into the shell's albedo.
 *
 * **B6.9** filed the rail as "a 690x8 px capsule of uniform `#dd3c3d` with one specular
 * streak, no grain and no wear, casting no shadow on the wall behind it", and asked for a cast
 * shadow. It cannot have one, and the arithmetic is the same arithmetic that keeps the set
 * from casting at all (see the header). `Rig` centres an orthographic shadow camera on the
 * origin with a half-width of `shadowArea / 2`, and the rail's **centre** sits **3.52-3.58
 * units** from that camera's axis while its **ends** sit at **4.90**. The frustum's half-width
 * is 3.5 at the phone's `shadowArea` of 7 and 4.1 at the desktop's 8.2: the rail is outside it
 * at every viewport, and its ends are outside it by a third. Reaching them needs
 * `shadowArea >= 9.8`, which on the low tier's 512 map drops the basket and every falling
 * tooth from 73 to 52 texels per unit — a 29 % loss on the only casters whose shadow a child
 * ever looks at, to shadow a bar at the top of the frame.
 *
 * So the shadow is *solved* rather than rendered, which the geometry makes exact: the rail is
 * an axis-aligned bar of known extent on a known plane, and the key is one direction. For each
 * vertex of the shell, march toward the key until the ray reaches the rail's front plane; if
 * it lands inside the bar, that vertex is occluded. `RAIL_SHADOW_REACH` stops the march before
 * the deep recess, where a real shadow would be swallowed by the alcove's own darkness anyway
 * and where the grid is too coarse to draw its edge.
 *
 * At the shipped geometry the rail's front face stands 0.08 units proud of the wall face, so
 * the umbra on that face is **0.115 units tall and offset 0.085 toward +x** — a real contact
 * gradient at the join, which is what the item is actually about.
 */
const RAIL_FRONT_Z = FRAME_Z + (FRAME_T + 0.16) / 2;
const KEY = [-0.5187, 0.7018, 0.4882] as const;
/** How far along the ray the march is allowed to go, in world units. */
const RAIL_SHADOW_REACH = 0.62;
/** How dark the umbra is, and the softness of its edge. */
const RAIL_SHADOW = 0.34;
const RAIL_SHADOW_SOFT = 0.07;

/** 0 = lit, 1 = full umbra, for a point on the shell under the accent rail. */
function railShadow(x: number, y: number, z: number, openTop: number, railHalf: number): number {
  const t = (RAIL_FRONT_Z - z) / KEY[2];
  if (t <= 0 || t > RAIL_SHADOW_REACH) return 0;
  const xs = x + KEY[0] * t;
  const ys = y + KEY[1] * t;
  if (Math.abs(xs) > railHalf) return 0;
  const bottom = openTop - 0.02;
  const top = bottom + RAIL_H;
  if (ys > top + RAIL_SHADOW_SOFT) return 0;
  // Soft on the way in at the bar's lower edge, which is the edge a child sees.
  if (ys >= bottom) return 1;
  return qstep(1 - (bottom - ys) / RAIL_SHADOW_SOFT);
}

export type AlcoveSpec = {
  /** Half-width of the whole shell. Must already be outside the frame at every viewport. */
  halfX: number;
  /** Bottom edge, buried below the shelf, and top edge, above the frame. */
  bottom: number;
  top: number;
  /** Half-width and head of the opening. */
  openHalfX: number;
  openTop: number;
  /** Height of the coved soffit — `layout.ts: nicheCoveSpan`. */
  coveSpan: number;
};

/** Graded sample list: `[a, b]` split into `n` cells, appending b but never a. */
function pushSpan(out: number[], a: number, b: number, n: number): void {
  for (let i = 1; i <= n; i++) out.push(a + ((b - a) * i) / n);
}

/**
 * Builds the alcove. The caller owns the result and must dispose it: it carries a private
 * albedo attribute, so it is never a `cachedGeometry()` entry.
 */
export function buildAlcove(spec: AlcoveSpec): BufferGeometry {
  const { halfX, bottom, top, openHalfX, openTop, coveSpan } = spec;
  const fillet = NICHE_SIDE_FILLET;
  const depth = NICHE_MOUTH_Z - NICHE_BACK_Z;
  const dish = nicheDish(openHalfX);

  const ribs = ribCount(openHalfX);
  const ribK = (Math.PI * ribs) / openHalfX;

  if (import.meta.env.DEV) {
    const rSide = turnRadius(depth, fillet);
    const rCove = turnRadius(depth, coveSpan);
    const rRib = ribRadius(openHalfX, ribs);
    if (rSide < MIN_BEVEL || rCove < MIN_BEVEL || rRib < MIN_BEVEL) {
      console.error(
        `[tooth-rescue/set] the alcove turns tighter than 3D-SPEC §3's ${MIN_BEVEL}-unit ` +
          `minimum: reveal radius ${rSide.toFixed(4)}, cove radius ${rCove.toFixed(4)}, ` +
          `rib radius ${rRib.toFixed(4)}. Widen NICHE_SIDE_FILLET, nicheCoveSpan or RIB_PITCH.`
      );
    }
  }

  /* ---- graded sample grids ---- */

  const inner = Math.max(0.05, openHalfX - fillet / 2);
  const outer = Math.min(halfX - 0.05, openHalfX + fillet / 2);
  const xs: number[] = [-halfX];
  pushSpan(xs, -halfX, -outer, Math.max(1, Math.round((halfX - outer) / CELL_FLAT)));
  pushSpan(xs, -outer, -inner, REVEAL_CELLS);
  // The recess is sampled at `RIB_SAMPLES` columns per rib, so a rib is always a curve on
  // the mesh rather than a zig-zag between three vertices.
  pushSpan(xs, -inner, inner, Math.max(INTERIOR_CELLS, ribs * RIB_SAMPLES));
  pushSpan(xs, inner, outer, REVEAL_CELLS);
  pushSpan(xs, outer, halfX, Math.max(1, Math.round((halfX - outer) / CELL_FLAT)));

  const coveFoot = openTop - coveSpan;
  const ys: number[] = [bottom];
  pushSpan(ys, bottom, coveFoot, Math.max(2, Math.round((coveFoot - bottom) / CELL_BODY)));
  pushSpan(ys, coveFoot, openTop, COVE_CELLS);
  // The rail's shadow band sits immediately above the opening on the flat wall face, where
  // `CELL_FLAT` alone would carry it on one row. Six rows over `RAIL_SHADOW_REACH` is enough
  // for its soft lower edge to be a gradient rather than a step.
  const railBand = Math.min(RAIL_SHADOW_REACH, Math.max(0.05, top - openTop));
  pushSpan(ys, openTop, openTop + railBand, 6);
  pushSpan(ys, openTop + railBand, top, Math.max(1, Math.round((top - openTop - railBand) / CELL_FLAT)));

  const nx = xs.length;
  const ny = ys.length;
  const count = nx * ny;

  /* ---- the field ---- */

  const pos = new Float32Array(count * 3);
  const uv = new Float32Array(count * 2);
  const albedo = new Float32Array(count * 3);

  const ivory = color(CLAY.ivoryDeep);
  // A15: the registry says this game is `red`, and the largest surface in its frame was
  // `coral` — 76.9 % of Tooth Rescue's saturated pixels classified nearest coral against a
  // coral difficulty pill 250 px above a red mat. The recess is the game's accent surface, so
  // it is the game's accent. See `ALCOVE_HEXES` and the DEV audit in `scene.tsx`.
  const deep = color(ALCOVE_DEEP);
  const main = color(ALCOVE_MAIN);
  // Pre-mixed once: the lifted recess colour at the top of the cove.
  const lit = new Color(
    deep.r + (main.r - deep.r) * COVE_LIFT,
    deep.g + (main.g - deep.g) * COVE_LIFT,
    deep.b + (main.b - deep.b) * COVE_LIFT
  );

  for (let j = 0; j < ny; j++) {
    const y = ys[j];
    // 1 well below the head of the alcove, 0 at and above it.
    const p = (openTop - y) / coveSpan;
    const sy = qstep(p);
    // `S'(p)` normalised to peak at 1: the lift tracks the cove's slope, so it is full at
    // the 51.6-degree steepest — where the key is gone — and zero at both ends.
    const q = p < 0 || p > 1 ? 0 : 16 * p * p * (1 - p) * (1 - p);
    const rr = deep.r + (lit.r - deep.r) * q;
    const gg = deep.g + (lit.g - deep.g) * q;
    const bb = deep.b + (lit.b - deep.b) * q;

    for (let i = 0; i < nx; i++) {
      const x = xs[i];
      const sx = qstep((openHalfX + fillet / 2 - Math.abs(x)) / fillet);
      const s = sx * sy;

      const u = Math.min(1, Math.abs(x) / openHalfX);
      // Fluting, centred on its own mean so the recess keeps the depth the dish solved for:
      // the crest stands `RIB_DEPTH / 2` proud of the nominal back and the valley the same
      // amount behind it. `s` fades the whole term out through the reveal, so the flat wall
      // face and the arris are untouched.
      const rib = (RIB_DEPTH / 2) * Math.cos(ribK * x);
      const zInterior = NICHE_BACK_Z + dish * u * u + rib;
      const z = NICHE_MOUTH_Z + s * (zInterior - NICHE_MOUTH_Z);

      const o = (j * nx + i) * 3;
      pos[o] = x;
      pos[o + 1] = y;
      pos[o + 2] = z;

      const paint = qstep((s - PAINT_LOW) / (PAINT_HIGH - PAINT_LOW));
      // The accent rail's own contact shadow. See `railShadow`.
      const shade = 1 - RAIL_SHADOW * railShadow(x, y, z, openTop, openHalfX + 0.21);
      albedo[o] = (ivory.r + (rr - ivory.r) * paint) * shade;
      albedo[o + 1] = (ivory.g + (gg - ivory.g) * paint) * shade;
      albedo[o + 2] = (ivory.b + (bb - ivory.b) * paint) * shade;

      const k = (j * nx + i) * 2;
      uv[k] = (x * UV_U[0] + y * UV_U[1] + z * UV_U[2]) * UV_SCALE;
      uv[k + 1] = (x * UV_V[0] + y * UV_V[1] + z * UV_V[2]) * UV_SCALE;
    }
  }

  /* ---- one indexed strip mesh, wound to face +Z ---- */

  const quads = (nx - 1) * (ny - 1);
  // Keyed on the largest *value* an index can hold, not on how many of them there are.
  const index = count > 65535 ? new Uint32Array(quads * 6) : new Uint16Array(quads * 6);
  let w = 0;
  for (let j = 0; j + 1 < ny; j++) {
    for (let i = 0; i + 1 < nx; i++) {
      const a = j * nx + i;
      const b = a + 1;
      const c = a + nx;
      const d = c + 1;
      // Counter-clockwise seen from +Z, which is where the camera is.
      index[w++] = a;
      index[w++] = b;
      index[w++] = d;
      index[w++] = a;
      index[w++] = d;
      index[w++] = c;
    }
  }

  const geo = new BufferGeometry();
  geo.setAttribute("position", new BufferAttribute(pos, 3));
  geo.setAttribute("uv", new BufferAttribute(uv, 2));
  geo.setIndex(new BufferAttribute(index, 1));
  // Smooth normals across the whole field, so the reveal and the cove read as one turning
  // surface rather than as facets.
  geo.computeVertexNormals();
  // Signed curvature into `color` — this is what darkens the back of the reveal and the
  // throat of the cove, and lifts the lip of the opening. It is the substitute for the cast
  // shadow the key's direction cannot supply; see the header.
  bakeCurvatureAO(geo);
  geo.setAttribute(ALBEDO_ATTRIBUTE, vertexAlbedoAttribute(albedo));
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}
