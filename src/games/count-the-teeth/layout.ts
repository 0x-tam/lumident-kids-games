/**
 * Count the Teeth — board metrics, camera framing and the scatter solver.
 *
 * Pure numbers: importing this pulls in no three and no React, so the shell (which needs
 * the camera), the scene (which needs everything) and the self test (which needs only the
 * solver) can all share it without dragging the 3D layer into a chunk that does not want
 * it.
 *
 * Scale note (3D-SPEC §2): 1 world unit = 10 cm. A counted tooth here is 7.2 cm tall — a
 * clay play-piece rather than an anatomical baby tooth — and the board it sits on grows
 * with the level and with the shape of the play area, from 36 x 42 cm on Easy to 65 x 42 cm
 * on a laptop's Hard or 36 x 67 cm on a phone's.
 *
 * ---------------------------------------------------------------------------
 * THE COUNTING GUARANTEE
 * ---------------------------------------------------------------------------
 *
 * The one thing this game may never do is put two teeth on screen in a way that makes the
 * count ambiguous. Round 1 of this audit found three separate reasons it was doing exactly
 * that, and all three are fixed here:
 *
 *  1. **The teeth were rendered 2.6x larger than the proof assumed.** `TOOTH_H` was used to
 *     size the separation constraints and to frame the camera, but the instance matrices
 *     were composed from `scatter.scale` alone — and `toothGeometry` is normalised to one
 *     world unit. Every board was proved for a 3.8 cm tooth and then drawn with a 10 cm one.
 *     `toothScale()` below is now the single place the render scale is computed, and the
 *     solver uses the same function.
 *
 *  2. **The screen-space height of a tooth was under-measured by 34%.** The old model took
 *     an upright tooth's screen-up extent to be `H·cos E`, which is the extent of a
 *     *vertical line segment*. A tooth is a solid, it leans, it yaws and it sways: its extent
 *     along the screen-up axis is `max(y·cos E − z·sin E) − min(...)` over the whole surface,
 *     over every pose. Measured off the assembled mascot itself, that is **0.939** of the
 *     tooth's height, not 0.616 (see `TOOTH_SILHOUETTE`).
 *
 *  3. **The test was orthographic; the camera is not.** Two silhouettes whose
 *     axis-aligned *world* boxes are disjoint can still overlap on screen, because the
 *     nearer of the two is magnified by up to 15% across this board's depth. The solver now
 *     works in **normalised device coordinates**, using the framing the camera is actually
 *     given, so the thing it proves is the thing the child sees.
 *
 * What is proved, precisely: for every pair of teeth, the NDC axis-aligned boxes of their
 * silhouettes are disjoint by at least `GAP_FRACTION` of a tooth's own NDC width, and
 * every tooth's box lies inside the visible part of the frame. Disjoint boxes cannot
 * overlap, so every tooth is 100% unoccluded by every other tooth — comfortably past the
 * 75% `3D-SPEC §6.7` asks for. Nothing else in the scene is between the camera and the
 * pad: the answer tiles sit far below the teeth in screen space (asserted by `?selftest=count`).
 *
 * The solve is **terminal**: `solveScatter` returns only when the board it has written
 * passes that test, falling through progressively less adventurous placements to exact grid
 * centres and, if even that were ever to fail, to a bounded shrink. It reports which rung it
 * used so the self test can assert that the interesting ones are never needed.
 *
 * `?selftest=count` still renders per-tooth IDs from the live game camera and measures the
 * real silhouettes on the GPU — that remains the authority. It no longer runs during play:
 * it cost ~20 synchronous `readRenderTargetPixels` calls inside `useFrame` on every round,
 * which is a 200–500 ms pipeline stall on a tile-based mobile GPU.
 *
 * Round 3 found the fourth reason, and it was in the *proof* rather than in the board: the
 * six constants the whole thing rests on were measured on a bare, upright body at one
 * quality tier's subdivision, while the guard that was supposed to keep them honest measured
 * a different quantity again. `toothGeometry("baby")` is re-solved per tier — 500 / 980 /
 * 1620 triangles — and an isosurface resampled at a different subdivision is a different
 * shape, so on any high-tier machine the game logged an error on every mount and
 * `?selftest=count` aborted before it ever reached the pass §6.7 actually names. The
 * constants are now bounds over all three tiers, they are the swept extents of the whole
 * assembled mascot, and `checkSilhouette` measures exactly that and nothing else.
 */

/* ------------------------------------------------------------------ */
/* Camera basis                                                        */
/* ------------------------------------------------------------------ */

const DEG = Math.PI / 180;

/**
 * 52°: steep enough that upright teeth separate cleanly in screen space, shallow enough
 * that they still read as objects standing on a table rather than as a floor plan — and
 * shallow enough that the mascot's face, which lives on the tooth's +Z flank, is seen at
 * 38° off its own normal rather than edge-on.
 */
export const ELEVATION = 52 * DEG;
export const FOV = 28;

export const SIN_E = Math.sin(ELEVATION);
export const COS_E = Math.cos(ELEVATION);
export const tanHalfFov = (fov: number) => Math.tan((fov * Math.PI) / 360);
export const TAN_HALF_FOV = tanHalfFov(FOV);

/**
 * The lenses this game is allowed to reach for, in the order it prefers them.
 *
 * `3D-SPEC §2` fixes the band at 26–32 and the default at 28, and 28 is what almost every
 * viewport gets. A tall narrow phone showing sixteen cells is the one composition that
 * cannot be held inside the spec's 8–16 unit distance band on a 28 mm lens, and the only
 * two ways out of that are a wider lens or a control clipped by the edge of the screen.
 * The spec permits the first and forbids the second.
 */
const FOV_BAND = [28, 30, 32] as const;

/** Screen-up coordinate of a world point, in the camera's own basis. */
export const screenUp = (y: number, z: number) => y * COS_E - z * SIN_E;
/** Toward-camera coordinate of a world point, in the camera's own basis. */
export const towardCamera = (y: number, z: number) => y * SIN_E + z * COS_E;

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/* ------------------------------------------------------------------ */
/* The tooth                                                           */
/* ------------------------------------------------------------------ */

/**
 * The one accent family this game is allowed to use, and the single place it is written.
 *
 * X2: round 1 registered this game as **coral** in `src/games/index.ts` and then built its
 * board, pad and pips from `clayAccent("mauve", …)` — dE2000 13.9 from `coral.deep` — so a
 * child tapped a coral card and opened into a mauve room. The literal is gone from both the
 * scene and the shell; `?selftest=count` asserts this constant against the registry entry,
 * so the two cannot drift apart again without a test going red.
 *
 * Kept here, in the file with no imports, so the scene and the shell can share it without
 * either of them reaching for the registry (which lazily imports *this game*).
 */
export const ACCENT = "coral" as const;

/** World height of a counted tooth at scale 1. `toothGeometry` is 1.0 unit tall. */
export const TOOTH_H = 0.72;
/** Random lean, in radians. Every tooth is placed by hand, so none of them is plumb. */
export const TOOTH_TILT = 5 * DEG;
/**
 * Random yaw, in radians, about the tooth's own axis.
 *
 * Deliberately small and centred on zero rather than the full turn the old code used: the
 * mascot's face is on the +Z flank, and a tooth that has been spun 150° presents the back of
 * its head. ±26° is enough that fourteen teeth do not look stamped, and every face still
 * reads.
 */
export const TOOTH_YAW = 26 * DEG;
/** Random size variation, ±. */
export const TOOTH_SCALE_VAR = 0.07;
/** How far a tooth's root is buried in the pad, so it is placed rather than balanced. */
export const TOOTH_SINK = 0.022;

/**
 * Idle life, in world units and radians. Lives here, not in `scene.tsx`, because the
 * countability proof has to pay for it.
 *
 * At the framings the shell produces a world unit is 100–150 CSS px, so `IDLE_BOB` is a
 * 2.2–3.3 px rise and `IDLE_SWAY` swings a crown sitting 0.57 units up by 0.022 units,
 * another 2.2–3.3 px. Round 1 used 0.0035 / 0.01 rad — 0.3 px and 0.6 px, under the
 * display's resolution, so the teeth were simply still (3.7 G-CT-6).
 *
 * The bob is applied **one-sided** by `scene.tsx` (0 to `IDLE_BOB`, never below), so a tooth
 * touches the clay once a cycle instead of hovering around a mean. `scatterMetrics` still
 * pays for it symmetrically, which is the conservative direction.
 *
 * `IDLE_SWAY` is swept into `TOOTH_SILHOUETTE` (it is a rotation, so it scales with the
 * tooth) and `IDLE_BOB` is added by `scatterMetrics` (it is a world translation, so it does
 * not). Neither is a free parameter any more: raising either widens every box, spreads every
 * board and makes every tooth smaller.
 */
export const IDLE_BOB = 0.022;
export const IDLE_SWAY = 0.038;

/**
 * Multiplies the mascot's face features without moving their anchors.
 *
 * `mascotParts` puts an eye at 6.8% of the tooth's height. On a 65 px tooth that is a 9 px
 * eye, which is legible but timid; 1.3 takes it to 11–12 px, which is the size at which a
 * four-year-old reads "this is a face" rather than "this has dots on it". Measured at the
 * framings the shell actually produces, a counted tooth is 43–111 px tall and its eye
 * 9.4–24 px across.
 *
 * `geometry.ts` clamps this into `[0.72, 1.68]` and presses every outward feature anchor in
 * as it grows, so the whole face stays inside the crown's own outline at any value — that is
 * A19, and it is what un-buried this game's catchlights (at 1.3 the glint sphere used to sit
 * *entirely inside* the pupil, which is what made fourteen of these read as skulls).
 *
 * **`TOOTH_SILHOUETTE` is derived at this value.** Change one and the other is stale; the
 * mount guard and `?selftest=count` will both say so, loudly, on the first frame.
 */
export const FACE_SCALE = 1.3;

/**
 * How wide the counted mascot smiles. Below `geometry.ts`'s 0.3 tongue threshold on purpose:
 * a tongue is noise at 60 px, a mouth is not. At `FACE_SCALE` this is a 0.12-of-height dark
 * oval rather than the 0.068 lozenge `open: 0` gives — 7 px against 4 px on a Hard board,
 * which is the difference between a smile and a lipless line. It does not touch the
 * silhouette (the mouth is anchored at y 0.70, far inside the crown): the sweep below
 * measures identical extents at `open` 0 and 0.28.
 */
export const FACE_OPEN = 0.28;

/* ---- the swept silhouette, and how it is measured ------------------ */

/**
 * The pose sweep the silhouette constants are the extremes of, as a grid.
 *
 * Exported and used by **both** the derivation and the runtime guard, so the guard measures
 * exactly the quantity the constants claim to be rather than something adjacent to it. That
 * was the round-3 defect in one line: the constants were the swept extents of the whole
 * mascot and the guard measured one bare, upright body, so four of the six numbers were
 * being compared with a different quantity — and the one two-sided comparison that happened
 * to be tight (`vMin`) fired a `console.error` on every mount.
 *
 * Resolution is not free but it is nearly free here: against a 48/6/96/4 reference grid this
 * one differs by at most **0.00054** on `footHalf` and 0.0003 on everything else (measured,
 * all three detail levels), which is `SWEEP_MARGIN` below.
 */
export const SWEEP = { yaw: 12, lean: 3, dir: 24, sway: 2 } as const;

/** Slack for the sweep grid's own coarseness. See `SWEEP`. */
const SWEEP_MARGIN = 0.001;

