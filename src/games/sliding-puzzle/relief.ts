/**
 * The five pictures, as pure 2D geometry.
 *
 * The brief is that the puzzle's picture must be a **rendered relief** — real extruded
 * clay standing off each tile, lit by the scene — and that the tiles are windows onto one
 * continuous relief, so a solved board reads as a single object. This file is the source
 * of that relief, and it is deliberately free of three and of React: it describes each
 * scene as a list of closed 2D outlines with a stand-off height and a thickness, in one
 * continuous board-space square, and it knows how to cut those outlines into tile windows.
 *
 * Board space is `u, v` in `[-1, 1]`, `v` up, covering the whole grid whatever the level.
 * A tile's window is an axis-aligned rectangle of that square, so slicing a picture into
 * 4, 9 or 16 windows is one clip per outline per tile — and because the clip is exact, the
 * pieces re-join into the original silhouette when the child solves the board.
 *
 * Two rules make the slicing safe, and both are enforced by only ever building outlines
 * through the generators below:
 *
 *  1. **Every outline is convex** (the scalloped sun is the one deliberate exception, and
 *     its lobes are far too shallow to disconnect). Sutherland–Hodgman clipping of a convex
 *     polygon against a rectangle always yields exactly one convex polygon — never two
 *     islands joined by a zero-width bridge, which is what would tear a piece open.
 *  2. **Complex forms are unions of overlapping convex blobs**, never one clever concave
 *     outline. A cloud is three circles; a smile is two capsules; a toothbrush is a capsule
 *     plus a rounded rectangle plus four bristles.
 *
 * Colour comes from `tokens.ts` and nowhere else — the whole product is warm clay, so the
 * sky in these pictures is peach, not blue.
 */
import { ACCENTS, CLAY, NEUTRAL } from "../../three/tokens";
import { TILE_DEPTH_SCALE } from "./layout";

/* ------------------------------------------------------------------ */
/* Palette                                                             */
/* ------------------------------------------------------------------ */

export type MatKey =
  | "ivory"
  | "enamel"
  | "shine"
  | "ink"
  | "stone"
  | "bark"
  | "coral"
  | "coralSoft"
  | "red"
  | "redSoft"
  | "peach"
  | "peachSoft"
  | "peachDeep"
  | "rose"
  | "roseSoft"
  | "mauve"
  | "mauveSoft"
  | "mauveDeep";

/**
 * The relief's clay, as brand tokens.
 *
 * **This is the runtime palette, not a preview table** — the comment here used to say it was
 * only for offline previews, and it was wrong: `reliefMesh.ts::matRGB` converts every entry to
 * the linear working space and bakes it into `ALBEDO_ATTRIBUTE`, which is what actually paints
 * the picture. A wrong hex here is a wrong pixel.
 *
 * **`ink` is `NEUTRAL.inkMid`, not `NEUTRAL.ink`, and that is round 4's SP4.** The audit
 * measured a 25x18 px ink capsule on a board tile at **sigma 2.7-3.6 sRGB codes** of interior
 * variation against ivory's 7.4 in the same frame — "pure flat black with a hard silhouette,
 * no bevel highlight, no edge gloss, no rim" — and it is not the bevel: every piece in the
 * product carries at least 0.0216 units of real quarter-round. It is the transfer curve.
 * A clay's whole crevice-to-crown ramp is a *ratio*, and sRGB spends far fewer codes on a
 * ratio the darker the surface. Measured over the shipped shading ramp (`shade` 0.565 to
 * 1.1595 after `uClayAO`), against a light level recovered from the round-4 capture:
 *
 *   | clay              | linear luma | ramp spans  | in dL\* |
 *   |---|---|---|---|
 *   | `NEUTRAL.ink`     | 0.032 | 15.6 codes | **7.5** |
 *   | `NEUTRAL.inkMid`  | 0.087 | 23.7 codes | **10.5** |
 *   | `CLAY.crevice`    | 0.164 | 30.9 codes | 12.9 |
 *   | `CLAY.ivory`      | 0.925 | 63.6 codes | 23.0 |
 *
 * `MIN_ALBEDO_LUMA` states that as a rule rather than as a one-off swap, and
 * `reliefMesh.ts::reliefAlbedoFaults` holds every future picture to it on a dev boot.
 * `inkMid` is the *brand's own* second ink (it is in `index.css` and
 * `tokens.ts::assertTokensMatchCSS` proves the two agree), so this stays inside the palette
 * instead of inventing a grey. It is still 60 L\* below the ivory it sits on: an eye reads as
 * an eye.
 *
 * The other half of SP4 — the specular rim, which is the only cue that works on *any* dark
 * albedo — is `reliefMesh.ts::WEAR`.
 */
export const MAT_HEX: Record<MatKey, string> = {
  ivory: CLAY.ivory,
  enamel: CLAY.enamel,
  shine: CLAY.wear,
  ink: NEUTRAL.inkMid,
  stone: NEUTRAL.well,
  bark: CLAY.crevice,
  coral: ACCENTS.coral.main,
  coralSoft: ACCENTS.coral.soft,
  red: ACCENTS.red.main,
  redSoft: ACCENTS.red.soft,
  peach: ACCENTS.peach.main,
  peachSoft: ACCENTS.peach.soft,
  peachDeep: ACCENTS.peach.deep,
  rose: ACCENTS.rose.main,
  roseSoft: ACCENTS.rose.soft,
  mauve: ACCENTS.mauve.main,
  mauveSoft: ACCENTS.mauve.soft,
  mauveDeep: ACCENTS.mauve.deep,
};

/**
 * Floor on a relief clay's linear luminance — **derived from `NEUTRAL.inkMid`, not typed**.
 *
 * Below it a piece cannot show the form it is modelled with; see the table on `MAT_HEX` for
 * the arithmetic. Deriving it from the token rather than writing the number means the rule is
 * "no relief clay darker than the brand's second ink" and stays true if that token ever moves,
 * instead of being a constant that drifts away from the reason it was chosen.
 * `reliefMesh.ts::reliefAlbedoFaults` checks every entry against it on a dev boot.
 */
const toLinear = (c: number): number =>
  c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
