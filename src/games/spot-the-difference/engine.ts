/**
 * Spot the Difference — game logic.
 *
 * Knows nothing about React and nothing about three. It owns the level, the randomised
 * subset of differences, the found set, the score and the finish timer, and it publishes
 * discrete events. Two consumers subscribe: the shell (HUD + `announce`) and the scene
 * (pops, rings, ripples). The scene never re-renders on an event.
 *
 * Rules, levels, scoring and randomisation are the 2D game's, unchanged (PROJECT.md):
 *   find 3 / 4 / 5 of five possible differences, chosen fresh every run
 *   par 30 / 45 / 60 s · live score = found x 100
 *   final score = found x 100 + max(0, par - seconds) x 4
 *   players aged 8+ start on Medium · the run ends in a celebration, never a failure
 *
 * The only additions are the "oops" sound on a wrong tap and the `miss` event that carries
 * where the tap landed, so the scene can put a ripple there.
 */
import { sounds } from "../../shared/audio";
import { SPOTS } from "./layout";

/* ------------------------------------------------------------------ */
/* Configuration (unchanged from the 2D game)                          */
/* ------------------------------------------------------------------ */

export type DiffId = "brush" | "towel" | "duck" | "star" | "soap";

export type Diff = {
  id: DiffId;
  /** Spoken name, used by `announce` and by the progress pill's labels. */
  hint: string;
};

/** The five possible changes. A run uses a random subset; the rest stay identical. */
export const DIFFS: readonly Diff[] = [
  { id: "brush", hint: "toothbrush" },
  { id: "towel", hint: "towel" },
  { id: "duck", hint: "rubber duck" },
  { id: "star", hint: "star" },
  { id: "soap", hint: "soap bottle" },
];

/** Differences to find per level — Easy / Medium / Hard. */
export const COUNT = [3, 4, 5] as const;
/** Par times in seconds; finishing under par pays 4 points a second. */
export const PAR = [30, 45, 60] as const;

/** Gap between the last find and the celebration overlay. */
const FINISH_DELAY = 800;

/**
 * The terminator — how long a run may go without progress before the game points at an answer.
 *
 * This used to be the only run in the product that could fail to *end*. There is no timer, no
 * hint and no lose state, `finish()` is reachable only by finding every difference, and none of
 * that is going to change: a child cannot lose here. But a four-year-old who cannot see the
 * last one played forever and never got a celebration, and "never punitive" and "never
 * finishes" are not the same promise. `NUDGE_LIMIT` closes it.
 *
 * 45 s is longer than the Hard par time (60 s is par for five; this is 45 s since the *last*
 * find, so a child who is making progress never sees it at all), and long enough that a child
 * who is enjoying looking is not interrupted. It then repeats, because one swell can be missed.
 *
 * The scene answers with a swell on the prop (`NUDGE_SCALE` in `scene.tsx`) and the shell says
 * the same thing out loud, which is what makes it a hint a screen-reader child also gets.
 * After `NUDGE_LIMIT` of them the game stops asking and answers — see there.
 */
const NUDGE_DELAY = 45000;
const NUDGE_REPEAT = 22000;

/**
 * How many swells a child gets before the game simply shows them the answer.
 *
 * The nudge above closed half of this: a child who cannot see the last difference is pointed
 * at it. It did not close the other half, which is round 4's SD7 — **a swell is not an escape
 * hatch.** It repeats every 22 s forever, and a four-year-old who cannot see the difference
 * after the first swell is not more likely to see it after the ninth. The run still had no
 * terminator; it had a louder version of the same question.
 *
 * So after three swells — `45 + 22 + 22` = **89 seconds without a single find**, longer than
 * the Hard par time and far longer than any run that is going well — the game finds it *for*
 * the child and says so. Everything else about it is identical to finding it yourself: the
 * same sparkle, the same pop, the same badge, the same 100 points, and the run carries on to
 * the next difference or to the celebration. Nothing is scored down and nothing is taken away,
 * because there is no version of this product in which a child is punished for not seeing
 * something. What changes is only the words (`SpotTheDifference.tsx` says "Here it is" rather
 * than "Found it"), so the game never claims a child did something they did not do.
 *
 * Three rather than one because looking is the game: a child who is enjoying searching should
 * not have the answer taken off them the first time they pause. Three rather than five because
 * 89 s is already a long time to be stuck at four years old, and the counter resets on every
 * find — so a child who is making progress never reaches it at all.
 */
const NUDGE_LIMIT = 3;

