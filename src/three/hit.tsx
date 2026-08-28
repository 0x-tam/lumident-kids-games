/**
 * Accessibility-grade input for 3D objects.
 *
 * Three problems this file exists to solve, none of which a raw mesh raycast solves:
 *
 * 1. **Fat fingers.** A prop that is 12 screen pixels wide is not tappable by a five year
 *    old. `HitTarget` grows an invisible collider until its *projected* size is at least
 *    `minScreenPx`, computed from the camera fov and the view height in CSS pixels.
 * 2. **Keyboard and screen readers.** Every target mirrors itself as a screen-reader-only
 *    `<button>` in a single hidden DOM layer, so Tab reaches it, Enter/Space fires it and
 *    VoiceOver reads its label. Grouped targets use the roving-tabindex pattern: one tab
 *    stop for the whole group, arrows to move within it.
 * 3. **Latency.** `pointerdown` responds in the same frame via `onPress`; `click` is never
 *    used, because click arrives after a delay and never arrives at all if the finger moves.
 *
 * Activation rule, once, explicitly: a target's own `onSelect` wins. `useFocusGroup`'s
 * `onActivate` only fires for indices that have no `HitTarget` registered — i.e. for groups
 * driven by bare indices. That way pointer and keyboard always run the same handler.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { useFrame, type RootState, type ThreeEvent } from "@react-three/fiber";
import {
  GreaterDepth,
  Group,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Quaternion,
  SphereGeometry,
  TorusGeometry,
  Vector3,
  type Camera,
  type MeshPhysicalMaterial,
} from "three";
import { ACCENTS, CLAY, NEUTRAL } from "./tokens";
import { createStore, FLAGS, isReduced, useStore, type Store } from "./store";
import { markShared, registerSceneCache, tagCacheEntry } from "./dispose";
import { cachedGeometry } from "./geometry";
import { clay } from "./materials";
import { easeOutCubic } from "./anim";
import { playAreaMetrics } from "./Scene3D";
// Type-only: erased at compile time, so this does not create a runtime cycle with the dev
// harness (which imports `hitTargetProbes` from here). The values come from the dynamic
// `import()` in `ensureFocusRingSelfTests`, which only runs under `?selftest=`.
import type { SelfTestResult } from "../dev/selftest";

/* ------------------------------------------------------------------ */
/* The hidden DOM accessibility layer                                  */
/* ------------------------------------------------------------------ */

const A11Y_ID = "lumident-a11y";
const LIVE_ID = "lumident-live";

/**
 * The standard visually-hidden recipe. Deliberately *not* `display:none` or
 * `visibility:hidden` — both remove the element from the tab order, which is the entire
 * point of it existing.
 */
const SR_ONLY =
  "position:absolute;width:1px;height:1px;margin:-1px;padding:0;border:0;overflow:hidden;" +
  "clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;appearance:none;background:none;";

function a11yRoot(): HTMLElement | null {
  if (typeof document === "undefined" || !document.body) return null;
  let el = document.getElementById(A11Y_ID);
  if (!el) {
    el = document.createElement("div");
    el.id = A11Y_ID;
    // Zero-size fixed box: the clipped children never affect layout or scroll position.
    el.style.cssText = "position:fixed;left:0;top:0;width:0;height:0;z-index:20;";
    document.body.appendChild(el);
  }
  watchInertFallback();
  return el;
}

/* ------------------------------------------------------------------ */
/* `inert` fallback                                                    */
/* ------------------------------------------------------------------ */

/**
 * `GameShell` marks the play area, the chrome and this layer's host `inert` while the
 * celebration dialog is open, and pairs it with `aria-hidden` — so a screen reader is
 * handled on every browser. What `aria-hidden` does *not* do is take an element out of the
 * tab order, and `inert` is what was carrying that: on Safari before 15.5 (and any engine
 * that ships neither) every mirrored button in this layer stayed focusable underneath a
 * full-screen modal, and would still fire its handler.
 *
 * `GameShell` owns the attribute; this owns the layer, so the fallback lives here. When the
 * engine has no native `inert`, the layer's own focusability is driven off the nearest
 * `[inert]` ancestor instead: every mirrored button and every group container drops to
 * `tabIndex -1`, arrow keys stop being handled, and activation is refused. That is the
 * behaviour `inert` would have provided, implemented rather than assumed.
 *
 * On an engine that supports `inert` — every current browser — `a11yLayerInert()` returns
 * `false` on its first line and no observer is ever created.
 */
const INERT_SUPPORTED = typeof HTMLElement !== "undefined" && "inert" in HTMLElement.prototype;

function a11yLayerInert(): boolean {
  if (INERT_SUPPORTED || typeof document === "undefined") return false;
  const root = document.getElementById(A11Y_ID);
  return root !== null && root.closest("[inert]") !== null;
}

let inertObserver: MutationObserver | null = null;

function watchInertFallback(): void {
  if (INERT_SUPPORTED || inertObserver !== null || typeof MutationObserver === "undefined") return;
  inertObserver = new MutationObserver(() => {
    const off = a11yLayerInert();
    const root = document.getElementById(A11Y_ID);
    if (root === null) return;
    root.style.pointerEvents = off ? "none" : "";
    // Grouped mirrors get their tab stop from the roving pass, which reads the same flag.
    groups.forEach(applyRoving);
    // Ungrouped mirrors sit directly under the layer and have no roving pass.
    for (let i = 0; i < root.children.length; i++) {
      const child = root.children[i];
      if (child instanceof HTMLButtonElement) child.tabIndex = off ? -1 : 0;
    }
  });
  inertObserver.observe(document.documentElement, {
    attributes: true,
    subtree: true,
    attributeFilter: ["inert"],
  });
}

/* ------------------------------------------------------------------ */
/* announce()                                                          */
/* ------------------------------------------------------------------ */

/**
 * **Two sibling nodes, never one node whose role is swapped.**
 *
 * The old implementation kept a single element and rewrote `role`/`aria-live` on it when
 * the politeness changed. Several assistive technologies snapshot a live region's
 * politeness when the node enters the accessibility tree and do not re-read it, so a
 * "polite" node that later claims to be an `alert` is announced politely — or, in the
 * worse failure, dropped while the platform re-registers it. Two nodes that each keep one
 * fixed politeness for the life of the document have no such state.
 *
 * The wrapper keeps the `lumident-live` id so anything reading the region as a whole (the
 * capture harness does) still sees the concatenated text of both nodes.
 */
type LiveNodes = { polite: HTMLElement; assertive: HTMLElement };

let liveNodes: LiveNodes | null = null;
let liveTimer = 0;

function liveChild(root: HTMLElement, id: string, role: string, politeness: string): HTMLElement {
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement("div");
    el.id = id;
    el.setAttribute("role", role);
    el.setAttribute("aria-live", politeness);
    el.setAttribute("aria-atomic", "true");
    el.style.cssText = SR_ONLY;
    root.appendChild(el);
  }
  return el;
}

function liveRegion(): LiveNodes | null {
  if (liveNodes && liveNodes.polite.isConnected && liveNodes.assertive.isConnected) {
    return liveNodes;
  }
  const root = a11yRoot();
  if (!root) return null;
  let wrap = document.getElementById(LIVE_ID);
  if (!wrap) {
    wrap = document.createElement("div");
    wrap.id = LIVE_ID;
    wrap.style.cssText = SR_ONLY;
    root.appendChild(wrap);
  }
  liveNodes = {
    polite: liveChild(wrap, `${LIVE_ID}-polite`, "status", "polite"),
    assertive: liveChild(wrap, `${LIVE_ID}-assertive`, "alert", "assertive"),
  };
  return liveNodes;
}

type LiveMessage = {
  text: string;
  assertive: boolean;
  /** Messages sharing a key describe the same thing; only the newest survives. */
  coalesce: string | undefined;
  /** `Date.now()` at `announce()`, used to drop superseded state descriptions. */
  at: number;
};

