# 3D Foundation — public API and integration notes

Status: **integrated, type-clean, builds, verified rendering in a browser.**
Audience: the nine game agents. `docs/3D-SPEC.md` still wins on anything this file is
silent about.

Everything below is what actually shipped, verified against the source, not what was
planned. Signatures are exact.

---

## 0. Read this first — the six things that will bite you

1. **3D components must not read React context.** They render inside the R3F root, which is
   a different reconciler root from the DOM tree. `GameAreaContext` is the one exception and
   it is a *DOM-side* context — read it above `<Scene3D>`, never below. Everything else
   comes from the module stores in `src/three/store.ts`.
2. **Any DOM overlay inside `GameShell`'s play area must sit at `z-index: 1` or above.**
   `Scene3D` portals its `<View>` div into that element and reserves `z-index: 0` with
   `pointer-events: auto` — that div is where R3F attaches its pointer listeners. A static
   overlay lands underneath it and becomes unclickable.
3. **`<Scene3D index>` must stay ≥ 1.** `Stage` clears the framebuffer at render priority
   `-1`; drei's `<View>` never clears and R3F's automatic root render is switched off. A view
   at index 0 or lower draws *before* the clear and vanishes.
4. **`Stage`'s own `children` render into the root scene, which is deliberately never
   rendered.** Meshes put there are invisible. Put scene content in a `<Scene3D>`.
5. **Zero allocations in `useFrame`.** No `new`, no array/object literals, no closures, no
   `map`/`filter`/`forEach`, no template literals. Module-level scratch `Vector3`/`Quaternion`
   /`Matrix4`, always. This is audited.
6. **Geometry carries a baked `color` attribute and every clay material has
   `vertexColors: true`.** If you hand a clay material a geometry you built yourself with a
   raw three constructor, it still renders correctly — `materials.ts` sets
   `defaultAttributeValues = { color: [1,1,1], uv: [0,0] }` — but you lose the curvature
   darkening that sells the clay. Build geometry through `geometry.ts`.

---

## 1. Contract compliance

Every module matches the cross-module contract **verbatim**. No breaking deviation was
found or introduced. The additions below are additive only — nothing that codes against the
contract is affected.

| Module | Addition | Notes |
|---|---|---|
| `geometry.ts` | `type ToothKind = 'molar' \| 'incisor' \| 'baby'` | the type of `toothGeometry`'s `kind` param |
| `materials.ts` | `_blobMaterialFor(opacity)` | `@internal`, used only by `ContactBlob`. Do not import. |
| `Stage.tsx` | `CONTEXT_RESTORED_EVENT` | window event name, fired after the studio PMREM is rebuilt |
| `Scene3D.tsx` | `type SceneCamera` | structurally identical to the inline `camera` prop type |
| `physics.ts` | `type CollisionCallback` | |
| `hit.tsx` | `type HitTargetProps` | |
| `text.ts` | `type TextOptions`, `type TextTexture` | |
| `selftest.ts` | `disposeSelfTestResources()`, `type DiffCluster`, `type SelfTestState` | `DiffCluster` adds `cx`/`cy` centroids on top of the contracted `{x,y,w,h,count}` |
| `perf.ts` | `type PerfMark`, `type PerfViolation`, `type PerfAPI` | `window.__perf` carries extra fields, see §11 |

**Filename note:** the spec's §7 table says `src/three/hit.ts`; the real file is
`src/three/hit.tsx` (it contains JSX). Import from `./three/hit` and the extension resolves.

---

## 2. `src/three/tokens.ts` — brand constants (frozen)

