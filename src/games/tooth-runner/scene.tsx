/**
 * Tooth Runner — the 3D world.
 *
 * How this file is wired (the pattern is Tooth Match's, adapted for a game whose logic has
 * to advance every frame rather than on a tap):
 *
 *  • It takes ONE prop, the engine, and that prop never changes identity. The component is
 *    memoised on it, so the shell re-rendering its clock once a second never touches the 3D
 *    tree. **This scene re-renders exactly zero times during a run** — every item, every
 *    prop and every scenery pool is an `InstancedMesh` whose contents are written from
 *    `useFrame`, so nothing about the run has to travel through React at all.
 *  • `useFrame` drives `engine.update(dt)` first, then reads the result. Both halves are
 *    allocation-free: module-level scratch `Matrix4`/`Vector3`/`Quaternion`/`Euler`, no
 *    literals, no closures, no `map`.
 *  • Everything repeated is instanced and recycled from a fixed pool. Nothing is created or
 *    destroyed while the game is running — an endless runner that allocates per spawn will
 *    hitch, so this one has no per-spawn path at all: `spawn()` sets fields on a pool member
 *    that has existed since mount.
 *
 * ── Depth ──────────────────────────────────────────────────────────────────────
 *
 * Three bands, described in `props.ts` and `layout.ts`. The near band (lane ties, kerb
 * pebbles, gateway posts, and the items themselves) runs at the world speed. The mid band runs at
 * 0.62 of it and the far ridge at 0.26 — physically wrong for a perspective camera, and
 * deliberately so: it is the diorama trick that makes a 3 metre deep set read as a
 * landscape. Under reduced motion each pool takes its own `reducedRate` — see
 * `layout.ts::RATE_MID_REDUCED` for the measurement, and for why collapsing all three to the
 * *near* rate (which is what shipped) made the far band 3.85x busier instead of quieter.
 *
 * ── The jump ───────────────────────────────────────────────────────────────────
 *
 * The one interaction the game has, so it gets the whole vocabulary: a 70 ms anticipation
 * crouch that compresses the tooth into the lane (visible on the frame the child taps),
 * a launch that kicks a stretch spring, a hang at the apex where the tooth stretches along
 * its travel, and a landing that kicks a squash scaled by the real impact speed and settles.
 * The arc itself is ballistic, solved in `layout.ts` from an apex and a hang time.
 *
 * ── The runner ─────────────────────────────────────────────────────────────────
 *
 * The hero is the product's shared mascot (`mascotParts`) and it runs on a two-beat cycle
 * locked to the ground speed. It used to be a bare tooth spun end over end at 1.5 rev/s,
 * which showed its roots to the sky for much of every second and left a face nowhere to
 * live. The crown now faces forward permanently, so the face is readable on every frame.
 *
 * ── Reduced motion ─────────────────────────────────────────────────────────────
 *
 * The camera never moves: the jump-follow is a translation of the *world group* held at
 * zero, and the stumble nudge goes through `CameraRig.shake`, which is a no-op on that path.
 * The mid band drops to 0.12 of the world speed and the far ridge stops entirely, so the
 * moving world — not just its decoration — is what gets quieter. The crouch delay goes to zero
 * so the tooth leaves the ground on the tap. Springs are inert by design in `anim.ts`, so every
 * impulse-driven flourish is replaced by an explicit ≤150 ms scale pop. Nothing idles.
 *
 * The **gait stays**, at `REDUCED_GAIT` of its amplitude. It used to be switched off entirely,
 * which left a rigid statue skating along a lane that was still scrolling — RU7: *"a
 * character's gait is not a vestibular trigger; camera motion and parallax are."* A tooth that
 * slides without moving its legs reads as broken, not as calm. The items still come — that is
 * the game.
 */
