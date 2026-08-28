/**
 * Maze Escape — the two geometries a maze owns.
 *
 * A fresh maze every run means fresh geometry every run, so this file is written around
 * one rule: **everything it returns is disposable and is disposed.** Nothing here goes
 * through `cachedGeometry` / `beveledExtrude`, because those `markShared` their result and
 * keep it forever — nine restarts would leave nine maze blocks pinned in the shared cache
 * with no way to reach them. `buildMazeGeometry` allocates, `disposeMazeGeometry` frees,
 * and `scene.tsx` pairs them on the same `useMemo` identity.
 *
 * ## The gum block
 *
 * The corridors are **carved**, not assembled. The whole block is a single extrusion of one
 * `Shape` whose outer boundary is the rounded board outline and whose hole is the traced,
 * filleted outline of the carved region (`maze.ts`). That buys three things a grid of
 * instanced wall blocks cannot:
 *
 *   • one draw call and one silhouette, with no seam or groove where two wall cells meet;
 *   • a real bevel that runs continuously around every corridor — three's extrusion holds
 *     the contour at the top face and swells it outward through the middle, so the hole is
 *     widest at the top and the wall's inner lip rolls over as a quarter-round;
 *   • curvature AO baked across the *whole* block, so a corridor corner is darker than a
 *     corridor wall because it genuinely is more enclosed, not because it was told to be.
 *
 * The lower bevel is sunk below the corridor floor (`wallSink`) so the wall meets the ivory
 * at its full width, with no undercut gap at the base.
 *
 * ## The corridor floor
 *
 * A generated grid with per-vertex occlusion accumulated from every nearby wall cell —
 * which is what makes corners pool warm-dark instead of every wall casting the same flat
 * band — plus the toothbrush's alcove dish pressed into it and a hand-pressed micro relief.
 * Quads buried under solid gum are dropped from the index rather than drawn and covered.
 */
import { BufferAttribute, BufferGeometry, ExtrudeGeometry, Path, Shape, Vector2 } from "three";
import { mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { bakeCurvatureAO } from "../../three/geometry";
import { getQuality } from "../../three/quality";
import { fbm2 } from "../../three/textures";
import {
  ALCOVE,
  DISH_RADIUS,
  FLOOR_Y,
  GOAL_OFFSET,
  boardCorner,
  cellSize,
  dishDepth,
  gumOuter,
  wallBevel,
  wallHeight,
  wallSink,
  wallSwell,
  MIN_BEVEL,
  RING_TUBE,
  TOOTH_HEIGHT_CELLS,
  bayClear,
  corridorClear,
  goalPadRadius,
  startRingMajor,
} from "./layout";
import {
  carveAlcove,
  corridorLoops,
  filletLoop,
  mergeCollinear,
  offsetLoop,
  reverseLoop,
  signedArea,
  type Cell,
} from "./maze";

/**
 * The same affine UV basis `geometry.ts` uses for every shared prop, repeated here because
 * its `finish()` pass is private. Continuous everywhere (a box projection would print a
 * smear line down the middle of a long wall), tuned so no axis-aligned face collapses to a
 * degenerate tangent frame. Grain repeats roughly every half world unit.
 */
const UV_U = [0.904, 0.362, 0.226] as const;
const UV_V = [0.218, 0.873, -0.436] as const;
const UV_SCALE = 2;
const WELD_EPS = 1e-4;

/** Fillet radius for a corridor corner, in cells. Clamped per-corner inside `filletLoop`. */
const CORNER_FILLET = 0.3;

export type MazeGeometry = {
  gum: BufferGeometry;
  floor: BufferGeometry;
};

/* ------------------------------------------------------------------ */
/* Finishing pass (owned, disposable twin of geometry.ts's `finish`)   */
/* ------------------------------------------------------------------ */

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
 * Flips winding when a closed solid came out inside-out.
 *
 * `ExtrudeGeometry` normalises the winding of the shape and its holes internally, and the
 * `rotateX` that lays the block flat is a mirror-free rotation, so in principle the result
 * is already outward. In principle is not good enough: a silently inverted block renders
 * black under the studio rig and nothing in the console says why. Signed volume is an
 * objective check that costs one pass over the index.
 */
function ensureOutward(geo: BufferGeometry): void {
  const index = geo.getIndex();
  const posAttr = geo.getAttribute("position");
  if (!index || !posAttr) return;
  const p = posAttr.array as ArrayLike<number>;
  const ia = index.array as ArrayLike<number>;

  let volume = 0;
  for (let t = 0; t < ia.length; t += 3) {
    const a = ia[t] * 3;
    const b = ia[t + 1] * 3;
    const c = ia[t + 2] * 3;
    volume +=
      p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) -
      p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) +
      p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  if (volume >= 0) return;

  const flipped = new Uint32Array(ia.length);
  for (let t = 0; t < ia.length; t += 3) {
    flipped[t] = ia[t];
    flipped[t + 1] = ia[t + 2];
    flipped[t + 2] = ia[t + 1];
  }
  geo.setIndex(new BufferAttribute(flipped, 1));
}

function applyPlanarUV(geo: BufferGeometry): void {
  const posAttr = geo.getAttribute("position");
  if (!posAttr) return;
  const p = posAttr.array as ArrayLike<number>;
  const count = posAttr.count;
  const uv = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    const x = p[i * 3];
    const y = p[i * 3 + 1];
    const z = p[i * 3 + 2];
    uv[i * 2] = (x * UV_U[0] + y * UV_U[1] + z * UV_U[2]) * UV_SCALE;
    uv[i * 2 + 1] = (x * UV_V[0] + y * UV_V[1] + z * UV_V[2]) * UV_SCALE;
  }
  geo.setAttribute("uv", new BufferAttribute(uv, 2));
}

/* ------------------------------------------------------------------ */
/* Wall-top relief                                                     */
/* ------------------------------------------------------------------ */