```ts
const UNIT: 1                                  // 1 world unit = 10cm; hero tooth ≈ 1.0 unit
type AccentFamily = 'red' | 'coral' | 'peach' | 'rose' | 'mauve'
type AccentTone   = 'soft' | 'main' | 'deep'
const ACCENTS: Record<AccentFamily, Record<AccentTone, string>>
const NEUTRAL: { page; surface; well; line; ink; inkMid; inkSoft }
const CLAY: { ivory; ivoryDeep; sss; enamel; enamelShadow; gum; gumDeep; gumSoft; crevice; wear }
const STUDIO: { key; bounce; rim; skyTop; skyBottom; envIntensity }
const KEY_LIGHT: { color; intensity; position; shadowBias; shadowNormalBias; shadowRadius }
const CAMERA: { fov: 28; fovRange: [26, 32]; near: 1; far: 60 }
const FOG:  { color: '#ede7dc'; density: 0.014 }
const TONE: { exposure: 1.05 }
function color(hex: string): THREE.Color          // cached — never allocate a Color per frame
function accent(family: AccentFamily, tone?: AccentTone): string
```

Colours are sRGB hex exactly as in `src/index.css`. three's ColorManagement converts on
assignment — **never pre-convert.**

---

## 3. `src/three/store.ts` — module stores (frozen)

```ts
type Store<T> = { get(): T; set(next: T | ((prev: T) => T)): void; subscribe(fn: () => void): () => void }
function createStore<T>(initial: T): Store<T>
function useStore<T>(store: Store<T>): T          // DOM-side only; never in a hot path

const reducedMotion: Store<boolean>               // live-bound to the media query
const isReduced: () => boolean                    // synchronous read for useFrame

type Route = { screen: 'hub' | 'game'; gameId: string | null }
const route: Store<Route>
const transition: { value: number; target: number }   // 0 = hub, 1 = in a game

const FLAGS: {
  selftest: string | null   // ?selftest=spot
  perf: boolean             // ?perf
  tier: string | null       // ?tier=low|mid|high  (honoured by quality.ts)
  reduced: boolean          // ?reduced=1          (forces the reduced-motion path)
}
```

`isReduced()` is how 3D code reads reduced motion. `useStore(reducedMotion)` is how DOM code
does. Do not call `useStore` inside `useFrame`.

---

## 4. `src/three/quality.ts` — device tier (frozen)

```ts
type Tier = 'low' | 'mid' | 'high'
type QualitySettings = {
  tier: Tier; dpr: number; shadowMapSize: number; contactShadows: boolean;
  depthOfField: boolean; antialias: boolean; maxInstances: number; detail: number
}
const quality: Store<QualitySettings>
const getQuality: () => QualitySettings           // synchronous read for useFrame
function degradeQuality(): void                   // Stage calls this; games do not
const BUDGETS: { drawCallsGame: 90; drawCallsHub: 60; triangles: 180_000; materials: 28;
                 renderTargets: 3; frameMsP95: 16.7; desktopFrameMsP95: 4.2 }
```

Tiers: `low` 512 shadow / dpr 1 / 90 instances / detail 1 · `mid` 1024 / 1.5 / 160 / 2 ·
`high` 1024 / 2 / 260 / 3. Never climbs back up mid-session. Size instanced scatters from
`getQuality().maxInstances`.

---

## 5. `src/three/geometry.ts`

**Every geometry returned already has a baked curvature-AO `color` attribute, is indexed,
watertight, has smooth welded normals, and honours a minimum bevel.** All builders cache by
key, so calling one twice with the same arguments returns the *same* `BufferGeometry` —
never dispose one yourself, and never mutate one in place.

```ts
function roundedBox(w, h, d, radius, detail?): BufferGeometry
function roundedPlate(w, h, thickness, cornerRadius, detail?): BufferGeometry
function clayTray(w, d, h, rim, detail?): BufferGeometry
function latheProfile(points: [number, number][], segments?, smooth?): BufferGeometry
function beveledExtrude(shape: THREE.Shape, opts: { depth: number; bevel: number; steps?: number }): BufferGeometry
function softSphere(radius, detail?): BufferGeometry
function softCapsule(radius, length, detail?): BufferGeometry
function roundedCylinder(radius, height, edge, detail?): BufferGeometry
function torusSoft(radius, tube, detail?): BufferGeometry
function toothGeometry(kind?: 'molar' | 'incisor' | 'baby', detail?): BufferGeometry
function bakeCurvatureAO(geo, opts?: { strength?: number; radius?: number }): BufferGeometry
function jitterSurface(geo, amount, frequency, seed?): BufferGeometry
function cachedGeometry(key: string, build: () => BufferGeometry): BufferGeometry
function disposeGeometryCache(): void
```

