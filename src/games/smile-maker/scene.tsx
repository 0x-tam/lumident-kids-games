/**
 * Smile Maker — the photo booth.
 *
 * How this file is wired:
 *
 *  • **One prop, the engine, and it never changes identity.** The component re-renders on
 *    exactly two things — an accessory arriving during the first second, and the polaroid
 *    appearing or leaving — because those are the only events that change what *exists* in
 *    the tree. Attaching, detaching, dragging, orbiting and the whole photo animation are
 *    struct mutation only.
 *  • **The entry frame builds the tooth and nothing else.** `buildBooth()` produces the hero
 *    and its face; the ten accessories arrive one per idle callback afterwards and rise into
 *    their slots. Round 4 measured the old all-at-once build at a 299.1 ms entry frame.
 *  • **The controls are objects.** Snap is a clay camera the print comes out of, Surprise is
 *    a lever and Clear is a tray, all standing on the table in front of the turntable. There
 *    is no DOM inside the play area; `hit.tsx` publishes the labelled buttons.
 *  • **One `useFrame`, at priority 0.5.** `Scene3D`'s `CameraRig` drives the camera at
 *    priority 0 and drei's `<View>` renders at 1, so a callback between the two is the only
 *    place that can layer an orbit on top of the rig's framing and still be certain the
 *    camera is final before anything is drawn. It allocates nothing: module-level scratch
 *    vectors, module-level step functions, no closures, no literals, no `map`.
 *  • **The polaroid is a real render capture.** At the moment of the shutter the shelf, the
 *    unworn props, the highlight and the polaroid itself are hidden, the scene is rendered
 *    from a second camera into a pooled render target, and everything is restored — all
 *    inside the same frame, before the view draws. Two targets are reused forever; a child
 *    can take a hundred photos and `renderer.info.memory.textures` never moves.
 *
 * Motion (3D-SPEC §4). Picking a prop up winds up *into* the shelf before it lifts. A drop
 * near its anchor is a magnetic `easeOutBack` snap that lands with a squash and a click; a
 * drop anywhere else is not a failure, it is a gentle `easeOutCubic` arc back to the shelf.
 * The orbit follows the finger on a damped follow and then **stays where the child left it**
 * — it eases back to the hero framing only on Clear, Surprise or the shutter, which are the
 * three beats that re-frame the shot. Nothing anywhere is linear.
 *
 * Reduced motion: no orbit drift and no auto-return (the orbit still answers a finger and
 * the arrow keys, immediately, because that is direct manipulation rather than animation),
 * no idle bob on the tooth or the shelf, props change place with a 150 ms scale pop instead
 * of travelling, the polaroid appears in place with the same pop, and there is no camera
 * flash at all.
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
  type RefObject,
} from "react";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import {
  AdditiveBlending,
  Color,
  DynamicDrawUsage,
  HalfFloatType,
  LinearFilter,
  Matrix4,
  MeshBasicMaterial,
  PerspectiveCamera,
  Plane,
  PlaneGeometry,
  Quaternion,
  Ray,
  UnsignedByteType,
  Vector3,
  WebGLRenderTarget,
  type Group,
  type InstancedMesh,
  type Mesh,
  type Scene,
  type TextureDataType,
  type WebGLRenderer,
} from "three";

import {
  FEEL,
  Spring,
  anticipate,
  clamp01,
  damp,
  dampAngle,
  easeOutBack,
  easeOutCubic,
  safeDelta,
  squashFor,
} from "../../three/anim";
import { DisposalBag, trackRenderTarget, untrackRenderTarget } from "../../three/dispose";
import { cachedGeometry, roundedCylinder, roundedPlate, torusSoft } from "../../three/geometry";
import { HitTarget, announce } from "../../three/hit";
import { shadowBlobMaterial } from "../../three/materials";
import { getQuality } from "../../three/quality";
import { ContactBlob, Rig, contactOpacityFor, contactRadiusFor } from "../../three/Rig";
import { CONTEXT_RESTORED_EVENT } from "../../three/Stage";
import { celebrationHeroScale, isReduced } from "../../three/store";
import { ensureManrope, textTexture, type TextTexture } from "../../three/text";
import { sparkleTexture } from "../../three/textures";
import { CLAY, NEUTRAL, color } from "../../three/tokens";
import { sounds } from "../../shared/audio";

import {
  ACCESSORIES,
  PROP_COUNT,
  type AnchorId,
  type SmileMakerEngine,
} from "./engine";
import {
  anchorMaterial,
  buildBooth,
  buildControls,
  buildNextProp,
  controlYaw,
  paperMaterial,
  podiumMaterial,
  shelfMaterial,
  shelfRingGeometry,
  toothMaterial,
  type ControlId,
} from "./build";
import {
  CAPTURE_DIST,
  CAPTURE_ELEVATION_MAX,
  CAPTURE_ELEVATION_MIN,
  CAPTURE_TARGET_Y,
  CONTROL_SLOTS,
  DRAG_PLANE_LIFT,
  DRAG_POP,
  ELEVATION,
  ELEVATION_MAX,
  ELEVATION_MIN,
  ORBIT_FOLLOW_LAMBDA,
  ORBIT_KEY_PITCH,
  ORBIT_KEY_YAW,
  ORBIT_PITCH_PER_PX,
  ORBIT_REDUCED_LAMBDA,
  ORBIT_RETURN_LAMBDA,
  ORBIT_YAW_PER_PX,
  PAD_H,
  PAD_R,
  PHOTO_CAPTION_Y,
  PHOTO_DIST,
  PHOTO_H,
  PHOTO_IMAGE,
  PHOTO_IMAGE_Y,
  PHOTO_PAPER_T,
  PHOTO_VIEW_HALF,
  PHOTO_W,
  PODIUM_H,
  PODIUM_R,
  PROP_HIT_R,
  RING_INNER,
  RING_OUTER,
  RING_TOP,
  SHADOW_AREA,
  SLOT_COUNT,
  SLOT_FAN,
  SLOT_OF,
  SNAP_SCREEN,
  TAN_HALF_FOV,
  TOOTH_BASE_Y,
  TOOTH_SCALE,
  YAW_LIMIT,
  framing,
  shelfScale,
  slotAngle,
  slotX,
  slotY,
  slotZ,
  type ControlSlot,
} from "./layout";

/* ------------------------------------------------------------------ */
/* Tuning                                                              */
/* ------------------------------------------------------------------ */

const MODE_IDLE = 0;
const MODE_DRAG = 1;
const MODE_FLY = 2;

/** How far a pointer must travel, in CSS pixels, before a press becomes a drag. */
const DRAG_PX = 9;
/** Distance in front of the camera the invisible pointer sheet is parked. */
const PLANE_DIST = 2.2;

const SNAP_DUR = 0.32;
const RETURN_DUR = 0.44;
const SNAP_IMPULSE = -5;
const RETURN_IMPULSE = -3.4;

/*
 * The flight path.
 *
 * It used to be a straight lerp from shelf slot to anchor plus `arc * sin(k * PI)` with
 * `SNAP_ARC = 0.05` — five millimetres of bump against a head 1.5 units tall, applied at
 * `k = 0.5`, by which point `easeOutBack` has already carried the prop *past* its anchor.
 * So it was never a travel arc at all, it was a post-arrival wobble, and for the three
 * `top`-anchor accessories (Hat, Party Hat, Crown) the path went straight through the face.
 * Round 2 photographed the Crown two frames after activation, buried through the middle of
 * the skull at eye level with one eye covered — a glitch frame on the normal path, in the
 * shipping build.
 *
 * It is now a quadratic Bezier whose control point is *solved* against the crown's measured
 * bounding sphere (`build.ts::headSphere`), so a hat always arrives from above whichever
 * slot it started in. The overshoot an `easeOutBack` produces past t = 1 is applied
 * separately, along the curve's arrival tangent and scaled to a fixed distance, because
 * extrapolating a Bezier past its end point would have thrown the prop back down toward the
 * control point — i.e. straight into the head again, only faster.
 */
/** Lift added to the control point above the higher endpoint, before any clearance solve. */
const SNAP_ARC = 0.12;
const RETURN_ARC = 0.34;
/** How far past the anchor a full `easeOutBack` overshoot travels, in world units. */
const OVERSHOOT_DIST = 1.3;
/** Air left between the flight path and the crown, in world units. 9 mm at product scale. */
const HEAD_CLEARANCE = 0.09;
/** Samples of the curve tested against the crown. Excludes both endpoints — see below. */
const ARC_SAMPLES = 13;
const ARC_LIFT_STEP = 0.08;
const ARC_LIFT_MAX = 2;
/**
 * Radius of the landing and take-off corridors the clearance test ignores, in world units.
 *
 * Must exceed the distance from the `top` anchor to the top of the crown (0.30), or a hat
 * could never be allowed to arrive at all. 0.45 leaves the last 4.5 cm of the descent to the
 * snap spring, which is the part that is *meant* to be inside the hat.
 */
const LANDING_R2 = 0.45 * 0.45;
/**
 * How far a keyboard flight is held before it takes off, so the press wind-up renders.
 *
 * `hit.tsx` routes keyboard and assistive activation through `el.click()`, which fires
 * `onPress` and `onSelect` in the same tick: the pick-up impulse is applied and the flight
 * starts before a single frame has been drawn, so the wind-up `3D-SPEC §4` requires exists
 * in the numbers and never on the screen. Holding the launch for `FEEL.windUp` lets the
 * press spring travel first. A pointer tap already has several frames between `pointerdown`
 * and `click`, so it skips this and behaves exactly as before.
 */
const PRESS_TRAVEL_EPS = 0.012;

const IDLE_LAMBDA = 30;
const DRAG_LAMBDA = 22;
const TURN_LAMBDA = 11;

const SPARKLES = 30;

/** Authored radius of the target ring; the scene scales it off the live snap radius. */
const ANCHOR_RING_R = 0.235;

/** Shutter -> capture. Long enough that the sparkle reads as a flash of light. */
const ARM_DELAY = 0.16;
const SLIDE_DUR = 0.62;
const LEAVE_DUR = 0.34;
const WHIRR_STEP = 0.13;
const WHIRR_COUNT = 3;

const PHOTO_HIDDEN = 0;
const PHOTO_ARMING = 1;
const PHOTO_SLIDING = 2;
const PHOTO_SHOWN = 3;
const PHOTO_LEAVING = 4;

const POOL_SIZE = 2;

/**
 * How wide the print is as it leaves the lens, as a fraction of its read size.
 *
 * The camera's front element is 0.25 units across and the polaroid is 0.86, so a print that
 * emerged at full size would be three times the width of the slot it came out of. 0.29 is
 * that ratio; it opens out to 1 over the slide.
 */
const PHOTO_EMERGE = 0.29;

