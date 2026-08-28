/**
 * Motion vocabulary for the whole product.
 *
 * Rule from the spec: nothing a child touches moves on `linear` or `ease-in-out`.
 * Presses, pops, flips and catches wind up, overshoot, then settle. Everything here is
 * allocation-free once constructed, so it is safe inside `useFrame`.
 */
import type { Object3D } from "three";
import { isReduced } from "./store";

/* ------------------------------------------------------------------ */
/* Easing                                                              */
/* ------------------------------------------------------------------ */

export const clamp01 = (t: number) => (t < 0 ? 0 : t > 1 ? 1 : t);

export const easeOutCubic = (t: number) => 1 - Math.pow(1 - clamp01(t), 3);
export const easeInCubic = (t: number) => clamp01(t) ** 3;
export const easeInOutCubic = (t: number) =>
  clamp01(t) < 0.5 ? 4 * clamp01(t) ** 3 : 1 - Math.pow(-2 * clamp01(t) + 2, 3) / 2;
export const easeOutQuint = (t: number) => 1 - Math.pow(1 - clamp01(t), 5);

/** Overshoot-and-settle. `s` 1.6–2.0 for a lively kid-toy pop. */
export const easeOutBack = (t: number, s = 1.7) => {
  const x = clamp01(t) - 1;
  return 1 + (s + 1) * x * x * x + s * x * x;
};

/** Wind-up then release — the anticipation curve for pickups and launches. */
export const easeInBack = (t: number, s = 1.7) => {
  const x = clamp01(t);
  return (s + 1) * x * x * x - s * x * x;
};

export const easeOutElastic = (t: number, amplitude = 1, period = 0.32) => {
  const x = clamp01(t);
  if (x === 0 || x === 1) return x;
  return amplitude * Math.pow(2, -10 * x) * Math.sin(((x - period / 4) * (2 * Math.PI)) / period) + 1;
};

/** Small dip against the direction of travel, then the real move. 0..1 -> -0.12..1 */
export const anticipate = (t: number, dip = 0.12) => {
  const x = clamp01(t);
  if (x < 0.28) return -dip * Math.sin((x / 0.28) * Math.PI);
  return easeOutBack((x - 0.28) / 0.72, 1.6);
};

/** Bounce-in-place used for landings and "oops" wobbles. */
export const easeOutBounce = (t: number) => {
  let x = clamp01(t);
  const n = 7.5625;
  const d = 2.75;
  if (x < 1 / d) return n * x * x;
  if (x < 2 / d) return n * (x -= 1.5 / d) * x + 0.75;
  if (x < 2.5 / d) return n * (x -= 2.25 / d) * x + 0.9375;
  return n * (x -= 2.625 / d) * x + 0.984375;
};

/* ------------------------------------------------------------------ */
/* Frame-rate independent smoothing                                    */
/* ------------------------------------------------------------------ */

/** Exponential approach that behaves identically at 30, 60 and 120 fps. */
export const damp = (current: number, target: number, lambda: number, dt: number) =>
  target + (current - target) * Math.exp(-lambda * dt);

/** In-place damp of an x/y/z triple. Allocation free. */
export function damp3(
  out: { x: number; y: number; z: number },
  tx: number,
  ty: number,
  tz: number,
  lambda: number,
  dt: number
): void {
  const k = Math.exp(-lambda * dt);
  out.x = tx + (out.x - tx) * k;
  out.y = ty + (out.y - ty) * k;
  out.z = tz + (out.z - tz) * k;
}

/** Shortest-path angular damp, keeps rotations from unwinding the long way round. */
export function dampAngle(current: number, target: number, lambda: number, dt: number) {
  let delta = (target - current) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta < -Math.PI) delta += Math.PI * 2;
  return current + delta * (1 - Math.exp(-lambda * dt));
}

/* ------------------------------------------------------------------ */
/* Springs                                                             */
/* ------------------------------------------------------------------ */

/**
 * A single-value spring integrated with a fixed sub-step so it stays stable when the
 * browser hands us a long frame. Defaults are the product's house feel: a quick,
 * slightly overshooting settle.
 */
export class Spring {
  value: number;
  velocity = 0;
  target: number;
  stiffness: number;
  damping: number;

  constructor(value = 0, stiffness = 320, damping = 22) {
    this.value = value;
    this.target = value;
    this.stiffness = stiffness;
    this.damping = damping;
  }

  /** Jump to a value with no motion — use on reset, never mid-interaction. */
  set(value: number): this {
    this.value = value;
    this.target = value;
    this.velocity = 0;
    return this;
  }

  to(target: number): this {
    this.target = target;
    return this;
  }

  /** Adds velocity — how a tap, a catch or a bump kicks an object. */
  impulse(v: number): this {
    this.velocity += v;
    return this;
  }

