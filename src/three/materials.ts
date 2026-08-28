/**
 * The clay shading model.
 *
 * A stock `MeshPhysicalMaterial` cannot make ivory read as pressed clay: its Lambert
 * terminator is a hard `max(N·L, 0)` cliff, it has no translucency, and its GGX lobe puts
 * a tight white dot on every rounded prop. All three are exactly the tells that make a
 * frame look like a Three.js example. So every clay factory here patches the physical
 * shader in two places:
 *
 *   1. **Wrapped diffuse** — `(N·L + w) / (1 + w)` replaces the clamped `N·L` on the
 *      *diffuse* lobe only, with `w` widened per channel by the material's scatter tint so
 *      the terminator goes warm-pink instead of grey. This is what stops ivory from going
 *      chalk-white on top and flat-grey underneath.
 *   2. **Warm back-scatter** — a cheap translucency lobe driven by `dot(V, -L)`, weighted
 *      by a grazing-angle "thinness" factor, tinted with `CLAY.sss`. Thin edges pick up a
 *      warm glow whenever a light sits behind the prop.
 *
 * Everything else that sells the look is achieved with stock, safe features: broad Charlie
 * sheen at high sheen-roughness instead of a specular dot, low `specularIntensity`,
 * roughness in the 0.55–0.8 band, a low-strength fbm normal map for micro-grain, and
 * `vertexColors` so the curvature AO baked into every geometry from `geometry.ts`
 * multiplies the albedo.
 *
 * All materials are cached by key and `markShared()`-ed, so `disposeObject3D` on a game's
 * scene root leaves them alone; `disposeMaterialCache()` is the only thing that frees them.
 */
import {
  AddEquation,
  BufferAttribute,
  Color,
  CustomBlending,
  DstColorFactor,
  OneFactor,
  OneMinusSrcAlphaFactor,
  DoubleSide,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  LinearSRGBColorSpace,
  SRGBColorSpace,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  ShaderChunk,
  ShaderLib,
  ZeroFactor,
  type BufferGeometry,
  type IUniform,
  type Texture,
  type WebGLProgramParametersWithUniforms,
} from "three";
import { markShared, registerSceneCache, tagCacheEntry } from "./dispose";
import { getQuality, PCSS_GROUPS_FOR_TIER } from "./quality";
import { ACCENTS, CLAY, NEUTRAL, type AccentFamily, type AccentTone } from "./tokens";
import { noiseNormalTexture, radialShadowTexture } from "./textures";

/* ------------------------------------------------------------------ */
/* The shader patch                                                    */
/* ------------------------------------------------------------------ */

/**
 * Every anchor is a `#include <...>` line in the *unresolved* ShaderLib source. three
 * calls `onBeforeCompile` before `resolveIncludes`, so these directives are still literal
 * text at patch time. Each one is asserted to occur exactly once; a miss disables that one
 * patch, logs an actionable error, and leaves the rest of the clay system working.
 */
const patchPoint = (label: string, anchor: string, replacement: string) => {
  const probe = ShaderLib.physical.fragmentShader.split(anchor).length - 1;
  if (probe !== 1) {
    console.error(
      `[lumident/materials] anchor '${anchor}' occurs ${probe}x in the physical fragment shader ` +
        `(expected 1); the clay '${label}' patch is DISABLED. Re-derive it from ` +
        `node_modules/three/src/renderers/shaders/ShaderLib/meshphysical.glsl.js`
    );
    return null;
  }
  return { anchor, replacement };
};

/** `patchPoint`, against the vertex shader. Same uniqueness contract, same failure mode. */
const patchVertexPoint = (label: string, anchor: string, replacement: string) => {
  const probe = ShaderLib.physical.vertexShader.split(anchor).length - 1;
  if (probe !== 1) {
    console.error(
      `[lumident/materials] anchor '${anchor}' occurs ${probe}x in the physical vertex shader ` +
        `(expected 1); the clay '${label}' patch is DISABLED. Re-derive it from ` +
        `node_modules/three/src/renderers/shaders/ShaderLib/meshphysical.glsl.js`
    );
    return null;
  }
  return { anchor, replacement };
};

/**
 * Verified verbatim against three r170
 * (`src/renderers/shaders/ShaderChunk/lights_physical_pars_fragment.glsl.js`, the last
 * line of `RE_Direct_Physical`). The sibling line in `RE_IndirectDiffuse_Physical` writes
 * to `indirectDiffuse`, so this string occurs exactly once — asserted below.
 */
const DIFFUSE_ANCHOR =
  "\treflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );";

const PARS_INCLUDE = "#include <lights_physical_pars_fragment>";

/**
 * Declarations. Injected after `#include <common>` rather than alongside the lighting
 * patch, so the three in-`main()` patches below do not depend on the lighting patch having
 * landed — if one anchor moves in a future three release the others still compile.
 *
 * `gClayCrev` / `gClayEdge` are written in `color_fragment` (which runs before every other
 * patched chunk) and read afterwards. They are the curvature-AO signal that
 * `geometry.ts::bakeCurvatureAO` baked into the `color` attribute, split into its two
 * halves: how deep in a crease this fragment is, and how far out over an exposed bevel.
 */
const CLAY_DECLARATIONS = /* glsl */ `
varying vec3 vClayAlbedo;
uniform float uClayWrap;
uniform vec3  uClaySSS;
uniform float uClaySSSStrength;
uniform float uClaySSSPower;
uniform float uClayAO;
uniform float uClayEdgeGloss;
uniform float uClayAOIndirect;
uniform vec3  uClayShadowTint;
uniform float uClayMottle;
uniform float uClayMottleRough;
float gClayCrev = 0.0;
float gClayEdge = 0.0;
float gClayShadow = 0.0;
float gClayMottle = 0.0;
`;

/**
 * How much of the grain map's tile the mottle spans, as a rate on the same UV.
 *
 * The grain tile is 0.75 world units (`GRAIN_REPEAT` below derives it), so at this rate one
 * mottle tile spans `0.75 / 0.16 = 4.69` world units and its four-cell lattice puts one
 * patch at **1.17 units** — about 157 screen px at design framing — with the second octave
 * at half that. That is the scale a thumb leaves on a slab, which is the point: it has to be
 * large enough that a flat face carries structure and small enough that a face carries more
 * than one of them.
 *
 * It is a magnification of the map (6.25x), so the sample lands on mip 0 and the mottle
 * cannot be averaged away the way the grain was in round 2.
 */
const CLAY_MOTTLE_RATE = 0.16;

/**
 * Luma at which the mottle runs at its authored amplitude — a lit `main` accent or ivory in
 * the key. Below it the amplitude is scaled up by `reference / luma`; above it, nothing
 * happens. See the mottle block in `CLAY_COLOR_FRAGMENT`.
 */
const MOTTLE_REFERENCE_LUMA = 0.35;
/**
 * Ceiling on that gain. 2 lands `coral.deep` (luma 0.126 linear) at 2.0 and `NEUTRAL.ink` at
 * 2.0 as well; past it a `deep` tone starts to read as blotched rather than pressed, and the
 * ceiling is the difference between compensating a display transform and inventing texture.
 */
const MOTTLE_MAX_GAIN = 2;

const CLAY_DIRECT_DIFFUSE = /* glsl */ `
	// --- Lumident clay --------------------------------------------------------
	// Wrapped diffuse, per channel. A scalar wrap softens the terminator but leaves it
	// grey, and grey is exactly what makes ivory read as chalk. Warm wavelengths survive
	// a longer path inside a scattering body, so red bleeds further past the terminator
	// than blue does; giving each channel its own wrap width is the cheapest honest way
	// to get that, and unlike a dot(V,-L) translucency lobe it actually fires under this
	// product's front-upper-left key. The wrap is normalised by (1 + w) so the lit pole
	// keeps its energy and only the shadow side gains.
	//
	// WIDTH IS A LOOK DECISION, NOT A FREEBIE. At w = 0.38 the shadow pole of a sphere
	// still receives 36% of the light its lit pole does; add an environment on top and the
	// form disappears entirely. The wrap exists to soften a terminator and let light bleed
	// through thin parts, so it is set per material in the 0.22-0.36 band, which keeps a
	// visible, unmistakably-round terminator while never showing a hard Lambert cliff. The
	// two materials whose whole job is translucent ivory — clayEnamel and clayGround — sit at
	// the spec's ~0.35 top of that band; everything with real form to model sits lower.
	//
	// Only the diffuse lobe is wrapped: the irradiance above keeps the true clamped N.L,
	// so the specular and sheen lobes are not smeared around the back of the prop.
	float clayRawNL = dot( geometryNormal, directLight.direction );
	vec3 clayWrapW = uClayWrap * ( vec3( 1.0 ) + uClaySSS * uClaySSSStrength );
	vec3 clayWrapNL = clamp( ( vec3( clayRawNL ) + clayWrapW ) / ( vec3( 1.0 ) + clayWrapW ), 0.0, 1.0 );
	reflectedLight.directDiffuse += directLight.color * clayWrapNL * BRDF_Lambert( material.diffuseColor );

	// Back-scatter, for what the wrap cannot cover: light arriving from behind the prop
	// and leaving toward the eye. Weighted by a grazing-angle thinness factor so it shows
	// on thin edges rather than flat faces, and by how far the point is into shadow so
	// the lit side does not double-count. Tinted by uClaySSS *and* the albedo, so a deep
	// coral gum scatters coral rather than generic pink.
	float clayBack  = saturate( dot( geometryViewDir, -directLight.direction ) );
	float clayThin  = pow( 1.0 - saturate( dot( geometryNormal, geometryViewDir ) ), 2.0 );
	float clayShade = 1.0 - saturate( clayRawNL );
	float clayScatter = pow( clayBack, uClaySSSPower ) * ( 0.30 + 0.70 * clayThin ) * clayShade;
	reflectedLight.directDiffuse += directLight.color * uClaySSS * material.diffuseColor * ( clayScatter * uClaySSSStrength );
	// --------------------------------------------------------------------------
`;

