/** Per-game score semantics — used by GameShell (submit + celebrate) and the hub cards. */

export type ScoreMeta = {
  label: string;
  better: "higher" | "lower";
  format: (v: number) => string;
};

const points: ScoreMeta = {
  label: "Top score",
  better: "higher",
  format: (v) => `${v.toLocaleString()} pts`,
};

/** Every game scores in points (higher is better); Smile Maker is a sandbox. */
export const SCORING: Record<string, ScoreMeta> = {
  "sliding-puzzle": points,
  "maze-escape": points,
  "tooth-match": points,
  "healthy-or-not": points,
  "spot-the-difference": points,
  "tooth-rescue": points,
  "count-the-teeth": points,
  "tooth-runner": points,
};

export const LEVEL_LABELS = ["Easy", "Medium", "Hard"];
