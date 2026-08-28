/**
 * In-page test harness, driven by `?selftest=<name>`.
 *
 * Two of the spec's guarantees cannot be eyeballed — "the only differing pixels between
 * the two Spot the Difference panels are the intended diffs", and "every tooth in Count
 * the Teeth is at least 75% unoccluded *from the game camera*". Both need the GPU to
 * answer, so the measurement primitives live here next to the harness that runs them.
 *
 * Nothing in this module costs anything during normal play: no render target is allocated
 * and no frame hook is installed until a helper is actually called. Everything that
 * touches the renderer saves and restores the state it changes, including on a throw.
 */
import {
  Color,
  CustomBlending,
  DoubleSide,
  MaxEquation,
  NearestFilter,
  NoBlending,
  NoColorSpace,
  OneFactor,
  RGBAFormat,
  ShaderMaterial,
  UnsignedByteType,
  Vector4,
  WebGLRenderTarget,
  type Camera,
  type Material,
  type Mesh,
  type Object3D,
  type Scene,
  type WebGLRenderer,
} from "three";
import { sceneCacheKeys, trackRenderTarget, untrackRenderTarget } from "../three/dispose";
import { hitTargetProbes } from "../three/hit";
import { playAreaMetrics, viewDiagnostics } from "../three/Scene3D";
import { NEUTRAL } from "../three/tokens";
import { FLAGS, route } from "../three/store";

/* ------------------------------------------------------------------ */
/* Registry                                                            */
/* ------------------------------------------------------------------ */

export type SelfTestResult = { name: string; pass: boolean; detail: string; data?: unknown };

type SelfTestFn = () => Promise<SelfTestResult> | SelfTestResult;

export type SelfTestState = {
  done: boolean;
  results: SelfTestResult[];
  run: (filter?: string) => Promise<SelfTestResult[]>;
};

declare global {
  interface Window {
    __selftest?: SelfTestState;
  }
}

const registry = new Map<string, SelfTestFn>();

const matches = (name: string, filter: string) =>
  filter === "1" || filter === "all" || filter === "*" || name.includes(filter);

const state: SelfTestState = { done: false, results: [], run: runSelfTests };
if (typeof window !== "undefined") window.__selftest = state;

/**
 * Tests register when their game module loads, which is *after* the query string is read.
 * So a matching registration schedules the run on a short debounce, giving every test in
 * the same scene a chance to register — and giving the scene a moment to settle before it
 * is photographed.
 */
let autoRunTimer: ReturnType<typeof setTimeout> | null = null;

export function registerSelfTest(name: string, fn: SelfTestFn): void {
  registry.set(name, fn);
  const filter = FLAGS.selftest;
  if (filter === null || !matches(name, filter)) return;
  if (autoRunTimer !== null) clearTimeout(autoRunTimer);
  autoRunTimer = setTimeout(() => {
    autoRunTimer = null;
    void runSelfTests(filter);
  }, 400);
}

let running: Promise<SelfTestResult[]> | null = null;

export function runSelfTests(filter?: string): Promise<SelfTestResult[]> {
  if (running !== null) return running;
  const p = execute(filter).finally(() => {
    running = null;
  });
  running = p;
  return p;
}

async function execute(filter?: string): Promise<SelfTestResult[]> {
  const results: SelfTestResult[] = [];
  state.done = false;
  state.results = results;

  for (const [name, fn] of registry) {
    if (filter !== undefined && !matches(name, filter)) continue;
    try {
      results.push(await fn());
    } catch (err) {
      results.push({
        name,
        pass: false,
        detail: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      });
    }
  }

  state.done = true;
  for (const r of results) {
    // Logged rather than returned-only so a headless driver can scrape the console.
    console.log(`[selftest] ${r.pass ? "PASS" : "FAIL"} ${r.name} — ${r.detail}`);
  }
  return results;
}

/* ------------------------------------------------------------------ */
/* Pixel diffing                                                       */
/* ------------------------------------------------------------------ */

export type DiffCluster = {
  /** Bounding box, in the row order of the supplied buffers. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Differing pixels inside the box (not the box area). */
  count: number;
  /** Centroid of the differing pixels — what a test asserts a diff's location against. */
  cx: number;
  cy: number;
};

/**
 * Compares two RGBA buffers and groups the differing pixels into 8-connected clusters.
 *
 * Rows follow whatever order the caller supplied. `readRenderTarget` hands back WebGL's
 * bottom-up order, so a cluster's `y` grows upward when the buffers came from there.
 *
 * `threshold` is the largest per-channel difference still considered "the same pixel";
 * the default tolerates 8-bit rounding and MSAA edge jitter but nothing structural.
 */