/**
 * `color_fragment` is where three multiplies the vertex colour into the albedo. Stock, that
 * multiply is fixed at 1.0 strength and has no other effect — which wastes the signal.
 * `bakeCurvatureAO` writes crevices down to ~0.63 and worn bevel crowns up to ~1.10, so the
 * attribute is a *signed curvature map*, not just a tint. Splitting it here into `gClayCrev`
 * and `gClayEdge` lets the two later patches use it as real occlusion and as an edge gloss.
 *
 * The tint itself becomes `1 + (vColor - 1) * uClayAO`, i.e. a strength knob that
 * extrapolates in both directions from neutral, so one uniform deepens creases *and* lifts
 * bevels together.
 *
 * **`vColor` is curvature. It is not, and must never be, an albedo.** Round 2 measured what
 * happens when the two are conflated: three feeds both the `color` vertex attribute and
 * `instanceColor` into the same `vColor`, so a caller writing a token colour there had it run
 * through `1 + (c - 1) * 1.45`, which drives every channel below ~0.31 straight to black.
 * `#efa160` rendered `(227,74,9)`, `#c08475` rendered `(143,12,6)`, and the celebration
 * confetti came out as arterial red. Per-surface colour therefore travels on its own
 * attribute, `aAlbedo` (see `ALBEDO_ATTRIBUTE` below), which is a **straight multiply at full
 * strength** and defaults to white when a geometry does not supply it. The two signals stay
 * orthogonal: curvature still drives `gClayCrev`/`gClayEdge`, so a coloured surface keeps its
 * crevice darkening and its edge gloss instead of losing them to a flattened `ao`.
 */
const CLAY_COLOR_FRAGMENT = /* glsl */ `
#if defined( USE_COLOR_ALPHA )
	diffuseColor *= vColor;
#elif defined( USE_COLOR )
	float clayLum = max( vColor.r, max( vColor.g, vColor.b ) );
	gClayCrev = saturate( ( 1.0 - clayLum ) * 2.0 );
	gClayEdge = saturate( ( clayLum - 1.0 ) * 10.0 );
	diffuseColor.rgb *= max( vec3( 0.0 ), vec3( 1.0 ) + ( vColor - vec3( 1.0 ) ) * uClayAO );
#endif
	diffuseColor.rgb *= vClayAlbedo;
	// --- Hand-pressed mottle -------------------------------------------------
	// A low-frequency *albedo* variation, read out of the grain map's alpha channel (see
	// \`textures.ts::MOTTLE_CELLS\`) at \`CLAY_MOTTLE_RATE\`.
	//
	// It exists because the two mechanisms above it are both no-ops on the surfaces that
	// dominate five of the nine games. \`vColor\` is \`bakeCurvatureAO\`'s output, and curvature
	// is *identically zero* on a plane and *constant* on a sphere or a cylinder — measured:
	// \`softSphere(0.36)\` writes 1.012 on all 492 vertices, and every flat face of a
	// \`roundedBox\` writes exactly 1.000. The grain normal map is the other, and a normal map
	// can only shade by turning the surface, so it does nothing on a face already pointed at
	// the key. Round 3 measured the result at 1-3 codes over hundreds of pixels on five
	// independent scenes and called it the rubric's "uniform albedo" rejection.
	//
	// Multiplying the albedo has no such blind spot: it changes the pixel whatever the normal
	// and whatever the light. \`gClayMottle\` is signed and zero-mean by construction, so a
	// material at \`uClayMottle = 0\` renders byte-identically to before — which is what
	// \`clayGround\` uses, because its one contract is to be indistinguishable from the DOM
	// page and a mottled floor would break the melt.
#ifdef USE_NORMALMAP
	gClayMottle = texture2D( normalMap, vNormalMapUv * ${CLAY_MOTTLE_RATE.toFixed(4)} ).a - 0.5;
#endif
	// Amplitude compensated for how dark the albedo is.
	//
	// The mottle is a *relative* swing, so on a \`deep\` accent it moves far fewer 8-bit codes
	// than the same swing does on ivory — round 4 measured the Tooth Rescue alcove
	// (\`coral.deep\`) at high-frequency sigma 0.628 against 5.434 on the basket in the same
	// frame, and called it "the mottle amplitude is crushed on dark albedos". It is not the
	// signal that is crushed, it is the display transform: sRGB's slope means a fixed
	// *fractional* change is worth fewer codes the darker the surface.
	//
	// The gain is \`MOTTLE_REFERENCE_LUMA / luma\`, i.e. exactly the inverse of that, clamped
	// so it can only ever *raise* a dark surface toward the reference and never blotch one:
	// at luma 0.35 (a lit \`main\` tone) the gain is 1 and nothing changes, and at the darkest
	// albedo in the palette it stops at 2. Applied to the signed, zero-mean signal, so a
	// material at \`uClayMottle = 0\` still renders byte-identically.
	float clayLuma = dot( diffuseColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
	float clayMottleGain = clamp( ${MOTTLE_REFERENCE_LUMA.toFixed(3)} / max( clayLuma, 0.01 ), 1.0, ${MOTTLE_MAX_GAIN.toFixed(1)} );
	diffuseColor.rgb *= max( vec3( 0.0 ), vec3( 1.0 + gClayMottle * uClayMottle * clayMottleGain ) );
	// -------------------------------------------------------------------------
`;

/**
 * The vertex half of the albedo path.
 *
 * Declared unconditionally on every clay material rather than behind a variant flag, for two
 * reasons. One compiled program: `customProgramCacheKey` is a constant, and adding a second
 * variant would have doubled the live-program count against a budget of 28 that the audit
 * already found at 33. And one migration path: a geometry that supplies nothing gets
 * `DEFAULT_ATTRIBUTES`' white through `vertexAttrib3fv`, so every existing prop in the
 * product is unaffected, byte for byte.
 */
const CLAY_ALBEDO_VERTEX_DECLARATIONS = /* glsl */ `
attribute vec3 aAlbedo;
varying vec3 vClayAlbedo;
`;

const CLAY_ALBEDO_VERTEX_ASSIGN = /* glsl */ `
	vClayAlbedo = aAlbedo;
`;

/**
 * A bevel only reads if it *catches* the key — a darker or lighter albedo along the edge is
 * not enough, because the eye reads a highlight travelling along a rim as geometry and a
 * tint as paint. Dropping roughness on the worn crown of every bevel gives the specular and
 * sheen lobes something to tighten onto exactly where the curvature is highest, so edges
 * pick up a soft warm line under the key. Creases go the other way — a pocket of clay that
 * never gets rubbed is rougher, and roughening it also stops the env from filling in the
 * occlusion the crevice tint just applied.
 */
const CLAY_ROUGHNESS_FRAGMENT = /* glsl */ `
float roughnessFactor = roughness;
#ifdef USE_ROUGHNESSMAP
	vec4 texelRoughness = texture2D( roughnessMap, vRoughnessMapUv );
	roughnessFactor *= texelRoughness.g;
#endif
// The mottle rides the roughness too, with the opposite sign to the albedo: a patch of clay
// that took more pressure is both slightly darker and slightly smoother, so the sheen breaks
// up across a flat face along with the colour instead of lying over it as an even sweep.
roughnessFactor = clamp( roughnessFactor - gClayEdge * uClayEdgeGloss + gClayCrev * 0.10 + gClayMottle * uClayMottleRough, 0.045, 1.0 );
`;

/**
 * Stock `aomap_fragment` is a no-op without an `aoMap` texture, and every clay material is
 * UV-projected procedural geometry that will never have one. But the occlusion signal
 * already exists per vertex — it just was not reaching the *indirect* lobes, so the
 * environment happily re-lit every crevice the vertex tint had darkened and the AO stopped
 * reading. Feeding `gClayCrev` in here is what makes a seam, an inner tray corner or the
 * underside of a rim actually go dark.
 *
 * `computeSpecularOcclusion` is defined in the `bsdfs` chunk, which `common` pulls in ahead
 * of `main`, so it is in scope. The stock USE_AOMAP branch is preserved underneath in case
 * a game ever supplies a real map.
 */
const CLAY_AOMAP_FRAGMENT = /* glsl */ `
{
	float clayAO = 1.0 - gClayCrev * uClayAOIndirect;
	// Warm the one part of the frame the key cannot reach. Multiplicative, so it tints and
	// deepens a cast shadow rather than lifting it — a warm shadow still has to be a shadow.
	vec3 clayShade = mix( vec3( 1.0 ), uClayShadowTint, gClayShadow );
	reflectedLight.indirectDiffuse *= clayAO * clayShade;
	#if defined( USE_SHEEN )
		sheenSpecularIndirect *= clayAO * clayShade;
	#endif
	#if defined( USE_ENVMAP ) && defined( STANDARD )
		float clayDotNV = saturate( dot( geometryNormal, geometryViewDir ) );
		reflectedLight.indirectSpecular *= computeSpecularOcclusion( clayDotNV, clayAO, material.roughness );
	#endif
}
#include <aomap_fragment>
`;

/**
 * Built once at module load. Any patch whose anchor has moved evaluates to `null`: the
 * materials still compile (falling back to stock behaviour for that one term) and the
 * console gets a loud, actionable error rather than a black screen.
 */
const CLAY_LIGHTING_CHUNK: string | null = (() => {
  const src = ShaderChunk.lights_physical_pars_fragment;
  if (src.split(DIFFUSE_ANCHOR).length !== 2) {
    console.error(
      "[lumident/materials] lights_physical_pars_fragment no longer contains the direct-diffuse " +
        "anchor; clay wrapped diffuse + back-scatter are DISABLED. Re-derive DIFFUSE_ANCHOR from " +
        "node_modules/three/src/renderers/shaders/ShaderChunk/lights_physical_pars_fragment.glsl.js"
    );
    return null;
  }
  if (ShaderLib.physical.fragmentShader.split(PARS_INCLUDE).length !== 2) {
    console.error(`[lumident/materials] '${PARS_INCLUDE}' is not unique; clay lighting is DISABLED.`);
    return null;
  }
  return src.replace(DIFFUSE_ANCHOR, CLAY_DIRECT_DIFFUSE);
})();

