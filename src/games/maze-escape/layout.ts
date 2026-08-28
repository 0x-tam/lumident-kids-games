/**
 * Board metrics and camera framing. Pure numbers — no three, no React.
 *
 * The board is a **fixed world size at every level**: 3.8 units, 38 cm at product scale
 * (3D-SPEC §2), the size of a real tabletop maze toy. Only the cell pitch changes with the
 * level, so a 9-cell Easy maze has fat corridors and a 13-cell Hard maze has narrow ones,
 * and the camera never has to move between levels. Everything else — wall height, bevel,
 * the tooth, the toothbrush, the treats — is a fraction of the cell, so the whole board
 * scales as one object and nothing has to be re-tuned per level.
 *
 * Two numbers here are load-bearing and were solved, not chosen:
 *
 *  1. **Board size vs. the allowed camera band.** `GameShell` hands a game the whole shell
 *     interior, which is 0.48:1 on an upright phone. Fitting 3.8 units of width into that
 *     aspect at fov 30 needs 15.71 units of distance — just inside the 8–16 band 3D-SPEC §2
 *     allows, and 1.9 % *outside* it by 0.462:1. A larger board would crop the outer
 *     corridor off the screen on a phone, which is not a look problem, it is a "the child
 *     cannot reach that corridor" problem. `cameraFor` no longer has a single lever to pull
 *     there: it widens the lens toward §2's 32 first and, past that, shrinks the board.
 *     Nothing is cropped at any aspect down to 0.30:1 — see the solve's own note.
 *  2. **Wall height vs. camera elevation.** A wall of height `h` hides everything within
 *     `h / tan(elevation)` behind it. The tooth runs down the middle of a corridor, half a
 *     cell from the near wall, so `WALL_RATIO / tan(ELEVATION)` must stay below 0.5 or the
 *     hero prop spends the game peeking over a wall. At 60° and 0.55 cells that ratio is
 *     0.318, and at `TOOTH_RATIO = 0.8` the tooth's crown stands a quarter of a cell proud
 *     of the wall tops, so a child can follow it round a corner without losing it behind
 *     the gum.
 *  3. **The goal has to be legible from the far corner of the board.** A toothbrush that
 *     stands *inside* the wall line is not a goal, it is a coin: at 60° elevation only its
 *     end cap renders. So the brush is `BRUSH_HEIGHT` cells long, is planted at the lip of
 *     its dish rather than sunk into it, and leans `BRUSH_TILT` away from the camera so its
 *     bristle face turns up into the lens and its whole head clears the gum. The arithmetic
 *     is in the constants below; every one of them was solved against the wall line and
 *     against the tooth's resting volume, not chosen.
 */

export const BOARD = 3.8;

/** Thickness of the ivory slab the gum block is pressed into; its top is the corridor floor. */
export const BASE_T = 0.16;
export const FLOOR_Y = BASE_T;
/**
 * How far the slab's top face sits below the corridor floor.
 *
 * The floor mesh carries a hand-pressed micro relief that dips a couple of thousandths of a
 * unit below its mean height. Left at exactly `FLOOR_Y`, the slab underneath would be
 * co-planar with the bottom of every one of those dips and the pair would z-fight in a
 * shimmering speckle across the whole board. Dropping the slab is free — the only place its
 * top face is visible at all is the thin rim outside the gum block.
 */
export const SLAB_SINK = 0.008;

/** Wall height and corridor lip, as fractions of the cell pitch. */
const WALL_RATIO = 0.55;
const BEVEL_RATIO = 0.11;
/**
 * Tooth diameter as a fraction of the cell.
 *
 * Two hard limits and one legibility floor meet here. The corridor is one cell wide at the
 * height the tooth occupies — which is true because `buildGum` cuts it `wallSwell` wider than
 * a cell and the extrusion takes exactly that back, see `wallSwell`; it was **not** true
 * before, and that is the round-4 defect this constant sat on top of. The tooth rolls, so what
 * has to fit is its *support* along the direction of travel, not half its bbox: measured off
 * the shipped metaball surface plus the arm capsules (`scratchpad/verify/maze-hero.mjs`), that
 * is 0.4577 of the tooth's own height, i.e. 0.366 cells at `TOOTH_RATIO = 0.8`. Against a
 * half-cell that leaves **0.134 cells of clearance on each side**, which is what `BUMP_PUSH`
 * spends. And the hero has to be big enough to be a character rather than a pip: at 0.62 the
 * tooth measured ~25 px on a laptop-sized play area with a ~5 px face, which is not a hero, it
 * is a cursor. 0.8 also puts the crown a quarter of a cell above the wall tops, and is the
 * number `3.2 G-ME-2` asks for.
 */
