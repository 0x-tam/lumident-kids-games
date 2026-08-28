/**
 * Board metrics for the Sliding Puzzle, and the camera solve.
 *
 * Pure numbers — importing this pulls in no three and no React, so the shell can frame the
 * scene without touching the 3D chunk's geometry code.
 *
 * Scale note (3D-SPEC §2): 1 world unit = 10 cm. The tray is a 37.8 cm square dish 3.4 cm
 * deep, and a 4x4 tile is a 6.7 cm clay chip 1.9 cm thick — a real object a child could
 * pick out of the tray, not a decal.
 *
 * Everything the tiles do is derived from `BOARD`, so 2x2, 3x3 and 4x4 all fill exactly
 * the same square of tray and the camera never has to move between levels.
 */

/** Side of the square the tiles occupy, whatever the level. */
export const BOARD = 3.0;
/** Board space in `relief.ts` is u,v in [-1, 1], so one board unit is `HALF` world units. */
export const HALF = BOARD / 2;

/** Groove between two tiles. The lattice bar that stands in it is narrower (see `BAR_W`). */
export const GAP = 0.08;

/* ------------------------------------------------------------------ */
/* The tray                                                            */
/* ------------------------------------------------------------------ */

export const WALL = 0.28;
/** Clay between the outermost tile and the well wall. */
export const WELL_MARGIN = 0.11;
export const TRAY_W = BOARD + 2 * WELL_MARGIN + 2 * WALL; // 3.78
export const TRAY_H = 0.34;

/**
 * Height of the tray's inner well floor — the plane the tiles rest on.
 *
 * `clayTray` derives it as `min(max(h * 0.3, baseRoll + 0.01), innerTop - 0.03)`; with
 * h = 0.34 and rim = 0.28 that resolves to 0.102 at every quality tier. The well wall
 * stands at 0.28 inward from the outer silhouette (inner half-width 1.61) and the rolled
 * lip flares back *out* to 0.2052 at the rim, so the opening is wider than the well and a
 * tile can never be pinched on its way down.
 */
export const WELL_Y = 0.102;

/* ------------------------------------------------------------------ */
/* A tile                                                             */
/* ------------------------------------------------------------------ */

export const TILE_T = 0.19;
/** Y of a tile's centre when it is sitting in the tray. */
export const REST_Y = WELL_Y + TILE_T / 2;

/** The printed panel: a thinner plate standing proud of the tile body's face. */
export const FACE_T = 0.05;
export const FACE_PROUD = 0.012;
/** Offset of the face plate along the tile's own thickness axis. */
export const FACE_DY = TILE_T / 2 + FACE_PROUD - FACE_T / 2;
/** Where a tile's relief starts, in tile-local space: flush with the face plate's top. */
export const RELIEF_Y = TILE_T / 2 + FACE_PROUD;

/**
 * Arc resolution for the three `roundedPlate`s this game builds — the tile body, its printed
 * panel and the reference plaque — passed explicitly instead of taking the tier's.
 *
 * **This is round 4's SP2, and the fix list has the mechanism wrong.** SP2 blamed
 * `bevelSteps: 2` on the relief. Built and counted (`scratchpad/sp/count.mjs`, driving the
 * real `boardRelief`/`plaqueRelief`), the whole relief of the worst picture at 4x4 is
 * **23,688** triangles of the captured 187,764 — 5 % — and stepping it to `bevelSteps: 1`
 * saves 12,112, which does not close the gap on the picture that actually breaches worst
 * (`family` at high tier: **208,586**, i.e. 15.9 % over, not 4.3 %).
 *
 * 81 % of the frame is these three plates. `roundedPlate` resolves `rectArcSegments(3) = 32`
 * segments **per corner quarter-arc** at the high tier, which is 3,164 triangles for a chip
 * whose corner radius is 9.7 screen px at 4x4 — a sagitta of **0.012 px**. The product's own
 * silhouette floor (`geometry.ts::MIN_SILHOUETTE_SEGMENTS`) is derived at half a pixel, and
 * its fillet floor (`MIN_FILLET_SEGMENTS`) at 0.54 px; this is 45x finer than either. It is
 * not quality, it is 90,000 invisible triangles.
 *
 * At `detail 1` the same plate is **828** triangles: 12 segments per corner arc and
 * `filletSegments(2) = 3` on the rim roll — the fillet floor exactly, not below it. Measured
 * sagitta of a tile corner at 12 segments, worst case over the three levels and the three
 * viewports in `docs`: **0.176 px** (2x2 on a laptop), against the 0.5-px bound both floors
 * are derived from. Nothing about the silhouette changes; §0 and §3 are untouched.
 *
 * Whole-scene effect at 4x4 on the worst picture, main pass + shadow submit:
 * **208,586 -> 94,122 (52.3 % of §9's 180,000)** at the high tier and 85,110 at mid/low.
 * `scene.tsx` counts the real geometries on every dev boot rather than trusting this comment.
 */