/** A vertex within this of the wall top is part of the flat cap. */
const TOP_EPS = 1e-4;
/**
 * Peak hand-press relief on the wall tops, as a fraction of the wall's height, and its
 * lump frequency in lumps per world unit.
 *
 * Solved rather than dialled. The measured defect (`3.2 G-ME-3`) was σ = 1.09 / 0.70 / 0.78
 * out of 255 across 8,000 px of coral wall top — the largest surface in the frame, and flat
 * to within half a code value. The dominant term in what a lit clay surface *does* vary by
 * is not its baked occlusion, it is the tilt of its normal: under the studio key, which
 * strikes an up-facing surface at about 40° off its normal, tilting that normal by θ moves
 * the diffuse term by sin(40°)·tan(θ). A relief of amplitude `a` at wavelength `λ` has a
 * peak slope of 2πa/λ ≈ 2a/λ for fbm's roughly triangular profile.
 *
 * At `a` = 0.04 of a 0.23-unit wall (0.0093 units) and `λ` = 0.24 units, that slope is
 * 0.077 — a 4.4° tilt, worth about ±5 code values. The three fbm octaves are self-similar
 * in slope, so the finer lumps carry the same tilt at a fifth of the size and there is no
 * scale at which the surface goes flat again. It is far too little to disturb the
 * silhouette (±1.5 px) and just enough that the top of a gum wall stops reading as poured
 * plastic.
 *
 * It also gives `bakeCurvatureAO` something to bite on, which on a mathematically flat
 * plateau it cannot have: signed mean curvature there is identically zero, so every AO term
 * the spec asks for was being computed and coming back as exactly 1.0.
 *
 * **Round 3 re-measured this on the shipped mesh and the paragraph above was describing a
 * relief that was never there.** Three things were wrong, and only the third was a number:
 *
 *  1. `(fbm2(...) − 0.5) × 2` is not a ±1 signed field. `textures.ts` returns
 *     `clamp01(fbmTiled × 0.7 + 0.5)` and never promised otherwise; measured over this
 *     game's own sample domain at all three pitches it has **rms 0.198 and p99.5 0.472**
 *     (`scratchpad/verify/maze-fbm.mjs`). So `amount` was delivering 20 % of its stated
 *     value in the body of the surface and 47 % at its loudest. `RELIEF_GAIN` below fixes
 *     that at the source instead of by inflating `WALL_RELIEF` until it looks right.
 *  2. The rim ramp was counted in **subdivision hops**, and the cap's triangles are not all
 *     the same size, so on a wall top only 0.33 units wide between its bevels most of the
 *     surface was inside a two-edge ramp. Measured on the finished 9-cell block, **67 % of
 *     plateau vertices moved by less than a tenth of the amplitude**. `WALL_RELIEF_RAMP`
 *     replaces it with a metric one.
 *  3. The worked example quoted a 0.19-unit wall and a 0.2-unit wavelength; `wallHeight(9)`
 *     is 0.2322 and the wavelength is `cell / WALL_RELIEF_LUMPS` = 0.2445. Corrected above.
 *
 * Measured after all three, on the vertices the relief actually moves, at 9 / 11 / 13 cells
 * (`scratchpad/verify/maze-relief.mjs`): displacement reaching the full ±amplitude with an
 * rms of 0.43 of it, plateau normals at a mean **8.6°** off vertical against 0° before, and
 * a red-channel albedo spread of **σ 4.4–6.0** code values against the round-3 render's 1.09.
 */
const WALL_RELIEF = 0.04;
/**
 * Turns `fbm2`'s output into the ±1 signed field the relief maths assumes.
 *
 * `1 / p99.5` of the measured distribution (0.4724 / 0.4742 / 0.4717 at 9 / 11 / 13 cells),
 * so `WALL_RELIEF` is now literally the peak displacement rather than five times it. The
 * 0.5 % of samples past ±1 are clamped rather than allowed to spike a single vertex.
 */
const RELIEF_GAIN = 2.118;
/**
 * The wall-top height field, in [-1, 1]. One definition, read by both the displacement and
 * the analytic normal, so the two can never describe different surfaces.
 */
const reliefAt = (x: number, z: number, frequency: number): number => {
  const signed = (fbm2(x * frequency + 5.7, z * frequency - 2.9, 3) - 0.5) * 2 * RELIEF_GAIN;
  return signed > 1 ? 1 : signed < -1 ? -1 : signed;
};
/**
 * Lumps per **cell**, not per world unit.
 *
 * Slope — which is what the eye actually reads — is amplitude over wavelength, and the
 * amplitude here is a fraction of the wall, which is a fraction of the cell. Pinning the
 * wavelength to world units instead therefore made the effect fade as the maze got harder:
 * measured, σ on the red channel ran 4.15 / 3.06 / 2.48 code values across 9 / 11 / 13
 * cells. Tying both ends of the ratio to the cell holds it at ~3 everywhere, which is what
 * "the same board, at three pitches" is supposed to mean.
 */
const WALL_RELIEF_LUMPS = 1.727;
/**
 * Width of the ramp that carries the relief away from the frozen rim, in cells.
 *
 * The rim of the cap is shared with the top row of the extrusion's bevel and may not move,
 * or the block cracks open along the T-junctions the subdivision creates. So the amplitude
 * has to reach full strength over some distance, and this is that distance — measured in
 * world units along the surface, not in edges (see the relaxation in `reliefTopCap`).
 *
 * 0.15 of a cell leaves the middle 55 % of a wall top at full amplitude: the strip is
 * `cell - 2 x wallBevel` = 0.79 of a cell wide at 9 cells, and the ramp takes 0.15 off each
 * side. The ramp's own peak slope is `1.5 x amount / ramp` = `1.5 x 0.022 / 0.15` = 0.22,
 * a 12.4 deg tilt, which is the same order as the relief it is ramping in and therefore
 * invisible as a rim — and it is the same number at 9, 11 and 13 cells because both ends of
 * that ratio are fractions of the cell.
 */
const WALL_RELIEF_RAMP = 0.15;
/**
 * Below this fraction of the cap's mean triangle area, a cap triangle is a triangulator
 * needle rather than surface, and is dropped before the relief is pressed in. A thousandth
 * is three orders below the smallest honest triangle the earcut produces here and two above
 * the largest needle it produces; the gap it leaves is the needle's own width, ~1.5e-6
 * units, which is a ten-thousandth of a shadow-map texel.
 */
const NEEDLE_FRACTION = 1e-3;
/**
 * Ceiling on the refined cap. A real budget, and the only thing that can stop the refinement
 * short of its target.
 *
 * Re-derived, because the quantity it bounds changed. It used to read 8,000 and mean "two
 * uniform subdivision levels for a cap half again as dense as any measured"; the refinement
 * below is driven by the relief's own wavelength instead, so the ceiling is now set from what
 * that actually converges to. Measured over sixty generated boards per pitch
 * (`scratchpad/verify/me-seam.mjs` and `/tmp/cap.mjs`): mean 3,610 / 4,798 / 8,355 triangles
 * and worst 4,063 / 5,371 / **9,408** at 9 / 11 / 13 cells. 14,000 is 1.49x the worst board
 * ever measured, so it never binds on a maze this game can generate, and it still bounds a
 * pathological one — which is the only job a ceiling has.
 */
