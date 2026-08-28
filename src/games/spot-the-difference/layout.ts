/**
 * Spot the Difference — pure numbers.
 *
 * Three unrelated things live here because all three are arithmetic with no dependencies:
 * the world coordinates of the diorama, the two-panel DOM layout solve, and the camera
 * that frames one panel. Nothing in this file imports `three` (the one `SceneCamera`
 * import is a type and erases), so `engine.ts` can read the spot table without dragging
 * the 3D layer into the logic.
 *
 * The unit convention is the product's: 1 world unit = 10 cm. The bathroom is a 62 x 42 cm
 * shoebox diorama — a doll's-house set, photographed on a long lens.
 */
import type { AccentFamily } from "../../three/tokens";
import type { SceneCamera } from "../../three/Scene3D";

/**
 * The accent family this game is registered under, stated **once** for the whole game.
 *
 * `src/games/index.ts` files this game under `rose` and the hub card a child taps to get here
 * is a rose gradient; round 4's A15 found four scenes contradicting their own registry entry
 * with a literal hex. `diorama.ts` and the shell both read the family from here and go through
 * `accent(GAME_ACCENT, tone)`, so there is no second place for the two to drift apart.
 *
 * It is a local constant rather than `GAMES[id].accent` on purpose: `src/games/index.ts` is
 * the module that loads this game's chunk, and a static import back into it from inside the
 * chunk is a cycle nobody needs for a five-letter string. `SpotTheDifference.tsx` proves the
 * two agree in DEV instead — see `assertRegistryAccent` there.
 */
export const GAME_ACCENT: AccentFamily = "rose";

/* ------------------------------------------------------------------ */
/* The room                                                            */
/* ------------------------------------------------------------------ */

/** Outer dimensions of the clay box the whole scene sits inside. */
export const ROOM = { w: 6.2, h: 4.2, depth: 1.7, rim: 0.26 } as const;

/**
 * Height of a `clayTray`'s well floor above its own underside, in that tray's local units.
 *
 * This mirrors `buildClayTray` (`src/three/geometry.ts`) line for line, and it exists
 * because round 2 shipped with the back wall guessed instead of derived. The old value
 * assumed the tray's floor was `rim` thick (0.26); the builder actually makes it
 * `max(height * 0.3, baseRoll + 0.01)` — 0.51 here, nearly twice as thick — so every prop
 * "hung on the wall" was placed a quarter of a unit *inside* solid clay. One of the five
 * differences was literally unfindable.
 *
 * `buildDiorama` re-measures the real geometry on every build and shouts in DEV if this
 * drifts from it, so the duplication can never rot silently.
 */
function trayWellFloor(height: number, rim: number, w: number, d: number): number {
  const halfMin = Math.min(Math.max(w, 0.05), Math.max(d, 0.05)) * 0.5;
  const h = Math.max(height, 0.03);
  // `MIN_BEVEL` in geometry.ts.
  const wall = Math.min(Math.max(rim, 0.02), halfMin * 0.45);
  const topRoll = Math.min(wall * 0.45, h * 0.22);
  const baseRoll = Math.min(wall * 0.35, h * 0.2);
  const innerTop = h - topRoll;
  return Math.min(Math.max(h * 0.3, baseRoll + 0.01), innerTop - 0.03);
}

/** World Y of the rig's ground plane — the underside of the box. */
export const GROUND_Y = -ROOM.h / 2; // -2.10
/** Inside floor of the box. Everything that stands on the floor starts here. */
export const FLOOR_Y = GROUND_Y + ROOM.rim; // -1.84
/**
 * Inside back wall — the face of the tray's well floor, once the tray has been stood on
 * end. Derived, never guessed: see `trayWellFloor`.
 */
export const TRAY_WELL_FLOOR = trayWellFloor(ROOM.depth, ROOM.rim, ROOM.w, ROOM.h); // 0.51
export const BACK_Z = -ROOM.depth + TRAY_WELL_FLOOR; // -1.19
/** Inside left/right walls. */
export const INNER_X = ROOM.w / 2 - ROOM.rim; // 2.84
/** Inside ceiling. */
export const INNER_Y = ROOM.h / 2 - ROOM.rim; // 1.84

/**
 * Smallest gap a wall prop keeps between its own back face and `BACK_Z`.
 *
 * Small on purpose — a star stuck on a mirror is stuck *on* it — but never zero: coplanar
 * surfaces z-fight, and a shadow needs somewhere to land to read as "in front of".
 */
export const WALL_GAP = 0.012;

/** Top surface of the vanity counter — a shadow receiver, and where the cup stands. */
export const COUNTER_Y = -0.56;
/** Top surface of the wall shelf — the soap bottle's two homes. */
export const SHELF_Y = -0.55;

/**
 * The plane the two answer marks — the "found" badge and the "oops" ripple — are drawn on.
 *
 * `z = 0` is the **front rim of the box**, not an arbitrary number: the tray is 1.7 deep and
 * its well floor sits at `BACK_Z` (−1.19), so its underside is at −1.70 and its opening is at
 * exactly 0.00. Every prop in the room is therefore behind this plane, and the deepest-forward
 * one — the duck, whose front face reaches `z = −0.09` — clears it by 0.09.
 *
 * ## Why this replaced `depthTest: false`
 *
 * Round 2 drew both marks at the prop's own depth and the room ate them: ring #4's back
 * surface finished 0.01 behind the wall and rendered as a large "C" with a chunk missing, and
 * the towel ring passed behind the counter. Round 3's answer was `depthTest: false` plus a
 * `renderOrder` above every prop, which is the same class of fix `3D-SPEC §0` and round 4's A1
 * removed from the shared focus ring: a mark that ignores the depth buffer is a sticker on the
 * screen, not an object in the picture, and it is drawn with no relationship to the light.
 *
 * Sliding the mark onto this plane along the camera ray solves the original problem
 * *geometrically* instead — the mark cannot intersect the room because it is wholly in front
 * of it — which means depth testing can stay **on**, the mark can be a lit clay solid, and it
 * still lands exactly over the prop it belongs to (see `slideToPlane` in `scene.tsx`).
 *
 * The badge geometry is built with its back face on this plane and its body extruding toward
 * the camera, so the whole solid is at `z >= 0` and nothing in the room can ever reach it.
 */
