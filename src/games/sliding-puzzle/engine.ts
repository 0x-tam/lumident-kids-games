/**
 * Sliding Puzzle — all of the game logic, and none of the presentation.
 *
 * Zero React, zero three. The scene subscribes with `on()` and reacts to discrete events;
 * nothing about a tile's animation ever travels through React state.
 *
 * The rules are the 2D game's, preserved exactly (PROJECT.md + the previous
 * implementation):
 *
 *   • 2x2 / 3x3 / 4x4 by level, five scenes, a new one picked at random every run.
 *   • The board is scrambled by walking the blank with random legal moves — 12 / 40 / 90 of
 *     them — which is the only shuffle that cannot produce an unsolvable board, and the
 *     loop keeps going while the result is still the solved arrangement.
 *   • A tile moves only when it is orthogonally adjacent to the blank.
 *   • points = max(50, BASE[level] + max(0, PAR[level] − seconds) × 5 − moves × 2)
 *     with BASE = [200, 500, 900] and PAR = [45, 120, 300].
 *   • Players aged 8+ start on Medium.
 *
 * The one deliberate change: the score is frozen the instant the last tile lands, rather
 * than being read again after the finish delay, so the celebration beat can be as long as
 * it needs to be without costing the child points.
 */
import { sounds } from "../../shared/audio";
import { SCENES } from "./relief";

export const SIZES = [2, 3, 4] as const;
export const SHUFFLE_STEPS = [12, 40, 90] as const;
export const BASE = [200, 500, 900] as const;
/** Generous seconds before the time bonus runs out. */
export const PAR = [45, 120, 300] as const;
export const LEVEL_LABELS = ["2×2", "3×3", "4×4"];

/** How long the "the picture becomes one object" beat runs before the celebration. */
const FINISH_DELAY = 1000;

/** Shuffle by walking the blank tile with random legal moves — always solvable. */
export function shuffle(size: number): number[] {
  const n = size * size;
  const tiles = Array.from({ length: n }, (_, i) => i);
  let blank = n - 1;
  let prev = -1;
  const steps = SHUFFLE_STEPS[SIZES.indexOf(size as 2 | 3 | 4)];
  for (let s = 0; s < steps || tiles.every((t, i) => t === i); s++) {
    const r = Math.floor(blank / size);
    const c = blank % size;
    const neighbors = [
      r > 0 && blank - size,
      r < size - 1 && blank + size,
      c > 0 && blank - 1,
      c < size - 1 && blank + 1,
    ].filter((x): x is number => x !== false && x !== prev);
    const next = neighbors[Math.floor(Math.random() * neighbors.length)];
    [tiles[blank], tiles[next]] = [tiles[next], tiles[blank]];
    prev = blank;
    blank = next;
    if (s > 400) break;
  }
  return tiles;
}

export type EngineEvent =
  | { type: "deal" }
  | { type: "move"; tile: number; from: number; to: number }
  /**
   * A tap or an arrow that cannot move anything. Never an error — the scene answers with a
   * shrug and the shell with a friendly nudge, and nothing is lost.
   *   `empty` the empty slot itself was tapped · `far` that piece is not beside the gap ·
   *   `edge` the arrow points off the board.
   */
  | { type: "blocked"; pos: number; reason: "empty" | "far" | "edge" }
  | { type: "solve"; score: number }
  | { type: "finish" };

type Listener = (event: EngineEvent) => void;

export class SlidingPuzzleEngine {
  level: number;
  sceneIdx: number;
  /** `tiles[position] = tileId`. The blank piece is always the last id. */
  tiles: number[] = [];
  blankPos = 0;
  moves = 0;
  started = false;
  /** The arrangement is correct — the closing beat is playing. */
  solved = false;
  /** The closing beat is over; `GameShell` may celebrate. */
  completed = false;
  finalScore: number | undefined = undefined;
  /** Kept in step by the shell's once-a-second ticker. */
  seconds = 0;
  /**
   * High-water mark of `placed` — the number the HUD chip shows while the child plays.
   *
   * See `liveProgress`. It exists because the *score* is not something a 3-to-10-year-old may
   * watch go backwards, and `liveScore` goes backwards twice a second.
   */
  private bestPlaced = 0;
  /**
   * How many pieces the scramble happened to leave at home. Subtracted from both terms of
   * `liveProgress`, so the chip prices what the *child* did and not what the shuffle did.
   */
  private dealPlaced = 0;

  private listeners = new Set<Listener>();
  private finishTimer = 0;

  constructor(level: number, sceneIdx: number) {
    this.level = level;
    this.sceneIdx = sceneIdx;
    this.reset();
  }

  get size(): number {
    return SIZES[this.level];
  }

  get count(): number {
    const s = this.size;
    return s * s;
  }

  /** The piece that is missing from the picture while the puzzle is being played. */
  get blankId(): number {
    return this.count - 1;
  }

  get scene() {
    return SCENES[this.sceneIdx];
  }

