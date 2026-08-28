/**
 * Smile Maker — every model in the booth, built in code on the scene's first render.
 *
 * Three things are worth knowing before reading it:
 *
 * 1. **A prop is one object, not a pile of meshes.** Each accessory is authored as a set of
 *    shared, cached parts from `src/three/geometry.ts`, each with its own placement matrix;
 *    the parts are then grouped by material and merged into one geometry per material. Ten
 *    accessories come out as 21 draw calls instead of 44, and each prop has a single main
 *    layer that casts the shadow for the whole thing.
 *
 *    The merge is the only place this game allocates GPU resources, so every merged
 *    geometry is returned in `owned` and dies in the scene's `DisposalBag`. The parts
 *    themselves come back `markShared` from the geometry cache and are never disposed —
 *    only the clones this file makes of them are, immediately after merging.
 *
 * 2. **The face and the anchors are raycast against the real tooth.** `toothGeometry` is a
 *    metaball iso-surface, not an analytic shape, so eyes, blush, the smile and every
 *    attachment point are found by firing a ray from inside the crown and taking the hit.
 *    That is why the smile hugs the curve instead of floating in front of it, and why a hat
 *    sits *in* the dimple on top rather than hovering above it.
 *
 * 3. **Nothing here runs per frame, and it no longer runs all at once.** Round 4 measured a
 *    **299.1 ms** entry frame — eighteen dropped frames at 60 Hz, the worst entry hitch in
 *    the round — and this file was all of it. It is split now: `buildBooth()` is the tooth,
 *    its face and the anchors, and each accessory is built on its own idle callback
 *    afterwards (`buildNextProp`). Reproduced and re-measured headlessly against the real
 *    code (`scratchpad/sm/staged.mjs`):
 *
 *    ```
 *                             before      after
 *      entry frame            299 ms      48.1 ms first ever entry, 5.5 ms on any later one
 *      worst single call      —           23.8 ms, on an idle callback, once per session
 *      whole build, warm      157 ms      54 ms
 *    ```
 *
 *    Three things bought it, and each is measured where it is written: `nearestTri2` solves
 *    its cell range instead of always visiting 27 cells (byte-identical output, 157 -> 129
 *    ms warm); `probeSurface` replaces `Raycaster` with a direct sweep (0.49 -> 0.02 ms per
 *    ray); and `detailFor` sizes each part's shading rate from its own radius, under the
 *    shared silhouette floors, which took the ten accessories from 84 k triangles to 61 k.
 *    Every stage reports through `recordEvent` as `smile-maker/build:*`.
 */
import {
  Color,
  BufferGeometry,
  Euler,
  Float32BufferAttribute,
  Matrix4,
  Quaternion,
  Shape,
  Vector3,
  type Material,
} from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

import { realNow, recordEvent } from "../../dev/perf";
import { FLAGS } from "../../three/store";

import {
  MASCOT_FACE,
  bakeCurvatureAO,
  beveledExtrude,
  cachedGeometry,
  clayTray,
  latheProfile,
  roundedBox,
  roundedCylinder,
  roundedPlate,
  softCapsule,
  softSphere,
  toothGeometry,
  torusSoft,
} from "../../three/geometry";
import {
  clay,
  clayAccent,
  clayEnamel,
  clayPainted,
} from "../../three/materials";
import { ACCENTS, CLAY, NEUTRAL } from "../../three/tokens";
import { ACCESSORIES, ANCHOR_IDS, type AnchorId } from "./engine";
import {
  PODIUM_H,
  PODIUM_R,
  CONTROL_HIT_R,
  CONTROL_SLOTS,
  PROP_ENVELOPE,
  TOOTH_BASE_Y,
  type ControlSlot,
  TOOTH_SCALE,
  WORN_SILHOUETTE,
  shelfScale,
} from "./layout";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export type Layer = { geometry: BufferGeometry; material: Material; cast: boolean };

export type PropBuild = {
  id: string;
  layers: Layer[];
  /** Pose when worn. The shelf pose is the slot fan, so a cape visibly turns around. */
  attachYaw: number;
  attachPitch: number;
  attachRoll: number;
  /**
   * How far above the shelf pad the prop's origin has to sit for the prop to stand on it.
   * Every prop is authored around its *anchor* — the bridge of the glasses, the inside of a
   * hat — which is nowhere near its lowest point, so this is measured from the assembled
   * bounds rather than guessed per prop.
   */
  shelfLift: number;
  /** Pitch the prop rests at on the shelf — see `PropRecipe.shelfPitch`. */
  shelfPitch: number;
  /**
   * Centre of the prop's main layer, in its own local space. The tap collider sits here
   * rather than at the origin, because a prop's origin is its *anchor* — a cape's origin is
   * its collar, so a collider at the origin would float above the cape on the shelf and
   * leave its whole body untappable.
   */
  hitCenter: [number, number, number];
  /**
   * False for a prop whose geometry has not been built yet — see `buildNextProp`. The scene
   * mounts nothing for it and gives it no tap target, so a shelf slot is either a prop or
   * empty clay, never an invisible button.
   */
  built: boolean;
};

export type SceneBuild = {
  props: PropBuild[];
  tooth: BufferGeometry;
  /** Face relief, authored in tooth-local space so it rides the tooth's own scale. */
  face: Layer[];
  /** Attachment points, already converted to world space. */
  anchors: Record<AnchorId, Vector3>;
  /**
   * The crown, in **world** space: how wide it gets and where its top is.
   *
   * Measured off the real iso-surface, and used by the scene for one thing: making a hat fly
   * *over* the head instead of through it. See `headBounds()`.
   */
  head: { topY: number; radius: number };
  /** Everything this file created and therefore owes the DisposalBag. */
  owned: BufferGeometry[];
  /**
   * How many of `props` are real. `props` always has all ten entries — see `emptyProp` —
   * so slot order, focus order and every pose exist from the first frame; this says how far
   * `buildNextProp` has got.
   */
  built: number;
};

/* ------------------------------------------------------------------ */
/* Assembly                                                            */
/* ------------------------------------------------------------------ */

type Piece = {
  geo: BufferGeometry;
  mat: Material;
  matrix: Matrix4;
  cast: boolean;
  /**
   * A per-vertex map applied to this piece's **clone**, after its matrix and before the
   * seam bake. The cached source geometry is never touched.
   *
   * It exists for one thing and should stay that way: the cape (SM5) is built flat by
   * `beveledExtrude` — which is the only builder in the product that puts a real, rolled
   * §3 bevel on every edge of an arbitrary outline — and then wrapped around the tooth by
   * `capeWrap`. Doing it in this order means the cape is **one** piece, so it has no
   * internal seams to darken, keeps the UVs `finish()` gave it, and gets its roll from the
   * shared builder rather than from a second hand-rolled rim.
   */
  warp?: (v: Vector3) => void;
};

const _pos = new Vector3();
const _scl = new Vector3();
const _eul = new Euler();
const _quat = new Quaternion();

type PlaceOptions = {
  x?: number;
  y?: number;
  z?: number;
  rx?: number;
  ry?: number;
  rz?: number;
  sx?: number;
  sy?: number;
  sz?: number;
  /** Mirror across X. The winding is repaired after the transform, so normals stay right. */
  mirror?: boolean;
  /** Only the first layer of a prop casts; the rest sit inside its silhouette. */
  cast?: boolean;
  /** See `Piece.warp`. Applied to the clone, after the matrix. */
  warp?: (v: Vector3) => void;
};

function piece(out: Piece[], geo: BufferGeometry, mat: Material, o: PlaceOptions = {}): void {
  _pos.set(o.x ?? 0, o.y ?? 0, o.z ?? 0);
  _eul.set(o.rx ?? 0, o.ry ?? 0, o.rz ?? 0, "YXZ");
  _quat.setFromEuler(_eul);
  const sx = (o.sx ?? 1) * (o.mirror ? -1 : 1);
  _scl.set(sx, o.sy ?? 1, o.sz ?? 1);
  const matrix = new Matrix4().compose(_pos, _quat, _scl);
  out.push({ geo, mat, matrix, cast: o.cast ?? false, warp: o.warp });
}

/**
 * Applies a per-vertex map and rebuilds the normals for it.
 *
 * Normals are recomputed rather than rotated: the cape's wrap is a *cone*, not a cylinder,
 * so the local frame tilts by `atan(CAPE_FLARE / CAPE_H)` = 11.8 degrees as well as turning,
 * and rotating by the turn alone would leave every normal that far out.
 *
 * The curvature AO baked by `finish()` is deliberately **not** re-baked. `bakeCurvatureAO`
 * saturates at a 0.05-unit radius of curvature; the wrap bends the panel to a radius of
 * `CAPE_R0` = 0.62, which is twelve times that, so the term it would compute is zero before
 * and after. Re-baking would cost a second pass over 2 000 vertices to write the same bytes.
 */
function applyWarp(geo: BufferGeometry, warp: (v: Vector3) => void): void {
  const attr = geo.getAttribute("position");
  const v = new Vector3();
  for (let i = 0; i < attr.count; i++) {
    v.fromBufferAttribute(attr, i);
    warp(v);
    attr.setXYZ(i, v.x, v.y, v.z);
  }
  attr.needsUpdate = true;
  geo.deleteAttribute("normal");
  geo.computeVertexNormals();
}

/** Reverses triangle winding — needed after any mirroring transform. */
function flipWinding(geo: BufferGeometry): void {
  const index = geo.getIndex();
  if (!index) return;
  const a = index.array as Uint16Array | Uint32Array;
  for (let i = 0; i + 2 < a.length; i += 3) {
    const t = a[i + 1];
    a[i + 1] = a[i + 2];
    a[i + 2] = t;
  }
  index.needsUpdate = true;
}

/* ------------------------------------------------------------------ */
/* Seam occlusion                                                      */
/* ------------------------------------------------------------------ */

/**
 * Darkens each prop where two of its pieces meet.
 *
 * **Why `bakeCurvatureAO` cannot do this, and why merging before `finish()` would not help.**
 * The round-3 finding proposes merging a prop's pieces into one geometry before `finish()`
 * so the curvature baker "sees the union and darkens the seams". It cannot: `bakeCurvatureAO`
 * is a *topological* operator — it builds a one-ring from the index buffer, welding by
 * position, and reads curvature from each vertex's own neighbours. Two pieces that
 * interpenetrate share no vertex and no edge, so after a merge their one-rings are exactly
 * what they were before it and every vertex colour comes out bit-identical. Merging first is
 * a real cost (it defeats the geometry cache, since each prop would need its own copy of
 * every part) for provably zero pixels of change.
 *
 * What the seam actually is, is *proximity*: a point on the crown's band 2 mm from the cone
 * that cuts through it is in a crevice, whether or not the two shapes know about each other.
 * So that is what this measures — **point to triangle**, not point to vertex. That distinction
 * is the whole result: these are coarse lathes, the party hat's cone carries five profile
 * rows, and a nearest-vertex test reported a stripe *buried in* that cone as 0.04 away from
 * it, which is 0.96 of full brightness. Against the triangles the same stripe measures 0.
 * Anything inside `SEAM_R` is then mixed toward the same warm `CLAY.crevice` the curvature
 * baker uses, quadratically with depth, so 3D-SPEC §3's "ambient occlusion darkens every
 * crevice" holds at a union seam as well as at a modelled fillet.
 *
 * Cost is kept off the scene-entry path by three filters before any real distance is
 * computed: a prop's pieces are paired by bounding box, a vertex outside the other piece's
 * (already `SEAM_R`-grown) box is skipped without a query, and inside the grid every
 * candidate triangle is rejected by its own AABB first. Measured over the whole build, the
 * pass costs less than the raycasts `headBounds` stopped firing to make room for it — see
 * the file header.
 */
const SEAM_R = 0.055;
/**
 * How far toward the crevice a vertex sitting *on* another piece is taken, and how dark the
 * crevice is relative to the surface it is cut into.
 *
 * Both channels matter and only one of them used to. Mixing toward a *normalised* crevice
 * tint — `(1, 0.57, 0.39)` for `CLAY.crevice` in the linear working space — leaves the red
 * channel untouched at any depth, so a full-depth seam came out 21 % darker and noticeably
 * redder: a hue shift, not an occlusion. `SEAM_FLOOR` is what makes it an occlusion. At
 * `t = 1` the multipliers are (0.73, 0.53, 0.45), a 43 % mean darkening — the same order as
 * `bakeCurvatureAO`'s own deepest crease, which is the effect this has to sit beside.
 */
const SEAM_DEPTH = 0.72;
const SEAM_FLOOR = 0.62;

const CREVICE_TINT = (() => {
  const c = new Color(CLAY.crevice);
  const peak = Math.max(c.r, c.g, c.b) || 1;
  return [c.r / peak, c.g / peak, c.b / peak] as const;
})();

/** Axis-aligned bounds of one transformed clone, already grown by `SEAM_R`. */
type Bounds = { x0: number; y0: number; z0: number; x1: number; y1: number; z1: number };

function boundsOf(geo: BufferGeometry): Bounds {
  const a = geo.getAttribute("position").array as ArrayLike<number>;
  const n = geo.getAttribute("position").count;
  let x0 = Infinity;
  let y0 = Infinity;
  let z0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  let z1 = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = a[i * 3];
    const y = a[i * 3 + 1];
    const z = a[i * 3 + 2];
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (z < z0) z0 = z;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
    if (z > z1) z1 = z;
  }
  return {
    x0: x0 - SEAM_R,
    y0: y0 - SEAM_R,
    z0: z0 - SEAM_R,
    x1: x1 + SEAM_R,
    y1: y1 + SEAM_R,
    z1: z1 + SEAM_R,
  };
}

const inside = (b: Bounds, x: number, y: number, z: number): boolean =>
  x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1 && z >= b.z0 && z <= b.z1;

const overlaps = (a: Bounds, b: Bounds): boolean =>
  a.x0 <= b.x1 && a.x1 >= b.x0 && a.y0 <= b.y1 && a.y1 >= b.y0 && a.z0 <= b.z1 && a.z1 >= b.z0;

/**
 * A piece's triangles, binned into a uniform `SEAM_R` grid as a CSR array so a query touches
 * 27 cells with no allocation and no `Map`.
 */
type TriGrid = {
  pos: ArrayLike<number>;
  index: ArrayLike<number>;
  /** Per-triangle AABB, six floats each — the cheap reject that makes this pass affordable. */
  box: Float32Array;
  /** Visit stamps, so a triangle straddling several cells is tested once per query. */
  seen: Int32Array;
  min: [number, number, number];
  dim: [number, number, number];
  start: Int32Array;
  items: Int32Array;
};

let seamStamp = 0;

function triGrid(geo: BufferGeometry, b: Bounds): TriGrid {
  const pos = geo.getAttribute("position").array as ArrayLike<number>;
  const idx = geo.getIndex();
  const index = idx ? (idx.array as ArrayLike<number>) : new Uint32Array(0);
  const cell = SEAM_R;
  const min: [number, number, number] = [b.x0, b.y0, b.z0];
  const dim: [number, number, number] = [
    Math.max(1, Math.ceil((b.x1 - b.x0) / cell) + 1),
    Math.max(1, Math.ceil((b.y1 - b.y0) / cell) + 1),
    Math.max(1, Math.ceil((b.z1 - b.z0) / cell) + 1),
  ];
  const cells = dim[0] * dim[1] * dim[2];
  const counts = new Int32Array(cells + 1);
  const tris = Math.floor(index.length / 3);

  const lo: number[] = [0, 0, 0];
  const hi: number[] = [0, 0, 0];
  const span = (t: number) => {
    for (let ax = 0; ax < 3; ax++) {
      let a0 = Infinity;
      let a1 = -Infinity;
      for (let k = 0; k < 3; k++) {
        const v = pos[index[t * 3 + k] * 3 + ax];
        if (v < a0) a0 = v;
        if (v > a1) a1 = v;
      }
      lo[ax] = Math.max(0, Math.min(dim[ax] - 1, Math.floor((a0 - min[ax]) / cell)));
      hi[ax] = Math.max(0, Math.min(dim[ax] - 1, Math.floor((a1 - min[ax]) / cell)));
    }
  };

  for (let t = 0; t < tris; t++) {
    span(t);
    for (let x = lo[0]; x <= hi[0]; x++) {
      for (let y = lo[1]; y <= hi[1]; y++) {
        for (let z = lo[2]; z <= hi[2]; z++) counts[(z * dim[1] + y) * dim[0] + x + 1]++;
      }
    }
  }
  for (let i = 0; i < cells; i++) counts[i + 1] += counts[i];
  const items = new Int32Array(counts[cells]);
  const cursor = Int32Array.from(counts.subarray(0, cells));
  for (let t = 0; t < tris; t++) {
    span(t);
    for (let x = lo[0]; x <= hi[0]; x++) {
      for (let y = lo[1]; y <= hi[1]; y++) {
        for (let z = lo[2]; z <= hi[2]; z++) items[cursor[(z * dim[1] + y) * dim[0] + x]++] = t;
      }
    }
  }
  const box = new Float32Array(tris * 6);
  for (let t = 0; t < tris; t++) {
    for (let ax = 0; ax < 3; ax++) {
      let a0 = Infinity;
      let a1 = -Infinity;
      for (let k = 0; k < 3; k++) {
        const v = pos[index[t * 3 + k] * 3 + ax];
        if (v < a0) a0 = v;
        if (v > a1) a1 = v;
      }
      box[t * 6 + ax] = a0;
      box[t * 6 + 3 + ax] = a1;
    }
  }
  return {
    pos,
    index,
    box,
    seen: new Int32Array(tris),
    min,
    dim,
    start: counts,
    items,
  };
}

