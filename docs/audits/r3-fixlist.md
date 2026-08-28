# ROUND 3 — CONSOLIDATED FIX LIST

Thirteen critics (nine game, four cross-cutting). All verdicts FAIL. Deduplicated to **68 items**:
26 shared, 42 game-scoped. **Shared items must land first** — 19 game items are blocked by one.

Every claim below was re-verified against source before inclusion. Claims that could not be
verified, or that a critic themselves marked unconfirmed, are listed in **DROPPED** at the end.

Severity: **blocker** = fails a `docs/3D-SPEC.md` hard constraint or a rubric line outright ·
**major** = fails a rubric line in one place, or a spec section with a stated tolerance ·
**minor** = real defect, does not fail a line on its own.

---

# PART A — SHARED CODE (`src/three/**`, `src/shared/**`, `src/hub/**`, `src/dev/**`, root)

## A1. blocker — Cache ownership window opens *after* the caches are populated, so nothing any game allocates is ever reclaimed
**Owner:** shared
**Files:** `src/three/dispose.ts:147-157` (`tagCacheEntry`), `:164-167` (`enterScene`), `:196-205` (`flushSceneEviction` sets `activeScene = null`); `src/dev/perf.ts:260-270` (`markSceneEnter` → `enterScene`); `src/GamesCollection.tsx:199`; `src/three/Scene3D.tsx`
**Reported by:** sliding-puzzle F1 (root cause), performance F2, accessibility F13, brand rubric 8, content-safety #5

**Defect (verified).** `tagCacheEntry` stamps an entry with `activeScene` *at lookup time*.
`activeScene` is set only by `enterScene`, called from `markSceneEnter`, called from a
`useEffect`. Every game's `useMemo` cache lookups (`clayTray`, `roundedPlate`, `roundedBox`,
`cachedGeometry(...)`, every `clay*` material factory) run in the **render** phase, before any
effect. Worse, leaving the hub calls `flushSceneEviction`, which sets `activeScene = null`
(`dispose.ts:205`) — so at the moment a game first renders, `activeScene` is `null`. Every entry
is therefore stamped `owner = null`, which `dispose.ts:150-153` treats as the "genuinely shared"
tier, and `flushSceneEviction` skips it forever. The per-scene eviction machinery is real and
correct and never fires on anything.

Measured: `endurance.json` — hub baseline geometries 21 / programs 4; after the first game
23 / 9, flat across two full nine-game loops. `computeMemoryDrift().withinSpec === false`.
Fails §5 ("must return to the hub baseline", ±2 programs only).

**Fix.** Open the ownership window before the scene subtree renders, not after.
Preferred: have `Scene3D` call `enterScene(gameId)` from a `useLayoutEffect`/render-phase guard
that runs as part of mounting the `<View>`, so no game can populate a cache outside its own
attribution window; keep `markSceneEnter` for the perf mark only. Then re-run the two-loop
endurance test and require geometries back to 21 and programs to 4±2.

## A2. blocker — `text.ts` is the only resource cache that is not scene-registered, and its disposer is dead code
**Owner:** shared
**Files:** `src/three/text.ts:46` (module `Map`), `:226` (`markShared`), `:233` (`disposeTextCache`)
**Consumer:** `src/games/count-the-teeth/scene.tsx:947`
**Reported by:** count-the-teeth F3, performance F1, accessibility F13, brand rubric 8, content-safety #5

**Defect (verified).** `textures.ts:51`, `geometry.ts:64` and `materials.ts:868` all call
`registerSceneCache`. `text.ts` does not. Every entry is `markShared`, so `disposeObject3D` and
`DisposalBag.release()` walk past it, and `disposeTextCache()` — grep confirms — is **called from
nowhere in `src/`**. The cache grows monotonically with distinct strings seen, for the life of the
tab.

Measured: `endurance.json` textures 3 → 9 (loop 1) → **11** (loop 2), still climbing when the run
ended; every loop-2 increment attributable to count-the-teeth.
`count-the-teeth-memory-after.json` reads `textures: 12` while `caches.texture` stays at 1 — i.e.
the leaked textures are outside every registered cache, which is exactly this path.

**Fix.** Register the text cache as a `SceneCache` (`entries` / `evict` / `size`), call
`tagCacheEntry("text", key)` on every lookup, drop the `markShared` at `:226`. Requires A1 to be
fixed first or the entries will simply be stamped `null` instead. Then re-run the two-loop
endurance and require textures back to 3.

## A3. blocker — The hub baseline excludes resources every game needs, so the first game entered permanently blows the §5 program tolerance
**Owner:** shared
**Files:** `src/three/hit.tsx:316, 330, 331, 351` (module-scope `markShared` geometries); `src/three/Scene3D.tsx:203`; `src/dev/perf.ts:265` (baseline capture point)
**Reported by:** performance F2, tooth-match F6, smile-maker F5 (partly), brand rubric 8

**Defect (verified).** `hit.tsx` builds `COLLIDER_GEOMETRY`, `RING_GEOMETRY`, `HALO_GEOMETRY` and
`CONTOUR_GEOMETRY` at module scope with `markShared`. `hit.tsx` arrives in the lazy game chunks,
so those four geometries materialise **after** the hub baseline is taken and never leave — that is
the standing `+2 geometries`. Separately, the first game compiles ~5 shader variants the hub never
needed (programs 4 → 9 on the first entry, flat thereafter) — a permanent `+5` against a `±2`
tolerance.

**Fix.** (a) Route `hit.tsx`'s four geometries through `cachedGeometry()` so they are tracked and
evictable, **or** construct them in the hub so they land inside the baseline. (b) Warm the game
shader variants once at hub boot (a hidden precompile pass over the clay material permutations —
instanced-albedo, shadow-receive) so the baseline includes them and A1's eviction can then take
them back down. (c) If +6 programs proves genuinely irreducible after (a) and (b), amend §5's
tolerance in the spec and defend the number — do not ship against a figure the code fails.

## A4. blocker — White text on light gradients: every primary button in the product fails WCAG AA
**Owner:** shared
**Files:** `src/index.css:412-450` (`.grad-btn` sets `color:#ffffff` over
`linear-gradient(145deg, var(--g-from), var(--g-to))`; `.grad-peach`, `.grad-mauve`, `.grad-coral`,
`.grad-rose`, `.grad-red` at `:446-450`); consumers `src/shared/GameShell.tsx:926` (`GRADS[accent]`),
every celebration "Play again", `src/games/tooth-runner/ToothRunner.tsx` "Tap to run",
`src/games/tooth-rescue/ToothRescue.tsx:237-245` "Tap to start"
**Reported by:** accessibility F1 (measured)

**Defect (verified in source).** `index.css:35` audits the *ink* ramp only; nobody ever ran
`contrastRatio()` on `#ffffff` against the gradient stops. Measured off the rendered composites:
peach pill **2.15:1**, mauve **3.11:1**, coral **3.15:1**, rose **4.02:1**, red **4.18:1** (all need
4.5:1 at 14 px / 800). **"Play again" 2.19:1** and **"Tap to run" 2.19:1** — these fail even the
3:1 large-text floor. The 145° ramp puts the lightest stop under the start of the text. Fails §8
and §1.5.

**Fix.** Either drop the light stop (`--g-from`) of every gradient to a relative luminance ≤ 0.19
(which `grad-red`'s `#c9212b` end already achieves at 5.62:1), or switch `.grad-btn` to
`color: var(--color-ink)` on peach/mauve/coral/rose and keep white only on `grad-red`. Then add a
selftest that walks the five `.grad-*` classes, calls the existing `contrastRatio()` helper on
`#ffffff` (or the chosen ink) against **both** stops, and fails the build. The helper already
exists in `src/dev/selftest.ts`.

## A5. blocker — DOM tap targets are 35–40 px against the §1.5 / §8 48 px floor
**Owner:** shared
**Files:** `src/shared/GameShell.tsx:920-931` (difficulty pills: `px-[18px] py-[9px] text-sm` → 38 px
computed, **35 px measured**), `src/index.css` `.clay-btn`, `src/games/sliding-puzzle/SlidingPuzzle.tsx:305`
("Next picture", ~40 px)
**Reported by:** accessibility F2 (measured 35 px), sliding-puzzle F5 (measured 37 px)

**Defect (verified).** The `clay-well` wrapper reaches 48 px only through its own `p-[5px]`; the
three `<button>`s inside it do not. `HitTarget` enforces `minScreenPx={48}` correctly for 3D
colliders — the DOM chrome a three-year-old actually has to hit is unpoliced, and the
`hit-targets` selftest only probes 3D colliders so it cannot see this.

**Fix.** `py-[14px]` on the level pills and `py-[13px]` on `.clay-btn` (grow the hit box with
padding; keep the visual pill its current size with an inner span if the design wants it small).
Extend `?selftest=hit-targets` to walk `document.querySelectorAll('button')` and assert
`getBoundingClientRect()` ≥ 48 in both axes.

## A6. blocker — PCSS dither is keyed on `gl_FragCoord`, which invents fake differences in Spot the Difference
**Owner:** shared
**Files:** `src/three/materials.ts:424`; surfaces in `src/games/spot-the-difference/scene.tsx:571-590`
**Reported by:** spot-the-difference F1 (localised the mechanism), content-safety #4, accessibility F4

**Defect (verified).**
```glsl
float ign = fract( 52.9829189 * fract( dot( gl_FragCoord.xy, vec2( 0.06711056, 0.00583715 ) ) ) );
```
`gl_FragCoord.xy` is absolute drawing-buffer space. Panel A and panel B are drawn ~780 device px
apart, so every shadowed fragment rotates its Vogel disc to a different angle in the two panels and
samples a different blocker set. The game's own test fails, twice:
`selftest-spot.json` — *"PANEL DRIFT: 2466 pixels differ between the two panels with identical
content (1367 clusters, worst 9x17 at 432,207)"*. The signature is diagnostic: drift is present
inside smooth shadow interiors (window penumbra 2.04 % > 4/255, shaded cabinet face 2.33 %) and
**0.00 % on the unshadowed lit wall** — the opposite of what a sub-pixel geometric offset produces.
`src/games/spot-the-difference/selftest.ts:36-42` states in its own comment that three's dithering
is "the only screen-space thing in the pipeline"; `materials.ts:424` broke that invariant. Direct
§6.5 violation.

**Fix.** Key the rotation off something identical for the same world fragment in both panels.
Cheapest correct option: rotate by
`fract(52.9829189 * fract(dot(coord.xy * shadowMapSize, vec2(0.06711056, 0.00583715))))` using the
shadow-space coordinate already in hand — still per-fragment, still decorrelates the disc, panel-
independent by construction. If the window-space grain is wanted for its screen-uniformity, add a
`uPanelOrigin` uniform and subtract it, written per panel between the two `gl.render` calls.
**`?selftest=spot` must be green before this ships.**

## A7. blocker — Contact-blob shadows are flat plateaus that read as decals
**Owner:** shared
**Files:** `src/three/materials.ts` (`shadowBlobMaterial`), `src/three/Rig.tsx` (`ContactBlob`, `contactRadiusFor`)
**Reported by:** count-the-teeth rubric 2 + F7 (measured), brand F5 (measured), tooth-runner F3/F4, tooth-rescue #9

**Defect (measured).** Sampled in `count-the-teeth-hard-count14.png` directly under a tooth's root
prongs (902,308), between the prongs (912,307) and 20 px away at the blob's visual centre
(906,306): **all three read `164,96,71` — bit-identical** — then a ~24 px ramp to full brightness at
the rim. §2 names this failure verbatim: "A shadow that is exactly as soft directly under a prop as
it is a unit above it reads as a dark decal stuck to the floor."

Second defect, same object, measured on the same frame: the blob **desaturates its receiver by
half** (lit coral C\* 68.6 → blob 36.1, hue +6°) where the real key/PCSS shadow correctly holds 91 %
of the receiver's chroma (C\* 62.6, hue +1.5°). On any saturated surface the blob lands as mud.
Third: the blob is ~3× the prop's footprint and is not clipped to the receiver — in
`count-the-teeth` it spills over the mat's rounded rim onto the cream page.

**Fix.** (a) Give `shadowBlobMaterial` a real profile — a dark core at the contact point and a wide
soft skirt — instead of a plateau plus a rim ramp. (b) Tint it through `CLAY.shadowTint` as a
multiply against the receiver's own albedo rather than a neutral darkening. (c) Size the radius from
the prop's actual footprint, not a hand-set multiple, and clip it to the receiver's geometry.
(d) Re-verify by re-sampling the three points above and requiring a monotonic gradient.

## A8. major — PCSS penumbra does not tighten at contact in wide-`shadowArea` scenes, and the kernel is visibly undersampled
**Owner:** shared
**Files:** `src/three/Rig.tsx:149-205` (`shadow.radius` derived from texels-per-unit), `src/three/materials.ts:413-457` (20-tap filter)
**Reported by:** tooth-runner F4 (measured), tooth-rescue #9 (ambiguous, see EVIDENCE)

**Defect.** In Tooth Runner (`SHADOW_AREA = 14`, `layout.ts:265`) the hero's cast shadow sits roughly
a body-width to the right of the feet with a **uniformly wide penumbra that never tightens at
contact**, measured at ~40 px where the ortho maths (14 units / 1024 texels = 0.0137 u/texel)
predicts ~6 px. At 2.6× contrast the interleaved-gradient dither is plainly readable as speckle
across the whole kernel and will crawl at 8 units/second. `?tier=low`, which drops to the stock
17-tap fixed-radius kernel, reads **better**.

**Fix.** Check the `shadow.radius`-as-penumbra-texels mapping against this game's ortho depth range —
either the gap term is saturating or the blocker search is missing the ground plane. Cap the maximum
penumbra so the contact end resolves, and raise the PCF disc tap count (or lower the max radius)
until the dither is sub-visible at 8 u/s. Re-verify with the A9 test below.

## A9. major — Grain and curvature-AO produce nothing on flat or constant-curvature surfaces, which is most of five games
**Owner:** shared
**Files:** `src/three/materials.ts` (`grain` / `normalScale` in `clayAccent`, `clayGum`, `clayPainted`), `src/three/geometry.ts:564` (`bakeCurvatureAO` inside `finish()`), `:178-179` note
**Reported by:** maze-escape F2 (measured), tooth-runner F5 (measured), healthy-or-not #7 (measured), count-the-teeth F7 (measured), tooth-rescue #1 (measured), brand F1

**Defect (measured, five independent scenes).** `bakeCurvatureAO` writes a *constant* vertex colour
on a mathematically flat plateau or a constant-curvature primitive (sphere/cone/torus) —
`build.ts:178-179` concedes this in its own comment. And a normal map at `grain 0.11–0.16` cannot
shade a face whose normal nearly parallels the key, nor a prop spanning a third of the frame.
Measured consequences: maze wall tops ±2/255 over 70 px with no structure surviving a 3.2× contrast
boost; count-the-teeth pad RGB(228,83,51) ±3 across ~400 px; tooth-rescue panel σ 1.3/255 over
40×40; healthy-or-not bin HF energy 0.48 vs mascot crown 4.16. Two mechanisms are present and both
are no-ops on the surfaces that dominate the frames. Fails rubric line 1 and §3.

**Fix.** (a) Drive the grain from **triplanar world-space** coordinates instead of UVs, so
`roundedCylinder`/`toothGeometry`/extruded slabs all resolve it. (b) Scale `grain` / `normalScale`
by the prop's **world size** rather than using one constant — a 6-unit hill needs several times the
amplitude a 0.3-unit pebble does to read the same. (c) Add a low-frequency albedo/roughness mottle
(not just a normal map) so a plateau breaks up under any light angle. Per-game geometry displacement
(B2.2, B7.5, B9.3) is the complement to this, not a substitute.

## A10. blocker — The celebration renders in a different `<View>` from the game, so the hero floats, intersects game props, and the copy lands on 3D geometry
**Owner:** shared
**Files:** `src/shared/GameShell.tsx:66` (celebration `<View>`), `:413` (`CelebrationClock`), `src/three/celebrate.tsx:408` (podium), `:671-681`; interacts with `src/games/sliding-puzzle/scene.tsx` (stageRef), `src/games/healthy-or-not/scene.tsx:1186-1197`, `src/games/spot-the-difference/scene.tsx:523-526`
**Reported by:** sliding-puzzle F4, healthy-or-not F1, spot-the-difference F3

**Defect.** The celebration hero and its 0.92-unit clay podium render in `GameShell`'s own `<View>`;
the game's props render in the game's `<View>`. No shadow pass connects them, so the podium **casts
nothing** onto anything the game left standing. Measured consequences:
- **Sliding Puzzle** — the podium hovers inside the tray with no shadow on the tray floor and
  interpenetrates both inner walls; the ledge bar passes through the mascot at arm height; and
  `celebrationHeroScale()` scales the game stage to 0, so the finished picture the child just built
  is swept away and the held frame is an **empty tray**.
- **Healthy or Not** — "Great job, Maya!" is set in `#2F3237` directly across the turntable rim and
  its progress beads, with no scrim and no plate; the hero stands on a beige disc floating in
  mid-air with no contact shadow, at a different scale from the game's own turntable half-faded
  below it.
- **Spot the Difference** — the 3D rooms scale to zero but the two DOM panel `<div>`s keep their
  `PANEL_SHADOW`, leaving two empty inset picture frames with a seam running vertically through the
  mascot's legs (measured luminance step 232→238 at x=759, y=600).

**Fix.** Pick one contract and apply it to all nine. Recommended: keep the celebration in
`GameShell` but require each game to **fully vacate** on `complete` (same
`celebrationHeroScale()` window the mascot already uses — so the turntable, the bin, the tray and
the DOM panel frames all leave together), give the hero a real ground plane and its own contact
shadow at the room's scale, and place the headline in solved negative space — never on top of a
prop. Where a game's payoff *is* the board (Sliding Puzzle's completed picture), hold that frame
visibly for its full beat before anything pops, and capture the frame.

