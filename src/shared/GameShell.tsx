/**
 * The frame all nine games live in.
 *
 * Its public props are frozen — nine games are written against them — but everything below
 * the surface belongs to the 3D world rather than to a web page:
 *
 *  - **The play area is the whole shell.** `GameAreaContext` hands `<Scene3D>` the full
 *    interior rect, so the scene's cream ground runs *under* the title, the chips and the
 *    level selector instead of stopping at a panel edge below them — a header bar sitting
 *    on top of a rectangle of 3D is exactly the "web page floating over a scene" look the
 *    spec rules out. Each game reserves the chrome band in its own camera solve (see any
 *    `layout.ts`), so no clay prop is ever solved under a chip; the measured band is
 *    published on the play area as `--chrome-h` *and* as its `padding-top`, so a game's own
 *    `ResizeObserver` is woken when the band reflows instead of keeping a stale reservation.
 *  - **The rect's edge is fogged, never cut.** `.world-edge` runs a feather in `NEUTRAL.page`
 *    around the play area and around the celebration, so a prop that reaches the boundary
 *    fades into the table instead of being guillotined by a scissor rectangle.
 *  - **Nothing here is opaque.** The single WebGL canvas is fixed behind the entire DOM
 *    tree at `z-index: 0`; any solid background in the shell would paint straight over the
 *    game. The shell's only paint is a low-alpha accent wash from the upper-left, which
 *    reads as the key light spilling onto the table rather than as a card.
 *  - **The chrome is lit like the scene.** Highlights top-left, occlusion bottom-right,
 *    cast shadows down *and to the right* — the same key direction as `KEY_LIGHT`.
 *  - **The celebration renders inside the game's own `<View>`.** Not beside it: a drei
 *    `<View>` is a whole `THREE.Scene` with its own camera and its own render call, so a
 *    celebration in a second view could not cast a shadow onto anything the game left
 *    standing, could not depth-test against it, and was lit by a second `<Rig>` at a
 *    different scale. It is handed to the game's view through `three/view-slot.tsx`; the
 *    shell keeps only the DOM half — the `role="dialog"`, the fogged edge and the copy —
 *    which cross-fades in on the frame the burst first reaches the screen. While it is up
 *    the play area, the hidden a11y layer and the chrome are `inert`.
 *  - **And the game gets out of its way.** `completed` raises the `celebration` flag in
 *    `three/store.ts`; each game's scene reads `celebrationHeroScale()` inside its own
 *    `useFrame` and pops its hero out over the hand-off window, so the celebration frame
 *    never contains two teeth.
 *
 * Layering rules a game must respect (unchanged from `Scene3D`'s contract): the view layer
 * sits at `z-index: 0` inside the play area and accepts pointers, so any DOM a game overlays
 * on its scene must sit at `z-index: 1` or above or it will be both invisible and unclickable.
 */
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { useFrame } from "@react-three/fiber";
import { sounds, toggleMuted, useMuted } from "./audio";
import { usePlayer } from "./player";
import { LEVEL_LABELS, SCORING } from "./scoring";
import { submitScore } from "./storage";
import {
  ClockIcon,
  RestartIcon,
  SoundOffIcon,
  SoundOnIcon,
  StarIcon,
  TrophyIcon,
} from "./icons";
import { GameAreaContext } from "../three/Scene3D";
import { Celebration } from "../three/celebrate";
import { CELEBRATION_COPY_BAND, setViewSlot } from "../three/view-slot";
import { announce } from "../three/hit";
import { cacheOwnership, sceneCacheSizes } from "../three/dispose";
import { ACCENTS, NEUTRAL, type AccentFamily } from "../three/tokens";
import { easeInCubic, safeDelta } from "../three/anim";
import {
  CELEBRATION_EXIT_SECONDS,
  CELEBRATION_EXIT_SECONDS_REDUCED,
  FLAGS,
  celebration,
  isReduced,
  setCelebrating,
} from "../three/store";

type Accent = AccentFamily;

export type GameHud = {
  levels?: { value: number; onChange: (level: number) => void; labels?: string[] };
  /** Formatted time, e.g. "0:42" (count-up) or "0:12" (countdown). */
  time?: string;
  /** Live score shown while playing. */
  score?: number;
};

export type GameShellProps = {
  gameId: string;
  title: string;
  subtitle: string;
  accent?: Accent;
  completed: boolean;
  /** Final score for this run — submitted when `completed` turns true. */
  score?: number;
  hud?: GameHud;
  completedMessage?: string;
  onRestart: () => void;
  children: ReactNode;
};

/* ------------------------------------------------------------------ */
/* Accent treatments                                                   */
/* ------------------------------------------------------------------ */

/** rgba() string from a brand hex, so the wash can be authored at a real alpha. */
const rgba = (hex: string, alpha: number) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
};

const GRADS: Record<Accent, string> = {
  red: "grad-red",
  coral: "grad-coral",
  peach: "grad-peach",
  rose: "grad-rose",
  mauve: "grad-mauve",
};

/**
 * Coloured light, not a coloured panel.
 *
 * The wash falls from the upper-left corner exactly where `KEY_LIGHT` sits, and fades to
 * fully transparent well before the middle of the frame — so it tints the 3D scene the way
 * a gelled bounce card would, and never turns the play area into a rectangle.
 */
const accentWash = (family: Accent): React.CSSProperties => ({
  background: `radial-gradient(135% 115% at 6% -12%, ${rgba(
    ACCENTS[family].main,
    0.11
  )}, ${rgba(ACCENTS[family].soft, 0.07)} 42%, rgba(237,231,220,0) 74%)`,
});

/* ------------------------------------------------------------------ */
/* The celebration's copy fog                                          */
/* ------------------------------------------------------------------ */

/**
 * Opaque under the copy, fogged out above it. The percentages are of the *band*, not of the
 * frame, and the band is painted as a background rather than sized as a box so that a long
 * headline on a short viewport overflows upward out of the fog instead of being squeezed by
 * it — exactly how `.world-edge` paints its own feather.
 *
 * The fog is `NEUTRAL.page`: the exact value `clayGround` is calibrated to render back at, so
 * it reads as the table continuing toward the viewer rather than as a scrim laid over the
 * world. It replaced a `rgba(240,234,223,0.97)` gradient that covered the bottom **58%** of
 * the frame — a cream veil over the majority of the most important shot in the product.
 *
 * `CELEBRATION_COPY_BAND` lives in `three/view-slot.tsx` because `celebrate.tsx` reads it
 * too: the burst has to fit itself above this band inside the *game's* camera now that it
 * renders in the game's own view.
 */
