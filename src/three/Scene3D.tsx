/**
 * Scene3D — one rectangle of the app's single canvas.
 *
 * A game or the hub wraps its 3D content in `<Scene3D>`; the content is portalled into the
 * `Stage` canvas and scissored to a DOM rect, so only what is on screen costs anything.
 * Mounting and unmounting this is the whole lifecycle of "entering a game" — the renderer
 * never notices.
 *
 * Which rect? `track` if given, otherwise the element on `GameAreaContext`, which
 * `GameShell` provides. The `<View>` element is portalled *into* that element rather than
 * rendered wherever `<Scene3D>` happens to sit in the React tree, so a game can put
 * `<Scene3D>` anywhere inside its shell and still land in the play area.
 *
 * DOM overlays inside the tracked element must sit at `z-index: 1` or above: the view
 * layer is a real, pointer-accepting DOM element at `z-index: 0` covering the whole rect,
 * because that is where R3F attaches its pointer listeners for 3D picking.
 */
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { Group, PerspectiveCamera, type Camera, type Scene, type WebGLRenderer } from "three";
import { View } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { CAMERA } from "./tokens";
import { CameraRig } from "./camera";
import { flushSceneEviction } from "./dispose";
import { realNow, recordEvent, setViewDiagnosticsSource } from "../dev/perf";
import { route } from "./store";
import { ViewSlot } from "./view-slot";

/* ------------------------------------------------------------------ */
/* View metrics                                                        */
/* ------------------------------------------------------------------ */

export type ViewMetrics = { width: number; height: number };

/**
 * The tracked play areas, in mount order, with their **layout** size in CSS pixels.
 *
 * Why not `state.size` from inside the view? drei's `<View>` snapshots
 * `track.getBoundingClientRect()` into the portal's `size` once, in a `useEffect` keyed on
 * `track` — so it never refreshes on its own, and it is a *transformed* rect. The hub → game
 * panel is a framer-motion scale flip from 0.24 → 1, so every view mounts believing it is a
 * quarter of its real height, and anything that sizes itself from that (`hit.tsx`) comes out
 * four times too big and stays that way until an unrelated React re-render.
 *
 * `offsetHeight` and `ResizeObserver`'s content box are both layout measurements: a CSS
 * transform does not touch them. So this reports the size the view settles at, from the
 * first frame, all the way through the entry animation.
 */
const viewMetrics: { el: HTMLElement; size: ViewMetrics }[] = [];

/**
 * The play area's layout size, or null before any view is mounted. The *first* tracked view
 * wins: `GameShell` mounts the play area before the celebration overlay, so an overlay never
 * redefines what a tap target is measured against.
 */
export function playAreaMetrics(): ViewMetrics | null {
  return viewMetrics.length > 0 ? viewMetrics[0].size : null;
}

/* ------------------------------------------------------------------ */
/* View diagnostics — why a view drew nothing                          */
/* ------------------------------------------------------------------ */

/**
 * ## The defect this exists for
 *
 * Round 4 measured `draw calls 0 / triangles 0` for Tooth Runner and Smile Maker at a true
 * 390×844, with their DOM chrome laid out perfectly. `renderer.info` is summed across every
 * `gl.render` of the frame (`src/dev/perf.ts` turns `autoReset` off and resets once per
 * frame), so a zero there does not mean "mis-framed": it means **no view rendered at all**.
 *
 * drei's `<View>` skips its `gl.render` in exactly three states, and none of them said so
 * out loud before this:
 *
 *  1. the `<View>` element was never created — `Scene3D` resolved no portal host, so
 *     `track.current` is null, `rect.current` stays `undefined` and drei's `Container`
 *     never reaches its render branch;
 *  2. the tracked rect is off the canvas by drei's own predicate
 *     (`bottom < 0 || top > canvasH || right < 0 || left > canvasW`);
 *  3. the tracked rect is degenerate — a 0×0 `getBoundingClientRect()` makes drei write
 *     `camera.aspect = 0/0 = NaN`, `updateProjectionMatrix()` then fills the projection
 *     matrix with NaN, and `Frustum.setFromProjectionMatrix` rejects every object in the
 *     scene. Zero draw calls, zero triangles, a perfectly healthy DOM.
 *
 * State 1 was also *unrecoverable*: `host` was resolved once, from a passive effect keyed on
 * an identity-stable ref object, so a null there was permanent for the life of the mount and
 * silent. Both halves are fixed below — the resolution retries and then falls back to
 * rendering in place rather than rendering nothing, and every view publishes the three
 * predicates here so `?selftest=viewport` can name which one fired instead of a future round
 * arguing about an unexplained zero.
 */
