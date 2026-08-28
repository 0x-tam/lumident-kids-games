/**
 * Tooth Runner — every prop in the game, as procedural clay.
 *
 * Two families live here and they share one shape, `PartDef`: a cached geometry, a cached
 * material and a **constant** local matrix. Everything the scene draws is one of these
 * parts instanced across a pool, and a pool member's world matrix is always
 * `propMatrix × part.offset` — one `multiplyMatrices` per part per instance per frame, no
 * scene-graph traversal, no per-object `Object3D`.
 *
 *   • `buildItems()`    — the five things that come down the lane. Two pickups and three
 *                          sweets, exactly the 2D game's set.
 *   • `buildScatters()` — the scenery. Eight recycled pools across three depth bands: the
 *                          near lane the tooth runs on, mid-ground clay props, and a far
 *                          silhouette ridge that separates out of the cream.
 *
 * Nothing here is built at module import time — `buildItems`/`buildScatters` are called
 * from the scene's first render, so all of it lands in this game's chunk and costs the hub
 * nothing. Every geometry comes back from `geometry.ts`'s cache and every material from
 * `materials.ts`'s, both `markShared`, so **there is nothing in this file a game is allowed
 * to dispose**. The only resource Tooth Runner constructs itself is the sparkle material in
 * `scene.tsx`, and that one is in a `DisposalBag`.
 *
 * The per-instance scatter tables are drawn from a seeded PRNG rather than `Math.random`,
 * so the roadside looks identical on every run and every reload — the randomisation the
 * brief asks to preserve is the *item* randomisation, and a world that reshuffles itself
 * behind the child every time they press restart reads as a glitch, not as variety.
 */
import {
  Euler,
  Matrix4,
  Quaternion,
  Shape,
  Vector3,
  type BufferGeometry,
  type Material,
} from "three";
import {
  bakeCurvatureAO,
  beveledExtrude,
  cachedGeometry,
  jitterSurface,
  latheProfile,
  roundedBox,
  roundedCylinder,
  softSphere,
  torusSoft,
} from "../../three/geometry";
import { clay, clayAccent, clayEnamel, clayIvory } from "../../three/materials";
import { getQuality } from "../../three/quality";
import { NEUTRAL, type AccentFamily } from "../../three/tokens";
import { GAMES } from "../index";
import {
  FAR_SPAN,
  FAR_Z0,
  GATE_SPAN,
  GATE_Z0,
  GROUND_Y,
  LANE_HALF,
  MID_SPAN,
  MID_Z0,
  NEAR_SPAN,
  NEAR_Z0,
  RATE_FAR,
  RATE_FAR_REDUCED,
  RATE_MID,
  RATE_MID_REDUCED,
  RATE_NEAR,
} from "./layout";

/* ------------------------------------------------------------------ */
/* Part plumbing                                                       */
/* ------------------------------------------------------------------ */

export type PartDef = {
  geometry: BufferGeometry;
  material: Material;
  /** Constant transform of this part inside its prop. Never mutated after build. */
  offset: Matrix4;
  castShadow: boolean;
  receiveShadow: boolean;
};

const _e = new Euler();
const _q = new Quaternion();

type PartOpts = {
  pos?: [number, number, number];
  rot?: [number, number, number];
  scale?: [number, number, number];
  cast?: boolean;
  receive?: boolean;
};

function part(geometry: BufferGeometry, material: Material, opts: PartOpts = {}): PartDef {
  const [px, py, pz] = opts.pos ?? [0, 0, 0];
  const [rx, ry, rz] = opts.rot ?? [0, 0, 0];
  const [sx, sy, sz] = opts.scale ?? [1, 1, 1];
  _e.set(rx, ry, rz);
  _q.setFromEuler(_e);
  return {
    geometry,
    material,
    offset: new Matrix4().compose(new Vector3(px, py, pz), _q, new Vector3(sx, sy, sz)),
    castShadow: opts.cast ?? false,
    receiveShadow: opts.receive ?? true,
  };
}

/**
 * Level-of-detail cap for scenery.
 *
 * `geometry.ts` reads the device tier when no `detail` is passed, so a high-tier tablet
 * would subdivide a background hill exactly as finely as the hero tooth. These props are
 * 20 to 80 units away and instanced dozens deep, which is where the triangle budget
 * actually goes — so they are capped, and still drop with the tier underneath the cap.
 */
const lod = (max: number) => Math.min(max, getQuality().detail);

/** Deterministic PRNG (mulberry32) so the roadside is the same on every run. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------ */
/* The five things that come down the lane                             */
/* ------------------------------------------------------------------ */

/**
 * A five-pointed star whose points actually read as points.
 *
 * The shape has to be smooth — 3D-SPEC §3 forbids a hard silhouette corner and a rim bevel
 * cannot fix a corner you are looking at face-on — so it stays a polar curve rather than ten
 * `lineTo`s. What changed is *which* polar curve.
 *
 * The old one was `r = mid + amp·cos(5θ)`. Its tip radius of curvature is
 * `R = r² / (r − r'')` with `r'' = −25·amp`, which at `outer 0.28 / inner 0.135` is
 * **0.0375 units — 13 % of the star's own radius**. That is a petal, and round 3
 * photographed exactly that: `tooth-runner-jump-i04.png` shows a five-lobed flower. (The
 * critic attributed it to `bevel: 0.03`; the bevel only rolls the rim along Z — the widest
 * cross-section of `extrudeSlab` is the outline itself, so the outline is the whole cause.)
 *
 * This one is `r = inner + (outer − inner)·cos²(2.5θ)^p`. The exponent sharpens the tips and
 * flattens the valleys at the same time, and both effects are what makes a star a star:
 *
 *   r''(tip) = −2·(outer − inner)·6.25·p   ⇒   R = outer² / (outer + 12.5·p·(outer − inner))
 *
 * At `outer 0.33 / inner 0.07 / p 1.4`: **R = 0.0223 units**, just over `MIN_BEVEL` (0.02),
 * which is the tightest a silhouette in this product is allowed to be — so it is as pointed
 * as §3 permits and not one unit more. Two things change together, and both matter: the
 * valley drops from 0.135 to 0.07, which is what makes the five spikes *separate* rather
 * than merge into a rosette, and the exponent keeps the tips from blunting as the valley
 * deepens. The spike is ±15.5° wide at half height out of the ±36° available.
 *
 * Neither number has room left. At this valley depth `p = 1.5` gives R = 0.0209 and
 * `p = 1.6` gives 0.0197 — under the floor. The pairing is the binding solution, not a
 * preference.
 */
const STAR_POWER = 1.4;