/**
 * The tooth's silhouette in the camera's screen basis, per unit of tooth height.
 *
 * These are constants rather than a runtime measurement because `cameraFor` runs on the DOM
 * side of `<Scene3D>`, where no geometry exists — the camera has to be solved before the
 * scene mounts. They are not allowed to drift: the scene sweeps the real assembled mascot on
 * mount and calls `checkSilhouette`, and `?selftest=count` fails hard if the two disagree.
 *
 * **What was measured, and how.** Every number is an extreme of `sweepSilhouette` run over
 * the whole mascot — `mascotParts({ featureScale: FACE_SCALE, open: FACE_OPEN, limbs: false })`,
 * body and face, as a point cloud — across the complete pose range a scatter can draw: yaw
 * ±`TOOTH_YAW`, lean up to `TOOTH_TILT` in every direction, plus ±`IDLE_SWAY` of idle roll.
 * Nothing is added on afterwards and nothing is subtracted: each figure is the thing itself.
 *
 * **They are bounds over the three detail levels the product can ship, not one measurement.**
 * That is the other half of the round-3 defect. `toothGeometry` is re-solved per quality tier
 * — 500 / 980 / 1620 triangles at detail 1 / 2 / 3 — and an isosurface resampled at a
 * different subdivision is a *different shape*: the bare body's `vMin` alone moves from
 * +0.0002 at detail 1 to −0.0205 at detail 3. The constants below were measured at detail 2
 * and the guard ran against whichever detail the tier had chosen, so on any high-tier machine
 * the game shipped with an error in the console and `?selftest=count` aborted before its
 * occlusion pass. Every number here is now `max` (or `min`, for `vMin`) over detail 1, 2
 * and 3, so the proof holds on every tier rather than on the one it was written on.
 *
 * Measured (fine grid, all three details, rounded outward):
 *
 *  • `uHalf` — half-width along screen-right. 0.4740, from the cheeks swung into
 *    screen-right width by yaw; the bare upright body is 0.3658.
 *  • `vMin` / `vMax` — extent along screen-up, `y·cos E − z·sin E`. −0.0840 to 0.8545, so a
 *    tooth is 0.939 of its own height tall on screen — not the 0.616 an upright-line model
 *    gives, and not the 0.79 the bare upright body gives either. `vMin` is negative because a
 *    yawed, leaning tooth swings root surface toward the camera and below the plane it
 *    stands on.
 *  • `dMid` / `dSpread` — the midpoint and half-range of the toward-camera extent. `dMid` is
 *    the depth the whole silhouette is projected at; `dSpread` is what `INTRA_PERSPECTIVE`
 *    below is derived from.
 *  • `footHalf` — the whole prop's horizontal reach, `max(|x|, |z|)`, which is what has to
 *    stay over the coral.
 *  • `rootHalf` — the same reach restricted to `y ≤ 0.12`, i.e. the part of the prop that is
 *    actually near the pad. This is the footprint a *contact* shadow covers, and it is a
 *    less than half of `footHalf`: sizing the contact blob from `footHalf` is what put a
 *    2.6x-oversized dark pool under every tooth.
 *
 * Reproduce with `sweepSilhouette(mascotCloud(detail), …, SWEEP)` for detail 1, 2 and 3;
 * `?selftest=count` does exactly that and prints the residuals.
 */
export const TOOTH_SILHOUETTE = {
  uHalf: 0.474,
  vMin: -0.084,
  vMax: 0.8545,
  dMid: 0.4604,
  dSpread: 0.5294,
  footHalf: 0.4844,
  rootHalf: 0.2275,
} as const;

/**
 * How much every silhouette half-extent is inflated to cover perspective *within* one tooth.
 *
 * A tooth's surface reaches `dSpread = 0.5294` of its own height either side of its mid
 * depth — 0.4079 world units at `MAX_TOOTH_SCALE`. The nearest the camera ever gets is
 * `MIN_DISTANCE`, 8 units, so the crown is magnified by at most 0.4079 / 8 = **5.10%**
 * relative to the mid-depth projection, and the roots shrunk by the same. 6% covers it with
 * 0.9 points to spare, and paying it as a flat inflation keeps the box a simple rectangle
 * instead of a per-vertex hull. It is the conservative direction: every box is slightly
 * larger than the silhouette it stands for, so a proof of disjointness still holds.
 *
 * **Transient scale is inside this margin too, and it is the only transient that is.** Every
 * other motion a counted tooth makes is a rotation or a translation and is already inside
 * `TOOTH_SILHOUETTE` (yaw, lean, `IDLE_SWAY`) or inside `scatterMetrics` (`IDLE_BOB`). A
 * landing squash is neither: `squashFor` preserves volume, so a tooth that shortens gets
 * *wider*, and width is the axis the gap is spent on.
 *
 *   • land: `LAND_IMPULSE −3.7` into `Spring(380, 19)` peaks at **−0.0977** → width +5.42%
 *   • hop:  `HOP_SQUASH −4.6` into the same spring peaks at −0.1215 → +6.68%, and it fires
 *     only *after* the round is answered, so it cannot affect countability at all
 *
 * Two neighbours at simultaneous land peak each grow toward the other by 5.42% of their own
 * half-width, i.e. `2 x 0.0542 x uHalf` of the channel. `GAP_FRACTION` demands
 * `0.16 x 2 x uHalf` = `0.32 x uHalf`, so the squash spends **33.9%** of it and leaves 66%
 * open — 0.0819 of 0.1239 world units at the largest tooth scale. Silhouettes are therefore
 * disjoint at every instant of the animation, not only at rest.
 */
const INTRA_PERSPECTIVE = 1.06;

export type Silhouette = {
  uHalf: number;
  vMin: number;
  vMax: number;
  dMid: number;
  dSpread: number;
  footHalf: number;
  rootHalf: number;
};

/** Height below which a point counts toward `rootHalf`. See `TOOTH_SILHOUETTE`. */
const ROOT_BAND = 0.12;

/**
 * Sweeps a point cloud through every pose a scatter can draw and returns the extremes —
 * **the exact quantity `TOOTH_SILHOUETTE` is a table of.**
 *
 * `points` is the whole assembled mascot in its own normalised space: 1.0 unit tall, origin
 * at the base of the roots, face included. `face.ts::mascotCloud` builds it; nothing else
 * should, because the constants are only honest about a cloud that carries the face.
 *
 * The rotation is `Euler(tiltX, yaw, tiltZ)` in three's default XYZ order, written out by
 * hand so this module keeps its no-imports property (the shell needs the camera solve and
 * must not drag `three` into its chunk). Verified identical to
 * `Matrix4.makeRotationFromEuler` to 0 ulp on the pose range.
 *
 * Cost is `poses x count`: at `SWEEP` and detail 3 that is 3,381 poses over 2,126 points,
 * about 7 M transforms — tens of milliseconds, once, and only under `import.meta.env.DEV` or
 * `?selftest=count`. Never on a production mount and never in a frame.
 */
export function sweepSilhouette(
  points: ArrayLike<number>,
  count: number,
  grid: typeof SWEEP = SWEEP
): Silhouette {
  let uHalf = 0;
  let footHalf = 0;
  let rootHalf = 0;
  let vMin = Infinity;
  let vMax = -Infinity;
  let dMin = Infinity;
  let dMax = -Infinity;

  for (let iy = 0; iy <= grid.yaw; iy++) {
    const yaw = -TOOTH_YAW + (2 * TOOTH_YAW * iy) / grid.yaw;
    for (let il = 0; il <= grid.lean; il++) {
      const lean = (TOOTH_TILT * il) / grid.lean;
      // An upright tooth has one pose, not `grid.dir` copies of the same one.
      const dirs = il === 0 ? 1 : grid.dir;
      for (let id = 0; id < dirs; id++) {
        const dir = (Math.PI * 2 * id) / dirs;
        for (let is = 0; is <= grid.sway; is++) {
          const sway = -IDLE_SWAY + (2 * IDLE_SWAY * is) / grid.sway;
          const tx = Math.cos(dir) * lean;
          const tz = Math.sin(dir) * lean + sway;
          const cx = Math.cos(tx);
          const sx = Math.sin(tx);
          const cy = Math.cos(yaw);
          const sy = Math.sin(yaw);
          const cz = Math.cos(tz);
          const sz = Math.sin(tz);
          const ae = cx * cz;
          const af = cx * sz;
          const be = sx * cz;
          const bf = sx * sz;
          const m00 = cy * cz;
          const m01 = -cy * sz;
          const m02 = sy;
          const m10 = af + be * sy;
          const m11 = ae - bf * sy;
          const m12 = -sx * cy;
          const m20 = bf - ae * sy;
          const m21 = be + af * sy;
          const m22 = cx * cy;

          for (let i = 0; i < count; i++) {
            const px = points[i * 3];
            const py = points[i * 3 + 1];
            const pz = points[i * 3 + 2];
            const x = m00 * px + m01 * py + m02 * pz;
            const y = m10 * px + m11 * py + m12 * pz;
            const z = m20 * px + m21 * py + m22 * pz;
            const axv = x < 0 ? -x : x;
            const azv = z < 0 ? -z : z;
            const reach = axv > azv ? axv : azv;
            if (axv > uHalf) uHalf = axv;
            if (reach > footHalf) footHalf = reach;
            if (y <= ROOT_BAND && reach > rootHalf) rootHalf = reach;
            const v = y * COS_E - z * SIN_E;
            if (v < vMin) vMin = v;
            if (v > vMax) vMax = v;
            const d = y * SIN_E + z * COS_E;
            if (d < dMin) dMin = d;
            if (d > dMax) dMax = d;
          }
        }
      }
    }
  }

  if (count <= 0) {
    return { uHalf: 0, vMin: 0, vMax: 0, dMid: 0, dSpread: 0, footHalf: 0, rootHalf: 0 };
  }
  return {
    uHalf,
    vMin,
    vMax,
    // Midpoint of the toward-camera extent, not a vertex-weighted mean. A mean over a point
    // cloud is a function of where the tessellation put its vertices — the face alone is
    // 1,074 of the 1,806 points at detail 2, all of them on the crown — so it moved by 0.26
    // of a tooth height when the face was added and reported that as a change of shape.
    dMid: (dMin + dMax) / 2,
    dSpread: (dMax - dMin) / 2,
    footHalf,
    rootHalf,
  };
}

/**
 * How far a measured sweep may sit *under* the written constant before it is called stale.
 *
 * Two things legitimately separate them and nothing else does: the sweep grid's own
 * coarseness (`SWEEP_MARGIN`, 0.001) and the spread between the three detail levels the
 * constants are a bound over, which is measured at **0.0234** (`vMin`, −0.0605 at detail 2
 * against −0.0839 at detail 1). 0.03 covers both with 20 % to spare and is still an order
 * tighter than the 0.02-of-a-tooth-height it replaces was being *applied* at — that guard
 * compared the swept mascot with one bare upright body, a difference of up to 0.11, so four
 * of its six comparisons could never have been meaningful in either direction.
 */
export const SILHOUETTE_TOLERANCE = 0.03;

/**
 * Returns a human-readable complaint if the geometry has drifted away from
 * `TOOTH_SILHOUETTE`, or `null` when the constants are still honest.
 *
 * `measured` must come from `sweepSilhouette` over the whole mascot — the same quantity the
 * constants are. Every field is checked in **both** directions and the two directions mean
 * different things:
 *
 *  • *over* the constant by any margin at all is a **proof failure**: the box the solver
 *    proves disjointness for is smaller than the silhouette on screen. Only `SWEEP_MARGIN`
 *    of grid slack is allowed.
 *  • *under* it by more than `SILHOUETTE_TOLERANCE` is **staleness**: the constants are
 *    conservative, so the proof still holds, but every board is being spread for a tooth
 *    bigger than the one being drawn and every tooth is smaller on screen than it needs to
 *    be. That is a real defect in a game whose whole problem is legibility, and it is the
 *    direction a lazy fix drifts in.
 */
