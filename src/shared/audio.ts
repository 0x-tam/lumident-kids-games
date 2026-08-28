/**
 * Tiny WebAudio synth — no audio files, no loading.
 * Gentle pops, sparkles, and a soft success chime.
 *
 * **Silent until asked.** These games are opened in a shared dental waiting room as often
 * as at home, and a tablet that starts making noise the moment a child taps a card is a
 * problem for every other family in the room. So the first run is muted, the speaker button
 * in `GameShell` is tinted with the game's accent while it is, and whichever way the child
 * (or the parent) sets it is remembered on the device from then on.
 *
 * The key is namespaced with the same `lumident:` prefix as the rest of our storage but is
 * deliberately *not* part of `shared/storage.ts` — that module's public API is frozen, and
 * a device-wide audio preference is not a player's score.
 */
import { useCallback, useSyncExternalStore } from "react";

const MUTE_KEY = "lumident:muted";

/**
 * Default true. A `null` value means this device has never expressed a preference, and the
 * quiet choice is the safe one. Wrapped because Safari private mode throws on access.
 */
const readMuted = (): boolean => {
  try {
    return window.localStorage.getItem(MUTE_KEY) !== "0";
  } catch {
    return true;
  }
};

let ctx: AudioContext | null = null;
let muted = typeof window === "undefined" ? true : readMuted();
const listeners = new Set<() => void>();

const getCtx = () => {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
};

const tone = (
  freq: number,
  start: number,
  dur: number,
  type: OscillatorType = "sine",
  vol = 0.12
) => {
  // Muted is checked before `getCtx()`, so a silent device never even constructs an
  // AudioContext — no autoplay warning, no suspended-context resume, no cost.
  if (muted) return;
  const c = getCtx();
  if (!c) return;
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, c.currentTime + start);
  gain.gain.setValueAtTime(0, c.currentTime + start);
  gain.gain.linearRampToValueAtTime(vol, c.currentTime + start + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + start + dur);
  osc.connect(gain).connect(c.destination);
  osc.start(c.currentTime + start);
  osc.stop(c.currentTime + start + dur + 0.05);
};

export const sounds = {
  pop: () => tone(520 + Math.random() * 120, 0, 0.09, "triangle", 0.1),
  sparkle: () => {
    tone(1180, 0, 0.12, "sine", 0.07);
    tone(1560, 0.06, 0.14, "sine", 0.06);
  },
  /**
   * The "not that one" sound — and deliberately **not** a wrong-answer sound.
   *
   * It used to be 380 Hz then 300 Hz: two soft tones falling a minor third. Softness was
   * never the issue. A descending interval is the culturally universal "wrong" signal —
   * the game-show buzzer, the error chime — and this product's §1.1 rule is that a child
   * cannot lose and a mistake is playful. A quiet way of saying "you failed" is still
   * saying it.
   *
   * So it rises instead: F4 349.2 Hz to G4 392.0 Hz, a whole tone up, which reads as a
   * question rather than a verdict — the same shape as the lift at the end of a spoken
   * "hmm?". Below `pop`'s 520–640 Hz so it never competes with a successful tap, at the
   * same volumes and the same 15 ms attack as before, so nothing about it is jarring.
   */
  oops: () => {
    tone(349.2, 0, 0.12, "triangle", 0.08);
    tone(392.0, 0.1, 0.16, "triangle", 0.07);
  },
  success: () => {
    tone(523, 0, 0.2, "sine", 0.1);
    tone(659, 0.12, 0.2, "sine", 0.1);
    tone(784, 0.24, 0.3, "sine", 0.1);
    tone(1047, 0.38, 0.45, "sine", 0.09);
  },
};

export const toggleMuted = () => {
  muted = !muted;
  try {
    window.localStorage.setItem(MUTE_KEY, muted ? "1" : "0");
  } catch {
    // A device that cannot persist the choice still honours it for this session.
  }
  listeners.forEach((l) => l());
};

export const useMuted = () =>
  useSyncExternalStore(
    useCallback((cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    }, []),
    () => muted
  );
