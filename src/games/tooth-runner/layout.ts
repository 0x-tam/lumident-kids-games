/**
 * Tooth Runner — world metrics and camera framing.
 *
 * Pure numbers: importing this pulls in no three and no React, so both the engine (which
 * needs the physics constants) and the shell (which needs the camera) can read it without
 * dragging the scene's geometry into their chunk.
 *
 * Scale note (3D-SPEC §2): 1 world unit = 10 cm and the hero tooth is exactly 1.0 unit
 * tall, so the runner is a 10 cm clay tooth bowling down a 29 cm wide clay path at roughly
 * half a metre a second. Everything below is in those units.
 *
 * ── How the 2D game's numbers were carried across ──────────────────────────────
 *
 * The 2D runner measured everything in percent of the play field: the player stood at
 * x = 16%, things spawned at x = 112% and were removed at x = -15%, and level speeds were
 * 40 / 52 / 64 percent a second. The quantity that actually defines the difficulty is the
 * *time* between an obstacle appearing and reaching the player — 96% of travel at the
 * level's speed, i.e. 2.40 s / 1.85 s / 1.50 s.
 *
 * `U_PER_PCT` is chosen so that that survives exactly: the spawn line sits 13 units in
 * front of the player, 96% of the 2D field maps onto those 13 units, and every speed,
 * spawn interval and hit window in `engine.ts` is the 2D number times this scalar. The
 * reaction times, the spawn cadence and the collision windows are therefore identical to
 * the game this replaces, measured with a stopwatch rather than by eye.
 */

/** 96% of the 2D field == the 13 units between the spawn line and the player. */
export const U_PER_PCT = 13 / 96;

/* ------------------------------------------------------------------ */
/* The lane                                                            */
/* ------------------------------------------------------------------ */

/** The player never moves in Z; the world scrolls past it toward +Z. */
export const PLAYER_Z = 0;
export const SPAWN_Z = -13;
/**
 * Where a passed item leaves, and where it starts leaving.
 *
 * The old cut was 6.5 — "past the bottom of the frame" — and that was projected for a
 * *low* item only. Re-projecting the round-3 build's own geometry through the real solve, in
 * every shipped rect (`cameraFor` + `ndcYOf`, five rects, the item's own top):
 *
 *   item as shipped          leaves the hero's screen box   leaves the frame
 *   low sweet, top y 0.36    z = 0.95 – 1.10                z = 1.80 – 2.55
 *   fizzy drink, top y 0.46  z = 1.20 – 1.40                z = 2.00 – 2.80
 *   **floating pickup, top y 1.63**  z = 4.20 – 4.85        **z = 4.65 – 5.40**
 *
 * — so a missed floating pickup hung across the hero's head and shoulders for four and a
 * half units of travel, and a fizzy drink covered the landing, which is the single beat this
 * game is built around. That is what `crop/tr-land.png` photographed. The new item set is
 * *taller* at the top end, not shorter — a floating pickup sweeps to y 2.04 (RU5 grew it
 * from a 0.45 hoop to a 0.46 swept half-extent, so this figure is unchanged) — so
 * the distance cannot be the fix; the taper is.
 *
 * The item pool now gets the ground-anchored taper the scenery pools already use. An item
 * is untouched until it is past the hit window (`HIT_Z` = 0.880 — it can no longer be
 * collected or bumped, so nothing is taken away by removing it), and it has sunk into the
 * lane by `CLEAR_Z + CLEAR_SPAN`. At the three level speeds that taper lasts 0.28 / 0.22 /
 * 0.18 s, entirely behind the player.
 */
export const ITEM_CLEAR_Z = 0.9;
export const ITEM_CLEAR_SPAN = 1.5;
/** 0.2 past the end of the taper: the item is already at zero scale when the slot is freed. */
export const DESPAWN_Z = ITEM_CLEAR_Z + ITEM_CLEAR_SPAN + 0.2;
/**
 * There is no off-screen in a world with a visible horizon: the spawn line 13 units out sits
 * near the top of the clear band, in plain view. So an item is not placed, it *arrives* —
 * scaling up on `easeOutBack` across the first two units of its travel.
 */
export const SPAWN_GROW = 2;

/**
 * The lane's top surface is world y = 0 — every gameplay height in this game is measured
 * from it — and the studio's cream floor sits one lane-thickness below.
 */