const TOOTH_RATIO = 0.8;
/** The tooth's height in cells — the unit its support and its roll reach are expressed in. */
export const TOOTH_HEIGHT_CELLS = TOOTH_RATIO;

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

export const cellSize = (n: number) => BOARD / n;
export const wallHeight = (n: number) => clamp(cellSize(n) * WALL_RATIO, 0.15, 0.28);
/** 3D-SPEC §3's minimum bevel is 0.02 units; this never goes near it. */
export const wallBevel = (n: number) => clamp(cellSize(n) * BEVEL_RATIO, 0.022, 0.045);
/** How far the gum sinks below the corridor floor, hiding the extrusion's lower bevel. */
export const wallSink = (n: number) => wallBevel(n) + 0.03;
export const toothRadius = (n: number) => (cellSize(n) * TOOTH_RATIO) / 2;

/** Outer size of the gum block at its widest cross-section, inset inside the ivory slab. */
export const gumOuter = (n: number) => BOARD - 2 * (wallBevel(n) + 0.03);
export const boardCorner = (n: number) => Math.min(cellSize(n) * 1.15, 0.44);

/** Cell centre in world space. Row grows toward +Z (down-screen), column toward +X. */
export const cellX = (c: number, n: number) => (c + 0.5 - n / 2) * cellSize(n);
export const cellZ = (r: number, n: number) => (r + 0.5 - n / 2) * cellSize(n);

/** Fractional cell coordinates from a world point — the inverse of `cellX` / `cellZ`. */
export const worldToU = (x: number, n: number) => x / cellSize(n) + n / 2;
export const worldToV = (z: number, n: number) => z / cellSize(n) + n / 2;

/**
 * Shadow frustum: bound the board, not the world (3D-FOUNDATION-NOTES §8) — **derived**.
 *
 * `Rig` builds an ortho camera of `shadowArea / 2` half-extent, aimed down `KEY_LIGHT`'s own
 * direction with `up = +Y`, so what has to fit is the board's bounding box **rotated into the
 * light's basis**, not the board's world footprint. Projecting the eight corners of
 * `[-BOARD/2, BOARD/2] × [0, wallHeight(9) + brush] × [-BOARD/2, BOARD/2]` onto that basis
 * needs half-extents of **2.671 × 2.573** (`/tmp/shadow.mjs`, re-derivable from `KEY_LIGHT`
 * alone), and `BOARD + 1.4` gave 2.600 — so the shipped frustum **clipped the board's own
 * far corner by 0.071 units**, which is a cast shadow that stops in mid-air.
 *
 * ME2 asked for this to be *tightened*; the measurement says it has to grow, by 2.7 %. The
 * cost is 2.7 % of shadow-map texel density and the return is a shadow that reaches the whole
 * board. An ortho shadow projects a caster and its own shadow to the same light-space point,
 * so covering the casters covers everything they throw.
 *
 * The margin is one wall bevel at the coarsest pitch, which is the largest feature that can
 * stand outside the box this bound is computed from.
 */
const SHADOW_LIGHT_HALF = 2.671;
export const SHADOW_AREA = 2 * (SHADOW_LIGHT_HALF + 0.045);

/**
 * 3D-SPEC §3's minimum bevel, in world units, used here as the minimum clearance any prop
 * must keep from the gum. Nothing in this game may come closer to a wall than this.
 */
export const MIN_BEVEL = 0.02;

