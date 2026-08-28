/**
 * Board metrics, shared by the shell (which needs the camera) and the scene (which needs
 * everything else). Pure numbers — importing this pulls in no three and no React.
 *
 * Scale note (3D-SPEC §2): 1 world unit = 10 cm, so a card here is a chunky 9 x 11.6 cm
 * slab 2 cm thick — a real object a small child can pick up in one hand, not a decal.
 *
 * Round-2 note. The cards were 7.2 x 9.5 cm and the camera solve bottomed out on
 * `MIN_DISTANCE`, so on a laptop the whole board was rendered 37 % smaller than the solve
 * had asked for. The prop is now sized for the distance band the spec allows (8–16 units)
 * rather than the camera being asked to close a gap it is not permitted to close.
 *
 * Round 3 gained nine points of frame fill without moving a card: the relief envelope the
 * camera reserves sky for is now `RELIEF_MAX_H` — a ceiling the relief fit *enforces* — in
 * place of a height measured off whichever motif happened to be tallest, and the far row's
 * relief point sits where a relief can actually stand rather than at the row's centre line.
 *
 * **Round 4: none of the framing numbers this header used to quote were ever rendered.**
 * They were correct about the solve and irrelevant to the product, because the caller fed
 * `cameraFor` a `0 x 0` rect on every viewport for the life of every mount — see
 * `CHROME_FALLBACK_PX` and the comment on `Board`'s measurement effect in `ToothMatch.tsx`,
 * where it is reproduced off the shipped pixels to three significant figures. The fill
 * percentages have been removed rather than restated: the only honest place for them now is
 * `?selftest=tooth-match-camera`, which measures the framing the game is actually given.
 */
import { COLS, PAIRS } from "./engine";

export const CARD_W = 0.9;
export const CARD_H = 1.16;
export const CARD_T = 0.2;
export const CARD_CORNER = 0.18;
export const GAP = 0.15;

export const PITCH_X = CARD_W + GAP;
export const PITCH_Z = CARD_H + GAP;

/**
 * A shallow clay tray. A card is 0.20 thick and sits with 0.12 of that inside the well, so
 * the lip frames the board without hiding the card edges that make the flip readable.
 */
export const TABLE_H = 0.34;
export const TABLE_RIM = 0.3;
/**
 * Height of the tray's inner well floor. `clayTray` derives it as
 * `min(max(h * 0.3, baseRoll + 0.01), innerTop - 0.03)`; with h = 0.34 and rim = 0.3 that
 * resolves to 0.102 for every board size we build, independent of the quality tier. It
 * stays 0.102 only while `TABLE_H`/`TABLE_RIM` are unchanged and `min(w, d) >= 1.34` (below
 * that the rim is clamped by `halfMin * 0.45` and the derivation moves) — both hold for
 * every level.
 */
export const WELL_Y = 0.102;
/**
 * A felt-style inlay covering the well floor, so the cards sit on a surface, not a void.
 *
 * 0.16, not 0.105. It is the *depth budget* below a resting card (see the sum under
 * `FRONT_PROUD`), and G-TM-5 needed that budget: the medallion's rim roll had to grow from
 * 0.0588 to 0.10 to clear 10 px at Hard, the pressed relief has to keep standing 0.024 proud
 * of the medallion, and both of those point straight down into this mat when a card is face
 * up. Raising the mat rather than the tray keeps `WELL_Y` at the 0.102 `clayTray` derives
 * from an unchanged `TABLE_H`/`TABLE_RIM` — the one number in this file that is a
 * *restatement* of a shared derivation rather than a choice. The rim still frames the
 * board: it covers the lower 0.066 of every card edge.
 */
export const MAT_T = 0.16;
/** Top of the mat — the plane the cards rest on. */
export const MAT_Y = WELL_Y + MAT_T;

/*
 * Depth budget.
 *
 * A card is not a flat slab: a raised panel stands proud of its printed face, and a red
 * medallion with a pressed diamond band stands proud of the other. Whichever way up the card
 * lies, one of those reliefs points at the mat — and a matched pair is then pressed a
 * further `PRESS_DROP` into it. These numbers are chosen together so that the *resting*
 * cases — the ones that persist and can be looked at — clear the tray's own well floor:
 *
 *   MAT_T + FRONT_PROUD − EMBLEM_PROUD − PRESS_DROP  =  0.16 + 0.012 − 0.124 − 0.028
 *                                                    =  0.02 > 0
 *
 * Change one and re-check that sum, or a card will sink through the table. G-TM-5 changed
 * two of them at once: the medallion's roll had to reach 0.10 to be legible at Hard, which
 * carried `BACK_PROUD` and therefore `EMBLEM_PROUD` up with it, and `MAT_T` is what paid
 * for the extra depth. The margin went from 0.007 to 0.02, so the budget is looser than it
 * was, not tighter.
 *
 * The *transient* wind-up is a separate matter and is deliberately not budgeted for.
 * `anticipate(k, 0.14)` swings a face-up card 25 degrees the wrong way while `FLIP_DIP`
 * presses it 0.05 into the table, and at that instant the card's own leading corner is
 * already 0.012 below the tray's base — the emblem going with it changes nothing. Both are
 * fully enclosed in opaque clay (mat, then tray body) for the 70 ms it lasts (round 3 shortened
 * it from 104; see `WINDUP_S` in `scene.tsx`), seen from a camera 42 degrees above; that dip
 * *is* the "presses into the table first" read.
 */
export const FRONT_PROUD = 0.012;
/**
 * How far the back medallion stands out of the card body.
 *
 * Equal to `BACK_ROLL`, deliberately: the whole visible height of the medallion is then
 * roll, so there is no flat cylindrical rim face left to read as a cut edge, and the roll
 * the child sees is the full radius rather than the shallow top of it.
 */
