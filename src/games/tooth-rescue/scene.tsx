/**
 * Tooth Rescue — the 3D set.
 *
 * The shape of this file mirrors Tooth Match's `scene.tsx`, because that is the pattern:
 *
 *  • One prop that never changes identity per frame (the engine), plus a `framing` object
 *    that changes only when the window is resized.
 *  • The component re-renders on **zero** engine events. Everything a body does is struct
 *    mutation inside `useFrame`.
 *  • Twenty-six bodies are five `InstancedMesh`es. Nothing here allocates per frame: no
 *    `new`, no literals, no closures, no `map`.
 *
 * What is different, and why:
 *
 *  • **The simulation is real.** `PhysicsWorld` owns gravity, restitution, friction and
 *    angular tumble; the basket is five box colliders whose centres are mutated in place
 *    each frame, so sliding it really does shovel a settled tooth along and really does
 *    let a candy clip the rim.
 *  • **Bodies are pooled and parked, never created or destroyed.** Twenty-six bodies are
 *    added to the world once, on mount. A free body is slept in a garage far below the
 *    table and re-slept every frame before `step`, so no restart, no `wakeAll` from a
 *    collider edit and no long frame can ever bring a retired tooth back to life.
 *  • **A caught tooth stops being physics and becomes a spring.** The solver is
 *    sphere-against-static-geometry — bodies do not collide with each other — so fourteen
 *    "piled" teeth would occupy one point. Instead the catch is real (the impact drives
 *    the basket's jelly and the tooth's own squash) and the tooth is then handed to a
 *    `Spring3` that carries its landing velocity into an assigned slot and holds it there,
 *    sloshing when the basket accelerates. It rides the basket exactly, and the basket's
 *    floor collider rises a layer at a time so the next tooth lands *on the pile*.
 *  • **Candy is authored comedy, not luck.** Physics decides *whether* candy clips the
 *    basket; the moment it does, the rim replaces its velocity with a big silly arc, spins
 *    it hard, and lets gravity and restitution do the rest — two real bounces across the
 *    table and a settle. It costs the child nothing but the point that was never there.
 *
 * ---------------------------------------------------------------------------
 * Round 2
 * ---------------------------------------------------------------------------
 *
 * Five audited defects were fixed here, and four of them shared one cause: nothing in this
 * scene was sized against the shot.
 *
 *  • **G-TRS-1 / X3 — the subject.** The falling tooth was a bare, faceless, rooted tooth
 *    at 1.17:1 against what it fell through and 0.36 % of the frame. It is now the
 *    product's mascot, baked into one geometry (`mascot.ts`) so a face costs no extra draw
 *    call, and it falls down a deep-toned alcove instead of through its own colour.
 *  • **G-TRS-2 — the basket.** The "woven basket" was four saturated red prongs hanging
 *    off a red band across an ivory tub, floating 4.55 mm clear of the clay and crossing
 *    the band in a hard dark notch. The weave is now the tub's own pale clay, seated the
 *    full wall thickness, and the accent survives only as a **rim band painted onto the
 *    tray's own surface** through the `aAlbedo` attribute — one surface, no notch, nothing
 *    vertical and red descending anywhere.
 *  • **G-TRS-3 — the budget.** 176,608 of 180,000 triangles, constant, with nothing in
 *    flight: the whole pool was submitted every frame with `frustumCulled={false}`, and
 *    twenty quality-tier wrapper ends alone were 52,480 of it. `InstancedMesh.count` now
 *    follows the live high-water index per pool, recomputed every frame in step 5, and the
 *    wrapper end is built for the fifteen pixels it covers.
 *  • **G-TRS-4 — the set.** Every piece of it is sized from the solved camera now (see
 *    `layout.ts: solveFraming`), so no edge of the set can be framed at any viewport.
 *  • **G-TRS-6 — orphan contact darkening.** The landing marker is drawn for falling
 *    bodies only. A body at rest has a real cast shadow; the blob under one that had come
 *    to rest on the old kerb was a dark ellipse on the mat with nothing above it.
 *
 * Per-instance and per-vertex colour travels on `ALBEDO_ATTRIBUTE`, never on
 * `setColorAt`/`instanceColor`: three folds `instanceColor` into the same `vColor` the
 * clay shader reads as signed curvature and extrapolates by `uClayAO = 1.45`, which drove
 * this game's candy off-token (S2). Any geometry that carries an albedo is therefore a
 * **clone** — never a `cachedGeometry()` result, which is shared for the life of the
 * context — and is disposed with the scene.
 *
 * ---------------------------------------------------------------------------
 * Round 3
 * ---------------------------------------------------------------------------
 *
 *  • **B6.1 — the set.** Five slabs abutting in mid-air became one continuous C2 surface,
 *    `set.ts`, with a coved soffit, rounded reveals, a dished back and `bakeCurvatureAO`
 *    run across the whole of it. The luminance separation the round-2 alcove was built for
 *    is kept and re-verified; the neutral it was painted in is not.
 *  • **B6.2 — the jelly.** The basket's catch wobble was measured at 3.2 % against a
 *    mechanism that allows 22. Re-derived from the solver's real landing speed rather than
 *    re-tuned: 11.2-12.8 % peak squash with a volume-preserving bulge. See `CATCH_KICK`.
 *  • **B6.3 — the tumble.** `§6.6` names angular tumble as one of this game's defining
 *    physics, and the one object class the game is about was overwriting the simulated
 *    orientation every frame. The body tumbles now and the *face* is what is oriented, over
 *    the last third of a second before it lands. See `SPIN_TOOTH`.
 *  • **B6.4 — the start gate.** The DOM overlay that ate the child's whole first press is
 *    gone; the chute is loaded instead, and the basket answers a `pointerdown` inside one
 *    frame. See `PERCH_*` and `PRESS_KICK`.
 *
 * Reduced motion (`isReduced()`, read fresh every frame): things still fall and the basket
 * still slides, because that *is* the game. Candy's tumble drops to a slow turn, the
 * falling tooth is given no spawn spin and its face-on blend is pinned to 1, so it comes
 * down dead upright and front-on with no idle rocking at all, the comic
 * arc becomes a modest hop, the jelly runs at the quarter gain `SoftWobble` applies for us,
 * every spring degrades to a non-overshooting damp, the pile stops sloshing, sparkles have
 * no velocity, and `Scene3D`'s `CameraRig` is already static.
 */