/*
 * ## The capture warm-up is gone, and here is the arithmetic — round 4, SM4
 *
 * There used to be a deliberate render-target pass 0.75 s after entry, whose job was to make
 * every material in the shot compile its second `NoToneMapping`/`LinearSRGB` variant off the
 * shutter. Three r170 forces both of those whenever `currentRenderTarget !== null`
 * (`WebGLPrograms.getParameters`), and both are in the program cache key, so the first photo
 * genuinely does compile a second variant of everything in it. That much was right.
 *
 * What was wrong is the sentence that justified keeping it: "the variants are attributable
 * to this scene's own materials and die with them." They do not. Every material in the shot
 * except this game's two private ones comes from `materials.ts`'s shared cache under a key
 * other scenes also ask for (`enamel`, `accent:mauve:*`, `painted:*`), so `dispose.ts` marks
 * it shared and never evicts it — and a program is released only when **every** material
 * referencing it is disposed. The variants outlive the scene by construction.
 *
 * The measurement, from the round-4 capture, and it also **corrects the finding**:
 * `smile-maker-memory-after.json` reports +6 programs over a cold hub baseline after one
 * hub -> game -> hub, but `endurance.json` runs the whole nine-game loop twice and shows
 * every game contributing +4 on its first entry and Smile Maker taking it to **+7** — so
 * this game's own share is **+3, once**, not +6 — and then **completely flat for the whole
 * of loop 2**, Smile Maker's second visit included. It is a one-time shared-tier allocation,
 * not a per-visit leak, and §5's steady state (a repeat visit costing zero) already holds.
 *
 * That is the reason to delete the warm-up rather than to keep it: it spent three permanent
 * programs and a whole extra scene render on **every** entry, on the tier that can least
 * afford either, for a beat most children never reach. Without it, a child who never presses
 * the camera costs nothing at all, and a child who does pays the same three programs the
 * warm-up was paying up front — once, at the shutter, behind the sparkle burst that
 * `ARM_DELAY` already puts between the press and the capture and the 0.62 s the print takes
 * to slide out.
 */

const PITCH_MIN = ELEVATION_MIN - ELEVATION;
const PITCH_MAX = ELEVATION_MAX - ELEVATION;

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/* ------------------------------------------------------------------ */
/* Per-frame scratch — module level, allocated exactly once            */
/* ------------------------------------------------------------------ */

const _fwd = new Vector3();
const _up = new Vector3();
const _pos = new Vector3();
const _scl = new Vector3();
const _mat = new Matrix4();
const _quat = new Quaternion();
const _planeN = new Vector3();
const _hitPoint = new Vector3();
const _dir = new Vector3();
const _target = new Vector3();
const _ray = new Ray();
const _dragPlane = new Plane();
const _clearColor = new Color();
const _tint = new Color();
const _squash = { x: 1, y: 1, z: 1 };

const FLAT_QUAT = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -Math.PI / 2);
const ZERO3: [number, number, number] = [0, 0, 0];

/* ------------------------------------------------------------------ */
/* Prop animation state                                                */
/* ------------------------------------------------------------------ */

type PropAnim = {
  index: number;
  seed: number;
  attached: boolean;
  mode: number;

  /** Live position, before the drag pop is added. */
  px: number;
  py: number;
  pz: number;

  /** Flight: start, Bezier control, goal, and the unit arrival tangent for the overshoot. */
  t: number;
  dur: number;
  /** Seconds still to wait before the flight starts, so a press wind-up can render. */
  delay: number;
  fx: number;
  fy: number;
  fz: number;
  cx: number;
  cy: number;
  cz: number;
  gx: number;
  gy: number;
  gz: number;
  ox: number;
  oy: number;
  oz: number;
  snap: boolean;
  landed: boolean;

  /** Where the finger currently is, on the drag plane. */
  dx: number;
  dy: number;
  dz: number;
  /** Unit vector from the drag plane toward the camera; the pop rides along it. */
  nx: number;
  ny: number;
  nz: number;

  yaw: number;
  yawTo: number;
  pitch: number;
  pitchTo: number;
  roll: number;
  rollTo: number;

  pop: Spring;
  scale: Spring;
  squash: Spring;
  wobble: Spring;

  /** Reduced-motion scale pop — springs are deliberately inert under reduced motion. */
  popT: number;
  popDur: number;
  popAmp: number;
};

function createAnim(index: number, slot: number, lift: number, pitch: number): PropAnim {
  return {
    index,
    seed: (index * 2.3999632297) % (Math.PI * 2),
    attached: false,
    mode: MODE_IDLE,
    px: slotX(slot),
    py: slotY + lift,
    pz: slotZ(slot),
    t: 0,
    dur: SNAP_DUR,
    delay: 0,
    fx: 0,
    fy: 0,
    fz: 0,
    cx: 0,
    cy: 0,
    cz: 0,
    gx: 0,
    gy: 0,
    gz: 0,
    ox: 0,
    oy: 1,
    oz: 0,
    snap: false,
    landed: true,
    dx: 0,
    dy: 0,
    dz: 0,
    nx: 0,
    ny: 0,
    nz: 1,
    yaw: slotAngle(slot) * SLOT_FAN,
    yawTo: slotAngle(slot) * SLOT_FAN,
    pitch,
    pitchTo: pitch,
    roll: 0,
    rollTo: 0,
    pop: new Spring(0, 300, 19),
    scale: new Spring(shelfScale(index), 340, 21),
    squash: new Spring(0, 380, 17),
    /*
     * `3D-SPEC §4.1 Exception 1` — comic wobble. `ζ = 11 / (2√300) = 0.318`, first overshoot
     * 34.9 %, 2 % settling 727 ms: inside the exception's 0.25–0.44 / ≤45 % / ≤900 ms and
     * outside the settle band, deliberately. It is the only spring here that is allowed to
     * be, and it qualifies on both counts the exception requires — it drives a roll about
     * the prop's own axis, which carries no state, and nothing waits on it: the prop is
     * already where it is going before the wobble has finished ringing down.
     */
    wobble: new Spring(0, 300, 11),
    popT: 0,
    popDur: FEEL.reducedFade,
    popAmp: 0,
  };
}

function reducedPop(a: PropAnim, amp: number): void {
  a.popAmp = amp;
  a.popDur = FEEL.reducedFade;
  a.popT = FEEL.reducedFade;
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
  spread: number,
  count: number,
  reduced: boolean
): void {
  for (let k = 0; k < count; k++) {
    const i = field.next;
    field.next = (field.next + 1) % field.n;
    if (field.dur[i] <= 0) field.live++;
    field.px[i] = x + (Math.random() - 0.5) * spread;
    field.py[i] = y + (Math.random() - 0.5) * spread * 0.7;
    field.pz[i] = z + (Math.random() - 0.5) * spread;
    const a = Math.random() * Math.PI * 2;
    const e = 0.25 + Math.random() * 0.9;
    const s = reduced ? 0 : 0.7 + Math.random() * 0.7;
    field.vx[i] = Math.cos(a) * Math.cos(e) * s;
    field.vy[i] = Math.sin(e) * s + (reduced ? 0 : 0.5);
    field.vz[i] = Math.sin(a) * Math.cos(e) * s;
    field.life[i] = 0;
    field.dur[i] = reduced ? 0.3 : 0.6 + Math.random() * 0.3;
    field.size[i] = 0.13 + Math.random() * 0.12;
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
      _mat.compose(_pos, camQuat, _scl);
      mesh.setMatrixAt(i, _mat);
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
    _mat.compose(_pos, camQuat, _scl);
    mesh.setMatrixAt(i, _mat);
  }
  field.live = live;
  mesh.instanceMatrix.needsUpdate = true;
}

/* ------------------------------------------------------------------ */
/* Render-target pool                                                  */
/* ------------------------------------------------------------------ */

/**
 * Two targets, reused forever, alternating so a capture never overwrites the texture the
 * polaroid is still showing while it slides.
 *
 * Half-float because a render target is written in **linear** space (three only applies
 * tone mapping and the sRGB transfer when it is rendering to the canvas), and eight linear
 * bits band visibly in the shadows of a cream scene. The extension is probed rather than
 * assumed: on a device without float colour buffers the fallback is eight bits, which is
 * mildly banded but always correct, rather than an incomplete framebuffer and a black photo.
 */
class PhotoPool {
  private readonly targets: WebGLRenderTarget[] = [];
  private cursor = -1;
  private size = 448;
  private type: TextureDataType = HalfFloatType;
  private probed = false;

  next(gl: WebGLRenderer): WebGLRenderTarget {
    if (!this.probed) {
      this.probed = true;
      this.size = getQuality().tier === "low" ? 288 : 448;
      const ctx = gl.getContext();
      const floatOk =
        !!ctx.getExtension("EXT_color_buffer_half_float") ||
        !!ctx.getExtension("EXT_color_buffer_float");
      this.type = floatOk ? HalfFloatType : UnsignedByteType;
    }

    if (this.targets.length < POOL_SIZE) {
      const rt = new WebGLRenderTarget(this.size, this.size, {
        type: this.type,
        depthBuffer: true,
        stencilBuffer: false,
        minFilter: LinearFilter,
        magFilter: LinearFilter,
        generateMipmaps: false,
      });
      rt.texture.name = "smile-maker/photo";
      trackRenderTarget(rt);
      this.targets.push(rt);
      this.cursor = this.targets.length - 1;
      return rt;
    }

    this.cursor = (this.cursor + 1) % this.targets.length;
    return this.targets[this.cursor];
  }

  release(): void {
    for (const rt of this.targets) untrackRenderTarget(rt);
    this.targets.length = 0;
    this.cursor = -1;
    this.probed = false;
  }
}

/* ------------------------------------------------------------------ */
/* Interaction state (per scene instance, never per frame)             */
/* ------------------------------------------------------------------ */

type Orbit = {
  yaw: number;
  pitch: number;
  yawTo: number;
  pitchTo: number;
  /** True only while `returnToFront` is easing the booth back. See `stepOrbit`. */
  returning: boolean;
  active: boolean;
  lastX: number;
  lastY: number;
};

type Pending = { active: boolean; x: number; y: number };

type Drag = {
  active: boolean;
  index: number;
  moved: boolean;
  cx: number;
  cy: number;
  /** World radius that reads as `SNAP_SCREEN` of the picture at this drag sheet's depth. */
  snapR: number;
};

type PhotoState = {
  phase: number;
  t: number;
  slide: number;
  roll: number;
  scale: number;
  whirr: number;
  hasImage: boolean;
};

type Runtime = {
  orbit: Orbit;
  pending: Pending;
  drag: Drag;
  photo: PhotoState;
  sparkles: SparkleField;
  pool: PhotoPool;
  camera: PerspectiveCamera | null;
  /** World point at the centre of the camera prop's front element — see the polaroid. */
  lens: Vector3;
  /** True between a real pointerdown and its pointerup, anywhere in the view. */
  pointerDown: boolean;
};

function createRuntime(): Runtime {
  return {
    orbit: { yaw: 0, pitch: 0, yawTo: 0, pitchTo: 0, returning: false, active: false, lastX: 0, lastY: 0 },
    pending: { active: false, x: 0, y: 0 },
    drag: { active: false, index: -1, moved: false, cx: 0, cy: 0, snapR: 0.8 },
    photo: {
      phase: PHOTO_HIDDEN,
      t: 0,
      slide: 0,
      roll: -0.055,
      scale: 1,
      whirr: 0,
      hasImage: false,
    },
    sparkles: createSparkles(SPARKLES),
    pool: new PhotoPool(),
    camera: null,
    lens: new Vector3(),
    pointerDown: false,
  };
}

