/**
 * Healthy or Not? — set metrics and the camera solve.
 *
 * Pure numbers. Importing this pulls in neither three nor React, so the shell can frame the
 * scene before a single geometry exists.
 *
 * **Scale (3D-SPEC §2): 1 world unit = 10 cm and a hero tooth prop is ~1.0 unit tall.**
 * The mascot is 1.05 units — 10.5 cm, a head-sized prop — and a food is 2–7 cm, the size of
 * the real thing in a child's hand. Every other metric in this file is derived from those
 * two so the whole set shares the product's shadow, fog and lighting read. (This used to be
 * `TOOTH_H = 1.9`, i.e. 1.81× the specified scale, which is why the celebration showed two
 * teeth at two different sizes and why the cast shadow read harder here than anywhere else.)
 *
 * The set is three objects, and each one is a different *kind* of thing so a child can tell
 * them apart without reading: the mascot tooth at the back, a turning turntable in front of
 * it carrying the round's food, and an open "no thank you" dish to the right that a
 * waved-off food tumbles into and settles in. Their spacing is not fixed:
 * `layoutFor(aspect)` pulls the composition together as the play area narrows, so a phone
 * held upright gets a stacked, near-centred set instead of a wide one the camera would
 * have to back away from until the food is a speck.
 */

/* ------------------------------------------------------------------ */
/* The mascot                                                          */
/* ------------------------------------------------------------------ */

/** `toothGeometry` is normalised to exactly 1.0 unit tall with its origin at the roots. */
export const TOOTH_H = 1.05;
export const TOOTH_X = 0;
export const TOOTH_Z = -0.72;

/** Normalised half-extents of `toothGeometry('baby')`, measured from the built mesh. */
export const TOOTH_HALF_W_N = 0.365;
export const TOOTH_HALF_D_N = 0.355;
export const TOOTH_HALF_W = TOOTH_HALF_W_N * TOOTH_H;
export const TOOTH_HALF_D = TOOTH_HALF_D_N * TOOTH_H;

/*
 * The crown, as a sphere.
 *
 * Every face feature below is seated against this rather than against a hand-guessed z,
 * which is what fixes the old face: the mouth was a flat ellipsoid pushed through a curved
 * surface, so it terminated in square-cut stubs, and the cheeks were secant patches that
 * cut across the form instead of shading with it.
 *
 * The numbers are a least-squares fit of a sphere centred on the tooth's own axis to 28
 * points of `toothGeometry("baby")`'s *front* surface, solved off the same metaball field
 * `geometry.ts` iso-surfaces (`TOOTH_BALLS.baby`, `ISO = 0.45`), in normalised tooth units:
 *
 *   centre (0, 0.716, 0) · radius 0.3563 · RMS residual 0.0027 (0.27 % of tooth height)
 *
 * A fit that tight means "sit this feature on the crown" is arithmetic, not taste.
 */
export const CROWN_YN = 0.716;
export const CROWN_RN = 0.3563;

export const EYE_XN = 0.15;
export const EYE_YN = 0.875;
export const EYE_ZN = 0.247;
export const EYE_RN = 0.068;
export const GLINT_RN = 0.021;

/*
 * The smile.
 *
 * A real arc, not a scaled ellipsoid: a circle drawn *on* the crown sphere. Take an axis
 * `A`, tilted `SMILE_AXIS_TILT` above horizontal and lying in the face's mirror plane; the
 * set of surface points at a fixed angle `SMILE_ALPHA` from `A` is a circle on the crown,
 * and the stretch of it nearest the chin is a smile that curls up into both cheeks.
 *
 * Derivation of the three angles (all in normalised tooth units):
 *   • the lowest point of the arc sits `SMILE_DROP` below the crown's equator, which puts
 *     the centre of the mouth at (0, 0.700, 0.356) — the anchor the old face used, kept so
 *     the ballistic solve that aims a food at the mouth did not have to move;
 *   • `SMILE_ALPHA` sets how tightly the arc curves, and `SMILE_SWEEP` how far round it
 *     runs; together they put the corners at (±0.170, 0.760) — a rise of 0.066 over a half
 *     width of 0.170, which is a frank grin rather than a polite one;
 *   • seating checked numerically at five points against the real metaball surface: worst
 *     error 0.0022, i.e. the tube's protrusion varies by under a tenth of its own radius.
 *
 * ---------------------------------------------------------------------------------------
 * WHY THIS IS ONE SWEPT TUBE AND NOT A CHAIN OF CAPSULES
 *
 * It used to be five `softCapsule`s seated on the arc, with a header claiming "five puts
 * the worst scallop at 0.0006 units — invisible". That number was wrong, and the shipped
 * render (`healthy-or-not-rest.png`) shows five countable beads with dark joints. The
 * arithmetic, in normalised tooth units:
 *
 *   arc radius            rho = CROWN_RN * sin(SMILE_ALPHA) = 0.3563 * 0.64279 = 0.22902
 *   tube radius           a   = LIP_TUBE_N                                     = 0.02800
 *   ideal outer surface   rho + a                                              = 0.25702
 *   five centres          spaced 2 * SMILE_SWEEP / 4 = 23.95 deg apart
 *   capsule half-length   h   = 0.031  (the old `cylinder = 0.062` / 2)
 *
 * At the midpoint between two centres the ray from the arc centre leaves the cylinder
 * section — it needs (rho + a) * tan(23.95/2 deg) = 0.05443 of straight run and only 0.031
 * exists — so the surface there is the *cap sphere*, at
 *   |C| cos(g) + sqrt(a^2 - |C|^2 sin^2 g)  with |C| = sqrt(rho^2 + h^2) = 0.231089
 *   and g = 23.95/2 - atan(h/rho) = 4.269 deg
 *   = 0.230449 + 0.022113 = 0.252562
 * i.e. **0.00444 tooth units of scallop, not 0.0006** — 7.4x the claimed figure, and
 * 0.00466 world units. `healthy-or-not-rest.png` renders the crown's 0.748-unit diameter
 * across 165 px, so 1 world unit is 220.5 px there and the scallop is **1.03 px**. Worse,
 * the surface normal *steps* by the full 23.95 deg at every joint, which is what turns a
 * 1 px notch into the four dark bands the audit photographed.
 *
 * A chain can never fix the normal step; it can only make it smaller. So the lip is now a
 * single sphere-swept tube built directly on the arc (`props.ts::buildLipGeometry`), whose
 * surface is by construction exactly `a` from the centreline everywhere. Its only error is
 * tessellation, and both terms are derived rather than asserted:
 *
 *   along the arc  32 rings over 2 * SMILE_SWEEP = 95.8 deg -> 2.99 deg per ring
 *                  chordal sag = rho * (1 - cos 1.495 deg) = 7.8e-5 units = 0.018 px
 *   around the tube 16 radial   -> 22.5 deg facets
 *                  sag = a * (1 - cos 11.25 deg) = 5.38e-4 units = 0.12 px
 *
 * Both are well under one pixel at the framing this game actually ships, and there is no
 * normal discontinuity anywhere on the tube or into its two hemispherical caps.
 */
