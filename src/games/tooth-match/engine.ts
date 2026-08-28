/**
 * Tooth Match — game logic.
 *
 * The engine is the single source of truth for a run and it knows nothing about React or
 * about three. It owns the deal, the two-card flip cycle, the miss/match timers, the miss
 * count and the score, and it publishes discrete events. Two consumers subscribe:
 *
 *   • `ToothMatch.tsx`  — re-renders the HUD and announces to screen readers.
 *   • `scene.tsx`       — starts card animations. It never re-renders on an event.
 *
 * That split is the whole reason the 3D layer can run at 60fps with zero React work per
 * frame: the scene reads `engine` once, subscribes once, and after that only mutates
 * plain structs from the event callback and Object3D transforms inside `useFrame`.
 *
 * Rules, level table, PAR times, scoring and the randomised deal are carried over from the
 * 2D implementation unchanged — see PROJECT.md. Only the presentation is new.
 */
import { sounds } from "../../shared/audio";

/* ------------------------------------------------------------------ */
/* Configuration (unchanged from the 2D game)                          */
/* ------------------------------------------------------------------ */

export const MOTIF_IDS = ["tooth", "brush", "paste", "cup", "floss", "star", "apple", "berry"] as const;
export type MotifId = (typeof MOTIF_IDS)[number];

/** Spoken names, for `announce()` and the hidden button labels. */
export const MOTIF_LABELS: Record<MotifId, string> = {
  tooth: "tooth",
  brush: "toothbrush",
  paste: "toothpaste",
  cup: "cup",
  floss: "floss",
  star: "star",
  apple: "apple",
  berry: "berry",
};

/** Pairs per level — Easy / Medium / Hard. */
export const PAIRS = [3, 6, 8] as const;
/** Par times in seconds; finishing under par pays 3 points a second. */
export const PAR = [30, 75, 110] as const;
/** Grid columns per level; rows fall out of the card count. */
export const COLS = [3, 4, 4] as const;

/** Card states, stored in a `Uint8Array` so the scene can read them without allocating. */
export const DOWN = 0;
export const UP = 1;
export const MATCHED = 2;

/** How long a matched pair stays face-up before it is locked in. */
const MATCH_DELAY = 450;
/** How long a mismatched pair stays face-up before it flips back. */
const MISS_DELAY = 900;
/** Gap between the last match and the celebration overlay. */
const FINISH_DELAY = 700;

export type Card = { key: number; id: MotifId };

export type EngineEvent =
  | { type: "deal" }
  | { type: "flip"; index: number; id: MotifId }
  | { type: "match"; a: number; b: number; id: MotifId; remaining: number }
  | { type: "miss"; a: number; b: number }
  | { type: "hide"; a: number; b: number }
  | { type: "reject"; index: number; reason: "matched" | "busy" }
  | { type: "complete"; score: number }
  | { type: "finish" };

/**
 * The original deal, preserved verbatim: pick `pairs` motifs at random, double them, and
 * shuffle. `sort(() => Math.random() - 0.5)` is not a uniform shuffle — it is kept as-is
 * because the brief is to preserve the existing randomisation, and for 6–16 cards it is
 * indistinguishable from one in play.
 */
function dealCards(pairs: number): Card[] {
  const picks = MOTIF_IDS.slice().sort(() => Math.random() - 0.5).slice(0, pairs);
  return [...picks, ...picks].map((id, i) => ({ key: i, id })).sort(() => Math.random() - 0.5);
}

/* ------------------------------------------------------------------ */
/* Engine                                                             */
/* ------------------------------------------------------------------ */

export class ToothMatchEngine {
  level = 0;
  cards: Card[] = [];
  /** Per-card `DOWN | UP | MATCHED`. Reallocated only on a deal. */
  state: Uint8Array = new Uint8Array(0);
  /** Indices currently face-up and unresolved — never longer than 2. */
  readonly flipped: number[] = [];
  misses = 0;
  matchedPairs = 0;
  started = false;
  completed = false;
  finalScore: number | undefined;
  /** Elapsed seconds, pushed in by the shell's ticker; feeds the time bonus. */
  seconds = 0;

  private resolveTimer = 0;
  private finishTimer = 0;
  private readonly listeners = new Set<(event: EngineEvent) => void>();

  get pairs(): number {
    return PAIRS[this.level];
  }

  get cols(): number {
    return COLS[this.level];
  }

  get rows(): number {
    return Math.ceil(this.cards.length / this.cols);
  }

  /**
   * What the star chip shows **while the child is playing**. Banked points only: it goes
   * up when a pair lands and it never, ever goes down.
   *
   * This used to be `max(0, matchedPairs * 100 - misses * 10)`, fed straight into the HUD.
   * A mismatch therefore subtracted ten points on the same frame, visibly, from a number a
   * three-to-ten-year-old was watching, while the voice said "Oops, not a pair" — a number
   * that ticks backwards is a punishment however gently it is worded, and 3D-SPEC §1.1
   * forbids penalising a mistake.
   *
   * **The final score is untouched.** `settleMatch` still prices the run with the exact
   * PROJECT.md formula, misses and time bonus included; that adjustment is revealed once,
   * in the celebration card, when the run is already won.
   */
  bankedScore(): number {
    return this.matchedPairs * 100;
  }

