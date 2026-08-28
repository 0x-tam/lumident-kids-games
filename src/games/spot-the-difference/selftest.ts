/**
 * `?selftest=spot` — proof that the two panels are the same picture.
 *
 * The whole game rests on one claim: *the only pixels that differ between the left and the
 * right picture are the differences a child is asked to find.* A drifting camera, a second
 * light, an unequal viewport or a stray exposure change would each invent a sixth
 * difference that cannot be found, and none of them is visible to the eye until a child is
 * stuck. So the claim is measured, not asserted.
 *
 * Three checks, in order of how badly they matter:
 *
 *  1. **Control.** Render the *right* panel with the *left* panel's visibility and diff the
 *     two rectangles. Anything at all that differs between the panels other than the
 *     intended toggles shows up here, and the expected answer is exactly zero pixels. A
 *     handful of *isolated* 1x1 pixels is tolerated and always reported — see
 *     `CONTROL_ISOLATED_MAX` for exactly what that allowance is and why it is a shape
 *     constraint rather than a looser threshold.
 *  2. **Placement.** Render normally and diff. Every differing pixel must fall inside the
 *     screen bound of an intended difference — the union of its two versions plus every
 *     shadow either version can throw — and every intended difference must actually produce
 *     a cluster.
 *  3. **Geometry.** Both panels must have been drawn at the same device-pixel size, which
 *     is what lets one camera serve both.
 *  4. **The reward does not cover the reward.** Every found badge must sit clear of the prop
 *     it marks, in projected panel pixels. Round 4's SD2 is that this was false: the marker
 *     was an annulus drawn *over* the prop, and at 3/3 three of them hid the duck, the towel
 *     and the whole shelf-and-window corner. The badges are placed by a search in `layout.ts`
 *     rather than by hand, and this measures the result of that search in the projection the
 *     child is looking at rather than trusting the arithmetic.
 *  5. **How much of the play area is picture.** Reported, and — since round 4 — reported for
 *     the whole game rather than living in a docblock that stated the numbers and shipped
 *     without them. See where it is computed for why it is not a threshold.
 *
 * The pass line also reports how much of the panel the expected regions cover, because check 2
 * is exactly as strong as those regions are small and nothing has ever said how big they are.
 * It is a reported number, not a threshold: see where it is computed.
 *
 * The rectangles are read straight back off the live drawing buffer, so this measures the
 * viewports, the projection and the multisample resolve the child is really looking at.
 */
import { pixelDiff, registerSelfTest, type SelfTestResult } from "../../dev/selftest";
import { playAreaMetrics } from "../../three/Scene3D";
import { DIFFS } from "./engine";
import { DIORAMA_ASPECT, PANEL_GAP } from "./layout";
import { spotHandle, type SpotHandle } from "./scene";

const NAME = "spot";

/**
 * The control tolerates at most a 4/255 wobble per channel.
 *
 * Not zero, for exactly one reason: every clay material ships with three's `dithering`
 * (`materials.ts` sets it, to keep large cream gradients from banding in 8-bit), whose
 * ±0.5/255 shift is keyed off `gl_FragCoord`, which is absolute window space and so differs
 * between the two panels by construction. It can flip an output byte by one, and nothing else
 * in the pipeline is screen-space. Four levels swallows that (and any driver rounding) while a
 * real drift — a moved camera, a second light, an exposure change — moves tens of levels
 * across thousands of pixels.
 *
 * **"Nothing else in the pipeline is screen-space" is an invariant, not an observation**, and
 * round 3 broke it: the PCSS penumbra's Vogel-disc rotation was keyed on `gl_FragCoord.xy`,
 * which rotated the disc differently in two panels drawn ~780 device px apart and made this
 * test report 2466 differing pixels in 1367 clusters, twice. The shared round re-keyed it onto
 * the shadow-space coordinate (`materials.ts`, `lumidentPCSS`). Anything added to a clay
 * material that reads a window-space quantity will land here, and it will look like a game
 * bug rather than a shader one — which is precisely why this test exists.
 */
const CONTROL_THRESHOLD = 4;
/** The live diff is compared a touch more loosely so a single AA-edge texel is not news. */
const LIVE_THRESHOLD = 6;

