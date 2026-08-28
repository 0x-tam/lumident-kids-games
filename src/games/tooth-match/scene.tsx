/**
 * Tooth Match — the 3D board.
 *
 * How this file is wired, because it is the pattern the other games copy:
 *
 *  • It takes ONE prop, the engine, and that prop never changes identity. Nothing about a
 *    card's animation ever travels through React.
 *  • It subscribes to the engine once and, from that callback, mutates plain structs
 *    (`CardAnim`). The component re-renders on exactly two events — `deal` and `match` —
 *    because those are the only two that change something React owns: how many cards exist,
 *    and which of them are still live targets. A `match` lands at most eight times in a run
 *    and never inside a frame loop, so the "no per-frame React render" rule is intact; what
 *    it buys is that a solved card can carry `disabled` and a matched aria-label, which is
 *    the only way the DOM counterpart in `hit.tsx` can stop being a live keyboard stop.
 *  • `useFrame` reads those structs, writes `Object3D` transforms, and composes instance
 *    matrices through module-level scratch objects. It allocates nothing: no `new`, no
 *    literals, no closures, no `map`.
 *  • Sixteen cards are four draw calls. The body, the raised front panel, the red medallion
 *    and the rosette pressed into it are each one `InstancedMesh`; their per-instance
 *    matrices are the card's own matrix times a constant offset matrix.
 *  • The card body's and panel's colours are per-instance, through the `aAlbedo` attribute
 *    from `materials.ts` — **never** `setColorAt`, which three multiplies into the same
 *    varying the clay shader reads as curvature and then extrapolates by 1.45.
 *  • Only the relief motifs are real per-card meshes, and they are scaled to zero (and
 *    hidden) while their card is face down — so a fresh board draws none of them.
 *
 * Motion (3D-SPEC §4): the flip is `anticipate()` — a counter-rotation and a dip into the
 * table, then the throw, then an overshoot that settles — and a squash spring is kicked at
 * the moment the card slams flat, which is the snap. A match lifts the pair on
 * `easeOutBack`, holds, then drops them on `easeInCubic` (gravity, not an ease-in-out) and
 * presses them into the mat. A miss kicks an underdamped rotation spring: a comic wobble,
 * no flash, no buzzer, no penalty animation.
 *
 * Reduced motion: no flip travel at all — the card swaps faces at the midpoint of a 150 ms
 * scale pop, matched pairs settle straight down without the lift, there is no idle float
 * and no wobble, and `Scene3D`'s `CameraRig` is already static. Still fully playable.
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
import { useFrame } from "@react-three/fiber";
import {
  AdditiveBlending,
  Color,
  DynamicDrawUsage,
  Matrix4,
  MeshBasicMaterial,
  PlaneGeometry,
  Quaternion,
  Vector3,
  type Group,
  type InstancedMesh,
} from "three";

import {
  FEEL,
  Spring,
  anticipate,
  clamp01,
  easeInCubic,
  easeOutBack,
  easeOutCubic,
  safeDelta,
  squashFor,
} from "../../three/anim";
import { DisposalBag } from "../../three/dispose";
import {
  beveledExtrude,
  cachedGeometry,
  clayTray,
  roundedBox,
  roundedPlate,
} from "../../three/geometry";
import { HitTarget, useFocusGroup } from "../../three/hit";
import {
  clay,
  clayAccent,
  clayIvory,
  ensureInstanceAlbedo,
  shadowBlobMaterial,
  writeAlbedo,
} from "../../three/materials";
import {
  ContactBlob,
  Rig,
  contactOpacityFor,
  contactRadiusFor as contactShadowRadius,
} from "../../three/Rig";
import { FLAGS, celebrationHeroScale, isReduced } from "../../three/store";
import { sparkleTexture } from "../../three/textures";
import { ACCENTS, CLAY, NEUTRAL, color } from "../../three/tokens";
import { MATCHED, MOTIF_LABELS, type MotifId, type ToothMatchEngine } from "./engine";
import {
  BACK_ROLL,
  BACK_DZ,
  BACK_INSET,
  BACK_T,
  CARD_CORNER,
  CARD_H,
  CARD_T,
  CARD_W,
  EMBLEM_BEVEL,
  EMBLEM_DEPTH,
  EMBLEM_DZ,
  HIT_RADIUS,
  INLAY_DZ,
  INLAY_INSET,
  INLAY_T,
  MAT_MARGIN,
  MAT_T,
  MAT_Y,
  MATCH_LIFT,
  MAX_CARDS,
  MOTIF_DZ,
  MOTIF_POP_BACK,
  PRESS_Y,
  REST_Y,
  RELIEF_POP_PEAK,
  TABLE_H,
  TABLE_RIM,
  cardX,
  cardZ,
  contactRadiusFor,
  gridFor,
  shadowAreaFor,
  trayFor,
} from "./layout";
import { buildMotifs, emblemShape, type MotifPart, type MotifTable } from "./motifs";

/* ------------------------------------------------------------------ */
/* Tuning                                                              */
/* ------------------------------------------------------------------ */

/** Card rotation about its own long axis. 0 = face up, PI = face down. */
const FACE_UP = 0;
const FACE_DOWN = Math.PI;

const FLIP_DUR = 0.4;
/**
 * The wind-up, in seconds. §4 asks for 50–80 ms of opposite-direction dip.
 *
 * Round 3 measured 104 ms here and it was right: `anticipate` spends its first **28 %** on
 * the dip, and the shipped `FLIP_DIP_END` was 0.26, so at `FLIP_DUR = 0.4` the rotation
 * wound up for 112 ms and the vertical press for 104.
 *
 * The fix list offered "shorten `FLIP_DUR` to ~0.3 s". That is the wrong half to cut: the
 * flip of a memory card is *information* — a child watches it to learn what the card is —
 * and taking 25 % off the whole move to bring one 30 ms overshoot into band trades the
 * legible part for the tuning part. So the curve's own parameter is re-timed instead
 * (`flipK` below): same `anticipate`, same shape, its 0.28 knee moved to land at
 * `WINDUP_S / FLIP_DUR`. The dip is 70 ms, the throw keeps the remaining 330 ms.
 */
const WINDUP_S = 0.07;
/** Where `anticipate` switches from the dip to the throw — see `src/three/anim.ts`. */
const ANTICIPATE_KNEE = 0.28;
/** Fraction of the flip spent winding up — the card presses into the table first. */
const FLIP_DIP_END = WINDUP_S / FLIP_DUR;
const FLIP_DIP = 0.05;
const FLIP_LIFT = 0.26;

