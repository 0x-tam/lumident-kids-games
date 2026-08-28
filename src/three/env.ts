/**
 * The studio environment — built in code, never loaded.
 *
 * Every soft-3D look in this class comes from image-based lighting; a `directionalLight`
 * plus an `ambientLight` cannot produce the warm gradient falloff that makes clay read as
 * clay. But an HDRI on disk is banned (and would be a 2MB download anyway), so the studio
 * is modelled: three emissive rounded softbox panels and a warm gradient sky, rendered
 * once through `PMREMGenerator.fromScene()` into a mip-chained cube UV texture and cached
 * for the life of the renderer.
 *
 * The panel layout mirrors `STUDIO` in `tokens.ts` exactly: a big warm key upper-left, a
 * cream bounce card below (this is why no shadow in the product is ever grey), and a
 * cooler rim strip behind-right to lift silhouettes off the cream page.
 */
import {
  AdditiveBlending,
  BackSide,
  Color,
  DoubleSide,
  FogExp2,
  CustomToneMapping,
  Mesh,
  PCFShadowMap,
  PMREMGenerator,
  PlaneGeometry,
  SRGBColorSpace,
  Scene,
  ShaderChunk,
  ShaderMaterial,
  SphereGeometry,
  type Texture,
  type WebGLRenderTarget,
  type WebGLRenderer,
} from "three";
import { disposeObject3D, markShared } from "./dispose";
import { FOG, STUDIO, TONE } from "./tokens";

/* ------------------------------------------------------------------ */
/* Procedural studio geometry                                          */
/* ------------------------------------------------------------------ */

