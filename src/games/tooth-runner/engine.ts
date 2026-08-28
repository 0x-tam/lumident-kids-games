/**
 * Tooth Runner — game logic.
 *
 * The engine owns the run and knows nothing about three or React. It holds the tooth's
 * vertical state, the world speed, the recycled item pool, the timer and the score, and it
 * publishes discrete events. Two consumers subscribe:
 *
 *   • `ToothRunner.tsx` — re-renders the HUD and announces to screen readers.
 *   • `scene.tsx`       — starts presentation animations. It never re-renders on an event.
 *
 * Unlike the other games this engine is *driven*: `update(dt)` is called once a frame from
 * the scene's `useFrame`, because a runner has no discrete tick to hang its physics on.
 * That is the whole reason it must be as allocation-free as the render loop — it runs in
 * the same place. The item pool is allocated once in the constructor and every item is
 * recycled in place; `update` never calls `new`, never builds a literal and never closes
 * over anything. `Math.random` is called only from `spawn()` and from a collision, which
 * are discrete events a few times a second.
 *
 * ── Rules, carried over verbatim from the 2D game (PROJECT.md) ─────────────────
 *
 *   levels           20 s / 25 s / 30 s
 *   speed            40 / 52 / 64  (percent of the field a second)
 *   sticky speed     22 / 28 / 34
 *   spawn interval   1.25 / 1.00 / 0.85  + up to 0.6 s of jitter
 *   points a pickup  50 / 75 / 100
 *   first spawn      0.8 s in; spawning stops 1.5 s before the end
 *   mix              55% pickup, and 60% of pickups float high
 *   candy            costs a second of speed and nothing else — no life, no penalty,
 *                    no end of run. A child cannot lose this game.
 *   score            pickups × the level's points
 *   default level    Medium for players aged 8 and over, Easy otherwise
 *
 * The percent-a-second speeds are converted to world units by `U_PER_PCT` in `layout.ts`,
 * which is defined so the *reaction time* between a spawn and the player is unchanged.
 */
import { sounds } from "../../shared/audio";
import { clamp01, damp } from "../../three/anim";
import { isReduced } from "../../three/store";
import {
  DESPAWN_Z,
  GRAVITY,
  HIGH_Y,
  HIGH_Y_SPAN,
  HIT_Y,
  HIT_Z,
  JUMP_BUFFER,
  JUMP_V,
  PLAYER_Z,
  SLOW_TIME,
  SPAWN_Z,
  TOOTH_CENTER_Y,
  TOOTH_SEMI_Z,
  U_PER_PCT,
  WINDUP,
} from "./layout";

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

export type LevelConfig = {
  duration: number;
  /** Percent of the 2D field a second — see `U_PER_PCT`. */
  speed: number;
  slow: number;
  spawn: number;
  pts: number;
};

export const LEVELS: readonly LevelConfig[] = [
  { duration: 20, speed: 40, slow: 22, spawn: 1.25, pts: 50 },
  { duration: 25, speed: 52, slow: 28, spawn: 1.0, pts: 75 },
  { duration: 30, speed: 64, slow: 34, spawn: 0.85, pts: 100 },
];

export const KIND_BRUSH = 0;
export const KIND_STAR = 1;
export const KIND_CANDY = 2;
export const KIND_SODA = 3;
export const KIND_DONUT = 4;
export const KIND_COUNT = 5;

/** Indexed by kind. Spoken by `announce()`, so they read as plain English. */
export const KIND_LABELS = ["toothbrush", "star", "candy", "fizzy drink", "donut"] as const;

const GOODIES = [KIND_BRUSH, KIND_STAR] as const;
const SWEETS = [KIND_CANDY, KIND_SODA, KIND_DONUT] as const;

export const isGoodie = (kind: number) => kind === KIND_BRUSH || kind === KIND_STAR;