/**
 * Re-times the flip's parameter so `anticipate`'s knee lands at `FLIP_DIP_END`.
 *
 * Piecewise-linear in `k`, so it is a change of clock and not a change of easing: every
 * value `anticipate` produces, and the order it produces them in, is untouched. (§4:
 * "use only `src/three/anim.ts` helpers … do not hand-roll easing" — this hand-rolls no
 * easing, it hands the shared one a different `t`.)
 */
const flipK = (k: number): number =>
  k < FLIP_DIP_END
    ? (k / FLIP_DIP_END) * ANTICIPATE_KNEE
    : ANTICIPATE_KNEE + ((k - FLIP_DIP_END) / (1 - FLIP_DIP_END)) * (1 - ANTICIPATE_KNEE);
/** Kicked when the card slams flat. Peak squash ≈ 0.27 of its thickness. */
const SNAP_IMPULSE = -6.5;

const MATCH_DUR = 0.72;
/* `MATCH_LIFT` lives in `layout.ts`: it is half of the transient envelope the camera has to
   reserve for, and the two must not drift apart. */
const MATCH_IMPULSE = -4.6;
const PRESS_DELTA = PRESS_Y - REST_Y;

/**
 * Finger-down feedback.
 *
 * `squash` is a Spring(0, 380, 17) — **§4.1 Exception 1 (comic wobble)**, see the spring's
 * own note where it is constructed. Stiffness 380 gives ω = 19.5 rad/s and ζ = 0.44, so a
 * velocity impulse `v` peaks at roughly `0.7 * v / ω`. `FEEL.pressScale` is 0.94, i.e. a
 * squash amount of −0.06 on the card's thickness axis, so the press impulse is
 * `−0.06 * 19.5 / 0.7 ≈ −2.6`; `FEEL.releaseOvershoot` is 1.06, so the release is +1.8 the
 * other way. Derived from FEEL rather than dialled, so a change to the house feel carries.
 *
 * This matters more than it looks: the flip's own first move is a *counter*-dip travelling
 * away from the finger for 104 ms, so without this the first thing a child saw on touch was
 * the card retreating.
 */
const PRESS_IMPULSE = -2.6;
const RELEASE_IMPULSE = 1.8;

/**
 * How long a matched card takes to settle into its "done" colour.
 *
 * Round 2 measured a matched card as indistinguishable from a live one: the only
 * differences were a 0.04-unit press and an idle bob of 0.0025 against 0.006, neither
 * perceptible, and both exactly zero under reduced motion. The whole card face now travels
 * to `rose.soft` — a 1.42:1 luminance step on the ivory body and a clear hue move on the
 * panel — visible at a glance, and visible with the springs switched off.
 */
const TINT_DUR = 0.22;

/**
 * Albedo multipliers that turn a solved card pink.
 *
 * `aAlbedo` multiplies the material's base colour, so a target colour has to be expressed
 * as a *ratio*, in linear space — which is what `color()` hands back. Both the ivory body
 * and the mauve panel travel to `rose.soft`, so the whole face changes rather than only the
 * 10 % ivory border: a card that is done reads as done from across the room. The panel's
 * red ratio is slightly above 1 (1.028) because `rose.soft` is a touch redder than
 * `mauve.soft`; the product is still 0.89 in linear, so nothing clips.
 */
const tintRatio = (fromHex: string, toHex: string) => {
  const from = color(fromHex);
  const to = color(toHex);
  return { r: to.r / from.r, g: to.g / from.g, b: to.b / from.b };
};
const BODY_TINT = tintRatio(CLAY.ivory, ACCENTS.rose.soft);
const PANEL_TINT = tintRatio(ACCENTS.mauve.soft, ACCENTS.rose.soft);

/**
 * The panel colour a card starts at, as an `aAlbedo` ratio off `mauve.soft`.
 *
 * ## TM6: the tooth had no silhouette
 *
 * Seven of the eight motifs carry an accent family on their dominant mass and read against
 * the `mauve.soft` panel at 2.57–4.70:1. The eighth cannot: a tooth that is not enamel-white
 * is not a tooth, and `CLAY.enamel` on `mauve.soft` is **1.24:1**. At the ~100 px a card
 * occupies, what a child saw was two ink dots and a grin floating on cream — the audit's
 * "on a small screen a child sees two black dots".
 *
 * The fix list offers two routes: darken the panel behind the tooth card only, or give the
 * tooth a `mauve.deep` plinth. This is the first, because the second only lifts the tooth's
 * *base* off the field and the defect is the whole outline — the crown is the half a child
 * recognises. `mauve.deep` on enamel is **4.65:1**, the highest silhouette contrast on any
 * card, and it costs no geometry and no draw call: the panel already carries a per-instance
 * albedo for the matched tint, so this is a different *starting* value in a buffer that is
 * written anyway.
 *
 * It does not leak information a memory game needs to protect. The panel is on the card's
 * *face*: a face-down board is unchanged, and a child still has to turn a card over to see
 * it, which is the move the game scores.
 *
 * A matched card still travels to `rose.soft` like every other, so "done" reads the same
 * everywhere — the tint below lerps from this base rather than from a shared one.
 */
const PANEL_BASE = { r: 1, g: 1, b: 1 };
const PANEL_BASE_TOOTH = tintRatio(ACCENTS.mauve.soft, ACCENTS.mauve.deep);
const panelBaseFor = (id: MotifId) => (id === "tooth" ? PANEL_BASE_TOOTH : PANEL_BASE);

/** Above this flip angle the relief is folded away, so it can never pierce the table. */
const MOTIF_ON_ANGLE = 1.75;
const MOTIF_FADE = 0.5;
/*
 * The reveal pop's overshoot and the fit's budget for it are the same number, and this is
 * where they are held together.
 *
 * `layout.ts` derives `RELIEF_POP_PEAK` in closed form from `MOTIF_POP_BACK` (it cannot
 * import `anim.ts`, which reaches `three` and `store.ts`), and `motifs.ts` divides every
 * relief budget by it. If the two ever disagreed, `fitRelief` would be budgeting for an
 * overshoot the scene does not produce — or, worse, not budgeting for one it does, which is
 * exactly the defect TM5 filed. So the curve is sampled here, once, at module scope, and
 * checked against the closed form.
 */
if (import.meta.env.DEV) {
  let peak = 0;
  for (let i = 0; i <= 2000; i++) {
    const v = easeOutBack(i / 2000, MOTIF_POP_BACK);
    if (v > peak) peak = v;
  }
  if (Math.abs(peak - RELIEF_POP_PEAK) > 1e-4) {
    console.error(
      `[tooth-match] RELIEF_POP_PEAK is ${RELIEF_POP_PEAK.toFixed(6)} but ` +
        `easeOutBack(_, ${MOTIF_POP_BACK}) peaks at ${peak.toFixed(6)}. The relief fit is ` +
        "budgeting for the wrong overshoot; fix layout.ts's derivation."
    );
  }
}