const hexLuma = (hex: string): number => {
  const n = Number.parseInt(hex.replace("#", ""), 16);
  const r = toLinear(((n >> 16) & 255) / 255);
  const g = toLinear(((n >> 8) & 255) / 255);
  const b = toLinear((n & 255) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
export const MIN_ALBEDO_LUMA = hexLuma(NEUTRAL.inkMid);

/* ------------------------------------------------------------------ */
/* Outlines                                                            */
/* ------------------------------------------------------------------ */

/**
 * One relief element.
 *
 * `pts` is a flat, counter-clockwise `[u0, v0, u1, v1, …]` outline in board space.
 * `lift` and `depth` are in **authored** units — the same units as `TILE_DEPTH_SCALE`'s
 * input, so an outline scales with the board (a 2x2 and a 4x4 show the same picture) while
 * the relief's thickness does not, or an easy board would look like a cake and a hard one
 * like a decal.
 *
 * As written in the five scenes below they say **which piece is in front of which**, and
 * nothing more. `ladder()` reads that ordering, and every `lift` and `depth` that reaches
 * `reliefMesh.ts` is the one it derives — see its comment for why the authored thicknesses
 * could not be kept.
 */
export type Poly = {
  pts: number[];
  lift: number;
  depth: number;
  mat: MatKey;
};

const TAU = Math.PI * 2;

/** Segment count from a radius: small props stay cheap, big ones stay round. */
const segsFor = (r: number, min = 12, max = 34) => {
  const n = Math.round(Math.abs(r) * 120);
  return n < min ? min : n > max ? max : n;
};

export function circle(cx: number, cy: number, r: number, segs?: number): number[] {
  const n = segs ?? segsFor(r);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU;
    out.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
  }
  return out;
}

export function ellipse(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  rot = 0,
  segs?: number
): number[] {
  const n = segs ?? segsFor(Math.max(rx, ry));
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU;
    const x = Math.cos(a) * rx;
    const y = Math.sin(a) * ry;
    out.push(cx + x * c - y * s, cy + x * s + y * c);
  }
  return out;
}

/** Rounded rectangle. Convex, and every corner is a real arc — no square corners exist. */
export function roundRect(
  cx: number,
  cy: number,
  w: number,
  h: number,
  r: number,
  rot = 0,
  arcSegs = 6
): number[] {
  const hx = Math.max(w / 2 - r, 0);
  const hy = Math.max(h / 2 - r, 0);
  const rr = Math.min(r, Math.min(w, h) / 2);
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  const out: number[] = [];
  // Four corner arcs, counter-clockwise from the bottom-right.
  const corners: [number, number, number][] = [
    [hx, -hy, -Math.PI / 2],
    [hx, hy, 0],
    [-hx, hy, Math.PI / 2],
    [-hx, -hy, Math.PI],
  ];
  for (const [ox, oy, a0] of corners) {
    for (let i = 0; i <= arcSegs; i++) {
      const a = a0 + (i / arcSegs) * (Math.PI / 2);
      const x = ox + Math.cos(a) * rr;
      const y = oy + Math.sin(a) * rr;
      out.push(cx + x * c - y * s, cy + x * s + y * c);
    }
  }
  return out;
}

/** A thick, fully rounded line — handles, arms, grout lines, the halves of a smile. */
export function capsule(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  r: number,
  arcSegs?: number
): number[] {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy) || 1e-6;
  const ux = dx / len;
  const uy = dy / len;
  const a0 = Math.atan2(uy, ux);
  const n = arcSegs ?? Math.max(6, Math.round(segsFor(r) / 2));
  const out: number[] = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 - Math.PI / 2 + (i / n) * Math.PI;
    out.push(x1 + Math.cos(a) * r, y1 + Math.sin(a) * r);
  }
  for (let i = 0; i <= n; i++) {
    const a = a0 + Math.PI / 2 + (i / n) * Math.PI;
    out.push(x0 + Math.cos(a) * r, y0 + Math.sin(a) * r);
  }
  return out;
}

/**
 * A gently scalloped disc: `r(θ) = mid + amp·cos(lobes·θ)`.
 *
 * Used for the sun and for the little background stars. It is the one non-convex outline in
 * the file, and the amplitude must be kept under a fifth of the radius so the scallops are
 * dimples rather than points: a clip line can never separate two lobes from the body.
 *
 * **`lobes` must never be 4.** Round 2 shipped four background "sparkles" built as
 * `lobed(…, mid 0.09, amp 0.05, 4)` — an amplitude of 56% of the radius, eight times the
 * invariant above — and a four-fold star with deep valleys is not a star, it is a **plus
 * sign**. Two of them stood in `dentistScene`, in `ACCENTS.red`, beside a figure in a white
 * coat: a red first-aid cross, which the content rules forbid outright. Use `star()`.
 */
export function lobed(
  cx: number,
  cy: number,
  mid: number,
  amp: number,
  lobes: number,
  segs = 44
): number[] {
  const out: number[] = [];
  for (let i = 0; i < segs; i++) {
    const a = (i / segs) * TAU;
    const r = mid + amp * Math.cos(lobes * a);
    out.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
  }
  return out;
}

/**
 * The little five-point stars scattered in the sky of three of the pictures.
 *
 * Five-fold on purpose. Any four-fold rosette reads as a cross the moment its valleys get
 * deep enough to see, and a cross in a dental picture reads as a first-aid cross; odd
 * symmetry cannot. The amplitude stays inside `lobed`'s stated invariant, so this is also
 * the only scalloped outline in the file that is provably safe to clip.
 */
export function star(cx: number, cy: number, r: number): number[] {
  return lobed(cx, cy, r, r * 0.2, 5, 40);
}

/**
 * A baby-tooth silhouette: domed crown, softly tapered base.
 *
 * Deliberately a single convex blob rather than the classic two-rooted outline — a notch
 * between two roots is exactly the concavity that would let a horizontal tile cut split the
 * shape into two islands. The tooth still reads: it is the crown that carries the identity.
 */