import { createRef, memo, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import {
  AdditiveBlending,
  DynamicDrawUsage,
  Euler,
  Matrix4,
  MeshBasicMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Quaternion,
  Vector3,
  type Group,
  type InstancedMesh,
  type Mesh,
} from "three";

import {
  FEEL,
  Spring,
  anticipate,
  clamp01,
  damp,
  easeInCubic,
  easeOutBack,
  easeOutCubic,
  safeDelta,
  squashFor,
} from "../../three/anim";
import { CameraRig } from "../../three/camera";
import { DisposalBag } from "../../three/dispose";
import { cachedGeometry, mascotParts, roundedBox } from "../../three/geometry";
import { clay, shadowBlobMaterial } from "../../three/materials";
import { Rig, contactOpacityFor, contactRadiusFor } from "../../three/Rig";
import { celebrationHeroScale, isReduced } from "../../three/store";
import { sparkleTexture } from "../../three/textures";
import { CLAY, KEY_LIGHT } from "../../three/tokens";
import {
  FINISH_DELAY,
  ITEM_BUMPED,
  ITEM_DEAD,
  ITEM_LIVE,
  ITEM_TAKEN,
  KIND_COUNT,
  MAX_ITEMS,
  type ToothRunnerEngine,
} from "./engine";
import {
  FOG_DENSITY,
  GROUND_SIZE,
  GROUND_Y,
  ITEM_CLEAR_SPAN,
  ITEM_CLEAR_Z,
  JUMP_V,
  LANE_LEN,
  LANE_W,
  SHADOW_AREA,
  SPAWN_GROW,
  SPAWN_Z,
  STRIDE,
  TOOTH_CENTER_Y,
} from "./layout";
import { buildItems, buildScatters } from "./props";

/* ------------------------------------------------------------------ */
/* Tuning                                                              */
/* ------------------------------------------------------------------ */

/** Lane bed: one long static slab. Both ends are far enough out to be pure fog. */
const LANE_T = 0.26;
const LANE_CENTER_Z = -44;

/**
 * Spring constants for the hero, and why every impulse below moved with them.
 *
 * `3D-SPEC §4` puts every spring in the product at stiffness 260–420 and **damping 18–28**.
 * Round 2 measured all four of this game's at 17 / 9 / 12 / 15 — ζ = 0.44 / 0.26 / 0.37 /
 * 0.45 against the band's 0.55–0.85. The wobble was the bad one: at ζ = 0.26 it keeps 43% of
 * its amplitude every cycle, so a stumble rang for five-plus visible oscillations and the
 * tooth read as rubber rather than as clay.
 *
 * Raising damping alone would also have shrunk every gesture, because the peak of an impulse
 * response falls as ζ rises. So each impulse is scaled by the ratio of the two peaks —
 * `peak = (v₀/ω_d)·e^{-ζωₙtₚ}·sin(ω_d tₚ)` at `tₚ = atan(√(1-ζ²)/ζ)/ω_d` — and the
 * visible amplitude of every launch, landing, stumble and pickup is unchanged to three
 * decimal places. What changed is only how fast it stops ringing: the wobble now decays to
 * 1.2% a cycle instead of 18%.
 */
const SQUASH_SPRING = [380, 19] as const;
const WOBBLE_SPRING = [300, 20] as const;
const LURCH_SPRING = [260, 19] as const;
const HOP_SPRING = [280, 19] as const;

/** Squash at the bottom of the anticipation crouch, and stretch at the top of the arc. */
const CROUCH_SQUASH = 0.26;
const AIR_STRETCH = 0.17;
/** Kicked on launch and on landing. Landing scales with the real impact speed. */
const LAUNCH_IMPULSE = 5.78;
const LAND_IMPULSE_SCALE = 1.21;
const LAND_IMPULSE_MAX = 7.36;

/** A candy: a hitch in the stride, a sideways wobble, a hop and a squash. */
const STUMBLE_LURCH = -8.63;
const STUMBLE_WOBBLE = 6.91;
const STUMBLE_SQUASH = -4.73;
const STUMBLE_HOP = 1.23;
/**
 * Fraction of the camera rig's own shake budget a stumble spends.
 *
 * This used to translate the *world group* by up to 0.05 units on top of `CameraRig`'s
 * 0.06-unit breathe, which put the combined displacement at ~0.11 against §4's 0.06 cap —
 * and did it by moving the world, which is precisely how you defeat a clamp that lives on
 * the camera. It now goes through `CameraRig.shake`, so the saturation, the decay and the
 * zero-angular-velocity guarantee all apply, and reduced motion silences it for free.
 */
const STUMBLE_SHAKE = 0.5;

/** A pickup: the tooth stretches with delight and the brush pops into sparkles. */
const COLLECT_STRETCH = 3.36;
const COLLECT_HOP = 1.57;
const COLLECT_SPARKS = 10;
const FINISH_SPARKS = 16;
const START_SPARKS = 8;

/* ------------------------------------------------------------------ */
/* The runner                                                          */
/* ------------------------------------------------------------------ */

/**
 * The hero used to be a bare `toothGeometry("baby")` spun end over end at 1.5 revolutions a
 * second. Two things were wrong with that and they are the same thing: it had no face, and
 * there was nowhere on it a face could have lived. Half of every second it presented its
 * roots to the sky, which for a dental brand is a poor read and for a four-year-old is not a
 * character at all.
 *
 * It is now the product's mascot (`mascotParts`) and it **runs**: a two-beat cycle locked to
 * the same ground speed that used to drive the roll, with the feet alternating, the arms
 * swinging against them, a bounce between footfalls and a compression on each contact. The
 * crown faces forward at all times, so the face is always readable — which is `G-TRN-6`'s
 * second remedy taken all the way rather than counter-rotating a face on a rolling ball.
 */
const HERO_HEIGHT = 1;
/**
 * A three-quarter turn — 35.5° off dead-on, toward the key light at upper-left.
 *
 * Not a free choice. Dead-on gives the best face and the worst gait, because the stride then
 * swings straight down the view axis and foreshortens to nothing; in profile the gait reads
 * and the face does not. At 35.5° the fore-aft stride still projects 56% of its travel
 * across the frame, both eyes and both cheeks stay clear of the silhouette (occlusion on a
 * convex face does not start until past ~60°), and the key gets a cheek to model instead of
 * the flat pancake a perfectly frontal face returns.
 */
const HERO_YAW = -0.62;
/**
 * Feature scale for the hero's face, and the screen size it actually buys — re-derived,
 * because the number this comment used to carry was not the one the camera produces.
 *
 * The solve puts the lens `MIN_DISTANCE` = 7.4 units from the aim point on a 28° lens, and
 * the hero's face sits 7.42 units from it, so the view there spans `2 × 7.42 × tan 14°` =
 * 3.70 world units across the 725 px shell — **196 px per world unit**, not the 179 that was
 * written here. `MASCOT_FACE.eye.r × featureScale` is then `0.068 × 1.18` = 0.0802, an eye
 * ball 0.160 units across = **31 screen px**, of which the cap standing proud of the crown is
 * the visible pupil. Comfortably over the 20 px a feature needs to read at arm's length.
 */
const HERO_FEATURES = 1.18;

/**
 * How far the mouth opens — 0.3, down from 0.55.
 *
 * The number is unchanged and its first reason still holds: the mouth's semi-height is
 * `(0.026 + 0.074 · open) · featureScale`, so at 0.55 and `featureScale` 1.18 it was 0.0787
 * units — a **73 × 31 px warm brown patch across the front of a tooth**, in a paediatric
 * dental product, on the surface a child looks at longest. At 0.3 it is 0.0569 units,
 * 73 × 23 px.
 *
 * Its *second* reason is gone and this comment no longer claims it. Round 4's A5 rebuilt
 * `MASCOT_FACE.mouth` as a curved, tapered arc swept along `y(u) = y + rise·(u² − ½)` with
 * `curve: 0.5`, so **the corners sit above the centre at every `open` value, 0 included** —
 * 0.3 is now a smile because the geometry is a smile, not because a small ellipsoid looks
 * less like a hole than a large one. The tongue anchor this file used to step around was the
 * same fix's second half (it is now derived from the solved mouth and sits inside it), so
 * there is nothing here compensating for it; `open` 0.3 keeps the tongue undrawn on its own
 * merits, because a runner seen at 196 px per world unit does not need one.
 */
const MOUTH_OPEN = 0.3;
/** Pitch pivot: about the hips, not about the feet or the crown. */
const LEAN_PIVOT = 0.34;

/** Peak lift between footfalls, and how far a foot swings fore-and-aft and clears the lane. */
const RUN_BOB = 0.075;
/**
 * The stride swings along the mascot's own facing, which `HERO_YAW` turns 35.5° off the view
 * axis — so only 56% of this projects across the frame. At the 196 px per world unit derived
 * on `HERO_FEATURES`, 0.15 units of travel is 29 px of swing, 16 px of it lateral. The foot
 * pad it moves is `2 × MASCOT_FACE.foot.w` = 0.21 units — **41 px**, not the 21 px this
 * comment claimed (it read the semi-axis as the width). The conclusion survives the
 * correction in the same direction: the swing is 40 % of the pad, a stride and not a twitch.
 */
const RUN_STEP_Z = 0.15;
const RUN_STEP_LIFT = 0.07;
/** Compression on contact, and the body's fore-aft rock across a stride. */
const RUN_SQUASH = 0.09;
const RUN_ROCK = 0.06;
const ARM_SWING = 0.42;
/** How high the tooth has to be before the run cycle gives way to a tucked jump pose. */
const AIRBORNE_FADE = 0.35;
/**
 * Gait amplitude under `prefers-reduced-motion`, and why it is not zero.
 *
 * RU7: `const running = reduced ? 0 : grounded;` gave the reduced-motion player *"a rigid
 * statue skating along the ground, which reads as broken rather than calm"*, while the world
 * around it kept scrolling. A limb cycle at 0.45 is 0.034 units of body bounce, 0.031 of foot
 * lift, 0.19 rad of arm swing and 0.04 of squash — a walk-run at half amplitude, all of it
 * *inside the character's own silhouette* and none of it moving the camera, the frame or the
 * background. §4 puts the reduction where the optic flow is, which is `layout.ts`'s parallax
 * rates, not on the one thing in the frame that explains what the child is looking at.
 */
const REDUCED_GAIT = 0.45;

/**
 * The starting leap.
 *
 * The first touch is the most important interaction in the game and it produced nothing: the
 * pill vanished, `jump()` returned early by design, and the world ramped up on a damp. The
 * rule stays (the first tap starts the run and does not spend itself on a jump into an empty
 * lane) but the *character* now answers it — `anticipate` dips the tooth into the lane and
 * fires it back out past its own height, with sparkles off the feet, all inside 0.42 s.
 */
const GO_DUR = 0.42;
const GO_LIFT = 0.6;
const GO_SQUASH = 0.42;

const SPARKLES = 30;
/**
 * Contact-blob pool, counted rather than estimated.
 *
 * `buildScatters` writes one blob per `blobAt` entry per instance, for the pools with a
 * non-zero `foot`: hill-near 7 + hill-far 6 + brush 6 + leaf 10 + gate 4 × 2 = **37**. Plus
 * `MAX_ITEMS` = 12 and the hero's own = **50**. 56 is that with a spare pool's worth of
 * headroom, and the ceiling is real — `writeBlob` drops silently past it, and the previous
 * value of 48 would now be reached in a frame with nine live items.
 */
const MAX_BLOBS = 56;

/**
 * The hero's own footprint on the lane, and the direction a cast shadow slides.
 *
 * `MASCOT_FACE.foot` puts each foot at x ±0.155 with semi-axes 0.105 × 0.125, and the run
 * cycle swings them ±`RUN_STEP_Z`; the farthest a foot's surface gets from the body axis is
 * therefore `hypot(0.155 + 0.105, 0.035 + 0.125 + 0.15)` = 0.42 at full stride, and 0.32 at
 * a contact — which is the pose the contact term is for. `contactRadiusFor` turns that into
 * a quad, so the number below is a measurement of the mascot and not a dial.
 */
const HERO_FOOT = 0.32;

/**
 * Ground footprint of a sweet, and the height of the mass above it.
 *
 * The three low sweets present 0.31–0.36 of half-width to the lane and stand 0.22–0.34 tall,
 * so one pair of numbers serves the pool. This was 0.3 of *radius* before, which — through
 * `CONTACT_BLOB_VISIBLE_FRACTION` — is 0.248 of visible blob under a 0.3-wide object: the
 * same arithmetic error the hills carried, on a smaller prop.
 */
const ITEM_FOOT = 0.3;
const ITEM_LIFT = 0.12;

/**
 * Ground-plane direction and rate at which a cast shadow slides away from the key, derived
 * from `KEY_LIGHT.position` = (−4, 7, 5): a point `h` above the floor lands at
 * `−h · (x, z) / y` = `h · (4/7, −5/7)`, i.e. `h · 0.9146` in the direction (0.5714, −0.7143)
 * — the cotangent of the key's 47.55° elevation.
 *
 * This is what a contact blob under a *dome* was missing. The blob is a hole in the light,
 * and the hole a dome makes is not centred under the dome: it is swept from the contact
 * ellipse toward the shadow side. Sizing the quad to the footprint alone put every visible
 * pixel of it underneath the prop.
 */
const SHADOW_SLIDE_X = KEY_LIGHT.position[0] / -KEY_LIGHT.position[1];
const SHADOW_SLIDE_Z = KEY_LIGHT.position[2] / -KEY_LIGHT.position[1];

const TWO_PI = Math.PI * 2;

/* ------------------------------------------------------------------ */
/* Per-frame scratch — module level, allocated exactly once            */
/* ------------------------------------------------------------------ */

const _prop = new Matrix4();
const _part = new Matrix4();
const _blob = new Matrix4();
const _pos = new Vector3();
const _scl = new Vector3();
const _quat = new Quaternion();
const _euler = new Euler();
const _squash = { x: 1, y: 1, z: 1 };
const _kindCount = new Int32Array(KIND_COUNT);

/** Lays a unit quad flat on the ground, so one plane serves every contact blob. */
const BLOB_QUAT = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -Math.PI / 2);