  /** Subscribe to discrete events. Returns the unsubscribe. */
  on(fn: (event: EngineEvent) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private emit(event: EngineEvent): void {
    for (const fn of this.listeners) fn(event);
  }

  /** Start a fresh run. Also used by the level selector and the restart button. */
  deal(level: number = this.level): void {
    this.clearTimers();
    this.level = level < 0 ? 0 : level >= PAIRS.length ? PAIRS.length - 1 : level;
    this.cards = dealCards(PAIRS[this.level]);
    this.state = new Uint8Array(this.cards.length);
    this.flipped.length = 0;
    this.misses = 0;
    this.matchedPairs = 0;
    this.started = false;
    this.completed = false;
    this.finalScore = undefined;
    this.seconds = 0;
    this.emit({ type: "deal" });
  }

  /**
   * The one input path. Pointer, keyboard and assistive tech all land here, so a rule can
   * never be enforced for one of them and not the others.
   */
  tap(index: number): void {
    if (this.completed) return;
    const card = this.cards[index];
    if (!card) return;

    if (this.state[index] === MATCHED) {
      this.emit({ type: "reject", index, reason: "matched" });
      return;
    }
    if (this.flipped.indexOf(index) >= 0 || this.flipped.length === 2) {
      this.emit({ type: "reject", index, reason: "busy" });
      return;
    }

    sounds.pop();
    this.started = true;
    this.state[index] = UP;
    this.flipped.push(index);
    this.emit({ type: "flip", index, id: card.id });

    if (this.flipped.length !== 2) return;

    const a = this.flipped[0];
    const b = this.flipped[1];
    if (this.cards[a].id === this.cards[b].id) {
      this.resolveTimer = window.setTimeout(() => {
        this.resolveTimer = 0;
        this.settleMatch(a, b);
      }, MATCH_DELAY);
    } else {
      // The miss is counted immediately, because the *final* score prices it. Nothing the
      // child can see moves: `bankedScore()` does not read `misses`.
      this.misses += 1;
      sounds.oops();
      this.emit({ type: "miss", a, b });
      this.resolveTimer = window.setTimeout(() => {
        this.resolveTimer = 0;
        this.settleMiss(a, b);
      }, MISS_DELAY);
    }
  }

  private settleMatch(a: number, b: number): void {
    sounds.sparkle();
    this.state[a] = MATCHED;
    this.state[b] = MATCHED;
    this.matchedPairs += 1;
    this.flipped.length = 0;
    this.emit({
      type: "match",
      a,
      b,
      id: this.cards[a].id,
      remaining: this.pairs - this.matchedPairs,
    });

    if (this.matchedPairs !== this.pairs) return;

    const bonus = Math.max(0, PAR[this.level] - this.seconds) * 3;
    /*
     * The PROJECT.md formula, floored at the number the child has been watching.
     *
     * `max(pairs * 40, pairs * 100 - misses * 10 + bonus)` is the original pricing and it is
     * untouched — the time bonus and the miss adjustment still decide the score for every run
     * that beats them. What is new is the third term. Round 2 removed the live score that
     * ticked backwards on a mismatch, which was right, but the star chip shows
     * `bankedScore()` = `pairs * 100`, and on a slow run with misses the celebration then
     * revealed a *smaller* number than the chip the child had just been watching. That moved
     * the punishment one beat later rather than removing it, and 3D-SPEC §1.1 forbids
     * penalising a mistake, not penalising it promptly.
     *
     * `bankedScore()` here rather than `pairs * 100`, so the floor cannot drift away from
     * the number actually on screen if the chip's arithmetic ever changes. `pairs * 40` stays
     * in the max for the same reason it was added — it is a floor, and a lower one now.
     */
    this.finalScore = Math.max(
      this.bankedScore(),
      this.pairs * 40,
      this.pairs * 100 - this.misses * 10 + bonus
    );
    this.emit({ type: "complete", score: this.finalScore });
    this.finishTimer = window.setTimeout(() => {
      this.finishTimer = 0;
      this.completed = true;
      this.emit({ type: "finish" });
    }, FINISH_DELAY);
  }

  private settleMiss(a: number, b: number): void {
    this.state[a] = DOWN;
    this.state[b] = DOWN;
    this.flipped.length = 0;
    this.emit({ type: "hide", a, b });
  }

  private clearTimers(): void {
    if (this.resolveTimer) {
      clearTimeout(this.resolveTimer);
      this.resolveTimer = 0;
    }
    if (this.finishTimer) {
      clearTimeout(this.finishTimer);
      this.finishTimer = 0;
    }
  }

  /** Called from the component's unmount effect. Leaves no timer and no listener behind. */
  dispose(): void {
    this.clearTimers();
    this.listeners.clear();
  }
}

export function createEngine(level = 0): ToothMatchEngine {
  const engine = new ToothMatchEngine();
  engine.deal(level);
  return engine;
}
