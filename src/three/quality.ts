/**
 * Device tier probe + budgets.
 *
 * The hard target is a locked 60fps on a mid-range Android tablet, so the tier is
 * decided up front from cheap signals and then adapted downward at runtime if frames
 * start costing too much. It never adapts upward mid-session — a resolution that pops
 * back and forth is worse than one that is slightly soft.
 */
import { createStore } from "./store";
import { FLAGS } from "./store";

export type Tier = "low" | "mid" | "high";

export type QualitySettings = {
  tier: Tier;
  dpr: number;
  shadowMapSize: number;
  /** Multi-sample antialiasing on the default framebuffer. */
  antialias: boolean;
  /** Cap for instanced scatter counts (confetti, scenery, sparkles). */
  maxInstances: number;
  /** Geometry subdivision level for procedural props. */
  detail: number;
  /**
   * Which shadow filter the clay shader compiles.
   *
   * `true` = the contact-hardening PCSS filter in `materials.ts` (a blocker search plus a
   * variable-radius PCF); `false` = three's stock 17-tap fixed-radius `SHADOWMAP_TYPE_PCF`
   * kernel. See `docs/3D-SPEC.md §2` for why the product does not use `PCFSoftShadowMap`
   * for either.
   *
   * **This is now `true` on every tier**, and the round-4 audit is why: the tier the target
   * device boots is `low`, and gating the filter on `tier !== "low"` meant the product's
   * signature material cue — the one §2 calls the "3D viewport tell" if it is missing — was
   * switched off on the only device that matters. The frame the target child sees was not
   * the frame anyone was reviewing.
   *
   * It is affordable because the *tap count* is tiered instead of the filter. The low tier
   * compiles one Vogel group and no widening branches: 8 blocker-search taps plus 12 filter
   * taps = 20 fetches, against the stock kernel's 17. Three extra fetches on one lobe is not
   * what a degrade is fighting — that is dpr, instance counts and geometry detail — which is
   * exactly the argument this comment already made for keeping the flag out of
   * `degradeQuality`.
   *
   * **Frozen at boot — `degradeQuality` never changes it.** `Rig` writes a different
   * quantity into `DirectionalLightShadow.radius` under each filter (penumbra texels *per
   * unit of depth gap* under PCSS, a flat penumbra width in texels under PCF), and the
   * branch that reads it is baked into a compiled program the moment the first clay
   * material compiles. Letting a runtime degrade flip it would leave live programs reading
   * a uniform that now means something else — a wrong-looking shadow, not a cheaper one.
   */
  softShadows: boolean;
};

/**
 * Every field here is read by something that renders. Two more used to sit alongside them —
 * `contactShadows` and `depthOfField` — and a grep found no reader for either anywhere in
 * `src/`, so the low tier never actually got the cheaper contact-shadow path it advertised
 * and the high tier's DOF was a promise with no implementation. They are deleted rather
 * than wired: the product's contact shadows are the procedural `ContactBlob` decal in
 * `Rig.tsx`, which since round 4 fades out with the caster's height so it supplies the
 * sub-texel contact pinch and never the body of a cast shadow, and there is no
 * post-processing stack to hang a DOF pass on.
 * A tier table that misdescribes what a tier costs is worse than a short one.
 */