export function checkSilhouette(measured: Silhouette): string | null {
  const bad: string[] = [];
  const over = (name: string, m: number, c: number): void => {
    if (m > c + SWEEP_MARGIN) bad.push(`${name} ${m.toFixed(4)} exceeds ${c}`);
    else if (m < c - SILHOUETTE_TOLERANCE) bad.push(`${name} ${m.toFixed(4)} well under ${c}`);
  };
  const under = (name: string, m: number, c: number): void => {
    if (m < c - SWEEP_MARGIN) bad.push(`${name} ${m.toFixed(4)} below ${c}`);
    else if (m > c + SILHOUETTE_TOLERANCE) bad.push(`${name} ${m.toFixed(4)} well above ${c}`);
  };
  over("uHalf", measured.uHalf, TOOTH_SILHOUETTE.uHalf);
  under("vMin", measured.vMin, TOOTH_SILHOUETTE.vMin);
  over("vMax", measured.vMax, TOOTH_SILHOUETTE.vMax);
  over("dSpread", measured.dSpread, TOOTH_SILHOUETTE.dSpread);
  over("footHalf", measured.footHalf, TOOTH_SILHOUETTE.footHalf);
  over("rootHalf", measured.rootHalf, TOOTH_SILHOUETTE.rootHalf);
  // `dMid` only moves the depth the whole box is projected at — it cannot make two
  // silhouettes overlap, so it is checked for staleness in both directions and nothing more.
  if (Math.abs(measured.dMid - TOOTH_SILHOUETTE.dMid) > SILHOUETTE_TOLERANCE) {
    bad.push(`dMid ${measured.dMid.toFixed(4)} vs ${TOOTH_SILHOUETTE.dMid}`);
  }
  return bad.length === 0
    ? null
    : `the counted mascot has changed shape — layout.ts TOOTH_SILHOUETTE is stale: ${bad.join(", ")}`;
}

/**
 * World scale of a tooth instance. **The one place this is computed.**
 *
 * The geometry is 1.0 unit tall, so a scatter's per-tooth variation has to be multiplied by
 * `TOOTH_H` before it reaches an instance matrix. Round 1 shipped without this and the whole
 * countability proof was written against a tooth 2.6x smaller than the one on screen.
 */
export const toothScale = (variation: number) => TOOTH_H * variation;

/** Largest scale any tooth can take — every constraint is sized for this. */
export const MAX_TOOTH_SCALE = TOOTH_H * (1 + TOOTH_SCALE_VAR);

/* ------------------------------------------------------------------ */
/* Separation constraints and the grid                                 */
/* ------------------------------------------------------------------ */

/**
 * Largest count any level can produce; every buffer in the game is sized from it once.
 *
 * It must equal `max(RANGE)` in `engine.ts`, and it is not derived from there so that this
 * module stays free of imports. The `count` self test asserts the two agree.
 */
export const MAX_COUNT = 14;

/**
 * Fraction of a tooth's own on-screen width that must separate two silhouettes.
 *
 * Resolution-independent by construction, which matters because the same board has to be
 * countable on a phone and on a laptop. 0.16 of a 65 px tooth is a 10 px channel of bare pad
 * between two teeth — visible at arm's length, and it survives the anti-aliasing.
 *
 * This single number is the definition of "countable" in this game. The grid pitch below is
 * *derived* from it rather than tuned against it, so the two can never drift apart: round 1
 * had a hand-written 0.09-unit world gap that satisfied nothing in particular.
 */
export const GAP_FRACTION = 0.16;

export type ScatterMetrics = {
  /** Screen-space half-width of one tooth including its lean, in world units. */
  uHalf: number;
  /** Half of the screen-up extent of one tooth including its lean, in world units. */
  vHalf: number;
  /** Centre of a tooth's screen-up extent, relative to its origin, in world units. */
  vMid: number;
  /** Mean toward-camera offset of one tooth's surface from its origin, in world units. */
  dMid: number;
  /** Half-width of the whole prop's reach on the pad — what has to stay over the coral. */
  footprint: number;
  /**
   * Half-width of the part of the prop that is actually near the pad (`rootHalf`), which is
   * what a *contact* shadow covers. Less than half of `footprint`: a tooth is widest at its
   * crown, 0.8 of a height up in the air, and sizing the contact pool from that is what put
   * a blob 2.6x too big under every one of them.
   */
  contact: number;
  /** Minimum |Δx| that separates two teeth regardless of their Δz (orthographic estimate). */
  sx: number;
  /** Minimum |Δz| that separates two teeth regardless of their Δx (orthographic estimate). */
  sz: number;
};

/**
 * Derives the grid's separation constraints from the tooth's real silhouette.
 *
 * These are the *orthographic* estimates. They size the grid, and the grid is what makes the
 * exact NDC test below pass on the first try essentially always; the NDC test is what makes
 * the grid safe to trust. Neither is decorative.
 *
 * Every term is one thing. The old implementation added `sin(TOOTH_TILT)` to `uHalf`,
 * `vHalf` and `footHalf` as a flat "lean" pad on top of constants that were *already* swept
 * over the lean — the tilt was paid for twice — and then spent the surplus, in a comment, on
 * the idle sway. `TOOTH_SILHOUETTE` now sweeps the tilt *and* the sway, so the only thing
 * left to add is the one transient that is a world-space translation rather than a rotation:
 * `IDLE_BOB`, which does not scale with the tooth and therefore cannot live in a table
 * expressed per unit of tooth height.
 */
export function scatterMetrics(sil: Silhouette = TOOTH_SILHOUETTE): ScatterMetrics {
  const s = MAX_TOOTH_SCALE;
  const uHalf = sil.uHalf * s * INTRA_PERSPECTIVE;
  // `IDLE_BOB` is a world offset, so it is added after the scale, not inside the table.
  const vHalf = ((sil.vMax - sil.vMin) / 2) * s * INTRA_PERSPECTIVE + IDLE_BOB * COS_E;
  const vMid = ((sil.vMax + sil.vMin) / 2) * s;
  // The demanded gap is a fraction of a tooth's *width* on both axes, because the screen
  // space the boxes are compared in is isotropic — a 10 px channel is a 10 px channel
  // whether it runs across the frame or up it.
  const gap = 2 * uHalf * GAP_FRACTION;
  return {
    uHalf,
    vHalf,
    vMid,
    dMid: sil.dMid * s,
    footprint: sil.footHalf * s,
    contact: sil.rootHalf * s,
    sx: 2 * uHalf + gap,
    sz: (2 * vHalf + gap) / SIN_E,
  };
}

export type Grid = { cols: number; rows: number; pitchX: number; pitchZ: number; cells: number };

/**
 * Cells per level, in three shapes.
 *
 * Easy 3–6 in 8–9 cells, Medium 5–10 in 12, Hard 8–14 in 15–18: every level keeps spare
 * cells, which is what stops even a full board from reading as a lattice.
 *
 * There are three shapes because there are three kinds of play area and a scatter that fits
 * one wastes the others. A `GameShell` interior is roughly square on a tablet, portrait on a
 * phone and 1.8:1 on a laptop, and the composition has to *hold* in all of them — a row costs
 * `sz · sin E ≈ 0.92` of screen height where a column costs `sx ≈ 0.90` of screen width, so
 * the two are near enough equal-area and the only question is which axis has the room.
 *
 * **Above `WIDE_ASPECT`** the grid spreads sideways into the room that is actually there,
 * instead of leaving a third of the frame as bare cream on either side.
 *
 * **Below `TALL_ASPECT`** it does the opposite, and that is round 3's B7.4. Measured, at
 * 390 x 844 (aspect 0.462, chrome 138 px) — smallest camera distance that holds *every*
 * bound including the board's own corners, and the resulting tooth height in CSS px:
 *
 *   | aspect | 4x4 | 3x5 | 3x4 | 3x3 |
 *   |---|---|---|---|---|
 *   | 0.46 | **no fit** | 15.4 u / 78 px | 15.9 u / 81 px | 15.5 u / 83 px |
 *   | 0.50 | **no fit** | 15.3 / 84 | 15.7 / 88 | 15.3 / 90 |
 *   | 0.55 | 16.0 / 75 | 15.3 / 84 | 14.4 / 96 | 14.0 / 99 |
 *   | 0.60 | 15.7 / 82 | 15.3 / 84 | 13.8 / 100 | 13.0 / 107 |
 *   | 0.70 | 14.6 / 95 | 15.3 / 84 | 13.8 / 100 | 11.3 / 124 |
 *   | 0.75 | 13.8 / 100 | 15.3 / 84 | 13.8 / 100 | 11.3 / 124 |
 *
 * Below 0.55 the four-column shapes cannot hold the board at all: the live solve drops the
 * board's own corners (they are the only *preferred* bound) and ships a mat guillotined by
 * both side edges, which is what round 3 photographed. Above 0.72 they are the larger tooth.
 * `TALL_ASPECT` is that crossover, and it is where the Medium pair crosses too (4x3 reaches
 * 3x4's 100 px at 0.72). The Hard pair crosses at 0.60, so between 0.60 and 0.72 the tall
 * table costs Hard up to 11 px of tooth to keep Medium's 16; both shapes hold every bound
 * there, so nothing is clipped either way and the trade is legibility against legibility.
 */
const GRIDS: readonly { cols: number; rows: number }[] = [
  { cols: 3, rows: 3 },
  { cols: 4, rows: 3 },
  { cols: 4, rows: 4 },
];

const WIDE_GRIDS: readonly { cols: number; rows: number }[] = [
  { cols: 4, rows: 2 },
  { cols: 6, rows: 2 },
  { cols: 6, rows: 3 },
];

const TALL_GRIDS: readonly { cols: number; rows: number }[] = [
  { cols: 3, rows: 3 },
  { cols: 3, rows: 4 },
  { cols: 3, rows: 5 },
];

/**
 * A fourth set, for a frame that is short rather than narrow.
 *
 * The three tables above trade columns against rows on the play area's *aspect*, which is the
 * right axis when the frame is roomy. It is not the right axis when the frame is **short** —
 * a 360 x 640 shell under a 273 px chrome band has 367 px of usable height and plenty of
 * width, and there the question is not "which way is the frame long" but "how few rows can
 * hold the count". A row costs `pitchZ · sin E` = 1.00 world units of screen-up; a column
 * costs `pitchX` = 0.90 of screen-width. On that shell, height is 2.7x scarcer.
 *
 * So Hard gets a **5 x 3** — fifteen cells, the same as `TALL_GRIDS`' 3 x 5, one spare over
 * the fourteen it draws, in three rows instead of five. `gridShapes` offers it alongside the
 * others and `cameraFor` picks whichever draws the biggest tooth, so it costs nothing
 * anywhere it does not win. Measured at 360 x 640 under a 273 px band: **37.6 px -> 42.8 px**,
 * which is the difference between a countable board and one that is not (§3.7).
 *
 * Easy and Medium reuse shapes the other tables already carry, so this table adds exactly one
 * new arrangement to the product.
 */
const SHORT_GRIDS: readonly { cols: number; rows: number }[] = [
  { cols: 4, rows: 2 },
  { cols: 6, rows: 2 },
  { cols: 5, rows: 3 },
];

/** Play-area aspect above which the wide shapes are used. */
export const WIDE_ASPECT = 1.55;
/** Play-area aspect below which the tall shapes are used. See the table above. */
export const TALL_ASPECT = 0.72;

/** Largest `cols x rows` any table above produces (`WIDE_GRIDS` 6x3). */
export const MAX_CELLS = 18;
/** Largest `rows` any table above produces (`TALL_GRIDS` 3x5). Sizes the row-slide scratch. */
const MAX_ROWS = 5;
export const LEVELS = GRIDS.length;

/**
 * Headroom over the bare separation constraint.
 *
 * Only 9%: the old 30-odd percent was buying jitter room the solver no longer needs, because
 * phase 2 tests every candidate move against the exact screen-space rule rather than against
 * a band computed up front. Every unspent percent here is a tooth that is bigger on screen,
 * which is the whole point (§3.7 legibility).
 */
const PITCH_HEADROOM = 1.09;

const gridOf = (
  shape: { cols: number; rows: number },
  m: ScatterMetrics
): Grid => ({
  cols: shape.cols,
  rows: shape.rows,
  pitchX: m.sx * PITCH_HEADROOM,
  pitchZ: m.sz * PITCH_HEADROOM,
  cells: shape.cols * shape.rows,
});