export function pixelDiff(
  a: Uint8Array,
  b: Uint8Array,
  opts: { width: number; height: number; threshold?: number }
): { differing: number; clusters: DiffCluster[] } {
  const { width, height } = opts;
  const threshold = opts.threshold ?? 8;
  const n = width * height;
  if (a.length < n * 4 || b.length < n * 4) {
    throw new Error(`pixelDiff: buffers hold ${a.length}/${b.length} bytes, need ${n * 4}`);
  }

  const mask = new Uint8Array(n);
  let differing = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    let d = Math.abs(a[o] - b[o]);
    const dg = Math.abs(a[o + 1] - b[o + 1]);
    if (dg > d) d = dg;
    const db = Math.abs(a[o + 2] - b[o + 2]);
    if (db > d) d = db;
    const da = Math.abs(a[o + 3] - b[o + 3]);
    if (da > d) d = da;
    if (d > threshold) {
      mask[i] = 1;
      differing++;
    }
  }

  // Iterative flood fill — a recursive one blows the stack on a full-screen diff.
  const stack = new Int32Array(differing > 0 ? differing : 1);
  const clusters: DiffCluster[] = [];

  for (let start = 0; start < n; start++) {
    if (mask[start] !== 1) continue;
    let sp = 0;
    stack[sp++] = start;
    mask[start] = 2;

    let minX = width;
    let maxX = -1;
    let minY = height;
    let maxY = -1;
    let count = 0;
    let sumX = 0;
    let sumY = 0;

    while (sp > 0) {
      const p = stack[--sp];
      const px = p % width;
      const py = (p - px) / width;
      count++;
      sumX += px;
      sumY += py;
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;

      for (let oy = -1; oy <= 1; oy++) {
        const ny = py + oy;
        if (ny < 0 || ny >= height) continue;
        const rowBase = ny * width;
        for (let ox = -1; ox <= 1; ox++) {
          const nx = px + ox;
          if (nx < 0 || nx >= width) continue;
          const q = rowBase + nx;
          if (mask[q] === 1) {
            mask[q] = 2;
            stack[sp++] = q;
          }
        }
      }
    }

    clusters.push({
      x: minX,
      y: minY,
      w: maxX - minX + 1,
      h: maxY - minY + 1,
      count,
      cx: sumX / count,
      cy: sumY / count,
    });
  }

  clusters.sort((p, q) => q.count - p.count);
  return { differing, clusters };
}

/* ------------------------------------------------------------------ */
/* Render target readback                                              */
/* ------------------------------------------------------------------ */

/**
 * Reads a render target's colour attachment as RGBA bytes.
 *
 * Rows come back bottom-up, the way `glReadPixels` produces them. This is a synchronous
 * GPU stall by nature — fine for a test, never for a frame budget.
 */
export function readRenderTarget(renderer: WebGLRenderer, target: WebGLRenderTarget): Uint8Array {
  const buffer = new Uint8Array(target.width * target.height * 4);
  const previous = renderer.getRenderTarget();
  try {
    renderer.readRenderTargetPixels(target, 0, 0, target.width, target.height, buffer);
  } finally {
    renderer.setRenderTarget(previous);
  }
  return buffer;
}

/* ------------------------------------------------------------------ */
/* Occlusion measurement                                               */
/* ------------------------------------------------------------------ */

/**
 * A flat unlit shader whose output is written verbatim: no tone mapping chunk, no output
 * colour-space chunk, no lighting. That exactness is the point — the returned bytes are
 * object IDs, and a colour-managed round trip would corrupt them.
 */
const ID_VERTEX = /* glsl */ `
#include <common>
#include <batching_pars_vertex>
void main() {
  #include <batching_vertex>
  #include <begin_vertex>
  #include <project_vertex>
}
`;

const ID_FRAGMENT = /* glsl */ `
uniform vec4 uCode;
void main() { gl_FragColor = uCode; }
`;

/** Bit-per-object packing needs 4 channels, so a pass covers 4 objects. */
const CHANNELS = 4;
/** Red-channel IDs are 1..255; well past anything a scene will ask about. */
const MAX_OBJECTS = 255;

let idTarget: WebGLRenderTarget | null = null;
let readBuffer: Uint8Array | null = null;
const idMaterials: ShaderMaterial[] = [];
const channelMaterials: ShaderMaterial[] = [];
let occluderMaterial: ShaderMaterial | null = null;