**UVs are not preserved.** Every builder strips source UVs before welding (keeping them
would refuse to weld across a UV seam and crease the model) and regenerates an affine planar
projection. So `beveledExtrude` and `roundedPlate` do **not** give you ExtrudeGeometry's
face-mapped UVs. If Sliding Puzzle or Tooth Match needs a texture registered to a specific
tile face, write your own UV pass over the returned geometry — after cloning it, because the
geometry is cached and shared.

**Vertex colours exceed 1.0 on purpose** (edge wear up to ~1.10, crevices down to ~0.63).
`materials.ts` multiplies in linear space. A small chunky prop is proportionally more bevel
than face, so its average tint runs ~6% brighter than a large flat one — if your tiles read
brighter than the tray they sit in, that is why.

Cost reference: `roundedBox` 386v/768tri, `clayTray` 618v/1232tri, `toothGeometry('baby')`
492v/980tri (1442v/2880tri at detail 4). Build cold, never inside `useFrame`.

---

## 6. `src/three/textures.ts`

All cached; `markShared`, so `disposeObject3D` will not free them.

```ts
function noiseNormalTexture(opts?: { size?; scale?; octaves? }): Texture
function radialShadowTexture(opts?: { size?; softness? }): Texture
function gradientTexture(stops: [number, string][], opts?: { size?; vertical? }): Texture
function grainTexture(opts?: { size?; strength? }): Texture
function sparkleTexture(opts?: { size? }): Texture
function fbm2(x: number, y: number, octaves?: number): number     // deterministic, no alloc
function disposeTextureCache(): void
```

---

## 7. `src/three/materials.ts`

Games call these factories. **Games never construct a `MeshStandardMaterial` inline.** All
results are cached by key and `markShared`, so the same call returns the same instance and
`disposeObject3D` will not free it. Do not mutate a returned material — you would retune
every other prop using it. If you need a variant, use `clay(key, opts)` with your own key.

```ts
type ClayOptions = {
  color?: string; roughness?: number; sss?: string; sssStrength?: number; wrap?: number;
  sheen?: number; grain?: number; transparent?: boolean; opacity?: number;
  emissive?: string; emissiveIntensity?: number
}
function clay(key: string, opts?: ClayOptions): MeshPhysicalMaterial
function clayIvory(): MeshPhysicalMaterial
function clayEnamel(): MeshPhysicalMaterial
function clayGum(tone?: 'soft' | 'main' | 'deep'): MeshPhysicalMaterial
function clayAccent(family: AccentFamily, tone?: AccentTone): MeshPhysicalMaterial
function clayPainted(hex: string, opts?: ClayOptions): MeshPhysicalMaterial
function clayRubber(hex: string): MeshPhysicalMaterial
function softGlass(hex?: string): MeshPhysicalMaterial
function clayGround(): MeshPhysicalMaterial
function shadowBlobMaterial(): MeshBasicMaterial
function disposeMaterialCache(): void
```

### The shader patch — verified, not assumed

Every clay material patches three's physical fragment shader through `onBeforeCompile`,
replacing one line inside `ShaderChunk.lights_physical_pars_fragment` with a per-channel
wrapped diffuse plus a back-scatter lobe.

Verified against the installed `three@0.170`:

- the anchor line occurs **exactly once** in `ShaderChunk.lights_physical_pars_fragment`
- `#include <lights_physical_pars_fragment>` occurs **exactly once** in
  `ShaderLib.physical.fragmentShader`
- `BRDF_Lambert` is defined in the `common` chunk, which the physical shader includes first
- `geometryNormal`, `geometryViewDir` and `directLight` are all in scope at the anchor
- **it compiles on a real GPU**: a live page reports four programs whose cache key ends in
  `lumident-clay-v1`, with a completely clean console. A GLSL compile failure would print to
  the console and render the props black; neither happens.

If a future three release moves the anchor, the module logs a loud `console.error` and ships
stock physical shading rather than a black screen. That message is your signal to re-derive
`DIFFUSE_ANCHOR`.

