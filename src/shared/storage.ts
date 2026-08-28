/**
 * Persistence layer. Currently localStorage; swap these functions for API
 * calls when the backend lands — nothing else in the app touches storage.
 */

export type Player = { name: string; age: number };

const PLAYER_KEY = "lumident:player";
const scoresKey = (name: string) => `lumident:scores:${name.trim().toLowerCase()}`;

const read = <T>(key: string): T | null => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
};

const write = (key: string, value: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable — play without persistence */
  }
};

export const loadPlayer = (): Player | null => {
  const p = read<Player>(PLAYER_KEY);
  return p && typeof p.name === "string" && p.name.trim() ? p : null;
};

export const savePlayer = (p: Player) => write(PLAYER_KEY, p);

export const clearPlayer = () => {
  try {
    localStorage.removeItem(PLAYER_KEY);
  } catch {
    /* ignore */
  }
};

export const getBest = (name: string, gameId: string): number | null => {
  const scores = read<Record<string, number>>(scoresKey(name));
  const v = scores?.[gameId];
  return typeof v === "number" ? v : null;
};

/** Records a finished game; returns the (possibly new) best. */
export const submitScore = (
  name: string,
  gameId: string,
  value: number,
  better: "higher" | "lower"
): { best: number; isNew: boolean } => {
  const key = scoresKey(name);
  const scores = read<Record<string, number>>(key) ?? {};
  const prev = scores[gameId];
  const isNew =
    typeof prev !== "number" || (better === "higher" ? value > prev : value < prev);
  const best = isNew ? value : prev;
  if (isNew) {
    scores[gameId] = value;
    write(key, scores);
  }
  return { best, isNew };
};
