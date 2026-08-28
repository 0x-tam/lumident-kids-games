/**
 * Tooth Runner — an auto-running clay tooth, in 3D.
 *
 * This file is the *shell*: it owns the React-visible state and nothing else. All game
 * logic lives in `engine.ts`, all presentation in `scene.tsx` and `props.ts`, and the two
 * talk through the engine's event emitter — never through props that change while the world
 * is moving. React renders here happen on discrete events only: a pickup, a candy, the
 * once-a-second clock, the sticky flag, the finish.
 *
 * Rules, levels, scoring and randomisation are the 2D game's, unchanged (PROJECT.md):
 * 20 / 25 / 30 second runs at rising speed, 50 / 75 / 100 points a pickup, candy costs a
 * second of speed and nothing else. There is no way to lose this game and no way to end a
 * run early — the clock is the only thing that finishes it, and it always finishes in a
 * celebration.
 *
 * ── Input ──────────────────────────────────────────────────────────────────────
 *
 * A runner has exactly one verb and no objects to aim at, so the tap target is the whole
 * play area rather than a `HitTarget` on a prop: a real `<button>` filling the shell's
 * interior below the chrome, hundreds of CSS pixels on its shortest side on every device.
 * It sits at `z-index: 1`, which is the layer rule `Scene3D` documents — the view layer
 * underneath it owns `z-index: 0` and would otherwise swallow the tap.
 *
 * Keyboard is Space, Up or Enter, from a window-level listener rather than from the button,
 * so a child does not have to find and focus the play area first. The listener stands aside
 * whenever focus is on one of the shell's own controls, so Space still works the mute,
 * restart and difficulty buttons.
 */
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { AnimatePresence, motion } from "framer-motion";
import GameShell from "../../shared/GameShell";
import { usePlayer } from "../../shared/player";
import { fmtTime } from "../../shared/useTicker";
import { markSceneEnter, markSceneExit } from "../../dev/perf";
import { announce } from "../../three/hit";
import { Scene3D, useGameArea } from "../../three/Scene3D";
import { reducedMotion, useStore } from "../../three/store";
import { KIND_LABELS, isGoodie, createEngine, type ToothRunnerEngine } from "./engine";
import { CHROME_PX_FALLBACK, cameraFor } from "./layout";
import { ToothRunnerScene } from "./scene";

/**
 * Frames the lane from the play area's real size.
 *
 * `GameShell` hands a game the whole shell interior — around 1.03:1 on a laptop and 0.48:1
 * on a phone held upright — so the camera distance is solved from the measured rect rather
 * than fixed (see `cameraFor`). This component sits on the DOM side of `<Scene3D>`, which is
 * the only place `GameAreaContext` can be read: everything below the view renders in the
 * R3F root and shares no context with the page.
 *
 * It re-renders on resize and at no other time — it is memoised on `engine`, whose identity
 * never changes, so the shell re-rendering its clock every second does not reach even as far
 * as the `<View>`. The camera prop is destructured to primitives inside `Scene3D`, so an
 * unchanged framing costs nothing.
 */
/** Frames to keep retrying for the play area's element before reporting it (see `TrackImpl`). */
const HOST_RETRY_FRAMES = 8;