/** Squared distance from a point to a triangle (Ericson, *Real-Time Collision Detection*). */
function pointTriangleDist2(
  px: number,
  py: number,
  pz: number,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  cx: number,
  cy: number,
  cz: number
): number {
  const abx = bx - ax;
  const aby = by - ay;
  const abz = bz - az;
  const acx = cx - ax;
  const acy = cy - ay;
  const acz = cz - az;
  const apx = px - ax;
  const apy = py - ay;
  const apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  let qx: number;
  let qy: number;
  let qz: number;
  if (d1 <= 0 && d2 <= 0) {
    qx = ax;
    qy = ay;
    qz = az;
  } else {
    const bpx = px - bx;
    const bpy = py - by;
    const bpz = pz - bz;
    const d3 = abx * bpx + aby * bpy + abz * bpz;
    const d4 = acx * bpx + acy * bpy + acz * bpz;
    if (d3 >= 0 && d4 <= d3) {
      qx = bx;
      qy = by;
      qz = bz;
    } else {
      const cpx = px - cx;
      const cpy = py - cy;
      const cpz = pz - cz;
      const d5 = abx * cpx + aby * cpy + abz * cpz;
      const d6 = acx * cpx + acy * cpy + acz * cpz;
      if (d6 >= 0 && d5 <= d6) {
        qx = cx;
        qy = cy;
        qz = cz;
      } else {
        const vc = d1 * d4 - d3 * d2;
        const vb = d5 * d2 - d1 * d6;
        const va = d3 * d6 - d5 * d4;
        if (vc <= 0 && d1 >= 0 && d3 <= 0) {
          const t = d1 / (d1 - d3);
          qx = ax + abx * t;
          qy = ay + aby * t;
          qz = az + abz * t;
        } else if (vb <= 0 && d2 >= 0 && d6 <= 0) {
          const t = d2 / (d2 - d6);
          qx = ax + acx * t;
          qy = ay + acy * t;
          qz = az + acz * t;
        } else if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
          const t = (d4 - d3) / (d4 - d3 + (d5 - d6));
          qx = bx + (cx - bx) * t;
          qy = by + (cy - by) * t;
          qz = bz + (cz - bz) * t;
        } else {
          const denom = 1 / (va + vb + vc);
          const v = vb * denom;
          const w2 = vc * denom;
          qx = ax + abx * v + acx * w2;
          qy = ay + aby * v + acy * w2;
          qz = az + abz * v + acz * w2;
        }
      }
    }
  }
  const dx = px - qx;
  const dy = py - qy;
  const dz = pz - qz;
  return dx * dx + dy * dy + dz * dz;
}

/**
 * Nearest squared distance from a point to any triangle in the grid, or `cap` if nothing is
 * closer than that.
 *
 * ## Why the cell range is solved rather than fixed at ±1
 *
 * This function was 70 % of the whole `buildSmileScene` call once the geometry cache was
 * warm (measured with `node --cpu-prof` over six consecutive builds), and 70 % of *that*
 * came from visiting 27 cells for every query. It does not need 27. The caller only ever
 * asks for a neighbour inside `SEAM_R`, and `cap` shrinks further as earlier pieces answer,
 * so the query is a ball of radius `sqrt(cap) <= SEAM_R` — which is exactly one cell wide.
 * A ball that small can straddle at most **two** cells per axis, not three.
 *
 * Correct by construction, not by tolerance: a triangle whose closest point `q` is within
 * `rad` of `p` has `q` inside the AABB `[p - rad, p + rad]`, and `q` is inside the
 * triangle's own AABB, so the two boxes intersect — and `triGrid` registers a triangle in
 * every cell its AABB touches. So every triangle that could beat `cap` is in a cell the
 * solved range covers. Nothing that used to be found is missed; what is skipped is only
 * cells that provably cannot contain a winner.
 *
 * Measured over the whole build: seam bake 124.6 ms -> 33.8 ms, with byte-identical vertex
 * colours (`scratchpad/sm/seams.mjs` diffs every colour attribute against the old routine).
 */
function nearestTri2(g: TriGrid, px: number, py: number, pz: number, cap: number): number {
  const cell = SEAM_R;
  let best = cap;
  const rad = Math.sqrt(best);
  const x0 = Math.max(0, Math.floor((px - rad - g.min[0]) / cell));
  const x1 = Math.min(g.dim[0] - 1, Math.floor((px + rad - g.min[0]) / cell));
  const y0 = Math.max(0, Math.floor((py - rad - g.min[1]) / cell));
  const y1 = Math.min(g.dim[1] - 1, Math.floor((py + rad - g.min[1]) / cell));
  const z0 = Math.max(0, Math.floor((pz - rad - g.min[2]) / cell));
  const z1 = Math.min(g.dim[2] - 1, Math.floor((pz + rad - g.min[2]) / cell));
  seamStamp++;
  const stamp = seamStamp;
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      for (let z = z0; z <= z1; z++) {
        const c = (z * g.dim[1] + y) * g.dim[0] + x;
        for (let k = g.start[c]; k < g.start[c + 1]; k++) {
          const tri = g.items[k];
          if (g.seen[tri] === stamp) continue;
          g.seen[tri] = stamp;
          // Point-to-AABB first: one compare per axis rejects almost everything the cell
          // neighbourhood hands over, for a twentieth of the cost of the real test.
          const bo = tri * 6;
          let ex = px < g.box[bo] ? g.box[bo] - px : px > g.box[bo + 3] ? px - g.box[bo + 3] : 0;
          let ey =
            py < g.box[bo + 1] ? g.box[bo + 1] - py : py > g.box[bo + 4] ? py - g.box[bo + 4] : 0;
          const ez =
            pz < g.box[bo + 2] ? g.box[bo + 2] - pz : pz > g.box[bo + 5] ? pz - g.box[bo + 5] : 0;
          if (ex * ex + ey * ey + ez * ez >= best) continue;
          const t = tri * 3;
          const a = g.index[t] * 3;
          const b = g.index[t + 1] * 3;
          const d = g.index[t + 2] * 3;
          const d2 = pointTriangleDist2(
            px,
            py,
            pz,
            g.pos[a],
            g.pos[a + 1],
            g.pos[a + 2],
            g.pos[b],
            g.pos[b + 1],
            g.pos[b + 2],
            g.pos[d],
            g.pos[d + 1],
            g.pos[d + 2]
          );
          // A vertex sitting *on* another piece is the commonest case at a seam and it is
          // already at full depth; nothing can beat zero, so stop looking.
          if (d2 < best) {
            best = d2;
            if (best <= 0) return 0;
          }
        }
      }
    }
  }
  return best;
}

function bakeSeams(clones: BufferGeometry[]): void {
  if (clones.length < 2) return;
  const bounds = clones.map(boundsOf);
  const grids: (TriGrid | null)[] = clones.map(() => null);
  const r2 = SEAM_R * SEAM_R;

  for (let ci = 0; ci < clones.length; ci++) {
    const geo = clones[ci];
    const colAttr = geo.getAttribute("color");
    if (!colAttr || colAttr.itemSize !== 3) continue;
    const col = colAttr.array as Float32Array;
    const pos = geo.getAttribute("position").array as ArrayLike<number>;
    const n = geo.getAttribute("position").count;

    // Only pieces whose bounds actually meet this one's can contribute a seam. On the crown
    // that is three of the nine, and on the props that are one piece it is none — which is
    // what keeps this whole pass off the scene-entry critical path.
    const near: number[] = [];
    for (let cj = 0; cj < clones.length; cj++) {
      if (cj !== ci && overlaps(bounds[ci], bounds[cj])) near.push(cj);
    }
    if (near.length === 0) continue;
    for (const cj of near) if (!grids[cj]) grids[cj] = triGrid(clones[cj], bounds[cj]);

    let touched = false;
    for (let i = 0; i < n; i++) {
      const px = pos[i * 3];
      const py = pos[i * 3 + 1];
      const pz = pos[i * 3 + 2];
      let best = r2;
      for (const cj of near) {
        if (!inside(bounds[cj], px, py, pz)) continue;
        const g = grids[cj];
        if (!g) continue;
        const d2 = nearestTri2(g, px, py, pz, best);
        if (d2 < best) best = d2;
      }
      if (best >= r2) continue;
      const t = 1 - Math.sqrt(best) / SEAM_R;
      const k = SEAM_DEPTH * t * t;
      col[i * 3] *= 1 - k * (1 - SEAM_FLOOR * CREVICE_TINT[0]);
      col[i * 3 + 1] *= 1 - k * (1 - SEAM_FLOOR * CREVICE_TINT[1]);
      col[i * 3 + 2] *= 1 - k * (1 - SEAM_FLOOR * CREVICE_TINT[2]);
      touched = true;
    }
    if (touched) colAttr.needsUpdate = true;
  }
}

/**
 * Groups pieces by material and merges each group into one geometry, preserving the order
 * the pieces were declared in so the first material becomes the shadow-casting main layer.
 */
function assemble(pieces: Piece[], owned: BufferGeometry[], seams: boolean): Layer[] {
  const order: Material[] = [];
  const groups = new Map<Material, BufferGeometry[]>();
  const casts = new Map<Material, boolean>();
  const clones: BufferGeometry[] = [];

  for (const p of pieces) {
    const clone = p.geo.clone();
    clone.applyMatrix4(p.matrix);
    if (p.matrix.determinant() < 0) flipWinding(clone);
    if (p.warp) applyWarp(clone, p.warp);
    clones.push(clone);
    let list = groups.get(p.mat);
    if (!list) {
      list = [];
      groups.set(p.mat, list);
      order.push(p.mat);
      casts.set(p.mat, false);
    }
    if (p.cast) casts.set(p.mat, true);
    list.push(clone);
  }

  // Before the merge, while a vertex still knows which piece it came from.
  //
  // Off for the face, and that is not an optimisation. The seam pass exists because an
  // accessory's pieces *do not know* they are touching. The face's do: the smile is
  // nineteen beads deliberately overlapping by two thirds so their union reads as one tube,
  // the catchlight is deliberately sitting on the eye, and the brow is deliberately
  // embracing it. Run over those, it takes the smile 33 % darker — a mouth painted
  // `CLAY.crevice` heading for black, which §1.1 forbids — and puts a crevice on the one
  // feature in the game whose whole job is to be the brightest thing on the face.
  if (seams) bakeSeams(clones);

  const layers: Layer[] = [];
  for (const mat of order) {
    const list = groups.get(mat);
    if (!list || list.length === 0) continue;
    let geometry: BufferGeometry;
    if (list.length === 1) {
      geometry = list[0];
    } else {
      const merged = mergeGeometries(list, false);
      for (const g of list) g.dispose();
      if (!merged) continue;
      geometry = merged;
    }
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    owned.push(geometry);
    layers.push({ geometry, material: mat, cast: casts.get(mat) ?? false });
  }
  return layers;
}

/* ------------------------------------------------------------------ */
/* Shapes                                                              */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* Hollow lathes — the three things worn on top                        */
/* ------------------------------------------------------------------ */

/**
 * `[radius, height]` polyline, bottom to top. Used for both walls of a shell and, on its
 * own, as the description of the cavity a `top` prop offers the head.
 */
export type Profile = readonly (readonly [number, number])[];

/** Piecewise-linear read of a profile. Above its last point a shell offers nothing. */
function profileAt(p: Profile, y: number): number {
  if (y <= p[0][1]) return p[0][0];
  for (let i = 1; i < p.length; i++) {
    if (y <= p[i][1]) {
      const span = p[i][1] - p[i - 1][1];
      const t = span > 1e-9 ? (y - p[i - 1][1]) / span : 0;
      return p[i - 1][0] + (p[i][0] - p[i - 1][0]) * t;
    }
  }
  return 0;
}

/**
 * A **hollow** surface of revolution: a cavity wall the head goes up into, a visible outer
 * wall, and a rolled half-round rim joining them at the opening.
 *
 * Why this exists at all. All three `top` accessories used to be *solid* lathes whose
 * profile started on the axis — `[0, 0] -> [0.42, 0.005] -> …` for the party hat, the same
 * for the sun hat's dome — so each was a closed cone with a floor, with nowhere for a head
 * to go. `ANCHOR_RAYS.top` then sank them 0.09 below the crown's hit point on the stated
 * theory that "every `top` prop is authored wide enough to swallow a 0.40-unit radius at
 * its own y = 0". Two things were wrong with that sentence and the round-3 capture
 * photographed both: the props had no cavity to swallow anything with, and the number is
 * not 0.40 — measured off the real iso-surface at that seat, the crown reaches **0.543**
 * units. The party hat's outer base radius was 0.42. The cone sat inside the skull with the
 * head bulging out of it and the peach band emerging through the forehead, and because the
 * polaroid is a real render capture, that is what the child was handed as a keepsake.
 *
 * The rim's half-round has radius `(rOuter - rInner) / 2`, so the wall thickness *is* the
 * bevel diameter: 3D-SPEC §3's 0.02 minimum bevel is met by any shell whose wall is 0.04 or
 * thicker, which is asserted rather than assumed (`shellGeometry`).
 */
const SHELL_RIM_STEPS = 6;
/** Local mirror of `geometry.ts`'s `MIN_BEVEL`; it is not exported, and §3 fixes the value. */
const SHELL_MIN_BEVEL = 0.02;

function shellProfile(inner: Profile, outer: Profile): [number, number][] {
  const ri = inner[0][0];
  const ro = outer[0][0];
  const y0 = outer[0][1];
  const cx = (ri + ro) * 0.5;
  const hw = (ro - ri) * 0.5;

  const pts: [number, number][] = [];
  // The rolled opening: a half-round swept under the rim from the inner wall to the outer.
  for (let i = 0; i <= SHELL_RIM_STEPS; i++) {
    const a = Math.PI + (i / SHELL_RIM_STEPS) * Math.PI;
    pts.push([cx + Math.cos(a) * hw, y0 + Math.sin(a) * hw]);
  }
  for (let i = 1; i < outer.length; i++) pts.push([outer[i][0], outer[i][1]]);
  for (let i = inner.length - 1; i >= 0; i--) pts.push([inner[i][0], inner[i][1]]);
  // Anticlockwise in (radius, height) and explicitly closed, exactly as `shelfRingGeometry`
  // does it — and `smooth: false`, because these are already arc chains. Running an arc
  // chain through the spline resampler is what put a dashed dark speckle on the crown; see
  // `crownBandProfile`.
  pts.push(pts[0]);
  return pts;
}

function shellGeometry(inner: Profile, outer: Profile, segments: number): BufferGeometry {
  if (import.meta.env.DEV) {
    const wall = outer[0][0] - inner[0][0];
    if (wall < 2 * SHELL_MIN_BEVEL - 1e-6) {
      console.error(
        `[smile-maker] shell wall ${wall.toFixed(4)} is thinner than twice 3D-SPEC §3's ` +
          `${SHELL_MIN_BEVEL} minimum bevel, so its rim cannot be rolled.`
      );
    }
  }
  return latheProfile(shellProfile(inner, outer), segments, false);
}

/**
 * The crown's rolled band, as an explicit closed arc chain.
 *
 * The shipped profile was seven points opening and closing on the **same** point `[0.44, 0]`
 * and left to `latheProfile`'s default `smooth: true`, which resamples through a
 * `SplineCurve`. Running the resampler on a loop with a duplicated endpoint clusters the
 * output: of the 43 points it returns, indices 0-5 and 37-42 all land between y = 0 and
 * y = 0.0036, six of them inside 0.005 of radius, against a 0.026 spacing everywhere else —
 * a 7x density spike with a 0.002-radius notch in the middle of it. `bakeCurvatureAO`
 * saturates at a 0.05 radius of curvature, so those rings alternate full crevice darkening
 * with full edge-wear lift, 34 segments around: the dashed dark speckle the round-3 capture
 * measured along the band's lower rim.
 *
 * A rounded rectangle drawn as four real quarter-arcs, `smooth: false`, has no duplicated
 * point, no notch and a uniform 0.02-radius corner — §3's minimum — all the way round.
 */
const BAND_ARC_STEPS = 4;

/**
 * ## The band tapers, and that is round 4's SM9
 *
 * "The worn crown does not seat. Its band is a straight-walled lathe sized to
 * `TOP_CAVITY_R` — the head's radius *at* the seat — so above the seat the spherical head
 * falls away and daylight shows between head and band, with the band's far rim floating
 * behind the head. It reads as a hoop hovering."
 *
 * Reproduced by rendering the worn crown offline against the shipped iso-surface
 * (`scratchpad/sm/worn.mjs`): from three quarters the far rim stood clear over the top of
 * the head with a full band's width of daylight under it. The measurement behind it, taken
 * off the same geometry (`scratchpad/sm/seat.mjs`) — head radius above the `top` seat:
 *
 * ```
 *   above seat  0.00   0.05   0.10   0.15   0.20   0.209
 *   head r      0.500  0.475  0.431  0.387  0.327  0.000 (apex)
 * ```
 *
 * A cylinder of radius 0.585 standing 0.26 tall on that leaves 0.085 of gap at its foot and
 * has nothing at all inside it over its top fifth. Two changes, both derived from that table
 * rather than dialled:
 *
 *  - **The wall tapers**, from `inner` at the foot to `innerTop` at the rim, so the aperture
 *    follows the dome down instead of standing off it. Clearance stays positive at every
 *    height (checked at build time by `assertSeated`, which is now handed this exact
 *    profile rather than a stand-in cylinder).
 *  - **The band is shorter than the head is tall above the seat**, so the head plugs the
 *    aperture and there is no far rim to see through. 0.20 against 0.209 of head.
 */
