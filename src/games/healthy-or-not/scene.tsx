/**
 * Healthy or Not? — the 3D set.
 *
 * The wiring, which is the Tooth Match pattern:
 *
 *  • Two props that never change identity — the engine and the quantised play-area aspect.
 *    Nothing about a prop's animation travels through React.
 *  • The component subscribes to the engine once and, from that callback, mutates plain
 *    structs (`FoodAnim`, `MascotAnim`, `DishAnim`). It re-renders on exactly two engine
 *    events: `deal` and `present` — the only two that change *which* food is mounted. A
 *    tap, a flight, a chomp, a lid and the finish are struct mutation only.
 *  • `useFrame` reads those structs and writes `Object3D` transforms through module-level
 *    scratch objects. It allocates nothing: no `new`, no literals, no closures, no `map`,
 *    and no audio (the engine owns every sound, so nothing in the hot loop can allocate a
 *    WebAudio node).
 *
 * The set: a big friendly clay tooth at the back, a slowly turning clay turntable in front
 * of it carrying the round's food, and an open clay dish beside it with a clay hand standing
 * up behind it, waving. *Three* things are tappable: the food, the tooth itself ("feed me")
 * — because tapping the character is the first thing a small child tries — and the
 * dish-and-hand pair ("no thank you"), which is one target because it is one answer. The food is the odd one
 * out and deliberately so: the first tap on it *picks it up* rather than answering with it,
 * because it is the newest and most touchable thing on the table and a child must be able
 * to reach for it without that being a scored commitment.
 *
 * The dish replaced a lidded bin, which replaced a hand — and round 4 (HN2) pointed out
 * what each swap cost. 3D-SPEC §6.4 and PROJECT.md both call this beat a wave-off — "gently
 * waved off and arcs away with a comic tumble" — and a rubbish bin says something else to a
 * four-year-old, but an *empty saucer* does not say "no thank you" at all. It is a place,
 * and the answer is a gesture. So both are here now: the dish keeps the tumble and keeps
 * somewhere legible for the food to land, and the hand behind it makes the gesture. Nothing
 * closes over the answer, which is the line §6.4 actually draws.
 *
 * Motion (3D-SPEC §4). Every one of the three targets answers the finger on `pointerdown`,
 * in the same frame: the food sinks to 0.94, the tooth squashes to 0.96 and nods, the dish
 * sinks, and the receiver's *anticipation* — the mascot's jaw cracking open — fires on
 * touch rather than on a lead 320 ms later. A tapped healthy food then winds *up* — it dips
 * into the pedestal and leans back for 100 ms — and flies on a genuine ballistic solve: the
 * launch velocity is computed so that the parabola under a fixed gravity lands in the mouth
 * in exactly `EAT_FLIGHT` seconds, and the position is integrated from that velocity. It is
 * a throw, not a tween. A sugary food gets the same wind-up and the same kind of solve,
 * aimed at the dish, tumbles on all three axes, bounces once and settles there in full
 * view. Nothing is destroyed, nothing is deleted in anger, and a wrong tap only adds a
 * comic wobble before the food goes exactly where it was always going to go.
 *
 * Reduced motion (`isReduced()`, read fresh every frame and at every event): the turntable
 * does not turn, nothing bobs, sways or breathes, and both flights are replaced by the
 * sanctioned ≤150 ms scale pop at the pedestal. The tooth still chomps, over 150 ms with no
 * overshoot and no hop. Fully playable, and it still looks like clay.
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
import { useFrame } from "@react-three/fiber";
import {
  AdditiveBlending,
  DynamicDrawUsage,
  Matrix4,
  MeshBasicMaterial,
  PlaneGeometry,
  Quaternion,
  Vector3,
  type BufferGeometry,
  type Group,
  type InstancedMesh,
  type Material,
  type Mesh,
} from "three";

import {
  FEEL,
  Spring,
  clamp01,
  damp,
  easeInCubic,
  easeOutBack,
  easeOutCubic,
  safeDelta,
  squashFor,
} from "../../three/anim";
import { DisposalBag } from "../../three/dispose";
import { cachedGeometry } from "../../three/geometry";
import { HitTarget, announce, hitTargetProbes, useFocusGroup } from "../../three/hit";
import { shadowBlobMaterial } from "../../three/materials";
import { ContactBlob, Rig, contactOpacityFor, contactRadiusFor } from "../../three/Rig";
import { FLAGS, celebrationHeroScale, isReduced } from "../../three/store";
import { sparkleTexture } from "../../three/textures";
import { CLAY, auditSceneAccents } from "../../three/tokens";
import { FOOD_LABELS, MAX_ROUNDS, type Food, type HealthyEngine } from "./engine";
import {
  AWAY_FLIGHT,
  AWAY_GRAVITY,
  BEAD_INSET,
  BEAD_R,
  DISH_H,
  DISH_R,
  DISH_REST_Y,
  HAND_LIFT,
  HAND_WAVE,
  CAVITY_HALF_DN,
  CAVITY_HALF_WN,
  CAVITY_MIN_WIDTH,
  CAVITY_OPEN_HN,
  CAVITY_ZN,
  CROWN_RN,
  CROWN_YN,
  EAT_FLIGHT,
  EAT_GRAVITY,
  EYE_RN,
  EYE_XN,
  EYE_YN,
  EYE_ZN,
  GLINT_RN,
  LIP_TUBE_N,
  MOUTH_X,
  MOUTH_Y,
  MOUTH_YN,
  MOUTH_Z,
  PED_H,
  PED_TOP,
  STAR_Y,
  STAR_Z,
  TABLE_H,
  TABLE_RIM_TUBE,
  TABLE_SPIN,
  TONGUE_PROUD_N,
  TONGUE_RN,
  TONGUE_YN,
  TONGUE_ZN,
  TOOTH_H,
  TOOTH_X,
  TOOTH_Z,
  layoutFor,
  shadowAreaFor,
} from "./layout";
import {
  CHEEK_LEFT,
  CHEEK_RIGHT,
  CHEEK_SCALE,
  buildFoods,
  buildMascot,
  HERO_FAMILY,
  sceneAccentPopulation,
  buildSet,
  discFor,
  handFootY,
  rimFor,
  type FoodTable,
} from "./props";

/* ------------------------------------------------------------------ */
/* Tuning                                                              */
/* ------------------------------------------------------------------ */

const PH_OFF = 0;
const PH_ENTER = 1;
const PH_IDLE = 2;
const PH_WOBBLE = 3;
const PH_WINDUP = 4;
const PH_EAT = 5;
const PH_AWAY = 6;
const PH_VANISH = 7;
/** Picked up and held toward the camera. Not an answer — see `tapFood`. */
const PH_LIFT = 8;
/** Landed in the "no thank you" dish and settling there, in full view. */
const PH_DISH = 9;

const EXIT_NONE = 0;
const EXIT_EAT = 1;
const EXIT_AWAY = 2;

/** A food drops onto the pedestal under constant acceleration and lands with a squash. */
const ENTER_DUR = 0.36;
const ENTER_DROP = 0.26;
/** Fraction of the entrance spent falling; the rest is the settle. */
const ENTER_LAND = 0.62;
const ENTER_IMPACT = -5.2;

/** The playful "oops": a comic wobble, then the food still goes where it belongs. */
const WOBBLE_DUR = 0.34;
const WOBBLE_IMPULSE = 5.4;

/** Anticipation before every launch — the food dips and leans away from its target. */
const WINDUP_DUR = 0.1;
const WINDUP_DIP = 0.09;

/*
 * The two flights are timed and weighted in `layout.ts`, because the camera has to reserve
 * room for the arc they describe — see `flightTop` there. Only the spin and the lead times
 * are presentation, so only they live here.
 */
const EAT_SPIN = 5.2;
/** Lead time so the mouth is wide open before the food gets there. */
const CHOMP_LEAD = 0.2;
const AWAY_SPIN = 3.4;
/** Lead time so the dish has braced before the food arrives. */
const DISH_LEAD = 0.24;

/**
 * The last of the flight, where the food goes *into* the mouth instead of parking on it.
 *
 * `launchEat` aims the food's **centre** at the mouth, and the widest food in the deal is
 * 0.41 units across, so at the moment of the chomp half of that prop was between the camera
 * and the face — `healthy-or-not-chomp-i05.png` has the cheese covering one eye, most of the
 * crown and half the smile. Two changes: the aim goes back by the food's own half-width so
 * its *front* lands on the mouth rather than its middle, and over the last 80 ms it shrinks
 * to `EAT_SHRINK_TO`, so what the child sees is a mouthful disappearing rather than a slab
 * pasted over the mascot's face.
 *
 * Worked through for the cheese (radius 0.32) at the desktop framing. The old solve put its
 * centre at `z = −0.378` and its near face at `−0.058`, which is 0.29 units in *front* of
 * the crown's surface (`−0.346`) and 0.64 units across against a crown 0.748 wide — 86 % of
 * the mascot's face, exactly what the audit photographed. The new solve crosses the crown's
 * front plane at `t = 0.30` and is 0.12 units behind it by `t = 0.34`, which is where the
 * shrink starts — so the whole shrink happens *inside* the head, where it cannot pop, and
 * the widest thing ever left over the face is 0.19 units, a quarter of the crown.
 */
const EAT_SHRINK_T = 0.08;
const EAT_SHRINK_TO = 0.3;

const VANISH_DUR = 0.16;

/* ------------------------------------------------------------------ */
/* Press (3D-SPEC §4)                                                  */
/* ------------------------------------------------------------------ */

/*
 * All three targets answer the finger on `pointerdown`, in the same frame.
 *
 * The impulses are derived from the springs they are fired into, not dialled. For an
 * underdamped `Spring(0, k, c)` the impulse response `x(t) = (v / w_d) e^{-zwt} sin(w_d t)`
 * peaks at `w_d t = acos(z)`, with value
 *
 *   peak = (v / w) * exp(-z * acos(z) / sqrt(1 - z^2))
 *
 * For the food's and the mascot's `Spring(0, 380, 17)`: `w = 19.494`, `z = 0.4361`,
 * `acos(z) = 1.1196`, `sqrt(1 - z^2) = 0.8999`, so the exponential is `0.5814` and
 *
 *   peak = 0.02983 * v      reached at t = acos(z) / w_d = 63.8 ms
 *
 * `FEEL.pressScale` is 0.94, i.e. a squash amount of −0.06, so the food's press impulse is
 * `−0.06 / 0.02983 = −2.01`; the fix list asks for 0.96 on the mascot, i.e. −0.04, giving
 * −1.34. Release is smaller than press in both cases because the spring is already
 * travelling back through zero when the finger lifts — a full `+2.01` there would overshoot
 * to about 1.10 rather than `FEEL.releaseOvershoot`'s 1.06.
 *
 * 63.8 ms is inside §4's "0.94 in ~90 ms" and, more to the point, the first frame after
 * `pointerdown` already shows about a third of the travel.
 */
const PRESS_HOLD_FOOD = -(1 - FEEL.pressScale);
const PRESS_HOLD_TOOTH = -0.04;
const PRESS_PEAK_PER_V = 0.02983;
const FOOD_PRESS = -(1 - FEEL.pressScale) / PRESS_PEAK_PER_V;
const FOOD_RELEASE = (FEEL.releaseOvershoot - 1) / PRESS_PEAK_PER_V * 0.8;
const TOOTH_PRESS = -0.04 / PRESS_PEAK_PER_V;
const TOOTH_RELEASE = 0.04 / PRESS_PEAK_PER_V * 0.8;
/**
 * The mascot's nod, on its own `Spring(0, 300, 18)`: `w = 17.321`, `z = 0.5196`,
 * `peak = 0.03096 * v`. A 4-degree nod (0.0698 rad) is therefore an impulse of 2.25.
 */
