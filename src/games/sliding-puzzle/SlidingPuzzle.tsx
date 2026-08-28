/**
 * Sliding Puzzle — clay tiles in a clay tray.
 *
 * This file is the *shell*: it owns the React-visible state and nothing else. All the game
 * logic lives in `engine.ts`, the picture in `relief.ts`, the extrusion of that picture
 * into real bevelled clay in `reliefMesh.ts`, and the board in `scene.tsx`. The shell and
 * the board talk through the engine's event emitter — never through props that change
 * while a tile is in the air.
 *
 * Rules, levels, scoring and randomisation are the 2D game's, unchanged (PROJECT.md):
 *   2x2 / 3x3 / 4x4 · five scenes, a fresh one every run · 12 / 40 / 90 scramble moves
 *   points = max(50, BASE[level] + max(0, PAR[level] − seconds) × 5 − moves × 2)
 *   with BASE = [200, 500, 900] and PAR = [45, 120, 300] · players aged 8+ start on Medium.
 *
 * What the child *sees* while playing is not that number. It is `engine.liveProgress()`,
 * which only ever goes up — the formula above docks two points per slide and five per second,
 * and round 2 put it straight in the star chip, so thinking cost a visible score in front of a
 * three-year-old. The formula is untouched and still sets `finalScore`; the celebration card
 * is where the difference is revealed, once, as a reward.
 *
 * React renders here happen on discrete events only — a move, a blocked tap, the finish,
 * and the once-a-second timer tick. The board itself renders zero times per frame, and
 * re-renders on exactly one event (`deal`).
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import GameShell from "../../shared/GameShell";
import { SwitchIcon } from "../../shared/icons";
import { usePlayer } from "../../shared/player";
import { fmtTime, useTicker } from "../../shared/useTicker";
import { markSceneEnter, markSceneExit } from "../../dev/perf";
import { announce } from "../../three/hit";
import { Scene3D, useGameArea } from "../../three/Scene3D";
import { isCelebrating } from "../../three/store";
import { LEVEL_LABELS, createEngine, type SlidingPuzzleEngine } from "./engine";
import { CHROME_PX, cameraFor } from "./layout";
import { SlidingPuzzleScene } from "./scene";

/* ------------------------------------------------------------------ */
/* Framing                                                             */
/* ------------------------------------------------------------------ */

const NOOP = (): void => {};

/**
 * Frames the tray from the play area's real size.
 *
 * `GameShell` hands a game the whole shell interior — about 1.15:1 on a laptop and 0.63:1 on
 * a phone held upright — so the camera distance has to be solved from the measured rect
 * rather than fixed (see `cameraFor`). It also publishes the measured height of its own title
 * and HUD band as `--chrome-h`, which is read here: this game used to hard-code 138 px for it,
 * and a game guessing at the shell's chrome is a subject framed behind a title bar.
 *
 * This component sits on the DOM side of `<Scene3D>`, which is the only place
 * `GameAreaContext` can be read: everything below the view renders in the R3F root and shares
 * no context with the page.
 *
 * It re-renders on resize and at no other time. The board is the same 3.0 units across at
 * every level, so a difficulty change never moves the camera at all.
 */
/** Frames to keep retrying for the play area's element before reporting it. */
const HOST_RETRY_FRAMES = 8;