/**
 * How far the extrusion's bevel swells the gum into a corridor, in cells — and therefore how
 * much wider than one cell the corridor has to be *cut*.
 *
 * `ExtrudeGeometry` holds a contour at both caps and offsets it by `bevelSize` through the
 * middle, so a solid is **widest between its bevels**. Measured on the shipped mesh
 * (`scratchpad/verify/me-bevel.mjs`): the gum's outer contour sits at nominal at y = 0.0850
 * and y = 0.3922 and at nominal + `wallBevel` at every plane from 0.1300 to 0.3472. For a
 * *hole* that means the corridor is narrowest exactly where every prop in this game stands.
 *
 * This file assumed a one-cell corridor in three separate solves and did not include the
 * swell in any of them. Cut at nominal, the clear width was **0.787 cells** at 9 cells, and:
 *
 *  - the hero's arms (support 0.4577 of its own height, `maze-mascot.mjs`) stood **0.0115
 *    units** from the gum at rest against §3's 0.02 minimum bevel, and went 0.017–0.025 units
 *    *inside* it at the peak of every bump — invisible to `maze-bump.mjs`, which measured its
 *    wall gap against `cell / 2`;
 *  - the start ring ran under the gum by 0.0007–0.0017 units (ME5);
 *  - the toothbrush by 0.017 (ME1).
 *
 * `build.ts::buildGum` now cuts every carved contour `wallSwell` wider (`maze.ts::offsetLoop`),
 * so the extrusion gives back exactly what it takes and the corridor really is one cell
 * across at the height a prop occupies. **Verified on the built mesh, not modelled:**
 * `scratchpad/verify/me-corridor.mjs` measures the clear half-width at the first fully
 * swollen plane over 108 straight corridors at 9 / 11 / 13 cells and reports **0.5000** at
 * every one of them. The bevel itself is untouched, so §3's rolled lip is untouched.
 */
export const wallSwell = (n: number) => wallBevel(n) / cellSize(n);

/**
 * The corridor's clear half-width at the height a floor prop occupies, in cells.
 *
 * Exactly a half cell — and it is exactly a half cell **because** `buildGum` widens the cut by
 * `wallSwell`. The two are one decision; changing either without the other puts this file's
 * arithmetic back where round 4 found it.
 */
export const corridorClear = (_n: number) => 0.5;

/**
 * The toothbrush's alcove. `ALCOVE` is how far the bay is carved into the two border-wall
 * cells behind the goal, `GOAL_OFFSET` how far the brush stands diagonally into that bay —
 * far enough that the tooth, which comes to rest on the goal cell's own centre, never
 * shares space with it — and the dish is the well pressed into the floor beneath it.
 *
 * `GOAL_OFFSET` is 0.46 rather than 0.34, and it was solved rather than nudged. The brush is
 * a leaning object: at the height of the tooth's own equator its handle has swung back
 * `sin(BRUSH_TILT) × 0.52` cells toward the goal cell, so the base has to start further out
 * than the finished object appears to stand. Measured against the tooth's roll sphere —
 * radius `TOOTH_RATIO / 2` = 0.4 cells, since a tumbling tooth's greatest reach is half its
 * own height — an offset of 0.38 left the handle **inside** it by 0.059 cells and the arms
 * grazing it. 0.46 clears the body by 0.05 cells and the arms by 0.07 at every roll phase.
 *
 * ## `ALCOVE` 0.26 → 0.43, and why the old number could not have been right (ME1)
 *
 * The previous value carried a comment saying the bay was "deliberately *not* widened" to
 * follow `GOAL_OFFSET`, on the grounds that the gum between the bay and the board's rounded
 * corner would pinch. Both halves of that were wrong, and `scratchpad/verify/me-goal.mjs`
 * and `me-alcove-solve.mjs` measure it rather than argue it: they build the real filleted
 * outline `buildGum` extrudes, transform the real brush parts through the real
 * socket → stance → beckon chain over the whole beckon envelope, and ask of every vertex
 * whether it is inside the gum solid *including* `wallSwell`.
 *
 * At 0.26 — against the corridor as it was actually cut, i.e. before `wallSwell` was put
 * back — the brush was **0.017 units inside the east border wall** at 9 cells and 0.013 at 13:
 * the cream head sliced by the coral surface and the handle passing through the wall mid-span,
 * exactly as `maze-escape-rest.png` and `maze-escape-tier-low.png` show. Re-solved against the
 * widened cut, the feasible window is:
 *
 * | ALCOVE | penetration (worst of 9/11/13) | web to the board corner |
 * |---|---|---|
 * | 0.16 | **+0.0145 inside the gum** | 0.105–0.196 |
 * | 0.20 | −0.0017 (under `MIN_BEVEL`) | 0.091–0.176 |
 * | 0.26 | −0.0192 (under `MIN_BEVEL` at 13 cells) | 0.069–0.144 |
 * | **0.32** | **−0.0368** | **0.0444–0.109** |
 * | 0.40 | −0.0601 | **0.0116** (pinched) |
 *
 * So the window is `[0.268, 0.376]` — the lower bound where the brush stops touching the gum
 * by `MIN_BEVEL`, the upper where the web to the board's rounded corner falls below it. 0.32
 * is its midpoint, i.e. the value furthest from both failures, and it holds at 9, 11 and 13
 * cells and at both fillet resolutions (`arcSegs` 2 and 3, i.e. the low tier as well).
 *
 * The corner web survives because `filletLoop` cuts the bay's own outer corner back by
 * `r(√2 − 1)` as it rounds it — the fillet gives back most of what the extra depth costs.
 *
 * The dish is a **press, not a well** — `0.06` of a cell deep against 0.17 before. Its
 * old job was to seat a stub of a toothbrush; sinking anything into it is exactly the
 * mistake `3.2 G-ME-1` reported, because at 60° elevation a 60 %-buried object shows only
 * its end cap. Nothing sits in it any more, so all it has to do now is soften the seat and
 * pool a little warm occlusion around the pad.
 */
