/**
 * Objective frame instrumentation — `window.__perf`.
 *
 * The perf critic has to measure, not squint, so this samples every frame and keeps a
 * rolling window. Two independent clocks are kept because they answer different
 * questions:
 *
 *  - The **rAF interval** says whether the app is *pacing*. It is vsync-bound, so a
 *    perfectly healthy 60Hz app sits at ~16.67ms and literally nothing else; the useful
 *    signal in it is not the mean but how often an interval is long enough to prove a
 *    vsync was missed.
 *  - The **time spent inside `renderer.render`** says how much *headroom* is left, which
 *    is the only number that predicts whether a mid-range Android tablet still holds 60
 *    when a desktop shows a flat 16.7ms.
 *
 * Sampling allocates nothing per frame: fixed Float64 ring buffers, a fixed pool of scene
 * marks, and exactly two closures created at install time. Everything that does allocate
 * (sorting for percentiles, building snapshot objects) runs only when something reads it.
 */
import type { Camera, Object3D, Scene, WebGLRenderer } from "three";
import {
  censusScene,
  enableResourceCensus,
  enterScene,
  exitScene,
  flushSceneEviction,
  memorySnapshot,
  pendingCacheScene,
  isResourceCensusOn,
  resourceCensus,
  resourceCensusByOwner,
  type MemorySnapshot,
  type ResourceRecord,
} from "../three/dispose";
import {
  BUDGETS,
  TIER_PROBE,
  displayPeriodMsOrNull,
  PERIOD_SAMPLES_NEEDED,
  periodSampleCount,
  quality,
  setPeriodSampling,
  type QualitySettings,
  type TierProbe,
} from "../three/quality";
import { FLAGS, route } from "../three/store";

/* ------------------------------------------------------------------ */
/* The clock                                                           */
/* ------------------------------------------------------------------ */

/**
 * **Captured before anything can patch it.** `src/dev/drive.ts` replaces
 * `performance.now` with a virtual clock that does not advance across a render call, so a
 * sampler that resolves `performance.now()` at call time measures a render as costing
 * exactly zero and a frame as costing exactly one virtual tick. Every timing number in the
 * round-2 audit was produced that way and is worthless.
 *
 * This binding is taken at module evaluation. `main.tsx` imports `App` — and therefore
 * `Stage` and this module — statically, and only then dynamically imports the driver, so
 * the real function is always the one captured here.
 */
export const realNow: () => number =
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now.bind(performance)
    : () => Date.now();

/** True while a harness owns `performance.now`. Set explicitly by `installDriver()`. */
let virtualClock = false;

/**
 * Declares that the rAF timestamp is virtual. Both clocks are then recorded: `avgMs` and
 * friends stay real wall-clock, `pacing*` reports the virtual cadence, and the budget
 * checks that only mean something against a real vsync are reported as *unmeasured*
 * rather than silently passing.
 */
export function setVirtualClock(on: boolean): void {
  if (virtualClock === on) return;
  virtualClock = on;
  // A synthetic cadence says nothing about the panel; stop teaching the shared estimator.
  setPeriodSampling(!on);
  resetPerf();
}

export const isVirtualClock = (): boolean => virtualClock;

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export type PerfMark = {
  name: string;
  phase: "enter" | "exit";
  /** Worst rAF interval observed inside the 1s window that follows the mark. */
  worstMs: number;
  /** Frames sampled inside that window. */
  frames: number;
  /** True while the window is still collecting. */
  open: boolean;
};

export type PerfViolation = {
  metric: string;
  value: number;
  budget: number;
  message: string;
};

/**
 * A budget check the current environment cannot decide, and *why* it cannot.
 *
 * The round-3 corpus is the argument for this type existing. `fps` read `9338.5` in a
 * `?drive=1` capture and `60.00` in every round-2 capture; both were artefacts of who was
 * calling `requestAnimationFrame`, and in neither case did the artefact look like one. An
 * instrument that cannot tell "fine" from "never sampled" is worse than no instrument, so
 * anything in here is reported as `null` in the snapshot rather than as a plausible number.
 */
export type Unmeasured = { metric: string; reason: string };

/** What the GPU timer query is doing, and if it is doing nothing, why. */
export type GpuTiming = {
  /** True only when `EXT_disjoint_timer_query_webgl2` is live and has returned results. */
  available: boolean;
  /** Human-readable reason when `available` is false. Empty when it is true. */
  reason: string;
  /** Mean GPU ms per frame over the resolved window, or null when unavailable. */
  avgMs: number | null;
  p95Ms: number | null;
  worstMs: number | null;
  /** Frames whose query actually resolved. Zero means "no evidence", never "cheap". */
  samples: number;
  /** Results thrown away because the driver reported `GPU_DISJOINT_EXT` (a context switch). */
  disjointDrops: number;
  /** Frames not timed because every query in the pool was still outstanding. */
  poolMisses: number;
};

/** One-shot measurement of something that happens once, not every frame. */
export type PerfEvent = {
  name: string;
  ms: number;
  /** Extra integer the event carries — for `compile:*`, the programs it created. */
  count: number;
  /** Real wall-clock ms since navigation start, so events can be ordered against marks. */
  at: number;
};

export type PerfSnapshot = {
  /**
   * Frames per second derived from the mean rAF interval, or **null** when the rAF cadence
   * is not the browser's own (a driver is pumping frames) or the tab was hidden while the
   * window filled. See `Unmeasured`.
   */
  fps: number | null;
  /** Mean rAF interval, ms. */
  avgMs: number;
  /** 95th percentile rAF interval, ms. */
  p95Ms: number;
  /** Longest rAF interval in the window, ms. */
  worstMs: number;
  /** Intervals longer than one 60Hz frame (16.7ms). Half of a healthy 60fps app's
   *  intervals land here by definition — read `droppedFrames` for actual hitches. */
  longFrames: number;
  longFrameRatio: number;
  /**
   * Intervals long enough to prove at least one vsync was missed (> 25ms). Null under the
   * same conditions as `fps`: a pumped or throttled frame source makes the interval mean
   * nothing about a missed vsync in either direction.
   */
  droppedFrames: number | null;
  droppedFrameRatio: number | null;
  /** Mean CPU ms spent inside `renderer.render` per frame, summed over all views. */
  renderAvgMs: number;
  /** 95th percentile of the same — the headroom number. */
  renderP95Ms: number;
  /**
   * Which clock produced `avgMs` / `p95Ms` / `worstMs` / `renderAvgMs` / `renderP95Ms`.
   * Always `"real"` — those are taken from the binding captured before any harness can
   * patch `performance.now`. `"virtual"` here means the *rAF cadence* was synthetic, so
   * `pacing*` and the checks named in `unmeasured` cannot be read as vsync evidence.
   */
  clock: "real" | "virtual";
  /** Mean rAF-timestamp interval. Equals `avgMs` unless a driver is pumping frames. */
  pacingAvgMs: number;
  pacingP95Ms: number;
  /** Budget checks the current environment cannot decide. Never silently passed. */
  unmeasured: Unmeasured[];
  /** Real GPU cost per frame, or an explicit statement that it could not be taken. */
  gpu: GpuTiming;
  /**
   * The display's own frame period, learned from the modal rAF interval, or null while it is
   * still being learned. Every dropped-frame and entry-hitch threshold in this file is a
   * multiple of it — see the note above `PERIOD_BIN_MS` (A12).
   */
  displayPeriodMs: number | null;
  /** The desktop -> tablet GPU projection, with its arithmetic spelled out (A7). */
  projection: GpuProjection;
  /** Live materials, summed from `programs[].usedTimes` — the §9 `materials` budget (A12c). */
  liveMaterials: number;
  /** True if `document.visibilityState` was "hidden" for any frame in the current window. */
  hiddenDuringWindow: boolean;
  /** Which tier this capture ran at, what the device would have probed into, and why. */
  tier: TierProbe;
  /** The settings that tier resolved to, including any runtime degrade. */
  quality: QualitySettings;
  /** One-shot measurements — currently `compile:<scene>`. */
  events: PerfEvent[];
  /**
   * Duplicate `markSceneEnter`/`markSceneExit` calls suppressed since the last reset.
   * `GamesCollection` owns the route and every game also marks its own mount, so this is
   * expected to be roughly one per scene change; a zero here on a run that changed scenes
   * would mean the dedupe is not firing.
   */
  duplicateMarksSuppressed: number;
  /** Marks lost to the ring buffer. Non-zero means `marks` is not the whole session. */
  marksOverwritten: number;
  /** Frames currently in the rolling window. */
  samples: number;
  /** Draw calls in the last sampled frame (all views combined). */
  calls: number;
  triangles: number;
  geometries: number;
  textures: number;
  programs: number;
  renderTargets: number;
  heapMB: number | null;
  screen: "hub" | "game";
  gameId: string | null;
  marks: PerfMark[];
  violations: PerfViolation[];
};