export type ViewDiagnostic = {
  /** Route scene this view belongs to at the time of reading. */
  scene: string;
  /** False when no portal host could be resolved — failure mode 1. */
  hostResolved: boolean;
  /** True while the view is rendering in place because no host was found. */
  fallbackInPlace: boolean;
  /** Layout size of the tracked element (`offsetWidth/Height`) — immune to CSS transforms. */
  layout: ViewMetrics;
  /** Transformed rect drei actually reads, in client coordinates. */
  rect: { left: number; top: number; right: number; bottom: number; width: number; height: number };
  /** The canvas rect drei compares against — `Stage`'s canvas is `fixed; inset: 0`. */
  canvas: { width: number; height: number };
  /** drei's own offscreen predicate, recomputed from the same inputs — failure mode 2. */
  offscreen: boolean;
  /** True when the rect cannot produce a finite camera aspect — failure mode 3. */
  degenerate: boolean;
};

const ZERO_RECT = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };

type ViewRegistration = {
  scene: () => string;
  el: () => HTMLElement | null;
  hostResolved: () => boolean;
  fallbackInPlace: () => boolean;
};

const registrations = new Set<ViewRegistration>();

/** Every mounted `<Scene3D>`, with the three reasons drei can decline to draw it. */
export function viewDiagnostics(): ViewDiagnostic[] {  // eslint-disable-line no-use-before-define
  const canvas = {
    width: typeof window === "undefined" ? 0 : window.innerWidth,
    height: typeof window === "undefined" ? 0 : window.innerHeight,
  };
  const out: ViewDiagnostic[] = [];
  registrations.forEach((reg) => {
    const el = reg.el();
    const box = el ? el.getBoundingClientRect() : null;
    const rect = box
      ? {
          left: box.left,
          top: box.top,
          right: box.right,
          bottom: box.bottom,
          width: box.width,
          height: box.height,
        }
      : { ...ZERO_RECT };
    const aspect = rect.width / rect.height;
    out.push({
      scene: reg.scene(),
      hostResolved: reg.hostResolved(),
      fallbackInPlace: reg.fallbackInPlace(),
      layout: { width: el?.offsetWidth ?? 0, height: el?.offsetHeight ?? 0 },
      rect,
      canvas,
      offscreen:
        el === null ||
        rect.bottom < 0 ||
        rect.top > canvas.height ||
        rect.right < 0 ||
        rect.left > canvas.width,
      degenerate: !Number.isFinite(aspect) || aspect <= 0,
    });
  });
  return out;
}

/*
 * The frame sampler screams when a frame draws nothing; this is what tells it *why*. Pushed
 * rather than imported, because `perf.ts` cannot import this module back without a cycle.
 */
setViewDiagnosticsSource(viewDiagnostics);

/* ------------------------------------------------------------------ */
/* Game area                                                           */
/* ------------------------------------------------------------------ */

/**
 * The DOM rect a game's 3D content renders into. Provided by `GameShell`; consumed here.
 * This is a DOM-side context — 3D components inside the R3F root must not read it, they
 * read the module stores in `store.ts` instead.
 */
export const GameAreaContext = createContext<RefObject<HTMLElement | null> | null>(null);

export function useGameArea(): RefObject<HTMLElement | null> | null {
  return useContext(GameAreaContext);
}

