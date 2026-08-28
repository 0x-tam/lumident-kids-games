/**
 * Every number the basket, the fall, the set and the camera are built from. Pure
 * arithmetic — importing this pulls in no three, no React and no engine.
 *
 * Scale (3D-SPEC §2): 1 world unit = 10 cm. A caught tooth is 7.4 cm tall, the basket is
 * 14 cm deep and 13-29 cm across, and things fall about 29 cm into it. It is a tabletop
 * toy, photographed on a long lens.
 *
 * ---------------------------------------------------------------------------
 * Round 2: what changed here, and why
 * ---------------------------------------------------------------------------
 *
 * The audit measured the one object this game is about at **24 x 34 buffer pixels, 0.36 %
 * of the frame, at 1.17:1 against what it falls through**, with 55 % of the play rect a
 * single flat page-coloured value and the set's own cut edges in shot. Three numbers here
 * caused all of it:
 *
 *  1. **The drop was 4.2 units and the tooth 0.46.** A 1:9.2 subject-to-travel ratio can
 *     only ever frame a speck. The drop is now 2.86 and the tooth 0.74 — 1:3.9 — so the
 *     camera solves ~1.5x closer *and* the prop is 1.6x bigger. Net: about 2x linear,
 *     4x the area, before the mascot face goes on it.
 *  2. **The set was two thin risers on an infinite cream plane**, so the upper half of
 *     every frame was the fog washing out to page colour and the tooth fell through its
 *     own colour. The set is now a real alcove: a deep warm back panel the whole drop
 *     happens against, framed by pale clay wings and a lintel.
 *  3. **The mat and risers were sized by guesswork** (`playHalf * 2 + basketW + 2.4`) and
 *     terminated inside the frame. Every piece of the set is now *derived from the solved
 *     camera* — `matNear`, `matFar`, `matHalfX`, `wallHalfX`, `wallTop` below are the
 *     answers to "where does the frame edge cross this plane", so a visible set edge is
 *     arithmetically impossible at any viewport.
 *
 * Gravity note. `physics.ts` defaults to 26 u/s² and explains why (Earth gravity in a
 * 10 cm diorama is over before a child reacts). Tooth Rescue under-cranks further, for one
 * honest reason: the reaction window a child gets is `sqrt(2 * dropHeight / g)`, and the
 * drop height is capped by what a 28° lens can frame from inside the 8-16 unit distance
 * band. `GRAVITY` and `LEVELS[].drop` are therefore *solved*, not chosen: they are the
 * unique pair that reproduces the shipped fall times of **1.42 / 1.09 / 0.83 s** over the
 * new, shorter drop. The rules (spawn cadence, candy rate, goals, points) are untouched —
 * the number of teeth a child sees per run is identical to the 2D original.
 */

/* ------------------------------------------------------------------ */
/* World                                                               */
/* ------------------------------------------------------------------ */

/**
 * Solved, not tuned. With the catch plane at `STAGE_Y + WELL_Y + TOOTH_R` = 0.695 and the
 * spawn at `SPAWN_Y` = 3.55 the free-fall drop is H = 2.855 units, and
 * `g = 2H / t²` with t = 1.42 s is 2.832.
 *
 * **That solve omits `physics.ts`'s `LINEAR_DAMPING`, and round 3 checked it.** The solver
 * multiplies velocity by `exp(-0.35 h)` every substep, so the shipped fall is slower than
 * the closed form: integrating the real substep loop at 1/120 s gives **1.545 / 1.202 /
 * 0.918 s** against the 1.4199 / 1.0889 / 0.8308 the closed form predicts (which the
 * integrator reproduces to four figures with the drag switched off, which is how we know
 * the discrepancy is the drag and not the integrator). Reproduce with
 * `scratchpad/verify/tooth-rescue-wobble.mjs`.
 *
 * The constant is deliberately **not** re-solved to recover 1.42 s. `PROJECT.md` fixes the
 * spawn cadence, the candy rate, the goals and the points; it does not fix the fall time,
 * and 8-10 % more air is 8-10 % more reaction window for a four-year-old on every level,
 * with the ordering and the ratios between the three levels untouched. What is fixed here
 * is the *claim*: the numbers above are now the ones the simulation produces.
 */
export const GRAVITY = 2.832;

/** Table height. Everything rests on it and the shadow frustum is centred on it. */
export const GROUND_Y = 0;

/**
 * Basket footprint. Width is solved per device in `solveFraming`; the rest is fixed.
 *
 * `BASKET_W_MIN` must stay above 0.67 or `trayMetrics(BASKET_W_MAX, …)` — which is
 * evaluated once, at module scope — would stop describing the narrowest basket the solver
 * can hand out. Both `wall` and `corner` are clamped by `min(w, d) * 0.5`, and at
 * `d = 1.44` those clamps do not bind until `w` drops below 0.67.
 */
export const BASKET_D = 1.44;
/**
 * Height of the tub, and the one number round 4's B6.2 turned out to hang on.
 *
 * It shipped at 0.9, and at 0.9 **a tooth does not fit in this basket**. `clayTray` puts the
 * well floor at `max(h * 0.3, ...)` and the inner lip at `h - topRoll`, so the usable
 * interior was `0.8325 - 0.27` = **0.5625 units deep against a 0.74-unit tooth**: the very
 * first catch stood 0.11 proud of the rim with its feet on the floor, and
 * `tooth-rescue-reduced-i06.png` shows exactly that — one tooth apparently perched *on* the
 * rim rather than sitting in the tub.
 *
 * Solved rather than nudged, and solved against **two** conditions, because the obvious one
 * on its own breaks the reward this whole game is building towards.
 *
 *  1. *A whole tooth is inside the tub.* `floorTop + 2 * TOOTH_R <= h`, and with
 *     `floorTop = 0.3 h` that is `h >= 0.74 / 0.7` = **1.057**.
 *  2. *A child can still see the tooth they caught.* The camera sits 19 degrees up, so the
 *     sight line clearing the near rim (at `z = BASKET_D / 2`) has dropped
 *     `0.72 * tan 19` = **0.248 units** by the time it reaches the pile at `z ~ 0`. The
 *     mascot's eyes are 0.875 of the way up a 0.74-unit tooth, so they are visible only while
 *     `0.3 h + 0.648 >= h - 0.248`, i.e. **`h <= 1.28`**. Deepen the tub past that and the
 *     first catch of the run disappears completely behind the near wall.
 *
 * 1.06 is the bottom of that window, which is the right end of it: it is the shallowest tub
 * that contains a tooth, so it hides the least of the pile. The floor lands at 0.318, a
 * resting tooth spans 0.318-1.058 against a rim at 1.06, and its eyes clear the near rim by
 * 0.151 — the crown peeks over the lip instead of standing on it, which is what
 * `tooth-rescue-reduced-i06.png` shows it doing today. Everything downstream is derived —
 * colliders, pile slots, the weave, the rim band and `basketDepth` all read `BASKET_H` — so
 * this is the only line that moves.
 */
export const BASKET_H = 1.06;
export const BASKET_RIM = 0.15;
export const BASKET_W_MIN = 1.35;
export const BASKET_W_MAX = 2.9;