/** hub baseline vs. now, for the `3D-SPEC §5` return-to-baseline requirement. */
export type MemoryDrift = {
  baseline: MemorySnapshot;
  current: MemorySnapshot;
  delta: { geometries: number; textures: number; programs: number; heapMB: number | null };
  /** `renderer.info.programs.length` is allowed to drift by +/-2 shader variants. */
  withinSpec: boolean;
  /** Cache entries freed by the reclaim this call forced, if any were still pending. */
  reclaimed: number;
  /** Per registered cache: live entries now minus live entries at the hub baseline. */
  cacheDelta: Record<string, number>;
  /**
   * The part of the geometry/texture drift that is **not** in any registered cache.
   *
   * `delta.geometries` counts GPU uploads; `cacheDelta.geometry` counts cache entries. When
   * every cache has returned to its baseline size — which is the case the round-3 endurance
   * run actually measured — the difference is exactly the residue no eviction can ever
   * reach, because nothing owns it. When a cache has *not* returned, this is an upper bound
   * rather than an exact figure, since a cached entry is only counted by `renderer.info`
   * once something has drawn with it.
   */
  outsideCaches: { geometries: number; textures: number };
  /**
   * **The residue, by name** (A6).
   *
   * `outsideCaches` is where four rounds of audit stopped: a positive integer that no
   * eviction can reach and that nothing can describe. `byOwner` says which scene first
   * rendered each surviving geometry and texture, and `survivors` names the individual
   * resources a departed scene still owns — construction site, three type, and size — so a
   * "+3 geometries" reading is a list of three objects rather than an argument.
   *
   * `owner: null` in `survivors` means the resource was first seen at the hub: that is the
   * genuinely shared tier and surviving is correct. Anything with a *game id* as its owner,
   * after that game has been left and `flushSceneEviction()` has run, is a real leak with an
   * address. Empty when the census is off (`?perf` / `?selftest` turn it on).
   */
  residue: {
    byOwner: Record<string, { geometries: number; textures: number }>;
    /** Resources still alive that a *departed* scene owns. This list should be empty. */
    survivors: ResourceRecord[];
    /**
     * Shared-by-construction singletons that happened to be first drawn inside a game rather
     * than on the hub. Reported, never asserted — see the note at the construction site.
     */
    sharedFirstSeenInGame: ResourceRecord[];
    censusOn: boolean;
  };
};

/** One live compiled program, for diffing a baseline program list against a later one. */
export type ProgramRecord = {
  /** three's `shaderName` for the material that first asked for this permutation. */
  name: string;
  /** How many live materials still hold it. A program is released only at zero. */
  usedTimes: number;
  /** The full permutation string — what actually distinguishes one variant from another. */
  cacheKey: string;
};

export type PerfAPI = {
  readonly fps: number | null;
  readonly avgMs: number;
  readonly p95Ms: number;
  readonly worstMs: number;
  readonly longFrames: number;
  readonly longFrameRatio: number;
  readonly droppedFrames: number | null;
  readonly droppedFrameRatio: number | null;
  readonly renderAvgMs: number;
  readonly renderP95Ms: number;
  readonly samples: number;
  readonly calls: number;
  readonly triangles: number;
  readonly geometries: number;
  readonly textures: number;
  readonly programs: number;
  readonly marks: PerfMark[];
  readonly violations: PerfViolation[];
  readonly budgets: typeof BUDGETS;
  readonly installed: boolean;
  readonly clock: "real" | "virtual";
  readonly gpu: GpuTiming;
  readonly tier: TierProbe;
  /** The measured display period, or null while it is still being learned. */
  readonly displayPeriodMs: number | null;
  /** Live materials (sum of `programs[].usedTimes`), the quantity §9 budgets. */
  readonly liveMaterials: number;
  /** The desktop -> tablet GPU projection and the budget actually asserted. */
  projection(): GpuProjection;
  /**
   * Every geometry and texture the census still holds, with the scene that first rendered it
   * and where in the graph it was found. Empty unless `?perf` or `?selftest` is set.
   */
  residue(): ResourceRecord[];
  snapshot(): PerfSnapshot;
  /**
   * Every live compiled program with its three cache key and use count. `3D-SPEC §5` allows
   * a +/-2 program drift and the round-3 run measured +6 with no way to say which six; a
   * baseline list diffed against a later one names them.
   */
  programList(): ProgramRecord[];
  memory(): MemorySnapshot | null;
  /** Records the current reading as the hub baseline. Taken automatically on first entry. */
  memoryBaseline(): MemorySnapshot | null;
  /** Baseline vs. now, after forcing any outstanding scene-cache reclaim. */
  memoryDrift(): MemoryDrift | null;
  reset(): void;
};

declare global {
  interface Window {
    __perf?: PerfAPI;
  }
}

/* ------------------------------------------------------------------ */
/* Rolling windows                                                     */
/* ------------------------------------------------------------------ */

/** ~4 seconds at 60fps: long enough for a stable p95, short enough to react. */
const WINDOW = 240;

/** One 60Hz frame. Kept as the spec's literal long-frame threshold. */
const LONG_FRAME_MS = 16.7;
/** Longer than this is a tab suspension or a debugger pause, not a rendering problem. */
const SUSPEND_MS = 500;

/* ------------------------------------------------------------------ */
/* The display period — the thing every frame budget is actually in    */
/* ------------------------------------------------------------------ */

/**
 * ## Why a constant could not do this job (A12a, A12b)
 *
 * Two thresholds in this file used to be absolute milliseconds:
 *
 *  - a dropped frame was `> 25 ms`. On the 120 Hz display every round-4 capture was taken
 *    on, a dropped vsync is a **16.7 ms** interval, so the counter was blind to the exact
 *    event it counts. "0–1 dropped frames everywhere" was produced by an instrument that
 *    could not have reported otherwise; maze-escape's 13.0 ms worst frame is a missed vsync
 *    scored as clean.
 *  - the scene-entry hitch budget was `50 ms`, justified in-comment by a 30 Hz assumption.
 *    `3D-SPEC §9` says *one dropped frame* — 33 ms at 60 Hz, 16.7 ms on that display. Smile
 *    Maker's measured 17.7 ms entry passed a check 1.5–3× looser than the spec it claimed
 *    to enforce.
 *
 * Both are now derived from the display's own period, measured here. A dropped frame is
 * `> 1.5 × period` (the smallest interval that cannot be explained by jitter on an on-time
 * frame) and the entry-hitch budget is `2 × period` (one frame of work plus the one frame
 * §9 allows to be dropped).
 *
 * The estimator is the **mode**, not the mean or the median: a 60 Hz app that drops one
 * frame in three still has 16.67 ms as its most common interval, while its mean and its
 * median have both moved. Bins are 0.25 ms wide over 0–40 ms, which resolves 8.33 ms and
 * 16.67 ms unambiguously and costs one integer increment per frame with no allocation.
 *
 * Until enough intervals have been seen the period is `null` and **every check that depends
 * on it is reported as UNMEASURED rather than passed** — the rule this file already applies
 * to `fps` under a virtual clock.
 */
/*
 * The histogram itself lives in `src/three/quality.ts`.
 *
 * Round 4 built one here and one there, both fed once per frame, at different resolutions
 * and with different rules for "not learned yet". One physical quantity, two answers that
 * could disagree in the same session — and the degrade watchdog reads one while these
 * checks read the other. `quality.ts` now owns it at this file's resolution (0.25 ms bins)
 * and this file's honesty (`null` until learned); `Stage`'s per-frame `noteFramePeriod` is
 * the single feed, and `setVirtualClock` switches sampling off so a synthetic cadence never
 * teaches the estimator its own step size.
 */
export function displayPeriodMs(): number | null {
  const period = displayPeriodMsOrNull();
  return period === null ? null : round(period, 3);
}

/** An interval this long cannot be an on-time frame at the measured refresh rate. */
const droppedFrameMs = (): number | null => {
  const period = displayPeriodMs();
  return period === null ? null : period * 1.5;
};

/**
 * `3D-SPEC §9`: "scene entry hitch <= 1 dropped frame". One frame of work plus the one
 * dropped frame the spec allows — expressed in the period the display actually runs at.
 */
const entryHitchBudgetMs = (): number | null => {
  const period = displayPeriodMs();
  return period === null ? null : period * 2;
};