export const BACK_PROUD = 0.1;
/**
 * How far the pressed relief stands out of the *card*, and therefore 0.024 — 2.4 mm — beyond
 * the medallion it is pressed into.
 *
 * It was 0.066, i.e. 0.008 proud of the medallion. That is 0.8 mm, and the previous comment
 * here called it "0.8 cm", which is where the mistake hid. At 179 px per world unit (Easy,
 * 900x700) 0.8 mm is 1.4 px of relief, and because `beveledExtrude` rolls the rim over
 * `EMBLEM_BEVEL` = 0.026, only the outermost 0.0072 of that roll was above the medallion —
 * a 0.8 px shading band. It was reading as printed colour, not as a crown, which is half of
 * what G-TM-5 asked for.
 *
 * At 0.082 the visible protrusion is 0.024 and the rim roll is 0.026, so *the entire visible
 * height of the relief is roll*: it is a rolled ridge sitting on the medallion, not a plate
 * with a lip. Visible shading band 0.0206 wide ≈ 3.7 px at Easy, 2.3 px at Hard.
 *
 * Written as `BACK_PROUD + 0.024` rather than as a literal so the 2.4 mm survives the
 * medallion growing: G-TM-5 moved `BACK_PROUD` from 0.058 to 0.1 and a hard-coded 0.082
 * would have put the relief *below* the medallion it is pressed into. `MAT_T` carries the
 * matching 5.5 mm of extra depth budget, so the sum above still clears by 0.024.
 */
export const EMBLEM_PROUD = BACK_PROUD + 0.024;

/** Y of a card's centre at rest, how far a matched card is pressed, and where it lands. */
export const REST_Y = MAT_Y + CARD_T / 2 + FRONT_PROUD;
export const PRESS_DROP = 0.028;
export const PRESS_Y = REST_Y - PRESS_DROP;

/* Part sizes and offsets along the card's own thickness axis (card space +Y = the face). */

/** The printed panel on the face. Inset all round so the ivory body reads as a frame. */
export const INLAY_INSET = 0.2;
/*
 * 0.02 / 0.45 is `geometry.ts`'s `MIN_PLATE_THICKNESS` — `MIN_BEVEL / PLATE_BEVEL_FRACTION`,
 * the thinnest plate that can carry 3D-SPEC §3's hard 0.02 minimum bevel on both faces.
 *
 * This used to read 0.036. `roundedPlate`'s clamp then resolved the bevel to 0.0162 and said
 * nothing, which is the razor-straight seam round 3 photographed across the bottom of every
 * face-up card (A20). Round 3 made `roundedPlate` refuse a thickness it cannot bevel — it
 * raises the plate and logs an error naming the caller — so leaving 0.036 here would ship a
 * `console.error` on every Tooth Match mount *and* leave `INLAY_DZ` solving against a
 * thickness the geometry does not have: the panel would stand 0.0162 proud of the card face
 * instead of the 0.012 `FRONT_PROUD` asks for. Written as the expression rather than as
 * 0.0444 so it stays exactly equal to the constant it has to clear.
 *
 * The extra 0.0084 of thickness goes backwards, into the card's own 0.2 body — `INLAY_DZ`
 * below is solved from the front face, so the front face does not move.
 */
export const INLAY_T = 0.02 / 0.45;
export const INLAY_DZ = CARD_T / 2 + FRONT_PROUD - INLAY_T / 2;

/**
 * Half-extents of the printed panel — the surface a relief actually stands on.
 *
 * `INLAY_INSET` is taken off the card's *full* width and depth (see the `roundedPlate` call
 * in `scene.tsx`), so the panel is 0.70 x 0.96 and these are 0.35 / 0.48 against the card's
 * own 0.45 / 0.58. The 0.10 / 0.10 difference is the ivory frame.
 *
 * They exist because round 4 measured the relief fit solving against the *card* and then
 * claiming, in prose, that it had solved against the panel — see `RELIEF_HALF_X`.
 */
export const PANEL_HALF_X = (CARD_W - INLAY_INSET) / 2;
export const PANEL_HALF_Z = (CARD_H - INLAY_INSET) / 2;

/**
 * The medallion on the back — the motif that tells a child what a card is while it is face
 * down, so its rim roll is the one shading gradient the whole card back has.
 *
 * **Why it is no longer a `roundedPlate`.** That builder derives its roll rather than
 * taking it: `min(max(0.02, min(t * 0.35, corner * 0.55)), t * 0.45)`. The only way to a
 * 0.10 roll through it is `t >= 0.286`, and a 0.286-thick plate seated `BACK_PROUD` out of
 * a 0.2-thick card pushes its far face to 0.086 in card space — 0.010 under the printed
 * inlay's underside at 0.076, i.e. two near-coplanar caps and the z-fight that G-SP-2
 * documented on the sliding puzzle's hair. `roundedBox` takes the radius directly, so the
 * roll and the thickness stop being the same number: a 0.24-thick pad with a 0.10 roll
 * lands its far face at 0.04, a clear 0.036 below the inlay.
 *
 * **Why 0.10.** G-TM-5 measured the roll at 0.0588 → 10.0 / 7.7 / 6.3 px at Easy / Medium /
 * Hard on a 900x700 play area with 132 px of chrome, against a 10 px floor. The camera
 * solve fills the same frame band at every level, so the board's *screen* size barely
 * changes and the roll has to grow in world units to cover the extra rows. Projecting the
 * solved camera at the same framing: **16.8 / 13.0 / 10.6 px**. Hard is the binding level
 * and it clears with 6 %.
 *
 * `roundedBox` clamps the radius to 0.9 of the smallest half-extent, which is the depth's:
 * 0.24 / 2 * 0.9 = 0.108, so 0.10 is taken as written. Most of the pad is buried inside the
 * card body; what stands out is the 10 mm `BACK_PROUD` dome.
 */
export const BACK_INSET = 0.16;
export const BACK_T = 0.24;
export const BACK_ROLL = 0.1;
export const BACK_DZ = -(CARD_T / 2 + BACK_PROUD - BACK_T / 2);

/**
 * The diamond band pressed into the medallion. See `emblemShape` in `motifs.ts` for why it
 * is a band and not the six-lobed rosette round 4 photographed competing with the star card.
 *
 * It is deliberately large — 0.676 x 0.910 built, 91 % of the 0.74 x 1.00 medallion — because
 * it is doing two jobs. It is the card back's pattern, and it is the *crown* that stops the
 * medallion being one plane with one normal: a continuous rolled ridge across 31 % of the
 * panel's area gives the face a shading gradient and a curvature-AO line that a flat plate
 * cannot have, and its hole is a 2.4 mm groove down to the medallion — a stitch line.
 *
 * `EMBLEM_DEPTH` is the flat core and `EMBLEM_BEVEL` the roll on each face, so the solid is
 * 0.084 thick and 0.06 of it is buried in the medallion. See `EMBLEM_PROUD` for why the
 * 0.024 that is not buried is entirely roll.
 */