export function toothOutline(cx: number, cy: number, w: number, h: number, segs = 46): number[] {
  const out: number[] = [];
  for (let i = 0; i < segs; i++) {
    const a = (i / segs) * TAU;
    const sin = Math.sin(a);
    const k = (1 - sin) / 2; // 0 at the crown, 1 at the base
    const rx = (w / 2) * (1 - 0.2 * k * k);
    const ry = h * (sin >= 0 ? 0.54 : 0.46);
    out.push(cx + Math.cos(a) * rx, cy + sin * ry);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Clipping                                                            */
/* ------------------------------------------------------------------ */

/** Signed area — used to reject slivers that would extrude into invisible junk. */
export function polyArea(pts: number[]): number {
  let a = 0;
  for (let i = 0, n = pts.length / 2; i < n; i++) {
    const j = (i + 1) % n;
    a += pts[i * 2] * pts[j * 2 + 1] - pts[j * 2] * pts[i * 2 + 1];
  }
  return a / 2;
}

/**
 * Clips one flat polygon against one half-plane. `side` picks the axis and direction:
 * 0 = keep x ≥ k, 1 = keep x ≤ k, 2 = keep y ≥ k, 3 = keep y ≤ k.
 *
 * Runs at build time only, so the allocation here is free; nothing in this file is ever
 * called from a frame.
 */
function clipHalf(pts: number[], side: number, k: number): number[] {
  const n = pts.length / 2;
  if (n === 0) return pts;
  const out: number[] = [];
  const axis = side < 2 ? 0 : 1;
  const keepAbove = side === 0 || side === 2;
  const dist = (i: number) => {
    const v = pts[i * 2 + axis];
    return keepAbove ? v - k : k - v;
  };
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const di = dist(i);
    const dj = dist(j);
    const xi = pts[i * 2];
    const yi = pts[i * 2 + 1];
    const xj = pts[j * 2];
    const yj = pts[j * 2 + 1];
    if (di >= 0) out.push(xi, yi);
    if ((di >= 0) !== (dj >= 0)) {
      const t = di / (di - dj);
      out.push(xi + (xj - xi) * t, yi + (yj - yi) * t);
    }
  }
  return out;
}

/** Removes points that landed on top of each other after clipping two adjacent edges. */
function dedupe(pts: number[], eps = 1e-5): number[] {
  const n = pts.length / 2;
  if (n < 3) return [];
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    if (Math.abs(pts[i * 2] - pts[j * 2]) < eps && Math.abs(pts[i * 2 + 1] - pts[j * 2 + 1]) < eps) {
      continue;
    }
    out.push(pts[i * 2], pts[i * 2 + 1]);
  }
  return out.length >= 6 ? out : [];
}

/**
 * Sutherland–Hodgman against an axis-aligned window. Returns an empty array when the
 * outline misses the window, or when what survives is too small to be worth a draw call.
 */
export function clipToWindow(
  pts: number[],
  minU: number,
  maxU: number,
  minV: number,
  maxV: number,
  minArea = 2e-4
): number[] {
  let cur = pts;
  cur = clipHalf(cur, 0, minU);
  if (cur.length < 6) return [];
  cur = clipHalf(cur, 1, maxU);
  if (cur.length < 6) return [];
  cur = clipHalf(cur, 2, minV);
  if (cur.length < 6) return [];
  cur = clipHalf(cur, 3, maxV);
  if (cur.length < 6) return [];
  cur = dedupe(cur);
  if (cur.length < 6) return [];
  return Math.abs(polyArea(cur)) < minArea ? [] : cur;
}

/* ------------------------------------------------------------------ */
/* Backgrounds                                                         */
/* ------------------------------------------------------------------ */

/**
 * The picture's ground colour, as a vertical ramp of brand tokens.
 *
 * It is not a relief element: it is painted onto the tiles themselves, one flat colour per
 * tile sampled at that tile's home cell, through the tile `InstancedMesh`'s per-instance
 * colour. That costs no geometry, no draw call and no material — and because the colour
 * travels with the tile, a scrambled board scrambles the sky exactly the way it scrambles
 * everything else.
 */
export type BgStop = [v: number, hex: string];

/** Returns the two stops bracketing `v` and the blend between them. */
export function bgSample(stops: BgStop[], v: number): { a: string; b: string; t: number } {
  if (v <= stops[0][0]) return { a: stops[0][1], b: stops[0][1], t: 0 };
  for (let i = 1; i < stops.length; i++) {
    if (v <= stops[i][0]) {
      const [v0, a] = stops[i - 1];
      const [v1, b] = stops[i];
      return { a, b, t: v1 === v0 ? 0 : (v - v0) / (v1 - v0) };
    }
  }
  const last = stops[stops.length - 1][1];
  return { a: last, b: last, t: 0 };
}

/* ------------------------------------------------------------------ */
/* The five scenes                                                     */
/* ------------------------------------------------------------------ */

export type ReliefScene = {
  id: string;
  name: string;
  bg: BgStop[];
  polys: Poly[];
};

const p = (pts: number[], lift: number, depth: number, mat: MatKey): Poly => ({
  pts,
  lift,
  depth,
  mat,
});

/* --- 1. Smiling Tooth ------------------------------------------------ */

const toothScene = (): Poly[] => {
  const out: Poly[] = [];
  // Warm ground the whole picture stands on — one outline, four windows wide.
  out.push(p(roundRect(0, -1.16, 2.9, 1.0, 0.3), 0, 0.05, "stone"));
  out.push(p(lobed(-0.6, 0.66, 0.2, 0.034, 10), 0.012, 0.055, "peach"));
  // Cloud: three overlapping discs, never one clever concave outline.
  out.push(p(circle(0.5, 0.74, 0.14), 0.02, 0.05, "enamel"));
  out.push(p(circle(0.67, 0.81, 0.11), 0.02, 0.05, "enamel"));
  out.push(p(circle(0.81, 0.72, 0.12), 0.02, 0.05, "enamel"));
  // The hero.
  out.push(p(toothOutline(0.02, -0.04, 0.74, 0.94), 0.03, 0.1, "enamel"));
  out.push(p(circle(-0.23, -0.11, 0.058), 0.122, 0.024, "roseSoft"));
  out.push(p(circle(0.27, -0.11, 0.058), 0.122, 0.024, "roseSoft"));
  out.push(p(circle(-0.12, 0.08, 0.05), 0.13, 0.028, "ink"));
  out.push(p(circle(0.16, 0.08, 0.05), 0.13, 0.028, "ink"));
  out.push(p(capsule(-0.14, -0.11, 0.02, -0.2, 0.035), 0.13, 0.028, "ink"));
  out.push(p(capsule(0.02, -0.2, 0.18, -0.11, 0.035), 0.13, 0.028, "ink"));
  // The gloss streak crosses the left eye, so it has to clear it — at the old 0.135/0.03 it
  // topped out 7 thou under the eye and the two caps fought.
  out.push(p(capsule(-0.17, 0.24, -0.21, 0.04, 0.045), 0.148, 0.032, "shine"));
  // An apple, because a smiling tooth needs something good to eat.
  out.push(p(circle(0.68, -0.5, 0.19), 0.02, 0.08, "red"));
  out.push(p(capsule(0.68, -0.33, 0.73, -0.22, 0.028), 0.09, 0.03, "bark"));
  out.push(p(star(-0.79, -0.16, 0.1), 0.03, 0.04, "peach"));
  out.push(p(star(0.87, 0.3, 0.082), 0.03, 0.04, "rose"));
  return out;
};

