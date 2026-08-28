# Lumident Kids Games — 3D Conversion, Round 2 Ranked Fix List

Synthesised from nine game critics and four cross-cutting critics (performance, accessibility,
brand, content-safety). Every claim below was checked against the source before being written
down; claims that could not be substantiated are listed in §5 with the reason they were dropped.

**Read this first.** Thirteen critics returned FAIL. They did not fail on thirteen different
things. Five shared defects account for the majority of the per-game findings, and until those
are fixed most of the per-game work cannot even be verified — every screenshot in the entire
evidence set was taken with a CSS override injected, so **nothing in this audit shows the
product as it currently ships.**

Fix order is: §1 shared → §2 cross-cutting → §3 per game. Do not start §3 items marked
"depends on" until their shared dependency has landed.

---

## 1. SHARED CODE (`src/shared/**`, `src/three/**`, `src/hub/**`, `src/dev/**`, `src/index.css`)

### S1 — BLOCKER — shell collapses to 162 px; every game ships as a letterbox strip
**Owner:** shared
**Files:** `src/GamesCollection.tsx:289`, `src/shared/GameShell.tsx:222`
**Defect:** The game panel is `className="mx-auto flex min-h-dvh w-full max-w-[860px] flex-col …"` —
a *min*-height, not a definite height. `GameShell`'s root is `className="relative flex h-full flex-col …"`,
and a percentage height cannot resolve against a min-height, so it computes to `auto` and collapses.
Measured chain (`shell-height-bug.json`): panel 772 px → flex body 676 px → GameShell root
**161.547 px**. Reproduced in plain DOM with no app code. `areaRef` is `absolute inset-0` inside
that collapsed root, so the drei `<View>` is scissored to **828 × 162** and the whole 3D scene
draws inside the header band. Confirmed visually in `*-rest-collapsed.png` for four games and
reproduced live on `localhost:5173` by the brand critic with no override.
Consequences: every 48 px tap target is a third of the viewport height and colliders overlap;
`count-the-teeth`'s answer tiles and `tooth-rescue`'s 5.35-unit drop have nowhere to go.
**Fix:** give the panel a definite height — `min-h-dvh` → `h-dvh` at `GamesCollection.tsx:289`
(keep `min-h-dvh` if you want both) — **or** change `GameShell.tsx:222` from `h-full` to
`flex-1 min-h-0` inside a definite-height flex parent. Then add a dev assertion (or a selftest
case) that `areaRef.current.getBoundingClientRect().height > 400` on a 900 px-tall viewport, so
this cannot regress silently. **Re-capture all nine games afterwards; this audit's visual
findings are provisional until you do.**

### S2 — BLOCKER — every per-instance / per-vertex colour is pushed through the AO extrapolation curve
**Owner:** shared
**Files:** `src/three/materials.ts:149-157` (`CLAY_COLOR_FRAGMENT`), `src/three/materials.ts:476` (`ao: opts.ao ?? 1.45`)
**Consumers affected:** `src/three/celebrate.tsx:318-330` + `writeConfettiColours`,
`src/games/sliding-puzzle/reliefMesh.ts:38-47,386`, `src/games/sliding-puzzle/scene.tsx:400-419`
**Defect:** The shader documents the `color` attribute as a *signed curvature map centred on 1.0*
(crevices ~0.63, worn bevel crowns ~1.10) and applies
`diffuseColor.rgb *= max(0, 1 + (vColor - 1) * uClayAO)` with `uClayAO` defaulting to **1.45**.
In three.js `instanceColor` and the vertex `color` attribute feed the same `vColor`. Any code that
uses that attribute to carry an **albedo** (always ≤ 1) is therefore driven *down* by 1.45× from
neutral, and any channel below ~0.31 linear clamps to **zero**.
Measured, and the prediction matches the render on every sample:

| token | spec sRGB | rendered | predicted by ×1.45 |
|---|---|---|---|
| `peach.main` #efa160 | (239,161,96) | (227,74,9) | (233,72,0) ✓ |
| `coral.main` #e8604c | (232,96,76) | (215,12,6) | ✓ |
| `mauve.main` #c08475 | (192,132,117) | (143,12,6) | ✓ |
| `NEUTRAL.ink` #2f3237 | (47,50,55) | (17,13,6) | ✓ |
| `red.deep` #c21e25 | — | #9D0000 | ✓ |

Two shipped consequences, both independently reported as blockers:
1. **The celebration confetti renders as arterial red / dried blood / near-black.** Histogrammed
   chip colours across three games: `#930F08`, `#DC1209`, `#4C0B04`, `#900000`, `(25,10,4)`.
   None is a Lumident token. `docs/3D-SPEC.md:29` bans blood outright.
2. **Sliding Puzzle's whole picture is off-token** (dE2000 9.8–19.1) and the brand ink `#2F3237`
   renders as pure black, so it never appears on screen anywhere in that game.
   Separately, `gClayEdge = saturate((clayLum − 1) × 10)` is identically **0** for every albedo-carrying
   surface, so the edge-gloss roughness drop — the only thing that makes a bevel read — never fires there.
**Fix:** stop overloading one attribute. Reserve `color` for `bakeCurvatureAO` output only, and
add a **straight-multiply albedo path**: either a second attribute (`aAlbedo`, multiplied into
`diffuseColor` at full strength alongside the curvature term), or a `clay()` variant flag
(`tintMode: "albedo"`) whose fragment does `diffuseColor.rgb *= vColor` and derives
`gClayCrev`/`gClayEdge` from a separate channel. Migrate `celebrate.tsx` confetti and
`sliding-puzzle` relief/face to it. **Do not "fix" this by setting `ao: 1.0`** — that leaves
`gClayEdge` permanently 0 and every bevel unlit. After the change, re-measure the rendered chip
pixels against `ACCENTS` and assert dE2000 ≤ 5.

### S3 — BLOCKER — the shared celebration breaches the triangle budget 2.1×–2.9× in 7 of 8 measured games
**Owner:** shared
**Files:** `src/three/celebrate.tsx:310-313` (chip geometry), `src/three/celebrate.tsx:600-601` (`frustumCulled={false}`, `castShadow`)
**Defect:** Measured, flagged by the app's own `__perf.violations`: maze-escape 379,300 ·
healthy-or-not 383,446 · count-the-teeth 386,882 · tooth-runner 437,322 · spot-the-difference
456,854 · tooth-match 460,682 · tooth-rescue 514,786 — against `BUDGETS.triangles = 180,000`.
Root cause isolated by direct geometry measurement: `roundedPlate(0.12, 0.12, 0.03, 0.045, 1)`
is **644 triangles** for a chip that covers ~12 screen px. With `castShadow` on (default/mid tier)
each chip is submitted twice: `260 × 644 × 2 = 334,880`, plus hero 3,240 and sparkles 56 =
**338,176** — matching the observed celebration delta of **338,178** in three independent games.
At **mid tier** (`maxInstances 160`, `detail 2`) it is still 208,080 with no game scene underneath.
**Fix:** two changes, either alone clears the budget, both take it to ~10 k:
1. `castShadow={false}` on the confetti `instancedMesh` at `celebrate.tsx:601` — 260 chips at
   12 px contribute nothing readable to a 1024 shadow map and cost half the total.
2. Replace the chip geometry with a purpose-built bevelled quad of 24–48 triangles (keep the
   bevel — `3D-SPEC §3` — just stop paying 644 tris for it at this size).
Also gate `maxInstances` on tier so low never builds the full field. Then re-measure per game and
assert `< 180000` in `computeViolations`.

### S4 — BLOCKER — the celebration composite is broken: faceless extracted tooth, confetti on an invisible plane, two horizons
**Owner:** shared
**Files:** `src/three/celebrate.tsx:314-316` (hero geo), `src/three/celebrate.tsx:66` (`REST_Y`),
`src/shared/GameShell.tsx:136-140` (`CELEBRATION_CAMERA`), `src/shared/GameShell.tsx:341-344` (`ground={false}`)
**Defect:** three faults compounding in the single most important frame in the product, reported
independently by all nine game critics plus content-safety and brand:
- **No face.** The hero is bare `toothGeometry("baby", detail)` — crown plus two splayed roots,
  no eyes, no mouth. Anatomically that is an *extracted* tooth, suspended in mid-air, as the
  reward for finishing. `buildMascot()` (`src/games/healthy-or-not/props.ts:452`) already exists
  and is not applied.
- **Confetti settles onto a ground plane that is not in the game's world.** Chips rest at
  `REST_Y = 0.019` under `CELEBRATION_CAMERA` (`[0, 0.9, 8.4]`, near level), while the game view
  is at 17°–42° elevation with `ground={false}` so nothing is drawn beneath them. Result in every
  celebration PNG: a dead-flat, perfectly coplanar horizontal sheet of chips floating in mid-air,
  hard-clipped at both View-rect edges, passing straight **through the hero's midsection**, with
  a second, contradictory horizon behind it.
- **The game scene stays fully lit underneath**, so `healthy-or-not`'s mascot is intersected by
  the hero (one disembodied eye and two floating cheeks at frame edge), `count-the-teeth` shows
  five rooted teeth at once plus its still-live answer tiles, and `spot-the-difference` wedges the
  hero into the 14 px gap between its two picture frames.
**Fix:**
1. Apply the mascot face parts to the celebration hero.
2. Derive `CELEBRATION_CAMERA` from the finishing game's solved `Framing` (same elevation, same
   target height, same distance band) instead of a fixed level camera, so the burst happens in the
   room the child was just in.
3. Either give the celebration a real ground at the game's ground height, or fade chips out before
   they settle so there is never a resting carpet. Clamp the radial burst so the settled field
   stays inside the play footprint and never clips at the View rect.
4. Hide or dim the game's own hero prop while `completed` is true (expose a `celebrating` flag on
   the store; each game sets its hero `visible = false`) so nothing interpenetrates.

### S5 — BLOCKER — the play area is blank at the exact frame the child wins, and stays live and focusable under the overlay
**Owner:** shared
**Files:** `src/shared/GameShell.tsx:246-407` (celebration overlay + `children` still rendered), `src/three/celebrate.tsx`
**Defect (two parts, same handoff):**
1. `count-the-teeth-celebration-perf.json` records ~**300 driven frames (~5 s at 60 Hz) with the
   play area rendering nothing at all** while the DOM celebration ("Great job, Maya!", "320 pts",
   "Play again") was already at `opacity 1, visibility visible`, and `__perf` still reported the
   game scene. The one non-negotiable promise — every run ends in celebration — is broken at the
   frame it matters.
2. `GameShell` keeps rendering `children` when `completed` is true. No game passes `disabled` to a
   `HitTarget` (`grep -n "disabled=" src/games/*/scene.tsx` returns nothing), so the
   `aria-disabled` branch at `hit.tsx:472` is dead code product-wide: after a win every hidden
   a11y button is still focusable **and still fires its handler** under a full-screen `z-20`
   overlay. The overlay has no `role="dialog"`, no `aria-modal`, no accessible name, and never
   receives focus.
**Fix:** gate the DOM overlay's opacity on the celebration scene's first `onAfterRender` (cross-fade,
never swap); set `aria-hidden` + `inert` on the play area while `completed`; give the overlay
`role="dialog" aria-modal="true" aria-labelledby={headlineId}`, focus the headline on mount, and
return focus to Restart on dismiss. Capture the completion transition as a PNG series next round.

### S6 — BLOCKER — memory never returns to the hub baseline
**Owner:** shared
**Files:** `src/three/geometry.ts:43-62` (`cachedGeometry` + `markShared`), `src/three/materials.ts:405` (material cache), `src/three/dispose.ts:19-25`
**Defect:** Both caches are module-level `Map`s with no eviction path on navigation
(`disposeGeometryCache()` exists and nothing calls it outside teardown). Measured hub → game → hub:

| game | geometries | textures | programs | heap |
|---|---|---|---|---|
| baseline | 21 | 3 | 8 | 44.3 MB |
| sliding-puzzle | +13 | +2 | +5 | +22.2 MB |
| maze-escape | +26 | +2 | +5 | +4.8 MB |
| tooth-match | +37 | +2 | +5 | +37.1 MB |
| healthy-or-not | +56 | +2 | +7 | +14.9 MB |
| spot-the-difference | +70 | +2 | +7 | +22.4 MB |
| tooth-rescue | +78 | +2 | +7 | +48.1 MB |
| count-the-teeth | +85 | +7 | +8 | +63.6 MB |
| tooth-runner | +102 | +7 | +18 | +49.1 MB |
| smile-maker | +109 | +8 | +25 | +65.3 MB |