## A11. blocker — Celebration confetti composition reads as red-and-white spatter
**Owner:** shared
**Files:** `src/three/celebrate.tsx:369` and the burst palette / chip geometry around it
**Reported by:** brand F3 (measured), content-safety #15

**Defect (measured).** `count-the-teeth`'s celebration fires a dense spray of small **elongated
capsule-shaped chips**, cream and dark red, from the base of an open-mouthed tooth mascot with a red
tongue, over a saturated `#e2502f` field. Measured chip colours `#c04020`, `#b03010`, `#a03010`;
darkest L\* 23; 1.6 % of the frame at C\* > 25 and L\* < 50. `celebrate.tsx:369`'s own comment records
that a previous build histogrammed these as `#930F08 / #DC1209 / #4C0B04` and called it *"dried
blood, in a paediatric dental product, as the reward for finishing"*. The `ALBEDO_ATTRIBUTE` change
fixed the tint pipeline; it did not fix the composition. Fails §1.1.

Compounding, from the other direction: in the eight games whose ground is cream, the confetti is
cream-on-cream and effectively invisible — so the burst is either alarming or absent.

**Fix.** (a) Clamp every confetti albedo to L\* ≥ 40 (`red.deep #c21e25` is the floor). (b) Change
the chip silhouette from a sliver to a rounded disc or a star. (c) Pick the burst palette **against
the receiving game's ground** — a coral scene gets cream + peach chips, a cream scene gets accent
chips — never red over red. (d) Re-run the histogram after any material change and assert the L\*
floor in a selftest.

## A12. blocker — `--chrome-h` does not describe the real chrome band, so HUD chips land on 3D props and on each other
**Owner:** shared
**Files:** `src/shared/GameShell.tsx` (publishes `--chrome-h`; HUD chip row and the level pill row), consumed by every game's `layout.ts` `cameraFor`
**Reported by:** sliding-puzzle F6, count-the-teeth F4, tooth-rescue #5, tooth-runner F1, brand F8, content-safety B3/#6, accessibility F7

**Defect.** Every `layout.ts` reads `--chrome-h` and solves the camera to keep geometry out of that
band — the mechanism is right. It fails on two counts. (1) `--chrome-h` reflects an unwrapped
constant, so when the HUD row **wraps** at phone width the reserved band is too short: measured, the
`0:00`/`★` chips render on top of Sliding Puzzle's reference plaque (the only thing on screen telling
the child what they are building), on top of a Count the Teeth tooth, and across Tooth Rescue's
drop-rail (rail visible in only 37 of 70 sampled columns). (2) Below ~430 px the chip row overlaps
the **Easy/Medium/Hard row** — two interactive DOM rows stacked, hiding "Hard". That is DOM-over-DOM
and cannot be a compositor artefact.

**Fix.** (a) Measure the HUD band element's actual laid-out height (`ResizeObserver` on the band) and
publish *that* as `--chrome-h`. (b) Below ~430 px, stack the chip row and the level row rather than
letting them overlap, and add the chip row's height into the published band. (c) Give `cameraFor` a
minimum top margin so no solved prop can enter the band even at the wrapped height. (d) Re-shoot at
390×844 and 360×640 for all nine.

## A13. blocker — Perf marks are recorded twice and a zero-frame mark is reported as a pass
**Owner:** shared
**Files:** `src/dev/perf.ts:236` (`MARK_SLOTS = 24`), `:242-254` (`mark`), `:253` (`slot.at = realNow()`), `:332` (window ageing), `computeViolations`; `src/GamesCollection.tsx:199, 216`; the nine per-game duplicate calls — `spot-the-difference/SpotTheDifference.tsx:332,341`, `tooth-runner/ToothRunner.tsx:220,222`, `count-the-teeth/CountTheTeeth.tsx:169,171`, `tooth-rescue/ToothRescue.tsx:331,333`, `maze-escape/MazeEscape.tsx:246,248`, `healthy-or-not/HealthyOrNot.tsx:168,175`, `sliding-puzzle/SlidingPuzzle.tsx:245,247`, plus tooth-match and smile-maker
**Reported by:** performance F7 + F8, tooth-match F5, maze-escape #5, healthy-or-not #13, content-safety #7

**Defect (verified).** `markSceneEnter`/`markSceneExit` are called from **both** `GamesCollection`
(which owns the route) and each game's own mount effect. `mark()` does not dedupe, so with 24 slots a
nine-game loop overruns the ring at six games and later captures show stale or overwritten marks.
Separately, `mark()` stamps `slot.at = realNow()` and `:332` ages the slot against that same **real**
clock — under `?drive=1` frames arrive only when the harness pumps, so any real-time gap > 1000 ms
between the mark and the next pumped batch closes the window at `frames: 0, worstMs: 0`, and
`computeViolations` then **skips it entirely** (`if (!slot.used || slot.frames === 0) continue`). An
absent measurement is reported as an empty `violations` array. Reproduced twice for Tooth Match on a
fresh load; present for maze-escape in five other captures. **Tooth Match currently has no
scene-entry measurement at all.**

**Fix.** (a) Delete the nine per-game `markSceneEnter`/`markSceneExit` calls — `GamesCollection` owns
the route — or dedupe inside `mark()` by ignoring a same-name-same-phase mark opened within the last
frame. (b) When `virtualClock` is true, age marks by **frame count only**; drop the
`wall - slot.at > MARK_WINDOW_MS` term. (c) Have `perfSnapshot` push `hitch:<phase>:<name>` into
`unmeasured` when a closed mark has `frames === 0`, so it can never read as a pass.
**This gates every entry measurement in round 4 and must land before re-capture.**

## A14. blocker — GPU cost is never measured, and the CPU numbers are internally contradictory
**Owner:** shared
**Files:** `src/dev/drive.ts:126-140` (`avgWithGpuMs` runs a **second, separate** 20-frame pass), `src/dev/perf.ts` (`fps` / `droppedFrameRatio` self-declared `unmeasured`)
**Reported by:** performance F4 + §1 (the central evidence finding), echoed by all nine game critics as their #1 evidence gap

**Defect (verified in the corpus).** Nothing in 416 files reports a GPU timer query, and the clay
shader runs a **20 dependent texture fetch** PCSS filter per shadowed fragment on top of
`MeshPhysicalMaterial` + fbm normal + IBL + vertex AO. A mid-range tablet is fragment-bound long
before it is CPU-bound; that entire cost is invisible. The CPU numbers are also self-contradictory:
`avgWithGpuMs` samples a different scene state than `avgMs`, producing the impossible result of a
superset measurement being cheaper than its subset (maze-escape 0.115 < 0.161; sliding-puzzle
0.445 < 0.558), and `tier-low.json` measures the strictly *cheaper* configuration as 4–6× **more**
expensive (maze-escape 0.598 ms at 17,670 tris vs 0.161 ms at 51,510 tris).

**Fix.** Bracket the frame with `EXT_disjoint_timer_query_webgl2` in a **visible, focused** tab; run
the timed and untimed passes over the identical frame-index range and scene state; report GPU p95 per
game next to CPU p95. Capture at `?tier=mid` at a 1200×800 CSS viewport (see A15). Bar to clear:
desktop GPU p95 ≤ 1.2 ms per game (≈12× fragment ratio for Mali-G52/Adreno 610 at 2.2 Mpx vs an
M-series at 5.0 Mpx). Until this exists **no 60 fps claim in this product can be graded.**

## A15. major — The target tier was never measured
**Owner:** shared
**Files:** `src/three/quality.ts:98-101` (coarse-pointer → `mid` only at `cores >= 8 && memory >= 6`, else `low`)
**Reported by:** performance F5

**Defect.** `mid` (dpr 1.5, 1024 shadow map, PCSS **on**, detail 2, 160 instances) is the tier a
mid-range Android tablet most plausibly boots into, and there is not one `?tier=mid` measurement in
the entire corpus — only `high` (desktop default) and `low`.

