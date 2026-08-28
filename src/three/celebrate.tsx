/**
 * The shared celebration — the last two seconds of all nine games.
 *
 * Choreography (non-reduced, 1.90s total):
 *   0.00–0.10  stillness. Nothing on screen but the podium.
 *   0.10–0.24  a contact shadow arrives, wide and soft, and the whole group dips.
 *              The shadow anticipating the prop is the oldest trick in hand-drawn
 *              animation and it is what buys the pop its weight.
 *   0.24–0.60  the mascot drops in, scaling 0 → 1 on easeOutBack while the shadow
 *              tightens under it (a close object casts a small, dark shadow).
 *   0.60       impact: confetti bursts radially, the camera takes a tiny nudge, and the
 *              mascot snaps into a squash that recovers elastically over 0.40s.
 *   0.62–1.76  sparkles pop (elastic) and fade, staggered per instance.
 *   0.9–1.5    confetti passes its apex and fades out on the way down. It never lands.
 *   1.20–1.70  the idle breath ramps in.
 *   1.90       onDone — GameShell can re-enable Play again.
 *
 * The hero is the product's mascot — face, arms and feet, from `geometry.ts::mascotParts` —
 * standing on a small clay podium. It used to be a bare `toothGeometry("baby")` floating in
 * mid-air, which is a crown and two splayed roots: an *extracted tooth*, presented as the
 * reward for finishing, in a product built to make dentistry unfrightening. That is the
 * single most important frame in the product and it is now the mascot grinning at the child.
 *
 * Budget: two InstancedMeshes, the podium, the contact blob and thirteen small mascot parts —
 * ~17 draw calls and ~19k triangles at high tier, against 90 and 180k. Per-frame code writes
 * straight into instance buffers through module-level scratch objects — no allocation, no
 * React render.
 */
import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import {
  AdditiveBlending,
  BufferAttribute,
  DynamicDrawUsage,
  Euler,
  InstancedBufferAttribute,
  Matrix4,
  MeshBasicMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Quaternion,
  Vector3,
  type Camera,
  type DirectionalLight,
  type Group,
  type InstancedMesh,
  type Object3D,
} from "three";

import {
  Timeline,
  clamp01,
  easeOutBack,
  easeOutCubic,
  easeOutElastic,
  safeDelta,
  squashFor,
} from "./anim";
import { CameraRig } from "./camera";
import { DisposalBag } from "./dispose";
import { flakeChip, mascotParts, roundedCylinder } from "./geometry";
import { ALBEDO_ATTRIBUTE, clay, instanceAlbedoAttribute, writeAlbedo } from "./materials";
import { getQuality } from "./quality";
import { ContactBlob, RIG_GROUND_NAME } from "./Rig";
import { isReduced } from "./store";
import { sparkleTexture } from "./textures";
import { CELEBRATION_COPY_BAND } from "./view-slot";
import { ACCENTS, CLAY, color, type AccentFamily } from "./tokens";

/* ------------------------------------------------------------------ */
/* Tuning                                                              */
/* ------------------------------------------------------------------ */

/** Hero height in world units (1 unit = 10 cm), per §2 of the spec. */
const TOOTH_HEIGHT = 1.05;
/** Confetti leaves the tooth's crown, not the table. */
const LAUNCH_Y = 0.86;
/**
 * Stylised gravity. Real gravity at this scale is 98 u/s², which reads as a video-game
 * physics demo; 16 gives a stop-motion hang time of ~0.35s to apex.
 */
const GRAVITY = -16;
/** Air drag on the chips — thin clay flakes shed speed fast, which is what sells "paper". */
const DRAG = 1.15;
const ANG_DRAG = 1.05;
const TAU = Math.PI * 2;

/**
 * **Chips are never allowed to land.**
 *
 * They used to. `REST_Y = 0.019` laid every chip flat on a ground plane that the celebration
 * does not draw — `GameShell` mounts the burst with `ground={false}` so the room the child
 * was just playing in stays visible behind it — and the result, in every celebration frame
 * of the round-2 evidence set, was a dead-flat perfectly coplanar sheet of confetti hanging
 * in mid-air, hard-clipped at both View-rect edges, passing straight through the hero's
 * midsection, with the game's own horizon contradicting it from behind.
 *
 * A resting carpet is not what a confetti burst looks like anyway. Real confetti leaves
 * frame. So a chip fades out on the way down instead of settling: once it has passed its
 * apex and dropped below `FADE_START_Y` it scales to nothing over `FADE_SECONDS` and retires.
 * There is no ground contact anywhere in the integrator, which means there is no second
 * horizon, no interpenetration with the hero's body, and no dependence on where the finishing
 * game happened to put its floor.
 */
const FADE_START_Y = 0.34;
const FADE_SECONDS = 0.42;

/**
 * Hard cap on how far a chip may travel from the hero, in world units.
 *
 * At the celebration framing (28° lens, 8.4 units back) the visible half-height at the hero's
 * depth is ~2.09 units, so a burst that throws chips further than this is guaranteed to clip
 * at the View rect on the narrow axis — which is exactly what the audit photographed. The cap
 * is applied to position rather than to the initial impulse so it holds whatever the drag and
 * the frame rate do.
 */
const BURST_RADIUS = 1.62;
/**
 * …and a floor on the same distance. A chip launched almost straight up falls back through
 * the hero's crown; giving every chip a minimum outward speed means the burst opens away from
 * the body instead of raining through it.
 */
const MIN_BURST_SPEED = 1.15;

/**
 * Fraction of `quality.maxInstances` the burst actually uses.
 *
 * Round 3's word for the burst was "spray", and half of that is density: 260 flakes at
 * roughly twelve screen pixels each is an atomised cloud, not confetti. Trading a third of
 * the count for `CHIP_CLASSES`' larger flakes keeps about the same coverage while making an
 * individual flake legible as an object — which is the difference between a burst and a
 * Coverage, computed rather than eyeballed: the old burst threw 260 chips of mean area
 * `(0.12 x 1.05)^2 = 0.0159` units^2, i.e. 4.13 units^2 of ink; the new one throws 156 of
 * `(0.13 x 1.05)^2 = 0.0186`, i.e. **2.91 units^2 — 70 % of the ink in 60 % of the pieces**,
 * each 14 % larger across and carrying five lobes to be read by. It costs 156 x 96 = 15.0k
 * triangles against the old 260 x 48 = 12.5k: 2.5k more, and still a twentieth of the 334k
 * this burst cost in round 2.
 */
const CONFETTI_DENSITY = 0.6;

/**
 * The three size classes a burst is composed of, as multipliers on the chip geometry, with
 * the maximum aspect distortion each is allowed.
 *
 * The old scheme drew a "pill" 38 % of the time at `sy / sx` up to **3.9:1**. That single
 * number is most of why the burst read as spatter: a 4:1 rounded octagon twelve pixels long
 * is a streak. Capping the aspect at 1.45 and giving the burst a deliberate mix of big, mid
 * and small flakes is what a handful of thrown confetti actually looks like — a few large
 * pieces that read as shapes, a lot of medium ones, and some specks for texture.
 */
const CHIP_CLASSES = [
  { lo: 1.3, hi: 1.62, aspectMax: 1.12 },
  { lo: 0.95, hi: 1.2, aspectMax: 1.28 },
  { lo: 0.62, hi: 0.84, aspectMax: 1.45 },
  { lo: 0.95, hi: 1.2, aspectMax: 1.28 },
] as const;

/** Podium is 0.11 tall and centred on its own origin, so this puts its top at y = 0. */
const PODIUM_POS: [number, number, number] = [0, -0.055, 0];

/**
 * Peak per-sparkle brightness. The page is #EDE7DC — very bright — so an additive glow
 * clips to white quickly; this is the one value in the file that has to be judged by eye
 * on a real screen rather than reasoned about.
 */
const SPARKLE_PEAK = 0.45;

const T_BURST = 0.6;
const T_SPARKLE = 0.62;
const T_DONE = 1.9;
/** Reduced-motion path: one 150 ms reveal and a beat before onDone. */
const T_REDUCED_REVEAL = 0.15;
const T_REDUCED_DONE = 0.32;

const FAMILIES: AccentFamily[] = ["red", "coral", "peach", "rose", "mauve"];

/* ------------------------------------------------------------------ */
/* Module scratch — shared by every frame, never reallocated           */
/* ------------------------------------------------------------------ */

const mtx = new Matrix4();
const vPos = new Vector3();
const vScale = new Vector3();
const quat = new Quaternion();
const quatParent = new Quaternion();
const eul = new Euler();
const scratchScale = { x: 1, y: 1, z: 1 };

/** Deterministic per-celebration randomness — a fixed cost, no Math.random in hot code. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * CIE 1976 L* of an sRGB hex. Used to hold a floor under the burst, and to prove it.
 */
function lstar(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const r = lin(((n >> 16) & 255) / 255);
  const g = lin(((n >> 8) & 255) / 255);
  const b = lin((n & 255) / 255);
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const f = y > 216 / 24389 ? Math.cbrt(y) : (24389 / 27) * y + 16 / 116;
  return 116 * f - 16;
}