function starShape(outer: number, inner: number, points = 5, power = STAR_POWER): Shape {
  const span = outer - inner;
  const half = points / 2;
  const segs = points * 24;
  const shape = new Shape();
  for (let i = 0; i <= segs; i++) {
    const a = (i / segs) * Math.PI * 2 - Math.PI / 2;
    const lobe = Math.cos(half * (a + Math.PI / 2));
    const r = inner + span * Math.pow(lobe * lobe, power);
    const x = Math.cos(a) * r;
    const y = Math.sin(a) * r;
    if (i === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  }
  shape.closePath();
  return shape;
}

export type ItemKindDef = {
  parts: PartDef[];
  /** Local axis the prop spins about — a star twirls face-on, a candy tumbles end over end. */
  axis: Vector3;
  label: string;
};

/**
 * The colour contract for this game, in one place.
 *
 * `src/games/index.ts` registers Tooth Runner under the **peach** family, and that is now
 * read from the registry rather than restated here — A15 found four scenes whose world
 * contradicted the card the child tapped, and a literal is exactly how that happens. Which
 * tone goes where is decided by height rather than by taste: the deep tone on the gateway
 * posts, which are measurably out of the chrome band; the main tone on the kerb pebbles and
 * near hills, which graze it; the soft tone on the roadside brush heads, which are the only
 * thing in the world that reaches into it. Mauve and rose survive in the far scenery, where
 * the fog has already taken most of them. See the gateway's note for the projection all
 * three follow from.
 *
 * ── The item vocabulary, and why it was inverted ───────────────────────────────
 *
 * Round 4 (RU2): *"a red ring drawn around an object is the universal sign for not this one.
 * The reward is the loudest object in the frame and the hazard is the quietest."* Both halves
 * were true and both were this table. The pickups wore a `red.main` halo 0.90 units across —
 * nearly as tall as the 1.0-unit hero — and the sweets were pushed deliberately to the
 * lowest-chroma family in the palette. A frame with three red rings stacked down the lane and
 * no visible sweet is a corridor of stop signs, and the rule the old comment taught ("red
 * means you can have it") is a rule the game invents, against one the child already has.
 *
 * The two families are still separated on three axes at once, so any one of them is enough —
 * what changed is which family gets which end of each axis. Measured in CIE L\*C\*h against
 * the lane (`CLAY.ivoryDeep`, L\* 89.2 C\* 10.2):
 *
 *   |            | grab (brush, star)                   | jump (candy, drink, donut)      |
 *   |---|---|---|
 *   | colour     | ivory body, **peach.deep** hoop+head | **rose**, one family            |
 *   |            | L\* 58.6 C\* 55.6 h 63° — amber      | L\* 50.5 C\* 57.8 h 23° — berry |
 *   |            | 2.52:1 on the lane, dE 55.6          | 3.35:1 on the lane, dE 66.4     |
 *   | silhouette | long, crossing a hoop                | low, wide, wrapped — never a ring |
 *   | motion     | twirls on the spot                   | dead still until it is knocked  |
 *
 * The salience ratio is what actually inverted. Reward-vs-hazard, as dE from the lane they
 * both sit on: it was `73.8 / 35.8` = **2.06** (the reward twice as loud as the hazard) and
 * it is now `55.6 / 66.4` = **0.84** — the hazard is the louder of the two, which is the sign
 * language a four-year-old brings with them. The hazard's own chroma more than doubles
 * (`mauve.main` C\* 27.4 → `rose.main` C\* 57.8, +111 %) and its lane contrast rises 43 %,
 * so "mark the sweet" is paid for in the sweet's own albedo rather than in a second decal
 * pass over a lane this game already cannot afford (see RU4).
 *
 * **Amber, not just "not red".** `peach.deep` is 36° of hue away from `red.main` and 40° from
 * `rose.main`, so nothing in the lane is within a family of it; it is the registered family's
 * dark anchor, so the mark is the game's own colour; and the hoop is a *thin* element (a
 * 0.09-unit rope, ~20 px at collection distance), which is why it takes the tone with real
 * luminance contrast — 2.52:1 on the lane against `peach.main`'s 1.60:1. A thin stroke needs
 * luminance; the eye's chroma channel does not resolve at that spatial frequency. The whole
 * pickup therefore reads ivory-and-deep-amber, and `peach.main` stays what it already was: the
 * *scenery's* tone, on the kerb pebbles and the near hills, so the thing you grab is never the
 * colour of the thing you run past.
 *
 * `red` and `coral` are used nowhere in this game any more — grep confirms it. The browser's
 * own focus outline on the play surface is `#b2343f`, which is `rose.deep`, so the one warm-red
 * ring a keyboard player can see now shares a family with the **hazards** rather than with the
 * reward. That is the other half of RU2's finding — *"compounded by the focus outline being the
 * same red"* — resolved in the direction that costs nothing: a warm-red outline and a warm-red
 * sweet both say *mind this one*, and neither says it about a toothbrush.
 */
export const GAME_ACCENT: AccentFamily =
  GAMES.find((g) => g.id === "tooth-runner")?.accent ?? "peach";

const AXIS_X = new Vector3(1, 0, 0);
const AXIS_Y = new Vector3(0, 1, 0);
const AXIS_Z = new Vector3(0, 0, 1);

/**
 * The hoop.
 *
 * Shrunk from 0.45 to 0.405 of outer radius (0.90 → 0.81 units across) and the pickup inside
 * it grown from 0.635 to 0.89, so the two swap roles: RU5 measured *"the brush spans 0.63 u
 * inside a 0.70 u void, so the **ring**, not the brush, is the silhouette a child parses"* —
 * and it was right, because a body that stops short of the band it is framed by is read as
 * cargo. The brush's head now clears the hoop's outer edge by 0.042 and its butt by 0.055, and
 * the star's five points reach 0.42 against the band's 0.405, so **the pickup crosses its own
 * mark** and the compound silhouette is the object rather than the frame.
 *
 * That only works because the hoop moved back far enough to stop intersecting. See `HALO_Z`.
 *
 * `REST_Y` in `engine.ts` follows from the outer radius exactly as it did before: a goodie
 * resting on the lane sits 0.50 up so the *whole* prop — which at some phase of the twirl is
 * the brush's 0.46 half-length, not the hoop — clears the surface instead of cutting into it.
 */
const HALO_R = 0.36;
const HALO_TUBE = 0.045;
/**
 * Behind the pickup, and far enough behind that nothing intersects it.
 *
 * The hoop's tube occupies z ∈ [HALO_Z − 0.045, HALO_Z + 0.045]. The deepest thing on either
 * pickup is the brush head's half-depth, 0.0775 (the star's is 0.0425), so a front face at
 * −0.105 clears the brush by 0.0275 and the star by 0.0625 at every angle of the twirl. Both
 * pickups spin about Z and the hoop spins with them, so this clearance is constant rather
 * than being the minimum of a sweep.
 *
 * It was −0.05, which was enough only while the body stayed *inside* the band. It is the
 * price of the swap above: the body may now cross the hoop, so the hoop has to be genuinely
 * behind it and not merely non-coplanar with it.
 */
const HALO_Z = -0.15;

/**
 * The hoop's geometry — a hand-rolled coil, not a lathe.
 *
 * RU6: *"`torusSoft`'s `finish()` runs `bakeCurvatureAO`, which has nothing to bite on because
 * a torus has no crevice and no exposed edge. Contrast-boosted 2.4× there is a single lighting
 * gradient and nothing else."* That is the same property this file already used to condemn the
 * arch — and it was never applied to the largest, most-frequently-on-screen object in the game.
 *
 * So the hoop takes `lumpySphere`'s path: clone the cached torus, push its welded vertices
 * along their normals by low-frequency fbm, then **re-bake the AO on the displaced surface**,
 * which is the whole point — the tint has to describe the coil that ships, not the ring it
 * started as. `amount` 0.0055 is 12 % of the tube radius, so the tube runs 0.0395–0.0505 around
 * the ring and never approaches `MIN_BEVEL` (0.02); `frequency` 5.5 lumps per world unit over
 * an 0.81-unit ring is ~4.5 swells around it — a coil rolled between two palms, not a machined
 * O-ring. The clone is mandatory: `torusSoft` hands back the shared cache entry, and jittering
 * that would displace the soda's waistband and the donut in the same frame.
 */
function haloGeometry(): BufferGeometry {
  const d = lod(2);
  return cachedGeometry(`tooth-runner/halo|${d}`, () => {
    const geo = torusSoft(HALO_R, HALO_TUBE, d).clone();
    jitterSurface(geo, 0.0055, 5.5, 41);
    bakeCurvatureAO(geo);
    geo.computeBoundingBox();
    geo.computeBoundingSphere();
    return geo;
  });
}

/** Indexed by the kind constants in `engine.ts`; order must match. */
export function buildItems(): ItemKindDef[] {
  const ivory = clayIvory();
  const enamel = clayEnamel();
  const peachDeep = clayAccent(GAME_ACCENT, "deep");
  const rose = clayAccent("rose", "main");
  const roseDeep = clayAccent("rose", "deep");
  const dough = clayAccent("mauve", "deep");

  /**
   * The shared mark. One geometry, one material, one offset — the two goodies literally
   * carry the same part, which is what makes them one family rather than two things that
   * happen to be the same colour. It sits `HALO_Z` behind the pickup so the pickup is always
   * read *through* it, and the pickup is free to cross it.
   */
  const halo = () =>
    part(haloGeometry(), peachDeep, { pos: [0, 0, HALO_Z], cast: true });

  /*
   * A toothbrush, lying broadside to the camera so its silhouette reads at a glance.
   *
   * ── What RU5 measured, and what each of the four parts now answers ─────────────
   *
   * *"No albedo, material or silhouette separation, so the tuft vanishes … what ships is a
   * white capsule with a red block on one end."* The tuft was `roundedBox` in **the handle's
   * own ivory**, directly under an ivory handle — three parts, two of them the same material,
   * so the three-part vocabulary the old comment described never survived to screen.
   *
   *  - **handle** — a *lathe*, not a box: a shaft that necks down toward the head and swells
   *    into a grip at the butt. A toothbrush handle is a surface of revolution with a waist,
   *    and a constant-section bar is the shape that read as "a thin white shaft" at lane
   *    distance. Six control points through `latheProfile`'s spline; 24 radial segments from
   *    the shared silhouette floor, so there is no facet at any tier.
   *  - **head** — `peach.deep`, and 0.21 × 0.175, which is 46 % taller than the block it
   *    replaces. Deep rather than main because this is where the *internal* read of the prop
   *    lives and both of its steps have to clear 3:1: head-against-handle is **3.09:1**
   *    (`peach.deep` L\* 58.6 vs ivory 97.0) where `peach.main` would give 1.96, and
   *    head-against-bristles is **3.19:1** where `peach.main` would give 2.03. It also keeps
   *    the collectible's tone distinct from the roadside's: the scenery is `peach.main` on the
   *    kerbs and near hills and `peach.soft` on the giant brush heads, so a deep head in the
   *    lane is not a colour anything else at that height wears.
   *  - **bristles** — `clayEnamel()`, the brightest, flattest material in the product, set
   *    0.085 below the head's centre so the pad hangs clear of both the head's underside and
   *    the handle's neck. The handle's own outline stops 0.0098 above the pad's top edge
   *    everywhere the two share an x, so the pad is proud of the handle silhouette by
   *    construction, not by a tuned offset — that is measured on the shipped lathe profile,
   *    not asserted. Against the handle it is 1.03:1, which is *correct*: bristles and a
   *    handle are both white, and the head is what stands between them.
   *
   * ── The §1.1 read at lane distance, which RU5 asked for explicitly ─────────────
   *
   * The shape a critic was unwilling to assert either way was *"a thin white shaft with a
   * coloured tip inside a red circle"* — which is a syringe. Three of the four things that
   * read makes that shape are now gone: the shaft is no longer constant-section (it necks and
   * swells, and a syringe barrel does neither), the "tip" end is now the **fat** end and it
   * carries a bright pad standing proud of it (a syringe's fat end is the plunger, at the
   * opposite end from the needle), and the circle is amber rather than red. What is left is a
   * long-handled implement with a wide bright head — which is the icon a toothbrush has.
   */
  const brush: ItemKindDef = {
    axis: AXIS_Z,
    label: "toothbrush",
    parts: [
      halo(),
      // Lathed along +Y and laid down along +X: the profile's y = 0 (the neck) lands at the
      // part's own x = 0, so the offset below puts the neck at −0.24 and the butt at +0.46.
      part(
        latheProfile([
          [0, 0],
          [0.038, 0.018],
          [0.048, 0.16],
          [0.046, 0.42],
          [0.062, 0.6],
          [0, 0.7],
        ]),
        ivory,
        { pos: [-0.24, 0, 0], rot: [0, 0, -Math.PI / 2], cast: true }
      ),
      part(roundedBox(0.21, 0.175, 0.155, 0.06), peachDeep, { pos: [-0.325, 0.035, 0], cast: true }),
      part(roundedBox(0.185, 0.085, 0.135, 0.038), enamel, { pos: [-0.325, -0.085, 0] }),
    ],
  };

  /*
   * The star: ivory inside — and now through — an amber hoop, rather than a red blob. See
   * `starShape` for why the outline is a polar curve and not ten `lineTo`s.
   *
   * Grown from 0.33 to 0.44 of outline radius for the same reason the brush was: at 0.33 its
   * tips died inside the hoop's band and the hoop was the silhouette. `beveledExtrude` grows
   * the silhouette outward by its `bevel`, so the shape that ships reaches **0.464** and the
   * five points emerge 0.059 past the band's 0.405 outer edge — alongside the brush's head at
   * 0.042 and its butt at 0.055, and on very nearly the same swept circle (0.464 against
   * 0.460), so one `REST_Y` serves both pickups. The hoop still shows through all five valleys (0.10 against an inner
   * band edge of 0.315), which is what makes the compound shape a star *wearing* a hoop.
   *
   * The tip's radius of curvature moves with it and is re-solved rather than assumed:
   *
   *   R = outer² / (outer + 12.5·p·(outer − inner)) = 0.1936 / 6.390 = **0.0303 units**
   *
   * — up from 0.0223, measured on the shipped polar curve by numeric differentiation rather
   * than by that closed form, and comfortably over `MIN_BEVEL` (0.02) before the bevel offsets
   * it outward to an effective 0.054. The valley deepens with the outer radius (0.07 → 0.10)
   * and stays *convex*: with `p` = 1.4 the minimum goes as `Δ^2.8`, so `r''(valley)` is zero
   * and the notch is locally a circle of radius `inner` — which is why a 0.024 outward offset
   * cannot cusp it.
   *
   * Ivory works here only *because* of the hoop: an ivory star on the ivory-deep lane is a
   * 1.22:1 albedo step and would vanish on its own. Framed by amber it is the brightest,
   * highest-contrast object in the world (3.09:1 against its own frame).
   */
  const star: ItemKindDef = {
    axis: AXIS_Z,
    label: "star",
    parts: [
      halo(),
      part(beveledExtrude(starShape(0.44, 0.1), { depth: 0.085, bevel: 0.024 }), ivory, {
        cast: true,
      }),
    ],
  };

  /*
   * Sweet 1 — a wrapped barrel lying along X, with a twist of wrapper at each end. The
   * silhouette rule for all three sweets is *low and wide*: this one is 0.34 tall and 0.72
   * across, so it is twice as wide as it is high and it can never be confused with a hoop.
   */
  const twist = roundedCylinder(0.1, 0.14, 0.04);
  const candy: ItemKindDef = {
    axis: AXIS_X,
    label: "candy",
    parts: [
      part(roundedCylinder(0.17, 0.44, 0.07), rose, { rot: [0, 0, Math.PI / 2], cast: true }),
      part(twist, roseDeep, { pos: [-0.29, 0, 0], rot: [0, 0, Math.PI / 2] }),
      part(twist, roseDeep, { pos: [0.29, 0, 0], rot: [0, 0, Math.PI / 2] }),
    ],
  };

  /*
   * Sweet 2 — a squat tub with a wrapper band round its waist. At 0.34 tall and 0.62 across it
   * obeys the same low-and-wide rule as the other two. The lathe profile closes at both poles,
   * so it is one watertight solid rather than an open shell with a visible inside.
   */
  const soda: ItemKindDef = {
    axis: AXIS_Y,
    label: "fizzy drink",
    parts: [
      part(
        latheProfile([
          [0, 0],
          [0.2, 0],
          [0.235, 0.05],
          [0.3, 0.3],
          [0.31, 0.34],
          [0, 0.34],
        ]),
        rose,
        { pos: [0, -0.19, 0], cast: true }
      ),
      part(torusSoft(0.26, 0.045, lod(2)), roseDeep, {
        pos: [0, -0.02, 0],
        rot: [Math.PI / 2, 0, 0],
      }),
    ],
  };

  /*
   * Sweet 3 — a ring doughnut **lying flat**, iced side up. Standing face-on it was a ring
   * pointed at the camera, which is the pickups' mark; flat it is 0.22 tall and 0.72 across and
   * its hole faces the sky, so the two silhouettes cannot collide.
   *
   * The dough is `mauve.deep` rather than `CLAY.ivoryDeep`, which was **the lane's own colour**
   * — a 1.00:1 albedo step, so two thirds of this prop was invisible against the surface it
   * sat on and only the icing ever read. At `mauve.deep` it is 3.68:1 on the lane, and the
   * brown-under-pink pairing is what a doughnut looks like.
   *
   * The glaze is a fatter, flattened torus on the same major radius: tube 0.12 against the
   * dough's 0.10 and squashed to 0.5 along its own axis, so it overhangs the dough by 0.02 all
   * the way round and stands 0.02 proud of its crown — a glaze draped over a ring rather than a
   * decal painted on one. Both numbers are the overhang, not a guess at one.
   */
  const donut: ItemKindDef = {
    axis: AXIS_Y,
    label: "donut",
    parts: [
      part(torusSoft(0.24, 0.1), dough, { rot: [Math.PI / 2, 0, 0], cast: true }),
      part(torusSoft(0.24, 0.12), rose, {
        pos: [0, 0.06, 0],
        rot: [Math.PI / 2, 0, 0],
        scale: [1, 1, 0.5],
      }),
    ],
  };

  return [brush, star, candy, soda, donut];
}

/* ------------------------------------------------------------------ */
/* Scenery                                                             */
/* ------------------------------------------------------------------ */

/** Default `blobAt`: one blob on the prop's own axis. */
const ZERO_AT: readonly number[] = [0];

/**
 * A sphere with the machining taken off it.
 *
 * Round 3: "all mid/far scenery is constant-curvature primitives with uniform albedo" — and
 * it was literally true, because a hill was `softSphere(1)` scaled. A sphere has the *same*
 * curvature at every point, so `bakeCurvatureAO` (which is a function of curvature) writes a
 * constant, the grain has nothing to vary against, and the terminator is a perfect ellipse.
 *
 * `jitterSurface` pushes vertices along their welded normals by low-frequency fbm — the
 * shared builders already use it on `clayTray` and on every `toothGeometry` — and the AO is
 * then re-baked
 * **after** the displacement, which is the whole point: the tint has to describe the surface
 * that ships, not the sphere it started as. `amount` is a peak displacement on the unit
 * sphere, so a hill scaled to `sx ≈ 2.1` carries `2.1 × amount` of world relief; `frequency`
 * is lumps per unit, so 0.9 gives 1.8 lumps across the sphere — one big dent and one big
 * swell, which is what a clay hill pressed by a thumb has.
 *
 * The clone is required: `softSphere` hands back the shared cache entry, and jittering that
 * would displace every sphere in the product.
 */
function lumpySphere(key: string, detail: number, amount: number, frequency: number, seed: number) {
  return cachedGeometry(`tooth-runner/${key}|${detail}|${seed}`, () => {
    const geo = softSphere(1, detail).clone();
    jitterSurface(geo, amount, frequency, seed);
    bakeCurvatureAO(geo);
    geo.computeBoundingBox();
    geo.computeBoundingSphere();
    return geo;
  });
}

export type ScatterDef = {
  key: string;
  parts: PartDef[];
  n: number;
  /** Far end of the recycling window, and how long it is. */
  z0: number;
  span: number;
  pitch: number;
  /** Units of taper at the far end of the window, so an instance grows in out of the fog. */
  fadeFar: number;
  /** Units of taper at the near end. Zero where the window wraps behind the camera. */
  fadeNear: number;
  /** Parallax multiplier on the world speed. */
  rate: number;
  /**
   * Parallax multiplier under `prefers-reduced-motion`. See `RATE_MID_REDUCED` in
   * `layout.ts` for the measurement this exists to answer — it defaults to `rate`, so a pool
   * that forgets to declare one can only ever stay as quiet as it already was, never get
   * busier. That default is the whole bug RU3 found: the old path forced *every* band to
   * `RATE_NEAR`, which slowed nothing and accelerated the far ridge by 3.85x.
   */
  reducedRate: number;
  /**
   * Contact shadow, described as the prop rather than as a radius.
   *
   * Round 3 measured the ground around every mid and far prop as *uniform white with a razor
   * elliptical terminator at the base* — not one value step — and this is why. The field
   * used to be "blob radius as a multiple of `sx`", and the hills were set to 0.95. But a
   * hill is a unit sphere sunk `0.42·sy` into the floor, so its silhouette **on the floor**
   * is an ellipse of semi-axis `sqrt(1 − 0.42²) = 0.9075·sx` — and the blob profile in
   * `textures.ts` stops being able to move an 8-bit byte at `CONTACT_BLOB_VISIBLE_FRACTION`
   * (0.827) of its radius. So the visible blob was `0.95 × 0.827 = 0.786·sx` against a
   * footprint of `0.9075·sx`: **every pixel of it was underneath the dome that cast it.**
   * (The fix list guessed fog. Fog at the mid band's 37 units is `1 − exp(−(0.014·37)²)` =
   * 0.235, a quarter of the way to cream — nowhere near enough to erase a shadow that was
   * there. It was never there.)
   *
   * So a pool now states two things it actually knows and `scene.tsx` does the arithmetic:
   *
   *  - `foot` — the prop's own silhouette radius **on the floor**, as a multiple of the
   *    instance's `sx`/`sz`. 0 disables the blob.
   *  - `lift` — the height of the mass the blob stands in for, as a multiple of `sy`. It
   *    buys two things: `Rig::contactRadiusFor`'s penumbra allowance, and the distance the
   *    real cast shadow slides across the floor away from the key.
   */
  foot: number;
  lift: number;
  /**
   * Local x offsets at which to write a blob, in units of `sx`. One entry for a prop with a
   * single base; the gateway has two posts and therefore two.
   */
  blobAt: Float32Array;
  /**
   * The highest local y the pool's geometry reaches, in the prop's own **unscaled** frame,
   * so an instance's world crown is `y[i] + crown · sy[i]`.
   *
   * Not decoration: it is what the gateway is sized against. Every `crown` here is fed
   * through `layout.ts::ndcYOf` against the real `cameraFor` solve, over the *seeded instance
   * tables* and with each pool's own end taper applied, in all five shipped rects. That is
   * where the ndc figures in the comments below come from — the projection is exported
   * precisely so they are computed rather than claimed. Worst `ndcY` per pool:
   *
   *   tie 0.50 · kerb 0.50 · **gate 0.47** · hill-near 0.58 · hill-far 0.63 · leaf 0.64 ·
   *   ridge 0.66 · brush 6.6
   *
   * against chrome-band bottoms of 0.541 / 0.600 / 0.628 / 0.727 in the four rects whose
   * ground itself clears the band. Only the brush pool crosses it — it is 2.96 units tall and
   * the mid band carries it past the lens — which is why its head is now the family's palest
   * tone rather than its deepest. See the brush's own note.
   */
  crown: number;
  /**
   * Finale clearance. When the clock runs out the world coasts to a stop wherever it
   * happens to be, so *whatever prop is passing the camera at that instant becomes the
   * celebration's composition* — round 2 caught a gateway filling the bottom 60% of the
   * frame as a featureless slab with the hero squeezed into the top fifth.
   *
   * A pool with `clearZ` finite is swept out of the camera's near volume across the 0.3 s
   * between the clock expiring and the celebration arming: an instance at `clearZ` is
   * untouched, one at `clearZ + clearFade` or nearer is gone. Set to `Infinity` for a pool
   * that is never in the way. This makes the finale framing deterministic — the nearest
   * surviving gate is *always* at least `clearZ` out — without any prop ever being cut.
   */
  clearZ: number;
  clearFade: number;
  x: Float32Array;
  y: Float32Array;
  sx: Float32Array;
  sy: Float32Array;
  sz: Float32Array;
  yaw: Float32Array;
  tilt: Float32Array;
};

type ScatterOpts = {
  key: string;
  parts: PartDef[];
  n: number;
  z0: number;
  span: number;
  fadeFar?: number;
  fadeNear?: number;
  rate: number;
  reducedRate?: number;
  foot?: number;
  lift?: number;
  blobAt?: readonly number[];
  crown: number;
  clearZ?: number;
  clearFade?: number;
  seed: number;
  /** Fills the per-instance tables. `r()` is the seeded PRNG; `i` is the instance index. */
  place: (
    i: number,
    r: () => number,
    out: { x: number; y: number; sx: number; sy: number; sz: number; yaw: number; tilt: number }
  ) => void;
};

function scatter(opts: ScatterOpts): ScatterDef {
  const { n } = opts;
  const r = rng(opts.seed);
  const out = { x: 0, y: 0, sx: 1, sy: 1, sz: 1, yaw: 0, tilt: 0 };
  const def: ScatterDef = {
    key: opts.key,
    parts: opts.parts,
    n,
    z0: opts.z0,
    span: opts.span,
    pitch: opts.span / n,
    fadeFar: opts.fadeFar ?? 8,
    fadeNear: opts.fadeNear ?? 0,
    rate: opts.rate,
    reducedRate: opts.reducedRate ?? opts.rate,
    foot: opts.foot ?? 0,
    lift: opts.lift ?? 0,
    blobAt: Float32Array.from(opts.blobAt ?? ZERO_AT),
    crown: opts.crown,
    clearZ: opts.clearZ ?? Infinity,
    clearFade: opts.clearFade ?? 4,
    x: new Float32Array(n),
    y: new Float32Array(n),
    sx: new Float32Array(n),
    sy: new Float32Array(n),
    sz: new Float32Array(n),
    yaw: new Float32Array(n),
    tilt: new Float32Array(n),
  };
  for (let i = 0; i < n; i++) {
    out.x = 0;
    out.y = 0;
    out.sx = 1;
    out.sy = 1;
    out.sz = 1;
    out.yaw = 0;
    out.tilt = 0;
    opts.place(i, r, out);
    def.x[i] = out.x;
    def.y[i] = out.y;
    def.sx[i] = out.sx;
    def.sy[i] = out.sy;
    def.sz[i] = out.sz;
    def.yaw[i] = out.yaw;
    def.tilt[i] = out.tilt;
  }
  return def;
}

/** ± with the sign alternating by index, so both verges stay populated. */
const side = (i: number) => (i % 2 === 0 ? 1 : -1);

export function buildScatters(): ScatterDef[] {
  /*
   * The band palette. Depth is carried by tint as much as by parallax: the closest scenery
   * is the registered family at full strength (peach), the middle drops to mauve, and the
   * far ridge is a pale rose that the fog then lifts most of the way to the page colour.
   * Nothing here is a new colour — every one is a token from `ACCENTS` — and the kerbs and
   * near hills share one material so the count stays low.
   */
  const ivory = clayIvory();
  const peach = clayAccent(GAME_ACCENT, "main");
  const peachDeep = clayAccent(GAME_ACCENT, "deep");
  const peachSoft = clayAccent(GAME_ACCENT, "soft");
  const mauve = clayAccent("mauve", "main");
  const roseSoft = clayAccent("rose", "soft");
  const tie = clay("tooth-runner/tie", {
    color: NEUTRAL.well,
    roughness: 0.88,
    sheen: 0.08,
    grain: 0.2,
  });

  const unitSphere = softSphere(1, lod(2));
  /*
   * Two hill bands and one ridge, each with its own displacement seed, so no two silhouettes
   * in the frame are the same curve. Amounts are peak displacement on the *unit* sphere:
   * 0.075 on a hill scaled to sx ≈ 2.1 is 0.16 units of world relief on a 4.2-unit dome,
   * and 0.06 on a ridge scaled to sx ≈ 5 is 0.30 on a 10-unit one.
   */
  const hillNearGeo = lumpySphere("hill-a", lod(2), 0.075, 0.9, 5);
  const hillFarGeo = lumpySphere("hill-b", lod(2), 0.068, 1.1, 17);
  const ridgeGeo = lumpySphere("ridge", lod(1), 0.06, 0.75, 29);

  /* -------- near band: the lane the child is actually running on -------- */

  /**
   * Cross-ties pressed into the lane. Low contrast on purpose — they are a *speed cue*,
   * not decoration, and a high-contrast stripe pattern strobing past at 8 units a second
   * is the fastest way to make a runner unpleasant to look at.
   */
  const ties = scatter({
    key: "tie",
    parts: [part(roundedBox(2.5, 0.05, 0.3, 0.06, lod(2)), tie, { pos: [0, 0.012, 0] })],
    n: 26,
    z0: NEAR_Z0,
    span: NEAR_SPAN,
    rate: RATE_NEAR,
    // The tie is a 0.05-thick slab lying at y 0.012; its crown is 0.037 above the anchor.
    crown: 0.037,
    seed: 11,
    place: (_i, r, o) => {
      o.sx = 0.94 + r() * 0.1;
      o.sz = 0.85 + r() * 0.35;
      o.yaw = (r() - 0.5) * 0.03;
    },
  });

  /** Pebble kerbs along both verges — the strongest read on how fast you are going. */
  const kerbs = scatter({
    key: "kerb",
    parts: [part(softSphere(0.16, lod(1)), peach, { cast: true })],
    n: 44,
    z0: NEAR_Z0,
    span: NEAR_SPAN,
    rate: RATE_NEAR,
    // A 0.16-radius sphere with no local offset; anchored 0.07-0.11 above the floor.
    crown: 0.16,
    // A pebble level with the lens fills the bottom corners of a frozen frame.
    clearZ: 1.5,
    clearFade: 2.5,
    seed: 23,
    place: (i, r, o) => {
      o.x = side(i) * (LANE_HALF + 0.09 + r() * 0.16);
      o.y = GROUND_Y + 0.07 + r() * 0.04;
      const s = 0.72 + r() * 0.55;
      o.sx = s;
      o.sy = s * (0.72 + r() * 0.2);
      o.sz = s * (0.9 + r() * 0.45);
      o.yaw = r() * Math.PI;
    },
  });

  /**
   * The gateways straddling the lane — a pair of posts, and no longer an arch.
   *
   * ── Why the arch had to go, with the arithmetic ────────────────────────────────
   *
   * Round 3 measured `#2F3237` ink on arch pixels at **2.42:1 and 2.12:1**, and `ink-mid`
   * (which is what `GameShell` sets the 15 px subtitle in) at **1.20:1**. Re-measured
   * straight off `tooth-runner-rest.png`: over the 95,006 arch pixels the darkest 1 % render
   * at luminance 0.107, which is **1.93:1 against ink and 1.15:1 against ink-mid**, and the
   * crop of the title band is arch from edge to edge. The arch was not *a* thing in the
   * chrome band; it was the whole of it.
   *
   * The fix list asked for a `clearZ`/`clearY` exclusion so no arch may occupy the top
   * `chrome` fraction of the frame. **There is no such distance.** `cameraFor` shifts the aim
   * point along the camera's own up vector and moves the camera by the same vector, so the
   * pitch is `ELEVATION` in every rect and the ground's vanishing point is pinned at
   * `HORIZON_NDC` = 0.707 — 14.6 % down from the top of the frame. The measured chrome band
   * is 13.6–34 % of the frame, so in four of the five rects the product ships in the horizon
   * is *inside* the band, and anything above the camera's own height converges into the band
   * from above however far away it is. Projected: the arch crown (world y 4.05) peaks at
   * ndcY 6.4–14.9 close in and never falls below **0.79** at the far end of its window,
   * against band bottoms of 0.32–0.73. Pushing it back does not work at 46 units and would
   * not work at 460.
   *
   * Recolouring does not close it either. At the arch's own measured darkest shading (0.404
   * of albedo, a fully self-shadowed tube underside) `peach.soft` reaches 4.76:1 against ink
   * and 2.84:1 against ink-mid, and `ivory` 5.19 / 3.09 — better, and still short of the
   * 4.5:1 a 15 px label wants. No clay tone in a self-shadowed tube can carry it, because
   * even the *page-coloured* ground reaches only 2.97:1 against ink-mid at that shading.
   *
   * ── What replaced it ──────────────────────────────────────────────────────────
   *
   * A gate the child runs *between* rather than under: two rounded posts on the verges with
   * ivory caps, crown 1.165 units above the lane (1.235 at the tallest instance). Sized, not
   * chosen — `layout.ts::GATE_Z0` carries the table, and the answer is that that crown over a
   * window starting at z = −28 peaks at ndcY **0.515–0.534** against band bottoms of 0.541 /
   * 0.600 / 0.628 / 0.727. The chrome band is then the fogged far field and nothing else,
   * which is the cream the DOM was designed against (`ink-mid` on `#EDE7DC` = 4.81:1).
   *
   * It also settles three things the arch could not:
   *
   *  - **It is never clipped.** The frame's top edge at z = 0 is world y 3.08; the arch crown
   *    was 4.05, so every arch had its crown cut by the view's top edge until it was ~15
   *    units out — which is what "reads as broken geometry" was. A 1.235 crown is 1.85 units
   *    clear of the top edge at the closest it ever gets.
   *  - **It cannot meet the lens.** The camera sits at y 2.46–2.92; the tallest post crown
   *    is world y 0.975. The whole "does the camera fly through the tube" problem stops
   *    existing, and with it the ±2.29–2.45 leg placement it forced.
   *  - **The facets and the seam go with it** (round 3's B8.8). A torus is a swept polyline
   *    with a duplicated seam ring; two lathed solids with domed ends have neither, and the
   *    pool costs 4,160 triangles at detail 2 against the arch's 5,760 at a forced detail 3.
   *
   * Posts at ±2.2, and that is measured against the *instances* rather than against the
   * placement formula: the widest kerb pebble in the seeded table reaches |x| = 1.885 (x 1.70
   * plus a 0.16 sphere at sx 1.16), and the post's inner face is at 2.2 − 0.178 = 2.022, so
   * the two near-band pools clear each other by 0.137 at every index. They share a parallax
   * rate, so an overlap there would be rigid and permanent rather than transient. Lateral
   * scale is pinned at 1: a gate that changes width is a different gate.
   */
  const GATE_X = 2.2;
  const GATE_POST_H = 1.02;
  const GATE_CAP_Y = 1.07;
  const GATE_CAP_H = 0.19;
  /*
   * Two lathed solids per post and nothing else. `roundedCylinder`'s roll is taken all the
   * way to 0.16 on a 0.178 radius, so the post's own ends are domes and there is no cap seam
   * to hide — which is the other half of round 3's arch finding (a torus is a swept polyline
   * with a duplicated seam ring; this has neither).
   *
   * Cost, counted rather than estimated: 352 + 168 triangles a post at detail 2, x 2 posts x
   * 4 instances = **4,160** against the arch pool's 5,760 at its forced detail 3. On the low
   * tier `lod` drops both to detail 1 and it is 2,688. The facet check the arch's comment
   * set for itself still holds: 14 radial segments on a 0.178 radius is a sagitta of
   * `0.178·(1 − cos 12.86°)` = 0.0045 units, which is 2.9 screen px at the closest a post
   * gets while any of it is still in frame — under the 3 px the arch was held to.
   */
  const gatePost = roundedCylinder(0.178, GATE_POST_H, 0.16, lod(2));
  const gateCap = roundedCylinder(0.135, GATE_CAP_H, 0.09, lod(1));
  const gates = scatter({
    key: "gate",
    parts: [
      part(gatePost, peachDeep, { pos: [-GATE_X, GATE_POST_H / 2, 0], cast: true }),
      part(gateCap, ivory, { pos: [-GATE_X, GATE_CAP_Y, 0], cast: true }),
      part(gatePost, peachDeep, { pos: [GATE_X, GATE_POST_H / 2, 0], cast: true }),
      part(gateCap, ivory, { pos: [GATE_X, GATE_CAP_Y, 0], cast: true }),
    ],
    n: 4,
    z0: GATE_Z0,
    span: GATE_SPAN,
    fadeFar: 8,
    rate: RATE_NEAR,
    crown: GATE_CAP_Y + GATE_CAP_H / 2,
    // The post's silhouette on the floor is the cylinder's own radius less its bottom roll;
    // the blob stands in for the lower half of a 1.0-unit post, which is the part whose
    // shadow is a pool rather than a streak.
    foot: 0.155,
    lift: 0.5,
    blobAt: [-GATE_X, GATE_X],
    // A post level with the lens fills a corner of a frozen celebration frame, exactly as a
    // kerb pebble does; swept on the same schedule.
    clearZ: 2,
    clearFade: 3,
    seed: 37,
    place: (_i, r, o) => {
      o.y = GROUND_Y;
      o.sx = 1;
      o.sz = 1;
      // Height varies, width never does. The tallest instance is 1.06 x 1.165 = 1.235,
      // which is what the ndc table in `layout.ts::GATE_Z0` is solved at.
      o.sy = 0.92 + r() * 0.14;
      o.tilt = (r() - 0.5) * 0.04;
    },
  });

  /* -------- mid band: the diorama the lane runs through -------- */

  const hillPlace =
    (near: number, spread: number, lo: number, hi: number) =>
    (i: number, r: () => number, o: { x: number; y: number; sx: number; sy: number; sz: number; yaw: number; tilt: number }) => {
      const s = lo + r() * (hi - lo);
      const flat = 0.54 + r() * 0.18;
      o.x = side(i) * (near + r() * spread);
      // Sunk into the floor so the visible part is a cap, never a ball resting on a plane.
      o.y = GROUND_Y - s * flat * 0.42;
      o.sx = s * (0.9 + r() * 0.35);
      o.sy = s * flat;
      o.sz = s * (0.9 + r() * 0.35);
      o.yaw = r() * Math.PI;
    };

  /*
   * Aerial recession, now inside the registered family (see `GAME_ACCENT`): the closest
   * hills are peach at full strength, the ones behind them drop to mauve — lower chroma and
   * a touch darker, which is what distance does — and the far ridge is the palest thing in
   * the frame. The band used to open on coral, which is a different family's colour and the
   * single largest reason the room did not match the card the child tapped.
   */
  const hillsNear = scatter({
    key: "hill-near",
    parts: [part(hillNearGeo, peach)],
    n: 7,
    z0: MID_Z0,
    span: MID_SPAN,
    rate: RATE_MID,
    reducedRate: RATE_MID_REDUCED,
    // The displacement pushes the surface out by at most `amount`, so the crown is 1.075.
    crown: 1.075,
    /*
     * `sqrt(1 - 0.42²)` = 0.9075 — the sphere's own section at the floor, since `hillPlace`
     * sinks it 0.42·sy. This is the number that was wrong: the blob used to be sized at
     * 0.95·sx, which is 0.786·sx of *visible* blob against a 0.9075·sx footprint, i.e. it was
     * entirely underneath the hill. The lift is the cap's apex, 0.58·sy above the floor.
     */
    foot: 0.9075,
    lift: 0.58,
    seed: 51,
    place: hillPlace(3.4, 2.4, 1.4, 2.6),
  });

  const hillsFar = scatter({
    key: "hill-far",
    parts: [part(hillFarGeo, mauve)],
    n: 6,
    z0: MID_Z0,
    span: MID_SPAN,
    rate: RATE_MID,
    reducedRate: RATE_MID_REDUCED,
    crown: 1.068,
    foot: 0.9075,
    lift: 0.58,
    seed: 67,
    place: hillPlace(5.6, 4.2, 2.4, 4.4),
  });

  /**
   * Giant toothbrushes standing at the roadside like trees — the mid-ground prop that says
   * what world this is. They are the tallest thing in the band and they lean, so the row
   * never reads as fence posts.
   *
   * ── Why this is six parts and not two ──────────────────────────────────────────
   *
   * It used to be a 0.26-square ivory stick with a red block stuck on top, and it read as a
   * matchstick — no bristles, no flat head, no neck, nothing resembling the collectible
   * brush the whole game is about grabbing. A world whose scenery contradicts its own
   * objective teaches a child the wrong noun.
   *
   * Every dimension below is the collectible brush's own, stood on end and scaled — and the
   * scale is *not* the single 2.8 this comment used to claim, because a bar that keeps its
   * cross-section at 3.6× its length is a wire at 25 units. Measured:
   *
   *   handle  0.46 × 0.10 × 0.12  ->  0.336 × 1.68 × 0.28    length ×3.65, section ×3.4/×2.3
   *   head    0.20 × 0.15 × 0.16  ->  0.476 × 0.70 × 0.42    length ×3.50, section ×2.4/×2.6
   *
   * — one silhouette, stood on end, with the section fattened so it survives the distance.
   *
   * plus a neck between them (a waist narrower than both, which is the shape that says
   * "this bends here") and three bristle rows standing proud of the head's front face. The
   * bristles are separate bars rather than one slab because the read is in the *silhouette*:
   * a solid pad is a second block, three bars with air between them are bristles.
   *
   * ── Why the head is no longer the deep tone ───────────────────────────────────
   *
   * With the arch gone this pool is the tallest thing in the frame (crown world y 2.96), and
   * the same projection that condemned the arch condemns a *dark* head here: a brush head is
   * on screen and inside the chrome band from 8–14 units out in every rect, at |ndcX| 0.12
   * upward — i.e. it can and does pass behind the subtitle. In `peach.deep` at the darkest
   * shading the product produces, that is **2.06:1 against ink and 1.23:1 against ink-mid**.
   * In `peach.soft` it is **5.2:1 and 3.1:1** — the same band the fogged far ridge and the
   * bare cream ground already sit in, which is the ceiling for any lit 3D surface (see the
   * gateway's note). The deep tone moves down to the gate posts, which are measurably out of
   * the band, so the palette keeps its dark anchor and puts it where it is safe.
   *
   * It also buys a rule the game did not have, and RU2 corrected which way round it runs:
   * **amber means you can have it.** The roadside brushes are unpainted cream with a
   * `peach.soft` head; the one in the lane wears a `peach.deep` head inside a `peach.deep`
   * hoop, and `peach.main` — the tone on the kerbs and near hills either side of it — appears
   * on neither. The two are still the same object at two sizes — the proportions below
   * are the collectible's, multiplied — but only one of them is a thing to grab, and the tone
   * that says so is 36° of hue away from the colour a child reads as *stop*.
   */
  const BRUSH_HANDLE_H = 1.68;
  const BRUSH_NECK_H = 0.3;
  const BRUSH_HEAD_H = 0.7;
  const BRUSH_HEAD_Y = BRUSH_HANDLE_H + BRUSH_NECK_H + BRUSH_HEAD_H / 2;
  // Detail 1 for the small parts: a 12 cm bar 25+ units out is a handful of pixels, and at
  // detail 2 the three of them would cost 13.8k triangles across the pool for nothing.
  const bristle = roundedBox(0.36, 0.12, 0.24, 0.055, lod(1));
  const brushes = scatter({
    key: "brush",
    parts: [
      part(roundedBox(0.336, BRUSH_HANDLE_H, 0.28, 0.13, lod(2)), ivory, {
        pos: [0, BRUSH_HANDLE_H / 2, 0],
      }),
      part(roundedBox(0.25, BRUSH_NECK_H, 0.22, 0.1, lod(1)), ivory, {
        pos: [0, BRUSH_HANDLE_H + BRUSH_NECK_H / 2, 0],
      }),
      part(roundedBox(0.476, BRUSH_HEAD_H, 0.42, 0.17, lod(2)), peachSoft, {
        pos: [0, BRUSH_HEAD_Y, 0],
        cast: true,
      }),
      // Front face of the head sits at z = 0.21; the bars poke 0.13 past it.
      part(bristle, ivory, { pos: [0, BRUSH_HEAD_Y + 0.21, 0.22] }),
      part(bristle, ivory, { pos: [0, BRUSH_HEAD_Y, 0.24] }),
      part(bristle, ivory, { pos: [0, BRUSH_HEAD_Y - 0.21, 0.22] }),
    ],
    n: 6,
    z0: MID_Z0,
    span: MID_SPAN,
    rate: RATE_MID,
    reducedRate: RATE_MID_REDUCED,
    crown: BRUSH_HEAD_Y + BRUSH_HEAD_H / 2,
    /*
     * The handle's base is a 0.336 x 0.28 box: half-diagonal `hypot(0.168, 0.14)` = 0.219.
     * `lift` is deliberately *not* the brush's full 2.68 — a 2.68-unit stick throws a shadow
     * that slides 2.45 units across the floor, and that is a streak, not a pool. A round
     * decal cannot honestly draw it, so the blob stands in for the bottom third of the
     * handle and the rest is the shadow map's job wherever the prop is inside its frustum.
     */
    foot: 0.219,
    lift: 0.55,
    seed: 83,
    place: (i, r, o) => {
      const s = 0.85 + r() * 0.5;
      o.x = side(i) * (3.1 + r() * 2.6);
      o.y = GROUND_Y;
      o.sx = s;
      o.sy = s;
      o.sz = s;
      o.yaw = r() * Math.PI * 2;
      o.tilt = (r() - 0.5) * 0.22;
    },
  });

  /**
   * Leaf sprigs: two blades standing out of the ground at different angles.
   *
   * A blade is a squashed sphere rather than an extruded outline — a lens has no silhouette
   * corner anywhere, which 3D-SPEC §3 requires, and it reuses the sphere already in the
   * cache. Each blade is positioned so its lower tip sits *below* the floor, which is what
   * plants it: the sprig scales about the ground line, so it stays planted at every size.
   */
  const leaves = scatter({
    key: "leaf",
    parts: [
      part(unitSphere, mauve, { pos: [0, 0.62, 0], rot: [0.3, 0, 0.1], scale: [0.26, 0.86, 0.085] }),
      part(unitSphere, mauve, { pos: [0, 0.48, 0], rot: [-0.34, 1.1, -0.22], scale: [0.22, 0.7, 0.075] }),
    ],
    n: 10,
    z0: MID_Z0,
    span: MID_SPAN,
    rate: RATE_MID,
    reducedRate: RATE_MID_REDUCED,
    // Tallest blade: centre 0.62, half-length 0.86, tilted 0.3 rad => 0.62 + 0.86·cos 0.3.
    crown: 1.442,
    // The two blades are 0.26 and 0.22 wide and set at different yaws; their union at the
    // floor is a touch wider than either.
    foot: 0.3,
    lift: 0.45,
    seed: 97,
    place: (i, r, o) => {
      const s = 0.75 + r() * 0.6;
      o.x = side(i) * (2.5 + r() * 3.6);
      o.y = GROUND_Y;
      o.sx = s;
      o.sy = s;
      o.sz = s;
      o.yaw = r() * Math.PI * 2;
      o.tilt = (r() - 0.5) * 0.16;
    },
  });

  /* -------- far band: the silhouette ridge -------- */

  /**
   * The one thing in the frame that separates out of the cream.
   *
   * Everything else in this world converges on the page colour with distance — the floor,
   * the fog and the DOM background are all `#ede7dc` by design, which is why there is no
   * horizon line. A ridge in soft rose, 55–75 units out and a third washed toward cream by
   * the fog, is aerial perspective doing exactly one job: telling you the world continues.
   *
   * It fades at *both* ends of its window, because unlike the near and mid bands its
   * recycling seam is in front of the camera rather than behind it.
   */
  const ridge = scatter({
    key: "ridge",
    parts: [part(ridgeGeo, roseSoft)],
    n: 16,
    z0: FAR_Z0,
    span: FAR_SPAN,
    // 55-75 units out with no cast shadow reaching it and nothing behind it to occlude: the
    // ridge is silhouette only, so it takes no blob.
    crown: 1.06,
    fadeFar: 12,
    // The near seam is in front of the camera, 34 units out and already a fifth washed into
    // the fog, and at 0.26 of the world speed an instance takes seven seconds to cross this
    // taper. Slow enough, and pale enough, that the recycle cannot be seen.
    fadeNear: 10,
    rate: RATE_FAR,
    reducedRate: RATE_FAR_REDUCED,
    seed: 113,
    place: (_i, r, o) => {
      const s = 4.5 + r() * 4;
      const flat = 0.3 + r() * 0.16;
      // Clear of the lane corridor: a ridge hill sitting on the path would say the path
      // ends, and this one never does.
      const bias = r() * 2 - 1;
      o.x = (bias < 0 ? -1 : 1) * (2.8 + Math.abs(bias) * 20);
      o.y = GROUND_Y - s * flat * 0.5;
      o.sx = s * (0.9 + r() * 0.5);
      o.sy = s * flat;
      o.sz = s * 0.7;
      o.yaw = r() * Math.PI;
    },
  });

  return [ties, kerbs, gates, hillsNear, hillsFar, brushes, leaves, ridge];
}
