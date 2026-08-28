/**
 * Maze Escape — the props, as real clay.
 *
 * Every geometry here comes back from a shared, `markShared`-ed cache in `geometry.ts` and
 * every material from the cached clay factories, so this module owns nothing and disposes
 * nothing. It is called once from a `useMemo` on the scene's mount and again when the cell
 * pitch changes (i.e. on a level change), never at module import time — so it lands in this
 * game's own chunk and the hub pays nothing for it.
 *
 * Everything is expressed as a fraction of the cell pitch: at 9 cells the corridors are fat
 * and the toothbrush is a chunky handful, at 13 they are narrow and it is a slim thing in a
 * slot, and neither needed a second set of numbers.
 *
 * Authoring convention, shared with `motifs.ts` in Tooth Match: a part is a geometry, a
 * material and a transform, and the scene decides what to parent it to.
 *
 * ## Colour: one family, one meaning
 *
 * The registry files this game under **coral**, and coral is the gum — 55 % of the board's
 * pixels and the thing the whole scene is made of. Every other family here carries exactly
 * one piece of meaning, so a child can learn the board by colour rather than by reading:
 *
 *   coral  → the walls (`clayGum`, whose `CLAY.gum` *is* `ACCENTS.coral.main`)
 *   mauve  → **the goal**: the brush's handle and the pad it stands on, nothing else
 *   peach  → **the sweets** — the lollipop's disc, the ice cream's cone
 *   rose   → **where you started** — and, as the one deliberate exception, the ice cream's
 *            scoop and cherry, because a *strawberry* ice cream is the shape a child reads
 *            and peach.soft on the ivory floor measures 1.10:1. The start marker is a flat
 *            ring lying on the floor and the ice cream is a standing cone; they are never
 *            confusable, and legibility beats a tidy colour table.
 *   ivory / enamel / crevice → neutrals: the hero, the brush head, the lolly stick
 *
 * The previous build painted the toothbrush handle `clayAccent("coral", "main")`, which is
 * byte-identical to `CLAY.gum` — the goal was literally the same colour as the walls it
 * stood between. That is the single largest reason the goal was unfindable, and it is why
 * nothing in this file may use coral again.
 */
import type { BufferGeometry, Material } from "three";
import {
  MASCOT_FACE,
  latheProfile,
  mascotParts,
  roundedBox,
  roundedCylinder,
  softCapsule,
  softSphere,
  toothGeometry,
  torusSoft,
  type MascotPart,
} from "../../three/geometry";
import { clayAccent, clayEnamel, clayIvory, clayPainted } from "../../three/materials";
import { ACCENTS } from "../../three/tokens";
import {
  ELEVATION,
  FACE_TILT,
  FLOOR_Y,
  RING_TUBE,
  cellSize,
  goalPadRadius,
  startRingMajor,
  toothRadius,
} from "./layout";

export type Part = {
  geometry: BufferGeometry;
  material: Material;
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
};

const NO_ROT: [number, number, number] = [0, 0, 0];
const ONE: [number, number, number] = [1, 1, 1];
/** Lay a ring or a disc flat, hole pointing up. */
const FLAT: [number, number, number] = [-Math.PI / 2, 0, 0];
/** Stand a flat prop up and turn its face into the lens. See `FACE_TILT`. */
const FACING: [number, number, number] = [FACE_TILT, 0, 0];

const part = (
  geometry: BufferGeometry,
  material: Material,
  position: [number, number, number],
  rotation: [number, number, number] = NO_ROT,
  scale: [number, number, number] = ONE
): Part => ({ geometry, material, position, rotation, scale });

export type ToothProp = {
  /** The mascot, in its own space: body at the origin with the roots' base at y = 0. */
  parts: MascotPart[];
  /**
   * Where to hang `parts` so the tooth's bounding-box centre lands on the parent's origin.
   * That centre is the axis it rolls about, and a tooth rolling about anything else skates.
   */
  offset: [number, number, number];
  /** Half-extents of the fitted body — the scene sizes the focus ring from these. */
  half: [number, number, number];
};

export type MazeProps = {
  tooth: ToothProp;
  brush: Part[];
  goalPad: Part;
  startRing: Part;
  /** Two treat designs, alternated across the dead ends exactly as the 2D game did. */
  treats: [Part[], Part[]];
};

