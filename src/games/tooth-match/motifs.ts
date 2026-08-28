/**
 * The eight card faces, as real clay props.
 *
 * The brief is explicit: a card face carries a *relief*, not a picture. So every motif is
 * a small extruded / lathed / metaball solid built by `src/three/geometry.ts`, standing
 * proud of the card face and lit by the same key light and studio environment as the table
 * it sits on. There is no texture of a drawing anywhere in this game, and no source asset.
 *
 * Everything here is built on the scene's first render, never at module import time, so it
 * lands in this game's chunk and costs the hub nothing. Every geometry and material comes
 * back from a shared, `markShared`-ed cache, which is why `buildMotifs()` has no teardown:
 * there is nothing here that a game is allowed to dispose.
 *
 * Authoring convention: a motif's base sits at local y = 0 and it points up +Y. The scene
 * parents it to the card at `MOTIF_DZ` along the card's own thickness axis, so it stands
 * out of the printed face and swings with the card as it flips.
 *
 * ---
 *
 * ## Round 3: the silhouettes are the game
 *
 * Round 3 measured two defects that are really one, and they are the reason this file was
 * rebuilt rather than tuned.
 *
 * **The shapes did not name their objects.** The "star" was `lobedShape(5, 0.105, 0.222)`
 * — a *cosine* radius, which makes a five-petal flower, not a star: measured silhouette
 * `rMax / rMin` **2.30**, and its tips were rounder than its valleys. Printed on every card
 * back was a six-petal rosette at silhouette ratio 1.44, in the same warm orange. In a memory
 * game the thing a child is asked to match looked like the wallpaper on the cards they had not
 * turned over yet (`tooth-match-f05.png`). The paste was a rounded slab with an ivory cylinder
 * on top — a jam jar. The brush was two bars. The apple and the berry were both a round blob
 * with something on top.
 *
 * Round 4 then measured that the first of those was **still true** after the star had been
 * rebuilt — a silhouette ratio is not a gestalt — and that the half that had to change was the
 * card back, not the star. See `emblemShape`. It also measured the rebuilt brush's *built*
 * silhouette rather than its profile and found a 0.76 handle-to-head ratio hiding inside it;
 * see `brush`.
 *
 * **The reliefs did not fit their cards.** See `CARD_HALF_U` in `layout.ts`: 33–43 % of every
 * relief hung off the far edge of its own card, because a card is foreshortened by `sin 42°`
 * and a relief standing on it is not.
 *
 * Both are now fixed by construction rather than by taste:
 *
 *   • Every identifying silhouette is authored as a 2D outline and given real depth
 *     (`stalkShape` + `beveledExtrude`) or as a lathe whose profile carries the tell — a
 *     crimped tail and a nozzle for the tube, a combed bristle block for the brush, a
 *     crowned dimple for the apple, a point-down teardrop for the berry, a lid seam and a
 *     pulled thread for the floss.
 *   • The star is `lobedShape(5, 0.098, 0.30, 1.35)`. The exponent is the whole point: at
 *     `p > 1` the valleys flatten into arcs of radius `rMin` and the points sharpen, which
 *     is what separates a star from a flower. Measured silhouette ratio **3.35**, minimum
 *     convex curvature radius 0.0243 — above §3's 0.02 floor, which is the constraint that
 *     stops it being sharper. See `starShape`. Round 4 found that a ratio is not a gestalt
 *     and that the card *back* was the half that had to change; see `emblemShape`.
 *   • Nothing carries its own scale or its own offset any more. `fitRelief` measures each
 *     motif's real vertices in the camera's own frame and solves the largest scale and the
 *     placement that keep it inside its card. A motif that cannot be fitted is a dev error
 *     naming itself, not a shape hanging off a card.
 *
 * Result, measured against the solved camera at 900x700 with 132 px of chrome: the eight
 * reliefs stand **90–105 px** tall and fill **55–66 %** of their own card's screen height,
 * with every vertex of every one of them inside the card's outline and its footprint on the
 * printed panel — **at the top of the reveal pop**, not only at rest.
 *
 * Those numbers are lower than the 101–125 px / 65–81 % this header carried in round 4, and
 * both halves of the difference are corrections rather than losses. The old figures were
 * measured against a camera the game never used (`ToothMatch.tsx` fed `cameraFor` a 0x0
 * rect; see TM1), and the fit they described was 8.98 % smaller than what the scene actually
 * drew, because `scene.tsx` multiplies the fitted scale by an `easeOutBack` that overshoots.
 * `RELIEF_POP_PEAK` now budgets that overshoot and the footprint is bounded by the printed
 * panel rather than by the card, so the claim above is true at every instant instead of at
 * rest. Nothing here is asserted from a bounding box or from a comment: `?selftest=tooth-match`
 * walks the shipped vertex buffers and fails the build state that round 4 photographed.
 *
 * ---
 *
 * **Colour is load-bearing here, not decoration.** Round 2 measured four of the eight
 * motifs as ivory reliefs standing on an ivory card panel — 1.03:1 and 1.10:1 against their
 * own face — with the result that a board of six face-up cards contained no identifiable
 * pair. Every motif carries a distinct accent family at `main` or `deep` on its dominant
 * mass, and the card panel behind them is no longer enamel white.
 *
 * Contrast of each dominant mass against the `mauve.soft` panel (`#efdfda`), **recomputed**
 * from the shipped `ACCENTS` hexes with the WCAG relative-luminance formula rather than
 * inherited from the round-2 table (it was right, and it is now checked):
 *
 * | motif | dominant mass            | ratio |
 * |-------|--------------------------|-------|
 * | tooth | enamel on `mauve.deep`   | 4.65  |
 * | berry | `rose.deep`              | 4.70  |
 * | brush | stick `red.deep`         | 4.63  |
 * | brush | ferrule `coral.deep`     | 3.78  |
 * | floss | pack `coral.deep`        | 3.78  |
 * | cup   | body `mauve.deep`        | 3.75  |
 * | paste | tube `rose.main`         | 3.41  |
 * | apple | `red.main`               | 2.98  |
 * | star  | `peach.deep`             | 2.57  |
 *
 * Two of those are below 3:1 on the raw sRGB tokens and I am not going to pretend
 * otherwise. They are the two where it costs least: the star has the most distinctive
 * silhouette in the set by a factor of two, and the apple is a dimpled sphere with a stalk.
 *
 * The **tooth's** row is round 4's TM6 and it used to read `1.24 silhouette`: an ivory relief
 * on a near-ivory panel, so all a child saw at 100 px was two ink dots and a grin floating on
 * cream. It is now the best-separated card on the board, because its panel — and only its
 * panel — starts at `mauve.deep`. See `PANEL_BASE` in `scene.tsx` for why that is a
 * per-instance albedo rather than geometry, and why it does not leak anything a memory game
 * needs to protect.
 *
 * What the palette cannot do is separate seven motifs from **each other** by colour: all
 * five accent families live in a 355°–28° hue band by brand design, and their `main` and
 * `deep` tones sit between L 0.12 and L 0.45, so the best achievable separation between any
 * two of them is about 2.9:1 and the typical one is 1.2:1. Shape carries motif identity;
 * colour's job here is to lift each motif off the panel. That is a property of the brand
 * palette, not something to be fixed by picking differently.
 *
 * The tooth stays enamel-white, because a tooth that is not enamel-white is not a tooth —
 * what changed is the field behind it. Its face carries the rest: ink eyes at 12.3:1 and a
 * warm crevice-brown grin at 4.7:1 against enamel, the highest-contrast elements on any card.
 */