export const PLATE_DETAIL = 1;

/**
 * One grain variant for the whole game, sized to the clay rather than to the level.
 *
 * `materials.ts::grainScale` asks for 3-4 grain periods across the prop; the default 0.75-unit
 * tile puts *one* period across a 3x3 tile, which renders as a gradient rather than as the
 * fingerprinted clay §3 asks for. `3.5 * 0.75 / 0.92` (a 3x3 tile) is 2.85, and 2.6 is the
 * nearest value that keeps **two** octaves (`3 - round(log2 s)`), giving a 0.288-unit / 38-px
 * grain tile: 4.9 periods across a 2x2 tile, 3.2 across a 3x3, 2.3 across a 4x4.
 *
 * Deliberately one constant and not a function of `size`: grain is a property of the clay, not
 * of how many pieces it was cut into, and each distinct scale bakes its own shared 64 kB map.
 */
export const GRAIN_SCALE = 2.6;

/* ------------------------------------------------------------------ */
/* Registering the printed panel against the tile it is printed on     */
/* ------------------------------------------------------------------ */

/**
 * `geometry.ts::roundedPlate`'s own rim bevel, restated here.
 *
 * A `roundedPlate(w, h, t, r)` is `w x h x t` at its **widest**, which is a band around its
 * middle; its flat top face sits at `+t/2` and is only `w - 2 * bevel` across, because the
 * rim rolls inward as it rises. Three things in this game have to be registered against that
 * roll and until round 4 none of them knew the number:
 *
 *  - the **printed panel**, which was inset a flat `0.09` at every level (`scene.tsx`) while
 *    the tile's roll is `2 x 0.0665 / 0.1012 / 0.0737` at 2x2 / 3x3 / 4x4. So the panel spilled
 *    onto the roll at the two easy levels and left a bare ivory ring at the hard one — a
 *    constant measured against a size-dependent rim. `faceSize` derives it instead.
 *  - the **relief**, whose base plane is the panel's flat top and whose window is the tile's
 *    full footprint (see `windowHalf`), so its outermost `tileRim` stands over clay that has
 *    already started to roll away underneath it. `reliefSkirt` is what fills that.
 *  - the same pair on the **plaque**.
 *
 * These constants mirror `geometry.ts`'s private `MIN_BEVEL` and `PLATE_BEVEL_FRACTION`, so
 * they can drift. They are not left to drift: `scene.tsx` measures the flat top of the two
 * plates it actually built and reports a mismatch on every dev boot.
 */
const PLATE_MIN_BEVEL = 0.02;
const PLATE_BEVEL_FRACTION = 0.45;
const PLATE_MIN_T = PLATE_MIN_BEVEL / PLATE_BEVEL_FRACTION;

const clampTo = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** Half-width the rim of a `roundedPlate(w, w, thickness, cornerRadius)` eats off its top. */
export const plateRim = (w: number, thickness: number, cornerRadius: number): number => {
  const t = Math.max(thickness, PLATE_MIN_T);
  const corner = clampTo(cornerRadius, PLATE_MIN_BEVEL, w * 0.48);
  return clampTo(Math.min(t * 0.35, corner * 0.55), PLATE_MIN_BEVEL, t * PLATE_BEVEL_FRACTION);
};