/** A caught tooth, and the collision sphere that stands in for it. */
export const TOOTH_SCALE = 0.74;
export const TOOTH_R = TOOTH_SCALE / 2;
/** Widest part of the crown, as built. What actually decides how many fit side by side. */
export const TOOTH_HALF_W = 0.257;

/**
 * A wrapped bonbon: a squashed sphere with two fluted wrapper ends.
 *
 * **B6.5 asked for a silhouette cue that survives colour**, because "catch this" and "dodge
 * this" have to separate in under a second for a four-year-old and hue alone cannot carry it
 * on a tablet held at an angle in a bright room. At `1.20 x 0.95` the body was very nearly a
 * ball, and a ball with two small nubs at 0.249 reads, at the fifteen-odd pixels the wrapper
 * ends occupy, as a ball. `1.32 x 0.84` is a lozenge — 1.57:1 against a tooth's 1.44:1 the
 * other way up — and the ends are spread to 0.30 and built 1.35x larger, so the wrapper is a
 * third of the prop's length rather than a decoration on the end of it. A tooth is upright and
 * round-topped; a sweet is horizontal and pointed at both ends, at any colour and any size.
 */
export const CANDY_R = 0.3;
export const CANDY_BODY_R = 0.273;
export const CANDY_STRETCH = 1.32;
export const CANDY_FLAT = 0.84;
export const CANDY_END_OFFSET = 0.3;
/** How much bigger the fluted end is built than the profile it is authored at. */
export const CANDY_END_SCALE = 1.35;
/**
 * How far each wrapper end is twisted about its own axis, in radians, in opposite directions.
 *
 * A wrapper is twisted; this is what makes the flutes read as a twist rather than as a pair of
 * ribbed caps, and it is the second half of the silhouette cue — the two ends catch the key at
 * different angles, so the prop has two distinct highlights even in one flat colour.
 */
export const CANDY_END_TWIST = 0.42;
/** Where a drop starts. Just above the top of the frame, so nothing pops into existence. */
export const SPAWN_Y = 3.55;

/**
 * The volume a settled tooth occupies, as an ellipsoid, in the two numbers that decide
 * whether two of them overlap.
 *
 * `PILE_A` is the crown's measured widest half-width — the same 0.257 the slot solver has
 * always clamped against — and `PILE_B` is half the tooth's height. They are **not** both
 * `TOOTH_R`: `TOOTH_R` is the *collision sphere's* radius, i.e. half the tooth's height,
 * and using it horizontally would model a settled tooth as 0.74 wide when it is 0.514. The
 * fix list asked for a clamp "at least `TOOTH_R` inside the wall"; that is 44 % more
 * clearance than the crown needs and on a 1.35-wide phone basket it leaves ±0.38 of usable
 * floor for a 0.514-wide prop. The honest number is the one the crown actually measures.
 */
export const PILE_A = 0.257;
export const PILE_B = 0.37;
/**
 * Two above the largest goal (12), so a catch that lands during the half-second finish
 * hold still has somewhere to go, and no higher — every slot is a live instance that the
 * shadow pass pays for twice.
 */
export const PILE_SLOTS = 14;

/**
 * Live body budget. Teeth: 14 piled + about 3 in flight + one skittering on the table.
 * These are only *ceilings* now: `scene.tsx` recomputes `InstancedMesh.count` from the live
 * high-water index every frame, so an idle board submits nothing instead of submitting the
 * whole pool (G-TRS-3 measured 176,608 triangles at rest, with nothing in flight).
 */
export const TOOTH_POOL = 18;
export const CANDY_POOL = 8;
export const BODY_POOL = TOOTH_POOL + CANDY_POOL;

/** Sparkles for catches and poofs — one instanced quad, one additive material. */
export const SPARKLES = 26;

/* ------------------------------------------------------------------ */
/* Clay tray metrics                                                   */
/* ------------------------------------------------------------------ */

const MIN_BEVEL = 0.02;
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

export type TrayMetrics = {
  wall: number;
  topRoll: number;
  baseRoll: number;
  innerTop: number;
  floorTop: number;
  corner: number;
};

/**
 * `clayTray` derives its well floor, rolled lip and outer corner radius internally and
 * exposes none of them — but the basket's physics colliders, its pile slots and its
 * decorative weave all have to line up with the real geometry, not with a guess. This
 * mirrors the builder's arithmetic exactly (see `geometry.ts: buildClayTray`).
 *
 * Because the basket is always wider than it is deep, every value here except the
 * silhouette itself is independent of the solved width.
 */
export function trayMetrics(w: number, d: number, h: number, rim: number): TrayMetrics {
  const halfMin = Math.min(w, d) * 0.5;
  const wall = clamp(rim, MIN_BEVEL, halfMin * 0.45);
  const topRoll = Math.min(wall * 0.45, h * 0.22);
  const baseRoll = Math.min(wall * 0.35, h * 0.2);
  const innerTop = h - topRoll;
  const floorTop = Math.min(Math.max(h * 0.3, baseRoll + 0.01), innerTop - 0.03);
  const fillet = Math.max(0.006, Math.min(wall * 0.6, (innerTop - floorTop) * 0.4));
  const corner = Math.min(Math.max(halfMin * 0.28, (wall + fillet) * 1.2), halfMin * 0.92);
  return { wall, topRoll, baseRoll, innerTop, floorTop, corner };
}

const BASKET = trayMetrics(BASKET_W_MAX, BASKET_D, BASKET_H, BASKET_RIM);

/** Inner floor of the basket — where the first layer of teeth rests. */
export const WELL_Y = BASKET.floorTop;
/** Top of the rim. The catch happens somewhere below this. */
export const RIM_Y = BASKET_H;
/** Height of the rolled lip, measured down from the rim. */
export const TOP_ROLL = BASKET.topRoll;
/** Wall thickness the colliders and the weave are placed against. */
export const WALL = BASKET.wall;
/** Outer corner radius of the silhouette — the weave must stay inside the straight runs. */
export const CORNER = BASKET.corner;
/** Half depth of the well in Z. Everything falls at z ≈ 0, so this is pure containment. */
export const INNER_HALF_D = BASKET_D / 2 - WALL;

/** Height of a body's centre when it rests on the basket floor. */
export const PILE_BASE_Y = WELL_Y + TOOTH_R;

/* ------------------------------------------------------------------ */
/* Camera                                                              */
/* ------------------------------------------------------------------ */

export const FOV = 28;
const TAN_HALF = Math.tan((FOV * Math.PI) / 360);
/**
 * 19 degrees. Low enough that the horizon stays comfortably above the top of the frame —
 * the picture is warm shelf and painted alcove, never a strip of empty sky — and high
 * enough that a child sees *into* the basket and reads the pile as a pile of faces rather
 * than as a row of shoulders. The guard is `SIN_E > TAN_HALF * COS_E`; at 19° and a 28°
 * lens that is 0.3256 > 0.2357, and `solveSet` asserts on it rather than trusting it.
 */
const ELEVATION = (19 * Math.PI) / 180;
const SIN_E = Math.sin(ELEVATION);
const COS_E = Math.cos(ELEVATION);