export const GROUND_Y = -0.26;
export const LANE_W = 2.9;
export const LANE_HALF = LANE_W / 2;
/** Long enough that both ends are lost in the fog rather than ending on a visible edge. */
export const LANE_LEN = 150;

/* ------------------------------------------------------------------ */
/* The tooth                                                           */
/* ------------------------------------------------------------------ */

/**
 * Height of the tooth's centre above the lane. The tooth is exactly 1.0 unit tall, so at
 * rest — standing upright on its feet — its centre is half a unit up. **Every collision in
 * the game is measured from this nominal height**, never from the presentation: the run
 * bounce, the squash and the lean in `scene.tsx` move the mesh and never the hit test, so
 * the 2D game's hit windows survive exactly.
 */
export const TOOTH_CENTER_Y = 0.5;
/** Half the tooth's depth. Used to push a bumped sweet clear of the body (`engine.ts`). */
export const TOOTH_SEMI_Z = 0.31;
/**
 * How far the world travels per footfall.
 *
 * The hero used to be spun end over end at `v / ROLL_RADIUS` — 1.5 revolutions a second,
 * which presented its roots to the sky for a large part of every second and gave a face
 * nowhere to live. It now *runs*: the same ground speed drives a two-beat run cycle instead
 * of a roll, and this is the stride length that sets its cadence: 3.0 / 3.9 / 4.8 steps a
 * second across the three levels. Fast enough to read as effort, and slow enough at the top
 * level that the gait still resolves rather than strobing — at 4.8 Hz a 60 fps display gives
 * each footfall twelve frames, which is about the floor for a cycle a child can follow.
 */
export const STRIDE = 1.8;

/* ------------------------------------------------------------------ */
/* The jump — the single most touched interaction in the game           */
/* ------------------------------------------------------------------ */

/**
 * Apex 1.00 unit (the tooth clears its own height), hang time 0.68 s. Solved from those
 * two, not dialled in: `v = 4h/T`, `g = 2v/T`. The 2D game's arc was 0.735 s to an apex of
 * 23% of the field; this is the same shape, a shade snappier.
 */
export const JUMP_APEX = 1.0;
export const JUMP_TIME = 0.68;
export const JUMP_V = (4 * JUMP_APEX) / JUMP_TIME;
export const GRAVITY = (2 * JUMP_V) / JUMP_TIME;

/**
 * The anticipation crouch. The tooth compresses into the lane for 70 ms and *then* leaves
 * it, so the launch has a real wind-up (3D-SPEC §4) instead of teleporting upward.
 *
 * The crouch is visible on the very next frame — the response-within-one-frame rule is met
 * by the squash, not by the displacement — and the 70 ms of ground contact is repaid by
 * `JUMP_BUFFER`: a tap that lands up to 140 ms early is remembered and fires the moment the
 * tooth is back on the lane, so the delay can never cost a child a jump they asked for.
 */
export const WINDUP = 0.07;
export const JUMP_BUFFER = 0.14;

/* ------------------------------------------------------------------ */
/* Collision                                                           */
/* ------------------------------------------------------------------ */

/** ±6.5% of the 2D field, unchanged. */
export const HIT_Z = 6.5 * U_PER_PCT;
/**
 * Vertical window between the tooth's centre and an item's centre. **Unchanged** — this is
 * one of the numbers the brief freezes, and the low-and-wide sweets in `props.ts` move only
 * `engine.ts::REST_Y`, which is presentation.
 *
 * Re-solved against those new rest heights: a sweet at y = 0.19 is cleared once the tooth is
 * 0.31 up, which happens 58 ms into the jump and lasts 0.565 s; the flat donut at y = 0.10
 * is cleared at 0.22, 40 ms in, for 0.601 s. At level 1 that is 3.1 units of travel against
 * a 1.76 unit hit window — a jump taken any time in a comfortable window gets you over, and
 * the three sweets now share one clearance rather than three (see `REST_Y`).
 */
export const HIT_Y = 0.62;

/** Floating pickups: high enough that they genuinely need a jump, low enough to be fair. */
export const HIGH_Y = 1.28;
export const HIGH_Y_SPAN = 0.3;

/** How long a candy keeps you sticky. Unchanged from the 2D game's 1000 ms. */
export const SLOW_TIME = 1.0;

