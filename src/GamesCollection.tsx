/**
 * The hub, and the hub ⇄ game scene swap.
 *
 * The screen a child comes back to between five or six short games, so it is built to be
 * calm and to be instant: no game chunk is loaded to draw it, its 3D is three instanced
 * draw calls plus nine small props, and nothing on it moves unless a finger or a Tab key
 * asks it to.
 *
 * ## How the cards work
 *
 * Each card is a real, transparent `<button>` in DOM order — that is what carries the
 * accessible name, the keyboard focus and the click. Behind it, in the app's single WebGL
 * canvas, stands a clay slab measured to the same rect. The DOM is the source of truth for
 * layout; `measureHub` converts it to world space on mount, on resize and when the webfont
 * lands, and drei's `<View>` re-reads the tracked grid rect every frame — so scrolling can
 * never desync the two, and no per-frame measurement is needed to keep them together.
 *
 * Cards sit at `z-index: 1` deliberately: `Scene3D` portals a pointer-accepting view layer
 * into the grid at `z-index: 0`, and a card left in the default layer would be painted over
 * by it and lose every tap.
 *
 * ## How entering a game works
 *
 * Opening a game is a scene swap, not a page load and not a modal. `AnimatePresence` in
 * `mode="wait"` guarantees the two never render at once — which also guarantees the canvas
 * never has to composite two `<View>`s that share one depth buffer:
 *
 *   1. The tapped slab dives at the camera with a wind-up while its neighbours step back
 *      and the hub's text fades (~260 ms).
 *   2. The hub unmounts at the moment the slab is biggest, and the game panel springs open
 *      *from the tapped card's screen rect* (~300 ms). The game's own `<Scene3D>` tracks
 *      the growing panel, so its scene grows with it rather than cutting in.
 *
 * Escape and the back control reverse it, mid-run, with no confirmation and no penalty.
 * Under `prefers-reduced-motion` both directions collapse to a 150 ms cross-fade with a
 * static camera and no dive.
 */
import {
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AnimatePresence, motion } from "framer-motion";
import { GAMES, type GameEntry } from "./games";
import { HubScene, type HubSceneCard } from "./hub/HubScene";
import {
  HUB_CAMERA_POSITION,
  HUB_CAMERA_TARGET,
  HUB_FOV,
  HubEngine,
  measureHub,
} from "./hub/engine";
import { sounds } from "./shared/audio";
import { usePlayer } from "./shared/player";
import { getBest } from "./shared/storage";
import { SCORING } from "./shared/scoring";
import { BackIcon, SwitchIcon, TrophyIcon, SparkleIcon } from "./shared/icons";
import { Scene3D } from "./three/Scene3D";
import { announce } from "./three/hit";
import { FLAGS, reducedMotion, useStore } from "./three/store";
import { markSceneEnter, markSceneExit } from "./dev/perf";

const HUB_CARDS: HubSceneCard[] = GAMES.map((g) => ({ id: g.id, accent: g.accent }));

/**
 * Prefetch, extended past the JS chunk (A13).
 *
 * `game.prefetch()` resolves the module and nothing else, so everything a game *builds* on
 * entry — including `textures.ts`'s CPU noise, a 256² lattice at four fbm octaves, roughly
 * 262 000 evaluations — still ran inside the frame the child was looking at.
 *
 * `Stage` warms the same assets 120 ms after boot, which covers the common case. This covers
 * the uncommon one: a child who reaches a card before that timer fires, or a boot where the
 * canvas was created late. Both call the same memoised builders, so whichever runs second is
 * a `Map` lookup.
 *
 * What is *not* warmed here, deliberately: shaders. `warmScene()` needs a scene, and a
 * game's scene is built by React on mount — it does not exist while its chunk is downloading.
 * Compiling a stand-in scene would produce programs keyed on a different lighting and shadow
 * permutation than the real one, i.e. a second live program per material, which is precisely
 * the defect `smile-maker`'s render-target warm-up was filed for (SM4). The compile is
 * measured instead: `compile:<scene>#<pass>` on `window.__perf.snapshot().events`.
 */