/**
 * Pending announcements, oldest first.
 *
 * The region has to be *cleared* and re-set for each message: an identical consecutive
 * message ("Caught!" twice) is not a mutation and so is never re-announced. The
 * implementation before the queue did that clear-then-set on a single 60 ms timer and
 * cancelled any pending message when a second `announce()` arrived — so two calls in one
 * commit, which is the normal case (a game's "Match!" plus `GameShell`'s completion line
 * both fire on the completing move), spoke only the second.
 *
 * **What round 4 measured, and what changed because of it.** Two things, and one of them
 * corrects the audit rather than confirming it.
 *
 * The audit said a child arrowing at 3/s "permanently outruns the queue". At 3/s that is
 * false and the arithmetic says so: the pipeline is `LIVE_CLEAR_MS + LIVE_HOLD_MS` = 260 ms
 * and the interval is 333 ms, and a driven run of that case measured 0 dropped and 60 ms of
 * lag on the old code. What *does* saturate it is any arrival faster than the 60 ms clear —
 * browser key auto-repeat, which fires a Maze move roughly every 33 ms, and any commit that
 * announces more than once, where every message after the first costs the full 260 ms hold.
 *
 * At those tempos the old queue was exactly as bad as the audit described. Driven, on the
 * old implementation: Maze at auto-repeat speed left narration **1960 ms** behind the board
 * and put **7 stale move lines ahead of** "You reached the toothbrush!"; ten announcements in
 * one commit delayed the completion line by **2140 ms** behind 8 stale lines; Tooth Runner's
 * overlapping cue streams delayed it by 650 ms. On the same scripts now, the completion line
 * is spoken **60 ms** after the event with **nothing** ahead of it in all three, and ordinary
 * narration lag falls from 1960 ms to 353 ms (80 ms with a `coalesce` key). Three rules do
 * it, and all three are enforced here rather than asked for game by game:
 *
 *  1. **Assertive interrupts.** An assertive message drops the polite messages still waiting
 *     (all but the newest — see `clearSupersededPolite`), cancels the current hold and
 *     speaks immediately on the assertive node. That is the queue-jump a completion line
 *     needs. `GameShell` must pass `{ assertive: true }` for its completion announcement to
 *     take it; see `AnnounceOptions`.
 *  2. **A short polite backlog.** At most `LIVE_POLITE_MAX` polite messages may be waiting,
 *     so worst-case narration lag is bounded at 3 x 260 ms rather than 8 x 260 ms.
 *  3. **Stale polite messages are discarded, never spoken late.** A polite message that has
 *     been waiting longer than `LIVE_STALE_MS` and has something newer behind it is
 *     dropped: a description of where the tooth was 700 ms ago is worse than silence. The
 *     `length > 1` guard is the part that matters — the *last* thing a game says is never
 *     dropped, whatever the tempo, which is precisely the failure `tooth-runner-keyboard.txt`
 *     recorded.
 *
 * `coalesce` is the per-game refinement on top: a repeated same-kind message (Maze's move
 * description, Tooth Runner's collection count) replaces its predecessor in the queue
 * instead of joining it.
 */
const liveQueue: LiveMessage[] = [];

/**
 * Blank time before the next text is written. Long enough for the mutation to register as
 * two separate changes; short enough that it is not perceived as a pause.
 */
const LIVE_CLEAR_MS = 60;
/** How long a message stays in the region before the next one is allowed to replace it. */
const LIVE_HOLD_MS = 200;
/**
 * How many *polite* messages may be waiting. At `LIVE_CLEAR_MS + LIVE_HOLD_MS` per message
 * this caps narration lag at ~780 ms. Assertive messages are never counted against it —
 * they jump the queue instead of joining it.
 */
const LIVE_POLITE_MAX = 3;
/**
 * How long a polite message may wait before it is considered a stale description of a game
 * state that has already moved on. Only applied when something newer is behind it.
 */
const LIVE_STALE_MS = 700;

function pumpLive(): void {
  liveTimer = 0;
  const nodes = liveRegion();
  if (!nodes) return;

  // Rule 3. Never empties the queue: the newest message always survives.
  const now = Date.now();
  while (
    liveQueue.length > 1 &&
    !liveQueue[0].assertive &&
    now - liveQueue[0].at > LIVE_STALE_MS
  ) {
    liveQueue.shift();
  }

  const next = liveQueue.shift();
  if (next === undefined) return;
  const el = next.assertive ? nodes.assertive : nodes.polite;

  el.textContent = "";
  liveTimer = window.setTimeout(() => {
    liveTimer = 0;
    el.textContent = next.text;
    // Hold, then release the region to whatever is waiting behind this message.
    if (liveQueue.length > 0) liveTimer = window.setTimeout(pumpLive, LIVE_HOLD_MS);
  }, LIVE_CLEAR_MS);
}

/** Removes every queued message carrying `key`. Index loop: no closure. */
function dropCoalesced(key: string): void {
  for (let i = liveQueue.length - 1; i >= 0; i--) {
    if (liveQueue[i].coalesce === key) liveQueue.splice(i, 1);
  }
}

/**
 * Clears the polite backlog an interrupt supersedes — but keeps the **newest** polite entry.
 *
 * That exception is the case the queue was originally built for: a game's "Match!" and
 * `GameShell`'s completion line both fire on the completing move, in one commit. Everything
 * older than that describes a state two events ago and is genuinely superseded; the newest
 * is a sibling of the interrupt, and dropping it would trade one round's bug for another's.
 */
function clearSupersededPolite(): void {
  let newest = -1;
  for (let i = liveQueue.length - 1; i >= 0; i--) {
    if (!liveQueue[i].assertive) {
      newest = i;
      break;
    }
  }
  for (let i = liveQueue.length - 1; i >= 0; i--) {
    if (!liveQueue[i].assertive && i !== newest) liveQueue.splice(i, 1);
  }
}

export type AnnounceOptions = {
  /**
   * Interrupts. Drops every polite message still waiting, cancels the current hold and
   * speaks on the dedicated `role="alert"` node. Use for the one line the child must hear
   * even mid-sentence — a run completing. Not for ordinary state changes: `3D-SPEC §8`
   * says game state changes announce *politely*.
   */
  assertive?: boolean;
  /**
   * Coalescing key. A queued message carrying the same key is removed and this one takes
   * its place at the back, so a game that re-describes one thing at gameplay tempo only
   * ever has its newest description waiting.
   *
   * Contract for the games (`A17`): Maze Escape passes `"move"` on its per-move position
   * line, Tooth Runner passes `"collect"` on its collection count and drops its per-spawn
   * sentence entirely in favour of the short approach cue.
   */
  coalesce?: string;
};

/**
 * One live region for the whole app, two nodes inside it. See `liveQueue` for the queue
 * policy and `LiveNodes` for why the politeness is never swapped on a node.
 *
 * The legacy `announce(message, true)` boolean form still means "assertive".
 */
export function announce(message: string, options?: boolean | AnnounceOptions): void {
  if (!liveRegion()) return;

  const assertive = typeof options === "boolean" ? options : options?.assertive === true;
  const coalesce = typeof options === "boolean" ? undefined : options?.coalesce;

  if (coalesce !== undefined) dropCoalesced(coalesce);

  if (assertive) {
    clearSupersededPolite();
    liveQueue.unshift({ text: message, assertive: true, coalesce, at: Date.now() });
    if (liveTimer !== 0) {
      window.clearTimeout(liveTimer);
      liveTimer = 0;
    }
    pumpLive();
    return;
  }

  liveQueue.push({ text: message, assertive: false, coalesce, at: Date.now() });

  let polite = 0;
  for (let i = 0; i < liveQueue.length; i++) if (!liveQueue[i].assertive) polite++;
  // Drop the *oldest* polite entries: the newest description of the game state is always
  // the one that must survive.
  while (polite > LIVE_POLITE_MAX) {
    for (let i = 0; i < liveQueue.length; i++) {
      if (!liveQueue[i].assertive) {
        liveQueue.splice(i, 1);
        break;
      }
    }
    polite--;
  }

  if (liveTimer === 0) pumpLive();
}

/* ------------------------------------------------------------------ */
/* Focus groups                                                        */
/* ------------------------------------------------------------------ */

type FocusState = { index: number; active: boolean };

type GroupRecord = {
  store: Store<FocusState>;
  container: HTMLElement;
  elements: Map<number, HTMLButtonElement>;
  /** Set while a `useFocusGroup` owns this group; used only for bare-index groups. */
  activate: ((index: number) => void) | null;
  count: number;
  enabled: boolean;
  /** HitTargets + hooks referencing this group; the DOM container dies at zero. */
  refs: number;
};

const groups = new Map<string, GroupRecord>();

const sortOrders = (rec: GroupRecord): number[] => {
  const out: number[] = [];
  rec.elements.forEach((_el, order) => out.push(order));
  out.sort((a, b) => a - b);
  return out;
};

/** The element that currently owns the single tab stop. */
function applyRoving(rec: GroupRecord): void {
  let stop = rec.store.get().index;
  if (!rec.elements.has(stop)) {
    stop = -1;
    rec.elements.forEach((_el, order) => {
      if (stop < 0 || order < stop) stop = order;
    });
  }
  const live = rec.enabled && !a11yLayerInert();
  rec.elements.forEach((el, order) => {
    el.tabIndex = live && order === stop ? 0 : -1;
  });
  // A group with no registered targets is driven by bare indices, so the container itself
  // has to be the focusable thing or arrow keys never reach us.
  rec.container.tabIndex = live && rec.elements.size === 0 ? 0 : -1;
}