Endurance ceiling: **130 / 11 / 33**, flat on pass 2 — so it is a *bounded cache*, not a leak.
But `docs/3D-SPEC.md:170-172` requires a **return to the hub baseline with ±2 programs tolerance**,
and 33 live programs also sits permanently over `BUDGETS.materials = 28`. Worse, game-private keys
are pinned into a "shared" cache: `clay("tooth-match/table")`, `cachedGeometry("tooth-match/quad")`,
`clay("sliding-puzzle/face")`, `clay("celebrate/confetti")` etc.
**Fix:** namespace the cache keys (`<gameId>/…` already is the convention) and split the caches into
a genuinely-shared tier (entries the hub itself uses) and a per-scene tier evicted by a new
`disposeSceneCache(gameId)` called from `markSceneExit`. If the bounded-cache behaviour is
*intended*, then amend `3D-SPEC §5` and `BUDGETS.materials` to state the contract and a measured
ceiling — right now the code and the spec contradict each other and the spec is what ships.

### S7 — BLOCKER — no valid frame-timing evidence exists anywhere in this audit
**Owner:** shared
**Files:** `src/dev/drive.ts:75`, `src/dev/perf.ts:187`, `src/dev/perf.ts:227`, `src/dev/perf.ts:507`
**Defect:** `drive.ts:75` installs `performance.now = () => (pumping ? virtualNow : realNow())`.
`perf.ts:187` defines `const now = () => performance.now()` and `perf.ts:507` measures render cost
as `renderAccum += now() - t0` — but `virtualNow` does not advance across the render call, so
**`renderAccum` is mathematically always exactly 0 under `?drive=1`**. That is why every snapshot
reports `renderAvgMs: 0 / renderP95Ms: 0` and 17 perf files report
`avgMs = p95Ms = worstMs = 16.67, longFrames 0, droppedFrames 0` — identical to two decimals, which
is impossible on real hardware. Four budget checks therefore *cannot fire*: `renderP95Ms`,
`droppedFrameRatio`, `hitch:enter:*`, `frameMsP95`. Separately `perf.ts:227` compares a virtual
`ts` against a `slot.at` seeded from the real clock, so `ts - slot.at` never exceeds 1000 ms and
**every scene-entry mark is still `open: true`** after 299–2629 frames — entry hitch was never
measured for a single game. Every `"violations": []` on a play-time capture is vacuous with respect
to timing.
**Fix:** capture `t0`/`t1` in `perf.ts` through a non-virtualised clock handle
(`const rawNow = performance.now.bind(performance)` captured at module load, before `drive.ts`
patches it), and make the mark window compare like-for-like clocks. Then re-run the whole capture
in a **foreground tab with the driver off** and, per `3D-SPEC §1.4`, on a mid-range Android tablet.
Until that exists, the 60 fps constraint is unverified, not met.

### S8 — BLOCKER — Count the Teeth runs ~20 synchronous GPU readbacks inside `useFrame`, every round
**Owner:** shared (mechanism) + count-the-teeth (call site)
**Files:** `src/three/verify.ts:97-121`, `src/games/count-the-teeth/scene.tsx:811-825` (`solveRound`)
**Defect:** `solveRound` runs inside the render frame and calls `measure()` up to four times
(3 attempts + fallback). Each `measure()` costs `1 + ceil(n/4)` synchronous
`readRenderTargetPixels` calls — five at level 2 / count 14. Because the occlusion guarantee never
converges (`selftest.json`: worst tooth **36.9 %** unoccluded against a 75 % requirement), all four
attempts run every time: **~20 synchronous readbacks in one frame, per round.** Free on Apple-silicon
unified memory; on a tile-based mobile GPU each one forces a full pipeline flush (5–30 ms) →
**200–500 ms of freeze between every round**, almost certainly the cause of the observed
~300-frame blank at completion (S5).
**Fix:** move the solve off the render frame. Precompute the next round's scatter during the previous
round's idle/celebration using the analytic path only (`layout.ts` already proves the exclusion
property with no GPU involvement), and keep the GPU verification behind `?selftest=count`. If a
runtime check must stay, batch all teeth into a single readback and cap it at one attempt.

### S9 — MAJOR — no shader precompilation; 23–27 cold GLSL compiles on scene entry
**Owner:** shared
**Files:** `src/three/Rig.tsx`, `src/shared/GameShell.tsx` (transition), `src/three/Scene3D.tsx`
**Defect:** `grep` for `renderer.compile`, `compileAsync` or drei `<Preload>` across `src/` returns
nothing. Hub baseline is 8 programs; entering Smile Maker reaches 31 (35 during the polaroid) —
23–27 distinct `MeshPhysicalMaterial` variants with heavy `onBeforeCompile` patching, compiled on
the first frame. On Mali/Adreno that is 15–60 ms each: **350 ms – 1.4 s of stall on entry**, against
`3D-SPEC §9`'s "≤ 1 dropped frame". Desktop-invisible with a warm driver cache, which is exactly why
the capture missed it, and the broken entry mark (S7) let it through silently.
**Fix:** call `gl.compile(scene, camera)` (or `compileAsync`) on the incoming game's subtree during
the existing 450–600 ms hub→game camera transition. The transition is perfect cover and already exists.

### S10 — MAJOR — `.grad-btn` and `.neu-raised` are ease-in-out with no anticipation and no overshoot
**Owner:** shared
**Files:** `src/index.css:293-312` (`.grad-btn`), `src/index.css:178-198` (`.neu-raised`)
**Defect:** `transition: transform 120ms ease` — CSS `ease` is `cubic-bezier(0.25, 0.1, 0.25, 1.0)`,
i.e. the ease-in-out family, banned outright by `3D-SPEC §4` and by the rubric. `:active` is a bare
`translateY(3px)` with no scale, no wind-up, no release overshoot. These are the **"Play again"
button on every celebration**, the difficulty pills, the Welcome screen's age stepper and
Tooth Rescue's only start control — the most-pressed controls in the product.
`.clay-btn` at `src/index.css:238-253` already does it correctly with `cubic-bezier(0.34, 1.42, 0.64, 1)`.
**Fix:** copy `.clay-btn`'s curve onto both classes; add `scale(0.94)` on `:active` over ~90 ms and a
release overshoot to ~1.06. Add a `@media (prefers-reduced-motion: reduce)` branch capping both at
≤150 ms with no overshoot.

### S11 — MAJOR — keyboard focus is destroyed on entering and on leaving every game
**Owner:** shared
**Files:** `src/GamesCollection.tsx` (`open()` / `close()` / `AnimatePresence mode="wait"`)
**Defect:** `grep -rn "\.focus()" src` returns exactly three call sites, none of which move focus
into the game panel on open or back to the originating card on close. `AnimatePresence mode="wait"`
unmounts the hub, so the focused card ceases to exist and `document.activeElement` falls to `<body>`.
A keyboard-only child must Tab from the top of the document after **every** game entry, and lands
nowhere after every Escape. WCAG 2.4.3.
**Fix:** store the originating element ref in `open()`; focus the "All games" button (or a
`tabIndex={-1}` `<h2>`) in the panel's mount effect; in `close()`, `requestAnimationFrame(() => cardRefs.current[index]?.focus())`.

### S12 — MAJOR — the a11y layer is last in DOM order and the game panel is an unlabelled, unroled region
**Owner:** shared
**Files:** `src/three/hit.tsx` (`a11yRoot()` appends `#lumident-a11y` to `document.body`), `src/GamesCollection.tsx:286`
**Defect:** the a11y layer lands after `#root`, so the reading order is: All games → mute → restart →
Easy → Medium → Hard → the game's own DOM → **then finally the 3D board**. The thing the child came
to touch is last. The panel itself carries no `role`, no `aria-label`, no `aria-labelledby` pointing
at `GameShell`'s `<h2>{title}</h2>`, and there is no skip link.
**Fix:** render the a11y layer inside the game panel (or place it before the chrome in DOM order);
add `role="region" aria-labelledby={titleId}` to the panel.

### S13 — MAJOR — `HitTarget` colliders are ~270 px for the first 8 frames and ~4× oversized through the entry animation
**Owner:** shared
**Files:** `src/three/hit.tsx:349-380`
**Defect:** two independent sizing faults.
1. The collider mounts at `scale 1` on a unit sphere = 1 world-unit radius, and `useFrame` skips
   7 of every 8 frames (`CHECK_MASK`), so the first sizing happens on frame 8. At d≈12, fov 28,
   view height 800 that is a **268 px-diameter** collider: every target overlaps every neighbour and
   a child who taps immediately on entry hits the wrong tile.
2. `state.size.height` comes from drei's `<View>` portal, captured at the View's *render*, not per
   frame. The hub→game panel is a framer-motion **scale** flip from 0.24 → 1, and
   `getBoundingClientRect()` returns the transformed rect — so the View mounts with
   `size.height ≈ 0.24 × real`, every collider comes out ~4× too large, and `lastDepth` +
   `DEPTH_TOLERANCE` then caches that. It only self-corrects on the next discrete HUD re-render.
   The only invalidations bound are `resize`/`orientationchange`, neither of which fires.
**Fix:** size the collider once in a `useLayoutEffect` before first paint (or seed `c.scale` from
`radius` rather than 1); invalidate `lastDepth` whenever `state.size.height` changes (compare against
a ref); read the untransformed play-area height rather than a transformed rect. Add a dev-mode
assertion in `selftest.ts` that projects every live collider and fails on overlap.

### S14 — MAJOR — focus indicators fail contrast and minimum stroke
**Owner:** shared
**Files:** `src/three/hit.tsx` (`FocusRing`, `RING_MIN_SCREEN_PX`, tube = `0.09 × R`),
`src/games/tooth-rescue/ToothRescue.tsx` (`ring-red-deep/45`, `outline-none`),
`src/games/tooth-runner/ToothRunner.tsx:221` (`ring-peach-deep/50`, `outline-none`)
**Defect:** measured with the repo's own `contrastRatio()` from `src/dev/selftest.ts:607`:
`FocusRing` is `red.deep #c21e25` — **4.87:1** on cream (pass), but only **1.77:1** on maze-escape's
coral gum block and **1.23:1** on `gumDeep`, where `maze-escape/scene.tsx:994` billboards it.
Ring stroke at minimum size is **1.8 px**, under WCAG 2.4.11's 2 px perimeter, on exactly the
distant small props the min-size clamp exists to protect. Tooth Rescue's slider ring computes to
**2.09:1** and Tooth Runner's to **1.60:1**, and both discard a *compliant* global
`:focus-visible` (`index.css:71`, 3.58:1) by setting `outline-none`.
**Fix:** compute the ring tube from `worldPerPixel` so it is never under 3 screen px; add a 1 px
`#2f3237` inner contour so the ring is legible against any backing (standard two-tone indicator);
delete `outline-none` from both games or use the ring colour at full alpha.

### S15 — MAJOR — `text-ink-soft` fails AA in all 11 usages, including the mute and restart icons
**Owner:** shared
**Files:** `src/index.css` / Tailwind theme (`ink-soft #8f897d`, `ink-mid #6b675f`), `src/shared/GameShell.tsx:257,265,298`
**Defect:** measured — `#8f897d` on `#EDE7DC` is **2.82:1** (hub subtitle 17 px/600, "pts" 15 px,
"Age N", "Getting X ready…"); on `clay-well` **2.55:1**; at `/75` (`#a7a195`) **2.09:1**.
`ink-mid #6b675f` on `clay-well #e3dccd` is **4.12:1** — the unselected Easy/Medium/Hard pills, 14 px
semibold. The **mute and restart icon buttons** use `!text-ink-soft` at 2.82:1 against a 3:1 floor
for UI components (WCAG 1.4.11) — and the mute button is the only way out of a soundtrack for a
child with sensory sensitivity.
**Fix:** darken `ink-soft` to ≥ 4.5:1 on cream (≈ `#6f6a60` or darker), never use it on `clay-well`,
and give the icon buttons a colour at ≥ 3:1. Single highest-yield accessibility change in the product.

### S16 — MAJOR — micro-grain never reaches the framebuffer, and `clayEnamel` is below the spec floor
**Owner:** shared
**Files:** `src/three/materials.ts:352-364` (`grainMap()`), `src/three/materials.ts:538` (`clayEnamel` `grain: 0.07`, `wrap: 0.28`)
**Defect:** measured on structure-free interior patches (9 px high-pass, L\* MAD): hub card face
**0.067**, count-the-teeth mat **0.088**, sliding-puzzle relief star top **0.020**, tile face **0.016**.
One 8-bit code at L\*87 is ≈0.25 L\*, so **every measurement is at or below quantisation** — the
grain is invisible. `grainMap()` never sets `repeat`, so the fbm perturbation lands ~4× under one
code value at play distance. Independently, `clayEnamel` — the mascot's own material — ships
`grain: 0.07` against `3D-SPEC §3`'s 0.08–0.15 floor and `wrap: 0.28` against the spec's ~0.35.
Consequence: `maze-escape-rest.png` is **23.85 % of the frame at exactly `#e75232`** and
`count-the-teeth-rest.png` **14.53 % at exactly `#bc7860`** — single-value fields covering a fifth
of the screen.
**Fix:** set an explicit world-scale `repeat` on `grainMap()` derived from the mesh's world size;
raise `clayEnamel` to `grain: 0.11–0.13`, `wrap: 0.35`. Verify with the same high-pass measurement:
a flat card face must reach **≥ 1.5 L\* p99−p1**.