const CELEBRATE_STAGGER = 0.055;
const HOP_IMPULSE = 2.6;

const SPARKLES = 26;

const GROUP = "Tooth Match cards";

/* ------------------------------------------------------------------ */
/* Per-frame scratch — module level, allocated exactly once            */
/* ------------------------------------------------------------------ */

const _card = new Matrix4();
const _part = new Matrix4();
const _pos = new Vector3();
const _scl = new Vector3();
const _squash = { x: 1, y: 1, z: 1 };
const _albedo = new Color();

/** Lays a plate (thickness on +Z) flat, printed face pointing along the card's own +Y. */
const LAY_X = -Math.PI / 2;
const partMatrix = (dz: number) => new Matrix4().makeRotationX(LAY_X).setPosition(0, dz, 0);
const PART_BODY = partMatrix(0);
const PART_INLAY = partMatrix(INLAY_DZ);
const PART_BACK = partMatrix(BACK_DZ);
const PART_EMBLEM = partMatrix(EMBLEM_DZ);
const BLOB_QUAT = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), LAY_X);

/* ------------------------------------------------------------------ */
/* Card animation state                                                */
/* ------------------------------------------------------------------ */

const PH_IDLE = 0;
const PH_FLIP = 1;
const PH_MATCH = 2;

type CardAnim = {
  index: number;
  gx: number;
  gz: number;
  /** Phase offset so sixteen cards do not breathe in lockstep. */
  seed: number;

  phase: number;
  t: number;
  dur: number;

  angle: number;
  from: number;
  to: number;
  snapped: boolean;

  restY: number;
  lift: number;
  matched: boolean;
  /** 0 = live ivory, 1 = fully settled into the matched tint. */
  tint: number;
  /** Set whenever `tint` moves, so the albedo buffer is written only on frames it changed. */
  tintDirty: boolean;

  /** Springs. All three allocate only here, so stepping them per frame is free. */
  hop: Spring;
  wobble: Spring;
  squash: Spring;

  /** Reduced-motion scale pop: springs are inert under reduced motion by design. */
  popT: number;
  popDur: number;
  popAmp: number;

  /** Seconds until this card joins the finishing wave; negative means "not queued". */
  hopDelay: number;

  /* Outputs, read by the writer loop. */
  y: number;
  spin: number;
  squashOut: number;
  /** How far the relief has grown out of the card face, 0..1 (may overshoot on the pop). */
  faceOut: number;
};

function createAnim(index: number, gx: number, gz: number): CardAnim {
  return {
    index,
    gx,
    gz,
    seed: (index * 2.3999632297) % (Math.PI * 2),
    phase: PH_IDLE,
    t: 0,
    dur: FLIP_DUR,
    angle: FACE_DOWN,
    from: FACE_DOWN,
    to: FACE_DOWN,
    snapped: true,
    restY: REST_Y,
    lift: 0,
    matched: false,
    tint: 0,
    // True on the first frame of a fresh deal too, so a re-deal repaints the shared albedo
    // buffer back to white instead of inheriting the last run's matched cards.
    tintDirty: true,
    /*
     * §4 / §4.1, stated in the quantities the band is about (A19's shared contract).
     *
     * `hop` is a **landing** — the card comes down onto the tray and the child is waiting to
     * see where it settled — so it takes §4's band, not the comic-wobble exception. At
     * damping 14 it was ζ 0.434 / 22.0 % overshoot / 571 ms to settle: outside the band on
     * all three, and 127 ms of that is a card still moving after it has arrived. 18 puts it
     * at **ζ 0.558 / 12.1 % / 444 ms**, the same landing feel `maze-escape` and
     * `healthy-or-not` took for the same reason.
     *
     * `wobble` and `squash` are **§4.1 Exception 1 — comic wobble**: a miss's soft wobble
     * (§6.3 asks for one by name) and the finger-down squash. Neither is a thing a child
     * waits on — the board is already accepting the next tap while they ring down — and both
     * sit inside the exception's envelope: wobble ζ 0.260 / 42.9 % / 889 ms, squash ζ 0.436 /
     * 21.8 % / 471 ms, against ζ 0.25-0.44, overshoot <= 45 %, settle <= 900 ms.
     */
    hop: new Spring(0, 260, 18),
    wobble: new Spring(0, 300, 9),
    squash: new Spring(0, 380, 17),
    popT: 0,
    popDur: FEEL.reducedFade,
    popAmp: 0,
    hopDelay: -1,
    y: REST_Y,
    spin: 0,
    squashOut: 0,
    faceOut: 0,
  };
}

function pop(a: CardAnim, amp: number, dur: number): void {
  a.popAmp = amp;
  a.popDur = dur;
  a.popT = dur;
}

function startFlip(a: CardAnim, up: boolean, reduced: boolean): void {
  a.phase = PH_FLIP;
  a.t = 0;
  a.dur = reduced ? FEEL.reducedFade : FLIP_DUR;
  a.from = a.angle;
  a.to = up ? FACE_UP : FACE_DOWN;
  a.snapped = false;
  if (reduced) pop(a, -0.16, a.dur);
}

function startMatch(a: CardAnim, reduced: boolean): void {
  a.phase = PH_MATCH;
  a.t = 0;
  a.dur = reduced ? FEEL.reducedFade : MATCH_DUR;
  a.snapped = false;
  a.matched = true;
  if (reduced) pop(a, -0.1, a.dur);
  else a.wobble.impulse(a.index % 2 === 0 ? 2.4 : -2.4);
}

/** Finger-down. Reduced motion gets the same information as a 150 ms scale pop. */
function pressCard(a: CardAnim, reduced: boolean): void {
  if (reduced) pop(a, -0.06, FEEL.reducedFade);
  else a.squash.impulse(PRESS_IMPULSE);
}

/** Finger-up: the other way, so the card springs back through its rest size and settles. */
function releaseCard(a: CardAnim, reduced: boolean): void {
  if (!reduced) a.squash.impulse(RELEASE_IMPULSE);
}

/**
 * If the keyboard is standing on one of the two cards about to be solved, returns its focus
 * order so the caller can put focus back once `hit.tsx` has rebuilt the button; -1 if not.
 *
 * It reads two documented data attributes and nothing internal: `hit.tsx` parents a grouped
 * target's hidden button directly to the group container and stamps `data-group` on the
 * container and `data-order` on the button.
 */
function focusedOrderIn(group: string, a: number, b: number): number {
  const active = typeof document === "undefined" ? null : (document.activeElement as HTMLElement | null);
  const order = active?.dataset?.order;
  if (active === null || order === undefined) return -1;
  if ((active.parentElement as HTMLElement | null)?.dataset?.group !== group) return -1;
  const n = Number(order);
  return n === a || n === b ? n : -1;
}