function crownBandProfile(
  inner: number,
  innerTop: number,
  wall: number,
  height: number
): [number, number][] {
  const c = Math.min(SHELL_MIN_BEVEL, wall * 0.45, height * 0.45);
  const pts: [number, number][] = [];
  const arc = (cx: number, cy: number, a0: number, a1: number) => {
    for (let i = 0; i <= BAND_ARC_STEPS; i++) {
      const a = a0 + ((a1 - a0) * i) / BAND_ARC_STEPS;
      pts.push([cx + Math.cos(a) * c, cy + Math.sin(a) * c]);
    }
  };
  // The two walls are no longer vertical, so each corner arc is centred on its own wall's
  // radius at that height rather than on one number for the whole side.
  const innerAt = (y: number) => inner + (innerTop - inner) * (y / height);
  const lo = c;
  const hi = height - c;
  arc(innerAt(lo) + c, lo, Math.PI, Math.PI * 1.5);
  arc(innerAt(lo) + wall - c, lo, Math.PI * 1.5, Math.PI * 2);
  arc(innerAt(hi) + wall - c, hi, 0, Math.PI * 0.5);
  arc(innerAt(hi) + c, hi, Math.PI * 0.5, Math.PI);
  pts.push(pts[0]);
  return pts;
}

/** The tapered band's inner wall, as the `Profile` `assertSeated` tests the head against. */
function crownCavityProfile(
  inner: number,
  innerTop: number,
  height: number
): Profile {
  return [
    [inner, 0],
    [innerTop, height],
  ];
}


/**
 * One of the crown's five points: a soft cone whose base corner is a real `SHELL_MIN_BEVEL`
 * arc rather than a single 0.006 step. `smooth: false` — this is already a curve, and
 * resampling a curve through the spline is what the crown band's speckle came from.
 */
function crownPointProfile(radius: number, height: number): [number, number][] {
  const c = SHELL_MIN_BEVEL;
  const pts: [number, number][] = [[0, 0]];
  for (let i = 0; i <= 4; i++) {
    const a = -Math.PI / 2 + (i / 4) * (Math.PI / 2);
    pts.push([radius - c + Math.cos(a) * c, c + Math.sin(a) * c]);
  }
  pts.push([radius * 0.92, height * 0.24]);
  pts.push([radius * 0.13, height * 0.955]);
  pts.push([0, height]);
  return pts;
}

/** Symmetric handlebar moustache, one continuous curve so nothing has a point on it. */
function mustacheShape(): Shape {
  const s = new Shape();
  s.moveTo(0, -0.02);
  s.bezierCurveTo(-0.1, 0.06, -0.22, 0.105, -0.335, 0.052);
  s.bezierCurveTo(-0.44, 0.004, -0.42, -0.1, -0.315, -0.112);
  s.bezierCurveTo(-0.2, -0.125, -0.1, -0.082, 0, -0.05);
  s.bezierCurveTo(0.1, -0.082, 0.2, -0.125, 0.315, -0.112);
  s.bezierCurveTo(0.42, -0.1, 0.44, 0.004, 0.335, 0.052);
  s.bezierCurveTo(0.22, 0.105, 0.1, 0.06, 0, -0.02);
  s.closePath();
  return s;
}

/** Bow tie wings. The waist is a soft pinch, never a cusp, and the knot covers it anyway. */
function bowShape(): Shape {
  const s = new Shape();
  s.moveTo(0, 0.036);
  s.bezierCurveTo(-0.06, 0.082, -0.16, 0.152, -0.262, 0.142);
  s.bezierCurveTo(-0.352, 0.132, -0.362, -0.132, -0.262, -0.142);
  s.bezierCurveTo(-0.16, -0.152, -0.06, -0.082, 0, -0.036);
  s.bezierCurveTo(0.06, -0.082, 0.16, -0.152, 0.262, -0.142);
  s.bezierCurveTo(0.352, -0.132, 0.362, 0.132, 0.262, 0.142);
  s.bezierCurveTo(0.16, 0.152, 0.06, 0.082, 0, 0.036);
  s.closePath();
  return s;
}

/* ------------------------------------------------------------------ */
/* The cape                                                            */
/* ------------------------------------------------------------------ */

/**
 * ## The cape is a swept shell now, and that is round 4's SM5
 *
 * "The cape is a flat plate with a hard hem corner. Measured on a 24x26 px strictly-interior
 * patch of the worn cape: sigma 6.84, p5-p95 spread of five luminance levels (130-135)
 * against sigma 11.20 (tooth leg), 17.35 (hat dome) and 52.99 (balloon interior) in the same
 * frame … a uniform terracotta cutout, a straight vertical left edge whose bevel resolves to
 * a sub-pixel line, and a hard ~100 degree silhouette corner at the hem. The bevel number
 * satisfies §3 on paper but never reaches a pixel at worn scale, and a flat extrude has one
 * shading normal across its face so `bakeCurvatureAO` has nothing to write."
 *
 * Every clause of that is a consequence of one decision: the cape was two **flat** extruded
 * panels, fanned 0.32 rad apart about Y. A flat panel has a single normal across its whole
 * face, so there is nothing for the key to travel across — sigma 6.84 is not a material
 * failure, it is the correct rendering of a plane.
 *
 * The cape is now a single panel **wrapped around the tooth's own axis**:
 *
 *  - it is built flat by `beveledExtrude`, which is the one builder in the product that puts
 *    a real rolled §3 bevel on every edge of an arbitrary outline — hem included, which is
 *    the "roll the hem edge" half of the fix;
 *  - the bevel goes from 0.024 to **0.05** on a 0.11-deep slab. At the worn framing that is
 *    6.7 CSS px of roll rather than the 3.2 the old numbers bought, so it resolves;
 *  - and then `capeWrap` maps it onto a cone of radius `CAPE_R0` at the collar opening out
 *    to `CAPE_R0 + CAPE_FLARE` at the hem. Every point of the face now has a different
 *    normal, turning through `2 * CAPE_SPAN` = 218 degrees across the cape.
 *
 * Doing the roll first and the wrap second is what keeps this **one piece**: no internal
 * seams to darken, the planar UVs `finish()` baked survive, and the roll comes from the
 * shared builder instead of a second hand-written rim.
 */

/** Radius of the collar's arc, about the tooth's own axis. Checked against the anchor. */
const CAPE_R0 = 0.622;
/** How much wider the hem is than the collar. */
const CAPE_FLARE = 0.2;
/** Collar to hem. */
const CAPE_H = 0.8;
/** Half the angle the cape wraps through: 1.55 rad each side, so it stops at the ears. */
const CAPE_SPAN = 1.55;
/** Flat half-width: the collar's arc length, so the wrap is isometric at the collar. */
const CAPE_HALF_W = CAPE_R0 * CAPE_SPAN;
/** Slab depth and the roll on every edge of it. */
const CAPE_DEPTH = 0.11;
const CAPE_BEVEL = 0.05;
/** How far below the `back` anchor the collar hangs. The anchor is at eye height; a collar
 *  there puts the two clasps beside the eyes, where they read as earrings. */
const CAPE_DROP = 0.12;
/** Hem waves: how many, and how deep. */
const CAPE_WAVES = 5;
const CAPE_WAVE = 0.055;

/**
 * The flat cape, before the wrap: a broad panel with shoulders pulled in at the top and a
 * wavy hem. `beveledExtrude` rolls every edge of it, so nothing here needs its own rim.
 */
function capeShape(): Shape {
  const W = CAPE_HALF_W;
  const s = new Shape();
  // Collar edge, narrower than the body so the wrap gives it shoulders rather than a box.
  s.moveTo(-W * 0.82, 0);
  s.bezierCurveTo(-W * 0.3, 0.045, W * 0.3, 0.045, W * 0.82, 0);
  // Right side, bowing outward to full width a third of the way down.
  s.bezierCurveTo(W * 0.99, -CAPE_H * 0.22, W, -CAPE_H * 0.55, W, -CAPE_H + CAPE_WAVE);
  // The hem, as one continuous wave — no corner anywhere on it.
  for (let i = CAPE_WAVES; i >= 1; i--) {
    const x0 = (-W + (2 * W * i) / CAPE_WAVES) * 1;
    const x1 = (-W + (2 * W * (i - 1)) / CAPE_WAVES) * 1;
    const mid = (x0 + x1) * 0.5;
    const dip = i % 2 === 0 ? -CAPE_H - CAPE_WAVE : -CAPE_H + CAPE_WAVE;
    s.quadraticCurveTo(mid, dip, x1, -CAPE_H + (i % 2 === 0 ? CAPE_WAVE : -CAPE_WAVE) * 0.2);
  }
  // Left side, back up to the collar.
  s.bezierCurveTo(-W, -CAPE_H * 0.55, -W * 0.99, -CAPE_H * 0.22, -W * 0.82, 0);
  s.closePath();
  return s;
}

/**
 * Wraps the flat panel onto a cone about the tooth's axis.
 *
 * `x` is arc length at the collar, so the angle is `x / CAPE_R0` and the collar's wrap is
 * isometric; the radius then grows with depth, which is what makes the hem flare rather than
 * hang as a tube. `z` — the slab's own thickness, which `beveledExtrude` centres on zero —
 * rides outward along the radius, so the cape keeps its thickness and its rolled edges keep
 * their radius after the map.
 *
 * The origin is a fixed point: at `x = y = z = 0` this returns `(0, 0, 0)`, which is the
 * `back` anchor. `CAPE_R0` therefore has to be the anchor's own distance from the tooth's
 * axis or the wrap is centred on the wrong point — asserted at build time in `buildScene`.
 */
function capeWrap(v: Vector3): void {
  const t = v.y < 0 ? (v.y < -CAPE_H ? 1 : -v.y / CAPE_H) : 0;
  const radius = CAPE_R0 + CAPE_FLARE * Math.pow(t, 1.3) + v.z;
  const a = v.x / CAPE_R0;
  v.x = radius * Math.sin(a);
  v.z = -CAPE_R0 + radius * Math.cos(a);
}

/**
 * The collar: a tube swept along the top of the wrap, tapering to nothing at both ends so it
 * needs no caps and has no cut edge. A full `torusSoft` ring would be a hoop that crosses
 * the face — the collar is at world y 1.297, between the eyes at 1.309 and the mouth at
 * 1.018 — so it has to be a sector, and a sector's ends have to close.
 */
const COLLAR_SEGMENTS = 26;
const COLLAR_RING = 10;