export const EMBLEM_DEPTH = 0.032;
export const EMBLEM_BEVEL = 0.026;
export const EMBLEM_DZ = -(CARD_T / 2 + EMBLEM_PROUD) + (EMBLEM_DEPTH + 2 * EMBLEM_BEVEL) / 2;

/** Where a motif's base sits: just clear of the raised front panel. */
export const MOTIF_DZ = CARD_T / 2 + FRONT_PROUD + 0.003;

/* ------------------------------------------------------------------ */
/* The relief-fit contract                                             */
/* ------------------------------------------------------------------ */

/**
 * The camera's elevation, and the two trig values every screen-space derivation in this
 * file and in `motifs.ts` is built on. Exported because the relief fit below is a
 * *screen-space* problem: a card lying flat is foreshortened and a relief standing on it is
 * not, so the only honest way to size one against the other is in the camera's own frame.
 */
export const ELEVATION = (42 * Math.PI) / 180;
export const ELEV_SIN = Math.sin(ELEVATION);
export const ELEV_COS = Math.cos(ELEVATION);

/**
 * Screen-up coordinate of a point in card space, relative to the card's own centre.
 *
 * The camera looks down the elevation ray, so its up vector is `(0, cos E, -sin E)`: a
 * point `(y, z)` in the card's frame lands `y·cos E - z·sin E` above the card centre on
 * screen. This is an *orthographic* measure and the relief always sits nearer the camera
 * than the card face it stands on, so it is magnified slightly more than this says —
 * `11 / (11 - 0.35·sin E) = 1.021`, i.e. 2.1 % at the shipped distance band. `RELIEF_MARGIN_U`
 * below is 7.7 % of the card's half-extent, so it covers that with 3.6x to spare.
 */
export const screenUp = (y: number, z: number): number => y * ELEV_COS - z * ELEV_SIN;

/**
 * Half the screen-up extent of a card's own face: `(CARD_H / 2)·sin E` = **0.3881**.
 *
 * This is the number round 3 photographed being broken. A relief standing upright on the
 * card converts its height to screen-up at `cos E` = 0.743, while the card converts its
 * *length* at `sin E` = 0.669 — so an upright relief only 0.52 units tall already reaches
 * the card's far edge, and the shipped ones were `RELIEF_H x MOTIF_SCALE` = 0.48 x 1.42 with
 * their bases pinned to the card's centre.
 *
 * Projecting each old motif's real bounding box through `screenUp`: the brush's top landed at
 * 0.625, the apple's at 0.750, the star's at 0.697 — against 0.3881. Between **33 % and 43 %**
 * of every relief's screen extent stood above the far edge of its own card (the fix list's
 * 30 % is the same defect estimated without the `MOTIF_DZ` base offset). Photographed in
 * `tooth-match-f05.png`, top row: the star and the paste tube.
 */
export const CARD_HALF_U = (CARD_H / 2) * ELEV_SIN;

/** Clear screen-up band kept between a relief and the card edge, each side. */
export const RELIEF_MARGIN_U = 0.03;
/** The screen-up band a relief may occupy on its own card. */
export const RELIEF_U_SPAN = 2 * (CARD_HALF_U - RELIEF_MARGIN_U);

/**
 * The reveal pop's overshoot factor, and the reason every budget below is divided by it.
 *
 * ## The defect (TM5)
 *
 * `fitRelief` solves a `scale` and asserts the result fits the card. `scene.tsx` then renders
 * the relief at `easeOutBack(faceOut, MOTIF_POP_BACK) * scale` — and `easeOutBack` overshoots.
 * So the number the fit checked is not the number the child sees: for the ~90 ms around the
 * peak of every reveal, every relief on the board is **8.98 % larger** than anything asserted.
 *
 * Measured on the shipped vertex buffers, that is exactly the frame round 4 photographed: the
 * star's half-width is 0.3384 at rest — inside the 0.35 panel — and **0.3688 at the pop**,
 * which is 5.4 % past the printed panel's edge and out over the ivory rim, with its base
 * floating 0.015 above the ivory it is standing over. (The audit's stronger reading, that the
 * tip leaves the card and lands on the tray channel, is arithmetically impossible and is
 * disproved: 0.3688 against the card's own 0.45 and the tray channel beyond 0.45. Nothing
 * here reaches the tray.)
 *
 * ## Why it is derived rather than typed
 *
 * `easeOutBack(t, s) = 1 + (s+1)u³ + su²` with `u = t − 1`. Its extremum is where
 * `3(s+1)u² + 2su = 0`, i.e. `u* = −2s / (3(s+1))`, and the peak is that value substituted
 * back. Written as the arithmetic so a change to `MOTIF_POP_BACK` moves the budget with it;
 * `scene.tsx` imports `MOTIF_POP_BACK` for the ease itself and asserts the two agree in DEV,
 * so the curve and its budget cannot drift apart.
 *
 * Note the card's own squash is deliberately **not** in here. `scene.tsx` scales the card
 * group and the relief group is its child, so a squash scales the card and everything on it
 * by the same factor — the relief's size *relative to its card* does not move, and relative
 * is the only thing these bounds are about.
 */
export const MOTIF_POP_BACK = 1.6;
const POP_U = (-2 * MOTIF_POP_BACK) / (3 * (MOTIF_POP_BACK + 1));
export const RELIEF_POP_PEAK =
  1 + (MOTIF_POP_BACK + 1) * POP_U * POP_U * POP_U + MOTIF_POP_BACK * POP_U * POP_U;