/**
 * Resting centre height of each kind when it sits on the lane. Mirrors `props.ts`, and it
 * has to: this is presentation following the art, not a rule (the rules are the durations,
 * speeds, spawn cadence, mix, and points above, and none of them move).
 *
 * Both pickups sit 0.50 up. The number is the prop's own **swept** half-extent, not the
 * hoop's radius: the hoop shrank to 0.405 (RU2/RU5 — the pickup now crosses its mark rather
 * than sitting inside it) but the brush grew to 0.89 across, so at some phase of its twirl the
 * lowest point of the prop is the handle's 0.46 half-length rather than any part of the ring.
 * 0.50 clears the lane by 0.04 at every spin angle; at the old 0.46 the butt of the new handle
 * would have cut 0.01 into the surface twice per revolution. All three sweets are low and wide
 * (0.22–0.34 tall), so theirs sit 0.10–0.19 up. What that does to the jump, solved from the
 * arc in `layout.ts`
 * (`v` = 5.882, `g` = 17.30, window above height `h` = `2·sqrt(v² − 2gh)/g`):
 *
 *   sweet   old rest → clearance → window     new rest → clearance → window
 *   candy   0.21  0.330  0.557 s             0.19  0.310  0.565 s
 *   drink   0.26  0.380  0.535 s             0.19  0.310  0.565 s
 *   donut   0.30  0.420  0.518 s             0.10  0.220  0.601 s
 *
 * — so the jump window widens by 7.5 % on average (0.537 s → 0.577 s) and, more usefully,
 * the three-way spread a child had to learn collapses to one rule: *sweets are low, one jump
 * clears any of them.* Every change is in the child's favour, in a game that cannot be lost.
 * `HIT_Y` and `HIT_Z` — the actual hit windows — are untouched, as are the durations,
 * speeds, spawn cadence, 55/45 mix, 60/40 high split and points.
 */
const REST_Y = [0.5, 0.5, 0.19, 0.19, 0.1];

export const ITEM_DEAD = 0;
export const ITEM_LIVE = 1;
export const ITEM_TAKEN = 2;
export const ITEM_BUMPED = 3;

/**
 * Pool size. Worst case is level 3: the 17.4 units between the spawn line and the despawn
 * line take 2.0 s to cross at 8.67 u/s, spawns come every 0.85–1.45 s, and a dead item
 * lingers 0.75 s — five live at once would be extraordinary. Twelve is free insurance and
 * means `spawn()` never has to fail.
 */
export const MAX_ITEMS = 12;

export type RunnerItem = {
  kind: number;
  state: number;
  /** Lateral jitter. Collision ignores it — the game is one-dimensional, as it was in 2D. */
  x: number;
  y: number;
  z: number;
  /** Spin about the kind's own axis, and its rate. */
  spin: number;
  spinRate: number;
  /** Velocity, used only while the item is playing out its collect / bump animation. */
  vx: number;
  vy: number;
  vz: number;
  /** Age and lifetime of that animation. */
  t: number;
  dur: number;
  /** Per-item phase so floating pickups do not bob in lockstep. */
  seed: number;
  /** Set for a floating pickup; drives the idle bob. */
  high: boolean;
  /** One-shot latch for the `approach` cue, so it is announced exactly once per item. */
  cued: boolean;
};

export type RunnerEvent =
  | { type: "reset" }
  | { type: "start" }
  | { type: "spawn"; slot: number; kind: number; high: boolean }
  | { type: "approach"; slot: number; kind: number; high: boolean }
  | { type: "crouch" }
  | { type: "jump" }
  | { type: "land"; impact: number }
  | { type: "collect"; slot: number; kind: number; collected: number; score: number }
  | { type: "stumble"; slot: number; kind: number }
  | { type: "sticky"; sticky: boolean }
  | { type: "tick"; secondsLeft: number }
  | { type: "complete"; score: number }
  | { type: "finish" };

/**
 * Gap between the run ending and the celebration, unchanged from the 2D game.
 *
 * Exported because `scene.tsx` sweeps the camera's near volume clear across exactly this
 * window, so that the celebration's composition is authored rather than being whatever prop
 * happened to be passing the lens when the clock expired.
 */
export const FINISH_DELAY = 0.3;
/**
 * How long before an obstacle reaches the player the "jump now" cue fires.
 *
 * A screen-reader player was told where the *controls* were and never where the *game* was:
 * nothing announced an approaching obstacle, so timing a jump by ear was impossible. The
 * jump arc hangs for 0.68 s and clears a ground sweet from 60 ms in, so a cue 0.55 s out
 * lands a tap in the middle of the window with room for a human reaction on either side.
 */
