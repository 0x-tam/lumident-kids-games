/**
 * Smile Maker — the numbers.
 *
 * Pure arithmetic: importing this pulls in no three and no React, so the shell can solve
 * the camera before a single geometry exists.
 *
 * Scale note (3D-SPEC §2): 1 world unit = 10 cm. The hero tooth is 15 cm tall and stands on
 * a 12 cm podium in the middle of a **round** clay turntable 32 cm across.
 */

/* ------------------------------------------------------------------ */
/* The booth                                                           */
/* ------------------------------------------------------------------ */

export const PODIUM_R = 0.62;
export const PODIUM_H = 0.15;

/** `toothGeometry` is normalised to 1.0 tall with its origin at the base of the roots. */
export const TOOTH_SCALE = 1.5;
export const TOOTH_BASE_Y = PODIUM_H;
export const TOOTH_TOP_Y = TOOTH_BASE_Y + TOOTH_SCALE;

/**
 * The turntable.
 *
 * **It is a circle.** It used to be a circle stretched 1.9x along the view axis so that it
 * projected to a near-circle at one specific camera elevation — which bought slot spacing at
 * the design shot and cost the object its identity everywhere else. The game's second
 * interaction is *turning the booth around*: round 2 measured the "round" turntable as a
 * visibly elongated oval at the bottom of the orbit range, with front-to-side prop spacing
 * that changed as the child dragged. A prop that changes shape when you turn it is not a
 * physical object, and no amount of tap-target arithmetic is worth that.
 *
 * The spacing the stretch used to buy is now bought honestly, from three things that cost
 * nothing:
 *   • a slot arc widened from 120 to 142 degrees each side of front, so the row wraps
 *     further around the back where there is spare picture;
 *   • which slot each accessory stands in (`SLOT_OF`);
 *   • and a blend of projected-arc and angular spacing (`SLOT_BLEND`) rather than pure
 *     projected arc, which buys rail room at the front for no loss on screen.
 *
 * Measured against the real `cameraFor` solve below, the tightest gap between neighbouring
 * prop centres is **69 px** on an 822x670 laptop rect, **44 px** on a 360x760 phone and
 * **102 px** on an 820x900 tablet — against 48 px tap targets, so nothing overlaps and
 * nothing is under the floor. (A 700x340 landscape phone remains the one shape this cannot
 * save: the camera clamps out at 16 units and the gaps fall to 21 px. Tab and the arrow-key
 * roving group still reach every prop there.)
 *
 * Losing the stretch also collapsed the booth's depth from 6.0 units to 3.0, which is most
 * of why the camera can now sit 8.9 units away instead of 12.8, and why the hero tooth
 * measures 209 CSS px on the capture rect instead of the 157 round 2 measured — see
 * `cameraFor`.
 */
/** Centre-line of the rail, where the ten slots sit. */
export const RING_R = 1.28;
/**
 * Inner and outer rim. The rail's top is `RING_TOP` = 0.22, and nothing the tooth can wear
 * comes below y = 0.30 at all — measured, the dressed silhouette is the podium's 0.62 up to
 * there and the cape's hem starts at 0.35 — so 1.07 clears everything worn by the whole
 * height of the rail rather than by a horizontal margin.
 */
export const RING_INNER = 1.07;
export const RING_OUTER = 1.49;
export const RING_TOP = 0.22;

export const SLOT_COUNT = 10;
/** Half the arc the slots span, measured from straight-ahead (+Z). */
export const SLOT_ARC = (142 * Math.PI) / 180;
/**
 * How much of the slot spacing is equalised in the *picture* rather than in the *world*.
 *
 * Pure projected-arc spacing (1) puts the ten props at exactly equal pixel intervals, which
 * is what the 48 px floor asks for — but because the front of a round turntable is closest
 * to the lens, equal pixels there means the least world room, and the front props end up
 * shoulder to shoulder while the side ones have 1.07 units of empty rail between them. Pure
 * angular spacing (0) is the opposite: 0.72 units everywhere and a 47 px gap at the sides.
 *
 * 0.9 is where both constraints are met: 69 px minimum on screen (against 48) on the design
 * rect and 44 px on a 360x760 phone, with more rail room at the front than pure projection
 * leaves —
 * which is what lets the small props be displayed a third larger without climbing over their
 * neighbours.
 */
const SLOT_BLEND = 0.9;
/**
 * Props are authored at their worn size; on the shelf they are display models.
 *
 * 0.62 -> 0.72. Round 2 measured five of the ten accessories drawing under 48 px on their
 * short axis, and a four-year-old aims at what they can see, not at the invisible collider
 * `HitTarget` inflates for them. Two thirds of that shortfall is recovered by the reframing
 * below; this closes most of the rest without letting the widest props (hat brim, cape)
 * touch their neighbours: at 0.72 the widest neighbouring pair clears by 1.4 cm.
 */