/** The tile body's roll: 0.0665 / 0.0506 / 0.0369 at 2x2 / 3x3 / 4x4. */
export const tileRim = (size: number): number =>
  plateRim(tileSize(size), TILE_T, tileCorner(size));

/** The printed panel's own roll. `FACE_T` is thin enough that this is `PLATE_MIN_BEVEL` flat. */
export const faceCorner = (size: number): number => Math.max(0.021, tileCorner(size) - 0.02);
export const faceRim = (size: number): number =>
  plateRim(tileSize(size), FACE_T, faceCorner(size));

/**
 * Width of the printed panel, chosen so its flat top is **exactly** the tile's flat top.
 *
 * `panel - 2 * faceRim = tile - 2 * tileRim`. The picture and the paper it is printed on then
 * share one registration at every level: 1.327 / 0.859 / 0.636 against the old flat
 * `tile - 0.09` of 1.330 / 0.830 / 0.580.
 *
 * The panel's widest band sits at `TILE_T/2 + FACE_PROUD - faceRim` = 0.087, where the tile
 * body has already rolled in to 0.6734 / 0.4359 / 0.3196 of half-width against the panel's
 * 0.6635 / 0.4294 / 0.3181 — clearance **9.9 / 6.5 / 1.5 mm**, positive at every level and
 * smallest at 4x4 (all six figures measured off the built geometry, not derived). Lowering
 * `FACE_PROUD` buys clearance; raising it spends it, and `scene.tsx` asserts the sign.
 */
export const faceSize = (size: number): number =>
  tileSize(size) - 2 * (tileRim(size) - faceRim(size));

/**
 * How far a ground-layer relief piece extends **below** its own base plane.
 *
 * Round 4's SP3 photographed the consequence of not having this: the relief window is the
 * tile's full footprint (it has to be — see `windowHalf`), the relief's base plane is the
 * panel's flat top, and between the two there is a ring `tileRim + FACE_PROUD` deep where the
 * tile has curved away and the picture is standing on nothing. At 4x4 that is a 0.049-unit
 * (7.1 screen px) gap under the outermost 5.4 px of every motif that reaches a tile edge,
 * which is exactly the "motifs appear to hang off the tile into the tray well" read.
 *
 * The skirt takes the piece down to `TILE_T/2 - tileRim` — the *top of the tile's widest band*,
 * the one height at which the tile is its full `tileSize` across. A piece cut by the window at
 * `tileSize/2` then meets the tile's own silhouette flush, at every point of the perimeter, and
 * everywhere inboard of that the skirt is buried in the panel and the tile. (`buildRelief`
 * drops the bottom *cap* a further `bevel` below this, because a piece is only at its full
 * window width one bevel above its cap; see the note there.)
 * It costs no triangles at all (the ring count is unchanged; one ring moves down) and it does
 * not change any piece's *visible* wall, because the piece still emerges from the clay at the
 * same height it did before.
 *
 * Ground layer only. `relief.ts::ladder` gives every higher layer `lift > 0` and sinks it
 * `WORLD.embed` into the clay below, so nothing above layer 0 can float on a hairline either.
 */
export const reliefSkirt = (size: number): number => FACE_PROUD + tileRim(size);