/**
 * Isolated single pixels the control is allowed to report, and the shape they must have.
 *
 * The primary fix for round 2's red `?selftest=spot` is in `scene.tsx`: both panel
 * rectangles are now solved in device pixels and snapped to even origins *and* even
 * extents, so the two viewports start and end on the same multisample resolve quad however
 * the device pixel ratio lands. That should take the control to a clean zero.
 *
 * This is the fallback the fix list authorises if it does not, and it is deliberately a
 * *shape* constraint rather than a bigger number: round 2 measured 1 and 2 differing pixels
 * in separate runs, in 1x1 clusters, at different places each time — the signature of a
 * resolve, not of a camera, a light or an exposure moving. Any cluster of 2x2 or larger, or
 * more than `CONTROL_ISOLATED_MAX` isolated pixels, is a real drift and still fails. What is
 * tolerated is always named in the result text, on the pass path as well as the fail path,
 * so a green run can never quietly hide a growing number.
 */
const CONTROL_ISOLATED_MAX = 4;

const nextFrame = (): Promise<void> =>
  new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });

async function frames(n: number): Promise<void> {
  for (let i = 0; i < n; i++) await nextFrame();
}

/** Waits for the scene to mount, lay its panels out and render at least one frame. */
async function waitForScene(maxFrames: number): Promise<SpotHandle | null> {
  for (let i = 0; i < maxFrames; i++) {
    const handle = spotHandle();
    if (handle && handle.layout.ready === 1 && handle.layout.devW > 8 && handle.layout.devH > 8) {
      return handle;
    }
    await nextFrame();
  }
  return null;
}

function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      onTimeout();
      reject(new Error(`timed out after ${ms}ms waiting for a panel capture`));
    }, ms);
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        reject(error);
      }
    );
  });
}

const fixed = (n: number) => Math.round(n);

/**
 * Scratch mask for the expected-region coverage report. Grown on demand and reused, so a
 * repeated `?selftest=spot` does not allocate a fresh megabyte every run.
 */
let coverage = new Uint8Array(0);
function coverageFor(width: number, height: number): Uint8Array {
  const need = width * height;
  if (coverage.length < need) coverage = new Uint8Array(need);
  return coverage;
}