export const SMILE_ALPHA = (40 * Math.PI) / 180;
export const SMILE_SWEEP = (47.9 * Math.PI) / 180;
export const SMILE_DROP = (2.6 * Math.PI) / 180;
export const SMILE_AXIS_TILT = SMILE_ALPHA - SMILE_DROP;
/** Half-thickness of the lip. Protrudes by its own radius, so it reads ~7 % of face width. */
export const LIP_TUBE_N = 0.028;
/** Rings along the arc, facets around the tube, stacks in each hemispherical cap. */
export const LIP_TUBE_RINGS = 32;
export const LIP_TUBE_RADIAL = 16;
export const LIP_CAP_STACKS = 4;

/** Centre of the closed smile — where a food is aimed, and where the mouth opens from. */
export const MOUTH_YN = 0.7;
export const MOUTH_ZN = 0.356;

/*
 * The open mouth is a separate solid that grows *downward from the lip line*, so the lip
 * is the upper lip through the whole chomp and the resting face is the arc alone — never a
 * 0.026-high sliver of ellipsoid, which is what used to read as a deadpan dash.
 *
 * Measured against the real surface: shut, the cavity is entirely inside the crown; at a
 * quarter open it shows a 0.142 × 0.049 opening; wide open, 0.270 × 0.157 with its top edge
 * at y = 0.705, tucked inside the lip tube (0.672–0.728), and a 0.035 lower-lip bulge.
 */
export const CAVITY_ZN = 0.318;
export const CAVITY_HALF_WN = 0.135;
/**
 * Half-depth of the cavity solid, and therefore how far it stands out of the crown.
 *
 * The crown's front surface at the mouth's height is `sqrt(CROWN_RN^2 - 0.016^2)` =
 * 0.355941, so a cavity centred at `CAVITY_ZN` shows a lens of exactly
 * `CAVITY_ZN + CAVITY_HALF_DN - 0.355941` of relief. At the shipped 0.055 that was 0.017
 * units — a sliver, which is part of why the mouth read as one flat colour. 0.066 gives
 * 0.028, and the interior gradient below has somewhere to happen.
 */
export const CAVITY_HALF_DN = 0.066;
export const CAVITY_OPEN_HN = 0.09;
/** Fraction of the cavity's width it keeps when barely open, so it opens as a slot. */
export const CAVITY_MIN_WIDTH = 0.45;

/**
 * How dark the back of the mouth gets, as a multiplier on the cavity's own token.
 *
 * The cavity is a convex solid pushed through a convex crown — there is no concave surface
 * for the key light to fall off across, so an unaided cavity renders as one flat patch no
 * matter which colour it is painted. `props.ts` therefore bakes this ramp into the
 * cavity's `aAlbedo` attribute, keyed on the vertex's own `z / r`: full token at the rim
 * where the opening meets the lip, `MOUTH_DARK` at the pole. It is shading, not a sixth
 * colour — the hue is `coral.deep` throughout.
 *
 * The visible lens spans `z / r` from `(CAVITY_HALF_DN - relief) / CAVITY_HALF_DN` =
 * 0.576 up to 1.0, so the ramp starts at 0.50 to land the rim at 98 % and the centre at
 * 32 %.
 */
export const MOUTH_DARK = 0.32;
export const MOUTH_DARK_FROM = 0.5;

/**
 * The tongue.
 *
 * A uniformly scaled ball — never a squashed ellipsoid — that *rises out of* the cavity as
 * the mouth opens instead of being scaled up inside it. At `show = 0` its centre sits one
 * full radius behind the cavity's surface, so it is entirely swallowed and cannot pop; at
 * `show = 1` it stands `TONGUE_PROUD_N` proud, which is a cap
 * `sqrt(2 * R * p - p^2)` = 0.052 units in half-width against an opening 0.135 units in
 * half-width — 39 % of it, not the saturated ellipse that filled the whole mouth before.
 * Because the ball is uniformly scaled it shades with its own form and its boundary is a
 * 38-degree cap join rather than the crisp edge of a flattened disc.
 *
 * `TONGUE_ZN` is derived, not chosen: the cavity's front surface at `TONGUE_YN` (0.035
 * below the fully open cavity's centre, half-height 0.09) is
 * `CAVITY_ZN + CAVITY_HALF_DN * sqrt(1 - (0.035 / 0.09)^2)` = 0.37881, and the hidden
 * position is that minus one tongue radius.
 */
export const TONGUE_YN = 0.603;
export const TONGUE_RN = 0.085;
export const TONGUE_ZN = 0.2938;
export const TONGUE_PROUD_N = 0.018;

/*
 * The blush.
 *
 * A ball offset along the crown normal until only a shallow cap emerges. Where the cap
 * meets the crown the two surfaces are close to parallel, so the boundary is tangent and
 * the blush falls off with the form instead of ending in the flat, unshaded patch the old
 * secant ellipsoid produced.
 *
 * Measured against the real metaball surface at `(0.265, 0.745)`, and this is the number
 * that matters: **the cheek and the crown now meet at 22°, where the shipped ellipsoid met
 * it at 108°.** An obtuse join is a crease you can see the edge of; 22° is a fade. Cap
 * half-width 0.078, peak relief 0.015 — one and a half millimetres across a 16 mm patch.
 * No visible part of the lip or the eyes falls inside the ball at any point (checked by
 * sampling both against the real surface), so nothing is swallowed by it.
 */
