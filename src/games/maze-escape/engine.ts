/**
 * Maze Escape — game logic.
 *
 * The engine is the single source of truth for a run and knows nothing about React or
 * three. It owns the maze, the tooth's logical cell, the treats, the goal, the clock and
 * the score, and publishes discrete events. Two consumers subscribe:
 *
 *   • `MazeEscape.tsx` — flips `completed`, announces to screen readers, holds the HUD.
 *   • `scene.tsx`      — queues the tooth's travel. It never re-renders on a move.
 *
 * Rules carried over from the 2D implementation verbatim (PROJECT.md):
 *
 *   9 / 11 / 13-cell mazes, regenerated every run · start (1,1) · goal (n-2,n-2)
 *   movement follows the finger **only through open corridors** and at most
 *   `MAX_STEPS_PER_MOVE` = 3 cells per gesture, so the maze must be traced rather than
 *   tapped — a distant tap, including one on the goal itself, does nothing
 *   score = max(100, BASE[level] + max(0, PAR[level] − seconds) × 10)
 *   BASE 250 / 550 / 900 · PAR 35 / 70 / 110 · players aged 8+ start on Medium
 *   treats sit at up to `min(3, level + 2)` dead ends and give a playful "oops"
 *
 * The only additions are events the 3D layer needs — `bump` (the tooth nosing into a wall,
 * which is playful and costs nothing) and `focus` — plus the forgiving pointer snap in
 * `pointerTo`, which widens the corridor as a *target* without widening it as a *rule*.
 *
 * ## What the child sees while playing is not the score formula
 *
 * `runScore()` below is PROJECT.md's formula and it is untouched — it is what gets banked,
 * announced and submitted. But it *falls*, by ten points a second, from 600 to 250 on Easy,
 * and this file's own comment used to say so approvingly ("it ebbs away as the clock runs").
 * A number counting backwards in front of a three-year-old is a dread timer and it punishes
 * a mistake in the one product that promises never to; `3D-SPEC §1.1` forbids it outright.
 *
 * So the HUD chip reads `progressScore()` instead, which is banked ground: points for every
 * step of the maze the child has *closed* toward the toothbrush, tracked as a high-water
 * mark so wandering back down a dead end never takes any of it away. It is scaled to land
 * on exactly `BASE[level]` at the goal, so the celebration's final number — the real
 * formula, speed bonus and all — is always the chip's number *plus* something. The child
 * only ever watches it go up, and the adjustment is revealed once, at the end.
 */
import { sounds } from "../../shared/audio";
import {
  GRID,
  deadEnds,
  generateMaze,
  goalDistances,
  pathBetween,
  type Cell,
} from "./maze";

export const BASE = [250, 550, 900] as const;
export const PAR = [35, 70, 110] as const;
/** The tooth walks; it never teleports. */
export const MAX_STEPS_PER_MOVE = 3;

/** Gap between reaching the toothbrush and the celebration overlay. */
const FINISH_DELAY = 450;
/** Step blips are throttled so a fast drag chirps rather than buzzes. */
const POP_INTERVAL = 90;
/** A wall can only bonk this often, however hard the finger leans on it. */
const BUMP_INTERVAL = 260;
/** Re-entering a treat cell re-triggers it, but not faster than this. */
const TREAT_INTERVAL = 620;

/**
 * How far, in cells, the finger may miss a corridor and still be understood.
 *
 * The corridor is one cell wide, which at 13 cells on a phone is well under a 48 px target.
 * Rather than widen the corridor — that would change the maze — the pointer snaps to the
 * nearest open cell centre within this radius.
 *
 * The number is a radius **from the cell's centre**, so it buys `2 × 0.78` = 1.56 cells of
 * acceptance across a corridor that is 1.0 cell wide: 0.28 of a cell of overhang onto the
 * gum on each side, which is where the "1 + 2 × 0.28" the previous comment quoted came from.
 * Round 3 read that as a stale constant left over from a `SNAP_RADIUS` of 0.28 and asked for
 * it to be "corrected to 0.78"; the two statements are the same number and the correction
 * would have made it wrong. It is restated here as the radius it is so that it cannot be
 * misread a third time.
 *
 * It is deliberately under 1.0: a finger parked in the middle of a wall is exactly 1.0 from
 * the neighbouring corridor, so it still reads as "pushing against the wall" and bonks
 * instead of silently sliding through.
 */