  step(dt: number): number {
    if (isReduced()) {
      // Reduced motion still settles, just without the overshoot travel.
      this.value = damp(this.value, this.target, 26, Math.min(dt, 0.05));
      this.velocity = 0;
      return this.value;
    }
    let remaining = Math.min(dt, 0.05);
    const h = 1 / 240;
    while (remaining > 0) {
      const step = remaining > h ? h : remaining;
      const a = (this.target - this.value) * this.stiffness - this.velocity * this.damping;
      this.velocity += a * step;
      this.value += this.velocity * step;
      remaining -= step;
    }
    return this.value;
  }

  get settled() {
    return Math.abs(this.velocity) < 0.001 && Math.abs(this.target - this.value) < 0.0005;
  }
}

/** Three independent springs sharing one config — position, scale, whatever. */
export class Spring3 {
  x: Spring;
  y: Spring;
  z: Spring;

  constructor(x = 0, y = 0, z = 0, stiffness = 320, damping = 22) {
    this.x = new Spring(x, stiffness, damping);
    this.y = new Spring(y, stiffness, damping);
    this.z = new Spring(z, stiffness, damping);
  }

  set(x: number, y: number, z: number): this {
    this.x.set(x);
    this.y.set(y);
    this.z.set(z);
    return this;
  }

  to(x: number, y: number, z: number): this {
    this.x.to(x);
    this.y.to(y);
    this.z.to(z);
    return this;
  }

  step(dt: number): void {
    this.x.step(dt);
    this.y.step(dt);
    this.z.step(dt);
  }

  /** Writes straight onto an Object3D field — no allocation, no React. */
  applyPosition(obj: Object3D): void {
    obj.position.set(this.x.value, this.y.value, this.z.value);
  }

  applyScale(obj: Object3D): void {
    obj.scale.set(this.x.value, this.y.value, this.z.value);
  }

  get settled() {
    return this.x.settled && this.y.settled && this.z.settled;
  }
}

/* ------------------------------------------------------------------ */
/* Squash & stretch                                                    */
/* ------------------------------------------------------------------ */

/**
 * Volume-preserving squash. `amount` > 0 stretches along the motion axis (falling),
 * < 0 squashes (impact). Writes into `out` so it can run every frame for free.
 */
export function squashFor(
  out: { x: number; y: number; z: number },
  amount: number,
  base = 1,
  limit = 0.34
): void {
  const a = amount > limit ? limit : amount < -limit ? -limit : amount;
  const along = base * (1 + a);
  const across = base / Math.sqrt(1 + a);
  out.x = across;
  out.y = along;
  out.z = across;
}

/** Impact squash amount from an impact speed, saturating so nothing goes rubbery. */
export const impactSquash = (speed: number, scale = 0.055) => -Math.min(0.3, Math.abs(speed) * scale);

/* ------------------------------------------------------------------ */
/* Timeline                                                            */
/* ------------------------------------------------------------------ */

type Cue = { at: number; fn: (t: number) => void; duration: number; fired: boolean };

/**
 * A tiny cue sequencer for choreographed moments (the celebration, a card snap).
 * Advance it from `useFrame`; it allocates nothing while running.
 */
export class Timeline {
  private cues: Cue[] = [];
  private t = 0;
  running = false;

  /** `fn` receives normalised progress 0..1 across `duration` (0 = instant one-shot). */
  add(at: number, duration: number, fn: (t: number) => void): this {
    this.cues.push({ at, duration, fn, fired: false });
    return this;
  }

  start(): this {
    this.t = 0;
    this.running = true;
    for (let i = 0; i < this.cues.length; i++) this.cues[i].fired = false;
    return this;
  }

  stop(): this {
    this.running = false;
    return this;
  }

  get elapsed() {
    return this.t;
  }

  step(dt: number): void {
    if (!this.running) return;
    this.t += dt;
    let allDone = true;
    for (let i = 0; i < this.cues.length; i++) {
      const cue = this.cues[i];
      const local = this.t - cue.at;
      if (local < 0) {
        allDone = false;
        continue;
      }
      if (cue.duration === 0) {
        if (!cue.fired) {
          cue.fired = true;
          cue.fn(1);
        }
        continue;
      }
      const p = local / cue.duration;
      if (p >= 1) {
        if (!cue.fired) {
          cue.fired = true;
          cue.fn(1);
        }
      } else {
        allDone = false;
        cue.fn(p);
      }
    }
    if (allDone) this.running = false;
  }
}

/** Clamp a frame delta so a tab-switch or a GC pause never teleports anything. */
export const safeDelta = (dt: number) => (dt > 1 / 20 ? 1 / 20 : dt);

/** House timing constants, so every game feels like the same product. */
export const FEEL = {
  pressDown: 0.09,
  pressScale: 0.94,
  releaseOvershoot: 1.06,
  windUp: 0.07,
  settle: { stiffness: 340, damping: 21 },
  snappy: { stiffness: 420, damping: 26 },
  heavy: { stiffness: 260, damping: 24 },
  /** Reduced-motion replacement duration for any transition. */
  reducedFade: 0.15,
} as const;