function activateIndex(rec: GroupRecord, index: number): void {
  const el = rec.elements.get(index);
  // Routing through the button's own click keeps one activation path for mouse, touch,
  // keyboard and assistive tech.
  if (el) el.click();
  else rec.activate?.(index);
}

function onGroupKey(rec: GroupRecord, e: KeyboardEvent): void {
  if (!rec.enabled || a11yLayerInert()) return;

  const orders = sortOrders(rec);
  const usingElements = orders.length > 0;
  const length = usingElements ? orders.length : rec.count;
  if (length <= 0) return;

  const current = rec.store.get().index;
  let at = usingElements ? orders.indexOf(current) : current;
  if (at < 0 || at >= length) at = 0;

  let next = at;
  switch (e.key) {
    case "ArrowRight":
    case "ArrowDown":
      next = (at + 1) % length;
      break;
    case "ArrowLeft":
    case "ArrowUp":
      next = (at - 1 + length) % length;
      break;
    case "Home":
      next = 0;
      break;
    case "End":
      next = length - 1;
      break;
    case "Enter":
    case " ":
    case "Spacebar":
      // Buttons fire `click` natively for Enter/Space, so only the bare-index container
      // (where the event target *is* the container) needs handling here.
      if (e.target !== rec.container) return;
      e.preventDefault();
      activateIndex(rec, rec.store.get().index < 0 ? 0 : rec.store.get().index);
      return;
    default:
      return;
  }

  e.preventDefault();
  const index = usingElements ? orders[next] : next;
  rec.store.set({ index, active: true });
  applyRoving(rec);
  rec.elements.get(index)?.focus();
}

function getGroup(name: string): GroupRecord {
  const existing = groups.get(name);
  if (existing && existing.container.isConnected) return existing;

  const root = a11yRoot();
  if (!root) throw new Error("useFocusGroup/HitTarget need a DOM to attach keyboard targets to");
  const container = document.createElement("div");
  container.setAttribute("role", "group");
  container.setAttribute("aria-label", name);
  container.dataset.group = name;
  container.style.cssText = "position:absolute;left:0;top:0;width:0;height:0;";
  container.tabIndex = -1;
  root.appendChild(container);

  const rec: GroupRecord = {
    store: createStore<FocusState>({ index: -1, active: false }),
    container,
    elements: new Map(),
    activate: null,
    count: 0,
    enabled: true,
    refs: 0,
  };

  container.addEventListener("keydown", (e) => onGroupKey(rec, e));
  container.addEventListener("focusin", (e) => {
    const target = e.target as HTMLElement | null;
    const order = target?.dataset?.order;
    const index = order !== undefined ? Number(order) : rec.store.get().index;
    rec.store.set({ index: index < 0 ? 0 : index, active: true });
    applyRoving(rec);
  });
  container.addEventListener("focusout", (e) => {
    const next = (e as FocusEvent).relatedTarget as Node | null;
    if (next && container.contains(next)) return;
    // Keep the index so returning to the group restores where the child was.
    rec.store.set({ index: rec.store.get().index, active: false });
  });

  groups.set(name, rec);
  return rec;
}

function releaseGroup(rec: GroupRecord): void {
  rec.refs--;
  if (rec.refs > 0) return;
  rec.store.set({ index: -1, active: false });
  const name = rec.container.dataset.group;
  if (name && groups.get(name) === rec) groups.delete(name);
  // Removing the node takes its listeners with it — nothing to unbind by hand.
  rec.container.remove();
}

/**
 * Roving focus over a set of targets. Returns the focused index, or -1 when the group does
 * not hold focus, so a scene can highlight the current item without any per-frame work.
 */
export function useFocusGroup(
  group: string,
  count: number,
  onActivate: (index: number) => void,
  enabled = true
): number {
  const rec = useMemo(() => getGroup(group), [group]);
  const handler = useRef(onActivate);

  useEffect(() => {
    handler.current = onActivate;
  }, [onActivate]);

  useEffect(() => {
    rec.refs++;
    rec.count = count;
    rec.enabled = enabled;
    rec.activate = (index: number) => handler.current(index);
    applyRoving(rec);
    return () => {
      rec.activate = null;
      // Focus state is reset by releaseGroup only when the group is genuinely gone — a
      // `count` or `enabled` change re-runs this effect and must not steal focus mid-game.
      releaseGroup(rec);
    };
  }, [rec, count, enabled]);

  const state = useStore(rec.store);
  return state.active ? state.index : -1;
}

/* ------------------------------------------------------------------ */
/* Shared 3D resources                                                 */
/* ------------------------------------------------------------------ */

/**
 * Everything below used to be a module-level `markShared` constant. Now it lives in a scene
 * cache, and the reason is `3D-SPEC §5`'s return-to-baseline rule.
 *
 * **What was measured.** Across two full nine-game endurance loops, every registered cache
 * came back to the hub baseline exactly — `caches` at `{texture: 1, material: 14,
 * geometry: 21}` in `endurance.json` and in all nine `*-memory-after.json` — while
 * `renderer.info.memory.geometries` sat at a flat **+2** and never moved. A residue that is
 * constant across eighteen game entries and invisible to every cache is, by construction,
 * something nothing owns.
 *
 * **What was proven by reading three, not assumed.** A geometry is registered in
 * `WebGLGeometries` inside `projectObject`, at `objects.update( object )`, which runs
 * *before* the `material.visible` test (`three.module.js` r170, ~line 30236). So the
 * collider's invisible material saves its draw call and its fill exactly as documented, and
 * does **not** stop the sphere counting against `info.memory.geometries`. That is at least
 * one of the two, in every game that mounts a `HitTarget`.
 *
 * **What is still open.** The other +1 is not attributed. The three torus geometries only
 * upload while a focus ring is actually visible, and the endurance run never focused
 * anything, so they are unlikely to be it; `Rig.tsx`'s lazily-built `unitPlane` is another
 * untracked `markShared` candidate. Rather than guess, `__perf.memoryDrift()` now reports
 * `outsideCaches`, which names the residue directly: with every cache back at baseline it is
 * exactly the count no eviction can reach. Fixing this file removes four candidates from
 * that number, and the next capture says what is left.
 *
 * `markShared` alone was never tracking. It only tells `disposeObject3D` to walk past a
 * resource; nothing then owns it, nothing can free it, and nothing counts it. And `hit.tsx`
 * arrives in the lazy game chunks, so these upload *after* the hub baseline is taken.
 *
 * So: geometry through `cachedGeometry()`, which `geometry.ts` already registers, and the
 * materials through a registered cache. Both stay `markShared` — that guard is what stops a
 * game's `disposeObject3D` freeing a resource the cache is still handing out — and eviction
 * disposes them directly, bypassing the guard, at the one moment nothing can still be
 * drawing with them. Same arrangement `textures.ts` and `geometry.ts` already use.
 *
 * Since round 4 the *only* thing left in this file's own cache is the collider's invisible
 * `MeshBasicMaterial`. The focus ring's four materials are built by `materials.ts::clay()`
 * under `hit:ring:*` keys, so they live in the `material` scene cache with every other clay
 * material in the product and are evicted by the same pass. One cache fewer to reason about,
 * and one fewer place a resource can be registered but never counted.
 *
 * The cost is that the collider sphere is rebuilt once per game entry — 13 x 9 = 117
 * vertices for `SphereGeometry(1, 12, 8)` — instead of once per session. That is the right
 * trade against a permanent, unreclaimable offset from the baseline.
 */

/** One unit sphere for every collider in the app; instances differ only by scale. */
const colliderGeometry = () =>
  cachedGeometry("hit:collider", () => new SphereGeometry(1, 12, 8));

/* ------------------------------------------------------------------ */
/* The focus ring's three clay ropes                                   */
/* ------------------------------------------------------------------ */

