/**
 * Every prop in Healthy or Not?, as real clay geometry.
 *
 * Nothing here is a texture of a drawing and nothing here is imported: the twelve foods,
 * the mascot's face, the turntable and the dish are all built from
 * `src/three/geometry.ts` builders and `src/three/materials.ts` factories, so they are lit
 * by the same key light and studio environment as the table they stand on.
 *
 * Two authoring rules, both load-bearing:
 *
 *  • **A food is authored with its base at local y = 0** and reports its own `height` and
 *    `radius`. The scene parents it inside a group offset by −height/2, so the group's
 *    origin is the food's *centre* — which is what a tumble has to rotate about and what a
 *    ballistic solve has to aim.
 *  • **One ball, scaled.** Almost every rounded volume here is the same cached
 *    `softSphere(0.1)` under a non-uniform scale. Fifteen props therefore cost one sphere
 *    geometry rather than fifteen, and the curvature-AO vertex colours a sphere carries are
 *    scale-invariant, so nothing is lost.
 *
 * Everything is built on the scene's first render — never at module import time — so it
 * lands in this game's chunk and costs the hub nothing. Every geometry and material comes
 * back `markShared` from a cache, which is why there is no teardown in this file: there is
 * nothing here a game is allowed to dispose.
 */
import { BufferAttribute, BufferGeometry, Path, Shape, type Material } from "three";
import { clamp01 } from "../../three/anim";
import {
  beveledExtrude,
  bakeCurvatureAO,
  cachedGeometry,
  latheProfile,
  roundedCylinder,
  softCapsule,
  softSphere,
  toothGeometry,
  torusSoft,
} from "../../three/geometry";
import {
  ALBEDO_ATTRIBUTE,
  clay,
  clayAccent,
  clayEnamel,
  clayIvory,
  clayPainted,
  softGlass,
  vertexAlbedoAttribute,
} from "../../three/materials";
import {
  CLAY,
  NEUTRAL,
  STUDIO,
  accent,
  color,
  type AccentFamily,
  type AccentTone,
} from "../../three/tokens";
import { HEALTHY_IDS, SUGARY_IDS, type FoodId } from "./engine";
import {
  CHEEK_BALL_RN,
  CHEEK_PROUD_N,
  CHEEK_XN,
  CHEEK_YN,
  CROWN_RN,
  CROWN_YN,
  DISH_FLOOR_Y,
  DISH_H,
  DISH_PAD_R,
  DISH_PAD_RISE,
  DISH_R,
  DISH_REST_Y,
  DISH_WALL,
  HAND_HALF_W,
  HAND_HEIGHT,
  HAND_WAVE_MAX,
  LIP_CAP_STACKS,
  LIP_TUBE_N,
  LIP_TUBE_RADIAL,
  LIP_TUBE_RINGS,
  MOUTH_DARK,
  MOUTH_DARK_FROM,
  PED_H,
  PED_R,
  SMILE_ALPHA,
  SMILE_AXIS_TILT,
  SMILE_SWEEP,
  TABLE_H,
  TOOTH_H,
} from "./layout";

/* ------------------------------------------------------------------ */
/* Part descriptors                                                    */
/* ------------------------------------------------------------------ */

export type Part = {
  geometry: BufferGeometry;
  material: Material;
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
};

export type FoodProp = {
  /**
   * Overall height, base at 0. Both numbers below are *measured* off the built geometry,
   * not eyeballed — `height` is the tumble pivot and the bounce floor, and `radius` is the
   * half-width the contact shadow is sized from.
   */
  height: number;
  radius: number;
  parts: Part[];
};

export type FoodTable = Record<FoodId, FoodProp>;

const NO_ROT: [number, number, number] = [0, 0, 0];
const ONE: [number, number, number] = [1, 1, 1];
/** Lay a disc or a ring flat, hole pointing up. */
const FLAT: [number, number, number] = [-Math.PI / 2, 0, 0];

const part = (
  geometry: BufferGeometry,
  material: Material,
  position: [number, number, number],
  rotation: [number, number, number] = NO_ROT,
  scale: [number, number, number] = ONE
): Part => ({ geometry, material, position, rotation, scale });

/* ------------------------------------------------------------------ */
/* Shape helpers                                                       */
/* ------------------------------------------------------------------ */

/**
 * A closed polygon whose corners are real arcs.
 *
 * 3D-SPEC §3 forbids a hard silhouette corner anywhere in this product, and a bevel on the
 * rim does not save a corner you look straight at — the cheese wedge is read face-on, so
 * its points have to be genuinely rounded in the outline itself.
 */
function roundedPolygonShape(
  points: readonly [number, number][],
  radius: number,
  /**
   * When set, each corner arc is written as this many straight segments instead of as a
   * `quadraticCurveTo`.
   *
   * `ExtrudeGeometry` samples every *curve* in a shape at `curveSegments`, which the tier
   * picks (6/10/16), and then builds a bevel ring for each sampled point. On a shape with
   * three corners that is free; on the hand's twenty-four it is not — measured, the hand came
   * out at **11,384 triangles at the high tier**, 6.3 % of §9's whole budget for a prop 0.6
   * units tall. Pre-sampling the arcs makes them straight segments, which `extractPoints`
   * passes through untouched.
   *
   * 5 is derived: the corners are 0.039 units in radius and turn about 90 degrees, so a
   * 5-segment arc has a sagitta of `0.039 * (1 - cos 9°)` = 4.8e-4 units, which is 0.1 px at
   * the framing this game ships — an order of magnitude inside the half-pixel bound
   * `geometry.ts` derives its own silhouette floors against.
   */
  arcSteps?: number
): Shape {
  const shape = new Shape();
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const prev = points[(i - 1 + n) % n];
    const cur = points[i];
    const next = points[(i + 1) % n];

    const inX = cur[0] - prev[0];
    const inY = cur[1] - prev[1];
    const inLen = Math.hypot(inX, inY) || 1;
    const outX = next[0] - cur[0];
    const outY = next[1] - cur[1];
    const outLen = Math.hypot(outX, outY) || 1;

    // Never eat more than 45% of the shorter neighbouring edge, or the outline self-folds.
    const r = Math.min(radius, inLen * 0.45, outLen * 0.45);
    const ax = cur[0] - (inX / inLen) * r;
    const ay = cur[1] - (inY / inLen) * r;
    const bx = cur[0] + (outX / outLen) * r;
    const by = cur[1] + (outY / outLen) * r;

    if (i === 0) shape.moveTo(ax, ay);
    else shape.lineTo(ax, ay);
    if (arcSteps === undefined) {
      shape.quadraticCurveTo(cur[0], cur[1], bx, by);
    } else {
      for (let k = 1; k <= arcSteps; k++) {
        const t = k / arcSteps;
        const u = 1 - t;
        shape.lineTo(
          u * u * ax + 2 * u * t * cur[0] + t * t * bx,
          u * u * ay + 2 * u * t * cur[1] + t * t * by
        );
      }
    }
  }
  shape.closePath();
  return shape;
}

/**
 * A smooth-lobed polar outline, `r(θ) = mid + amp·cos(lobes·θ)`. Used for the little
 * "well done" star that pops over the mascot: a star drawn with straight segments has acute
 * points, and this one does not.
 */
