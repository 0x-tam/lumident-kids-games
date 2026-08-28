/**
 * Count the Teeth — the counted mascot, in the two shapes this game needs it in.
 *
 * There is **one** source of truth for what a counted tooth looks like: `mascotParts()` in
 * `src/three/geometry.ts`, the same call the celebration hero, Tooth Rescue and Healthy or
 * Not? make. Everything in this file is a projection of its output.
 *
 * Round 3, B7.2, is why the file exists. The scene used to re-implement the face from the
 * raw `MASCOT_FACE` anchor table — and re-implemented it *wrongly*, because it multiplied
 * every feature's radius by `FACE_SCALE` and left the anchors alone. At 1.3 that put the eye
 * catchlight's centre 0.0597 from the pupil's centre against a pupil radius of
 * `0.068 x 1.3 = 0.0884`: the glint sphere was **entirely enclosed by the pupil** and never
 * rendered, and the same error hung the cheeks off the crown's outline. Two solid matte-black
 * discs over a lipless mouth line and a pair of exposed root prongs is a **skull**, and the
 * audit photographed fourteen of them on a tray.
 *
 * `mascotParts` has since been fixed (A19: the glint's offset scales with the eye, and every
 * outward-facing anchor is *pressed in* as its feature grows), so the fix here is to stop
 * having a second implementation at all. What this file keeps is the *submission strategy* —
 * fourteen mascots as **one** instanced mesh instead of 182 draw calls, and instead of the
 * five this game shipped in round 4 (CT2) — which is the only thing about this game's mascot
 * that is legitimately its own.
 */
import { Euler, Matrix4, Quaternion, Vector3, type BufferGeometry } from "three";
import {
  mascotGeometry,
  mascotMaterial,
  mascotParts,
  type MascotPart,
} from "../../three/geometry";
import { FACE_OPEN, FACE_SCALE } from "./layout";

/**
 * The counted mascot's parts, in the tooth's own normalised space: 1.0 unit tall, origin at
 * the base of the roots, so a part's world matrix is exactly `bodyMatrix x local`.
 *
 * `limbs: false` on purpose, and it is a countability decision rather than a taste one: a
 * counted prop's silhouette has to stay one clean isolated shape for the exclusion proof in
 * `layout.ts`, and arms would both widen every box (`uHalf` 0.474 -> 0.61 measured) and
 * visually tangle fourteen of them together. The limbs answer "a lone extracted tooth",
 * which is the celebration hero's problem; the face answers "these read as mushrooms", which
 * is this one's.
 */
export function countedMascotParts(detail?: number): MascotPart[] {
  return mascotParts({
    height: 1,
    featureScale: FACE_SCALE,
    open: FACE_OPEN,
    limbs: false,
    detail,
  });
}

/**
 * The counted mascot as a single merged geometry, face and all.
 *
 * Round 4, CT2. The submission strategy this file exists to own used to be "one instanced
 * mesh for the bodies plus one per face feature" — five meshes, and the four face ones were
 * allocated and drawn at `MAX_COUNT x perTooth` instances whatever the board actually held.
 * On an Easy board of five at the high tier that is 45,060 triangles and five draw calls for
 * five characters. `mascotGeometry` merges body and face into one buffer, carrying each
 * part's colour in the shared `aAlbedo` vertex channel, so the same five characters cost
 * **21,300 triangles and one call**, and one shadow-pass submission instead of five.
 *
 * The merge is only legitimate because a counted tooth's face never moves relative to its
 * body: `scene.tsx` composes every feature matrix as `bodyMatrix x local`, which is exactly
 * the transform the merge bakes in. If this game ever blinks or opens a mouth over time,
 * come back to `mascotParts` — and pay the four calls knowingly.
 *
 * Pair it with `countedMascotMaterial()` and nothing else: the albedo channel is a straight
 * multiply against that carrier's own colour, so a different material re-tints every face.
 */
export function countedMascotGeometry(detail?: number): BufferGeometry {
  return mascotGeometry({
    height: 1,
    featureScale: FACE_SCALE,
    open: FACE_OPEN,
    limbs: false,
    detail,
  });
}

/** The one material `countedMascotGeometry` is colour-calibrated against. */
export const countedMascotMaterial = mascotMaterial;

/**
 * The whole assembled mascot as a flat point cloud in its own normalised space — body plus
 * every face feature, transformed by its own local matrix.
 *
 * This is what `layout.ts::sweepSilhouette` measures, and therefore what `TOOTH_SILHOUETTE`
 * is a table of. It is deliberately the *same* assembly the scene renders rather than an
 * approximation of it, so the guard cannot pass on geometry the player never sees.
 *
 * Allocates a `Float32Array` of about 6 kB. Called once on mount under `import.meta.env.DEV`
 * and once per detail level by `?selftest=count`; never in a frame, never in production.
 */
export function mascotCloud(detail?: number): Float32Array {
  const parts = countedMascotParts(detail);
  let total = 0;
  for (const part of parts) total += part.geometry.getAttribute("position").count;

  const out = new Float32Array(total * 3);
  const m = new Matrix4();
  const pos = new Vector3();
  const rot = new Euler();
  const scale = new Vector3();
  const v = new Vector3();
  let w = 0;

  for (const part of parts) {
    pos.set(part.position[0], part.position[1], part.position[2]);
    rot.set(part.rotation[0], part.rotation[1], part.rotation[2]);
    scale.set(part.scale[0], part.scale[1], part.scale[2]);
    m.compose(pos, new Quaternion().setFromEuler(rot), scale);
    const attr = part.geometry.getAttribute("position");
    for (let i = 0; i < attr.count; i++) {
      v.fromBufferAttribute(attr, i).applyMatrix4(m);
      out[w++] = v.x;
      out[w++] = v.y;
      out[w++] = v.z;
    }
  }
  return out;
}