/**
 * Clear band kept at each side of the **printed panel**, so a relief never stands out over
 * the ivory rim.
 *
 * This used to read `CARD_W / 2 - 0.045` = 0.405, with the comment above it claiming it kept
 * the relief off the ivory rim. It did the opposite: the ivory rim *starts* at
 * `PANEL_HALF_X` = 0.35, so 0.405 sits 0.055 inside it and the bound licensed exactly the
 * overhang it said it prevented. Two motifs used it — the star to 0.3384 and the floss to
 * 0.3117 — and a relief past 0.35 has its base 0.015 above the ivory it hangs over, because
 * `MOTIF_DZ` is measured from the panel's top face and the ivory is a panel-thickness lower.
 *
 * 0.02 of margin, not 0.045: the bound is now the panel's edge rather than the card's, and
 * the panel's own rim roll is `MIN_BEVEL` = 0.02, so a relief that clears the roll clears the
 * panel. The ivory frame is 0.10 wide either side and is itself the visual margin.
 */
export const RELIEF_MARGIN_X = 0.02;
export const RELIEF_HALF_X = PANEL_HALF_X - RELIEF_MARGIN_X;
/**
 * How far inside the **panel's** own edges a relief's footprint has to stay, near and far.
 *
 * Screen-up containment alone would let a tall relief stand with its base hanging past the
 * card's lip: invisible from this camera, but no longer standing on the surface it belongs
 * to. These were measured from `CARD_H / 2`, which put the near bound at 0.56 — 0.08 past
 * the panel's 0.48 — and every one of the eight motifs was pinned to it, so every relief in
 * the game had its near footprint standing on (or over) the ivory frame rather than on the
 * printed field. They are measured from the panel now, which is the surface `MOTIF_DZ` is
 * derived from.
 *
 * The two clearances are **not** the same number, and the asymmetry is the key light's. `Rig`
 * puts the key at `(-4, 7, 5)` — above, to the left, and on the *viewer's* side of the board
 * — so every cast shadow falls to +x and −z, i.e. away from the camera. A relief's shadow
 * therefore lands on the card *behind* it, which is why the far edge is the one that needs
 * real clearance and the near edge only needs enough not to look like it is falling off.
 * Giving the near edge the far edge's margin cost 19 % of the fitted scale on the tooth for
 * a shadow that is not on that side.
 */
export const RELIEF_NEAR_CLEAR = 0.02;
export const RELIEF_FAR_CLEAR = 0.07;
export const RELIEF_NEAR_Z = PANEL_HALF_Z - RELIEF_NEAR_CLEAR;
export const RELIEF_FAR_Z = PANEL_HALF_Z - RELIEF_FAR_CLEAR;
/**
 * The same two clearances against the **card**, for the relief's whole silhouette rather
 * than its footprint.
 *
 * A physical object standing on a printed panel is allowed to overhang it — a cup's rim is
 * wider than its foot — so bounding every vertex to the panel would be a 12–18 % cut in every
 * relief on the board to prevent something that is not wrong. What is wrong is a *base*
 * hanging off the panel, because `MOTIF_DZ` is measured from the panel's top face and the
 * ivory frame is a panel-thickness lower: that base floats. So `fitRelief` bounds the
 * footprint (the vertices in the bottom `MOTIF_FOOT_BAND` of the motif's height) against the
 * panel and the full silhouette against the card, and both at the reveal pop.
 */
export const SILHOUETTE_NEAR_Z = CARD_H / 2 - RELIEF_NEAR_CLEAR;
export const SILHOUETTE_FAR_Z = CARD_H / 2 - RELIEF_FAR_CLEAR;
/** Fraction of a motif's height that counts as its footprint. */
export const MOTIF_FOOT_BAND = 0.15;

/**
 * The tallest a fitted relief may stand above the card face, in world units.
 *
 * Not a taste value: it is the term `cameraFor` reserves sky for, so it has to be a number
 * the art cannot exceed rather than a number measured off the art (`RELIEF_H = 0.48` was
 * the latter, and it was already 0.03 out — the apple measures 0.451, not the 0.466 its
 * comment claimed). `motifs.ts` fits every relief to `min(u-span, width, this)` and asserts
 * the result, so a future motif can only ever be *shorter* than what the camera reserved.
 *
 * 0.66 is 6.6 cm of clay standing on an 11.6 cm card — the largest prop that still leaves
 * the card reading as the thing underneath it, and it binds for the brush. Measured against
 * the solved camera at 900x700 with 132 px of chrome, the eight reliefs come out **90–105 px**
 * tall, filling **55–66 %** of their own card's screen height.
 *
 * Round 4: this is a ceiling on the relief at the **top of its reveal pop**, not at rest —
 * `fitRelief` divides by `RELIEF_POP_PEAK` — so what `cameraFor` reserves sky for is now what
 * the tallest instant actually needs. Before that it was exceeded by 8.98 % on every flip.
 */
export const RELIEF_MAX_H = 0.66;

/** Largest deal, so instance buffers are allocated once and never resized. */
export const MAX_CARDS = PAIRS[PAIRS.length - 1] * 2;

/* ------------------------------------------------------------------ */
/* Tap target                                                          */
/* ------------------------------------------------------------------ */

/**
 * Half-width of a card's invisible collider, before `HitTarget`'s 48 px growth.
 *
 * It lives here rather than in `scene.tsx` because the camera solve has to reserve frame for
 * the focus ring this radius sizes, and the two must not drift apart — see `reachFor`.
 *
 * `CARD_W * 0.55` = 0.495 is 94 % of the 1.05 column pitch, i.e. a 3 % clear gap each side,
 * and round 3 filed that as too close. Reproduced and it is: the number is right. What the
 * arithmetic does *not* support is the conclusion. The collider is a sphere and both
 * neighbours in a row sit at the same depth, so the ray's first hit is always the sphere
 * whose centre is nearest the pointer — the boundary is the perpendicular bisector, which is
 * the midpoint between the two cards, which is correct. Between *rows* the near card is
 * nearer the camera and would win an overlap, but at this radius the projected circles
 * overlap the neighbouring card's own screen footprint by 0.006 units — 0.8 % of a card's
 * screen height — because a row's 1.31 pitch projects to `1.31 * sin 42 = 0.877` against a
 * 0.99 collider diameter.
 *
 * So the clamp is written down rather than the radius changed: `0.48 x` the tighter pitch,
 * which 0.495 already satisfies (`0.48 * 1.05 = 0.504`), so that a future change to
 * `CARD_W`, `GAP` or this factor cannot quietly cross it. The growth past this point is
 * `minScreenPx: 48`, which is 3D-SPEC §1.5's floor and is not this game's to weaken.
 */
