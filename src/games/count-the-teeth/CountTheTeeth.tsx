/**
 * Count the Teeth — clay tooth mascots on a coral board.
 *
 * This file is the *shell*: it owns the React-visible state and nothing else. All game
 * logic lives in `engine.ts`, all presentation in `scene.tsx`, the board metrics, the camera
 * solve and the countability proof in `layout.ts`, and the GPU audit of that proof in
 * `verify.ts`. The shell and the scene talk to the engine through its event emitter — never
 * through props that change while the board is moving.
 *
 * Rules, levels, scoring and randomisation are exactly the 2D game's (PROJECT.md):
 *   5 rounds · counts 3–6 / 5–10 / 8–14 by level · three choices drawn within ±2
 *   a round pays `round(100 × [1, 1.5, 2])` only if it is answered first time
 *   a wrong tap costs nothing but that round's points — no penalty, no life, no failure
 *   final score = points + max(0, par − seconds) × 2, par 30 / 45 / 60
 *   players aged 8+ start on Medium.
 *
 * The live score chip shows `engine.liveScore()`, which is banked points and nothing else:
 * it is monotonically non-decreasing for the whole run, and the time bonus is revealed once,
 * at the celebration (X1). Nothing a child does here can make a number in front of them go
 * down.
 *
 * React renders here happen on discrete events only: a round, an answer, the finish and
 * the once-a-second timer tick. The board itself renders zero times per frame.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import GameShell from "../../shared/GameShell";
import { usePlayer } from "../../shared/player";
import { fmtTime, useTicker } from "../../shared/useTicker";
import { markSceneEnter, markSceneExit } from "../../dev/perf";
import { announce } from "../../three/hit";
import { Scene3D, useGameArea } from "../../three/Scene3D";
import { createEngine, type CountEngine } from "./engine";
import { ACCENT, CHROME_PX, cameraFor, type ChromeRect } from "./layout";
import { CountTheTeethScene } from "./scene";

/**
 * `GameShell`'s chrome as the shell itself measured it, in play-area CSS pixels.
 *
 * The band is what the camera solve has to keep the composition clear of, and it is not a
 * constant: it changes with the HUD a game asks for, with the viewport's type scale, and —
 * the case round 4 photographed — with whether the difficulty row wraps the chip group onto
 * a second line. On a 390 x 844 phone that band measures ~273 px, twice the 138 this file
 * used to guess.
 *
 * **The rect, not just the height (A9).** `--chrome-h` is `chrome.offsetHeight` and says
 * nothing about where across the width the controls are; `--chrome-{top,bottom,left,right}`
 * is the union of the real control clusters. `bottom` is the keep-clear floor and is `<=`
 * `--chrome-h`, and `left`/`right` say how much of the width that floor applies to. Both are
 * read, and the height is kept as the conservative fallback for a shell that publishes only
 * the scalar.
 *
 * Every value is sanity-checked rather than trusted: a nonsense number frames the board for
 * a band that swallows the screen, which is a worse failure than falling back.
 */
function readChrome(el: HTMLElement): ChromeRect {
  const width = el.offsetWidth;
  const height = el.offsetHeight;
  const fallback: ChromeRect = { top: 0, bottom: CHROME_PX, left: 0, right: width };
  if (typeof window === "undefined") return fallback;
  const style = window.getComputedStyle(el);
  const num = (name: string): number => Number.parseFloat(style.getPropertyValue(name));

  const band = num("--chrome-h");
  const bandOk = Number.isFinite(band) && band > 0 && band < height;
  const top = num("--chrome-top");
  const bottom = num("--chrome-bottom");
  const left = num("--chrome-left");
  const right = num("--chrome-right");
  const rectOk =
    Number.isFinite(top) &&
    Number.isFinite(bottom) &&
    Number.isFinite(left) &&
    Number.isFinite(right) &&
    bottom > top &&
    bottom < height &&
    right > left;

  if (rectOk) return { top, bottom, left, right };
  if (bandOk) return { top: 0, bottom: band, left: 0, right: width };
  return fallback;
}

/** Two rects are the same framing input if every edge agrees to under a pixel. */
const sameChrome = (a: ChromeRect, b: ChromeRect): boolean =>
  Math.abs(a.top - b.top) < 1 &&
  Math.abs(a.bottom - b.bottom) < 1 &&
  Math.abs(a.left - b.left) < 1 &&
  Math.abs(a.right - b.right) < 1;