const SNAP_RADIUS = 0.78;
/**
 * Ceiling on the adaptive snap, in cells.
 *
 * ME7: the acceptance strip across a corridor is `2 × snapRadius` cells wide, and on a 13-cell
 * board at phone width a cell is ~24 CSS px — so the fixed 0.78 buys 38 px of acceptance
 * against 3D-SPEC §8's 48 px floor. `MazeEscapeScene` therefore raises the radius from the
 * *measured* pixels-per-cell whenever the board is small on screen, and this is where it stops.
 *
 * 0.98 rather than 1.0 for the reason the constant above already gives: a finger parked at the
 * exact centre of a wall is 1.0 cell from the neighbouring corridor and has to read as
 * "pushing against the wall" and bonk, not slide silently through. 0.98 keeps that true with
 * 0.02 of a cell to spare and takes the 13-cell phone board to exactly 48 px.
 */
const SNAP_RADIUS_MAX = 0.98;

export type EngineEvent =
  | { type: "maze" }
  | { type: "move"; r: number; c: number; dr: number; dc: number }
  | { type: "bump"; dr: number; dc: number }
  | { type: "treat"; index: number }
  | { type: "complete"; score: number }
  | { type: "finish" }
  | { type: "focus"; on: boolean };

export class MazeEscapeEngine {
  level = 0;
  n: number = GRID[0];
  maze: boolean[][] = [];
  /**
   * How far the finger may miss a corridor, in cells. See `SNAP_RADIUS` / `SNAP_RADIUS_MAX`.
   *
   * Written by the scene from the live pixels-per-cell, never by the engine, and clamped on
   * the way in so no caller can widen it past the bonk boundary.
   */
  snapRadius: number = SNAP_RADIUS;


  /** Steps from every cell to the goal, -1 for walls. Rebuilt with the maze. */
  distances: Int16Array = new Int16Array(0);
  treats: Cell[] = [];
  goal: Cell = { r: 0, c: 0 };
  pos: Cell = { r: 1, c: 1 };

  started = false;
  completed = false;
  finalScore: number | undefined;
  /** Steps from the start cell to the goal on this maze. Fixed when the maze is built. */
  startDistance = 1;
  /**
   * The fewest steps-to-goal the tooth has ever stood at this run — a high-water mark, so
   * `progressScore()` is monotonic by construction rather than by careful bookkeeping.
   */
  bestRemaining = 1;
  /** Elapsed seconds, pushed in by the shell's ticker; prices the time bonus. */
  seconds = 0;
  /** True while the keyboard surface holds focus — the scene draws a focus ring. */
  focused = false;

  /** Set by the shell so a tap on the board can hand the keyboard surface focus. */
  focusRequest: (() => void) | null = null;

  private finishTimer = 0;
  private lastPop = 0;
  private lastBump = 0;
  private lastTreat = 0;
  private lastPointerCell = -1;
  private readonly listeners = new Set<(event: EngineEvent) => void>();

  get cells(): number {
    return this.n;
  }

  /**
   * The run's score: the 2D formula, verbatim from PROJECT.md.
   *
   * Read exactly once per run, at the moment the tooth reaches the toothbrush. It is never
   * shown while the child is playing — see `progressScore()` and the note at the top of this
   * file.
   */
  runScore(): number {
    return Math.max(100, BASE[this.level] + Math.max(0, PAR[this.level] - this.seconds) * 10);
  }

  /**
   * What the HUD chip shows while the child plays. **Never decreases.**
   *
   * Points for ground closed toward the toothbrush, banked against the best approach so far.
   * Scaled so that arriving pays exactly `BASE[level]` — the same base the final formula
   * starts from — which makes the celebration's number a *rise* from the chip's last value
   * in every run, whatever the clock did.
   */
  progressScore(): number {
    const banked = this.startDistance - this.bestRemaining;
    if (banked <= 0) return 0;
    return Math.round((BASE[this.level] * banked) / this.startDistance);
  }