export const HIT_RADIUS = Math.min(CARD_W * 0.55, 0.48 * Math.min(PITCH_X, PITCH_Z));
/** 3D-SPEC §8's tap floor, in CSS px. The value `scene.tsx` hands `HitTarget`. */
export const TAP_FLOOR_PX = 48;

export type Grid = { cols: number; rows: number; width: number; depth: number };

export function gridFor(level: number): Grid {
  const cols = COLS[level];
  const count = PAIRS[level] * 2;
  const rows = Math.ceil(count / cols);
  return {
    cols,
    rows,
    width: cols * CARD_W + (cols - 1) * GAP,
    depth: rows * CARD_H + (rows - 1) * GAP,
  };
}

export const cardX = (index: number, grid: Grid): number =>
  ((index % grid.cols) - (grid.cols - 1) / 2) * PITCH_X;

export const cardZ = (index: number, grid: Grid): number =>
  (Math.floor(index / grid.cols) - (grid.rows - 1) / 2) * PITCH_Z;

/**
 * Outer size of the tray: the grid plus a hand's width of clay.
 *
 * 0.88, not the old 1.0. `clayTray` takes `TABLE_RIM` out of each side for the wall, so the
 * well's inner clear size is `grid + TRAY_MARGIN − 2 * TABLE_RIM` = `grid + 0.28`; the mat
 * is `grid + MAT_MARGIN` and has to fit inside that. Shrink `TRAY_MARGIN` without shrinking
 * `MAT_MARGIN` and the mat pushes through the well wall.
 */
export const TRAY_MARGIN = 0.88;
export const MAT_MARGIN = 0.12;
export const trayFor = (grid: Grid) => ({
  w: grid.width + TRAY_MARGIN,
  d: grid.depth + TRAY_MARGIN,
});

/**
 * Radius of the soft contact darkening under the tray.
 *
 * Keyed off the tray's **shorter** side, not its longer one. The blob is a disc and the
 * tray is a rectangle: at `max * 0.62` the disc reached 0.6 units past the tray's near
 * edge on a 4-row board, which is what put the board's own contact shadow outside the view
 * rect and had it cut off mid-gradient at the bottom of the frame.
 */
export const contactRadiusFor = (tray: { w: number; d: number }): number =>
  Math.min(tray.w, tray.d) * 0.5 + 0.16;

/* ------------------------------------------------------------------ */
/* Camera                                                              */
/* ------------------------------------------------------------------ */

/**
 * The board is framed from the measured play-area rect rather than from a hand-picked
 * distance per level, because `GameShell` hands a game the *whole* shell interior: that
 * rect is roughly 1:1 on a laptop and 0.6:1 on a phone held upright, and one fixed camera
 * cannot serve both.
 *
 * **This is a screen-space solve, not an orthographic one, and that is the whole point.**
 * Round 2 measured "board centre at 67.7 % of frame height, top 35.6 % empty cream, tray
 * bottom lip flush at 99.9 % with its own contact shadow cropped", and the first attempt at
 * a fix reproduced the crop at Hard (tray lip at 98.5 %, shadow gone) because it estimated
 * the vertical extent as `y·cos E − z·sin E`. That expression is the *orthographic* screen-up
 * coordinate. Under a 28-degree perspective the tray's near lip is 2.9 units closer to the
 * camera than its far rim, so it is magnified by about 30 % relative to it — a solve that
 * ranks the two by `u` alone under-reserves the bottom of the frame by exactly that amount,
 * every time, and the near lip is always the thing that gets cut.
 *
 * The same expression also invented a point that does not exist. The old `spanTop` combined
 * the highest `y` in the scene (a matched card at full lift, which happens over the *grid*)
 * with the furthest `−z` (the contact shadow's far skirt, 1.4 units behind the back row),
 * as if a card could be lifted out there. That phantom corner reserved ~0.5 units of sky
 * that nothing ever occupies.
 *
 * So instead: list the points the shot has to contain, project them properly, and iterate
 * distance and aim until they fit. Twelve passes; measured to converge to 1e-4 in six, and
 * it runs on a resize or a level change, never in a frame. The framing skeleton is:
 *
 *   • the contact shadow's skirt, near and far  — the thing that was being cropped
 *   • the tray's near lip, floor and rim top    — the closest, most magnified geometry
 *   • the tray's far rim top
 *   • the near row's lower card edge
 *   • a matched card at full lift with its relief standing, in the near row and the far row
 *
 * Two constraints, both in normalised device coordinates so they are aspect-honest:
 * everything above sits inside the band the chrome does *not* cover, with `MARGIN_NDC` of
 * clear frame on every side; and the outermost card of the **near** row (the magnified one)
 * plus the reach its focus ring needs (`reachFor`) stays inside the frame horizontally.
 *
 * Width is solved from the grid, not the tray, and the tray's side lip is allowed to run
 * off the frame on a squarer viewport. The hard constraint is that every card and its focus
 * ring is reachable; a clay lip leaving the frame is a photograph of a table, and
 * `GameShell`'s feather fogs that edge rather than razoring it. Solving width from the tray
 * pushed a narrow frame past `MAX_DISTANCE` and shrank the cards for nothing.
 */
const FOV = 28;
const TAN_HALF_FOV = Math.tan((FOV * Math.PI) / 360);
/**
 * The widest lens `3D-SPEC §2` allows, and the only thing left when the distance band runs
 * out.
 *
 * On a portrait phone the play area can be narrower than it is tall: at 390x700 with 132 px
 * of chrome the four-column boards need the camera at 18.9 units to fit their width, the
 * band stops at 16, and the solve clamps — leaving the outermost column 5 % outside the
 * frame and its focus ring 21 % outside. Nothing about the board can shrink (the rules fix
 * the grid) and nothing about the distance can grow, so the lens opens instead, by exactly
 * the factor the overflow measures and never past this ceiling.
 */