import { memo, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import {
  AdditiveBlending,
  DynamicDrawUsage,
  Euler,
  Matrix4,
  MeshBasicMaterial,
  PlaneGeometry,
  Quaternion,
  Vector3,
  type BufferGeometry,
  type Group,
  type InstancedBufferAttribute,
  type InstancedMesh,
} from "three";

import {
  Spring,
  Spring3,
  clamp01,
  easeInCubic,
  easeOutBack,
  easeOutCubic,
  impactSquash,
  safeDelta,
  squashFor,
} from "../../three/anim";
import { DisposalBag } from "../../three/dispose";
import {
  cachedGeometry,
  clayTray,
  latheProfile,
  roundedBox,
  roundedPlate,
  softSphere,
} from "../../three/geometry";
import {
  ALBEDO_ATTRIBUTE,
  clay,
  ensureInstanceAlbedo,
  shadowBlobMaterial,
  vertexAlbedoAttribute,
  writeAlbedo,
} from "../../three/materials";
import { FocusRing } from "../../three/hit";
import { playAreaMetrics } from "../../three/Scene3D";
import { PhysicsWorld, SoftWobble, type Body, type BoxCollider } from "../../three/physics";
import { ContactBlob, Rig } from "../../three/Rig";
import { celebrationHeroScale, isReduced } from "../../three/store";
import { sparkleTexture } from "../../three/textures";
import { ACCENTS, CLAY, NEUTRAL, auditSceneAccents, color } from "../../three/tokens";
import { sounds } from "../../shared/audio";
import {
  BASKET_D,
  BASKET_H,
  BASKET_RIM,
  BODY_POOL,
  CANDY_BODY_R,
  CANDY_END_OFFSET,
  CANDY_END_SCALE,
  CANDY_END_TWIST,
  CANDY_FLAT,
  CANDY_POOL,
  CANDY_R,
  CANDY_STRETCH,
  FOV,
  FRAME_T,
  FRAME_Z,
  NICHE_MOUTH_Z,
  GRAVITY,
  INNER_HALF_D,
  MAT_T,
  PILE_A,
  PILE_SLOTS,
  RAIL_H,
  RIM_Y,
  SET_BASE_Y,
  SPARKLES,
  SPAWN_Y,
  STAGE_Y,
  TOOTH_POOL,
  TOOTH_R,
  TOOTH_SCALE,
  WALL,
  WEAVE_MAX,
  WEAVE_TINT_CANE,
  WELL_Y,
  nicheCoveSpan,
  pileSlots,
  pileSupport,
  trayMetrics,
  weaveCount,
  weaveLayout,
  type Framing,
  type PileSlots,
} from "./layout";
import { buildMascotGeometry } from "./mascot";
import { ALCOVE_HEXES, buildAlcove } from "./set";
import { KIND_CANDY, KIND_TOOTH, type EngineEvent, type ToothRescueEngine } from "./engine";

/* ------------------------------------------------------------------ */
/* Tuning                                                              */
/* ------------------------------------------------------------------ */

/** Item lifecycle. */
const S_FREE = 0;
const S_FALL = 1;
const S_PILE = 2;
const S_LOOSE = 3;
const S_POOF = 4;

/** Where a retired body is slept, far enough down that nothing can ever reach it. */
const GARAGE_Y = -80;

/**
 * Basket follow.
 *
 * 90 / 15 was outside `3D-SPEC §4`'s 260–420 / 18–28 band, on the one object under the
 * child's finger for the whole thirty seconds: ζ ≈ 0.79 and a 200–300 ms arrival against a
 * 0.83 s fall. At 300 / 26 the damping ratio is 0.75 and ωn goes 9.5 → 17.3, so the basket
 * arrives in ~0.31 s and the lag under a dragging finger is halved. `BASKET_MAX_SPEED` is
 * raised to match: the old 9 u/s would have thrown away most of the stiffness on a long drag.
 *
 * **Round 4 (B6.11): 26 was still invisible.** ζ = 26 / (2 sqrt 300) = 0.7506 and the peak
 * overshoot of a step response is `exp(-pi zeta / sqrt(1 - zeta^2))` = **2.82 %** — on the one
 * object a child drags for thirty seconds. Technically not linear, practically a straight
 * line. At 20 the ratio is 0.5774 and the overshoot **10.84 %**, with 2 % settling at
 * `8 / c` = 400 ms; both are inside `3D-SPEC §4`'s band (damping 18-28, and §4.1's derived
 * zeta 0.439-0.868 / settle 286-444 ms), so this is the band being *used* rather than
 * widened.
 *
 * **And it cannot drop a catch, which is the thing to check before loosening a follow.** The
 * overshoot is a fraction of the *step*, and the longest step this game can produce is the
 * full lane, `2 * PLAY_HALF_MAX` = 4.8 units. 10.84 % of that is **0.52 units**, against a
 * catching half-width of `innerHalfW` = 0.53 at the narrowest basket the solver hands out and
 * 1.30 at the widest — so even a corner-to-corner flick lands the tooth inside the well. A
 * finger that is *dragging* never presents a step at all: `Spring.to` is re-aimed every frame,
 * so there is no transient to overshoot.
 */
const BASKET_STIFFNESS = 300;
const BASKET_DAMPING = 20;
const BASKET_MAX_SPEED = 14;
/** Acceleration handed to the jelly, clamped so one long frame cannot spike it. */
const MAX_ACCEL = 240;
/** Overshoot allowance past the reach limit, so hitting the end reads as hitting an end. */
const BASKET_EDGE_SLACK = 0.05;

/** Pile springs: firm, with just enough give to slosh when the basket swings. */
const PILE_STIFFNESS = 280;
const PILE_DAMPING = 19;
const PILE_SLOSH = 0.3;

/**
 * Candy's comic ejection, in world units/s. Big arc, hard spin, two bounces, a settle.
 *
 * Re-derived for the shorter drop: the frame is 1.48x tighter and gravity 1.48x lower, so
 * every launch speed is scaled by 0.674 to keep the arc the same *fraction of the picture*
 * it always was. `EJECT_UP` puts the apex 0.70 units above the rim and the flight at
 * 1.40 s — both unchanged from the shipped feel.
 */
const EJECT_UP = 1.99;
const EJECT_OUT = 1.11;
const EJECT_SPIN = 11;
const EJECT_RANGE = 1.55;
const EJECT_UP_REDUCED = 1.01;
const EJECT_OUT_REDUCED = 0.74;
/** Gain on a *second* ejection — a sweet that bounced back in. A hop, not another arc. */
const EJECT_REBOUND = 0.55;

/**
 * The knock a tooth gets when it clips the basket instead of going in, and the stall clock
 * that guarantees no falling body can ever come to rest in mid-air. See `deflectOffBasket`.
 *
 * `FALL_STALL_SPEED` is the downward speed below which a tooth is not, in any useful sense,
 * falling: `physics.ts`'s `LINEAR_DAMPING` alone cannot hold a body above 0.25 u/s once
 * gravity has it, and the slowest thing this game drops leaves the chute at 0 and is past
 * 0.25 u/s within 0.09 s. `FALL_STALL` is then long enough that a rim graze bouncing a tooth
 * briefly upward is not mistaken for a rest.
 */
const DEFLECT_OUT = 1.15;
const DEFLECT_DOWN = 0.45;
const FALL_STALL_SPEED = 0.25;
const FALL_STALL = 0.3;

/** How long a loose prop lies on the table before it hops away. */
const REST_TOOTH = 1.2;
const REST_CANDY = 1.7;
const POOF_DUR = 0.42;
const POOF_DUR_REDUCED = 0.22;

/**
 * Tumble.
 *
 * Candy tumbles hard, because a bonbon has no front. A tooth has a face, and X3 is right
 * that a face on a *freely* rolling prop spends most of every second pointed away — which
 * is why round 2 replaced the roll with an authored sway written straight into the body's
 * quaternion every frame.
 *
 * Round 3 (B6.3) called that the wrong solution to a real problem, and it is: `3D-SPEC §6.6`
 * names "gravity, restitution, **angular tumble**" as this game's defining physics, the
 * solver was running all three, and the one object class the game is about threw its result
 * away and rocked +/-10 degrees instead. The sway also cost the fall its weight — a tooth
 * that never turns reads as a sprite on a rail.
 *
 * So the body tumbles for real and the **face** is what is oriented, not the body:
 *
 *  - `SPIN_TOOTH` is the nominal angular speed at spawn, spread `+/-20 %` per drop by the
 *    seed and signed so a tooth is as likely to roll one way as the other. With
 *    `physics.ts`'s `ANGULAR_DAMPING = 1.1` the integrated turn before the face-on blend
 *    takes over is `w0 (1 - e^(-1.1 T)) / 1.1`, and at the shipped fall times that is
 *    **77-115 degrees on Easy, 64-96 on Medium, 49-74 on Hard** — a real tumble at every
 *    level, in the 60-120 band the fix list asked for at all but the fastest. Derived in
 *    `scratchpad/verify/tooth-rescue-wobble.mjs`, not guessed.
 *  - Over the last `FACE_ON_TIME` before the tooth reaches the catch plane, its spin is
 *    damped and its orientation is slerped toward the authored face-on pose. The blend is
 *    driven by *time to arrival* rather than by height, so it behaves the same on a level
 *    that drops from rest and on one that is thrown down at 2.26 u/s. It lands face-on.
 *  - Reduced motion keeps round 2's behaviour exactly: no spawn spin, blend pinned to 1, so
 *    the tooth comes down dead upright and front-on with no idle rocking (`3D-SPEC §4`).
 *
 * The axis mix is biased to Z — an in-plane roll, where the face stays toward camera for
 * the whole turn — with a smaller X pitch and a little Y yaw, so the tumble reads as tumbling
 * rather than as a face repeatedly disappearing.
 */
/*
 * ---------------------------------------------------------------------------
 * Round 4 (B6.6): the tumble was rolling the mascot upside down
 * ---------------------------------------------------------------------------
 *
 * The axis mix above was biased to **Z** on the argument that an in-plane roll keeps the face
 * toward camera for the whole turn. It does — and it also turns the mascot over. Inverted, the
 * mouth arc's corners point *down* and the dark stroke sits above two large dark eyes: round 4
 * photographed it and read "a downturned frown or a crack", "a bin of skulls". On a dental
 * product for four-year-olds that is `3D-SPEC §1.1` and the cavity read at once, and it is
 * what a child sees for most of a 1.5-second fall, because `FACE_ON_TIME` only corrects the
 * last third of a second.
 *
 * The tumble now **lives in yaw**, and roll and pitch are clamped on the *orientation* rather
 * than on the angular velocity — a velocity clamp still integrates to a full turn given
 * enough time. Each frame the body's quaternion is decomposed `YXZ` (yaw, then pitch, then
 * roll), pitch and roll are clamped to `TUMBLE_PITCH_MAX` and `TUMBLE_ROLL_MAX`, and the
 * result is written back, so the clamp is what the solver carries forward as well as what the
 * renderer draws. Yaw is left free: a tooth turning about its own axis reads as tumbling and
 * cannot invert anything.
 *
 * The band is the fix list's: ±35 degrees of roll, ±20 of pitch. Integrated yaw is unchanged
 * in magnitude — with `physics.ts`'s `ANGULAR_DAMPING = 1.1` a spawn at `SPIN_TOOTH` turns
 * `w0 (1 - e^(-1.1 T)) / 1.1` before the face-on blend takes over, which at the shipped fall
 * times of 1.545 / 1.202 / 0.918 s is **148 / 129 / 106 degrees** of yaw. It is a real tumble
 * at every level, and none of it is upside down.
 */
const SPIN_CANDY = 4.6;
const SPIN_REDUCED = 0.35;
const SPIN_TOOTH = 2.1;
const SPIN_TOOTH_PITCH = 0.42;
const SPIN_TOOTH_ROLL = 0.5;
const TUMBLE_PITCH_MAX = (20 * Math.PI) / 180;
const TUMBLE_ROLL_MAX = (35 * Math.PI) / 180;
/** Seconds before arrival over which the tumble hands off to the face-on pose. */
const FACE_ON_TIME = 0.34;
/** How hard spin is bled off, and how hard the pose is pulled, at full blend. */
const FACE_ON_SPIN_DAMP = 7.5;
const FACE_ON_SLERP = 13;
/**
 * Where a falling tooth is heading: the sphere-centre height of the *next* catch.
 *
 * It used to be the constant `STAGE_Y + WELL_Y + TOOTH_R` — the height of the very first
 * catch of a run, on an empty basket. Every catch after that lands on the heap, which is up to
 * 1.13 units higher, so `tta` was measured against a plane the tooth passes long before it
 * arrives and `blend` stayed at 0 through the whole approach: **the face-on hand-off only ever
 * ran for the first tooth of a run.** Read from the drop solve instead, so it tracks the pile.
 */
function catchPlaneY(rt: Runtime): number {
  const next = rt.piled < PILE_SLOTS ? rt.piled : PILE_SLOTS - 1;
  return STAGE_Y + rt.slots.landing[next] + TOOTH_R;
}
const SWAY_RATE = 2.4;
const SWAY_TILT = 0.17;
const SWAY_LEAN = 0.1;
const SWAY_YAW = 0.5;

/**
 * Impact speed -> `SoftWobble`'s normalised kick, as a **gain** rather than a divisor.
 *
 * It used to be `impact / 5.5`, justified as "the fastest arrival is `sqrt(2gH)` = 4.02 u/s,
 * so 8 became 5.5 and a catch kicks the jelly exactly as hard as it always did". Round 3
 * measured the result across all 24 frames of the catch contact sheet and found a **6 px dip
 * on a 185 px basket** — 3.2 % — with the rim *narrowing* rather than bulging. `3D-SPEC §6.6`
 * names the basket's soft-body wobble as one of this game's two defining features.
 *
 * Re-derived end to end instead of re-tuned. Stepping `PhysicsWorld` at its 1/120 s fixed
 * step, a tooth arrives at the catch plane at **3.383 / 3.494 / 3.870 u/s** — the fix list's
 * guess that "the solver has already deadened it to ~0.5" is wrong, `respond()` reports
 * `-v.dot(n)` *before* the response, so this is the full landing speed. That kick then runs
 * `SW_IMPULSE_GAIN = 0.6` into a spring at `k = 351`, `d = 23` (zeta 0.61), whose impulse
 * response peaks at `0.0334 v0`, and `SW_SQUASH_GAIN = 2.2` turns that into the squash
 * amount: **0.0315 of squash per unit of kick.** At `impact / 5.5` that is a peak of
 * 1.94-2.22 %, which is exactly the 3.2 % the contact sheet measured once the rim's own
 * travel is added.
 *
 * At a gain of 1.05 the same chain lands at **11.2 / 11.6 / 12.8 %** peak squash across the
 * three levels — the fix list's 10-14 % target — which `squashFor`'s volume-preserving map
 * turns into a **6.1-7.1 % width bulge**, so the rim now widens as it dips instead of
 * narrowing. `SW_SQUASH_LIMIT` is 0.22, so none of it clips. Reproduce with
 * `scratchpad/verify/tooth-rescue-wobble.mjs`.
 */
const CATCH_KICK = 1.05;
/** A candy clipping the rim is a knock, not a landing: about 6 % squash. */
const CANDY_KICK_SCALE = 1 / 1.8;
/**
 * The basket's acknowledgement of a press, in the same units.
 *
 * `3D-SPEC §4` wants a response inside one frame. A spring impulse moves on the frame it is
 * applied — `v0 = -1.9 * 0.6 = -1.14`, so after one 60 Hz frame the value is already 0.019
 * and the squash 4.2 % — and it peaks at **6.0 %** (a scale of 0.940) about 60 ms later
 * before recovering. That is the "presses to 0.94 and pops back" the fix list asked for, and
 * it is the same jelly a catch drives, so a press feels like a small catch rather than like
 * a separate effect.
 */
const PRESS_KICK = 1.9;

/**
 * The rest-state invitation, which is what replaced the "Tap to start" overlay — and what
 * round 4 took out of it.
 *
 * Round 3 (B6.4) found the overlay doing two bad things at once: it was a full-field
 * `<button onClick>` at `z-[2]` over the slider pad at `z-[1]`, and `onClick` fires on
 * pointer-**up**, so the entire first press — down, drag, up — was consumed and never reached
 * `aimAt`. A child who tapped and immediately dragged got a basket that ignored their finger.
 * And what it taught was two lines of English.
 *
 * Three things replaced it: the basket answering a `pointerdown` inside one frame
 * (`PRESS_KICK`), the landing marker on the shelf under the chute mouth, and a tooth perched in
 * the mouth of the chute, bobbing. **The third is gone as of round 4, and the arithmetic is
 * why.** B6.9 filed it as floating — "feet visibly clear of the rail, no contact shadow on
 * anything" — and it was: a prop hanging in mid-air under a bar reads as a sticker however it
 * is justified. There are exactly three places it could go and all three are closed:
 *
 *  - **On the rail**, which is what a viewer already reads it as, and which would give it real
 *    contact. Measured across 25 viewport/chrome combinations (`scratchpad/tr/perch.mjs`), the
 *    headroom between the rail's own top and the chrome band's foot is **at most 0.074 ndc**,
 *    about 26 screen pixels, and at a wrapped HUD it is *negative*. A tooth standing there
 *    needs 0.19-0.25 ndc. It does not fit at **any** viewport — which is exactly what
 *    `tooth-rescue-phone.png` shows happening to it today, head clipped by the timer pill.
 *  - **Behind the rail**, tucked into the chute so the lintel occludes its crown. The shell's
 *    own surface is in the way: at the perch's mid-height the openness is `qstep(0.37 / coveSpan)`
 *    = 0.245, which puts the recess at z = -2.015 against a rail front face at -1.745 — 0.27 of
 *    gap for 0.51 of tooth.
 *  - **Below the rail**, where it was. Nothing to stand on, which is the filed defect.
 *
 * So the fix list's own stated alternative is what ships — "or drop the perch". The other two
 * thirds of the invitation are untouched: the landing marker still sits on the shelf under the
 * chute mouth at rest, saying where a drop ends up, and the basket still presses and pops back
 * the instant a finger lands on it.
 */
const PERCH_EXIT = 0.3;
const PERCH_EXIT_REDUCED = 0.15;

/**
 * The landing marker under a *falling* prop: a real contact darkening that doubles as an
 * aim. It is deliberately not drawn for anything at rest — see G-TRS-6 in the header.
 */
const BLOB_MIN = 0.36;
const BLOB_GROW = 0.3;
const BLOB_FALL_RANGE = 2.9;

/* ------------------------------------------------------------------ */
/* Per-frame scratch — module level, allocated exactly once            */
/* ------------------------------------------------------------------ */

const _m = new Matrix4();
const _pos = new Vector3();
const _scl = new Vector3();
const _off = new Vector3();
const _q = new Quaternion();
const _euler = new Euler();
const _sq = { x: 1, y: 1, z: 1 };
const _identity = new Quaternion();

const FLAT_ROT: [number, number, number] = [-Math.PI / 2, 0, 0];
const BLOB_QUAT = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -Math.PI / 2);