/* ------------------------------------------------------------------ */
/* Step functions — module level so the frame closes over nothing      */
/* ------------------------------------------------------------------ */

/**
 * ## The orbit stays where the child left it — round 4, SM8
 *
 * "In a sandbox whose only reward is admiring what you made, the orbit springs back to
 * front-on a second after the child stops turning it — which is also why the three 'orbit
 * angle' captures differ by only 2.6-6.1 mean absolute pixel levels."
 *
 * That is the whole finding and it is right: `ORBIT_HOLD = 1.15` then a damped return to
 * zero meant the booth took itself back. Turning a turntable is this game's second
 * interaction and the only way to see the back of a cape or the side of a hat; a view that
 * undoes itself is not a view the child owns.
 *
 * So there is no return at all any more. The orbit is a **position**, not a gesture: it is
 * held until the child changes it, or until one of the three things that legitimately
 * re-frames the shot happens — Clear, Surprise or a photo — each of which calls
 * `returnToFront()`. Those three are the beats where the booth is presenting something new
 * rather than showing what the child made, and a photo in particular is composed from the
 * front.
 *
 * The damped follow stays: the camera still eases toward the target angle rather than
 * snapping to it, which is what makes a drag feel like a turntable and not a scrollbar.
 */
function stepOrbit(o: Orbit, dt: number, reduced: boolean): void {
  if (reduced) {
    // Direct manipulation only: no inertia, no drift, and — as everywhere else — no easing
    // back to a framing the child did not ask for. A return requested by Clear, Surprise or
    // the shutter is dropped rather than queued, so it cannot fire later when the child
    // touches the booth again.
    o.returning = false;
    o.yaw = damp(o.yaw, o.yawTo, ORBIT_REDUCED_LAMBDA, dt);
    o.pitch = damp(o.pitch, o.pitchTo, ORBIT_REDUCED_LAMBDA, dt);
    return;
  }
  if (o.returning) {
    o.yawTo = damp(o.yawTo, 0, ORBIT_RETURN_LAMBDA, dt);
    o.pitchTo = damp(o.pitchTo, 0, ORBIT_RETURN_LAMBDA, dt);
    if (Math.abs(o.yawTo) < 1e-3 && Math.abs(o.pitchTo) < 1e-3) {
      o.yawTo = 0;
      o.pitchTo = 0;
      o.returning = false;
    }
  }
  o.yaw = damp(o.yaw, o.yawTo, ORBIT_FOLLOW_LAMBDA, dt);
  o.pitch = damp(o.pitch, o.pitchTo, ORBIT_FOLLOW_LAMBDA, dt);
}

/**
 * Sends the booth back to front-on, slowly, like a turntable settling.
 *
 * Called from exactly three places — Clear, Surprise and the shutter — and never on a timer.
 * See `stepOrbit`.
 */
function returnToFront(o: Orbit): void {
  if (Math.abs(o.yawTo) < 1e-3 && Math.abs(o.pitchTo) < 1e-3) return;
  o.returning = true;
}

/**
 * Layers the orbit on top of whatever `CameraRig` just wrote.
 *
 * The rig owns the framing and the breathe. This re-expresses the camera as an azimuth and
 * an elevation about **the rig's own aim point**, adds the orbit, clamps the elevation so
 * the booth can never go over the top or under the floor, and re-aims. Recomputed from the
 * rig's fresh output every frame, so nothing accumulates and a resize that moves the framing
 * is picked up immediately.
 *
 * The aim point is read back off the camera's forward vector rather than taken from the
 * static `framing` target, and that is the whole of G-SM-10. `cam.lookAt(framing.tx, ...)`
 * threw away the rig's angular breathe every single frame: `camera.ts` slides the aim point
 * along the camera's own right and up axes to produce it, so overwriting the aim point
 * overwrites the breathe. Only the positional component — camera and aim moving together —
 * survived, which round 2 measured as about 0.2 degrees of the 0.35 the spec allows.
 *
 * Reading it back costs one quaternion rotation and is exact: any point on the view ray
 * reproduces the rig's orientation under `lookAt`, and taking it at distance `r` means an
 * orbit of zero reproduces the rig's position bit for bit as well. Shake, which translates
 * camera and aim by the same vector, comes through untouched for the same reason.
 */
function applyOrbit(cam: PerspectiveCamera, o: Orbit): void {
  const dx = cam.position.x - framing.tx;
  const dy = cam.position.y - framing.ty;
  const dz = cam.position.z - framing.tz;
  const r = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (r < 1e-4) return;

  _dir.set(0, 0, -1).applyQuaternion(cam.quaternion);
  const ax = cam.position.x + _dir.x * r;
  const ay = cam.position.y + _dir.y * r;
  const az = cam.position.z + _dir.z * r;

  // The camera sits at -forward * r from the aim point, so its azimuth and elevation about
  // that point are read straight off the forward vector.
  const azimuth = Math.atan2(-_dir.x, -_dir.z) + o.yaw;
  let el = Math.asin(clamp(-_dir.y, -1, 1)) + o.pitch;
  if (el < ELEVATION_MIN) el = ELEVATION_MIN;
  else if (el > ELEVATION_MAX) el = ELEVATION_MAX;

  const horizontal = Math.cos(el) * r;
  cam.position.set(
    ax + horizontal * Math.sin(azimuth),
    ay + Math.sin(el) * r,
    az + horizontal * Math.cos(azimuth)
  );
  cam.lookAt(ax, ay, az);
}

/**
 * Where the ray from the camera through `(ax, ay, az)` crosses the current drag sheet.
 *
 * This is what puts the target ring on top of an anchor that may be behind the tooth: the
 * ring lands at the anchor's *screen* position but at the depth the prop is being dragged
 * at, so it is never occluded and the snap test is a plain distance between two points on
 * one plane.
 */
function planeTargetFor(
  cam: PerspectiveCamera,
  ax: number,
  ay: number,
  az: number,
  out: Vector3
): boolean {
  _dir.set(ax - cam.position.x, ay - cam.position.y, az - cam.position.z);
  const len = _dir.length();
  if (len < 1e-5) return false;
  _dir.multiplyScalar(1 / len);
  _ray.origin.copy(cam.position);
  _ray.direction.copy(_dir);
  return _ray.intersectPlane(_dragPlane, out) !== null;
}

function stepProp(
  a: PropAnim,
  dt: number,
  reduced: boolean,
  restX: number,
  restY: number,
  restZ: number
): void {
  if (a.mode === MODE_FLY) {
    if (a.delay > 0) {
      // Held on the shelf while the press spring winds the prop down into it. Position is
      // untouched; `root.position` adds `n * pop`, so the dip is what renders.
      a.delay -= dt;
    } else {
      a.t += dt;
    }
    const k = clamp01(a.t / a.dur);
    /*
     * `easeOutBack(k, 1.6)`, not 1.5. `3D-SPEC §4.1` fixes the settle band's overshoot floor
     * at 1.6 (9.0 %) and this site shipped 1.5 (8.0 %) — one point of overshoot below a band
     * whose whole purpose is that a landing is *seen* to land. A snap onto an anchor is a
     * landing a child is waiting on, so it takes the band rather than the exception.
     */
    const e = a.snap ? easeOutBack(k, 1.6) : easeOutCubic(k);
    if (e <= 1) {
      const u = 1 - e;
      const w0 = u * u;
      const w1 = 2 * u * e;
      const w2 = e * e;
      a.px = w0 * a.fx + w1 * a.cx + w2 * a.gx;
      a.py = w0 * a.fy + w1 * a.cy + w2 * a.gy;
      a.pz = w0 * a.fz + w1 * a.cz + w2 * a.gz;
    } else {
      // Past the anchor. Travel along the arrival tangent by a fixed distance rather than
      // extrapolating the curve, which would swing the prop back toward the control point.
      const over = (e - 1) * OVERSHOOT_DIST;
      a.px = a.gx + a.ox * over;
      a.py = a.gy + a.oy * over;
      a.pz = a.gz + a.oz * over;
    }
    if (!a.landed && k > 0.86) {
      a.landed = true;
      a.squash.impulse(a.snap ? SNAP_IMPULSE : RETURN_IMPULSE);
      a.wobble.impulse(a.index % 2 === 0 ? 1.6 : -1.6);
      // The click. Fired from the frame because it has to land on the same frame as the
      // squash — it is a discrete, once-per-flight call, not per-frame work.
      if (a.snap) sounds.pop();
    }
    if (a.delay <= 0 && a.t >= a.dur) {
      a.mode = MODE_IDLE;
      a.px = a.gx;
      a.py = a.gy;
      a.pz = a.gz;
    }
  } else if (a.mode === MODE_DRAG) {
    const lambda = reduced ? ORBIT_REDUCED_LAMBDA : DRAG_LAMBDA;
    const k = Math.exp(-lambda * dt);
    a.px = a.dx + (a.px - a.dx) * k;
    a.py = a.dy + (a.py - a.dy) * k;
    a.pz = a.dz + (a.pz - a.dz) * k;
  } else {
    const k = Math.exp(-IDLE_LAMBDA * dt);
    a.px = restX + (a.px - restX) * k;
    a.py = restY + (a.py - restY) * k;
    a.pz = restZ + (a.pz - restZ) * k;
  }

  a.pop.step(dt);
  a.scale.step(dt);
  a.squash.to(0);
  a.squash.step(dt);
  a.wobble.to(0);
  a.wobble.step(dt);

  a.yaw = dampAngle(a.yaw, a.yawTo, TURN_LAMBDA, dt);
  a.pitch = damp(a.pitch, a.pitchTo, TURN_LAMBDA, dt);
  a.roll = damp(a.roll, a.rollTo, TURN_LAMBDA, dt);

  if (a.popT > 0) a.popT -= dt;
}

/** Extra scale pop used only on the reduced-motion path. */
function popAmount(a: PropAnim): number {
  if (a.popT <= 0) return 0;
  const q = clamp01(1 - a.popT / a.popDur);
  return a.popAmp * Math.sin(q * Math.PI);
}

/** The crown, in world space — `SceneBuild["head"]`. */
type HeadBounds = { topY: number; radius: number };

/**
 * True when no sampled point of the curve is inside the crown.
 *
 * "Inside the crown" is a cylinder of `radius` capped at `topY`, plus `HEAD_CLEARANCE` on
 * both, because that is the shape a hat actually has to get over. Two neighbourhoods are
 * exempt: the last `LANDING_R` of the approach and the first `LANDING_R` of the take-off.
 * They have to be, because the `top` anchor is *sunk* 0.09 tooth-local units below the
 * surface — that is what puts the crown of the tooth inside a hat rather than the hat
 * perched on the tip — so both the goal of putting a hat on and the start of taking one off
 * are inside the crown by construction. What the test governs is the middle of the flight:
 * the part that used to go through the face.
 */