  /** Steps remaining to the toothbrush from where the tooth stands, or -1. */
  stepsToGoal(): number {
    const at = this.pos.r * this.n + this.pos.c;
    return this.distances[at] ?? -1;
  }

  /** Which of the four neighbours are open, as a 4-bit mask: up, right, down, left. */
  openMask(): number {
    const { r, c } = this.pos;
    const n = this.n;
    let mask = 0;
    if (r > 0 && !this.maze[r - 1][c]) mask |= 1;
    if (c < n - 1 && !this.maze[r][c + 1]) mask |= 2;
    if (r < n - 1 && !this.maze[r + 1][c]) mask |= 4;
    if (c > 0 && !this.maze[r][c - 1]) mask |= 8;
    return mask;
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

  /** Start a fresh run: a brand new maze every single time, as the brief requires. */
  regenerate(level: number = this.level): void {
    this.clearTimers();
    this.level = level < 0 ? 0 : level >= GRID.length ? GRID.length - 1 : level;
    const n = GRID[this.level];
    this.n = n;
    this.maze = generateMaze(n);
    this.goal = { r: n - 2, c: n - 2 };
    this.distances = goalDistances(this.maze, n, this.goal);
    this.treats = deadEnds(this.maze, n).slice(0, Math.min(3, this.level + 2));
    this.pos = { r: 1, c: 1 };
    // Guarded: a degenerate maze that put the start on the goal would otherwise divide by
    // zero in `progressScore()`, which is not a thing a child should ever have to see.
    this.startDistance = Math.max(1, this.distances[1 * n + 1] ?? 1);
    this.bestRemaining = this.startDistance;
    this.started = false;
    this.completed = false;
    this.finalScore = undefined;
    this.seconds = 0;
    this.lastPointerCell = -1;
    this.lastPop = 0;
    this.lastBump = 0;
    this.lastTreat = 0;
    this.emit({ type: "maze" });
  }

  setFocused(on: boolean): void {
    if (this.focused === on) return;
    this.focused = on;
    this.emit({ type: "focus", on });
  }

  /* ---------------- movement ---------------- */

  /** One cell in a direction — the keyboard's whole vocabulary. */
  step(dr: number, dc: number): void {
    if (this.completed) return;
    const nr = this.pos.r + dr;
    const nc = this.pos.c + dc;
    if (nr < 0 || nr >= this.n || nc < 0 || nc >= this.n || this.maze[nr][nc]) {
      this.bump(dr, dc);
      return;
    }
    this.lastPointerCell = nr * this.n + nc;
    this.arrive(nr, nc, dr, dc);
  }

  /**
   * Follow the finger, but only when it stays near the tooth — the maze must be traced,
   * not tapped. A path longer than three cells, or no path at all, does nothing.
   */
  walkToward(target: Cell): void {
    if (this.completed) return;
    const steps = pathBetween(this.maze, this.n, this.pos, target);
    if (steps.length === 0 || steps.length > MAX_STEPS_PER_MOVE) return;
    for (const cell of steps) {
      const dr = cell.r - this.pos.r;
      const dc = cell.c - this.pos.c;
      this.arrive(cell.r, cell.c, dr, dc);
    }
  }

  /**
   * The pointer path. `u` / `v` are fractional cell coordinates, so the snap can measure a
   * real distance rather than rounding to a cell and losing the miss.
   */
  pointerTo(u: number, v: number): void {
    if (this.completed) return;
    const n = this.n;
    const ci = Math.floor(u);
    const ri = Math.floor(v);

    let bestR = -1;
    let bestC = -1;
    let bestD = Infinity;
    for (let r = ri - 1; r <= ri + 1; r++) {
      if (r < 0 || r >= n) continue;
      for (let c = ci - 1; c <= ci + 1; c++) {
        if (c < 0 || c >= n || this.maze[r][c]) continue;
        const dx = u - (c + 0.5);
        const dz = v - (r + 0.5);
        const d = dx * dx + dz * dz;
        if (d < bestD) {
          bestD = d;
          bestR = r;
          bestC = c;
        }
      }
    }

    if (bestR >= 0 && bestD <= this.snapRadius * this.snapRadius) {
      const at = bestR * n + bestC;
      // Most pointermove events land on the cell we already handled; skipping them keeps
      // the BFS off the input path entirely while a finger is dragging.
      if (at === this.lastPointerCell) return;
      this.lastPointerCell = at;
      this.walkToward({ r: bestR, c: bestC });
      return;
    }

    this.lastPointerCell = -1;
    if (ri < 0 || ri >= n || ci < 0 || ci >= n || !this.maze[ri][ci]) return;
    const dr = ri - this.pos.r;
    const dc = ci - this.pos.c;
    // Only a wall the tooth is actually leaning on bonks; a finger halfway across the
    // board is not "bumping into" anything.
    if (Math.abs(dr) + Math.abs(dc) === 1) this.bump(dr, dc);
  }

  /**
   * Sets the snap radius from a measured acceptance diameter in CSS pixels per cell.
   *
   * Clamped here rather than at the call site so the bonk boundary is guaranteed by the engine
   * that owns it. Returns the acceptance diameter it actually achieved, in pixels, which is
   * what `?selftest=maze-hit` asserts against §8's 48 px floor.
   */
  setSnapFromPixels(pxPerCell: number): number {
    if (!(pxPerCell > 0)) return 0;
    const wanted = 24 / pxPerCell;
    this.snapRadius =
      wanted < SNAP_RADIUS ? SNAP_RADIUS : wanted > SNAP_RADIUS_MAX ? SNAP_RADIUS_MAX : wanted;
    return 2 * this.snapRadius * pxPerCell;
  }

  /** Ends a drag so the next `pointerTo` is treated as a fresh gesture. */
  endGesture(): void {
    this.lastPointerCell = -1;
  }

  private arrive(r: number, c: number, dr: number, dc: number): void {
    this.started = true;
    this.pos = { r, c };

    // Bank the approach before anything else reads it, so the `move` event a listener gets
    // is already carrying the new progress number.
    const remaining = this.distances[r * this.n + c] ?? -1;
    if (remaining >= 0 && remaining < this.bestRemaining) this.bestRemaining = remaining;

    const now = performance.now();
    if (now - this.lastPop > POP_INTERVAL) {
      sounds.pop();
      this.lastPop = now;
    }
    this.emit({ type: "move", r, c, dr, dc });

    for (let i = 0; i < this.treats.length; i++) {
      const treat = this.treats[i];
      if (treat.r !== r || treat.c !== c) continue;
      if (now - this.lastTreat <= TREAT_INTERVAL) break;
      this.lastTreat = now;
      sounds.oops();
      this.emit({ type: "treat", index: i });
      break;
    }

    if (r === this.goal.r && c === this.goal.c && this.finalScore === undefined) {
      sounds.sparkle();
      this.finalScore = this.runScore();
      this.emit({ type: "complete", score: this.finalScore });
      this.finishTimer = window.setTimeout(() => {
        this.finishTimer = 0;
        this.completed = true;
        this.emit({ type: "finish" });
      }, FINISH_DELAY);
    }
  }

  /** A wall is never a failure — it is a soft bonk and a wobble, and nothing is lost. */
  private bump(dr: number, dc: number): void {
    const now = performance.now();
    if (now - this.lastBump <= BUMP_INTERVAL) return;
    this.lastBump = now;
    sounds.pop();
    this.emit({ type: "bump", dr, dc });
  }

  private clearTimers(): void {
    if (this.finishTimer) {
      clearTimeout(this.finishTimer);
      this.finishTimer = 0;
    }
  }

  /** Called from the component's unmount effect. No timer and no listener survives it. */
  dispose(): void {
    this.clearTimers();
    this.listeners.clear();
    this.focusRequest = null;
  }
}

export function createEngine(level = 0): MazeEscapeEngine {
  const engine = new MazeEscapeEngine();
  engine.regenerate(level);
  return engine;
}