The warm-edge look is carried by the **per-channel wrap**, not by the `dot(V,-L)` lobe: the
key light is in front (`KEY_LIGHT.position = (-4, 7, 5)`), so the back-scatter term correctly
evaluates to ~0 under the standard rig. It fires when a game puts a light behind a prop.

---

## 8. `src/three/env.ts` and `src/three/Rig.tsx`

```ts
function getStudioEnvironment(renderer: WebGLRenderer): Texture      // code-built PMREM, ~25ms once
function applySceneDefaults(scene, renderer, opts?: { fogDensity?: number; background?: boolean }): void
function disposeEnvironment(): void

function Rig(props: {
  groundY?: number; groundSize?: number; shadowArea?: number; fogDensity?: number;
  envIntensity?: number; ground?: boolean; keyIntensity?: number; children?: ReactNode
}): JSX.Element

function ContactBlob(props: {
  position?: [number, number, number]; radius?: number; opacity?: number;
  rotation?: [number, number, number]
}): JSX.Element
```

**Mount exactly one `<Rig>` per `<Scene3D>`**, and put your scene inside it. It owns
`scene.environment`, `scene.fog`, the single shadow-casting key light and the ground plane,
and it re-applies them on `CONTEXT_RESTORED_EVENT`. It has no `useFrame` — it costs one
layout effect at mount and nothing per frame.

Verified live: exactly one `DirectionalLight`, `#fff0dc`, intensity 2.35, `castShadow`,
1024² map. No stray ambient light. Renderer: `NeutralToneMapping`, exposure 1.05,
`SRGBColorSpace`, `PCFSoftShadowMap`. Scene: `FogExp2('#ede7dc', 0.014)`,
`environmentIntensity 0.95`, `background === null`.

Two things to know:

- **`shadow.radius` is inert.** r170's `PCFSoftShadowMap` branch uses a fixed one-texel
  kernel and ignores `shadowRadius`. Shadow softness is governed purely by `shadowArea` vs.
  map size, so pass a *larger* `shadowArea` for a softer map, and get close-contact softness
  from `<ContactBlob>`.
- **`shadowArea` should bound your play area, not the world.** The ortho frustum is sized
  from it; a frustum ten times larger than the action is the difference between a soft
  contact shadow and a staircase.

---

## 9. `src/three/Stage.tsx` and `src/three/Scene3D.tsx`

```ts
// Stage.tsx — mounted once in App.tsx. Games never touch it.
const stageReady: Store<boolean>
function useRenderer(): WebGLRenderer | null
const CONTEXT_RESTORED_EVENT: 'lumident:contextrestored'
function Stage(props: { children?: ReactNode }): JSX.Element

// Scene3D.tsx — this is your entry point.
const GameAreaContext: React.Context<React.RefObject<HTMLElement | null> | null>
function useGameArea(): React.RefObject<HTMLElement | null> | null
type SceneCamera = { position: [number, number, number]; target?: [number, number, number]; fov?: number }
function Scene3D(props: {
  children: ReactNode; camera?: SceneCamera; track?: React.RefObject<HTMLElement | null>;
  className?: string; index?: number
}): JSX.Element
```

`GameShell` now provides `GameAreaContext` pointing at its play-area div, so inside a game a
bare `<Scene3D>` automatically tracks that rect. Pass `track` only to override it.

`fov` is clamped to `CAMERA.fovRange` (26–32). Camera moves go through a `CameraRig` that
breathes and springs; changing the `camera` prop after mount calls `focus()` (a spring move),
not a cut. The prop is destructured to primitives internally, so rebuilding the array literal
on every render is safe.

`Scene3D` mutates the tracked element: if it computes to `position: static` it rewrites it to
`relative` (restored on unmount). It resolves the host in a *passive* effect, so exactly one
commit renders no view — that is expected, not a flash to chase.

---

## 10. `src/three/camera.ts`, `anim.ts`, `physics.ts`