export const CHEEK_XN = 0.265;
export const CHEEK_YN = 0.745;
export const CHEEK_BALL_RN = 0.13;
export const CHEEK_PROUD_N = 0.02;

/** Where a healthy food is aimed: just inside the open mouth. */
export const MOUTH_X = TOOTH_X;
export const MOUTH_Y = MOUTH_YN * TOOTH_H;
export const MOUTH_Z = TOOTH_Z + (MOUTH_ZN - 0.03) * TOOTH_H;

/** Where the little "well done" star pops. */
export const STAR_Y = 1.14 * TOOTH_H;
export const STAR_Z = TOOTH_Z + 0.16 * TOOTH_H;
/** Highest point the star reaches, used by the framing solve. */
const STAR_TOP = STAR_Y + 0.18 * TOOTH_H;

/* ------------------------------------------------------------------ */
/* The turntable                                                       */
/* ------------------------------------------------------------------ */

export const TABLE_H = 0.12;
export const TABLE_RIM_TUBE = 0.05;
/** Centre pedestal the round's food stands on. */
export const PED_R = 0.34;
export const PED_H = 0.14;
/** Top of the pedestal — a food's base rests here. */
export const PED_TOP = TABLE_H + PED_H;

/** One bead per round, ringed around the turntable so the slow spin is legible. */
export const BEAD_R = 0.055;
export const BEAD_INSET = 0.17;

/** Radians per second. One revolution takes ~24 s — a drift, not a spin. */
export const TABLE_SPIN = 0.26;

/** Tallest, shortest and widest food in the deal, measured off the props. Frames the shot. */
const FOOD_TALL = 0.73;
const FOOD_SHORT = 0.2;
const FOOD_WIDE = 0.41;
/*
 * The upper-right staircase of the deal's `(radius, height)` pairs, read off `props.ts`:
 *
 *   carrot 0.41 x 0.43   candy 0.35 x 0.32   cheese 0.32 x 0.51   cake 0.28 x 0.55
 *   apple  0.25 x 0.54   cupcake 0.21 x 0.65  lollipop 0.20 x 0.62  soda 0.20 x 0.73
 *
 * Nothing wider than 0.32 is taller than 0.43, and nothing taller than 0.55 is wider than
 * 0.21. Framing a food *standing in the dish* as one 0.41 x 0.73 cylinder would reserve a
 * corner of air no prop can ever occupy, and on a phone that corner is what the camera
 * backs away from; these two are the tight envelope instead.
 */
const FOOD_MID_H = 0.55;
const FOOD_TALL_R = 0.21;

/* ------------------------------------------------------------------ */
/* The two flights                                                     */
/* ------------------------------------------------------------------ */

/*
 * Both exits are the same kind of motion — a flight time plus a gravity, from which the
 * launch velocity is *solved* so the parabola lands where it has to. They live here rather
 * than in `scene.tsx` because the shot has to reserve room for the arc: the apex of a
 * lobbed cupcake is the highest thing that ever happens in this game, higher than the
 * mascot's own crown, and framing to the props at rest is what crops it.
 *
 * The gravities are chosen so the arc clears the crown by about a third of a tooth height
 * and no more — a lob a child can follow with their eyes, not a mortar shot.
 */
export const EAT_FLIGHT = 0.42;
export const EAT_GRAVITY = 18;
export const AWAY_FLIGHT = 0.46;
export const AWAY_GRAVITY = 16;

/**
 * The top of the highest point any food reaches on a flight to `targetY`.
 *
 * A food's group origin is its *centre*, so the silhouette top is the apex plus half its
 * height. Which food peaks highest is not obvious — a tall one starts higher, a short one
 * has further to climb — so this walks the whole range rather than guessing.
 */
function flightTop(
  targetY: number,
  gravity: number,
  flight: number,
  /** True when the target is a *base* height a food's centre rides half its height above. */
  ridesFood = false
): number {
  let top = 0;
  for (let h = FOOD_SHORT; h <= FOOD_TALL + 1e-9; h += 0.05) {
    const rest = PED_TOP + h / 2;
    const aim = ridesFood ? targetY + h / 2 : targetY;
    const vy = (aim - rest + 0.5 * gravity * flight * flight) / flight;
    const apex = vy > 0 ? rest + (vy * vy) / (2 * gravity) : rest;
    const t = apex + h / 2;
    if (t > top) top = t;
  }
  return top;
}

/* ------------------------------------------------------------------ */
/* The "no thank you" dish                                             */
/* ------------------------------------------------------------------ */

/**
 * The second verb, and why it is a dish rather than a bin.
 *
 * 3D-SPEC §6.4 and PROJECT.md both describe this game the same way: a sugary food is
 * "gently waved off and arcs away with a comic tumble" / the child "waves off sugary ones".
 * Two rounds of this build shipped a lidded rubbish bin instead, which carries a different
 * message to a four-year-old (a thing you throw food *away* into) and — measured off
 * `healthy-or-not-rest.png` — read as a cookie jar: a straight-sided orange drum at
 * `#e48f42` with a fitted lid, sitting next to a `#ee974e` turntable rim and holding a
 * `#f29d57` piece of cheese. The object being judged and one of the two answers were the
 * same material family.
 *
 * So: an open dish the food tumbles onto and visibly settles in. Nothing shuts over it,
 * nothing swallows it, the child sees where their answer went, and it is on the *registered*
 * family for this game (`GAMES["healthy-or-not"].accent`, i.e. `peach`) at its `deep` tone —
 * see `props.ts::buildSet` for why the hero furniture, and not a food, is what carries the
 * registry colour.
 *
 * The profile is a real bowl, revolved: up the outside, rolled over at the rim and back
 * down the inside to a flat well floor. `props.ts::DISH_PROFILE` builds it from exactly
 * these four numbers so there is one source of truth for the landing height.
 */
export const DISH_R = 0.392;
export const DISH_H = 0.186;
/** Height of the well floor, i.e. the inside of the bowl. */
export const DISH_FLOOR_Y = 0.08;
/** Wall thickness at the rim; also sets how far the rim rolls inward. */
export const DISH_WALL = 0.056;