/**
 * Lightness floor for a confetti albedo. `red.deep #c21e25` is the darkest token in the
 * brand at **L\* 42.0**, and `rose.deep #b2343f` at 41.7 — so no token in `ACCENTS` breaches
 * this, and the round-3 finding that the burst histogrammed at "darkest L\* 23" is not an
 * albedo problem at all. It is a *shading* one: a thin flake tumbling on three axes spends
 * about half its time with its face turned away from the key, and a back-facing clay surface
 * is lit by nothing but the environment. See `confettiMat` for what was done about that.
 *
 * The floor is still asserted, in dev, over every family's palette, because the thing that
 * produced "dried blood" in round 2 was a *pipeline* change nobody re-histogrammed.
 */
const CONFETTI_MIN_L = 40;

/**
 * The burst palette, composed rather than sampled.
 *
 * The old mix drew each chip independently: 60 % from the game's own family, and within that
 * 42 % `main` / 36 % `soft` / 22 % `deep`. Over Count the Teeth's coral field that put roughly
 * a fifth of the burst at a saturated deep tone *on top of a saturated ground of the same
 * hue*, which is why round 3 measured it as red-on-red spatter — and over the eight games
 * whose ground is cream it put a third of the burst at a `soft` tone barely separable from
 * the page. One mix, two opposite failures, because it never looked at what it was landing on.
 *
 * Ten slots, dealt round-robin. The composition rules, in order of what they protect:
 *
 *  1. **Never the game's own family at a deep tone.** Both deep slots come from other
 *     families, so "red over red" cannot happen whatever the accent is.
 *  2. **The own family is capped at two slots in ten** (was six), and contributes only `soft`
 *     and `main` — enough to tie the burst to the game, not enough to disappear into it.
 *  3. **Every one of the five families appears in every burst**, plus one cream flake. A mix
 *     that spans the whole palette reads as confetti; a mix that spans one hue reads as spray.
 *  4. **All three lightness registers are always present** — five mid (L\* 50-73), three
 *     light (L\* 84-98), two deep (L\* 42-59). Whatever ground it lands on, cream or
 *     saturated, at least one register separates from it. That is the honest version of "pick
 *     the palette against the receiving ground": the celebration is mounted by `GameShell`
 *     and does not know the ground, so the mix is built to survive either.
 *  5. **Consecutive slots alternate register and family**, so any five chips in a row span
 *     four families and all three registers.
 */
export function confettiPalette(family: AccentFamily): string[] {
  const others = FAMILIES.filter((f) => f !== family);
  return [
    ACCENTS[others[0]].main,
    ACCENTS[family].soft,
    ACCENTS[others[1]].main,
    ACCENTS[others[2]].deep,
    CLAY.enamel,
    ACCENTS[others[3]].main,
    ACCENTS[others[1]].soft,
    ACCENTS[family].main,
    ACCENTS[others[0]].deep,
    ACCENTS[others[2]].main,
  ];
}

if (import.meta.env.DEV) {
  const bad: string[] = [];
  for (const f of FAMILIES) {
    for (const hex of confettiPalette(f)) {
      const l = lstar(hex);
      if (l < CONFETTI_MIN_L) bad.push(`${f}: ${hex} L*${l.toFixed(1)}`);
    }
  }
  if (bad.length > 0) {
    console.error(
      `[lumident/celebrate] confetti albedos below the L* ${CONFETTI_MIN_L} floor — the burst ` +
        `is the last frame of every run in a paediatric dental clinic:\n  ${bad.join("\n  ")}`
    );
  }
}

/* ------------------------------------------------------------------ */
/* Runtime state                                                       */
/* ------------------------------------------------------------------ */

type Runtime = {
  /** Confetti. `n` is buffer capacity; `live` is how many this run actually uses. */
  n: number;
  live: number;
  px: Float32Array;
  py: Float32Array;
  pz: Float32Array;
  vx: Float32Array;
  vy: Float32Array;
  vz: Float32Array;
  ex: Float32Array;
  ey: Float32Array;
  ez: Float32Array;
  wx: Float32Array;
  wy: Float32Array;
  wz: Float32Array;
  sx: Float32Array;
  sy: Float32Array;
  sz: Float32Array;
  /** 1 while a chip is at full size, ramping to 0 as it fades out. 0 = retired. */
  fade: Float32Array;
  rest: Uint8Array;

  /** Sparkles. `ns` is capacity, `nsLive` how many this run uses. */
  ns: number;
  nsLive: number;
  spX: Float32Array;
  spY: Float32Array;
  spZ: Float32Array;
  spSize: Float32Array;
  spRoll: Float32Array;
  spStart: Float32Array;
  spDur: Float32Array;
  spR: Float32Array;
  spG: Float32Array;
  spB: Float32Array;

  /** Choreography outputs, written by Timeline cues and read once per frame. */
  reduced: boolean;
  armed: boolean;
  moving: number;
  reveal: number;
  blob: number;
  toothY: number;
  toothScale: number;
  squash: number;
  tilt: number;
  lean: number;
  done: boolean;
  doneFired: boolean;
  /** Set once every sparkle has finished, so the field stops writing dead matrices. */
  sparklesFlushed: boolean;
};

function createRuntime(n: number, ns: number): Runtime {
  const f = () => new Float32Array(n);
  const g = () => new Float32Array(ns);
  return {
    n,
    live: n,
    px: f(), py: f(), pz: f(),
    vx: f(), vy: f(), vz: f(),
    ex: f(), ey: f(), ez: f(),
    wx: f(), wy: f(), wz: f(),
    sx: f(), sy: f(), sz: f(),
    fade: f(),
    rest: new Uint8Array(n),
    ns,
    nsLive: ns,
    spX: g(), spY: g(), spZ: g(),
    spSize: g(), spRoll: g(),
    spStart: g(), spDur: g(),
    spR: g(), spG: g(), spB: g(),
    reduced: false,
    armed: false,
    moving: 0,
    reveal: 0,
    blob: 0,
    toothY: 0,
    toothScale: 0,
    squash: 0,
    tilt: 0,
    lean: 0,
    done: false,
    doneFired: false,
    sparklesFlushed: false,
  };
}

/* ------------------------------------------------------------------ */
/* Fitting the celebration to whatever camera the game left behind     */
/* ------------------------------------------------------------------ */

/*
 * ## Why this exists
 *
 * `GameShell` used to mount the celebration in a `<View>` of its own, with a camera it
 * solved itself: a 28 degree lens 8.4 units back, aimed at the origin. Round 3's A10 moved
 * the celebration into the **game's** view - one scene, one depth buffer, one shadow pass -
 * and deleted that solve, which was right. What it left behind was a burst still authored in
 * world units for a camera that no longer exists.
 *
 * Measured, over the nine real `cameraFor()` solves at a 1200x800 play area with a 96 px
 * chrome band, with the subject left at the world origin: the podium and the hero fall into
 * the bottom `CELEBRATION_COPY_BAND` in **eight of nine** games and the burst clips the
 * frustum in **seven of nine**. The game cameras run 28-30 degrees at 5.5-12 units over
 * elevations from 10 (Tooth Runner) to 60 (Maze Escape), aimed at nine different points.
 * Nothing authored against one fixed framing survives that.
 *
 * So the celebration fits itself to the camera it finds, once, when it activates - never per
 * frame. Three numbers are solved: where it stands on the ground plane (x, z) and how big it
 * is (one uniform scale). It keeps standing **on the ground**, so the game's own shadow pass
 * catches the podium and the hero; that is the whole reason A10 moved it here.
 *
 * ## What is being fitted
 *
 * Every bound below is derived from the constants above it, not chosen:
 *
 *  - **Horizontal.** `BURST_RADIUS` caps a chip's distance from the axis, and a chip may
 *    stick out by its own half-diagonal on top of that.
 *  - **Top.** The apex of the fastest chip: `LAUNCH_Y` plus its jitter, plus the rise that
 *    a launch speed of `3.6 + 2.2` buys under `GRAVITY` and `DRAG`, plus the same
 *    half-diagonal.
 *  - **Bottom.** The underside of the podium. Deliberately *not* the lowest a chip reaches:
 *    chips fade out on the way down (see `FADE_START_Y`) and pass through the copy band as
 *    they go, which is what confetti does and what the band's scrim in `GameShell` is for.
 *    What must stay above the band is the hero and the thing it stands on.
 *
 * ## How big
 *
 * The hero keeps the screen size it was authored at. At the retired framing the visible
 * height at the hero's depth was `2 * 8.4 * tan(14 deg) = 4.189` units, so a 1.05-unit hero
 * filled 25.1 % of the view. That fraction - not a world size - is what is held constant
 * across nine different lenses, which is what "reads at a comparable size" has to mean once
 * the camera stops being ours. It is reduced, never raised, when the burst would not
 * otherwise fit the region above the band.
 */