/** The mascot builder puts the origin at the root tips; the collision sphere is centred. */
const TOOTH_CENTRE = new Matrix4().makeTranslation(0, -0.5, 0);
/**
 * The two wrapper ends: laid along X, twisted about their own axis in opposite directions,
 * then offset. Built once at module scope — `_m.multiply(END_*)` in the frame loop is the only
 * per-frame cost. See `CANDY_END_TWIST`.
 */
const END_RIGHT = new Matrix4()
  .makeRotationX(CANDY_END_TWIST)
  .multiply(new Matrix4().makeRotationZ(-Math.PI / 2))
  .setPosition(CANDY_END_OFFSET, 0, 0);
const END_LEFT = new Matrix4()
  .makeRotationX(-CANDY_END_TWIST)
  .multiply(new Matrix4().makeRotationZ(Math.PI / 2))
  .setPosition(-CANDY_END_OFFSET, 0, 0);

/**
 * The wrapper's fluted end, authored explicitly instead of splined.
 *
 * `latheProfile`'s smoothing pass resamples any profile up to 42 rings, which is how a
 * 2 cm nub that covers about fifteen screen pixels came to cost 2,624 triangles at the high
 * tier — twenty of them were 52,480, the largest single item in the whole scene. Eleven
 * hand-placed rings describe the same three flutes at 252 triangles, and `finish()`'s
 * smooth vertex normals mean it still has no shading edge anywhere.
 */
const CANDY_END_PROFILE: [number, number][] = [
  [0, 0],
  [0.097, 0.01],
  [0.158, 0.032],
  [0.19, 0.08],
  [0.167, 0.121],
  [0.113, 0.158],
  [0.132, 0.196],
  [0.158, 0.245],
  [0.116, 0.29],
  [0.055, 0.322],
  [0, 0.346],
];
const CANDY_END_SEGS = 14;
/** The same eleven rings, built `CANDY_END_SCALE` larger. See `layout.ts: CANDY_END_SCALE`. */
const CANDY_END_PROFILE_BIG: [number, number][] = CANDY_END_PROFILE.map(([r, y]) => [
  r * CANDY_END_SCALE,
  y * CANDY_END_SCALE,
]);

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/* ------------------------------------------------------------------ */
/* DEV assertions — see the block in `ToothRescueSceneImpl`            */
/* ------------------------------------------------------------------ */

/**
 * Projects a world point into this scene's own camera, in ndc. Mirrors `layout.ts`'s solve —
 * the camera sits in the YZ plane at a fixed 19-degree tilt with no roll, so this is a dot
 * product rather than a matrix, and it needs no renderer to run.
 */
const CAM_TAN = Math.tan((FOV * Math.PI) / 360);
const CAM_SIN = Math.sin((19 * Math.PI) / 180);
const CAM_COS = Math.cos((19 * Math.PI) / 180);
function projectNdc(framing: Framing, x: number, y: number, z: number): [number, number] | null {
  const dy = y - framing.position[1];
  const dz = z - framing.position[2];
  const depth = -dy * CAM_SIN - dz * CAM_COS;
  if (depth <= 1e-3) return null;
  const metrics = playAreaMetrics();
  const aspect = metrics !== null && metrics.height > 0 ? metrics.width / metrics.height : 1;
  return [x / (depth * CAM_TAN * Math.max(0.3, aspect)), (dy * CAM_COS - dz * CAM_SIN) / (depth * CAM_TAN)];
}
/**
 * How far outside the frame a set edge has to project before the check is satisfied.
 *
 * 1.0 is the frame; anything at 1.0 is *on* the edge, which at a slightly different aspect is
 * inside it. `layout.ts: SET_ASPECT_MIN` sizes the set for a 2.2 aspect precisely so this has
 * room, and the check is what proves the sizing survived whatever the play area reported.
 */
const SET_EDGE_MARGIN = 1.02;

/**
 * Every accent hex this scene paints, and the family the registry says it is.
 *
 * `GAMES` is not imported: `src/games/index.ts` imports this scene's entry point, so reading
 * the registry here would be an evaluation-order cycle. `auditSceneAccents` takes the family as
 * an argument for exactly this reason (see `tokens.ts`), and the DEV check below is what stops
 * the duplicate drifting.
 */
const REGISTRY_ACCENT = "red" as const;
function sceneAccentHexes(): readonly string[] {
  return [...ALCOVE_HEXES, ACCENTS.red.main, ACCENTS.red.soft, ...CANDY_HEX];
}

/* ------------------------------------------------------------------ */
/* Items                                                              */
/* ------------------------------------------------------------------ */

type Item = {
  /** Index within its own kind's pool — also its instance index. */
  slotIndex: number;
  kind: number;
  body: Body;
  state: number;
  /** Counts down in S_LOOSE, up in S_POOF. */
  timer: number;
  /** Seconds since this life began. Drives the falling tooth's sway. */
  age: number;
  scale: number;
  seed: number;
  variant: number;
  /** Assigned pile slot, or -1. */
  pile: number;
  /** Impact speeds captured by the collision callback, consumed after the step. */
  hitBasket: number;
  hitGround: number;
  /**
   * How long this body has been in `S_FALL` without actually falling. See `FALL_STALL`.
   */
  stall: number;
  /** Local-Y squash, kicked on every real impact. */
  squash: Spring;
  /** Basket-local homing spring for a caught tooth. */
  home: Spring3;
  /** Resting orientation a settled prop turns towards. */
  rest: Quaternion;
  /** Whether `rest` has been chosen for the current life. */
  resting: boolean;
};

function createItem(world: PhysicsWorld, kind: number, slotIndex: number): Item {
  const body = world.addBody({
    radius: kind === KIND_TOOTH ? TOOTH_R : CANDY_R,
    // Teeth are dead weight; candy is a bouncy little liar.
    restitution: kind === KIND_TOOTH ? 0.16 : 0.55,
    friction: kind === KIND_TOOTH ? 0.85 : 0.25,
    kind: kind === KIND_TOOTH ? "tooth" : "candy",
  });
  body.position.set(0, GARAGE_Y, 0);
  body.sleeping = true;

  const item: Item = {
    slotIndex,
    kind,
    body,
    state: S_FREE,
    timer: 0,
    age: 0,
    scale: 0,
    seed: 0,
    variant: 0,
    pile: -1,
    hitBasket: 0,
    hitGround: 0,
    stall: 0,
    // 360 / 19: in `3D-SPEC §4`'s 260–420 / 18–28 band (it shipped at damping 17).
    squash: new Spring(0, 360, 19),
    home: new Spring3(0, 0, 0, PILE_STIFFNESS, PILE_DAMPING),

    rest: new Quaternion(),
    resting: false,
  };
  // Sideways and depth-wise the pile is springy — that is the slosh when the basket
  // swings. Vertically it must never overshoot upward, or a settling tooth would pop back
  // out of the heap, so its channel is deliberately over-damped.
  item.home.y.damping = PILE_DAMPING * 1.8;
  body.userData.item = item;
  return item;
}

/**
 * **B6.5: the thing to avoid was painted the same family as the 22.6 % backdrop it falls in
 * front of.** `red.main` and `coral.main` against a `coral.deep` alcove — `tooth-rescue-catch-f09.png`
 * shows a sweet that is very nearly camouflaged, in a game whose one rule is "catch these,
 * let those go by".
 *
 * The recess is now the game's own `red` (see `set.ts: ALCOVE_DEEP`), so the sweet moves off
 * red and coral entirely. Measured as albedo relative luminance against the recess's 0.160:
 *
 * | tone | hex | L | vs the wall |
 * |---|---|---|---|
 * | `peach.main` | `#efa160` | 0.4468 | **2.37:1** |
 * | `mauve.main` | `#c08475` | 0.2899 | 1.63:1 |
 * | `peach.deep` | `#c97a34` | 0.2658 | 1.51:1 |
 * | `red.main` (was) | `#e8474f` | 0.2223 | 1.30:1 |
 * | `rose.main` (was) | `#cf4a55` | 0.1882 | 1.13:1 |
 *
 * Three tones rather than four, because the fourth would have to come back toward the wall.
 * `mauve.main` earns its place on chroma rather than on luminance — C\* 22 against the
 * recess's 72, so a dusty sweet on a saturated wall separates even where the two luminances
 * are closest. The shape carries the rest: see `CANDY_STRETCH` and `CANDY_END_TWIST`.
 */
const CANDY_HEX = [ACCENTS.peach.main, ACCENTS.mauve.main, ACCENTS.peach.deep];

/**
 * Hands a caught tooth's body over to the pile spring: it stops being simulated but keeps
 * its quaternion, which the render path goes on slerping towards the slot's resting pose.
 */
function sleepBody(item: Item): void {
  const b = item.body;
  b.velocity.set(0, 0, 0);
  b.angularVelocity.set(0, 0, 0);
  b.position.set(0, GARAGE_Y, 0);
  b.sleeping = true;
}

