/**
 * Tooth Match's two self-checks, and the two round-4 defects they exist because of.
 *
 * Both are registered from `scene.tsx` behind a lazy `import()` gated on `?selftest=`, so
 * nothing here reaches a child's bundle: Rollup emits it as its own chunk that is only ever
 * requested when the query string asks for it.
 *
 * ## `tooth-match-camera` (TM1)
 *
 * The camera solve in `layout.ts` was correct, and its own 193,116-case sweep was correct,
 * and neither mattered: `ToothMatch.tsx` fed it `(level, 0, 0, 132)` for the life of every
 * mount, because a `useLayoutEffect` read an ancestor's ref before React had attached it and
 * never retried. Round 4 photographed the result — a 2.04x over-zoom at 390x844 with two of
 * six cards clipped off the frame — and the game shipped it with a `console.error` armed for
 * exactly this case that could not fire, because the *solve* never overflowed. It was the
 * *call* that was wrong.
 *
 * So this check does two things a sweep cannot:
 *
 *  1. asserts `cameraFor` was last called with a **measured** rect — `lastFraming()` reports
 *     the arguments, not the answer, and a 0x0 rect or a chrome height still sitting on
 *     `CHROME_FALLBACK_PX` after the shell has published its own is the defect itself;
 *  2. re-solves at the live rect and at a true 390x844 phone shell, for all three levels,
 *     and projects **every card's four corners and every focus ring's outer edge** into NDC,
 *     failing on anything outside `1 - MARGIN_NDC` or anything under the chrome band. That is
 *     the regression case the fix list asked for, expressed against the geometry a child
 *     touches rather than against the solve's own residual.
 *
 * ## `tooth-match-reliefs` (TM5)
 *
 * `motifs.ts`'s header claimed "every vertex of every one of them inside the card's outline
 * and inside its footprint". It was a comment. It was also true only at rest: the scene draws
 * the relief at `easeOutBack(faceOut, MOTIF_POP_BACK) * scale`, which peaks 8.98 % higher, and
 * at that peak the star stood 5.4 % outside the printed panel. This walks the **shipped
 * vertex buffers** through the same transforms the scene applies, at the pop peak, and
 * asserts the containment in code.
 */
import { registerSelfTest, type SelfTestResult } from "../../dev/selftest";
import { buildMotifs, type MotifPart } from "./motifs";
import {
  CARD_H,
  CARD_T,
  CARD_W,
  ELEV_COS,
  ELEV_SIN,
  HIT_RADIUS,
  INLAY_INSET,
  MOTIF_DZ,
  MOTIF_FOOT_BAND,
  PITCH_X,
  PITCH_Z,
  REST_Y,
  RELIEF_FAR_Z,
  RELIEF_HALF_X,
  RELIEF_MAX_H,
  RELIEF_NEAR_Z,
  RELIEF_POP_PEAK,
  RELIEF_U_SPAN,
  SILHOUETTE_FAR_Z,
  SILHOUETTE_NEAR_Z,
  TAP_FLOOR_PX,
  cameraFor,
  gridFor,
  lastFraming,
  screenUp,
} from "./layout";

/* ------------------------------------------------------------------ */
/* Camera                                                              */
/* ------------------------------------------------------------------ */

/**
 * `MARGIN_NDC` is private to `layout.ts` on purpose — it is the solve's own margin, not a
 * shared constant — so it is restated here as the *bar*, and the check would fail loudly if
 * the solve ever went looser than the bar rather than quietly adopting whatever it uses.
 * 3D-SPEC §8's tap floor is the same: stated, not imported from the thing being tested.
 */
const NDC_LIMIT = 0.955;
/** The ring's outer edge is `1.05 x` the footprint — `RING_PROUD` in `hit.tsx`. */
const RING_OUTER = 1.05;

/** A true 390x844 phone: `GamesCollection`'s panel is `max-w-860 px-4` under a 60 px back row. */
const PHONE = { label: "390x844", width: 390 - 32, height: 844 - 96, chrome: 221 };

type Overflow = { what: string; ndc: number };