/**
 * Every shape a level may be laid out in, most-columns first.
 *
 * `WIDE_ASPECT` / `TALL_ASPECT` used to *choose* between the three tables from the play
 * area's aspect alone, and the table above them is honest about how that number was found:
 * the smallest camera distance that holds every bound, measured at **scale 1**. Since
 * `CameraFraming.scale` exists that is the wrong question — a shape that needs the world
 * shrunk to 0.70 loses to one that needs 0.82 even if the first "fits" and the second does
 * not — and the thresholds were measured at a 138 px chrome band, against a real one of 273.
 *
 * So the shapes are now *candidates* and `cameraFor` picks the one that draws the biggest
 * tooth, which is the quantity §3.7 is actually about. Measured, at a real 273 px band:
 *
 *   | play area | level | 3-col (old pick) | 4-col | chosen |
 *   |---|---|---|---|---|
 *   | 390 x 745 | Hard   | 42 px | **51 px** | 4-col |
 *   | 390 x 745 | Medium | 51 px | **58 px** | 4-col |
 *   | 700 x 1050| Hard   | **74 px** | 88 px | 4-col |
 *   | 390 x 745 (138 px band) | Hard | **57 px** | 55 px | 3-col |
 *
 * Neither table dominates — which is exactly why a threshold could not express it.
 */
function gridShapes(level: number): readonly { cols: number; rows: number }[] {
  const i = clamp(level, 0, GRIDS.length - 1) | 0;
  const out: { cols: number; rows: number }[] = [];
  for (const table of [WIDE_GRIDS, SHORT_GRIDS, GRIDS, TALL_GRIDS]) {
    const g = table[clamp(i, 0, table.length - 1) | 0];
    if (!out.some((s) => s.cols === g.cols && s.rows === g.rows)) out.push(g);
  }
  return out;
}

/**
 * The shape this level takes at a given aspect, by the pre-round-4 thresholds.
 *
 * Kept as the *default* for the two places that have no framing to read one from — a
 * `boardFor` called before a camera exists, and the DEV geometry checks. Everything that
 * renders or measures reads `CameraFraming.board`, which is solved rather than looked up.
 */
export function gridFor(level: number, m: ScatterMetrics, aspect = 1): Grid {
  const table = aspect >= WIDE_ASPECT ? WIDE_GRIDS : aspect <= TALL_ASPECT ? TALL_GRIDS : GRIDS;
  return gridOf(table[clamp(level, 0, table.length - 1) | 0], m);
}

/* ------------------------------------------------------------------ */
/* The board                                                           */
/* ------------------------------------------------------------------ */

/**
 * The board is a **clay tray with a real well**, not two slabs stacked.
 *
 * Round 3, B7.7: the coral field used to be a 0.055-thick plate standing `PAD_PROUD = 0.018`
 * above a flat mat — *below* §3's 0.02 minimum bevel, so the geometry physically could not
 * roll at that edge and the largest surface in the frame transitioned to the rim in three
 * pixels with no darkening on either side. There was no crevice anywhere in this scene for
 * curvature-AO to find, because there was no crevice in the model.
 *
 * `clayTray` is the shared answer: an outer wall with a rolled lip, a filleted inner wall and
 * a flat well floor. The coral is a plate laid *in* the well, tucked under the fillet so its
 * own edge is never seen, and the rim stands `MAT_H - MAT_FLOOR - PAD_LAY` = **0.136 units**
 * above it — seven times the minimum bevel, a real wall to cast onto the coral and a real
 * crevice for the AO.
 */
export const MAT_H = 0.2;
/**
 * Wall thickness of the tray.
 *
 * `clayTray` insets its flat floor by `rim + fillet`, and the fillet is `0.4` of the well's
 * depth: measured across three detail levels and every board size this game produces, the
 * inset is **`rim + 0.0384`** and the floor sits at exactly `0.30 x MAT_H`, to within
 * 0.0002. `MAT_MARGIN` has to clear that inset or the coral plate would ride up the fillet.
 */
export const MAT_RIM = 0.22;
/**
 * Where `clayTray` puts its well floor, as a fraction of the tray's height, and how much
 * the measurement is allowed to move before this file is wrong.
 *
 * Written down rather than recomputed because `PAD_TOP` and `TOOTH_Y` have to be constants —
 * the camera is solved on the DOM side, before any geometry exists. The scene measures the
 * real tray on mount and `?selftest=count` fails hard if it has drifted, so this is a
 * checked assumption rather than an assumed one.
 */
export const MAT_FLOOR_FRACTION = 0.3;
export const MAT_FLOOR_TOLERANCE = 0.004;

/**
 * Everything that rests on the cream ground is floated by this much.
 *
 * A slab whose underside is exactly coplanar with the ground plane is a shimmering edge
 * waiting to happen — the bottom face is back-facing and culled, but the rounded bevel
 * wraps round to meet it, and that band *is* front-facing. 0.6 mm at product scale is
 * invisible and settles it.
 */
export const GROUND_LIFT = 0.006;
/** World Y of the tray's rim — the highest clay on the board. */
export const MAT_Y = MAT_H + GROUND_LIFT;
/** World Y of the tray's well floor, which the coral plate is laid on. */
export const MAT_FLOOR = MAT_H * MAT_FLOOR_FRACTION + GROUND_LIFT;

/**
 * The coral plate in the well.
 *
 * 0.05 thick: `roundedPlate` refuses anything under `MIN_BEVEL / 0.45` = 0.0444 (A20), and
 * anything thicker would reach below the tray's own base. As laid it spans y 0.020 to 0.070,
 * entirely inside the tray's solid floor except the `PAD_LAY` that is the visible surface.
 * The plate is drawn wider than the flat floor so its rim disappears under the fillet — see
 * `scene.tsx`, which sizes it from the tray geometry it actually built.
 */
export const PAD_T = 0.05;
export const PAD_CORNER = 0.3;
/** How far the coral sheet stands above the tray's own floor. */
export const PAD_LAY = 0.004;
export const PAD_TOP = MAT_FLOOR + PAD_LAY;
export const PAD_Y = PAD_TOP - PAD_T / 2;
/** Depth of the well above the coral — the crevice §3 wants and B7.7 said did not exist. */
export const PAD_WELL = MAT_Y - PAD_TOP;
/** World Y of a tooth's origin (the base of its roots). */
export const TOOTH_Y = PAD_TOP - TOOTH_SINK;

/** Clay margin between the outermost tooth and the edge of the coral field. */
const PAD_MARGIN = 0.16;

/**
 * Extra coral behind the back row, so a back tooth's **crown** does not break the tray's
 * outer silhouette. Round 4, CT5.
 *
 * At 52° of elevation a tooth's silhouette only ever grows *up*-screen from its root, so the
 * back row is the row that projects over the rim. The arithmetic is exact and — usefully —
 * independent of how big the board is, because every term below moves with `clampZ`:
 *
 *   crown top, screen-up   `screenUp(TOOTH_Y, −clampZ) + vMid + vHalf`
 *                        = `TOOTH_Y·cos E + clampZ·sin E + 0.2968 + 0.3968`
 *                        = `0.72314 + 0.788·clampZ`
 *   tray's outer rim top   `screenUp(MAT_Y, matBackZ)`
 *                        = `MAT_Y·cos E + (clampZ + footprint + 0.02 + MAT_MARGIN)·sin E`
 *                        = `0.34747 + 0.788·clampZ`
 *
 * — a constant **0.0658 world units of screen-up above the tray's own outline**, on every
 * board, at every level, which is round 4's `count-the-teeth-rest.png` and `-tablet.png`:
 * the top-row teeth read as standing on the cream table behind the tray rather than in it.
 * (The coral field's own back edge is 0.3044 lower still, so a crown over some rim is
 * unavoidable at this elevation and is not what this fixes.)
 *
 * Pulling the back row forward by `Δz` lowers the crown by `Δz · sin E = 0.788 Δz`. 0.15
 * spends 0.1182 of that: it clears the 0.0658 overhang and leaves **0.0524** — 17 % of the
 * rim band's own 0.3044 screen height — so the crown sits inside the rim's outline with the
 * rim visible above it. The cost is 0.15 of board depth, +3.1 % on a phone's Medium board,
 * which moves the camera out by under 1 % (`?selftest=count` prints both).
 */
const BACK_CROWN_CLEAR = 0.15;
/**
 * Margin between the coral field and the outer silhouette of the tray.
 *
 * Must exceed `clayTray`'s own floor inset (`MAT_RIM + 0.0384` = 0.2584) or the logical pad
 * — the region teeth are clamped into — would extend past the flat floor and up the fillet.
 * 0.28 leaves 0.0216 of flat floor beyond the last legal tooth position on every side.
 */
const MAT_MARGIN = 0.28;

export const PIP_COUNT = 5;
export const PIP_R = 0.1;
export const PIP_H = 0.07;
export const PIP_PITCH = 0.3;
export const PIP_FILL_R = 0.07;
export const PIP_FILL_H = 0.06;
/** World Y of the pip sockets, which lie on the cream ground. */
export const PIP_Y = GROUND_LIFT;
/**
 * The pips moved from the back of the board to the ground **in front of** it.
 *
 * Round 3, B7.5: at 52 degrees of elevation a tooth standing at the back of the pad projects
 * its 0.94-of-a-height body up-screen across the rim and straight over the pip rail — two of
 * five pips covered by heads on every desktop capture, at every level, in a game about
 * counting objects on a surface. The arithmetic: the back-most legal tooth's silhouette top
 * reached `0.197` world units of screen-up **above** the pip's own top.
 *
 * Pulling the tooth clamp in would have cost the board depth, and deepening the back rail
 * would have cost 0.33 of board on the axis the phone framing has least of. Putting the row
 * in front costs neither, because a tooth's silhouette only ever grows *up*-screen from its
 * root: anything nearer the camera than the teeth is structurally safe. Measured on the new
 * geometry, the front-most legal tooth's box bottom clears the pips' top by **0.306** world
 * units of screen-up, and the answer tiles — nearer still, and only 0.2 tall — sit 0.42
 * below the pips. `?selftest=count` asserts all of it in NDC, per board, per viewport.
 */
const PIP_LANE = 2 * PIP_R + 0.1;

export const pipX = (index: number) => (index - (PIP_COUNT - 1) / 2) * PIP_PITCH;

/* ---- answer tiles ------------------------------------------------- */

export const TILE_W = 0.94;
export const TILE_D = 0.80;
export const TILE_T = 0.2;
export const TILE_CORNER = 0.17;
export const TILE_PITCH = 1.08;
export const TILE_Y = TILE_T / 2 + GROUND_LIFT;
/** Bare ground between the pip row and the back edge of the answer tiles. */
const TILE_GAP = 0.16;

/**
 * The label plate standing proud of the tile, and the numeral just above it.
 *
 * ## Where the plate sits, and why it moved (round 4, CT6)
 *
 * The plate used to be *buried*: `PLATE_DY = TILE_T/2 + 0.02 - PLATE_T/2` put its underside
 * 0.04 **inside** the tile and left 0.02 of it showing. `roundedBox` clamps its corner radius
 * to `0.9 x` the smallest half-extent, so on a 0.06-thick plate the rim is a 0.027
 * quarter-round — and the part of that quarter-round that is tangent to the horizontal is its
 * *lowest* point, which was the part underground. What a child saw was the rim's vertical
 * mid-band meeting the tile's flat top at ~90 degrees: a hard concave corner with no fillet,
 * one pixel wide, and no AO to soften it because the two solids share no vertices for
 * `bakeCurvatureAO` to weld. That is CT6's "1 px hard hairline groove", and §3 forbids it.
 *
 * The plate now rests *on* the tile's top plane, sunk by `PLATE_SINK`. At 0.008 into a 0.027
 * radius the rim meets the tile face at **45 degrees instead of 90**, as a soft valley the
 * key can shade across — and the geometry, not a texture, is what makes the gradient. The
 * plate stands `PLATE_T - PLATE_SINK` proud as a result, so the label reads as a pressed clay
 * boss rather than a decal, which is the other half of what CT6 asked for.
 */