/**
 * Cast shadows in this product are cream-on-cream, and cream in shadow is lit by nothing but
 * the environment — which makes a shadow the *only* place in the frame where the warm key
 * has no say. Left alone it comes out a neutral lavender-grey smudge, which against a cream
 * page is the single ugliest thing a stylised renderer can do.
 *
 * Physically, a shadow on a cream floor is filled by bounce from the lit cream around it, so
 * it should be *warmer* than the lit floor, not cooler. There is no GI here to supply that,
 * so the shadow mask is captured on its way past and used to tint the indirect lobes toward
 * warm further down (see the ao patch). The capture writes the existing global rather than
 * declaring a local, because `#pragma unroll_loop_start` duplicates this body verbatim once
 * per directional light and a local would be a redeclaration in the same scope.
 *
 * The product ships exactly one directional light, so `gClayShadow` is exact. With more than
 * one it holds the last light's mask, which degrades to "tinted by whichever light was
 * enumerated last" — still stable, never wrong-coloured.
 */
const SHADOW_ANCHOR =
  "\t\tdirectLight.color *= ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ i ], " +
  "directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, " +
  "directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;";

const CLAY_SHADOW_CAPTURE = /* glsl */ `		float clayShadowSample = ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;
		// Geometric occlusion, 0..1 — NOT the intensity-scaled mask.
		//
		// \`getShadow\` returns \`1 - shadowIntensity\` in full shadow, so the mask this used to
		// capture topped out at 0.52 and \`mix( 1, uClayShadowTint, gClayShadow )\` could only
		// ever apply *half* the tint it was handed. That is half of why round 4 measured a
		// cast shadow whose chroma had not moved. Dividing the intensity back out makes the
		// uniform mean what its name says: at 1.0 the fragment is fully occluded and the
		// shadow's own colour is exactly \`uClayShadowTint\`. The direct light is still scaled
		// by the raw sample, so nothing about the *darkening* changes.
		gClayShadow = ( 1.0 - clayShadowSample ) / max( directionalLightShadow.shadowIntensity, 1e-4 );
		directLight.color *= clayShadowSample;`;

/**
 * Patches a line *inside* a ShaderChunk and hangs the rewritten chunk off its `#include`.
 * `onBeforeCompile` sees the shader before `resolveIncludes` runs, so a line that lives in a
 * chunk is simply not present in the fragment source yet — which is why this needs its own
 * form. Both halves are asserted: the anchor must be unique within the chunk, and the
 * chunk's include must be unique within the shader.
 */
const chunkPatch = (label: string, chunkName: keyof typeof ShaderChunk, anchor: string) => {
  const src = ShaderChunk[chunkName];
  const include = `#include <${chunkName}>`;
  const inChunk = src.split(anchor).length - 1;
  const inShader = ShaderLib.physical.fragmentShader.split(include).length - 1;
  if (inChunk !== 1 || inShader !== 1) {
    console.error(
      `[lumident/materials] the clay '${label}' patch is DISABLED: its anchor occurs ${inChunk}x ` +
        `in ShaderChunk.${chunkName} and '${include}' occurs ${inShader}x in the physical fragment ` +
        `shader (both must be 1). Re-derive it from node_modules/three/src/renderers/shaders/.`
    );
    return null;
  }
  return { src, include, anchor };
};

const SHADOW_PATCH = chunkPatch("warm shadow", "lights_fragment_begin", SHADOW_ANCHOR);

/* ------------------------------------------------------------------ */
/* Contact-hardening shadows (PCSS)                                    */
/* ------------------------------------------------------------------ */

/**
 * A penumbra that widens with distance from the contact point.
 *
 * `3D-SPEC §2` used to ask for `PCFSoftShadowMap` **and** `shadow.radius 4` in the same row.
 * In three r170 those are mutually exclusive — the `SHADOWMAP_TYPE_PCF_SOFT` branch of
 * `shadowmap_pars_fragment` declares `float dx = texelSize.x;` and never reads
 * `shadowRadius` — so the row could not be satisfied as written, and two rounds of audit
 * escalated it instead of resolving it. It is resolved here, and the spec row now records
 * what actually ships.
 *
 * Neither stock branch was ever the right answer, because both are *fixed-width*: they
 * produce the same penumbra directly under a prop's contact point as they do a unit above
 * it, and a shadow whose edge does not change as the caster lifts away reads as a dark decal
 * stuck to the floor rather than as light being blocked. That is the actual defect the audit
 * photographed ("a flat occlusion slab, not a penumbra", "the terminator resolves in ≤ 2 px").
 *
 * So the PCF branch is redirected into a percentage-closer *soft* shadow:
 *
 *   1. **Blocker search.** Eight taps on a Vogel disc read the packed depth around the
 *      receiver and average everything in front of it. The mean is the caster's depth.
 *   2. **Penumbra.** The shadow camera is orthographic, so its depth buffer is *linear* and
 *      `receiverDepth − blockerDepth` is a real distance once scaled by the frustum's depth
 *      range. `Rig` folds that scale, the key's angular size and the map's texel density
 *      into `DirectionalLightShadow.radius`, so the whole conversion is one multiply here
 *      and the result is a penumbra whose half-width in **world** units is
 *      `SHADOW_SOFTNESS × gap` — framing-independent, tier-independent, and zero at contact.
 *   3. **Filter.** Twelve taps on a Vogel disc at that radius.
 *
 * Two properties worth stating because they are why this is affordable:
 *
 *  - **It cannot cause shadow acne.** Acne is self-shadowing, i.e. the blocker *is* the
 *    receiver, i.e. `gap ≈ 0`, i.e. the kernel collapses to `PCSS_MIN_TEXELS`. The wide
 *    kernels only ever appear where the caster is genuinely far from the receiver, so the
 *    existing `shadowBias` / `shadowNormalBias` pair — tuned against a narrow kernel — stays
 *    valid.
 *  - **Both discs are rotated per fragment** by interleaved-gradient noise. Twelve taps over
 *    a ten-texel disc is an undersample, and an unrotated pattern turns that into concentric
 *    banding — the same artefact, one octave finer. Rotating converts it into fine noise at
 *    the scale of the clay grain the surface already carries.
 *
 * Cost is 20 texture fetches against the stock kernel's 17, and it is gated on
 * `quality.softShadows` so the low tier keeps the cheap fixed-radius path.
 */
const PCSS_SEARCH_TEXELS = 9;
/** Sampling floor. Below ~2 texels a PCF disc aliases into a stair-stepped edge. */
const PCSS_MIN_TEXELS = 2;
/**
 * Ceiling on the penumbra, in shadow texels.
 *
 * A sampling limit, not a look limit. It does not bite at any framing the product ships:
 * `Rig` writes `shadow.radius = SHADOW_SOFTNESS x 2.2 x shadowMapSize` and the shader
 * multiplies it by the *normalised* depth gap, which works out to a penumbra half-width of
 * `SHADOW_SOFTNESS x gap` world units — so at a 12-unit frustum on a 1024 map this clamp is
 * only reached once a caster is 1.17 world units clear of its receiver, well past anything
 * a game holds up.
 */
const PCSS_MAX_TEXELS = 10;
const PCSS_SEARCH_TAPS = 8;

/**
 * Filter taps, per penumbra width. This is the fix for a measured artefact, so it is worth
 * writing down what it is fixing.
 *
 * Every tap is a binary depth compare, so an N-tap kernel is an N-sample Bernoulli estimate
 * of coverage and its standard error peaks at `0.5 / sqrt(N)` in the middle of a penumbra.
 * Pushed through the rest of the pipeline — `shadowIntensity` 0.52, a key carrying ~60 % of
 * the light on the cream floor, and the sRGB transfer's slope near code 237 — one sigma at
 * twelve taps lands at **4.6 of 255**, i.e. an 18-code peak-to-peak speckle, which is what
 * round 3 photographed across the whole kernel in Tooth Runner. Under the old
 * `gl_FragCoord` rotation key (see `lumidentPCSS`) that speckle was also *screen*-locked, so
 * it crawled across every surface as the scene scrolled.
 *
 * The rotation key is now world-locked, which stops the crawl. The noise itself only comes
 * down with taps, and taps only matter where the kernel is actually wide — at the contact
 * end the disc collapses to `PCSS_MIN_TEXELS` and twelve taps all agree. So the tap count
 * follows the radius:
 *
 *   | radius (texels) | taps | 1 sigma, 8-bit |
 *   |---|---|---|
 *   | <= 3.5 | 12 | 4.6 (but the taps agree at this width, so the real figure is far lower) |
 *   | <= 7   | 24 | 3.2 |
 *   | > 7    | 36 | 2.7 |
 *
 * The three groups are one 36-point Vogel disc **interleaved** by three, not three copies of
 * a twelve-point disc: each group on its own is still a well-spread golden-angle set (stride
 * `3 x 2.39996 = 0.916 rad mod 2pi`, irrational, so no group clumps), and all three together
 * are exactly the 36-point disc rather than a triple sample of the same radii.
 *
 * **How many groups compile is the tier, and it is what replaced gating the whole filter on
 * the tier.** `quality.ts::PCSS_GROUPS_FOR_TIER` is the table; the round-4 audit's finding
 * was that `softShadows = tier !== "low"` switched the product's signature shadow off on the
 * one device `3D-SPEC §1.4` names as the target, so the frame the target child sees was not
 * the frame anyone had reviewed. Tiering the tap count instead costs the low tier three
 * fetches over the stock kernel it used to get (8 blocker-search + 12 filter = 20 against 17)
 * and keeps the contact-hardening the whole look rests on.
 *
 *   | tier | groups | widest kernel | fetches, widest |
 *   |---|---|---|---|
 *   | low  | 1 | 12 taps | 20 |
 *   | mid  | 2 | 24 taps | 32 |
 *   | high | 3 | 36 taps | 44 |
 *
 * The wide groups are branches on the *measured* penumbra, so they only run where the shadow
 * is genuinely soft — a minority of any frame, most of which is umbra and unshadowed floor.
 */
const PCSS_TAP_GROUPS = 3;
const PCSS_FILTER_TAPS = 36;
const PCSS_WIDEN_1 = 3.5;
const PCSS_WIDEN_2 = 7;

