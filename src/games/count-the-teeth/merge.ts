/**
 * Count the Teeth — the two props this game assembles from more than one solid.
 *
 * ## What merging does, and what it does not
 *
 * It removes draw calls: two meshes become one submission in the colour pass and one in the
 * shadow pass, which is the budget CT2 is about.
 *
 * It does **not**, on its own, give `bakeCurvatureAO` a crevice to find. A14 fix 4's rule is
 * that the baker sees curvature only within one welded mesh — but its weld is by *position*,
 * so it only helps where the two solids' vertices actually coincide. Two solids that merely
 * *intersect*, like a boss standing out of a face, share no vertex and get no crevice from
 * being merged. That is worth writing down because it is the mistake this file was one edit
 * away from shipping a comment about.
 *
 * So CT6's "1 px hard hairline groove" is fixed in `layout.ts` instead, by geometry: see
 * `PLATE_SINK`. The plate now rests on the tile's top plane rather than 0.04 inside it, so
 * the part of its rim that touches is the part that is nearly tangent to it — a 45-degree
 * valley the key can shade across, instead of a 90-degree corner one pixel wide. The merge
 * here is for the draw call, and it is honest about that.
 *
 * ## How the colour survives
 *
 * The tile is `CLAY.ivory` and its plate is `CLAY.enamel`, and one mesh takes one material.
 * The clay shader already has the channel for this — `aAlbedo`, a straight per-vertex
 * multiply that `materials.ts` added precisely so a palette would stop being run through
 * `bakeCurvatureAO`'s curvature extrapolation. Each part's colour is divided by the
 * carrier's and written there, exactly as `geometry.ts::buildMascotMesh` does it, so the
 * merged prop keeps two tones off one `MeshPhysicalMaterial` and the baked AO rides along
 * untouched in `color`.
 *
 * What is given up, knowingly: the plate's own `roughness` / `sheen` / `grain`. A material is
 * a whole-mesh property and there is no per-vertex channel for it. The two recipes differed
 * by 0.62 vs ivory's default roughness and 0.34 vs 0.11 of sheen — a difference that was
 * invisible at the plate's on-screen size next to a seam that was not.
 */
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  Matrix3,
  Matrix4,
  MeshStandardMaterial,
  Vector3,
  type Material,
} from "three";
import {
  bakeCurvatureAO,
  cachedGeometry,
  clayTray,
  roundedBox,
  softSphere,
  torusSoft,
} from "../../three/geometry";
import { ALBEDO_ATTRIBUTE, vertexAlbedoAttribute } from "../../three/materials";
import { getQuality } from "../../three/quality";
import { CLAY } from "../../three/tokens";
import {
  MAT_H,
  MAT_RIM,
  PLATE_D,
  PLATE_DY,
  PLATE_T,
  PLATE_W,
  TILE_CORNER,
  TILE_D,
  TILE_T,
  TILE_W,
} from "./layout";

/** One solid going into a merge: a geometry, where to put it, and what colour it is. */
type Part = {
  geometry: BufferGeometry;
  /** Local transform, applied to positions and (inverse-transposed) to normals. */
  matrix?: Matrix4;
  /**
   * sRGB hex. Divided by the carrier's colour and written into `aAlbedo`.
   *
   * Omitted means "the carrier's own colour", i.e. a neutral `(1,1,1)` multiply — which is
   * the right answer for a feature that is the *same clay* as the thing it stands on and is
   * meant to read by shading alone.
   */
  color?: string;
};

const _v = new Vector3();
const _nrm = new Matrix3();
const _carrier = new Color();
const _part = new Color();

/**
 * Welds a list of solids into one indexed geometry with per-vertex albedo and re-baked AO.
 *
 * `carrier` is the material the result will be drawn with; every part's colour is expressed
 * relative to it, so a part painted the carrier's own colour writes a neutral `(1,1,1)`.
 *
 * `bakeCurvatureAO` runs on the *merged* buffer, which is the entire point: it welds by
 * position, so the ring of triangles around a junction is now one ring and the concavity is
 * visible to it. `ao.strength` is the shared default the individual builders use.
 */