export const SHELF_SCALE = 0.72;
/** How much of its slot angle a shelf prop turns through, so the row fans toward the front. */
export const SLOT_FAN = 0.55;

/**
 * Resting camera elevation.
 *
 * Declared here because the slot spacing is solved against it. 24 -> 22 degrees: with a
 * round turntable the vertical extent of the booth is now dominated by the front rim, and
 * every degree of elevation spends picture height on bare table. 22 degrees is still a
 * clearly three-quarter view of the shelf tops, and the pads still read as pads.
 */
export const ELEVATION = (22 * Math.PI) / 180;

/**
 * Slot angles, solved once at module load so ten props land at equal spacing in the
 * *picture* rather than at equal spacing in angle.
 *
 * The ring projects (orthographically, which is close enough at a 28-degree lens) to an
 * ellipse with semi-axes `RING_R` and `RING_R * sin(ELEVATION)`. Walking that ellipse by
 * cumulative arc length and sampling ten equally spaced stations gives the angles below.
 * Trapezoid over 720 steps: the residual spacing error is under 0.1%.
 */
const SLOT_ANGLES: Float64Array = (() => {
  const a = RING_R;
  const b = RING_R * Math.sin(ELEVATION);
  const steps = 720;
  const theta = new Float64Array(steps + 1);
  const arc = new Float64Array(steps + 1);
  for (let i = 0; i <= steps; i++) theta[i] = -SLOT_ARC + (i / steps) * 2 * SLOT_ARC;
  for (let i = 1; i <= steps; i++) {
    const m0 = Math.hypot(a * Math.cos(theta[i - 1]), b * Math.sin(theta[i - 1]));
    const m1 = Math.hypot(a * Math.cos(theta[i]), b * Math.sin(theta[i]));
    arc[i] = arc[i - 1] + ((m0 + m1) * 0.5) * (theta[i] - theta[i - 1]);
  }
  const total = arc[steps];
  const out = new Float64Array(SLOT_COUNT);
  let j = 0;
  for (let k = 0; k < SLOT_COUNT; k++) {
    const want = SLOT_COUNT <= 1 ? 0 : (k / (SLOT_COUNT - 1)) * total;
    while (j < steps && arc[j + 1] < want) j++;
    const span = arc[j + 1] - arc[j];
    const t = span > 1e-9 ? (want - arc[j]) / span : 0;
    const projected = theta[j] + (theta[j + 1] - theta[j]) * t;
    const even = -SLOT_ARC + (k / (SLOT_COUNT - 1)) * 2 * SLOT_ARC;
    out[k] = projected * SLOT_BLEND + even * (1 - SLOT_BLEND);
  }
  return out;
})();

export const slotAngle = (i: number): number => SLOT_ANGLES[i] ?? 0;

export const slotX = (i: number): number => Math.sin(slotAngle(i)) * RING_R;
export const slotZ = (i: number): number => Math.cos(slotAngle(i)) * RING_R;
export const slotY = RING_TOP;

/**
 * Which slot each accessory stands in — `SLOT_OF[accessoryIndex] = slotIndex`.
 *
 * The ten accessories, their order and their names are PROJECT.md's and are untouched; this
 * only decides where on the turntable each one is displayed.
 *
 * It decides two things a blanket "slot i holds accessory i" got wrong.
 *
 * **Pixels.** A round turntable puts the front slots 0.7 units closer to the lens than the
 * end slots — a 26 % difference in pixels per world unit at the design framing. Round 2
 * measured five accessories drawing under 48 px on their short axis, so the four whose
 * silhouette is roughly square, and therefore smallest (flower, moustache, glasses, bow
 * tie), now take the four nearest slots.
 *
 * **Frame width.** The slots nearest +/-90 degrees are the ones that set how wide the booth
 * is, and on a phone held upright width is what the camera solve binds on. The two widest
 * props (cape 1.30 across, sun hat 1.20) therefore stand at the *end* slots, which sit well
 * inside the ring's own half-width. Between them those two swaps are worth about 10 px of
 * tooth on a 360-wide phone and 8-10 px on exactly the props that were short, and they cost
 * nothing at all.
 *
 * Keyboard order follows the *ring*, left to right, not this array — see `focusOrder` in
 * `scene.tsx`, which is the slot index. Arrow keys therefore walk the row a child can see.
 *
 *   glasses -> 3 · sunglasses -> 7 · hat -> 9 · party hat -> 1 · crown -> 2
 *   moustache -> 5 · bow tie -> 6 · flower -> 4 · cape -> 0 · balloon -> 8
 */
export const SLOT_OF: readonly number[] = [3, 7, 9, 1, 2, 5, 6, 4, 0, 8];

