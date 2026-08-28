# Lumident Kids Games

## What it is

**Lumident Kids Games** is a browser-based collection of nine short mini-games built for
the waiting room of Lumident, a pediatric dental clinic. It is a standalone single-page
web app. The idea: a child aged roughly 3–10 picks up a phone or tablet while waiting for
their appointment, plays a game that takes 15–60 seconds, and walks into the dentist's
chair feeling good about teeth.

Every game is themed around positive dental moments — brushing, healthy food, smiling
teeth — with an explicit content rule baked in from the original spec: **no drills, no
injections, no blood, no crying, no failure screens.** A child can never lose; mistakes
get a playful "oops" and the run always ends in a celebration.

## The experience

**Onboarding.** On first launch the child (or parent) enters a name and sets an age with
a big −/+ stepper (2–14). That's the whole "account" — no sign-up, no backend, nothing
leaves the device. Age quietly tunes difficulty defaults: kids 8+ start games on Medium,
younger ones on Easy.

**The hub.** A warm cream screen greets the player by name ("Hi Maya, pick a game")
under a sticky pill header with the clinic logo and a player chip (tap it to switch
players). Nine cards sit in a responsive grid, each with one of Lumident's real 3D clay
icons, a one-line description, and that player's personal best score. Tapping a card
opens the game full-screen.

**Playing.** Every game shares one frame (the `GameShell`): title and one-sentence
instruction, mute and restart buttons, a difficulty selector (Easy / Medium / Hard), a
live timer chip, and a live score chip. Finishing triggers the shared celebration —
radial confetti, a floating 3D baby tooth, "Great job, Maya!", the points earned, and
either a gold "New best!" pill or your standing record, plus Play again.

## The nine games

| Game | You do | Levels change |
|---|---|---|
| **Sliding Puzzle** | Slide tiles to rebuild an illustrated scene (5 scenes, random each run) | 2×2 / 3×3 / 4×4 board |
| **Maze Escape** | Drag a smiling tooth through ivory corridors carved in coral "gums" to reach a toothbrush | 9/11/13-cell generated mazes, fresh every run |
| **Tooth Match** | Memory card-flipping for pairs | 3 / 6 / 8 pairs |
| **Healthy or Not?** | Tap tooth-friendly foods, wave off sugary ones | 8 / 10 / 12 rounds, higher multipliers |
| **Spot the Difference** | Find the changes between two bathroom scenes (random subset of 5 possible diffs) | Find 3 / 4 / 5 |
| **Tooth Rescue** | Slide a basket to catch falling teeth; candy comically bounces out | Faster drops, more candy, higher catch goal |
| **Count the Teeth** | Count scattered teeth, tap the right number (5 rounds) | Counts up to 6 / 10 / 14 |
| **Tooth Runner** | Auto-running tooth; tap to jump candy, grab toothbrushes (candy only slows you) | 20/25/30s runs at rising speed |
| **Smile Maker** | Sandbox: drag hats, glasses, capes onto a big tooth, snap a polaroid | No score — "just for fun" |

Every scored game produces **points** (higher = better): correct actions × a level
multiplier, plus a time bonus for finishing fast. Best scores are stored per player per
game in `localStorage` under `lumident:*` keys, isolated in one small module
(`src/shared/storage.ts`) so a real backend can be swapped in later without touching
anything else.

## The look

The app wears the actual **Lumident brand**, extracted from the clinic's production
website:

- **Manrope** as the single typeface — weight carries the hierarchy.
- The site's warm greige-cream background (`#EDE7DC`), ink `#2F3237`.
- Five accent families all derived from Lumident's departmental reds: brand red, gum
  coral, peach, ortho rose, clay mauve.
- Surfaces use a soft-3D "clay" treatment — warm gradient cards with inset highlights
  and pressed-in wells, buttons that physically depress on tap.
- The website's real 3D-rendered icons (`public/brand/*.webp` — ivory teeth with red
  accents) serve as the hub iconography and mascot; in-game art is hand-drawn inline
  SVG in a matching cute, big-eyed style.
- The maze reuses the brand's teeth-in-gums motif literally: white paths carved through
  a coral block.

## Under the hood

Vite + React 18 + TypeScript (strict) + Tailwind v4, framer-motion for UI transitions
only. Each game is an isolated folder exporting one component, registered in
`src/games/index.ts` — adding a tenth game touches only its folder and that registry.

Notable engineering choices:

- The arcade games (Rescue, Runner) run their 60fps loops **without any per-frame React
  renders** — sprite positions are written straight to DOM nodes; React state changes
  only on discrete events (spawn, catch, once-per-second tick).
- The maze is genuinely a maze: movement follows your finger only through open
  corridors, max 3 cells per gesture, so it must be traced — tapping the goal does
  nothing.
- Every run is randomized: new maze, new card deal, new food order, new difference
  subset, new puzzle scene, new tooth counts.
- Sound is a tiny WebAudio synth (pops, sparkles, a 4-note success chime) — no audio
  files, global mute toggle.
- Accessibility: 48px+ tap targets, keyboard play everywhere practical (arrows for
  maze/basket, Space to jump, Escape closes the game), aria labels, and full
  `prefers-reduced-motion` support.
- No dependencies beyond React / framer-motion / Tailwind; production build is ~107 KB
  gzipped JS plus lazily-loaded icon images.

## Current state

Feature-complete and verified — type-check and production build clean, every game
play-tested end-to-end. The single deliberate gap is persistence: scores are
device-local until the planned backend replaces the storage module.