/** Half the largest chip's own diagonal: it can stick out past `BURST_RADIUS` by this much. */
const CHIP_MAX_HALF = (() => {
  // `flakeChip(0.13, 0.13, 0.03, ...)`, so half-extents of (0.065, 0.065, 0.015)...
  const half = Math.hypot(0.13 / 2, 0.13 / 2, 0.03 / 2);
  // ...times the largest per-instance scale a chip can be dealt. `stageConfetti` writes
  // `sx = size * sqrt(a)` and `sy = size / sqrt(a)`, so the largest linear factor any chip
  // sees is `CHIP_CLASSES[0].hi * sqrt(aspectMax)`.
  const cls = CHIP_CLASSES[0];
  return half * cls.hi * Math.sqrt(cls.aspectMax);
})();

/** Apex of the fastest chip, in world units above the ground the celebration stands on. */
const BURST_APEX_Y = (() => {
  // `dv/dt = -g - k v` integrates to a rise of `v/k - (g/k^2) ln(1 + k v / g)`.
  const g = -GRAVITY;
  const k = DRAG;
  const v = 3.6 + 2.2;
  const rise = v / k - (g / (k * k)) * Math.log(1 + (k * v) / g);
  // The jitter `stageConfetti` adds to the release height is +/- 0.05.
  return LAUNCH_Y + 0.05 + rise;
})();

const SUBJECT_HALF_XZ = BURST_RADIUS + CHIP_MAX_HALF;
/** The podium is 0.11 tall with its top at y = 0, so its underside is the floor of the box. */
const SUBJECT_Y_MIN = PODIUM_POS[1] - 0.055;
const SUBJECT_Y_MAX = BURST_APEX_Y + CHIP_MAX_HALF;
/** Podium radius: this and `TOOTH_HEIGHT` are the box that must clear the copy band. */
const PODIUM_RADIUS = 0.92;

/**
 * Two boxes, two different rules - and the split is the whole reason this fits at all.
 *
 * **The hero box** is the podium and the mascot standing on it. It must sit inside the
 * region above `CELEBRATION_COPY_BAND`, because that is the thing the headline would cover.
 *
 * **The burst box** is the same plus every chip out to `BURST_RADIUS` and up to
 * `BURST_APEX_Y`. It must stay inside the *frustum* - a chip cut in half by the View rect is
 * the failure round 3 photographed - but it is explicitly allowed to cross into the copy
 * band on the way down, because that is where chips fade out (`FADE_START_Y`) and the band
 * carries a scrim in `GameShell` for exactly this.
 *
 * Constraining the burst to the region above the band instead of to the frustum was measured
 * first, and it costs too much: it drives Maze Escape's hero down to 8.8 % of the view
 * height - a 70 px mascot on an 800 px screen - because a 3.56-unit-wide box seen from a
 * 60 degree elevation projects three and a half times taller than the 1.05-unit hero inside
 * it. Under the split below the same camera keeps the hero at its authored fraction.
 */
function boxCorners(halfXZ: number, yLo: number, yHi: number): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (const x of [-halfXZ, halfXZ]) {
    for (const z of [-halfXZ, halfXZ]) {
      for (const y of [yLo, yHi]) out.push([x, y, z]);
    }
  }
  return out;
}

const HERO_BOX = boxCorners(PODIUM_RADIUS, SUBJECT_Y_MIN, TOOTH_HEIGHT);
const BURST_BOX = boxCorners(SUBJECT_HALF_XZ, SUBJECT_Y_MIN, SUBJECT_Y_MAX);

/** The screen fraction the hero was authored at. See the header. */
const HERO_VIEW_FRACTION = TOOTH_HEIGHT / (2 * 8.4 * Math.tan((28 * Math.PI) / 360));
/** ...in NDC, where the whole view is 2 units tall. */
const HERO_NDC_HEIGHT = HERO_VIEW_FRACTION * 2;

/** Keep this much of the view clear at every edge, in NDC. 0.04 is 2 % of the view. */
const FIT_MARGIN = 0.04;
/** NDC y of the top of the copy band: a fraction f of the view height is at `2f - 1`. */
const BAND_TOP_NDC = 2 * CELEBRATION_COPY_BAND - 1;
/** The line the hero stands on, and everything above is measured from. */
const REGION_Y_LO = BAND_TOP_NDC + FIT_MARGIN;
const REGION_Y_HI = 1 - FIT_MARGIN;
const REGION_X_HALF = 1 - FIT_MARGIN;
/** How far above the anchor line the burst may reach: the top of the frustum, not the region. */
const BURST_Y_HI = 1 - FIT_MARGIN;

/**
 * Damping and iteration count. The solve is a fixed point - moving the aim changes the
 * projected boxes, which changes the aim - and damping it converges monotonically instead of
 * ringing. 40 passes is well past the measured convergence (every game camera in the product
 * settles to 1e-3 within twelve); it runs once per celebration, so the margin costs nothing.
 */
const FIT_ITERATIONS = 40;
const FIT_DAMPING = 0.6;
/**
 * A scale outside this band means the camera handed in is not one this product ships, and a
 * silently enormous or invisible celebration is worse than an unfitted one.
 */
const FIT_SCALE_MIN = 0.3;
const FIT_SCALE_MAX = 3;
/**
 * Below this the camera is level enough that a horizontal plane is edge-on and the ground
 * solve has no answer at all. `sin(1 degree)`.
 */
const FIT_MIN_DOWNWARD = Math.sin((1 * Math.PI) / 180);


/** Where the celebration should stand, and how big. `y` is the ground it stands on. */
export type CelebrationFit = {
  x: number;
  y: number;
  z: number;
  scale: number;
  /** `false` when the camera could not be solved against, and the authored placement stands. */
  fitted: boolean;
  /** `true` when there was no ground plane to stand on and it was placed in front instead. */
  free: boolean;
};

/** The ground plane and shadow frustum a game's `<Rig>` installed. See `readGround`. */
export type CelebrationGround = { y: number; half: number; exists: boolean };

const fitCam = new Vector3();
const fitRay = new Vector3();
const fitAim = new Vector3();
const fitProbe = new Vector3();
const fitFwd = new Vector3();
const fitRight = new Vector3();
const fitUp = new Vector3();

/**
 * NDC of a world point, or `false` when the point is behind the near plane.
 *
 * Written out rather than using `Vector3.project` so the depth test happens *before* the
 * perspective divide: a point behind the camera divides by a negative w and lands back
 * inside the frame with both signs flipped, which would let the solve converge on a
 * placement nobody can see.
 */
function ndcOf(camera: Camera, x: number, y: number, z: number, out: Vector3): boolean {
  out.set(x, y, z).applyMatrix4(camera.matrixWorldInverse);
  if (out.z > -1e-3) return false;
  out.applyMatrix4(camera.projectionMatrix);
  return true;
}

/** Projected bounds of one box placed at (px, baseY, pz) and scaled. Returns `false` if clipped. */
type Bounds = { minX: number; maxX: number; minY: number; maxY: number };
const heroBounds: Bounds = { minX: 0, maxX: 0, minY: 0, maxY: 0 };
const burstBounds: Bounds = { minX: 0, maxX: 0, minY: 0, maxY: 0 };

function projectBox(
  camera: Camera,
  box: readonly (readonly [number, number, number])[],
  px: number,
  baseY: number,
  pz: number,
  scale: number,
  out: Bounds
): boolean {
  out.minX = Infinity;
  out.maxX = -Infinity;
  out.minY = Infinity;
  out.maxY = -Infinity;
  for (let i = 0; i < box.length; i++) {
    const c = box[i];
    if (!ndcOf(camera, px + scale * c[0], baseY + scale * c[1], pz + scale * c[2], fitProbe)) {
      return false;
    }
    if (fitProbe.x < out.minX) out.minX = fitProbe.x;
    if (fitProbe.x > out.maxX) out.maxX = fitProbe.x;
    if (fitProbe.y < out.minY) out.minY = fitProbe.y;
    if (fitProbe.y > out.maxY) out.maxY = fitProbe.y;
  }
  return true;
}

/**
 * The fallback for a camera with no ground under it.
 *
 * Spot the Difference looks straight ahead at two framed pictures and draws no floor, so
 * there is no horizontal plane to stand the celebration on: the ground solve's ray never
 * meets one. It is placed in front of the camera instead, upright, at the distance that
 * makes the hero exactly its authored screen fraction - which for a 28 degree lens is the
 * 8.4 units the celebration was originally authored at, by construction, since that is where
 * `HERO_VIEW_FRACTION` came from.
 */