/* --- 2. Toothbrush, on a bathroom shelf ------------------------------ */

const brushScene = (): Poly[] => {
  const out: Poly[] = [];
  out.push(p(roundRect(0, -1.2, 2.9, 1.02, 0.26), 0, 0.06, "stone"));
  // Tiled wall: one long joint and two short ones, offset like brick courses.
  out.push(p(capsule(-1.08, 0.36, 1.08, 0.36, 0.022), 0.006, 0.03, "stone"));
  out.push(p(capsule(-0.34, 1.06, -0.34, 0.36, 0.022), 0.006, 0.03, "stone"));
  out.push(p(capsule(0.62, 1.06, 0.62, 0.36, 0.022), 0.006, 0.03, "stone"));
  // The brush, laid across the picture so it crosses tile windows on the diagonal.
  out.push(p(capsule(-0.66, -0.66, 0.34, 0.62, 0.115), 0.03, 0.085, "coral"));
  out.push(p(capsule(-0.55, -0.53, -0.25, -0.15, 0.072), 0.115, 0.03, "redSoft"));
  out.push(p(roundRect(0.451, 0.762, 0.3, 0.25, 0.1, 0.907), 0.035, 0.095, "ivory"));
  for (const t of [-0.09, -0.03, 0.03, 0.09]) {
    out.push(
      p(
        roundRect(0.329 + 0.615 * t, 0.857 + 0.788 * t, 0.055, 0.15, 0.026, 0.907),
        0.065,
        0.082,
        "enamel"
      )
    );
  }
  // Toothpaste.
  out.push(p(roundRect(-0.66, 0.42, 0.3, 0.62, 0.13, -0.16), 0.02, 0.075, "ivory"));
  out.push(p(roundRect(-0.72, 0.79, 0.2, 0.17, 0.075, -0.16), 0.042, 0.09, "red"));
  out.push(p(capsule(-0.66, 0.29, -0.66, 0.5, 0.06), 0.1, 0.03, "rose"));
  // Rinsing cup, standing on the shelf.
  out.push(p(roundRect(0.74, -0.44, 0.42, 0.48, 0.15), 0.02, 0.07, "roseSoft"));
  out.push(p(capsule(0.55, -0.21, 0.93, -0.21, 0.046), 0.09, 0.035, "rose"));
  out.push(p(circle(-0.88, -0.14, 0.075), 0.02, 0.045, "enamel"));
  out.push(p(circle(0.9, 0.44, 0.06), 0.02, 0.045, "enamel"));
  return out;
};

/* --- 3. Dino Brushing ------------------------------------------------ */

const dinoScene = (): Poly[] => {
  const out: Poly[] = [];
  out.push(p(roundRect(0, -1.18, 2.9, 0.96, 0.28), 0, 0.055, "stone"));
  out.push(p(capsule(0.42, -0.34, 0.94, -0.02, 0.1), 0.02, 0.07, "mauve"));
  out.push(p(capsule(-0.16, -0.64, -0.16, -0.42, 0.1), 0.02, 0.08, "mauve"));
  out.push(p(capsule(0.24, -0.64, 0.24, -0.42, 0.1), 0.02, 0.08, "mauve"));
  out.push(p(ellipse(0.06, -0.34, 0.46, 0.34), 0.03, 0.1, "mauve"));
  out.push(p(ellipse(0.04, -0.44, 0.28, 0.18), 0.125, 0.03, "mauveSoft"));
  out.push(p(circle(-0.02, 0.56, 0.09), 0.04, 0.06, "mauveDeep"));
  out.push(p(circle(0.17, 0.42, 0.085), 0.04, 0.06, "mauveDeep"));
  out.push(p(circle(0.33, 0.22, 0.075), 0.04, 0.06, "mauveDeep"));
  out.push(p(circle(-0.18, 0.26, 0.36), 0.05, 0.11, "mauve"));
  out.push(p(ellipse(-0.44, 0.12, 0.2, 0.145, -0.2), 0.155, 0.035, "mauveSoft"));
  out.push(p(circle(-0.27, 0.36, 0.055), 0.16, 0.03, "ink"));
  out.push(p(circle(-0.5, 0.28, 0.05), 0.2, 0.026, "roseSoft"));
  // The same two-capsule V every other face in this file wears. A single horizontal capsule
  // is a grimace, and it was on three of the five pictures.
  out.push(p(capsule(-0.54, 0.06, -0.45, 0.005, 0.028), 0.2, 0.026, "ink"));
  out.push(p(capsule(-0.45, 0.005, -0.36, 0.06, 0.028), 0.2, 0.026, "ink"));
  out.push(p(capsule(0.16, 0.0, 0.34, 0.24, 0.075), 0.14, 0.05, "mauve"));
  out.push(p(capsule(0.36, 0.26, 0.3, 0.62, 0.055), 0.16, 0.05, "coral"));
  out.push(p(roundRect(0.29, 0.72, 0.17, 0.15, 0.065, 0.16), 0.165, 0.06, "ivory"));
  // Four thin bristles along the head's own axis: one enamel block on one ivory block reads
  // as two marshmallows on a stick, which is what round 2 shipped here.
  for (const t of [-0.051, -0.017, 0.017, 0.051]) {
    out.push(
      p(
        roundRect(0.2765 + t * 0.9872, 0.8039 + t * 0.1593, 0.032, 0.08, 0.014, 0.16),
        0.185,
        0.055,
        "enamel"
      )
    );
  }
  out.push(p(star(0.74, 0.62, 0.095), 0.02, 0.045, "peach"));
  return out;
};