export const MARK_Z = 0;

/**
 * Planes a prop can drop a shadow onto. The self test sweeps a diff's bounding box along
 * the key-light direction against these to work out where its shadow may legally move.
 */
export const RECEIVER_Y = [FLOOR_Y, COUNTER_Y, SHELF_Y] as const;

/* ------------------------------------------------------------------ */
/* Where the wall furniture sits                                       */
/* ------------------------------------------------------------------ */

/**
 * Depths of the four things fixed to the back wall, each derived from its own thickness so
 * the prop is *in front of* the wall by `WALL_GAP` and by nothing more than it needs.
 *
 * They live here rather than in `diorama.ts` because `SPOTS` — the keyboard/pointer pick
 * table — has to agree with them exactly. Round 2 shipped them independently and the focus
 * ring for "Mirror" and "Little window" landed on blank wall.
 */
/** `roundedPlate(1.62, 1.72, 0.11, 0.24)` — half-thickness 0.055. */
export const MIRROR_Z = BACK_Z + WALL_GAP + 0.055; // -1.123
/** Front face of the rose backing board — where anything mounted *on* the mirror starts. */
const MIRROR_FACE_Z = MIRROR_Z + 0.055; // -1.068
/**
 * How far the glass seats *into* the backing board.
 *
 * Not zero, because two coplanar faces z-fight; not more than the glass is thick, or it
 * disappears again. 0.02 leaves the glass standing 0.05 proud of the rose, which at this
 * camera is about 3 CSS px of rose visible along the glass's lower and right edges — a lip,
 * which is what makes the rose read as a *frame* rather than as the board's colour.
 */
const GLASS_SEAT = 0.02;
/**
 * `roundedPlate(1.34, 1.44, 0.07, 0.18, 2)` — the glass, sitting in the front of the frame.
 *
 * Round 3 shipped this as `BACK_Z + WALL_GAP + 0.035`, described in this comment as
 * "recessed inside the frame". It was not recessed; it was *buried*. Both plates were flush
 * against the wall, so the glass occupied z ∈ [−1.178, −1.108] and the frame z ∈ [−1.178,
 * −1.068] — the glass was wholly inside the frame's volume and wholly inside its 1.62 × 1.72
 * footprint, and the frame is a solid `roundedPlate`, not a ring. Not one fragment of it
 * was ever drawn: the audit photographed the biggest prop in the room as an opaque red
 * plaque and a screen-reader child was told "Mirror" for it.
 *
 * The frame has no rebate to recess into, so the glass is seated into its front face
 * instead. Derived from the two thicknesses, never guessed:
 *   glass centre = frame front (−1.068) − GLASS_SEAT (0.02) + glass half (0.035) = −1.053,
 *   glass spans [−1.088, −1.018], frame front at −1.068 → 0.05 units proud.
 */
export const MIRROR_GLASS_Z = MIRROR_FACE_Z - GLASS_SEAT + 0.035; // -1.053
/**
 * Star: `beveledExtrude(depth 0.05, bevel 0.022)` is 0.094 deep, centred; sits on the glass.
 *
 * Derived from `MIRROR_GLASS_Z`, so it followed the glass forward: the stars' back faces now
 * meet the glass's front face exactly, instead of ending 0.054 proud of a solid red board
 * with the glass they were said to be stuck to hidden behind it.
 */
export const STAR_Z = MIRROR_GLASS_Z + 0.035 + 0.047; // -0.971
/** The window group's origin. Its deepest child (the sky panel) reaches 0.09 behind it. */
export const WINDOW_Z = BACK_Z + WALL_GAP + 0.09; // -1.088
/** The shelf plate is 0.5 deep lying flat, so its centre stands 0.25 off the wall. */
export const SHELF_Z = BACK_Z + WALL_GAP + 0.25; // -0.928
/** Floor tiles: `roundedPlate(_, TILE_DEPTH, …)` lying flat, back edge against the wall. */
export const TILE_DEPTH = 1.14;
export const TILE_Z = BACK_Z + WALL_GAP + TILE_DEPTH / 2; // -0.608

/* ------------------------------------------------------------------ */
/* The vanity, and why its depths are here                             */
/* ------------------------------------------------------------------ */

/**
 * The whole set was dressed against a wall a quarter of a unit further back than the one
 * that exists, and the mirror was only the visible half of that.
 *
 * With `BACK_Z` corrected from −1.44 to −1.19, the cabinet's 0.95-unit depth, the counter's
 * 1.10 and the basin's 1.04 no longer fit between the wall and the picture plane at `z = 0`:
 * pushing them forward until their backs met the real wall put the counter's lip 0.08 from
 * the frame and left the towel rail — which has to hang clear of the cabinet's face — poking
 * 0.04 *out* of the picture. The room did not get shallower; the props were always partly
 * inside the wall.
 *
 * So the vanity is re-proportioned to the room that is really there, back to front, with
 * each depth stated once and every dependent placement derived from it:
 *
 * ```
 *   wall −1.190 │ cabinet −1.178…−0.398 │ counter −1.178…−0.258 (0.14 lip)
 *               │ basin (z-squashed to fit the counter)
 *               │ rail −0.260 → towel −0.372…−0.122 │ picture plane 0.000
 * ```
 */
export const CABINET_D = 0.78;
export const CABINET_Z = BACK_Z + WALL_GAP + CABINET_D / 2; // -0.788
export const COUNTER_D = 0.92;
export const COUNTER_Z = BACK_Z + WALL_GAP + COUNTER_D / 2; // -0.718
/**
 * The basin is a lathe, so it is round in plan and 1.04 deep — wider than the counter it
 * stands on. Squashing it along Z alone makes it the oval a vanity basin actually is, and
 * costs no geometry: the parts are scaled inside `assemble`.
 */
