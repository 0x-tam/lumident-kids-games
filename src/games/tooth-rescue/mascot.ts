/**
 * Tooth Rescue's falling teeth, as **one** geometry.
 *
 * ---------------------------------------------------------------------------
 * Why this file exists
 * ---------------------------------------------------------------------------
 *
 * X3: "four games present bare, faceless teeth with exposed roots as the subject… an
 * extracted tooth is not a mascot." Tooth Rescue is the worst of the four, because the
 * bare tooth *is* the thing the child is asked to look at, catch and collect.
 *
 * `src/three/geometry.ts: mascotParts()` is the shared answer, but it hands back a flat
 * list of thirteen meshes to render as siblings. Tooth Rescue cannot do that: it draws up
 * to eighteen teeth, and eighteen groups of thirteen meshes is 234 draw calls against a
 * budget of 90 — never mind that they have to be an `InstancedMesh` to be simulated at all.
 *
 * So the parts are **baked down**: each part's geometry is cloned, transformed into mascot
 * space, tagged with its material's colour in the `aAlbedo` vertex attribute the round-2
 * clay shader added for exactly this, and merged into a single indexed `BufferGeometry`.
 * The result renders with **one material and one draw call for the whole pool**, and the
 * face is real geometry — spheres with real bevels catching the real key — not a decal.
 *
 * `aAlbedo` and not the `color` attribute, because `color` is where `bakeCurvatureAO`
 * writes signed curvature and the clay shader extrapolates it by `uClayAO = 1.45`: writing
 * `NEUTRAL.ink` there renders pure black and `coral.soft` renders arterial red. See
 * `materials.ts: ALBEDO_ATTRIBUTE`. The per-part curvature AO survives the merge untouched,
 * so every eye, cheek and foot still gets its own crevice darkening and edge gloss.
 *
 * ---------------------------------------------------------------------------
 * What is left out, and why
 * ---------------------------------------------------------------------------
 *
 * - **Arms.** A caught tooth is one of fourteen in a heap; fourteen pairs of static
 *   T-posed arms interlock into a thicket. Feet are kept, because feet are the specific
 *   answer to "exposed roots": they turn a crown-plus-two-splayed-roots silhouette into
 *   somebody standing up.
 * - **Eye catchlight *geometry*.** Two 320-triangle balls per tooth, 11,520 triangles
 *   across the pool, for a highlight that is 17.4 degrees of arc on the pupil. The
 *   triangles are still not spent — but round 3 was right that dropping them outright left
 *   a doll-eyed mascot ("darkest eye pixel `(26,23,19)`, a broad top sheen and no dot"),
 *   and the enamel specular this file used to credit is on the *body*, not on the matte ink
 *   of the eye. So the catchlight is now **painted into the eye sphere's own vertices** at
 *   merge time: `paintCatchlight` below writes an ivory smudge into the `aAlbedo` attribute
 *   over exactly the cap the omitted `glint` ball would have shown. Zero extra triangles,
 *   zero extra draws, zero extra material — and, being a vertex-interpolated albedo rather
 *   than a sphere, it is a soft smudge rather than the "tight white specular dot" `§0`
 *   bans.
 * - **Body subdivision above detail 2.** A tooth here renders at roughly 60 CSS pixels;
 *   the high tier's 1,620-triangle body is 640 triangles of nothing, doubled by the shadow
 *   pass, eighteen times over.
 */
import type { BufferGeometry, Material } from "three";
import { Color, Euler, Matrix4, Quaternion, Vector3 } from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

import { MASCOT_FACE, mascotParts } from "../../three/geometry";
import { ALBEDO_ATTRIBUTE, vertexAlbedoAttribute } from "../../three/materials";
import { getQuality } from "../../three/quality";
import { ACCENTS, CLAY, color } from "../../three/tokens";

/** Parts of the shared mascot this game does not bake in. See the header. */
const OMIT = new Set(["arm-l", "arm-r", "glint-l", "glint-r"]);

