/**
 * Stage — the one and only WebGL context in the product.
 *
 * Created at app start, never torn down. Entering or leaving a game mounts and unmounts
 * drei `<View>`s (see `Scene3D.tsx`); it never touches the renderer. Everything a scene
 * needs from the renderer goes through `useRenderer()`.
 *
 * Three things in here are load-bearing and non-obvious. All three come from reading
 * drei v9's `web/View.js` and r3f v8's loop, not from the docs:
 *
 * 1. **We own the clear.** `View` wraps its scissored render in `autoClear = false` and
 *    never clears. R3F's automatic full-scene render — which normally does the clearing —
 *    is switched off the moment any subscriber holds a render priority, and `View`'s does.
 *    So with only drei in play the colour and depth buffers accumulate across frames.
 *    `FrameDriver` clears the whole drawing buffer at priority -1, before any view draws.
 *
 * 2. **We hold the priority gate.** A permanent high-priority `useFrame` keeps
 *    `internal.priority > 0` forever, so R3F never falls back to auto-rendering the root
 *    scene. Consequence: when no `<View>` is on screen, the frame is a clear and nothing
 *    else — which is exactly the requirement — and `Stage`'s own `children` live in a
 *    scene that is deliberately never rendered (use them for logic, not for meshes).
 *
 * 3. **`eventSource` is mandatory, not stylistic.** `View` renders its DOM elements
 *    outside the canvas and maps pointers with `event.clientX/Y`, which only works when
 *    the canvas hands event handling to `#root` with `eventPrefix="client"`.
 */
import { useEffect, useState, type ReactNode } from "react";
import { Canvas, invalidate, useFrame, useThree, type RootState } from "@react-three/fiber";
import { View } from "@react-three/drei";
import type { WebGLRenderer } from "three";
import { createStore, useStore, type Store } from "./store";
import {
  degradeQuality,
  displayPeriodMs,
  noteFramePeriod,
  quality,
  shouldDegrade,
} from "./quality";
import { CAMERA } from "./tokens";
import { applySceneDefaults, disposeEnvironment } from "./env";
import { gpuFrameBegin, gpuFrameEnd, installPerf, realNow } from "../dev/perf";

/* ------------------------------------------------------------------ */
/* Public handles                                                      */
/* ------------------------------------------------------------------ */

const rendererStore = createStore<WebGLRenderer | null>(null);

/** True once the context exists and the scene defaults have been applied. */
export const stageReady: Store<boolean> = createStore<boolean>(false);

/** The app's single renderer, or null before the canvas has been created. */
export function useRenderer(): WebGLRenderer | null {
  return useStore(rendererStore);
}

/**
 * Fired on `window` after a lost context has been restored and the studio environment has
 * been rebuilt. Anything holding a GPU-side resource it built itself (render targets,
 * canvas textures) should rebuild on this.
 */
export const CONTEXT_RESTORED_EVENT = "lumident:contextrestored";

/* ------------------------------------------------------------------ */
/* Adaptive quality                                                    */
/* ------------------------------------------------------------------ */

/** ~1.6 s of history at 60fps. */
const WINDOW = 96;
/** Frames ignored after start and after a tier drop: shader compiles are not the steady state. */
const WARMUP_FRAMES = 150;
/** Evaluate a little under once a second. */
const EVAL_EVERY = 48;
/*
 * The overrun test itself lives in `quality.ts::shouldDegrade`, measured against the
 * display's own frame period rather than against a hard-coded 60 Hz. See that function for
 * why the pair of absolute thresholds that used to sit here — `p95(period) > 22.5 ms &&
 * p95(work) > 9.2 ms` — could not fire on the GPU-bound frame this watchdog exists for.
 */
/** Consecutive failing evaluations required. ~2.4 s of sustained overrun. */
const STRIKES = 3;

/**
 * Rolling frame-cost sampler. Every buffer is preallocated and the once-a-second p95 sorts
 * in place, so nothing here allocates on a frame boundary.
 */
class FrameSampler {
  private readonly period = new Float32Array(WINDOW);
  private readonly work = new Float32Array(WINDOW);
  private readonly scratch = new Float32Array(WINDOW);
  private cursor = 0;
  private filled = 0;
  private lastStart = 0;
  private startedAt = 0;
  private warmup = WARMUP_FRAMES;
  private sinceEval = 0;
  private strikes = 0;
  private exhausted = false;

  reset(): void {
    this.cursor = 0;
    this.filled = 0;
    this.lastStart = 0;
    this.warmup = WARMUP_FRAMES;
    this.sinceEval = 0;
    this.strikes = 0;
    this.exhausted = false;
  }

  begin(now: number): void {
    if (this.lastStart > 0) {
      const dt = now - this.lastStart;
      this.period[this.cursor] = dt;
      // Feeds `quality.ts`'s modal-period estimator. Integer histogram bump, no allocation.
      noteFramePeriod(dt);
    }
    this.lastStart = now;
    this.startedAt = now;
  }