export const BASIN_SQUASH = 0.85;
export const BASIN_Z = COUNTER_Z;
/** On the counter, a touch proud of its centre — where the original had it. */
export const CUP_Z = COUNTER_Z + 0.02; // -0.698
/** Clear of the cabinet's face, tucked just under the counter's lip. */
export const RAIL_Z = -0.26;

/* ------------------------------------------------------------------ */
/* Inspectable spots                                                   */
/* ------------------------------------------------------------------ */

export type Spot = {
  /** Screen-reader name. Read out by the hidden button `HitTarget` creates. */
  label: string;
  x: number;
  y: number;
  z: number;
  /** World radius of the prop. Grown on screen to at least `MIN_TAP_PX`. */
  r: number;
  /** Index into `DIFFS`, or -1 for a prop that is the same in both pictures. */
  diff: number;
};

/**
 * Every prop a child can point at, whether or not it can change.
 *
 * This table is what makes the game playable from a keyboard: arrowing through it moves a
 * focus ring around the *scene*, not around the answers, so a keyboard player searches
 * exactly the way a pointer player does. If the list were only the five diffs, tabbing
 * would spell out the solution.
 */
export const SPOTS: readonly Spot[] = [
  { label: "Toothbrush cup on the counter", x: -0.18, y: -0.28, z: CUP_Z, r: 0.45, diff: 0 },
  { label: "Folded towel on the rail", x: -1.8, y: -1.16, z: RAIL_Z, r: 0.52, diff: 1 },
  { label: "Rubber duck on the floor", x: 0.95, y: -1.6, z: -0.35, r: 0.45, diff: 2 },
  { label: "Stars stuck on the mirror", x: -1.72, y: 0.34, z: STAR_Z, r: 0.42, diff: 3 },
  { label: "Soap bottle on the shelf", x: 1.7, y: -0.25, z: SHELF_Z, r: 0.74, diff: 4 },
  { label: "Wash basin", x: -1.62, y: -0.4, z: BASIN_Z, r: 0.5, diff: -1 },
  /*
   * Deliberately **not** the mirror's centre.
   *
   * The mirror is the biggest prop in the room and the stars are stuck *on* it, so a pick
   * circle around its middle contains the star's centre outright — at which point the star,
   * which is one of the five answers, cannot be aimed at at all and the shared collider
   * assertion (`?selftest` → `hit-targets`) fails on "Mirror / Stars stuck on the mirror".
   * Moved up and in, and shrunk to a radius that clears the star at every panel size this
   * layout produces: centres are **0.772** units apart — √(0.37² + 0.66² + 0.152²), recomputed
   * after `MIRROR_GLASS_Z` was un-buried and `STAR_Z` followed it 0.09 forward, which moved
   * the two centres *further* apart, not closer.
   *
   * The collider that has to fit inside that, evaluated against the two shapes this actually
   * ships at rather than against a bound (`HitTarget` sizes it `minScreenPx * 0.5 * worldPerPixel`,
   * and `worldPerPixel = 2 · depth · tan(fov/2) / playAreaHeight`; both shapes solve to the same
   * fov 28 / distance 9.465 camera, so only the play-area height differs):
   *   desktop, 828 × 724 play area → panels 389 × 270, `fh` 0.373, `tapScreenPx` **129**,
   *            collider radius 129 · 0.5 · 0.006895 = **0.445**
   *   phone,   358 × 748 play area → panels 321 × 198, `fh` 0.265, `tapScreenPx` **182**,
   *            collider radius 182 · 0.5 · 0.006673 = **0.607**
   * Both are under the 0.772 separation, and the second is the tighter one — the phone, where
   * the panel is the smallest fraction of the view and `tapScreenPx` compensates hardest.
   *
   * That separation is no longer only reasoned about here: `SPOT_MIN_SEPARATION` recomputes it
   * from this table on every load (0.7718), and `panelHeightFloorPx` turns it into the panel
   * height below which the two constraints become contradictory — 157 px, which is what
   * `solvePanels` now refuses to choose and what replaced `tapScreenPx`'s silent 320 cap (SD5).
   * `?selftest=hit-targets` asserts the same thing in projected pixels, which is where it counts.
   */
  { label: "Mirror", x: -1.35, y: 1.0, z: MIRROR_Z, r: 0.62, diff: -1 },
  { label: "Little window", x: 1.75, y: 1.02, z: WINDOW_Z, r: 0.7, diff: -1 },
];

/**
 * Smallest tap radius in CSS pixels for the *pointer* path — 30 px of radius is a 60 px
 * target, more generous than §8's 48, which is safe here because `pick()` resolves a tie by
 * nearest centre: two overlapping pick circles still send the tap to the prop it is nearest.
 */
export const MIN_TAP_PX = 30;

/** The accessibility floor proper. Applies to the collider, which may not overlap. */
export const TAP_MIN_SCREEN_PX = 48;

/**
 * `minScreenPx` to hand `HitTarget`, given the panel's height as a fraction of the view.
 *
 * `HitTarget` sizes a collider from `worldPerPixel(camera, depth, viewHeightPx)` and
 * `viewHeightPx` is the **play area's** height — correct for every other game, because every
 * other game renders into the whole play area. This one renders into a panel that is a
 * fraction `fh` of it, so a collider sized to 48 "view" pixels is only `48 * fh` pixels on
 * the child's screen: at a typical `fh` of 0.49 that is 23 px, less than half the floor.
 * Dividing by `fh` cancels exactly (`perPixelPanel = perPixelView / fh`), so the collider
 * lands on 48 real pixels — and because the same number is reported to the probe, the
 * `hit-targets` assertion measures the panel too instead of quietly passing at 2x.
 */