/* --- 4. Friendly Dentist --------------------------------------------- */

const dentistScene = (): Poly[] => {
  const out: Poly[] = [];
  out.push(p(roundRect(0, -0.72, 1.12, 0.92, 0.3), 0.02, 0.09, "enamel"));
  out.push(p(capsule(-0.17, -0.32, 0.0, -0.56, 0.055), 0.105, 0.025, "roseSoft"));
  out.push(p(capsule(0.17, -0.32, 0.0, -0.56, 0.055), 0.105, 0.025, "roseSoft"));
  out.push(p(circle(0.0, 0.1, 0.4), 0.045, 0.1, "peachSoft"));
  out.push(p(ellipse(0.0, 0.35, 0.42, 0.24), 0.05, 0.11, "bark"));
  out.push(p(capsule(-0.38, 0.3, 0.38, 0.3, 0.05), 0.17, 0.045, "coral"));
  out.push(p(circle(0.0, 0.53, 0.13), 0.18, 0.06, "stone"));
  out.push(p(circle(0.0, 0.53, 0.075), 0.245, 0.03, "enamel"));
  out.push(p(circle(-0.15, 0.1, 0.05), 0.165, 0.03, "ink"));
  out.push(p(circle(0.15, 0.1, 0.05), 0.165, 0.03, "ink"));
  out.push(p(capsule(-0.13, -0.06, 0.0, -0.13, 0.033), 0.165, 0.03, "ink"));
  out.push(p(capsule(0.0, -0.13, 0.13, -0.06, 0.033), 0.165, 0.03, "ink"));
  // A little tooth friend, waiting to be counted — and smiling back, which it was not.
  out.push(p(toothOutline(0.7, -0.58, 0.38, 0.48), 0.035, 0.09, "enamel"));
  out.push(p(circle(0.62, -0.53, 0.032), 0.14, 0.026, "ink"));
  out.push(p(circle(0.78, -0.53, 0.032), 0.14, 0.026, "ink"));
  out.push(p(capsule(0.63, -0.64, 0.7, -0.69, 0.024), 0.14, 0.026, "ink"));
  out.push(p(capsule(0.7, -0.69, 0.77, -0.64, 0.024), 0.14, 0.026, "ink"));
  out.push(p(star(-0.78, 0.52, 0.1), 0.02, 0.045, "peach"));
  out.push(p(star(-0.7, -0.44, 0.082), 0.02, 0.045, "rose"));
  return out;
};

/* --- 5. Happy Family ------------------------------------------------- */

/**
 * One member of the family.
 *
 * Round 2 shipped three floating heads — body top −0.18 against head bottom −0.10, so every
 * figure's head hovered 8 hundredths of a board clear of its shoulders with no neck — each
 * wearing a dead-straight horizontal black bar for a mouth, and none of them had arms. This
 * is the picture the child spends the whole game assembling, so all of that is rebuilt here:
 * shoulders the head actually sits on, a neck capsule bridging the two, arms that give the
 * silhouette something to say when it is cut into sixteen pieces, cheeks, and the same
 * two-capsule V-smile `toothScene` and `dentistScene` have always used.
 *
 * A figure is positioned by its **face**, not by its feet: `cy` is the centre of the head and
 * everything else hangs off it, because the face is what has to land inside a tile window.
 *
 * `z` lifts a whole figure into its own layer — the child stands in front of both parents —
 * and every part's stand-off is chosen so that no two *touching* parts share a top face.
 * `reliefLayerFaults` in `reliefMesh.ts` console.errors on every dev boot if that ever stops
 * being true. Since round 3 the stand-offs are read as ordering only and `ladder()` derives
 * the real heights, so `z` matters exactly where a figure overlaps another one — which, at
 * the positions below, is nowhere: the child at `cx 0, scale 0.62` and the parents at
 * `cx ±0.56, scale 0.8` do not touch. It is kept because it states the intent, and because
 * the moment anyone moves a figure it starts mattering again.
 */
type FamilyFigure = {
  cx: number;
  /** Centre of the head, in board space — a figure is positioned by its face. */
  cy: number;
  scale: number;
  /** Board v the figure stands on. The body is stretched from the jaw down to it. */
  foot: number;
  body: MatKey;
  hair: MatKey;
  /** Whole-figure stand-off, so a figure in front is never coplanar with one behind. */
  z: number;
  /** Right arm raised to hold something, instead of hanging. */
  raise?: boolean;
};