/**
 * Depth budget.
 *
 * A tile's top sits at `WELL_Y + TILE_T` = 0.292 against a rim at 0.34, so an unmoved tile
 * is nested 4.8 mm below the lip — the "pressed into the tray" read. The relief then
 * stands proud of that, which breaks the rim line and stops the board looking like a
 * printed mat. Raising `TILE_T` past 0.238 would float the tiles above the rim and lose the
 * nesting; lowering it below ~0.12 makes them chips instead of tiles.
 *
 * **How proud is a composition question, not a modelling one.** At `ELEVATION` a point `h`
 * above the tile's face projects `h / tan(42°) = 1.111 h` toward the camera *relative to its
 * own tile* — so a piece standing 0.29 proud at the front edge of its window appears to
 * overhang the next tile by 0.322 world units, which at 4x4 (a 0.67-unit tile) is 48 % of the
 * tile in front. Chins hanging over tile edges and over the tray rim is exactly what stops a
 * piece reading as a self-contained object, which is the single idea this game runs on.
 *
 * That is the *only* thing this constant now decides. Round 3 had it deciding two things at
 * once — the overhang and how thick every individual piece of clay came out — and the second
 * job was being done badly enough that the brand critic measured the relief as flat cutouts
 * (see `relief.ts::ladder`, which has the numbers). Thickness is now derived in `relief.ts`
 * from a wall floor and a height budget, both stated in world units at this scale, and it is
 * asserted on every dev boot. So:
 *
 *  - **0.66 is the world-units-per-authored-unit rate**, and `relief.ts` sizes its ladder
 *    through it. Change it and the ladder rescales with it; the invariants move together.
 *  - The tallest element in any of the five pictures now stands **0.240** above the tile
 *    face — the budget, hit exactly by four of the five — for an apparent overhang of 0.267,
 *    **39.8 %** of a 4x4 tile against round 3's 31.7 %. It sits 0.544 above the table,
 *    0.204 clear of the 0.34 rim.
 *  - The *thinnest* element now shows **0.048** of its own side (the wall you can see above
 *    whatever it stands on), against round 3's 0.0053 — a median of 0.048 against 0.0198,
 *    i.e. 3.9 screen px of side where the median used to be 1.6 and the worst 0.4.
 *    Eight points of overhang bought every element in the product a visible silhouette.
 */
export const TILE_DEPTH_SCALE = 0.66;

/* ------------------------------------------------------------------ */
/* The lattice                                                         */
/* ------------------------------------------------------------------ */

/**
 * The grooves between cells are real raised clay bars, so every cell — including the empty
 * one — is a *pressed-in well* in the tray rather than a gap between floating tiles.
 * Narrower than `GAP` on purpose: 1.5 mm of clearance each side means a tile that is
 * wobbling from a nudge still never intersects a bar.
 */
export const BAR_W = 0.05;
export const BAR_H = 0.05;

/* ------------------------------------------------------------------ */
/* Motion                                                              */
/* ------------------------------------------------------------------ */

/** How far a tile lifts clear of the tray while it glides. Clears the rim by ~0.19. */
export const RISE = 0.3;

/* ------------------------------------------------------------------ */
/* Instance budgets — allocated once, never resized                    */
/* ------------------------------------------------------------------ */

export const MAX_TILES = 16;
/** `2 * (size - 1)` bars at the hardest level. */
export const MAX_BARS = 6;

/* ------------------------------------------------------------------ */
/* Grid maths                                                          */
/* ------------------------------------------------------------------ */

export const cellSize = (size: number): number => BOARD / size;
export const tileSize = (size: number): number => BOARD / size - GAP;
/** Small enough that a relief piece clipped to the tile square never overhangs its corner
 *  by more than 2 mm, large enough to stay clear of `roundedPlate`'s 0.02 minimum bevel. */
export const tileCorner = (size: number): number => (BOARD / size - GAP) * 0.1;

export const cellX = (pos: number, size: number): number =>
  ((pos % size) - (size - 1) / 2) * (BOARD / size);

export const cellZ = (pos: number, size: number): number =>
  (Math.floor(pos / size) - (size - 1) / 2) * (BOARD / size);

/**
 * Board space is v-up; the world is -Z-away. A cell's centre in board space, used to cut
 * that tile's window out of the continuous relief and to sample its patch of sky.
 */
export const cellU = (pos: number, size: number): number => ((pos % size) * 2 + 1) / size - 1;
export const cellV = (pos: number, size: number): number =>
  1 - ((Math.floor(pos / size) * 2 + 1) / size);

/** Half-extent of a tile's window, in board space. */
export const windowHalf = (size: number): number => tileSize(size) / 2 / HALF;