function solveFree(camera: Camera, out: CelebrationFit): void {
  fitCam.setFromMatrixPosition(camera.matrixWorld);
  fitFwd.set(0, 0, -1).applyQuaternion(camera.quaternion).normalize();
  fitRight.set(1, 0, 0).applyQuaternion(camera.quaternion).normalize();
  // The screen's own up, not the world's: an NDC offset has to move along the frame.
  fitUp.set(0, 1, 0).applyQuaternion(camera.quaternion).normalize();

  // `projectionMatrix.elements[5] = 1 / tan(fov / 2)` for any perspective camera, which is
  // the only lens parameter this needs and avoids narrowing the type to PerspectiveCamera.
  const invTanHalf = camera.projectionMatrix.elements[5];
  if (!(invTanHalf > 0)) return;
  const distance = (TOOTH_HEIGHT * invTanHalf) / (2 * HERO_VIEW_FRACTION);

  let scale = 1;
  let aimX = 0;
  let aimY = REGION_Y_LO;
  for (let pass = 0; pass < FIT_ITERATIONS; pass++) {
    // Half-extents of the frame at `distance`, so an NDC aim becomes a world offset.
    const halfH = distance / invTanHalf;
    // `e[5] / e[0]` is the aspect ratio: e[0] = 1 / (aspect * tan(fov/2)), e[5] = 1 / tan(fov/2).
    const halfW = halfH * (invTanHalf / camera.projectionMatrix.elements[0]);
    const px = fitCam.x + fitFwd.x * distance + fitRight.x * aimX * halfW + fitUp.x * aimY * halfH;
    const py = fitCam.y + fitFwd.y * distance + fitRight.y * aimX * halfW + fitUp.y * aimY * halfH;
    const pz = fitCam.z + fitFwd.z * distance + fitRight.z * aimX * halfW + fitUp.z * aimY * halfH;

    if (!projectBox(camera, HERO_BOX, px, py, pz, scale, heroBounds)) return;
    if (!projectBox(camera, BURST_BOX, px, py, pz, scale, burstBounds)) return;

    aimX += FIT_DAMPING * (0 - (heroBounds.minX + heroBounds.maxX) / 2);
    aimY += FIT_DAMPING * (REGION_Y_LO - heroBounds.minY);

    const want = Math.min(
      (REGION_Y_HI - REGION_Y_LO) / Math.max(1e-6, heroBounds.maxY - REGION_Y_LO),
      (BURST_Y_HI - REGION_Y_LO) / Math.max(1e-6, burstBounds.maxY - REGION_Y_LO),
      REGION_X_HALF / Math.max(1e-6, Math.max(-burstBounds.minX, burstBounds.maxX))
    );
    if (want < 1) scale *= 1 + FIT_DAMPING * (want - 1);
    if (scale < FIT_SCALE_MIN) scale = FIT_SCALE_MIN;
    else if (scale > FIT_SCALE_MAX) scale = FIT_SCALE_MAX;

    out.x = px;
    out.y = py;
    out.z = pz;
    out.scale = scale;
    out.fitted = true;
    out.free = true;
  }
}

/**
 * Solves `x`, `z` and `scale` against a camera.
 *
 * Allocation-free after module load, and exported so a harness can run it against every
 * game's real `cameraFor()` solve without a browser - which is how the numbers in the header
 * were measured, and how they can be re-measured after any camera change.
 */
export function solveCelebrationFit(
  camera: Camera,
  ground: CelebrationGround,
  out: CelebrationFit
): void {
  out.x = 0;
  out.y = ground.y;
  out.z = 0;
  out.scale = 1;
  out.fitted = false;
  out.free = false;

  camera.updateMatrixWorld();
  fitCam.setFromMatrixPosition(camera.matrixWorld);

  /*
   * No floor to stand on: place it in front of the camera instead. Two cases reach this -
   * a game that draws no ground (`ground.exists`, read from the `<Rig>` mesh's name) and a
   * camera level enough that a horizontal plane is edge-on. Spot the Difference is the
   * first; nothing in the product is the second, and it is guarded rather than assumed.
   */
  fitRay
    .set(0, (REGION_Y_LO + REGION_Y_HI) / 2, 0.5)
    .unproject(camera)
    .sub(fitCam)
    .normalize();
  if (!ground.exists || fitRay.y > -FIT_MIN_DOWNWARD) {
    solveFree(camera, out);
    return;
  }

  let scale = 1;
  let aimX = 0;
  let aimY = REGION_Y_LO;

  for (let pass = 0; pass < FIT_ITERATIONS; pass++) {
    /* Aim: the ground point whose hero-box centre lands on (aimX, aimY) in the frame. */
    const planeY = ground.y + scale * ((SUBJECT_Y_MIN + TOOTH_HEIGHT) / 2);
    fitRay.set(aimX, aimY, 0.5).unproject(camera).sub(fitCam);
    if (fitRay.y > -FIT_MIN_DOWNWARD) return;
    const t = (planeY - fitCam.y) / fitRay.y;
    if (!(t > 0)) return;
    fitAim.copy(fitRay).multiplyScalar(t).add(fitCam);

    /*
     * Stay inside the game's shadow frustum. `Rig` centres it on the origin and sizes it
     * `shadowArea / 2` across, so a celebration solved further out than that would stand in
     * the one place where the game's shadow pass - the entire point of A10 - does not reach
     * it. The bound used is the inscribed circle, which is conservative whatever angle the
     * key light's box sits at relative to world XZ. Clamping the aim rather than the answer
     * keeps the rest of the pass consistent with where it will actually end up.
     */
    const reach = Math.max(0, ground.half - scale * PODIUM_RADIUS);
    const r = Math.hypot(fitAim.x, fitAim.z);
    const k = r > reach && r > 1e-6 ? reach / r : 1;
    const px = fitAim.x * k;
    const pz = fitAim.z * k;
    const clamped = k < 1;

    if (!projectBox(camera, HERO_BOX, px, ground.y, pz, scale, heroBounds)) return;
    if (!projectBox(camera, BURST_BOX, px, ground.y, pz, scale, burstBounds)) return;

    /* Bottom-align the hero box to the anchor line; centre it horizontally. */
    aimX += FIT_DAMPING * (0 - (heroBounds.minX + heroBounds.maxX) / 2);
    aimY += FIT_DAMPING * (REGION_Y_LO - heroBounds.minY);

    /*
     * Size. Everything is measured as a height above the anchor line, so the scale term and
     * the position term do not fight: the hero box must fit the region, the burst box must
     * fit the frustum, and the burst must not run out of the sides. All three are `min`ned
     * with the authored hero fraction and applied downward only - a burst that leaves the
     * frame is the failure round 3 photographed and a hero a little under its authored size
     * is not.
     */
    const heroBaseNdc = heroBounds.minY;
    if (!ndcOf(camera, px, ground.y, pz, fitProbe)) return;
    const groundNdc = fitProbe.y;
    if (!ndcOf(camera, px, ground.y + scale * TOOTH_HEIGHT, pz, fitProbe)) return;
    const heroH = Math.abs(fitProbe.y - groundNdc);
    if (!(heroH > 1e-6)) return;

    let want = Math.min(
      HERO_NDC_HEIGHT / heroH,
      (REGION_Y_HI - REGION_Y_LO) / Math.max(1e-6, heroBounds.maxY - REGION_Y_LO),
      (BURST_Y_HI - REGION_Y_LO) / Math.max(1e-6, burstBounds.maxY - REGION_Y_LO),
      REGION_X_HALF / Math.max(1e-6, Math.max(-burstBounds.minX, burstBounds.maxX))
    );
    /*
     * If the shadow frustum stopped the aim from moving far enough back, the hero box is
     * still hanging below the anchor line and no amount of further aiming will lift it. It
     * is shrunk out of the band instead: at a fixed ground point a smaller subject projects
     * its near-bottom corner higher, so this converges on `minY == REGION_Y_LO`.
     */
    if (clamped && heroBaseNdc < REGION_Y_LO) {
      const under = REGION_Y_LO - heroBaseNdc;
      want = Math.min(want, 1 - under / (REGION_Y_HI - REGION_Y_LO));
    }
    scale *= 1 + FIT_DAMPING * (want - 1);
    if (scale < FIT_SCALE_MIN) scale = FIT_SCALE_MIN;
    else if (scale > FIT_SCALE_MAX) scale = FIT_SCALE_MAX;

    out.x = px;
    out.y = ground.y;
    out.z = pz;
    out.scale = scale;
    out.fitted = true;
  }
}

/**
 * The ground plane and the shadow frustum the game's `<Rig>` installed, read back off the
 * scene it installed them into.
 *
 * `Rig` is the only thing in the product that adds a `DirectionalLight`; it writes
 * `light.target.position.set(0, groundY, 0)` and sizes `light.shadow.camera` to
 * `shadowArea / 2` about that point. Reading those two back is how the celebration learns
 * where the floor is and how far from the origin it may stand before the game's shadow pass
 * stops covering it - without a prop that `GameShell`, which does not know which game it is
 * wrapping, would have nothing to fill in.
 *
 * Seven of the nine games ground at y = 0; Tooth Runner grounds at -0.26 and Spot the
 * Difference at -2.10, and both of those would have had the celebration standing two metres
 * of world above their floors if this were hard-coded.
 *
 * Falls back to y = 0 and an unbounded frustum when there is no such light (the dev probe).
 */
export function readGround(scene: Object3D, out: CelebrationGround): void {
  out.y = 0;
  out.half = Infinity;
  out.exists = scene.getObjectByName(RIG_GROUND_NAME) !== undefined;
  const found: { light: DirectionalLight | null } = { light: null };
  scene.traverse((o) => {
    if (found.light === null && (o as Partial<DirectionalLight>).isDirectionalLight === true) {
      found.light = o as DirectionalLight;
    }
  });
  const light = found.light;
  if (light === null) return;
  out.y = light.target.position.y;
  const cam = light.shadow.camera;
  out.half = Math.min(Math.abs(cam.right), Math.abs(cam.top));
}

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

