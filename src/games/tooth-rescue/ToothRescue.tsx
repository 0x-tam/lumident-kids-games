/**
 * Tooth Rescue — slide the basket, catch the teeth, laugh at the candy.
 *
 * This file is the shell: React-visible state and the control surface, nothing else. The
 * rules live in `engine.ts`, the table in `scene.tsx`, and the two meet inside one
 * `useFrame` — the engine's clock *is* the physics clock, so a spawn can never drift away
 * from the simulation that has to catch it.
 *
 * React renders happen on discrete events only: the once-a-second countdown, a catch, the
 * start, the finish and a resize. A spawn does not re-render anything, and the board never
 * re-renders while a body is in the air.
 *
 * The control surface is a real DOM element rather than a `HitTarget`, because what a child
 * moves here is not an object with a position, it is a one-dimensional aim. `role="slider"`
 * is exactly that control: arrow keys, Home and End work the way a screen-reader user
 * already expects, `aria-valuetext` reads back "centre left" rather than a meaningless
 * number, and the element covers the whole play field so the tap target is the screen. The
 * catches themselves are announced politely through `announce()`.
 *
 * X4: the live region carries the **game**, not just the control. Every drop announces its
 * kind and its lane in the same seven-bucket vocabulary the slider reads its own position
 * back in, so a player who cannot see the board can still line the basket up with a tooth
 * and stand clear of a sweet. See `ZONES` below.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import GameShell from "../../shared/GameShell";
import { usePlayer } from "../../shared/player";
import { fmtTime } from "../../shared/useTicker";
import { markSceneEnter, markSceneExit } from "../../dev/perf";
import { announce } from "../../three/hit";
import { Scene3D, useGameArea } from "../../three/Scene3D";
import { KIND_CANDY, createEngine, type ToothRescueEngine } from "./engine";
import { CHROME_PX_FALLBACK, sameFraming, solveFraming, type Framing } from "./layout";
import { ToothRescueScene } from "./scene";

/** One arrow press, as a fraction of the basket's full reach. */
const KEY_STEP = 0.16;

/**
 * How many frames after mount the framing keeps re-reading the chrome rect. See the framing
 * effect: child layout effects run before their parent's, so the shell has not published
 * `--chrome-bottom` when this component first measures.
 */
const CHROME_RETRY_FRAMES = 10;
/** Frames to keep retrying for the play area's element itself before reporting it. */
const HOST_RETRY_FRAMES = 8;

/**
 * The chrome band `GameShell` actually measured, not the 138 px this game used to assume.
 *
 * A12 made the shell publish its real title + HUD height on the play area as `--chrome-h`
 * (and as its `padding-top`, which is what wakes the `ResizeObserver` when only the band
 * changes). On a 390x844 phone that band is around 254 px because the level pills and the
 * chip group wrap onto two lines; solving against 138 put the whole picture 0.53 world units
 * too high and landed the accent rail at y = 184 px underneath chips occupying 254-297 px.
 * See B6.5 and `scratchpad/verify/tooth-rescue-framing.mjs`.
 *
 * **A9 / B6.4.** The shell now also publishes the chrome's *occupied rect*, and its bottom is
 * at or above `--chrome-h` — the band includes the row's padding, the rect stops at the last
 * control. The rail is solved against the rect's foot (it runs the full width of the opening,
 * so it overlaps the rect's horizontal span at every viewport and has to clear it), and the
 * camera's own shift still uses the conservative band. `-1` means "not published", which is
 * what an SSR pass and a shell that has not measured yet both report.
 */
function cssPx(el: HTMLElement, name: string): number {
  if (typeof window === "undefined") return -1;
  const raw = parseFloat(window.getComputedStyle(el).getPropertyValue(name));
  return Number.isFinite(raw) && raw > 0 ? raw : -1;
}

function chromeOf(el: HTMLElement): number {
  const raw = cssPx(el, "--chrome-h");
  return raw > 0 && raw < el.offsetHeight ? raw : CHROME_PX_FALLBACK;
}

/**
 * Floor between two spawn announcements, in ms.
 *
 * Round 3 (B6.7) counted what the old policy produced: every drop announced, every
 * 0.7-1.55 s, which over a 30 s Hard run is ~40 polite live-region updates competing with
 * catch and bounce announcements in the same queue. A drop only carries information when it
 * changes what the player should do, so a tooth already in the basket's own zone now says
 * nothing at all, and the rest are floored at this gap. A **sweet** aimed within one zone of
 * the basket ignores the floor: it is the one warning that is time-critical, and it costs
 * nothing to act on.
 */