export const ALCOVE = 0.32;
export const GOAL_OFFSET = 0.46;

/**
 * The largest disc that fits in the bay around the socket, in cells, at the height a prop
 * standing on the floor occupies.
 *
 * Derived, not measured: the bay's east and south faces are cut at `1 + ALCOVE + wallSwell`
 * from the goal cell's own origin, the extrusion swells them back by `wallSwell`, and the
 * socket stands at `0.5 + GOAL_OFFSET`. `me-alcove-solve.mjs` binary-searches the same
 * quantity on the real filleted outline and agrees to three decimals (0.360 at 9, 11 and 13
 * cells).
 */
export const bayClear = (_n: number) => 0.5 + ALCOVE - GOAL_OFFSET;

/**
 * Radius of the mauve pad the brush stands on, in cells.
 *
 * It used to be a flat 0.34 and the audit photographed it half-buried in the gum, because
 * 0.34 is larger than the 0.19 cells the old bay actually had. It is now the bay's own clear
 * radius less `MIN_BEVEL`, capped at the authored size — so the pad is a coaster that fits
 * its alcove **by construction**, at every board size, and can never be re-buried by a change
 * to `ALCOVE`, `GOAL_OFFSET` or the bevel. Resolves to 0.313 / 0.302 / 0.292 cells.
 */
export const GOAL_PAD_MAX = 0.34;
export const goalPadRadius = (n: number) =>
  Math.min(GOAL_PAD_MAX, bayClear(n) - MIN_BEVEL / cellSize(n));

/**
 * The dish pressed into the floor under the pad, in cells.
 *
 * Deliberately larger than the pad and larger than `bayClear`: it is a depression in the
 * floor, not a prop, so the part of it that runs under the gum is simply covered — and it is
 * shallower than `wallSink` at every board size (0.025 against 0.075 at 9 cells), so it can
 * never open a gap under the wall's base. What the child sees is the ring of pressed clay
 * between the pad's rim and the gum.
 */
export const DISH_RADIUS = 0.46;
export const dishDepth = (n: number) => cellSize(n) * 0.06;