const FOV_MAX = 32;
const TAN_HALF_FOV_MAX = Math.tan((FOV_MAX * Math.PI) / 360);
/** 42 degrees: enough to read the grid as a plan, shallow enough to see the card edges. */
const SIN_E = ELEV_SIN;
const COS_E = ELEV_COS;
/** Clear frame kept on every side, as a fraction of the half-frame. 4.5 % ≈ 16 px at 700. */
const MARGIN_NDC = 0.045;

/**
 * How far past the outermost card's own edge the focus ring reaches, in board units.
 *
 * **This was `0.3`, a flat constant, and it is now solved — because `hit.tsx` changed.**
 * Round 4's A1 rebuilt the ring: its outer edge is now `1.00–1.05 x` the marked object's
 * *footprint*, where the footprint is exactly the disc `HitTarget` sizes its collider to —
 * `max(radius, minScreenPx * 0.5 * worldPerPixel)`. Before A1 the ring was `radius * 1.2`
 * grown again by the outer torus's own tube, landing at `1.464 x`; 0.3 was the allowance for
 * that, and carrying it forward is a reservation for a ring that no longer exists.
 *
 * The ring's outer radius is measured from the **card's centre**, and `halfW` below is
 * measured from the outermost card's **outer edge**, so what has to be reserved is the
 * difference:
 *
 *     reach = RING_OUTER * max(HIT_RADIUS, TAP_FLOOR_PX/2 * worldPerPixel) − CARD_W/2
 *
 * `worldPerPixel` is `2 * depth * tan(fov/2) / viewHeightPx`, and `viewHeightPx` is the play
 * area's own CSS height — the `height` argument to `cameraFor`, which is the same element
 * `hit.tsx` reads through `playAreaMetrics()`. So this is not an estimate of what the ring
 * will do; it is the ring's own solve, evaluated on the numbers the ring will be handed.
 *
 * It is evaluated **inside** `solvePass`, at the distance of that pass, because the tap floor
 * is a screen quantity and the distance is what the pass is solving for. `boardScale` needs
 * no correction: a uniform scale `s` multiplies the distance and the world together, so
 * `worldPerPixel` in *board* units is the same number at `r` unscaled as at `r*s` scaled.
 *
 * At the shipped framings the tap floor never binds and the collider does, so `reach` settles
 * at `1.05 * 0.495 − 0.45` = **0.06975** — a 78 % cut on 0.3, which is 13 % more board on a
 * portrait phone, where width is the binding constraint. `MIN_BOARD_SCALE`'s sweep is re-run
 * against it.
 */
const RING_OUTER = 1.05;
const reachFor = (perPixel: number): number => {
  const footprint = Math.max(HIT_RADIUS, TAP_FLOOR_PX * 0.5 * perPixel);
  const reach = RING_OUTER * footprint - CARD_W / 2;
  return reach > 0 ? reach : 0;
};
/** Allowance for the key light's cast shadow and the contact blob's soft tail. */
const SHADOW_SKIRT = 0.32;
/**
 * How far a matched pair rises before it is pressed into the mat. Lives here rather than in
 * `scene.tsx` because it is half of the transient envelope the camera has to reserve for;
 * `scene.tsx` imports it so the two can never drift apart.
 */
export const MATCH_LIFT = 0.3;
/**
 * Top of a standing relief on a resting card, and how far forward on the card it can be.
 *
 * `RELIEF_MAX_H` is a *ceiling the fit enforces*, not a measurement of the current art —
 * see that constant for why the difference matters. `motifs.ts` is still not imported here:
 * this file pulls in no three and no React, and the fit reads its budget from here rather
 * than the other way round.
 */
const RELIEF_TOP = REST_Y + MOTIF_DZ + RELIEF_MAX_H;
/**
 * A relief's most forward mass sits at most `RELIEF_NEAR_Z` from its card's centre, which
 * on the near row is the closest — and therefore the most magnified — thing in the shot
 * after the tray's own lip.
 */
const RELIEF_DZ = RELIEF_NEAR_Z;
/** ...and the same card at the top of a match lift. Transient, but never cropped. */
const LIFT_TOP = RELIEF_TOP + MATCH_LIFT;
/** Top corner of a lifted card body, which is further back than its relief. */
const LIFT_CARD_TOP = REST_Y + MATCH_LIFT + CARD_T / 2;
/** Lower edge of a card at rest — the near row's silhouette bottom. */
const CARD_BOTTOM = REST_Y - CARD_T / 2;
/**
 * Fallback height of `GameShell`'s title + HUD band, used only until the shell's own
 * measurement arrives.
 *
 * **It is a fallback, and round 4 measured it being the only value this game ever used.**
 * `ToothMatch.tsx` resolved the play area in a `useLayoutEffect`, which React runs *before*
 * an ancestor's ref is attached, so the effect returned early, never built its
 * `ResizeObserver`, and — because its dependency is an identity-stable ref object — never
 * ran again. `cameraFor` was therefore called with `(level, 0, 0, 132)` for the life of every
 * mount, on every viewport. See `ToothMatch.tsx` for the fix and for how it was proved off
 * the shipped pixels.
 */
export const CHROME_FALLBACK_PX = 132;
const MIN_DISTANCE = 8;
const MAX_DISTANCE = 16;
/** Measured to converge to 1e-4 in six; twelve is the belt-and-braces number. */
const SOLVE_PASSES = 12;

/**
 * The framing skeleton, as (y, z) pairs. Module-level and rewritten in place: `cameraFor`
 * runs on a resize or a level change, but it is called from a React render and there is no
 * reason for it to churn the heap.
 */
const SKELETON_MAX = 10;
const _skelY = new Float64Array(SKELETON_MAX);
const _skelZ = new Float64Array(SKELETON_MAX);

export type CameraFraming = {
  position: [number, number, number];
  target: [number, number, number];
  fov: number;
  /**
   * Uniform scale the whole board group carries — see `MIN_BOARD_SCALE`. 1 on every
   * viewport where the spec's distance band is enough; below 1 on a portrait phone.
   */
  boardScale: number;
};

