/**
 * Smile Maker — game logic.
 *
 * The sandbox is deliberately the simplest engine in the product: ten accessories, each of
 * which is either on the tooth or on the shelf, plus a polaroid that is either out or not.
 * There is no score, no timer, no level and no way to fail — PROJECT.md lists this game as
 * "No score — just for fun", and that is preserved exactly.
 *
 * What is preserved verbatim from the 2D implementation:
 *   • the same ten accessories, in the same order, with the same names;
 *   • tapping one toggles it on or off, with a pop;
 *   • "Randomize" shuffles with `sort(() => Math.random() - 0.5)` and takes
 *     `2 + floor(random * 3)` of them;
 *   • "Reset" clears everything;
 *   • "Done" takes a snapshot the child can dismiss and re-take as often as they like.
 *
 * The one rule the 3D version adds is anchor exclusivity: two hats cannot occupy the top of
 * the same head. Putting a second one on does not fail — the first one hops back to its
 * shelf slot, which is why `randomize` also picks distinct anchors rather than blindly
 * taking the first N of the shuffle.
 *
 * Zero React, zero three. Consumers subscribe and mutate their own state from the events.
 */
import { sounds } from "../../shared/audio";

/* ------------------------------------------------------------------ */
/* Accessories                                                         */
/* ------------------------------------------------------------------ */

export const ANCHOR_IDS = ["top", "eyes", "mouth", "neck", "back", "ear", "hand"] as const;
export type AnchorId = (typeof ANCHOR_IDS)[number];

export type AccessoryDef = {
  id: string;
  /** Spoken and written name — matches the 2D game's labels. */
  name: string;
  anchor: AnchorId;
  /** Where a screen-reader user is told it goes. */
  place: string;
};

/** Same ten, same order as the 2D `ACCESSORIES` table. */
export const ACCESSORIES: readonly AccessoryDef[] = [
  { id: "glasses", name: "Glasses", anchor: "eyes", place: "on the eyes" },
  { id: "sunglasses", name: "Sunglasses", anchor: "eyes", place: "on the eyes" },
  { id: "hat", name: "Hat", anchor: "top", place: "on top" },
  { id: "party", name: "Party Hat", anchor: "top", place: "on top" },
  { id: "crown", name: "Crown", anchor: "top", place: "on top" },
  { id: "mustache", name: "Mustache", anchor: "mouth", place: "above the smile" },
  { id: "bowtie", name: "Bow Tie", anchor: "neck", place: "at the neck" },
  { id: "flower", name: "Flower", anchor: "ear", place: "on the side" },
  { id: "cape", name: "Cape", anchor: "back", place: "on the back" },
  { id: "balloon", name: "Balloon", anchor: "hand", place: "at the side" },
] as const;

export const PROP_COUNT = ACCESSORIES.length;

/* ------------------------------------------------------------------ */
/* Events                                                              */
/* ------------------------------------------------------------------ */

export type EngineEvent =
  /** The dragged / tapped accessory came to rest, on the tooth or back on the shelf. */
  | { type: "place"; index: number; attached: boolean; changed: boolean }
  /** Another accessory already owned that anchor and politely stepped aside. */
  | { type: "displace"; index: number }
  /** Everything moved at once. */
  | { type: "layout"; reason: "reset" | "randomize" | "undo" }
  /** The child asked for a photo of a bare tooth. Not a failure — an invitation. */
  | { type: "nudge" }
  | { type: "photo" }
  | { type: "dismiss" };

type Listener = (event: EngineEvent) => void;

/* ------------------------------------------------------------------ */
/* Engine                                                              */
/* ------------------------------------------------------------------ */

export class SmileMakerEngine {
  /** 1 = worn, 0 = on the shelf. A typed array so the scene can read it without allocating. */
  readonly worn = new Uint8Array(PROP_COUNT);
  /** True while the polaroid is out. */
  photo = false;
  /** How many accessories are on the tooth — drives the DOM button states. */
  wornCount = 0;
  /** Caption printed on the polaroid. Set once, before the scene mounts. */
  caption = "What a smile!";
  /**
   * Whether the last thing that happened was a `reset` that actually took something off, and
   * therefore whether `undoClear()` has anything to put back.
   *
   * "Clear" is the one control in this game that destroys what the child made, it sits next
   * to the one that rewards them, and neither of them can be read by a four-year-old. Making
   * it recoverable is the half of that a rule change cannot fix: PROJECT.md's "Reset clears
   * everything" is untouched — the same button still clears everything — and this only means
   * that pressing it is no longer the one action in the product a child cannot take back.
   */
  canUndoClear = false;
  /** What was on the tooth immediately before that reset. */
  private readonly cleared = new Uint8Array(PROP_COUNT);