/**
 * A Vogel (golden-angle) disc, emitted as literal GLSL.
 *
 * Written out rather than looped over a `const vec2[]`: three compiles GLSL ES 1.00 even on
 * a WebGL2 context, and array constructors are an ES 3.00 feature. Unrolling in TypeScript
 * costs nothing at runtime and keeps the tap positions readable in a shader dump.
 *
 * `stride`/`offset` take every `stride`-th point starting at `offset`, which is how the
 * filter splits one 36-point disc into three interleaved 12-point groups.
 */
const vogelDisc = (n: number, stride = 1, offset = 0): string[] => {
  const taps: string[] = [];
  for (let i = offset; i < n; i += stride) {
    const r = Math.sqrt((i + 0.5) / n);
    const a = i * 2.399963229728653;
    taps.push(`vec2( ${(Math.cos(a) * r).toFixed(5)}, ${(Math.sin(a) * r).toFixed(5)} )`);
  }
  return taps;
};

/** One interleaved group of filter taps, as GLSL statements. */
const pcssFilterGroup = (group: number): string =>
  vogelDisc(PCSS_FILTER_TAPS, PCSS_TAP_GROUPS, group)
    .map(
      (p) =>
        `\t\t\tsum += texture2DCompare( shadowMap, coord.xy + lumidentSpin( ${p}, rot ) * spread, coord.z );`
    )
    .join("\n");

const PCSS_GROUP_TAPS = PCSS_FILTER_TAPS / PCSS_TAP_GROUPS;

/**
 * How many of the three interleaved groups this session compiles. Frozen at boot for the same
 * reason `quality.softShadows` is: it decides the *text* of a program, not a uniform.
 */
const PCSS_COMPILED_GROUPS = PCSS_GROUPS_FOR_TIER[getQuality().tier];
const PCSS_MID_GROUP = PCSS_COMPILED_GROUPS >= 2;
const PCSS_TOP_GROUP = PCSS_COMPILED_GROUPS >= 3;

const PCSS_FUNCTIONS = /* glsl */ `
	vec2 lumidentSpin( vec2 tap, vec2 rot ) {
		return vec2( tap.x * rot.x - tap.y * rot.y, tap.x * rot.y + tap.y * rot.x );
	}

	void lumidentBlocker( sampler2D shadowMap, vec2 uv, float z, inout float sum, inout float hits ) {
		float d = unpackRGBAToDepth( texture2D( shadowMap, uv ) );
		if ( d < z ) {
			sum += d;
			hits += 1.0;
		}
	}

	float lumidentPCSS( sampler2D shadowMap, vec2 shadowMapSize, float shadowRadius, vec3 coord ) {
		vec2 texelSize = vec2( 1.0 ) / shadowMapSize;
		// Interleaved-gradient rotation for both discs, keyed on the **shadow map** rather
		// than on the window.
		//
		// This line used to read \`gl_FragCoord.xy\`, which is absolute drawing-buffer space.
		// Spot the Difference draws one world twice, into two viewports ~780 device px apart,
		// so the same world fragment received a different disc rotation in each panel and
		// sampled a different blocker set — inventing differences a child is asked to find and
		// cannot. The game's own shipped test reported it: 2466 differing pixels in 1367
		// clusters, present inside smooth shadow interiors and 0.00 % on the unshadowed wall,
		// which is the signature of a shading term rather than of a geometric offset.
		// \`3D-SPEC §6.5\` makes panel parity a correctness requirement, so the key has to be a
		// function of the world fragment, and \`coord.xy\` is: the shadow camera belongs to the
		// light, not to a viewport, so two draws of the same world point produce the same
		// shadow-space coordinate bit for bit.
		//
		// It is still per-fragment. The IGN constants advance \`52.9829189 x 0.06711056 = 3.556\`
		// hash cycles per shadow texel, and at design framing (~134 screen px per world unit,
		// a 12-unit frustum on a 1024 map) a shadow texel spans 1.57 screen px — 2.3 cycles per
		// screen pixel, i.e. fully decorrelated neighbours. And because the key is now world-
		// locked the dither is stable on the surface instead of crawling across it whenever the
		// camera or the scene moves, which is half of why the old kernel read as speckle.
		float ign = fract( 52.9829189 * fract( dot( coord.xy * shadowMapSize, vec2( 0.06711056, 0.00583715 ) ) ) );
		float ang = ign * 6.28318530718;
		vec2 rot = vec2( cos( ang ), sin( ang ) );

		vec2 search = texelSize * ${PCSS_SEARCH_TEXELS.toFixed(1)};
		float blockerSum = 0.0;
		float blockerHits = 0.0;
${vogelDisc(PCSS_SEARCH_TAPS)
  .map(
    (p) =>
      `\t\tlumidentBlocker( shadowMap, coord.xy + lumidentSpin( ${p}, rot ) * search, coord.z, blockerSum, blockerHits );`
  )
  .join("\n")}

		float radius = ${PCSS_MIN_TEXELS.toFixed(1)};
		if ( blockerHits > 0.0 ) {
			// Orthographic shadow camera => linear depth => this difference is a distance.
			// \`shadowRadius\` carries "penumbra texels per unit of normalised depth gap".
			float gap = max( 0.0, coord.z - blockerSum / blockerHits );
			radius = clamp( gap * shadowRadius, ${PCSS_MIN_TEXELS.toFixed(1)}, ${PCSS_MAX_TEXELS.toFixed(1)} );
		}

		vec2 spread = texelSize * radius;
		float sum = 0.0;
		float taps = ${PCSS_GROUP_TAPS.toFixed(1)};
		{
${pcssFilterGroup(0)}
		}
		// Wide kernels only. The branch is coherent across a penumbra — neighbouring fragments
		// measure near-identical gaps — so this is a whole-warp decision, not divergence.
${
  PCSS_MID_GROUP
    ? `\t\tif ( radius > ${PCSS_WIDEN_1.toFixed(1)} ) {\n\t\t\ttaps += ${PCSS_GROUP_TAPS.toFixed(
        1
      )};\n${pcssFilterGroup(1)}\n\t\t}`
    : "\t\t// low tier: only the first tap group is compiled in. See PCSS_TAP_GROUPS."
}
${
  PCSS_TOP_GROUP
    ? `\t\tif ( radius > ${PCSS_WIDEN_2.toFixed(1)} ) {\n\t\t\ttaps += ${PCSS_GROUP_TAPS.toFixed(
        1
      )};\n${pcssFilterGroup(2)}\n\t\t}`
    : "\t\t// the third tap group is not compiled in. See PCSS_TAP_GROUPS."
}
		return sum / taps;
	}

`;

/** Where the PCSS helpers are injected: after `texture2DCompare`, before `getShadow`. */
const PCSS_DECLARE_ANCHOR = "\tvec2 texture2DDistribution( sampler2D shadow, vec2 uv ) {";

/**
 * The stock PCF branch is not deleted, it is preprocessed away: reproducing three's
 * seventeen-tap block verbatim in order to replace it would be a second copy to keep in
 * step with every three release. Redirecting the branch head and renaming the old branch's
 * condition to something never defined leaves the upstream text intact and inert, and the
 * `SHADOWMAP_TYPE_PCF_SOFT` / `VSM` / unfiltered branches after it still work if the
 * renderer's shadow type ever changes.
 */
const PCSS_BRANCH_ANCHOR = "if ( frustumTest ) {\n\t\t#if defined( SHADOWMAP_TYPE_PCF )";
const PCSS_BRANCH_REPLACEMENT =
  "if ( frustumTest ) {\n" +
  "\t\t#if defined( SHADOWMAP_TYPE_PCF )\n" +
  "\t\t\tshadow = lumidentPCSS( shadowMap, shadowMapSize, shadowRadius, shadowCoord.xyz );\n" +
  "\t\t#elif defined( SHADOWMAP_TYPE_PCF_SUPERSEDED_BY_LUMIDENT_PCSS )";

/**
 * `null` on the low tier (keep three's cheap fixed-radius kernel) and whenever an anchor has
 * moved — in which case the console gets an actionable error and the product falls back to
 * the stock filter rather than to a black screen.
 */
const PCSS_PATCH: { anchor: string; replacement: string } | null = (() => {
  if (!getQuality().softShadows) return null;
  const src = ShaderChunk.shadowmap_pars_fragment;
  const include = "#include <shadowmap_pars_fragment>";
  const declares = src.split(PCSS_DECLARE_ANCHOR).length - 1;
  const branches = src.split(PCSS_BRANCH_ANCHOR).length - 1;
  const included = ShaderLib.physical.fragmentShader.split(include).length - 1;
  if (declares !== 1 || branches !== 1 || included !== 1) {
    console.error(
      `[lumident/materials] the clay PCSS shadow filter is DISABLED: its declaration anchor ` +
        `occurs ${declares}x and its branch anchor ${branches}x in ` +
        `ShaderChunk.shadowmap_pars_fragment, and '${include}' occurs ${included}x in the ` +
        `physical fragment shader (all three must be 1). Shadows fall back to three's ` +
        `fixed-radius PCF kernel, which has no contact hardening — re-derive the anchors from ` +
        `node_modules/three/src/renderers/shaders/ShaderChunk/shadowmap_pars_fragment.glsl.js`
    );
    return null;
  }
  return {
    anchor: include,
    replacement: src
      .replace(PCSS_DECLARE_ANCHOR, `${PCSS_FUNCTIONS}${PCSS_DECLARE_ANCHOR}`)
      .replace(PCSS_BRANCH_ANCHOR, PCSS_BRANCH_REPLACEMENT),
  };
})();

/** True when the compiled clay programs contain the PCSS filter. `Rig` reads it: the two
 *  sides must agree on what `DirectionalLightShadow.radius` means. */
export const CLAY_SOFT_SHADOWS = PCSS_PATCH !== null;