/** Real wall-clock interval between rAF callbacks. The number every budget is read from. */
const frameMs = new Float64Array(WINDOW);
/** The rAF timestamp interval — identical to `frameMs` unless a driver virtualises it. */
const pacingMs = new Float64Array(WINDOW);
const renderMs = new Float64Array(WINDOW);
const scratch = new Float64Array(WINDOW);

let write = 0;
let filled = 0;

/** Accumulates inside the wrapped `renderer.render`; flushed once per sampled frame. */
let renderAccum = 0;
let lastCalls = 0;
let lastTriangles = 0;

/* ------------------------------------------------------------------ */
/* GPU timing                                                          */
/* ------------------------------------------------------------------ */

/**
 * Real GPU cost per frame, via `EXT_disjoint_timer_query_webgl2`.
 *
 * Why this had to exist: nothing in the 416-file round-3 corpus reported a GPU timer query,
 * and the clay shader runs a 20-dependent-fetch PCSS filter per shadowed fragment on top of
 * `MeshPhysicalMaterial` + fbm normal + IBL + vertex AO. A mid-range tablet is fragment-bound
 * long before it is CPU-bound, so the entire cost that decides `3D-SPEC §4` was invisible.
 * `drive.ts` approximated it with a `gl.finish()` bracket over a *second, separate* 20-frame
 * pass, which measured a different scene state than the pass it was compared against and
 * produced the impossible result of a superset costing less than its subset.
 *
 * One query per frame, not per render call: the frame is bracketed by `FrameDriver` in
 * `Stage.tsx`, whose two `useFrame` subscribers sit at priority -1 and +10000 and therefore
 * straddle every drei `<View>` render. WebGL2 allows one `TIME_ELAPSED_EXT` query active at
 * a time, which this satisfies by construction.
 *
 * Zero allocation on a frame path: the query objects are a fixed pool created at install,
 * and `beginQuery`/`endQuery`/`getQueryParameter` return primitives.
 *
 * Results arrive a few frames late, so a slot stays `pending` until the driver says the
 * result is available. If every slot is outstanding the frame simply is not timed and
 * `poolMisses` records that — it is never guessed at.
 */
type TimerExt = { readonly TIME_ELAPSED_EXT: number; readonly GPU_DISJOINT_EXT: number };

/**
 * Eight frames of latency. Desktop drivers return a result within 1-3 frames; this is
 * generous enough that `poolMisses` stays at zero in practice and small enough that eight
 * outstanding queries is a trivial driver-side cost.
 */
const GPU_POOL = 8;

type GpuSlot = { query: WebGLQuery; pending: boolean };

let gl2: WebGL2RenderingContext | null = null;
let timerExt: TimerExt | null = null;
let gpuReason = "perf sampler not installed";
const gpuPool: GpuSlot[] = [];
let gpuNext = 0;
let gpuActive: GpuSlot | null = null;
let gpuDisjointDrops = 0;
let gpuPoolMisses = 0;

const gpuMs = new Float64Array(WINDOW);
let gpuWrite = 0;
let gpuFilled = 0;

function teardownGpuTiming(): void {
  if (gl2 !== null) {
    if (gpuActive !== null && timerExt !== null) {
      gl2.endQuery(timerExt.TIME_ELAPSED_EXT);
      gpuActive = null;
    }
    for (const slot of gpuPool) gl2.deleteQuery(slot.query);
  }
  gpuPool.length = 0;
  gl2 = null;
  timerExt = null;
  gpuNext = 0;
  gpuActive = null;
  gpuReason = "perf sampler not installed";
}

function setupGpuTiming(gl: WebGLRenderer): void {
  teardownGpuTiming();
  gpuMs.fill(0);
  gpuWrite = 0;
  gpuFilled = 0;
  gpuDisjointDrops = 0;
  gpuPoolMisses = 0;

  const ctx: unknown = gl.getContext();
  if (typeof WebGL2RenderingContext === "undefined" || !(ctx instanceof WebGL2RenderingContext)) {
    gpuReason = "context is WebGL1; EXT_disjoint_timer_query_webgl2 requires WebGL2";
    return;
  }
  const raw: unknown = ctx.getExtension("EXT_disjoint_timer_query_webgl2");
  const ext = raw as TimerExt | null;
  if (ext === null || typeof ext.TIME_ELAPSED_EXT !== "number") {
    gpuReason =
      "EXT_disjoint_timer_query_webgl2 not exposed by this browser/driver — GPU cost is not measured";
    return;
  }

  for (let i = 0; i < GPU_POOL; i++) {
    const query = ctx.createQuery();
    if (query === null) break;
    gpuPool.push({ query, pending: false });
  }
  if (gpuPool.length === 0) {
    gpuReason = "createQuery() returned null — GPU cost is not measured";
    return;
  }

  gl2 = ctx;
  timerExt = ext;
  gpuReason = "";
}

/** Called by `Stage`'s frame driver at priority -1, before any view renders. */
export function gpuFrameBegin(): void {
  const ctx = gl2;
  const ext = timerExt;
  if (ctx === null || ext === null) return;
  if (gpuActive !== null) {
    // `gpuFrameEnd` did not run — a `useFrame` subscriber threw between the two. Close the
    // query so the instrument recovers on the next frame instead of dying silently, and
    // discard its result: it spans an unknown amount of work.
    ctx.endQuery(ext.TIME_ELAPSED_EXT);
    gpuActive = null;
    gpuPoolMisses++;
    return;
  }
  const slot = gpuPool[gpuNext];
  if (slot.pending) {
    // Every query still outstanding: skip this frame rather than invent a number for it.
    gpuPoolMisses++;
    return;
  }
  ctx.beginQuery(ext.TIME_ELAPSED_EXT, slot.query);
  gpuActive = slot;
}

/** Called by `Stage`'s frame driver at priority +10000, after every view has rendered. */
export function gpuFrameEnd(): void {
  const ctx = gl2;
  const ext = timerExt;
  if (ctx === null || ext === null) return;
  if (gpuActive !== null) {
    ctx.endQuery(ext.TIME_ELAPSED_EXT);
    gpuActive.pending = true;
    gpuActive = null;
    gpuNext = (gpuNext + 1) % gpuPool.length;
  }

  // `GPU_DISJOINT_EXT` is reset by the read, and it means the GPU was interrupted at some
  // point since the last read — so every result collected in this pass is suspect, not just
  // one of them. Conservatively discard the lot; `disjointDrops` says how many.
  const disjoint = ctx.getParameter(ext.GPU_DISJOINT_EXT) === true;
  for (let i = 0; i < gpuPool.length; i++) {
    const slot = gpuPool[i];
    if (!slot.pending) continue;
    if (ctx.getQueryParameter(slot.query, ctx.QUERY_RESULT_AVAILABLE) !== true) continue;
    slot.pending = false;
    if (disjoint) {
      gpuDisjointDrops++;
      continue;
    }
    const ns = ctx.getQueryParameter(slot.query, ctx.QUERY_RESULT);
    if (typeof ns !== "number") continue;
    gpuMs[gpuWrite] = ns / 1e6;
    gpuWrite = (gpuWrite + 1) % WINDOW;
    if (gpuFilled < WINDOW) gpuFilled++;
  }
}

/**
 * Clears the GPU window without touching the CPU window, the scene marks or the events.
 *
 * `drive()` calls this immediately before a measurement pass so the percentiles it reports
 * cover that pass and nothing else. `reset()` would have done it too, and would also have
 * wiped every scene mark the capture is about to read.
 */
export function resetGpuWindow(): void {
  gpuMs.fill(0);
  gpuWrite = 0;
  gpuFilled = 0;
  gpuDisjointDrops = 0;
  gpuPoolMisses = 0;
}

function gpuTiming(): GpuTiming {
  const live = timerExt !== null && gpuFilled > 0;
  return {
    available: live,
    reason: live
      ? ""
      : timerExt !== null
        ? "EXT_disjoint_timer_query_webgl2 is present but no query has resolved yet"
        : gpuReason,
    avgMs: live ? round(meanOf(gpuMs, gpuFilled), 3) : null,
    p95Ms: live ? round(percentileOf(gpuMs, gpuFilled, 0.95), 3) : null,
    worstMs: live ? round(maximumOf(gpuMs, gpuFilled), 3) : null,
    samples: gpuFilled,
    disjointDrops: gpuDisjointDrops,
    poolMisses: gpuPoolMisses,
  };
}

/* ------------------------------------------------------------------ */
/* One-shot events                                                     */
/* ------------------------------------------------------------------ */

const EVENT_SLOTS = 32;
const events: PerfEvent[] = [];