/**
 * The landing pad, and why it is no longer a second mesh.
 *
 * It used to be a `roundedCylinder` liner dropped into the bowl: 0.05 thick, seated so its
 * top face sat 0.012 above `DISH_FLOOR_Y` with the other 0.038 "buried". Buried is the
 * wrong word for it. `roundedCylinder`'s top bevel begins 0.02 below its top face, i.e. at
 * y = 0.072, which is **below** the bowl's floor at 0.080 — so the bowl's flat floor and
 * the liner's bevel cross each other in a circle at r = 0.2233, meeting at 23.6 degrees.
 * Two surfaces crossing at a shallow angle is a depth-buffer coin toss along the whole
 * intersection, and `healthy-or-not-rest.png` shows exactly that: a broken, stippled dark
 * ring round the liner (round 4, A4 item 4).
 *
 * Nudging one of them would have moved the z-fight, not removed it, so the pad is now part
 * of the bowl's own lathe (`props.ts::dishProfile`) — one welded mesh, no coincident
 * surfaces anywhere, and one draw call less. Its darker tone is carried on the geometry's
 * per-vertex albedo instead of on a second material, which also means `bakeCurvatureAO`
 * finally sees the concave corner at the pad's foot (A14 fix 4: the baker can only find
 * curvature *within* one mesh).
 *
 * The two numbers below are the ones the game reasons about, and both are unchanged from
 * the liner they replace, so no flight, no bounce and no rest height moved.
 */
export const DISH_PAD_R = 0.225;
/** How far the pad stands proud of the bowl floor. */
export const DISH_PAD_RISE = 0.012;
/** Where a waved-off food's *base* comes to rest: the top face of the pad. */
export const DISH_REST_Y = DISH_FLOOR_Y + DISH_PAD_RISE;

/**
 * The "bye bye" hand, and why the dish needed one.
 *
 * Round 4, HN2: "an empty terracotta saucer does not read as 'no thank you' to a
 * pre-reader". It does not — a dish is a place, not a gesture, and this game's whole second
 * answer is a gesture. PROJECT.md and §6.4 both call the beat a *wave-off*, and the shipped
 * set had nothing in it that waves.
 *
 * So a clay hand stands behind the dish and waves. It is deliberately *behind* rather than
 * *instead of*: a hand on its own was what the lidded bin replaced two rounds ago, because a
 * hand has nowhere for the food to land and a child could not see where their answer went.
 * The pair says both halves — "wave it away" and "it lands here" — and nothing closes over
 * the answer, so §6.4 is intact.
 *
 * Placed diagonally back and *inward* — `hypot(HAND_X, HAND_Z)` is 0.513 against the bowl's
 * own 0.392, so its foot is on the table outside the dish's footprint and its silhouette
 * clears the bowl's on the far side. Straight behind (the first pass) reads as a hand growing
 * out of the rim, because at a 24-degree elevation everything within 0.4 of the rim projects
 * inside it; straight behind and *outward* cost 7 % of subject size on a phone, because the
 * hand's swept right edge then became the widest point in the whole set and the side margin
 * is what binds the distance solve there. Inward, its right edge sits at `dishX + 0.19`,
 * inside the bowl's own `dishX + 0.392`, and the solve is back where it was.
 *
 * It is clear of the away-flight's ground track by 0.31 units at a phone aspect and 0.50 at
 * a laptop one, so a tumbling food never passes through it. Both stay inside one tap target:
 * see `scene.tsx`'s `TARGET_DISH_R`.
 */
/**
 * How far from the dish's centre the hand stands, and in which direction.
 *
 * The direction is **solved, not authored**, because the set re-composes with the aspect
 * (`layoutFor`) and a fixed offset that is clear of the turntable on a laptop is standing on
 * it on a phone — which the first pass did: at a 0.48 aspect the table is centred (-0.2,
 * 0.34) with a radius of 0.6, and a hand parked 0.18 inward of the dish landed 0.451 from
 * that centre, i.e. **on the rotating tray**, parented to the dish and not turning with it.
 *
 * So the offset runs along the perpendicular to the table-to-dish axis, on the side away
 * from the camera: `perp(normalize(dish - table))`. That is outward from the tray by
 * construction at every aspect (0.98 from the table's centre at a phone aspect, 1.51 at a
 * laptop one, against radii of 0.6 and 0.8), always *behind* the bowl so nothing it does can
 * cover where the food lands, and never wider than the bowl's own silhouette, so it never
 * becomes the point the distance solve backs away from. Placing it outward instead cost 7 %
 * of subject size on a phone, measured.
 *
 * `HAND_OUT` is 0.5 against the bowl's 0.392, so the hand's foot is on the table outside the
 * dish's footprint.
 */
export const HAND_OUT = 0.5;
/**
 * The wrist's own footprint, for the "is the hand standing on the turntable" test.
 *
 * The outline's wrist is 0.038 either side of centre before `HAND_SCALE`, i.e. 0.057 after,
 * plus a 0.033 bevel: 0.09, rounded up.
 */
const HAND_FOOT_R = 0.1;
/** How far the wrist's foot sits above the ground, so the sign seats rather than sinks. */
export const HAND_LIFT = 0.012;

/** Overall height of the built prop, checked against the geometry in `props.ts`. */
export const HAND_HEIGHT = 0.65;
/**
 * Half-width **including the wave**, because the camera has to reserve for the motion and
 * not for the pose — the same rule that puts each flight's apex in `fitPoints` below.
 *
 * The hand pivots at its foot, so a swing of `HAND_WAVE_MAX` takes its widest point out to
 * `halfWidth * cos(w) + height * sin(w)` = `0.217 * 0.9693 + 0.606 * 0.2459` = **0.359**. At
 * rest it is 0.217; reserving the rest pose is how a prop gets clipped exactly when it moves,
 * which is the one moment a child is looking at it. `props.ts` checks the built geometry
 * against this, swing included.
 */
export const HAND_HALF_W = 0.37;
/**
 * Radians the hand swings through, either side of upright, and the largest angle it ever
 * reaches: `scene.tsx`'s idle amplitude plus the peak of its sprung one-shot.
 * `Spring(0, 300, 11)` given `impulse(3.4)` peaks at **0.123** of unit amplitude —
 * analytically `(3.4 / w_d) e^{-zeta w_n t} sin(w_d t)` at `w_d t = atan(w_d / (zeta w_n))`,
 * which is 0.129, and 0.123 when the integrator is stepped at 60 Hz as it actually is. The
 * two together are bounded by `HAND_WAVE * 1.129`, i.e. 14.2 degrees.
 *
 * It lives here rather than in `scene.tsx` because the camera has to reserve for it.
 */