const NOD_PEAK_PER_V = 0.03096;
const TOOTH_NOD = 0.0698 / NOD_PEAK_PER_V;
/** How far the jaw cracks open the instant the tooth or the food is touched. */
const PRE_OPEN = 0.24;

/* ------------------------------------------------------------------ */
/* Picking a food up                                                   */
/* ------------------------------------------------------------------ */

/*
 * The first tap on a food is not an answer.
 *
 * The food is the most salient object in the frame and it changes every round, so a
 * four-year-old's first instinct is to touch it — and until now that touch *was* the
 * commitment "feed this to the tooth", scored, with no way to look at the new thing on the
 * table first. Now the first tap lifts it toward the camera and turns it so it can be read,
 * and the second tap (or the tooth, or the dish) answers. It puts itself back down after
 * `LIFT_HOLD` so a child who wanders off is never stuck holding something.
 */
const LIFT_RISE = 0.24;
const LIFT_HOLD = 2.6;
const LIFT_FALL = 0.24;
const LIFT_H = 0.22;
const LIFT_TILT = 0.3;
const LIFT_SPIN = 1.5;
const LIFT_GROW = 0.16;

/* ------------------------------------------------------------------ */
/* Landing in the dish                                                 */
/* ------------------------------------------------------------------ */

/** One small bounce, then the tumble damps out and the food sits there in full view. */
const DISH_BOUNCE = 0.26;
const DISH_BOUNCE_H = 0.07;
const DISH_SPIN_DAMP = 7;
const DISH_LAND_SQUASH = -4.2;
/**
 * How long the food stays visible in the dish before it clears.
 *
 * The engine advances 900 ms after a correct answer and 1250 ms after an oops, and the
 * flight lands at 560 ms / 900 ms. 0.34 s of hold plus a 0.16 s fade means the dish is
 * empty again a beat before the next food arrives on the pedestal, and the child has had
 * a third of a second of the answer sitting still where they put it.
 */
const DISH_HOLD = 0.34;

/** Chomp cycle: open with overshoot, hold, snap shut, settle. */
const CHOMP_DUR = 0.44;
const CHOMP_OPEN = 0.16;
const CHOMP_HOLD = 0.24;
const CHOMP_SHUT = 0.34;
const CHOMP_IMPACT = -5;
const CHOMP_HOP = 2.4;

const STAR_DUR = 0.62;
const GROW_PER_BITE = 0.008;
const GROW_MAX = 0.045;

/* ------------------------------------------------------------------ */
/* The wordless invitation                                             */
/* ------------------------------------------------------------------ */

/*
 * The only instruction in this game is a sentence a four-year-old cannot read, and the
 * lidded bin's breathing lid — the previous affordance — went with the lid. The hand behind
 * the dish (HN2) says what the "no" answer *means*; the beat below says which two things are
 * answers at all, and the two jobs are different.
 *
 * So until the child's first answer, the two things that *are* answers beat gently and out
 * of phase with each other: `max(0, sin)` rather than a sine, so each is a heartbeat with a
 * rest after it rather than a continuous wobble, and the two beats alternate so the eye is
 * handed from one to the other. It stops itself the moment the run starts, and it does not
 * run at all under reduced motion, where §4 forbids idle float and the opening `announce()`
 * carries the same information.
 */
const INVITE_HZ = 1.1;
const INVITE_TOOTH = 0.022;
const INVITE_DISH = 0.034;
/** How fast the beat fades once the child has answered once. */
const INVITE_FADE = 4;

/**
 * The second half of the invitation, and the half that was missing (HN2).
 *
 * The first tap on a food picks it up rather than answering with it — deliberately, so a
 * child can reach for the new thing on the table without that being a scored commitment.
 * But nothing on screen then said what the *second* tap was for: the two destinations sat
 * exactly as still as they had before, and the only thing that named them was an `aria`
 * label a four-year-old cannot hear.
 *
 * So picking a food up re-arms the beat for both of them, at full strength, for long enough
 * to be noticed and not long enough to nag. It is the same beat, the same alternation and
 * the same code path as the opening invitation, so it costs nothing new and it stops itself
 * the same way: `isReduced()` suppresses it entirely (§4 forbids idle float, and the
 * pick-up's `announce()` carries the same information in words).
 */
const HINT_DUR = 2.4;

/* ------------------------------------------------------------------ */
/* The waving hand                                                     */
/* ------------------------------------------------------------------ */

/*
 * `HAND_WAVE` — how far the hand swings, in radians — lives in `layout.ts` rather than here,
 * because the camera has to reserve for it: this prop's fit ring is sized from its *swept*
 * half-width, not its resting one. See `HAND_HALF_W`.
 */

/** Idle wave rate, in Hz. Slower than the beat it rides on, so the two do not throb. */
const HAND_HZ = 0.9;
/** Lean, so the palm faces the child rather than the ceiling. */
const HAND_TILT = -0.26;

/**
 * The hand's one spring — 3D-SPEC §4.1 Exception 1 (comic wobble).
 *
 * k 300 / c 11 is ζ 0.318, 34.9 % first overshoot and 727 ms to settle, inside the
 * exception's 0.25–0.44 / ≤45 % / ≤900 ms. It qualifies on the other clause too: a wave is a
 * flourish, it carries no state, and nothing waits on it — the food is already in the air by
 * the time the ring-down starts.
 */
const handSpring = (): Spring => new Spring(0, 300, 11);

/** One clear wave, fired when a food is waved away or a food is picked up. */
const waveHand = (h: HandAnim, amount: number, reduced: boolean): void => {
  if (!reduced) h.wave.impulse(amount);
};

type HandAnim = { wave: Spring };

/* ------------------------------------------------------------------ */
/* Tap targets                                                         */
/* ------------------------------------------------------------------ */

/**
 * The "no" answer's collider stays on the **bowl**, and the hand is a cue rather than a
 * fourth target. That is a decision, so here is the arithmetic behind it.
 *
 * The hand's distance from the bowl's centre is not fixed: `layoutFor` solves its position
 * against the turntable, and it runs from 0.500 at a laptop aspect to 0.859 at a phone one
 * (the phone composition packs the tray and the dish together, so the hand has to go further
 * back to stand off the tray). One circle containing both would therefore have to be 0.45 at
 * one end and 0.63 at the other — and at 0.63 it touches the *food's* collider, which is the
 * other answer. Measured at 390x844, the pair-covering circle leaves 4.1 px between "feed"
 * and "wave away"; the bowl-only circle leaves 43 px.
 *
 * So the hand says what the bowl means and the bowl takes the tap. That costs a sighted
 * child nothing they can miss: the bowl renders 170 px across on a phone and 236 px on a
 * laptop, it sits directly under the hand, and the keyboard and screen-reader path reach the
 * same answer through the same one stop (`useFocusGroup(GROUP, 3)` — and the 3 is a constant
 * for the reason the group comment gives).
 */

/**
 * The three labels, in focus order.
 *
 * Held as constants because `hitTargetProbes()` is global — it reports every mounted target
 * in the document — and `?selftest=healthy-or-not-targets` has to be able to say which three
 * are this game's without pattern-matching on prose.
 */
const LABEL_FOOD =
  "The food on the turntable. Tap once to pick it up and look at it, tap again to feed it to the tooth.";
const LABEL_TOOTH = "The tooth. Tap to feed it this food.";
const LABEL_DISH = "The dish, under the waving hand. Tap to wave this food away.";
const TARGET_LABELS = [LABEL_FOOD, LABEL_TOOTH, LABEL_DISH];

/* ------------------------------------------------------------------ */
/* Progress beads                                                      */
/* ------------------------------------------------------------------ */

/*
 * An answered round has to be visible from across the room, and it was not.
 *
 * The done bead used to be painted `peach.main` — the same token as the turntable rim a
 * hand's width away from it — flattened to 0.62 and sunk half into the disc, so twelve
 * markers about 8 px across differed from their surroundings by hue alone. It is now a
 * different token entirely (`coral.main`, `props.ts`), a rounder pebble, and it stands
 * clear of the disc and casts its own shadow, so "done" reads as relief as well as colour
 * even for a child who cannot separate the two hues.
 *
 * The empty socket goes the other way: nearly flush, in the pedestal's own dark warm grey —
 * literally the same material now, see `props.ts::buildSet` — so an unanswered round is a
 * dent and an answered one is a stone sitting in it.
 */
const BEAD_DONE_GROW = 1.16;
const BEAD_EMPTY_FLAT = 0.42;
const BEAD_DONE_FLAT = 0.85;
const BEAD_EMPTY_Y = TABLE_H - 0.02;
/** Sits *on* the disc: half its own height up, less 0.008 so the contact is a seat. */
const BEAD_DONE_Y = TABLE_H + BEAD_R * BEAD_DONE_GROW * BEAD_DONE_FLAT - 0.008;

const SPARKLES = 24;
const GROUP = "Healthy or Not choices";

/* ------------------------------------------------------------------ */
/* Per-frame scratch — module level, allocated exactly once            */
/* ------------------------------------------------------------------ */

const _mat = new Matrix4();
const _pos = new Vector3();
const _scl = new Vector3();
const _squash = { x: 1, y: 1, z: 1 };
const IDENTITY_QUAT = new Quaternion();

/* ------------------------------------------------------------------ */
/* Food animation                                                      */
/* ------------------------------------------------------------------ */

type FoodAnim = {
  seed: number;
  spinSign: number;

  phase: number;
  t: number;
  dur: number;
  pending: number;

  height: number;
  radius: number;

  x: number;
  y: number;
  z: number;
  rx: number;
  ry: number;
  rz: number;
  sc: number;
  /** Scale at the moment `PH_VANISH` began, so the eat shrink is not thrown away. */
  sc0: number;
  /** Final squash amount handed to `squashFor`, and the part of it the phase owns. */
  sq: number;
  sqBase: number;

  /** How far the food is picked up, 0..1, and the yaw the child has turned it through. */
  lift: number;
  liftYaw: number;
  /** Set for exactly one frame when the food touches down in the dish. */
  justLanded: boolean;

  /** Ballistic state — launch point, velocity, angular velocity. */
  fx: number;
  fy: number;
  fz: number;
  vx: number;
  vy: number;
  vz: number;
  wx: number;
  wy: number;
  wz: number;
  thumped: boolean;
  /** Turntable angle at the moment this food was presented — see `stepFood`. */
  spin0: number;

  wobble: Spring;
  squash: Spring;
  /** Finger-down sink. Separate from `squash` so a press never eats a landing impact. */
  press: Spring;
  /** True while a finger is down on this food. Drives the reduced-motion press. */
  held: boolean;

  /** Reduced-motion scale pop; springs are deliberately inert under reduced motion. */
  popT: number;
  popDur: number;
  popAmp: number;
};

function createFoodAnim(seed: number): FoodAnim {
  return {
    seed,
    spinSign: seed % 2 === 0 ? 1 : -1,
    phase: PH_OFF,
    t: 0,
    dur: ENTER_DUR,
    pending: EXIT_NONE,
    height: 0.5,
    radius: 0.3,
    x: 0,
    y: 0,
    z: 0,
    rx: 0,
    ry: 0,
    rz: 0,
    sc: 0,
    sc0: 1,
    sq: 0,
    sqBase: 0,
    lift: 0,
    liftYaw: 0,
    justLanded: false,
    fx: 0,
    fy: 0,
    fz: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    wx: 0,
    wy: 0,
    wz: 0,
    thumped: false,
    spin0: 0,
    // 3D-SPEC §4.1 Exception 1 (comic wobble). k 300 / c 9 is ζ 0.260, 42.9 % first
    // overshoot, 889 ms to settle — inside the exception's 0.25–0.44 / ≤45 % / ≤900 ms, and
    // it is the "soft comic wobble" §6.3 asks for on a miss. It gates nothing: the food goes
    // where it was always going the moment the wobble ends.
    wobble: new Spring(0, 300, 9),
    squash: new Spring(0, 380, 17),
    press: new Spring(0, 380, 17),
    held: false,
    popT: 0,
    popDur: FEEL.reducedFade,
    popAmp: 0,
  };
}