/**
 * Records a one-shot cost — currently only shader compilation, from `Scene3D`.
 *
 * `3D-SPEC §9` allows "scene entry hitch <= 1 dropped frame", and the round-3 audit could
 * not grade that because the compile was never separated from the rest of the entry window.
 * Keeping it as its own event means a capture reports the compile cost and the program count
 * it bought, instead of a comment claiming 15-60 ms per variant on hardware nobody ran on.
 */
export function recordEvent(name: string, ms: number, count = 0): void {
  events.push({ name, ms: round(ms, 2), count, at: round(realNow(), 1) });
  while (events.length > EVENT_SLOTS) events.shift();
}

/* ------------------------------------------------------------------ */
/* Scene marks                                                         */
/* ------------------------------------------------------------------ */

/**
 * 64, not 24.
 *
 * A nine-game endurance loop opens 18 marks and a two-loop run opens 36; at 24 the ring
 * overran mid-run and the round-3 captures reported marks that had already been overwritten
 * by a later game. `marksOverwritten` counts the overrun explicitly, so a longer run than
 * this holds still reports that its list is partial rather than looking complete.
 */
const MARK_SLOTS = 64;
const MARK_WINDOW_MS = 1000;
/**
 * ...or this many frames, whichever comes first. At 60Hz the time window closes first
 * (90 frames is 1.5s); under a driver pumping frames far faster than real time it is the
 * frame count that closes the window, so an entry mark actually resolves and the
 * `hitch:enter:*` budget can fire instead of sitting `open` forever.
 */
const MARK_WINDOW_FRAMES = 90;

type MarkSlot = PerfMark & { at: number; used: boolean };

const markPool: MarkSlot[] = [];
for (let i = 0; i < MARK_SLOTS; i++) {
  markPool.push({ name: "", phase: "enter", worstMs: 0, frames: 0, open: false, at: 0, used: false });
}
let markWrite = 0;
let duplicateMarks = 0;
let markOverwrites = 0;

/**
 * Opens a measurement window, unless this is the second half of a duplicate pair.
 *
 * `GamesCollection` owns the route and calls `markSceneEnter`/`markSceneExit`; every one of
 * the nine games *also* mirrors those calls in its own mount effect. Both are legitimate
 * from where they sit, and neither can see the other, so the dedupe belongs here. Round-3
 * captures show the consequence of not having it: every mark recorded twice, identical
 * `worstMs` and `frames`, and the 24-slot ring overrunning at six games.
 *
 * The rule is deliberately narrow — the *immediately preceding* mark, same name, same phase,
 * window still open. That catches a duplicate whether it arrives in the same tick or 800 ms
 * later behind a cold lazy chunk, and it cannot suppress a real re-entry, because leaving a
 * game records an `exit` mark in between and so changes what the preceding mark is.
 */
function mark(name: string, phase: "enter" | "exit"): void {
  const previous = markPool[(markWrite + MARK_SLOTS - 1) % MARK_SLOTS];
  if (previous.used && previous.open && previous.name === name && previous.phase === phase) {
    duplicateMarks++;
    return;
  }

  const slot = markPool[markWrite];
  if (slot.used) markOverwrites++;
  markWrite = (markWrite + 1) % MARK_SLOTS;
  slot.name = name;
  slot.phase = phase;
  slot.worstMs = 0;
  slot.frames = 0;
  slot.open = true;
  slot.used = true;
  // Real clock, to match the `wall` reading the sampler ages it against. Mixing a virtual
  // `at` with a real `ts` is why every entry mark in the round-2 audit stayed `open`.
  slot.at = realNow();
}

/**
 * Opens a 1s measurement window at scene entry. The spec allows at most one dropped frame
 * when a game's view mounts; this is what makes that assertion checkable.
 */
export function markSceneEnter(name: string): void {
  mark(name, "enter");
  // The route store is what `computeViolations` picks a draw-call budget from, and nothing
  // else in the app ever wrote to it — so every game scene was graded against the hub's 60
  // and every violation was labelled "in the hub".
  route.set({ screen: "game", gameId: name });
  // The first departure from the hub — the hub built, settled and idle — is the only
  // honest baseline for `3D-SPEC §5`. Taking it at renderer creation would have caught an
  // empty scene and flattered every later reading.
  if (memoryBaseline === null) captureMemoryBaseline();
  enterScene(name);
}

export function markSceneExit(name: string): void {
  mark(name, "exit");
  if (route.get().gameId === name || route.get().screen === "game") {
    route.set({ screen: "hub", gameId: null });
  }
  exitScene(name);
}

/* ------------------------------------------------------------------ */
/* Sampling                                                            */
/* ------------------------------------------------------------------ */

let renderer: WebGLRenderer | null = null;
let originalAutoReset = true;
let rafId = 0;
let sampling = false;
/** Previous rAF timestamp (virtual under a driver). */
let lastTs = -1;
/** Previous real wall-clock reading. */
let lastWall = -1;
/**
 * True once any frame in the current window was sampled while the tab was hidden.
 *
 * A hidden tab does not run `requestAnimationFrame` at vsync — Chrome throttles it to ~1Hz
 * and often stops it entirely — so neither `fps` nor `droppedFrameRatio` means anything
 * taken there. Sticky for the life of the window rather than checked per read, because a
 * capture script typically brings the tab forward before reading, and the frames already in
 * the buffer would still be the throttled ones.
 */
let hiddenDuringWindow = false;

/**
 * Runs once per animation frame. Order relative to R3F's own rAF callback is not
 * guaranteed, and does not need to be: `renderer.info` is read and then reset here, so
 * whichever order the browser picks, each sample holds one complete frame's totals —
 * possibly the previous frame's, never a partial one.
 */
function sample(ts: number): void {
  rafId = requestAnimationFrame(sample);

  // Two readings, deliberately. `wall` is the only one any budget is allowed to use; `ts`
  // is whatever the frame source says the time is, which a driver is free to invent.
  const wall = realNow();
  const dt = lastWall < 0 ? -1 : wall - lastWall;
  lastWall = wall;
  const pacing = lastTs < 0 ? -1 : ts - lastTs;
  lastTs = ts;

  const cpu = renderAccum;
  renderAccum = 0;

  if (typeof document !== "undefined" && document.visibilityState === "hidden") {
    hiddenDuringWindow = true;
  }

  if (renderer !== null) {
    lastCalls = renderer.info.render.calls;
    lastTriangles = renderer.info.render.triangles;
    renderer.info.reset();
  }

  // First frame after install/reset has no interval, and a suspended tab is not a hitch.
  if (dt < 0 || dt > SUSPEND_MS) return;

  watchZeroDrawCalls();

  frameMs[write] = dt;
  pacingMs[write] = pacing < 0 ? dt : pacing;
  renderMs[write] = cpu;
  write = (write + 1) % WINDOW;
  if (filled < WINDOW) filled++;

  for (let i = 0; i < MARK_SLOTS; i++) {
    const slot = markPool[i];
    if (!slot.open) continue;
    // Under a driver, frames arrive only when the harness pumps them, and the real-time gap
    // between two batches is the harness's — a fetch, a screenshot encode — not the app's.
    // Ageing against the wall clock there closed the window at `frames: 0` before a single
    // frame had been sampled, and `computeViolations` then skipped the slot entirely, so an
    // absent measurement was published as an empty `violations` array. Round-3 captures show
    // that for maze-escape in five files and for tooth-match on a fresh load. With a virtual
    // clock the window is closed by frame count and by nothing else.
    const expired = virtualClock
      ? slot.frames >= MARK_WINDOW_FRAMES
      : wall - slot.at > MARK_WINDOW_MS || slot.frames >= MARK_WINDOW_FRAMES;
    if (expired) {
      slot.open = false;
      continue;
    }
    if (dt > slot.worstMs) slot.worstMs = dt;
    slot.frames++;
  }
}

/* ------------------------------------------------------------------ */
/* Zero-draw-call watchdog (A8)                                        */
/* ------------------------------------------------------------------ */

/**
 * A frame that draws nothing while a `<Scene3D>` is mounted is a bug, and it was a *silent*
 * one: two of nine games shipped `draw calls 0 / triangles 0` at 390x844 with their DOM
 * chrome laid out perfectly, no console output, and no error anywhere in 843 evidence files.
 *
 * `renderer.info` is reset once per rAF here rather than per `gl.render`, so `lastCalls` is
 * the whole frame's total across every drei `<View>`. Zero means no view rendered at all,
 * and `viewDiagnostics()` knows which of drei's three skip conditions fired. Fires once per
 * episode so a legitimately empty frame (mid-transition, `AnimatePresence` between screens)
 * cannot spam, and re-arms when drawing resumes.
 */
const ZERO_DRAW_FRAMES = 12;
let zeroDrawRun = 0;
let zeroDrawReported = false;