function lobedShape(lobes: number, rMin: number, rMax: number, samples: number): Shape {
  const shape = new Shape();
  const mid = (rMax + rMin) / 2;
  const amp = (rMax - rMin) / 2;
  for (let i = 0; i < samples; i++) {
    const a = (i / samples) * Math.PI * 2;
    const r = mid + amp * Math.cos(lobes * a);
    const x = Math.cos(a - Math.PI / 2) * r;
    const y = Math.sin(a - Math.PI / 2) * r;
    if (i === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  }
  shape.closePath();
  return shape;
}

/* ------------------------------------------------------------------ */
/* Lathe profiles — [radius, height], bottom to top                    */
/* ------------------------------------------------------------------ */

const CARROT: [number, number][] = [
  [0, 0],
  [0.115, 0.015],
  [0.13, 0.09],
  [0.12, 0.24],
  [0.09, 0.4],
  [0.05, 0.52],
  [0, 0.58],
];

const BOTTLE: [number, number][] = [
  [0, 0],
  [0.15, 0.01],
  [0.165, 0.06],
  [0.163, 0.3],
  [0.1, 0.4],
  [0.093, 0.5],
  [0, 0.52],
];

const MILK: [number, number][] = [
  [0, 0.03],
  [0.14, 0.04],
  [0.152, 0.3],
  [0.088, 0.4],
  [0.083, 0.46],
  [0, 0.46],
];

const TUMBLER: [number, number][] = [
  [0, 0],
  [0.145, 0],
  [0.158, 0.04],
  [0.178, 0.4],
  [0.192, 0.44],
];

const WATER: [number, number][] = [
  [0, 0.03],
  [0.14, 0.035],
  [0.156, 0.3],
  [0, 0.31],
];

const BERRY: [number, number][] = [
  [0, 0],
  [0.062, 0.04],
  [0.12, 0.14],
  [0.175, 0.3],
  [0.152, 0.38],
  [0, 0.42],
];

const CUP: [number, number][] = [
  [0, 0],
  [0.125, 0],
  [0.138, 0.03],
  [0.182, 0.36],
  [0.192, 0.39],
];

const WRAPPER: [number, number][] = [
  [0, 0],
  [0.13, 0],
  [0.145, 0.03],
  [0.198, 0.24],
  [0.208, 0.27],
];

const CHEESE_TRI: [number, number][] = [
  [-0.26, -0.19],
  [0.3, -0.19],
  [0.3, 0.26],
];

/* ------------------------------------------------------------------ */
/* The foods                                                           */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* Food surfaces                                                       */
/* ------------------------------------------------------------------ */

/**
 * The family this game is registered as (`GAMES["healthy-or-not"].accent`).
 *
 * Declared here rather than imported, for the reason `tokens.ts::auditSceneAccents` gives:
 * `src/games/index.ts` imports the scenes, so a scene importing it back is a cycle. The
 * scene checks the two agree in DEV (`scene.tsx`, `?selftest=healthy-or-not-accents`).
 */
export const HERO_FAMILY: AccentFamily = "peach";

/**
 * The saturated surfaces this set puts on screen, with the area each one covers.
 *
 * `tokens.ts::auditSceneAccents` takes a *population* of colours and reports which family
 * dominates it, and A15's finding was measured over **pixels** — "0.1 % of this play area's
 * saturated pixels are nearest peach". A flat list of the ten tones in the palette answers a
 * different question and gets a different answer (it makes red and peach tie at two tones
 * each and hands the tie to red), so the population below is weighted: each surface appears
 * in proportion to the area it actually covers, in world units squared.
 *
 * The areas are the props' own numbers, not eyeballed — a planform ellipse from the radius
 * or the scale each part is authored with. Food surfaces carry a `/ 12` time share, because
 * a food is on the pedestal for one round of twelve.
 *
 * Cross-checked against the thing it is a proxy for. Rendering the whole set at the game's
 * own camera and classifying every saturated pixel — the auditor's own method, run over all
 * twelve foods — gives **peach 68.3 %, coral 16.4 %, rose 11.9 %, red 2.5 %, mauve 1.0 %**,
 * and peach dominant on every single food. The table below gives peach 57 % / coral 31 %,
 * i.e. the same answer with less margin, because it counts all twelve progress beads as
 * present when they only fill up over a run. Conservative in the right direction.
 */
type AccentSurface = readonly [hex: string, area: number];

/** Area of one round food, from its authored radius. */
const disc = (r: number): number => Math.PI * r * r;
/** Area of an ellipse-ish prop from its two horizontal half-extents. */
const oval = (rx: number, rz: number): number => Math.PI * rx * rz;
/** A food is up for one round of twelve. */
const FOOD_SHARE = 1 / 12;

export const SCENE_ACCENT_SURFACES: readonly AccentSurface[] = [
  // ---- always on screen ----
  // The bowl, less the crevice-clay pad that sits inside it (a neutral, and `classifyAccent`
  // correctly returns null for it, so it dilutes nothing).
  [accent(HERO_FAMILY, "deep"), disc(DISH_R) - disc(DISH_PAD_R)],
  // Twelve progress beads at `BEAD_DONE_GROW` 1.16, counted as if the run were finished.
  [accent("coral", "main"), 12 * disc(0.055 * 1.16)],

  // ---- one food at a time ----
  // The apple's ramp runs deep -> coral across the fruit, so its body is half of each.
  // `0.224` is `APPLE_R`, spelled out because that constant is declared further down.
  [accent("red", "deep"), disc(0.224) * 0.5 * FOOD_SHARE], // apple, shaded cheek
  [accent("coral", "main"), disc(0.224) * 0.5 * FOOD_SHARE], // apple, lit cheek
  [accent("peach", "main"), oval(0.205, 0.095) * FOOD_SHARE], // carrot root
  [accent("mauve", "deep"), 3 * oval(0.045, 0.027) * FOOD_SHARE], // carrot fronds
  [accent("red", "main"), disc(0.102) * FOOD_SHARE], // milk cap
  [accent("peach", "main"), 0.56 * 0.3 * FOOD_SHARE], // cheese wedge
  [accent("coral", "main"), disc(0.18) * FOOD_SHARE], // strawberry
  [accent("mauve", "deep"), 3 * oval(0.038, 0.023) * FOOD_SHARE], // strawberry calyx
  [accent("rose", "main"), 0.4 * 0.08 * FOOD_SHARE], // lollipop disc, stood on edge
  [accent("coral", "main"), disc(0.2) * FOOD_SHARE], // soda cup
  [accent("rose", "main"), oval(0.03, 0.12) * FOOD_SHARE], // soda straw
  [accent("rose", "main"), disc(0.278) * FOOD_SHARE], // cake icing
  [accent("red", "main"), disc(0.05) * FOOD_SHARE], // cake cherry
  [accent("rose", "main"), oval(0.185, 0.14) * FOOD_SHARE], // candy centre
  [accent("rose", "main"), disc(0.295) * 0.73 * FOOD_SHARE], // doughnut icing
  [accent("mauve", "deep"), disc(0.295) * 0.27 * FOOD_SHARE], // doughnut ring
  [accent("coral", "main"), disc(0.21) * FOOD_SHARE], // cupcake wrapper
  [accent("red", "main"), disc(0.06) * FOOD_SHARE], // cupcake cherry
];

/** One entry per `AREA_QUANTUM` of surface, for `auditSceneAccents`. */
const AREA_QUANTUM = 0.002;

export function sceneAccentPopulation(): string[] {
  const out: string[] = [];
  for (const [hex, area] of SCENE_ACCENT_SURFACES) {
    const n = Math.max(1, Math.round(area / AREA_QUANTUM));
    for (let i = 0; i < n; i++) out.push(hex);
  }
  return out;
}

/**
 * How many grain periods a food carries.
 *
 * `3D-SPEC §3` asks for fingerprinted clay, and round 4's A14 measured the shipped grain as
 * absent on exactly these props. The strength was never the problem — `clayAccent` ships
 * `grain: 0.11`, mid-band for §3's 0.08–0.15, and the shared analysis showed the maze wall's
 * measured high-pass sigma is already at the top of what that band can produce. The *scale*
 * was: `GRAIN_REPEAT` puts one grain period every 0.75 world units, and an apple is 0.45
 * units across. One period across a whole prop is a gradient, not a grain.
 *
 * `materials.ts` gives the rule as `grainScale = (3.5 * 0.75) / propSizeInUnits` and caps it
 * at 4 (past which the finest octave falls under the 3 px aliasing floor and is mipped
 * away). Every food here is 0.2–0.73 units, i.e. asks for 3.6–13, so they all take the cap.
 */
const FOOD_GRAIN_SCALE = 4;

/**
 * `clayAccent` with a grain scale.
 *
 * `clayAccent(family, tone)` takes no options, and `clayPainted`'s cache key does not
 * include `grainScale`, so two callers asking for the same hex at different scales would
 * silently share the first one's material. `clay()` takes a caller-supplied key, which is
 * the one public route that cannot collide. The recipe below is `clayAccent`'s, reproduced;
 * the only knobs it cannot reach are `ao` (1.45 here against `clayAccent`'s 1.50) and
 * `edgeGloss` (0.26 against 0.28), both of which are `ClayInternal` and neither of which is
 * separable by eye at these sizes.
 */
function foodAccent(family: AccentFamily, tone: AccentTone): Material {
  return clay(`hn/food:${family}:${tone}`, {
    color: accent(family, tone),
    roughness: 0.68,
    wrap: 0.24,
    sss: accent(family, "soft"),
    sssStrength: 0.38,
    sheen: 0.38,
    grain: 0.11,
    grainScale: FOOD_GRAIN_SCALE,
  });
}

/** The same, for the two non-accent clays a food is made of. */
function foodClay(key: string, hex: string, roughness: number, sssStrength: number): Material {
  return clay(`hn/food:${key}`, {
    color: hex,
    roughness,
    wrap: 0.26,
    sss: CLAY.sss,
    sssStrength,
    sheen: 0.4,
    grain: 0.12,
    grainScale: FOOD_GRAIN_SCALE,
  });
}

/**
 * Adds a per-vertex albedo ramp to a copy of a cached geometry.
 *
 * The clone is the point: `cachedGeometry` entries are shared across the product for the
 * life of the context, so an attribute written onto one would follow it into every other
 * scene that asked for the same shape. The clone is itself cached under this game's own
 * key, so it is built once, `markShared`, and reclaimed with the scene like everything else
 * here — nothing in this file is a resource the game has to dispose.
 *
 * **`aAlbedo` is a multiplier, not a colour.** `materials.ts` ends its colour chunk with
 * `diffuseColor.rgb *= vClayAlbedo`, so a vertex carrying a literal token would be that
 * token *times the material's own*, which on a red apple is `red.deep x red.main` — nearly
 * black. The first draft did exactly that and rendered as one flat crimson ball; the values
 * written here are therefore `mix(from, to) / base`, per linear channel, where `base` is the
 * material's `color`. A vertex at `from` writes exactly the ratio that reproduces `from`.
 *
 * `paint` is given the vertex position and returns 0..1 along the ramp.
 */
function albedoRamp(
  key: string,
  source: () => BufferGeometry,
  base: string,
  from: string,
  to: string,
  paint: (x: number, y: number, z: number) => number
): BufferGeometry {
  return cachedGeometry(key, () => {
    const geo = source().clone();
    const position = geo.getAttribute("position");
    const a = color(from);
    const b = color(to);
    const c = color(base);
    // A token never has a channel at zero (the darkest in the palette is `red.deep`'s green
    // at 0.0125 linear), but the guard costs nothing and a division by zero here would write
    // Infinity into a vertex buffer and paint the prop white.
    const inv = [1 / Math.max(1e-4, c.r), 1 / Math.max(1e-4, c.g), 1 / Math.max(1e-4, c.b)];
    const values = new Float32Array(position.count * 3);
    for (let i = 0; i < position.count; i++) {
      const k = clamp01(paint(position.getX(i), position.getY(i), position.getZ(i)));
      values[i * 3] = (a.r + (b.r - a.r) * k) * inv[0];
      values[i * 3 + 1] = (a.g + (b.g - a.g) * k) * inv[1];
      values[i * 3 + 2] = (a.b + (b.b - a.b) * k) * inv[2];
    }
    geo.setAttribute(ALBEDO_ATTRIBUTE, vertexAlbedoAttribute(values));
    return geo;
  });
}

/* ------------------------------------------------------------------ */
/* The apple                                                           */
/* ------------------------------------------------------------------ */

const APPLE_R = 0.224;
const APPLE_BODY_H = 0.4;
/** How far each pole is sunk into the body. A real apple's stem sits in a well. */
const APPLE_DIMPLE = 0.045;
/** Radius at which the dimple has faded back into the body. */
const APPLE_WELL_R = 0.078;
/** Rings across one well, and around the flank between them. See `appleProfile`. */
const APPLE_WELL_RINGS = 10;
const APPLE_FLANK_RINGS = 18;

/**
 * The apple's profile, and why it stopped being a sphere.
 *
 * It was `softSphere(0.1)` under a `[2.2, 2, 2.2]` scale, and round 4 photographed the
 * consequence: "a smooth sphere of uniform red with one broad falloff — no fbm micro-grain,
 * no curvature lightening, no blush variation, no stem dimple — sitting beside a tooth leg
 * in the same crop that visibly carries clay tooth and warm crevice AO."
 *
 * The missing curvature term was not a bug in `bakeCurvatureAO`; it was arithmetic. The
 * baker darkens where a vertex sits *behind* the plane of its one-ring and lifts where it
 * sits in front, and on a sphere every vertex sits exactly the same distance behind that
 * plane — the shared re-measurement got `min 1.012, max 1.012` for `softSphere`, i.e. a
 * constant. **A sphere cannot carry curvature AO, so no amount of tuning would have put any
 * on this prop.** It needs somewhere concave to find.
 *
 * Measured, with `bakeCurvatureAO` run over both: `softSphere(0.1)` spans **1.0425 to
 * 1.0428**, a spread of 0.0003; this profile spans **0.651 to 1.085**, a spread of 0.434 —
 * darkest in the two wells, lightest on the shoulder where the flank turns over.
 *
 * ### Sampled in three pieces, not one
 *
 * The body is the sphere `y = H/2 (1 + sin t)`, `r = R cos t`, with each pole pulled back
 * into the fruit by `APPLE_DIMPLE * (1 + cos(pi * r / APPLE_WELL_R)) / 2` — a raised cosine
 * *in radius*, so it reaches the axis and the well's rim both with zero slope and neither is
 * a crease. The lowest point of the mesh is then a *ring* rather than a point, which is what
 * an apple's base actually is, and the two wells give the baker two concave one-rings.
 *
 * Sampling it uniformly in `t` does not work, and the first draft did: `r = R cos t` moves
 * fastest exactly at the poles, so a well 0.078 wide got three rings and the profile turned
 * **35.6 degrees in one step** at the stem well's rim — a visible crease on the feature the
 * fix exists to add. Each well therefore gets `APPLE_WELL_RINGS` samples spaced evenly in
 * *radius* and the flank between them gets `APPLE_FLANK_RINGS` spaced evenly in `t`, which
 * brings the worst turn anywhere on the profile to **17.3 degrees** — below the dish's 19.4
 * and inside `assertSmoothProfile`'s limit.
 *
 * `smooth: false` at the call site: the profile is already an analytic curve sampled at 39
 * points, so `latheProfile`'s spline resampler would only multiply it by six.
 */
function appleProfile(): [number, number][] {
  const sphere = (r: number, sign: number): number =>
    (APPLE_BODY_H / 2) * (1 + sign * Math.sqrt(Math.max(0, 1 - (r / APPLE_R) ** 2)));
  const well = (r: number): number =>
    (1 + Math.cos(Math.PI * Math.min(1, r / APPLE_WELL_R))) / 2;

  const pts: [number, number][] = [];
  for (let j = 0; j <= APPLE_WELL_RINGS; j++) {
    const r = (APPLE_WELL_R * j) / APPLE_WELL_RINGS;
    pts.push([r, sphere(r, -1) + APPLE_DIMPLE * well(r)]);
  }
  const edge = Math.acos(APPLE_WELL_R / APPLE_R);
  for (let i = 1; i < APPLE_FLANK_RINGS; i++) {
    const t = -edge + (i / APPLE_FLANK_RINGS) * 2 * edge;
    pts.push([APPLE_R * Math.cos(t), (APPLE_BODY_H / 2) * (1 + Math.sin(t))]);
  }
  for (let j = APPLE_WELL_RINGS; j >= 0; j--) {
    const r = (APPLE_WELL_R * j) / APPLE_WELL_RINGS;
    pts.push([r, sphere(r, 1) - APPLE_DIMPLE * well(r)]);
  }

  let minY = Infinity;
  for (const pt of pts) if (pt[1] < minY) minY = pt[1];
  for (const pt of pts) pt[1] -= minY;
  return pts;
}

export const APPLE_PROFILE = appleProfile();
/** Measured off the profile rather than declared, so the two can never drift. */
const APPLE_TOP = Math.max(...APPLE_PROFILE.map((p) => p[1]));
const APPLE_WELL_Y = APPLE_PROFILE[APPLE_PROFILE.length - 1][1];

/**
 * The blush.
 *
 * A real apple is not one colour: it is deep crimson on the shaded side and warms through
 * to orange-red where the sun reached it. Two tokens — `red.deep` #c21e25 to `coral.main`
 * #e8604c, a span of 25 L\* and 22 degrees of hue — ramped off the vertex's own direction,
 * squared so the transition is broad and there is no seam anywhere on the fruit.
 *
 * It is carried on `aAlbedo` and not on the `color` attribute, per the migration contract in
 * `materials.ts`: `color` belongs to `bakeCurvatureAO`, and writing a palette into it puts
 * the palette through the curvature extrapolation instead of the shading.
 */
function appleGeometry(): BufferGeometry {
  return albedoRamp(
    "healthy-or-not/apple",
    () => latheProfile(APPLE_PROFILE, undefined, false),
    accent("red", "main"),
    accent("red", "deep"),
    accent("coral", "main"),
    (x, y, z) => {
      const len = Math.hypot(x, z) || 1;
      // The blush faces the child at rest and leans a little toward the key light's azimuth
      // (`KEY_LIGHT.position` is (-4, 7, 5), i.e. front-left). It is on the *fruit*, so the
      // turntable carries it round: the apple presents its ripe cheek and then slowly shows
      // the deep side, which is a reason for the table to turn beyond decoration.
      const lit = (z / len) * 0.94 - (x / len) * 0.34;
      const up = y / APPLE_TOP;
      const k = 0.5 + 0.5 * lit;
      return k * k * (0.5 + 0.5 * up);
    }
  );
}

/* ------------------------------------------------------------------ */
/* The cheese                                                          */
/* ------------------------------------------------------------------ */

/**
 * Three holes, in the outline rather than on it.
 *
 * Round 4, HN3: "correct bevel, but a single flat saturated `peach.main` albedo and 'holes'
 * that are brown domes **bulging outward**, reading as chocolate buttons stuck to a wedge."
 * They were: two `roundedCylinder` pucks in crevice clay, parked at `z = 0.15` on a wedge
 * whose bevelled depth is 0.33, i.e. standing 0.015 proud of the face.
 *
 * A convex prop can never read as a cavity, so the holes are now holes: `Shape.holes`,
 * carried through `beveledExtrude` into `ExtrudeGeometry`, which bevels a hole's mouth
 * *inward*. That gives each one a countersunk lip — a genuinely concave rim, which is
 * (a) a real silhouette bite where a hole meets the wedge's edge, (b) somewhere for
 * `bakeCurvatureAO` to darken, and (c) two fewer meshes and two fewer draw calls than the
 * buttons it replaces.
 *
 * The albedo ramp is the second half of the same finding. A wedge of cheese is not one
 * colour: its cut faces are paler than its rind. `peach.soft` on the front face through to
 * `peach.main` on the back and the rind, which is a value change of 24 L* carried on the
 * geometry rather than on a second material.
 */
/*
 * Placement is a clearance calculation, not taste. `ExtrudeGeometry` insets the outline by
 * `bevelSize` to build the front face and *expands* every hole by the same amount, so a hole
 * centre must clear each edge by `holeRadius + 2 * bevel` or the two rings intersect and the
 * wedge grows a spike where they cross. The first draft put a 0.03 hole 0.033 from the
 * hypotenuse against a 0.045 bevel — it needed 0.12 — and the render showed exactly that
 * spike.
 *
 * `CHEESE_TRI`'s incircle is centred (0.154, -0.044) with radius 0.1458, which is the whole
 * budget: at `bevel` 0.045 the largest hole that fits anywhere is 0.056, and three do not
 * fit at all. Dropping the bevel to 0.030 — still 1.5x `3D-SPEC §3`'s 0.02 floor, and the
 * wedge's *outline* rounding is `roundedPolygonShape`'s 0.075 rather than this — buys back
 * 0.03 of clearance everywhere. The three below clear their nearest edge by 0.014, 0.005 and
 * 0.004 respectively, all positive.
 */
const CHEESE_HOLES: [number, number, number][] = [
  [0.15, -0.045, 0.045],
  [0.205, 0.035, 0.03],
  [0.02, -0.1, 0.026],
];

const CHEESE_DEPTH = 0.24;
const CHEESE_BEVEL = 0.03;

function cheeseShape(): Shape {
  const shape = roundedPolygonShape(CHEESE_TRI, 0.075);
  for (const [cx, cy, r] of CHEESE_HOLES) {
    const hole = new Path();
    hole.absarc(cx, cy, r, 0, Math.PI * 2, true);
    shape.holes.push(hole);
  }
  return shape;
}

function cheeseGeometry(): BufferGeometry {
  const half = CHEESE_DEPTH / 2 + CHEESE_BEVEL;
  return albedoRamp(
    "healthy-or-not/cheese",
    () => beveledExtrude(cheeseShape(), { depth: CHEESE_DEPTH, bevel: CHEESE_BEVEL }),
    accent("peach", "main"),
    accent("peach", "main"),
    accent("peach", "soft"),
    (_x, _y, z) => (z + half) / (2 * half)
  );
}

/* ------------------------------------------------------------------ */
/* The "bye bye" hand                                                  */
/* ------------------------------------------------------------------ */

/**
 * A waving hand, standing behind the dish.
 *
 * Round 4, HN2: "an empty terracotta saucer does not read as 'no thank you' to a
 * pre-reader", and the fix list's own first suggestion is to "put a waving-hand prop back
 * **beside** the dish (it can still lob food into an open dish, so §6.4's 'nothing shuts
 * over the answer' survives)". This is that, and it is deliberately *beside* rather than
 * *instead of*: a hand alone was what the lidded bin replaced, because a hand has nowhere
 * for the food to land and the child could not see where their answer went.
 *
 * The outline is a palm with four finger lobes and a thumb running down into a wrist that
 * reaches the table, built as one closed rounded polygon and extruded with a bevel — one
 * mesh, no hard corner anywhere in the silhouette, and no facial features of any kind on it.
 * It reads as a hand-shaped sign, which is the point: a *disembodied* hand is what the
 * lidded bin was brought in to replace, and this one is standing on something.
 *
 * Authored in the XY plane with the palm centre at the origin and the foot at `HAND_FOOT`,
 * so the scene pivots it about the wrist to wave.
 */
/**
 * Overall size. The outline below is authored at a comfortable working scale and multiplied
 * by this, so one number moves the whole prop: the first pass shipped it at 1.0 and the set
 * render showed a 0.49-unit hand beside a 1.05-unit mascot and a 0.78-unit bowl — legible as
 * a shape, far too small to read as a *gesture* at the framing this game ships.
 */
const HAND_SCALE = 1.5;
const HAND_W = 0.115;
/** The wrist runs down to here, so the sign stands on the table instead of floating. */
const HAND_FOOT = -0.1;
const HAND_OUTLINE: [number, number][] = (() => {
  const pts: [number, number][] = [];
  const finger = (cx: number, top: number, half: number): void => {
    /*
     * Shallow dips, not slots. The extrusion insets the outline by `bevel` to build the
     * front face, so a *concave* valley narrower than twice the bevel folds through itself
     * and the wedge grows a spike — the same failure the cheese holes had, from the other
     * side. At `HAND_SCALE` the bevel is 0.033 and the fingers are 0.078 apart, so a real
     * slot between them would need 0.066 of the 0.078 and leave no finger. A 1.9x dip with a
     * generous corner radius reads as four fingers and survives the inset.
     */
    pts.push([cx - half, top - half * 1.9]);
    pts.push([cx - half * 0.72, top]);
    pts.push([cx + half * 0.72, top]);
    pts.push([cx + half, top - half * 1.9]);
  };
  // Wrist, up the little-finger side.
  pts.push([-0.052, 0]);
  pts.push([-0.088, 0.075]);
  pts.push([-0.104, 0.14]);
  // Four fingers, tallest in the middle.
  finger(-0.079, 0.226, 0.026);
  finger(-0.027, 0.26, 0.026);
  finger(0.026, 0.252, 0.026);
  finger(0.076, 0.216, 0.025);
  // Down the thumb side, out over the thumb, then down the wrist to the foot it stands on.
  pts.push([HAND_W, 0.128]);
  pts.push([0.126, 0.086]);
  pts.push([0.102, 0.046]);
  pts.push([0.062, 0.052]);
  pts.push([0.056, 0.004]);
  pts.push([0.046, -0.05]);
  pts.push([0.038, HAND_FOOT]);
  pts.push([-0.038, HAND_FOOT]);
  pts.push([-0.05, -0.05]);
  for (const pt of pts) {
    pt[0] *= HAND_SCALE;
    pt[1] *= HAND_SCALE;
  }
  return pts;
})();

function handGeometry(): BufferGeometry {
  const geo = beveledExtrude(roundedPolygonShape(HAND_OUTLINE, 0.026 * HAND_SCALE, 5), {
    depth: 0.05 * HAND_SCALE,
    bevel: 0.022 * HAND_SCALE,
  });
  // `layout.ts` has to declare this prop's extents (it may not import this file), and the
  // camera fit and the tap target are both solved from those declarations. So the built
  // geometry is measured against them rather than trusted: a hand that outgrows either
  // number is a hand that can be cropped or that falls outside its own collider.
  if (import.meta.env.DEV) {
    const box = geo.boundingBox;
    if (box) {
      const h = box.max.y - box.min.y;
      const rest = Math.max(-box.min.x, box.max.x);
      // Swept, not resting: the hand pivots at its foot, so its widest point at full swing
      // is `rest * cos(w) + h * sin(w)`. See `layout.ts::HAND_HALF_W`.
      const w = rest * Math.cos(HAND_WAVE_MAX) + h * Math.sin(HAND_WAVE_MAX);
      if (h > HAND_HEIGHT + 1e-6 || w > HAND_HALF_W + 1e-6) {
        console.warn(
          `[healthy-or-not] the hand measures ${h.toFixed(3)} tall and sweeps ${w.toFixed(3)} ` +
            `wide against layout's HAND_HEIGHT ${HAND_HEIGHT} / HAND_HALF_W ${HAND_HALF_W}; ` +
            "update them."
        );
      }
    }
  }
  return geo;
}

/** The built hand's floor in its own local space, so the scene can stand it on the table. */
export const handFootY = (): number => handGeometry().boundingBox?.min.y ?? 0;

/**
 * Builds all twelve foods. Call once, from a `useMemo` on the scene's mount — that call is
 * what warms the geometry cache, so a food appearing for the first time in round nine
 * mounts three meshes and builds nothing.
 */
export function buildFoods(): FoodTable {
  // The apple is the only food whose profile is generated rather than typed, so it is the
  // only one that can drift silently. 17.3 degrees measured against the 20 the dish sets.
  assertSmoothProfile(APPLE_PROFILE, 20, "apple");

  /* One ball, scaled everywhere. */
  const ball = softSphere(0.1);

  /*
   * Every clay a food is made of goes through the grain-scaled factories above, not through
   * `clayIvory` / `clayEnamel` / `clayPainted` / `clayAccent`. Those four are correct for a
   * board, a tray or a mascot; on a 0.45-unit apple they put a single grain period across
   * the whole prop, which is the "no fbm micro-grain" the audit measured. See
   * `FOOD_GRAIN_SCALE`.
   */
  const ivory = foodClay("ivory", CLAY.ivory, 0.74, 0.55);
  const enamel = foodClay("enamel", CLAY.enamel, 0.62, 0.5);
  const glass = softGlass();
  const stem = foodClay("stem", CLAY.crevice, 0.78, 0.3);
  const water = foodClay("water", STUDIO.rim.color, 0.66, 0.4);

  const red = foodAccent("red", "main");
  const coral = foodAccent("coral", "main");
  const peach = foodAccent("peach", "main");
  const peachSoft = foodAccent("peach", "soft");
  const rose = foodAccent("rose", "main");
  const roseSoft = foodAccent("rose", "soft");
  const mauveSoft = foodAccent("mauve", "soft");
  const mauveDeep = foodAccent("mauve", "deep");

  /** A leaf / frond: the shared ball squashed into a rounded blade. */
  const leaf = (
    material: Material,
    position: [number, number, number],
    rotation: [number, number, number],
    length: number,
    width: number
  ): Part => part(ball, material, position, rotation, [width / 0.2, length / 0.2, (width * 0.6) / 0.2]);

  const table: FoodTable = {
    /* ---------------- tooth-friendly ---------------- */

    /**
     * Apple — a lathed fruit with a well at each pole, a clay stem standing *in* the top
     * well, and one leaf. `appleGeometry` has the argument for why it is not a sphere.
     *
     * The stem is seated on the measured well floor rather than on a guessed height, so the
     * two cannot drift: `APPLE_WELL_Y` comes off the built profile.
     */
    apple: {
      parts: [
        part(appleGeometry(), red, [0, 0, 0]),
        part(softCapsule(0.019, 0.062), stem, [0.012, APPLE_WELL_Y + 0.046, 0], [0, 0, 0.2]),
        leaf(mauveDeep, [0.085, APPLE_WELL_Y + 0.056, 0.015], [0.35, 0, -0.95], 0.125, 0.062),
      ],
      // Measured off the built parts, not the body alone: the leaf reaches 0.452 and the
      // stem 0.440, and `height` is the tumble pivot and the bounce floor, so it has to
      // cover the tallest of them.
      height: 0.46,
      radius: APPLE_R,
    },

    /** Carrot — a tapered root lying tilted, with a leafy tuft at the thick end. */
    carrot: {
      parts: [
        part(latheProfile(CARROT), peach, [-0.2, 0.135, 0], [0, 0, -(Math.PI / 2 - 0.28)]),
        leaf(mauveDeep, [-0.27, 0.3, 0.03], [0.25, 0, 0.28], 0.22, 0.09),
        leaf(mauveDeep, [-0.32, 0.27, -0.06], [-0.2, 0, 0.62], 0.19, 0.08),
        leaf(mauveDeep, [-0.23, 0.32, -0.03], [0.1, 0, -0.1], 0.2, 0.085),
      ],
      height: 0.43,
      radius: 0.41,
    },

    /** Milk — a glass bottle with milk standing in it and a brand-red cap. */
    milk: {
      parts: [
        part(latheProfile(MILK), enamel, [0, 0, 0]),
        part(latheProfile(BOTTLE), glass, [0, 0, 0]),
        part(roundedCylinder(0.102, 0.075, 0.028), red, [0, 0.535, 0]),
      ],
      height: 0.57,
      radius: 0.17,
    },

    /**
     * Cheese — a rounded wedge, read face-on, with two holes pressed into it.
     *
     * `beveledExtrude` grows the silhouette outward by the bevel on every axis: the wedge
     * is 0.045 wider than `CHEESE_TRI` all round and 0.33 deep, not 0.24. The base offset
     * and the holes' z are set from those *grown* numbers — take them from the shape and
     * the wedge sinks into the pedestal and the holes disappear inside it.
     */
    cheese: {
      parts: [part(cheeseGeometry(), peach, [-0.02, 0.235, 0])],
      height: 0.51,
      radius: 0.32,
    },

    /** Water — a tumbler with a pale still surface in it. */
    water: {
      parts: [
        part(latheProfile(WATER), water, [0, 0, 0]),
        part(latheProfile(TUMBLER), glass, [0, 0, 0]),
      ],
      height: 0.44,
      radius: 0.19,
    },

    /** Strawberry — a lathed teardrop under a fan of calyx leaves. */
    strawberry: {
      parts: [
        part(latheProfile(BERRY), coral, [0, 0, 0]),
        leaf(mauveDeep, [0.09, 0.41, 0.02], [0.2, 0, -1.15], 0.15, 0.075),
        leaf(mauveDeep, [-0.08, 0.41, -0.04], [-0.25, 0, 1.2], 0.14, 0.07),
        leaf(mauveDeep, [0.01, 0.43, -0.09], [1.15, 0, 0], 0.13, 0.07),
      ],
      height: 0.48,
      radius: 0.18,
    },

    /* ---------------- sugary ---------------- */

    /** Lollipop — a swirled disc on an ivory stick. */
    lollipop: {
      parts: [
        part(softCapsule(0.028, 0.26), ivory, [0, 0.16, 0]),
        part(roundedCylinder(0.2, 0.08, 0.032), rose, [0, 0.42, 0], [Math.PI / 2, 0, 0]),
        part(torusSoft(0.115, 0.034), roseSoft, [0, 0.42, 0.03]),
        part(ball, roseSoft, [0, 0.42, 0.05], NO_ROT, [0.5, 0.5, 0.4]),
      ],
      height: 0.62,
      radius: 0.2,
    },

    /** Fizzy drink — a tapered cup, a lid and a bent straw. */
    soda: {
      parts: [
        part(latheProfile(CUP), coral, [0, 0, 0]),
        part(roundedCylinder(0.202, 0.05, 0.02), ivory, [0, 0.41, 0]),
        part(softCapsule(0.03, 0.24), rose, [0.06, 0.58, 0], [0, 0, 0.3]),
      ],
      height: 0.73,
      radius: 0.2,
    },

    /** Cake — a sponge, a thick icing layer, a cherry and one candle. */
    cake: {
      parts: [
        part(roundedCylinder(0.27, 0.2, 0.055), mauveSoft, [0, 0.1, 0]),
        part(roundedCylinder(0.278, 0.1, 0.042), rose, [0, 0.24, 0]),
        part(ball, red, [0.11, 0.32, 0.05], NO_ROT, [0.5, 0.5, 0.5]),
        part(softCapsule(0.024, 0.11), ivory, [-0.06, 0.4, -0.02]),
        part(ball, peachSoft, [-0.06, 0.5, -0.02], NO_ROT, [0.3, 0.45, 0.3]),
      ],
      height: 0.55,
      radius: 0.28,
    },

    /** Sweet — a fat centre with two twisted wrapper ends. */
    candy: {
      parts: [
        part(ball, rose, [0, 0.16, 0], NO_ROT, [1.85, 1.6, 1.4]),
        part(ball, roseSoft, [-0.24, 0.16, 0], [0, 0, 0.5], [0.9, 0.75, 0.55]),
        part(ball, roseSoft, [0.24, 0.16, 0], [0, 0, -0.5], [0.9, 0.75, 0.55]),
      ],
      height: 0.32,
      radius: 0.35,
    },

    /** Doughnut — a ring lying flat, capped by a flattened icing ring. */
    donut: {
      parts: [
        part(torusSoft(0.2, 0.095), mauveDeep, [0, 0.095, 0], FLAT),
        part(torusSoft(0.203, 0.09), rose, [0, 0.145, 0], FLAT, [1, 1, 0.62]),
      ],
      height: 0.2,
      radius: 0.29,
    },

    /** Cupcake — a fluted wrapper, a swirl of frosting and a cherry on top. */
    cupcake: {
      parts: [
        part(latheProfile(WRAPPER), coral, [0, 0, 0]),
        part(ball, peachSoft, [0, 0.36, 0], NO_ROT, [1.95, 1.7, 1.95]),
        part(ball, peachSoft, [0.02, 0.5, 0], NO_ROT, [1.1, 1, 1.1]),
        part(ball, red, [0.02, 0.59, 0.01], NO_ROT, [0.6, 0.6, 0.6]),
      ],
      height: 0.65,
      radius: 0.21,
    },
  };

  // A food in the deal with no prop would present as an empty pedestal and would be very
  // easy to miss in review, so it is a hard error rather than a shrug.
  for (const id of HEALTHY_IDS) assertProp(table, id);
  for (const id of SUGARY_IDS) assertProp(table, id);

  return table;
}

function assertProp(table: FoodTable, id: FoodId): void {
  if (!table[id] || table[id].parts.length === 0) {
    throw new Error(`[healthy-or-not] food "${id}" has no clay prop`);
  }
}

/* ------------------------------------------------------------------ */
/* The mascot                                                          */
/* ------------------------------------------------------------------ */

export type Piece = { geometry: BufferGeometry; material: Material };

export type Mascot = {
  body: Piece;
  eye: Piece;
  glint: Piece;
  /** The resting smile: one sphere-swept tube seated on the crown. Never animated. */
  lip: Piece;
  /** The opening. Grows downward from the lip; invisible at rest. */
  cavity: Piece;
  tongue: Piece;
  cheek: Piece;
  star: Piece;
};

/**
 * The smile, as a single sphere-swept tube lying on a circle drawn on the crown.
 *
 * `layout.ts` carries the derivation and the arithmetic that condemns the five-capsule
 * chain this replaces; here is the construction.
 *
 * `A` is the axis the arc curves around, tilted up and forward in the face's mirror plane;
 * `U = (1, 0, 0)` and `V = A × U` span the plane perpendicular to it. A point at angle
 * `SMILE_ALPHA` from `A` and `θ` around it is
 *
 *   dir(θ) = cos α · A + sin α · (sin θ · U − cos θ · V)
 *
 * a unit vector, so `CROWN_RN · dir(θ)` lands exactly on the fitted crown sphere — checked
 * against the real metaball surface at five points, worst error 0.0022 of tooth height.
 * Written out, with `e(θ) = sin θ · U − cos θ · V` the unit radial and
 * `T(θ) = cos θ · U + sin θ · V` the unit tangent, the centreline is the circle
 *
 *   P(θ) = crownCentre + (CROWN_RN cos α) · A + (CROWN_RN sin α) · e(θ)
 *
 * and `{e(θ), A}` is an orthonormal basis of the plane perpendicular to `T(θ)` at every
 * θ — which is exactly what a tube needs, with no parallel-transport and no twist. The
 * surface is `P(θ) + a · (cos φ · e(θ) + sin φ · A)`, so **every vertex is exactly `a` from
 * the centreline by construction** and the outward normal is the bracket itself. The two
 * ends close with hemispheres swept the same way, so the tube-to-cap join is the same
 * surface continued, not two solids overlapping.
 *
 * Winding, derived rather than guessed (there is no `ensureOutward` outside `geometry.ts`):
 * `A × e = T`, so `(A − e) × T = −e − A` and the triangle `(p[i], p[i+1], q[i+1])` — rows
 * ordered along +T, φ increasing — has normal `−a·ΔL·(e + A)`, i.e. **inward**. The order
 * below is therefore `(p[i], q[i], p[i+1])` / `(p[i+1], q[i], q[i+1])`, whose normals come
 * out `+a·ΔL·(e + A)`, and `assertOutward` re-checks the assembled buffer in DEV.
 *
 * Checked numerically against this construction before it shipped: 626 vertices, 1248
 * triangles, every vertex within 6e-17 of `a` from the centreline, every directed edge used
 * exactly once (so the shell is closed), `6V = +0.006980` — outward — and a volume 97.1 %
 * of the analytic swept tube, which is exactly the inscribed-polygon deficit for 16 x 32.
 */
function buildLipGeometry(): BufferGeometry {
  return cachedGeometry("healthy-or-not/lip", () => {
    const ay = Math.sin(SMILE_AXIS_TILT);
    const az = Math.cos(SMILE_AXIS_TILT);
    const rho = CROWN_RN * Math.sin(SMILE_ALPHA) * TOOTH_H;
    const along = CROWN_RN * Math.cos(SMILE_ALPHA) * TOOTH_H;
    const a = LIP_TUBE_N * TOOTH_H;
    const cy = CROWN_YN * TOOTH_H;

    const RAD = LIP_TUBE_RADIAL;
    const CAP = LIP_CAP_STACKS;
    const RINGS = LIP_TUBE_RINGS;

    const pos: number[] = [];
    const nrm: number[] = [];
    const uv: number[] = [];
    const index: number[] = [];
    const rows: number[][] = [];

    // uv is world position scaled by 2 in `geometry.ts::applyPlanarUV`, i.e. the grain map
    // tiles every half world unit. These are arc lengths, scaled the same way, so the lip
    // carries the same grain frequency as every other prop without a planar projection —
    // which on a tube this thin would smear along the sweep.
    const UV_PER_UNIT = 2;
    const arcLen = 2 * SMILE_SWEEP * rho;

    /** One ring of `RAD` vertices about the centreline point `(px, py, pz)`. */
    const ring = (
      px: number,
      py: number,
      pz: number,
      ex: number,
      ey: number,
      ez: number,
      tx: number,
      ty: number,
      tz: number,
      /** cos of the polar angle: 0 on the tube, →1 at a cap's pole. */
      capCos: number,
      capSin: number,
      u: number
    ): void => {
      const row: number[] = [];
      for (let i = 0; i < RAD; i++) {
        const phi = (i / RAD) * Math.PI * 2;
        const cp = Math.cos(phi);
        const sp = Math.sin(phi);
        // capCos·T + capSin·(cos φ · e + sin φ · A), with A = (0, ay, az).
        const nx = capCos * tx + capSin * cp * ex;
        const ny = capCos * ty + capSin * (cp * ey + sp * ay);
        const nz = capCos * tz + capSin * (cp * ez + sp * az);
        row.push(pos.length / 3);
        pos.push(px + a * nx, py + a * ny, pz + a * nz);
        nrm.push(nx, ny, nz);
        uv.push(u * UV_PER_UNIT, phi * a * UV_PER_UNIT);
      }
      rows.push(row);
    };

    const pole = (px: number, py: number, pz: number, nx: number, ny: number, nz: number, u: number): void => {
      rows.push([pos.length / 3]);
      pos.push(px + a * nx, py + a * ny, pz + a * nz);
      nrm.push(nx, ny, nz);
      uv.push(u * UV_PER_UNIT, 0);
    };

    const at = (theta: number) => {
      const st = Math.sin(theta);
      const ct = Math.cos(theta);
      return {
        // e(θ) = sinθ·U − cosθ·V, with V = (0, az, −ay).
        ex: st,
        ey: -ct * az,
        ez: ct * ay,
        // T(θ) = cosθ·U + sinθ·V.
        tx: ct,
        ty: st * az,
        tz: -st * ay,
        px: rho * st,
        py: cy + along * ay - rho * ct * az,
        pz: along * az + rho * ct * ay,
      };
    };

    const start = at(-SMILE_SWEEP);
    const end = at(SMILE_SWEEP);

    // Start cap: pole first, then stacks travelling +T until the t = 0 ring *is* the tube's
    // first ring. `capCos` is negative here because the cap bulges backwards along −T.
    pole(start.px, start.py, start.pz, -start.tx, -start.ty, -start.tz, -(Math.PI / 2) * a);
    for (let k = 1; k <= CAP; k++) {
      const t = 1 - k / CAP;
      const psi = t * (Math.PI / 2);
      ring(
        start.px, start.py, start.pz,
        start.ex, start.ey, start.ez,
        start.tx, start.ty, start.tz,
        -Math.sin(psi), Math.cos(psi),
        -psi * a
      );
    }
    for (let j = 1; j < RINGS; j++) {
      const theta = -SMILE_SWEEP + (j / RINGS) * 2 * SMILE_SWEEP;
      const q = at(theta);
      ring(q.px, q.py, q.pz, q.ex, q.ey, q.ez, q.tx, q.ty, q.tz, 0, 1, (j / RINGS) * arcLen);
    }
    // End cap: the t = 0 ring is the tube's last ring, then stacks on to the pole.
    for (let k = 0; k < CAP; k++) {
      const t = k / CAP;
      const psi = t * (Math.PI / 2);
      ring(
        end.px, end.py, end.pz,
        end.ex, end.ey, end.ez,
        end.tx, end.ty, end.tz,
        Math.sin(psi), Math.cos(psi),
        arcLen + psi * a
      );
    }
    pole(end.px, end.py, end.pz, end.tx, end.ty, end.tz, arcLen + (Math.PI / 2) * a);

    for (let r = 0; r + 1 < rows.length; r++) {
      const p = rows[r];
      const q = rows[r + 1];
      if (p.length === 1) {
        for (let i = 0; i < q.length; i++) index.push(p[0], q[i], q[(i + 1) % q.length]);
      } else if (q.length === 1) {
        for (let i = 0; i < p.length; i++) index.push(p[i], q[0], p[(i + 1) % p.length]);
      } else {
        for (let i = 0; i < p.length; i++) {
          const j = (i + 1) % p.length;
          index.push(p[i], q[i], p[j]);
          index.push(p[j], q[i], q[j]);
        }
      }
    }

    const geo = new BufferGeometry();
    geo.setAttribute("position", new BufferAttribute(new Float32Array(pos), 3));
    geo.setAttribute("normal", new BufferAttribute(new Float32Array(nrm), 3));
    geo.setAttribute("uv", new BufferAttribute(new Float32Array(uv), 2));
    geo.setIndex(index);
    bakeCurvatureAO(geo);
    geo.computeBoundingBox();
    geo.computeBoundingSphere();
    assertOutward(geo, "lip");
    return geo;
  });
}

/**
 * DEV-only winding check, and the reason it exists.
 *
 * `geometry.ts::finish` runs `ensureOutward` on every shared builder, but it is private —
 * a geometry assembled inside a game has to get its own triangle order right. An inverted
 * shell is not a crash and not a warning: with `FrontSide` materials it renders as a hole
 * you can see the studio through, which is precisely the kind of defect that survives to a
 * screenshot. Six times the signed volume of a closed mesh is `sum(a · (b × c))` over its
 * triangles, positive exactly when the winding is counter-clockwise from outside.
 */
function assertOutward(geo: BufferGeometry, name: string): void {
  if (!import.meta.env.DEV) return;
  const index = geo.getIndex();
  const posAttr = geo.getAttribute("position");
  if (!index || !posAttr) return;
  const p = posAttr.array as ArrayLike<number>;
  const ia = index.array as ArrayLike<number>;
  let volume = 0;
  for (let t = 0; t < ia.length; t += 3) {
    const a = ia[t] * 3;
    const b = ia[t + 1] * 3;
    const c = ia[t + 2] * 3;
    volume +=
      p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) +
      p[a + 1] * (p[b + 2] * p[c] - p[b] * p[c + 2]) +
      p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  if (volume <= 0) {
    console.warn(`[healthy-or-not] ${name} is wound inside-out (6V = ${volume.toFixed(6)}).`);
  }
}

/**
 * Where a blush ball sits so that its cap is tangent to the crown.
 *
 * A sphere of radius `CHEEK_BALL_RN` pushed along the crown normal until exactly
 * `CHEEK_PROUD_N` of it stands proud. Because the ball's curvature is close to the crown's,
 * the two surfaces meet at a shallow angle and the blush shades with the form. Measured
 * against the real tooth: cap half-width 0.078, peak relief 0.015, and the two surfaces
 * meet at **22°** — where the ellipsoid it replaces met the crown at **108°**, which is the
 * hard, unshaded boundary the audit photographed.
 */
function cheekCentre(side: number): [number, number, number] {
  const dy = CHEEK_YN - CROWN_YN;
  const zn = Math.sqrt(Math.max(0, CROWN_RN * CROWN_RN - CHEEK_XN * CHEEK_XN - dy * dy));
  const offset = (CROWN_RN - CHEEK_BALL_RN + CHEEK_PROUD_N) / CROWN_RN;
  return [
    side * CHEEK_XN * offset * TOOTH_H,
    (CROWN_YN + dy * offset) * TOOTH_H,
    zn * offset * TOOTH_H,
  ];
}

export const CHEEK_LEFT = cheekCentre(-1);
export const CHEEK_RIGHT = cheekCentre(1);
/** Uniform scale that turns the shared `softSphere(0.1)` into the blush ball. */
export const CHEEK_SCALE = (CHEEK_BALL_RN * TOOTH_H) / 0.1;

/**
 * The mouth's interior, as a private copy of the shared ball carrying a depth ramp.
 *
 * The cavity is a convex solid pushed through a convex crown, so there is no concave
 * surface for the key to fall off across and it renders as one flat patch whatever colour
 * it is painted — which is exactly what the audit photographed. The ramp lives in
 * `aAlbedo`, keyed on the vertex's own `z / r`: full token at the rim where the opening
 * meets the lip, `MOUTH_DARK` at the pole. It is a shading term, not a sixth colour.
 *
 * The copy is not optional: `aAlbedo` is a per-vertex attribute and `softSphere(0.1)` is
 * the geometry fifteen other props in this file share. It goes through `cachedGeometry`
 * under this game's own key so it is still attributed to this scene and evicted with it.
 */
function buildCavityGeometry(): BufferGeometry {
  return cachedGeometry("healthy-or-not/mouth-cavity", () => {
    const geo = softSphere(0.1).clone();
    const posAttr = geo.getAttribute("position");
    const count = posAttr.count;
    const values = new Float32Array(count * 3);
    const span = 1 - MOUTH_DARK_FROM;
    for (let i = 0; i < count; i++) {
      const u = posAttr.getZ(i) / 0.1;
      const raw = (u - MOUTH_DARK_FROM) / span;
      const t = raw < 0 ? 0 : raw > 1 ? 1 : raw;
      // Quadratic rather than linear: the rim has to stay at the lip's own value so the
      // two read as one surface, and all of the darkening belongs near the pole.
      const m = 1 - (1 - MOUTH_DARK) * t * t;
      values[i * 3] = m;
      values[i * 3 + 1] = m;
      values[i * 3 + 2] = m;
    }
    geo.setAttribute(ALBEDO_ATTRIBUTE, vertexAlbedoAttribute(values));
    return geo;
  });
}

/**
 * The friendly tooth.
 *
 * Its face is deliberately made of the smallest possible number of pieces: two eyes with a
 * catchlight, a smile that is always there, an opening behind it, a tongue and two blush
 * pads. No brows, no outline, no expression that can ever turn — there is exactly one face
 * in this game and it is happy.
 *
 * The lip and the opening are `coral.deep`, not `CLAY.crevice`. `CLAY.crevice` is
 * `tokens.ts`'s ambient-occlusion tint — the colour the shader puts *in* a crease — and
 * painting the mascot's mouth with it made the most legible feature on an ivory face a
 * brown line, which on a tooth reads as a stain rather than as a smile. `coral.deep` is a
 * real accent family, it pairs with the `coral.soft` blush already on the cheeks, and it
 * carries the cavity's ramp down to a deep warm maroon without leaving the palette.
 */
export function buildMascot(): Mascot {
  const ball = softSphere(0.1);
  const mouth = clayAccent("coral", "deep");
  return {
    body: { geometry: toothGeometry("baby"), material: clayEnamel() },
    eye: { geometry: ball, material: clayPainted(NEUTRAL.ink) },
    glint: { geometry: ball, material: clayIvory() },
    lip: { geometry: buildLipGeometry(), material: mouth },
    cavity: { geometry: buildCavityGeometry(), material: mouth },
    tongue: { geometry: ball, material: clayAccent("rose", "main") },
    cheek: { geometry: ball, material: clayAccent("coral", "soft") },
    star: {
      geometry: beveledExtrude(lobedShape(4, 0.05, 0.17, 64), { depth: 0.07, bevel: 0.026 }),
      // `peach.soft` (#f8ead9) against the page cream (#ede7dc) is a difference of 11 / 4 /
      // -3 out of 255 — the "well done" star was the least legible thing on screen and it
      // is the reward. `peach.main` is the same family, three stops down.
      material: clayAccent("peach", "main"),
    },
  };
}

/* ------------------------------------------------------------------ */
/* The turntable, the dish and the hand                                */
/* ------------------------------------------------------------------ */

export type SetPieces = {
  /** The turntable slab and its rim are sized from the measured play area, so the scene
   *  builds their geometry itself; only the materials are fixed here. */
  discMaterial: Material;
  rimMaterial: Material;
  pedestal: Piece;
  bead: Piece;
  beadDone: Piece;
  /**
   * The "no thank you" dish: an open bowl with a rolled rim and a darker landing pad,
   * welded into **one** lathe (see `dishGeometry`).
   */
  dish: Piece;
  /** The waving "bye bye" hand that stands behind it. See `handGeometry`. */
  hand: Piece;
};

/** Turntable slab geometry for a given radius. Cached by radius like everything else. */
export const discFor = (radius: number): BufferGeometry => roundedCylinder(radius, TABLE_H, 0.06);
/** Rolled rim so the turntable's edge is never a lip you could cut yourself on. */
export const rimFor = (radius: number, tube: number): BufferGeometry => torusSoft(radius, tube);

/**
 * The dish's cross-section, revolved: up the outside, rolled over at the rim, back down
 * the inside to a flat well floor, closed on the axis at both ends so the lathe is a
 * watertight solid rather than an open shell.
 *
 * Every point derives from the four numbers `layout.ts` publishes, so the height a food is
 * thrown at (`DISH_REST_Y`) and the floor it lands on cannot drift apart.
 *
 * It is *generated* rather than typed out because a hand-placed rim is where 3D-SPEC §3's
 * "no 90-degree silhouette corner" quietly gets broken: a first draft of this profile
 * turned 77.5 degrees in a single step where the outer wall met the roll, which smooth
 * vertex normals hide in the shading and do nothing about in the outline. Each of the
 * three arcs below is entered and left on the tangent the next one starts with, and the
 * steepest step anywhere on it is the roll's 30 degrees — the same angular resolution
 * `roundedCylinder` uses for its own bevels. `assertSmoothProfile` proves it in DEV.
 */
function dishProfile(): [number, number][] {
  const roll = DISH_WALL / 2;
  const wallTop = DISH_H - roll;
  const rInner = DISH_R - DISH_WALL;
  const rBase = DISH_R * 0.45;
  const rFloor = rInner - 0.09;
  const p: [number, number][] = [[0, 0], [rBase, 0]];

  // Outer wall: a quarter-ellipse from the flat foot to the foot of the rim roll. It leaves
  // the base horizontal (u = 0) and arrives vertical (u = pi/2), so both joints are
  // tangent-continuous and neither is a corner.
  for (let i = 1; i <= OUTER_STEPS; i++) {
    const u = (i / OUTER_STEPS) * (Math.PI / 2);
    p.push([rBase + (DISH_R - rBase) * Math.sin(u), wallTop * (1 - Math.cos(u))]);
  }
  // The rim roll: a true half-round of radius `roll`, entered and left vertically.
  for (let i = 1; i < ROLL_STEPS; i++) {
    const th = (i / ROLL_STEPS) * Math.PI;
    p.push([DISH_R - roll + roll * Math.cos(th), wallTop + roll * Math.sin(th)]);
  }
  // Inner wall: the mirror of the outer one — vertical at the rim, horizontal at the floor.
  for (let i = 0; i <= INNER_STEPS; i++) {
    const v = (i / INNER_STEPS) * (Math.PI / 2);
    p.push([rInner - (rInner - rFloor) * (1 - Math.cos(v)), wallTop - (wallTop - DISH_FLOOR_Y) * Math.sin(v)]);
  }
  /*
   * The landing pad, which used to be a second mesh (`layout.ts::DISH_PAD_R` has the
   * z-fight arithmetic). A raised-cosine fillet from the floor up to the pad's top face:
   * zero slope at both ends, so it joins the floor and the pad tangentially and there is no
   * crease at either foot. `DISH_PAD_RISE / (rFloor - DISH_PAD_R)` is 0.57, so the steepest
   * point of the ramp is `atan(pi/2 * 0.57)` = 41.9 degrees — which is a fillet, not a
   * corner, and `assertSmoothProfile` measures the per-segment turn rather than the slope.
   */
  for (let i = 1; i <= PAD_STEPS; i++) {
    const w = i / PAD_STEPS;
    p.push([
      rFloor - (rFloor - DISH_PAD_R) * w,
      DISH_FLOOR_Y + DISH_PAD_RISE * (1 - Math.cos(Math.PI * w)) / 2,
    ]);
  }
  p.push([0, DISH_REST_Y]);
  return p;
}

/*
 * Profile resolution, and why this profile is `smooth: false`.
 *
 * `latheProfile`'s default `smooth` runs the control points through a `SplineCurve` and
 * resamples at `max(6 * points, 24)` — six samples per authored segment. That is exactly
 * right for a profile a human typed by eye (`CARROT`, `MILK`, `BERRY`), and it is pure cost
 * for one that is *generated* from arcs, because the arcs are already the curve. The old
 * 18-point dish became 108 rings and 6,848 triangles; the profile below is sampled by its
 * own arithmetic at 36 rings and costs **2,208** — finer where curvature is (15 degrees per
 * step around the rim roll, an 0.00024-unit sagitta) and a third of the triangles.
 *
 * The step counts are chosen against the sagitta at the framing this game ships (about
 * 268 px per world unit on a laptop):
 *   outer wall  8 steps over 90 deg on r ~ 0.22 -> 0.0011 units = 0.29 px
 *   rim roll   12 steps over 180 deg on r = 0.028 -> 0.00024 units = 0.06 px
 *   inner wall  6 steps over 90 deg -> 0.0013 units = 0.35 px
 * all comfortably under half a pixel, which is the same bar `MIN_SILHOUETTE_SEGMENTS` is
 * derived against in `geometry.ts`.
 */
const OUTER_STEPS = 8;
const ROLL_STEPS = 12;
const INNER_STEPS = 6;
const PAD_STEPS = 6;

export const DISH_PROFILE = dishProfile();

/**
 * The dish, as one mesh: bowl and landing pad welded together, two tones carried on the
 * geometry's per-vertex albedo rather than on a second material.
 *
 * Why the albedo and not two meshes: two meshes is what produced the stippled ring the
 * audit photographed (see `layout.ts::DISH_PAD_R`), and a single welded lathe additionally
 * lets `bakeCurvatureAO` find the concave corner at the pad's foot — the baker only ever
 * sees curvature within one mesh, so a pad dropped in as a separate prop can never have a
 * seated look no matter how the two are positioned (round 4, A14 fix 4).
 *
 * The ramp is where the two tones cross, and the crossing is a smoothstep over exactly the
 * ramp's own radial span, so the colour change and the form change are the same event and
 * neither prints an edge the other does not.
 */
function dishGeometry(bowl: string, pad: string): BufferGeometry {
  const rFloor = DISH_R - DISH_WALL - 0.09;
  return albedoRamp(
    `healthy-or-not/dish|${bowl}|${pad}`,
    // `latheProfile` is the shared builder, so the mesh arrives welded, planar-UV'd and
    // AO-baked before the ramp is written onto the clone. Its own cache entry is then never
    // rendered — a few hundred vertices of CPU-side waste, never uploaded, and evicted with
    // this scene like every other entry `tagCacheEntry` attributes to it.
    () => latheProfile(DISH_PROFILE, undefined, false),
    bowl,
    pad,
    bowl,
    (x, _y, z) => {
      // 0 on the pad, 1 on the bowl floor and everywhere above it, smoothstepped over
      // exactly the ramp's own radial span so the colour change and the form change are the
      // same event and neither prints an edge the other does not.
      const t = clamp01((Math.hypot(x, z) - DISH_PAD_R) / (rFloor - DISH_PAD_R));
      return t * t * (3 - 2 * t);
    }
  );
}

/**
 * DEV-only: the largest direction change between consecutive profile segments.
 *
 * A lathe's silhouette *is* its profile, so a turn here is a visible crease on the finished
 * prop no matter how smooth the vertex normals are. 30 degrees is the step `roundedCylinder`
 * itself takes across a bevel at the middle quality tier, so that is the bar.
 */
/**
 * The largest direction change between consecutive points of a lathe profile, in degrees.
 *
 * Exported so a check can *report* the number rather than only assert against it — the
 * previous version of this file measured its profile with a re-implementation in a scratch
 * script, which is exactly how a measurement comes to describe code that is no longer there.
 */
export function profileWorstTurn(points: readonly [number, number][]): number {
  let worst = 0;
  for (let i = 1; i + 1 < points.length; i++) {
    const ax = points[i][0] - points[i - 1][0];
    const ay = points[i][1] - points[i - 1][1];
    const bx = points[i + 1][0] - points[i][0];
    const by = points[i + 1][1] - points[i][1];
    const la = Math.hypot(ax, ay);
    const lb = Math.hypot(bx, by);
    if (la < 1e-9 || lb < 1e-9) continue;
    const cos = Math.min(1, Math.max(-1, (ax * bx + ay * by) / (la * lb)));
    const turn = (Math.acos(cos) * 180) / Math.PI;
    if (turn > worst) worst = turn;
  }
  return worst;
}

function assertSmoothProfile(points: readonly [number, number][], limit: number, name: string): void {
  if (!import.meta.env.DEV) return;
  const worst = profileWorstTurn(points);
  if (worst > limit) {
    console.warn(
      `[healthy-or-not] ${name} profile turns ${worst.toFixed(1)} degrees in one step ` +
        `(limit ${limit}); that is a hard silhouette corner, 3D-SPEC section 3.`
    );
  }
}


export function buildSet(): SetPieces {
  // 20 degrees, down from 31, and derived rather than picked: the dish's own worst turn is
  // 19.4 (the pad ramp's foot) and the apple's is 17.3, so the limit sits just above what
  // the two shipped profiles actually do. It was 31 because the old rim roll took 30-degree
  // steps; it does not any more, and a limit set to whatever the code happens to do is a
  // limit that can never fail.
  assertSmoothProfile(DISH_PROFILE, 20, "dish");

  /*
   * The progress beads are two 12-instance meshes, so their triangle count is multiplied by
   * twenty-four. At the size they render — under a centimetre of world space — the hero
   * ball's 980 triangles buy nothing, and detail 2 costs 500.
   */
  const pebble = softSphere(0.1, 2);

  /*
   * The turntable is furniture, and it was competing with the food.
   *
   * Measured off `healthy-or-not-rest.png`: the rim rendered `#ee974e` and the cheese
   * standing on it `#f29d57` — the same hue, the same saturation, four units of value
   * apart. The three surfaces are now one quiet warm-grey ramp with no chroma in it at
   * all, stepped far enough apart to read as three things:
   *
   *   pedestal  NEUTRAL.line  #d9d2c2   the food stands on the darkest of them
   *   disc      CLAY.ivory    #fbf6ec   +34 / +36 / +42 against the pedestal
   *   rim       NEUTRAL.well  #e3dccd   −24 / −26 / −31 against the disc
   *
   * Adjacent pairs never differ by less than 24 units, which is the failure the audit
   * measured elsewhere in the product (large surfaces under one unit apart), and nothing
   * on the table carries a hue that can be mistaken for something edible.
   */
  const disc = clay("healthy/disc", {
    color: CLAY.ivory,
    roughness: 0.74,
    sheen: 0.22,
    grain: 0.13,
  });
  const rim = clay("healthy/rim", {
    color: NEUTRAL.well,
    roughness: 0.78,
    sheen: 0.16,
    grain: 0.13,
  });
  /*
   * One dark warm grey for the pedestal and for the empty bead sockets, not two.
   *
   * They used to be separate `clay()` entries differing by 0.02 of roughness, 0.02 of sheen
   * and 0.03 of grain — a distinction nothing on screen can carry, on a prop that renders
   * about 8 px across. It cost a material, and this scene needs the headroom: measured, the
   * worst pair of mounted foods plus the set plus the mascot is 20 materials, and
   * `BUDGETS.materials` is 28 against a shared focus ring that brings four more of its own
   * whenever a keyboard child is playing.
   */
  const stone = clay("healthy/pedestal", {
    color: NEUTRAL.line,
    roughness: 0.8,
    sheen: 0.12,
    grain: 0.17,
  });

  return {
    discMaterial: disc,
    rimMaterial: rim,
    pedestal: { geometry: roundedCylinder(PED_R, PED_H, 0.07), material: stone },
    bead: { geometry: pebble, material: stone },
    // `coral.main` and not `peach.main`: a done bead used to be painted the same token as
    // the turntable rim it sits beside, so the ring of progress was invisible at the ~8 px
    // it renders. The scene also raises a done bead clear of the disc and lets it cast, so
    // the difference between "empty" and "done" is a shadow as well as a colour.
    beadDone: { geometry: pebble, material: clayAccent("coral", "main") },
    /*
     * The dish is this game's hero colour, and the hero colour is the registry's (A15).
     *
     * The audit classified every saturated pixel in the play area to its nearest family and
     * found **0.1 %** of them nearest `peach` — the family `GAMES["healthy-or-not"].accent`
     * declares and the difficulty pills 250 px above the set already wear — against 64.3 %
     * mauve. That 64.3 % is almost entirely this one prop: it is the largest saturated
     * surface in the frame by a wide margin.
     *
     * The dish is also the *right* prop to carry it, and the foods are not: a food's colour
     * is information a four-year-old is being asked to read (an apple is red, a carrot is
     * orange), so it cannot be reassigned to satisfy a registry. The furniture can.
     *
     * `deep` rather than `main` because `peach.main` is the carrot and the cheese. At
     * `#c97a34` against their `#efa160` the bowl is 14 L* below both, which is the same
     * separation the turntable's three greys were given for the same reason.
     */
    dish: {
      geometry: dishGeometry(accent(HERO_FAMILY, "deep"), CLAY.crevice),
      material: clay(`healthy/dish:${HERO_FAMILY}`, {
        color: accent(HERO_FAMILY, "deep"),
        roughness: 0.72,
        wrap: 0.24,
        sss: accent(HERO_FAMILY, "soft"),
        sssStrength: 0.34,
        sheen: 0.3,
        grain: 0.12,
        // 0.55 world units across the pad, 0.78 across the bowl: `grainScale` 4 is the
        // knob's ceiling and puts ~3 grain periods on the pad. See `FOOD_GRAIN_SCALE`.
        grainScale: 3,
      }),
    },
    hand: {
      geometry: handGeometry(),
      material: clay("healthy/hand", {
        color: CLAY.ivoryDeep,
        roughness: 0.76,
        wrap: 0.26,
        sss: CLAY.sss,
        sssStrength: 0.5,
        sheen: 0.4,
        grain: 0.12,
        grainScale: 4,
      }),
    },
  };
}
