/**
 * Count the Teeth — the 3D board.
 *
 * Wiring, following the pattern Tooth Match set:
 *
 *  • One prop, the engine, whose identity never changes. Nothing about a tooth's animation
 *    ever travels through React.
 *  • The component subscribes to the engine once and mutates plain structs from that
 *    callback. It re-renders on three events — `round`, `complete` and a re-framing — because
 *    those are the only ones that change what is mounted.
 *  • `useFrame` reads those structs, writes `Object3D` transforms and composes instance
 *    matrices through module-level scratch. It allocates nothing: no `new`, no literals,
 *    no closures, no `map`. **It does no GPU readbacks and no layout solving** — round 1 ran
 *    up to twenty synchronous `readRenderTargetPixels` calls inside the frame on every round.
 *  • Fourteen teeth are one `InstancedMesh`; their eyes, catchlights, cheeks and mouths are
 *    four more; contact shadows, answer tiles, label plates and round pips are five more. The
 *    whole board is about twenty draw calls.
 *
 * **The counted props are the product's mascot, not bare teeth, and not a local copy of one.**
 * Round 1 shipped `toothGeometry("baby")` with nothing on it, and from this near-top-down
 * camera fourteen of them read as mushrooms. Round 3 shipped a face this file assembled
 * itself from the raw anchor table, and got the scaling wrong in a way that buried both eye
 * catchlights inside their own pupils — fourteen matte-black-eyed **skulls**, which is worse.
 * `face.ts` now derives every feature from `mascotParts()`, the one call the celebration hero
 * and Healthy or Not? make, so a child meets one character across the whole product and there
 * is one implementation of it. Fourteen full `mascotParts()` groups would be 182 draw calls,
 * so what stays local is only the submission: one instanced mesh per feature, `MAX_COUNT`
 * (or twice that, for the paired ones) instances, each composed as `bodyMatrix x local`.
 *
 * Motion (3D-SPEC §4). Teeth arrive one at a time on `easeOutBack(1.9)` from 2 cm above
 * the pad, each landing with a squash impulse and a small `sounds.pop()`. That stagger is
 * the game's rhythm and a second, audible way to count, so it survives reduced motion
 * (which stops the movement, not the sound) and it replays on a wrong answer. It is *not*
 * the accessible path on its own — audio ships muted (S24) — so the scene also speaks the
 * arrangement, row by row, through `describeArrangement`. See the announcement block below. A correct answer sends a hop wave through the
 * teeth with `HOP_STAGGER` between neighbours. A wrong answer wobbles the tile the child
 * touched on an underdamped spring and re-deals the count audibly: no red, no buzzer, no
 * penalty, and the same tiles stay live so they can simply try again. Pressing a tile sinks
 * it on a snappy spring and releasing kicks it back past rest — never `linear`, never
 * `ease-in-out`.
 *
 * Reduced motion: the teeth appear together over `FEEL.reducedFade` on a non-overshooting
 * grow (they are opaque clay, so a real alpha fade would mean a transparent variant of a
 * shared material and the blend/sort cost that comes with it — the short grow is the
 * honest equivalent), there is no drop, no hop wave, no idle breath, no wobble and no
 * sparkle velocity. Presses still travel, because a control that does not move is not a
 * control. The camera is already static under `Scene3D`'s `CameraRig`.
 *
 * The counting guarantee lives entirely in `layout.ts` now, as an exact screen-space proof
 * that runs off the render frame; `verify.ts` keeps the GPU measurement as `?selftest=count`.
 *
 * Two numbers in `layout.ts` are measurements of geometry it cannot import — the mascot's
 * swept silhouette and `clayTray`'s well floor — and this file is where they are checked
 * against the geometry that was actually built. Both checks `console.error` on a drift, which
 * is a gating condition against a release, so both are compared like with like: round 3's
 * guard was not, and it failed on every mount of the shipping build for four months of audit.
 */
import {
  createRef,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useFrame, useThree } from "@react-three/fiber";
import {
  AdditiveBlending,
  Color,
  DynamicDrawUsage,
  Euler,
  LinearSRGBColorSpace,
  SRGBColorSpace,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Quaternion,
  Vector3,
  type Group,
  type InstancedMesh,
  type MeshPhysicalMaterial,
  type Object3D,
} from "three";

import { sounds } from "../../shared/audio";
import {
  FEEL,
  Spring,
  clamp01,
  easeOutBack,
  easeOutCubic,
  safeDelta,
  squashFor,
} from "../../three/anim";
import { DisposalBag } from "../../three/dispose";
import {
  cachedGeometry,
  roundedCylinder,
  roundedPlate,
} from "../../three/geometry";
import { HitTarget, announce, useFocusGroup } from "../../three/hit";
import {
  clay,
  clayAccent,
  clayIvory,
  clayPainted,
  shadowBlobMaterial,
} from "../../three/materials";
import { Rig, contactRadiusFor } from "../../three/Rig";
import { celebrationHeroScale, FLAGS, isReduced } from "../../three/store";
import { sparkleTexture } from "../../three/textures";
import { ensureManrope, textTexture } from "../../three/text";
import { ACCENTS, CLAY } from "../../three/tokens";
import { CHOICES, RANGE, ROUNDS, type CountEngine } from "./engine";
import { countedMascotGeometry, countedMascotMaterial, mascotCloud } from "./face";
import { answerTileGeometry, dressedTrayGeometry } from "./merge";
import {
  ACCENT,
  GLYPH_DY,
  GLYPH_H,
  GROUND_LIFT,
  IDLE_BOB,
  IDLE_SWAY,
  MAT_FLOOR,
  MAT_FLOOR_TOLERANCE,
  MAT_RIM,
  MAX_COUNT,
  PAD_CORNER,
  PAD_T,
  PAD_TOP,
  PAD_Y,
  PIP_COUNT,
  PIP_FILL_H,
  PIP_FILL_R,
  PIP_H,
  PIP_R,
  PIP_Y,
  TILE_D,
  TILE_SINK,
  TILE_T,
  TILE_W,
  TILE_Y,
  TOOTH_SILHOUETTE,
  TOOTH_Y,
  auditScatter,
  checkSilhouette,
  createScatter,
  describeArrangement,
  pipX,
  scatterMetrics,
  solveScatter,
  sweepSilhouette,
  tileX,
  toothScale,
  type CameraFraming,
  type Scatter,
} from "./layout";

/* ------------------------------------------------------------------ */
/* Tuning                                                              */
/* ------------------------------------------------------------------ */

/**
 * Seconds between two teeth arriving.
 *
 * This is not decoration and it is not a taste call: `sounds.pop()` fires once per tooth on
 * this clock, so the deal is countable by ear as well as by eye. 0.19 s is 5.3 taps a
 * second, slow enough to count and quick enough that fourteen teeth deal in 2.7 s. Round 1
 * shipped 0.07, which is 14 a second — a rattle, not a count.
 *
 * The taps are a *second* channel, not the accessible one. `describeArrangement` is the
 * accessible one, because audio is muted until somebody asks for it (S24) and a child using
 * a screen reader should not have to find the speaker button before the game is playable.
 */
const SPAWN_STAGGER = 0.19;
const SPAWN_DUR = 0.34;
/** How far above the pad a tooth starts its arrival. */
const SPAWN_DROP = 0.2;
/**
 * Kicked when a tooth lands; peak squash is about a tenth of its height.
 *
 * Re-scaled with the springs below (B7.8), not re-tuned: `Spring(380, 19)` reaches
 * **−0.0977** on −3.7 where `Spring(380, 17)` reached −0.0953 on −3.4. Every impulse in this
 * file was re-solved the same way, so the motion a child sees is the motion round 3 shipped
 * and only the damping — which §4 fixes, and which five of these seven springs were under —
 * has moved.
 */
const LAND_IMPULSE = -3.7;

const HOP_STAGGER = 0.06;
/** `Spring(300, 19)` peaks at +0.1207 on 4.3, against +0.1208 on the old (240, 12) at 3.2. */
const HOP_IMPULSE = 4.3;
/** −0.1215 of squash at peak, against −0.1177 before. */
const HOP_SQUASH = -4.6;

/** Reduced-motion stand-in for any impulse: a short, non-overshooting scale pulse. */
const PULSE_DUR = FEEL.reducedFade;
const PULSE_TOOTH = -0.13;
const PULSE_TILE = -0.1;

/** `Spring(300, 20)` peaks at +0.1444 on 5.3, against +0.1434 on the old (300, 15) at 4.5. */
const TILE_LIFT_IMPULSE = 5.3;
/**
 * `Spring(320, 18)` peaks at +0.2166 on 7.6, against +0.2157 on the old (320, 8) at 5.4.
 *
 * §4's damping floor of 18 is the one place this file loses something it wanted: at damping 8
 * the wobble rang back through −0.104 and settled over 1.19 s, and at 18 it rings back
 * through −0.033 and settles in 0.53 s. The first swing — which is the comic beat, and the
 * one a four-year-old reads — is preserved exactly; the tail is shorter. That is the right
 * side of the trade to be on for a control a child is about to press again.
 */
