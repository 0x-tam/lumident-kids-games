# ROUND 4 — CONSOLIDATED FIX LIST

Nine game critics and four cross-cutting critics. All nine games returned FAIL; all four
cross-cutting critics returned FAIL. 47 items below, deduplicated.

**Shared items (A) must land before game items (B).** Twelve of the game items are downstream
of a shared defect and are marked `depends: A#`.

---

# A. SHARED CODE — `src/three/**`, `src/shared/**`, `src/hub/**`, `src/GamesCollection.tsx`, `src/dev/**`

## A1 — blocker — Focus ring is a flat unlit sticker drawn through the world
**Owner:** shared
**Files:** `src/three/hit.tsx:406-407` (`TorusGeometry(1,0.09,8,48)` / halo / contour), `:461-492`
(`MeshBasicMaterial`, `depthTest:false`, `depthWrite:false`, `toneMapped:false`), `:626-630`
(`renderOrder` 997/998/999), `:512` (radius solve).

**Defect.** Eight games draw their keyboard focus indicator as a camera-billboarded, unlit,
un-tone-mapped, un-fogged annulus with depth testing disabled. Measured consequences across
six independent reviews: it is 240 px across a 150 px card in Tooth Match; ~190 px across a
143 px collider in Count the Teeth where it swallows three of five round-progress pips; it
draws *over* cards nearer the camera in `tooth-match-impact-f01.png` and over the doughnut it
is marking in `healthy-or-not-focus-f04.png`; it hides most of the towel it just rewarded in
`spot-the-difference-impact-f03.png`; it overhangs the tray rim in Sliding Puzzle; it is a red
rectangle over the whole board in Maze Escape. In a scene where every other object is in 52°
perspective it is a circle in the picture plane with zero shading across its tube. This is
simultaneously the "flat/uniform-albedo/hard-edge" rubric line and the "UI reads as a web page
over a 3D scene" line, and in a memory game it actively hides information.

**Fix.**
1. Replace `MeshBasicMaterial` with a lit clay material (`clayAccent`) so the torus takes the
   scene key and shows curvature across the tube. Keep `toneMapped` default (true).
2. `depthTest: true`, `depthWrite: false`, plus a small along-ray forward offset and
   `polygonOffset` so it never z-fights the surface it hugs. If occlusion legibility is
   required, render a second occluded pass at ~0.25 opacity instead of disabling depth.
3. Size it to the target's silhouette, not to a fixed multiple: change the radius solve at
   `:512` so the ring's outer edge lands at ~1.05× the projected silhouette of the marked
   object, and clamp it so it can never exceed the object's own footprint bounds.
4. Keep the two-tone (accent ring + ink contour) WCAG 2.4.11 scheme — a lit two-tone ring
   passes 2.4.11 exactly as well as an unlit one.

## A2 — blocker — `FocusRing` billboard uses a *local* quaternion, so it breaks under any rotated ancestor
**Owner:** shared
**Files:** `src/three/hit.tsx:604` (`g.quaternion.copy(state.camera.quaternion)`).

**Defect.** `g.quaternion` is local. World orientation therefore resolves to
`parentRotation × cameraRotation`. `src/games/smile-maker/scene.tsx:1736` rotates each prop
root (`root.rotation.set(pitch, yaw, roll + wobble*0.06)`) and the hit node is a child of that
root, so the ring renders as a ~100×50 px tilted ellipse lying *inside* the cape prop and
wobbling with it every frame. Measured aspect 2.0 against 1.00 for the seven games with
unrotated ancestors. Ten of Smile Maker's targets are affected. The file's own comment says
"a ring seen edge-on is not a focus indicator."

**Fix.** Compose out the parent: copy the camera's world quaternion, then pre-multiply by the
inverse of `g.parent.getWorldQuaternion(q)`. Alternatively reparent the ring group out of the
rotated node into the scene root and drive its position from the target's world matrix.
Add a selftest asserting the ring's projected bounding-box aspect is 1.0 ± 0.1 for every
registered target in every game.

## A3 — blocker — Cast shadows are flat grey decals; the PCSS solve is hidden behind them
**Owner:** shared
**Files:** `src/three/Rig.tsx` (`ContactBlob`), `src/three/materials.ts` (`clayGround`,
`CLAY.shadowTint` application), `src/three/tokens.ts` (`CLAY.shadowTint`, `STUDIO`),
`src/hub/HubScene.tsx` (hub card blobs).

**Defect.** `penumbra-measurement.json` proves the PCSS filter is live — edge width 1 px at a
0.05 u gap widening to 18–19 px at 2.0 u — but that measurement was taken with **all 16
`MeshBasicMaterial` ContactBlob decals forced invisible**. What the child sees is the decal.
Measured on shipped frames: the Healthy or Not tooth's shadow holds L\* 77.3→77.0 across
**112 px** and then falls off a cliff in ~10 px; the tooth's head is 0.6 u off the ground and
its shadow tip is exactly as hard as its foot contact. The hub is the same defect at scale —
950 px of gutter flat to ±0.05 L\*, a `#c4bfb4` slab covering **5.0 % of the frame**, dE2000
9.50 from page cream. It is also **grey, not warm**: lit ground `C 6.55 h 91.0` → shadow
`C 6.47 h 93.9`, i.e. chroma unchanged and hue rotated *away* from red. `CLAY.shadowTint` is
documented to hold red and pull blue; it is not reaching the ground material. §2 explicitly
names this the "3D viewport tell".

**Fix.**
1. Drive each `ContactBlob`'s radius **and** opacity from the caster's current height above
   the receiver, so the decal itself gains a penumbra (Sliding Puzzle's per-tile blob at
   `sliding-puzzle/scene.tsx:139-160,880-895` already does this correctly — lift that
   behaviour into the shared `ContactBlob`). Where the real PCSS shadow is sufficient
   (default and mid tier), delete the blob entirely and keep it only as the low-tier
   substitute.
2. Route `CLAY.shadowTint` into `clayGround`'s shadow term so shadows gain chroma and rotate
   warm rather than grey. Target: shadow chroma ≥ lit chroma, hue rotated toward red, not away.
3. Re-run `penumbra-measurement` **with the blobs visible**, at game framing, on the Healthy
   or Not tooth — not on an isolated sphere with decals hidden.

## A4 — blocker — The low tier ships hard edges, faceted silhouettes and a frowning mascot
**Owner:** shared
**Files:** `src/three/quality.ts:53-58` (`low: { antialias:false, maxInstances:90, detail:1 }`),
`:195/:201` (`SOFT_SHADOWS = BOOT_TIER !== "low"`), `src/three/geometry.ts:1114`,
`:1173-1174` (`pick3(dt, …)`), `:1456` (`TOOTH_SUBDIV[0] = 4`), `:1791` (`eyeBall` pinned).

**Defect.** `quality.ts:161 decide()` returns `low` for a coarse pointer with
`deviceMemory ≤ 4` — every mid-range Android tablet Chrome reports, i.e. §1.4's named target
device. At that tier: `healthy-or-not-tier-low.png` shows a 12-sided turntable with flat facet
planes, a decagonal dish with a **white z-fighting seam** along the liner/well join, and a
**hexagonal-prism milk bottle** with a ~90° shoulder step and a flat disc cap meeting the neck
at a sharp corner; `count-the-teeth-tier-low.png` shows a stair-stepped tray rim, jagged
polygonal pupils, and a tooth at `TOOTH_SUBDIV[0]=4` whose facets cut the mouth ball into a
**straight downturned dash — the mascot frowns**, with blush on one cheek only;
`tooth-rescue-tier-low.png` shows two pale rectangular slabs with unbevelled, unlit edges
punching up through the basket floor; `maze-escape-tier-low.png` shows a hard shading seam and
a near-absent cast shadow. §0: "there is no hard edge anywhere in this product." §3: "no
geometry ships with a 90° silhouette corner." §1.1: no sad or scary faces.

**Fix.**
1. Floor every silhouette curve at ~24 radial segments regardless of tier — change `pick3` so
   `detail:1` clamps lathe/torus/cylinder segment counts to a minimum rather than taking the
   coarsest entry. Cost is a few hundred triangles against a 180 k budget currently used at
   14.7 k on the affected scene.
2. Pin the mascot's detail: pass an explicit `detail` into `mascotParts`/`toothGeometry` so
   `TOOTH_SUBDIV` never drops below 6 at any tier — the same treatment `eyeBall` already gets
   at `geometry.ts:1791`. A counting game's character silhouette is the last thing the low
   tier should spend.
3. Restore FXAA (or MSAA×2) at low tier; buy it back from dpr or shadow-map size, not from
   silhouettes.
4. Fix the dish liner z-fight with a depth offset or by merging the liner into the bowl lathe.
5. Clamp the weave/fence decal's extrusion to `wallThickness − MIN_BEVEL` and enforce
   `MIN_BEVEL = 0.02` on the low-detail path, not only the high one.
6. Add low-tier at-rest frames for all nine games to the per-build verify script.

## A5 — blocker — The shared mascot has no smile
**Owner:** shared
**Files:** `src/three/geometry.ts:1589` (`MASCOT_FACE.mouth`), `:1882-1890` (`mascotParts`
mouth part, `geometry: ball`).

**Defect.** The mouth is a `softSphere` scaled `[w, shut..open, d]` — a flat horizontal
ellipsoid with **zero curvature**. There is no arc, no rotation and no curve term anywhere in
`MASCOT_FACE.mouth = { y:0.7, z:0.305, w:0.155, d:0.055, shut:0.026, open:0.1 }`, while the
doc-comment claims `open: 0` is "a closed smile". At the product's two largest `featureScale`
values this dominates: Tooth Rescue (1.6) renders two enormous solid-black eyes over a
dead-straight thick brown bar — the exact "skull" failure mode `geometry.ts:1846` warns about;
Maze Escape (1.62) is illegible at 30 px. This is the character in six of nine games, on every
hub card, and as the shared celebration hero. The product already draws a friendly tooth twice
(Healthy or Not's red ∪ arc; Smile Maker's 19-bead swept smile) — the shared mascot is the
odd one out and it is the one the child sees most.

**Fix.** Replace the ellipsoid with a curved sweep whose end points sit **above** its centre at
every `open` value. Port the tapered bead curve from `src/games/smile-maker/build.ts`
(`y = 0.573 + 0.052·t²`, 19 beads) into `mascotParts`, or build a torus-arc segment. Verify at
`featureScale` 1.0, 1.6 and 1.62, at `open` 0.0 / 0.5 / 1.0, at 8× crop.

## A6 — blocker — Memory never returns to the hub baseline, in 9 of 9 games
**Owner:** shared
**Files:** `src/three/dispose.ts` (`DisposalBag`, ownership tags, `markSceneExit`),
`src/three/Scene3D.tsx` (view unmount ordering), `src/three/celebrate.tsx`,
`src/three/hit.tsx` (ring/halo/contour cached geometry), `src/three/text.ts`,
`src/dev/perf.ts` (memory probe).