const MAX_TOP_TRIANGLES = 14000;
/**
 * Longest cap edge the relief may be sampled across, in wavelengths of the relief itself.
 *
 * ## The defect this exists for (ME4)
 *
 * `fieldNormals` writes the *exact* height-field normal at every interior cap vertex. What
 * the child sees is the shader's barycentric interpolation of those normals across a
 * triangle — and `ExtrudeGeometry` earcuts a polygon with up to sixty holes, so the cap it
 * returns contains triangles whose longest edge is measured in *units* while the relief's
 * wavelength is a quarter of a cell. Interpolating between two uncorrelated samples of the
 * field gives a smooth ramp inside the triangle and a **slope discontinuity at its edges** —
 * which is a straight ruled line across hand-pressed clay, §0's "no hard edge anywhere",
 * photographed in `maze-escape-tier-low.png` and `crop/tab_seam.png`.
 *
 * Uniform 1-to-4 subdivision could not fix it, because it keeps a needle *similar to
 * itself*: two levels take a 3.0-unit edge to 0.75 and no further. Measured on the shipped
 * build (`scratchpad/verify/me-seam.mjs`, which re-derives the field from the two published
 * constants and checks itself against a control error of 0.000 deg at every vertex):
 *
 * | | shipped (2 uniform levels) | now |
 * |---|---|---|
 * | plateau edge length, p95, 9 cells | 0.799 u = **1.89 cells** | 0.244 u = 0.58 cells |
 * | plateau edge length, p95, 13 cells | 0.793 u = **2.71 cells** | 0.188 u = 0.64 cells |
 * | interpolated-normal error, median | 5.7 deg | 4.1 deg |
 * | interpolated-normal error, p95 | 21.6 deg | 9.7–10.0 deg |
 * | interpolated-normal error, worst | 50.5 deg | 17.4–19.9 deg |
 * | edge the worst error sits on | 0.310 u | 0.14–0.23 u |
 *
 * The script's `max` column is not in that table on purpose: it is dominated by the board's own
 * outer lip, a two-row quad strip around the perimeter that lands inside the relief band the
 * classifier uses. It is a rolled bevel along a straight edge, its normals come from the mesh
 * and are right, and it carries no relief — which is why the *error* columns, which is what a
 * child sees, do not move with it.
 *
 * ## Why one wavelength, and what is left
 *
 * An edge longer than the wavelength joins two samples the field has no correlation between,
 * so the chord cannot follow the lump at all and the discontinuity at the edge saturates at
 * the full normal swing. At one wavelength or less both endpoints sit inside the same lump
 * and the chord follows it. That is the boundary, and it is where the curve flattens: the
 * measured p95 error is 9.75 deg at one wavelength, 9.10 at three quarters and 7.37 at a
 * third — 24 % better for **4.1x the triangles and 5.3x the build time**.
 *
 * The residual is not a defect of the mesh, it is the arithmetic of linear interpolation: the
 * relief's own peak normal tilt is `atan(2*pi*a/lambda)` = 13.4 deg, and a sine sampled at one
 * wavelength departs from its chord by up to 0.43 of its amplitude, i.e. ~5.8 deg, with the
 * rest of the p95 coming from fbm's higher octaves. What matters is that the residual now
 * lives at the scale of the lumps — every slope change is inside 0.58 of a cell, ~40 screen
 * px at design framing, against the 500 px line it replaces — so it reads as the pressed
 * texture it was always meant to be rather than as a ruled edge.
 *
 * **Not tier-scaled.** A4's finding is that the tier the target device boots is the one nobody
 * art-directed, and the wall tops are ~45 % of this game's play area.
 */
const RELIEF_EDGE_WAVELENGTHS = 1;
/**
 * Tonal drift pressed into the wall tops along with the relief, as linear multipliers on
 * the crest and in the trough.
 *
 * This is §3's "crevices go warm-dark, exposed edges go slightly lighter and desaturated"
 * applied to the one surface in this game that needed it most: the wall tops are ~45 % of
 * the play area and round 3 measured them at σ = 1.09/255, i.e. one code value of variation
 * across the largest object on screen.
 *
 * The trough drops blue hardest and red least, which is the same warm-dark ramp
 * `buildFloor` already uses for its wall occlusion and the same direction `CLAY.crevice`
 * sits in from `CLAY.gum`. The crest raises blue and green more than red, which on a
 * red-dominant albedo *is* desaturation. Both are keyed to the relief's own height, so the
 * drift lands on the lumps rather than on noise of its own.
 *
 * Magnitudes are stated in linear light. Measured on the built geometry, over the plateau
 * vertices the relief moves, they combine with the curvature AO the relief now gives
 * `bakeCurvatureAO` to bite on and land the wall top's albedo at **p1 217.5 / mean 231.1 /
 * p99 238.4** on red at 9 cells against `CLAY.gum`'s own 232 — a 21-code spread where round
 * 3 measured σ = 1.09 over 8,000 px. 6 % of a wall's albedo is under the swing its own
 * shading takes across the 8.6° of normal tilt beside it, so it reads as clay, not as a
 * texture.
 */
const WEAR_CREST: readonly [number, number, number] = [0.06, 0.09, 0.11];
const WEAR_TROUGH: readonly [number, number, number] = [0.07, 0.09, 0.14];

/** Order-independent key for an edge. Safe while the vertex count stays under a million. */
const EDGE_STRIDE = 1e6;
const edgeKey = (a: number, b: number) => (a < b ? a * EDGE_STRIDE + b : b * EDGE_STRIDE + a);

/**
 * Subdivides the gum block's flat top cap and presses a hand relief into it.
 *
 * Runs on the welded, indexed geometry *before* normals, UVs and AO, so everything
 * downstream simply sees a richer mesh.
 *
 * The one hazard here is cracking the block open, and the whole design is arranged around
 * avoiding it. The cap's boundary is shared with the top row of the extrusion's bevel, which
 * is not ours to touch: so every vertex on that boundary — and every midpoint inserted along
 * it — is **frozen at its original height**. A frozen midpoint is exactly collinear with the
 * two ends of the bevel edge it sits on, so the T-junction it creates has no gap to leak
 * through. Interior vertices ramp in over `WALL_RELIEF_RAMP` of a cell, measured along the
 * surface.
 *
 * The second hazard is the triangulator's needles, and it is the reason this function hands
 * back a mask instead of just moving vertices. `ExtrudeGeometry` earcuts a polygon with one
 * contour and up to sixty holes; a few of the triangles it returns are collinear to within a
 * millionth of a unit, and many more are merely very long and thin — one measured 3.12 units
 * along and 1.4 mm across. 1-to-4 subdivision keeps a needle *similar to itself*, so its
 * width shrinks with every level while its length does too, and the field's own curvature
 * over a long edge (`sagitta ~ (2pi/lambda)^2 x amount x L^2 / 8`) then lands as a height
 * difference across a width that is orders of magnitude smaller. Measured on the shipped
 * level-2 cap the induced face tilts reached **77 deg**, and at level 3 **87 deg**.
 *
 * Two answers, and the geometry needs both:
 *
 *  • the genuinely degenerate ones are dropped, by planar area against the cap's own mean
 *    (`NEEDLE_FRACTION`) — 1 / 2 / 4 triangles carrying `2e-4 %` of the surface, so what is
 *    left behind is a slit ~1.5e-6 units wide (`scratchpad/verify/maze-sliver.mjs`);
 *  • the merely-thin ones are left in place and **shaded from the field rather than from the
 *    mesh**. The plateau is a height field, so its normal is known in closed form; every
 *    interior cap vertex takes `normalize(-dh/dx, 1, -dh/dz)` after `computeVertexNormals`
 *    has run (`fieldNormals` below). The shading is then exactly the amplitude-over-
 *    wavelength argument on `WALL_RELIEF` predicts, at any tessellation, and a needle can no
 *    longer vote on its neighbours' normals at all.
 *
 * Vertices shared with the bevel are excluded from that overwrite — their normal is the join
 * between two surfaces and only the mesh knows it — which is safe because the ramp holds the
 * field flat there anyway.
 */
export type TopRelief = {
  /** Cap vertex -> ramp mask, 0 at the frozen rim and 1 across the middle of a wall top. */
  mask: Map<number, number>;
  /** Cap vertices that also belong to a bevel triangle; their normals are left alone. */
  shared: Set<number>;
};