function popFood(a: FoodAnim, amp: number, dur: number): void {
  a.popAmp = amp;
  a.popDur = dur;
  a.popT = dur;
}

/**
 * A new food takes the pedestal.
 *
 * `angle` is the turntable's current rotation, and it is stored rather than used: a food
 * turns *with* the table from the moment it arrives, not from the table's absolute phase.
 * Otherwise a run that has been going for twenty seconds would present round eight facing
 * away from the child — the turntable has no visible phase, but a cheese wedge very much
 * does, and the whole game rests on a four year old reading the prop at a glance.
 */
function startEnter(a: FoodAnim, height: number, radius: number, reduced: boolean, angle: number): void {
  a.height = height;
  a.radius = radius;
  a.spin0 = angle;
  a.phase = PH_ENTER;
  a.t = 0;
  a.dur = reduced ? FEEL.reducedFade : ENTER_DUR;
  a.pending = EXIT_NONE;
  a.rx = 0;
  a.rz = 0;
  a.sq = 0;
  a.sc = reduced ? 0 : 0.001;
  a.sc0 = 1;
  a.lift = 0;
  a.liftYaw = 0;
  a.justLanded = false;
  a.thumped = false;
  a.wobble.set(0);
  a.squash.set(0);
  a.press.set(0);
  a.held = false;
  a.popT = 0;
}

/**
 * Picked up: rises, tips toward the camera, grows a little and turns slowly so the prop can
 * actually be read, then puts itself back down.
 *
 * Under reduced motion this collapses to the sanctioned scale pop — `lift` still runs, but
 * `stepFood` applies only its scale term, so there is no travel, no tilt and no rotation.
 */
function startLift(a: FoodAnim, reduced: boolean): void {
  a.phase = PH_LIFT;
  a.t = 0;
  a.dur = reduced ? FEEL.reducedFade : LIFT_RISE;
}

function pressFood(a: FoodAnim, reduced: boolean): void {
  a.held = true;
  if (!reduced) a.press.impulse(FOOD_PRESS);
}

function releaseFood(a: FoodAnim, reduced: boolean): void {
  a.held = false;
  if (!reduced) a.press.impulse(FOOD_RELEASE);
}

function startWobble(a: FoodAnim, reduced: boolean): void {
  a.phase = PH_WOBBLE;
  a.t = 0;
  a.dur = reduced ? FEEL.reducedFade : WOBBLE_DUR;
  if (reduced) popFood(a, -0.12, a.dur);
  else {
    a.wobble.impulse(a.spinSign * WOBBLE_IMPULSE);
    a.squash.impulse(-3);
  }
}

function nudgeFood(a: FoodAnim, reduced: boolean): void {
  if (reduced) popFood(a, -0.08, FEEL.reducedFade);
  else {
    a.wobble.impulse(a.spinSign * 2.4);
    a.squash.impulse(-2);
  }
}

function startWindup(a: FoodAnim, exit: number, reduced: boolean): void {
  a.pending = exit;
  if (reduced) {
    // No travel under reduced motion: the food leaves with the sanctioned scale pop.
    a.phase = PH_VANISH;
    a.sc0 = a.sc > 0 ? a.sc : 1;
    a.t = 0;
    a.dur = FEEL.reducedFade;
    return;
  }
  a.phase = PH_WINDUP;
  a.t = 0;
  a.dur = WINDUP_DUR;
}

/**
 * The ballistic solve. Given a flight time, gravity fixes the launch velocity that lands
 * the food in the mouth — so the arc is a consequence of the throw rather than a curve
 * drawn between two points.
 */
function launchEat(a: FoodAnim): void {
  a.phase = PH_EAT;
  a.t = 0;
  a.dur = EAT_FLIGHT;
  a.fx = a.x;
  a.fy = a.y;
  a.fz = a.z;
  // `MOUTH_Z` is the mouth *surface*; a food's group origin is its centre. Aiming the
  // centre there puts the near half of the prop in front of the mascot's face for the whole
  // chomp, so the aim goes back by the food's own half-width and the prop arrives with its
  // front face on the mouth instead of its middle.
  a.vx = (MOUTH_X - a.x) / EAT_FLIGHT;
  a.vz = (MOUTH_Z - a.radius - a.z) / EAT_FLIGHT;
  a.vy = (MOUTH_Y - a.y + 0.5 * EAT_GRAVITY * EAT_FLIGHT * EAT_FLIGHT) / EAT_FLIGHT;
}

/**
 * The same ballistic solve as `launchEat`, aimed at the floor of the "no thank you" dish.
 *
 * 3D-SPEC §6.4 and PROJECT.md both call this beat a *wave-off*: the food "arcs away with a
 * comic tumble". It is a lob with real angular velocity on all three axes, and it lands
 * somewhere open where the child can see it come to rest — a dish, not a bin that shuts a
 * lid over the answer.
 */
function launchAway(a: FoodAnim, bx: number, bz: number): void {
  a.phase = PH_AWAY;
  a.t = 0;
  a.dur = AWAY_FLIGHT;
  a.fx = a.x;
  a.fy = a.y;
  a.fz = a.z;
  const land = DISH_REST_Y + a.height / 2;
  a.vx = (bx - a.x) / AWAY_FLIGHT;
  a.vz = (bz - a.z) / AWAY_FLIGHT;
  a.vy = (land - a.y + 0.5 * AWAY_GRAVITY * AWAY_FLIGHT * AWAY_FLIGHT) / AWAY_FLIGHT;
  a.wx = AWAY_SPIN * a.spinSign;
  a.wy = 2.4;
  a.wz = 2.6 * a.spinSign;
}

/**
 * Advances one food. Pure struct mutation: no allocation, no React, no audio.
 * `tx`/`tz` are the turntable's centre and `angle` its current rotation, so a resting food
 * turns with the table it is standing on.
 */