### S17 — MAJOR — cast shadows are hard, dense and grey on the hub and on the cream backdrop
**Owner:** shared
**Files:** `src/three/env.ts:238` (`PCFShadowMap`), `src/three/Rig.tsx:139-153` (`SHADOW_PENUMBRA`, `shadowNormalBias`), `src/three/tokens.ts` (`CLAY.shadowTint`)
**Defect:** the rig itself passes — key from upper-left in all ten scenes, shadow-floor hue
62°–92° everywhere, never lavender. What fails is softness and density on the surfaces the
`shadowTint` does not reach:
- Hub gutter: vertical profile at x=800 falls **29 L\* in 12 px** then holds `#868071`
  **byte-identical for 900+ px** — a flat occlusion slab, not a penumbra, 38 L\* below the lit ground.
- `count-the-teeth` board shadow on the cream backdrop: `(136,133,121)` on `(236,230,218)` — R−B of
  15, i.e. neutral olive, contradicting `env.ts:12`'s own stated invariant. The same board's shadow
  *on the pad* is correctly warm `(129,88,65)`, so the tint is reaching the clay path and not the
  directional pass on the backdrop.
- `smile-maker`: terminator resolves in ≤ 2 px with visible stair-stepping and a second flat
  plateau meeting the first on a crisp line — shadow-map banding.
- `env.ts:238` ships `PCFShadowMap` where `3D-SPEC §2` specifies `PCFSoftShadowMap`. The code carries
  a technically literate justification, but the spec's opening line is "where this file and your own
  taste disagree, this file wins."
**Fix:** multiply the shadow term by `CLAY.shadowTint` where it actually lands (the `gClayShadow`
capture at `materials.ts:252` already isolates it); raise shadow-map resolution or `shadowRadius`
so the penumbra measures **≥ 5 px** at design framing and widens with distance; lift density to
roughly a 0.78–0.85 multiply (currently 0.58 on healthy-or-not); widen the hub's ortho frustum so
the gutter floor sits nearer L\* 68–72. Take the `PCFSoftShadowMap` deviation back to the spec owner
rather than resolving it in a code comment.

### S18 — MAJOR — the View rect is visible on every screen and clips content mid-object
**Owner:** shared
**Files:** `src/three/Rig.tsx` (ground plane), `src/three/Scene3D.tsx` (View rect), `src/shared/GameShell.tsx` (`CHROME_PX`)
**Defect:** the calibration anchor holds inside the games (`clayGround` renders `#ece6da`, **dE 0.5**
from `#EDE7DC` — genuinely excellent), but the **hub's backdrop band measures `#e8d8c1`, dE 6.2**,
abutting the page at a razor edge on all four sides. Content is cut mid-object at that boundary:
the hub's Healthy-or-Not apple is sliced at `#d72e2f` slamming into cream at x = 234;
`count-the-teeth`'s answer tiles — the only tap targets in that game — are guillotined by the bottom
edge at four different viewport sizes; celebration confetti hard-clips at both ends.
`hub-tablet.png` at 1024×591 shows the 3D slabs no longer registering with the DOM card boxes at all
(icons clipped at both edges, bottom row cut, titles running across icons).
**Fix:** match the hub's backdrop plane exactly to `NEUTRAL.page`; extend the View rect past the
layout bounds with a fogged/feathered margin so the boundary is never a hard rectangle; and add a
safe-area constraint so no interactive prop is ever solved outside the rect (see the per-game
framing items G-CT-3, G-SM-3, G-SP-4, G-TM-8).

### S19 — MAJOR — DOM chrome floats over the world; no game uses in-world text
**Owner:** shared
**Files:** `src/shared/GameShell.tsx:246-320` (HUD), `:341-407` (celebration card), `src/three/text.ts` (unused)
**Defect:** verified on a live composite by the brand critic (there is no composite in the evidence
set — see §4). The white neumorphic "Next picture" pill and the flat string `Moves: 0` are drawn
**directly on top of the clay tray**, overlapping it, unlit by the scene, casting a CSS drop-shadow
into nothing. The `0:00` / score / speaker / reset chips are glassy white DOM widgets in a completely
different material language from the clay. The celebration is a CSS `linear-gradient` scrim to
near-opaque cream over the bottom 58 %, carrying a rounded-rect card with `box-shadow` and a pill
button. `src/three/text.ts` — the Manrope canvas-texture module that exists for exactly this — is
imported by **zero** games.
**Fix:** move the HUD chips out of the play rect entirely, or render score/time/level as in-world
clay props on a back plate with real contact shadows using `text.ts`. At minimum, no DOM element may
overlap a clay prop.

### S20 — MINOR — the hub ignores the quality tier entirely
**Owner:** shared
**Files:** `src/hub/props.tsx:35` (`const D = 2;`)
**Defect:** every hub prop hard-codes detail 2 and never reads `getQuality().detail`. `tier-low.json`
confirms the hub is byte-identical across tiers (33 calls / 83,454 tris / 21 geometries) while
in-game geometry drops 19–73 %. The hub is the first thing a child sees on the device class low tier
exists for. Compounding: `probeTier` in `quality.ts` sends a coarse-pointer device to **low** unless
`cores >= 8 && memory >= 6`, and `navigator.deviceMemory` reports 4 for any 4–6 GB tablet — so a
typical mid-range Android tablet lands on low and an 8 GB one on mid, and S3's budget breach flips on
that coin.
**Fix:** `const D = getQuality().detail;` in `props.tsx:35`.

### S21 — MINOR — `perf.ts` grades every game scene against the hub budget
**Owner:** shared
**Files:** `src/dev/perf.ts:311`
**Defect:** `const hub = route.get().screen === "hub";` — `route` reports `"hub"` while a game is on
screen, so `computeViolations` picks `drawCallsHub` (60) for game scenes and labels every violation
"in the hub". Spot the Difference at 72–83 calls is flagged against 60 when its real budget is 90.
Every perf report in this audit is mislabelled, which trains a reader to discount the whole
`violations` array.
**Fix:** set the route store's `screen` in `markSceneEnter` and clear it in `markSceneExit`; the
budget-selection logic itself is correct.

### S22 — MINOR — unscissored full-screen depth clear every celebration frame
**Owner:** shared
**Files:** `src/shared/GameShell.tsx:130-133`
**Defect:** `setScissorTest(false)` then `clear(false, true, false)`. Correct for compositing order,
but an unscissored depth clear on a tile-based deferred mobile GPU forces a depth load/store and
defeats tile binning.
**Fix:** scissor the clear to the celebration view's rect.

### S23 — MINOR — `?probe=1` mounts a debug scene in production
**Owner:** shared
**Files:** `src/App.tsx:12-14` vs `src/main.tsx:26`
**Defect:** `?drive` is `import.meta.env.DEV`-gated at `main.tsx:26`; `?probe=1` is not.
**Fix:** gate it the same way.

### S24 — MINOR — sound is unmuted by default
**Owner:** shared
**Files:** `src/shared/audio.ts:8`
**Defect:** in a shared dental waiting room, first launch plays audio unprompted. Not a spec
violation; a real parent problem, and the mute control that fixes it currently fails contrast (S15).
**Fix:** start muted and surface an obvious unmute, or persist the last choice in `localStorage`.

---

## 2. CROSS-CUTTING (one defect, several game folders — fix as one change set)

### X1 — BLOCKER — the live score chip counts *down* while the child plays
**Owner:** tooth-match, sliding-puzzle, maze-escape
**Files:** `src/games/tooth-match/engine.ts:118`, `src/games/tooth-match/ToothMatch.tsx:147`,
`src/games/sliding-puzzle/engine.ts:168`, `src/games/maze-escape/engine.ts:104`
**Defect:** `tooth-match`'s `liveScore() = max(0, matchedPairs * 100 - misses * 10)` is fed straight
into the HUD star chip, so a mismatch subtracts 10 points **on the same frame**, visibly, from a
number a 3–10-year-old is watching, while the announcement says "Oops, not a pair."
`sliding-puzzle` docks 2 points per tile slid and 5 per second; `maze-escape`'s own source comment
says the score "ebbs away as the clock runs" at 10/second. A number that ticks backwards while a
child plays is a dread timer whatever the clock chip says, and `3D-SPEC §1.1` forbids penalising a
mistake.
**Fix:** the live chip banks **up only**. Keep the time/move/miss terms in the *final* score if you
want them, and reveal that adjustment once, in the celebration card, never live.

### X2 — MAJOR — accent family drifts from the registry in three games
**Owner:** count-the-teeth, smile-maker, tooth-runner
**Files:** `src/games/index.ts` (registry), `src/games/count-the-teeth/scene.tsx:476,483,490`,
`src/games/smile-maker/build.ts:371-382`, `src/games/tooth-runner/props.ts:410,182-186`
**Defect:** the hub card icon plate uses the registry gradient, so a child taps a coral card and it
opens into a mauve room. Measured: `count-the-teeth` is registered **coral** but its board, pad and
pips are `clayAccent("mauve", …)` (mat samples `#bc7860`, dE 4.9 from mauve.main, dE **13.9** from
coral.deep). `smile-maker` is registered **mauve** and uses coral, peach, mauve, red *and* rose —
with no mauve element visible in `smile-maker-dressed.png`. `tooth-runner` is registered **peach**
but its hero arch is `coral.deep` and the brush caps are `red.main`.
**Fix:** drive the accent from the `GameEntry` so it cannot drift — pass `entry.accent` into each
scene's material factory and use `clayAccent(entry.accent, tone)` for the dominant surfaces. One
family per game, secondary families only as accents.

### X3 — MAJOR — four games present bare, faceless teeth with exposed roots as the subject
**Owner:** tooth-runner, tooth-rescue, count-the-teeth, maze-escape (+ shared, see S4)
**Files:** `src/games/tooth-runner/props.ts`, `src/games/tooth-rescue/scene.tsx`,
`src/three/geometry.ts:1130-1151` (`toothGeometry("baby")`), `src/games/maze-escape/props.ts:110-121`
**Defect:** the product's mascot has a face; its game props do not. `tooth-runner`'s hero is a
featureless white egg rolling end-over-end at 1.5 rev/s, presenting its roots to the sky for a large
fraction of every second. `tooth-rescue`'s falling teeth are bare rooted teeth at 1.17:1 contrast.
`count-the-teeth`'s props read as mushrooms/garlic cloves. `maze-escape`'s hero is ~30 px with a
6 px face that is occluded or rolled away in every captured play frame. The face rig
(`healthy-or-not/props.ts:452 buildMascot()`) exists and is used by exactly one game.
**Fix:** promote the mascot face parts into a shared `src/three/` helper and apply them to every
counted, caught, rolled or driven tooth in the product. Scale the features to a fixed *fraction of
screen height*, not of the prop, so a 30 px prop still shows eyes. For rolling/tumbling props, put
the face on a node outside the roll node so it stays camera-facing (see G-TR-6).