export function tapScreenPx(panelFraction: number): number {
  if (!(panelFraction > 0.02) || panelFraction > 1) return TAP_MIN_SCREEN_PX;
  // `ceil`, not `round`: rounding down loses up to `0.5 * panelFraction` real pixels, and
  // 48 is a floor, not a target. Measured at the two shipped framings — phone `fh` 0.265
  // gives 48/0.265 = 181.13, and `Math.round` shipped 181, i.e. 181 x 0.265 = 47.965 real
  // px, 0.035 px under a hard §1.5/§8 bound. `ceil` costs at most one view pixel and makes
  // `tapScreenPx(fh) * fh >= 48` true at every fraction.
  //
  // **There is no cap here any more**, and the deleted one is round 4's SD5.
  //
  // It used to read `Math.ceil(px > 320 ? 320 : px)`. Below `panelFraction` 0.15 that clamp
  // silently stopped honouring §8's 48 px floor — the one number in this function — with no
  // warning, on the accessibility bound the whole function exists to hold. Capping the answer
  // is the wrong shape of fix twice over: it makes the guarantee quietly false, and it hides
  // the fact that the *layout* has produced a panel too small to play in, which is the thing
  // that actually needs to be true.
  //
  // What the cap was protecting against is real, and it is now enforced where the information
  // is. An unbounded `minScreenPx` grows the collider until two of them swallow each other,
  // which `?selftest=hit-targets` fails on ("no target's centre falls inside another target's
  // circle"). That bound turns out **not** to depend on the view at all — see
  // `panelHeightFloorPx`, where the play-area height cancels out of the algebra — so it is a
  // constraint on the panel, `solvePanels` enforces it when it chooses a layout, and it is
  // asserted in DEV. This function now always returns the number §8 asks for.
  return Math.ceil(TAP_MIN_SCREEN_PX / panelFraction);
}

/**
 * The closest two `SPOTS` centres get, in world units. Measured from the table, never quoted.
 *
 * `SPOTS`' own docblock quotes 0.772 for the Mirror/Stars pair and reasons about the collider
 * against it; this recomputes it from the shipped table on every load, so a spot that moves
 * cannot leave a stale number behind. It is the ceiling every collider has to fit under —
 * `?selftest=hit-targets` fails when one target's centre falls inside another's circle.
 */
export const SPOT_MIN_SEPARATION = (() => {
  let best = Infinity;
  for (let i = 0; i < SPOTS.length; i++) {
    for (let j = i + 1; j < SPOTS.length; j++) {
      const a = SPOTS[i];
      const b = SPOTS[j];
      const d = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
      if (d < best) best = d;
    }
  }
  return best;
})();

/**
 * The smallest panel, in CSS pixels of height, that can carry a 48 px collider on every spot
 * without two colliders swallowing each other. **This is what the deleted 320 cap was.**
 *
 * Derived, and the derivation is short enough to state in full. A collider's world radius is
 *
 *   `r = minScreenPx · 0.5 · worldPerPixel`,  `worldPerPixel = 2 · depth · tan(fov/2) / H`
 *
 * where `H` is the play area's height in CSS pixels (`hit.tsx` sizes against the play area,
 * which is why this game has to compensate at all). This game passes
 * `minScreenPx = 48 / fh = 48 · H / panelH`, so
 *
 *   `r = (48 · H / panelH) · 0.5 · 2 · depth · tan(fov/2) / H = 48 · depth · tan(fov/2) / panelH`
 *
 * — **`H` cancels.** The constraint is on the panel alone, and it is `r < SPOT_MIN_SEPARATION`:
 *
 *   `panelH > 48 · depth · tan(fov/2) / SPOT_MIN_SEPARATION`
 *
 * `depth` is taken at the *deepest* spot (the mirror, against the back wall) because that is
 * where a fixed screen radius buys the most world, i.e. the worst case. At the framing this
 * game ships — fov 28, distance 9.4655, deepest spot 0.64 further out — that is
 * `48 · 10.11 · 0.24933 / 0.772` = **157 px**, against a shipped 270 px on the desktop and
 * 198 px on the phone. `solvePanels` will not choose a layout under it.
 */
export function panelHeightFloorPx(panelW: number, panelH: number): number {
  const cam = cameraFor(panelW, panelH);
  // Distance from the camera to the deepest spot, along the view axis. The camera is nearly
  // head-on (6°/7°), so the axial component of the offset is within 1 % of the offset itself.
  const distance = Math.hypot(
    cam.position[0] - TARGET[0],
    cam.position[1] - TARGET[1],
    cam.position[2] - TARGET[2]
  );
  const depth = distance + (TARGET[2] - BACK_Z);
  return (TAP_MIN_SCREEN_PX * depth * Math.tan(((cam.fov ?? FOV) * DEG) / 2)) / SPOT_MIN_SEPARATION;
}

/* ------------------------------------------------------------------ */
/* Panel layout                                                        */
/* ------------------------------------------------------------------ */

export const PANEL_GAP = 14;
/**
 * Half-extents the frame must contain, at the aim plane.
 *
 * Larger than the box's own 3.10 x 2.10 half-size on purpose: the front rim sits 0.55 units
 * closer to the camera than the aim point, so it magnifies on the way to the film, and the
 * 6° azimuth and 7° elevation then swing the far corners further out again. The old comment
 * here said "about 5%" and did not distinguish the two axes. **Solved rather than estimated**,
 * by projecting the front rim's real outline (straight edges plus a corner arc, since the
 * rim is rolled) against the camera `cameraFor` produces at this very aspect, and iterating
 * to a fixed point because the camera depends on the answer:
 *
 *   required HALF_X = 3.422 · required HALF_Y = 2.310   (rim corner radius 0.26)
 *
 * So the real magnification is **10.4 %** horizontally and 10.0 % vertically, not 5 %; and
 * the two shipped numbers are not loose. `HALF_X = 3.4` is 0.6 % *under* what the rim's
 * outer edges need — the left and right rim edges are cropped by about two panel pixels,
 * which is invisible and is why nobody has ever seen it — and `HALF_Y = 2.36` carries 2.2 %
 * of spare. There is no framing headroom to reclaim here; anyone looking for a bigger picture
 * has to look at the panel box, not at these two numbers (see `solvePanels`).
 *
 * Declared up here, above the panel solver, because the solver's aspect floor *is* this
 * ratio — see `ASPECT_MIN`.
 */