function curveClears(a: PropAnim, cy: number, head: HeadBounds): boolean {
  const rr = head.radius + HEAD_CLEARANCE;
  const rr2 = rr * rr;
  const ceiling = head.topY + HEAD_CLEARANCE;
  for (let i = 1; i < ARC_SAMPLES - 1; i++) {
    const t = i / (ARC_SAMPLES - 1);
    const u = 1 - t;
    const w0 = u * u;
    const w1 = 2 * u * t;
    const w2 = t * t;
    const x = w0 * a.fx + w1 * a.cx + w2 * a.gx;
    const y = w0 * a.fy + w1 * cy + w2 * a.gy;
    const z = w0 * a.fz + w1 * a.cz + w2 * a.gz;
    if (y >= ceiling) continue;
    const gx = x - a.gx;
    const gy = y - a.gy;
    const gz = z - a.gz;
    if (gx * gx + gy * gy + gz * gz < LANDING_R2) continue;
    const fx = x - a.fx;
    const fy = y - a.fy;
    const fz = z - a.fz;
    if (fx * fx + fy * fy + fz * fz < LANDING_R2) continue;
    if (x * x + z * z < rr2) return false;
  }
  return true;
}

/**
 * Picks the control point for a flight, and with it the shape of the arc.
 *
 * For an ordinary flight — glasses onto the eyes, a bow tie to the neck, anything going back
 * to its shelf slot — the control point is the midpoint lifted a little, which is the gentle
 * lob the game always had. (Measured: with that lift alone, none of the seven non-overhead
 * anchors puts any part of its path inside the crown, in either direction.)
 *
 * For a flight to or from the `top` anchor the lift is raised in steps until the curve
 * clears the crown, and the control point is biased three quarters of the way toward the
 * goal so the descent is steep rather than diagonal. A hat therefore leaves the shelf, rises
 * about 0.25 units over the crown, and comes down onto it; taking one off runs the same path
 * backwards. It passes behind `GameShell`'s title band on the way, which is where a hat
 * thrown over a tooth's head ought to be.
 *
 * Runs once per flight, off a discrete event: at most 25 lift steps x 11 samples.
 */
function solveFlightArc(a: PropAnim, head: HeadBounds, overhead: boolean): void {
  const bias = overhead ? 0.72 : 0.5;
  a.cx = a.fx + (a.gx - a.fx) * bias;
  a.cz = a.fz + (a.gz - a.fz) * bias;

  const base = (a.fy > a.gy ? a.fy : a.gy) + (a.snap ? SNAP_ARC : RETURN_ARC);
  a.cy = base;

  if (overhead) {
    let lift = 0;
    for (; lift <= ARC_LIFT_MAX; lift += ARC_LIFT_STEP) {
      if (curveClears(a, base + lift, head)) break;
    }
    a.cy = base + (lift > ARC_LIFT_MAX ? ARC_LIFT_MAX : lift);
  }

  // Unit arrival tangent. B'(1) = 2 * (P2 - P1); direction is all the overshoot needs.
  let ox = a.gx - a.cx;
  let oy = a.gy - a.cy;
  let oz = a.gz - a.cz;
  const len = Math.sqrt(ox * ox + oy * oy + oz * oz);
  if (len > 1e-5) {
    ox /= len;
    oy /= len;
    oz /= len;
  } else {
    ox = 0;
    oy = -1;
    oz = 0;
  }
  a.ox = ox;
  a.oy = oy;
  a.oz = oz;
}

function startFlight(
  a: PropAnim,
  gx: number,
  gy: number,
  gz: number,
  snap: boolean,
  reduced: boolean,
  head: HeadBounds,
  overhead: boolean
): void {
  if (reduced) {
    a.px += a.nx * a.pop.value;
    a.py += a.ny * a.pop.value;
    a.pz += a.nz * a.pop.value;
    a.pop.set(0);
    a.mode = MODE_IDLE;
    a.delay = 0;
    a.px = gx;
    a.py = gy;
    a.pz = gz;
    reducedPop(a, snap ? -0.15 : -0.1);
    return;
  }

  if (Math.abs(a.pop.value) < PRESS_TRAVEL_EPS) {
    // The press has not travelled yet: this is a keyboard or assistive activation, where
    // `onPress` and `onSelect` ran in one tick. Hold the launch for a few frames and let the
    // pick-up impulse render as a dip into the shelf first (G-SM-11). The pop is left live
    // deliberately — it decays to zero *during* the flight, so the prop peels off the shelf
    // instead of teleporting off it.
    a.delay = FEEL.windUp;
    a.pop.to(0);
  } else {
    // Fold the drag pop into the position first, so the flight starts exactly where the prop
    // was seen to be rather than at the point it was mathematically hovering over.
    a.px += a.nx * a.pop.value;
    a.py += a.ny * a.pop.value;
    a.pz += a.nz * a.pop.value;
    a.pop.set(0);
    a.delay = 0;
  }

  a.mode = MODE_FLY;
  a.t = 0;
  a.dur = snap ? SNAP_DUR : RETURN_DUR;
  a.fx = a.px;
  a.fy = a.py;
  a.fz = a.pz;
  a.gx = gx;
  a.gy = gy;
  a.gz = gz;
  a.snap = snap;
  a.landed = false;
  solveFlightArc(a, head, overhead);
}

/* ------------------------------------------------------------------ */
/* Scene                                                               */
/* ------------------------------------------------------------------ */

type PropNode = {
  index: number;
  id: string;
  anchor: AnchorId;
  label: string;
  /** Which station on the turntable this accessory stands at — see `SLOT_OF`. */
  slot: number;
  /** Its slot's world position and fan yaw, resolved once so the frame never looks them up. */
  homeX: number;
  homeZ: number;
  homeYaw: number;
  /** Pitch the prop rests at on its pad — nonzero only for the cape. See `build.ts`. */
  homePitch: number;
  root: RefObject<Group>;
  art: RefObject<Group>;
  hit: RefObject<Group>;
  anim: PropAnim;
};

/**
 * The roving focus group the ten accessories share.
 *
 * They used to be ten separate tab stops, alone among the nine games: a keyboard child had
 * to Tab past every accessory to reach `Snap!`. `focusOrder` is the **slot** index, not the
 * accessory index, so Left and Right walk the shelf in the order a child sees it.
 *
 * `hit.tsx` uses this string as the group's `aria-label`, so it has to read as a name.
 */
const SHELF_GROUP = "Accessory shelf";
const CONTROL_GROUP = "Booth controls";

/**
 * What each control's hidden button says, and it does not change.
 *
 * `engine.canUndoClear` and `engine.photo` both flip what a press *does*; a changed
 * `ariaLabel` recreates the button and takes keyboard focus with it, which is the same
 * reason the ten accessories carry a fixed label. Each of these therefore names the object
 * and both of its presses, and `announce()` says which one just happened.
 */
const CONTROL_LABEL: Record<ControlId, string> = {
  snap: "The camera. Press Enter to take a photo of your smile, or to put the photo away.",
  surprise: "The surprise lever. Press Enter for a random smile.",
  tray: "The tray. Press Enter to clear the tooth, or to put everything back on it again.",
};

/** Reading order for the three: the way the eye crosses the table, left to right. */
const CONTROL_ORDER: Record<ControlId, number> = { snap: 0, surprise: 1, tray: 2 };

const controlSlot = (id: ControlId): ControlSlot => {
  const slot = CONTROL_SLOTS.find((c) => c.id === id);
  if (!slot) throw new Error(`[smile-maker] no CONTROL_SLOTS entry for "${id}"`);
  return slot;
};

const PODIUM_POS: [number, number, number] = [0, PODIUM_H / 2, 0];
const BOOTH_BLOB_POS: [number, number, number] = [0, 0.004, 0];
const PHOTO_CAPTION_POS: [number, number, number] = [0, PHOTO_CAPTION_Y, PHOTO_PAPER_T / 2 + 0.005];
const PHOTO_IMAGE_POS: [number, number, number] = [0, PHOTO_IMAGE_Y, PHOTO_PAPER_T / 2 + 0.004];
const PHOTO_IMAGE_SCALE: [number, number, number] = [PHOTO_IMAGE, PHOTO_IMAGE, 1];