/* ------------------------------------------------------------------ */
/* Scenery bands                                                       */
/* ------------------------------------------------------------------ */

/*
 * Three depth bands, each a fixed pool recycled through a Z window. `Z0 + SPAN` is where
 * an instance wraps back to the far end, and it is deliberately *behind the camera* for
 * the near and mid bands so a wrap can never be seen. The far band wraps in front of the
 * camera but too far away to notice, and fades at both ends.
 */
export const NEAR_Z0 = -46;
export const NEAR_SPAN = 58;
/**
 * The gateway pool's own window, shorter than the rest of the near band.
 *
 * A prop's screen height is not bounded by how tall it is but by how *far* it is: every
 * point above the lane converges on the ground's vanishing point, which sits at a fixed
 * `HORIZON_NDC` = 0.707 whatever the rect. So the tallest a gate ever reads is at the far
 * end of its window, and shortening that window is what buys height at the near end.
 * Projected through `ndcYOf` against the real `cameraFor` solve, the peak `ndcY` of the
 * gateway's design-maximum crown (1.165 x 1.06 = 1.235 units above the lane) is
 *
 *   z0    laptop   phone   portrait   tablet     (chrome band bottom: 0.60 / 0.54 / 0.73 / 0.63)
 *   -46    0.58     0.58     0.59       0.59      phone fails
 *   -34    0.55     0.54     0.56       0.55      phone grazes
 *   **-28  0.52     0.51     0.53       0.52**    clear in all four
 *
 * The fifth rect, a landscape phone, clamps `chrome` at 0.34 and its band bottom is 0.32 —
 * below the bare *ground*, which peaks at 0.34 there. Nothing can clear a band that covers
 * the floor, so that rect is judged on tone rather than on height, and the answer is the
 * fogged cream the DOM was designed against.
 *
 * `z0 + span` stays at +12 so the wrap is still behind the camera (which sits at z ≈ 7.2–7.5)
 * and can never be seen. Four gates across 40 units is one every 10 units: 1.1 s apart at the
 * top level and 1.9 s at the bottom.
 */
export const GATE_Z0 = -28;
export const GATE_SPAN = 40;
export const MID_Z0 = -54;
export const MID_SPAN = 66;
export const FAR_Z0 = -70;
export const FAR_SPAN = 44;

/** Parallax rates. */
export const RATE_NEAR = 1;
export const RATE_MID = 0.62;
export const RATE_FAR = 0.26;

/**
 * Parallax rates under `prefers-reduced-motion`, and the measurement that produced them.
 *
 * Round 4 (RU3) measured changed-pixel fraction per screen band across `i01…i06`, normal
 * against `?reduced=1`:
 *
 *   far  y200-320   normal 20.2 / 20.0 / 18.4 / 16.8 / 15.6 %   reduced **23.2 / 20.9 / 19.6 / 16.5 / 17.9 %**
 *   mid  y320-480   normal 31.7 … 30.2 %                        reduced 33.8 … 31.8 %
 *   near lane       normal 26.4 … 22.6 %                        reduced 24.5 … 21.8 %
 *
 * — the reduced path was quieter in no band and **busier in the two that matter**. The cause
 * was one line in `scene.tsx` and it is arithmetic, not an oversight: reduced motion collapsed
 * every band to `RATE_NEAR`, on the theory that layers sliding across one another is the
 * vestibular trigger. Collapsing *upward* multiplies the far ridge's screen speed by
 * `1 / RATE_FAR` = **3.85x** and the mid band's by 1.61x. The world was made rigid by making
 * most of it move faster.
 *
 * Optic flow, not differential parallax, is what a child who set this flag is protected from —
 * so the bands come down instead of up, and the near band (the lane the hero's own gait is
 * locked to, and the plane the items travel in) is the one that cannot move, because it is the
 * game. Against the *normal* path the reduced far band's world displacement now falls to
 * **0** (from 0.26) and the mid band to 0.12 from 0.62 — a **5.2x** cut — and against the
 * shipped reduced path they fall by ∞ and 8.3x. Projected to screen speed at the top level on
 * a laptop rect — which is the quantity the changed-pixel measurement is actually reading:
 *
 *   band           normal      shipped reduced      this
 *   near (z −8)    938 px/s        938 px/s        938 px/s   (the lane; it is the game)
 *   mid  (z −30)   236 px/s        **380 px/s**     46 px/s
 *   far  (z −60)    55 px/s        **210 px/s**      0 px/s
 *
 * — and the two bold figures are the finding. A frozen ridge 55–75 units out behind two thirds
 * of a fog is a painted backdrop, which is what it already looked like; a hill drifting at 46
 * px/s crosses a 3 px threshold in 65 ms.
 *
 * **What was deliberately not done:** cutting `engine.speed`. The level speeds, the spawn
 * cadence and the reaction times are the 2D game's and PROJECT.md freezes them. Scaling the
 * world speed to reach the same optic-flow target would need ~0.28x, at which the 13 units
 * between the spawn line and the player take 9.2 s to cross against a 20 s run: half the items
 * a child spawns would never arrive, and the reduced-motion player would score half. An
 * accessibility path is not allowed to be a difficulty setting.
 */