  end(now: number): void {
    if (this.exhausted) return;
    this.work[this.cursor] = now - this.startedAt;
    this.cursor = this.cursor + 1 === WINDOW ? 0 : this.cursor + 1;
    if (this.filled < WINDOW) this.filled++;

    if (this.warmup > 0) {
      this.warmup--;
      return;
    }
    if (this.filled < WINDOW) return;
    if (++this.sinceEval < EVAL_EVERY) return;
    this.sinceEval = 0;

    const over = shouldDegrade(this.p95(this.period));
    this.strikes = over ? this.strikes + 1 : 0;
    if (this.strikes < STRIKES) return;

    const before = quality.get().tier;
    degradeQuality();
    const after = quality.get().tier;
    if (after === before) {
      // Already at the bottom tier — stop measuring, there is nothing left to give up.
      this.exhausted = true;
      return;
    }
    console.warn(
      `[Stage] sustained frame overrun, quality ${before} -> ${after} ` +
        `(p95 period ${this.p95(this.period).toFixed(1)}ms against a measured display period ` +
        `of ${displayPeriodMs().toFixed(1)}ms, cpu work ${this.p95(this.work).toFixed(1)}ms)`
    );
    this.strikes = 0;
    this.warmup = WARMUP_FRAMES;
  }

  /** Only ever called with a full window, so the whole buffer is live data. */
  private p95(src: Float32Array): number {
    this.scratch.set(src);
    this.scratch.sort();
    return this.scratch[Math.floor(WINDOW * 0.95)];
  }
}

const sampler = new FrameSampler();

/* ------------------------------------------------------------------ */
/* Frame driver                                                        */
/* ------------------------------------------------------------------ */

/** Runs before every view. Negative priority does not engage R3F's manual-render gate. */
const CLEAR_PRIORITY = -1;
/** Runs after every view, and is the gate that keeps R3F from auto-rendering the root. */
const GATE_PRIORITY = 10_000;

function beginFrame(state: RootState): void {
  // `realNow`, not `performance.now()`: `?drive=1` virtualises the latter, which pins the
  // sampled period at exactly one tick and the sampled work at exactly zero — so adaptive
  // quality could never fire under the harness that is supposed to be stressing it.
  sampler.begin(realNow());
  const gl = state.gl;
  // Deterministic frame start: a game that rendered into a target last frame must not be
  // able to make us clear the wrong buffer.
  gl.setRenderTarget(null);
  gl.setScissorTest(false);
  gl.clear(true, true, false);
  // These two `useFrame` priorities are the only pair in the app guaranteed to straddle
  // every drei `<View>` render, which makes them the frame bracket a GPU timer query needs.
  // No-op unless `EXT_disjoint_timer_query_webgl2` is live; see `perf.ts`.
  gpuFrameBegin();
}

function endFrame(): void {
  gpuFrameEnd();
  sampler.end(realNow());
}

function FrameDriver() {
  useFrame(beginFrame, CLEAR_PRIORITY);
  useFrame(endFrame, GATE_PRIORITY);
  return null;
}

/* ------------------------------------------------------------------ */
/* Renderer lifecycle                                                  */
/* ------------------------------------------------------------------ */

function StageRuntime({ onLost, onRestored }: { onLost: () => void; onRestored: () => void }) {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);

  useEffect(() => installPerf(gl), [gl]);

  useEffect(() => {
    const canvas = gl.domElement;

    const handleLost = (event: Event) => {
      // preventDefault is the whole contract: without it the browser never restores.
      event.preventDefault();
      console.warn("[Stage] WebGL context lost — pausing the frameloop until it returns.");
      onLost();
    };

    const handleRestored = () => {
      // three re-initialises its own GL state from its constructor-registered listener,
      // which runs before this one. Everything *we* built on the GPU is gone though, and
      // the PMREM is the expensive one — rebuild it and re-attach the scene defaults.
      disposeEnvironment();
      applySceneDefaults(scene, gl);
      onRestored();
      window.dispatchEvent(new Event(CONTEXT_RESTORED_EVENT));
      console.warn("[Stage] WebGL context restored — studio environment rebuilt.");
    };

    canvas.addEventListener("webglcontextlost", handleLost);
    canvas.addEventListener("webglcontextrestored", handleRestored);
    return () => {
      canvas.removeEventListener("webglcontextlost", handleLost);
      canvas.removeEventListener("webglcontextrestored", handleRestored);
    };
  }, [gl, scene, onLost, onRestored]);

  return null;
}

/* ------------------------------------------------------------------ */
/* Boot warm-up                                                        */
/* ------------------------------------------------------------------ */

