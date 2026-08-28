/**
 * Tooth Rescue — the rules, with no three and no React in sight.
 *
 * Everything the 2D game did is preserved verbatim (PROJECT.md + the original file):
 *
 *   30 second runs · levels [spawn 1.15 / 0.90 / 0.70 s + up to 0.4 s of jitter],
 *   [candy 22% / 30% / 35%], [goal 8 / 10 / 12], [points 50 / 75 / 100 per tooth],
 *   first spawn at 0.4 s, spawning stops 0.5 s before time, players aged 8+ start on
 *   Medium, score = caught x points, the run ends the moment the goal is reached, and
 *   there is no way to lose — running out of time simply ends the run and celebrates
 *   whatever was caught.
 *
 * The only thing that changed shape is "speed": in 2D a drop was a constant percent of the
 * field per second. Here things really fall, so the level's speed knob became the initial
 * downward velocity handed to the body (`drop`), on top of the world's gravity. Fall times
 * to the basket floor work out at 1.55 / 1.20 / 0.92 s — the same ordering the 2D game had,
 * with the same spawn cadence, so the number of teeth a child sees per run is unchanged.
 *
 * Round 2 shortened the drop — the audit measured the falling tooth at 0.36 % of the frame,
 * which no amount of art direction survives — so `drop` was re-solved against the new
 * height to land on exactly the same three fall times. Over H = 2.855 units at
 * `GRAVITY` = 2.832, the initial speeds 0 / 1.08 / 2.26 u/s give 1.4199 / 1.0889 / 0.8308 s
 * **in closed form** — and round 3 found that closed form is not what ships. `physics.ts`
 * damps velocity by `exp(-0.35 h)` every substep, which the solve above ignored; stepping
 * the real integrator at its 1/120 s fixed step gives **1.545 / 1.202 / 0.918 s**. The
 * three `drop` values are left exactly as they are — they are the level knob, and the
 * ordering and the ratios between the levels are what the rules care about; see
 * `layout.ts: GRAVITY` for why the extra air is kept rather than tuned away, and
 * `scratchpad/verify/tooth-rescue-wobble.mjs` for the derivation.
 * Nothing else about the levels moved.
 *
 * Events are emitted through **one reused mutable record**. The scene subscribes from
 * inside `useFrame` (the engine's clock is the frame clock), and allocating a fresh event
 * object per spawn would put garbage on the hot path. Listeners must read what they need
 * synchronously and never retain the object.
 */

export const GAME_SECONDS = 30;

export const KIND_TOOTH = 0;
export const KIND_CANDY = 1;

export type LevelConfig = {
  /** Seconds between spawns, before jitter. */
  spawn: number;
  jitter: number;
  /** Initial downward speed handed to a falling body, world units/s. */
  drop: number;
  /** Probability a spawn is candy rather than a tooth. */
  candy: number;
  /** Teeth needed to finish early. */
  goal: number;
  /** Points per caught tooth. */
  pts: number;
};

export const LEVELS: readonly LevelConfig[] = [
  { spawn: 1.15, jitter: 0.4, drop: 0, candy: 0.22, goal: 8, pts: 50 },
  { spawn: 0.9, jitter: 0.4, drop: 1.08, candy: 0.3, goal: 10, pts: 75 },
  { spawn: 0.7, jitter: 0.4, drop: 2.26, candy: 0.35, goal: 12, pts: 100 },
];

/** How far off centre a spawn may land, as a fraction of the basket's reach. */
const SPAWN_SPREAD = 0.94;
/** The original opened with a short pause before the first drop. */
const FIRST_SPAWN = 0.4;
/** Beat between the run ending and the celebration, so the last catch can land. */
const FINISH_HOLD = 0.5;
/**
 * Candy colour variants the scene tints its instances with.
 *
 * Three since B6.5: the sweet moved off `red` and `coral` — the families the alcove and the
 * basket now own — and only three tones in the remaining families clear the recess by enough
 * luminance to be read at speed. See `scene.tsx: CANDY_HEX` for the table.
 */
export const CANDY_VARIANTS = 3;

export type EngineEventType =
  | "reset"
  | "start"
  | "spawn"
  | "catch"
  | "bounce"
  | "tick"
  | "complete";

/**
 * The single reused event record. Fields not relevant to `type` hold whatever the previous
 * event left there — read only what the type documents:
 *
 *   spawn    → kind, x (-1..1, a fraction of the basket's reach), drop, spin, variant
 *   catch    → caught, goal, score
 *   tick     → secondsLeft
 *   complete → score
 */
export type EngineEvent = {
  type: EngineEventType;
  kind: number;
  x: number;
  drop: number;
  spin: number;
  variant: number;
  caught: number;
  goal: number;
  score: number;
  secondsLeft: number;
};

type Listener = (event: EngineEvent) => void;

/**
 * xorshift32. Seeded per run so a run is reproducible given the same frame deltas — which
 * is what makes a physics bug reproducible — while every run still deals fresh randomness.
 */