const HALF_X = 3.4;
const HALF_Y = 2.36;

/** Width : height of the framed box — what a panel would ideally be shaped like. */
export const DIORAMA_ASPECT = HALF_X / HALF_Y; // 1.4407

/**
 * The aspect band a panel is allowed to land in.
 *
 * **The floor is the picture's own aspect and nothing looser.** `cameraFor` fits `HALF_X`
 * horizontally and `HALF_Y` vertically and takes whichever is tighter, so a panel narrower
 * than `DIORAMA_ASPECT` letterboxes: the picture is limited by the panel's *width* and the
 * spare height is dead cream. Round 2 shipped a floor of 0.75, which let the solver pick a
 * 386 x 439 panel — the diorama filled 54% of it, with 23% empty above and below, in a game
 * whose entire subject is looking closely at that picture. At the floor below the diorama's
 * own aspect there is no shape the solver can choose that does not waste picture.
 *
 * The ceiling is looser (a wide panel wastes a little width, not the subject) and is left
 * where it was.
 */
const ASPECT_MIN = DIORAMA_ASPECT;
const ASPECT_MAX = 1.62;

export type PanelSolution = {
  /** `row` = side by side, `column` = one above the other. */
  mode: "row" | "column";
  /** Panel size in CSS pixels. **Both panels are always exactly this size.** */
  pw: number;
  ph: number;
  /**
   * 1 when this came from a **layout** measurement of a real box, 0 for the placeholder.
   *
   * Round 4's SD1: the solve was fed `frame.getBoundingClientRect()`, which is a *transformed*
   * rect, and the hub → game entry is a framer-motion scale flip from 0.24 → 1. A warm chunk
   * mounts inside that flip, so the whole game was solved against a quarter-size box; and the
   * `ResizeObserver` watching the frame could never correct it, because a CSS transform does
   * not touch the content box it reports, so it never fired again. The bad solve was permanent
   * for the life of the mount.
   *
   * Nothing in this game may be built from a solve that did not come from `offsetWidth` /
   * `offsetHeight` or from a `ResizeObserver` entry's `contentRect` — both of which are layout
   * measurements a transform cannot reach. This flag is what `<Scene3D>`'s mount is gated on,
   * so a placeholder framing can never reach `ViewCamera` and be treated as a real placement.
   */
  measured: 0 | 1;
};

/** The solve before anything has been measured. Never handed to a camera — see `measured`. */
export const UNSOLVED: PanelSolution = { mode: "row", pw: 0, ph: 0, measured: 0 };

function fit(slotW: number, slotH: number): { pw: number; ph: number; score: number } {
  let pw = Math.max(1, slotW);
  let ph = Math.max(1, slotH);
  const aspect = pw / ph;
  if (aspect > ASPECT_MAX) pw = ph * ASPECT_MAX;
  else if (aspect < ASPECT_MIN) ph = pw / ASPECT_MIN;
  pw = Math.floor(pw);
  ph = Math.floor(ph);
  // Not area: what matters is how big the *diorama* ends up, and the camera fits the box
  // to whichever of the two panel axes is tighter. A tall thin panel has plenty of area
  // and shows a tiny bathroom.
  const byWidth = pw / DIORAMA_ASPECT;
  return { pw, ph, score: byWidth < ph ? byWidth : ph };
}