function Board({ engine }: { engine: SlidingPuzzleEngine }): JSX.Element {
  const area = useGameArea();
  const [rect, setRect] = useState({ width: 0, height: 0, chrome: CHROME_PX });
  const remeasure = useRef<() => void>(NOOP);

  useLayoutEffect(() => {
    /*
     * The ref is resolved by retry, not read once.
     *
     * `GameShell` holds `areaRef` on an **ancestor** div and hands it down through
     * `GameAreaContext`; React attaches a host ref in the same bottom-up layout pass that
     * runs layout effects, so a descendant's layout effect runs before the ancestor's ref is
     * attached and `area.current` is null here on every mount. Round 4 shipped
     * `if (!el) return;` at the top, which meant no `ResizeObserver` was installed **and**
     * `remeasure.current` was never assigned — so the passive re-measure below, which the
     * comment under it calls "not belt-and-braces", was calling `NOOP`. `rect` stayed
     * `{0, 0, CHROME_PX}` and `cameraFor` framed the board for aspect 1 on every viewport.
     */
    let raf = 0;
    let attempts = 0;
    let cancelled = false;
    let observer: ResizeObserver | null = null;

    const install = (el: HTMLElement) => {
    const measure = () => {
      const box = el.getBoundingClientRect();
      // `GameShell` publishes the measured height of its title + HUD band here. Falling back
      // to the constant rather than to zero: a shell that stops publishing it must not make
      // the camera frame the subject *behind* the title.
      const raw = Number.parseFloat(getComputedStyle(el).getPropertyValue("--chrome-h"));
      const chrome = Number.isFinite(raw) && raw > 0 ? raw : CHROME_PX;
      setRect((prev) =>
        // Quantised: a one-pixel reflow must not spring the camera.
        Math.abs(prev.width - box.width) < 6 &&
        Math.abs(prev.height - box.height) < 6 &&
        Math.abs(prev.chrome - chrome) < 4
          ? prev
          : { width: box.width, height: box.height, chrome }
      );
    };
    measure();
    remeasure.current = measure;
    observer = new ResizeObserver(measure);
    observer.observe(el);
    };

    const resolve = () => {
      if (cancelled) return;
      const el = area?.current ?? null;
      if (!el) {
        if (++attempts <= HOST_RETRY_FRAMES) {
          raf = requestAnimationFrame(resolve);
        } else {
          console.error(
            "[sliding-puzzle] the play area never attached its ref after " +
              `${HOST_RETRY_FRAMES} frames; the board is framed from the fallback rect.`
          );
        }
        return;
      }
      // The microtask lands before React flushes passive effects, so the passive
      // re-measure below finds a real `remeasure.current` and does the job its own
      // docblock describes: read the band the parent's layout effect has just published.
      install(el);
    };
    if (area?.current) resolve();
    else queueMicrotask(resolve);

    return () => {
      cancelled = true;
      if (raf !== 0) cancelAnimationFrame(raf);
      remeasure.current = NOOP;
      observer?.disconnect();
    };
  }, [area]);

  /**
   * One re-measure after mount, and this is not belt-and-braces.
   *
   * React runs layout effects child-first, so the measure above is *guaranteed* to run
   * before `GameShell`'s own layout effect has written `--chrome-h`, and the first solve
   * therefore always falls back to the `CHROME_PX` guess. That guess is a laptop's band. On
   * a phone the title wraps to two lines and the level pills and the chip group fall onto
   * separate rows, so the real band runs past 200 px — and the camera framed the top of the
   * composition for a 138 px one. Round 3 photographed exactly that at 390x844: the timer
   * and star chips sitting on the reference plaque, which is the only thing on screen that
   * tells the child what they are building. A *passive* effect runs after every layout
   * effect in the tree, including the parent's, so this is the first moment the published
   * band can be read.
   *
   * `GameShell` also publishes the band as the play area's `padding-top`, so the observed
   * content box shrinks and the `ResizeObserver` fires too — but only in a browser with a
   * real one. `setRect` is quantised, so when nothing moved this costs a `getBoundingClientRect`
   * and no render.
   */
  useEffect(() => {
    remeasure.current();
  }, [area]);

  return (
    <Scene3D camera={cameraFor(rect.width, rect.height, rect.chrome)}>
      <SlidingPuzzleScene engine={engine} />
    </Scene3D>
  );
}

/* ------------------------------------------------------------------ */
/* Keyboard play                                                       */
/* ------------------------------------------------------------------ */

/**
 * Arrow keys slide the piece next to the gap — the arrow says which way the piece should
 * travel, so Right slides the piece on the gap's left.
 *
 * Bound in the **capture** phase on purpose. `hit.tsx`'s roving-focus group listens for
 * arrows on its own hidden container in the bubble phase; capturing first and stopping
 * propagation means the same key cannot both move focus and slide a tile. Tab still
 * reaches the board, Enter and Space still activate the focused slot, and Home/End still
 * move within the group — only the plain arrows are claimed for play.
 *
 * Shift+arrow is deliberately let through, so the roving focus ring can still be walked
 * across the board cell by cell: a keyboard player who wants to point at a specific slot
 * and press Enter can, and a player who just wants to play holds nothing down.
 *
 * **Why this is a component rather than an effect in the shell.** The listener is on
 * `window`, and `GameShell` retires the play area during the celebration by marking it
 * `inert` + `aria-hidden` — which stops pointers and focus and does exactly nothing to a
 * window listener. Round 3 captured the result: with focus on the celebration's heading,
 * ArrowRight/Left/Up moved tiles behind the dialog (`moves 0→1→2→3`) and re-solved the
 * board, while `preventDefault()` + `stopPropagation()` ate the keys a switch or keyboard
 * user needed to move inside the modal. Both guards below are needed and neither is
 * redundant: `isCelebrating()` is the product-wide state flag, and the `inert` test is the
 * general one — anything the shell ever retires the play area for retires play with it.
 * Reading `inert` needs the play-area node, which is only reachable from inside
 * `GameAreaContext`, so this sits under `GameShell` beside the board.
 */