/**
 * `[radius, height]` of each accessory **as it stands on the shelf**, in the same order as
 * `ACCESSORIES` — the prop's own bounds with its `shelfPitch` applied, before `shelfScale`.
 *
 * The camera has to be solved before a single geometry exists — that is why this module
 * imports no three — so the framing needs to know how big the props are without being able
 * to measure them. This is that table: a conservative envelope, radius in the XZ plane and
 * height above the prop's own lowest point.
 *
 * It is the one number in this game that is duplicated knowledge, so `buildSmileScene()`
 * checks every entry against the assembled bounding boxes and logs a loud console error in
 * dev if a recipe outgrows its envelope. Framing drift is a silent bug otherwise.
 */
export const PROP_ENVELOPE: readonly (readonly [number, number])[] = [
  [0.37, 0.34], // glasses
  [0.4, 0.32], // sunglasses
  [0.6, 0.42], // sun hat — narrower and shallower since SM10 lifted its seat
  [0.52, 0.79], // party hat — narrower and taller since SM6 made it a real cone
  [0.66, 0.44], // crown — narrower since SM9 tapered its band
  [0.38, 0.25], // moustache
  [0.43, 0.46], // bow tie
  [0.20, 0.38], // flower
  [0.94, 1.08], // cape (stood up on the shelf — see build.ts::shelfPitch)
  [0.28, 1.07], // balloon
];
/**
 * How much larger than life each accessory is *displayed on the shelf*, on top of
 * `SHELF_SCALE`. Worn, every prop is always at scale 1.
 *
 * This exists because two of the round-2 findings pull in opposite directions and the
 * geometry does not allow both to be answered the same way.
 *
 * G-SM-6 asks for nothing under 48 CSS px on its short axis. But the props that were
 * smallest — glasses, sunglasses, moustache — are worn on a **face**, and the face is the
 * one part of this game whose size is not negotiable: the crown of the tooth is 0.64 world
 * units tall, the eye anchor and the mouth anchor are 0.29 apart, and a 0.39-tall pair of
 * glasses plus a 0.40-tall moustache is 0.79 units of accessory on 0.64 units of face. They
 * would intersect each other and push up through the brim of a hat. Modelling them big
 * enough to read on the shelf and modelling them to fit the face are different numbers.
 *
 * So the shelf is what it always was — a stand holding display models — and the display
 * models are shown at the size a four-year-old can aim at. The prop shrinks to its true size
 * as it lands, which is a legible transition rather than a cost: it reads as the accessory
 * fitting itself to the tooth.
 *
 * The ceiling on each entry is its neighbours: see `SLOT_BLEND` for the rail room this is
 * spending.
 *
 * **Re-measured in round 3, and four entries came down.** The previous numbers in this
 * comment ("glasses 51, sunglasses 48, hat 48 … flower 56") were not reproducible: projecting
 * the *real assembled geometry* of each prop, at its own slot and shelf scale, through the
 * solved camera on the same 822x670 rect gives glasses 69, sunglasses 87, hat 81, party 89,
 * crown 98, moustache 51, bow tie 69, flower 41, cape 63, balloon 56 on the short axis. The
 * one that was actually short is the flower, which the old comment listed as the safest.
 *
 * The three `top` props no longer need a boost at all — B9.1 made them big enough to fit the
 * head they go on, which is 1.09 units across — and giving them one now costs frame width at
 * portrait aspect, where the shelf's own half-width is what the camera binds on. Hat 1.1 -> 1,
 * crown 1.06 -> 1, sunglasses 1.45 -> 1.3, flower 1 -> 1.2 (41 px -> 49).
 *
 * The moustache is the one that cannot be closed: 51 px on its short axis at 1.5x, and that
 * is the ceiling — a moustache tall enough to be comfortable on the shelf would be shown at
 * more than half again the size it can ever be worn at, and would climb over the bow tie
 * next to it.
 */
export const SHELF_BOOST: readonly number[] = [1.3, 1.3, 1, 1, 1, 1.5, 1.06, 1.2, 1, 1];

/** Scale an accessory is drawn at while it is on the shelf. */
export const shelfScale = (index: number): number =>
  SHELF_SCALE * (SHELF_BOOST[index] ?? 1);

/** Pad the prop stands on, so a slot reads as a place rather than as a coincidence. */
export const PAD_R = 0.21;
export const PAD_H = 0.045;

/* ------------------------------------------------------------------ */
/* The booth's own controls                                            */
/* ------------------------------------------------------------------ */

/**
 * Where the camera, the lever and the tray stand, and how much room each takes.
 *
 * They are on the table **in front of** the turntable rather than on it, and that is forced
 * rather than chosen: `SLOT_ARC` is 142 degrees each side of front, so the ten accessories
 * already occupy the whole rail except 76 degrees at the back — where a camera would face
 * away from the tooth and stand behind it.
 *
 * The band they stand in is the one the DOM control row used to cover. `cameraFor` was
 * already reserving that height (`controlsPx`); with the row gone (round 4, SM7) the reserve
 * becomes just the play area's own bottom padding and the controls are fitted as content,
 * so the same picture holds three objects instead of a strip of bare cream.
 *
 * `r` and `h` are a conservative envelope in the control's own frame, exactly like
 * `PROP_ENVELOPE`, and `buildControls` checks the built geometry against them in dev.
 */