**Fix.** Capture the full matrix at `?tier=mid` at 1200×800 CSS, and state which tier the named target
device actually probes into, including what `navigator.deviceMemory` reports on it — that single
value decides mid vs low.

## A16. major — Scene entry compiles shaders synchronously
**Owner:** shared
**Files:** `src/three/Scene3D.tsx:203` (`state.gl.compile(state.scene, state.camera)`), comment at `:180-186`
**Reported by:** performance F6

**Defect (verified).** The call is the synchronous `gl.compile`. Its own comment states the cost on
Mali/Adreno is **15–60 ms per variant**, and first entry to a game compiles ~5 new programs
(`endurance.json`: 4 → 9). That is 75–300 ms of blocking compile inside the entry window against §9's
"scene entry hitch ≤ 1 dropped frame". Desktop is already at the edge before compile is counted:
Sliding Puzzle's enter `worstMs` is 6.8 ms — 34 ms at a 5× CPU ratio, exactly one missed vsync with
zero margin.

**Fix.** three 0.170 ships `WebGLRenderer.compileAsync()` (KHR_parallel_shader_compile — confirmed
present in this repo's `node_modules/three`). Call it from the card hover/focus/pointerdown prefetch
§5 already mandates for the JS chunk, so compilation overlaps the 450–600 ms dive. Keep synchronous
`gl.compile` only as a fallback when the extension is absent.

## A17. blocker — The hub exceeds the §9 triangle budget
**Owner:** shared
**Files:** `src/hub/HubScene.tsx`, `src/hub/props.tsx:44` (`const D = () => getQuality().detail`)
**Reported by:** performance F3, brand hard constraints, content-safety #8

**Defect (verified).** `hub-baseline.json`: `triangles: 188558` against `budget: 180000` — the **only**
budget violation the harness reports anywhere, and it flags itself. High tier only (`tier-low.json`
reads 39,138). This is also the scene with the worst measured `renderP95Ms` (2.50 ms, 8× the next
worst game), and it is the first screen a child sees and the screen they return to nine times a
session.

**Fix.** The hub is a menu of nine static props at slab scale; `detail: 3` buys nothing there. Clamp
`D()` to 2 for hub-prefixed builders (or pass `detail: 2` into the hub's `roundedPlate`/prop calls).
Expect ~90–110 k and a matching drop in the 2.5 ms.

## A18. blocker — The hub shows four cards of bare, faceless extracted teeth with exposed roots
**Owner:** shared
**Files:** `src/hub/props.tsx:138` (`CardPair`), `:221` (`Basket`), `:236-237` (`ThreeTeeth`, ×3), `:274` (`RunningTooth`) — all `geometry={tooth()}` + `material={clayEnamel()}`
**Reported by:** content-safety B1, content-safety rubric 9

**Defect (verified).** Seven bare teeth on the landing screen, no face and no feet. The Count the
Teeth card shows three faceless white teeth with long splayed roots against a **pink gum-coloured**
pad; the Tooth Rescue card shows a single faceless rooted tooth **falling into a deep red basin**
under the caption "Catch the falling teeth". The codebase already knows: `src/games/tooth-rescue/mascot.ts`
opens by quoting the prior round — *"an extracted tooth is not a mascot"* — and the in-game scenes
were fixed. The hub was not, so the advertisement is now scarier than the product. Fails §1.1.

Compounding (same files, rubric line 9): with the text label removed — the actual condition for a
pre-reader — only 2 of 9 cards are legible (apple, magnifying glass). The other seven read as a brown
square, an orange block, two dashes, a party hat, and the two above.

**Fix.** Point `Basket`, `ThreeTeeth`, `CardPair` and `RunningTooth` at `mascotParts()` /
`MASCOT_FACE` (`src/three/geometry.ts:1422, 1489`) — the geometry already exists and is already baked
for instancing. Desaturate the basket interior off `clayAccent("red","main")`. Then re-check all nine
card props with the label hidden and require the subject to be identifiable.

## A19. blocker — Mascot feature anchors are not scaled by `featureScale`, so cheeks break the silhouette and the eye catchlight is buried inside the pupil
**Owner:** shared
**Files:** `src/three/geometry.ts:1422` (`MASCOT_FACE` clearance table), `:1489` (`mascotParts`), `:1423-1427`, `:1550`; consumers `src/games/count-the-teeth/scene.tsx:292-306` (`featureMatrix`, `FACE_SCALE = 1.3`), `src/games/tooth-rescue/mascot.ts:82` (`featureScale: 1.6`)
**Reported by:** count-the-teeth F2 + F8 (arithmetic), tooth-rescue #4 (arithmetic, independently), maze-escape #3 (symptom)

**Defect (verified arithmetic, two games).** `mascotParts` scales feature *radii* by `k` but passes
the **anchor offsets unscaled**, so every clearance in the `MASCOT_FACE` table is invalid at `k ≠ 1`.
- Count the Teeth at `k = 1.3`: eye radius `0.068 × 1.3 = 0.0884`; glint radius `0.021 × 1.3 = 0.0273`;
  glint centre offset `|(-0.022, 0.024, 0.05)| = 0.0597`. Outer reach `0.0597 + 0.0273 = 0.0870 <
  0.0884` — **the glint sphere is entirely enclosed by the eye and never renders.** At `k = 1` it
  protruded by 0.0126. Result: two solid matte-black discs, which with a lipless brown mouth line and
  two exposed root prongs read as a **skull**, on a board of fourteen of them.
- Tooth Rescue at `k = 1.6`: cheek outer edge `0.235 + 0.085 × 1.6 = 0.371` against a 0.347 crown
  half-width — 7 % of the half-width hangs in empty space; mouth front `z = 0.305 + 0.055 × 1.6 =
  0.393` against a 0.354 surface, standing 0.039 H proud so the mouth reads as a stuck-on lozenge.

This is a §1.1 content violation as rendered — the product already contains proof of the right read
in the celebration hero, which is charming.

**Fix.** Multiply the anchor offsets by `k` in `mascotParts` (`position: [side * F.cheek.x * H * k, …]`,
and the glint's `dx/dy/dz`), or push the glint's `dz` out to `eye.r × k × 1.05`. Verify at Count the
Teeth Hard/14 where a tooth is ~60 px tall, and at Tooth Rescue's `featureScale: 1.6`. Then re-check
the read against the celebration hero.

## A20. major — `roundedPlate`'s final clamp overrides `MIN_BEVEL`, shipping visible hard edges
**Owner:** shared
**Files:** `src/three/geometry.ts:833`
**Reported by:** tooth-match F4

**Defect (verified).**
```ts
const bevel = Math.min(Math.max(MIN_BEVEL, Math.min(t * 0.35, corner * 0.55)), t * 0.45);
```
The trailing `t * 0.45` term silently overrides the `MIN_BEVEL` floor. With Tooth Match's
`INLAY_T = 0.036` this resolves to **0.0162** against §3's hard 0.02 minimum, and it renders as a
razor-straight dark seam with an ivory sliver across the bottom of every face-up card — a visible hard
edge on the surface a child looks at longest.

**Fix.** Make `roundedPlate` **refuse** a thickness that cannot carry `MIN_BEVEL` (throw in dev, clamp
`t` up in prod) rather than silently shipping a thinner roll. Then fix the caller (B3.4).

## A21. major — Spot the Difference's play area never gets its height, because the shell's content column does not resolve
**Owner:** shared (+ spot-the-difference)
**Files:** `src/shared/GameShell.tsx` (content column), `src/games/spot-the-difference/SpotTheDifference.tsx:168-195` (`frameRef`, `min-h-0 flex-1`), `src/games/spot-the-difference/layout.ts:301-308` (`solvePanels`)
**Reported by:** spot-the-difference F2 (measured)

**Defect (measured).** Panels render at **390 × 275 CSS px inside a 1500 × 820 window** — ~28 % of the
available play area by area — with ~130 px of dead cream above and ~95 px below. `solvePanels` is
correct on the box it is handed; the box is ~800 × 275 because `flex-1` on `frameRef` resolves against
content, not the viewport. Consequence in the one game whose entire mechanic is close looking: a
toothbrush is ~20 × 9 CSS px and the extra star is ~25 px.

**Fix.** Make `GameShell`'s child column `h-full` down to `frameRef` so `flex-1` resolves against the
viewport, and let `solvePanels` see the full box. At 1490 × 520 the row solve returns ~738 × 512
panels — 1.9× linear, ~3.5× picture area, no new geometry. Then re-check `tapScreenPx(layout.fh)`,
which moves with the panel fraction.

## A22. major — `user-scalable=no` disables pinch-zoom app-wide
**Owner:** shared
**Files:** `index.html:5` — `<meta name="viewport" content="… maximum-scale=1.0, user-scalable=no" />`
**Reported by:** content-safety #12

**Defect (verified).** WCAG 1.4.4 violation. In a waiting room it also removes the parent's only
recourse when text is small.
**Fix.** Delete `maximum-scale=1.0` and `user-scalable=no`.

## A23. minor — Two quality flags gate nothing
**Owner:** shared
**Files:** `src/three/quality.ts:19, 21, 51-52, 59-60, 67-68`
**Reported by:** performance F9

**Defect (verified).** `contactShadows` and `depthOfField` are declared per tier and grep finds **no
reader anywhere in `src/`**. So the low tier does not get the cheaper contact-shadow path it
advertises, and the high tier's DOF is a promise with no implementation — which matters because
`quality.ts` therefore misdescribes what the low tier costs, and low is the tier most target devices
land on.
**Fix.** Delete both fields, or wire them.

## A24. minor — `tokens.ts` neutrals are stale and its own comment is now false
**Owner:** shared
**Files:** `src/three/tokens.ts:31-33` (`inkMid "#6b675f"`, `inkSoft "#8f897d"`, under a comment reading *"Identical to the CSS tokens"*) vs `src/index.css:50-51` (`#575349`, `#67635a`)
**Reported by:** brand F7

**Defect (verified).** The CSS moved for WCAG reasons and documented that the old values failed AA on
all 11 usages. The 3D layer's source of truth still holds the abandoned values. Currently unused in 3D
(grep confirms), so this is a landmine: the first in-world label reaching for `NEUTRAL.inkSoft` ships a
2.8:1 failure.
**Fix.** One-line sync, and either delete the "Identical" claim or add a test that enforces it.

## A25. minor — `announce()`'s 60 ms debounce silently drops back-to-back messages
**Owner:** shared
**Files:** `src/three/hit.tsx:108-119`
**Reported by:** accessibility F12

**Defect.** The region is cleared and re-set on a 60 ms timer, cancelling any pending message. Two
`announce()` calls in one commit — e.g. a game's "Match!" plus `GameShell`'s completion announcement,
which both fire on the completing move — mean only the second is spoken.
**Fix.** Queue instead of replace, or bump the second message onto a follow-on tick.

## A26. minor — `FocusRing` has no panel-fraction compensation
**Owner:** shared
**Files:** `src/three/hit.tsx` (`RING_MIN_SCREEN_PX = 20`, `viewHeightPx()`); consumer `src/games/spot-the-difference` (`tapScreenPx(layout.fh)`)
**Reported by:** accessibility F9

**Defect.** `RING_MIN_SCREEN_PX` goes through the same uncompensated `viewHeightPx()` that `HitTarget`
needs `tapScreenPx()` to correct. At Spot's ~0.37 panel fraction the ring's floor is ~7 px radius /
15 px diameter. Latent today (prop radii usually exceed it), but it is the same bug `tapScreenPx` was
written to kill, left unfixed one function over.
**Fix.** Give `FocusRing` a `minScreenPx` prop and have Spot pass `tapScreenPx(fh)` into it.

## A27. minor — Score presentation can tell a child they did worse
**Owner:** shared
**Files:** `src/shared/GameShell.tsx` (celebration score + "Best" pill), `src/shared/scoring.ts`
**Reported by:** content-safety #9

**Defect.** A 0-point run shows **"0 pts"** beside **"Best: 300"** — reachable in tooth-rescue,
tooth-runner, count-the-teeth and healthy-or-not. That is a direct did-worse comparison at the exact
moment §1.1 requires celebration.
**Fix.** Suppress the "Best" pill when `value < best`, or floor every game's score the way tooth-match
already does.

## A28. minor — Hub subtitle is competitive and meaningless to a first-time child
**Owner:** shared
**Files:** `src/hub/HubScene.tsx` / `src/GamesCollection.tsx` (hub subtitle copy)
**Reported by:** content-safety #16
**Fix.** Replace *"can you beat your best score?"* with "Pick one and play."

## A29. minor — `sounds.oops()` uses the universal wrong-answer descending motif
**Owner:** shared
**Files:** `src/shared/audio.ts`
**Reported by:** content-safety #17

**Defect.** Two triangle tones descending 380 → 300 Hz. Soft enough (vol 0.08, 15 ms attack) to pass
"nothing jarring", but descending pitch is the culturally universal "wrong" signal in a product whose
§1.1 rule is that mistakes are playful.
**Fix.** A same-pitch neutral "boop" or a rising wobble.

---

# PART B — GAME-SCOPED

> Items marked **[blocked by …]** must not be started until the named shared item lands.

## B1. Sliding Puzzle — `src/games/sliding-puzzle/`

**B1.1 blocker — Arrow keys drive the hidden board while the celebration dialog is up.**
Files: `SlidingPuzzle.tsx:210-241`. Reported by: sliding-puzzle F2, accessibility F10.
The window-level **capture-phase** `keydown` bails only for `INPUT`/`TEXTAREA`/`SELECT`/
`contentEditable` and calls `preventDefault()` + `stopPropagation()` on every arrow. `GameShell` marks
the play area `inert` + `aria-hidden`, which stops pointer and focus but does nothing to a window
listener. Captured: with focus on the celebration `<h3>`, ArrowRight/Left/Up moved tiles
(`moves 0→1→2→3`) and re-solved the board, silently. A keyboard or switch user in the modal has their
arrow keys swallowed by a hidden game.
**Fix:** `if (isCelebrating()) return;` at the top of `onKey` — `isCelebrating()` is already exported
from `src/three/store.ts:145`. Additionally bail when the play-area node carries `inert`. Re-test by
tabbing into the celebration and pressing arrows: focus must move within the modal and `engine.moves`
must not change.

**B1.2 major — The tile relief is not extruded; it is a coplanar cutout.**
Files: `relief.ts`, `scene.tsx:507-526`. Reported by: brand F2 (measured at 2.5× zoom).
§6.1 requires "actual extruded 3D scene elements on each tile face … not a flat texture of a drawing".
At 2.5× the peach star, red flower, eyes, mouth, coral headband, coat and chest V are **coplanar
cutouts with hard aliased silhouettes, no thickness, no bevel, no self-shadow and no cast shadow onto
the tile**; only the headlamp ring shows extrusion, and at shipped scale it is sub-pixel.
**Fix:** give every relief element ≥ 0.06 u of real extrusion with a 0.02 u bevel so each casts onto
the tile face under the key. Re-shoot at 3×3 and verify the cast shadows are present.

**B1.3 major — Up to 15 bevelled relief geometries are built synchronously inside a React render, on every deal.**
Files: `scene.tsx:507-526` (`buildRelief` inside the `tiles` `useMemo`, keyed on
`[dealId, scene, size, count, bevelSteps]`). Reported by: sliding-puzzle F3.
Fires on scene entry, on every "Next picture", and on every difficulty change. The only measurement
that exists is 2×2 (3 geometries → **6.8 ms worst entry frame, the worst of all nine games**); 4×4 is
5× the work, mid-session, in a render phase.
**Fix:** cache the relief geometries by `(sceneIdx, size, bevelSteps)` so returning to a seen scene
costs nothing, and build them off the render path (once per scene at 4×4 resolution and slice per
tile, or amortise behind the existing 1 s `FINISH_DELAY`). Then capture `markSceneEnter` and a
mid-session `nextPicture()` at 4×4 on `?tier=low` and show worst frame < 16.6 ms.

**B1.4 major — The empty well is off-palette chocolate brown.**
Files: `scene.tsx:441-447` and its material. Reported by: brand F2 (measured `#90543c`, dE 6.7 from the
nearest token; `#783c24`/`#6c3018` in the seams; 3.4 % of the play area).
The game also has **zero pixels above C\* 18** — it has no accent identity at all despite being
declared `mauve` in `src/games/index.ts`.
**Fix:** re-tone the well to `mauve.soft` / `NEUTRAL.well #e3dccd` at reduced exposure so it reads as
the tray in shadow, and give the game a real mauve presence in the tray furniture.

**B1.5 major — Phone camera solve lets the HUD cover the reference plaque.** [blocked by A12]
Files: `SlidingPuzzle.tsx:69-74` (`cameraFor` reads `--chrome-h`). Reported by: sliding-puzzle F6.
**Fix:** after A12, add a minimum top margin so the plaque top can never enter the chrome band.
Re-shoot at 390×844 and 360×640.

**B1.6 minor — `reset()` seeds `bestPlaced` from the scrambled board.**
Files: `engine.ts:172`. Reported by: sliding-puzzle F8.
`sliding-puzzle-composite.png` shows **★134 at `Moves: 0`, `0:00`**. At 2×2, `per = round(200/3) = 67`,
so a scramble with 2 tiles already home banks 134/200 before the child touches anything — the chip
barely moves during the run, defeating the reason `liveProgress` exists, and two children get
different starting scores for the same effort.
**Fix:** seed `bestPlaced = 0` and price `liveProgress` on pieces placed *since the deal*, or subtract
the deal-time `placed` count from both terms.

**B1.7 minor — `plaqueMat` is keyed on derived data, so the material cache grows per distinct picture.**
Files: `scene.tsx:494-500` with `src/three/materials.ts:699`. Reported by: sliding-puzzle F9.
Bounded at 5 by the scene count today, but the key is a hex lerped from `bgSample(scene.bg, 0)` — the
shape of key that stops being bounded the moment someone adds a scene.
**Fix:** key on `sceneIdx`. After A1 lands, confirm it is evicted with the scene.

## B2. Maze Escape — `src/games/maze-escape/`

**B2.1 blocker — The wall bump is imperceptible: 5 px of push and 13 % squash over ~90 ms.**
Files: `scene.tsx:330-331` (`hSquash.impulse(-4)`, `push.impulse(cell * 2.4)`), `:261`
(`push: Spring(0, 420, 18)`). Reported by: maze-escape F1 (model + independent frame measurement).
`cell = 3.8/9 = 0.422`, so the damped impulse peak is **0.0319 units = 5.0 screen px** at 158 px/unit.
Confirmed across 11 frames of `sheet-maze-escape-wall-bump.png`: silhouette stays a round dome,
centroid moves 602.5 → 598.5 px. `hSquash` peaks at 13.3 % against `squashFor`'s own 0.28 limit. This
is the interaction a child performs most in a maze, and §6.2 names basket/wall squash as a defining
feature.
**Fix:** soften to `Spring(0, 260, 15)` and raise `BUMP_PUSH` to ~10 for a ~0.25-cell (≈40 px)
nudge-and-rebound; raise `BUMP_SQUASH` to ≈ −8.5 so `hSquash` peaks near the 0.28 clamp; add a
50–80 ms wind-up dip before the push per §4. Verify by re-running the rim-tracking measurement over 30
frames at 1-frame spacing, not by eye.

**B2.2 blocker — Wall-top plateaus are uniform albedo across ~45 % of the play area.** [blocked by A9]
Files: `build.ts:607` (consumes `clayGum`), `build.ts:178-179` (concedes curvature AO is zero on a flat
plateau), `src/three/materials.ts:940-957`. Reported by: maze-escape F2 (measured ±2/255 over 70 px; a
3.2× contrast boost reveals no grain, no curvature darkening, no edge wear).
**Fix:** after A9's triplanar/world-scaled grain, additionally **displace the plateau geometry** with
shallow thumb-press undulation at ~0.3-cell wavelength and 0.005–0.01 units so `bakeCurvatureAO` has
real curvature to bite on.

**B2.3 major — The hero reads as a skull at the gameplay camera.** [blocked by A19]
Files: `props.ts:214` (claims "art-directed eyes with catchlights"), `:234` (claims the mouth is
`CLAY.crevice`, "never black"), `layout.ts:178` (`ELEVATION = 60°`). Reported by: maze-escape F3.
At ~40 × 60 px in a 1500 px frame the pupils are solid black discs with no catchlight and the mouth
interior samples `(143,103,75)` — muddy brown. Both claims are true in the celebration frame, where
the same character is genuinely charming, and neither survives the 60°-elevation camera looking into
the mouth at a grazing angle. A dark-brown open mouth is the wrong signal in a dental game; borders on
§1's "no scary faces".
**Fix:** after A19 restores the catchlight, size it in screen space (like `HitTarget`'s `minScreenPx`)
so it holds at play scale; re-tone the mouth interior to warm gum pink rather than `CLAY.crevice`; add
a fill/bounce term so the cavity is not shaded to brown mud at 60°.

**B2.4 major — The camera solve has 1.9 % margin at phone aspect and hard-floors the aspect at 0.4.**
Files: `layout.ts:238-241` — `raw > MAX_DISTANCE ? MAX_DISTANCE : raw` silently discards the distance
the solve just computed, and `Math.max(0.4, aspect)` stops the solve responding below 0.4.
Reported by: maze-escape F4 (numeric evaluation of `cameraFor`: 0.50 → 0 % cropped, **0.462 → 1.9 %**,
0.45 → 4.5 %, 0.42 → 10.9 %, ≤ 0.40 → 15.1 %). The file's own header admits it lands at 15.7 of an
allowed 16 on desktop. §2 forbids exactly this.
**Fix:** when `raw > MAX_DISTANCE`, widen `fov` toward §2's 32 ceiling before clamping; if that still
does not contain the board, scale the board group by `MAX_DISTANCE / raw` instead of cropping. Delete
the 0.4 floor and let the solve run.
*Note:* the observed ~65 % cropping in `maze-escape-phone-composite.png` is **not** used as evidence
here — see DROPPED #4. This item stands on the arithmetic alone and needs a real-device re-shoot.

**B2.5 minor — Stale comment.** `engine.ts:64-74` computes "an effective target of 1 + 2 × 0.28 cells"
while the constant two lines below is `SNAP_RADIUS = 0.78`. The constant is correct.
**Fix:** correct the comment to 0.78.

## B3. Tooth Match — `src/games/tooth-match/`

**B3.1 blocker — The eight motifs are not identifiable as the objects they name, and the "star" is the card-back pattern.**
Files: `motifs.ts:131` (`starShape = lobedShape(5, 0.105, 0.222, 64)`), `:233-235` (brush), `:238`
(paste), `:259-266` (floss), plus `emblemShape = lobedShape(6, 0.215, 0.3, 48)` on every card back.
Reported by: tooth-match F1.
The cosine radius makes the "star" a **five-petal flower**, silhouette-identical in family to the
**six-petal flower** printed on every face-down card, in the same peach hue. In a memory game the thing
you are asked to match looks like the wallpaper on the cards you have not turned over. `paste` is a
rounded red slab plus an ivory cylinder (reads as a jam jar); `brush` is two bars; `floss` is a box
plus a ring. The file's own header concedes colour cannot separate the motifs (typical 1.2:1) and puts
all identity on shape.
**Fix:** rebuild the identifying silhouettes, not the colours. Star: real rounded-tipped points at
`rMax/rMin ≥ 3` with a narrow waist (not cosine lobes). Paste: crimped tail, tapered body, conical
nozzle. Brush: splayed bristle block, waisted handle. Floss: lid seam and a pulled thread. Then
re-shoot a Hard board and require that no two of the eight share a silhouette family at 60 px.

**B3.2 blocker — 30 % of every relief hangs off the far edge of its own card.**
Files: `layout.ts:190` (`MOTIF_SCALE = 1.42`), `:327` (`RELIEF_H = 0.48`). Reported by: tooth-match F2.
`0.48 × 1.42 = 0.68` units of vertical relief on a 1.16-unit card at a 42° camera: screen-up extent
`0.68·cos42° = 0.505` against the card half-length's `0.58·sin42° = 0.388`. The relief's base is
occluded by the card body, so it reads as a die-cut shape hovering above an empty panel.
**Fix:** drop `MOTIF_SCALE` to ≈ 0.95 so `H·cos E ≤ CARD_H/2·sin E`, **or** recline every motif toward
the camera the way `star` already is so height converts to card-plane footprint. Re-measure against
`RELIEF_TOP` in `cameraFor` afterwards.

**B3.3 blocker — On a portrait phone the camera solve gives up and pushes cards and focus rings off-screen.**
Files: `layout.ts:301` (`FOV_MAX`), `:415-460` (the solve). Reported by: tooth-match F3.
Numerically, at a 354 × 760 play area with 215 px of chrome: Easy fits (0.796 NDC), but **Medium
reaches 1.057 and Hard 1.094** — the outermost card's own edge is 6–10 % outside the frame — and its
**focus ring reaches 1.213 / 1.256**, 21–26 % outside. Medium is the default for age ≥ 8. The file's
comment already concedes this and ships it. A focus ring a quarter off-screen is also an §8 failure.
**Fix:** the grid is fixed by the rules, so the board must shrink, not the lens: allow `MAX_DISTANCE`
to be exceeded below ~0.7 aspect, or scale the whole board group by `1/over` when the distance clamp
binds. Add `reachNDC > 1` as an assert in the solve and a selftest case at 390×844 for all three
levels.

**B3.4 major — The printed inlay's bevel is 0.0162, under §3's 0.02 floor.** [blocked by A20]
Files: `layout.ts:129` (`INLAY_T = 0.036`). Reported by: tooth-match F4.
Renders as a straight dark seam with an ivory sliver across the bottom of every face-up card.
**Fix:** raise `INLAY_T` to ≥ 0.045 so `t*0.45 ≥ 0.02` (re-check the
`MAT_T + FRONT_PROUD − EMBLEM_PROUD − PRESS_DROP` budget), after A20 makes `roundedPlate` refuse the
under-spec case rather than silently shipping it.

**B3.5 minor — Wind-up is 104 ms against §4's 50–80 ms.**
Files: `src/three/anim.ts:42` (`anticipate` spends its first 28 % on the dip) as used with
`FLIP_DIP_END = 0.26` of `FLIP_DUR = 0.4 s`. Mitigated (the press squash fires on pointerdown so the
first visible move is toward the finger) but outside the band.
**Fix:** shorten `FLIP_DUR` to ~0.3 s (dip 78 ms) or drop the dip window to 0.18.

**B3.6 minor — Card colliders are 0.99 units across on a 1.05-unit pitch.**
Files: `scene.tsx` `HitTarget radius={CARD_W * 0.55}`. A 3 % clear gap before `minScreenPx: 48` growth;
on a small viewport neighbouring colliders overlap and the nearer card wins the raycast.
**Fix:** clamp the collider to ≤ 0.48 × pitch in either axis, and add a tooth-match case to the
`hit-targets` selftest (the passing run was captured with Count the Teeth mounted).

## B4. Healthy or Not? — `src/games/healthy-or-not/`

**B4.1 blocker — Two of the three tap targets sit inert for 320 ms after being touched.**
Files: `scene.tsx:1584`, `:1593`, `:1602` (all three `HitTarget`s pass **only `onSelect`** — no
`onPress`, no `onRelease`, and none wraps the prop as a child); `scene.tsx:1122-1125` (tooth chomp
scheduled at `oops + WINDUP_DUR + EAT_FLIGHT − CHOMP_LEAD` = **320 ms**), `:1127-1130` (bin lid at
`0.1 + 0.46 − 0.24` = **320 ms**). Reported by: healthy-or-not rubric 3.
§4 requires a visible response within one frame and a 0.94 press-down in ~90 ms.
`tooth-match/scene.tsx:1109-1110`, `count-the-teeth/scene.tsx:1501-1502` and
`smile-maker/scene.tsx:1918` all implement press; this game is the only one that does not.
**Fix:** add `onPress` / `onRelease` to all three targets — a `Spring` press-sink on the food, a 0.96
squash + nod on the tooth, a lid-press on the bin — and fire the receiver's **anticipation** (the
lid's `LID_ANTICIPATE` dip, the jaw's pre-open) on pointerdown rather than at the scheduled lead.

**B4.2 blocker — The mascot's mouth: bead-chain smile, AO-tint lip, flat crimson cavity.**
Files: `props.ts:493-537` (lip beads), `:569`, `:574-575` (lip and cavity painted `CLAY.crevice`
`#8a6a58`), `:576` (tongue `clayAccent("rose","main")` `#cf4a55`), `layout.ts:91` (claims the worst
scallop at 5 segments is "0.0006 units — invisible"). Reported by: healthy-or-not F3, brand §1.2.
Three defects in the hero character's face, which is the payoff of every correct answer: (1) the
resting smile renders as **five countable capsules with dark joints** — the most legible feature on
the face after the eyes, so the "invisible scallop" claim is false as rendered; (2) `CLAY.crevice` is
`tokens.ts:51`'s AO tint, not one of the five accent families, and on an ivory tooth a brown mouth
line reads as **stain**; (3) the open mouth is a flat, hard-edged saturated ellipse filling the cavity
with essentially no shading gradient and a crisp boundary against the brown interior.
**Fix:** build the lip as one swept tube along the crown circle (or raise `LIP_SEGMENTS` until the
scallop is genuinely sub-pixel **and verify it in a render**); repalette the lip to `mauve.deep` or
`coral.deep`; give the cavity a real interior — darker at the back, a soft-edged tongue that shades
with the form and does not fill the opening.

**B4.3 major — The bin does not read as a bin, and shares its token with the food.**
Files: `props.ts:640` (turntable rim) and `:644-647` (bin body) both assign
`clayAccent("peach","main")`; `layout.ts:222` argues "a bin says what it is by being a bin".
Reported by: healthy-or-not F5. Measured: bin `#e48f42`, rim `#ee974e`, cheese `#f29d57`. A
straight-sided drum with a fitted lid and an ivory knob, no flap, no pedal, no liner, no taper, no
visible opening at rest — a four-year-old reads a cookie jar. And when the round's food is cheese,
carrot, cupcake or donut, the thing being judged and one of the two answers are the same material
family.
**Fix:** give it bin geometry — tapered drum, visible dark liner above the rim at rest, a swing flap
or stepped pedal, a wider lid overhang — and move it off `peach` onto `mauve` so the "no" target is
chromatically separate from both the food and the turntable furniture. De-saturate the turntable rim
so the eye goes to the food.

**B4.4 major — §6.4 direction not followed: wave-off replaced with a rubbish bin.**
Files: `scene.tsx:24-26` (documents the substitution openly), `layout.ts:217-225`.
Reported by: healthy-or-not F6. §6.4 says a sugary food is "gently waved off and arcs away with a
comic tumble". "Put the food in the bin" carries a different message to a child.
**Fix:** this needs the §6 owner, not a code change in isolation. Either amend the spec, or replace
the bin with a directed wave-off that still lands somewhere legible (a clay "no thank you" tray the
food tumbles onto and settles in).

**B4.5 major — The food occludes the mascot's face for the whole chomp.**
Files: `layout.ts:143` — `MOUTH_Z = TOOTH_Z + (MOUTH_ZN − 0.03) × TOOTH_H` aims the food's **centre**
at the mouth surface, so a 0.41-wide prop puts half of itself between the camera and the face.
Reported by: healthy-or-not #8 (chomp-i04..i06: one eye, most of the crown and half the mouth hidden).
**Fix:** aim the flight at `MOUTH_Z − foodDepth/2` and shrink the food to ~0.3 over the last 80 ms so
it disappears *into* the mouth instead of parking on top of it.

**B4.6 major — An exploratory tap is a scored commitment.**
Files: `scene.tsx:1584-1591` (the **food itself** — the most salient object in the frame — is a
`HitTarget` firing `engine.answer("feed")`), `:1600` (the tooth fires the same). Reported by:
healthy-or-not #9. There is no way for a four-year-old to touch the new thing on the table without
answering the question.
**Fix:** make the food target a **pick-up** — first tap lifts and rotates it toward camera with a
wind-up (which also solves "read the prop"), second tap or a drag to the tooth commits. Or drop the
food target and keep the two real answers.

**B4.7 minor — Progress beads illegible; bin lid has a hard seam; no non-textual onboarding.**
Files: `props.ts:641` (`beadDone` = `clayAccent("peach","main")` — the **same token as the rim they sit
on**, ~8 px dots); the lid/rim join renders as a thin dark aliased line (§0 forbids hard edges); the
only instruction is the subtitle.
**Fix:** put the done-beads on a contrasting token and raise them off the disc so they cast their own
contact shadow; raise the lid 0.008 u off the rim at rest or chamfer the underside; add a first-round
demo or a pulse on the two answerable objects.

## B5. Spot the Difference — `src/games/spot-the-difference/`

**B5.1 blocker — `?selftest=spot` must be green.** [blocked by A6]
Files: `selftest.ts`, `scene.tsx:571-590`. The fix is A6 (shared, `materials.ts:424` is not this game's
file to edit). This game's gate: re-run the control and require zero differing pixels (or ≤ 4 isolated
1×1), plus a fresh `spot-panelA/B` pair that survives an independent region diff on non-answer props
(duck, basin, soap, window — currently 1.8–3.8 % differing).

**B5.2 major — The pictures use ~28 % of the play area.** [blocked by A21]
Files: `SpotTheDifference.tsx:168-195`, `layout.ts:301-308`. After A21, re-check
`tapScreenPx(layout.fh)`, which moves with the panel fraction, and re-run the hit-targets selftest.

**B5.3 major — The DOM panel frames stay lit through the celebration.** [related A10]
Files: `scene.tsx:523-526` (`celebrationHeroScale()` shrinks the 3D rooms), `SpotTheDifference.tsx:63-65`
(`PANEL_SHADOW`), `:180-193` (`panelStyle`).
**Fix:** drive the two panel `<div>`s' opacity/boxShadow on the same clock the world scale uses, or
simply `boxShadow: "none"` once `engine.completed` is true. One discrete state change, no per-frame
render.

**B5.4 major — The towel is the one flat prop in an otherwise good room.**
Files: `diorama.ts:460-461` (`grain: 0.22` on both towel materials — outside §3's 0.08–0.15 band) and
the towel geometry. Reported by: spot-the-difference F4. Near-uniform orange slab; the "fold" is a
separate rectangular plate on the face with a crisp four-corner silhouette and a hard dark contact
line — an appliqué decal, not folded cloth; near-square bottom corners; no curvature darkening in the
crease and no wear on the fold edge. It is one of the five answers a child stares at.
**Fix:** build the fold as continuous geometry with a real 0.02–0.04 radius at the roll and hem, bake
`bakeCurvatureAO` through the crease, round the bottom corners to ≥ 0.03, and bring grain to 0.12.

**B5.5 minor — The ring instance buffer is re-uploaded every frame for the rest of the run.**
Files: `scene.tsx:763-782` — `diorama.rings.visible` is set true on the first find and only cleared on
`deal`/`setTestMode`, so five matrices are recomposed and re-uploaded every frame thereafter. Under
reduced motion `breathe` is 1 and `open` saturates at 1, so the upload is pure waste — on the game
that can least afford GPU traffic.
**Fix:** skip the write when every active ring has `ringT >= 1` and `reduced` is true; gate the block
on a dirty flag otherwise.

**B5.6 minor — The prop labelled "Mirror" renders as an opaque red plaque.**
Files: `layout.ts:198`. A screen-reader user is told "Mirror" for something a sighted child sees as a
red board.
**Fix:** give it a `softGlass()` inset panel inside the rose frame, or rename the label to what it is.

**B5.7 minor — The game has no terminator.**
Files: `engine.ts` (no timer, no hint, `finish()` reachable only by finding every difference).
Reported by: content-safety #11. A child who cannot find the last difference plays forever and never
reaches a celebration. Not punitive, but it is the one run that can fail to end.
**Fix:** after ~45 s of no progress, shimmer the remaining difference.

## B6. Tooth Rescue — `src/games/tooth-rescue/`

**B6.1 blocker — The alcove backdrop is a flat, unlit, hard-edged brown slab at 24 % of the desktop frame and ~60 % of the phone play area.**
Files: `scene.tsx:846-849`, `:966-968` (`panelMat = clayPainted(CLAY.crevice, {…, grain: 0.16})`),
`:1428` ("Nothing in the set casts: it is a backdrop"), `:1436-1465` (`panelGeo`, `wingGeo`,
`lintelGeo`, `railGeo`, `plinthGeo`, `matGeo` — all `receiveShadow` only).
Reported by: tooth-rescue F1, performance rubric 1, brand F1, accessibility F6, content-safety B2 —
**five critics independently**.
Measured: σ **1.3/255** over a 40 × 40 patch; relative luminance **0.112** where every other surface in
the product sits at 0.68–0.80; ~3 % luminance variation over 500 px (no shading gradient at all);
one-pixel silhouette transitions at both the shelf junction (`(124,86,56) → (234,213,185)` in 1 px at
x=560) and the wing junction (`(138,129,116) → (127,88,59)` in 1 px at y=400), with **zero AO at
either** — the pixel below the seam is *brighter* than the ones below it. Razor 90° silhouette corners
at 3× zoom. Five large slabs abut with no shadow between them.
Fails §0 ("no hard edge anywhere in this product", "ambient occlusion darkens every crevice"), §3
(minimum bevel 0.02, no 90° silhouette corner) and rubric line 1 on all five sub-conditions at once.
**The contrast reasoning behind it is sound and independently verified** (a falling tooth at L 0.663
against the cream floor is 1.09:1 — genuinely invisible; against this alcove 4.46:1). Keep the
luminance separation; the execution is what fails.
**Fix:** (a) Build the alcove as a real shallow clay box — bevelled inner corners at r ≥ 0.03, a
curved cyclorama sweep instead of a flat quad, `bakeCurvatureAO` baked through, a top-to-bottom
gradient with the key's falloff, and a visible chute mouth with depth behind the rail. (b) Let the set
**cast**: give `panelGeo`/`wingGeo`/`lintelGeo`/`plinthGeo` `castShadow` and widen the ortho frustum to
include them, so every junction gains a real contact gradient; if the shadow budget will not take it,
bake per-junction darkening into vertex colours via `bakeCurvatureAO` on a merged set geometry.
(c) Re-solve the contrast inside the declared family — `coral.soft`/`rose.soft` walls with a
`coral.deep` floor gives the same separation without a sixth colour and without a muddy value across a
third of the screen. (d) Grain at 0.16 currently delivers 0.5 % at 12 units; fix via A9.

**B6.2 blocker — The basket's soft-body wobble is 3 % and reads as nothing.**
Files: `scene.tsx:1203` (`rt.wobble.impulse(0, impact / CATCH_FULL_SCALE, 0)`), `:255`
(`CATCH_FULL_SCALE = 5.5`), `src/three/physics.ts:598-604` (`SW_IMPULSE_GAIN = 0.6`,
`SW_SQUASH_LIMIT = 0.22`). Reported by: tooth-rescue F2.
Measured across all 24 frames of `tooth-rescue-catch-i00..i23`: rim top 289 → 295 → 293 → 294 — a
**6 px dip on a 185 px basket (3.2 %)** — and the rim **narrows** 285 → 282 px while it compresses, so
there is no volume-preserving bulge at any measurable level. The mechanism allows 22 %; the tuning
delivers ~3 %. §6.6 names basket wobble as one of this game's two defining features.
**Fix:** `CATCH_FULL_SCALE = 5.5` divides a landing speed the solver has already deadened to ~0.5
before `SW_IMPULSE_GAIN` halves it again. Target a peak of 10–14 % squash (rim dip ~20 px, width bulge
~8 px) and verify by re-running the rim-tracking measurement.

**B6.3 blocker — Falling teeth do not tumble; the authored sway overwrites the rigid body.**
Files: `scene.tsx:1303-1310` (`b.quaternion.setFromEuler(...)` replaces the simulated orientation every
frame), `:245-248` (`SWAY_TILT ±0.17 rad`, `SWAY_RATE 2.4 rad/s`). Reported by: tooth-rescue F3.
§6.6 requires "gravity, restitution, **angular tumble**". The physics is running and its result is
thrown away for the one object class the game is about; candy tumbles (`SPIN_CANDY = 4.6`), the tooth
rocks ±10°. The stated reason ("a tooth has a face") is legitimate art direction and the wrong
solution.
**Fix:** let the body tumble and orient the **face** instead — damp angular velocity toward a
face-forward rest as the tooth nears the basket (the code already does this on ground impact,
`scene.tsx:1236`), or blend simulated spin into the authored sway over the last 0.3 s. A tooth that
rotates 60–120° on the way down and snaps face-on as it lands gives you both.

**B6.4 major — The start gate swallows the first press and teaches nothing without reading.**
Files: `ToothRescue.tsx:234-245` — a full-field `<button onClick>` at `z-[2]` over the slider pad at
`z-[1]`. `onClick` fires on pointer-**up**, so the entire first press (down, drag, up) is consumed and
never reaches `aimAt`; a child who taps and immediately drags gets a basket that ignores their finger.
The rest frame's only affordances are two lines of English.
**Fix:** replace the DOM gate with an in-world invitation — a tooth already resting on the rail that
wobbles and drops on first contact, and a basket that presses to 0.94 and pops back on `pointerdown`
(§4 requires a response within one frame; there is currently none). Move `begin()` and `aimAt()` to
`onPointerDown` on the pad and delete the overlay button.

**B6.5 major — Phone HUD chips sit on and clip the drop-rail.** [blocked by A12]
Files: `solveFraming` in `layout.ts`. Measured at 390×844: chips at y≈254–297, rail at y≈256–269; the
rail is visible in only 37 of 70 sampled columns. "Tap to start" also overlaps the basket rim.
**Fix:** `solveFraming` already derives everything from the measured rect — after A12, have it derive
the **safe** rect too: subtract the HUD band from the vertical extent it frames against and drop the
rail below it. Verify at 0.462 aspect, not just desktop.

**B6.6 major — `featureScale: 1.6` pushes the cheeks outside the head silhouette and floats the mouth.** [blocked by A19]
Files: `mascot.ts:82`, header claim at `:68-73` (checks only the eye and declares the whole face clear).
**Fix:** after A19 scales the anchors, re-verify at `k = 1.6`; if the cheek still breaks the crown,
drop `featureScale` to the largest value that keeps it inside (≈1.3) and recover the read by enlarging
the eyes alone.

**B6.7 minor — Every spawn announces, every 0.7–1.55 s.**
Files: `ToothRescue.tsx:265-287` (the code calls this "chatter" itself). Over a 30 s Hard run that is
~40 polite live-region updates competing with catch and bounce announcements in the same queue.
**Fix:** announce only when the drop's zone differs from the basket's current zone, or coalesce to one
update per 1.5 s naming the nearest unhandled drop.

**B6.8 minor — Eye catchlights are omitted from the mascot pool.**
Files: `mascot.ts:53` (`OMIT` drops `glint-l` / `glint-r`). Darkest eye pixel `(26,23,19)` with a broad
top sheen and no dot. Defensible against §0's "never a tight white specular dot", and the triangle
argument is sound, but the result is a doll-eyed mascot.
**Fix:** bake a two-vertex-coloured highlight cap into the eye sphere at merge time — no extra draw, no
extra material, and it can be a soft ivory smudge rather than a hard dot.

## B7. Count the Teeth — `src/games/count-the-teeth/`

**B7.1 blocker — `TOOTH_SILHOUETTE.vMin` is stale, which voids the §6.7 countability guarantee and logs an error on every mount.**
Files: `layout.ts:182` (`vMin: 0`), `:169-170` (the comment asserting it), `:298-299` (the guard),
`verify.ts:316-317` (`return fail(complaint)` — the render-from-game-camera occlusion pass at
`verify.ts:366+` is **unreachable**), `scene.tsx:695` (`console.error` on every mount).
Reported by: count-the-teeth F1, content-safety B3, accessibility F5.
Verified: `count-the-teeth-console.txt` — `{"total":1,"errors":1}`, message
*`toothGeometry("baby") has changed shape — layout.ts TOOTH_SILHOUETTE is stale: vMin -0.0205 vs 0`* —
the **only** error produced anywhere in the entire audit run. The measured geometry is 0.0205 below the
plane the constant declares, which eats 17 % of the `GAP_FRACTION` clearance margin the whole
disjointness proof rests on. `?selftest=count` aborts at this guard before it ever renders the ID pass,
so §6.7's "every tooth ≥ 75 % unoccluded from the game camera" is **unverified in the shipping build**.
**Fix:** re-run the sweep that produced these constants against the current `toothGeometry("baby")` +
`buildFace()` at `FACE_SCALE`, write the new six numbers, then re-run `?selftest=count` and prove the
occlusion pass actually passes — including forcing round 2's failing seed 51980671 from inside the
module (`solveScatter` is not reachable from outside), with per-tooth unoccluded percentages printed.
**Do not widen `SILHOUETTE_TOLERANCE` to silence it.**

**B7.2 blocker — The counted mascots read as skulls.** [blocked by A19]
Files: `scene.tsx:292-306` (`featureMatrix` scales radii by `k = FACE_SCALE = 1.3` but passes anchors
unscaled), `:350-359`, `:363-376` (cheeks). Reported by: count-the-teeth F2 + F8 + §1, content-safety.
See A19 for the arithmetic. Visible in `crops/eyes.png`, `crops/pips.png`, `crops/rimtooth.png` and all
18 frames of `sheet-count-the-teeth-correct.png`; `count-the-teeth-hard-count14-composite.png` is a
4×4 grid of fourteen of them on a blood-orange tray.
**Fix:** after A19, verify at Hard/14 where a tooth is ~60 px tall, and check the read against the
celebration hero in `count-the-teeth-celebration-composite.png`, which is already right.

**B7.3 blocker — Per-round numeral textures leak for the life of the session.** [blocked by A2]
Files: `scene.tsx:947` (`textTexture(String(value), …)` for each of three answer numerals, every
round), `:857-859` (this game's `DisposalBag` holds exactly one object, `sparkleMat`).
Hard draws numerals up to 16, so the cache grows with distinct numbers seen. Measured: hub textures 3 →
9 (loop 1) → 11 (loop 2), every loop-2 increment from this game.
**Fix:** after A2 registers the text cache, additionally either bag the three per-round textures here
and release them on round change, or pre-render the full reachable numeral set once at mount so the
count is constant. Re-run the two-loop endurance and show textures returning to 3.

**B7.4 blocker — The phone layout clips the game's own subject matter and the HUD collides with itself.** [blocked by A12]
Files: `layout.ts` `cameraFor` / `boardFor`. Reported by: count-the-teeth F4, content-safety B3,
brand F8.
At a true 390×844 (aspect 0.462): the mat is clipped left and right, **a tooth is bisected by the right
screen edge**, both outer answer tiles are clipped (so their `minScreenPx={48}` colliders extend
off-screen), and the chip row is drawn on top of the level pill row hiding "Hard". A child counts what
they can see, taps 4, and gets `sounds.oops()` — the game is wrong and the child is told they are.
**Fix:** solve the horizontal fit at the measured aspect the way the celebration camera already does
(`?selftest=celebration-framing` passes at aspect 0.48 while the board framing does not — the
machinery exists). Extend `?selftest=count` to assert that every tooth's NDC box and every tile's
collider lie inside the visible frame at 0.46 as well as at 1.83, and that no tooth silhouette
intersects the HUD chip rects.

**B7.5 major — Teeth are drawn standing on the rim and on top of the round-progress pips.**
Files: `layout.ts:591` (`clampZ = padD/2 - footprint - 0.02` clamps the *footprint*, not the projected
silhouette), pip rail at `matBackZ + MAT_MARGIN + PIP_R + 0.06`. Reported by: count-the-teeth F5.
At `ELEVATION = 52°` a tooth at the pad's back edge projects its 0.79-unit body up-screen across the
rim and the pip rail. `crops/pips.png` shows two of five pips covered by heads and a third tooth
entirely off the pad, overhanging the mat's outer edge into the page. Happens on **every** desktop
capture at every level, in a game about counting objects on a surface.
**Fix:** pull `clampZ` in by the tooth's projected screen height, or move/inset the pip rail. Add an
assertion to `?selftest=count` that no tooth's NDC box intersects any pip's.

**B7.6 major — The contact shadow ignores the idle bob, so teeth float over a frozen shadow.**
Files: `scene.tsx:1236-1237` (`bob = sin(elapsed*1.05 + seed) * 0.022`), `:1240`
(`const lift = drop + hop.value` — **excludes `bob`**), `:1265` (`contact` derived from that `lift`).
Reported by: count-the-teeth F6. A 1.05 Hz, ~3.4 px hover running 95 % of the time a child is looking
at the board, over a shadow pinned at full-contact size.
**Fix:** include `bob` in the term the contact darkening reads, and consider replacing the pure-sine
idle with a low-amplitude sway about the root contact — §4 wants nothing that floats.

**B7.7 major — `PAD_PROUD = 0.018` is below the minimum bevel radius, so the largest surface in the frame is a sticker.**
Files: `layout.ts:482`. Reported by: count-the-teeth F7, brand.
The coral pad stands 0.018 u proud of the mat — **less than §3's 0.02 minimum bevel** — so the geometry
physically cannot roll at that edge. Measured: rim → pad transitions in **3 pixels** with no darkening
on either side; the pad interior is RGB(228,83,51) ± 3 across ~400 px. There is no crevice anywhere in
this scene for curvature-AO to darken because there is no crevice in the model.
**Fix:** recess the coral field into the mat as a real well at ≥ 0.06 u so there is a crevice to
darken and a rim to cast onto the pad; give the pad's top face a shallow dish or hand-pressed height
variation so it is not a mathematically constant plane. (Complements A7 and A9.)

**B7.8 minor — Five of seven springs are outside §4's 260–420 / 18–28 band.**
Files: `scene.tsx:437-464` — `hop (240, 12)`, `wobble (320, 8)`, `pip (300, 13)`, `lift (300, 15)`,
`squash (380, 17)` all below damping 18; `hop` also below stiffness 260; `press (430, 26)` above the
ceiling.
**Fix:** bring them into band, or amend §4 if the band is genuinely wrong for a hop and defend it.

**B7.9 minor — A grey shading smudge crosses every tooth's forehead.**
Consistent across `crops/eyes.png`, `crops/pips.png`, `crops/rimtooth.png` — a normal seam or
curvature-AO band at the `softSphere` pole. On fourteen teeth it makes the board look dirty.
**Fix:** check `finish()`'s smooth-normal handling and the `bakeCurvatureAO` result at the crown pole
of `toothGeometry("baby")`.

**B7.10 minor — The pad renders `#e45333` from a `coral.main` token of `#e8604c`.**
Not a token violation (it comes from the factory), but the frame's dominant hue — ~30 % of the pixels —
is noticeably hotter and more saturated than the brand coral.
**Fix:** white-balance the pad albedo against a measured render the way `clayGround` already does with
`GROUND_WHITE_BALANCE`.

## B8. Tooth Runner — `src/games/tooth-runner/`

**B8.1 blocker — The near-arch pool is placed straight through the title band in every framing.**
Files: `props.ts:480-483` (`torusSoft(1, 0.09, 3)`, `n: 4`), `layout.ts:236` (`cameraFor` protects only
the hero's clear band). Reported by: tooth-runner F1, brand F4, accessibility F7 — all measured.
Contrast of `#2F3237` ink on arch pixels: **2.42:1 and 2.12:1** against the 4.5:1 a 17 px subtitle
requires and the 3:1 a 38 px phone H1 requires; the a11y critic measured ink-mid on arch brown at
**1.20:1** in the reduced composite, where the words "the brushes" vanish entirely. Present in
`-composite`, `-reduced-composite`, `-tier-low-composite` and `-phone-composite`. The near arch is also
hard-clipped by the view's top edge at y≈93, so it reads as broken geometry.
**Fix:** give the arch pool the same treatment the finale sweep already gives near scenery — a
`clearY`/`clearZ` exclusion derived from the camera's projected chrome band, so no arch may occupy the
top `chrome` fraction of the frame. `cameraFor` already receives `--chrome-h`; project it into world
space and cull or scale down arches whose crown enters it. **Do not solve this by darkening the text.**

**B8.2 blocker — Grab-items and jump-items share one colour family, so the game's verb is unreadable.**
Files: `engine.ts:86-87` (`GOODIES = [KIND_BRUSH, KIND_STAR]`, `SWEETS = [KIND_CANDY, KIND_SODA,
KIND_DONUT]`), `props.ts:208` (brush head `red`), `:217` (star `red`), `:226` (candy `rose`), `:239`
(donut icing `rose`), `:259` (soda cup `coral`), `engine.ts:490` (`high = goodie && Math.random() < 0.6`
— 40 % of goodies spawn on the ground). Reported by: tooth-runner F2.
Every item in the game, grab and jump alike, is warm red. There is no colour, shape or position
language separating them; the only cue is height, and 40 % of goodies forfeit it.
`tooth-runner-jump-i04.png` shows the consequence: a large red lobed shape on the ground that the tooth
jumps — that is the **star**, a thing to collect, and `starShape(0.28, 0.135)` with `bevel: 0.03` has
rounded its points into a flower. The comment at `props.ts:216` ("a peach star on a peach roadside is
invisible") solved visibility against the background by colliding with the sweets.
**Fix:** move all three sweets out of red into one non-accent family with one shared silhouette rule
(low, wide, wrapped); make both goodies one distinct family — ivory + a bright ring/halo, spinning,
always haloed. Make the star actually a star: drop `bevel` to 0.012 or widen the inner radius. And
**spawn one sweet and one brush in the lane on the start screen** so the child sees both verbs before
they tap — the start frame is currently an empty lane.

**B8.3 blocker — Requested contact blobs on mid/far scenery render as nothing.** [related A7]
Files: `props.ts:545-565` (`hill-near` `blob: 0.95`, `hill-far` `blob: 0.9`), `scene.tsx:778`
(`writeBlob`), `scene.tsx:244` (`MAX_BLOBS = 48`), `FOG_DENSITY 0.014`. Reported by: tooth-runner F3.
At 4× contrast the ground around every mid/far prop is uniform white with a razor elliptical terminator
at the base — not a single value step. The hills are pasted onto a flat cream field.
**Fix:** verify `writeBlob` actually reaches these pools (29 scenery + up to 12 items + hero = 42
against a cap of 48 — close), and make `blobMat` fog-exempt or fog at a much lower rate: a contact
shadow is a **hole in the light**, not an object, so a blob 30–60 units out must not be washed away.

**B8.4 major — The hero's cast shadow is a detached decal.** [blocked by A8]
Files: `layout.ts:265` (`SHADOW_AREA = 14`). See A8 for the shared mapping fix; re-verify against this
game's ortho depth range and confirm the contact end resolves at ~6 px rather than the measured ~40 px.

**B8.5 major — All mid/far scenery is constant-curvature primitives with uniform albedo.** [blocked by A9]
Files: `props.ts:545-700` (hills, ridges, leaves, arches — spheres, cones, tori). After A9's
world-scaled/triplanar grain, additionally **displace the hill and ridge geometry with low-frequency
noise before baking AO** so curvature actually varies.

**B8.6 major — Items pass between the lens and the hero and occlude the landing for five frames.**
Files: `layout.ts` `DESPAWN_Z = 6.5`, `scene.tsx:686` (item loop). Reported by: tooth-runner F6.
`crop/tr-land.png` (i22–i26): a red soda cup covers the entire landing — the single beat that carries
all the weight in this game.
**Fix:** items already have the machinery — give the item pool the same `clearZ`/`clearFade`
ground-anchored taper the scenery pools use, at a `clearZ` that puts the near cut **behind** the hero,
and lower `DESPAWN_Z` accordingly.

**B8.7 minor — `open: 0.55` renders a dark brown filled ellipsoid across the front of a tooth.**
Files: `scene.tsx:472` (`mascotParts({ … open: 0.55 })`), `src/three/geometry.ts:1426-1427`. In a
paediatric **dental** product a large `CLAY.crevice` patch on a tooth reads as decay at a glance. The
tongue sits at `y 0.668` against a mouth at `y 0.7`, so in profile it clips to a red sliver at the
lower corner.
**Fix:** drop `open` to ~0.3, or render the mouth as a thin crescent recess rather than a filled
ellipsoid, and lift `tongue.y` so it is centred inside the aperture at every open value.

**B8.8 minor — The arch shows a faceted silhouette and a dark normal seam.**
Files: `props.ts:481` (`torusSoft(1, 0.09, 3)`). It is the largest surface in every frame.
**Fix:** raise the radial detail one LOD step on mid/high tier and check the torus builder's seam
vertex duplication.

## B9. Smile Maker — `src/games/smile-maker/`

**B9.1 blocker — Every top-anchor prop is jammed through the head at rest, and the polaroid keepsake records it.**
Files: `build.ts:397` (the `top` anchor sinks the prop 0.09 below the crown apex on the stated theory
that every `top` prop is "authored wide enough to swallow a 0.40-unit radius at its own y = 0"),
`:525-545` (party hat lathe profile **starts at `[0, 0]`** — a solid cone with a closed bottom cap, no
cavity), `:505-519` (fedora dome, same), `scene.tsx:215` (`LANDING_R2 = 0.45 * 0.45` exempts the last
0.45 u of the descent from the clearance test). Reported by: smile-maker F1.
The flight path was carefully fixed after round 2 to arc over the head; **the resting pose was never
checked at all.** The cone is buried in the skull, no brim is visible, the peach torus emerges through
the front of the forehead as a hard-edged orange sliver, and `pose: { roll: -0.14 }` digs one side in
further.
**Fix:** open the top props — start the lathe profile at the brim radius, not at the axis, so the hat
is a shell. Then add a **resting-pose clearance assert**: for each `top` prop, sample the crown
iso-surface against the prop's geometry at the final anchor transform (including `pose.roll`) and fail
the build if any head vertex lies outside the prop's interior sweep. Same test the flight arc already
has, run at `t = 1`.

**B9.2 blocker — `onSurface` has no up-vector: the mascot's brows roll into a scowl and the catchlights land on bare enamel.**
Files: `build.ts:310-329` (`_quat.setFromUnitVectors(UNIT_Z, hit.normal)` — the minimal-arc rotation,
which leaves roll about the normal **completely uncontrolled**), `:790` (brow/lid scaled 1.25 × 0.42),
`:805` (blush 1 × 0.62), `:823` (smile beads), `:792` (eye at azimuth `side * 0.42`, elevation dir
y 0.03), `:795-797` (spark probed at azimuth `side * 0.3`, elevation dir y 0.16). Reported by:
smile-maker F2.
Every anisotropic face feature inherits an accidental roll: **both eyebrows slope down toward the
centre**, so the resting expression of the mascot in a children's dental app is a **scowl** — not
authored, it fell out of the quaternion. §1 forbids scary faces. Separately, the "catchlight" is probed
0.12 rad inboard and well above the eye, so it lands on bare enamel between and above the eyes in every
frame at every zoom — two white specks that read as blemishes.
**Fix:** give `onSurface` an explicit up hint and build the basis as `right = up × normal`,
`up' = normal × right`, so a brow authored horizontal stays horizontal; then author the brows with a
deliberate upward-outward tilt. Move the spark probe to the eye's own azimuth `a` with a small enough
elevation offset that it lands on the eye sphere — better, make it a **child of the eye transform**
rather than probing the head at all.

**B9.3 blocker — Union seams ship hard and unoccluded, plus z-fighting on the crown and a 0.005 bevel on the party hat.**
Files: `build.ts:500-720` (every accessory is a union of independent primitive meshes), `:530-539`
(party hat base bevel `[0,0] → [0.42, 0.005]` — **four times under §3's 0.02**), `:558-570` (crown lathe
profile opens and closes on the same point `[0.44, 0]`); mechanism at `src/three/geometry.ts:564`
(`bakeCurvatureAO` runs **per geometry** inside `finish()`). Reported by: smile-maker F3.
No piece knows another piece is touching it, so every seam ships with zero occlusion and zero fillet:
the crown's five cones cut the band with no fillet, three berries jam through it with a hard
intersection ring, the band is uniform flat orange with no curvature darkening/grain/wear/subsurface,
and a dashed dark speckle runs the band's right rim from the coincident lathe endpoints surviving
`mergeVertices`/`dropDegenerate`. Direct §0 violation.
**Fix:** merge each prop's pieces into one `BufferGeometry` **before** `finish()` so `bakeCurvatureAO`
sees the union and darkens the seams (or add an explicit seam-fillet pass). Open the crown's lathe
profile so first and last points are not coincident. Raise the party hat's base bevel to ≥ 0.02.

**B9.4 major — On a phone the camera solve gives up and crops five of ten toys off-screen.**
Files: `layout.ts:591`, `:313-314`, `:579-582` (the "cropping the rim is better than an unsolvable
loop" branch). Reported by: smile-maker F4. At 390×844 the shelf ring is cut on both sides: crown,
party hat, balloon and fedora are gone entirely, bowtie and sunglasses halved — **five of ten
accessories invisible and untappable** — while the top ~30 % of the frame is empty cream. `fitAt`
returns NaN because the ring (`RING_OUTER = 1.49`) plus overhanging props does not fit inside the
fov-28 / 16-unit band at portrait aspect. The solve is honest; the **content layout is fixed**.
**Fix:** make the shelf layout aspect-aware. Below ~0.6 aspect, compress the ring to an ellipse
(shorter on X, deeper on Z) or split the ten slots into two shallow arcs front and back, then re-solve.
Add the 0.46 aspect case to `celebration-framing` and assert every prop's projected bbox is inside the
clear band.

**B9.5 major — Taking a photo leaves +3 programs and +4 textures resident after the scene is gone.**
Files: `scene.tsx:1563` (`capture()` renders the scene to an offscreen target under a different render
state), `:520-562` (`PhotoPool`), `:1118` (`bag.onRelease`). Reported by: smile-maker F5, performance.
Measured: this game settles at programs 13 / textures 13 in the pass where "Snap!" was pressed, versus
10 / 9 in the enter-and-leave endurance pass. Render targets **are** disposed correctly
(`renderTargets: 0`), so the leak is in what the offscreen pass compiles and allocates around itself.
**Fix:** instrument `renderer.info` immediately before and after `capture()` and diff. Most likely
program variants compiled for a different tone-mapping / output-colour-space / fog state than the
canvas pass — force the capture pass to use the **identical** render state so no new variant is needed,
or pre-warm those variants once at scene mount.

**B9.6 major — The controls are an unlit DOM pill row, text-only, with a no-undo destroy button next to the reward.**
Files: `SmileMaker.tsx:226-268` (`Surprise` / `Clear` / `Snap!`), `:234`, `:245`, `:266` (no icon or
glyph on any of them). Reported by: smile-maker rubric 6 + rubric 9.
This is a **photo booth with no camera in it**: the child presses a web button labelled "Snap!" and a
polaroid materialises from nowhere. The polaroid itself **is** a real clay prop in the scene and is the
one piece of this game that gets it right — which proves the team knows how. And a pre-reader cannot
distinguish "Clear", which destroys everything they made with no undo, from "Snap!", the reward.
**Fix:** put the controls in the world — a clay camera prop on the ring the child taps to snap, a
shuffle die or spinner for Surprise, a tray or lid for Clear. At minimum, an unambiguous icon on every
button and an undoable "put everything back" animation gating Clear.

**B9.7 minor — Sunglasses and Cape are unreadable as objects.**
The sunglasses' tinted panes are so weakly tinted that the shelf pad's dimple reads straight through
them and the temples splay at unrelated angles — the prop reads as loose brown sticks. The cape stands
upright as a brown paddle with a collar ring and an orange cross, reading as a hand mirror or signpost.
**Fix:** raise the lens tint opacity and rim the panes; fold the temples down so the prop reads as
glasses lying on a table. Drape the cape over its shelf pad in soft folds rather than standing it on
edge, and **drop the cross emblem** — it is the only cross-shaped mark in the product and reads as
clinical.

**B9.8 minor — 19 % of the play area is dead cream above the diorama.**
Title band ends at y≈165, the 3D starts at y≈300, in an 820 px frame. The solve reserves the chrome and
the control row correctly, then does not use the space it has left.
**Fix:** recentre the solved shift into the middle of the clear band on landscape too, and let the
diorama grow.

## B10. Tooth Match — scoring

**B10.1 minor — The celebration reveals a number lower than the banked chip the child was watching.**
Files: `src/games/tooth-match/engine.ts:115-129` (`finalScore` subtracts misses). Reported by:
content-safety #10. The round-2 fix removed the live score that ticked backwards on a mismatch — which
was correct — but it moved the punishment one beat later rather than removing it.
**Fix:** make `finalScore ≥ bankedScore`.

---

# DROPPED — asserted without sufficient evidence, or contradicted

1. **Sliding Puzzle finding 7 — "DOM/engine desync: `Moves: 51` held for 11 interactions."**
   The critic filed it themselves as *"needs confirmation"* and attributed it to possible React
   scheduling starvation in a hidden, throttled tab. The half that *is* real — arrow keys mutating the
   board behind the celebration — is captured as B1.1. The stale `Moves` display is not reproducible
   from the evidence and the capture agent's own framing of it (an aria-live bug) was shown to be
   wrong. Re-test in a visible focused tab before treating it as a defect.

2. **"Smile Maker's tooth cannot be orbited by keyboard"** (capture report, repeated by content-safety
   #13). Refuted by the accessibility critic against `src/games/smile-maker/scene.tsx:1483-1538`, which
   binds a capture-phase `keydown` implementing **Shift+arrow** orbit with `YAW_LIMIT`/`PITCH_MIN..MAX`
   clamping and per-press announcements. The capture agent tested bare arrows, which belong to the
   roving focus group. Not a defect. (A verification capture is still wanted — see EVIDENCE 6.)

3. **Every "Enter did not activate" note in the capture report.** The accessibility critic proved this
   is a harness artefact by building a bare `<button>` with an `onclick` in a clean page and getting
   `hit: 0` from the same synthetic Enter — the harness produces a trusted `keydown`/`keyup` but no
   activation `click`. Disregard all of them.

4. **"Maze Escape / Healthy or Not / Tooth Match phone screenshots show the board bleeding off all
   four edges."** `src/dev/drive.ts:12-14` states the `ResizeObserver` is faked to report the rect once
   on `observe()`, so an iframe resized after mount never re-solves the camera. Both critics
   independently transpiled their game's `layout.ts` and evaluated the solve numerically: maze predicts
   1.9 % cropping (not ~65 %), and healthy-or-not predicts **nothing clips at all** at 360×733 (bin
   far-right rim x = +0.875, table left edge −0.860, crown top +0.146 against a top of 0.340). The
   healthy-or-not capture demonstrably rendered the *desktop* camera and desktop `layoutFor(1.13)` into
   a phone viewport. **The severe cropping claim is dropped**; the code-level margin defects that stand
   on arithmetic alone are kept as B2.4 and B3.3. Healthy or Not's phone framing is scored
   **unverified**, not broken. Count the Teeth's and Tooth Rescue's phone items (B7.4, B6.5) are kept
   because their DOM-over-DOM HUD collisions cannot be a compositor artefact.

5. **Tooth Rescue finding 9 — "cast-shadow penumbra does not widen with gap."** The critic measured
   ~20 px at a small gap and ~18 px at a larger one and explicitly declined to call the PCSS solve
   broken, since the `ContactBlob` radial decal plausibly dominates both samples. Kept only as an
   evidence request (EVIDENCE 3), not as a fix.

6. **Count the Teeth's round-2 occlusion failure (worst tooth 36.9 % unoccluded, seed 51980671).**
   Neither confirmed nor cleared — `?selftest=count` aborts before the occlusion pass runs. Folded into
   B7.1's verification requirement rather than listed as a standalone defect.

7. **"Any frame drop below 60 fps" as a code defect.** No fps measurement exists on any device, on any
   tier, in 416 files, and `perf.ts` correctly self-declares it `unmeasured`. This is converted into
   instrumentation items (A13, A14, A15, A16) plus a required measurement. There is no code fix to
   assign until a number exists.

8. **Memory drift attributed to Maze Escape, Spot the Difference and Tooth Runner.** Each game's own
   delta across both endurance loops is **zero** on every counter and each has clean, verified
   disposal. The drift is entirely A1/A2/A3. Do not send a fixer into those three folders for it.

9. **Brand critic's "Spot the Difference renders no rose" (61 % in-family) and "Tooth Match 55.5 %
   in-family".** Both games' per-game critics judged the token usage correct and the off-family pixels
   are lit renders of in-family albedos or deliberate second-accent motifs. Only Smile Maker (44.5 %,
   a genuine chocolate/tan ramp at hue 45–63° with no matching token) and Tooth Rescue (13 %, item
   B6.1) are actionable.

10. **Sliding Puzzle evidence gap 7** — the critic destroyed `sliding-puzzle-rest.png` with a `sips`
    command. No conclusion depended on it; it is a re-capture request, not a defect.

---

# ITEMS THAT BLOCK A PASS

**Shared (must land first — 19 game items depend on one of these):**
A1 · A2 · A3 · A4 · A5 · A6 · A7 · A10 · A11 · A12 · A13 · A14 · A17 · A18 · A19

**Game-scoped blockers:**
B1.1 · B2.1 · B2.2 · B3.1 · B3.2 · B3.3 · B4.1 · B4.2 · B5.1 · B6.1 · B6.2 · B6.3 · B7.1 · B7.2 ·
B7.3 · B7.4 · B8.1 · B8.2 · B8.3 · B9.1 · B9.2 · B9.3

**Gating conditions that are not code changes but must be satisfied before a pass verdict:**
- `?selftest=spot` green (currently 2466 px / 1367 clusters, reproduced twice).
- `?selftest=count` reaching and passing its occlusion pass (currently aborts at a stale-constant
  guard, and `console.error`s on every mount — the only error in the entire audit run).
- A two-loop endurance run landing within §5's stated tolerance, or the tolerance amended and defended.
- One GPU-timer-query capture at `?tier=mid`, 1200×800, in a **visible focused tab** — desktop GPU p95
  ≤ 1.2 ms per game — with A13 landed first so the marks are admissible.

---

# EVIDENCE REQUIRED FOR ROUND 4 (not fixes — capture obligations)

1. **A real device.** Every millisecond in 416 files is Apple-GPU desktop wall clock under a virtual
   clock. §4's constraint is a locked 60 fps on a mid-range Android tablet. Needed: real `fps`,
   `droppedFrameRatio` and long-frame count on that hardware, at the tier it actually probes into, for
   all nine games plus the hub — with the entry hitch measured **including** cold shader compilation.
2. **A real 390×844 browser window** (not a resize, not `?drive=1`) for all nine games plus the hub,
   and a resize-after-mount pass, since every `Stage` measures once and then depends entirely on the
   `ResizeObserver`. This is what closes DROPPED #4 in either direction.
3. **Penumbra-widening proof:** one prop held at 0.05 u and at 2.0 u above the ground with `ContactBlob`
   and the blob decal **disabled**, raw shadow-map edge width measured at each. This is the only way to
   know whether the PCSS solve is running or compiling away.
4. **`?tier=mid` and `?tier=low` composites for the games that have neither** (tooth-rescue,
   spot-the-difference). Low tier is where `quality.softShadows` gates PCSS off — for Spot it may be
   the only configuration where the panels currently match, which would confirm A6 from the other side.
5. **The missing framings and beats:** a Sliding Puzzle 4×4 composite and a solved-board contact sheet
   (the 1 s `FINISH_DELAY` payoff has **not one pixel** of evidence); a Tooth Match Hard board with 4+
   different motifs face-up; Smile Maker's Crown and Hat worn from three orbit angles; a Healthy or Not
   **wrong** answer at 1-frame spacing; Tooth Rescue's celebration first second.
6. **Focus-ring captures.** 416 files contain **zero** frames of a 3D focus indicator — the central
   artefact for the accessibility lane; the critic had to produce it themselves. Needed:
   `<game>-focus-f01.png` for all nine, plus a `?selftest=hit-targets` run **per game** (it has been run
   against two of nine), plus the Shift+arrow orbit run for Smile Maker that closes DROPPED #2.
7. **Reduced-motion interaction frames** for tooth-match, healthy-or-not, tooth-rescue, tooth-runner and
   smile-maker — currently at-rest stills only. The Maze Escape treatment
   (`sheet-maze-reduced-vs-normal.png`) is the standard. Plus one run under a real OS
   `prefers-reduced-motion: reduce`, since `?reduced=1` has only ever been exercised via the store flag.
8. **Press-latency series** for the eight games that lack one (measured only for tooth-match): per-frame
   pixel diff against the frame before `pointerdown`, frames +1 to +8, cropped to the control.
9. **The 450–600 ms hub↔game transition (§5)** — unmeasured for every game: 0 rAF callbacks in a hidden
   tab, and `skipAnimations` is on under `?drive=1`. Needs a visible focused tab.

---

# HONEST ASSESSMENT

The engineering underneath this submission is genuinely strong and should not be mistaken for the
problem. The performance critic mechanically extracted all 20 `useFrame` bodies plus every
`update`/`step`/`tick` they call and found **zero** per-frame allocations and zero per-frame React
renders across the entire tree — that is a real result, not a spot check. `camera.ts` enforces §4's
breathe caps by construction rather than by a tunable clamp and passes in all nine games. Keyboard play
is complete and correct in 9/9, the reduced-motion branch is real and meaningfully different in 9/9,
the two-tone focus ring's WCAG maths was independently recomputed and holds, `hit.tsx`'s 48 px
world-space solve is algebraically correct, the PMREM studio holds `#EDE7DC` to dE 0.5 in all ten
scenes with zero cool pixels and zero clipped speculars, and the `aria-live` copy is the best-written
text in the product. Several frames — the Healthy or Not chomp, the Maze Escape corner tumble, the
Tooth Match tray and card backs — would sit inside a Sago Mini product without apology.

But the product is not close to the §3D-SPEC bar, and the distance is structural rather than
cosmetic. Every one of the thirteen critics returned FAIL, and they failed on **different** rubric
lines, which means there is no single lever. Four hard constraints are breached by measurement, not
opinion: §5 memory never returns to baseline and textures were **still climbing** after two full loops;
§9's triangle budget is exceeded by the hub, the first and most-returned-to screen; §1.1 is breached in
three separate places (the hub's seven bare rooted teeth, one falling into a red basin; two mascots
that render as skulls because a feature-anchor scale was never applied; a confetti burst of dark red
slivers over red); and §6.5's panel-parity rule is broken by a shared shader change, which the game's
own shipped selftest reports as failing — twice. Underneath those sits a pattern that matters more than
any individual item: **the reasoning in this codebase is excellent and its verification is thin.**
`layout.ts:91` computes a scallop as "0.0006 units — invisible" and it is the most legible feature on
the mascot's face. `props.ts:214` claims "art-directed eyes with catchlights" and the catchlight sphere
is arithmetically enclosed inside the pupil. `mascot.ts:68-73` checks the eye clearance and declares the
whole face clear while the cheeks hang 7 % outside the crown. `layout.ts:180-187` asserts a silhouette
constant that the geometry contradicts by 0.0205 units, and the guard that catches it aborts the very
occlusion proof §6.7 mandates. Smile Maker's prop flight was rigorously fixed and its resting pose was
never checked at all. In each case a claim written in a comment substituted for a measurement, and the
render disagrees.

The other structural gap is the evidence itself. There is no fps measurement, no GPU measurement, no
`?tier=mid` measurement and no real-device measurement anywhere in 416 files, and the CPU numbers that
do exist are internally contradictory in two ways (a superset cheaper than its subset; the cheaper tier
measuring 4–6× more expensive). One of nine entry marks closed having sampled zero frames and was
reported as a clean `violations: []`. So §9's central claim — a locked 60 fps on a mid-range Android
tablet, on a shader running 20 dependent texture fetches per shadowed fragment — is not merely unproven,
it is currently unprovable with this harness. That has to be fixed before anything else can be judged.

Realistically: the 15 shared blockers are a focused body of work — most are 10–100 line changes in
files with one owner, and A1, A4, A5, A17, A19 and A22 are each close to a one-liner with an outsized
blast radius. Land those and roughly a third of the game items resolve or shrink. What will take
longer is the art debt those changes expose — Tooth Rescue's alcove, Tooth Match's motifs, Tooth
Runner's item vocabulary and Smile Maker's union seams are genuine modelling work, not tuning, and
three of the nine games currently have a frame that a reasonable person could not place inside a Toca
Boca product. Two rounds, not one, and the first of them should be shared code plus instrumentation
only, so round 4's evidence is worth reading.