export function Celebration({
  active,
  accent,
  onDone,
}: {
  active: boolean;
  accent: AccentFamily;
  onDone?: () => void;
}): JSX.Element {
  const rootRef = useRef<Group>(null);
  const blobRef = useRef<Group>(null);
  const toothRef = useRef<Group>(null);
  const confettiRef = useRef<InstancedMesh>(null);
  const sparkleGroupRef = useRef<Group>(null);
  const sparkleRef = useRef<InstancedMesh>(null);

  /**
   * The camera nudge, without taking the camera away from anybody.
   *
   * `Scene3D` already owns this view's camera with its own `CameraRig` (breathing, spring
   * focus) and rewrites `position` + `lookAt` from scratch every frame at priority 0. A
   * second rig pointed at the same camera would win by subscription order and silently
   * kill the breathe. So this rig drives a detached proxy whose base is the origin: with
   * breathing off, `proxy.position` after `update()` *is* the pure shake vector, which we
   * add to the real camera's position after `Scene3D` has written it.
   *
   * Translating the camera without touching its quaternion moves the aim point by the same
   * vector — angular velocity is exactly zero, which is precisely the no-queasy shake
   * `CameraRig` implements internally. And if this ever ran *before* Scene3D's rig, the
   * offset would simply be overwritten: the nudge disappears, nothing drifts.
   */
  const shake = useMemo(() => {
    const proxy = new PerspectiveCamera();
    const rig = new CameraRig(proxy, { breathe: false, maxShake: 0.055 });
    rig.setBase(0, 0, 0, 0, 0, -1, true);
    return { proxy, rig };
  }, []);

  /** onDone is a discrete callback; keeping it in a ref keeps useFrame's closure stable. */
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  const accentRef = useRef(accent);
  accentRef.current = accent;
  const activeRef = useRef(active);
  activeRef.current = active;

  /**
   * Counts are fixed for the component's life. The tier can only degrade at runtime and a
   * shrinking instance buffer is not worth a reallocation mid-celebration — `mesh.count`
   * gates what actually draws.
   */
  const counts = useMemo(() => {
    const q = getQuality();
    const n = q.maxInstances;
    // `maxInstances` is already tiered (90 / 160 / 260), so the low tier never builds the
    // full field — the burst's cost was never the instance count, it was 644 triangles per
    // chip times a shadow submit. See `confetti` below.
    return { n, ns: Math.max(10, Math.min(28, Math.round(n / 8))), detail: q.detail };
  }, []);

  const rt = useMemo(() => createRuntime(counts.n, counts.ns), [counts]);
  const bag = useMemo(() => new DisposalBag(), []);

  /* ---------------- geometry + materials ---------------- */

  /**
   * One chip geometry for the whole burst, and its per-instance albedo buffer.
   *
   * Two round-2 blockers meet on these fifteen lines.
   *
   * **Triangles.** This used to be `roundedPlate(0.12, 0.12, 0.03, 0.045, 1)`, which is a
   * bevelled `ExtrudeGeometry` and **644 triangles** — for a flake that covers about twelve
   * screen pixels. With `castShadow` on, each chip was submitted twice: `260 × 644 × 2` is
   * 334,880 of the 338,178 triangles the celebration added, against a whole-scene budget of
   * 180,000. `bevelChip` is 48 triangles and keeps a real rolled rim, and the shadow submit
   * is gone (see the mesh below), so the same burst is ~12.5k. The bevel was not the cost;
   * paying `ExtrudeGeometry` prices for it was.
   *
   * **Colour.** The chips used to carry their accent on `InstancedMesh.instanceColor`, which
   * three multiplies into the same `vColor` the clay shader reads as a *signed curvature map*
   * and extrapolates by 1.45x. Every token was driven down: `#efa160` rendered `(227,74,9)`,
   * and the histogrammed chip colours across three games came back `#930F08`, `#DC1209`,
   * `#4C0B04` — dried blood, in a paediatric dental product, as the reward for finishing.
   * The tint now travels on `ALBEDO_ATTRIBUTE`, a straight multiply, so a chip renders its
   * token and the geometry's baked curvature still darkens the rim.
   *
   * **Silhouette.** A rounded octagon stretched by a per-instance aspect of up to 3:1 is a
   * sliver, and round 3 read the burst as "a dense spray of small elongated capsule-shaped
   * chips" — spatter. `flakeChip` gives it five smooth lobes (no in-plane points: §3 has no
   * hard-corner exemption for small props), `CHIP_CLASSES` in `resetRuntime` caps the aspect
   * at 1.45 and deals three deliberate size classes, and `CONFETTI_DENSITY` trades count for
   * size so the flakes are individually legible instead of atomised. 96 triangles at 16 ring
   * segments against `bevelChip`'s 48, and 40 % fewer chips — the arithmetic is under
   * `CONFETTI_DENSITY`.
   *
   * The geometry is built locally rather than through `cachedGeometry` precisely because it
   * carries that per-instance attribute: an instance buffer on a shared cached geometry would
   * follow it into every other game that asked for the same key.
   */
  const confetti = useMemo(() => {
    const geo = flakeChip(0.13, 0.13, 0.03, 0.012, 5, 0.18, 16).clone();
    const albedo = instanceAlbedoAttribute(counts.n);
    geo.setAttribute(ALBEDO_ATTRIBUTE, albedo);
    return { geo, albedo };
  }, [counts.n]);

  /**
   * The mascot, not a specimen.
   *
   * The hero was a bare `toothGeometry("baby")` — a crown and two splayed roots, no eyes, no
   * mouth, no body — hanging in mid-air as the reward for finishing a game, in a product
   * whose entire purpose is to make a dental surgery unfrightening. Anatomically that is an
   * extracted tooth. `mascotParts` gives it the product's own face (the one Healthy or Not?
   * already ships) plus arms and feet, so the same silhouette reads as somebody standing up
   * and grinning. `open: 0.82` is a wide happy grin with the tongue showing.
   */
  const hero = useMemo(
    () => mascotParts({ height: TOOTH_HEIGHT, detail: counts.detail, open: 0.82 }),
    [counts.detail]
  );

  /**
   * A little clay podium, and the reason it exists.
   *
   * `GameShell` mounts this view with `ground={false}` so the room behind stays visible, which
   * left the hero and its contact shadow floating over nothing at all. A full ground plane is
   * not the fix — it would draw a second horizon across the game's own. A 0.9-unit disc is: it
   * is a prop, it reads as a plinth, it catches the hero's cast shadow, and it has no horizon
   * to contradict anything.
   */
  const podiumGeo = useMemo(() => roundedCylinder(0.92, 0.11, 0.05, counts.detail), [counts.detail]);
  const podiumMat = useMemo(
    () =>
      clay("celebrate/podium", {
        color: CLAY.ivoryDeep,
        roughness: 0.78,
        sheen: 0.24,
        grain: 0.13,
      }),
    []
  );

  const confettiMat = useMemo(
    () =>
      // White base, deliberately: the per-instance albedo *is* the token, and multiplying it
      // by an off-white body colour would put a systematic bias between the rendered chip and
      // the `ACCENTS` entry it is supposed to be.
      clay("celebrate/confetti", {
        color: "#ffffff",
        roughness: 0.66,
        sheen: 0.5,
        grain: 0.12,
        sss: CLAY.sss,
        // A confetti flake is a 3 mm wafer of clay, and at that thickness it is genuinely
        // translucent — which is also the only lever this shading model has on the problem
        // round 3 photographed. The chips tumble on three axes, so about half of them face
        // away from the key at any instant, and the clay shader's two soft-lighting terms
        // both fail exactly there: the wrap cannot reach the antipode (it would need `w > 1`),
        // and the back-scatter lobe is driven by `dot(V, -L)`, which is *negative* under this
        // product's front-upper-left key and so never fires at all. A back-facing chip was
        // therefore lit by the environment alone, and the environment is deliberately a dim
        // fill — which is where the measured "darkest L* 23" came from. It was never the
        // palette: the darkest token in the brand is `red.deep` at L* 42.
        //
        // So the flake is given the response of a thin translucent wafer rather than of a
        // solid: the widest wrap in the product bar the floor, a strong scatter, half again
        // the environment, and a small warm emissive floor that is orientation-independent by
        // construction. **Round 4 must re-histogram the burst and state the rendered floor** —
        // this is the one change in this file whose result cannot be computed from the source.
        sssStrength: 0.62,
        wrap: 0.38,
        envMapIntensity: 1.5,
        emissive: CLAY.sss,
        // 0.15 x `CLAY.sss` is (0.103, 0.046, 0.032) in linear, i.e. +0.058 of luminance
        // added to every chip whatever it faces. Applied to the measured back-face floor
        // (L* 23, Y 0.0397) that lands at Y 0.098, **L\* 38** — a warm shadow-side, not a
        // silhouette. It also lifts the lit side by about a seventh, which on a flake is
        // the direction to err in.
        emissiveIntensity: 0.15,
      }),
    []
  );

  /** Sparkle sprite. Owned locally and disposed on unmount. */
  const sparkleGeo = useMemo(() => {
    const g = new PlaneGeometry(1, 1);
    // three only multiplies vColor into the fragment when USE_COLOR is on, and USE_COLOR
    // declares `attribute vec3 color`. Without a real attribute the driver feeds (0,0,0)
    // and every sparkle renders black — so the plane carries an explicit white one.
    const white = new Float32Array(g.attributes.position.count * 3).fill(1);
    g.setAttribute("color", new BufferAttribute(white, 3));
    return g;
  }, []);

  const sparkleMat = useMemo(
    () =>
      // Deliberately unlit: a sparkle is a light artefact, not a clay surface.
      //
      // `sparkleTexture` writes its RGB already scaled by alpha, so `premultipliedAlpha`
      // is not optional here — without it three's additive path multiplies by alpha a
      // second time and the warm falloff collapses into a hard dot. Premultiplied +
      // additive is ONE/ONE: the wide, low-alpha tail adds almost nothing (a warm haze)
      // and only the tiny hot core adds at full strength, which is what a glint does.
      //
      // The base tint is neutral-warm rather than an accent: the per-instance colour is
      // already an accent, and multiplying two peaches together crushes green and blue and
      // leaves dull orange dots.
      new MeshBasicMaterial({
        map: sparkleTexture(),
        color: CLAY.wear,
        transparent: true,
        blending: AdditiveBlending,
        premultipliedAlpha: true,
        depthWrite: false,
        vertexColors: true,
      }),
    []
  );

  useEffect(() => {
    bag.add(sparkleGeo);
    bag.add(sparkleMat);
    // The chip geometry is a local clone carrying this celebration's instance buffer, so it
    // is this component's to free — unlike everything else here, which is shared and cached.
    bag.add(confetti.geo);
    return () => bag.release();
  }, [bag, sparkleGeo, sparkleMat, confetti]);

  /* ---------------- timelines ---------------- */

  const timelines = useMemo(() => {
    const full = new Timeline();

    // Beat of stillness, then a shadow arrives — wide and soft, the way a distant object
    // casts. Announcing the prop with its shadow before the prop itself is what buys the
    // pop its weight. The hero shows up as a speck and drifts *up* over the same beat:
    // that opposite-direction pull is the wind-up, and it stays clear of the ground plane
    // (a group-level dip would push the contact blob under the Rig's floor and hide it).
    full.add(0.1, 0.14, (p) => {
      const e = easeOutCubic(p);
      rt.blob = 1.28 * e;
      rt.toothScale = 0.05 * e;
      rt.toothY = 0.55 + 0.14 * e;
    });

    // The pop. Scale runs on easeOutBack while the drop runs on easeOutCubic, so the tooth
    // overshoots its size a fraction before it finishes arriving — that offset is the
    // difference between "pops" and "grows".
    full.add(0.24, 0.36, (p) => {
      rt.toothScale = 0.05 + 0.95 * easeOutBack(p, 1.9);
      const d = easeOutCubic(p);
      rt.toothY = 0.69 * (1 - d);
      rt.blob = 1.28 + (0.86 - 1.28) * d;
      rt.lean = 0.16 * (1 - d);
    });

    // Impact.
    full.add(T_BURST, 0, () => {
      rt.toothScale = 1;
      rt.toothY = 0;
      rt.lean = 0;
      rt.armed = true;
      const mesh = confettiRef.current;
      if (mesh) mesh.count = rt.live;
      // Low enough that it reads as the table taking a knock, not as a camera move.
      if (!rt.reduced) shake.rig.shake(0.55);
    });

    // Squash & stretch: instantaneous compression on contact, elastic recovery out of it.
    full.add(T_BURST, 0.4, (p) => {
      rt.squash = -0.26 * (1 - easeOutElastic(p, 1, 0.34));
    });

    // The shadow spreads back out as the tooth rebounds, then settles.
    full.add(T_BURST, 0.34, (p) => {
      rt.blob = 0.86 + 0.16 * Math.sin(easeOutCubic(p) * Math.PI);
    });

    full.add(T_DONE, 0, () => {
      rt.done = true;
    });

    // Reduced motion: no burst, no tumble, no camera. A single short reveal, then stillness.
    // It has to land as a reward, so the tooth still gets a small scale pop — just one that
    // never overshoots and never travels.
    const reduced = new Timeline();
    reduced.add(0, T_REDUCED_REVEAL, (p) => {
      const e = easeOutCubic(p);
      rt.reveal = e;
      rt.blob = e;
      rt.toothScale = 0.78 + 0.22 * e;
    });
    reduced.add(T_REDUCED_DONE, 0, () => {
      rt.done = true;
    });

    return { full, reduced };
  }, [rt, shake]);

  const tlRef = useRef<Timeline>(timelines.full);

  /* ---------------- fit to the game's camera ---------------- */

  /*
   * Once, on activation, and again if the view is resized while the celebration is up -
   * never per frame. `size` is in the dependency list because a game re-solves its camera
   * from a `ResizeObserver`, so a rotation or a window drag changes the frustum underneath
   * a celebration that is already on screen.
   *
   * The camera this reads is the game's, already written for this frame by `Scene3D`'s
   * `CameraRig` at priority 0. The rig's breathe keeps moving it by fractions of a unit
   * afterwards, which is why the fit is a placement and not a per-frame track: re-solving
   * every frame would put the whole celebration on the breathe.
   */
  const camera = useThree((s) => s.camera);
  const scene = useThree((s) => s.scene);
  const size = useThree((s) => s.size);
  const groundRef = useRef<CelebrationGround>({ y: 0, half: Infinity, exists: false });
  const fitRef = useRef<CelebrationFit>({
    x: 0,
    y: 0,
    z: 0,
    scale: 1,
    fitted: false,
    free: false,
  });

  useEffect(() => {
    const root = rootRef.current;
    if (!root || !active) return;
    readGround(scene, groundRef.current);
    solveCelebrationFit(camera, groundRef.current, fitRef.current);
    const fit = fitRef.current;
    root.position.set(fit.x, fit.y, fit.z);
    root.scale.setScalar(fit.scale);
  }, [active, camera, scene, size]);

  /* ---------------- activation ---------------- */

  useEffect(() => {
    const root = rootRef.current;
    if (root) root.visible = active;

    if (!active) {
      tlRef.current.stop();
      const c = confettiRef.current;
      if (c) c.count = 0;
      const s = sparkleRef.current;
      if (s) s.count = 0;
      return;
    }

    const reduced = isReduced();
    resetRuntime(rt, accentRef.current, reduced);

    const confettiMesh = confettiRef.current;
    if (confettiMesh) {
      writeConfettiColours(confetti.albedo, rt, accentRef.current);
      confettiMesh.instanceMatrix.setUsage(DynamicDrawUsage);
      // In reduced motion the arrangement is already in place and simply reveals; in the
      // full path nothing draws until the burst arms it.
      confettiMesh.count = reduced ? rt.live : 0;
    }
    const sparkles = sparkleRef.current;
    if (sparkles) {
      prepareSparkles(sparkles, rt);
      sparkles.count = rt.nsLive;
    }

    tlRef.current = reduced ? timelines.reduced : timelines.full;
    tlRef.current.start();
  }, [active, accent, rt, timelines, confetti]);

  useEffect(() => () => shake.rig.dispose(), [shake]);

  /* ---------------- per-frame ---------------- */

  useFrame((st, rawDt) => {
    const root = rootRef.current;
    if (!root) return;
    if (!activeRef.current) {
      if (root.visible) root.visible = false;
      return;
    }
    root.visible = true;

    const dt = safeDelta(rawDt);
    const tl = tlRef.current;
    tl.step(dt);
    const t = tl.elapsed;

    const blob = blobRef.current;
    if (blob) blob.scale.setScalar(Math.max(0.0001, rt.blob));

    /* Hero tooth ---------------------------------------------------- */
    const tooth = toothRef.current;
    if (tooth) {
      // The idle breath ramps in only once the landing has finished resolving, so the
      // settle and the breath never fight for the same frames.
      const idle = rt.reduced ? 0 : clamp01((t - 1.2) / 0.5);
      const bob = idle * 0.014 * Math.sin(st.clock.elapsedTime * 2.0);
      tooth.position.y = rt.toothY + bob;
      squashFor(scratchScale, rt.squash, rt.toothScale);
      tooth.scale.set(scratchScale.x, scratchScale.y, scratchScale.z);
      tooth.rotation.y = rt.tilt + idle * 0.022 * Math.sin(st.clock.elapsedTime * 1.3);
      tooth.rotation.x = rt.lean * 0.35;
    }

    /* Confetti ------------------------------------------------------ */
    const confettiMesh = confettiRef.current;
    if (confettiMesh) {
      if (rt.reduced) {
        if (tl.running || rt.reveal < 1) updateConfettiStatic(confettiMesh, rt);
      } else if (rt.armed) {
        updateConfettiBurst(confettiMesh, rt, dt);
      }
    }

    /* Sparkles ------------------------------------------------------ */
    const sparkleGroup = sparkleGroupRef.current;
    const sparkles = sparkleRef.current;
    if (sparkleGroup && sparkles) {
      // One billboard for the whole field: rotate the parent to face the camera and every
      // instance matrix collapses to translate + scale + roll.
      st.camera.getWorldQuaternion(quat);
      const parent = sparkleGroup.parent;
      if (parent) {
        parent.getWorldQuaternion(quatParent).invert();
        quat.premultiply(quatParent);
      }
      sparkleGroup.quaternion.copy(quat);
      if (rt.reduced) {
        if (tl.running || rt.reveal < 1) updateSparklesStatic(sparkles, rt);
      } else {
        updateSparkles(sparkles, rt, t);
      }
    }

    if (!rt.reduced) {
      shake.rig.update(dt, st.clock.elapsedTime);
      const cam = st.camera;
      cam.position.x += shake.proxy.position.x;
      cam.position.y += shake.proxy.position.y;
      cam.position.z += shake.proxy.position.z;
    }

    if (rt.done && !rt.doneFired) {
      rt.doneFired = true;
      onDoneRef.current?.();
    }
  });

  return (
    <group ref={rootRef}>
      {/* Something to stand on. See `podiumGeo` for why this is a disc and not a floor. */}
      <mesh
        geometry={podiumGeo}
        material={podiumMat}
        position={PODIUM_POS}
        receiveShadow
        castShadow={false}
      />

      <group ref={blobRef}>
        <ContactBlob radius={0.62} opacity={0.42} position={[0, 0.004, 0]} />
      </group>

      <group ref={toothRef}>
        {hero.map((p) => (
          <mesh
            key={p.key}
            geometry={p.geometry}
            material={p.material}
            position={p.position}
            rotation={p.rotation}
            scale={p.scale}
            castShadow={p.castShadow}
          />
        ))}
      </group>

      {/*
        `castShadow` is off, unconditionally and on every tier. 260 chips at twelve screen
        pixels contribute nothing a 1024 shadow map can resolve, and they were costing a
        second full submit of the whole burst — half of the celebration's entire triangle
        breach. `frustumCulled` stays off because the instance matrices move without the
        bounding sphere being recomputed.
      */}
      <instancedMesh
        ref={confettiRef}
        args={[confetti.geo, confettiMat, counts.n]}
        frustumCulled={false}
        castShadow={false}
      />

      <group ref={sparkleGroupRef} position={[0, 0.58, 0]}>
        <instancedMesh
          ref={sparkleRef}
          args={[sparkleGeo, sparkleMat, counts.ns]}
          frustumCulled={false}
        />
      </group>
    </group>
  );
}