/**
 * The catchlight, as a cap on the eye instead of as a ball in front of it.
 *
 * `MASCOT_FACE.glint` is a sphere of radius `r` whose centre sits `|d|` from the pupil's
 * centre along `d = (dx, dy, dz)`, both scaled by `featureScale` — so what a child actually
 * sees of it is the spherical cap the glint cuts out of the pupil, and that cap is the same
 * at every `k`. Its half-angle is fixed by the two radii and the offset:
 *
 *   `cos(theta) = (|d|^2 + R^2 - r^2) / (2 |d| R)`  with `R = eye.r`
 *
 * which for the shipped `(-0.022, 0.024, 0.05)`, `r = 0.021`, `R = 0.068` is `|d| = 0.05972`,
 * `cos(theta) = 0.9543`, **theta = 17.4 degrees**. Reproduced from the tokens at module load
 * rather than written down, so it cannot drift from `MASCOT_FACE`.
 *
 * The painted version is deliberately *wider and softer* than the geometric one. The two
 * scales below act on `1 - cos(theta)`, which is what makes them cap *areas* rather than
 * angles: 0.36 and 2.2 put the solid core at **10.4 degrees** and the outer edge at
 * **25.9 degrees**. The eye is `softSphere(0.1, 2)` — an icosphere at subdivision 4, 252
 * vertices, mean vertex spacing `acos(1 - 2/252)` = 7.2 degrees — so the outer cap spans
 * `2 pi (1 - cos 25.9) / 4 pi` = 5.0 % of the sphere, i.e. about **13 vertices**, and the
 * shader interpolates a gradient between them. A 17.4-degree hard-edged disc would have
 * carried six and read as a polygon.
 */
const GLINT_DIR = (() => {
  const d = MASCOT_FACE.glint;
  const len = Math.hypot(d.dx, d.dy, d.dz);
  return { x: d.dx / len, y: d.dy / len, z: d.dz / len, len };
})();
const GLINT_COS = (() => {
  const R = MASCOT_FACE.eye.r;
  const r = MASCOT_FACE.glint.r;
  const L = GLINT_DIR.len;
  return (L * L + R * R - r * r) / (2 * L * R);
})();
const CORE_SCALE = 0.36;
const EDGE_SCALE = 2.2;
/**
 * How far the smudge lifts the pupil toward `CLAY.ivory`.
 *
 * Not to 1: a catchlight painted to full ivory on a matte ink sphere is a white dot with a
 * gradient round it, and `3D-SPEC §0` bans the dot however it is produced. Interpolated in
 * **linear** RGB (which is what `aAlbedo` carries), 0.55 of the way from `NEUTRAL.ink` to
 * `CLAY.ivory` lands the core at a relative luminance of **0.523**, against the pupil's
 * 0.031 and the enamel crown's 0.926. Carried through the same lighting the crown gets —
 * the crown renders at 0.663 — that is a smudge at ~0.373 over a pupil at ~0.022, i.e.
 * **5.9:1**, unmissable, while still sitting a third below the crown so the pupil never
 * becomes the brightest thing on the face.
 */
const GLINT_LIFT = 0.55;

/**
 * Writes the catchlight into an eye's albedo buffer, in place.
 *
 * `positions` are already in mascot space (the caller has applied the part matrix), so the
 * direction from the eye's own centre is `p - centre`, and the eye centre is exactly the
 * part's translation.
 */
function paintCatchlight(
  positions: ArrayLike<number>,
  count: number,
  albedo: Float32Array,
  cx: number,
  cy: number,
  cz: number,
  ivory: Color
): void {
  // `GLINT_DIR` is **not** mirrored between the two eyes, and that is deliberate: one light
  // source means both catchlights land on the same side of their pupil, and mirroring them
  // is the classic tell that a face was assembled rather than lit. `mascotParts` places the
  // omitted glint balls the same way — `side * eye.x + glint.dx * k`, with `dx` unmirrored.
  const cosCore = 1 - (1 - GLINT_COS) * CORE_SCALE;
  const cosEdge = 1 - (1 - GLINT_COS) * EDGE_SCALE;
  for (let i = 0; i < count; i++) {
    const dx = positions[i * 3] - cx;
    const dy = positions[i * 3 + 1] - cy;
    const dz = positions[i * 3 + 2] - cz;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-6) continue;
    const c = (dx * GLINT_DIR.x + dy * GLINT_DIR.y + dz * GLINT_DIR.z) / len;
    if (c <= cosEdge) continue;
    const t = Math.min(1, (c - cosEdge) / (cosCore - cosEdge));
    // Smoothstep, so the smudge has no ring at either end of its falloff.
    const w = t * t * (3 - 2 * t) * GLINT_LIFT;
    const o = i * 3;
    albedo[o] += (ivory.r - albedo[o]) * w;
    albedo[o + 1] += (ivory.g - albedo[o + 1]) * w;
    albedo[o + 2] += (ivory.b - albedo[o + 2]) * w;
  }
}

/* ------------------------------------------------------------------ */
/* The iris, and the lower lip                                          */
/* ------------------------------------------------------------------ */