export type SpotEvent =
  | { type: "deal" }
  /**
   * `revealed` is 1 when the game found it for the child after `NUDGE_LIMIT` swells rather
   * than the child finding it. Nothing about the outcome differs — see `NUDGE_LIMIT` — but
   * the shell must not say "Found it!" to a child who did not.
   */
  | { type: "found"; index: number; remaining: number; revealed: number }
  /**
   * `panel` is 0 or 1 for a tap, -1 when the check came from the keyboard.
   *
   * `already` is the index into `DIFFS` of a difference the child has **already found**, or
   * -1. Nothing about the outcome changes — a re-check still costs nothing and still answers
   * with the same ripple — but the words must: round 2 told a screen-reader player who
   * re-checked the towel that "the folded towel on the rail is the same in both pictures",
   * which is the one thing it is not, and which is unusable as feedback.
   */
  | { type: "miss"; panel: number; nx: number; ny: number; spot: number; already: number }
  /** Nothing has been found for `NUDGE_DELAY`. `index` is one difference still in play. */
  | { type: "nudge"; index: number }
  | { type: "complete"; score: number }
  | { type: "finish" };

/**
 * The scene's contribution to input: turning a normalised point inside a panel into the
 * index of the prop under it. Lives here rather than in the scene so `tap` and `checkSpot`
 * share one code path — a rule enforced for the pointer and not for the keyboard is a bug
 * waiting to be reported by exactly one child.
 */
export type SceneBridge = {
  pick: ((nx: number, ny: number) => number) | null;
};

/**
 * The original subset draw, preserved verbatim. `sort(() => Math.random() - 0.5)` is not a
 * uniform shuffle; it is kept because the brief is to preserve the existing randomisation,
 * and across five items it is indistinguishable from one in play.
 */
function pickDiffs(count: number): Uint8Array {
  const mask = new Uint8Array(DIFFS.length);
  const order = DIFFS.map((_d, i) => i).sort(() => Math.random() - 0.5);
  for (let i = 0; i < count && i < order.length; i++) mask[order[i]] = 1;
  return mask;
}

/* ------------------------------------------------------------------ */
/* Engine                                                              */
/* ------------------------------------------------------------------ */

export class SpotEngine {
  level = 0;
  /** 1 where this run's difference is live. Read straight from `useFrame`. */
  activeMask = new Uint8Array(DIFFS.length);
  /** 1 where the child has already found it. */
  foundMask = new Uint8Array(DIFFS.length);
  foundCount = 0;
  started = false;
  completed = false;
  finalScore: number | undefined;
  /** Elapsed seconds, pushed in by the shell's ticker; prices the time bonus. */
  seconds = 0;

  /** Filled in by the scene on mount, cleared on unmount. */
  readonly bridge: SceneBridge = { pick: null };

  private finishTimer = 0;
  private nudgeTimer = 0;
  /** Swells since the last find. Reset by every find, including a revealed one. */
  private nudges = 0;
  private readonly listeners = new Set<(event: SpotEvent) => void>();

  get target(): number {
    return COUNT[this.level];
  }

  /** Live score while playing: 100 a find, exactly as the 2D game. */
  liveScore(): number {
    return this.foundCount * 100;
  }