function SmileMakerSceneImpl({ engine }: { engine: SmileMakerEngine }): JSX.Element {
  /*
   * **The entry frame builds the tooth and nothing else.**
   *
   * Round 4, SM3 measured a 299.1 ms frame entering this game — eighteen dropped frames at
   * 60 Hz and the worst entry hitch anywhere in the round — and the compile events in the
   * same capture put shader compilation at 2.2 ms of it. It was `buildSmileScene()`, called
   * synchronously here. `build.ts` now splits: `buildBooth()` is the hero tooth, its face,
   * the anchors and the head bounds, and each accessory is built on its own idle callback
   * afterwards. Measured headlessly against the real code (`scratchpad/sm/staged.mjs`, with
   * the shared textures already warm the way `Stage`'s boot warm-up leaves them):
   *
   * ```
   *              before        after
   *   entry      299.1 ms      48.1 ms first ever entry, 5.5 ms on any later one
   *   worst      —             23.8 ms, on an idle callback, once per session
   * ```
   */
  const build = useMemo(() => buildBooth(), []);
  const bag = useMemo(() => new DisposalBag(), []);
  const rt = useMemo(() => createRuntime(), []);
  const controls = useMemo(() => buildControls(build.owned), [build]);

  /**
   * How many accessories exist. Bumped once per arrival — ten discrete renders in the first
   * second and never again — not per frame.
   *
   * The `build` object itself never changes identity, so `nodes` below is not rebuilt and no
   * ref is remounted; what changes is the contents of `build.props[i]`, which the JSX reads
   * on the render this triggers and the frame loop re-reads every frame.
   */
  const [built, setBuilt] = useState(0);

  /** The only other thing that re-renders this component: the polaroid's keyboard target. */
  const [photoOut, setPhotoOut] = useState(false);

  /* ---------------- shared, cached resources ---------------- */

  const quadGeo = useMemo(
    () => cachedGeometry("smile-maker/quad", () => new PlaneGeometry(1, 1)),
    []
  );
  const sheetGeo = useMemo(
    () => cachedGeometry("smile-maker/sheet", () => new PlaneGeometry(10, 10)),
    []
  );
  const ringGeo = useMemo(() => shelfRingGeometry(RING_INNER, RING_OUTER, RING_TOP), []);
  const padGeo = useMemo(() => roundedCylinder(PAD_R, PAD_H, 0.018), []);
  const podiumGeo = useMemo(() => roundedCylinder(PODIUM_R, PODIUM_H, 0.05), []);
  const anchorGeo = useMemo(() => torusSoft(ANCHOR_RING_R, 0.034), []);
  const paperGeo = useMemo(
    () => roundedPlate(PHOTO_W, PHOTO_H, PHOTO_PAPER_T, 0.045),
    []
  );

  const shelfMat = useMemo(() => shelfMaterial(), []);
  const podiumMat = useMemo(() => podiumMaterial(), []);
  const paperMat = useMemo(() => paperMaterial(), []);
  const anchorMat = useMemo(() => anchorMaterial(), []);
  const toothMat = useMemo(() => toothMaterial(), []);
  const blobMat = useMemo(() => shadowBlobMaterial(), []);
  /** Reciprocal of the blob material's own tint — see the fade in the frame loop. */
  const blobInvTint = useMemo(
    () =>
      [
        1 / Math.max(1e-4, blobMat.color.r),
        1 / Math.max(1e-4, blobMat.color.g),
        1 / Math.max(1e-4, blobMat.color.b),
      ] as const,
    [blobMat]
  );

  /* ---------------- resources this game owns ---------------- */

  /*
   * The caption waits for Manrope.
   *
   * `textTexture` caches by its option set, not by which font actually drew it, so calling
   * it before the webfont is usable would bake a system-ui version into the shared cache and
   * every later call would get that back. One await, one discrete re-render, correct type.
   */
  const [caption, setCaption] = useState<TextTexture | null>(null);

  useEffect(() => {
    let alive = true;
    void ensureManrope().then(() => {
      if (!alive) return;
      setCaption(
        textTexture(engine.caption, {
          fontSize: 62,
          weight: 800,
          color: NEUTRAL.ink,
          maxWidth: 560,
        })
      );
    });
    return () => {
      alive = false;
    };
  }, [engine]);

  const captionScale = useMemo<[number, number, number]>(() => {
    if (!caption) return [1, 1, 1];
    const h = Math.min(0.135, (PHOTO_W - 0.14) / Math.max(caption.aspect, 0.01));
    return [h * caption.aspect, h, 1];
  }, [caption]);

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

  /**
   * The print. Unlit on purpose: the pixels in the render target are already a lit,
   * fogged render of the booth, so shading them a second time would be wrong. Tone mapping
   * stays on, because the capture skipped it — see `PhotoPool`.
   */
  const photoMat = useMemo(() => new MeshBasicMaterial({ toneMapped: true }), []);

  const captionMat = useMemo(
    () =>
      new MeshBasicMaterial({
        transparent: true,
        depthWrite: false,
        toneMapped: true,
      }),
    []
  );

  useEffect(() => {
    if (!caption) return;
    captionMat.map = caption.texture;
    captionMat.needsUpdate = true;
  }, [caption, captionMat]);

  const sheetMat = useMemo(() => new MeshBasicMaterial({ visible: false }), []);

  useEffect(() => {
    bag.add(sparkleMat);
    bag.add(photoMat);
    bag.add(captionMat);
    bag.add(sheetMat);
    bag.onRelease(() => rt.pool.release());
    return () => bag.release();
  }, [bag, rt, sparkleMat, photoMat, captionMat, sheetMat]);

  /*
   * `build.owned` **grows** as the accessories arrive, so it is swept again on every change
   * rather than once on mount. `DisposalBag.add` appends without checking, so the sweep is
   * indexed rather than restarted: adding a geometry twice would dispose it twice and count
   * it twice in `?selftest=memory`'s ledger.
   *
   * The bag's own `release()` lives in the effect above, which is declared first and whose
   * cleanup therefore runs first at unmount — by which point every geometry any of these
   * callbacks created is already in it, because the build effect's cleanup cancels the
   * pending idle callback in the same commit.
   */
  const bagged = useRef(0);
  useEffect(() => {
    while (bagged.current < build.owned.length) bag.add(build.owned[bagged.current++]);
  }, [bag, build, built, controls]);

  /**
   * The camera's lens, in world space — where the print is born and where it goes back to.
   *
   * Resolved once from the built control rather than written down twice: the prop's own
   * `lens` point put through the yaw that turns it to face the tooth and the translation
   * that stands it on the table, which is exactly the transform the group in the graph
   * applies.
   */
  useEffect(() => {
    const camera = controls.find((c) => c.id === "snap");
    if (!camera?.lens) return;
    const slot = controlSlot("snap");
    const yaw = controlYaw(slot);
    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    const [lx, ly, lz] = camera.lens;
    rt.lens.set(slot.x + lx * cos + lz * sin, ly, slot.z - lx * sin + lz * cos);
  }, [controls, rt]);

  /**
   * The shelf fills itself in.
   *
   * One accessory per idle callback, so the browser places the work where it has room
   * instead of inside the frame the child is watching, and the arrival rides the same
   * `easeOutBack` snap a landing uses (`stepProp` damps every prop toward
   * `slotY + build.props[i].shelfLift`, which is 0 until the prop exists and its real value
   * afterwards — so a prop that arrives late rises into its slot rather than popping).
   *
   * `requestIdleCallback` with a timeout, falling back to a timer where the engine has no
   * idle callback: the timeout is what stops a busy first second from leaving the shelf
   * empty, and the fallback is what stops it on Safari before 16.4.
   */
  useEffect(() => {
    if (build.built >= PROP_COUNT) return;
    let cancelled = false;
    let idle = 0;
    let timer = 0;
    const step = () => {
      if (cancelled) return;
      const more = buildNextProp(build);
      setBuilt(build.built);
      if (more) schedule();
    };
    const schedule = () => {
      const ric = window.requestIdleCallback;
      if (typeof ric === "function") idle = ric(step, { timeout: 120 });
      else timer = window.setTimeout(step, 16);
    };
    schedule();
    return () => {
      cancelled = true;
      if (idle !== 0) window.cancelIdleCallback?.(idle);
      if (timer !== 0) window.clearTimeout(timer);
    };
    // `built` re-arms the chain after each arrival; `build` never changes identity.
  }, [build, built]);

  /* ---------------- nodes ---------------- */

  const nodes = useMemo<PropNode[]>(() => {
    const out: PropNode[] = [];
    for (let i = 0; i < PROP_COUNT; i++) {
      const def = ACCESSORIES[i];
      const slot = SLOT_OF[i] ?? i;
      out.push({
        index: i,
        id: def.id,
        anchor: def.anchor,
        // Deliberately stable: a label that changed on attach would recreate the hidden
        // button and steal keyboard focus. State goes through `announce()` instead — see
        // `SmileMaker.tsx`, which reports what the tooth is wearing after every change.
        label: `${def.name}, number ${slot + 1} on the shelf. Press Enter to put it ${def.place} or take it off.`,
        slot,
        homeX: slotX(slot),
        homeZ: slotZ(slot),
        homeYaw: slotAngle(slot) * SLOT_FAN,
        homePitch: build.props[i].shelfPitch,
        root: createRef<Group>(),
        art: createRef<Group>(),
        hit: createRef<Group>(),
        anim: createAnim(i, slot, build.props[i].shelfLift, build.props[i].shelfPitch),
      });
    }
    return out;
  }, [build]);

  const toothRef = useRef<Group>(null);
  const shelfRef = useRef<Group>(null);
  const padRef = useRef<InstancedMesh>(null);
  const blobRef = useRef<InstancedMesh>(null);
  const sparkRef = useRef<InstancedMesh>(null);
  const anchorRef = useRef<Mesh>(null);
  const polaroidRef = useRef<Group>(null);
  const sheetRef = useRef<Mesh>(null);
  const controlsRef = useRef<Group>(null);
  const boothBlobRef = useRef<Group>(null);

  const photoCam = useMemo(() => {
    const cam = new PerspectiveCamera(30, 1, 1, 60);
    cam.updateProjectionMatrix();
    return cam;
  }, []);

  /* ---------------- static instance buffers ---------------- */

  useLayoutEffect(() => {
    const pads = padRef.current;
    const blobs = blobRef.current;
    if (pads) {
      for (let i = 0; i < SLOT_COUNT; i++) {
        _pos.set(slotX(i), slotY - PAD_H / 2 + 0.004, slotZ(i));
        _quat.set(0, 0, 0, 1);
        _scl.set(1, 1, 1);
        _mat.compose(_pos, _quat, _scl);
        pads.setMatrixAt(i, _mat);
      }
      pads.instanceMatrix.needsUpdate = true;
    }
    if (blobs) {
      blobs.instanceMatrix.setUsage(DynamicDrawUsage);
      // Allocates `instanceColor` and marks it dynamic, so the per-instance density fade in
      // the frame loop has somewhere to write. `setColorAt` is what allocates it in three.
      _tint.setRGB(1, 1, 1);
      for (let i = 0; i < SLOT_COUNT; i++) blobs.setColorAt(i, _tint);
      if (blobs.instanceColor) blobs.instanceColor.setUsage(DynamicDrawUsage);
    }
    const spark = sparkRef.current;
    if (spark) {
      spark.instanceMatrix.setUsage(DynamicDrawUsage);
      // InstancedMesh starts with identity matrices, which would park a full-size sparkle
      // at the origin until the first burst.
      _pos.set(0, 0, 0);
      _quat.set(0, 0, 0, 1);
      _scl.set(0, 0, 0);
      _mat.compose(_pos, _quat, _scl);
      for (let i = 0; i < SPARKLES; i++) spark.setMatrixAt(i, _mat);
      spark.instanceMatrix.needsUpdate = true;
    }
    for (const node of nodes) {
      const root = node.root.current;
      if (root) root.rotation.order = "YXZ";
    }
  }, [nodes]);

  /* ---------------- engine events ---------------- */

  const restOf = useCallback(
    (node: PropNode, attached: boolean, out: Vector3): void => {
      if (attached) out.copy(build.anchors[node.anchor]);
      else out.set(node.homeX, slotY + build.props[node.index].shelfLift, node.homeZ);
    },
    [build]
  );

  useEffect(
    () =>
      engine.on((event) => {
        const reduced = isReduced();
        switch (event.type) {
          case "place": {
            const node = nodes[event.index];
            if (!node) break;
            const a = node.anim;
            a.attached = event.attached;
            a.scale.to(event.attached ? 1 : shelfScale(event.index));
            restOf(node, event.attached, _pos);
            startFlight(a, _pos.x, _pos.y, _pos.z, event.attached, reduced, build.head, node.anchor === "top");
            if (event.attached) {
              a.yawTo = build.props[event.index].attachYaw;
              a.pitchTo = build.props[event.index].attachPitch;
              a.rollTo = build.props[event.index].attachRoll;
              burst(rt.sparkles, _pos.x, _pos.y + 0.1, _pos.z, 0.3, reduced ? 4 : 9, reduced);
            } else {
              a.yawTo = node.homeYaw;
              a.pitchTo = node.homePitch;
              a.rollTo = 0;
            }
            break;
          }
          case "displace": {
            const node = nodes[event.index];
            if (!node) break;
            const a = node.anim;
            a.attached = false;
            a.scale.to(shelfScale(event.index));
            a.yawTo = node.homeYaw;
            a.pitchTo = node.homePitch;
            a.rollTo = 0;
            restOf(node, false, _pos);
            startFlight(a, _pos.x, _pos.y, _pos.z, false, reduced, build.head, node.anchor === "top");
            break;
          }
          case "layout": {
            for (let i = 0; i < nodes.length; i++) {
              const node = nodes[i];
              const a = node.anim;
              const attached = engine.worn[i] === 1;
              if (a.attached === attached && a.mode === MODE_IDLE) continue;
              a.attached = attached;
              a.scale.to(attached ? 1 : shelfScale(i));
              a.yawTo = attached ? build.props[i].attachYaw : node.homeYaw;
              a.pitchTo = attached ? build.props[i].attachPitch : node.homePitch;
              a.rollTo = attached ? build.props[i].attachRoll : 0;
              restOf(node, attached, _pos);
              startFlight(a, _pos.x, _pos.y, _pos.z, attached, reduced, build.head, node.anchor === "top");
            }
            if (event.reason === "reset") resetSparkles(rt.sparkles);
            // Clear and Surprise are the booth presenting something new rather than showing
            // what the child made, so they are two of the three beats that re-frame it.
            returnToFront(rt.orbit);
            break;
          }
          case "nudge": {
            // Every shelf prop hops and wobbles: "these go on the tooth". Discrete, and the
            // same springs a landing uses, so it costs nothing and reads as the same world.
            for (let i = 0; i < nodes.length; i++) {
              const a = nodes[i].anim;
              if (a.attached || a.mode !== MODE_IDLE) continue;
              if (reduced) {
                reducedPop(a, 0.18);
              } else {
                a.squash.impulse(-3.6);
                a.wobble.impulse(i % 2 === 0 ? 2.4 : -2.4);
                a.pop.impulse(1.6);
              }
            }
            break;
          }
          case "photo": {
            // The third: a photograph is composed from the front.
            returnToFront(rt.orbit);
            rt.photo.phase = PHOTO_ARMING;
            rt.photo.t = 0;
            rt.photo.whirr = 0;
            burst(rt.sparkles, 0, TOOTH_BASE_Y + 0.9, 0.35, 1.2, reduced ? 6 : 16, reduced);
            setPhotoOut(true);
            break;
          }
          case "dismiss": {
            if (rt.photo.phase !== PHOTO_HIDDEN) {
              rt.photo.phase = PHOTO_LEAVING;
              rt.photo.t = 0;
            }
            setPhotoOut(false);
            break;
          }
          default:
            break;
        }
      }),
    [engine, nodes, build, rt, restOf]
  );

  /* ---------------- pointer ---------------- */

  const beginDrag = useCallback(
    (index: number) => {
      if (rt.drag.active) {
        // A second finger while the first is still down is ignored; a drag left over from
        // an interaction that never got its pointerup is cleared rather than left to make
        // this prop permanently unpickable.
        if (rt.pointerDown) return;
        rt.drag.active = false;
      }
      // Cleared first: `onSelect` reads it a moment later to tell a tap from a drag, and a
      // press that bails out below must not leave the previous drag's answer behind.
      rt.drag.moved = false;
      const node = nodes[index];
      const cam = rt.camera;
      if (!node || !cam) return;
      if (engine.photo) engine.dismissPhoto();

      rt.drag.active = true;
      rt.drag.index = index;
      rt.drag.cx = rt.pending.x;
      rt.drag.cy = rt.pending.y;
      rt.pending.active = false;

      // One camera-facing sheet, parked in front of the booth: the prop stays in clear view
      // for the whole drag whichever anchor it belongs to (see DRAG_PLANE_LIFT).
      _planeN.set(0, 0, 1).applyQuaternion(cam.quaternion).normalize();
      _pos.set(
        framing.tx + _planeN.x * DRAG_PLANE_LIFT,
        framing.ty + _planeN.y * DRAG_PLANE_LIFT,
        framing.tz + _planeN.z * DRAG_PLANE_LIFT
      );
      _dragPlane.setFromNormalAndCoplanarPoint(_planeN, _pos);
      rt.drag.snapR = SNAP_SCREEN * cam.position.distanceTo(_pos) * TAN_HALF_FOV;

      const a = node.anim;
      a.nx = _planeN.x;
      a.ny = _planeN.y;
      a.nz = _planeN.z;
      a.mode = MODE_DRAG;
      a.dx = a.px;
      a.dy = a.py;
      a.dz = a.pz;
      a.scale.to(1.06);
      a.yawTo = build.props[index].attachYaw;
      a.pitchTo = build.props[index].attachPitch;
      a.rollTo = build.props[index].attachRoll;
      // Wind-up: the prop presses down into the shelf before it lifts (3D-SPEC §4).
      a.pop.set(0);
      a.pop.to(DRAG_POP);
      a.pop.impulse(-2.4);
      sounds.pop();
    },
    [engine, nodes, build, rt]
  );

  const endDrag = useCallback(
    (index: number) => {
      if (!rt.drag.active || rt.drag.index !== index) return;
      rt.drag.active = false;
      const node = nodes[index];
      const a = node.anim;
      a.pop.to(0);
      a.scale.to(a.attached ? 1 : shelfScale(index));

      if (!rt.drag.moved) {
        // A tap, not a drag. `onSelect` has either already toggled it (pointer) or is about
        // to (keyboard); either way only an untouched prop needs putting back.
        if (a.mode === MODE_DRAG) a.mode = MODE_IDLE;
        return;
      }

      const cam = rt.camera;
      const anchor = build.anchors[node.anchor];
      let near = false;
      if (cam && planeTargetFor(cam, anchor.x, anchor.y, anchor.z, _target)) {
        const dx = a.px - _target.x;
        const dy = a.py - _target.y;
        const dz = a.pz - _target.z;
        near = dx * dx + dy * dy + dz * dz <= rt.drag.snapR * rt.drag.snapR;
      }
      engine.place(index, near);
    },
    [engine, nodes, build, rt]
  );

  /**
   * One press handler for all three controls.
   *
   * Each object has two states and the object decides which one a press means — the camera
   * takes a photo or puts one away, the tray clears or gives back — so there is nothing here
   * for a child to get wrong and no control that is ever dead. `engine.takePhoto()` on a
   * bare tooth answers with a wiggle from the whole shelf and a spoken invitation rather
   * than refusing, which is why `Snap` was never `disabled` in the DOM row either.
   */
  const pressControl = useCallback(
    (id: ControlId) => {
      switch (id) {
        case "snap":
          if (engine.photo) engine.dismissPhoto();
          else engine.takePhoto();
          break;
        case "surprise":
          engine.randomize();
          break;
        case "tray":
          if (engine.canUndoClear) engine.undoClear();
          else engine.reset();
          break;
        default:
          break;
      }
    },
    [engine]
  );

  const onSheetDown = useCallback(
    (e: ThreeEvent<PointerEvent>) => {
      // Recorded, not acted on: `HitTarget` picks up the same native event a moment later
      // and clears this if the press landed on a prop. Promotion to an orbit happens on
      // the first move, which is also what stops a plain tap from nudging the camera.
      rt.pointerDown = true;
      rt.pending.active = true;
      rt.pending.x = e.clientX;
      rt.pending.y = e.clientY;
    },
    [rt]
  );

  const onSheetMove = useCallback(
    (e: ThreeEvent<PointerEvent>) => {
      if (rt.drag.active) {
        const node = nodes[rt.drag.index];
        if (!node) return;
        if (e.ray.intersectPlane(_dragPlane, _hitPoint)) {
          node.anim.dx = _hitPoint.x;
          node.anim.dy = _hitPoint.y;
          node.anim.dz = _hitPoint.z;
        }
        if (!rt.drag.moved) {
          const mx = e.clientX - rt.drag.cx;
          const my = e.clientY - rt.drag.cy;
          if (mx * mx + my * my > DRAG_PX * DRAG_PX) rt.drag.moved = true;
        }
        return;
      }

      if (!rt.pending.active) return;
      const o = rt.orbit;
      if (!o.active) {
        o.active = true;
        o.lastX = rt.pending.x;
        o.lastY = rt.pending.y;
      }
      const dx = e.clientX - o.lastX;
      const dy = e.clientY - o.lastY;
      o.lastX = e.clientX;
      o.lastY = e.clientY;
      o.returning = false;
      o.yawTo = clamp(o.yawTo - dx * ORBIT_YAW_PER_PX, -YAW_LIMIT, YAW_LIMIT);
      o.pitchTo = clamp(o.pitchTo + dy * ORBIT_PITCH_PER_PX, PITCH_MIN, PITCH_MAX);
    },
    [nodes, rt]
  );

  /*
   * A pointer drag ends here, on `window`, and deliberately *not* on `HitTarget`'s
   * `onRelease`.
   *
   * `HitTarget` calls `onRelease` from `onPointerOut` as well as from `pointerup`, which is
   * correct for a button — sliding off a button must cancel it — and fatal for a drag: the
   * prop leaves its own collider on the very first frame it follows the finger, and the
   * drop would resolve instantly, back at the shelf. Ending on `window` also means a finger
   * that leaves the play area still puts the prop down properly.
   */
  useEffect(() => {
    const end = () => {
      rt.pointerDown = false;
      rt.pending.active = false;
      rt.orbit.active = false;
      if (rt.drag.active) endDrag(rt.drag.index);
    };
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    return () => {
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
  }, [rt, endDrag]);

  /* ---------------- keyboard: Shift + arrows turn the booth ---------------- */

  /*
   * Plain arrow keys belong to the roving focus group, exactly as in every other game
   * (`tooth-match`, `sliding-puzzle`, `count-the-teeth`, `healthy-or-not`,
   * `spot-the-difference` all do this). They used to drive the orbit from a **window**
   * listener that called `preventDefault` unconditionally on all four arrows, with no
   * `activeElement` guard: that killed page scroll everywhere in the app while this game was
   * mounted, and it meant the ten accessories each had to be their own tab stop because
   * arrows were not available to move between them.
   *
   * The orbit is on Shift + arrow now, announced in the game's own intro. The listener stays
   * on `window` rather than on an element because the 3D scene has no focusable node of its
   * own, but it only ever claims a key it actually uses, and never one aimed at a field.
   *
   * It listens in the **capture** phase and stops propagation on the keys it takes. Without
   * that, a Shift + Arrow pressed while focus is inside the accessory group would be handled
   * twice: `hit.tsx`'s roving handler does not look at modifiers, so the booth would turn
   * *and* the focused accessory would change under the child's hands.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
      const focused = document.activeElement as HTMLElement | null;
      if (
        focused &&
        (focused.isContentEditable ||
          focused.tagName === "INPUT" ||
          focused.tagName === "TEXTAREA" ||
          focused.tagName === "SELECT")
      ) {
        return;
      }
      let dx = 0;
      let dy = 0;
      let word = "";
      switch (e.key) {
        case "ArrowLeft":
          dx = 1;
          word = "Turned left";
          break;
        case "ArrowRight":
          dx = -1;
          word = "Turned right";
          break;
        case "ArrowUp":
          dy = 1;
          word = "Looking down from above";
          break;
        case "ArrowDown":
          dy = -1;
          word = "Looking up from below";
          break;
        default:
          return;
      }
      e.preventDefault();
      e.stopPropagation();
      const o = rt.orbit;
      const yawBefore = o.yawTo;
      const pitchBefore = o.pitchTo;
      o.yawTo = clamp(o.yawTo + dx * ORBIT_KEY_YAW, -YAW_LIMIT, YAW_LIMIT);
      o.pitchTo = clamp(o.pitchTo + dy * ORBIT_KEY_PITCH, PITCH_MIN, PITCH_MAX);
      // A key press is the child taking the view, so it cancels a return in flight.
      o.returning = false;
      // A screen-reader player has no other way to know the booth moved, or that it has
      // stopped moving because it reached the end of its travel.
      if (o.yawTo === yawBefore && o.pitchTo === pitchBefore) {
        announce("That is as far as the booth turns that way.");
      } else if (Math.abs(o.yawTo) < 0.02 && Math.abs(o.pitchTo) < 0.02) {
        announce("Back to the front. The tooth is looking at you.");
      } else {
        announce(word + ".");
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [rt]);

  /* ---------------- context loss ---------------- */

  useEffect(() => {
    const rebuild = () => {
      // Every target died with the context. Drop them, blank the print and put the
      // polaroid away; the next photo builds a fresh pool.
      rt.pool.release();
      if (photoMat.map) {
        photoMat.map = null;
        photoMat.needsUpdate = true;
      }
      rt.photo.hasImage = false;
      rt.photo.phase = PHOTO_HIDDEN;
      engine.dismissPhoto();
    };
    window.addEventListener(CONTEXT_RESTORED_EVENT, rebuild);
    return () => window.removeEventListener(CONTEXT_RESTORED_EVENT, rebuild);
  }, [engine, photoMat, rt]);

  /* ---------------- capture ---------------- */

  const capture = useCallback(
    (gl: WebGLRenderer, scene: Scene, cam: PerspectiveCamera) => {
      const shelf = shelfRef.current;
      const anchorMesh = anchorRef.current;
      const polaroid = polaroidRef.current;
      const spark = sparkRef.current;

      /* 1. Take the booth out of shot: shelf, unworn props, every focus ring, the sparkle
            burst (billboarded to the wrong camera) and the polaroid itself. */
      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        if (node.hit.current) node.hit.current.visible = false;
        if (node.art.current) node.art.current.visible = node.anim.attached;
      }
      if (shelf) shelf.visible = false;
      if (anchorMesh) anchorMesh.visible = false;
      if (polaroid) polaroid.visible = false;
      if (spark) spark.visible = false;
      // The booth's own furniture, which is not what is being photographed: the camera
      // cannot appear in its own print, and the contact decal under the podium belongs to
      // the table rather than to the portrait.
      if (controlsRef.current) controlsRef.current.visible = false;
      if (boothBlobRef.current) boothBlobRef.current.visible = false;

      /* 2. Aim: the child's own viewpoint, at a portrait distance, with the elevation
            pulled into a flattering band so a photo taken from underneath still reads. */
      const dx = cam.position.x - framing.tx;
      const dy = cam.position.y - framing.ty;
      const dz = cam.position.z - framing.tz;
      const r = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
      const az = Math.atan2(dx, dz);
      const el = clamp(Math.asin(dy / r), CAPTURE_ELEVATION_MIN, CAPTURE_ELEVATION_MAX);
      const horizontal = Math.cos(el) * CAPTURE_DIST;
      photoCam.position.set(
        horizontal * Math.sin(az),
        CAPTURE_TARGET_Y + Math.sin(el) * CAPTURE_DIST,
        horizontal * Math.cos(az)
      );
      photoCam.lookAt(0, CAPTURE_TARGET_Y, 0);
      photoCam.updateMatrixWorld(true);

      /* 3. Render. The clear colour is the page cream, so the print's ground and its sky
            converge exactly the way the live scene's do. */
      const target = rt.pool.next(gl);
      gl.getClearColor(_clearColor);
      const alpha = gl.getClearAlpha();
      // Scissor is restored alongside the clear colour. It used to be switched off and left
      // off, and correctness then depended on drei's `<View>` re-asserting it on the next
      // render — which it does today and is not this function's business to rely on.
      const scissor = gl.getScissorTest();
      gl.setRenderTarget(target);
      gl.setScissorTest(false);
      gl.setClearColor(color(NEUTRAL.page), 1);
      gl.clear(true, true, false);
      gl.render(scene, photoCam);
      gl.setRenderTarget(null);
      gl.setScissorTest(scissor);
      gl.setClearColor(_clearColor, alpha);

      /* 4. Put the booth back, in the same frame — nothing has been drawn to the canvas
            yet, so the child never sees a gap. */
      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        if (node.hit.current) node.hit.current.visible = true;
        if (node.art.current) node.art.current.visible = true;
      }
      if (shelf) shelf.visible = true;
      if (anchorMesh) anchorMesh.visible = false;
      if (spark) spark.visible = true;
      if (controlsRef.current) controlsRef.current.visible = true;
      if (boothBlobRef.current) boothBlobRef.current.visible = true;

      const first = photoMat.map === null;
      photoMat.map = target.texture;
      // Only the first swap changes the shader; re-flagging every photo would rebuild the
      // program each time for nothing.
      if (first) photoMat.needsUpdate = true;
      rt.photo.hasImage = true;
    },
    [nodes, photoCam, photoMat, rt]
  );

  /* ---------------- the frame ---------------- */

  useFrame((state, delta) => {
    const cam = state.camera as PerspectiveCamera;
    if (!cam.isPerspectiveCamera) return;
    rt.camera = cam;

    const dt = safeDelta(delta);
    const reduced = isReduced();
    const elapsed = state.clock.elapsedTime;

    /* -- camera: the rig has already written its framing; layer the orbit on top -- */
    stepOrbit(rt.orbit, dt, reduced);
    applyOrbit(cam, rt.orbit);

    /* -- the pointer sheet rides in front of the camera, closer than anything else, so a
          drag is never swallowed by a prop the finger happens to pass over -- */
    const sheet = sheetRef.current;
    _fwd.set(0, 0, -1).applyQuaternion(cam.quaternion);
    _up.set(0, 1, 0).applyQuaternion(cam.quaternion);
    if (sheet) {
      sheet.position.set(
        cam.position.x + _fwd.x * PLANE_DIST,
        cam.position.y + _fwd.y * PLANE_DIST,
        cam.position.z + _fwd.z * PLANE_DIST
      );
      sheet.quaternion.copy(cam.quaternion);
    }

    /* -- the tooth breathes -- */
    const toothBob = reduced ? 0 : Math.sin(elapsed * 1.05) * 0.013;
    const toothSway = reduced ? 0 : Math.sin(elapsed * 0.72) * 0.022;
    const swayCos = Math.cos(toothSway);
    const swaySin = Math.sin(toothSway);
    const tooth = toothRef.current;
    if (tooth) {
      tooth.position.y = TOOTH_BASE_Y + toothBob;
      tooth.rotation.y = toothSway;
      /*
       * The celebration hand-off, the same one every other game uses.
       *
       * Inert today and deliberately kept: Smile Maker is the one scoreless sandbox, it
       * passes `completed={false}` to `GameShell`, and so `celebrationHeroScale()` is 1 for
       * the whole session. It is here so there is exactly one mechanism across the nine
       * games rather than eight and an exception — the day this booth grows a finish, the
       * hero already knows how to get off the stage.
       */
      const exit = celebrationHeroScale();
      tooth.scale.set(TOOTH_SCALE * exit, TOOTH_SCALE * exit, TOOTH_SCALE * exit);
    }

    /* -- props -- */
    const blobs = blobRef.current;
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      const root = node.root.current;
      const a = node.anim;

      let restX: number;
      let restY: number;
      let restZ: number;
      if (a.attached) {
        const anchor = build.anchors[node.anchor];
        restX = anchor.x * swayCos + anchor.z * swaySin;
        restY = anchor.y + toothBob;
        restZ = -anchor.x * swaySin + anchor.z * swayCos;
        a.yawTo = build.props[i].attachYaw + toothSway;
      } else if (a.mode === MODE_IDLE) {
        restX = node.homeX;
        restY =
          slotY +
          build.props[i].shelfLift +
          (reduced ? 0 : Math.sin(elapsed * 1.15 + a.seed) * 0.011);
        restZ = node.homeZ;
      } else {
        restX = node.homeX;
        restY = slotY + build.props[i].shelfLift;
        restZ = node.homeZ;
      }

      stepProp(a, dt, reduced, restX, restY, restZ);

      if (root) {
        const pop = a.pop.value;
        root.position.set(a.px + a.nx * pop, a.py + a.ny * pop, a.pz + a.nz * pop);
        root.rotation.set(a.pitch, a.yaw, a.roll + a.wobble.value * 0.06);
        squashFor(_squash, a.squash.value + popAmount(a), a.scale.value, 0.28);
        root.scale.set(_squash.x, _squash.y, _squash.z);
      }

      if (blobs) {
        /*
         * Contact darkening under a prop that is home, driven by the **shared** model rather
         * than by this file's own curve.
         *
         * Round 4's A3 put the two responses a contact term owes a caster that lifts into
         * `Rig.tsx`: the penumbra **widens** by the key's angular size, and the near-black
         * pinch — which is an occlusion of proximity, not a shadow — **fades to nothing**
         * across one shadow-map texel of gap. This used to do neither: it shrank the blob to
         * zero over 0.24 units, which is a shadow that gets *smaller* as its caster rises,
         * and it is the "this has no weight" signal Sliding Puzzle's own comment names.
         *
         * `contactRadiusFor` and `contactOpacityFor` are the same two curves `ContactBlob`
         * uses; the component itself cannot be used here because these ten heights change
         * every frame and it is a React component (§1.4).
         */
        /*
         * Height above the pad — but only while the prop is actually off it. A prop at rest
         * still moves: `restY` carries an 11 mm idle bob, and feeding that into a term whose
         * whole window is `CONTACT_FADE_LIFT` = 0.05 would pulse the contact darkening by
         * 28 % at 1.15 Hz. The bob is a breath, not a lift; a prop sitting in its slot is in
         * contact with it.
         */
        const lift =
          a.mode === MODE_IDLE
            ? 0
            : Math.max(0, a.py + a.ny * a.pop.value - (slotY + build.props[i].shelfLift));
        const fade = a.attached ? 0 : contactOpacityFor(1, lift);
        const s = fade > 0 ? contactRadiusFor(PAD_R * 0.99, lift) * 2 : 1e-4;
        _pos.set(node.homeX, slotY + 0.007, node.homeZ);
        _scl.set(s, s, 1);
        _mat.compose(_pos, FLAT_QUAT, _scl);
        blobs.setMatrixAt(i, _mat);
        /*
         * Density, not colour. `materials.ts::blobMaterial` blends to `dst * mix(1, tint, a)`
         * with `a` a property of the material — one number for all ten instances — so an
         * instanced blob cannot fade by opacity. It can fade by tint, exactly: solving
         * `mix(1, tintEff, a) = mix(1, tint, a * fade)` gives `tintEff = mix(1, tint, fade)`,
         * so the per-instance multiplier is `((1 - fade) + fade * tint) / tint` per channel.
         * At `fade = 1` that is 1 and as `fade` falls it rises toward a multiply by white.
         * The reciprocal is taken off the material's own colour, never off a copy of the hex.
         * Sliding Puzzle solves the same problem the same way.
         */
        _tint.setRGB(
          (1 - fade) * blobInvTint[0] + fade,
          (1 - fade) * blobInvTint[1] + fade,
          (1 - fade) * blobInvTint[2] + fade
        );
        blobs.setColorAt(i, _tint);
      }
    }
    if (blobs) {
      blobs.instanceMatrix.needsUpdate = true;
      if (blobs.instanceColor) blobs.instanceColor.needsUpdate = true;
    }

    /* -- the anchor a dragged prop is looking for -- */
    const anchorMesh = anchorRef.current;
    if (anchorMesh) {
      const showing = rt.drag.active && rt.drag.moved && rt.drag.index >= 0;
      anchorMesh.visible = showing;
      if (showing) {
        const node = nodes[rt.drag.index];
        const anchor = build.anchors[node.anchor];
        const ax = anchor.x * swayCos + anchor.z * swaySin;
        const ay = anchor.y + toothBob;
        const az = -anchor.x * swaySin + anchor.z * swayCos;
        if (planeTargetFor(cam, ax, ay, az, _target)) {
          anchorMesh.position.copy(_target);
          anchorMesh.quaternion.copy(cam.quaternion);
          const a = node.anim;
          const dx = a.px - _target.x;
          const dy = a.py - _target.y;
          const dz = a.pz - _target.z;
          const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
          const near = clamp01(1 - d / rt.drag.snapR);
          const pulse = reduced ? 1 : 1 + Math.sin(elapsed * 7.2) * 0.055;
          // Sized off the live snap radius, so the ring is always the same fraction of the
          // picture and always an honest picture of how close is close enough.
          const s = ((rt.drag.snapR / ANCHOR_RING_R) * (0.34 + near * 0.16)) * pulse;
          anchorMesh.scale.set(s, s, s);
        } else {
          anchorMesh.visible = false;
        }
      }
    }

    /* -- sparkles -- */
    const spark = sparkRef.current;
    if (spark) stepSparkles(rt.sparkles, spark, cam.quaternion, dt, reduced);

    /* -- the polaroid -- */
    const photo = rt.photo;
    const polaroid = polaroidRef.current;
    if (photo.phase === PHOTO_ARMING) {
      photo.t += dt;
      if (photo.t >= (reduced ? 0 : ARM_DELAY)) {
        capture(state.gl, state.scene, cam);
        photo.phase = PHOTO_SLIDING;
        photo.t = 0;
        photo.whirr = 0;
      }
    } else if (photo.phase === PHOTO_SLIDING) {
      photo.t += dt;
      const dur = reduced ? FEEL.reducedFade : SLIDE_DUR;
      const k = clamp01(photo.t / dur);
      if (reduced) {
        photo.slide = 1;
        photo.roll = -0.055;
        photo.scale = 0.9 + 0.1 * easeOutCubic(k);
      } else {
        // The whirr: three little motor ticks while the print is pushed out.
        while (photo.whirr < WHIRR_COUNT && photo.t > photo.whirr * WHIRR_STEP) {
          photo.whirr++;
          sounds.pop();
        }
        photo.slide = anticipate(k, 0.1);
        photo.roll = -0.055 - 0.17 * (1 - easeOutBack(k, 1.7));
        photo.scale = 1;
      }
      if (photo.t >= dur) {
        photo.phase = PHOTO_SHOWN;
        photo.t = 0;
        photo.slide = 1;
        photo.scale = 1;
        sounds.success();
      }
    } else if (photo.phase === PHOTO_SHOWN) {
      photo.slide = 1;
      photo.scale = 1;
      photo.roll = reduced ? -0.055 : -0.055 + Math.sin(elapsed * 0.9) * 0.009;
    } else if (photo.phase === PHOTO_LEAVING) {
      photo.t += dt;
      const dur = reduced ? FEEL.reducedFade : LEAVE_DUR;
      const k = clamp01(photo.t / dur);
      photo.slide = 1 - easeOutCubic(k);
      photo.scale = reduced ? 1 - 0.12 * k : 1;
      if (photo.t >= dur) {
        photo.phase = PHOTO_HIDDEN;
        photo.slide = 0;
      }
    }

    if (polaroid) {
      const visible = photo.phase !== PHOTO_HIDDEN && photo.hasImage;
      polaroid.visible = visible;
      if (visible) {
        /*
         * The print comes out of the camera's lens.
         *
         * It used to rise from below the bottom of the frame — a picture sliding in from
         * off-screen, which is a web transition rather than a thing happening in the booth.
         * Round 4, SM7 asked for the other half of §6.9: the capture is real, so the object
         * it produces should come out of the object that took it. `rt.lens` is the world
         * point at the centre of the camera prop's front element, and `photo.slide` carries
         * the print from there to the place it is held for reading. Put away, it goes back
         * in the same way, which is why `PHOTO_LEAVING` runs the same parameter backwards.
         */
        const rest = (framing.controlsFrac - framing.chromeFrac) * PHOTO_VIEW_HALF;
        const u = rest + (reduced ? 0 : Math.sin(elapsed * 1.3) * 0.01);
        const k = photo.slide;
        const hx = cam.position.x + _fwd.x * PHOTO_DIST + _up.x * u;
        const hy = cam.position.y + _fwd.y * PHOTO_DIST + _up.y * u;
        const hz = cam.position.z + _fwd.z * PHOTO_DIST + _up.z * u;
        polaroid.position.set(
          rt.lens.x + (hx - rt.lens.x) * k,
          rt.lens.y + (hy - rt.lens.y) * k,
          rt.lens.z + (hz - rt.lens.z) * k
        );
        _quat.setFromAxisAngle(_fwd, photo.roll);
        polaroid.quaternion.copy(cam.quaternion).premultiply(_quat);
        // Born at the width of the lens it is pushed out of, and only then opened out to
        // reading size: a print emerging, rather than a card scaling up in mid-air.
        const grow = PHOTO_EMERGE + (1 - PHOTO_EMERGE) * clamp01(k);
        const size = photo.scale * grow;
        polaroid.scale.set(size, size, size);
      }
    }
  }, 0.5);

  /* ---------------- graph ---------------- */

  return (
    <Rig shadowArea={SHADOW_AREA} groundY={0}>
      <group ref={boothBlobRef}>
        <ContactBlob position={BOOTH_BLOB_POS} radius={PODIUM_R * 1.45} opacity={0.34} />
      </group>

      <group ref={shelfRef}>
        {/*
          A genuinely circular rail. It used to be scaled 1.9x along Z so that it projected
          to a near-circle at one camera elevation and to a visible oval at every other one;
          the spacing that bought is now bought from radius, arc and slot assignment instead
          (see `layout.ts`), so the turntable is the same object from wherever a child turns
          it to.
        */}
        <mesh geometry={ringGeo} material={shelfMat} castShadow receiveShadow />
        <instancedMesh
          ref={padRef}
          args={[padGeo, shelfMat, SLOT_COUNT]}
          frustumCulled={false}
          receiveShadow
        />
        <instancedMesh
          ref={blobRef}
          args={[quadGeo, blobMat, SLOT_COUNT]}
          frustumCulled={false}
          renderOrder={2}
        />
      </group>

      <mesh
        geometry={podiumGeo}
        material={podiumMat}
        position={PODIUM_POS}
        castShadow
        receiveShadow
      />

      <group ref={toothRef} position-y={TOOTH_BASE_Y} scale={TOOTH_SCALE}>
        <mesh geometry={build.tooth} material={toothMat} castShadow receiveShadow />
        {build.face.map((layer, i) => (
          <mesh
            key={i}
            geometry={layer.geometry}
            material={layer.material}
            castShadow={layer.cast}
            receiveShadow
          />
        ))}
      </group>

      {/*
        A slot is either a prop or bare clay — never an invisible button. `built` gates both
        the meshes and the tap target, so a shelf that is still filling itself in cannot hand
        the child a target with nothing under it, and `?selftest=hit-targets` cannot count a
        collider that marks empty air.
      */}
      {nodes.map((node) => (
        <group key={node.id} ref={node.root}>
          <group ref={node.art}>
            {build.props[node.index].layers.map((layer, i) => (
              <mesh
                key={i}
                geometry={layer.geometry}
                material={layer.material}
                castShadow={layer.cast}
                receiveShadow
              />
            ))}
          </group>
          <group ref={node.hit}>
            {build.props[node.index].built ? (
              <HitTarget
                ariaLabel={node.label}
                group={SHELF_GROUP}
                focusOrder={node.slot}
                radius={PROP_HIT_R}
                minScreenPx={48}
                position={build.props[node.index].hitCenter}
                onPress={() => beginDrag(node.index)}
                onSelect={() => {
                  if (!rt.drag.moved) engine.toggle(node.index);
                  // Keyboard and assistive activation run press -> select with no pointer
                  // behind them, so there is no pointerup coming to close the drag.
                  if (!rt.pointerDown) endDrag(node.index);
                }}
              />
            ) : null}
          </group>
        </group>
      ))}

      {/*
        The booth's own controls: a camera, a lever and a tray, standing on the table in
        front of the turntable. Round 4, SM7 — see `build.ts::buildControls`.

        Their labels are **stable**. `engine.canUndoClear` and `engine.photo` both flip what
        a press does, and a changed `ariaLabel` recreates the hidden button and steals
        keyboard focus (the same reason the ten accessories carry a fixed label and report
        state through `announce()` instead). So each label says what the object is and what
        both of its presses do, and the narration says which one just happened.
      */}
      <group ref={controlsRef}>
        {controls.map((control) => (
          <group
            key={control.id}
            position={[controlSlot(control.id).x, 0, controlSlot(control.id).z]}
            rotation={[0, controlYaw(controlSlot(control.id)), 0]}
          >
            {control.layers.map((layer, i) => (
              <mesh
                key={i}
                geometry={layer.geometry}
                material={layer.material}
                castShadow={layer.cast}
                receiveShadow
              />
            ))}
            <HitTarget
              ariaLabel={CONTROL_LABEL[control.id]}
              group={CONTROL_GROUP}
              focusOrder={CONTROL_ORDER[control.id]}
              radius={control.hitRadius}
              minScreenPx={48}
              position={control.hitCenter}
              onSelect={() => pressControl(control.id)}
            />
          </group>
        ))}
      </group>

      <mesh
        ref={anchorRef}
        geometry={anchorGeo}
        material={anchorMat}
        visible={false}
        renderOrder={3}
      />

      <instancedMesh
        ref={sparkRef}
        args={[quadGeo, sparkleMat, SPARKLES]}
        frustumCulled={false}
        renderOrder={6}
      />

      <group ref={polaroidRef} visible={false}>
        <mesh geometry={paperGeo} material={paperMat} />
        <mesh
          geometry={quadGeo}
          material={photoMat}
          position={PHOTO_IMAGE_POS}
          scale={PHOTO_IMAGE_SCALE}
        />
        {caption ? (
          <mesh
            geometry={quadGeo}
            material={captionMat}
            position={PHOTO_CAPTION_POS}
            scale={captionScale}
            renderOrder={1}
          />
        ) : null}
        {photoOut ? (
          <HitTarget
            ariaLabel="Your photo. Press Enter to put it away and keep playing."
            focusOrder={PROP_COUNT}
            radius={0.46}
            minScreenPx={48}
            position={ZERO3}
            onSelect={() => engine.dismissPhoto()}
          />
        ) : null}
      </group>

      {/*
        The pointer sheet. Invisible material, so it costs no draw call, but it is the
        closest thing to the camera and therefore the first raycast hit — which is what
        makes a drag survive passing over another prop, and what lets an empty-space press
        become an orbit without ever stealing a press that belonged to a prop.
      */}
      <mesh
        ref={sheetRef}
        geometry={sheetGeo}
        material={sheetMat}
        onPointerDown={onSheetDown}
        onPointerMove={onSheetMove}
      />
    </Rig>
  );
}

/** Memoised on `engine`, which never changes identity. */
export const SmileMakerScene = memo(SmileMakerSceneImpl);