  private readonly listeners = new Set<Listener>();

  on(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private emit(event: EngineEvent): void {
    // Discrete, a handful of times a minute — a closure here costs nothing.
    for (const fn of this.listeners) fn(event);
  }

  /** Which accessory currently owns `anchor`, or -1. */
  wearerAt(anchor: AnchorId): number {
    for (let i = 0; i < PROP_COUNT; i++) {
      if (this.worn[i] === 1 && ACCESSORIES[i].anchor === anchor) return i;
    }
    return -1;
  }

  /**
   * Puts an accessory on the tooth or back on the shelf. Always emits `place`, even when
   * nothing changed, because the scene uses it to end a drag: a prop dropped back where it
   * came from still has to fly home.
   */
  place(index: number, attached: boolean): void {
    if (index < 0 || index >= PROP_COUNT) return;
    // Anything the child does themselves ends the undo window.
    this.canUndoClear = false;
    const changed = (this.worn[index] === 1) !== attached;

    if (attached) {
      const anchor = ACCESSORIES[index].anchor;
      for (let i = 0; i < PROP_COUNT; i++) {
        if (i === index || this.worn[i] === 0) continue;
        if (ACCESSORIES[i].anchor !== anchor) continue;
        this.worn[i] = 0;
        this.emit({ type: "displace", index: i });
      }
      this.worn[index] = 1;
    } else {
      this.worn[index] = 0;
    }

    this.recount();
    this.emit({ type: "place", index, attached, changed });
  }

  toggle(index: number): void {
    this.place(index, this.worn[index] === 0);
  }

  /**
   * The 2D behaviour: shuffle everything, take two to four. The only addition is skipping
   * an accessory whose anchor is already spoken for, so every pick is actually visible.
   */
  randomize(): void {
    this.canUndoClear = false;
    // Put the polaroid away first, so the scene animates it out instead of leaving it
    // hanging in front of a smile that no longer exists.
    this.dismissPhoto();
    sounds.sparkle();
    const order: number[] = [];
    for (let i = 0; i < PROP_COUNT; i++) order.push(i);
    order.sort(() => Math.random() - 0.5);

    const want = 2 + Math.floor(Math.random() * 3);
    this.worn.fill(0);
    const used: AnchorId[] = [];
    let taken = 0;
    for (const index of order) {
      if (taken >= want) break;
      const anchor = ACCESSORIES[index].anchor;
      if (used.indexOf(anchor) >= 0) continue;
      used.push(anchor);
      this.worn[index] = 1;
      taken++;
    }

    this.recount();
    this.emit({ type: "layout", reason: "randomize" });
  }

  reset(): void {
    this.dismissPhoto();
    this.cleared.set(this.worn);
    this.canUndoClear = this.wornCount > 0;
    this.worn.fill(0);
    this.recount();
    this.emit({ type: "layout", reason: "reset" });
  }

  /** Puts back exactly what the last `reset()` took off. No-op if there is nothing to undo. */
  undoClear(): void {
    if (!this.canUndoClear) return;
    this.canUndoClear = false;
    this.dismissPhoto();
    this.worn.set(this.cleared);
    this.recount();
    this.emit({ type: "layout", reason: "undo" });
  }

  /**
   * The shutter.
   *
   * `Snap!` used to ship `disabled` while nothing was on the tooth: the biggest, brightest
   * control in the game did nothing at all, with no visible reason, for the child who
   * naturally presses the most attractive button first. It is always enabled now, and an
   * empty tooth gets a friendly nudge and a wiggle from the shelf instead of silence
   * (`3D-SPEC §1` — the child cannot lose, and a control that ignores them is a loss).
   *
   * The rule PROJECT.md states — "Done" takes a snapshot the child can dismiss and re-take
   * as often as they like — is unchanged for every case where there is a smile to snap.
   */
  takePhoto(): void {
    if (this.photo) return;
    if (this.wornCount === 0) {
      sounds.pop();
      this.emit({ type: "nudge" });
      return;
    }
    this.photo = true;
    sounds.sparkle();
    this.emit({ type: "photo" });
  }

  dismissPhoto(): void {
    if (!this.photo) return;
    this.photo = false;
    this.emit({ type: "dismiss" });
  }

  private recount(): void {
    let n = 0;
    for (let i = 0; i < PROP_COUNT; i++) n += this.worn[i];
    this.wornCount = n;
  }

  dispose(): void {
    this.listeners.clear();
  }
}

export function createEngine(caption: string): SmileMakerEngine {
  const engine = new SmileMakerEngine();
  engine.caption = caption;
  return engine;
}
