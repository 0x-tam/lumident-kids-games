/**
 * Spot the Difference — the shell.
 *
 * Owns the React-visible state and the DOM: the two picture frames, the pointer input and
 * the progress pill. All logic lives in `engine.ts`, all presentation in `scene.tsx`, and
 * the two talk through the engine's event emitter.
 *
 * Rules, levels, scoring and randomisation are exactly the 2D game's (PROJECT.md):
 *   a random subset of five possible differences · find 3 / 4 / 5 by level
 *   par 30 / 45 / 60 s · live score = found x 100 · final = found x 100 + under-par x 4
 *   players aged 8+ start on Medium.
 *
 * Two DOM details are load-bearing:
 *
 *  - **The panels are transparent `<div>`s over the 3D, not pictures.** They exist to be
 *    measured (the scene renders into their exact rectangles) and to catch pointers. An
 *    input shield behind them covers the rest of the play area, because R3F's own pointer
 *    mapping computes NDC from the *whole* view rect and would pick against the wrong point
 *    inside a sub-rectangle. Everything about picking is handled in panel space instead.
 *  - **Everything sits at `z-index: 1` or above**, per `Scene3D`'s contract, or it would be
 *    both invisible and unclickable under the view layer.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import GameShell from "../../shared/GameShell";
import { CheckIcon } from "../../shared/icons";
import { usePlayer } from "../../shared/player";
import { fmtTime, useTicker } from "../../shared/useTicker";
import { markSceneEnter, markSceneExit } from "../../dev/perf";
import { announce } from "../../three/hit";
import { Scene3D, useGameArea } from "../../three/Scene3D";
import {
  CELEBRATION_EXIT_SECONDS,
  CELEBRATION_EXIT_SECONDS_REDUCED,
  FLAGS,
  isReduced,
} from "../../three/store";
import { DIFFS, createEngine, type SpotEngine } from "./engine";
import {
  GAME_ACCENT,
  PANEL_GAP,
  SPOTS,
  TAP_MIN_SCREEN_PX,
  UNSOLVED,
  cameraFor,
  createPanelLayout,
  measurePanels,
  solvePanels,
  tapScreenPx,
  type PanelLayout,
  type PanelSolution,
} from "./layout";
import { SpotScene } from "./scene";

// The pixel test and the harness it needs are dev-only weight; a child never downloads
// them. `registerSelfTest` auto-runs a matching test on a short debounce, so importing the
// module is the whole wiring.
if (FLAGS.selftest !== null) void import("./selftest");

/* ------------------------------------------------------------------ */
/* The two picture frames                                              */
/* ------------------------------------------------------------------ */

/**
 * A picture frame with nothing in it.
 *
 * The clay diorama behind it is drawn by WebGL into exactly this rectangle; the only thing
 * the DOM contributes is the rolled edge and the soft occlusion at the corners, lit from
 * the upper-left like everything else in the product.
 */
const PANEL_SHADOW =
  "inset 2px 3px 6px rgba(255,255,255,0.8), inset -3px -6px 12px rgba(94,74,54,0.10)," +
  " 0 16px 30px -20px rgba(94,74,54,0.6)";

/**
 * How the frames leave, and why they leave on this curve and not another.
 *
 * The two rooms are yanked away by `celebrationHeroScale()` — `1 → 0` on `easeInCubic` across
 * `CELEBRATION_EXIT_SECONDS` (0.24 s, `store.ts`). Round 3 left the `<div>`s behind: the audit
 * photographed two *empty inset picture frames* through the celebration, with a seam running
 * vertically down the mascot's legs. So the frames leave on the same clock and the same curve,
 * as one discrete state change on `completed` — not per frame, and not a second animation loop.
 *
 * `easeInCubic` as a bezier is `cubic-bezier(0.32, 0, 0.67, 0)`. Never `linear`, never
 * `ease-in-out`: it is exactly the removal curve the world is already on, so the clay rooms and
 * the DOM frames around them go at the same rate and read as one object leaving.
 *
 * The duration is imported rather than typed, and the reduced-motion window is imported too —
 * `store.ts` halves the world's exit to 0.12 s there, and a frame still taking 0.24 s to go
 * would be the DOM lagging the 3D by exactly the amount reduced motion was asking to remove.
 * `isReduced()` is read in the render that flips `completed`, which is the only render where
 * the value is used.
 */