function makeIdMaterial(r: number, g: number, b: number, a: number, solo: boolean): ShaderMaterial {
  const m = new ShaderMaterial({
    vertexShader: ID_VERTEX,
    fragmentShader: ID_FRAGMENT,
    uniforms: { uCode: { value: new Vector4(r, g, b, a) } },
    // Open geometry (a card face, a ground plate) must still count as coverage.
    side: DoubleSide,
    fog: false,
    lights: false,
  });
  if (solo) {
    // Solo pass: no depth at all, and max-blending so a mesh's own overlapping fragments
    // are idempotent while four different objects still land in four separate channels.
    m.depthTest = false;
    m.depthWrite = false;
    m.blending = CustomBlending;
    m.blendEquation = MaxEquation;
    m.blendSrc = OneFactor;
    m.blendDst = OneFactor;
  } else {
    m.depthTest = true;
    m.depthWrite = true;
    m.blending = NoBlending;
  }
  return m;
}

function idMaterial(id: number): ShaderMaterial {
  let m = idMaterials[id];
  if (m === undefined) {
    m = makeIdMaterial(id / 255, 0, 0, 1, false);
    idMaterials[id] = m;
  }
  return m;
}

function channelMaterial(channel: number): ShaderMaterial {
  let m = channelMaterials[channel];
  if (m === undefined) {
    m = makeIdMaterial(
      channel === 0 ? 1 : 0,
      channel === 1 ? 1 : 0,
      channel === 2 ? 1 : 0,
      channel === 3 ? 1 : 0,
      true
    );
    channelMaterials[channel] = m;
  }
  return m;
}

function ensureTarget(size: number): WebGLRenderTarget {
  if (idTarget !== null && idTarget.width === size) return idTarget;
  if (idTarget !== null) untrackRenderTarget(idTarget);
  idTarget = trackRenderTarget(
    new WebGLRenderTarget(size, size, {
      format: RGBAFormat,
      type: UnsignedByteType,
      // No filtering and no colour space: the texels are data, not an image.
      minFilter: NearestFilter,
      magFilter: NearestFilter,
      colorSpace: NoColorSpace,
      generateMipmaps: false,
      depthBuffer: true,
      stencilBuffer: false,
      samples: 0,
    })
  );
  readBuffer = new Uint8Array(size * size * 4);
  return idTarget;
}

/** Frees the shared ID target and materials. Call from a game's disposal bag on unmount. */
export function disposeSelfTestResources(): void {
  if (idTarget !== null) {
    untrackRenderTarget(idTarget);
    idTarget = null;
  }
  readBuffer = null;
  for (const m of idMaterials) m?.dispose();
  idMaterials.length = 0;
  for (const m of channelMaterials) m?.dispose();
  channelMaterials.length = 0;
  occluderMaterial?.dispose();
  occluderMaterial = null;
}

/* Scratch state, reused so a call inside a running game does not churn the heap. */
const meshes: Mesh[] = [];
const meshTag: number[] = [];
const savedMaterial: (Material | Material[])[] = [];
const savedVisible: boolean[] = [];
const otherRenderables: Object3D[] = [];
const savedOtherVisible: boolean[] = [];
const tagged = new Map<Object3D, number>();
const savedClear = new Color();
const savedViewport = new Vector4();
const savedScissor = new Vector4();
let tagIndex = 0;

const tagOne = (o: Object3D) => {
  tagged.set(o, tagIndex);
};

const collectOne = (o: Object3D) => {
  const mesh = o as Mesh;
  if (mesh.isMesh === true) {
    meshes.push(mesh);
    savedMaterial.push(mesh.material);
    savedVisible.push(mesh.visible);
    const t = tagged.get(o);
    meshTag.push(t === undefined ? -1 : t);
    return;
  }
  const other = o as Object3D & { isSprite?: boolean; isLine?: boolean; isPoints?: boolean };
  if (other.isSprite === true || other.isLine === true || other.isPoints === true) {
    // These keep their real materials through the ID passes, which would paint arbitrary
    // colours into the ID buffer. Hidden for the duration, restored afterwards.
    otherRenderables.push(o);
    savedOtherVisible.push(o.visible);
  }
};