export async function runSpotSelfTest(): Promise<SelfTestResult> {
  // Roughly six seconds at 60Hz: enough for a lazily-loaded chunk, a first paint and the
  // layout pass, and short enough that a headless driver does not hang on it.
  const handle = await waitForScene(360);
  if (!handle) {
    return {
      name: NAME,
      pass: false,
      detail:
        "the Spot the Difference scene never rendered — open the game itself with ?selftest=spot",
    };
  }

  const restoreLevel = handle.engine.level;
  handle.engine.dealAll();
  handle.setTestMode(true);
  // Let the deal land, the pops reset and the camera's entry spring settle.
  await frames(6);

  try {
    /* ---- 1. control: both panels drawn from the same visibility ---- */
    const control = await withTimeout(handle.capture("aa"), 4000, handle.cancelCapture);
    const controlDiff = pixelDiff(control.a, control.b, {
      width: control.width,
      height: control.height,
      threshold: CONTROL_THRESHOLD,
    });
    let controlNote = "";
    if (controlDiff.differing !== 0) {
      let worst = controlDiff.clusters[0];
      for (let i = 1; i < controlDiff.clusters.length; i++) {
        const c = controlDiff.clusters[i];
        if (c.w * c.h > worst.w * worst.h || (c.w * c.h === worst.w * worst.h && c.count > worst.count)) {
          worst = c;
        }
      }
      const structured = worst.w > 1 || worst.h > 1;
      if (structured || controlDiff.differing > CONTROL_ISOLATED_MAX) {
        return {
          name: NAME,
          pass: false,
          detail:
            `PANEL DRIFT: ${controlDiff.differing} pixels differ between the two panels with ` +
            `identical content (${controlDiff.clusters.length} clusters, worst ${worst.w}x${worst.h} ` +
            `at ${fixed(worst.cx)},${fixed(worst.cy)}). ` +
            (structured
              ? "A cluster larger than 1x1 is structure, not resolve noise: the panels no " +
                "longer share one camera, one light rig or one viewport size."
              : `More than ${CONTROL_ISOLATED_MAX} isolated pixels is past what a multisample ` +
                `resolve can account for — check the even-device-pixel viewport snapping in ` +
                `scene.tsx before widening anything.`),
          data: {
            panel: `${control.width}x${control.height}`,
            clusters: controlDiff.clusters.slice(0, 6),
          },
        };
      }
      controlNote =
        ` TOLERATED: ${controlDiff.differing} isolated 1x1 pixel` +
        `${controlDiff.differing === 1 ? "" : "s"} in the control ` +
        `(cap ${CONTROL_ISOLATED_MAX}), attributed to the multisample resolve.`;
    }

    /* ---- 2. the real diff ---- */
    await frames(2);
    const live = await withTimeout(handle.capture("ab"), 4000, handle.cancelCapture);
    const { width, height } = live;
    const result = pixelDiff(live.a, live.b, { width, height, threshold: LIVE_THRESHOLD });
    const boxes = handle.expectedBoxes(width, height);

    if (boxes.length !== DIFFS.length) {
      return {
        name: NAME,
        pass: false,
        detail: `expected ${DIFFS.length} differences in play for the test, got ${boxes.length}`,
      };
    }

    const hits = new Int32Array(boxes.length);
    let strayPixels = 0;
    let strayClusters = 0;
    let strayNote = "";

    for (let c = 0; c < result.clusters.length; c++) {
      const cl = result.clusters[c];
      let inside = -1;
      for (let b = 0; b < boxes.length; b++) {
        const box = boxes[b];
        if (
          cl.x >= box.x0 &&
          cl.x + cl.w - 1 <= box.x1 &&
          cl.y >= box.y0 &&
          cl.y + cl.h - 1 <= box.y1
        ) {
          inside = b;
          break;
        }
      }
      if (inside >= 0) {
        hits[inside] += cl.count;
        continue;
      }
      strayClusters += 1;
      strayPixels += cl.count;
      if (strayNote === "") {
        strayNote = `${cl.w}x${cl.h} at ${fixed(cl.cx)},${fixed(cl.cy)} (${cl.count}px)`;
      }
    }

    if (strayPixels > 0) {
      return {
        name: NAME,
        pass: false,
        detail:
          `${strayPixels} differing pixels in ${strayClusters} clusters fall outside every ` +
          `intended difference — worst ${strayNote}. Something other than the five diff props ` +
          `is rendering differently between the panels.`,
        data: { panel: `${width}x${height}`, boxes, clusters: result.clusters.slice(0, 8) },
      };
    }

    const missing: string[] = [];
    for (let b = 0; b < boxes.length; b++) {
      if (hits[b] === 0) missing.push(DIFFS[boxes[b].index].hint);
    }
    if (missing.length > 0) {
      return {
        name: NAME,
        pass: false,
        detail: `these differences changed no pixels at all: ${missing.join(", ")}`,
        data: { panel: `${width}x${height}`, boxes, clusters: result.clusters.slice(0, 8) },
      };
    }

    /* ---- 3. the geometry that makes one camera legal for two panels ---- */
    const layout = handle.layout;
    if (layout.devW !== live.width || layout.devH !== live.height) {
      return {
        name: NAME,
        pass: false,
        detail: `the two panel viewports are not the same size (${layout.devW}x${layout.devH})`,
      };
    }

    /* ---- 4. the reward does not cover the reward (SD2) ---- */
    const marks = handle.markProbes(width, height);
    if (marks.length !== DIFFS.length) {
      return {
        name: NAME,
        pass: false,
        detail:
          `only ${marks.length} of ${DIFFS.length} found badges could be projected — a ` +
          `difference with no mark is a find a child gets no answer to`,
      };
    }
    const covering: string[] = [];
    const offPanel: string[] = [];
    let tightestGap = Infinity;
    for (const mark of marks) {
      // Two discs are clear when the gap between their rims is non-negative. Reported as a
      // number rather than a boolean so a future round can watch it shrink.
      const centres = Math.hypot(mark.badge.x - mark.prop.x, mark.badge.y - mark.prop.y);
      const gap = centres - mark.badge.r - mark.prop.r;
      if (gap < tightestGap) tightestGap = gap;
      if (gap < 0) {
        covering.push(
          `${DIFFS[mark.index].hint}: badge overlaps its own prop by ${(-gap).toFixed(0)}px`
        );
      }
      if (
        mark.badge.x - mark.badge.r < 0 ||
        mark.badge.y - mark.badge.r < 0 ||
        mark.badge.x + mark.badge.r > width ||
        mark.badge.y + mark.badge.r > height
      ) {
        offPanel.push(
          `${DIFFS[mark.index].hint}: badge circle (${mark.badge.x.toFixed(0)},` +
            `${mark.badge.y.toFixed(0)}) r${mark.badge.r.toFixed(0)} leaves the panel`
        );
      }
    }
    if (covering.length > 0 || offPanel.length > 0) {
      return {
        name: NAME,
        pass: false,
        detail:
          `the found badges do not clear the props they mark: ` +
          [...covering, ...offPanel].join("; ") +
          `. The placement search is in layout.ts (BADGES) — fix it there, not here.`,
        data: { panel: `${width}x${height}`, marks },
      };
    }

    /* ---- 5. how much of the play area is picture (SD4) ---- */
    const view = playAreaMetrics();
    const viewArea = view ? view.width * view.height : 0;
    /*
     * **Picture area, not panel area** — and the difference is the whole reason this number is
     * worth printing rather than eyeballing.
     *
     * `cameraFor` fits the diorama to whichever of the panel's two axes is tighter, so a panel
     * wider than `DIORAMA_ASPECT` shows a picture narrower than itself and the rest is dead
     * cream *inside the panel*. Measuring panel area therefore flatters exactly the layouts
     * that waste the most: on 1440x900 the old column solve scored 48.6 % of the play area on
     * panel area and **34.4 %** on picture area, because 51 px of every 457 px panel was cream.
     * The row solve this now uses scores 31.6 % on the same window — 2.8 points behind on the
     * quantity that means something, not the 17 the panel metric would have claimed.
     *
     * Reported, never asserted, and the distinction is deliberate. `3D-SPEC §6.5` says "two
     * miniature 3D bathroom dioramas side by side" and says nothing about how much of the
     * screen they should take, so a pass/fail line here would be a threshold invented by this
     * file — which is the exact failure round 4's A12 exists for. What the number is *for* is
     * that it is the one thing this game cannot fix from inside itself: the panels are limited
     * by `max-w-[860px]` on the wrapper in `src/GamesCollection.tsx`, and at 1500x820 that
     * leaves the pictures at 35.0 % of the play area. Raising the cap to 1400 takes the same
     * window to 659 x 457 panels and ~61 % with no geometry change at all. Printing it on every
     * run is what stops that from going back to being a claim in a comment.
     */
    const pictureH = Math.min(layout.pxW / DIORAMA_ASPECT, layout.pxH);
    const pictureArea = pictureH * pictureH * DIORAMA_ASPECT * 2;
    const occupancy = viewArea > 0 ? (pictureArea / viewArea) * 100 : 0;
    const occupancyNote =
      viewArea > 0
        ? ` The two panels are ${layout.pxW}x${layout.pxH} each and the pictures inside them ` +
          `cover ${occupancy.toFixed(1)}% of the ${view!.width}x${view!.height} play area ` +
          `(gap ${PANEL_GAP}px); the tightest badge-to-prop gap is ` +
          `${tightestGap.toFixed(0)}px.`
        : "";

    const perDiff = DIFFS.map((d, i) => {
      const at = boxes.findIndex((b) => b.index === i);
      return `${d.hint}:${at >= 0 ? hits[at] : 0}`;
    }).join(" ");

    /*
     * How much of the picture "none stray" is actually a claim about.
     *
     * Check 2 passes when every differing pixel sits inside some expected box, and the boxes
     * are generated by the same module that places the props — so the claim is only as strong
     * as the boxes are small. They are a prop's screen bound *plus* every shadow either version
     * could throw onto four receivers *plus* a 4.5 % pad, and nothing has ever reported how much
     * of the panel that adds up to. Reported, not asserted: a threshold picked without a
     * measurement to hang it on would be the same failure this whole round is about. A future
     * round now has the number to set one from, and to watch for growth.
     */
    const mask = coverageFor(width, height);
    mask.fill(0);
    for (let b = 0; b < boxes.length; b++) {
      const box = boxes[b];
      const x0 = Math.max(0, Math.floor(box.x0));
      const x1 = Math.min(width - 1, Math.ceil(box.x1));
      const y0 = Math.max(0, Math.floor(box.y0));
      const y1 = Math.min(height - 1, Math.ceil(box.y1));
      for (let y = y0; y <= y1; y++) {
        const row = y * width;
        for (let x = x0; x <= x1; x++) mask[row + x] = 1;
      }
    }
    let covered = 0;
    for (let i = 0; i < width * height; i++) covered += mask[i];
    const coveragePct = ((covered / (width * height)) * 100).toFixed(1);

    return {
      name: NAME,
      pass: true,
      detail:
        `panels ${width}x${height}px are pixel-identical with matched content ` +
        `(${controlDiff.differing} differing), and all ${DIFFS.length} differences land inside ` +
        `their own region: ${result.differing} differing pixels in ${result.clusters.length} ` +
        `clusters, none stray. The regions cover ${coveragePct}% of the panel, so ${(
          100 - Number(coveragePct)
        ).toFixed(1)}% of it is asserted bit-identical. [${perDiff}]${occupancyNote}${controlNote}`,
      data: {
        panel: `${width}x${height}`,
        differing: result.differing,
        boxCoveragePct: Number(coveragePct),
        playAreaOccupancyPct: Number(occupancy.toFixed(1)),
        panelPx: `${layout.pxW}x${layout.pxH}`,
        tightestBadgeGapPx: Number(tightestGap.toFixed(1)),
        boxes,
      },
    };
  } finally {
    handle.setTestMode(false);
    handle.engine.deal(restoreLevel);
  }
}

registerSelfTest(NAME, runSpotSelfTest);