function reliefTopCap(
  geo: BufferGeometry,
  topY: number,
  amount: number,
  frequency: number,
  ramp: number
): TopRelief | null {
  const index = geo.getIndex();
  const posAttr = geo.getAttribute("position");
  if (!index || !posAttr || amount <= 0) return null;

  const pos: number[] = Array.from(posAttr.array as ArrayLike<number>);
  const src = index.array as ArrayLike<number>;
  const onTop = (v: number) => Math.abs(pos[v * 3 + 1] - topY) < TOP_EPS;

  let cap: number[] = [];
  const rest: number[] = [];
  for (let t = 0; t < src.length; t += 3) {
    const a = src[t];
    const b = src[t + 1];
    const c = src[t + 2];
    if (onTop(a) && onTop(b) && onTop(c)) cap.push(a, b, c);
    else rest.push(a, b, c);
  }
  if (cap.length === 0) return null;

  // Needles: collinear in the plane the relief is a height field over. Measured against the
  // cap's own mean area, so the threshold does not have to be re-picked per board size.
  const capArea = (t: number): number => {
    const a = cap[t] * 3;
    const b = cap[t + 1] * 3;
    const c = cap[t + 2] * 3;
    return Math.abs((pos[b] - pos[a]) * (pos[c + 2] - pos[a + 2]) - (pos[b + 2] - pos[a + 2]) * (pos[c] - pos[a])) / 2;
  };
  let capTotal = 0;
  for (let t = 0; t < cap.length; t += 3) capTotal += capArea(t);
  const needleFloor = (capTotal / (cap.length / 3)) * NEEDLE_FRACTION;
  const solid: number[] = [];
  for (let t = 0; t < cap.length; t += 3) {
    if (capArea(t) < needleFloor) continue;
    solid.push(cap[t], cap[t + 1], cap[t + 2]);
  }
  cap = solid;
  if (cap.length === 0) return null;

  // An edge of the cap that only one cap triangle owns is where the cap meets the bevel.
  const use = new Map<number, number>();
  const bump = (a: number, b: number) => {
    const k = edgeKey(a, b);
    use.set(k, (use.get(k) ?? 0) + 1);
  };
  for (let t = 0; t < cap.length; t += 3) {
    bump(cap[t], cap[t + 1]);
    bump(cap[t + 1], cap[t + 2]);
    bump(cap[t + 2], cap[t]);
  }
  /*
   * The rim is the set of cap edges the *bevel* owns from the other side, and "used exactly
   * once by a cap triangle" is not the same set.
   *
   * The needle drop above removes triangles from the cap, which exposes their neighbours'
   * edges: those become used-once too, deep in the middle of a wall top. Treating them as rim
   * froze them and — since the loop below never splits a rim edge — left interior edges up to
   * **1.4 units long** unrefined, which is exactly the ruled line this whole pass exists to
   * remove, surviving in the one place the needle drop had touched.
   *
   * An edge is only the rim if *both* of its ends belong to a triangle outside the cap. A slit
   * left by a dropped needle is 1.5e-6 units wide (`maze-sliver.mjs`) and both of its sides are
   * cap triangles sampling the same field at the same place, so displacing them keeps them
   * coincident and splitting one of them opens nothing: there is no counterpart to leave behind.
   */
  const restVerts = new Set<number>();
  for (const v of rest) restVerts.add(v);

  let border = new Set<number>();
  const frozen = new Set<number>();
  for (const [k, count] of use) {
    if (count !== 1) continue;
    const p = Math.floor(k / EDGE_STRIDE);
    const q = k % EDGE_STRIDE;
    if (!restVerts.has(p) || !restVerts.has(q)) continue;
    border.add(k);
    frozen.add(p);
    frozen.add(q);
  }

  /*
   * Length-driven conforming refinement — see `RELIEF_EDGE_FRACTION`.
   *
   * Each pass marks every edge longer than `target`, closes the marked set so that no
   * triangle is left with exactly two marked edges (promoting those to a full 1-to-4 split),
   * and then splits each triangle by how many of its edges are marked: three → four
   * triangles, one → two, none → left alone. The closure is what makes it **conforming**:
   * every inserted midpoint is inserted from both sides of its edge, so the cap never
   * acquires a T-junction and can never crack open — the same guarantee the uniform version
   * had, obtained the same way.
   *
   * A pass at least halves the longest edge of every triangle that has one, so the loop
   * terminates in `ceil(log2(longest / target))` passes; `MAX_PASSES` is a belt-and-braces
   * bound and `MAX_TOP_TRIANGLES` is the real one. The needle that motivated all of this —
   * 3.12 units along, 1.4 mm across — is bisected along its length rather than quartered, so
   * it costs 2 triangles a pass instead of 4, which is why the whole thing fits inside the
   * triangle budget the uniform build already spent.
   */
  const MAX_PASSES = 48;
  const target = RELIEF_EDGE_WAVELENGTHS / frequency;
  const target2 = target * target;
  const planarLen2 = (a: number, b: number) => {
    const dx = pos[a * 3] - pos[b * 3];
    const dz = pos[a * 3 + 2] - pos[b * 3 + 2];
    return dx * dx + dz * dz;
  };

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    /*
     * The rim is never split, and that is a fix rather than an omission. An edge the cap shares
     * with the bevel is owned on the other side by a triangle this pass does not touch, so a
     * midpoint inserted on it is referenced by cap triangles only — and `computeVertexNormals`,
     * which runs after this, then averages *only* cap faces there and writes `+Y`, while the
     * edge's two end vertices average cap and bevel together and come out rolled over. The rim's
     * normal ends up alternating rolled, flat, rolled along its own length: a crease exactly
     * where §3's lip is meant to be smoothest. The uniform subdivision this replaces had the
     * same defect and measured a **118.7 deg** turn between adjacent vertex normals over 180
     * boards; leaving the rim alone takes the worst turn to 99.5 deg, and every one of those is
     * now on the extrusion's own bevel band (buried at the base, or the 46 deg per segment a
     * three-segment 90 deg lip costs) rather than on the visible plateau.
     *
     * Nothing is lost by it: `WALL_RELIEF_RAMP` holds the field at zero for 0.15 of a cell
     * inside the rim, so a rim edge has no relief to sample in the first place.
     */
    const marked = new Set<number>();
    for (let t = 0; t < cap.length; t += 3) {
      const a = cap[t];
      const b = cap[t + 1];
      const c = cap[t + 2];
      // Only the *longest* edge, Rivara-style. Marking every over-long edge is a uniform
      // 1-to-4 in disguise: it quadruples the honest triangles to buy one bisection of the
      // needle, and the budget runs out before the needle is anywhere near the target.
      const lab = planarLen2(a, b);
      const lbc = planarLen2(b, c);
      const lca = planarLen2(c, a);
      /*
       * The longest edge that is not on the rim.
       *
       * Rim edges are skipped rather than the whole triangle: taking the longest edge and
       * bailing when it happens to be a rim edge leaves a triangle with a 1.4-unit interior
       * edge unrefined for the whole run, which is the ruled line this pass exists to remove
       * reappearing on the boards where the rim happens to be the longer side.
       */
      let longest = -1;
      let key = 0;
      const consider = (len2: number, k: number) => {
        if (len2 <= longest || len2 <= target2 || border.has(k)) return;
        longest = len2;
        key = k;
      };
      consider(lab, edgeKey(a, b));
      consider(lbc, edgeKey(b, c));
      consider(lca, edgeKey(c, a));
      if (longest < 0) continue;
      marked.add(key);
    }
    if (marked.size === 0) break;

    /*
     * No closure pass, and that is deliberate. Promoting a two-marked triangle to a full
     * 1-to-4 cascades: the third edge it takes is a neighbour's edge, which promotes that
     * neighbour, and on a connected cap it reaches nearly every triangle — measured at
     * `grown` ≈ 2 × the triangle count, i.e. a uniform subdivision wearing a length test.
     * Conformity does not need it. The marked set is *global and per-edge*, so a neighbour
     * across a marked edge sees the same mark and inserts the same midpoint; all that is
     * required is that every triangle handle one, two or three marks without leaving a
     * T-junction, which is what the three branches below do.
     */
    let grown = 0;
    for (let t = 0; t < cap.length; t += 3) {
      const count =
        (marked.has(edgeKey(cap[t], cap[t + 1])) ? 1 : 0) +
        (marked.has(edgeKey(cap[t + 1], cap[t + 2])) ? 1 : 0) +
        (marked.has(edgeKey(cap[t + 2], cap[t])) ? 1 : 0);
      grown += count;
    }
    if (cap.length / 3 + grown > MAX_TOP_TRIANGLES) break;

    const mids = new Map<number, number>();
    const nextCap: number[] = [];
    const nextBorder = new Set<number>();
    const midOf = (a: number, b: number): number => {
      const k = edgeKey(a, b);
      const seen = mids.get(k);
      if (seen !== undefined) return seen;
      const m = pos.length / 3;
      pos.push(
        (pos[a * 3] + pos[b * 3]) / 2,
        (pos[a * 3 + 1] + pos[b * 3 + 1]) / 2,
        (pos[a * 3 + 2] + pos[b * 3 + 2]) / 2
      );
      mids.set(k, m);
      if (border.has(k)) {
        frozen.add(m);
        nextBorder.add(edgeKey(a, m));
        nextBorder.add(edgeKey(m, b));
      }
      return m;
    };
    // An unsplit border edge has to be carried forward or the next pass forgets it is a rim.
    const keepBorder = (a: number, b: number) => {
      const k = edgeKey(a, b);
      if (border.has(k)) nextBorder.add(k);
    };

    for (let t = 0; t < cap.length; t += 3) {
      const a = cap[t];
      const b = cap[t + 1];
      const c = cap[t + 2];
      const mAB = marked.has(edgeKey(a, b));
      const mBC = marked.has(edgeKey(b, c));
      const mCA = marked.has(edgeKey(c, a));
      const count = (mAB ? 1 : 0) + (mBC ? 1 : 0) + (mCA ? 1 : 0);
      if (count === 3) {
        const ab = midOf(a, b);
        const bc = midOf(b, c);
        const ca = midOf(c, a);
        nextCap.push(a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca);
        continue;
      }
      if (count === 0) {
        nextCap.push(a, b, c);
        keepBorder(a, b);
        keepBorder(b, c);
        keepBorder(c, a);
        continue;
      }
      if (count === 1) {
        // Bisect the marked edge toward the opposite vertex. Winding is preserved by keeping
        // the two halves in the parent's own cyclic order.
        if (mAB) {
          const m = midOf(a, b);
          nextCap.push(a, m, c, m, b, c);
          keepBorder(b, c);
          keepBorder(c, a);
        } else if (mBC) {
          const m = midOf(b, c);
          nextCap.push(b, m, a, m, c, a);
          keepBorder(a, b);
          keepBorder(c, a);
        } else {
          const m = midOf(c, a);
          nextCap.push(c, m, b, m, a, b);
          keepBorder(a, b);
          keepBorder(b, c);
        }
        continue;
      }
      /*
       * Two marked edges: one corner triangle plus a quad, cut on its shorter diagonal so the
       * pass cannot manufacture a needle of its own. Written once, with the corner rotated to
       * the unmarked edge, so the three cases cannot drift apart.
       */
      // Rotate so that (p0, p1) is the *unmarked* edge; the corner sits at p2.
      const p0 = !mAB ? a : !mBC ? b : c;
      const p1 = !mAB ? b : !mBC ? c : a;
      const p2 = !mAB ? c : !mBC ? a : b;
      // Marked edges are (p1,p2) and (p2,p0); the unmarked one is (p0,p1).
      const m1 = midOf(p1, p2);
      const m2 = midOf(p2, p0);
      nextCap.push(m1, p2, m2);
      const dA = planarLen2(p0, m1);
      const dB = planarLen2(p1, m2);
      if (dA <= dB) nextCap.push(p0, p1, m1, p0, m1, m2);
      else nextCap.push(p0, p1, m2, p1, m1, m2);
      keepBorder(p0, p1);
    }
    cap = nextCap;
    border = nextBorder;
  }

  /*
   * Geodesic distance from the frozen rim, in world units, over the refined cap's own
   * one-ring — a bounded label-correcting relaxation, which on a planar patch settles in a
   * couple of sweeps and never needs a heap.
   *
   * **In world units, not in hops, and that is a fix rather than a rewrite.** The cap comes
   * out of `ExtrudeGeometry`'s triangulation of a polygon with dozens of holes, so it
   * contains long slivers; 1-to-4 subdivision keeps a sliver similar to itself, so its short
   * edge halves at every level while a hop-counted ramp stays two edges wide however short
   * those edges are. Two neighbours could therefore sit one hop apart at 0.0006 units and
   * carry mask 0.5 and 1.0 — the full relief amplitude across a sub-millimetre edge, i.e. a
   * near-vertical facet. A metric ramp cannot do that: its slope is `1.5 x amount / ramp` by
   * construction, and both ends are fractions of the cell, so it is the same 12.4 deg at
   * every board size.
   */
  const adjacency = new Map<number, number[]>();
  const link = (a: number, b: number) => {
    const list = adjacency.get(a);
    if (list) list.push(b);
    else adjacency.set(a, [b]);
  };
  const seen = new Set<number>();
  for (let t = 0; t < cap.length; t += 3) {
    const a = cap[t];
    const b = cap[t + 1];
    const c = cap[t + 2];
    link(a, b);
    link(b, a);
    link(b, c);
    link(c, b);
    link(c, a);
    link(a, c);
    seen.add(a);
    seen.add(b);
    seen.add(c);
  }

  const reach = new Map<number, number>();
  const queue: number[] = [];
  for (const v of frozen) {
    if (!seen.has(v)) continue;
    reach.set(v, 0);
    queue.push(v);
  }
  const planar = (a: number, b: number) => {
    const dx = pos[a * 3] - pos[b * 3];
    const dz = pos[a * 3 + 2] - pos[b * 3 + 2];
    return Math.sqrt(dx * dx + dz * dz);
  };
  for (let head = 0; head < queue.length; head++) {
    const v = queue[head];
    const base = reach.get(v) ?? 0;
    for (const w of adjacency.get(v) ?? []) {
      const d = base + planar(v, w);
      if (d >= ramp) continue;
      if ((reach.get(w) ?? Infinity) <= d) continue;
      reach.set(w, d);
      queue.push(w);
    }
  }

  const mask = new Map<number, number>();
  for (const v of seen) {
    const d = reach.get(v);
    // Smoothstep, so the ramp has no slope discontinuity at either end — a linear ramp
    // creases the surface exactly where it meets the untouched rim.
    let m = 1;
    if (d !== undefined) {
      const u = d / ramp;
      m = u * u * (3 - 2 * u);
    }
    mask.set(v, m);
    if (m <= 0) continue;
    pos[v * 3 + 1] = topY + reliefAt(pos[v * 3], pos[v * 3 + 2], frequency) * amount * m;
  }

  const shared = new Set<number>();
  for (const v of restVerts) if (seen.has(v)) shared.add(v);

  geo.setAttribute("position", new BufferAttribute(new Float32Array(pos), 3));
  geo.setIndex(cap.concat(rest));
  return { mask, shared };
}

