/**
 * Spot the Difference — the two panels.
 *
 * ## The one rule this file exists to enforce
 *
 * **The two panels must be pixel-identical except for the intended differences.** That is
 * not achieved by being careful; it is achieved by construction:
 *
 *  - There is **one** `<Scene3D>`, so there is one drei `<View>`, one virtual scene and one
 *    `PerspectiveCamera` instance. There is **one** `<Rig>`, so there is one key light, one
 *    environment, one fog and one shadow map.
 *  - That single scene is drawn **twice per frame from the same camera**, into two
 *    viewports, from one `useFrame` callback. Nothing runs between the two `gl.render`
 *    calls except the per-panel `visible` flags of the five difference props — no matrix
 *    changes, no camera changes, no material changes, no clock reads.
 *  - **`state.scene` here is this game's own subtree and nothing else.** Round 2 was
 *    reported as "Spot renders the entire R3F scene twice, including other games' Views" —
 *    it does not, and the reason is worth stating so nobody re-introduces the fear. This
 *    `useFrame` is registered *inside* drei's portal (`Scene3D` puts `children` inside
 *    `<View>`, and `View` does `createPortal(children, virtualScene)`), so the `state` it
 *    receives is the portal's, and its `scene` is that `<View>`'s private
 *    `THREE.Scene` — see `node_modules/@react-three/drei/web/View.js`, where `CanvasView`
 *    creates `virtualScene` per view and `Container` renders `children ? state.scene : scene`.
 *  - **`GameShell`'s celebration is now inside that same subtree, and the panel loop hides it
 *    for the two panel renders.** This comment used to say the opposite — that the celebration
 *    was a separate `<Scene3D>` with a separate virtual scene that "cannot be reached from
 *    here" — and `view-slot.tsx` made that false: one scene, one camera, one depth buffer and
 *    one `<Rig>` is the whole point of that change, and it is right. But it lands *this* game
 *    with a hazard no other game has: for the 0.24 s of the hand-off both loops are live, and
 *    a scene traversal drawn into two viewports would have drawn the hero's podium **twice,
 *    once inside each picture frame**. The panel loop therefore hides everything the view slot
 *    added, for exactly the span of its own two `gl.render` calls, and restores it afterwards
 *    — so the celebration is drawn once, full-frame, by drei's own render at priority 1, and
 *    the two shrinking rooms composite on top of it. Hiding rather than layer-masking is
 *    deliberate: `WebGLShadowMap` skips an invisible object too, so the hero cannot leak into
 *    the panels' shadow maps either. It is hidden identically for both panels, so it cannot
 *    make them disagree.
 *  - Both viewports are **exactly the same size in device pixels** (`layout.ts` solves one
 *    panel size and uses it twice), so one `camera.aspect` serves both and the projection
 *    matrix is literally the same object, untouched between the calls. Both rectangles are
 *    snapped to **even** device origins and even device extents, so a vertex lands on the
 *    same sub-pixel phase and on the same multisample resolve quad in both panels whatever
 *    the device pixel ratio is.
 *  - The view's own render at priority 1 has nothing of this game's to draw, because the
 *    world group is `visible = false` outside the two panel renders. During play that render
 *    therefore only clears; during the celebration it is what draws the hero, full-frame and
 *    at the view's own aspect, and the two shrinking rooms are then composited over it. The
 *    `Rig` sits *outside* that group — read the comment on the tree before moving it.
 *
 * ## Why the draw-call count is the number it is
 *
 * Two shaded traversals plus two shadow passes is three to four times what a single-picture
 * game pays, and it is not optional: the whole game *is* two pictures. So the room is built
 * to be cheap per traversal instead — `diorama.ts` merges every static prop that shares a
 * material into one mesh, which is why the surround, the counter-and-basin and the
 * shelf-and-rail are single draw calls. Round 2 measured **83** calls on the celebration
 * frame (§9's ceiling is 90 and the shared celebration has since grown), against roughly 77
 * in play; the merges take the play frame to roughly 69 and leave real headroom for the
 * celebration to composite over the two live pictures rather than replacing them.
 *
 * `?selftest=spot` reads the two live panel rectangles straight back off the drawing buffer
 * and pixel-diffs them, so any future drift fails loudly instead of quietly inventing a
 * sixth difference.
 *
 * ## Per-frame cost
 *
 * One `useFrame`. Zero allocations: every vector, quaternion, matrix and squash triple is a
 * module-level scratch, every loop is an indexed `for`, and the only `Math.random` in the
 * game runs inside the engine's deal. React renders once on mount and once per `deal` — the
 * scene never re-renders while the child is playing.
 */