const familyFigure = (out: Poly[], f: FamilyFigure): void => {
  const s = f.scale;
  const cx = f.cx;
  const hy = f.cy;
  const head = 0.27 * s;
  /** Shoulders overlap the jaw by 0.03·scale — the fix for the floating head. */
  const top = hy - head + 0.03 * s;
  const bodyH = top - f.foot;
  const shoulder = top - 0.1 * s;
  const push = (pts: number[], lift: number, depth: number, mat: MatKey): void => {
    out.push(p(pts, lift + f.z, depth, mat));
  };

  push(roundRect(cx, (top + f.foot) / 2, 0.58 * s, bodyH, 0.17 * s), 0.02, 0.08, f.body);
  // Arms, same stand-off and same clay as the body so they read as one silhouette.
  push(capsule(cx - 0.24 * s, shoulder, cx - 0.36 * s, shoulder - 0.42 * s, 0.075 * s), 0.02, 0.072, f.body);
  if (f.raise) {
    push(capsule(cx + 0.24 * s, shoulder, cx + 0.34 * s, shoulder + 0.34 * s, 0.075 * s), 0.02, 0.072, f.body);
    // A hand, so the raised arm ends in something and the brush above it is a separate
    // object rather than a continuation of the same limb.
    push(circle(cx + 0.34 * s, shoulder + 0.34 * s, 0.088 * s), 0.1, 0.078, "peachSoft");
  } else {
    push(capsule(cx + 0.24 * s, shoulder, cx + 0.36 * s, shoulder - 0.42 * s, 0.075 * s), 0.02, 0.072, f.body);
  }
  push(capsule(cx, hy - 0.3 * s, cx, hy - 0.18 * s, 0.072 * s), 0.032, 0.086, "peachSoft");
  push(circle(cx, hy, head), 0.045, 0.1, "peachSoft");
  push(ellipse(cx, hy + 0.16 * s, 0.285 * s, 0.145 * s), 0.052, 0.113, f.hair);
  push(circle(cx - 0.185 * s, hy - 0.095 * s, 0.048 * s), 0.132, 0.03, "roseSoft");
  push(circle(cx + 0.185 * s, hy - 0.095 * s, 0.048 * s), 0.132, 0.03, "roseSoft");
  push(circle(cx - 0.098 * s, hy - 0.02 * s, 0.036 * s), 0.15, 0.03, "ink");
  push(circle(cx + 0.098 * s, hy - 0.02 * s, 0.036 * s), 0.15, 0.03, "ink");
  push(capsule(cx - 0.075 * s, hy - 0.14 * s, cx, hy - 0.185 * s, 0.024 * s), 0.15, 0.03, "ink");
  push(capsule(cx, hy - 0.185 * s, cx + 0.075 * s, hy - 0.14 * s, 0.024 * s), 0.15, 0.03, "ink");
};

const familyScene = (): Poly[] => {
  const out: Poly[] = [];
  out.push(p(roundRect(0, -1.16, 2.9, 0.92, 0.28), 0, 0.05, "stone"));
  out.push(p(lobed(-0.78, 0.8, 0.16, 0.028, 10), 0.012, 0.055, "peach"));
  out.push(p(circle(0.62, 0.88, 0.12), 0.018, 0.052, "enamel"));
  out.push(p(circle(0.78, 0.93, 0.09), 0.018, 0.052, "enamel"));
  out.push(p(circle(0.9, 0.86, 0.1), 0.018, 0.052, "enamel"));
  out.push(p(star(-0.3, 0.86, 0.07), 0.026, 0.048, "peach"));
  out.push(p(star(0.04, 0.94, 0.055), 0.026, 0.048, "rose"));

  const FOOT = -0.74;
  familyFigure(out, { cx: -0.56, cy: 0.3, scale: 0.8, foot: FOOT, body: "coral", hair: "bark", z: 0 });
  familyFigure(out, { cx: 0.56, cy: 0.3, scale: 0.8, foot: FOOT, body: "mauve", hair: "mauveDeep", z: 0 });

  // A little tooth friend standing on the floor in front, so the bottom row of tiles has
  // something in it other than a strip of ground.
  out.push(p(toothOutline(-0.84, -0.84, 0.28, 0.3), 0.105, 0.09, "enamel"));
  out.push(p(circle(-0.9, -0.81, 0.028), 0.2, 0.026, "ink"));
  out.push(p(circle(-0.78, -0.81, 0.028), 0.2, 0.026, "ink"));
  out.push(p(capsule(-0.91, -0.885, -0.84, -0.93, 0.019), 0.2, 0.026, "ink"));
  out.push(p(capsule(-0.84, -0.93, -0.77, -0.885, 0.019), 0.2, 0.026, "ink"));

  // The child stands in front, so their whole layer sits proud of both parents, and it is
  // the child who holds the toothbrush: the picture is now unmistakably about brushing.
  familyFigure(out, {
    cx: 0,
    cy: 0.06,
    scale: 0.62,
    foot: FOOT,
    body: "peach",
    hair: "peachDeep",
    z: 0.04,
    raise: true,
  });
  // The brush leans out of the fist rather than continuing its line, so the silhouette
  // reads as "child holding a toothbrush" and not as one very long arm.
  //
  // It leans *less far* than it did, and the reason is measurable rather than aesthetic.
  // At its old top of u = 0.32 the handle's right edge reached u ≈ 0.348, and the mother's
  // hair — she stands at cx = 0.56 with an ellipse of rx = 0.228 — starts at u = 0.332. The
  // child's toothbrush passed *through* the side of her hair: at tile scale, a coral bar
  // growing out of a parent's head. It also cost the whole picture a layer of relief. Every
  // stacking chain in the scene is a chain of clay changes (see `ladder()`), and this one
  // accidental intersection made the deepest chain `ground → body → hand → handle → head →
  // bristles` seven changes long instead of six, which divides the height budget seven ways
  // and takes every element in the picture below the wall it needs to read as clay. Pulling
  // the top of the handle to u = 0.28 puts its right edge at 0.328 — clear of the hair by
  // 4 thousandths of a board, one twentieth of a 4x4 tile — and the head and bristles ride
  // the same 0.04 across so the brush is the same object, only more upright.
  out.push(p(capsule(0.225, 0.11, 0.28, 0.52, 0.048), 0.215, 0.048, "coral"));
  out.push(p(roundRect(0.312, 0.625, 0.2, 0.155, 0.065, -0.2231), 0.225, 0.052, "ivory"));
  // Four thin bristles laid along the head's own long axis, not three fat ones — at tile
  // size a wide head with three stubby prongs reads as a mitten.
  for (const t of [-0.063, -0.021, 0.021, 0.063]) {
    out.push(
      p(
        roundRect(0.334 + t * 0.9752, 0.7225 - t * 0.2214, 0.034, 0.105, 0.015, -0.2231),
        0.24,
        0.05,
        "enamel"
      )
    );
  }
  return out;
};

/* ------------------------------------------------------------------ */
/* The ladder — how thick each piece of clay actually is               */
/* ------------------------------------------------------------------ */

