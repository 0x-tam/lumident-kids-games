/**
 * Tiny module-level stores.
 *
 * Components rendered inside the R3F root do not share React context with the DOM tree,
 * and per-frame code must never trigger a React render. So every piece of state the 3D
 * layer needs lives here: readable synchronously from `useFrame`, subscribable from
 * React via `useSyncExternalStore` when a discrete change genuinely needs a re-render.
 */
import { useCallback, useSyncExternalStore } from "react";

export type Store<T> = {
  get: () => T;
  set: (next: T | ((prev: T) => T)) => void;
  subscribe: (fn: () => void) => () => void;
};

export function createStore<T>(initial: T): Store<T> {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set: (next) => {
      const v = typeof next === "function" ? (next as (p: T) => T)(value) : next;
      if (Object.is(v, value)) return;
      value = v;
      listeners.forEach((l) => l());
    },
    subscribe: (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}

export function useStore<T>(store: Store<T>): T {
  return useSyncExternalStore(
    useCallback((cb) => store.subscribe(cb), [store]),
    store.get,
    store.get
  );
}

/* ------------------------------------------------------------------ */
/* Reduced motion                                                      */
/* ------------------------------------------------------------------ */

const mql =
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)")
    : null;

export const reducedMotion = createStore<boolean>(mql?.matches ?? false);

if (mql) {
  const onChange = () => reducedMotion.set(mql.matches);
  if (typeof mql.addEventListener === "function") mql.addEventListener("change", onChange);
  else mql.addListener(onChange);
}

/** Synchronous read for per-frame code. Never call `useStore` in a hot path. */
export const isReduced = () => reducedMotion.get();

/* ------------------------------------------------------------------ */
/* Route: which 3D scene the single canvas is showing                  */
/* ------------------------------------------------------------------ */

export type Route = { screen: "hub" | "game"; gameId: string | null };

export const route = createStore<Route>({ screen: "hub", gameId: null });

/** 0 = fully hub, 1 = fully in a game. Driven by the transition, read per frame. */
export const transition = { value: 0, target: 0 };

/* ------------------------------------------------------------------ */
/* The celebration hand-off                                            */
/* ------------------------------------------------------------------ */

/**
 * How long a game's hero has to get off the stage, in seconds.
 *
 * Not a taste value: it is the length of the shared celebration's own wind-up. `celebrate.tsx`
 * spends 0.10 s on stillness and starts its mascot at 5% scale at 0.24 s, so a game hero that
 * is gone by 0.24 s is gone before the celebration's hero exists, and the frame never contains
 * two teeth. Under reduced motion the celebration reveals at t = 0 instead, so the window
 * shortens to a scale pop inside the spec's 150 ms ceiling.
 */
export const CELEBRATION_EXIT_SECONDS = 0.24;
export const CELEBRATION_EXIT_SECONDS_REDUCED = 0.12;

/**
 * Whether a run has finished and the shared 3D celebration owns the frame.
 *
 * A plain mutable record, like `transition` above and for the same reason: it is read inside
 * `useFrame`, once or twice per game, every frame of the hand-off. Subscribing to it would put
 * a React render on the hot path, and nothing in the DOM needs to re-render on it — `GameShell`
 * already owns `completed` as React state and is the only thing that writes here.
 *
 * ## What a game does with it
 *
 * `GameShell` renders the celebration into its own `<View>` over the top of the game's scene,
 * and the game's scene **keeps rendering** — deliberately, so the room the child just played in
 * is still there behind the burst instead of a cream plate. That leaves the game's own hero
 * standing in the shot, interpenetrating the celebration's mascot. Round 2 photographed the
 * result in every game: `healthy-or-not` showed one disembodied eye and two floating cheeks,
 * `count-the-teeth` five rooted teeth at once, `spot-the-difference` the hero wedged into the
 * 14 px gap between its picture frames.
 *
 * So every game's scene takes its hero off the stage, in one line, inside the `useFrame` it
 * already has:
 *
 * ```ts
 * // once per frame, after the hero's own transform is composed
 * const exit = celebrationHeroScale();
 * hero.scale.set(sx * exit, sy * exit, sz * exit);
 * ```
 *
 * `celebrationHeroScale()` is 1 for the whole run, then eases to exactly 0 across
 * `CELEBRATION_EXIT_SECONDS` and stays there until the next restart. Multiplying rather than
 * setting `visible = false` is the point: `tooth-runner` already solved this locally — the
 * runner takes its bow and *pops out*, arriving at zero on the frame the celebration arms —
 * and a prop that vanishes between two frames reads as a bug where one that is yanked away
 * reads as a hand-off. The curve is the same `easeInCubic` removal it uses: barely moving at
 * first, gone fast at the end.
 *
 * Use `isCelebrating()` for anything that is a *state* rather than a transform — stopping a
 * spawner, freezing an engine, muting an idle loop. It is true from the frame the run
 * completes until the next restart.
 *
 * Nothing else may write here. `GameShell` sets it, clears it on restart, and clears it when
 * it unmounts (a child who leaves for the hub mid-celebration must not leave the flag set for
 * whatever they open next).
 */
export const celebration = {
  /** True from the frame the run completes until the next restart. */
  active: false,
  /** Seconds since `active` turned true. Advanced by `GameShell`, never by a game. */
  elapsed: 0,
  /** 1 → 0 across the exit window. The number a game multiplies into its hero's scale. */
  heroScale: 1,
};

/** Synchronous read for per-frame code. Never call `useStore` in a hot path. */
export const isCelebrating = (): boolean => celebration.active;

/** 1 while the game owns the frame, easing to 0 as the shared celebration takes over. */
export const celebrationHeroScale = (): number => celebration.heroScale;

/**
 * `GameShell` only. Flipping the flag always restarts the window from a clean 1, so a
 * restart during the hand-off cannot leave a game's hero stuck at a fraction of its size.
 */
export function setCelebrating(active: boolean): void {
  celebration.active = active;
  celebration.elapsed = 0;
  celebration.heroScale = 1;
}

/* ------------------------------------------------------------------ */
/* Debug flags (query string, dev only)                                */
/* ------------------------------------------------------------------ */

const params = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;

export const FLAGS = {
  selftest: params?.get("selftest") ?? null,
  perf: params?.has("perf") ?? false,
  /** Force a quality tier for testing: ?tier=low|mid|high */
  tier: params?.get("tier") ?? null,
  /** Force the reduced-motion path for testing: ?reduced=1 */
  reduced: params?.get("reduced") === "1",
} as const;

if (FLAGS.reduced) reducedMotion.set(true);
