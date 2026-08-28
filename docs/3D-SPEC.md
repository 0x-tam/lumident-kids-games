# Lumident Kids Games — 3D Conversion Spec (authoritative)

Every agent working on this conversion MUST read this file first and obey it exactly.
Where this file and your own taste disagree, this file wins. Where this file is silent,
match the established look.

---

## 0. The look, in one paragraph

Stop-motion claymation shot on a long lens in a warm studio. Everything is hand-pressed
ivory clay with rounded, slightly irregular bevels — **there is no hard edge anywhere in
this product.** Light is a big soft warm key from upper-left, a cream bounce card from
below, and a cool-ish rim from behind-right; all of it comes from a procedurally built
environment map, never from a bare `directionalLight` alone. Surfaces are matte with a
broad, low-intensity sheen — never a tight white speculars dot. Contact shadows are dark,
soft and *close* to the object; ambient occlusion darkens every crevice. Depth separation
comes from warm cream fog, not from haze grey. If a frame could be mistaken for a
Three.js example, a Blender default-cube render, or a flat-shaded low-poly asset store
pack, it has failed.

References in the head (do not fetch them, just aim there): Toca Boca World, Sago Mini,
Pixar shorts, Super Mario Odyssey's Luncheon/Cap kingdom props.

---

## 1. Hard constraints (violating any one fails the task)

1. **Content.** No drills, injections, needles, blood, tears, crying, pain, scary faces,
   darkness-as-threat, failure screens, "you lose", red X's, life counters that run out,
   or any punitive feedback. The child cannot lose. Mistakes get a playful "oops" and the
   run always ends in celebration.
2. **Brand.** Manrope only. Page `#EDE7DC`, ink `#2F3237`, and the five accent families
   in `src/three/tokens.ts`. Materials are built from these tokens — never from a generic
   PBR preset, never a stock "gold/plastic/metal" material.
3. **Architecture.** Shared `GameShell` stays. Each game stays one folder exporting one
   component, registered in `src/games/index.ts`. `src/shared/storage.ts` keeps its exact
   public API (`Player`, `loadPlayer`, `savePlayer`, `clearPlayer`, `getBest`,
   `submitScore`) — do not change signatures or key names.
4. **Performance.** **No per-frame React renders anywhere.** Mutate refs / `object3D`
   transforms directly inside `useFrame`. Instance everything repeated. Lazy-load each
   game's geometry+materials so the hub is instant. Budgets in §9.

   > **Amended 2026-08-27, by the project owner.** This rule previously read "Locked 60fps
   > on a mid-range Android tablet", and that is **no longer a pass/fail gate.** No such
   > device is available to this project, so the constraint could only ever be argued from a
   > desktop proxy multiplied by an assumed factor — which is an opinion wearing a number's
   > clothes, and three audit rounds burned real effort on it. What remains binding is
   > everything in §9 that can actually be measured here. Do not fail an item, and do not
   > spend a round, on the unverifiable mobile claim.
5. **Accessibility.** 48px+ effective tap targets in *screen* space, keyboard play
   everywhere practical, aria labels, and a real `prefers-reduced-motion` path: static
   camera, no parallax, no idle float — still fully playable and still good-looking.
6. **No source assets.** Every model is procedural geometry built in code. Every material
   is code-defined. Every texture is generated procedurally or on a `<canvas>` at runtime.
   No `.glb`, `.fbx`, `.hdr`, `.exr`, no downloaded textures, no CDN model/texture fetch.
   The only binary assets in the repo are the existing `public/brand/*.webp` icons.
   Importing a model to solve a look = failed task.
7. **Deps.** `three`, `@react-three/fiber` (v8), `@react-three/drei` (v9), plus the
   existing React 18 / TS strict / Tailwind v4 / framer-motion (2D UI only). Do not add
   any other runtime dependency. `three/examples/jsm/*` is part of `three` and allowed.

---

## 2. World, camera, lighting standard

**Scale.** 1 world unit = 10 cm. A hero tooth prop is ~1.0 unit tall. Keep every game in
this scale so shared lighting, fog and shadow settings read identically.

