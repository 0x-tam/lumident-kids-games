/**
 * Smile Maker — a photo booth for one very patient tooth.
 *
 * This file is the *shell*: it owns the React-visible state and nothing else. The sandbox
 * rules live in `engine.ts`, every model in `build.ts`, all presentation in `scene.tsx`,
 * and the three talk through the engine's event emitter — never through props that change
 * while something is moving.
 *
 * Behaviour carried over from the 2D game (PROJECT.md): a sandbox with no score, no timer
 * and no levels; the same ten accessories; tap to put one on or take it off; "Surprise"
 * shuffles and takes two to four (the 2D "Randomize"); "Clear" empties the tooth (the 2D
 * "Reset"); "Snap!" takes a photo the child can put away and take again as often as they
 * like (the 2D "Done"). Nothing can be got wrong, so nothing here can fail.
 *
 * React renders happen on discrete events only — an accessory moving, the polaroid arriving
 * or leaving. The booth itself renders zero times per frame.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import GameShell from "../../shared/GameShell";
import { usePlayer } from "../../shared/player";
import { markSceneEnter, markSceneExit } from "../../dev/perf";
import { announce } from "../../three/hit";
import { Scene3D, useGameArea } from "../../three/Scene3D";
import { ACCESSORIES, createEngine, type SmileMakerEngine } from "./engine";
import { cameraFor } from "./layout";
import { SmileMakerScene } from "./scene";

/** Fallbacks used only until the first measurement lands. */
const CHROME_FALLBACK = 132;
/**
 * What the booth must clear at the *bottom* of the frame.
 *
 * It used to be the measured height of this game's DOM control row plus its padding. The row
 * is gone (round 4, SM7): Snap, Surprise and Clear are objects in the booth now, and
 * `layout.ts::CONTROL_SLOTS` puts them in exactly the band the row used to cover, as
 * *content* the camera solve fits rather than as a reserve it works around. What is left to
 * clear is the play area's own bottom padding.
 */
const CONTROLS_FALLBACK = 26;
/** How many frames to keep looking for the play area before giving up and shouting. */
const AREA_RETRY_FRAMES = 8;

/**
 * What the tooth is wearing, as a sentence.
 *
 * X4: a screen-reader player was told where the *controls* were and never where the *game*
 * was — "Crown on, on top" says what just happened but never what the tooth now looks like,
 * so after three or four moves there is no way to know what you have made. Every state
 * change now ends with this. Maze Escape's announcements (direction + open exits +
 * remaining distance) are the reference: enough to play the game without seeing it.
 */
function wornList(engine: SmileMakerEngine): string {
  const names: string[] = [];
  for (let i = 0; i < ACCESSORIES.length; i++) {
    if (engine.worn[i] === 1) names.push(ACCESSORIES[i].name.toLowerCase());
  }
  if (names.length === 0) return "The tooth is bare.";
  if (names.length === 1) return `The tooth is wearing a ${names[0]}.`;
  const last = names[names.length - 1];
  return `The tooth is wearing ${names.slice(0, -1).join(", ")} and a ${last}.`;
}


/**
 * Frames the booth from the play area's real size **and the real height of both chrome
 * bands**.
 *
 * `GameShell` hands a game its whole interior, which is a very different shape on a phone
 * held upright than on a laptop, so the distance has to be solved from the measured rect
 * rather than fixed (see `cameraFor`). It also publishes the measured height of its own
 * title band as `--chrome-h`; this game's control row is measured the same way. Both used to
 * be hard-coded constants in `layout.ts` — `CHROME_PX = 118` against a band that actually
 * renders at 132 — and a camera solved against a band 14 px shorter than the real one puts
 * the top of a party hat underneath the title.
 *
 * This sits on the DOM side of `<Scene3D>` because that is the only place `GameAreaContext`
 * can be read — everything below the view renders in the R3F root and shares no context with
 * the page.
 */