```ts
class CameraRig {
  constructor(camera: PerspectiveCamera, opts?: { breathe?: boolean; maxShake?: number })
  setBase(px, py, pz, tx, ty, tz, immediate?): void
  focus(px, py, pz, tx, ty, tz): void
  shake(strength: number): void
  update(dt: number, elapsed: number): void
  dispose(): void
}
```
`Scene3D` already owns one per view. To add a shake without fighting it, run your own rig on
a *detached* camera proxy and add its resulting position offset to `state.camera.position` —
that is what `celebrate.tsx` does. Under reduced motion `update()` is completely static.

```ts
// anim.ts — the only easing in the product. Do not hand-roll.
clamp01, easeOutCubic, easeInCubic, easeInOutCubic, easeOutQuint,
easeOutBack(t, s = 1.7), easeInBack, easeOutElastic(t, amplitude?, period?),
anticipate(t, dip = 0.12), easeOutBounce
damp(current, target, lambda, dt): number
damp3(out: {x,y,z}, tx, ty, tz, lambda, dt): void
dampAngle(current, target, lambda, dt): number
class Spring  { value; velocity; target; constructor(value?, stiffness = 320, damping = 22);
                set(v); to(v); impulse(v); step(dt): number }
class Spring3 { x; y; z; constructor(x?, y?, z?, stiffness?, damping?); set(x,y,z); to(x,y,z); step(dt) }
squashFor(out: {x,y,z}, amount, base = 1, limit = 0.34): void   // volume-preserving
impactSquash(speed, scale = 0.055): number
class Timeline { running; get elapsed; add(at, duration, fn: (t: number) => void); start(); stop(); step(dt) }
safeDelta(dt): number        // clamps a long frame to 1/20s
FEEL: { pressDown: 0.09; pressScale: 0.94; releaseOvershoot: 1.06; windUp: 0.07;
        settle/snappy/heavy: { stiffness; damping }; reducedFade: 0.15 }
```
`Spring`, `Spring3` and `Timeline` allocate only in their constructors — safe in `useFrame`.

```ts
// physics.ts
type Body = { position; velocity; quaternion; angularVelocity: THREE.Vector3|Quaternion;
              radius; mass; restitution; friction: number; sleeping; alive: boolean;
              kind: string; userData: Record<string, unknown> }
type BoxCollider = { center: Vector3; halfExtents: Vector3; restitution: number;
                     kind: string; enabled: boolean }
class PhysicsWorld {
  gravity: Vector3
  constructor(opts?: { gravity?: number; fixedStep?: number })   // defaults 26 u/s², 1/120s
  addBody(init: Partial<Body>): Body        // copies your vectors, does not alias them
  removeBody(b: Body): void
  addPlane(y: number, restitution?, kind?): void
  addBox(center: Vector3, halfExtents: Vector3, restitution?, kind?): BoxCollider
  removeBox(c: BoxCollider): void
  onCollision(cb: (body: Body, withKind: string, impactSpeed: number) => void): void
  step(dt: number): void                    // zero allocation, frame-rate independent
  clear(): void
}
class SoftWobble {
  constructor(opts?: { stiffness?; damping?; maxTilt? })
  applyAcceleration(ax, ay, az): void        // REAL world units/s²
  impulse(x, y, z): void                     // NORMALISED — 1.0 is a firm catch
  update(dt): void
  apply(obj: Object3D): void
  reset(): void
}
```

Mutate a `BoxCollider`'s `center` in place to move it; the world diffs centres each step and
wakes bodies a moved collider reaches or abandons.

**`SoftWobble.impulse` takes a normalised kick, not a speed.** Passing a raw impact speed
(~18 u/s from a drop) pins the wobble at its tilt clamp on every catch and reads as a square
wave. Divide by a sensible full-scale first. `apply(obj)` **owns that object's rotation and
scale** — it captures the authored scale on first call and multiplies; nothing else may
animate that node's scale.

Verified live in a browser: six bodies dropped into a tray settle to exactly
`floor + radius` and report `sleeping: true`.

---

## 11. `src/three/hit.tsx`, `text.ts`, `celebrate.tsx`