export const PLATE_W = TILE_W - 0.2;
export const PLATE_D = TILE_D - 0.2;
export const PLATE_T = 0.06;
/**
 * How far the plate's underside is pushed below the tile's top face.
 *
 * Small on purpose. Zero would leave the two surfaces tangent at a single circle — a contact
 * with no overlap, which renders as a hairline of z-fighting rather than as clay. 0.008 is
 * 30 % of the rim's own 0.027 radius, which is the 45-degree contact angle above.
 */
export const PLATE_SINK = 0.008;
/** How far the plate stands off the tile's top face. Derived; do not set it directly. */
export const PLATE_PROUD = PLATE_T - PLATE_SINK;
/** Offset of the plate's centre along the tile's own +Y, from the tile's centre. */
export const PLATE_DY = TILE_T / 2 + PLATE_T / 2 - PLATE_SINK;
export const GLYPH_H = 0.3;
export const GLYPH_DY = TILE_T / 2 + PLATE_PROUD + 0.004;

/** How far a pressed tile sinks. 4 mm at product scale — a real, felt travel. */
export const TILE_SINK = 0.055;

export const tileX = (index: number) => (index - 1) * TILE_PITCH;

/**
 * Everything about the board that depends on how many teeth this level can hold.
 *
 * The board is sized *to the game*, not the game to the board: nine cells of Easy get a
 * 30 x 39 cm placemat and sixteen cells of Hard get a 38 x 50 cm one, and because
 * `cameraFor` fits whatever it is given, Easy is framed closer and its six teeth are
 * proportionally larger on screen. A fixed board would have meant framing every level for
 * fourteen teeth and showing three of them the size of peas.
 */
export type BoardMetrics = {
  level: number;
  grid: Grid;
  matW: number;
  matD: number;
  matCZ: number;
  matBackZ: number;
  matFrontZ: number;
  padW: number;
  padD: number;
  padCZ: number;
  pipZ: number;
  tileZ: number;
  tileFrontZ: number;
  /** Hard bounds on a tooth's centre, so no tooth can wander off the terracotta. */
  clampX: number;
  clampZ: number;
  /** Shadow frustum half-extent: bound the board and the tiles, not the world. */
  shadowArea: number;
};

export function boardFor(level: number, m: ScatterMetrics, aspect = 1): BoardMetrics {
  return boardForGrid(level, m, gridFor(level, m, aspect));
}

function boardForGrid(level: number, m: ScatterMetrics, grid: Grid): BoardMetrics {
  const spanX = (grid.cols - 1) * grid.pitchX;
  const spanZ = (grid.rows - 1) * grid.pitchZ;

  const padW = spanX + 2 * m.uHalf + 2 * PAD_MARGIN;
  // The field reaches `BACK_CROWN_CLEAR` further behind the last legal tooth than in front of
  // it, and the whole field (and the tray with it) shifts back by half of that so the teeth
  // stay centred on z = 0 and `clampZ` stays symmetric. See `BACK_CROWN_CLEAR`.
  const padD = spanZ + 2 * m.footprint + 2 * PAD_MARGIN + BACK_CROWN_CLEAR;
  const padCZ = -BACK_CROWN_CLEAR / 2;

  // The tray is symmetric about the coral field now that the pip rail is gone from its back.
  const matW = padW + 2 * MAT_MARGIN;
  const matD = padD + 2 * MAT_MARGIN;
  const matCZ = padCZ;
  const matBackZ = matCZ - matD / 2;
  const matFrontZ = matCZ + matD / 2;

  // Pips first, on the ground in front of the tray; then the answer row in front of them.
  const pipZ = matFrontZ + PIP_LANE / 2;
  const tileZ = matFrontZ + PIP_LANE + TILE_GAP + TILE_D / 2;

  return {
    level,
    grid,
    matW,
    matD,
    matCZ,
    matBackZ,
    matFrontZ,
    padW,
    padD,
    padCZ,
    pipZ,
    tileZ,
    tileFrontZ: tileZ + TILE_D / 2,
    clampX: padW / 2 - m.uHalf - 0.02,
    // Symmetric about z = 0 and deliberately *not* `padD / 2 - …`: the field is longer than
    // the tooth region by `BACK_CROWN_CLEAR`, and that extra length belongs to the rim, not
    // to the scatter. Written out from the grid so the two cannot drift.
    clampZ: spanZ / 2 + PAD_MARGIN - 0.02,
    /*
     * The shadow frustum, sized to what actually casts and receives — and **centred on the
     * world origin, because that is where `Rig` aims it** (`light.target.position.set(0,
     * groundY, 0)`).
     *
     * The old expression was `max(matW, tileFrontZ - matBackZ) + 1.0`: a *span* used where a
     * frustum width was wanted, on a composition that is not symmetric about z = 0. The tray
     * sits near the origin and the answer row sits `tileFrontZ` in front of it, so what has
     * to be covered around the origin is `2 · max(|matBackZ|, tileFrontZ)`, not their
     * difference. CT2 read this as slack to reclaim; measured, it is **wrong in both
     * directions**, which is worse:
     *
     *   | board | needed | old | new |
     *   |---|---|---|---|
     *   | Easy, 1440 x 745 | 5.42 | 5.59 | 6.22 |
     *   | Easy, 390 x 745, 273 px band | 6.68 | **6.57 — short** | 7.48 |
     *   | Hard, 1440 x 745 | 6.68 | 7.55 | 7.48 |
     *
     * The row in bold is an answer tile whose front edge was **outside the shadow camera**:
     * its cast shadow simply stopped, mid-tile, on a control a child is looking at. So this
     * is a correctness fix that happens to tighten two boards out of three, and CT2's GPU
     * saving comes from the draw-call collapse in `scene.tsx`, not from here.
     *
     * `SHADOW_SLACK` covers the light's own obliquity — the key arrives at 47.6°, so a prop
     * of height `h` throws its shadow `h / tan(47.6°) = 0.91 h` along the ground from its
     * base, and the tallest caster is a tooth at `MAX_TOOTH_SCALE` 0.77. 0.8 covers it on
     * every side. The scene multiplies the result by `CameraFraming.scale`, because the world
     * this bounds is the scaled one.
     */
    shadowArea:
      2 * Math.max(matW / 2, matD / 2 - matCZ, tileZ + TILE_D / 2) + SHADOW_SLACK,
  };
}

/** Ground reach of the tallest caster along the key's own direction. See `shadowArea`. */
const SHADOW_SLACK = 0.8;

/* ------------------------------------------------------------------ */
/* Camera                                                              */
/* ------------------------------------------------------------------ */

/** `3D-SPEC §2` — "Distance 8–16 units". Not a tuning knob. */
export const MIN_DISTANCE = 8;
export const MAX_DISTANCE = 16;

/**
 * Fallback height of `GameShell`'s title + HUD band, in CSS px.
 *
 * A fallback, not a constant: `GameShell` measures its own chrome and publishes the real
 * figure on the play area as the `--chrome-h` custom property, which `CountTheTeeth.tsx`
 * reads and passes to `cameraFor`. This number is only what the solve uses before that
 * property exists (SSR, or a host that mounts a `<Scene3D>` outside a shell). Guessing it
 * is how round 1 pushed the answer tiles out the bottom of the frame (§3.7 G-CT-2).
 */
export const CHROME_PX = 138;

/**
 * `GameShell`'s chrome as a **rect** in play-area CSS pixels, which is what A9 publishes.
 *
 * `--chrome-h` is a height and says nothing about where across the width the controls are;
 * `--chrome-bottom` is the bottom of the union of the real control clusters and is `<=` it.
 * Both are honoured here: `bottom` is the keep-clear floor and `left`/`right` say how much
 * of the width that floor applies to. On a phone the title block and the chip group between
 * them span the whole width and the rect degenerates to the band, which is correct — it is
 * genuinely a band there.
 */
export type ChromeRect = { top: number; bottom: number; left: number; right: number };

/**
 * The `world-edge` feather, in CSS pixels — `src/index.css` `.world-edge { --feather: 30px }`.
 *
 * The play area is fogged to the page colour over the outermost 30 px of all four sides, at
 * full opacity for the first pixel and 72 % at 9 px. Anything inside that strip is not
 * *visible*, whatever the projection says, and round 4's `count-the-teeth-phone.png` shows
 * exactly that: the right-hand tooth's outer third is dissolved into cream.
 *
 * It replaces `EDGE_MARGIN = 0.985` / `EDGE_MARGIN_U = 0.99`, which were **fractions of the
 * frame** — 0.015 of half-height is 5.6 px on a 745 px phone and 1 px of half-width on the
 * u axis, against a 30 px feather. A fixed CSS-pixel inset is the honest expression of a
 * fixed CSS-pixel gradient, and it grows *relatively* on a small screen, which is where the
 * fog costs the most.
 */
const WORLD_EDGE_FEATHER = 30;
/**
 * Slack for `CameraRig`'s idle breathe, which moves the camera by up to
 * `BREATHE_COMPONENT`-ish per axis after the framing has been solved. Charged against the
 * frame edges so a breathing camera can never bring a tile into contact with them.
 */
const BREATHE_SLACK = 0.012;

export type CameraFraming = {
  position: [number, number, number];
  target: [number, number, number];
  fov: number;
  /** Distance from the aim point to the eye. */
  r: number;
  /** Aim point offset along the camera's own up vector, from the world origin. */
  lift: number;
  /** Frame aspect, as the projection will be given it. */
  aspect: number;
  /**
   * The board this framing was solved *for*, and the one the scene must draw.
   *
   * Published rather than re-derived. `boardFor(level, m, aspect)` used to be called
   * independently by the scene, by `?selftest=count` and by `cameraFor`, on the assumption
   * that a shared `(level, m, aspect)` made them agree. That is no longer true — the grid
   * shape is *solved* now, against the chrome band and the pixel height as well (see
   * `gridShapes`) — and "frame one board, then render a different one" is precisely how a
   * sweep can come back green on a composition nobody ever draws.
   */
  board: BoardMetrics;
  /** `tan(fov / 2)`, so everything downstream measures against the lens actually chosen. */
  tanHalf: number;
  /** Fraction of the frame's height covered by `GameShell`'s chrome band, at the top. */
  chrome: number;
  /**
   * The `world-edge` feather plus the camera-breathe slack, in `projectPoint`'s units.
   *
   * Anything nearer a frame edge than this is inside the fog gradient and is not visible,
   * however cleanly it projects. Published so `auditScatter` and `?selftest=count` measure
   * against the same edge the solve does.
   */
  edge: number;
  /**
   * The chrome keep-clear rect's horizontal span, in `projectPoint` units.
   *
   * The rect is `x` in `[left, right]`, `y` from `visibleTop(f)` up to `+1`. Published so a
   * check can measure a **DOM** occluder — which is what CT1 was, and what §6.7's rendered
   * proof is structurally incapable of seeing: it is an offscreen ID render of the 3D scene,
   * and a frosted difficulty pill is not in it.
   */
  chromeSpan: { left: number; right: number };
  /**
   * Uniform scale the **whole composition** is rendered at, `SCALE_MIN..1`.
   *
   * ## Why this exists (round 4, CT1)
   *
   * `cameraFor` used to end with an "unreachable" fallback — `r = MAX_DISTANCE`, `lift = 0`
   * — for the case where no distance in 8–16 and no lens in 26–32 can hold the composition
   * below the chrome band. It is not unreachable. Driven headlessly over the real numbers,
   * it fires at **every phone shape as soon as the band passes ~170 px**, and `GameShell`'s
   * band on a 390 × 844 phone measures ~273 px (a two-line title, a two-line subtitle and a
   * difficulty row that wraps the chip group onto a second line). In that state the framing
   * satisfies nothing at all: the back row's crowns land up to **0.25 of NDC above the
   * visible top**, i.e. behind the difficulty pills and the timer chip. That is round 4's
   * `count-the-teeth-phone.png`, and it is a counting game with a tooth behind a control.
   *
   * Nothing else could give. §2 fixes the distance band at 8–16 and the lens at 26–32; the
   * answer tiles are the game's only controls and may not shrink below the 48 px floor; the
   * pips are the round's only progress feedback. What *can* give is the size of the world:
   * a composition scaled by `s` and viewed from the same distance is the identical picture,
   * one step smaller. So the solve now bisects `s` until a fit exists, and the "unreachable"
   * branch is genuinely unreachable because a small enough `s` always fits.
   *
   * §2's 8–16 band is untouched and is still asserted: it is a statement about the *look*
   * (how much perspective compression the frame carries), which depends on distance relative
   * to subject size. Scaling the subject and keeping `r` inside the band preserves that
   * ratio exactly; pushing `r` past 16 at a fixed subject size would have been the same
   * picture expressed in a way the spec forbids.
   *
   * Everything in `layout.ts` stays in **unscaled** world units — the scatter, the board, the
   * silhouette table, `solveScatter`. Only the projection knows about `scale`, so a proof
   * written in world units still describes the pixels. The scene applies it once, on a single
   * group node, and pre-multiplies the three collider positions it mounts outside that group.
   */
  scale: number;
};