/* ------------------------------------------------------------------ */
/* Setup (runs on activation only — never per frame)                   */
/* ------------------------------------------------------------------ */

function resetRuntime(rt: Runtime, family: AccentFamily, reduced: boolean): void {
  const rng = mulberry32((Date.now() ^ (FAMILIES.indexOf(family) * 0x9e3779b9)) >>> 0);

  rt.reduced = reduced;
  rt.live = reduced ? Math.min(18, rt.n) : Math.round(rt.n * CONFETTI_DENSITY);
  rt.nsLive = reduced ? Math.min(7, rt.ns) : rt.ns;
  rt.sparklesFlushed = false;
  rt.armed = false;
  rt.moving = 0;
  rt.reveal = reduced ? 0 : 1;
  rt.blob = 0;
  rt.toothY = reduced ? 0 : 0.55;
  rt.toothScale = 0;
  rt.squash = 0;
  rt.lean = 0;
  rt.done = false;
  rt.doneFired = false;
  // A hand-placed prop is never square to camera.
  rt.tilt = -0.26 + rng() * 0.52;

  for (let i = 0; i < rt.live; i++) {
    // Dealt from `CHIP_CLASSES` on the index, not sampled: the same reason the palette is
    // dealt. A composed burst has a known number of big flakes in it every time.
    const c = CHIP_CLASSES[i % CHIP_CLASSES.length];
    const size = c.lo + rng() * (c.hi - c.lo);
    // `ratio` is exactly `sx / sy`, log-uniform over `[1/aspectMax, aspectMax]` so the two
    // orientations are equally likely, and the two axes take its square root in opposite
    // directions so a chip's *area* is `size^2` whatever its aspect. That is what keeps the
    // size classes meaning what they say.
    const ratio = Math.pow(c.aspectMax, (rng() - 0.5) * 2);
    const half = Math.sqrt(ratio);
    rt.sx[i] = size * half;
    rt.sy[i] = size / half;
    rt.sz[i] = size * (0.85 + rng() * 0.3);
  }

  if (reduced) layoutConfettiStatic(rt, rng);
  else stageConfetti(rt, rng);

  layoutSparkles(rt, rng, reduced);
}