import { Path, Shape, SplineCurve, Vector2, type BufferGeometry, type Material } from "three";
import {
  beveledExtrude,
  latheProfile,
  mascotGeometry,
  mascotMaterial,
  roundedBox,
  roundedCylinder,
  softCapsule,
  torusSoft,
} from "../../three/geometry";
import { clayAccent, clayEnamel, clayPainted } from "../../three/materials";
import { CLAY } from "../../three/tokens";
import { MOTIF_IDS, type MotifId } from "./engine";
import {
  CARD_H,
  CARD_W,
  ELEV_COS,
  ELEV_SIN,
  INLAY_INSET,
  MOTIF_DZ,
  RELIEF_FAR_CLEAR,
  RELIEF_MARGIN_U,
  RELIEF_MARGIN_X,
  RELIEF_NEAR_CLEAR,
  RELIEF_FAR_Z,
  RELIEF_HALF_X,
  RELIEF_NEAR_Z,
  RELIEF_MAX_H,
  RELIEF_POP_PEAK,
  RELIEF_U_SPAN,
  MOTIF_FOOT_BAND,
  SILHOUETTE_FAR_Z,
  SILHOUETTE_NEAR_Z,
  screenUp,
} from "./layout";

export type MotifPart = {
  geometry: BufferGeometry;
  material: Material;
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
  /**
   * Reliefs are small and there can be twenty-six of them on screen at once, so only the
   * dominant mass of each motif casts. The secondary parts sit inside that silhouette and
   * their shadows would be a shadow-pass draw call for a difference nobody can see.
   */
  castShadow: boolean;
};

/**
 * A motif, plus the placement `fitRelief` solved for it.
 *
 * `scale` and `z` are per motif on purpose. A toothbrush is a thin vertical stick and a
 * star is a wide disc; one shared scale would have to serve the worst of them, and round 3's
 * central complaint about this product is that its subjects are too small in frame. There is
 * no physical relationship between the size of a toothbrush and the size of a star, so
 * there is nothing to preserve by tying them together — and every relief being fitted to its
 * own card is what an icon set is.
 */
export type FittedMotif = {
  parts: MotifPart[];
  /** Uniform scale applied to the whole motif group. */
  scale: number;
  /** Card-space z the motif's base sits at, so it is centred on the card *on screen*. */
  z: number;
};

const NO_ROT: [number, number, number] = [0, 0, 0];
const ONE: [number, number, number] = [1, 1, 1];
/** Lay a ring or a disc flat, hole pointing up. */
const FLAT: [number, number, number] = [-Math.PI / 2, 0, 0];

const part = (
  geometry: BufferGeometry,
  material: Material,
  position: [number, number, number],
  rotation: [number, number, number] = NO_ROT,
  scale: [number, number, number] = ONE,
  castShadow = false
): MotifPart => ({ geometry, material, position, rotation, scale, castShadow });

/* ------------------------------------------------------------------ */
/* Shape builders                                                      */
/* ------------------------------------------------------------------ */

/**
 * A closed, everywhere-smooth polar outline: `r(θ) = rMin + (rMax − rMin)·q^p`, where
 * `q = (1 + cos(lobes·θ)) / 2`.
 *
 * A star drawn with `lineTo` has acute corners, and 3D-SPEC §3 forbids a hard silhouette
 * corner anywhere in this product — a bevel on the rim does not fix a point you can cut
 * yourself on when seen from above. Sampling a smooth radius function instead gives points
 * whose tips are genuinely rounded, at no extra cost.
 *
 * **`p` is what round 3 added, and it is the difference between a star and a flower.** With
 * `p = 1` the function is a pure cosine: tips and valleys are equally round, and the outline
 * reads as petals however deep the lobes are cut. The curvature at a tip is
 * `ρ = rMax² / (rMax + 12.5·p·(rMax − rMin))` and the valley flattens toward an arc of
 * radius `rMin` as `p` rises — so `p > 1` sharpens the point and *broadens* the valley,
 * which is exactly the asymmetry that makes a shape read as a star. `p < 1` does the
 * opposite and produces a gear.
 */