const TIERS: Record<Tier, Omit<QualitySettings, "tier" | "dpr" | "softShadows">> = {
  low: {
    shadowMapSize: 512,
    /*
     * **Multisampling is on at the low tier, and it is the single biggest thing this tier
     * was getting wrong.**
     *
     * The low tier is the one the target device boots (see `decide`), and it renders at
     * `dpr 1.0` — where an unresolved edge is a full device pixel of staircase with nothing
     * to hide it. Round 4's `count-the-teeth-tier-low.png` is the evidence: the mascot's
     * outline is visibly stepped, the tray rim reads as a staircase and the pupils look
     * polygonal, none of which is geometry (the pupil is a 500-triangle icosphere at 30 px)
     * and all of which is the absence of a resolve.
     *
     * It is affordable because MSAA is not supersampling. Coverage and depth are sampled per
     * sample; the *fragment shader runs once per pixel*, and this renderer is fragment-bound
     * (`BUDGETS.desktopGpuMsP95`'s note: a 20-fetch PCSS filter over `MeshPhysicalMaterial`
     * plus an fbm normal plus IBL). So the shading cost — the cost that decides whether this
     * device holds 60 fps — does not move. What grows is the colour/depth buffer and the
     * resolve: at `dpr 1.0` on a 2560x1600 panel the backing store is 1.02 Mpx against the
     * high tier's 4.1 Mpx at `dpr 2.0`, so even 4x MSAA here writes less bandwidth than the
     * tier above it does with none.
     */
    antialias: true,
    maxInstances: 90,
    /*
     * `detail: 2`, not 1.
     *
     * `pick3`'s cheapest entry is a *shading* budget being asked to decide a *silhouette*,
     * and `3D-SPEC §0` ("no hard edge anywhere in this product") and `§3` ("no geometry
     * ships with a 90° silhouette corner") are not tiered statements. At 1 the low tier
     * shipped a 12-sided turntable, a hexagonal-prism milk bottle with a hard shoulder, a
     * stair-stepped tray rim and a mascot whose crown facets cut its mouth into a straight
     * downturned dash — the character frowning, on the device §1.4 names as the target.
     *
     * `geometry.ts::MIN_SILHOUETTE_SEGMENTS` floors the outline counts independently, so
     * this is belt *and* braces: the floor catches anything that reaches for an outline, and
     * this stops the tier reaching for the cheapest entry of anything at all.
     *
     * Measured cost of the pair (`scratchpad/tris.mjs`, building each prop at the round-4
     * low tier's resolved counts and at today's): eight representative props go **3312 ->
     * 7128 triangles, +3816, which is 2.12 % of §9's 180 k ceiling** on a scene the round-4
     * capture measured at 14.7 k. The geometry budget was never the constraint on this
     * device — fill rate is, and triangles are not fill.
     */
    detail: 2,
  },
  mid: {
    shadowMapSize: 1024,
    antialias: true,
    maxInstances: 160,
    detail: 2,
  },
  high: {
    shadowMapSize: 1024,
    antialias: true,
    maxInstances: 260,
    detail: 3,
  },
};

const DPR: Record<Tier, number> = { low: 1, mid: 1.5, high: 2 };

/**
 * Everything the tier decision was made from, kept so a capture can *state* which tier it
 * ran at and why instead of leaving the reader to guess.
 *
 * `3D-SPEC §4`'s target is a mid-range Android tablet, and `probed` is what that device
 * would land on with no `?tier=` override. `deviceMemory` is the single value that decides
 * mid vs low for a coarse pointer (see `decide`), and it is reported here as `null` when
 * the browser does not implement it — Safari and Firefox do not — rather than silently
 * folded into the 4 GB assumption the decision falls back to.
 */
export type TierProbe = {
  /** The tier actually in force this session. */
  tier: Tier;
  /** `?tier=` if it was set and valid, else null. */
  forced: Tier | null;
  /** What this device would have chosen on its own. Equals `tier` when `forced` is null. */
  probed: Tier;
  /** `navigator.hardwareConcurrency`, or null if the browser withholds it. */
  cores: number | null;
  /** `navigator.deviceMemory` in GB, or null where the API does not exist. */
  deviceMemory: number | null;
  coarsePointer: boolean;
  /** `UNMASKED_RENDERER_WEBGL`, lowercased. Empty when the debug extension is blocked. */
  renderer: string;
  /** True when `renderer` matched the known-slow mobile GPU families and pinned `low`. */
  pinnedBySlowGpu: boolean;
  /** `window.devicePixelRatio` at boot — the other half of what `dpr` resolves to. */
  devicePixelRatio: number;
};

/** Mobile GPU families that cannot hold 60fps at this shader cost whatever the core count. */
const SLOW_GPU = /mali-4|mali-t|adreno \(tm\) [345]|powervr (sgx|ge8)/;

const readRendererString = (): string => {
  try {
    if (typeof document === "undefined") return "";
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    if (!gl) return "";
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    const name = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) ?? "").toLowerCase() : "";
    const lose = gl.getExtension("WEBGL_lose_context");
    lose?.loseContext();
    return name;
  } catch {
    /* probing is best-effort */
    return "";
  }
};