/**
 * The focus ring is **three nested clay ropes**, not a flat annulus, and every number below
 * is normalised so that the outermost rope's outer edge sits at exactly radius 1. The
 * group's scale is therefore the ring's outer radius in world units, which is the quantity
 * the sizing solve actually computes.
 *
 * Layout, outer edge inward:
 *
 * ```
 *   |<-- 2t -->|<-- 2t -->|<-- 2t -->|
 *   [   ink    ][ accent  ][  pale   ]   ... and the object it marks
 *   ^ r = 1                          ^ r = 1 - 6t
 * ```
 *
 * **Why three and not two.** `A20` was right and the arithmetic is worth writing down,
 * because it also proves that no two-tone scheme can work here. Recomputed with the repo's
 * own `contrastRatio()`: the shipped accent `red.deep #c21e25` is 1.23:1 on `CLAY.gumDeep`
 * and 1.77:1 on `CLAY.gum`; `NEUTRAL.ink` is 2.63:1 on `gumDeep`. Neither tone cleared 3:1
 * there, so the "whichever tone loses contrast, the other carries the indicator" claim was
 * false on a colour this product actually paints. It is false *structurally*: `red.deep` sits
 * at relative luminance 0.1253, so it clears 3:1 only against backings above L = 0.4759, and
 * a lone partner covering everything below that would need L >= 1.528 — brighter than white.
 * A third tone is not a nicety; with a dark accent it is the arithmetic minimum.
 *
 * The pair that carries the guarantee is `RING_INK` + `RING_PALE`, and it carries it
 * **independently of whatever accent a game passes**: ink (L = 0.0316) clears 3:1 on every
 * backing above L = 0.1948 and enamel (L = 0.9572) on every backing below L = 0.2857, and
 * those two half-lines overlap, so the whole luminance range is covered by construction.
 * Measured over every colour in `NEUTRAL`, `CLAY` and all fifteen `ACCENTS` entries the worst
 * backing is `red.main`, where the better of the two tones still measures **3.70:1**.
 * `focus-ring-contrast` asserts it rather than this comment claiming it.
 *
 * The accent rope in the middle carries brand identity, not contrast duty. It only has to
 * be distinguishable from the two ropes touching it, which `focus-ring-contrast` also
 * asserts (the worst shipped accent, `red.main`, is 3.70:1 against enamel).
 */
const RING_TUBE = 0.0433;

/** Major radii of the ink, accent and pale ropes. Each rope is `2 * RING_TUBE` wide. */
const RING_MAJOR = [1 - RING_TUBE, 1 - 3 * RING_TUBE, 1 - 5 * RING_TUBE] as const;

/**
 * Deliberately **not** tier-scaled.
 *
 * Everything else in the product subdivides off `getQuality().detail`, and `A4` is the
 * record of what that costs: the low tier — the tier a mid-range Android tablet actually
 * boots — is the one nobody art-directs, and it ships facets. A focus ring is at most four
 * draw calls and 5.1k triangles (2.8% of the §9 budget) and only while something is
 * focused, so it pays the same price on every tier and is round on every tier. Ten radial
 * segments give the rope real curvature under the key; 64 tubular segments keep the chord
 * around 7 px on the largest ring this product draws.
 */
const RING_RADIAL_SEG = 10;
const RING_TUBULAR_SEG = 64;

const ropeGeometry = (band: 0 | 1 | 2) =>
  cachedGeometry(
    `hit:ring:${band}`,
    () => new TorusGeometry(RING_MAJOR[band], RING_TUBE, RING_RADIAL_SEG, RING_TUBULAR_SEG)
  );

/** The two tones that carry the WCAG non-text contrast guarantee. See `RING_TUBE`. */
const RING_INK = NEUTRAL.ink;
const RING_PALE = CLAY.enamel;

/**
 * The guaranteed pair, named, so `focus-ring-contrast` asserts over the same two hexes the
 * ring is actually built from rather than a copy of them.
 */
export const RING_TONES: ReadonlyArray<readonly [string, string]> = [
  ["ink", RING_INK],
  ["pale", RING_PALE],
];

/**
 * The two backing populations a ring is ever drawn on: every neutral, every clay body
 * colour and every accent tone. `3D-SPEC §1.2` allows exactly this palette and no other,
 * so this list is closed — which is what makes the guarantee above provable rather than
 * sampled. Exported for `focus-ring-contrast`.
 */
export const RING_BACKINGS: ReadonlyArray<readonly [string, string]> = [
  ...Object.entries(NEUTRAL),
  ...Object.entries(CLAY),
  ...Object.keys(ACCENTS).flatMap((f) =>
    Object.keys(ACCENTS[f as keyof typeof ACCENTS]).map(
      (t) =>
        [`${f}.${t}`, ACCENTS[f as keyof typeof ACCENTS][t as keyof typeof ACCENTS.red]] as const
    )
  ),
];

/* ---- Materials: this file's own scene-registered cache ---- */

const materialCache = new Map<string, MeshBasicMaterial>();
const HIT_CACHE = "hit";

registerSceneCache({
  name: HIT_CACHE,
  entries: () => materialCache.entries(),
  size: () => materialCache.size,
  evict: (key) => {
    const m = materialCache.get(key);
    if (m === undefined) return;
    m.dispose();
    materialCache.delete(key);
  },
});

function hitMaterial(key: string, build: () => MeshBasicMaterial): MeshBasicMaterial {
  tagCacheEntry(HIT_CACHE, key);
  let m = materialCache.get(key);
  if (m === undefined) {
    m = markShared(build());
    m.name = key;
    materialCache.set(key, m);
  }
  return m;
}

/**
 * `object.visible` stays true so the raycaster still sees it, but `material.visible` is
 * false, which makes `WebGLRenderer` skip it before it ever reaches the render list — no
 * draw call and no fill. (It does not skip the geometry registration; see above.)
 */
const colliderMaterial = () =>
  hitMaterial("collider", () => new MeshBasicMaterial({ visible: false }));

/**
 * A rope of the focus ring, in the same clay as everything else in the scene.
 *
 * **What this replaces, and why.** Eight games used to draw this indicator as three
 * camera-billboarded `MeshBasicMaterial` tori with `depthTest: false`, `toneMapped: false`
 * and no fog — the only object in a 28 degree-perspective clay diorama that was a flat
 * circle in the picture plane with zero shading across its tube, drawn straight through
 * everything in front of it. It read as a web page pasted over the scene, and because it
 * ignored depth it drew over cards *nearer the camera* in Tooth Match, over the doughnut it
 * was marking in Healthy or Not, and over the towel it had just rewarded in Spot the
 * Difference. In a memory game an indicator that hides information is worse than no
 * indicator.
 *
 * So: `clay()`, which means lit by the studio key, tone-mapped with the rest of the frame,
 * fogged with the rest of the frame, and carrying the same grain and sheen as the props it
 * sits beside. A torus lit from upper-left shows the key travelling around its tube, which
 * is the whole reason a rope is the right shape.
 *
 * The render state is set after the fact because it is not material *description* and
 * `ClayOptions` deliberately does not carry it:
 *
 * - `depthTest` stays **on** (three's default). Occlusion is now correct.
 * - `depthWrite` stays **on**, which is a deliberate departure from the letter of the fix
 *   list, and the reason is worth recording. The rope is not an overlay any more; it is a
 *   solid lit object standing beside the props. Leaving `depthWrite` off costs two things.
 *   three sorts the opaque list front-to-back, so the far ground would be drawn *after* the
 *   near ring and paint straight over it, which is why the naive version needs a
 *   `renderOrder` hack in the first place. And every transparent decal in the scene — the
 *   `ContactBlob` under the very prop being marked, at `renderOrder` 2 — is drawn after all
 *   opaque geometry, so with no depth written by the ring a ground shadow would blend on
 *   top of a ring floating in front of it. Writing depth makes both cases resolve correctly
 *   for free, and the only thing a solid rope then hides is what is genuinely behind it.
 *   `renderOrder` is still raised, but now only so the depth buffer is already complete
 *   when the ring is drawn and early-z rejects the occluded fragments.
 * - `polygonOffset` pulls the fragments a hair toward the eye. The ring hugs the marked
 *   object's silhouette from outside, so it only grazes that object's surface at its inner
 *   edge; the along-ray offset in `FocusRing` handles the bulk of it and this handles the
 *   grazing remainder.
 *
 * Keys are namespaced `hit:ring:` so nothing else can be handed one of these and be
 * surprised by the render state.
 */
function ringRope(key: string, hex: string): MeshPhysicalMaterial {
  const m = clay(`hit:ring:${key}`, {
    color: hex,
    // A touch glossier and a touch less grainy than a prop: this is a small, thin form and
    // the grain map's world-scale repeat would read as noise across a 7 px rope.
    roughness: 0.62,
    grain: 0.07,
    wrap: 0.3,
    sheen: 0.4,
    envMapIntensity: 1.05,
  });
  m.polygonOffset = true;
  m.polygonOffsetFactor = -2;
  m.polygonOffsetUnits = -2;
  return m;
}

/**
 * The occluded pass: where the ring is *behind* something, this draws instead, at a quarter
 * strength.
 *
 * `A1` asked for exactly this rather than the old `depthTest: false`, and the difference is
 * the whole point. Disabling depth makes the indicator win against every pixel in the
 * frame, including the ones a child needs to see. `depthFunc: GreaterDepth` makes it lose
 * every one of those and win only where it would otherwise have vanished completely, so a
 * keyboard user whose target has slid behind a gum wall still knows where focus is without
 * anything being hidden to tell them.
 *
 * Ink at 0.30, on the accent rope's geometry: ink is the tone that survives being blended
 * 70/30 into this palette's occluders, which are overwhelmingly ivory and enamel.
 */
