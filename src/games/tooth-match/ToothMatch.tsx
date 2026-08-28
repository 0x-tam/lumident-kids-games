/**
 * Tooth Match — memory pairs, in clay.
 *
 * This file is the *shell*: it owns the React-visible state and nothing else. All game
 * logic lives in `engine.ts`, all presentation in `scene.tsx`, and the two talk through
 * the engine's event emitter — never through props that change while the board is moving.
 *
 * Rules, levels, scoring and the deal are exactly the 2D game's (PROJECT.md):
 *   3 / 6 / 8 pairs · par 30 / 75 / 110 s
 *   final score = max(banked, pairs × 40, pairs × 100 − misses × 10 + max(0, par − seconds) × 3)
 *   players aged 8+ start on Medium · the deal is re-randomised every run.
 *
 * The star chip shows `engine.bankedScore()` — matched pairs only, monotonically up, for
 * the whole time the chip is on screen. The miss and time terms are still in the final
 * score above; they are revealed once, on the celebration card, and never as a number
 * ticking backwards in front of a child who has just made a mistake (3D-SPEC §1.1).
 *
 * React renders here happen on discrete events only: a flip, a match, a miss, a deal, the
 * finish, and the once-a-second timer tick. The board itself renders zero times per frame.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import GameShell from "../../shared/GameShell";
import { usePlayer } from "../../shared/player";
import { fmtTime, useTicker } from "../../shared/useTicker";
import { markSceneEnter, markSceneExit } from "../../dev/perf";
import { announce } from "../../three/hit";
import { Scene3D, useGameArea } from "../../three/Scene3D";
import { MOTIF_LABELS, createEngine, type ToothMatchEngine } from "./engine";
import { CHROME_FALLBACK_PX, cameraFor } from "./layout";
import { ToothMatchScene } from "./scene";

/** How many frames to keep retrying for the play area's element before giving up. */
const HOST_RETRY_FRAMES = 8;

/**
 * The play area's rect, *predicted* from the window, for the one render before the element
 * exists to be measured.
 *
 * `Scene3D`'s `ViewCamera` snaps to the first framing it is handed and springs to every one
 * after it, so handing it a rect of `0 x 0` — which is what this component did until round 4
 * — is not merely a wrong first frame: it is the framing the camera *starts* from, and every
 * correction after it is a visible zoom. Predicting it keeps that correction inside a few
 * per cent.
 *
 * The numbers are `GamesCollection.tsx`'s own layout, read off the class list rather than
 * guessed: the panel is `mx-auto max-w-[860px] px-4 pt-4 pb-5` inside `h-dvh`, above it a
 * `mb-3` row holding one `py-3 text-base` button (12 + 24 + 12 = 48, plus the 12 of `mb-3`).
 * `GamesCollection.tsx:111` predicts the same rect the same way for the entry flip, and for
 * the same reason.
 *
 * The chrome band is genuinely not predictable — it depends on whether the subtitle and the
 * chip row wrap — so it keeps `CHROME_FALLBACK_PX` until the shell publishes the real one.
 */
const PANEL_MAX_WIDTH = 860;
const PANEL_SIDE_PADDING = 16;
const PANEL_ABOVE = 16 + 12 + 48;
const PANEL_BELOW = 20;
function predictedRect(): { width: number; height: number; chrome: number } {
  // Never a zero rect, even with no `window`: `cameraFor`'s degenerate branch is a guard, not
  // a framing, and handing it one is the defect this whole function exists to have stopped.
  if (typeof window === "undefined") {
    return { width: PANEL_MAX_WIDTH - 2 * PANEL_SIDE_PADDING, height: 700, chrome: CHROME_FALLBACK_PX };
  }
  const width = Math.min(PANEL_MAX_WIDTH, window.innerWidth) - 2 * PANEL_SIDE_PADDING;
  const height = window.innerHeight - PANEL_ABOVE - PANEL_BELOW;
  return {
    width: width > 1 ? width : PANEL_MAX_WIDTH - 2 * PANEL_SIDE_PADDING,
    height: height > 1 ? height : 700,
    chrome: CHROME_FALLBACK_PX,
  };
}