export const RATE_MID_REDUCED = 0.12;
export const RATE_FAR_REDUCED = 0;

/* ------------------------------------------------------------------ */
/* Camera                                                              */
/* ------------------------------------------------------------------ */

/**
 * A long lens sitting low behind the tooth.
 *
 * `GameShell` hands a game the whole shell interior, so the top ~25% of the frame is under
 * the title and HUD. The framing is solved from the measured rect: the vertical span that
 * must stay clear runs from a little in front of the lane (y = −0.35) to the top of the
 * tooth at the apex of a jump (y = 2.20), and the aim point is then lifted along the
 * camera's own up vector by half the chrome band so that span lands centred in the part of
 * the frame nothing is covering.
 *
 * **The elevation is 10°, and that number was measured rather than chosen.** A 28° lens is
 * a very long one, so the ground's vanishing point sits exactly `ELEVATION` above the view
 * centre and everything distant piles up underneath it. Projecting the real frame:
 *
 *   elevation   furthest ground still clear of the chrome band
 *   15°          30 units
 *   12°          40 units
 *   10°          58 units
 *
 * At 15° — the angle this game started at — every scenery band beyond the spawn line was
 * behind the title. At 10° the tooth still lands at −9.5°, the apex of a jump at +3.7° and
 * the spawn line at +2.2°, all of it comfortably inside the clear band, while the mid-ground
 * and the far ridge get a real strip of frame to live in. Going flatter than this starts to
 * cost the read on how high a jump is, which is the one thing a runner cannot afford.
 *
 * There is no horizon *line* anywhere in the frame: the floor, the fog and the page are all
 * `#ede7dc`, so distance simply becomes the page colour. The far silhouette band in soft
 * rose is the only thing that separates out of it.
 */
const FOV = 28;
const TAN_HALF_FOV = Math.tan((FOV * Math.PI) / 360);
const ELEVATION = (10 * Math.PI) / 180;

/**
 * Where the ground's vanishing point sits in the frame — and the reason the chrome band
 * cannot be cleared by moving anything further away.
 *
 * `cameraFor` lifts the aim point along the camera's own up vector, and moves the camera by
 * the *same* vector, so the pitch is `ELEVATION` in every rect and the horizon is pinned at
 * `tan(ELEVATION) / tan(FOV/2)` = **0.707 in NDC**, i.e. 14.6 % down from the top of the
 * frame, always. The measured chrome band is 13.6–34 % of the frame, so in four of the five
 * rects the product ships in the horizon is *inside* the band. Any prop taller than the
 * camera therefore stays inside the band at every finite distance: round 3's proposed
 * remedy — "a `clearZ` exclusion so no arch may occupy the top `chrome` fraction" — has no
 * solution for a gate the hero runs under, which is why the arch was replaced with a
 * gateway short enough to stay under the band rather than pushed further away.
 *
 * Exported so the check can be run against the shipped solve rather than asserted here.
 */
export const HORIZON_NDC = Math.tan(ELEVATION) / TAN_HALF_FOV;

/**
 * Vertical screen position of a world point, in NDC (`+1` = top of the frame).
 *
 * Pure, and the only place the projection is written down: `props.ts` sizes the gateway
 * against it and `scratchpad`'s framing harness re-derives every number in the two comments
 * above by calling it, so a constant here cannot drift away from the camera it describes.
 */