function ringGhost(): MeshPhysicalMaterial {
  const m = clay("hit:ring:ghost", {
    color: RING_INK,
    roughness: 0.7,
    // Matched to the ropes on purpose. `grain` decides whether a `normalMap` is bound, and
    // `normalMap` is one of the flags three folds into its program cache key — `clay`'s
    // constant `customProgramCacheKey` does not cover it. A ghost with `grain: 0` would be
    // a second compiled program against §9's live-material budget, and it would compile on
    // the child's first Tab press.
    grain: 0.07,
    wrap: 0.3,
    sheen: 0.4,
    transparent: true,
    opacity: 0.3,
  });
  m.depthWrite = false;
  m.depthFunc = GreaterDepth;
  return m;
}

/* Per-frame scratch — these run inside useFrame and must never allocate. */
const _view = new Vector3();
const _scale = new Vector3();
const _screen = new Vector3();
const _camPos = new Vector3();
const _anchor = new Vector3();
const _dir = new Vector3();
const _pscale = new Vector3();
const _probePoint = new Vector3();
const _qCam = new Quaternion();
const _qParent = new Quaternion();
const _qParentInv = new Quaternion();

/**
 * Height, in CSS pixels, of the rectangle this view will occupy once it has settled.
 *
 * Not `state.size.height`. drei's `<View>` freezes that at the transformed
 * `getBoundingClientRect()` it read when the portal was created, and the hub → game panel
 * mounts mid-way through a framer-motion scale flip from 0.24 → 1. Sizing a tap target
 * against a quarter-height view makes it four times too large, `lastDepth` then caches
 * that, and the only thing that ever corrected it was an unrelated HUD re-render.
 */
function viewHeightPx(state: RootState): number {
  const layout = playAreaMetrics();
  if (layout !== null && layout.height > 0) return layout.height;
  return state.size.height || state.gl.domElement.clientHeight || 1;
}

/** World units per CSS pixel at `depth` in front of a perspective camera. */
function worldPerPixel(camera: PerspectiveCamera, depth: number, viewHeightPx: number): number {
  return (2 * depth * Math.tan((camera.fov * Math.PI) / 360)) / viewHeightPx;
}

/**
 * View-space depth of `obj`'s origin, or -1 when it is behind the camera.
 *
 * `getWorldPosition` refreshes the object's own world matrix, but `matrixWorldInverse` is
 * only recomputed inside `gl.render` — so on the very first frame, before anything has
 * been drawn, it is still identity. `fresh` pays for one in-place matrix inversion (no
 * allocation) on the passes where that matters: the first one, and any invalidation.
 */
function viewDepth(obj: Group | Mesh, camera: PerspectiveCamera, fresh = false): number {
  if (fresh) {
    camera.updateMatrixWorld();
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
  }
  obj.getWorldPosition(_view);
  _view.applyMatrix4(camera.matrixWorldInverse);
  return -_view.z;
}

/* ------------------------------------------------------------------ */
/* FocusRing                                                           */
/* ------------------------------------------------------------------ */

/**
 * The tap-target floor `HitTarget` uses by default, and the reference point the focus ring's
 * own floor is expressed against. `3D-SPEC §8`.
 */
const DEFAULT_MIN_SCREEN_PX = 48;

/**
 * How far proud of the marked object's footprint the ring's outer edge is allowed to sit.
 *
 * **The number `A1` asked for, and the defect it closes.** The ring used to be sized as
 * `radius x 1.2` at the call site and then grown again by the outermost torus's own tube, so
 * its outer edge landed at `1.464 x` the radius it was handed. Measured, that is a 240 px
 * ring around a 150 px card in Tooth Match, a ~190 px ring around a 143 px collider in Count
 * the Teeth where it swallowed three of five progress pips, and most of the towel hidden in
 * Spot the Difference. The ring is an outline of a thing, not a second larger thing.
 *
 * The solve is now expressed once, in screen pixels, against the target's **footprint**:
 * the larger of the object's own projected silhouette and the `3D-SPEC §8` tap floor — i.e.
 * exactly the disc `HitTarget` sizes its collider to. `1.05` is both the target and the
 * ceiling: the breath below oscillates the ring between flush with that footprint and 5 %
 * proud of it, so the ring can never exceed the footprint by more than a twentieth,
 * whatever a game passes.
 */
const RING_PROUD = 0.05;

/**
 * Along-ray forward offset, as a fraction of the ring's outer radius: two tube radii, so
 * the whole rope clears the plane the marked object's silhouette sits in.
 *
 * A billboarded ring at `1.05 x` the silhouette sits *outside* the object's projection, so
 * the surface it is depth-tested against is whatever is behind the object, not the object.
 * The one place they meet is the grazing inner edge, and the sphere's silhouette is tangent
 * to the view ray exactly at the origin's depth — which is why a small offset plus
 * `polygonOffset` is enough and no z-fighting survives. Because the shift is along the ray
 * *to the camera position*, and perspective projection is a central projection through that
 * point, the ring's projected centre does not move by a pixel; only its depth does. The
 * pixel size is then solved at the shifted depth, so it does not move either.
 */
const RING_FORWARD = 2 * RING_TUBE;

/**
 * The ring breathes between flush with the footprint and `RING_PROUD` past it.
 *
 * `3D-SPEC §4` forbids `linear` and `ease-in-out` on anything a child touches and says not
 * to hand-roll easing, so the breath is a sawtooth phase shaped by `anim.ts`'s
 * `easeOutCubic` in both directions: it snaps proud in the first third of the cycle and
 * drifts back over the remaining two thirds. Asymmetric, so it never reads as the symmetric
 * ease-in-out ramp the spec names. Under reduced motion it is pinned fully proud — §4 says
 * no idle float, and a static ring at its most legible size is the right still.
 */
const RING_BREATH_HZ = 0.62;
const RING_BREATH_RISE = 0.32;