/**
 * `toothGeometry`'s origin convention is not part of its contract, so it is measured
 * rather than assumed. The tooth is fitted so its **largest** dimension is one diameter and
 * its bounding-box centre sits on the origin — that centre is the axis it rolls about.
 *
 * `height` is the fitted world height of the body, which is what `mascotParts` wants: it is
 * *not* interchangeable with `diameter`, and only coincides with it while the tooth's
 * height happens to be its largest dimension.
 */
function fitTooth(geometry: BufferGeometry, diameter: number) {
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  const bb = geometry.boundingBox;
  if (!bb) {
    return {
      scale: 1,
      height: 1,
      base: 0,
      offset: [0, 0, 0] as [number, number, number],
      half: [0.5, 0.5, 0.5] as [number, number, number],
    };
  }
  const sx = bb.max.x - bb.min.x;
  const sy = bb.max.y - bb.min.y;
  const sz = bb.max.z - bb.min.z;
  const k = diameter / Math.max(1e-4, Math.max(sx, Math.max(sy, sz)));
  return {
    scale: k,
    height: sy * k,
    /** Height of the roots' base above the fitted bbox centre — negative, by construction. */
    base: bb.min.y * k - ((bb.max.y + bb.min.y) / 2) * k,
    offset: [
      -((bb.max.x + bb.min.x) / 2) * k,
      -((bb.max.y + bb.min.y) / 2) * k,
      -((bb.max.z + bb.min.z) / 2) * k,
    ] as [number, number, number],
    half: [(sx * k) / 2, (sy * k) / 2, (sz * k) / 2] as [number, number, number],
  };
}

/**
 * How much bigger than art-directed the mascot's features are drawn on this board.
 *
 * `G-ME-2` asks for the eyes at `D * 0.16`. `MASCOT_FACE` cannot deliver that number and
 * `X3` requires this game to use `MASCOT_FACE`: its eye anchors sit at `x = ±0.15` of the
 * tooth's height, so an eye of radius 0.16 has the two eyeballs **overlapping across the
 * midline**. The largest face the shared anchors admit is what this constant picks, and the
 * ceiling was measured against the metaball surface rather than guessed
 * (`scratchpad/mefaceverify.mjs` re-implements `metaField` / `surfaceRadius` at 256 march
 * steps and 30 bisections, and reproduces the shipped anchor table exactly):
 *
 * | featureScale | eye protrusion | cheek protrusion | gap between the eyes |
 * |---|---|---|---|
 * | 1.000 (art-directed) | 0.044 | 0.047 | 0.164 |
 * | 1.306 (was, 9 cells) | 0.065 | 0.069 | 0.122 |
 * | **1.620 (this)**     | **0.087** | ~~0.092~~ | **0.080** |
 * | 1.887 (was, 13 cells)| 0.106 | 0.111 | 0.043 |
 *
 * All in units of the tooth's own height; protrusion is measured radially from a point
 * inside the crown, i.e. it is how far a feature stands off the head.
 *
 * **The cheek column no longer describes what renders, and is struck through rather than
 * silently corrected so the argument below can still be read.** Round 3's A19 gave
 * `mascotParts` a `pressIn(anchor, half, k)` rule — the extra size a scaled feature gains
 * goes *inward*, so the feature's outer extreme stays where `featureScale = 1` put it — and
 * applied it to the cheeks, because a cheek that grows outward hangs off the silhouette. The
 * cheek's protrusion is therefore pinned at its k = 1 value (0.0025 of the tooth's height,
 * measured on the shipped geometry) at every scale this game could ask for.
 *
 * **The choice of 1.62 is unaffected**: it was made on the *eye gap* column, and the eye is
 * the one feature A19 deliberately exempted from `pressIn` — precisely because this game
 * solves its scale against the visible eye cap. Both other columns still hold.
 *
 * **The gap is the binding constraint, and it is a legibility one, not a modelling one.**
 * The 13-cell tooth is 30 px across, so a gap of 0.043 is **1.3 px**: at the value this game
 * shipped a moment ago the two eyes merged into a single dark visor on the hardest board —
 * a different expression, not a bigger face. Holding the gap at or above 0.08 caps the scale
 * at 1.62, and the resulting eye *disc* (the spherical cap standing proud of the surface,
 * which is all a child actually sees) at ~130 px per world unit is:
 *
 * | cells | tooth | eye disc, was → now | eye gap, was → now |
 * |---|---|---|---|
 * |  9 | 43.9 px | 7.2 → **9.2 px** | 5.4 → 3.5 px |
 * | 11 | 35.9 px | 7.4 → **7.6 px** | 3.0 → 2.9 px |
 * | 13 | 30.4 px | 7.5 → 6.4 px     | 1.3 → **2.4 px** |
 *
 * — bigger where a four-year-old plays, and two eyes instead of one dark band where an
 * eight-year-old does.
 *
 * It is **one constant for all three levels**, deliberately, replacing a per-level solve
 * that chased a fixed *world* eye size. That solve needed `featureScale` 2.74 on the 13-cell
 * board to hold the eye at a constant 0.03 units — far past the merge point — so it spent
 * its whole range fighting a ceiling it could not reach and shipped three different faces.
 * The character is now identical at every difficulty; only the prop's size changes with the
 * cell pitch, which is exactly what `TOOTH_RATIO` already promises.
 */
