/**
 * Count the Teeth — `?selftest=count`.
 *
 * 3D-SPEC §6.7: *"the layout generator renders per-tooth IDs to an offscreen target from
 * the actual game camera and resamples until every tooth is ≥75% unoccluded. Not 'checked
 * from above' — from the game camera."*
 *
 * That guarantee is now enforced in two places, and it matters which does what.
 *
 *  • **`layout.ts` enforces it, on every board, on the CPU.** `solveScatter` will not return
 *    a board until `auditScatter` proves that every pair of tooth silhouettes is disjoint on
 *    screen, in the camera's real perspective, with a clear channel between them, and that no
 *    tooth is outside the visible frame. Disjoint silhouettes are 100% unoccluded, so the
 *    spec's 75% is not a threshold this game aims at — it is a floor it cannot approach.
 *  • **This file audits that claim against pixels.** It is the empirical authority, and it is
 *    the thing that would catch a mistake in the analysis: it sees the true silhouette rather
 *    than a bounding box, the board and the tiles as occluders, and the frame edges.
 *
 * Round 1 had this the other way round — `measure()` ran up to four times *inside* `useFrame`
 * on every round, which is `1 + ceil(n/4)` synchronous `readRenderTargetPixels` calls per
 * attempt: about twenty full pipeline flushes in a single frame, 200–500 ms of freeze on a
 * tile-based mobile GPU, and then the game shipped whatever board it had ended up with. The
 * expensive check now runs only here, and the cheap check is the one that is never skipped.
 *
 * How the measurement gets an honest answer:
 *
 *  • The teeth that are measured are **probe meshes**, not the `InstancedMesh` the player
 *    sees. `occlusionRatios()` distinguishes objects by tagging their meshes, and an
 *    instanced mesh is a single mesh — fourteen instances would come back as one number.
 *    So the scene carries fourteen probe meshes that share the tooth geometry, sit
 *    `visible = false` outside a measurement, and exist only when a self test is requested.
 *  • The real instanced teeth *and their faces* are hidden for that duration, or they would
 *    paint themselves over the probes as untagged occluders and every ratio would read zero.
 *  • So would the `HitTarget` colliders. They are ordinarily invisible *by material*
 *    (`material.visible = false`) rather than by object, and `occlusionRatios` replaces
 *    every material in the scene with its own — which would turn three 48-pixel spheres
 *    into solid black occluders sitting between the camera and the board. Same for the
 *    additive sparkles and the contact blobs. The scene keeps all of them under one group
 *    and `mask()` hides that group.
 *  • Everything that legitimately occludes — the clay board, the terracotta pad, the
 *    answer tiles, the ground — stays visible, because a tooth hidden behind the board's
 *    own edge is exactly the failure this test exists to catch.
 */
import { SRGBColorSpace, WebGLRenderTarget, type Camera, type Object3D, type WebGLRenderer } from "three";
import {
  disposeSelfTestResources,
  occlusionRatios,
  readRenderTarget,
  registerSelfTest,
  type SelfTestResult,
} from "../../dev/selftest";
import { trackRenderTarget, untrackRenderTarget } from "../../three/dispose";
import { GAMES } from "../index";
import { RANGE } from "./engine";
import { countedMascotGeometry, mascotCloud } from "./face";
import {
  ACCENT,
  MAT_FLOOR,
  MAT_FLOOR_TOLERANCE,
  MAX_COUNT,
  PIP_COUNT,
  PIP_H,
  PIP_R,
  PIP_Y,
  TILE_D,
  TILE_PITCH,
  TILE_T,
  TILE_W,
  auditScatter,
  cameraFor,
  checkSilhouette,
  createScatter,
  describeArrangement,
  mulberry32,
  pipX,
  projectPoint,
  solveScatter,
  sweepSilhouette,
  toothNdcBox,
  visibleTop,
  SCALE_MIN,
  type BoardMetrics,
  type CameraFraming,
  type NdcBox,
  type Scatter,
  type ScatterMetrics,
} from "./layout";

/** A tooth must keep at least this much of its own silhouette to be countable. */
export const MIN_UNOCCLUDED = 0.75;

/**
 * ID-buffer resolution.
 *
 * The target is square while the play area rarely is, which is deliberate — the camera's
 * projection is untouched, so every occlusion relationship is exactly the player's, and
 * only the pixel aspect differs (both passes share it, so the ratio is exact). The size is
 * chosen for the *worst* aspect: on a phone held upright a tooth still covers about 18 x 10
 * texels, so one texel is well under 1% of its silhouette. Each of the `1 + ceil(n/4)`
 * synchronous readbacks is 147 kB.
 */
export const PROBE_SIZE = 192;

/**
 * The live scene's hooks into its own probe rig. The scene owns this object, hands it over
 * once, and drops it on unmount; the self test borrows it.
 */
export type ProbeRig = {
  gl: WebGLRenderer | null;
  camera: Camera | null;
  /** `MAX_COUNT` probe meshes, parked invisible. */
  probes: Object3D[];
  /** Poses probes `0..scatter.count-1` from a scatter. */
  place: (scatter: Scatter, probes: Object3D[]) => void;
  /** Hides everything that must not act as an occluder during a measurement. */
  mask: () => void;
  unmask: () => void;
  metrics: ScatterMetrics;
  framing: CameraFraming;
  board: BoardMetrics;
  /** What `clayTray` actually built, as the scene measured it. See `MAT_FLOOR`. */
  well: { floor: number; insetX: number; insetZ: number };
};

let live: ProbeRig | null = null;

/**
 * Publishes the live rig and returns the function that retracts it.
 *
 * The renderer-sized ID target `occlusionRatios` allocates belongs to whoever asked for it
 * (FOUNDATION-NOTES §12); releasing the rig frees it, so leaving the game cannot push the hub
 * baseline up (S6).
 */
export function setProbeRig(rig: ProbeRig): () => void {
  live = rig;
  return () => {
    if (live === rig) live = null;
    disposeSelfTestResources();
  };
}

