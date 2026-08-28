/**
 * One seam, so the celebration can live inside the game's own `<View>`.
 *
 * ## Why this exists
 *
 * The celebration used to mount its own `<Scene3D>`, which is its own drei `<View>` — and a
 * drei `<View>` is its own `THREE.Scene`, its own camera and its own `gl.render()` call.
 * Two scenes cannot share a shadow pass or a depth buffer, so the hero stood on a plinth
 * that cast nothing onto the board the child had just finished, interpenetrated whatever the
 * game had left standing, and was lit by a second `<Rig>` at a different scale from the
 * first. The round-3 audit photographed all three of those in three different games.
 *
 * Rendering the celebration inside the game's view fixes the cause rather than the symptoms:
 * one scene, one camera, one depth buffer, one lighting rig.
 *
 * ## Why it is a module store and not React context
 *
 * drei's `<View>` reaches the canvas through `tunnel-rat`: the elements are captured into a
 * store by `View.In` and re-rendered at `View.Port`, which is somewhere else entirely in the
 * React tree. Context providers above the tunnel's *input* therefore do not reach its
 * output, so a `GameShell` provider cannot be read inside the view it is portalling into.
 * A module store crosses that boundary because it does not depend on tree position at all;
 * `useSyncExternalStore` gives the consumer a correct, tearing-free subscription to it.
 *
 * The slot holds a React node and nothing else. It is written once when a run completes and
 * once when it is dismissed — never per frame, and it allocates nothing while playing.
 */
import { useSyncExternalStore, type ReactNode } from "react";

let slot: ReactNode = null;
const listeners = new Set<() => void>();

/**
 * Publish (or clear, with `null`) the node the game's view should render.
 *
 * Exactly one owner: `GameShell`. Two shells are never mounted at once — `AnimatePresence`
 * runs in `mode="wait"` — so a single-valued slot is the whole contract.
 */
export function setViewSlot(next: ReactNode): void {
  if (slot === next) return;
  slot = next;
  for (const listener of listeners) listener();
}

const subscribe = (onChange: () => void): (() => void) => {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
};

const read = (): ReactNode => slot;

/**
 * Rendered by `Scene3D` inside a **game's** view (never the hub's, never the probe's), last
 * in the subtree so every prop the game owns is already in the scene graph beside it.
 */
export function ViewSlot(): JSX.Element {
  const node = useSyncExternalStore(subscribe, read, read);
  return <>{node}</>;
}

/**
 * The band at the bottom of the celebration that the headline, the score plate and
 * "Play again" stand in, as a fraction of the view's height.
 *
 * It lives here rather than in `GameShell` because it is now read from **both** sides of the
 * seam: `GameShell` paints its fog over exactly this fraction, and `celebrate.tsx` has to
 * keep the hero and the burst above it when it fits itself to the game's camera. Importing
 * it from `GameShell` would make `celebrate.tsx → GameShell → celebrate.tsx` a cycle.
 *
 * Sized against the copy itself, at the type scale `GameShell` sets: headline 34 px, score
 * plate ~60 px, button 48 px (the §1.5 floor), gaps and padding ~56 px — ~198 px, which is
 * inside 34 % of the shortest viewport this ships on (a phone at ~760 px of shell, i.e.
 * 258 px).
 */
export const CELEBRATION_COPY_BAND = 0.34;