export const HAND_WAVE = 0.22;
export const HAND_WAVE_MAX = HAND_WAVE * 1.129;

/* ------------------------------------------------------------------ */
/* Composition                                                         */
/* ------------------------------------------------------------------ */

export type SceneLayout = {
  tableX: number;
  tableZ: number;
  tableR: number;
  dishX: number;
  dishZ: number;
  /** The waving hand, solved from the other two. See `HAND_OUT`. */
  handX: number;
  handZ: number;
  /** Solved bounds of the whole set, used by the camera and the shadow frustum. */
  centerX: number;
  centerZ: number;
  halfWidth: number;
  halfDepth: number;
  spanY: number;
};

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const mix = (a: number, b: number, t: number) => a + (b - a) * t;

/** Highest point anything reaches, including a food at the top of its arc. */
const EAT_TOP = flightTop(MOUTH_Y, EAT_GRAVITY, EAT_FLIGHT);
const AWAY_TOP = flightTop(DISH_REST_Y, AWAY_GRAVITY, AWAY_FLIGHT, true);
const SPAN_Y = Math.max(STAR_TOP, EAT_TOP, AWAY_TOP);

/**
 * The set, fitted to the play area's aspect.
 *
 * `t = 0` is a phone held upright (aspect ≈ 0.48): the turntable comes back towards the
 * centre, the table shrinks, and the dish swings round to the near-right corner where the
 * frame is tall and empty. `t = 1` is a laptop (aspect ≈ 1.03): the set opens out sideways
 * into a triangle — food low-left, mascot high-centre, dish low-right.
 */
export function layoutFor(aspect: number): SceneLayout {
  const t = clamp01((aspect - 0.55) / 0.5);

  const tableX = mix(-0.2, -0.64, t);
  const tableZ = mix(0.34, 0.5, t);
  // Quantised to three values, and *only* three: the turntable slab and its rim are
  // geometry, `geometry.ts` caches by argument, and a continuously varying radius would
  // mint a new mesh on every pixel of a window drag and never free one. Rounding to 0.1
  // over a 0.62–0.80 range can only ever produce 0.6, 0.7 or 0.8.
  const tableR = Math.round(mix(0.62, 0.8, t) * 10) / 10;
  // The narrow-end pair is not the bin's `(0.5, 1.0)`, and the reason is arithmetic rather
  // than taste. The dish is 0.392 in radius against the bin's 0.3, and at a phone aspect
  // this corner is both the nearest thing to the camera and the outermost, so its front and
  // outer edges are exactly what the distance solve backs away from. `0.42 + 0.392 = 0.812`
  // and `0.92 + 0.392 = 1.312` put those two edges within a hundredth of where the bin's
  // `0.8` and `1.3` were, which is what keeps the phone shot the size it already was: the
  // solve lands at 7.842 units against the shipped build's 7.844 at 360x733, and 6.914
  // against 6.869 at 390x600. Left alone at `(0.5, 1.0)` the same swap cost 5 % of subject
  // size on a phone, which on a game whose failure mode is legibility is not free.
  const dishX = mix(0.42, 0.78, t);
  const dishZ = mix(0.92, 0.34, t);

  /*
   * The hand, solved in three steps rather than authored, because a fixed offset that clears
   * the turntable on a laptop stands on it on a phone (see `HAND_OUT`).
   *
   *  1. Aim along the perpendicular to the table-to-dish axis, on the far side: `(uz, -ux)`
   *     is the clockwise perpendicular, and it is behind the bowl for every composition this
   *     function produces.
   *  2. Cap `x` at the bowl's own right edge less the hand's swept half-width, so the hand
   *     can never become the outermost point of the set. Measured, letting it stick out cost
   *     12.6 % of subject size at a 0.48 aspect: the side margin is what binds the distance
   *     solve there, and a prop 0.32 wider than the dish moved that bound.
   *  3. Push `z` back until the foot is off the turntable *and* at least `HAND_OUT` from the
   *     dish's centre. Both are circles, so both are one `sqrt`.
   */
  const dx = dishX - tableX;
  const dz = dishZ - tableZ;
  const dLen = Math.hypot(dx, dz) || 1;
  const handX = Math.min(dishX + (dz / dLen) * HAND_OUT, dishX + DISH_R - HAND_HALF_W);
  const offX = handX - dishX;
  const clearDish = dishZ - Math.sqrt(Math.max(0, HAND_OUT * HAND_OUT - offX * offX));
  const trayR = tableR + HAND_FOOT_R;
  const overTray = trayR * trayR - (handX - tableX) * (handX - tableX);
  const clearTray = overTray > 0 ? tableZ - Math.sqrt(overTray) : clearDish;
  const handZ = Math.min(clearDish, clearTray);

  const minX = Math.min(tableX - tableR, TOOTH_X - TOOTH_HALF_W, dishX - DISH_R, handX - HAND_HALF_W);
  const maxX = Math.max(
    tableX + tableR,
    TOOTH_X + TOOTH_HALF_W,
    dishX + DISH_R,
    handX + HAND_HALF_W
  );
  const minZ = Math.min(
    TOOTH_Z - TOOTH_HALF_D,
    tableZ - tableR,
    dishZ - DISH_R,
    handZ - HAND_HALF_W
  );
  const maxZ = Math.max(tableZ + tableR, dishZ + DISH_R);

  return {
    tableX,
    tableZ,
    tableR,
    dishX,
    dishZ,
    handX,
    handZ,
    centerX: (minX + maxX) / 2,
    centerZ: (minZ + maxZ) / 2,
    halfWidth: (maxX - minX) / 2,
    halfDepth: (maxZ - minZ) / 2,
    spanY: SPAN_Y,
  };
}

/* ------------------------------------------------------------------ */
/* Camera                                                              */
/* ------------------------------------------------------------------ */

const FOV = 28;
const TAN_HALF_FOV = Math.tan((FOV * Math.PI) / 360);
/**
 * 24 degrees. Shallower than a board game's plan view on purpose: the mascot has a face,
 * and a face read from above is a face you cannot read. Low enough to see the tooth smile,
 * high enough that the turntable is still a disc rather than an edge.
 */