/**
 * For each object, the fraction of its silhouette that is actually visible from `camera`.
 *
 * Two kinds of pass, both rendered from the caller's camera exactly as configured:
 *
 *  1. One pass over the whole scene with every mesh flattened to an ID colour (targets get
 *     their own ID, everything else writes zero but still writes depth). Counting each ID
 *     gives the pixels that survive occlusion by scenery *and* by the other targets.
 *  2. `ceil(n/4)` passes over the targets alone with depth off and max-blending, four
 *     objects per pass, one per colour channel. That gives each object's unoccluded
 *     footprint without needing one readback per object.
 *
 * The target is square while the game viewport usually is not. That is deliberate: the
 * camera's projection matrix is untouched, so the frustum and every occlusion relationship
 * are identical to what the player sees — only the pixel aspect differs, and both passes
 * share it, so the ratio is exact.
 *
 * An object with no unoccluded footprint at all (off-screen, or hidden) reports 0.
 */
export function occlusionRatios(
  renderer: WebGLRenderer,
  camera: Camera,
  objects: Object3D[],
  size = 256
): number[] {
  const ratios: number[] = [];
  if (objects.length === 0) return ratios;
  if (objects.length > MAX_OBJECTS) {
    throw new Error(`occlusionRatios: ${objects.length} objects exceeds the ${MAX_OBJECTS} ID limit`);
  }

  let root: Object3D = objects[0];
  while (root.parent !== null) root = root.parent;
  const scene = root as Scene;

  const target = ensureTarget(size);
  const buffer = readBuffer as Uint8Array;
  const pixels = size * size;

  const visible = new Int32Array(objects.length);
  const solo = new Int32Array(objects.length);

  tagged.clear();
  for (let i = 0; i < objects.length; i++) {
    tagIndex = i;
    objects[i].traverse(tagOne);
  }

  meshes.length = 0;
  meshTag.length = 0;
  savedMaterial.length = 0;
  savedVisible.length = 0;
  otherRenderables.length = 0;
  savedOtherVisible.length = 0;
  root.traverse(collectOne);

  const prevTarget = renderer.getRenderTarget();
  const prevAlpha = renderer.getClearAlpha();
  const prevAutoClear = renderer.autoClear;
  const prevScissorTest = renderer.getScissorTest();
  // Deliberately not touching toneMapping or shadowMap.enabled: both are program
  // parameters, and flipping them would force every material in the app to recompile on
  // the next real frame. The ID shader ignores tone mapping anyway, and pausing shadow
  // updates is enough to skip the shadow pass.
  const prevShadowAuto = renderer.shadowMap.autoUpdate;
  renderer.getClearColor(savedClear);
  renderer.getViewport(savedViewport);
  renderer.getScissor(savedScissor);

  const prevOverride = scene.isScene === true ? scene.overrideMaterial : null;
  const prevBackground = scene.isScene === true ? scene.background : null;

  if (occluderMaterial === null) occluderMaterial = makeIdMaterial(0, 0, 0, 1, false);
  const occluder = occluderMaterial;

  try {
    if (scene.isScene === true) {
      scene.overrideMaterial = null;
      // A background colour or environment map would paint non-zero IDs everywhere.
      scene.background = null;
    }
    renderer.autoClear = true;
    renderer.shadowMap.autoUpdate = false;
    renderer.setScissorTest(false);
    renderer.setClearColor(0x000000, 0);

    for (let i = 0; i < otherRenderables.length; i++) otherRenderables[i].visible = false;

    /* Pass 1 — the scene as it really is, everything flattened to IDs. */
    for (let i = 0; i < meshes.length; i++) {
      const t = meshTag[i];
      meshes[i].material = t < 0 ? occluder : idMaterial(t + 1);
    }
    renderer.setRenderTarget(target);
    renderer.render(root, camera);
    renderer.readRenderTargetPixels(target, 0, 0, size, size, buffer);
    for (let p = 0; p < pixels; p++) {
      const id = buffer[p * 4];
      if (id > 0 && id <= objects.length) visible[id - 1]++;
    }

    /* Pass 2 — targets alone, four per pass, one colour channel each. */
    const groups = Math.ceil(objects.length / CHANNELS);
    for (let g = 0; g < groups; g++) {
      for (let i = 0; i < meshes.length; i++) {
        const t = meshTag[i];
        const inGroup = t >= 0 && Math.floor(t / CHANNELS) === g;
        meshes[i].visible = inGroup;
        if (inGroup) meshes[i].material = channelMaterial(t % CHANNELS);
      }
      renderer.setRenderTarget(target);
      renderer.render(root, camera);
      renderer.readRenderTargetPixels(target, 0, 0, size, size, buffer);

      for (let c = 0; c < CHANNELS; c++) {
        const index = g * CHANNELS + c;
        if (index >= objects.length) break;
        let count = 0;
        for (let p = 0; p < pixels; p++) if (buffer[p * 4 + c] > 127) count++;
        solo[index] = count;
      }
    }
  } finally {
    for (let i = 0; i < meshes.length; i++) {
      meshes[i].material = savedMaterial[i];
      meshes[i].visible = savedVisible[i];
    }
    for (let i = 0; i < otherRenderables.length; i++) {
      otherRenderables[i].visible = savedOtherVisible[i];
    }
    if (scene.isScene === true) {
      scene.overrideMaterial = prevOverride;
      scene.background = prevBackground;
    }
    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(savedClear, prevAlpha);
    renderer.autoClear = prevAutoClear;
    renderer.shadowMap.autoUpdate = prevShadowAuto;
    renderer.setViewport(savedViewport);
    renderer.setScissor(savedScissor);
    renderer.setScissorTest(prevScissorTest);

    meshes.length = 0;
    meshTag.length = 0;
    savedMaterial.length = 0;
    savedVisible.length = 0;
    otherRenderables.length = 0;
    savedOtherVisible.length = 0;
    tagged.clear();
  }

  for (let i = 0; i < objects.length; i++) {
    ratios.push(solo[i] === 0 ? 0 : visible[i] / solo[i]);
  }
  return ratios;
}