/**
 * The floor on `boardScale`, and therefore the ceiling `solvePass` is allowed to run to:
 * `MAX_DISTANCE / MIN_BOARD_SCALE`.
 *
 * **Why the board scales at all.** Round 3 measured this file giving up. At a 354x760 play
 * area with 215 px of chrome the four-column boards need the camera at 17.5 units, the
 * spec's band stops at 16, and the solve clamped and shipped the overflow: Medium reached
 * **1.057** in NDC and Hard **1.094** — the outermost card's own edge 6-10 % outside the
 * frame — and their focus rings **1.213 / 1.256**, a quarter off-screen, which is an §8
 * failure on top of a framing one. Medium is the default for age >= 8. Reproduced exactly by
 * transpiling this file and evaluating the solve; the comment at `FOV_MAX` already conceded
 * it in prose.
 *
 * **Why scaling is the same image, not a compromise.** Under a uniform scale `s` about the
 * origin, scaling the board and leaving the camera at `r` produces pixel-for-pixel the image
 * of the unscaled board at `r / s` — the projection is homogeneous. So the solve is allowed
 * to run past `MAX_DISTANCE` to find the distance the framing actually wants, and the excess
 * is then spent on the board instead of on the camera. The camera still ships inside the
 * spec's 8-16 band; the rules' 3x2 / 4x3 / 4x4 grid is untouched; only the clay gets smaller,
 * and only on a shell narrower than it is tall.
 *
 * 0.62 is the floor because a card at that scale is still 5.6 x 7.2 cm — a real object a
 * child can hold. Nothing in the supported viewport range gets near it.
 *
 * **The sweep, re-run against the shipped module with the derived focus-ring reach** —
 * 227,430 cases (280–1600 x 260–1200 in 10 px steps, six chrome heights, three levels),
 * projecting every card's four corners and every focus ring's own outer edge rather than
 * reading the solve's residual back:
 *
 *   min boardScale **0.7524** (was 0.6847), worst card corner **0.9315** NDC, worst focus
 *   ring **0.9397** NDC against the 0.955 bar, fov inside 28–32, distance inside 8–16, and
 *   **zero** overflows.
 *
 * Round 4 read the previous version of this paragraph next to the shipped 390x844 render and
 * concluded, reasonably, that the render disproved the sweep. It did not: the sweep was
 * right and it was never exercised, because `cameraFor` was called with a `0 x 0` rect. That
 * is TM1, it is fixed in `ToothMatch.tsx`, and the check that would have caught it is
 * `?selftest=tooth-match-camera`, which asserts the *arguments* the solve is handed and not
 * only the answer it returns. Below the floor the solve would crop again, so `cameraFor`
 * still asserts the residual in dev rather than shipping it silently.
 */
const MIN_BOARD_SCALE = 0.62;
const SOLVE_CEILING = MAX_DISTANCE / MIN_BOARD_SCALE;

export function cameraFor(
  level: number,
  width: number,
  height: number,
  chromePx: number = CHROME_FALLBACK_PX
): CameraFraming {
  _last.level = level;
  _last.width = width;
  _last.height = height;
  _last.chromePx = chromePx;

  const grid = gridFor(level);
  const tray = trayFor(grid);
  const aspect = width > 0 && height > 0 ? Math.max(0.4, width / height) : 1;
  // Clamped: a landscape phone would otherwise report the chrome eating half the frame
  // and push the camera out past the far end of the allowed band.
  const chrome = height > 0 ? Math.min(0.34, chromePx / height) : 0.2;

  const farTray = tray.d / 2;
  const farShadow = farTray + SHADOW_SKIRT;
  const farGrid = grid.depth / 2;
  /** Centre line of the outermost card rows — where a relief actually stands. */
  const rowZ = farGrid - CARD_H / 2;

  let n = 0;
  _skelY[n] = 0;              _skelZ[n++] = farShadow;   // contact shadow, near skirt
  _skelY[n] = 0;              _skelZ[n++] = -farShadow;  // contact shadow, far skirt
  _skelY[n] = 0;              _skelZ[n++] = farTray;     // tray near lip, at the table
  _skelY[n] = TABLE_H;        _skelZ[n++] = farTray;     // tray near lip, at the rim top
  _skelY[n] = TABLE_H;        _skelZ[n++] = -farTray;    // tray far rim
  _skelY[n] = CARD_BOTTOM;    _skelZ[n++] = farGrid;     // near row, lower card edge
  _skelY[n] = LIFT_TOP;       _skelZ[n++] = rowZ + RELIEF_DZ;   // near row, lifted relief
  _skelY[n] = LIFT_TOP;       _skelZ[n++] = -rowZ + RELIEF_DZ;  // far row, lifted relief
  _skelY[n] = LIFT_CARD_TOP;  _skelZ[n++] = -farGrid;    // far row, lifted card corner

  /** The band the chrome leaves clear, in NDC. +1 is the top of the frame. */
  const bandTop = 1 - 2 * chrome - MARGIN_NDC;
  const bandBottom = -1 + MARGIN_NDC;
  const bandCentre = (bandTop + bandBottom) / 2;
  const bandSpan = bandTop - bandBottom;
  /**
   * Half the horizontal reach that must fit: outermost card plus its focus ring. The ring's
   * half is solved inside `solvePass`, at that pass's own distance — see `reachFor`.
   */
  const gridHalfW = grid.width / 2;
  /** The play area's CSS height, which is also the `<View>`'s and so the ring's. */
  const viewH = height > 0 ? height : 1;

  /*
   * Three passes of the same solve, and they are in this order for a reason.
   *
   * 1. At the default 28 mm lens, clamped into the spec's 8-16 distance band, measure how
   *    far outside the frame the board still is. That number is only ever above 1 on a
   *    shell narrower than it is tall, where the four-column boards need more distance
   *    than the band has.
   * 2. Open the lens by exactly that factor — no ladder, no taste value — capped at
   *    `FOV_MAX`. A wider lens is free (§2 allows 26-32) and buys `tan16 / tan14` = 15 %
   *    of the shortfall, so it is spent before any of the board is.
   * 3. Re-solve with the distance ceiling lifted to `SOLVE_CEILING`, which reports the
   *    distance the framing genuinely wants. Whatever of that is past `MAX_DISTANCE` is
   *    handed to `boardScale` instead — see `MIN_BOARD_SCALE` for why that is the same
   *    image rather than a compromise.
   *
   * `solvePass` writes into module-level scratch rather than returning an object:
   * `cameraFor` is called from a React render on every resize and level change.
   */
  const first = solvePass(n, TAN_HALF_FOV, aspect, gridHalfW, viewH, farGrid, bandCentre, bandSpan, MAX_DISTANCE);
  let tanHalf = TAN_HALF_FOV;
  let fov = FOV;
  if (first > 1.0005) {
    const wanted = TAN_HALF_FOV * first;
    tanHalf = wanted > TAN_HALF_FOV_MAX ? TAN_HALF_FOV_MAX : wanted;
    fov = (2 * Math.atan(tanHalf) * 180) / Math.PI;
  }
  const over = solvePass(n, tanHalf, aspect, gridHalfW, viewH, farGrid, bandCentre, bandSpan, SOLVE_CEILING);

  // The distance the framing wanted, converted into board scale for the part of it the
  // spec's band cannot hold. `shift` is an offset in the same world, so it scales with it.
  const wantedR = _solvedR;
  const boardScale = wantedR > MAX_DISTANCE ? MAX_DISTANCE / wantedR : 1;
  const r = wantedR * boardScale;
  const shift = _solvedShift * boardScale;

  // The assert the fix list asked for. `over` is the residual at the settled distance, so
  // above 1 means even `SOLVE_CEILING` was not enough and something is genuinely cropped —
  // which is the defect this whole path exists to make impossible, not a tolerance.
  if (import.meta.env.DEV && over > 1.0005) {
    console.error(
      `[tooth-match] camera solve overflows by ${((over - 1) * 100).toFixed(1)}% at level ` +
        `${level}, ${width}x${height} with ${chromePx}px of chrome: the board would be ` +
        `cropped even at boardScale ${MIN_BOARD_SCALE}. Lower MIN_BOARD_SCALE or widen the ` +
        `play area.`
    );
  }

  // Applied along the camera's own up vector (0, cos, -sin) so the framing shifts without
  // changing the angle.
  const ty = shift * COS_E;
  const tz = -shift * SIN_E;

  return {
    position: [0, ty + r * SIN_E, tz + r * COS_E],
    target: [0, ty, tz],
    fov,
    boardScale,
  };
}