function TrackImpl({ engine }: { engine: ToothRunnerEngine }): JSX.Element {
  const area = useGameArea();
  const [rect, setRect] = useState({ width: 0, height: 0, chrome: CHROME_PX_FALLBACK });

  useLayoutEffect(() => {
    /*
     * A11y/viewport hardening, in the same family as A8 — and the reason it is a retry and
     * not a guard.
     *
     * Round 4 shipped this as `const el = area?.current; if (!el) { console.error(...); return; }`
     * under a comment claiming "React attaches host refs before any layout effect, so this
     * has never been observed". That is true of a component's **own** host refs and false of
     * an **ancestor's**: `GameShell` holds `areaRef` on `<div ref={areaRef} class="absolute
     * inset-0">` and provides it through `GameAreaContext`, and React attaches a host ref in
     * the same bottom-up layout pass that runs layout effects — a descendant's layout effect
     * therefore runs *before* the ancestor's ref is attached. Every mount of this game took
     * the early return, logged the error, installed no `ResizeObserver`, and — because
     * `area` is an identity-stable ref object, so this effect never re-runs — kept
     * `cameraFor(0, 0, CHROME_PX_FALLBACK)` for the life of the mount. That is aspect 1 on a
     * 0.48:1 phone.
     *
     * The recovery is `maze-escape`'s, which was measured: try once synchronously (free when
     * the ref is somehow already there), then on a microtask — React's commit is one
     * synchronous task, so a microtask lands after every ref in the tree is attached and
     * still before paint — then a bounded rAF ladder, and only then the error.
     */
    let raf = 0;
    let attempts = 0;
    let cancelled = false;
    let observer: ResizeObserver | null = null;

    const measure = (el: HTMLElement) => {
      // `offsetWidth`/`offsetHeight`, never `getBoundingClientRect()`: the panel is CSS-scaled
      // during the hub -> game flip, so a transformed rect reports a quarter of the truth and
      // the camera would solve its framing against it and stay there.
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      // `GameShell` publishes the *measured* chrome band here; the constant is only a fallback.
      const raw = parseFloat(getComputedStyle(el).getPropertyValue("--chrome-h"));
      const chrome = Number.isFinite(raw) && raw > 0 ? raw : CHROME_PX_FALLBACK;
      setRect((prev) =>
        // Quantised: a one-pixel reflow must not spring the camera.
        Math.abs(prev.width - w) < 6 &&
        Math.abs(prev.height - h) < 6 &&
        Math.abs(prev.chrome - chrome) < 4
          ? prev
          : { width: w, height: h, chrome }
      );
    };
    const attach = () => {
      if (cancelled) return;
      const el = area?.current ?? null;
      if (!el) {
        if (++attempts <= HOST_RETRY_FRAMES) {
          raf = requestAnimationFrame(attach);
        } else {
          console.error(
            "[tooth-runner] the play area never attached its ref after " +
              `${HOST_RETRY_FRAMES} frames; the lane is framed from the fallback rect.`
          );
        }
        return;
      }
      measure(el);
      observer = new ResizeObserver(() => measure(el));
      observer.observe(el);
    };

    if (area?.current) attach();
    else queueMicrotask(attach);

    return () => {
      cancelled = true;
      if (raf !== 0) cancelAnimationFrame(raf);
      observer?.disconnect();
    };
  }, [area]);

  const camera = useMemo(
    () => cameraFor(rect.width, rect.height, rect.chrome),
    [rect.width, rect.height, rect.chrome]
  );

  return (
    <Scene3D camera={camera}>
      <ToothRunnerScene engine={engine} />
    </Scene3D>
  );
}

const Track = memo(TrackImpl);

/**
 * `easeOutBack(1.8)` as a cubic bezier — §4's overshoot band, expressed in the one form
 * framer-motion accepts. Nothing a child touches is allowed a `linear` or `ease-in-out`.
 */
const EASE_OUT_BACK: [number, number, number, number] = [0.34, 1.56, 0.64, 1];