function lobedShape(lobes: number, rMin: number, rMax: number, p: number, samples: number): Shape {
  const shape = new Shape();
  const span = rMax - rMin;
  for (let i = 0; i < samples; i++) {
    const a = (i / samples) * Math.PI * 2;
    const q = (1 + Math.cos(lobes * a)) / 2;
    const r = rMin + span * Math.pow(q, p);
    const x = Math.cos(a - Math.PI / 2) * r;
    const y = Math.sin(a - Math.PI / 2) * r;
    if (i === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  }
  shape.closePath();
  return shape;
}

/**
 * A symmetric upright silhouette from a `[y, halfWidth]` profile, capped at each end.
 *
 * This is the workhorse for the props whose identity lives in a 2D outline — the brush's
 * waisted handle, the tube's crimped tail and shoulder, the floss pack's lid step. It exists
 * because those tells cannot be built out of `roundedBox`es: a waist *is* the shape, and two
 * stacked boxes are two stacked boxes.
 *
 * The profile is resampled through a spline, so a handful of control points describes a
 * curve with no visible facets — the same trick `latheProfile` uses, for the same reason.
 *
 * **Both caps are tangent-vertical where they meet the profile**, so every profile here
 * begins and ends with a short vertical collar. Without it the join is a corner whose radius
 * is `edgeLength / turnAngle`, and the first pass at the tube and the pack measured 0.0117
 * and 0.0077 there against §3's 0.02 — a hard silhouette corner on a prop a child looks at
 * from 30 cm. Caught by auditing the outline's discrete convex curvature rather than by
 * looking at it, which is the only way a 1 cm feature gets caught at all.
 *
 * A cap is a semicircle of the end half-width by default — right for a handle, wrong for a
 * box, whose end has to be flat with a real corner fillet. `flatTop` / `flatBottom` give that
 * fillet, and the arcs are tangent to the sides at both ends of it by construction.
 */
type StalkEnds = {
  samples?: number;
  capSegments?: number;
  /** Fillet radius of a *flat* bottom end. Omitted = a semicircular one. */
  flatBottom?: number;
  /** Fillet radius of a flat top end. */
  flatTop?: number;
};

function stalkShape(profile: [number, number][], ends: StalkEnds = {}): Shape {
  const samples = ends.samples ?? 30;
  const capSegments = ends.capSegments ?? 9;
  const pts = new SplineCurve(profile.map(([y, hw]) => new Vector2(hw, y))).getPoints(samples);
  // A spline through a stepped profile can undershoot; a negative half-width would fold the
  // outline through its own axis and hand `ExtrudeGeometry` a self-intersecting contour.
  for (const p of pts) if (p.x < 0.006) p.x = 0.006;

  const shape = new Shape();
  const first = pts[0];
  const last = pts[pts.length - 1];
  const arc = (cx: number, cy: number, r: number, from: number, to: number) => {
    for (let i = 1; i <= capSegments; i++) {
      const a = from + ((to - from) * i) / capSegments;
      shape.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    }
  };
  const HALF = Math.PI / 2;

  shape.moveTo(first.x, first.y);
  for (let i = 1; i < pts.length; i++) shape.lineTo(pts[i].x, pts[i].y);
  if (ends.flatTop === undefined) {
    arc(0, last.y, last.x, 0, Math.PI);
  } else {
    const r = Math.min(ends.flatTop, last.x * 0.9);
    arc(last.x - r, last.y, r, 0, HALF);
    shape.lineTo(-(last.x - r), last.y + r);
    arc(-(last.x - r), last.y, r, HALF, Math.PI);
  }
  for (let i = pts.length - 1; i >= 0; i--) shape.lineTo(-pts[i].x, pts[i].y);
  if (ends.flatBottom === undefined) {
    arc(0, first.y, first.x, Math.PI, 2 * Math.PI);
  } else {
    const r = Math.min(ends.flatBottom, first.x * 0.9);
    arc(-(first.x - r), first.y, r, Math.PI, Math.PI + HALF);
    shape.lineTo(first.x - r, first.y - r);
    arc(first.x - r, first.y, r, Math.PI + HALF, 2 * Math.PI);
  }
  shape.closePath();
  return shape;
}

/**
 * The bristle block: a rounded slab whose top edge is combed into `teeth` tufts.
 *
 * The comb is the whole reason the brush is not "two bars". A flat-topped block on a stick
 * is a spatula; four tufts on top of it is a toothbrush, and it survives being 60 px tall
 * because the tufts break the one edge a child's eye lands on.
 */
function combShape(halfWidth: number, height: number, teeth: number, arcSegments = 6): Shape {
  // `teeth` tufts span the full `2 * halfWidth`, so one tuft's radius is `halfWidth / teeth`
  // and its centres are `2 * tuft` apart. That radius is a convex silhouette feature and is
  // therefore held at or above §3's 0.02: four tufts on a 0.082 half-width is 0.0205.
  const tuft = halfWidth / teeth;
  const foot = Math.max(0.02, tuft * 0.9);
  const shape = new Shape();
  shape.moveTo(halfWidth, foot);
  shape.lineTo(halfWidth, height - tuft);
  for (let t = 0; t < teeth; t++) {
    // Tuft centres run from the right edge to the left, each a semicircular bump.
    const cx = halfWidth - tuft * (2 * t + 1);
    for (let i = 0; i <= arcSegments; i++) {
      const a = (i / arcSegments) * Math.PI;
      shape.lineTo(cx + Math.cos(a) * tuft, height - tuft + Math.sin(a) * tuft);
    }
  }
  shape.lineTo(-halfWidth, foot);
  // Rounded bottom corners, so the block meets the handle without a cut edge.
  for (let i = 0; i <= arcSegments; i++) {
    const a = Math.PI + (i / arcSegments) * (Math.PI / 2);
    shape.lineTo(-halfWidth + foot + Math.cos(a) * foot, foot + Math.sin(a) * foot);
  }
  shape.lineTo(halfWidth - foot, 0);
  for (let i = 0; i <= arcSegments; i++) {
    const a = -Math.PI / 2 + (i / arcSegments) * (Math.PI / 2);
    shape.lineTo(halfWidth - foot + Math.cos(a) * foot, foot + Math.sin(a) * foot);
  }
  shape.closePath();
  return shape;
}

/**
 * A rounded diamond (a square on its point, with filleted corners), as an explicit point
 * list. Used twice by `quiltShape` — once as its outline and once as its hole.
 *
 * The fillet is a real circular arc tangent to both edges, so the corner radius is the
 * number passed and not an emergent property of a spline: 3D-SPEC §3's 0.02 floor is a
 * measurement of that arc, and this is the shape that has to satisfy it.
 */
function roundedDiamond(hx: number, hy: number, radius: number, arcSegments = 4): Vector2[] {
  // Half-angle of the corner at each of the four points, in the diamond's own frame.
  const pts: Vector2[] = [];
  const corners: [number, number][] = [
    [0, hy],
    [hx, 0],
    [0, -hy],
    [-hx, 0],
  ];
  for (let c = 0; c < 4; c++) {
    const p = corners[c];
    const prev = corners[(c + 3) % 4];
    const next = corners[(c + 1) % 4];
    // Unit vectors along the two edges leaving this corner.
    const ux = prev[0] - p[0];
    const uy = prev[1] - p[1];
    const vx = next[0] - p[0];
    const vy = next[1] - p[1];
    const ul = Math.hypot(ux, uy);
    const vl = Math.hypot(vx, vy);
    const ax = ux / ul;
    const ay = uy / ul;
    const bx = vx / vl;
    const by = vy / vl;
    // Half the angle between them; the fillet's tangent points sit `radius / tan(half)`
    // along each edge, and its centre `radius / sin(half)` along the bisector.
    const half = Math.acos(Math.max(-1, Math.min(1, ax * bx + ay * by))) / 2;
    const along = Math.min(radius / Math.tan(half), Math.min(ul, vl) * 0.49);
    const r = along * Math.tan(half);
    let mx = ax + bx;
    let my = ay + by;
    const ml = Math.hypot(mx, my) || 1;
    mx /= ml;
    my /= ml;
    const cx = p[0] + mx * (r / Math.sin(half));
    const cy = p[1] + my * (r / Math.sin(half));
    const t0 = Math.atan2(p[1] + ay * along - cy, p[0] + ax * along - cx);
    const t1 = Math.atan2(p[1] + by * along - cy, p[0] + bx * along - cx);
    // Shortest sweep between the two tangent points — the fillet never goes the long way.
    let sweep = t1 - t0;
    while (sweep > Math.PI) sweep -= 2 * Math.PI;
    while (sweep < -Math.PI) sweep += 2 * Math.PI;
    for (let i = 0; i <= arcSegments; i++) {
      const a = t0 + (sweep * i) / arcSegments;
      pts.push(new Vector2(cx + Math.cos(a) * r, cy + Math.sin(a) * r));
    }
  }
  return pts;
}

/**
 * The relief pressed into the back of every card.
 *
 * ## Why it is no longer a rosette (TM2)
 *
 * It was `lobedShape(6, 0.215, 0.3, 1)` in `peach.main` on `red.main`: a centred, warm-orange,
 * six-lobed radial rosette 0.65 across. The `star` card's relief is a centred, warm-orange,
 * five-lobed radial solid 0.66 across. Round 3 separated them by *silhouette ratio* — 3.35
 * against 1.44 — and round 4 photographed the two side by side and found the ratio had moved
 * while the gestalt had not: same hue family, same placement, same scale, both radially
 * lobed, both raised. At the ~100 px a card actually occupies, a child was being asked to
 * tell a five-petal flower from a six-petal one, on the one screen where telling two things
 * apart *is* the game.
 *
 * The fix list is explicit that the **back** changes, not the star, and it is right: the back
 * is wallpaper and the star is a card, so the back is the one that has to be unable to
 * collide with anything. So this is not another lobed outline with different numbers — it is
 * a different *kind* of thing:
 *
 *   • **not radial and not a solid.** A diamond band — an outline with a hole — reads as a
 *     quilted panel, a stitched seam, a texture. No motif in the set is an outline, and
 *     nothing in the set is a diamond. There is no shape family left in common to confuse.
 *   • **not orange.** `red.deep` on `red.main` is 1.55:1, deliberately: a card back is
 *     material, not information, and the loudest thing on a face-down board should be the
 *     medallion's own clay roll. The star keeps `peach.deep`, which now appears nowhere else.
 *   • **still the medallion's crown.** The rosette's other job was to stop the medallion
 *     being one plane with one normal (see `EMBLEM_DEPTH` in `layout.ts`). A band does that
 *     better than a dome: it is 0.177 wide and ~1.7 units long, so it lays a continuous
 *     rolled ridge across 31 % of the panel's area instead of one hill in the middle, and
 *     the hole is a 2.4 mm groove down to the medallion — a stitch line, with its own
 *     curvature-AO.
 *
 * Sizes are chosen against the *built* solid, not against the outline: `beveledExtrude` grows
 * the outline outward by `EMBLEM_BEVEL` and shrinks the hole inward by the same, and the
 * corner fillets pull each diamond point in by `r / sin(halfAngle) − r`, which is 0.054 at the
 * acute ends and 0.017 at the sides. Measured on the shipped buffer, the band is
 * **0.676 x 0.910** on a `0.74 x 1.00` medallion — 91 % of it in both axes, with 0.032 / 0.045
 * of clear red either side — and its crest is 0.141 wide in x and 0.201 in y against 0.052 of
 * bevel, so it keeps a real flat top to catch the key rather than rolling into a lens.
 *
 * §3: minimum convex curvature radius **0.075** on the outline and **0.055** on the hole,
 * against the 0.02 floor — 3.7x and 2.7x. It is also **640 triangles against the rosette's
 * 764**, so the card back got cheaper as well as quieter.
 */
export const emblemShape = (): Shape => {
  const shape = new Shape();
  const outline = roundedDiamond(0.327, 0.488, 0.075);
  shape.moveTo(outline[0].x, outline[0].y);
  for (let i = 1; i < outline.length; i++) shape.lineTo(outline[i].x, outline[i].y);
  shape.closePath();
  const hole = new Path();
  const inner = roundedDiamond(0.185, 0.27, 0.055);
  hole.moveTo(inner[0].x, inner[0].y);
  for (let i = 1; i < inner.length; i++) hole.lineTo(inner[i].x, inner[i].y);
  hole.closePath();
  shape.holes.push(hole);
  return shape;
};

/**
 * The five-pointed star, for the `star` card.
 *
 * `rMax / rMin` = 3.06 on the shape and **3.35** on the built silhouette. Both measured by
 * binning the shipped vertex buffer into 720 polar bins: `[0.0980, 0.3281]`. The extrusion's
 * bevel grows a convex tip by its full width (0.30 -> 0.3281) and a broad valley by *nothing*
 * (0.098 -> 0.0980), so it deepens the star rather than filling it in — which is the opposite
 * of what a bevel does to a sharp concave notch, and the reason a `p > 1` profile survives
 * being extruded when a spiked polygon would not.
 *
 * `p = 1.35` is the largest exponent §3 allows. Exact polar curvature
 * `κ = (r² + 2r'² − r·r'') / (r² + r'²)^{3/2}`, swept at 40,000 samples, puts the minimum
 * convex radius at **0.0243**, at the tip; the floor is `MIN_BEVEL` = 0.02. Push `p` to 1.5
 * and it falls to 0.0210; the old cosine profile sat at 0.0293 and had nothing to show for it.
 *
 * Round 3 defended this against the card back by silhouette ratio alone — 3.35 against the
 * rosette's 1.44 — and round 4 photographed the two together and showed that a ratio is not a
 * gestalt: both were centred, warm-orange, radially lobed solids of the same size. The card
 * back is no longer any of those things (`emblemShape`), so the star is now the only lobed
 * radial solid, and the only `peach` object, on the board.
 */
export const starShape = (): Shape => lobedShape(5, 0.098, 0.3, 1.35, 96);


/* ------------------------------------------------------------------ */
/* Lathe profiles                                                      */
/* ------------------------------------------------------------------ */

/**
 * The rinsing cup: `[radius, height]` bottom to top.
 *
 * Narrow foot, walls that flare outward, and a rolled rim — so the silhouette is a trapezoid
 * standing on its short side, which is the mirror of the toothpaste tube's (wide crimped
 * base, shoulder, narrow neck). That opposition is deliberate: they are the two motifs most
 * at risk of collapsing into each other at 60 px, and it is the one pair the shapes alone
 * have to separate.
 */
const CUP_PROFILE: [number, number][] = [
  [0, 0],
  [0.115, 0],
  [0.128, 0.022],
  [0.163, 0.16],
  [0.186, 0.3],
  [0.196, 0.325],
];

/**
 * The apple: a dimpled crown and a dimpled base, not a sphere.
 *
 * Round 2 shipped `softSphere(0.2)` with a stem, and round 3 filed it next to the berry as
 * "a round blob with something on top" — twice. The profile turning back toward the axis at
 * the top (`0.155 -> 0.085 -> 0.032 -> 0` while the height *falls* from 0.325 to 0.303)
 * carves the well the stalk sits in, which is the one silhouette feature an apple has and a
 * berry does not.
 */
const APPLE_PROFILE: [number, number][] = [
  [0, 0.014],
  [0.075, 0],
  [0.155, 0.022],
  [0.205, 0.115],
  [0.208, 0.215],
  [0.155, 0.3],
  [0.085, 0.325],
  [0.032, 0.312],
  [0, 0.303],
];

/**
 * The berry: a teardrop standing on its **point**, wide and rounded at the shoulder.
 *
 * The old profile was the other way up — round at the bottom, tapering to a tip at the top
 * — which is the same silhouette family as the apple plus a stalk. Inverting it and taking
 * the widest radius down from 0.175 to 0.142 makes the pair read as "round" versus
 * "pointed" at any size: at 60 px that is the only difference either of them needs.
 */
const BERRY_PROFILE: [number, number][] = [
  [0, 0],
  [0.032, 0.006],
  [0.075, 0.055],
  [0.118, 0.145],
  [0.142, 0.245],
  [0.138, 0.305],
  [0.1, 0.335],
  [0, 0.345],
];

/** Height the mascot tooth is built at, before its fitted scale. */
const TOOTH_H = 0.46;

/**
 * Face-feature boost for the mascot tooth.
 *
 * A literal, because `mascotParts` needs it *before* the geometry `fitRelief` would measure
 * it from exists — so it is stated with the number it actually produces rather than with
 * the number it was hoped to produce. `MASCOT_FACE.eye.r` is 0.068 of the tooth's height, so
 * the pupil comes out `2 x 0.068 x TOOTH_H x TOOTH_FEATURE_SCALE x fittedScale` across;
 * against the solved camera at 900x700 with 132 px of chrome that is **22.5 / 17.8 / 14.6 px**
 * at Easy / Medium / Hard.
 *
 * Round 2 shipped 1.15 on a 0.42-unit tooth and measured 16.7 / 12.8 / 10.3, so this is a
 * 35 % larger face on a card that is the same size. 1.45 is inside `mascotParts`' own derived
 * `[0.72, 1.68]` clamp — which is bounded by the eye breaking the crown's outline — with
 * 14 % to spare, so the boost is real rather than silently clamped.
 */
const TOOTH_FEATURE_SCALE = 1.45;

export type MotifTable = Record<MotifId, FittedMotif>;

/* ------------------------------------------------------------------ */
/* The fit                                                            */
/* ------------------------------------------------------------------ */

/**
 * Scratch for `measureMotif`, so a mount does not churn the heap.
 *
 * `fzMin` / `fzMax` are the **footprint**'s z extent — the same measurement restricted to the
 * bottom `MOTIF_FOOT_BAND` of the motif's height, i.e. the part that is actually standing on
 * the panel. `zMin` / `zMax` are the whole silhouette. They are bounded against different
 * things; see `SILHOUETTE_NEAR_Z` in `layout.ts`.
 */
const _ext = { uMin: 0, uMax: 0, xHalf: 0, yMax: 0, zMin: 0, zMax: 0, fzMin: 0, fzMax: 0 };

/**
 * Measures a motif's real vertices, in card space, at unit scale.
 *
 * Every part carries a position, an Euler rotation and a scale, so the only honest extent is
 * the transformed one — the star is reclined and the stalk shapes are extruded about their
 * own mid-plane, and a bounding box taken before either would be wrong in both directions.
 * Three's Euler default order is XYZ, i.e. `R = Rx·Ry·Rz`; the motifs here only ever use one
 * axis at a time, but the full product is applied so a future part cannot quietly break it.
 */
function measureMotif(parts: MotifPart[]): typeof _ext {
  _ext.uMin = Infinity;
  _ext.uMax = -Infinity;
  _ext.xHalf = 0;
  _ext.yMax = 0;
  _ext.zMin = Infinity;
  _ext.zMax = -Infinity;
  _ext.fzMin = Infinity;
  _ext.fzMax = -Infinity;

  // Two passes, because the footprint band is a fraction of a height the first pass finds.
  // Both walk the same raw buffers; eight motifs is ~40k vertices, once, on mount.
  for (let pass = 0; pass < 2; pass++) {
  const footTop = pass === 0 ? 0 : _ext.yMax * MOTIF_FOOT_BAND;
  for (const p of parts) {
    const attr = p.geometry.getAttribute("position");
    // The raw buffer, not `getX/getY/getZ`. Every geometry here comes out of `finish()`, so
    // the attribute is a plain non-interleaved `BufferAttribute` with `itemSize` 3 — and the
    // accessor calls cost 3 ms across the eight motifs against a 16.7 ms scene-entry budget
    // (§9), which is a fifth of the whole budget spent on three method calls per vertex.
    const buf = attr.array as ArrayLike<number>;
    const stride = attr.itemSize;
    const [rx, ry, rz] = p.rotation;
    const [sx, sy, sz] = p.scale;
    const cx = Math.cos(rx);
    const sxr = Math.sin(rx);
    const cy = Math.cos(ry);
    const syr = Math.sin(ry);
    const cz = Math.cos(rz);
    const szr = Math.sin(rz);

    for (let i = 0, o = 0; i < attr.count; i++, o += stride) {
      let x = buf[o] * sx;
      let y = buf[o + 1] * sy;
      let z = buf[o + 2] * sz;
      // Rz
      let t = x * cz - y * szr;
      y = x * szr + y * cz;
      x = t;
      // Ry
      t = x * cy + z * syr;
      z = -x * syr + z * cy;
      x = t;
      // Rx
      t = y * cx - z * sxr;
      z = y * sxr + z * cx;
      y = t;

      x += p.position[0];
      y += p.position[1];
      z += p.position[2];

      if (pass === 0) {
        const u = screenUp(y, z);
        if (u < _ext.uMin) _ext.uMin = u;
        if (u > _ext.uMax) _ext.uMax = u;
        const ax = x < 0 ? -x : x;
        if (ax > _ext.xHalf) _ext.xHalf = ax;
        if (y > _ext.yMax) _ext.yMax = y;
        if (z < _ext.zMin) _ext.zMin = z;
        if (z > _ext.zMax) _ext.zMax = z;
      } else if (y <= footTop) {
        if (z < _ext.fzMin) _ext.fzMin = z;
        if (z > _ext.fzMax) _ext.fzMax = z;
      }
    }
  }
  }
  // A motif whose lowest vertices are all above the band (nothing is authored that way, but
  // a future one could be) falls back to the full silhouette rather than to an empty range.
  if (_ext.fzMin > _ext.fzMax) {
    _ext.fzMin = _ext.zMin;
    _ext.fzMax = _ext.zMax;
  }
  return _ext;
}

/** Bisection steps for the scale search. 24 halvings resolve to 6e-8 of the range. */
const FIT_PASSES = 24;

/**
 * Solves the largest scale, and the card-space z, that keep a motif inside its own card.
 *
 * Four constraints, all of them screen-space or footprint, none of them taste:
 *
 *   1. the relief's screen-up span fits `RELIEF_U_SPAN` — the card's own face minus a margin
 *      each side. This is the one round 3 photographed being broken.
 *   2. its half-width fits `RELIEF_HALF_X`.
 *   3. it stands no taller than `RELIEF_MAX_H`, which is what `cameraFor` reserves sky for.
 *   4. its *footprint* — the vertices in the bottom `MOTIF_FOOT_BAND` of its height — stays
 *      on the printed panel, and its whole silhouette stays over the card. Two bounds, not
 *      one, because a real object standing on a printed field may overhang it but may not
 *      *stand* off it: `MOTIF_DZ` is measured from the panel's top face, so a base past the
 *      panel edge floats a panel-thickness above the ivory frame under it.
 *
 * (1) and (4) fight: centring a tall relief on screen slides it toward the card's near edge,
 * because a card converts length to screen-up at `sin E` and a standing relief converts
 * height at `cos E`. So the z window is intersected from both, and the scale is bisected
 * down until that window is non-empty. Closed form would need a case split per motif; a
 * 24-step bisection on a monotone predicate runs once per mount for eight motifs and cannot
 * get the case split wrong.
 */
function fitRelief(parts: MotifPart[], id: string): { scale: number; z: number } {
  const e = measureMotif(parts);
  const uSpan = e.uMax - e.uMin;
  const anchorU = MOTIF_DZ * ELEV_COS;

  /*
   * Everything below is solved for the **largest scale the relief ever reaches**, and the
   * fitted scale is that divided by `RELIEF_POP_PEAK` — see that constant in `layout.ts`.
   *
   * `scene.tsx` renders the relief at `easeOutBack(faceOut, MOTIF_POP_BACK) * scale`, which
   * peaks 8.98 % above `scale` on every reveal. Solving for `scale` and asserting on `scale`
   * meant the file's own header claim ("every vertex … inside the card's outline and inside
   * its footprint") was true at rest and false for ~90 ms of every flip — which is the frame
   * round 4 photographed, with the star 5.4 % outside the printed panel.
   *
   * `z` needs no pop budget of its own: the group scales about its own origin, and the
   * `window` below is monotone in `s` (both bounds relax as `s` falls), so a `z` valid at the
   * peak is valid at every smaller scale on the way there.
   */
  const pop = RELIEF_POP_PEAK;

  /** The z window a given *peak* scale allows, as `[lo, hi]`; empty when `lo > hi`. */
  const window = (s: number): [number, number] => {
    // Screen-up: the top may not pass the card's far edge, the bottom may not pass its near
    // edge. Both solve to a bound on z because z is what slides the relief up and down.
    const zFromTop = (anchorU + s * e.uMax - RELIEF_U_SPAN / 2) / ELEV_SIN;
    const zFromBottom = (anchorU + s * e.uMin + RELIEF_U_SPAN / 2) / ELEV_SIN;
    // Footprint against the panel, whole silhouette against the card.
    const lo = Math.max(
      zFromTop,
      -RELIEF_FAR_Z - s * e.fzMin,
      -SILHOUETTE_FAR_Z - s * e.zMin
    );
    const hi = Math.min(
      zFromBottom,
      RELIEF_NEAR_Z - s * e.fzMax,
      SILHOUETTE_NEAR_Z - s * e.zMax
    );
    return [lo, hi];
  };

  let hiS = Math.min(
    RELIEF_U_SPAN / uSpan,
    RELIEF_HALF_X / e.xHalf,
    RELIEF_MAX_H / e.yMax
  );
  let loS = 0;
  const [w0, w1] = window(hiS);
  if (w0 > w1) {
    for (let i = 0; i < FIT_PASSES; i++) {
      const mid = (loS + hiS) / 2;
      const [lo, hi] = window(mid);
      if (lo <= hi) loS = mid;
      else hiS = mid;
    }
    hiS = loS;
  }

  /** The peak scale the solve allows; what the child sees at the top of the reveal pop. */
  const peak = hiS;
  const [lo, hi] = window(peak);
  // Centre the relief on the card in screen-up, then pull it into whichever bound is
  // binding. `clamp`, not `min`/`max` in sequence: the window is guaranteed non-empty here.
  const centred = (anchorU + peak * ((e.uMin + e.uMax) / 2)) / ELEV_SIN;
  const z = centred < lo ? lo : centred > hi ? hi : centred;
  const scale = peak / pop;

  if (import.meta.env.DEV) {
    /*
     * Asserted at the peak, because the peak is the thing that has to fit — and asserted
     * against bounds **restated from the card's own dimensions**, not against the derived
     * constants the solve above used.
     *
     * Round 4 shipped this block reading `RELIEF_HALF_X`, `RELIEF_U_SPAN` and the two `Z`
     * bounds directly. `peak` is `min(RELIEF_U_SPAN / uSpan, RELIEF_HALF_X / e.xHalf, …)`
     * and `z` is clamped into the window those same constants define, so every line of the
     * check was true by construction: a negative control that replaced `pop` with 1 — the
     * exact round-4 defect TM5 filed — left it silent. A check that calls the code it checks
     * can only ever agree with it (A12).
     *
     * The restatement below is one line of arithmetic per bound, from `CARD_W`, `CARD_H`,
     * `INLAY_INSET`, `ELEV_SIN` and the two margins, so moving a derived constant no longer
     * moves the bar and the measurement together. This is what `?selftest=tooth-match-reliefs`
     * does in the browser; it costs nothing to do it here too, where it runs on every boot.
     */
    const cardHalfU = (CARD_H / 2) * ELEV_SIN;
    const panelHalfX = (CARD_W - INLAY_INSET) / 2;
    const panelHalfZ = (CARD_H - INLAY_INSET) / 2;
    const reliefHalfX = panelHalfX - RELIEF_MARGIN_X;
    const nearZ = panelHalfZ - RELIEF_NEAR_CLEAR;
    const farZ = panelHalfZ - RELIEF_FAR_CLEAR;
    const silNearZ = CARD_H / 2 - RELIEF_NEAR_CLEAR;
    const silFarZ = CARD_H / 2 - RELIEF_FAR_CLEAR;
    /*
     * The quantity checked is the size the child sees at the top of the reveal, re-derived
     * from what this function *returns* — `scale` — times the pop peak, and not from `peak`
     * itself. `peak` is the solve's own working value and asserting it is a tautology: it is
     * `min(span/uSpan, halfX/xHalf, maxH/yMax)` by the four lines above, so "does `peak` fit"
     * has one possible answer. `scale * RELIEF_POP_PEAK` is the product of a returned value
     * and an independent constant, so it goes wrong exactly when the budget stops being paid
     * — which is TM5's defect, and what a negative control that sets the local `pop` to 1
     * has to be able to catch.
     */
    const rendered = scale * RELIEF_POP_PEAK;
    const top = anchorU - z * ELEV_SIN + rendered * e.uMax;
    const bottom = anchorU - z * ELEV_SIN + rendered * e.uMin;
    const half = cardHalfU - RELIEF_MARGIN_U;
    const failures: string[] = [];
    if (scale <= 0) failures.push("scale collapsed to zero");
    if (top > half + 1e-6 || bottom < -half - 1e-6) {
      failures.push(
        `screen-up span [${bottom.toFixed(4)}, ${top.toFixed(4)}] against +-${half.toFixed(4)}`
      );
    }
    if (rendered * e.xHalf > reliefHalfX + 1e-6) {
      failures.push(
        `half-width ${(rendered * e.xHalf).toFixed(4)} against ${reliefHalfX.toFixed(4)}`
      );
    }
    if (z + rendered * e.fzMax > nearZ + 1e-6 || z + rendered * e.fzMin < -farZ - 1e-6) {
      failures.push(
        `footprint z [${(z + rendered * e.fzMin).toFixed(4)}, ${(z + rendered * e.fzMax).toFixed(4)}] ` +
          `off the panel [${(-farZ).toFixed(4)}, ${nearZ.toFixed(4)}]`
      );
    }
    if (
      z + rendered * e.zMax > silNearZ + 1e-6 ||
      z + rendered * e.zMin < -silFarZ - 1e-6
    ) {
      failures.push(
        `silhouette z [${(z + rendered * e.zMin).toFixed(4)}, ${(z + rendered * e.zMax).toFixed(4)}] ` +
          `off the card [${(-silFarZ).toFixed(4)}, ${silNearZ.toFixed(4)}]`
      );
    }
    if (failures.length > 0) {
      console.error(
        `[tooth-match] motif "${id}" cannot be fitted to its card at the reveal pop ` +
          `(x${pop.toFixed(4)}): ${failures.join("; ")}. Rebuild the motif smaller, or raise ` +
          `RELIEF_MAX_H and re-check the camera solve.`
      );
    }
  }

  return { scale, z };
}

/* ------------------------------------------------------------------ */
/* The eight                                                           */
/* ------------------------------------------------------------------ */

/**
 * Builds all eight motifs. Call once — from `scene.tsx`'s `ensureMotifs`, on the **second**
 * frame after mount rather than in the mount commit; see that function for why (TM3).
 *
 * Materials are deliberately drawn from a small set — the whole board runs on well under
 * twenty clay materials, inside the 28-material budget, because every factory call with the
 * same arguments returns the same cached instance.
 *
 * **Part counts are a draw-call budget, not a tidiness preference.** The eight motifs are
 * `1 / 3 / 2 / 2 / 2 / 1 / 2 / 2` meshes and every motif appears exactly twice, so a fully
 * solved Hard board — the one state in which all sixteen reliefs stand at once — draws **30**
 * relief meshes plus 8 board fixtures = 38 colour-pass calls, and 17 in the shadow pass: 55
 * against §9's ceiling of 60. Round 4's arrangement was 46 + 8 + 17 = **71**, i.e. over the
 * budget in the state a child reaches by winning, and nothing had measured it because the
 * captures are all of face-down boards. The tooth is what closed that gap: `mascotGeometry`
 * merges nine meshes into one (see the comment on `toothParts`).
 */
export function buildMotifs(): MotifTable {
  const enamel = clayEnamel();
  const redDeep = clayAccent("red", "deep");
  const redMain = clayAccent("red", "main");
  const roseMain = clayAccent("rose", "main");
  const roseDeep = clayAccent("rose", "deep");
  const coralDeep = clayAccent("coral", "deep");
  const peachDeep = clayAccent("peach", "deep");
  const mauveDeep = clayAccent("mauve", "deep");
  const stem = clayPainted(CLAY.crevice);

  /*
   * The tooth card is the product's mascot, not a bare tooth.
   *
   * `limbs: false`. Arms and feet are what turn a rooted tooth into a character when it is a
   * game's *hero*; here the tooth is one icon in a set of eight, and four extra meshes per
   * card on the one board in the product that can have sixteen reliefs standing at once. The
   * grin does the character work at this size.
   *
   * `mascotGeometry`, not `mascotParts`, and the difference is draw calls. A faced mascot is
   * **nine meshes**; two tooth cards on a solved Hard board is eighteen of them, against §9's
   * ceiling of 60 for the whole frame. Merged it is one mesh and one material, with the face
   * carried on `ALBEDO_ATTRIBUTE` — which is the case `geometry.ts` built the merge for
   * ("a screen that wants a lot of static characters"). Nothing here animates a part: the
   * relief scales as a whole and never blinks or opens its mouth, so the merge costs this
   * game nothing at all. Measured: a fully solved Hard board goes from 46 relief meshes to
   * **30**, i.e. 54 colour-pass calls to 38.
   */
  const toothParts: MotifPart[] = [
    part(
      mascotGeometry({
        height: TOOTH_H,
        detail: 1,
        featureScale: TOOTH_FEATURE_SCALE,
        open: 0.45,
        limbs: false,
      }),
      mascotMaterial(),
      [0, 0, 0],
      NO_ROT,
      ONE,
      true
    ),
  ];

  const raw: Record<MotifId, MotifPart[]> = {
    /* The mascot: a smiling baby tooth, the same face the rest of the product wears. */
    tooth: toothParts,

    /*
     * Toothbrush: a slim deep-red stick, a coral ferrule, then an ivory head combed into
     * four tufts.
     *
     * ## What was wrong (TM4)
     *
     * The handle was a `[0.04 … 0.056]` half-width profile at `bevel: 0.022`, and the bevel
     * is the half that got missed: `beveledExtrude` grows a silhouette outward by the full
     * bevel on each side, so the *built* handle was **0.156** wide against a built head of
     * 0.204 — a ratio of **0.76**, over a length of 0.31. That is not a stick with a head on
     * it; it is a lozenge with a cap on it, and round 4 read it as "a red bean under a white
     * cap", with the second reading that an irregular saturated-red smear has in a paediatric
     * dental clinic (§1.1 adjacency). The waist was real but shallow — 0.038 against 0.056 on
     * the profile, and a further 0.022 of bevel each side flattened it to 88 % built.
     *
     * ## What it is now, and why these numbers
     *
     * The fix list asks for a handle ≈0.35x the head's width, a pinched neck, and an accent
     * ferrule so the half that names the object carries the contrast. All three, solved
     * against the **built** silhouette rather than against the profile, and every number here
     * is measured off the shipped buffers:
     *
     *   • **head 0.24 x 0.216, handle 0.1043 wide over 0.427.** Handle-to-head is **0.435**
     *     against the old 0.76. It is not the 0.35 the fix list names, and the reason is a
     *     floor rather than a preference: §3's `MIN_BEVEL` is 0.02, `beveledExtrude` adds it
     *     to each side, so the built handle cannot go under 0.08 whatever the profile says,
     *     and a head wide enough to make 0.08 a 0.35 ratio would be 0.23 wide against 0.216
     *     tall — wider than it is long, which is a paintbrush, not a toothbrush. 0.435 is the
     *     narrowest stick §3 permits under a head that still reads as a toothbrush head.
     *   • **a real waist.** Profile `0.032 grip → 0.020 neck → 0.028 shoulder`; the spline is
     *     checked not to undershoot (measured min 0.02001, so the 0.006 anti-fold clamp never
     *     fires). Built **0.1043 / 0.0800 / 0.0960** — the neck is **77 %** of the grip
     *     against the old 88 %.
     *   • **a `coral.deep` ferrule** between neck and bristles: the one high-contrast band on
     *     the prop, sitting exactly where a real brush has one, so the deep red reads as a
     *     handle rather than as an undifferentiated smear. 3.78:1 on the panel. It is 0.15
     *     wide — 1.44x the handle and 0.63x the head, so it is visible past both — and the
     *     handle takes a `flatTop` so its dome does not fill the collar. `roundedBox` derives
     *     its radius from the smallest half-extent, so the ferrule is 0.07 deep in y
     *     specifically to let a 0.026 roll through the clamp; at 0.036 it would have resolved
     *     to 0.0162, under §3, silently.
     *   • **§3 audited, not assumed.** Minimum convex curvature radius on the handle's built
     *     outline is **0.0200** (the `flatTop` fillet), at the floor and not under it, and the
     *     extrusion's own bevel enlarges it further; the comb's tuft radius is `0.1 / 4` =
     *     **0.025**.
     */
    brush: [
      part(
        beveledExtrude(
          stalkShape([
            [0.04, 0.032],
            [0.075, 0.032],
            [0.14, 0.03],
            [0.22, 0.024],
            [0.29, 0.02],
            [0.33, 0.024],
            [0.365, 0.028],
            [0.375, 0.028],
          ], { flatTop: 0.02 }),
          { depth: 0.055, bevel: 0.02 }
        ),
        redDeep,
        [0, 0, 0],
        NO_ROT,
        ONE,
        true
      ),
      part(roundedBox(0.15, 0.07, 0.072, 0.026), coralDeep, [0, 0.415, 0]),
      part(
        beveledExtrude(combShape(0.1, 0.175, 4), { depth: 0.058, bevel: 0.02 }),
        enamel,
        [0, 0.47, 0]
      ),
    ],

    /*
     * Toothpaste: a flat crimped tail, a body with a slight waist, a shoulder that tapers
     * into a narrow neck, and a ribbed ivory cap wider than the neck it sits on. The old
     * prop was a rounded slab plus a cylinder, which reads as a jam jar because a jar is
     * exactly that: straight sides and a lid. The taper and the flat tail are the difference,
     * and they run the silhouette the opposite way round from the cup's — wide at the bottom
     * and narrow at the top, against the cup's narrow foot and open rim. Those two are the
     * pair most at risk of collapsing into each other at 60 px.
     */
    paste: [
      part(
        beveledExtrude(
          stalkShape(
            [
              [0.03, 0.098],
              [0.05, 0.098],
              [0.1, 0.094],
              [0.15, 0.104],
              [0.245, 0.099],
              [0.298, 0.064],
              [0.332, 0.042],
              [0.352, 0.04],
            ],
            { flatBottom: 0.03 }
          ),
          { depth: 0.098, bevel: 0.026 }
        ),
        roseMain,
        [0, 0, 0],
        NO_ROT,
        ONE,
        true
      ),
      part(roundedCylinder(0.046, 0.075, 0.022), enamel, [0, 0.4, 0]),
    ],

    /* Rinsing cup, with a rolled rim so the lip is never a knife edge. */
    cup: [
      part(latheProfile(CUP_PROFILE), mauveDeep, [0, 0, 0], NO_ROT, ONE, true),
      part(torusSoft(0.19, 0.03), enamel, [0, 0.325, 0], FLAT),
    ],

    /*
     * Floss: a pack whose outline steps outward at the top — that step is the lid seam —
     * with a loop of thread pulled out of the slot at the bottom front, where floss comes
     * out of a real dispenser.
     */
    floss: [
      part(
        beveledExtrude(
          stalkShape(
            [
              [0.03, 0.138],
              [0.052, 0.138],
              [0.16, 0.134],
              [0.208, 0.15],
              [0.248, 0.148],
              [0.27, 0.148],
            ],
            { flatBottom: 0.03, flatTop: 0.032 }
          ),
          { depth: 0.112, bevel: 0.026 }
        ),
        coralDeep,
        [0, 0, 0],
        NO_ROT,
        ONE,
        true
      ),
      part(torusSoft(0.058, 0.021), enamel, [0, 0.082, 0.098]),
    ],

    /* A rounded five-pointed star. See `starShape` for why it is not a flower any more. */
    star: [
      part(
        beveledExtrude(starShape(), { depth: 0.09, bevel: 0.026 }),
        peachDeep,
        [0, 0.334, 0],
        NO_ROT,
        ONE,
        true
      ),
    ],

    /* Apple: a lathed body with a dimpled crown and base, and a clay stalk in the well. */
    apple: [
      part(latheProfile(APPLE_PROFILE), redMain, [0, 0, 0], NO_ROT, ONE, true),
      part(softCapsule(0.021, 0.05), stem, [0.012, 0.345, 0], [0, 0, 0.24]),
    ],

    /* Berry: a point-down teardrop under a soft calyx collar. */
    berry: [
      part(latheProfile(BERRY_PROFILE), roseDeep, [0, 0, 0], NO_ROT, ONE, true),
      part(torusSoft(0.098, 0.028), mauveDeep, [0, 0.322, 0], FLAT),
    ],
  };

  const table = {} as MotifTable;
  for (const id of MOTIF_IDS) {
    const parts = raw[id];
    // Cheap guard against a motif being added to the pool without art: a missing entry would
    // render as an empty card face and would be very easy to miss in review.
    if (!parts || parts.length === 0) {
      throw new Error(`[tooth-match] motif "${id}" has no relief parts`);
    }
    const { scale, z } = fitRelief(parts, id);
    table[id] = { parts, scale, z };
  }

  return table;
}
