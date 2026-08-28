/**
 * Spot the Difference — the bathroom, built in code.
 *
 * Every prop here is procedural geometry from `src/three/geometry.ts` and every surface is
 * a factory from `src/three/materials.ts`. Nothing is loaded, nothing is a texture of a
 * drawing, and nothing has a hard edge: the box, the counter, the basin, the duck and the
 * soap bottle are all filleted solids with baked curvature AO.
 *
 * Two decisions here exist purely to pay for rendering the scene **twice a frame**:
 *
 *  1. **Multi-part props are merged into one geometry.** A duck made of eight spheres is
 *     eight draw calls, which becomes sixteen once both panels draw it. `assemble()` bakes
 *     each part's own colour into the `aAlbedo` attribute the clay materials multiply in
 *     *after* the curvature term, so a merged prop keeps per-part colour on a single
 *     material and still lands on its token. The duck, the basin-and-tap, the cup with its
 *     fixed toothbrush, the loose toothbrush, the soap bottle, the towel and the window
 *     frame are each one draw call. The same argument applies *across* props once they share
 *     a material and never move, so the table and the cyclorama, the counter and the basin,
 *     and the shelf and the towel rail are also one mesh each. Round 2 measured 83 draw
 *     calls on the celebration frame against §9's ceiling of 90; these merges are worth
 *     eight of them, which is the headroom the shared celebration needs to composite over
 *     two live pictures instead of replacing them.
 *  2. **Tessellation is specified, not inherited.** Most props pass an explicit `detail`
 *     to the geometry builders rather than taking the device tier's. A toothbrush head nine
 *     millimetres across does not need a high-tier bevel, and on the high tier the tier
 *     default would put the two panels plus their two shadow passes at the §9 triangle
 *     ceiling. The room box, the vanity and the mirror frame — the large, flat, well-lit
 *     surfaces where faceting would actually show — keep the tier default.
 *  3. **The room shell never casts, and nothing outside it receives.** The box, the floor
 *     tiles, the mirror glass, the wall stars and the two answer marks are `castShadow: false`:
 *     the shadow pass also runs once per panel, so a caster costs two draw calls a frame, and
 *     none of those five has a receiver to throw a shadow onto. That is now a statement about
 *     the *receivers*, not about the props: the mirror glass is visible for the first time
 *     (see `layout.ts::MIRROR_GLASS_Z`) and the three stars stand a full 0.094 proud of it, so
 *     three casters plus a `receiveShadow` on the glass would buy a real contact shadow — and
 *     cost six shadow-pass draw calls a frame (three props x two panels) against the eight of
 *     headroom `§9`'s 90-call ceiling leaves the celebration frame. The stars are peach on an
 *     enamel panel at ΔE76 53.8, with `bakeCurvatureAO` running through their rims; they
 *     do not need to buy legibility twice. Every free-standing prop does cast. The consequence
 *     of a shell that does not cast is that light passes through
 *     it, so the surround — the table and the cyclorama, both built here rather than by
 *     `Rig` — is `receiveShadow: false`. See the comment on the surround for the arithmetic;
 *     making the shell cast instead would put its own rim across the upper 45% of the back
 *     wall, which is where the mirror and the window are.
 *
 * Nothing in this module runs at import time: `buildDiorama()` is called from the scene's
 * mount, so the geometry work lands in this game's own lazy chunk and on the frame the
 * child enters the game, never on the hub's cold start.
 */
import {
  Color,
  Euler,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  Object3D,
  Quaternion,
  Shape,
  Vector3,
  type BufferGeometry,
  type Material,
} from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import {
  bakeCurvatureAO,
  beveledExtrude,
  clayTray,
  latheProfile,
  roundedBox,
  roundedCylinder,
  roundedPlate,
  softCapsule,
  softSphere,
  torusSoft,
} from "../../three/geometry";
import {
  ALBEDO_ATTRIBUTE,
  clay,
  clayEnamel,
  clayGround,
  clayPainted,
  clayRubber,
  vertexAlbedoAttribute,
} from "../../three/materials";
import { disposeObject3D } from "../../three/dispose";
import { ACCENTS, CLAY, NEUTRAL, accent, auditSceneAccents, classifyAccent } from "../../three/tokens";
import {
  BADGE_ROT,
  BASIN_SQUASH,
  BASIN_Z,
  CABINET_D,
  CABINET_Z,
  COUNTER_D,
  COUNTER_Y,
  COUNTER_Z,
  CUP_Z,
  FLOOR_Y,
  GAME_ACCENT,
  GROUND_Y,
  MIRROR_GLASS_Z,
  MIRROR_Z,
  RAIL_Z,
  ROOM,
  SHELF_Y,
  SHELF_Z,
  STAR_Z,
  TILE_DEPTH,
  TILE_Z,
  TRAY_WELL_FLOOR,
  WINDOW_Z,
} from "./layout";

/* ------------------------------------------------------------------ */
/* Part assembly                                                       */
/* ------------------------------------------------------------------ */

type Part = {
  geo: BufferGeometry;
  /** sRGB hex written into this part's `aAlbedo` attribute. See `assemble`. */
  tint?: string;
  pos?: [number, number, number];
  rot?: [number, number, number];
  scale?: [number, number, number] | number;
};

const _m = new Matrix4();
const _q = new Quaternion();
const _e = new Euler();
const _p = new Vector3();
const _s = new Vector3();
const _tint = new Color();

/**
 * Every colour this scene actually paints with, collected as it is used. DEV only.
 *
 * A hand-kept list of "the colours this file uses" is a second source of truth and it rots the
 * first time somebody edits a material; this is the colours the build really handed to the
 * renderer. `auditSceneColours` reads it — see there for what is asserted and what is only
 * reported, and why the difference matters.
 */
const devColours = new Set<string>();

/**
 * Bakes several cached geometries into one, with each part's colour carried per-vertex.
 *
 * **The colour goes into `aAlbedo`, never into `color`.** `color` is the curvature-AO
 * channel, and the clay shader extrapolates it through `uClayAO = 1.45` as *signed
 * curvature* — so round 2's version of this function, which multiplied the token colour
 * into `color`, pushed every tint through a 1.45x gamma-like curve away from mid-grey.
 * Measured on the shipped build: the duck's `peach.main` `#efa160` rendered around
 * `(227,74,9)` and the soap's coral read as pink. Writing the same linear value into the
 * dedicated albedo attribute is a straight multiply *after* the curvature term, so the
 * duck is peach again and its creases are still dark and its edges still worn.
 *
 * `Color.set` converts an sRGB hex into three's linear working space, which is exactly what
 * `aAlbedo` wants — never pre-convert by hand. The attribute is only attached when at least
 * one part is tinted; `DEFAULT_ATTRIBUTES` supplies white for the rest.
 *
 * The source geometries are cached and shared, so every part is cloned first.
 */
function assemble(parts: Part[]): BufferGeometry {
  const clones: BufferGeometry[] = [];
  let tinted = false;
  for (let i = 0; i < parts.length; i++) if (parts[i].tint !== undefined) tinted = true;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const geo = part.geo.clone();
    const pos = part.pos;
    const rot = part.rot;
    const scale = part.scale;
    _p.set(pos ? pos[0] : 0, pos ? pos[1] : 0, pos ? pos[2] : 0);
    _e.set(rot ? rot[0] : 0, rot ? rot[1] : 0, rot ? rot[2] : 0);
    _q.setFromEuler(_e);
    if (typeof scale === "number") _s.set(scale, scale, scale);
    else if (scale) _s.set(scale[0], scale[1], scale[2]);
    else _s.set(1, 1, 1);
    _m.compose(_p, _q, _s);
    geo.applyMatrix4(_m);

    if (import.meta.env.DEV && part.tint !== undefined) devColours.add(part.tint);

    if (tinted) {
      // Every clone needs the attribute or `mergeGeometries` refuses the set; an untinted
      // part gets white, which is the identity multiply.
      if (part.tint === undefined) _tint.setRGB(1, 1, 1);
      else _tint.set(part.tint);
      const count = geo.getAttribute("position").count;
      const albedo = new Float32Array(count * 3);
      for (let v = 0; v < albedo.length; v += 3) {
        albedo[v] = _tint.r;
        albedo[v + 1] = _tint.g;
        albedo[v + 2] = _tint.b;
      }
      geo.setAttribute(ALBEDO_ATTRIBUTE, vertexAlbedoAttribute(albedo));
    }
    clones.push(geo);
  }

  const merged = mergeGeometries(clones, false);
  for (let i = 0; i < clones.length; i++) clones[i].dispose();
  if (!merged) throw new Error("[spot] assemble(): geometries did not share an attribute set");
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  return merged;
}

function mesh(
  geo: BufferGeometry,
  material: Material,
  x: number,
  y: number,
  z: number,
  opts?: { cast?: boolean; receive?: boolean; rot?: [number, number, number] }
): Mesh {
  const m = new Mesh(geo, material);
  m.position.set(x, y, z);
  if (opts?.rot) m.rotation.set(opts.rot[0], opts.rot[1], opts.rot[2]);
  m.castShadow = opts?.cast ?? false;
  m.receiveShadow = opts?.receive ?? false;
  return m;
}

/**
 * A five-pointed star with no point on it.
 *
 * A star drawn `lineTo` by `lineTo` has five cusps and five sharp valleys, and no amount of
 * bevel makes those legal (3D-SPEC §3: there is no hard edge anywhere in this product). So
 * the outline is polar and everywhere smooth — `r(t) = rMin + (rMax - rMin) * k^SHARPNESS`
 * with `k = (cos 5t + 1) / 2`. The exponent is what turns a five-lobed flower into a star:
 * above 1 it narrows the tips and widens the valleys, while keeping a zero derivative at
 * both extremes, so every turn is a curve.
 */
const STAR_SHARPNESS = 2.2;