**Defect.** Every `<id>-memory-after.json` reports `withinSpec: false` after **one**
hub→game→hub round trip. Geometries +1…+3 in all nine (§5 allows **zero** tolerance on
geometries); programs +2…+6, breaching the ±2 tolerance in four (sliding-puzzle +3,
tooth-match +3, tooth-rescue +3, **smile-maker +6**). `cacheDelta` is zero on every registered
cache in every game, so the residue is in `outsideCaches` — nothing the eviction machinery can
reach. `endurance.json` plateaus at +4 geo / +3 tex / **+7 programs** / +18.5 MB across two
full nine-game loops, so it is bounded, not compounding — but it is outside a stated tolerance
with no owner. Separately, Tooth Rescue's exit leaves `taggedOwned: 17, taggedUnowned: 0,
activeScene: null` — 17 shared materials owned by a scene that no longer exists, which would
block eviction.

**Fix.**
1. Tag every `BufferGeometry` and every compiled program with its construction site and owning
   scene at creation (dev build). Dump the untagged survivors on `markSceneExit` and **name
   them** — the current evidence proves the residue exists and proves nothing about what it is.
   Leading suspects: geometry built by the shared celebration burst mounted into a game's
   `<View>`; `Rig`; render-target program variants (see A6/G-SM4).
2. Warm shared infrastructure (celebration materials, `hit.tsx` ring/halo/contour, `text.ts`
   glyph atlas) **once at boot, before the hub baseline is recorded**, so a one-time shared
   allocation is not scored as a per-game leak.
3. Reset ownership tags to `unowned` on `markSceneExit`.
4. Add `?selftest=memory` that enters and leaves the same game twice and asserts the second
   visit is delta-zero, and assert `outsideCaches.geometries === 0` on the leave path. The
   endurance plateau proves that assertion is achievable.

## A7 — blocker — The 60 fps mobile claim is unsupported and contradicted by the project's own model
**Owner:** shared
**Files:** `src/three/quality.ts:233-244` (`desktopGpuMsP95: 1.2` and its justifying comment),
`src/three/materials.ts` (PCSS branch, 20-tap filter), `src/three/Rig.tsx`
(`shadowMap.autoUpdate`, shadow frustum).

**Defect.** **29 of 30 scene/tier GPU readings breach the project's own
`desktopGpuMsP95 = 1.2 ms`**, by 1.13×–3.61× (worst: maze-escape default 4.335 ms). At the low
tier — the tier the target tablet boots — every scene reads 1.35–2.07 ms; applying the
project's own stated ×12 factor gives 16.2–24.9 ms, so **9 of 10 scenes miss a single 60 Hz
frame under the most optimistic conversion the project itself supplies**. Nothing in 843
evidence files touches the mid-range Android tablet §1.4 names; every number is an Apple M5 at
dpr 1 on a 120 Hz panel, and `fps ≈ 120` is that panel's vsync, not headroom. Draw calls,
triangles, render targets and CPU render cost are comfortably inside budget everywhere, so
this is fill and shadow-pass cost, not geometry.

**Fix.**
1. **Measure on real hardware.** One Mali-G52 or Adreno 610-class tablet, `?tier=low`,
   `window.__perf` for 240 frames per scene. Until that number exists §1.4 is an assertion and
   no round can pass this axis.
2. Meanwhile, take the two largest levers: (a) stop re-rendering the shadow map every frame —
   `shadowMap.autoUpdate` is left at three's default `true` in every scene except
   `spot-the-difference/scene.tsx:636`; hold it when nothing casting has moved; (b) reduce the
   PCSS blocker search from 8 taps to 4 and the filter from 20 fetches where the scene's depth
   range is shallow, and gate full PCSS to high tier only.
3. Tighten each scene's ortho shadow frustum to the real caster bounds (Maze Escape's
   `SHADOW_AREA = BOARD + 1.4` is the worst offender).
4. Amend the comment at `quality.ts:233-241` to say the ×12 factor is **projected, never
   measured**, so the budget number stops reading as a result.

## A8 — blocker — Two games render 0 draw calls / 0 triangles at 390×844
**Owner:** shared (View/rect plumbing) — affects `tooth-runner`, `smile-maker`
**Files:** `src/three/Scene3D.tsx` (tracked `getBoundingClientRect`, `<View>` scissor),
`src/three/view-slot.tsx`, `src/three/Stage.tsx` (canvas rect), `src/shared/GameShell.tsx`
(play-area host height).

**Defect.** `viewport-summary.txt` at a true 390×844 via `Emulation.setDeviceMetricsOverride`:
`tooth-runner  draw calls 0  triangles 0`, `smile-maker  draw calls 0  triangles 0`.
Confirmed on a re-run with a deliberately longer settle after an earlier false negative on
Count the Teeth. `tooth-runner-phone.png` and `smile-maker-phone.png` show the DOM chrome laid
out correctly with a blank cream play area of real height (the "Tap to run" pill sits at
y≈708/844, i.e. `bottom-[14%]` of a ~480 px box). Two of nine games are unplayable by touch,
keyboard or anything else on the device class PROJECT.md names first. `cameraFor` was ruled
out by hand-solving it for the phone rect; zero draw calls means the `<View>` is being skipped
entirely, not mis-framed.

**Fix.** Log the tracked `getBoundingClientRect()` and the play area's computed height at
390×844 on mount for both games, plus the `<View>` scissor rect against the `Stage` canvas
rect. Most likely cause: the play-area host collapses to zero measured height once the control
row wraps to two lines, while the absolutely-positioned `<View>` element has no containing-
block height — `GameShell`'s own dev guard already warns about that collapse. Then add
`?selftest=viewport` asserting `renderer.info.render.calls > 0` for **every** registered game
at 390×844, 768×1024 and 1440×900.

## A9 — blocker — `--chrome-h` publishes a scalar, so the HUD paints on top of the game
**Owner:** shared — affects `sliding-puzzle`, `healthy-or-not`, `count-the-teeth`,
`tooth-rescue`, `maze-escape`
**Files:** `src/shared/GameShell.tsx` (chrome measurement, `--chrome-h` write, `:307-346`),
each game's `cameraFor` caller (`SlidingPuzzle.tsx:96-111`, `HealthyOrNot.tsx:56-60`,
`CountTheTeeth.tsx:110-113`, `ToothRescue.tsx`, `MazeEscape.tsx:93-122`).

**Defect.** The shell publishes a single top-inset scalar. At narrow widths the chip row wraps
onto a second line and the difficulty pills grow, and neither is reflected in that number, so
the camera solve believes it has vertical band it does not have and the chips land on the
subject. Measured on shipped phone captures: Sliding Puzzle's `0:00` timer and `★ 0` chips are
drawn **on top of the reference plaque**, the timer squarely over the tooth's face — the game
becomes unplayable because the child cannot see what they are building, and
`SlidingPuzzle.tsx:96-110` names this as a round-3 finding it claims to have fixed. Healthy or
Not's `0:00` chip sits on the mascot's left eye and `★ 0` covers the right of its head. Count
the Teeth hides a counted tooth more than half behind the frosted level pill. Tooth Rescue's
timer chip occludes and clips the mascot's head, leaving a one-eyed character.

**Fix.** Publish the chrome's **measured occupied rect** (the union of the title band, the pill
row and the chip row bounding boxes), not a height scalar. Have every `cameraFor` treat that
rect as a keep-clear region — a hard floor on the subject's screen-space top, the same rule §2
already applies to the celebration's copy band. Make `GameShell`'s `ResizeObserver` observe the
chrome element as well as the play area. Add framing assertions at 390×844, 360×640 and
414×896 that no game's subject silhouette intersects the chrome rect.

## A10 — blocker — The celebration destroys the child's work and frames it in browser chrome
**Owner:** shared — affects `sliding-puzzle`, `tooth-rescue`, `maze-escape`, `tooth-runner`
**Files:** `src/three/celebrate.tsx` (`celebrationHeroScale`, `solveCelebrationCamera`),
`src/shared/GameShell.tsx:576-632` (dialog), `:922-940` (score plate).

**Defect.** Three defects in one beat.
(a) `celebrationHeroScale()` scales the game's stage to zero as the celebration arrives. In
Sliding Puzzle (`scene.tsx:798-799`) that takes the tiles, relief, shadows, socket **and the
reference plaque** with it — the completed bear survives frames f01–f05 and by **f06 the tray
is empty**; in a 2×2 run the finished picture lasts **3 frames** of a 25-frame celebration.
62 arrow presses of work are erased and replaced with a dialog box. In Tooth Rescue the
basket, the whole caught pile and the mascot vanish, leaving a blurred void and a floating
white "200 pts" pill. In a picture puzzle the picture *is* the reward.
(b) The headline receives programmatic focus and the browser draws a **hard-cornered
rectangular focus outline** across the 3D board — visible in `maze-escape-keyboard-end.png`,
`tooth-rescue-keyboard-end.png`, `tooth-runner-keyboard-end.png`,
`sliding-puzzle-celebration-f12.png`. A right-angled 1 px box over the hero moment, in a
product whose first paragraph is "there is no hard edge anywhere."
(c) `solveCelebrationCamera` is given no occluders, so in Maze Escape the celebration mascot is
**sliced by a coral wall** at its right cheek.

**Fix.**
1. Stop scaling the stage to zero. Solve the celebration camera against the *finished* board:
   dolly back and tilt so the mascot lands beside or behind the child's work, with the work
   held in frame, and let the DOM copy occupy the band the celebration already treats as
   floor. Where the mascot genuinely cannot coexist (Sliding Puzzle's mascot arrives through
   the middle of the picture), drop the mascot for that game and let the closed slab of relief
   be the hero — it already has a bow.
2. Pass the scene's occluders into `solveCelebrationCamera` so the podium is placed clear of
   wall geometry, or fade the board to a flat backdrop rather than a partial opacity ramp
   (Maze Escape currently dissolves its bottom third mid-object).
3. Replace the DOM focus outline on the headline with the rounded `ring-coral-deep` treatment
   already used at `MazeEscape.tsx:328`, or set `outline: none` on the programmatically
   focused heading and rely on the dialog's own framing.
4. Add the missing `?selftest=celebration-framing` §2 names — it is absent from the registry
   and it is exactly the check that would have caught (a) and (c).

## A11 — major — The one adaptive-quality safety net is inert for GPU-bound frames
**Owner:** shared
**Files:** `src/three/Stage.tsx:126-127`.

**Defect.** `over = p95(period) > 22.5 ms && p95(work) > 9.2 ms`. `work` is CPU time between
`beginFrame` and `endFrame`. A GPU-bound frame — precisely what a fragment-bound clay shader
on a tablet produces — stretches `period` while `work` stays at the 0.3–1.5 ms these captures
measured, so the `&&` refuses to degrade in the only scenario the degrade exists for.

**Fix.** Add a third arm using the GPU timer `src/dev/perf.ts` already collects, or drop the
`work` gate to `BUDGETS.frameMsP95 * 0.25` and rely on the existing 3-strike / 2.4 s hysteresis
to reject 30 Hz panels and background throttling.

## A12 — major — Three perf self-checks are looser than, or measure the wrong thing from, the spec
**Owner:** shared
**Files:** `src/dev/perf.ts:298` (`DROPPED_FRAME_MS = 25`), `:881/:938/:1136/:1141` (its uses),
`:920` (entry-hitch budget `50`), `:896` (`violation(out,"programs",programs,BUDGETS.materials,…)`).

**Defect.**
(a) `DROPPED_FRAME_MS = 25` cannot see a single dropped vsync on the 120 Hz display these
captures ran on (a dropped frame there is a 16.7 ms interval). The entire "0–1 dropped frames
everywhere" headline was produced by a counter blind to the failure it counts — maze-escape's
13.0 ms worst frame is a missed vsync scored as clean.
(b) The entry-hitch budget of 50 ms is justified in-comment by a 30 Hz assumption. §9 says one
dropped frame — 33 ms at 60 Hz, 16.7 ms at the capture display. Smile Maker's measured 17.7 ms
entry frame passes a check 1.5–3× looser than the spec it claims to enforce.
(c) `:896` asserts `renderer.info.programs.length` against `BUDGETS.materials`. Those are
different quantities. `endurance.json:finalPrograms` shows 11 programs whose `usedTimes` sum to
**41 live materials at the hub** against a §9 budget of 28 — the budget was breached and the
check passed at 11 ≤ 28.

**Fix.** Derive both thresholds from the measured display period: sample the modal rAF interval
over the first second, then a dropped frame is `> 1.5 × period` and the entry-hitch budget is
`2 × period`. Change `:896` to sum `usedTimes` across `renderer.info.programs` (or traverse the
scene collecting distinct `material.uuid`) and assert **that** against `BUDGETS.materials`;
report the program count as a separate metric.

## A13 — major — `warmScene()` is exported for a prefetch nobody wired, so shader compile runs on the entry frame
**Owner:** shared
**Files:** `src/three/Scene3D.tsx:243` (`export function warmScene`), `:268` (called from
inside `useFrame`), `:213-219` (the comment specifying the intended call site),
`src/GamesCollection.tsx:504/509/514`, `src/games/index.ts:38`.

**Defect.** The hub's hover/focus/pointerdown prefetch resolves the JS chunk only. `gl.compile`
therefore runs inside the entry frame's `useFrame`, measured at 1.2–7.2 ms per game on an M5
*with* `KHR_parallel_shader_compile`, alongside 256²×4-octave CPU noise texture generation
(`src/three/textures.ts:243`). On an Adreno 610 driver without off-thread linking, compiling
3–6 clay `MeshPhysicalMaterial` variants is routinely 50–300 ms. Every child, every game,
every entry. The file's own comment says "until it is called from there, the entry hitch is
measured, not removed."

**Fix.** In the hub's prefetch path, once the chunk resolves, call
`warmScene(gl, scene, camera, id)` during the 450–600 ms transition — the one window where the
cost is invisible. Pre-generate the noise textures in the same pass.

## A14 — major — Micro grain is present in code and absent on screen
**Owner:** shared — affects `maze-escape`, `sliding-puzzle`, `tooth-rescue`, `healthy-or-not`
**Files:** `src/three/materials.ts:1010-1011` (grain binding, `normalScale`), `GRAIN_REPEAT` /
grain tile size (`materials.ts:134`, 0.75 world units), `src/three/textures.ts` (fbm builder),
`src/three/geometry.ts` (`bakeCurvatureAO`).

**Defect.** Measured high-pass (9 px box, luminance) on the largest surfaces in the product:
Sliding Puzzle tile face **σ 0.497/255, p99 1.25/255**; Maze Escape coral wall top **σ 2.94/255
— 1.2 % variation across the largest object on screen**; Tooth Rescue alcove high-frequency
**σ 0.628** against 5.434 on the basket in the same frame. §3 requires "fingerprinted clay
tooth, never a uniform plastic albedo" at 0.08–0.15 strength. Two structural causes: (a) the
grain tile is **0.75 world units** while a 4×4 sliding tile is 0.67 units — one grain period
per tile is a low-frequency mottle that at ~70 screen px resolves as a smooth gradient; (b)
the grain is not triplanar, so it streaks in a single direction across an entire 12-unit maze
board (visible as one diagonal streak on every wall). Additionally, the mottle amplitude is
crushed on dark albedos (`coral.deep` alcove) and `bakeCurvatureAO` is producing no crevice
darkening at Maze Escape's concave corridor corners.

**Fix.**
1. Scale grain repeat per object so a small prop carries 3–4 periods rather than one; expose it
   as a per-material parameter rather than one world constant.
2. Make the grain UV triplanar and world-space so it stops stretching along carved contours and
   stops running one direction across a whole board.
3. Scale mottle amplitude by 1/luminance so it survives on `deep` tones.
4. Verify `bakeCurvatureAO` actually runs on the Maze Escape and Tooth Rescue geometry — the
   zero-darkening concave corners say it does not. Add a build assertion.
5. Acceptance target: wall-top high-pass σ ≥ 8/255 at 1:1 on Maze Escape; ≥ 2.0 with a
   top-to-bottom luminance sweep ≥ 15 levels on the Tooth Rescue alcove.

## A15 — major — Scenes hard-code hero hexes, so the 3D world contradicts the registry in 4 of 9 games
**Owner:** shared (helper + registry) + the four games
**Files:** `src/games/index.ts` (`GAMES[id].accent`), `src/three/tokens.ts` (`ACCENTS`,
`accent()`), then `src/games/healthy-or-not/props.ts`, `src/games/count-the-teeth/scene.tsx`,
`src/games/tooth-rescue/set.ts` + `scene.tsx`, `src/games/spot-the-difference/diorama.ts`.

**Defect.** Classifying every saturated pixel (C\* > 25) in each play area to its nearest family
token: healthy-or-not is registered `peach` and **0.1 %** of its saturated pixels are nearest
peach (mauve 64.3 / red 21.6); count-the-teeth is registered `coral` and is 75.0 % red;
tooth-rescue is registered `red` and is 76.9 % coral; spot-the-difference is registered `rose`
at 23.3 % (peach 40.9 dominant). The CSS chrome reads the registry correctly — all nine
difficulty pills land on their registered family's hue lane — so inside a single frame the pill
and the world disagree: a coral pill 250 px above a red mat, a peach pill above a red apple in
a mauve bowl.

**Fix.** Make every scene pull its hero colour from `accent(GAMES[id].accent, tone)` rather than
a literal hex. One change per scene file; it also fixes Tooth Match's orange star and Tooth
Runner's red focus ring. Add a dev assertion that no game scene constructs a colour literal
outside `tokens.ts`.

## A16 — major — Systematic accent drift: every mid/dark accent lands off-token
**Owner:** shared
**Files:** `src/three/env.ts` (tone mapping, exposure, PMREM intensity), `src/three/tokens.ts`
(`STUDIO`), `src/three/materials.ts` (albedo → linear conversion).

**Defect.** Sampled against the 29 tokens with CIEDE2000: mid-to-dark accents share one
signature — `dL −1.8…−3.2`, `dC +3…+8.6`, `dh +4…+5°` toward orange (rescue back wall dE 4.64,
maze block top 4.76, tooth-match card 3.41, count mat 4.98, rescue basket 8.07, runner bottle
8.35). A light low-chroma token lands at dE **0.51** (`peach.main` on the runner's far hill),
which proves the pipeline can hit a token exactly. This is one calibration issue, not nine
authoring mistakes.

**Fix.** One tone-map / env-multiply calibration pass anchored on the `#EDE7DC` ground, which
`tokens.ts` already defines as the reference. Then re-verify all 29 tokens through a render and
require dE2000 ≤ 3 for every family's `main` and `deep`.