export type ControlSlot = {
  id: "snap" | "surprise" | "tray";
  x: number;
  z: number;
  /** XZ radius of the built control, about its own origin. */
  r: number;
  /** Height above the table. */
  h: number;
};

export const CONTROL_SLOTS: readonly ControlSlot[] = [
  { id: "snap", x: -1.1, z: 1.42, r: 0.34, h: 0.53 },
  { id: "surprise", x: 0, z: 1.66, r: 0.2, h: 0.55 },
  { id: "tray", x: 1.15, z: 1.47, r: 0.36, h: 0.22 },
];

/*
 * `z` is what the solve is sensitive to, and it is solved rather than composed by eye.
 *
 * These three are the closest things in the shot to the lens, so their **front edge** is the
 * lowest thing in the frame and it is what `yLow` binds on. Measured through `cameraFor` on
 * the design rect (`scratchpad/sm/ctl1.mjs`, sweeping z and an overall scale):
 *
 * ```
 *   all three at z   1.42   1.52   1.62      no controls at all
 *   distance         9.39   9.55   9.71      9.13
 * ```
 *
 * An overall scale on the props themselves barely moves it (0.72x buys 0.12 of distance),
 * because what binds is where they *stand*, not how big they are. So each one stands on the
 * smallest circle that clears the turntable — `RING_OUTER` (1.49) plus its own base radius,
 * so no plinth is inside the rail — and keeps its full size, which is what makes these the
 * largest tap targets in the game. As placed the whole row costs **1.5 %** of camera
 * distance: 9.264 against 9.131 with no controls at all, and 8.817 in the frame round 4
 * photographed, which had a strip of bare cream there instead.
 *
 * The lever is the awkward one: at `x = 0` it is on the axis, so clearing the rail costs it
 * pure depth, and depth is exactly what `yLow` binds on. Its base is therefore the smallest
 * of the three (0.16 against the camera's 0.30), which is what lets it stand at z 1.66
 * instead of 1.74 — worth 0.07 of distance and the difference between a knob that reads and
 * a knob lost among the props on the rail behind it.
 *
 * On a phone all three are free: at 0.56 aspect the width binds on the cape and the balloon
 * long before them, and the solved distance is 12.367 with or without them.
 */

/**
 * Tap radius for a booth control, in world units.
 *
 * Larger than `PROP_HIT_R` because these are not on the rail and have no neighbour to
 * swallow: the nearest pair of centres is 1.1 apart, so a 0.36 radius leaves 0.38 of clear
 * table between them. They are also the closest objects in the shot to the lens, which makes
 * them the largest targets in the game in screen space. Projected through the solved camera
 * (`scratchpad/sm/targets.mjs`):
 *
 * ```
 *                     design 822x670    phone 358x640
 *   the three         118-122 px        82-84 px
 *   the ten on shelf  57-71 px          42-50 px, floored to 48 by `HitTarget`
 * ```
 */
export const CONTROL_HIT_R = 0.36;

/* ------------------------------------------------------------------ */
/* Interaction                                                         */
/* ------------------------------------------------------------------ */

/**
 * A lifted prop rides a single camera-facing sheet this far in front of the booth's centre.
 *
 * One sheet for every prop, rather than one through each anchor, because three of the seven
 * anchors are behind or beside the tooth: a cape dragged on a sheet through its own anchor
 * would spend the whole drag hidden behind the head it is being fitted to. On this sheet the
 * prop is always in clear view, and the target ring is drawn where the ray from the camera
 * through the anchor crosses the same sheet — so it still appears exactly over the spot on
 * the tooth, and prop and target are always coplanar.
 */
export const DRAG_PLANE_LIFT = 3;
/**
 * Snap radius as a fraction of the *half-height of the view at the sheet's own depth*, not
 * as a fixed number of world units: the sheet sits a fixed 3 units in front of the booth,
 * so on a laptop (camera at 8.7) it is proportionally much closer to the lens than on a
 * phone (camera at 13.4), and a constant world radius would mean "anywhere at all" on one
 * and "dead centre" on the other. 0.3 of the half-height is about 15% of the picture.
 */
export const SNAP_SCREEN = 0.3;
/** How far a lifted prop floats further toward the camera, off the sheet. */
export const DRAG_POP = 0.18;

/** Tap target radius in world units; `HitTarget` grows it if the screen size falls short. */
/**
 * Tap target radius in world units; `HitTarget` grows it if the screen size falls short.
 *
 * Capped by the slot spacing rather than chosen for comfort: at the design framing the
 * nearest two prop centres are 68 CSS px apart, so a collider bigger than 34 px of radius
 * would start swallowing its neighbour. 0.22 world is 33 px there and is raised to the
 * 24 px `minScreenPx` floor on a phone, where the centres are 47 px apart.
 */