/**
 * Overwrites the plateau's vertex normals with the height field's own.
 *
 * The relief is `h(x, z) = mask x amount x reliefAt(x, z)`, so its normal is
 * `normalize(-dh/dx, 1, -dh/dz)` — known exactly, and independent of how the triangulator
 * happened to cut the cap up. `mask` is treated as locally constant, which is correct in the
 * middle of a wall top and self-correcting at the rim, where it goes to zero and takes the
 * whole gradient with it: the normal there returns to `+Y`, which is what the flat cap
 * carried before any of this ran.
 *
 * The central-difference step is a 48th of the lump wavelength, which resolves all three fbm
 * octaves — the finest is a quarter of the wavelength — so the normal carries micro-grain the
 * mesh itself is too coarse to hold. That is the right way round: §3 asks for grain in the
 * shading, and 1.5 px of geometry cannot carry it.
 */
function fieldNormals(
  geo: BufferGeometry,
  relief: TopRelief,
  amount: number,
  frequency: number
): void {
  const posAttr = geo.getAttribute("position");
  const nrmAttr = geo.getAttribute("normal");
  if (!posAttr || !nrmAttr) return;
  const p = posAttr.array as ArrayLike<number>;
  const nr = nrmAttr.array as Float32Array;
  const eps = 1 / (frequency * 48);

  for (const [v, m] of relief.mask) {
    if (m <= 0 || relief.shared.has(v)) continue;
    const x = p[v * 3];
    const z = p[v * 3 + 2];
    const k = (m * amount) / (2 * eps);
    const dx = (reliefAt(x + eps, z, frequency) - reliefAt(x - eps, z, frequency)) * k;
    const dz = (reliefAt(x, z + eps, frequency) - reliefAt(x, z - eps, frequency)) * k;
    const len = Math.sqrt(dx * dx + 1 + dz * dz);
    nr[v * 3] = -dx / len;
    nr[v * 3 + 1] = 1 / len;
    nr[v * 3 + 2] = -dz / len;
  }
  nrmAttr.needsUpdate = true;
}