/**
 * How far the tiles pull together when the picture is finished: exactly enough to close
 * every groove, so the solved board is one continuous slab of relief rather than sixteen
 * chips that happen to line up.
 */
export const convergeFactor = (size: number): number => tileSize(size) / cellSize(size);

/* ------------------------------------------------------------------ */
/* The reference plaque                                                */
/* ------------------------------------------------------------------ */

/**
 * The finished picture, standing on a little clay ledge behind the tray — the 3D replacement
 * for the 2D game's thumbnail, and the only thing on screen that tells the child what they
 * are building.
 *
 * Round 2 shipped it at 1.15 units (38% of the board), parked at x = +0.98, with its base at
 * y = 0.05 and z = -2.2. Measured against a 42-degree camera, that put its bottom edge at
 * v = 1.509 while the tray's back rim tops out at v = 1.517 — so the reference picture was
 * *behind* the rim of the tray, and its lower third was occluded in every captured frame.
 *
 * Three things changed and each is load-bearing:
 *  - **Width 1.68**, 56% of `BOARD`, over the 55% floor the audit set.
 *  - **Centred on x = 0.** Off-centre, above a centred tray, is the composition that left
 *    half the frame as empty cream.
 *  - **Standing on a ledge**, whose top at y = 0.26 lifts the plaque's bottom edge clear of
 *    the rim — measured in true perspective, by 5 to 9 px at every viewport in `docs` — and
 *    whose width fills the band of frame either side of the plaque that used to be the empty
 *    half. It runs wider than the tray and bleeds off both edges on a phone, which is what a
 *    shelf does. It is a prop, not a wall: a fifth of the plaque's height, sitting far below
 *    its top, so it costs no frame height at all.
 *
 * Reclined 17 degrees rather than 30: the plaque's face is then 25 degrees off the camera's
 * axis (the tiles themselves are viewed at 42), which is more than square enough to read,
 * and every degree of recline costs frame height at `sin(ELEVATION)` — the mistake that made
 * the old plaque expensive as well as invisible.
 */
export const PLAQUE_W = 1.68;
export const PLAQUE_T = 0.09;
export const PLAQUE_TILT = 0.3;
export const PLAQUE_CORNER = 0.05;
/**
 * The plaque has the same registration problem the tiles do, in miniature: its relief window
 * is the whole picture (`half: 1`, i.e. the plaque's full `PLAQUE_W`) while the slab's flat
 * face is `PLAQUE_W - 2 * 0.0275` across. Same fix, same reasoning — see `reliefSkirt`.
 */
export const PLAQUE_RELIEF_SKIRT = plateRim(PLAQUE_W, PLAQUE_T, PLAQUE_CORNER);

/** The ledge the plaque stands on, and the tray's back edge it must clear. */
export const LEDGE_W = 4.6;
export const LEDGE_H = 0.26;
export const LEDGE_D = 0.5;
/** Its front face lands at −1.91: two centimetres clear of the tray's back face at −1.89,
 *  because two vertical faces at the same z is the same z-fight G-SP-2 was about. */
export const LEDGE_Z = -2.16;

const PLAQUE_BASE_Y = LEDGE_H;
const PLAQUE_BASE_Z = LEDGE_Z;
export const PLAQUE_POS: [number, number, number] = [
  0,
  PLAQUE_BASE_Y + (PLAQUE_W / 2) * Math.cos(PLAQUE_TILT),
  PLAQUE_BASE_Z - (PLAQUE_W / 2) * Math.sin(PLAQUE_TILT),
];
export const LEDGE_POS: [number, number, number] = [0, LEDGE_H / 2, LEDGE_Z];
/** Relief depths shrink with the plaque, or the miniature reads like a cake — and carry the
 *  tiles' own depth scale, so the reference picture is the same picture, only smaller. */
export const PLAQUE_DEPTH_SCALE = (PLAQUE_W / BOARD) * TILE_DEPTH_SCALE;

/* ------------------------------------------------------------------ */
/* Camera                                                              */
/* ------------------------------------------------------------------ */