/** The vertical slice of world the camera must hold: the shelf, and the whole drop. */
const FRAME_BOTTOM = -0.3;
const FRAME_TOP = 3.6;
/** Z spread of anything interesting, so the tilt's foreshortening is accounted for. */
const FIELD_DEPTH = 1.8;
const MARGIN = 0.12;

/**
 * Fallback for `GameShell`'s title + HUD band, used only when `--chrome-h` cannot be read
 * (SSR, or a shell that has not measured yet). **Never the live value.**
 *
 * Round 3 (B6.5) measured what happens when it is: `GameShell` publishes the *measured*
 * band on the play area as `--chrome-h` (A12), and on a 390x844 phone that band is ~254 px,
 * not 138. Solving against 138 put the camera 10.82 units out instead of 12.95 and shifted
 * the picture down by 0.44 world units instead of 0.97 — so the accent rail landed at
 * y = 184 px with the HUD chips occupying 254-297 px, i.e. the chips sat *on* the rail.
 * With the real band the same solve puts the rail at 296 px, 42 px below the band's foot.
 * Reproduce with `scratchpad/verify/tooth-rescue-framing.mjs`.
 */
export const CHROME_PX_FALLBACK = 138;
/**
 * How far below the chrome band's foot the accent rail must finish, in NDC.
 *
 * 0.05 NDC is 21 px on an 844 px phone and 20 px on an 800 px desktop — a gap a child
 * reads as "the rail belongs to the room, the chips belong to the app". It is a *guard*:
 * with the real `--chrome-h` the natural solve already clears the band by 24-61 px at every
 * viewport tested, so this binds only if a future HUD grows a third row.
 */
const RAIL_CLEAR_NDC = 0.05;
const MIN_DISTANCE = 8;
const MAX_DISTANCE = 16;

/** Basket width as a fraction of the visible width, before clamping. */
const BASKET_WIDTH_RATIO = 0.6;
/**
 * However wide the window gets, the lane stops growing. This is not only a legibility
 * clamp: the basket has to be able to *cross* it inside the shortest fall (0.83 s) or a
 * drop stops being catchable, and at `BASKET_MAX_SPEED` a 4.8-unit lane takes 0.34 s plus
 * the spring's settle.
 */
const PLAY_HALF_MAX = 2.4;
/**
 * Floor on the lane's half-travel.
 *
 * 0.4 rather than 0.5, because at the narrowest play area the product supports (a 300 px card
 * on a tall phone) `halfX` is about 1.20 and `BASKET_W_MIN` is 1.35, so `LANE_FRACTION` asks for
 * 0.357 — and clamping that back up to 0.5 puts the tub's outer flank at **ndc 1.045**, i.e.
 * off the side of the frame at full reach. At 0.4 it lands at 0.896. The lane is still 0.8 units
 * of travel, a third of the visible width; below that the basket may as well be fixed.
 */
const PLAY_HALF_MIN = 0.4;
/**
 * How much of the visible half-width the basket's *outer edge* is allowed to reach.
 *
 * It used to be all of it — `playHalf = halfX - basketW / 2 - 0.04` puts the tub's flank
 * flush against the frame edge — and that single line is why round 4 measured the alcove
 * "cropped at both side edges with no headroom". The opening has to be at least as wide as
 * the lane (`nicheHalfX >= playHalf + basketW / 2 + 0.35`) or the basket would slide behind
 * its own reveal, so a lane that reaches the frame edge forces the *reveal* to the frame
 * edge too: measured, the opening's right reveal landed at ndc.x **0.981 on desktop and
 * 0.947 on a phone** — inside the frame by 2-5 %, which is exactly the band where an edge
 * clips rather than reads.
 *
 * At 0.86 the basket stops a seventh of the half-width short, the opening's lower bound
 * drops with it, and the reveal lands at 0.869 on desktop — visibly inside, with the pale
 * wing beside it doing the job it exists for. The lane loses 19 % of its travel and keeps
 * every drop reachable, because spawns are placed inside `playHalf` rather than inside a
 * fixed world width.
 */
const LANE_FRACTION = 0.86;
/**
 * Where the opening's reveal is allowed to land, in ndc.x, and the band it may never land
 * in.
 *
 * An alcove reads as an alcove when both reveals are inside the frame, and reads as a
 * painted rectangle when one of them sits on the frame edge. On a phone held upright the
 * first is arithmetically impossible — the lane alone needs more than the frame is wide at
 * that depth — so the rule is a *dichotomy* rather than a bound: comfortably inside, or far
 * enough outside that the recess simply fills the picture the way a backdrop should.
 */
const REVEAL_INSIDE_NDC = 0.88;
const REVEAL_OUTSIDE_NDC = 1.12;
/**
 * The aspect the **set** is sized for, whatever aspect the play area reports.
 *
 * Round 4 photographed the whole set framed at 1024x768: the shell's rounded left end, the
 * plinth's cap and the shelf mat's entire near-left corner, all inside the picture over bare
 * page cream. That cannot happen if the numbers agree — `matHalfX` is
 * `matDepth * tan * wide + 0.7`, so its corner projects to `1 + 0.7 / (matDepth * tan * wide)`,
 * which is **greater than 1 by construction at every aspect**. It happened anyway, so the
 * aspect the set was sized for and the aspect it was rendered at were not the same number.
 *
 * The set is therefore no longer sized for the measured aspect at all. It is sized for the
 * widest one the product supports, so a stale or mid-transition measurement cannot expose an
 * edge — a mistimed measure now only mis-frames the *subject*, which the DEV check in
 * `scene.tsx` reports by name. The cost is a few flat columns on a mesh whose flat regions
 * are sampled at `CELL_FLAT`: about 600 triangles at the widest viewport tested.
 */
const SET_ASPECT_MIN = 2.2;

/* ------------------------------------------------------------------ */
/* The set                                                             */
/* ------------------------------------------------------------------ */

/** Thickness of the clay shelf mat the basket slides on. */
export const MAT_T = 0.055;
/**
 * Top of the mat. The basket stands on it, drops land on it and the physics floor sits at
 * this height — the `Rig`'s own ground plane at y = 0 is the table the mat lies on.
 */
export const STAGE_Y = MAT_T;

/** Z of the alcove's back panel, and of the pale wings and lintel standing in front of it. */
export const PANEL_Z = -2.55;
export const PANEL_T = 0.5;
export const FRAME_Z = -2.05;
export const FRAME_T = 0.45;
/** How far below the shelf every upright is buried, so no base edge is ever in shot. */
export const SET_BASE_Y = -0.8;
/**
 * Height of the accent rail that caps the alcove opening. It sits on the shell's own flat
 * face, standing `NICHE_MOUTH_Z - (FRAME_Z - (FRAME_T + 0.16) / 2)` = 0.08 units proud of
 * it, which is what makes it read as the lip of a chute rather than as paint.
 */
export const RAIL_H = 0.13;

/* ------------------------------------------------------------------ */
/* The alcove shell                                                    */
/* ------------------------------------------------------------------ */

/**
 * The alcove, as one continuous surface. See `set.ts` for the builder and for the round-3
 * argument; these are the numbers it is built from.
 *
 * `NICHE_MOUTH_Z` is where the pale wall face sits — exactly where the old wings' front
 * face was, so the accent rail's 0.08-unit proudness is unchanged.
 */