/**
 * Outer radius of the rose start ring, in cells — and its tube, which is a legibility floor
 * rather than a solve.
 *
 * ## ME5
 *
 * The ring was authored at major 0.34 + tube 0.055 = **0.395 cells** with a comment arguing
 * that this "finishes 0.395 of a cell from the centre, inside the corridor's own half-cell,
 * so it never runs under the gum". The corridor's half-width at the ring's own height is not
 * 0.5, it is `corridorClear` — 0.3934 at 9 cells and 0.390 at 11 and 13 — so the ring ran
 * **under** the gum by 0.0007 to 0.0017 units on every board, measured on the real outline by
 * `scratchpad/verify/me-ring.mjs`. That is the "arcs disappear into the wall base" the audit
 * photographed four times.
 *
 * The outer radius is now `min(authored, corridorClear − MIN_BEVEL)`, so the ring clears the
 * gum by the spec's own minimum at every board size and cannot be re-buried by a change to the
 * bevel, the corridor cut or the board pitch. With the corridor cut to its intended width
 * (see `wallSwell`) the clamp does **not** bind at any pitch this game ships — 0.5 − 0.0684 −
 * 0.055 = 0.377 against the authored 0.34 at 13 cells, the tightest — so the ring keeps the
 * size it was art-directed at and the clamp is a guarantee rather than a change. Re-measured
 * on the real outline: the ring's outer edge now stands **0.031–0.044 units clear** of the gum
 * (1.5–2.2 × `MIN_BEVEL`) against 0.0007–0.0017 units *inside* it before.
 *
 * **What this does not fix, honestly.** A ring lying on the floor next to a 0.55-cell wall
 * seen from 60° is partly hidden by that wall, because that is what a wall does: the wall top
 * occludes `wallHeight / tan(ELEVATION)` = 0.317 cells of floor behind it. Measured over ten
 * generated mazes per board size by ray-marching the ring's own surface against the gum solid
 * from the shipped camera, the hidden fraction falls from 27.2 / 28.4 / 38.7 % to
 * **22.6 / 14.4 / 8.8 %** at 9 / 11 / 13 cells — the corridor widening moved the wall away
 * from the ring, which is most of the gain. What is left is a wall doing what a wall does, and
 * the tooth, which stands 0.8 of a cell tall, is what the child actually looks for at the
 * start.
 */
export const RING_TUBE = 0.055;
export const RING_MAJOR_MAX = 0.34;
export const startRingMajor = (n: number) =>
  Math.min(RING_MAJOR_MAX, corridorClear(n) - MIN_BEVEL / cellSize(n) - RING_TUBE);

/* ------------------------------------------------------------------ */
/* The toothbrush                                                      */
/* ------------------------------------------------------------------ */

/**
 * Brush length along its own axis, in cells. The parts in `props.ts` are authored to add up
 * to exactly this, so the number here and the number on screen cannot drift apart.
 *
 * It was solved from the wall line, not chosen. The head occupies the top 30 % of the brush
 * (0.84–1.20 cells). Standing at `BRUSH_BASE_SINK` below the floor and leaning `BRUSH_TILT`,
 * the head's *lowest* point lands at 0.68 cells and its highest at 1.00, against a wall top
 * of `WALL_RATIO` = 0.55 — so the entire head, not merely its tip, reads above the gum from
 * anywhere on the board. At 0.65 cells (the old value) the whole brush finished at 0.21,
 * i.e. *below* the wall it stood between, which is why it photographed as a beige coin.
 */
export const BRUSH_HEIGHT = 1.2;

/**
 * Lean, in radians about world X. Negative tips the top toward −Z, i.e. away from the
 * camera and out over the goal cell.
 *
 * That direction is the whole point. The camera looks down the (0, sin 60°, cos 60°)
 * direction, so anything that faces the lens has to lean *back*. At −28° the bristle face
 * normal is (0, 0.469, 0.883), which is 32° off the view axis — the child sees the bristle
 * field, not a foreshortened sliver. Leaning the other way would have tipped it into the
 * border wall and shown the camera the back of the head.
 *
 * 28° rather than 45°: the lean costs height (`cos` of it), and the head has to clear the
 * gum. 28° keeps 88 % of the length as height and still turns the face up.
 */
export const BRUSH_TILT = -(28 * Math.PI) / 180;
/** A little turn off-axis so the brush reads as *placed* rather than installed. */
export const BRUSH_YAW = -0.3;
/** How far the brush's foot sits below the corridor floor, as a fraction of the dish. */
export const BRUSH_BASE_SINK = 0.5;
/** Foot of the brush in world Y — planted at the lip of its dish, not buried in it. */
export const brushBaseY = (n: number) => FLOOR_Y - dishDepth(n) * BRUSH_BASE_SINK;