/**
 * Frames the board from the play area's real size, at the level being played.
 *
 * `GameShell` hands a game the whole shell interior, so the camera has to be solved from the
 * measured rect rather than fixed — and since round 4 the *board* is solved with it: the grid
 * shape and the composition's world scale both come out of `cameraFor`, against this rect and
 * this chrome rect, and are read back off the framing rather than re-derived.
 * This component sits on the DOM side of `<Scene3D>`, which is the only place
 * `GameAreaContext` can be read: everything below the view renders in the R3F root and shares
 * no context with the page.
 *
 * It re-renders on resize and on a level change, and at no other time. The framing object is
 * memoised because the scene is memoised on it: a new object every render would defeat that.
 *
 * **`offsetWidth`/`offsetHeight`, never `getBoundingClientRect()`.** The panel is CSS-scaled
 * during the hub→game flip, and a transformed rect reports about a quarter of the real size —
 * which would be latched by the quantiser below and leave the game framed for a viewport that
 * never existed. Layout metrics ignore transforms; `ResizeObserver` watches the content box
 * for the same reason. (This is the trap S13 describes, on the DOM side of it.)
 */
/** Frames to keep retrying for the play area's element before reporting it. */
const HOST_RETRY_FRAMES = 8;

function Board({ engine, level }: { engine: CountEngine; level: number }): JSX.Element {
  const area = useGameArea();
  const [rect, setRect] = useState<{ width: number; height: number; chrome: ChromeRect }>({
    width: 0,
    height: 0,
    chrome: { top: 0, bottom: CHROME_PX, left: 0, right: 0 },
  });

  useLayoutEffect(() => {
    /*
     * The ref is resolved by retry, not read once — and until round 5 it was read once.
     *
     * `GameShell` holds `areaRef` on an **ancestor** div (`<div ref={areaRef} class="absolute
     * inset-0">`) and provides it through `GameAreaContext`. React attaches a host ref in the
     * same bottom-up layout pass that runs layout effects, so a descendant's layout effect
     * runs *before* the ancestor's ref is attached: `area.current` is null here on every
     * mount, on every device. The `if (!el) return;` this replaces therefore returned every
     * time, which meant neither the `ResizeObserver` nor the `MutationObserver` below was
     * ever created — and because `area` is an identity-stable ref object the effect never
     * re-ran to try again.
     *
     * The consequence is CT1 in full: `rect` stayed `{width: 0, height: 0, chrome: CHROME_PX}`
     * for the life of the mount, so `cameraFor` solved the board for a 0x0 play area on a
     * laptop and on a phone alike — the exact fallback the round-4 work re-derived the grid
     * shapes, the `scale` bisection and the A9 rect reads to avoid.
     */
    let raf = 0;
    let attempts = 0;
    let cancelled = false;
    let observer: ResizeObserver | null = null;
    let attributes: MutationObserver | null = null;

    const install = (el: HTMLElement) => {
    const measure = () => {
      const width = el.offsetWidth;
      const height = el.offsetHeight;
      const chrome = readChrome(el);
      setRect((prev) =>
        // Quantised: a one-pixel reflow must not spring the camera.
        Math.abs(prev.width - width) < 6 &&
        Math.abs(prev.height - height) < 6 &&
        sameChrome(prev.chrome, chrome)
          ? prev
          : { width, height, chrome }
      );
    };
    measure();
    observer = new ResizeObserver(measure);
    observer.observe(el);
    /*
     * This used to also `observe(el.firstElementChild)`, because the play area is
     * `absolute inset-0` and so did **not** resize when only the chrome band did — a title
     * that reflows after Manrope loads, or a HUD row appearing, changed `--chrome-h` and
     * never woke this observer. `GameShell` opened the area with a spacer of exactly the
     * band's height as its first child and this game watched that.
     *
     * The spacer is gone: round 3 (A12) publishes the band as the play area's own
     * `padding-top`, and a `ResizeObserver` reports the **content box**, so `observe(el)`
     * above fires on a band change by itself.
     */

    /*
     * …and the observer alone is not enough, which is round 4's CT1 in one paragraph.
     *
     * React runs layout effects **child-first**, so this effect fires before `GameShell`'s
     * own measurement effect has published anything. The first solve therefore always uses
     * `CHROME_PX` — a guess — and every correction after it depends on a *side effect* of
     * another component's DOM write: the shell sets `area.style.paddingTop`, which changes
     * this element's content box, which happens to wake the `ResizeObserver` above. Anything
     * that publishes `--chrome-*` without changing the padding (the A9 rect does exactly
     * that: `--chrome-left/right` move when a chip row grows sideways at a constant height)
     * lands with nothing watching, and the board stays framed for a band that is not there.
     *
     * A `MutationObserver` on the attribute the shell actually writes closes it
     * deterministically: `--chrome-*` and `padding-top` are both set through `area.style`,
     * so every publication is one `style` attribute mutation on this element, delivered at
     * the end of the same microtask. No polling, no frame budget, no dependence on layout.
     */
    attributes = new MutationObserver(measure);
    attributes.observe(el, { attributes: true, attributeFilter: ["style"] });
    };

    const resolve = () => {
      if (cancelled) return;
      const el = area?.current ?? null;
      if (!el) {
        if (++attempts <= HOST_RETRY_FRAMES) {
          raf = requestAnimationFrame(resolve);
        } else {
          console.error(
            "[count-the-teeth] the play area never attached its ref after " +
              `${HOST_RETRY_FRAMES} frames; the board is framed for a 0x0 rect. ` +
              "Run ?selftest=count."
          );
        }
        return;
      }
      install(el);
    };
    // React's commit is one synchronous task, so a microtask queued from a layout effect
    // lands after every ref in the tree is attached and still before the browser paints.
    if (area?.current) resolve();
    else queueMicrotask(resolve);

    return () => {
      cancelled = true;
      if (raf !== 0) cancelAnimationFrame(raf);
      observer?.disconnect();
      attributes?.disconnect();
    };
  }, [area]);

  const framing = useMemo(
    () => cameraFor(rect.width, rect.height, level, undefined, rect.chrome),
    [rect.width, rect.height, rect.chrome, level]
  );

  return (
    <Scene3D camera={framing}>
      <CountTheTeethScene engine={engine} framing={framing} level={level} />
    </Scene3D>
  );
}