/* ------------------------------------------------------------------ */
/* Camera                                                              */
/* ------------------------------------------------------------------ */

export type SceneCamera = {
  position: [number, number, number];
  target?: [number, number, number];
  fov?: number;
};

const ORIGIN: [number, number, number] = [0, 0, 0];

/** Long-lens miniature framing (§2). Distance 13.2 units, inside the 8–16 band. */
const DEFAULT_CAMERA: SceneCamera = { position: [0, 5.5, 12] };

const clampFov = (fov: number = CAMERA.fov) =>
  fov < CAMERA.fovRange[0] ? CAMERA.fovRange[0] : fov > CAMERA.fovRange[1] ? CAMERA.fovRange[1] : fov;

/** Below drei `<View>`'s default index of 1, so the camera is settled before the view draws. */
const CAMERA_PRIORITY = 0;

/**
 * Owns this view's camera and drives it with a `CameraRig`.
 *
 * Deliberately not drei's `<PerspectiveCamera makeDefault>`: that component allocates a
 * 256px FBO per instance whether or not you use its render-to-texture mode, which is a
 * render target and a disposal liability we get nothing for.
 *
 * Aspect ratio is left alone on purpose — drei's `View` rewrites `camera.aspect` from the
 * tracked rect every frame, and setting it here would only fight that.
 */