/**
 * Builds the procedural assets every game shares, once, at boot — before any game is opened
 * and before `markSceneEnter` records the hub memory baseline.
 *
 * Two defects share this cause, and both were argued about for four rounds because the
 * assets are *invisible* to the machinery that was looking for them:
 *
 *  - **A13.** `textures.ts` generates its noise on the CPU: a 256² lattice at four fbm
 *    octaves is ~262 k `fbmTiled` evaluations, and it ran inside the frame a child was
 *    looking at, per game, every entry. `sparkleTexture()` is asked for by seven of the nine
 *    games and the celebration and by *nothing on the hub*, so it was generated cold on the
 *    entry frame of whichever game a child opened first.
 *  - **A6.** That same texture is `markShared`, correctly, and therefore lives for the tab.
 *    Created on first game entry, it lands *after* the hub baseline was taken and is then
 *    scored as a per-game leak for the rest of the session — which is precisely the shape of
 *    the residue the memory captures report: bounded, tiny, and identical after eighteen
 *    game entries as after one. A leak compounds; four geometries across two full nine-game
 *    loops is one-time shared allocation wearing a leak's clothes.
 *
 * Deliberately *not* awaited and deliberately not in `handleCreated`: the first frame belongs
 * to the hub. A timeout puts this after the hub's own first paint and comfortably before a
 * child can cross the room and tap a card.
 *
 * Only assets with no per-game parameters are warmed. Warming a variant that a single game
 * asks for would promote it to the shared tier permanently and turn a fix for one leak into
 * a real one.
 */
const BOOT_WARM_DELAY_MS = 120;

function warmSharedAssets(): void {
  void import("./textures").then(({ radialShadowTexture, sparkleTexture, grainTexture }) => {
    // Every game's spark burst and the shared celebration's. Not used by the hub.
    sparkleTexture();
    // The contact-shadow blob, at the one size `materials.ts::blobMaterial` asks for.
    radialShadowTexture({ size: 256, softness: 0.42 });
    // The pressed-clay micro grain.
    grainTexture();
  });
  void import("./materials").then(({ clayIvory, clayEnamel }) => {
    // Forces `grainMap()` — the 128² × 3-octave fbm normal every clay material samples.
    clayIvory();
    clayEnamel();
  });
  void import("./text").then(({ ensureManrope }) => {
    // A label baked against the fallback face has to be baked again when Manrope lands.
    void ensureManrope();
  });
}

function handleCreated(state: RootState): void {
  rendererStore.set(state.gl);
  applySceneDefaults(state.scene, state.gl);
  stageReady.set(true);
  if (typeof window !== "undefined") window.setTimeout(warmSharedAssets, BOOT_WARM_DELAY_MS);
}

/* ------------------------------------------------------------------ */
/* Stage                                                               */
/* ------------------------------------------------------------------ */

const CANVAS_STYLE: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 0,
  // The canvas is scenery. `#root` at z-index 10 owns every pointer, and drei's <View>
  // re-targets R3F's event layer onto the tracked element from there.
  pointerEvents: "none",
};

/**
 * The root scene is never rendered (see the gate above), so this camera exists only to
 * satisfy R3F. Views bring their own. Module-level so r3f's shallow compare in `configure`
 * never decides to rebuild it.
 */
const ROOT_CAMERA = {
  fov: CAMERA.fov,
  near: CAMERA.near,
  far: CAMERA.far,
  position: [0, 0, 12] as [number, number, number],
};

export function Stage({ children }: { children?: ReactNode }): JSX.Element {
  const q = useStore(quality);
  const [contextLost, setContextLost] = useState(false);

  // Context attributes are fixed for the life of the context, so antialias is sampled once
  // at creation. A later tier drop changes dpr — which R3F can apply live — and nothing else.
  const [glConfig] = useState(() => ({
    antialias: quality.get().antialias,
    alpha: true,
    powerPreference: "high-performance" as WebGLPowerPreference,
    stencil: false,
    depth: true,
    preserveDrawingBuffer: false,
  }));

  const [eventSource] = useState<HTMLElement | undefined>(
    () => document.getElementById("root") ?? undefined
  );

  const [onLost] = useState(() => () => {
    sampler.reset();
    setContextLost(true);
  });
  const [onRestored] = useState(() => () => setContextLost(false));

  // `setFrameloop` updates state but does not restart the rAF chain, which stopped itself
  // when we went to "never". Nudging it is the documented way back.
  useEffect(() => {
    if (!contextLost) invalidate();
  }, [contextLost]);

  return (
    <Canvas
      style={CANVAS_STYLE}
      gl={glConfig}
      dpr={q.dpr}
      shadows="soft"
      frameloop={contextLost ? "never" : "always"}
      eventSource={eventSource}
      eventPrefix="client"
      camera={ROOT_CAMERA}
      onCreated={handleCreated}
    >
      <FrameDriver />
      <StageRuntime onLost={onLost} onRestored={onRestored} />
      <View.Port />
      {children}
    </Canvas>
  );
}