export function ndcYOf(framing: CameraFraming, y: number, z: number): number {
  const camY = framing.position[1];
  const camZ = framing.position[2];
  const vy = y - camY;
  const vz = z - camZ;
  const depth = -(vy * Math.sin(ELEVATION) + vz * Math.cos(ELEVATION));
  if (depth <= 1e-4) return Number.POSITIVE_INFINITY;
  return (vy * Math.cos(ELEVATION) - vz * Math.sin(ELEVATION)) / depth / TAN_HALF_FOV;
}

/**
 * World band that must stay clear of the chrome, and its centre.
 *
 * `CLEAR_BOTTOM` reserves a strip of lane *in front of* the hero, and RU11 is what sizes it:
 * *"the peach DOM pill sits directly on the tooth's body and hides its legs — the read on
 * 'this thing runs' — while telling the child to make it run."* At −0.35 there was nowhere
 * below the hero for it to go. Projecting the shipped solve (`cameraFor` + `ndcYOf`) and
 * expressing the hero's feet as a fraction of the pill's own container — the play area below
 * `--chrome-h`, which is what `bottom-*` is measured in:
 *
 *   rect (chrome fraction)      feet, CLEAR_BOTTOM −0.35      feet, −0.5     camera distance
 *   laptop  820x810  (0.216)            80.5 %                  78.1 %        7.40 → 7.40
 *   phone   350x735  (0.313)            83.9 %                  80.0 %        7.58 → 7.88
 *
 * The 56 px pill is 9.4 % of the laptop container and 11.1 % of the phone's, so at
 * `bottom-[2%]` its top edge sits at 88.6 % and 86.9 % — **10.5 and 6.9 points of daylight
 * below the feet**, where before it overlapped them by 3.4 points on the phone.
 *
 * It costs camera distance only where the height solve binds, i.e. `chrome > 0.268`: the
 * laptop, tablet and portrait rects stay pinned at `MIN_DISTANCE` and their 27.1 % subject
 * share does not move at all, the phone goes 7.58 → 7.88 (26.5 % → 25.5 %) and the landscape
 * phone 7.75 → 8.20 (25.9 % → 24.4 %).
 *
 * The gateway's clearance survives, and here is the whole of it rather than an assurance. The
 * aim point drops by 0.075 and, where the solve binds, the camera also retreats — the two
 * partly cancel, so the tallest gate cap crown at the far end of its window moves:
 *
 *   laptop 0.5477 → 0.5564   tablet 0.5428 → 0.5515   portrait 0.5484 → 0.5571
 *   phone  0.5229 → 0.5243   landscape phone 0.5129 → 0.5105
 *
 * — at worst +0.0087, against the band bottoms of 0.541 / 0.600 / 0.628 / 0.727 the pool was
 * sized to. The tightest of those, the phone at 0.541, is also the one that barely moves
 * (+0.0015), because that is a rect where `r` compensates. Margin at the worst pair falls from
 * 0.052 to 0.044 and nothing crosses.
 */
const CLEAR_BOTTOM = -0.5;
const CLEAR_TOP = 2.2;
const CLEAR_HALF = (CLEAR_TOP - CLEAR_BOTTOM) / 2;
const CLEAR_MID = (CLEAR_TOP + CLEAR_BOTTOM) / 2;

/** Half the width the item lane needs; the scenery is allowed to run off the sides. */
const HALF_WIDTH = 0.9;
/**
 * Fallback height of `GameShell`'s title + HUD band, used only as a fraction of the rect.
 *
 * `GameShell` now publishes the *measured* band on the play area as the `--chrome-h` custom
 * property, and `ToothRunner.tsx` reads it and passes it in. This constant is what we frame
 * against if that property is ever missing, so a stale number can never silently become the
 * framing again.
 */