export function FocusRing(props: {
  visible: boolean;
  /**
   * World radius of the **marked object's silhouette** — the same quantity `HitTarget`
   * takes as `radius` and sizes its collider from. The ring's outer edge lands at
   * `1.00`–`1.05 x` the larger of this and the tap floor. It is *not* a ring radius: a
   * caller that used to inflate this to make the ring bigger should stop.
   */
  radius: number;
  color?: string;
  /**
   * The tap floor of the target this ring marks, in the same units and with the same
   * panel compensation `HitTarget.minScreenPx` takes — `viewHeightPx` reports the play
   * area's height, so a game drawing into a sub-panel (Spot the Difference, at a panel
   * fraction near 0.37) passes a pre-divided `tapScreenPx(fh)` and the ring inherits that
   * compensation exactly, because `minScreenPx` is the quantity the game already divided.
   * `HitTarget` passes its own through; a standalone ring can leave it at the default.
   */
  minScreenPx?: number;
  /** Only used to name this ring in the `focus-ring` selftest. */
  label?: string;
}): JSX.Element {
  const groupRef = useRef<Group>(null);
  // Deep red rather than the mid red: 4.87:1 against the cream page, so the accent rope
  // reads as deliberate UI even on a bright tablet outdoors. It carries identity, not the
  // contrast guarantee — see `RING_TUBE`.
  const hex = props.color ?? ACCENTS.red.deep;

  const inkGeo = useMemo(() => ropeGeometry(0), []);
  const accentGeo = useMemo(() => ropeGeometry(1), []);
  const paleGeo = useMemo(() => ropeGeometry(2), []);
  const inkMat = useMemo(() => ringRope("ink", RING_INK), []);
  const accentMat = useMemo(() => ringRope(`accent:${hex}`, hex), [hex]);
  const paleMat = useMemo(() => ringRope("pale", RING_PALE), []);
  const ghostMat = useMemo(ringGhost, []);

  const radiusRef = useRef(props.radius);
  radiusRef.current = props.radius;
  const minPxRef = useRef(DEFAULT_MIN_SCREEN_PX);
  minPxRef.current = props.minScreenPx ?? DEFAULT_MIN_SCREEN_PX;

  const visibleRef = useRef(props.visible);
  visibleRef.current = props.visible;

  const probe = useMemo<FocusRingProbe | null>(
    () => (PROBING ? { ...EMPTY_RING_PROBE, label: props.label ?? "focus-ring", accent: hex } : null),
    [props.label, hex]
  );

  useEffect(() => {
    if (probe === null) return;
    ensureFocusRingSelfTests();
    ringProbes.add(probe);
    return () => {
      ringProbes.delete(probe);
    };
  }, [probe]);

  useFrame((state) => {
    const g = groupRef.current;
    // Under `?selftest=` the sizing pass runs for *every* registered ring, focused or not,
    // so `focus-ring` can assert the aspect of all of them rather than only the one the
    // driver happened to leave focused. In production the early return stands.
    if (!g || (!visibleRef.current && probe === null)) return;

    const camera = state.camera;
    const persp = camera as PerspectiveCamera;
    const parent = g.parent;

    /* ---- Billboard, with every rotated ancestor composed out (A2) ---- */
    //
    // `g.quaternion` is a *local* rotation. Copying the camera's into it made the ring's
    // world orientation `parentRotation x cameraRotation`, so under Smile Maker's rotated
    // prop roots the ring rendered as a tilted ellipse lying inside the prop and wobbling
    // with it — measured projected aspect 2.0 against 1.00 everywhere else, on ten of that
    // game's targets, under a comment in this file reading "a ring seen edge-on is not a
    // focus indicator". Pre-multiplying by the inverse of the parent's *world* quaternion
    // makes the world orientation exactly the camera's again, for any ancestor chain.
    camera.getWorldQuaternion(_qCam);
    if (parent !== null) {
      parent.getWorldQuaternion(_qParent);
      _qParentInv.copy(_qParent).invert();
      g.quaternion.copy(_qParentInv).multiply(_qCam);
    } else {
      _qParentInv.identity();
      g.quaternion.copy(_qCam);
    }

    /* ---- Sizing, in screen pixels, against the target's footprint (A1) ---- */

    // Zero last frame's along-ray offset first, or the depth solve feeds back on itself.
    g.position.set(0, 0, 0);
    // `fresh` unconditionally, unlike `HitTarget` below. At most one ring is visible at a
    // time, so this is one in-place 4x4 inversion per frame for the whole app — and the
    // alternative is a depth read from the *previous* frame's `matrixWorldInverse` mixed
    // with a camera world position read from this one, on the first frame of every focus
    // move and every time the camera rig moves inside `useFrame`.
    const depth0 = viewDepth(g, persp, true);
    _anchor.setFromMatrixPosition(g.matrixWorld);

    let parentScale = 1;
    if (parent !== null) {
      // `parent.matrixWorld` is fresh: `getWorldQuaternion` above refreshed the chain.
      _pscale.setFromMatrixScale(parent.matrixWorld);
      parentScale = Math.max(_pscale.x, Math.max(_pscale.y, _pscale.z)) || 1;
    }

    const phase = (state.clock.elapsedTime * RING_BREATH_HZ) % 1;
    const breath = isReduced()
      ? 1
      : phase < RING_BREATH_RISE
        ? easeOutCubic(phase / RING_BREATH_RISE)
        : 1 - easeOutCubic((phase - RING_BREATH_RISE) / (1 - RING_BREATH_RISE));
    const proud = 1 + RING_PROUD * breath;

    let outerWorld = radiusRef.current * proud;

    if (persp.isPerspectiveCamera && depth0 > 0) {
      const viewH = viewHeightPx(state);
      const perPixel0 = worldPerPixel(persp, depth0, viewH);
      const silhouettePx = radiusRef.current / perPixel0;
      const tapFloorPx = minPxRef.current * 0.5;
      // The footprint: exactly the disc `HitTarget` sizes its collider to.
      const footprintPx = silhouettePx > tapFloorPx ? silhouettePx : tapFloorPx;
      const outerPx = footprintPx * proud;

      persp.getWorldPosition(_camPos);
      _dir.copy(_camPos).sub(_anchor);
      const dist = _dir.length();
      let depth1 = depth0;
      if (dist > 1e-6) {
        // Never more than halfway to the camera, whatever a game's scale is.
        const step = Math.min(outerPx * perPixel0 * RING_FORWARD, dist * 0.5);
        _dir.multiplyScalar(step / dist);
        // The anchor-to-camera vector's component along the view axis is exactly `depth0`,
        // so a step of `step` along it costs `step * depth0 / dist` of depth.
        depth1 = depth0 - (step * depth0) / dist;
        _dir.applyQuaternion(_qParentInv).divideScalar(parentScale);
        g.position.copy(_dir);
      }
      outerWorld = outerPx * worldPerPixel(persp, depth1, viewH);

      if (probe !== null) {
        probe.outerPx = outerPx;
        probe.footprintPx = footprintPx;
      }
    } else if (probe !== null) {
      probe.outerPx = 0;
      probe.footprintPx = 0;
    }

    // The group's scale *is* the ring's outer radius: `RING_MAJOR[0] + RING_TUBE === 1`.
    g.scale.setScalar(outerWorld / parentScale);

    if (probe !== null) {
      probe.visible = visibleRef.current;
      measureRing(g, camera, viewHeightPx(state), probe);
    }
  });

  return (
    // renderOrder 900: last of the opaque list, so the depth buffer is complete before the
    // ring is drawn. The ghost is transparent and therefore later still, which is what lets
    // it read a finished depth buffer and paint only where the ring lost.
    <group ref={groupRef} visible={props.visible}>
      <mesh geometry={inkGeo} material={inkMat} renderOrder={900} />
      <mesh geometry={accentGeo} material={accentMat} renderOrder={900} />
      <mesh geometry={paleGeo} material={paleMat} renderOrder={900} />
      <mesh geometry={accentGeo} material={ghostMat} renderOrder={901} />
    </group>
  );
}

/* ------------------------------------------------------------------ */
/* Focus-ring probes + selftests (dev only)                            */
/* ------------------------------------------------------------------ */

/**
 * What `focus-ring` asserts, per registered ring. `A2` shipped because nothing measured the
 * one property a billboard exists to guarantee.
 */
export type FocusRingProbe = {
  label: string;
  /** The accent hex this ring's middle rope is drawing. */
  accent: string;
  /** Whether this ring was actually being drawn when it was measured. */
  visible: boolean;
  /** Projected bounding box of the ring's outer edge, CSS px. */
  widthPx: number;
  heightPx: number;
  /**
   * `widthPx / heightPx`. A plane parallel to the image plane projects to the image plane
   * by a *similarity* transform, so a correctly billboarded ring is an exact circle at any
   * position in the frame and this is exactly 1. Under a rotated ancestor it is not.
   */
  aspect: number;
  /** The ring's outer radius, CSS px. */
  outerPx: number;
  /** The marked target's footprint radius, CSS px. `outerPx` may not exceed 1.05x it. */
  footprintPx: number;
  measured: boolean;
};

const EMPTY_RING_PROBE: Omit<FocusRingProbe, "label" | "accent"> = {
  visible: false,
  widthPx: 0,
  heightPx: 0,
  aspect: 0,
  outerPx: 0,
  footprintPx: 0,
  measured: false,
};

const ringProbes = new Set<FocusRingProbe>();

/** Snapshot for the `focus-ring` selftest. */
export const focusRingProbes = (): FocusRingProbe[] => Array.from(ringProbes);

/**
 * Sample count for the projected bounding box. A multiple of four, so a perfectly round
 * ring's sampled polygon has vertices on both axes and its own bounding box is exactly
 * square — the discretisation contributes zero error to `aspect`.
 */
const RING_PROBE_N = 16;
const RING_PROBE_COS = new Float32Array(RING_PROBE_N);
const RING_PROBE_SIN = new Float32Array(RING_PROBE_N);
for (let i = 0; i < RING_PROBE_N; i++) {
  const a = (i / RING_PROBE_N) * Math.PI * 2;
  RING_PROBE_COS[i] = Math.cos(a);
  RING_PROBE_SIN[i] = Math.sin(a);
}

function measureRing(g: Group, camera: Camera, viewH: number, probe: FocusRingProbe): void {
  g.updateWorldMatrix(true, false);
  const persp = camera as PerspectiveCamera;
  const width = viewH * (persp.isPerspectiveCamera ? persp.aspect || 1 : 1);
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < RING_PROBE_N; i++) {
    // The unit circle in the ring's own XY plane is its outer edge: `RING_MAJOR[0] +
    // RING_TUBE === 1` and `TorusGeometry` lies in XY with its hole along Z.
    _probePoint.set(RING_PROBE_COS[i], RING_PROBE_SIN[i], 0);
    _probePoint.applyMatrix4(g.matrixWorld);
    _probePoint.project(camera);
    const x = (_probePoint.x * 0.5 + 0.5) * width;
    const y = (0.5 - _probePoint.y * 0.5) * viewH;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  probe.widthPx = maxX - minX;
  probe.heightPx = maxY - minY;
  probe.aspect = probe.heightPx > 1e-6 ? probe.widthPx / probe.heightPx : 0;
  probe.measured = true;
}

/**
 * `1.0 +/- 0.1`, the tolerance `A2` asked for. The true value for a correct billboard is
 * exactly 1.0 — see `FocusRingProbe.aspect` — so this band is entirely slack, and the
 * defect it exists to catch measured 2.0.
 */
const RING_ASPECT_TOLERANCE = 0.1;