function stepFood(
  a: FoodAnim,
  dt: number,
  reduced: boolean,
  elapsed: number,
  tx: number,
  tz: number,
  angle: number,
  bx: number,
  bz: number
): void {
  if (a.phase === PH_OFF) {
    a.sc = 0;
    return;
  }

  const restY = PED_TOP + a.height / 2;

  /*
   * Every output below is *assigned*, never accumulated — except `rx`/`ry`/`rz` while the
   * food is in the air, where accumulation is the tumble. Resetting the grounded rotations
   * and the phase's own squash contribution here is what stops a wobble from ratcheting the
   * food a few degrees further over every frame it is alive.
   */
  const freeSpin =
    a.phase === PH_EAT || a.phase === PH_AWAY || a.phase === PH_DISH || a.phase === PH_VANISH;
  if (!freeSpin) {
    a.rx = 0;
    a.rz = 0;
  }
  a.sqBase = 0;
  a.justLanded = false;

  switch (a.phase) {
    case PH_ENTER: {
      a.t += dt;
      const k = clamp01(a.t / a.dur);
      a.x = tx;
      a.z = tz;
      a.ry = angle - a.spin0 + a.liftYaw;
      if (reduced) {
        a.y = restY;
        a.sc = easeOutCubic(k);
      } else {
        const fall = k / ENTER_LAND;
        // Constant acceleration, not an ease: it reads as weight arriving.
        a.y = fall < 1 ? restY + ENTER_DROP * (1 - fall * fall) : restY;
        a.sc = easeOutBack(clamp01(k / 0.5), 1.7);
        if (!a.thumped && k >= ENTER_LAND) {
          a.thumped = true;
          a.squash.impulse(ENTER_IMPACT);
        }
      }
      if (a.t >= a.dur) {
        a.phase = PH_IDLE;
        a.t = 0;
        a.y = restY;
        a.sc = 1;
      }
      break;
    }

    case PH_IDLE: {
      a.x = tx;
      a.z = tz;
      a.ry = angle - a.spin0 + a.liftYaw;
      a.sc = 1;
      a.y = restY + (reduced ? 0 : Math.sin(elapsed * 1.35 + a.seed) * 0.012);
      break;
    }

    case PH_LIFT: {
      a.t += dt;
      a.x = tx;
      a.z = tz;
      a.ry = angle - a.spin0 + a.liftYaw;
      a.y = restY;
      a.sc = 1;
      const rise = reduced ? FEEL.reducedFade : LIFT_RISE;
      const fall = reduced ? FEEL.reducedFade : LIFT_FALL;
      if (a.t < rise) a.lift = reduced ? easeOutCubic(a.t / rise) : easeOutBack(a.t / rise, 1.5);
      else if (a.t < rise + LIFT_HOLD) a.lift = 1;
      else a.lift = 1 - easeInCubic(clamp01((a.t - rise - LIFT_HOLD) / fall));
      // Turning it is the whole point: a cheese wedge or a milk bottle only reads from the
      // front, and the turntable's own drift is far too slow to help inside one round.
      if (!reduced) a.liftYaw += LIFT_SPIN * dt * a.lift;
      if (a.t >= rise + LIFT_HOLD + fall) {
        a.phase = PH_IDLE;
        a.t = 0;
        a.lift = 0;
        // Fold the turn the child gave it into the food's own phase, so putting it down is
        // not a snap back to the facing it arrived with.
        a.spin0 -= a.liftYaw;
        a.liftYaw = 0;
        if (!reduced) a.squash.impulse(-2.6);
      }
      break;
    }

    case PH_WOBBLE: {
      a.t += dt;
      a.x = tx;
      a.z = tz;
      a.ry = angle - a.spin0 + a.liftYaw;
      a.y = restY;
      a.sc = 1;
      if (a.t >= a.dur) startWindup(a, a.pending, reduced);
      break;
    }

    case PH_WINDUP: {
      a.t += dt;
      const k = clamp01(a.t / a.dur);
      const dip = Math.sin(k * Math.PI);
      a.x = tx;
      a.z = tz;
      a.ry = angle - a.spin0 + a.liftYaw;
      a.y = restY - WINDUP_DIP * dip;
      a.sc = 1;
      // A food answered while it is being held comes back down *through* the wind-up rather
      // than snapping to the pedestal first: the lift decays across the same 100 ms.
      a.lift *= 1 - k;
      // Leans away from where it is about to go: back for the tooth, right for the exit.
      a.rx = a.pending === EXIT_EAT ? 0.34 * dip : 0;
      a.rz = a.pending === EXIT_AWAY ? -0.3 * dip : 0;
      a.sqBase = -0.14 * dip;
      if (a.t >= a.dur) {
        a.rx = 0;
        a.rz = 0;
        a.sqBase = 0;
        a.lift = 0;
        if (a.pending === EXIT_EAT) launchEat(a);
        else launchAway(a, bx, bz);
      }
      break;
    }

    case PH_EAT: {
      a.t += dt;
      const t = a.t < a.dur ? a.t : a.dur;
      a.x = a.fx + a.vx * t;
      a.z = a.fz + a.vz * t;
      a.y = a.fy + a.vy * t - 0.5 * EAT_GRAVITY * t * t;
      a.rx += EAT_SPIN * dt;
      a.ry += 1.6 * dt;
      // Into the mouth, not onto the face: see EAT_SHRINK_T.
      const remain = a.dur - a.t;
      a.sc =
        remain < EAT_SHRINK_T
          ? 1 - (1 - EAT_SHRINK_TO) * clamp01(1 - remain / EAT_SHRINK_T)
          : 1;
      if (a.t >= a.dur) {
        a.phase = PH_VANISH;
        a.sc0 = a.sc;
        a.t = 0;
        a.dur = VANISH_DUR;
      }
      break;
    }

    case PH_AWAY: {
      a.t += dt;
      const t = a.t < a.dur ? a.t : a.dur;
      // Integrated from the solved launch velocity, exactly like `PH_EAT`, so the two
      // exits are the same *kind* of motion and only their destination differs.
      a.x = a.fx + a.vx * t;
      a.z = a.fz + a.vz * t;
      a.y = a.fy + a.vy * t - 0.5 * AWAY_GRAVITY * t * t;
      a.rx += a.wx * dt;
      a.ry += a.wy * dt;
      a.rz += a.wz * dt;
      a.sc = 1;
      if (a.t >= a.dur) {
        a.phase = PH_DISH;
        a.t = 0;
        a.dur = DISH_HOLD;
        a.x = bx;
        a.z = bz;
        a.y = DISH_REST_Y + a.height / 2;
        a.justLanded = true;
        a.squash.impulse(DISH_LAND_SQUASH);
      }
      break;
    }

    case PH_DISH: {
      a.t += dt;
      // One bounce, and the tumble runs down instead of stopping dead — a settle, which is
      // what "arcs away with a comic tumble" has to end in if the child is to see where the
      // food went. Nothing shuts over it and nothing takes it away in front of them.
      // A parabola, because that is the shape a hop actually is — not a sine, and certainly
      // not the ease-in-out §4 forbids on anything a child is watching happen to their tap.
      const bt = a.t / DISH_BOUNCE;
      const b = bt < 1 ? 4 * bt * (1 - bt) * DISH_BOUNCE_H : 0;
      a.x = bx;
      a.z = bz;
      a.y = DISH_REST_Y + a.height / 2 + b;
      a.sc = 1;
      a.wx = damp(a.wx, 0, DISH_SPIN_DAMP, dt);
      a.wy = damp(a.wy, 0, DISH_SPIN_DAMP, dt);
      a.wz = damp(a.wz, 0, DISH_SPIN_DAMP, dt);
      a.rx += a.wx * dt;
      a.ry += a.wy * dt;
      a.rz += a.wz * dt;
      // Killing the spin is not the same as settling: a food whose tumble simply stopped
      // would rest at whatever angle it happened to be at, half through the dish's floor.
      // The two tilt axes are drawn back to upright while the yaw keeps whatever facing the
      // tumble gave it, which is what "it landed" looks like. `AWAY_SPIN` over one flight
      // is at most 1.56 rad, so this never unwinds a whole turn in front of the child.
      a.rx = damp(a.rx, 0, 6, dt);
      a.rz = damp(a.rz, 0, 6, dt);
      if (a.t >= a.dur) {
        a.phase = PH_VANISH;
        a.sc0 = 1;
        a.t = 0;
        a.dur = VANISH_DUR;
      }
      break;
    }

    case PH_VANISH: {
      a.t += dt;
      const k = clamp01(a.t / a.dur);
      a.sc = a.sc0 * (1 - easeInCubic(k));
      if (a.t >= a.dur) {
        a.phase = PH_OFF;
        a.sc = 0;
      }
      break;
    }

    default:
      break;
  }

  /*
   * The pick-up, applied outside the switch so every phase composes with it: the wind-up
   * can start while the food is still up in the air and simply carry it down.
   *
   * `LIFT_TILT` is positive, i.e. the top tips *toward* the camera. At the shot's 24-degree
   * elevation that is what turns a flat-lying prop (the doughnut, the candy) from a rim
   * into a face, and what turns an upright one (the cheese, the milk) from a flat elevation
   * into a three-quarter view. Under reduced motion only the scale term runs — no travel,
   * no tilt, no turn, which is §4's scale pop and nothing else.
   */
  if (a.lift > 0) {
    if (!reduced) {
      a.y += LIFT_H * a.lift;
      a.rx += LIFT_TILT * a.lift;
    }
    a.sc *= 1 + LIFT_GROW * a.lift;
  }

  a.wobble.to(0);
  a.squash.to(0);
  // `Spring.step` throws velocity away under reduced motion — it becomes a critically
  // damped follow — so a press there is expressed as a *target* the value settles to over
  // about 150 ms rather than as an impulse the spring would silently discard. Either way
  // the finger gets an answer, and §4 gets its response inside one frame.
  a.press.to(reduced && a.held ? PRESS_HOLD_FOOD : 0);
  a.wobble.step(dt);
  a.squash.step(dt);
  a.press.step(dt);

  let popAmount = 0;
  if (a.popT > 0) {
    a.popT -= dt;
    popAmount = a.popAmp * Math.sin(clamp01(1 - a.popT / a.popDur) * Math.PI);
  }

  // The spring's value IS the tilt in radians: an impulse of 5.4 on a 300/9 spring peaks
  // at ~0.31 rad and rings down over half a second — a comic wobble, not a twitch.
  if (!freeSpin) a.rz += a.wobble.value;
  a.sq = a.sqBase + a.squash.value + a.press.value + popAmount;
}

/* ------------------------------------------------------------------ */
/* Mascot animation                                                    */
/* ------------------------------------------------------------------ */

type MascotAnim = {
  chompDelay: number;
  chompT: number;
  chompDur: number;
  closed: boolean;
  open: number;
  bites: number;
  starT: number;
  starDur: number;
  hop: Spring;
  squash: Spring;
  grow: Spring;
  /** Finger-down squash, and the little nod that goes with it. */
  press: Spring;
  nod: Spring;
  /**
   * True while a finger (or Space) is down on the tooth or on the food.
   *
   * The chomp used to be the mascot's *only* reaction, and it was scheduled to lead the
   * food's arrival — 320 ms after the tap on every correct answer. `pre` is the receiver's
   * anticipation moved to where §4 requires it: the jaw cracks open on pointerdown, in the
   * same frame, and closes again if the finger slides off without choosing.
   */
  held: boolean;
  pre: Spring;
};

function createMascot(): MascotAnim {
  return {
    chompDelay: -1,
    chompT: -1,
    chompDur: CHOMP_DUR,
    closed: true,
    open: 0,
    bites: 0,
    starT: 0,
    starDur: STAR_DUR,
    // A landing, and a child is waiting on it, so it takes §4's band rather than §4.1's
    // exception. `c` was 14 (ζ 0.434, 22.0 %, 571 ms), which is outside `damping` 18–28;
    // at 18 it is ζ 0.558, 12.1 % overshoot, 444 ms — the band's own corner.
    hop: new Spring(0, 260, 18),
    // `squash` and `press` are **§4.1 Exception 1 (comic wobble)**: ζ 0.436, 21.8 %
    // overshoot, 471 ms to settle, against the exception's ζ 0.25–0.44 / ≤45 % / ≤900 ms.
    // Both are finger-down flourishes on a prop that is already answering the tap — nothing
    // is waiting on their ring-down, which is the clause the exception turns on.
    squash: new Spring(0, 380, 17),
    grow: new Spring(1, 300, 20),
    press: new Spring(0, 380, 17),
    nod: new Spring(0, 300, 18),
    held: false,
    pre: new Spring(0, 340, 21),
  };
}

/** Finger-down on the mascot, or on the food that is about to be fed to it. */
function pressMascot(m: MascotAnim, reduced: boolean): void {
  m.held = true;
  if (!reduced) {
    m.press.impulse(TOOTH_PRESS);
    m.nod.impulse(TOOTH_NOD);
  }
}

function releaseMascot(m: MascotAnim, reduced: boolean): void {
  m.held = false;
  if (!reduced) m.press.impulse(TOOTH_RELEASE);
}

function scheduleChomp(m: MascotAnim, delay: number, reduced: boolean): void {
  m.chompDelay = delay < 0 ? 0 : delay;
  m.chompDur = reduced ? FEEL.reducedFade : CHOMP_DUR;
}

function cheer(m: MascotAnim, reduced: boolean): void {
  m.starT = reduced ? FEEL.reducedFade : STAR_DUR;
  m.starDur = m.starT;
  if (!reduced) {
    m.hop.impulse(3.2);
    m.squash.impulse(-4.2);
  }
}

function stepMascot(m: MascotAnim, field: SparkleField, dt: number, reduced: boolean): void {
  // `open` is re-derived every frame from the chomp and then raised by the press
  // anticipation below, so neither can leave the other's value stuck on the jaw.
  if (m.chompT < 0) m.open = 0;
  if (m.chompDelay >= 0) {
    m.chompDelay -= dt;
    if (m.chompDelay <= 0) {
      m.chompDelay = -1;
      m.chompT = 0;
      m.closed = false;
    }
  }

  if (m.chompT >= 0) {
    m.chompT += dt;
    const d = m.chompDur;
    if (reduced) {
      const k = clamp01(m.chompT / d);
      m.open = k < 0.5 ? easeOutCubic(k * 2) : 1 - easeOutCubic((k - 0.5) * 2);
      if (!m.closed && k >= 0.5) {
        m.closed = true;
        m.bites++;
        burst(field, MOUTH_X, MOUTH_Y + 0.1 * TOOTH_H, MOUTH_Z + 0.09 * TOOTH_H, 4, true);
        m.starT = FEEL.reducedFade;
        m.starDur = m.starT;
      }
    } else {
      if (m.chompT < CHOMP_OPEN) {
        // Opens with an overshoot — the jaw swings wide and settles at the top.
        m.open = easeOutBack(m.chompT / CHOMP_OPEN, 1.8);
      } else if (m.chompT < CHOMP_HOLD) {
        m.open = 1;
      } else if (m.chompT < CHOMP_SHUT) {
        // Closes on an accelerating curve: a snap, not a fade.
        m.open = 1 - easeInCubic((m.chompT - CHOMP_HOLD) / (CHOMP_SHUT - CHOMP_HOLD));
      } else {
        m.open = 0;
        if (!m.closed) {
          // The snap: the head squashes, hops, sparkles and grows a fraction.
          m.closed = true;
          m.bites++;
          m.squash.impulse(CHOMP_IMPACT);
          m.hop.impulse(CHOMP_HOP);
          burst(field, MOUTH_X, MOUTH_Y + 0.12 * TOOTH_H, MOUTH_Z + 0.11 * TOOTH_H, 9, false);
          m.starT = STAR_DUR;
          m.starDur = STAR_DUR;
        }
      }
    }
    if (m.chompT >= d) {
      m.chompT = -1;
      m.open = 0;
    }
  }

  // Anticipation: the jaw is at least `PRE_OPEN` while a finger is down, so the mouth is
  // already moving on the frame after `pointerdown` rather than 320 ms later. `max`, not a
  // sum, so it can never fight the chomp for control of the same opening.
  m.pre.to(m.held ? 1 : 0);
  m.pre.step(dt);
  const anticipate = PRE_OPEN * m.pre.value;
  if (anticipate > m.open) m.open = anticipate;

  const target = 1 + Math.min(GROW_MAX, m.bites * GROW_PER_BITE);
  m.grow.to(target);
  m.grow.step(dt);
  m.hop.to(0);
  m.squash.to(0);
  m.press.to(reduced && m.held ? PRESS_HOLD_TOOTH : 0);
  m.nod.to(0);
  m.hop.step(dt);
  m.squash.step(dt);
  m.press.step(dt);
  m.nod.step(dt);
  if (m.starT > 0) m.starT -= dt;
}