const ELEVATION = (24 * Math.PI) / 180;
const SIN_E = Math.sin(ELEVATION);
const COS_E = Math.cos(ELEVATION);
/**
 * Fallback height of `GameShell`'s title + HUD band, in CSS pixels.
 *
 * Only a fallback. `GameShell` publishes the *measured* band on the play area as
 * `--chrome-h`, and `HealthyOrNot.tsx` reads it and passes it in — the band is not a
 * constant, it shrinks when a game has no HUD row and it grows when the title wraps on a
 * narrow phone, and this number reserving more than the band really needs is the single
 * largest consumer of frame height in the shot (at 670 px tall it costs 20 % of the frame).
 * The constant survives for the case where nothing has measured yet, i.e. the first render.
 */
export const DEFAULT_CHROME_PX = 138;
const MIN_DISTANCE = 3.6;
const MAX_DISTANCE = 13;
/** Frame margin, in NDC. 0.06 keeps a hand's-width of table between prop and view edge. */
const EDGE_MARGIN = 0.06;

/**
 * The chrome's *occupied* box, in play-area CSS pixels, as `GameShell` publishes it
 * (`--chrome-left/-top/-right/-bottom`; round 4, A9).
 *
 * A scalar band was wrong in both directions: it forbade the whole strip beside a short
 * title, and it could not say "the timer chip is at the right-hand end of an otherwise
 * empty row". This is the union of the four real control clusters, and the contract A9
 * states is that a game treats it as a **keep-clear region** — a floor on the subject's
 * screen-space top *within the rect's horizontal span* — exactly the way §2 already makes
 * the celebration treat `CELEBRATION_COPY_BAND`.
 *
 * Worth being honest about the size of the prize here: at 390x844 this game's rect runs
 * x 24..334 of 358, i.e. 87 % of the width, and at 1440x900 it runs 24..802 of 826, i.e.
 * 94 %. The chrome very nearly spans the frame in both, so the horizontal scoping buys a
 * few pixels at each edge and no more. What it *does* buy — and what fixed the shipped
 * phone frame — is `bottom` rather than `--chrome-h`: `bottom` is the last pixel of the
 * lowest control, where `--chrome-h` is that plus the row's 16 px bottom padding.
 */
export type ChromeRect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

/** `--chrome-h` as a rect: the whole band, full width. The conservative fallback. */
export const chromeBandRect = (width: number, band: number): ChromeRect => ({
  left: 0,
  top: 0,
  right: width,
  bottom: band,
});

export type CameraFraming = {
  position: [number, number, number];
  target: [number, number, number];
  fov: number;
};

/**
 * The points the shot is composed around.
 *
 * Deliberately *not* the set's bounding box. Fitting a box means fitting eight corners the
 * scene never occupies — the top corners of this set are two units of empty air over the
 * turntable — and the camera then backs off until the props are small and the table is
 * cropped at the bottom anyway. These are the silhouettes that actually exist: the crown,
 * the tallest food standing on the pedestal, the turntable's rim at both its heights, the
 * dish, and the top of the star. Written into a flat `xyz` array so the solve below can walk
 * it without allocating per candidate.
 */
function fitPoints(layout: SceneLayout): Float64Array {
  const RING = 12;
  /*
   * Capacity, and the reason it is spelled out.
   *
   * A `Float64Array` **silently discards** an out-of-range write, so an undersized buffer
   * here does not throw and does not corrupt anything — it just quietly stops recording
   * silhouette points, and the solve then frames a set that is missing its last few props.
   * That is exactly what happened: the buffer was sized for five rings when the body below
   * writes nine, so the away-flight apex and the dish's rings never reached
   * `measure()` at all, and the dish — one of the three tap targets — projected to
   * |x| = 1.09 in NDC at a 0.65 aspect, i.e. cropped by the frame edge on a phone.
   *
   * So `push` grows the buffer instead of dropping the write. A ninth ring added later
   * costs one extra allocation on a resize and frames correctly; it cannot silently
   * disappear from the shot. `RINGS` stays as the size that makes the growth path dead
   * code, and a DEV-only assertion at the bottom says so out loud if it stops being true.
   */
  const RINGS = 10;
  const POINTS = 3;
  let out = new Float64Array((RING * RINGS + POINTS) * 3);
  let i = 0;
  const push = (x: number, y: number, z: number): void => {
    if (i + 3 > out.length) {
      const grown = new Float64Array(out.length * 2);
      grown.set(out);
      out = grown;
    }
    out[i++] = x;
    out[i++] = y;
    out[i++] = z;
  };
  /*
   * A 12-gon sampled *on* a circle is inscribed in it, so its widest vertex sits
   * `cos(π/12)` of the way out and the fit misses the real silhouette by 3.5 % of every
   * radius — which measured as the turntable rim breaching the frame edge by 0.015 NDC
   * (about 8 px at 1020 wide) at square-ish aspects. Scaling the sample radius by
   * `1 / cos(π/RING)` circumscribes the circle instead: every point of the real disc is
   * then inside the sampled polygon, exactly, at no extra cost and with no extra points.
   */
  const CIRCUMSCRIBE = 1 / Math.cos(Math.PI / RING);
  const ring = (cx: number, cz: number, r: number, y: number): void => {
    const rr = r * CIRCUMSCRIBE;
    for (let k = 0; k < RING; k++) {
      const a = ((k / RING) * Math.PI * 2) as number;
      push(cx + Math.cos(a) * rr, y, cz + Math.sin(a) * rr);
    }
  };

  const crownY = CROWN_YN * TOOTH_H;
  const crownR = CROWN_RN * TOOTH_H;
  ring(TOOTH_X, TOOTH_Z, crownR, crownY);
  push(TOOTH_X, crownY + crownR, TOOTH_Z);
  push(TOOTH_X, 0, TOOTH_Z);
  push(TOOTH_X, STAR_TOP, TOOTH_Z);

  // The turntable's *visible* radius, not its slab radius: the rolled rim is a torus whose
  // outer edge stands `TABLE_RIM_TUBE` proud of the slab, and fitting the slab alone let
  // that rim eat the whole edge margin and clip by a pixel at a 0.56 aspect.
  const tableOuter = layout.tableR + TABLE_RIM_TUBE;
  ring(layout.tableX, layout.tableZ, tableOuter, 0);
  ring(layout.tableX, layout.tableZ, tableOuter, TABLE_H);
  ring(layout.tableX, layout.tableZ, FOOD_WIDE, PED_TOP + FOOD_TALL);
  // Each flight's apex, over the midpoint of its own trajectory. Reserving room for these
  // is the difference between "the cupcake sails into the mouth" and "the cupcake leaves
  // the top of the screen and comes back".
  ring((layout.tableX + MOUTH_X) / 2, (layout.tableZ + MOUTH_Z) / 2, FOOD_WIDE, EAT_TOP);
  ring((layout.tableX + layout.dishX) / 2, (layout.tableZ + layout.dishZ) / 2, FOOD_WIDE, AWAY_TOP);

  ring(layout.dishX, layout.dishZ, DISH_R, 0);
  // The waving hand standing behind the dish. It is the tallest thing on that side of the
  // set, so leaving it out of the fit is how it would get cropped — which is exactly what
  // happened to the dish itself when this buffer was one ring short (see `push`).
  ring(layout.handX, layout.handZ, HAND_HALF_W, HAND_LIFT + HAND_HEIGHT);
  // The dish is open, so what has to stay in frame above it is a food standing *in* it —
  // not a lid arc. The tallest of those reaches 0.822 against the lidded bin's swept lid at
  // 1.05, which is the frame height this game gets back for dropping the lid.
  ring(layout.dishX, layout.dishZ, Math.max(DISH_R, FOOD_WIDE), DISH_REST_Y + FOOD_MID_H);
  ring(layout.dishX, layout.dishZ, FOOD_TALL_R, DISH_REST_Y + FOOD_TALL);

  // The guard the missing ring slipped past. Dev only — a mis-sized buffer is now a
  // correctness non-event (see `push`), so this is a tidiness warning, never a crash in
  // front of a child.
  if (import.meta.env.DEV && i !== (RING * RINGS + POINTS) * 3) {
    console.warn(
      `[healthy-or-not] fitPoints wrote ${i / 3} points but RINGS/POINTS predict ` +
        `${RING * RINGS + POINTS}; update them so the buffer stays exact.`
    );
  }

  return i === out.length ? out : (out.subarray(0, i) as Float64Array);
}