function nudge(a: CardAnim, reduced: boolean, strength: number): void {
  if (reduced) pop(a, -0.09, FEEL.reducedFade);
  else {
    a.wobble.impulse(a.index % 2 === 0 ? strength : -strength);
    a.squash.impulse(-2.2);
  }
}

/**
 * Advances one card. Pure struct mutation — no allocation, no branching on React state.
 * `elapsed` is the scene clock, used only for the idle breath.
 */
function stepCard(a: CardAnim, dt: number, reduced: boolean, elapsed: number): void {
  if (a.hopDelay >= 0) {
    a.hopDelay -= dt;
    if (a.hopDelay <= 0) {
      a.hopDelay = -1;
      if (reduced) pop(a, -0.14, FEEL.reducedFade);
      else {
        a.hop.impulse(HOP_IMPULSE);
        a.squash.impulse(-4.5);
      }
    }
  }

  if (a.phase === PH_FLIP) {
    a.t += dt;
    const k = clamp01(a.t / a.dur);
    if (reduced) {
      // No travel at all: the faces swap at the midpoint of a short scale pop.
      a.angle = k < 0.5 ? a.from : a.to;
      a.lift = 0;
    } else {
      a.angle = a.from + (a.to - a.from) * anticipate(flipK(k), 0.14);
      a.lift =
        k < FLIP_DIP_END
          ? -FLIP_DIP * Math.sin((k / FLIP_DIP_END) * Math.PI)
          : FLIP_LIFT * Math.sin(((k - FLIP_DIP_END) / (1 - FLIP_DIP_END)) * Math.PI);
      if (!a.snapped && k > 0.82) {
        a.snapped = true;
        a.squash.impulse(SNAP_IMPULSE);
      }
    }
    if (a.t >= a.dur) {
      a.phase = PH_IDLE;
      a.angle = a.to;
      a.lift = 0;
      a.t = 0;
    }
  } else if (a.phase === PH_MATCH) {
    a.t += dt;
    const k = clamp01(a.t / a.dur);
    if (reduced) {
      a.lift = PRESS_DELTA * easeOutCubic(k);
    } else if (k < 0.3) {
      a.lift = MATCH_LIFT * easeOutBack(k / 0.3, 1.8);
    } else if (k < 0.52) {
      a.lift = MATCH_LIFT;
    } else {
      const q = (k - 0.52) / 0.48;
      a.lift = MATCH_LIFT + (PRESS_DELTA - MATCH_LIFT) * easeInCubic(q);
      if (!a.snapped && q > 0.88) {
        a.snapped = true;
        a.squash.impulse(MATCH_IMPULSE);
      }
    }
    if (a.t >= a.dur) {
      a.phase = PH_IDLE;
      a.t = 0;
      a.lift = 0;
      a.restY = PRESS_Y;
    }
  }

  a.hop.to(0);
  a.wobble.to(0);
  a.squash.to(0);
  a.hop.step(dt);
  a.wobble.step(dt);
  a.squash.step(dt);

  let popAmount = 0;
  if (a.popT > 0) {
    a.popT -= dt;
    const q = clamp01(1 - a.popT / a.popDur);
    popAmount = a.popAmp * Math.sin(q * Math.PI);
  }

  let bob = 0;
  let tilt = 0;
  if (!reduced && a.phase === PH_IDLE) {
    const amp = a.matched ? 0.0025 : 0.006;
    bob = Math.sin(elapsed * 1.15 + a.seed) * amp;
    tilt = Math.sin(elapsed * 0.83 + a.seed * 1.7) * (a.matched ? 0.004 : 0.012);
  }

  a.y = a.restY + a.lift + a.hop.value + bob;
  a.spin = a.wobble.value + tilt;
  a.squashOut = a.squash.value + popAmount;

  // The "this one is done" colour. Reduced motion still gets it, just as a 150 ms fade —
  // it is information, not decoration, so it is never switched off.
  const tintTarget = a.matched ? 1 : 0;
  if (a.tint !== tintTarget) {
    const rate = dt / (reduced ? FEEL.reducedFade : TINT_DUR);
    a.tint = tintTarget > a.tint ? Math.min(1, a.tint + rate) : Math.max(0, a.tint - rate);
    a.tintDirty = true;
  }

  // The relief is folded away while the card is face down, so it can never be caught
  // pointing through the table — and it grows back out with a pop as the card turns.
  // Under reduced motion the angle snaps, so the reveal is driven by the pop's own clock
  // instead: a 150 ms scale in or out, matching the card's cross-fade.
  if (reduced && a.phase === PH_FLIP) {
    const k = clamp01(a.t / a.dur);
    a.faceOut = a.to === FACE_UP ? clamp01((k - 0.4) / 0.6) : clamp01(1 - k / 0.6);
  } else {
    const raw = clamp01((MOTIF_ON_ANGLE - a.angle) / MOTIF_FADE);
    a.faceOut = raw <= 0 ? 0 : reduced ? raw : easeOutBack(raw, MOTIF_POP_BACK);
  }
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
function burst(field: SparkleField, x: number, y: number, z: number, count: number, reduced: boolean): void {
  for (let k = 0; k < count; k++) {
    const i = field.next;
    field.next = (field.next + 1) % field.n;
    if (field.dur[i] <= 0) field.live++;
    field.px[i] = x + (Math.random() - 0.5) * 0.34;
    field.py[i] = y + Math.random() * 0.16;
    field.pz[i] = z + (Math.random() - 0.5) * 0.34;
    const a = Math.random() * Math.PI * 2;
    const e = 0.3 + Math.random() * 0.9;
    const s = reduced ? 0 : 0.8 + Math.random() * 0.7;
    field.vx[i] = Math.cos(a) * Math.cos(e) * s;
    field.vy[i] = Math.sin(e) * s + (reduced ? 0 : 0.55);
    field.vz[i] = Math.sin(a) * Math.cos(e) * s;
    field.life[i] = 0;
    field.dur[i] = reduced ? 0.3 : 0.62 + Math.random() * 0.3;
    field.size[i] = 0.17 + Math.random() * 0.13;
  }
}

/** Kills every live sparkle so a restart does not leave the previous run in the air. */
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
      field.vy[i] -= 3.4 * dt;
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

type CardNode = {
  key: number;
  index: number;
  label: string;
  /** Which of the eight this card carries — the key into the motif table. */
  motifId: MotifId;
  /** Spoken name of this card's motif, for the label a solved card carries. */
  motifLabel: string;
  /** `aAlbedo` ratio the printed panel starts at, off `mauve.soft`. See `PANEL_BASE`. */
  panelBase: { r: number; g: number; b: number };
  hit: [number, number, number];
  /**
   * The relief, and the placement `fitRelief` solved for it — **empty until the table is
   * built**, which is one frame after the board first draws. See `useMotifs` for why.
   *
   * These are mutated in place rather than rebuilt, so the node identity (and with it every
   * `ref`, and every card's whole animation state) survives the reliefs arriving.
   */
  parts: MotifPart[];
  /**
   * Where this card's relief stands and how big it is, solved by `fitRelief` from the
   * motif's own vertices — see `motifs.ts`. Per motif, not per card: a toothbrush and a
   * star have no shared physical scale, and one number for both would have to serve the
   * worse of them.
   */
  motifPos: [number, number, number];
  motifScale: number;
  slot: RefObject<Group>;
  card: RefObject<Group>;
  motif: RefObject<Group>;
  anim: CardAnim;
};

/** Nothing to draw until `buildMotifs()` has run; shared, never mutated. */
const NO_PARTS: MotifPart[] = [];

/**
 * Copies a built motif table onto the card nodes.
 *
 * In place, deliberately: `nodes` is memoised on the deal, and rebuilding it when the
 * reliefs arrive would replace every `RefObject` and every `CardAnim` — i.e. reset the board
 * mid-animation. The React tree still needs one render to mount the meshes, which
 * `setMotifVersion` provides.
 */
function applyMotifs(nodes: CardNode[], table: MotifTable): void {
  for (const node of nodes) {
    const fitted = table[node.motifId];
    node.parts = fitted.parts;
    node.motifScale = fitted.scale;
    // A fresh tuple, not a write into the old one: R3F compares props by reference, so
    // mutating the array in place would leave the group at z = 0 for ever.
    node.motifPos = [0, MOTIF_DZ, fitted.z];
  }
}

const FLAT_ROT: [number, number, number] = [-Math.PI / 2, 0, 0];


function ToothMatchSceneImpl({
  engine,
  boardScale,
}: {
  engine: ToothMatchEngine;
  boardScale: number;
}): JSX.Element {
  /** Bumped by the `deal` event — the only engine event that re-renders this component. */
  const [dealId, setDealId] = useState(0);

  const bag = useMemo(() => new DisposalBag(), []);
  const sparkles = useMemo(() => createSparkles(SPARKLES), []);

  const level = engine.level;
  const grid = useMemo(() => gridFor(level), [level]);
  const tray = useMemo(() => trayFor(grid), [grid]);

  /* ---------------- board resources (all shared + cached) ---------------- */

  const trayGeo = useMemo(() => clayTray(tray.w, tray.d, TABLE_H, TABLE_RIM), [tray]);
  const matGeo = useMemo(
    () => roundedPlate(grid.width + MAT_MARGIN, grid.depth + MAT_MARGIN, MAT_T, 0.3, 1),
    [grid]
  );

  /**
   * The card body is the one geometry this scene owns rather than borrows.
   *
   * A per-instance albedo attribute has to live on the *geometry*, and `cachedGeometry()`
   * hands back an object shared with every other scene for the life of the WebGL context —
   * attaching to it would leak this board's colours into whatever asks for the same plate
   * next. So: clone, attach, and dispose it with the scene.
   */
  const cardBody = useMemo(() => {
    const geometry = roundedPlate(CARD_W, CARD_H, CARD_T, CARD_CORNER).clone();
    const albedo = ensureInstanceAlbedo(geometry, MAX_CARDS);
    return { geometry, albedo };
  }, []);

  // Same treatment, same reason. Detail 1 on the panel: it is a flat inset field seen
  // face-on, its rim roll sits under the relief, and sixteen of them at the default tier
  // were 6k triangles for nothing.
  const panel = useMemo(() => {
    const geometry = roundedPlate(
      CARD_W - INLAY_INSET,
      CARD_H - INLAY_INSET,
      INLAY_T,
      CARD_CORNER - 0.07,
      1
    ).clone();
    const albedo = ensureInstanceAlbedo(geometry, MAX_CARDS);
    return { geometry, albedo };
  }, []);
  // The medallion keeps the default tier: its rim roll is the whole point (see `BACK_T`).
  // A `roundedBox`, not a `roundedPlate`, because the roll has to be set rather than
  // derived from the thickness — see `BACK_ROLL`.
  const backGeo = useMemo(
    () => roundedBox(CARD_W - BACK_INSET, CARD_H - BACK_INSET, BACK_T, BACK_ROLL),
    []
  );
  const emblemGeo = useMemo(
    () => beveledExtrude(emblemShape(), { depth: EMBLEM_DEPTH, bevel: EMBLEM_BEVEL }),
    []
  );
  const blobGeo = useMemo(() => cachedGeometry("tooth-match/quad", () => new PlaneGeometry(1, 1)), []);

  const trayMat = useMemo(
    () => clay("tooth-match/table", { color: CLAY.ivoryDeep, roughness: 0.76, sheen: 0.2, grain: 0.13 }),
    []
  );
  const matMat = useMemo(
    () => clay("tooth-match/mat", { color: NEUTRAL.well, roughness: 0.8, sheen: 0.12, grain: 0.17 }),
    []
  );
  const cardMat = useMemo(() => clayIvory(), []);
  /**
   * The printed panel.
   *
   * It used to be `CLAY.enamel` — `#fdfaf3`, the *exact same hex* as the `clayEnamel` tooth
   * relief standing on it, which is how a memory game shipped with cards nobody could tell
   * apart (measured 1.03:1 and 1.10:1 on four of the eight motifs). A warm mauve field is
   * light enough to keep the coloured reliefs at 2.6–4.7:1 while still giving the one motif
   * that has to stay ivory-white a real silhouette to read against.
   */
  const inlayMat = useMemo(() => clayAccent("mauve", "soft"), []);
  /** `red`, because `src/games/index.ts` registers this game as `red`. */
  const backMat = useMemo(() => clayAccent("red", "main"), []);
  /**
   * Warm-on-warm, and never light-on-red: see `emblemShape` in `motifs.ts` for why the old
   * `red.soft`-on-`red.main` pairing could not ship.
   */
  const emblemMat = useMemo(() => clayAccent("peach", "main"), []);
  const blobMat = useMemo(() => shadowBlobMaterial(), []);

  /**
   * With `cardBody.geometry`, one of the two resources this game constructs itself and
   * therefore has to free. Everything else came from a `markShared` cache and is not ours
   * to dispose.
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
    bag.add(cardBody.geometry);
    bag.add(panel.geometry);
    return () => bag.release();
  }, [bag, sparkleMat, cardBody, panel]);

  /* ---------------- the reliefs, off the entry frame (TM3) ---------------- */

  /*
   * ## Why `buildMotifs()` no longer runs in the mount commit
   *
   * Round 4 measured a **54.6 ms** entry hitch here — 3.3 dropped frames at 60 Hz against the
   * app's own 50 ms budget — and named the cause: `buildMotifs()` runs eight relief builds,
   * each an extrude or a lathe followed by `mergeVertices` and `bakeCurvatureAO`, inside the
   * same commit as two `roundedPlate().clone()`s, two `ensureInstanceAlbedo`s, the tray and
   * the mat.
   *
   * The fix the list asks for is the one the game's own rules make free: **a fresh board is
   * entirely face down, and a face-down card draws no relief at all.** `stepCard` already
   * folds every relief to `visible = false` above `MOTIF_ON_ANGLE`, so for the whole of the
   * entry — and until a child's first tap, which is at minimum a few hundred milliseconds of
   * transition away — the eight motifs are geometry nothing is looking at.
   *
   * So they are built on the second animation frame after mount. Two `requestAnimationFrame`s,
   * not one: the first callback runs *inside* the frame R3F is already rendering, so building
   * there would land in the same presented frame the hitch was measured on. The second is the
   * first frame the board has already been shown in.
   *
   * `ensureMotifs()` is also called synchronously from the `flip` event, so a driven run (or a very
   * fast child) that taps before the timer fires gets the relief in the same frame it asked
   * for it rather than a card that turns over empty. That path is the pre-round-4 behaviour
   * and costs exactly what it used to; it is just no longer on the entry frame.
   *
   * The `motifs` state exists only to schedule the one render that mounts the meshes — the
   * fit itself is written onto the (stable) nodes by `applyMotifs`, so no card loses its refs
   * or its animation state. `motifsRef` is what the same-frame flip path reads, because a
   * `setState` from an engine event is not visible until the next render and the flip needs
   * the table *now*.
   */
  const motifsRef = useRef<MotifTable | null>(null);
  const [motifs, setMotifs] = useState<MotifTable | null>(null);
  const nodesRef = useRef<CardNode[]>([]);

  const ensureMotifs = useCallback((): MotifTable => {
    let table = motifsRef.current;
    if (table === null) {
      table = buildMotifs();
      motifsRef.current = table;
      applyMotifs(nodesRef.current, table);
      // The ref is what the same-frame flip path reads; this schedules the one render that
      // mounts the meshes.
      setMotifs(table);
    }
    return table;
  }, []);

  /*
   * The two self-checks, behind the query flag so nothing here reaches a child's bundle.
   * `?selftest=tooth-match` runs both; see `verify.ts` for what each exists because of.
   */
  useEffect(() => {
    if (!FLAGS.selftest) return;
    let alive = true;
    void import("./verify").then((mod) => {
      if (alive) mod.registerToothMatchChecks();
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (motifsRef.current !== null) return;
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => {
        ensureMotifs();
      });
    });
    return () => {
      cancelAnimationFrame(outer);
      if (inner !== 0) cancelAnimationFrame(inner);
    };
  }, [ensureMotifs]);

  /* ---------------- per-deal nodes ---------------- */

  const nodes = useMemo<CardNode[]>(() => {
    const out: CardNode[] = [];
    const g = gridFor(engine.level);
    const table = motifsRef.current;
    for (let i = 0; i < engine.cards.length; i++) {
      const card = engine.cards[i];
      const gx = cardX(i, g);
      const gz = cardZ(i, g);
      const fitted = table === null ? null : table[card.id];
      out.push({
        key: card.key,
        index: i,
        label: `Card ${i + 1}, row ${Math.floor(i / g.cols) + 1}, column ${(i % g.cols) + 1}`,
        motifId: card.id,
        motifLabel: MOTIF_LABELS[card.id],
        panelBase: panelBaseFor(card.id),
        hit: [gx, REST_Y + 0.18, gz],
        parts: fitted === null ? NO_PARTS : fitted.parts,
        motifPos: [0, MOTIF_DZ, fitted === null ? 0 : fitted.z],
        motifScale: fitted === null ? 0 : fitted.scale,
        slot: createRef<Group>(),
        card: createRef<Group>(),
        motif: createRef<Group>(),
        anim: createAnim(i, gx, gz),
      });
    }
    return out;
    // `dealId` is the dependency that matters: it changes exactly when `engine.cards` does.
    // `motifs` is *not* a dependency: the table is written onto these nodes in place so
    // that a re-deal is the only thing that ever replaces them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, dealId]);

  /** Read from the event callback, which is bound once and must not close over a stale deal. */
  nodesRef.current = nodes;

  const bodyRef = useRef<InstancedMesh>(null);
  const inlayRef = useRef<InstancedMesh>(null);
  const backRef = useRef<InstancedMesh>(null);
  const emblemRef = useRef<InstancedMesh>(null);
  const blobRef = useRef<InstancedMesh>(null);
  const sparkRef = useRef<InstancedMesh>(null);
  /** The cards, as one node, so the celebration can take the board off the table. */
  const stageRef = useRef<Group>(null);

  /* ---------------- instance buffers ---------------- */

  useLayoutEffect(() => {
    const count = nodes.length;
    const meshes = [bodyRef.current, inlayRef.current, backRef.current, emblemRef.current, blobRef.current];
    for (const mesh of meshes) {
      if (!mesh) continue;
      mesh.count = count;
      mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    }
  }, [nodes]);

  useLayoutEffect(() => {
    const mesh = sparkRef.current;
    if (!mesh) return;
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    // InstancedMesh starts life with identity matrices, which would park a full-size
    // sparkle at the origin until the first burst. Collapse them all up front.
    const zero = new Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < SPARKLES; i++) mesh.setMatrixAt(i, zero);
    mesh.instanceMatrix.needsUpdate = true;
  }, []);

  /* ---------------- solved cards: focus, labels, disabled ---------------- */

  /**
   * Bumped when a pair resolves. It re-renders the JSX (not `nodes`, whose memo does not
   * depend on it), which is what lets a solved card's `HitTarget` pick up `disabled` and a
   * "matched" label. At most eight bumps in a run, all from a timer callback.
   */
  const [resolved, setResolved] = useState(0);

  /** Focus order to restore after the two solved buttons are rebuilt; -1 = nothing to do. */
  const refocus = useRef(-1);

  useEffect(() => {
    const order = refocus.current;
    if (order < 0) return;
    refocus.current = -1;
    // A passive effect, deliberately: `HitTarget` rebuilds its button in a passive effect
    // too, and a child's runs before its parent's — so by here the new button exists.
    const container = document.querySelector<HTMLElement>(`[data-group="${GROUP}"]`);
    container?.querySelector<HTMLElement>(`button[data-order="${order}"]`)?.focus();
  }, [resolved]);

  /* ---------------- engine events ---------------- */

  useEffect(
    () =>
      engine.on((event) => {
        const list = nodesRef.current;
        const reduced = isReduced();
        switch (event.type) {
          case "deal":
            resetSparkles(sparkles);
            setDealId((v) => v + 1);
            break;
          case "flip":
            // Synchronous, and only ever on the first flip of a mount: a card must never
            // turn over empty. See `ensureMotifs`.
            ensureMotifs();
            if (list[event.index]) startFlip(list[event.index].anim, true, reduced);
            break;
          case "hide":
            if (list[event.a]) startFlip(list[event.a].anim, false, reduced);
            if (list[event.b]) startFlip(list[event.b].anim, false, reduced);
            break;
          case "miss":
            if (list[event.a]) nudge(list[event.a].anim, reduced, 4.5);
            if (list[event.b]) nudge(list[event.b].anim, reduced, 4.5);
            break;
          case "match": {
            const a = list[event.a];
            const b = list[event.b];
            if (a) startMatch(a.anim, reduced);
            if (b) startMatch(b.anim, reduced);
            if (a && b) {
              burst(
                sparkles,
                (a.anim.gx + b.anim.gx) * 0.5,
                REST_Y + 0.45,
                (a.anim.gz + b.anim.gz) * 0.5,
                reduced ? 4 : 8,
                reduced
              );
            }
            // Both cards are about to stop being keyboard targets, and `hit.tsx` rebuilds
            // its hidden button when `disabled` or `ariaLabel` changes — which drops focus
            // to `<body>` if the child was standing on one of them. Remember where they
            // were now, while the old button is still the active element.
            refocus.current = focusedOrderIn(GROUP, event.a, event.b);
            setResolved((v) => v + 1);
            break;
          }
          case "complete":
            for (let i = 0; i < list.length; i++) list[i].anim.hopDelay = i * CELEBRATE_STAGGER;
            burst(sparkles, 0, REST_Y + 0.7, 0, reduced ? 6 : 14, reduced);
            break;
          case "reject":
            if (list[event.index]) nudge(list[event.index].anim, reduced, 2.2);
            break;
          default:
            break;
        }
      }),
    [engine, sparkles, ensureMotifs]
  );

  /* ---------------- keyboard ---------------- */

  /*
   * Roving arrow-key focus across the whole grid.
   *
   * `MAX_CARDS`, not `nodes.length`, and that is deliberate — copy it. `useFocusGroup`
   * releases and re-takes its reference on the group whenever `count` changes, and a
   * re-deal *also* unmounts every `HitTarget` before the new ones mount. If the hook let
   * go at the same moment, the group's reference count would touch zero mid-commit, its
   * hidden container would be removed from the DOM, and the new cards would register into
   * a detached node — arrow keys and VoiceOver would go quiet with nothing in the console.
   * A constant count keeps one live reference for the scene's whole life. The value itself
   * is unused here: `count` only drives groups that have no `HitTarget`s of their own.
   *
   * Each card's own `HitTarget` owns activation, so this `onActivate` is a fallback that
   * never fires in practice — it exists so pointer and keyboard cannot diverge.
   */
  useFocusGroup(GROUP, MAX_CARDS, (index) => engine.tap(index));

  /* ---------------- the frame ---------------- */

  useFrame((state, delta) => {
    const body = bodyRef.current;
    const inlay = inlayRef.current;
    const back = backRef.current;
    const emblem = emblemRef.current;
    const blob = blobRef.current;
    const spark = sparkRef.current;
    if (!body || !inlay || !back || !emblem || !blob) return;

    const dt = safeDelta(delta);
    const reduced = isReduced();
    const elapsed = state.clock.elapsedTime;

    // The hand-off. 1 for the whole run, then eased to exactly 0 across the shared window.
    const stage = stageRef.current;
    if (stage) {
      const exit = celebrationHeroScale();
      stage.scale.set(exit, exit, exit);
    }

    const list = nodesRef.current;
    const bodyAlbedo = cardBody.albedo;
    const panelAlbedo = panel.albedo;
    let albedoDirty = false;

    for (let i = 0; i < list.length; i++) {
      const node = list[i];
      const slot = node.slot.current;
      const card = node.card.current;
      if (!slot || !card) continue;
      const a = node.anim;

      stepCard(a, dt, reduced, elapsed);

      slot.position.set(a.gx, a.y, a.gz);
      slot.rotation.y = a.spin;
      slot.updateMatrix();

      card.rotation.z = a.angle;
      squashFor(_squash, a.squashOut, 1, 0.3);
      card.scale.set(_squash.x, _squash.y, _squash.z);
      card.updateMatrix();

      _card.multiplyMatrices(slot.matrix, card.matrix);
      _part.multiplyMatrices(_card, PART_BODY);
      body.setMatrixAt(i, _part);
      _part.multiplyMatrices(_card, PART_INLAY);
      inlay.setMatrixAt(i, _part);
      _part.multiplyMatrices(_card, PART_BACK);
      back.setMatrixAt(i, _part);
      _part.multiplyMatrices(_card, PART_EMBLEM);
      emblem.setMatrixAt(i, _part);

      if (a.tintDirty) {
        a.tintDirty = false;
        // easeOutCubic, so "solved" lands almost immediately and then settles, instead of
        // creeping in linearly over the whole 220 ms.
        const k = easeOutCubic(a.tint);
        _albedo.setRGB(
          1 + (BODY_TINT.r - 1) * k,
          1 + (BODY_TINT.g - 1) * k,
          1 + (BODY_TINT.b - 1) * k
        );
        writeAlbedo(bodyAlbedo, i, _albedo);
        const base = node.panelBase;
        _albedo.setRGB(
          base.r + (PANEL_TINT.r - base.r) * k,
          base.g + (PANEL_TINT.g - base.g) * k,
          base.b + (PANEL_TINT.b - base.b) * k
        );
        writeAlbedo(panelAlbedo, i, _albedo);
        albedoDirty = true;
      }

      const motif = node.motif.current;
      if (motif) {
        // Hidden as well as collapsed: a face-down board draws no relief meshes at all,
        // which is most of this game's draw-call headroom.
        motif.visible = a.faceOut > 0.002;
        const s = a.faceOut * node.motifScale;
        motif.scale.set(s, s, s);
      }

      /*
       * Close-contact darkening, on the shared physics rather than this file's own.
       *
       * Round 4's A3 gave `Rig.tsx` a real answer for a decal under a prop that leaves its
       * receiver: the footprint **grows** by the key's tangent half-angle times the lift, and
       * the contact term **falls to zero** by `CONTACT_FADE_LIFT`, past which the cast shadow
       * is the whole shadow and a decal on top of it is a sticker hiding the PCSS solve. This
       * used a local `BLOB_FADE` that shrank the quad linearly over 0.16 — the right
       * direction for the fade and the wrong one for the size, and 3x too long a window.
       *
       * One honest limitation, stated rather than hidden: sixteen cards share one
       * `InstancedMesh` and therefore one material, so there is no per-instance opacity to
       * drive. The fade is applied to the quad's *size* instead. Over the 0.05-unit window
       * that is about three frames of a flip, and the blob is fully covered by its own card
       * for all of them.
       */
      const lift = a.y > REST_Y ? a.y - REST_Y : 0;
      const fade = contactOpacityFor(1, lift);
      const w = fade <= 0 ? 0 : 2 * contactShadowRadius(CARD_W / 2, lift) * fade;
      const d = fade <= 0 ? 0 : 2 * contactShadowRadius(CARD_H / 2, lift) * fade;
      _pos.set(a.gx, MAT_Y + 0.006, a.gz);
      _scl.set(w < 1e-4 ? 1e-4 : w, d < 1e-4 ? 1e-4 : d, 1);
      _part.compose(_pos, BLOB_QUAT, _scl);
      blob.setMatrixAt(i, _part);
    }

    body.instanceMatrix.needsUpdate = true;
    inlay.instanceMatrix.needsUpdate = true;
    back.instanceMatrix.needsUpdate = true;
    emblem.instanceMatrix.needsUpdate = true;
    blob.instanceMatrix.needsUpdate = true;
    // Only on frames where a card's tint actually moved — at most 220 ms per matched pair.
    if (albedoDirty) {
      bodyAlbedo.needsUpdate = true;
      panelAlbedo.needsUpdate = true;
    }

    if (spark) {
      // Collapsed instances still cost a draw call and still land in
      // `renderer.info.triangles`. The field is empty for most of a run, so take it out of
      // the list entirely rather than submitting 26 degenerate quads a frame.
      spark.visible = sparkles.live > 0;
      stepSparkles(sparkles, spark, state.camera.quaternion, dt, reduced);
    }
  });

  /* ---------------- graph ---------------- */

  return (
    <Rig shadowArea={shadowAreaFor(level) * boardScale} groundY={0}>
      {/*
        The whole board, at the scale the camera solve asked for.

        `boardScale` is 1 on every viewport where 3D-SPEC §2's 8–16 distance band can frame
        the board, and below it on a portrait phone, where round 3 measured the solve giving
        up and pushing the outer column and its focus ring off the frame. Scaling the board
        by `s` at distance `r` is pixel-identical to the unscaled board at `r / s` — see
        `MIN_BOARD_SCALE` — so this is the same photograph, taken with the camera the spec
        allows. The ground plane is at y = 0 and the group scales about the origin, so
        nothing lifts off the table; `Rig`'s shadow frustum takes the same factor above.

        `<HitTarget>`s live inside it too, and their `radius` is passed pre-scaled, because
        `hit.tsx` divides by the parent's world scale and treats `radius` as a world
        quantity.
      */}
      <group scale={boardScale}>
        <ContactBlob position={[0, 0.004, 0]} radius={contactRadiusFor(tray)} opacity={0.3} />

        <mesh geometry={trayGeo} material={trayMat} castShadow receiveShadow />
        <mesh geometry={matGeo} material={matMat} rotation={FLAT_ROT} position-y={MAT_Y - MAT_T / 2} receiveShadow />

        {/*
          The cards, and the celebration hand-off.

          The shared celebration renders *inside this view*, sharing this camera, this depth
          buffer and this `<Rig>`. Without this group the board of sixteen cards is still lying
          there when the celebration's mascot arrives on its podium in the middle of it. The
          board takes its bow first (`complete` staggers a hop down the whole board and fires a
          sparkle burst), then `celebrationHeroScale()` pops the cards away and leaves the tray
          they were lying in as the celebration's table.
        */}
        <group ref={stageRef}>
          {/*
            Only the card body casts. The inlay, the medallion and the rosette all sit inside
            the body's own outline, so their shadows would be identical to one already being
            drawn — three shadow-pass draw calls a frame for nothing.
          */}
          <instancedMesh
            ref={bodyRef}
            args={[cardBody.geometry, cardMat, MAX_CARDS]}
            frustumCulled={false}
            castShadow
            receiveShadow
          />
          <instancedMesh
            ref={inlayRef}
            args={[panel.geometry, inlayMat, MAX_CARDS]}
            frustumCulled={false}
            receiveShadow
          />
          <instancedMesh ref={backRef} args={[backGeo, backMat, MAX_CARDS]} frustumCulled={false} receiveShadow />
          <instancedMesh ref={emblemRef} args={[emblemGeo, emblemMat, MAX_CARDS]} frustumCulled={false} receiveShadow />
          <instancedMesh ref={blobRef} args={[blobGeo, blobMat, MAX_CARDS]} frustumCulled={false} renderOrder={2} />

          {nodes.map((node) => (
            <group key={node.key} ref={node.slot} matrixAutoUpdate={false}>
              <group ref={node.card} matrixAutoUpdate={false}>
                <group ref={node.motif} position={node.motifPos} visible={false}>
                  {/* Empty until `ensureMotifs` has run — see the comment on it (TM3). */}
                  {motifs === null ? null : node.parts.map((p, k) => (
                    <mesh
                      key={k}
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
          ))}

        </group>

        {/*
          Outside the hand-off group: the sparkles the win fires are the last thing the board
          does and they read as part of the burst, not as a prop left standing.
        */}
        <instancedMesh
          ref={sparkRef}
          args={[blobGeo, sparkleMat, SPARKLES]}
          frustumCulled={false}
          renderOrder={6}
        />

        {/*
          `engine.state` is read in render, and that is safe here *only* because `resolved`
          gates it: the array is mutated by the engine before every event, and `match` is the
          one event that changes a card's `MATCHED` bit and also bumps `resolved`. A solved
          card then stops being an activation target and says so out loud, instead of leaving
          a screen-reader player to walk eight dead cards to reach two live ones.
        */}
        {nodes.map((node) => {
          const solved = engine.state[node.index] === MATCHED;
          return (
            <HitTarget
              key={node.key}
              ariaLabel={solved ? `${node.label}. Matched, ${node.motifLabel}.` : node.label}
              group={GROUP}
              focusOrder={node.index}
              position={node.hit}
              radius={HIT_RADIUS * boardScale}
              minScreenPx={48}
              disabled={solved}
              onPress={() => pressCard(node.anim, isReduced())}
              onRelease={() => releaseCard(node.anim, isReduced())}
              onSelect={() => engine.tap(node.index)}
            />
          );
        })}
      </group>
    </Rig>
  );
}

/**
 * Memoised on `engine`, which never changes identity — so the shell re-rendering its HUD
 * once a second (or on any flip) does not touch the 3D tree at all.
 */
export const ToothMatchScene = memo(ToothMatchSceneImpl);