## A17 — major — `announce()` queue is outrun at gameplay tempo
**Owner:** shared
**Files:** `src/three/hit.tsx:100-180` (`announce`, `LIVE_CLEAR_MS`, `LIVE_HOLD_MS`,
`LIVE_QUEUE_MAX`).

**Defect.** Each message is held `LIVE_CLEAR_MS + LIVE_HOLD_MS` = 260 ms and the queue caps at
8, dropping the oldest. Maze Escape announces on every keyboard move; a child arrowing at 3/s
permanently outruns the queue, so narration lags up to ~2 s behind the board and
"You reached the toothbrush!" queues behind eight stale move announcements. Tooth Runner fires
a 12–16 word sentence on every spawn at a 0.85–1.45 s Hard cadence — `tooth-runner-keyboard.txt`
records `Live region: []` at the end of a completed run. The feature is implemented and unusable
at tempo.

**Fix.** Coalesce consecutive same-kind announcements (keep only the newest positional
description in the queue) and let `complete` jump the queue as assertive. Per game: Maze
coalesces `move`; Tooth Runner drops the spawn sentence entirely and keeps only the short
`approach` cue, with collections announced on a 2 s coalescing window.

## A18 — major — Selftest coverage gaps that let every blocker above ship silently
**Owner:** shared
**Files:** `src/dev/selftest.ts`, `src/dev/verify.ts`, `src/dev/perf.ts`.

**Defect.** (a) No `celebration-framing` selftest exists although §2 names it — it is exactly
the check A10 needed. (b) `hit-targets` computes `probe.x/y/r` and never bounds-checks them
against the view rect, so Count the Teeth's clipped tiles pass while the panel mask cuts them
(the `count` selftest simultaneously reports "clear by 0.017", ≈1–2 px). (c)
`hitTargetsPerGame` is reported as an unlabelled sequence (`4/0/6/3/8/0/3/0/10`) so a
per-game zero cannot be attributed; three games ship zero colliders and nothing says which.
(d) Count the Teeth's §6.7 occlusion proof is an offscreen ID render of the 3D scene and is
structurally incapable of seeing a DOM occluder, so its "worst tooth 99.4 % unoccluded"
guarantee is false on phone and can never say so. (e) No selftest measures in-world `text.ts`
label contrast. (f) No selftest asserts non-zero draw calls per viewport (see A8).

**Fix.** Add: `celebration-framing`; a bounds check in `hit-targets` rejecting any probe circle
that leaves the *masked* view rect; per-game-id keying of `hitTargetsPerGame`; compositing (or
at minimum rasterising) the chrome rect into the count occlusion mask; a `text-contrast` check
sampling rendered label pixels against their plate; and `?selftest=viewport` per A8. Run all of
them at 390×844, 768×1024 and 1440×900.

## A19 — minor — Spring damping band is violated across the product while comments claim compliance
**Owner:** shared (spec) + `maze-escape`, `healthy-or-not`, `tooth-match`, `smile-maker`
**Files:** `docs/3D-SPEC.md §4`; `src/games/maze-escape/scene.tsx:317,318,765,766` (11/15/13/12,
and `spin` stiffness 240 under the 260 floor) with the false compliance claim at `:160`;
`src/games/healthy-or-not/scene.tsx:472,945`; `src/games/tooth-match/scene.tsx:334`;
`src/games/smile-maker/scene.tsx:390,761` (`easeOutBack(k,1.5)` under the 1.6–2.0 band).

**Defect.** §4 states `stiffness 260–420 / damping 18–28` as an absolute. Nine springs across
four games sit outside it. Maze Escape's `scene.tsx:160` explicitly rejects damping 15 as
out-of-band on one spring in the same file that ships 11, 12, 13 and 15 on four others — a
false compliance claim in a comment is how a rubric line gets waved through.

**Fix.** Either bring all of them inside the band, or amend §4 with an explicit, numbered
"comic wobble / underdamped ring-down" exception and annotate each site with which exception it
claims. Do not leave a comment asserting compliance that the same file contradicts.

## A20 — minor — The two-tone focus-ring contrast guarantee is false for one shipped clay colour
**Owner:** shared
**Files:** `src/three/hit.tsx:410-422` (the claim), `src/three/tokens.ts` (`CLAY.gumDeep`).

**Defect.** The comment states "whichever tone loses contrast against a given backing, the other
carries the indicator." On `CLAY.gumDeep #c74430` the ring is **1.23:1** and the ink contour is
**2.63:1** — neither clears 3:1. Nothing is broken today (Maze uses `CLAY.gum` at 3.80:1), but
the invariant is stated as universal.

**Fix.** Add a selftest running `contrastRatio` over both ring tones against every clay colour a
ring can be drawn on, and lighten the contour (or add a third pale tone) until every backing has
one tone ≥ 3:1.

## A21 — minor — Chrome furniture is made of hairline strokes
**Owner:** shared
**Files:** `src/shared/icons.tsx`, `src/index.css:287-296`.

**Defect.** The chips themselves are excellent — neumorphic clay pills on `#faf6ee` with warm
`rgba(64,54,42,…)` shadows and warm-white inset highlights, inside the page's own value range.
The glyphs on them are ~1.5 px vector outlines. In a product whose first paragraph is "there is
no hard edge anywhere", the chrome is made entirely of the thinnest possible hard edges.

**Fix.** Replace the speaker / refresh / clock strokes with small filled soft shapes or extruded
clay reliefs at the same optical weight.