const TILE_WOBBLE_IMPULSE = 7.6;
/** Radians of twist per unit of wobble spring. 5 degrees at the peak: comic, not violent. */
const TILE_WOBBLE_TWIST = 0.42;
const TILE_PRESS_TAP = -1.7;

/**
 * Anticipation, then exit. A negative impulse on the retract spring lifts the answer row a
 * few millimetres before it drops away, so the tiles leave the way a puppeteer would take
 * them off rather than by being switched off. §3.7 G-CT-5: round 1 left three live-looking
 * answer tiles sitting under the celebration card.
 */
const RETIRE_ANTICIPATE = -2.4;
const RETIRE_DROP = 0.62;

const SPARKLES = 20;
/**
 * One instanced quad per possible tooth, one per answer tile, one for the tray — everything
 * in this scene that touches the ground is grounded by a single draw call.
 *
 * The tray's used to be a `<ContactBlob>`, which takes a *scalar* radius: under a board that
 * runs 3.6 x 6.7 on a phone's Hard and 6.5 x 4.2 on a laptop's, one radius either fails to
 * reach the long edge or throws a pool half the board's length out over the cream page. An
 * instance can be scaled per axis, so it is an ellipse fitted to the board it belongs to.
 */
const BLOB_SLOTS = MAX_COUNT + CHOICES + 1;
const TILE_BLOB = MAX_COUNT;
const MAT_BLOB = MAX_COUNT + CHOICES;
/**
 * Lift at which the contact pool has drawn back completely.
 *
 * It is a *contact* darkening: it stands in for the near-black pinch the 1024² shadow map
 * cannot resolve where a prop meets the floor, and that pinch genuinely stops existing once
 * the prop leaves. So the pool collapses as a tooth rises and the shadow map takes over.
 *
 * 0.12 rather than 0.22, because the term it has to make visible is the smallest one: the
 * idle bob is ±0.022, which against 0.22 moved the pool by 2.1 % and against 0.12 moves it by
 * 3.9 % — 2.1 px at the desktop framing's 140 px per world unit, i.e. actually visible. It
 * also means the hop (0.121 at peak) and the spawn drop (0.2) take the pool to nothing, which
 * is what a tooth in the air should have.
 */
const BLOB_FADE = 0.12;

/**
 * Contact-blob size — solved from the profile, not multiplied by eye.
 *
 * The old `BLOB_SPREAD = 1.6` was a hand-set multiple of the *whole prop's* footprint, and
 * both halves of it were wrong. The multiple's own comment claimed "at 1.6 the silhouette
 * edge sits where the ramp is still at 0.84 of full"; evaluated on the profile that actually
 * ships (`textures.ts::contactBlobAlpha`, softness 0.42, a strictly decreasing two-lobe
 * Wyvill falloff since A7) the edge sits at **0.126**, so five sixths of the quad was
 * carrying almost no darkness at all. And "footprint" meant `TOOTH_SILHOUETTE.footHalf`,
 * which is the prop's reach at its *crown* — 0.8 of a height up in the air. The pool under
 * every tooth was **1.114 world units** across, where the tooth touches the pad over 0.351.
 *
 * `Rig.tsx::contactRadiusFor` is shared code's answer to "how big is this blob, actually":
 * it divides the reach the caller wants darkened by `CONTACT_BLOB_VISIBLE_FRACTION` (0.827,
 * solved from the profile as the radius past which the alpha can no longer move an 8-bit
 * output byte) and widens it by `SHADOW_SOFTNESS x lift`. Feed it `rootHalf` — the reach of
 * the part of the prop that is actually near the pad — and the quad comes out at **0.396**
 * across for a tooth at rest (0.424 at the largest size variation): **2.8x smaller**, and
 * dark all the way to its edge instead of over a sixth of it.
 *
 * `PlaneGeometry(1, 1)` scaled by `r` is `r` *wide*, so the scale is twice the radius.
 */
const blobQuadFor = (contact: number, lift: number): number =>
  2 * contactRadiusFor(contact, lift);

/**
 * How far the coral sheet reaches under the tray's fillet, so its own rim is never seen.
 *
 * The fillet is 0.0384 wide on this tray (measured), so 0.03 puts the plate's edge four
 * fifths of the way into it and still leaves the fillet's own curve above coral rather than
 * above the plate's bevel.
 */
const PAD_TUCK = 0.03;

/** Same idea for the answer tiles, whose blob was inside the tile for the same reason. */
const TILE_BLOB_SPREAD_W = 1.75;
const TILE_BLOB_SPREAD_D = 1.9;

/**
 * Per-channel white balance for the coral field, in linear space — the same treatment
 * `materials.ts::GROUND_WHITE_BALANCE` gives the floor, and for the same reason: this
 * surface has a *measurable* contract and the studio illuminant is warm by design.
 *
 * ## What it has to satisfy
 *
 * `3D-SPEC §8`: the things a child is asked to count must clear **3:1** against the field
 * they are counted on. `§X2`: the room must be the hub card's accent family, and this is the
 * one surface in the product that deliberately goes saturated — ivory teeth on cream would be
 * 1.3:1 and a counting game whose objects melt into their background is a broken game.
 *
 * ## Round 4, CT4 — the old vector targeted the wrong statistic, and the tone map moved
 *
 * The round-3 comment claimed "3.20:1". Measured off `count-the-teeth-rest.png` — 6,800
 * open-coral pixels and ~2,500–4,000 crown pixels per tooth, WCAG relative luminance — that
 * figure is the **90th-percentile** crown pixel (3.25–3.26:1). The median crown pixel is
 * **3.03:1** and the shaded decile is **2.50:1**: half the character's surface sat under the
 * figure the comment quoted, and its shaded flank under the floor itself.
 *
 * Then `A16` removed `NeutralToneMapping`'s black-point offset from the shipped curve, which
 * lifts exactly the channels this surface is dark in. Inverting the shipped pixels back
 * through the old operator and pushing the recovered radiance through the new one (the
 * round-trip reproduces the shipped bytes exactly, so the inversion is sound):
 *
 *   open coral   `(212, 88, 80)` -> radiance `(0.6984, 0.1376, 0.1202)` -> **`(218, 104, 97)`**
 *   crown median `(236, 224, 204)` -> radiance `(0.9173, 0.8191, 0.6701)` -> `(238, 227, 207)`
 *
 * — the pad lifts far more than the crown does, and the median contrast falls from 3.03 to
 * **2.70:1**, under §8's floor on the surface the whole game is about. So this constant is
 * not a polish item after A16; it is a correction that has to happen.
 *
 * ## How this vector was solved
 *
 * The response of *this* material to *this* albedo was fitted at its own operating point
 * rather than borrowed from the ground: `gain = radiance / albedo` per channel, from the
 * measurement above, is `(1.044, 1.091, 0.956)`. Solving for the albedo whose radiance has
 * `coral.main`'s **exact chromaticity** at the luminance that puts the median crown at
 * 3.20:1 gives `t = 0.7963` of the token's linear radiance, hence
 *
 *   `PAD_WHITE_BALANCE = t / gain = (0.7628, 0.7297, 0.8330)`
 *
 * and a predicted render of **`(210, 86, 68)`** — chromaticity `(0.810, 0.117, 0.073)`,
 * which is `coral.main`'s to four decimals. That is strictly better than the round-3
 * compromise, which split the vector and shipped a hue 0.024 off the token in blue: under
 * the new curve the full chromaticity correction and the contrast target are no longer in
 * conflict, because both are reached by scaling the *whole* vector rather than only its
 * length.
 *
 * The shaded decile of a crown lands at **2.74:1** and is deliberately not chased: §8's floor
 * is a statement about an object against its background, and taking the tenth-percentile
 * pixel to 3:1 needs the coral 19 % darker, which costs the field its colour.
 *
 * ## Why it will not rot again
 *
 * Every number above is a projection: no pixel of it has been rendered. So `?selftest=count`
 * now **renders the live board into an offscreen target and measures the real pixels**,
 * classifying coral against crown and asserting the median at 3:1 with the margin above it
 * as headroom. If the key, the studio panels, `TONE.exposure`, the tray's depth or the tone
 * curve move again, that test fails with both figures in the message rather than a comment
 * going quietly out of date.
 */
const PAD_WHITE_BALANCE = new Color().setRGB(0.7628, 0.7297, 0.833, LinearSRGBColorSpace);