/**
 * Smallest the composition may be scaled to before the solve gives up and says so.
 *
 * Derived, not chosen: at 0.55 the worst rect the shell can produce (a 360 × 600 shell with a
 * 300 px band) still frames a Hard board, and the tooth it draws is 34 CSS px tall — the
 * point at which `?selftest=count`'s legibility assertion says the board has stopped being
 * countable in three seconds and the *shell* has to give the game more room. Reaching it is
 * a bug in the caller, not a framing to ship, so it logs.
 */
export const SCALE_MIN = 0.55;

/**
 * One point the framing has to contain, in the camera's own basis.
 *
 * `u` is |screen-right|, `v` is screen-up and `d` is toward-camera; all three are computed
 * from world coordinates without reference to the camera's position, which is what makes the
 * fit below solvable in closed form for a given `r`.
 */
type Bound = { u: number; v: number; d: number; required: boolean };

const bounds: Bound[] = [];

/** A real world point — a board corner, a tile corner, a pip. */
const pushBound = (u: number, y: number, z: number, required: boolean): void => {
  bounds.push({ u: u < 0 ? -u : u, v: screenUp(y, z), d: towardCamera(y, z), required });
};

/**
 * A point already expressed in the camera's basis.
 *
 * The teeth have to be bounded this way, because `vMid` and `vHalf` are *screen-up* offsets,
 * not world heights: pushing `TOOTH_Y + vMid + vHalf` through `screenUp` multiplies them by
 * `cos E` a second time and reports a back-row crown 0.27 units lower than it really is —
 * which is how round 1's framing could believe a composition fitted while a quarter of it
 * was outside the frame.
 */
const pushBoundUV = (u: number, v: number, d: number, required: boolean): void => {
  bounds.push({ u: u < 0 ? -u : u, v, d, required });
};

/**
 * Everything the frame must hold, tagged by whether it may be sacrificed.
 *
 * **Required** are the three answer tiles (the game's only controls, and round 1's blocker:
 * they were bisected by the bottom of the play area at every viewport measured), every tooth
 * the scatter can reach, and the round pips. **Preferred** are the board's own corners: if a
 * viewport is so extreme that something has to go, a sliver of clay leaving the frame is a
 * composition the child can still play, and a half-drawn button is not.
 */
function collectBounds(b: BoardMetrics, m: ScatterMetrics): void {
  bounds.length = 0;
  const tileOuter = TILE_PITCH + TILE_W / 2;

  // Answer tiles: the top-back and bottom-front corners bracket their whole screen extent.
  pushBound(tileOuter, TILE_T, b.tileZ - TILE_D / 2, true);
  pushBound(tileOuter, TILE_T, b.tileFrontZ, true);
  pushBound(tileOuter, 0, b.tileFrontZ, true);

  // Teeth: the four corners of the box a full-size tooth would occupy at the far corners of
  // its own field. `d` is the depth `toothNdcBox` projects at, so these constraints and the
  // audit's frame test are the same arithmetic.
  const toothU = b.clampX + m.uHalf;
  for (let i = 0; i < 2; i++) {
    const z = i === 0 ? -b.clampZ : b.clampZ;
    const v = screenUp(TOOTH_Y, z) + m.vMid;
    const d = towardCamera(TOOTH_Y, z) + m.dMid;
    pushBoundUV(toothU, v + m.vHalf, d, true);
    pushBoundUV(toothU, v - m.vHalf, d, true);
  }

  // Round pips, on the ground in front of the tray. Both z edges, because they now sit
  // between two things that are both required and the row is 0.2 deep.
  pushBound(pipX(PIP_COUNT - 1) + PIP_R, PIP_Y + PIP_H, b.pipZ - PIP_R, true);
  pushBound(pipX(PIP_COUNT - 1) + PIP_R, PIP_Y, b.pipZ + PIP_R, true);

  // The board itself.
  pushBound(b.matW / 2, MAT_Y, b.matBackZ, false);
  pushBound(b.matW / 2, MAT_Y, b.matFrontZ, false);
  pushBound(b.matW / 2, 0, b.matFrontZ, false);
}

/**
 * With the camera at distance `r` on the fixed 52° elevation, a world point's projection
 * depends on only two numbers: its screen-up coordinate `v` and its toward-camera coordinate
 * `d`. Working it through, the aim point's own lift `L` cancels out of the depth entirely:
 *
 *     depth    = r − d
 *     vertical = v − L
 *     ndcY     = (v − L) / (tan · (r − d))
 *
 * So for a chosen `r`, every point turns into a one-sided linear constraint on `L`, and the
 * whole framing question becomes "is the intersection of those intervals non-empty". No
 * search over two variables, no orthographic approximation, and — unlike the round-1
 * implementation, which composed in an orthographic basis at the aim plane — it is exact for
 * the answer tiles, which sit 1.6 units nearer the camera than that plane and were therefore
 * pushed 11% outside a frame the old solve believed they were inside.
 */
/**
 * The frame's usable box, in the units `projectPoint` writes: `y` runs −1..1 over the play
 * area's height and `x` runs −aspect..aspect over its width.
 *
 * `chromeBottom` is subtracted from the top and applies only across `[chromeL, chromeR]`;
 * outside that span the composition may use the full frame. `fog` is the `world-edge`
 * feather converted into these units — the frame is 2 units tall over `height` CSS px, so a
 * CSS pixel is `2 / height` units **on both axes**, because this space is aspect-corrected.
 */
type Frame = {
  top: number;
  bottom: number;
  side: number;
  edge: number;
  chromeTop: number;
  chromeL: number;
  chromeR: number;
};

function frameFor(width: number, height: number, aspect: number, chrome: ChromeRect): Frame {
  const px = height > 0 ? 2 / height : 0;
  const fog = WORLD_EDGE_FEATHER * px + BREATHE_SLACK;
  const toX = (cssX: number) => (width > 0 ? (cssX / width) * 2 * aspect - aspect : 0);
  return {
    // Full-frame limits, used outside the chrome's horizontal span.
    top: 1 - fog,
    bottom: 1 - fog,
    side: aspect - fog,
    edge: fog,
    // …and the limit under the chrome. `2 * bottom / height` is the band as an NDC depth.
    chromeTop: 1 - (height > 0 ? (2 * chrome.bottom) / height : 0) - fog,
    chromeL: toX(chrome.left),
    chromeR: toX(chrome.right),
  };
}

function liftInterval(
  r: number,
  f: Frame,
  tan: number,
  scale: number,
  requiredOnly: boolean
): { lo: number; hi: number } | null {
  let lo = -Infinity;
  let hi = Infinity;
  for (let i = 0; i < bounds.length; i++) {
    const p = bounds[i];
    if (requiredOnly && !p.required) continue;
    const u = p.u * scale;
    const v = p.v * scale;
    const depth = r - p.d * scale;
    if (depth < 1) return null;
    const half = tan * depth;
    if (u > half * f.side) return null;
    // `u` is |screen-right|, so a bound sits under the chrome if *either* of its two mirror
    // positions does. Conservative by construction, and exact for the centred compositions
    // this game draws.
    const underChrome = -u <= f.chromeR && u >= f.chromeL;
    const top = underChrome ? f.chromeTop : f.top;
    const a = v - half * top;
    const b = v + half * f.bottom;
    if (a > lo) lo = a;
    if (b < hi) hi = b;
  }
  return lo <= hi ? { lo, hi } : null;
}

/** Smallest distance in `[MIN_DISTANCE, MAX_DISTANCE]` that frames everything, or null. */
function fitDistance(
  f: Frame,
  tan: number,
  scale: number,
  requiredOnly: boolean
): number | null {
  if (liftInterval(MAX_DISTANCE, f, tan, scale, requiredOnly) === null) return null;
  let lo = MIN_DISTANCE;
  let hi = MAX_DISTANCE;
  if (liftInterval(lo, f, tan, scale, requiredOnly) !== null) return lo;
  // 30 halvings resolve to under a micron; the loop is bounded and runs on resize only.
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    if (liftInterval(mid, f, tan, scale, requiredOnly) === null) lo = mid;
    else hi = mid;
  }
  return hi;
}

/** One candidate grid shape, framed. `tooth` is what the shapes are ranked on. */
type Solved = {
  board: BoardMetrics;
  fov: number;
  tan: number;
  r: number;
  interval: { lo: number; hi: number };
  scale: number;
  /** Projected half-height of the *back* row's largest tooth, in NDC. See `cameraFor`. */
  tooth: number;
  /** True when the tray's own corners are inside the frame — the *preferred* bounds held. */
  full: boolean;
  /** True when even `SCALE_MIN` could not hold the required bounds. */
  gaveUp: boolean;
};

/**
 * How much smaller a tooth may be, in exchange for a tray whose corners stay in frame.
 *
 * 8 %: under the difference a four-year-old can see between two props on the same board, and
 * against it, a mat guillotined by both side edges — which is what round 3 photographed at
 * 390 x 844 and what the *preferred* bound exists to avoid. Applied as a ranking bonus only;
 * a shape that keeps the corners never wins if it is more than 8 % worse to look at.
 */
const CORNERS_BONUS = 1.08;

/**
 * Frames one candidate board: shortest lens, then the board's own corners, then the world.
 *
 * The order is the order of increasing harm. The board's corners are the only *preferred*
 * bound — a sliver of clay leaving the frame is a composition the child can still play — and
 * shrinking the world is last because it costs legibility everywhere rather than at one edge.
 */
function solveShape(board: BoardMetrics, m: ScatterMetrics, frame: Frame): Solved {
  collectBounds(board, m);
  const fitAt = (s: number) => {
    const whole = fitLens(frame, s, false);
    if (whole !== null) return { ...whole, full: true };
    const required = fitLens(frame, s, true);
    return required === null ? null : { ...required, full: false };
  };

  let scale = 1;
  let fit = fitAt(1);
  let gaveUp = false;
  if (fit === null) {
    // Bisect: every bound's screen extent is monotone in `scale`, so one bisection finds the
    // largest world that fits. 24 halvings resolve `scale` to 3e-8.
    let lo = SCALE_MIN;
    let hi = 1;
    let found = fitAt(SCALE_MIN);
    if (found === null) {
      gaveUp = true;
      scale = SCALE_MIN;
      fit = {
        fov: FOV_BAND[FOV_BAND.length - 1],
        tan: tanHalfFov(FOV_BAND[FOV_BAND.length - 1]),
        r: MAX_DISTANCE,
        interval: { lo: 0, hi: 0 },
        full: false,
      };
    } else {
      for (let i = 0; i < 24; i++) {
        const mid = (lo + hi) / 2;
        const candidate = fitAt(mid);
        if (candidate === null) hi = mid;
        else {
          lo = mid;
          found = candidate;
        }
      }
      scale = lo;
      fit = found;
    }
  }

  // The back row's largest tooth, projected. `k` folds the scale and the size variation in
  // exactly as `toothNdcBox` does, so the ranking and the render agree.
  const k = scale;
  const depth = fit.r - (towardCamera(TOOTH_Y, -board.clampZ) * scale + m.dMid * k);
  const tooth = (m.vHalf * k) / (fit.tan * (depth < 1 ? 1 : depth));

  return {
    board,
    fov: fit.fov,
    tan: fit.tan,
    r: fit.r,
    interval: fit.interval,
    scale,
    tooth,
    full: fit.full,
    gaveUp,
  };
}