/**
 * The scenes above author *ordering*: which piece is in front of which. They do not author
 * thickness, and until round 3 they were read as if they did.
 *
 * Measured over all five scenes as shipped, with `TILE_DEPTH_SCALE = 0.66`: the **exposed
 * wall** of a piece — how much of its own side you can see above whatever it stands on —
 * had a median of 0.0198 world units and a minimum of 0.0053, and 123 of the 132 elements
 * were under 0.04.
 *
 * **Design framing**, which every screen-pixel number in this file is quoted at, derived
 * rather than guessed: the round-3 laptop capture gives `GameShell` a 780 x 732 play area
 * with a 138 px chrome band, so `cameraFor` solves `r = 13.6` at a 28° lens and the frame is
 * `2 · 13.6 · tan 14° = 6.78` world units over 732 px — **108 px per world unit**. A vertical
 * wall is foreshortened by `cos 42° = 0.743`, so it shows `0.743 · 108 = 80 px per world
 * unit` of side.
 *
 * At 80 px/unit the median relief element showed **1.6 px** of side and the worst showed
 * **0.4 px**. That is why the brand critic, at 2.5x zoom, described extruded clay as
 * "coplanar cutouts with hard aliased silhouettes, no thickness, no bevel, no self-shadow
 * and no cast shadow onto the tile" — the geometry is genuinely extruded and the numbers
 * were genuinely invisible.
 *
 * So thickness is derived here instead of authored, from three facts and nothing else:
 *
 *  1. **A piece needs a wall you can see.** `WORLD.minWall` is the floor; the derivation
 *     is on the constant itself, below.
 *  2. **The whole relief has a height budget.** A piece standing `h` above the tile face
 *     appears, at 42°, to overhang the tile in front of it by `h / tan 42° = 1.111 h`
 *     (`layout.ts`), and at 4x4 a tile is only 0.67 units across. `WORLD.topBudget` is what
 *     bounds that, and it is the one number the pictures are not allowed to spend past.
 *  3. **One clay is one piece of clay.** Two overlapping outlines carrying the *same*
 *     `MatKey` are the same blob — a figure's arms are its body, a cloud is three discs —
 *     and merging them into one layer is invisible by construction (same albedo, same
 *     normal, and `reliefMesh.ts`'s world-space UV projection gives coincident points
 *     identical grain). Only a change of clay needs a step, because only a change of clay
 *     shows one. This is what keeps the ladder short: counting every overlapping outline the
 *     deepest chain in the product is **9** layers, and counting only clay changes it is
 *     **5** (`family`: child's body → hand → brush handle → brush head → bristles; `dino`
 *     and `dentist` are also 5, `brush` 4, `tooth` 3).
 *
 * The result is a per-scene step: `wall = clamp(TOP_BUDGET / layers, MIN_WALL, MAX_WALL)`.
 * Shallow pictures get thick clay, deep ones get the budget divided evenly, and no picture
 * exceeds the budget. As resolved today: `tooth` 3 layers x 0.070, `brush` 4 x 0.060, and
 * `dino`/`dentist`/`family` 5 x 0.048 — so **every element in the product now shows at least
 * 0.048 world units of its own side, 3.9 screen px, against a previous median of 0.0198 and
 * a worst case of 0.0053.** `reliefLadder()` reports these and `reliefMesh.ts` asserts them
 * on every dev boot: a number in a comment here is checked, not claimed.
 */
const WORLD = {
  /**
   * Floor on every element's exposed wall.
   *
   * 0.04 units is 3.2 screen px of side at design framing, and — this is the half that
   * matters for a dark piece on a light one, where the wall is the same colour as the cap —
   * it throws a cast shadow. `KEY_LIGHT.position` is `(-4, 7, 5)`, so a wall of height `h`
   * displaces its shadow by `h · |(4/7, −5/7)| = 0.914 h`: 0.037 units here, which is 6.7
   * texels of the 1024-texel map over this game's 5.6-unit `SHADOW_AREA` and clears the
   * 0.006-unit `shadowNormalBias`. Below ~0.03 the shadow is inside the bias and the
   * element is a decal again.
   */
  minWall: 0.04,
  /** …and a ceiling, so a three-layer picture does not come out as a wedding cake. */
  maxWall: 0.07,
  /**
   * Total relief height above the tile face.
   *
   * 0.24 units appears to overhang the tile in front by `0.24 × 1.111 = 0.267`, which is
   * 39.8 % of a 4x4 tile. Round 3 shipped a tallest piece of 0.191 (31.7 %) with the median
   * element invisible; this spends 8 points of overhang, on the tallest element of the
   * tallest picture only, to buy every element in the product a wall it can be seen by.
   */
  topBudget: 0.24,
  /** How far a piece sinks into the clay it stands on, so no piece floats on a hairline. */
  embed: 0.012,
} as const;

/** World units back to the author space the outlines above are written in. */
const authored = (world: number): number => world / TILE_DEPTH_SCALE;
const MIN_WALL = authored(WORLD.minWall);
const MAX_WALL = authored(WORLD.maxWall);
const TOP_BUDGET = authored(WORLD.topBudget);
const EMBED = authored(WORLD.embed);

/**
 * How deeply two outlines must interpenetrate, in board units, before they are treated as
 * stacked rather than as grazing.
 *
 * 0.008 board units is 0.012 world units — 1.2 mm at the product's scale, and about one
 * screen pixel of a 4x4 tile. Below that, two coplanar caps cannot show a seam wide enough
 * to see, so forcing a whole extra layer of relief for the pair would cost height for
 * nothing. Both the ladder and `reliefMesh.ts`'s coplanarity assertion read this same
 * constant through `overlapsInPlan`, so the thing that is asserted is the thing that was
 * built.
 */
const MIN_PENETRATION = 0.008;

const boxOf = (pts: number[]): [number, number, number, number] => {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let i = 0; i < pts.length; i += 2) {
    if (pts[i] < x0) x0 = pts[i];
    if (pts[i] > x1) x1 = pts[i];
    if (pts[i + 1] < y0) y0 = pts[i + 1];
    if (pts[i + 1] > y1) y1 = pts[i + 1];
  }
  return [x0, y0, x1, y1];
};

