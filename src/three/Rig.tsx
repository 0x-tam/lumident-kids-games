/**
 * The standard lighting rig. Every scene in the product mounts exactly one.
 *
 * The heavy lifting is done by the code-built studio PMREM in `env.ts`; the single
 * `directionalLight` here exists almost entirely to cast the one shadow map we can afford.
 * Its ortho frustum is sized from `shadowArea` rather than left at three's default 5-unit
 * box, because a shadow map spread over a frustum ten times larger than the play area is
 * the difference between a soft contact shadow and a staircase.
 *
 * There is no `useFrame` in this file. The rig is static: it costs one layout effect on
 * mount and nothing per frame.
 */
import { useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import { useThree } from "@react-three/fiber";
import { PlaneGeometry, Vector3, type DirectionalLight } from "three";
import { applySceneDefaults } from "./env";
import { markShared } from "./dispose";
import { CLAY_SOFT_SHADOWS, _blobMaterialFor, clayGround } from "./materials";
import { CONTACT_BLOB_VISIBLE_FRACTION } from "./textures";
import { quality } from "./quality";
import { CONTEXT_RESTORED_EVENT } from "./Stage";
import { useStore } from "./store";
import { KEY_LIGHT, STUDIO } from "./tokens";

/** Direction the key arrives *from*, normalised once. Scaled per scene by `shadowArea`. */
const KEY_DIR = new Vector3(
  KEY_LIGHT.position[0],
  KEY_LIGHT.position[1],
  KEY_LIGHT.position[2]
).normalize();

/**
 * The key's angular size, as the tangent of its half-angle — i.e. how many world units of
 * penumbra half-width the shadow gains per world unit of gap between caster and receiver.
 *
 * This is the one number that decides how soft every cast shadow in the product is, and it
 * is a *physical* description of the light rather than a filter width: a shadow's penumbra
 * widens with distance from the contact point, and a shadow whose edge is the same directly
 * under a prop as it is a unit above it reads as a dark decal stuck to the floor. The clay
 * shader's PCSS filter (`materials.ts`) does the widening; this sets the rate.
 *
 * 0.10 is the key softbox in `STUDIO.key` read as a real source: 4.4 × 3.2 units at ~6.6
 * units out is a half-angle whose tangent is ~0.25 across the long axis, which is far too
 * soft to keep any shadow at all, so it is stopped down to the value that keeps the
 * penumbra a shadow. What it produces, at design framing (28° lens, ~12 units out,
 * ~134 screen px per world unit):
 *
 *   | caster→receiver gap *along the key* | penumbra width | on screen |
 *   |---|---|---|
 *   | contact (0)   | `2 × MIN` texels | **6.3 px** (the sampling floor, not the light) |
 *   | 0.3 units     | 0.060 units | **8.0 px** |
 *   | 0.6 units     | 0.120 units | **16 px** |
 *   | 1.0 units     | 0.200 units | **27 px** |
 *
 * — over the 5 px floor a soft shadow needs everywhere, and genuinely widening rather than
 * translating. The gap is measured along the light, so a prop lifted `h` off the floor is
 * `h / sin 47.6° = 1.36 h` up this table, and the penumbra it casts is stretched again by
 * the key's incidence on the floor: both make the shadow softer than the column above, never
 * harder. See `docs/3D-SPEC.md §2` for why this replaced a fixed-width kernel.
 */
const SHADOW_SOFTNESS = 0.1;

/**
 * Fixed penumbra half-width in world units, for the low tier's stock 17-tap kernel.
 *
 * Kept because the low tier does not compile the PCSS filter (20 texture fetches against
 * 17, gated in `quality.ts`), and three's `SHADOWMAP_TYPE_PCF` branch can only do one width
 * for the whole frame. The conversion below turns it into texels so that the softness is a
 * fixed *world* width whatever a game's `shadowArea` and the tier's map size are — without
 * it a tight scene gets a hard cutout ellipse and a wide one a vague smudge from the same
 * number. 0.032 spans 8.6 screen px at design framing.
 */
const SHADOW_PENUMBRA_FLAT = 0.032;

const GROUND_ROT: [number, number, number] = [-Math.PI / 2, 0, 0];

/**
 * Name on the ground mesh, so anything mounted *inside* a game's scene can find out whether
 * that game draws a floor at all.
 *
 * `celebrate.tsx` is the consumer: since round 3's A10 the celebration renders inside the
 * game's own view, and it has to stand on the game's ground so the game's shadow pass
 * catches it. Seven of the nine games draw one; Spot the Difference passes `ground={false}`
 * (it looks straight at two framed pictures) and declares a `groundY` 2.1 units below the
 * room centre that nothing renders. Inferring "is there a floor" from geometry or from a
 * distance heuristic was tried and is not reliable; a name is.
 */
export const RIG_GROUND_NAME = "lumident-rig-ground";
const BLOB_ROT: [number, number, number] = [-Math.PI / 2, 0, 0];
const ORIGIN: [number, number, number] = [0, 0, 0];

/**
 * One unit quad shared by every contact blob in the app. Passed by prop rather than as a
 * `<planeGeometry>` child so R3F never disposes it on unmount; `markShared` keeps
 * `disposeObject3D` off it too.
 */
let unitPlane: PlaneGeometry | null = null;
const getUnitPlane = (): PlaneGeometry => {
  if (!unitPlane) unitPlane = markShared(new PlaneGeometry(1, 1));
  return unitPlane;
};

export type RigProps = {
  /** World Y of the floor. The shadow frustum and the key are both centred on it. */
  groundY?: number;
  groundSize?: number;
  /** Side length of the square the shadow map must cover, in world units. */
  shadowArea?: number;
  fogDensity?: number;
  envIntensity?: number;
  ground?: boolean;
  keyIntensity?: number;
  children?: ReactNode;
};

export function Rig({
  groundY = 0,
  groundSize = 60,
  shadowArea = 12,
  fogDensity,
  envIntensity,
  ground = true,
  keyIntensity,
  children,
}: RigProps): JSX.Element {
  const scene = useThree((s) => s.scene);
  const gl = useThree((s) => s.gl);
  // Re-renders only when the device tier is degraded — a discrete, once-a-session event.
  const shadowMapSize = useStore(quality).shadowMapSize;
  const lightRef = useRef<DirectionalLight>(null);
  const groundMaterial = useMemo(() => clayGround(), []);

  useLayoutEffect(() => {
    const apply = () => {
      applySceneDefaults(scene, gl, { fogDensity });
      scene.environmentIntensity = envIntensity ?? STUDIO.envIntensity;
    };
    apply();
    // Dev-only look-dev handle. Every scene in the product lives inside a drei <View>, which
    // owns its own THREE.Scene, and nothing else on the page exposes one — so without this
    // there is no way to inspect materials, vertex attributes or lighting from a console or
    // an automated driver. Stripped from production by the DEV guard.
    if (import.meta.env.DEV) {
      (window as unknown as { __rig?: unknown }).__rig = { scene, gl };
    }
    // Stage rebuilds the studio PMREM after a context restore and fires this once it is
    // ready. Without re-applying, this view's scene keeps pointing at the dead texture —
    // Stage only re-runs the defaults on the root scene, not on every View's own scene.
    window.addEventListener(CONTEXT_RESTORED_EVENT, apply);
    return () => {
      window.removeEventListener(CONTEXT_RESTORED_EVENT, apply);
      // Each drei <View> owns its scene, so the rig is responsible for handing it back
      // empty. The PMREM itself is shared and survives.
      scene.environment = null;
      scene.fog = null;
    };
  }, [scene, gl, fogDensity, envIntensity]);

  useLayoutEffect(() => {
    const light = lightRef.current;
    if (!light) return;

    const half = Math.max(0.5, shadowArea * 0.5);
    // Far enough back that props up to ~2 units tall stay inside the frustum, close
    // enough that near/far stay tight and the depth buffer keeps its precision.
    const dist = half * 2.4 + 6;
    const depth = half * 2.2;

    light.position.set(KEY_DIR.x * dist, groundY + KEY_DIR.y * dist, KEY_DIR.z * dist);
    light.target.position.set(0, groundY, 0);
    // The target has to live in the graph or its world matrix never refreshes, and the
    // shadow camera silently keeps aiming at wherever it was first placed.
    scene.add(light.target);

    const cam = light.shadow.camera;
    cam.left = -half;
    cam.right = half;
    cam.top = half;
    cam.bottom = -half;
    cam.near = Math.max(0.1, dist - depth);
    cam.far = dist + depth;
    cam.updateProjectionMatrix();

    const shadow = light.shadow;
    // A mapSize change after the target exists needs the old target thrown away, or three
    // keeps rendering into the previous resolution.
    if (shadow.map && shadow.mapSize.x !== shadowMapSize) {
      shadow.map.dispose();
      shadow.map = null;
    }
    shadow.mapSize.set(shadowMapSize, shadowMapSize);
    shadow.bias = KEY_LIGHT.shadowBias;
    shadow.normalBias = KEY_LIGHT.shadowNormalBias;
    // How much light a shadow may take away. See the token: a cast shadow on cream is filled
    // by bounce off the lit cream around it, so it deepens and warms rather than blanking.
    shadow.intensity = KEY_LIGHT.shadowIntensity;
    /*
     * `shadow.radius` carries two different quantities, one per shadow filter, and
     * `CLAY_SOFT_SHADOWS` is the single source of truth for which — it is read from the
     * same frozen `quality.softShadows` the clay shader compiled against, so the uniform
     * and the branch that reads it can never disagree.
     *
     *  - **PCSS (mid/high).** "Penumbra texels per unit of *normalised* depth gap." The
     *    shadow camera is orthographic, so its depth buffer is linear and one unit of
     *    normalised depth is `depthRange` world units; multiplying by the map's texel
     *    density and by the key's angular size collapses the whole conversion into one
     *    number the fragment shader can multiply the measured blocker gap by. Note what the
     *    algebra does to `half`: `texelsPerUnit ∝ 1/half` and `depthRange ∝ half`, so the
     *    result is `SHADOW_SOFTNESS × 2.2 × shadowMapSize` — identical in every scene. The
     *    penumbra is therefore a fixed world width per unit of gap, whatever a game passes
     *    as `shadowArea`, and it still halves on the low tier's smaller map.
     *  - **Stock PCF (low).** A flat penumbra width in texels, from a fixed world width.
     */
    const texelsPerUnit = shadowMapSize / (half * 2);
    const depthRange = cam.far - cam.near;
    shadow.radius = CLAY_SOFT_SHADOWS
      ? SHADOW_SOFTNESS * depthRange * texelsPerUnit
      : Math.max(1.5, Math.min(9, SHADOW_PENUMBRA_FLAT * texelsPerUnit));
    shadow.needsUpdate = true;

    return () => {
      scene.remove(light.target);
      shadow.map?.dispose();
      shadow.map = null;
    };
  }, [scene, shadowArea, groundY, shadowMapSize]);

  return (
    <>
      <directionalLight
        ref={lightRef}
        color={KEY_LIGHT.color}
        intensity={keyIntensity ?? KEY_LIGHT.intensity}
        castShadow
      />
      {ground ? (
        <mesh
          name={RIG_GROUND_NAME}
          rotation={GROUND_ROT}
          position-y={groundY}
          receiveShadow
          material={groundMaterial}
        >
          <planeGeometry args={[groundSize, groundSize]} />
        </mesh>
      ) : null}
      {children}
    </>
  );
}

/**
 * The blob's radius for a prop of a given footprint — the answer to "how big should this
 * quad be", which nothing in the product could give before.
 *
 * Round 3 measured a contact blob at roughly three times its prop's footprint, spilling off
 * the mat it belonged to and onto the cream page, because every caller had guessed a
 * multiple by eye. Two numbers decide it and both are derived:
 *
 *  - `CONTACT_BLOB_VISIBLE_FRACTION` (0.827) is where the profile in `textures.ts` stops
 *    being able to move an 8-bit output byte, solved from the profile itself. Anything past
 *    it is quad, not shadow — so the *visible* blob is 0.827 of the radius and the radius
 *    has to be that much larger than the darkness the caller actually wants.
 *  - `SHADOW_SOFTNESS` is the key's tangent half-angle, so a prop held `lift` units off the
 *    floor throws a penumbra `SHADOW_SOFTNESS * lift` wider than its own silhouette. The
 *    blob has to cover that or its own edge cuts across the real shadow's.
 *
 * `footprint` is the prop's own silhouette radius on the floor, in world units — take it
 * from `geometry.boundingBox` or from the half-width the game already knows, never from a
 * guess. The result is ~1.21x the footprint for a prop standing on the floor.
 */
export function contactRadiusFor(footprint: number, lift = 0): number {
  const reach = Math.max(0.001, footprint) + SHADOW_SOFTNESS * Math.max(0, lift);
  return reach / CONTACT_BLOB_VISIBLE_FRACTION;
}

/**
 * How a contact blob answers the caster lifting off the receiver.
 *
 * Round 4's A3: "the Healthy or Not tooth's shadow holds L\* 77.3 → 77.0 across 112 px and
 * then falls off a cliff in ~10 px; the tooth's head is 0.6 u off the ground and its shadow
 * tip is exactly as hard as its foot contact." A decal that does not respond to height is a
 * sticker, and — worse — a *big* one sits on top of the PCSS penumbra and hides the entire
 * solve, which is how round 4's penumbra measurement came to be taken with all sixteen blobs
 * forced invisible: with them visible there was nothing to measure.
 *
 * Two responses, both physical, both driven by the same `lift`:
 *
 *  - **Radius grows.** A source of angular half-size `SHADOW_SOFTNESS` throws a penumbra
 *    `SHADOW_SOFTNESS × lift` wider than the caster's own silhouette. `contactRadiusFor`
 *    already knew this; nothing was passing it a `lift`.
 *  - **Opacity falls, and reaches zero.** The blob exists to supply the near-black pinch the
 *    shadow map cannot resolve — one 1024² texture over a 12-unit play area is 85 texels per
 *    unit, and a contact gradient is finer than that. That pinch is a *contact* term: it is
 *    an ambient-occlusion effect of two surfaces being close, and it vanishes as they
 *    separate. Past `CONTACT_FADE_LIFT` the real cast shadow is the whole shadow, which is
 *    exactly the regime the PCSS filter was written for and the regime the decal was hiding.
 *
 * `CONTACT_FADE_LIFT` is one shadow-map texel of gap at the tightest framing the product
 * ships: a 512-map (low tier) over a 12-unit `shadowArea` is 42.7 texels per unit, so a
 * caster 0.023 units up is already at the map's resolution limit and the map can take over.
 * Rounded up to 0.05 to leave the handover a margin rather than a step — the two overlap
 * through the fade rather than swapping.
 *
 * Sliding Puzzle solved the same problem per tile at `sliding-puzzle/scene.tsx:139-160`
 * (a `BLOB_TIGHTEN`/`BLOB_DARK` pair driven by the tile's rise); this is that behaviour in
 * the shared component, with the sign on radius taken from the light's angular size rather
 * than from taste.
 */
const CONTACT_FADE_LIFT = 0.05;

/** Peak opacity as a function of lift, 1 at contact and 0 at `CONTACT_FADE_LIFT`. */
const contactFade = (lift: number): number => {
  if (lift <= 0) return 1;
  if (lift >= CONTACT_FADE_LIFT) return 0;
  const t = 1 - lift / CONTACT_FADE_LIFT;
  // Smooth at both ends, so a prop settling onto the floor does not print a step.
  return t * t * (3 - 2 * t);
};

export type ContactBlobProps = {
  position?: [number, number, number];
  /**
   * Quad half-width. Prefer `contactRadiusFor(footprint, lift)` over a hand-set number —
   * see that function for why a guessed multiple is what put a blob over the page.
   */
  radius?: number;
  opacity?: number;
  /**
   * How far the caster currently stands above the receiver, in world units.
   *
   * Drives radius **and** opacity — see `CONTACT_FADE_LIFT`. Leave it at 0 only for a prop
   * that genuinely rests on the floor and never leaves it (a tray, a mat, a board); anything
   * that lifts, hops, flies or is simply held above the ground must pass it, or its shadow is
   * a sticker and it is standing on top of the product's real one.
   *
   * A prop that *animates* its height cannot use this prop at all — it would re-render React
   * every frame, which `3D-SPEC §1.4` forbids. Drive an instanced blob from `useFrame`
   * instead, the way Sliding Puzzle does, and use `contactRadiusFor` + `contactOpacityFor`
   * to get the same two curves.
   */
  lift?: number;
  rotation?: [number, number, number];
};

/**
 * The blob's peak opacity for a caster at `lift`, given the density the caller wants at
 * contact. The per-frame half of `ContactBlob`, for a scene driving an instanced blob.
 */
export function contactOpacityFor(opacity: number, lift = 0): number {
  return opacity * contactFade(lift);
}

/**
 * Close contact darkening under a prop.
 *
 * The shadow map is one 1024² texture stretched across the whole play area, so it can
 * never resolve the near-black pinch right where an object touches the floor — that
 * gradient is most of what makes a prop look *placed* rather than hovering. This quad
 * supplies it for free, and on the low tier it stands in for the shadow map entirely under
 * scattered props.
 *
 * Two things about it changed after round 3 photographed it reading as a decal, and both
 * live outside this component: the alpha profile is now strictly monotonic with no plateau
 * (`textures.ts::radialShadowTexture`), and the material multiplies its receiver instead of
 * fading it toward brown (`materials.ts::blobMaterial`). What is left here is the size, and
 * that is what `contactRadiusFor` above is for.
 */
export function ContactBlob({
  position = ORIGIN,
  radius = 0.6,
  opacity = 0.45,
  lift = 0,
  rotation = BLOB_ROT,
}: ContactBlobProps): JSX.Element {
  const faded = contactOpacityFor(opacity, lift);
  // Quantised inside the factory, so a scene of twenty props shares one or two materials.
  const material = useMemo(() => _blobMaterialFor(faded), [faded]);
  // The penumbra allowance is on the *reach*, so the quad grows with the caster's height by
  // exactly the light's angular size — see `contactRadiusFor`.
  const grown = radius + (SHADOW_SOFTNESS * Math.max(0, lift)) / CONTACT_BLOB_VISIBLE_FRACTION;
  // Faded out entirely: the real cast shadow is the whole shadow up here. Rendering a
  // zero-opacity quad would still cost a draw call and still sit in the depth-sorted
  // transparent pass, which is what a decal covering the PCSS solve looks like from the
  // profiler's side.
  if (faded <= 0) return <group />;
  return (
    <mesh
      position={position}
      rotation={rotation}
      scale={grown * 2}
      geometry={getUnitPlane()}
      material={material}
      renderOrder={2}
    />
  );
}