const EYE_GAP_MIN = 0.08;
/**
 * Derived from the shared anchors rather than typed in, so that if `MASCOT_FACE` ever moves
 * the eyes this board's face follows instead of quietly merging them again. Reads: the two
 * eyeballs span `2 × (eye.x + eye.r × scale)`, and the enamel left between them is
 * `2 × eye.x − 2 × eye.r × scale`. Solve that for `EYE_GAP_MIN`. Currently 1.618.
 */
const FEATURE_SCALE = (2 * MASCOT_FACE.eye.x - EYE_GAP_MIN) / (2 * MASCOT_FACE.eye.r);

/* ------------------------------------------------------------------ */
/* Two corrections this board applies to the shared face               */
/* ------------------------------------------------------------------ */

/**
 * How much bigger this game draws the catchlight than `MASCOT_FACE.glint.r` asks for.
 *
 * Round 3's charge was that at the gameplay camera the hero "reads as a skull": two solid
 * black discs over a dark open mouth, at 40 x 60 px in a 1500 px frame. Half of that was a
 * shared bug — the glint offset did not scale with `featureScale`, so at this game's k of
 * 1.62 the catchlight sphere was arithmetically *inside* the pupil and never rendered at all
 * — and A19 fixed it. What A19 leaves is a catchlight whose visible cap is 29.9 % of the
 * pupil's radius: **3.6 px at 9 cells, 2.5 px at 13**. That is a catchlight in principle.
 *
 * The two spheres intersect, so the visible catchlight is the cap of the glint that stands
 * outside the pupil, and its rim circle has radius `sqrt(Ra^2 - x^2)` with
 * `x = (d^2 + Ra^2 - Rb^2) / 2d` — `Ra` the pupil, `Rb` the glint, `d` the offset. Growing
 * `Rb` grows that cap, and the ceiling is not aesthetic: past a point the glint's *projected*
 * disc reaches past the pupil's and the highlight spills onto the enamel, which reads as a
 * blister rather than as light. So the ceiling is solved — the glint radius at which
 * `dPerp + Rb = Ra`, where `dPerp` is the part of the offset that survives projection at
 * `ELEVATION` — and this constant takes 94 % of it. Derived from `MASCOT_FACE` rather than
 * typed in, so a future move of the eye carries the catchlight with it.
 *
 * Resolves to **1.3313**, which puts the visible cap at 41.0 % of the pupil radius: **4.9 px
 * at 9 cells, 4.0 at 11, 3.4 at 13**, with the projected disc still 0.0029 H inside the
 * pupil's rim. Reproduce with `scratchpad/verify/maze-hero.mjs`.
 *
 * A screen-space floor of the kind `HitTarget.minScreenPx` applies is the wrong instrument
 * here and the arithmetic says so: a catchlight cannot be larger than the pupil it sits on,
 * the pupil is 8.2 px on the hardest board, and a px floor would therefore either never
 * bind or push the highlight straight off the eye. What holds it at play scale is that it is
 * a fixed *fraction* of the pupil at every board size — which is what a catchlight is.
 */