  on(fn: (event: SpotEvent) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private emit(event: SpotEvent): void {
    for (const fn of this.listeners) fn(event);
  }

  /** Start a fresh run. Also used by the level selector and the restart button. */
  deal(level: number = this.level): void {
    this.clearTimers();
    this.level = level < 0 ? 0 : level >= COUNT.length ? COUNT.length - 1 : level;
    this.activeMask = pickDiffs(COUNT[this.level]);
    this.foundMask = new Uint8Array(DIFFS.length);
    this.foundCount = 0;
    this.started = false;
    this.completed = false;
    this.finalScore = undefined;
    this.seconds = 0;
    this.nudges = 0;
    this.emit({ type: "deal" });
    this.armNudge(NUDGE_DELAY);
  }

  /**
   * Forces every difference on and nothing found. Only `?selftest=spot` calls this: the
   * pixel test needs a known board, and a random subset would test three diffs one run and
   * five the next.
   *
   * Deliberately does **not** arm the nudge: a prop swelling mid-capture is a prop at a
   * different scale in a test whose whole job is that nothing moves between two reads.
   */
  dealAll(): void {
    this.clearTimers();
    this.activeMask = new Uint8Array(DIFFS.length).fill(1);
    this.foundMask = new Uint8Array(DIFFS.length);
    this.foundCount = 0;
    this.started = false;
    this.completed = false;
    this.finalScore = undefined;
    this.nudges = 0;
    this.emit({ type: "deal" });
  }

  /**
   * A tap inside a panel. `nx`/`ny` are 0..1 from the panel's top-left corner.
   * Both panels are live, and a tap in either one counts.
   */
  tap(panel: number, nx: number, ny: number): void {
    if (this.completed) return;
    const spot = this.bridge.pick ? this.bridge.pick(nx, ny) : -1;
    this.resolve(spot, panel, nx, ny);
  }

  /** Keyboard / assistive tech: "check this prop". Same rules, same outcomes. */
  checkSpot(spot: number): void {
    if (this.completed) return;
    this.resolve(spot, -1, -1, -1);
  }

  private resolve(spot: number, panel: number, nx: number, ny: number): void {
    this.started = true;
    const diff = spot >= 0 && spot < SPOTS.length ? SPOTS[spot].diff : -1;
    const live = diff >= 0 && this.activeMask[diff] === 1;

    if (live && this.foundMask[diff] === 0) {
      this.award(diff, 0);
      return;
    }

    // Never a penalty and never an error: a wrong tap costs nothing and answers with a
    // ripple, so poking around the picture stays part of the fun.
    sounds.pop();
    this.emit({ type: "miss", panel, nx, ny, spot, already: live ? diff : -1 });
  }

  /**
   * Books a difference as found. One path for both ways of getting there — see `NUDGE_LIMIT`.
   *
   * The `revealed` flag is carried, not branched on: a revealed find sparkles, pops, scores
   * and re-arms exactly like an earned one, because "the child cannot lose" has to include
   * "the child cannot be shown they lost". Only the sentence the shell speaks differs.
   */
  private award(diff: number, revealed: number): void {
    sounds.sparkle();
    this.foundMask[diff] = 1;
    this.foundCount += 1;
    this.nudges = 0;
    this.emit({ type: "found", index: diff, remaining: this.target - this.foundCount, revealed });
    if (this.foundCount >= this.target) this.finish();
    // Progress. A child who is finding things is never nudged.
    else this.armNudge(NUDGE_DELAY);
  }

  private finish(): void {
    this.clearTimers();
    const bonus = Math.max(0, PAR[this.level] - this.seconds) * 4;
    this.finalScore = this.target * 100 + bonus;
    this.emit({ type: "complete", score: this.finalScore });
    this.finishTimer = window.setTimeout(() => {
      this.finishTimer = 0;
      this.completed = true;
      this.emit({ type: "finish" });
    }, FINISH_DELAY);
  }

  /**
   * (Re)arms the idle nudge. Cleared first every time, so this can never stack two timers —
   * the same discipline `clearTimers` applies to the finish delay, and the reason neither
   * leaves anything behind for `dispose()` to find.
   */
  private armNudge(delay: number): void {
    if (this.nudgeTimer) {
      clearTimeout(this.nudgeTimer);
      this.nudgeTimer = 0;
    }
    this.nudgeTimer = window.setTimeout(() => {
      this.nudgeTimer = 0;
      if (this.completed || this.finishTimer) return;
      const index = this.remainingIndex();
      if (index < 0) return;
      this.nudges += 1;
      if (this.nudges >= NUDGE_LIMIT) {
        // The terminator. `award` resets the counter and re-arms for the next difference, so
        // a child who is completely stuck is walked through the rest of the board one swell
        // at a time and still reaches the celebration.
        this.award(index, 1);
        return;
      }
      this.emit({ type: "nudge", index });
      this.armNudge(NUDGE_REPEAT);
    }, delay);
  }

  /** The lowest-indexed difference that is in play and not yet found, or -1. */
  private remainingIndex(): number {
    for (let i = 0; i < DIFFS.length; i++) {
      if (this.activeMask[i] === 1 && this.foundMask[i] === 0) return i;
    }
    return -1;
  }

  private clearTimers(): void {
    if (this.finishTimer) {
      clearTimeout(this.finishTimer);
      this.finishTimer = 0;
    }
    if (this.nudgeTimer) {
      clearTimeout(this.nudgeTimer);
      this.nudgeTimer = 0;
    }
  }

  /** Called from the component's unmount effect. Leaves no timer and no listener behind. */
  dispose(): void {
    this.clearTimers();
    this.listeners.clear();
    this.bridge.pick = null;
  }
}

export function createEngine(level = 0): SpotEngine {
  const engine = new SpotEngine();
  engine.deal(level);
  return engine;
}