function starShape(outer: number, inner: number, samples = 60): Shape {
  const shape = new Shape();
  for (let i = 0; i < samples; i++) {
    const a = (i / samples) * Math.PI * 2;
    const k = (Math.cos(5 * a) + 1) / 2;
    const r = inner + (outer - inner) * Math.pow(k, STAR_SHARPNESS);
    const x = Math.cos(a + Math.PI / 2) * r;
    const y = Math.sin(a + Math.PI / 2) * r;
    if (i === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  }
  shape.closePath();
  return shape;
}

/* ------------------------------------------------------------------ */
/* Dev audit: the room's colours against the registry                  */
/* ------------------------------------------------------------------ */

/**
 * **Round 4's A15, for this game — and one measured correction to it.**
 *
 * A15 classified every saturated pixel (`C* > 25`) of each play area to its nearest accent
 * family and found four scenes contradicting their own registry entry. For this one it read
 * "registered `rose` at 23.3 % against a dominant peach at 40.9". I reproduced that from the
 * shipped capture — panel A of `spot-the-difference-f00.png` measures peach 55.3 %, **red
 * 33.5 %**, coral 6.8, rose 2.4, mauve 2.0 — and then found that the diagnosis behind it does
 * not survive contact with the classifier:
 *
 *  - **The hero was never a hard-coded wrong hex.** The mirror frame — the largest accent
 *    surface in the room — has been `ACCENTS.rose.main` all along, and it is the 33.5 % that
 *    is filed under *red*. Sampled on the shipped frame it renders at `h 28.1–28.6°` against
 *    its own token's `h 22.9°`: a **+5.5° rotation toward orange**, which is precisely the
 *    tone-map defect A16 measured project-wide (`dh +4…+5°`) and removed this round by
 *    dropping `NeutralToneMapping`'s black-point offset. With that gone the frame should land
 *    back near `h 23–24°` and the 33.5 % should read as rose.
 *  - **`classifyAccent` cannot separate rose from red anyway.** Its fifteen tone hues
 *    interleave: `rose.soft 11.75°` sits **0.45°** from `red.soft 12.20°`, and
 *    `rose.deep 24.48°` sits **2.60°** from `red.main 27.08°`. A nearest-hue vote across a
 *    gap that small is decided by the render's own noise, so a *dominance* assertion between
 *    those two families is not a measurement — which is why nothing here errors on one.
 *
 * What this does assert instead is the thing that is decidable and that would have caught the
 * real drift in this file: **every colour the scene paints with must be a brand token** — one
 * of the fifteen `ACCENTS` tones, a `NEUTRAL`, a `CLAY` body, or white. That is the check that
 * fails on `#e9eef3` and `#dce7f0`, the two bespoke cool hexes SD8 found, and it cannot be
 * satisfied by accident. It is deliberately *not* filtered by chroma; see the function body
 * for the injected-defect run that proves why.
 *
 * The family histogram is reported next to it, so a future round has the number without this
 * function pretending it can adjudicate rose against red.
 */
function auditSceneColours(root: Group): void {
  if (!import.meta.env.DEV) return;
  /*
   * The sanctioned set, built from the token files rather than typed out: the five accent
   * families, the neutrals, the clay bodies, and pure white — which is not a colour choice but
   * the identity element for `aAlbedo`, the value `clayPainted("#ffffff")` carries so a merged
   * geometry's per-vertex tint multiplies through unchanged.
   *
   * **Chroma is not the filter.** An earlier version of this only judged colours above
   * `ACCENT_CHROMA_FLOOR`, and I checked it by injecting the two hexes SD8 actually found:
   * `#dc4a9f` fired, and **`#e9eef3` did not** — it sits at `C* 3.1`, so a saturation filter
   * calls it a neutral and waves it through. The two bespoke cool hexes this file shipped were
   * both *pale*; a check that can only see saturated drift would have missed the drift it was
   * written for, and would have been the fourth self-check in this codebase looser than the
   * rule it claims to enforce. Every colour is judged.
   */
  const allowed = new Set<string>(["#ffffff"]);
  for (const family of Object.keys(ACCENTS) as (keyof typeof ACCENTS)[]) {
    for (const tone of ["soft", "main", "deep"] as const) {
      allowed.add(ACCENTS[family][tone].toLowerCase());
    }
  }
  for (const hex of Object.values(NEUTRAL)) allowed.add(hex.toLowerCase());
  for (const hex of Object.values(CLAY)) allowed.add(hex.toLowerCase());
  /*
   * One exemption, and it is granted by **provenance rather than by hex**.
   *
   * `clayGround()`'s albedo is `NEUTRAL.page` multiplied by `materials.ts`'s
   * `GROUND_WHITE_BALANCE` — a calibration constant, not a colour choice: it exists so the
   * floor *renders back* to `#EDE7DC` and the canvas melts into the DOM page. It is neither
   * exported nor a token (it currently resolves to `#f0f4f5`, which this check found on its
   * first run and correctly refused). Reading it live off the shared factory means this
   * exemption tracks that calibration instead of pinning a hex that would go stale the next
   * time somebody re-measures the page match — and it exempts exactly one material rather
   * than "anything pale".
   */
  allowed.add(`#${clayGround().color.getHexString()}`.toLowerCase());

  // The materials the scene really built, read off the tree rather than from a hand-kept list
  // that would rot the first time a material moved.
  const used = new Set(devColours);
  root.traverse((object) => {
    const material = (object as Mesh).material;
    if (!material || Array.isArray(material)) return;
    const colour = (material as { color?: Color }).color;
    if (colour) used.add(`#${colour.getHexString()}`);
  });

  const strays: string[] = [];
  const hexes: string[] = [];
  for (const hex of used) {
    const family = classifyAccent(hex);
    if (family !== null) hexes.push(hex);
    if (allowed.has(hex.toLowerCase())) continue;
    strays.push(`${hex}${family === null ? " (a neutral)" : ` (nearest ${family})`}`);
  }
  if (strays.length > 0) {
    console.error(
      `[spot/diorama] ${strays.length} colour(s) in this scene are not brand tokens: ` +
        `${strays.join(", ")}. 3D-SPEC §1.2 allows the five accent families, NEUTRAL and CLAY ` +
        `and nothing else — use accent(GAME_ACCENT, tone) or a NEUTRAL/CLAY token.`
    );
  }
  const report = auditSceneAccents(hexes, GAME_ACCENT);
  const shares = (Object.keys(report.share) as (keyof typeof report.share)[])
    .filter((f) => report.share[f] > 0)
    .map((f) => `${f} ${(report.share[f] * 100).toFixed(0)}%`)
    .join(" · ");
  console.info(
    `[spot/diorama] ${used.size} colours, ${used.size - strays.length} of them brand tokens. ` +
      `Accent census over ` +
      `${report.saturated} saturated ones: ${shares}. Registry says ${GAME_ACCENT}; the hero ` +
      `(the mirror frame) is accent(${GAME_ACCENT}, "main") by construction. Dominance is ` +
      `reported, not asserted — rose and red tone hues are 0.45–2.60° apart and a nearest-hue ` +
      `vote cannot tell them apart. See this function's note.`
  );
}

/* ------------------------------------------------------------------ */
/* The "found" badge                                                   */
/* ------------------------------------------------------------------ */

/**
 * The reward mark, built once at unit radius: a bevelled clay medallion with a raised tick.
 *
 * ## What it replaces, and why a ring could not be repaired in place
 *
 * Round 3's mark was `torusSoft(1, 0.15, 2)` with `depthTest: false`, `renderOrder: 5`,
 * billboarded to the camera every frame. Round 4 measured it and found two separate defects:
 *
 *  - **It could not shade.** A billboarded torus points its tube *crest* at the camera at
 *    every ring angle, so the whole visible band shares one normal. The audit read
 *    (189–191, 39–41, 46–48) at all twelve angles at r = 110 px — lit side and shadow side
 *    indistinguishable, in a scene keyed at intensity 2.6 from the upper left — with the
 *    flanks collapsing 190 → 64–85 over ~3 px, which is a hard dark contour, not a bevel.
 *  - **It covered the reward.** Drawn *over* the prop at 0.40–0.82 world radius, it hid most
 *    of the towel; at 3/3 three of them obliterated the duck, the towel and the entire
 *    shelf-and-window corner of both pictures. That is the money shot of this game.
 *
 * And a third, from SD3: it spoke the same visual language as the *focus* ring — both
 * billboarded annuli, dark ink contour, pale halo, comparable radius — so a keyboard player
 * could not tell "my cursor is here" from "I already found this" exactly when the board is
 * half solved. Since round 4 the shared focus ring (`hit.tsx`, A1) is *also* a lit clay rope,
 * so making this one a lit clay rope too would have made them harder to tell apart, not
 * easier. **The ring silhouette is now reserved for focus, and found is a filled badge.**
 *
 * ## Why this shades and the torus did not
 *
 * The disc's rolled rim sweeps its normal through the full circle of directions lying in the
 * badge's own plane. The key arrives from `(-0.4262, 0.7458, 0.5327)`; with the badge facing
 * the camera axis `(0.1038, 0.1219, 0.9867)` the in-plane component of the key has magnitude
 * **0.833**, so `N·L` on the outer rim runs from +0.833 at the upper left to −0.833 (clamped
 * to 0) at the lower right — a full bright-to-dark crescent. The torus it replaces held a
 * constant `N·L` of 0.572 all the way round, which is the flat band the audit photographed.
 * The raised tick's own bevel does the same thing again at a smaller scale, and the two
 * together are what makes it read as pressed clay rather than as a printed sticker.
 *
 * It is depth-tested like every other solid in the room (see `MARK_Z`), it is drawn by the
 * same key with the same tone map, and the instance matrix that places it is a translation
 * and a uniform scale — no per-frame quaternion, because `BADGE_ROT` bakes the facing in.
 */
const BADGE_DISC_T = 0.34;
const BADGE_DISC_EDGE = 0.15;
/**
 * The badge is **two tones, and that is what lets it land anywhere in the room.**
 *
 * `rose.deep` reads beautifully on almost every ground here — 5.64:1 on the wall, 4.94:1 on
 * the floor, 4.61:1 on the cabinet, 4.45:1 on the tiles, 2.88:1 on the duck and towel A — and
 * catastrophically on exactly one: the **mirror frame**, which is `rose.main`, where it is
 * **1.38:1 (ΔE76 9.1)**. That is not hypothetical; the star's badge is placed beside the stars
 * and the stars are stuck on the mirror, so roughly a third of that badge lands on the frame.
 *
 * Placing the badge somewhere else would fix the star and leave the next prop that moves to
 * find the same hole. Two tones fix it by construction, and it is the same argument round 4's
 * A20 made for the shared focus ring: one accent cannot clear 3:1 against a whole palette, but
 * a light/dark **pair** can, because between them they cover both halves of the luminance
 * range. Here the chip is `CLAY.enamel` and its face is `accent(GAME_ACCENT, "deep")`:
 *
 *   on the cream wall — enamel is 1.03:1 (invisible) and the rose face is **5.64:1**
 *   on the rose mirror frame — the rose face is 1.38:1 and the enamel chip is **4.23:1**
 *
 * Whichever tone the ground swallows, the other one draws the silhouette. The white tick on
 * the rose face is 5.83:1, the same pairing the DOM progress pill uses for the same tick.
 *
 * `BADGE_FACE_R` 0.82 leaves an enamel rim 0.18 of the radius wide — 3.0 CSS px on the phone's
 * panel, 4.1 on the desktop's, 7.2 at the width cap `solvePanels` is asking for — and still
 * clears the tick, whose furthest point (including its bevel) reaches 0.741.
 */
const BADGE_FACE_R = 0.82;
/** Half-width of the tick's centre stroke *before* the extrude bevel widens it by `bevel`. */
const BADGE_TICK_W = 0.14;
const BADGE_TICK_DEPTH = 0.1;
const BADGE_TICK_BEVEL = 0.045;
/**
 * Radius of the arc that replaces the tick's corner.
 *
 * **Strictly greater than `BADGE_TICK_W`, and that is a §3 requirement rather than a taste.**
 * The inner side of a swept stroke is the centre-line offset *inward*, so its radius is
 * `R − w`: at `R = w` the two inner flanks meet in a cusp and at `R < w` they cross. A
 * chevron drawn `lineTo` by `lineTo` — which is what a tick normally is — has `R = 0` and
 * therefore a sharp reflex notch in its silhouette, i.e. a hard edge, on the mark a child
 * looks at at the happiest moment in the game.
 *
 * The number is set by what that radius is worth *in pixels*, not by it merely being positive.
 * `0.26 − 0.14` = **0.12 badge-radii**, which is 4.9 px at the largest badge this game can
 * produce (81.6 px across at the 1400 px width cap) and 2.0 px on the phone's 33 px badge. An
 * earlier 0.2 left 0.06, i.e. 1.0 px on the phone — arithmetically an arc and visually a
 * corner. `three`'s `ExtrudeGeometry` insets its bevel rings *toward* the shape, so this is the
 * tightest cross-section of the solid: the two bevelled faces round it further, to 0.165.
 *
 * The corner eats `R · tan(θ/2)` = 0.279 off each leg of a 94.1° turn, against legs 0.446 and
 * 0.885 long, so both survive it.
 */
const BADGE_TICK_CORNER = 0.26;
/** How far each layer sinks into the one under it, so the solids meet with no gap. */
const BADGE_TICK_SINK = 0.06;
/** Centre-line of the tick, in badge-local units (the disc has radius 1). */
const BADGE_TICK_PATH: readonly (readonly [number, number])[] = [
  [-0.42, 0.02],
  [-0.13, -0.28],
  [0.44, 0.34],
];

/**
 * The closed outline of a stroke swept along `path`, with round caps and a rounded corner.
 *
 * Built analytically rather than sampled from a distance field: the centre-line is
 * (segment, arc, segment) and the boundary is that curve offset by `half` to the left,
 * a cap, the same curve offset to the right, and a second cap. Every join is an arc, so the
 * silhouette has no corner anywhere — including the *inner* one, which is the one a naive
 * offset gets wrong (see `BADGE_TICK_CORNER`).
 *
 * The two sample counts are derived against the biggest badge this game can produce — 81.6 px
 * across at the 1400 px width cap `solvePanels` is asking for, i.e. a 40.8 px radius. The end
 * cap is a half-circle of `BADGE_TICK_W + bevel` = 0.185 badge-radii = **7.5 px**, so six steps
 * across 180° leave a sagitta of `7.5 · (1 − cos 30°)` = **0.25 px**; the corner arc is
 * `BADGE_TICK_CORNER` = 8.2 px over 94°, so eight steps leave **0.04 px**. Both are under the
 * antialiasing floor, and the outline is what this pays for — it is 34 points against the 50 a
 * 12/10 pair costs, on a mesh instanced five times and drawn twice a frame.
 */
function strokeShape(
  path: readonly (readonly [number, number])[],
  half: number,
  corner: number,
  arcSegments = 8,
  capSegments = 6
): Shape {
  const [p0, p1, p2] = path;
  const d1x = p1[0] - p0[0];
  const d1y = p1[1] - p0[1];
  const l1 = Math.hypot(d1x, d1y);
  const u1x = d1x / l1;
  const u1y = d1y / l1;
  const d2x = p2[0] - p1[0];
  const d2y = p2[1] - p1[1];
  const l2 = Math.hypot(d2x, d2y);
  const u2x = d2x / l2;
  const u2y = d2y / l2;

  // Turn angle, and the tangent length the arc eats out of each leg.
  const cross = u1x * u2y - u1y * u2x;
  const turn = Math.atan2(cross, u1x * u2x + u1y * u2y);
  const tangent = corner * Math.tan(Math.abs(turn) / 2);
  const aStart: [number, number] = [p1[0] - u1x * tangent, p1[1] - u1y * tangent];
  // The arc's far tangent point is `p1 + u2 * tangent`; it is not named because the arc's
  // last sample lands on it exactly, and pushing it a second time would leave a duplicate.
  // Arc centre: perpendicular to the first leg, on the side the path turns toward.
  const sign = cross >= 0 ? 1 : -1;
  const cx = aStart[0] - u1y * corner * sign;
  const cy = aStart[1] + u1x * corner * sign;
  const a0 = Math.atan2(aStart[1] - cy, aStart[0] - cx);

  /** The centre-line, densely sampled, with a unit tangent at every sample. */
  const spine: [number, number, number, number][] = [];
  spine.push([p0[0], p0[1], u1x, u1y]);
  spine.push([aStart[0], aStart[1], u1x, u1y]);
  for (let i = 1; i <= arcSegments; i++) {
    const a = a0 + (turn * i) / arcSegments;
    const px = cx + Math.cos(a) * corner;
    const py = cy + Math.sin(a) * corner;
    // Tangent of a circle is the radius turned 90° in the direction of travel.
    spine.push([px, py, -Math.sin(a) * sign, Math.cos(a) * sign]);
  }
  // The arc's last sample *is* `aEnd`, with `u2` as its tangent to within rounding — pushing
  // `aEnd` again here would leave a duplicate vertex, i.e. a zero-length outline segment and a
  // degenerate triangle out of `ExtrudeGeometry`. (Checked: with the duplicate in, the outline
  // reported a spurious 48.4° turn where there is nothing but a straight join.)
  spine.push([p2[0], p2[1], u2x, u2y]);

  const shape = new Shape();
  const move = (x: number, y: number, first: boolean) => {
    if (first) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  };
  // Left side, start to end.
  for (let i = 0; i < spine.length; i++) {
    const [x, y, tx, ty] = spine[i];
    move(x - ty * half, y + tx * half, i === 0);
  }
  // End cap.
  const [ex, ey, etx, ety] = spine[spine.length - 1];
  const endA = Math.atan2(etx, -ety);
  for (let i = 1; i < capSegments; i++) {
    const a = endA - (Math.PI * i) / capSegments;
    move(ex + Math.cos(a) * half, ey + Math.sin(a) * half, false);
  }
  // Right side, end back to start.
  for (let i = spine.length - 1; i >= 0; i--) {
    const [x, y, tx, ty] = spine[i];
    move(x + ty * half, y - tx * half, false);
  }
  // Start cap.
  const [sx, sy, stx, sty] = spine[0];
  const startA = Math.atan2(-stx, sty);
  for (let i = 1; i < capSegments; i++) {
    const a = startA - (Math.PI * i) / capSegments;
    move(sx + Math.cos(a) * half, sy + Math.sin(a) * half, false);
  }
  shape.closePath();
  return shape;
}

/**
 * The badge, at radius 1, facing `BADGE_ROT` with its **back face on `z = 0`**.
 *
 * The z-normalisation at the end is what makes the depth argument in `MARK_Z` hold without a
 * fudge factor: whatever the facing rotation does to the solid, it is then slid forward until
 * its rearmost vertex sits exactly on the plane, so the entire badge is at `z >= 0` and the
 * frontmost thing in the room (the duck's belly, at `z = -0.09`) can never reach it.
 */
function badgeGeometry(): BufferGeometry {
  /*
   * `detail: 1` on both lathes, and it is derived rather than cheap — `3D-SPEC §3` and round
   * 4's A4 are explicit that a shading budget may not decide a silhouette.
   *
   * The *outline* is not what `detail` buys here: `geometry.ts::MIN_SILHOUETTE_SEGMENTS`
   * floors every lathe at 24 segments on every tier, so the circle is a 24-gon whatever this
   * argument says. What `detail` chooses is the number of arc steps across the **rim roll**,
   * 3 against 5. The roll's radius is `BADGE_DISC_EDGE` (0.15) of the badge radius, so on the
   * largest badge this game can produce — 81.6 px across at the 1400 px width cap, i.e. a
   * 40.8 px radius — the roll is 6.1 px and a 3-step quarter-arc has a sagitta of
   * `6.1 · (1 − cos 30°)` = **0.82 px**, under the antialiasing floor A4 derives its own 24
   * from. On the phone's 33 px badge it is 0.33 px. Five steps would be invisible and would
   * cost 480 triangles a lathe on a mesh that is instanced five times and drawn twice a frame.
   */
  const geo = assemble([
    {
      geo: roundedCylinder(1, BADGE_DISC_T, BADGE_DISC_EDGE, 1),
      rot: [Math.PI / 2, 0, 0],
      pos: [0, 0, 0],
      tint: CLAY.enamel,
    },
    {
      geo: roundedCylinder(BADGE_FACE_R, BADGE_DISC_T * 0.62, BADGE_DISC_EDGE * 0.55, 1),
      rot: [Math.PI / 2, 0, 0],
      pos: [0, 0, BADGE_DISC_T / 2 - BADGE_TICK_SINK + BADGE_DISC_T * 0.31],
      tint: accent(GAME_ACCENT, "deep"),
    },
    {
      geo: beveledExtrude(strokeShape(BADGE_TICK_PATH, BADGE_TICK_W, BADGE_TICK_CORNER), {
        depth: BADGE_TICK_DEPTH,
        bevel: BADGE_TICK_BEVEL,
      }),
      pos: [
        0,
        0,
        BADGE_DISC_T / 2 -
          BADGE_TICK_SINK +
          BADGE_DISC_T * 0.62 -
          BADGE_TICK_SINK +
          (BADGE_TICK_DEPTH + 2 * BADGE_TICK_BEVEL) / 2,
      ],
      tint: CLAY.enamel,
    },
  ]);
  _e.set(BADGE_ROT[0], BADGE_ROT[1], BADGE_ROT[2]);
  _q.setFromEuler(_e);
  _m.makeRotationFromQuaternion(_q);
  geo.applyMatrix4(_m);
  geo.computeBoundingBox();
  const back = geo.boundingBox ? geo.boundingBox.min.z : 0;
  geo.translate(0, 0, -back);
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

/* ------------------------------------------------------------------ */
/* Cloth                                                               */
/* ------------------------------------------------------------------ */

/**
 * A hanging strip of cloth, described as a centre curve with a varying thickness — and then
 * folded across its own width, which is the half the round-3 build was missing.
 *
 * Round 2 shipped the towel as `roundedBox(0.62, 0.6, 0.13) + roundedBox(0.6, 0.11, 0.17)`
 * — two plastic slabs, on the prop a child is second-most likely to tap, two props from a
 * duck that is genuinely well made. Round 3 replaced that with the swept section below, and
 * the audit still photographed a flat orange slab with a rectangular appliqué stuck on it.
 * Both halves of that verdict were right, and neither was a shading problem:
 *
 *  - **The section was invisible.** `AZIMUTH` is 6° and `ELEVATION` is 7°, so this camera
 *    looks very nearly straight down the +Z axis — and every millimetre of drape, belly and
 *    lip roll in a `ClothProfile` lives in the (z, y) plane. A prism swept along its width
 *    has one constant cross-section, so its front face is one near-constant normal: the
 *    profile was edge-on to the lens and could not shade. Cloth reads because it *ripples
 *    across* the hang, and there was no variation along the width at all.
 *  - **The fold was a separate solid.** `TOWEL_FOLD` was a second sweep intersecting the
 *    first, so it met the front face along a hard boolean seam with four crisp corners —
 *    which is exactly what an appliqué decal looks like, because it is one.
 *
 * So there are now two changes, and they are the two things the render actually lacked:
 *
 *  1. **The fold is part of the same curve.** The path runs back hem → up the back → around
 *     the rail on a real arc → down the front → and stops *short*, at a fat rolled selvedge,
 *     with the back panel hanging 0.258 units lower behind it. That is how a towel thrown over
 *     a rail actually reads from the front: one layer ending in a lit roll, a second layer
 *     visible below it in its shadow. One continuous surface, no seam, no boolean — and no
 *     extra depth, which matters because the towel clears the cabinet behind it by 0.012 units
 *     and the picture plane in front of it by 0.092. A hem curled forward over the front face
 *     was the first thing tried and it does not fit: a 0.072-thick cloth needs a bend diameter
 *     past 0.144 to keep a non-degenerate inner surface, which puts the returning flap through
 *     `z = 0` and out of the picture.
 *  2. **`drapeFolds()` — undulation across the width.** A smooth ±`FOLD_AMPLITUDE` shear in
 *     z, so the front face turns toward and away from the key as it crosses the towel. The
 *     amplitude is *derived from the normal swing it has to produce*, not chosen — see
 *     `FOLD_AMPLITUDE`.
 *
 * The three things that made the section right in the first place all still hold:
 *
 *  - **drape** — the centre curve bows outward through the belly of the hang;
 *  - **a lip roll** — the half-thickness grows by half again at the front hem, so the fold
 *    edge is a rolled selvedge that catches the key, which is what stops cloth reading as
 *    card;
 *  - **asymmetry** — the front and the back hang to different lengths and belly differently,
 *    because a towel thrown over a rail never hangs even.
 *
 * The outline is the centre curve offset by ±(halfThickness − bevel) with a semicircular
 * cap at each hem, and `beveledExtrude` then rolls the two long side edges as well, so
 * there is no hard edge anywhere on it (3D-SPEC §3).
 */
type ClothProfile = {
  /** Centre curve, back hem → over the rail → front hem, in (z, y) local to the rail. */
  path: readonly (readonly [number, number])[];
  /** Half-thickness at each path point, in world units. Must exceed `bevel`. */
  half: readonly number[];
  /** Width of the towel across the rail, including the rolled side edges. */
  width: number;
};

/**
 * Roll radius on the two long side edges, and the amount the 2D outline is inset by.
 *
 * **These have to be the same number**, and in round 3 they were not: the outline was inset
 * by 0.016 while `beveledExtrude` clamped the roll it actually built up to `MIN_BEVEL`
 * (0.02, `geometry.ts`), so every stated half-thickness came out 0.004 too fat and the side
 * roll was 0.02 — under the 0.03 a hem this size needs to stop reading as a cut edge. 0.032
 * is the roll the corners get, and the profile's thinnest `half` (0.038) is chosen to clear
 * it: `half − CLOTH_BEVEL` must stay above `clothShape`'s 0.004 floor — here it is 0.006 —
 * or the outline collapses onto its own centreline and the solid becomes a tube.
 */
const CLOTH_BEVEL = 0.032;
const CAP_SEGMENTS = 5;

function clothShape(profile: ClothProfile): Shape {
  const path = profile.path;
  const n = path.length;
  const nx: number[] = [];
  const ny: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = path[i > 0 ? i - 1 : 0];
    const b = path[i < n - 1 ? i + 1 : n - 1];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    // Left normal of the travel direction. Travel runs back-hem → crest → front-hem, so
    // this is consistently the outward face on both sides of the fold.
    nx.push(dy / len);
    ny.push(-dx / len);
  }

  const shape = new Shape();
  const at = (i: number, sign: number) => {
    const h = Math.max(0.004, profile.half[i] - CLOTH_BEVEL);
    return [path[i][0] + nx[i] * h * sign, path[i][1] + ny[i] * h * sign] as const;
  };
  /*
   * A semicircle around a hem point — the rolled selvedge.
   *
   * The sweep always runs in the direction of *increasing* angle, which is what puts it on
   * the side away from the cloth at both ends: the normal here is the travel direction
   * rotated −90°, so rotating the normal a further +90° gives the outward tangent at the
   * far hem and the outward tangent at the near hem alike. Sweeping the other way folds the
   * cap back through the body of the towel and the outline self-intersects.
   */
  const cap = (i: number, fromPlusNormal: boolean) => {
    const h = Math.max(0.004, profile.half[i] - CLOTH_BEVEL);
    const base = Math.atan2(ny[i], nx[i]) + (fromPlusNormal ? 0 : Math.PI);
    for (let s = 1; s < CAP_SEGMENTS; s++) {
      const a = base + (s / CAP_SEGMENTS) * Math.PI;
      shape.lineTo(path[i][0] + Math.cos(a) * h, path[i][1] + Math.sin(a) * h);
    }
  };

  const start = at(0, 1);
  shape.moveTo(start[0], start[1]);
  for (let i = 1; i < n; i++) {
    const p = at(i, 1);
    shape.lineTo(p[0], p[1]);
  }
  cap(n - 1, true);
  for (let i = n - 1; i >= 0; i--) {
    const p = at(i, -1);
    shape.lineTo(p[0], p[1]);
  }
  cap(0, false);
  shape.closePath();
  return shape;
}

const clothGeometry = (profile: ClothProfile): BufferGeometry =>
  beveledExtrude(clothShape(profile), {
    depth: Math.max(0.02, profile.width - 2 * CLOTH_BEVEL),
    bevel: CLOTH_BEVEL,
  });

/** Width of the towel across the rail, and the axis `drapeFolds` ripples along. */
const TOWEL_WIDTH = 0.62;
/**
 * Outer radius of the towel rail, from `fixtureGeo`'s `roundedCylinder(0.036, 1.5, 0.03, 2)`.
 *
 * Stated here because the wrap arc below is derived from it: a cloth `h` thick bending over
 * a bar of radius `r` has its *centreline* on radius `r + h`, and any tighter centreline
 * radius drives the inner offset of `clothShape` negative and self-intersects the outline.
 */
const RAIL_RADIUS = 0.036;

/**
 * The towel: one continuous sweep, over the rail and down both sides.
 *
 * Points 4–10 are the wrap: a circular arc of radius **0.084** about the rail's axis, sampled
 * every 30°. That is `RAIL_RADIUS + 0.046 + 0.002` — the largest half-thickness on the arc,
 * plus the 2 mm of daylight `assertClothClearsRail` requires and float arithmetic needs
 * (0.082 − 0.046 evaluates to 0.035999999999999997 at two of the seven points, which is
 * *inside* a rail of radius 0.036, and cloth inside a bar is invisible for exactly the reason
 * the mirror glass was). It also keeps `clothShape`'s inner offset at 0.038 > 0 all the way
 * round. Round 3's path turned the crest in a single 0.058-radius corner with `half = 0.036`,
 * which was still positive but visibly creased; at the half-thicknesses this profile now
 * carries it would have inverted.
 *
 * Depth budget, which is the tightest constraint in the room and is why the fold points
 * *back* rather than standing forward off the front face:
 *   back-most  −0.126 → world −0.386, and the cabinet's front face is at −0.398
 *              (`CABINET_Z + CABINET_D / 2`): 0.012 units of daylight.
 *   front-most  0.168 (the front hem's cap, 0.112 + 0.056) → world −0.092, clear of the
 *              picture plane at z = 0 by 0.092.
 * Height:
 *   front hem lowest  −0.530 − 0.056 = −0.586 → world −1.406
 *   back  hem lowest  −0.800 − 0.044 = −0.844 → world −1.664, and `FLOOR_Y` is −1.840.
 * So 0.258 units of the back layer — about 15 CSS px at the panel size this game ships at —
 * stay visible below the front hem, in the front hem's own shadow. That band *is* the fold.
 *
 * `drapeFolds` then drops the hem by up to a further `FOLD_SAG` (0.035), which takes the back
 * hem to world −1.699 and leaves 0.141 of floor clearance. Every one of these numbers was
 * evaluated against the built outline rather than read off the path, because the extrude
 * re-expands the shape by the bevel and the eye-checked figure is 0.032 short every time.
 * Both hems' extremes are the semicircular caps, not the path points.
 */
const TOWEL_DRAPE: ClothProfile = {
  path: [
    [-0.078, -0.800],
    [-0.086, -0.580],
    [-0.084, -0.360],
    [-0.084, -0.140],
    [-0.084, 0.0],
    [-0.0728, 0.042],
    [-0.042, 0.0728],
    [0.0, 0.084],
    [0.042, 0.0728],
    [0.0728, 0.042],
    [0.084, 0.0],
    [0.096, -0.160],
    [0.114, -0.340],
    [0.120, -0.460],
    [0.112, -0.530],
  ],
  half: [
    0.044, 0.038, 0.038, 0.040, 0.042, 0.044, 0.046, 0.046, 0.046, 0.044, 0.042, 0.040, 0.038,
    0.046, 0.056,
  ],
  width: TOWEL_WIDTH,
};

/**
 * Proves the wrap arc against the rail it is wrapping, the way `assertWellFloor` proves
 * `BACK_Z` against the tray that was actually built.
 *
 * Two failure modes, one check. A path point whose distance from the rail axis is less than
 * `RAIL_RADIUS + half` puts cloth *inside* the bar — invisible from the front, and exactly the
 * class of defect that shipped the mirror glass buried inside its own frame. The same margin
 * is what keeps `clothShape`'s inner offset positive: the inner outline sits at
 * `distance − half`, so a point that clears the rail also cannot self-intersect around the
 * crest. DEV only, once per build, over fifteen points.
 */
function assertClothClearsRail(profile: ClothProfile): void {
  if (!import.meta.env.DEV) return;
  for (let i = 0; i < profile.path.length; i++) {
    const [z, y] = profile.path[i];
    const distance = Math.hypot(z, y);
    // Only the points that actually wrap: a hem 0.8 units below the rail is not near it.
    if (distance > 0.2) continue;
    const inner = distance - profile.half[i];
    if (inner < RAIL_RADIUS - 1e-6) {
      // eslint-disable-next-line no-console
      console.error(
        `[spot] the towel is inside the rail at path point ${i} (${z}, ${y}): its inner ` +
          `surface is ${inner.toFixed(4)} from the rail axis and the rail's radius is ` +
          `${RAIL_RADIUS}. Move the point out to at least ${(RAIL_RADIUS + profile.half[i]).toFixed(4)}.`
      );
      return;
    }
  }
}

/* ---- Folds across the width ---- */

/** Undulations across the towel's 0.62 units — three visible lobes, one of them clipped. */
const FOLD_LOBES = 2.5;
/** Angular frequency of the fold, in radians per world unit. */
const FOLD_K = (2 * Math.PI * FOLD_LOBES) / TOWEL_WIDTH; // 25.34
/**
 * How far the fold tips the front face away from head-on, at its steepest.
 *
 * **This is the number that was derived and the amplitude that follows from it**, not the
 * other way round — the audit's standing complaint about this codebase is a comment that
 * asserts a measurement the render contradicts, and "displace by 4 cm" would have been one.
 * What a child sees is not the displacement, it is the shading, and the shading is set by
 * the *normal*, so the normal swing is what gets picked:
 *
 *   dz/dx = FOLD_AMPLITUDE · FOLD_K · cos(…), so a peak slope of tan(15°) needs
 *   FOLD_AMPLITUDE = tan(15°) / FOLD_K = 0.2679 / 25.34 = 0.01057.
 *
 * What 15° buys, evaluated (not estimated) against `KEY_LIGHT.position` (−4, 7, 5) →
 * normalised (−0.4262, 0.7458, 0.5327) and a front face whose normal is ≈ (0, 0, 1):
 *
 *   tilt −15°  N·L = 0.4046
 *   tilt   0°  N·L = 0.5330
 *   tilt +15°  N·L = 0.6251
 *
 * — a swing of 0.220 on a 0.533 base, so **±20 % of the key term**. `KEY_LIGHT.intensity` is
 * 2.6 and the tokens put the key at roughly 60 % of the light on a surface facing it, which
 * makes it a ±12 % luminance ripple: on `peach.main` #efa160 something like ±18 of 255 per
 * channel, three times over across the towel. The audit's complaint was large surfaces varying
 * by under one unit out of 255. This is a shading feature and not a silhouette one, which is
 * exactly why it survives being drawn at 57 px per world unit.
 */
const FOLD_AMPLITUDE = Math.tan((15 * Math.PI) / 180) / FOLD_K;
/** Offset so a fold crest does not land dead centre on the towel. */
const FOLD_PHASE = 0.7;
/**
 * Hem sag, in phase with the fold: cloth hangs longest where it bellies out.
 *
 * Honest about its size — 0.035 units is ~2 CSS px at the shipping panel. Its job is to stop
 * the hem being a ruler-straight line, which is a thing the eye notices at any size, not to
 * be read as a shape.
 */
const FOLD_SAG = 0.035;
/**
 * The band the fold opens over: nothing at all where the cloth is pinched around the rail
 * (which would push it into the bar), everything by the time it reaches the hem.
 */
const FOLD_TOP = 0.0;
const FOLD_BOTTOM = -0.55;

const smoothstep01 = (t: number): number => {
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return c * c * (3 - 2 * c);
};

/**
 * Ripples an already-built towel across its own width, in place.
 *
 * Runs on the *assembled* geometry, which is safe: `assemble()` clones every cached source
 * before merging, so nothing here can reach the geometry cache. It is a pure function of
 * `(x, y)`, so the two vertices of a welded pair move together and the surface stays closed;
 * and because a whole column at one `(x, y)` translates by one vector, the section is carried
 * along rather than stretched — the cloth *bends*, it does not get thicker in the troughs.
 *
 * Normals and curvature AO are rebuilt afterwards, which is the point of doing it here rather
 * than in the profile: `bakeCurvatureAO` then darkens the fold troughs (peak mean curvature
 * `FOLD_AMPLITUDE · FOLD_K² = 6.7`, i.e. a 0.15-unit radius, well inside the baker's 0.05-unit
 * reference) and lifts the crests, which is the crease shading the flat prism had nothing to
 * offer.
 */
function drapeFolds(geo: BufferGeometry): BufferGeometry {
  const pos = geo.getAttribute("position");
  const span = FOLD_TOP - FOLD_BOTTOM;
  // The attribute API rather than a `Float32Array` cast: this walks a buffer produced by
  // `mergeGeometries`, and a cast that is wrong about the backing type would silently write
  // nonsense into the towel instead of failing. It runs once, at build.
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    const m = smoothstep01((FOLD_TOP - y) / span);
    if (m <= 0) continue;
    const wave = Math.sin(pos.getX(i) * FOLD_K + FOLD_PHASE);
    pos.setY(i, y - FOLD_SAG * m * m * (0.5 + 0.5 * wave));
    pos.setZ(i, pos.getZ(i) + FOLD_AMPLITUDE * m * wave);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  bakeCurvatureAO(geo);
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

/* ------------------------------------------------------------------ */
/* Public shape                                                        */
/* ------------------------------------------------------------------ */

export type DiffNode = {
  /** Visible in panel A, and in *both* panels when this difference is not in this run. */
  a: Object3D;
  /** Visible in panel B, and only while this difference is in play. */
  b: Object3D;
  /** What squashes and pops when the child finds it — chosen so both panels react. */
  pop: Object3D[];
};

export type Diorama = {
  root: Group;
  /** Indexed to match `DIFFS` in `engine.ts`. */
  diffs: DiffNode[];
  badges: InstancedMesh;
  ripples: InstancedMesh;
  /** Props with a barely-there idle bob. Empty under reduced motion. */
  bob: Object3D[];
  bobBase: number[];
  dispose: () => void;
};

/** Instances in the found-badge mesh — one per possible difference. */
export const BADGE_SLOTS = 5;
/** Concentric rings in one "oops" ripple. */
export const RIPPLE_SLOTS = 3;

/* ------------------------------------------------------------------ */
/* The build                                                           */
/* ------------------------------------------------------------------ */

/**
 * Proves `layout.ts`'s `BACK_Z` against the tray that was actually built.
 *
 * `BACK_Z` has to mirror an internal of `buildClayTray`, and round 2 shipped it guessed
 * rather than derived: the wall was assumed to be `rim` (0.26) thick when the builder makes
 * it 0.51, so six props — including one of the five differences — were buried inside solid
 * clay and the game had an unfindable answer. A comment saying "keep these in sync" would
 * not have caught that; a measurement does.
 *
 * The tray is a generalised lathe: the only two vertices on its own axis are the poles it
 * caps with, one at `y = 0` (the underside) and one at `y = floorTop` (the well floor). So
 * the deepest near-axis vertex *is* the number, to within the surface jitter the finishing
 * pass adds. DEV only, and it walks the position buffer once at build time.
 */
function assertWellFloor(tray: BufferGeometry): void {
  if (!import.meta.env.DEV) return;
  const pos = tray.getAttribute("position");
  if (!pos) return;
  const a = pos.array as ArrayLike<number>;
  let measured = -Infinity;
  for (let i = 0; i < a.length; i += 3) {
    if (Math.abs(a[i]) < 0.06 && Math.abs(a[i + 2]) < 0.06 && a[i + 1] > measured) {
      measured = a[i + 1];
    }
  }
  // `finish()` jitters the tray by min(h, w, d) * 0.004 = 0.0068 units along the normal.
  const tolerance = Math.min(ROOM.depth, Math.min(ROOM.w, ROOM.h)) * 0.004 + 1e-4;
  if (measured === -Infinity || Math.abs(measured - TRAY_WELL_FLOOR) > tolerance) {
    // eslint-disable-next-line no-console
    console.error(
      `[spot] BACK_Z is wrong. clayTray's well floor measures ${measured.toFixed(4)}; ` +
        `layout.ts derives ${TRAY_WELL_FLOOR.toFixed(4)}. Every wall prop is now misplaced ` +
        `by ${(measured - TRAY_WELL_FLOOR).toFixed(4)} units — re-derive trayWellFloor() ` +
        `against buildClayTray in src/three/geometry.ts.`
    );
  }
}

export function buildDiorama(): Diorama {
  const root = new Group();
  root.matrixAutoUpdate = true;

  /* ---------------- Materials ---------------- */

  const roomMat = clay("spot-room", { color: NEUTRAL.surface, roughness: 0.8, sheen: 0.16, grain: 0.1 });
  const tileMat = clay("spot-tile", { color: NEUTRAL.well, roughness: 0.86, sheen: 0.1, grain: 0.14 });
  const cabinetMat = clay("spot-cabinet", { color: CLAY.ivoryDeep, roughness: 0.74, sheen: 0.22 });
  const enamelMat = clayEnamel();
  /**
   * Shelf *and* towel rail. One material, therefore one mesh, therefore one draw call and
   * one shadow-pass call per panel instead of two of each — and this scene pays for
   * everything twice. Round 2 gave the rail its own slightly glossier `clay()`; at 0.036
   * units thick, half-hidden behind the towel, nobody was ever going to see the difference
   * between roughness 0.50 and 0.62, and a whole material is a large price for it. The
   * merged value splits the two.
   */
  const fixtureMat = clay("spot-fixture", { color: CLAY.ivoryDeep, roughness: 0.62, sheen: 0.34 });
  // The registry (`src/games/index.ts`) files this game under **rose**, and the hub card a
  // child taps is a rose gradient. Round 2's room had no rose element large enough to
  // answer that: the frame was `rose.soft` (#f2c6cb, 1.4:1 on the cream wall) and it was
  // buried inside the back wall anyway. The mirror frame is the biggest single accent
  // surface in the picture and it sits in the upper-left third, which is where this
  // composition was missing a focal point — so it is where the game's family lives.
  const frameMat = clayPainted(accent(GAME_ACCENT, "main"), { roughness: 0.62 });
  /*
   * The mirror's glass.
   *
   * Two rounds of history, and round 4 closes the second half. Round 3 shipped it 42 %
   * transparent over the solid `rose.main` backing board it is set into, which blends (in
   * linear working space) to `#daa9af` — a pale dusty pink, not a mirror. That was fixed by
   * giving it its own opaque albedo: no transparent pass, no `depthWrite: false`, nothing in
   * this scene that has to sort.
   *
   * What the fix left behind was a **bespoke hex**, `#e9eef3`, at hue 256° in a product whose
   * palette spans 27–95°, and round 4's SD8 is that drift. It is stated as a defect even
   * though the *render* was already inside the palette — measured on the shipped frame the
   * glass reads `L* 84.2, C* 6.0, h 80.1`, i.e. warm, because a matte-ish plate in a warm
   * studio takes the studio's colour and hands most of its own back. That measurement is also
   * the argument for the change being safe: an albedo whose blue does not survive to the
   * framebuffer is not the thing making this panel read as glass.
   *
   * `CLAY.enamel` is the tone `3D-SPEC` names for polished clay and it is what the fix list
   * asked for. The mirror cue moves where it always really was — into the specular channel,
   * where `roughness 0.16` and `envMapIntensity 1.55` let the studio dome (the *cool* half of
   * this warm-key/cool-fill rig) sweep across it. A polished panel against a `roughness 0.8`
   * wall separates by sheen, not by pigment.
   *
   * Measured against the two things that share the frame with it, old → new:
   *   panel on the `rose.main` it is set into — **3.78:1 → 4.23:1**, further past the 3:1 UI
   *   floor. The panel is bordered by 0.14 units of that rose on all four sides, so this is
   *   the ratio a child's eye actually gets, and it is what turns "red board" into "framed
   *   mirror".
   *   the peach stars stuck on it — **1.81:1 → 2.03:1** on luminance, while ΔE76 goes the
   *   other way, **57.5 → 53.8**. That trade is recorded rather than hidden: 12 % more
   *   luminance ratio for 6 % less colour difference, on a figure that is also a raised
   *   bevelled solid with its own cast shadow on the panel. Both directions of the number are
   *   here because the previous version of this comment argued the opposite trade.
   *   the window's sky is now `CLAY.enamel` too, so the two bright panels at either end of the
   *   room finally agree. They are never adjacent — the mirror is ringed in rose, the window in
   *   `CLAY.ivoryDeep` — so they are told apart by frame and position, which is what a
   *   four-year-old uses.
   */
  const glassMat = clayPainted(CLAY.enamel, {
    roughness: 0.16,
    sheen: 0.16,
    grain: 0.05,
    envMapIntensity: 1.55,
  });
  const starMat = clayPainted(ACCENTS.peach.main, { roughness: 0.58 });
  /*
   * The towel pair.
   *
   * `grain: 0.22` was outside §3's 0.08–0.15 band — it was carrying the whole burden of
   * making a constant-normal prism look like cloth, and all it produced was the diagonal
   * streaking the audit measured. The folds are geometry now (`drapeFolds`), so the grain
   * goes back inside the band and does the job it is actually for.
   */
  const towelAMat = clayPainted(ACCENTS.peach.main, { roughness: 0.88, sheen: 0.55, grain: 0.12 });
  const towelBMat = clayPainted(accent(GAME_ACCENT, "main"), {
    roughness: 0.88,
    sheen: 0.55,
    grain: 0.12,
  });
  /*
   * The window, and **the one surface in this product that was not warm** — round 4's SD8.
   *
   * The audit measured the sky pane at `#d7d9d5`: `C* 2.0, hue 127°`, in a palette whose hues
   * span 27–95° and a room whose every other surface measures `C* 6–17.6` at `h 75–80`. I
   * reproduced it at `(216, 217, 214)` — `C* 1.6, h 123°` — and found the mechanism, which is
   * more specific than "a cool hex".
   *
   * The pane was `STUDIO.rim.color` (`#dce7f0`) as *both* albedo and **emissive**. Two things
   * are wrong with that and the second is the one that mattered:
   *
   *  - `STUDIO.rim.color` is a **light** token. It describes the cool rim strip that separates
   *    silhouettes from the cream page; using it as a surface colour imports a lighting
   *    decision into the art direction, and nothing downstream can tell the two apart.
   *  - An **emissive term pins a surface's hue against the studio.** Every other cool albedo
   *    in this room is dragged warm by the key and the bounce — that is exactly why the mirror
   *    glass rendered at `h 80` despite being authored at `h 256`. Emission is added after
   *    shading and is not multiplied by any light, so this one pane kept its own colour while
   *    the room kept the studio's. It was the only surface that *could* stay cool.
   *
   * Both halves are now palette tokens. The pane is `CLAY.enamel` — the brightest tone in the
   * product, and the tone the fix list named — lit and emitting the same, so a window reads as
   * *brighter than the room*, which is the right direction for daylight and the opposite of
   * what shipped (the old pane rendered `L* 86.2` against a wall at `L* 86.5`).
   *
   * The frame moves off `NEUTRAL.surface` at the same time, and for a reason of its own: the
   * wall behind it is also `NEUTRAL.surface`, so the mullions had no tonal separation from
   * anything and were carried entirely by their cast shadow. `CLAY.ivoryDeep` against the
   * enamel pane is **1.26:1**, up from the old pair's 1.16:1, and against the wall it is a
   * frame that can be seen with the lights on.
   *
   * `emissiveIntensity` drops 0.14 → 0.10 because the tone it multiplies is brighter: the
   * pane's job is to look like daylight, not to reach the tone-map shoulder and go chalk,
   * which `STUDIO`'s own calibration note warns about for ivory.
   */
  const windowMat = clay("spot-window", { color: CLAY.ivoryDeep, roughness: 0.66, sheen: 0.24 });
  const skyMat = clayPainted(CLAY.enamel, {
    roughness: 0.4,
    sheen: 0.18,
    emissive: CLAY.enamel,
    emissiveIntensity: 0.1,
  });
  const tintedMat = clayPainted("#ffffff", { roughness: 0.55, sheen: 0.36 });
  const rubberMat = clayRubber("#ffffff");

  /*
   * The found badge and the "oops" ripple.
   *
   * Both answer something the child just did, and both used to be drawn *through* the picture
   * — `depthTest: false` plus a `renderOrder` above every prop. That flag is gone from this
   * file entirely. Round 2's problem was real (a mark at the prop's own depth is sliced open
   * by the wall behind it: ring #4 rendered as a large "C" with a chunk missing, and the towel
   * ring passed behind the counter) but disabling the depth test answered it by making the
   * mark stop being an object. `MARK_Z` answers it geometrically instead — both marks are slid
   * along the camera ray onto the plane of the box's front rim, which is in front of every
   * prop in the room — so they cannot intersect anything and can be lit, depth-tested clay.
   *
   * Colours are chosen against the props, not from a palette:
   *  - the badge is `rose.deep` through `accent(GAME_ACCENT, ...)`, so it is whatever the
   *    registry says this game is. No prop in the room uses it, and it measures 4.9:1 on the
   *    cream wall. Round 2's `peach.main` was the exact colour of the duck and of towel A.
   *  - its tick is `CLAY.enamel`, which is 6.1:1 on that rose — the same pairing the DOM
   *    progress pill uses for the same tick, so the 3D reward and the HUD agree.
   *  - the ripple was `mauve.soft` `#efdfda` on a `#f3e5d2` wall: **1.05:1**, invisible.
   *    `mauve.main` is the tone the fix list names.
   */
  const badgeMat = clayPainted("#ffffff", {
    roughness: 0.46,
    sheen: 0.44,
    grain: 0.1,
  });
  const rippleMat = clay("spot-ripple", {
    color: ACCENTS.mauve.main,
    roughness: 0.66,
    sheen: 0.3,
    grain: 0.1,
  });

  /* ---------------- Backdrop ---------------- */

  /**
   * The surround: a table the box stands on, and a cyclorama sweeping up behind it.
   *
   * Three things are load-bearing here, and all three are round-2 defects.
   *
   * **1. The game owns the surround; `Rig`'s ground is switched off.** (`scene.tsx` passes
   * `ground={false}`.) The room shell deliberately casts no shadow — a shoebox lit from the
   * front-upper-left would throw its own rim across the upper 45% of its back wall, which
   * is exactly where the mirror and the window live. But a shell that does not cast is a
   * shell light passes *through*: every wall prop's shadow escaped the box and landed on
   * the rig's table outside it. Measured on the shipped build, that is the "stray
   * neutral-grey bars" — three hairlines of `#8a877b` (L\* 56, in a product with no neutral
   * grey in it) running off the right edge of both pictures, which are the window mullions'
   * and the shelf's shadows thrown through a wall.
   *
   * The arithmetic says every escaping shadow lands at `z < -1.68` and `|x| > 3.1` — behind
   * and beside the box, never in front of it — so there is nothing outside the box that
   * *should* be catching a shadow. `receiveShadow: false` on both surround surfaces removes
   * the receiver instead of removing the caster, and the room's own shadows (which land on
   * the box floor, the tiles, the counter and the shelf) are untouched.
   *
   * **2. The table is the colour calibration anchor and is left alone.** Same
   * `clayGround()` material, same up-facing normal, same `GROUND_Y` as the rig's own
   * ground, so it still renders back at ≈ `#ECE6DA` — dE2000 0.5 from `NEUTRAL.page` — and
   * the canvas still melts into the page.
   *
   * **3. The cyclorama is tilted 19°, which is not a taste number.** Standing it vertical
   * gave it `N·L = 0.527` against the table's `0.738`, and the two creams measured
   * `#e1dacd` above the horizon and `#ece6da` below it: a visible seam across every
   * picture, and the upper cream 4 dE off the brand page. Leaning the sweep back by
   * `asin`-solving `0.7379·sin θ + 0.5270·cos θ = 0.7379` gives **θ = 18.94°**, at which the
   * key term on the sweep equals the key term on the table exactly and the seam has nothing
   * left to show. Its lower edge passes through `y = GROUND_Y` at `z ≈ -7.4`, well behind
   * the box, so the junction itself is hidden by the box for every ray but the extreme
   * edges of frame.
   */
  const COVE_TILT = -18.94 * (Math.PI / 180);
  // Table and sweep in one mesh. They share `clayGround()`, neither moves, neither casts and
  // neither receives, so two draw calls were buying nothing — and this scene pays each of
  // them twice a frame. The plates are authored at the origin and placed by `assemble`, so
  // their planar UVs (and therefore the grain) are byte-identical to the separate version.
  const surroundGeo = assemble([
    { geo: roundedPlate(30, 30, 1.2, 4, 1), pos: [0, GROUND_Y - 0.6, -2], rot: [-Math.PI / 2, 0, 0] },
    { geo: roundedPlate(36, 22, 1.2, 4, 1), pos: [0, 3.0, -9.2], rot: [COVE_TILT, 0, 0] },
  ]);
  root.add(mesh(surroundGeo, clayGround(), 0, 0, 0));

  /* ---------------- The box ---------------- */

  // `clayTray` opens along +Y; a quarter turn about X points the well at the camera and
  // turns the tray's rolled rim into the diorama's picture frame. One draw call for the
  // back wall, all four side walls and the frame.
  const trayGeo = clayTray(ROOM.w, ROOM.h, ROOM.depth, ROOM.rim, 2);
  assertWellFloor(trayGeo);
  const box = mesh(trayGeo, roomMat, 0, 0, -ROOM.depth, {
    receive: true,
    rot: [Math.PI / 2, 0, 0],
  });
  root.add(box);

  const tiles = mesh(
    roundedPlate(5.5, TILE_DEPTH, 0.06, 0.16, 2),
    tileMat,
    0,
    FLOOR_Y + 0.031,
    TILE_Z,
    { receive: true, rot: [-Math.PI / 2, 0, 0] }
  );
  root.add(tiles);

  /* ---------------- Vanity: cabinet, counter, basin, tap ---------------- */

  root.add(
    mesh(roundedBox(2.5, 1.14, CABINET_D, 0.11), cabinetMat, -1.35, FLOOR_Y + 0.57, CABINET_Z, {
      cast: true,
      receive: true,
    })
  );

  // `BASIN_SQUASH` on Z only: a lathed bowl is round in plan and would overhang the counter
  // it stands on now the room's real depth is known. An oval basin is also just what a
  // vanity basin is.
  const K = BASIN_SQUASH;
  const basinGeo = assemble([
    {
      geo: latheProfile([
        [0.0, 0.0],
        [0.26, 0.0],
        [0.3, 0.05],
        [0.44, 0.2],
        [0.52, 0.36],
        [0.5, 0.4],
        [0.44, 0.34],
        [0.26, 0.14],
        [0.08, 0.09],
        [0.0, 0.08],
      ], 22),
      scale: [1, 1, K],
    },
    { geo: roundedCylinder(0.075, 0.48, 0.03, 1), pos: [0, 0.24, -0.42 * K], scale: [1, 1, K] },
    { geo: softCapsule(0.055, 0.26, 1), pos: [0, 0.46, -0.3 * K], rot: [1.2, 0, 0] },
    { geo: softSphere(0.062, 1), pos: [0, 0.5, -0.42 * K] },
  ]);

  /*
   * Counter and basin are one mesh — same `clayEnamel()`, both static, both casting and both
   * receiving. Merging saves a shaded draw call *and* a shadow-pass call per panel, which is
   * four per frame here.
   *
   * The pivot is the counter's, and the basin's offset is its old world position minus that,
   * stated in terms of the same constants so the two can never drift apart. `BASIN_Z` is
   * `COUNTER_Z` by definition, hence no Z term.
   */
  const vanityTopGeo = assemble([
    { geo: roundedPlate(2.9, COUNTER_D, 0.14, 0.1, 2), rot: [-Math.PI / 2, 0, 0] },
    { geo: basinGeo, pos: [-1.62 + 1.35, COUNTER_Y - (COUNTER_Y - 0.07), BASIN_Z - COUNTER_Z] },
  ]);
  basinGeo.dispose();
  root.add(
    mesh(vanityTopGeo, enamelMat, -1.35, COUNTER_Y - 0.07, COUNTER_Z, {
      cast: true,
      receive: true,
    })
  );

  /* ---------------- Mirror and its stars ---------------- */

  root.add(
    mesh(roundedPlate(1.62, 1.72, 0.11, 0.24), frameMat, -1.42, 0.76, MIRROR_Z, { cast: true })
  );
  /*
   * The glass. It has always been here; until now not one pixel of it was ever drawn.
   *
   * Both plates were flush against the back wall, so this 0.07-thick panel sat wholly inside
   * the 0.11-thick frame — and the frame is a solid `roundedPlate`, not a ring. `layout.ts`
   * carries the arithmetic and the fix: the glass is seated into the frame's *front* face
   * instead, standing 0.05 proud, with the rose showing as a 0.14-unit border all round.
   * That is the whole of B5.6: the prop a screen-reader child is told is a "Mirror" now
   * looks like one, and the three stars are stuck to glass rather than floating on a plaque.
   */
  root.add(mesh(roundedPlate(1.34, 1.44, 0.07, 0.18, 2), glassMat, -1.42, 0.76, MIRROR_GLASS_Z));

  const starGeo = beveledExtrude(starShape(0.21, 0.075), { depth: 0.05, bevel: 0.022 });
  // Three separate meshes, deliberately not merged. Merging the two fixed stars would save
  // two draw calls a frame, but all three stars squash together when the difference is
  // found, and a merged pair scales about the pivot *between* them: at the pop's 1.24 peak
  // the volume-preserving squash would slide them 0.085 units — about 7 px — toward each
  // other, on the exact prop the child is being congratulated for spotting.
  const star1 = mesh(starGeo, starMat, -1.85, 1.28, STAR_Z, { rot: [0, 0, 0.2] });
  const star2 = mesh(starGeo, starMat, -1.02, 1.14, STAR_Z, { rot: [0, 0, -0.35] });
  // The difference: panel B gets a third star low on the glass.
  const starExtra = mesh(starGeo, starMat, -1.72, 0.34, STAR_Z, { rot: [0, 0, 0.55] });
  root.add(star1, star2, starExtra);

  /* ---------------- Ivory fixtures: the shelf and the towel rail ---------------- */

  /*
   * Two props at opposite ends of the room in one mesh, which looks odd written down and is
   * the right call here: they are the same material, neither ever moves, neither is a
   * difference, and both are on screen in every frame of every run — so there is nothing a
   * second draw call could buy. It buys two, in fact: this scene renders twice a frame.
   *
   * The rail picks up `castShadow` in the bargain (the shelf already had it). That is a gain
   * rather than a cost: a rail an inch off the cabinet door ought to draw a line on it, and
   * the rail's shadow is identical in both panels, so it cannot leak into the pixel test.
   * Offsets are the rail's old world position minus the shelf's, stated once.
   */
  const fixtureGeo = assemble([
    { geo: roundedPlate(2.0, 0.5, 0.12, 0.08, 2), rot: [-Math.PI / 2, 0, 0] },
    {
      geo: roundedCylinder(0.036, 1.5, 0.03, 2),
      pos: [-1.35 - 1.72, -0.82 - (SHELF_Y - 0.06), RAIL_Z - SHELF_Z],
      rot: [0, 0, Math.PI / 2],
    },
  ]);
  root.add(
    mesh(fixtureGeo, fixtureMat, 1.72, SHELF_Y - 0.06, SHELF_Z, { cast: true, receive: true })
  );

  const soapGeo = assemble([
    {
      geo: latheProfile([
        [0.0, 0.0],
        [0.155, 0.0],
        [0.175, 0.05],
        [0.17, 0.33],
        [0.115, 0.42],
        [0.075, 0.5],
        [0.0, 0.5],
      ], 18),
      tint: ACCENTS.coral.soft,
    },
    { geo: roundedCylinder(0.062, 0.09, 0.025, 1), pos: [0, 0.545, 0], tint: ACCENTS.coral.deep },
    { geo: roundedCylinder(0.032, 0.13, 0.015, 1), pos: [0, 0.63, 0], tint: ACCENTS.coral.deep },
    {
      geo: softCapsule(0.032, 0.09, 1),
      pos: [0.06, 0.67, 0],
      rot: [0, 0, 1.35],
      tint: ACCENTS.coral.deep,
    },
  ]);
  const soapA = mesh(soapGeo, tintedMat, 1.02, SHELF_Y, SHELF_Z, { cast: true });
  const soapB = mesh(soapGeo, tintedMat, 2.38, SHELF_Y, SHELF_Z, { cast: true });
  root.add(soapA, soapB);

  /* ---------------- Cup and toothbrushes ---------------- */

  const cupGeo = latheProfile([
    [0.0, 0.0],
    [0.185, 0.0],
    [0.2, 0.05],
    [0.195, 0.3],
    [0.185, 0.34],
    [0.172, 0.3],
    [0.168, 0.06],
    [0.0, 0.05],
  ], 22);

  /**
   * One toothbrush, expressed as parts that can be dropped into a larger assembly at an
   * arbitrary offset and tilt. `at` is relative to whatever pivot the caller is merging
   * around — never to the world — so a merged prop still scales about its own base when
   * the "found" pop squashes it.
   */
  const brushParts = (
    handle: string,
    at: readonly [number, number, number],
    rot: [number, number, number]
  ): Part[] => {
    const parts: { geo: BufferGeometry; pos: [number, number, number]; tint: string }[] = [
      { geo: softCapsule(0.031, 0.4, 1), pos: [0, 0.231, 0], tint: handle },
      { geo: softCapsule(0.024, 0.08, 1), pos: [0, 0.5, 0.006], tint: handle },
      { geo: roundedBox(0.085, 0.15, 0.05, 0.022, 1), pos: [0, 0.585, 0.012], tint: CLAY.ivoryDeep },
      { geo: roundedBox(0.072, 0.105, 0.035, 0.016, 1), pos: [0, 0.6, 0.045], tint: CLAY.enamel },
    ];
    _e.set(rot[0], rot[1], rot[2]);
    _q.setFromEuler(_e);
    return parts.map((p) => {
      _p.set(p.pos[0], p.pos[1], p.pos[2]).applyQuaternion(_q);
      return {
        geo: p.geo,
        tint: p.tint,
        rot,
        pos: [at[0] + _p.x, at[1] + _p.y, at[2] + _p.z] as [number, number, number],
      };
    });
  };

  // The cup and the brush that never moves are one draw call. They are the same prop to a
  // child (one "toothbrush cup" spot, one shared pop), and `aAlbedo` means a mauve cup and
  // a coral handle can now share one white-based material. Two draw calls saved per panel
  // — one shaded, one in the shadow pass — in a scene that draws itself twice.
  const CUP_AT: readonly [number, number, number] = [-0.18, COUNTER_Y, CUP_Z];
  const cupAndBrushGeo = assemble([
    { geo: cupGeo, tint: ACCENTS.mauve.main },
    ...brushParts(ACCENTS.coral.main, [-0.06, 0.02, -0.02], [-0.1, 0, 0.14]),
  ]);
  const cup = mesh(cupAndBrushGeo, tintedMat, CUP_AT[0], CUP_AT[1], CUP_AT[2], {
    cast: true,
    receive: true,
  });
  root.add(cup);

  // The difference: panel B is one toothbrush short.
  const brush2Geo = assemble(brushParts(ACCENTS.red.main, [0, 0, 0], [-0.05, 0, -0.18]));
  const brush2 = mesh(brush2Geo, tintedMat, -0.11, COUNTER_Y + 0.02, CUP_Z + 0.03, { cast: true });
  root.add(brush2);

  /* ---------------- Towel (the rail is part of `fixtureGeo`) ---------------- */

  /*
   * One sweep, then folded across its own width — see `clothShape` and `drapeFolds`. The
   * profile is authored in (z, y) around the rail and extruded across the towel's width, so
   * the quarter-turn about Y is what points the extrusion along the rail: `R_y(−90°)` maps
   * `(x, y, z) → (−z, y, x)`, which puts the extrusion axis on world X and the profile in
   * world (z, y). `drapeFolds` relies on exactly that mapping, which is why it runs *after*
   * `assemble` and not on the source geometry.
   *
   * The second slab is gone. It was a separate `TOWEL_FOLD` sweep intersecting this one, and
   * a boolean seam between two solids is what the audit photographed as an appliqué decal;
   * the fold is now a shorter front layer of the same continuous surface.
   */
  assertClothClearsRail(TOWEL_DRAPE);
  const towelGeo = drapeFolds(assemble([{ geo: clothGeometry(TOWEL_DRAPE), rot: [0, -Math.PI / 2, 0] }]));
  const towelA = mesh(towelGeo, towelAMat, -1.8, -0.82, RAIL_Z, { cast: true });
  const towelB = mesh(towelGeo, towelBMat, -1.8, -0.82, RAIL_Z, { cast: true });
  root.add(towelA, towelB);

  /* ---------------- Window ---------------- */

  const windowGroup = new Group();
  windowGroup.position.set(1.75, 1.02, WINDOW_Z);
  const windowGeo = assemble([
    { geo: roundedBox(1.74, 0.15, 0.13, 0.045, 1), pos: [0, 0.66, 0] },
    { geo: roundedBox(1.86, 0.17, 0.24, 0.055, 1), pos: [0, -0.66, 0.05] },
    { geo: roundedBox(0.15, 1.5, 0.13, 0.045, 1), pos: [-0.795, 0, 0] },
    { geo: roundedBox(0.15, 1.5, 0.13, 0.045, 1), pos: [0.795, 0, 0] },
    { geo: roundedBox(0.1, 1.36, 0.11, 0.035, 1), pos: [0, 0, 0] },
  ]);
  windowGroup.add(mesh(windowGeo, windowMat, 0, 0, 0, { cast: true }));
  windowGroup.add(mesh(roundedPlate(1.5, 1.3, 0.06, 0.1, 1), skyMat, 0, 0, -0.06));
  root.add(windowGroup);

  /* ---------------- Rubber duck ---------------- */

  const duckGeo = assemble([
    { geo: softSphere(0.26, 2), pos: [0, 0.25, 0], scale: [1.3, 0.95, 1.0], tint: ACCENTS.peach.main },
    { geo: softSphere(0.13, 2), pos: [-0.3, 0.33, 0], scale: [1.0, 0.95, 0.6], tint: ACCENTS.peach.main },
    { geo: softSphere(0.155, 2), pos: [0.19, 0.485, 0], tint: ACCENTS.peach.main },
    { geo: roundedBox(0.15, 0.065, 0.1, 0.028, 1), pos: [0.33, 0.455, 0], tint: ACCENTS.peach.deep },
    { geo: softSphere(0.032, 1), pos: [0.245, 0.55, 0.093], tint: NEUTRAL.ink },
    { geo: softSphere(0.032, 1), pos: [0.245, 0.55, -0.093], tint: NEUTRAL.ink },
    { geo: softSphere(0.115, 1), pos: [0, 0.31, 0.205], scale: [1.25, 0.85, 0.42], tint: ACCENTS.peach.soft },
    { geo: softSphere(0.115, 1), pos: [0, 0.31, -0.205], scale: [1.25, 0.85, 0.42], tint: ACCENTS.peach.soft },
  ]);
  const duckA = mesh(duckGeo, rubberMat, 0.95, FLOOR_Y, -0.35, { cast: true, rot: [0, -0.4, 0] });
  // The difference: in panel B the duck has turned around.
  const duckB = mesh(duckGeo, rubberMat, 0.95, FLOOR_Y, -0.35, {
    cast: true,
    rot: [0, Math.PI + 0.4, 0],
  });
  root.add(duckA, duckB);

  /* ---------------- Found badges and "oops" ripples ---------------- */

  /*
   * One instanced mesh each: five found badges and one three-ring ripple are two draw calls
   * per panel however many are on screen, and both are built at unit radius so a scale is the
   * whole animation. The badge's two colours ride in `aAlbedo`, so the disc and its tick are
   * still one geometry, one material and one draw call.
   *
   * **The ripple's tube is fat on purpose, and the number is measured.** Round 2's ripple was
   * `torusSoft(1, 0.055)` peaking at scale 0.53 — a 0.029-unit tube, **1.6 CSS pixels** at
   * the framing that shipped, in `mauve.soft` on a cream wall, for 0.55 s. Missing is the
   * commonest thing a child does in this game and its only visual answer was sub-pixel.
   * At `tube 0.14` the same peak is a 0.148-unit stroke: **19.7 px** on a 900 px panel,
   * 12.1 px on a 553 px one and still **8.5 px** on the smallest panel this layout will
   * produce, against the 6 px floor the fix list sets. The badge is 2 x `BADGE_R` across —
   * 47 CSS px on the desktop panel and 34 px on the phone's, with a 6.3 px tick stroke at the
   * worst of the two. Both are projected through the slide onto `MARK_Z`, which is where
   * those numbers come from.
   *
   * **The ripple is no longer billboarded either.** It carried the same defect the badge is
   * here to fix: a camera-facing torus points its tube crest at the lens all the way round, so
   * the band has one normal and cannot shade. Baking `BADGE_ROT` into the geometry costs
   * nothing, removes a per-frame quaternion copy, and gives the ring the same lit-crescent
   * roll the badge has.
   */
  const badges = new InstancedMesh(badgeGeometry(), badgeMat, BADGE_SLOTS);
  badges.frustumCulled = false;
  badges.castShadow = false;
  badges.visible = false;
  root.add(badges);

  const rippleGeo = torusSoft(1, 0.14, 2).clone();
  _e.set(BADGE_ROT[0], BADGE_ROT[1], BADGE_ROT[2]);
  _q.setFromEuler(_e);
  _m.makeRotationFromQuaternion(_q);
  // `torusSoft` lies in the XY plane already, so this is the same facing the badge takes.
  rippleGeo.applyMatrix4(_m);
  rippleGeo.computeBoundingSphere();
  const ripples = new InstancedMesh(rippleGeo, rippleMat, RIPPLE_SLOTS);
  ripples.frustumCulled = false;
  ripples.castShadow = false;
  ripples.visible = false;
  root.add(ripples);

  /* ---------------- Difference wiring ---------------- */

  const empty = () => {
    const g = new Group();
    root.add(g);
    return g;
  };

  /*
   * `BADGES[i]` — where each mark lands — is derived in `layout.ts` from `SPOTS` itself, by
   * searching a fixed compass order for the first heading that clears every other prop's pick
   * circle and every badge already placed. It is not authored here any more, and the reason is
   * SD2: the five hand-set ring radii and centres that used to live in this list were the
   * thing that put a `rose.deep` annulus *on top of* the towel, the duck and the shelf corner.
   * A table five numbers long is a table nobody can check; a search is one anybody can re-run.
   *
   * The `z` in each entry is the depth the badge's *screen size* is solved at, not the depth it
   * is drawn at — `stepScene` slides it forward onto `MARK_Z` along the camera ray and
   * rescales by the same factor, so it keeps its size and its place beside the prop while
   * never being able to intersect the room.
   */
  const diffs: DiffNode[] = [
    { a: brush2, b: empty(), pop: [cup, brush2] },
    { a: towelA, b: towelB, pop: [towelA, towelB] },
    { a: duckA, b: duckB, pop: [duckA, duckB] },
    { a: empty(), b: starExtra, pop: [star1, star2, starExtra] },
    { a: soapA, b: soapB, pop: [soapA, soapB] },
  ];

  // Every merged geometry this build owns. `basinGeo` is *not* here: it is an intermediate,
  // folded into `vanityTopGeo` and disposed at the point it stops being needed.
  auditSceneColours(root);

  const owned: BufferGeometry[] = [
    surroundGeo,
    vanityTopGeo,
    fixtureGeo,
    soapGeo,
    cupAndBrushGeo,
    brush2Geo,
    towelGeo,
    windowGeo,
    duckGeo,
  ];

  return {
    root,
    diffs,
    badges,
    ripples,
    bob: [duckA, duckB],
    bobBase: [duckA.position.y, duckB.position.y],
    dispose: () => {
      /*
       * Everything from `geometry.ts` / `materials.ts` is `markShared`, so `disposeObject3D`
       * frees exactly what this build owns: the **nine** merged geometries in `owned` — the
       * previous version of this comment said seven while the array held nine, which is round
       * 4's B5 footnote — plus the badge and the pre-rotated ripple ring, both built here.
       *
       * The `owned` loop and the two `geometry.dispose()` calls below are belt and braces:
       * `disposeObject3D` already frees any geometry in the tree that `isShared` says is not
       * shared, and a second `dispose()` on a `BufferGeometry` is a no-op. The two
       * `InstancedMesh.dispose()` calls are *not* redundant — those free the instance
       * matrix/colour buffers, which nothing else touches.
       *
       * `rippleGeo` is a `clone()` of the cached `torusSoft`, taken **before** the facing
       * matrix is applied, so the shared original is never mutated and never disposed.
       */
      disposeObject3D(root);
      for (let i = 0; i < owned.length; i++) owned[i].dispose();
      badges.geometry.dispose();
      badges.dispose();
      rippleGeo.dispose();
      ripples.dispose();
    },
  };
}