const warmSharedAssets = (): void => {
  void import("./three/textures").then(({ sparkleTexture, radialShadowTexture, grainTexture }) => {
    sparkleTexture();
    radialShadowTexture({ size: 256, softness: 0.42 });
    grainTexture();
  });
};

/** See the guard inside `?selftest=memory`. Module scope so a remount cannot clear it. */
let memoryTestRan = false;

const prefetchGame = (game: GameEntry): void => {
  game.prefetch();
  warmSharedAssets();
};

/**
 * Long enough for the dive to read, short enough that the whole hub → game move lands
 * inside the 450–600 ms the spec allows: 200 ms of dive, then ~400 ms of the panel opening
 * out of the card, overlapping at the moment the slab is biggest.
 */
const DIVE_S = 0.2;
const REDUCED_FADE = 0.15;
/** Matches the panel's own `max-w-[860px]`; used to predict its rect before it exists. */
const PANEL_MAX_WIDTH = 860;

/** ~400 ms with a whisper of overshoot: the §5 transition feel, never a linear tween. */
const PANEL_SPRING = {
  type: "spring",
  stiffness: 260,
  damping: 28,
  opacity: { duration: 0.18 },
} as const;

type Flip = { x: number; y: number; scale: number };

/**
 * The transform that maps the game panel onto the card that opened it.
 *
 * The panel's rect is *predicted* rather than measured, because it does not exist yet when
 * the child lifts their finger. Predicting it keeps the whole flip in the same render as
 * the mount, which is what stops the panel flashing at full size for one frame before the
 * animation takes hold.
 */
function flipFrom(card: DOMRect | null): Flip | null {
  if (!card || typeof window === "undefined") return null;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const width = Math.min(PANEL_MAX_WIDTH, vw);
  if (width < 1 || vh < 1) return null;
  return {
    x: card.left + card.width * 0.5 - vw * 0.5,
    y: card.top + card.height * 0.5 - vh * 0.5,
    scale: Math.max(0.24, Math.min(1, card.width / width)),
  };
}