/** Write cursor into the shared contact-blob instance buffer, reset at the top of a frame. */
let _blobCount = 0;

/* ------------------------------------------------------------------ */
/* Presentation state for the tooth                                    */
/* ------------------------------------------------------------------ */

type ToothAnim = {
  /** Run-cycle phase in radians. One footfall every π, locked to ground speed via `STRIDE`. */
  stride: number;
  /** Damped acceleration estimate, and the pitch it drives. */
  accel: number;
  prevSpeed: number;
  lean: number;
  /** Damped vertical follow of the world group. Held at zero under reduced motion. */
  followY: number;
  /** Springs. Constructed here and only here; stepping them per frame allocates nothing. */
  squash: Spring;
  wobble: Spring;
  lurch: Spring;
  hop: Spring;
  /** Reduced-motion scale pop — springs are deliberately inert on that path. */
  popT: number;
  popDur: number;
  popAmp: number;
  /** Countdown across the starting leap, and across the finale's near-volume sweep. */
  goT: number;
  finale: number;
};

function createToothAnim(): ToothAnim {
  return {
    stride: 0,
    accel: 0,
    prevSpeed: 0,
    lean: 0,
    followY: 0,
    squash: new Spring(0, SQUASH_SPRING[0], SQUASH_SPRING[1]),
    wobble: new Spring(0, WOBBLE_SPRING[0], WOBBLE_SPRING[1]),
    lurch: new Spring(0, LURCH_SPRING[0], LURCH_SPRING[1]),
    hop: new Spring(0, HOP_SPRING[0], HOP_SPRING[1]),
    popT: 0,
    popDur: FEEL.reducedFade,
    popAmp: 0,
    goT: 0,
    finale: 0,
  };
}

function pop(a: ToothAnim, amp: number): void {
  a.popAmp = amp;
  a.popDur = FEEL.reducedFade;
  a.popT = FEEL.reducedFade;
}

function resetToothAnim(a: ToothAnim): void {
  a.stride = 0;
  a.accel = 0;
  a.prevSpeed = 0;
  a.lean = 0;
  a.followY = 0;
  a.squash.set(0);
  a.wobble.set(0);
  a.lurch.set(0);
  a.hop.set(0);
  a.popT = 0;
  a.popAmp = 0;
  a.goT = 0;
  a.finale = 0;
}

/* ------------------------------------------------------------------ */
/* Sparkles                                                            */
/* ------------------------------------------------------------------ */

type SparkleField = {
  n: number;
  px: Float32Array;
  py: Float32Array;
  pz: Float32Array;
  vx: Float32Array;
  vy: Float32Array;
  vz: Float32Array;
  life: Float32Array;
  dur: Float32Array;
  size: Float32Array;
  next: number;
  live: number;
};

function createSparkles(n: number): SparkleField {
  const f = () => new Float32Array(n);
  return {
    n,
    px: f(),
    py: f(),
    pz: f(),
    vx: f(),
    vy: f(),
    vz: f(),
    life: f(),
    dur: f(),
    size: f(),
    next: 0,
    live: 0,
  };
}