/**
 * Two equal panels in the available box — **side by side, and side by side is not a
 * preference.**
 *
 * Equal *is the point*: the two panels share one camera, and a perspective camera has one
 * aspect ratio. Panels of different sizes would need different projections, and different
 * projections invent differences that are not differences.
 *
 * ## Why the mode is not chosen on size any more (round 4, SD4)
 *
 * This function used to pick whichever arrangement made the diorama bigger, and on
 * 1440 × 900 that is `column` — which contradicts `3D-SPEC §6.5`, "two miniature 3D bathroom
 * dioramas **side by side**", and is the second half of round 4's SD4.
 *
 * So the layout is `row`, and `column` exists for exactly one reason — the *other* normative
 * line, `§8`'s 48 px tap floor. On a phone, `row` halves an already narrow box:
 * 322 × 411 → **154 × 106**, and a 106 px panel cannot carry a 48 px collider on every spot
 * without two colliders swallowing each other (`panelHeightFloorPx` says it needs 157). So the
 * phone falls back to `column`, 321 × 198, which clears the floor by 26 %.
 *
 * Two rules, both quoted from the spec, and nothing chosen by eye.
 *
 * ## What side by side costs, measured honestly
 *
 * The obvious objection is that this trades picture size for a layout preference, in the game
 * whose headline complaint is that the picture is too small. It is worth the two lines of
 * arithmetic, because the size the *panel* loses and the size the **picture** loses are not
 * the same number — `cameraFor` fits the diorama to whichever panel axis is tighter, so a
 * column panel is wider than the picture inside it and 51 px of every 457 is dead cream:
 *
 *   desktop 1500 × 820 → box 792 × 499 → row 389 × 270  (unchanged)
 *   desktop 1440 × 900 → box 792 × 579 → **row 389 × 270**, was column 457 × 282.
 *                        Panel area says −17 points of play-area coverage; **picture** area
 *                        says 34.4 % → 31.6 %, and the diorama itself is **4.4 % smaller
 *                        linearly** (270 against 282). A child does not see 4.4 %; a child does
 *                        see whether the two pictures are beside each other.
 *   phone    390 × 844 → box 322 × 411 → column 321 × 198  (unchanged: row is 106 px, under 157)
 *   tablet   768 × 1024 (portrait) → box ~736 × 700 → **row 361 × 250**, was column ~555 × 343.
 *                        This one really is expensive — 27 % of picture height — and it is
 *                        stated rather than buried.
 *
 * Every one of those losses is repaid several times over by the width cap below, which is the
 * change that actually matters: at a 1400 px cap `row` is 659 × 457 and beats `column`
 * outright at every shape. `?selftest=spot` prints the picture coverage on every run so the
 * trade stays visible instead of living in this comment.
 *
 * ## What actually limits the picture, measured
 *
 * The round-3 audit filed the pictures at ~28 % of the play area and put it down to the
 * frame's `flex-1` not resolving against the viewport. Evaluated numerically against this
 * function at the shipped shell sizes, that diagnosis is wrong and the frame's height is
 * fine — the giveaway is in the audit's own measurement, ~130 px of dead cream *above* the
 * panels and ~95 px *below*: a flex child that had collapsed to its content would have none,
 * because it would be hugging the panels. It is centring inside a box it does have.
 *
 *   desktop 1500 × 820 → shell 828 × 724 → this box 792 × 499 → **row, 389 × 270**
 *                        pictures 35.0 % of the play area, 46.8 % of the box dead cream
 *   phone    390 × 844 → shell 358 × 748 → this box 322 × 411 → **column, 321 × 198**
 *                        pictures 47.5 % of the play area, 3.9 % of the box dead cream
 *
 * On the phone the solve is already inside the 40–70 % band a Toca Boca frame sits in. On the
 * desktop the panel is **width**-starved and height-rich: `(792 − 14) / 2 = 389` px of width,
 * at the diorama's own 1.4407 aspect, *is* 270 px of height, and the leftover 229 px of the
 * box cannot become picture — a taller panel only letterboxes, because `cameraFor` fits the
 * tighter of its two constraints (see `ASPECT_MIN`). Nothing in this file can spend it.
 *
 * The one lever is the width this function is handed, and it is capped outside this game:
 * `src/GamesCollection.tsx` wraps every game in `max-w-[860px]`, which is 828 of interior and
 * 792 after `GameShell`'s padding. Raising that cap for this game alone would give, on the
 * same 1500 × 820 window: 1100 → 509 × 353 (46.5 %), 1240 → 579 × 401 (53.1 %), 1400 →
 * 659 × 457 (60.8 %). Every one of those is geometry-free — same room, same camera solve,
 * same draw calls, purely a bigger viewport.
 *
 * **It cannot be worked around from inside this game, and that is a fact about the renderer,
 * not a preference.** drei's `<View>` tracks `GameShell`'s play area and scissors to it, and
 * `measurePanels` publishes the panel rects as *fractions of that rect*; a panel that breaks
 * out of the 860 px column with a negative margin would be laid out fine in the DOM and then
 * clipped away by the scissor, because the WebGL viewport it is drawn into does not exist
 * outside the tracked element. Widening this game means widening the tracked element, and the
 * tracked element's width is set in `src/GamesCollection.tsx`. `?selftest=spot` now reports
 * the occupancy on every run so the number cannot go back to living only in this comment.
 */
export function solvePanels(w: number, h: number): PanelSolution {
  const row = fit((w - PANEL_GAP) / 2, h);
  const column = fit(w, (h - PANEL_GAP) / 2);
  const rowFits = row.pw >= 1 && row.ph >= panelHeightFloorPx(row.pw, row.ph);
  const solution: PanelSolution = rowFits
    ? { mode: "row", pw: row.pw, ph: row.ph, measured: 1 }
    : { mode: "column", pw: column.pw, ph: column.ph, measured: 1 };

  if (import.meta.env.DEV) {
    const floor = panelHeightFloorPx(solution.pw, solution.ph);
    if (solution.ph < floor) {
      console.error(
        `[spot/layout] a ${solution.pw}x${solution.ph} panel cannot carry a ` +
          `${TAP_MIN_SCREEN_PX}px collider on every spot: the panel has to be at least ` +
          `${floor.toFixed(0)}px tall before two colliders start swallowing each other ` +
          `(closest two spots are ${SPOT_MIN_SEPARATION.toFixed(3)} units apart). Neither ` +
          `layout fits in ${Math.round(w)}x${Math.round(h)} — the play area is too small for ` +
          `this game, and ?selftest=hit-targets will say so in projected pixels.`
      );
    }
  }
  return solution;
}

/**
 * The live geometry of the two panels, as fractions of the tracked view rect.
 *
 * Fractions rather than pixels on purpose. `GameShell` is CSS-scaled while the hub → game
 * transition plays, so a pixel rect measured at rest is wrong for ~400 ms. drei's `<View>`
 * re-reads the tracked rect every frame and hands it to the renderer as a viewport; a
 * fraction of *that* viewport is correct at every instant of the transition and costs no
 * per-frame `getBoundingClientRect`.
 *
 * Every field is a plain number and the object identity never changes, so `useFrame` reads
 * it without allocating.
 */
export type PanelLayout = {
  /** 1 once the panels have been measured at least once. */
  ready: number;
  /** Panel size as a fraction of the tracked view. */
  fw: number;
  fh: number;
  /** Panel origins as fractions from the view's left / bottom edge. */
  ax: number;
  ay: number;
  bx: number;
  by: number;
  /** Panel size in CSS pixels — the screen-space unit the tap radius is measured in. */
  pxW: number;
  pxH: number;
  /** Device-pixel rect actually rendered last frame. Written by the scene, read by the test. */
  devW: number;
  devH: number;
  devAX: number;
  devAY: number;
  devBX: number;
  devBY: number;
};

export function createPanelLayout(): PanelLayout {
  return {
    ready: 0,
    fw: 0,
    fh: 0,
    ax: 0,
    ay: 0,
    bx: 0,
    by: 0,
    pxW: 0,
    pxH: 0,
    devW: 0,
    devH: 0,
    devAX: 0,
    devAY: 0,
    devBX: 0,
    devBY: 0,
  };
}

/**
 * Converts three measured client rects into the fractions above.
 *
 * `ay`/`by` are measured from the *bottom* because that is the corner WebGL's viewport
 * uses. Both panels report one `fw`/`fh`; the two rects are laid out from the same
 * `PanelSolution` so they cannot disagree, and taking one keeps them provably equal even
 * if a browser rounds the two rects differently.
 */