/**
 * **B6.6.** At the size this game draws a tooth, the shared rig's eye is one solid ball of
 * `NEUTRAL.ink`. Round 4 photographed the result at high magnification — "a white blob with
 * two large pure-black voids and a dark curved gash across the crown", and, in a basket, "a
 * bin of skulls". Two of those three words are about the eyes: a *void* is a hole, and an
 * *eye* is a hole with something in it.
 *
 * So the pupil keeps the middle of the cap and the rest of it becomes an iris, painted into
 * the same `aAlbedo` attribute the catchlight already uses — zero extra triangles, zero extra
 * draws, zero extra material, and nothing for the shared rig to change. The colour is
 * `CLAY.crevice`, the product's one warm brown and the colour of the mouth recess two
 * centimetres below it, so the face is lit by one palette rather than two.
 *
 * The three bands are stated as half-angles from the eye's own front pole, because that is
 * what a child sees: the eye's visible cap at this game's `featureScale` of 1.6 runs to about
 * **70 degrees** (`cos t = 1 - capHeight / r`, with the eye anchored 0.0367 H inside the crown
 * and a radius of 0.068 k). Inside 30 degrees is pupil, 30-62 is iris, and everything outside
 * that stays ink — a dark limbal ring, which is what stops the brown reaching the crown and
 * softening the eye's outline.
 *
 * Measured through the albedo: ink is relative luminance 0.031 and `CLAY.crevice` is 0.164, so
 * the iris reads **5.2:1 against the pupil** while still sitting far below the enamel crown's
 * 0.926 — the eye keeps all of its weight in the silhouette and stops being a hole.
 */
const IRIS_HEX = CLAY.crevice;
const PUPIL_COS = Math.cos((30 * Math.PI) / 180);
const IRIS_COS = Math.cos((62 * Math.PI) / 180);

/** Writes the iris ring into an eye's albedo buffer, in place. Runs before the catchlight. */
function paintIris(
  positions: ArrayLike<number>,
  count: number,
  albedo: Float32Array,
  cx: number,
  cy: number,
  cz: number,
  iris: Color
): void {
  for (let i = 0; i < count; i++) {
    const dx = positions[i * 3] - cx;
    const dy = positions[i * 3 + 1] - cy;
    const dz = positions[i * 3 + 2] - cz;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-6) continue;
    // The cap axis is the eye's own front pole, which is +z: every feature on this rig is
    // anchored on the crown's front and the mascot faces the camera.
    const c = dz / len;
    if (c >= PUPIL_COS || c <= IRIS_COS) continue;
    // Smoothstep in from both edges, so neither the pupil's rim nor the limbal ring is a
    // hard line — `3D-SPEC §0` bans the edge however it is produced.
    const t = (c - IRIS_COS) / (PUPIL_COS - IRIS_COS);
    const w = t < 0.5 ? smooth(t * 2) : smooth((1 - t) * 2);
    const o = i * 3;
    albedo[o] += (iris.r - albedo[o]) * w;
    albedo[o + 1] += (iris.g - albedo[o + 1]) * w;
    albedo[o + 2] += (iris.b - albedo[o + 2]) * w;
  }
}

const smooth = (t: number): number => {
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  return x * x * (3 - 2 * x);
};

/**
 * **B6.6, second half.** "Give the mouth a lower lip so it cannot read as a crack when
 * flipped."
 *
 * The lip is painted onto the **mouth stroke itself**, not onto the crown beneath it, and
 * that is the second attempt rather than the first. Painting the crown does not work, and the
 * reason is vertex density: `mouthArcGeometry`'s stroke is 0.149 of a tooth tall at this
 * game's `open`, so a ridge under it has about 0.06 of a unit to live in, and the body is a
 * subdivision-6 icosphere — **fewer than a dozen of its vertices fall inside that band**, so
 * the lift renders as a dapple rather than as a line. Widening the band to 0.125 spreads the
 * same lift over twice the area and it disappears altogether. Both were rendered and looked
 * at (`scratchpad/tr/face.png`).
 *
 * The stroke is a swept tube and has vertices all the way round, so the two-tone belongs
 * there: everything whose normal points downward is lifted toward `red.soft`, ramped by
 * `-n.y`, which makes the underside of the stroke a lit lip and leaves the upper half the
 * `CLAY.crevice` recess it already is. One curve, two tones, no extra geometry — and a
 * two-tone mouth cannot read as a crack in either orientation, because a crack has no lit
 * side.
 */
const LIP_HEX = ACCENTS.red.soft;
const LIP_LIFT = 0.62;

function paintLip(
  normals: ArrayLike<number>,
  count: number,
  albedo: Float32Array,
  lip: Color
): void {
  for (let i = 0; i < count; i++) {
    const ny = normals[i * 3 + 1];
    if (ny >= 0) continue;
    const w = smooth(-ny) * LIP_LIFT;
    const o = i * 3;
    albedo[o] += (lip.r - albedo[o]) * w;
    albedo[o + 1] += (lip.g - albedo[o + 1]) * w;
    albedo[o + 2] += (lip.b - albedo[o + 2]) * w;
  }
}

const _m = new Matrix4();
const _p = new Vector3();
const _q = new Quaternion();
const _e = new Euler();
const _s = new Vector3();

