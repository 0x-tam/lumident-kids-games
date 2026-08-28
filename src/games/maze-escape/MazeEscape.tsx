/**
 * Maze Escape — guide a smiling tooth through corridors carved in coral gums.
 *
 * This file is the *shell*: it owns the React-visible state and nothing else. All game
 * logic lives in `engine.ts`, the maze in `maze.ts`, the maze's geometry in `build.ts` and
 * all presentation in `scene.tsx`; they talk through the engine's event emitter, never
 * through props that change while the tooth is moving.
 *
 * Rules, levels, scoring and randomisation are exactly the 2D game's (PROJECT.md):
 *   9 / 11 / 13-cell generated mazes, fresh every run · start (1,1), goal (n-2,n-2)
 *   the finger is followed only through open corridors and at most three cells per gesture,
 *   so the maze has to be traced — tapping the goal does nothing
 *   score = max(100, BASE + max(0, PAR − seconds) × 10), BASE 250/550/900, PAR 35/70/110
 *   — banked once, at the finish. The chip the child watches while playing shows *progress*
 *   toward the toothbrush, which only ever climbs; see `engine.ts`.
 *   treats at up to min(3, level + 2) dead ends · players aged 8+ start on Medium
 *
 * React renders here happen on discrete events only: a new maze, the finish, and the
 * once-a-second timer tick. A move does **not** re-render anything — during a fast drag the
 * engine can fire ten moves a second, and re-rendering the shell on each would put React on
 * the input path for no benefit at all, since the HUD depends only on the level and the
 * clock. The scene handles moves by mutating structs.
 *
 * ## Keyboard, and why not `useFocusGroup`
 *
 * The maze's whole keyboard vocabulary is "arrow key moves one cell", and `useFocusGroup`
 * spends the arrow keys on roving focus between items — a child would need two keystrokes
 * per step through a 13-cell maze. So the keyboard surface here is a real `role="application"`
 * region, which is the ARIA pattern for exactly this case: it tells assistive tech to stop
 * intercepting keys and hand them to the app. It is `pointer-events: none` so it can never
 * swallow a drag aimed at the board, and the scene hands it focus on the first tap; the 3D
 * side answers with the shared `<FocusRing>` around the tooth, and every state change is
 * spoken through `announce()` — including which corridors are open and how many steps are
 * left, so the maze is genuinely playable by ear.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import GameShell from "../../shared/GameShell";
import { usePlayer } from "../../shared/player";
import { fmtTime, useTicker } from "../../shared/useTicker";
import { markSceneEnter, markSceneExit } from "../../dev/perf";
import { announce } from "../../three/hit";
import { Scene3D, useGameArea } from "../../three/Scene3D";
import { FLAGS } from "../../three/store";
import { createEngine, type MazeEscapeEngine } from "./engine";
import { CHROME_PX, cameraFor, type ChromeRect } from "./layout";
import { MazeEscapeScene } from "./scene";

/** Arrow keys, plus WASD for the older children who reach for them. */
const KEYS: Record<string, [number, number]> = {
  ArrowUp: [-1, 0],
  ArrowDown: [1, 0],
  ArrowLeft: [0, -1],
  ArrowRight: [0, 1],
  w: [-1, 0],
  W: [-1, 0],
  s: [1, 0],
  S: [1, 0],
  a: [0, -1],
  A: [0, -1],
  d: [0, 1],
  D: [0, 1],
};

const DIR_NAME: Record<string, string> = {
  "-1,0": "Up",
  "1,0": "Down",
  "0,-1": "Left",
  "0,1": "Right",
};

const MASK_NAMES = ["up", "right", "down", "left"];