/** Separating-axis penetration depth for two outlines. 0 when they are disjoint. */
function penetration(a: number[], b: number[]): number {
  let best = Infinity;
  for (let pass = 0; pass < 2; pass++) {
    const P = pass === 0 ? a : b;
    const Q = pass === 0 ? b : a;
    const n = P.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ex = P[j * 2] - P[i * 2];
      const ey = P[j * 2 + 1] - P[i * 2 + 1];
      const len = Math.hypot(ex, ey);
      if (len < 1e-9) continue;
      const ax = ey / len;
      const ay = -ex / len;
      let p0 = Infinity;
      let p1 = -Infinity;
      let q0 = Infinity;
      let q1 = -Infinity;
      for (let k = 0; k < n; k++) {
        const d = P[k * 2] * ax + P[k * 2 + 1] * ay;
        if (d < p0) p0 = d;
        if (d > p1) p1 = d;
      }
      for (let k = 0; k < Q.length / 2; k++) {
        const d = Q[k * 2] * ax + Q[k * 2 + 1] * ay;
        if (d < q0) q0 = d;
        if (d > q1) q1 = d;
      }
      const span = Math.min(p1, q1) - Math.max(p0, q0);
      if (span <= 0) return 0;
      if (span < best) best = span;
    }
  }
  return best === Infinity ? 0 : best;
}

/**
 * Do two outlines really overlap in plan?
 *
 * Exact for these shapes: every generator above emits a convex outline, and SAT is exact on
 * convex pairs. The bounding boxes are only a reject filter, which is what keeps this a few
 * hundred microseconds over the ~1500 pairs in the largest scene instead of a few
 * milliseconds.
 */
export function overlapsInPlan(a: number[], b: number[]): boolean {
  const A = boxOf(a);
  const B = boxOf(b);
  if (Math.min(A[2], B[2]) - Math.max(A[0], B[0]) <= MIN_PENETRATION) return false;
  if (Math.min(A[3], B[3]) - Math.max(A[1], B[1]) <= MIN_PENETRATION) return false;
  return penetration(a, b) > MIN_PENETRATION;
}

export type LadderReport = {
  id: string;
  /** Distinct heights the picture resolves onto. */
  layers: number;
  /** Exposed wall of every element, in world units at `TILE_DEPTH_SCALE`. */
  wallWorld: number;
  /** Height of the tallest element above the tile face, in world units. */
  topWorld: number;
};

const reports: LadderReport[] = [];

/**
 * Re-seats a scene's outlines onto the ladder, preserving every front-to-back relationship
 * the artwork authored and replacing every thickness it did not.
 *
 * The layer of a piece is the longest chain of *clay changes* underneath it, which is a
 * longest path in a DAG whose edges run from lower authored top to higher; resolving the
 * scene in ascending authored-top order means every predecessor is final before it is read.
 * Ordering can therefore never invert: whenever two pieces overlap and carry different clay,
 * the one the artwork put on top is still on top, one full `wall` above.
 */
function ladder(id: string, polys: Poly[]): Poly[] {
  const n = polys.length;
  const top = polys.map((p) => p.lift + p.depth);
  const under: number[][] = polys.map(() => []);
  // Unordered pairs only — the overlap test is symmetric and it is the expensive half.
  // Over all five scenes this is 1898 tests and ~0.7 ms once, at module load, off-frame.
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (polys[i].mat === polys[j].mat) continue;
      const lower = top[j] < top[i] - 1e-9 ? j : top[i] < top[j] - 1e-9 ? i : -1;
      if (lower === -1) continue;
      if (!overlapsInPlan(polys[i].pts, polys[j].pts)) continue;
      under[lower === j ? i : j].push(lower);
    }
  }
  const order = polys.map((_, i) => i).sort((a, b) => top[a] - top[b]);
  const layer = new Array<number>(n).fill(0);
  for (const i of order) {
    for (const j of under[i]) if (layer[j] + 1 > layer[i]) layer[i] = layer[j] + 1;
  }
  let layers = 1;
  for (let i = 0; i < n; i++) if (layer[i] + 1 > layers) layers = layer[i] + 1;
  const wall = Math.min(MAX_WALL, Math.max(MIN_WALL, TOP_BUDGET / layers));
  reports.push({
    id,
    layers,
    wallWorld: wall * TILE_DEPTH_SCALE,
    topWorld: layers * wall * TILE_DEPTH_SCALE,
  });
  return polys.map((p, i) => {
    const t = (layer[i] + 1) * wall;
    // Layer 0 stands on the printed face itself, so it starts flush with it; everything
    // above sinks `EMBED` into the clay below rather than balancing on a shared plane.
    const base = layer[i] === 0 ? 0 : layer[i] * wall - EMBED;
    return { pts: p.pts, lift: base, depth: t - base, mat: p.mat };
  });
}

/** What the ladder resolved to, per scene. Read by the dev assertion in `reliefMesh.ts`. */
export const reliefLadder = (): readonly LadderReport[] => reports;

/** The invariants the ladder exists to hold, in world units at `TILE_DEPTH_SCALE`. */
export const LADDER_LIMITS = {
  minWall: WORLD.minWall,
  topBudget: WORLD.topBudget,
} as const;

export const SCENES: ReliefScene[] = [
  {
    id: "tooth",
    name: "Smiling Tooth",
    bg: [
      [-1, ACCENTS.rose.soft],
      [-0.1, ACCENTS.coral.soft],
      [1, ACCENTS.peach.soft],
    ],
    polys: ladder("tooth", toothScene()),
  },
  {
    id: "brush",
    name: "Toothbrush",
    bg: [
      [-1, NEUTRAL.well],
      [-0.3, NEUTRAL.surface],
      [1, ACCENTS.mauve.soft],
    ],
    polys: ladder("brush", brushScene()),
  },
  {
    id: "dino",
    name: "Dino Brushing",
    bg: [
      [-1, ACCENTS.peach.soft],
      [0, ACCENTS.coral.soft],
      [1, ACCENTS.mauve.soft],
    ],
    polys: ladder("dino", dinoScene()),
  },
  {
    id: "dentist",
    name: "Friendly Dentist",
    bg: [
      [-1, NEUTRAL.surface],
      [0.2, ACCENTS.red.soft],
      [1, ACCENTS.red.soft],
    ],
    polys: ladder("dentist", dentistScene()),
  },
  {
    id: "family",
    name: "Happy Family",
    bg: [
      [-1, ACCENTS.rose.soft],
      [0.1, ACCENTS.coral.soft],
      [1, ACCENTS.peach.soft],
    ],
    polys: ladder("family", familyScene()),
  },
];