const GLINT_CEILING_MARGIN = 0.94;
const GLINT_BOOST = (() => {
  const g = MASCOT_FACE.glint;
  const k = FEATURE_SCALE;
  const d = Math.hypot(g.dx, g.dy, g.dz) * k;
  // The camera looks down `(0, sin E, cos E)`; the offset's component along that axis is
  // lost to projection, and what is left is the separation of the two discs on screen.
  const along = (g.dy * Math.sin(ELEVATION) + g.dz * Math.cos(ELEVATION)) * k;
  const perp = Math.sqrt(Math.max(0, d * d - along * along));
  const ceiling = (MASCOT_FACE.eye.r * k - perp) / (g.r * k);
  return ceiling > 1 ? ceiling * GLINT_CEILING_MARGIN : 1;
})();

/**
 * The mouth's clay, replacing `CLAY.crevice` on this board only.
 *
 * `mascotParts` paints the mouth `CLAY.crevice` — the colour every recess in the product
 * uses, and the right answer for a crease. This mouth is not a crease: at `open: 0.5` it is
 * a 27 px lozenge directly under two ink pupils, and round 3 sampled its interior at
 * `(143, 103, 75)`. Muddy brown is the wrong signal under any face and a specifically wrong
 * one in a dental game.
 *
 * `rose.deep` is the same family the shared tongue already uses (`rose.main`), so the tongue
 * still reads *against* the mouth rather than into it, and it is the one accent family this
 * board has spare — coral is the gum, mauve is the goal, peach is the sweets.
 *
 * Two shading terms carry the rest of the finding, which was that the cavity "is shaded to
 * brown mud at 60°":
 *
 *   • `wrap` at 0.35 — §3's own number, against `clayPainted`'s 0.24 default. The mouth is a
 *     lens pressed into the crown and at this elevation the camera looks into it at a
 *     grazing angle, so the term that decides its brightness is how far the diffuse wraps
 *     past the terminator.
 *   • a bounce floor. `emissiveIntensity` 0.08 of the mouth's own albedo is the light a real
 *     cavity gets back off the lips around it; it is not a glow, it is the reason a mouth
 *     never goes to black. `#b2343f` is linear (0.440, 0.033, 0.051), so the term adds
 *     0.035 to red — about a third of a fully-shaded sample of the same albedo and about a
 *     tenth of a lit one, i.e. it lifts the crush and leaves the modelling alone.
 */
const mouthClay = () =>
  clayPainted(ACCENTS.rose.deep, {
    roughness: 0.72,
    wrap: 0.35,
    sss: ACCENTS.rose.soft,
    sssStrength: 0.55,
    sheen: 0.3,
    emissive: ACCENTS.rose.deep,
    emissiveIntensity: 0.08,
  });

/**
 * Applies both corrections to the shared mascot.
 *
 * Deliberately a post-pass over `mascotParts`' output rather than a hand-rolled face:
 * `geometry.ts` is explicit that every tooth in the product wears the same face, and this
 * changes two attributes of it — one tone and one radius — without adding a single feature
 * this game's mascot has and the other eight do not.
 */
function retoneFace(parts: MascotPart[]): MascotPart[] {
  const mouth = mouthClay();
  return parts.map((p) => {
    if (p.key === "mouth") return { ...p, material: mouth };
    if (p.key !== "glint-l" && p.key !== "glint-r") return p;
    return {
      ...p,
      scale: [p.scale[0] * GLINT_BOOST, p.scale[1] * GLINT_BOOST, p.scale[2] * GLINT_BOOST],
    };
  });
}