export function measurePanels(
  layout: PanelLayout,
  area: HTMLElement,
  panelA: HTMLElement,
  panelB: HTMLElement
): void {
  const ar = area.getBoundingClientRect();
  const a = panelA.getBoundingClientRect();
  const b = panelB.getBoundingClientRect();
  if (ar.width < 1 || ar.height < 1 || a.width < 1 || a.height < 1) {
    layout.ready = 0;
    return;
  }
  layout.fw = a.width / ar.width;
  layout.fh = a.height / ar.height;
  layout.ax = (a.left - ar.left) / ar.width;
  layout.ay = (ar.bottom - a.bottom) / ar.height;
  layout.bx = (b.left - ar.left) / ar.width;
  layout.by = (ar.bottom - b.bottom) / ar.height;
  /*
   * `offsetWidth`/`offsetHeight`, **not** the rects above — round 4's SD1, second half.
   *
   * The six fractions are ratios of two rects inside the same transformed subtree, and the
   * entry flip is a uniform scale plus a translate, so every scale factor cancels exactly and
   * they are right at every instant of the animation. That is why they are measured this way
   * and why they stay that way.
   *
   * `pxW`/`pxH` are not ratios. They are the panel's size in **CSS pixels**, and they are the
   * unit `pick()` compares `MIN_TAP_PX` (30 px of radius) against and that the "oops" ripple
   * unprojects a tap through. Taken off a transformed rect they read 0.24 × the truth for the
   * whole flip — and, because a `ResizeObserver` on the untransformed content box never fires
   * again afterwards, they *stay* 0.24 × for the life of the mount. A 30 px floor measured in
   * quarter-size pixels is a 125 px floor on the child's screen: every tap in the left half of
   * the room resolves to whichever prop is nearest rather than the one under the finger.
   *
   * A CSS transform does not touch `offsetWidth`/`offsetHeight` — the same discipline
   * `Scene3D`'s `viewMetrics` and `GameShell`'s play-area guard already apply, for the same
   * reason.
   */
  layout.pxW = panelA.offsetWidth || a.width;
  layout.pxH = panelA.offsetHeight || a.height;
  layout.ready = 1;
}

/* ------------------------------------------------------------------ */
/* Camera                                                              */
/* ------------------------------------------------------------------ */

const FOV = 28;
const FOV_MIN = 26;
const FOV_MAX = 32;
const DEG = Math.PI / 180;
/** Nearly head-on: a raking view would hide props behind each other in one panel only. */
const AZIMUTH = 6 * DEG;
const ELEVATION = 7 * DEG;
const TARGET: readonly [number, number, number] = [0, -0.06, -0.55];
const MIN_DIST = 8;
const MAX_DIST = 16;

const clampFov = (fov: number) => (fov < FOV_MIN ? FOV_MIN : fov > FOV_MAX ? FOV_MAX : fov);

/**
 * Frames the whole box inside one panel.
 *
 * Solved from the panel's own aspect, not the play area's: the camera renders into the
 * panel viewport, so the panel is the frame. Vertical and horizontal constraints are both
 * solved and the tighter one wins.
 *
 * The lens moves only when the distance band runs out. A tall, narrow panel — two pictures
 * side by side on a laptop — needs to stand further back than the spec's 16 units allow,
 * and a very wide one closer than 8; in both cases the fov is opened or closed inside the
 * spec's 26–32 band until the distance fits, rather than cropping the room or breaking the
 * long-lens miniature look. 28 is used wherever it works, which is most shapes.
 */
export function cameraFor(panelW: number, panelH: number): SceneCamera {
  const aspect = panelW > 0 && panelH > 0 ? panelW / panelH : 1;
  const horizontal = HALF_X / aspect;
  const need = horizontal > HALF_Y ? horizontal : HALF_Y;

  let fov = FOV;
  let d = need / Math.tan((fov * DEG) / 2);
  if (d > MAX_DIST) {
    fov = clampFov((2 * Math.atan(need / MAX_DIST)) / DEG);
    d = need / Math.tan((fov * DEG) / 2);
  } else if (d < MIN_DIST) {
    fov = clampFov((2 * Math.atan(need / MIN_DIST)) / DEG);
    d = need / Math.tan((fov * DEG) / 2);
  }
  if (d < MIN_DIST) d = MIN_DIST;
  if (d > MAX_DIST) d = MAX_DIST;

  const ce = Math.cos(ELEVATION);
  return {
    position: [
      TARGET[0] + Math.sin(AZIMUTH) * ce * d,
      TARGET[1] + Math.sin(ELEVATION) * d,
      TARGET[2] + Math.cos(AZIMUTH) * ce * d,
    ],
    target: [TARGET[0], TARGET[1], TARGET[2]],
    fov,
  };
}

/* ------------------------------------------------------------------ */
/* The "found" badge — where it sits and which way it faces            */
/* ------------------------------------------------------------------ */

/**
 * World radius of the found badge, measured at the **prop's own depth**.
 *
 * The badge is authored in the same frame `SPOTS` is, and `scene.tsx` then slides it along the
 * camera ray onto `MARK_Z` and rescales by the same along-ray factor — so its projected size
 * is exactly what this radius says at the depth it is authored at, and the slide costs it
 * nothing. Every number below is therefore in prop-depth world units and converts to panel
 * pixels by one division.
 *
 * 0.40 is set by the smallest panel this layout will produce, not by taste. At the phone's
 * 321 × 198 panel a world unit is 42.7 panel pixels, so the badge is **34 px across**; at the
 * desktop's 389 × 270 it is 47 px; at the 1400 px cap `solvePanels` is asking for it is 79 px.
 * 34 px is the same size as the DOM progress pill's own tick chips (28 px + border), which is
 * the smallest tick a child is asked to read anywhere in this product.
 */