const SPAWN_ANNOUNCE_GAP = 1500;

/**
 * What a screen reader says instead of a number. Seven buckets is enough to steer by and
 * few enough that crossing the field does not produce a stream of chatter.
 *
 * **The same vocabulary names the basket and every drop.** That is the whole of X4 for this
 * game: the audit found Tooth Rescue "announces the basket position but never where the
 * tooth is falling", which leaves a blind player steering a basket around an empty room.
 * A spawn's `event.x` and the slider's `aimX` are already the *same* -1..1 quantity — a
 * fraction of the basket's reach — so putting them through one bucket function makes the
 * game solvable by ear: the drop says "centre left", the slider reads back "centre left",
 * and they are in the same place. `zoneOf` is deliberately not exported as two functions
 * for that reason; if the two ever stopped agreeing the game would stop being playable.
 */
const ZONES = [
  "far left",
  "left",
  "centre left",
  "centre",
  "centre right",
  "right",
  "far right",
];

const zoneOf = (aim: number) => {
  const z = Math.round(((aim + 1) / 2) * (ZONES.length - 1));
  return z < 0 ? 0 : z >= ZONES.length ? ZONES.length - 1 : z;
};

function Field({ engine }: { engine: ToothRescueEngine }): JSX.Element {
  const area = useGameArea();
  const padRef = useRef<HTMLDivElement>(null);
  const zoneRef = useRef(-1);
  const [framing, setFraming] = useState<Framing>(() => solveFraming(0, 0));
  const [started, setStarted] = useState(engine.started);
  /**
   * Whether the pad is showing a *visible* focus ring, which is what the in-world ring mirrors.
   *
   * `:focus-visible` is the browser's own answer to "did this focus come from a keyboard", so
   * the 3D ring appears for a keyboard player and not for a finger — the same rule
   * `hit.tsx`'s rings follow. `matches` is wrapped because a very old engine throws on an
   * unknown pseudo-class, and the safe failure there is to *show* the indicator.
   */
  const [focusRing, setFocusRing] = useState(false);

  /* ---------------- framing ---------------- */

  /**
   * ---------------------------------------------------------------------------
   * B6.4: the set was framed at 1024x768, and `getBoundingClientRect` is why
   * ---------------------------------------------------------------------------
   *
   * Round 4 photographed the whole set inside the picture on a tablet — the alcove shell's
   * rounded left end, the plinth's cap and the shelf mat's entire near-left corner, over bare
   * page cream. That cannot happen if the numbers agree: `matHalfX` is
   * `matDepth * tan * wide + 0.7`, so its corner projects to `1 + 0.7 / (matDepth * tan * wide)`,
   * which is **greater than 1 by construction at every aspect**. The only way the picture can
   * disagree with the solve is for the aspect the set was sized against and the aspect it was
   * rendered at to be different numbers.
   *
   * `getBoundingClientRect()` is a **transformed** box. The hub to game transition is a
   * framer-motion scale flip on the shell, and drei's `<View>` tracks the element's *layout*
   * box, so during the flip the two disagree — and a `ResizeObserver` never fires again,
   * because a transform does not change the layout box. A measurement taken mid-flip is
   * therefore permanent. `GameShell` walks `offsetTop`/`offsetLeft` for the chrome rect for
   * exactly this reason and says so; this file was still asking the DOM for pixels.
   *
   * So: `offsetWidth`/`offsetHeight`, which are layout numbers and immune to the flip. Two more
   * things make a mistimed measurement recoverable rather than permanent:
   *
   *  - `layout.ts: SET_ASPECT_MIN` sizes the set for the widest aspect the product supports,
   *    not for the one this call was handed, so even a wrong aspect cannot expose an edge;
   *  - the retry below re-measures for a few frames after mount, because `--chrome-h` is
   *    published by `GameShell`'s own layout effect and **child effects run before parent
   *    effects** — the first measurement of every mount reads an unset variable and falls back
   *    to `CHROME_PX_FALLBACK`.
   */
  useLayoutEffect(() => {
    /*
     * The ref is resolved by retry, not read once.
     *
     * `GameShell` holds `areaRef` on an **ancestor** div and provides it through
     * `GameAreaContext`. React attaches a host ref in the same bottom-up layout pass that
     * runs layout effects, so a descendant's layout effect runs before the ancestor's ref is
     * attached: `area.current` is null here on every mount. Round 4 shipped
     * `if (!el) return;` in front of the `ResizeObserver` **and** in front of the bounded
     * rAF catch-up below, so neither was ever installed and `framing` kept the
     * `CHROME_PX_FALLBACK` solve for the life of the mount — the same measurement hole TR4
     * closed on the transformed-rect side.
     */
    let resolveRaf = 0;
    let attempts = 0;
    let cancelled = false;
    let observer: ResizeObserver | null = null;
    let raf = 0;

    const install = (el: HTMLElement) => {
    const measure = () => {
      const width = el.offsetWidth;
      const height = el.offsetHeight;
      if (width < 1 || height < 1) return false;
      const bottom = cssPx(el, "--chrome-bottom");
      const next = solveFraming(width, height, chromeOf(el), bottom > 0 ? bottom : undefined);
      // Only a framing a child could actually see the difference in replaces the old one:
      // a new object here would rebuild the basket's geometry and spring the camera.
      setFraming((prev) => (sameFraming(prev, next) ? prev : next));
      return bottom > 0;
    };
    measure();
    observer = new ResizeObserver(() => {
      measure();
    });
    observer.observe(el);
    // Bounded catch-up: stops the frame the shell has published its rect, and after
    // `CHROME_RETRY_FRAMES` regardless, so this can never become a per-frame cost.
    let frame = 0;
    const retry = () => {
      if (cancelled || measure() || ++frame >= CHROME_RETRY_FRAMES) return;
      raf = window.requestAnimationFrame(retry);
    };
    if (typeof window !== "undefined") raf = window.requestAnimationFrame(retry);
    };

    const resolve = () => {
      if (cancelled) return;
      const el = area?.current ?? null;
      if (!el) {
        if (++attempts <= HOST_RETRY_FRAMES) {
          resolveRaf = requestAnimationFrame(resolve);
        } else {
          console.error(
            "[tooth-rescue] the play area never attached its ref after " +
              `${HOST_RETRY_FRAMES} frames; the set is framed from the fallback rect. ` +
              "Run ?selftest=tooth-rescue-framing."
          );
        }
        return;
      }
      install(el);
    };
    if (area?.current) resolve();
    else queueMicrotask(resolve);

    return () => {
      cancelled = true;
      observer?.disconnect();
      if (raf !== 0) window.cancelAnimationFrame(raf);
      if (resolveRaf !== 0) cancelAnimationFrame(resolveRaf);
    };
  }, [area]);

  /* ---------------- aim ---------------- */

  /** Writes the aim through to the engine and keeps the slider's ARIA value honest. */
  const setAim = useCallback(
    (nx: number) => {
      engine.aim(nx);
      const el = padRef.current;
      if (!el) return;
      const zone = zoneOf(engine.aimX);
      if (zone === zoneRef.current) return;
      zoneRef.current = zone;
      el.setAttribute("aria-valuenow", String(Math.round(((engine.aimX + 1) / 2) * 100)));
      el.setAttribute("aria-valuetext", ZONES[zone]);
    },
    [engine]
  );

  const begin = useCallback(() => {
    if (engine.started || engine.completed) return;
    engine.start();
    setStarted(true);
    announce("Go! Catch the falling teeth. Sweets bounce back out — let them go.");
  }, [engine]);

  /** Pointer x → world x on the basket's own line, then → aim. No raycast, no allocation. */
  const aimAt = useCallback(
    (clientX: number) => {
      const el = area?.current;
      if (!el) return;
      const box = el.getBoundingClientRect();
      if (box.width < 1) return;
      // The camera sits in the YZ plane with no roll, so screen X maps to world X by a
      // single scalar at the basket's depth — `halfX` is that scalar, solved in layout.ts.
      const ndc = ((clientX - box.left) / box.width) * 2 - 1;
      setAim((ndc * framing.halfX) / framing.playHalf);
    },
    [area, framing.halfX, framing.playHalf, setAim]
  );

  /* Re-announce the starting position whenever a run resets. */
  useEffect(() => {
    zoneRef.current = -1;
    setAim(engine.aimX);
  }, [engine, setAim, started]);

  /* Hand keyboard focus to the field the moment the run begins. */
  useEffect(() => {
    if (started) padRef.current?.focus();
  }, [started]);

  useEffect(
    () =>
      engine.on((event) => {
        if (event.type === "reset") setStarted(false);
      }),
    [engine]
  );

  const showsFocusRing = (el: HTMLElement): boolean => {
    try {
      return el.matches(":focus-visible");
    } catch {
      return true;
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case "ArrowLeft":
        e.preventDefault();
        begin();
        setAim(engine.aimX - KEY_STEP);
        break;
      case "ArrowRight":
        e.preventDefault();
        begin();
        setAim(engine.aimX + KEY_STEP);
        break;
      case "Home":
        e.preventDefault();
        begin();
        setAim(-1);
        break;
      case "End":
        e.preventDefault();
        begin();
        setAim(1);
        break;
      case " ":
      case "Enter":
        e.preventDefault();
        begin();
        break;
      default:
        break;
    }
  };

  return (
    <div className="relative z-[1] flex min-h-0 flex-1 flex-col">
      {/*
        `aria-valuenow` and `aria-valuetext` are authored here as constants so the slider is
        valid from the first paint, and then owned by `setAim`, which writes them straight
        to the node. React never rewrites an attribute whose prop has not changed, so the
        two never fight.
      */}
      <div
        ref={padRef}
        role="slider"
        tabIndex={0}
        aria-label="Basket position — drag, or use the arrow keys"
        aria-orientation="horizontal"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={50}
        aria-valuetext="centre"
        onKeyDown={onKeyDown}
        onFocus={(e) => setFocusRing(showsFocusRing(e.currentTarget))}
        onBlur={() => setFocusRing(false)}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          // Order matters. The press is registered first so the basket's jelly answers on
          // the very next frame whether or not this press also starts the run, and `aimAt`
          // runs on pointer-**down** rather than being eaten by an overlay's `onClick`,
          // which fires on pointer-up. See B6.4 and `engine.press`.
          engine.press();
          begin();
          aimAt(e.clientX);
        }}
        onPointerMove={(e) => aimAt(e.clientX)}
        onPointerUp={(e) => {
          if (e.currentTarget.hasPointerCapture(e.pointerId)) {
            e.currentTarget.releasePointerCapture(e.pointerId);
          }
        }}
        /*
          **B6.3(a): the DOM band is gone, because there is a real ring in the world now.**

          It was the standard two-tone WCAG 2.4.11 indicator — a 3 px `CLAY.ivory` band with a
          3 px `#2f3237` band inside it — and the a11y critic who photographed it called it "a
          strong, deliberate two-tone band". It was also a **6 px hard-cornered rectangle around
          the entire viewport**, on a product whose spec bans a hard edge anywhere and in the
          only one of nine games that had no in-world indicator at all (`focus-rings.json`
          records `tag: "DIV"` here against eight in-world rings elsewhere). A band around the
          screen also says nothing about *what* the arrow keys move.

          `scene.tsx` now draws `FocusRing` around the basket instead — three lit clay ropes on
          the object the keys actually control — and this element carries `outline-none`, which
          works as of A10: `index.css`'s global `:focus-visible` rule was unlayered and beat
          every Tailwind utility regardless of specificity, and A10 moved it into `@layer base`.

          The indicator is not lost, it moved: `onFocus`/`onBlur` above drive `focusRing`, which
          is passed straight to the ring.
        */
                className="no-select min-h-0 flex-1 touch-none rounded-[28px] focus-visible:outline-none"
      />

      {/*
        There is no start gate here any more, and that is the fix rather than a removal.

        It was a full-field `<button onClick>` at `z-[2]` over this pad at `z-[1]`, and
        `onClick` fires on pointer-**up** — so the whole of a child's first press was
        consumed by it and `aimAt` never saw the drag. A child who tapped and immediately
        slid got a basket that ignored their finger for the first gesture of the game. What
        it taught in exchange was two lines of English, on a screen for four-year-olds.

        The invitation is in the room now: the chute sits loaded with a tooth that bobs, the
        landing marker under it shows where a drop ends up, and the basket presses and pops
        back the instant a finger lands on it (`scene.tsx`, the `PERCH_*` and `PRESS_KICK`
        blocks). Keyboard and screen-reader players lose nothing: `onKeyDown` below already
        starts the run from any arrow, Home, End, Enter or Space, and the `reset`
        announcement says so in words.
      */}
      <Scene3D camera={framing}>
        <ToothRescueScene engine={engine} framing={framing} focused={focusRing} />
      </Scene3D>
    </div>
  );
}