/* ------------------------------------------------------------------ */
/* Dish animation                                                      */
/* ------------------------------------------------------------------ */

/**
 * The "no thank you" dish.
 *
 * It has no moving parts — that is the point of it being a dish — so all of its life is two
 * springs. `press` is the finger-down sink (§4, in the same frame as `pointerdown`, which
 * the lidded bin it replaces never had: its only reaction was a lid scheduled 320 ms
 * later). `rise` is the receiving gesture: a small lift when a food is on its way, and a
 * dip when it lands, so the dish acknowledges the catch instead of standing inert while
 * something bounces off it.
 */
type DishAnim = { delay: number; held: boolean; press: Spring; rise: Spring };

function createDish(): DishAnim {
  // `press` is **§4.1 Exception 1 (comic wobble)** — ζ 0.436 / 21.8 % / 471 ms, inside the
  // exception's ζ 0.25–0.44 / ≤45 % / ≤900 ms. It is the dish's finger-down anticipation and
  // nothing waits on it; `rise` (ζ 0.520 / 14.8 % / 444 ms) is in §4's band on its own.
  return { delay: -1, held: false, press: new Spring(0, 380, 17), rise: new Spring(0, 300, 18) };
}

/** Finger-down. This *is* the dish's anticipation, and it happens on touch, not on a lead. */
function pressDish(d: DishAnim, reduced: boolean): void {
  d.held = true;
  if (!reduced) d.press.impulse(FOOD_PRESS);
}

function releaseDish(d: DishAnim, reduced: boolean): void {
  d.held = false;
  if (!reduced) d.press.impulse(FOOD_RELEASE);
}

/** Schedules the brace. `delay` is how long until the food gets here. */
function readyDish(d: DishAnim, delay: number): void {
  d.delay = delay < 0 ? 0 : delay;
}