/** Every clay factory returns a `MeshPhysicalMaterial`, but `MascotPart` types it loosely. */
type Coloured = Material & { color?: Color };

/**
 * Bakes the shared mascot into one indexed geometry, centred and scaled the way
 * `toothGeometry` is: origin at the root tips, one unit tall.
 *
 * `featureScale` is the number that decides whether a child can see a face at all. The
 * shared rig's anchors are authored as fractions of the tooth, so at 1.0 a tooth rendering
 * at 60 px carries an 8 px eye. 1.6 puts the eye at 13 px — the same eye-to-head ratio
 * Healthy or Not's hero uses.
 *
 * **Clearance is now checked by the shared rig, and this file no longer asserts it.** Round 3
 * (A19) found that `mascotParts` scaled feature radii by `featureScale` but passed the anchor
 * offsets unscaled, so every clearance in `MASCOT_FACE` was invalid at k != 1 — at this
 * file's 1.6 the cheek stood 7 % of the half-width outside the crown and the mouth 0.039
 * proud of the surface, which is why this comment's "keeping every feature inside the crown's
 * silhouette" was wrong when it was written. `mascotParts` now applies
 * `pressIn(anchor, half, k)` and clamps `featureScale` into a derived `[0.72, 1.68]`, so 1.6
 * is inside the range by construction. Re-derived against the shipped geometry rather than
 * re-asserted here: eye outer x 0.2588 against a 0.3293 silhouette at that height, cheek
 * 0.3200 against 0.3615, mouth 0.2480 against 0.3681 — all in units of the tooth's height.
 *
 * The caller owns the result and must dispose it: it is a private geometry, not a cache
 * entry, so nothing else will.
 */
export function buildMascotGeometry(): BufferGeometry {
  const parts = mascotParts({
    height: 1,
    // Capped, not taken: see the header.
    detail: Math.min(2, getQuality().detail),
    featureScale: 1.6,
    // A wide closed grin. Above 0.3 the shared rig adds a tongue, which is another 320
    // triangles times the pool for something invisible at this size.
    open: 0.28,
    limbs: true,
    kind: "baby",
  });

  const pieces: BufferGeometry[] = [];
  for (const part of parts) {
    if (OMIT.has(part.key)) continue;
    const geo = part.geometry.clone();

    _p.set(part.position[0], part.position[1], part.position[2]);
    _e.set(part.rotation[0], part.rotation[1], part.rotation[2]);
    _q.setFromEuler(_e);
    _s.set(part.scale[0], part.scale[1], part.scale[2]);
    _m.compose(_p, _q, _s);
    // `applyMatrix4` runs the normals through the inverse-transpose, which is what keeps
    // the non-uniformly scaled cheeks and feet lit correctly after the bake.
    geo.applyMatrix4(_m);

    const count = geo.getAttribute("position").count;
    const albedo = new Float32Array(count * 3);
    const c = (part.material as Coloured).color;
    // Values are linear RGB. `MeshPhysicalMaterial.color` already is — three's
    // ColorManagement converted the token hex on assignment — so never re-convert here.
    const r = c ? c.r : 1;
    const g = c ? c.g : 1;
    const b = c ? c.b : 1;
    for (let i = 0; i < count; i++) {
      albedo[i * 3] = r;
      albedo[i * 3 + 1] = g;
      albedo[i * 3 + 2] = b;
    }
    if (part.key === "eye-l" || part.key === "eye-r") {
      const eyePos = geo.getAttribute("position").array as ArrayLike<number>;
      // Iris first, catchlight over it: the highlight belongs on top of whatever it lands on.
      paintIris(eyePos, count, albedo, part.position[0], part.position[1], part.position[2], color(IRIS_HEX));
      paintCatchlight(
        eyePos,
        count,
        albedo,
        part.position[0],
        part.position[1],
        part.position[2],
        color(CLAY.ivory)
      );
    } else if (part.key === "mouth") {
      paintLip(geo.getAttribute("normal").array as ArrayLike<number>, count, albedo, color(LIP_HEX));
    }
    geo.setAttribute(ALBEDO_ATTRIBUTE, vertexAlbedoAttribute(albedo));
    pieces.push(geo);
  }

  // `mergeGeometries` needs every input to carry the same attribute names, which they do:
  // each part comes out of `geometry.ts: finish()` with position / normal / uv / color, and
  // the loop above gave them all an albedo.
  const merged = mergeGeometries(pieces, false);
  for (const p of pieces) p.dispose();
  if (!merged) {
    // Cannot happen with the inputs above, but a null here would mean an invisible game.
    // Fall back to the plain body rather than to nothing.
    const fallback = parts[0].geometry.clone();
    fallback.computeBoundingSphere();
    return fallback;
  }
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  return merged;
}