/** "up and right", "left, up and down" — a spoken list of the corridors from here. */
function openList(mask: number): string {
  const names: string[] = [];
  for (let i = 0; i < 4; i++) if (mask & (1 << i)) names.push(MASK_NAMES[i]);
  if (names.length === 0) return "nowhere";
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * Frames the board from the play area's real size.
 *
 * `GameShell` hands a game the whole shell interior — 1.03:1 on a laptop, 0.48:1 on an
 * upright phone — so the camera distance is solved from the rect rather than fixed (see
 * `cameraFor`). This component sits on the DOM side of `<Scene3D>`, which is the only place
 * `GameAreaContext` can be read: everything below the view renders in the R3F root and
 * shares no context with the page.
 */
function Board({
  engine,
  areaOut,
}: {
  engine: MazeEscapeEngine;
  /** Publishes the resolved play area upward, so `?selftest=` can grade the live rect. */
  areaOut: MutableRefObject<HTMLElement | null>;
}): JSX.Element {
  const area = useGameArea();
  const [rect, setRect] = useState<{ width: number; height: number; chrome: number | ChromeRect }>({
    width: 0,
    height: 0,
    chrome: CHROME_PX,
  });

  /*
   * ## The bug this retry exists for (ME3)
   *
   * This effect used to read `area?.current` once and `return` when it was null — and it is
   * *always* null here on the first commit. React attaches a host element's ref while walking
   * back **up** the tree, so an ancestor's ref (`GameShell`'s play area) is still unset when a
   * descendant's layout effect runs; `Scene3D` documents the same thing and retries for it.
   * The effect is keyed on `area`, an identity-stable ref object, so it never ran again: no
   * `ResizeObserver` was ever installed and `cameraFor` spent every session on the initial
   * `{ 0, 0, 138 }`. Reconstructed against the round-4 captures, that fallback predicts a
   * projected board height of 560.6 px at 1440×900 (measured 564), 471 px at 1024×768
   * (measured 471) and 534 px at 390×844 (measured 529) — the same camera on a laptop and on
   * a phone, which is why the phone frame showed four corridors and no toothbrush.
   *
   * The first retry is a **microtask**, not a frame: React's commit is synchronous inside one
   * task, so a microtask queued from a layout effect runs after every ref in that commit is
   * attached and still before the browser paints. The board is therefore framed correctly on
   * the first painted frame in the normal case, and the rAF ladder behind it is the same
   * belt-and-braces `Scene3D` carries for the case where it is not.
   */
  useLayoutEffect(() => {
    if (!area) return;
    let raf = 0;
    let cancelled = false;
    let observer: ResizeObserver | null = null;
    let attempts = 0;
    const RETRY_FRAMES = 8;

    const measure = (el: HTMLElement) => {
      // `offsetWidth` / `offsetHeight`, never `getBoundingClientRect()`: the panel is CSS
      // scaled during the hub → game flip, and a transformed rect reports a fraction of the
      // real size — which would solve the camera for a box the game never actually gets.
      const width = el.offsetWidth;
      const height = el.offsetHeight;
      const style = getComputedStyle(el);
      const px = (name: string): number => parseFloat(style.getPropertyValue(name));
      // `GameShell` publishes the chrome's measured *occupied rect* (A9). A corner of the
      // board may sit level with the title as long as it is not under it, which on an upright
      // phone is exactly where the two outer corridors are. `--chrome-h` is the documented
      // fallback and is what this read used to be.
      const left = px("--chrome-left");
      const top = px("--chrome-top");
      const right = px("--chrome-right");
      const bottom = px("--chrome-bottom");
      const band = px("--chrome-h");
      const chrome: number | ChromeRect =
        Number.isFinite(left) && Number.isFinite(top) && Number.isFinite(right) && Number.isFinite(bottom) && bottom > 0
          ? { left, top, right, bottom }
          : Number.isFinite(band) && band > 0
            ? band
            : CHROME_PX;
      setRect((prev) => {
        const prevBottom = typeof prev.chrome === "number" ? prev.chrome : prev.chrome.bottom;
        const nextBottom = typeof chrome === "number" ? chrome : chrome.bottom;
        const prevLeft = typeof prev.chrome === "number" ? 0 : prev.chrome.left;
        const nextLeft = typeof chrome === "number" ? 0 : chrome.left;
        const prevRight = typeof prev.chrome === "number" ? prev.width : prev.chrome.right;
        const nextRight = typeof chrome === "number" ? width : chrome.right;
        // Quantised: a one-pixel reflow must not spring the camera.
        return Math.abs(prev.width - width) < 6 &&
          Math.abs(prev.height - height) < 6 &&
          Math.abs(prevBottom - nextBottom) < 4 &&
          Math.abs(prevLeft - nextLeft) < 6 &&
          Math.abs(prevRight - nextRight) < 6
          ? prev
          : { width, height, chrome };
      });
    };

    const attach = () => {
      if (cancelled) return;
      const el = area.current;
      if (!el) {
        if (++attempts <= RETRY_FRAMES) raf = requestAnimationFrame(attach);
        else {
          console.error(
            "[maze-escape] the play area never attached its ref; the board is framed from " +
              "the fallback rect. Run ?selftest=maze-framing."
          );
        }
        return;
      }
      areaOut.current = el;
      measure(el);
      observer = new ResizeObserver(() => measure(el));
      observer.observe(el);
    };

    const el = area.current;
    if (el) attach();
    else queueMicrotask(attach);

    return () => {
      cancelled = true;
      if (raf !== 0) cancelAnimationFrame(raf);
      observer?.disconnect();
      areaOut.current = null;
    };
  }, [area, areaOut]);

  // One solve per measured rect, so the scene's `scale` prop only changes when the framing
  // does — `MazeEscapeScene` is memoised and a fresh object every render would defeat it.
  const chromeKey =
    typeof rect.chrome === "number"
      ? `b${rect.chrome}`
      : `r${rect.chrome.left},${rect.chrome.top},${rect.chrome.right},${rect.chrome.bottom}`;
  const framing = useMemo(
    () => cameraFor(rect.width, rect.height, rect.chrome),
    // `chromeKey` is the primitive stand-in for the rect object, which is rebuilt on every
    // measure; without it this memo would re-solve on every `ResizeObserver` tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rect.width, rect.height, chromeKey]
  );

  return (
    // `touch-none`: the page sets `touch-action: manipulation`, which still lets a browser
    // claim a drag as a pan. Tracing a maze is a drag; it cannot be shared with the scroller.
    <Scene3D className="touch-none" camera={framing}>
      {/*
        `scale` is 1 in every framing that fits inside §2's fov and distance bands, and below
        1 only where the board cannot be fitted at 16 units and 32°, where `cameraFor` shrinks
        it rather than crop a corridor off the edge. See `cameraFor`.
      */}
      <MazeEscapeScene engine={engine} scale={framing.scale} />
    </Scene3D>
  );
}

export default function MazeEscape(): JSX.Element {
  const { player } = usePlayer();

  // Created once, on the first render, and never replaced — `MazeEscapeScene` is memoised
  // on this identity, so nothing the shell re-renders can reach the 3D tree.
  const engineRef = useRef<MazeEscapeEngine | null>(null);
  if (!engineRef.current) engineRef.current = createEngine((player?.age ?? 5) >= 8 ? 1 : 0);
  const engine = engineRef.current;

  const [, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((v) => v + 1), []);

  const padRef = useRef<HTMLDivElement>(null);
  /** The play area, published by `Board` once it resolves. Read only by the self-tests. */
  const areaElRef = useRef<HTMLElement | null>(null);
  /** True for the duration of one `engine.step()`, so only keyboard moves are spoken. */
  const fromKeyboard = useRef(false);
  /**
   * Mirrors `engine.started` across renders.
   *
   * A move does not re-render this component — that is the whole point — but `useTicker`
   * reads its `running` flag at render time, so *something* has to re-render once when the
   * first move happens or the clock never starts and the finish never prices its bonus.
   * This makes that exactly one render per run rather than one per move.
   */
  const running = useRef(false);
  /**
   * Last progress number the HUD chip was rendered with.
   *
   * The chip now shows banked progress, which changes on a *move* — and a move deliberately
   * does not re-render this component. So one render is forced when, and only when, the
   * number actually changes. That is bounded by the maze's own solution length (30–70 for
   * the whole run, at most three per traced gesture), it is a discrete state change rather
   * than anything per-frame, and `MazeEscapeScene` is memoised on the engine's identity so
   * none of it reaches the 3D tree.
   */
  const banked = useRef(0);

  const [seconds, resetTimer] = useTicker(engine.started && !engine.completed);

  /** The engine reads this when the tooth reaches the brush, to price the time bonus. */
  useEffect(() => {
    engine.seconds = seconds;
  }, [engine, seconds]);

  useEffect(() => {
    engine.focusRequest = () => padRef.current?.focus({ preventScroll: true });
    return () => {
      engine.focusRequest = null;
    };
  }, [engine]);

  useEffect(
    () =>
      engine.on((event) => {
        switch (event.type) {
          case "maze":
            running.current = false;
            banked.current = 0;
            bump();
            // Carries the same three facts every `move` does — where you are, which
            // corridors leave it, how far the toothbrush is — so a player who cannot see
            // the board has something to act on before their first keystroke rather than a
            // free guess. `regenerate()` emits this synchronously after the maze, the
            // distance field and the start cell are all in place, so both reads are valid.
            // Assertive, and it clears the coalesced move lines with it: nothing said about
            // the old maze is true of this one.
            announce(
              `A new maze. The tooth starts in the top left corner, ` +
                `${engine.stepsToGoal()} steps from the toothbrush. ` +
                `Open: ${openList(engine.openMask())}.`,
              { assertive: true, coalesce: "move" }
            );
            break;
          case "move": {
            const progress = engine.progressScore();
            if (!running.current || progress !== banked.current) {
              running.current = true;
              banked.current = progress;
              bump();
            }
            if (!fromKeyboard.current) break;
            /*
             * `coalesce: "move"` (A17). Browser key auto-repeat fires an arrow every ~33 ms
             * and the live region cannot clear faster than 60 ms, so a held key used to build
             * a backlog the queue then read out for two seconds after the child stopped —
             * measured at 1,960 ms behind with seven stale lines still queued. Coalescing
             * drops the superseded move lines and keeps the newest, which is the only one
             * that describes where the tooth actually is.
             */
            announce(
              `${DIR_NAME[`${event.dr},${event.dc}`] ?? "Moved"}. Open: ${openList(
                engine.openMask()
              )}. ${engine.stepsToGoal()} steps to the toothbrush.`,
              { coalesce: "move" }
            );
            break;
          }
          case "bump":
            // Playful, never punitive: nothing is lost and the tooth simply bounces back.
            if (fromKeyboard.current) {
              // Same kind as a move: a bump is a statement about where the tooth is and which
              // corridors leave it, so a newer one supersedes an older one.
              announce(`Boing! That way is gum. Open: ${openList(engine.openMask())}.`, {
                coalesce: "move",
              });
            }
            break;
          case "treat":
            announce("Oops, a sweet! The tooth wobbles and carries on.", { coalesce: "treat" });
            break;
          case "complete":
            // Swaps the chip from the progress number to the banked one, which is always a
            // rise: the progress chip tops out at BASE and the final score starts there.
            bump();
            // Assertive: the completion line must jump the move backlog, not queue behind it.
            announce(
              `You reached the toothbrush! ${event.score.toLocaleString()} points` +
                (event.score > engine.progressScore()
                  ? `, including a speed bonus for finishing in ${fmtTime(engine.seconds)}.`
                  : "."),
              { assertive: true }
            );
            break;
          case "finish":
            bump();
            break;
          default:
            break;
        }
      }),
    [engine, bump]
  );

  useEffect(() => {
    markSceneEnter("maze-escape");
    return () => {
      markSceneExit("maze-escape");
      engine.dispose();
    };
  }, [engine]);

  /*
   * The two checks this game needs and the shared registry cannot make — the board's framing
   * at viewports the harness cannot resize to, and the snap radius's tap-target guarantee.
   * Dynamic and query-gated so neither the module nor `src/dev/selftest.ts` is in the chunk a
   * child downloads; static would also be an evaluation-order cycle, exactly as `hit.tsx`
   * documents for its own two.
   */
  useEffect(() => {
    if (FLAGS.selftest === null) return;
    let live = true;
    void import("./selftests").then((m) => {
      if (live) m.registerMazeSelfTests(engine, () => areaElRef.current);
    });
    return () => {
      live = false;
    };
  }, [engine]);

  const restart = useCallback(
    (level?: number) => {
      engine.regenerate(level ?? engine.level);
      resetTimer();
    },
    [engine, resetTimer]
  );

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const dir = KEYS[e.key];
    if (!dir) return;
    e.preventDefault();
    fromKeyboard.current = true;
    engine.step(dir[0], dir[1]);
    fromKeyboard.current = false;
  };

  const onFocus = (e: React.FocusEvent<HTMLDivElement>) => {
    // A pointer tap focuses this region too (the scene asks it to), and a focus ring drawn
    // round the tooth for a child who is using a finger is noise. `:focus-visible` is the
    // browser's own answer to "did this focus come from the keyboard".
    let visible = true;
    try {
      visible = e.currentTarget.matches(":focus-visible");
    } catch {
      visible = true;
    }
    engine.setFocused(visible);
  };

  return (
    <GameShell
      gameId="maze-escape"
      title="Maze Escape"
      subtitle="Drag the tooth along the path to the toothbrush."
      accent="coral"
      completed={engine.completed}
      score={engine.finalScore}
      hud={{
        levels: { value: engine.level, onChange: (level) => restart(level) },
        time: fmtTime(seconds),
        // Never `runScore()`: the chip a child watches must only ever climb. See engine.ts.
        score: engine.finalScore ?? engine.progressScore(),
      }}
      onRestart={() => restart()}
    >
      <div className="relative flex min-h-0 flex-1">
        <Board engine={engine} areaOut={areaElRef} />
        {/*
          The keyboard surface. `z-[2]` puts its focus ring above the view layer (which is
          portalled into the play area after this element and would otherwise paint over
          it); `pointer-events-none` guarantees it can never intercept a drag.
        */}
        <div
          ref={padRef}
          role="application"
          tabIndex={0}
          aria-label="Maze board. Arrow keys move the tooth one step through the corridors, or drag it with a finger. Walls are soft gum — bumping one costs nothing."
          onKeyDown={onKeyDown}
          onFocus={onFocus}
          onBlur={() => engine.setFocused(false)}
          /*
            `ring-coral-deep` at full strength, not `/60`. At 60 % over the page the blended
            stroke measures **2.28:1** against `#EDE7DC`, under the 3:1 that a non-text UI
            indicator has to clear; at full opacity it is 3.97:1. `outline-none` is only safe
            here because this ring replaces the outline rather than removing it — see
            `S14`, which is the same defect in two other games where nothing replaced it.
          */
          className="pointer-events-none absolute inset-0 z-[2] rounded-[26px] outline-none focus-visible:ring-4 focus-visible:ring-coral-deep"
        />
      </div>
    </GameShell>
  );
}