/**
 * The inputs of the last `cameraFor` call, so a self-check can assert the framing was solved
 * from a *measured* rect rather than from the fallback.
 *
 * This exists because round 4's TM1 was invisible to every check the game had: the solve was
 * correct, its 193,116-case sweep was correct, and none of it mattered because the caller
 * fed it `(0, 0, 132)` for the life of every mount. A check that only exercises the function
 * cannot see that; a check that reads what the function was actually *called with* can.
 * Module scratch, rewritten in place — `cameraFor` runs inside a React render.
 */
export type SolvedFraming = {
  level: number;
  width: number;
  height: number;
  chromePx: number;
};
const _last: SolvedFraming = { level: -1, width: 0, height: 0, chromePx: 0 };
/**
 * A **copy**, not the scratch record. A reader that held the live object would see it change
 * under it the moment it called `cameraFor` again — which is exactly what a check that
 * re-solves a synthetic viewport does.
 */
export const lastFraming = (): SolvedFraming => ({
  level: _last.level,
  width: _last.width,
  height: _last.height,
  chromePx: _last.chromePx,
});

/** Distance and aim from the last `solvePass`. Module scratch, see `cameraFor`. */
let _solvedR = 11;
let _solvedShift = 0.3;

/**
 * Solves distance and aim for one lens, and returns the residual overflow.
 *
 * The return value is `max(needY, needX)` measured at the settled distance: 1 means the
 * skeleton exactly fills the band it is allowed, above 1 means the distance clamp bound
 * before it could and that much of the board is outside the frame.
 */
function solvePass(
  n: number,
  tanHalf: number,
  aspect: number,
  gridHalfW: number,
  viewH: number,
  farGrid: number,
  bandCentre: number,
  bandSpan: number,
  maxDistance: number
): number {
  let r = 11;
  let shift = 0.3;
  let over = 1;
  for (let pass = 0; pass <= SOLVE_PASSES; pass++) {
    // Camera sits on the elevation ray through the aim point; forward is (0, -sin, -cos)
    // and the camera's own up is (0, cos, -sin), so a view-space coordinate is two dots.
    const cy = shift * COS_E + r * SIN_E;
    const cz = -shift * SIN_E + r * COS_E;

    let hi = -Infinity;
    let lo = Infinity;
    for (let i = 0; i < n; i++) {
      const dy = _skelY[i] - cy;
      const dz = _skelZ[i] - cz;
      const vz = -(dy * SIN_E + dz * COS_E);
      const ndc = (dy * COS_E - dz * SIN_E) / (vz * tanHalf);
      if (ndc > hi) hi = ndc;
      if (ndc < lo) lo = ndc;
    }

    // Width is measured on the NEAR row: it is the magnified one, so it is the one that
    // reaches the side of the frame first.
    const wz = -((REST_Y - cy) * SIN_E + (farGrid - cz) * COS_E);
    // The ring's own solve, at this pass's distance: `hit.tsx` sizes it from
    // `worldPerPixel` at the target's depth against the play area's CSS height.
    const halfW = gridHalfW + reachFor((2 * wz * tanHalf) / viewH);
    const needX = halfW / (wz * tanHalf * aspect) / (1 - MARGIN_NDC);
    const needY = (hi - lo) / bandSpan;
    over = needY > needX ? needY : needX;
    // The last pass only measures: re-aiming and re-scaling after it would leave the
    // reported overflow describing a camera the caller never receives.
    if (pass === SOLVE_PASSES) break;

    // Re-aim first (a uniform NDC translation is a world translation along the camera's up
    // axis), then re-scale by whichever constraint is binding.
    shift += ((hi + lo) / 2 - bandCentre) * (r * tanHalf);
    r *= over;
    r = r < MIN_DISTANCE ? MIN_DISTANCE : r > maxDistance ? maxDistance : r;
  }
  _solvedR = r;
  _solvedShift = shift;
  return over;
}

/** Shadow frustum: bound the board, not the world (3D-FOUNDATION-NOTES §8). */
export function shadowAreaFor(level: number): number {
  const tray = trayFor(gridFor(level));
  return Math.max(tray.w, tray.d) + 1.6;
}