/**
 * The tilt a flat prop needs to face a 60°-elevation camera.
 *
 * A disc whose normal is `t` from vertical is seen `ELEVATION − 90° + t` off-axis. At 45°
 * that is 15°, so a lollipop reads as a full circle rather than an ellipse — while still
 * standing at 45° instead of lying nearly flat on the floor, which is what a true 30°
 * camera-facing tilt would cost.
 */
export const FACE_TILT = Math.PI / 4;

/* ------------------------------------------------------------------ */
/* Camera                                                              */
/* ------------------------------------------------------------------ */

const FOV = 30;
/**
 * §2's fov ceiling. The solve widens toward it *before* it will crop anything — a wider lens
 * costs a little of the miniature reading, and cropping costs a corridor the child then
 * cannot reach.
 */
const FOV_MAX = 32;
const tanHalf = (fov: number) => Math.tan((fov * Math.PI) / 360);
const TAN_HALF_FOV = tanHalf(FOV);
const TAN_HALF_FOV_MAX = tanHalf(FOV_MAX);
/** Steep enough to read the maze as a plan, shallow enough that the walls have depth. */
export const ELEVATION = (60 * Math.PI) / 180;
/**
 * Breathing room between the fitted box and the edge of the clear frame, as a fraction of the
 * half-frame.
 *
 * This replaces the old `HEADROOM = 0.4` / `MARGIN = 0.12` pair, which were world-unit padding
 * on a flat box: `HEADROOM` existed to leave room for whatever stood up out of the board and
 * `MARGIN` for a rim of table around it. The fit is a projection now and the box it projects
 * already *contains* the toothbrush, so headroom is not a separate quantity any more — only
 * the rim is, and a rim is a screen-space fraction rather than a world distance. 0.06 of the
 * half-frame is what the old 0.12 units bought against a 1.9-unit half-board, so the framing
 * it produces on a laptop is the one that was reviewed.
 */
const FRAME_MARGIN = 0.06;
/**
 * Fallback height of `GameShell`'s title + HUD band, in CSS px. Only ever used as a
 * fraction of the rect.
 *
 * `GameShell` now publishes the *measured* band on the play area as `--chrome-h`, and
 * `MazeEscape.tsx` reads it and passes it in. This constant is only the value used before
 * that variable resolves (and if a future shell stops publishing it), so it stays at the
 * number the band actually measured.
 */
export const CHROME_PX = 138;
const MIN_DISTANCE = 8;
const MAX_DISTANCE = 16;

export type CameraFraming = {
  position: [number, number, number];
  target: [number, number, number];
  fov: number;
  /**
   * Uniform scale the board group must carry, ≤ 1.
   *
   * 1 in every framing that fits inside §2's bands. Below them the board is made smaller
   * instead of the camera being pushed past 16 units, because a board that is too small to
   * look impressive is a cosmetic problem and a board with a corridor off the edge of the
   * screen is an unwinnable one.
   */
  scale: number;
};

/**
 * The chrome's occupied rectangle in the play area's own pixels, as `GameShell` publishes it
 * (`--chrome-left/-top/-right/-bottom`). A9: the shell used to publish only a scalar height,
 * so every game reserved a full-width band whether or not the controls filled one.
 */
export type ChromeRect = { left: number; top: number; right: number; bottom: number };

/**
 * Everything that has to stay on screen, as a box in board space at `scale = 1`.
 *
 * `y` runs from the bottom of the ivory slab to the top of the toothbrush's head at the
 * *largest* cell pitch (9 cells), which bounds all three: `brushBaseY(9)` +
 * `BRUSH_HEIGHT × cos(BRUSH_TILT) × cellSize(9)` = 0.147 + 0.447. The tooth's crown reaches
 * 0.498 and the wall tops 0.392, both inside it.
 */