/** The shortest lens in the band that holds the composition at `scale`, or null. */
function fitLens(
  f: Frame,
  scale: number,
  requiredOnly: boolean
): { fov: number; tan: number; r: number; interval: { lo: number; hi: number } } | null {
  for (let i = 0; i < FOV_BAND.length; i++) {
    const tan = tanHalfFov(FOV_BAND[i]);
    const r = fitDistance(f, tan, scale, requiredOnly);
    if (r === null) continue;
    const interval = liftInterval(r, f, tan, scale, requiredOnly);
    if (interval === null) continue;
    return { fov: FOV_BAND[i], tan, r, interval };
  }
  return null;
}

/**
 * Frames the board from the play area's measured rect.
 *
 * `GameShell` hands a game the whole shell interior, which is 1.2:1 on a laptop and 0.55:1
 * on a phone held upright. One fixed distance cannot serve both, and neither can one fixed
 * aim point: the board grows with the level, so Hard needs 15 units where Easy needs 10.
 *
 * The solve is the smallest distance inside the spec's 8–16 band at which some aim point
 * frames the whole composition, and the aim point is then the centre of the interval that
 * works — which is what puts the composition in the middle of the *clear* part of the frame
 * rather than under the HUD.
 *
 * Three things give, in this order, and only as far as they have to:
 *
 *  1. **the lens**, 28 → 30 → 32°, shortest first;
 *  2. **the board's own corners** — the only *preferred* bound. A sliver of clay leaving the
 *     frame is a composition the child can still play; a half-drawn button is not;
 *  3. **the size of the world** (`CameraFraming.scale`), bisected down to `SCALE_MIN`.
 *
 * Step 3 replaces a fallback that claimed to be unreachable and was not — see
 * `CameraFraming.scale` for the measurement. With it there is no framing this function can
 * return that does not hold every required bound, at every aspect and every chrome band the
 * shell can produce, which is the property `?selftest=count` now asserts directly.
 *
 * `chrome` accepts the scalar `--chrome-h` or the A9 rect. The rect is strictly better: its
 * `bottom` is the bottom of the real control clusters rather than of the band's box, and its
 * `left`/`right` say how much of the width the keep-clear applies to.
 */
export function cameraFor(
  width: number,
  height: number,
  level: number,
  m: ScatterMetrics = scatterMetrics(),
  chrome: number | ChromeRect = CHROME_PX
): CameraFraming {
  const aspect = width > 0 && height > 0 ? width / height : 1.2;
  const rect: ChromeRect =
    typeof chrome === "number"
      ? { top: 0, bottom: chrome > 0 ? chrome : CHROME_PX, left: 0, right: width }
      : chrome;
  const frame = frameFor(width, height, aspect, rect);

  // The score is the *smallest* tooth the board can draw — the back row's, which is the
  // farthest from the camera. A shape that draws one big tooth and one tiny one is not a
  // countable board; the worst tooth is the one a four-year-old has to find.
  const rank = (s: Solved) => s.tooth * (s.full ? CORNERS_BONUS : 1);
  let best: Solved | null = null;
  for (const shape of gridShapes(level)) {
    const candidate = solveShape(boardForGrid(level, m, gridOf(shape, m)), m, frame);
    if (best === null || rank(candidate) > rank(best)) best = candidate;
  }

  if (best === null || best.gaveUp) {
    // The shell has handed the game less room than `SCALE_MIN` can hold in any shape. Ship
    // the smallest composition rather than an unsolved one, give up the keep-clear last of
    // all, and say so — at that point it is the shell's room that is wrong, not the framing.
    const noKeepClear = frameFor(width, height, aspect, { ...rect, bottom: 0 });
    let forced: Solved | null = null;
    for (const shape of gridShapes(level)) {
      const candidate = solveShape(boardForGrid(level, m, gridOf(shape, m)), m, noKeepClear);
      if (forced === null || rank(candidate) > rank(forced)) forced = candidate;
    }
    if (import.meta.env.DEV) {
      console.error(
        `[count-the-teeth] the play area is too small to frame the board: ${width}x${height} ` +
          `with a ${Math.round(rect.bottom)}px chrome band leaves less than SCALE_MIN ` +
          `(${SCALE_MIN}) of composition in any grid shape. Drawn at SCALE_MIN with the ` +
          `chrome keep-clear given up; the shell has to give the game more room.`
      );
    }
    if (forced !== null) best = forced;
  }

  const solved = best as Solved;
  const { fov, tan, r, interval, scale, board } = solved;
  const lift = (interval.lo + interval.hi) / 2;
  const ty = lift * COS_E;
  const tz = -lift * SIN_E;

  return {
    position: [0, ty + r * SIN_E, tz + r * COS_E],
    target: [0, ty, tz],
    fov,
    r,
    lift,
    aspect,
    board,
    // Reported as the fraction of the frame's height the keep-clear floor sits at, which is
    // what `visibleTop` and `auditScatter` measure against. No clamp: the old
    // `min(0.34, band / height)` under-reserved a 273 px band on a 745 px phone by 20 px and
    // told the rest of the file it had not.
    chrome: height > 0 ? rect.bottom / height : 0.2,
    chromeSpan: { left: frame.chromeL, right: frame.chromeR },
    edge: frame.edge,
    tanHalf: tan,
    scale,
  };
}

/**
 * Projects a world point into the same aspect-corrected screen space `NdcBox` uses:
 * `y` spans −1..1 over the frame, `x` spans −aspect..aspect, and the top `2 · chrome` of the
 * `y` range is behind `GameShell`'s title band.
 *
 * Exported so `?selftest=count` can assert, in the terms the defect was reported in, that no
 * answer tile is ever bisected by the bottom of the play area.
 */
export function projectPoint(
  f: CameraFraming,
  x: number,
  y: number,
  z: number,
  out: { x: number; y: number }
): void {
  // `x`, `y` and `z` are **unscaled** world coordinates — the space `boardFor`,
  // `solveScatter` and every constant in this file are written in. `f.scale` is the one node
  // between them and the camera, so it belongs here and nowhere else.
  const s = f.scale;
  const depth = f.r - towardCamera(y, z) * s;
  const inv = 1 / (f.tanHalf * (depth < 1 ? 1 : depth));
  out.x = x * s * inv;
  out.y = (screenUp(y, z) * s - f.lift) * inv;
}

/** Top of the visible band, in the units `projectPoint` writes. Below it lies the chrome. */
export const visibleTop = (f: CameraFraming) => 1 - 2 * f.chrome;

/* ------------------------------------------------------------------ */
/* Screen-space projection of one tooth                                */
/* ------------------------------------------------------------------ */

/**
 * A tooth's silhouette as an axis-aligned box in **aspect-corrected** device coordinates:
 * `y` runs −1..1 over the frame's height and `x` runs −aspect..aspect over its width, so a
 * unit is the same length in both axes. Comparing a horizontal gap with a vertical one — or
 * with a tooth's own width — is only meaningful in a space where that is true, which is why
 * this is not raw NDC.
 */
export type NdcBox = { x0: number; x1: number; y0: number; y1: number };

const makeBox = (): NdcBox => ({ x0: 0, x1: 0, y0: 0, y1: 0 });

/**
 * Projects a tooth's world-space screen box into NDC, exactly.
 *
 * The world box spans `[u0,u1] x [v0,v1]` over a depth range `[near, far]`. A point at world
 * offset `t` and depth `D` lands at `t / (tan · D)`, so the projection of the whole box is
 * bounded by evaluating each edge at both depths and taking the hull — which is correct
 * whether or not the box straddles the optical axis, and is where a single-depth
 * approximation quietly goes wrong for the outer columns.
 */
export function toothNdcBox(
  out: NdcBox,
  f: CameraFraming,
  m: ScatterMetrics,
  x: number,
  z: number,
  variation: number
): void {
  const s = f.scale;
  const k = (variation / (1 + TOOTH_SCALE_VAR)) * s;
  const uHalf = m.uHalf * k;
  const vHalf = m.vHalf * k;

  // One depth for the whole tooth — its surface's mean — with `INTRA_PERSPECTIVE` already
  // folded into the half-extents to cover the crown being nearer than the roots. What this
  // must get right is the depth difference *between* teeth, which is up to 15% across a
  // Hard board and is exactly what an orthographic test cannot see.
  const depth = f.r - (towardCamera(TOOTH_Y, z) * s + m.dMid * k);
  const inv = 1 / (f.tanHalf * (depth < 1 ? 1 : depth));

  const cx = x * s * inv;
  const cy = (screenUp(TOOTH_Y, z) * s + m.vMid * k - f.lift) * inv;
  const hx = uHalf * inv;
  const hy = vHalf * inv;
  out.x0 = cx - hx;
  out.x1 = cx + hx;
  out.y0 = cy - hy;
  out.y1 = cy + hy;
}

/* ------------------------------------------------------------------ */
/* The scatter field                                                   */
/* ------------------------------------------------------------------ */

export type Scatter = {
  count: number;
  level: number;
  x: Float32Array;
  z: Float32Array;
  yaw: Float32Array;
  tiltX: Float32Array;
  tiltZ: Float32Array;
  scale: Float32Array;
  /**
   * Which rung of the solve produced this board.
   *
   * `"free"` is the adventurous placement, `"tight"` a less adventurous one, `"grid"` exact
   * cell centres and `"shrunk"` the bounded last resort. `?selftest=count` asserts that
   * `"shrunk"` never happens and that `"grid"` is rare.
   */
  path: "free" | "tight" | "grid" | "shrunk";
};

export function createScatter(): Scatter {
  const f = () => new Float32Array(MAX_COUNT);
  return {
    count: 0,
    level: 0,
    x: f(),
    z: f(),
    yaw: f(),
    tiltX: f(),
    tiltZ: f(),
    scale: f(),
    path: "grid",
  };
}

/* ------------------------------------------------------------------ */
/* The board, in words                                                 */
/* ------------------------------------------------------------------ */

/**
 * Row names, indexed by how many rows actually hold a tooth. Back to front, because that is
 * the order the eye reads the board in and the order the teeth land in.
 */
const ROW_LABELS: readonly (readonly string[])[] = [
  [],
  ["On the mat"],
  ["Back row", "Front row"],
  ["Back row", "Middle row", "Front row"],
  ["Back row", "Second row", "Third row", "Front row"],
  ["Back row", "Second row", "Middle row", "Fourth row", "Front row"],
];

/**
 * The arrangement on the mat, as something a screen reader can read out — row by row, left
 * to right, one "tooth" per tooth.
 *
 * **This is the game, for a child who cannot see the board.** X4 / §3.7 G-CT-7: round 1
 * announced the three candidate answers and nothing else, which is a one-in-three guess with
 * no way to do better. The scene also taps `sounds.pop()` once per tooth as they land, and
 * that is a lovely cue — but audio now ships **muted** (S24), so a run that depends on it is
 * a run a blind child cannot play on a device nobody has unmuted. A spoken list does not
 * depend on the speaker, on reduced motion, or on the child having been listening at the
 * moment the round dealt.
 *
 * It deliberately does **not** say how many there are. That is the question. What it gives is
 * exactly what a sighted player gets from the frame — where the teeth are — and the counting
 * is still theirs to do.
 *
 * Rows are recovered from `z` by rounding to the grid, which is exact: the solver's largest
 * per-tooth Z offset is `REACH_Z = 0.38` of a pitch, so a tooth can never round into its
 * neighbour's row.
 *
 * Allocates, and is meant to: it runs once per round from a discrete event, never per frame.
 */