/** Parks every chip inside the tooth's crown, ready for the burst cue to release it. */
function stageConfetti(rt: Runtime, rng: () => number): void {
  for (let i = 0; i < rt.live; i++) {
    rt.px[i] = (rng() - 0.5) * 0.12;
    rt.py[i] = LAUNCH_Y + (rng() - 0.5) * 0.1;
    rt.pz[i] = (rng() - 0.5) * 0.12;

    const a = rng() * TAU;
    // The band used to be 2.0–4.8, which against `DRAG` asymptotes at 1.74–4.17 units of
    // horizontal travel — up to two and a half times the visible half-height, so the far
    // chips were guaranteed to leave the View rect through its side. This band asymptotes
    // inside `BURST_RADIUS`, and the floor keeps every chip moving away from the hero's body
    // rather than falling back down through it.
    const speed = MIN_BURST_SPEED + rng() * 1.35;
    rt.vx[i] = Math.cos(a) * speed;
    // Depth is compressed against width: the camera looks roughly down -Z, and a burst that
    // is wider than it is deep reads as a burst instead of a cloud.
    rt.vz[i] = Math.sin(a) * speed * 0.72;
    // Vertical impulse, capped by the frame rather than by feel. Under `GRAVITY` and `DRAG`
    // a launch speed v rises `v/k - (g/k²)·ln(1 + kv/g)` above where it was released, so
    // this band rises 0.346-0.828 units from `LAUNCH_Y` — an apex at **y = 1.21 to 1.70**,
    // which is where `BURST_APEX_Y` below comes from. (The number in this comment used to
    // read "peaks at 1.20-1.68 units *above the crown*"; the arithmetic was right and the
    // label was wrong by the whole of `LAUNCH_Y`. It is an absolute height, not a clearance.)
    // The previous 4.2-6.8 peaked at 2.08 and clipped its fastest chips off the top edge.
    rt.vy[i] = 3.6 + rng() * 2.2;

    rt.ex[i] = rng() * TAU;
    rt.ey[i] = rng() * TAU;
    rt.ez[i] = rng() * TAU;
    rt.wx[i] = (rng() - 0.5) * 18;
    rt.wy[i] = (rng() - 0.5) * 14;
    rt.wz[i] = (rng() - 0.5) * 18;
    rt.fade[i] = 1;
    rt.rest[i] = 0;
  }
  rt.moving = rt.live;
}

/**
 * Reduced-motion arrangement: the burst caught mid-air, one frame after it opened.
 *
 * It used to be a golden-angle scatter lying flat at `REST_Y` — which is the same
 * coplanar-sheet-on-an-invisible-floor the full path was producing, just held still, and
 * held still is where a still frame is easiest to read as wrong. A shell around the hero has
 * no plane in it to be a floor, so there is nothing for the eye to read as a second horizon,
 * and it stays a reward rather than a mess to sweep up.
 */
function layoutConfettiStatic(rt: Runtime, rng: () => number): void {
  const n = rt.live;
  const spin = rng() * TAU;
  for (let i = 0; i < n; i++) {
    const a = i * 2.399963 + spin;
    // Golden angle in azimuth, a shaped radius, and a height that climbs with it: chips sit
    // in a shallow dome over the hero's crown rather than in a ring around its feet.
    const u = (i + 0.5) / n;
    const rad = Math.min(BURST_RADIUS, 0.52 + 0.82 * Math.sqrt(u));
    rt.px[i] = Math.cos(a) * rad;
    rt.pz[i] = Math.sin(a) * rad * 0.62;
    rt.py[i] = 1.28 - 0.62 * u + (rng() - 0.5) * 0.2;
    rt.ex[i] = rng() * TAU;
    rt.ey[i] = rng() * TAU;
    rt.ez[i] = rng() * TAU;
    rt.fade[i] = 1;
    rt.rest[i] = 1;
  }
  rt.moving = 0;
}

function layoutSparkles(rt: Runtime, rng: () => number, reduced: boolean): void {
  const warm = [ACCENTS.peach.soft, ACCENTS.peach.main, ACCENTS.mauve.soft];
  for (let i = 0; i < rt.nsLive; i++) {
    const a = rng() * TAU;
    const rad = 0.34 + rng() * 0.66;
    rt.spX[i] = Math.cos(a) * rad;
    rt.spY[i] = Math.sin(a) * rad * 0.9;
    rt.spZ[i] = -0.2 + rng() * 0.6;
    rt.spSize[i] = 0.1 + rng() * 0.13;
    rt.spRoll[i] = rng() * TAU;
    // Staggered so the field twinkles rather than flashing, but bounded: the last sparkle
    // finishes at 0.62 + 0.42 + 0.72 = 1.76s, comfortably inside T_DONE.
    rt.spStart[i] = reduced ? 0 : T_SPARKLE + rng() * 0.42;
    rt.spDur[i] = 0.55 + rng() * 0.17;
    const c = color(warm[Math.floor(rng() * warm.length)]);
    rt.spR[i] = c.r;
    rt.spG[i] = c.g;
    rt.spB[i] = c.b;
  }
}

