/**
 * Maze Escape's own self-tests. Registered from `MazeEscape.tsx` behind `?selftest=`, so
 * nothing here is in a child's bundle path.
 *
 * Two checks, both for round-4 findings the shared registry structurally could not make:
 *
 *  - **`maze-framing` (ME3).** The board was unplayable at 390×844 — off all four edges, the
 *    toothbrush entirely off screen — and nothing in the product could say so, because the
 *    page cannot resize its own window and no check ever projected the board. This does not
 *    need a resize: `cameraFor` is a pure function of the rect, so the test *asks it* for the
 *    framings the harness cannot reach and grades each one by projecting the fitted box with
 *    `projectBoardBounds`, the same projection the solve fits with. It also grades the **live**
 *    rect, which is the one thing arithmetic alone cannot check — that the measurement effect
 *    actually ran.
 *  - **`maze-hit` (ME7).** `?selftest=hit-targets` reports "no live colliders in this scene —
 *    nothing asserted" here, and correctly: the maze is traced over one picking plane and its
 *    only tap-size guarantee is the engine's snap radius. This measures the acceptance
 *    diameter that radius actually buys, in CSS pixels, from the live camera and the live view
 *    size, and asserts §8's 48 px floor.
 */
import { registerSelfTest, type SelfTestResult } from "../../dev/selftest";
import { playAreaMetrics } from "../../three/Scene3D";
import { cameraFor, cellSize, projectBoardBounds, type ChromeRect } from "./layout";
import type { MazeEscapeEngine } from "./engine";

/** The play-area rects the harness shoots, minus the shell's own 10 px page inset. */
const FRAMINGS: [string, number, number, number][] = [
  ["390x844 phone", 370, 768, 176],
  ["360x640 phone", 340, 566, 176],
  ["414x896 phone", 394, 820, 176],
  ["768x1024 tablet", 748, 930, 152],
  ["1024x768 tablet", 1004, 674, 138],
  ["1440x900 laptop", 825, 806, 138],
];

const SLACK = 0.002;

type Graded = {
  label: string;
  fov: number;
  scale: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  clearTop: number;
  pass: boolean;
};

function grade(label: string, w: number, h: number, chrome: number | ChromeRect): Graded {
  const framing = cameraFor(w, h, chrome);
  const b = projectBoardBounds(framing, w / h);
  const band = typeof chrome === "number" ? chrome : chrome.bottom;
  const clearTop = 1 - 2 * Math.min(0.34, band / h);
  return {
    label,
    fov: framing.fov,
    scale: framing.scale,
    minX: b.minX,
    maxX: b.maxX,
    minY: b.minY,
    maxY: b.maxY,
    clearTop,
    pass:
      Number.isFinite(b.minX) &&
      b.minX >= -1 - SLACK &&
      b.maxX <= 1 + SLACK &&
      b.minY >= -1 - SLACK &&
      b.maxY <= clearTop + SLACK,
  };
}

/** Reads the chrome rect the shell publishes on the play area, or its scalar fallback. */
function liveChrome(el: HTMLElement): number | ChromeRect {
  const style = getComputedStyle(el);
  const px = (name: string) => parseFloat(style.getPropertyValue(name));
  const left = px("--chrome-left");
  const top = px("--chrome-top");
  const right = px("--chrome-right");
  const bottom = px("--chrome-bottom");
  if (Number.isFinite(left) && Number.isFinite(top) && Number.isFinite(right) && Number.isFinite(bottom) && bottom > 0) {
    return { left, top, right, bottom };
  }
  const band = px("--chrome-h");
  return Number.isFinite(band) && band > 0 ? band : 138;
}

/**
 * Registers both tests. Idempotent: `registerSelfTest` re-arms the auto-run debounce, so
 * calling it once per mount would re-drive the whole suite on every scene entry.
 */
let registered = false;

