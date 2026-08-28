/**
 * Deterministic frame driver — `?drive=1`. Dev/verification only.
 *
 * Automated browsers park their tab at `document.visibilityState === "hidden"`. Chrome then
 * stops the whole rendering lifecycle for that tab: `requestAnimationFrame` never fires and
 * `ResizeObserver` callbacks are never delivered, because both are steps of the render loop.
 * react-three-fiber's <Canvas> waits on a ResizeObserver before it will mount its children,
 * so in that environment the app renders nothing at all — not because it is broken, but
 * because nothing ever asks it to draw.
 *
 * This module removes both dependencies so the running app can be inspected and measured
 * from a script:
 *   - ResizeObserver is wrapped so `observe()` also reports the element's real rect on a
 *     microtask, which is never throttled. That lets the canvas size itself and R3F mount.
 *   - `advance()` renders one complete R3F frame on demand — every useFrame subscriber and
 *     every drei <View> — with a timestamp we choose.
 *
 * Driving frames explicitly is also strictly better evidence than watching an fps counter:
 * it is reproducible, it isolates our cost from the browser's scheduling, and it reports the
 * per-frame CPU and GPU cost that actually decides whether a mid-range tablet holds 60fps.
 *
 * Nothing here is imported unless the query flag is present, and it never runs in production.
 */
import { advance } from "@react-three/fiber";
import { MotionGlobalConfig } from "framer-motion";
import {
  markClockDiscontinuity,
  resetGpuWindow,
  setVirtualClock,
  type GpuTiming,
} from "./perf";

type DriveStats = {
  /** Frames sampled. Warm-up frames are pumped and then discarded, not counted here. */
  frames: number;
  warmupFrames: number;
  totalMs: number;
  avgMs: number;
  p95Ms: number;
  worstMs: number;
  /**
   * Real GPU cost per frame over **these frames** — the same pass, the same scene state.
   *
   * The field this replaces, `avgWithGpuMs`, ran a *second, separate* 20-frame pass with a
   * `gl.finish()` in it and reported the average. That is why the round-3 corpus contains
   * impossibilities: maze-escape 0.115 "with GPU" against 0.161 without, sliding-puzzle
   * 0.445 against 0.558 — a superset measuring cheaper than its subset, because it was not
   * a superset at all, it was a different sample of a different moment.
   */
  gpu: GpuTiming;
  /**
   * Present **only** when the timer query is unavailable: a `gl.finish()`-bracketed pass of
   * the same length, run straight after the main one. It is a fallback and a lower bound —
   * `finish()` measures a pipeline drain, not the frame's GPU cost — and it is deliberately
   * never emitted alongside `gpu.available === true`, so the two can never be compared.
   */
  fallbackFinishAvgMs?: number;
};

type DriveHooks = {
  queue: Map<number, FrameRequestCallback>;
  remeasureAll: () => void;
};

/**
 * The hooks are installed by an inline script in index.html, before any module is
 * evaluated. That ordering is not optional: framer-motion and react-three-fiber both
 * capture `requestAnimationFrame` at import time, so a patch applied from here — after
 * those modules have loaded — would drive nothing.
 */
const hooks = (window as unknown as { __driveHooks?: DriveHooks }).__driveHooks;

const percentile = (sorted: number[], p: number) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0;

/* ------------------------------------------------------------------ */
/* The virtual clock                                                   */
/* ------------------------------------------------------------------ */

/**
 * Driving react-three-fiber's `advance()` by hand renders the 3D, but it leaves everything
 * else in the app frozen: framer-motion, drei and R3F's own loop all schedule through
 * requestAnimationFrame, which a hidden tab never fires. A transition that never runs means
 * a game that never mounts.
 *
 * So rather than driving one subsystem, we take over the clock. rAF becomes a queue we
 * drain on demand, and `performance.now()` reports virtual time while we are draining, so
 * every time-based animation in the app advances exactly as it would at a real 60Hz — just
 * deterministically, and without needing the tab to be on screen.
 */
let virtualNow = 0;
let pumping = false;

const realNow = performance.now.bind(performance);