const COPY_FOG: React.CSSProperties = {
  backgroundImage: `linear-gradient(to top, ${NEUTRAL.page} 0%, ${NEUTRAL.page} 60%, ${rgba(
    NEUTRAL.page,
    0
  )} 100%)`,
  backgroundRepeat: "no-repeat",
  backgroundSize: `100% ${CELEBRATION_COPY_BAND * 100}%`,
  backgroundPosition: "bottom",
};

/* ------------------------------------------------------------------ */
/* Celebration, inside the game's own view                             */
/* ------------------------------------------------------------------ */

/**
 * The `useFrame` priority at which the game's view has already drawn.
 *
 * drei's `<View>` subscribes at its own `index`, and `Scene3D` defaults a game's view to
 * index 1, so a callback at 2 runs after that view's `gl.render()` for the frame. This is
 * the one thing `CELEBRATION_VIEW_INDEX + 1` used to buy us, and it survives the move into
 * the game's view unchanged.
 */
const CELEBRATION_DRAWN_PRIORITY = 2;

/**
 * Runs before every game's own `useFrame` (they subscribe at priority 0), so a game reads a
 * value that was advanced this frame rather than last one.
 */
const CELEBRATION_CLOCK_PRIORITY = -1;

/**
 * Advances the hand-off window in `store.ts` while the celebration is up.
 *
 * It lives here rather than in `celebrate.tsx` because the flag's lifetime is the *shell's*
 * `completed`, not the burst's timeline: a game's hero has to stay gone after `onDone` fires
 * and the burst has finished, right up until the child presses Play again.
 *
 * Mutates a module record, allocates nothing, and never causes a React render.
 */
function CelebrationClock(): null {
  useFrame((_state, rawDt) => {
    if (!celebration.active) return;
    celebration.elapsed += safeDelta(rawDt);
    // Read fresh every frame, like every other reduced-motion branch in the product.
    const span = isReduced() ? CELEBRATION_EXIT_SECONDS_REDUCED : CELEBRATION_EXIT_SECONDS;
    celebration.heroScale = 1 - easeInCubic(celebration.elapsed / span);
  }, CELEBRATION_CLOCK_PRIORITY);
  return null;
}

/**
 * Fires once, on the first frame *after* the view holding the celebration has drawn.
 *
 * The DOM copy is gated on this, which is the difference between "the child wins and the
 * panel goes blank" and a cross-fade over a world that never stopped rendering.
 */
function CelebrationRendered({ onRendered }: { onRendered: () => void }) {
  const fired = useRef(false);
  useFrame(() => {
    if (fired.current) return;
    fired.current = true;
    onRendered();
  }, CELEBRATION_DRAWN_PRIORITY);
  return null;
}

type Result = { value: number; best: number; isNew: boolean };

/* ------------------------------------------------------------------ */
/* Dev guard: the play area must be a play area                        */
/* ------------------------------------------------------------------ */

/**
 * The shell collapsed to 162 px for an entire release because a percentage height cannot
 * resolve against a `min-height` parent, and nothing in the product noticed. Nothing
 * silently notices twice: this measures the real, untransformed play box.
 *
 * `offsetHeight`, never `getBoundingClientRect()` — the shell is CSS-scaled while the
 * hub → game flip plays, and a transformed rect reports a quarter of the truth.
 */
const MIN_PLAY_PX = 400;
/** Chrome + the panel's own padding + the "All games" row, on the tightest layout. */
const CHROME_ALLOWANCE_PX = 300;

const requiredPlayHeight = (viewportH: number) =>
  Math.min(MIN_PLAY_PX, Math.max(0, viewportH - CHROME_ALLOWANCE_PX));

/* ------------------------------------------------------------------ */
/* GameShell                                                           */
/* ------------------------------------------------------------------ */