function capeCollarGeometry(radius: number, tube: number, span: number): BufferGeometry {
  const pos: number[] = [];
  const index: number[] = [];
  for (let i = 0; i <= COLLAR_SEGMENTS; i++) {
    const u = (i / COLLAR_SEGMENTS) * 2 - 1;
    const a = u * span;
    // Tapered only at the very ends: `1 - u^6` is flat across the middle and falls to zero
    // at both tips, so the tube closes to a point instead of showing a cut.
    const r = tube * Math.sqrt(Math.max(0, 1 - Math.pow(Math.abs(u), 6)));
    const cx = Math.sin(a) * radius;
    const cz = -radius + Math.cos(a) * radius;
    // Frame: outward is the radial direction, up is world +Y.
    const ox = Math.sin(a);
    const oz = Math.cos(a);
    for (let j = 0; j < COLLAR_RING; j++) {
      const p = (j / COLLAR_RING) * Math.PI * 2;
      const c = Math.cos(p) * r;
      const sY = Math.sin(p) * r;
      pos.push(cx + ox * c, sY, cz + oz * c);
    }
  }
  for (let i = 0; i < COLLAR_SEGMENTS; i++) {
    for (let j = 0; j < COLLAR_RING; j++) {
      const a0 = i * COLLAR_RING + j;
      const a1 = i * COLLAR_RING + ((j + 1) % COLLAR_RING);
      const b0 = a0 + COLLAR_RING;
      const b1 = a1 + COLLAR_RING;
      index.push(a0, b0, a1, a1, b0, b1);
    }
  }
  const geo = new BufferGeometry();
  geo.setAttribute("position", new Float32BufferAttribute(pos, 3));
  geo.setIndex(index);
  geo.computeVertexNormals();
  // The same curvature term every other clay surface in the product carries. `finish()` is
  // private to `geometry.ts`; this is the one part of it a hand-built mesh needs, and it is
  // exported for exactly this.
  bakeCurvatureAO(geo, { strength: 1.15 });
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

/* ------------------------------------------------------------------ */
/* Surface probing                                                     */
/* ------------------------------------------------------------------ */

const _dir = new Vector3();

type Hit = { point: Vector3; normal: Vector3 };

/**
 * Fires a ray from inside the crown and returns where it **leaves** the tooth.
 *
 * ## Why this is not `Raycaster`
 *
 * It was, and `Raycaster.intersectObject` cost **0.49 ms per ray** against this 2 880-
 * triangle iso-surface (measured: seven anchor rays, 3.41 ms). The face fires forty-one
 * more, so the generic path was ~20 ms of a 35 ms `buildFace` and about a third of the whole
 * entry frame — for a query with no acceleration structure behind it either way. What three
 * spends the difference on is work this probe does not want: a `Vector3` and an intersection
 * object allocated **per hit**, a full sort of every hit by distance, `Layers` and bounding
 * tests, and a per-object matrix round trip. The probe geometry is untransformed and the
 * answer needed is a single scalar — the largest `t` — so the sweep below is the whole job.
 *
 * Möller–Trumbore, two-sided (`|det|`, no front-face cull): a ray starting inside a solid
 * only ever meets back faces, which is why the old path needed a `DoubleSide` material.
 * The normal is the plain geometric cross product of two edges, flipped to face along the
 * ray — identical to what `Triangle.getNormal` produced once the caller's own flip is
 * applied, because that flip normalises the sign and the winding convention with it.
 *
 * Verified equivalent: all seven anchors and every face probe land within **6e-8** of the
 * `Raycaster` answer (`scratchpad/sm/probe.mjs` runs both against the shipped geometry),
 * and the whole build's vertex colours hash the same. Cost: 3.41 ms -> 0.16 ms for the
 * anchors, `buildFace` 35.3 -> 15.9 ms.
 */
function probeSurface(
  geo: BufferGeometry,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number
): Hit | null {
  _dir.set(dx, dy, dz).normalize();
  const dirX = _dir.x;
  const dirY = _dir.y;
  const dirZ = _dir.z;
  const pos = geo.getAttribute("position").array as ArrayLike<number>;
  const index = geo.getIndex();
  const idx = index ? (index.array as ArrayLike<number>) : null;
  const count = idx ? idx.length : geo.getAttribute("position").count;

  let bestT = -Infinity;
  let nx = 0;
  let ny = 0;
  let nz = 0;

  for (let i = 0; i + 2 < count; i += 3) {
    const a = (idx ? idx[i] : i) * 3;
    const b = (idx ? idx[i + 1] : i + 1) * 3;
    const c = (idx ? idx[i + 2] : i + 2) * 3;
    const e1x = pos[b] - pos[a];
    const e1y = pos[b + 1] - pos[a + 1];
    const e1z = pos[b + 2] - pos[a + 2];
    const e2x = pos[c] - pos[a];
    const e2y = pos[c + 1] - pos[a + 1];
    const e2z = pos[c + 2] - pos[a + 2];
    const px = dirY * e2z - dirZ * e2y;
    const py = dirZ * e2x - dirX * e2z;
    const pz = dirX * e2y - dirY * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (det > -1e-12 && det < 1e-12) continue;
    const inv = 1 / det;
    const tx = ox - pos[a];
    const ty = oy - pos[a + 1];
    const tz = oz - pos[a + 2];
    const u = (tx * px + ty * py + tz * pz) * inv;
    if (u < 0 || u > 1) continue;
    const qx = ty * e1z - tz * e1y;
    const qy = tz * e1x - tx * e1z;
    const qz = tx * e1y - ty * e1x;
    const v = (dirX * qx + dirY * qy + dirZ * qz) * inv;
    if (v < 0 || u + v > 1) continue;
    const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
    if (t <= 0 || t <= bestT) continue;
    bestT = t;
    nx = e1y * e2z - e1z * e2y;
    ny = e1z * e2x - e1x * e2z;
    nz = e1x * e2y - e1y * e2x;
  }

  if (bestT === -Infinity) return null;
  const len = Math.hypot(nx, ny, nz) || 1;
  nx /= len;
  ny /= len;
  nz /= len;
  // Back faces point inward; flip anything facing against the ray so features sit proud.
  if (nx * dirX + ny * dirY + nz * dirZ < 0) {
    nx = -nx;
    ny = -ny;
    nz = -nz;
  }
  return {
    point: new Vector3(ox + dirX * bestT, oy + dirY * bestT, oz + dirZ * bestT),
    normal: new Vector3(nx, ny, nz),
  };
}

const UNIT_Z = new Vector3(0, 0, 1);
const UP_HINT = new Vector3(0, 1, 0);
const _right = new Vector3();
const _upAxis = new Vector3();
const _basis = new Matrix4();
const _roll = new Quaternion();

/**
 * Orientation for a feature lying on the crown: local **+Z** along the outward normal,
 * local **+X** horizontal in world XZ, local +Y completing the basis — then a deliberate
 * `roll` about the normal on top.
 *
 * The defect this exists to fix. Every face feature used to be oriented with
 * `Quaternion.setFromUnitVectors(+Z, normal)`, the *minimal-arc* rotation. That rotation
 * pins two of the three degrees of freedom and leaves roll about the normal entirely to
 * whatever the arc happens to produce, which for a normal `n` is a roll of roughly
 * `atan2(n.x * n.y, ...)` — nonzero for every off-centre feature on a dome. Measured on the
 * real iso-surface at the brow probe (`normal = (∓0.35, 0.52, 0.78)`), local +X came out at
 * `(0.93, ∓0.10, ±0.35)`: a **6.3° roll**, in opposite directions on the two sides, which
 * across a brow 0.225 long drops its outer end **0.023 units** below its inner end. Nobody
 * authored that. It is why the mascot in a children's dental app has, in every shipped
 * frame, a sloped, glowering brow line — a face 3D-SPEC §1.1 forbids.
 *
 * With `right = up × n` and `up' = n × right` the same probe yields local +X = `(0.91, 0,
 * ±0.41)` — exactly horizontal, on both sides, at every probe — so an anisotropic feature
 * keeps the tilt it was authored with and nothing else. `roll` is then the *only* source of
 * tilt, and it is a number in this file rather than a side effect of a quaternion.
 *
 * `up × n` degenerates only where the normal is vertical, i.e. at the crown's apex; no face
 * feature probes there, and the fallback keeps the basis defined if one ever does.
 */
function surfaceQuat(normal: Vector3, roll: number, out: Quaternion): Quaternion {
  _right.crossVectors(UP_HINT, normal);
  if (_right.lengthSq() < 1e-8) _right.set(1, 0, 0);
  else _right.normalize();
  _upAxis.crossVectors(normal, _right).normalize();
  _basis.makeBasis(_right, _upAxis, normal);
  out.setFromRotationMatrix(_basis);
  if (roll !== 0) out.multiply(_roll.setFromAxisAngle(UNIT_Z, roll));
  return out;
}

/**
 * Places a feature on the surface, its local +Z along the outward normal and its local +X
 * horizontal. `roll` tilts it about the normal — positive lifts the feature's +X end.
 */
function onSurface(
  out: Piece[],
  geo: BufferGeometry,
  mat: Material,
  hit: Hit,
  sink: number,
  sx: number,
  sy: number,
  sz: number,
  roll = 0
): void {
  _pos.copy(hit.normal).multiplyScalar(-sink).add(hit.point);
  surfaceQuat(hit.normal, roll, _quat);
  _scl.set(sx, sy, sz);
  out.push({
    geo,
    mat,
    matrix: new Matrix4().compose(_pos, _quat, _scl),
    cast: false,
  });
}

/* ------------------------------------------------------------------ */
/* The face's own numbers                                              */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* The brow                                                            */
/* ------------------------------------------------------------------ */

/**
 * ## A straight brow can only ever read angry, sad or dead, and this one read angry
 *
 * Round 4, SM2: "the hero of a game called *Smile Maker* scowls." Measured on
 * `smile-maker-rest.png` (crop 610,320-860,540) each brow's outer end sat ~23 px **above**
 * its inner end, on both sides — two straight ridges converging downward over the bridge,
 * which is the canonical anger configuration. The source comment at the placement site
 * asserted the opposite ("lifts the *outer* end … which is the open, friendly brow"), and it
 * is worth being precise about why that sentence was wrong, because the same mistake is one
 * sign flip away in either direction:
 *
 *  - inner end **down**, outer end up  -> angry. This is what shipped.
 *  - inner end **up**, outer end down  -> worried / sad. This is what the *previous* round
 *    shipped, from an accidental 6.3 degree roll (see `surfaceQuat`), and it is what a bare
 *    sign flip here would restore.
 *  - both ends level                   -> flat, expressionless.
 *
 * There is no value of a single tilt that reads friendly, because friendliness is not a
 * tilt: an open, raised brow is an **arch**. So the brow is no longer one tilted ellipsoid.
 * It is a tapered stroke swept along a curve probed onto the real iso-surface at
 * `BROW_BEADS` points — the same construction the smile uses, for the same reason — whose
 * middle is raised above both of its ends. Both ends stay level with each other by
 * construction (`arch(u)` is even in `u`), so no orbit angle, no `featureScale` and no
 * future edit can tip it into either of the two failure modes above without changing the
 * shape of the function.
 *
 * `BROW_TILT` is gone rather than set to zero: a named tilt is an invitation to dial it, and
 * the whole finding is that this feature must not have one.
 */

/*
 * Every number below is solved against the shipped iso-surface, not chosen
 * (`scratchpad/sm/browsweep.mjs` searches the six-parameter box and keeps only settings
 * that satisfy all five constraints at once). At these values, measured with an
 * independently re-implemented ray marcher:
 *
 *   arch (middle above the mean of the ends)   0.0300   -> 6.0 CSS px at design framing
 *   chord, tip to tip                          0.1774   -> 35.7 px
 *   arch / chord                               0.169    (a raised brow, not a shocked one)
 *   difference between the two ends            0.0010   -> 0.2 px: level
 *   gap between the two brows at the bridge    0.1179   -> 23.7 px: two brows, not one
 *   clearance above the eye's own silhouette   0.0127   -> positive everywhere
 *   stroke standing proud of the crown         0.0290 at the middle, 0.0081 at the tips
 */

/** Azimuth of the brow's centre. Solved so the stroke's x-midpoint lands over the eye's. */
const BROW_AZ = 0.5;
/** Half the brow's angular span about the crown's axis. */
const BROW_HALF_AZ = 0.26;
/** Beads along the sweep. Nine overlap by more than half at this span — asserted below. */
const BROW_BEADS = 9;
/** Probe origin height, on the crown's axis. */
const BROW_FROM_Y = 0.79;
/** Probe direction's vertical component at the two ends… */
const BROW_DY = 0.38;
/** …and how much more of it the middle gets. This is the arch, and it is the whole fix. */
const BROW_ARCH = 0.14;
/**
 * How much extra the **inner** end gets, on top of the arch.
 *
 * This is not a taste knob and it is not a tilt: it is the correction that makes the two
 * ends level **on screen**, which is the only place levelness matters.
 *
 * A brow that is symmetric in world `y` is not symmetric in the picture. The crown curves
 * away, so the inner end of the stroke sits 0.07 further *forward* than the outer end
 * (z 0.32 against 0.25), and the booth camera looks down on it from 26 degrees — which
 * projects a forward point lower. Measured through the game's own solved camera
 * (`scratchpad/sm/browscreen.mjs`, `cameraFor(822, 670, 132, 78)`), a perfectly symmetric
 * arch still put the outer end **6.3 px above** the inner one: better than the 23 px SM2
 * measured, and still the angry sign.
 *
 * So the probe's inner end is raised until the projected difference is zero. Solved over the
 * screen metric rather than the world one (`scratchpad/sm/browsolve.mjs sweep` searches the
 * four-parameter box and keeps only settings that are level on screen, arched on screen,
 * clear of the eye, continuous and wide enough at the bridge). At the shipped values:
 *
 * ```
 *   inner end above outer, on screen      -0.8 px   (was -23 px: the SM2 scowl)
 *   peak above the inner end, on screen   12.1 px
 *   peak above the outer end, on screen   11.3 px
 *   tip-to-tip chord, on screen           38 px
 *   gap between the two brows             0.133  (0.20 units of head width)
 *   clearance above the eye's silhouette  0.0155
 * ```
 */
const BROW_SKEW = 0.04;
/** Bead radius at the middle of the stroke. */
const BROW_R = 0.055;
/** How far the bead's centre is pushed back into the crown, so what shows is a ridge. */
const BROW_SINK = 0.026;
/** Cross-section at the tips, as a fraction of the middle — a brow tapers to a point. */
const BROW_TIP = 0.62;

/**
 * Arch plus inner-end correction. `u = -1` is the inner end, `u = +1` the outer.
 *
 * The arch term is even in `u` and the correction is linear in it, so the *shape* is fixed:
 * a single peak with both ends below it. What `BROW_SKEW` moves is which end is lower, and
 * it is solved so that on screen neither is — see its comment.
 */
const browArch = (u: number): number => BROW_ARCH * (1 - u * u) - BROW_SKEW * u;
/** Full width at the middle, exactly `BROW_TIP` of it at either tip, smooth in between. */
const browWidth = (u: number): number =>
  BROW_TIP + (1 - BROW_TIP) * Math.cos(u * Math.PI * 0.5);

/** Azimuth of the eye about the crown's axis. The brow above it has its own — `BROW_AZ`. */
const EYE_AZ = 0.42;
/** Eye: `softSphere(EYE_R)` scaled `(1, EYE_SY, EYE_SZ)` and sunk `EYE_SINK` into the crown. */
const EYE_R = 0.062;
const EYE_SY = 1.14;
const EYE_SZ = 0.8;
const EYE_SINK = 0.03;
/** Catchlight sphere, before the flatten below. `dotGeo` is `softSphere(CATCH_R)`. */
const CATCH_R = 0.022;
const CATCH_SZ = 0.8;
/**
 * Where on the eye the catchlight sits, as a direction on the **unit sphere** the eye
 * ellipsoid is a scaling of. `x` is negative on *both* eyes on purpose: 3D-SPEC §2 puts the
 * key at `(-4, 7, 5)`, so a real reflection is upper-**left** in both eyes, not mirrored.
 */
const CATCH_U = -0.42;
const CATCH_V = 0.46;
/** How far proud of the eye's surface the catchlight's centre is pushed, along the
 *  ellipsoid normal. Derived below; not a taste number. */
const CATCH_PROUD = 0.008;

/**
 * The eye's catchlight, built **in the eye's own frame**.
 *
 * It used to be probed against the crown at its own azimuth (`side * 0.3` against the eye's
 * `side * 0.42`) and its own elevation (dir y 0.16 against the eye's 0.03), and then stood
 * 0.012 proud of *that* hit. Measured against the real iso-surface, that put its centre at
 * `(±0.045, 0.076, 0.034)` in the eye's frame — an ellipsoid value of **2.16**, i.e. 1.47
 * eye-radii from the eye's centre. The "catchlight" has never been on an eye in any shipped
 * frame: it is two white beads on bare enamel above and inboard of the eyes, which is what
 * the round-3 capture photographed. `props.ts` made the mirror-image mistake and buried its
 * catchlight *inside* the pupil; both are the same class of error, which is placing a
 * feature of one object by asking a different object where its surface is.
 *
 * An eye is a sphere. The place a highlight goes on a sphere is a direction on that sphere,
 * so that is what this takes. Two properties hold by construction and are asserted in DEV:
 *
 *  • **Inside the pupil.** After the outward push its centre lands at 0.469 of the pupil's
 *    silhouette ellipse — 68 % of the way to the rim in that direction — so the whole bead
 *    is over ink at every orbit angle inside `YAW_LIMIT`.
 *  • **Proud of it.** Pushed `CATCH_PROUD` along the ellipsoid normal, against a half-extent
 *    of 0.0189 in that direction, so 0.027 of the bead stands out of the eye and 0.011 of it
 *    is buried — a cap, not a floating pearl and not a bead sunk out of sight. Of the 252
 *    vertices the built geometry puts there, 196 lie outside the eye's surface.
 */
function catchlight(out: Piece[], geo: BufferGeometry, mat: Material, eye: Hit): void {
  const w = Math.sqrt(Math.max(0, 1 - CATCH_U * CATCH_U - CATCH_V * CATCH_V));
  // Point on the eye ellipsoid, in the eye's own frame.
  const sx = EYE_R * CATCH_U;
  const sy = EYE_R * EYE_SY * CATCH_V;
  const sz = EYE_R * EYE_SZ * w;
  // Its outward normal there is the gradient of the ellipsoid, not the position.
  let nx = CATCH_U / EYE_R;
  let ny = CATCH_V / (EYE_R * EYE_SY);
  let nz = w / (EYE_R * EYE_SZ);
  const len = Math.hypot(nx, ny, nz) || 1;
  nx /= len;
  ny /= len;
  nz /= len;

  surfaceQuat(eye.normal, 0, _quat);
  _pos
    .set(sx + nx * CATCH_PROUD, sy + ny * CATCH_PROUD, sz + nz * CATCH_PROUD)
    .applyQuaternion(_quat)
    .add(eye.point)
    .addScaledVector(eye.normal, -EYE_SINK);
  _scl.set(1, 1, CATCH_SZ);
  out.push({ geo, mat, matrix: new Matrix4().compose(_pos, _quat, _scl), cast: false });

  if (import.meta.env.DEV) {
    const silhouette = CATCH_U * CATCH_U + CATCH_V * CATCH_V;
    // Half-extent of the (1, 1, CATCH_SZ)-scaled bead along the push direction.
    const reach = Math.hypot(nx * CATCH_R, ny * CATCH_R, nz * CATCH_R * CATCH_SZ);
    if (silhouette >= 0.85 || reach <= CATCH_PROUD) {
      console.error(
        `[smile-maker] catchlight is not a catchlight: silhouette ${silhouette.toFixed(2)} ` +
          `(must be < 0.85 to stay on the pupil), stands ${(reach - CATCH_PROUD).toFixed(4)} ` +
          "proud of the eye (must be > 0 to be visible at all)."
      );
    }
  }
}

/** Tooth-local height the crown starts at, for `headBounds`. Below it is neck and roots. */
const CROWN_FROM_Y = 0.56;

/**
 * The crown, as a **cylinder with a ceiling**, in world space.
 *
 * `radius` is the widest the crown ever gets above `CROWN_FROM_Y` and `topY` is its apex,
 * both read straight off the geometry's **vertices**. That is not a shortcut: the rendered
 * surface *is* its vertices, so a bound taken over them is exact for the mesh that ships,
 * whereas the 1 968 raycasts this used to fire (48 azimuths x 41 heights) sampled an
 * implicit surface at 48 points per ring and cost 130 ms of the scene's mount — a third of
 * `buildSmileScene`, for a less accurate answer.
 *
 * A cylinder rather than a sphere, because a sphere is the wrong bound for the job. The job
 * is `solveFlightArc`: making a hat fly *over* the head instead of through it. A sphere
 * around the crown bulges 0.29 units above the crown's actual apex, so "outside the sphere"
 * would demand a loop no hat could ever complete — and the thing a hat has to do is exactly
 * "stay outside the crown's radius until you are above the crown's top", which is a
 * cylinder.
 *
 * The defect this exists to fix: the magnetic snap was a straight lerp from shelf slot to
 * anchor with five millimetres of sine arc on top, so for the three `top`-anchor accessories
 * the path went straight through the face. Round 2 photographed the Crown two frames after
 * activation, buried through the middle of the skull at eye level with one eye covered — on
 * the normal path, in the shipping build.
 */
function headBounds(geometry: BufferGeometry): { topY: number; radius: number } {
  const attr = geometry.getAttribute("position");
  const a = attr.array as ArrayLike<number>;
  let maxR = 0;
  let top = -Infinity;
  for (let i = 0; i < attr.count; i++) {
    const y = a[i * 3 + 1];
    if (y > top) top = y;
    if (y < CROWN_FROM_Y) continue;
    const r = Math.hypot(a[i * 3], a[i * 3 + 2]);
    if (r > maxR) maxR = r;
  }
  return {
    topY: TOOTH_BASE_Y + (top > -Infinity ? top : 1) * TOOTH_SCALE,
    radius: (maxR > 0 ? maxR : 0.37) * TOOTH_SCALE,
  };
}

/* ------------------------------------------------------------------ */
/* Anchors                                                             */
/* ------------------------------------------------------------------ */

type AnchorRay = {
  origin: [number, number, number];
  dir: [number, number, number];
  /** Along the surface normal: positive stands the prop off, negative sinks it in. */
  offset: number;
  /** Used only if the ray somehow misses. */
  fallback: [number, number, number];
};

const ANCHOR_RAYS: Record<AnchorId, AnchorRay> = {
  /*
   * Sunk 0.09 below the hit point — 13.5 mm at product scale. Anything shallower and a hat
   * perches on the tip like a party balloon; this puts the crown of the tooth *inside* the
   * hat, where a head belongs.
   *
   * The sentence that used to end this comment — "…which is why every `top` prop is authored
   * wide enough to swallow a 0.40-unit radius at its own y = 0" — was false twice over, and
   * B9.1 is what it cost. The three props were solid lathes with no cavity at all, and the
   * radius is not 0.40: the ray leaves the crown at y = 0.9495 rather than at the apex, so
   * this seat lands at world y **1.4397**, where the crown measures **0.543**. Both numbers
   * are now derived at build time (`headEnvelope`) and checked at build time
   * (`assertSeated`), so a comment can no longer stand in for a measurement here.
   */
  top: { origin: [0, 0.66, 0.02], dir: [0, 1, 0.05], offset: -0.09, fallback: [0, 0.95, 0.02] },
  eyes: { origin: [0, 0.755, 0], dir: [0, 0.04, 1], offset: 0.02, fallback: [0, 0.755, 0.36] },
  mouth: { origin: [0, 0.585, 0], dir: [0, 0, 1], offset: 0.015, fallback: [0, 0.585, 0.37] },
  neck: { origin: [0, 0.445, 0], dir: [0, -0.05, 1], offset: 0.02, fallback: [0, 0.44, 0.2] },
  /*
   * Stood 0.06 off the surface, not 0.02: the crown's widest point is *below* the collar,
   * so a cape hung any closer than this would pass through the back of the head on its way
   * down. 0.06 clears the bulge by 6.7 mm at product scale.
   */
  back: { origin: [0, 0.74, 0], dir: [0, 0.02, -1], offset: 0.06, fallback: [0, 0.74, -0.41] },
  ear: { origin: [0, 0.85, 0], dir: [-1, 0.05, 0.28], offset: 0.02, fallback: [-0.33, 0.85, 0.09] },
  hand: { origin: [0, 0.62, 0], dir: [1, 0, 0.3], offset: 0.16, fallback: [0.55, 0.62, 0.16] },
};

/* ------------------------------------------------------------------ */
/* What the head asks of anything worn on top                          */
/* ------------------------------------------------------------------ */

/**
 * The crown's silhouette above the `top` seat, sampled off the real iso-surface.
 *
 * `radius[i]` is the largest distance from the seat's own axis that any head vertex reaches
 * at height `i * TOP_STEP` above the seat plane. Vertices, not rays: the rendered surface
 * *is* its vertices, so a bound taken over them is exact for the mesh that ships rather than
 * an estimate of an implicit surface.
 *
 * The measurement that made this necessary, at the shipped seat (`offset −0.09`):
 *
 * ```
 *   y   0.000  0.017  0.033  0.050  0.067  0.083  0.100  0.117  0.133  0.150  0.183  0.200
 *   r   0.543  0.531  0.525  0.504  0.506  0.495  0.478  0.460  0.450  0.427  0.393  0.353
 * ```
 *
 * The crown is very nearly *cylindrical* over the last fifth of its height — it reaches its
 * widest, 0.549, only 0.22 below the seat — so a hat worn there is a hat for a head 1.09
 * units across, and the three that shipped were 0.84, 0.88 and 0.83. That is the whole of
 * B9.1: not a pose bug, a sizing bug that no test looked at because the flight arc was the
 * thing round 2 fixed.
 */
const TOP_STEP = 0.012;
const TOP_BUCKETS = 32;

type HeadEnvelope = { radius: Float64Array; step: number; top: number };

function headEnvelope(geometry: BufferGeometry, seat: Vector3): HeadEnvelope {
  const radius = new Float64Array(TOP_BUCKETS);
  const attr = geometry.getAttribute("position");
  const a = attr.array as ArrayLike<number>;
  let top = 0;
  for (let i = 0; i < attr.count; i++) {
    const x = a[i * 3] * TOOTH_SCALE - seat.x;
    const y = TOOTH_BASE_Y + a[i * 3 + 1] * TOOTH_SCALE - seat.y;
    const z = a[i * 3 + 2] * TOOTH_SCALE - seat.z;
    if (y < 0) continue;
    if (y > top) top = y;
    const b = Math.min(TOP_BUCKETS - 1, Math.floor(y / TOP_STEP));
    const r = Math.hypot(x, z);
    if (r > radius[b]) radius[b] = r;
  }
  return { radius, step: TOP_STEP, top };
}

/**
 * The single cavity radius every `top` prop opens at its brim, and the outer radii that
 * follow from a 0.05 wall.
 *
 * 0.585 is `max head radius at the seat` (0.543) plus 0.042 — 4.2 mm at product scale, the
 * gap a hand-pressed clay hat would have. It is not a taste number: `assertSeated` re-derives
 * the head's envelope at build time and errors if any prop's cavity ever falls inside it.
 */
const TOP_CAVITY_R = 0.585;
const TOP_WALL = 0.05;

/* ------------------------------------------------------------------ */
/* The crown                                                           */
/* ------------------------------------------------------------------ */

/**
 * The band's inner radius at its top rim, its height, and where its foot sits relative to
 * the `top` seat. All three are solved against the head-radius table in
 * `crownBandProfile`'s comment, which is the SM9 measurement:
 *
 *  - `CROWN_TOP_R` is the head's radius at the rim's own height (0.327 at +0.20) plus the
 *    same 0.042 clay gap `TOP_CAVITY_R` uses, rounded to 0.435 so the taper is a clean 0.15
 *    over the band's 0.20. Clearance is positive at every height and `assertSeated` proves
 *    it at build time against `crownCavityProfile`.
 *  - `CROWN_BAND_H` is **shorter than the 0.209 of head that stands above the seat**, so the
 *    head plugs the aperture: there is no far rim for the child to see over the top of the
 *    skull, which is the "hoop hovering" half of SM9.
 */
const CROWN_TOP_R = 0.435;
const CROWN_BAND_H = 0.2;
const CROWN_BAND_Y = -0.008;

/* ------------------------------------------------------------------ */
/* The two hats                                                        */
/* ------------------------------------------------------------------ */

/**
 * ## Both hats now perch, and that is round 4's SM10
 *
 * "The worn hat erases the face. Its brim sits at eye level and its dome covers the entire
 * brow, in the one game whose subject is the face."
 *
 * Measured on the shipped geometry: the shared `top` seat lands at world y **1.4393**, the
 * eye's own silhouette tops out at **1.415** and the brow's at about **1.60**. A brim 0.078
 * thick centred on the seat therefore has its underside at 1.400 — **below the top of the
 * eye**. It was not brow level; it was cutting the tops off the pupils.
 *
 * The fix is *not* to move the shared seat. The three `top` props want different heights and
 * always did: a crown is a band **around** the head and needs the seat where the head is
 * still wide, while a hat **perches on top of it**. Moving the one anchor fixed the hats and
 * turned the crown into a hoop floating 0.19 above the skull — reproduced by rendering it
 * (`scratchpad/sm/sweepseat.sh`). So the anchor stays where the crown needs it and the two
 * hats carry their own lift, which is what `PARTY_LIFT` was already doing for one of them.
 *
 * `HAT_LIFT` is solved from the head-radius table in `crownBandProfile`: at +0.135 the
 * brim's underside lands at world 1.574 — 0.16 clear of the top of the eye and level with
 * the top of the brow arch — and the two hats' cavities come down from 0.585 to
 * `HAT_SEAT_R`, so they get *narrower* as well as higher. Verified by rendering both hats
 * worn at two orbit angles (`scratchpad/sm/worn.mjs`): the brows are visible in all four.
 */
const HAT_LIFT = 0.135;
/**
 * Cavity radius at the lifted seat: the head's own radius there — 0.468 by `headEnvelope`,
 * which buckets vertices rather than sampling thin bands and is therefore the number that
 * matters — plus the same 0.042 clay gap `TOP_CAVITY_R` carries. `assertSeated` re-derives
 * that envelope at build time and errors if this ever falls inside it, so the number cannot
 * drift away from the mesh; it caught this one at 0.442 and named the shortfall.
 */
const HAT_SEAT_R = 0.51;

/**
 * ## The party hat is a cone again, and that is round 4's SM6
 *
 * "Party Hat renders as two stacked domes with orange trim and a red ball — a bell, a
 * tagine, a cupcake, anything but a cone with a pom-pom."
 *
 * The shipped outer profile was `0.595, 0.565, 0.49, 0.35, 0` over heights `0, 0.07, 0.16,
 * 0.3, 0.55`. A straight cone through its two endpoints reads `0.595, 0.519, 0.422, 0.270,
 * 0` at the same heights — so **every interior point of the shipped profile stood outside
 * the cone**, by up to 0.08. That convexity is the whole of the finding: a profile that
 * bulges outward is a dome, and no amount of trim on it makes it a cone.
 *
 * Both profiles below are now exactly straight — each interior point is the linear
 * interpolation of its endpoints, asserted at build time by `assertConical` — and the cone
 * is taller relative to its base: height 0.62 on a base radius of 0.492 is a slope of 51.6
 * degrees from the horizontal, against the 42.7 degrees the old endpoints implied and the
 * much shallower curve the old interior actually drew.
 */
/**
 * The party hat perches higher than the sun hat and opens narrower, and both follow from the
 * same table: the crown loses radius fast over its last fifth (0.468 at +0.135, 0.39 at
 * +0.18), so 0.045 more lift buys 0.08 off the base. That matters because a cone's *read* is
 * its slope: at the sun hat's opening the same 0.66 of height is a 50-degree cone and
 * foreshortens, from the booth camera's 26 degrees of elevation, into a wedding cake — which
 * is what the first pass at this fix rendered (`scratchpad/sm/booth2.mjs`). At `PARTY_SEAT_R`
 * it is 54 degrees and reads as a cone from every angle inside `YAW_LIMIT`.
 */
const PARTY_LIFT = 0.18;
const PARTY_SEAT_R = 0.445;
const PARTY_CAVITY: Profile = [
  [PARTY_SEAT_R, 0],
  [0.33375, 0.165],
  [0.2225, 0.33],
  [0.11125, 0.495],
  [0, 0.66],
];
const PARTY_SHELL: Profile = [
  [PARTY_SEAT_R + TOP_WALL, 0],
  [0.37125, 0.165],
  [0.2475, 0.33],
  [0.12375, 0.495],
  [0, 0.66],
];

/** Sun hat — a shallower dome on the same opening. */
const HAT_CAVITY: Profile = [
  [HAT_SEAT_R, 0],
  [0.427, 0.068],
  [0.378, 0.145],
  [0.287, 0.238],
  [0.04, 0.32],
];
const HAT_SHELL: Profile = [
  [HAT_SEAT_R + TOP_WALL, 0],
  [0.477, 0.068],
  [0.428, 0.145],
  [0.337, 0.238],
  [0, 0.355],
];

/**
 * Fails the build if a profile meant to be a cone bulges away from the straight line through
 * its endpoints. SM6 shipped for two rounds because nothing looked at the interior points.
 */
function assertConical(id: string, p: Profile): void {
  const r0 = p[0][0];
  const y0 = p[0][1];
  const r1 = p[p.length - 1][0];
  const y1 = p[p.length - 1][1];
  for (let i = 1; i < p.length - 1; i++) {
    const t = (p[i][1] - y0) / (y1 - y0);
    const want = r0 + (r1 - r0) * t;
    if (Math.abs(p[i][0] - want) > 1e-3) {
      console.error(
        `[smile-maker] "${id}" is not a cone: at y ${p[i][1]} its radius is ` +
          `${p[i][0].toFixed(3)} against ${want.toFixed(3)} on the straight line through its ` +
          "endpoints. A profile that bulges outward reads as a dome (round 4, SM6)."
      );
    }
  }
}

/**
 * The sun hat's brim: a flat annulus with a rolled outer rim and a rolled inner one, so the
 * head passes up through it into the dome. Both rolls are half the plate's thickness, which
 * is `>= MIN_BEVEL` for any brim 0.04 thick or more.
 */
function brimGeometry(inner: number, outer: number, thickness: number): BufferGeometry {
  const hw = Math.min(thickness * 0.5, (outer - inner) * 0.4);
  const pts: [number, number][] = [];
  const arc = (cx: number, cy: number, a0: number, a1: number, steps: number) => {
    for (let i = 0; i <= steps; i++) {
      const a = a0 + ((a1 - a0) * i) / steps;
      pts.push([cx + Math.cos(a) * hw, cy + Math.sin(a) * hw]);
    }
  };
  arc(inner + hw, 0, Math.PI, Math.PI * 1.5, 4); // inner roll, lower half
  arc(outer - hw, 0, Math.PI * 1.5, Math.PI * 2.5, 6); // outer roll, all the way over
  arc(inner + hw, 0, Math.PI * 0.5, Math.PI, 4); // inner roll, upper half
  pts.push(pts[0]);
  return latheProfile(pts, 40, false);
}

/**
 * Fails the build if any part of the head would be outside a `top` prop's cavity when the
 * prop is resting on it — the same clearance test the flight arc already runs, at `t = 1`.
 *
 * Round 2 fixed the flight path with a solved Bezier and a 13-sample clearance sweep, and
 * `LANDING_R2` deliberately exempts the last 0.45 units of the descent because that part is
 * *meant* to be inside the hat. Nothing then checked what "inside the hat" meant, and the
 * answer was "through the skull". This is that check.
 *
 * `roll` matters and is applied: a head point at radius `r` on the axis of the roll lands
 * `r * sin(roll)` higher in the prop's frame than it does in the world's, so the party hat's
 * −0.14 pose asks for 0.032 more cavity on one side than an unrolled test would report.
 */
function assertSeated(
  id: string,
  cavity: Profile,
  roll: number,
  head: HeadEnvelope,
  lift = 0,
  /**
   * True for a prop that is open at the top — a crown band, not a hat. Above its rim there
   * is no prop for the head to be inside of, so a head point up there is not a collision;
   * without this the test reads `profileAt`'s "nothing above the last point" as a cavity of
   * radius zero and fails every open band by construction.
   */
  openTop = false
): void {
  const rim = cavity[cavity.length - 1][1];
  const cos = Math.cos(roll);
  const sin = Math.sin(roll);
  let worst = Infinity;
  let worstY = 0;
  for (let b = 0; b < TOP_BUCKETS; b++) {
    const r = head.radius[b];
    if (r <= 0) continue;
    const y = b * head.step;
    // The two extremes of the roll: the head point on the +X and −X sides of the seat.
    for (const s of [-1, 1]) {
      const py = -s * r * sin + y * cos;
      // Below the brim the head is not inside the hat, which is where a head belongs.
      if (py < lift) continue;
      if (openTop && py - lift > rim) continue;
      const pr = Math.abs(s * r * cos + y * sin);
      const slack = profileAt(cavity, py - lift) - pr;
      if (slack < worst) {
        worst = slack;
        worstY = py - lift;
      }
    }
  }
  if (worst < 0) {
    console.error(
      `[smile-maker] "${id}" is seated through the head: its cavity is ${(-worst).toFixed(3)} ` +
        `units too narrow at ${worstY.toFixed(3)} above the brim. Widen the cavity profile ` +
        "or raise `ANCHOR_RAYS.top.offset`."
    );
  }
}

/* ------------------------------------------------------------------ */
/* Props                                                               */
/* ------------------------------------------------------------------ */
/* ------------------------------------------------------------------ */

type Pose = { yaw?: number; pitch?: number; roll?: number };

type PropRecipe = {
  pose: Pose;
  /**
   * Pitch the prop is shown at **on the shelf**, about its own X. Zero for nine of the ten:
   * a prop authored around its anchor generally stands the right way up already. The cape
   * does not, because a cape hangs.
   */
  shelfPitch?: number;
  build: (out: Piece[]) => void;
};

const HALF_PI = Math.PI / 2;

/* ------------------------------------------------------------------ */
/* How coarse a prop's parts are, and why that is safe                  */
/* ------------------------------------------------------------------ */

/**
 * Detail level for one part, solved from the radius of the curve that decides **its own**
 * outline — not from the tier, and not by eye.
 *
 * ## Why this exists
 *
 * Round 4, SM3, measured the entry hitch and `node --cpu-prof` put 70 % of the build inside
 * the seam-occlusion pass, whose cost is `vertices x triangles-near-the-query`. The
 * sunglasses alone were **18 764 triangles** and **53.6 ms** of seam bake, warm. For a prop
 * that is 3 cm across on a face and about 90 CSS px wide on the shelf, that is between one
 * and two hundred triangles per pixel.
 *
 * ## Why it is not A4 again
 *
 * A4's finding was that a *tier table* was allowed to decide an outline: the low tier shipped
 * 12-sided lathes and 2-segment fillets, so the target device got facet planes. The fix
 * landed in `geometry.ts` as two floors on the **resolved** counts —
 * `MIN_SILHOUETTE_SEGMENTS = 24` and `MIN_FILLET_SEGMENTS = 3` — which are applied *after*
 * `pick3` picks, at every tier and for every caller. So `detail: 1` here still buys 24
 * silhouette segments and 3 fillet rings; what it drops is shading rate on curves that are
 * millimetres across, and that is exactly what the floors were written to make safe.
 *
 * The bound, from the same arithmetic §3 uses: at design framing a world unit is ~134 CSS
 * px, so an `n`-gon standing in for a circle of radius `r` shows a sagitta of
 * `134 · r · (1 − cos(π/n))` px. At the 24-segment floor that is `0.46 · r` px — under half
 * a pixel for **any** `r` below 1.09 units, which is wider than the whole dressed tooth. The
 * outline is safe at `detail: 1` for everything in this booth; only a part whose *shading*
 * needs more rings — a big sphere, a broad dome — asks for more.
 *
 * Measured effect (`scratchpad/sm/staged.mjs`): sunglasses 18 764 -> 6 436 triangles and
 * 53.6 -> 8.9 ms of warm build; glasses 9 448 -> 3 976 and 19.0 -> 4.4 ms; flower 6 744 ->
 * 3 384 and 22.5 -> 6.1 ms.
 */
const detailFor = (outlineRadius: number): number =>
  outlineRadius < 0.1 ? 1 : outlineRadius < 0.24 ? 2 : 3;

function recipes(): Record<string, PropRecipe> {
  /*
   * Materials. Every one of these is cached and shared; none is ours to dispose.
   *
   * **One family, and it is the registry's.** `src/games/index.ts` registers this game as
   * `accent: "mauve"`, and round 2 measured the booth using coral, peach, mauve, red *and*
   * rose — with no mauve element visible in the shipped dressed frame at all. A child taps a
   * mauve card on the hub and opens into a red room. Mauve is now the body colour of every
   * large accessory; peach and rose appear only as trim, a berry, a pompom, a petal.
   *
   * It is also half of G-SM-7. Twenty distinct clay materials went in; twelve come out
   * (five accents, one glass, enamel, two painted, three booth surfaces), and the tooth and
   * the polaroid paper now share `clayEnamel` with the highlight material rather than each
   * owning a private one.
   */
  const mauveDeep = clayAccent("mauve", "deep");
  const mauve = clayAccent("mauve", "main");
  const peach = clayAccent("peach", "main");
  const rose = clayAccent("rose", "main");
  const roseSoft = clayAccent("rose", "soft");
  /**
   * Lenses are **translucent**, and that is a content fix rather than a styling one.
   * The shipped sunglasses were opaque `rose.deep` slabs that covered both eyes completely:
   * crown plus shades plus a red cape produced a masked, spiked figure, and that was the
   * polaroid keepsake the child left with. A tinted lens keeps the eyes — and therefore the
   * face — readable through it.
   */
  const glass = lensMaterial();
  const gleam = clayEnamel();

  return {
    /* -------- Glasses: two clay rims, real lenses, arms folded back -------- */
    glasses: {
      pose: {},
      build: (out) => {
        // Tube 0.026 -> 0.034: a rolled clay ring rather than a wire, at the same outer
        // diameter — the eye props cannot grow, because they are worn on a face 0.64 units
        // tall that also has to hold a moustache. Their shelf legibility is bought by
        // `SHELF_BOOST` instead; see `layout.ts`.
        const rim = torusSoft(0.132, 0.034, detailFor(0.132));
        piece(out, rim, mauveDeep, { x: -0.19, cast: true });
        piece(out, rim, mauveDeep, { x: 0.19, cast: true });
        piece(out, softCapsule(0.034, 0.09, detailFor(0.034)), mauveDeep, { y: 0.018, rz: HALF_PI });
        // Temple arms: radius 0.021 -> 0.04. At 0.021 they measured 2 CSS px and aliased
        // into a dashed line; 0.04 clears 8 px at the design framing, which survives.
        // **Folded.** They used to be `rx: HALF_PI` — two rods standing straight out of the
        // back of the frame, splayed 25 degrees apart, which is a pair of glasses being worn
        // by nobody. On a shelf a pair of glasses is *folded*: both temples lie across the
        // back of the lenses, one over the other, roughly along X. See `sunglasses`.
        const arm = softCapsule(0.036, 0.46, detailFor(0.036));
        piece(out, arm, mauveDeep, {
          x: -0.09,
          y: -0.03,
          z: -0.105,
          rz: HALF_PI + 0.16,
          cast: true,
        });
        piece(out, arm, mauveDeep, {
          x: 0.09,
          y: -0.062,
          z: -0.135,
          rz: HALF_PI - 0.16,
          cast: true,
        });
        const lens = softSphere(0.125, detailFor(0.125));
        piece(out, lens, glass, { x: -0.19, z: -0.004, sz: 0.13 });
        piece(out, lens, glass, { x: 0.19, z: -0.004, sz: 0.13 });
      },
    },

    /* -------- Sunglasses: a brow bar, two tinted visor panes, under-rims -------- */
    sunglasses: {
      pose: {},
      build: (out) => {
        piece(out, roundedBox(0.74, 0.055, 0.06, 0.024, detailFor(0.024)), mauveDeep, { y: 0.095, cast: true });
        const lens = roundedPlate(0.31, 0.21, 0.05, 0.085, detailFor(0.085));
        piece(out, lens, glass, { x: -0.185, y: -0.03, rz: 0.1 });
        piece(out, lens, glass, { x: 0.185, y: -0.03, rz: -0.1 });
        /*
         * A rim all the way round each pane, as an ellipse rather than a rectangle so there
         * is still no hard edge on it (§0). Without it the panes had a frame on two sides —
         * the brow bar above, the under-rim below — and nothing at all on the outboard and
         * inboard edges, so a tinted pane at 0.46 opacity had no boundary and the shelf pad's
         * dimple read straight through the middle of the prop. The rim is what makes the tint
         * read as *glass in a frame* instead of as a stain on the table.
         */
        const bezel = torusSoft(0.155, 0.027, detailFor(0.155));
        piece(out, bezel, mauveDeep, { x: -0.185, y: -0.03, rz: 0.1, sx: 1.07, sy: 0.75, cast: true });
        piece(out, bezel, mauveDeep, { x: 0.185, y: -0.03, rz: -0.1, sx: 1.07, sy: 0.75, cast: true });
        // Under-rims: what makes a tinted pane read as *shades* rather than as goggles.
        const under = softCapsule(0.024, 0.24, detailFor(0.024));
        piece(out, under, mauveDeep, { x: -0.185, y: -0.148, rz: HALF_PI + 0.1, cast: true });
        piece(out, under, mauveDeep, { x: 0.185, y: -0.148, rz: HALF_PI - 0.1, cast: true });
        // Folded, exactly as the round pair are — see `glasses`.
        const arm = softCapsule(0.036, 0.5, detailFor(0.036));
        piece(out, arm, mauveDeep, {
          x: -0.1,
          y: -0.055,
          z: -0.1,
          rz: HALF_PI + 0.17,
          cast: true,
        });
        piece(out, arm, mauveDeep, {
          x: 0.1,
          y: -0.095,
          z: -0.13,
          rz: HALF_PI - 0.17,
          cast: true,
        });
        const spark = softSphere(0.05, detailFor(0.05));
        piece(out, spark, gleam, { x: -0.24, y: 0.012, z: 0.04, rz: 0.55, sy: 0.5, sz: 0.2 });
        piece(out, spark, gleam, { x: 0.13, y: 0.012, z: 0.04, rz: 0.55, sy: 0.5, sz: 0.2 });
      },
    },

    /* -------- Sun hat: a real brim with a hole in it, a hollow dome, a peach band -------- */
    hat: {
      pose: { roll: 0.09 },
      build: (out) => {
        // The brim is an **annulus**, not a disc. It was `roundedCylinder(0.6, 0.075, …)` —
        // a solid puck the head could only be inside of, which is what "swallow" was
        // supposed to mean and never was. Its hole is `TOP_CAVITY_R` across so the crown
        // passes up through it into the dome.
        piece(out, brimGeometry(HAT_SEAT_R, 0.58, 0.078), mauve, { y: HAT_LIFT, cast: true });
        piece(out, shellGeometry(HAT_CAVITY, HAT_SHELL, 30), mauve, {
          y: HAT_LIFT + 0.012,
          cast: true,
        });
        // The band rides *on* the dome: its ring radius is the dome's own outer radius at
        // that height, so the tube half-buries instead of floating around it.
        piece(out, torusSoft(profileAt(HAT_SHELL, 0.082), 0.05, detailFor(0.43)), peach, {
          y: HAT_LIFT + 0.094,
          rx: -HALF_PI,
        });
      },
    },

    /* -------- Party hat: a hollow cone, two stripes, a pompom -------- */
    party: {
      pose: { roll: -0.14 },
      build: (out) => {
        piece(out, shellGeometry(PARTY_CAVITY, PARTY_SHELL, 28), mauve, {
          y: PARTY_LIFT,
          cast: true,
        });
        /*
         * **One** stripe, near the base, and it sits on the cone's own radius at its height
         * so the tube half-buries instead of floating around it.
         *
         * It was two, at 0.13 and 0.33, and two horizontal bands across a cone read as tiers
         * — half of why SM6 saw a cupcake. One band at the brim reads as the hat's edge.
         */
        piece(out, torusSoft(profileAt(PARTY_SHELL, 0.1), 0.042, detailFor(0.4)), peach, {
          y: PARTY_LIFT + 0.1,
          rx: -HALF_PI,
        });
        piece(out, softSphere(0.088, detailFor(0.088)), rose, { y: PARTY_LIFT + 0.665 });
      },
    },

    /* -------- Crown: a rolled band, five soft points, three berries -------- */
    crown: {
      pose: {},
      build: (out) => {
        // Inner radius 0.416 -> `TOP_CAVITY_R`. The band used to be narrower than the head
        // it goes around: measured off the iso-surface at the `top` seat the crown reaches
        // 0.543, so the lower fifth of the band was inside the skull and three berries were
        // jammed through it. It is a closed arc chain, and since SM9 a **tapered** one that
        // is shorter than the head is tall above the seat — see `crownBandProfile`.
        piece(
          out,
          latheProfile(
            crownBandProfile(TOP_CAVITY_R, CROWN_TOP_R, TOP_WALL, CROWN_BAND_H),
            40,
            false
          ),
          peach,
          { y: CROWN_BAND_Y, cast: true }
        );
        // Base corner as a real 0.02 arc. The shipped profile turned it in one 0.006 step —
        // the same defect as the party hat's 0.005 base, and 3.3x under §3's minimum bevel.
        const point = latheProfile(crownPointProfile(0.094, 0.257), 16, false);
        // The rim the points stand on has moved inward with the taper, so they are placed
        // from the band's own mid-radius *at its top* rather than from a constant.
        const rimR = CROWN_TOP_R + TOP_WALL * 0.5;
        for (let i = 0; i < 5; i++) {
          const a = (i - 2) * 0.5;
          // Yawed to face outward first, so a single tilt about its own X leans the point
          // away from the crown no matter where it sits on the band.
          piece(out, point, peach, {
            x: Math.sin(a) * rimR,
            y: CROWN_BAND_Y + CROWN_BAND_H - 0.03,
            z: Math.cos(a) * rimR,
            ry: a,
            rx: 0.16,
            cast: true,
          });
        }
        const berry = softSphere(0.058, detailFor(0.058));
        // Half way up the band, on its own outer wall at that height.
        const berryY = CROWN_BAND_H * 0.4;
        const berryR =
          TOP_CAVITY_R + ((CROWN_TOP_R - TOP_CAVITY_R) * berryY) / CROWN_BAND_H + TOP_WALL + 0.012;
        for (let i = 0; i < 3; i++) {
          const a = (i - 1) * 0.46;
          piece(out, berry, rose, {
            x: Math.sin(a) * berryR,
            y: CROWN_BAND_Y + berryY,
            z: Math.cos(a) * berryR,
          });
        }
      },
    },

    /* -------- Moustache -------- */
    mustache: {
      pose: { pitch: -0.16 },
      build: (out) => {
        // sx 0.72 -> 0.85 and sy 0.72 -> 1.0. Both are capped by the face rather than by
        // taste: at full width the tips would stand 17 mm off a crown that curves away from
        // them, and any taller than 0.23 the moustache meets the bottom of a pair of
        // sunglasses worn at the same time. The shelf shows it 1.45x larger (`SHELF_BOOST`).
        // `mauve.deep`, not `CLAY.crevice`.
        //
        // Round 4, SM11 listed four "off-palette prop colours" and three of them are not:
        // the glasses are `ACCENTS.mauve.deep` verbatim, the bow tie and the sun hat are
        // `ACCENTS.mauve.main` verbatim, and their measured drift was A16's tone-map black
        // point, which `env.ts` has now removed. This one was real. `CLAY.crevice` is the
        // product's *crevice* tint — the colour a curvature baker mixes toward at the bottom
        // of a fold, and the colour the shared mascot's mouth recess uses — and it measures
        // dE2000 **7.92** from the nearest of the fifteen family tokens
        // (`scratchpad/sm/de.mjs`). As a wash in a crease nobody would call that a brand
        // colour question; as the whole body of the second-largest prop on the shelf it is.
        piece(out, beveledExtrude(mustacheShape(), { depth: 0.06, bevel: 0.028 }), mauveDeep, {
          sx: 0.85,
          sy: 1.0,
          cast: true,
        });
      },
    },

    /* -------- Bow tie -------- */
    bowtie: {
      pose: {},
      build: (out) => {
        piece(out, beveledExtrude(bowShape(), { depth: 0.075, bevel: 0.032 }), mauve, {
          sx: 1.15,
          sy: 1.3,
          cast: true,
        });
        piece(out, roundedBox(0.13, 0.19, 0.15, 0.05, detailFor(0.05)), mauveDeep, { z: 0.035 });
      },
    },

    /* -------- Flower: six petals and a peach middle -------- */
    flower: {
      pose: { yaw: -0.6, roll: 0.2 },
      build: (out) => {
        const petal = softSphere(0.105, detailFor(0.105));
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * Math.PI * 2;
          piece(out, petal, roseSoft, {
            x: Math.cos(a) * 0.125,
            y: Math.sin(a) * 0.125,
            rz: a,
            sx: 0.62,
            sy: 1,
            sz: 0.34,
            cast: true,
          });
        }
        piece(out, roundedCylinder(0.075, 0.06, 0.025, detailFor(0.075)), peach, { z: 0.04, rx: HALF_PI });
      },
    },

    /* -------- Cape: two panels wrapped back, a collar roll, a peach spark -------- */
    cape: {
      // Yaw only *when worn*. A forward tilt would read as a lean and, once the whole prop
      // has been turned through 180 degrees to face the tooth's back, would tip the hem
      // straight into the head instead of away from it. The shelf is a different problem —
      // see `shelfPitch`.
      pose: { yaw: Math.PI },
      /*
       * **Stood up, not laid down.** Round 3 photographed the old flat-panel cape lying on
       * its pad and read it as a hand mirror; round 4 (SM6) read the same prop reclined 49
       * degrees as a *reclining* hand mirror. Both readings were right about the object:
       * two flat plates with a ring on one end is a mirror whatever angle it is at.
       *
       * The prop is a wrapped shell now (see `capeWrap`), so the shelf pose that reads is
       * the obvious one — standing on its hem, the way a cape hangs on a stand. From the
       * booth camera the child sees the collar at the top, the two clasps at its front
       * corners, the wrap curving away behind and the wavy hem below: a garment with a top
       * and a bottom. A small lean forward keeps the inside of the wrap visible rather than
       * presenting a closed silhouette.
       *
       * `shelfLift` and the `PROP_ENVELOPE` check are both taken from the *posed* bounds, so
       * the lean cannot silently float the prop or outgrow the camera solve.
       */
      shelfPitch: -0.18,
      build: (out) => {
        /*
         * One panel, rolled flat and then wrapped — see the block comment on `capeWrap`.
         * The old build was two flat plates fanned about Y, which is what SM5 measured.
         */
        piece(out, beveledExtrude(capeShape(), { depth: CAPE_DEPTH, bevel: CAPE_BEVEL }), mauve, {
          y: -CAPE_DROP,
          warp: capeWrap,
          cast: true,
        });
        // Through the shared cache like every other geometry in the booth, so it is owned,
        // counted and evicted with the scene rather than orphaned on every rebuild.
        piece(
          out,
          cachedGeometry("smile-maker/cape-collar", () =>
            capeCollarGeometry(CAPE_R0, 0.055, CAPE_SPAN * 0.97)
          ),
          mauveDeep,
          { y: 0.02 - CAPE_DROP }
        );
        /*
         * Two clasps, one at each end of the collar, where a cape is actually fastened.
         *
         * It was `lobedShape(4, …)` — a four-lobed star — pinned to the middle of the cape's
         * back at `y = -0.42`. A four-lobed star is a **cross**, it was the only cross-shaped
         * mark anywhere in the product, and a cross on a garment in a *dental* app reads as
         * clinical. Nothing about the prop needed it: what a cape needs, and did not have, is
         * something at the throat that says which end is the top. Now that the cape wraps,
         * the throat is where its two front edges come round — so that is where these go.
         */
        const clasp = softSphere(0.05, detailFor(0.05));
        for (const side of [-1, 1]) {
          const a = side * CAPE_SPAN * 0.94;
          piece(out, clasp, peach, {
            x: Math.sin(a) * CAPE_R0,
            y: 0.02 - CAPE_DROP,
            z: -CAPE_R0 + Math.cos(a) * CAPE_R0,
            sz: 0.7,
          });
        }
      },
    },

    /* -------- Balloon on a string -------- */
    balloon: {
      pose: { yaw: 0.35 },
      build: (out) => {
        // 0.185 -> 0.265 radius. A balloon is one of the four props whose silhouette is
        // roughly square, so its short axis *is* what a child aims at: 0.53 world is 51 px
        // on the shelf at the design framing, against the 39 px round 2 measured.
        piece(out, softSphere(0.265), rose, { y: 0.72, sy: 1.12, cast: true });
        piece(
          out,
          latheProfile(
            [
              [0, 0],
              [0.062, 0.028],
              [0.024, 0.082],
              [0, 0.09],
            ],
            14
          ),
          rose,
          { y: 0.42, rx: Math.PI, cast: true }
        );
        // String radius 0.013 -> 0.026: at 0.013 it was a sub-pixel hairline.
        // Also `mauve.deep` rather than `CLAY.crevice` — see the moustache.
        piece(out, softCapsule(0.026, 0.44, detailFor(0.026)), mauveDeep, {
          x: 0.03,
          y: 0.2,
          z: 0.008,
          rz: 0.09,
        });
      },
    },
  };
}