const FIT_HALF_XZ = BOARD / 2;
const FIT_Y_MIN = 0;
const FIT_Y_MAX = brushBaseY(9) + BRUSH_HEIGHT * Math.cos(BRUSH_TILT) * cellSize(9);

/**
 * Frames the board from the measured play-area rect.
 *
 * ## What this replaces, and why it was invisible (ME3)
 *
 * The solve this file has carried for three rounds is a *flat-box* fit: it fits
 * `BOARD/2 + MARGIN` of half-width and `(BOARD·sin E + HEADROOM)/2 + MARGIN` of half-height
 * against the frustum **at the aim plane**. A board seen at 60° is not at the aim plane: its
 * near edge stands `BOARD/2 · cos E` = 0.95 units closer to the camera and therefore projects
 * about 6.5 % larger at phone distances, which is the whole of the margin the flat model
 * carried. The solve is now the real question — *do the eight corners of the fitted box land
 * inside the clear part of the frame* — answered by projecting them, and the three levers run
 * in the same order (distance, then §2's 32° lens, then board scale).
 *
 * That was never the reason the phone frame was broken, though. **The camera solve was not
 * running at all**: `MazeEscape.tsx`'s measurement effect read `area.current` in a
 * `useLayoutEffect` and returned when it was null — which it always is, because React attaches
 * a host element's ref while walking *up* the tree, after its descendants' layout effects.
 * The effect was keyed on the identity-stable ref object, so it never re-ran, no
 * `ResizeObserver` was ever installed, and every session in every capture ran on the initial
 * `{ width: 0, height: 0, chrome: 138 }` — i.e. `aspect = 1`, `chrome = 0.2`, distance 9.169,
 * on a laptop and on a phone alike. Reconstructed from the round-4 captures, that model
 * predicts a projected board height of 560.6 px at 1440×900 (measured **564**), 471 px at
 * 1024×768 (measured **471**) and 534 px at 390×844 (measured **529**); the solve running
 * correctly would have predicted 313 px on the phone. `MazeEscape.tsx` now retries the way
 * `Scene3D` does.
 *
 * ## The chrome, as a rectangle (A9)
 *
 * `chrome` may be the shell's measured occupied rect rather than a scalar band. A corner of
 * the board is allowed to sit level with the title as long as it is not *under* it, which on
 * an upright phone is where the two outer corridors live. Passing a number keeps the old
 * behaviour — a full-width band — and is the documented fallback.
 */