export const BADGE_R = 0.4;

/** Clear air between the prop's pick circle and the badge's rim, in the same units. */
const BADGE_GAP = 0.12;

/**
 * Which way the badge faces, as an XYZ Euler in radians — **a constant, not a billboard.**
 *
 * `cameraFor` moves the camera's *distance* with the panel shape and nothing else: `AZIMUTH`
 * and `ELEVATION` are compile-time constants, so the direction the camera looks from never
 * changes in this game. A mark that faces the camera can therefore be a clay object with a
 * fixed orientation in the room, baked into its geometry once, instead of a quaternion copied
 * off the camera every frame. That is the difference between an object and a sticker, and it
 * is also cheaper: the instance matrix is a translation and a uniform scale.
 *
 * Solved rather than dialled. three composes an XYZ Euler so that local `+Z` maps to
 * `(sin y, −sin x · cos y, cos x · cos y)`, and the camera sits along
 * `(cos EL · sin AZ, sin EL, cos EL · cos AZ)`. Equating the two:
 *
 *   `y = asin(cos EL · sin AZ)`,  `x = −asin(sin EL / cos y)`,  `z = 0`
 *
 * which at AZ 6° / EL 7° is `x = −7.037°`, `y = +5.956°`. Verified against three's own
 * `Matrix4.makeRotationFromEuler` to 1e-9.
 */
export const BADGE_ROT: readonly [number, number, number] = (() => {
  const y = Math.asin(Math.cos(ELEVATION) * Math.sin(AZIMUTH));
  const x = -Math.asin(Math.sin(ELEVATION) / Math.cos(y));
  return [x, y, 0];
})();

/**
 * Where each difference's badge lands — **derived from `SPOTS`, never hand-placed.**
 *
 * Round 4's SD2: the found marker was a `torusSoft(1, 0.15)` at radius 0.40–0.82 drawn *over*
 * the prop, and the audit photographed it hiding most of the towel and, at 3/3, obliterating
 * the duck and the whole shelf-and-window corner of both pictures. "The money shot of the
 * game" was the one frame in which the child could no longer see what they had found.
 *
 * So the badge goes *beside* the prop, at `spot.r + BADGE_R + BADGE_GAP` — the first distance
 * at which the two discs cannot touch. The direction is picked by search, not by hand, from a
 * fixed compass order, taking the first heading that
 *
 *   1. keeps the whole badge inside the **box's own outer silhouette** (`ROOM.w` × `ROOM.h`
 *      about the camera's aim point). Not the wider guaranteed-visible box: a badge is a chip
 *      laid on the picture, and a chip half off the edge of the picture reads as a rendering
 *      fault. `HALF_X`/`HALF_Y` are 10 % larger again, so anything inside the room is on
 *      screen at every panel shape this layout produces;
 *   2. keeps the badge clear of **every other** spot's pick circle, so a reward never covers a
 *      prop the child still has to examine; and
 *   3. keeps it clear of every badge already placed, because a run can have all five out at
 *      once — which is exactly the frame (`keyboard-end.png`, 3/3) the audit photographed as
 *      three rings obliterating the duck, the towel and the shelf-and-window corner.
 *
 * Up-and-right leads the order because the key is upper-left: a badge up-right of a prop sits
 * on the prop's own lit side rather than in its cast shadow. A search over eight headings on
 * five props is 40 comparisons at module load and it can be re-run by anyone; a hand-placed
 * table is five numbers nobody can check without a browser. DEV shouts if a prop has no legal
 * heading at all rather than silently shipping an overlap.
 */
const BADGE_HEADINGS: readonly (readonly [number, number])[] = [
  [0.707, 0.707], // up-right — the lit side
  [1, 0], // right
  [0.707, -0.707], // down-right
  [-0.707, 0.707], // up-left
  [0, 1], // up
  [-1, 0], // left
  [-0.707, -0.707], // down-left
  [0, -1], // down
];

export type Badge = { x: number; y: number; z: number };

/** Indexed to match `DIFFS` in `engine.ts`; `x`/`y` are at the prop's own `z`. */
export const BADGES: readonly Badge[] = (() => {
  const out: Badge[] = [];
  const limitX = ROOM.w / 2 - BADGE_R;
  const limitY = ROOM.h / 2 - BADGE_R;
  // Ordered by `diff`, so index i is DIFFS[i].
  const byDiff: Spot[] = [];
  for (const spot of SPOTS) if (spot.diff >= 0) byDiff[spot.diff] = spot;

  for (let i = 0; i < byDiff.length; i++) {
    const spot = byDiff[i];
    const reach = spot.r + BADGE_R + BADGE_GAP;
    let chosen: Badge | null = null;
    for (const [hx, hy] of BADGE_HEADINGS) {
      const x = spot.x + hx * reach;
      const y = spot.y + hy * reach;
      if (Math.abs(x - TARGET[0]) > limitX || Math.abs(y - TARGET[1]) > limitY) continue;
      let clear = true;
      for (const other of SPOTS) {
        if (other === spot) continue;
        if (Math.hypot(x - other.x, y - other.y) < other.r + BADGE_R) {
          clear = false;
          break;
        }
      }
      for (let p = 0; clear && p < out.length; p++) {
        if (Math.hypot(x - out[p].x, y - out[p].y) < 2 * BADGE_R) clear = false;
      }
      if (!clear) continue;
      chosen = { x, y, z: spot.z };
      break;
    }
    if (chosen === null) {
      // Never leave a difference without a mark: fall back to the first heading and say so.
      const [hx, hy] = BADGE_HEADINGS[0];
      chosen = { x: spot.x + hx * reach, y: spot.y + hy * reach, z: spot.z };
      if (import.meta.env.DEV) {
        console.error(
          `[spot/layout] no heading clears every other spot for "${spot.label}" — its found ` +
            `badge will overlap another prop's pick circle. Move the prop, shrink BADGE_R, or ` +
            `add a heading.`
        );
      }
    }
    out.push(chosen);
  }
  return out;
})();