export default function ToothRescue(): JSX.Element {
  const { player } = usePlayer();

  // Created once and never replaced — `ToothRescueScene` is memoised on this identity, so
  // the countdown re-rendering the shell every second cannot reach the 3D tree.
  const engineRef = useRef<ToothRescueEngine | null>(null);
  if (!engineRef.current) engineRef.current = createEngine((player?.age ?? 5) >= 8 ? 1 : 0);
  const engine = engineRef.current;

  /** When the last spawn announcement went out. See `SPAWN_ANNOUNCE_GAP`. */
  const spawnSaidRef = useRef(-Infinity);

  const [, setVersion] = useState(0);

  useEffect(
    () =>
      engine.on((event) => {
        switch (event.type) {
          case "spawn": {
            /*
              X4. The one announcement that turns this from an operable control into a
              playable game: *where the thing is*, in the same words the basket reports
              itself in, and *what* it is, so a blind player knows whether to chase it or
              stand clear. `event.x` is a fraction of the basket's own reach, so "centre
              left" here and "centre left" from the slider are the same place.

              Round 3 (B6.7) was right that announcing *every* drop is not that. It fired
              every 0.7-1.55 s — about forty updates over a 30 s Hard run — into the same
              polite queue as the catch and bounce lines, so the messages that matter
              queued behind ones that did not. The filter is the question "does this change
              what the player should do":

                - a tooth already falling into the basket's own zone needs no move, so it
                  says nothing;
                - anything else is floored at `SPAWN_ANNOUNCE_GAP`;
                - a sweet aimed within one zone of the basket ignores the floor, because it
                  is the only time-critical warning in the game.

              Worst case is now one update per 1.5 s instead of one per 0.7, and roughly a
              seventh of tooth drops fall silent on top of that.
            */
            const drop = zoneOf(event.x);
            const here = zoneOf(engine.aimX);
            const now = typeof performance === "undefined" ? Date.now() : performance.now();
            /*
              A17's coalescing key. A drop line describes *one* thing — where the next thing
              to steer at is — so a queued one that has not been spoken yet is worthless the
              moment a newer one exists. `"drop"` makes the queue keep only the newest, which
              is the difference between steering at where the tooth is and steering at where
              it was two spawns ago. The `SPAWN_ANNOUNCE_GAP` floor below is still what keeps
              the *rate* down; this is what keeps the content current.
            */
            if (event.kind === KIND_CANDY) {
              if (Math.abs(drop - here) > 1) break;
              spawnSaidRef.current = now;
              announce(`Sweet, ${ZONES[drop]}. Let it go by.`, { coalesce: "drop" });
            } else {
              if (drop === here) break;
              if (now - spawnSaidRef.current < SPAWN_ANNOUNCE_GAP) break;
              spawnSaidRef.current = now;
              announce(`Tooth falling, ${ZONES[drop]}.`, { coalesce: "drop" });
            }
            break;
          }
          case "catch":
            setVersion((v) => v + 1);
            // Same key discipline (A17): the running total is one fact, and only its newest
            // value is worth waiting to hear.
            announce(
              event.caught >= event.goal
                ? `Caught! That is all ${event.goal}.`
                : `Caught! ${event.caught} of ${event.goal}. Basket ${ZONES[zoneOf(engine.aimX)]}.`,
              { coalesce: "catch" }
            );
            break;
          case "bounce":
            // Playful, never punitive: nothing is lost, the candy just leaves in a hurry.
            announce("Oops! The candy bounced right back out.");
            break;
          case "complete":
            setVersion((v) => v + 1);
            announce(
              `Time! You rescued ${event.caught} ${event.caught === 1 ? "tooth" : "teeth"}. Well done.`
            );
            break;
          case "reset":
            setVersion((v) => v + 1);
            /*
              X4 again. `reset` fires from the shell's restart button and from every
              difficulty pill, and a player who cannot see the board otherwise gets silence
              from both — the board is back to empty and the goal may have changed from 8
              to 12, and nothing said so. The goal is the only number in this game a player
              needs to plan with, so it is what the fresh board announces.
            */
            announce(
              `New basket, empty. Catch ${event.goal} teeth. Press an arrow key, or tap, to start.`
            );
            break;
          case "tick":
          case "start":
            setVersion((v) => v + 1);
            break;
          default:
            break;
        }
      }),
    [engine]
  );

  useEffect(() => {
    markSceneEnter("tooth-rescue");
    return () => {
      markSceneExit("tooth-rescue");
      engine.dispose();
    };
  }, [engine]);

  const restart = useCallback(
    (level?: number) => {
      engine.reset(level);
    },
    [engine]
  );

  const score = engine.finalScore ?? engine.liveScore();

  return (
    <GameShell
      gameId="tooth-rescue"
      title="Tooth Rescue"
      subtitle="Slide the basket. Catch the falling teeth."
      accent="red"
      completed={engine.completed}
      score={score}
      hud={{
        levels: { value: engine.level, onChange: (level) => restart(level) },
        time: fmtTime(engine.secondsLeft),
        score,
      }}
      onRestart={() => restart()}
    >
      <Field engine={engine} />
    </GameShell>
  );
}