export function describeArrangement(out: Scatter, b: BoardMetrics): string {
  const n = out.count;
  if (n <= 0) return "The mat is empty.";

  const rows = b.grid.rows;
  const half = (rows - 1) / 2;
  const buckets: number[][] = [];
  for (let r = 0; r < rows; r++) buckets.push([]);
  for (let i = 0; i < n; i++) {
    const r = clamp(Math.round(out.z[i] / b.grid.pitchZ + half), 0, rows - 1) | 0;
    buckets[r].push(i);
  }

  const used = buckets.filter((row) => row.length > 0);
  const labels = ROW_LABELS[used.length] ?? [];
  const parts: string[] = [];
  for (let r = 0; r < used.length; r++) {
    // Left to right, as read.
    used[r].sort((a, c) => out.x[a] - out.x[c]);
    const label = labels[r] ?? `Row ${r + 1}`;
    parts.push(`${label}: ${used[r].map(() => "tooth").join(", ")}`);
  }
  return `${parts.join(". ")}.`;
}

/** Deterministic PRNG, so a failing layout can be reproduced from its seed alone. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* Solver scratch. Reused across calls; the solver is synchronous, so it never re-enters. */
const cellOrder = new Int32Array(MAX_CELLS);
const rowOffX = new Float32Array(MAX_ROWS);
const baseX = new Float32Array(MAX_COUNT);
const baseZ = new Float32Array(MAX_COUNT);
const boxes: NdcBox[] = [];
for (let i = 0; i < MAX_COUNT; i++) boxes.push(makeBox());
const probe = makeBox();

/**
 * Fraction of a row's X pitch a whole row may slide.
 *
 * Free, and it is what destroys the column alignment: rows are separated in Z by more than a
 * tooth is tall on screen, so no X slide of a whole row can ever bring two teeth together.
 * There is deliberately **no** Z slide — round 1 had one, and sliding a row in Z eats the
 * very separation the row slide relies on, which is why one board in three arrived illegal
 * and had to be re-drawn.
 */
const ROW_SLIDE_X = 0.24;
/** Largest per-tooth offset, as a fraction of the pitch, at the most adventurous rung. */
const REACH_X = 0.4;
const REACH_Z = 0.38;
/** Relaxation: how many sweeps, how many candidates a tooth tries per sweep. */
const RELAX_PASSES = 2;
const RELAX_TRIES = 10;

/** How adventurous each rung of the solve is, as a multiplier on every offset above. */
const RUNGS: readonly { amount: number; path: Scatter["path"] }[] = [
  { amount: 1, path: "free" },
  { amount: 0.62, path: "free" },
  { amount: 0.34, path: "tight" },
  { amount: 0, path: "grid" },
];

/**
 * How much clear screen space two silhouettes must have between them: a fraction of the
 * wider of the two, so a big tooth next to a small one is judged by the big one.
 *
 * Defined once and used by both the solver and the audit. Round 1's solver and its checker
 * used two different rules, which is how a board could be accepted and then measured as
 * ambiguous.
 */
function neededGap(a: NdcBox, b: NdcBox): number {
  const wa = a.x1 - a.x0;
  const wb = b.x1 - b.x0;
  return (wa > wb ? wa : wb) * GAP_FRACTION;
}

/** Clearance between two boxes on whichever axis separates them best. Negative overlaps. */
function clearance(a: NdcBox, b: NdcBox): number {
  const dx = Math.max(b.x0 - a.x1, a.x0 - b.x1);
  const dy = Math.max(b.y0 - a.y1, a.y0 - b.y1);
  return dx > dy ? dx : dy;
}

/** True when `probe` clears every tooth in `boxes[0..n)` other than `self`. */
function clearOfAll(n: number, self: number): boolean {
  for (let j = 0; j < n; j++) {
    if (j === self) continue;
    if (clearance(probe, boxes[j]) < neededGap(probe, boxes[j])) return false;
  }
  return true;
}

export type ScatterAudit = {
  /** Worst pair's clearance, in NDC. Negative means two silhouettes overlap on screen. */
  worstGap: number;
  /** Worst pair's clearance as a multiple of the gap the solver demands. 1.0 is exactly at it. */
  worstRatio: number;
  /** How far the worst tooth is outside the visible frame, in NDC. Negative is inside. */
  worstOutside: number;
  pass: boolean;
};

/**
 * Re-derives, from scratch, whether a finished board is countable at a given framing.
 *
 * This is the definition of the guarantee — `solveScatter` calls it, `?selftest=count` calls
 * it, and the scene calls it when the play area is resized. It has no state and no GPU.
 */
export function auditScatter(out: Scatter, m: ScatterMetrics, f: CameraFraming): ScatterAudit {
  const n = out.count;
  for (let i = 0; i < n; i++) toothNdcBox(boxes[i], f, m, out.x[i], out.z[i], out.scale[i]);

  let worstGap = Infinity;
  let worstRatio = Infinity;
  for (let i = 1; i < n; i++) {
    for (let j = 0; j < i; j++) {
      const a = boxes[i];
      const c = boxes[j];
      const gap = clearance(a, c);
      const need = neededGap(a, c);
      if (gap < worstGap) worstGap = gap;
      const ratio = need > 1e-9 ? gap / need : Infinity;
      if (ratio < worstRatio) worstRatio = ratio;
    }
  }

  // The same three edges the solve uses, in the same units: the keep-clear floor at the top,
  // and the `world-edge` feather on the other three. Measuring a tooth against a bare
  // `±aspect` would call a tooth dissolved into the fog gradient "inside the frame" — which
  // is round 4's phone capture, where the right-hand tooth's outer third is cream.
  const top = 1 - 2 * f.chrome;
  const side = f.aspect - f.edge;
  const bottom = 1 - f.edge;
  let worstOutside = -Infinity;
  for (let i = 0; i < n; i++) {
    const a = boxes[i];
    const over = Math.max(-side - a.x0, a.x1 - side, -bottom - a.y0, a.y1 - top);
    if (over > worstOutside) worstOutside = over;
  }
  if (n === 0) {
    worstGap = Infinity;
    worstRatio = Infinity;
    worstOutside = -Infinity;
  }
  return {
    worstGap,
    worstRatio,
    worstOutside,
    pass: (n < 2 || worstRatio >= 1) && worstOutside <= 0,
  };
}

/**
 * Produces a scatter that is **proved countable before it returns**.
 *
 * Four rungs, tried in order, each less adventurous than the last:
 *
 *  1–2. **Free.** Cells are shuffled and only `count` of them are used, which is the 2D
 *  game's `cells.sort(random)` draw carried over. Each *row* then slides as a unit in X;
 *  rows are separated in Z by more than a tooth is tall on screen, so a row's X slide can
 *  never create an ambiguous pair. Each tooth takes an offset inside its cell, and then two
 *  relaxation sweeps let it try a much larger one — keeping the move only if the tooth still
 *  clears *every other tooth* on screen, not just the ones placed before it. The board is
 *  therefore legal before the pass, after every individual move, and after the pass, while
 *  teeth in sparse neighbourhoods wander far enough that nothing reads as a lattice.
 *
 *  3. **Tight.** The same thing with a third of the reach.
 *
 *  4. **Grid.** Exact cell centres. The pitch is `PITCH_HEADROOM` over the separation
 *  constraint by construction, so this rung cannot fail unless the framing itself is
 *  degenerate — which `?selftest=count` asserts across every level, count and viewport
 *  aspect the shell can produce.
 *
 * If even that fails the teeth are shrunk 6% at a time, up to twelve times. That path exists
 * so the function is total; it is not a design.
 *
 * The important property is that **there is no code path that returns an unproved board.**
 * Round 1's implementation tried three draws, fell back once, and then shipped whatever it
 * had along with a note of how bad it was.
 */
export function solveScatter(
  out: Scatter,
  level: number,
  count: number,
  m: ScatterMetrics,
  f: CameraFraming,
  b: BoardMetrics,
  rand: () => number
): boolean {
  const grid = b.grid;
  const n = clamp(count, 0, Math.min(MAX_COUNT, grid.cells)) | 0;

  out.count = n;
  out.level = level;
  out.path = "grid";
  if (n === 0) return true;

  for (let rung = 0; rung < RUNGS.length; rung++) {
    const { amount, path } = RUNGS[rung];
    place(out, n, grid, b, m, f, rand, amount);
    out.path = path;
    if (auditScatter(out, m, f).pass) return true;
  }

  // Bounded last resort. Shrinking a tooth shrinks its NDC box, so this terminates.
  for (let step = 0; step < 12; step++) {
    for (let i = 0; i < n; i++) out.scale[i] *= 0.94;
    out.path = "shrunk";
    if (auditScatter(out, m, f).pass) return true;
  }
  return false;
}

function place(
  out: Scatter,
  n: number,
  grid: Grid,
  b: BoardMetrics,
  m: ScatterMetrics,
  f: CameraFraming,
  rand: () => number,
  amount: number
): void {
  // The slide is capped at what the *whole* row can take without any tooth hitting the pad
  // edge. Sliding a row and then clamping its outermost tooth would squeeze that tooth into
  // its neighbour — a rigid row cannot create an ambiguous pair, a partly-clamped one can,
  // and that alone was rejecting a third of the boards this solver drew.
  const slideRoom = Math.max(0, b.clampX - ((grid.cols - 1) / 2) * grid.pitchX);
  const slide = Math.min(grid.pitchX * ROW_SLIDE_X, slideRoom) * amount;
  for (let r = 0; r < grid.rows; r++) {
    rowOffX[r] = (rand() * 2 - 1) * slide;
  }

  for (let i = 0; i < grid.cells; i++) cellOrder[i] = i;
  for (let i = grid.cells - 1; i > 0; i--) {
    const j = (rand() * (i + 1)) | 0;
    const t = cellOrder[i];
    cellOrder[i] = cellOrder[j];
    cellOrder[j] = t;
  }

  const halfCols = (grid.cols - 1) / 2;
  const halfRows = (grid.rows - 1) / 2;

  for (let i = 0; i < n; i++) {
    const cell = cellOrder[i];
    const col = cell % grid.cols;
    const row = (cell - col) / grid.cols;
    baseX[i] = (col - halfCols) * grid.pitchX + rowOffX[row];
    baseZ[i] = clamp((row - halfRows) * grid.pitchZ, -b.clampZ, b.clampZ);
    out.x[i] = baseX[i];
    out.z[i] = baseZ[i];
    out.yaw[i] = (rand() * 2 - 1) * TOOTH_YAW;
    const dir = rand() * Math.PI * 2;
    const lean = rand() * TOOTH_TILT * (0.35 + 0.65 * amount);
    out.tiltX[i] = Math.cos(dir) * lean;
    out.tiltZ[i] = Math.sin(dir) * lean;
    out.scale[i] = 1 + (rand() * 2 - 1) * TOOTH_SCALE_VAR * (0.4 + 0.6 * amount);
  }

  if (amount <= 0) {
    for (let i = 0; i < n; i++) toothNdcBox(boxes[i], f, m, out.x[i], out.z[i], out.scale[i]);
    return;
  }

  /* Relaxation: every accepted move leaves the whole board legal on screen. */

  for (let i = 0; i < n; i++) toothNdcBox(boxes[i], f, m, out.x[i], out.z[i], out.scale[i]);
  const reachX = grid.pitchX * REACH_X * amount;
  const reachZ = grid.pitchZ * REACH_Z * amount;

  for (let pass = 0; pass < RELAX_PASSES; pass++) {
    for (let i = 0; i < n; i++) {
      for (let attempt = 0; attempt < RELAX_TRIES; attempt++) {
        // Shrinking amplitude: a bold move first, then progressively more modest ones, so
        // a tooth with room takes it and a hemmed-in tooth still gets a nudge.
        const k = 1 - attempt / RELAX_TRIES;
        const x = clamp(baseX[i] + (rand() * 2 - 1) * reachX * k, -b.clampX, b.clampX);
        const z = clamp(baseZ[i] + (rand() * 2 - 1) * reachZ * k, -b.clampZ, b.clampZ);
        toothNdcBox(probe, f, m, x, z, out.scale[i]);
        if (clearOfAll(n, i)) {
          out.x[i] = x;
          out.z[i] = z;
          boxes[i].x0 = probe.x0;
          boxes[i].x1 = probe.x1;
          boxes[i].y0 = probe.y0;
          boxes[i].y1 = probe.y1;
          break;
        }
      }
    }
  }
}