/**
 * Presses the crest/trough tonal drift into the wall tops.
 *
 * Runs **after** `bakeCurvatureAO`, and multiplies into the same `color` attribute the clay
 * shader already reads — exactly the way `buildFloor` layers its wall occlusion on top of
 * the baked curvature. It is deliberately not a second attribute: one channel, one read.
 *
 * Only the plateau is touched. A vertex qualifies on two independent tests — it lies inside
 * the relief band around `topY`, and its shading normal is the up-facing one — so a bevel
 * vertex that happens to sit at the right height cannot be caught by it.
 */
function toneTopCap(geo: BufferGeometry, topY: number, amount: number): void {
  const posAttr = geo.getAttribute("position");
  const nrmAttr = geo.getAttribute("normal");
  const colAttr = geo.getAttribute("color");
  if (!posAttr || !nrmAttr || !colAttr || amount <= 0) return;
  const p = posAttr.array as ArrayLike<number>;
  const nr = nrmAttr.array as ArrayLike<number>;
  const col = colAttr.array as Float32Array;

  for (let i = 0; i < posAttr.count; i++) {
    const dy = p[i * 3 + 1] - topY;
    if (dy > amount || dy < -amount) continue;
    if (nr[i * 3 + 1] < 0.5) continue;
    const t = dy / amount;
    const crest = t > 0 ? t : 0;
    const trough = t < 0 ? -t : 0;
    col[i * 3] *= 1 + WEAR_CREST[0] * crest - WEAR_TROUGH[0] * trough;
    col[i * 3 + 1] *= 1 + WEAR_CREST[1] * crest - WEAR_TROUGH[1] * trough;
    col[i * 3 + 2] *= 1 + WEAR_CREST[2] * crest - WEAR_TROUGH[2] * trough;
  }
  colAttr.needsUpdate = true;
}

/**
 * Weld on position only, drop degenerates, fix winding, refine and press the top, then
 * smooth normals, UVs, curvature AO.
 *
 * Attributes are stripped before merging for the same reason `geometry.ts` strips them:
 * `mergeVertices` compares every attribute, so leaving the extruder's UVs on would refuse
 * to weld across a UV seam and `computeVertexNormals` would then crease the block along it.
 */