/** Fired from a discrete event, never per frame — `Math.random` here is free. */
function burst(
  field: SparkleField,
  x: number,
  y: number,
  z: number,
  count: number,
  reduced: boolean
): void {
  for (let k = 0; k < count; k++) {
    const i = field.next;
    field.next = (field.next + 1) % field.n;
    if (field.dur[i] <= 0) field.live++;
    field.px[i] = x + (Math.random() - 0.5) * 0.3;
    field.py[i] = y + (Math.random() - 0.5) * 0.24;
    field.pz[i] = z + (Math.random() - 0.5) * 0.3;
    const a = Math.random() * Math.PI * 2;
    const e = 0.25 + Math.random() * 1;
    const s = reduced ? 0 : 1 + Math.random() * 0.9;
    field.vx[i] = Math.cos(a) * Math.cos(e) * s;
    field.vy[i] = Math.sin(e) * s + (reduced ? 0 : 0.7);
    field.vz[i] = Math.sin(a) * Math.cos(e) * s;
    field.life[i] = 0;
    field.dur[i] = reduced ? 0.28 : 0.55 + Math.random() * 0.3;
    field.size[i] = 0.16 + Math.random() * 0.12;
  }
}

function resetSparkles(field: SparkleField): void {
  for (let i = 0; i < field.n; i++) if (field.dur[i] > 0) field.life[i] = field.dur[i];
}

/**
 * Sparkles drift with the world, not with the ground under them: a spark thrown off a
 * pickup keeps the pickup's momentum, which at 8 units a second is most of what it is
 * doing. `drift` is that carry, applied as a plain Z translation.
 */
function stepSparkles(
  field: SparkleField,
  mesh: InstancedMesh,
  camQuat: Quaternion,
  dt: number,
  drift: number,
  reduced: boolean
): void {
  if (field.live <= 0) return;
  let live = 0;
  for (let i = 0; i < field.n; i++) {
    const dur = field.dur[i];
    if (dur <= 0) continue;
    const life = field.life[i] + dt;
    if (life >= dur) {
      field.dur[i] = 0;
      _pos.set(0, 0, 0);
      _scl.set(0, 0, 0);
      _part.compose(_pos, camQuat, _scl);
      mesh.setMatrixAt(i, _part);
      continue;
    }
    field.life[i] = life;
    live++;
    field.pz[i] += drift;
    if (!reduced) {
      field.vy[i] -= 3.6 * dt;
      field.px[i] += field.vx[i] * dt;
      field.py[i] += field.vy[i] * dt;
      field.pz[i] += field.vz[i] * dt;
    }
    const p = life / dur;
    const grow = reduced ? easeOutCubic(p * 4) : easeOutBack(p * 3.4 > 1 ? 1 : p * 3.4, 2);
    const size = field.size[i] * grow * (1 - p * p);
    _pos.set(field.px[i], field.py[i], field.pz[i]);
    _scl.set(size, size, size);
    _part.compose(_pos, camQuat, _scl);
    mesh.setMatrixAt(i, _part);
  }
  field.live = live;
  mesh.instanceMatrix.needsUpdate = true;
}

/* ------------------------------------------------------------------ */
/* Scene                                                               */
/* ------------------------------------------------------------------ */