/**
 * The shot.
 *
 * `GameShell` hands a game the whole shell interior — 1.15:1 on a laptop, 0.63:1 on a phone
 * held upright — and puts its own title and HUD across the top of it. This game puts a
 * "Moves" readout and a "Next picture" button across the bottom. Neither band is empty page:
 * the world runs full-bleed underneath both, which is what stops the panel reading as a card.
 * But the *subject* has to stay out of them, and round 2's solve budgeted for neither: the
 * tray's front lip landed 3% of the frame **past** the bottom edge at every size measured,
 * ran clean off the bottom at the low tier, and the "Moves: 0" text was drawn on top of the
 * tray. So the vertical solve here is expressed as a safe band with explicit margins rather
 * than as one hand-tuned half-height.
 *
 * The composition is a centred column — plaque above, tray below — so the horizontal solve is
 * just the tray plus a little air. `HALF_WIDTH` was 1.8 before, which is *narrower than the
 * tray's own half-width of 1.89*: the width constraint could not bind, and at phone aspect
 * the tray projected 122% of the frame width with its outer tiles cut off. That is not a look
 * problem, it is a "the child cannot reach that tile" problem.
 *
 * Both extremes below are measured along the camera's own up vector, where a point at (y, z)
 * projects to `y·cos(E) − z·sin(E)`. They are constants, not derived at runtime, because
 * nothing about them varies — but they are derived *from* the plaque and tray constants
 * above, and `docs`-free arithmetic is exactly how the old ones drifted out of date.
 */
const FOV = 28;
const TAN_HALF_FOV = Math.tan((FOV * Math.PI) / 360);
/** 42 degrees: reads as a plan of the grid, still shallow enough to see the tile edges. */
const ELEVATION = (42 * Math.PI) / 180;
const COS_E = Math.cos(ELEVATION);
const SIN_E = Math.sin(ELEVATION);

const upV = (y: number, z: number): number => y * COS_E - z * SIN_E;

/** The tray's front-bottom edge — the lowest point of the composition. */
const SUBJECT_BOTTOM_V = upV(0, TRAY_W / 2);
/** The top edge of the reclined plaque. */
const SUBJECT_TOP_V = upV(
  PLAQUE_BASE_Y + PLAQUE_W * Math.cos(PLAQUE_TILT),
  PLAQUE_BASE_Z - PLAQUE_W * Math.sin(PLAQUE_TILT)
);
const SUBJECT_MID_V = (SUBJECT_TOP_V + SUBJECT_BOTTOM_V) / 2;

/** The tray, plus 5 cm of table either side. */
const HALF_WIDTH = TRAY_W / 2 + 0.1;

/**
 * `GameShell` publishes the measured height of its title + HUD band as `--chrome-h` on the
 * play area. This is the fallback for a shell that does not, and the two must not drift far:
 * it is only ever used as a fraction of the rect.
 */
export const CHROME_PX = 138;
/** This game's own bottom row: `Moves: N` and the "Next picture" button. */
export const FOOTER_PX = 48;

/**
 * Air between the subject and the safe band.
 *
 * Two numbers per edge, and the larger wins, because the two failures they answer are not
 * the same shape:
 *
 *  - **As a fraction of the band** (`MARGIN_*`) the margin scales with how much room the
 *    composition was given, which is what keeps a laptop shot from looking cramped.
 *  - **As a fraction of the frame** (`MIN_*`) it is an absolute floor, which is what a
 *    collision is measured in. Round 3 photographed the phone HUD chips sitting on the
 *    reference plaque, and the band-relative top margin at 390x844 is
 *    `band 0.673 x 0.025 = 1.7 % of frame height`, i.e. **13 px** — a margin thin enough
 *    that any error in `--chrome-h` lands the plaque inside the chrome. `MIN_TOP_GAP_PX`
 *    makes that gap a real 24 px at every viewport.
 *
 * `MARGIN_BOTTOM` is the same defect on the other edge, and its own comment was the proof:
 * it claimed to clear "the audit's floor of 6 % of frame height under the tray's front lip"
 * while being 7.5 % **of the band**, which is `0.075 x 0.749 = 5.6 %` of the frame on a
 * laptop and `0.075 x 0.673 = 5.0 %` on a phone. It cleared the floor at no viewport in the
 * product. `MIN_BOTTOM_FRAC` is that floor, stated in the units the floor is written in.
 */