/**
 * The decision proper, over values already read. Pure, so the probe record cannot drift.
 *
 * ## What the target device gets, and why
 *
 * `3D-SPEC §1.4`'s target is a mid-range Android tablet, and a mid-range Android tablet
 * lands on **`low`**. That is deliberate, and round 4 was right to make the product prove it
 * rather than assume it, because a tier that nobody art-directs is a tier nobody should ship
 * — the fix for that finding is `TIERS.low` above (real antialiasing, real silhouettes),
 * not a promotion.
 *
 * The arithmetic against promoting it is the project's own. `BUDGETS.desktopGpuMsP95` models
 * this device at roughly 12x the per-pixel cost of the desktop these captures ran on, and
 * lands the *whole* 60 Hz frame at ~14.4 ms at ~2.2 Mpx. 2.2 Mpx is the **mid** tier's pixel
 * count on that panel (`dpr 1.5` on 2560x1600 ≈ 2.3 Mpx). The low tier's is 1.02 Mpx. So the
 * model that says the target device *just* holds 60 fps is already a model of the mid tier,
 * with nothing left over — and `§9` pins mid's dpr at 1.5, so mid cannot be made cheaper
 * without breaking the spec instead. Promoting the target device is a 2.25x fill increase on
 * the one device in the product with no fill to spare.
 *
 * ## The bug that was here
 *
 * The coarse-pointer branch read `c >= 8 && m >= 6`, and **`m >= 6` was unsatisfiable for any
 * value the API can return.** `navigator.deviceMemory` is deliberately quantised for
 * fingerprinting resistance: it reports the nearest value in `{0.25, 0.5, 1, 2, 4, 8}`, capped
 * at 8. There is no 6. A tablet with 6 GB reports 4. So `m >= 6` meant `m === 8`, i.e. "8 GB
 * or more, reported", and the table said something it did not do. The predicate below now
 * says what it means, in the API's own units.
 *
 * The values are read as a *floor*, never as a measurement: 4 means "4 GB or the nearest
 * bucket below what this device has", and a browser that withholds the API entirely (Safari
 * and Firefox do) falls back to 4 rather than to a guess in either direction.
 */
function decide(
  cores: number | null,
  memory: number | null,
  coarse: boolean,
  renderer: string
): Tier {
  if (SLOW_GPU.test(renderer)) return "low";
  const c = cores ?? 4;
  const m = memory ?? 4;
  if (c <= 4 || m <= 2) return "low";
  // A coarse pointer means a phone or tablet. `low` is the honest default there and `high`
  // is never on offer; `mid` needs the top of both quantised scales — 8 reported cores and
  // the API's 8 GB ceiling — because that is the only signal available that separates a
  // flagship tablet from the mid-range one this product is tuned for.
  if (coarse) return c >= 8 && m >= 8 ? "mid" : "low";
  return c >= 8 ? "high" : "mid";
}

function probe(): TierProbe {
  const forced =
    FLAGS.tier === "low" || FLAGS.tier === "mid" || FLAGS.tier === "high" ? FLAGS.tier : null;

  if (typeof navigator === "undefined") {
    return {
      tier: forced ?? "mid",
      forced,
      probed: "mid",
      cores: null,
      deviceMemory: null,
      coarsePointer: false,
      renderer: "",
      pinnedBySlowGpu: false,
      devicePixelRatio: 1,
    };
  }

  const cores = typeof navigator.hardwareConcurrency === "number" ? navigator.hardwareConcurrency : null;
  const nav = navigator as Navigator & { deviceMemory?: number };
  const deviceMemory = typeof nav.deviceMemory === "number" ? nav.deviceMemory : null;
  const coarsePointer =
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(pointer: coarse)").matches
      : false;
  const renderer = readRendererString();
  const probed = decide(cores, deviceMemory, coarsePointer, renderer);

  return {
    tier: forced ?? probed,
    forced,
    probed,
    cores,
    deviceMemory,
    coarsePointer,
    renderer,
    pinnedBySlowGpu: SLOW_GPU.test(renderer),
    devicePixelRatio: typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1,
  };
}