### X4 — MAJOR — screen-reader players are told where the *controls* are, never where the *game* is
**Owner:** sliding-puzzle, tooth-match, tooth-rescue, tooth-runner, count-the-teeth
**Files:** `src/games/sliding-puzzle/SlidingPuzzle.tsx:126-132`, `src/games/tooth-match/ToothMatch.tsx` (`case "flip"`),
`src/games/tooth-rescue/ToothRescue.tsx`, `src/games/tooth-runner/ToothRunner.tsx`, `src/games/count-the-teeth/CountTheTeeth.tsx:106-133`
**Defect:** all nine games are *operable* by keyboard and `Escape` returns to the hub cleanly from
every one — that part is genuinely done. But only three (maze-escape, healthy-or-not,
spot-the-difference) are *playable* blind, because only those three announce game state rather than
control state. Sliding Puzzle announces the direction moved but never which piece is where;
Tooth Match announces a bare noun ("toothpaste") with no card reference; Tooth Rescue announces the
basket position but never where the tooth is falling; Tooth Runner never announces an approaching
obstacle so jump timing is impossible; Count the Teeth reads out three candidate answers and never
the arrangement, leaving a 1-in-3 guess.
**Fix:** every `announce()` on a state change must carry the information needed to choose the next
action: piece identity + slot on a puzzle move; `"Card 3 shows a cup"` on a flip; spawn lane on a
tooth spawn ("tooth falling, left"); next obstacle and its lane time on spawn ("toothbrush, high,
in two"); an enumerable audio or spoken cue for the count. Use maze-escape's announcements
(direction + open exits + remaining distance) as the reference implementation.

---

## 3. PER-GAME

### 3.1 Sliding Puzzle

**G-SP-1 — BLOCKER — depends on S2 — migrate the relief and tile faces off the AO colour channel.**
`src/games/sliding-puzzle/reliefMesh.ts:38-47,386`, `src/games/sliding-puzzle/scene.tsx:400-419`.
Both `faceMat` and `reliefMat` are white-based materials that carry their palette as a per-instance /
per-vertex linear multiply into the attribute S2 reinterprets as curvature. Once S2 lands, write
albedo to the new attribute and re-verify every relief colour lands within dE2000 5 of its token.

**G-SP-2 — BLOCKER — z-fighting across the whole hair/head overlap on all three figures.**
`src/games/sliding-puzzle/relief.ts:505-506`. Head top = lift 0.045 + depth 0.100 = **0.145**;
hair top = 0.050 + 0.095 = **0.145** — exactly coplanar front-facing caps. Renders as a hard black
and white dither punched through the hair, visible at 1× in f03/f04/f05/f07, `-reduced.png` and
`-celebration.png`, on every figure, in the hero scene.
**Fix:** move the hair to `lift: 0.05, depth: 0.11` (top 0.16). Then add a build-time assertion in
`reliefMesh.ts` that no two overlapping polys in a scene have `|lift+depth|` within 0.005 of each
other, and run it over all five scenes. Re-check `dentistScene`'s head/hair pair
(`relief.ts:466-467`, tops 0.160 vs 0.155) for the same fault.

**G-SP-3 — BLOCKER — "Happy Family" has no smiles, floating heads, and nothing dental in it.**
`src/games/sliding-puzzle/relief.ts:495-517`. Line 511 gives every figure a **dead-straight
horizontal black bar** for a mouth, while `toothScene` (`:399-400`) and `dentistScene` (`:475-476`)
both build a real V-smile from two angled capsules. Body top = −0.18, head bottom = −0.10: the head
floats 0.08 board units clear with no neck, shoulders or arms. The scene contains no tooth, no
toothbrush and no smile — and it is the picture the child spends the whole game assembling.
**Fix:** give every figure the two-capsule smile from `relief.ts:399-400`; overlap body and head
(`bodyY −0.42` or `headY 0.10`) and add a neck capsule; put a toothbrush in at least one hand.
Re-render all five scenes and inspect **at final tile size**, not at composition scale.

**G-SP-4 — MAJOR — the lifted tile has no cast shadow and its contact blob dilates instead of translating.**
`src/games/sliding-puzzle/scene.tsx:711-716`, constants at `:139-140` (`BLOB_BASE 1.22`, `BLOB_SPREAD 0.9`).
The blob is written at the tile's own x/z and scaled to `tileSize × (1.22 + 0.9 × lift)`, so as the
tile rises 3 cm the only shadow under it gets 74 % wider, stays dead centred, and nothing offsets
toward the key at (−4, 7, 5). At 4× on f03 no distinct cast shadow is visible under the raised tile.
A shadow that grows and stays centred as an object rises reads as "this has no weight" — which is
why the (correctly coded) `LIFT_STRETCH`/`LAND_IMPULSE` squash does not land on screen.
**Fix:** offset the blob along the key's ground projection by `lift × keyDir.xz`, and
darken-and-tighten rather than spread; or lift the tile inside the shadow frustum and let the real
shadow map carry it (the tray already `receiveShadow`s at `scene.tsx:824`).

**G-SP-5 — MAJOR — the reference plaque is smaller, dimmer and worse-placed than the picture it explains.**
`src/games/sliding-puzzle/layout.ts:186` (`PLAQUE_W = 1.15` vs `BOARD = 3.0`), `:172` (`PLAQUE_POS[0] = 0.98`).
38 % of the board, parked off-centre, reclined 30°, visually colliding with the tray's back rim with
its lower third occluded. The child cannot see what they are building.
**Fix:** centre it above the board, raise it clear of the tray silhouette, and size it to ≥ 55 % of
board width.

**G-SP-6 — MAJOR — half the frame is empty and the tray tangent-clips the bottom edge.**
`src/games/sliding-puzzle/layout.ts:227-247`. In f07 (1100×562) the tray occupies y 290–535: **49 %
of the frame above the subject is empty cream** and the front lip sits 12 px from the bottom; in
`-tier-low.png` and `-reduced.png` it runs off the bottom entirely.
**Fix:** depends on S18 and a composite capture. Re-solve `HALF_HEIGHT`/`TARGET_Z` so the front lip
clears the bottom edge by ≥ 6 % of frame height and the plaque does not overlap the tray.

**G-SP-7 — MINOR — the empty cell is an unexplained brown smudge.** `blobMat` at 0.78 × tile size
renders as a blurred mud ellipse (f01/f03/f05). Nothing says "put a piece here."
**Fix:** replace with a recessed clay socket in the tray with a visible lip, or a soft accent-tinted
inlay that reads as a slot.

**G-SP-8 — MINOR — the picture parallaxes over its own tile edges.** `layout.ts:59` (`RELIEF_Y`) with
relief up to 0.28 proud at `ELEVATION = 42°`: chins overhang tile edges and the tray rim, so a tile
does not read as a self-contained piece — the single idea the game runs on.
**Fix:** reduce relief `depth` on tall pieces, raise camera elevation a few degrees, or add a thin
raised lip to each tile face plate so every piece has a visible frame.

**G-SP-9 — MINOR — a11y.** Slot labels are permanently `"Slot row R, column C"` (`scene.tsx:483-486`)
and the roving group name is the raw dev string `"sliding-puzzle-cells"`, read verbatim by VoiceOver
while every sibling game uses prose. Arrow keys are bound on `window` in capture phase with
`stopPropagation` (`SlidingPuzzle.tsx:163-194`), so the only way to move focus is an undocumented
Shift+arrow. **Fix:** rename the group to `"Sliding Puzzle tiles"`; state the Shift+arrow scheme in
the board's `aria-label`; add piece identity to the move announcement (see X4).

### 3.2 Maze Escape

**G-ME-1 — BLOCKER — the goal is unidentifiable.** `src/games/maze-escape/props.ts:126-130`,
`src/games/maze-escape/layout.ts` (`dishDepth`, `wallHeight`). The toothbrush stands
`cell*0.65 = 0.274` tall, sunk `0.92 × dishDepth = 0.066` into its dish → crown at 0.208, against
`wallHeight = cell*0.55 = 0.232`. **The toothbrush is shorter than the walls around it**, in an
alcove, at 60° elevation, so only its top end renders — a ~20 px beige coin. Its handle is
`clayAccent("coral","main")` = `#e8604c`, **byte-identical to `CLAY.gum`**, the walls it sits between.
The idle wag is gated on `NOTICE_CELLS = 2.7`, so it is invisible until the child has nearly finished.
**Fix:** lift the brush out of the dish, make it ~`cell*1.1` tall and cant it ~35° toward camera so
the bristle head reads in silhouette **above** the wall line; recolour the handle to
`clayAccent("mauve","main")` or `peach.deep`; replace the proximity-gated wag with a continuous idle
beckon visible from anywhere on the board.

**G-ME-2 — MAJOR — the hero is 30 px with a 6 px face.** `src/games/maze-escape/layout.ts`
(`TOOTH_RATIO = 0.62`), `props.ts:110-121` (eyes `softSphere(D*0.105)`, mouth `torusSoft(D*0.11, D*0.036)`).
In every captured play frame the face is occluded by a wall or rolled away. **Fix:** `TOOTH_RATIO ≈ 0.80`;
eyes to ~`D*0.16`, mouth to ~`D*0.17`. Orientation is already handled by the slerp-to-identity; the
problem is size. See X3.

**G-ME-3 — MAJOR — uniform albedo on the dominant surface.** Measured σ = 1.09 / 0.70 / 0.78 out of
255 across 8,000 px of coral wall top in `maze-escape-rest.png` — the single largest surface in the
frame, ~55 % of the board's pixels. **Fix:** depends on S16; additionally apply the existing floor
`relief` pass (`build.ts:283`) to the wall top faces so `bakeCurvatureAO` has something to bite on.

**G-ME-4 — MAJOR — start and goal markers are indistinguishable.** Two flat torus rings of near-identical
size (`cell*0.33` rose-soft vs `cell*0.3` peach-soft); peach-soft `#f8ead9` on ivory floor `#fbf6ec`
is a 5-point separation, i.e. invisible. The two treat designs read as 12 px debris.
**Fix:** make the goal marker a different *shape* and a `main`/`deep` tone; give the treats a silhouette
a child recognises as a sweet at 12 px, or scale them up.

**G-ME-5 — MINOR — focus ring invisible on gum.** `src/games/maze-escape/scene.tsx:994` billboards the
shared `FocusRing` over the coral block, where it measures 1.77:1 (1.23:1 on `gumDeep`). Fixed by
S14's two-tone contour; verify on this game specifically.

### 3.3 Tooth Match

**G-TM-1 — BLOCKER — the card back is a red first-aid cross, six-up, on the opening screen.**
`src/games/tooth-match/motifs.ts:81` — `emblemShape = lobedShape(4, 0.055, 0.2, 64)`. `rMax/rMin = 3.6`,
so the four lobes are far longer than the waist is wide and the shape renders as a **plus sign, not a
sparkle**. In `clayAccent("red","soft")` `#f7d9dc` on a `clayAccent("red","main")` panel
(`src/games/tooth-match/scene.tsx:547-548`) it is unmistakable at 3×: a pale cross on a saturated red
field, filling the frame, and it persists through every unmatched pair for the whole run.
Two independent failures: (a) `3D-SPEC §1.1` — a medical cross is the strongest clinical signal there
is, in a product built to make dentistry unfrightening; (b) the red-cross-on-light-ground emblem is
protected under the Geneva Conventions and, in the US, 18 U.S.C. §706 — it cannot ship in a
commercial product regardless of intent.
**Fix:** raise `rMin` to ≈0.13 so the lobes read as a rounded four-petal flower, rotate 45°
(`lobedShape` already offsets by −π/2; add π/4), **and** move the emblem off the red family —
`clayAccent("peach","soft")` on `clayAccent("coral","main")` removes the medical read entirely.
Render and confirm before shipping. Also re-check `starShape` at `motifs.ts:80`
(`lobedShape(5, 0.086, 0.222, 80)`, ratio 2.6) at final card size.

**G-TM-2 — BLOCKER — the motifs are invisible, so the memory game cannot be played.**
`src/games/tooth-match/motifs.ts:146, 152, 157, 170`. Four of eight motifs are ivory reliefs on an
ivory card face. Measured contrast on `tooth-match-celebration-c03.png`: **1.03:1** (right-column ball
motif vs its face) and **1.10:1**. WCAG's floor for a meaningful non-text graphic is 3:1.
`tooth` at line 146 is `clayEnamel` `#fdfaf3` standing on an inlay of `CLAY.enamel` `#fdfaf3` — the
exact same hex. In `c03.png` all six cards are face up and no pair can be identified by anyone.
**Fix:** every motif carries a distinct accent family at `main` or `deep` on its dominant mass, and
the card inlay stops being enamel-white. Concretely: `tooth` → keep enamel, set the inlay to
`clayAccent("mauve","soft")` so the ivory tooth reads as a silhouette; `paste` tube →
`clayAccent("mauve","main")` with the ivory cap inverted; `brush` head → `clayAccent("peach","soft")`;
`floss` loop → `clayAccent("rose","main")`. Target ≥ 3:1 measured **from a rendered frame**, not from
the hex values.

**G-TM-3 — MAJOR — a matched card is visually indistinguishable from a live one.**
`src/games/tooth-match/scene.tsx` (`startMatch` / `stepCard`). The only differences are a 0.04-unit
press and an idle bob amplitude of 0.0025 vs 0.006 — neither perceptible, and both zero under reduced
motion. In `m08.png` the resolved pair cannot be told from the unresolved cards.
**Fix:** on match completion, tint the card body toward `clayAccent(family,"soft")` over ~200 ms, or
press a visible ring into the inlay. The child needs to see the board shrinking.

**G-TM-4 — MAJOR — a matched card stays a live keyboard target with no cue.**
`src/games/tooth-match/scene.tsx:836` — `<HitTarget>` never receives `disabled`, though `hit.tsx:428`
supports it and `hit.tsx:482` correctly emits `aria-disabled="true"` (not the `disabled` attribute,
which would delete the roving tab stop). A screen-reader player walks eight solved cards to reach two
live ones and is told nothing.
**Fix:** set the attribute imperatively from the `match` event callback (reading engine state in
render would break the `deal`-only re-render contract). This is also the first real use of the
`disabled` path S5 needs product-wide.

**G-TM-5 — MAJOR — the card back has a uniform albedo and no readable bevel.**
`src/games/tooth-match/scene.tsx:547` (`backGeo` is a `roundedPlate` whose face is one plane with one
normal; bevel roll `CARD_CORNER - 0.045` is a ~4 px band at play distance). Measured std **0.42** on
the panel interior against **17.3** on the adjacent ivory body. `EMBLEM_DEPTH 0.028` shows no bevel
highlight at all.
**Fix (with S16):** widen the bevel roll so the curvature-AO band is ≥ 10 px at play distance, and add
a shallow crown to the plate top so it is not a single-normal plane.

**G-TM-6 — MAJOR — no press response on finger-down.** `scene.tsx:836` wires only `onSelect`;
`onPress`/`onRelease`/`onHover` (`hit.tsx:425-427`) are unused across the whole game folder, and
`FEEL.pressDown` / `FEEL.pressScale` / `FEEL.releaseOvershoot` exist at `anim.ts:302-304` for exactly
this. The first thing a child sees on finger-down is the flip's own counter-dip travelling *away* for
104 ms. **Fix:** kick the card's existing `squash` spring on `onPress` and the other way on `onRelease`.

**G-TM-7 — MINOR — a flip announces a bare noun.** `ToothMatch.tsx` `case "flip": announce(MOTIF_LABELS[event.id])`.
**Fix:** `` announce(`Card ${event.index + 1} shows ${MOTIF_LABELS[event.id]}.`) ``. See X4.

**G-TM-8 — MAJOR — framing is solved from the card grid, not the tray.**
`src/games/tooth-match/layout.ts:143-166` builds `halfHeight` from `grid.depth` (2.03 at level 0) while
`trayFor` (`layout.ts:98`) adds a full unit of clay — the object actually being framed is 3.03 deep.
Measured on `tooth-match-rest.png` (822×671): board centre at **67.7 %** of frame height, top **35.6 %**
empty cream, tray bottom lip flush at **99.9 %** with its own contact shadow cropped.
**Fix:** solve the framing from the tray's outer extent plus the shadow radius, then re-tune `shift`.

### 3.4 Healthy or Not?

**G-HN-1 — BLOCKER — the "no thank you" verb is a disembodied fist on a stump.**
`src/games/healthy-or-not/props.ts`, `src/games/healthy-or-not/scene.tsx:1429-1446`.
A severed forearm with a brown cuff, standing upright on the table, is the entire affordance for half
the game's input. Nothing identifies it; it has **no idle gesture at rest** (frames f07–f09 are
motionless — the only wave is a 21° reactive tilt *after* the tap), so a child cannot learn it by
watching. The affordance is carried entirely by text a four-year-old cannot read. And the tooth itself
is not a hit target: only the food and the hand are registered, so both preschool instincts —
drag the food to the mouth, or tap the tooth — do nothing.
**Fix:** replace the hand with an object whose shape carries the meaning (a lidded bin, a second plate
with a soft "no" mark, a friendly chute); give it a slow idle (a lid breathing open a few degrees on a
2 s loop); and register the tooth as a third hit target routed to `engine.answer("feed")`.