/** Reused so a measurement does not churn the heap. */
const subset: Object3D[] = [];
/** Per-tooth visible fractions from the last `measure()`. Reused, never reallocated. */
const ratios: number[] = [];

/**
 * Renders the probe rig's first `count` teeth as IDs from `rig.camera` and writes every
 * per-tooth visible fraction into `ratios`, returning the smallest. 1 means nothing is hidden
 * at all; 0 means a tooth is entirely behind something or off screen.
 *
 * The whole array is kept, not just the minimum, because "worst tooth 36.9 % unoccluded" is
 * not a reproducible defect report — "tooth 9 of 14 at 36.9 %, its neighbours at 100 %" is.
 *
 * Synchronous and readback-bound — `1 + ceil(count / 4)` of them. Never call it from a frame.
 */
export function measure(rig: ProbeRig, count: number): number {
  ratios.length = 0;
  if (count <= 0) return 1;
  const gl = rig.gl;
  const camera = rig.camera;
  const probes = rig.probes;
  // Fail *closed*. If the rig cannot answer — no renderer yet, no camera yet, fewer probes
  // than teeth — the honest report is "not proven".
  if (!gl || !camera || probes.length < count) return 0;

  rig.mask();
  const n = count;

  subset.length = 0;
  for (let i = 0; i < n; i++) {
    probes[i].visible = true;
    subset.push(probes[i]);
  }

  let worst = 1;
  try {
    const measured = occlusionRatios(gl, camera, subset, PROBE_SIZE);
    for (let i = 0; i < measured.length; i++) {
      const r = measured[i] > 1 ? 1 : measured[i];
      ratios.push(r);
      if (r < worst) worst = r;
    }
  } finally {
    for (let i = 0; i < n; i++) probes[i].visible = false;
    subset.length = 0;
    rig.unmask();
  }
  return worst;
}

/** The per-tooth fractions from the last `measure()`, as a percentage list. */
const ratioReport = (): string =>
  ratios.map((r, i) => `${i}:${(r * 100).toFixed(1)}%`).join(" ");

/* ------------------------------------------------------------------ */
/* Self test                                                           */
/* ------------------------------------------------------------------ */

/**
 * Three sweeps, because they answer different questions and cost wildly different amounts.
 *
 * The **analytic** sweep is free (no GPU, no readback), so it runs a lot of boards and proves
 * the property the solver claims across every viewport the shell can produce — not only the
 * one that happens to be on screen. 11 rects x 17 (level, count) pairs x 120 seeds is 22,440
 * boards in a few tens of milliseconds. Measured, on the shipped layout: 0 ambiguous, worst
 * pair exactly 1.00x the required gap, no board falling past the "free" placement rung.
 *
 * The **framing** sweep is the one round 1 failed and round 3 failed again: it asserts that
 * every answer tile projects wholly inside the play rect **and** that its 48 px collider does
 * too, at every aspect — 0.462 to 2.14 — on every level, at three chrome bands. The blocker was measured as
 * "201 tile-ivory pixels on the final rendered row" — a control bisected by the bottom of the
 * viewport is not a 48 px target however big its collider is.
 *
 * The **rendered** sweep is the one the spec names, and costs `1 + ceil(n/4)` synchronous
 * readbacks a board, so it runs fewest: 17 pairs x 4 seeds plus the pinned regression board
 * below = 69, each photographed from the live game camera with per-tooth ID colours.
 */
const ANALYTIC_SEEDS = 60;
/**
 * Chrome bands the countability sweep is run at.
 *
 * Two, not one: the invariant has to hold both on the roomy framing the old sweep used and on
 * the cramped one a real phone produces, and those are *different boards* now — the grid shape
 * and the world scale are both solved against the band. `ANALYTIC_SEEDS` is halved to 60 so
 * the sweep costs the same 22,440 boards it always did, spent where they say more.
 */
const ANALYTIC_BANDS: readonly number[] = [138, 273];
const GPU_SEEDS = 4;
/** Yield to the browser this often so the page keeps painting while the sweep runs. */
const YIELD_EVERY = 4;

/**
 * Viewport rects the shell can hand a game, from a phone held upright to a wide desktop —
 * including the two letterboxed shapes the round-1 capture harness produced.
 */
const RECTS: readonly (readonly [number, number])[] = [
  // A true iPhone 14/15 play area, aspect 0.462. Round 3's phone capture is the reason it is
  // here: at that aspect the four-column shapes could not hold the board, the solve dropped
  // its only *preferred* bound, and the mat shipped guillotined by both side edges.
  [390, 844],
  [360, 640],
  [420, 760],
  [700, 1050],
  [822, 674],
  [900, 900],
  [1100, 562],
  [1300, 663],
  [1440, 820],
  // Aspect 1.829 — the desktop capture's own shape, named in round 3's fix list.
  [1500, 820],
  [1500, 700],
];

/** Clear space every answer tile must keep between itself and the frame edge, in NDC. */
const TILE_FRAME_MARGIN = 0.005;

/**
 * Height of the hit target's centre above the tile, and the tap target §1.5 / §8 demand.
 *
 * A tile whose *body* is inside the frame can still have half its collider off screen, and a
 * collider that is off screen is not a 48 px target however big `minScreenPx` says it is —
 * which is round 3's B7.4 at a true 390 x 844, where both outer tiles were clipped. The frame
 * is 2 units of `projectPoint`'s `y` tall over `h` CSS px, so 24 px of clearance is `48 / h`
 * in those units, and the space is aspect-corrected so the same length works on both axes.
 */
const HIT_Y = TILE_T + 0.12;
const TAP_TARGET_PX = 48;