const CLAY_PATCHES = [
  // `#include <packing>` is unique across the whole physical shader source (vertex and
  // fragment), sits in the pars block right after <common>, and needs nothing from the
  // chunks around it — the safest possible place to hang declarations.
  patchPoint("declarations", "#include <packing>", `#include <packing>\n${CLAY_DECLARATIONS}`),
  patchPoint("vertex-colour AO", "#include <color_fragment>", CLAY_COLOR_FRAGMENT),
  patchPoint("edge gloss", "#include <roughnessmap_fragment>", CLAY_ROUGHNESS_FRAGMENT),
  patchPoint("indirect occlusion", "#include <aomap_fragment>", CLAY_AOMAP_FRAGMENT),
  SHADOW_PATCH
    ? {
        anchor: SHADOW_PATCH.include,
        replacement: SHADOW_PATCH.src.replace(SHADOW_PATCH.anchor, CLAY_SHADOW_CAPTURE),
      }
    : null,
  PCSS_PATCH,
].filter((p): p is { anchor: string; replacement: string } => p !== null);

const CLAY_VERTEX_PATCHES = [
  patchVertexPoint(
    "albedo declarations",
    "#include <common>",
    `#include <common>\n${CLAY_ALBEDO_VERTEX_DECLARATIONS}`
  ),
  patchVertexPoint(
    "albedo varying",
    "#include <color_vertex>",
    `#include <color_vertex>\n${CLAY_ALBEDO_VERTEX_ASSIGN}`
  ),
].filter((p): p is { anchor: string; replacement: string } => p !== null);

/**
 * If either half of the albedo path failed to land, the fragment shader would declare a
 * varying nothing writes — legal GLSL, but it would read as garbage on some drivers and
 * silently black out every clay prop. Falling back to a literal white keeps the product
 * rendering and leaves the console error from `patchVertexPoint` as the only symptom.
 */
const CLAY_ALBEDO_ACTIVE = CLAY_VERTEX_PATCHES.length === 2;

/**
 * Constant so every clay material shares one compiled program per define-set. Without it
 * three falls back to `onBeforeCompile.toString()`, and because each material owns a
 * closure the source text would still match — but pinning it makes the intent explicit and
 * survives minifiers that rename captured variables.
 *
 * Bump the suffix whenever the GLSL above changes: three caches compiled programs by this
 * key for the life of the context.
 */
const CLAY_PROGRAM_KEY = "lumident-clay-v6";

/**
 * The shadow filter is compiled in, not switched at draw time, so it has to be part of the
 * key or a session that boots low and one that boots high would share a program.
 */
const CLAY_PROGRAM_CACHE_KEY = `${CLAY_PROGRAM_KEY}${
  CLAY_SOFT_SHADOWS ? `-pcss${PCSS_COMPILED_GROUPS * PCSS_GROUP_TAPS}` : "-pcf"
}`;

type ClayShading = {
  wrap: number;
  sss: string;
  sssStrength: number;
  sssPower: number;
  ao: number;
  edgeGloss: number;
  aoIndirect: number;
  shadowTint: string;
  mottle: number;
  mottleRough: number;
};

const attachClayShader = (mat: MeshPhysicalMaterial, s: ClayShading): void => {
  // One uniform object per material, created once — never inside the compile callback,
  // which can fire again on context restore.
  const uWrap: IUniform<number> = { value: s.wrap };
  const uSSS: IUniform<Color> = { value: new Color(s.sss) };
  const uStrength: IUniform<number> = { value: s.sssStrength };
  const uPower: IUniform<number> = { value: s.sssPower };
  const uAO: IUniform<number> = { value: s.ao };
  const uEdgeGloss: IUniform<number> = { value: s.edgeGloss };
  const uAOIndirect: IUniform<number> = { value: s.aoIndirect };
  const uShadowTint: IUniform<Color> = { value: new Color(s.shadowTint) };
  const uMottle: IUniform<number> = { value: s.mottle };
  const uMottleRough: IUniform<number> = { value: s.mottleRough };

  mat.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => {
    shader.uniforms.uClayWrap = uWrap;
    shader.uniforms.uClaySSS = uSSS;
    shader.uniforms.uClaySSSStrength = uStrength;
    shader.uniforms.uClaySSSPower = uPower;
    shader.uniforms.uClayAO = uAO;
    shader.uniforms.uClayEdgeGloss = uEdgeGloss;
    shader.uniforms.uClayAOIndirect = uAOIndirect;
    shader.uniforms.uClayShadowTint = uShadowTint;
    shader.uniforms.uClayMottle = uMottle;
    shader.uniforms.uClayMottleRough = uMottleRough;

    let frag = shader.fragmentShader;
    for (const p of CLAY_PATCHES) frag = frag.replace(p.anchor, p.replacement);
    if (CLAY_LIGHTING_CHUNK) frag = frag.replace(PARS_INCLUDE, CLAY_LIGHTING_CHUNK);
    if (!CLAY_ALBEDO_ACTIVE) frag = frag.replace("varying vec3 vClayAlbedo;", "vec3 vClayAlbedo = vec3( 1.0 );");
    shader.fragmentShader = frag;

    let vert = shader.vertexShader;
    for (const p of CLAY_VERTEX_PATCHES) vert = vert.replace(p.anchor, p.replacement);
    shader.vertexShader = vert;
  };
  mat.customProgramCacheKey = () => CLAY_PROGRAM_CACHE_KEY;
};

/* ------------------------------------------------------------------ */
/* Micro-grain                                                         */
/* ------------------------------------------------------------------ */


/**
 * One shared fbm normal map for every clay surface, sized so the grain actually survives the
 * trip to the framebuffer.
 *
 * `geometry.ts::applyPlanarUV` writes `uv = worldPosition * UV_SCALE`, with `UV_SCALE = 2`,
 * so a texture repeat of `r` makes one tile of this map span `1 / (2r)` world units. At
 * `r = 2/3` that is **0.75 world units** — 7.5 cm at product scale.
 *
 * The three numbers below are one calculation, not three tastes. Design framing is a 28°
 * lens at ~12 units, which puts ~134 screen px on a world unit:
 *
 *   - **texel density.** 0.75 units / 128 px = **0.78 screen px per texel**, i.e. the map is
 *     sampled at mip 0. The previous 512px/repeat-1 map spanned 0.5 units, which is 0.13 px
 *     per texel — an 8x minification, so every fragment read mip ~3, and the mip of a normal
 *     map is a *flat* normal map. That is the whole reason round 2 measured the micro-grain
 *     at or under one 8-bit code on every surface it sampled: the perturbation existed in
 *     the texture and had been averaged away before it reached a pixel.
 *   - **feature size.** 8 lattice cells across the tile puts the base lump at 0.094 units
 *     ≈ 12 px, and 3 octaves put the finest at 0.023 units ≈ 3 px — fingerprint scale, above
 *     the aliasing floor (4 texels per cell at the top octave) and below "blotches".
 *   - **slope.** `NORMAL_GAIN` acts on a per-texel central difference, so halving the map
 *     against the same lattice count doubles the encoded slope. Peak tilt lands near 36°,
 *     which the materials' 0.08–0.15 `normalScale` then dials back into the spec's band.
 */
/**
 * Measured p1..p99 half-spread of the mottle signal `textures.ts` bakes into the grain map's
 * alpha, as a fraction of full scale. Not a guess: computed over the shipped 128px /
 * 4-cell / 2-octave map and pinned here so the amplitudes below are stated in *albedo*
 * percent rather than in units of an unspecified noise.
 */
const MOTTLE_SPREAD = 0.1706;
/** ±5.9 % albedo, p1 to p99. See the note in `build()`. */
const DEFAULT_MOTTLE = 0.059 / MOTTLE_SPREAD;
/** ±0.04 roughness over the same spread — enough to break a sheen sweep, not to stripe it. */
const DEFAULT_MOTTLE_ROUGH = 0.04 / MOTTLE_SPREAD;

const GRAIN_REPEAT = 2 / 3;
const GRAIN_SIZE = 128;
const GRAIN_CELLS = 8;
const GRAIN_OCTAVES = 3;

/**
 * The grain map, at a per-material repeat.
 *
 * `grainScale` multiplies `GRAIN_REPEAT`, so `2` puts two grain periods where there was one.
 * Round 4's A14: "the grain tile is **0.75 world units** while a 4x4 sliding tile is 0.67
 * units — one grain period per tile is a low-frequency mottle that at ~70 screen px resolves
 * as a smooth gradient." One world constant cannot serve a 12-unit maze board and a 0.67-unit
 * tile at once; the number a caller wants is "3-4 periods across *my* prop", and only the
 * caller knows its size.
 *
 * **Raising the repeat alone would have been the wrong fix, and this is the part the audit's
 * one-line version misses.** The map's three numbers are one calculation (see the note above
 * `MOTTLE_SPREAD`): 8 lattice cells across a 0.75-unit tile put the base lump at 12 screen px
 * and three octaves put the finest at 3 px, which is the aliasing floor — 4 texels per cell at
 * the top octave. Multiplying the repeat by `s` divides *every* one of those by `s`, so at
 * `s = 2` the finest octave is 1.5 px and at `s = 4` it is 0.75 px: under the floor, therefore
 * mipped away, therefore invisible — which is precisely the round-2 failure this map's
 * dimensions were derived to fix.
 *
 * So a variant drops octaves as it gains repeat, `octaves = 3 - round(log2 s)`, which holds
 * the **finest octave at ~3 screen px at every scale** and only ever removes detail the
 * sampler could not have resolved:
 *
 *   | grainScale | tile | base lump | finest octave | octaves |
 *   |---|---|---|---|---|
 *   | 1 | 0.750 u / 100 px | 12 px | 3.1 px | 3 |
 *   | 2 | 0.375 u / 50 px  |  6 px | 3.1 px | 2 |
 *   | 4 | 0.188 u / 25 px  |  3 px | 3.1 px | 1 |
 *
 * Above 4 there is nothing left to drop and the knob clamps: a prop that small wants a
 * *finer* map, not a tighter repeat, and it should say so rather than silently alias.
 *
 * Each variant is its own 128x128 RGBA texture (64 kB). The product is expected to use two or
 * three of them; the map is keyed and shared, so a scale used by nine materials costs one.
 *
 * One coupling worth knowing: the alpha channel carries the low-frequency mottle and is
 * sampled off the same `vNormalMapUv`, which includes the texture's `repeat`. So a variant
 * shrinks the thumbprint mottle by the same factor it shrinks the grain. That is the right
 * direction — a small prop wants a small thumbprint — but it means `CLAY_MOTTLE_RATE`'s
 * "4.69 world units per mottle tile" is stated at `grainScale = 1` and divides by the scale.
 */