function mergeParts(parts: readonly Part[], carrier: Material, aoStrength: number): BufferGeometry {
  let vTotal = 0;
  let iTotal = 0;
  for (const p of parts) {
    const n = p.geometry.getAttribute("position").count;
    vTotal += n;
    iTotal += p.geometry.index ? p.geometry.index.count : n;
  }

  const pos = new Float32Array(vTotal * 3);
  const nrm = new Float32Array(vTotal * 3);
  const uv = new Float32Array(vTotal * 2);
  const alb = new Float32Array(vTotal * 3);
  const idx = vTotal > 65535 ? new Uint32Array(iTotal) : new Uint16Array(iTotal);

  // `materialColor` is not exported from materials.ts, and reading `.color` off the
  // `MeshStandardMaterial` every clay recipe is built on gives the same value it would.
  // Narrowed by `instanceof` rather than asserted, and guarded rather than assumed: a carrier
  // that has somehow lost its colour should render flat, not black.
  _carrier.set(1, 1, 1);
  if (carrier instanceof MeshStandardMaterial) _carrier.copy(carrier.color);
  const bR = _carrier.r > 1e-4 ? _carrier.r : 1;
  const bG = _carrier.g > 1e-4 ? _carrier.g : 1;
  const bB = _carrier.b > 1e-4 ? _carrier.b : 1;

  let vOff = 0;
  let iOff = 0;
  for (const p of parts) {
    const g = p.geometry;
    const src = g.getAttribute("position");
    const srcN = g.getAttribute("normal");
    const srcUv = g.getAttribute("uv");
    const n = src.count;
    const m = p.matrix;
    if (m) _nrm.getNormalMatrix(m);

    // `new Color(hex)` converts sRGB to linear on assignment, which is the space `aAlbedo`
    // and the carrier's own colour are both in. Never pre-convert by hand.
    const tint = p.color;
    const tinted = tint !== undefined;
    if (tinted) _part.set(tint);
    const aR = tinted ? _part.r / bR : 1;
    const aG = tinted ? _part.g / bG : 1;
    const aB = tinted ? _part.b / bB : 1;

    for (let i = 0; i < n; i++) {
      const o = (vOff + i) * 3;
      _v.fromBufferAttribute(src, i);
      if (m) _v.applyMatrix4(m);
      pos[o] = _v.x;
      pos[o + 1] = _v.y;
      pos[o + 2] = _v.z;
      if (srcN) {
        _v.fromBufferAttribute(srcN, i);
        if (m) _v.applyMatrix3(_nrm).normalize();
        nrm[o] = _v.x;
        nrm[o + 1] = _v.y;
        nrm[o + 2] = _v.z;
      }
      if (srcUv) {
        uv[(vOff + i) * 2] = srcUv.getX(i);
        uv[(vOff + i) * 2 + 1] = srcUv.getY(i);
      }
      alb[o] = aR;
      alb[o + 1] = aG;
      alb[o + 2] = aB;
    }

    const index = g.index;
    if (index) for (let i = 0; i < index.count; i++) idx[iOff + i] = index.getX(i) + vOff;
    else for (let i = 0; i < n; i++) idx[iOff + i] = i + vOff;

    vOff += n;
    iOff += index ? index.count : n;
  }

  const out = new BufferGeometry();
  out.setAttribute("position", new BufferAttribute(pos, 3));
  out.setAttribute("normal", new BufferAttribute(nrm, 3));
  out.setAttribute("uv", new BufferAttribute(uv, 2));
  out.setAttribute(ALBEDO_ATTRIBUTE, vertexAlbedoAttribute(alb));
  out.setIndex(new BufferAttribute(idx, 1));
  return bakeCurvatureAO(out, { strength: aoStrength });
}

/* ------------------------------------------------------------------ */
/* The answer tile                                                     */
/* ------------------------------------------------------------------ */