/**
 * Projects every card corner and every focus-ring edge for one framing and returns whatever
 * left the frame.
 *
 * The projection is the camera's own: view depth along the elevation ray, screen-up from the
 * camera's up vector, `ndcX` scaled by the aspect. The ring's radius is re-derived here the
 * way `hit.tsx` derives it — `max(radius, tapFloor/2 * worldPerPixel)` at the target's own
 * depth, times `RING_OUTER` — rather than read from `layout.ts`, so a change to the solve's
 * internal `reachFor` cannot make this check agree with it by construction.
 */
function overflowsFor(level: number, width: number, height: number, chrome: number): Overflow[] {
  const f = cameraFor(level, width, height, chrome);
  const s = f.boardScale;
  const tanHalf = Math.tan((f.fov * Math.PI) / 360);
  const aspect = Math.max(0.4, width / height);
  const grid = gridFor(level);
  const bandTop = 1 - 2 * Math.min(0.34, chrome / height) - (1 - NDC_LIMIT);
  const out: Overflow[] = [];

  const project = (x: number, y: number, z: number) => {
    const dx = x * s - f.position[0];
    const dy = y * s - f.position[1];
    const dz = z * s - f.position[2];
    const vz = -(dy * ELEV_SIN + dz * ELEV_COS);
    return {
      vz,
      ndcX: dx / (vz * tanHalf * aspect),
      ndcY: (dy * ELEV_COS - dz * ELEV_SIN) / (vz * tanHalf),
    };
  };

  for (let row = 0; row < grid.rows; row++) {
    for (let col = 0; col < grid.cols; col++) {
      const cx = (col - (grid.cols - 1) / 2) * PITCH_X;
      const cz = (row - (grid.rows - 1) / 2) * PITCH_Z;
      const where = `L${level} card r${row + 1}c${col + 1}`;
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          const p = project(cx + (sx * CARD_W) / 2, REST_Y + CARD_T / 2, cz + (sz * CARD_H) / 2);
          const worst = Math.max(Math.abs(p.ndcX), Math.abs(p.ndcY));
          if (worst > NDC_LIMIT) out.push({ what: `${where} corner`, ndc: worst });
          if (p.ndcY > bandTop) out.push({ what: `${where} corner under the chrome`, ndc: p.ndcY });
        }
      }
      // The ring, sized the way `hit.tsx` sizes it, at the collider's own centre.
      const centre = project(cx, REST_Y + 0.18, cz);
      const perPixel = (2 * centre.vz * tanHalf) / height / s;
      const footprint = Math.max(HIT_RADIUS, TAP_FLOOR_PX * 0.5 * perPixel);
      const outer = RING_OUTER * footprint;
      for (const sx of [-1, 1]) {
        const p = project(cx + sx * outer, REST_Y + 0.18, cz);
        if (Math.abs(p.ndcX) > NDC_LIMIT) {
          out.push({ what: `${where} focus ring`, ndc: Math.abs(p.ndcX) });
        }
      }
    }
  }
  return out;
}

function cameraCheck(): SelfTestResult {
  const live = lastFraming();
  const failures: string[] = [];

  if (live.width <= 0 || live.height <= 0) {
    failures.push(
      `cameraFor was last called with a ${live.width}x${live.height} rect — the play area was ` +
        "never measured (TM1)"
    );
  }

  const cases: { label: string; level: number; width: number; height: number; chrome: number }[] =
    [];
  for (const level of [0, 1, 2]) {
    cases.push({ ...PHONE, level });
    if (live.width > 0 && live.height > 0) {
      cases.push({
        label: `live ${live.width}x${live.height}`,
        level,
        width: live.width,
        height: live.height,
        chrome: live.chromePx,
      });
    }
  }

  let worst = 0;
  for (const c of cases) {
    for (const o of overflowsFor(c.level, c.width, c.height, c.chrome)) {
      if (o.ndc > worst) worst = o.ndc;
      if (failures.length < 8) failures.push(`${c.label} ${o.what} at ${o.ndc.toFixed(3)} NDC`);
    }
  }

  // Restore the module's record of the live framing: `overflowsFor` calls `cameraFor`, which
  // rewrites it, and leaving a synthetic phone rect there would make a second run pass on a
  // rect nothing rendered.
  if (live.width > 0 && live.height > 0) {
    cameraFor(live.level, live.width, live.height, live.chromePx);
  }

  return {
    name: "tooth-match-camera",
    pass: failures.length === 0,
    detail:
      failures.length === 0
        ? `${cases.length} framings, every card corner and focus ring inside ${NDC_LIMIT} NDC ` +
          `and clear of the chrome band`
        : failures.join("; "),
    data: {
      live,
      framings: cases.length,
      ndcLimit: NDC_LIMIT,
      worstNdc: Number(worst.toFixed(4)),
    },
  };
}