const grainVariants = new Map<number, Texture>();

/** Above this the top octave has nowhere left to go — see the table above. */
const GRAIN_SCALE_MAX = 4;

const grainMap = (scale = 1): Texture => {
  const q = Math.round(Math.max(0.25, Math.min(GRAIN_SCALE_MAX, scale)) * 100) / 100;
  const cached = grainVariants.get(q);
  if (cached) return cached;
  const octaves = Math.max(1, Math.min(GRAIN_OCTAVES, GRAIN_OCTAVES - Math.round(Math.log2(q))));
  const variant: Texture = noiseNormalTexture({
    size: GRAIN_SIZE,
    scale: GRAIN_CELLS,
    octaves,
    repeat: GRAIN_REPEAT * q,
  });
  markShared(variant);
  grainVariants.set(q, variant);
  return variant;
};

/* ------------------------------------------------------------------ */
/* Factories                                                           */
/* ------------------------------------------------------------------ */

export type ClayOptions = {
  color?: string;
  roughness?: number;
  sss?: string;
  sssStrength?: number;
  wrap?: number;
  sheen?: number;
  grain?: number;
  /**
   * Multiplier on the grain map's repeat: `2` puts two grain periods where there was one.
   *
   * The default tile is 0.75 world units, which is right for a board and far too coarse for
   * a small prop — `3D-SPEC §3` asks for "fingerprinted clay tooth", and one period across a
   * 0.67-unit sliding tile is a gradient, not a fingerprint. Size it so the prop carries
   * **3-4 periods**: `grainScale = (3.5 * 0.75) / propSizeInUnits`. See `grainMap`.
   */
  grainScale?: number;
  transparent?: boolean;
  opacity?: number;
  emissive?: string;
  emissiveIntensity?: number;
  /**
   * Scales this material's response to the studio environment. Public because a genuinely
   * thin or translucent surface — a confetti wafer, a cup — needs more of the fill than a
   * solid slab does, and because it is the one lighting knob that cannot break anything: it
   * multiplies the indirect lobes and nothing else.
   */
  envMapIntensity?: number;
};

/** Knobs the internal factories need that games have no business setting per-call. */
type ClayInternal = ClayOptions & {
  sssPower?: number;
  /** Strength of the baked curvature-AO vertex tint. 1 = as baked; >1 sculpts harder. */
  ao?: number;
  /** How much roughness a worn bevel crown loses, so edges catch the key. */
  edgeGloss?: number;
  /** How much of the environment a crevice is allowed to lose. */
  aoIndirect?: number;
  /** Multiplier applied to the indirect lobes inside a cast shadow. Warm, never grey. */
  shadowTint?: string;
  /**
   * Peak-to-peak albedo swing of the hand-pressed mottle, as a fraction. See
   * `CLAY_MOTTLE_RATE`. 0 disables it exactly (the signal is zero-mean).
   */
  mottle?: number;
  /** Roughness swing of the same mottle, in absolute roughness units. */
  mottleRough?: number;
  specularIntensity?: number;
  sheenColor?: string;
  sheenRoughness?: number;
  ior?: number;
  doubleSided?: boolean;
  depthWrite?: boolean;
  dithering?: boolean;
};

const cache = new Map<string, MeshPhysicalMaterial>();

/**
 * `vertexColors` is on for every clay material, so the shader reads a `color` attribute.
 * Every geometry from `geometry.ts` carries one (baked curvature AO), but a raw
 * `<planeGeometry>` or a drei helper does not — and an unbound vertex attribute reads as
 * black, which would render the prop invisible. This default makes the missing case a
 * neutral white multiply instead. `uv` gets the same treatment for the grain normal map.
 */
const DEFAULT_ATTRIBUTES: Record<string, number[]> = {
  color: [1, 1, 1],
  uv: [0, 0],
  // The albedo path is declared on every clay program; a prop that carries no per-surface
  // colour must read as an untouched white multiply, not as black.
  aAlbedo: [1, 1, 1],
};

/* ------------------------------------------------------------------ */
/* Per-surface albedo                                                  */
/* ------------------------------------------------------------------ */

/**
 * The attribute a caller writes a **colour** into.
 *
 * Migration contract, for every consumer that today writes a token colour into the `color`
 * vertex attribute or into `InstancedMesh.instanceColor`:
 *
 * ```ts
 * // per-vertex — leave `color` to bakeCurvatureAO, put the palette here
 * geometry.setAttribute(ALBEDO_ATTRIBUTE, vertexAlbedoAttribute(linearRGBTriples));
 *
 * // per-instance — attach to the geometry, not to the mesh, and never to a cached one
 * const albedo = instanceAlbedoAttribute(count);
 * geometry.setAttribute(ALBEDO_ATTRIBUTE, albedo);
 * writeAlbedo(albedo, i, color(ACCENTS.peach.main));
 * albedo.needsUpdate = true;
 * ```
 *
 * Values are **linear** RGB, which is exactly what `tokens.ts::color()` returns — three's
 * ColorManagement converts an sRGB hex on assignment, so never pre-convert by hand.
 *
 * Two rules that are not optional:
 *  - Stop setting `instanceColor` on the same mesh. three multiplies `instanceColor` into
 *    `vColor` alongside the vertex `color`, so leaving it set puts the colour back through
 *    the curvature extrapolation this attribute exists to escape.
 *  - Never attach an instance attribute to a geometry from `cachedGeometry()`. That cache is
 *    shared across games for the life of the context; clone it, or build the geometry locally
 *    and dispose it with the scene.
 */
export const ALBEDO_ATTRIBUTE = "aAlbedo";

/** Per-vertex albedo. `values` is `vertexCount * 3` linear RGB floats. */
export function vertexAlbedoAttribute(values: Float32Array): BufferAttribute {
  return new BufferAttribute(values, 3);
}

/** Per-instance albedo, pre-filled white so an unwritten instance is never black. */
export function instanceAlbedoAttribute(count: number): InstancedBufferAttribute {
  const attr = new InstancedBufferAttribute(new Float32Array(Math.max(1, count) * 3).fill(1), 3);
  attr.setUsage(DynamicDrawUsage);
  return attr;
}

/** Writes one linear RGB colour into an albedo attribute. No allocation. */
export function writeAlbedo(
  attr: BufferAttribute | InstancedBufferAttribute,
  index: number,
  c: Color
): void {
  const arr = attr.array as Float32Array;
  const o = index * 3;
  arr[o] = c.r;
  arr[o + 1] = c.g;
  arr[o + 2] = c.b;
}

/**
 * Convenience for the common per-instance case: attaches (once) and returns the albedo
 * buffer on `geo`, growing it if the instance count went up.
 */
export function ensureInstanceAlbedo(geo: BufferGeometry, count: number): InstancedBufferAttribute {
  const existing = geo.getAttribute(ALBEDO_ATTRIBUTE) as InstancedBufferAttribute | undefined;
  if (existing && existing.count >= count) return existing;
  const attr = instanceAlbedoAttribute(count);
  geo.setAttribute(ALBEDO_ATTRIBUTE, attr);
  return attr;
}

/** `defaultAttributeValues` is honoured for every material by `WebGLBindingStates`, but is
 *  only declared on `ShaderMaterial` in @types/three. */
type WithAttributeDefaults = { defaultAttributeValues: Record<string, number[]> };

const build = (opts: ClayInternal): MeshPhysicalMaterial => {
  const g = opts.grain ?? 0.11;
  const m = new MeshPhysicalMaterial({
    color: opts.color ?? CLAY.ivory,
    roughness: opts.roughness ?? 0.7,
    metalness: 0,
    // The whole point: a broad grazing-angle sheen instead of a specular highlight dot.
    //
    // `sheenRoughness` is the parameter that decides whether a sheen exists at all, and it
    // was the one set wrong. Charlie's distribution is driven by `sin(H)`, so a *high*
    // sheen roughness spreads the lobe until it is nearly uniform over the hemisphere —
    // which makes it a constant added to every fragment, i.e. flat fill light, the exact
    // opposite of what a sheen is for. At 0.88 the material had no sheen, it had a slight
    // overall lift. Around 0.30 the lobe still has no hot core (that would be the specular
    // dot the spec forbids) but it does concentrate toward grazing angles, so it reads as a
    // soft band of light that travels around a form as the surface turns away from the eye.
    //
    // Note three energy-conserves this: `outgoingLight *= 1 - max3(sheenColor * sheen)`
    // before the lobe is added, so `sheen` is a *redistribution*, not a bonus. Past ~0.6
    // the body of the material visibly loses saturation and the clay turns to felt.
    sheen: opts.sheen ?? 0.42,
    sheenColor: opts.sheenColor ?? CLAY.wear,
    sheenRoughness: opts.sheenRoughness ?? 0.3,
    // Not "as low as possible": the GGX lobe at these roughnesses is very broad, so it is
    // a second, wider sheen rather than a highlight, and at F0 ~ 0.035 the Fresnel rim on
    // cream stays a warm sheen and never becomes a white outline.
    specularIntensity: opts.specularIntensity ?? 0.7,
    specularColor: CLAY.wear,
    ior: opts.ior ?? 1.48,
    envMapIntensity: opts.envMapIntensity ?? 1,
    vertexColors: true,
    transparent: opts.transparent ?? false,
    opacity: opts.opacity ?? 1,
    emissive: opts.emissive ?? "#000000",
    emissiveIntensity: opts.emissiveIntensity ?? 1,
    // Large cream gradients band badly in 8-bit; dithering is free and kills it.
    dithering: opts.dithering ?? true,
  });

  // Set after construction: three's `setValues` logs a warning for any key passed as
  // `undefined`, so optional parameters must never appear in the constructor object.
  if (opts.doubleSided) m.side = DoubleSide;
  if (opts.depthWrite === false) m.depthWrite = false;

  if (g > 0) {
    m.normalMap = grainMap(opts.grainScale ?? 1);
    m.normalScale.set(g, g);
  }

  (m as unknown as WithAttributeDefaults).defaultAttributeValues = DEFAULT_ATTRIBUTES;

  attachClayShader(m, {
    wrap: opts.wrap ?? 0.28,
    sss: opts.sss ?? CLAY.sss,
    sssStrength: opts.sssStrength ?? 0.5,
    sssPower: opts.sssPower ?? 2.6,
    ao: opts.ao ?? 1.45,
    edgeGloss: opts.edgeGloss ?? 0.26,
    aoIndirect: opts.aoIndirect ?? 0.55,
    shadowTint: opts.shadowTint ?? CLAY.shadowTint,
    // The default is derived, not dialled. `textures.ts` writes a two-octave, four-cell fbm
    // into the map's alpha; measured over the shipped 128px map its mean is 0.00000 and its
    // p1..p99 half-spread is 0.1706 (`MOTTLE_SPREAD`), so `DEFAULT_MOTTLE` is set to put the
    // p1..p99 albedo swing at ±5.9 %. Carried through the sRGB transfer that is **±6 of 255
    // on the bright channel of a lit clay surface, a p1..p99 span of ~12** — against the
    // 1-3 codes round 3 measured across five scenes, and still far short of blotching.
    mottle: opts.mottle ?? DEFAULT_MOTTLE,
    mottleRough: opts.mottleRough ?? DEFAULT_MOTTLE_ROUGH,
  });

  return markShared(m);
};

