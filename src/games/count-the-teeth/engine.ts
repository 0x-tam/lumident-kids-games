/**
 * Count the Teeth — game logic.
 *
 * Zero React, zero three. The engine owns the round sequence, the randomised count, the
 * three answer choices, the miss bookkeeping and the score, and it publishes discrete
 * events. Two consumers subscribe: `CountTheTeeth.tsx` (HUD + `announce()`) and
 * `scene.tsx` (starts animations, and re-lays the scatter). Neither ever re-renders the
 * board from a frame.
 *
 * Rules, level table, PAR times, scoring and randomisation are carried over from the 2D
 * implementation unchanged (PROJECT.md):
 *
 *   5 rounds · counts 3–6 / 5–10 / 8–14 by level · three choices within ±2 of the answer
 *   a round pays `round(100 × MULT[level])` **only if it was answered first time**
 *   a wrong tap costs nothing but that round's points — no penalty, no life, no failure
 *   final score = points + max(0, PAR[level] − seconds) × 2
 *   players aged 8+ start on Medium.
 */
import { sounds } from "../../shared/audio";

/* ------------------------------------------------------------------ */
/* Configuration (unchanged from the 2D game)                          */
/* ------------------------------------------------------------------ */

export const ROUNDS = 5;

/** Inclusive count range per level — Easy / Medium / Hard. */
export const RANGE: readonly (readonly [number, number])[] = [
  [3, 6],
  [5, 10],
  [8, 14],
];

/** Points multiplier per level. A clean round pays `round(100 × MULT)`. */
export const MULT = [1, 1.5, 2] as const;

/** Par times in seconds; finishing under par pays 2 points a second. */
export const PAR = [30, 45, 60] as const;

/** Number of answer tiles. Fixed, so the keyboard group's count never changes. */
export const CHOICES = 3;

/** Beat between a correct answer and the next round. */
const NEXT_DELAY = 900;
/**
 * Slightly longer on the last round so the finishing hop reads before the celebration
 * takes the screen. The 2D game used 900 for both; this is presentation, not a rule.
 */
const FINISH_DELAY = 1100;

export type EngineEvent =
  | { type: "round"; index: number; count: number; answers: readonly number[]; retry: boolean }
  | { type: "correct"; index: number; value: number; points: number }
  | { type: "wrong"; index: number; value: number }
  | { type: "complete"; score: number };

/* ------------------------------------------------------------------ */
/* Round generation (randomisation preserved verbatim)                 */
/* ------------------------------------------------------------------ */

/** `lo + floor(random × (hi − lo + 1))` — the 2D game's draw, unchanged. */
function drawCount(level: number): number {
  const [lo, hi] = RANGE[level];
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

/**
 * Three ascending choices: the answer plus two neighbours inside ±2, clamped to
 * `1 .. hi + 2`. Kept exactly as the 2D game generated them, including the `Set` retry
 * loop, so the distribution of "how close are the wrong answers" is identical.
 */
function drawAnswers(level: number, count: number): number[] {
  const hi = RANGE[level][1];
  const answers = new Set<number>([count]);
  while (answers.size < CHOICES) {
    const off = count + (Math.floor(Math.random() * 5) - 2);
    if (off >= 1 && off <= hi + 2) answers.add(off);
  }
  return [...answers].sort((a, b) => a - b);
}

/* ------------------------------------------------------------------ */
/* Engine                                                              */
/* ------------------------------------------------------------------ */

export class CountEngine {
  level = 0;
  /** 0-based index of the round on screen. */
  round = 0;
  /** How many teeth are on the mat right now. */
  count = 0;
  answers: number[] = [];
  /** Points banked so far, before the time bonus. */
  score = 0;
  /** Elapsed seconds, pushed in by the shell's ticker; prices the time bonus. */
  seconds = 0;
  started = false;
  completed = false;
  finalScore: number | undefined;

  /** True once this round has been answered wrongly — the round then pays nothing. */
  private missed = false;
  /** Set between a correct answer and the next round, so extra taps are simply ignored. */
  private locked = false;
  private timer = 0;
  private readonly listeners = new Set<(event: EngineEvent) => void>();

  /** Points a clean round is worth at the current level. */
  get perRound(): number {
    return Math.round(100 * MULT[this.level]);
  }

  /** Live score while playing — banked points only; the bonus lands at the end. */
  liveScore(): number {
    return this.score;
  }

  on(fn: (event: EngineEvent) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private emit(event: EngineEvent): void {
    for (const fn of this.listeners) fn(event);
  }

  /** Start a fresh run. Used by mount, the restart button and the level selector. */
  start(level: number = this.level): void {
    this.clearTimer();
    this.level = level < 0 ? 0 : level >= RANGE.length ? RANGE.length - 1 : level;
    this.round = 0;
    this.score = 0;
    this.seconds = 0;
    this.started = false;
    this.completed = false;
    this.finalScore = undefined;
    this.missed = false;
    this.locked = false;
    this.deal(false);
  }

  private deal(retry: boolean): void {
    this.count = drawCount(this.level);
    this.answers = drawAnswers(this.level, this.count);
    this.missed = false;
    this.locked = false;
    this.emit({
      type: "round",
      index: this.round,
      count: this.count,
      answers: this.answers,
      retry,
    });
  }

  /**
   * The one input path: pointer, keyboard and assistive tech all land here, so a rule can
   * never be enforced for one of them and not the others.
   */
  answer(value: number): void {
    if (this.completed || this.locked) return;
    const index = this.answers.indexOf(value);
    if (index < 0) return;

    this.started = true;

    if (value !== this.count) {
      // Playful, never punitive: the round simply stops paying and the child tries again.
      sounds.oops();
      this.missed = true;
      this.emit({ type: "wrong", index, value });
      return;
    }

    sounds.sparkle();
    let points = 0;
    if (!this.missed) {
      points = this.perRound;
      this.score += points;
    }
    this.missed = false;
    this.locked = true;
    this.emit({ type: "correct", index, value, points });

    const last = this.round + 1 >= ROUNDS;
    this.timer = window.setTimeout(
      () => {
        this.timer = 0;
        if (last) this.finish();
        else {
          this.round += 1;
          this.deal(false);
        }
      },
      last ? FINISH_DELAY : NEXT_DELAY
    );
  }

  private finish(): void {
    const bonus = Math.max(0, PAR[this.level] - this.seconds) * 2;
    this.finalScore = this.score + bonus;
    this.completed = true;
    this.emit({ type: "complete", score: this.finalScore });
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = 0;
    }
  }

  /** Called from the component's unmount effect. Leaves no timer and no listener behind. */
  dispose(): void {
    this.clearTimer();
    this.listeners.clear();
  }
}

export function createEngine(level = 0): CountEngine {
  const engine = new CountEngine();
  engine.start(level);
  return engine;
}