export const NICHE_MOUTH_Z = FRAME_Z + FRAME_T / 2;

/**
 * The deepest point of the recess.
 *
 * Bounded below by the mat: the shell plunges through the shelf plane on its way down to
 * `SET_BASE_Y`, and that intersection must stay hidden behind the plinth or it shows as a
 * bright cream line along the foot of the alcove. The plinth's top-back edge is at
 * `y = STAGE_Y + 0.3`, `z = FRAME_Z + 0.12 - 0.18` = (0.355, -2.11); a sight line through
 * it at the camera's fixed 19-degree elevation reaches the shelf plane
 * `0.30 / tan(19 deg)` = 0.871 units further back, at **z = -2.981**. Anything in front of
 * that is occluded, so -2.60 has 0.38 units of margin. Bounded above by `matFar`
 * (`PANEL_Z - 0.2` = -2.75), which must stay behind the shell so no gap opens at the back.
 */
export const NICHE_BACK_Z = -2.6;

/**
 * Half-width of the reveal — the rounded return from the wall face into the recess.
 *
 * This is the number that killed the razor edge round 3 measured at the wing junction
 * (`(138,129,116) -> (127,88,59)` in one pixel). The surface turns through the full
 * `NICHE_MOUTH_Z - NICHE_BACK_Z` = 0.775 units of depth over this width using a quintic
 * smootherstep, whose second derivative vanishes at both ends: the tightest radius of
 * curvature anywhere on the turn is `(1 + z'^2)^1.5 / |z''|` = **0.242 units**, twelve
 * times `3D-SPEC §3`'s 0.02 minimum bevel, and the joins to the flat wall and to the flat
 * interior are curvature-continuous rather than merely tangent-continuous.
 * `set.ts: turnRadius` computes it and `buildAlcove` asserts it on every build in dev.
 */
export const NICHE_SIDE_FILLET = 0.44;

/**
 * How far the interior bows forward toward the reveals, as a fraction of the opening's own
 * half-width, and the band it is held inside.
 *
 * A flat back wall has a constant normal, and a constant normal under a *directional* key is
 * a constant `N.L`: round 3 measured 3 % luminance variation over 500 px and sigma 1.3/255
 * over a 40x40 patch, which is what "flat, unlit slab" means arithmetically. A quadratic dish
 * tips the normal by `atan(2 * dish / openHalfX)` at the arris, and the fraction is chosen so
 * that angle is ~10 degrees at **every** viewport rather than at one: a fixed 0.16 gave 11.2
 * degrees on a phone's 1.61 half-width but only 4.6 on a desktop's 4.02, which is where the
 * wall is widest and the flatness most visible.
 *
 * At 10 degrees the studio key (normalised `(-0.4216, 0.7379, 0.5270)`) walks the wrapped
 * diffuse response from **0.1558 on the left of the recess to 0.1722 on the right — a 10.6 %
 * luminance sweep across the back wall**, and it holds within half a point of that from a
 * 1.61 half-width to a 4.02 one. Verified in `scratchpad/verify/tooth-rescue-alcove.mjs`.
 */
const NICHE_DISH_TILT = 0.088;
export function nicheDish(openHalfX: number): number {
  return clamp(NICHE_DISH_TILT * openHalfX, 0.12, 0.34);
}

/**
 * Height of the coved soffit at the head of the alcove, as a function of how tall the
 * opening turned out to be.
 *
 * The cove is where the vertical gradient comes from. Over it the surface turns from
 * facing the camera to facing the floor, so `N.L` falls from 0.527 to 0.119 — the top of
 * the alcove goes to a fifth of the light the middle gets, with no shadow map involved.
 * Clamped so a short phone opening still gets a cove and a tall desktop one does not spend
 * a third of the drop inside it. Max slope is `1.875 * depth / span` (the quintic's peak
 * derivative). Every viewport tested solves to 1.04-1.08, where the soffit reaches
 * **54.4 degrees at its steepest** and the wrapped `N.L` reaches **-0.293**: the surface
 * faces the floor and keeps only the environment. Across the whole clamp band the steepest
 * point runs 51.6 degrees (at the 1.15 ceiling) to 72.8 (at the 0.45 floor), and the
 * tightest radius of curvature is 0.242 units — twelve times `3D-SPEC §3`'s minimum bevel —
 * at that floor.
 */
export function nicheCoveSpan(nicheTop: number): number {
  return clamp(0.34 * (nicheTop - STAGE_Y), 0.45, 1.15);
}

export type Framing = {
  position: [number, number, number];
  target: [number, number, number];
  fov: number;
  /** Distance from camera to aim point. */
  distance: number;
  /** View-space depth of the line the basket slides along. */
  basketDepth: number;
  /** Visible world half-width at that depth — the pointer mapping's only constant. */
  halfX: number;
  basketW: number;
  /** How far either side of centre the basket may travel, and drops may land. */
  playHalf: number;
  shadowArea: number;

  /* --- the set, solved from the camera above so no edge of it can be framed --- */
  /** Half width of the shelf mat, and the z of its near and far edges. */
  matHalfX: number;
  matNear: number;
  matFar: number;
  /** Half width and top of the alcove's back panel. */
  wallHalfX: number;
  wallTop: number;
  /** Half width of the opening between the pale wings, and the height of its head. */
  nicheHalfX: number;
  nicheTop: number;
};

/**
 * Frames the whole drop from the measured play-area rect.
 *
 * `GameShell` hands a game the entire shell interior — 1.03:1 on a laptop, 0.48:1 on a
 * phone held upright — so only the *vertical* constraint is solved here: the drop height
 * is what must fit, and the field then becomes exactly as wide as the screen turned out to
 * be. That is the right trade for a catch game: on a narrow phone the child gets a narrow
 * lane and a proportionally chunkier basket, and every drop is still reachable, because
 * spawns are placed inside the basket's own reach rather than inside a fixed world width.
 *
 * Everything *outside* the lane is then filled with real set, sized from the same solve —
 * see `matHalfX` / `wallHalfX` below.
 */