export default function GameShell({
  gameId,
  title,
  subtitle,
  accent = "red",
  completed,
  score,
  hud,
  completedMessage,
  onRestart,
  children,
}: GameShellProps) {
  const muted = useMuted();
  const { player } = usePlayer();
  const [result, setResult] = useState<Result | null>(null);

  /** Handed to `Scene3D` through `GameAreaContext` — this is the rect the game renders into. */
  const areaRef = useRef<HTMLDivElement>(null);
  const chromeRef = useRef<HTMLDivElement>(null);
  const a11yHostRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const headlineRef = useRef<HTMLHeadingElement>(null);
  const restartRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const submittedRef = useRef(false);
  const livingRef = useRef(true);
  const meta = SCORING[gameId];
  const titleId = useId();

  /** Set on the frame the 3D celebration first reaches the framebuffer. */
  const [celebrationDrawn, setCelebrationDrawn] = useState(false);
  const onCelebrationRendered = useCallback(() => setCelebrationDrawn(true), []);

  /*
   * Declared before anything that reads it: effect cleanups run in declaration order, so
   * this flips before the celebration's focus-restore cleanup can fire and fight the hub
   * for focus when the child leaves mid-celebration.
   */
  useEffect(() => {
    livingRef.current = true;
    return () => {
      livingRef.current = false;
      // A child who leaves for the hub mid-celebration must not leave the flag set for
      // whatever they open next — the store outlives this component.
      setCelebrating(false);
    };
  }, []);

  /**
   * Safety net for the cross-fade. If the celebration view never gets a frame — a lost
   * context, a tab that was backgrounded at the moment of the win — the child must still
   * be told they won and still be able to press Play again. The gate is a *nicety*; being
   * able to finish a run is not.
   */
  useEffect(() => {
    if (!completed || celebrationDrawn) return;
    const t = window.setTimeout(() => setCelebrationDrawn(true), 900);
    return () => window.clearTimeout(t);
  }, [completed, celebrationDrawn]);

  /* ---------------- the hidden a11y layer belongs in here ---------------- */

  /**
   * `hit.tsx` lazily appends `#lumident-a11y` to `document.body`, which puts every 3D tap
   * target *after* the whole app in reading order: a screen-reader child heard the back
   * button, the mute button, the level pills and the game's own DOM before reaching the
   * thing they came to touch. The layer is a zero-size fixed box, so it can be adopted
   * anywhere; adopting it here, above the chrome, makes the board the first thing in the
   * game. It goes back to `body` on the way out so the hub keeps a working layer and
   * `hit.tsx`'s `isConnected` caches stay valid.
   */
  useLayoutEffect(() => {
    const host = a11yHostRef.current;
    if (!host || typeof document === "undefined") return;
    let observer: MutationObserver | null = null;

    const adopt = () => {
      const layer = document.getElementById("lumident-a11y");
      if (!layer) return false;
      if (layer.parentElement !== host) host.appendChild(layer);
      return true;
    };

    // The layer is created on the first `HitTarget`/`useFocusGroup` render, which for a
    // view-portalled scene can be a tick after the shell mounts.
    if (!adopt()) {
      observer = new MutationObserver(() => {
        if (adopt()) {
          observer?.disconnect();
          observer = null;
        }
      });
      observer.observe(document.body, { childList: true });
    }

    return () => {
      observer?.disconnect();
      const layer = document.getElementById("lumident-a11y");
      if (layer && layer.parentElement === host) document.body.appendChild(layer);
    };
  }, []);

  /**
   * The chrome band: measured, published, and — this is the part that was missing — made to
   * *wake the observers that read it*.
   *
   * The band's height is not a constant. It grows when Manrope replaces the fallback face,
   * when a game's HUD row appears, and when the level pills and the chip group wrap onto two
   * lines on a phone. All of that was already measured here. What was broken is the other
   * half of the loop:
   *
   *   - the play area is `absolute inset-0`, so **its box never changes when only the band
   *     does**;
   *   - every game solves its camera inside a `ResizeObserver(playArea)`;
   *   - a `ResizeObserver` fires on a *box* change, so eight of the nine games never
   *     re-read `--chrome-h` after their first measure. (Only `count-the-teeth` escaped, by
   *     additionally observing the spacer — and its comment says exactly why.)
   *   - worse, that first measure is *guaranteed* stale: React runs a child's layout effect
   *     before its parent's, so every game measured the band before this component had
   *     measured it and fell back to its own `CHROME_PX` guess.
   *
   * The fix is to publish the band as the play area's `padding-top` instead of as a spacer
   * element. A `ResizeObserver` reports the **content box** by default, so the play area's
   * observed box now shrinks by exactly the band — which wakes all nine games with no edit
   * to any of them — while `offsetHeight` / `getBoundingClientRect()`, which is what the
   * games actually measure the shell with, still reports the full shell. Absolutely
   * positioned children (`Scene3D`'s view layer, `.world-edge`) resolve `inset: 0` against
   * the padding box, so the 3D still fills the whole shell edge to edge.
   *
   * Written straight to the DOM rather than through React state: it is a layout fact, not
   * app state, and routing it through a render meant re-rendering the entire game subtree
   * on every reflow of a title.
   *
   * `offsetHeight`, not `getBoundingClientRect`: the shell is CSS-scaled while the hub →
   * game transition plays, and a transformed rect would report a band a third of its size.
   */
  /**
   * ## …and why a scalar was not enough (A9)
   *
   * `--chrome-h` is a single top inset. It is correct about *height* — `offsetHeight`
   * includes a chip row that has wrapped onto a second line — and it says nothing about
   * **where across the width** the chrome actually is. Every game's `cameraFor` therefore
   * treats the whole band as forbidden and everything below it as free, which is wrong in
   * both directions: it wastes the strip of table beside a short title, and, worse, it has
   * no way to express "the timer chip is at the right-hand end of a row that is otherwise
   * empty". The photographed consequences: Sliding Puzzle's `0:00` and `★ 0` drawn on top of
   * the reference plaque with the timer squarely over the tooth's face; Healthy or Not's
   * timer on the mascot's left eye; Tooth Rescue's timer clipping the mascot's head into a
   * one-eyed character.
   *
   * So the band is published as a **rect** as well as a height, in play-area pixels:
   *
   *   `--chrome-h`       unchanged, and deliberately still `chrome.offsetHeight` — nine games
   *                      solve against it and shrinking it by even the row's bottom padding
   *                      would let props creep under the chips.
   *   `--chrome-top`     top of the occupied box.
   *   `--chrome-bottom`  bottom of the occupied box (<= `--chrome-h`).
   *   `--chrome-left`    left edge of the leftmost control.
   *   `--chrome-right`   right edge of the rightmost control.
   *
   * The rect is the union of the real control clusters — the title block, the mute/restart
   * pair, the difficulty pills and the chip group — each marked `data-chrome-box`, not of
   * the full-width rows that contain them.
   *
   * **Contract for every `cameraFor`:** treat that rect as a keep-clear region, exactly as
   * `§2` already makes the celebration treat `CELEBRATION_COPY_BAND` — a hard floor on the
   * subject's screen-space top *within the rect's horizontal span*, rather than across the
   * whole frame. `--chrome-h` remains a valid conservative fallback for a game that has not
   * adopted the rect yet.
   *
   * Measured with `offsetTop`/`offsetLeft` walked up the `offsetParent` chain, never
   * `getBoundingClientRect()`: the shell is CSS-scaled while the hub → game flip plays, and
   * a transformed rect would report a band a third of its size.
   */
  useLayoutEffect(() => {
    const chrome = chromeRef.current;
    const area = areaRef.current;
    if (!chrome || !area) return;

    /**
     * Offset of `el` in the play area's own coordinate space, by walking `offsetParent`.
     *
     * The chrome is a *sibling* of the play area, not a descendant, so the walk terminates at
     * the shell root rather than at `area`. That is the same origin: `area` is
     * `absolute; inset: 0` with no border, so its padding box starts at the shell root's
     * (0, 0) — and a drei `<View>` portalled into it resolves *its* `inset: 0` against that
     * same padding box. So this rect, `--chrome-*`, and the `x`/`y` `hit.tsx` projects its
     * colliders into are all one coordinate system, which is what lets
     * `?selftest=chrome-keepclear` compare them directly.
     */
    const offsetIn = (el: HTMLElement, root: HTMLElement): { x: number; y: number } => {
      let x = 0;
      let y = 0;
      let node: HTMLElement | null = el;
      while (node !== null && node !== root) {
        x += node.offsetLeft;
        y += node.offsetTop;
        node = node.offsetParent as HTMLElement | null;
      }
      return { x, y };
    };

    let publishedHeight = -1;
    let publishedKey = "";

    const measure = () => {
      const height = chrome.offsetHeight;
      if (height !== publishedHeight) {
        publishedHeight = height;
        area.style.setProperty("--chrome-h", `${height}px`);
        area.style.paddingTop = `${height}px`;
      }

      const boxes = chrome.querySelectorAll<HTMLElement>("[data-chrome-box]");
      let left = Number.POSITIVE_INFINITY;
      let top = Number.POSITIVE_INFINITY;
      let right = Number.NEGATIVE_INFINITY;
      let bottom = Number.NEGATIVE_INFINITY;
      boxes.forEach((box) => {
        if (box.offsetWidth === 0 && box.offsetHeight === 0) return;
        const at = offsetIn(box, area);
        if (at.x < left) left = at.x;
        if (at.y < top) top = at.y;
        if (at.x + box.offsetWidth > right) right = at.x + box.offsetWidth;
        if (at.y + box.offsetHeight > bottom) bottom = at.y + box.offsetHeight;
      });
      // No measurable control (a HUD-less game before first layout): fall back to the band,
      // which is the conservative answer, never a zero rect that would read as "all clear".
      if (!Number.isFinite(left)) {
        left = 0;
        top = 0;
        right = area.offsetWidth;
        bottom = height;
      }
      const key = `${left}|${top}|${right}|${bottom}`;
      if (key === publishedKey) return;
      publishedKey = key;
      area.style.setProperty("--chrome-left", `${Math.round(left)}px`);
      area.style.setProperty("--chrome-top", `${Math.round(top)}px`);
      area.style.setProperty("--chrome-right", `${Math.round(right)}px`);
      area.style.setProperty("--chrome-bottom", `${Math.round(bottom)}px`);
    };

    // The container alone is not enough: a chip cluster that grows sideways without changing
    // the band's height never changes `chrome`'s box, and the rect would go stale. So a
    // control that mounts later — the HUD appears the first time a game reports a score —
    // has to be picked up after the fact.
    //
    // It must be armed EXACTLY ONCE per element. `observe()` on an already-observed target
    // is *not* a no-op: the spec has it re-deliver an initial notification. Re-arming from
    // inside the callback therefore re-notifies, which re-arms, which re-notifies — an
    // unbounded loop that starves the frame rather than throwing. It was measured at
    // 4.92M layout reads against 577 animation frames before the page stopped responding.
    const observed = new WeakSet<HTMLElement>();
    const ro = new ResizeObserver(() => {
      measure();
      arm();
    });
    const arm = () => {
      chrome.querySelectorAll<HTMLElement>("[data-chrome-box]").forEach((box) => {
        if (observed.has(box)) return;
        observed.add(box);
        ro.observe(box);
      });
    };
    // Deliberately *not* observing `area`: this callback writes `area.style.paddingTop`, and
    // an observer on the element it resizes is the classic "ResizeObserver loop completed
    // with undelivered notifications" console error. The chrome band is full-width, so a
    // change to the play area's width reaches this through `chrome` anyway.
    ro.observe(chrome);
    arm();
    measure();

    // …and a row that appears or disappears entirely is a childList change, not a resize.
    const mo = new MutationObserver(() => {
      measure();
      arm();
    });
    mo.observe(chrome, { childList: true, subtree: true });

    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  }, []);

  /* ---------------- dev guard + selftest for the play rect ---------------- */

  useLayoutEffect(() => {
    if (!import.meta.env.DEV) return;
    const el = areaRef.current;
    if (!el || typeof window === "undefined") return;
    const need = requiredPlayHeight(window.innerHeight);
    if (el.offsetHeight >= need) return;
    console.error(
      `[GameShell] play area is ${el.offsetHeight}px tall on a ${window.innerHeight}px viewport ` +
        `(needs >= ${need}px). The panel around GameShell has lost its definite height — ` +
        `check that it is 'h-dvh', not 'min-h-dvh': a percentage height cannot resolve ` +
        `against a min-height and collapses the whole 3D scene into a letterbox strip.`
    );
  });

  useEffect(() => {
    if (FLAGS.selftest === null) return;
    let cancelled = false;
    void import("../dev/chrome-audit").then(({ registerChromeSelfTests }) => {
      if (cancelled) return;
      // `chrome-contrast` and `dom-hit-targets` — the two DOM rules `hit-targets` cannot
      // see. Idempotent, so registering from every shell and from the hub is fine.
      registerChromeSelfTests();
    });
    void import("../dev/selftest").then(({ registerSelfTest }) => {
      if (cancelled) return;
      /*
       * The chrome band is what every game's camera solve reserves, and the band is now
       * published as the play area's `padding-top` (see the measurement effect above). This
       * asserts the two halves agree — a published `--chrome-h` that does not match the
       * chrome element's real height, or a play area whose content box has not shrunk by
       * it, is the exact failure that put HUD chips on top of 3D props in round 3.
       */
      /*
       * The one thing a browser can assert about `3D-SPEC` §5's memory rule from inside a
       * single screen.
       *
       * The full rule - "memory returns to the hub baseline after a nine-game loop" - needs
       * a capture that drives the route, so it cannot be a selftest. What *can* be asserted
       * here is the invariant the whole eviction machinery rests on, and the one that was
       * broken in round 3 (A1): the ownership window has to be open, and attributed to this
       * game, *before* the game's subtree renders and populates the shared caches. When it is
       * not, every entry is stamped `null`, `flushSceneEviction` reads that as the
       * genuinely-shared tier and skips it forever, and nothing any game allocates is ever
       * reclaimed - which is exactly how the round-3 endurance run ended with textures still
       * climbing after two full loops.
       *
       * `taggedUnowned` counts first-tags made with no scene live *since the last
       * `enterScene`*, so on a game screen it must be zero. `taggedOwned` is reported rather
       * than asserted: a repeat visit can legitimately hit only already-promoted shared
       * entries and tag nothing new, and a test that fails on that would be flaky.
       *
       * The text cache is checked at the same time because it is the other half of the same
       * failure (A2): it was the one resource cache that never called `registerSceneCache`,
       * so its entries were invisible to eviction whatever the ownership window did.
       */
      registerSelfTest("scene-memory", () => {
        const own = cacheOwnership();
        const caches = sceneCacheSizes();
        const problems: string[] = [];
        if (own.activeScene !== gameId) {
          problems.push(
            `the cache ownership window says the live scene is ` +
              `${own.activeScene === null ? "the hub (null)" : own.activeScene}, not ${gameId} ` +
              `- markSceneEnter must run before the game subtree renders`
          );
        }
        if (own.taggedUnowned > 0) {
          problems.push(
            `${own.taggedUnowned} cache entr${own.taggedUnowned === 1 ? "y was" : "ies were"} ` +
              `first tagged with no scene live, so ${own.taggedUnowned === 1 ? "it is" : "they are"} ` +
              `stamped shared and can never be evicted`
          );
        }
        if (!("text" in caches)) {
          problems.push("the text label cache is not registered as a SceneCache (A2)");
        }
        const detail =
          `${gameId}: owned ${own.taggedOwned}, unowned ${own.taggedUnowned}, ` +
          `caches ${JSON.stringify(caches)}`;
        return {
          name: "scene-memory",
          pass: problems.length === 0,
          detail: problems.length === 0 ? detail : `${problems.join("; ")} - ${detail}`,
        };
      });

      registerSelfTest("shell-chrome-band", () => {
        const area = areaRef.current;
        const chrome = chromeRef.current;
        if (!area || !chrome) {
          return { name: "shell-chrome-band", pass: false, detail: `${gameId}: shell not mounted` };
        }
        const real = chrome.offsetHeight;
        const declared = Number.parseFloat(
          window.getComputedStyle(area).getPropertyValue("--chrome-h")
        );
        const padding = Number.parseFloat(window.getComputedStyle(area).paddingTop);
        // `clientHeight` is the padding box; `clientHeight - padding` is the content box a
        // ResizeObserver on the play area reports, which is what wakes every game.
        const observed = area.clientHeight - padding;
        const pass =
          Number.isFinite(declared) &&
          Math.abs(declared - real) < 1 &&
          Math.abs(padding - real) < 1 &&
          observed > 0 &&
          Math.abs(area.offsetHeight - real - observed) < 1;
        return {
          name: "shell-chrome-band",
          pass,
          detail: `${gameId}: chrome ${real}px, --chrome-h ${declared}px, padding ${padding}px, observed content box ${observed}px of ${area.offsetHeight}px`,
          data: { gameId, real, declared, padding, observed, shell: area.offsetHeight },
        };
      });

      /*
       * `celebration-framing` — the check `3D-SPEC §2` names and the registry never had.
       *
       * It is exactly the test A10 needed. Three assertions, each against a defect that was
       * photographed rather than imagined:
       *
       *  (a) **The child's work is still on screen.** `celebrationHeroScale()` eases the
       *      game's stage out over the hand-off window, and in Sliding Puzzle that takes the
       *      tiles, the relief, the shadows, the socket *and the reference plaque* with it:
       *      the finished bear survives to f05 and by f06 the tray is empty — 62 arrow
       *      presses of work replaced by a dialog box. A blank frame is a frame with no draw
       *      calls in it, and `window.__perf.calls` is the whole frame's total across every
       *      view, so "the world went away" is a number this can read. It cannot tell a
       *      vanished *hero* from a vanished *board* — that distinction lives in each scene —
       *      but it makes "the celebration frame is empty" impossible to ship silently.
       *  (b) **Nothing hard-cornered is drawn on the hero moment.** The headline is the one
       *      element in the product that takes focus without being asked to, so its focus
       *      indicator is the one that can land on the board. Asserting a real corner radius
       *      on it keeps the fix from being undone by a future class-list edit.
       *  (c) **The copy band stays inside its declared share of the frame.** `celebrate.tsx`
       *      fits the burst above `CELEBRATION_COPY_BAND`; if the DOM copy grows past it the
       *      two disagree and clay ends up under fog.
       *
       * Static assertions run whether or not a run has finished; the dynamic ones report
       * "not celebrating" rather than passing, so a capture that forgot to drive to the win
       * cannot read as a clean bill.
       */
      registerSelfTest("celebration-framing", () => {
        const overlay = overlayRef.current;
        const headline = headlineRef.current;
        const problems: string[] = [];
        const notes: string[] = [];

        if (headline === null) {
          notes.push("headline not mounted (no celebration up) — corner radius not asserted");
        } else {
          const radius = Number.parseFloat(window.getComputedStyle(headline).borderTopLeftRadius);
          if (!(radius >= 16)) {
            problems.push(
              `the celebration headline's corner radius is ${radius}px, so its focus outline ` +
                `is a hard-cornered rectangle over the 3D board (3D-SPEC §0)`
            );
          }
        }

        const perf = typeof window !== "undefined" ? window.__perf : undefined;
        if (!completed) {
          notes.push("no run has finished — draw calls and copy band not asserted");
        } else {
          const calls = perf?.calls ?? -1;
          if (calls === 0) {
            problems.push(
              "the celebration frame drew nothing: the game's world was scaled or unmounted " +
                "out of the shot and the child's work is gone (A10a)"
            );
          } else if (calls < 0) {
            notes.push("window.__perf is not installed — draw calls not asserted");
          }
          if (overlay !== null && headline !== null) {
            /*
              The copy column is `absolute inset-0` and paints its fog as a background over
              the bottom `CELEBRATION_COPY_BAND` of itself, so its own box is the whole frame
              and says nothing. What matters is how far up the *copy* reaches: the headline is
              the topmost element in the column, and it is positioned inside a container that
              shares the overlay's origin, so its `offsetTop` is directly comparable.
            */
            const frame = Math.max(1, overlay.offsetHeight);
            const share = (frame - headline.offsetTop) / frame;
            if (share > CELEBRATION_COPY_BAND + 0.02) {
              problems.push(
                `the DOM copy reaches ${(share * 100).toFixed(0)}% up the frame against a ` +
                  `declared CELEBRATION_COPY_BAND of ${(CELEBRATION_COPY_BAND * 100).toFixed(0)}% — ` +
                  `celebrate.tsx fits the burst above the declared band, so clay is under fog`
              );
            }
          }
        }

        return {
          name: "celebration-framing",
          pass: problems.length === 0,
          detail:
            problems.length === 0
              ? `${gameId}: ${notes.length > 0 ? notes.join("; ") : "framing clear"}`
              : `${gameId}: ${problems.join("; ")}`,
          data: { gameId, completed, calls: perf?.calls ?? null, notes },
        };
      });

      /*
       * `chrome-keepclear` — the shared half of A9.
       *
       * The chrome's occupied rect is published on the play area (see the measurement effect
       * above); this asserts that nothing a child has to *touch* is underneath it. Every live
       * 3D collider is projected into view pixels by `hit.tsx`, so the check is exact rather
       * than a look at a screenshot: a target circle that intersects the chrome rect is a
       * target the HUD is sitting on.
       *
       * It deliberately says nothing about scenery. A prop under the title band is a framing
       * call each game's `cameraFor` makes; a *tap target* under the timer chip is a game a
       * child cannot play, and that is what this refuses to let ship.
       */
      registerSelfTest("chrome-keepclear", async () => {
        const { hitTargetProbes } = await import("../three/hit");
        const area = areaRef.current;
        if (!area) {
          return { name: "chrome-keepclear", pass: false, detail: `${gameId}: shell not mounted` };
        }
        const style = window.getComputedStyle(area);
        const num = (name: string) => Number.parseFloat(style.getPropertyValue(name));
        const rect = {
          left: num("--chrome-left"),
          top: num("--chrome-top"),
          right: num("--chrome-right"),
          bottom: num("--chrome-bottom"),
        };
        if (!Number.isFinite(rect.bottom)) {
          return {
            name: "chrome-keepclear",
            pass: false,
            detail: `${gameId}: the chrome rect was never published (--chrome-bottom is unset)`,
          };
        }
        const live = hitTargetProbes().filter((p) => p.measured && !p.disabled);
        const hits = live.filter(
          (p) =>
            p.x + p.r > rect.left &&
            p.x - p.r < rect.right &&
            p.y + p.r > rect.top &&
            p.y - p.r < rect.bottom
        );
        return {
          name: "chrome-keepclear",
          pass: hits.length === 0,
          detail:
            hits.length === 0
              ? `${gameId}: ${live.length} colliders, none under the chrome rect ` +
                `[${rect.left},${rect.top} → ${rect.right},${rect.bottom}]`
              : `${gameId}: ${hits.length} of ${live.length} tap targets are under the chrome — ` +
                hits.map((p) => `${p.label} at (${Math.round(p.x)},${Math.round(p.y)}) r${Math.round(p.r)}`).join(", "),
          data: { gameId, rect, targets: live.length, hits: hits.map((p) => p.label) },
        };
      });

      registerSelfTest("shell-play-area", () => {
        const el = areaRef.current;
        const viewportH = window.innerHeight;
        const height = el ? el.offsetHeight : 0;
        const width = el ? el.offsetWidth : 0;
        const need = requiredPlayHeight(viewportH);
        return {
          name: "shell-play-area",
          pass: height >= need && width > 0,
          detail: `${gameId}: play area ${width}×${height} on a ${viewportH}px viewport, needs >= ${need}px tall`,
          data: { gameId, width, height, viewportH, need },
        };
      });
    });
    return () => {
      cancelled = true;
    };
    // `completed` is in here because `celebration-framing` reads it: a registration made on
    // mount would close over `false` forever and could never see the frame it is about.
    // `registerSelfTest` is a `Map.set`, so re-registering replaces rather than accumulates.
  }, [gameId, completed]);

  /* ---------------- completion ---------------- */

  useEffect(() => {
    if (!completed) {
      submittedRef.current = false;
      setResult(null);
      setCelebrationDrawn(false);
      // Restart: the game owns its hero again, at full size, on the very next frame.
      setCelebrating(false);
      return;
    }
    if (submittedRef.current) return;
    submittedRef.current = true;
    // Read synchronously from `useFrame` by all nine scenes, which take their own hero off
    // the stage across the window this opens — see `store.ts::celebration`. Set before the
    // celebration view mounts, so the first frame of the hand-off is already counted.
    setCelebrating(true);
    sounds.success();

    const message = completedMessage ?? `Great job${player ? `, ${player.name}` : ""}!`;
    if (player && meta && typeof score === "number") {
      const { best, isNew } = submitScore(player.name, gameId, score, meta.better);
      setResult({ value: score, best, isNew });
      // `celebrate.tsx` deliberately never announces; the copy lives here, so the call does
      // too. Without it a screen-reader user hears a chime and nothing else.
      //
      // Says exactly what the plate says, for the same reason: "Your best is 300" after a
      // 0-point run is the did-worse comparison of §1.1, spoken instead of drawn. A run
      // that scored nothing is announced as a win and nothing else.
      //
      // **Assertive** (A17's contract on this call site). The completion line is the last
      // thing the game says and the only one a child is waiting for, and it arrives at the
      // end of a run — i.e. on top of whatever polite backlog the last few seconds of play
      // queued. Polite, it waits its turn behind that backlog: `hit.tsx` measured the Maze
      // completion landing 1960 ms late with seven stale lines still ahead of it. Assertive
      // drops the superseded polite backlog, keeps the newest line, and speaks now (60 ms).
      announce(
        score > 0
          ? `${message} ${score.toLocaleString()} points.${isNew ? " New best score!" : ""}`
          : message,
        { assertive: true }
      );
    } else {
      announce(message, { assertive: true });
    }
  }, [completed, player, meta, score, gameId, completedMessage]);

  /**
   * Everything outside the dialog stops existing for a pointer, a Tab key and a screen
   * reader alike. Without this, every hidden a11y button in the play area stayed focusable
   * *and still fired its handler* underneath a full-screen overlay.
   */
  useLayoutEffect(() => {
    const nodes = [areaRef.current, a11yHostRef.current, chromeRef.current];
    for (const node of nodes) {
      if (!node) continue;
      node.toggleAttribute("inert", completed);
      if (completed) node.setAttribute("aria-hidden", "true");
      else node.removeAttribute("aria-hidden");
    }
    return () => {
      for (const node of nodes) {
        if (!node) continue;
        node.removeAttribute("inert");
        node.removeAttribute("aria-hidden");
      }
    };
  }, [completed]);

  /** Focus into the dialog on open, and back to a real control on dismiss. */
  useEffect(() => {
    if (!completed) return;
    const previous = document.activeElement;
    returnFocusRef.current = previous instanceof HTMLElement ? previous : null;
    const raf = requestAnimationFrame(() => headlineRef.current?.focus());
    return () => {
      cancelAnimationFrame(raf);
      if (!livingRef.current) return;
      const prev = returnFocusRef.current;
      const inPlayArea = prev !== null && areaRef.current?.contains(prev) === true;
      const target = prev && prev.isConnected && !inPlayArea ? prev : restartRef.current;
      // After the layout effect above has lifted `inert` from the chrome.
      requestAnimationFrame(() => target?.focus());
    };
  }, [completed]);

  /** A modal traps Tab. The headline is `tabIndex -1`, so it is a target, not a stop. */
  const onDialogKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab") return;
    const root = overlayRef.current;
    if (!root) return;
    const items = root.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    if (items.length === 0) {
      event.preventDefault();
      return;
    }
    const index = Array.prototype.indexOf.call(items, document.activeElement);
    const last = items.length - 1;
    let next: number;
    if (index === -1) next = event.shiftKey ? last : 0;
    else if (event.shiftKey) next = index === 0 ? last : index - 1;
    else next = index === last ? 0 : index + 1;
    event.preventDefault();
    items[next].focus();
  }, []);

  /* ---------------- the celebration, inside the game's own view ---------------- */

  /**
   * The 3D half of the celebration, handed to the game's `<View>` through `view-slot.tsx`.
   *
   * It used to be a `<Scene3D>` of its own right here in the shell — its own drei `<View>`,
   * therefore its own `THREE.Scene`, its own camera and its own `<Rig>`. Two scenes cannot
   * share a shadow pass or a depth buffer, and the audit photographed all three consequences:
   * a podium that cast nothing onto the tray the child had just filled, a hero interpenetrating
   * props the game had left standing, and a second lighting rig at a different scale from the
   * first. Rendering it inside the game's view is the fix for the cause, not the symptoms.
   *
   * What that hands over, and what it takes back:
   *  - the camera is now the **game's** camera, so `<Celebration>` fits itself to whatever
   *    frustum it finds and keeps clear of `CELEBRATION_COPY_BAND`. The shell no longer
   *    solves a camera, because it no longer owns one.
   *  - `<Celebration>` must not mount a `<Rig>` or a camera of its own, and needs no depth
   *    reset: there is only one depth buffer now, and the game's own props are what it
   *    should be occluding against.
   *
   * Two objects only, rebuilt when the run ends and when it restarts — never per frame.
   */
  const celebrationSlot = useMemo(
    () =>
      completed ? (
        <>
          <CelebrationClock />
          <CelebrationRendered onRendered={onCelebrationRendered} />
          <Celebration active accent={accent} />
        </>
      ) : null,
    [completed, accent, onCelebrationRendered]
  );

  useLayoutEffect(() => {
    setViewSlot(celebrationSlot);
    return () => setViewSlot(null);
  }, [celebrationSlot]);

  const levelLabels = hud?.levels?.labels ?? LEVEL_LABELS;
  const headline = completedMessage ?? `Great job${player ? `, ${player.name}` : ""}!`;

  return (
    <div
      role="region"
      aria-labelledby={titleId}
      className="relative flex h-full flex-col overflow-hidden rounded-[36px]"
      style={accentWash(accent)}
    >
      {/*
        The hidden accessibility layer is adopted in here, before the chrome, so the 3D
        board is the first thing a keyboard or screen-reader child reaches inside the game.
        Zero-size: the layer's own children are `position: fixed` and clipped.
      */}
      <div ref={a11yHostRef} className="h-0 w-0" />

      {/*
        The play area: the full shell interior, and deliberately so. The scene's cream
        ground runs *under* the title and the chips and off all four sides, which is what
        stops the panel reading as a web page with a rectangle of 3D pasted into it — and
        it is the rect all nine games solve their framing against (each reserves the chrome
        band itself, see any game's `layout.ts`). `Scene3D` portals the view in here at
        z-index 0.

        Its `--chrome-h` and its `padding-top` are both written by the measurement effect
        above and are the same number: the property is what a game *reads*, the padding is
        what makes a game's `ResizeObserver` on this element *notice* when it changes. The
        padding is also what keeps a game's own DOM clear of the chrome — it replaced a
        spacer element, which did the second job and neither of the other two.
      */}
      <div ref={areaRef} className="absolute inset-0 flex flex-col">
        {/*
          A game's own DOM lays out here, clear of the chrome. The wrapper is deliberately
          left unpositioned: giving it a stacking context would lift it above the view layer
          and swallow every pointer event the 3D scene needs.
        */}
        <div className="flex min-h-0 flex-1 flex-col px-[18px] pb-[18px]">
          <GameAreaContext.Provider value={areaRef}>{children}</GameAreaContext.Provider>
        </div>
        {/*
          The fogged edge. A `<View>` is a scissor rectangle: without this, anything that
          reaches the boundary is cut with a razor edge halfway through an object and the
          child sees the rectangle instead of the world.
        */}
        <div aria-hidden className="world-edge pointer-events-none absolute inset-0 z-[1]" />
      </div>

      {/*
        Chrome. Over the play area but never over a prop — every game reserves this band in
        its own camera solve — with `pointer-events: none` on the layer and `auto` on the
        controls, so the strip of table the ground shows through is not a dead zone. It
        fades out of the way when the celebration takes the screen, so nothing DOM-shaped is
        left sitting on top of the hero tooth.
      */}
      <div
        ref={chromeRef}
        className="pointer-events-none relative z-10 shrink-0"
        style={{
          opacity: completed ? 0 : 1,
          transition: "opacity 260ms cubic-bezier(0.33, 1, 0.68, 1)",
        }}
      >
        <header className="flex items-start justify-between gap-3 px-6 pb-1.5 pt-6">
          {/*
            `min-w-0` is load-bearing at phone widths. A flex item defaults to
            `min-width: auto`, i.e. it refuses to shrink below its longest word — "Difference"
            sets a ~150 px floor at 27 px. The mute and restart buttons are `shrink-0` and
            50 px each, so on a narrow shell the title block wins the argument and pushes them
            past the shell's `overflow-hidden` edge. With `min-w-0` the title wraps instead,
            which grows the measured band rather than losing two controls.
          */}
          <div className="min-w-0" data-chrome-box>
            <h2 id={titleId} className="text-[27px] font-semibold leading-[1.15]">
              {title}
            </h2>
            <p className="mt-1 text-[15px] font-semibold text-ink-mid">{subtitle}</p>
          </div>
          <div className="pointer-events-auto flex shrink-0 gap-2.5" data-chrome-box>
            <button
              type="button"
              onClick={toggleMuted}
              aria-pressed={muted}
              aria-label={muted ? "Turn sound on" : "Turn sound off"}
              /*
                No `!` on the colour: Tailwind's utilities layer already outranks
                `.clay-btn`'s own `color`, and an `!important` here would beat the inline
                style below.
              */
              className="clay-btn grid h-[50px] w-[50px] place-items-center rounded-[18px] text-ink-mid"
              /*
                Sound starts off (see `audio.ts`), so this control has to say so at a
                glance. It says it in clay rather than in colour: while muted the button is
                a well pressed *into* the table instead of a slab standing on it — legible
                on every accent, unlike a tint (peach.deep measures 2.6:1 here), and it
                still carries ink-mid at 5.5:1.
              */
              style={
                muted
                  ? {
                      background: "rgba(226, 217, 201, 0.85)",
                      boxShadow:
                        "inset 4px 5px 8px rgba(94, 74, 54, 0.13), inset -2px -3px 6px rgba(255, 255, 255, 0.72)",
                    }
                  : undefined
              }
            >
              {muted ? <SoundOffIcon className="h-6 w-6" /> : <SoundOnIcon className="h-6 w-6" />}
            </button>
            <button
              ref={restartRef}
              type="button"
              onClick={onRestart}
              aria-label="Restart game"
              className="clay-btn grid h-[50px] w-[50px] place-items-center rounded-[18px] text-ink-mid"
            >
              <RestartIcon className="h-6 w-6" />
            </button>
          </div>
        </header>

        {hud && (
          <div className="flex flex-wrap items-center gap-2.5 px-6 pb-4 pt-2.5">
            {hud.levels && (
              <div
                role="radiogroup"
                aria-label="Difficulty level"
                className="clay-well pointer-events-auto flex gap-1 rounded-full p-[5px]"
                data-chrome-box
              >
                {levelLabels.map((label, i) => {
                  const activeLvl = hud.levels!.value === i;
                  /*
                    48 px in both axes, on **both** states.

                    These were `py-[9px] text-sm` — a 38 px computed box, measured at 35 px —
                    against the §1.5 / §8 floor of 48. The `clay-well` around them reached 48
                    through its own `p-[5px]`; the three things a three-year-old actually has
                    to hit did not. The active pill inherits the floor from `.grad-btn`; the
                    inactive ones are bare `<button>`s and have to say it themselves, which is
                    why the sizing lives in the shared half of the class list rather than in
                    the branch.

                    Growing the *padding* rather than the type keeps the pill's label at the
                    same 14 px it has always been.
                  */
                  const base =
                    "inline-flex min-h-[48px] min-w-[48px] items-center justify-center rounded-full px-[18px] text-sm";
                  return (
                    <button
                      key={label}
                      type="button"
                      role="radio"
                      aria-checked={activeLvl}
                      onClick={() => hud.levels!.onChange(i)}
                      className={
                        activeLvl
                          ? `grad-btn ${GRADS[accent]} ${base} !shadow-[inset_2px_2px_4px_rgba(255,255,255,0.5),inset_-2px_-4px_8px_var(--g-inset),5px_9px_15px_-9px_var(--g-glow)]`
                          : `${base} cursor-pointer border-none bg-transparent font-display font-semibold text-ink-mid`
                      }
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            )}
            <div className="ml-auto flex gap-2.5" data-chrome-box>
              {hud.time !== undefined && (
                <span className="clay-chip" aria-label={`Time ${hud.time}`}>
                  <ClockIcon
                    className="h-[17px] w-[17px]"
                    style={{ color: ACCENTS[accent].deep }}
                  />
                  {hud.time}
                </span>
              )}
              {hud.score !== undefined && (
                <span className="clay-chip" aria-label={`Score ${hud.score} points`}>
                  <StarIcon className="h-[17px] w-[17px] text-peach-deep" />
                  {hud.score.toLocaleString()}
                </span>
              )}
            </div>
          </div>
        )}
      </div>


      {completed && (
        <div
          ref={overlayRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={`${titleId}-win`}
          onKeyDown={onDialogKeyDown}
          className="absolute inset-0 z-20"
        >
          {/*
            No `<Scene3D>` here any more. The 3D celebration renders inside the *game's*
            view — see `celebrationSlot` above and `three/view-slot.tsx` — so it shares the
            game's scene, camera, depth buffer and lighting rig. This overlay is DOM only:
            the modal semantics, the fogged edge and the copy.

            The play area underneath keeps rendering, and is `inert`, so the burst plays over
            the world the child just finished rather than over a blank rectangle.
          */}

          {/*
            The same fogged edge every other 3D region in the product carries, so a confetti
            chip that reaches the boundary dissolves into the table instead of being sliced
            by the view's scissor rectangle.
          */}
          <div aria-hidden className="world-edge pointer-events-none absolute inset-0 z-[1]" />

          {/*
            The copy, standing in the table's own fog rather than under a scrim.

            The band is `CELEBRATION_COPY_BAND` of the frame. `celebrate.tsx` reads the same
            constant and fits the burst above it inside the game's camera, so no clay is ever
            veiled — the shell no longer solves a camera to guarantee that, because the
            celebration no longer has a camera of its own.
            The gradient is `NEUTRAL.page` — the value `clayGround` renders back at — so it
            reads as the table running on toward the viewer, which is what the fogged edge
            above and every play area in the product already do. Cross-faded in on the frame
            the burst first reaches the screen, never swapped in ahead of it.
          */}
          <div
            data-celebration-copy
            className="pointer-events-none absolute inset-0 z-[2] flex flex-col items-center justify-end gap-2.5 px-6 pb-8"
            style={{
              ...COPY_FOG,
              opacity: celebrationDrawn ? 1 : 0,
              transition: "opacity 280ms cubic-bezier(0.33, 1, 0.68, 1)",
            }}
          >
            {/*
              The headline takes programmatic focus when the run ends, and the browser draws
              the global `:focus-visible` indicator on it. `focus-visible:outline-none` was
              on this element and did nothing: the global rule in `index.css` was *unlayered*,
              which beats every Tailwind utility regardless of specificity, so what the child
              actually got was a hard-cornered 3 px rectangle laid straight across the 3D
              board at the hero moment — photographed in `maze-escape-keyboard-end.png`,
              `tooth-rescue-keyboard-end.png`, `tooth-runner-keyboard-end.png` and
              `sliding-puzzle-celebration-f12.png` (A10b).

              The cascade bug is fixed at source (the rule now lives in `@layer base`). The
              indicator is kept rather than suppressed — focus moved without the child asking,
              and a keyboard user has to be able to see where — but it is given a box to
              follow: an outline traces its element's own `border-radius`, so at 26 px it is a
              soft capsule around the copy instead of a right angle over the mascot. `§0`'s
              "no hard edge anywhere" holds for the DOM too.

              The padding is what stops the capsule hugging the glyphs; the negative margin
              keeps the copy optically centred exactly where it was.
            */}
            <h3
              id={`${titleId}-win`}
              ref={headlineRef}
              tabIndex={-1}
              data-celebration-headline
              className="-mx-5 rounded-[26px] px-5 py-1 text-center text-[34px] font-semibold"
              style={{
                animation: "lumi-rise 0.4s ease-out 0.15s both",
                outlineOffset: "6px",
              }}
            >
              {headline}
            </h3>

            {/*
              A celebration never tells a child they did worse.

              This plate used to read "0 pts" beside "Best: 300" — reachable in four of the
              nine games — which is a direct did-worse comparison at the exact moment §1.1
              asks for celebration. Two rules, both here rather than in the scores themselves
              (the stored number is a fact; what we *show* is the product's voice):

                - the trophy pill appears only for a **new** best. There is no "Best: N" case
                  any more, so there is nothing to be measured against.
                - the plate itself only appears for a run that scored. A zero run gets the
                  headline, the confetti and "Play again", with no number at all.
            */}
            {result && meta && result.value > 0 && (
              <div
                /* `.clay-plate`, not a white card: same ramp, same key direction and same
                   value range as the chips and the table. See `index.css`. */
                className="clay-plate mt-1.5 flex items-center gap-3 rounded-[22px] px-[22px] py-3.5"
                style={{ animation: "lumi-rise 0.4s ease-out 0.28s both" }}
              >
                <StarIcon className="h-[26px] w-[26px] text-peach-deep" />
                <span className="font-display text-[25px] font-semibold tabular-nums">
                  {result.value.toLocaleString()}
                  <span className="ml-[5px] text-[15px] text-ink-soft">pts</span>
                </span>
                {result.isNew && (
                  <span
                    /*
                      A pebble of peach clay pressed onto the plate.

                      It used to be a `#FFD66B → #FFB84D` gold gradient with `#6B4A00` text —
                      three colours, none of which is `NEUTRAL.ink`, the page cream or one of
                      the five accent families `3D-SPEC §1.2` allows. The ramp below is
                      `ACCENTS.peach.soft` walked ±6% along the same clay curve as `.clay-btn`,
                      and the ink on it measures 11.1:1.
                    */
                    className="inline-flex items-center gap-1.5 rounded-full px-3.5 py-2 font-display text-[13.5px] font-semibold text-ink"
                    style={{
                      background: "linear-gradient(158deg, #fdf1e3, #eedec9)",
                      boxShadow:
                        "inset 2px 2px 4px rgba(255,253,246,0.85), inset -2px -3px 6px rgba(94,74,54,0.12)",
                    }}
                  >
                    <TrophyIcon className="h-[15px] w-[15px]" /> New best!
                  </span>
                )}
              </div>
            )}

            <button
              type="button"
              onClick={onRestart}
              className={`grad-btn ${GRADS[accent]} pointer-events-auto mt-3.5 rounded-full px-11 py-[17px] text-xl`}
              style={{ animation: "lumi-rise 0.4s ease-out 0.4s both" }}
            >
              Play again
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