/* ------------------------------------------------------------------ */
/* Colour contrast                                                     */
/* ------------------------------------------------------------------ */

function channelLuminance(v: number): number {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function parseHex(hex: string): [number, number, number] {
  let h = hex.trim();
  if (h.startsWith("#")) h = h.slice(1);
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  if (h.length !== 6 || !/^[0-9a-fA-F]{6}$/.test(h)) {
    throw new Error(`contrastRatio: "${hex}" is not a hex colour`);
  }
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

/** WCAG 2.1 relative luminance — its own transfer curve, not three's colour management. */
function relativeLuminance(hex: string): number {
  const [r, g, b] = parseHex(hex);
  return (
    0.2126 * channelLuminance(r) +
    0.7152 * channelLuminance(g) +
    0.0722 * channelLuminance(b)
  );
}

/** WCAG 2.1 contrast ratio, 1..21. AA body text needs 4.5, large text and UI need 3. */
export function contrastRatio(hexA: string, hexB: string): number {
  const la = relativeLuminance(hexA);
  const lb = relativeLuminance(hexB);
  const light = la > lb ? la : lb;
  const dark = la > lb ? lb : la;
  return (light + 0.05) / (dark + 0.05);
}

/* ------------------------------------------------------------------ */
/* Tap targets                                                         */
/* ------------------------------------------------------------------ */

/**
 * `3D-SPEC` requires a >= 48 px effective tap target, and a child who taps the instant a
 * game appears must hit what they aimed at. Both were broken in round 2 and neither was
 * catchable by eye: colliders mounted as unscaled unit spheres (a 268 px target at the
 * standard framing) and stayed four times oversized through the entry animation, because
 * the view height they were sized against was a mid-flip transformed rect.
 *
 * So this projects every live collider and asserts three things about it:
 *
 *  1. it is at least `minScreenPx` across — the target is genuinely reachable;
 *  2. it is not inflated past what `minScreenPx` (or the prop's own size) asks for — an
 *     oversized collider is the failure that makes a child hit the wrong tile;
 *  3. no target's centre falls inside another target's circle — you must be able to aim at
 *     any target without something else swallowing the tap.
 *
 * Only runs under `?selftest`; `hit.tsx` does not populate the probes otherwise.
 */
const UNDERSIZE_TOLERANCE = 0.9;
const OVERSIZE_TOLERANCE = 1.15;

registerSelfTest("hit-targets", () => {
  const live = hitTargetProbes().filter((p) => p.measured && !p.disabled);
  if (live.length === 0) {
    const id = route.get().gameId ?? route.get().screen;
    return {
      name: "hit-targets",
      pass: true,
      detail: `${id}: no live colliders in this scene — nothing asserted`,
      data: { gameId: id, targets: 0 },
    };
  }

  const undersized: string[] = [];
  const oversized: string[] = [];
  const overlapping: string[] = [];
  const outOfView: string[] = [];

  /*
   * The bounds check the round-4 audit asked for (A18b).
   *
   * `probe.x/y/r` were computed and then never compared against anything, so a target that
   * had been pushed off the edge of the play area — or half of it cut away by the view's
   * scissor rectangle — measured a perfectly legal 48 px and passed. Count the Teeth's
   * clipped tiles are the shipped example: the panel mask cuts them while the `count`
   * selftest simultaneously reports "clear by 0.017", which is one or two pixels.
   *
   * `playAreaMetrics()` is the *layout* size of the tracked element, so it is immune to the
   * CSS scale of the hub → game flip — the same reason `hit.tsx` sizes its colliders from it.
   * A circle is required to be wholly inside it: a target a child can only half reach is a
   * target they will half miss.
   */
  const view = playAreaMetrics();

  for (const p of live) {
    const expected = Math.max(p.minScreenPx * 0.5, p.radiusPx);
    if (p.r * 2 < p.minScreenPx * UNDERSIZE_TOLERANCE) {
      undersized.push(`${p.label}: ${(p.r * 2).toFixed(0)}px < ${p.minScreenPx}px`);
    }
    if (p.r > expected * OVERSIZE_TOLERANCE) {
      oversized.push(
        `${p.label}: ${(p.r * 2).toFixed(0)}px vs ${(expected * 2).toFixed(0)}px needed`
      );
    }
    if (view !== null) {
      const over =
        p.x - p.r < 0 ||
        p.y - p.r < 0 ||
        p.x + p.r > view.width ||
        p.y + p.r > view.height;
      if (over) {
        outOfView.push(
          `${p.label}: circle (${p.x.toFixed(0)},${p.y.toFixed(0)}) r${p.r.toFixed(0)} ` +
            `leaves the ${view.width}×${view.height} view`
        );
      }
    }
  }

  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const a = live[i];
      const b = live[j];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      // Two circles may overlap at the rim; what must never happen is one target's centre
      // sitting inside another's, because then it cannot be aimed at at all.
      if (d < a.r || d < b.r) {
        overlapping.push(`${a.label} / ${b.label} centres ${d.toFixed(0)}px apart`);
      }
    }
  }

  const pass =
    undersized.length === 0 &&
    oversized.length === 0 &&
    overlapping.length === 0 &&
    outOfView.length === 0;
  // Keyed by game id (A18c). `hitTargetsPerGame` was reported as an unlabelled sequence —
  // `4/0/6/3/8/0/3/0/10` — so three games shipping zero colliders could be counted and not
  // one of them named.
  const gameId = route.get().gameId ?? route.get().screen;
  const parts: string[] = [`${gameId}: ${live.length} live colliders`];
  if (undersized.length) parts.push(`${undersized.length} under ${live[0].minScreenPx}px`);
  if (oversized.length) parts.push(`${oversized.length} oversized`);
  if (overlapping.length) parts.push(`${overlapping.length} swallowing a neighbour`);
  if (outOfView.length) parts.push(`${outOfView.length} outside the view rect`);

  return {
    name: "hit-targets",
    pass,
    detail: parts.join(", "),
    data: {
      gameId,
      view,
      outOfView,
      targets: live.length,
      undersized,
      oversized,
      overlapping,
      probes: live.map((p) => ({
        label: p.label,
        x: Math.round(p.x),
        y: Math.round(p.y),
        diameterPx: Math.round(p.r * 2),
        minScreenPx: p.minScreenPx,
      })),
    },
  };
});