/* ------------------------------------------------------------------ */
/* The build                                                           */
/* ------------------------------------------------------------------ */


/* ------------------------------------------------------------------ */
/* The dressed tooth, against the camera's reservation                 */
/* ------------------------------------------------------------------ */

/**
 * Fails the build if anything the tooth can wear reaches outside `layout.ts`'s
 * `WORN_SILHOUETTE`, which is the shape `cameraFor` reserves picture for.
 *
 * `PROP_ENVELOPE` has had a guard like this since round 2 and `WORN_SILHOUETTE` had none —
 * which is how it came to reserve a 0.62-radius disc at the top of every frame for a pompom
 * 0.20 across, and 0.55 at the bottom for a podium that is 0.62. Duplicated knowledge that
 * nothing checks drifts; duplicated knowledge that something checks is just a cache.
 *
 * The margin is one-sided on purpose: reserving *more* than the geometry needs wastes
 * picture and is caught by looking at a render, while reserving *less* crops a prop and is
 * caught by nothing.
 */
function assertWornFits(
  tooth: BufferGeometry,
  face: Layer[],
  props: PropBuild[],
  anchors: Record<AnchorId, Vector3>
): void {
  let worst = 0;
  let worstY = 0;
  const v = new Vector3();
  const m = new Matrix4();
  const q = new Quaternion();
  const e = new Euler();

  const check = (x: number, y: number, z: number) => {
    if (y < 0) return;
    const allowed = profileAt(WORN_SILHOUETTE, y);
    const over = Math.hypot(x, z) - allowed;
    if (over > worst) {
      worst = over;
      worstY = y;
    }
  };
  const sweep = (geo: BufferGeometry, matrix: Matrix4) => {
    const attr = geo.getAttribute("position");
    for (let i = 0; i < attr.count; i++) {
      v.fromBufferAttribute(attr, i).applyMatrix4(matrix);
      check(v.x, v.y, v.z);
    }
  };

  m.makeScale(TOOTH_SCALE, TOOTH_SCALE, TOOTH_SCALE).setPosition(0, TOOTH_BASE_Y, 0);
  sweep(tooth, m);
  for (const layer of face) sweep(layer.geometry, m);
  for (let i = 0; i < 24; i++) {
    const t = (i / 24) * Math.PI * 2;
    check(Math.sin(t) * PODIUM_R, PODIUM_H, Math.cos(t) * PODIUM_R);
  }
  for (let i = 0; i < props.length; i++) {
    const p = props[i];
    e.set(p.attachPitch, p.attachYaw, p.attachRoll, "YXZ");
    m.compose(anchors[ACCESSORIES[i].anchor], q.setFromEuler(e), _scl.set(1, 1, 1));
    for (const layer of p.layers) sweep(layer.geometry, m);
  }

  if (worst > 0) {
    console.error(
      `[smile-maker] the dressed tooth reaches ${worst.toFixed(3)} outside ` +
        `layout.ts::WORN_SILHOUETTE at y = ${worstY.toFixed(2)}. The camera reserves that ` +
        "shape, so something is about to be cropped."
    );
  }
}