export function buildProps(n: number): MazeProps {
  const cell = cellSize(n);
  const R = toothRadius(n);
  const D = R * 2;

  const enamel = clayEnamel();
  const ivory = clayIvory();
  const mauve = clayAccent("mauve", "main");
  const mauveDeep = clayAccent("mauve", "deep");
  const peach = clayAccent("peach", "main");
  const peachDeep = clayAccent("peach", "deep");
  const rose = clayAccent("rose", "main");
  const roseSoft = clayAccent("rose", "soft");

  /* ---------------- the hero ---------------- */

  const body = toothGeometry("baby");
  const fit = fitTooth(body, D);

  /**
   * The shared mascot, not a hand-rolled face.
   *
   * `X3`'s charge against this game was two separate things: the face was 6 px, and the prop
   * was a bare crown on two splayed roots — which is an *extracted* tooth, not a character.
   * `mascotParts` answers both: art-directed eyes with catchlights, blush cheeks, an open
   * grin, and — the part that changes the silhouette — two arms and two feet, so the same
   * outline reads as somebody standing up. Two of those the shared face cannot size for this
   * camera, and `retoneFace` above corrects them: the catchlight, which A19 restored but
   * left at 3 px, and the mouth's tone, which is `CLAY.crevice` everywhere else and reads as
   * mud when a 60 deg camera looks down into it.
   *
   * Every part rides the roll node. `X3` prescribes hanging the face *outside* the roll node
   * for a tumbling prop, and that is right for a sphere; it is wrong here, and I checked the
   * numbers before deciding. The tooth is not rotationally symmetric: measured off the
   * metaball surface, its radius in the face direction runs from 0.468 of its height at the
   * crown down to ~0.15 at the root tips. A face pinned to a non-rotating node would
   * therefore hang up to a third of the prop's height off the body every time the roots came
   * round — a face floating in mid-air next to a tooth. Glued to the body it is always
   * correctly seated, and the existing slerp-to-identity brings it upright at every stop,
   * which in a maze that has to be *traced* is most of the run.
   */
  const tooth: ToothProp = {
    offset: fit.offset,
    half: fit.half,
    parts: retoneFace(
      mascotParts({
        height: fit.height,
        featureScale: FEATURE_SCALE,
        // A real grin, tongue and all. `retoneFace` re-paints the mouth interior warm rose
        // and opens the catchlight up to the size the eye can carry — see both constants.
        open: 0.5,
        limbs: true,
      })
    ),
  };

  /* ---------------- the goal ---------------- */

  /**
   * The toothbrush, authored bottom-up along its own +Y with its foot at y = 0, so the scene
   * can plant it, lean it and wag it without any of these numbers changing.
   *
   * The parts add up to exactly `BRUSH_HEIGHT` (1.2 cells): handle 0 → 0.72, neck
   * 0.72 → 0.86, head 0.84 → 1.20. The head is the widest part and the bristle pad stands
   * proud of its front face, so the silhouette is stick-then-paddle — the one shape a
   * four-year-old already knows. The old brush was 0.65 cells *total* and its handle was the
   * wall colour.
   */
  const brush: Part[] = [
    // Handle, 0 → 0.86. `mauve.deep`, not `mauve.main`: measured with the repo's own sRGB
    // relative-luminance formula, mauve.main against `CLAY.gum` is **1.10:1** — a real hue
    // difference (dE2000 12.3) at almost exactly equal lightness, and at this size and in
    // motion lightness is what carries. mauve.deep is 1.43:1 against the gum and **4.50:1**
    // against the ivory floor the lower two-thirds of it actually stands against.
    part(roundedBox(cell * 0.115, cell * 0.86, cell * 0.1, cell * 0.048), mauveDeep, [0, cell * 0.43, 0]),
    // A grip band. Breaks the long handle so it reads as a *handle* rather than a rod.
    part(roundedBox(cell * 0.145, cell * 0.1, cell * 0.125, cell * 0.045), ivory, [0, cell * 0.46, 0]),
    // Head, 0.84 → 1.20 — the whole of it above the wall line. Ivory against coral gum is
    // 3.14:1, the highest-contrast pair this palette has, and it is what makes the goal
    // findable from the far corner. The accent identifies it; the ivory *shows* it.
    part(roundedBox(cell * 0.235, cell * 0.36, cell * 0.115, cell * 0.075), ivory, [0, cell * 1.02, 0]),
    // The bristle field, proud of the head's front face — and the front face is turned into
    // the lens by `BRUSH_TILT`, so this is the plane the child is looking straight at.
    part(
      roundedBox(cell * 0.185, cell * 0.28, cell * 0.055, cell * 0.026),
      enamel,
      [0, cell * 1.03, cell * 0.072]
    ),
  ];

  return {
    tooth,
    brush,
    /**
     * The goal marker is a **filled pad**, the start marker an **open ring** — different
     * shapes, so they are told apart by silhouette and not only by tone. The pad is mauve,
     * the same family as the handle standing on it, so "brush" and "brush stand" read as
     * one object.
     *
     * Measured on the ivory corridor floor they stand on: the old pair was peach.soft at
     * **1.10:1 / dE2000 4.7** (the "five-point separation, i.e. invisible" the audit
     * measured) and rose.soft at 1.42:1. The new pair is mauve.main at **2.87:1 / dE 31.7**
     * and rose.main at **4.09:1 / dE 43.7**.
     */
    goalPad: part(
      roundedCylinder(cell * goalPadRadius(n), cell * 0.05, cell * 0.02),
      mauve,
      // Slightly *proud* of the floor, never sunk into the dish. A marker at the bottom of
      // a well is invisible at 60° elevation — that is the whole of `G-ME-1` in one line —
      // so this reads as a coaster the brush stands on, with the dish pressed around it.
      //
      // Its radius comes from `goalPadRadius`, i.e. from the bay it stands in, because at a
      // flat 0.34 of a cell it was wider than the bay had room for and the audit photographed
      // it half-buried in the gum (ME1).
      [0, FLOOR_Y + cell * 0.012, 0]
    ),
    /**
     * Tube 0.055 of a cell, not 0.038. The ring lies flat, so all the child ever sees of it
     * is two tube widths, foreshortened to `sin(ELEVATION)` = 0.87 across the top and bottom
     * of the loop: at 0.038 that was a 2.5–3.6 px hairline of rose on ivory depending on the
     * cell pitch — measurably 4.09:1, visually not there. 0.055 draws it at 3.6–5.2 px.
     *
     * The major radius is **not** typed in any more. The line this replaces claimed 0.395 of a
     * cell was "inside the corridor's own half-cell, so it never runs under the gum", and both
     * halves of that were wrong: the corridor's clear half-width was 0.393/0.390, not 0.5, and
     * the ring did run under the gum (ME5). `startRingMajor` derives it from `corridorClear`
     * less `MIN_BEVEL`, clamped to the size it was art-directed at — which is what it resolves
     * to at all three pitches now that the corridor is cut to its intended width.
     */
    startRing: part(
      torusSoft(cell * startRingMajor(n), cell * RING_TUBE),
      rose,
      [0, FLOOR_Y + 0.006, 0],
      FLAT
    ),
    treats: [
      /**
       * A lollipop. A circle on a stick is the most legible sweet silhouette there is, and
       * `FACE_TILT` turns the disc's face into the lens so it reads as a circle rather than
       * an ellipse. 0.47 cells across, against 0.32 for the flat coin it replaces.
       */
      [
        part(softCapsule(cell * 0.024, cell * 0.4), ivory, [0, FLOOR_Y + cell * 0.212, 0]),
        part(
          roundedCylinder(cell * 0.235, cell * 0.075, cell * 0.03),
          peach,
          [0, FLOOR_Y + cell * 0.48, 0],
          FACING
        ),
        part(
          roundedCylinder(cell * 0.1, cell * 0.085, cell * 0.028),
          peachDeep,
          [0, FLOOR_Y + cell * 0.487, cell * 0.007],
          FACING
        ),
      ],
      /**
       * An ice cream: cone, scoop, cherry. The lathe gives a real cone, so the silhouette is
       * triangle-then-ball — again a shape a child reads before they read anything.
       */
      [
        part(
          latheProfile([
            [0, 0],
            [cell * 0.06, cell * 0.09],
            [cell * 0.12, cell * 0.26],
            [cell * 0.175, cell * 0.42],
            [cell * 0.168, cell * 0.45],
          ]),
          peachDeep,
          [0, FLOOR_Y, 0]
        ),
        part(softSphere(cell * 0.2), roseSoft, [0, FLOOR_Y + cell * 0.54, 0]),
        part(softSphere(cell * 0.062), rose, [0, FLOOR_Y + cell * 0.76, cell * 0.02]),
      ],
    ],
  };
}