/* ------------------------------------------------------------------ */
/* Perf instrumentation                                                */
/* ------------------------------------------------------------------ */

/**
 * Asserts that the frame instrumentation is *telling the truth about itself*.
 *
 * This exists because of the specific way round 3's evidence failed. Every one of the nine
 * scene-entry marks was recorded twice, and two of them ("maze-escape", "tooth-match")
 * closed having sampled `frames: 0` — no measurement at all — while `violations` came back
 * as `[]` and was read as a pass. A harness that cannot distinguish "fine" from "never
 * sampled" is worse than no harness, so the distinction is now asserted rather than trusted:
 *
 *  1. no closed mark sampled zero frames (`perf.ts` also names these in `unmeasured`);
 *  2. no two consecutive marks share a name and a phase — that is the duplicate-record
 *     signature, and `mark()`'s dedupe is supposed to make it impossible.
 *
 * It does **not** fail on `marksOverwritten`: a long endurance run legitimately laps the
 * ring. It reports the count instead, so a reader knows the list is partial.
 */
registerSelfTest("perf-marks", () => {
  const perf = typeof window !== "undefined" ? window.__perf : undefined;
  if (!perf) {
    return { name: "perf-marks", pass: false, detail: "window.__perf is not installed" };
  }

  const snap = perf.snapshot();
  const unsampled = snap.marks
    .filter((m) => !m.open && m.frames === 0)
    .map((m) => `${m.phase}:${m.name}`);

  const duplicated: string[] = [];
  for (let i = 1; i < snap.marks.length; i++) {
    const a = snap.marks[i - 1];
    const b = snap.marks[i];
    if (a.name === b.name && a.phase === b.phase) duplicated.push(`${b.phase}:${b.name}`);
  }

  const pass = unsampled.length === 0 && duplicated.length === 0;
  const parts = [`${snap.marks.length} marks`];
  if (unsampled.length) parts.push(`${unsampled.length} sampled zero frames (UNMEASURED)`);
  if (duplicated.length) parts.push(`${duplicated.length} duplicate-recorded`);
  if (snap.marksOverwritten) parts.push(`${snap.marksOverwritten} lost to the ring`);
  if (pass) parts.push("every closed window sampled at least one frame");

  return {
    name: "perf-marks",
    pass,
    detail: parts.join(", "),
    data: {
      unsampled,
      duplicated,
      marksOverwritten: snap.marksOverwritten,
      duplicateMarksSuppressed: snap.duplicateMarksSuppressed,
      clock: snap.clock,
      hiddenDuringWindow: snap.hiddenDuringWindow,
      // Carried so a `?selftest` capture states the tier and the GPU-timing status even when
      // no separate perf capture was taken alongside it.
      tier: snap.tier,
      gpu: snap.gpu,
      unmeasured: snap.unmeasured,
    },
  };
});