const cached = (key: string, opts: ClayInternal): MeshPhysicalMaterial => {
  let m = cache.get(key);
  if (!m) {
    m = build(opts);
    cache.set(key, m);
  }
  // Attributes the lookup to whichever scene is live, so a game's private material — and
  // the compiled program behind it — is reclaimed when it leaves. See `dispose.ts`.
  tagCacheEntry("material", key);
  return m;
};

registerSceneCache({
  name: "material",
  entries: () => cache.entries(),
  size: () => cache.size,
  evict: (key) => {
    const m = cache.get(key);
    if (!m) return;
    m.dispose();
    cache.delete(key);
  },
});

/**
 * Generic clay factory. `key` is the cache identity — two calls with the same key return
 * the same material and the second call's options are ignored, so keys must encode
 * whatever varies.
 */
export function clay(key: string, opts: ClayOptions = {}): MeshPhysicalMaterial {
  return cached(key, opts);
}

/** The hero material. Warm off-white that reads pink in the thin parts, never chalk. */
export function clayIvory(): MeshPhysicalMaterial {
  return cached("ivory", {
    color: CLAY.ivory,
    roughness: 0.74,
    wrap: 0.26,
    sss: CLAY.sss,
    sssStrength: 0.55,
    sssPower: 2.4,
    sheen: 0.44,
    sheenColor: "#fff3e2",
    sheenRoughness: 0.3,
    grain: 0.12,
    specularIntensity: 0.72,
    ao: 1.5,
    edgeGloss: 0.3,
  });
}

/**
 * Tooth enamel: the same clay body, read as slightly polished. Roughness stays at the
 * glossy end of the permitted 0.55–0.8 band rather than going properly shiny — a real
 * specular lobe on a 1-unit prop is a plastic tell.
 *
 * `grain` and `wrap` are pinned to the spec, not to taste. This is the mascot's own material
 * and the largest single-albedo surface a child looks at, and it shipped at `grain: 0.07`
 * against `3D-SPEC §3`'s 0.08–0.15 floor and `wrap: 0.28` against its ~0.35. Both are now at
 * the spec's numbers; combined with the retuned grain map above, a flat enamel face has a
 * measurable surface again instead of a single byte repeated across a fifth of the frame.
 */
export function clayEnamel(): MeshPhysicalMaterial {
  return cached("enamel", {
    color: CLAY.enamel,
    roughness: 0.58,
    wrap: 0.35,
    sss: CLAY.sss,
    sssStrength: 0.72,
    sssPower: 2.0,
    sheen: 0.5,
    sheenColor: "#fff2e4",
    sheenRoughness: 0.26,
    grain: 0.12,
    specularIntensity: 0.86,
    ior: 1.52,
    envMapIntensity: 1.06,
    ao: 1.5,
    edgeGloss: 0.34,
  });
}

/** Gum coral. Genuinely translucent material, so it gets the strongest scatter. */
export function clayGum(tone: "soft" | "main" | "deep" = "main"): MeshPhysicalMaterial {
  const color = tone === "soft" ? CLAY.gumSoft : tone === "deep" ? CLAY.gumDeep : CLAY.gum;
  return cached(`gum:${tone}`, {
    color,
    roughness: 0.7,
    wrap: 0.3,
    sss: CLAY.gumSoft,
    sssStrength: 0.7,
    sssPower: 2.2,
    sheen: 0.36,
    sheenColor: "#ffd8c8",
    sheenRoughness: 0.32,
    grain: 0.14,
    specularIntensity: 0.6,
    ao: 1.5,
    edgeGloss: 0.26,
  });
}

/**
 * Painted clay in one of the five departmental accent families.
 *
 * `opts` overrides the recipe below and is folded into the cache key, so two callers asking
 * for the same tone at different settings get different materials. It exists because round 4
 * had two games needing one knob each — `grainScale` on a small prop — and no overload to
 * ask for it: both ended up restating this whole recipe through `clay(key, opts)`, which
 * duplicates four values (`ao`, `edgeGloss`, `specularIntensity`, `sheenColor`) that are not
 * reachable from `ClayOptions` at all, and drifts the moment this recipe is retuned.
 */
export function clayAccent(
  family: AccentFamily,
  tone: AccentTone = "main",
  opts: ClayOptions = {}
): MeshPhysicalMaterial {
  return cached(`accent:${family}:${tone}${optionsKey(opts as Record<string, unknown>)}`, {
    color: ACCENTS[family][tone],
    roughness: 0.68,
    wrap: 0.24,
    // Scatter tinted with the family's own soft tone keeps saturated accents from
    // turning muddy-orange where the key wraps around them.
    sss: ACCENTS[family].soft,
    sssStrength: 0.38,
    sssPower: 2.8,
    sheen: 0.38,
    sheenColor: "#ffe7d4",
    sheenRoughness: 0.3,
    grain: 0.11,
    specularIntensity: 0.66,
    ao: 1.5,
    edgeGloss: 0.28,
    ...opts,
  });
}

/**
 * Every option a caller passed, in a stable order, as a cache key.
 *
 * The alternative — and what shipped until round 5 — is a hand-written concatenation of the
 * options someone remembered. `clayPainted`'s listed twelve of `ClayOptions`' twenty-seven,
 * so `grainScale`, `mottle`, `color`, `ao`, `edgeGloss`, `shadowTint`, `specularIntensity`,
 * `sheenColor`, `ior`, `doubleSided`, `depthWrite` and `dithering` were all invisible to it:
 * two callers asking for the same hex at different values silently shared the first one's
 * material. Two games filed exactly that against `grainScale` in round 4, and the reason
 * both had to route around this factory is that a list is a thing that goes stale — adding
 * a field to `ClayOptions` and forgetting the key is a silent, correct-looking edit.
 *
 * Reading the object removes the list. Keys are sorted so property order cannot change the
 * key, `undefined` is dropped so an explicitly-absent option keys identically to an omitted
 * one, and numbers go through `String` so `0.30` and `0.3` agree.
 */
function optionsKey(opts: Record<string, unknown>): string {
  const names = Object.keys(opts).sort();
  let out = "";
  for (const n of names) {
    const v = opts[n];
    if (v === undefined) continue;
    out += `|${n}=${String(v)}`;
  }
  return out;
}

/** Arbitrary painted clay. Keyed on the colour plus every option the caller overrode. */
export function clayPainted(hex: string, opts: ClayOptions = {}): MeshPhysicalMaterial {
  const key = `painted:${hex}${optionsKey(opts as Record<string, unknown>)}`;
  return cached(key, {
    roughness: 0.68,
    wrap: 0.24,
    sss: CLAY.sss,
    sssStrength: 0.32,
    sheen: 0.38,
    sheenColor: "#ffe7d4",
    sheenRoughness: 0.3,
    grain: 0.11,
    specularIntensity: 0.66,
    ao: 1.5,
    edgeGloss: 0.28,
    ...opts,
    color: hex,
  });
}

/** Soft matte rubber — toothbrush grips, bumpers. Velvet sheen, almost no specular. */
export function clayRubber(hex: string): MeshPhysicalMaterial {
  return cached(`rubber:${hex}`, {
    color: hex,
    roughness: 0.84,
    wrap: 0.22,
    sss: CLAY.sss,
    sssStrength: 0.16,
    sssPower: 3.2,
    // Rubber is the one surface in the product that really is nearly Lambertian, so it
    // keeps a wide sheen and almost no specular — the velvet reading, on purpose.
    sheen: 0.5,
    sheenColor: "#fff6ec",
    sheenRoughness: 0.62,
    grain: 0.18,
    specularIntensity: 0.24,
    ao: 1.4,
    edgeGloss: 0.2,
  });
}

/**
 * Milky translucent — cups, water, the polaroid's cover. Deliberately *not*
 * `transmission`: that forces three's extra transmission render pass and a second
 * full-scene draw, which the 60fps-on-a-tablet budget cannot pay for. Blended opacity plus
 * a heavy scatter term reads the same at this scale.
 */
export function softGlass(hex = "#e7f0f5"): MeshPhysicalMaterial {
  return cached(`glass:${hex}`, {
    color: hex,
    roughness: 0.24,
    wrap: 0.4,
    sss: "#ffffff",
    sssStrength: 0.85,
    sssPower: 1.6,
    sheen: 0,
    grain: 0.04,
    specularIntensity: 0.95,
    ior: 1.45,
    envMapIntensity: 1.25,
    transparent: true,
    opacity: 0.42,
    doubleSided: true,
    depthWrite: false,
  });
}