/**
 * Worst-case NDC extents of `pts` for a camera `r` back and aimed at `(tx, ty, tz)`.
 * Returns `false` through `OUT` when any point falls behind the near plane.
 *
 * `over` is the amount by which the worst point breaches its own ceiling, where the ceiling
 * is the keep-clear rect's bottom for a point inside the rect's horizontal span and the
 * plain frame margin for a point outside it. One scalar rather than a `maxY`, because with
 * a per-point ceiling there is no single "top" to compare against.
 */
const OUT = { maxAbsX: 0, over: 0, minY: 0, ok: false };

/** NDC ceilings the keep-clear rect implies. Filled once per `cameraFor`, read per point. */
const CEIL = { band: 1 - EDGE_MARGIN, free: 1 - EDGE_MARGIN, left: -1, right: 1 };

function measure(
  pts: Float64Array,
  r: number,
  tx: number,
  ty: number,
  tz: number,
  aspect: number
): void {
  let maxAbsX = 0;
  let over = -Infinity;
  let minY = Infinity;
  for (let i = 0; i < pts.length; i += 3) {
    const dx = pts[i] - tx;
    const dy = pts[i + 1] - ty;
    const dz = pts[i + 2] - tz;
    // Camera sits at target + r·(0, sinE, cosE) and looks back down that vector, so the
    // r terms cancel out of the up coordinate and survive only in the depth.
    const depth = r - (dy * SIN_E + dz * COS_E);
    if (depth < 0.25) {
      OUT.ok = false;
      return;
    }
    const nx = dx / (depth * TAN_HALF_FOV * aspect);
    const ny = (dy * COS_E - dz * SIN_E) / (depth * TAN_HALF_FOV);
    const ax = nx < 0 ? -nx : nx;
    if (ax > maxAbsX) maxAbsX = ax;
    // The keep-clear rule, per point: a prop may rise into the strip of band that has no
    // control in it, and may not rise into the strip that has.
    const ceiling = nx >= CEIL.left && nx <= CEIL.right ? CEIL.band : CEIL.free;
    const breach = ny - ceiling;
    if (breach > over) over = breach;
    if (ny < minY) minY = ny;
  }
  OUT.maxAbsX = maxAbsX;
  OUT.over = over;
  OUT.minY = minY;
  OUT.ok = true;
}

/**
 * The aim height that leaves equal air above and below the set.
 *
 * Solved rather than approximated because perspective is not symmetric here: the near edge
 * of the turntable is a unit closer to the camera than the mascot's crown, so it projects
 * larger, and a closed-form "centre of the bounding box" aim drops it off the bottom of the
 * frame — which is exactly what the shipped shot did.
 */
function aimHeight(pts: Float64Array, r: number, tx: number, tz: number, aspect: number): number {
  let lo = -3;
  let hi = SPAN_Y + 6;
  for (let k = 0; k < 22; k++) {
    const m = (lo + hi) / 2;
    measure(pts, r, tx, m, tz, aspect);
    // Raising the aim pushes the set down the frame, so slack-above minus slack-below is
    // monotonic in `m` and a bisection converges without any derivative. `-OUT.over` is
    // that slack above: the smallest gap between any point and the ceiling it answers to.
    if (!OUT.ok || -OUT.over - (OUT.minY + 1 - EDGE_MARGIN) > 0) hi = m;
    else lo = m;
  }
  return (lo + hi) / 2;
}

/**
 * Solves the camera from the measured play-area rect.
 *
 * Both the distance and the aim are solved, and both against the real silhouette: the
 * smallest distance at which every point in `fitPoints` clears the frame edge by
 * `EDGE_MARGIN` and clears the chrome band at the top. Nothing is ever cropped — and a
 * cropped prop here is not a look problem, it is a prop the child cannot reach.
 */