/**
 * An answer tile and its raised label plate, as one mesh.
 *
 * Both `roundedBox` calls are the ones the scene used to make separately, at the same
 * dimensions and the same corner radii; only `PLATE_DY` moved, and it moved in `layout.ts`
 * for a reason that has nothing to do with this merge (`PLATE_SINK`). What this buys is one
 * draw call and one shadow submission instead of two, on a prop drawn three times.
 *
 * `PLATE_T` is 0.06 against `MIN_PLATE_THICKNESS`'s 0.0444, so the plate carries §3's full
 * 0.02 bevel on its own rim.
 */
export function answerTileGeometry(carrier: Material, detail?: number): BufferGeometry {
  // Resolved into the key rather than left as "whatever the tier is": the adaptive-quality
  // net can lower `detail` mid-session, and a cache keyed on `undefined` would keep handing
  // back geometry built at the tier the scene mounted on. Every shared builder does the same
  // thing through `detailOf`, which is not exported.
  const dt = detail ?? getQuality().detail;
  const key = `count-the-teeth/tile|${dt}`;
  return cachedGeometry(key, () =>
    mergeParts(
      [
        { geometry: roundedBox(TILE_W, TILE_T, TILE_D, TILE_CORNER, dt), color: CLAY.ivory },
        {
          geometry: roundedBox(PLATE_W, PLATE_T, PLATE_D, TILE_CORNER - 0.06, dt),
          matrix: new Matrix4().makeTranslation(0, PLATE_DY, 0),
          color: CLAY.enamel,
        },
      ],
      carrier,
      1.15
    )
  );
}

/* ------------------------------------------------------------------ */
/* The tray, and the maker's mark pressed into its rim                 */
/* ------------------------------------------------------------------ */

/**
 * Where the mark sits on the front rim, as a fraction of the tray's half-width.
 *
 * Off-centre, because a centred mark reads as a logo and an off-centre one reads as a
 * potter's. −0.58 puts it under the left third of the board, clear of the round pips (which
 * are on the ground in front of the tray, centred) at every board size.
 */
const MARK_X_FRACTION = -0.58;
/**
 * Width of `clayTray`'s rolled lip on each side of the rim, in world units — **measured**.
 *
 * `clayTray` does not publish its profile, so this was read off the geometry the same way
 * `scene.tsx` reads the well floor: sample the tray's top surface across the front rim and
 * find where it stops being flat. On a 4.59 x 3.05 board it is flat at y = 0.1999 from
 * `matD/2 − 0.173` to `matD/2 − 0.043` and rolls away outside that, so the lip is 0.045 wide
 * and the usable flat band is `MAT_RIM − 2 · RIM_LIP` = **0.13**.
 *
 * It matters because a mark that overhangs the roll lifts off the surface at its ends — a
 * ring bent over a kerb rather than pressed into a rim. Everything below is derived from this
 * number rather than eyeballed, so if `MAT_RIM` changes the mark follows it.
 */
const RIM_LIP = 0.045;
/** The flat part of the rim, and the mark's outer radius inside it with clay to spare. */
const RIM_FLAT = MAT_RIM - 2 * RIM_LIP;
const MARK_OUTER = RIM_FLAT / 2 - 0.006;
/**
 * The mark's ring and its three dots, in world units.
 *
 * The ring's section is a circle, so half of it below the rim's surface leaves a half-round
 * rope standing on it — the same contact `PLATE_SINK` reasons about, and the reason there is
 * no hard edge anywhere in the mark (§0, §3).
 *
 * It is small, and deliberately: at a desktop framing the board spans about 92 CSS px per
 * world unit, so the ring reads at ~11 px across. A potter's mark is a detail you find at
 * arm's length and never notice on a phone, which is exactly the register CT7 asks for —
 * "a pressed maker's mark in the rim … a slight corner wear", not a logo.
 */