function finishOwned(
  src: BufferGeometry,
  ao?: { strength?: number; radius?: number },
  press?: { topY: number; amount: number; frequency: number; ramp: number }
): BufferGeometry {
  src.deleteAttribute("uv");
  src.deleteAttribute("uv1");
  src.deleteAttribute("uv2");
  src.deleteAttribute("normal");
  src.deleteAttribute("color");
  src.clearGroups();

  const geo = mergeVertices(src, WELD_EPS);
  if (geo !== src) src.dispose();

  dropDegenerate(geo);
  ensureOutward(geo);
  const relief = press
    ? reliefTopCap(geo, press.topY, press.amount, press.frequency, press.ramp)
    : null;
  geo.computeVertexNormals();
  if (press && relief) fieldNormals(geo, relief, press.amount, press.frequency);
  applyPlanarUV(geo);
  bakeCurvatureAO(geo, ao);
  if (press) toneTopCap(geo, press.topY, press.amount);
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

/* ------------------------------------------------------------------ */
/* The gum block                                                       */
/* ------------------------------------------------------------------ */

/** Rounded board outline, counter-clockwise, in shape space. */
function roundedRectPoints(size: number, radius: number, arcSegs: number): number[] {
  const h = size / 2;
  const r = Math.min(radius, h * 0.9);
  const out: number[] = [];
  const cx = [h - r, -h + r, -h + r, h - r];
  const cy = [h - r, h - r, -h + r, -h + r];
  for (let k = 0; k < 4; k++) {
    const a0 = (k * Math.PI) / 2;
    for (let i = 0; i <= arcSegs; i++) {
      const a = a0 + (Math.PI / 2) * (i / arcSegs);
      out.push(cx[k] + Math.cos(a) * r, cy[k] + Math.sin(a) * r);
    }
  }
  return out;
}

const toVec2 = (loop: number[]): Vector2[] => {
  const out: Vector2[] = [];
  for (let i = 0; i < loop.length; i += 2) out.push(new Vector2(loop[i], loop[i + 1]));
  return out;
};

function buildGum(
  maze: boolean[][],
  n: number,
  goal: Cell,
  arcSegs: number,
  bevelSegments: number
): BufferGeometry {
  const cell = cellSize(n);
  const bevel = wallBevel(n);
  const sink = wallSink(n);
  const height = wallHeight(n);

  // Shape space: X is world X, Y is *minus* world Z, because the block is laid flat with
  // `rotateX(-PI/2)`, which maps local (x, y, z) to world (x, z, -y).
  const toShape = (loop: number[]): number[] => {
    const out = new Array<number>(loop.length);
    for (let i = 0; i < loop.length; i += 2) {
      out[i] = (loop[i] - n / 2) * cell;
      out[i + 1] = -(loop[i + 1] - n / 2) * cell;
    }
    return out;
  };

  const outer = roundedRectPoints(gumOuter(n), boardCorner(n), Math.max(4, arcSegs * 3));
  if (signedArea(outer) < 0) reverseLoop(outer);

  const shape = new Shape();
  shape.setFromPoints(toVec2(outer));

  for (const raw of corridorLoops(maze, n)) {
    // The toothbrush's bay is cut out of the outline itself, so it inherits the same bevel,
    // the same fillet and the same baked occlusion as every other corridor corner.
    const bayed = carveAlcove(raw, goal.r, goal.c, ALCOVE);
    // Cut the hole `wallSwell` wider than the corridor it is meant to be, because the
    // extrusion will take exactly that much back through the middle band — the height every
    // prop in this game stands at. See `offsetLoop` for the measurement and for why this is
    // safe on a maze this generator can produce. `corridorClear` in `layout.ts` is 0.5
    // *because* of this line; the two must move together.
    const widened = offsetLoop(mergeCollinear(bayed), wallSwell(n));
    const filleted = filletLoop(widened, CORNER_FILLET, arcSegs);
    const points = toShape(filleted);
    // Holes wind opposite to the outer contour. `ExtrudeGeometry` normalises this itself,
    // but handing it a consistent shape keeps the bevel's inward offset unambiguous.
    if (signedArea(points) > 0) reverseLoop(points);
    const path = new Path();
    path.setFromPoints(toVec2(points));
    shape.holes.push(path);
  }

  // Total thickness is `depth + 2 * bevelThickness`; we want top − bottom = height + sink.
  const depth = Math.max(0.02, height + sink - 2 * bevel);
  const geo = new ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelOffset: 0,
    bevelSegments,
    // Every contour is already an explicit polyline; sampling it as curves would only
    // multiply the vertex count.
    curveSegments: 1,
    steps: 1,
  });
  geo.rotateX(-Math.PI / 2);
  // The extrusion spans local z in [-bevel, depth + bevel]; drop it so its underside sits
  // `sink` below the corridor floor and its top lands exactly at FLOOR_Y + height.
  geo.translate(0, FLOOR_Y - sink + bevel, 0);

  // A wider AO radius than the default: the feature that has to read is a corridor corner,
  // which is a cell across, not a thumb-pressed 5 mm bevel.
  //
  // The extrusion spans `[FLOOR_Y - sink, FLOOR_Y + height]` after the translate above, so
  // the flat cap the relief has to find is exactly `FLOOR_Y + height` — derived here rather
  // than measured off the mesh, because a bounding box would also catch a stray vertex.
  return finishOwned(
    geo,
    { strength: 1.2, radius: 1.5 },
    {
      topY: FLOOR_Y + height,
      amount: height * WALL_RELIEF,
      frequency: WALL_RELIEF_LUMPS / cell,
      ramp: cell * WALL_RELIEF_RAMP,
    }
  );
}

/* ------------------------------------------------------------------ */
/* The corridor floor                                                  */
/* ------------------------------------------------------------------ */

/** Reach of the wall occlusion, in cells. */
const AO_REACH = 0.62;
/** Deepest the pooled occlusion may go, as a fraction of the ivory's own brightness. */
const AO_MAX = 0.46;
/** Peak hand-press relief on the floor, in world units. */
const RELIEF = 0.0035;

