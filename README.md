# Lumident Kids Games

A collection of short, friendly mini-games for children (ages 3–10) to play
while waiting for their dental appointment. Touch-first with full keyboard
support. Every game takes 15–60 seconds, needs no instructions beyond its
subtitle, and always ends in celebration — no failure states.

## Run it

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # production build in dist/
```

## Flow

1. **Welcome** — the child types their name and sets their age with a big
   −/+ stepper. Stored locally; the player chip in the hub header switches
   players. Age tunes the default difficulty (8+ starts on Medium).
2. **Hub** — every game as a card with its illustrated icon and the player's
   top score.
3. **Game** — shared frame with a level selector (Easy / Medium / Hard),
   a timer chip, and a live score chip, then a celebration overlay that
   records the score and shows "New best!" when beaten.

## Levels, timers & scoring

Every game (except the Smile Maker sandbox) has three levels and scores in
points — higher is always better. Points come from correct actions
(multiplied by level) plus a time bonus for finishing fast; mistakes cost a
little or nothing, never the run.

| Game | Levels | Timer |
| --- | --- | --- |
| Sliding Puzzle | 2×2 / 3×3 / 4×4 | counts up |
| Maze Escape | 9×9 / 11×11 / 13×13 generated mazes | counts up |
| Tooth Match | 3 / 6 / 8 pairs | counts up |
| Healthy or Not? | 8 / 10 / 12 foods | counts up |
| Spot the Difference | 3 / 4 / 5 differences | counts up |
| Tooth Rescue | faster drops, more candy | 30s countdown |
| Count the Teeth | counts up to 6 / 10 / 14 | counts up |
| Tooth Runner | faster runs of 20 / 25 / 30s | countdown |
| Smile Maker | — (sandbox, just for fun) | — |

Score semantics live in `src/shared/scoring.ts`; the shared 1-second timer
is `src/shared/useTicker.ts`. Persistence is isolated in
`src/shared/storage.ts` (currently localStorage, keyed per player) — **swap
these few functions for API calls when the backend lands**; nothing else in
the app touches storage.

## Architecture

```
src/
  App.tsx                 ← PlayerProvider + Welcome/Hub switch
  Welcome.tsx             ← name + age onboarding
  GamesCollection.tsx     ← hub: header, player chip, card grid, game modal
  games/
    index.ts              ← game registry (add/remove games here only)
    <game-name>/<Game>.tsx← one self-contained component per game
  shared/
    GameShell.tsx         ← shared game frame + score-aware celebration
    player.tsx            ← player context (name, age)
    storage.ts            ← persistence layer (backend goes here later)
    scoring.ts            ← per-game score metadata
    art.tsx               ← SVG illustration library (tooth, foods, …)
    gameIcons.tsx         ← illustrated hub-card icons
    icons.tsx             ← small stroke UI icons
    scenes.tsx            ← full scenes used by the sliding puzzle
    Confetti.tsx          ← lightweight confetti burst
    audio.ts              ← tiny WebAudio synth (pops, sparkles, success)
```

**Adding a game:** create `src/games/my-game/MyGame.tsx` rendering
`<GameShell gameId="my-game" score={…} completed={…} onRestart={…}>`, add an
entry to `GAMES` in `src/games/index.ts`, and (if it has a score) one line in
`scoring.ts`.

## Design system

- Palette: soft sky / mint / sun / coral / lavender accents on warm white
  surfaces with pastel background glows, defined as Tailwind theme tokens in
  `src/index.css`.
- Chunky "toy" 3D buttons (`.btn3d` component classes) that physically press
  down on tap; layered card shadows for depth.
- Type: Baloo 2 for display, Nunito for body.
- All artwork is inline SVG in one cohesive style — no image assets, no
  emoji in the UI.
- Audio is synthesized WebAudio (no files), gentle, mutable in every game.
- Accessibility: large tap targets, arrow-key/space play where practical,
  visible focus rings, `prefers-reduced-motion` respected.

## Stack

React 18 · TypeScript · Tailwind CSS 4 · Framer Motion · Vite — fully
client-side today; storage layer ready for a future backend.