/**
 * Frames the board from the play area's real size.
 *
 * `GameShell` hands a game the whole shell interior — 1.03:1 on a laptop, 0.48:1 on an
 * upright phone — so the camera distance has to be solved from the rect rather than fixed
 * per level (see `cameraFor`). This component sits on the DOM side of `<Scene3D>`, which is
 * the only place `GameAreaContext` can be read: everything below the view renders in the
 * R3F root and shares no context with the page.
 *
 * It re-renders on resize and on a level change and at no other time; the camera prop is
 * destructured to primitives inside `Scene3D`, so an unchanged framing costs nothing and a
 * changed one is a spring move, never a cut.
 */
function Board({ engine }: { engine: ToothMatchEngine }): JSX.Element {
  const area = useGameArea();
  const [rect, setRect] = useState(predictedRect);

  /*
   * ## The defect this effect exists to have fixed (TM1)
   *
   * This was a `useLayoutEffect` with `if (!el) return;` at the top and `[area]` as its
   * dependency, and the combination made it a no-op for the life of every mount:
   *
   *   - React attaches a host element's `ref` while walking *up* the tree, so an ancestor's
   *     ref is still null when a descendant's **layout** effect runs. `areaRef` lives on
   *     `GameShell`, which is this component's ancestor, so `area.current` was always null
   *     here. (`Scene3D` documents exactly this and uses a passive effect for it.)
   *   - the early return meant no `ResizeObserver` was ever created;
   *   - and `area` is an identity-stable ref *object*, so the effect never re-ran and there
   *     was nothing to recover it.
   *
   * So `rect` stayed `{0, 0, 132}` and `cameraFor(level, 0, 0, 132)` — aspect 1, chrome 20 %
   * — framed the board on every viewport this product ships on. It is not a phone bug; the
   * phone is only where it becomes fatal.
   *
   * **Proved off the shipped pixels, not inferred.** Projecting the near row's card corners
   * through the framing each hypothesis produces, against `tooth-match-rest.png` (1440x900,
   * shell 828x792) and `tooth-match-phone.png` (390x844, shell 358x748):
   *
   * | quantity                    | measured | zero-rect solve | true-rect solve |
   * |-----------------------------|----------|-----------------|-----------------|
   * | desktop card centres (px)   | 509.5 / 722 / 934 | 509.5 / 720 / 930.5 | 500.5 / 720 / 939.5 |
   * | desktop medallion width     | 147–148  | **148.8**       | 155.4           |
   * | phone medallion width       | 139–143  | **147**         | 70              |
   * | phone tray near base (px y) | 729      | **731**         | 731             |
   * | phone tray far rim (px y)   | 294      | **282**         | 267             |
   *
   * The zero-rect column is the shipped render on both viewports. On the phone that framing
   * is a 2.04x over-zoom: the outer columns' card centres land at x = −119 and 477 in a
   * 358 px-wide shell, which is the "two of six cards unplayable, clipped on three sides"
   * the audit photographed, and the reason 246 px of viewport below the board go unused.
   *
   * The fix is the cause, not the symptom: a **passive** effect (refs are attached by the
   * time passive effects flush), a bounded rAF retry in case a future tree defers the ref,
   * and a dev error if it never resolves rather than a silent fallback that renders.
   *
   * The audit's suggested fix — "observe the chrome element as well" — is **not** needed and
   * is not done: `GameShell` publishes the band as the play area's own `padding-top`, and a
   * `ResizeObserver` reports the *content* box, so a band that changes height without
   * changing the shell already wakes this observer. That half of the shared design works.
   */
  useEffect(() => {
    let raf = 0;
    let attempts = 0;
    let observer: ResizeObserver | null = null;

    const measure = (el: HTMLElement) => {
      // `offsetWidth/offsetHeight`, not `getBoundingClientRect()`: the panel is CSS-scaled
      // during the hub -> game flip, and a transformed rect reports a quarter of the truth
      // (this is the trap S13 documents for tap-target sizing).
      const width = el.offsetWidth;
      const height = el.offsetHeight;
      const style = getComputedStyle(el);
      const px = (name: string): number => Number.parseFloat(style.getPropertyValue(name));
      /*
       * A9's chrome *rect*, with A9's own fallback.
       *
       * `--chrome-bottom` is the bottom of the union of the real control clusters;
       * `--chrome-h` is `chrome.offsetHeight`, which additionally includes the HUD row's
       * `pb-4`. The difference is 16 px of table this game was reserving for a row's bottom
       * padding. The rect's horizontal span is the whole shell on every viewport here (the
       * title is hard left, the chips hard right), so `left`/`right` buy this game nothing
       * and are deliberately not read — a keep-clear region that spans the frame *is* a
       * band, and pretending otherwise would be the reverse of A9's point.
       */
      const bottom = px("--chrome-bottom");
      const declared = px("--chrome-h");
      const chrome =
        Number.isFinite(bottom) && bottom > 0
          ? bottom
          : Number.isFinite(declared) && declared > 0
            ? declared
            : CHROME_FALLBACK_PX;
      setRect((prev) =>
        // Quantised: a one-pixel reflow must not spring the camera.
        Math.abs(prev.width - width) < 6 &&
        Math.abs(prev.height - height) < 6 &&
        Math.abs(prev.chrome - chrome) < 4
          ? prev
          : { width, height, chrome }
      );
    };

    const resolve = () => {
      const el = area?.current ?? null;
      if (!el) {
        if (++attempts <= HOST_RETRY_FRAMES) {
          raf = requestAnimationFrame(resolve);
          return;
        }
        console.error(
          "[tooth-match] the play area never attached its ref after " +
            `${HOST_RETRY_FRAMES} frames; the board would be framed for a 0x0 rect. ` +
            "Run ?selftest=tooth-match-camera."
        );
        return;
      }
      measure(el);
      observer = new ResizeObserver(() => measure(el));
      observer.observe(el);
    };
    resolve();

    return () => {
      if (raf !== 0) cancelAnimationFrame(raf);
      observer?.disconnect();
    };
  }, [area]);

  /*
   * One solve, two consumers.
   *
   * `cameraFor` returns the board scale alongside the framing because the two are the same
   * answer: on a viewport where §2's 8–16 distance band cannot frame the grid, the solve
   * finds the distance the shot wants and hands the part of it the band cannot hold to the
   * board instead of dropping it (round 3 measured the dropped version pushing Medium's and
   * Hard's outer column and focus rings off the frame). `boardScale` is a primitive, so the
   * memoised scene re-renders only when it actually changes — a resize or a level change.
   */
  const framing = cameraFor(engine.level, rect.width, rect.height, rect.chrome);

  return (
    <Scene3D camera={framing}>
      <ToothMatchScene engine={engine} boardScale={framing.boardScale} />
    </Scene3D>
  );
}