function buildFloor(maze: boolean[][], n: number, goal: Cell, sub: number): BufferGeometry {
  const cell = cellSize(n);
  // The wall's visible face at floor level is now the cell boundary itself: `buildGum` cuts
  // the corridor `wallSwell` wider and the extrusion swells it back by exactly that, so the
  // clear width really is one cell (see `offsetLoop`). This inset used to compensate for the
  // swell and would now double-count it.
  const inset = 0;
  const dishY = dishDepth(n);
  // The well is centred under where the brush actually stands — diagonally into the bay,
  // clear of the cell centre the tooth comes to rest on.
  const goalU = goal.c + 0.5 + GOAL_OFFSET;
  const goalV = goal.r + 0.5 + GOAL_OFFSET;

  // Half a cell in from the board edge on every side: the outer ring is always solid gum,
  // so the floor's own boundary is never visible.
  const span = n - 1;
  const w = span * sub + 1;
  const total = w * w;

  const position = new Float32Array(total * 3);
  const occlusion = new Float32Array(total);

  const wall = (r: number, c: number) => r < 0 || r >= n || c < 0 || c >= n || maze[r][c];

  for (let j = 0; j < w; j++) {
    const v = 0.5 + j / sub;
    const vi = Math.floor(v);
    for (let i = 0; i < w; i++) {
      const u = 0.5 + i / sub;
      const ui = Math.floor(u);
      const at = j * w + i;

      const x = (u - n / 2) * cell;
      const z = (v - n / 2) * cell;

      let y = FLOOR_Y + (fbm2(x * 6.5 + 11.3, z * 6.5 - 4.1, 3) - 0.5) * 2 * RELIEF;

      // The toothbrush's alcove: a smooth dish pressed into the clay, flat-bottomed at the
      // centre and tangent to the floor at the rim so there is no crease around it.
      const dd = Math.hypot(u - goalU, v - goalV);
      let dish = 0;
      if (dd < DISH_RADIUS) {
        dish = 0.5 + 0.5 * Math.cos((Math.PI * dd) / DISH_RADIUS);
        y -= dishY * dish;
      }

      let occ = 0;
      for (let r = vi - 2; r <= vi + 2; r++) {
        for (let c = ui - 2; c <= ui + 2; c++) {
          if (!wall(r, c)) continue;
          const dx = u < c + inset ? c + inset - u : u > c + 1 - inset ? u - (c + 1 - inset) : 0;
          const dz = v < r + inset ? r + inset - v : v > r + 1 - inset ? v - (r + 1 - inset) : 0;
          const d = Math.sqrt(dx * dx + dz * dz);
          if (d >= AO_REACH) continue;
          const k = 1 - d / AO_REACH;
          occ += k * k;
        }
      }
      // Saturating, so a vertex buried under a wall does not go to soot.
      occlusion[at] = (1 - Math.exp(-1.35 * occ)) * (1 - 0.35 * dish);

      position[at * 3] = x;
      position[at * 3 + 1] = y;
      position[at * 3 + 2] = z;
    }
  }

  const index: number[] = [];
  for (let j = 0; j < w - 1; j++) {
    for (let i = 0; i < w - 1; i++) {
      const u = 0.5 + (i + 0.5) / sub;
      const v = 0.5 + (j + 0.5) / sub;
      const ui = Math.floor(u);
      const vi = Math.floor(v);
      // Drop a quad only when it and every one of its eight neighbours is solid gum, so no
      // hole can ever open under a bevelled corridor lip.
      let buried = true;
      for (let r = vi - 1; r <= vi + 1 && buried; r++) {
        for (let c = ui - 1; c <= ui + 1; c++) {
          if (!wall(r, c)) {
            buried = false;
            break;
          }
        }
      }
      if (buried) continue;

      const a = j * w + i;
      const b = a + 1;
      const c2 = a + w;
      const d = c2 + 1;
      // Wound so the face normal points at +Y.
      index.push(a, c2, b, b, c2, d);
    }
  }

  const geo = new BufferGeometry();
  geo.setAttribute("position", new BufferAttribute(position, 3));
  geo.setIndex(index);
  geo.computeVertexNormals();
  applyPlanarUV(geo);
  // Curvature AO first: it catches the dish rim and the micro relief. The wall occlusion is
  // then multiplied into the same attribute, because the clay shader reads exactly one.
  bakeCurvatureAO(geo, { strength: 0.9, radius: 0.9 });

  const colorAttr = geo.getAttribute("color");
  const col = colorAttr.array as Float32Array;
  for (let at = 0; at < total; at++) {
    const t = occlusion[at];
    const shade = 1 - AO_MAX * t;
    // Warm-dark, never grey: the blue channel falls fastest, exactly as `CLAY.crevice` does.
    col[at * 3] *= shade * (1 + 0.03 * t);
    col[at * 3 + 1] *= shade * (1 - 0.06 * t);
    col[at * 3 + 2] *= shade * (1 - 0.15 * t);
  }
  colorAttr.needsUpdate = true;

  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

/* ------------------------------------------------------------------ */
/* Entry points                                                        */
/* ------------------------------------------------------------------ */

/**
 * Builds one maze's geometry. Called from a `useMemo` on the scene's mount and again on
 * every regenerate — never at module import time, so it lands in this game's own chunk.
 *
 * Cost on the mid tier for the largest board: roughly 23k extruded vertices welded down to
 * ~4k, plus a 2.4k-vertex floor. One frame's work, once per maze, never per frame.
 */
/**
 * The clearance invariants, checked at build time in DEV.
 *
 * ME5 asked for "a build-time assertion comparing the two", and this is it — generalised to
 * every prop that stands in the carved gum, because the ring was not the only one that had
 * drifted. Each line is the same statement: *this prop's own footprint, plus 3D-SPEC §3's
 * minimum bevel, fits inside the clear width the extrusion actually leaves at the height the
 * prop occupies.* They cannot silently come apart again: change `BEVEL_RATIO`, `ALCOVE`,
 * `GOAL_OFFSET`, the board pitch or the ring's authored size and whichever one no longer holds
 * says so on the next maze built in dev.
 *
 * `TOOTH_SUPPORT` is the tooth's own support along its direction of travel, in units of its
 * height — the arms, not the body, are the widest thing on it — measured off the shipped
 * metaball surface and the arm capsules by `scratchpad/verify/maze-hero.mjs`.
 */
const TOOTH_SUPPORT = 0.4577;
/**
 * Worst *simultaneous* reach of the hero toward a wall over a whole bump beat, in cells.
 *
 * Not `support + peak push`. Those two peaks do not coincide: the tooth is squashed along the
 * bump axis while the push is rising, which shrinks its support, and the squash has decayed by
 * the time the push tops out. `scratchpad/verify/maze-bump.mjs` integrates the three springs at
 * 60 Hz and evaluates `push(t) + supportX(squash(t), tip(t))` every frame, over a single bump
 * and over a train of four at the engine's own 260 ms `BUMP_INTERVAL`; the worst value is
 * 0.4532 cells at 9, 11 and 13 alike, i.e. 2.19–3.17 px of daylight at design framing.
 */
const BUMP_LEAD_PEAK = 0.4532;

let clearanceChecked = false;

function assertClearances(n: number): void {
  const cell = cellSize(n);
  const bevelCells = MIN_BEVEL / cell;
  const checks: [string, number, number][] = [
    ["start ring", startRingMajor(n) + RING_TUBE + bevelCells, corridorClear(n)],
    ["goal pad", goalPadRadius(n) + bevelCells, bayClear(n)],
    ["tooth at rest", TOOTH_SUPPORT * TOOTH_HEIGHT_CELLS + bevelCells, corridorClear(n)],
    /*
     * No `MIN_BEVEL` margin on this one, deliberately, and it is not a loosened check: §3's
     * minimum bevel is a rule about *geometry* — no feature may be sharper than 0.02 units —
     * and a hero pressing on soft gum for 130 ms is a transient contact, not a feature. What
     * has to hold is that it never enters the gum, and it holds with 2.19 px to spare on the
     * tightest board. The resting row above does carry the margin, because that clearance is
     * permanent and is a feature.
     */
    ["tooth at the peak of a bump", BUMP_LEAD_PEAK, corridorClear(n)],
  ];
  for (const [what, needs, has] of checks) {
    if (needs <= has) continue;
    console.error(
      `[maze-escape] ${what} does not fit at ${n} cells: needs ${needs.toFixed(4)} cells of ` +
        `clear half-width, has ${has.toFixed(4)}. See layout.ts::wallSwell.`
    );
  }
}

export function buildMazeGeometry(maze: boolean[][], n: number, goal: Cell): MazeGeometry {
  if (import.meta.env.DEV && !clearanceChecked) {
    clearanceChecked = true;
    assertClearances(9);
    assertClearances(11);
    assertClearances(13);
  }
  const detail = getQuality().detail;
  const arcSegs = detail <= 1 ? 2 : 3;
  const bevelSegments = detail <= 1 ? 2 : 3;
  const sub = detail <= 1 ? 3 : detail < 3 ? 4 : 5;
  // The wall-top relief is deliberately **not** on that list. It used to lose a subdivision
  // level at `detail <= 1`, and A4's finding is exactly that the tier the target device boots
  // is the one nobody art-directed — on a surface that is ~45 % of this game's play area. The
  // refinement in `reliefTopCap` is driven by the relief's own wavelength now, not by a level
  // count, and it spends the triangles the uniform two-level build already spent, so there is
  // nothing here for the low tier to buy back. See `RELIEF_EDGE_FRACTION`.
  return {
    gum: buildGum(maze, n, goal, arcSegs, bevelSegments),
    floor: buildFloor(maze, n, goal, sub),
  };
}

/** Frees a maze's geometry. Nothing here is shared, so both really are ours to dispose. */
export function disposeMazeGeometry(geometry: MazeGeometry): void {
  geometry.gum.dispose();
  geometry.floor.dispose();
}