export function cameraFor(
  width: number,
  height: number,
  chrome: number | ChromeRect = DEFAULT_CHROME_PX
): CameraFraming {
  const aspect = width > 0 && height > 0 ? width / height : 1;
  const layout = layoutFor(aspect);
  setKeepClear(width, height, chrome);
  const pts = fitPoints(layout);
  const tx = layout.centerX;
  const tz = layout.centerZ;

  let lo = 0.5;
  let hi = MAX_DISTANCE;
  for (let k = 0; k < 26; k++) {
    const mid = (lo + hi) / 2;
    const ty = aimHeight(pts, mid, tx, tz, aspect);
    measure(pts, mid, tx, ty, tz, aspect);
    const fits =
      OUT.ok && OUT.maxAbsX <= 1 - EDGE_MARGIN && OUT.over <= 0 && OUT.minY >= -1 + EDGE_MARGIN;
    if (fits) hi = mid;
    else lo = mid;
  }

  const r = hi < MIN_DISTANCE ? MIN_DISTANCE : hi > MAX_DISTANCE ? MAX_DISTANCE : hi;
  const ty = aimHeight(pts, r, tx, tz, aspect);

  return {
    position: [tx, ty + r * SIN_E, tz + r * COS_E],
    target: [tx, ty, tz],
    fov: FOV,
  };
}

/**
 * Turns the published chrome rect into the three NDC numbers `measure` reads.
 *
 * **The 0.34 clamp that used to live here is gone, and it was the bug.** The line read
 * `Math.min(0.34, band / height)`, so a band taller than a third of the play area was
 * silently under-reserved. At 390x844 this game's band measures 292 px of a 748 px area —
 * 0.390 — and the clamp handed the solve 0.340, i.e. it gave the scene back 38 px of frame
 * that the chip row is standing in. That is how `0:00` and `* 0` came to be drawn on the
 * mascot's forehead (round 4, HN1).
 *
 * What replaces it is not another fraction. The reserve is now whatever the rect says, and
 * the only floor is that a frame must keep *some* room to compose in: `MIN_USABLE_NDC`
 * (0.30 of the frame's height) below the band. If that floor ever bites, the shot is
 * genuinely impossible at that size and DEV says so out loud rather than quietly cropping.
 */
const MIN_USABLE_NDC = 0.6;

function setKeepClear(width: number, height: number, chrome: number | ChromeRect): void {
  const free = 1 - EDGE_MARGIN;
  CEIL.free = free;
  if (width <= 0 || height <= 0) {
    // Nothing measured yet. Reserve the fallback band across the whole width, which is the
    // conservative answer; `HealthyOrNot.tsx` retries until a real rect exists.
    CEIL.band = 1 - (2 * DEFAULT_CHROME_PX) / 748 - EDGE_MARGIN;
    CEIL.left = -1;
    CEIL.right = 1;
    return;
  }
  const rect =
    typeof chrome === "number"
      ? chromeBandRect(width, chrome > 0 ? chrome : DEFAULT_CHROME_PX)
      : chrome;
  const bottom = 1 - (2 * rect.bottom) / height - EDGE_MARGIN;
  const floor = -1 + EDGE_MARGIN + MIN_USABLE_NDC;
  if (import.meta.env.DEV && bottom < floor) {
    console.warn(
      `[healthy-or-not] the chrome band is ${rect.bottom.toFixed(0)}px of a ${height.toFixed(0)}px ` +
        "play area; the shot has no room left under it and is being framed against a floor."
    );
  }
  CEIL.band = bottom < floor ? floor : bottom;
  CEIL.left = (2 * rect.left) / width - 1;
  CEIL.right = (2 * rect.right) / width - 1;
}

/**
 * What the solve actually achieved, re-measured against the camera it returns.
 *
 * The solve's inner bisection assumes the aim moves every point monotonically down the
 * frame, which is true vertically and only *nearly* true horizontally — raising the aim
 * pushes points away from the camera, which shrinks `|x|` and can walk a prop into the
 * keep-clear span it had been beside. So the aim is solved approximately and the result is
 * checked exactly, here, rather than asserted. HN1 asked for precisely this: the solved
 * silhouette-fit result reported, so a crop can be attributed to the solve or to the
 * harness.
 *
 * Returns the worst breach of each of the four constraints; every number <= 0 means nothing
 * is cropped and nothing is under a control.
 */
export type FramingReport = {
  distance: number;
  aspect: number;
  /** Silhouette points measured. */
  points: number;
  /** NDC overshoot past the side margins; <= 0 is in frame. */
  sideBreach: number;
  /** NDC overshoot past the bottom margin; <= 0 is in frame. */
  bottomBreach: number;
  /** NDC overshoot into the chrome's keep-clear rect; <= 0 is clear of the controls. */
  chromeBreach: number;
  /** The keep-clear ceiling in NDC, and the span it applies over. */
  keepClear: { band: number; left: number; right: number };
};

export function framingReport(
  width: number,
  height: number,
  chrome: number | ChromeRect = DEFAULT_CHROME_PX
): FramingReport {
  const aspect = width > 0 && height > 0 ? width / height : 1;
  const layout = layoutFor(aspect);
  const camera = cameraFor(width, height, chrome);
  // `cameraFor` left `CEIL` set for this call; re-measure against the camera it returned.
  const pts = fitPoints(layout);
  const r = Math.hypot(
    camera.position[0] - camera.target[0],
    camera.position[1] - camera.target[1],
    camera.position[2] - camera.target[2]
  );
  measure(pts, r, camera.target[0], camera.target[1], camera.target[2], aspect);
  return {
    distance: r,
    aspect,
    points: pts.length / 3,
    sideBreach: OUT.ok ? OUT.maxAbsX - (1 - EDGE_MARGIN) : Number.POSITIVE_INFINITY,
    bottomBreach: OUT.ok ? -1 + EDGE_MARGIN - OUT.minY : Number.POSITIVE_INFINITY,
    chromeBreach: OUT.ok ? OUT.over : Number.POSITIVE_INFINITY,
    keepClear: { band: CEIL.band, left: CEIL.left, right: CEIL.right },
  };
}

/** Shadow frustum: bound the set, not the world (3D-FOUNDATION-NOTES §8). */
export function shadowAreaFor(layout: SceneLayout): number {
  return Math.max(layout.halfWidth, layout.halfDepth) * 2 + 0.9;
}