export const CHROME_PX_FALLBACK = 138;
/**
 * The floor on camera distance, and the one number that decides how big the hero reads.
 *
 * The clear-band solve asks for `CLEAR_HALF / (tan(FOV/2) · (1 − chrome))` = 5.42 units at
 * `chrome` 0, so this floor binds in every rect whose chrome band is under 26.8 % — which is
 * the laptop and both tablet rects. There, it and nothing else sets the subject's share of the
 * frame. At 8.4 the 1.0-unit tooth was 23.9% of frame height in every layout measured; round
 * 2's legibility bar is a subject that fills far more of the frame than that.
 *
 * 7.4 puts it at **27.1%** and the eyes at 32 screen px on a laptop rect. On the two rects
 * where the band solve binds instead — the portrait phone (chrome 0.313, r 7.88, subject
 * 25.5%) and the landscape phone (chrome clamped at 0.34, r 8.20, 24.4%) — the floor is not
 * what decides, and those two are the rects that gained the strip of lane `CLEAR_BOTTOM`
 * reserves. Going below 7.4 starts eating the margin this floor protects, and a runner cannot
 * afford to lose the read on how high a jump is.
 */
const MIN_DISTANCE = 7.4;
const MAX_DISTANCE = 13;

export type CameraFraming = {
  position: [number, number, number];
  target: [number, number, number];
  fov: number;
};

export function cameraFor(
  width: number,
  height: number,
  chromePx: number = CHROME_PX_FALLBACK
): CameraFraming {
  const aspect = width > 0 && height > 0 ? width / height : 1;
  // Clamped: a landscape phone would otherwise report the chrome eating half the frame.
  const chrome = height > 0 ? Math.min(0.34, chromePx / height) : 0.22;

  const forHeight = CLEAR_HALF / (TAN_HALF_FOV * (1 - chrome));
  const forWidth = HALF_WIDTH / (TAN_HALF_FOV * Math.max(0.4, aspect));
  const raw = forWidth > forHeight ? forWidth : forHeight;
  const r = raw < MIN_DISTANCE ? MIN_DISTANCE : raw > MAX_DISTANCE ? MAX_DISTANCE : raw;

  const shift = chrome * r * TAN_HALF_FOV;
  const cosE = Math.cos(ELEVATION);
  const sinE = Math.sin(ELEVATION);
  const ty = CLEAR_MID + shift * cosE;
  const tz = -shift * sinE;

  return {
    position: [0, ty + r * sinE, tz + r * cosE],
    target: [0, ty, tz],
    fov: FOV,
  };
}

/**
 * Shadow frustum. Bound the *action*, not the world (3D-FOUNDATION-NOTES §8).
 *
 * Re-derived against the shared PCSS solve rather than restated. `Rig` writes
 * `shadow.radius = SHADOW_SOFTNESS × 2.2 × mapSize` and the clay shader multiplies it by the
 * *normalised* blocker gap, so with `half = 7`, `depthRange = 4.4 × half = 30.8` and
 * `texelsPerUnit = mapSize / 14`:
 *
 *   radius(texels) = gap / 30.8 × 0.1 × 2.2 × 1024 = **7.314 × gap**, clamped to [2, 10]
 *   penumbra half-width = radius × 14/1024 = **0.1000 × gap world units** — i.e. exactly
 *   `SHADOW_SOFTNESS × gap`, which is the shared file's claim, confirmed for this frustum.
 *
 * What that gives on the lane under the hero, which is 7.67 units from the lens, so the view
 * spans `2 × 7.67 × tan 14°` = 3.824 world units over a 725 px shell — 190 px per world unit:
 *
 *   | gap along the key | penumbra, full width | on screen |
 *   |---|---|---|
 *   | contact (clamped at 2 texels) | 0.0547 u | **10.4 px** |
 *   | 0.3 u  | 0.060 u | 11 px |
 *   | 1.0 u  | 0.200 u | 38 px |
 *   | 1.37 u | clamp reached at 10 texels, 0.273 u | 52 px |
 *
 * So the contact end resolves in 10 screen pixels rather than the ~40 px round 3 measured,
 * and the widening is live right up to the jump apex — the tooth at `JUMP_APEX` = 1.0 is
 * 1.0 / sin 47.55° = 1.356 u up the table, a shade under the sampling clamp. Everything
 * further out than the frustum carries a contact blob instead.
 */
export const SHADOW_AREA = 14;
/**
 * Fog. At 0.014 the mid band 30 units out is a fifth washed toward cream, the far ridge at
 * 34–78 units runs from a fifth to seven tenths, and the floor's own edge 200 units away is
 * gone entirely — which is what buys the aerial perspective *and* hides the far pool's
 * recycling seam.
 */
export const FOG_DENSITY = 0.014;
/** Big enough that the floor's own edge is fogged out to exactly the page colour. */
export const GROUND_SIZE = 400;