```ts
function HitTarget(props: {
  ariaLabel: string; minScreenPx?: number /* = 48 */; radius?: number /* = 0.5 */;
  position?: [number, number, number]; onSelect?; onPress?; onRelease?: () => void;
  onHover?: (hovering: boolean) => void; disabled?: boolean; focusOrder?: number;
  group?: string; children?: ReactNode
}): JSX.Element
function FocusRing(props: { visible: boolean; radius: number; color?: string }): JSX.Element
function announce(message: string, assertive?: boolean): void
function useFocusGroup(group: string, count: number, onActivate: (i: number) => void, enabled?: boolean): number
```
`HitTarget` wraps your prop in a group with an invisible collider sized so the target is at
least `minScreenPx` CSS px wide **at its depth**, rechecked one frame in eight. The collider
is `object.visible = true` + `material.visible = false`: raycastable at zero draw cost —
confirmed live in the scene graph. **Never install a custom raycast filter or a BVH on a
scene containing `HitTarget`s**; it would silently kill them.

Use `announce()` for anything a screen-reader user must hear that has no DOM counterpart.
`celebrate.tsx` deliberately does **not** call it — if your game's celebration copy is not in
the DOM, add the call.

```ts
function ensureManrope(): Promise<void>     // resolves when usable, or after a 1.5s deadline
function textTexture(text: string, opts?: {
  fontSize?; weight?: number; color?; background?: string; padding?; maxWidth?: number
}): { texture: Texture; aspect: number; width: number; height: number }
function disposeTextCache(): void
```
Cached and `markShared`; transparent background by default; canvas capped at 1024px. Await
`ensureManrope()` once, then flip a state bit — do not poll per frame.

```ts
function Celebration(props: { active: boolean; accent: AccentFamily; onDone?: () => void }): JSX.Element
```
A 1.90s sequence: wind-up, drop with `easeOutBack`, confetti burst at 0.60s, sparkles, idle
breath, `onDone` at 1.90s. Confetti is one `InstancedMesh` sized from
`getQuality().maxInstances`. Has a separate non-overshooting reduced-motion timeline. Mount it
inside your `<Rig>` at the position you want the hero tooth; it hides itself when inactive.

---

## 12. `src/dev/perf.ts` and `src/dev/selftest.ts`

```ts
function installPerf(renderer: WebGLRenderer): () => void    // Stage calls this once
function perfSnapshot(): PerfSnapshot
function markSceneEnter(name: string): void
function markSceneExit(name: string): void
```
`window.__perf` exposes `fps, avgMs, p95Ms, worstMs, longFrames, longFrameRatio,
droppedFrames, droppedFrameRatio, renderAvgMs, renderP95Ms, samples, calls, triangles,
geometries, textures, programs, marks, violations, budgets, installed, snapshot(), memory(),
reset()`.

Judge hitches on **`droppedFrames` (>25ms)**, not `longFrames` (>16.7ms) — at 60Hz roughly
half of a perfectly healthy app's rAF intervals exceed 16.7ms by definition. On desktop,
`renderP95Ms` against `BUDGETS.desktopFrameMsP95` is the real headroom number, because a
vsync-bound machine shows a flat 16.7ms no matter how little headroom is left.