function ToothRunnerSceneImpl({ engine }: { engine: ToothRunnerEngine }): JSX.Element {
  /* ---------------- resources (all shared + cached) ---------------- */

  const kinds = useMemo(() => buildItems(), []);
  const scatters = useMemo(() => buildScatters(), []);
  const anim = useMemo(() => createToothAnim(), []);
  const sparkles = useMemo(() => createSparkles(SPARKLES), []);
  const bag = useMemo(() => new DisposalBag(), []);

  /**
   * The hero, as a flat list of meshes from the shared builder. Every geometry and material
   * in it comes back from the shared caches, so this costs a handful of lookups and no GPU
   * memory the product was not already carrying.
   */
  const hero = useMemo(
    () => mascotParts({ height: HERO_HEIGHT, featureScale: HERO_FEATURES, open: MOUTH_OPEN }),
    []
  );
  const laneGeo = useMemo(() => roundedBox(LANE_W, LANE_T, LANE_LEN, 0.1), []);
  const laneMat = useMemo(
    () => clay("tooth-runner/lane", { color: CLAY.ivoryDeep, roughness: 0.84, sheen: 0.14, grain: 0.16 }),
    []
  );
  const quadGeo = useMemo(() => cachedGeometry("tooth-runner/quad", () => new PlaneGeometry(1, 1)), []);
  const blobMat = useMemo(() => shadowBlobMaterial(), []);

  /**
   * The one resource this game constructs itself, and therefore the one it must free.
   * Everything else came back from a `markShared` cache and is not ours to dispose.
   */
  const sparkleMat = useMemo(
    () =>
      new MeshBasicMaterial({
        map: sparkleTexture(),
        color: CLAY.wear,
        transparent: true,
        blending: AdditiveBlending,
        // `sparkleTexture` writes RGB already scaled by alpha; without this three's additive
        // path multiplies by alpha twice and the warm tail collapses to a dot.
        premultipliedAlpha: true,
        depthWrite: false,
        toneMapped: false,
        fog: false,
      }),
    []
  );

  useEffect(() => {
    bag.add(sparkleMat);
    return () => bag.release();
  }, [bag, sparkleMat]);

  /* ---------------- refs ---------------- */

  const worldRef = useRef<Group>(null);
  const heroRef = useRef<Group>(null);
  const bodyRef = useRef<Group>(null);
  const leanRef = useRef<Group>(null);
  const blobRef = useRef<InstancedMesh>(null);
  const sparkRef = useRef<InstancedMesh>(null);

  /**
   * The four mascot parts the run cycle drives, plus the rest positions it swings them
   * around. Built once from the part list itself, so a change to `MASCOT_FACE`'s proportions
   * moves the animation with it instead of silently desynchronising from it.
   */
  const limbs = useMemo(() => {
    const find = (key: string) => hero.find((part) => part.key === key) ?? null;
    const foot = (key: string) => {
      const p = find(key);
      return { ref: createRef<Mesh>(), y: p ? p.position[1] : 0, z: p ? p.position[2] : 0 };
    };
    // Arms need no rest values: the gait writes `rotation.x` only, and the outward tilt on
    // `rotation.z` is the one React applied from the part list and never touches again.
    return {
      footL: foot("foot-l"),
      footR: foot("foot-r"),
      armL: createRef<Mesh>(),
      armR: createRef<Mesh>(),
    };
  }, [hero]);

  /** Look-up from part key to the ref that part needs, or undefined for a static part. */
  const partRef = useMemo(() => {
    const map: Record<string, ReturnType<typeof createRef<Mesh>>> = {};
    map["foot-l"] = limbs.footL.ref;
    map["foot-r"] = limbs.footR.ref;
    map["arm-l"] = limbs.armL;
    map["arm-r"] = limbs.armR;
    return map;
  }, [limbs]);

  /**
   * The stumble's camera nudge, borrowed from `celebrate.tsx`'s pattern.
   *
   * `Scene3D` owns this view's camera with its own `CameraRig` and rewrites it from scratch
   * at priority 0, so a second rig aimed at the same camera would fight it. This one drives a
   * detached proxy whose base is the origin and whose breathe is off, which makes
   * `proxy.position` after `update()` the pure shake vector — added to the real camera after
   * `Scene3D` has written it. Translating position without touching the quaternion moves the
   * aim point by the same vector, so the angular velocity is exactly zero.
   */
  const shake = useMemo(() => {
    const proxy = new PerspectiveCamera();
    const rig = new CameraRig(proxy, { breathe: false, maxShake: 0.05 });
    rig.setBase(0, 0, 0, 0, 0, -1, true);
    return { proxy, rig };
  }, []);
  useEffect(() => () => shake.rig.dispose(), [shake]);

  /** One ref per part per pool. Built once; `map` here runs at mount, never per frame. */
  const scatterRefs = useMemo(
    () => scatters.map((def) => def.parts.map(() => createRef<InstancedMesh>())),
    [scatters]
  );
  const itemRefs = useMemo(
    () => kinds.map((kind) => kind.parts.map(() => createRef<InstancedMesh>())),
    [kinds]
  );

  /** Scroll offset per pool, in world units. Kept inside [0, span) so it never drifts. */
  const offsets = useMemo(() => new Float64Array(scatters.length), [scatters]);

  /* ---------------- instance buffers ---------------- */

  useLayoutEffect(() => {
    const zero = new Matrix4().makeScale(0, 0, 0);
    for (let s = 0; s < scatterRefs.length; s++) {
      const refs = scatterRefs[s];
      for (let p = 0; p < refs.length; p++) {
        const mesh = refs[p].current;
        if (mesh) mesh.instanceMatrix.setUsage(DynamicDrawUsage);
      }
    }
    for (let k = 0; k < itemRefs.length; k++) {
      const refs = itemRefs[k];
      for (let p = 0; p < refs.length; p++) {
        const mesh = refs[p].current;
        if (!mesh) continue;
        mesh.instanceMatrix.setUsage(DynamicDrawUsage);
        mesh.count = 0;
      }
    }
    const blob = blobRef.current;
    if (blob) {
      blob.instanceMatrix.setUsage(DynamicDrawUsage);
      blob.count = 0;
    }
    const spark = sparkRef.current;
    if (spark) {
      spark.instanceMatrix.setUsage(DynamicDrawUsage);
      // InstancedMesh starts life with identity matrices, which would park a full-size
      // sparkle at the origin until the first burst. Collapse them all up front.
      for (let i = 0; i < SPARKLES; i++) spark.setMatrixAt(i, zero);
      spark.instanceMatrix.needsUpdate = true;
    }
  }, [scatterRefs, itemRefs]);

  /* ---------------- engine events ---------------- */

  useEffect(
    () =>
      engine.on((event) => {
        const reduced = isReduced();
        switch (event.type) {
          case "reset":
            resetToothAnim(anim);
            resetSparkles(sparkles);
            break;
          case "start":
            // The first touch has to land on the character, not just on the HUD.
            burst(sparkles, 0, 0.1, 0.1, reduced ? 4 : START_SPARKS, reduced);
            if (reduced) pop(anim, 0.13);
            else {
              anim.goT = GO_DUR;
              anim.hop.impulse(1.9);
            }
            break;
          case "jump":
            if (reduced) pop(anim, 0.12);
            else anim.squash.impulse(LAUNCH_IMPULSE);
            break;
          case "land":
            if (reduced) pop(anim, -0.1);
            else
              anim.squash.impulse(
                -Math.min(LAND_IMPULSE_MAX, Math.abs(event.impact) * LAND_IMPULSE_SCALE)
              );
            break;
          case "collect": {
            const it = engine.items[event.slot];
            burst(sparkles, it.x, it.y, it.z, reduced ? 5 : COLLECT_SPARKS, reduced);
            if (reduced) pop(anim, 0.12);
            else {
              anim.squash.impulse(COLLECT_STRETCH);
              anim.hop.impulse(COLLECT_HOP);
            }
            break;
          }
          case "stumble": {
            if (reduced) {
              // Playful, never punitive: the same "oops" read, without the tumble.
              pop(anim, -0.14);
              break;
            }
            anim.lurch.impulse(STUMBLE_LURCH);
            anim.wobble.impulse(event.slot % 2 === 0 ? STUMBLE_WOBBLE : -STUMBLE_WOBBLE);
            anim.squash.impulse(STUMBLE_SQUASH);
            anim.hop.impulse(STUMBLE_HOP);
            shake.rig.shake(STUMBLE_SHAKE);
            break;
          }
          case "complete":
            burst(sparkles, 0, TOOTH_CENTER_Y + 0.7, 0, reduced ? 6 : FINISH_SPARKS, reduced);
            if (reduced) pop(anim, 0.14);
            else {
              anim.hop.impulse(2.91);
              anim.squash.impulse(-4.2);
            }
            break;
          default:
            break;
        }
      }),
    [engine, anim, sparkles, shake]
  );

  /* ---------------- the frame ---------------- */

  useFrame((state, delta) => {
    const world = worldRef.current;
    const heroNode = heroRef.current;
    const body = bodyRef.current;
    const lean = leanRef.current;
    const blob = blobRef.current;
    if (!world || !heroNode || !body || !lean || !blob) return;

    const dt = safeDelta(delta);
    const reduced = isReduced();
    const elapsed = state.clock.elapsedTime;

    engine.update(dt);
    const speed = engine.speed;
    const travel = speed * dt;

    /*
     * The finale sweep.
     *
     * When the clock expires the world coasts asymptotically to a stop, so without this the
     * celebration's composition is whatever happened to be passing the lens at that instant
     * — round 2 froze on a gateway filling the bottom 60% of the frame as a featureless slab.
     * Across the 0.3 s of `FINISH_DELAY` every near-band prop inside the camera's near
     * volume sinks into the lane (the same ground-anchored taper this world already uses at
     * the ends of every recycling window), so the frame the celebration arms on is
     * deterministic: nothing nearer than the gate pool's `clearZ`, every single run.
     */
    anim.finale = engine.ending
      ? anim.finale + dt / FINISH_DELAY > 1
        ? 1
        : anim.finale + dt / FINISH_DELAY
      : 0;
    // easeOutCubic on the *removal*: most of the travel happens immediately, so the prop is
    // out of the way well inside the window and the last sliver leaves gently.
    const sweep = anim.finale > 0 ? easeOutCubic(anim.finale) : 0;

    _blobCount = 0;

    /* -------- scenery pools -------- */

    for (let s = 0; s < scatters.length; s++) {
      const def = scatters[s];
      // Reduced motion: each pool's own declared rate, which is never above its normal one —
      // see `layout.ts::RATE_MID_REDUCED`. The near band keeps rate 1 because the hero's gait
      // and every item are locked to it; the mid band drops to 0.12 and the ridge freezes.
      const rate = reduced ? def.reducedRate : def.rate;
      let off = offsets[s] + travel * rate;
      if (off >= def.span) off %= def.span;
      offsets[s] = off;

      const refs = scatterRefs[s];
      const parts = def.parts;
      for (let i = 0; i < def.n; i++) {
        let local = i * def.pitch + off;
        if (local >= def.span) local -= def.span;
        const z = def.z0 + local;

        // Taper at the ends of the window so a recycled instance grows out of the fog
        // rather than popping into it.
        let f = 1;
        if (def.fadeFar > 0) {
          const a = local / def.fadeFar;
          if (a < f) f = a;
        }
        if (def.fadeNear > 0) {
          const b = (def.span - local) / def.fadeNear;
          if (b < f) f = b;
        }
        if (f < 0) f = 0;
        else if (f > 1) f = 1;

        // Finale sweep: smooth in z as well as in time, so a prop drifting across the
        // threshold while the world coasts can never pop.
        if (sweep > 0 && def.clearZ < Infinity) {
          const near = (z - def.clearZ) / def.clearFade;
          if (near > 0) f *= 1 - sweep * (near > 1 ? 1 : near);
        }

        _euler.set(def.tilt[i], def.yaw[i], 0);
        _quat.setFromEuler(_euler);
        // Anchored to the floor as it tapers, so a fading prop sinks into the ground
        // instead of shrinking toward its own middle and floating.
        _pos.set(def.x[i], GROUND_Y + (def.y[i] - GROUND_Y) * f, z);
        _scl.set(def.sx[i] * f, def.sy[i] * f, def.sz[i] * f);
        _prop.compose(_pos, _quat, _scl);

        for (let p = 0; p < parts.length; p++) {
          const mesh = refs[p].current;
          if (!mesh) continue;
          _part.multiplyMatrices(_prop, parts[p].offset);
          mesh.setMatrixAt(i, _part);
        }

        if (def.foot > 0) {
          const footX = def.foot * def.sx[i] * f;
          const footZ = def.foot * def.sz[i] * f;
          const lift = def.lift * def.sy[i] * f;
          const at = def.blobAt;
          for (let b = 0; b < at.length; b++) {
            writeBlob(blob, def.x[i] + at[b] * def.sx[i], GROUND_Y + 0.008, z, footX, footZ, lift);
          }
        }
      }

      for (let p = 0; p < refs.length; p++) {
        const mesh = refs[p].current;
        if (mesh) mesh.instanceMatrix.needsUpdate = true;
      }
    }

    /* -------- items -------- */

    _kindCount.fill(0);
    const items = engine.items;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.state === ITEM_DEAD) continue;
      const k = it.kind;
      const slot = _kindCount[k];
      _kindCount[k] = slot + 1;

      let scale = 1;
      let y = it.y;
      if (it.state === ITEM_TAKEN) {
        const p = clamp01(it.t / it.dur);
        // POP: a hard overshoot on the way out, so a grabbed brush reads as *taken*, not
        // as faded. Starts at exactly 1 so nothing jumps on the frame it is collected.
        scale = reduced
          ? 1 - easeOutCubic(p)
          : (1 + 0.55 * Math.sin(clamp01(p * 2) * Math.PI)) *
            (1 - easeInCubic(clamp01((p - 0.35) / 0.65)));
      } else if (it.state === ITEM_BUMPED) {
        const p = clamp01(it.t / it.dur);
        scale = reduced ? 1 - easeOutCubic(p) : 1 - easeInCubic(clamp01((p - 0.45) / 0.55));
      } else {
        // Arriving: an item grows into the world across its first two units of travel, so
        // the spawn line — which is in plain view — never shows something appearing.
        const born = clamp01((it.z - SPAWN_Z) / SPAWN_GROW);
        if (born < 1) scale = reduced ? easeOutCubic(born) : easeOutBack(born, 1.6);
        if (it.high && !reduced) y += Math.sin(elapsed * 2.2 + it.seed) * 0.05;
      }

      /*
       * Leaving — the same ground-anchored taper the scenery pools use at the ends of their
       * windows, and the answer to round 3's "items pass between the lens and the hero and
       * occlude the landing for five frames".
       *
       * An item is untouched until `ITEM_CLEAR_Z`, which is past `HIT_Z` and therefore past
       * anything it could still do, and has sunk into the lane by `+ ITEM_CLEAR_SPAN`. The
       * y multiply is what makes it *sink* rather than shrink toward its own middle and
       * float: the lane's surface is y = 0 in this game, so scaling y is scaling toward the
       * ground. See `layout.ts::ITEM_CLEAR_Z` for the projection this is sized from.
       */
      if (it.state === ITEM_LIVE && it.z > ITEM_CLEAR_Z) {
        // `easeOutCubic` on the *removal*, as the scenery pools do: most of the shrink
        // happens in the first third of the taper, so the item is out of the way long before
        // it could reach the hero's screen box, and the last sliver leaves gently.
        const keep = 1 - easeOutCubic(clamp01((it.z - ITEM_CLEAR_Z) / ITEM_CLEAR_SPAN));
        scale *= keep;
        y *= keep;
      }

      _quat.setFromAxisAngle(kinds[k].axis, it.spin);
      _pos.set(it.x, y, it.z);
      _scl.set(scale, scale, scale);
      _prop.compose(_pos, _quat, _scl);

      const refs = itemRefs[k];
      const parts = kinds[k].parts;
      for (let p = 0; p < parts.length; p++) {
        const mesh = refs[p].current;
        if (!mesh) continue;
        _part.multiplyMatrices(_prop, parts[p].offset);
        mesh.setMatrixAt(slot, _part);
      }

      if (it.state === ITEM_LIVE && !it.high) {
        writeBlob(blob, it.x, 0.008, it.z, ITEM_FOOT * scale, ITEM_FOOT * scale, ITEM_LIFT * scale);
      }
    }

    for (let k = 0; k < itemRefs.length; k++) {
      const refs = itemRefs[k];
      const count = _kindCount[k];
      for (let p = 0; p < refs.length; p++) {
        const mesh = refs[p].current;
        if (!mesh) continue;
        mesh.count = count;
        mesh.instanceMatrix.needsUpdate = true;
      }
    }

    /* -------- the runner -------- */

    /*
     * The run cycle. One footfall every π of `stride`, at `speed / STRIDE` steps a second —
     * the same ground speed that used to be spent spinning the tooth end over end, now spent
     * on a gait. Both feet on the ground at π/2 and 3π/2 is not what a run does, so the two
     * feet are driven a half-cycle apart and the body rides `|sin|` between them.
     *
     * Airborne, the cycle fades out over the first third of a unit of jump height and the
     * feet tuck: a character pedalling in mid-air is the classic tell of a gait bolted onto
     * a jump rather than blended with it.
     */
    const grounded = 1 - clamp01(engine.toothY / AIRBORNE_FADE);
    // Reduced motion keeps the gait — at `REDUCED_GAIT` amplitude, and at full *cadence*,
    // because the lane under the feet has not slowed and a stride that no longer matches the
    // ground it is on is foot-slip. Only the amplitude comes down (RU7).
    const running = reduced ? grounded * REDUCED_GAIT : grounded;
    anim.stride += (speed / STRIDE) * Math.PI * dt;
    // Kept bounded so the phase cannot lose precision across a long session.
    if (anim.stride > TWO_PI) anim.stride -= TWO_PI;
    const strideS = Math.sin(anim.stride);
    const strideC = Math.cos(anim.stride);
    const airborne = 1 - grounded;

    anim.lurch.to(0);
    anim.lurch.step(dt);

    // Lean into acceleration. The estimate is damped, so the one-frame speed cliff a candy
    // produces becomes a readable backward lean rather than a single-frame flick.
    const rawAccel = dt > 1e-4 ? (speed - anim.prevSpeed) / dt : 0;
    anim.prevSpeed = speed;
    anim.accel = damp(anim.accel, rawAccel, 12, dt);
    const leanTarget = anim.accel * -0.028;
    anim.lean = damp(anim.lean, leanTarget < -0.3 ? -0.3 : leanTarget > 0.3 ? 0.3 : leanTarget, 10, dt);

    anim.squash.to(0);
    anim.wobble.to(0);
    anim.hop.to(0);
    anim.squash.step(dt);
    anim.wobble.step(dt);
    anim.hop.step(dt);

    let popAmount = 0;
    if (anim.popT > 0) {
      anim.popT -= dt;
      popAmount = anim.popAmp * Math.sin(clamp01(1 - anim.popT / anim.popDur) * Math.PI);
    }

    /*
     * The starting leap.
     *
     * `anticipate()` runs 0 -> 1 with a dip in the first 28%; subtracting the linear ramp
     * leaves a pulse that is *negative* through the wind-up and *positive* through the
     * overshoot, and is exactly zero at both ends — so nothing jumps when it expires.
     *
     * The two halves are spent on different things, which matters: the wind-up is a
     * compression into the lane (a translation would put the tooth *through* the lane), the
     * overshoot is real height. The dip bottoms out 59 ms in, inside §4's 50–80 ms window.
     */
    let goLift = 0;
    let goSquash = 0;
    if (anim.goT > 0) {
      anim.goT -= dt;
      const p = clamp01(1 - anim.goT / GO_DUR);
      const dev = anticipate(p, 0.5) - p;
      if (dev > 0) goLift = GO_LIFT * dev;
      else goSquash = GO_SQUASH * dev;
    }

    let squashOut = anim.squash.value + popAmount + goSquash;
    // Weight on each footfall: hardest at contact, gone by the top of the bounce.
    if (running > 0) {
      const contactPhase = 1 - Math.abs(strideS);
      squashOut -= RUN_SQUASH * running * contactPhase * contactPhase;
    }
    // Anticipation: the tooth presses into the lane before it leaves it.
    if (engine.crouch > 0) squashOut -= CROUCH_SQUASH * engine.crouch;
    if (!engine.grounded) {
      // Hang: stretched along the arc at the top, round again as it picks up speed.
      const hang = 1 - Math.min(1, Math.abs(engine.toothVy) / JUMP_V);
      squashOut += AIR_STRETCH * (reduced ? 0.45 : 1) * hang;
    }
    squashFor(_squash, squashOut, 1, 0.32);
    /*
     * The hand-off — the shared one, `store.ts::celebrationHeroScale`.
     *
     * `GameShell`'s celebration draws its *own* mascot hero, in its own view, over the top of
     * this scene — which is still rendering. Leave the runner standing and the celebration
     * frame has two teeth in it. The runner takes its bow first: the `complete` event fires a
     * FINISH_DELAY before the shell flips `completed`, and it has already kicked a hop, a
     * squash and a sparkle burst. Then the shared window opens and pops it out, arriving at
     * exactly zero before the celebration's own mascot exists. This used to be a private
     * `anim.finale > 0.5` ramp; the curve is identical and the clock is now everyone's.
     */
    const exit = celebrationHeroScale();
    // The squash pivots on the lane, not on the tooth's middle, so a landing flattens the
    // crown down onto planted feet instead of lifting the feet off the ground.
    body.scale.set(_squash.x * exit, _squash.y * exit, _squash.z * exit);
    body.rotation.z = anim.wobble.value;

    const bob = running > 0 ? RUN_BOB * running * Math.abs(strideS) : 0;
    let ty = engine.toothY + anim.hop.value + bob + goLift;
    if (!reduced && !engine.started) ty += Math.sin(elapsed * 1.7) * 0.018;
    heroNode.position.y = ty;

    lean.rotation.x = anim.lean + anim.lurch.value + RUN_ROCK * running * strideC;

    /*
     * Feet and arms — a real two-beat gait, not two legs waving.
     *
     * Contacts are at `stride = 0` and `π`, which is where `|sin|` (the bounce) is zero. At
     * a contact one foot must be *forward and planted* and the other *back and about to
     * leave*, so the fore-aft swing is `cos` — a quarter cycle out of phase with the bounce
     * — and a foot only leaves the lane while it is travelling forwards, which is the half
     * of the cycle where the swing's derivative is positive. Get that phase wrong and the
     * character pedals: both feet down together, both up together.
     */
    const stepL = strideC;
    const stepR = -strideC;
    const liftL = strideS < 0 ? -strideS : 0;
    const liftR = strideS > 0 ? strideS : 0;
    const footL = limbs.footL.ref.current;
    if (footL) {
      footL.position.z = limbs.footL.z + RUN_STEP_Z * running * stepL;
      footL.position.y = limbs.footL.y + RUN_STEP_LIFT * running * liftL + 0.05 * airborne;
    }
    const footR = limbs.footR.ref.current;
    if (footR) {
      footR.position.z = limbs.footR.z + RUN_STEP_Z * running * stepR;
      footR.position.y = limbs.footR.y + RUN_STEP_LIFT * running * liftR + 0.05 * airborne;
    }
    // Arms swing against the *opposite* leg, and reach forward on a jump.
    const armL = limbs.armL.current;
    if (armL) armL.rotation.x = ARM_SWING * running * stepR + 0.35 * airborne;
    const armR = limbs.armR.current;
    if (armR) armR.rotation.x = ARM_SWING * running * stepL + 0.35 * airborne;

    /*
     * Close contact under the tooth, and the hand-off to the real cast shadow.
     *
     * This used to fade over 0.85 units of jump height — i.e. it was still drawing at the
     * apex, on top of the PCSS penumbra, which is exactly A3's *"a big decal sits on top of
     * the solve and hides it"*. `contactOpacityFor` is the shared curve and it is the one the
     * whole product now hands over on: full at contact, zero by `CONTACT_FADE_LIFT` (0.05 u,
     * one shadow-map texel of gap at the low tier's 512 map over `SHADOW_AREA` 14). Past that
     * the map is the whole shadow, and the map is live all the way to the apex — the tooth at
     * `JUMP_APEX` is 1.356 u up the light's table, a shade under the sampling clamp.
     *
     * The instance pool shares one material, so the fade lands on the quad's **area** rather
     * than on its alpha; over a 0.05-unit window the physical radius growth it displaces is
     * 0.005 u, which is 1 px. At `JUMP_V` the tooth crosses that window in 8.5 ms — half a
     * frame — so the hand-off is one frame long and it happens on the frame the launch squash
     * fires, which is where the eye already is.
     *
     * `bob` is deliberately *not* in the fade term. It is a stylised bounce of the body between
     * footfalls, and the blob stands in for the planted foot, whose own clearance is zero at
     * every contact (`|sin|` is zero there). It scales the blob instead, which is the gait
     * breathing rather than a hand-off. Feeding it to the fade would strobe a 155 px decal on
     * and off at up to 4.8 Hz.
     */
    const gapFade = contactOpacityFor(1, engine.toothY);
    const bounce = 1 - 0.35 * clamp01(bob / RUN_BOB);
    const heroFoot = HERO_FOOT * gapFade * bounce * exit;
    writeBlob(blob, 0, 0.01, 0, heroFoot, heroFoot, engine.toothY + bob);

    blob.count = _blobCount;
    blob.instanceMatrix.needsUpdate = true;

    /* -------- the world group: the only thing standing in for a camera move -------- */

    if (reduced) {
      anim.followY = 0;
      world.position.set(0, 0, 0);
    } else {
      // An authored, damped framing follow — not a shake and not a breathe. It trails the
      // jump by at most 0.11 units and has no impulse path, so it cannot ring.
      anim.followY = damp(anim.followY, -engine.toothY * 0.11, 7, dt);
      world.position.set(0, anim.followY, 0);
      /*
       * The stumble nudge, applied *after* `Scene3D`'s own rig has written this camera (that
       * rig runs at priority 0 and this scene is mounted below it, so it is always first).
       * `CameraRig` saturates the amplitude, decays it and moves position and aim by the same
       * vector; reduced motion never reaches this branch at all.
       */
      shake.rig.update(dt, elapsed);
      const cam = state.camera;
      cam.position.x += shake.proxy.position.x;
      cam.position.y += shake.proxy.position.y;
      cam.position.z += shake.proxy.position.z;
    }

    const spark = sparkRef.current;
    if (spark) {
      stepSparkles(sparkles, spark, state.camera.quaternion, dt, travel, reduced);
      // The pool is idle for most of a run. `stepSparkles` collapses a dead instance's matrix
      // to zero scale, so it rasterises nothing — but three still submits the instanced draw
      // and its vertex work. Publishing the live count skips the call outright.
      spark.count = sparkles.live > 0 ? SPARKLES : 0;
    }
  });

  /* ---------------- graph ---------------- */

  return (
    <Rig
      groundY={GROUND_Y}
      groundSize={GROUND_SIZE}
      shadowArea={SHADOW_AREA}
      fogDensity={FOG_DENSITY}
    >
      <group ref={worldRef}>
        <mesh
          geometry={laneGeo}
          material={laneMat}
          position-y={-LANE_T / 2}
          position-z={LANE_CENTER_Z}
          receiveShadow
        />

        {scatters.map((def, s) =>
          def.parts.map((p, i) => (
            <instancedMesh
              key={`${def.key}-${i}`}
              ref={scatterRefs[s][i]}
              args={[p.geometry, p.material, def.n]}
              frustumCulled={false}
              castShadow={p.castShadow}
              receiveShadow={p.receiveShadow}
            />
          ))
        )}

        {kinds.map((kind, k) =>
          kind.parts.map((p, i) => (
            <instancedMesh
              key={`item-${k}-${i}`}
              ref={itemRefs[k][i]}
              args={[p.geometry, p.material, MAX_ITEMS]}
              frustumCulled={false}
              castShadow={p.castShadow}
              receiveShadow={p.receiveShadow}
            />
          ))
        )}

        {/*
          The runner, as four nested nodes, each of which owns exactly one transform:

            heroRef   world height — the jump arc, the run bounce, the starting leap.
            bodyRef   squash & stretch, and the sideways wobble. Its origin is on the lane,
                      so a landing squash flattens the crown *down* onto planted feet; put
                      the pivot at the tooth's middle instead and the feet leave the ground
                      every time it lands.
            leanRef   pitch — acceleration lean, stumble lurch and the run's fore-aft rock,
                      about the hips rather than about the feet or the crown.
            (inner)   the mascot's own yaw. The face lives here and *never* rotates with the
                      gait, so it is readable on every frame of every run.
        */}
        <group ref={heroRef}>
          <group ref={bodyRef}>
            <group ref={leanRef} position-y={LEAN_PIVOT}>
              <group position-y={-LEAN_PIVOT} rotation-y={HERO_YAW}>
                {hero.map((p) => (
                  <mesh
                    key={p.key}
                    ref={partRef[p.key]}
                    geometry={p.geometry}
                    material={p.material}
                    position={p.position}
                    rotation={p.rotation}
                    scale={p.scale}
                    castShadow={p.castShadow}
                  />
                ))}
              </group>
            </group>
          </group>
        </group>

        <instancedMesh
          ref={blobRef}
          args={[quadGeo, blobMat, MAX_BLOBS]}
          frustumCulled={false}
          renderOrder={2}
        />
        <instancedMesh
          ref={sparkRef}
          args={[quadGeo, sparkleMat, SPARKLES]}
          frustumCulled={false}
          renderOrder={6}
        />
      </group>
    </Rig>
  );
}