const PAD_ALBEDO = `#${new Color(ACCENTS[ACCENT].main)
  .multiply(PAD_WHITE_BALANCE)
  .getHexString(SRGBColorSpace)}`;

/**
 * The subsurface tint carries the same calibration as the albedo, and it has to.
 *
 * `clayPainted`'s `sss` lobe adds light that does *not* scale with the diffuse albedo, so
 * scaling one and not the other makes the fitted per-channel gain above wrong by whatever
 * fraction of the surface's radiance the lobe contributes — in the direction that undoes the
 * correction. The white balance is a property of this *surface*, not of one of its lobes.
 */
const PAD_SSS = `#${new Color(ACCENTS[ACCENT].soft)
  .multiply(PAD_WHITE_BALANCE)
  .getHexString(SRGBColorSpace)}`;

/**
 * One font spec for every numeral, shared by the pre-render and the per-round swap so the
 * two cannot miss each other in `text.ts`'s cache — which is keyed on the options as well as
 * on the string.
 */
const NUMERAL_FONT = {
  fontSize: 96,
  weight: 800,
  // White in the texture, brand colour on the material — so three slots cover every number
  // the game can ever show.
  color: "#ffffff",
  padding: 8,
} as const;

/**
 * Every numeral this game can ever draw: 1 through `max(RANGE) + 2`.
 *
 * `drawAnswers` clamps its candidates to `1 .. hi + 2`, so on Hard that is 1–16. Derived
 * from the rules rather than typed, and asserted against them by `?selftest=count`.
 */
const MAX_NUMERAL = RANGE[RANGE.length - 1][1] + 2;

const GROUP = "Count the Teeth answers";

/* ------------------------------------------------------------------ */
/* Per-frame scratch — module level, allocated exactly once            */
/* ------------------------------------------------------------------ */

const _pos = new Vector3();
const _scl = new Vector3();
const _quat = new Quaternion();
const _euler = new Euler();
const _mat = new Matrix4();
const _part = new Matrix4();
const _squash = { x: 1, y: 1, z: 1 };

const LAY_X = -Math.PI / 2;
const FLAT_ROT: [number, number, number] = [LAY_X, 0, 0];
const BLOB_QUAT = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), LAY_X);
/** Offset of the raised label plate along a tile's own +Y. */

const GLYPH_POS: [number, number, number] = [0, GLYPH_DY, 0];

/* ------------------------------------------------------------------ */
/* The mascot's face, as instanced features                            */
/* ------------------------------------------------------------------ */

/*
 * It used to be built here, from the raw `MASCOT_FACE` anchor table, and it was built
 * wrong — see `face.ts`, which now derives it from `mascotParts()` so there is exactly one
 * implementation of this product's mascot. Thirteen real meshes is right for one hero and
 * 182 draw calls for fourteen counted teeth; what stays local is the instancing, which is
 * the only part of it that is legitimately this game's own.
 */

/* ------------------------------------------------------------------ */
/* Animation state                                                     */
/* ------------------------------------------------------------------ */

type Anim = {
  scatter: Scatter;

  /* Teeth */
  spawnDelay: Float32Array;
  popped: Uint8Array;
  landed: Uint8Array;
  hopDelay: Float32Array;
  /** Delay until this tooth taps again on a re-count. −1 when it is not going to. */
  countDelay: Float32Array;
  seed: Float32Array;
  pulseT: Float32Array;
  hop: Spring[];
  squash: Spring[];
  roundT: number;

  /* Tiles */
  press: Spring[];
  lift: Spring[];
  wobble: Spring[];
  tilePulseT: Float32Array;
  retire: Spring;

  /* Pips */
  pip: Spring[];
  filled: number;

  /* Layout */
  dirty: boolean;
};

function createAnim(): Anim {
  const f = (n: number) => new Float32Array(n);
  const springs = (n: number, s: number, d: number) => {
    const out: Spring[] = [];
    for (let i = 0; i < n; i++) out.push(new Spring(0, s, d));
    return out;
  };
  const seed = f(MAX_COUNT);
  for (let i = 0; i < MAX_COUNT; i++) seed[i] = (i * 2.3999632297) % (Math.PI * 2);
  return {
    scatter: createScatter(),
    spawnDelay: f(MAX_COUNT),
    popped: new Uint8Array(MAX_COUNT),
    landed: new Uint8Array(MAX_COUNT),
    hopDelay: f(MAX_COUNT).fill(-1),
    countDelay: f(MAX_COUNT).fill(-1),
    seed,
    pulseT: f(MAX_COUNT),
    hop: springs(MAX_COUNT, 300, 19),
    squash: springs(MAX_COUNT, 380, 19),
    roundT: -1,
    press: springs(CHOICES, 420, 26),
    lift: springs(CHOICES, 300, 20),
    wobble: springs(CHOICES, 320, 18),
    tilePulseT: f(CHOICES),
    retire: new Spring(0, 260, 22),
    pip: springs(PIP_COUNT, 300, 19),
    filled: 0,
    dirty: true,
  };
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
    field.px[i] = x + (Math.random() - 0.5) * 0.36;
    field.py[i] = y + Math.random() * 0.14;
    field.pz[i] = z + (Math.random() - 0.5) * 0.36;
    const a = Math.random() * Math.PI * 2;
    const e = 0.3 + Math.random() * 0.9;
    const s = reduced ? 0 : 0.75 + Math.random() * 0.7;
    field.vx[i] = Math.cos(a) * Math.cos(e) * s;
    field.vy[i] = Math.sin(e) * s + (reduced ? 0 : 0.5);
    field.vz[i] = Math.sin(a) * Math.cos(e) * s;
    field.life[i] = 0;
    field.dur[i] = reduced ? 0.3 : 0.6 + Math.random() * 0.3;
    field.size[i] = 0.15 + Math.random() * 0.12;
  }
}

function resetSparkles(field: SparkleField): void {
  for (let i = 0; i < field.n; i++) if (field.dur[i] > 0) field.life[i] = field.dur[i];
}