/**
 * Chrome-band heights the framing sweep is run at, in CSS px.
 *
 * `GameShell` measures its own title + HUD band and publishes it as `--chrome-h`, so the
 * live solve uses a real number rather than `CHROME_PX`. That number moves with the HUD a
 * game asks for, with the viewport's type scale, and — the case that mattered — with whether
 * the difficulty row wraps the chip group onto a second line.
 *
 * ## This list was too short, and that is why CT1 shipped
 *
 * It used to read `[110, 138, 172]`. The band on a 390 x 844 phone is **~273 px**, and it is
 * arithmetic rather than a guess: `header` = `pt-6` 24 + a two-line 27 px title at 1.15 (62)
 * + `mt-1` 4 + a two-line 15 px subtitle (45) + `pb-1.5` 6 = 141; `hud` = `pt-2.5` 10 + the
 * 58 px difficulty group + a 10 px wrap gap + a 38 px chip row + `pb-4` 16 = 132. At 360 px
 * of shell the title can take a third line, which is another ~31.
 *
 * So the sweep asserted a property over a range of bands that **excluded every real phone**,
 * and `cameraFor`'s "unreachable" fallback — which fires at a phone shape from about 170 px
 * of band upward — was never once exercised by it. Round 4 photographed the consequence: a
 * counted tooth behind the difficulty pills. A self-check narrower than the thing it claims
 * to enforce is exactly what A12 exists for; this is the same defect one folder down.
 *
 * ## …and a band range that is *wider* than reality is not honest either
 *
 * The first attempt swept every band at every rect, which asked the solve to hold a 330 px
 * band on an 1100 x 562 landscape shell — 59 % of the frame, and a combination `GameShell`
 * cannot produce. A check that fails on an impossible input teaches nothing, and a check
 * that is silently relaxed to make it pass teaches worse.
 *
 * So the range is a function of the shell's **width**, derived from the same CSS the numbers
 * above come from. The band only grows past ~200 px when a row wraps, and both wraps need a
 * narrow shell:
 *
 *  - the **HUD row** wraps when the difficulty group (~246 px) plus the chip group (~170 px)
 *    plus their 10 px gap exceed the row's content width (`width − 48` for `px-6`): below
 *    about **474 px**;
 *  - the **title** wraps when its block — `width − 48 − 110 (two 50 px buttons and a 10 px
 *    gap) − 12` — drops under "Count the Teeth" at 27 px semibold (~205 px) or the subtitle
 *    at 15 px (~210 px): below about **380 px**.
 *
 * 520 is that boundary with margin. Above it the band tops out around 200; below it, at the
 * ~273 px a 390 px phone measures, with 300 for slack.
 */
const WIDE_CHROME_BAND: readonly number[] = [110, 138, 172, 200];
const NARROW_CHROME_BAND: readonly number[] = [110, 138, 172, 220, 273, 300];
/** Shell width below which `GameShell`'s HUD row and title can both wrap. See above. */
const CHROME_WRAP_WIDTH = 520;
const chromeBandsFor = (width: number): readonly number[] =>
  width >= CHROME_WRAP_WIDTH ? WIDE_CHROME_BAND : NARROW_CHROME_BAND;

/**
 * Smallest a counted tooth may be on screen, in CSS px, measured as its projected box height.
 *
 * §3.7 asks for a board a four-year-old can count in three seconds, and this is the quantity
 * that decides it. 40 px is the smallest prop this product asks a child to *identify* rather
 * than *hit*: the 48 px floor in §1.5 and §8 is a tap target, the teeth are not tapped, and
 * the answer tiles keep their own floor through `minScreenPx`.
 *
 * It is a real bar, and it did real work. On its first run it failed at **37.6 px** — a Hard
 * board on a 360 x 640 shell under a 273 px band — and the fix was `SHORT_GRIDS`' 5 x 3 in
 * `layout.ts`, not a smaller number here. Worst case across every rect and every producible
 * band is now 42.2 px.
 */
const MIN_TOOTH_PX = 40;

const nextFrame = () =>
  new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });

/** The scene mounts asynchronously; the auto-run debounce may still beat it. */
async function waitForRig(timeoutMs: number): Promise<ProbeRig | null> {
  const deadline = performance.now() + timeoutMs;
  while (live === null || live.gl === null || live.camera === null) {
    if (performance.now() > deadline) return null;
    await nextFrame();
  }
  return live;
}

const fail = (detail: string): SelfTestResult => ({ name: "count", pass: false, detail });

/** Every corner of every answer tile, in the order the failure message wants to name them. */
function worstTileCorner(f: CameraFraming, b: BoardMetrics): { slack: number; where: string } {
  const out = { x: 0, y: 0 };
  const top = visibleTop(f);
  let slack = Infinity;
  let where = "";
  for (let i = 0; i < 3; i++) {
    const x = (i - 1) * TILE_PITCH;
    for (let cx = -1; cx <= 1; cx += 2) {
      for (let cz = -1; cz <= 1; cz += 2) {
        for (let cy = 0; cy <= 1; cy++) {
          projectPoint(
            f,
            x + (cx * TILE_W) / 2,
            cy * TILE_T,
            b.tileZ + (cz * TILE_D) / 2,
            out
          );
          const margins = [f.aspect - out.x, f.aspect + out.x, 1 + out.y, top - out.y];
          for (let k = 0; k < margins.length; k++) {
            if (margins[k] < slack) {
              slack = margins[k];
              where = `tile ${i} corner (${cx > 0 ? "+" : "-"}x, ${cz > 0 ? "+" : "-"}z, ${
                cy === 0 ? "base" : "top"
              }) ${["right", "left", "bottom", "top"][k]} edge`;
            }
          }
        }
      }
    }
  }
  return { slack, where };
}

/**
 * The screen box of the round pips, as a hull over all five sockets.
 *
 * B7.5's assertion lives here: no tooth's silhouette box may touch it. The old back rail put
 * two of five pips under a tooth's head on every desktop capture at every level, and nothing
 * in the product could have noticed — the countability proof cares about teeth occluding each
 * other and about the frame edges, and a pip is neither.
 */
function pipNdcBox(out: NdcBox, f: CameraFraming, b: BoardMetrics): void {
  const p = { x: 0, y: 0 };
  out.x0 = Infinity;
  out.x1 = -Infinity;
  out.y0 = Infinity;
  out.y1 = -Infinity;
  for (let i = 0; i < PIP_COUNT; i++) {
    for (let sx = -1; sx <= 1; sx += 2) {
      for (let sz = -1; sz <= 1; sz += 2) {
        for (let sy = 0; sy <= 1; sy++) {
          projectPoint(f, pipX(i) + sx * PIP_R, PIP_Y + sy * PIP_H, b.pipZ + sz * PIP_R, p);
          if (p.x < out.x0) out.x0 = p.x;
          if (p.x > out.x1) out.x1 = p.x;
          if (p.y < out.y0) out.y0 = p.y;
          if (p.y > out.y1) out.y1 = p.y;
        }
      }
    }
  }
}