export function cameraFor(
  width: number,
  height: number,
  chrome: number | ChromeRect = CHROME_PX
): CameraFraming {
  const w = width > 0 ? width : 1;
  const h = height > 0 ? height : 1;
  const aspect = w / h;

  // The keep-clear box, in NDC. A scalar chrome spans the full width, exactly as before.
  const band = typeof chrome === "number" ? (chrome > 0 ? chrome : CHROME_PX) : chrome.bottom;
  // Clamped: a landscape phone would otherwise report the chrome eating half the frame and
  // push the camera out past the far end of the allowed band.
  const clearFrac = 1 - Math.min(0.34, band / h);
  const keepTopNdc = 1 - 2 * (1 - clearFrac);
  const keepLeftNdc = typeof chrome === "number" ? -1 : (2 * chrome.left) / w - 1;
  const keepRightNdc = typeof chrome === "number" ? 1 : (2 * chrome.right) / w - 1;

  const sinE = Math.sin(ELEVATION);
  const cosE = Math.cos(ELEVATION);

  /**
   * Worst overflow of the fitted box beyond the clear frame, in NDC, for one candidate.
   * Negative is slack. Allocation-free: eight corners, no arrays.
   */
  const overflow = (r: number, tan: number, scale: number): number => {
    const shift = (1 - clearFrac) * r * tan;
    const ty = FLOOR_Y * scale + shift * cosE;
    const tz = -shift * sinE;
    const eyeY = ty + r * sinE;
    const eyeZ = tz + r * cosE;
    // Camera basis: forward (0, -sinE, -cosE), right (1, 0, 0), up (0, cosE, -sinE).
    let worst = -Infinity;
    for (let i = 0; i < 8; i++) {
      const x = (i & 1 ? 1 : -1) * FIT_HALF_XZ * scale;
      const y = (i & 2 ? FIT_Y_MAX : FIT_Y_MIN) * scale;
      const z = (i & 4 ? 1 : -1) * FIT_HALF_XZ * scale;
      const vy = y - eyeY;
      const vz = z - eyeZ;
      const depth = -(vy * sinE + vz * cosE);
      if (depth <= 0.05) return Infinity;
      const ndcX = x / (depth * tan * aspect);
      const ndcY = (vy * cosE + vz * -sinE) / (depth * tan);
      const overX = Math.abs(ndcX) - (1 - FRAME_MARGIN);
      // The top band is only out of bounds where the chrome actually sits.
      const overY =
        ndcX >= keepLeftNdc && ndcX <= keepRightNdc
          ? ndcY - keepTopNdc
          : ndcY - (1 - FRAME_MARGIN);
      const under = -(1 - FRAME_MARGIN) - ndcY;
      const worstHere = overX > overY ? (overX > under ? overX : under) : overY > under ? overY : under;
      if (worstHere > worst) worst = worstHere;
    }
    return worst;
  };

  /** Smallest distance in `[lo, hi]` at which nothing overflows, or `hi`. */
  const solveDistance = (tan: number, scale: number): number => {
    let lo = MIN_DISTANCE;
    let hi = MAX_DISTANCE;
    if (overflow(hi, tan, scale) > 0) return Infinity;
    if (overflow(lo, tan, scale) <= 0) return lo;
    for (let i = 0; i < 28; i++) {
      const mid = (lo + hi) / 2;
      if (overflow(mid, tan, scale) > 0) lo = mid;
      else hi = mid;
    }
    return hi;
  };

  let fov = FOV;
  let tan = TAN_HALF_FOV;
  let r = solveDistance(tan, 1);
  if (!Number.isFinite(r)) {
    fov = FOV_MAX;
    tan = TAN_HALF_FOV_MAX;
    r = solveDistance(tan, 1);
  }
  // Everything is inside §2's bands and the board still does not fit: shrink the board rather
  // than crop it. Bisection on the scale, because the projected size is monotone in it but not
  // linear once the box has depth.
  let scale = 1;
  if (!Number.isFinite(r)) {
    let lo = 0.2;
    let hi = 1;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (overflow(MAX_DISTANCE, tan, mid) > 0) hi = mid;
      else lo = mid;
    }
    scale = lo;
    r = MAX_DISTANCE;
  }

  const shift = (1 - clearFrac) * r * tan;
  const ty = FLOOR_Y * scale + shift * cosE;
  const tz = -shift * sinE;

  return {
    position: [0, ty + r * sinE, tz + r * cosE],
    target: [0, ty, tz],
    fov,
    scale,
  };
}

/**
 * The same projection `cameraFor` fits with, exposed so a self-test can grade a *shipped*
 * framing rather than re-deriving one. Returns the fitted box's NDC bounds.
 */
export function projectBoardBounds(
  framing: CameraFraming,
  aspect: number
): { minX: number; maxX: number; minY: number; maxY: number } {
  const tan = Math.tan((framing.fov * Math.PI) / 360);
  const sinE = Math.sin(ELEVATION);
  const cosE = Math.cos(ELEVATION);
  const [, eyeY, eyeZ] = framing.position;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < 8; i++) {
    const x = (i & 1 ? 1 : -1) * FIT_HALF_XZ * framing.scale;
    const y = (i & 2 ? FIT_Y_MAX : FIT_Y_MIN) * framing.scale;
    const z = (i & 4 ? 1 : -1) * FIT_HALF_XZ * framing.scale;
    const vy = y - eyeY;
    const vz = z - eyeZ;
    const depth = -(vy * sinE + vz * cosE);
    if (depth <= 0.05) continue;
    const ndcX = x / (depth * tan * aspect);
    const ndcY = (vy * cosE - vz * sinE) / (depth * tan);
    if (ndcX < minX) minX = ndcX;
    if (ndcX > maxX) maxX = ndcX;
    if (ndcY < minY) minY = ndcY;
    if (ndcY > maxY) maxY = ndcY;
  }
  return { minX, maxX, minY, maxY };
}