const APPROACH_LEAD = 0.55;
/** How hard the world's speed chases its target. Slower while coasting to a stop. */
const SPEED_LAMBDA = 3.4;
const STOP_LAMBDA = 2.6;
/** Gravity for an item that has been comically knocked away. */
const DEBRIS_GRAVITY = 9;
/** Clearance past the tooth's own half-depth before a bumped sweet starts its arc. */
const BUMP_CLEARANCE = 0.2;
/** Sideways kick on a bump, so the sweet leaves the frame rather than the tooth's middle. */
const BUMP_VX = 1.7;

function makeItem(): RunnerItem {
  return {
    kind: 0,
    state: ITEM_DEAD,
    x: 0,
    y: 0,
    z: 0,
    spin: 0,
    spinRate: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    t: 0,
    dur: 0,
    seed: 0,
    high: false,
    cued: false,
  };
}

/* ------------------------------------------------------------------ */
/* Engine                                                              */
/* ------------------------------------------------------------------ */

export class ToothRunnerEngine {
  level = 0;

  /** Pickups grabbed this run. The score is this times the level's points. */
  collected = 0;
  /** False until the first tap; the world stands still until then, exactly as in 2D. */
  started = false;
  /** True once the clock runs out — the world coasts to a stop over the last moments. */
  ending = false;
  completed = false;
  finalScore: number | undefined;

  elapsed = 0;
  secondsLeft = LEVELS[0].duration;

  /** World units a second the ground is moving. Damped, never snapped up. */
  speed = 0;
  /** True while a candy is still slowing you down. */
  sticky = false;

  /** Height of the lane's top surface is 0; this is the tooth's jump height above it. */
  toothY = 0;
  toothVy = 0;
  grounded = true;
  /** 0 → 1 across the anticipation crouch; the scene reads it straight as a squash. */
  crouch = 0;

  readonly items: RunnerItem[] = [];

  private slowUntil = -1;
  private spawnIn = 0.8;
  private jumpBuffer = 0;
  private crouchT = 0;
  private crouchDur = WINDUP;
  private finishIn = 0;
  private readonly listeners = new Set<(event: RunnerEvent) => void>();

  constructor() {
    for (let i = 0; i < MAX_ITEMS; i++) this.items.push(makeItem());
  }

  get config(): LevelConfig {
    return LEVELS[this.level];
  }

  /** Live and final score are the same expression — pickups times the level multiplier. */
  score(): number {
    return this.collected * LEVELS[this.level].pts;
  }

  /** Centre of the tooth in world Y, which is what collisions are measured against. */
  toothCenterY(): number {
    return TOOTH_CENTER_Y + this.toothY;
  }