/* ------------------------------------------------------------------ */
/* Reliefs                                                             */
/* ------------------------------------------------------------------ */

/**
 * Walks one motif's shipped vertex buffers through the scene's own transforms and returns the
 * extents, at a given uniform scale about the group's origin.
 *
 * Deliberately a second implementation rather than a call into `measureMotif`: a check that
 * reuses the code it is checking can only ever agree with it.
 */
function extentsAt(parts: MotifPart[], scale: number, z: number) {
  let xHalf = 0;
  let yMax = 0;
  let zMin = Infinity;
  let zMax = -Infinity;
  let uMin = Infinity;
  let uMax = -Infinity;
  const anchorU = MOTIF_DZ * ELEV_COS - z * ELEV_SIN;

  // Two passes: the footprint band is a fraction of a height the first pass finds.
  const local: { x: number; y: number; z: number }[] = [];
  for (const p of parts) {
    const attr = p.geometry.getAttribute("position");
    const [rx, ry, rz] = p.rotation;
    const [sx, sy, sz] = p.scale;
    for (let i = 0; i < attr.count; i++) {
      let x = attr.getX(i) * sx;
      let y = attr.getY(i) * sy;
      let zz = attr.getZ(i) * sz;
      let t = x * Math.cos(rz) - y * Math.sin(rz);
      y = x * Math.sin(rz) + y * Math.cos(rz);
      x = t;
      t = x * Math.cos(ry) + zz * Math.sin(ry);
      zz = -x * Math.sin(ry) + zz * Math.cos(ry);
      x = t;
      t = y * Math.cos(rx) - zz * Math.sin(rx);
      zz = y * Math.sin(rx) + zz * Math.cos(rx);
      y = t;
      x = (x + p.position[0]) * scale;
      y = (y + p.position[1]) * scale;
      zz = (zz + p.position[2]) * scale;
      local.push({ x, y, z: zz });
      const ax = x < 0 ? -x : x;
      if (ax > xHalf) xHalf = ax;
      if (y > yMax) yMax = y;
      if (zz < zMin) zMin = zz;
      if (zz > zMax) zMax = zz;
      const u = anchorU + screenUp(y, zz);
      if (u < uMin) uMin = u;
      if (u > uMax) uMax = u;
    }
  }
  let fzMin = Infinity;
  let fzMax = -Infinity;
  const footTop = yMax * MOTIF_FOOT_BAND;
  for (const v of local) {
    if (v.y > footTop) continue;
    if (v.z < fzMin) fzMin = v.z;
    if (v.z > fzMax) fzMax = v.z;
  }
  if (fzMin > fzMax) {
    fzMin = zMin;
    fzMax = zMax;
  }
  return { xHalf, yMax, zMin: z + zMin, zMax: z + zMax, fzMin: z + fzMin, fzMax: z + fzMax, uMin, uMax };
}