function park(item: Item): void {
  item.state = S_FREE;
  item.scale = 0;
  item.pile = -1;
  item.timer = 0;
  item.age = 0;
  item.hitBasket = 0;
  item.hitGround = 0;
  item.stall = 0;
  item.resting = false;
  item.squash.set(0);
  const b = item.body;
  b.velocity.set(0, 0, 0);
  b.angularVelocity.set(0, 0, 0);
  b.position.set(0, GARAGE_Y, 0);
  b.quaternion.identity();
  b.sleeping = true;
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

/** Fired from a discrete event only, so `Math.random` here costs nothing per frame. */
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
    field.px[i] = x + (Math.random() - 0.5) * 0.48;
    field.py[i] = y + Math.random() * 0.22;
    field.pz[i] = z + (Math.random() - 0.5) * 0.48;
    const a = Math.random() * Math.PI * 2;
    const e = 0.3 + Math.random() * 0.9;
    const s = reduced ? 0 : 0.7 + Math.random() * 0.6;
    field.vx[i] = Math.cos(a) * Math.cos(e) * s;
    field.vy[i] = Math.sin(e) * s + (reduced ? 0 : 0.5);
    field.vz[i] = Math.sin(a) * Math.cos(e) * s;
    field.life[i] = 0;
    field.dur[i] = reduced ? 0.3 : 0.58 + Math.random() * 0.28;
    field.size[i] = 0.24 + Math.random() * 0.19;
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
  if (field.live <= 0) {
    mesh.count = 0;
    return;
  }
  mesh.count = field.n;
  let live = 0;
  for (let i = 0; i < field.n; i++) {
    const dur = field.dur[i];
    if (dur <= 0) continue;
    const life = field.life[i] + dt;
    if (life >= dur) {
      field.dur[i] = 0;
      _pos.set(0, 0, 0);
      _scl.set(0, 0, 0);
      _m.compose(_pos, camQuat, _scl);
      mesh.setMatrixAt(i, _m);
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
    _m.compose(_pos, camQuat, _scl);
    mesh.setMatrixAt(i, _m);
  }
  field.live = live;
  mesh.instanceMatrix.needsUpdate = true;
}

/* ------------------------------------------------------------------ */
/* Runtime                                                             */
/* ------------------------------------------------------------------ */

type Runtime = {
  world: PhysicsWorld;
  teeth: Item[];
  candy: Item[];
  all: Item[];
  wobble: SoftWobble;
  basket: Spring;
  sparkles: SparkleField;

  floor: BoxCollider;
  wallL: BoxCollider;
  wallR: BoxCollider;
  wallB: BoxCollider;
  wallF: BoxCollider;

  slots: PileSlots;
  piled: number;

  /* Framing, mirrored so the frame loop never touches React. */
  playHalf: number;
  halfX: number;
  basketW: number;
  innerHalfW: number;

  basketX: number;
  prevX: number;
  prevV: number;

  candyColorDirty: boolean;
  /** `SoftWobble.apply` captures the node's authored scale on its first call after a
   *  `reset()`, so the node has to be back at 1 before that call happens. */
  wobbleDirty: boolean;

  /* --- the rest-state invitation, and the press it answers --- */
  /** Last `engine.presses` this scene has reacted to. An edge, not a level. */
  presses: number;
  /** How far the rest-state landing marker has faded out (0..1). */
  perchGone: number;
};

function createRuntime(): Runtime {
  const world = new PhysicsWorld({ gravity: GRAVITY });
  world.addPlane(STAGE_Y, 1, "ground");

  const teeth: Item[] = [];
  const candy: Item[] = [];
  const all: Item[] = [];
  for (let i = 0; i < TOOTH_POOL; i++) {
    const item = createItem(world, KIND_TOOTH, i);
    teeth.push(item);
    all.push(item);
  }
  for (let i = 0; i < CANDY_POOL; i++) {
    const item = createItem(world, KIND_CANDY, i);
    candy.push(item);
    all.push(item);
  }

  // Placeholder extents; `applyFraming` writes the real ones before the first frame.
  const zero = new Vector3();
  const half = new Vector3(0.5, 0.5, 0.5);
  const floor = world.addBox(zero, half, 0.35, "basket-floor");
  const wallL = world.addBox(zero, half, 1, "basket-wall");
  const wallR = world.addBox(zero, half, 1, "basket-wall");
  const wallB = world.addBox(zero, half, 1, "basket-wall");
  const wallF = world.addBox(zero, half, 1, "basket-wall");

  return {
    world,
    teeth,
    candy,
    all,
    // Damping raised from 15 into `3D-SPEC §4`'s 18–28 band; ζ goes 0.47 → 0.62, which is
    // the difference between a basket that wobbles twice and one that wobbles once.
    wobble: new SoftWobble({ stiffness: 260, damping: 20, maxTilt: 0.11 }),
    basket: new Spring(0, BASKET_STIFFNESS, BASKET_DAMPING),
    sparkles: createSparkles(SPARKLES),
    floor,
    wallL,
    wallR,
    wallB,
    wallF,
    slots: pileSlots(2.2),
    piled: 0,
    playHalf: 1,
    halfX: 2.2,
    basketW: 2.2,
    innerHalfW: 0.95,
    basketX: 0,
    prevX: 0,
    prevV: 0,
    candyColorDirty: true,
    wobbleDirty: true,
    presses: 0,
    perchGone: 0,
  };
}

/** Wall geometry follows the solved basket width; called on mount and on every resize. */
function applyFraming(rt: Runtime, framing: Framing): void {
  rt.playHalf = framing.playHalf;
  rt.halfX = framing.halfX;
  rt.basketW = framing.basketW;
  rt.innerHalfW = framing.basketW / 2 - WALL;
  rt.slots = pileSlots(framing.basketW);

  const wallH = (RIM_Y - WELL_Y) * 0.5;
  const wallCY = STAGE_Y + WELL_Y + wallH;
  // X and Z are owned by `syncColliders`, which widens them as the heap grows.
  rt.floor.halfExtents.set(rt.innerHalfW, 0.06, INNER_HALF_D);
  rt.wallL.halfExtents.set(WALL * 0.5, wallH, INNER_HALF_D + WALL);
  rt.wallR.halfExtents.copy(rt.wallL.halfExtents);
  rt.wallB.halfExtents.set(rt.innerHalfW + WALL, wallH, WALL * 0.5);
  rt.wallF.halfExtents.copy(rt.wallB.halfExtents);
  rt.wallL.center.y = wallCY;
  rt.wallR.center.y = wallCY;
  rt.wallB.center.y = wallCY;
  rt.wallF.center.y = wallCY;
  syncColliders(rt);
}

/**
 * The basket's catching floor rises with the heap so the next tooth lands *on the pile*
 * instead of dropping through it — the piled teeth are render-only and have no colliders of
 * their own. Once there is anything to land on, the catching surface also widens to the
 * basket's whole footprint: a heap spreads past the well, and a tooth clipping the edge of one
 * has nowhere honest to fall to.
 *
 * The height is read straight out of the drop solve (`pileSlots().landing`), not stepped by a
 * nominal layer: `landing[i]` is `y[i] - TOOTH_R`, i.e. the collider top at which a tooth
 * resting on it has its centre exactly at the slot it is about to be sprung to. The homing
 * spring therefore has no vertical distance left to cover, which is what stops a catch
 * dropping through the heap and jumping back up it — and it is the only version of this
 * number that stays correct now that the heap is not a stack of equal layers.
 */
function syncColliders(rt: Runtime): void {
  const next = rt.piled < PILE_SLOTS ? rt.piled : PILE_SLOTS - 1;
  const floorTop = STAGE_Y + rt.slots.landing[next];
  const x = rt.basketX;
  rt.floor.halfExtents.x = rt.piled > 0 ? rt.innerHalfW + WALL : rt.innerHalfW;
  rt.floor.halfExtents.z = rt.piled > 0 ? INNER_HALF_D + WALL : INNER_HALF_D;
  rt.floor.center.set(x, floorTop - rt.floor.halfExtents.y, 0);
  rt.wallL.center.x = x - rt.innerHalfW - WALL * 0.5;
  rt.wallR.center.x = x + rt.innerHalfW + WALL * 0.5;
  rt.wallB.center.x = x;
  rt.wallF.center.x = x;
  rt.wallB.center.z = -(INNER_HALF_D + WALL * 0.5);
  rt.wallF.center.z = INNER_HALF_D + WALL * 0.5;
}

function freeAll(rt: Runtime): void {
  for (let i = 0; i < rt.all.length; i++) park(rt.all[i]);
  rt.piled = 0;
  rt.basket.set(0);
  rt.basketX = 0;
  rt.prevX = 0;
  rt.prevV = 0;
  rt.wobbleDirty = true;
  resetSparkles(rt.sparkles);
  syncColliders(rt);
  rt.candyColorDirty = true;
  rt.perchGone = 0;
}

/* ------------------------------------------------------------------ */
/* Spawning                                                            */
/* ------------------------------------------------------------------ */

function spawn(rt: Runtime, event: EngineEvent, reduced: boolean): void {
  const list = event.kind === KIND_TOOTH ? rt.teeth : rt.candy;
  let item: Item | null = null;
  for (let i = 0; i < list.length; i++) {
    if (list[i].state === S_FREE) {
      item = list[i];
      break;
    }
  }
  if (!item) return;

  const seed = event.spin;
  item.state = S_FALL;
  item.scale = 1;
  item.seed = seed;
  item.variant = event.variant;
  item.pile = -1;
  item.timer = 0;
  item.age = 0;
  item.hitBasket = 0;
  item.hitGround = 0;
  item.stall = 0;
  item.resting = false;
  item.squash.set(0);
  item.home.set(0, 0, 0);

  const b = item.body;
  b.sleeping = false;
  b.position.set(event.x * rt.playHalf, SPAWN_Y, (seed - 0.5) * 0.1);
  b.velocity.set(0, -event.drop, 0);
  b.quaternion.identity();

  if (item.kind === KIND_TOOTH) {
    if (reduced) {
      // Dead upright and front-on, exactly as round 2 shipped it. See the SPIN_TOOTH block.
      b.angularVelocity.set(0, 0, 0);
    } else {
      // One seed, two decorrelated numbers: the golden ratio walks the unit interval
      // without repeating a pattern the eye can lock on to, and needs no RNG state.
      const s2 = (seed * 1.6180339887) % 1;
      const mag = SPIN_TOOTH * (0.8 + seed * 0.4);
      const sign = s2 < 0.5 ? 1 : -1;
      // Yaw carries the tumble (B6.6). Pitch and roll get a little, and are clamped on the
      // orientation every frame so they can rock but can never turn the mascot over.
      b.angularVelocity.set(
        sign * mag * SPIN_TOOTH_PITCH,
        sign * mag,
        (s2 - 0.5) * mag * SPIN_TOOTH_ROLL
      );
    }
  } else {
    const s = reduced ? SPIN_REDUCED : SPIN_CANDY;
    b.angularVelocity.set((seed - 0.5) * 2 * s, (0.5 - seed) * s, (seed * 1.4 - 0.7) * s);
    rt.candyColorDirty = true;
  }
}

/* ------------------------------------------------------------------ */
/* Contact handling                                                    */
/* ------------------------------------------------------------------ */

/**
 * Is this contact on the *inside* of the basket — the well, the inner wall or the rim top —
 * rather than a graze down the outside of it?
 *
 * The wall colliders are the real wall: their outer faces are the basket's own silhouette,
 * which is honest (you can knock a prop off the side of a basket) but means "touched a
 * basket collider" is not the same question as "went in". A sphere resting against the
 * outer face sits a full radius beyond the wall; one on the rim or inside never does.
 */
function insideBasket(rt: Runtime, body: Body): boolean {
  return (
    Math.abs(body.position.x - rt.basketX) < rt.innerHalfW + WALL + body.radius * 0.5 &&
    Math.abs(body.position.z) < INNER_HALF_D + WALL + body.radius * 0.5 &&
    body.position.y > STAGE_Y + WELL_Y - body.radius
  );
}

/**
 * Is this body over the **mouth** — the opening a prop can actually fall through?
 *
 * `insideBasket` above is deliberately generous (it has to catch a candy grazing the outside
 * of a wall, which is still a rim strike a child watches). This is the strict question, and it
 * is the one that decides whether a *tooth* touching the assembly is on its way in or has
 * clipped the edge.
 */
function overMouth(rt: Runtime, body: Body): boolean {
  return Math.abs(body.position.x - rt.basketX) <= rt.innerHalfW && Math.abs(body.position.z) <= INNER_HALF_D;
}

/**
 * **B6.2's root cause, and the one line that produced the picture.**
 *
 * Round 4 photographed "five teeth in a rigid fan above and outside the basket rim with open
 * air beneath them, roots stabbing through neighbouring crowns" and read it as a pile-packing
 * failure. It is not: it is a **lifecycle hole**. Reproduced from the source and from the
 * capture's own HUD — `tooth-rescue-catch-f13.png` reads `150` points on Easy, which is
 * `150 / 50` = **three teeth caught**, under a fan of six or seven.
 *
 * A tooth left `S_FALL` only on a `ground` contact or a `basket-floor` contact. The five
 * basket colliders are boxes, and `sweepSphereBox` inflates a box by the sphere's radius
 * before testing it — so a wall collider `2 * WALL` = 0.30 thick presents a **stable top face
 * 0.30 + 2 * TOOTH_R = 1.04 units wide** at exactly rim height, with a pure `+Y` normal
 * everywhere except the outermost corner. A tooth landing anywhere on that band settles there
 * with restitution 0.16 and friction 0.85, `updateSleep` sleeps it after `SLEEP_TIME`, and a
 * sleeping body is skipped by `substep` entirely. It never touches the ground, never touches
 * the floor, never leaves `S_FALL` — and the face-on blend cannot rescue it either, because
 * `tta` is computed from the fall speed and a stationary tooth divides by nothing and gets
 * `blend = 0`. It is frozen mid-tumble, above the rim, for the rest of the run, while the next
 * one lands beside it at the same height (bodies do not collide with each other) and the fan
 * assembles itself.
 *
 * The comment this replaces said such a tooth "deadens against the clay and slides off the
 * outside — which is what actually happened". It is what was *intended*; it is not what the
 * collider does.
 *
 * Two changes close it, and the second one closes it whatever the collider geometry does next:
 *
 *  1. a tooth that touches the assembly while **not over the mouth** is knocked clear here, in
 *     the solver's own callback, in the substep it arrives — the same place the candy's comic
 *     ejection already lives;
 *  2. `FALL_STALL` in the frame loop retires any falling body that has stopped falling,
 *     wherever it is resting and whatever it is resting on.
 */
function deflectOffBasket(rt: Runtime, item: Item): void {
  const b = item.body;
  const dir = b.position.x >= rt.basketX ? 1 : -1;
  b.velocity.x = dir * DEFLECT_OUT * (0.85 + item.seed * 0.3);
  if (b.velocity.y > -DEFLECT_DOWN) b.velocity.y = -DEFLECT_DOWN;
  // A knock, not a landing: the same wobble a candy's rim strike drives, at the same scale.
  b.angularVelocity.multiplyScalar(0.5);
  item.state = S_LOOSE;
  item.timer = REST_TOOTH;
  item.stall = 0;
  item.resting = false;
}

/**
 * The rim's comic ejection. Runs inside the solver's own collision callback, which is the
 * one place a game is invited to overwrite a response, so the candy leaves the basket in
 * the same substep it arrived — never after a frame of bouncing around inside it.
 */
function ejectCandy(rt: Runtime, item: Item, reduced: boolean, gain = 1, keepTimer = false): void {
  const b = item.body;
  let sx = b.position.x >= rt.basketX ? 1 : -1;
  // Aim the arc back into the frame when the basket is parked against an edge, so the
  // joke always lands somewhere the child can watch it.
  const reach = reduced ? EJECT_OUT_REDUCED * 1.6 : EJECT_RANGE;
  if (rt.basketX + sx * reach > rt.halfX - 0.35) sx = -1;
  else if (rt.basketX + sx * reach < -(rt.halfX - 0.35)) sx = 1;

  const out = (reduced ? EJECT_OUT_REDUCED : EJECT_OUT) * gain;
  const up = (reduced ? EJECT_UP_REDUCED : EJECT_UP) * gain;
  b.velocity.set(sx * out * (0.85 + item.seed * 0.3), up, 0.22 + (item.seed - 0.5) * 0.4);

  const spin = (reduced ? SPIN_REDUCED * 2 : EJECT_SPIN) * gain;
  b.angularVelocity.set(
    (item.seed - 0.5) * spin,
    (0.5 - item.seed) * spin * 0.5,
    -sx * spin * (0.7 + item.seed * 0.4)
  );
  item.state = S_LOOSE;
  // A **re-**ejection keeps the clock it already had. Resetting it would let a sweet that
  // keeps finding its way back into the basket live for ever, and the whole point of the
  // rebound is that it does not stay.
  if (!keepTimer) item.timer = REST_CANDY;
  item.stall = 0;
  item.resting = false;
}

/* ------------------------------------------------------------------ */
/* Painting                                                            */
/* ------------------------------------------------------------------ */

/**
 * Paints the tub pale and its rolled rim in the accent, on **one** surface.
 *
 * This is the whole of what used to be fourteen instanced red prongs and a band. The tray
 * geometry is cloned (never the cache entry — see the header) and given an `aAlbedo`
 * attribute. `color` is untouched: that attribute is `bakeCurvatureAO`'s signed curvature, and
 * the rolled lip keeps its crevice darkening and its edge gloss exactly as the tray shipped
 * them.
 *
 * ---------------------------------------------------------------------------
 * Round 4 (B6.8): the "rim band" was a full-height dip-dye, and the ramp was fiction
 * ---------------------------------------------------------------------------
 *
 * The audit measured a red-to-white gradient down the whole front of the tub —
 * `#ec3f3f -> #de8d86 -> #e2b1a7 -> #dcbdb0` down one 100 px column — against a comment
 * describing a band at the rim fading over 0.05 units. Both are true, and the reason is a
 * class of bug worth naming: **a per-vertex ramp narrower than the mesh's vertex spacing is
 * not a ramp.**
 *
 * `buildClayTray` draws the tub's outer wall as `line(0, baseRoll, 0, innerTop, wallSegs)`
 * with `wallSegs = pick3(dt, 1, 2, 3)`. At the high tier that is three segments, so on a
 * 1.06-tall tub the wall carries vertex rings at roughly `y = 0.05, 0.38, 0.71, 0.99` and
 * **nothing in between**. The old band started at `BASKET_H - 0.22` and faded over 0.05; no
 * vertex fell inside that window, so the shader interpolated `soft` at one ring to `main` at
 * the next and painted a 0.28-unit gradient. At the **low tier** `wallSegs` is 1 and the two
 * rings are the whole wall: the ramp becomes the entire tub, which is the dip-dye
 * `tooth-rescue-tier-low.png` shows.
 *
 * So the band is no longer placed against a hand-written height; it is placed against the
 * **geometry**. `trayMetrics` mirrors the builder's own arithmetic, and `innerTop` is a ring
 * the profile always emits at every tier, with the rolled lip's own arc rings — three at the
 * low tier, five at the high — stacked above it. Painting from `innerTop` up over `topRoll`
 * therefore puts the whole ramp *inside the roll*, on vertices that exist, at every tier: the
 * body is one tone the lighting can shape and the accent is the rim, which is what the
 * comment always claimed. And because the roll is a curved surface, the boundary is a
 * gradient over real curvature rather than the hard line `3D-SPEC §0` bans.
 *
 * `assertBandIsSampled` runs the check in DEV rather than trusting this paragraph: it counts
 * the distinct vertex heights the ramp actually lands on and reports if there are fewer than
 * three. A future edit to the band, to `BASKET_H` or to `clayTray`'s profile cannot
 * reintroduce the dip-dye silently.
 */
function paintBasket(geo: BufferGeometry, basketW: number): void {
  const tray = trayMetrics(basketW, BASKET_D, BASKET_H, BASKET_RIM);
  const start = tray.innerTop;
  const fade = tray.topRoll;
  const pos = geo.getAttribute("position");
  const n = pos.count;
  const out = new Float32Array(n * 3);
  const soft = color(ACCENTS.red.soft);
  const main = color(ACCENTS.red.main);
  let sampled = 0;
  let lastY = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < n; i++) {
    const y = pos.getY(i);
    const t = clamp01((y - start) / fade);
    const s = t * t * (3 - 2 * t);
    out[i * 3] = soft.r + (main.r - soft.r) * s;
    out[i * 3 + 1] = soft.g + (main.g - soft.g) * s;
    out[i * 3 + 2] = soft.b + (main.b - soft.b) * s;
    if (y >= start - 1e-4 && y <= start + fade + 1e-4 && Math.abs(y - lastY) > 1e-4) {
      sampled++;
      lastY = y;
    }
  }
  geo.setAttribute(ALBEDO_ATTRIBUTE, vertexAlbedoAttribute(out));

  if (import.meta.env.DEV && sampled < 3) {
    console.error(
      `[tooth-rescue/scene] the rim band spans ${sampled} vertex ring(s) between y ${start.toFixed(3)} ` +
        `and ${(start + fade).toFixed(3)}. Below three the shader interpolates across whatever ` +
        `is either side of it and the band renders as a full-height dip-dye (B6.8). Move the ` +
        `band onto rings clayTray actually emits, or raise the tray's profile resolution.`
    );
  }
}