/**
 * ## Why this is staged, and what each stage costs
 *
 * Round 4, SM3: entering this game cost a **299.1 ms** frame — eighteen dropped frames at
 * 60 Hz and the worst entry hitch measured anywhere in the round. The compile events in the
 * same capture put shader compilation at 2.2 ms, so it was never the shaders. It was this
 * function, called synchronously inside a `useMemo` on the scene's first render.
 *
 * Reproduced headlessly before anything was touched (`scratchpad/sm/profile.mjs`, the real
 * TypeScript through esbuild against real three r170): **325 ms cold, 157 ms with the shared
 * geometry cache already warm.** `node --cpu-prof` over six consecutive warm builds put
 * **70 % of the whole call inside `nearestTri2`** — the seam-occlusion pass — with the
 * iso-surface, the raycasts and the merges sharing the rest.
 *
 * Two independent fixes, and they compose:
 *
 *  1. `nearestTri2` now solves its cell range from the live query radius instead of always
 *     visiting 27 cells. Byte-identical output (the whole build's vertex colours hash the
 *     same before and after — `scratchpad/sm/seams.mjs`), 157 ms -> 129 ms warm.
 *  2. **The build is split.** `buildBooth()` produces the tooth, its face, the anchors and
 *     the head bounds — everything the child sees in the middle of the frame — and that is
 *     all the entry frame pays for. `buildNextProp()` then builds **one accessory per call**,
 *     driven from an idle callback after the entry transition has finished, and each one
 *     arrives in its slot with the same `easeOutBack` snap a landing uses. A shelf that
 *     fills itself in is charming; a 300 ms freeze is not.
 *
 * Every stage reports its real cost through `recordEvent`, so the next capture names the
 * stage instead of the file: look for `smile-maker/build:*` in `window.__perf.snapshot()`.
 */