export default function CountTheTeeth(): JSX.Element {
  const { player } = usePlayer();

  // Created once, on the first render, and never replaced — `CountTheTeethScene` is
  // memoised on this identity, so nothing the shell re-renders can reach the 3D tree.
  const engineRef = useRef<CountEngine | null>(null);
  if (!engineRef.current) engineRef.current = createEngine((player?.age ?? 5) >= 8 ? 1 : 0);
  const engine = engineRef.current;

  const [, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((v) => v + 1), []);

  const [seconds, resetTimer] = useTicker(engine.started && !engine.completed);

  /** The engine reads this when the last round lands, to price the time bonus. */
  useEffect(() => {
    engine.seconds = seconds;
  }, [engine, seconds]);

  useEffect(
    () =>
      engine.on((event) => {
        bump();
        switch (event.type) {
          case "correct":
            announce(
              event.points > 0
                ? `Yes! ${engine.count} teeth. ${event.points} points.`
                : `Yes! ${engine.count} teeth.`
            );
            break;
          default:
            /*
             * `round` and `wrong` are announced by the *scene*, not here, and `complete` by
             * `GameShell` together with the score and the best.
             *
             * The board is what a blind player needs described (X4, §3.7 G-CT-7), and only
             * the scene knows it: the scatter is solved in an effect that runs after this
             * callback, from the framing the camera was actually given. Announcing from both
             * places would also be worse than announcing from one — `announce()` debounces
             * 60 ms and replaces the live region's text, so two calls in the same tick means
             * the first is silently thrown away.
             */
            break;
        }
      }),
    [engine, bump]
  );

  useEffect(() => {
    markSceneEnter("count-the-teeth");
    return () => {
      markSceneExit("count-the-teeth");
      engine.dispose();
    };
  }, [engine]);

  const restart = useCallback(
    (level?: number) => {
      engine.start(level ?? engine.level);
      resetTimer();
    },
    [engine, resetTimer]
  );

  return (
    <GameShell
      gameId="count-the-teeth"
      title="Count the Teeth"
      subtitle="How many teeth can you count?"
      accent={ACCENT}
      completed={engine.completed}
      score={engine.finalScore}
      hud={{
        levels: { value: engine.level, onChange: (level) => restart(level) },
        time: fmtTime(seconds),
        // Banked points only while playing — never the running total minus anything.
        score: engine.finalScore ?? engine.liveScore(),
      }}
      onRestart={() => restart()}
    >
      <Board engine={engine} level={engine.level} />
    </GameShell>
  );
}