/**
 * The probe record for this session. Read by `window.__perf` so every capture carries the
 * tier it was taken at — `3D-SPEC §9`'s budgets mean nothing without it, and the round-3
 * corpus contained no `?tier=mid` measurement at all.
 */
export const TIER_PROBE: TierProbe = probe();

/**
 * Decided once, from the tier the device booted on, and never revised. See `softShadows`
 * in `QualitySettings` for why this cannot be a per-tier field.
 */
const BOOT_TIER: Tier = TIER_PROBE.tier;
/** See `softShadows` in `QualitySettings`: every tier, with the tap count tiered instead. */
const SOFT_SHADOWS = true;

/**
 * How many Vogel tap groups the PCSS filter compiles, by boot tier. Read by `materials.ts`,
 * which is also where the group sizes live.
 *
 *   | tier | groups | fetches at contact | fetches at the widest penumbra |
 *   |---|---|---|---|
 *   | low  | 1 | 20 | 20 |
 *   | mid  | 2 | 20 | 32 |
 *   | high | 3 | 20 | 44 |
 *
 * The blocker search is 8 fetches at every tier and the first filter group is 12, so the
 * cheapest tier costs 20 against the stock fixed-radius kernel's 17. The extra groups only
 * fire on fragments whose measured penumbra is already wide, which is a minority of any
 * frame — a shadow is mostly umbra and unshadowed floor.
 */
export const PCSS_GROUPS_FOR_TIER: Record<Tier, number> = { low: 1, mid: 2, high: 3 };

const build = (tier: Tier): QualitySettings => ({
  tier,
  dpr: Math.min(typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1, DPR[tier]),
  ...TIERS[tier],
  softShadows: SOFT_SHADOWS,
});

export const quality = createStore<QualitySettings>(build(BOOT_TIER));

/* ------------------------------------------------------------------ */
/* When to degrade                                                     */
/* ------------------------------------------------------------------ */

/**
 * The display's own frame period, learned from the frames the app actually renders.
 *
 * `Stage` calls `noteFramePeriod` once per frame with the interval since the previous one.
 * The estimate is the **mode** of a coarse histogram, not the mean or the median: a session
 * that drops a third of its frames still spends most of its intervals at exactly one refresh
 * period, and the mode finds that where an average would be dragged into the gaps.
 *
 * Bins are 0.5 ms wide from 4 ms to 44 ms, which covers 240 Hz down to 22 Hz, and the whole
 * thing is one preallocated `Int32Array` written with integer arithmetic — it runs inside a
 * frame callback, and `3D-SPEC §9` allows zero allocations there.
 */
/*
 * One estimator, not two.
 *
 * Round 4 landed this histogram here (A11) and a second one in `src/dev/perf.ts` (A12), both
 * fed once per frame, at different resolutions (0.5 ms vs 0.25 ms) and with different
 * honesty rules (this one assumed 60 Hz until it had learned; that one reported `null`). Two
 * estimators for one physical quantity can disagree, and did: the degrade watchdog and the
 * dropped-frame check could be reading different periods in the same session. `perf.ts` now
 * delegates here, so there is one histogram, one feed and one answer.
 *
 * The surviving resolution is `perf.ts`'s finer one, because A12's thresholds are derived
 * from the period: at 120 Hz a 0.5 ms bin puts the mode at 8.25 ms against a true 8.333, and
 * the entry-hitch budget it derives (2x) is then 0.17 ms adrift. 0.25 ms bins from 0 to 40 ms
 * cover 25 Hz to 240 Hz, cost one integer increment per frame and allocate nothing.
 */
const PERIOD_BIN_MS = 0.25;
const PERIOD_BIN_MIN = 0;
const PERIOD_BINS = 160;
/** ~0.5 s at 120 Hz, ~1 s at 60 Hz — long enough for a stable mode, short enough to arm early. */
const PERIOD_MIN_SAMPLES = 60;
const periodHist = new Int32Array(PERIOD_BINS);
let periodSamples = 0;
let periodSampling = true;

/**
 * Turns period sampling off while frames are being produced synthetically.
 *
 * `src/dev/drive.ts` replaces `requestAnimationFrame` with a deterministic pump, and a
 * synthetic cadence says nothing about the panel. `perf.ts` flips this with its virtual-clock
 * flag; without it the harness would teach the degrade watchdog its own step size.
 */