export default function ToothRunner(): JSX.Element {
  const { player } = usePlayer();
  const reduced = useStore(reducedMotion);

  // Created once, on the first render, and never replaced — `ToothRunnerScene` is memoised
  // on this identity, so nothing the shell re-renders can reach the 3D tree.
  const engineRef = useRef<ToothRunnerEngine | null>(null);
  if (!engineRef.current) engineRef.current = createEngine((player?.age ?? 5) >= 8 ? 1 : 0);
  const engine = engineRef.current;

  const [, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((v) => v + 1), []);

  const surfaceRef = useRef<HTMLButtonElement>(null);
  /** Guards the synthetic `click` that follows a pointer or key we have already handled. */
  const lastInputRef = useRef(0);

  useEffect(
    () =>
      engine.on((event) => {
        switch (event.type) {
          case "start":
            // Drops the "Tap to run" pill.
            bump();
            // Shortened with the rest of the narration (see `collect`): the old 20-word
            // version took 6.7 s to speak and the first jump cue interrupts it at ~3.4 s, so
            // half of it was never heard. The `reset` line above is where the full
            // instructions live — it fires while the world is still standing still.
            announce("Off you go! Jump the sweets, grab the brushes and stars.");
            break;
          case "spawn":
            /*
             * Deliberately silent. RU8/A17: at level 3 an item spawns every 0.85–1.45 s, and
             * a *"toothbrush ahead, up high. Jump in two seconds to grab it."* is about 2.6 s
             * of speech. Two sentences per item at that cadence is a queue that can never
             * drain, and the driven measurement is what it produced — 650 ms of lag with two
             * stale lines still ahead of the live one, so the cue that mattered arrived after
             * the moment it described.
             *
             * The *what* moves onto `collect` (which is the moment that carries information)
             * and the *when* stays on `approach` below, which is the only line a player has to
             * hear on time. One short sentence per item, at the instant it is actionable.
             */
            break;
          case "approach":
            /*
             * The one time-critical line in the game, so it is the one that interrupts.
             *
             * `assertive` drops the polite backlog and speaks now — a queued "Got the star!"
             * must not hold up a jump cue. `coalesce` means a second item's cue supersedes a
             * first one that has not been spoken yet rather than queueing behind it, which is
             * what happens when two items arrive inside the 60 ms clear window.
             *
             * Short on purpose: it lands `APPROACH_LEAD` (0.55 s) before the item, and a long
             * sentence would still be reading itself out after the window has closed. The two
             * forms carry the whole verb — jump it, or jump and take it.
             */
            if (!isGoodie(event.kind)) {
              announce("Jump now!", { assertive: true, coalesce: "approach" });
            } else if (event.high) {
              announce("Jump now, grab it!", { assertive: true, coalesce: "approach" });
            }
            break;
          case "collect":
            bump();
            /*
             * Two words, and that is the whole of RU8's remaining half.
             *
             * `coalesce` supersedes a line still waiting rather than queueing behind it, but
             * coalescing cannot help a narrator that simply has more to say than the run
             * lasts. Driving the *real* engine at every level through the *real* `announce()`
             * queue and costing each line at a screen reader's default 180 words a minute:
             *
             *   level        lines        speech as a share of the run (3 seeds)
             *   1 (20 s)   29-31 -> 19-22     270-306 % -> **75-94 %**
             *   2 (25 s)   34-38 -> 21-25     258-308 % -> **68-88 %**
             *   3 (30 s)   53-55 -> 35-37     343-366 % -> **91-100 %**
             *
             * Dropping the spawn sentence is most of the line count; shortening this one from
             * *"Got the toothbrush! 5 so far."* to *"toothbrush! 5."* is what takes the share
             * under 100 %, because at the top level a perfect run collects one item every
             * 2.2 s and the long form takes 2.3 s to say. Every jump cue lands inside its
             * 0.55 s window at every level, before and after — that part was A17's fix; this
             * part is stopping the narrator from being permanently behind the child.
             *
             * The count is cumulative, so a superseded line loses nothing.
             */
            announce(`${KIND_LABELS[event.kind]}! ${event.collected}.`, { coalesce: "collect" });
            break;
          case "stumble":
            // Playful, never punitive: nothing is lost, you are just sticky for a moment.
            bump();
            announce(`Oops, ${KIND_LABELS[event.kind]}. Sticky feet!`, { coalesce: "stumble" });
            break;
          case "sticky":
            bump();
            break;
          case "tick":
            bump();
            if (event.secondsLeft === 5) announce("Five seconds left.");
            break;
          case "reset":
            bump();
            announce(
              "Tooth Runner ready. Press space to start running, then press space to jump."
            );
            break;
          case "complete":
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
    markSceneEnter("tooth-runner");
    return () => {
      markSceneExit("tooth-runner");
      engine.dispose();
    };
  }, [engine]);

  /* ---------------- keyboard ---------------- */

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== " " && e.key !== "Spacebar" && e.key !== "ArrowUp" && e.key !== "Enter") return;
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      // Stand aside for the shell's own controls, so Space still works mute, restart and
      // the difficulty selector.
      const active = document.activeElement as HTMLElement | null;
      if (active && active !== surfaceRef.current) {
        const tag = active.tagName;
        if (
          tag === "BUTTON" ||
          tag === "INPUT" ||
          tag === "SELECT" ||
          tag === "TEXTAREA" ||
          active.isContentEditable
        ) {
          return;
        }
      }
      e.preventDefault();
      lastInputRef.current = performance.now();
      engine.jump();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [engine]);

  const onPointerDown = useCallback(() => {
    // `pointerdown`, never `click`: the response has to be on the frame the finger lands.
    lastInputRef.current = performance.now();
    engine.jump();
  }, [engine]);

  /**
   * Only assistive activation should reach this — a pointer or a key press has already
   * jumped, and the browser then synthesises a `click` on top of it.
   *
   * RU10: the guard was a 500 ms wall-clock window, *"long for a game whose whole verb is a
   * jump"* — a switch or screen-reader user double-activating lost the second one. Two
   * cheaper discriminators run first and the window is only the backstop:
   *
   *  - `detail` is the click count. A real pointer click reports ≥ 1; a click synthesised by
   *    assistive tech, or by Enter on a focused button, reports **0**. So `detail > 0` is a
   *    pointer event we have already handled, whatever the clock says.
   *  - the window itself drops to 120 ms, which still covers the pointerdown → click gap
   *    (single-digit ms) and the Enter keydown → click gap, and is under the ~180 ms floor of
   *    a deliberate second activation.
   */
  const onClick = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>) => {
      if (event.detail > 0) return;
      if (performance.now() - lastInputRef.current < 120) return;
      engine.jump();
    },
    [engine]
  );

  const restart = useCallback(
    (level?: number) => {
      engine.reset(level ?? engine.level);
    },
    [engine]
  );

  const score = engine.finalScore ?? engine.score();

  return (
    <GameShell
      gameId="tooth-runner"
      title="Tooth Runner"
      subtitle="Jump the candy. Grab the brushes."
      accent="peach"
      completed={engine.completed}
      score={engine.finalScore}
      hud={{
        levels: { value: engine.level, onChange: (level) => restart(level) },
        time: fmtTime(engine.secondsLeft),
        score,
      }}
      onRestart={() => restart()}
    >
      <div className="relative min-h-0 flex-1">
        <Track engine={engine} />

        {/*
          The play surface. Transparent by design — the world behind it is the game — but a
          real focusable button, so Tab reaches it, a screen reader announces it and the
          focus ring is the browser's own. The label describes the *game*, not just the
          control: what is in the lane, what to do about it, and how.
        */}
        <button
          ref={surfaceRef}
          type="button"
          aria-label="Tooth Runner play area. Your tooth runs along a lane. Sweets to jump over, toothbrushes and stars to grab. Tap, or press space, to jump."
          onPointerDown={onPointerDown}
          onClick={onClick}
          className="no-select absolute inset-0 z-[1] touch-none cursor-pointer rounded-[28px] border-none bg-transparent p-0"
        />

        {/*
          The "Tap to run" pill.

          It is a real `<button>`, not a `pointer-events-none` label: as a label `.grad-btn`'s
          press states could never fire, so the single most important touch in the game gave
          no feedback of any kind. It is `aria-hidden` and untabbable because the play surface
          behind it already carries the accessible name — this is the *visual* affordance, and
          duplicating it in the reading order would only be noise.

          Enter is a spring inside §4's band (stiffness 340 / damping 21 — `FEEL.settle`), so
          it arrives with a real overshoot rather than the plain opacity-and-translate ramp
          `lumi-rise` gave it. Exit is a scale pop on `easeOutBack(1.8)` in 150 ms, so the
          pill is *taken* by the tap instead of being cut out of existence on the next frame.

          It sits at `bottom-[2%]`, not `bottom-[14%]`. RU11 photographed it at 14% *"directly
          on the tooth's body, hiding its legs — the read on 'this thing runs' — while telling
          the child to make it run."* The hero's feet project to 80.0–78.1 % of this container
          depending on the rect (`layout.ts::CLEAR_BOTTOM` carries the table and the strip of
          lane that was reserved to make room), and a 56 px pill at 2 % has its top edge at
          86.9 % on the narrowest rect: **6.9 points of daylight below the feet**, where 14 %
          put it 3.4 points *over* them. Nothing else moved — this is still the whole-width
          play surface's visual affordance, and the surface behind it is still the tap target.

          One rect cannot be solved in height: a landscape phone clamps `chrome` at 0.34 and
          leaves a 218 px container, of which the 56 px pill is a quarter — there are only
          44 px below the feet and the pill needs 67. That rect has width instead, so under
          560 px of viewport height the pill stops being centred and moves to the right of the
          hero, which is clear of it horizontally by the whole half-width of the lane. The pill
          keeps its size, so the ≥48 px target holds; only its anchor changes.
        */}
        <AnimatePresence>
          {!engine.started && !engine.completed && (
            <motion.div
              key="start"
              className="pointer-events-none absolute inset-x-0 bottom-[2%] z-[1] flex justify-center [@media(max-height:560px)]:justify-end [@media(max-height:560px)]:pr-[7%]"
              initial={reduced ? { opacity: 0 } : { opacity: 0, y: 18, scale: 0.84 }}
              animate={reduced ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1 }}
              exit={
                reduced
                  ? { opacity: 0, transition: { duration: 0.15, ease: "easeOut" } }
                  : { opacity: 0, scale: 1.24, transition: { duration: 0.15, ease: EASE_OUT_BACK } }
              }
              transition={
                reduced
                  ? { duration: 0.15, ease: "easeOut" }
                  : { type: "spring", stiffness: 340, damping: 21, mass: 1 }
              }
            >
              <button
                type="button"
                aria-hidden
                tabIndex={-1}
                onPointerDown={onPointerDown}
                onClick={onClick}
                className="grad-btn grad-peach pointer-events-auto cursor-pointer rounded-full px-9 py-3.5 text-lg"
              >
                Tap to run
              </button>
            </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence>
          {engine.sticky && (
            <motion.div
              key="sticky"
              className="pointer-events-none absolute inset-x-0 top-[6%] z-[1] flex justify-center"
              initial={reduced ? { opacity: 0 } : { opacity: 0, y: 12, scale: 0.8 }}
              animate={reduced ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1 }}
              exit={
                reduced
                  ? { opacity: 0, transition: { duration: 0.15, ease: "easeOut" } }
                  : { opacity: 0, scale: 1.18, transition: { duration: 0.15, ease: EASE_OUT_BACK } }
              }
              transition={
                reduced
                  ? { duration: 0.15, ease: "easeOut" }
                  : { type: "spring", stiffness: 420, damping: 26, mass: 1 }
              }
            >
              <span className="rounded-full bg-rose-deep px-4 py-1.5 font-display text-sm font-semibold text-white shadow">
                Sticky feet!
              </span>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </GameShell>
  );
}
