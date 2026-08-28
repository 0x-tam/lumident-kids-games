/**
 * Healthy or Not? — feed the tooth the foods that keep it strong, wave the sugary ones away.
 *
 * This file is the *shell*: it owns the React-visible state and nothing else. All game
 * logic lives in `engine.ts`, all presentation in `scene.tsx`, and the two talk through the
 * engine's event emitter — never through props that change while a prop is in the air.
 *
 * Rules, levels, scoring and the deal are exactly the 2D game's (PROJECT.md):
 *   8 / 10 / 12 rounds · multiplier 1 / 1.5 / 2 · par 40 / 55 / 70 s
 *   a correct answer pays `round(100 × multiplier)`, a wrong one pays nothing
 *   final score = points + max(0, par − seconds) × 2
 *   players aged 8+ start on Medium · the deal is re-randomised every run.
 *
 * React renders here happen on discrete events only: an answer, a new round, the finish,
 * and the once-a-second timer tick. The set itself renders zero times per frame.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import GameShell from "../../shared/GameShell";
import { usePlayer } from "../../shared/player";
import { fmtTime, useTicker } from "../../shared/useTicker";
import { markSceneEnter, markSceneExit } from "../../dev/perf";
import { announce } from "../../three/hit";
import { Scene3D, useGameArea } from "../../three/Scene3D";
import { FLAGS } from "../../three/store";
import { FOOD_LABELS, createEngine, type FoodId, type HealthyEngine } from "./engine";
import {
  DEFAULT_CHROME_PX,
  cameraFor,
  chromeBandRect,
  framingReport,
  type ChromeRect,
} from "./layout";
import { HealthyScene } from "./scene";

/**
 * Frames the set from the play area's real size.
 *
 * `GameShell` hands a game the whole shell interior — roughly 1.03:1 on a laptop and 0.48:1
 * on a phone held upright — so both the camera distance *and* the composition are solved
 * from the measured rect (see `layoutFor` / `cameraFor`). This component sits on the DOM
 * side of `<Scene3D>`, which is the only place `GameAreaContext` can be read: everything
 * below the view renders in the R3F root and shares no context with the page.
 *
 * The aspect is quantised to 0.05 before it reaches the scene, so a window drag re-renders
 * the 3D tree a handful of times rather than on every pixel.
 */
type Measured = {
  width: number;
  height: number;
  /** The chrome's occupied box, in play-area pixels. */
  chrome: ChromeRect;
  /** False until the play area has actually been found and read. */
  real: boolean;
};

const FALLBACK: Measured = {
  width: 0,
  height: 0,
  chrome: chromeBandRect(0, DEFAULT_CHROME_PX),
  real: false,
};

/** How many frames to keep looking for the play area before giving up and shouting. */
const AREA_RETRY_FRAMES = 8;