**Camera.** `PerspectiveCamera`, **fov 26–32 (default 28)** — a long lens is what makes it
read as a miniature diorama instead of a video game. Distance 8–16 units. `near 1`,
`far 60` (tight near/far = clean depth precision on mobile). Per-game overrides allowed
only inside that fov band.

**Framings are solved, never typed in.** Every camera in the product — each game's
`layout.ts` and the shared celebration's (`GameShell::solveCelebrationCamera`) — derives its
distance and aim from what is actually on screen and from the *measured* aspect of the rect
it renders into, then clamps into the fov and distance bands above. A hard-coded
`position` / `target` triple is a bug: it is tuned on one viewport and silently guillotines
content on every other. The celebration additionally treats the band its DOM copy occupies
as a floor the subject may never fall below, so the hero can never be framed under the
words. Covered by the `celebration-framing` selftest.

**Lighting rig** (`src/three/env.ts` + `src/three/Rig.tsx`), identical in every scene:

| Element | Spec |
|---|---|
| Environment | PMREM of a **code-built** studio: warm key softbox upper-left, cream bounce card below, cool-ish rim strip behind-right, warm gradient sky. `scene.environment`, intensity 0.85–1.0 |
| Key | one `directionalLight`, colour `#FFF0DC`, intensity 2.0–2.6, from `(-4, 7, 5)` direction, casts shadow |
| Shadow | `PCFShadowMap` + the clay **PCSS** filter (see below), map 1024 (512 on low tier), tight ortho frustum around the play area, `bias -0.0004`, `normalBias 0.006`, `shadowIntensity 0.52`. `shadow.radius` is **not** a filter width — see below |
| Contact | additional soft blob/contact shadow directly under props (procedural radial texture or drei `ContactShadows` with `frames` limited) |
| Fog | `FogExp2('#EDE7DC', 0.010–0.020)` — cream, never grey |
| Tone map | Khronos **PBR Neutral**, exposure ~1.05, installed through `CustomToneMapping` with its black-point offset removed — see §2.1. **Not** ACESFilmic (it desaturates the brand reds) |
| Output | `outputColorSpace = SRGBColorSpace`, `ColorManagement` on (three default) |
| Background | the scene's ground/backdrop is the page cream so the canvas melts into the page |

**Shadow softness — the rule, and why the row above changed.**

*The rule:* **a cast shadow's penumbra must widen with distance from the contact point.** A
shadow that is exactly as soft directly under a prop as it is a unit above it reads as a
dark decal stuck to the floor, not as light being blocked, and it is the single fastest way
to lose the miniature. Sharp where the prop touches; wide and warm where it lifts away.

*Why this row no longer says `PCFSoftShadowMap` + `radius 4`.* Those two are mutually
exclusive in three r170, so that row could not be satisfied as written and two audit rounds
escalated it instead of resolving it. In
`ShaderChunk/shadowmap_pars_fragment.glsl.js`, the `SHADOWMAP_TYPE_PCF` branch reads
`shadowRadius` (17 compares at `0, ±r/2, ±r` texels, any width); the
`SHADOWMAP_TYPE_PCF_SOFT` branch declares `float dx = texelSize.x;` and never mentions
`shadowRadius` — a fixed 2×2-texel block, ~3 screen px at design framing, with no knob.

The resolution is neither option as posed, because **both stock branches are fixed-width**
and therefore both fail the rule above. What ships instead:

- `renderer.shadowMap.type = PCFShadowMap` — the only branch that reads `shadow.radius`.
- The clay shader redirects that branch into a **PCSS** filter (`materials.ts`): eight
  Vogel-disc taps search the packed depth for the blocker, and twelve more run a PCF disc
  whose radius comes from the measured caster-to-receiver gap. Both discs are rotated per
  fragment by interleaved-gradient noise so an undersampled wide kernel dithers instead of
  banding. **Every tier compiles it**, and the *tap count* is what the tier decides
  (`quality.ts::PCSS_GROUPS_FOR_TIER`, frozen at boot): 20 fetches on low, up to 32 on mid and
  44 on high, against the stock fixed-radius kernel's 17. Round 4 found the old gate —
  `softShadows = tier !== "low"` — switching the product's signature shadow off on the device
  §1.4 names as the target, i.e. the frame the target child sees was not the frame anyone was
  reviewing. Three extra fetches on one lobe is not what a degrade is fighting.