export function solveFraming(
  width: number,
  height: number,
  chromePx: number = CHROME_PX_FALLBACK,
  occupiedBottomPx?: number
): Framing {
  const aspect = width > 0 && height > 0 ? width / height : 0.75;
  const wide = Math.max(0.3, aspect);
  // The set outruns the frame at *any* aspect the product supports, not at the one this
  // call happened to be handed. See `SET_ASPECT_MIN`.
  const setWide = Math.max(wide, SET_ASPECT_MIN);
  const band = chromePx > 0 ? chromePx : CHROME_PX_FALLBACK;
  /*
   * Two readings of the same band, and they are not interchangeable.
   *
   * `bandFrac` is the truth — how much of the shell the title, the pills and the chips
   * actually occupy. `chrome` is what the *camera* is allowed to give away, clamped at 0.34
   * because a landscape phone would otherwise report the chrome eating half the frame and
   * push the camera to `MAX_DISTANCE` for a picture nobody can see.
   *
   * Everything that decides where the picture sits uses `chrome`. Everything that decides
   * whether a *prop* is underneath a chip uses `bandFrac` — because when the two differ, the
   * chips are still there. On a 390x844 phone with a wrapped HUD the band is ~313 px
   * (0.371), so the clamp bites and a rail placed against `chrome` would sit 26 px inside
   * the chip group.
   */
  const bandFrac = height > 0 ? Math.min(0.5, band / height) : 0.2;
  const chrome = Math.min(0.34, bandFrac);

  const span = FRAME_TOP - FRAME_BOTTOM;
  const halfProjected = (span * COS_E + FIELD_DEPTH * SIN_E) / 2 + MARGIN;
  const raw = halfProjected / (TAN_HALF * Math.max(0.3, 1 - chrome));
  const distance = clamp(raw, MIN_DISTANCE, MAX_DISTANCE);

  // Half the chrome band, in world units at the aim plane, applied along the camera's own
  // up vector (0, cos, -sin) so the picture slides down without the angle changing.
  const shift = chrome * distance * TAN_HALF;
  const ty = (FRAME_TOP + FRAME_BOTTOM) / 2 + shift * COS_E;
  const tz = -shift * SIN_E;

  // Depth of the basket line: distance, corrected for the basket sitting below and in
  // front of the aim point. Forward is (0, -sin, -cos), so this is just a dot product.
  const basketDepth = distance + SIN_E * (ty - BASKET_H * 0.5) + COS_E * tz;
  const halfX = basketDepth * TAN_HALF * wide;

  // Quantised, so a one-pixel reflow can never rebuild the basket's geometry.
  const basketW = clamp(
    Math.round((halfX * BASKET_WIDTH_RATIO) / 0.05) * 0.05,
    BASKET_W_MIN,
    BASKET_W_MAX
  );
  // The lane stops a `LANE_FRACTION` short of the frame edge rather than touching it, so
  // the alcove opening it forces open has somewhere to put its reveals.
  const playHalf = clamp(halfX * LANE_FRACTION - basketW / 2, PLAY_HALF_MIN, PLAY_HALF_MAX);

  /* ---- where the frame's edges actually land, so the set can outrun them ---- */

  // Camera position, and the two rays through the centre of the frame's top and bottom
  // edges. Forward is (0, -sin, -cos) and up is (0, cos, -sin), so `f ∓ tan(fov/2) * u`
  // are these two, written out with the signs folded in.
  const cy = ty + distance * SIN_E;
  const cz = tz + distance * COS_E;
  const downY = SIN_E + TAN_HALF * COS_E;
  const downZ = COS_E - TAN_HALF * SIN_E;
  const upY = SIN_E - TAN_HALF * COS_E;
  const upZ = COS_E + TAN_HALF * SIN_E;

  // Bottom edge, on the shelf: everything nearer than this is out of shot.
  const matNear = cz - downZ * ((cy - STAGE_Y) / downY);
  const matFar = PANEL_Z - 0.2;
  // Widest where the shelf is deepest in view — the far edge, not the near one.
  const matDepth = (cy - STAGE_Y) * SIN_E + (cz - matFar) * COS_E;
  const matHalfX = matDepth * TAN_HALF * setWide + 0.7;

  // Top edge, on the back panel. `upY > 0` is the "horizon stays out of frame" condition;
  // if a future FOV/elevation edit ever broke it the ray would never meet the panel, so
  // the fallback simply builds a very tall wall rather than an infinite one.
  const wallTop = upY > 1e-3 ? cy - upY * ((cz - PANEL_Z) / upZ) : cy + span;
  const wallDepth = (cy - SET_BASE_Y) * SIN_E + (cz - PANEL_Z) * COS_E;
  const wallHalfX = wallDepth * TAN_HALF * setWide + 0.7;

  /*
   * The alcove opening.
   *
   * Lower bound: just outside the basket's travel, or the tub slides behind its own reveal.
   * Then the dichotomy `REVEAL_INSIDE_NDC` / `REVEAL_OUTSIDE_NDC` — the reveal may sit
   * comfortably inside the picture or comfortably outside it, and never on the edge. The
   * projection is solved on the reveal's own plane (`NICHE_MOUTH_Z`, where the pale wall
   * face is) at the height a child reads the opening's width at, because a 19-degree tilt
   * puts that plane at a different depth from the drop's z = 0.
   */
  const revealDepth = (cy - (BASKET_H + 0.3)) * SIN_E + (cz - NICHE_MOUTH_Z) * COS_E;
  const revealSpan = revealDepth * TAN_HALF * wide;
  const nicheFloor = playHalf + basketW / 2 + 0.35;
  const nicheCeiling = Math.max(basketW / 2 + 0.25, wallHalfX - 0.95);
  const nicheHalfX = clamp(
    nicheFloor <= revealSpan * REVEAL_INSIDE_NDC
      ? nicheFloor
      : Math.max(nicheFloor, revealSpan * REVEAL_OUTSIDE_NDC),
    basketW / 2 + 0.2,
    nicheCeiling
  );

  /**
   * The head of the alcove is solved, not placed: it lands on the **same screen height as
   * the spawn**, so a tooth is born a hair behind the lintel and slides out of the chute
   * mouth instead of appearing in mid-air. It has to be solved because the two live on
   * different planes — the drop at z ≈ 0, the lintel 2 units further back — and a camera
   * tilted 19° down projects the further one higher up the frame, by an amount that changes
   * with the viewport. Placing it by hand put the accent rail behind `GameShell`'s chrome
   * band at every size tested.
   */
  const ndcY = (y: number, z: number) => {
    const dy = y - cy;
    const dz = z - cz;
    const depth = -dy * SIN_E - dz * COS_E;
    return depth > 1e-3 ? (dy * COS_E - dz * SIN_E) / (depth * TAN_HALF) : 0;
  };
  const yAtNdc = (ndc: number, z: number) => {
    const k = ndc * TAN_HALF;
    return cy + ((z - cz) * (SIN_E - k * COS_E)) / (COS_E + k * SIN_E);
  };
  /*
   * ...and then the *safe* rect, which is the half of B6.5 the shift alone does not cover.
   * `1 - 2 * bandFrac` is the NDC height of the chrome band's foot, so the rail's own top —
   * `nicheTop + RAIL_H - 0.02`, the way `scene.tsx` places it — must project below that by
   * `RAIL_CLEAR_NDC`. Solved on `FRAME_Z`, the plane the rail actually lives on, because a
   * 19-degree tilt projects that plane higher up the frame than the drop's z = 0.
   */
  // A9: the shell now publishes the *occupied* rect as well as the band. The rail runs the
  // full width of the opening, so it overlaps the rect's horizontal span at every viewport
  // and has to clear its foot — which is at or above `--chrome-h`, so adopting it can only
  // give the picture room back, never take it. `--chrome-h` remains the fallback for a
  // shell that has not published the rect (and for SSR).
  const occupiedFrac =
    occupiedBottomPx !== undefined && occupiedBottomPx > 0 && height > 0
      ? Math.min(bandFrac, occupiedBottomPx / height)
      : bandFrac;
  const railCeiling =
    yAtNdc(1 - 2 * occupiedFrac - RAIL_CLEAR_NDC, FRAME_Z) - (RAIL_H - 0.02);
  const nicheTop = clamp(
    Math.min(yAtNdc(ndcY(SPAWN_Y, 0) + 0.03, FRAME_Z), railCeiling),
    BASKET_H + 0.6,
    wallTop - 0.35
  );

  return {
    position: [0, cy, cz],
    target: [0, ty, tz],
    fov: FOV,
    distance,
    basketDepth,
    halfX,
    basketW,
    playHalf,
    // Bound the table the action happens on, not the world (3D-FOUNDATION-NOTES §8).
    shadowArea: clamp(2 * nicheHalfX + 2.4, 7, 14),
    matHalfX,
    matNear,
    matFar,
    wallHalfX,
    wallTop,
    nicheHalfX,
    nicheTop,
  };
}

