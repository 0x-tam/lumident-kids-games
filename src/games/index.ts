import { lazy, type ComponentType } from "react";

export type GameEntry = {
  id: string;
  title: string;
  subtitle: string;
  accent: "red" | "coral" | "peach" | "rose" | "mauve";
  /** 3D icon from the Lumident brand kit (public/brand/). */
  icon: string;
  Component: ComponentType;
  /**
   * Starts this game's chunk downloading without rendering it. The hub calls it on card
   * hover, focus and pointerdown, so by the time a finger lifts the module is usually
   * already parsed and entering the game costs no hitch (3D-SPEC §5).
   */
  prefetch: () => void;
};

type Loader = () => Promise<{ default: ComponentType }>;

/**
 * Each game is its own chunk.
 *
 * The hub has to be interactive on a cold start without waiting for a single game module —
 * nine 3D games' worth of geometry, materials and physics is not something a child should
 * pay for to look at a menu. `React.lazy` splits them; `prefetch` un-splits them again the
 * instant a card shows interest.
 *
 * `import()` memoises its module promise, so calling `prefetch()` on every pointermove over
 * a card costs one already-resolved promise lookup. The rejection handler clears the latch
 * so a chunk that failed on a flaky connection can be retried rather than staying poisoned.
 */
function register(meta: Omit<GameEntry, "Component" | "prefetch">, load: Loader): GameEntry {
  let started: Promise<unknown> | null = null;
  return {
    ...meta,
    Component: lazy(load) as unknown as ComponentType,
    prefetch: () => {
      if (started) return;
      started = load().catch(() => {
        started = null;
      });
    },
  };
}

/** Add or remove games here — nothing else needs to change. */
export const GAMES: GameEntry[] = [
  register(
    {
      id: "sliding-puzzle",
      title: "Sliding Puzzle",
      subtitle: "Slide the tiles. Rebuild the picture.",
      accent: "mauve",
      icon: "/brand/diagnostics.webp",
    },
    () => import("./sliding-puzzle/SlidingPuzzle")
  ),
  register(
    {
      id: "maze-escape",
      title: "Maze Escape",
      subtitle: "Guide the tooth to the toothbrush.",
      accent: "coral",
      icon: "/brand/toothbrush.webp",
    },
    () => import("./maze-escape/MazeEscape")
  ),
  register(
    {
      id: "tooth-match",
      title: "Tooth Match",
      subtitle: "Flip the cards. Match the pairs.",
      accent: "red",
      icon: "/brand/kids.webp",
    },
    () => import("./tooth-match/ToothMatch")
  ),
  register(
    {
      id: "healthy-or-not",
      title: "Healthy or Not?",
      subtitle: "Tap the foods that keep teeth strong.",
      accent: "peach",
      icon: "/brand/prevention.webp",
    },
    () => import("./healthy-or-not/HealthyOrNot")
  ),
  register(
    {
      id: "spot-the-difference",
      title: "Spot the Difference",
      subtitle: "Find all the little changes.",
      accent: "rose",
      icon: "/brand/checkup-cleaning.webp",
    },
    () => import("./spot-the-difference/SpotTheDifference")
  ),
  register(
    {
      id: "tooth-rescue",
      title: "Tooth Rescue",
      subtitle: "Catch the falling teeth.",
      accent: "red",
      icon: "/brand/urgent-care.webp",
    },
    () => import("./tooth-rescue/ToothRescue")
  ),
  register(
    {
      id: "count-the-teeth",
      title: "Count the Teeth",
      subtitle: "How many teeth can you count?",
      accent: "coral",
      icon: "/brand/aligners.webp",
    },
    () => import("./count-the-teeth/CountTheTeeth")
  ),
  register(
    {
      id: "tooth-runner",
      title: "Tooth Runner",
      subtitle: "Jump the candy. Grab the brushes.",
      accent: "peach",
      icon: "/brand/retention.webp",
    },
    () => import("./tooth-runner/ToothRunner")
  ),
  register(
    {
      id: "smile-maker",
      title: "Smile Maker",
      subtitle: "Create your own funny smile.",
      accent: "mauve",
      icon: "/brand/whitening.webp",
    },
    () => import("./smile-maker/SmileMaker")
  ),
];
