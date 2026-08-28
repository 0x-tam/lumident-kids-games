/**
 * Healthy or Not? — game logic.
 *
 * The engine owns a run and knows nothing about React or about three. It holds the deal,
 * the round cursor, the score, the two resolve timers, and it publishes discrete events.
 * Two consumers subscribe:
 *
 *   • `HealthyOrNot.tsx` — re-renders the HUD and announces to screen readers.
 *   • `scene.tsx`        — starts prop animations. It never re-renders on an event.
 *
 * Rules, levels, scoring, the time bonus and the randomised deal are carried over from the
 * 2D implementation unchanged (PROJECT.md):
 *
 *   8 / 10 / 12 rounds · multiplier 1 / 1.5 / 2 · par 40 / 55 / 70 s
 *   a correct answer pays `round(100 × multiplier)`, a wrong one pays nothing
 *   final score = points + max(0, par − seconds) × 2
 *   players aged 8+ start on Medium · the deal is re-randomised every run
 *
 * The one thing that is new is the *shape* of an answer. The 2D game had two buttons — the
 * food itself and "Not for teeth" — and this engine still takes exactly those two choices,
 * `"feed"` and `"wave"`. What the child touches is `scene.tsx`'s business: three props are
 * wired to those two choices (the food and the mascot both feed; the dish waves off), which
 * is a presentation decision and changes no rule here. Which choice is right depends on the
 * food, exactly as before. What changed is only what a wrong answer looks like: nothing is
 * taken away, the food still ends up where it belongs (healthy food goes to the tooth,
 * sugary food is waved off) and the child simply earns no points for that round.
 */
import { sounds } from "../../shared/audio";

/* ------------------------------------------------------------------ */
/* Food table                                                          */
/* ------------------------------------------------------------------ */

/**
 * Tooth-friendly foods. Six, as in the 2D game.
 *
 * `strawberry` stands in for the brief's broccoli: the brand has five accent families and
 * all five are reds — there is no green anywhere in `tokens.ts`, and a mauve broccoli is
 * not something a four year old reads as broccoli. A strawberry is instantly readable in
 * the palette we actually have, and it was in the 2D game's healthy list already.
 */
export const HEALTHY_IDS = ["apple", "carrot", "milk", "cheese", "water", "strawberry"] as const;

/** Sugary foods. Six, as in the 2D game. */
export const SUGARY_IDS = ["lollipop", "soda", "cake", "candy", "donut", "cupcake"] as const;

export type FoodId = (typeof HEALTHY_IDS)[number] | (typeof SUGARY_IDS)[number];

/** Spoken names for `announce()`. Every prop is wordless on screen; this is the audio copy. */
export const FOOD_LABELS: Record<FoodId, string> = {
  apple: "an apple",
  carrot: "a carrot",
  milk: "a bottle of milk",
  cheese: "a piece of cheese",
  water: "a glass of water",
  strawberry: "a strawberry",
  lollipop: "a lollipop",
  soda: "a fizzy drink",
  cake: "a cake",
  candy: "a sweet",
  donut: "a doughnut",
  cupcake: "a cupcake",
};

/** Rounds per level — Easy / Medium / Hard. */
export const ROUNDS = [8, 10, 12] as const;
/** Points multiplier per level. */
export const MULT = [1, 1.5, 2] as const;
/** Par times in seconds; finishing under par pays 2 points a second. */
export const PAR = [40, 55, 70] as const;

/** Largest deal, so the scene can size its instance buffers once and never resize them. */
export const MAX_ROUNDS = ROUNDS[ROUNDS.length - 1];

export type Food = { key: number; id: FoodId; healthy: boolean };

/** Which of the two answers the child gave. */
export type Choice = "feed" | "wave";
/** Where the food goes once the round is answered. Never depends on the answer. */
export type Exit = "eat" | "away";

export type EngineEvent =
  | { type: "deal" }
  /** A new food has taken the pedestal. */
  | { type: "present"; round: number; food: Food }
  | {
      type: "answer";
      round: number;
      food: Food;
      choice: Choice;
      correct: boolean;
      exit: Exit;
      earned: number;
    }
  /** A tap that arrived while the previous answer was still playing out. */
  | { type: "reject" }
  | { type: "complete"; score: number }
  | { type: "finish" };

/**
 * Delay from the answer to the next food arriving. The correct-answer beat is the 2D
 * game's 850 ms rounded up to cover the 620 ms flight plus its landing; the "oops" beat is
 * longer because the wobble plays first and the food only leaves afterwards.
 */
const ADVANCE_CORRECT = 900;
const ADVANCE_OOPS = 1250;
/** Gap between the last round resolving and the celebration taking the screen. */
const FINISH_DELAY = 800;