function ringAspectSelfTest(): SelfTestResult {
  const live = focusRingProbes().filter((p) => p.measured);
  if (live.length === 0) {
    return {
      name: "focus-ring",
      pass: true,
      detail: "no focus rings registered in this scene — nothing asserted",
      data: { rings: 0 },
    };
  }

  const skewed: string[] = [];
  const oversized: string[] = [];
  const undersized: string[] = [];
  let worstAspect = 1;

  for (const p of live) {
    if (Math.abs(p.aspect - 1) > Math.abs(worstAspect - 1)) worstAspect = p.aspect;
    if (Math.abs(p.aspect - 1) > RING_ASPECT_TOLERANCE) {
      skewed.push(`${p.label}: aspect ${p.aspect.toFixed(3)}`);
    }
    if (p.footprintPx > 0) {
      // Half a pixel of slack for the projection, nothing more.
      if (p.outerPx > p.footprintPx * (1 + RING_PROUD) + 0.5) {
        oversized.push(
          `${p.label}: outer ${p.outerPx.toFixed(0)}px vs footprint ${p.footprintPx.toFixed(0)}px`
        );
      }
      if (p.outerPx < p.footprintPx - 0.5) {
        undersized.push(
          `${p.label}: outer ${p.outerPx.toFixed(0)}px inside footprint ${p.footprintPx.toFixed(0)}px`
        );
      }
    }
  }

  const pass = skewed.length === 0 && oversized.length === 0 && undersized.length === 0;
  const parts = [`${live.length} rings`, `worst aspect ${worstAspect.toFixed(3)}`];
  if (skewed.length) parts.push(`${skewed.length} not square to the camera`);
  if (oversized.length) parts.push(`${oversized.length} past the footprint`);
  if (undersized.length) parts.push(`${undersized.length} inside the footprint`);

  return {
    name: "focus-ring",
    pass,
    detail: parts.join(", "),
    data: {
      rings: live.length,
      skewed,
      oversized,
      undersized,
      probes: live.map((p) => ({
        label: p.label,
        visible: p.visible,
        aspect: Math.round(p.aspect * 1000) / 1000,
        outerPx: Math.round(p.outerPx),
        footprintPx: Math.round(p.footprintPx),
      })),
    },
  };
}

/** WCAG's non-text contrast floor. Not a taste threshold — do not widen it. */
const RING_CONTRAST_MIN = 3;

/**
 * Proves, over the whole closed palette, the claim `A20` found false: that whichever tone
 * loses contrast against a given backing, another one carries the indicator.
 *
 * `contrastRatio` is injected rather than reimplemented — a second copy of the WCAG
 * transfer curve in this file is exactly the kind of drift `A12` is about.
 *
 * With the tones the ring currently ships this cannot fail, and that is deliberate rather
 * than decorative: the pair was *chosen* so its two half-lines overlap (see `RING_TUBE`), so
 * the assertion is a tripwire on `RING_TONES`, not a sample of the palette. It has teeth —
 * driven against pairs a future edit might plausibly reach for, it fires every time: ink +
 * `NEUTRAL.line` bottoms out at 2.93:1 on `rose.main`, ink + `red.deep` (the scheme A20
 * measured) at 1.68:1 on `inkMid`, and either tone alone at 1.00:1 on itself. Anything that
 * makes the pale tone darker than L = 0.6844, with ink where it is, opens a gap and this
 * says so.
 */
function ringContrastSelfTest(contrastRatio: (a: string, b: string) => number): SelfTestResult {
  const uncovered: string[] = [];
  let worst = Infinity;
  let worstName = "";

  const bestTone = (backing: string): number => {
    let best = 0;
    for (const [, tone] of RING_TONES) {
      const r = contrastRatio(tone, backing);
      if (r > best) best = r;
    }
    return best;
  };

  for (const [name, hex] of RING_BACKINGS) {
    const best = bestTone(hex);
    if (best < worst) {
      worst = best;
      worstName = name;
    }
    if (best < RING_CONTRAST_MIN) uncovered.push(`${name} ${hex}: best tone ${best.toFixed(2)}:1`);
  }

  // The guaranteed tones must also be separable from each other, or the ring reads as one
  // thick smudge instead of a two-tone indicator.
  const pairSeparation = contrastRatio(RING_TONES[0][1], RING_TONES[1][1]);
  if (pairSeparation < RING_CONTRAST_MIN) {
    uncovered.push(
      `${RING_TONES[0][0]} vs ${RING_TONES[1][0]} only ${pairSeparation.toFixed(2)}:1`
    );
  }

  // Every accent actually on screen has to be separable from at least one rope touching it,
  // or the ring reads as two bands rather than three and the game's identity colour is lost.
  const flatAccents: string[] = [];
  for (const p of focusRingProbes()) {
    const near = bestTone(p.accent);
    if (near < RING_CONTRAST_MIN) {
      flatAccents.push(`${p.label} accent ${p.accent}: ${near.toFixed(2)}:1`);
    }
  }

  const pass = uncovered.length === 0 && flatAccents.length === 0;
  return {
    name: "focus-ring-contrast",
    pass,
    detail: pass
      ? `${RING_BACKINGS.length} backings, worst is ${worstName} at ${worst.toFixed(2)}:1, ` +
        `ink/pale separation ${pairSeparation.toFixed(2)}:1`
      : [...uncovered, ...flatAccents].join("; "),
    data: {
      backings: RING_BACKINGS.length,
      worst: { backing: worstName, ratio: Math.round(worst * 100) / 100 },
      pairSeparation: Math.round(pairSeparation * 100) / 100,
      uncovered,
      flatAccents,
    },
  };
}

let ringSelfTestsRegistered = false;

/**
 * Registers the two focus-ring selftests the first time a ring mounts under `?selftest=`.
 *
 * A **dynamic** import, for two reasons. `src/dev/selftest.ts` imports `hitTargetProbes`
 * from this file, so a static import would be an evaluation-order cycle — and the losing
 * order is real: if `selftest.ts` evaluates first, its `registry` is still in its temporal
 * dead zone while this module's top level runs. And in a production build the chunk is
 * never fetched at all, because `PROBING` is false.
 */
function ensureFocusRingSelfTests(): void {
  if (ringSelfTestsRegistered || !PROBING) return;
  ringSelfTestsRegistered = true;
  void import("../dev/selftest").then((mod) => {
    mod.registerSelfTest("focus-ring", ringAspectSelfTest);
    mod.registerSelfTest("focus-ring-contrast", () => ringContrastSelfTest(mod.contrastRatio));
  });
}

/* ------------------------------------------------------------------ */
/* HitTarget                                                           */
/* ------------------------------------------------------------------ */

export type HitTargetProps = {
  ariaLabel: string;
  minScreenPx?: number;
  radius?: number;
  position?: [number, number, number];
  onSelect?: () => void;
  onPress?: () => void;
  onRelease?: () => void;
  onHover?: (hovering: boolean) => void;
  disabled?: boolean;
  focusOrder?: number;
  group?: string;
  children?: ReactNode;
};

/** How much the view-space depth must change before the collider is resized. */
const DEPTH_TOLERANCE = 0.03;
/** Collider size is checked on one frame in eight — resizing is not a per-frame concern. */
const CHECK_MASK = 7;

/* ------------------------------------------------------------------ */
/* Collider probes (dev only)                                          */
/* ------------------------------------------------------------------ */

/**
 * Screen-space record of every live collider, so `?selftest` can assert that tap targets
 * are the size they claim and do not swallow each other. Populated only when a selftest
 * filter is present; in production the set stays empty and the projection never runs.
 */
export type HitTargetProbe = {
  label: string;
  disabled: boolean;
  /** Required minimum diameter in CSS px. */
  minScreenPx: number;
  /** Projected centre, CSS px from the top-left of the view. */
  x: number;
  y: number;
  /** Projected radius of the collider as it is actually sized, CSS px. */
  r: number;
  /** Projected radius of the prop itself, CSS px — the floor `minScreenPx` cannot shrink. */
  radiusPx: number;
  /** False until the first sizing pass has run for this target. */
  measured: boolean;
};

const probes = new Set<HitTargetProbe>();

/** Snapshot for `src/dev/selftest.ts`. */
export const hitTargetProbes = (): HitTargetProbe[] => Array.from(probes);

const PROBING = FLAGS.selftest !== null;