export const PROP_HIT_R = 0.22;

/* ------------------------------------------------------------------ */
/* Orbit                                                               */
/* ------------------------------------------------------------------ */

const DEG = Math.PI / 180;

/** Hard clamps. The child can look down onto the hat or up under the chin, never further. */
export const ELEVATION_MIN = 7 * DEG;
export const ELEVATION_MAX = 56 * DEG;
/** Yaw is clamped hard too: the face never turns away, so the booth is never disorienting. */
export const YAW_LIMIT = 62 * DEG;

/** Radians of orbit per CSS pixel of drag. A full view width is roughly the whole range. */
export const ORBIT_YAW_PER_PX = 0.0055;
export const ORBIT_PITCH_PER_PX = 0.0038;
/** One arrow-key press (with Shift held — plain arrows move keyboard focus). */
export const ORBIT_KEY_YAW = 10 * DEG;
export const ORBIT_KEY_PITCH = 7 * DEG;

/*
 * There is no hold, because there is no timed return. Round 4, SM8: the booth used to take
 * itself back to front-on 1.15 s after the child stopped turning it. The orbit is a position
 * the child owns now and it is held until they change it; `scene.tsx::returnToFront` eases
 * it back only on Clear, Surprise and the shutter, and `ORBIT_RETURN_LAMBDA` is the speed of
 * that — deliberately slower than a spring, a turntable settling rather than a snap-back.
 */
export const ORBIT_RETURN_LAMBDA = 0.85;
export const ORBIT_FOLLOW_LAMBDA = 9;
/** Reduced motion: direct, immediate, no drift and no return. */
export const ORBIT_REDUCED_LAMBDA = 30;

/* ------------------------------------------------------------------ */
/* Camera                                                              */
/* ------------------------------------------------------------------ */

export const FOV = 28;
export const TAN_HALF_FOV = Math.tan((FOV * Math.PI) / 360);

/** Fallbacks only. Both are measured from the live DOM and passed in — see `Booth`. */
const CHROME_PX = 132;
const CONTROLS_PX = 78;

const MIN_DISTANCE = 8;
const MAX_DISTANCE = 16;

/** Where the camera aims when the orbit is at rest — roughly the tooth's waist. */
export const TARGET_Y = 0.92;

/**
 * Breathing room left around the content, as a fraction of the half-view. Small on purpose:
 * `GameShell` now feathers the play-area boundary into the page cream, so a rim that touches
 * the edge fades rather than being sliced.
 */
const MARGIN = 0.04;
/**
 * How much of the frame the turntable's bare rim must still keep clear of the play area's
 * own edge. Smaller than `MARGIN` because this is the boundary of the scissor rectangle, not
 * the boundary of the composition.
 */
const BLEED_MARGIN = 0.02;

/* ------------------------------------------------------------------ */
/* What has to be in shot                                              */
/* ------------------------------------------------------------------ */

/**
 * The camera is solved by **projecting the things that matter and fitting them**, not from a
 * pair of hand-written half-extents.
 *
 * The old code reserved a fixed `HALF_HEIGHT = 2.1` — a number that had drifted to cover a
 * party-hat tip measured in the wrong place — and solved `forHeight ~= 12.8` against a
 * `forWidth ~= 6.4`. The height constraint won by a factor of two, the camera went to the
 * far end of the legal distance band, and round 2 measured the result: the booth covering
 * **14.2%** of an 822x670 play area — bounding box 382 x 354 — with 440 px of bare cream at
 * the sides and 120 px of dead cream between the title band and the tooth.
 *
 * A half-extent cannot describe this booth, because the booth is not vertically symmetric
 * about anything and the front of the turntable is 1.6 units closer to the lens than the
 * tooth is — so it projects much further down than its distance from the aim point suggests.
 * The fix is to stop approximating: sample the real silhouette, project it through the real
 * camera, and shrink the distance until it fits the part of the frame that is actually
 * clear. Same arithmetic a person does when they frame a photograph.
 */
/**
 * The dressed tooth's own silhouette: `[radius, height]`, in world space, at rest.
 *
 * Measured, not reasoned. Every accessory is placed at its anchor with its attach pose and
 * every vertex of the result — tooth, face, arms, feet, podium and all ten props at once —
 * is bucketed by height at 0.02; this is a polyline whose linear interpolation lies above
 * every bucket with room for the tooth's 0.013 idle bob. `buildSmileScene()` re-derives the
 * whole dressed silhouette on mount and errors in dev if any vertex reaches outside it
 * (`assertWornFits`), exactly as it already does for `PROP_ENVELOPE` — and it caught this
 * table's own first draft, which undershot the cape's hem by 0.059 at y = 0.38.
 *
 * The two entries this replaces were the whole of B9.8. The old stack reserved
 * `ring(1.0, 1.62)` and `ring(0.62, 2.12)`: a full 0.62-radius disc at the height of a party
 * hat's tip. The tip of a party hat is a pompom **0.20** across, and the widest thing at
 * that height is nothing at all. Reserving a disc three times too wide at the very top of
 * the shot is what pushed the camera back and left the dead cream band the round-3 capture
 * measured between the title and the diorama — 140 px of an 820 px frame.
 *
 * `ring(0.55, 0)` was also 0.07 *under* the podium it stands for. That direction is worse:
 * it is a crop, not a waste.
 */