function KeyboardPlay({ engine }: { engine: SlidingPuzzleEngine }): null {
  const area = useGameArea();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      let dx = 0;
      let dz = 0;
      switch (e.key) {
        case "ArrowLeft":
          dx = -1;
          break;
        case "ArrowRight":
          dx = 1;
          break;
        case "ArrowUp":
          dz = -1;
          break;
        case "ArrowDown":
          dz = 1;
          break;
        default:
          return;
      }
      // The celebration owns the screen: the arrows belong to whatever has focus inside it.
      if (isCelebrating()) return;
      // …and the same for anything else the shell ever retires the play area for.
      if (area?.current?.hasAttribute("inert")) return;
      const active = document.activeElement as HTMLElement | null;
      const tag = active?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || active?.isContentEditable) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      engine.slide(dx, dz);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [engine, area]);

  return null;
}

/* ------------------------------------------------------------------ */
/* Announcements                                                       */
/* ------------------------------------------------------------------ */

/**
 * A blind player has to be able to choose their next move from what they just heard.
 *
 * Round 2 announced the *direction* and the gap — "Moved left. Empty space at row 2, column
 * 3." — which is control state, not game state: it never said which piece had moved, so
 * there was no way to build a picture of the board and the puzzle was unsolvable without
 * sight. Every announcement below carries the piece's identity (a piece *is* its home slot,
 * because the picture is continuous), where it landed, where the gap is now, and how far
 * along the run is. `maze-escape` is the reference for this shape.
 */
const DIRECTION = (from: number, to: number, size: number): string => {
  if (to === from - 1) return "left";
  if (to === from + 1) return "right";
  if (to === from - size) return "up";
  return "down";
};

/** "row 2, column 3" for a board position. */
const SLOT = (pos: number, size: number): string =>
  `row ${Math.floor(pos / size) + 1}, column ${(pos % size) + 1}`;

const progressOf = (engine: SlidingPuzzleEngine): string =>
  `${engine.placed} of ${engine.total} pieces are home.`;

const BLOCKED: Record<"empty" | "far" | "edge", string> = {
  empty: "That is the empty space itself. Choose a piece beside it.",
  far: "Oops — that piece is not next to the empty space yet.",
  edge: "Oops — there is no piece to slide in from that side.",
};

/* ------------------------------------------------------------------ */
/* The game                                                            */
/* ------------------------------------------------------------------ */