`installPerf` sets `renderer.info.autoReset = false` and owns the reset (drei `<View>` calls
`gl.render` once per view, so three's per-call reset would report only the last view).
Consequence: **anything reading `renderer.info` mid-frame sees an accumulating counter.**

Call `markSceneEnter`/`markSceneExit` around your game's mount/unmount so the scene-entry
hitch budget is measurable.

```ts
type SelfTestResult = { name: string; pass: boolean; detail: string; data?: unknown }
function registerSelfTest(name: string, fn: () => Promise<SelfTestResult> | SelfTestResult): void
function runSelfTests(filter?: string): Promise<SelfTestResult[]>
function pixelDiff(a, b, opts: { width; height; threshold? }): { differing: number; clusters: DiffCluster[] }
function readRenderTarget(renderer, target): Uint8Array           // WebGL bottom-up row order
function occlusionRatios(renderer, camera, objects, size = 256): number[]
function contrastRatio(hexA: string, hexB: string): number
function disposeSelfTestResources(): void
```

`selftest.ts` has **no importer yet** — it is pulled in when a game module imports
`registerSelfTest`, which is what puts `window.__selftest` on the page. Spot the Difference
and Count the Teeth own that wiring. Registering a test whose name matches `?selftest=…`
auto-runs it on a 400ms debounce and logs `[selftest] PASS/FAIL …` for a headless driver.

`occlusionRatios` mutates the live scene graph and restores in a `finally`; it costs
`1 + ceil(n/4)` synchronous readbacks. **Between rounds, never in `useFrame`.** It hides
sprites/lines/points for the duration and ignores `renderer.clippingPlanes`. Whoever owns it
must call `disposeSelfTestResources()` from their `DisposalBag` or the shared 256² ID target
leaks past the hub baseline.

---

## 13. `src/three/dispose.ts`

```ts
function markShared<T extends object>(resource: T): T
const isShared: (resource: object) => boolean
function disposeObject3D(root: Object3D): void        // skips anything markShared
class DisposalBag {
  add<T extends { dispose(): void }>(item: T): T
  onRelease(fn: () => void): void                     // listeners, RAF, timers, physics
  release(): void
}
const trackRenderTarget: (rt: WebGLRenderTarget) => WebGLRenderTarget
const untrackRenderTarget: (rt: WebGLRenderTarget) => void
function memorySnapshot(renderer): { geometries; textures; programs; renderTargets; heapMB }
```

Everything from `geometry.ts`, `textures.ts`, `materials.ts` and `text.ts` is already shared
and cached — **do not dispose it.** Register only what *your game* allocates: render targets,
one-off canvas textures, materials you built with `new`, event listeners, timers, and the
physics world (via `onRelease`). Hub → game → hub must return `renderer.info.memory` and
`programs.length` to the hub baseline (±2 programs for shader variants).

---

## 14. `?probe=1` — the foundation smoke scene

`src/dev/probe.tsx` renders one prop per geometry builder crossed with one material factory,
plus the studio rig, in-world Manrope text, a keyboard-reachable `HitTarget`, six live
physics bodies with soft-body tray wobble, and the celebration. It is lazily imported, so it
ships as its own 59kB chunk and costs the hub nothing.

Use it as a reference implementation and as a bisect tool: if your game's clay looks wrong,
open `?probe=1` first and find out whether the foundation or your scene is at fault.

It publishes `window.__probe = { world, bodies, wobble, gl, scene, advance, frames, lastDt }`.
`advance` is R3F's manual frame driver — `advance(performance.now() + n * 16.7)` runs a
complete frame, every subscriber and the view render, **without waiting for rAF**. That is
the only way to verify the loop in a hidden or throttled tab (headless drivers, CI, a
background pane get no rAF at all and render nothing). Measured there: 42 draw calls,
59,852 triangles per frame, 7 programs, 14 geometries, 5 textures — inside every §9 budget.

Other flags: `?tier=low|mid|high` forces a quality tier, `?reduced=1` forces the
reduced-motion path, `?perf` and `?selftest=…` per §12.

---

## 15. Known gaps the game agents inherit

1. **`src/games/index.ts` does not use `React.lazy` yet.** Spec §5 requires each game to be a
   separate chunk with prefetch on card hover/focus/pointerdown. The production bundle is
   currently one 1.19MB chunk. Whoever lands the first 3D game should do this.
2. **Hub → game camera transition (§5) is unimplemented.** `store.transition` exists as the
   channel for it and nothing drives it yet.
3. **No hub `<Scene3D>` yet** — the hub renders zero draw calls, which is why
   `renderer.info.render.calls === 0` on a cold boot.
4. **The hub-baseline memory assertion (§5) has not been exercised**, because no game mounts
   a view yet. Run it as soon as two 3D games exist.
5. **`<StrictMode>` was removed from `src/main.tsx`** deliberately: React 18's double-mount
   runs r3f's `unmountComponentAtNode`, which calls `forceContextLoss()` and rebuilds the root
   on a canvas whose context it just threw away — breaking "one context, created once, never
   torn down" and poisoning the `renderer.info` baseline. Do not add it back.