function ensureInstanceColor(mesh: InstancedMesh, count: number): InstancedBufferAttribute {
  let attr = mesh.instanceColor;
  if (!attr || attr.count < count) {
    attr = new InstancedBufferAttribute(new Float32Array(count * 3), 3);
    attr.setUsage(DynamicDrawUsage);
    mesh.instanceColor = attr;
  }
  return attr;
}

/**
 * Writes each chip's accent into the **albedo** attribute, not into `instanceColor`.
 *
 * `instanceColor` and the vertex `color` attribute both feed `vColor`, and the clay shader
 * reads `vColor` as signed curvature centred on 1.0 and extrapolates it by `uClayAO = 1.45`.
 * A token written there is an albedo (always ≤ 1), so it came out multiplied by roughly 0.55
 * and every channel under ~0.31 clamped to black. That is the whole mechanism behind the
 * arterial-red confetti in the round-2 evidence. See `materials.ts::ALBEDO_ATTRIBUTE`.
 */
function writeConfettiColours(
  attr: InstancedBufferAttribute,
  rt: Runtime,
  family: AccentFamily
): void {
  // Dealt, not drawn. A cycle guarantees the proportions in `confettiPalette` are the
  // proportions that actually render — sampling ten slots two hundred times independently
  // leaves the realised mix several points off the composition on any given run, and the
  // whole point of composing it is that the burst is the same picture every time.
  const palette = confettiPalette(family);
  for (let i = 0; i < rt.live; i++) {
    writeAlbedo(attr, i, color(palette[i % palette.length]));
  }
  attr.needsUpdate = true;
}

/** Sparkle tints are written per frame (they double as brightness), so this only sizes the buffer. */
function prepareSparkles(mesh: InstancedMesh, rt: Runtime): void {
  ensureInstanceColor(mesh, rt.ns);
  mesh.instanceMatrix.setUsage(DynamicDrawUsage);
}

/* ------------------------------------------------------------------ */
/* Per-frame integrators — zero allocation below this line             */
/* ------------------------------------------------------------------ */

function updateConfettiBurst(mesh: InstancedMesh, rt: Runtime, dt: number): void {
  if (rt.moving === 0) return;
  const arr = mesh.instanceMatrix.array as Float32Array;
  const drag = Math.exp(-DRAG * dt);
  const angDrag = Math.exp(-ANG_DRAG * dt);
  let wrote = 0;

  for (let i = 0; i < rt.live; i++) {
    if (rt.rest[i] === 1) continue;

    rt.vy[i] += GRAVITY * dt;
    rt.vx[i] *= drag;
    rt.vy[i] *= drag;
    rt.vz[i] *= drag;

    rt.px[i] += rt.vx[i] * dt;
    rt.py[i] += rt.vy[i] * dt;
    rt.pz[i] += rt.vz[i] * dt;

    rt.ex[i] += rt.wx[i] * dt;
    rt.ey[i] += rt.wy[i] * dt;
    rt.ez[i] += rt.wz[i] * dt;
    rt.wx[i] *= angDrag;
    rt.wy[i] *= angDrag;
    rt.wz[i] *= angDrag;

    // Hold the burst inside the frame. Pulling the position back onto the cap rather than
    // clamping the impulse means the cap holds whatever the drag, the frame rate or a
    // future camera does, and killing the outward velocity at the same moment stops a
    // capped chip from sliding along the boundary like a puck against a wall.
    const r2 = rt.px[i] * rt.px[i] + rt.pz[i] * rt.pz[i];
    if (r2 > BURST_RADIUS * BURST_RADIUS) {
      const k = BURST_RADIUS / Math.sqrt(r2);
      rt.px[i] *= k;
      rt.pz[i] *= k;
      rt.vx[i] *= 0.35;
      rt.vz[i] *= 0.35;
    }

    // Fade out on the way down instead of landing. No ground contact anywhere in this
    // integrator: see FADE_START_Y for why a resting carpet was the wrong answer.
    if (rt.vy[i] < 0 && rt.py[i] < FADE_START_Y) {
      rt.fade[i] -= dt / FADE_SECONDS;
      if (rt.fade[i] <= 0) {
        rt.fade[i] = 0;
        rt.rest[i] = 1;
        rt.moving--;
      }
    }

    // Cubic on the way out, so a chip thins rather than snapping off.
    const f = rt.fade[i];
    const s = f >= 1 ? 1 : f * f * (3 - 2 * f);
    vPos.set(rt.px[i], rt.py[i], rt.pz[i]);
    eul.set(rt.ex[i], rt.ey[i], rt.ez[i]);
    quat.setFromEuler(eul);
    vScale.set(rt.sx[i] * s, rt.sy[i] * s, rt.sz[i] * s);
    mtx.compose(vPos, quat, vScale);
    mtx.toArray(arr, i * 16);
    wrote++;
  }

  if (wrote > 0) mesh.instanceMatrix.needsUpdate = true;
}

function updateConfettiStatic(mesh: InstancedMesh, rt: Runtime): void {
  const arr = mesh.instanceMatrix.array as Float32Array;
  const k = rt.reveal;
  for (let i = 0; i < rt.live; i++) {
    vPos.set(rt.px[i], rt.py[i], rt.pz[i]);
    eul.set(rt.ex[i], rt.ey[i], rt.ez[i]);
    quat.setFromEuler(eul);
    // Scale-in only. The clay materials are shared and cached by key, so animating opacity
    // here would fade every other prop in the app using the same material.
    const s = 0.55 + 0.45 * k;
    vScale.set(rt.sx[i] * s, rt.sy[i] * s, rt.sz[i] * s);
    mtx.compose(vPos, quat, vScale);
    mtx.toArray(arr, i * 16);
  }
  mesh.instanceMatrix.needsUpdate = true;
}

function updateSparkles(mesh: InstancedMesh, rt: Runtime, t: number): void {
  if (rt.sparklesFlushed) return;
  const arr = mesh.instanceMatrix.array as Float32Array;
  const attr = mesh.instanceColor;
  const carr = attr ? (attr.array as Float32Array) : null;
  let alive = 0;

  for (let i = 0; i < rt.nsLive; i++) {
    const u = clamp01((t - rt.spStart[i]) / rt.spDur[i]);
    let scale = 0;
    let bright = 0;
    if (u > 0 && u < 1) {
      // Elastic pop over the first third, then a soft cubic fade — a twinkle, not a strobe.
      const pop = easeOutElastic(clamp01(u / 0.34), 1, 0.42);
      const fade = u < 0.3 ? 1 : Math.pow(1 - (u - 0.3) / 0.7, 1.6);
      scale = rt.spSize[i] * pop;
      bright = fade * SPARKLE_PEAK;
      alive++;
    } else if (u <= 0) {
      alive++;
    }

    vPos.set(rt.spX[i], rt.spY[i], rt.spZ[i]);
    eul.set(0, 0, rt.spRoll[i]);
    quat.setFromEuler(eul);
    vScale.set(scale, scale, scale);
    mtx.compose(vPos, quat, vScale);
    mtx.toArray(arr, i * 16);

    if (carr) {
      // Additive blending turns per-instance colour into per-instance brightness, which is
      // how each sparkle gets its own life without a per-instance alpha attribute.
      carr[i * 3] = rt.spR[i] * bright;
      carr[i * 3 + 1] = rt.spG[i] * bright;
      carr[i * 3 + 2] = rt.spB[i] * bright;
    }
  }

  mesh.instanceMatrix.needsUpdate = true;
  if (attr) attr.needsUpdate = true;
  // One final all-zero write lands before this latches, so nothing is left mid-fade.
  if (alive === 0) rt.sparklesFlushed = true;
}

function updateSparklesStatic(mesh: InstancedMesh, rt: Runtime): void {
  const arr = mesh.instanceMatrix.array as Float32Array;
  const attr = mesh.instanceColor;
  const carr = attr ? (attr.array as Float32Array) : null;
  const k = rt.reveal;

  for (let i = 0; i < rt.nsLive; i++) {
    const scale = rt.spSize[i] * (0.6 + 0.4 * k);
    vPos.set(rt.spX[i], rt.spY[i], rt.spZ[i]);
    eul.set(0, 0, rt.spRoll[i]);
    quat.setFromEuler(eul);
    vScale.set(scale, scale, scale);
    mtx.compose(vPos, quat, vScale);
    mtx.toArray(arr, i * 16);

    if (carr) {
      const bright = SPARKLE_PEAK * 0.68 * k;
      carr[i * 3] = rt.spR[i] * bright;
      carr[i * 3 + 1] = rt.spG[i] * bright;
      carr[i * 3 + 2] = rt.spB[i] * bright;
    }
  }

  mesh.instanceMatrix.needsUpdate = true;
  if (attr) attr.needsUpdate = true;
}