function Booth({ engine }: { engine: SmileMakerEngine }): JSX.Element {
  const area = useGameArea();
  const [rect, setRect] = useState({
    width: 0,
    height: 0,
    chrome: CHROME_FALLBACK,
    controls: CONTROLS_FALLBACK,
    real: false,
  });

  /**
   * ## The play area was never measured, in any shipped frame
   *
   * This effect used to open with `const el = area?.current; if (!el) return;` and depend on
   * `[area, controlsRef]` — the context's ref *object*, whose identity never changes. React
   * attaches a host element's ref while committing that fiber and commits children before
   * parents, so a layout effect inside a `<GameShell>` descendant runs **before**
   * `areaRef.current` is set. The guard therefore fired on the first and only run, no
   * `ResizeObserver` was ever attached, and `rect` stayed `{0, 0, 132, 78}` for the life of
   * the mount. `cameraFor(0, 0, …)` falls back to `aspect = 1`, so every frame this game has
   * ever rendered was framed for a square play area.
   *
   * Reproduced numerically against the shipped `cameraFor` before it was touched
   * (`scratchpad/sm/camtest.mjs`): the square fallback solves the camera to distance 8.15,
   * the laptop rect (822x670) to 8.82 and a 390x844 phone to 12.69. On a laptop that is a
   * 8 % error nobody would photograph; on a phone the booth was rendered **56 % too large**
   * for its frame. `healthy-or-not/HealthyOrNot.tsx` documents the identical defect and the
   * identical cause, found independently in the same round.
   *
   * So the resolution retries, exactly as `Scene3D` had to for the same reason (A8), and if
   * it still cannot find the area it says so rather than framing a square in silence.
   *
   * `offsetWidth`/`offsetHeight`, never `getBoundingClientRect()`: the panel is CSS-scaled
   * through the hub -> game flip, so a transformed rect reports a fraction of the real size
   * — which would solve the camera for the wrong aspect, hold that framing for the length of
   * the transition, and then snap. These are layout measurements; a transform cannot touch
   * them.
   */
  useLayoutEffect(() => {
    if (!area) return;
    let raf = 0;
    let tries = 0;
    let observer: ResizeObserver | null = null;

    const measure = (el: HTMLElement) => {
      const width = el.offsetWidth;
      const height = el.offsetHeight;
      const style = getComputedStyle(el);
      const px = (name: string, fallback: number): number => {
        const raw = Number.parseFloat(style.getPropertyValue(name));
        return Number.isFinite(raw) ? raw : fallback;
      };
      /*
       * `--chrome-bottom` is `GameShell`'s measured *occupied* box — the union of the four
       * real control clusters — and it is never more than `--chrome-h`, which is the whole
       * band including the row's padding (A9). Reserving the box rather than the band is
       * picture back: on the design rect it is 14 px, and the reserve costs about a fifth of
       * the frame height, so guessing it high is the most expensive guess in this file.
       * `--chrome-h` stays the conservative fallback for the first frame, before
       * `GameShell`'s own measurement effect has run.
       */
      const bottom = px("--chrome-bottom", Number.NaN);
      const chrome = Number.isFinite(bottom) ? bottom : px("--chrome-h", CHROME_FALLBACK);
      setRect((prev) =>
        // Quantised: a one-pixel reflow must not spring the camera.
        prev.real &&
        Math.abs(prev.width - width) < 6 &&
        Math.abs(prev.height - height) < 6 &&
        Math.abs(prev.chrome - chrome) < 4
          ? prev
          : { width, height, chrome, controls: CONTROLS_FALLBACK, real: true }
      );
    };

    const attach = () => {
      const el = area.current;
      if (!el) {
        if (++tries <= AREA_RETRY_FRAMES) {
          raf = requestAnimationFrame(attach);
          return;
        }
        console.error(
          "[smile-maker] the play area never attached its ref, so the booth is framed for " +
            "a square. Run ?selftest=viewport for the full diagnostic."
        );
        return;
      }
      measure(el);
      observer = new ResizeObserver(() => measure(el));
      observer.observe(el);
    };
    attach();

    return () => {
      if (raf !== 0) cancelAnimationFrame(raf);
      observer?.disconnect();
    };
  }, [area]);

  return (
    <Scene3D camera={cameraFor(rect.width, rect.height, rect.chrome, rect.controls)}>
      <SmileMakerScene engine={engine} />
    </Scene3D>
  );
}