function reliefCheck(): SelfTestResult {
  const table = buildMotifs();
  const failures: string[] = [];
  const rows: Record<string, unknown>[] = [];
  const halfU = RELIEF_U_SPAN / 2;

  /*
   * The bounds themselves, before anything is measured against them.
   *
   * A12's lesson, applied here: a check that imports the constant it is checking can only
   * agree with it. Reverting `RELIEF_HALF_X` to the card's half-width — the round-4 value —
   * moves the bar and the measurement together, and a check that only walks vertices would
   * go on passing. So the *policy* is restated from the card's own dimensions and asserted
   * first: the panel is where a relief stands, so the panel is what bounds it.
   */
  const panelHalfX = (CARD_W - INLAY_INSET) / 2;
  const panelHalfZ = (CARD_H - INLAY_INSET) / 2;
  if (RELIEF_HALF_X > panelHalfX + 1e-9) {
    failures.push(
      `bound: RELIEF_HALF_X ${RELIEF_HALF_X.toFixed(4)} is outside the printed panel's ` +
        `${panelHalfX.toFixed(4)} — a relief that wide stands over the ivory frame`
    );
  }
  if (RELIEF_NEAR_Z > panelHalfZ + 1e-9 || RELIEF_FAR_Z > panelHalfZ + 1e-9) {
    failures.push(
      `bound: footprint z bounds [${(-RELIEF_FAR_Z).toFixed(4)}, ${RELIEF_NEAR_Z.toFixed(4)}] ` +
        `are outside the panel's +-${panelHalfZ.toFixed(4)}`
    );
  }
  if (SILHOUETTE_NEAR_Z > CARD_H / 2 + 1e-9 || SILHOUETTE_FAR_Z > CARD_H / 2 + 1e-9) {
    failures.push(
      `bound: silhouette z bounds are outside the card's +-${(CARD_H / 2).toFixed(4)}`
    );
  }
  if (RELIEF_POP_PEAK < 1) {
    failures.push(`bound: RELIEF_POP_PEAK ${RELIEF_POP_PEAK} cannot be below 1`);
  }

  for (const id of Object.keys(table) as (keyof typeof table)[]) {
    const fit = table[id];
    // The size the child actually sees at the top of the reveal, not the fitted one.
    const e = extentsAt(fit.parts, fit.scale * RELIEF_POP_PEAK, fit.z);
    const say = (what: string) => failures.push(`${id}: ${what}`);
    if (e.xHalf > RELIEF_HALF_X + 1e-6) {
      say(`half-width ${e.xHalf.toFixed(4)} past the panel's ${RELIEF_HALF_X.toFixed(4)}`);
    }
    if (e.yMax > RELIEF_MAX_H + 1e-6) {
      say(`height ${e.yMax.toFixed(4)} past the camera's reserved ${RELIEF_MAX_H.toFixed(4)}`);
    }
    if (e.uMax > halfU + 1e-6 || e.uMin < -halfU - 1e-6) {
      say(`screen-up [${e.uMin.toFixed(4)}, ${e.uMax.toFixed(4)}] past +-${halfU.toFixed(4)}`);
    }
    if (e.fzMax > RELIEF_NEAR_Z + 1e-6 || e.fzMin < -RELIEF_FAR_Z - 1e-6) {
      say(
        `footprint z [${e.fzMin.toFixed(4)}, ${e.fzMax.toFixed(4)}] off the panel ` +
          `[${(-RELIEF_FAR_Z).toFixed(4)}, ${RELIEF_NEAR_Z.toFixed(4)}]`
      );
    }
    if (e.zMax > SILHOUETTE_NEAR_Z + 1e-6 || e.zMin < -SILHOUETTE_FAR_Z - 1e-6) {
      say(
        `silhouette z [${e.zMin.toFixed(4)}, ${e.zMax.toFixed(4)}] off the card ` +
          `[${(-SILHOUETTE_FAR_Z).toFixed(4)}, ${SILHOUETTE_NEAR_Z.toFixed(4)}]`
      );
    }
    rows.push({
      id,
      scale: Number(fit.scale.toFixed(4)),
      peakHalfWidth: Number(e.xHalf.toFixed(4)),
      peakHeight: Number(e.yMax.toFixed(4)),
      peakFootZ: [Number(e.fzMin.toFixed(4)), Number(e.fzMax.toFixed(4))],
    });
  }

  return {
    name: "tooth-match-reliefs",
    pass: failures.length === 0,
    detail:
      failures.length === 0
        ? `${rows.length} reliefs, every shipped vertex inside its card at the ` +
          `x${RELIEF_POP_PEAK.toFixed(4)} reveal pop`
        : failures.join("; "),
    data: { popPeak: Number(RELIEF_POP_PEAK.toFixed(6)), reliefs: rows },
  };
}

let registered = false;

/** Idempotent: `scene.tsx` imports this on every mount and a re-mount must not re-arm twice. */
export function registerToothMatchChecks(): void {
  if (registered) return;
  registered = true;
  registerSelfTest("tooth-match-camera", cameraCheck);
  registerSelfTest("tooth-match-reliefs", reliefCheck);
}