## A22 — minor — Live-region role swap and `inert` with no fallback
**Owner:** shared
**Files:** `src/three/hit.tsx` (live region element), `src/shared/GameShell.tsx:576-632`.

**Defect.** `role` is swapped between `status` and `alert` on the *same* live node, which several
assistive technologies handle unreliably. `inert` ships with no fallback for Safari < 15.5.

**Fix.** Use two sibling live nodes (one `polite`, one `assertive`) and route by urgency.
Add an `inert` polyfill or an explicit `aria-hidden` + focus-trap fallback path.

## A23 — minor — All performance numbers come from a Vite dev server, never a production build
**Owner:** shared
**Files:** capture harness / `src/dev/perf.ts` invocation.

**Defect.** `transition-summary.txt` states it: cold start 123 ms, `panelInDom` 218–1947 ms and
every transition timing were measured against unbundled ES modules. A production build changes
the shape of the entry frame — one chunk arriving, mounting and compiling together — and can
make the entry hitch **worse**. `dist/` exists and was never captured from.

**Fix.** Re-run the entry, transition and endurance passes against `vite build && vite preview`.

---

# B. GAME-SCOPED ITEMS

## B1 — Sliding Puzzle (`src/games/sliding-puzzle/**`)

**SP1 — blocker — the finished picture is deleted at the moment the child finishes it.**
`scene.tsx:798-799`, rationale at `:615-623`. See **A10(a)** for the shared mechanism.
Game-side fix: solve the celebration camera against the completed board and keep `stageRef` at
scale 1; if the shared mascot cannot be placed clear of the picture, opt this game out of the
mascot and let the closed relief slab (last piece drops, grooves sink, tiles converge) be the
hero. `depends: A10`.

**SP2 — blocker — 187,764 triangles at 4×4 against the 180,000 §9 budget.**
`scene.tsx:539` (`const bevelSteps = getQuality().detail <= 1 ? 1 : 2;`) keys off tier but not
board size; 16 relief windows at `bevelSteps: 2` (rings = 6 per outline, `family` alone 55
polys) overshoot by 4.3 %. Self-flagged in `sliding-puzzle-perf.json:violations`.
**Fix:** `getQuality().detail <= 1 || size >= 4 ? 1 : 2`, or add a triangle assertion inside
`boardRelief` (`reliefMesh.ts:539`) that steps `bevelSteps` down until the merged set is under
budget. At 4×4 the pieces are ~70 screen px and the second quarter-round ring is invisible.
Add the 4×4 board to the perf selftest.

**SP3 — major — relief overruns the frame it is supposed to sit inside.**
`scene.tsx:431` (`const inset = tileSize(size) - 0.09`) vs `layout.ts:149`
(`windowHalf = tileSize/2/HALF`). The printed face panel is inset 0.045 u per side; the relief
window is the **full** `tileSize`, so relief runs 0.045 u — 13 % of a 4×4 tile's half-width —
past the panel onto the tile's rounded rim, and motifs appear to hang off the tile into the
tray well. The geometry is correctly clipped (verified: worst |x|/|z| 0.33500 against a 0.335 u
half-extent, 0.00 % overhang), so this is a registration mismatch, not a clipping bug. The
header at `scene.tsx:22-24` promises "the tile body's own rim reads as a frame around the
picture"; it does not.
**Fix:** pass `windowHalf` the **inset** panel size and re-derive `convergeFactor` from the
same number so the solved board still closes to a continuous slab.

**SP4 — major — dark relief renders as flat black with a hard silhouette.**
`reliefMesh.ts:26-30` (which documents this exact problem and claims to have solved it),
`scene.tsx:467-483` (`grain: 0.1`, `grain: 0.11`). At 4× zoom the `ink` capsule is pure flat
black with a hard silhouette, no bevel highlight, no edge gloss, no rim — the bevel is real
(all 132 pieces ≥ 0.0216 u, above the 0.02 floor) but a near-black albedo multiplies the
curvature signal to nothing. The brown wedge beside it is one uniform field with a 1 px
contour. `depends: A14` for the grain half.
**Fix:** floor the `ink` palette entry well above black (`#2F3237` at ~0.03 linear cannot show
curvature at any bevel width) **or** give dark relief a dedicated rim-light term so its
silhouette rolls; and raise `WEAR` (currently 0.06) on the top bevel so exposed edges go
lighter and desaturated as §3 requires.

**SP5 — minor — the level control is notation, not an affordance.**
`SlidingPuzzle.tsx` level pills: `2×2 / 3×3 / 4×4`, plus `Moves: 0`, `Next picture`, `0:00`.
Nothing in the chrome is legible to a pre-reader.
**Fix:** render the three levels as three miniature clay boards with 4 / 9 / 16 tiles. Same
control, zero reading.

*(Phone chip-over-plaque → A9. Relief grain → A14. Focus ring → A1.)*

## B2 — Maze Escape (`src/games/maze-escape/**`)

**ME1 — blocker — the toothbrush goal interpenetrates the gum wall in every capture.**
`layout.ts:121-122` (`ALCOVE = 0.26`, `GOAL_OFFSET = 0.46`), with the decision recorded at
`:108-110` ("`ALCOVE` is deliberately *not* widened to follow it"). The brush foot sits 0.96
cells into a cell whose far edge is 1.0, in a bay carved only 0.26 cells past it, then leaned
28° (`BRUSH_TILT`) and yawed 17° (`BRUSH_YAW`) so its swept volume leaves the bay entirely.
Result: the cream brush head is sliced by the coral surface, the brown handle passes through
the wall mid-span, the mauve goal pad is half-buried, and a shadow decal floats on a vertical
wall face. This is the object the entire game exists to reach.
**Fix:** solve `ALCOVE` from the brush's actual swept bounds — take the brush parts' AABB,
apply `BRUSH_TILT` and `BRUSH_YAW`, add the `brushRef` beckon's rock-and-rise envelope, project
onto the two border-wall planes, and carve to that plus 0.02 minimum-bevel clearance. If the
resulting bay pinches the board's rounded corner, move the brush inboard to the goal cell
centre and offset the tooth's rest position instead — never leave the prop inside the wall.

**ME2 — blocker — worst GPU cost in the product: 4.335 ms p95, 3.61× the project's own budget.**
`perf-vs-budget.txt:15`; low tier still 1.703 ms (1.42×). Triangles (51 k) and calls (46) are
well inside §9, so this is fill and shadow-pass cost: a full-frame board with 20-tap PCSS on
both the gum block and the carved floor. `depends: A7`.
**Fix:** bake the corridor floor's wall occlusion into vertex colour (the machinery exists in
`build.ts::buildFloor`) and take the floor off `receiveShadow`; tighten the ortho frustum from
`SHADOW_AREA = BOARD + 1.4` to the board's real bounds; drop the PCSS blocker search to 4 taps
for this scene's depth range. Require ≤1.2 ms p95 at default tier before this ships.

**ME3 — blocker — unplayable at 390×844.** `layout.ts:270-318` (`cameraFor`),
`MazeEscape.tsx:93-122` (measurement). The board bleeds off all four edges, the tooth is
clipped by the level pills, the time/score chips are painted on the coral, and **the goal is
entirely off-screen**. `cameraFor` is a genuine fit solve, so the failure is the input rect or
the `min(0.34, …)` chrome clamp under-counting a two-row HUD. `depends: A9`.
**Fix:** instrument `cameraFor`'s inputs on a real 390×844 load and log
`width/height/chrome/aspect/raw/scale`; the symptom (too close in *both* axes) says `width` is
read larger than the real play area. Add `?selftest=maze-framing` asserting at 390×844,
360×640 and 414×896 that the board AABB **and** the goal prop project inside the play-area rect.

**ME4 — major — straight 45° shading seams across the wall tops.**
`build.ts:556-585` (`fieldNormals` skips `relief.shared` boundary vertices), visible in
`crop/tab_seam.png`, `crop/lowreduced.png`, `crop/rest_corner.png`. Field-normal vertices sit
next to flat +Y vertices along the subdivision lattice and the discontinuity draws as a ruled
line. A perfectly straight crease on hand-pressed clay is a defect and a §0 hard edge.
**Fix:** ramp the field normal to +Y across a one-ring band inside the shared boundary rather
than switching at it — reuse the `WALL_RELIEF_RAMP` blend already applied to the height field.