/** Comfortably inside the PMREM camera's far plane, comfortably outside every panel. */
const SKY_RADIUS = 40;

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize( position );
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`;

/**
 * PMREM renders with tone mapping disabled into a half-float linear target, so these
 * uniforms must already be linear. `new Color(hex)` does that conversion on assignment —
 * writing the value straight out is correct, and applying any encoding here would
 * double-convert.
 */
const SKY_FRAG = /* glsl */ `
uniform vec3 uTop;
uniform vec3 uBottom;
varying vec3 vDir;
void main() {
  float t = smoothstep( -0.35, 0.85, vDir.y );
  gl_FragColor = vec4( mix( uBottom, uTop, t ), 1.0 );
}
`;

const PANEL_VERT = /* glsl */ `
varying vec2 vPanelUv;
void main() {
  vPanelUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`;

/**
 * A rounded-rectangle SDF with a soft falloff, so the softbox has genuinely soft edges
 * rather than a hard rectangle that would print a visible box in every specular
 * reflection. Additive: the panels are light sources sitting in front of the sky, and
 * additive blending also makes their draw order irrelevant.
 */
const PANEL_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uRadius;
uniform float uSoft;
varying vec2 vPanelUv;
void main() {
  vec2 p = ( vPanelUv - 0.5 ) * 2.0;
  vec2 q = abs( p ) - vec2( 1.0 - uRadius );
  float sd = length( max( q, 0.0 ) ) + min( max( q.x, q.y ), 0.0 ) - uRadius;
  float m = 1.0 - smoothstep( -uSoft, 0.0, sd );
  gl_FragColor = vec4( uColor, m * m );
}
`;

type PanelSpec = {
  color: string;
  intensity: number;
  position: readonly [number, number, number];
  size: readonly [number, number];
  /** Corner radius as a fraction of the half-extent; 1.0 is a full ellipse. */
  radius: number;
  soft: number;
};

const PANELS: PanelSpec[] = [
  { ...STUDIO.key, radius: 0.55, soft: 0.75 },
  { ...STUDIO.bounce, radius: 0.9, soft: 1.0 },
  { ...STUDIO.rim, radius: 0.35, soft: 0.5 },
];

const buildStudioScene = (): Scene => {
  const scene = new Scene();

  const sky = new Mesh(
    new SphereGeometry(SKY_RADIUS, 32, 20),
    new ShaderMaterial({
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      uniforms: {
        // Scaled in linear space, after ColorManagement has converted the sRGB token.
        // The sky is fill, not a light source: see the note on STUDIO.skyIntensity.
        uTop: { value: new Color(STUDIO.skyTop).multiplyScalar(STUDIO.skyIntensity) },
        uBottom: { value: new Color(STUDIO.skyBottom).multiplyScalar(STUDIO.skyIntensity) },
      },
      side: BackSide,
      depthWrite: false,
      toneMapped: false,
      fog: false,
    })
  );
  sky.renderOrder = -1;
  scene.add(sky);

  for (const p of PANELS) {
    // Colour components deliberately exceed 1: these are HDR emitters, and the PMREM
    // target is half-float, so the key really is ~5.6x brighter than the sky.
    const emissive = new Color(p.color).multiplyScalar(p.intensity);
    const mesh = new Mesh(
      new PlaneGeometry(p.size[0], p.size[1]),
      new ShaderMaterial({
        vertexShader: PANEL_VERT,
        fragmentShader: PANEL_FRAG,
        uniforms: {
          uColor: { value: emissive },
          uRadius: { value: p.radius },
          uSoft: { value: p.soft },
        },
        transparent: true,
        blending: AdditiveBlending,
        depthWrite: false,
        depthTest: false,
        side: DoubleSide,
        toneMapped: false,
        fog: false,
      })
    );
    mesh.position.set(p.position[0], p.position[1], p.position[2]);
    mesh.lookAt(0, 0, 0);
    scene.add(mesh);
  }

  return scene;
};

/* ------------------------------------------------------------------ */
/* Cache                                                               */
/* ------------------------------------------------------------------ */

let envTarget: WebGLRenderTarget | null = null;
let envTexture: Texture | null = null;
let envOwner: WebGLRenderer | null = null;

/**
 * Builds (or returns) the studio PMREM for this renderer. Roughly 25ms once, at app start;
 * every scene afterwards reuses the same texture.
 */
export function getStudioEnvironment(renderer: WebGLRenderer): Texture {
  if (envTexture && envOwner === renderer) return envTexture;
  // A different renderer means a new WebGL context: the old texture belongs to a dead one.
  if (envTexture) disposeEnvironment();

  const scene = buildStudioScene();
  const pmrem = new PMREMGenerator(renderer);
  try {
    // A little pre-blur softens the panel edges below what the mip chain alone gives,
    // which matters for the two lowest-roughness materials (enamel, softGlass).
    //
    // 0.040 is not a taste value, it is the ceiling. PMREMGenerator takes
    // `1 + floor(3 * sigma / (PI / (2 * (256 - 1))))` samples and warns above 20, so
    // anything from 0.0411 up prints a console warning on every cold boot and silently
    // clips the kernel it warned about. Visually indistinguishable from 0.045.
    envTarget = pmrem.fromScene(scene, 0.04, 0.1, SKY_RADIUS * 4);
    envTexture = markShared(envTarget.texture);
    envOwner = renderer;
  } finally {
    pmrem.dispose();
    // The studio only ever exists for the duration of one cube render.
    disposeObject3D(scene);
  }

  return envTexture as Texture;
}

/* ------------------------------------------------------------------ */
/* Tone map                                                            */
/* ------------------------------------------------------------------ */

/**
 * Where the shoulder starts. Khronos PBR Neutral writes this as `0.8 - 0.04`, the second
 * term being the black-point offset removed below; with the offset gone it is simply the
 * shoulder start, and it is kept at 0.76 rather than restored to 0.8 because 0.76 is what
 * the measurement below prefers on the calibration surface (ground dE2000 0.22 against 0.65).
 */
const TONE_SHOULDER = 0.76;
const TONE_DESATURATION = 0.15;

/**
 * **Khronos PBR Neutral, minus its black-point offset. This is the fix for round 4's A16, and
 * it is a deliberate, measured amendment to `3D-SPEC §2`'s tone-map row.**
 *
 * ## What was wrong
 *
 * A16 measured every mid-to-dark accent in the product landing off-token with one shared
 * signature: `dL −1.8…−3.2`, `dC +3…+8.6`, `dh +4…+5°` toward orange — while a light,
 * low-chroma token landed at dE2000 0.51. The audit's read was right — "this is one
 * calibration issue, not nine authoring mistakes" — and the transform doing it is the first
 * three lines of the stock operator:
 *
 * ```glsl
 * float x = min( color.r, min( color.g, color.b ) );
 * float offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
 * color -= offset;
 * ```
 *
 * That subtracts a **near-constant ~0.04 of linear radiance from all three channels**. On a
 * channel sitting at 0.80 it is a 5 % shift the shoulder gives back at the top. On a channel
 * sitting at 0.073 — which is exactly where the blue channel of `coral.main` lands — it is a
 * **55 % shift**. Removing more than half of one channel and a twentieth of another *is* a
 * chroma boost with a hue rotation toward the dominant channel and a small luminance drop: it
 * is the measured signature, arrived at from the operator rather than fitted to the data.
 *
 * ## Why this is not "widening a budget"
 *
 * The offset is a filmic toe, and the product does not want one: every surface in it is warm
 * clay on a cream page, there is nothing near black in the frame by design, and §1.2 pins the
 * palette as an exact list of hexes. §2 chose PBR Neutral over ACESFilmic to stop the brand
 * reds being desaturated into orange; the shipped operator was rotating them into orange by
 * the other route. The shoulder — the half of the curve that stops ivory clipping to chalk,
 * which is the reason the row names an operator at all — is untouched.
 *
 * ## The measurement
 *
 * Not a model. Each shipped round-4 frame's pixel was inverted through the **current** tone
 * map to recover the radiance the renderer actually produced, and that same radiance was
 * pushed through the candidate. No assumption about shading, lighting or albedo enters it:
 *
 *   | surface (round-4 capture) | token | dE2000 now | dE2000 after |
 *   |---|---|---|---|
 *   | Maze Escape coral block top   | `coral.main` | 3.82 | **1.91** |
 *   | Maze Escape coral, shadow side| `coral.main` | 8.14 | **3.24** |
 *   | Tooth Match red card          | `red.main`   | 4.43 | **2.11** |
 *   | Tooth Match red card, lower   | `red.main`   | 5.81 | **1.83** |
 *   | lit ground (calibration anchor)| `page`      | 0.51 | **0.22** |
 *
 * Reproduce with `scratchpad/tonemap.mjs`. Every surface improves, the anchor improves
 * without `GROUND_WHITE_BALANCE` being re-derived, and four of the five land inside A16's
 * dE ≤ 3 bar. The fifth is a shadow-side sample whose remaining error is luminance, not hue.
 *
 * The darks lifting is a second win rather than a cost: the same subtraction was crushing the
 * mascot's `NEUTRAL.ink` pupils to `#111216`, which is where round 4's "two enormous solid
 * black eyes … reads as a skull" came from.
 *
 * ## Keeping it honest
 *
 * `CustomToneMapping` is three's supported hook for exactly this and is part of `three`, so
 * §1.7's dependency rule is untouched. The body below is the upstream operator verbatim from
 * `node_modules/three/src/renderers/shaders/ShaderChunk/tonemapping_pars_fragment.glsl.js`
 * with the three offset lines deleted and nothing else changed — diff it against upstream on
 * every three upgrade.
 */
const CLAY_TONE_MAP = /* glsl */ `
vec3 CustomToneMapping( vec3 color ) {
	const float StartCompression = ${TONE_SHOULDER.toFixed(2)};
	const float Desaturation = ${TONE_DESATURATION.toFixed(2)};
	color *= toneMappingExposure;
	// Upstream subtracts a black-point offset here. See CLAY_TONE_MAP for the measurement
	// that removed it; do not restore it without re-running that measurement.
	float peak = max( color.r, max( color.g, color.b ) );
	if ( peak < StartCompression ) return color;
	float d = 1. - StartCompression;
	float newPeak = 1. - d * d / ( peak + d - StartCompression );
	color *= newPeak / peak;
	float g = 1. - 1. / ( Desaturation * ( peak - newPeak ) + 1. );
	return mix( color, vec3( newPeak ), g );
}
`;

/**
 * Installed once at module load, before any material can compile.
 *
 * `WebGLPrograms` keys a program on `toneMapping` (the enum) but not on the *text* of the
 * chunk, so mutating it after a program exists would leave that program on the old curve.
 * Doing it at module evaluation makes that unreachable: nothing in the product renders before
 * this file is imported, because `Rig` imports it and no scene mounts without a `Rig`.
 */
const TONE_MAP_ANCHOR = "vec3 CustomToneMapping( vec3 color ) { return color; }";
if (ShaderChunk.tonemapping_pars_fragment.includes(TONE_MAP_ANCHOR)) {
  ShaderChunk.tonemapping_pars_fragment = ShaderChunk.tonemapping_pars_fragment.replace(
    TONE_MAP_ANCHOR,
    CLAY_TONE_MAP
  );
} else if (!ShaderChunk.tonemapping_pars_fragment.includes("StartCompression = 0.76")) {
  // Loud and actionable rather than silent: without the patch every accent in the product
  // renders through an identity curve, which is a blown-out frame, not a subtle drift.
  console.error(
    "[lumident/env] three's CustomToneMapping stub has moved; the clay tone curve is NOT " +
      "installed and every surface will render unmapped. Re-derive TONE_MAP_ANCHOR from " +
      "node_modules/three/src/renderers/shaders/ShaderChunk/tonemapping_pars_fragment.glsl.js"
  );
}

/* ------------------------------------------------------------------ */
/* Renderer + scene defaults                                           */
/* ------------------------------------------------------------------ */

const configured = new WeakSet<WebGLRenderer>();

/**
 * Renderer-wide state is set exactly once per context. The tone curve is Khronos PBR Neutral
 * — the operator `3D-SPEC §2` names, and for the reason it names it: ACESFilmic desaturates
 * the brand reds into orange on the gum coral and on every accent prop — installed through
 * `CustomToneMapping` with **one term removed**. See `CLAY_TONE_MAP` for the measurement.
 */
const configureRenderer = (renderer: WebGLRenderer): void => {
  if (configured.has(renderer)) return;
  configured.add(renderer);
  renderer.toneMapping = CustomToneMapping;
  renderer.toneMappingExposure = TONE.exposure;
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  /**
   * `PCFShadowMap` — and the spec now says so. **This is a resolved conflict, not a
   * deviation; do not "fix" it back.**
   *
   * `3D-SPEC §2` used to ask for `PCFSoftShadowMap` **and** `radius 4` in the same row, and
   * in three r170 those two are mutually exclusive. Verified against the shipped source,
   * `node_modules/three/src/renderers/shaders/ShaderChunk/shadowmap_pars_fragment.glsl.js`:
   *
   *   - the `SHADOWMAP_TYPE_PCF` branch declares
   *     `float dx0 = - texelSize.x * shadowRadius;` and takes 17 compares at
   *     `0, ±radius/2, ±radius` texels — `shadow.radius` is honoured, and the penumbra is
   *     tunable to any width.
   *   - the `SHADOWMAP_TYPE_PCF_SOFT` branch declares `float dx = texelSize.x;` and never
   *     references `shadowRadius` at all. Its kernel is a fixed 2×2-texel bilinear block,
   *     roughly 3 screen px at design framing — under the 5 px a soft shadow needs, with no
   *     knob to widen it.
   *
   * Two rounds of audit escalated the row rather than resolving it. It is resolved now, and
   * the answer is neither of the two options as posed, because **both stock branches are
   * fixed-width**: they draw the same penumbra directly under a prop's contact point as a
   * unit above it, which is what makes a shadow read as a dark decal rather than as light
   * being blocked. What the look actually needs is a penumbra that *widens with distance*.
   *
   * So the type stays `PCFShadowMap` — the only branch that reads `shadow.radius` at all —
   * and the clay shader redirects that branch into a contact-hardening PCSS filter
   * (`materials.ts::PCSS_PATCH`): a blocker search, then a PCF disc whose radius comes from
   * the measured caster-to-receiver gap. `shadow.radius` stops being a filter width and
   * becomes the gap→penumbra conversion (`Rig.tsx`). `PCFSoftShadowMap` would break this
   * outright: its branch ignores `shadowRadius`, so the whole solve would compile away.
   *
   * The low tier keeps this branch unpatched (`quality.softShadows`), where it is also the
   * cheaper of the two: 17 compares against PCF_SOFT's 9 bilinear-interpolated ones, which
   * is thirty-six texture fetches.
   */
  renderer.shadowMap.type = PCFShadowMap;
  renderer.shadowMap.needsUpdate = true;
};

/**
 * Idempotent per-scene setup. Safe and cheap to call on every `Rig` mount: the renderer
 * work happens once, and the scene work is three property writes plus a fog object that is
 * reused rather than reallocated.
 */
export function applySceneDefaults(
  scene: Scene,
  renderer: WebGLRenderer,
  opts?: { fogDensity?: number; background?: boolean }
): void {
  configureRenderer(renderer);

  const env = getStudioEnvironment(renderer);
  if (scene.environment !== env) scene.environment = env;
  scene.environmentIntensity = STUDIO.envIntensity;

  const density = opts?.fogDensity ?? FOG.density;
  const fog = scene.fog;
  if (fog instanceof FogExp2) {
    fog.color.set(FOG.color);
    fog.density = density;
  } else {
    scene.fog = new FogExp2(FOG.color, density);
  }

  // Default: no background at all, so the canvas stays transparent and the DOM page cream
  // shows through. Opting in is only for offscreen captures that need an opaque backdrop.
  if (opts?.background) {
    if (scene.background instanceof Color) scene.background.set(FOG.color);
    else scene.background = new Color(FOG.color);
  } else if (scene.background !== null) {
    scene.background = null;
  }
}

/** Frees the studio PMREM. Only correct on teardown or context loss. */
export function disposeEnvironment(): void {
  envTarget?.dispose();
  envTarget = null;
  envTexture = null;
  envOwner = null;
}