/**
 * `recordEvent`'s ring is 32 slots wide and shared with the `compile:*` one-shots a capture
 * reads, so a build that published sixteen events per entry would push those out. The stage
 * timings are therefore published only when something is asking for them — `?perf` or
 * `?selftest` — and cost one `realNow()` pair otherwise.
 */
const TIMING = FLAGS.perf || FLAGS.selftest !== null;

function stage<T>(name: string, count: number, fn: () => T): T {
  if (!TIMING) return fn();
  const at = realNow();
  const out = fn();
  recordEvent(`smile-maker/build:${name}`, realNow() - at, count);
  return out;
}

/**
 * Everything except the accessories: the hero tooth, its face, the seven anchors and the
 * head bounds the flight arcs need. `props` comes back with all ten entries present but
 * empty (`layers: []`), so slot order, focus order and every pose the engine reads exist
 * from the first frame; `buildNextProp` fills them in.
 */
export function buildBooth(): SceneBuild {
  const build = buildScene(false);
  return build;
}

/**
 * Builds the next unbuilt accessory. Returns true while there is still work to do, so a
 * caller can drive it from `requestIdleCallback` without knowing how many there are.
 *
 * Appends to `build.owned`, which the scene's `DisposalBag` re-reads on every change — the
 * geometries this creates are this scene's and die with it.
 */
export function buildNextProp(build: SceneBuild): boolean {
  const index = build.built;
  if (index >= ACCESSORIES.length) return false;
  const def = ACCESSORIES[index];
  stage(`prop:${def.id}`, 1, () => {
    build.props[index] = buildProp(index, build.owned);
  });
  build.built = index + 1;
  if (build.built >= ACCESSORIES.length) {
    if (import.meta.env.DEV) {
      stage("assertWornFits", 0, () =>
        assertWornFits(build.tooth, build.face, build.props, build.anchors)
      );
    }
    return false;
  }
  return true;
}

/**
 * Builds the tooth, the face and all ten accessories in one call.
 *
 * Kept for callers that cannot stage — the offline harnesses, and any future non-React
 * consumer. The scene itself uses `buildBooth` + `buildNextProp`; see the block comment
 * above for why.
 */
export function buildSmileScene(): SceneBuild {
  return buildScene(true);
}

function buildScene(withProps: boolean): SceneBuild {
  const owned: BufferGeometry[] = [];

  /* -------- the tooth, at hero detail (3D-FOUNDATION-NOTES §5) -------- */
  const tooth = stage("tooth", 0, () => toothGeometry("baby", 4));

  /* -------- anchors and face -------- */
  const anchors = stage("anchors", ANCHOR_IDS.length, () => buildAnchors(tooth));
  const face = stage("face", 0, () => buildFace(tooth, owned));
  const head = stage("headBounds", 0, () => headBounds(tooth));

  /* -------- the crown, for the resting pose -------- */
  /*
   * `anchors.top` is where a hat comes to rest. Everything worn there has to be a shell the
   * crown fits inside at that seat, and until round 3 nothing checked it — see
   * `headEnvelope` for the measurement and `assertSeated` for the test.
   */
  if (import.meta.env.DEV) {
    stage("seatChecks", 3, () => {
      const seated = headEnvelope(tooth, anchors.top);
      assertSeated("hat", HAT_CAVITY, 0.09, seated, HAT_LIFT);
      assertSeated("party", PARTY_CAVITY, -0.14, seated, PARTY_LIFT);
      assertConical("party cavity", PARTY_CAVITY);
      assertConical("party shell", PARTY_SHELL);
      // A crown is an open band: its cavity is its inner *tapered* wall, and the head is
      // meant to come out of the top of it — so the profile is the band's own, and above
      // its rim it offers nothing, which `profileAt` reports as 0 and `assertSeated`
      // correctly ignores because those head points are not inside the prop at all.
      assertSeated(
        "crown",
        crownCavityProfile(TOP_CAVITY_R, CROWN_TOP_R, CROWN_BAND_H),
        0,
        seated,
        CROWN_BAND_Y,
        true
      );
    });
  }

  /* -------- accessories -------- */
  const props: PropBuild[] = [];
  for (let index = 0; index < ACCESSORIES.length; index++) props.push(emptyProp(index));

  const build: SceneBuild = { props, tooth, face, anchors, head, owned, built: 0 };
  if (withProps) while (buildNextProp(build));
  return build;
}

/** The seven attachment points, raycast against the real iso-surface. */
function buildAnchors(probe: BufferGeometry): Record<AnchorId, Vector3> {
  const anchors = {} as Record<AnchorId, Vector3>;
  for (const id of ANCHOR_IDS) {
    const spec = ANCHOR_RAYS[id];
    const hit = probeSurface(
      probe,
      spec.origin[0],
      spec.origin[1],
      spec.origin[2],
      spec.dir[0],
      spec.dir[1],
      spec.dir[2]
    );
    const local = hit
      ? hit.point.clone().addScaledVector(hit.normal, spec.offset)
      : new Vector3(spec.fallback[0], spec.fallback[1], spec.fallback[2]);
    anchors[id] = new Vector3(
      local.x * TOOTH_SCALE,
      TOOTH_BASE_Y + local.y * TOOTH_SCALE,
      local.z * TOOTH_SCALE
    );
  }
  return anchors;
}

/**
 * The face, probed onto the real iso-surface and merged into one layer per material.
 *
 * Its geometries go into `owned` — they are this scene's and die with it.
 *
 * Everything here runs on the entry frame, and it is the half of the build that has to: the
 * tooth's face is the middle of the picture and nothing about the booth reads without it.
 * The ten accessories do not, and they are staged — see `buildNextProp`.
 */
function buildFace(probe: BufferGeometry, owned: BufferGeometry[]): Layer[] {
  /*
   * Round 2: "the face is flat decals, and the dressed result reads as masked and stitched".
   * Both halves of that were true and both are geometry problems, not colour problems.
   *
   * **The mouth was a row of nine separate dots.** Seven `softSphere(0.031)` beads spaced
   * 0.071 apart on the surface leaves a visible gap between every pair, and a row of evenly
   * spaced dark beads across a face is read by an adult as stitching and by a child as a
   * zip. It is now one continuous curve: nineteen beads at 0.040 radius on a 0.030 pitch, so
   * each bead overlaps its neighbour by two thirds and the merged union is a smooth tube.
   * They are still probed onto the real iso-surface one at a time, which is the whole reason
   * the smile hugs the crown instead of cutting through it, and the colour is the product's
   * warm crevice brown — the same recess colour `mascotParts` uses, never black.
   *
   * **The eyes were flat.** A sphere squashed to 0.62 of its depth and sunk 0.026 is a disc
   * with nothing for the key to travel across. They are rounder (0.80 of depth), bigger, and
   * seated in a shallow ivory *lid* — a slightly proud enamel bead above each eye that casts
   * the eye into its own socket. That lid is what makes the eye shade with the form: it is
   * the same clay as the tooth, so `bakeCurvatureAO` and the wrapped diffuse do the work.
   */
  const ink = clayPainted(NEUTRAL.ink);
  const recess = clayPainted(CLAY.crevice);
  const gleam = clayEnamel();
  const blushMat = clayAccent("rose", "soft");

  const facePieces: Piece[] = [];
  const browGeo = softSphere(BROW_R, 1);
  const eyeGeo = softSphere(0.062);
  const dotGeo = softSphere(0.022);
  const blushGeo = softSphere(0.082);
  const smileGeo = softSphere(0.05, 1);

  /** Tooth-local y of the brow's peak and of its two ends — checked below in DEV. */
  let browPeak = -Infinity;
  let browInner = 0;
  let browOuter = 0;

  for (const side of [-1, 1]) {
    /** Azimuth of the eye — unchanged, and deliberately not the brow's; see `BROW_AZ`. */
    const a = side * EYE_AZ;

    /*
     * The brow, swept before anything else so it sits behind the eye in the merge order and
     * the eye reads as seated under it. See the block comment on `browArch`: the middle of
     * the stroke is probed higher up the crown than either end, so the brow arches instead
     * of tilting, and the two ends come out level with each other by construction.
     */
    for (let i = 0; i < BROW_BEADS; i++) {
      const u = (i / (BROW_BEADS - 1)) * 2 - 1;
      const az = side * (BROW_AZ + u * BROW_HALF_AZ);
      const hit = probeSurface(
        probe,
        0,
        BROW_FROM_Y,
        0,
        Math.sin(az),
        BROW_DY + browArch(u),
        Math.cos(az)
      );
      if (!hit) continue;
      const w = browWidth(u);
      onSurface(facePieces, browGeo, gleam, hit, BROW_SINK, w, w, 1);
      if (hit.point.y > browPeak) browPeak = hit.point.y;
      // `u = -1` is the inner end (smallest azimuth), `u = +1` the outer.
      if (i === 0) browInner = hit.point.y;
      else if (i === BROW_BEADS - 1) browOuter = hit.point.y;
    }

    const eye = probeSurface(probe, 0, 0.755, 0, Math.sin(a), 0.03, Math.cos(a));
    if (eye) {
      onSurface(facePieces, eyeGeo, ink, eye, 0.030, 1, EYE_SY, EYE_SZ);
      catchlight(facePieces, dotGeo, gleam, eye);
    }

    const c = side * 0.82;
    // Sink 0.052 -> 0.006. The blush was a 0.2-deep ellipsoid pushed 0.052 *below* the
    // surface, so its front face sat 0.036 inside the tooth: the cheeks have never been
    // drawn at all, in any shipped frame. Nobody caught it because a missing blush looks
    // like a design choice.
    //
    // No roll. It used to carry `side * BLUSH_TILT`, justified as "the cheek follows the
    // brow, at half the angle" — following a brow that was itself the SM2 defect. A blush
    // is a soft round bloom; there is nothing on it for a tilt to express.
    const blush = probeSurface(probe, 0, 0.652, 0, Math.sin(c), 0, Math.cos(c));
    if (blush) {
      onSurface(facePieces, blushGeo, blushMat, blush, 0.006, 1, 0.62, 0.2);
    }
  }

  if (import.meta.env.DEV && browPeak > -Infinity) {
    /*
     * Two invariants, both of which a single sign flip breaks, and neither of which is a
     * tolerance to be widened:
     *
     *  1. **The stroke arches.** Its peak stands above both of its ends. A brow that is flat
     *     is expressionless and a brow that is a straight tilt can only read angry or sad.
     *  2. **The inner end is never below the outer end in world y.** This is the direction
     *     the projection needs: the crown curves away, so the inner end sits further forward
     *     than the outer one, and the booth camera looks down on it — which pushes a forward
     *     point *down* the picture. Inner-above-outer in world is what comes out level on
     *     screen (see `BROW_SKEW`); inner-below-outer is the SM2 scowl by construction, at
     *     any camera.
     */
    const lift = browPeak - Math.max(browInner, browOuter);
    if (lift < 0.008) {
      console.error(
        `[smile-maker] the brow is not arched: its peak stands ${lift.toFixed(4)} above its ` +
          "higher end (needs > 0.008). A brow that is flat or tilted reads as angry, sad or " +
          "dead — see the comment on `browArch`."
      );
    }
    if (browInner < browOuter - 1e-4) {
      console.error(
        `[smile-maker] the brow's inner end is ${(browOuter - browInner).toFixed(4)} BELOW ` +
          "its outer end. That is the anger configuration (round 4, SM2) and the camera " +
          "makes it worse, not better — see `BROW_SKEW`."
      );
    }
  }

  /* One continuous smile. Every bead is placed on the real surface, so the curve follows the
     crown; the overlap is what stops it reading as a row of stitches. */
  const SMILE_BEADS = 19;
  for (let i = 0; i < SMILE_BEADS; i++) {
    const t = (i / (SMILE_BEADS - 1)) * 2 - 1;
    const y = 0.573 + 0.052 * t * t;
    const a = t * 0.42;
    // Tapered: the corners of a smile are thinner than its middle, which is the difference
    // between a mouth and a slot.
    const w = 0.62 + 0.38 * Math.cos(t * 1.35);
    const dot = probeSurface(probe, 0, y, 0, Math.sin(a), 0, Math.cos(a));
    // Sunk most of the way in, so what shows is a shallow spherical cap whose rim meets the
    // enamel almost tangentially — a dimple, not a bead sitting on top of the face. Measured
    // on the real iso-surface: neighbouring probe points are 0.020 apart and each cap is at
    // least 0.024 across, so the union is continuous everywhere including at the corners.
    if (dot) onSurface(facePieces, smileGeo, recess, dot, 0.036, w, w, 1);
  }

  /* -------- arms and feet -------- */
  /*
   * X3: "four games present bare, faceless teeth with exposed roots as the subject". This is
   * not one of the four — Smile Maker's tooth has had a face since it was written — but it
   * does present two bare roots, and `src/three/geometry.ts::MASCOT_FACE` now carries the
   * product's answer to that: feet at the root tips and arms off the crown's flanks turn the
   * same silhouette into somebody standing up.
   *
   * The proportions are the shared ones, verbatim, so this tooth is the same character as
   * the celebration hero and every other mascot in the product. They are built here rather
   * than through `mascotParts()` because they have to merge into this game's own enamel
   * layer and ride the tooth's scale, and because the face itself is raycast against the
   * real iso-surface, which `mascotParts` does not do.
   *
   * It also makes the `hand` anchor literal: the balloon's string now ends at a hand.
   */
  const F = MASCOT_FACE;
  const armGeo = softCapsule(F.arm.r, F.arm.len, 1);
  const footGeo = softSphere(0.1, 1);
  for (const side of [-1, 1]) {
    piece(facePieces, armGeo, gleam, {
      x: side * F.arm.x,
      y: F.arm.y,
      z: F.arm.z,
      // A capsule runs along +Y; a roll of -tilt swings the right arm up and out, so both
      // arms come off the crown's flank rather than out of its jaw.
      rz: -side * F.arm.tilt,
      cast: true,
    });
    piece(facePieces, footGeo, gleam, {
      x: side * F.foot.x,
      y: F.foot.y,
      z: F.foot.z,
      sx: F.foot.w / 0.1,
      sy: F.foot.h / 0.1,
      sz: F.foot.d / 0.1,
      cast: true,
    });
  }

  return assemble(facePieces, owned, false);
}

/**
 * A prop before its geometry exists.
 *
 * Every field the scene reads *before* the prop is on screen is here and is final: the id,
 * the three attach angles and the shelf pitch all come from the recipe table, which is pure
 * data. Only `layers`, `shelfLift` and `hitCenter` wait for the build, and each of those is
 * re-read from `build.props[i]` on the frame that uses it — never captured — so a prop
 * arriving late slides into its slot instead of appearing in the wrong one.
 */
function emptyProp(index: number): PropBuild {
  const recipe = recipeTable()[ACCESSORIES[index].id];
  return {
    id: ACCESSORIES[index].id,
    layers: [],
    attachYaw: recipe.pose.yaw ?? 0,
    attachPitch: recipe.pose.pitch ?? 0,
    attachRoll: recipe.pose.roll ?? 0,
    shelfPitch: recipe.shelfPitch ?? 0,
    shelfLift: 0,
    hitCenter: [0, 0, 0],
    built: false,
  };
}

/**
 * The recipe table, built once per module life.
 *
 * It holds only materials and closures — no geometry — so hoisting it out of the build costs
 * nothing and lets `emptyProp` read a pose before any geometry exists. The materials are all
 * cache lookups; the closures allocate their geometry only when called.
 */
let recipeCache: Record<string, PropRecipe> | null = null;
const recipeTable = (): Record<string, PropRecipe> => (recipeCache ??= recipes());