/**
 * The original deal, preserved verbatim: shuffle a doubled healthy pool and take the first
 * half of the rounds from it, shuffle a doubled sugary pool and take the rest, then shuffle
 * the two together. `sort(() => Math.random() - 0.5)` is not a uniform shuffle; it is kept
 * as-is because the brief is to preserve the existing randomisation, and across 8–12 items
 * it is indistinguishable from one in play.
 */
function dealRounds(count: number): Food[] {
  const half = count / 2;
  const healthy = [...HEALTHY_IDS, ...HEALTHY_IDS]
    .sort(() => Math.random() - 0.5)
    .slice(0, Math.ceil(half))
    .map((id) => ({ id: id as FoodId, healthy: true }));
  const sugary = [...SUGARY_IDS, ...SUGARY_IDS]
    .sort(() => Math.random() - 0.5)
    .slice(0, Math.floor(half))
    .map((id) => ({ id: id as FoodId, healthy: false }));
  return [...healthy, ...sugary]
    .sort(() => Math.random() - 0.5)
    .map((food, key) => ({ key, ...food }));
}

/* ------------------------------------------------------------------ */
/* Engine                                                              */
/* ------------------------------------------------------------------ */

export class HealthyEngine {
  level = 0;
  foods: Food[] = [];
  round = 0;
  score = 0;
  started = false;
  completed = false;
  finalScore: number | undefined;
  /** Elapsed seconds, pushed in by the shell's ticker; prices the time bonus. */
  seconds = 0;
  /** True while an answer is playing out — further taps are politely refused. */
  busy = false;

  private advanceTimer = 0;
  private finishTimer = 0;
  private readonly listeners = new Set<(event: EngineEvent) => void>();

  get rounds(): number {
    return ROUNDS[this.level];
  }

  get perCorrect(): number {
    return Math.round(100 * MULT[this.level]);
  }

  get current(): Food | undefined {
    return this.foods[this.round];
  }

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

  /** Start a fresh run. Also used by the level selector and the restart button. */
  deal(level: number = this.level): void {
    this.clearTimers();
    this.level = level < 0 ? 0 : level >= ROUNDS.length ? ROUNDS.length - 1 : level;
    this.foods = dealRounds(ROUNDS[this.level]);
    this.round = 0;
    this.score = 0;
    this.started = false;
    this.completed = false;
    this.finalScore = undefined;
    this.seconds = 0;
    this.busy = false;
    this.emit({ type: "deal" });
  }

  /**
   * The one input path. Pointer, keyboard and assistive tech all land here, so a rule can
   * never be enforced for one of them and not the others.
   */
  answer(choice: Choice): void {
    if (this.completed || this.finalScore !== undefined) return;
    const food = this.foods[this.round];
    if (!food) return;
    if (this.busy) {
      this.emit({ type: "reject" });
      return;
    }

    this.busy = true;
    this.started = true;

    const correct = choice === "feed" ? food.healthy : !food.healthy;
    // Where the food goes is a property of the *food*, never of the answer: a sugary
    // treat is always waved off and a healthy one always reaches the tooth, so a child
    // who guesses wrong still watches the right thing happen.
    const exit: Exit = food.healthy ? "eat" : "away";
    const earned = correct ? this.perCorrect : 0;

    if (correct) {
      this.score += earned;
      sounds.sparkle();
    } else if (choice === "feed") {
      // Tapped a sugary food: the 2D game's "oops".
      sounds.oops();
    } else {
      // Waved off something healthy: the 2D game's gentler "hint" note.
      sounds.pop();
    }

    this.emit({ type: "answer", round: this.round, food, choice, correct, exit, earned });

    this.advanceTimer = window.setTimeout(
      () => {
        this.advanceTimer = 0;
        this.advance();
      },
      correct ? ADVANCE_CORRECT : ADVANCE_OOPS
    );
  }

  private advance(): void {
    if (this.round + 1 >= this.rounds) {
      const bonus = Math.max(0, PAR[this.level] - this.seconds) * 2;
      this.finalScore = this.score + bonus;
      this.emit({ type: "complete", score: this.finalScore });
      this.finishTimer = window.setTimeout(() => {
        this.finishTimer = 0;
        this.completed = true;
        this.emit({ type: "finish" });
      }, FINISH_DELAY);
      return;
    }
    this.round += 1;
    this.busy = false;
    this.emit({ type: "present", round: this.round, food: this.foods[this.round] });
  }

  private clearTimers(): void {
    if (this.advanceTimer) {
      clearTimeout(this.advanceTimer);
      this.advanceTimer = 0;
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

export function createEngine(level = 0): HealthyEngine {
  const engine = new HealthyEngine();
  engine.deal(level);
  return engine;
}