**G-HN-2 — BLOCKER — scale violation, and it is the root cause of the celebration interpenetration.**
`src/games/healthy-or-not/layout.ts:22` — `TOOTH_H = 1.9`. `3D-SPEC §2`: 1 world unit = 10 cm, a hero
tooth prop is ~1.0 unit tall, *keep every game in this scale so shared lighting, fog and shadow read
identically*. `src/three/celebrate.tsx:64` obeys it (`TOOTH_HEIGHT = 1.05`). At 1.81× the specified
scale the two teeth in the celebration read as different objects at different sizes, and the cast
shadow penumbra reads harder than the shared tuning intends.
**Fix:** bring `TOOTH_H` to ~1.05 and pull the camera in via `cameraFor()` to keep the framing.

**G-HN-3 — MAJOR — the mascot's mouth is geometrically a flat line and its face is intersecting spheres.**
`src/games/healthy-or-not/layout.ts:57` (`MOUTH_SHUT_HN = 0.026`), `props.ts:458-462`.
The eye, mouth, tongue and cheek are all the same `ball` geometry, scaled flat and pushed through the
crown. At 10× the mouth terminates in **square-cut aliased stubs** with a bright lip band — an
unresolved boolean intersection, not a mouth; the cheeks are boxy flat patches with essentially no
shading gradient while the surrounding surface falls two stops through the same region. `3D-SPEC §0`:
"there is no hard edge anywhere in this product." And the product's hero character does not smile at
rest — the comment calls it "a smile line"; the render is a deadpan dash.
**Fix:** build the mouth as a lathed torus segment swept along the crown normal, curved into a real
smile; bake the cheeks as vertex-colour blush on the crown (so they shade with the form for free) or
offset a spherical patch along the crown normal so the boundary is tangent rather than secant.

**G-HN-4 — MINOR — unbounded cache-key growth on resize.** `scene.tsx` calls `discFor(layout.tableR)` /
`rimFor(layout.tableR, TABLE_RIM_TUBE)`; `geometry.ts:854-880` keys on the radius, and
`layoutFor(aspect)` derives `tableR` from the aspect quantised to 0.05 — so a window drag mints a
permanent new geometry per distinct aspect.
**Fix:** quantise `tableR` itself to three or four values covering portrait/square/landscape.

### 3.5 Spot the Difference

**G-SD-1 — BLOCKER — `BACK_Z` is wrong by 0.25 units and six props, including one of the five
differences, are buried inside the back wall.**
`src/games/spot-the-difference/layout.ts:27` — `export const BACK_Z = -ROOM.depth + ROOM.rim; // -1.44`
assumes the tray floor is `rim` (0.26) thick. `buildClayTray` (`src/three/geometry.ts:979`) sets
`floorTop = max(height * 0.3, baseRoll + 0.01) = max(0.51, 0.101) = 0.51`. The tray sits at z = −1.7
rotated +π/2 about X, so the **inner back wall is at z = −1.19**, not −1.44. (The side-wall
generalisation is correct, which is why `FLOOR_Y` and `INNER_X` are right.)
Buried: mirror frame (`diorama.ts:334`), mirror glass (`:338`), `star1`/`star2`/`starExtra`
(`:341-344`), window frame and emissive sky panel (`:445,454`). Confirmed by arithmetic, by projecting
the mirror centre with the captured camera onto blank wall in a contrast-stretched crop, and by the
same voids in `-reduced.png` and `-tier-low.png`.
Consequences: difference #3 ("star") is **unfindable by sight** — in play 60 % of Easy runs, 80 % of
Medium and **always on Hard** (`engine.ts:44`, `COUNT = [3,4,5]`); two more of the eight checkable
spots point at nothing, so keyboard focus rings for "Mirror" and "Little window" render behind a wall
(WCAG 2.4.7); the upper 45 % of the room is empty because its set dressing is invisible; and the
buried props still `castShadow`, costing shadow-pass draws for nothing.
**Fix:** derive the back wall from the geometry rather than guessing — export the real value from
`clayTray` and import it, or at minimum
`-ROOM.depth + Math.max(ROOM.depth * 0.3, ROOM.rim * 0.35 + 0.01)` (= −1.19) — then re-space the wall
props forward (stars need ≥ 0.03 clearance, not 0.2 behind). Note `?selftest=spot` **cannot** catch
this: `expectedBoxes` (`scene.tsx:709`) derives its regions from the same buried geometry.

**G-SD-2 — BLOCKER — Spot renders the entire R3F scene twice, including other games' Views.**
`src/games/spot-the-difference/scene.tsx:438-458`. The panel loop calls `gl.render(state.scene, camera)`
twice with per-panel scissors, and `state.scene` is the single R3F root containing **all** drei Views.
Only `world.visible` is toggled (`:437`/`:458`), so the celebration View (`GameShell.tsx:341`, index 3)
is drawn into **both** panel viewports with Spot's camera. That is why celebration draw calls hit 83
and triangles 456,854, and it is the mechanism behind the reported duplicated-celebration artefact.
Cost on a tablet: two full scene traversals plus the shadow pass, three per frame, at 75 draw calls in
play (83 % of budget).
**Fix:** render only Spot's own subtree — `gl.render(worldRef.current, camera)` against a dedicated
scene — or hide every non-`world` root child for the duration of the loop and restore after. Also stop
rendering both panels while the celebration overlay is up.

**G-SD-3 — BLOCKER — the "oops" feedback is a 1.6-pixel pale hairline on a cream wall.**
`src/games/spot-the-difference/diorama.ts:489-492` + `scene.tsx:590`. The miss ripple is
`torusSoft(1, 0.055, 2)` in `clayAccent("mauve","soft")` `#efdfda` against a wall measuring `#f3e5d2`.
Peak scale is `RIPPLE_MAX × 1.15 = 0.53`, so the tube is 0.029 world units ≈ **1.6 px** at the measured
56.7 px/unit, for 0.55 s, partially clipped by the floor lip — sub-pixel on a phone. Missing a
difference is the most common thing a child does in this game, and its only visual answer is invisible.
**Fix:** a filled soft disc or thick annulus at ≥ 6 px effective stroke, in `ACCENTS.mauve.main`
(`#c08475`) not `.soft`, drawn on the `RIPPLE_Z` plane with `depthTest: false` and a `renderOrder`
above the props so the room cannot occlude it.

**G-SD-4 — MAJOR — the found-ring renders as a broken arc buried in the wall, in the game's colour.**
`src/games/spot-the-difference/diorama.ts:533`. Ring #4 sits at z = −1.14 with r = 0.82 and tube
0.062, so its back surface is at z = −1.20 — 0.01 *behind* the real wall face (G-SD-1's root cause
again). Visible in all three celebration captures as a large orange "C" with a chunk missing plus a
disconnected stub; the towel ring (`:515`) passes behind the counter and reads as broken. Separately
`ringMat` is `clayAccent("peach","main")` `#efa160` — the *same colour as the duck and towel A*, so a
found-ring around the duck is orange on orange.
**Fix:** put every ring on a single `RING_Z` plane in front of the room with `depthTest: false`, and
pick a ring colour that is not also a prop colour.

**G-SD-5 — MAJOR — `ASPECT_MIN = 0.75` lets the solver pick panels much taller than the picture.**
`src/games/spot-the-difference/layout.ts:91`, `:263-264`. `cameraFor` fits `HALF_X = 3.4` horizontally
while `DIORAMA_ASPECT` is 1.44, so any panel narrower than 1.44 letterboxes — and the whole
[0.75, 1.44) band is reachable. Measured on `-rest.png`: panel 386×439 → required vertical half-extent
3.87 against a 2.1 half-height room, so the diorama fills **54 %** of the panel with 23 % dead cream
above and below. The row-vs-column solver is not wrong; the aspect floor is.
**Fix:** `const ASPECT_MIN = DIORAMA_ASPECT;` (1.44). Re-check the column path at 553×667, which
currently lands at 313×193 and frames correctly.

**G-SD-6 — MINOR — `?selftest=spot` ships red.** `selftest.json`: 2 differing pixels in one run
(clusters at 486,263 and 490,263), 1 in the next (499,277), isolated 1×1 on a 778×882 panel. Unstable
across runs → MSAA resolve phase, not camera/fov/exposure divergence; the scene genuinely does what
`§6.5` asks. **Fix:** round the viewport origins to even device pixels so both panels land on the same
MSAA sample grid; only if that fails, tighten the assertion to "no cluster larger than 1×1 outside the
expected boxes" **and say so in the failure text** — do not just widen it.

**G-SD-7 — MINOR — the towel is two plastic slabs.** `diorama.ts:433-437` — a
`roundedBox(0.62, 0.6, 0.13, 0.055)` plus `roundedBox(0.6, 0.11, 0.17, 0.048)`. No drape, no fold, no
thickness variation. It is one of five comparison props and the second-most-likely to be tapped, and
it sits two props from the duck, which is genuinely well made. The material (roughness 0.88, sheen
0.55, grain 0.22) is already right; the geometry is not.
**Fix:** build it as a lathed/strip drape with a lip roll and a soft asymmetric fold.