const MARK_TUBE = 0.013;
const MARK_R = MARK_OUTER - MARK_TUBE;
const MARK_DOT = 0.01;
/** How far the mark stands proud of the rim. */
const MARK_PROUD = 0.009;
/**
 * Subdivision for the mark's own parts, chosen by **screen size** rather than inherited.
 *
 * A4's rule is that a tier table may not decide a silhouette; it does not say every prop must
 * take the tier's top setting. This one is ~17 CSS px across with a ~3 px section at the
 * widest framing the product ships, and `MIN_SILHOUETTE_SEGMENTS` already floors the ring at
 * 24 segments around — 2.2 px per segment, a sagitta of 0.05 px, an order of magnitude under
 * the AA floor. Inheriting detail 3 instead costs **4,380 triangles** for a mark 17 px wide,
 * which is 2.4 % of §9's whole budget spent on a potter's stamp.
 */
const MARK_DETAIL = 1;

/**
 * The tray, dressed.
 *
 * Round 4, CT7: 85 % of the coral field is empty at tablet and phone aspects — and that
 * emptiness is *load-bearing*. It is `layout.ts`'s exclusion proof, and every unit of it is a
 * tooth a child can count without ambiguity. So the fix dresses the **tray**, which the proof
 * says nothing about, and does not touch the field: a small potter's mark pressed into the
 * front rim, a clay rope ring with three dots inside it.
 *
 * Two things it is deliberately **not**:
 *
 *  - *not a groove.* A merge is a union of surfaces, not a CSG subtraction: a shape sunk into
 *    the tray is simply inside it and invisible. Only raised features are honest here, so the
 *    "shallow thumb-groove" half of CT7's suggestion is not done — see the report.
 *  - *not tinted.* Every part is the tray's own clay (`color` omitted, a neutral `aAlbedo`),
 *    so it reads by shading and by its own curvature, the way a mark pressed into a real
 *    piece does. A second colour here would be a sticker.
 *
 * `torusSoft` and `softSphere` are round sections all the way through, so there is no hard
 * edge and no 90-degree silhouette corner anywhere in the mark (§0, §3). It is inside the
 * merged tray geometry, so the whole thing is still **one** draw call and one shadow
 * submission: CT7 costs the budget CT2 is about exactly nothing.
 *
 * Placed relative to the tray's own front rim, so it follows the board as the level and the
 * play area change it. `clayTray` builds Y-up with its base on y = 0, which is the space
 * these offsets are in — the scene lifts the mesh, not the geometry.
 */
export function dressedTrayGeometry(
  w: number,
  d: number,
  carrier: Material,
  detail?: number
): BufferGeometry {
  const dt = detail ?? getQuality().detail;
  const key = `count-the-teeth/tray|${w.toFixed(3)}|${d.toFixed(3)}|${dt}`;
  return cachedGeometry(key, () => {
    // The centre-line of the front rim: half a rim's width in from the outer silhouette.
    const rimZ = d / 2 - MAT_RIM / 2;
    const markX = (w / 2) * MARK_X_FRACTION;
    // `torusSoft` lies in the XY plane; the rim is horizontal, so the ring is laid flat.
    const lay = new Matrix4().makeRotationX(Math.PI / 2);
    // The ring's own section is a circle, so half of it below the rim's surface leaves a
    // half-round rope standing on it — the same contact `PLATE_SINK` reasons about.
    const ringY = MAT_H + MARK_PROUD - MARK_TUBE;

    const parts: Part[] = [
      { geometry: clayTray(w, d, MAT_H, MAT_RIM, dt) },
      {
        geometry: torusSoft(MARK_R, MARK_TUBE, MARK_DETAIL),
        matrix: new Matrix4().makeTranslation(markX, ringY, rimZ).multiply(lay),
      },
    ];

    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2 + Math.PI / 6;
      parts.push({
        geometry: softSphere(MARK_DOT, MARK_DETAIL),
        matrix: new Matrix4().makeTranslation(
          markX + Math.cos(a) * MARK_R * 0.44,
          MAT_H + MARK_PROUD - MARK_DOT,
          rimZ + Math.sin(a) * MARK_R * 0.44
        ),
      });
    }

    return mergeParts(parts, carrier, 1.0);
  });
}