export default function SlidingPuzzle(): JSX.Element {
  const { player } = usePlayer();

  // Created once, on the first render, and never replaced — `SlidingPuzzleScene` is
  // memoised on this identity, so nothing the shell re-renders can reach the 3D tree.
  const engineRef = useRef<SlidingPuzzleEngine | null>(null);
  if (!engineRef.current) engineRef.current = createEngine((player?.age ?? 5) >= 8 ? 1 : 0);
  const engine = engineRef.current;

  const [, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((v) => v + 1), []);

  const [seconds, resetTimer] = useTicker(engine.started && !engine.solved);

  /** The engine reads this the moment the last tile lands, to price the time bonus. */
  useEffect(() => {
    engine.seconds = seconds;
  }, [engine, seconds]);

  useEffect(
    () =>
      engine.on((event) => {
        bump();
        switch (event.type) {
          case "deal":
            announce(
              `${engine.scene.name}: a ${engine.size} by ${engine.size} picture with one ` +
                "piece missing. An arrow key slides the piece on that side of the gap into " +
                "it, so Right slides the piece to the gap's left. Hold Shift with an arrow " +
                `to move between slots. The gap is at ${SLOT(engine.blankPos, engine.size)}. ` +
                progressOf(engine)
            );
            break;
          case "move": {
            const size = engine.size;
            // A tile's id *is* its home slot, and the picture is one continuous relief, so
            // "the row 1, column 4 piece" names a real, findable piece of the image.
            const home = SLOT(event.tile, size);
            const landed = SLOT(event.to, size);
            const settled = event.to === event.tile ? ", where it belongs" : "";
            announce(
              `The ${home} piece moved ${DIRECTION(event.from, event.to, size)} into ` +
                `${landed}${settled}. The gap is now at ${SLOT(engine.blankPos, size)}. ` +
                progressOf(engine)
            );
            break;
          }
          case "blocked":
            // Playful, never punitive: nothing is lost and nothing is taken away.
            announce(
              `${BLOCKED[event.reason]} The gap is at ${SLOT(engine.blankPos, engine.size)}.`
            );
            break;
          case "solve":
            announce(
              `The picture is complete — all ${engine.total} pieces are home. ` +
                `${engine.scene.name}.`
            );
            break;
          default:
            break;
        }
      }),
    [engine, bump]
  );

  useEffect(() => {
    markSceneEnter("sliding-puzzle");
    return () => {
      markSceneExit("sliding-puzzle");
      engine.dispose();
    };
  }, [engine]);

  const restart = useCallback(
    (level?: number) => {
      engine.deal(level ?? engine.level);
      resetTimer();
    },
    [engine, resetTimer]
  );

  const nextPicture = useCallback(() => {
    engine.nextPicture();
    resetTimer();
  }, [engine, resetTimer]);

  return (
    <GameShell
      gameId="sliding-puzzle"
      title="Sliding Puzzle"
      subtitle="Slide the tiles. Rebuild the picture."
      accent="mauve"
      completed={engine.completed}
      score={engine.finalScore}
      hud={{
        levels: { value: engine.level, onChange: (level) => restart(level), labels: LEVEL_LABELS },
        time: fmtTime(seconds),
        // Progress banked, never the running score, and **never `finalScore`**: see
        // `engine.liveProgress`. X1.
        //
        // `finalScore` is the PROJECT.md formula, which docks 2 a move and 5 a second and
        // floors at 50 — so it can land far *below* the banked progress the chip has been
        // showing. `solve` sets it a full `FINISH_DELAY` (1000 ms) before `completed` flips
        // and the celebration covers the chrome, so reading it here put a visibly smaller
        // number on screen for a second at the exact moment the child won: an Easy run
        // solved slowly drops the chip 200 -> 80. That is X1 surviving into the last second
        // of the run. The speed bonus is revealed once, on the celebration card, which is
        // handed the full formula through `score={engine.finalScore}` below.
        score: engine.liveProgress(),
      }}
      onRestart={() => restart()}
    >
      <Board engine={engine} />
      <KeyboardPlay engine={engine} />

      {/*
        The only DOM this game owns. `z-index: 1` is not optional — `Scene3D` portals its
        pointer-accepting view layer into the play area at `z-index: 0`, and anything below
        that is both invisible and unclickable.
      */}
      {/*
        The only DOM this game owns, and the camera knows about it: `layout.ts::FOOTER_PX` is
        this row's height, and `cameraFor` keeps the tray's front lip above it. Round 2 drew
        "Moves: 0" straight on top of the tray. `min-h` rather than padding so the reserved
        band and the rendered band are the same number.
      */}
      <div className="pointer-events-none relative z-[1] mt-auto flex min-h-[48px] flex-wrap items-center justify-center gap-3">
        <p className="font-display text-[15px] font-semibold text-ink-mid" aria-live="off">
          Moves: {engine.moves}
        </p>
        {/*
          The one control a child presses mid-run, so it does not rely on the word.

          Round 4's SP5 is about exactly this — "nothing in the chrome is legible to a
          pre-reader" — and the level pills, the other half of it, are `GameShell`'s to render
          (`hud.levels.labels` is `string[]`, and the string is also the button's accessible
          name, so a pictograph there would be a pictograph in VoiceOver too). This half is
          mine: `SwitchIcon` is the shared two-arrow swap glyph, `aria-hidden` because the
          button's own text is already the accessible name, so the icon adds a read for a
          three-year-old and adds nothing at all for a screen reader.
        */}
        <button
          type="button"
          onClick={nextPicture}
          className="clay-btn pointer-events-auto flex items-center gap-2 rounded-full px-5 py-[9px] text-[14.5px]"
        >
          <SwitchIcon className="h-[18px] w-[18px]" />
          Next picture
        </button>
      </div>
    </GameShell>
  );
}