  on(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private emit(event: EngineEvent): void {
    for (const fn of this.listeners) fn(event);
  }

  private reset(): void {
    this.tiles = shuffle(this.size);
    this.blankPos = this.tiles.indexOf(this.blankId);
    this.dealPlaced = this.placed;
    this.bestPlaced = this.dealPlaced;
    this.moves = 0;
    this.started = false;
    this.solved = false;
    this.completed = false;
    this.finalScore = undefined;
  }

  private clearTimer(): void {
    if (this.finishTimer) {
      clearTimeout(this.finishTimer);
      this.finishTimer = 0;
    }
  }

  /**
   * Start a run. Without an explicit picture it steps forward by a random amount, which is
   * the 2D game's rule and guarantees the new scene is never the one just played.
   */
  deal(level = this.level, sceneIdx?: number): void {
    this.clearTimer();
    this.level = level;
    this.sceneIdx =
      sceneIdx ??
      (this.sceneIdx + 1 + Math.floor(Math.random() * (SCENES.length - 1))) % SCENES.length;
    this.reset();
    this.emit({ type: "deal" });
  }

  /** The "Next picture" control: same level, same difficulty, the next scene along. */
  nextPicture(): void {
    this.deal(this.level, (this.sceneIdx + 1) % SCENES.length);
  }

  /**
   * The PROJECT.md formula, verbatim. Read exactly once per run, at the moment the last tile
   * lands, to set `finalScore` — and never shown while the child is playing.
   */
  liveScore(): number {
    return Math.max(
      50,
      BASE[this.level] + Math.max(0, PAR[this.level] - this.seconds) * 5 - this.moves * 2
    );
  }

  /** Pieces sitting in their home slot right now. The gap does not count as a piece. */
  get placed(): number {
    let n = 0;
    for (let pos = 0; pos < this.tiles.length - 1; pos++) if (this.tiles[pos] === pos) n++;
    return n;
  }

  /** Pieces there are to place — everything but the one the picture is missing. */
  get total(): number {
    return this.count - 1;
  }

  /**
   * What the HUD chip shows while the child plays.
   *
   * `liveScore` docks 2 points every time a tile slides and 5 points every second, and round 2
   * fed it straight into the star chip: a mistake, or simply thinking, visibly took points off
   * a number the child was watching. That is punitive feedback and `3D-SPEC §1.1` forbids it.
   *
   * This banks instead. It is the *best* number of pieces ever placed in this run, priced so a
   * finished picture banks exactly `BASE[level]` — so the chip only ever ticks up, a run that
   * goes backwards on the board costs nothing, and the celebration card is where the speed
   * bonus is revealed, once, as a reward. The scoring rule itself is untouched: `finalScore`
   * is still `liveScore()` frozen at the solve.
   *
   * **Both terms are measured from the deal, not from zero.** Round 3 photographed the chip
   * reading **★134 at `Moves: 0`, `0:00`**: at 2x2 the old pricing was `round(200/3) = 67` a
   * piece against a raw `placed`, so a scramble that happened to leave two of the three pieces
   * at home banked 134 of 200 before the child touched anything. The chip then barely moved
   * for the whole run — which is the one thing it exists to do — and two children who played
   * identically finished on different numbers because their shuffles differed. Pricing the
   * `total - dealPlaced` pieces the child actually has to place, over the `bestPlaced -
   * dealPlaced` they have placed, starts every run at 0 and ends every completed run at
   * exactly `BASE[level]`, whatever the scramble handed out.
   *
   * `remaining` cannot be zero: `shuffle()` loops while the arrangement is still solved, and
   * a board where every non-blank piece is home *is* the solved board (the blank has only one
   * slot left to be in). The guard is kept anyway — a zero here would be a NaN in the HUD.
   */
  liveProgress(): number {
    const remaining = this.total - this.dealPlaced;
    if (remaining <= 0) return BASE[this.level];
    const gained = this.bestPlaced - this.dealPlaced;
    return Math.round((BASE[this.level] * gained) / remaining);
  }

  private isSolved(): boolean {
    for (let i = 0; i < this.tiles.length; i++) if (this.tiles[i] !== i) return false;
    return true;
  }

  /** Tapping a cell tries to slide whatever is sitting in it into the empty space. */
  tapAt(pos: number): void {
    if (this.solved || pos < 0 || pos >= this.tiles.length) return;
    if (pos === this.blankPos) {
      this.emit({ type: "blocked", pos, reason: "empty" });
      return;
    }
    const size = this.size;
    const dr = Math.abs(Math.floor(pos / size) - Math.floor(this.blankPos / size));
    const dc = Math.abs((pos % size) - (this.blankPos % size));
    if (dr + dc !== 1) {
      sounds.oops();
      this.emit({ type: "blocked", pos, reason: "far" });
      return;
    }
    this.commit(pos);
  }

  /**
   * Keyboard play: the arrow says which way a tile should travel, so the tile that moves is
   * the one on the far side of the gap. Left/right are refused across a row wrap.
   */
  slide(dx: number, dz: number): void {
    if (this.solved) return;
    const size = this.size;
    const from = this.blankPos - (dz * size + dx);
    if (
      from < 0 ||
      from >= this.tiles.length ||
      (dx !== 0 && Math.floor(from / size) !== Math.floor(this.blankPos / size))
    ) {
      sounds.oops();
      this.emit({ type: "blocked", pos: this.blankPos, reason: "edge" });
      return;
    }
    this.commit(from);
  }

  private commit(from: number): void {
    const to = this.blankPos;
    const tile = this.tiles[from];
    this.tiles[from] = this.blankId;
    this.tiles[to] = tile;
    this.blankPos = from;
    this.moves += 1;
    this.started = true;
    const placed = this.placed;
    if (placed > this.bestPlaced) this.bestPlaced = placed;
    sounds.pop();
    this.emit({ type: "move", tile, from, to });

    if (!this.isSolved()) return;

    this.solved = true;
    this.finalScore = this.liveScore();
    sounds.sparkle();
    this.emit({ type: "solve", score: this.finalScore });
    this.clearTimer();
    this.finishTimer = window.setTimeout(() => {
      this.finishTimer = 0;
      this.completed = true;
      this.emit({ type: "finish" });
    }, FINISH_DELAY);
  }

  dispose(): void {
    this.clearTimer();
    this.listeners.clear();
  }
}

export function createEngine(level: number): SlidingPuzzleEngine {
  return new SlidingPuzzleEngine(level, Math.floor(Math.random() * SCENES.length));
}