/* ------------------------------------------------------------------ */
/* Viewport — does anything reach the framebuffer at all? (A8, A18f)   */
/* ------------------------------------------------------------------ */

/**
 * The check whose absence let two of nine games ship a blank play area.
 *
 * `viewport-summary.txt` at a true 390×844: `tooth-runner draw calls 0 triangles 0`,
 * `smile-maker draw calls 0 triangles 0`, with the DOM chrome laid out correctly in both
 * screenshots. Nine games, forty-odd selftests, eight hundred evidence files, and not one
 * assertion that a scene draws anything — so "unplayable on the device PROJECT.md names
 * first" was invisible to every instrument the project owns.
 *
 * Two halves, both necessary:
 *
 *  1. **the outcome** — `window.__perf.calls` is the frame total across every drei `<View>`
 *     (`perf.ts` turns `info.autoReset` off and resets once per rAF), so `> 0` is the whole
 *     claim: something was drawn. A game that renders 21 badly-framed draw calls fails other
 *     checks; a game that renders zero fails this one and only this one.
 *  2. **the cause** — `viewDiagnostics()` names which of drei's three skip conditions fired
 *     for each mounted view: the portal host never resolved, the tracked rect is off the
 *     canvas, or the tracked rect is degenerate and has poisoned `camera.aspect` with NaN.
 *     Reporting the cause is what stops round 5 re-deriving it from a screenshot.
 *
 * The viewport itself is reported rather than asserted: a page cannot resize its own window,
 * so running this at 390×844, 768×1024 and 1440×900 is the capture harness's job. What the
 * page guarantees is that whichever viewport it is handed, a zero is a failure with a named
 * cause attached.
 */
registerSelfTest("viewport", () => {
  const perf = typeof window !== "undefined" ? window.__perf : undefined;
  const views = viewDiagnostics();
  const gameId = route.get().gameId ?? route.get().screen;
  const viewport = { width: window.innerWidth, height: window.innerHeight };

  if (!perf?.installed) {
    return {
      name: "viewport",
      pass: false,
      detail: `${gameId}: window.__perf is not installed, so draw calls cannot be read`,
      data: { gameId, viewport, views },
    };
  }
  if (views.length === 0) {
    return {
      name: "viewport",
      pass: false,
      detail: `${gameId}: no <Scene3D> is mounted at ${viewport.width}×${viewport.height}`,
      data: { gameId, viewport, views },
    };
  }

  const calls = perf.calls;
  const triangles = perf.triangles;
  const problems: string[] = [];
  if (calls <= 0) problems.push(`0 draw calls at ${viewport.width}×${viewport.height}`);
  if (triangles <= 0) problems.push(`0 triangles at ${viewport.width}×${viewport.height}`);
  for (const v of views) {
    if (!v.hostResolved) problems.push(`view "${v.scene}" never resolved a portal host`);
    if (v.fallbackInPlace) problems.push(`view "${v.scene}" fell back to rendering in place`);
    if (v.offscreen) {
      problems.push(
        `view "${v.scene}" is offscreen by drei's predicate: rect ` +
          `[${v.rect.left.toFixed(0)},${v.rect.top.toFixed(0)} → ` +
          `${v.rect.right.toFixed(0)},${v.rect.bottom.toFixed(0)}] against a ` +
          `${v.canvas.width}×${v.canvas.height} canvas`
      );
    }
    if (v.degenerate) {
      problems.push(
        `view "${v.scene}" has a degenerate tracked rect ` +
          `(${v.rect.width}×${v.rect.height}; layout ${v.layout.width}×${v.layout.height}), ` +
          "so camera.aspect is not finite and every object fails the frustum test"
      );
    }
  }

  return {
    name: "viewport",
    pass: problems.length === 0,
    detail:
      problems.length === 0
        ? `${gameId}: ${calls} draw calls, ${triangles} triangles at ` +
          `${viewport.width}×${viewport.height} across ${views.length} view(s)`
        : `${gameId}: ${problems.join("; ")}`,
    data: { gameId, viewport, calls, triangles, views },
  };
});