/** Overlap of two boxes on the axis they overlap least. <= 0 means they are disjoint. */
const boxOverlap = (a: NdcBox, c: NdcBox): number => {
  const dx = Math.min(a.x1, c.x1) - Math.max(a.x0, c.x0);
  const dy = Math.min(a.y1, c.y1) - Math.max(a.y0, c.y0);
  return dx < dy ? dx : dy;
};

const scratchPipBox: NdcBox = { x0: 0, x1: 0, y0: 0, y1: 0 };
const scratchToothBox: NdcBox = { x0: 0, x1: 0, y0: 0, y1: 0 };

/**
 * The fraction of a tooth's silhouette that is behind `GameShell`'s chrome, 0..1.
 *
 * ## Why this is here and not on the GPU
 *
 * §6.7's rendered proof is an offscreen **ID render of the 3D scene**. A frosted difficulty
 * pill is a DOM element; it is not in that scene, and no amount of resolution will put it
 * there. So the same build that shipped `count-the-teeth-phone.png` — a counted tooth whose
 * crown is behind the difficulty row and whose face is behind the timer chip — reported
 * "worst tooth 99.4 % unoccluded", truthfully, about a different question. CT1.
 *
 * The keep-clear rect *is* published in the camera's own units (`CameraFraming.chromeSpan`
 * and `visibleTop`), so the occluder can simply be intersected with the tooth's box. Two
 * things make that the right call rather than a shortcut:
 *
 *  - it is **conservative**. `toothNdcBox` is the axis-aligned hull of the silhouette, so the
 *    overlap it reports is at least the true one: this check can fail a board the pixels
 *    would pass, never the reverse.
 *  - it runs in the **analytic** sweep, which covers 22,440 boards across every viewport,
 *    level and chrome band — where the rendered sweep photographs 69. A DOM occluder is now
 *    checked on three orders of magnitude more boards than the GPU pass could reach.
 *
 * The alternative — a camera-facing proxy quad added to the scene so `occlusionRatios` counts
 * it — was rejected on evidence rather than taste: it needs matrix plumbing whose only
 * verification is a rendered frame, and this round has no browser.
 */
function chromeOverlapFraction(box: NdcBox, f: CameraFraming): number {
  const top = visibleTop(f);
  const w = box.x1 - box.x0;
  const h = box.y1 - box.y0;
  if (w <= 0 || h <= 0) return 0;
  const dx = Math.min(box.x1, f.chromeSpan.right) - Math.max(box.x0, f.chromeSpan.left);
  // The rect runs from the keep-clear floor to the top of the frame.
  const dy = Math.min(box.y1, 1) - Math.max(box.y0, top);
  if (dx <= 0 || dy <= 0) return 0;
  return (dx * dy) / (w * h);
}


/* ------------------------------------------------------------------ */
/* The surfaces, measured in the pixels a child sees                   */
/* ------------------------------------------------------------------ */

/**
 * `3D-SPEC §8` floor for a graphical object against its background.
 *
 * The calibration in `scene.tsx::PAD_WHITE_BALANCE` aims at 3.20 so that this has headroom;
 * a pass at exactly 3.00 means something has drifted and the margin is gone.
 */
const MIN_SURFACE_CONTRAST = 3;
/** Resolution of the surface render. Only medians are taken, so this is plenty. */
const SURFACE_SIZE = 256;
/** A classification needs this many pixels before it is allowed to assert anything. */
const MIN_SURFACE_PIXELS = 400;

type SurfaceResult = { pass: boolean; detail: string; data: Record<string, number | string> };

/** WCAG 2.1 relative luminance from 8-bit sRGB, its own transfer curve. */
function luminance8(r: number, g: number, b: number): number {
  const ch = (v: number) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}