function ViewCamera({ position, target, fov }: { position: [number, number, number]; target: [number, number, number]; fov: number }) {
  const set = useThree((s) => s.set);
  const previous = useThree((s) => s.camera);

  const camera = useMemo(
    () => new PerspectiveCamera(clampFov(), 1, CAMERA.near, CAMERA.far),
    []
  );
  const rig = useMemo(() => new CameraRig(camera), [camera]);
  const mounted = useRef(false);

  useLayoutEffect(() => {
    const restore = previous;
    set(() => ({ camera }));
    return () => {
      set(() => ({ camera: restore }));
    };
    // `previous` is intentionally read once: re-running this would restore the camera we
    // ourselves installed. Same reasoning as drei's own makeDefault handling.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera, set]);

  useEffect(() => () => rig.dispose(), [rig]);

  const [px, py, pz] = position;
  const [tx, ty, tz] = target;

  // Primitive deps, never the arrays: the caller almost certainly rebuilds the literal on
  // every render, and re-firing `focus()` per render would restart the wind-up every time.
  useEffect(() => {
    if (camera.fov !== fov) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
    if (mounted.current) {
      rig.focus(px, py, pz, tx, ty, tz);
    } else {
      rig.setBase(px, py, pz, tx, ty, tz, true);
      mounted.current = true;
    }
  }, [camera, rig, px, py, pz, tx, ty, tz, fov]);

  useFrame((state, dt) => {
    rig.update(dt, state.clock.elapsedTime);
  }, CAMERA_PRIORITY);

  return <primitive object={camera} />;
}

/* ------------------------------------------------------------------ */
/* Shader precompilation                                               */
/* ------------------------------------------------------------------ */

/**
 * Runs before the camera and before drei's `<View>` render, so a program compiled here is
 * warm by the time the frame that needs it is drawn.
 */
const PRECOMPILE_PRIORITY = CAMERA_PRIORITY - 0.5;
/** One pass on the first frame, one more for anything that mounted a beat later. */
const PRECOMPILE_PASSES = 2;
/** Give up waiting for the rig's environment after this many frames and compile anyway. */
const PRECOMPILE_PATIENCE = 12;

/**
 * Warms every program this view needs, in one place, before the first frame that uses one,
 * and — the part that did not exist before — **measures what that cost**.
 *
 * Without this pass a game's entry compiles 23–27 `MeshPhysicalMaterial` variants cold, in
 * the frame the child is looking at. This runs at priority -0.5, drei's `<View>` renders at
 * its `index` (1 by default), so the compile is genuinely first within the frame.
 *
 * It waits for `scene.environment`, because `Rig` installs the PMREM in a passive effect and
 * compiling before that produces programs with the wrong defines: a wasted compile and,
 * worse, a second live program per material for the memory budget to carry.
 *
 * ## Why it is measured, and what the measurement does and does not settle
 *
 * `3D-SPEC §9` allows "scene entry hitch ≤ 1 dropped frame". The round-3 audit could not
 * grade that, because the compile cost was never separated from the rest of the entry
 * window — the file asserted "15–60 ms per variant on Mali/Adreno" in a comment and nothing
 * anywhere measured it. `recordEvent` now publishes the real elapsed cost and the number of
 * programs it bought, in `window.__perf.snapshot().events`, inside the entry mark's window.
 *
 * Two caveats, both of which a reader of that number needs, and both checked against three
 * r170's source rather than assumed:
 *
 *  - **The event is the *issue* cost, not the whole compile.** `gl.compile` ends at
 *    `gl.linkProgram` (`WebGLProgram`, `three.module.js` ~20317). The calls that actually
 *    wait for the driver — `getProgramParameter(ACTIVE_UNIFORMS)` via `new WebGLUniforms`
 *    and `fetchAttributeLocations` — are deferred to `onFirstUse`, which the renderer
 *    reaches at the first *draw* with that material. So the link wait lands in the frame
 *    after this event, in the same entry window, and shows up in that mark's `worstMs`. The
 *    event and the mark have to be read together; neither alone is the entry hitch.
 *    The `+parallel` tag says whether `KHR_parallel_shader_compile` is present, which is the
 *    difference between a driver that links on a worker thread and one that does not.
 *  - **Moving the stall off the entry frame is not something this component can do, and the
 *    prefetch cannot do it either.** It mounts *with* the view, and drei renders that view
 *    from the same frame, so there is no wall-clock room between compiling and drawing —
 *    `compileAsync` would change nothing, because the first draw still forces `onFirstUse`.
 *
 *    The round-4 fix list asked for `warmScene()` to be called from the hub's
 *    hover/focus/pointerdown prefetch instead. It cannot be: `gl.compile(scene, camera)`
 *    needs a **scene**, and a game's scene is built by React when its component mounts — it
 *    does not exist while its chunk is downloading. Compiling a stand-in scene is worse than
 *    not compiling: three keys a program on the full material *and lighting and shadow*
 *    permutation, so a warm-up rig that differs from the real one in any define buys a
 *    second live program per material and nothing else. That is exactly the defect Smile
 *    Maker's render-target warm-up was filed for (SM4, +6 programs).
 *
 *    So `warmScene` is called from the one place it can be — `Precompile` below, at priority
 *    -0.5, before drei's view renders — and the prefetch takes the half of the entry cost it
 *    genuinely can: `GamesCollection.prefetchGame()` and `Stage`'s boot warm-up build the
 *    shared procedural textures (a 256² four-octave fbm lattice, ~262 k evaluations) ahead of
 *    time. What the compile then costs is measured rather than asserted, per game, per pass,
 *    with the driver's parallel-link capability tagged: on the round-4 captures it is
 *    1.2–7.2 ms against a Smile Maker entry frame of 299 ms, so on that hardware it is not
 *    the lever. On a driver without off-thread linking it may be; the event says which.
 *
 * `gl.compile` allocates. That is fine and deliberate here — it runs at most twice per view,
 * never in the steady state, and the ref guard makes that structural rather than a promise.
 */

/** `true` when the driver links shaders off-thread. See the caveats above. */
function hasParallelCompile(gl: WebGLRenderer): boolean {
  const ctx: unknown = gl.getContext();
  if (!(ctx instanceof WebGLRenderingContext) && !(ctx instanceof WebGL2RenderingContext)) {
    return false;
  }
  return ctx.getExtension("KHR_parallel_shader_compile") !== null;
}

/**
 * Compiles every program a scene needs and reports what it cost, as a `compile:<label>`
 * event on `window.__perf`.
 *
 * Exported so the hub's chunk prefetch can warm a game's shaders while the dive animation is
 * running, which is the only place the cost can actually be hidden. Safe to call more than
 * once: three's program cache makes a second call over the same scene close to free, and the
 * event it records will say so (`count: 0`).
 */
export function warmScene(gl: WebGLRenderer, scene: Scene, camera: Camera, label: string): void {
  const before = gl.info.programs?.length ?? 0;
  const t0 = realNow();
  gl.compile(scene, camera);
  const ms = realNow() - t0;
  recordEvent(`compile:${label}`, ms, (gl.info.programs?.length ?? 0) - before);
}

function Precompile() {
  const passes = useRef(0);
  const waited = useRef(0);

  useFrame((state) => {
    if (passes.current >= PRECOMPILE_PASSES) return;
    if (state.scene.environment === null && waited.current < PRECOMPILE_PATIENCE) {
      waited.current++;
      return;
    }
    const pass = passes.current++;
    // The second pass exists to catch anything that mounted a beat later; it normally
    // compiles nothing, and its event says so. Both are labelled so a capture can tell them
    // apart instead of seeing one number of unknown provenance.
    // Named from the route so the event says which scene paid, and tagged with whether the
    // driver links off-thread, because that decides how to read the number.
    const scene = route.get().gameId ?? route.get().screen;
    warmScene(
      state.gl,
      state.scene,
      state.camera,
      `${scene}#${pass}${hasParallelCompile(state.gl) ? "+parallel" : ""}`
    );
  }, PRECOMPILE_PRIORITY);

  return null;
}

/* ------------------------------------------------------------------ */
/* Scene3D                                                             */
/* ------------------------------------------------------------------ */

const VIEW_STYLE: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  zIndex: 0,
  // R3F attaches its pointer listeners to this element, so it has to accept them.
  pointerEvents: "auto",
};

export function Scene3D({
  children,
  camera,
  track,
  className,
  index = 1,
}: {
  children: ReactNode;
  camera?: SceneCamera;
  track?: RefObject<HTMLElement | null>;
  className?: string;
  index?: number;
}): JSX.Element {
  const area = useGameArea();
  const target = track ?? area;
  const [host, setHost] = useState<HTMLElement | null>(null);
  /**
   * Set when the host could not be resolved even after retrying. The view then renders where
   * it sits instead of not rendering at all — a mis-placed scene is a bug, a scene that never
   * reaches the framebuffer is a game a child cannot play (A8).
   */
  const [giveUp, setGiveUp] = useState(false);
  const viewElRef = useRef<HTMLElement | null>(null);

  /*
   * The reclaim, on its own effect and keyed on nothing.
   *
   * It used to live inside the host-resolution effect, which meant a mount that never
   * resolved a host also never reclaimed the departing scene's caches. Separating them makes
   * the reclaim unconditional: this is still the one moment at which nothing can be drawing
   * with the outgoing game's geometry, materials or textures.
   */
  useEffect(
    () => () => {
      flushSceneEviction();
    },
    []
  );

  // A *passive* effect, not a layout effect: React attaches a host element's ref while
  // walking up the tree, so an ancestor's ref is still null when a descendant's layout
  // effect runs. By the time passive effects flush, every ref from the commit is attached.
  //
  // ...and it retries. A single read of `target.current` that happens to come back null was
  // permanent and silent, because `target` is an identity-stable ref object and this effect
  // is keyed on it: the portal was never created, drei never registered a render for the
  // view, and the game drew literally nothing for the rest of its life while its DOM chrome
  // laid out perfectly. See `ViewDiagnostic` above.
  useEffect(() => {
    let raf = 0;
    let attempts = 0;
    const HOST_RETRY_FRAMES = 8;

    const resolve = () => {
      const el = target?.current ?? null;
      if (el) {
        setHost(el);
        setGiveUp(false);
        return;
      }
      if (++attempts <= HOST_RETRY_FRAMES) {
        raf = requestAnimationFrame(resolve);
        return;
      }
      console.error(
        "[Scene3D] no portal host after " +
          `${HOST_RETRY_FRAMES} frames — the tracked element never attached its ref. ` +
          "Rendering the view in place so the scene still reaches the framebuffer; " +
          "run ?selftest=viewport for the full diagnostic."
      );
      setGiveUp(true);
    };
    resolve();

    return () => {
      if (raf !== 0) cancelAnimationFrame(raf);
    };
  }, [target]);

  useEffect(() => {
    const el = host;
    if (!el) return;

    // Publish the *layout* size for `hit.tsx`. Measured now and kept current by a
    // ResizeObserver, both of which report the content box and so are immune to the entry
    // animation's CSS scale. See `viewMetrics` above for why drei's own `size` is not usable.
    const entry = { el, size: { width: el.offsetWidth, height: el.offsetHeight } };
    viewMetrics.push(entry);
    const observer = new ResizeObserver(() => {
      entry.size.width = el.offsetWidth;
      entry.size.height = el.offsetHeight;
    });
    observer.observe(el);

    // `<View>` lays its element out absolutely, which only lines up with the tracked rect
    // if the tracked element is a containing block. Fix it here rather than making every
    // caller remember.
    const wasStatic = getComputedStyle(el).position === "static";
    const restore = el.style.position;
    if (wasStatic) el.style.position = "relative";

    return () => {
      observer.disconnect();
      const at = viewMetrics.indexOf(entry);
      if (at >= 0) viewMetrics.splice(at, 1);
      if (wasStatic) el.style.position = restore;
    };
  }, [host]);

  /*
   * Register with the diagnostic so `?selftest=viewport` can say *which* of drei's three
   * skip conditions fired for a view that drew nothing. The registration reads through
   * closures rather than snapshotting, so it is always current and never re-registers.
   */
  useEffect(() => {
    const registration: ViewRegistration = {
      scene: () => route.get().gameId ?? route.get().screen,
      el: () => viewElRef.current ?? host,
      hostResolved: () => host !== null,
      fallbackInPlace: () => host === null && giveUp,
    };
    registrations.add(registration);
    return () => {
      registrations.delete(registration);
    };
  }, [host, giveUp]);

  const config = camera ?? DEFAULT_CAMERA;
  const view = (
    <View
      index={index}
      className={className}
      style={VIEW_STYLE}
      /*
        drei reads this element's `getBoundingClientRect()` every frame and drives both the
        scissor and `camera.aspect` from it. Holding a reference to it is what lets
        `viewDiagnostics()` report the exact rect drei saw rather than a rect we assume it
        saw — the difference between naming a zero-draw-call frame and guessing at it.
      */
      ref={(node: HTMLElement | Group | null) => {
        viewElRef.current = node instanceof HTMLElement ? node : null;
      }}
    >
      <ViewCamera
        position={config.position}
        target={config.target ?? ORIGIN}
        fov={clampFov(config.fov)}
      />
      {children}
      {/*
        The shell's celebration renders *here*, inside the game's own view, so that it shares
        this view's scene, camera, depth buffer and `<Rig>` — see `view-slot.tsx`. Only a
        game's view hosts it: the hub and the dev probe pass an explicit `track`, and a
        celebration has no business in either.
      */}
      {track ? null : <ViewSlot />}
      {/* Last, so every sibling subtree is already in the scene graph when it first runs. */}
      <Precompile />
    </View>
  );

  // With a tracked element we portal into it. Without one (no `track`, no `GameShell`) the
  // view renders where it sits and is sized by `className`.
  //
  // `giveUp` is the third branch and it is deliberately *not* `null`: a view that renders
  // nowhere renders nothing, which is how two of nine games shipped a blank play area at
  // phone size. Rendering in place is wrong-looking and reportable; rendering nothing is
  // invisible and unplayable.
  if (!target || giveUp) return view;
  return <>{host ? createPortal(view, host) : null}</>;
}