export default function GamesCollection() {
  const { player, setPlayer } = usePlayer();
  const [active, setActive] = useState<GameEntry | null>(null);
  const [flip, setFlip] = useState<Flip | null>(null);
  const reduced = useStore(reducedMotion);

  const engineRef = useRef<HubEngine | null>(null);
  if (!engineRef.current) engineRef.current = new HubEngine(GAMES.length);
  const engine = engineRef.current;

  const gridRef = useRef<HTMLDivElement>(null);
  const cardRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const slotRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const activeRef = useRef<GameEntry | null>(null);
  const visitedRef = useRef(false);
  const backRef = useRef<HTMLButtonElement>(null);
  /** Which card opened the current game, so focus can go home when it closes. */
  const returnIndexRef = useRef<number | null>(null);

  /** Discrete, layout-driven values the 3D scene needs as React props. */
  const [layout, setLayout] = useState({ aspect: 2.1, shadowArea: 12 });

  /* ---------------- measurement ---------------- */

  useLayoutEffect(() => {
    if (active) return;
    const grid = gridRef.current;
    if (!grid) return;
    let cancelled = false;

    const remeasure = () => {
      if (cancelled || !gridRef.current) return;
      const aspect = measureHub(engine, gridRef.current, cardRefs.current, slotRefs.current);
      if (aspect <= 0) return;
      const shadowArea = engine.shadowArea;
      setLayout((prev) =>
        prev.aspect === aspect && prev.shadowArea === shadowArea ? prev : { aspect, shadowArea }
      );
    };

    remeasure();

    const ro = new ResizeObserver(remeasure);
    ro.observe(grid);
    for (const el of cardRefs.current) if (el) ro.observe(el);
    window.addEventListener("resize", remeasure);
    window.addEventListener("orientationchange", remeasure);
    // Card heights change the moment Manrope replaces the fallback face.
    document.fonts?.ready.then(remeasure).catch(() => {});

    return () => {
      cancelled = true;
      ro.disconnect();
      window.removeEventListener("resize", remeasure);
      window.removeEventListener("orientationchange", remeasure);
    };
  }, [active, engine]);

  /** Restart the slabs' arrival every time the hub comes back on screen. */
  useLayoutEffect(() => {
    if (!active) engine.begin(visitedRef.current);
  }, [active, engine]);

  /**
   * A finger that lifts off the card, off the page or onto another window must not leave a
   * slab held down. R3F is not involved here — these are plain DOM buttons.
   */
  useEffect(() => {
    const release = () => {
      for (let i = 0; i < GAMES.length; i++) engine.setHeld(i, false);
    };
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
      window.removeEventListener("blur", release);
    };
  }, [engine]);

  /* ---------------- entering / leaving ---------------- */

  const open = useCallback(
    /*
      `el` is nullable so the route can be driven without a pointer: `?selftest=memory`
      enters and leaves every game twice against the *running page*, which is the only way to
      assert `3D-SPEC §5` on the thing a child actually uses rather than on a simulation of
      the cache builders. With no card element there is simply no flip to solve from, and
      `flipFrom(null)` already returns null, which is the reduced-motion entry.
    */
    (game: GameEntry, index: number, el: HTMLElement | null) => {
      if (activeRef.current) return;
      sounds.pop();
      setFlip(flipFrom(el ? el.getBoundingClientRect() : null));
      engine.select(index);
      markSceneEnter(game.id);
      announce(`Opening ${game.title}`);
      // Where a keyboard child comes back to. `AnimatePresence mode="wait"` unmounts the
      // hub, so the focused card ceases to exist and focus falls to <body>; without this
      // they would have to Tab from the top of the document after every single game.
      returnIndexRef.current = index;
      activeRef.current = game;
      setActive(game);
    },
    [engine]
  );

  const close = useCallback(() => {
    const current = activeRef.current;
    if (!current) return;
    activeRef.current = null;
    visitedRef.current = true;
    markSceneExit(current.id);
    announce("Back to all games");
    setActive(null);
  }, []);

  /**
   * Focus lands inside the panel as soon as it opens — on the one control that is on
   * screen and means something before the game has finished springing open.
   */
  useEffect(() => {
    if (!active) return;
    const raf = requestAnimationFrame(() => backRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [active]);

  /**
   * ...and back onto the card that opened the game when it closes. `mode="wait"` means the
   * hub does not exist until the panel's exit finishes, so this has to wait for
   * `onExitComplete` rather than run in an effect on `active`.
   */
  const restoreHubFocus = useCallback(() => {
    if (activeRef.current) return;
    const index = returnIndexRef.current;
    returnIndexRef.current = null;
    if (index === null) return;
    requestAnimationFrame(() => cardRefs.current[index]?.focus());
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  /**
   * The hub is the one screen with no `GameShell` on it, so it has to register the two DOM
   * chrome audits itself — otherwise the header, the player pill and the nine cards are the
   * only controls in the product that nothing measures.
   */
  useEffect(() => {
    if (FLAGS.selftest === null) return;
    let cancelled = false;
    void import("./dev/chrome-audit").then(({ registerChromeSelfTests }) => {
      if (!cancelled) registerChromeSelfTests();
    });
    return () => {
      cancelled = true;
    };
  }, []);

  /* ---------------- ?selftest=memory — §5, against the running page ---------------- */

  /**
   * ## Why this had to live here, and why it had to be the real app (A6)
   *
   * Round 3 closed the memory item with a **headless simulation of the cache builders**. It
   * ran, it passed, and the real app still ended two full nine-game loops at +4 geometries,
   * +3 textures, +7 programs and ~25 MB of heap. The simulation could not have found the
   * residue because the residue is not in a cache — every `<id>-memory-after.json` reports
   * `cacheDelta` zero on every registered cache — and because a drei `<View>`'s portal scene
   * is not reachable from any traversal a harness outside React can start.
   *
   * So the assertion is made from inside the running page, driving the same `open`/`close`
   * a child's finger drives, with the same React tree, the same `<View>`s and the same
   * `flushSceneEviction()` on the same unmount.
   *
   * ## What it asserts, and why *that* is the right question
   *
   * Not "does the first visit return to baseline". It cannot, and demanding that would be
   * wrong rather than strict: `sparkleTexture()` is asked for by seven games and the shared
   * celebration and by nothing on the hub, `hit.tsx`'s ring geometry and the celebration
   * burst are built on first use, and all of them are `markShared` — created once, correctly
   * kept for the life of the tab, and landing *after* the hub baseline was taken. The
   * evidence says exactly this: `endurance.json` **plateaus**. Nine games × two loops is
   * eighteen entries; a per-entry leak of one to three geometries would read +18 to +54, and
   * what is measured is +4. Bounded at four across eighteen entries is one-time shared
   * allocation, not a leak. (`Stage.tsx` now warms the ones it can before the baseline, which
   * removes most of that four; this asserts the part that must be zero regardless.)
   *
   * What must be exactly zero is the **steady state**: visiting the same game twice must cost
   * nothing the second time. That is the guarantee `§5` is actually for — "a child bounces
   * between all nine games in one sitting" — and the plateau proves it is achievable.
   *
   * Three assertions per game, all after the reclaim has been forced:
   *   1. second visit minus first visit is 0 geometries, 0 textures, 0 programs;
   *   2. `outsideCaches.geometries === 0` on the leave path — nothing the eviction machinery
   *      cannot reach;
   *   3. no surviving resource is owned by a scene that has been left — and when one is, it
   *      is **named**, with its construction site, by the census in `dispose.ts`.
   *
   * Run it with `?selftest=memory`. It drives eighteen scene entries, so it is deliberately
   * not part of the default sweep.
   */
  const openById = useCallback(
    (id: string) => {
      const index = GAMES.findIndex((g) => g.id === id);
      if (index < 0) return;
      open(GAMES[index], index, cardRefs.current[index]);
    },
    [open]
  );

  useEffect(() => {
    if (FLAGS.selftest === null || !FLAGS.selftest.includes("memory")) return;
    let cancelled = false;

    void import("./dev/selftest").then(({ registerSelfTest }) => {
      if (cancelled) return;
      registerSelfTest("memory", async () => {
        /*
          Once per page load, and the guard is load-bearing rather than tidy.
          `registerSelfTest` re-arms the auto-run debounce every time a test registers, and
          every `GameShell` this test mounts registers three of its own — including
          `scene-memory`, whose name matches the `memory` filter. Without this the run would
          re-trigger itself after finishing and drive another eighteen scene entries, for
          ever. Reload to run it again.
        */
        if (memoryTestRan) {
          return {
            name: "memory",
            pass: true,
            detail: "already run in this page load — reload to re-drive the eighteen entries",
          };
        }
        memoryTestRan = true;

        const perf = window.__perf;
        if (!perf?.installed) {
          return { name: "memory", pass: false, detail: "window.__perf is not installed" };
        }

        /*
          Frames, with a wall-clock escape hatch. Under `?drive=1` rAF is a queue the harness
          drains, and a hidden tab never fires it at all; a test that could hang forever in
          either case is a test nobody will run.
        */
        const settle = (n: number) =>
          new Promise<void>((resolve) => {
            let seen = 0;
            const timeout = window.setTimeout(resolve, 200 + n * 40);
            const step = () => {
              if (cancelled || ++seen >= n) {
                window.clearTimeout(timeout);
                resolve();
                return;
              }
              requestAnimationFrame(step);
            };
            requestAnimationFrame(step);
          });

        /** Long enough for the panel spring, the view mount and the first draws. */
        const ENTER_FRAMES = 42;
        /** Long enough for the exit spring, the unmount and `flushSceneEviction`. */
        const EXIT_FRAMES = 30;

        const visit = async (id: string) => {
          openById(id);
          await settle(ENTER_FRAMES);
          close();
          await settle(EXIT_FRAMES);
          // Forces any outstanding reclaim before reading, so the number is never a
          // mid-transition one.
          return perf.memory();
        };

        close();
        await settle(EXIT_FRAMES);

        const problems: string[] = [];
        const rows: {
          game: string;
          geometries: number;
          textures: number;
          programs: number;
          outsideCacheGeometries: number;
          survivors: string[];
        }[] = [];

        for (const game of GAMES) {
          if (cancelled) break;
          const first = await visit(game.id);
          // Baseline *after* the first visit: one-time shared allocation is now in it, so
          // what follows measures the steady state and nothing else.
          perf.memoryBaseline();
          const second = await visit(game.id);
          const drift = perf.memoryDrift();
          if (first === null || second === null || drift === null) {
            problems.push(`${game.id}: no memory reading`);
            continue;
          }
          const d = drift.delta;
          const survivors = drift.residue.survivors.map(
            (r) => `${r.kind} ${r.type} owned by ${r.owner} at ${r.site}`
          );
          rows.push({
            game: game.id,
            geometries: d.geometries,
            textures: d.textures,
            programs: d.programs,
            outsideCacheGeometries: drift.outsideCaches.geometries,
            survivors,
          });
          if (d.geometries !== 0 || d.textures !== 0 || d.programs !== 0) {
            problems.push(
              `${game.id}: a repeat visit cost +${d.geometries} geometries, ` +
                `+${d.textures} textures, +${d.programs} programs — the steady state is not flat`
            );
          }
          if (drift.outsideCaches.geometries !== 0) {
            problems.push(
              `${game.id}: ${drift.outsideCaches.geometries} geometries outside every ` +
                "registered cache, which no eviction can reach"
            );
          }
          if (survivors.length > 0) {
            problems.push(`${game.id}: ${survivors.length} resources survive it — ${survivors.join("; ")}`);
          }
        }

        return {
          name: "memory",
          pass: problems.length === 0,
          detail:
            problems.length === 0
              ? `${rows.length} games entered and left twice each; every repeat visit was ` +
                "delta-zero and nothing survives outside a registered cache"
              : problems.join(" | "),
          data: { rows, censusOn: perf.residue().length > 0 },
        };
      });
    });

    return () => {
      cancelled = true;
    };
  }, [openById, close]);

  useEffect(() => {
    document.body.style.overflow = active ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [active]);

  /* ---------------- transitions ---------------- */

  /**
   * The hub simply fades; the *motion* during those 260 ms is the slab diving at the camera
   * in 3D, which is where a child's eye already is.
   */
  const hubExitTransition = useMemo(
    () => ({ duration: reduced ? REDUCED_FADE : DIVE_S, ease: "easeOut" as const }),
    [reduced]
  );

  const panelInitial = useMemo(
    () =>
      reduced || !flip
        ? { opacity: 0, x: 0, y: 0, scale: 1 }
        : { opacity: 0.15, x: flip.x, y: flip.y, scale: flip.scale },
    [reduced, flip]
  );

  /** Springs going in, a snappier spring coming back out — never a linear tween either way. */
  const panelExit = useMemo(
    () =>
      reduced || !flip
        ? {
            opacity: 0,
            x: 0,
            y: 0,
            scale: 1,
            transition: { duration: REDUCED_FADE, ease: "easeOut" as const },
          }
        : {
            opacity: 0,
            x: flip.x,
            y: flip.y,
            scale: flip.scale,
            transition: {
              type: "spring" as const,
              stiffness: 340,
              damping: 34,
              opacity: { duration: 0.24 },
            },
          },
    [reduced, flip]
  );

  /* ---------------- render ---------------- */

  return (
    <div className="min-h-dvh">
      <AnimatePresence mode="wait" initial={false} onExitComplete={restoreHubFocus}>
        {active ? (
          <motion.div
            key={active.id}
            initial={panelInitial}
            animate={{ opacity: 1, x: 0, y: 0, scale: 1 }}
            exit={panelExit}
            transition={
              reduced ? { duration: REDUCED_FADE, ease: "easeOut" as const } : PANEL_SPRING
            }
            style={{ transformOrigin: "50% 50%" }}
            /*
              `h-dvh`, never `min-h-dvh`. GameShell's root is `h-full`, and a percentage
              height cannot resolve against a min-height: it computes to `auto`, the flex
              body collapses to its content, and the whole 3D play area lands in a 162 px
              letterbox strip inside the header band. GameShell asserts against this in dev
              and registers a `shell-play-area` selftest, so it cannot come back quietly.
            */
            className="mx-auto flex h-dvh w-full max-w-[860px] flex-col px-4 pb-5 pt-4"
          >
            <div className="mb-3 flex shrink-0 justify-start">
              <button
                ref={backRef}
                type="button"
                onClick={close}
                aria-label="Back to all games"
                className="clay-btn inline-flex items-center gap-2 rounded-full py-3 pl-4 pr-[22px] text-base"
              >
                <BackIcon className="h-[18px] w-[18px]" /> All games
              </button>
            </div>
            <div className="min-h-0 flex-1">
              <Suspense fallback={<ChunkShimmer title={active.title} reduced={reduced} />}>
                <active.Component />
              </Suspense>
            </div>
          </motion.div>
        ) : (
          <motion.div
            key="hub"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={hubExitTransition}
          >
            <header className="sticky top-0 z-40 px-4 pt-3.5">
              {/*
                A clay rail lying on the table, not a pane of frosted glass over it.

                It used to be `backdrop-blur-[10px]` over a translucent `#FCF8F1` ramp: a
                material that exists nowhere in this world, brighter than any lit surface in
                it, and — because the header is sticky over the card grid — literally a
                blurred window held above the 3D. The ramp below is `.clay-btn`'s, inside the
                page's own value range, and the shadow falls down *and to the right* like
                everything else the key touches. Opaque, so nothing behind it needs blurring.
              */}
              <div
                className="mx-auto flex max-w-[1080px] items-center justify-between gap-3 rounded-[26px] py-2.5 pl-[18px] pr-3.5"
                style={{
                  background: "linear-gradient(158deg, #f6f0e3, #e9e1d1)",
                  boxShadow:
                    "inset 2px 3px 5px rgba(255,253,246,0.85), inset -3px -6px 10px rgba(94,74,54,0.1), 8px 16px 30px -20px rgba(94,74,54,0.45)",
                }}
              >
                <div className="flex items-center gap-2.5">
                  <img src="/brand/baby-tooth.webp" alt="" className="h-[44px] w-[44px]" />
                  <span className="font-display text-[22px] font-extrabold">
                    Lumident <span className="text-red-deep">Kids</span>
                  </span>
                </div>

                {player && (
                  <button
                    type="button"
                    onClick={() => setPlayer(null)}
                    aria-label={`Playing as ${player.name}, age ${player.age}. Switch player`}
                    className="clay-btn flex items-center gap-2.5 rounded-full py-1.5 pl-[7px] pr-4"
                  >
                    {/*
                      The player initial, on the same ramp as `.grad-red` rather than on a
                      private copy of it.

                      It used to hard-code `#F04B52 → #C9212B` with `color: white` — 3.60:1
                      at the light stop, at 18 px/800, against the 4.5:1 AA floor. Reading
                      `--g-from` / `--g-to` / `--g-ink` off the `grad-red` class means this
                      is covered by `?selftest=chrome-contrast` along with every button, and
                      cannot drift away from the family again.
                    */}
                    <span
                      aria-hidden
                      className="grad-red grid h-[38px] w-[38px] place-items-center rounded-full font-display text-lg font-extrabold"
                      style={{
                        color: "var(--g-ink)",
                        background: "linear-gradient(145deg, var(--g-from), var(--g-to))",
                        boxShadow:
                          "inset 2px 2px 4px rgba(255,255,255,0.4), inset -2px -4px 7px var(--g-inset)",
                      }}
                    >
                      {player.name.charAt(0).toUpperCase()}
                    </span>
                    <span className="text-left leading-[1.15]">
                      <span className="block font-display text-[14.5px] font-semibold">
                        {player.name}
                      </span>
                      <span className="block whitespace-nowrap text-[11.5px] font-bold text-ink-soft">
                        Age {player.age}
                      </span>
                    </span>
                    <SwitchIcon className="h-[15px] w-[15px] text-ink-soft" />
                  </button>
                )}
              </div>
            </header>

            <main className="mx-auto max-w-[1080px] px-5 pb-14">
              <div className="mt-10">
                <h1 className="text-[clamp(28px,4vw,38px)] font-semibold tracking-[-0.01em]">
                  Hi {player?.name ?? "there"}, pick a game
                </h1>
                {/*
                  Not "can you beat your best score?".

                  It asked a first-time child to beat a score they do not have, and it framed
                  the hub as a competition in a product whose §1.1 premise is that a child
                  cannot lose. The half that carried information — that every game has three
                  levels — stays; the challenge is replaced by an instruction a three-year-old
                  can follow.
                */}
                <p className="mt-1.5 text-[17px] font-semibold text-ink-soft">
                  Three levels each. Pick one and play.
                </p>
              </div>

              {/*
                The tracked rect. The nine slabs render into exactly this box, so the grid
                carries no background of its own — anything opaque here would paint over the
                canvas, which lives behind the whole DOM tree.

                It bleeds 14 px past the cards on every side: `padding + equal negative
                margin` grows the *border* box — which is what drei tracks and what
                `measureHub` maps into world space — while leaving the content box, the
                column widths and every card rect exactly where they were. Without it the
                scissor rectangle lands on the outermost cards' own edges and slices their
                props in half (the Healthy-or-Not apple was cut clean through, cream against
                #d72e2f, with no shadow and no falloff). The margin arithmetic keeps the
                28 px gap under the heading and the 52 px gap above the footer unchanged.
              */}
              <div
                ref={gridRef}
                className="relative mt-[14px] -mx-[14px] -mb-[14px] grid gap-5 p-[14px]"
                style={{ gridTemplateColumns: "repeat(auto-fill, minmax(290px, 1fr))" }}
              >
                {/*
                  The fogged edge of the hub's own `<View>`, the same one every play area
                  carries. The 14 px bleed above stops the scissor landing on the outermost
                  cards' edges; this stops the boundary being a *rectangle* at all — a slab's
                  drop shadow or a prop that reaches it dissolves into the page instead of
                  ending on a razor line.

                  First in DOM order on purpose: it is a `z-[1]` sibling of the cards, which
                  are also `z-[1]`, so every card's label paints over it while the view layer
                  at `z-0` stays underneath. Its 30 px reach is inside each card's own 18 px
                  padding plus the 14 px bleed, so no text is ever touched.
                */}
                <div
                  aria-hidden
                  className="world-edge pointer-events-none absolute inset-0 z-[1]"
                />

                {GAMES.map((game, i) => {
                  const best = player ? getBest(player.name, game.id) : null;
                  const meta = SCORING[game.id];
                  return (
                    <button
                      key={game.id}
                      ref={(node) => {
                        cardRefs.current[i] = node;
                      }}
                      type="button"
                      onPointerEnter={() => {
                        prefetchGame(game);
                        engine.setHover(i, true);
                      }}
                      onPointerLeave={() => engine.setHover(i, false)}
                      onPointerDown={() => {
                        prefetchGame(game);
                        engine.setHeld(i, true);
                      }}
                      onPointerUp={() => engine.setHeld(i, false)}
                      onFocus={() => {
                        prefetchGame(game);
                        engine.setFocus(i, true);
                      }}
                      onBlur={() => engine.setFocus(i, false)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") engine.setHeld(i, true);
                      }}
                      onKeyUp={() => engine.setHeld(i, false)}
                      onClick={(e) => open(game, i, e.currentTarget)}
                      // The focus ring is drawn twice on purpose: a real DOM outline for
                      // anyone using a screen magnifier or a high-contrast mode, matched to
                      // the slab's own 30px bevel, and the accent halo that grows out from
                      // behind the slab in 3D.
                      className="relative z-[1] flex cursor-pointer items-center gap-[18px] rounded-[30px] border-none bg-transparent p-[18px] text-left focus-visible:rounded-[30px] focus-visible:outline-offset-[7px]"
                      style={CARD_BOX}
                    >
                      {/*
                        The room the 3D prop stands in. It is measured, not assumed, so the
                        clay object and the text can never drift apart on a reflow.
                      */}
                      <span
                        ref={(node) => {
                          slotRefs.current[i] = node;
                        }}
                        aria-hidden
                        className="block h-[88px] w-[88px] shrink-0"
                      />
                      <span className="min-w-0">
                        <span className="block font-display text-[19px] font-semibold leading-[1.2]">
                          {game.title}
                        </span>
                        <span className="mt-[3px] block text-[13.5px] font-semibold leading-[1.35] text-ink-mid">
                          {game.subtitle}
                        </span>
                        <span className="mt-[9px] flex items-center gap-1.5 font-display text-[13.5px] font-medium text-ink-mid">
                          {meta ? (
                            <>
                              <TrophyIcon className="h-[15px] w-[15px] text-peach-deep" />
                              {best !== null ? `${best.toLocaleString()} pts` : "No best yet"}
                            </>
                          ) : (
                            <>
                              <SparkleIcon className="h-[15px] w-[15px] text-mauve-main" />
                              Just for fun
                            </>
                          )}
                        </span>
                      </span>
                    </button>
                  );
                })}

                <Scene3D
                  track={gridRef}
                  camera={{
                    position: HUB_CAMERA_POSITION,
                    target: HUB_CAMERA_TARGET,
                    fov: HUB_FOV,
                  }}
                >
                  <HubScene
                    engine={engine}
                    cards={HUB_CARDS}
                    aspect={layout.aspect}
                    shadowArea={layout.shadowArea}
                  />
                </Scene3D>
              </div>

              <footer className="mt-[52px] text-center text-[13.5px] font-semibold text-ink-soft">
                Lumident Pediatric
              </footer>
            </main>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Chrome                                                              */
/* ------------------------------------------------------------------ */

/**
 * The card is a hit area and a label, nothing more: the clay it appears to be made of is
 * the 3D slab standing behind it. A CSS surface here would be a second, slightly-wrong copy
 * of the same object — the exact "fake depth pasted over real depth" the spec forbids, and
 * a press would then animate twice, in two different physics.
 */
const CARD_BOX: React.CSSProperties = { minHeight: 128 };

/**
 * The Suspense fallback while a game chunk lands.
 *
 * Calm and branded rather than a spinner on white: the shape is already the shape and
 * colour of the prop the game is about to show. On a warm cache it is never seen at all —
 * the hub prefetches on hover, focus and pointerdown.
 */
function ChunkShimmer({ title, reduced }: { title: string; reduced: boolean }) {
  return (
    <div
      className="relative flex h-full flex-col items-center justify-center gap-5 rounded-[36px]"
      role="status"
      aria-live="polite"
    >
      <motion.span
        aria-hidden
        className="block h-[86px] w-[86px] rounded-[30px]"
        style={{
          background: "linear-gradient(158deg, #FBF6EC, #E9E1D0)",
          boxShadow:
            "inset 3px 4px 7px rgba(255,255,255,0.9), inset -4px -7px 12px rgba(94,74,54,0.08)",
        }}
        animate={reduced ? undefined : { opacity: [0.6, 1, 0.6], scale: [0.97, 1, 0.97] }}
        transition={{ duration: 1.6, repeat: Infinity, times: [0, 0.45, 1] }}
      />
      <span className="font-display text-[17px] font-semibold text-ink-soft">
        Getting {title} ready…
      </span>
    </div>
  );
}