const contrast = (a: number, b: number): number =>
  (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

const median = (xs: number[]): number => xs[xs.length >> 1];

/**
 * Renders the live board and measures the two contrasts this game's calibrations claim.
 *
 * ## Why this exists
 *
 * Round 4, CT4: `PAD_WHITE_BALANCE`'s comment asserted "3.20:1" between the coral field and
 * an ivory crown. Measured off the round-4 capture, 3.20 is the **90th-percentile** crown
 * pixel; the median is 3.03 and the shaded decile 2.50. The comment was not lying about a
 * number, it was quoting the wrong statistic — and nothing in the product could tell, because
 * nothing in the product had ever looked. Round 4, CT6, made the mirror error in the other
 * direction: the numerals were reported at "3.80:1" from the two *tokens*, where the rendered
 * pair measures 4.05.
 *
 * Every contrast claim in this folder is now settled the same way §6.7's occlusion claim is:
 * by rendering the thing and counting pixels. A comment can go stale; this cannot.
 *
 * ## How the classification stays honest
 *
 * The scene is rendered as the player sees it — real materials, real lights, real tone map,
 * into an sRGB target, so the bytes are the bytes on screen. Pixels are then bucketed by
 * colour, not by position, which is what makes it robust to the framing having moved:
 *
 *  - **coral field**: strongly red-dominant (`r - max(g,b) > 60`) and mid-luminance;
 *  - **crown**: bright and near-neutral-warm (`r - b < 60`, all channels high);
 *  - **numeral**: red-dominant like the coral but *darker* than it, which is the only thing
 *    in the frame that is;
 *  - **plate**: the brightest near-neutral band, i.e. the crowns' own bucket restricted to
 *    the answer row's half of the frame.
 *
 * A bucket with fewer than `MIN_SURFACE_PIXELS` members asserts nothing and says so —
 * `UNMEASURED`, never an invented pass. That matters here more than usual: the board is
 * dealt asynchronously, and a run that catches the frame before the first deal would
 * otherwise "prove" a contrast about an empty tray.
 */
function measureSurfaces(rig: ProbeRig): SurfaceResult {
  const gl = rig.gl;
  const camera = rig.camera;
  if (!gl || !camera || rig.probes.length === 0) {
    return { pass: true, detail: "surface contrast UNMEASURED (no renderer)", data: {} };
  }
  let root: Object3D = rig.probes[0];
  while (root.parent !== null) root = root.parent;

  const target = new WebGLRenderTarget(SURFACE_SIZE, SURFACE_SIZE, {
    depthBuffer: true,
    stencilBuffer: false,
    samples: 0,
  });
  target.texture.colorSpace = SRGBColorSpace;
  trackRenderTarget(target);

  const prev = gl.getRenderTarget();
  let bytes: Uint8Array;
  try {
    gl.setRenderTarget(target);
    gl.render(root as never, camera);
    bytes = readRenderTarget(gl, target);
  } finally {
    gl.setRenderTarget(prev);
  }

  const coral: number[] = [];
  const crown: number[] = [];
  const numeral: number[] = [];
  const plate: number[] = [];
  // Rows come back bottom-up. The answer row is at the bottom of the frame, so the lower
  // third of the buffer is the top third of the image in `glReadPixels` order.
  const answerRows = SURFACE_SIZE / 3;
  for (let row = 0; row < SURFACE_SIZE; row++) {
    for (let col = 0; col < SURFACE_SIZE; col++) {
      const o = (row * SURFACE_SIZE + col) * 4;
      const r = bytes[o];
      const g = bytes[o + 1];
      const b = bytes[o + 2];
      if (bytes[o + 3] < 250) continue;
      const l = luminance8(r, g, b);
      const red = r - Math.max(g, b);
      if (red > 60) {
        if (row < answerRows) numeral.push(l);
        else coral.push(l);
      } else if (r > 200 && g > 185 && b > 160 && r - b < 60) {
        if (row < answerRows) plate.push(l);
        else crown.push(l);
      }
    }
  }

  target.dispose();
  untrackRenderTarget(target);

  coral.sort((a, z) => a - z);
  crown.sort((a, z) => a - z);
  numeral.sort((a, z) => a - z);
  plate.sort((a, z) => a - z);

  const parts: string[] = [];
  const data: Record<string, number | string> = {
    coralPixels: coral.length,
    crownPixels: crown.length,
    numeralPixels: numeral.length,
    platePixels: plate.length,
  };
  let pass = true;

  if (coral.length >= MIN_SURFACE_PIXELS && crown.length >= MIN_SURFACE_PIXELS) {
    // The **median** crown pixel, which is CT4's whole point: half the character's surface
    // is darker than its brightest decile and it is the half a comment kept forgetting.
    const ratio = contrast(median(crown), median(coral));
    const dark = contrast(crown[crown.length / 10 | 0], median(coral));
    data.crownOnCoral = ratio;
    data.crownDecileOnCoral = dark;
    if (ratio < MIN_SURFACE_CONTRAST) pass = false;
    parts.push(
      `crown/coral ${ratio.toFixed(2)}:1 at the median (shaded decile ${dark.toFixed(2)}), ` +
        `need ${MIN_SURFACE_CONTRAST}`
    );
  } else {
    parts.push(`crown/coral UNMEASURED (${crown.length}/${coral.length} px)`);
  }

  if (numeral.length >= MIN_SURFACE_PIXELS / 4 && plate.length >= MIN_SURFACE_PIXELS) {
    const ratio = contrast(median(numeral), median(plate));
    data.numeralOnPlate = ratio;
    if (ratio < MIN_SURFACE_CONTRAST) pass = false;
    parts.push(`numeral/plate ${ratio.toFixed(2)}:1, need ${MIN_SURFACE_CONTRAST}`);
  } else {
    parts.push(`numeral/plate UNMEASURED (${numeral.length}/${plate.length} px)`);
  }

  return { pass, detail: parts.join(" · "), data };
}

registerSelfTest("count", async (): Promise<SelfTestResult> => {
  const rig = await waitForRig(5000);
  if (!rig) {
    return fail(
      "no live Count the Teeth scene — open the game with ?selftest=count so the probe rig exists"
    );
  }

  const metrics = rig.metrics;

  // X2: the hub card's icon plate is painted from the registry's accent, so a scene that
  // paints itself from a different family means a child taps a coral card and opens into a
  // mauve room. `layout.ts::ACCENT` is the only literal in this folder; this is what keeps
  // it married to the registry. (Importing `../index` is safe from here and only from here:
  // the registry loads every game *lazily*, and this module is itself only ever reached by
  // a dynamic import behind `FLAGS.selftest`.)
  const entry = GAMES.find((g) => g.id === "count-the-teeth");
  if (!entry) return fail("count-the-teeth is not registered in src/games/index.ts");
  if (entry.accent !== ACCENT) {
    return fail(
      `accent drift: the registry says "${entry.accent}", the scene paints "${ACCENT}"`
    );
  }

  // `layout.ts` sizes every buffer in the game from MAX_COUNT without importing the rules,
  // so the two have to be checked against each other somewhere. Here.
  const highest = RANGE[RANGE.length - 1][1];
  if (highest !== MAX_COUNT) {
    return fail(`layout.MAX_COUNT is ${MAX_COUNT} but the hardest level draws up to ${highest}`);
  }

  // The camera and the separation constraints are both solved from written-down measurements
  // of the assembled mascot. If it has been reshaped — or if a quality tier resolves it at a
  // subdivision the constants were not measured at — everything downstream is proving
  // something about a tooth that no longer exists.
  //
  // All three detail levels, because `TOOTH_SILHOUETTE` claims to be a bound over all three
  // and a check at whichever one this machine happens to have probed into would not test that
  // claim. Round 3's guard failed exactly here: the numbers were measured at detail 2 and the
  // shipping build ran detail 3, whose `vMin` is 0.0208 lower.
  for (const detail of [1, 2, 3]) {
    const cloud = mascotCloud(detail);
    const complaint = checkSilhouette(sweepSilhouette(cloud, cloud.length / 3));
    if (complaint) return fail(`at detail ${detail}: ${complaint}`);
    await nextFrame();
  }

  /*
   * …and the *cheapest* tier's body may not go back below the subdivision the face needs.
   *
   * Round 4, CT3: `TOOTH_SUBDIV[0]` was 4, i.e. a 500-triangle icosphere, and the mascot's
   * mouth is sampled **on** that surface — so two facet planes cut the mouth ball into a
   * straight downturned dash. `count-the-teeth-tier-low.png` is fourteen frowning mascots on
   * a tray, on the one device `3D-SPEC §1.4` names as the target.
   *
   * A4 fixed it centrally (`TOOTH_SUBDIV = [6, 6, 8, 11]`), so the game-side `detail`
   * override CT3 asks for would be a no-op today — detail 1 and detail 2 both resolve to
   * subdivision 6 — and a workaround for a bug that no longer exists is a defect of its own.
   * What this game *does* need is a guard, because the table is not exported and the next
   * person to tune it will not know that this character's mouth lives on its body.
   *
   * `IcosahedronGeometry(1, d)` subdivides each of 20 faces into `(d + 1)^2` triangles, so
   * subdivision 6 is exactly `20 * 49 = 980` — a number, not a threshold. The mascot's face
   * parts are fixed-detail and add a constant, so the merged geometry is compared against the
   * merge at the level the frown was fixed at.
   */
  {
    const low = countedMascotGeometry(1).index;
    const floor = countedMascotGeometry(2).index;
    const lowTris = low === null ? 0 : low.count / 3;
    const floorTris = floor === null ? 0 : floor.count / 3;
    if (lowTris < floorTris) {
      return fail(
        `the counted mascot degrades below subdivision 6 on the low tier: ${lowTris} triangles ` +
          `against ${floorTris} at detail 2. TOOTH_SUBDIV[0] has been lowered — that is CT3, ` +
          `a mascot whose facets cut its mouth into a straight downturned dash`
      );
    }
  }

  // `clayTray` decides where its own well floor sits; `layout.ts` has to write that down as a
  // constant, because `TOOTH_Y` is solved before any geometry exists. This is the other
  // written-down measurement in the folder, and it gets the same treatment.
  if (Math.abs(rig.well.floor - MAT_FLOOR) > MAT_FLOOR_TOLERANCE) {
    return fail(
      `clayTray's well floor is at ${rig.well.floor.toFixed(4)}, layout.ts::MAT_FLOOR says ${MAT_FLOOR}`
    );
  }
  {
    const marginX = rig.board.matW / 2 - rig.board.padW / 2;
    const marginZ = rig.board.matD / 2 - rig.board.padD / 2;
    if (rig.well.insetX > marginX || rig.well.insetZ > marginZ) {
      return fail(
        `the coral field runs past clayTray's flat floor: inset ` +
          `${rig.well.insetX.toFixed(4)}/${rig.well.insetZ.toFixed(4)} against margins ` +
          `${marginX.toFixed(4)}/${marginZ.toFixed(4)} — raise MAT_MARGIN`
      );
    }
  }

  const scratch = createScatter();

  /* ---- sweep 1: the framing, at every aspect the shell can produce ---- */

  let worstSlack = Infinity;
  let slackCase = "";
  let worstHitRatio = Infinity;
  let hitCase = "";
  const hitPoint = { x: 0, y: 0 };
  let worstDistance = 0;
  let widestFov = 0;
  let worstScale = 1;
  let scaleCase = "";
  let worstToothPx = Infinity;
  let toothCase = "";
  let worstCells = Infinity;
  for (const [w, h] of RECTS) {
    for (const chrome of chromeBandsFor(w)) {
      for (let level = 0; level < RANGE.length; level++) {
        const f = cameraFor(w, h, level, metrics, chrome);
        // The board `cameraFor` **chose**. The grid shape is solved now, against the chrome
        // band and the pixel height as well as the aspect, so re-deriving it here would frame
        // one board and measure a different one — which is how a sweep comes back green on a
        // composition nobody ever renders.
        const b = f.board;

        // Every shape has to hold the level's largest count, or the solver silently drops
        // teeth. `gridShapes` picks by tooth size and knows nothing about the rules.
        if (b.grid.cells < RANGE[level][1]) {
          return fail(
            `the ${b.grid.cols}x${b.grid.rows} board chosen at ${w}x${h} chrome ${chrome}px ` +
              `has ${b.grid.cells} cells for a level that draws up to ${RANGE[level][1]} teeth`
          );
        }
        if (b.grid.cells < worstCells) worstCells = b.grid.cells;

        // The composition's world scale. `SCALE_MIN` is the point at which `cameraFor` gives
        // up the keep-clear entirely and logs; reaching it is a bug in the caller's room, and
        // it must never happen for a rect the shell can actually hand a game.
        if (f.scale < worstScale) {
          worstScale = f.scale;
          scaleCase = `${w}x${h} chrome ${chrome}px level ${level}`;
        }
        if (f.scale <= SCALE_MIN + 1e-6) {
          return fail(
            `the framing bottomed out at SCALE_MIN (${SCALE_MIN}) at ${w}x${h} chrome ` +
              `${chrome}px level ${level} — at that point cameraFor stops honouring the ` +
              `chrome keep-clear, which is CT1`
          );
        }

        // …and the tooth it draws. Legibility, not framing: a board that fits and cannot be
        // counted has solved the wrong problem (§3.7).
        toothNdcBox(scratchToothBox, f, metrics, 0, -b.clampZ, 1 + 0.07);
        const toothPx = ((scratchToothBox.y1 - scratchToothBox.y0) / 2) * h;
        if (toothPx < worstToothPx) {
          worstToothPx = toothPx;
          toothCase = `${w}x${h} chrome ${chrome}px level ${level} (scale ${f.scale.toFixed(2)})`;
        }

        // The keep-clear itself, in the terms CT1 was reported in: the back row's largest
        // tooth, against the rect the HUD actually occupies.
        const behind = chromeOverlapFraction(scratchToothBox, f);
        if (behind > 0) {
          return fail(
            `${(behind * 100).toFixed(1)}% of a back-row tooth is behind the HUD at ${w}x${h} ` +
              `chrome ${chrome}px level ${level} — CT1`
          );
        }
        if (f.r < 8 - 1e-6 || f.r > 16 + 1e-6) {
          return fail(
            `camera distance ${f.r.toFixed(2)} at ${w}x${h} level ${level} leaves 3D-SPEC's 8–16 band`
          );
        }
        if (f.fov < 26 || f.fov > 32) {
          return fail(`fov ${f.fov} at ${w}x${h} level ${level} leaves 3D-SPEC's 26–32 band`);
        }
        if (f.r > worstDistance) worstDistance = f.r;
        if (f.fov > widestFov) widestFov = f.fov;
        const corner = worstTileCorner(f, b);
        if (corner.slack < worstSlack) {
          worstSlack = corner.slack;
          slackCase = `${w}x${h} chrome ${chrome}px level ${level}, ${corner.where}`;
        }

        // …and the colliders, which are round, centred above the tile, and the thing a
        // finger actually has to land on.
        const need = TAP_TARGET_PX / h;
        const top = visibleTop(f);
        for (let i = 0; i < 3; i++) {
          projectPoint(f, TILE_PITCH * (i - 1), HIT_Y, b.tileZ, hitPoint);
          const slack = Math.min(
            f.aspect - hitPoint.x,
            f.aspect + hitPoint.x,
            1 + hitPoint.y,
            top - hitPoint.y
          );
          const ratio = slack / need;
          if (ratio < worstHitRatio) {
            worstHitRatio = ratio;
            hitCase = `${w}x${h} chrome ${chrome}px level ${level}, tile ${i}`;
          }
        }
      }
    }
  }

  // And the framing the player is looking at right now, which is solved from the chrome band
  // `GameShell` actually measured rather than from any of the values swept above.
  {
    const corner = worstTileCorner(rig.framing, rig.board);
    if (corner.slack < worstSlack) {
      worstSlack = corner.slack;
      slackCase = `the live framing, ${corner.where}`;
    }
  }

  if (worstSlack < TILE_FRAME_MARGIN) {
    return fail(
      `an answer tile is clipped by the play area: ${worstSlack.toFixed(4)} of clearance at ${slackCase}`
    );
  }
  if (worstHitRatio < 1) {
    return fail(
      `an answer tile's ${TAP_TARGET_PX} px collider extends off screen: only ` +
        `${(worstHitRatio * TAP_TARGET_PX).toFixed(1)} px of clearance at ${hitCase}`
    );
  }

  /* ---- sweep 2: the countability invariant, over many boards and viewports ---- */

  let analytic = 0;
  let illegal = 0;
  let worstRatio = Infinity;
  let ratioCase = "";
  let worstOutside = -Infinity;
  let worstPipOverlap = -Infinity;
  let pipCase = "";
  let worstChrome = 0;
  let chromeCase = "";
  const paths: Record<Scatter["path"], number> = { free: 0, tight: 0, grid: 0, shrunk: 0 };

  for (const [w, h] of RECTS) {
    for (const band of ANALYTIC_BANDS) {
      for (let level = 0; level < RANGE.length; level++) {
        const f = cameraFor(w, h, level, metrics, band);
        const b = f.board;
        const [lo, hi] = RANGE[level];
        pipNdcBox(scratchPipBox, f, b);
        for (let count = lo; count <= hi; count++) {
          for (let s = 0; s < ANALYTIC_SEEDS; s++) {
            const seed = level * 1_000_003 + count * 7919 + s * 104_729 + w * 31 + h * 17 + 1;
            const ok = solveScatter(scratch, level, count, metrics, f, b, mulberry32(seed));
            analytic++;
            paths[scratch.path]++;
            if (scratch.count !== count) {
              return fail(
                `solver dropped teeth: asked for ${count} at level ${level}, placed ${scratch.count}`
              );
            }
            // The spoken board has to enumerate exactly as many teeth as the rendered one. A
            // child playing by ear counts the words; if a row bucket ever swallowed a tooth
            // the game would be unwinnable for them and perfectly fine to look at, which is
            // the kind of defect that survives every screenshot ever taken (X4).
            const spoken = describeArrangement(scratch, b).split("tooth").length - 1;
            if (spoken !== count) {
              return fail(
                `the spoken arrangement says ${spoken} teeth for a board of ${count} ` +
                  `(level ${level}, ${w}x${h}, seed ${seed})`
              );
            }
            const audit = auditScatter(scratch, metrics, f);
            if (!ok || !audit.pass) {
              illegal++;
              if (illegal === 1) ratioCase = `${w}x${h} level ${level}, count ${count}, seed ${seed}`;
            }
            if (audit.worstRatio < worstRatio && count > 1) worstRatio = audit.worstRatio;
            if (audit.worstOutside > worstOutside) worstOutside = audit.worstOutside;
            for (let i = 0; i < scratch.count; i++) {
              toothNdcBox(scratchToothBox, f, metrics, scratch.x[i], scratch.z[i], scratch.scale[i]);
              // B7.5: the progress row is not a tooth, so `auditScatter` cannot see it.
              const over = boxOverlap(scratchToothBox, scratchPipBox);
              if (over > worstPipOverlap) {
                worstPipOverlap = over;
                pipCase = `${w}x${h} level ${level}, count ${count}, seed ${seed}, tooth ${i}`;
              }
              // …and neither can it see the HUD, which is a DOM element. CT1.
              const behind = chromeOverlapFraction(scratchToothBox, f);
              if (behind > worstChrome) {
                worstChrome = behind;
                chromeCase =
                  `${w}x${h} chrome ${band}px level ${level}, count ${count}, ` +
                  `seed ${seed}, tooth ${i}`;
              }
            }
          }
        }
        await nextFrame();
      }
    }
  }

  /* ---- the surfaces, in the pixels a child sees ---- */

  // Before sweep 3: `measure()` poses the probes and masks half the scene, and this wants the
  // frame as the player has it. Run first, then let the occlusion sweep do what it likes.
  const surface = measureSurfaces(rig);
  await nextFrame();

  /* ---- sweep 3: the rendered guarantee, from the live game camera ---- */

  let renderedWorst = 1;
  let renderedCase = "";
  let renderedDetail = "";
  let rendered = 0;
  let sinceYield = 0;
  const liveFraming = rig.framing;
  const liveBoard = rig.board;

  /**
   * Boards this sweep must photograph whatever else it does.
   *
   * `51_980_671` is round 2's failure: a Hard board of fourteen whose worst tooth was measured
   * at **36.9 % unoccluded**, which is half of §6.7's floor. It has never been re-measured,
   * because round 3's stale-constant guard aborted this test three sweeps earlier — so the
   * countability guarantee the spec names has not actually been verified in a shipping build
   * since it was written. Pinning the seed here is how it stops being a story: it is solved
   * against the live camera and photographed on every run, and if the geometry, the framing
   * or the solver ever put a tooth behind another one again, this is the board that says so.
   */
  const PINNED: readonly { level: number; count: number; seed: number; why: string }[] = [
    { level: 2, count: 14, seed: 51_980_671, why: "round 2's 36.9 % board" },
  ];

  for (const pin of PINNED) {
    solveScatter(scratch, pin.level, pin.count, metrics, liveFraming, liveBoard, mulberry32(pin.seed));
    rig.place(scratch, rig.probes);
    const ratio = measure(rig, scratch.count);
    rendered++;
    renderedDetail = `seed ${pin.seed} (${pin.why}) per tooth: ${ratioReport()}`;
    if (ratio < renderedWorst) {
      renderedWorst = ratio;
      renderedCase = `level ${pin.level}, count ${pin.count}, seed ${pin.seed}`;
    }
    await nextFrame();
  }

  for (let level = 0; level < RANGE.length; level++) {
    const [lo, hi] = RANGE[level];
    for (let count = lo; count <= hi; count++) {
      for (let s = 0; s < GPU_SEEDS; s++) {
        const seed = level * 7_368_787 + count * 2_654_435 + s * 40_503 + 1;
        // Deliberately solved against the *live* framing and the *live* board, whatever level
        // the player happens to be on: the probes are posed in that camera's world.
        solveScatter(scratch, level, count, metrics, liveFraming, liveBoard, mulberry32(seed));
        rig.place(scratch, rig.probes);
        const ratio = measure(rig, scratch.count);
        rendered++;
        if (ratio < renderedWorst) {
          renderedWorst = ratio;
          renderedCase = `level ${level}, count ${count}, seed ${seed} — per tooth: ${ratioReport()}`;
        }
        if (++sinceYield >= YIELD_EVERY) {
          sinceYield = 0;
          await nextFrame();
        }
      }
    }
  }

  // `grid` is exact cell centres and `shrunk` is the bounded last resort. Neither is a
  // defect on its own — the board is proved either way — but they are how a board stops
  // looking hand-placed, so they are held to the rate they were measured at (0 of 22,440
  // across every viewport, level and count) rather than merely being allowed.
  const gridRate = analytic > 0 ? (paths.grid + paths.shrunk) / analytic : 0;
  const pass =
    illegal === 0 &&
    worstOutside <= 0 &&
    worstPipOverlap <= 0 &&
    worstChrome <= 0 &&
    worstToothPx >= MIN_TOOTH_PX &&
    paths.shrunk === 0 &&
    gridRate <= 0.01 &&
    surface.pass &&
    renderedWorst >= MIN_UNOCCLUDED;

  return {
    name: "count",
    pass,
    detail:
      `${analytic} boards over ${RECTS.length} viewports: ${illegal} ambiguous` +
      (illegal > 0 ? ` (first ${ratioCase})` : "") +
      `, tightest pair ${worstRatio.toFixed(2)}x the required gap, ` +
      `worst tooth ${worstOutside <= 0 ? "inside" : "OUTSIDE"} the frame by ` +
      `${Math.abs(worstOutside).toFixed(4)} · closest tooth-to-pip ` +
      `${worstPipOverlap <= 0 ? "clear by" : "OVERLAPPING by"} ` +
      `${Math.abs(worstPipOverlap).toFixed(4)} (${pipCase}) · worst tooth behind the HUD ` +
      `${(worstChrome * 100).toFixed(1)}%${worstChrome > 0 ? ` (${chromeCase})` : ""} · ` +
      `smallest tooth ${worstToothPx.toFixed(0)}px (${toothCase}), need ${MIN_TOOTH_PX} · ` +
      `world scale >= ${worstScale.toFixed(3)} (${scaleCase}), floor ${SCALE_MIN} · ` +
      `smallest grid ${worstCells} cells · ${surface.detail} · placements ${paths.free}/` +
      `${paths.tight}/${paths.grid}/${paths.shrunk} free/tight/grid/shrunk · answer tiles ` +
      `clear the play area by ${worstSlack.toFixed(3)} (worst at ${slackCase}) · tightest ` +
      `collider ${(worstHitRatio * TAP_TARGET_PX).toFixed(0)} px clear of the edge ` +
      `(${hitCase}) · camera ` +
      `${worstDistance.toFixed(1)}u max, fov ${widestFov} max · ${rendered} boards rendered ` +
      `from the live game camera: worst tooth ${(renderedWorst * 100).toFixed(1)}% unoccluded, ` +
      `need ${(MIN_UNOCCLUDED * 100).toFixed(0)}%` +
      (renderedWorst < MIN_UNOCCLUDED ? ` (${renderedCase})` : "") +
      ` · ${renderedDetail}`,
    data: {
      analytic,
      illegal,
      worstChrome,
      chromeCase,
      worstToothPx,
      toothCase,
      worstScale,
      scaleCase,
      worstCells,
      surface: surface.data,
      worstRatio,
      worstOutside,
      worstPipOverlap,
      pipCase,
      paths,
      gridRate,
      worstSlack,
      slackCase,
      worstHitRatio,
      hitCase,
      worstDistance,
      widestFov,
      rendered,
      renderedWorst,
      renderedCase,
      renderedDetail,
    },
  };
});