function Stage({ engine }: { engine: HealthyEngine }): JSX.Element {
  const area = useGameArea();
  const [rect, setRect] = useState<Measured>(FALLBACK);

  /**
   * ## The play area was never measured, on any device, in any shipped frame
   *
   * This effect used to open with `const el = area?.current; if (!el) return;` and depend on
   * `[area]` — the context's ref *object*, whose identity never changes. React attaches a
   * host element's ref while committing that fiber, and it commits children before parents,
   * so a layout effect inside `<GameShell>`'s play-area div runs **before**
   * `areaRef.current` is set. The guard therefore fired on the first (and only) run, no
   * `ResizeObserver` was ever attached, and `rect` stayed `{0, 0, 138}` for the life of the
   * mount. `cameraFor(0, 0, …)` falls back to `aspect = 1`; `layoutFor(0/0 → 1)` returns the
   * *landscape* composition. Every frame this game has ever rendered was framed for a square.
   *
   * On a laptop that is nearly harmless — the shell measures 826x807, aspect 1.02 — which is
   * why four rounds of review never caught it. At 390x844 the play area is 358x748, aspect
   * 0.479, and the same camera renders the landscape set into a portrait frustum: the
   * turntable runs off the left edge and the dish — one of the three answer targets — is
   * guillotined by the right (round 4, HN1).
   *
   * Reproduced numerically before it was touched, against `healthy-or-not-phone.png`
   * (panel origin 16,76; landmarks in panel pixels):
   *
   *   |                          | tray right | crown x    | crown top | dish left |
   *   |--------------------------|-----------:|-----------:|----------:|----------:|
   *   | observed in the PNG      |        284 |  139 – 284 |       252 |       304 |
   *   | solved at 358x748        |        260 |  115 – 241 |       336 |       183 |
   *   | solved at 0x0 (fallback) |        275 |  125 – 290 |       229 |       297 |
   *
   * The shipped frame is the fallback, to within a few pixels, and is nothing like the
   * frame the measured rect asks for.
   *
   * So the resolution retries instead of bailing, exactly as `Scene3D` had to for the same
   * reason (A8), and if it still cannot find the area it says so rather than framing a
   * square in silence.
   */
  useLayoutEffect(() => {
    if (!area) return;
    let raf = 0;
    let tries = 0;
    let observer: ResizeObserver | null = null;
    let mutations: MutationObserver | null = null;

    const measure = (el: HTMLElement) => {
      // `offsetWidth`/`offsetHeight`, never `getBoundingClientRect()`: the panel is
      // CSS-scaled through the hub → game flip, and a transformed rect reports a quarter of
      // the real size — which would solve the camera for the wrong aspect, hold that
      // framing for the length of the transition, and then snap. These are layout
      // measurements, so a transform cannot touch them.
      const width = el.offsetWidth;
      const height = el.offsetHeight;
      const style = getComputedStyle(el);
      const px = (name: string, fallback: number): number => {
        const raw = Number.parseFloat(style.getPropertyValue(name));
        return Number.isFinite(raw) ? raw : fallback;
      };
      // `GameShell` publishes the measured title + HUD band here as `--chrome-h` and its
      // occupied box as `--chrome-{left,top,right,bottom}` (A9). Reading them rather than
      // hard-coding is what stops the shot reserving a band that is not there: the reserve
      // costs a fifth of the frame height, so guessing it high is the most expensive guess
      // in the file. The rect is preferred; the band is the conservative fallback for the
      // first frame, before `GameShell`'s own measurement effect has run.
      const band = px("--chrome-h", DEFAULT_CHROME_PX);
      const bottom = px("--chrome-bottom", Number.NaN);
      const chrome: ChromeRect = Number.isFinite(bottom)
        ? {
            left: px("--chrome-left", 0),
            top: px("--chrome-top", 0),
            right: px("--chrome-right", width),
            bottom,
          }
        : chromeBandRect(width, band > 0 ? band : DEFAULT_CHROME_PX);
      setRect((prev) =>
        // Quantised: a one-pixel reflow must not spring the camera.
        prev.real &&
        Math.abs(prev.width - width) < 6 &&
        Math.abs(prev.height - height) < 6 &&
        Math.abs(prev.chrome.bottom - chrome.bottom) < 4 &&
        Math.abs(prev.chrome.left - chrome.left) < 4 &&
        Math.abs(prev.chrome.right - chrome.right) < 4
          ? prev
          : { width, height, chrome, real: true }
      );
    };

    const attach = () => {
      const el = area.current;
      if (!el) {
        tries += 1;
        if (tries > AREA_RETRY_FRAMES) {
          console.error(
            `[healthy-or-not] no play area after ${AREA_RETRY_FRAMES} frames; the camera is ` +
              "being solved against the fallback rect and the framing will be wrong."
          );
          return;
        }
        raf = requestAnimationFrame(attach);
        return;
      }
      measure(el);
      // The content box shrinks by the chrome's `padding-top`, so this wakes on a band that
      // grows — a wrapped title, a HUD row appearing, Manrope replacing the fallback face.
      observer = new ResizeObserver(() => measure(el));
      observer.observe(el);
      // …but a chip cluster that grows *sideways* changes the published rect without
      // changing any box on this element, and `GameShell` publishes by writing inline
      // custom properties. Watching the attribute is what makes the rect live rather than
      // a first-paint snapshot.
      mutations = new MutationObserver(() => measure(el));
      mutations.observe(el, { attributes: true, attributeFilter: ["style"] });
    };

    attach();
    return () => {
      cancelAnimationFrame(raf);
      observer?.disconnect();
      mutations?.disconnect();
    };
  }, [area]);

  const raw = rect.width > 0 && rect.height > 0 ? rect.width / rect.height : 1;
  const aspect = Math.round(raw * 20) / 20;

  /*
   * Memoised on the measured rect, not recomputed per render.
   *
   * `cameraFor` is a 26-step distance bisection wrapping a 22-step aim bisection over 123
   * silhouette points — about 70,000 point evaluations. This component re-renders on every
   * engine event and on every one-second tick, and the answer only changes when the rect
   * does, so without this the solve runs a few times a second for nothing.
   */
  const camera = useMemo(
    () => cameraFor(rect.width, rect.height, rect.chrome),
    [rect.width, rect.height, rect.chrome]
  );

  /*
   * The check the crop got past.
   *
   * `framingReport` re-measures every silhouette point against the camera the solve just
   * returned — not against the solve's own intermediate state — so a breach is a number with
   * an address rather than an argument about a screenshot. Registered as a self-test so
   * `?selftest=framing` fails on it in the page, at whatever viewport the harness is driving,
   * which is the only place the phone case can actually be observed.
   *
   * Registered **once**, reading the live rect through a ref: `registerSelfTest` re-arms the
   * suite's auto-run debounce on every call, so re-registering on every resize would keep
   * pushing the run into the future for as long as a window was being dragged.
   */
  const latest = useRef(rect);
  latest.current = rect;
  useEffect(() => {
    if (FLAGS.selftest === null) return;
    let cancelled = false;
    void import("../../dev/selftest").then(({ registerSelfTest }) => {
      if (cancelled) return;
      registerSelfTest("healthy-or-not-framing", () => {
        const now = latest.current;
        if (!now.real) {
          return {
            name: "healthy-or-not-framing",
            pass: false,
            detail: "the play area was never measured; the camera is on the fallback rect",
          };
        }
        const r = framingReport(now.width, now.height, now.chrome);
        const worst = Math.max(r.sideBreach, r.bottomBreach, r.chromeBreach);
        return {
          name: "healthy-or-not-framing",
          pass: worst <= 1e-3,
          detail:
            `${now.width}x${now.height} aspect ${r.aspect.toFixed(3)}, chrome bottom ` +
            `${now.chrome.bottom}px, distance ${r.distance.toFixed(3)}, ${r.points} silhouette ` +
            `points — side ${r.sideBreach.toFixed(4)}, bottom ${r.bottomBreach.toFixed(4)}, ` +
            `chrome ${r.chromeBreach.toFixed(4)} (NDC; <= 0 is clear)`,
          data: r,
        };
      });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Scene3D camera={camera}>
      <HealthyScene engine={engine} aspect={aspect} />
    </Scene3D>
  );
}

export default function HealthyOrNot(): JSX.Element {
  const { player } = usePlayer();

  // Created once, on the first render, and never replaced — `HealthyScene` is memoised on
  // this identity, so nothing the shell re-renders can reach the 3D tree.
  const engineRef = useRef<HealthyEngine | null>(null);
  if (!engineRef.current) engineRef.current = createEngine((player?.age ?? 5) >= 8 ? 1 : 0);
  const engine = engineRef.current;

  const [, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((v) => v + 1), []);

  const [seconds, resetTimer] = useTicker(engine.started && engine.finalScore === undefined);

  /** The engine reads this when the last round lands, to price the time bonus. */
  useEffect(() => {
    engine.seconds = seconds;
  }, [engine, seconds]);

  useEffect(
    () =>
      engine.on((event) => {
        bump();
        switch (event.type) {
          case "deal":
            announce(opening(engine.foods[0].id, 0, engine.rounds));
            break;
          case "present":
            announce(
              `Round ${event.round + 1} of ${engine.rounds}. On the turntable: ${FOOD_LABELS[event.food.id]}. Feed it to the tooth, or wave it away?`
            );
            break;
          case "answer": {
            const name = FOOD_LABELS[event.food.id];
            const left = engine.rounds - event.round - 1;
            const more = left > 0 ? ` ${left} ${left === 1 ? "food" : "foods"} to go.` : "";
            if (event.correct) {
              announce(
                event.exit === "eat"
                  ? `Yes! ${capitalise(name)} keeps teeth strong. The tooth eats it. ${event.earned} points.${more}`
                  : `Good choice. Bye bye, ${name} — it lands in the dish. ${event.earned} points.${more}`
              );
            } else {
              // Never a failure, never a penalty: an "oops" and the food still goes where
              // it belongs, so the child sees — and hears — the right answer happen either
              // way. The announcement names the destination for the same reason the dish
              // is open: the answer has to be learnable, not just scored.
              announce(
                event.choice === "feed"
                  ? `Oops, ${name} is very sugary. It gets waved away instead.${more}`
                  : `${capitalise(name)} is tooth friendly too. The tooth eats it.${more}`
              );
            }
            break;
          }
          case "reject":
            announce("One food at a time.");
            break;
          case "complete":
            announce(`All rounds done! ${event.score} points.`);
            break;
          default:
            break;
        }
      }),
    [engine, bump]
  );

  useEffect(() => {
    markSceneEnter("healthy-or-not");
    // The engine deals inside its own factory, before this subscription exists, so round
    // one never arrives as an event — announce it here or a screen-reader user starts the
    // game with no idea what is on the turntable.
    const first = engine.foods[engine.round];
    if (first) announce(opening(first.id, engine.round, engine.rounds));
    return () => {
      markSceneExit("healthy-or-not");
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
      gameId="healthy-or-not"
      title="Healthy or Not?"
      subtitle="Feed the tooth the good stuff. Wave the sweet stuff away."
      accent="peach"
      completed={engine.completed}
      score={engine.finalScore}
      hud={{
        levels: { value: engine.level, onChange: (level) => restart(level) },
        time: fmtTime(seconds),
        score: engine.finalScore ?? engine.liveScore(),
      }}
      onRestart={() => restart()}
    >
      <Stage engine={engine} />
    </GameShell>
  );
}

/** `FOOD_LABELS` are written to sit mid-sentence ("an apple"); some lines need them first. */
const capitalise = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * The first thing a screen-reader player hears.
 *
 * It has to say where the *game* is, not where the controls are: what is on the turntable,
 * what the two answers are, and which keys reach them. The three tap targets are one roving
 * tab stop (`scene.tsx`), so "arrow keys" is the whole navigation model.
 */
function opening(food: FoodId, round: number, rounds: number): string {
  return (
    `Round ${round + 1} of ${rounds}. On the turntable: ${FOOD_LABELS[food]}. ` +
    "Is it good for teeth? Arrow keys move between the food, the tooth and the dish; " +
    "Enter chooses. Enter on the food picks it up so you can hear it named again; Enter on " +
    "the tooth feeds it, and Enter on the dish waves it away."
  );
}