export default function ToothMatch(): JSX.Element {
  const { player } = usePlayer();

  // Created once, on the first render, and never replaced — `ToothMatchScene` is memoised
  // on this identity, so nothing the shell re-renders can reach the 3D tree.
  const engineRef = useRef<ToothMatchEngine | null>(null);
  if (!engineRef.current) engineRef.current = createEngine((player?.age ?? 5) >= 8 ? 1 : 0);
  const engine = engineRef.current;

  const [, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((v) => v + 1), []);

  const [seconds, resetTimer] = useTicker(engine.started && !engine.completed);

  /** The engine reads this when the last pair lands, to price the time bonus. */
  useEffect(() => {
    engine.seconds = seconds;
  }, [engine, seconds]);

  useEffect(
    () =>
      engine.on((event) => {
        bump();
        /*
         * Every announcement carries the information needed to choose the *next* card, not
         * just a description of the control that was pressed. Round 2 measured this game as
         * operable blind but not playable blind: a flip said "toothpaste" and nothing else,
         * so a screen-reader player had no anchor to remember it against, and a mismatch
         * named neither of the two cards it had just shown — which is the entire content of
         * a memory game's feedback.
         */
        switch (event.type) {
          case "deal": {
            const cols = engine.cols;
            announce(
              `New board. ${engine.pairs} pairs, ${engine.cards.length} cards, ` +
                `${engine.rows} rows of ${cols}, all face down. ` +
                `Arrow keys move between cards, Enter turns one over.`
            );
            break;
          }
          case "flip": {
            const turned = engine.flipped.length;
            announce(
              turned === 1
                ? `Card ${event.index + 1} shows ${MOTIF_LABELS[event.id]}. Turn over one more.`
                : `Card ${event.index + 1} shows ${MOTIF_LABELS[event.id]}.`
            );
            break;
          }
          case "match":
            announce(
              event.remaining > 0
                ? `Match! Cards ${event.a + 1} and ${event.b + 1} are both ${MOTIF_LABELS[event.id]}. ` +
                    `${event.remaining} ${event.remaining === 1 ? "pair" : "pairs"} to go.`
                : `Match! Cards ${event.a + 1} and ${event.b + 1} are both ${MOTIF_LABELS[event.id]}.`
            );
            break;
          case "miss":
            // Playful, never punitive: nothing is lost and the cards simply come back — and
            // the child is told exactly what was under each one, which is the thing they
            // need in order to play well next time.
            announce(
              `Oops, not a pair. Card ${event.a + 1} was ${MOTIF_LABELS[engine.cards[event.a].id]}, ` +
                `card ${event.b + 1} was ${MOTIF_LABELS[engine.cards[event.b].id]}. They turn back over.`
            );
            break;
          case "reject":
            announce(
              event.reason === "matched"
                ? `Card ${event.index + 1} is already matched. Try another one.`
                : "Two cards are already turned over. Just a moment."
            );
            break;
          case "complete":
            announce(`All pairs matched! ${event.score} points.`);
            break;
          default:
            break;
        }
      }),
    [engine, bump]
  );

  useEffect(() => {
    markSceneEnter("tooth-match");
    return () => {
      markSceneExit("tooth-match");
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

  return (
    <GameShell
      gameId="tooth-match"
      title="Tooth Match"
      subtitle="Flip the cards. Match the pairs."
      accent="red"
      completed={engine.completed}
      score={engine.finalScore}
      hud={{
        levels: { value: engine.level, onChange: (level) => restart(level) },
        time: fmtTime(seconds),
        /*
         * `bankedScore()`, never `finalScore` — not even once the run is won.
         *
         * The engine emits `complete` and then waits `FINISH_DELAY` (700 ms) before
         * `completed` flips and the celebration covers the chrome, so `finalScore ?? banked`
         * put whatever the final pricing came to into the star chip for 700 ms, on screen, at
         * the exact moment the child finished. Round 3 then found the other half of the same
         * defect: the celebration itself could reveal a number *below* the banked one. Both
         * are closed — `settleMatch` floors `finalScore` at `bankedScore()` — and this chip
         * still shows the banked number, because a chip that changes value at the finish line
         * is a result, and the celebration is where a result belongs.
         *
         * The full PROJECT.md formula is untouched and is handed to `GameShell` as `score`
         * below: it is revealed once, on the celebration card, which is where X1 says the
         * time and miss adjustment belongs.
         */
        score: engine.bankedScore(),
      }}
      onRestart={() => restart()}
    >
      <Board engine={engine} />
    </GameShell>
  );
}