const MARGIN_TOP = 0.025;
const MARGIN_BOTTOM = 0.075;
/** The plaque's top edge may never come within this many pixels of the chrome band. */
const MIN_TOP_GAP_PX = 24;
/** The audit's floor: 6 % of frame height under the tray's front lip. */
const MIN_BOTTOM_FRAC = 0.06;
/** Neither floor may eat the band on a very short viewport. */
const MAX_TOP_PAD = 0.12;
const MAX_BOTTOM_PAD = 0.14;

const MIN_DISTANCE = 8;
const MAX_DISTANCE = 16;

/** A convenient point on the board to measure the aim shift from. */
const BASE_AIM_Y = 0.3;
const BASE_AIM_Z = -0.2;

export type CameraFraming = {
  position: [number, number, number];
  target: [number, number, number];
  fov: number;
};

export function cameraFor(width: number, height: number, chromePx = CHROME_PX): CameraFraming {
  const aspect = width > 0 && height > 0 ? width / height : 1;
  // Clamped: a landscape phone would otherwise report the chrome eating half the frame and
  // push the camera out past the far end of the allowed band.
  const chrome = height > 0 ? Math.min(0.34, Math.max(0, chromePx) / height) : 0.2;
  const footer = height > 0 ? Math.min(0.2, FOOTER_PX / height) : 0.1;
  const band = Math.max(0.3, 1 - chrome - footer);
  // Both edges: the band-relative margin or the absolute floor, whichever is larger, capped
  // so a very short viewport cannot leave nothing to frame the subject in.
  const topPad = Math.min(
    MAX_TOP_PAD,
    Math.max(band * MARGIN_TOP, height > 0 ? MIN_TOP_GAP_PX / height : MARGIN_TOP)
  );
  const bottomPad = Math.min(MAX_BOTTOM_PAD, Math.max(band * MARGIN_BOTTOM, MIN_BOTTOM_FRAC));
  const inner = Math.max(0.25, band - topPad - bottomPad);

  const forWidth = HALF_WIDTH / (TAN_HALF_FOV * Math.max(0.4, aspect));
  const forHeight = (SUBJECT_TOP_V - SUBJECT_BOTTOM_V) / (2 * TAN_HALF_FOV * inner);
  const raw = forWidth > forHeight ? forWidth : forHeight;
  const r = raw < MIN_DISTANCE ? MIN_DISTANCE : raw > MAX_DISTANCE ? MAX_DISTANCE : raw;

  // Where the middle of the composition has to land, as a fraction of the frame from the top,
  // and how far that is from the middle of the frame in world units at the target plane.
  const centreFrac = (chrome + topPad + (1 - footer - bottomPad)) / 2;
  const aimV = SUBJECT_MID_V - (0.5 - centreFrac) * 2 * r * TAN_HALF_FOV;

  // Applied along the camera's up vector (0, cos, −sin) so the framing shifts without
  // changing the angle. `BASE` is just a convenient point on the board to measure from.
  const shift = aimV - upV(BASE_AIM_Y, BASE_AIM_Z);
  const ty = BASE_AIM_Y + shift * COS_E;
  const tz = BASE_AIM_Z - shift * SIN_E;

  return {
    position: [0, ty + r * SIN_E, tz + r * COS_E],
    target: [0, ty, tz],
    fov: FOV,
  };
}

/**
 * Shadow frustum: bound the tray, not the world (FOUNDATION §8). The plaque and its ledge sit
 * behind it and neither cast nor receive — three more shadow-pass draw calls for a shadow
 * that falls backwards onto empty table, and widening the frustum to reach them would cost
 * every tile a third of its shadow resolution. Contact blobs ground them instead.
 */
export const SHADOW_AREA = 5.6;