export function registerMazeSelfTests(
  engine: MazeEscapeEngine,
  area: () => HTMLElement | null
): void {
  if (registered) return;
  registered = true;

  registerSelfTest("maze-framing", (): SelfTestResult => {
    const rows = FRAMINGS.map(([label, w, h, chrome]) => grade(label, w, h, chrome));
    const el = area();
    if (el !== null && el.offsetWidth > 0 && el.offsetHeight > 0) {
      rows.push(grade(`live ${el.offsetWidth}x${el.offsetHeight}`, el.offsetWidth, el.offsetHeight, liveChrome(el)));
    }
    const bad = rows.filter((r) => !r.pass);
    /*
     * The live row is also how this test catches the *cause* rather than the symptom. The
     * shipped defect was not a bad solve, it was a solve that never ran: `Board`'s measurement
     * effect read the play area's ref in a layout effect, where an ancestor's ref is always
     * still null, and never retried. A live rect of 0×0 — or one whose framing is identical to
     * `cameraFor(0, 0)` on a viewport that is nothing like square — means it has come back.
     */
    const stuck =
      el !== null && el.offsetWidth > 0
        ? (() => {
            const fallback = cameraFor(0, 0, 138);
            const live = cameraFor(el.offsetWidth, el.offsetHeight, liveChrome(el));
            const same =
              Math.abs(fallback.position[1] - live.position[1]) < 0.01 &&
              Math.abs(fallback.position[2] - live.position[2]) < 0.01;
            const square = Math.abs(el.offsetWidth / el.offsetHeight - 1) < 0.15;
            return same && !square;
          })()
        : false;
    return {
      name: "maze-framing",
      pass: bad.length === 0 && !stuck,
      detail:
        bad.length === 0 && !stuck
          ? `board and toothbrush inside the clear frame at all ${rows.length} framings`
          : stuck
            ? "the live framing is the 0x0 fallback: the play-area measurement never ran"
            : `off screen at ${bad.map((r) => r.label).join(", ")}`,
      data: { rows, stuck },
    };
  });

  registerSelfTest("maze-hit", (): SelfTestResult => {
    const metrics = playAreaMetrics();
    if (metrics === null || metrics.height <= 0) {
      return { name: "maze-hit", pass: false, detail: "no view mounted; nothing to measure" };
    }
    const el = area();
    const chrome = el !== null ? liveChrome(el) : 138;
    const w = el?.offsetWidth ?? metrics.width;
    const h = el?.offsetHeight ?? metrics.height;
    const framing = cameraFor(w, h, chrome);
    const dist = Math.hypot(
      framing.position[0] - framing.target[0],
      framing.position[1] - framing.target[1],
      framing.position[2] - framing.target[2]
    );
    const perUnit = metrics.height / (2 * dist * Math.tan((framing.fov * Math.PI) / 360));
    // Every board size, not only the one that happens to be loaded: a child changes level
    // without the viewport changing, and 13 cells is the one that fails.
    const rows = [9, 11, 13].map((n) => {
      const perCell = perUnit * cellSize(n) * framing.scale;
      const radius = Math.min(0.98, Math.max(0.78, 24 / perCell));
      return { cells: n, pxPerCell: perCell, snapRadius: radius, acceptancePx: 2 * radius * perCell };
    });
    const live = engine.setSnapFromPixels(perUnit * cellSize(engine.n) * framing.scale);
    const bad = rows.filter((r) => r.acceptancePx < 48);
    return {
      name: "maze-hit",
      pass: bad.length === 0,
      detail:
        bad.length === 0
          ? `snap acceptance ${rows.map((r) => `${r.cells}:${r.acceptancePx.toFixed(0)}px`).join(" ")} (live ${live.toFixed(0)} px)`
          : `snap acceptance under 48 px at ${bad.map((r) => `${r.cells} cells (${r.acceptancePx.toFixed(0)} px)`).join(", ")}` +
            ` — the corridor is ${bad[0].pxPerCell.toFixed(0)} px wide there and the snap is capped at 0.98 cells so a wall still bonks`,
      data: { view: metrics, distance: dist, fov: framing.fov, scale: framing.scale, rows },
    };
  });
}