  on(fn: (event: RunnerEvent) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private emit(event: RunnerEvent): void {
    for (const fn of this.listeners) fn(event);
  }

  /* ---------------- input ---------------- */

  /**
   * The one input path: pointer, keyboard and assistive tech all land here.
   *
   * The very first tap only starts the run — it does not also jump. That is the 2D game's
   * behaviour and it matters: the child's first touch is usually on the "Tap to run" pill,
   * and spending it on a jump into an empty lane teaches the wrong thing.
   */
  jump(): void {
    if (this.completed) return;
    if (!this.started) {
      this.started = true;
      this.emit({ type: "start" });
      return;
    }
    if (this.ending) return;
    this.jumpBuffer = JUMP_BUFFER;
  }

  /* ---------------- the frame ---------------- */

  /** Called once a frame from the scene. Allocates nothing. */
  update(dt: number): void {
    if (!this.started) return;
    const cfg = LEVELS[this.level];

    if (!this.ending) {
      this.elapsed += dt;
      const left = Math.max(0, Math.ceil(cfg.duration - this.elapsed));
      if (left !== this.secondsLeft) {
        this.secondsLeft = left;
        this.emit({ type: "tick", secondsLeft: left });
      }
    }

    /* Speed. A candy drops it instantly — that is the stumble — and it climbs back with a
       damp, which is what the tooth leans into on the way out of one. */
    const stickyNow = !this.ending && this.elapsed < this.slowUntil;
    if (stickyNow !== this.sticky) {
      this.sticky = stickyNow;
      this.emit({ type: "sticky", sticky: stickyNow });
    }
    const target = this.ending ? 0 : (stickyNow ? cfg.slow : cfg.speed) * U_PER_PCT;
    this.speed = damp(this.speed, target, this.ending ? STOP_LAMBDA : SPEED_LAMBDA, dt);

    this.stepJump(dt);
    this.stepItems(dt);

    if (!this.ending) {
      // Spawning stops 1.5 s before the end, so a run never finishes mid-obstacle.
      if (this.elapsed < cfg.duration - 1.5) {
        this.spawnIn -= dt;
        if (this.spawnIn <= 0) {
          this.spawnIn = cfg.spawn + Math.random() * 0.6;
          this.spawn();
        }
      }
      if (this.elapsed >= cfg.duration) {
        this.ending = true;
        this.finalScore = this.score();
        this.finishIn = FINISH_DELAY;
        this.emit({ type: "complete", score: this.finalScore });
      }
    } else if (!this.completed) {
      this.finishIn -= dt;
      if (this.finishIn <= 0) {
        this.completed = true;
        this.emit({ type: "finish" });
      }
    }
  }

  private stepJump(dt: number): void {
    if (this.jumpBuffer > 0) this.jumpBuffer -= dt;

    if (this.crouchT > 0) {
      this.crouchT -= dt;
      this.crouch = clamp01(1 - this.crouchT / this.crouchDur);
      if (this.crouchT <= 0) this.launch();
    } else if (this.jumpBuffer > 0 && this.grounded) {
      this.jumpBuffer = 0;
      // Reduced motion keeps the squash but drops the wind-up delay: the same read, with
      // no gap between the tap and the tooth leaving the ground.
      this.crouchDur = isReduced() ? 0 : WINDUP;
      if (this.crouchDur <= 0) {
        this.crouch = 1;
        this.launch();
      } else {
        // This frame's dt is consumed straight away, so the tooth is already compressing on
        // the frame the tap is processed rather than on the one after it. The wind-up costs
        // 70 ms of ground contact; it must never cost a frame of feedback.
        this.crouchT = this.crouchDur - dt;
        this.crouch = clamp01(1 - this.crouchT / this.crouchDur);
        this.emit({ type: "crouch" });
        if (this.crouchT <= 0) this.launch();
      }
    }

    if (!this.grounded) {
      this.toothVy -= GRAVITY * dt;
      this.toothY += this.toothVy * dt;
      if (this.toothY <= 0) {
        const impact = this.toothVy;
        this.toothY = 0;
        this.toothVy = 0;
        this.grounded = true;
        this.emit({ type: "land", impact });
      }
    }
  }

  private launch(): void {
    this.crouchT = 0;
    this.crouch = 0;
    this.toothVy = JUMP_V;
    this.grounded = false;
    sounds.pop();
    this.emit({ type: "jump" });
  }

  private stepItems(dt: number): void {
    const speed = this.speed;
    const centerY = this.toothCenterY();
    const items = this.items;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.state === ITEM_DEAD) continue;
      it.spin += it.spinRate * dt;

      if (it.state === ITEM_LIVE) {
        it.z += speed * dt;
        if (it.z > DESPAWN_Z) {
          it.state = ITEM_DEAD;
          continue;
        }
        // The audio half of the game. Fired once, a fixed *time* rather than a fixed
        // distance out, so the cue lands in the same place in the jump window at every
        // level and while a candy still has hold of the speed.
        if (!it.cued && !this.ending && it.z - PLAYER_Z > -speed * APPROACH_LEAD) {
          it.cued = true;
          this.emit({ type: "approach", slot: i, kind: it.kind, high: it.high });
        }
        if (
          !this.ending &&
          it.z - PLAYER_Z < HIT_Z &&
          it.z - PLAYER_Z > -HIT_Z &&
          centerY - it.y < HIT_Y &&
          centerY - it.y > -HIT_Y
        ) {
          this.resolve(i, it);
        }
        continue;
      }

      // Playing out a collect or a bump: it keeps travelling with the world, plus its own
      // little arc, and dies when its clock runs out.
      it.t += dt;
      it.x += it.vx * dt;
      it.z += (speed * 0.7 + it.vz) * dt;
      it.y += it.vy * dt;
      it.vy -= DEBRIS_GRAVITY * dt;
      if (it.t >= it.dur) it.state = ITEM_DEAD;
    }
  }

  private resolve(slot: number, it: RunnerItem): void {
    const reduced = isReduced();
    if (isGoodie(it.kind)) {
      this.collected += 1;
      sounds.sparkle();
      it.state = ITEM_TAKEN;
      it.t = 0;
      it.dur = reduced ? 0.22 : 0.55;
      it.vx = 0;
      it.vy = reduced ? 0 : 1.9;
      it.vz = 0;
      it.spinRate = reduced ? 0 : 7;
      this.emit({
        type: "collect",
        slot,
        kind: it.kind,
        collected: this.collected,
        score: this.score(),
      });
      return;
    }

    // A sweet. It costs a second of speed and a comic stumble — never a life, never a run.
    sounds.oops();
    this.slowUntil = this.elapsed + SLOW_TIME;
    this.speed = LEVELS[this.level].slow * U_PER_PCT;
    it.state = ITEM_BUMPED;
    it.t = 0;
    it.dur = reduced ? 0.25 : 0.75;
    /*
     * Start the debris arc *outside* the tooth, not where the collision happened.
     *
     * A hit is registered anywhere inside a 0.31-unit window, which is inside the body — so
     * the bumped sweet used to be drawn intersecting the roots for the whole first half of
     * its arc. It is pushed clear along +Z (the tooth's half-depth plus the sweet's own
     * radius) and given a lateral velocity so it leaves sideways as well as forward, which
     * is both the funnier read and the one that cannot re-enter the body.
     */
    it.z = PLAYER_Z + TOOTH_SEMI_Z + BUMP_CLEARANCE;
    it.vx = reduced ? 0 : slot % 2 === 0 ? BUMP_VX : -BUMP_VX;
    it.vy = reduced ? 0 : 2.4;
    it.vz = reduced ? 0 : 2.6;
    it.spinRate = reduced ? 0 : slot % 2 === 0 ? 9 : -9;
    this.emit({ type: "stumble", slot, kind: it.kind });
  }

  /**
   * One brush and one candy, standing still in the lane before the run starts.
   *
   * The start frame was an empty lane and a pill that says "Tap to run", which asks a
   * four-year-old to learn the game's only two verbs from a sentence they cannot read. Now
   * the two nouns are *in front of them*, one above the other, at the two heights they will
   * arrive at: a haloed toothbrush up where you jump to grab it, and a candy on the ground
   * where you jump over it.
   *
   * This costs the run nothing. `update()` returns immediately while `!started`, so these
   * two do not move, do not spin, cannot be hit and do not consume a spawn — the clock, the
   * `spawnIn` cadence and the 55/45 mix all begin at the first tap exactly as before. They
   * then travel in with the world like any other item and are the first two things the child
   * meets, which is the demonstration finishing itself.
   *
   * Both `z` values were **searched**, not chosen: a 0.25-unit sweep of both against the real
   * `cameraFor` solve, in all five shipped rects, maximising the smallest screen-space gap
   * between the three boxes (hero, brush, candy) subject to neither pickup entering the
   * chrome band. The answer is −4.75 and −6.0. Re-projected after RU2/RU5 grew both pickups
   * to 0.89 across and RU11 moved `CLEAR_BOTTOM` to −0.5, the stack has *more* daylight than
   * it had, not less — the props grew and the camera retreated by more than they grew:
   *
   *   laptop  hero −0.656..−0.136 | candy −0.052..0.048 | brush 0.132..0.438  gaps **0.084/0.084**
   *   phone   hero −0.725..−0.238 | candy −0.112..−0.016 | brush 0.058..0.351  gaps **0.126/0.074**
   *
   * against chrome-band bottoms of 0.60 and 0.541 — a column of *hero, jump-this, grab-this*
   * with daylight between all three, and the old worst gap of 0.066 improved to 0.074.
   *
   * `x` stays inside the ±0.12 band `spawn()` jitters within. Collision in this game is
   * one-dimensional by design, so an item parked further off the lane's centre line than the
   * jitter allows would be seen to be missed and still register — the demonstration must not
   * teach something the game does not do.
   */
  private showTheVerbs(): void {
    this.place(0, KIND_BRUSH, -4.75, true, 0.1);
    this.place(1, KIND_CANDY, -6, false, -0.1);
  }

  /** Shared by `showTheVerbs` and nothing else; `spawn()` has its own randomised path. */
  private place(slot: number, kind: number, z: number, high: boolean, x: number): void {
    const it = this.items[slot];
    it.kind = kind;
    it.state = ITEM_LIVE;
    it.x = x;
    it.y = high ? HIGH_Y : REST_Y[kind];
    it.z = z;
    it.spin = 0;
    // The twirl is the pickups' third cue (see `props.ts`'s vocabulary table); it does not
    // advance until the run starts, because `update()` returns while `!started`.
    it.spinRate = isReduced() || !isGoodie(kind) ? 0 : kind === KIND_STAR ? 1.5 : 1.1;
    it.vx = 0;
    it.vy = 0;
    it.vz = 0;
    it.t = 0;
    it.dur = 0;
    it.seed = 0;
    it.high = high;
    it.cued = false;
  }

  private spawn(): void {
    let slot = -1;
    for (let i = 0; i < this.items.length; i++) {
      if (this.items[i].state === ITEM_DEAD) {
        slot = i;
        break;
      }
    }
    if (slot < 0) return;

    const reduced = isReduced();
    const goodie = Math.random() < 0.55;
    const pool = goodie ? GOODIES : SWEETS;
    const kind = pool[Math.floor(Math.random() * pool.length)];
    const high = goodie && Math.random() < 0.6;

    const it = this.items[slot];
    it.kind = kind;
    it.state = ITEM_LIVE;
    it.x = (Math.random() - 0.5) * 0.24;
    it.y = high ? HIGH_Y + Math.random() * HIGH_Y_SPAN : REST_Y[kind];
    it.z = SPAWN_Z;
    it.spin = Math.random() * Math.PI * 2;
    // Pickups twirl on the spot; a sweet sits still on the lane until it is knocked away.
    it.spinRate = reduced || !goodie ? 0 : kind === KIND_STAR ? 1.5 : 1.1;
    it.vx = 0;
    it.vy = 0;
    it.vz = 0;
    it.t = 0;
    it.dur = 0;
    it.seed = Math.random() * Math.PI * 2;
    it.high = high;
    it.cued = false;

    this.emit({ type: "spawn", slot, kind, high });
  }

  /* ---------------- lifecycle ---------------- */

  /** Start a fresh run. Used by the level selector, the restart button and Play again. */
  reset(level: number = this.level): void {
    this.level = level < 0 ? 0 : level >= LEVELS.length ? LEVELS.length - 1 : level;
    for (let i = 0; i < this.items.length; i++) {
      this.items[i].state = ITEM_DEAD;
      this.items[i].cued = false;
    }
    this.collected = 0;
    this.started = false;
    this.ending = false;
    this.completed = false;
    this.finalScore = undefined;
    this.elapsed = 0;
    this.secondsLeft = LEVELS[this.level].duration;
    this.speed = 0;
    this.sticky = false;
    this.toothY = 0;
    this.toothVy = 0;
    this.grounded = true;
    this.crouch = 0;
    this.slowUntil = -1;
    this.spawnIn = 0.8;
    this.jumpBuffer = 0;
    this.crouchT = 0;
    this.finishIn = 0;
    this.showTheVerbs();
    this.emit({ type: "reset" });
  }

  /** Called from the component's unmount effect. Leaves no listener behind. */
  dispose(): void {
    this.listeners.clear();
  }
}

export function createEngine(level = 0): ToothRunnerEngine {
  const engine = new ToothRunnerEngine();
  engine.reset(level);
  return engine;
}