export const WORN_SILHOUETTE: readonly (readonly [number, number])[] = [
  [0.65, 0.0], // podium
  [0.65, 0.18],
  [0.45, 0.2], // bare roots between the podium and the cape's hem
  [1.07, 0.26],
  [1.07, 0.6], // the cape's hem, 1.066 at its widest
  [1.02, 1.0],
  [0.8, 1.24],
  [0.86, 1.34],
  [0.92, 1.44],
  [1.02, 1.62], // the balloon, held out to one side, 1.012 at its widest
  [1.02, 1.8],
  [1.0, 1.86],
  [0.95, 1.96],
  [0.9, 2.0],
  [0.86, 2.02],
  [0.78, 2.04],
  // Above the balloon there is the party hat's cone and its pompom, and nothing else. The
  // cone is taller than it was (SM6) and this column is a quarter of a unit wide against the
  // 1.02 below it, so the extra height is nearly free: measured through `cameraFor`, the
  // whole of round 4's geometry work moves the solved distance from 8.82 to 8.75 on the
  // design rect and from 12.69 to 11.38 on a 390x844 phone.
  [0.25, 2.1],
  [0.25, 2.38],
];

const CONTENT: Float64Array = (() => {
  const pts: number[] = [];
  const push = (x: number, y: number, z: number) => {
    pts.push(x, y, z);
  };
  /** A horizontal ring of `n` points — the shape almost everything in this booth is. */
  const ring = (radius: number, y: number, cx = 0, cz = 0, n = 16) => {
    for (let i = 0; i < n; i++) {
      const t = (i / n) * Math.PI * 2;
      push(cx + Math.sin(t) * radius, y, cz + Math.cos(t) * radius);
    }
  };

  // 2. Every shelf prop, at its own size and in its own slot. Two rings each: the full
  //    radius where it stands, and 70 % of it at the top, because nothing on this shelf is a
  //    cylinder — a hat is a brim under a dome, a balloon is a sphere on a string, and
  //    reserving a full-width box for the top of each one is what would push the camera back
  //    for air that has nothing in it.
  for (let i = 0; i < SLOT_COUNT; i++) {
    const slot = SLOT_OF[i] ?? i;
    const sx = slotX(slot);
    const sz = slotZ(slot);
    const r = PROP_ENVELOPE[i][0] * shelfScale(i);
    const h = PROP_ENVELOPE[i][1] * shelfScale(i);
    ring(r, RING_TOP - 0.04, sx, sz, 8);
    ring(r * 0.7, RING_TOP + h, sx, sz, 8);
  }

  // 3. The three booth controls, standing on the table in front of the rail. Two rings
  //    each, the same way the shelf props are reserved: the full radius where each stands
  //    and 70 % of it at the top, because none of them is a cylinder.
  for (const c of CONTROL_SLOTS) {
    ring(c.r, 0, c.x, c.z, 8);
    ring(c.r * 0.7, c.h, c.x, c.z, 8);
  }

  // 4. The tooth and everything it can be wearing at once.
  //
  //    This used to be a four-ring stack whose numbers were reasoned rather than measured,
  //    and two of them were wrong in the direction that costs picture. `WORN_SILHOUETTE`
  //    below is the real union, sampled off the built geometry.
  for (let i = 0; i < WORN_SILHOUETTE.length; i++) {
    ring(WORN_SILHOUETTE[i][0], WORN_SILHOUETTE[i][1], 0, 0, 12);
  }

  return new Float64Array(pts);
})();

/**
 * Things that may run off the edge of the frame, but not far.
 *
 * The bare rim of the turntable, and nothing else. Reserving picture height for it is what a
 * bounding-box camera does; choosing the shot means deciding that a rail with nothing on it
 * is allowed to pass behind the control row at the bottom of the frame and under the title
 * band at the top, the way a table runs out of a photograph. `GameShell` feathers the play
 * area's boundary into the page cream, so the rim fades out rather than being sliced.
 *
 * It is still held inside the frame proper — a rim clipped by the *scissor rectangle* would
 * be a hard edge, which is the thing the feather exists to prevent.
 */
const BLEED: Float64Array = (() => {
  const pts: number[] = [];
  for (let i = 0; i < 24; i++) {
    const t = (i / 24) * Math.PI * 2;
    const x = Math.sin(t) * RING_OUTER;
    const z = Math.cos(t) * RING_OUTER;
    pts.push(x, 0, z, x, RING_TOP, z);
  }
  return new Float64Array(pts);
})();