function buildProp(index: number, owned: BufferGeometry[]): PropBuild {
  const def = ACCESSORIES[index];
  const recipe = recipeTable()[def.id];
  const pieces: Piece[] = [];
  recipe.build(pieces);
  const layers = assemble(pieces, owned, true);

  /*
   * Bounds **in the shelf pose**, because that is the only pose these two numbers are for.
   * `shelfLift` puts the prop's lowest point on its pad and `PROP_ENVELOPE` tells the
   * camera how much room the prop takes on the shelf, and both are wrong for any prop with
   * a `shelfPitch` if they are read off the unrotated boxes. The slot fan is a yaw, which
   * changes neither the height nor the XZ radius, so pitch is the whole of it.
   */
  const shelfPitch = recipe.shelfPitch ?? 0;
  const cp = Math.cos(shelfPitch);
  const sp = Math.sin(shelfPitch);
  let minY = Infinity;
  let maxY = -Infinity;
  let radius = 0;
  for (const layer of layers) {
    const attr = layer.geometry.getAttribute("position");
    const a = attr.array as ArrayLike<number>;
    for (let v = 0; v < attr.count; v++) {
      const x = a[v * 3];
      const y = a[v * 3 + 1] * cp - a[v * 3 + 2] * sp;
      const z = a[v * 3 + 1] * sp + a[v * 3 + 2] * cp;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      const r = Math.max(Math.abs(x), Math.abs(z));
      if (r > radius) radius = r;
    }
  }
  const lift = Number.isFinite(minY) ? -minY * shelfScale(index) : 0;

  if (import.meta.env.DEV) {
    // `layout.ts` has to size the shot before any of this exists, so it carries a table of
    // authored envelopes. If a recipe outgrows its entry the camera silently starts
    // cropping — which is precisely the class of bug that shipped last round.
    const envelope = PROP_ENVELOPE[index];
    const height = maxY - minY;
    if (envelope && (radius > envelope[0] + 1e-3 || height > envelope[1] + 1e-3)) {
      console.error(
        `[smile-maker] "${def.id}" is bigger than its PROP_ENVELOPE entry: ` +
          `radius ${radius.toFixed(3)} (allowed ${envelope[0]}), ` +
          `height ${height.toFixed(3)} (allowed ${envelope[1]}). ` +
          "Update layout.ts::PROP_ENVELOPE or the camera will crop it."
      );
    }
  }

  const main = layers.length > 0 ? layers[0].geometry.boundingBox : null;
  const centre: [number, number, number] = main
    ? [
        (main.min.x + main.max.x) * 0.5,
        (main.min.y + main.max.y) * 0.5,
        (main.min.z + main.max.z) * 0.5,
      ]
    : [0, 0, 0];

  return {
    id: def.id,
    layers,
    attachYaw: recipe.pose.yaw ?? 0,
    attachPitch: recipe.pose.pitch ?? 0,
    attachRoll: recipe.pose.roll ?? 0,
    shelfPitch,
    // Not clamped at zero. It used to be, and that was harmless only while every prop's
    // geometry straddled its own origin. The party hat's brim now sits `PARTY_LIFT` above
    // its anchor, so its whole body is above its origin, `lift` is negative — the origin
    // belongs *below* the pad — and clamping it to zero floated the hat 4.7 cm above the
    // shelf. What this number means is "put the prop's lowest point on the pad", which has
    // always been true in both directions.
    shelfLift: Number.isFinite(lift) ? lift : 0,
    hitCenter: centre,
    built: true,
  };
}

/* ------------------------------------------------------------------ */
/* Booth furniture                                                     */
/* ------------------------------------------------------------------ */

/**
 * The clay turntable the accessories stand on. A closed cross-section, so it has no open
 * back and no place for the key to leak through.
 *
 * **Every corner is an arc, not a chamfer.** The shipped profile turned each corner with a
 * *single* straight segment 4 CSS px wide, facing away from the key: round 2 measured the
 * vertical luminance profile across the outer rim as `207 -> 110 -> 93 -> 174` — a 55 %
 * drop in one pixel — and the rim aliased into a broken dashed dark line. `3D-SPEC §0` is
 * "there is no hard edge anywhere in this product" and `§3` sets a minimum bevel radius of
 * 0.02 units; one chamfer segment satisfies neither, because a chamfer has two creases
 * rather than none.
 *
 * `CORNER = 0.05` with five points of arc puts 8-9 px of continuous gradient on the outer
 * rim at the design framing, and the lathe runs at 72 segments instead of 48 so the
 * silhouette of a 1.58-radius circle stays under a quarter of a pixel from true.
 */
const RING_CORNER = 0.05;
const RING_ARC_STEPS = 4;

export function shelfRingGeometry(
  inner: number,
  outer: number,
  top: number
): BufferGeometry {
  const c = Math.min(RING_CORNER, (outer - inner) * 0.32, top * 0.4);
  const pts: [number, number][] = [];
  /** Quarter arc of radius `c` centred on (cx, cy), swept from `a0` to `a1`. */
  const arc = (cx: number, cy: number, a0: number, a1: number) => {
    for (let i = 0; i <= RING_ARC_STEPS; i++) {
      const a = a0 + ((a1 - a0) * i) / RING_ARC_STEPS;
      pts.push([cx + Math.cos(a) * c, cy + Math.sin(a) * c]);
    }
  };

  // Anticlockwise in (radius, height), starting on the inner wall at the bottom.
  arc(inner + c, c, Math.PI, Math.PI * 1.5); // inner bottom
  arc(outer - c, c, Math.PI * 1.5, Math.PI * 2); // outer bottom
  arc(outer - c, top - c, 0, Math.PI * 0.5); // outer top
  arc(inner + c, top - c, Math.PI * 0.5, Math.PI); // inner top
  pts.push(pts[0]);

  // `smooth: false` because the profile is already an explicit arc chain — resampling it
  // through a spline would round the *straights* as well and pull the walls inward.
  return latheProfile(pts, 72, false);
}

export const podiumMaterial = () =>
  clay("smile-maker/podium", {
    color: CLAY.ivoryDeep,
    roughness: 0.78,
    sheen: 0.18,
    grain: 0.14,
  });

export const shelfMaterial = () =>
  clay("smile-maker/shelf", {
    color: NEUTRAL.well,
    roughness: 0.8,
    sheen: 0.12,
    grain: 0.16,
  });

/**
 * The polaroid's paper.
 *
 * Was a private `clay("smile-maker/paper")` painted `CLAY.enamel` — which is what
 * `clayEnamel()` already is. One fewer live material for no visible change (G-SM-7).
 */
export const paperMaterial = () => clayEnamel();

/**
 * The tinted lens the glasses and sunglasses share.
 *
 * It used to be `softGlass("#d6b3ae")`, and that was the last shader-program variant this
 * game owned (G-SM-7). `softGlass` is the one clay factory that sets `sheen: 0` *and*
 * `doubleSided: true`, and both are program defines: `USE_SHEEN` and `DOUBLE_SIDED`. Every
 * other clay material in the product — `clayAccent`, `clayPainted`, `clayEnamel`, plain
 * `clay()` — carries a sheen, a grain normal map and a single side, so they all compile to
 * the *same* program behind `materials.ts`'s constant `customProgramCacheKey`. One pair of
 * lenses was pulling a second one in.
 *
 * Nothing about the look needs those two flags here. Both lens solids are closed shells (a
 * flattened `softSphere`, a `roundedPlate`), so single-sided renders the front shell, which
 * is what a tinted lens is; with `doubleSided` you were seeing the back shell through the
 * front and doubling the tint. The sheen is what makes it read as glass rather than as
 * tinted air, and it is free now that it is the same lobe as the frame it sits in.
 *
 * `depthWrite` is the one thing `ClayOptions` cannot express, so it is set here. Safe to
 * mutate — the key is private to this game, the material is built once, and this runs
 * before it is ever assigned to a mesh. Without it a lens (renderOrder 0) would depth-cull
 * the anchor ring (renderOrder 3) whenever the ring came to rest behind the glasses.
 */
export const lensMaterial = () => {
  const m = clay("smile-maker/lens", {
    /*
     * `ACCENTS.mauve.deep`, at 0.58 rather than 0.46.
     *
     * Two findings, one number. The colour was `#d6b3ae`, which is not in any of the five
     * accent families 3D-SPEC §1.2 allows — it is the tan end of the chocolate ramp the brand
     * critic measured as this game's largest out-of-family block. And at 0.46 the tint was so
     * weak that the *dimple in the shelf pad behind the prop* read through both panes, so the
     * sunglasses had no interior at all. Mauve deep at 0.58, against ink eyes at `#2f3237`,
     * still leaves the pupils clearly visible through a worn pair — which is the round-2
     * content fix this must not undo — while giving the panes something to be.
     */
    color: ACCENTS.mauve.deep,
    roughness: 0.3,
    wrap: 0.4,
    sss: "#ffffff",
    sssStrength: 0.85,
    transparent: true,
    opacity: 0.58,
  });
  m.depthWrite = false;
  return m;
};

/**
 * The ring that shows a dragged prop where its anchor is.
 *
 * `grain` was 0, which is the only thing in this game that turned off the shared clay
 * normal map — and a material with no normal map compiles to a *different program* from one
 * with it, so a single 0.34-unit torus was carrying a whole extra shader variant against a
 * 28-program budget the game was already 3 over. It is a lit clay ring like everything else
 * now; at this size the grain is invisible and the program is free.
 */
export const anchorMaterial = () =>
  clay("smile-maker/anchor", {
    color: ACCENTS.peach.main,
    emissive: ACCENTS.peach.main,
    emissiveIntensity: 0.4,
    roughness: 0.5,
    sheen: 0.45,
    grain: 0.11,
    transparent: true,
    opacity: 0.88,
  });

/**
 * The hero tooth.
 *
 * `clayEnamel` rather than `clayIvory`: it is the product's mascot material — the same one
 * `src/three/geometry.ts::mascotParts` gives every tooth in the product — and sharing it
 * with the eye catchlights and the polaroid paper takes three materials down to one.
 */
export const toothMaterial = () => clayEnamel();

/* ------------------------------------------------------------------ */
/* The booth's own controls                                            */
/* ------------------------------------------------------------------ */

/**
 * ## A photo booth with a camera in it — round 4's SM7
 *
 * "`SmileMaker.tsx:250-369`: three DOM pills ("Surprise", "Clear", "Snap!") with 19 px
 * stroked-vector `currentColor` glyphs sitting on bare cream between the turntable's front
 * rim and the frame edge, anchored to nothing. `SmileMaker.tsx:296` records the round-3
 * finding verbatim — *this is a photo booth with no camera in it* — and answers it by
 * drawing a camera **icon on the web button**. §6.9 got the hard half right (the polaroid is
 * a real `WebGLRenderTarget` capture) and the easy half wrong."
 *
 * The three controls are objects now. They stand on the table in front of the turntable —
 * the band the DOM row used to cover, which the camera solve was already reserving and
 * which was otherwise bare cream — and they are the closest things in the shot to the lens,
 * so they are also the largest tap targets in the game.
 *
 *  - **the camera** takes the photograph, and the polaroid slides out of *its* lens;
 *  - **the lever** is pulled for a surprise, which is what a lever is for;
 *  - **the tray** is where everything goes when the tooth is cleared, and where it comes
 *    back from if the child presses it again.
 *
 * The DOM row is gone. `HitTarget` already publishes a real, focusable, labelled button in
 * `#lumident-a11y` for every one of the ten accessories; these three join the same
 * mechanism, in their own focus group, so the keyboard and screen-reader path is the one
 * the rest of the game already uses rather than a parallel one.
 *
 * The slots cannot hold them: `SLOT_ARC` is 142 degrees each side of front, so the ten
 * accessories already occupy everything except 76 degrees at the **back** of the rail —
 * where a camera would face away from the tooth and stand behind it.
 */

export type ControlId = ControlSlot["id"];

/**
 * Packs one control and checks it against its `CONTROL_SLOTS` envelope, which is what the
 * camera solve reserved picture for. Same duplicated-knowledge-with-a-check discipline
 * `PROP_ENVELOPE` gets, and for the same reason: framing drift is silent otherwise.
 */
function finishControl(
  id: ControlId,
  layers: Layer[],
  slot: ControlSlot,
  hitCenter: [number, number, number],
  lens?: [number, number, number]
): ControlBuild {
  if (import.meta.env.DEV) {
    let radius = 0;
    let top = 0;
    for (const layer of layers) {
      const attr = layer.geometry.getAttribute("position");
      const a = attr.array as ArrayLike<number>;
      for (let v = 0; v < attr.count; v++) {
        const r = Math.hypot(a[v * 3], a[v * 3 + 2]);
        if (r > radius) radius = r;
        if (a[v * 3 + 1] > top) top = a[v * 3 + 1];
      }
    }
    if (radius > slot.r + 1e-3 || top > slot.h + 1e-3) {
      console.error(
        `[smile-maker] control "${id}" is bigger than its CONTROL_SLOTS envelope: ` +
          `radius ${radius.toFixed(3)} (allowed ${slot.r}), height ${top.toFixed(3)} ` +
          `(allowed ${slot.h}). Update layout.ts or the camera will crop it.`
      );
    }
  }
  return { id, layers, hitCenter, hitRadius: CONTROL_HIT_R, lens };
}

export type ControlBuild = {
  id: ControlId;
  layers: Layer[];
  /** Local centre of the tap collider, and its world radius. */
  hitCenter: [number, number, number];
  hitRadius: number;
  /**
   * Where the polaroid is born, in the control's own local space. Only the camera has one;
   * it is the centre of the front of the lens.
   */
  lens?: [number, number, number];
};

/** Yaw that turns a control to face the tooth at the origin. */
export const controlYaw = (slot: ControlSlot): number => Math.atan2(-slot.x, -slot.z);

/**
 * The three controls. Built with the accessories rather than on the entry frame — they are
 * furniture, not the hero — and, like every prop here, one merged geometry per material.
 */
export function buildControls(owned: BufferGeometry[]): ControlBuild[] {
  const slotOf = (id: ControlId): ControlSlot => {
    const slot = CONTROL_SLOTS.find((c) => c.id === id);
    if (!slot) throw new Error(`[smile-maker] no CONTROL_SLOTS entry for "${id}"`);
    return slot;
  };
  const shell = clayAccent("mauve", "main");
  const trim = clayAccent("mauve", "deep");
  const button = clayAccent("rose", "main");
  const knob = clayAccent("peach", "main");
  const pale = clayEnamel();

  const out: ControlBuild[] = [];

  /* -------- the camera -------- */
  {
    const pieces: Piece[] = [];
    // Body: a rounded box on a short plinth, tipped up a little so the lens looks at the
    // tooth's face rather than at its feet.
    piece(pieces, roundedCylinder(0.3, 0.08, 0.03, 2), trim, { y: 0.04, cast: true });
    piece(pieces, roundedBox(0.44, 0.34, 0.3, 0.07, 2), shell, { y: 0.28, rx: -0.16, cast: true });
    // Lens barrel, pointing at the tooth (local -Z after the group's facing yaw).
    piece(pieces, roundedCylinder(0.115, 0.16, 0.04, 2), trim, {
      y: 0.3,
      z: -0.19,
      rx: HALF_PI - 0.16,
      cast: true,
    });
    piece(pieces, torusSoft(0.125, 0.032, detailFor(0.125)), knob, {
      y: 0.305,
      z: -0.25,
      rx: -0.16,
    });
    // The glass: a shallow enamel cap, so the lens has something in it.
    piece(pieces, softSphere(0.1, detailFor(0.1)), pale, { y: 0.303, z: -0.245, rx: -0.16, sz: 0.35 });
    // Shutter button, on top, where a thumb goes.
    piece(pieces, roundedCylinder(0.065, 0.06, 0.025, 1), button, { x: 0.13, y: 0.46, z: 0.03 });
    // Viewfinder bump.
    piece(pieces, roundedBox(0.13, 0.08, 0.1, 0.03, 1), trim, { x: -0.11, y: 0.45, z: 0.02 });
    out.push(finishControl("snap", assemble(pieces, owned, true), slotOf("snap"), [0, 0.3, -0.05], [0, 0.303, -0.31]));
  }

  /* -------- the surprise lever -------- */
  {
    const pieces: Piece[] = [];
    // 0.16, not 0.24. The lever sits on the booth's axis, so the circle that clears the
    // turntable costs it pure depth, and depth is what the camera solve binds on — see
    // `layout.ts::CONTROL_SLOTS`. A narrower foot is 0.07 of camera distance.
    piece(pieces, roundedCylinder(0.16, 0.075, 0.03, 2), trim, { y: 0.037, cast: true });
    // The stalk leans toward the child, which is the direction it wants to be pulled. The
    // lean is 0.22 rather than 0.34 for the same reason the foot is narrow: every unit of
    // radius on this control is a unit of depth in the shot.
    piece(pieces, softCapsule(0.045, 0.3, detailFor(0.045)), shell, {
      y: 0.24,
      z: 0.035,
      rx: 0.22,
      cast: true,
    });
    piece(pieces, softSphere(0.115, detailFor(0.115)), knob, { y: 0.425, z: 0.075, cast: true });
    out.push(finishControl("surprise", assemble(pieces, owned, true), slotOf("surprise"), [0, 0.31, 0.05]));
  }

  /* -------- the tray -------- */
  {
    const pieces: Piece[] = [];
    piece(pieces, clayTray(0.62, 0.44, 0.14, 0.05, 2), shell, { y: 0.07, cast: true });
    // Two little feet, so it reads as a dish standing on the table rather than a hole in it.
    for (const side of [-1, 1]) {
      piece(pieces, roundedCylinder(0.06, 0.04, 0.018, 1), trim, { x: side * 0.2, y: 0.02 });
    }
    out.push(finishControl("tray", assemble(pieces, owned, true), slotOf("tray"), [0, 0.1, 0]));
  }

  return out;
}