/**
 * `Scene3D` pushes its `viewDiagnostics` in here at module scope.
 *
 * A plain import would be a cycle — `Scene3D` already imports `realNow`/`recordEvent` from
 * this file — and a dynamic one leaves `Scene3D` in the entry chunk anyway (it is statically
 * imported by eleven modules) while adding a promise to the failure path. A registration
 * hook is neither.
 */
let viewDiagnosticsSource: (() => unknown[]) | null = null;

export function setViewDiagnosticsSource(fn: () => unknown[]): void {
  viewDiagnosticsSource = fn;
}

function watchZeroDrawCalls(): void {
  if (lastCalls > 0) {
    zeroDrawRun = 0;
    zeroDrawReported = false;
    return;
  }
  if (zeroDrawReported || ++zeroDrawRun < ZERO_DRAW_FRAMES) return;
  zeroDrawReported = true;
  const views = viewDiagnosticsSource?.() ?? [];
  if (views.length === 0) return; // nothing mounted: an empty frame is correct.
  console.error(
    `[perf] ${ZERO_DRAW_FRAMES} consecutive frames drew nothing while ${views.length} ` +
      `view(s) were mounted on "${route.get().gameId ?? route.get().screen}". ` +
      "A drei <View> skips its render when the host never resolved, when its tracked rect " +
      "is offscreen, or when that rect is degenerate (a 0-size rect gives camera.aspect " +
      "NaN and every object fails the frustum test). Diagnostics:",
    views
  );
}

/**
 * Drops the next frame interval.
 *
 * `?drive=1` pumps frames in bursts with arbitrary real-time gaps between them (a fetch, a
 * screenshot encode). Wall-clock sampling would otherwise book that gap as one enormous
 * frame and poison `worstMs` and every scene mark. The gap is a property of the harness,
 * not of the app, so it is discarded — never clamped, never averaged in.
 */
export function markClockDiscontinuity(): void {
  lastWall = -1;
  lastTs = -1;
}

function startSampling(): void {
  if (sampling) return;
  sampling = true;
  lastTs = -1;
  lastWall = -1;
  rafId = requestAnimationFrame(sample);
}

function stopSampling(): void {
  if (!sampling) return;
  sampling = false;
  cancelAnimationFrame(rafId);
  rafId = 0;
}

/* ------------------------------------------------------------------ */
/* Derived statistics (on-demand only)                                 */
/* ------------------------------------------------------------------ */

/*
 * The four statistics, over an explicit sample count.
 *
 * Explicit rather than closing over `filled`, because the GPU window fills independently of
 * the CPU one — its results arrive several frames late and are discarded on a driver
 * disjoint — and a GPU p95 computed over the CPU window's `filled` would read whatever
 * happened to be left in the buffer from a previous run.
 */
function meanOf(buf: Float64Array, count: number): number {
  if (count === 0) return 0;
  let sum = 0;
  for (let i = 0; i < count; i++) sum += buf[i];
  return sum / count;
}

function percentileOf(buf: Float64Array, count: number, p: number): number {
  if (count === 0) return 0;
  scratch.set(buf.subarray(0, count));
  scratch.subarray(0, count).sort();
  const idx = Math.min(count - 1, Math.max(0, Math.ceil(p * count) - 1));
  return scratch[idx];
}

function maximumOf(buf: Float64Array, count: number): number {
  let max = 0;
  for (let i = 0; i < count; i++) if (buf[i] > max) max = buf[i];
  return max;
}

function countOverIn(buf: Float64Array, count: number, limit: number): number {
  let n = 0;
  for (let i = 0; i < count; i++) if (buf[i] > limit) n++;
  return n;
}

const mean = (buf: Float64Array) => meanOf(buf, filled);
const percentile = (buf: Float64Array, p: number) => percentileOf(buf, filled, p);
const maximum = (buf: Float64Array) => maximumOf(buf, filled);
const countOver = (buf: Float64Array, limit: number) => countOverIn(buf, filled, limit);

const round = (v: number, places = 2) => {
  const f = 10 ** places;
  return Math.round(v * f) / f;
};

/* ------------------------------------------------------------------ */
/* Budgets                                                             */
/* ------------------------------------------------------------------ */

/**
 * A phone or tablet is allowed the full 16.7ms frame; a desktop dev machine is held to
 * `desktopFrameMsP95` because it is standing in for a device four times slower.
 */
const isHandheld =
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(pointer: coarse)").matches
    : false;

function violation(
  out: PerfViolation[],
  metric: string,
  value: number,
  budget: number,
  message: string
): void {
  if (value > budget) out.push({ metric, value: round(value), budget, message });
}

/**
 * Budget checks the current clock cannot decide. Reported alongside the violations so an
 * empty `violations` array can never be mistaken for "all budgets met".
 */
function computeUnmeasured(): Unmeasured[] {
  const out: Unmeasured[] = [];
  if (virtualClock) {
    // Under a driver the frames are pumped as fast as the script can go, so an interval
    // longer than 25ms proves nothing about a missed vsync in either direction.
    const reason = "a harness owns requestAnimationFrame; the rAF cadence is synthetic";
    out.push({ metric: "droppedFrameRatio", reason });
    out.push({ metric: "fps", reason });
  } else if (hiddenDuringWindow) {
    // A hidden tab is throttled to ~1Hz or stopped outright, and its frames are not paced by
    // vsync at all. Reporting 60.0 from that would be the round-2 artefact all over again.
    const reason = "the tab was hidden for part of this window; rAF is throttled, not vsync-paced";
    out.push({ metric: "droppedFrameRatio", reason });
    out.push({ metric: "fps", reason });
  }
  if (filled === 0) {
    out.push({ metric: "renderP95Ms", reason: "no frames sampled" });
  }
  if (!gpuAvailable()) {
    out.push({ metric: "gpuP95Ms", reason: gpuTiming().reason });
  }
  if (displayPeriodMs() === null) {
    // Without the panel's period there is no honest threshold for "a vsync was missed" and
    // no honest budget for the entry hitch. Both are named rather than approximated (A12).
    const reason = virtualClock
      ? "the rAF cadence is synthetic, so the display period cannot be inferred from it"
      : `only ${periodSampleCount()} rAF intervals seen; ${PERIOD_SAMPLES_NEEDED} are needed to resolve the display period`;
    out.push({ metric: "droppedFrameRatio", reason });
    out.push({ metric: "hitch:*", reason });
  }
  // The claim `3D-SPEC §1.4` actually makes is about a mid-range Android tablet, and nothing
  // in this process has ever run on one. `desktopGpuMsP95` is a proxy for it, reached by an
  // unmeasured conversion factor; saying so here is what stops a clean `violations: []` on a
  // desktop being read as "60fps on the named device" (A7).
  out.push({
    metric: "gpuMsP95@target",
    reason:
      "no measurement exists on the mid-range Android tablet 3D-SPEC §1.4 names. " +
      "The desktop reading is converted by GPU_PROJECTION.perPixelCostRatio, which is an " +
      "estimate, not a measurement — read snapshot().projection for the arithmetic.",
  });

  // A closed window that sampled zero frames measured nothing. `computeViolations` cannot
  // assert against it and must not, so it is named here instead — an absent measurement can
  // never again be published as a clean `violations: []`.
  for (let i = 0; i < MARK_SLOTS; i++) {
    const slot = markPool[i];
    if (!slot.used || slot.open || slot.frames > 0) continue;
    out.push({
      metric: `hitch:${slot.phase}:${slot.name}`,
      reason: "the measurement window closed having sampled zero frames — UNMEASURED, not a pass",
    });
  }
  return out;
}

const gpuAvailable = (): boolean => timerExt !== null && gpuFilled > 0;

/**
 * Live materials, from three's own refcount. One program is shared by every material with
 * the same permutation, so `programs.length` undercounts materials — badly. See A12c.
 */
function liveMaterialCount(): number {
  const list = renderer?.info.programs;
  if (!list) return 0;
  let n = 0;
  for (const p of list) n += p.usedTimes;
  return n;
}

/* ------------------------------------------------------------------ */
/* The desktop -> tablet projection, written down (A7)                 */
/* ------------------------------------------------------------------ */