function stepSparkles(
  field: SparkleField,
  mesh: InstancedMesh,
  camQuat: Quaternion,
  dt: number,
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
    if (!reduced) {
      field.vy[i] -= 3.2 * dt;
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
/* Speech                                                              */
/* ------------------------------------------------------------------ */

/**
 * "Choose 2, 3 or 4." — the tiles, in the order they are laid out and the order the arrow
 * keys walk them, so "the second one" means the same thing to every player.
 */
function chooseFrom(answers: readonly number[]): string {
  if (answers.length === 0) return "";
  if (answers.length === 1) return `Choose ${answers[0]}.`;
  return `Choose ${answers.slice(0, -1).join(", ")} or ${answers[answers.length - 1]}.`;
}

/* ------------------------------------------------------------------ */
/* Keyboard focus across a re-deal                                     */
/* ------------------------------------------------------------------ */

/**
 * `HitTarget` rebuilds its hidden `<button>` whenever `ariaLabel` changes, and the answer
 * tiles are literally labelled with their number — so every round destroys the element
 * that had keyboard focus and focus falls to `<body>`. A child playing on a keyboard would
 * then have to Tab back into the game five times a run.
 *
 * `useFocusGroup` keeps the *group* alive (its `count` is the constant `CHOICES`), so the
 * only thing lost is the DOM focus itself. These two helpers note which slot had it before
 * the round changed and hand it back afterwards, addressing the hidden layer by the same
 * `data-` attributes `hit.tsx` publishes for its own roving-tabindex bookkeeping.
 */
function capturedFocusOrder(): number {
  if (typeof document === "undefined") return -1;
  const el = document.activeElement as HTMLElement | null;
  const order = el?.dataset?.order;
  if (order === undefined) return -1;
  const parent = el?.parentElement as HTMLElement | null;
  if (!parent || parent.dataset.group !== GROUP) return -1;
  const n = Number(order);
  return Number.isFinite(n) ? n : -1;
}

function restoreFocusOrder(order: number): void {
  if (typeof document === "undefined" || order < 0) return;
  // Only if nothing else has taken focus in the meantime — never steal it back.
  if (document.activeElement !== null && document.activeElement !== document.body) return;
  const root = document.getElementById("lumident-a11y");
  const container = root?.querySelector<HTMLElement>(`[data-group="${GROUP}"]`);
  container?.querySelector<HTMLButtonElement>(`[data-order="${order}"]`)?.focus();
}

/* ------------------------------------------------------------------ */
/* Scene                                                               */
/* ------------------------------------------------------------------ */

export type CountSceneProps = {
  engine: CountEngine;
  /** Solved on the DOM side, where the play area's real size can be measured. */
  framing: CameraFraming;
  /** The level `framing` was solved for. Passed rather than read so the two cannot drift. */
  level: number;
};

function CountTheTeethSceneImpl({ engine, framing }: CountSceneProps): JSX.Element {
  /** Bumped by the `round` event — the only engine event that changes what the tiles say. */
  const [roundId, setRoundId] = useState(0);
  const [completed, setCompleted] = useState(false);
  const [fontReady, setFontReady] = useState(false);

  const st = useMemo(() => createAnim(), []);
  const sparkles = useMemo(() => createSparkles(SPARKLES), []);
  const bag = useMemo(() => new DisposalBag(), []);

  /* ---------------- geometry (all shared + cached) ---------------- */

  /**
   * The counted mascot as **one** geometry — body, eyes, glints, cheeks and mouth merged,
   * with each part's colour carried in the shared `aAlbedo` vertex channel.
   *
   * Round 4, CT2: the face used to be four extra `InstancedMesh`es beside the body, each one
   * allocated at `MAX_COUNT x perTooth` instances and drawn at that count whatever the board
   * held. Measured on the shipped builders at the high tier, on an Easy board of five, the
   * characters alone go from **45,060 triangles in 5 draw calls to 21,300 in 1** — the
   * triangles because the face stopped drawing fourteen mascots' worth of eyes for five
   * teeth, the calls because there is now one submission in the colour pass and one in the
   * shadow pass instead of five and five.
   *
   * It is only correct because nothing here animates a feature independently of the body:
   * `useFrame` composes every face matrix as `bodyMatrix x local`, which is exactly what the
   * merge bakes in. A game that blinks or opens a mouth over time needs `mascotParts`.
   *
   * `mascotMaterial()` is the carrier the merge is colour-calibrated against; pairing the
   * geometry with anything else would silently re-tint every face.
   */
  const toothGeo = useMemo(() => countedMascotGeometry(), []);
  const metrics = useMemo(() => scatterMetrics(), []);
  // Solved, not looked up: the grid shape now depends on the chrome band and the play area's
  // pixel height as well as its aspect, so the board the camera was framed for is published
  // on the framing and this is the only place it may come from. See `CameraFraming.board`.
  const board = framing.board;

  /**
   * The tray, and the two numbers this file has to read back off it.
   *
   * `clayTray` decides where its own well floor lands and how far in from the outer
   * silhouette that floor stays flat, and neither is in its signature. `layout.ts` writes
   * both down as constants — it must, because the camera is solved before any geometry
   * exists — so this measures the geometry that was actually built and the effect below
   * shouts if the two have parted company. Measuring beats assuming, and it is three passes
   * over 618 vertices, once per board size.
   */
  /**
   * One accent family, and it is the one the hub card promises.
   *
   * `src/games/index.ts` registers this game as **coral**; round 1's board, pad and pips were
   * `clayAccent("mauve", …)`, measuring dE2000 13.9 from `coral.deep` — a child tapped a
   * coral card and opened into a mauve room (X2). The coral field is the one place in this
   * product that deliberately goes saturated: ivory teeth on a cream board would be a 1.3:1
   * contrast ratio, and a counting game whose things-to-be-counted melt into their background
   * is a broken game.
   */
  const boardMat = useMemo(() => clayAccent(ACCENT, "soft"), []);

  const matGeo = useMemo(
    () => dressedTrayGeometry(board.matW, board.matD, boardMat),
    [board.matW, board.matD, boardMat]
  );

  const well = useMemo(() => {
    const attr = matGeo.getAttribute("position");
    const pos = attr?.array as ArrayLike<number> | undefined;
    if (!pos) return { floor: MAT_FLOOR, insetX: MAT_RIM, insetZ: MAT_RIM };
    // The floor is the highest surface over the middle of the tray; nothing else is there.
    let floor = -Infinity;
    for (let i = 0; i < attr.count; i++) {
      const x = pos[i * 3];
      const z = pos[i * 3 + 2];
      if (Math.abs(x) < board.matW * 0.15 && Math.abs(z) < board.matD * 0.15) {
        const y = pos[i * 3 + 1];
        if (y > floor) floor = y;
      }
    }
    // …and the flat part of it is every vertex sharing that height.
    let flatX = 0;
    let flatZ = 0;
    for (let i = 0; i < attr.count; i++) {
      if (Math.abs(pos[i * 3 + 1] - floor) > 2e-3) continue;
      const ax = Math.abs(pos[i * 3]);
      const az = Math.abs(pos[i * 3 + 2]);
      if (ax > flatX) flatX = ax;
      if (az > flatZ) flatZ = az;
    }
    // World space: `clayTray` builds with its base on y = 0 and the mesh is lifted by
    // `GROUND_LIFT`, so this is directly comparable with `MAT_FLOOR`.
    return {
      floor: floor + GROUND_LIFT,
      insetX: board.matW / 2 - flatX,
      insetZ: board.matD / 2 - flatZ,
    };
  }, [matGeo, board.matW, board.matD]);

  /**
   * The coral sheet, drawn `PAD_TUCK` wider than the flat floor on every side so its own rim
   * is hidden under the tray's fillet. What a child sees is coral, then a filleted wall, then
   * the rim — no plate edge anywhere, which is the whole point of B7.7.
   *
   * The *logical* pad (`board.padW/padD`, which is what teeth are clamped into) is smaller
   * than the flat floor by construction: `MAT_MARGIN` 0.28 against a measured inset of
   * 0.2584. The effect below asserts that rather than trusting it.
   */
  const padGeo = useMemo(
    () =>
      roundedPlate(
        board.matW - 2 * (well.insetX - PAD_TUCK),
        board.matD - 2 * (well.insetZ - PAD_TUCK),
        PAD_T,
        PAD_CORNER
      ),
    [board.matW, board.matD, well.insetX, well.insetZ]
  );

  const tileMat = useMemo(() => clayIvory(), []);
  const tileGeo = useMemo(() => answerTileGeometry(tileMat), [tileMat]);
  const pipGeo = useMemo(() => roundedCylinder(PIP_R, PIP_H, 0.028), []);
  const pipFillGeo = useMemo(() => roundedCylinder(PIP_FILL_R, PIP_FILL_H, 0.024), []);
  const quadGeo = useMemo(
    () => cachedGeometry("count-the-teeth/quad", () => new PlaneGeometry(1, 1)),
    []
  );

  /**
   * Everything `layout.ts` had to write down about geometry it cannot import, checked against
   * the geometry that was actually built.
   *
   * The camera and the separation constraints are solved on the DOM side of `<Scene3D>`,
   * before any geometry exists, so `TOOTH_SILHOUETTE` and `MAT_FLOOR` are constants. This is
   * what stops them going stale — and round 3 is what it is for: the old guard measured one
   * bare, upright `toothGeometry("baby")` and compared it with numbers that were the swept
   * extents of the *whole mascot*, so four of its six comparisons were between different
   * quantities and the fifth fired `console.error` on every mount of the shipping build.
   * It now sweeps the same assembled mascot the constants are a table of, at the detail
   * level this tier actually renders.
   *
   * A console error here is a gating condition against a release, so it must never fire for
   * anything but a real drift — and when it does it must say exactly which number moved.
   *
   * **Deferred, not skipped.** The sweep is 2,847 poses over 1,806 points — tens of
   * milliseconds — and §9 budgets scene entry at one dropped frame. `import.meta.env.DEV` is
   * true in the build the audit harness drives, so running this on the mount commit would put
   * a hitch inside the very window the entry budget is measured in. A second is comfortably
   * past the 450–600 ms hub-to-game transition and still well inside a child's first round.
   */
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const timer = window.setTimeout(() => {
      const cloud = mascotCloud();
      const complaint = checkSilhouette(sweepSilhouette(cloud, cloud.length / 3));
      if (complaint) console.error(`[count-the-teeth] ${complaint}`);
    }, 1000);
    return () => window.clearTimeout(timer);
  }, []);

  /** The tray checks are cheap arithmetic on numbers already measured; they stay on mount. */
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    if (Math.abs(well.floor - MAT_FLOOR) > MAT_FLOOR_TOLERANCE) {
      console.error(
        `[count-the-teeth] clayTray's well floor moved: measured ${well.floor.toFixed(4)}, ` +
          `layout.ts::MAT_FLOOR says ${MAT_FLOOR}`
      );
    }
    if (
      well.insetX > board.matW / 2 - board.padW / 2 ||
      well.insetZ > board.matD / 2 - board.padD / 2
    ) {
      console.error(
        `[count-the-teeth] the coral field runs past clayTray's flat floor: inset ` +
          `${well.insetX.toFixed(4)}/${well.insetZ.toFixed(4)} against a margin of ` +
          `${(board.matW / 2 - board.padW / 2).toFixed(4)}. Raise MAT_MARGIN.`
      );
    }
  }, [well, board.matW, board.matD, board.padW, board.padD]);

  /* ---------------- materials ---------------- */

  // Everything except the albedo is `clayAccent("coral", "main")`'s own recipe, so the coral
  // field is the same clay as the tray it sits in and only its calibration differs.
  const padMat = useMemo(
    () => clayPainted(PAD_ALBEDO, { sss: PAD_SSS, sssStrength: 0.38 }),
    []
  );
  // `countedMascotMaterial` *is* `clayEnamel`; naming it through `face.ts` is what keeps
  // the merged geometry's `aAlbedo` channel married to the carrier it was divided by.
  const toothMat = useMemo(() => countedMascotMaterial(), []);

  const pipMat = useMemo(() => clayAccent(ACCENT, "deep"), []);
  /** Ivory in a dark coral socket: the *filled* pip is the state that has to read. */
  const pipFillMat = useMemo(() => clayIvory(), []);
  const blobMat = useMemo(() => shadowBlobMaterial(), []);

  /**
   * Exactly three numeral materials — one per tile slot, not one per number. The glyph
   * itself lives in the map (swapped each round, which is a uniform change and not a
   * recompile); the brand colour lives here, so the numbers are always `coral.deep` on the
   * enamel plate: 5.9:1, comfortably past the 3:1 that large UI type needs.
   */
  const glyphMats = useMemo<MeshPhysicalMaterial[]>(() => {
    const out: MeshPhysicalMaterial[] = [];
    for (let i = 0; i < CHOICES; i++) {
      out.push(
        clay(`count-the-teeth/glyph-${i}`, {
          color: ACCENTS[ACCENT].deep,
          roughness: 0.66,
          sheen: 0.16,
          grain: 0,
          transparent: true,
        })
      );
    }
    return out;
  }, []);

  /** The only resource this game constructs with `new`, and therefore the only one it frees. */
  const sparkleMat = useMemo(
    () =>
      new MeshBasicMaterial({
        map: sparkleTexture(),
        color: CLAY.wear,
        transparent: true,
        blending: AdditiveBlending,
        premultipliedAlpha: true,
        depthWrite: false,
        toneMapped: false,
        fog: false,
      }),
    []
  );

  /* ---------------- refs ---------------- */

  const teethRef = useRef<InstancedMesh>(null);
  const teethGroupRef = useRef<Group>(null);
  const blobRef = useRef<InstancedMesh>(null);
  const tileRef = useRef<InstancedMesh>(null);
  const pipRef = useRef<InstancedMesh>(null);
  const pipFillRef = useRef<InstancedMesh>(null);
  const sparkRef = useRef<InstancedMesh>(null);
  const fxRef = useRef<Group>(null);

  const tileNodes = useMemo(
    () =>
      Array.from({ length: CHOICES }, (_, i) => ({
        index: i,
        group: createRef<Group>(),
        glyph: createRef<Mesh>(),
        hit: [tileX(i), TILE_T + 0.12, board.tileZ] as [number, number, number],
      })),
    [board.tileZ]
  );

  /* ---------------- the probe rig (dev only) ---------------- */

  /**
   * `?selftest=count` renders per-tooth IDs from the live game camera, which needs one real
   * mesh per tooth — an `InstancedMesh` is a single object and would come back as one number.
   * Round 1 mounted fourteen of those in production and imported the whole self-test module
   * (and its render target) into the game chunk to do it. Both are now behind the flag, and
   * the module is reached by a dynamic import so it stays out of a child's download.
   */
  const probeRefs = useMemo(
    () => (FLAGS.selftest ? Array.from({ length: MAX_COUNT }, () => createRef<Mesh>()) : []),
    []
  );

  /**
   * The renderer and the camera the view is actually drawn with.
   *
   * These are what makes the rig's measurement *the player's* measurement, and handing over
   * `null` for either — which is what this file did until now — means `waitForRig` spins for
   * five seconds and the self test reports "no live Count the Teeth scene": the GPU
   * authority the spec names (§6.7) was registered, wired to the scene, and structurally
   * unable to run. Selected rather than destructured from `useThree()`: a bare `useThree()`
   * subscribes to the whole store and would re-render this component on every resize.
   * `s.camera` is the `PerspectiveCamera` `Scene3D`'s `ViewCamera` installs, so it is the
   * one drei renders this view with, and its identity changes once, on mount.
   */
  const gl = useThree((s) => s.gl);
  const viewCamera = useThree((s) => s.camera);

  useLayoutEffect(() => {
    if (!FLAGS.selftest) return;
    let release: (() => void) | null = null;
    let alive = true;
    void import("./verify").then((mod) => {
      if (!alive) return;
      release = mod.setProbeRig({
        gl,
        camera: viewCamera,
        probes: probeRefs.map((r) => r.current).filter((o): o is Mesh => o !== null),
        place: (scatter: Scatter, probes: Object3D[]) => {
          for (let i = 0; i < probes.length && i < scatter.count; i++) {
            const p = probes[i];
            p.position.set(scatter.x[i], TOOTH_Y, scatter.z[i]);
            _euler.set(scatter.tiltX[i], scatter.yaw[i], scatter.tiltZ[i]);
            p.quaternion.setFromEuler(_euler);
            p.scale.setScalar(toothScale(scatter.scale[i]));
            p.updateMatrix();
          }
        },
        mask: () => {
          if (fxRef.current) fxRef.current.visible = false;
          if (teethGroupRef.current) teethGroupRef.current.visible = false;
        },
        unmask: () => {
          if (fxRef.current) fxRef.current.visible = true;
          if (teethGroupRef.current) teethGroupRef.current.visible = true;
        },
        metrics,
        framing,
        board,
        well,
      });
    });
    return () => {
      alive = false;
      release?.();
    };
  }, [probeRefs, metrics, framing, board, well, gl, viewCamera]);

  useEffect(() => {
    bag.add(sparkleMat);
    return () => bag.release();
  }, [bag, sparkleMat]);

  /* ---------------- instance buffers ---------------- */

  useLayoutEffect(() => {
    const teeth = teethRef.current;
    const blob = blobRef.current;
    _pos.set(0, 0, 0);
    _scl.set(0, 0, 0);
    _quat.identity();
    _mat.compose(_pos, _quat, _scl);

    if (teeth) {
      teeth.count = 0;
      teeth.instanceMatrix.setUsage(DynamicDrawUsage);
    }
    if (blob) {
      // Always full: the tail slots are the answer tiles' and the tray's contact shadows,
      // which are on screen from the first frame. Unused tooth slots are collapsed instead
      // of cropped.
      blob.count = BLOB_SLOTS;
      blob.instanceMatrix.setUsage(DynamicDrawUsage);
      for (let i = 0; i < BLOB_SLOTS; i++) blob.setMatrixAt(i, _mat);
      blob.instanceMatrix.needsUpdate = true;
    }
    for (const mesh of [tileRef.current, pipFillRef.current]) {
      if (!mesh) continue;
      mesh.count = mesh === pipFillRef.current ? PIP_COUNT : CHOICES;
      mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    }

    // InstancedMesh starts life with identity matrices, which would park a full-size
    // sparkle at the origin until the first burst. Collapse them all up front.
    const spark = sparkRef.current;
    if (spark) {
      spark.instanceMatrix.setUsage(DynamicDrawUsage);
      for (let i = 0; i < SPARKLES; i++) spark.setMatrixAt(i, _mat);
      spark.instanceMatrix.needsUpdate = true;
    }
  }, []);

  /**
   * The tray's own contact shadow. Set once per board size and then never touched: the board
   * does not move, and a quad that does not move has no business in a frame loop.
   */
  useLayoutEffect(() => {
    const blob = blobRef.current;
    if (!blob) return;
    _pos.set(0, 0.004, board.matCZ);
    _scl.set(2 * contactRadiusFor(board.matW / 2), 2 * contactRadiusFor(board.matD / 2), 1);
    _mat.compose(_pos, BLOB_QUAT, _scl);
    blob.setMatrixAt(MAT_BLOB, _mat);
    blob.instanceMatrix.needsUpdate = true;
  }, [board.matW, board.matD, board.matCZ]);

  /** The pip sockets never move; they do move when the board's depth changes. */
  useLayoutEffect(() => {
    const pips = pipRef.current;
    if (!pips) return;
    pips.count = PIP_COUNT;
    for (let i = 0; i < PIP_COUNT; i++) {
      // A shallow dark socket pressed into the cream ground in front of the tray — the row
      // moved off the board's back rail entirely, because at 52 degrees the back teeth were
      // drawn straight over it (B7.5). `roundedCylinder` is centred on its own height, so
      // half of it is buried and the top stands `PIP_H / 2` proud.
      _pos.set(pipX(i), PIP_Y, board.pipZ);
      _scl.set(1, 1, 1);
      _quat.identity();
      _mat.compose(_pos, _quat, _scl);
      pips.setMatrixAt(i, _mat);
    }
    pips.instanceMatrix.needsUpdate = true;
  }, [board.pipZ]);

  /* ---------------- in-world numerals ---------------- */

  useEffect(() => {
    let alive = true;
    void ensureManrope().then(() => {
      if (alive) setFontReady(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  /**
   * Every numeral the game can ever show, drawn **once**, at mount.
   *
   * Round 3, B7.3: `textTexture` caches by string, and this game asked it for three fresh
   * numerals on every round — so the shared text cache grew with the number of distinct
   * values a session happened to see, for the life of that session. Measured across a
   * two-loop endurance run, hub textures went 3 -> 9 -> 11 with every loop-2 increment coming
   * from here.
   *
   * A2 has since attributed the text cache to the scene that populates it, so leaving the
   * game frees these — but "frees eventually" is not the same as "bounded", and a cache whose
   * size depends on what a child guessed is not a cache. Sixteen canvases is 1 through
   * `MAX_NUMERAL`, the complete reachable set, drawn in one pass; from then on the count is
   * constant no matter how long anybody plays.
   *
   * Gated on `fontReady`, and that gate is why this cannot simply be done lazily: a numeral
   * drawn before Manrope is usable would be cached in the system stack for the rest of the
   * session. Two frames of blank tiles is a much smaller miss than permanently off-brand
   * numbers.
   */
  useEffect(() => {
    if (!fontReady) return;
    /*
     * …and every one of them gets the driver's maximum anisotropy, which is round 4's CT6
     * "blurry mip-filtered flat decals".
     *
     * The numeral lies **flat on the tile**, and the camera looks down the board at 52
     * degrees of elevation. A flat-lying quad seen at that angle is minified along one
     * texture axis and barely at all along the other — the ratio is `1 / cos 52 = 1.62`
     * before the tile's own perspective foreshortening. Isotropic mip selection has to take
     * the *larger* derivative or alias, so it picks a mip level chosen for the compressed
     * axis and applies it to the sharp one: the numeral loses roughly two thirds of an
     * octave of detail across its whole width, which is what a blurry decal is.
     *
     * Anisotropic filtering is exactly the sampler feature for that case, it is core in
     * WebGL2 via `EXT_texture_filter_anisotropic` (three exposes the cap directly), and it
     * costs nothing but sampler state on a shader `BUDGETS` already calls fragment-bound —
     * there are three of these quads in the frame.
     *
     * Set here rather than in `text.ts` because the cache is shared: a title drawn
     * face-on has no anisotropy to gain, and the renderer is not reachable from that module.
     * Setting it on a cached texture is a sampler parameter, not a re-upload.
     */
    const maxAniso = gl.capabilities.getMaxAnisotropy();
    for (let v = 1; v <= MAX_NUMERAL; v++) {
      const { texture } = textTexture(String(v), NUMERAL_FONT);
      if (texture.anisotropy !== maxAniso) {
        texture.anisotropy = maxAniso;
        texture.needsUpdate = true;
      }
    }
  }, [fontReady, gl]);

  /** Swaps the three cached numerals onto the three glyph materials. Allocates nothing new. */
  useLayoutEffect(() => {
    if (!fontReady) return;
    for (let i = 0; i < CHOICES; i++) {
      const value = engine.answers[i];
      if (value === undefined) continue;
      const label = textTexture(String(value), NUMERAL_FONT);
      const material = glyphMats[i];
      if (material.map !== label.texture) {
        const first = material.map === null;
        material.map = label.texture;
        // Only the null -> texture transition changes the shader's defines.
        if (first) material.needsUpdate = true;
      }
      tileNodes[i].glyph.current?.scale.set(GLYPH_H * label.aspect, GLYPH_H, 1);
    }
  }, [engine, roundId, fontReady, glyphMats, tileNodes]);

  /* ---------------- the layout solve ---------------- */

  /**
   * Draws a scatter and proves it countable — on the CPU, off the render frame.
   *
   * Round 1 ran this from the top of `useFrame` and paid `1 + ceil(n/4)` synchronous
   * `readRenderTargetPixels` calls per attempt, four attempts deep, on every round: about
   * twenty full pipeline flushes in one frame, which is free on unified memory and 200–500 ms
   * of freeze on a tile-based mobile GPU (S8). There is no GPU work here at all now — the
   * proof `layout.ts` runs is an exact screen-space test against the same framing the camera
   * is given, and it is the *stronger* of the two checks, because it is applied to every board
   * rather than measured after the fact.
   */
  const deal = useCallback(
    (reason: "round" | "reframe") => {
      solveScatter(st.scatter, engine.level, engine.count, metrics, framing, board, Math.random);
      const teeth = teethRef.current;
      if (teeth) teeth.count = st.scatter.count;
      st.roundT = 0;
      st.dirty = false;
      for (let i = 0; i < MAX_COUNT; i++) {
        st.spawnDelay[i] = i * SPAWN_STAGGER;
        st.popped[i] = 0;
        st.landed[i] = 0;
        st.hopDelay[i] = -1;
        st.countDelay[i] = -1;
        st.pulseT[i] = 0;
        st.hop[i].set(0);
        st.squash[i].set(0);
      }
      announce(
        reason === "round"
          ? `Round ${engine.round + 1} of ${ROUNDS}. ${describeArrangement(st.scatter, board)} ` +
              `How many teeth altogether? ${chooseFrom(engine.answers)}`
          : `The teeth have moved. ${describeArrangement(st.scatter, board)}`
      );
    },
    [engine, metrics, framing, board, st]
  );

  /** Replays the arrival taps without re-dealing — the audible count, on demand. */
  const recount = useCallback(() => {
    const reduced = isReduced();
    for (let i = 0; i < st.scatter.count; i++) {
      st.countDelay[i] = i * SPAWN_STAGGER;
      if (!reduced) st.hopDelay[i] = i * SPAWN_STAGGER;
    }
  }, [st]);

  /* ---------------- engine events ---------------- */

  const pendingFocus = useRef(-1);

  useEffect(
    () =>
      engine.on((event) => {
        const reduced = isReduced();
        switch (event.type) {
          case "round":
            st.filled = event.index;
            // Solved from an effect, not from the frame. Until then the spawn clock is
            // parked below zero, which holds every tooth at scale zero — otherwise the
            // previous round's board would sit there for a frame and then vanish.
            st.roundT = -1;
            st.dirty = true;
            st.retire.set(0);
            resetSparkles(sparkles);
            pendingFocus.current = capturedFocusOrder();
            setCompleted(false);
            setRoundId((v) => v + 1);
            break;
          case "correct": {
            st.filled = engine.round + 1;
            const tile = st.lift[event.index];
            if (tile) {
              if (reduced) st.tilePulseT[event.index] = PULSE_DUR;
              else {
                tile.impulse(TILE_LIFT_IMPULSE);
                st.press[event.index].impulse(TILE_PRESS_TAP);
              }
            }
            for (let i = 0; i < st.scatter.count; i++) {
              st.hopDelay[i] = reduced ? 0 : i * HOP_STAGGER;
            }
            burst(sparkles, tileX(event.index), TILE_T + 0.34, 0, reduced ? 5 : 10, reduced);
            break;
          }
          case "wrong":
            // Playful, never punitive: a soft comic wobble, the same tiles stay live, the
            // board is not re-dealt — and both count-again channels fire, the taps for a
            // child who is listening and the spoken arrangement for one who is not. A second
            // attempt has to be a real one, which means saying what is on the mat again.
            if (reduced) st.tilePulseT[event.index] = PULSE_DUR;
            else {
              st.wobble[event.index].impulse(
                event.index % 2 === 0 ? TILE_WOBBLE_IMPULSE : -TILE_WOBBLE_IMPULSE
              );
              st.press[event.index].impulse(TILE_PRESS_TAP);
            }
            recount();
            announce(
              `Oops, not quite. Here they are again. ` +
                `${describeArrangement(st.scatter, board)} ${chooseFrom(engine.answers)}`
            );
            break;
          case "complete":
            st.filled = ROUNDS;
            for (let i = 0; i < st.scatter.count; i++) {
              st.hopDelay[i] = reduced ? 0 : i * HOP_STAGGER;
            }
            burst(sparkles, 0, PAD_TOP + 0.6, 0, reduced ? 6 : 14, reduced);
            // The answer row leaves the stage rather than sitting live under the
            // celebration card (§3.7 G-CT-5).
            if (!reduced) st.retire.impulse(RETIRE_ANTICIPATE);
            st.retire.to(1);
            setCompleted(true);
            break;
          default:
            break;
        }
      }),
    [engine, st, sparkles, recount, board]
  );

  /**
   * The deal runs here rather than in the frame loop. It is pure CPU work on a discrete
   * event, so it belongs on the event, and putting it here means `useFrame` can be read as
   * what it is: transforms only.
   */
  useEffect(() => {
    if (st.dirty) deal("round");
  }, [st, deal, roundId]);

  /**
   * A re-framing (the play area was resized or rotated) invalidates the proof, because the
   * proof is stated in screen space. Re-audit, and re-deal only if the board no longer holds
   * — a resize that leaves it countable must not throw away the child's half-counted board.
   */
  useEffect(() => {
    if (st.dirty || st.scatter.count === 0) return;
    if (!auditScatter(st.scatter, metrics, framing).pass) deal("reframe");
  }, [st, metrics, framing, deal]);

  /** Runs after the `HitTarget` children have rebuilt their hidden buttons. */
  useEffect(() => {
    if (pendingFocus.current < 0) return;
    restoreFocusOrder(pendingFocus.current);
    pendingFocus.current = -1;
  }, [roundId]);

  /* ---------------- keyboard ---------------- */

  const activate = useCallback(
    (index: number) => {
      const value = engine.answers[index];
      if (value !== undefined) engine.answer(value);
    },
    [engine]
  );

  /*
   * `CHOICES` is a constant, which matters: `useFocusGroup` releases its reference on the
   * group whenever `count` changes, and a round change also unmounts every `HitTarget`
   * before the replacements mount. If both let go in the same commit the group's refcount
   * would touch zero, its hidden container would leave the DOM, and the new tiles would
   * register into a detached node — arrows and VoiceOver would go silent with nothing in
   * the console. Here the count never changes, so one live reference is held for the
   * scene's whole life.
   */
  useFocusGroup(GROUP, CHOICES, activate);

  /* ---------------- the frame ---------------- */

  useFrame((state, delta) => {
    const teeth = teethRef.current;
    const blob = blobRef.current;
    const tiles = tileRef.current;
    const pipFill = pipFillRef.current;
    if (!teeth || !blob || !tiles || !pipFill) return;

    const dt = safeDelta(delta);
    const reduced = isReduced();
    const elapsed = state.clock.elapsedTime;

    /*
     * The celebration hand-off.
     *
     * Since A10, `GameShell` publishes the shared burst into **this scene's own `<View>`**
     * (`view-slot.tsx` → `Scene3D`), so there is one camera, one depth buffer and one rig;
     * this scene keeps rendering behind it — deliberately, so the child stays in the room
     * they were playing in. Round 2 photographed the result here: five rooted teeth on the pad at the
     * same time as the celebration's own tooth, plus a live-looking answer row underneath
     * it. The row already retires on `complete`; this takes the scatter with it. The board
     * takes its bow first — `complete` staggers a hop down the whole scatter and fires a
     * sparkle burst — and then the teeth pop out across the shared window, arriving at
     * exactly zero before the celebration's mascot exists. The pad and the mat stay: they
     * are the table the burst lands on.
     */
    const exit = celebrationHeroScale();
    const teethGroup = teethGroupRef.current;
    if (teethGroup) teethGroup.scale.set(exit, exit, exit);

    /* ---- teeth ---- */

    const scatter = st.scatter;
    const spawnDur = reduced ? PULSE_DUR : SPAWN_DUR;
    if (st.roundT >= 0) st.roundT += dt;

    for (let i = 0; i < scatter.count; i++) {
      const local = st.roundT - st.spawnDelay[i];

      if (st.popped[i] === 0 && local >= 0) {
        st.popped[i] = 1;
        // A discrete, once-per-tooth event that happens to be detected inside the frame
        // loop, because the stagger clock lives here. It fires under reduced motion too:
        // reduced motion suppresses movement, and this is the accessible count.
        sounds.pop();
      }

      // The re-count wave: taps only, on the same rhythm as the deal.
      if (st.countDelay[i] >= 0) {
        st.countDelay[i] -= dt;
        if (st.countDelay[i] <= 0) {
          st.countDelay[i] = -1;
          sounds.pop();
        }
      }

      const k = clamp01((reduced ? st.roundT : local) / spawnDur);
      let grow: number;
      let drop = 0;
      if (reduced) {
        grow = st.roundT < 0 ? 0 : easeOutCubic(k);
      } else {
        grow = k <= 0 ? 0 : easeOutBack(k, 1.9);
        drop = (1 - easeOutCubic(k)) * SPAWN_DROP;
        if (st.landed[i] === 0 && k >= 0.86) {
          st.landed[i] = 1;
          st.squash[i].impulse(LAND_IMPULSE);
        }
      }

      if (st.hopDelay[i] >= 0) {
        st.hopDelay[i] -= dt;
        if (st.hopDelay[i] <= 0) {
          st.hopDelay[i] = -1;
          if (reduced) st.pulseT[i] = PULSE_DUR;
          else {
            st.hop[i].impulse(HOP_IMPULSE);
            st.squash[i].impulse(HOP_SQUASH);
          }
        }
      }

      const hop = st.hop[i];
      const squash = st.squash[i];
      hop.to(0);
      squash.to(0);
      hop.step(dt);
      squash.step(dt);

      let pulse = 0;
      if (st.pulseT[i] > 0) {
        st.pulseT[i] -= dt;
        pulse = PULSE_TOOTH * Math.sin(clamp01(1 - st.pulseT[i] / PULSE_DUR) * Math.PI);
      }

      let bob = 0;
      let sway = 0;
      if (!reduced) {
        // One-sided, and that is the second half of B7.6. A tooth rises off its contact
        // and settles back **onto** it; it never goes below the surface it stands on, so
        // there is an instant in every cycle where the prop is genuinely touching the clay
        // and the contact pool is at full size. A symmetric sine has no such instant, which
        // is most of why the old idle read as a hover rather than as breathing. Cosine so
        // the cycle starts at contact, not half a bob up.
        bob = (1 - Math.cos(elapsed * 1.05 + st.seed[i])) * 0.5 * IDLE_BOB;
        sway = Math.sin(elapsed * 0.77 + st.seed[i] * 1.7) * IDLE_SWAY;
      }

      // **`bob` is inside the lift, not beside it** (B7.6). It used to be added to the
      // tooth's position and left out of the term the contact shadow reads, so a 1.05 Hz,
      // 2–3 px hover ran over a shadow pinned at full-contact size for 95 % of the time a
      // child was looking at the board — the one motion in the scene that says "this is a
      // sticker, not an object standing on a surface".
      const lift = drop + hop.value + bob;
      squashFor(_squash, squash.value + pulse, 1, 0.28);
      // `toothScale` is the one place the geometry's unit height becomes a world size.
      const size = toothScale(scatter.scale[i]) * grow;

      _pos.set(scatter.x[i], TOOTH_Y + lift, scatter.z[i]);
      _euler.set(scatter.tiltX[i], scatter.yaw[i], scatter.tiltZ[i] + sway);
      _quat.setFromEuler(_euler);
      _scl.set(_squash.x * size, _squash.y * size, _squash.z * size);
      _mat.compose(_pos, _quat, _scl);
      teeth.setMatrixAt(i, _mat);

      // The face rides the body's own matrix — it is *in* the body's geometry now (CT2),
      // so there is nothing further to pose and nothing further to submit.

      // Close contact darkening: the shadow map cannot resolve the pinch right where a
      // tooth meets the pad, and that gradient is most of what makes it look *placed*.
      //
      // Two terms, and they point in opposite directions on purpose. `contactRadiusFor`
      // widens the reach by `SHADOW_SOFTNESS x lift`, which is §2's rule — a penumbra grows
      // with the gap. `contact` collapses the pool over `BLOB_FADE`, because what this decal
      // supplies is the *contact* pinch, and a tooth in the air has none. At the idle bob's
      // 0.022 peak they come to +1.36 % and −5.13 %, so the pool breathes 3.9 % — 2.1 px at
      // the desktop framing — with the tooth that casts it. Round 3 read `lift` from a term
      // that excluded the bob entirely, so a 1.05 Hz hover ran over a pool frozen at full
      // contact size for 95 % of the time a child was looking at the board.
      const contact = 1 - clamp01(lift / BLOB_FADE);
      const r =
        blobQuadFor(
          TOOTH_SILHOUETTE.rootHalf * toothScale(scatter.scale[i]),
          lift > 0 ? lift : 0
        ) *
        grow *
        (0.72 + 0.28 * contact) *
        exit;
      _pos.set(scatter.x[i], PAD_TOP + 0.004, scatter.z[i]);
      _scl.set(r < 1e-4 ? 1e-4 : r, r < 1e-4 ? 1e-4 : r, 1);
      _mat.compose(_pos, BLOB_QUAT, _scl);
      blob.setMatrixAt(i, _mat);
    }

    // Collapse everything this round does not use, so a smaller count never leaves last
    // round's shadows or last round's eyes lying on the pad.
    _pos.set(0, 0, 0);
    _scl.set(0, 0, 0);
    _quat.identity();
    _mat.compose(_pos, _quat, _scl);
    for (let i = scatter.count; i < MAX_COUNT; i++) blob.setMatrixAt(i, _mat);

    teeth.instanceMatrix.needsUpdate = true;

    /* ---- answer tiles ---- */

    st.retire.step(dt);
    const retire = st.retire.value;
    const shown = retire < 1 ? 1 - retire : 0;

    for (let i = 0; i < CHOICES; i++) {
      const node = tileNodes[i];
      const group = node.group.current;
      if (!group) continue;

      const press = st.press[i];
      const lift = st.lift[i];
      const wobble = st.wobble[i];
      lift.to(0);
      wobble.to(0);
      press.step(dt);
      lift.step(dt);
      wobble.step(dt);

      let pulse = 0;
      if (st.tilePulseT[i] > 0) {
        st.tilePulseT[i] -= dt;
        pulse = PULSE_TILE * Math.sin(clamp01(1 - st.tilePulseT[i] / PULSE_DUR) * Math.PI);
      }

      group.position.set(
        tileX(i),
        TILE_Y + press.value + lift.value - retire * RETIRE_DROP,
        board.tileZ
      );
      group.rotation.set(0, wobble.value * TILE_WOBBLE_TWIST, 0);
      squashFor(_squash, press.value * 2.6 + pulse, 1, 0.24);
      group.scale.set(_squash.x * shown, _squash.y * shown, _squash.z * shown);
      group.updateMatrix();

      tiles.setMatrixAt(i, group.matrix);

      // Its own close-contact darkening, pinching as the tile is pressed into the clay and
      // drawing back as a correct answer lifts it.
      const sit = 1 - clamp01(lift.value / 0.2);
      const tw =
        TILE_W * TILE_BLOB_SPREAD_W * (1 + press.value * 1.4) * (0.82 + 0.18 * sit) * shown;
      const td =
        TILE_D * TILE_BLOB_SPREAD_D * (1 + press.value * 1.4) * (0.82 + 0.18 * sit) * shown;
      _pos.set(tileX(i), 0.004, board.tileZ);
      _scl.set(tw < 1e-4 ? 1e-4 : tw, td < 1e-4 ? 1e-4 : td, 1);
      _mat.compose(_pos, BLOB_QUAT, _scl);
      blob.setMatrixAt(TILE_BLOB + i, _mat);
    }

    tiles.instanceMatrix.needsUpdate = true;
    blob.instanceMatrix.needsUpdate = true;

    /* ---- round pips ---- */

    for (let i = 0; i < PIP_COUNT; i++) {
      const pip = st.pip[i];
      pip.to(i < st.filled ? 1 : 0);
      const v = pip.step(dt);
      const s = v < 1e-4 ? 1e-4 : v;
      // Grows *out of* the socket rather than being scaled about a floating centre.
      _pos.set(pipX(i), PIP_Y + PIP_FILL_H * 0.5 * s, board.pipZ);
      _quat.identity();
      _scl.set(s, s, s);
      _mat.compose(_pos, _quat, _scl);
      pipFill.setMatrixAt(i, _mat);
    }
    pipFill.instanceMatrix.needsUpdate = true;

    const spark = sparkRef.current;
    if (spark) stepSparkles(sparkles, spark, state.camera.quaternion, dt, reduced);
  });

  /* ---------------- graph ---------------- */

  return (
    /*
      `shadowArea` is a world quantity and the world is scaled, so it is scaled with it — a
      frustum sized for a full-size board around a 0.7-scale one is 43 % of its texel
      density thrown away.
    */
    <Rig shadowArea={board.shadowArea * framing.scale} groundY={0}>
      {/*
        One node carries `CameraFraming.scale`, and it is the only thing in this file that
        knows about it. Everything inside — the board metrics, the scatter, the silhouette
        table, the sparkle field, the contact blobs — stays in the unscaled world units
        `layout.ts` is written in, and `projectPoint` / `toothNdcBox` apply the same factor
        on the projection side, so a proof written in world units still describes pixels.

        Why a scale at all: see `CameraFraming.scale`. Short version — a 273 px chrome band
        on a 745 px phone leaves less frame than the composition needs at 8–16 units with a
        26–32° lens, and round 4 photographed what the old code did about it (nothing: it
        returned an unsolved framing and put a tooth behind the difficulty pills).

        The ground plane and the key stay outside, at world scale: they are the room, not
        the composition.
      */}
      <group scale={framing.scale}>
        {/* `clayTray` is built Y-up with its base on y = 0, so it takes no rotation. */}
        <mesh
          geometry={matGeo}
          material={boardMat}
          position-y={GROUND_LIFT}
          position-z={board.matCZ}
          castShadow
          receiveShadow
        />
        <mesh
          geometry={padGeo}
          material={padMat}
          rotation={FLAT_ROT}
          position-y={PAD_Y}
          position-z={board.padCZ}
          receiveShadow
        />

        <instancedMesh
          ref={pipRef}
          args={[pipGeo, pipMat, PIP_COUNT]}
          frustumCulled={false}
          receiveShadow
        />
        <instancedMesh
          ref={pipFillRef}
          args={[pipFillGeo, pipFillMat, PIP_COUNT]}
          frustumCulled={false}
          castShadow
        />

        {/*
        The counted mascots: **one** instanced mesh, face included (CT2). The group is kept
        because `celebrationHeroScale` drives it and because `?selftest=count` hides the
        whole character in one call.
      */}
        <group ref={teethGroupRef}>
          <instancedMesh
            ref={teethRef}
            args={[toothGeo, toothMat, MAX_COUNT]}
            frustumCulled={false}
            castShadow
            receiveShadow
          />
        </group>

        {/*
          Tile and label plate in one mesh (CT2/CT6). The plate sits inside the body's own
          outline, so the merge adds nothing to what the shadow pass has to draw.
        */}
        <instancedMesh
          ref={tileRef}
          args={[tileGeo, tileMat, CHOICES]}
          frustumCulled={false}
          castShadow
          receiveShadow
        />

        {tileNodes.map((node) => (
          <group key={node.index} ref={node.group} matrixAutoUpdate={false}>
            <mesh
              ref={node.glyph}
              geometry={quadGeo}
              material={glyphMats[node.index]}
              position={GLYPH_POS}
              rotation={FLAT_ROT}
              visible={fontReady}
            />
          </group>
        ))}

        {probeRefs.length > 0 && (
          <group>
            {probeRefs.map((ref, i) => (
              <mesh key={i} ref={ref} geometry={toothGeo} material={toothMat} visible={false} />
            ))}
          </group>
        )}

        {/*
        Everything in here is hidden while the occlusion check runs. Blobs and sparkles are
        transparent overlays that would be flattened into opaque black occluders by the ID
        pass, and a `HitTarget`'s collider is invisible only by *material* — the ID pass
        replaces materials, which would turn three 48-pixel spheres into solid walls
        between the camera and the board.
      */}
        <group ref={fxRef}>
          <instancedMesh
            ref={blobRef}
            args={[quadGeo, blobMat, BLOB_SLOTS]}
            frustumCulled={false}
            renderOrder={2}
          />
          <instancedMesh
            ref={sparkRef}
            args={[quadGeo, sparkleMat, SPARKLES]}
            frustumCulled={false}
            renderOrder={6}
          />
          {tileNodes.map((node) => {
            const value = engine.answers[node.index];
            return (
              <HitTarget
                key={node.index}
                ariaLabel={
                  value === undefined ? "Answer" : `${value} ${value === 1 ? "tooth" : "teeth"}`
                }
                group={GROUP}
                focusOrder={node.index}
                position={node.hit}
                /*
                `HitTarget` divides by its parent's world scale, so `radius` is a *world*
                radius however deep the node sits. Inside the scaled group that means the
                factor has to be applied here, or a 0.7-scale board would mount colliders
                43 % wider than the tiles they mark — which `?selftest=hit-targets`'s
                oversize check would (correctly) fail.
              */
                radius={TILE_W * 0.5 * framing.scale}
                minScreenPx={48}
                disabled={completed}
                onPress={() => st.press[node.index].to(-TILE_SINK)}
                onRelease={() => st.press[node.index].to(0).impulse(1.4)}
                onSelect={() => activate(node.index)}
              />
            );
          })}
        </group>
      </group>
    </Rig>
  );
}

/**
 * Memoised on `engine` (whose identity never changes) plus the framing and level, which are
 * solved on the DOM side and only change on a resize or a level switch — so the shell
 * re-rendering its HUD once a second does not touch the 3D tree at all.
 */
export const CountTheTeethScene = memo(CountTheTeethSceneImpl);