import { memo, useCallback, useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import {
  Box3,
  Group,
  Matrix4,
  Object3D,
  Quaternion,
  Vector3,
  Vector4,
  type PerspectiveCamera,
  type WebGLRenderer,
} from "three";
import { ContactBlob, Rig } from "../../three/Rig";
import { HitTarget } from "../../three/hit";
import { celebrationHeroScale, isCelebrating, isReduced } from "../../three/store";
import { KEY_LIGHT } from "../../three/tokens";
import { FEEL, Spring, clamp01, easeOutBack, easeOutCubic, safeDelta, squashFor } from "../../three/anim";
import { DIFFS, type SpotEngine } from "./engine";
import {
  BACK_Z,
  BADGES,
  BADGE_R,
  CABINET_Z,
  CUP_Z,
  FLOOR_Y,
  GROUND_Y,
  INNER_X,
  INNER_Y,
  MARK_Z,
  MIN_TAP_PX,
  RECEIVER_Y,
  SPOTS,
  type PanelLayout,
  type Spot,
} from "./layout";
import { BADGE_SLOTS, RIPPLE_SLOTS, buildDiorama, type Diorama } from "./diorama";

/* ------------------------------------------------------------------ */
/* Frame ordering                                                      */
/* ------------------------------------------------------------------ */

/**
 * Strictly after drei's `<View>` (index 1, which draws an empty scene because the world is
 * hidden) and strictly before `GameShell`'s celebration depth reset (priority 2) so the
 * celebration still composites over the panels.
 */
const PANEL_PRIORITY = 1.5;

/**
 * Holds the shadow map across drei's own `<View>` render, and nothing else.
 *
 * The rig's key light lives outside the hidden world group (see the tree, at the bottom of
 * this file), so `<View>`'s render at priority 1 now has a light to gather even though it
 * has nothing visible to draw — and three re-renders a light's shadow map on *every*
 * `gl.render`. That would be a full shadow-map bind and clear per frame, thrown away by the
 * two panel renders half a millisecond later. Freezing the map for that one call skips it;
 * the panel loop switches updates back on before it draws anything.
 *
 * **The hold is now conditional, and that is not a tuning choice.** It used to end with "so
 * `GameShell`'s celebration (priority 3) still gets its own shadows in full", which was true
 * only while the celebration had a `<Scene3D>` of its own. Since `view-slot.tsx` the
 * celebration is drawn by *this* view's render at priority 1 — precisely the render this hold
 * was built to make cheap — so an unconditional hold would have frozen the hero's shadow map
 * at whatever the last panel render left in it (the room, with the hero hidden) and then never
 * updated it again, for the whole celebration. Holding only while nothing is celebrating keeps
 * the saving for the 99 % of frames that are play, and costs one extra shadow pass per frame
 * for the 0.24 s of hand-off, after which the panel loop stops and the count drops to one.
 */
const SHADOW_HOLD_PRIORITY = 0.9;

/* ------------------------------------------------------------------ */
/* Feel                                                                */
/* ------------------------------------------------------------------ */

/** Scale a found prop jumps to before springing back — the "happy pop". */
const POP_SCALE = 1.24;
const POP_SCALE_REDUCED = 1.09;
/**
 * The pop's wind-up: how long the prop squashes *down* before it jumps, and how far.
 *
 * Round 2 shipped the pop as `anim.pop.value = POP_SCALE` — a one-frame jump from 1.00 to
 * 1.24 with no anticipation at all, on the single most important moment in the game.
 * `3D-SPEC §4` asks for a 50–80 ms opposite dip on anything a child touches; 60 ms to 0.96
 * costs nothing and is what makes the jump land as a reward rather than as a pop-in.
 * Suppressed under reduced motion, where the whole point is not to move first.
 */
const POP_WIND_UP = 0.06;
const POP_DIP = 0.96;
/** How long the found badge takes to pop in. */
const RING_IN = 0.42;
/** One "oops" ripple, and the delay between its three rings. */
const RIPPLE_LIFE = 0.55;
const RIPPLE_STAGGER = 0.09;
const RIPPLE_MAX = 0.46;
/** Idle bob on the duck. Sub-centimetre; switched off entirely under reduced motion. */
const BOB_AMPLITUDE = 0.022;
const BOB_SPEED = 1.35;

/**
 * The idle nudge — the game's terminator. See `NUDGE_DELAY` in `engine.ts` for when it fires.
 *
 * A child who cannot find the last difference had no way out of this game: there is no timer,
 * no hint and no lose state, and `finish()` is reachable only by finding every one. That is
 * the right shape (nothing here may ever be punitive) with one piece missing — a run that can
 * fail to end. So after 45 s without progress, one still-unfound prop swells and settles.
 *
 * Sized to be *noticed and not startling*: 0.055 is 23 % of the 0.24 the reward pop travels,
 * and it goes through the same volume-preserving `squashFor`, so the prop swells the way
 * everything else in this game does rather than in a way a child has to learn. Slow, too —
 * 1.4 s for one rise and fall, against the reward pop's ~0.4 s — because a hint that snaps
 * reads as a reward and a child would go and tap the thing that just congratulated them.
 *
 * Under reduced motion it is smaller and shorter but it still happens: §4 asks for less
 * movement, not for a hint that only sighted-and-unbothered children get. The screen-reader
 * half is `announce`d by the shell on the same event.
 */
const NUDGE_SCALE = 0.055;
const NUDGE_SCALE_REDUCED = 0.038;
const NUDGE_LIFE = 1.4;
const NUDGE_LIFE_REDUCED = 0.9;

/* ------------------------------------------------------------------ */
/* Module scratch — nothing below allocates inside a frame              */
/* ------------------------------------------------------------------ */

const _vp = new Vector4();
const _prevVp = new Vector4();
const _prevSc = new Vector4();
const _mat = new Matrix4();
const _pos = new Vector3();
const _scl = new Vector3();
const _quat = new Quaternion();
const _ray = new Vector3();
const _dir = new Vector3();
const _hit = new Vector3();
const _squash = { x: 1, y: 1, z: 1 };

/**
 * A CSS-pixel measurement rounded to an **even** device pixel.
 *
 * Module level, not a closure inside `useFrame`: an arrow function declared in a frame
 * callback is one allocation per frame per call site, which is exactly the thing §9 forbids
 * and the thing the round-2 sweep of this file happened not to catch.
 */
function evenDevicePx(cssPx: number, dpr: number): number {
  const d = Math.round(cssPx * dpr);
  return d - (d & 1);
}

/**
 * Runs `body` with the **panel's** projection installed on the shared camera, then puts the
 * camera back exactly as it was found.
 *
 * Three things need this and all three run between frames, never inside one: turning a tap
 * into a prop (`pick`), turning a tap into a world point for the "oops" ripple, and the self
 * test's `expectedBoxes`. Each of them is reasoning in *panel* pixels, and the camera spends
 * the gaps between frames carrying the *view's* aspect — see the note where the panel loop
 * hands it back. The closure this allocates is one per tap and one per self-test call; the
 * frame path never comes near it.
 */
function withPanelProjection<T>(camera: PerspectiveCamera, aspect: number, body: () => T): T {
  const previous = camera.aspect;
  const swap = aspect > 0 && previous !== aspect;
  if (swap) {
    camera.aspect = aspect;
    camera.updateProjectionMatrix();
  }
  try {
    return body();
  } finally {
    if (swap) {
      camera.aspect = previous;
      camera.updateProjectionMatrix();
    }
  }
}

const KEY_DIR = new Vector3(
  KEY_LIGHT.position[0],
  KEY_LIGHT.position[1],
  KEY_LIGHT.position[2]
).normalize();

/* ------------------------------------------------------------------ */
/* Animation state                                                     */
/* ------------------------------------------------------------------ */

type DiffAnim = {
  /** Settles to 1. Kicked to `POP_SCALE` once the wind-up has finished. */
  pop: Spring;
  /** 0..1 opening progress of the found badge. */
  ringT: number;
  found: number;
  /** Seconds remaining in the anticipation dip; 0 once the prop has actually popped. */
  windT: number;
};

type RippleState = {
  t: number;
  alive: number;
  /** 0 or 1 for a tap in that panel, -1 for a keyboard check (both panels). */
  panel: number;
  x: number;
  y: number;
  z: number;
};

/**
 * The idle nudge, and what the instanced ring buffer was last written for.
 *
 * One object with a stable identity, read and written from `useFrame` and never re-created,
 * so the frame path can carry three more pieces of state without three more parameters and
 * without allocating.
 */
type SpotRuntime = {
  ripple: RippleState;
  /** `index` is the difference being pointed at, `t` counts the swell down. -1 = nothing. */
  nudge: { t: number; index: number };
  /**
   * The camera pose the five badge matrices were last composed against, and whether they
   * have ever been written. See the write gate in `stepScene`.
   */
  ring: {
    written: number;
    px: number;
    py: number;
    pz: number;
    qx: number;
    qy: number;
    qz: number;
    qw: number;
  };
};

function createRuntime(): SpotRuntime {
  return {
    ripple: { t: 0, alive: 0, panel: -1, x: 0, y: 0, z: MARK_Z },
    nudge: { t: 0, index: -1 },
    ring: { written: 0, px: 0, py: 0, pz: 0, qx: 0, qy: 0, qz: 0, qw: 0 },
  };
}

function createAnims(): DiffAnim[] {
  const out: DiffAnim[] = [];
  for (let i = 0; i < DIFFS.length; i++) {
    out.push({
      pop: new Spring(1, FEEL.settle.stiffness, FEEL.settle.damping),
      ringT: 0,
      found: 0,
      windT: 0,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Self-test handle                                                    */
/* ------------------------------------------------------------------ */

export type SpotCapture = { width: number; height: number; a: Uint8Array; b: Uint8Array };

export type ExpectedBox = { index: number; x0: number; y0: number; x1: number; y1: number };

/** A projected circle in panel/readback pixels. */
export type MarkCircle = { x: number; y: number; r: number };

/**
 * Where a found badge lands relative to the prop it marks, in the panel's own pixels.
 *
 * This is the number SD2 turns on. The old marker was a `rose.deep` annulus drawn *over* the
 * prop, and the argument that the new one sits *beside* it is worth exactly as much as a
 * measurement of the shipped projection — so `?selftest=spot` takes one.
 */
export type MarkProbe = { index: number; badge: MarkCircle; prop: MarkCircle };

export type SpotHandle = {
  /** Freezes idle motion and clears every ring/ripple so a capture is reproducible. */
  setTestMode: (on: boolean) => void;
  /**
   * Resolves with the two live panel rectangles, read straight off the drawing buffer at
   * the end of the next frame. `"aa"` renders panel B with panel A's visibility — the
   * control that proves nothing but the intended toggles can differ.
   */
  capture: (mode: "ab" | "aa") => Promise<SpotCapture>;
  /** Drops a capture that will never be fulfilled, so a timed-out test can try again. */
  cancelCapture: () => void;
  /** Where each active difference is allowed to change pixels, in readback coordinates. */
  expectedBoxes: (width: number, height: number) => ExpectedBox[];
  /** Found badge vs. its own prop, projected into a `width` x `height` panel. */
  markProbes: (width: number, height: number) => MarkProbe[];
  layout: PanelLayout;
  /** The live engine — the test needs a deterministic board, not a random subset. */
  engine: SpotEngine;
};

let liveHandle: SpotHandle | null = null;
/** `null` until the scene is mounted and has rendered at least one frame. */
export const spotHandle = (): SpotHandle | null => liveHandle;

type CaptureJob = {
  mode: "ab" | "aa";
  resolve: (capture: SpotCapture) => void;
  reject: (error: unknown) => void;
};

/* ------------------------------------------------------------------ */
/* Per-panel visibility                                                */
/* ------------------------------------------------------------------ */

/**
 * The entire difference between the two panels, in six lines.
 *
 * A difference that is not in this run shows its "A" objects in *both* panels, so the
 * pictures stay identical there. A difference that is in play shows A on the left and B on
 * the right. Nothing else in the scene is ever touched between the two renders.
 */
function applyPanel(diorama: Diorama, engine: SpotEngine, panel: number, ripple: RippleState): void {
  const mask = engine.activeMask;
  const diffs = diorama.diffs;
  for (let i = 0; i < diffs.length; i++) {
    const live = mask[i] === 1;
    diffs[i].a.visible = panel === 0 || !live;
    diffs[i].b.visible = panel === 1 && live;
  }
  diorama.ripples.visible =
    ripple.alive === 1 && (ripple.panel < 0 || ripple.panel === panel);
}

/* ------------------------------------------------------------------ */
/* Scene                                                               */
/* ------------------------------------------------------------------ */

export type SpotSceneProps = {
  engine: SpotEngine;
  layout: PanelLayout;
  /**
   * `minScreenPx` for every `HitTarget`, already compensated for the fact that this game
   * draws into a panel rather than into the whole play area. See `layout.ts::tapScreenPx`.
   * Changes only when the panels are re-solved — never per frame — so this stays outside the
   * memo's identity guarantee for the play loop.
   */
  tapPx: number;
};

export const SpotScene = memo(function SpotScene({
  engine,
  layout,
  tapPx,
}: SpotSceneProps): JSX.Element {
  const worldRef = useRef<Group>(null);
  const cameraRef = useRef<PerspectiveCamera | null>(null);
  const jobRef = useRef<CaptureJob | null>(null);
  const testModeRef = useRef(false);

  const diorama = useMemo(() => buildDiorama(), []);
  const anims = useMemo(() => createAnims(), []);
  const rt = useMemo(() => createRuntime(), []);
  /**
   * The scene's own children, and anything `view-slot.tsx` has added on top of them.
   *
   * Refs rather than state: they are read and written only from `useFrame`, and a React
   * render here would defeat the memo that keeps the 3D tree still while a child plays.
   */
  const baselineRef = useRef<Object3D[]>([]);
  const guestsRef = useRef<Object3D[]>([]);

  /* ---------------- Input: screen-space picking ---------------- */

  /**
   * Which prop is under a normalised point in a panel.
   *
   * Deliberately not a raycast. The panels are sub-rectangles of the view drei hands R3F,
   * so R3F's own pointer mapping would compute the wrong NDC for both of them; and a
   * spherical collider cannot express "at least 48 screen pixels *in this panel*". So the
   * spots are projected with the same camera the panel was drawn with and compared in the
   * panel's own pixels, with a hard floor of `MIN_TAP_PX` radius — a 60 px target at the
   * smallest panel this layout will ever produce.
   *
   * Runs on a tap, never per frame.
   */
  const pick = useCallback(
    (nx: number, ny: number): number => {
      const camera = cameraRef.current;
      const pw = layout.pxW;
      const ph = layout.pxH;
      if (!camera || pw < 1 || ph < 1) return -1;

      const tx = nx * pw;
      const ty = ny * ph;
      // World units per CSS pixel at a given view depth, for this panel's height.
      const k = (2 * Math.tan((camera.fov * Math.PI) / 360)) / ph;

      // `_ray.project` needs the panel's projection, not the view's. It used to find it
      // installed by accident, because the panel loop left it behind; it is asked for now.
      return withPanelProjection(camera, pw / ph, () => {
        let best = -1;
        let bestDistance = Infinity;
        for (let i = 0; i < SPOTS.length; i++) {
          const spot = SPOTS[i];
          _ray.set(spot.x, spot.y, spot.z);
          _dir.copy(_ray).applyMatrix4(camera.matrixWorldInverse);
          const depth = -_dir.z;
          if (depth <= 0) continue;
          _ray.project(camera);
          const sx = (_ray.x * 0.5 + 0.5) * pw;
          const sy = (1 - (_ray.y * 0.5 + 0.5)) * ph;
          const dx = sx - tx;
          const dy = sy - ty;
          const distance = Math.sqrt(dx * dx + dy * dy);
          let radius = spot.r / (depth * k);
          if (radius < MIN_TAP_PX) radius = MIN_TAP_PX;
          if (distance <= radius && distance < bestDistance) {
            bestDistance = distance;
            best = i;
          }
        }
        return best;
      });
    },
    [layout]
  );

  useEffect(() => {
    engine.bridge.pick = pick;
    return () => {
      engine.bridge.pick = null;
    };
  }, [engine, pick]);

  /* ---------------- Engine events ---------------- */

  useEffect(
    () =>
      engine.on((event) => {
        const reduced = isReduced();
        const ripple = rt.ripple;
        if (event.type === "deal") {
          for (let i = 0; i < anims.length; i++) {
            anims[i].pop.set(1);
            anims[i].ringT = 0;
            anims[i].found = 0;
            anims[i].windT = 0;
          }
          ripple.alive = 0;
          rt.nudge.t = 0;
          rt.nudge.index = -1;
          diorama.badges.visible = false;
          // The five slots hold last run's matrices until something writes them again, so the
          // gate in `stepScene` has to be told they are stale. See `ring.written`.
          rt.ring.written = 0;
          for (let i = 0; i < diorama.diffs.length; i++) {
            const pop = diorama.diffs[i].pop;
            for (let p = 0; p < pop.length; p++) pop[p].scale.set(1, 1, 1);
          }
          return;
        }
        if (event.type === "found") {
          const anim = anims[event.index];
          anim.found = 1;
          anim.ringT = 0;
          anim.pop.to(1);
          anim.pop.velocity = 0;
          if (reduced) {
            anim.windT = 0;
            anim.pop.value = POP_SCALE_REDUCED;
          } else {
            // Wind up first. `stepScene` drives the dip and hands over to the spring.
            anim.windT = POP_WIND_UP;
            anim.pop.value = 1;
          }
          // Progress: whatever the nudge was pointing at, it is not the question any more.
          if (rt.nudge.index >= 0) {
            const pop = diorama.diffs[rt.nudge.index].pop;
            for (let p = 0; p < pop.length; p++) pop[p].scale.set(1, 1, 1);
          }
          rt.nudge.t = 0;
          rt.nudge.index = -1;
          diorama.badges.visible = true;
          return;
        }
        if (event.type === "nudge") {
          rt.nudge.index = event.index;
          rt.nudge.t = reduced ? NUDGE_LIFE_REDUCED : NUDGE_LIFE;
          return;
        }
        if (event.type === "miss") {
          const camera = cameraRef.current;
          ripple.panel = event.panel;
          ripple.t = 0;
          ripple.alive = 1;
          if (event.spot >= 0) {
            // A named prop: ripple on the prop itself, so a keyboard check reads the same
            // way a tap does.
            const spot = SPOTS[event.spot];
            ripple.x = spot.x;
            ripple.y = spot.y;
            ripple.z = spot.z + 0.35;
          } else if (camera && event.nx >= 0 && layout.pxW > 0 && layout.pxH > 0) {
            // `unproject` reads the projection matrix, and these are *panel* coordinates.
            withPanelProjection(camera, layout.pxW / layout.pxH, () => {
              _ray.set(event.nx * 2 - 1, 1 - event.ny * 2, 0.5).unproject(camera);
            });
            _dir.copy(_ray).sub(camera.position).normalize();
            const t = Math.abs(_dir.z) > 1e-4 ? (MARK_Z - camera.position.z) / _dir.z : 0;
            _hit.copy(camera.position).addScaledVector(_dir, t);
            ripple.x = _hit.x < -2.5 ? -2.5 : _hit.x > 2.5 ? 2.5 : _hit.x;
            ripple.y = _hit.y < -1.6 ? -1.6 : _hit.y > 1.6 ? 1.6 : _hit.y;
            ripple.z = MARK_Z;
          } else {
            ripple.x = 0;
            ripple.y = 0;
            ripple.z = MARK_Z;
          }
        }
      }),
    [engine, anims, diorama, rt, layout]
  );

  /* ---------------- Lifecycle ---------------- */

  useEffect(() => {
    liveHandle = {
      setTestMode: (on: boolean) => {
        testModeRef.current = on;
        rt.ripple.alive = 0;
        rt.nudge.t = 0;
        rt.nudge.index = -1;
        rt.ring.written = 0;
        diorama.badges.visible = false;
        for (let i = 0; i < anims.length; i++) {
          anims[i].pop.set(1);
          anims[i].ringT = 0;
          anims[i].found = 0;
          anims[i].windT = 0;
        }
        for (let i = 0; i < diorama.diffs.length; i++) {
          const pop = diorama.diffs[i].pop;
          for (let p = 0; p < pop.length; p++) pop[p].scale.set(1, 1, 1);
        }
        for (let i = 0; i < diorama.bob.length; i++) {
          diorama.bob[i].position.y = diorama.bobBase[i];
        }
      },
      capture: (mode) =>
        new Promise<SpotCapture>((resolve, reject) => {
          if (jobRef.current) {
            reject(new Error("a capture is already in flight"));
            return;
          }
          jobRef.current = { mode, resolve, reject };
        }),
      cancelCapture: () => {
        const pending = jobRef.current;
        jobRef.current = null;
        pending?.reject(new Error("capture cancelled"));
      },
      expectedBoxes: (width, height) => expectedBoxes(diorama, engine, cameraRef.current, width, height),
      markProbes: (width, height) => markProbes(cameraRef.current, width, height),
      layout,
      engine,
    };
    return () => {
      liveHandle = null;
    };
  }, [diorama, engine, layout, anims, rt]);

  useEffect(() => {
    const built = diorama;
    return () => {
      const job = jobRef.current;
      jobRef.current = null;
      job?.reject(new Error("the scene unmounted before the capture ran"));
      built.dispose();
    };
  }, [diorama]);

  /* ---------------- The frame ---------------- */

  // See `SHADOW_HOLD_PRIORITY`. Runs after the camera and before drei's `<View>`.
  useFrame((state) => {
    state.gl.shadowMap.autoUpdate = isCelebrating();
  }, SHADOW_HOLD_PRIORITY);

  useFrame((state, delta) => {
    /*
     * Unconditional and first, so the two panel renders below always draw against a live
     * shadow map however this callback exits — and so nothing downstream of this game ever
     * inherits a frozen one. The hold at `SHADOW_HOLD_PRIORITY` is the only thing that turns
     * it off, it runs once a frame, and it now leaves it on while the celebration is up
     * because that render happens at priority 1, *before* this line.
     */
    state.gl.shadowMap.autoUpdate = true;

    const world = worldRef.current;
    if (!world) return;
    const camera = state.camera as PerspectiveCamera;
    cameraRef.current = camera;

    const dt = safeDelta(delta);
    const reduced = isReduced();
    stepScene(diorama, anims, rt, dt, state.clock.elapsedTime, reduced, testModeRef.current, camera);

    /*
     * The celebration hand-off.
     *
     * This game is the awkward one. `GameShell` draws the shared burst from a single centred
     * camera, and there is no centre here: there are two picture frames with a gap between
     * them, and round 2 photographed the celebration's hero wedged into that 14 px gap. So
     * both rooms put themselves away — one scale on the shared `world` node, which both
     * panels render, so they leave together and identically — and once they are gone the
     * panel loop stops running at all. That last part is worth having on its own: it is two
     * full scene traversals plus a shadow pass a frame that nobody can see, on top of the
     * celebration's own view.
     *
     * The two DOM picture frames leave on the same beat, driven off the same `completed`
     * flag — see `PANEL_SHADOW` in `SpotTheDifference.tsx`. Round 3 shipped the rooms leaving
     * and the frames staying, and the audit photographed the result: two empty inset picture
     * frames with a seam running vertically through the mascot's legs.
     */
    const celebrating = isCelebrating();
    const exit = celebrationHeroScale();
    world.scale.set(exit, exit, exit);

    /*
     * Tell this game's own subtree apart from whatever `view-slot.tsx` has portalled in.
     *
     * Recorded every frame that is *not* a celebration, when the slot is provably empty, so
     * the comparison never has to know what a celebration is made of — only that anything the
     * scene did not have a moment ago is not ours to draw into a picture frame. Reuses both
     * arrays, so it allocates nothing after the first few frames.
     */
    const kids = state.scene.children;
    const baseline = baselineRef.current;
    const guests = guestsRef.current;
    if (!celebrating) {
      baseline.length = 0;
      for (let i = 0; i < kids.length; i++) baseline.push(kids[i]);
      guests.length = 0;
    } else if (guests.length === 0) {
      for (let i = 0; i < kids.length; i++) {
        if (baseline.indexOf(kids[i]) < 0) guests.push(kids[i]);
      }
    }

    if (layout.ready !== 1 || exit <= 0.0005) return;
    const gl = state.gl;
    gl.getViewport(_vp);
    const viewW = _vp.z;
    const viewH = _vp.w;
    const dpr = gl.getPixelRatio();

    /*
     * Both panels are solved in **device** pixels, and both origins and both sizes are
     * snapped to even numbers.
     *
     * three stores a viewport in CSS pixels and applies `floor(css * pixelRatio)`, so a
     * fractional device-pixel ratio (1.25, 1.5, a browser zoom) can quietly hand the two
     * panels origins of different parity. Round 2's `?selftest=spot` failed on one or two
     * isolated pixels that moved between runs — the signature of a multisample resolve
     * landing on a different phase, not of a camera or exposure drift. Solving in device
     * pixels removes the rounding, and forcing even origins *and* even extents means both
     * rectangles start and end on the same 2x2 resolve quad however the tier's DPR clamp
     * lands. `+ 0.25` before the divide is what survives three's floor: the product is
     * `dev + 0.25`, which floors back to `dev` rather than to `dev - 1`.
     */
    const devW = evenDevicePx(layout.fw * viewW, dpr);
    const devH = evenDevicePx(layout.fh * viewH, dpr);
    if (devW < 8 || devH < 8) return;
    const pw = (devW + 0.25) / dpr;
    const ph = (devH + 0.25) / dpr;

    /*
     * One aspect, set once, shared by both renders — the projection matrix is not touched
     * between them. Solved from the device rectangle that is really drawn.
     *
     * **And handed back.** The camera belongs to the view, not to the panel loop: drei sets
     * `camera.aspect` to the *view's* aspect at priority 1 every frame, and anything that
     * reads the projection between frames has a right to find it that way. Round 3 left the
     * panel aspect installed, which made two things wrong and one thing non-deterministic:
     * `solveCelebrationFit` reads `projectionMatrix.elements[0]` when the celebration mounts,
     * and whether it saw 1.44 or the view's 1.14 depended on where React happened to commit.
     * The three places that genuinely need the *panel* projection ask for it explicitly now —
     * see `withPanelProjection`.
     */
    const viewAspect = camera.aspect;
    const aspect = devW / devH;
    if (viewAspect !== aspect) {
      camera.aspect = aspect;
      camera.updateProjectionMatrix();
    }

    const job = jobRef.current;
    const forceA = job !== null && job.mode === "aa";

    const prevAutoClear = gl.autoClear;
    const prevScissorTest = gl.getScissorTest();
    gl.getViewport(_prevVp);
    gl.getScissor(_prevSc);
    gl.autoClear = false;

    // The celebration steps out of the scene for exactly these two renders. See the note on
    // `<View>` in this file's header for why, and why `visible` rather than a layer mask.
    for (let i = 0; i < guests.length; i++) guests[i].visible = false;
    world.visible = true;
    for (let panel = 0; panel < 2; panel++) {
      applyPanel(diorama, engine, forceA ? 0 : panel, rt.ripple);
      const devX = evenDevicePx(_vp.x + (panel === 0 ? layout.ax : layout.bx) * viewW, dpr);
      const devY = evenDevicePx(_vp.y + (panel === 0 ? layout.ay : layout.by) * viewH, dpr);
      const x = (devX + 0.25) / dpr;
      const y = (devY + 0.25) / dpr;
      gl.setViewport(x, y, pw, ph);
      gl.setScissor(x, y, pw, ph);
      gl.setScissorTest(true);
      gl.render(state.scene, camera);
      // The readback rectangle is now the rectangle that was drawn by construction, not by
      // re-deriving three's rounding.
      if (panel === 0) {
        layout.devAX = devX;
        layout.devAY = devY;
      } else {
        layout.devBX = devX;
        layout.devBY = devY;
      }
    }
    layout.devW = devW;
    layout.devH = devH;
    world.visible = false;
    // `Celebration` writes `root.visible = true` from its own `useFrame` at priority 0, so
    // the value restored here is the one it will write again next frame either way.
    for (let i = 0; i < guests.length; i++) guests[i].visible = true;

    gl.setScissorTest(prevScissorTest);
    gl.setViewport(_prevVp);
    gl.setScissor(_prevSc);
    gl.autoClear = prevAutoClear;
    if (camera.aspect !== viewAspect) {
      camera.aspect = viewAspect;
      camera.updateProjectionMatrix();
    }

    if (job) {
      jobRef.current = null;
      runCapture(gl, layout, job);
    }
  }, PANEL_PRIORITY);

  /* ---------------- Tree ---------------- */

  return (
    /*
      `ground={false}`: the diorama supplies its own table and cyclorama, both with
      `receiveShadow: false`. The room shell deliberately casts nothing (a shoebox lit from
      the front-upper-left would throw its own rim across the upper 45% of its back wall,
      which is where the mirror and the window live), and a shell that does not cast is a
      shell light passes through — so every wall prop's shadow escaped the box and struck the
      rig's table outside it as thin `#8a877b` hairlines. Removing the receiver is the fix
      that does not cost the room its light. See `buildDiorama`'s surround.

      **The rig is outside the hidden group, and that nesting is load-bearing.** Two separate
      things depend on it and they pull in opposite directions:

       - The *world* must be invisible outside the two panel renders, or drei's `<View>` will
         draw a third, full-play-area copy of the room over them at priority 1. It is also
         the backstop on picking: `Raycaster` skips an invisible subtree, so even if a
         pointer event did reach R3F it could not resolve a `HitTarget` against NDC computed
         from the whole view rect instead of from a panel. Picking is `engine.tap` plus the
         panel-space `pick` in this file, and only that.
       - The *light* must be visible, because `WebGLRenderer.compile` gathers materials with
         `scene.traverse` but lights with `scene.traverse**Visible**` (three r170,
         `WebGLRenderer.js`). With the rig inside the hidden group — where round 2 had it —
         `Scene3D`'s `<Precompile>` warmed every program of this scene with
         `NUM_DIR_LIGHTS 0`: the wrong defines, so the frame that mattered still compiled
         cold *and* the scene then carried a second, unusable program per material against
         the §9 budget. Precisely the opposite of what precompiling is for, and invisible
         from inside `Scene3D`, which cannot know a game hides its own world.

      Hoisting the rig satisfies both. `Rig` renders its `<directionalLight>` as a sibling of
      its children and adds the light's target to the scene root, so nothing else moves — see
      `SHADOW_HOLD_PRIORITY` for the one cost this does carry and how it is paid back.
    */
    <Rig groundY={GROUND_Y} ground={false} shadowArea={8.4} fogDensity={0.011}>
      <group ref={worldRef} visible={false}>
        <primitive object={diorama.root} dispose={null} />
        <ContactBlob position={CABINET_BLOB} radius={1.25} opacity={0.3} />
        <ContactBlob position={DUCK_BLOB} radius={0.36} opacity={0.4} />
        <ContactBlob position={CUP_BLOB} radius={0.26} opacity={0.34} />
        {SPOTS.map((spot, index) => (
          <HitTarget
            key={spot.label}
            ariaLabel={`Check the ${spot.label}`}
            group={FOCUS_GROUP}
            focusOrder={index}
            radius={spot.r}
            minScreenPx={tapPx}
            position={[spot.x, spot.y, spot.z]}
            onSelect={() => engine.checkSpot(index)}
          />
        ))}
      </group>
    </Rig>
  );
});

const FOCUS_GROUP = "Bathroom pictures";
// Each blob sits under the prop it grounds, so all three move with the vanity's corrected
// depths rather than staying where the old, wrong wall put them.
const CABINET_BLOB: [number, number, number] = [-1.35, FLOOR_Y + 0.012, CABINET_Z];
const DUCK_BLOB: [number, number, number] = [0.95, FLOOR_Y + 0.014, -0.35];
const CUP_BLOB: [number, number, number] = [-0.18, -0.552, CUP_Z];

/* ------------------------------------------------------------------ */
/* Animation                                                           */
/* ------------------------------------------------------------------ */

/**
 * Slides a point along the ray from the camera onto a fixed `z = planeZ` plane, in place,
 * and returns the factor its world size must be multiplied by to keep the same screen size.
 *
 * This is what lets the found ring and the "oops" ripple be drawn *in front of the picture*
 * while still sitting exactly over the prop they belong to. Round 2 drew them at the prop's
 * own depth, and the room ate them: ring #4's back surface finished 0.01 units behind the
 * back wall and rendered as a large "C" with a chunk missing, and the towel ring passed
 * behind the counter. Because the point stays on the camera ray, its projection does not
 * move by a pixel; because a perspective camera's screen size is `worldSize / viewDepth` and
 * both depths are measured along the same ray, the ratio *is* the along-ray parameter.
 *
 * No allocation: reads and writes `p`, touches nothing else.
 */
function slideToPlane(p: Vector3, camera: PerspectiveCamera, planeZ: number): number {
  const cz = camera.position.z;
  const dz = p.z - cz;
  if (dz > -1e-4 && dz < 1e-4) return 1;
  const t = (planeZ - cz) / dz;
  if (!(t > 0.05) || t > 20) return 1;
  p.set(
    camera.position.x + (p.x - camera.position.x) * t,
    camera.position.y + (p.y - camera.position.y) * t,
    planeZ
  );
  return t;
}

/**
 * Advances every animated value and writes the instanced ring/ripple matrices.
 *
 * Runs before both panel renders, so whatever it writes is identical in the two pictures —
 * which is exactly what makes a found ring and a happy pop appear in *both* panels for
 * free, with no second copy of anything.
 */
function stepScene(
  diorama: Diorama,
  anims: DiffAnim[],
  rt: SpotRuntime,
  dt: number,
  elapsed: number,
  reduced: boolean,
  testMode: boolean,
  camera: PerspectiveCamera
): void {
  const diffs = diorama.diffs;
  const ripple = rt.ripple;

  /*
   * The idle nudge (see `NUDGE_LIFE`), resolved once for the whole pop loop.
   *
   * One swell, and `sin(phase * PI)` is the whole curve: it is zero at both ends *with zero
   * derivative* at both ends, and positive everywhere between, so the prop grows and comes
   * back without a frame of linear travel and without ever dipping below its own size. A
   * two-lobe `sin(phase * 2PI)` would have been a swell followed by a *shrink*, which is a
   * different gesture and not the one a hint wants. Repetition is the engine's job — it re-arms
   * every `NUDGE_REPEAT` — so this has no reason to loop inside itself.
   *
   * The frame it ends on is the frame the scale is put back, before the pop loop runs, so the
   * loop cannot re-apply a swell for an index that is no longer live.
   */
  const nudge = rt.nudge;
  let nudgeSwell = 0;
  if (nudge.t > 0) {
    nudge.t -= dt;
    if (nudge.t <= 0) {
      nudge.t = 0;
      const done = diffs[nudge.index];
      if (done) for (let p = 0; p < done.pop.length; p++) done.pop[p].scale.set(1, 1, 1);
      nudge.index = -1;
    } else {
      const life = reduced ? NUDGE_LIFE_REDUCED : NUDGE_LIFE;
      const phase = 1 - nudge.t / life;
      nudgeSwell = (reduced ? NUDGE_SCALE_REDUCED : NUDGE_SCALE) * Math.sin(phase * Math.PI);
    }
  }

  /** Anything the badge matrices depend on that has changed since they were last written. */
  let ringsMoving = 0;

  /* Pops — wind-up, then jump, then settle. */
  for (let i = 0; i < diffs.length; i++) {
    const anim = anims[i];
    let value: number;
    if (anim.windT > 0) {
      // Anticipation. A half-sine over the wind-up window: the prop leaves 1.0 and returns
      // to it with zero velocity at both ends, so the hand-over to the spring's jump has
      // nothing to snap through.
      anim.windT -= dt;
      if (anim.windT <= 0) {
        anim.windT = 0;
        anim.pop.velocity = 0;
        anim.pop.value = POP_SCALE;
        value = POP_SCALE;
      } else {
        const phase = 1 - anim.windT / POP_WIND_UP;
        value = 1 + (POP_DIP - 1) * Math.sin(phase * Math.PI);
        anim.pop.value = value;
      }
    } else {
      value = anim.pop.step(dt);
    }
    // The nudge rides on top of the pop rather than beside it, so the two can never fight
    // over one `scale`. A found prop is never nudged, so in practice only one is ever live.
    if (nudgeSwell !== 0 && nudge.index === i) value *= 1 + nudgeSwell;
    const pop = diffs[i].pop;
    if (value > 1.0005 || value < 0.9995) {
      squashFor(_squash, value - 1, 1);
      for (let p = 0; p < pop.length; p++) pop[p].scale.set(_squash.x, _squash.y, _squash.z);
    } else if (anim.found === 1) {
      for (let p = 0; p < pop.length; p++) pop[p].scale.set(1, 1, 1);
    }
    // The badge holds off until the wind-up has handed over, so the reward reads as one
    // gesture rather than as a mark and a jump that happen to overlap.
    if (anim.found === 1 && anim.ringT < 1) {
      ringsMoving = 1;
      if (anim.windT === 0) {
        anim.ringT = clamp01(anim.ringT + dt / (reduced ? FEEL.reducedFade : RING_IN));
      }
    }
  }

  /* Idle: a barely perceptible bob on the duck, and none at all under reduced motion.
     One-sided — the duck's origin is its keel, and a two-sided bob would push it through
     the tiles for half of every cycle. */
  const bob = diorama.bob;
  const lift = reduced || testMode ? 0 : (Math.sin(elapsed * BOB_SPEED) * 0.5 + 0.5) * BOB_AMPLITUDE;
  for (let i = 0; i < bob.length; i++) bob[i].position.y = diorama.bobBase[i] + lift;

  /*
   * Found badges — one instanced mesh, slid forward onto `MARK_Z`.
   *
   * **Written only when something they depend on has moved.** `badges.visible` goes true on
   * the first find and only comes down on a deal, so round 3 recomposed five matrices and
   * re-uploaded the instance buffer on every frame of the rest of the run — in the one game
   * that submits its geometry twice a frame and can least afford the traffic.
   *
   * The matrices are a pure function of exactly three things, and all three are checked
   * rather than assumed:
   *  - **`ringT`** — `ringsMoving`, set in the pop loop above while any badge is still opening
   *    (including through the wind-up, so a badge that has not opened yet is still written).
   *  - **`breathe`** — a function of `elapsed`, so it moves every frame at full motion and is
   *    pinned to exactly 1 under reduced motion.
   *  - **the camera** — `slideToPlane`'s along-ray factor, and nothing else since SD2: the
   *    badge's facing is baked into its geometry (`BADGE_ROT`), because `cameraFor` moves the
   *    camera's *distance* with the panel shape and never its direction. `camera.ts` snaps the
   *    rig to its base pose under reduced motion and breathes it by up to 0.06 units and 0.35°
   *    otherwise; at this framing that is `9.466 · tan(0.35°) · 0.7` = 0.040 world units of aim
   *    swing, which at the mark plane (view depth ≈ 8.9, 0.0164 world per panel px) is
   *    **2.4 CSS px** — so at full motion the write is *not* waste and is not skipped. The
   *    pose is still compared rather than inferred from `reduced`, and the rotation half of it
   *    is still compared even though the badge no longer reads it, because the *slide* is a
   *    function of the camera's position and the position is what the rotation comes with.
   *
   * Under reduced motion, once the last badge has saturated, all three are constant and the
   * whole block is skipped for the remainder of the run.
   */
  const badges = diorama.badges;
  if (badges.visible) {
    const sync = rt.ring;
    const cp = camera.position;
    const cq = camera.quaternion;
    const moved =
      sync.written === 0 ||
      ringsMoving === 1 ||
      !reduced ||
      sync.px !== cp.x ||
      sync.py !== cp.y ||
      sync.pz !== cp.z ||
      sync.qx !== cq.x ||
      sync.qy !== cq.y ||
      sync.qz !== cq.z ||
      sync.qw !== cq.w;
    if (moved) {
      sync.written = 1;
      sync.px = cp.x;
      sync.py = cp.y;
      sync.pz = cp.z;
      sync.qx = cq.x;
      sync.qy = cq.y;
      sync.qz = cq.z;
      sync.qw = cq.w;
      writeBadges(diorama, anims, elapsed, reduced, camera);
    }
  }

  /* "Oops" ripple — three concentric rings that grow and shrink away. Never an error. */
  const ripples = diorama.ripples;
  if (ripple.alive === 1) {
    const life = reduced ? FEEL.reducedFade : RIPPLE_LIFE;
    const stagger = reduced ? 0 : RIPPLE_STAGGER;
    ripple.t += dt;
    if (ripple.t > life + stagger * (RIPPLE_SLOTS - 1)) {
      ripple.alive = 0;
      ripples.visible = false;
    } else {
      // Identity, not the camera's: the ripple's facing is baked into its geometry alongside
      // the badge's, for the same reason — a camera-facing torus points its tube crest at the
      // lens all the way round and cannot shade.
      _quat.identity();
      _pos.set(ripple.x, ripple.y, ripple.z);
      slideToPlane(_pos, camera, MARK_Z);
      for (let i = 0; i < RIPPLE_SLOTS; i++) {
        const local = (ripple.t - i * stagger) / life;
        // A sine over a front-loaded clock: the ring is already half its size two frames
        // after the tap and then takes its time folding back into nothing. Growth and
        // recession both start and end at rest, so nothing has to fade and no shared
        // material is ever mutated.
        const scale =
          local <= 0 || local >= 1 || (reduced && i > 0)
            ? 0
            : Math.sin(Math.PI * Math.pow(local, 0.62)) * RIPPLE_MAX * (0.55 + i * 0.3);
        _scl.set(scale, scale, scale);
        _mat.compose(_pos, _quat, _scl);
        ripples.setMatrixAt(i, _mat);
      }
      ripples.instanceMatrix.needsUpdate = true;
    }
  }
}

/**
 * The five badge matrices. Split out only so the write gate above reads as one decision.
 *
 * A translation and a uniform scale — no quaternion is read from the camera and none is
 * composed, because `BADGE_ROT` is baked into the geometry. `_quat` is the identity and stays
 * that way; `Matrix4.compose` still wants one, and a module-level constant costs nothing.
 */
function writeBadges(
  diorama: Diorama,
  anims: DiffAnim[],
  elapsed: number,
  reduced: boolean,
  camera: PerspectiveCamera
): void {
  const badges = diorama.badges;
  _quat.identity();
  for (let i = 0; i < BADGE_SLOTS; i++) {
    const anim = anims[i];
    const badge = BADGES[i];
    let scale = 0;
    if (anim.found === 1) {
      const open = reduced ? easeOutCubic(anim.ringT) : easeOutBack(anim.ringT, 1.9);
      const breathe = reduced ? 1 : 1 + Math.sin(elapsed * 2.1 + i * 1.7) * 0.028;
      scale = BADGE_R * open * breathe;
    }
    _pos.set(badge.x, badge.y, badge.z);
    scale *= slideToPlane(_pos, camera, MARK_Z);
    _scl.set(scale, scale, scale);
    _mat.compose(_pos, _quat, _scl);
    badges.setMatrixAt(i, _mat);
  }
  badges.instanceMatrix.needsUpdate = true;
}

/* ------------------------------------------------------------------ */
/* Capture + expected regions (self test support)                      */
/* ------------------------------------------------------------------ */

/**
 * Reads the two panel rectangles out of the default framebuffer.
 *
 * Reading the *live* drawing buffer rather than a private render target is the point: it
 * measures the viewports, the projection and the multisample resolve the child actually
 * sees. It is legal without `preserveDrawingBuffer` because it happens inside the same
 * animation frame that drew them, before the compositor takes the buffer.
 */
function runCapture(gl: WebGLRenderer, layout: PanelLayout, job: CaptureJob): void {
  try {
    const ctx = gl.getContext();
    const w = layout.devW;
    const h = layout.devH;
    if (w < 8 || h < 8) throw new Error(`panel is ${w}x${h} device pixels`);
    const a = new Uint8Array(w * h * 4);
    const b = new Uint8Array(w * h * 4);
    ctx.readPixels(layout.devAX, layout.devAY, w, h, ctx.RGBA, ctx.UNSIGNED_BYTE, a);
    ctx.readPixels(layout.devBX, layout.devBY, w, h, ctx.RGBA, ctx.UNSIGNED_BYTE, b);
    job.resolve({ width: w, height: h, a, b });
  } catch (error) {
    job.reject(error);
  }
}

const _box = new Box3();
const _corner = new Vector3();
const _shadow = new Vector3();
/** `widen` projects into this, so the point handed to it is never clobbered. */
const _proj = new Vector3();

type Accumulator = { x0: number; y0: number; x1: number; y1: number; any: number };

function widen(acc: Accumulator, p: Vector3, camera: PerspectiveCamera, w: number, h: number): void {
  _proj.copy(p).project(camera);
  const x = (_proj.x * 0.5 + 0.5) * w;
  // Readback rows come back bottom-up, which is the same orientation as NDC y.
  const y = (_proj.y * 0.5 + 0.5) * h;
  if (x < acc.x0) acc.x0 = x;
  if (x > acc.x1) acc.x1 = x;
  if (y < acc.y0) acc.y0 = y;
  if (y > acc.y1) acc.y1 = y;
  acc.any = 1;
}

/** How far a shadow ray is followed before it has certainly left the room. */
const SHADOW_REACH = 2.4;
const ROOM_SLACK = 0.12;

/** True when a swept point is still somewhere a shadow could actually land. */
function insideRoom(p: Vector3): boolean {
  return (
    p.y > FLOOR_Y - ROOM_SLACK &&
    p.y < INNER_Y + ROOM_SLACK &&
    p.z > BACK_Z - ROOM_SLACK &&
    p.x > -INNER_X - ROOM_SLACK &&
    p.x < INNER_X + ROOM_SLACK
  );
}

/**
 * Where the key light could throw this point's shadow.
 *
 * Every horizontal receiver (floor, counter, shelf) and the back wall are swept, and every
 * landing that is still inside the room is folded in. Some of those points are not the
 * *first* surface the ray meets, which is deliberate: the result only has to be a superset
 * of the real shadow, or the test would fail on a shadow it simply forgot about.
 */
function widenShadow(
  acc: Accumulator,
  p: Vector3,
  camera: PerspectiveCamera,
  w: number,
  h: number
): void {
  for (let i = 0; i < RECEIVER_Y.length; i++) {
    const t = (p.y - RECEIVER_Y[i]) / KEY_DIR.y;
    if (t <= 0 || t > SHADOW_REACH) continue;
    _shadow.copy(p).addScaledVector(KEY_DIR, -t);
    if (insideRoom(_shadow)) widen(acc, _shadow, camera, w, h);
  }
  const tz = (p.z - BACK_Z) / KEY_DIR.z;
  if (tz > 0 && tz <= SHADOW_REACH) {
    _shadow.copy(p).addScaledVector(KEY_DIR, -tz);
    if (insideRoom(_shadow)) widen(acc, _shadow, camera, w, h);
  }
}

function widenObject(
  acc: Accumulator,
  obj: Object3D,
  camera: PerspectiveCamera,
  w: number,
  h: number
): void {
  obj.updateWorldMatrix(true, true);
  _box.setFromObject(obj);
  if (_box.isEmpty()) return;
  for (let i = 0; i < 8; i++) {
    _corner.set(
      i & 1 ? _box.max.x : _box.min.x,
      i & 2 ? _box.max.y : _box.min.y,
      i & 4 ? _box.max.z : _box.min.z
    );
    widen(acc, _corner, camera, w, h);
    widenShadow(acc, _corner, camera, w, h);
  }
}

/**
 * For each difference in play, the rectangle its pixels are allowed to change in.
 *
 * Derived from the objects themselves rather than hand-typed, so moving a prop cannot
 * silently loosen the test: it is the screen bound of the A version, the B version, and of
 * every shadow either of them can cast onto the floor, the counter, the shelf or the back
 * wall — padded for the shadow map's softness.
 */
/**
 * Projects each difference's prop circle and its found badge into one panel rectangle.
 *
 * Both circles are evaluated at the prop's **own depth**, which is legitimate rather than
 * convenient: `slideToPlane` moves the badge along the camera ray and multiplies its world
 * size by the same along-ray factor, so its projection is identical to what it would be if it
 * were drawn where it is authored. That is the whole point of the slide and it is why the
 * badge can be reasoned about here in one line instead of re-deriving the plane.
 */
function markProbes(
  camera: PerspectiveCamera | null,
  width: number,
  height: number
): MarkProbe[] {
  const out: MarkProbe[] = [];
  if (!camera || width < 1 || height < 1) return out;
  const byDiff: Spot[] = [];
  for (const spot of SPOTS) if (spot.diff >= 0) byDiff[spot.diff] = spot;
  return withPanelProjection(camera, width / height, () => {
    // World units per panel pixel at a given view depth — the same relation `pick` uses.
    const k = (2 * Math.tan((camera.fov * Math.PI) / 360)) / height;
    const project = (x: number, y: number, z: number, r: number): MarkCircle | null => {
      _ray.set(x, y, z);
      _dir.copy(_ray).applyMatrix4(camera.matrixWorldInverse);
      const depth = -_dir.z;
      if (depth <= 0) return null;
      _ray.project(camera);
      return {
        x: (_ray.x * 0.5 + 0.5) * width,
        y: (1 - (_ray.y * 0.5 + 0.5)) * height,
        r: r / (depth * k),
      };
    };
    for (let i = 0; i < BADGE_SLOTS && i < byDiff.length; i++) {
      const spot = byDiff[i];
      const mark = BADGES[i];
      const prop = project(spot.x, spot.y, spot.z, spot.r);
      const badge = project(mark.x, mark.y, mark.z, BADGE_R);
      if (prop && badge) out.push({ index: i, badge, prop });
    }
    return out;
  });
}

function expectedBoxes(
  diorama: Diorama,
  engine: SpotEngine,
  camera: PerspectiveCamera | null,
  width: number,
  height: number
): ExpectedBox[] {
  const out: ExpectedBox[] = [];
  if (!camera) return out;
  const pad = Math.max(8, 0.045 * Math.min(width, height));
  // `width`/`height` *are* the panel readback rectangle, so this projects in the panel's own
  // frame — asked for explicitly rather than inherited from whatever the last frame left on
  // the shared camera. Same projection as before, now for a stated reason.
  return withPanelProjection(camera, width / height, () => {
    for (let i = 0; i < diorama.diffs.length; i++) {
      if (engine.activeMask[i] !== 1) continue;
      const acc: Accumulator = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity, any: 0 };
      widenObject(acc, diorama.diffs[i].a, camera, width, height);
      widenObject(acc, diorama.diffs[i].b, camera, width, height);
      if (acc.any === 0) continue;
      out.push({
        index: i,
        x0: acc.x0 - pad,
        y0: acc.y0 - pad,
        x1: acc.x1 + pad,
        y1: acc.y1 + pad,
      });
    }
    return out;
  });
}