/**
 * Time-based animation reads virtual time while we are driving, so it advances in step.
 *
 * This is also the single most dangerous thing in this file, and it invalidated every
 * timing number in the round-2 audit: anything that resolves `performance.now` *at call
 * time* now measures virtual milliseconds. `src/dev/perf.ts` binds the real function at
 * module load — before this runs — and `setVirtualClock(true)` tells it to say so out
 * loud, so a capture taken under the driver reports which budgets it could not decide
 * instead of reporting a flat, meaningless 60.00.
 */
function patchClock(): void {
  performance.now = () => (pumping ? virtualNow : realNow());
  virtualNow = realNow();
  setVirtualClock(true);
}

/** Runs every callback queued for this frame. Re-registrations land in the next frame. */
function pumpOnce(dtMs: number): void {
  virtualNow += dtMs;
  if (!hooks) {
    advance(virtualNow, true);
    return;
  }
  const due = Array.from(hooks.queue.values());
  hooks.queue.clear();
  for (const cb of due) {
    try {
      cb(virtualNow);
    } catch (err) {
      console.error("[drive] rAF callback threw", err);
    }
  }
  // If nothing was scheduled (an idle frameloop, or R3F on demand), still render one frame
  // so a capture after a state change is never a stale buffer.
  if (due.length === 0) advance(virtualNow, true);
}

/**
 * Frames pumped and thrown away before sampling starts.
 *
 * A cold scene pays for shader links, first-use attribute lookups and first texture uploads
 * on its opening frames, and none of that is the steady-state cost a 60fps claim is about.
 *
 * Why 30: `Scene3D`'s precompile pass waits up to 12 frames for the PMREM before it runs,
 * `HitTarget` re-sizes its collider on one frame in eight, and three defers each program's
 * link readback to the first draw that uses it. 30 frames clears all three with margin and
 * is half a second of virtual time. It is a *choice*, not a measurement, which is why
 * `warmupFrames` is reported alongside every result — if a scene's knee turns out to be
 * later, a capture's `worstMs` will show it inside the sampled range and the number can move
 * with evidence behind it.
 *
 * The reason a warm-up is needed at all: `tier-low.json` reports the strictly *cheaper*
 * configuration as 4–6x more expensive than the richer one (maze-escape 0.598 ms at 17,670
 * triangles against 0.161 ms at 51,510). No tier setting can do that, so the difference is
 * in the measurement, and cold-vs-warm scene state is the candidate this removes. Whether it
 * was the whole explanation is a question for the next capture, not a claim made here.
 */
const WARMUP_FRAMES = 30;

/**
 * Frames pumped after the pass so the last few timer queries can resolve.
 *
 * A GPU timer result is not available for one to three frames after its `endQuery`. Without
 * a drain the tail of every pass would be silently missing from the percentile.
 */
const GPU_DRAIN_FRAMES = 6;

/** Renders `frames` frames, `dtMs` apart, and reports what each one cost. */
function drive(frames = 60, dtMs = 1000 / 60): DriveStats {
  const samples: number[] = [];
  let total = 0;
  pumping = true;
  // Whatever happened between the last batch and this one is the harness's time, not a
  // frame the app dropped. Tell the sampler to throw the first interval away.
  markClockDiscontinuity();

  for (let i = 0; i < WARMUP_FRAMES; i++) pumpOnce(dtMs);

  // Cleared *after* the warm-up so the GPU percentiles describe the sampled frames only.
  resetGpuWindow();
  markClockDiscontinuity();

  for (let i = 0; i < frames; i++) {
    const t0 = realNow();
    pumpOnce(dtMs);
    const cost = realNow() - t0;
    samples.push(cost);
    total += cost;
  }

  for (let i = 0; i < GPU_DRAIN_FRAMES; i++) pumpOnce(dtMs);

  const timing = window.__perf?.gpu;
  const gpu: GpuTiming = timing ?? {
    available: false,
    reason: "window.__perf is not installed",
    avgMs: null,
    p95Ms: null,
    worstMs: null,
    samples: 0,
    disjointDrops: 0,
    poolMisses: 0,
  };

  const sorted = samples.slice().sort((a, b) => a - b);
  const stats: DriveStats = {
    frames,
    warmupFrames: WARMUP_FRAMES,
    totalMs: Math.round(total * 100) / 100,
    avgMs: Math.round((total / frames) * 1000) / 1000,
    p95Ms: Math.round(percentile(sorted, 0.95) * 1000) / 1000,
    worstMs: Math.round(sorted[sorted.length - 1] * 1000) / 1000,
    gpu,
  };

  if (!gpu.available) {
    // Only here. Never next to a real GPU number, so nothing can subtract one from the other.
    const canvas = document.querySelector("canvas");
    const gl = canvas?.getContext("webgl2") ?? canvas?.getContext("webgl");
    markClockDiscontinuity();
    let withFinish = 0;
    for (let i = 0; i < frames; i++) {
      const t0 = realNow();
      pumpOnce(dtMs);
      gl?.finish();
      withFinish += realNow() - t0;
    }
    stats.fallbackFinishAvgMs = Math.round((withFinish / frames) * 1000) / 1000;
  }

  pumping = false;
  markClockDiscontinuity();
  return stats;
}