/** Two framings differ only when something a child could see differs. */
export function sameFraming(a: Framing | null, b: Framing): boolean {
  if (!a) return false;
  return (
    Math.abs(a.distance - b.distance) < 0.02 &&
    Math.abs(a.basketW - b.basketW) < 0.001 &&
    Math.abs(a.playHalf - b.playHalf) < 0.02 &&
    Math.abs(a.target[1] - b.target[1]) < 0.02 &&
    Math.abs(a.matHalfX - b.matHalfX) < 0.05 &&
    Math.abs(a.wallHalfX - b.wallHalfX) < 0.05 &&
    Math.abs(a.nicheHalfX - b.nicheHalfX) < 0.05 &&
    // The alcove shell is rebuilt from `wallTop` and `nicheTop` as well as the two widths,
    // and since round 3 that is a real mesh rather than a `roundedBox` extent. Both are
    // derived from `distance` and `target[1]`, which are already compared above, so this
    // adds no rebuilds in practice — it just stops the memo's dependencies being a claim.
    Math.abs(a.wallTop - b.wallTop) < 0.05 &&
    Math.abs(a.nicheTop - b.nicheTop) < 0.03
  );
}

/* ------------------------------------------------------------------ */
/* Pile slots                                                          */
/* ------------------------------------------------------------------ */

/**
 * Where each caught tooth ends up, in basket-local space.
 *
 * The solver in `physics.ts` is spheres-against-static-geometry — bodies do not collide
 * with each other — so a physical pile would be fourteen teeth occupying one point. Instead
 * a caught tooth lands for real (its impact drives the basket's wobble and its own squash)
 * and is then handed to a spring that carries its landing velocity into an assigned slot.
 * The result reads as a pile with weight, rides the basket exactly instead of lagging a
 * frame behind it — and, since round 4, **cannot** interpenetrate, because that is now a
 * property of the solve rather than a hope about the grid.
 *
 * ---------------------------------------------------------------------------
 * Round 4 (B6.2): what the grid actually produced
 * ---------------------------------------------------------------------------
 *
 * The old solver laid `cols x 2` bricks on fixed 0.386-unit layers. Three arithmetic
 * failures, all reproducible from the numbers it shipped:
 *
 *  - **`cols` and `pitch` disagreed.** `cols` was chosen as `floor(2 usable / 0.547) + 1`,
 *    i.e. as if the pitch were `2 usable / (cols - 1)`, and the pitch was then computed as
 *    `2 usable / (cols - 1 + 0.44)` to make room for the brick offset. On a 2.5-wide basket
 *    that is `1.686 / 3.44` = **0.490 against a stated 0.547 minimum**, so neighbouring
 *    crowns were 10 % closer than the constant that exists to stop them touching.
 *  - **No cross-layer test at all.** Measured over the shipped slots, the closest pair was
 *    **0.443 units apart on desktop and 0.365 on a phone**, against a crown width of 0.514:
 *    a 14 % and a 29 % interpenetration, between a slot in one layer and one in the next.
 *  - **The jitter escaped the clamp.** `|x|` reached exactly `usable` before a ±0.01
 *    scatter was added, so the outermost crowns finished 0.010 *inside* the clay wall and
 *    0.002 through the front one.
 *
 * ---------------------------------------------------------------------------
 * What it is now: a drop solve
 * ---------------------------------------------------------------------------
 *
 * Each tooth is modelled as the ellipsoid `PILE_A x PILE_B x PILE_A` it measures, and slots
 * are placed one at a time by *dropping* them:
 *
 *  1. take a deterministic low-discrepancy set of candidate `(x, z)` inside the usable
 *     floor (the interior inset by `PILE_A`, so no crown can reach the clay);
 *  2. for each candidate, compute the **lowest** `y` at which its ellipsoid touches but does
 *     not overlap every slot already placed, or the well floor;
 *  3. keep the candidate that lands lowest, breaking ties toward the middle of the tub.
 *
 * Two guarantees fall out of the construction rather than out of a pass afterwards. No pair
 * can overlap, because step 2 is exactly the no-overlap condition solved for `y`. And
 * nothing can levitate, because the `y` chosen is the *smallest* admissible one, so every
 * slot is in contact with the floor or with the slot that produced its bound — which
 * `pileSupport` below returns, and which the game asserts in DEV.
 *
 * Preferring the lowest landing and then the centre is also what makes the heap a heap: the
 * floor fills first, the second course drops into the dimples of the first, and the profile
 * narrows as it rises instead of standing four columns tall.
 *
 * **Yaw is deliberately small.** It used to be a full `n1 * 2π`, which turned a basket of
 * mascots into a basket of anonymous backs of heads: half the pile faced away from camera.
 * Every caught tooth settles within ±26° of front-on, which is what makes the end of a run
 * read as "look how many friends I rescued".
 */
export type PileSlots = {
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
  yaw: Float32Array;
  lean: Float32Array;
  /**
   * Top of the basket's floor collider while slot `i` is the next one to fill, in
   * basket-local units. Set to `y[i] - TOOTH_R`, so a tooth caught into that slot lands at
   * the slot's own height and the homing spring has nothing vertical left to do — which is
   * what stops a catch dropping through the heap and then jumping back up it.
   */
  landing: Float32Array;
  /** Highest point of a full heap, for the DEV framing check. */
  top: number;
};

/**
 * Candidate `(x, z)` positions tried per slot.
 *
 * The R2 low-discrepancy sequence (the 2-D generalisation of the golden ratio) covers a
 * rectangle far more evenly than a jittered grid at this count and needs no RNG state, so
 * the same basket width always solves to the same heap — a resize cannot reshuffle a pile
 * the child is looking at.
 */
const PILE_CANDIDATES = 112;
const R2_A1 = 0.7548776662466927;
const R2_A2 = 0.5698402909980532;
/** How strongly a tie is broken toward the middle of the tub, in units of `y`. */
const PILE_CENTRE_BIAS = 0.06;

/** Squared horizontal separation of two slots in units where 1.0 is "just touching". */
function pileHorizontal2(dx: number, dz: number): number {
  const a = 2 * PILE_A;
  return (dx * dx + dz * dz) / (a * a);
}