function stepDish(d: DishAnim, dt: number, landed: boolean, reduced: boolean): void {
  if (d.delay >= 0) {
    d.delay -= dt;
    if (d.delay <= 0) {
      d.delay = -1;
      if (!reduced) d.rise.impulse(1.6);
    }
  }
  if (landed && !reduced) {
    d.rise.impulse(-1.6);
    d.press.impulse(-3);
  }
  d.press.to(reduced && d.held ? PRESS_HOLD_FOOD : 0);
  d.rise.to(0);
  d.press.step(dt);
  d.rise.step(dt);
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

/**
 * Per-instance spawn delay, in seconds (HN4).
 *
 * Every instance in a burst used to start at `life = 0`, and `easeOutBack(p * 3.4, 2)` takes
 * a sparkle from nothing to **34.8 % of full size in the first frame** — so nine sparkles
 * scattered over 0.36 units appeared simultaneously, at the same moment, with additive
 * blending, and summed into one hard-edged four-lobed cross on the mascot's head.
 *
 * 28 ms apart puts the ninth 224 ms behind the first, which is a third of the burst's own
 * 0.6–0.9 s life: they open as a ripple outward instead of a flashbulb, and no two are ever
 * at the same point of the same curve. Under reduced motion the stagger is dropped along
 * with everything else — `FEEL.reducedFade` is the whole budget there and 4 sparkles fading
 * in sequence would spend it three times over.
 */
const SPARKLE_STAGGER = 0.028;

/** Fired from a discrete transition, never every frame — `Math.random` here is free. */
function burst(field: SparkleField, x: number, y: number, z: number, count: number, reduced: boolean): void {
  for (let k = 0; k < count; k++) {
    const i = field.next;
    field.next = (field.next + 1) % field.n;
    if (field.dur[i] <= 0) field.live++;
    // Every offset, speed and size below is a fraction of the mascot's own height, so the
    // burst kept its proportions when the scale came back to spec. The spatial spread grew
    // with the stagger: a puff that opens over time wants somewhere to open *into*, and at
    // 0.34 the nine of them overlapped by more than their own diameters.
    field.px[i] = x + (Math.random() - 0.5) * 0.5 * TOOTH_H;
    field.py[i] = y + (Math.random() - 0.5) * 0.3 * TOOTH_H;
    field.pz[i] = z + (Math.random() - 0.5) * 0.34 * TOOTH_H;
    const a = Math.random() * Math.PI * 2;
    const e = 0.3 + Math.random() * 0.9;
    const s = reduced ? 0 : (0.9 + Math.random() * 0.8) * 0.6;
    field.vx[i] = Math.cos(a) * Math.cos(e) * s;
    field.vy[i] = Math.sin(e) * s + (reduced ? 0 : 0.4);
    field.vz[i] = Math.sin(a) * Math.cos(e) * s;
    // Negative life *is* the delay: `stepSparkles` counts it up and holds the instance at
    // zero scale until it crosses zero, so no second array and no branch in the hot loop
    // beyond the one that was already there.
    field.life[i] = reduced ? 0 : -k * SPARKLE_STAGGER;
    field.dur[i] = reduced ? 0.3 : 0.6 + Math.random() * 0.3;
    field.size[i] = (0.16 + Math.random() * 0.12) * TOOTH_H * 0.62;
  }
}

function resetSparkles(field: SparkleField): void {
  // `>=` on the duration ends the instance on the next step, whatever its delay was: a
  // re-deal must not leave a staggered sparkle to appear a quarter of a second into the new
  // round with nothing to explain it.
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
    if (life < 0) {
      // Still waiting its turn. Held at zero scale — the matrix was already collapsed when
      // the slot was freed, so this costs one compare and nothing else.
      field.life[i] = life;
      live++;
      continue;
    }
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
      field.vy[i] -= 2.4 * dt;
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
/* Scene                                                               */
/* ------------------------------------------------------------------ */

type SlotContent = { key: number; food: Food } | null;

type Progress = { answered: number; popIndex: number; popT: number };

const FLAT_ROT: [number, number, number] = [-Math.PI / 2, 0, 0];
const SLOT_KEYS = [0, 1] as const;

function HealthySceneImpl({ engine, aspect }: { engine: HealthyEngine; aspect: number }): JSX.Element {
  /* ---------------- resources (all shared + cached) ---------------- */

  const foods = useMemo<FoodTable>(() => buildFoods(), []);
  const mascotArt = useMemo(() => buildMascot(), []);
  const set = useMemo(() => buildSet(), []);
  /** The hand's own local floor, so the sign stands on the table instead of near it. */
  const handFoot = useMemo(() => handFootY(), []);
  const bag = useMemo(() => new DisposalBag(), []);
  const sparkles = useMemo(() => createSparkles(SPARKLES), []);

  const layout = useMemo(() => layoutFor(aspect), [aspect]);
  const discGeo = useMemo(() => discFor(layout.tableR), [layout.tableR]);
  const rimGeo = useMemo(() => rimFor(layout.tableR, TABLE_RIM_TUBE), [layout.tableR]);
  const quadGeo = useMemo(
    () => cachedGeometry("healthy-or-not/quad", () => new PlaneGeometry(1, 1)),
    []
  );
  /**
   * One contact-blob material per food slot, cloned so this scene may write `opacity` on it
   * every frame.
   *
   * `materials.ts` caches and `markShared`s its blob materials by quantised opacity, so the
   * one `shadowBlobMaterial()` returns is borrowed by other props; setting `.opacity` on it
   * would darken or lighten every contact shadow in the product. The clone is this game's,
   * so it is also this game's to free — `bag` does that on unmount.
   */
  const blobMats = useMemo(() => {
    const base = shadowBlobMaterial();
    return [base.clone(), base.clone()];
  }, []);
  /** The density these blobs want at zero lift; `contactOpacityFor` scales it from here. */
  const BLOB_OPACITY = blobMats[0].opacity;

  /**
   * The one resource this game constructs itself, and therefore the one it must free.
   * Everything else came back `markShared` from a cache and is not ours to dispose.
   */
  const sparkleMat = useMemo(
    () =>
      new MeshBasicMaterial({
        map: sparkleTexture(),
        color: CLAY.wear,
        transparent: true,
        blending: AdditiveBlending,
        // `sparkleTexture` writes RGB already scaled by alpha; without this three's
        // additive path multiplies by alpha twice and the warm tail collapses to a dot.
        premultipliedAlpha: true,
        depthWrite: false,
        toneMapped: false,
        fog: false,
      }),
    []
  );

  useEffect(() => {
    bag.add(sparkleMat);
    for (const m of blobMats) bag.add(m);
    return () => bag.release();
  }, [bag, sparkleMat, blobMats]);

  /*
   * `args` on an `<instancedMesh>` is a *constructor* argument list: R3F compares it
   * shallowly and rebuilds the object when it changes. This scene re-renders once per
   * round, so a fresh array literal in the JSX would risk rebuilding all three instanced
   * meshes mid-run and wiping the live sparkles and the progress beads. Memoised, they are
   * constructed exactly once.
   */
  const beadArgs = useMemo(
    () => [set.bead.geometry, set.bead.material, MAX_ROUNDS] as [BufferGeometry, Material, number],
    [set]
  );
  const beadDoneArgs = useMemo(
    () =>
      [set.beadDone.geometry, set.beadDone.material, MAX_ROUNDS] as [BufferGeometry, Material, number],
    [set]
  );
  const sparkArgs = useMemo(
    () => [quadGeo, sparkleMat, SPARKLES] as [BufferGeometry, Material, number],
    [quadGeo, sparkleMat]
  );

  /* ---------------- animation state ---------------- */

  const anims = useMemo(() => [createFoodAnim(0), createFoodAnim(1)], []);
  const mascot = useMemo(() => createMascot(), []);
  const dish = useMemo(() => createDish(), []);
  const hand = useMemo<HandAnim>(() => ({ wave: handSpring() }), []);
  const progress = useMemo<Progress>(() => ({ answered: 0, popIndex: -1, popT: 0 }), []);
  const table = useMemo(() => ({ angle: 0 }), []);
  /**
   * How much of the wordless invitation is still running, and how much of the pick-up hint.
   * `v` is damped and `hint` counts down; neither is ever a React render.
   */
  const invite = useMemo(() => ({ v: 1, hint: 0 }), []);
  /** Bead ring positions, rebuilt whenever the round count or the table radius changes. */
  const beadRing = useMemo(() => new Float32Array(MAX_ROUNDS * 2), []);

  const slotRefs = useMemo(() => [createRef<Group>(), createRef<Group>()], []);
  const blobRefs = useMemo(() => [createRef<Mesh>(), createRef<Mesh>()], []);
  const tableRef = useRef<Group>(null);
  const toothRef = useRef<Group>(null);
  const cavityRef = useRef<Mesh>(null);
  const tongueRef = useRef<Mesh>(null);
  const starRef = useRef<Mesh>(null);
  const dishRef = useRef<Group>(null);
  const handRef = useRef<Group>(null);
  /** The mascot's contact blob, so it can leave with the mascot. See the graph. */
  const toothBlobRef = useRef<Group>(null);
  const beadRef = useRef<InstancedMesh>(null);
  const beadDoneRef = useRef<InstancedMesh>(null);
  const sparkRef = useRef<InstancedMesh>(null);

  /** The two mounted foods. Replaced only on `deal` and `present`. */
  const [slots, setSlots] = useState<[SlotContent, SlotContent]>([null, null]);
  const [rounds, setRounds] = useState(engine.rounds);

  /* ---------------- layout-dependent buffers ---------------- */

  useLayoutEffect(() => {
    const bead = beadRef.current;
    const done = beadDoneRef.current;
    const ringR = layout.tableR - BEAD_INSET;
    const base = BEAD_R / 0.1;
    for (let i = 0; i < MAX_ROUNDS; i++) {
      const a = (i / Math.max(1, rounds)) * Math.PI * 2 - Math.PI / 2;
      beadRing[i * 2] = Math.cos(a) * ringR;
      beadRing[i * 2 + 1] = Math.sin(a) * ringR;
    }
    if (bead) {
      for (let i = 0; i < MAX_ROUNDS; i++) {
        _pos.set(beadRing[i * 2], BEAD_EMPTY_Y, beadRing[i * 2 + 1]);
        _scl.set(base, base * BEAD_EMPTY_FLAT, base);
        _mat.compose(_pos, IDENTITY_QUAT, _scl);
        bead.setMatrixAt(i, _mat);
      }
      bead.count = rounds;
      bead.instanceMatrix.needsUpdate = true;
    }
    if (done) {
      done.instanceMatrix.setUsage(DynamicDrawUsage);
      // The frame loop reassigns this every frame; zeroing it here only stops a first paint
      // from showing twelve identity-matrix beads stacked at the table's centre.
      done.count = 0;
    }
  }, [layout.tableR, rounds, beadRing]);

  /*
   * The engine deals inside its own factory, before this component exists, so the very
   * first food never arrives as an event — the scene puts it on the pedestal itself. Every
   * later round, and every re-deal, comes through `present` / `deal`.
   */
  useEffect(() => {
    const first = engine.foods[engine.round];
    if (!first) return;
    const prop = foods[first.id];
    const slot = engine.round & 1;
    startEnter(anims[slot], prop.height, prop.radius, isReduced(), table.angle);
    setSlots((prev) => {
      const next: [SlotContent, SlotContent] = [prev[0], prev[1]];
      next[slot] = { key: first.key, food: first };
      return next;
    });
    // Mount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useLayoutEffect(() => {
    const mesh = sparkRef.current;
    if (!mesh) return;
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    // An InstancedMesh starts life with identity matrices, which would park a full-size
    // sparkle at the origin until the first burst. Collapse them all up front.
    for (let i = 0; i < SPARKLES; i++) {
      _pos.set(0, 0, 0);
      _scl.set(0, 0, 0);
      _mat.compose(_pos, IDENTITY_QUAT, _scl);
      mesh.setMatrixAt(i, _mat);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }, []);

  /* ---------------- engine events ---------------- */

  useEffect(
    () =>
      engine.on((event) => {
        const reduced = isReduced();
        switch (event.type) {
          case "deal": {
            resetSparkles(sparkles);
            progress.answered = 0;
            progress.popIndex = -1;
            progress.popT = 0;
            mascot.bites = 0;
            mascot.chompDelay = -1;
            mascot.chompT = -1;
            mascot.open = 0;
            mascot.starT = 0;
            mascot.held = false;
            mascot.pre.set(0);
            mascot.grow.set(1);
            invite.v = 1;
            dish.delay = -1;
            dish.held = false;
            dish.press.set(0);
            dish.rise.set(0);
            anims[0].phase = PH_OFF;
            anims[1].phase = PH_OFF;
            const first = engine.foods[0];
            if (first) {
              const prop = foods[first.id];
              startEnter(anims[0], prop.height, prop.radius, reduced, table.angle);
              setSlots([{ key: first.key, food: first }, null]);
            } else {
              setSlots([null, null]);
            }
            setRounds(engine.rounds);
            break;
          }

          case "present": {
            const slot = event.round & 1;
            const prop = foods[event.food.id];
            startEnter(anims[slot], prop.height, prop.radius, reduced, table.angle);
            setSlots((prev) => {
              const next: [SlotContent, SlotContent] = [prev[0], prev[1]];
              next[slot] = { key: event.food.key, food: event.food };
              return next;
            });
            break;
          }

          case "answer": {
            const slot = event.round & 1;
            const a = anims[slot];
            const exit = event.exit === "eat" ? EXIT_EAT : EXIT_AWAY;
            if (event.correct) startWindup(a, exit, reduced);
            else {
              // The playful "oops": a wobble first, then the food still goes where it
              // belongs. Nothing is taken away and nothing is destroyed.
              a.pending = exit;
              startWobble(a, reduced);
            }
            // Both receivers are scheduled to *lead* the food's arrival, so the mouth or
            // the lid is already wide open when it gets there. Under reduced motion there
            // is no flight, so each only has to wait out the oops pop.
            const oops = event.correct ? 0 : reduced ? FEEL.reducedFade : WOBBLE_DUR;
            if (exit === EXIT_EAT) {
              const lead = reduced
                ? oops + 0.05
                : oops + WINDUP_DUR + EAT_FLIGHT - CHOMP_LEAD;
              scheduleChomp(mascot, lead, reduced);
            } else if (!reduced) {
              readyDish(dish, oops + WINDUP_DUR + AWAY_FLIGHT - DISH_LEAD);
              // The gesture the game is named for. It fires with the wind-up rather than on
              // the landing, so the hand is waving while the food is in the air.
              waveHand(hand, 3.4, reduced);
            }
            // Answering ends the invitation, whichever way it went.
            invite.hint = 0;
            progress.popIndex = progress.answered;
            progress.answered = Math.min(MAX_ROUNDS, progress.answered + 1);
            progress.popT = reduced ? FEEL.reducedFade : 0.34;
            break;
          }

          case "complete":
            cheer(mascot, reduced);
            burst(sparkles, TOOTH_X, TOOTH_H * 0.95, TOOTH_Z + 0.45 * TOOTH_H, reduced ? 6 : 14, reduced);
            break;

          case "reject": {
            const slot = engine.round & 1;
            nudgeFood(anims[slot], reduced);
            break;
          }

          default:
            break;
        }
      }),
    [engine, foods, anims, mascot, dish, hand, progress, sparkles, table, invite]
  );

  /* ---------------- the three answers ---------------- */

  /*
   * Touching the food is not answering with it.
   *
   * The food is the biggest, newest, most obviously touchable thing in the frame, and it
   * used to fire `engine.answer("feed")` on the first tap — so a four-year-old had no way
   * to reach out to the new object on the table without committing to a scored answer, and
   * no way to look at it. The first tap now picks it up and turns it; the second tap, or
   * the tooth, or the dish, answers. A tap while the previous answer is still playing out
   * still reaches the engine, so it still gets the polite "one food at a time" refusal and
   * its wobble rather than silently doing nothing.
   */
  const tapFood = useCallback(() => {
    const a = anims[engine.round & 1];
    const food = engine.current;
    if (food && !engine.busy && (a.phase === PH_ENTER || a.phase === PH_IDLE)) {
      const reduced = isReduced();
      startLift(a, reduced);
      // HN2: picking a food up is a question ("now what?"), so both answers say so. The
      // tooth and the dish take up the beat again and the hand gives one small wave.
      invite.hint = HINT_DUR;
      waveHand(hand, 2.1, reduced);
      // Naming it again is the point of the pick-up for a screen-reader player: it is the
      // one moment in the round where "let me look at this first" is a thing they can do.
      announce(
        `You picked up ${FOOD_LABELS[food.id]}. Choose again to feed the tooth, or choose the dish to wave it away.`
      );
      return;
    }
    engine.answer("feed");
  }, [anims, engine, hand, invite]);

  const pressFeed = useCallback(() => {
    const reduced = isReduced();
    pressFood(anims[engine.round & 1], reduced);
    pressMascot(mascot, reduced);
  }, [anims, engine, mascot]);

  const releaseFeed = useCallback(() => {
    const reduced = isReduced();
    releaseFood(anims[engine.round & 1], reduced);
    releaseMascot(mascot, reduced);
  }, [anims, engine, mascot]);

  /* ---------------- keyboard ---------------- */

  /*
   * Three targets, one tab stop, arrows between them: the food, the tooth and the dish. The
   * food and the tooth are the *same* answer — a small child either drags the food to the
   * mouth or taps the character, and until now neither instinct did anything unless the
   * finger happened to land on the pedestal.
   *
   * The count is the constant 3 — it can never change, which sidesteps the hazard Tooth
   * Match documents (a changing `count` releases and re-takes the group reference, and if
   * every `HitTarget` were unmounting in the same commit the group's refcount would touch
   * zero and its hidden container would be removed from the DOM). Each target owns its own
   * activation, so this `onActivate` is the fallback that keeps pointer and keyboard on the
   * same code path.
   */
  useFocusGroup(GROUP, 3, (index) => {
    if (index === 2) engine.answer("wave");
    else if (index === 1) engine.answer("feed");
    else tapFood();
  });

  /* ---------------- the checks the audit had to run by hand ---------------- */

  /**
   * Two DEV self-tests, both measuring things this file has previously *asserted* in a
   * comment and been wrong about.
   *
   * `healthy-or-not-accents` is A15's half that belongs to the scene: it classifies every
   * accent this set puts on screen and fails if the dominant family is not the one the
   * registry declares. `healthy-or-not-targets` re-measures what the `HitTarget` comment
   * below used to state as a fact — that the three colliders never overlap and never fall
   * under §1.5's 48 px floor — from `hit.tsx`'s own projected probes, at whatever viewport
   * the page happens to be, which is the only place a phone can be observed.
   *
   * Dynamic import for the reason `hit.tsx` gives: `selftest.ts` reaches back into the 3D
   * layer, and in a production build this chunk is never fetched.
   */
  useEffect(() => {
    if (FLAGS.selftest === null) return;
    let cancelled = false;
    void import("../../dev/selftest").then(({ registerSelfTest }) => {
      if (cancelled) return;
      registerSelfTest("healthy-or-not-accents", async () => {
        // The registry is read *here*, not in `props.ts`: `src/games/index.ts` imports the
        // scenes, so a scene importing it back at module scope is a cycle. A dynamic import
        // inside a dev-only test is not, and it is what makes `HERO_FAMILY` a claim that can
        // be falsified rather than a constant that agrees with itself.
        const { GAMES } = await import("../index");
        const registered = GAMES.find((g) => g.id === "healthy-or-not")?.accent ?? null;
        const report = auditSceneAccents(sceneAccentPopulation(), HERO_FAMILY);
        const share = (Object.keys(report.share) as (keyof typeof report.share)[])
          .map((f) => `${f} ${(report.share[f] * 100).toFixed(0)}%`)
          .join(", ");
        return {
          name: "healthy-or-not-accents",
          pass: report.matchesRegistry && registered === HERO_FAMILY,
          detail:
            `registry says ${registered ?? "nothing"}, the set is built on ${HERO_FAMILY}; ` +
            `${report.saturated} area samples — ${share}`,
          data: { ...report, registered },
        };
      });
      registerSelfTest("healthy-or-not-targets", () => {
        const mine = hitTargetProbes().filter((p) => p.measured && TARGET_LABELS.includes(p.label));
        const problems: string[] = [];
        for (const p of mine) {
          if (p.r * 2 < p.minScreenPx - 0.5) {
            problems.push(`target ${TARGET_LABELS.indexOf(p.label)} is ${(p.r * 2).toFixed(0)}px across`);
          }
        }
        for (let i = 0; i < mine.length; i++) {
          for (let j = i + 1; j < mine.length; j++) {
            const a = mine[i];
            const b = mine[j];
            const gap = Math.hypot(a.x - b.x, a.y - b.y) - (a.r + b.r);
            if (gap < 0) {
              problems.push(
                `targets ${TARGET_LABELS.indexOf(a.label)} and ${TARGET_LABELS.indexOf(b.label)} ` +
                  `overlap by ${(-gap).toFixed(0)}px`
              );
            }
          }
        }
        return {
          name: "healthy-or-not-targets",
          pass: mine.length === 3 && problems.length === 0,
          detail:
            mine.length === 3
              ? problems.join("; ") ||
                `3 targets, ${mine.map((p) => `${(p.r * 2).toFixed(0)}px`).join(" / ")}, no overlap`
              : `${mine.length} targets measured, expected 3`,
          data: mine,
        };
      });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  /* ---------------- the frame ---------------- */

  useFrame((state, delta) => {
    const dt = safeDelta(delta);
    const reduced = isReduced();
    const elapsed = state.clock.elapsedTime;

    /* Turntable. Slow, and completely still under reduced motion. */
    if (!reduced) table.angle += TABLE_SPIN * dt;
    const tableGroup = tableRef.current;
    if (tableGroup) tableGroup.rotation.y = table.angle;

    /*
     * The celebration hand-off.
     *
     * Since A10, `GameShell` publishes the shared burst into **this scene's own `<View>`**
     * (`view-slot.tsx` → `Scene3D`), so there is one camera, one depth buffer and one rig;
     * this scene keeps rendering behind it — deliberately, so the child stays in the room
     * they were playing in. This game's mascot is the worst case in the product for that: round 2
     * photographed it intersected by the celebration's own tooth, leaving one disembodied
     * eye and two floating cheeks at the frame edge. So the mascot cheers first (`complete`
     * fires `cheer()` and a sparkle burst) and is then popped out across the shared window,
     * arriving at exactly zero before the celebration's mascot exists — as does whatever
     * food is still in flight. The turntable, the pedestal and the dish stay: they are the
     * room, not the character.
     */
    const exit = celebrationHeroScale();

    /*
     * The wordless invitation. One `damp` and two `Math.sin` per frame, no allocation, and
     * it settles to exactly the same scene the reduced-motion path renders.
     */
    invite.v = damp(invite.v, engine.started || reduced ? 0 : 1, INVITE_FADE, dt);
    if (invite.hint > 0) invite.hint -= dt;
    // The opening invitation and the pick-up hint are the same beat; whichever is louder
    // wins, so a hint fired while the opening is still running does not double it.
    const hinting = !reduced && invite.hint > 0 ? clamp01(invite.hint / (HINT_DUR * 0.4)) : 0;
    const calling = invite.v > hinting ? invite.v : hinting;
    const beat = calling > 0.002 ? Math.sin(elapsed * INVITE_HZ * Math.PI) : 0;
    const inviteTooth = 1 + INVITE_TOOTH * calling * (beat > 0 ? beat : 0);
    const inviteDish = 1 + INVITE_DISH * calling * (beat < 0 ? -beat : 0);

    /* Foods. */
    let dishLanded = false;
    for (let i = 0; i < 2; i++) {
      const a = anims[i];
      const group = slotRefs[i].current;
      const blob = blobRefs[i].current;
      if (!group) continue;

      stepFood(
        a,
        dt,
        reduced,
        elapsed,
        layout.tableX,
        layout.tableZ,
        table.angle,
        layout.dishX,
        layout.dishZ
      );
      if (a.justLanded) dishLanded = true;

      const visible = a.phase !== PH_OFF && a.sc > 0.002;
      group.visible = visible;
      if (visible) {
        group.position.set(a.x, a.y, a.z);
        group.rotation.set(a.rx, a.ry, a.rz);
        squashFor(_squash, a.sq, a.sc, 0.3);
        group.scale.set(_squash.x * exit, _squash.y * exit, _squash.z * exit);
      }

      if (blob) {
        /*
         * Close-contact darkening, driven by the gap the food actually has under it.
         *
         * This used to fade the blob out linearly over **0.3 world units** of lift and
         * *shrink* it as the food rose — both backwards. `Rig.tsx` derives the handover the
         * other way round and gives the arithmetic: the contact term is an ambient-occlusion
         * effect of two surfaces being close, so it is gone by `CONTACT_FADE_LIFT` (0.05,
         * one shadow-map texel of gap at the low tier's 512 map over a 12-unit area), and a
         * key of angular half-size `SHADOW_SOFTNESS` throws a penumbra that gets *wider*
         * with height, not narrower. A decal that outlives the handover by 6x and tightens
         * while it does it is the "sticker sitting on top of the real shadow" A3 is about —
         * it is what the penumbra measurement had to force invisible to see anything at all.
         *
         * So: `contactRadiusFor` for the size (public, and the same function `ContactBlob`
         * uses), `contactOpacityFor` for the density, and the material is this slot's own
         * clone because the cached blob materials are `markShared` and mutating one would
         * reach into every other prop in the product that borrowed it.
         */
        const inDish = a.phase === PH_DISH;
        const resting =
          inDish ||
          a.phase === PH_ENTER ||
          a.phase === PH_IDLE ||
          a.phase === PH_LIFT ||
          a.phase === PH_WOBBLE ||
          a.phase === PH_WINDUP;
        const ground = inDish ? DISH_REST_Y : PED_TOP;
        const lift = resting ? a.y - (ground + a.height / 2) : Number.POSITIVE_INFINITY;
        const alpha = resting ? contactOpacityFor(BLOB_OPACITY, lift) * a.sc : 0;
        blob.visible = alpha > 0.004;
        if (blob.visible) {
          const w = contactRadiusFor(a.radius, lift) * 2 * exit;
          blob.position.set(a.x, ground + 0.006, a.z);
          blob.scale.set(w < 1e-4 ? 1e-4 : w, w < 1e-4 ? 1e-4 : w, 1);
          blobMats[i].opacity = alpha;
        }
      }
    }

    /* Mascot. */
    stepMascot(mascot, sparkles, dt, reduced);
    const toothBlob = toothBlobRef.current;
    if (toothBlob) {
      /*
       * The mascot hops on every chomp — `hop.impulse(2.4)` peaks about 0.09 units up, which
       * is nearly twice `Rig.tsx`'s `CONTACT_FADE_LIFT`, so for about half a second its
       * contact blob is a sticker under a character that is not touching anything.
       *
       * The physical response is `contactOpacityFor`, and that needs a material of its own;
       * this scene already spends two on the food pair, and measured, its worst live count
       * is 26 against `BUDGETS.materials` 28 — with a shared focus ring bringing four more
       * whenever a keyboard child is playing. So the third goes to the props that actually
       * fly and the mascot takes the same curve applied to *scale* instead. It is not identical — a
       * shrinking radial falloff keeps its dark core where a fading one does not — but it is
       * the same curve, it reaches exactly zero at the same lift, and it uncovers the PCSS
       * penumbra at exactly the same moment, which is the thing A3 is about.
       */
      const seat = contactOpacityFor(1, mascot.hop.value) * exit;
      toothBlob.scale.set(seat, seat, seat);
      toothBlob.visible = seat > 0.004;
    }
    const tooth = toothRef.current;
    if (tooth) {
      const breath = reduced ? 0 : Math.sin(elapsed * 1.05) * 0.006;
      squashFor(
        _squash,
        mascot.squash.value + mascot.press.value + breath,
        mascot.grow.value * inviteTooth,
        0.24
      );
      tooth.scale.set(_squash.x * exit, _squash.y * exit, _squash.z * exit);
      tooth.position.y = mascot.hop.value;
      // The nod is the press's second half: the head dips toward the child on touch, so the
      // response is a gesture and not only a size change.
      tooth.rotation.x = mascot.nod.value;
      tooth.rotation.y = reduced ? 0 : Math.sin(elapsed * 0.62) * 0.05;
      tooth.rotation.z = reduced ? 0 : Math.sin(elapsed * 0.47) * 0.018;
    }
    /*
     * The opening.
     *
     * It grows *downward from the lip line* rather than symmetrically about it, so the
     * smile is the upper lip through the whole chomp and never has a dark band open above
     * it. Anchoring it means moving it as well as scaling it: the top of the cavity is held
     * at `MOUTH_YN` (a lip-tube's radius inside the lip, so the join is never visible)
     * while the bottom drops. Its width also comes up from `CAVITY_MIN_WIDTH`, so it opens
     * as a slot widening into a grin rather than a circle inflating.
     */
    const cavity = cavityRef.current;
    if (cavity) {
      const open = mascot.open;
      cavity.visible = open > 0.004;
      if (cavity.visible) {
        const half = CAVITY_OPEN_HN * open;
        const wide = CAVITY_HALF_WN * (CAVITY_MIN_WIDTH + (1 - CAVITY_MIN_WIDTH) * open);
        cavity.position.y = (MOUTH_YN - half + LIP_TUBE_N) * TOOTH_H;
        cavity.scale.set(
          (wide * TOOTH_H) / 0.1,
          (half * TOOTH_H) / 0.1,
          (CAVITY_HALF_DN * TOOTH_H) / 0.1
        );
      }
    }
    const tongue = tongueRef.current;
    if (tongue) {
      const show = mascot.open > 0.4 ? (mascot.open - 0.4) / 0.6 : 0;
      tongue.visible = show > 0.02;
      if (tongue.visible) {
        // The tongue *rises out of* the mouth: a ball of fixed, uniform size sliding
        // forward from one full radius behind the cavity's surface to `TONGUE_PROUD_N`
        // proud of it. Never scaled, so it always shades with its own form and its edge is
        // always a shallow cap join — where the old flattened ellipsoid was scaled up
        // inside the opening until it filled it as one hard-edged saturated patch.
        tongue.position.z = (TONGUE_ZN + TONGUE_PROUD_N * show) * TOOTH_H;
      }
    }
    const star = starRef.current;
    if (star) {
      const k = mascot.starT > 0 ? 1 - mascot.starT / mascot.starDur : 1;
      const s = mascot.starT > 0 ? Math.sin(clamp01(k) * Math.PI) * (reduced ? 1 : easeOutBack(clamp01(k * 2.2), 1.9)) : 0;
      star.visible = s > 0.01;
      if (star.visible) {
        star.scale.set(s * TOOTH_H, s * TOOTH_H, s * TOOTH_H);
        star.rotation.z = reduced ? 0 : (1 - k) * 1.2;
      }
    }

    /* The dish: a press sink, a brace before the catch and a dip on the landing. */
    stepDish(dish, dt, dishLanded, reduced);
    const dishGroup = dishRef.current;
    if (dishGroup) {
      squashFor(_squash, dish.press.value, inviteDish, 0.2);
      dishGroup.scale.set(_squash.x, _squash.y, _squash.z);
      dishGroup.position.y = dish.rise.value * 0.05;
    }

    /*
     * The hand. Two motions, added: a slow idle wave that rides the dish's half of the
     * invitation beat, and a sprung one-shot fired when a food is actually waved away.
     * Under reduced motion it is a still gesture — a hand held up — which is a legible cue
     * in itself and costs the child no movement they did not ask for.
     */
    const handGroup = handRef.current;
    if (handGroup) {
      hand.wave.to(0);
      hand.wave.step(dt);
      const idle = reduced
        ? 0
        : Math.sin(elapsed * HAND_HZ * Math.PI * 2) * calling * (beat < 0 ? -beat : 0);
      handGroup.rotation.z = reduced ? 0 : hand.wave.value * HAND_WAVE + idle * HAND_WAVE;
      handGroup.rotation.x = HAND_TILT;
    }

    /* Progress beads. */
    const done = beadDoneRef.current;
    if (done) {
      done.count = progress.answered;
      if (progress.answered > 0) {
        if (progress.popT > 0) progress.popT -= dt;
        const base = (BEAD_R / 0.1) * BEAD_DONE_GROW;
        for (let i = 0; i < progress.answered; i++) {
          let k = base;
          if (i === progress.popIndex && progress.popT > 0) {
            const q = clamp01(1 - progress.popT / (reduced ? FEEL.reducedFade : 0.34));
            k = base * (1 + 0.5 * Math.sin(q * Math.PI) * (reduced ? 0.5 : 1));
          }
          _pos.set(beadRing[i * 2], BEAD_DONE_Y, beadRing[i * 2 + 1]);
          _scl.set(k, k * BEAD_DONE_FLAT, k);
          _mat.compose(_pos, IDENTITY_QUAT, _scl);
          done.setMatrixAt(i, _mat);
        }
        done.instanceMatrix.needsUpdate = true;
      }
    }

    const spark = sparkRef.current;
    if (spark) stepSparkles(sparkles, spark, state.camera.quaternion, dt, reduced);
  });

  /* ---------------- graph ---------------- */

  const eyeS = (EYE_RN * TOOTH_H) / 0.1;
  const glintS = (GLINT_RN * TOOTH_H) / 0.1;

  return (
    <Rig shadowArea={shadowAreaFor(layout)} groundY={0}>
      {/* ---------------- the mascot ---------------- */}
      <group ref={toothRef} position={[TOOTH_X, 0, TOOTH_Z]}>
        <mesh
          geometry={mascotArt.body.geometry}
          material={mascotArt.body.material}
          scale={TOOTH_H}
          castShadow
          receiveShadow
        />
        <mesh
          geometry={mascotArt.eye.geometry}
          material={mascotArt.eye.material}
          position={[-EYE_XN * TOOTH_H, EYE_YN * TOOTH_H, EYE_ZN * TOOTH_H]}
          scale={eyeS}
        />
        <mesh
          geometry={mascotArt.eye.geometry}
          material={mascotArt.eye.material}
          position={[EYE_XN * TOOTH_H, EYE_YN * TOOTH_H, EYE_ZN * TOOTH_H]}
          scale={eyeS}
        />
        <mesh
          geometry={mascotArt.glint.geometry}
          material={mascotArt.glint.material}
          position={[(-EYE_XN - 0.022) * TOOTH_H, (EYE_YN + 0.024) * TOOTH_H, (EYE_ZN + 0.05) * TOOTH_H]}
          scale={glintS}
        />
        <mesh
          geometry={mascotArt.glint.geometry}
          material={mascotArt.glint.material}
          position={[(EYE_XN - 0.022) * TOOTH_H, (EYE_YN + 0.024) * TOOTH_H, (EYE_ZN + 0.05) * TOOTH_H]}
          scale={glintS}
        />
        {/*
          * Blush: a near-tangent spherical cap, not a flat patch cut through the crown.
          * `props.ts` solves the centre; the ball is uniformly scaled, so the cap shades
          * with the form and its boundary is soft (22° between the surfaces, where the
          * ellipsoid it replaces met the crown at 108°).
          */}
        <mesh
          geometry={mascotArt.cheek.geometry}
          material={mascotArt.cheek.material}
          position={CHEEK_LEFT}
          scale={CHEEK_SCALE}
        />
        <mesh
          geometry={mascotArt.cheek.geometry}
          material={mascotArt.cheek.material}
          position={CHEEK_RIGHT}
          scale={CHEEK_SCALE}
        />
        <mesh
          ref={tongueRef}
          geometry={mascotArt.tongue.geometry}
          material={mascotArt.tongue.material}
          position={[0, TONGUE_YN * TOOTH_H, TONGUE_ZN * TOOTH_H]}
          scale={(TONGUE_RN * TOOTH_H) / 0.1}
          visible={false}
        />
        {/* The opening, behind the lip. Hidden at rest — the smile is the arc, not this. */}
        <mesh
          ref={cavityRef}
          geometry={mascotArt.cavity.geometry}
          material={mascotArt.cavity.material}
          position={[0, MOUTH_YN * TOOTH_H, CAVITY_ZN * TOOTH_H]}
          visible={false}
        />
        {/*
          * The smile: one sphere-swept tube on a circle drawn on the crown — curved in all
          * three axes, hugging the surface to its corners, hemispherical ends, and no joint
          * anywhere along it. It is always on: the hero character smiles at rest.
          */}
        <mesh geometry={mascotArt.lip.geometry} material={mascotArt.lip.material} />
        <mesh
          ref={starRef}
          geometry={mascotArt.star.geometry}
          material={mascotArt.star.material}
          position={[0, STAR_Y, STAR_Z - TOOTH_Z]}
          visible={false}
          castShadow
        />
      </group>
      {/*
        The mascot's own contact darkening, in a node of its own so it leaves with the
        mascot. A soft dark ellipse on the table with nothing above it is exactly the orphan
        contact the audit found on `tooth-rescue`'s mat.
      */}
      <group ref={toothBlobRef} position={[TOOTH_X, 0, TOOTH_Z]}>
        <ContactBlob position={[0, 0.005, 0]} radius={TOOTH_H * 0.34} opacity={0.34} />
      </group>

      {/* ---------------- the turntable ---------------- */}
      <group ref={tableRef} position={[layout.tableX, 0, layout.tableZ]}>
        <mesh
          geometry={discGeo}
          material={set.discMaterial}
          position={[0, TABLE_H / 2, 0]}
          castShadow
          receiveShadow
        />
        <mesh
          geometry={rimGeo}
          material={set.rimMaterial}
          position={[0, TABLE_H - TABLE_RIM_TUBE * 0.35, 0]}
          rotation={FLAT_ROT}
          castShadow
          receiveShadow
        />
        <mesh
          geometry={set.pedestal.geometry}
          material={set.pedestal.material}
          position={[0, TABLE_H + PED_H / 2, 0]}
          castShadow
          receiveShadow
        />
        <instancedMesh
          ref={beadRef}
          args={beadArgs}
          frustumCulled={false}
          receiveShadow
        />
        <instancedMesh
          ref={beadDoneRef}
          args={beadDoneArgs}
          frustumCulled={false}
          castShadow
          receiveShadow
        />
      </group>
      <ContactBlob
        position={[layout.tableX, 0.005, layout.tableZ]}
        radius={layout.tableR * 1.05}
        opacity={0.34}
      />

      {/* ---------------- the foods ---------------- */}
      {SLOT_KEYS.map((i) => {
        const content = slots[i];
        return (
          <group key={i} ref={slotRefs[i]} visible={false}>
            {content ? (
              <group key={content.key} position={[0, -foods[content.food.id].height / 2, 0]}>
                {foods[content.food.id].parts.map((p, k) => (
                  <mesh
                    key={k}
                    geometry={p.geometry}
                    material={p.material}
                    position={p.position}
                    rotation={p.rotation}
                    scale={p.scale}
                    castShadow
                    receiveShadow
                  />
                ))}
              </group>
            ) : null}
          </group>
        );
      })}
      {SLOT_KEYS.map((i) => (
        <mesh
          key={i}
          ref={blobRefs[i]}
          geometry={quadGeo}
          material={blobMats[i]}
          rotation={FLAT_ROT}
          renderOrder={2}
          visible={false}
        />
      ))}

      {/* ---------------- the "no thank you" dish, and the hand that waves ---------------- */}
      <group ref={dishRef} position={[layout.dishX, 0, layout.dishZ]}>
        {/*
          An open bowl, revolved in one piece: up the outside, rolled over at the rim, back
          down the inside, and on into the landing pad without a seam. Nothing closes over
          the answer, and there is no second mesh to fight the first for the depth buffer.
        */}
        <mesh
          geometry={set.dish.geometry}
          material={set.dish.material}
          castShadow
          receiveShadow
        />
        {/*
          The gesture the dish could not make on its own (HN2). It is parented to the dish so
          it presses, braces and dips with it — one prop, one answer — and it stands behind
          the bowl so nothing it does can cover where the food lands.
        */}
        <group
          ref={handRef}
          position={[layout.handX - layout.dishX, HAND_LIFT - handFoot, layout.handZ - layout.dishZ]}
        >
          <mesh
            geometry={set.hand.geometry}
            material={set.hand.material}
            castShadow
            receiveShadow
          />
        </group>
        {/*
          0.34, the same density the other three contacts use, so all four share one
          quantised material out of `materials.ts`'s blob cache rather than minting a fifth.
        */}
        <ContactBlob
          position={[layout.handX - layout.dishX, 0.005, layout.handZ - layout.dishZ]}
          radius={contactRadiusFor(0.075)}
          opacity={0.34}
        />
      </group>
      <ContactBlob
        position={[layout.dishX, 0.005, layout.dishZ]}
        radius={contactRadiusFor(DISH_R)}
        opacity={0.34}
      />

      {/* ---------------- sparkles ---------------- */}
      <instancedMesh
        ref={sparkRef}
        args={sparkArgs}
        frustumCulled={false}
        renderOrder={6}
      />

      {/*
        * The three targets, and every one of them answers the finger on `pointerdown`.
        *
        * Two of them lead to the same answer on purpose. A four-year-old's first instincts
        * are to touch the food and to touch the character; the shipped build registered
        * only the food and the hand, so tapping the tooth — the most obvious thing on
        * screen — did nothing at all.
        *
        * Re-measured against the solve after the play area started being measured at all
        * (HN1) and after the hand joined the dish. Projected diameters and the smallest gap
        * between any two circles, from the solve itself:
        *
        *   390x844 phone   food 115 px  tooth 122 px  dish 174 px   gap  6.4 px
        *   1024x768 tablet food 142 px  tooth 142 px  dish 195 px   gap 62.5 px
        *   1440x900 laptop food 177 px  tooth 177 px  dish 244 px   gap 71.1 px
        *
        * The props' own radii win everywhere, so `minScreenPx` never has to inflate a
        * collider past its prop. The phone gap is small and deliberately not "fixed": it is
        * between the food and the tooth, which are the *same answer*, so the worst a stray
        * finger can do there is the thing it was going to do anyway.
        * `?selftest=healthy-or-not-targets` re-measures all of this in the page.
        *
        * `onPress` / `onRelease` are not decoration here. Every one of these used to pass
        * `onSelect` alone, and the first thing a child saw after touching the food or the
        * tooth was 320 ms of nothing — the chomp and the lid were both scheduled to *lead*
        * the food's arrival, which is 100 ms of wind-up plus a 420–460 ms flight later.
        * §4 asks for a visible response inside one frame, and this is it.
        */}
      <HitTarget
        ariaLabel={LABEL_FOOD}
        group={GROUP}
        focusOrder={0}
        position={[layout.tableX, PED_TOP + 0.26, layout.tableZ]}
        radius={0.32}
        minScreenPx={48}
        onPress={pressFeed}
        onRelease={releaseFeed}
        onSelect={tapFood}
      />
      <HitTarget
        ariaLabel={LABEL_TOOTH}
        group={GROUP}
        focusOrder={1}
        position={[TOOTH_X, CROWN_YN * TOOTH_H, TOOTH_Z]}
        radius={CROWN_RN * TOOTH_H}
        minScreenPx={48}
        onPress={pressFeed}
        onRelease={releaseFeed}
        onSelect={() => engine.answer("feed")}
      />
      <HitTarget
        ariaLabel={LABEL_DISH}
        group={GROUP}
        focusOrder={2}
        position={[layout.dishX, DISH_H * 0.7, layout.dishZ]}
        radius={DISH_R}
        minScreenPx={48}
        onPress={() => pressDish(dish, isReduced())}
        onRelease={() => releaseDish(dish, isReduced())}
        onSelect={() => engine.answer("wave")}
      />
    </Rig>
  );
}

/**
 * Memoised on `engine` (which never changes identity) and `aspect` (a number that only
 * moves when the play area is genuinely resized) — so the shell re-rendering its HUD once a
 * second, or on every answer, does not touch the 3D tree at all.
 */
export const HealthyScene = memo(HealthySceneImpl);