/**
 * ## The argument this settles, with arithmetic
 *
 * Round 4 measured GPU time for the first time and found **29 of 30 scene/tier readings over
 * `BUDGETS.desktopGpuMsP95` = 1.2 ms**, by 1.13x–3.61x, while *every* reading sat far under
 * the 16.7 ms hard ceiling. Two readings of that are possible — the proxy is wrong, or the
 * product misses 60 fps on the device `3D-SPEC §1.4` names — and the fix list is explicit
 * that raising the budget until the numbers fit is the failure mode A12 exists for.
 *
 * So: not raised. Re-derived, and the derivation shipped next to the number.
 *
 * `quality.ts` justifies 1.2 ms like this: *"A Mali-G52 / Adreno 610 tablet at ~2.2 Mpx is
 * roughly 12x the per-pixel cost of an M-series desktop GPU at ~5.0 Mpx, so 1.2 ms measured
 * on this desktop projects to ~14.4 ms."* That sentence contains three quantities and uses
 * one: `1.2 x 12 = 14.4` applies **12 as a whole-frame factor** while describing it as a
 * **per-pixel** factor, and then never divides by the pixel counts it quoted. A per-pixel
 * ratio only becomes a frame-cost ratio after the pixel counts are applied:
 *
 *     factor = perPixelCostRatio x (targetPixels / measuredPixels)
 *
 * Both of the pixel counts in that comment are also the wrong ones.
 *
 *  - **measured.** The round-4 captures ran at 1440x900 at dpr 1 = **1.296 Mpx**, not 5.0.
 *    So it is not assumed here at all: it is read from the drawing buffer at call time.
 *  - **target.** 2.2 Mpx is the tablet *panel's native* resolution. The app never renders it.
 *    `quality.ts::DPR` caps the low tier — the tier that device boots — at **dpr 1**, so on a
 *    1280x800 CSS viewport the drawing buffer is 1.024 Mpx. Projecting onto pixels the
 *    renderer is explicitly configured never to produce doubles the answer.
 *
 * With both corrected, and the comment's own 12x per-pixel ratio taken at face value:
 *
 *     factor          = 12 x (1.024 / 1.296) = 9.48
 *     desktop budget  = 16.7 / 9.48          = 1.76 ms
 *
 * — so the published 1.2 ms is **1.47x stricter** than the model that is supposed to justify
 * it. It survives; it just was not derived, and two errors happened to cancel in its favour.
 * It is derived now.
 *
 * The check below asserts against `min(published budget, model-derived budget)`. That is a
 * one-way ratchet on purpose: if a future edit to the model would loosen the bar, the
 * published number still holds it, and if the model tightens, the model wins. Raising a
 * budget until the numbers fit is the failure mode A12 was raised for, and this is the
 * structural guarantee that it cannot happen here by accident.
 *
 * What that arithmetic then says about the shipped readings, at the tier the target device
 * boots (`?tier=low`, all ten scenes, from `perf-vs-budget.txt`): p95 1.350–2.074 ms x 9.48
 * projects to **12.8–19.7 ms**. Nine of the ten land inside a 60 Hz frame and one does not —
 * `tooth-match` at 19.7 ms — while `tooth-rescue` (16.3), `tooth-runner` (16.4) and
 * `smile-maker` (16.4) graze the ceiling with no headroom whatever. That is a different and
 * far more actionable statement than "29 of 30 readings breach the budget": it names one
 * scene to fix and three to stop growing.
 *
 * And it is still a projection. It is not evidence about a tablet. Only a tablet is.
 *
 * What is still **not** measured, and is now said out loud on every snapshot: the per-pixel
 * cost ratio itself. It is an estimate about hardware nobody in four rounds has run on.
 * `computeUnmeasured()` emits `gpuMsP95@target` unconditionally for exactly that reason —
 * until a Mali-G52 / Adreno 610-class tablet is measured, `§1.4` is an assertion and this
 * file will keep saying so.
 */
export const GPU_PROJECTION = {
  /**
   * Per-pixel fragment cost of a Mali-G52 / Adreno 610-class tablet GPU relative to the
   * desktop GPU under test. **ESTIMATED, NEVER MEASURED.** Carried at the value `quality.ts`
   * asserts so the two files cannot disagree about it; the moment a real device is measured
   * this becomes a measurement and the whole projection becomes a fact.
   */
  perPixelCostRatio: 12,
  /**
   * The **drawing-buffer** pixels the app would produce on that device, not the panel's
   * native resolution: a 1280x800 CSS viewport (a Galaxy Tab A9+ / Lenovo Tab M10-class
   * 1920x1200 panel at its reported dpr) rendered at `quality.ts::DPR.low === 1`.
   *
   * Also an estimate — it is a device nobody has held — but it is an estimate of the right
   * quantity. 2.2 Mpx, the number the justifying comment used, is a resolution the renderer
   * is explicitly configured never to draw at.
   */
  targetPixels: 1_024_000,
} as const;

export type GpuProjection = {
  /** Drawing-buffer pixels this capture actually rendered — measured, not assumed. */
  measuredPixels: number;
  targetPixels: number;
  perPixelCostRatio: number;
  /** `perPixelCostRatio x targetPixels / measuredPixels`. */
  factor: number;
  /** Measured GPU p95 here, or null when the timer query never resolved. */
  measuredGpuP95Ms: number | null;
  /** What that projects to on the named device. PROJECTED, never measured. */
  projectedGpuP95Ms: number | null;
  /** `gpuMsP95 / factor` — the desktop reading that would project to one 60Hz frame. */
  derivedDesktopBudgetMs: number;
  /** The budget actually asserted: `min(published, derived)`. Never looser than published. */
  assertedDesktopBudgetMs: number;
  publishedDesktopBudgetMs: number;
  /** Always false. The day this is true, `3D-SPEC §1.4` stops being an assertion. */
  measuredOnTargetDevice: false;
};

function drawingBufferPixels(): number {
  if (renderer === null) return 0;
  const ctx: unknown = renderer.getContext();
  if (
    (typeof WebGLRenderingContext !== "undefined" && ctx instanceof WebGLRenderingContext) ||
    (typeof WebGL2RenderingContext !== "undefined" && ctx instanceof WebGL2RenderingContext)
  ) {
    return ctx.drawingBufferWidth * ctx.drawingBufferHeight;
  }
  return 0;
}

export function gpuProjection(): GpuProjection {
  const measuredPixels = drawingBufferPixels();
  const factor =
    measuredPixels > 0
      ? (GPU_PROJECTION.perPixelCostRatio * GPU_PROJECTION.targetPixels) / measuredPixels
      : GPU_PROJECTION.perPixelCostRatio;
  const measured = gpuAvailable() ? percentileOf(gpuMs, gpuFilled, 0.95) : null;
  const derived = BUDGETS.gpuMsP95 / factor;
  return {
    measuredPixels,
    targetPixels: GPU_PROJECTION.targetPixels,
    perPixelCostRatio: GPU_PROJECTION.perPixelCostRatio,
    factor: round(factor, 2),
    measuredGpuP95Ms: measured === null ? null : round(measured, 3),
    projectedGpuP95Ms: measured === null ? null : round(measured * factor, 2),
    derivedDesktopBudgetMs: round(derived, 3),
    assertedDesktopBudgetMs: round(Math.min(BUDGETS.desktopGpuMsP95, derived), 3),
    publishedDesktopBudgetMs: BUDGETS.desktopGpuMsP95,
    measuredOnTargetDevice: false,
  };
}