/**
 * How deep into the tub's mouth a tooth sits when it is wedged on the rim rather than down
 * in the well, as a fraction of `PILE_B`.
 *
 * The well is not the whole basket, and this is the number that stops the heap being a tower.
 * Without it the phone basket is unsolvable: its well floor is 1.05 x 1.14 units and a settled
 * tooth is 0.514 x 0.514 x 0.74, so fourteen of them stack **2.97 units proud of the rim** —
 * higher than the chute they fell out of and off the top of the frame. A real basket with more
 * in it than it holds does not do that; the last teeth wedge across the rolled lip, which is
 * both what one looks like and the difference between a heap and the levitating fan round 4
 * photographed.
 *
 * A slot centre over the rim is kept inside the tub's own silhouette, so a crown overhangs by
 * at most `PILE_A` and its weight is still over clay. 0.72 seats it a quarter of the way into
 * the mouth rather than balanced on top of the lip. Capacity goes from the well's 1.05 x 1.14
 * to the tub's 1.35 x 1.44 — 1.62x the footprint — which is what takes the heap from 2.97
 * proud to under 0.6.
 */
const PILE_RIM_SEAT = 0.72;

export function pileSlots(basketW: number): PileSlots {
  const innerHalfW = basketW / 2 - WALL;
  // Inside the well a crown may reach the clay and no further, so a slot centre is never
  // closer than `PILE_A` to it on any side.
  const wellX = Math.max(0.02, innerHalfW - PILE_A);
  const wellZ = Math.max(0.02, INNER_HALF_D - PILE_A);
  // Over the rim the centre stays inside the tub's silhouette, so the crown overhangs by at
  // most `PILE_A` and never stands over open air.
  const ux = Math.max(wellX, basketW / 2);
  const uz = Math.max(wellZ, BASKET_D / 2);
  // Where a tooth rests when it is wedged on the rim rather than down in the well.
  const rimRest = RIM_Y + PILE_B * PILE_RIM_SEAT;

  const x = new Float32Array(PILE_SLOTS);
  const y = new Float32Array(PILE_SLOTS);
  const z = new Float32Array(PILE_SLOTS);
  const yaw = new Float32Array(PILE_SLOTS);
  const lean = new Float32Array(PILE_SLOTS);
  const landing = new Float32Array(PILE_SLOTS);

  for (let i = 0; i < PILE_SLOTS; i++) {
    let bestX = 0;
    let bestZ = 0;
    let bestY = PILE_BASE_Y;
    let bestScore = Infinity;

    for (let c = 0; c < PILE_CANDIDATES; c++) {
      // R2 walks (0,1)² without ever repeating a pattern the eye can lock on to. The slot
      // index offsets the sequence so two slots never test the same list in the same order.
      const u = (0.5 + R2_A1 * (c + 1 + i * PILE_CANDIDATES)) % 1;
      const v = (0.5 + R2_A2 * (c + 1 + i * PILE_CANDIDATES)) % 1;
      const cx = (u * 2 - 1) * ux;
      const cz = (v * 2 - 1) * uz;

      // Two floors, and which one a candidate gets is a question about its crown rather than
      // its centre: a tooth whose whole crown clears the clay drops to the well, anything
      // else is standing on the rolled lip.
      const inWell = Math.abs(cx) <= wellX && Math.abs(cz) <= wellZ;
      let cy = inWell ? PILE_BASE_Y : rimRest;
      for (let j = 0; j < i; j++) {
        const h2 = pileHorizontal2(cx - x[j], cz - z[j]);
        if (h2 >= 1) continue;
        const rest = y[j] + 2 * PILE_B * Math.sqrt(1 - h2);
        if (rest > cy) cy = rest;
      }

      const off = (Math.abs(cx) / ux + Math.abs(cz) / uz) * 0.5;
      const score = cy + PILE_CENTRE_BIAS * off;
      if (score < bestScore) {
        bestScore = score;
        bestX = cx;
        bestZ = cz;
        bestY = cy;
      }
    }

    x[i] = bestX;
    y[i] = bestY;
    z[i] = bestZ;
    landing[i] = bestY - TOOTH_R;
    // Deterministic pseudo-scatter for the pose only — it can never move a centre, so it can
    // never reopen the overlap the solve above closed.
    const n1 = (i * 0.6180339887) % 1;
    const n2 = (i * 0.7548776662) % 1;
    yaw[i] = (n1 - 0.5) * 0.9;
    lean[i] = (n2 - 0.5) * 0.26;
  }

  let top = PILE_BASE_Y;
  for (let i = 0; i < PILE_SLOTS; i++) if (y[i] > top) top = y[i];
  return { x, y, z, yaw, lean, landing, top: top + PILE_B };
}

/**
 * What slot `i` is resting on: `-1` for the well floor, otherwise the slot underneath it.
 *
 * This is the half of the drop solve that can be *checked*: a slot whose `y` is above both
 * the floor and every ellipsoid bound is levitating, and `scene.tsx` asserts in DEV that no
 * slot is. Returns `-2` if the slot overlaps something, which the same assertion reports.
 */
export function pileSupport(slots: PileSlots, i: number, basketW: number): number {
  const eps = 1e-4;
  const innerHalfW = basketW / 2 - WALL;
  const inWell =
    Math.abs(slots.x[i]) <= Math.max(0.02, innerHalfW - PILE_A) &&
    Math.abs(slots.z[i]) <= Math.max(0.02, INNER_HALF_D - PILE_A);
  let support = -1;
  let best = inWell ? PILE_BASE_Y : RIM_Y + PILE_B * PILE_RIM_SEAT;
  for (let j = 0; j < i; j++) {
    const h2 = pileHorizontal2(slots.x[i] - slots.x[j], slots.z[i] - slots.z[j]);
    if (h2 >= 1) continue;
    const rest = slots.y[j] + 2 * PILE_B * Math.sqrt(1 - h2);
    if (rest > slots.y[i] + eps) return -2;
    if (rest > best) {
      best = rest;
      support = j;
    }
  }
  return slots.y[i] > best + eps ? -2 : support;
}

/* ------------------------------------------------------------------ */
/* Basket weave                                                        */
/* ------------------------------------------------------------------ */

/**
 * The woven-cane relief on the tub, and the two grips on its ends. Fourteen entries of
 * `[px, py, pz, sx, sy, sz, tint]`, all instances of one rounded unit cube, so the whole
 * thing costs a single draw call.
 *
 * ---------------------------------------------------------------------------
 * This replaces `trimLayout`, which the audit called, correctly, blood
 * ---------------------------------------------------------------------------
 *
 * The old trim was four saturated `red.main` prongs hanging down the front of an ivory,
 * tooth-coloured tub from a horizontal red band. In a children's dental app the most
 * available read for that is blood, which `3D-SPEC §1.1` bans outright. Three separate
 * defects, one shape:
 *
 *  - **Vertical + red + descending = a drip.** The relief is now the tub's own pale clay.
 *    The accent survives only as the rolled rim band, which is painted straight onto the
 *    tray's own surface through the per-vertex albedo attribute (see `scene.tsx:
 *    paintBasket`) — so it is a *rim*, at the top, going around, not a slash across the
 *    middle with things dripping from it.
 *  - **Floating fins.** The old slats were seated 0.95 mm into a wall and hung 4.55 mm in
 *    free air. `SLAT_SEAT` below is derived: a slat's inner face lands exactly on the
 *    well's inner surface, `WALL` deep, so it is embedded through the full thickness of
 *    the clay and cannot poke into the well either.
 *  - **A hard dark interpenetration notch** where the slats crossed the band at
 *    `BAND_Y = 0.5`. There is no band mesh any more, so there is nothing to cross.
 *
 * The `tint` field is 0 for the pale cane and 1 for the accent grips; `scene.tsx` turns it
 * into a per-instance `aAlbedo` value. One geometry, one material, two colours.
 */
