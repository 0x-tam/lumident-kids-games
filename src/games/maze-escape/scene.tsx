/**
 * Maze Escape — the 3D board.
 *
 * Wiring, following the pattern Tooth Match set:
 *
 *  • One prop, the engine, whose identity never changes. Nothing about the tooth's travel
 *    travels through React.
 *  • The component subscribes to the engine once and mutates plain structs from the
 *    callback. It re-renders on exactly two events — `maze` (a new maze exists, so new
 *    geometry and new treats) and `focus` (the keyboard surface gained or lost focus, so
 *    the focus ring appears). Every move, bump and treat is struct mutation only.
 *  • `useFrame` reads those structs and writes `Object3D` transforms. It allocates nothing:
 *    no `new`, no literals, no closures, no `map`.
 *
 * ## Motion
 *
 * The tooth **rolls**: the roll angle is `distance travelled / radius`, integrated into the
 * roller's quaternion every frame, so it can never skate however fast a finger drags. It
 * leans into its direction of travel (a pitch about the axis across the corridor, growing
 * with speed) and **banks** into corners (an underdamped spring about the axis along the
 * corridor, kicked by the signed turn at the moment the direction changes). When it stops
 * it settles upright with a hop and a squash — which is also what keeps a rolling face from
 * ever coming to rest upside down.
 *
 * A wall is a bonk, never a failure, and it is a *choreographed* one: the tooth rears back
 * and stretches for 60 ms, then lunges into the gum, flattens along the bump axis to within
 * a whisker of `squashFor`'s clamp, noses its crown over toward the wall, rebounds past its
 * own resting place and settles — 433 ms end to end. The amplitude is bounded by the
 * corridor, not by taste: see `BUMP_PUSH`. Nothing is lost, no counter moves, and the child
 * can carry straight on.
 *
 * The **toothbrush beckons continuously**, from the first frame of the run and wherever the
 * tooth is. It used to hold perfectly still until the tooth was within 2.7 cells of it,
 * which meant the one object a child needs to find was the only inanimate thing on the
 * board right up until they had already found it. The near-field wag is still there; it is
 * now an excited *addition* to an idle that never stops.
 *
 * ## Reduced motion
 *
 * `isReduced()` is read fresh every frame and at every event. No roll, no lean, no bank, no
 * idle bob on the treats, no beckon on the toothbrush, no sparkle velocity, and the camera
 * is already static (`Scene3D`'s `CameraRig`). The tooth still travels — it has to, that is
 * the game — but it settles on an exponential approach with a much stiffer response, and
 * bumps and treats become 150 ms scale pops. Still fully playable, still readable.
 *
 * Losing the beckon costs this branch nothing it cannot afford, because none of the goal's
 * legibility rests on motion: it is 1.2 cells tall against 0.55-cell walls, it leans its
 * bristle face into the lens, and its head is ivory at 3.14:1 against the coral gum. Motion
 * is the invitation, not the signpost.
 */
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import {
  AdditiveBlending,
  DynamicDrawUsage,
  Matrix4,
  MeshBasicMaterial,
  PlaneGeometry,
  PerspectiveCamera,
  Quaternion,
  Vector3,
  type Group,
  type InstancedMesh,
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
import { cachedGeometry, roundedPlate } from "../../three/geometry";
import { FocusRing } from "../../three/hit";
import { playAreaMetrics } from "../../three/Scene3D";
import { clay, clayGum, clayIvory, shadowBlobMaterial } from "../../three/materials";
import { ContactBlob, Rig, contactOpacityFor, contactRadiusFor } from "../../three/Rig";
import {
  CELEBRATION_EXIT_SECONDS,
  CELEBRATION_EXIT_SECONDS_REDUCED,
  celebration,
  celebrationHeroScale,
  isReduced,
} from "../../three/store";
import { sparkleTexture } from "../../three/textures";
import { CLAY } from "../../three/tokens";
import { buildMazeGeometry, disposeMazeGeometry } from "./build";
import type { MazeEscapeEngine } from "./engine";
import {
  BASE_T,
  BOARD,
  BRUSH_HEIGHT,
  BRUSH_TILT,
  BRUSH_YAW,
  SLAB_SINK,
  FLOOR_Y,
  GOAL_OFFSET,
  SHADOW_AREA,
  boardCorner,
  brushBaseY,
  cellSize,
  cellX,
  cellZ,
  toothRadius,
  worldToU,
  worldToV,
} from "./layout";
import { buildProps, type Part } from "./props";

/* ------------------------------------------------------------------ */
/* Tuning                                                              */
/* ------------------------------------------------------------------ */

/** Cruise speed, in cells per second. Fast enough to keep up with a dragging finger. */
const SPEED_CELLS = 7.4;
const SPEED_CELLS_REDUCED = 9.5;
/** Extra speed per queued cell, so the tooth closes a lag instead of accumulating one. */
const CATCH_UP = 0.32;
const CATCH_UP_MAX = 5;

const MAX_LEAN = 0.24;
const BANK_KICK = 3.4;
/** Hop and squash when the tooth rolls to a stop. */
const SETTLE_HOP = 1.5;
const SETTLE_SQUASH = -2.6;
/**
 * Bump response.
 *
 * ## The beat
 *
 * A wall bonk is the interaction a child performs most in a maze and §6.2 names wall squash
 * as one of this game's defining features, so it is choreographed rather than dialled:
 *
 *   0 – 60 ms   the tooth rears back `BUMP_RECOIL` and **stretches** along the bump axis —
 *               §4's wind-up, an opposite-direction dip inside its 50–80 ms window;
 *   60 – 133 ms it lunges, flattens to 27 % against `squashFor`'s 0.28 clamp, and noses
 *               over 10.9° toward the wall;
 *   133 – 280 ms it rebounds past its own resting place and stretches again;
 *   → 430 ms    settled.
 *
 * ## Why these numbers
 *
 * Round 3 measured what shipped at **4.2 px of push and 11.2 % of squash over 283 ms** —
 * "the silhouette stays a round dome, centroid moves 602.5 → 598.5 px" — i.e. a beat a child
 * cannot see. Reproduced exactly by `scratchpad/verify/maze-bump.mjs`, which runs
 * `anim.ts::Spring`'s own integrator (fixed 1/240 sub-step, dt clamped to 0.05) at a 60 fps
 * cadence, so every figure below is simulated rather than asserted.
 *
 * The push is **not** free to grow: the mascot is 0.4577 of its own height wide across the
 * corridor — the *arms*, which reach further than the crown does — the corridor is exactly
 * one cell, and the leading surface may kiss the gum but must not pass through it. Squashing
 * pulls that half-extent in to 0.3295 and the nose-over pushes it back out to 0.3675, which
 * leaves 0.206 of a cell of travel. `BUMP_PUSH` 6.0 peaks at 0.155 of a cell and the
 * simulation's closest approach to the wall over the whole beat is **2.19 px** on the
 * tightest board (13 cells), including a train of four bumps at the engine's own 260 ms
 * `BUMP_INTERVAL`. `scratchpad/verify/maze-hero.mjs` derives the half-extents from
 * `TOOTH_BALLS.baby` and `MASCOT_FACE` rather than from a bounding box.
 *
 * Measured result, at the audited desktop framing (160.3 px/unit) on the 9-cell board:
 * 10.5 px of push, 27.2 % of squash, 10.9° of nose-over, 15.6 px of crown travel and a
 * 433 ms beat — against 4.2 px, 11.2 %, none and 283 ms.
 *
 * `push` is (260, 18) and not the (260, 15) the audit proposed: 15 is outside §4's band, and
 * the extra rebound it buys (2.4 px against 2.1) is not worth leaving it.
 *
 * **This comment used to end "the springs sit inside §4's stated band", and this file shipped
 * four that did not** — `bank`, `hop` and the treats' `bob` and `spin`. That sentence is
 * exactly the failure §4.1 now names by file and line, so it is gone rather than corrected in
 * place. The four are resolved at their own declarations: `hop` is retuned into the band
 * because a landing is something the child waits on, and the other three carry §4.1
 * Exception 1 by name because they are flourishes with no state attached.
 *
 * ## The wall these numbers are measured against
 *
 * `scratchpad/verify/maze-bump.mjs` measured its wall gap at `cell / 2`, and the wall is not
 * there: `ExtrudeGeometry` swells the gum into the corridor by one `wallBevel` through the
 * whole middle band (`layout.ts::wallSwell`). Against the real face the shipped tuning was
 * **4.04 px inside the gum** at 9 cells, not 3.17 px clear of it — a self-check looser than
 * the geometry it checked. The verifier now measures against `corridorClear`, `buildGum` cuts
 * the corridor to the width this file always assumed, and the numbers above are what the
 * corrected check reports.
 */
const BUMP_PUSH = 6.0;
const BUMP_SQUASH = -11;
const BUMP_TWIST = 2.2;
/** Nose-over: the crown tips toward the wall it bonked. Peaks at 10.9°. */
const BUMP_TIP = 7;
/** Wind-up: a backward nudge and a stretch along the bump axis, before the lunge. */
const BUMP_RECOIL = 1.1;
const BUMP_STRETCH = 1.6;
/** §4 asks for 50–80 ms of wind-up; this is four frames at 60 fps. */
const BUMP_WINDUP = 0.06;

/**
 * How far into the closed end of its dead end a sweet is tucked, in cells.
 *
 * The treats are now real objects — a 0.47-cell lollipop, a 0.4-cell ice cream — and the
 * tooth that comes to collect one is 0.8 cells across and comes to rest on the cell's own
 * centre. Parking the sweet at the centre too would bury it inside the hero. A dead end has
 * exactly one open side, so "away from it" is unambiguous, and it also composes better: the
 * sweet reads as *stashed* at the end of the pocket rather than dropped in the doorway.
 */
const TREAT_TUCK = 0.22;

/** One sparkle every this many cells of travel. */
const TRAIL_STEP = 0.46;
const SPARKLES = 24;

/** Travel queue. Deep enough that a fast drag never reaches the end of it. */
const QUEUE = 48;

/**
 * Distance, in cells, at which the toothbrush starts noticing the tooth *specifically*.
 *
 * This used to gate the brush's only motion, which meant the goal stood dead still until
 * the child had nearly finished — the one moment they no longer needed help finding it.
 * It now layers an excited near-field wag on top of `IDLE_*` below, which never stops.
 */
const NOTICE_CELLS = 2.7;

/**
 * The brush's continuous idle beckon: a slow lean and a slower rise, always running.
 *
 * Amplitudes are in radians and cells. They are deliberately small — the goal has to be
 * *findable* from the far corner of the board, and it is the brush's height, its lean and
 * its mauve-against-coral handle that do that. The beckon is what makes it read as *alive*
 * and therefore as the thing to head for, not what makes it visible. Two decorrelated
 * frequencies so it never looks like a metronome.
 */
const IDLE_SWAY = 0.085;
const IDLE_SWAY_HZ = 1.15;
const IDLE_RISE = 0.035;
const IDLE_RISE_HZ = 0.74;
/** Excited wag, added on top of the idle when the tooth is close. */
const NEAR_SWAY = 0.2;
const NEAR_SWAY_HZ = 7.4;
const NEAR_BOUNCE = 0.075;
const NEAR_BOUNCE_HZ = 6.2;

/**
 * Where the brush's head centre sits relative to the socket it is planted in, in cells.
 *
 * Derived from the stance rather than typed in, so the win burst cannot drift off the head
 * if the brush is ever re-authored. `props.ts` centres the head at 0.85 of `BRUSH_HEIGHT`
 * along the brush's own axis (the parts run 0.84 → 1.20 of 1.2), and the stance turns that
 * axis by `BRUSH_TILT` about world X, which maps local +Y to `(0, cos t, sin t)` — `t` being
 * negative is exactly what carries the head back over the goal cell and turns its bristle
 * face into the lens. Resolves to 0.900 cells up and 0.479 cells toward the camera-far side.
 */
/**
 * The hero's own contact blob, as a footprint and a density rather than a quad size.
 *
 * `BLOB_FOOTPRINT` is the tooth's silhouette radius on the floor in cells — its body half
 * extent, 0.2925 of a cell, rounded up to the arm reach so the pinch covers what the child
 * sees touching down. `contactRadiusFor` turns that into the quad, so the "how big" question
 * is answered once, in `Rig.tsx`, for every prop in the product.
 */
/**
 * How far the board sinks as it hands the frame to the celebration, in world units.
 *
 * ## ME6
 *
 * `GameShell` renders the shared celebration into **this scene's own `<View>`**, and
 * `celebrate.tsx` fits its mascot to the ground plane the game's `<Rig>` installed — y = 0,
 * centred, clamped only to the shadow frustum. On this board that lands a 1.05-unit mascot
 * standing at the *table*, 0.16 below the corridor floor, in the middle of a 0.39-unit wall
 * whenever the maze happens to put one there (about half the time). `maze-escape-keyboard-end.png`
 * is that frame: a coral wall through the mascot's cheek.
 *
 * The fix list asks for the board's occluders to be handed to the celebration solve and for
 * the partial fade to become "a full fade to a flat backdrop". The first half has no API —
 * `solveCelebrationFit` takes a ground plane and a shadow radius and nothing else, and
 * `celebrate.tsx` is not this folder's to change. The second half is entirely here, and it is
 * the stronger of the two anyway: a board that is *gone* cannot slice anything, and the cream
 * table it sinks into is exactly the flat backdrop asked for.
 *
 * Sunk rather than faded, because a fade needs a transparent clay material — a second shader
 * permutation per material, which is the memory defect A6 exists for — and because sinking is
 * what a toy does when it is put away. 0.72 units puts the wall tops 0.33 below the ground
 * plane, which is opaque and 60 units across, so nothing of the board survives the move.
 *
 * The window is the shared hand-off window, so the board and the hero leave as one gesture and
 * both are gone before the celebration's mascot exists (`store.ts` derives the 0.24 s from
 * `celebrate.tsx`'s own wind-up). The child's run is over 450 ms before this starts — the
 * engine's `FINISH_DELAY` — so the tooth's bow at the toothbrush plays in full first.
 */
const BOARD_SINK = 0.72;

/** How often the snap radius is re-measured, in frames. See the frame loop. */
const SNAP_MEASURE_FRAMES = 30;

const BLOB_FOOTPRINT = 0.34;
const BLOB_OPACITY = 0.42;

const HEAD_AXIS = BRUSH_HEIGHT * 0.85;
const HEAD_UP = Math.cos(BRUSH_TILT) * HEAD_AXIS;
const HEAD_BACK = Math.sin(BRUSH_TILT) * HEAD_AXIS;

/* ------------------------------------------------------------------ */
/* Per-frame scratch — module level, allocated exactly once            */
/* ------------------------------------------------------------------ */

const _pos = new Vector3();
const _scl = new Vector3();
const _mat = new Matrix4();
const _axis = new Vector3(0, 0, 1);
const _spin = new Quaternion();
const _lean = new Quaternion();
const _bank = new Quaternion();
const _upright = new Quaternion();
const _squash = { x: 1, y: 1, z: 1 };
const _boardCentre = new Vector3();

const FLAT_ROT: [number, number, number] = [-Math.PI / 2, 0, 0];

/* ------------------------------------------------------------------ */
/* Tooth animation state                                               */
/* ------------------------------------------------------------------ */

type ToothAnim = {
  x: number;
  z: number;
  /** Unit direction of the segment being travelled, zero when at rest. */
  dirX: number;
  dirZ: number;
  /** Last non-zero direction — the lean and bank axes keep using it after the stop. */
  faceX: number;
  faceZ: number;
  speed: number;
  /** Cell the tail of the queue points at; where the tooth comes to rest. */
  restR: number;
  restC: number;
  queue: Int16Array;
  qHead: number;
  qLen: number;

  lean: Spring;
  bank: Spring;
  hop: Spring;
  vSquash: Spring;
  hSquash: Spring;
  push: Spring;
  /** Nose-over about the axis across the bump — the crown tipping into the wall. */
  tip: Spring;

  bumpX: number;
  bumpZ: number;
  bumpYaw: number;
  /**
   * Seconds of wind-up still to run before the lunge fires, and the two impulses it will
   * fire with. Held on the struct rather than in a closure so the frame loop stays
   * allocation-free.
   */
  bumpArm: number;
  bumpKick: number;
  bumpTwist: number;

  moving: boolean;
  trail: number;

  /** Reduced-motion scale pop: springs are deliberately inert under reduced motion. */
  popT: number;
  popDur: number;
  popAmp: number;
};

function createTooth(r: number, c: number, n: number): ToothAnim {
  return {
    x: cellX(c, n),
    z: cellZ(r, n),
    dirX: 0,
    dirZ: 0,
    faceX: 0,
    faceZ: 1,
    speed: 0,
    restR: r,
    restC: c,
    queue: new Int16Array(QUEUE),
    qHead: 0,
    qLen: 0,
    lean: new Spring(0, 300, 20),
    /*
     * §4.1 Exception 1 — comic wobble. ζ = 0.318, first overshoot 34.9 %, 2 % settle 727 ms.
     * The bank is the tooth leaning into a turn: a flourish that carries no state, that
     * nothing is waiting on, and whose visible ring-down is the point. Inside the exception's
     * ζ 0.25–0.44 / ≤ 45 % / ≤ 900 ms bounds.
     */
    bank: new Spring(0, 300, 11),
    // §4's settle band. `damping` 18, not 15: a hop is a *landing* and the child is waiting on
    // it, so it takes the band rather than Exception 1. ζ 0.503, overshoot 16.1 %, settle
    // 444 ms — against ζ 0.419 / 23.4 % / 533 ms at 15, which was outside it.
    hop: new Spring(0, 320, 18),
    vSquash: new Spring(0, 400, 18),
    hSquash: new Spring(0, 380, 18),
    push: new Spring(0, 260, 18),
    tip: new Spring(0, 300, 20),
    bumpX: 0,
    bumpZ: 0,
    bumpYaw: 0,
    bumpArm: 0,
    bumpKick: 0,
    bumpTwist: 0,
    moving: false,
    trail: 0,
    popT: 0,
    popDur: FEEL.reducedFade,
    popAmp: 0,
  };
}

function pop(a: ToothAnim, amp: number, dur: number): void {
  a.popAmp = amp;
  a.popDur = dur;
  a.popT = dur;
}

/** Resets the tooth onto a fresh maze with no motion carried over from the last run. */
function resetTooth(a: ToothAnim, r: number, c: number, n: number): void {
  a.x = cellX(c, n);
  a.z = cellZ(r, n);
  a.dirX = 0;
  a.dirZ = 0;
  a.faceX = 0;
  a.faceZ = 1;
  a.speed = 0;
  a.restR = r;
  a.restC = c;
  a.qHead = 0;
  a.qLen = 0;
  a.lean.set(0);
  a.bank.set(0);
  a.hop.set(0);
  a.vSquash.set(0);
  a.hSquash.set(0);
  a.push.set(0);
  a.tip.set(0);
  a.bumpArm = 0;
  a.moving = false;
  a.trail = 0;
  a.popT = 0;
}

function pushCell(a: ToothAnim, r: number, c: number, n: number): void {
  if (a.qLen >= QUEUE) {
    // Cannot happen at any human drag speed, but a desynced tooth would be a bug the child
    // sees, so jump to the oldest queued cell rather than silently dropping it.
    const at = a.queue[a.qHead];
    const jr = (at / n) | 0;
    a.restR = jr;
    a.restC = at - jr * n;
    a.x = cellX(a.restC, n);
    a.z = cellZ(a.restR, n);
    a.qHead = (a.qHead + 1) % QUEUE;
    a.qLen--;
  }
  a.queue[(a.qHead + a.qLen) % QUEUE] = r * n + c;
  a.qLen++;
}

function bumpTooth(a: ToothAnim, dr: number, dc: number, reduced: boolean, cell: number): void {
  a.bumpX = dc;
  a.bumpZ = dr;
  // Local +X of the squash node points along the bump: rotation.y = t maps X to
  // (cos t, 0, -sin t), so cos t = bumpX and -sin t = bumpZ.
  a.bumpYaw = Math.atan2(-dr, dc);
  if (reduced) {
    a.bumpArm = 0;
    pop(a, -0.12, FEEL.reducedFade);
    return;
  }
  // The wind-up starts on this frame — §4's "visible within one frame" is satisfied by the
  // recoil and the stretch, not by the lunge, which is the whole point of an anticipation.
  a.push.impulse(-cell * BUMP_RECOIL);
  a.hSquash.impulse(BUMP_STRETCH);
  a.bumpKick = cell * BUMP_PUSH;
  a.bumpTwist = dc !== 0 ? BUMP_TWIST : -BUMP_TWIST;
  a.bumpArm = BUMP_WINDUP;
}

/** Fires the lunge once the wind-up has run its 60 ms. Called from the frame loop. */
function releaseBump(a: ToothAnim, dt: number): void {
  if (a.bumpArm <= 0) return;
  a.bumpArm -= dt;
  if (a.bumpArm > 0) return;
  a.bumpArm = 0;
  a.push.impulse(a.bumpKick);
  a.hSquash.impulse(BUMP_SQUASH);
  a.tip.impulse(BUMP_TIP);
  a.bank.impulse(a.bumpTwist);
}

/**
 * Advances the tooth along its queued path and returns the distance covered this frame.
 *
 * Constant-speed locomotion with a damped ramp at both ends: a rolling object does not
 * ease-in-out between cells, it accelerates, cruises and rolls to a stop. The loop consumes
 * more than one cell per frame only when a long frame or a deep queue makes it necessary.
 */
function travel(a: ToothAnim, dt: number, reduced: boolean, n: number, cell: number): number {
  const cruise = cell * (reduced ? SPEED_CELLS_REDUCED : SPEED_CELLS);
  const catchUp = 1 + CATCH_UP * (a.qLen > CATCH_UP_MAX ? CATCH_UP_MAX : a.qLen);

  // Peek at the current target only to decide whether there is anywhere to go.
  let tr = a.restR;
  let tc = a.restC;
  if (a.qLen > 0) {
    const at = a.queue[a.qHead];
    tr = (at / n) | 0;
    tc = at - tr * n;
  }
  const gapX = cellX(tc, n) - a.x;
  const gapZ = cellZ(tr, n) - a.z;
  const want = gapX * gapX + gapZ * gapZ > 1e-10 ? cruise * catchUp : 0;
  a.speed = damp(a.speed, want, reduced ? 30 : 16, dt);

  let remaining = a.speed * dt;
  let travelled = 0;
  let guard = 8;

  while (remaining > 1e-6 && guard-- > 0) {
    let r = a.restR;
    let c = a.restC;
    if (a.qLen > 0) {
      const at = a.queue[a.qHead];
      r = (at / n) | 0;
      c = at - r * n;
    }
    const tx = cellX(c, n);
    const tz = cellZ(r, n);
    const dx = tx - a.x;
    const dz = tz - a.z;
    const dist = Math.sqrt(dx * dx + dz * dz);

    if (dist <= 1e-5) {
      if (a.qLen === 0) break;
      a.restR = r;
      a.restC = c;
      a.qHead = (a.qHead + 1) % QUEUE;
      a.qLen--;
      continue;
    }

    const ndx = dx / dist;
    const ndz = dz / dist;
    if (ndx !== a.dirX || ndz !== a.dirZ) {
      if (a.dirX !== 0 || a.dirZ !== 0) {
        const turn = a.dirX * ndz - a.dirZ * ndx;
        if (!reduced && (turn > 0.1 || turn < -0.1)) a.bank.impulse(turn * BANK_KICK);
      }
      a.dirX = ndx;
      a.dirZ = ndz;
      a.faceX = ndx;
      a.faceZ = ndz;
    }

    if (remaining >= dist) {
      a.x = tx;
      a.z = tz;
      travelled += dist;
      remaining -= dist;
      if (a.qLen === 0) break;
      a.restR = r;
      a.restC = c;
      a.qHead = (a.qHead + 1) % QUEUE;
      a.qLen--;
    } else {
      a.x += ndx * remaining;
      a.z += ndz * remaining;
      travelled += remaining;
      remaining = 0;
    }
  }

  return travelled;
}

/* ------------------------------------------------------------------ */
/* Treats                                                              */
/* ------------------------------------------------------------------ */

type TreatAnim = {
  x: number;
  z: number;
  kind: number;
  seed: number;
  bob: Spring;
  spin: Spring;
  popT: number;
  popAmp: number;
};

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

/** Fired from a discrete event or a distance threshold, never per frame. */
function burst(
  field: SparkleField,
  x: number,
  y: number,
  z: number,
  count: number,
  spread: number,
  reduced: boolean
): void {
  for (let k = 0; k < count; k++) {
    const i = field.next;
    field.next = (field.next + 1) % field.n;
    if (field.dur[i] <= 0) field.live++;
    field.px[i] = x + (Math.random() - 0.5) * spread;
    field.py[i] = y + Math.random() * spread * 0.5;
    field.pz[i] = z + (Math.random() - 0.5) * spread;
    const a = Math.random() * Math.PI * 2;
    const e = 0.3 + Math.random() * 0.9;
    const s = reduced ? 0 : spread * (1.6 + Math.random() * 1.4);
    field.vx[i] = Math.cos(a) * Math.cos(e) * s;
    field.vy[i] = Math.sin(e) * s + (reduced ? 0 : spread * 1.1);
    field.vz[i] = Math.sin(a) * Math.cos(e) * s;
    field.life[i] = 0;
    // Reduced motion gets a plain 150 ms fade in place, matching `FEEL.reducedFade`.
    field.dur[i] = reduced ? 0.15 : 0.5 + Math.random() * 0.3;
    field.size[i] = spread * (0.6 + Math.random() * 0.5);
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
      field.vy[i] -= 2.6 * dt;
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

function PartMesh({ part: p, castShadow = false }: { part: Part; castShadow?: boolean }): JSX.Element {
  return (
    <mesh
      geometry={p.geometry}
      material={p.material}
      position={p.position}
      rotation={p.rotation}
      scale={p.scale}
      castShadow={castShadow}
      receiveShadow
    />
  );
}

function MazeEscapeSceneImpl({
  engine,
  scale = 1,
}: {
  engine: MazeEscapeEngine;
  /** Board scale from `cameraFor`. 1 unless the play area is narrower than 0.44:1. */
  scale?: number;
}): JSX.Element {
  /** Bumped by the `maze` event — one of only two engine events that re-render this tree. */
  const [mazeId, setMazeId] = useState(0);
  const [focused, setFocused] = useState(engine.focused);

  const n = engine.n;
  const cell = cellSize(n);
  const R = toothRadius(n);

  const bag = useMemo(() => new DisposalBag(), []);
  const sparkles = useMemo(() => createSparkles(SPARKLES), []);
  const props = useMemo(() => buildProps(n), [n]);

  /* ---------------- the maze's own geometry (built + freed per run) ---------------- */

  const geometry = useMemo(
    () => buildMazeGeometry(engine.maze, engine.n, engine.goal),
    // `mazeId` is the dependency that matters: it changes exactly when `engine.maze` does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [engine, mazeId]
  );

  /**
   * The only leak this game could have.
   *
   * React runs this cleanup after the commit that swapped in the *new* geometry, so by the
   * time the old block is disposed no mesh references it any more. On unmount it frees the
   * live one. Nothing else here is ours: every other geometry and material came back
   * `markShared` from a foundation cache.
   */
  useEffect(() => () => disposeMazeGeometry(geometry), [geometry]);

  /* ---------------- shared board resources ---------------- */

  const slabGeo = useMemo(() => roundedPlate(BOARD, BOARD, BASE_T - SLAB_SINK, boardCorner(n)), [n]);
  const quadGeo = useMemo(() => cachedGeometry("maze-escape/quad", () => new PlaneGeometry(1, 1)), []);
  const slabMat = useMemo(
    () => clay("maze-escape/slab", { color: CLAY.ivoryDeep, roughness: 0.78, sheen: 0.18, grain: 0.14 }),
    []
  );
  const floorMat = useMemo(() => clayIvory(), []);
  const gumMat = useMemo(() => clayGum("main"), []);
  /**
   * The hero's contact blob material, **cloned** rather than shared.
   *
   * `shadowBlobMaterial()` hands back an entry from `materials.ts`'s opacity-quantised blob
   * cache, and this scene writes `opacity` on it every frame as the tooth hops (A3). Writing
   * a cached material would reach every other blob in the product. The clone shares the map,
   * so it is the same shader permutation and costs no extra program; it is this scene's to
   * free, and the disposal bag below does.
   */
  const blobMat = useMemo(() => shadowBlobMaterial().clone(), []);

  /**
   * Two materials this game constructs itself, and therefore the two it must free.
   *
   * `pickMat` is a raycast collider, not a look: `material.visible = false` means the
   * renderer skips the plane entirely while the raycaster still sees it — the same trick
   * `hit.tsx` uses for every `HitTarget` collider in the product.
   */
  const pickMat = useMemo(() => new MeshBasicMaterial({ visible: false }), []);
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

  useEffect(() => {
    bag.add(pickMat);
    bag.add(sparkleMat);
    bag.add(blobMat);
    return () => bag.release();
  }, [bag, pickMat, sparkleMat, blobMat]);

  /* ---------------- per-run animation state ---------------- */

  /**
   * `FocusRing` compensates for its parents' accumulated scale and then sets its own **world**
   * radius to what it is handed, so the board scale has to be folded in here or the ring
   * would stay full size around a shrunken tooth.
   */
  const ringRadius = useMemo(() => {
    const [hx, hy, hz] = props.tooth.half;
    return Math.max(hx, Math.max(hy, hz)) * scale;
  }, [props, scale]);

  /** The framing scale, read every frame by the board's celebration exit. */
  const scaleRef = useRef(scale);
  scaleRef.current = scale;

  const tooth = useMemo(() => createTooth(1, 1, n), [n]);
  const toothRef = useRef(tooth);
  toothRef.current = tooth;

  const treats = useMemo<TreatAnim[]>(() => {
    const out: TreatAnim[] = [];
    const maze = engine.maze;
    const cells = engine.n;
    const pitch = cellSize(cells);
    for (let i = 0; i < engine.treats.length; i++) {
      const t = engine.treats[i];
      // Push away from the dead end's single open side. The guards are belt-and-braces: a
      // treat is always an interior cell, and a cell with no open neighbour cannot exist in
      // a generated maze — but a zero offset is a correct answer if either ever changed.
      let ox = 0;
      let oz = 0;
      if (t.r > 0 && !maze[t.r - 1][t.c]) oz = 1;
      else if (t.r < cells - 1 && !maze[t.r + 1][t.c]) oz = -1;
      else if (t.c > 0 && !maze[t.r][t.c - 1]) ox = 1;
      else if (t.c < cells - 1 && !maze[t.r][t.c + 1]) ox = -1;
      out.push({
        x: cellX(t.c, cells) + ox * pitch * TREAT_TUCK,
        z: cellZ(t.r, cells) + oz * pitch * TREAT_TUCK,
        kind: i % 2,
        seed: (i * 2.3999632297) % (Math.PI * 2),
        // Both §4.1 Exception 1 — comic wobble. A sweet's idle bob (ζ 0.375, 28.0 %, 615 ms)
        // and its spin (ζ 0.403 at k 260, 24.5 %, 615 ms) are idle flourishes on a prop the
        // child never waits for. `spin`'s stiffness goes 240 → 260 because the exception
        // covers ring-down, not speed, and 260 is §4's floor for the natural frequency.
        bob: new Spring(0, 300, 13),
        spin: new Spring(0, 260, 12),
        popT: 0,
        popAmp: 0,
      });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, mazeId]);
  const treatsRef = useRef(treats);
  treatsRef.current = treats;

  /** Where the toothbrush stands this run — read every frame, so cached as plain numbers. */
  const goalX = cellX(engine.goal.c, n);
  const goalZ = cellZ(engine.goal.r, n);
  const goalRef = useRef({ x: goalX, z: goalZ, near: 0, armed: false, pop: 0 });
  goalRef.current.x = goalX;
  goalRef.current.z = goalZ;

  /* ---------------- object refs ---------------- */

  const holderRef = useRef<Group>(null);
  const bankerRef = useRef<Group>(null);
  const hSquashRef = useRef<Group>(null);
  const vSquashRef = useRef<Group>(null);
  const rollerRef = useRef<Group>(null);
  const blobRef = useRef<Mesh>(null);
  const sparkRef = useRef<InstancedMesh>(null);
  const boardRef = useRef<Group>(null);
  const snapTick = useRef(0);
  const brushRef = useRef<Group>(null);
  const padMeshRef = useRef<Group>(null);
  const treatRefs = useRef<(Group | null)[]>([]);
  treatRefs.current.length = treats.length;

  useEffect(() => {
    const mesh = sparkRef.current;
    if (!mesh) return;
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    // InstancedMesh starts with identity matrices, which would park a full-size sparkle at
    // the origin until the first burst. Collapse them all up front.
    const zero = new Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < SPARKLES; i++) mesh.setMatrixAt(i, zero);
    mesh.instanceMatrix.needsUpdate = true;
  }, []);

  /* ---------------- engine events ---------------- */

  useEffect(
    () =>
      engine.on((event) => {
        const a = toothRef.current;
        const reduced = isReduced();
        switch (event.type) {
          case "maze":
            resetSparkles(sparkles);
            // Reset here as well as in the effect below: `regenerate()` emits synchronously,
            // and a frame can render between that and React's commit. Without this the child
            // would see one frame of the new maze with the tooth still standing wherever the
            // last run left it.
            resetTooth(a, engine.pos.r, engine.pos.c, engine.n);
            if (rollerRef.current) rollerRef.current.quaternion.identity();
            setMazeId((v) => v + 1);
            break;
          case "move":
            pushCell(a, event.r, event.c, engine.n);
            break;
          case "bump":
            bumpTooth(a, event.dr, event.dc, reduced, cellSize(engine.n));
            break;
          case "treat": {
            const t = treatsRef.current[event.index];
            if (!t) break;
            if (reduced) {
              t.popT = FEEL.reducedFade;
              t.popAmp = 0.18;
            } else {
              t.bob.impulse(4.6);
              t.spin.impulse(9);
            }
            if (!reduced) a.hSquash.impulse(-2.2);
            // Raised to match the treats' new height: a sweet is now 0.67–0.82 cells tall,
            // and sparkles bursting out of its middle read as a puff, not a pop.
            burst(sparkles, t.x, FLOOR_Y + cellSize(engine.n) * 0.62, t.z, reduced ? 3 : 7, cellSize(engine.n) * 0.34, reduced);
            break;
          }
          case "complete":
            if (!reduced) {
              a.hop.impulse(3.4);
              a.vSquash.impulse(-4);
            } else {
              pop(a, -0.14, FEEL.reducedFade);
            }
            // Centred on the brush *head*, not the goal cell: the head is where the child is
            // looking at the moment they win, and the lean carries it 0.9 of a cell up and
            // 0.48 back from the socket. Solved by `HEAD_UP` / `HEAD_BACK` above.
            burst(
              sparkles,
              cellX(engine.goal.c, engine.n) + cellSize(engine.n) * GOAL_OFFSET,
              brushBaseY(engine.n) + cellSize(engine.n) * HEAD_UP,
              cellZ(engine.goal.r, engine.n) + cellSize(engine.n) * (GOAL_OFFSET + HEAD_BACK),
              reduced ? 6 : 16,
              cellSize(engine.n) * 0.5,
              reduced
            );
            break;
          case "focus":
            setFocused(event.on);
            break;
          default:
            break;
        }
      }),
    [engine, sparkles]
  );

  /** A new maze means the tooth starts over — and never mid-roll from the previous run. */
  useEffect(() => {
    resetTooth(toothRef.current, engine.pos.r, engine.pos.c, engine.n);
    const roller = rollerRef.current;
    if (roller) roller.quaternion.identity();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, mazeId]);

  /* ---------------- pointer ---------------- */

  const dragging = useRef(false);

  useEffect(() => {
    const end = () => {
      if (!dragging.current) return;
      dragging.current = false;
      engine.endGesture();
    };
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    return () => {
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
  }, [engine]);

  // `e.point` is in world space, and the board group may be scaled by the camera solve, so
  // the hit has to be divided back into board space before it means a cell.
  const inv = scale > 0 ? 1 / scale : 1;

  const onPointerDown = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    dragging.current = true;
    // The keyboard surface is `pointer-events: none` (it must not swallow the drag), so a
    // tap can never focus it by itself. Hand it focus here, or arrow keys do nothing after
    // a child has touched the board.
    engine.focusRequest?.();
    engine.pointerTo(worldToU(e.point.x * inv, engine.n), worldToV(e.point.z * inv, engine.n));
  };

  const onPointerMove = (e: ThreeEvent<PointerEvent>) => {
    if (!dragging.current) return;
    engine.pointerTo(worldToU(e.point.x * inv, engine.n), worldToV(e.point.z * inv, engine.n));
  };

  /* ---------------- the frame ---------------- */

  useFrame((state, delta) => {
    const holder = holderRef.current;
    const banker = bankerRef.current;
    const hSquash = hSquashRef.current;
    const vSquash = vSquashRef.current;
    const roller = rollerRef.current;
    if (!holder || !banker || !hSquash || !vSquash || !roller) return;

    const dt = safeDelta(delta);
    const reduced = isReduced();
    const elapsed = state.clock.elapsedTime;
    const a = toothRef.current;

    /* --- travel --- */

    const moved = travel(a, dt, reduced, n, cell);
    const wasMoving = a.moving;
    a.moving = moved > 1e-6;

    if (a.moving && !reduced) {
      // Roll angle is distance over radius — the only way a rolling prop never skates.
      _axis.set(a.dirZ, 0, -a.dirX);
      _spin.setFromAxisAngle(_axis, moved / R);
      roller.quaternion.premultiply(_spin);
      // Integrating a quaternion frame after frame drifts off unit length eventually.
      roller.quaternion.normalize();
    } else if (!a.moving) {
      // Settles upright, so a rolling face never comes to rest upside down.
      _upright.identity();
      roller.quaternion.slerp(_upright, 1 - Math.exp(-(reduced ? 20 : 7.5) * dt));
    }

    if (wasMoving && !a.moving) {
      if (reduced) pop(a, -0.09, FEEL.reducedFade);
      else {
        a.hop.impulse(SETTLE_HOP);
        a.vSquash.impulse(SETTLE_SQUASH);
      }
    }

    /* --- trail --- */

    if (moved > 0) {
      a.trail += moved;
      const stride = cell * TRAIL_STEP;
      if (a.trail >= stride) {
        a.trail = 0;
        burst(sparkles, a.x, FLOOR_Y + R * 0.5, a.z, reduced ? 1 : 2, cell * 0.2, reduced);
      }
    }

    /* --- springs --- */

    // The bonk's wind-up runs on the clock, not on a timer: one struct field, no closure.
    releaseBump(a, dt);

    a.lean.to(reduced || !a.moving ? 0 : clamp01(a.speed / (cell * SPEED_CELLS)) * MAX_LEAN);
    a.bank.to(0);
    a.hop.to(0);
    a.vSquash.to(0);
    a.hSquash.to(0);
    a.push.to(0);
    a.tip.to(0);
    a.lean.step(dt);
    a.bank.step(dt);
    a.hop.step(dt);
    a.vSquash.step(dt);
    a.hSquash.step(dt);
    a.push.step(dt);
    a.tip.step(dt);

    let popAmount = 0;
    if (a.popT > 0) {
      a.popT -= dt;
      popAmount = a.popAmp * Math.sin(clamp01(1 - a.popT / a.popDur) * Math.PI);
    }

    /* --- write the tooth --- */

    const push = a.push.value;
    holder.position.set(a.x + a.bumpX * push, FLOOR_Y + R + a.hop.value, a.z + a.bumpZ * push);

    /*
     * The hand-off. Since A10, `GameShell` publishes the shared celebration into **this
     * scene's own `<View>`** (`view-slot.tsx` → `Scene3D`) — one camera, one depth buffer,
     * one rig — and this scene keeps rendering behind it, so the tooth would still be standing in the goal
     * alcove while the celebration's own mascot arrives on its podium, two teeth in one frame.
     * The tooth takes its bow first (the `complete` event kicks `hop` 3.4 and `vSquash` −4, a
     * real leap), then this pops it out, arriving at exactly zero before the celebration's
     * mascot exists. The maze block and the toothbrush stay: that is the room the celebration
     * is deliberately still rendering behind the burst.
     */
    const exit = celebrationHeroScale();
    holder.scale.set(exit, exit, exit);

    /*
     * ME7 — the tap-target guarantee, measured rather than assumed.
     *
     * The maze has no `HitTarget` colliders: it is traced with a finger over one picking
     * plane, and its only size guarantee is the engine's snap radius. `SNAP_RADIUS = 0.78`
     * cells buys `2 × 0.78 × cell` of acceptance across a corridor, which is 38 CSS px on a
     * 13-cell board at phone width — under §8's 48 px floor, and the audit's
     * `selftest.json` recorded "no live colliders in this scene — nothing asserted".
     *
     * So the radius is driven from the pixels the board actually occupies. Re-measured every
     * `SNAP_MEASURE_FRAMES` rather than every frame (it only moves when the viewport or the
     * level does) and allocation-free: one reused `Vector3`, one divide.
     *
     * `playAreaMetrics()` reports the view's *layout* size, which is immune to the entry
     * flip's CSS scale — the same quantity `hit.tsx` sizes every collider in the product
     * against.
     */
    snapTick.current = (snapTick.current + 1) % SNAP_MEASURE_FRAMES;
    if (snapTick.current === 0) {
      const metrics = playAreaMetrics();
      const cam = state.camera;
      if (metrics !== null && metrics.height > 0 && cam instanceof PerspectiveCamera) {
        _boardCentre.set(0, FLOOR_Y * scaleRef.current, 0);
        const dist = cam.position.distanceTo(_boardCentre);
        const perUnit = metrics.height / (2 * dist * Math.tan((cam.fov * Math.PI) / 360));
        engine.setSnapFromPixels(perUnit * cell * scaleRef.current);
      }
    }

    /*
     * The board takes its bow too (ME6). Written every frame from the prop rather than left to
     * React, so the exit transform and the framing scale can never disagree — and it is three
     * numbers, no allocation.
     */
    const board = boardRef.current;
    if (board) {
      const span = isReduced() ? CELEBRATION_EXIT_SECONDS_REDUCED : CELEBRATION_EXIT_SECONDS;
      const t = celebration.active ? clamp01(celebration.elapsed / span) : 0;
      // The same `easeInCubic` removal the hero uses: barely moving at first, gone fast at the
      // end, so it reads as a hand-off rather than as a prop disappearing between two frames.
      const away = easeInCubic(t);
      const s = scaleRef.current * (1 - 0.12 * away);
      board.scale.set(s, s, s);
      board.position.y = -BOARD_SINK * away;
    }

    _axis.set(a.faceZ, 0, -a.faceX);
    _lean.setFromAxisAngle(_axis, a.lean.value);
    _axis.set(a.faceX, 0, a.faceZ);
    _bank.setFromAxisAngle(_axis, a.bank.value);
    banker.quaternion.copy(_lean).multiply(_bank);

    /*
     * The bump frame. `hSquash` is yawed so its local +X lies along the bump, squashes along
     * that X, and tips about its local Z so the crown noses into the wall it hit.
     *
     * `vSquash` carries the **inverse** yaw, and that is a fix rather than a flourish. The
     * yaw rotates everything under it, including the mascot, so a bonk against a wall to the
     * north used to swing the tooth's face a quarter turn — and leave it there, because
     * `bumpYaw` is only written when a bump happens. A child bonking a side wall once spent
     * the rest of the run looking at the tooth's ear. Undoing the yaw on the child node
     * cancels the rotation while leaving the squash axis where it belongs: a vertex goes
     * `Ry(−yaw) → squash along X → Rz(−tip) → Ry(yaw)`, so the flatten still runs along the
     * bump direction in world space and the face still points at the camera. `vSquash`'s own
     * scale is equal in x and z, so a y-rotation commutes with it and nothing else moves.
     *
     * It also fixes the roll. `_spin`'s axis `(dirZ, 0, −dirX)` is a world direction, and
     * `roller.quaternion.premultiply` applies it in the roller's *parent* frame — which used
     * to be yawed by the last bump, so after a bonk against a side wall the tooth rolled
     * about an axis a quarter turn from its direction of travel, i.e. it skated. With the
     * two yaws cancelling, the parent frame's rotation is identity again at every moment.
     */
    hSquash.rotation.y = a.bumpYaw;
    hSquash.rotation.z = -a.tip.value;
    squashFor(_squash, a.hSquash.value, 1, 0.28);
    // `squashFor` writes the deforming axis into `y`; this node squashes along its own X.
    hSquash.scale.set(_squash.y, _squash.x, _squash.z);

    vSquash.rotation.y = -a.bumpYaw;
    squashFor(_squash, a.vSquash.value + popAmount, 1, 0.28);
    vSquash.scale.set(_squash.x, _squash.y, _squash.z);

    /* --- contact shadow --- */

    /*
     * The hero's contact blob, on the shared curves (A3).
     *
     * It used to shrink linearly with a normalised hop and keep its opacity, which is the
     * "sticker that does not answer height" A3 measured across the product: the decal stayed
     * exactly as dark under a tooth in the air as under one on the floor, and — worse — it sat
     * on top of the real PCSS penumbra and hid it. `contactRadiusFor` grows the quad by the
     * key's own angular size as the caster lifts and `contactOpacityFor` fades it to nothing
     * by `CONTACT_FADE_LIFT`, where the shadow map takes over. Both are read per frame here
     * rather than through `<ContactBlob>`, because the hop changes every frame and the
     * component would re-render React with it.
     *
     * `material.opacity` is written directly, which is why `blobMat` is a **clone** of the
     * shared blob material rather than the cached instance — see its `useMemo`.
     */
    const blob = blobRef.current;
    if (blob) {
      const lift = a.hop.value > 0 ? a.hop.value : 0;
      const faded = contactOpacityFor(BLOB_OPACITY, lift) * exit;
      blob.visible = faded > 0;
      if (blob.visible) {
        const size = contactRadiusFor(cell * BLOB_FOOTPRINT, lift) * 2 * exit;
        blobMat.opacity = faded;
        blob.position.set(a.x, FLOOR_Y + 0.004, a.z);
        blob.scale.set(size < 1e-4 ? 1e-4 : size, size < 1e-4 ? 1e-4 : size, 1);
      }
    }

    /* --- the toothbrush notices --- */

    const goal = goalRef.current;
    const gdx = a.x - goal.x;
    const gdz = a.z - goal.z;
    const near = clamp01(1 - Math.sqrt(gdx * gdx + gdz * gdz) / (cell * NOTICE_CELLS));
    goal.near = near;
    if (near > 0.45 && !goal.armed) {
      goal.armed = true;
      goal.pop = FEEL.reducedFade * 2;
    } else if (near < 0.3 && goal.armed) {
      goal.armed = false;
    }
    if (goal.pop > 0) goal.pop -= dt;

    // The brush lives inside a group that already carries the plant, the lean and the yaw
    // (see the graph below), so everything written here is in the brush's own frame: `y` is
    // along its handle and `z` rocks it side to side.
    const brush = brushRef.current;
    const greet = goal.pop > 0 ? Math.sin(clamp01(1 - goal.pop / (FEEL.reducedFade * 2)) * Math.PI) : 0;
    if (brush) {
      if (reduced) {
        // No idle beckon and no bounce: the greeting is one short scale pop, which is a
        // discrete state change rather than continuous motion. The goal stays findable
        // without it — that job belongs to its height, its lean and its colour.
        brush.rotation.z = 0;
        brush.position.y = 0;
        const s = 1 + greet * 0.12;
        brush.scale.set(s, s, s);
      } else {
        // Always running, wherever the tooth is; the near-field term only adds to it.
        brush.rotation.z =
          Math.sin(elapsed * IDLE_SWAY_HZ) * IDLE_SWAY +
          Math.sin(elapsed * NEAR_SWAY_HZ) * NEAR_SWAY * near;
        brush.position.y =
          cell * IDLE_RISE * (0.5 + 0.5 * Math.sin(elapsed * IDLE_RISE_HZ)) +
          cell * NEAR_BOUNCE * near * Math.abs(Math.sin(elapsed * NEAR_BOUNCE_HZ));
        const s = 1 + greet * 0.14 + near * 0.03;
        brush.scale.set(s, s, s);
      }
    }

    const pad = padMeshRef.current;
    if (pad) {
      const s = reduced ? 1 + greet * 0.06 : 1 + greet * 0.09 + Math.sin(elapsed * 4.6) * 0.03 * near;
      pad.scale.set(s, s, s);
    }

    /* --- treats --- */

    const list = treatsRef.current;
    for (let i = 0; i < list.length; i++) {
      const node = treatRefs.current[i];
      if (!node) continue;
      const t = list[i];
      t.bob.to(0);
      t.spin.to(0);
      t.bob.step(dt);
      t.spin.step(dt);
      let tp = 0;
      if (t.popT > 0) {
        t.popT -= dt;
        tp = t.popAmp * Math.sin(clamp01(1 - t.popT / FEEL.reducedFade) * Math.PI);
      }
      const idle = reduced ? 0 : Math.sin(elapsed * 1.4 + t.seed) * cell * 0.018;
      node.position.set(t.x, idle + t.bob.value * cell * 0.09, t.z);
      node.rotation.y = t.spin.value * 0.35;
      const s = 1 + tp;
      node.scale.set(s, s, s);
    }

    /* --- sparkles --- */

    const spark = sparkRef.current;
    if (spark) stepSparkles(sparkles, spark, state.camera.quaternion, dt, reduced);
  });

  /* ---------------- graph ---------------- */

  return (
    // `shadowArea` follows the board: the ortho frustum is sized to what casts, and a board
    // shrunk by the camera solve casts a smaller shadow, not the same one at lower texel
    // density. `groundY` stays 0 — the board's underside sits on the ground plane at every
    // scale, because the scale is about the origin the board already stands on.
    <Rig shadowArea={SHADOW_AREA * scale} groundY={0}>
      {/*
        Everything below is the board, and the board is one object: `cameraFor` may hand back
        a scale under 1 on a viewport narrower than 0.44:1, and it has to reach the props, the
        contact shadow and the drag plane alike or they stop agreeing with each other.
      */}
      <group ref={boardRef} scale={scale}>
        {/*
          Close contact under the board. The slab's own shadow map does the long throw; this
          supplies the near-black pinch right at the edge, which is what stops a 38 cm object
          from looking like it is hovering a centimetre off the table.
        */}
        <ContactBlob
          position={[0, 0.004, 0]}
          radius={contactRadiusFor((BOARD / 2) * scale)}
          opacity={0.34}
          lift={0}
        />

        {/*
          `renderOrder` on the three board meshes, and it is the largest thing this scene can
          do about ME2 — the worst GPU cost in the product, 4.335 ms p95 against a 1.2 ms
          desktop proxy.

          `WebGLRenderList.sort` orders opaque draws by `groupOrder`, then `renderOrder`, then
          the NDC z of the object's **origin**, then object id. The gum, the floor and `Rig`'s
          ground plane all sit at world (0, 0, 0), so their z keys are identical and the tie
          falls through to id — and `Rig` renders its ground *before* `{children}`, so the
          ground has the lowest id and is drawn first. Every fragment of the 60-unit cream
          plane behind the board was therefore shaded by the full clay + 20-tap PCSS shader and
          then overdrawn, and so was every fragment of the slab under the gum.

          Front-to-back is the order early-Z wants and nothing here discards or writes depth
          from the shader, so the fragments this removes are removed before shading. It changes
          no pixel: only the order they are computed in.
        */}

        {/* The gum block. One draw call, one silhouette, corridors carved right through it. */}
        <mesh geometry={geometry.gum} material={gumMat} renderOrder={-3} castShadow receiveShadow />

        {/*
          The carved corridor floor, with its wall occlusion and the alcove dish.

          ME2 asks for `receiveShadow` to come off this mesh, on the grounds that `buildFloor`
          already bakes the wall occlusion into vertex colour. **Not done, and here is the
          arithmetic.** Those are different terms: the baked one is *ambient* occlusion — an
          isotropic contact darkening that pools in corners and is the same on every side of a
          wall — and the shadow map is the *directional* key. Taking the key off would delete
          the band of shade the coral throws across the ivory, which is the largest single depth
          cue on the board and the thing A3 spent this round making warm rather than grey.

          The cost it would save is also not where the time is. The floor covers 39.9 % of the
          frame (`scratchpad/verify/me-overdraw.mjs`), so its shadow lobe is ~0.4 frames of
          20-tap PCSS; the draw ordering below removes **0.52 frames** of the entire clay
          shader — a third of everything this scene shades — and costs no pixel at all. That is
          taken first, and the floor keeps its shadow.
        */}
        <mesh geometry={geometry.floor} material={floorMat} renderOrder={-2} receiveShadow />

        {/* The ivory slab: the board's underside and, where the gum is cut away, its floor. */}
        <mesh
          geometry={slabGeo}
          material={slabMat}
          rotation={FLAT_ROT}
          position-y={(BASE_T - SLAB_SINK) / 2}
          renderOrder={-1}
          castShadow
          receiveShadow
        />

        {/* Start pad. */}
        <group position={[cellX(1, n), 0, cellZ(1, n)]}>
          <PartMesh part={props.startRing} />
      </group>

        {/*
          The goal. The bay is carved into the gum block itself (see `carveAlcove`), so what
          stands here is only what lives in it: the mauve pad pressed into the dish, and the
          toothbrush planted on it.

          Three nested transforms, and each one owns exactly one thing, which is what lets the
          frame loop above write plain local numbers:

            • the socket — where in the bay the brush stands (`GOAL_OFFSET`, diagonally);
            • the stance — the plant height, the lean into the lens and the off-axis turn.
              Fixed for the run, so it is authored here and never touched per frame;
            • `brushRef` — the beckon: a rock about the brush's own Z and a rise along its own
              handle, both zero at rest, so the stance is never fought over.
        */}
        <group position={[goalX + cell * GOAL_OFFSET, 0, goalZ + cell * GOAL_OFFSET]}>
          <group ref={padMeshRef} position={[0, props.goalPad.position[1], 0]}>
            <mesh
              geometry={props.goalPad.geometry}
              material={props.goalPad.material}
              rotation={props.goalPad.rotation}
              receiveShadow
            />
        </group>
          <group position={[0, brushBaseY(n), 0]} rotation={[BRUSH_TILT, BRUSH_YAW, 0]}>
            <group ref={brushRef}>
              {props.brush.map((p, i) => (
                <PartMesh key={i} part={p} castShadow={i < 3} />
              ))}
          </group>
        </group>
      </group>

        {/* Treats at the dead ends. Bopping one is an "oops", never a penalty. */}
        {treats.map((t, i) => (
          <group
            key={i}
            ref={(node) => {
              treatRefs.current[i] = node;
            }}
            position={[t.x, 0, t.z]}
          >
            {/*
              Only the two structural parts cast: a lollipop's swirl dot and an ice cream's
              cherry are 6–8 px props whose shadows are a pixel each, and the shadow pass is
              where this scene's draw-call budget actually goes.
            */}
            {props.treats[t.kind].map((p, k) => (
              <PartMesh key={k} part={p} castShadow={k < 2} />
            ))}
        </group>
        ))}

        {/* The hero. holder → banker (lean + bank) → bump squash → landing squash → roller. */}
        <group ref={holderRef}>
          <group ref={bankerRef}>
            <group ref={hSquashRef}>
              <group ref={vSquashRef}>
                {/*
                  The mascot rides the roll node whole — face, arms and feet. `props.ts`
                  carries the reasoning; the short version is that the tooth is not a sphere,
                  so a face pinned outside the roll would hang in mid-air whenever the roots
                  came round. The inner group re-centres the mascot (whose own origin is the
                  base of its roots) onto the bounding-box centre, which is the axis a rolling
                  object has to turn about if it is not to skate.
                */}
                <group ref={rollerRef}>
                  <group position={props.tooth.offset}>
                    {props.tooth.parts.map((p) => (
                      <mesh
                        key={p.key}
                        geometry={p.geometry}
                        material={p.material}
                        position={p.position}
                        rotation={p.rotation}
                        scale={p.scale}
                        castShadow={p.castShadow}
                        receiveShadow
                      />
                    ))}
                </group>
              </group>
            </group>
          </group>
        </group>
          {/*
            Sized from the fitted body rather than from a magic multiple of the radius: 1.5 x
            the largest half-extent clears the prop on every axis, including a tooth caught
            mid-roll with its roots swung sideways.

            It does **not** sit inside a one-cell corridor, and an earlier revision of this
            comment claimed it did. The largest half-extent is the tooth's own half-height,
            `D / 2` = 0.4 of a cell, so the ring is 0.6 of a cell in radius and 1.2 across — a
            fifth wider than the corridor. That is deliberate rather than tolerated: a focus
            ring that fits inside the prop it marks is not an indicator, and this one is
            two-tone precisely so it can cross onto the gum.

            The colour is the shared default, deliberately, and this used to be an override.

            G-ME-5 is real: `ACCENTS.red.deep` alone measures **1.77:1 against `CLAY.gum`** and
            1.23:1 against `CLAY.gumDeep`, and this board is 55 % gum by area — a ring 0.6 of a
            cell across, centred in a one-cell corridor, spends 37 % of its circumference over
            a wall top, so a third of the indicator was disappearing. The fix was to pass
            `NEUTRAL.ink` here, because at the time `FocusRing` had no second tone: its halo
            was the *same hex* as its ring.

            `FocusRing` now draws a real two-tone indicator (`hit.tsx::CONTOUR_GEOMETRY`) — an
            ink contour standing proud on both sides of the accent ring. Passing ink here would
            paint ink on ink and collapse it back to a single tone. The default is now strictly
            better on this board: the ink contour carries the gum wall tops at **3.80:1** and
            red.deep carries the ivory corridor floor at **5.56:1**, so whichever surface the
            ring crosses, one of its two tones clears the 3:1 non-text floor.
          */}
          <FocusRing visible={focused} radius={ringRadius} />
      </group>

        <mesh ref={blobRef} geometry={quadGeo} material={blobMat} rotation={FLAT_ROT} renderOrder={2} />

        <instancedMesh
          ref={sparkRef}
          args={[quadGeo, sparkleMat, SPARKLES]}
          frustumCulled={false}
          renderOrder={6}
        />

        {/*
          The drag surface. Deliberately far larger than the board: a finger that strays off
          the maze mid-gesture must keep being tracked, or the tooth stalls the moment a child
          overshoots a corner. Invisible to the renderer, visible to the raycaster.
        */}
        <mesh
          geometry={quadGeo}
          material={pickMat}
          rotation={FLAT_ROT}
          position-y={FLOOR_Y}
          scale={60}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
        />
      </group>
    </Rig>
  );
}

/**
 * Memoised on `engine`, whose identity never changes, and on `scale`, which changes only
 * when the play area is re-measured into a different framing — so the shell re-rendering its
 * timer once a second does not touch the 3D tree at all.
 */
export const MazeEscapeScene = memo(MazeEscapeSceneImpl);