- `shadow.radius` is redefined: under PCSS it carries *penumbra texels per unit of
  normalised depth gap*, written by `Rig.tsx` from `SHADOW_SOFTNESS` (the key's tangent
  half-angle, 0.10), the ortho frustum's depth range and the map's texel density. The
  penumbra half-width is therefore `0.10 × gap` **world units**, framing-independent, where
  the gap is measured *along the key*: 6.3 screen px at contact (the sampling floor), 8 px at
  a 0.3-unit gap, 27 px at a unit.
- `PCFSoftShadowMap` must not be set: its branch ignores `shadowRadius`, so the whole solve
  would compile away and the shadows would silently go back to being decals.

**Never** ship: a single unshadowed `directionalLight`, a bare `ambientLight` as the only
fill, `MeshBasicMaterial` for a lit prop, three-point lighting with hard falloff, or a
shadow filter whose penumbra does not vary with the caster's distance.

**Backdrops are shaded as ground.** `clayGround`'s albedo is white-balanced against a
*measured* render of an **up-facing** plane under this studio (`GROUND_WHITE_BALANCE`), so
it only lands on `#EDE7DC` for a surface whose shading normal is `+Y`. The studio is
deliberately warm except for one cool rim strip *behind* the subject, so the same material
on a camera-facing plane sees the warm bounce card and none of the rim and renders
`#e8d8c1` — dE2000 6.2 from the page, i.e. a visible rectangle. A backdrop plane that
stands in for the table (the hub's) therefore ships `+Y` shading normals, which is also
what it physically is: a cyclorama sweep, the same floor seen face-on.


### 2.1 The tone curve, and the one term removed from it

The operator is Khronos PBR Neutral — the one this spec has always named, chosen because
ACESFilmic rotates the brand reds toward orange. It is installed through three's
`CustomToneMapping` hook rather than `NeutralToneMapping`, with **one term deleted**: the
black-point offset

```glsl
float x = min( color.r, min( color.g, color.b ) );
float offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
color -= offset;
```

That subtracts a near-constant ~0.04 of linear radiance from all three channels. On a channel
at 0.80 it is a 5 % shift the shoulder gives back; on a channel at 0.073 — where the blue of
`coral.main` lands — it is a **55 %** shift. Removing half of one channel and a twentieth of
another is a chroma boost, a hue rotation toward the dominant channel and a small luminance
drop, which is exactly the `dL −1.8…−3.2 / dC +3…+8.6 / dh +4…+5°` signature round 4 measured
on every mid-to-dark accent in the product while a light low-chroma token landed at dE2000
0.51.

Verified by inverting the shipped round-4 pixels through the shipped curve to recover their
radiance and pushing that same radiance through the new one, so no model of shading or
lighting enters it (`scratchpad/tonemap.mjs`):

| surface | token | dE2000 before | dE2000 after |
|---|---|---|---|
| Maze Escape coral block top | `coral.main` | 3.82 | **1.91** |
| Maze Escape coral, shadow side | `coral.main` | 8.14 | **3.24** |
| Tooth Match red card | `red.main` | 4.43 | **2.11** |
| Tooth Match red card, lower | `red.main` | 5.81 | **1.83** |
| lit ground (the calibration anchor) | `page` | 0.51 | **0.22** |

The shoulder — the half of the curve that stops ivory clipping to chalk, and the reason this
row names an operator at all — is untouched, and `StartCompression` stays at 0.76. The body
in `env.ts::CLAY_TONE_MAP` is upstream's verbatim, minus those three lines; diff it against
`ShaderChunk/tonemapping_pars_fragment.glsl.js` on every three upgrade.

---

## 3. Materials: the clay system

All materials come from `src/three/materials.ts`. Games call the factories; games do not
construct `MeshStandardMaterial` inline.

Required properties of every clay surface:
- **Fake subsurface.** Wrapped diffuse (`(N·L + w) / (1 + w)`, w ≈ 0.35) plus a warm
  back-scatter term. Ivory reads warm-pink in the thin parts, never chalk-white.
- **Broad soft sheen**, low `specularIntensity`, `roughness` 0.55–0.8. No tight highlights.
- **Micro grain.** A procedural fbm normal map at very low strength (0.08–0.15) so the
  surface has fingerprinted clay tooth, never a uniform plastic albedo.
- **Curvature darkening / edge wear.** `bakeCurvatureAO(geometry)` writes vertex colours;
  materials multiply by them. Crevices go warm-dark, exposed edges go slightly lighter and
  desaturated — that is the "hand-pressed" tell.
- **Real bevels in the geometry**, not a normal-map fake. Minimum bevel radius 0.02 units;
  no geometry ships with a 90° silhouette corner.

Factories (see file for exact signatures): `clayIvory`, `clayEnamel`, `clayGum`,
`clayAccent(family, tone)`, `clayPainted(hex)`, `clayRubber`, `softGlass`, `clayGround`.
All cached by key and disposed through `src/three/dispose.ts`.

---

## 4. Motion & feel

Absolute rules:
- **Nothing a child touches uses `linear` or `ease-in-out`.** Presses, pops, flips,
  snaps, catches and pickups use anticipation → overshoot → settle.
- Every launch/pickup has a **wind-up** (a small opposite-direction dip, 50–80 ms).
- Every landing has **squash & stretch** with volume preservation, then a settle spring.
- Nothing floats to a stop. Motion settles with a spring or with `easeOutBack`, inside the
  band in **§4.1** below.
- Response to a tap is visible **within one frame**. Press-down 0.94 scale in ~90 ms,
  release overshoot to ~1.06 then settle.
- The camera **breathes**: sub-degree low-frequency noise, amplitude ≤ 0.35°, ≤ 0.06
  units. It must never swing enough to make a child queasy — hard clamp angular velocity.
- Reduced motion: camera is static, no parallax, no idle float, no shake; state changes
  become short cross-fades/scale pops ≤ 150 ms. Still readable, still charming.

Use only `src/three/anim.ts` helpers (`Spring`, `damp`, `damp3`, `easeOutBack`,
`easeOutElastic`, `anticipate`, `squashFor`, `Timeline`). Do not hand-roll easing.

### 4.1 The settle band, and the one exception to it

**The band itself is unchanged and normative: `stiffness` 260–420, `damping` 18–28, or
`easeOutBack(1.6–2.0)`.** What follows says what those numbers *do*, so a site can be judged
by the motion a child sees rather than by two constants, and adds the one exception §6.3
already demands.

`anim.ts::Spring` integrates `a = (target − x)·k − v·c` at unit mass, so:

- `ζ = c / (2√k)` — the damping ratio. It alone decides the **overshoot**:
  `exp(−πζ/√(1−ζ²))`.
- `8 / c` — the 2 % settling time. It depends on `c` alone, not on `k`.
- `√k` — the natural frequency, i.e. how fast the whole gesture reads.

Over the band's four corners that is `ζ` 0.439–0.868, overshoot 0.4 %–21.5 %, settle
286–444 ms. `easeOutBack` at 1.6–2.0 overshoots 9.0 %–13.2 %, which sits inside it, so the
two clauses of the rule really are interchangeable. **Pick `k` for the speed you want, then
`c` for the settling time; `ζ` falls out and is the thing to check.**

One consequence worth stating, because it is why the band reads as arbitrary at its edge:
Healthy or Not?'s `squash` at `(380, 17)` and its `hop` at `(260, 14)` have `ζ` 0.436 and
0.434 — the same motion to two decimal places — and only the second is outside the box. The
edge is a *speed* boundary, not a *shape* one. That is an argument for reading the table
below as ζ, not an argument for moving the box.

**Exception 1 — comic wobble.** §6.3 asks for exactly one motion the band forbids: "misses
give a soft comic wobble". A wobble that reads as a wobble needs visible ring-down, which is
`ζ` under the band. Allowed, bounded, and it must be annotated:

- `ζ` in **0.25–0.44**: first overshoot ≤ 45 %, 2 % settling ≤ 900 ms. Nothing looser and
  nothing slower — past `ζ = 0.25` a prop rings for over a second and a child reads it as
  broken rather than as funny.
- Allowed **only** on a feedback flourish that carries no state and that nobody is waiting
  on: a wobble, an idle bob, an idle spin, a bank into a turn. **Never** on a press, a snap,
  a flip, a catch, a pickup, a landing, a camera move, or anything that gates the next tap.
- Every site must carry a comment naming this exception by number. A comment asserting
  compliance in a file that ships violations is how a rubric line gets waved through, and
  round 4 found exactly that at `maze-escape/scene.tsx:160`.

The nine springs currently outside the band, measured (`scratchpad/springs.mjs`), and what
each has to become:

| site | k | c | ζ | overshoot | settle | resolution |
|---|---|---|---|---|---|---|
| `healthy-or-not` `wobble` | 300 | 9 | 0.260 | 42.9 % | 889 ms | Exception 1 — annotate |
| `tooth-match` `wobble` | 300 | 9 | 0.260 | 42.9 % | 889 ms | Exception 1 — annotate |
| `smile-maker` `wobble` | 300 | 11 | 0.318 | 34.9 % | 727 ms | Exception 1 — annotate |
| `maze-escape` `bank` | 300 | 11 | 0.318 | 34.9 % | 727 ms | Exception 1 — annotate |
| `maze-escape` treat `bob` | 300 | 13 | 0.375 | 28.0 % | 615 ms | Exception 1 — annotate |
| `maze-escape` treat `spin` | 240 | 12 | 0.387 | 26.7 % | 667 ms | Exception 1 — annotate, **and** `k` 240 → 260: the exception covers ring-down, not speed |
| `maze-escape` `hop` | 320 | 15 | 0.419 | 23.4 % | 533 ms | **retune** `c` → 18 (ζ 0.503, 16.1 %, 444 ms) |
| `healthy-or-not` `hop` | 260 | 14 | 0.434 | 22.0 % | 571 ms | **retune** `c` → 18 (ζ 0.558, 12.1 %, 444 ms) |
| `tooth-match` `hop` | 260 | 14 | 0.434 | 22.0 % | 571 ms | **retune** `c` → 18 (ζ 0.558, 12.1 %, 444 ms) |

A hop is a landing and a child is waiting on it, so it takes the band, not the exception.
`smile-maker/scene.tsx`'s `easeOutBack(k, 1.5)` (8.0 % overshoot) goes to 1.6 (9.0 %) — the
band's floor, and a difference of one point of overshoot.

Use only `src/three/anim.ts` helpers (`Spring`, `damp`, `damp3`, `easeOutBack`,
`easeOutElastic`, `anticipate`, `squashFor`, `Timeline`). Do not hand-roll easing.

### 4.1 The settle band, and the one exception to it

This row used to read "`stiffness` 260–420, `damping` 18–28", and **it was stated in the
wrong quantities.** `anim.ts::Spring` integrates `a = (target − x)·k − v·c` at unit mass, so
what a child actually sees is the damping ratio `ζ = c / (2√k)` — the overshoot and the
ring-down come from `ζ`, not from `k` and `c` separately. A box drawn on `k` and `c` cuts
across lines of constant `ζ`, and the result is a rule that cannot tell two identical motions
apart. Measured on the shipped springs (`scratchpad/springs.mjs`):

| spring | k | c | ζ | overshoot | verdict under the old box |
|---|---|---|---|---|---|
| Healthy or Not? `squash` | 380 | 17 | 0.436 | 21.8 % | **compliant** |
| Healthy or Not? `hop` | 260 | 14 | 0.434 | 22.0 % | **violation** |

Those two are the same motion to two decimal places. Restated in the quantity that describes
it — and derived to be **exactly** the old box, not a wider one; `ζ` at its four corners is
0.439, 0.558, 0.683, 0.868:

- **Settle springs: `ζ` in 0.44–0.87**, i.e. first overshoot 0.4 %–22 %, 2 % settling time
  ≤ 450 ms. Equivalent to `easeOutBack(1.5–2.0)`, whose overshoot over that range is 8.0 %
  to 13.2 % — the old `1.6–2.0` was a 9.0 %–13.2 % window, and 1.5 is inside the spring band
  it is supposed to be interchangeable with.
- Pick `k` for the *speed* you want (`√k` is the natural frequency; 260–420 is 400–460 ms of
  ring-down) and then set `c = 2ζ√k`. Do not pick `c` first.

**Exception 1 — comic wobble.** §6.3 asks for exactly one motion this band forbids: "misses
give a soft comic wobble". A wobble that has to *read as* a wobble needs visible ring-down,
which is `ζ` below the band. It is allowed, bounded, and it must be annotated:

- `ζ` in **0.25–0.44**, i.e. first overshoot ≤ 45 % and 2 % settling ≤ 900 ms. Nothing
  slower and nothing looser — past `ζ = 0.25` a prop rings for over a second and a child
  reads it as broken rather than as funny.
- Allowed **only** on a feedback flourish that carries no state: a wobble, a bob, an idle
  spin, a bank into a turn. Never on a press, a snap, a flip, a catch, a pickup, a camera
  move, or anything a child is waiting on before they can act.
- Every site must carry a comment naming this exception. A comment claiming compliance in a
  file that ships violations is how a rubric line gets waved through, and round 4 found
  exactly that at `maze-escape/scene.tsx:160`.

The nine springs currently outside the main band, with what they measure
(`scratchpad/springs.mjs`), and what each one has to become:

| site | k | c | ζ | overshoot | settle | resolution |
|---|---|---|---|---|---|---|
| `healthy-or-not` `wobble` | 300 | 9 | 0.260 | 42.9 % | 889 ms | Exception 1 — annotate |
| `tooth-match` `wobble` | 300 | 9 | 0.260 | 42.9 % | 889 ms | Exception 1 — annotate |
| `smile-maker` `wobble` | 300 | 11 | 0.318 | 34.9 % | 727 ms | Exception 1 — annotate |
| `maze-escape` `bank` | 300 | 11 | 0.318 | 34.9 % | 727 ms | Exception 1 — annotate |
| `maze-escape` treat `bob` | 300 | 13 | 0.375 | 28.0 % | 615 ms | Exception 1 — annotate |
| `maze-escape` treat `spin` | 240 | 12 | 0.387 | 26.7 % | 667 ms | Exception 1 — annotate |
| `maze-escape` `hop` | 320 | 15 | 0.419 | 23.4 % | 533 ms | **retune** — `c` 16 puts it at ζ 0.447 |
| `healthy-or-not` `hop` | 260 | 14 | 0.434 | 22.0 % | 571 ms | **retune** — `c` 15 puts it at ζ 0.465 |
| `tooth-match` `hop` | 260 | 14 | 0.434 | 22.0 % | 571 ms | **retune** — `c` 15 puts it at ζ 0.465 |

A hop is a landing, not a flourish: a child is waiting on it, so it takes the main band. The
three retunes are one digit each and change the overshoot by under two points.

---

## 5. App architecture

### One WebGL context, forever
`src/three/Stage.tsx` mounts **one** `<Canvas>` for the whole app, fixed to the viewport,
behind the DOM UI (`z-index: 0`; DOM UI at `z-index: 10`, `eventSource` = `#root`,
`eventPrefix="client"`). It is created once at app start and **never** torn down. Entering
or leaving a game must never recreate the renderer.

### Scene regions
Rendering into a DOM rect uses drei `<View track={ref}>` + `<View.Port/>`. Only the views
that are on screen render. Hub uses one view spanning the card grid; a game uses one view
tracking `GameShell`'s play area (except Spot the Difference, see §6).

### Game contract
```tsx
// src/games/<game>/<Game>.tsx  — default export, no props
export default function MyGame() {
  const engine = useRef<MyEngine>(null!);          // all per-frame state lives here
  if (!engine.current) engine.current = createEngine();
  const [hud, setHud] = useState(...);              // discrete events only
  return (
    <GameShell {...}>
      <Scene3D>                                     {/* portals into the one canvas */}
        <MyGameScene engine={engine.current} />     {/* memoized, stable props */}
      </Scene3D>
      {/* optional DOM overlay, must read as part of the world */}
    </GameShell>
  );
}
```
- 3D components **must not consume React context** (they render in the R3F root). Read
  shared state from the module stores in `src/three/store.ts` instead.
- Communication game-logic → 3D scene goes through the engine object + an event emitter,
  never through props that change per frame.

### Lifecycle & memory
- Leaving a game unmounts its View; `src/three/dispose.ts` must free every geometry,
  material, render target, canvas texture, listener, RAF and physics body the game
  created. Shared caches (env map, shared materials, shared geometry) persist by design
  and are bounded.
- After hub → game → hub, `renderer.info.memory.geometries/textures` and
  `renderer.info.programs.length` must return to the hub baseline (±2 programs tolerance
  for shader variants). Playing all nine and looping again must not grow it.

### Lazy loading
`src/games/index.ts` registers each game as `React.lazy(() => import(...))` so its
geometry/material modules are a separate chunk. The hub must be interactive on cold start
without waiting for any game chunk, and entering a game must not hitch — prefetch the
chunk on card hover/focus/pointerdown.

### Transitions
Hub ⇄ game is a continuous, readable camera + scene transition (≈450–600 ms), never a cut
and never a page load. `Escape` and the back control always return to the hub instantly,
mid-run, with no confirmation and no penalty. The greeting, player chip, per-player best
scores and player switching all behave exactly as they do today.

---

## 6. Per-game 3D direction

Every game keeps its current rules, level counts, scoring and randomisation (see
`PROJECT.md`). Only the presentation and feel change — plus whatever is called out here.

1. **Sliding Puzzle** — physical clay tiles in a shallow tray with a real rim and inner
   well. Tiles *rise* off the tray, glide, and drop with a settle; they never slide flat.
   The picture is a **rendered relief** — actual extruded 3D scene elements on each tile
   face, lit by the scene — not a flat texture of a drawing.
2. **Maze Escape** — tilted top-down camera over a coral gum block with ivory corridors
   carved into it with real wall depth and rounded, bevelled corridor edges. The tooth
   *rolls* and leans into its direction of travel, banking on turns, squashing on wall
   bumps. The three-cells-per-gesture / corridors-only rule stays.
3. **Tooth Match** — chunky cards with real thickness, rounded corners and a bevelled
   edge, flipping in 3D on the long axis with anticipation and a hard, satisfying snap at
   the end. Matches lift, chime and press together; misses give a soft comic wobble.
4. **Healthy or Not?** — food props on a slowly turning clay turntable. A tapped healthy
   food arcs into a smiling tooth (which chomps happily); a sugary food is gently waved
   off and arcs away with a comic tumble. Nothing is ever destroyed or punished.
5. **Spot the Difference** — two miniature 3D bathroom dioramas side by side, both live.
   **Both panels must render the same scene object with the same camera instance and the
   same lights**, differing only by per-panel visibility toggles for the intended diffs.
   Any parallax, FOV, exposure or lighting drift between panels is a bug that invents fake
   differences. Ship an in-page test (`?selftest=spot`) that renders both panels to render
   targets and pixel-diffs them, asserting that the only differing pixel clusters are the
   intended diffs.
6. **Tooth Rescue** — real falling-body physics (`src/three/physics.ts`): gravity,
   restitution, angular tumble. The basket has soft-body wobble that responds to
   acceleration and to catches. Candy hits the rim and bounces out comically — never
   scary, never a penalty beyond "no point".
7. **Count the Teeth** — teeth scattered on a clay surface with real contact shadows so
   the count reads at a glance. **Runtime guarantee:** the layout generator renders per-
   tooth IDs to an offscreen target *from the actual game camera* and resamples until
   every tooth is ≥75% unoccluded. Not "checked from above" — from the game camera.
8. **Tooth Runner** — endless runner, camera behind **the shared mascot, running on a
   two-beat gait** (not a rolling tooth — see below), layered parallax depth (near lane, mid
   props, far silhouette band), instanced repeating scenery, toothbrush pickups that pop with
   a burst. Candy only slows you; nothing kills.
   **Amended after round 4 (RU9), because the spec and the build had silently disagreed for
   three rounds.** This line used to read "camera behind a rolling tooth". A tooth rolled end
   over end at `v / ROLL_RADIUS` — 1.5 revolutions a second at the middle level — presents its
   roots to the sky for a large part of every second, which for a dental brand is the wrong
   read and, more importantly, leaves the face nowhere to live: §1.1 asks for a character a
   four-year-old can attach to, and a rolling ball cannot hold eyes. The build replaced the
   roll with a run: the same ground speed drives a two-beat cycle (`STRIDE` = 1.8 units per
   footfall, 3.0 / 3.9 / 4.8 steps a second), the crown faces forward permanently so the face
   is readable on every frame, and the arc of a jump is ballistic rather than a spin. The
   parallax, the pickups and the "candy only slows you" rule are unchanged. Under
   `prefers-reduced-motion` the gait stays at 0.45 amplitude — a gait is not a vestibular
   trigger, and freezing it while the world scrolls reads as broken (RU7); the reduction goes
   on the parallax bands, where the optic flow is.
   **Reduced motion must be measurable, not declared.** A capture harness comparing normal and
   `?reduced=1` frames must find the reduced path quieter in *every* screen band. Round 4
   found this game quieter in none and busier in two, because collapsing every parallax band
   to the near rate accelerates the far ones.
9. **Smile Maker** — a big orbitable tooth; hats/glasses/capes are 3D props that snap to
   anchor points with a magnetic ease + click. The polaroid is a **real render capture**
   of the framed scene onto a clay polaroid prop.

---

## 7. Shared modules (file ownership is strict — do not edit files you do not own)

```
src/three/tokens.ts      brand colours, scale, camera/lighting constants
src/three/store.ts       tiny module stores (reduced-motion, quality, mute, scene route)
src/three/geometry.ts    procedural geometry builders + curvature-AO baker + cache
src/three/textures.ts    procedural canvas/noise textures + cache
src/three/materials.ts   the clay material system + cache
src/three/env.ts         code-built studio environment (PMREM) + fog/tonemap setup
src/three/Rig.tsx        <Rig> standard lights, ground, shadows for a scene
src/three/Stage.tsx      the single <Canvas>, View.Port, quality/dpr, perf hooks
src/three/Scene3D.tsx    per-region <View> wrapper games use
src/three/camera.ts      CameraRig: breathing, clamped shake, spring focus moves
src/three/anim.ts        easing, Spring, damp, squash/stretch, Timeline
src/three/physics.ts     fixed-step rigid bodies, collisions, soft-body wobble
src/three/hit.tsx        <HitTarget minScreenPx>, keyboard focus ring, roving focus
src/three/text.ts        Manrope canvas-texture text for in-world labels
src/three/celebrate.tsx  shared 3D celebration sequence
src/three/dispose.ts     disposal + leak tracking
src/three/quality.ts     device tier probe, adaptive dpr, budgets
src/dev/perf.ts          window.__perf instrumentation (frame times, renderer.info)
src/dev/selftest.ts      ?selftest=… in-page test harness
```

## 8. Accessibility contract

- Every interactive 3D object is reachable by keyboard (Tab / arrows), shows a visible
  3D focus ring, and activates with Enter/Space.
- Every interactive 3D object has a DOM counterpart or `aria-live` announcement so a
  screen reader user knows what happened. Game state changes announce politely.
- Effective tap targets ≥48 CSS px measured in screen space at the object's depth —
  use `<HitTarget minScreenPx={48}>`, never a raw mesh raycast for small props.
- `prefers-reduced-motion` path per §4 must be play-tested end to end for every game.

## 9. Performance budgets (per frame, per scene)

These are binding, because every one of them is measurable on the hardware this project has.
The mid-range-Android 60fps claim is **not** binding — see the amendment in §1.4. Keep
measuring and reporting real CPU and GPU milliseconds: the numbers are useful evidence and
cost nothing. Just do not gate a release on a projection nobody can check.

| Metric | Budget |
|---|---|
| draw calls | ≤ 90 (hub ≤ 60) |
| triangles | ≤ 180k |
| unique materials live | ≤ 28 |
| shadow maps | 1, ≤1024 (512 low tier) |
| render targets live | ≤ 3 |
| per-frame allocations in `useFrame` | **0** (no `new`, no array/object literals, no closures) |
| React renders while playing | only on discrete events; **0** per frame |
| scene entry hitch | ≤ 1 dropped frame |
| DPR | clamped `min(devicePixelRatio, 2)` high / 1.5 mid / 1.0 low |

`window.__perf` must expose rolling avg/p95 frame time, long-frame count, and
`renderer.info` so critics can measure instead of eyeballing.