/**
 * Per-channel white balance for the ground albedo, in linear space.
 *
 * This is the one material in the product with a *measurable* contract: the ground plane and
 * the hub backdrop have to come out of the renderer at `NEUTRAL.page` so the canvas melts
 * into the DOM page behind it. They cannot, if they are painted `NEUTRAL.page`: the studio
 * illuminant is warm by design — a `#FFF0DC` key carrying roughly two thirds of the light on
 * an up-facing surface, plus a warm key softbox and a warm bounce card in the environment —
 * and warm light on warm cream multiplies. Measured on the probe scene, a floor painted
 * `#EDE7DC` rendered as `#EBDCC7`: twenty-one points of blue short of the brand.
 *
 * Neutralising the light instead would cost the look (that warm key is the whole point) and
 * would still have to come out of the spec's fixed key colour. So the floor is treated the
 * way a stage backdrop is: colour-matched to the plate. The vector below is
 * `target / measured` per channel, derived from that render, and it is applied to
 * `NEUTRAL.page` rather than hard-coded as a hex so the calibration follows the token if the
 * brand cream ever moves.
 *
 * **Re-measure this whenever the key, the studio panels or `TONE.exposure` change** — it is
 * a calibration against a specific illuminant, not a constant of nature. Sample a lit patch
 * of empty floor in `?probe=1` and compare it to `#EDE7DC`.
 */
const GROUND_WHITE_BALANCE = new Color().setRGB(1.028, 1.132, 1.278, LinearSRGBColorSpace);

const GROUND_ALBEDO = `#${new Color(NEUTRAL.page).multiply(GROUND_WHITE_BALANCE).getHexString(SRGBColorSpace)}`;

/**
 * The cream floor. Same hue as the page and the fog, so the ground plane, the fog and the
 * DOM background converge instead of producing a horizon line. No sheen at all — a sheen
 * streak across a floor-sized quad is the single most obvious "this is a 3D viewport" tell.
 */
export function clayGround(): MeshPhysicalMaterial {
  return cached("ground", {
    color: GROUND_ALBEDO,
    roughness: 0.84,
    // The floor keeps the widest wrap in the product. It is a single huge quad with one
    // normal, so it has no form to model — all a narrow wrap would buy is a hard-edged
    // brightness step where the key's own falloff crosses it. What it must do instead is
    // land on exactly #EDE7DC so the canvas melts into the DOM page.
    wrap: 0.36,
    sss: CLAY.sss,
    sssStrength: 0.12,
    sssPower: 3.5,
    sheen: 0,
    grain: 0.05,
    // Pinned, along with `roughness` and `envMapIntensity`: GROUND_WHITE_BALANCE was
    // measured against exactly these, and any of them moving re-tints the page match.
    specularIntensity: 0.12,
    ior: 1.42,
    envMapIntensity: 0.92,
    // A flat plane has no curvature, so there is nothing for the AO terms to find; leaving
    // them at strength keeps the shared program key and costs nothing.
    ao: 1,
    // The one surface in the product that must NOT be mottled. `GROUND_WHITE_BALANCE` above
    // exists so this plane renders back to `NEUTRAL.page` and the canvas melts into the DOM
    // page behind it; a ±6 % albedo swing across it would print the 3D region as a visibly
    // textured rectangle against a flat CSS cream. The mottle signal is zero-mean, so at 0
    // this material renders byte-identically to the calibration it was measured against.
    mottle: 0,
    mottleRough: 0,
  });
}

/* ------------------------------------------------------------------ */
/* Contact blob shadows                                                */
/* ------------------------------------------------------------------ */

const DEFAULT_BLOB_OPACITY = 0.45;

/**
 * What callers pass is a *relative* density, not a final alpha — the nine games are already
 * written against the 0.25-0.45 band and must not have to be re-tuned one by one. A shadow
 * that only removes a third of the light under a prop reads as a smudge the prop happens to
 * be standing near; gluing an object to the ground needs the contact point to be genuinely
 * dark. This gain maps the band the games use onto the band that actually reads, and the
 * ceiling keeps the darkest blob short of a hole in the floor.
 */
const BLOB_GAIN = 1.55;
const BLOB_MAX = 0.86;

/** Warm dark, never neutral black — the bounce card means no shadow in this world is grey. */
const BLOB_TINT = CLAY.crevice;

const blobCache = new Map<number, MeshBasicMaterial>();

type ImageLike = {
  data?: ArrayLike<number>;
  width?: number;
  height?: number;
  getContext?: (id: "2d") => CanvasRenderingContext2D | null;
};

/** Reads one RGBA texel from either a DataTexture's typed array or a canvas-backed one. */
const readTexel = (tex: Texture, u: number, v: number): ArrayLike<number> | null => {
  const img = tex.image as ImageLike | undefined;
  const w = img?.width ?? 0;
  const h = img?.height ?? 0;
  if (!img || w < 1 || h < 1) return null;

  const x = Math.min(w - 1, Math.max(0, Math.round(u * (w - 1))));
  const y = Math.min(h - 1, Math.max(0, Math.round(v * (h - 1))));

  if (img.data) {
    const i = (y * w + x) * 4;
    return i + 3 < img.data.length ? [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]] : null;
  }
  if (typeof img.getContext === "function") {
    try {
      return img.getContext("2d")?.getImageData(x, y, 1, 1).data ?? null;
    } catch {
      return null; // tainted canvas
    }
  }
  return null;
};

/**
 * `radialShadowTexture()` could reasonably be authored either as a luminance mask (white
 * blob, opaque everywhere) or as an alpha ramp (white RGB, alpha falls off). Those need
 * opposite wiring — `alphaMap` vs `map` — and getting it wrong yields either an invisible
 * blob or a solid square. Rather than couple this file to the current implementation,
 * sample the centre and a corner once and let the data decide.
 */
const wireBlobTexture = (mat: MeshBasicMaterial, tex: Texture): void => {
  const mid = readTexel(tex, 0.5, 0.5);
  const edge = readTexel(tex, 0.02, 0.02);
  // Default to `map`: the alpha ramp is the convention textures.ts ships today.
  let useAlphaChannel = true;
  if (mid && edge) useAlphaChannel = Math.abs(mid[3] - edge[3]) >= Math.abs(mid[1] - edge[1]);

  if (useAlphaChannel) mat.map = tex;
  else mat.alphaMap = tex;
};

const blobMaterial = (opacity: number): MeshBasicMaterial => {
  // Quantised so a scene full of props shares two or three materials, not twenty.
  const q = Math.max(0.05, Math.min(BLOB_MAX, Math.round(opacity * BLOB_GAIN * 20) / 20));
  let m = blobCache.get(q);
  if (!m) {
    m = new MeshBasicMaterial({
      color: BLOB_TINT,
      transparent: true,
      opacity: q,
      depthWrite: false,
      // Blobs sit coplanar with the ground; polygon offset is cheaper and more reliable
      // than nudging every caller's Y by an epsilon they have to remember.
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      toneMapped: true,
      fog: true,
      // A shadow multiplies its receiver. It does not fade it toward brown.
      //
      // Stock alpha blending computes `src*a + dst*(1-a)`, which *replaces* the receiver's
      // colour with the blob's own. Round 3 measured exactly that: under a blob, a lit coral
      // surface fell from C* 68.6 to C* 36.1 with a 6-degree hue shift, while the real PCSS
      // shadow a few pixels away held 91 % of the same surface's chroma. On anything
      // saturated the blob landed as mud, which is the one thing a decal must not do.
      //
      // `premultipliedAlpha` makes three emit `rgb * a` (the `premultiplied_alpha_fragment`
      // chunk runs *after* tone mapping and the colour-space transform, so the tint is
      // already in output space); `DstColorFactor` / `OneMinusSrcAlphaFactor` then evaluates
      //
      //     dst * (tint * a) + dst * (1 - a)  ==  dst * mix( 1, tint, a )
      //
      // — a true multiply, at strength `a`. Recomputed against the same sample: on a lit
      // coral receiver at the band's typical `a = 0.7`, the old lerp took C* 64.0 to 31.5
      // (**49 % kept**, hue +5.8 deg) — which reproduces the audit's 68.6 -> 36.1 / +6 deg
      // almost exactly — and the multiply takes it to 51.8 (**81 % kept, hue +1.2 deg**),
      // i.e. into the same band as the real PCSS shadow's measured 91 % / +1.5 deg. On the
      // cream floor the two agree to within nine 8-bit codes, so the eight games whose
      // ground is cream need no re-tuning of the density they already pass.
      blending: CustomBlending,
      blendEquation: AddEquation,
      blendSrc: DstColorFactor,
      blendDst: OneMinusSrcAlphaFactor,
      // Alpha is passed through untouched — `0 * srcA + 1 * dstA`. Stated rather than left
      // to three's `blendSrcAlpha ?? blendSrc` fallback, which would apply `DST_COLOR` to
      // the alpha channel and arrive at the same answer by accident. It matters because the
      // canvas is created with `alpha: true`: a blob that spills past the ground plane now
      // multiplies a cleared framebuffer, contributes nothing, and leaves the page showing
      // through — where the old lerp painted brown onto empty canvas.
      blendSrcAlpha: ZeroFactor,
      blendDstAlpha: OneFactor,
      premultipliedAlpha: true,
    });
    // 0.42 rather than 0.55: a slightly fatter dark core with a shorter tail. See the note
    // on the falloff in `textures.ts` — the blob has to end well inside its own quad.
    wireBlobTexture(m, radialShadowTexture({ size: 256, softness: 0.42 }));
    markShared(m);
    blobCache.set(q, m);
  }
  return m;
};

/** The default contact-blob material. `ContactBlob` uses the quantised variants. */
export function shadowBlobMaterial(): MeshBasicMaterial {
  return blobMaterial(DEFAULT_BLOB_OPACITY);
}

/** @internal — `Rig.tsx` only. Kept out of the public contract deliberately. */
export const _blobMaterialFor = blobMaterial;

/* ------------------------------------------------------------------ */
/* Teardown                                                            */
/* ------------------------------------------------------------------ */

/**
 * Frees every cached material. Textures are *not* freed here: the grain and blob maps
 * belong to `textures.ts`, which owns their lifetime via `disposeTextureCache()`.
 */
export function disposeMaterialCache(): void {
  for (const m of cache.values()) m.dispose();
  cache.clear();
  for (const m of blobCache.values()) m.dispose();
  blobCache.clear();
  // The grain variants are textures, and `textures.ts` owns every texture's lifetime through
  // `disposeTextureCache()` — dropping the lookup here is what this function is for.
  grainVariants.clear();
}