export type CameraFraming = {
  position: [number, number, number];
  target: [number, number, number];
  fov: number;
};

/**
 * Live framing, shared with the scene.
 *
 * The scene has to know the point the camera orbits around and how much of the frame the
 * chrome eats (so the polaroid lands in the clear part of it), and it cannot read that
 * through React context — 3D components render in the R3F root. `cameraFor` is a pure
 * function of the measured rect that also parks its answer here, which is the same
 * module-store pattern `src/three/store.ts` uses.
 */
export const framing = {
  tx: 0,
  ty: TARGET_Y,
  tz: 0,
  distance: 12,
  chromeFrac: 0.16,
  controlsFrac: 0.1,
};

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/**
 * Projects `CONTENT` through a camera at distance `r` whose aim point has been slid `shift`
 * along the camera's own up axis, and reports the NDC bounds.
 *
 * Allocation-free and module-scoped: `cameraFor` runs a two-level solve over it and is
 * called from a React render, so it must not produce garbage.
 */
const bounds = { minY: 0, maxY: 0, maxX: 0, bleedMinY: 0, bleedMaxY: 0, bleedMaxX: 0 };

function project(r: number, shift: number, aspect: number): void {
  const sinE = Math.sin(ELEVATION);
  const cosE = Math.cos(ELEVATION);

  // Aim point, and the camera parked `r` back along the elevation.
  const ay = TARGET_Y + shift * cosE;
  const az = -shift * sinE;
  const cy = ay + r * sinE;
  const cz = az + r * cosE;

  let minY = Infinity;
  let maxY = -Infinity;
  let maxX = 0;
  let bMinY = Infinity;
  let bMaxY = -Infinity;
  let bMaxX = 0;

  // Camera basis. Forward is (0, -sinE, -cosE); right is world X; up completes it.
  for (let pass = 0; pass < 2; pass++) {
    const src = pass === 0 ? CONTENT : BLEED;
    for (let i = 0; i < src.length; i += 3) {
      const dx = src[i];
      const dy = src[i + 1] - cy;
      const dz = src[i + 2] - cz;
      const depth = -dy * sinE - dz * cosE;
      if (depth < 0.2) continue;
      const ndcY = (dy * cosE - dz * sinE) / (depth * TAN_HALF_FOV);
      const ndcX = dx / (depth * TAN_HALF_FOV * aspect);
      const ax = ndcX < 0 ? -ndcX : ndcX;
      if (pass === 0) {
        if (ndcY < minY) minY = ndcY;
        if (ndcY > maxY) maxY = ndcY;
        if (ax > maxX) maxX = ax;
      } else {
        if (ndcY < bMinY) bMinY = ndcY;
        if (ndcY > bMaxY) bMaxY = ndcY;
        if (ax > bMaxX) bMaxX = ax;
      }
    }
  }

  bounds.minY = minY;
  bounds.maxY = maxY;
  bounds.maxX = maxX;
  bounds.bleedMinY = bMinY;
  bounds.bleedMaxY = bMaxY;
  bounds.bleedMaxX = bMaxX;
}

/**
 * For a given distance, finds the aim shift that centres the content in the clear band and
 * reports whether it fits. Four passes: the relation is very nearly linear (sliding the aim
 * point by `s` moves the picture by `s / (r * tan)`), so it converges immediately.
 */
function fitAt(r: number, aspect: number, yLow: number, yHigh: number, xLim: number): number {
  let shift = 0;
  const want = (yLow + yHigh) * 0.5;
  for (let pass = 0; pass < 4; pass++) {
    project(r, shift, aspect);
    shift += ((bounds.minY + bounds.maxY) * 0.5 - want) * r * TAN_HALF_FOV;
  }
  project(r, shift, aspect);
  const fits =
    bounds.minY >= yLow &&
    bounds.maxY <= yHigh &&
    bounds.maxX <= xLim &&
    bounds.bleedMinY >= -1 + BLEED_MARGIN &&
    bounds.bleedMaxY <= 1 - BLEED_MARGIN &&
    bounds.bleedMaxX <= 1 - BLEED_MARGIN;
  // Encodes both answers in one return so the caller never has to re-run the projection:
  // NaN means "does not fit at this distance".
  return fits ? shift : Number.NaN;
}

/** One-entry memo: `cameraFor` is called from a React render, not only on resize. */
const memo = {
  width: -1,
  height: -1,
  chrome: -1,
  controls: -1,
  result: null as CameraFraming | null,
};