/**
 * A PNG data URL of the canvas. The buffer is read in the same task as the render that
 * filled it, so this works without `preserveDrawingBuffer` — which would otherwise cost
 * every real user a full-screen copy per frame.
 */
function capture(maxWidth = 0): string | null {
  const canvas = document.querySelector("canvas");
  if (!canvas) return null;
  pumping = true;
  markClockDiscontinuity();
  pumpOnce(1000 / 60);
  pumping = false;
  markClockDiscontinuity();
  const full = canvas.toDataURL("image/png");
  if (!maxWidth || canvas.width <= maxWidth) return full;

  // A retina canvas is several megabytes as a data URL. Downscaling through a 2D canvas
  // keeps the artefact openable while preserving enough detail to judge materials and
  // easing from a sequence of frames.
  const scaled = document.createElement("canvas");
  const ratio = maxWidth / canvas.width;
  scaled.width = maxWidth;
  scaled.height = Math.round(canvas.height * ratio);
  const ctx = scaled.getContext("2d");
  if (!ctx) return full;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(canvas, 0, 0, scaled.width, scaled.height);
  return scaled.toDataURL("image/png");
}

/** Renders, downscales and POSTs a frame to the artefact sink (tools/shotserver.mjs). */
async function shoot(name: string, maxWidth = 1280, port = 5199): Promise<number> {
  const data = capture(maxWidth);
  if (!data) return 0;
  const res = await fetch(`http://localhost:${port}/save?name=${encodeURIComponent(name)}`, {
    method: "POST",
    body: data,
  });
  return Number(await res.text());
}

/** POSTs any JSON blob to the artefact sink alongside the screenshots. */
async function record(name: string, value: unknown, port = 5199): Promise<number> {
  const res = await fetch(`http://localhost:${port}/save?name=${encodeURIComponent(name)}`, {
    method: "POST",
    body: JSON.stringify(value, null, 2),
  });
  return Number(await res.text());
}

export function installDriver(): void {
  if (!hooks) {
    console.warn("[drive] index.html hook missing - reload with ?drive=1 in the URL");
  }
  patchClock();

  /*
   * framer-motion runs plain opacity/transform transitions on the Web Animations API, whose
   * timeline does not advance in a hidden tab — so an <AnimatePresence mode="wait"> exit
   * never completes and the incoming screen never mounts. Pumping rAF cannot fix that,
   * because WAAPI is not on rAF. Skipping the 2D animation makes those swaps resolve
   * instantly so the screen under test actually appears.
   *
   * The 3D transition is unaffected: it runs through useFrame and is driven frame by frame,
   * which is the half worth watching anyway.
   */
  MotionGlobalConfig.skipAnimations = true;
  Object.assign(window, {
    __drive: drive,
    __capture: capture,
    __shoot: shoot,
    __record: record,
    __remeasure: () => hooks?.remeasureAll(),
  });
}

declare global {
  interface Window {
    __drive?: typeof drive;
    __capture?: typeof capture;
    __shoot?: typeof shoot;
    __record?: typeof record;
    __remeasure?: () => void;
  }
}