**ME5 — major — the start ring's arcs disappear into the wall base.**
`props.ts:427` builds it at major radius `0.34·cell` + tube `0.055` = 0.395 cells outer, and
`props.ts:420-426` argues it "never runs under the gum". That arithmetic ignores the bevel the
same codebase documents at `build.ts:13-21` ("swells outward through the middle, so the hole is
widest at the top"), so the corridor's **clear** width at `FLOOR_Y + 0.006` is under 1.0 cell.
Contradicted by four captures.
**Fix:** derive the ring radius from the corridor's clear half-width evaluated at the ring's
actual Y (contour inset minus the extrusion's inward swell at that height), not from
`0.5·cell`. Add a build-time assertion comparing the two.

**ME6 — major — celebration mascot sliced by a coral wall; board dissolves mid-object.**
`maze-escape-keyboard-end.png`. `depends: A10`. Game-side: supply the maze board's occluders to
`solveCelebrationCamera` and replace the partial opacity ramp with a full fade to a flat
backdrop.

**ME7 — minor — no hit-target coverage.** `selftest.json` records "no live colliders in this
scene — nothing asserted." The game uses a raw 60-unit picking plane (`scene.tsx:1310-1319`)
with `SNAP_RADIUS = 0.78` cells as its only tap-size guarantee; on a 13-cell Hard board at
phone width that acceptance diameter works out to roughly 43 px, under §8's 48 px floor.
**Fix:** register a synthetic collider per open cell, or a single probe reporting the snap
acceptance diameter in screen px, so `?selftest=hit-targets` asserts something across 9/11/13
cells at phone, tablet and desktop. `depends: A18`.

*(Spring damping → A19. Announce flood → A17. Grain/AO → A14. Focus ring → A1.)*

## B3 — Tooth Match (`src/games/tooth-match/**`)

**TM1 — blocker — the phone board is clipped on three sides while 246 px of viewport go unused.**
`layout.ts:435` (`CHROME_FALLBACK_PX = 132`), `:491` (`MIN_BOARD_SCALE = 0.62`),
`ToothMatch.tsx:51-72`. Measured at a true 390×844: the top card row is sliced flat at y = 316
(132 red pixels on one row through three rounded card tops); the left column is visible at
~40 % of its width with its emblem cut in half; the right column the same; the board's lowest
pixel is y = 598 in an 844-high viewport. Two of six cards are unplayable and their
48 px-guaranteed colliders extend off-screen. `layout.ts:485-487` asserts the solve holds
everything at 0.955 NDC down to 280×810; the shipped render disproves it. `depends: A9`.
**Fix:** make `Board`'s `ResizeObserver` observe the chrome element as well as the play area,
fall back to `playArea.getBoundingClientRect().top` rather than the 132 px constant, and add a
regression case at 390×844 × Easy/Medium/Hard asserting every card vertex inside `1 − MARGIN_NDC`.

**TM2 — blocker — the card back competes with a motif.**
`scene.tsx:770` (back emblem: centred warm-orange six-lobed rosette, `clayAccent("peach","main")`)
vs `motifs.ts` `starShape` (centred warm-orange five-petal relief). Same hue family, same
placement, same scale, both radially lobed, both raised — visible together in
`tooth-match-reduced-i01.png`. `motifs.ts:26-33` names this as the round-3 defect and claims it
was fixed by construction; the silhouette ratio moved (3.35 vs 1.44) and the gestalt did not.
At 100 px a child is asked to tell a five-petal flower from a six-lobed rosette.
**Fix:** change the **back**, not the star. Replace the rosette with a non-radial debossed
field — a quilted diamond lattice, or an off-centre corner mark in `red.deep` on `red.main` —
so no motif can ever collide with it.

**TM3 — major — 54.6 ms entry hitch, 3.3 dropped frames at 60 Hz.**
`realtime-perf.json` `hitch:enter:tooth-match` against the app's own 50 ms budget. Note
`tooth-match-enter.json`'s `worstMs 1.5` is inadmissible — captured under `?drive=1` with
`"clock":"virtual"`, which cannot see a presented frame. The entry frame runs `buildMotifs()`
plus eight relief geometry builds plus `bakeCurvatureAO` plus two `roundedPlate().clone()` plus
`ensureInstanceAlbedo` synchronously in one commit (`scene.tsx:165`, `:704-748`).
**Fix:** move `buildMotifs()` behind the card-hover/focus prefetch §5 already mandates
(`depends: A13`), or split it across two frames — the board renders face-down on the first
frame and face-down cards need no reliefs at all.

**TM4 — major — the `brush` motif does not name its object and has a bad second reading.**
`motifs.ts`, `brush`. A fat lumpy lozenge wider than the head it hangs beneath, no neck, in
saturated deep red, topped by an ivory bristle block that is ivory-on-near-ivory against the
`mauve.soft` panel. At the shipped ~100 px it reads as a red bean under a white cap; on a
tooth-white card in a paediatric dental clinic an irregular deep-red smear has a second reading
nobody wants (§1.1 adjacency).
**Fix:** narrow the handle to a real stick ≈0.35× the head's width with a pinched neck, and put
an accent ferrule in `coral.deep` between neck and bristles so the half that names the object
carries the contrast.

**TM5 — major — `fitRelief` does not fit the star.**
`motifs.ts` `fitRelief`, header claim at `:44-53` ("every vertex … inside the card's outline and
inside its footprint"). In `crop/tm-star.png` the star's left arm crosses the pink panel edge,
crosses the card's ivory rim, and its tip lands over the tray channel **outside** the card.
**Fix:** `fitRelief` is measuring a bound that excludes the arm tips, or measuring before the
final scale. Walk the shipped vertex buffer after all transforms and assert containment in a
selftest rather than in a comment.

**TM6 — minor — the `tooth` motif has 1.24:1 silhouette contrast.**
`clayEnamel` ivory on the near-ivory `mauve.soft` panel; only the mascot's eyes and grin carry
it, so on a small screen a child sees two black dots. Conceded as deliberate in `motifs.ts`.
**Fix:** darken the panel behind only the tooth card, or give the tooth a `mauve.deep` shadow
plinth so it has a silhouette to read against.

*(Focus ring → A1. Memory +1 geo/+3 programs → A6. GPU 2.794 ms → A7.)*

## B4 — Healthy or Not? (`src/games/healthy-or-not/**`)

**HN1 — blocker — the phone frame hides the mascot's face and cuts an answer target in half.**
`healthy-or-not-phone.png` at 390×844: the `0:00` pill sits on the mascot's left eye and
forehead, `★ 0` covers the right of its head (both with their own drop shadows), and the
terracotta dish — one of the two answer targets — is **guillotined by the panel's right edge**.
`HealthyOrNot.tsx:56-60` reads `--chrome-h`; the header wraps to three rows at that width and
the chip row spills past it. `layout.ts:550-555` puts the dish ring in the silhouette set and it
is still cropped, so either the solve runs against a stale rect or `EDGE_MARGIN` is consumed by
the wrapped chrome band. `depends: A9`.
**Fix:** per A9 for the chip band; then re-check `layout.ts::cameraFor` at aspect 0.462 with the
solved silhouette-fit result logged so the crop can be attributed to the solve or the harness.

**HN2 — major — the "no" answer carries no meaning, and the obvious action does not answer.**
`scene.tsx:1998-2005` (the dish, labelled "Tap to wave this food away" — for a screen reader),
`scene.tsx:1494-1502` (first tap on the food picks it up and turns it; a second tap feeds it,
with a silent default of "healthy"), `scene.tsx:324` (records that this prop replaced a **waving
hand** and then a **lidded bin**, both more readable). An empty terracotta saucer does not read
as "no thank you" to a pre-reader, and a child who taps a cupcake twice answers "healthy".
Compounded by the palette: all five accent families are warm reds/oranges (`tokens.ts:17-23`),
so the apple, strawberry, doughnut, cupcake and candy are all the same red — nothing separates
healthy from sugary.
**Fix:** put a waving-hand prop back **beside** the dish (it can still lob food into an open
dish, so §6.4's "nothing shuts over the answer" survives), or give the dish a persistent
in-world "no" cue visible before any tap. On the food's first tap, light up both destinations so
the second step is discoverable without the aria label. And introduce a non-hue cue (a shape or
plinth) separating the two answer classes.

**HN3 — major — the food props have no grain, no edge wear and inverted cheese holes.**
`props.ts:296-303` (apple) and the food set generally. `crop_apple_dish.png`: the apple is a
smooth sphere of uniform red with one broad falloff — no fbm micro-grain, no curvature
lightening, no blush variation, no stem dimple — sitting beside a tooth leg in the same crop
that visibly carries clay tooth and warm crevice AO. `crop_cheese.png`: correct bevel, but a
single flat saturated `peach.main` albedo and "holes" that are brown domes **bulging outward**,
reading as chocolate buttons stuck to a wedge. `depends: A14`.
**Fix:** verify `bakeCurvatureAO` vertex colours reach the food materials (visibly present on
the tooth, absent on the apple); raise normal-map strength into §3's 0.08–0.15; add a stem
dimple and two-tone blush to the apple; recess the cheese holes as actual cavities.

**HN4 — minor — the chomp sparkle burst is one flat billboard glued to the mascot's skull.**
`scene.tsx:1005`, `:1472`. At 1-frame spacing all 14 instances are still coincident, so the
first frame of every successful feed shows one hard-edged orange four-lobed cross on the
character's head.
**Fix:** give the burst a spawn-time stagger (a few ms of per-instance delay) so it opens as a
puff.

*(Low-tier faceting → A4. GPU 2.808 ms → A7. Focus ring → A1. Memory +2 geo → A6. Springs → A19.)*

## B5 — Spot the Difference (`src/games/spot-the-difference/**`)

**SD1 — blocker — the scene solves its panels against a transform-inflated rect, so the opening
frame of every entry is broken.** `SpotTheDifference.tsx:117` (`const box =
frame.getBoundingClientRect()` feeding `solvePanels`), `:130` (the `ResizeObserver` observes the
*content box*, which a CSS transform does not touch, so it can never fire to correct the bad
solve). The hub→game entry is a framer-motion scale flip from 0.24 → 1, which
`src/three/Scene3D.tsx:47-58` documents as the reason every view "mounts believing it is a
quarter of its real height". Result: the WebGL viewport panels are solved against a ~0.3× box in
row mode while the DOM frames are already full-size in column mode. Photographed twice
independently, two and a half hours apart, both at clock 0:00: two full-size empty cream picture
frames with two ~130×95 px dioramas rendered side by side across the seam between them.
**Fix:** measure with `frame.offsetWidth`/`offsetHeight`, or take the size from the
`ResizeObserver` entry's `contentRect` — never `getBoundingClientRect()`, the same discipline
`Scene3D` and `GameShell:231` already apply. Re-solve when `playAreaMetrics()` changes, and gate
`<Scene3D>`'s mount on a solve that came from a layout measurement.

**SD2 — blocker — the found ring is a flat annulus that covers the thing it rewards.**
`diorama.ts:746-751` and `:1104-1108`: a camera-billboarded `torusSoft(1, 0.15, 2)` with
`depthTest = false`, `renderOrder = 5`. Because the tube crest's normal points at the camera at
every ring angle, the visible face has **no shading variation at all** — measured (189–191,
39–41, 46–48) at all twelve angles at r = 110 px, lit side and shadow side indistinguishable in
a scene keyed at intensity 2.6 from upper-left — and the flanks collapse 190 → 64–85 over ~3 px,
a hard dark contour rather than a bevel rolloff. In `impact-f03.png` its red band hides most of
the towel; in `keyboard-end.png` three rings obliterate the towel, the duck and the entire
shelf-and-window corner of both pictures. This is the money shot of the game.
**Fix:** replace it with a clay object that belongs to the room — a small bevelled clay star or
tick that pops in **beside** the prop with its own contact shadow and `ContactBlob`. If a ring
is kept, tilt it 25–35° out of the camera plane so the tube reads as lit, swap `depthTest:false`
for a small along-ray offset plus `polygonOffset`, and shrink `ring.r` per diff so the annulus
frames the prop instead of sitting on it. Either way it must be lit by the same key as the room.
`depends: A1` (same reasoning, separate code path).

**SD3 — major — found marker and focus marker speak the same visual language.**
`diorama.ts:747` (`ACCENTS.rose.deep #b2343f`) vs `src/three/hit.tsx:585`
(`ACCENTS.red.deep #c21e25`). Both are billboarded annuli with a dark ink contour and a pale
halo at comparable on-screen radius. A keyboard or switch player cannot distinguish "my cursor
is here" from "I already found this" — exactly when the board is half solved.
**Fix:** the found marker must differ in **form**, not hue — a filled clay badge or a burst.
Reserve the ring silhouette for focus alone.

**SD4 — major — two-thirds of the surface is empty in a game about looking closely at a picture.**
`layout.ts` `solvePanels` docblock (which states the numbers, the fix and the projected result
and then ships without it), `src/GamesCollection.tsx` `max-w-[860px]`. On 1500×820 the pictures
are **35.0 % of the play area with 46.8 % of the panel box dead cream**; the docblock's own
projection for a 1400 px cap is 659×457 panels at 60.8 % occupancy, "geometry-free — same room,
same camera solve, same draw calls". Also: §6.5 specifies two dioramas **side by side** and on
1440×900 the solver picks column.
**Fix:** add a per-game `maxWidth` on the collection wrapper (or let `solvePanels` overflow the
860 px column) and raise the cap for this game. It is one number.

**SD5 — minor — `tapScreenPx` caps at 320.** `layout.ts:280`. Below `fh = 0.15` the 48 px floor
silently stops being honoured with no warning. Not reached today; it is an unguarded cliff.
**Fix:** assert rather than clamp, or raise the cap and let the assertion fail loudly.

**SD6 — minor — `aria-label` on a `<span>` with no `role`.** `SpotTheDifference.tsx:260-264`.
ARIA does not map `aria-label` onto a generic element, so the progress ticks expose no
accessible name. `announce()` covers the information, so this is redundancy lost.
**Fix:** add `role="img"`, or make the pill a single `<p>` with the full state as text.

**SD7 — minor — the only run in the product that can fail to *end*.** `engine.ts:53` states it:
no timer, no hint, no lose state, `finish()` reachable only by finding every difference. A child
who cannot find the last one never reaches a celebration. There is an idle nudge but no
escalation.
**Fix:** after N idle nudges, gently pop the remaining difference. Nothing is scored down; the
run still ends in celebration.

**SD8 — minor — the window glass is the only non-warm surface in the product.**
`spot-the-difference-tablet.png (800,395)`: `#d7d9d5`, C\* 2.0, **hue 127°** in a palette whose
hues span 27–95°; nearest token dE 5.52.
**Fix:** tint `softGlass` to `page` / `clay.enamel` rather than neutral.

*(Mid-tier GPU 2.069 ms → A7. Memory +1 geo → A6. Note: `diorama.ts:1163`'s comment says
"exactly the seven merged geometries" while the array holds nine — fix the comment while
touching the file.)*

## B6 — Tooth Rescue (`src/games/tooth-rescue/**`)

**TR1 — blocker — the largest surface in the product is a flat slab.**
`set.ts:262-303`, `scene.tsx:1012`. The alcove back wall measured over 97,000 px: luminance mean
83.9, **σ 1.77, full range 79–90 — eleven levels out of 255**; high-frequency energy σ **0.628**
against 5.434 on the basket and 1.387 on the cream shelf in the same frame. It occupies
**22.6 % of the play area**. `materials.ts:1010-1011` binds grain at 0.11–0.14 but at
`coral.deep`'s luminance on a camera-facing plane it produces nothing measurable.
`depends: A14`.
**Fix:** this backdrop should not be a painted flat. Give it real occupancy — a shallow shelf
run with rounded ribs or a coved tile pattern at 0.15–0.25 u relief so the key rakes across it;
drop `coral.deep` toward `coral.soft` and let form, not saturation, carry the separation from
the ivory teeth. Acceptance: high-frequency σ ≥ 2.0 and a top-to-bottom luminance sweep ≥ 15
levels on that surface.

**TR2 — blocker — the pile is a fan of interpenetrating teeth hanging in open air.**
`scene.tsx:26-30` (states the cause: "bodies do not collide with each other… handed to a
`Spring3` that carries its landing velocity into an assigned slot and holds it there"),
`:1345-1370`, `:1462-1470`. In `tooth-rescue-catch-f13.png` five teeth form a rigid fan above
and outside the basket rim with open air beneath them, the leftmost tooth's crown entirely clear
of the tub's left wall, roots stabbing through neighbouring crowns. This is the shot the child
stares at for the whole run.
**Fix:** solve the slots against the tub's real interior volume — pack them as a hex sphere
stack of radius `TOOTH_R` clamped to `innerHalfW`/`INNER_HALF_D`, raising y one layer per full
ring; clamp every slot centre to at least `TOOTH_R` inside the wall and below the rim; add a
pairwise separation pass (26 bodies = 338 checks, trivial) so no two crowns overlap. If the pile
is meant to overflow, model teeth spilling onto the shelf, not levitating.

**TR3 — blocker — the only game with no 3D focus ring, and a win state made of browser chrome.**
`ToothRescue.tsx:268`
(`focus-visible:[box-shadow:inset_0_0_0_3px_#fbf6ec,inset_0_0_0_6px_#2f3237]`) draws a flat
6 px CSS ring around the entire viewport rectangle; `focus-rings.json` records `tag: "DIV"`, and
8 of 9 games show an in-world ring. `tooth-rescue-keyboard-end.png` shows naked `#2F3237` type
inside a hard-cornered 1 px outline rectangle over a hero-less blurred scene, half over the red
alcove and half over the shelf.
**Fix:** (a) render a real in-world ring around the basket on `:focus-visible` — a torus in
`red.soft` at the tub's footprint, driven by the same `SoftWobble` so it moves with the object —
and set the DOM ring to `outline: none` once it exists; (b) give the win heading an in-world
surface (the celebration podium the shared burst already places) and remove the focus outline
from a programmatically focused heading; (c) do **not** pop the basket and pile out — the caught
teeth are the trophy. `depends: A1, A10`.

**TR4 — major — the set is framed and clipped at both phone and tablet.**
`layout.ts` (`solveFraming`), `set.ts` sizing. `scene.tsx:52` (G-TRS-4) claims "no edge of the
set can be framed at any viewport"; false at 1024×768 (wall top terminates in a dead-straight
unbevelled cut at y≈285, vertical right edge at x≈915, two hard floor corners against an empty
cream void — it reads as card with a red rectangle glued on) and at 390×844 (mascot's head
occluded and clipped by the `0:30` timer pill, rail running behind the HUD chips, alcove cropped
at both side edges with no headroom). `depends: A9`.
**Fix:** make `solveFraming` account for the HUD's occupied rect and pull the camera back (or
raise the set's own margin) until the rail, both reveals and the shelf's side edges are inside
frame at 390×844 and 1024×768. Verify with captured frames, not a comment.

**TR5 — major — the thing to avoid is painted the same family as the 22.6 % backdrop it falls
in front of.** `scene.tsx:503` (`CANDY_HEX`, `ACCENTS.red.main`/`coral.main`) vs
`set.ts:265-266` (alcove in `coral.deep`/`coral.main`). In `tooth-rescue-catch-f09.png` the
candy is nearly camouflaged. A four-year-old must separate catch-this from dodge-this in under a
second.
**Fix:** move candy off red/coral entirely — `mauve.main` / `rose.deep` read against a warm
backdrop — and give it a silhouette cue that survives colour (a hard twist, a wide wrapper
spread) so the read does not depend on hue. `depends: A15`.

**TR6 — major — the tumbling mascot inverts into a frown/fracture read.**
`mascot.ts` (face), `scene.tsx:1487-1510` (tumble). At high magnification a tumbled mascot is a
white blob with two large pure-black voids and a dark curved gash across the crown; inverted,
the gash sits above the eyes and reads as a downturned frown or a crack, and the pile reads as a
bin of skulls. `FACE_ON_TIME` only corrects the last third of a second, so this is what the
child sees for most of the fall. §1.1, and for a dental product the cavity/crack read
specifically.
**Fix:** clamp roll to ±35° and pitch to ±20° regardless of the solver's angular velocity and
let the tumble live in yaw; put a highlight and a warm-brown iris in the eyes so they are eyes,
not voids; give the mouth a lower lip so it cannot read as a crack when flipped. `depends: A5`.

**TR7 — major — candy that never touches the rim just sits in the basket, contradicting the
instruction.** `scene.tsx:893-916` (comic ejection fires from the **rim collision callback**),
`:1381` (`hitBasket` branch runs only a wobble impulse). A candy dropping cleanly through the
mouth lands on the floor collider and rests there among the teeth, while `ToothRescue.tsx:143`
has already told the child "Sweets bounce back out — let them go." It also occupies pile space.
**Fix:** trigger `ejectCandy()` on **any** contact with the basket assembly — call it from the
`hitBasket` branch, not only from the rim collider.

**TR8 — minor — the basket is a baked CSS gradient with a 90° corner.**
`scene.tsx:939-951` (`paintBasket`, `BAND_START`/`BAND_FADE`) produces a full-height red→white
dip-dye whose direction fights the key (darkest at the top of the form), not the "rim band" the
comment at `:47` describes; measured down one 100 px column: `#ec3f3f → #de8d86 → #e2b1a7 →
#dcbdb0`. The front-left vertical corner is a 90° silhouette with no bevel highlight (§3
minimum bevel 0.02 u). The fence sits on the wall as a floating decal plate with a paper-thin
shadow and no AO at the join.
**Fix:** shorten `BAND_FADE` so the ramp completes within the top ~18 %, leaving the body a
single `clayAccent("rose")` tone the lighting can shape; bevel the vertical corners; seat the
fence with a crevice.

**TR9 — minor — the mascot on the rail floats.** `tooth-rescue-rest.png (600,255)-(860,400)`:
feet visibly clear of the rail, no contact shadow on anything. Also the rail itself is a
690×8 px capsule of uniform `#dd3c3d` with one specular streak, no grain and no wear, casting
no shadow on the wall behind it.
**Fix:** seat the feet and add a small `ContactBlob`; give the rail grain and a cast shadow, or
drop the perch.

**TR10 — minor — ownership tags survive the scene.** After exit, `ownership` reads
`taggedOwned: 17, taggedUnowned: 0, activeScene: null` where the baseline read `0 / 45` — 17
shared materials owned by a dead scene, the state that would block eviction. `depends: A6`.

**TR11 — minor — the basket's drag overshoot is imperceptible.** `scene.tsx:218-219`
(`BASKET_STIFFNESS 300 / BASKET_DAMPING 26`) gives ζ = 0.75, a **2.8 %** peak overshoot on the
one thing a child drags for thirty seconds. Technically not linear; practically invisible.
**Fix:** drop damping to ~20 (ζ ≈ 0.58, ~10 % overshoot), then re-check it does not overshoot
far enough to drop a catch.

*(GPU 2.809 ms → A7. Memory +1 geo/+3 programs → A6. Low-tier fence slabs → A4. Accent family
mismatch → A15.)*

## B7 — Count the Teeth (`src/games/count-the-teeth/**`)

**CT1 — blocker — on a phone a counted tooth is hidden behind a UI control.**
`count-the-teeth-phone.png`; solve at `CountTheTeeth.tsx:110-113`
(`cameraFor(rect.width, rect.height, level, undefined, rect.chrome)`). At 390×844 one tooth is
more than half hidden behind the frosted "Easy / Medium / Hard" pill — only its eyes and mouth
show *through* the translucent chip, the crown is gone — and the teeth at x≈45 and x≈340 are
clipped by the panel's soft edge mask. A counting game in which a tooth is behind a control has
no correct answer. Worse, §6.7's runtime guarantee reports "worst tooth 99.4 % unoccluded" on
the same build, because that proof is an offscreen ID render of the 3D scene and is
structurally incapable of seeing a DOM occluder. `depends: A9, A18`.
**Fix:** per A9 for the keep-clear rect; and extend `verify.ts`'s count selftest to composite
the DOM chrome (or at minimum rasterise the chrome band's rect into the occlusion mask) so a DOM
occluder can fail the test.

**CT2 — major — GPU p95 over budget on every tier, with 24 draw calls for five teeth.**
2.307 / 2.249 / 1.543 ms (default / mid / low) against `desktopGpuMsP95 = 1.2`, with 1 dropped
frame at mid. `scene.tsx:1560-1571` builds the face from five separate meshes.
`depends: A7`.
**Fix:** tighten `board.shadowArea` to the tray's actual footprint (one large receiver, ≤14
small casters) and drop the shadow map to 512² at high tier too; collapse the five face meshes
into a single instanced mesh with a packed atlas, removing four draw calls and four shadow-pass
submissions.

**CT3 — major — the mascot frowns at low tier.** `TOOTH_SUBDIV[0] = 4` facets cut the mouth
ball into a straight downturned dash with blush on one cheek only. Handled centrally in **A4**;
game-side, pass an explicit `detail` from `face.ts` into `mascotParts`/`toothGeometry` so this
game's character never degrades below subdiv 6. `depends: A4, A5`.

**CT4 — minor — the white-balance calibration targets the wrong statistic.**
`scene.tsx:304-333` (`PAD_WHITE_BALANCE`) asserts the coral field and ivory crown land at
"3.20:1" and "clears the floor with margin". Measured: 3.20:1 holds only at the **90th-percentile**
crown pixel; the median crown pixel is **3.02:1** and a mid-tooth body sample is **2.87:1**,
under §8's 3:1 floor. Half the character's surface is below the floor against the field it must
be counted on.
**Fix:** re-run the calibration the comment specifies, targeting the crown's **median** rather
than its brightest decile — `k` needs to come down further, and the AO headroom the comment
claims works the wrong way for the crown.

**CT5 — minor — crowns overhang the tray rim.** At 1024×768 and at low tier, teeth sit hard
against the tray's inner wall with their crowns over the pink rim (top-left and top-centre on
tablet; top-right at low tier). `solveScatter` clamps the **base** into the padded field; the
swept crown is wider.
**Fix:** inset the scatter bounds by `TOOTH_SILHOUETTE`'s crown half-width, not its root
half-width, when a tooth is near a rim.

**CT6 — minor — in-world answer digits are blurry flat decals at 3.80:1.**
Blurry mip-filtered flat decals with no relief and no bevel, framed by a 1 px hard hairline
groove, on a tile face with near-zero shading gradient. `#c64726` on `#efe2cf` = 3.80:1, which
passes only as large text, with no margin, on **lit geometry** whose ratio moves with the
shading. Nothing measures it (`chrome-contrast` cannot see a mesh).
**Fix:** extrude the numerals as clay relief (or at minimum bevel the tile inset), and register
the `text-contrast` selftest from A18.

**CT7 — minor — 85 % of the coral field is empty at tablet and phone aspects.** Functionally
motivated by §6.7's countability proof, but duller than the reference it aims at.
**Fix:** dress the **tray**, not the field — a pressed maker's mark in the rim, a shallow
thumb-groove, a slight corner wear. None of that touches the exclusion proof.

*(Focus ring covering the pips → A1, plus move `board.pipZ` out from behind the ring. Memory
+2 geo/+2 programs → A6. Accent family mismatch → A15.)*

## B8 — Tooth Runner (`src/games/tooth-runner/**`)

**RU1 — blocker — renders nothing at 390×844.** `viewport-summary.txt`: `draw calls 0
triangles 0`; `tooth-runner-phone.png` is a blank ~350×480 cream rectangle under correct DOM
chrome. Root cause is shared plumbing — see **A8**. `depends: A8`.

**RU2 — blocker — the game inverts the child's existing sign language.**
`props.ts:216`, `:271` (`torusSoft(HALO_R=0.4, HALO_TUBE)`, 0.90 units across — nearly as tall
as the 1.0-unit hero), `:872` ("red means you can have it"), `:212-213` (the hazard deliberately
pushed to low-chroma mauve with no ring). A red ring drawn around an object is the universal
sign for *not this one*. The reward is the loudest object in the frame and the hazard is the
quietest; `_montage-tooth-runner-impact.png` has frames with three red rings stacked down the
lane and no visible sweet — a corridor of stop signs. The rationale in the comment is internally
coherent and still wrong, because it is a rule the game teaches rather than one the child
already has. Compounded by the focus outline being the same red.
**Fix:** move the halo to the game's own registered accent (`peach #efa160`) — warm, high
contrast against both the ivory lane and the mauve sweets, no prohibition semantics — and mark
the **sweet** instead (a warm-mauve ground puff or a scuff decal beneath it). Retest the read at
lane distance, not close range. `depends: A15`.

**RU3 — blocker — reduced motion is decoration-only; the moving world is untouched.**
`engine.ts:368` (jump wind-up), `:457` (pickup pop), `:540` (pickup twirl),
`scene.tsx:694`, `:702` (4 sparks instead of `START_SPARKS`), `:769`. Measured per band across
`i01…i06`, normal vs `?reduced=1`:
far y200-320 normal 20.2/20.0/18.4/16.8/15.6 % vs reduced **23.2/20.9/19.6/16.5/17.9 %**;
mid y320-480 normal 31.7…30.2 % vs reduced 33.8…31.8 %; near lane normal 26.4…22.6 % vs reduced
24.5…21.8 %. The reduced path is not quieter in any band and is *busier* in the far parallax
band. Seven of nine games measure literally 0 changed pixels across five consecutive reduced
frames; this one is indistinguishable from full motion. A child who set
`prefers-reduced-motion` because motion makes them ill gets the full moving world.
**Fix:** under `isReduced()`, collapse the three parallax layers to a single scroll rate and cut
`engine.speed` — a runner can be slower, it cannot be a moving diorama. Re-capture the
`i01..i06` pair and require the far band under ~5 %.

**RU4 — major — a dropped frame on an M5, and low tier still 1.44× over budget.**
`realtime-perf.json`: `worstMs 31.3`, `longFrames 1`, `droppedFrames 1`, GPU `p95Ms 2.462` vs
1.2. `_low-tooth-runner.json`: low-tier GPU p95 **1.732** with every quality lever already
pulled (instances 260→90, detail 3→1, antialias off, shadow map 512) — `window.__perf` flags it
itself. 47 calls / 113 k tris are not the problem; the 20-tap PCSS filter across a full-screen
lane is. `depends: A7`.
**Fix:** bisect by forcing `softShadows:false` at high tier and re-reading GPU p95, then apply
the shared A7 levers.

**RU5 — major — the pickup does not read as a toothbrush.** `props.ts:287`
(`roundedBox(0.17,0.08,0.13,0.035)`, ivory bristle tuft placed directly beneath an ivory
handle). No albedo, material or silhouette separation, so the tuft vanishes and the three-part
"handle, head, bristles" vocabulary the comment describes does not survive to screen. What ships
is a white capsule with a red block on one end, framed by a red ring; the brush spans 0.63 u
inside a 0.70 u void so the **ring**, not the brush, is the silhouette a child parses.
Additionally: at lane distance the same shape is a thin white shaft with a coloured tip inside a
red circle — this needs an explicit check against §1's content list before ship (no assertion
made either way; it has not been looked at at gameplay distance).
**Fix:** give the tuft its own material (a lighter flatter enamel, or soft mauve) and step it
proud of the handle silhouette so it breaks the outline. Verify in a lane-distance frame like
`tooth-runner-f04.png`, not a close-up. Then re-examine the lane-distance silhouette against
§1.1.

**RU6 — major — the halo has no hand-pressed tell.** `props.ts:271` builds it from a bare
`TorusGeometry`; `geometry.ts:1165 torusSoft`'s `finish()` runs `bakeCurvatureAO`, which has
nothing to bite on because a torus has no crevice and no exposed edge. Contrast-boosted 2.4×
there is a single lighting gradient and nothing else. `props.ts:710-729` already identified this
exact property of a torus as the reason the arch was replaced; the reasoning was not applied to
the halo — the largest, most-frequently-on-screen object in the game.
**Fix:** build the halo as a jittered lathe with a slightly irregular tube radius (the
`jitterSurface` + re-bake path `lumpySphere` uses at `props.ts:409`), so it reads as a
hand-rolled coil.

**RU7 — major — reduced motion switches off the gait entirely.** `scene.tsx:961`
(`const running = reduced ? 0 : grounded;`). No stride, no arm swing, no foot lift, no bob,
while the world still scrolls — the reduced-motion player gets a rigid statue skating along the
ground, which reads as broken rather than calm. A character's gait is not a vestibular trigger;
camera motion and parallax are, and those are handled correctly in the same branch (and are
exactly what RU3 says is *not* reduced).
**Fix:** keep the gait at 0.4–0.5× amplitude under reduced motion; put the reduction where §4
points it.

**RU8 — minor — announce spam.** `ToothRunner.tsx:169-185`, `engine.ts:71-73`
(`spawn: 1.25/1.0/0.85`), `:338` (`+ Math.random()*0.6`). See **A17**. Game-side: drop the spawn
sentence, keep the short `approach` cue, coalesce collections on a 2 s window.

**RU9 — minor — spec and build disagree silently.** `docs/3D-SPEC.md §6.8` specifies "camera
behind a **rolling** tooth"; `scene.tsx:190-193` ships a biped with a two-beat gait and documents
the substitution. The gait itself is well built (`scene.tsx:1063-1083` gets the contact phase
right — `cos` for fore-aft swing, quarter-cycle out of phase with the `|sin|` bounce).
**Fix:** amend §6.8 or restore the roll. Do not leave the spec and the build disagreeing.

**RU10 — minor — 500 ms activation swallow.** `ToothRunner.tsx:264`: `onClick` discards any
assistive activation within 500 ms of a pointer or key input, so a switch or screen-reader user
double-activating loses the second jump. 500 ms is long for a game whose whole verb is a jump.
**Fix:** tighten to ~120 ms, or guard on the event's `detail`/`pointerType` instead of a
wall-clock window.

**RU11 — minor — "Tap to run" occludes the hero.** In `tooth-runner-rest.png` and `-tablet.png`
the peach DOM pill sits directly on the tooth's body and hides its legs — the read on "this
thing runs" — while telling the child to make it run.
**Fix:** move the pill below the hero.

*(Win state composition → A10. Memory +3 geo → A6. Ground plane featureless third of frame →
A14.)*

## B9 — Smile Maker (`src/games/smile-maker/**`)

**SM1 — blocker — renders nothing at 390×844.** `viewport-summary.txt`: `draw calls 0
triangles 0`; `smile-maker-phone.png` shows a title, two chips, three buttons and ~500 px of
empty cream. Root cause is shared plumbing — see **A8**. Note the control row wraps to two lines
at that width, which is the leading suspect for the host height collapsing. `depends: A8`.

**SM2 — blocker — the hero of a game called *Smile Maker* scowls.**
`build.ts:909-913` (`const BROW_TILT = 0.16`), `:1749-1754`
(`onSurface(..., side * BROW_TILT)`), with the comment at `:1749` asserting this "lifts the
*outer* end … which is the open, friendly brow". It is the opposite: lifting the outer end drops
the inner end, which is the canonical **angry** configuration. Measured on `smile-maker-rest.png`
(crop 610,320–860,540): each brow's outer end sits ~23 px above its inner end, both sides — two
ridges converging downward over the bridge. The same file at `:855-857` correctly identifies
that an accidental 6.3° roll had been shipping "a sloped, glowering brow line — a face 3D-SPEC
§1.1 forbids", then overcorrects 9.2° in the **same** direction and calls it fixed. This is the
largest face in the product, it is the entry state, and it is the state after every **Clear**.
**Fix:** do not merely flip the sign — that restores the worried brow it came from. A straight
tilted capsule can only read angry, sad or flat. Probe three points per brow and arch it (outer
low, centre high, inner low) so it reads as a raised open brow, with `BROW_TILT ≈ 0`. Re-shoot
bare-face frames at 4× from three orbit angles.

**SM3 — blocker — a 299.1 ms entry frame.** `_low-smile-maker.json:violations[1]`
(`hitch:enter:smile-maker`, value 299.1, budget 50) — ~18 dropped frames at 60 Hz, ~36 at the
captured 120 Hz, and the worst entry hitch measured anywhere in the round; the only low-tier
capture in the corpus that shows one. Not shader compile: the same file puts
`compile:smile-maker#0+parallel` at 2.2 ms and `#1` at 0.7 ms. It is `build.ts` — 2,096 lines
raycasting a metaball iso-surface (`probeSurface`, `:817-830`) once per face feature and once
per anchor, extruding and bevelling ten accessories, and baking curvature AO, synchronously on
the main thread.
**Fix:** build the tooth, podium and rail on entry; queue the ten accessories over subsequent
idle frames and let them arrive in their slots with the existing `easeOutBack` snap (a shelf
filling itself in is charming). Memoise `probeSurface` results — they are camera- and
viewport-independent. Add `performance.mark` breakpoints inside `build.ts` (iso-surface probe /
extrude+bevel / curvature bake / merge) so the next measurement names the stage.

**SM4 — major — +6 programs leaked by the capture warm-up.** `smile-maker-memory-after.json`:
programs 4 → 10 after one hub→game→hub, against §5's ±2. Prime suspect is the deliberate
render-target warm-up at `scene.tsx:1793-1812` with `WARM_DELAY = 0.75` (`:258`), which runs a
full render-target pass 0.75 s after entry precisely so every material in the shot compiles its
second `NoToneMapping`/`LinearSRGB` variant off the shutter — variants keyed on render-target
state that outlive the materials that requested them. Six is close to the count of distinct clay
materials in the booth. Disposal is otherwise correct (`scene.tsx:1126-1132`).
**Fix:** either drop the warm-up and take the one-frame compile on the first Snap (already
covered by the polaroid's slide animation), or keep it and force-release the render-target
program variants on unmount. Re-measure with populated program names — the current dump is ten
empty strings. `depends: A6`.

**SM5 — major — the cape is a flat plate with a hard hem corner.** `build.ts:1548`
(`extrude at depth: 0.05, bevel: 0.024`), shape at `:787-798` (`capePanelShape`). Measured on a
24×26 px strictly-interior patch of the worn cape: **σ 6.84, p5–p95 spread of five luminance
levels (130–135)** against σ 11.20 (tooth leg), 17.35 (hat dome) and 52.99 (balloon interior) in
the same frame. Nearest-neighbour blow-up shows a uniform terracotta cutout, a straight vertical
left edge whose bevel resolves to a sub-pixel line, and a hard ~100° silhouette corner at the
hem. The bevel number satisfies §3 on paper but never reaches a pixel at worn scale, and a flat
extrude has one shading normal across its face so `bakeCurvatureAO` has nothing to write.
**Fix:** build the cape as a lofted/swept surface that actually wraps the shoulders and flares
at the hem, raise the bevel to a visible radius at worn scale, and roll the hem edge.

**SM6 — major — two of ten props are unidentifiable on the shelf.** "Cape" (slot 1) renders as a
flat mauve paddle with a torus ring on one end — the file records at `build.ts:1536` that this
read as a hand mirror in round 3, and `shelfPitch: -0.85` has made it a *reclining* hand mirror.
"Party Hat" (slot 2) renders as two stacked domes with orange trim and a red ball — a bell, a
tagine, a cupcake, anything but a cone with a pom-pom. In a dress-up sandbox the shelf is the
entire interface.
**Fix:** give the cape a visible collar-and-drape silhouette on the shelf (hang it over a hook,
or fold it so the collar reads); rebuild the party hat as an actual cone with a bevelled base
and a pom-pom.

**SM7 — major — a photo booth with no camera in it.** `SmileMaker.tsx:250-369`: three DOM pills
("Surprise", "Clear", "Snap!") with 19 px stroked-vector `currentColor` glyphs
(`SmileMaker.tsx:69-78`) sitting on bare cream between the turntable's front rim and the frame
edge, anchored to nothing. `SmileMaker.tsx:296` records the round-3 finding verbatim — "this is
a photo booth with no camera in it" — and answers it by drawing a camera **icon on the web
button**. §6.9 got the hard half right (the polaroid is a real `WebGLRenderTarget` capture,
`scene.tsx:527-570`) and the easy half wrong.
**Fix:** put Snap on a clay camera prop standing on the turntable rim, so the polaroid slides
out of its real lens; put Surprise on a physical lever or a spinnable knob; put Clear on the
tray. Keep the DOM row as the offscreen a11y counterpart only, the way `hit.tsx` already does
for the ten props.

**SM8 — major — the camera takes itself back from the child, and cannot be moved by keyboard.**
`layout.ts:311-313` / `scene.tsx:660-668`: `ORBIT_HOLD = 1.15 s` then
`damp(o.yawTo, 0, ORBIT_RETURN_LAMBDA = 0.85, dt)`. In a sandbox whose only reward is admiring
what you made, the orbit springs back to front-on a second after the child stops turning it —
which is also why the three "orbit angle" captures differ by only 2.6–6.1 mean absolute pixel
levels. Separately, orbit is pointer-only: §6.9's headline interaction is a capability keyboard
users simply do not get.
**Fix:** hold the child's orbit indefinitely; return to front only on Clear, Surprise or Snap.
Add `Shift+←/→` on the shelf group (or a dedicated "Turn the tooth" target) for keyboard orbit.

**SM9 — minor — the worn crown does not seat.** Its band is a straight-walled lathe sized to
`TOP_CAVITY_R` — the head's radius *at* the seat — so above the seat the spherical head falls
away and daylight shows between head and band, with the band's far rim floating behind the head.
It reads as a hoop hovering.
**Fix:** taper `crownBandProfile` inward toward the top so the band hugs the dome, or sink the
seat 0.03–0.04 deeper.

**SM10 — minor — the worn hat erases the face.** Its brim sits at eye level and its dome covers
the entire brow, in the one game whose subject is the face.
**Fix:** raise the seat and reduce the dome scale ~15 % so the brow line stays clear.

**SM11 — minor — off-palette prop colours.** Glasses `#72381d` (dE2000 **16.06** from the
nearest token), moustache `#764f33` (10.41), bowtie `#bc6f53` (7.93), top hat `#9e5636` (7.57).
38.9 % of this game's saturated pixels are farther than dE 6 from any of the fifteen family
tokens. `depends: A15, A16`.
**Fix:** repaint from `mauve` / `peach`. `#72381d` at dE 16 is not a brand colour by any reading.

*(Focus ring ellipse → A2. `easeOutBack(1.5)` and `Spring(0,300,11)` → A19.)*

---

# C. ITEMS DROPPED, AND WHY

1. **"×20 mobile projection" (performance critic).** The critic's own estimate of the desktop→
   tablet factor, offered alongside the project's documented ×12. Only the project's own ×12 is
   carried into A7; the ×20 column is an opinion about hardware nobody measured. Both point the
   same way, so nothing is lost.
2. **"React renders 0 per frame is unmeasured" (performance critic).** Correct, but it is an
   evidence gap, not a defect — the code reading is clean in all nine games and no capture
   contradicts it. Listed under Evidence, not as a fix.
3. **"Reduced motion never exercised via the real media query" (accessibility critic).** The
   critic explicitly declined to block on it because `store.ts:166` and `store.ts:54` prove the
   `?reduced=1` and media-query paths converge. Evidence gap, not a fix item.
4. **"Maze Escape / Sliding Puzzle / Spot the Difference reduced-motion branch may be broken"
   (three game critics, from byte-identical capture frames).** Byte-identical frames are
   ambiguous between "reduced correctly" and "input never landed", and the a11y critic's
   per-band measurement resolved seven of nine games as correct. Only Tooth Runner, where the
   measurement showed reduced ≈ normal, survives as a defect (RU3). The rest are evidence gaps.
5. **"Tooth Runner's pickup may read as a syringe" (game critic).** The critic explicitly
   declined to assert it. Carried as a required check inside RU5, not as a standalone finding.
6. **"Spot the Difference's keyboard path lets a player enumerate without comparing"
   (game critic).** The critic called it a fair accessibility affordance and marked the change
   optional. Dropped.
7. **Press-latency and squash-and-stretch failures (five game critics failed these lines).**
   Every one of them failed on *absence of usable evidence*, not on a proven code defect —
   `press-latency-diffs.txt` states the camera breathe moves every pixel every frame and no
   no-press control run was captured. Not actionable as code fixes; listed under Evidence.
8. **Per-game claims contradicted by a second reviewer.** Tooth Rescue's DOM focus band was
   described by one critic as absent and by the a11y critic (who photographed it) as "a strong,
   deliberate two-tone band". TR3 is written against the verified fact — it exists, it is a DOM
   ring, and it is the only game without a 3D one — not against the stronger claim.
9. **"29 of 30 GPU readings is a project-wide calibration question, not a defect"
   (Smile Maker critic, item 12).** Folded into A7 rather than dropped, because the perf critic
   independently established the same numbers breach the project's own budget on the target
   tier.

---

# D. ITEMS THAT BLOCK A PASS

**Shared (must land first):**
- **A1** — focus ring is a flat unlit sticker drawn through the world
- **A2** — focus-ring billboard broken under rotated ancestors
- **A3** — cast shadows are flat grey decals; shadow tint not reaching the ground
- **A4** — low tier ships hard edges, faceted silhouettes and a frowning mascot
- **A5** — the shared mascot has no smile
- **A6** — memory never returns to baseline, 9 of 9 games
- **A7** — the 60 fps mobile claim is unsupported and contradicted by the project's own model
- **A8** — two games render 0 draw calls at 390×844
- **A9** — `--chrome-h` scalar lets the HUD paint on top of the game
- **A10** — the celebration destroys the child's work and frames it in browser chrome

**Game-scoped:**
- **SP1**, **SP2** (Sliding Puzzle) — picture deleted at the win; triangle budget breached
- **ME1**, **ME2**, **ME3** (Maze Escape) — goal inside a wall; worst GPU in the product;
  unplayable at phone size
- **TM1**, **TM2** (Tooth Match) — phone board clipped on three sides; card back competes with a
  motif
- **HN1** (Healthy or Not?) — HUD on the mascot's face; an answer target cut in half
- **SD1**, **SD2** (Spot the Difference) — broken opening frame on every entry; the found ring
  covers the reward
- **TR1**, **TR2**, **TR3** (Tooth Rescue) — flat 22.6 % slab; levitating interpenetrating pile;
  no 3D focus ring and a browser-chrome win state
- **CT1** (Count the Teeth) — a counted tooth hidden behind a UI control on phone
- **RU1**, **RU2**, **RU3** (Tooth Runner) — blank at phone size; inverted sign language;
  reduced motion does not reduce motion
- **SM1**, **SM2**, **SM3** (Smile Maker) — blank at phone size; angry brows; 299 ms entry hitch

**Total: 10 shared blockers, 20 game blockers.**

---

# E. HONEST ASSESSMENT AGAINST `docs/3D-SPEC.md`

The engineering underneath this build is genuinely strong, and it is worth being precise about
that before the verdict: there is **not one allocation on any frame path in 54,059 lines** —
verified by extracting all 21 `useFrame` bodies and walking their call graphs four levels deep;
draw calls, triangles, render targets and CPU render cost are inside budget on nine of ten
scenes; the accessibility architecture (the `#lumident-a11y` adoption above the chrome, the
`announce()` queue, roving tabindex with `aria-disabled` rather than `disabled`, the dialog's
inert/focus-restore discipline) is better than most shipped children's software; keyboard
completion is proven end-to-end in seven of nine games including a 62-press 4×4 solve; reduced
motion is a real, threaded branch that measures **literally zero changed pixels** across five
consecutive frames in seven games; content safety — the monotonic score chip, the suppressed
zero-score plate, the rising "oops" interval, mute-by-default, the absence of any lose state —
is careful, deliberate, child-first work; and the PCSS solve, when you hide the decals sitting
on top of it, really does widen its penumbra from 1 px at contact to 19 px at 2.0 u. Held still,
at the high tier, `healthy-or-not-rest.png` and `maze-escape-f00.png` are lovely miniatures.

But the spec's bar is not "a lovely still at the high tier on an M5." It is a warm hand-pressed
clay diorama, at a locked 60 fps, on a mid-range Android tablet, legible to a four-year-old in
three seconds, with no hard edge anywhere — and against that bar the product currently fails in
five structural ways at once. **Two of nine games render nothing at all on the device PROJECT.md
names first**, and three more are clipped, occluded or overflowing there. **The tier that target
device actually boots turns the signature shadow off, facets every silhouette, and makes the
mascot frown** — the frame the target child sees is not the frame anyone has been reviewing.
**The shadow — the single most important material cue in the whole look — is a flat grey decal
in every scene**, a defect round 2 measured, round 3 escalated, and round 4 addressed by making
the slab shallower rather than softer. **The character at the centre of six games physically
cannot smile**, and the hero of the game called *Smile Maker* has an anger brow that its own
source comment believes is friendly. And **the project's own instrumentation breaches its own
GPU budget in 29 of 30 readings**, with no measurement on the target hardware anywhere in 843
evidence files. Round 4 is materially better than round 3 — the capture harness is honest, the
penumbra and memory probes are real measurements rather than assertions, and several
long-standing defects are genuinely closed — but the gap that remains is not polish. It is
roughly two focused work-streams: one on shared material, shadow and mascot code (A1–A5), and
one on layout, viewport and celebration framing (A8–A10), plus a single trip to a real tablet to
convert A7 from arithmetic into a fact. Nothing on this list is architecturally hard. All of it
has to land before a pass is defensible.