export function setPeriodSampling(on: boolean): void {
  periodSampling = on;
}

/** Records one frame interval. Zero-allocation; safe to call from `useFrame`. */
export function noteFramePeriod(deltaMs: number): void {
  if (!periodSampling || deltaMs <= 0) return;
  const bin = ((deltaMs - PERIOD_BIN_MIN) / PERIOD_BIN_MS) | 0;
  if (bin < 0 || bin >= PERIOD_BINS) return;
  periodHist[bin]++;
  periodSamples++;
}

/**
 * The modal frame period in ms, or **null** while it is still being learned.
 *
 * Null rather than an assumed 60 Hz, and that is the point: everything downstream of this
 * number — the degrade watchdog here, the dropped-frame and entry-hitch checks in `perf.ts` —
 * must report UNMEASURED rather than act on a guess. The 16.67 this used to assume is right
 * on most machines and wrong on exactly the ones a watchdog exists for.
 */
export function displayPeriodMsOrNull(): number | null {
  if (periodSamples < PERIOD_MIN_SAMPLES) return null;
  let best = 0;
  let bestAt = -1;
  for (let i = 0; i < PERIOD_BINS; i++) {
    if (periodHist[i] > best) {
      best = periodHist[i];
      bestAt = i;
    }
  }
  if (bestAt < 0) return null;
  return PERIOD_BIN_MIN + (bestAt + 0.5) * PERIOD_BIN_MS;
}

/** How many rAF intervals have been recorded, and how many are needed. For UNMEASURED copy. */
export const periodSampleCount = (): number => periodSamples;
export const PERIOD_SAMPLES_NEEDED = PERIOD_MIN_SAMPLES;

/** 60 Hz, the period §9 targets. Used only for display where a number must be printed. */
const ASSUMED_PERIOD_MS = 1000 / 60;

/** The learned period, or the 60 Hz assumption. Never use this to decide anything. */
export function displayPeriodMs(): number {
  return displayPeriodMsOrNull() ?? ASSUMED_PERIOD_MS;
}

/**
 * Fraction of a display period a frame may overrun by before it counts as dropped.
 * 1.5 is the standard half-way point: a frame that misses one vsync lands at 2.0 periods, one
 * that makes it lands at 1.0, and nothing legitimate lands between.
 */
const DROPPED_PERIOD_RATIO = 1.5;

/**
 * Should the renderer give up a tier?
 *
 * **The `&&` this replaces could not fire on the hardware it existed for.** It read
 * `p95(period) > 22.5 ms && p95(work) > 9.2 ms`, where `work` is CPU time between
 * `beginFrame` and `endFrame`. A GPU-bound frame — which is precisely what a fragment-bound
 * clay shader on a tablet produces, and precisely what this watchdog is for — stretches
 * `period` while `work` sits at the **0.3–1.5 ms** the round-4 captures actually measured. So
 * the second arm was never true and the net never fired.
 *
 * Note that dropping the work gate to `frameMsP95 × 0.25` — the fix the audit offered as an
 * alternative — does not fix it either: 0.25 × 16.7 = 4.18 ms is still nearly three times the
 * worst CPU frame in the corpus. The gate has to stop asking *where* the time went.
 *
 * What it asks instead is whether frames are being **missed**, measured against the display's
 * own period rather than against a hard-coded 60 Hz:
 *
 *   `p95(period) > 1.5 × displayPeriod` — the machine is failing to hit its own refresh —
 *   **and nothing else.** In particular there is deliberately no arm asking where the time
 *   went. A CPU arm cannot see a GPU-bound frame, a GPU arm reads `null` on every browser
 *   without `EXT_disjoint_timer_query_webgl2`, and a `null` there must never be allowed to
 *   read as "the GPU is fine" — which is what any conjunction of the two would do.
 *
 * This is what makes it reject the two false positives the `&&` was protecting against, and
 * it rejects them *by construction* rather than by luck:
 *
 *  - **A 30 Hz panel.** Every interval is 33.3 ms, so the mode is 33.3 ms and `p95` is 33.3 ms.
 *    `33.3 > 1.5 × 33.3` is false. The old absolute 22.5 ms threshold called this a failure.
 *  - **Background throttling.** Intervals collapse to ~1000 ms *uniformly*, so the mode moves
 *    with them and the ratio stays at 1. And the work arms are both far under budget while
 *    throttled, so even a mixed window cannot trip it.
 *
 * Everything else a p95 over the ratio could mean — a GC pause, a compositor hiccup, another
 * tab taking the GPU for a moment — is transient, and the caller's 3-strike / ~2.4 s
 * hysteresis is what rejects it. That hysteresis is the only reason a single condition is
 * safe here, and it is not optional.
 */