function computeViolations(): PerfViolation[] {
  const out: PerfViolation[] = [];
  const hub = route.get().screen === "hub";
  const callBudget = hub ? BUDGETS.drawCallsHub : BUDGETS.drawCallsGame;

  violation(out, "drawCalls", lastCalls, callBudget, `${lastCalls} draw calls in the ${hub ? "hub" : "game"}`);
  violation(out, "triangles", lastTriangles, BUDGETS.triangles, `${lastTriangles} triangles`);

  const renderBudget = isHandheld ? BUDGETS.frameMsP95 : BUDGETS.desktopFrameMsP95;
  const rp95 = percentile(renderMs, 0.95);
  violation(
    out,
    "renderP95Ms",
    rp95,
    renderBudget,
    `p95 render cost ${round(rp95)}ms exceeds the ${isHandheld ? "handheld" : "desktop-proxy"} budget`
  );

  // Real GPU cost, when a query resolved. `3D-SPEC §4`'s locked-60fps claim is a fragment
  // claim before it is a CPU one, and this is the only check in this file that tests it.
  if (gpuAvailable()) {
    const gp95 = percentileOf(gpuMs, gpuFilled, 0.95);
    const projection = gpuProjection();
    // On real handheld hardware the 16.7ms ceiling is a fact and needs no projection. On a
    // desktop the budget is a proxy, and it is the stricter of what `quality.ts` publishes
    // and what that file's own model derives — see `GPU_PROJECTION`.
    const gpuBudget = isHandheld ? BUDGETS.gpuMsP95 : projection.assertedDesktopBudgetMs;
    violation(
      out,
      "gpuP95Ms",
      gp95,
      gpuBudget,
      isHandheld
        ? `p95 GPU cost ${round(gp95, 3)}ms exceeds one 60Hz frame — this device cannot hold 60fps`
        : `p95 GPU cost ${round(gp95, 3)}ms at ${(projection.measuredPixels / 1e6).toFixed(3)}Mpx ` +
          `exceeds the desktop proxy; PROJECTED (never measured) x${projection.factor} = ` +
          `${projection.projectedGpuP95Ms}ms on the tablet 3D-SPEC §1.4 names, against 16.7ms`
    );
  }

  const droppedLimit = droppedFrameMs();
  if (!virtualClock && !hiddenDuringWindow && droppedLimit !== null) {
    const dropped = countOver(frameMs, droppedLimit);
    const droppedRatio = filled === 0 ? 0 : dropped / filled;
    // 1% of frames is a hitch every ~1.6s at 60fps — already visible to a child.
    violation(
      out,
      "droppedFrameRatio",
      droppedRatio,
      0.01,
      `${dropped}/${filled} frames exceeded ${round(droppedLimit, 1)}ms ` +
        `(1.5 x the measured ${round(displayPeriodMs() ?? 0, 2)}ms display period) and so missed a vsync`
    );
  }

  /*
   * Live materials, not live programs (A12c).
   *
   * This used to assert `renderer.info.programs.length` against `BUDGETS.materials`. Those
   * are different quantities and the difference is not small: three keeps **one** program per
   * distinct shader permutation and refcounts it across every material that shares it, so a
   * scene with 41 live materials sharing 11 permutations reported "11" against a budget of
   * 28 and passed — while the budget the number claimed to enforce was breached by 13.
   * `endurance.json:finalPrograms` is exactly that reading.
   *
   * `usedTimes` is that refcount, so summing it over the live program list is the live
   * material count, and it is what §9's `materials` budget is about. The program count is
   * still published on the snapshot; it is simply no longer pretending to be this.
   */
  const programList = renderer?.info.programs ?? null;
  const programs = programList?.length ?? 0;
  let liveMaterials = 0;
  if (programList !== null) for (const p of programList) liveMaterials += p.usedTimes;
  violation(
    out,
    "materials",
    liveMaterials,
    BUDGETS.materials,
    `${liveMaterials} live materials across ${programs} compiled shader permutations`
  );

  if (renderer !== null) {
    const mem = memorySnapshot(renderer);
    violation(
      out,
      "renderTargets",
      mem.renderTargets,
      BUDGETS.renderTargets,
      `${mem.renderTargets} render targets live`
    );
  }

  /*
   * "Scene entry hitch <= 1 dropped frame" (§9), in the period the display actually runs at.
   *
   * The constant this replaces was 50 ms, justified in-comment by a 30 Hz assumption — 1.5x
   * looser than the spec at 60 Hz and 3x looser on the 120 Hz panel every round-4 capture
   * was taken on. `entryHitchBudgetMs()` is `2 x` the *measured* period: one frame of work
   * plus the one dropped frame §9 allows. When the period is not yet known the check is not
   * run and `computeUnmeasured()` says so — never approximated into a pass (A12b).
   */
  const hitchBudget = entryHitchBudgetMs();
  if (hitchBudget !== null) {
    for (let i = 0; i < MARK_SLOTS; i++) {
      const slot = markPool[i];
      // A window that sampled nothing is not a pass and is not a failure — `computeUnmeasured`
      // names it so it can never be read as either.
      if (!slot.used || slot.frames === 0) continue;
      violation(
        out,
        `hitch:${slot.phase}:${slot.name}`,
        slot.worstMs,
        round(hitchBudget, 1),
        `${slot.phase === "enter" ? "entering" : "leaving"} "${slot.name}" cost a ` +
          `${round(slot.worstMs, 1)}ms frame against a ${round(hitchBudget, 1)}ms budget ` +
          `(2 x the measured ${round(displayPeriodMs() ?? 0, 2)}ms display period)`
      );
    }
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/**
 * True when the rAF cadence cannot be read as vsync evidence — see `Unmeasured`.
 *
 * `displayPeriodMs() === null` joins the list: without the panel's own period there is no
 * threshold at which an interval proves a missed vsync, and the previous answer — a hard
 * 25 ms — was wrong on every display faster than 40 Hz (A12a).
 */
const cadenceUnusable = (): boolean =>
  virtualClock || hiddenDuringWindow || displayPeriodMs() === null;

/** Dropped frames over the window, or null when the threshold is not knowable. */
function droppedInWindow(): number | null {
  const limit = droppedFrameMs();
  return limit === null ? null : countOver(frameMs, limit);
}

export function perfSnapshot(): PerfSnapshot {
  const avg = mean(frameMs);
  const long = countOver(frameMs, LONG_FRAME_MS);
  const dropped = droppedInWindow();
  const mem = renderer !== null ? memorySnapshot(renderer) : null;
  const blind = cadenceUnusable();

  return {
    fps: blind || avg <= 0 ? null : round(1000 / avg, 1),
    avgMs: round(avg),
    p95Ms: round(percentile(frameMs, 0.95)),
    worstMs: round(maximum(frameMs)),
    longFrames: long,
    longFrameRatio: filled === 0 ? 0 : round(long / filled, 3),
    droppedFrames: blind || dropped === null ? null : dropped,
    droppedFrameRatio:
      blind || dropped === null || filled === 0 ? null : round(dropped / filled, 3),
    renderAvgMs: round(mean(renderMs)),
    renderP95Ms: round(percentile(renderMs, 0.95)),
    clock: virtualClock ? "virtual" : "real",
    pacingAvgMs: round(mean(pacingMs)),
    pacingP95Ms: round(percentile(pacingMs, 0.95)),
    unmeasured: computeUnmeasured(),
    gpu: gpuTiming(),
    displayPeriodMs: displayPeriodMs(),
    projection: gpuProjection(),
    liveMaterials: liveMaterialCount(),
    hiddenDuringWindow,
    tier: TIER_PROBE,
    quality: quality.get(),
    events: events.slice(),
    duplicateMarksSuppressed: duplicateMarks,
    marksOverwritten: markOverwrites,
    samples: filled,
    calls: lastCalls,
    triangles: lastTriangles,
    geometries: mem?.geometries ?? 0,
    textures: mem?.textures ?? 0,
    programs: mem?.programs ?? 0,
    renderTargets: mem?.renderTargets ?? 0,
    heapMB: mem?.heapMB ?? null,
    screen: route.get().screen,
    gameId: route.get().gameId,
    marks: collectMarks(),
    violations: computeViolations(),
  };
}

/**
 * The marks in the order they were opened, oldest first.
 *
 * Slot order and chronological order are the same thing only until the ring wraps, and a
 * reader — including `?selftest=perf-marks`, which looks for two *adjacent* marks sharing a
 * name and a phase — has no way to tell that it has stopped being true. Starting the walk at
 * the write cursor makes the list chronological whether the ring has lapped or not.
 */
function collectMarks(): PerfMark[] {
  const out: PerfMark[] = [];
  for (let n = 0; n < MARK_SLOTS; n++) {
    const slot = markPool[(markWrite + n) % MARK_SLOTS];
    if (!slot.used) continue;
    out.push({
      name: slot.name,
      phase: slot.phase,
      worstMs: round(slot.worstMs, 1),
      frames: slot.frames,
      open: slot.open,
    });
  }
  return out;
}

function resetPerf(): void {
  frameMs.fill(0);
  pacingMs.fill(0);
  renderMs.fill(0);
  write = 0;
  filled = 0;
  lastTs = -1;
  lastWall = -1;
  renderAccum = 0;
  lastCalls = 0;
  lastTriangles = 0;
  hiddenDuringWindow = false;
  gpuMs.fill(0);
  gpuWrite = 0;
  gpuFilled = 0;
  gpuDisjointDrops = 0;
  gpuPoolMisses = 0;
  duplicateMarks = 0;
  markOverwrites = 0;
  events.length = 0;
  for (let i = 0; i < MARK_SLOTS; i++) {
    const slot = markPool[i];
    slot.used = false;
    slot.open = false;
    slot.worstMs = 0;
    slot.frames = 0;
  }
}

/* ------------------------------------------------------------------ */
/* Memory baseline                                                     */
/* ------------------------------------------------------------------ */

let memoryBaseline: MemorySnapshot | null = null;

function captureMemoryBaseline(): MemorySnapshot | null {
  if (renderer === null) return null;
  memoryBaseline = memorySnapshot(renderer);
  return memoryBaseline;
}

/**
 * The `3D-SPEC §5` check, made self-proving: it forces any outstanding scene-cache reclaim
 * to happen *first* and reports how many entries that freed, so a reading can never be
 * taken in the window between leaving a game and reclaiming it.
 */
function computeMemoryDrift(): MemoryDrift | null {
  if (renderer === null || memoryBaseline === null) return null;
  const reclaimed = pendingCacheScene() !== null ? flushSceneEviction() : 0;
  const current = memorySnapshot(renderer);
  const baselineCaches = memoryBaseline.caches;
  const cacheDelta: Record<string, number> = {};
  for (const name of Object.keys(current.caches)) {
    cacheDelta[name] = current.caches[name] - (baselineCaches[name] ?? 0);
  }
  for (const name of Object.keys(baselineCaches)) {
    if (!(name in cacheDelta)) cacheDelta[name] = -baselineCaches[name];
  }
  const delta = {
    geometries: current.geometries - memoryBaseline.geometries,
    textures: current.textures - memoryBaseline.textures,
    programs: current.programs - memoryBaseline.programs,
    heapMB:
      current.heapMB !== null && memoryBaseline.heapMB !== null
        ? Math.round((current.heapMB - memoryBaseline.heapMB) * 10) / 10
        : null,
  };
  return {
    baseline: memoryBaseline,
    current,
    delta,
    withinSpec:
      delta.geometries === 0 && delta.textures === 0 && Math.abs(delta.programs) <= 2,
    reclaimed,
    cacheDelta,
    outsideCaches: {
      geometries: delta.geometries - (cacheDelta.geometry ?? 0),
      textures: delta.textures - (cacheDelta.texture ?? 0) - (cacheDelta.text ?? 0),
    },
    residue: (() => {
      const live = resourceCensus();
      const departed = live.filter(
        (r) => r.owner !== null && r.owner !== current.ownership.activeScene
      );
      return {
        byOwner: resourceCensusByOwner(),
        /*
         * Survivors of a scene that has already gone, minus the ones that are shared *by
         * construction*.
         *
         * `markShared` is the escape hatch, so it is worth saying why trusting it here is
         * not a hole. A `markShared` resource is a module-level singleton — `hit.tsx`'s ring
         * geometry, the celebration burst, a cached clay material's normal map — and it is
         * allocated once and kept for the tab on purpose. Whichever scene happens to render
         * it first is an accident of which card a child tapped, not ownership. Counting
         * those as leaks makes the assertion permanently red and therefore permanently
         * ignored, which is worse than not having it.
         *
         * Nothing is hidden by that: they are listed in `sharedFirstSeenInGame`, and the
         * assertion that actually protects §5 — a repeat visit costing exactly zero — cannot
         * be satisfied by anything that grows, shared or not.
         */
        survivors: departed.filter((r) => !r.shared),
        sharedFirstSeenInGame: departed.filter((r) => r.shared),
        censusOn: isResourceCensusOn(),
      };
    })(),
  };
}

/**
 * three keeps one `WebGLProgram` per distinct shader permutation and refcounts it by
 * material. `name` is the shader name, `cacheKey` the full permutation string, `usedTimes`
 * how many live materials still hold it — which is exactly what has to reach zero before a
 * program is released.
 */
function listPrograms(): ProgramRecord[] {
  const live = renderer?.info.programs;
  if (!live) return [];
  const out: ProgramRecord[] = [];
  for (const program of live) {
    out.push({
      name: program.name,
      usedTimes: program.usedTimes,
      cacheKey: program.cacheKey,
    });
  }
  return out;
}

/** Live-getter facade so `__perf.fps` in a console reads the current window, not a copy. */
const api = {} as PerfAPI;
api.snapshot = perfSnapshot;
api.memory = () => {
  if (renderer === null) return null;
  // Same reason as `computeMemoryDrift`: a reading taken mid-transition would report the
  // outgoing game's cache and look like a leak that is not one.
  if (pendingCacheScene() !== null) flushSceneEviction();
  return memorySnapshot(renderer);
};
api.memoryBaseline = captureMemoryBaseline;
api.projection = gpuProjection;
api.residue = () => resourceCensus();
api.programList = listPrograms;
api.memoryDrift = computeMemoryDrift;
api.reset = resetPerf;

const define = (key: keyof PerfAPI, get: () => unknown) =>
  Object.defineProperty(api, key, { get, enumerable: true });

define("fps", () => {
  if (cadenceUnusable()) return null;
  const avg = mean(frameMs);
  return avg > 0 ? round(1000 / avg, 1) : null;
});
define("avgMs", () => round(mean(frameMs)));
define("p95Ms", () => round(percentile(frameMs, 0.95)));
define("worstMs", () => round(maximum(frameMs)));
define("longFrames", () => countOver(frameMs, LONG_FRAME_MS));
define("longFrameRatio", () =>
  filled === 0 ? 0 : round(countOver(frameMs, LONG_FRAME_MS) / filled, 3)
);
define("droppedFrames", () => (cadenceUnusable() ? null : droppedInWindow()));
define("droppedFrameRatio", () => {
  if (cadenceUnusable() || filled === 0) return null;
  const dropped = droppedInWindow();
  return dropped === null ? null : round(dropped / filled, 3);
});
define("renderAvgMs", () => round(mean(renderMs)));
define("renderP95Ms", () => round(percentile(renderMs, 0.95)));
define("samples", () => filled);
define("calls", () => lastCalls);
define("triangles", () => lastTriangles);
define("geometries", () => renderer?.info.memory.geometries ?? 0);
define("textures", () => renderer?.info.memory.textures ?? 0);
define("programs", () => renderer?.info.programs?.length ?? 0);
define("marks", collectMarks);
define("violations", computeViolations);
define("budgets", () => BUDGETS);
define("installed", () => renderer !== null);
define("clock", () => (virtualClock ? "virtual" : "real"));
define("gpu", gpuTiming);
define("tier", () => TIER_PROBE);
define("displayPeriodMs", displayPeriodMs);
define("liveMaterials", liveMaterialCount);

if (typeof window !== "undefined") window.__perf = api;

/* ------------------------------------------------------------------ */
/* Install                                                             */
/* ------------------------------------------------------------------ */

let uninstall: (() => void) | null = null;

/** One census pass every N `gl.render` calls. A no-op when the census is off. */
const CENSUS_EVERY_RENDERS = 12;

/**
 * Binds the sampler to a renderer. Stage calls this explicitly; `?perf` starts the
 * frame-interval half on its own at import time so marks made before the renderer exists
 * are still measured. Safe to ship in production: the whole cost is one rAF callback of
 * ~20 float operations and one `performance.now()` pair per `render` call.
 */
export function installPerf(gl: WebGLRenderer): () => void {
  if (renderer === gl && uninstall !== null) return uninstall;
  if (uninstall !== null) uninstall();

  renderer = gl;
  originalAutoReset = gl.info.autoReset;
  setupGpuTiming(gl);

  // A frame is drawn in several `render` calls once drei `<View>`s are in play; letting
  // three reset per call would report only the last view, so the sample loop owns the
  // reset instead and `calls`/`triangles` become true per-frame totals.
  gl.info.autoReset = false;

  /*
   * The resource census (A6) hooks here, and only here.
   *
   * A drei `<View>` renders a *portal* scene that is not a child of the root scene, so no
   * traversal starting from `Stage` can ever reach a game's geometry. This wrapper sees
   * every scene that actually reaches the framebuffer, which is precisely the blind spot
   * that let a headless simulation "prove" the eviction machinery correct while the real app
   * kept residue. Rate-limited because the census only needs to see a scene once, not 60
   * times a second; a fresh graph is picked up within a fifth of a second either way.
   */
  if (FLAGS.perf || FLAGS.selftest !== null) enableResourceCensus();
  let censusCountdown = 0;

  const inner = gl.render;
  const wrapped: WebGLRenderer["render"] = (scene: Scene, camera: Camera) => {
    if (censusCountdown-- <= 0) {
      censusCountdown = CENSUS_EVERY_RENDERS;
      censusScene(scene as unknown as Object3D);
    }
    // `realNow`, never `performance.now()`: the driver's virtual clock does not advance
    // across this call, which made `renderAccum` mathematically always exactly zero.
    const t0 = realNow();
    inner.call(gl, scene, camera);
    renderAccum += realNow() - t0;
  };
  gl.render = wrapped;

  startSampling();

  const teardown = () => {
    if (renderer !== gl) return;
    // Only unwrap if nothing wrapped us afterwards — clobbering a later hook is worse than
    // leaving one extra `performance.now()` pair in the call path.
    if (gl.render === wrapped) gl.render = inner;
    gl.info.autoReset = originalAutoReset;
    teardownGpuTiming();
    renderer = null;
    uninstall = null;
    if (!FLAGS.perf) stopSampling();
  };

  uninstall = teardown;
  return teardown;
}

if (FLAGS.perf) startSampling();