**G-SD-8 — MINOR — stray neutral-grey bars outside the diorama.** Measured `#8a877b` at x 732–745 in
`-rest.png` (independently reported as "a grey squiggle poking out of the right edge of both
dioramas"). Nothing neutral-grey at L\* 56 should exist in this product; likely leaking geometry from
the double-render in G-SD-2. **Fix:** re-check after G-SD-2 lands; if it persists, find and cull it.

**G-SD-9 — MINOR — the found pop has no wind-up.** `scene.tsx:298` — `anim.pop.value = POP_SCALE` is a
one-frame jump from 1.0 to 1.24. `anticipate()` exists in `anim.ts` and `§4` asks for a 50–80 ms
opposite dip. A 60 ms squash to ~0.96 before the pop costs nothing and lands the reward.

### 3.6 Tooth Rescue

**G-TRS-1 — BLOCKER — the falling tooth has 1.17:1 contrast against what it falls through.**
`src/games/tooth-rescue/scene.tsx`, `src/games/tooth-rescue/layout.ts`. Measured on
`tooth-rescue-f05.png`: tooth mean `(224,211,193)`, background `(236,230,218)`. Only the darkest root
reaches 3.0:1 against the brightest background pixel. It occupies 24×34 buffer px in a 602×376 view
(0.36 % of frame area). The one object the game is about is effectively invisible.
**Fix:** separate the drop lane's value from the props — a darker back wall, a tinted drop corridor,
or warm cream fog that actually reads in the upper frame — and/or re-tone the falling tooth toward
`CLAY.enamel` with a stronger rim-light contribution, and enlarge it. Target **≥ 3:1 mean contrast**
against whatever it falls through, verified by the same measurement. See also X3 (give it a face).

**G-TRS-2 — BLOCKER — the basket trim reads as blood running down a tooth.**
`src/games/tooth-rescue/layout.ts` (`trimLayout`) + `clayAccent("red","main")`. A horizontal saturated
red band across the front of an ivory, tooth-coloured tub with four red prongs hanging down from it.
The stated intent is woven-basket slats. In a children's dental app the most available read is blood,
which `3D-SPEC §1.1` bans outright. Two further defects in the same geometry: the end slat is seated
with 0.95 mm inside the wall and 4.55 mm hanging in free air (the end band with 0.3 mm), so they read
as floating fins, and they cross at `BAND_Y = 0.5` producing a **hard dark interpenetration notch** —
`§0` "no hard edge anywhere".
**Fix:** re-author the weave as proud/recessed clay geometry in the tray's own ivory with an accent
only in the rolled band, or move the accent to a family that cannot read as blood. Merge slat and band
into one geometry, seat both at least one `WALL` deep, and run `bakeCurvatureAO` on the result so the
accent picks up the same bevel and occlusion as the tray.

**G-TRS-3 — MAJOR — zero triangle headroom during play: 176,608 of 180,000 (98.1 %), constant.**
`src/games/tooth-rescue/scene.tsx` (instancedMesh block). All 22 tooth + 10 candy + 20 candy-end
instances are submitted every frame with `frustumCulled={false}`, and free bodies are only scaled to
zero — `tooth-rescue-enter.json` reports the identical 176,608 at entry with nothing in flight.
3,392 triangles of margin on a mid-range Android tablet.
**Fix:** track a live high-water mark per pool and set `mesh.count` to it each frame. Keep the
matrices; drop the submissions.

**G-TRS-4 — MAJOR — 55 % of the play viewport is one flat page-coloured value, and the set's own edges
are in shot.** Measured `#E8E0D8` over 55.0 % of the play rect (73.9 % cream+tan). `layout.ts`'s own
comment claims the mat is "wider than the frame, so its side edges are never in shot"; measured, the
mat spans x 372–1140 and the near kerb 440–1075 inside a view rect of x 340–1160 — both terminate
in frame with visible cut ends.
**Fix:** extend `matGeo`/`riserNearGeo` past the solved `halfX` at their depth so no edge is ever
framed; dress the upper 40 % with real geometry and value separation, or re-frame so the drop fills
the shot.

**G-TRS-5 — MINOR — the basket spring is outside the mandated band.**
`src/games/tooth-rescue/scene.tsx` — `BASKET_STIFFNESS = 90`, `BASKET_DAMPING = 15` against
`3D-SPEC §4`'s 260–420 / 18–28. ζ≈0.79, ~200–300 ms arrival against a 0.83 s level-2 fall time, on the
one object under the child's finger for the entire 30 seconds.
**Fix:** raise into the band and re-tune `BASKET_MAX_SPEED` around it.

**G-TRS-6 — MINOR — orphan contact darkening.** `f08.png` shows a dark ellipse on the mat at ~(455,470)
with no object above it; `-reduced-after-interaction.png` the same at ~(680,522). The blob is written
at `STAGE_Y + 0.012` at the body's x/z regardless of the body's height above the *kerb* it may be
resting on. **Fix:** suppress or re-seat the blob when the supporting surface is not the mat.

### 3.7 Count the Teeth

**G-CT-1 — BLOCKER — the countability guarantee is not enforced; the game deals boards that cannot be counted.**
`src/games/count-the-teeth/scene.tsx:~800-830` (`solveRound`) against `docs/3D-SPEC.md:219-221`.
The spec makes ≥ 75 %-unoccluded-from-the-game-camera a **runtime guarantee** and says the generator
"resamples *until*" it holds. The implementation tries three free-form draws, falls back once to the
safe-band layout, then does `st.lastRatio = ratio` and ships whatever it got — there is no rejection
path. `selftest.json` records a level-2 / 14-tooth board at **36.9 % unoccluded** and an analytic pair
margin of **5.36e-7 world units** (two teeth touching) across 4,080 boards. Visible at only six teeth
in `-reduced.png`. On a game whose single verb is *count*, and which re-asks the round until the child
guesses right.
**Fix:** make the fallback terminal — loop the safe-band solve with monotonically increasing separation
until `measure()` clears `MIN_UNOCCLUDED`. If `MAX_COUNT = 14` cannot be laid out countably at the
current framing, cap the level-2 range or pull the camera back rather than accepting an ambiguous
board. Do this together with S8, which moves the solve off the render frame.

**G-CT-2 — BLOCKER — the answer tiles are clipped by the bottom of the play area at every viewport tested.**
`src/games/count-the-teeth/layout.ts:516-538` (`cameraFor`), `:497` (`MAX_DISTANCE = 16`).
Measured tile-ivory pixels on the final rendered row: 201 (`f01`, 1100×562), 240 (`-rest`, 1500×766),
220 (`-reduced`, 1300×663), 235 (`-celebration`). These are the game's only controls and only 48 px
targets; a target bisected by the viewport edge is not 48 px in the clipped axis whatever
`HitTarget.minScreenPx` computes. `cameraFor` lifts the aim by half the `CHROME_PX = 138` band and then
clamps at `MAX_DISTANCE`, pushing the composition out the bottom.
**Fix:** raise `MAX_DISTANCE` above 16 or reduce `V_MARGIN`/`CHROME_PX` so the solve is not clamped, and
add an assertion that `screenUp(0, TILE_FRONT_Z)` projects at least `TILE_D/2 + margin` above the
bottom of the rect at every aspect the shell can produce.

**G-CT-3 — MAJOR — the props do not read as teeth.** `src/three/geometry.ts:1130-1151` (used at
`scene.tsx:441`). The "baby" kind renders from this near-top-down camera as a dimpled sphere with two
~8 px root nubs — a mushroom, a garlic clove, a bread roll. The proof is in the product's own frame:
`-celebration.png` puts an unmistakable molar directly beside four of these blobs. Same screen, two
different tooth languages, one of them legible.
**Fix:** lengthen and splay the roots so the silhouette carries the tooth read from a top-down camera,
**or** lower the camera pitch so the crown/neck/root profile is visible, **or** switch the counted prop
to the `molar` kind. Pick one and check it against the celebration hero in the same frame. See X3.

**G-CT-4 — MAJOR — there is no contact shadow under the teeth.** `src/games/count-the-teeth/scene.tsx:955-961`.
The per-tooth blob is written at `radius * 2.5 * grow * (0.5 + 0.5 * contact)`. Measured mean pad R in a
100×60 box directly under the front-left tooth: **185.9**; under the lower-right tooth **188.0** —
against **187.7** for open pad 100 px away. The blob contributes under 1 % of darkening; grounding
comes entirely from an offset directional lobe, so the teeth read as stickers pasted on the mat.
**Fix:** raise blob opacity and tighten its radius so it pools at the actual silhouette-to-pad contact,
and verify against a reference pad sample rather than against "it is in the buffer".

**G-CT-5 — MAJOR — the answer tiles stay on screen through the celebration.** `-celebration.png` shows
live-looking "2 3 4" tiles, still clipped, under a DOM "Play again". **Fix:** retract or fade the tiles
on the `complete` event (and set the `celebrating` flag from S4).

**G-CT-6 — MINOR — idle life is below display resolution.** `scene.tsx:934-936` — `bob = sin(...)*0.0035`
and `sway = sin(...)*0.01 rad` work out to ~0.2 px and 0.57° at this framing. Not "subtle" — off.
**Fix:** raise until the motion is at least 1.5 px at the design framing, or drop it.

**G-CT-7 — MINOR — a blind player faces a 1-in-3 guess.** `CountTheTeeth.tsx:106-133` announces the three
candidate answers and never the arrangement or an enumerable cue. `sounds.pop()` already fires per
tooth at `scene.tsx:895`. **Fix:** stagger the per-tooth pops audibly (including under reduced motion)
and announce "listen for the taps", or add a "hear the count" control. See X4.

### 3.8 Tooth Runner

**G-TRN-1 — BLOCKER — the celebration composition is decided by a modulo.**
`src/games/tooth-runner/props.ts:405-425`, `src/games/tooth-runner/layout.ts` (`NEAR_Z0 = -46`,
`NEAR_SPAN = 58`), `src/games/tooth-runner/engine.ts` (`STOP_LAMBDA = 2.6`).
Arches recycle in the near band, wrapping at z = +12, while the camera sits at ~z = +8.2, y = +2.80 and
the arch crown tops out at 2.24–2.59 — so the camera flies *over* the arch and the tube sweeps across
the lower frame at point-blank range every time one passes. At the end of a run the world coasts
asymptotically to a stop, so **wherever the arch happens to be when the clock expires is the
celebration composition**. `tooth-runner-celebration.png` drew a featureless coral slab over the bottom
60 % of the frame with the hero squeezed into the top fifth.
**Fix:** on `complete`, drive the world forward a solved distance so no near-band instance lies inside
the camera's near volume before the celebration arms — or set `mesh.count = 0` on arches and kerbs
during the 0.3 s `FINISH_DELAY`. Do not ship a finale whose framing is a lottery.

**G-TRN-2 — MAJOR — the largest prop in frame has a visible polygonal silhouette.**
`src/games/tooth-runner/props.ts:410` (`torusSoft(1, 0.09, lod(2))`) and `props.ts:110` (`lod` caps at
`getQuality().detail`, so the arch is **permanently capped at detail 2** on every device).
`geometry.ts:917-937` maps that to 26 tubular segments on default and **16 on low** — 22.5° per chord
on a 2.5-unit ring. `tooth-runner-tier-low.png` shows an unmistakable polyline with a sharp chevron at
the crown; the chords are still readable at default tier in `-rest.png`. `3D-SPEC §3` forbids hard
silhouette edges.
**Fix:** the arch is 4 instances, not 40 — remove the `lod` cap on it entirely and let it take
`getQuality().detail`, or raise `torusSoft`'s tubular segment counts to 24/40/64. The headroom exists
(play-time is 96,964 of 180,000).

**G-TRN-3 — MAJOR — the roadside "giant toothbrushes" read as matchsticks.**
`src/games/tooth-runner/props.ts:471-491` — a `roundedBox(0.26, 2.1, 0.26)` ivory stick with a
`roundedBox(0.44, 0.6, 0.36)` red block on top. No bristles, no flat head, no neck, and nothing like
the collectible brush at `props.ts:182-186`, so the world's visual vocabulary contradicts itself while
the core verb is "grab the brushes".
**Fix:** add a bristle field (an instanced row of short capsules or a jittered `roundedBox` cluster) and
a neck between handle and head, and match the head's proportion to the collectible.

**G-TRN-4 — MAJOR — the first touch produces no response.**
`src/games/tooth-runner/ToothRunner.tsx:230-237` (the "Tap to run" pill) and `:241-248` (the "Sticky!"
chip) enter on `lumi-rise` (`src/index.css:103-112`) — a plain opacity + `translateY(14px)` with **no
overshoot keyframe** — and **exit as a one-frame unmount cut** with no `AnimatePresence`. The pill
carries `pointer-events-none`, so `.grad-btn`'s press states never fire on it. And
`engine.jump()` deliberately returns after `started = true`, so the first tap does not jump: the pill
vanishes, nothing moves, and the world ramps up on `damp(…, SPEED_LAMBDA = 3.4, dt)`. Zero
anticipation, zero overshoot, zero pop on the most important interaction in the game.
**Fix:** wrap both in `AnimatePresence` with a scale-pop exit (`easeOutBack(1.6–2.0)`, ~150 ms); add an
overshoot keyframe to `lumi-rise` or replace it with a framer-motion spring in `§4`'s band; add a
`≤150 ms` reduced-motion branch; and make the first tap produce a visible character response.

**G-TRN-5 — MAJOR — all four springs are outside the mandated damping range.**
`src/games/tooth-runner/scene.tsx:205-208` — `squash(380, 17)` ζ=0.44, `wobble(300, 9)` **ζ=0.26**,
`lurch(260, 12)` ζ=0.37, `hop(280, 15)` ζ=0.45, against `3D-SPEC §4`'s 18–28. The wobble spring decays
only 43 % per cycle, so a stumble rings for five-plus visible oscillations — rubbery, exactly what
`impactSquash`'s own comment warns against.
**Fix:** raise to the band (`wobble` → 300/20 minimum). If the ring is deliberate comedy, amend `§4`
rather than silently violating it.

**G-TRN-6 — MAJOR — the rolling hero is unreadable.** See X3. `f05` (airborne, stretched, rolled) is a
smooth egg; `f09` a featureless white ball; `f01`/`f06` show roots skyward. At 1.5 rev/s the character
presents no tooth silhouette for much of every second, and a tooth repeatedly showing its roots to the
sky is a poor read for a dental brand.
**Fix:** put the face on a node **outside** `rollRef` so it counter-rotates and stays camera-facing (the
existing graph makes this trivial), **or** clamp `roll` to ±35° with a spring return so the crown always
faces forward and the motion reads as effort rather than as a ball rolling.

**G-TRN-7 — MINOR — the stumble shake bypasses the camera rig's structural clamp.**
`src/games/tooth-runner/scene.tsx` (`SHAKE_AMP = 0.05`) translates the *world group* by up to 0.05 units
on top of `CameraRig`'s 0.06-unit breathe, so combined displacement can reach ~0.11 against `§4`'s
≤0.06 cap. Decays over 0.3 s, so not queasy — but it is outside the cap and it defeats the clamp by
moving the world instead of the camera. **Fix:** route it through `rig.shake(strength)` so
`camera.ts:141-146`'s saturation and decay apply.

**G-TRN-8 — MINOR — item/tooth interpenetration on a bump.** `f04.png` and `f06.png` show the bumped
donut drawn intersecting the tooth's roots: `resolve()` sets `ITEM_BUMPED` with `vz = 2.6` but the item
continues from its collision position, which is inside the tooth. **Fix:** offset the item's Z forward
by the tooth's half-depth before the debris arc starts, or add a lateral `vx` so it clears the body.

### 3.9 Smile Maker

**G-SM-1 — BLOCKER — the magnetic snap drives every top-anchored accessory through the character's head.**
`src/games/smile-maker/scene.tsx:664-668`, `:173-176`. The flight is a straight lerp from shelf slot to
anchor plus `a.arc * sin(k·π)` with `SNAP_ARC = 0.05` — five millimetres of arc against a 1.5-unit-tall
head — so for the three `top`-anchor accessories (Hat, Party Hat, Crown) the path passes straight
through the face. `smile-maker-f02.png`, two frames after the Crown is activated, shows it buried
through the middle of the skull at eye level, covering one eye. This is a glitch frame on the normal
path, in the shipping build.
**Fix:** replace the straight lerp with a quadratic Bézier whose control point sits above the anchor for
above-head anchors, or scale `SNAP_ARC` per anchor to clear the head bounding sphere, so a hat always
arrives from above.

**G-SM-2 — MAJOR — the shelf ring has a 1–3 px black seam instead of a bevel.**
`src/games/smile-maker/build.ts:747-765` (`shelfRingGeometry`). The corner is **one straight chamfer
segment** (`[r1-0.035, top] → [r1-0.005, top-0.03] → [r1, 0.03]`) on a 48-segment lathe of radius 1.52 —
~4 px wide at the rendered scale, facing away from the key. Measured vertical profile at x=570:
`207 → 110 → 93 → 174` (a 55 % luminance drop in one pixel); at x=560: `208 → 123 → 87 → 140 → 207`.
In `-rest.png` the outer rim aliases into a broken dashed dark line. `§0` "no hard edge anywhere",
`§3` "minimum bevel radius 0.02 units".
**Fix:** replace each corner with a 3–4 point arc of radius ≥ 0.03 and raise the lathe to ≥ 64 segments
at this radius; verify the edge resolves to ≥ 6 px of gradient at the design framing.

**G-SM-3 — MAJOR — the booth fills 14.2 % of the frame.**
`src/games/smile-maker/layout.ts:174` (`HALF_HEIGHT = 2.1`), `:179` (`CONTENT_SHIFT = -0.3`).
`HALF_HEIGHT` reserves vertical extent up to a party-hat tip that actually sits on the *shelf*, not
above the tooth, so `cameraFor` solves `forHeight ≈ 12.8` against `forWidth ≈ 6.4` and pushes the camera
to 12.8 units. Measured on `-rest.png` (822×670): booth bounding box **381 × 353**, 441 px of bare cream
to the sides, 120 px of dead cream between the title band and the tooth. `§6.9` asks for "a **big**
orbitable tooth"; on a phone this is ~30 px tall.
**Fix:** solve `HALF_HEIGHT` from the actual rendered bounds (tooth top + tallest *attached* accessory),
not from a shelf prop's tip, and let the width solve win when it does.

**G-SM-4 — MAJOR — the turntable is an ellipse that only looks round from one elevation.**
`src/games/smile-maker/layout.ts:44` (`RING_Z = 1.9`). The ring is stretched 1.9× along Z so it projects
to a near-circle at the hero elevation only — and the game's core secondary interaction is orbiting it.
`smile-maker-orbit-02.png` shows the "round" turntable as a visibly elongated oval with inconsistent
front-to-side prop spacing. A prop that changes shape when you turn it is not a physical object.
**Fix:** make the ring genuinely circular and get the slot spacing from a larger radius plus a slightly
higher elevation, or lock the orbit's elevation band tight enough that the cheat never becomes visible.

**G-SM-5 — MAJOR — ten separate tab stops, no roving group; window-level arrow capture with no guard.**
`src/games/smile-maker/scene.tsx:1600` mounts ten `HitTarget`s with no `group=` prop, so `hit.tsx:479`
gives every accessory `tabIndex 0` — a keyboard child Tabs past ten accessories to reach `Snap!`. Every
other game uses the roving pattern (`tooth-match/scene.tsx:839`, `sliding-puzzle/scene.tsx:856`,
`count-the-teeth/scene.tsx:1157`, `healthy-or-not/scene.tsx:1431`, `spot-the-difference/scene.tsx:484`).
The orbit's window-level arrow listener calls `preventDefault` unconditionally with no `activeElement`
guard, killing page scroll.
**Fix:** put the accessories in a focus group; move the orbit off bare arrows onto a modifier or a
dedicated "turn" control so arrows drive focus like everywhere else; guard the listener.

**G-SM-6 — MAJOR — five of ten accessories draw under 48 px on their short axis.**
Measured on the 822×670 play area of `-rest.png`: flower 34×29, mustache 47×27, sunglasses 52×30,
bowler 37×50, balloon 40×39, glasses 55×42 — and the plain-glasses temple arms are 2 px wide, aliased
into dashes. `hit.tsx:610` inflates the invisible collider so the *hit* target clears 48 px (the spec's
letter is met), but a four-year-old aims at what they can see.
**Fix:** depends on G-SM-3 — re-framing to fill the frame recovers most of it; then raise the smallest
accessories' modelled size so nothing draws under 48 px on its short axis at the design framing, and
thicken the temple arms.

**G-SM-7 — MAJOR — 31 live programs at rest, 35 during the polaroid, against a 28 budget.**
`src/games/smile-maker/build.ts:371-382`, `:661-663`, `smile-maker-perf.json`. Flagged by the app's own
`__perf.violations`. **Fix:** consolidate material variants (this game uses `clayAccent` across five
families plus `clayPainted` and `clayEnamel`); combine with X2's single-family discipline and S9's
precompile.

**G-SM-8 — MAJOR — the face is flat decals, and the dressed result reads as masked and stitched.**
The eyes and dotted smile are flat black marks with zero relief on an otherwise fully modelled body —
vinyl stickers on clay. In `-dressed.png` / `-s04.png` / `-s06.png` opaque dark-red sunglasses fully
hide the eyes, the mouth is a **row of nine dots** reading as stitches, and crown + shades + red cape
produces a masked, spiked figure — and that is the polaroid keepsake the child leaves with.
**Fix:** emboss the eyes and smile as real indentations that shade with the form; make the sunglasses
lenses translucent so the eyes stay visible; replace the dotted mouth with a continuous curved smile.

**G-SM-9 — MINOR — `Snap!` ships `disabled`.** `src/games/smile-maker/SmileMaker.tsx:180` renders the
biggest, brightest button disabled while `wornCount === 0`, with no visible reason. The child who
presses the most attractive control first gets nothing. **Fix:** keep it enabled; play a friendly
"put something on first!" announce plus a prop wiggle (`§1` — the child cannot lose).

**G-SM-10 — MINOR — `applyOrbit` discards the camera rig's angular breathe.**
`src/games/smile-maker/scene.tsx:634` — `cam.lookAt(framing.tx, framing.ty, framing.tz)` overwrites
`camera.ts:184-213` every frame; only ~0.2° of residual from positional breathe survives.
**Fix:** read the rig's breathed aim point instead of the static framing target.

**G-SM-11 — MINOR — keyboard activation consumes a wind-up that never renders.**
`hit.tsx:161` routes keyboard activation through `el.click()`, firing `onPress` (`beginDrag` →
`pop.impulse(-2.4)`) and `onSelect` (`engine.toggle` → `startFlight`) in the same tick, and
`scene.tsx:730-734` folds the pop into position immediately. Visible in `f01→f02`: no wind-up frame
exists. **Fix:** give `startFlight` its own 3–5 frame wind-up when the pop spring has not yet travelled.

**G-SM-12 — MINOR — `capture()` leaves scissor test off.** `src/games/smile-maker/scene.tsx:1315` calls
`gl.setScissorTest(false)` and never restores it; correctness depends on drei's `<View>` re-asserting
scissor state on the next render. **Fix:** save and restore it alongside the clear colour, which the
same function already does correctly.

---

## 4. VERIFIED CORRECT — do not regress while fixing the above

These were checked by multiple critics against source and pixels and are genuinely right. Several of
the fixes above touch the same files; leave these alone.

- **Zero per-frame allocation in every `useFrame`.** All nine games plus `celebrate.tsx` and
  `physics.ts` use module-level scratch (`_mat`, `_pos`, `_scl`, `_quat`, `_euler`, `_squash`),
  indexed `for` loops, no closures, no `map`, no literals. A brace-matched sweep of every `useFrame`
  body returned 57 apparent hits, **all false positives** (`setMatrixAt`, `setScalar`, `setFromEuler`,
  `setViewport`). `removeBody` is swap-remove, not splice. This is the best part of the codebase.
- **Zero per-frame React renders.** Every scene is `memo`'d on an engine identity that never changes;
  engines mutate refs and emit on discrete events; the only recurring render is `useTicker` at 1 Hz.
- **No source assets.** No `.glb/.gltf/.fbx/.hdr/.exr/.ktx2`, no `TextureLoader`, no CDN model or
  texture fetch. Manrope is the only network asset. Every model is procedural, every texture generated.
- **Manrope is the only typeface, including in-world canvas text.** `src/three/text.ts:43` is the only
  `ctx.font` in the product, `ensureManrope()` blocks on `document.fonts.load`, and the requested
  weights in `index.html` match `text.ts`'s `WEIGHTS` exactly so nothing is synthesised.
- **Colour management.** `clayGround` renders back at `#ece6da`, **dE2000 0.5** from `NEUTRAL.page`,
  in all nine games. Zero off-hue pixels, zero blue pixels, zero max-channel clipping across all 163
  PNGs — no unclamped white light anywhere.
- **The lighting rig is not three-point and not a bare directional.** Code-built PMREM studio (warm key
  softbox, cream bounce card *below*, cool rim strip as white-balance control, `skyIntensity 0.34`
  dome) plus one shadow-carrying directional. Measured: saturation and warmth **rise** into shadow on
  every scene; shadow-floor hue 62°–92° in all ten scenes, never lavender; key from upper-left in all
  ten. `SHADOW_PENUMBRA` is converted from a fixed *world* size into texels, so softness is
  framing-independent. `shadowNormalBias 0.006` keeps props attached to their own shadows.
- **`CameraRig` breathe caps are structural, not tunable.** `BREATHE_COMPONENT = 0.06/√3` and
  `BREATHE_ANGULAR_SHARE = 0.7` mean the spec's ceiling cannot be exceeded by editing one number;
  shake translates camera and aim by the same vector so its angular velocity is exactly zero;
  deterministic two-frequency sines, no `Math.random` in the frame path; `isReduced()` gates it at
  four separate points. Measured drift of ~0.010°–0.15° across every captured series.
- **Reduced motion is a real, meaningfully different branch, not an empty media query.**
  `camera.ts:153` returns before the breathe term; `anim.ts:133` swaps `Spring.step` for a damp with
  velocity zeroed (≤150 ms settle, no overshoot); `hit.tsx:404` freezes the focus-ring pulse;
  `celebrate.tsx:482-500` has a separate `timelines.reduced`; `physics.ts:678` cuts impulse gain to
  0.25; every game reads `isReduced()` fresh each frame and at every engine event.
- **The child cannot lose, in all nine games.** Score floors (`max(50, …)`, `max(100, …)`,
  `max(pairs*40, …)`), fixed round counts, food exits that never depend on the answer, time-out that
  simply celebrates what was caught, wrong answers that re-ask without advancing, a scoreless sandbox.
  Escape returns to the hub from all nine with no confirmation and no penalty.
- **Copy.** "Boing! That way is gum." · "Oops, a sweet! The tooth wobbles and carries on." ·
  "Good choice. Bye bye, cupcake." · "Nothing different there. Keep looking!" Nobody wrote "wrong",
  "failed" or "lost" anywhere in the product. No drills, needles, injections, blood, crying or failure
  screens exist in code or in any of the 163 frames.
- **Privacy.** `localStorage` only (`lumident:player`, `lumident:scores:<name>`). The only `fetch(` in
  `src/**` is `drive.ts` to localhost, DEV-gated. No analytics, no beacon, no cookies.
- **Rules, levels, scoring and randomisation are preserved verbatim from PROJECT.md** in every engine,
  including the deliberately non-uniform `sort(() => Math.random() - 0.5)` shuffles, which are kept and
  documented as such.
- **Draw calls, play-time triangles and render targets are all comfortably inside budget** in all nine
  games (12–46 calls vs 90; 17k–176k tris vs 180k; 0–1 RTs vs 3), and the DPR clamp works (1 px/CSS px
  on a dpr-2 display at low tier). Smile Maker's polaroid uses a bounded `POOL_SIZE = 2` render-target
  pool with correct `trackRenderTarget`/`untrackRenderTarget` — no target-per-capture leak.
- **maze-escape's keyboard implementation is the reference.** `role="application"` with documented
  reasoning, a `pointer-events-none` region so it can never eat a drag, and announcements carrying
  direction + open exits + remaining distance — enough to solve the maze blind. Copy this pattern.

---

## 5. DROPPED CLAIMS — and why

These were asserted by a critic or by the capture agent and are **not** in the fix list.

1. **"tooth-runner has no focusable start control."** False. `ToothRunner.tsx:221` renders a real
   `<button>` at `absolute inset-0` with `aria-label="Tooth Runner. Tap, or press space, to jump."`
   and `focus-visible:ring-4`. It has no text node, which is why the capture agent's
   `querySelectorAll('button')` text scan listed it among "three with EMPTY text". Tab does reach it.
   (The ring's 1.60:1 contrast **is** a real defect — kept as S14.)
2. **"Spot the Difference's celebration shows two teeth side by side and two confetti fields."**
   Not reproducible from the saved PNGs: the topmost opaque rows grow smoothly 3 → 25 → 57 px (one
   crown), the only interior transparent run is the natural V between the roots showing the 14 px
   panel gap, and confetti density is *lower* than in maze-escape or tooth-match, not doubled.
   The underlying **mechanism** is real and is kept as G-SD-2 — but the specific visual claim is
   dropped pending a live composite.
3. **Every `fps: 60 / droppedFrames: 0 / worstMs 16.67` PASS.** Vacuous by construction — see S7.
   No timing claim from this evidence set, in either direction, is admissible.
4. **`brand-pixels-tooth-rescue.json` and `brand-pixels-tooth-runner.json`.** Unusable: four of five
   tooth-runner probes hit fully transparent pixels (`a: 0`), and the tooth-rescue samples
   (`floor #a4866e`, `basket-red #847a65`) do not match the same regions measured directly off the
   PNGs (`#E5D4BA`, `#D9C5A7`), with coordinates (1512×1328, 2419×463) that fit no capture in the set.
   Superseded by direct measurement.
5. **"maze-escape / count-the-teeth reduced motion FAIL"** and **"reduced motion PASS"** for those two.
   Both games' `-reduced.png` and `-reduced-after-interaction.png` are **byte-identical** (md5
   `860890eb…` and `4334adaa…`), because the driven interaction was a *blocked* move and a *wrong*
   answer respectively. The images prove nothing either way. Converted to a re-capture request (§6),
   not a fix.
6. **"healthy-or-not takes 10–20 s between rounds."** Background-tab timer clamp; the engine's real
   values are `ADVANCE_CORRECT = 900`, `ADVANCE_OOPS = 1250`, `FINISH_DELAY = 800`. Dismissed by the
   reporting critic.
7. **"sliding-puzzle's live region is empty on every arrow-key move."** `SlidingPuzzle.tsx:126-132`
   does call `announce()`, and `announce()` defers 60 ms through `setTimeout` (`hit.tsx:106-110`),
   which the harness re-routed through a MessageChannel to beat the background-tab clamp. Most likely
   a harness artefact. Downgraded to a verify item (§6), not a fix.
8. **"count-the-teeth's hop/squash never fires."** The eight captured frames are 3/3/4/5/6/10/16 frames
   apart and sampled a 0.78 s staggered hop wave at the wrong moments; the code
   (`LAND_IMPULSE -3.4`, `HOP_IMPULSE 3.2`, `HOP_SQUASH -4.2` through `squashFor`) is correct.
   Downgraded to a re-capture request. (The *idle* bob genuinely is below display resolution — kept
   as G-CT-6.)
9. **"tooth-match silently drops the second flip of a pair (15/15 'not a pair' is impossible)."**
   Asserted from a keyboard log; no source line was identified for the drop, and the arithmetic claim
   depends on assumptions about the log's replay order. Needs reproduction before it becomes a fix.
10. **"Rubric lines 3 and 4 (press curves, squash) PASS/FAIL" from images.** `?drive=1` sets
    framer-motion `skipAnimations`, so no captured frame can show a DOM press curve, and the 3D series
    sampling is too coarse to resolve peaks. The *code* for anticipation, overshoot, volume-preserving
    squash and settle is correct in every game that was read; the *evidence* does not exist. No fix is
    listed for motion quality beyond the specific defects named above (S10, G-TRN-4, G-TRN-5,
    G-TRS-5, G-SD-9, G-TM-6, G-SM-11).
11. **"env.ts's `PCFShadowMap` deviation is defensible."** Kept as a defect (S17) rather than accepted,
    because `3D-SPEC` opens with "where this file and your own taste disagree, this file wins" — but
    the resolution is a spec conversation, not a unilateral code change.

---

## 6. EVIDENCE THAT MUST BE RE-CAPTURED BEFORE THE NEXT ROUND

The next audit is not comparable to this one unless these exist. **All of it must be captured after
S1 lands, with no CSS override injected.**

1. **Composite DOM + 3D screenshots.** `__shoot` writes the WebGL canvas only; the DOM layer is
   transparent in all 163 PNGs, so rubric line 6 ("UI reads as a web page floating over 3D") was
   judged from source and one manual live capture. Need real page screenshots at rest, mid-play and
   at the celebration, for all nine games, at desktop and phone size.
2. **Wall-clock frame timing with the driver off** (S7), in a foreground tab, with non-zero
   `renderP95Ms`/`renderAvgMs`, covering entry → 30 s of play → the full celebration → exit — and on
   the mid-range Android tablet `3D-SPEC §1.4` actually names. Findings S8 and S9 are
   desktop-invisible by construction.
3. **A closed scene-entry mark** per game, reporting `worstMs` against the 50 ms threshold.
4. **True 390×844 mobile.** Chrome bottomed out at 553×667 in every pass. Several `cameraFor`
   implementations take a distinct branch at ~0.48:1 (clamping at `MAX_DISTANCE = 16`) that has never
   been rendered — and that is where G-SM-3, G-SM-6, G-CT-2 and G-TRS-1 get worse, not better.
5. **`sliding-puzzle-celebration-perf.json`** — the only celebration never measured.
6. **Spot the Difference re-captured with non-zero draw calls** (its play-time perf row reads
   `0 calls / 0 triangles`, which is an absent measurement, not a passing one).
7. **Valid reduced-motion pairs** for maze-escape (a *legal* move) and count-the-teeth (a *correct*
   answer), plus a captured reduced-motion frame series through a jump and a stumble in tooth-runner.
8. **Impact-frame series at 1–2 frame spacing** for: a tooth-rescue catch, a maze-escape wall bump and
   90° corner, a count-the-teeth correct-answer hop wave, a healthy-or-not chomp, and a
   tooth-match press — cropped 4× at the prop, since several of these effects are ~4 px.
9. **A rendered PNG of the failing count-the-teeth seed 51980671** (level 2, count 14, 36.9 %
   unoccluded) from the game camera.
10. **2D transition timing** with `skipAnimations` off, so `§5`'s 450–600 ms hub⇄game transition and
    the celebration's 0.24 s fade can be judged at all.
11. **Foreground-tab read of `#lumident-live`** after a real sliding-puzzle arrow keypress (§5 item 7),
    and a real-keys (not synthetic) Tab/Enter traversal pass.

---

## 7. ITEMS THAT BLOCK A PASS

A pass requires **all** of these, in this order:

**Shared, must land first:**
- **S1** — shell height collapse (blocks literally everything else, including re-capture)
- **S2** — instance/vertex colour routed through the AO curve (content safety: blood-coloured
  confetti; brand: off-token across two games)
- **S3** — celebration triangle budget, 2.1×–2.9× over in 7 of 8 measured games
- **S4** — celebration composite: faceless extracted tooth, coplanar confetti on an invisible plane,
  two horizons, game hero interpenetrated
- **S5** — blank play area at the winning frame + celebration is not a dialog and leaves the game live
- **S6** — memory never returns to the hub baseline (+5 to +25 programs against a ±2 tolerance)
- **S7** — no valid frame-timing instrumentation exists (the 60 fps constraint is unverified)
- **S8** — ~20 synchronous GPU readbacks per round inside `useFrame`

**Cross-cutting:**
- **X1** — the live score chip counts down when a child makes a mistake

**Per game:**
- **G-TM-1** — six red first-aid crosses are Tooth Match's opening screen (content safety **and** a
  legal exposure under 18 U.S.C. §706 / the Geneva Conventions)