export function HitTarget(props: HitTargetProps): JSX.Element {
  const {
    ariaLabel,
    minScreenPx = DEFAULT_MIN_SCREEN_PX,
    radius = 0.5,
    position,
    disabled = false,
    focusOrder = 0,
    group,
    children,
  } = props;

  // One mutable mirror of the props so DOM and pointer handlers never capture stale
  // callbacks and never need re-binding.
  const latest = useRef(props);
  latest.current = props;

  const groupRef = useRef<Group>(null);
  const colliderRef = useRef<Mesh>(null);
  const pressed = useRef(false);
  const hovering = useRef(false);

  // Fetched per mount, not held in a module constant: both live in scene caches now and a
  // game entering after an eviction has to be handed the rebuilt object, not a disposed one.
  const collider = useMemo(colliderGeometry, []);
  const colliderMat = useMemo(colliderMaterial, []);

  const rec = useMemo(() => (group ? getGroup(group) : null), [group]);
  const localStore = useMemo(() => createStore<FocusState>({ index: focusOrder, active: false }), [focusOrder]);
  const store = rec ? rec.store : localStore;
  const focusState = useStore(store);
  const focused = focusState.active && focusState.index === focusOrder && !disabled;

  /* ---------------- DOM counterpart ---------------- */

  useEffect(() => {
    const parent = rec ? rec.container : a11yRoot();
    if (!parent) return;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = ariaLabel;
    btn.style.cssText = SR_ONLY;
    btn.dataset.order = String(focusOrder);
    btn.tabIndex = rec || a11yLayerInert() ? -1 : 0;
    // `aria-disabled` rather than `disabled`: a disabled DOM button is unfocusable, which
    // would silently delete the roving group's only tab stop when it lands on this index.
    if (disabled) btn.setAttribute("aria-disabled", "true");

    const onClick = () => {
      const p = latest.current;
      // `a11yLayerInert()`: without native `inert`, a screen reader can still reach and
      // activate a mirrored button under the celebration dialog. See `INERT_SUPPORTED`.
      if (p.disabled || a11yLayerInert()) return;
      p.onPress?.();
      if (p.onSelect) p.onSelect();
      else rec?.activate?.(p.focusOrder ?? 0);
      p.onRelease?.();
    };
    const onFocus = () => localStore.set({ index: focusOrder, active: true });
    const onBlur = () => localStore.set({ index: focusOrder, active: false });

    btn.addEventListener("click", onClick);
    // Grouped targets get focus state from the container's focusin/focusout, which avoids a
    // blur/focus flicker when arrowing from one sibling to the next.
    if (!rec) {
      btn.addEventListener("focus", onFocus);
      btn.addEventListener("blur", onBlur);
    }

    // Keep DOM order matching focusOrder so Tab and arrows agree with what is on screen.
    let before: Element | null = null;
    for (let i = 0; i < parent.children.length; i++) {
      const child = parent.children[i] as HTMLElement;
      if (Number(child.dataset.order ?? "0") > focusOrder) {
        before = child;
        break;
      }
    }
    parent.insertBefore(btn, before);

    if (rec) {
      rec.refs++;
      rec.elements.set(focusOrder, btn);
      applyRoving(rec);
    }

    return () => {
      btn.removeEventListener("click", onClick);
      if (!rec) {
        btn.removeEventListener("focus", onFocus);
        btn.removeEventListener("blur", onBlur);
      }
      btn.remove();
      if (rec) {
        if (rec.elements.get(focusOrder) === btn) rec.elements.delete(focusOrder);
        applyRoving(rec);
        releaseGroup(rec);
      }
    };
  }, [ariaLabel, disabled, focusOrder, localStore, rec]);

  /* ---------------- Pointer ---------------- */

  const cancelPress = useCallback(() => {
    if (!pressed.current) return;
    pressed.current = false;
    latest.current.onRelease?.();
  }, []);

  useEffect(() => {
    // R3F only reports pointerup over the object. Releasing anywhere else must still end
    // the press, or a target stays visually held down forever.
    window.addEventListener("pointerup", cancelPress);
    window.addEventListener("pointercancel", cancelPress);
    return () => {
      window.removeEventListener("pointerup", cancelPress);
      window.removeEventListener("pointercancel", cancelPress);
    };
  }, [cancelPress]);

  const onPointerDown = (e: ThreeEvent<PointerEvent>) => {
    if (latest.current.disabled) return;
    e.stopPropagation();
    pressed.current = true;
    latest.current.onPress?.();
  };

  const onPointerUp = (e: ThreeEvent<PointerEvent>) => {
    if (!pressed.current) return;
    e.stopPropagation();
    pressed.current = false;
    latest.current.onRelease?.();
    if (!latest.current.disabled) latest.current.onSelect?.();
  };

  const onPointerOver = (e: ThreeEvent<PointerEvent>) => {
    if (latest.current.disabled || hovering.current) return;
    e.stopPropagation();
    hovering.current = true;
    latest.current.onHover?.(true);
  };

  const onPointerOut = () => {
    if (hovering.current) {
      hovering.current = false;
      latest.current.onHover?.(false);
    }
    // Sliding off a target cancels the press — it must not select.
    cancelPress();
  };

  /* ---------------- Collider sizing ---------------- */

  // -1, so `(frame + 1) & CHECK_MASK` is 0 on the *first* frame. Starting at 0 meant the
  // first sizing pass happened on frame 8, and until then every collider was an unscaled
  // unit sphere — a 268 px-wide target at the standard framing, overlapping its neighbours
  // for the first moments of every game.
  const frame = useRef(-1);
  const lastDepth = useRef(-1);
  const lastHeight = useRef(-1);

  // Before the first frame runs at all, the collider is at least the prop's own radius
  // rather than a one-world-unit sphere. Cheap belt-and-braces for the frame between
  // commit and the first `useFrame`.
  useLayoutEffect(() => {
    colliderRef.current?.scale.setScalar(radius);
  }, [radius]);

  const probe = useMemo<HitTargetProbe | null>(
    () =>
      PROBING
        ? {
            label: ariaLabel,
            disabled,
            minScreenPx,
            x: 0,
            y: 0,
            r: 0,
            radiusPx: 0,
            measured: false,
          }
        : null,
    [ariaLabel, disabled, minScreenPx]
  );

  useEffect(() => {
    if (probe === null) return;
    probes.add(probe);
    return () => {
      probes.delete(probe);
    };
  }, [probe]);

  useFrame((state) => {
    const g = groupRef.current;
    const c = colliderRef.current;
    if (!g || !c) return;

    frame.current = (frame.current + 1) & 0xffff;
    if ((frame.current & CHECK_MASK) !== 0) return;

    const camera = state.camera as PerspectiveCamera;
    if (!camera.isPerspectiveCamera) return;

    const depth = viewDepth(g, camera, lastDepth.current < 0);
    if (depth <= 0) return;

    // A changed view height changes what a screen pixel is worth, so the cached depth must
    // stop suppressing the next check. `resize`/`orientationchange` do not cover this: the
    // play area also changes height when the shell relayouts, and drei's portal size only
    // refreshes on a React re-render.
    const height = viewHeightPx(state);
    if (height !== lastHeight.current) {
      lastHeight.current = height;
      lastDepth.current = -1;
    }

    // Resize only on a meaningful depth change; a prop drifting a millimetre is not one.
    const settled =
      lastDepth.current > 0 &&
      Math.abs(depth - lastDepth.current) < lastDepth.current * DEPTH_TOLERANCE;
    if (settled && probe === null) return;

    const perPixel = worldPerPixel(camera, depth, height);
    const needed = minScreenPx * 0.5 * perPixel;
    const target = needed > radius ? needed : radius;

    if (!settled) {
      lastDepth.current = depth;
      g.getWorldScale(_scale);
      const parent = Math.max(_scale.x, _scale.y, _scale.z) || 1;
      c.scale.setScalar(target / parent);
    }

    if (probe !== null) {
      g.getWorldPosition(_screen);
      _screen.project(camera);
      const width = height * (camera.aspect || 1);
      probe.x = (_screen.x * 0.5 + 0.5) * width;
      probe.y = (0.5 - _screen.y * 0.5) * height;
      probe.r = target / perPixel;
      probe.radiusPx = radius / perPixel;
      probe.disabled = disabled;
      probe.measured = true;
    }
  });

  return (
    <group ref={groupRef} position={position}>
      {children}
      {/*
        `radius`, not `radius * 1.2`. The ring is sized against the target's *footprint*
        now — the same disc the collider below is grown to — and adds its own 0–5 %
        clearance. The old 1.2 multiplied with the outermost torus's tube to put the ring's
        outer edge at 1.464x the prop, which is the 240 px-over-a-150 px-card measurement.
      */}
      <FocusRing
        visible={focused}
        radius={radius}
        minScreenPx={minScreenPx}
        label={ariaLabel}
      />
      <mesh
        ref={colliderRef}
        geometry={collider}
        material={colliderMat}
        onPointerDown={disabled ? undefined : onPointerDown}
        onPointerUp={disabled ? undefined : onPointerUp}
        onPointerOver={disabled ? undefined : onPointerOver}
        onPointerOut={disabled ? undefined : onPointerOut}
        onPointerCancel={disabled ? undefined : onPointerOut}
      />
    </group>
  );
}