export default function SmileMaker(): JSX.Element {
  const { player } = usePlayer();

  // Created once, on the first render, and never replaced — `SmileMakerScene` is memoised
  // on this identity, so nothing the shell re-renders can reach the 3D tree.
  const engineRef = useRef<SmileMakerEngine | null>(null);
  if (!engineRef.current) {
    engineRef.current = createEngine(player ? `${player.name}'s smile!` : "What a smile!");
  }
  const engine = engineRef.current;

  /*
   * No `useState` here any more, and that is the point.
   *
   * This component used to keep a version counter and bump it on every engine event, purely
   * so the DOM control row could re-render — `Clear` becoming `Undo`, `Snap!` becoming `Put
   * away`. The row is gone (SM7), so every one of those renders was work with no output.
   * What is left is the narration, which is a side effect and needs no render at all.
   */
  useEffect(
    () =>
      engine.on((event) => {
        switch (event.type) {
          case "place":
            if (!event.changed) break;
            announce(
              (event.attached
                ? `${ACCESSORIES[event.index].name} on, ${ACCESSORIES[event.index].place}. `
                : `${ACCESSORIES[event.index].name} back on the shelf. `) + wornList(engine)
            );
            break;
          case "displace":
            // Never a failure, just a polite shuffle.
            announce(`${ACCESSORIES[event.index].name} hops back to the shelf to make room.`);
            break;
          case "layout":
            announce(
              (event.reason === "randomize"
                ? "Surprise smile! "
                : event.reason === "undo"
                  ? "Everything is back. "
                  : engine.canUndoClear
                    ? "All clear. Press the tray again to put it all back. "
                    : "All clear. ") +
                wornList(engine)
            );
            break;
          case "nudge":
            // The child pressed the brightest button on an empty tooth. Invitation, never a
            // refusal, and it names the next thing to do rather than the thing that failed.
            announce(
              "The tooth is bare, so there is nothing to photograph yet. " +
                "Put something on it first, then press the camera."
            );
            break;
          case "photo":
            announce(`Say cheese! Here is your polaroid. ${wornList(engine)}`);
            break;
          default:
            break;
        }
      }),
    [engine]
  );

  useEffect(() => {
    markSceneEnter("smile-maker");
    announce(
      "Smile Maker. Tab to the accessory shelf, then use the left and right arrow keys to " +
        "move along its ten accessories and Enter to put one on the tooth or take it off. " +
        "Tab again for the booth's three controls: a camera that takes the photo, a lever " +
        "for a surprise smile, and a tray that clears the tooth. Hold Shift with the arrow " +
        "keys to turn the booth around, and it stays where you leave it. The tooth is bare."
    );
    return () => {
      markSceneExit("smile-maker");
      engine.dispose();
    };
  }, [engine]);

  const restart = useCallback(() => engine.reset(), [engine]);

  return (
    <GameShell
      gameId="smile-maker"
      title="Smile Maker"
      subtitle="Create your own funny smile."
      accent="mauve"
      completed={false}
      onRestart={restart}
    >
      {/*
        The booth is the whole interface. Round 4, SM7: "this is a photo booth with no camera
        in it … three DOM pills sitting on bare cream between the turntable's front rim and
        the frame edge, anchored to nothing", answered in round 3 by drawing a camera *icon
        on the web button*. Snap, Surprise and Clear are objects on the table now — see
        `build.ts::buildControls` — and there is no DOM inside the play area at all.

        The keyboard and screen-reader path did not move: `hit.tsx` already publishes a real
        focusable, labelled button in `#lumident-a11y` for each of the ten accessories, and
        the three controls join the same mechanism in their own focus group. That is one
        accessibility path for the whole game rather than a 3D one and a parallel DOM one.
      */}
      <Booth engine={engine} />
    </GameShell>
  );
}