const PANEL_EXIT_MS = CELEBRATION_EXIT_SECONDS * 1000;
const PANEL_EXIT_MS_REDUCED = CELEBRATION_EXIT_SECONDS_REDUCED * 1000;
const PANEL_EXIT_EASE = "cubic-bezier(0.32, 0, 0.67, 0)";

function Board({ engine, layout }: { engine: SpotEngine; layout: PanelLayout }): JSX.Element {
  const area = useGameArea();
  const frameRef = useRef<HTMLDivElement>(null);
  const aRef = useRef<HTMLDivElement>(null);
  const bRef = useRef<HTMLDivElement>(null);
  const [solution, setSolution] = useState<PanelSolution>(UNSOLVED);
  /**
   * `minScreenPx` for the scene's `HitTarget`s, in the units `HitTarget` measures in.
   *
   * State rather than a per-frame read because it is a *layout* fact: it changes when the
   * panels are re-solved and at no other time, and `SpotScene` is memoised precisely so the
   * 3D tree never re-renders while a child is playing. Quantised for the same reason the
   * panel solution is — a one-pixel reflow must not walk the whole scene.
   */
  const [tapPx, setTapPx] = useState(TAP_MIN_SCREEN_PX);

  /*
   * Solve the layout from the space actually available — **measured, never `getBoundingClientRect`.**
   *
   * ## The defect this is the fix for (round 4, SD1)
   *
   * This read `frame.getBoundingClientRect()`. The hub → game entry is a framer-motion flip on
   * `GamesCollection.tsx`'s panel — `initial={{ scale: flip.scale }}`, as low as **0.24** — and
   * `getBoundingClientRect()` is a *transformed* rect, so a component that mounts inside the
   * flip solves the whole game against a quarter-size box.
   *
   * The half that made it stick is the `ResizeObserver`: it watches the frame's **content
   * box**, and a CSS transform does not touch a content box. The flip therefore produces *no
   * observer callback at all* — from layout's point of view nothing has changed while the
   * panel scales from 0.24 to 1 — so nothing in this effect was ever guaranteed to re-solve
   * once the flip finished. Recovery depended entirely on some unrelated relayout happening
   * to fire the observer after the ~400 ms spring had settled, which is not something the code
   * arranged and not something that has to happen. `Scene3D.tsx:47-58` documents exactly this
   * trap for drei's `<View>`; this file was walking into it one level up.
   *
   * It is also why the defect is intermittent in captures and reliable in play. The game is
   * behind `React.lazy`, so on a cold chunk the module arrives *after* the flip has settled and
   * everything looks fine — but `GAMES[i].prefetch()` warms the chunk on card hover, focus and
   * pointerdown, so the child who actually taps a card mounts inside the flip and gets the
   * broken solve. The audit photographed it twice, hours apart.
   *
   * ## What this does instead
   *
   * `offsetWidth`/`offsetHeight`, and the `ResizeObserver` entry's `contentRect` where the
   * engine gives us one. Both are layout measurements and neither can be reached by a
   * transform, so the first solve is right at `scale 0.24` and stays right at `scale 1`. The
   * observer is kept for real relayouts (a wrapped chrome row, an orientation change), which is
   * what it was always for.
   *
   * `useLayoutEffect` because the panels must be sized before the first paint, and `frameRef`
   * is this component's own ref — an ancestor's would still be null here.
   */
  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const measure = (entry?: ResizeObserverEntry) => {
      // `contentRect` when the observer offers it, `offset*` otherwise. Both are untransformed;
      // neither is `getBoundingClientRect`.
      const width = entry ? entry.contentRect.width : frame.offsetWidth;
      const height = entry ? entry.contentRect.height : frame.offsetHeight;
      if (width < 8 || height < 8) return;
      const next = solvePanels(width, height);
      setSolution((prev) =>
        // Quantised: a one-pixel reflow must not spring the camera.
        prev.measured === next.measured &&
        prev.mode === next.mode &&
        Math.abs(prev.pw - next.pw) < 4 &&
        Math.abs(prev.ph - next.ph) < 4
          ? prev
          : next
      );
    };
    measure();
    const observer = new ResizeObserver((entries) => measure(entries[0]));
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);

  /* Publish the panel rectangles to the scene, as fractions of the tracked view.
     Deliberately a *passive* effect: `GameShell`'s play-area ref belongs to an ancestor,
     and an ancestor's ref is still null while a descendant's layout effect runs. */
  useEffect(() => {
    const areaEl = area?.current;
    const a = aRef.current;
    const b = bRef.current;
    /*
     * A passive effect is the correct place for an ancestor's ref — React attaches host refs
     * during the layout pass, so by the time passive effects flush `areaRef` is populated —
     * and this game's camera is solved from the panel rects rather than from the play area,
     * so a miss here does not mis-frame the scene. It does silently mis-size every collider:
     * `tapScreenPx` would keep its initial value and §8's 48 px floor would go unmet with
     * nothing to say so. Reported rather than swallowed, in the same family as A8.
     */
    if (!areaEl || !a || !b) {
      if (import.meta.env.DEV) {
        console.error(
          "[spot-the-difference] play area or panel refs missing after commit; tap targets " +
            "keep their initial size. Run ?selftest=spot."
        );
      }
      return;
    }
    const publish = () => {
      measurePanels(layout, areaEl, a, b);
      // `layout.fh` is the panel's height as a fraction of the tracked view — exactly the
      // factor `HitTarget`'s play-area-based sizing is out by here. See `tapScreenPx`.
      if (layout.ready !== 1) return;
      const next = tapScreenPx(layout.fh);
      setTapPx((prev) => (Math.abs(prev - next) < 4 ? prev : next));
    };
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(areaEl);
    observer.observe(a);
    window.addEventListener("resize", publish);
    window.addEventListener("orientationchange", publish);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", publish);
      window.removeEventListener("orientationchange", publish);
      layout.ready = 0;
    };
  }, [area, layout, solution]);

  const tap = useCallback(
    (panel: number, event: React.PointerEvent<HTMLDivElement>) => {
      const rect = event.currentTarget.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return;
      engine.tap(
        panel,
        (event.clientX - rect.left) / rect.width,
        (event.clientY - rect.top) / rect.height
      );
    },
    [engine]
  );

  // `engine.completed` is the same flag `GameShell` opens the celebration on, and `Board`
  // re-renders on it because the engine's `finish` event bumps the game's version counter.
  const leaving = engine.completed;
  const exitMs = isReduced() ? PANEL_EXIT_MS_REDUCED : PANEL_EXIT_MS;
  const panelStyle: CSSProperties = {
    width: solution.pw,
    height: solution.ph,
    borderRadius: 28,
    boxShadow: leaving ? "none" : PANEL_SHADOW,
    transition: `box-shadow ${exitMs}ms ${PANEL_EXIT_EASE}`,
    touchAction: "none",
    // A frame with nothing in it is not a thing to tap. `engine.tap` already refuses once the
    // run is over; this is so the cursor stops claiming otherwise.
    pointerEvents: leaving ? "none" : "auto",
    cursor: leaving ? "default" : "pointer",
  };

  return (
    <>
      {/*
        Input shield. R3F listens on drei's view element, which covers the whole play area;
        without this, a pointer outside a panel would be raycast against NDC computed from
        the wrong rectangle and could "find" a difference the child never touched.
      */}
      <div aria-hidden className="absolute inset-0 z-[1]" />

      <div
        ref={frameRef}
        className="relative z-[2] flex min-h-0 flex-1 items-center justify-center"
      >
        <div
          className={
            solution.mode === "row"
              ? "flex items-center justify-center"
              : "flex flex-col items-center justify-center"
          }
          style={{ gap: PANEL_GAP }}
        >
          <div
            ref={aRef}
            aria-hidden
            className="no-select"
            style={panelStyle}
            onPointerDown={(e) => tap(0, e)}
          />
          <div
            ref={bRef}
            aria-hidden
            className="no-select"
            style={panelStyle}
            onPointerDown={(e) => tap(1, e)}
          />
        </div>
      </div>

      <Progress engine={engine} />

      {/*
        Mounted only once the panels have a real size, **and only from a layout measurement**.
        `ViewCamera` treats its first `camera` prop as an immediate placement and every later
        one as a spring move, so mounting against a placeholder framing would open the game on
        a visible push-in that nobody asked for — and mounting against a *transformed* framing
        is round 4's SD1, which opened it on the wrong framing and left it there. `measured` is
        the flag that distinguishes the two; see `PanelSolution` in `layout.ts`.
      */}
      {solution.measured === 1 ? (
        <Scene3D camera={cameraFor(solution.pw, solution.ph)}>
          <SpotScene engine={engine} layout={layout} tapPx={tapPx} />
        </Scene3D>
      ) : null}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Progress pill                                                       */
/* ------------------------------------------------------------------ */

function Progress({ engine }: { engine: SpotEngine }): JSX.Element {
  return (
    <div className="relative z-[2] mt-2.5 flex shrink-0 justify-center">
      <div className="clay-chip !gap-1.5 !px-5 !py-2">
        {DIFFS.map((diff, i) =>
          engine.activeMask[i] === 1 ? (
            <span
              key={diff.id}
              /*
               * `role="img"` — round 4's SD6.
               *
               * ARIA does not map `aria-label` onto a generic element: a bare `<span>` has an
               * implicit role of `generic`, which is in the "name prohibited" set, so every
               * assistive technology was entitled to drop these five labels on the floor and
               * they exposed no accessible name at all. `announce()` carries the same
               * information on every event, so nothing was *missing* — what was lost is the
               * redundancy, i.e. the ability to go back and re-read the board's state instead
               * of having to have caught the live region when it spoke. That is the half a
               * child who looks away actually needs.
               *
               * `img` rather than `status` or a list item: this really is a small picture of a
               * state, it has no children to expose, and `img` is the one role whose entire
               * contract is "treat me as an opaque thing with this name".
               */
              role="img"
              aria-label={engine.foundMask[i] === 1 ? `Found the ${diff.hint}` : "Not found yet"}
              className={`grid h-7 w-7 place-items-center rounded-full ${
                engine.foundMask[i] === 1
                  // Rose, because `src/games/index.ts` files this game under rose and the
                  // hub card the child tapped to get here is a rose gradient. Round 2's
                  // coral tick was the same drift X2 names in three other games. White on
                  // `rose.deep` measures 6.1:1 — the same pairing the 3D found badge uses
                  // for the same tick, so the HUD and the room agree.
                  ? "bg-rose-deep text-white"
                  : "bg-line text-transparent"
              }`}
            >
              <CheckIcon className="h-4 w-4" />
            </span>
          ) : null
        )}
        <span className="ml-1 font-display text-lg font-bold">
          {engine.foundCount} / {engine.target}
        </span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Game                                                                */
/* ------------------------------------------------------------------ */

/**
 * Proves `GAME_ACCENT` still equals what the registry says, in DEV, once per mount.
 *
 * `layout.ts` states the family locally so `diorama.ts` can build its hero material without a
 * static import back into `src/games/index.ts` — the module that lazily loads this chunk. The
 * price of that is a second copy of one word, and round 4's A15 is entirely about second
 * copies of a colour drifting from the first. So the copy is checked rather than trusted, and
 * checked from *here*: this file is React, the import is dynamic, and it runs after the
 * registry module has finished evaluating, so there is no cycle to trip over.
 */
function assertRegistryAccent(): void {
  if (!import.meta.env.DEV) return;
  void import("../index").then((mod) => {
    const entry = mod.GAMES.find((g) => g.id === "spot-the-difference");
    if (entry && entry.accent !== GAME_ACCENT) {
      console.error(
        `[spot] GAME_ACCENT is "${GAME_ACCENT}" but the registry files this game under ` +
          `"${entry.accent}". The 3D room, the HUD and the hub card would disagree — change ` +
          `GAME_ACCENT in layout.ts, which is the only place the room reads it from.`
      );
    }
  });
}

export default function SpotTheDifference(): JSX.Element {
  const { player } = usePlayer();

  // Created once and never replaced — `SpotScene` is memoised on this identity, so the
  // shell's once-a-second timer tick cannot reach the 3D tree.
  const engineRef = useRef<SpotEngine | null>(null);
  if (!engineRef.current) engineRef.current = createEngine((player?.age ?? 5) >= 8 ? 1 : 0);
  const engine = engineRef.current;

  const layoutRef = useRef<PanelLayout | null>(null);
  if (!layoutRef.current) layoutRef.current = createPanelLayout();
  const layout = layoutRef.current;

  const [, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((v) => v + 1), []);

  // Counts from the moment the pictures appear, exactly as the 2D game did — the par
  // times (30 / 45 / 60 s) and therefore the time bonus were tuned against that clock, and
  // starting it on the first tap would quietly re-tune the scoring.
  const [seconds, resetTimer] = useTicker(!engine.completed);

  /** The engine reads this when the last difference lands, to price the time bonus. */
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
              `Two bathroom pictures. Find ${engine.target} ${
                engine.target === 1 ? "difference" : "differences"
              }.`
            );
            break;
          case "found": {
            /*
             * Two openings, one outcome.
             *
             * `revealed` means the game found it after three unanswered swells (`NUDGE_LIMIT`
             * in `engine.ts`) rather than the child finding it. Everything else about it is
             * identical — same sparkle, same pop, same badge, same 100 points — but this line
             * must not tell a child they found something they did not, and it must not sound
             * like a correction either. "Here it is" is neither.
             */
            const what = `the ${DIFFS[event.index].hint} is different`;
            const opening = event.revealed === 1 ? `Here it is — ${what}` : `Found it — ${what}`;
            announce(
              event.remaining > 0
                ? `${opening}. ${event.remaining} ` +
                    `${event.remaining === 1 ? "difference" : "differences"} to go.`
                : `${opening}.`
            );
            break;
          }
          case "miss": {
            /*
             * Playful, never punitive: nothing is lost and nothing is wrong — but a player
             * who cannot see the ripple still has to be told *what* they just checked and
             * *where the run stands*, or "nothing different there" is unusable feedback
             * about an unnamed thing.
             *
             * Three different true statements, in order of how much they tell the player:
             * they re-checked something they have already solved; they checked a named prop
             * that is genuinely the same in both pictures; or they tapped empty room.
             */
            const left = engine.target - engine.foundCount;
            announce(
              event.already >= 0
                ? `You already found the ${DIFFS[event.already].hint}. ` +
                    `${left} ${left === 1 ? "difference" : "differences"} to go.`
                : event.spot >= 0
                  ? `The ${SPOTS[event.spot].label.toLowerCase()} is the same in both pictures. Keep looking!`
                  : "Nothing different there. Keep looking!"
            );
            break;
          }
          case "nudge":
            // Only ever the first two — the third is a `found` with `revealed`, above.
            /*
             * The spoken half of the terminator (`NUDGE_DELAY` in `engine.ts`). The scene
             * swells the prop; a child who cannot see that swell has to be told the same
             * thing, or the game has a way out for sighted players only. Naming the prop is
             * exactly the information the swell carries — no more and no less.
             */
            announce(`Still looking? Have another look at the ${DIFFS[event.index].hint}.`);
            break;
          case "complete":
            announce(`You found them all! ${event.score} points.`);
            break;
          default:
            break;
        }
      }),
    [engine, bump]
  );

  useEffect(() => {
    assertRegistryAccent();
    markSceneEnter("spot-the-difference");
    // The opening deal happens before anything can subscribe, so its announcement is made
    // here — a screen-reader user has to be told what the run asks for.
    announce(
      `Two bathroom pictures, side by side. Find ${engine.target} ` +
        `${engine.target === 1 ? "difference" : "differences"}. ` +
        `Tab to a thing in the room and press Enter to check it.`
    );
    return () => {
      markSceneExit("spot-the-difference");
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
      gameId="spot-the-difference"
      title="Spot the Difference"
      subtitle="Can you find all the little changes?"
      accent={GAME_ACCENT}
      completed={engine.completed}
      score={engine.finalScore}
      hud={{
        levels: { value: engine.level, onChange: (level) => restart(level) },
        time: fmtTime(seconds),
        score: engine.finalScore ?? engine.liveScore(),
      }}
      onRestart={() => restart()}
    >
      <Board engine={engine} layout={layout} />
    </GameShell>
  );
}