/**
 * Solves the camera from the measured play-area rect and the measured chrome.
 *
 * `GameShell` hands a game its whole interior, which is 1.23:1 on a laptop and about 0.47:1
 * on a phone held upright, and publishes its title band's real height as `--chrome-h`; this
 * game measures its own control row the same way. Both bands are reserved, the content is
 * fitted into what is left, and the aim point is slid along the camera's own up vector so
 * the booth sits centred in the part of the frame that is actually clear.
 *
 * The distance is found by bisection rather than by a closed form because the vertical
 * constraint is genuinely perspective — the nearest thing in the shot is 1.6 units closer to
 * the lens than the aim plane — and a closed form would have to linearise exactly the term
 * that used to be wrong. Twenty-two halvings over [4, 30] resolve it to under a millimetre;
 * the whole solve is about 15,000 multiply-adds and it is memoised on its inputs.
 */
export function cameraFor(
  width: number,
  height: number,
  chromePx = CHROME_PX,
  controlsPx = CONTROLS_PX
): CameraFraming {
  if (
    memo.result &&
    memo.width === width &&
    memo.height === height &&
    memo.chrome === chromePx &&
    memo.controls === controlsPx
  ) {
    return memo.result;
  }

  const aspect = width > 0 && height > 0 ? width / height : 1;
  const chrome = height > 0 ? clamp(chromePx / height, 0, 0.34) : 0.16;
  const controls = height > 0 ? clamp(controlsPx / height, 0, 0.22) : 0.1;

  // The clear band, in NDC. A fraction f of the height is 2f of NDC.
  const yHigh = 1 - 2 * chrome - MARGIN;
  const yLow = -1 + 2 * controls + MARGIN;
  const xLim = 1 - MARGIN;

  let lo = 4;
  let hi = 30;
  let shift = 0;
  if (Number.isNaN(fitAt(hi, aspect, yLow, yHigh, xLim))) {
    // Cannot fit even at the far end (a very short landscape rect). Take the far end and
    // let the clamp below decide: cropping the rim is better than an unsolvable loop.
    hi = 30;
  } else {
    for (let i = 0; i < 22; i++) {
      const mid = (lo + hi) * 0.5;
      if (Number.isNaN(fitAt(mid, aspect, yLow, yHigh, xLim))) lo = mid;
      else hi = mid;
    }
  }

  const r = clamp(hi, MIN_DISTANCE, MAX_DISTANCE);
  const solved = fitAt(r, aspect, yLow, yHigh, xLim);
  shift = Number.isNaN(solved) ? 0 : solved;
  // The clamp may have moved the distance away from what the solve assumed, so recentre
  // once at the distance actually used.
  if (Number.isNaN(solved)) {
    let s = 0;
    const want = (yLow + yHigh) * 0.5;
    for (let pass = 0; pass < 4; pass++) {
      project(r, s, aspect);
      s += ((bounds.minY + bounds.maxY) * 0.5 - want) * r * TAN_HALF_FOV;
    }
    shift = s;
  }

  const cosE = Math.cos(ELEVATION);
  const sinE = Math.sin(ELEVATION);
  const ty = TARGET_Y + shift * cosE;
  const tz = -shift * sinE;

  framing.tx = 0;
  framing.ty = ty;
  framing.tz = tz;
  framing.distance = r;
  framing.chromeFrac = chrome;
  framing.controlsFrac = controls;

  const result: CameraFraming = {
    position: [0, ty + r * sinE, tz + r * cosE],
    target: [0, ty, tz],
    fov: FOV,
  };
  memo.width = width;
  memo.height = height;
  memo.chrome = chromePx;
  memo.controls = controlsPx;
  memo.result = result;
  return result;
}

/** Shadow frustum: bound the booth, not the world (3D-FOUNDATION-NOTES §8). */
export const SHADOW_AREA = 2 * (RING_OUTER + 0.5);

/* ------------------------------------------------------------------ */
/* The polaroid                                                        */
/* ------------------------------------------------------------------ */

export const PHOTO_W = 0.86;
export const PHOTO_H = 1.02;
/** The print itself, inset in the paper with the classic wide bottom margin. */
export const PHOTO_IMAGE = 0.72;
export const PHOTO_IMAGE_Y = 0.085;
export const PHOTO_CAPTION_Y = -0.375;
export const PHOTO_PAPER_T = 0.045;

/**
 * Distance in front of the camera the polaroid is held. Chosen so the print is 46% of the
 * frame height at any aspect, which also keeps it inside the width of a phone held upright.
 */
export const PHOTO_DIST = PHOTO_H / 0.46 / (2 * TAN_HALF_FOV);
/** Half-height of the view at that distance — the polaroid's slide-in travel. */
export const PHOTO_VIEW_HALF = PHOTO_DIST * TAN_HALF_FOV;

/** The framing of the capture itself: just the tooth and what it is wearing. */
export const CAPTURE_TARGET_Y = 0.94;
export const CAPTURE_DIST = 5;
export const CAPTURE_ELEVATION_MIN = 11 * DEG;
export const CAPTURE_ELEVATION_MAX = 34 * DEG;