- **G-TM-2** — the memory game's motifs are invisible (1.03:1), so it cannot be played
- **G-SD-1** — `BACK_Z` is wrong by 0.25 units; one of the five differences is inside a wall, and is
  always in play on Hard
- **G-SD-2** — Spot renders the whole R3F scene twice, including other games' Views
- **G-SD-3** — the miss feedback is a 1.6 px invisible hairline
- **G-CT-1** — the countability guarantee is not enforced; boards ship at 36.9 % unoccluded
- **G-CT-2** — the only tap targets in Count the Teeth are clipped in half by the viewport
- **G-ME-1** — Maze Escape's goal is shorter than the walls and the same colour as them
- **G-TRS-1** — the falling tooth is at 1.17:1 contrast against its background
- **G-TRS-2** — the basket trim reads as blood running down a tooth
- **G-HN-1** — the "no thank you" verb is a disembodied fist with no idle and no in-world explanation
- **G-HN-2** — `TOOTH_H = 1.9` breaks the shared world scale (and causes S4's interpenetration)
- **G-SP-2** — z-fighting across every figure's hair in the hero relief scene
- **G-SP-3** — "Happy Family" has no smiles, floating heads and nothing dental in it
- **G-TRN-1** — Tooth Runner's celebration composition is decided by a modulo
- **G-SM-1** — accessories fly through the character's head on the normal path

Everything else in §1–§3 is required for the *quality* bar (materials, framing, accessibility,
contrast) but does not by itself block a pass.

---

## 8. HONEST ASSESSMENT

**The engineering is a long way ahead of the product.** The parts of `docs/3D-SPEC.md` that describe
*how to build* have been met to an unusually high standard: the lighting rig is a real code-built PMREM
studio with a bounce card and a cool rim, measurable in the pixels (saturation rises into shadow, every
shadow floor lands warm, the key is consistent across all ten scenes); the clay shader does genuine
signed-curvature AO, edge-gloss and wrapped diffuse; `squashFor` is arithmetically volume-preserving and
is kicked from real impact velocities; the camera's breathe caps are enforced by construction rather
than by a tunable clamp; reduced motion is a substantial parallel implementation, not a flag; every
`useFrame` in the product allocates nothing and no scene re-renders React per frame; there are no source
assets anywhere; every engine preserves the original rules, levels and scoring verbatim; and the child
genuinely cannot lose in any of the nine games. That is real work and it should not be thrown away.

**What has not been met is everything the spec says about what reaches the screen.** The product
currently ships with every game rendered into a 162-pixel strip — so §1.4's "60 fps" and §6's
"4-year-old figures it out in three seconds" are not close to met; they are not testable. Behind that
one CSS bug sit five more shared defects that each break a hard constraint: a shader that turns every
brand accent into arterial red or black (§1.1's ban on blood, §1's brand contract), a celebration that
is 2.1×–2.9× over the triangle budget and composites a faceless extracted tooth over a floating slab of
red chips (§9, §1.1, and the "every run ends in celebration" promise, which is literally a blank frame
at the moment of winning), a memory profile that never returns to baseline (§5), and perf
instrumentation that reads back its own fake clock so nothing in §9 has ever actually been measured.
Per game, the pattern is the same and it is a *composition and legibility* problem, not a technique
problem: the subject fills 6.7 %–27 % of the frame where Toca Boca fills 40–70 %; the objective is the
same colour as the wall in one game, shorter than the wall in another, invisible at 1.03:1 in a third,
and inside a wall in a fourth. Two frames — the ivory mascot in Healthy or Not, and the duck in Spot
the Difference — genuinely could sit inside a Sago Mini product. The rest could not, and the win screen
and Tooth Match's opening screen are not marginal failures: a scatter of red-and-white capsules around
a pulled tooth, and six red first-aid crosses, are the two worst possible images to put in front of a
three-year-old in a dental waiting room.

**How far is it?** The shared fixes (S1–S8) are perhaps a week of focused work and would move the
product from "unshippable" to "assessable" — most of them are small, well-localised changes to code
that is already well-structured, and S1 alone unblocks the entire re-capture. The per-game work is the
larger half: roughly two-thirds of the 60-odd game items are art-direction and framing decisions
(prop scale, silhouette legibility, camera solves, contrast) rather than bugs, and those need a
designer's eye and a re-render loop, not a patch. My honest estimate is that the build is **one shared
sprint and one art-direction pass away from a defensible pass**, and that no re-audit should be
attempted until S1 has landed and the whole capture set has been re-shot without an injected override —
because at present not one image in this audit shows the product that ships.