/* ------------------------------------------------------------------ */
/* Scene                                                               */
/* ------------------------------------------------------------------ */

type SceneProps = {
  engine: ToothRescueEngine;
  framing: Framing;
  /**
   * Whether the DOM slider that drives this scene currently has a **visible** focus ring.
   *
   * A discrete flag, not a per-frame one: it changes on focus and blur and nowhere else, so
   * the re-render it costs happens twice a session. Every `useMemo` in this component is keyed
   * on `framing`, so nothing is rebuilt when it flips.
   */
  focused: boolean;
};

function ToothRescueSceneImpl({ engine, framing, focused }: SceneProps): JSX.Element {
  const rt = useMemo(() => createRuntime(), []);
  const bag = useMemo(() => new DisposalBag(), []);

  /* ---------------- geometry ---------------- */

  /**
   * Cloned, because it carries a per-vertex albedo and `cachedGeometry` entries are shared
   * across games for the life of the WebGL context.
   */
  /**
   * The tray is built at **detail 3 on every tier**, and that is B6.8's third item.
   *
   * The audit read "the front-left vertical corner is a 90-degree silhouette with no bevel
   * highlight". As geometry that is wrong and the number says so: `trayMetrics` puts the tub's
   * vertical corner radius at **0.288 units** at every width the solver hands out — 14x
   * `3D-SPEC §3`'s 0.02 minimum bevel, and a fifth of the whole half-width of the narrowest
   * basket. It is one of the most generously rounded corners in the product.
   *
   * What the audit was looking at is the corner's **sampling**, and there the reading is right.
   * `geometry.ts: buildClayTray` builds the rounded-rect ring with
   * `filletSegments(pick3(dt, 3, 4, 6))`, i.e. against A4's *fillet* floor of 3 rather than its
   * *silhouette* floor of 24 — but a 0.288-unit corner is a silhouette, not a fillet. At the low
   * tier that is **three facets across a 90-degree turn, 30 degrees of normal step each**, which
   * is exactly the crease down the front-left corner in `tooth-rescue-tier-low.png`. At detail 3
   * it is six, 15 degrees, and a sagitta of 0.0025 units — a third of a pixel at this prop's
   * framing.
   *
   * The floor belongs in `geometry.ts` (contract noted in the round-4 report); what this file
   * can do without reaching into shared code is refuse the tier for the one prop a child has
   * under their finger for thirty seconds. It costs 1,408 triangles — 0.8 % of the §9 budget —
   * on a scene measured at 64.7k.
   */
  const basketGeo = useMemo(() => {
    const geo = clayTray(framing.basketW, BASKET_D, BASKET_H, BASKET_RIM, 3).clone();
    paintBasket(geo, framing.basketW);
    return geo;
  }, [framing.basketW]);
  useEffect(() => () => basketGeo.dispose(), [basketGeo]);

  /** Cloned for the same reason: the cane / grip tint is a per-instance albedo. */
  const weaveGeo = useMemo(() => roundedBox(1, 1, 1, 0.34, 1).clone(), []);
  const candyGeo = useMemo(() => softSphere(CANDY_BODY_R, 2).clone(), []);
  const candyEndGeo = useMemo(
    () => latheProfile(CANDY_END_PROFILE_BIG, CANDY_END_SEGS, false).clone(),
    []
  );
  const toothGeo = useMemo(() => buildMascotGeometry(), []);

  const matGeo = useMemo(
    () => roundedPlate(framing.matHalfX * 2, framing.matNear + 0.4 - framing.matFar, MAT_T, 0.42, 1),
    [framing.matHalfX, framing.matNear, framing.matFar]
  );
  /**
   * The alcove: back panel, pale wings and lintel, as **one** continuous surface.
   *
   * Round 3 filed this five times over — see `set.ts` for every measurement and for the
   * arithmetic behind the replacement. `setHalfX` keeps the wings' old outer extent, which
   * `solveFraming` already guarantees is outside the frame at every viewport, so the shell's
   * own edges are as unframeable as the pieces it replaces.
   */
  const setHalfX = Math.max(framing.nicheHalfX + 0.5, framing.wallHalfX + 0.6);
  const alcoveGeo = useMemo(
    () =>
      buildAlcove({
        halfX: setHalfX,
        bottom: SET_BASE_Y,
        top: framing.wallTop + 0.4,
        openHalfX: framing.nicheHalfX,
        openTop: framing.nicheTop,
        coveSpan: nicheCoveSpan(framing.nicheTop),
      }),
    [setHalfX, framing.wallTop, framing.nicheHalfX, framing.nicheTop]
  );
  useEffect(() => () => alcoveGeo.dispose(), [alcoveGeo]);
  const railGeo = useMemo(
    () => roundedBox(framing.nicheHalfX * 2 + 0.42, RAIL_H, FRAME_T + 0.16, 0.055, 1),
    [framing.nicheHalfX]
  );
  /**
   * The skirting the whole set stands on, and the one piece of it that has to run the full
   * width rather than the opening's.
   *
   * It sits at `FRAME_Z + 0.12` with a depth of 0.36, so its front face is at z = -1.75 —
   * 0.075 **proud** of the shell's wall face at `NICHE_MOUTH_Z` = -1.825. A proud piece that stops at the opening
   * therefore shows its own cut end standing on the wing's face, which is precisely the
   * fault G-TRS-4 measured elsewhere in this set. Projected at the solved camera, the old
   * `nicheHalfX * 2 + 0.3` put that end at ndc.x **0.43** on a 1400x500 viewport, 0.64 at
   * 1920x900 and 0.83 on a 1180x760 laptop — in shot at every wide aspect.
   *
   * `setHalfX` is the wings' own outer edge, which `wingW` above already solves to finish
   * 0.6 units past the back panel. Re-projected: the end now lands at ndc.x 1.21-1.95
   * across 360x640 through 1400x500, i.e. outside the frame at every viewport tested.
   *
   * Running it the full width also buries every upright's junction with the mat behind one
   * continuous base, so the wings and the panel no longer meet the shelf in a bare line.
   */
  const plinthGeo = useMemo(() => roundedBox(setHalfX * 2, 0.3, 0.36, 0.1, 1), [setHalfX]);
  const quadGeo = useMemo(
    () => cachedGeometry("tooth-rescue/quad", () => new PlaneGeometry(1, 1)),
    []
  );

  /* ---------------- materials (all cached and shared) ---------------- */

  /**
   * White-based, so the per-vertex `aAlbedo` reads as the token colour instead of as a
   * tint of the base. Otherwise a copy of `clayAccent`'s parameters.
   */
  const basketMat = useMemo(
    () =>
      clay("tooth-rescue/basket", {
        color: "#ffffff",
        roughness: 0.68,
        wrap: 0.24,
        sss: ACCENTS.red.soft,
        sssStrength: 0.38,
        sheen: 0.38,
        grain: 0.15,
      }),
    []
  );
  const weaveMat = useMemo(
    () =>
      clay("tooth-rescue/weave", {
        color: "#ffffff",
        roughness: 0.74,
        wrap: 0.26,
        sss: CLAY.sss,
        sssStrength: 0.45,
        sheen: 0.42,
        grain: 0.14,
      }),
    []
  );
  /** White-based `clayEnamel`: the mascot's own body colour rides on the albedo. */
  const toothMat = useMemo(
    () =>
      clay("tooth-rescue/tooth", {
        color: "#ffffff",
        roughness: 0.58,
        wrap: 0.35,
        sss: CLAY.sss,
        sssStrength: 0.72,
        sheen: 0.5,
        grain: 0.12,
      }),
    []
  );
  const candyMat = useMemo(
    () =>
      clay("tooth-rescue/candy", { color: "#ffffff", roughness: 0.44, sheen: 0.5, grain: 0.07 }),
    []
  );
  const matMat = useMemo(
    () => clay("tooth-rescue/shelf", { color: NEUTRAL.well, roughness: 0.82, sheen: 0.1, grain: 0.19 }),
    []
  );
  /**
   * The alcove. White-based, because the shell carries wall, reveal and recess on **one**
   * surface and every one of those colours rides on the per-vertex `aAlbedo` attribute.
   *
   * The contrast reasoning the round-2 `CLAY.crevice` panel was built on is kept and has been
   * re-verified twice since — a tooth renders at relative luminance 0.663 and against the
   * cream shelf that is 1.22:1, genuinely invisible. What has changed twice is the colour it
   * is solved with: `CLAY.crevice` was a neutral in a game whose in-family pixel share the
   * brand critic measured at 13 %, and `coral.deep` was the wrong *family* (A15: 76.9 % of
   * this game's saturated pixels classified nearest coral against a registry that says red).
   * `set.ts: ALCOVE_DEEP` is now the red family held at the same L\* the coral was, and the
   * recess is **fluted** rather than dished-and-flat — see `set.ts: RIB_DEPTH` for the
   * measurement that forced it.
   */
  const alcoveMat = useMemo(
    () =>
      clay("tooth-rescue/alcove", {
        color: "#ffffff",
        roughness: 0.8,
        sheen: 0.2,
        grain: 0.16,
      }),
    []
  );
  const frameMat = useMemo(
    () => clay("tooth-rescue/frame", { color: CLAY.ivoryDeep, roughness: 0.8, sheen: 0.16, grain: 0.16 }),
    []
  );
  /**
   * The rail gets its own material rather than `clayAccent("red")`, for one reason: `grainScale`.
   *
   * A14's fix 1 made the grain map's repeat a per-object knob and gave the sizing rule
   * `grainScale ~ (3.5 * 0.75) / propSizeInUnits`, because the map is authored for a prop about
   * 3.5 units across and a small one gets a fraction of a grain period over its whole surface.
   * B6.9 measured the consequence here: "a 690x8 px capsule of uniform `#dd3c3d` with one
   * specular streak, no grain and no wear". The rail is long but **thin** — `RAIL_H` is 0.13 —
   * and it is the short dimension that decides whether a child sees any grain at all, so the
   * rule gives `2.625 / 0.13` = 20, above A14's cap of 4. Capped at 4 the finest octave is held
   * at ~3 px by the variant's own octave drop, so this cannot alias.
   */
  const railMat = useMemo(
    () =>
      clay("tooth-rescue/rail", {
        color: ACCENTS.red.main,
        roughness: 0.68,
        wrap: 0.24,
        sss: ACCENTS.red.soft,
        sssStrength: 0.38,
        sheen: 0.38,
        grain: 0.14,
        grainScale: 4,
      }),
    []
  );
  const blobMat = useMemo(() => shadowBlobMaterial(), []);

  /** The only resource this game builds itself, and so the only one it must free. */
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
    bag.add(sparkleMat);
    bag.add(weaveGeo);
    bag.add(candyGeo);
    bag.add(candyEndGeo);
    bag.add(toothGeo);
    bag.onRelease(() => rt.world.clear());
    return () => bag.release();
  }, [bag, sparkleMat, weaveGeo, candyGeo, candyEndGeo, toothGeo, rt]);

  /* ---------------- refs ---------------- */

  const rootRef = useRef<Group>(null);
  const bodyRef = useRef<Group>(null);
  const weaveRef = useRef<InstancedMesh>(null);
  const toothRef = useRef<InstancedMesh>(null);
  const candyRef = useRef<InstancedMesh>(null);
  const endRef = useRef<InstancedMesh>(null);
  const blobRef = useRef<InstancedMesh>(null);
  const sparkRef = useRef<InstancedMesh>(null);
  /** Everything in flight, as one node, so the celebration can clear the air. */
  const flightRef = useRef<Group>(null);
  const candyAlbedo = useRef<InstancedBufferAttribute | null>(null);
  const endAlbedo = useRef<InstancedBufferAttribute | null>(null);

  /* ---------------- framing ---------------- */

  useLayoutEffect(() => {
    applyFraming(rt, framing);
  }, [rt, framing]);

  /*
   * Three things this scene has claimed in a comment for three rounds, asserted instead.
   *
   * They run once per framing, in DEV only, and they are deliberately the three the audit had
   * to use screenshots for: whether the pile levitates (B6.2), whether the set can be framed
   * (B6.4), and whether the world contradicts the registry (A15). A `console.error` names the
   * number; a comment did not.
   */
  useEffect(() => {
    if (!import.meta.env.DEV) return;

    /* --- B6.2: every slot rests on the floor, the rim or another slot --- */
    const slots = pileSlots(framing.basketW);
    const innerHalfW = framing.basketW / 2 - WALL;
    for (let i = 0; i < PILE_SLOTS; i++) {
      const support = pileSupport(slots, i, framing.basketW);
      if (support === -2) {
        console.error(
          `[tooth-rescue/scene] pile slot ${i} at (${slots.x[i].toFixed(3)}, ${slots.y[i].toFixed(3)}, ` +
            `${slots.z[i].toFixed(3)}) is levitating or overlapping — the drop solve in ` +
            `layout.ts: pileSlots is the only thing that may place it (B6.2).`
        );
      }
      const overX = Math.abs(slots.x[i]) + PILE_A - Math.max(innerHalfW, framing.basketW / 2);
      const overZ = Math.abs(slots.z[i]) + PILE_A - BASKET_D / 2;
      if (overX > 1e-3 || overZ > 1e-3) {
        console.error(
          `[tooth-rescue/scene] pile slot ${i} pushes ${Math.max(overX, overZ).toFixed(4)} units ` +
            `past the tub's silhouette (B6.2).`
        );
      }
    }

    /* --- B6.4: no edge of the set may be inside the frame --- */
    const setHalf = Math.max(framing.nicheHalfX + 0.5, framing.wallHalfX + 0.6);
    const edges: [string, number, number, number][] = [
      ["alcove shell side", setHalf, SET_BASE_Y, NICHE_MOUTH_Z],
      ["alcove shell top", 0, framing.wallTop + 0.4, NICHE_MOUTH_Z],
      ["shelf mat far corner", framing.matHalfX, STAGE_Y, framing.matFar],
      ["shelf mat near corner", framing.matHalfX, STAGE_Y, framing.matNear + 0.4],
      ["plinth end", setHalf, STAGE_Y + 0.3, FRAME_Z + 0.12],
    ];
    for (const [label, x, y, z] of edges) {
      const p = projectNdc(framing, x, y, z);
      if (p !== null && Math.abs(p[0]) <= SET_EDGE_MARGIN && Math.abs(p[1]) <= SET_EDGE_MARGIN) {
        console.error(
          `[tooth-rescue/scene] the ${label} projects to ndc (${p[0].toFixed(3)}, ${p[1].toFixed(3)}) — ` +
            `inside the frame. G-TRS-4 / B6.4: no edge of the set may be framed at any viewport.`
        );
      }
    }
    // The opening's reveal is the one edge that is *meant* to be visible — but never on the
    // frame's own edge, where it clips instead of reading. See `layout.ts: REVEAL_INSIDE_NDC`.
    const reveal = projectNdc(framing, framing.nicheHalfX, BASKET_H + 0.3, NICHE_MOUTH_Z);
    if (reveal !== null && Math.abs(reveal[0]) > 0.88 && Math.abs(reveal[0]) < 1.12) {
      console.error(
        `[tooth-rescue/scene] the alcove's reveal projects to ndc.x ${reveal[0].toFixed(3)}, in the ` +
          `0.88-1.12 band where an edge clips rather than reads (B6.4).`
      );
    }

    /* --- A15: the 3D world agrees with the registry --- */
    const audit = auditSceneAccents(sceneAccentHexes(), REGISTRY_ACCENT);
    if (!audit.matchesRegistry) {
      console.error(
        `[tooth-rescue/scene] the scene's accent hexes are dominated by "${audit.dominant}" but the ` +
          `registry says "${REGISTRY_ACCENT}" (A15). Shares: ` +
          Object.entries(audit.share)
            .map(([k, v]) => `${k} ${(v * 100).toFixed(0)}%`)
            .join(", ")
      );
    }
  }, [framing]);

  // Adopt the engine's press count rather than assuming zero, so a remount can never open
  // with a phantom kick from presses that happened before this scene existed.
  useLayoutEffect(() => {
    rt.presses = engine.presses;
  }, [rt, engine]);

  useLayoutEffect(() => {
    const mesh = weaveRef.current;
    if (!mesh) return;
    const data = weaveLayout(framing.basketW);
    const albedo = ensureInstanceAlbedo(weaveGeo, WEAVE_MAX);
    const live = weaveCount(framing.basketW);
    const cane = color(CLAY.ivory);
    const grip = color(ACCENTS.red.main);
    for (let i = 0; i < live; i++) {
      const o = i * 7;
      _pos.set(data[o], data[o + 1], data[o + 2]);
      _scl.set(data[o + 3], data[o + 4], data[o + 5]);
      _m.compose(_pos, _identity, _scl);
      mesh.setMatrixAt(i, _m);
      writeAlbedo(albedo, i, data[o + 6] === WEAVE_TINT_CANE ? cane : grip);
    }
    mesh.count = live;
    mesh.instanceMatrix.needsUpdate = true;
    albedo.needsUpdate = true;
  }, [framing.basketW, weaveGeo]);

  /* ---------------- instance buffers ---------------- */

  useLayoutEffect(() => {
    const zero = new Matrix4().makeScale(0, 0, 0);
    const meshes = [toothRef.current, candyRef.current, endRef.current, blobRef.current, sparkRef.current];
    for (const mesh of meshes) {
      if (!mesh) continue;
      mesh.instanceMatrix.setUsage(DynamicDrawUsage);
      // InstancedMesh starts life with identity matrices, which would park a full-size
      // prop at the origin until the first spawn. Collapse them all up front, then let
      // `count` do the real work of keeping them out of the pipeline.
      for (let i = 0; i < mesh.instanceMatrix.count; i++) mesh.setMatrixAt(i, zero);
      mesh.instanceMatrix.needsUpdate = true;
      mesh.count = 0;
    }
    // Allocated here so the per-spawn recolour inside `useFrame` only ever writes. Never
    // `setColorAt`: `instanceColor` is multiplied into the curvature attribute the clay
    // shader extrapolates by 1.45, which is what drove this game's candy off-token (S2).
    candyAlbedo.current = ensureInstanceAlbedo(candyGeo, CANDY_POOL);
    endAlbedo.current = ensureInstanceAlbedo(candyEndGeo, CANDY_POOL * 2);
  }, [candyGeo, candyEndGeo]);

  /* ---------------- collisions ---------------- */

  useEffect(() => {
    rt.world.onCollision((body, withKind, impact) => {
      const item = body.userData.item as Item | undefined;
      if (!item) return;
      if (withKind === "ground") {
        if (item.state === S_FALL) {
          item.hitGround = impact;
          item.state = S_LOOSE;
          item.timer = item.kind === KIND_TOOTH ? REST_TOOTH : REST_CANDY;
        } else if (item.state === S_LOOSE && impact > item.hitGround) {
          item.hitGround = impact;
        }
        return;
      }
      if (item.kind === KIND_TOOTH) {
        if (item.state !== S_FALL) return;
        // The well floor is the catch. Anything else the assembly can be touched by, while
        // the tooth is *not* over the mouth, is a clipped edge — and it is knocked clear here
        // rather than being left to settle on the rim. See `deflectOffBasket` for what that
        // used to produce. A tooth that is over the mouth and brushing an inner wall face on
        // its way down is left alone: the floor is one substep away.
        if (withKind === "basket-floor") item.hitBasket = impact;
        else if (!overMouth(rt, body)) deflectOffBasket(rt, item);
        return;
      }

      /*
       * **B6.7.** The item says the comic ejection "fires from the rim collision callback" and
       * that a sweet dropping cleanly through the mouth "lands on the floor collider and rests
       * there among the teeth". The first half is a misreading of the code — there is one call
       * site, and its guard was `insideBasket`, which is true of the floor collider, so a clean
       * drop *was* ejected. But the item's picture is real, and the path that produces it is
       * the one nobody was looking at: a sweet that has **already** been ejected is `S_LOOSE`,
       * and `S_LOOSE` fell through the `state !== S_FALL` guard at the top of this callback —
       * so a rebound that landed back in a basket the child had chased under it simply sat
       * there for the whole `REST_CANDY` second and three-quarters, in the pile's own space,
       * exactly as photographed in `tooth-rescue-catch-f12/f13.png`.
       *
       * Both halves are closed. The floor collider is named explicitly, so the guarantee no
       * longer depends on one predicate staying generous; and a loose sweet that touches the
       * basket hops out again at a fraction of the kick, on the clock it already had.
       * "Sweets bounce back out" is now true of every path, which is what
       * `ToothRescue.tsx:143` has been promising the child.
       */
      if (!(withKind === "basket-floor" || overMouth(rt, body) || insideBasket(rt, body))) return;
      if (item.state === S_FALL) {
        item.hitBasket = impact;
        ejectCandy(rt, item, isReduced());
      } else if (item.state === S_LOOSE) {
        ejectCandy(rt, item, isReduced(), EJECT_REBOUND, true);
      }
    });
    // `PhysicsWorld` keeps its listeners for the life of the world, and the world lives
    // exactly as long as this component — there is nothing to unsubscribe.
  }, [rt]);

  /* ---------------- engine events ---------------- */

  useEffect(
    () =>
      engine.on((event) => {
        if (event.type === "spawn") spawn(rt, event, isReduced());
        else if (event.type === "reset") freeAll(rt);
      }),
    [engine, rt]
  );

  /* ---------------- the frame ---------------- */

  useFrame((state, delta) => {
    const root = rootRef.current;
    const bodyGroup = bodyRef.current;
    const teethMesh = toothRef.current;
    const candyMesh = candyRef.current;
    const endMesh = endRef.current;
    const blobMesh = blobRef.current;
    if (!root || !bodyGroup || !teethMesh || !candyMesh || !endMesh || !blobMesh) return;

    const dt = safeDelta(delta);
    const idt = dt > 1e-4 ? 1 / dt : 0;
    const reduced = isReduced();
    const world = rt.world;
    const all = rt.all;

    /* --- 1. rules clock. Spawns arrive synchronously through the subscription. --- */
    engine.update(dt);

    /* --- 2. the basket follows the child's aim --- */
    const limit = rt.playHalf + BASKET_EDGE_SLACK;
    rt.basket.to(clamp(engine.aimX * rt.playHalf, -rt.playHalf, rt.playHalf));
    rt.basket.step(dt);
    if (rt.basket.velocity > BASKET_MAX_SPEED) rt.basket.velocity = BASKET_MAX_SPEED;
    else if (rt.basket.velocity < -BASKET_MAX_SPEED) rt.basket.velocity = -BASKET_MAX_SPEED;

    const bx = clamp(rt.basket.value, -limit, limit);
    const vx = (bx - rt.prevX) * idt;
    let ax = (vx - rt.prevV) * idt;
    if (ax > MAX_ACCEL) ax = MAX_ACCEL;
    else if (ax < -MAX_ACCEL) ax = -MAX_ACCEL;
    rt.prevX = bx;
    rt.prevV = vx;
    rt.basketX = bx;

    // The press answers before anything else in the frame, so a `pointerdown` is visible
    // on the very next presented frame (3D-SPEC §4).
    if (engine.presses !== rt.presses) {
      rt.presses = engine.presses;
      rt.wobble.impulse(0, PRESS_KICK, 0);
    }

    root.position.set(bx, STAGE_Y, 0);
    /*
     * The celebration hand-off.
     *
     * Since A10, `GameShell` publishes the shared burst into **this scene's own `<View>`**
     * (`view-slot.tsx` → `Scene3D`), so there is one camera, one depth buffer and one rig;
     * this scene keeps rendering behind it — deliberately, so the child stays in the room
     * they were playing in.
     *
     * **B6.3(c): the basket and its pile no longer go with it.** They used to: `root.scale`
     * took `celebrationHeroScale()` and the tub, the weave and every caught tooth shrank to
     * nothing over `CELEBRATION_EXIT_SECONDS`. `tooth-rescue-keyboard-end.png` is what that
     * produces — "Great job, Maya!" over an empty shelf and a bare wall, with the thing the
     * child spent thirty seconds filling deleted at the exact moment it is being congratulated
     * for. The heap **is** the trophy; the celebration is about it, so it stays, and the
     * podium the shared burst places lands on a full basket rather than on bare clay.
     *
     * What still clears is the **air**: anything mid-flight, and the loaded chute. Those are
     * the game continuing, not the child's work, and leaving a tooth falling through a
     * celebration is the one thing that would read as the run not having finished. A10's
     * contract asks `store.ts` for a second channel that keeps a game's work at 1 while the
     * hero yields; until that lands, this scene simply does not hand its work over — which is
     * the same answer, expressed locally, and it needs nothing outside this file.
     */
    const exit = celebrationHeroScale();
    const flight = flightRef.current;
    if (flight) flight.scale.set(exit, exit, exit);
    syncColliders(rt);

    /* --- 3. re-park retired bodies, then simulate --- */
    for (let i = 0; i < all.length; i++) {
      const item = all[i];
      if (item.state !== S_FREE) continue;
      // Defensive: `addPlane` / `addBox` wake every body, and a woken garage body would
      // fall forever. One assignment a frame makes that impossible.
      const b = item.body;
      if (!b.sleeping) {
        b.sleeping = true;
        b.velocity.set(0, 0, 0);
        b.position.set(0, GARAGE_Y, 0);
      }
    }
    world.step(dt);

    /* --- 4. consume contacts --- */
    for (let i = 0; i < all.length; i++) {
      const item = all[i];
      if (item.hitBasket > 0) {
        const impact = item.hitBasket;
        item.hitBasket = 0;
        if (item.kind === KIND_TOOTH && item.state === S_FALL) {
          if (rt.piled < PILE_SLOTS) {
            const b = item.body;
            const hx = b.position.x;
            const hz = b.position.z;
            item.state = S_PILE;
            item.pile = rt.piled++;
            item.home.set(hx - bx, b.position.y - STAGE_Y, hz);
            item.home.x.velocity = b.velocity.x - vx;
            // The solver has already deadened the real landing velocity against the clay
            // floor, so the weight is put back deliberately: a downward kick into an
            // over-damped Y channel, which dips a few millimetres into the clay and
            // recovers without ever overshooting *up* through the pile.
            item.home.y.velocity = -Math.min(impact, 8) * 0.3;
            item.home.z.velocity = b.velocity.z;
            item.squash.impulse(impactSquash(impact, 0.9) * 12);
            const slot = rt.slots;
            _euler.set(slot.lean[item.pile], slot.yaw[item.pile], slot.lean[item.pile] * 0.6);
            item.rest.setFromEuler(_euler);
            item.resting = true;
            sleepBody(item);
            rt.wobble.impulse(0, impact * CATCH_KICK, 0);
            burst(rt.sparkles, hx, STAGE_Y + RIM_Y + 0.16, hz, reduced ? 3 : 7, reduced);
            sounds.sparkle();
            engine.registerCatch();
            syncColliders(rt);
          } else {
            // Pile full (only reachable during the finish hold). No penalty, no drama —
            // the tooth simply hops back out onto the table and away.
            item.state = S_LOOSE;
            item.timer = REST_TOOTH;
          }
        } else if (item.kind === KIND_CANDY) {
          rt.wobble.impulse(
            (item.body.position.x - bx) * 0.5,
            impact * CATCH_KICK * CANDY_KICK_SCALE,
            0
          );
          item.squash.impulse(impactSquash(impact, 0.9) * 9);
          sounds.oops();
          engine.registerBounce();
        }
      }

      if (item.hitGround > 0) {
        const impact = item.hitGround;
        item.hitGround = 0;
        item.squash.impulse(impactSquash(impact, 0.9) * 10);
        if (item.kind === KIND_TOOTH) {
          // The solver adds spin on every impact. A tooth has a face, so it is damped hard
          // and allowed to settle back to a near-front-on rest instead of rolling away.
          item.body.angularVelocity.multiplyScalar(0.12);
        }
        if (!item.resting) {
          item.resting = true;
          if (item.kind === KIND_TOOTH) {
            _euler.set(0.12, (item.seed - 0.5) * 0.7, (item.seed - 0.5) * 0.4);
          } else {
            _euler.set(0, item.seed * Math.PI * 2, 0);
          }
          item.rest.setFromEuler(_euler);
        }
        if (item.kind === KIND_TOOTH) sounds.pop();
      }
    }

    /* --- 5. advance every item and write its instance matrix --- */
    if (rt.wobbleDirty) {
      rt.wobbleDirty = false;
      bodyGroup.rotation.set(0, 0, 0);
      bodyGroup.scale.set(1, 1, 1);
      rt.wobble.reset();
    }
    rt.wobble.applyAcceleration(reduced ? ax * 0.5 : ax, 0, 0);
    rt.wobble.update(dt);
    rt.wobble.apply(bodyGroup);
    const wq = bodyGroup.quaternion;
    const wsx = bodyGroup.scale.x;
    const wsy = bodyGroup.scale.y;
    const wsz = bodyGroup.scale.z;

    const slots = rt.slots;
    const poofDur = reduced ? POOF_DUR_REDUCED : POOF_DUR;
    // Reduced motion gets no sway at all: a falling tooth still falls, because that is the
    // game, but it falls dead upright and front-on. No idle rocking (3D-SPEC §4).
    const swayTilt = reduced ? 0 : SWAY_TILT;
    const swayRate = reduced ? 0 : SWAY_RATE;

    // Where the next catch will come to rest. See `catchPlaneY`.
    const catchY = catchPlaneY(rt);

    // Live instance counts. G-TRS-3: the pools used to be submitted whole, every frame,
    // with `frustumCulled={false}` — 176,608 triangles at rest with nothing in flight.
    // Everything at or above these indices is parked at scale zero, so dropping it costs
    // nothing and saves it twice, once per pass.
    let toothCount = 0;
    let candyCount = 0;
    let blobCount = 0;

    for (let i = 0; i < all.length; i++) {
      const item = all[i];
      const b = item.body;
      let blobSize = 0;
      let blobX = 0;
      let blobZ = 0;

      if (item.state !== S_FREE) {
        item.age += dt;
        if (item.kind === KIND_TOOTH) {
          if (item.slotIndex + 1 > toothCount) toothCount = item.slotIndex + 1;
        } else if (item.slotIndex + 1 > candyCount) {
          candyCount = item.slotIndex + 1;
        }
      }

      if (item.state === S_PILE) {
        const p = item.pile;
        item.home.to(slots.x[p], slots.y[p], slots.z[p]);
        if (!reduced) item.home.x.impulse(-ax * PILE_SLOSH * dt);
        item.home.step(dt);
        item.home.x.value = clamp(item.home.x.value, -rt.innerHalfW, rt.innerHalfW);
        item.home.z.value = clamp(item.home.z.value, -INNER_HALF_D, INNER_HALF_D);
        _off.set(item.home.x.value * wsx, item.home.y.value * wsy, item.home.z.value * wsz);
        _off.applyQuaternion(wq);
        _pos.set(bx + _off.x, STAGE_Y + _off.y, _off.z);
        b.quaternion.slerp(item.rest, 1 - Math.exp(-11 * dt));
        _q.copy(wq).multiply(b.quaternion);
      } else if (item.state === S_FREE) {
        _pos.set(0, GARAGE_Y, 0);
        _q.copy(_identity);
      } else {
        _pos.copy(b.position);
        if (item.kind === KIND_TOOTH && item.state === S_FALL) {
          /*
           * The tumble is the body's own; what is authored is the **face**, and only over
           * the last `FACE_ON_TIME` of the fall. `blend` is 0 while the tooth is more than
           * that far from the catch plane and 1 once it is there or past it, so the same
           * hand-off works on a level that drops from rest and on one thrown down at
           * 2.26 u/s. Under reduced motion it is pinned to 1 and this is round 2's
           * behaviour byte for byte: no spin at spawn, pose written every frame.
           */
          const fall = -b.velocity.y;
          // A tooth that is barely moving down is not about to arrive — the first frames of
          // an Easy drop start from rest — so the blend is held off rather than dividing by
          // nothing. Below the catch plane (a miss, on its way to the shelf) `tta` goes
          // negative and the blend saturates, which is what lands it face-on there too.
          const tta = fall > 0.35 ? (_pos.y - catchY) / fall : FACE_ON_TIME;
          const blend = reduced ? 1 : 1 - clamp01(tta / FACE_ON_TIME);
          if (blend > 0) {
            _euler.set(
              SWAY_LEAN,
              (item.seed - 0.5) * SWAY_YAW,
              Math.sin(item.age * swayRate + item.seed * 6.283) * swayTilt
            );
            _q.setFromEuler(_euler);
            if (reduced) {
              b.quaternion.copy(_q);
            } else {
              b.angularVelocity.multiplyScalar(Math.exp(-FACE_ON_SPIN_DAMP * blend * dt));
              b.quaternion.slerp(_q, 1 - Math.exp(-FACE_ON_SLERP * blend * dt));
            }
          }
        } else if (item.resting && (b.sleeping || b.velocity.lengthSq() < 1.4)) {
          b.quaternion.slerp(item.rest, 1 - Math.exp(-9 * dt));
        }

        if (item.state === S_FALL) {
          /*
           * B6.6: roll and pitch are clamped on the **orientation**, every frame, for every
           * falling prop with a face. A clamp on angular velocity still integrates to a full
           * turn; this one cannot. `YXZ` puts yaw in `.y`, so the tumble the solver produces
           * survives intact and only the two axes that can invert a face are bounded. The
           * clamped quaternion is written back to the body, so the solver carries the bound
           * forward as well.
           */
          if (item.kind === KIND_TOOTH) {
            _euler.setFromQuaternion(b.quaternion, "YXZ");
            const px = clamp(_euler.x, -TUMBLE_PITCH_MAX, TUMBLE_PITCH_MAX);
            const rz = clamp(_euler.z, -TUMBLE_ROLL_MAX, TUMBLE_ROLL_MAX);
            if (px !== _euler.x || rz !== _euler.z) {
              _euler.set(px, _euler.y, rz, "YXZ");
              b.quaternion.setFromEuler(_euler);
            }
            _euler.order = "XYZ";
          }
          /*
           * B6.2: a falling body that has stopped falling has come to rest on something that
           * is not a catch — the rim ledge, the outside of a wall, a collider edge — and must
           * never simply stay there. This is the guarantee that does not depend on which
           * collider it found: it retires the body wherever it is, and the ordinary `S_LOOSE`
           * clock then hops it away.
           */
          if (b.sleeping || b.velocity.y > -FALL_STALL_SPEED) item.stall += dt;
          else item.stall = 0;
          if (item.stall > FALL_STALL && item.age > FALL_STALL) {
            item.state = S_LOOSE;
            item.timer = item.kind === KIND_TOOTH ? REST_TOOTH : REST_CANDY;
            item.stall = 0;
          }
        }
        _q.copy(b.quaternion);
        if (item.state === S_FALL) {
          const h = _pos.y - STAGE_Y;
          blobSize = BLOB_MIN + BLOB_GROW * clamp01(h / BLOB_FALL_RANGE);
          blobX = _pos.x;
          blobZ = _pos.z;
        }
      }

      /* Lifecycle clocks. */
      if (item.state === S_LOOSE) {
        item.timer -= dt;
        if (item.timer <= 0) {
          item.state = S_POOF;
          item.timer = 0;
          burst(rt.sparkles, _pos.x, _pos.y + 0.1, _pos.z, reduced ? 2 : 4, reduced);
        }
      } else if (item.state === S_POOF) {
        item.timer += dt;
        const p = clamp01(item.timer / poofDur);
        // A friendly puff, not a deletion: it swells a little, then folds away.
        item.scale = reduced ? 1 - easeInCubic(p) : (1 + 0.22 * Math.sin(p * Math.PI)) * (1 - easeInCubic(p));
        if (p >= 1) {
          // Retired, but still written this frame at scale zero — skipping the write would
          // leave last frame's full-size matrix on screen for one frame.
          park(item);
          _pos.set(0, GARAGE_Y, 0);
        }
      }

      item.squash.to(0);
      item.squash.step(dt);
      squashFor(_sq, item.squash.value, 1, 0.28);

      const s = item.scale;
      if (item.kind === KIND_TOOTH) {
        _scl.set(TOOTH_SCALE * s * _sq.x, TOOTH_SCALE * s * _sq.y, TOOTH_SCALE * s * _sq.z);
        _m.compose(_pos, _q, _scl);
        _m.multiply(TOOTH_CENTRE);
        teethMesh.setMatrixAt(item.slotIndex, _m);
      } else {
        _scl.set(
          CANDY_STRETCH * s * _sq.x,
          CANDY_FLAT * s * _sq.y,
          CANDY_FLAT * s * _sq.z
        );
        _m.compose(_pos, _q, _scl);
        candyMesh.setMatrixAt(item.slotIndex, _m);
        _m.multiply(END_RIGHT);
        endMesh.setMatrixAt(item.slotIndex * 2, _m);
        _m.compose(_pos, _q, _scl);
        _m.multiply(END_LEFT);
        endMesh.setMatrixAt(item.slotIndex * 2 + 1, _m);
      }

      if (blobSize > 1e-4) {
        // Written compactly from index 0, so `count` is exactly the number of markers.
        _pos.set(blobX, STAGE_Y + 0.012, blobZ);
        _scl.set(blobSize, blobSize, 1);
        _m.compose(_pos, BLOB_QUAT, _scl);
        blobMesh.setMatrixAt(blobCount++, _m);
      }
    }

    /* --- 5b. the rest-state invitation: the landing marker under the chute mouth --- */
    /*
     * The perched tooth is gone (see the `PERCH_*` block); the marker it shared is not. It is
     * the same contact darkening every real drop carries, drawn on the shelf directly under the
     * chute mouth while the board is at rest, so the frame a child arrives at already says
     * "things land here". It fades over `PERCH_EXIT` once the run starts, which is shorter than
     * the engine's own 0.4 s to the first spawn, so the marker hands over to a real one.
     */
    {
      const exitDur = reduced ? PERCH_EXIT_REDUCED : PERCH_EXIT;
      if (engine.started || engine.completed) rt.perchGone = Math.min(1, rt.perchGone + dt / exitDur);
      const gone = rt.perchGone;
      if (gone < 1 && blobCount < BODY_POOL) {
        const out = reduced ? easeOutCubic(gone) : easeInCubic(gone);
        _pos.set(0, STAGE_Y + 0.012, 0);
        const bs = (BLOB_MIN + BLOB_GROW) * (1 - out);
        _scl.set(bs, bs, 1);
        _m.compose(_pos, BLOB_QUAT, _scl);
        blobMesh.setMatrixAt(blobCount++, _m);
      }
    }

    teethMesh.count = toothCount;
    candyMesh.count = candyCount;
    endMesh.count = candyCount * 2;
    blobMesh.count = blobCount;
    teethMesh.instanceMatrix.needsUpdate = true;
    candyMesh.instanceMatrix.needsUpdate = true;
    endMesh.instanceMatrix.needsUpdate = true;
    blobMesh.instanceMatrix.needsUpdate = true;

    /* --- 6. candy colours, only after a spawn --- */
    const cAlbedo = candyAlbedo.current;
    const eAlbedo = endAlbedo.current;
    if (rt.candyColorDirty && cAlbedo && eAlbedo) {
      rt.candyColorDirty = false;
      for (let i = 0; i < rt.candy.length; i++) {
        const item = rt.candy[i];
        const c = color(CANDY_HEX[item.variant % CANDY_HEX.length]);
        writeAlbedo(cAlbedo, i, c);
        writeAlbedo(eAlbedo, i * 2, c);
        writeAlbedo(eAlbedo, i * 2 + 1, c);
      }
      cAlbedo.needsUpdate = true;
      eAlbedo.needsUpdate = true;
    }

    const spark = sparkRef.current;
    if (spark) stepSparkles(rt.sparkles, spark, state.camera.quaternion, dt, reduced);
  });

  /* ---------------- graph ---------------- */

  return (
    <Rig shadowArea={framing.shadowArea} groundY={0}>
      {/*
        The set. Every extent here comes out of `solveFraming`, which solves where the
        frame's own edges cross each of these planes — so no piece of it can terminate in
        shot at any viewport, which is exactly what G-TRS-4 measured happening.

        Nothing in the set casts, and `set.ts`'s header carries the arithmetic for why:
        the studio key arrives from in *front* of the set, so every shadow it could throw
        lands behind itself, out of shot. The junctions are dissolved into one C2 surface
        and darkened by `bakeCurvatureAO` instead.
      */}
      <mesh geometry={alcoveGeo} material={alcoveMat} receiveShadow />
      {/* The chute mouth, and the one place the accent family sits high in the frame. */}
      <mesh
        geometry={railGeo}
        material={railMat}
        position={[0, framing.nicheTop + RAIL_H / 2 - 0.02, FRAME_Z]}
        receiveShadow
      />
      {/*
        The skirting. It runs past the frame on both sides (see `plinthGeo`) and stands
        proud of the wings, so every upright in the set meets the shelf behind it rather
        than in a bare line on the mat.
      */}
      <mesh
        geometry={plinthGeo}
        material={frameMat}
        position={[0, STAGE_Y + 0.15, FRAME_Z + 0.12]}
        receiveShadow
      />
      <mesh
        geometry={matGeo}
        material={matMat}
        rotation={FLAT_ROT}
        position={[0, MAT_T / 2, (framing.matNear + 0.4 + framing.matFar) / 2]}
        receiveShadow
      />

      <group ref={rootRef}>
        {/*
          Rides the basket, and deliberately sits *outside* the wobble group: the close
          contact darkening belongs to where the basket meets the mat, and must not lean or
          squash with the jelly above it.
        */}
        <ContactBlob position={[0, 0.008, 0]} radius={framing.basketW * 0.6} opacity={0.4} />
        {/*
          **B6.3(a): the in-world focus ring, and the only game in the product that did not
          have one.**

          Tooth Rescue's control surface is a `role="slider"` covering the whole play field
          rather than a `HitTarget`, because what a child moves here is a one-dimensional aim
          and not an object — so there was no collider for `HitTarget` to hang a ring on, and
          what a keyboard player got instead was a 6 px CSS band around the viewport rectangle
          (`focus-rings.json`: `tag: "DIV"`, against eight games showing an in-world ring).

          The ring marks the **basket**, because the basket is what the arrow keys move. It
          rides `rootRef`, so it tracks the tub across the lane exactly, and it sits outside
          `bodyRef` for the same reason the contact blob does: an indicator that squashes with
          the jelly is an indicator that changes size while a child is looking for it.

          `radius` is the marked object's silhouette radius, not a ring radius — A1 changed
          that contract this round, and half the tub's width is the right quantity: the ring
          lands at 1.00-1.05x the larger of that and the 48 px tap floor.
        */}
        <group position={[0, BASKET_H * 0.5, 0]}>
          <FocusRing visible={focused} radius={framing.basketW * 0.5} label="tooth-rescue/basket" />
        </group>
        <group ref={bodyRef}>
          <mesh geometry={basketGeo} material={basketMat} castShadow receiveShadow />
          {/*
            B6.8: the cane casts. The old comment said its shadow duplicated the tub's and
            cost "fourteen shadow-pass draws a frame" — an `InstancedMesh` is one draw call in
            the shadow pass whatever its instance count, and a stave standing `PROUD` off the
            wall throws its shadow *onto the wall*, which is the contact gradient at the join
            that the audit found missing. `bakeCurvatureAO` cannot supply it: it sees curvature
            only inside one welded mesh, and the staves are instances of a separate one (A14).
          */}
          <instancedMesh
            ref={weaveRef}
            args={[weaveGeo, weaveMat, WEAVE_MAX]}
            frustumCulled={false}
            castShadow
            receiveShadow
          />
        </group>
      </group>

      {/* Teeth, sweets and their contact darkening — the hand-off takes the lot. */}
      <group ref={flightRef}>
        <instancedMesh
          ref={toothRef}
          args={[toothGeo, toothMat, TOOTH_POOL]}
          frustumCulled={false}
          castShadow
          receiveShadow
        />
        <instancedMesh
          ref={candyRef}
          args={[candyGeo, candyMat, CANDY_POOL]}
          frustumCulled={false}
          castShadow
          receiveShadow
        />
        <instancedMesh
          ref={endRef}
          args={[candyEndGeo, candyMat, CANDY_POOL * 2]}
          frustumCulled={false}
        />
        <instancedMesh
          ref={blobRef}
          args={[quadGeo, blobMat, BODY_POOL]}
          frustumCulled={false}
          renderOrder={2}
        />
      </group>
      <instancedMesh
        ref={sparkRef}
        args={[quadGeo, sparkleMat, SPARKLES]}
        frustumCulled={false}
        renderOrder={6}
      />
    </Rig>
  );
}

/**
 * Memoised on the engine (whose identity never changes) and the framing (which changes
 * only on a resize), so the shell re-rendering its timer once a second never reaches the
 * 3D tree.
 */
export const ToothRescueScene = memo(ToothRescueSceneImpl);