function makeRng(seed: number): () => number {
  let s = seed >>> 0 || 0x9e3779b9;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

export class ToothRescueEngine {
  level: number;
  started = false;
  completed = false;
  caught = 0;
  /** Candy that bounced back out. Shown nowhere, counts against nothing — telemetry only. */
  bounced = 0;
  finalScore: number | null = null;
  secondsLeft = GAME_SECONDS;

  /** Where the child is pointing the basket, -1..1. Written by input, read by the scene. */
  aimX = 0;

  /**
   * How many times the child has pressed. **Not a rule** — nothing here reads it, nothing
   * scores it and `reset()` leaves it alone.
   *
   * It exists because `3D-SPEC §4` requires the thing under a child's finger to answer
   * inside one frame, and round 3 (B6.4) found the basket answering not at all: the start
   * overlay ate the first press and every later press only moved the aim. The shell bumps
   * this on `pointerdown`; `scene.tsx` diffs it inside `useFrame` and kicks the basket's
   * jelly. A counter rather than a boolean so the scene sees an *edge* without the shell
   * having to clear a flag, and a plain field rather than an event so a press never costs a
   * React render.
   */
  presses = 0;

  private elapsed = 0;
  private spawnIn = FIRST_SPAWN;
  private finishing = false;
  private finishT = 0;
  private rng: () => number;
  private listeners = new Set<Listener>();
  private readonly event: EngineEvent = {
    type: "reset",
    kind: KIND_TOOTH,
    x: 0,
    drop: 0,
    spin: 0,
    variant: 0,
    caught: 0,
    goal: 0,
    score: 0,
    secondsLeft: GAME_SECONDS,
  };

  constructor(level = 0) {
    this.level = level < 0 ? 0 : level >= LEVELS.length ? LEVELS.length - 1 : level;
    this.rng = makeRng((Date.now() ^ 0x5bf03635) >>> 0);
  }

  get config(): LevelConfig {
    return LEVELS[this.level];
  }

  get goal(): number {
    return this.config.goal;
  }

  liveScore(): number {
    return this.caught * this.config.pts;
  }

  on(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /** Full restart. `level` defaults to the current one, matching the shell's restart button. */
  reset(level?: number): void {
    if (typeof level === "number") {
      this.level = level < 0 ? 0 : level >= LEVELS.length ? LEVELS.length - 1 : level;
    }
    this.started = false;
    this.completed = false;
    this.caught = 0;
    this.bounced = 0;
    this.finalScore = null;
    this.secondsLeft = GAME_SECONDS;
    this.elapsed = 0;
    this.spawnIn = FIRST_SPAWN;
    this.finishing = false;
    this.finishT = 0;
    this.aimX = 0;
    this.rng = makeRng((Date.now() ^ 0x5bf03635) >>> 0);
    this.emit("reset");
  }

  start(): void {
    if (this.started || this.completed) return;
    this.started = true;
    this.emit("start");
  }

  /** Clamp and store the child's aim. -1 is the far left of the basket's reach, 1 the far right. */
  aim(x: number): void {
    this.aimX = x < -1 ? -1 : x > 1 ? 1 : x;
  }

  /** A press landed. See `presses`: feedback only, never a rule. */
  press(): void {
    this.presses++;
  }

  /** Nudge the aim by a fixed step — the arrow keys. */
  nudge(delta: number): void {
    this.aim(this.aimX + delta);
  }

  /**
   * Advanced from the scene's `useFrame`, so the rules clock and the physics clock are the
   * same clock and can never drift apart.
   */
  update(dt: number): void {
    if (this.completed) return;

    if (this.finishing) {
      this.finishT -= dt;
      if (this.finishT <= 0) {
        this.completed = true;
        this.finalScore = this.liveScore();
        this.emit("complete");
      }
      return;
    }

    if (!this.started) return;

    this.elapsed += dt;

    const shown = Math.max(0, Math.ceil(GAME_SECONDS - this.elapsed));
    if (shown !== this.secondsLeft) {
      this.secondsLeft = shown;
      this.emit("tick");
    }

    const cfg = this.config;
    this.spawnIn -= dt;
    if (this.spawnIn <= 0 && this.elapsed < GAME_SECONDS - 0.5) {
      this.spawnIn = cfg.spawn + this.rng() * cfg.jitter;
      const e = this.event;
      e.kind = this.rng() < 1 - cfg.candy ? KIND_TOOTH : KIND_CANDY;
      e.x = (this.rng() * 2 - 1) * SPAWN_SPREAD;
      e.drop = cfg.drop;
      e.spin = this.rng();
      e.variant = Math.floor(this.rng() * CANDY_VARIANTS);
      this.emit("spawn");
    }

    if (this.elapsed >= GAME_SECONDS) this.finish();
  }

  /**
   * A tooth landed in the basket. Late catches during the finish hold still count — the
   * child is never told a catch arrived "too late".
   */
  registerCatch(): void {
    if (this.completed) return;
    this.caught++;
    this.emit("catch");
    if (this.caught >= this.config.goal) this.finish();
  }

  /** Candy hit the rim. Costs nothing but the point that was never there. */
  registerBounce(): void {
    if (this.completed) return;
    this.bounced++;
    this.emit("bounce");
  }

  dispose(): void {
    this.listeners.clear();
  }

  private finish(): void {
    if (this.finishing || this.completed) return;
    this.finishing = true;
    this.finishT = FINISH_HOLD;
  }

  private emit(type: EngineEventType): void {
    const e = this.event;
    e.type = type;
    e.caught = this.caught;
    e.goal = this.config.goal;
    e.score = this.finalScore ?? this.liveScore();
    e.secondsLeft = this.secondsLeft;
    for (const fn of this.listeners) fn(e);
  }
}

export function createEngine(level = 0): ToothRescueEngine {
  return new ToothRescueEngine(level);
}