/* ------------------------------------------------------------------ */
/* In-world label contrast (A18e)                                      */
/* ------------------------------------------------------------------ */

/** AA body text. Large text and UI controls clear at 3:1, which the size test below applies. */
const TEXT_CONTRAST_AA = 4.5;
const TEXT_CONTRAST_LARGE = 3;
/** px in the label's own canvas at which WCAG's "large text" allowance starts (18.66pt bold). */
const TEXT_LARGE_PX = 25;

/**
 * Every in-world label, checked against the plate it is baked onto.
 *
 * `text.ts` bakes a label into a canvas and caches it under
 * `text|fontSize|weight|color|background|padding|maxWidth`, so the cache keys *are* the
 * corpus: no render target, no readback, and no scene has to be in any particular state.
 *
 * **Stated limitation, because a proxy that hides is worse than no check.** When a label is
 * baked with an empty `background` it is transparent and sits on whatever 3D plate the game
 * put behind it, which this cannot see. Those are measured against `NEUTRAL.page` — the
 * value `clayGround` is calibrated to render back at (dE2000 0.5), and the lightest surface
 * in the product, so it is the *most* forgiving backing a label can have. A failure here is
 * therefore a real failure; a pass on a transparent label is a pass against the page cream
 * and not against a dark clay plate a game may have used instead. Those are named in `data`
 * so the gap is visible rather than implied.
 */
registerSelfTest("text-contrast", () => {
  const keys = sceneCacheKeys("text");
  if (keys.length === 0) {
    return {
      name: "text-contrast",
      pass: true,
      detail: "no in-world labels have been baked in this scene — nothing asserted",
      data: { labels: 0 },
    };
  }

  const failures: string[] = [];
  const assumedBacking: string[] = [];
  const measured: { text: string; ratio: number; need: number; backing: string }[] = [];

  for (const key of keys) {
    // `text` itself can contain `|`, so split from the right: the last six fields are fixed.
    const parts = key.split("|");
    if (parts.length < 7) continue;
    const [maxWidth, padding, background, color, weight, fontSize] = [
      parts[parts.length - 1],
      parts[parts.length - 2],
      parts[parts.length - 3],
      parts[parts.length - 4],
      parts[parts.length - 5],
      parts[parts.length - 6],
    ];
    void maxWidth;
    void padding;
    void weight;
    const text = parts.slice(0, parts.length - 6).join("|");
    if (!color.startsWith("#")) continue;

    const transparent = background === "" || !background.startsWith("#");
    const backing = transparent ? NEUTRAL.page : background;
    if (transparent) assumedBacking.push(text);

    const size = Number.parseFloat(fontSize);
    const need = Number.isFinite(size) && size >= TEXT_LARGE_PX ? TEXT_CONTRAST_LARGE : TEXT_CONTRAST_AA;
    const ratio = contrastRatio(color, backing);
    measured.push({ text, ratio: Math.round(ratio * 100) / 100, need, backing });
    if (ratio < need) {
      failures.push(`"${text}" ${color} on ${backing} = ${ratio.toFixed(2)}:1, needs ${need}:1`);
    }
  }

  return {
    name: "text-contrast",
    pass: failures.length === 0,
    detail:
      failures.length === 0
        ? `${measured.length} in-world labels, all clear ` +
          `(${assumedBacking.length} measured against the page cream — see the note in the source)`
        : `${failures.length} of ${measured.length} in-world labels fail: ${failures.join("; ")}`,
    data: { labels: measured.length, failures, assumedBacking, measured },
  };
});