/**
 * Writes one contact blob into the shared buffer. Allocation-free; bounded by `MAX_BLOBS`.
 *
 * `footX`/`footZ` are the prop's own silhouette semi-axes **on the floor** and `lift` is the
 * height of the mass the blob stands in for; everything else is derived here so no caller
 * has to guess a multiple again:
 *
 *   slide  = SHADOW_SLIDE · lift      — how far the real cast shadow moves off the contact
 *   centre = contact + slide / 2      — the swept silhouette's midpoint
 *   reach  = foot + |slide| / 2 + penumbra, via `Rig::contactRadiusFor`
 *
 * The quad is axis-aligned, so this is the swept ellipse's bounding ellipse rather than the
 * ellipse itself — a round decal cannot be a capsule. It is an honest over-estimate: the
 * profile's own falloff reaches zero value *and* zero slope at the quad edge, so the extra
 * reach costs a slightly longer skirt and never an edge.
 */
function writeBlob(
  mesh: InstancedMesh,
  x: number,
  y: number,
  z: number,
  footX: number,
  footZ: number,
  lift: number
): void {
  if (_blobCount >= MAX_BLOBS || footX <= 1e-4 || footZ <= 1e-4) return;
  const slideX = SHADOW_SLIDE_X * lift;
  const slideZ = SHADOW_SLIDE_Z * lift;
  const half = 0.5 * Math.sqrt(slideX * slideX + slideZ * slideZ);
  const rx = contactRadiusFor(footX + half, lift);
  const rz = contactRadiusFor(footZ + half, lift);
  _pos.set(x + slideX * 0.5, y, z + slideZ * 0.5);
  _scl.set(rx * 2, rz * 2, 1);
  _blob.compose(_pos, BLOB_QUAT, _scl);
  mesh.setMatrixAt(_blobCount, _blob);
  _blobCount += 1;
}

/**
 * Memoised on `engine`, which never changes identity — so the shell re-rendering its clock
 * every second, or its score on every pickup, does not touch the 3D tree at all.
 */
export const ToothRunnerScene = memo(ToothRunnerSceneImpl);