/**
 * Instance budget for the weave. The live count is written by `weaveLayout` and read back as
 * `InstancedMesh.count`, so a narrow basket does not pay for a wide one's staves.
 *
 * ---------------------------------------------------------------------------
 * Round 4 (B6.8): three staves and two wefts is a fence, not basketry
 * ---------------------------------------------------------------------------
 *
 * The audit called the relief "a floating decal plate with a paper-thin shadow and no AO at
 * the join", and `tooth-rescue-tier-low.png` shows exactly that: a three-picket fence with two
 * rails, centred on an otherwise plain wall. Three things were wrong and all three are
 * arithmetic:
 *
 *  - **`PROUD` was 3 mm.** The studio key arrives at 47.6 degrees, so relief `p` throws a
 *    shadow `p * (0.7379 / 0.5270)` = **1.4 p** long: 0.042 units, about 4 screen pixels at
 *    this prop's framing. That is the paper-thin shadow, measured. At 0.07 it is 0.098 units,
 *    and the staves read as staves.
 *  - **Nothing cast it.** The instanced mesh had `castShadow` off, under a comment claiming
 *    fourteen extra shadow draws. An `InstancedMesh` is **one** draw call in the shadow pass
 *    whatever its instance count, and its shadow is not the tub's — the tub's silhouette is
 *    behind the staves, not on them.
 *  - **The stave count was fixed at three.** The tub is between 1.35 and 2.9 units wide, so
 *    three staves is a weave on the narrowest basket and a fence on the widest. It now follows
 *    the width at a fixed pitch, which is what makes it read as a woven surface rather than as
 *    a motif applied to one.
 */
export const WEAVE_MAX = 26;
export const WEAVE_TINT_CANE = 0;
export const WEAVE_TINT_GRIP = 1;

/** Vertical span of the cane, kept clear of the base roll and of the rim band. */
const SLAT_BOTTOM = 0.15;
const SLAT_TOP = BASKET_H - 0.3;
/** How far the cane stands out of the tub. See `WEAVE_MAX` for where 0.07 comes from. */
const PROUD = 0.07;
/**
 * How far a slat's inner face is buried **past** the well's inner surface.
 *
 * It used to be exactly zero — `seatZ = halfD + (PROUD - WALL) / 2` puts the inner face on
 * `halfD - WALL`, which *is* the well's inner surface — so the two coplanar faces z-fought.
 * `tooth-rescue-tier-low.png` shows the result as two bright slivers on the inside of the back
 * wall, in the middle of the tub, where a child looking into the basket sees them. A slat is
 * pressed *into* clay, so it goes in far enough that no depth precision question exists.
 */
const SEAT_BITE = 0.02;
/** Depth of a slat: the wall thickness, what stands proud of it, and the bite. */
const SLAT_SEAT = WALL + PROUD + SEAT_BITE;
/** Target gap between stave centres. A thumb's width of cane. */
const STAVE_PITCH = 0.42;
const STAVE_MIN = 3;
const STAVE_MAX = 7;

/** How many staves run down each long face of a tub this wide. Always odd, so one is central. */
export function staveCount(basketW: number): number {
  const straightW = Math.max(0.06, basketW / 2 - CORNER);
  const raw = Math.floor((straightW * 2) / STAVE_PITCH) + 1;
  const odd = raw % 2 === 0 ? raw - 1 : raw;
  return odd < STAVE_MIN ? STAVE_MIN : odd > STAVE_MAX ? STAVE_MAX : odd;
}

/** Live instance count for a tub this wide: staves on both long faces, two ends, wefts, grips. */
export function weaveCount(basketW: number): number {
  return staveCount(basketW) * 2 + 2 + 4 + 2;
}

export function weaveLayout(basketW: number): Float32Array {
  const out = new Float32Array(WEAVE_MAX * 7);
  const halfW = basketW / 2;
  const halfD = BASKET_D / 2;
  const straightW = Math.max(0.06, halfW - CORNER);
  const slatH = SLAT_TOP - SLAT_BOTTOM;
  const slatY = (SLAT_TOP + SLAT_BOTTOM) / 2;
  const staves = staveCount(basketW);
  // Centre of a slat that reaches from `SEAT_BITE` inside the well to `PROUD` outside the tub.
  const seatZ = halfD + (PROUD - WALL - SEAT_BITE) / 2 + SEAT_BITE;
  const seatX = halfW + (PROUD - WALL - SEAT_BITE) / 2 + SEAT_BITE;

  let w = 0;
  const put = (
    px: number,
    py: number,
    pz: number,
    sx: number,
    sy: number,
    sz: number,
    tint: number
  ) => {
    out[w++] = px;
    out[w++] = py;
    out[w++] = pz;
    out[w++] = sx;
    out[w++] = sy;
    out[w++] = sz;
    out[w++] = tint;
  };

  // Cane staves, the same run on the front face and the back.
  for (let i = 0; i < staves; i++) {
    const t = staves > 1 ? (i / (staves - 1)) * 2 - 1 : 0;
    const px = t * straightW * 0.82;
    put(px, slatY, seatZ, 0.13, slatH, SLAT_SEAT, WEAVE_TINT_CANE);
    put(px, slatY, -seatZ, 0.13, slatH, SLAT_SEAT, WEAVE_TINT_CANE);
  }
  // One on each end, seated the same way against the end wall.
  put(seatX, slatY, 0, SLAT_SEAT, slatH, 0.13, WEAVE_TINT_CANE);
  put(-seatX, slatY, 0, SLAT_SEAT, slatH, 0.13, WEAVE_TINT_CANE);

  // Two horizontal weft hoops across the long faces. Horizontal is the point: a vertical
  // red element that stops short of the base is a drip; a horizontal pale one is basketry.
  // They ride 12 mm *proud* of the staves rather than recessed behind them, because a
  // recessed weft would break the well's inner surface and a settled crown can reach it.
  const weftW = straightW * 1.94;
  for (let i = 0; i < 2; i++) {
    const py = SLAT_BOTTOM + slatH * (i === 0 ? 0.2 : 0.66);
    put(0, py, seatZ + 0.02, weftW, 0.1, SLAT_SEAT, WEAVE_TINT_CANE);
    put(0, py, -(seatZ + 0.02), weftW, 0.1, SLAT_SEAT, WEAVE_TINT_CANE);
  }

  // The grips: two rolled bars on the short ends, at rim height, in the accent. A basket
  // has handles; a wound does not. Seated half the wall thickness into the tub's flat
  // outer face, which at this height is below the rolled lip and so is genuinely flat.
  const gripY = BASKET_H - TOP_ROLL - 0.02;
  const gripD = Math.min(BASKET_D * 0.62, BASKET_D - 2 * WALL);
  put(halfW + 0.02, gripY, 0, 0.19, 0.15, gripD, WEAVE_TINT_GRIP);
  put(-(halfW + 0.02), gripY, 0, 0.19, 0.15, gripD, WEAVE_TINT_GRIP);

  return out;
}