export function shouldDegrade(periodP95Ms: number): boolean {
  // Unmeasured is not a reason to degrade. Until the panel's own period is known there is
  // no ratio to test, and testing against an assumed 60 Hz would drop a tier on a 30 Hz
  // panel in its first second — the exact false positive the paragraph above rejects.
  const period = displayPeriodMsOrNull();
  if (period === null) return false;
  return periodP95Ms > period * DROPPED_PERIOD_RATIO;
}

/** Drops one tier when sustained frame cost exceeds budget. Never climbs back. */
export function degradeQuality(): void {
  const current = quality.get().tier;
  if (current === "high") quality.set(build("mid"));
  else if (current === "mid") quality.set(build("low"));
}

/** Synchronous read for per-frame code. */
export const getQuality = () => quality.get();

/**
 * Hard budgets from the spec. `src/dev/perf.ts` asserts against these so the perf critic
 * measures instead of eyeballing.
 */
export const BUDGETS = {
  drawCallsGame: 90,
  drawCallsHub: 60,
  triangles: 180_000,
  materials: 28,
  renderTargets: 3,
  frameMsP95: 16.7,
  /** Desktop proxy for "60fps on a mid-range Android": 4x CPU headroom. */
  desktopFrameMsP95: 4.2,
  /**
   * GPU p95 per frame, measured with `EXT_disjoint_timer_query_webgl2` (see
   * `src/dev/perf.ts`). Two different numbers because they are two different claims:
   *
   *  - `desktopGpuMsP95` is a **proxy**, and it is *projected, never measured*. The clay
   *    shader is fragment-bound (a 20-fetch PCSS filter on top of `MeshPhysicalMaterial` +
   *    fbm normal + IBL), so the scaling that matters is fill rate, not triangles — and the
   *    ~12x figure below is therefore a **per-pixel** ratio. It only becomes a whole-frame
   *    factor after multiplying by the two devices' pixel counts:
   *
   *        factor = 12 x (targetPixels / measuredPixels)
   *
   *    Both counts were wrong here until round 5, and the two errors happened to cancel.
   *    The captures ran at 1440x900 at dpr 1 = **1.296 Mpx**, not the ~5.0 Mpx this note
   *    claimed; and the target device boots the **low** tier, whose `DPR.low = 1` means the
   *    renderer is configured never to draw more than **1.024 Mpx** on it — not the 2.2 Mpx
   *    of its native panel, which is the *mid* tier's pixel count and is what §9 pins at
   *    dpr 1.5. So the whole-frame factor is 12 x 1.024/1.296 = **9.48**, and the desktop
   *    reading that projects to one 60 Hz frame is 16.7 / 9.48 = **1.76 ms**.
   *
   *    The published 1.2 is therefore 1.47x stricter than the model that was cited to
   *    justify it. It stands — but as a choice, not as a derivation. `src/dev/perf.ts`
   *    re-derives 1.76 from these same numbers and asserts against `min(1.2, derived)`, a
   *    one-way ratchet: editing this model can tighten the bar and can never loosen it
   *    below what is published here.
   *
   *    Nothing in this process has ever run on the target device. `perf.ts` emits
   *    `gpuMsP95@target` as UNMEASURED unconditionally so that a clean `violations: []` on
   *    a desktop can never be read as "60 fps on the named device".
   *  - `gpuMsP95` is the **fact**: a GPU frame longer than one 60Hz period cannot hold 60fps
   *    on any device, so on real handheld hardware this is a proof of failure when exceeded
   *    and merely necessary, never sufficient, when met.
   */
  desktopGpuMsP95: 1.2,
  gpuMsP95: 16.7,
} as const;
