/**
 * Disposal + leak tracking.
 *
 * A child bounces between all nine games in one sitting, so leaving a game must return
 * GPU memory to the hub baseline. Anything a game allocates that is not in a shared cache
 * must be registered here and released on unmount.
 */
import {
  BufferGeometry,
  Material,
  Object3D,
  Texture,
  WebGLRenderTarget,
  type WebGLRenderer,
} from "three";

/* ------------------------------------------------------------------ */
/* Resource census — naming the residue, in the real app               */
/* ------------------------------------------------------------------ */

/**
 * ## Why this exists
 *
 * Round 3 "proved" the eviction machinery correct with a headless simulation of the cache
 * builders, and the real app still ended a nine-game loop above the hub baseline. The
 * simulation could not see the residue because the residue is **not in a cache**: every
 * `<id>-memory-after.json` reports `cacheDelta` zero on every registered cache, so whatever
 * survives is outside the only thing the simulation modelled.
 *
 * `renderer.info.memory.geometries` is a bare integer. It can say *how many* survive and can
 * never say *which*, so four rounds of audit have argued about an unnamed number. This names
 * them, from inside the running page, with no harness in the loop:
 *
 *  - every geometry and every texture reachable from a scene that is actually being rendered
 *    is recorded once, with the scene that was live at the time and the object that held it;
 *  - `dispose()` on a three resource dispatches a `dispose` event, so a one-shot listener is
 *    enough to drop the record the instant the resource is genuinely freed;
 *  - what is left after `flushSceneEviction()` is, by construction, exactly the survivors —
 *    and each one carries its owning scene and its construction site.
 *
 * Off by default and off in production: `enableResourceCensus()` is called only by
 * `src/dev/perf.ts`, and only under `?perf` or `?selftest`. When it is off, `censusScene` is
 * a single boolean test.
 */
export type ResourceKind = "geometry" | "texture";

export type ResourceRecord = {
  kind: ResourceKind;
  uuid: string;
  /** three's class name — `BufferGeometry`, `CanvasTexture`, `DataTexture`, … */
  type: string;
  /** The scene that was live the first time this resource was seen in a rendered graph. */
  owner: string | null;
  /** Where it was seen: object name/type, and its parent chain, so a survivor is findable. */
  site: string;
  /** Vertices for a geometry, pixels for a texture. Ranks the residue by what it costs. */
  size: number;
  /** True when `markShared` was called on it — surviving is then correct, not a leak. */
  shared: boolean;
};

let censusOn = false;
const census = new Map<string, ResourceRecord>();

/** Turns the census on. Idempotent. Called from `src/dev/perf.ts` only. */
export function enableResourceCensus(): void {
  censusOn = true;
}

export const isResourceCensusOn = (): boolean => censusOn;

const siteOf = (obj: Object3D): string => {
  let node: Object3D | null = obj;
  let out = "";
  for (let depth = 0; node !== null && depth < 4; depth++) {
    const label = node.name !== "" ? `${node.type}(${node.name})` : node.type;
    out = out === "" ? label : `${out} < ${label}`;
    node = node.parent;
  }
  return out;
};

function record(
  kind: ResourceKind,
  resource: BufferGeometry | Texture,
  site: string,
  size: number
): void {
  const existing = census.get(resource.uuid);
  if (existing !== undefined) {
    // `markShared` can be called after a resource has already been drawn once (a cache that
    // promotes an entry on a second scene's hit), so the flag is refreshed rather than
    // frozen at first sight. Nothing else about a record can change.
    if (!existing.shared && isShared(resource)) existing.shared = true;
    return;
  }
  const entry: ResourceRecord = {
    kind,
    uuid: resource.uuid,
    // `BufferGeometry.type` is a class name; `Texture.type` is a GL data-type *number*.
    // The constructor name is the only field that means the same thing for both.
    type: resource.constructor.name,
    owner: activeScene,
    site,
    size,
    shared: isShared(resource),
  };
  census.set(resource.uuid, entry);
  // `dispose()` dispatches this. One-shot, so a resource that is freed leaves no trace and
  // the census only ever holds things that are still alive.
  const onDispose = () => {
    census.delete(resource.uuid);
    resource.removeEventListener("dispose", onDispose);
  };
  resource.addEventListener("dispose", onDispose);
}

const texturePixels = (t: Texture): number => {
  const image = t.image as { width?: number; height?: number } | null | undefined;
  return image && typeof image.width === "number" && typeof image.height === "number"
    ? image.width * image.height
    : 0;
};

function recordMaterial(material: Material, site: string): void {
  for (const key of Object.keys(material)) {
    const value = (material as unknown as Record<string, unknown>)[key];
    if (value instanceof Texture) record("texture", value, `${site}.${key}`, texturePixels(value));
  }
}

/**
 * Records every geometry and texture under a scene that is about to be drawn.
 *
 * Called from the `gl.render` wrapper in `src/dev/perf.ts`, which is the only place in the
 * app guaranteed to see every scene that actually reaches the framebuffer — including drei
 * `<View>`'s portal scenes, which are not children of the root scene and which no traversal
 * from `Stage` could ever reach. That blind spot is the reason a headless harness could not
 * find this.
 */
export function censusScene(root: Object3D): void {
  if (!censusOn) return;
  root.traverse((obj) => {
    const mesh = obj as Object3D & {
      geometry?: BufferGeometry;
      material?: Material | Material[];
    };
    if (mesh.geometry !== undefined) {
      const position = mesh.geometry.attributes.position as { count?: number } | undefined;
      record("geometry", mesh.geometry, siteOf(obj), position?.count ?? 0);
    }
    const material = mesh.material;
    if (Array.isArray(material)) {
      for (const m of material) recordMaterial(m, siteOf(obj));
    } else if (material !== undefined) {
      recordMaterial(material, siteOf(obj));
    }
  });
}

/**
 * Every resource still alive, newest first, optionally filtered to the ones a given scene
 * owns. `owner === null` means "first seen at the hub", which is the genuinely-shared tier.
 */
export function resourceCensus(opts?: { owner?: string | null; kind?: ResourceKind }): ResourceRecord[] {
  const out: ResourceRecord[] = [];
  census.forEach((entry) => {
    if (opts?.kind !== undefined && entry.kind !== opts.kind) return;
    if (opts !== undefined && "owner" in opts && entry.owner !== opts.owner) return;
    out.push(entry);
  });
  out.sort((a, b) => b.size - a.size);
  return out;
}

/**
 * Live resources grouped by the scene that first rendered them — the one-line answer to
 * "who is holding the +4 geometries?".
 */
export function resourceCensusByOwner(): Record<string, { geometries: number; textures: number }> {
  const out: Record<string, { geometries: number; textures: number }> = {};
  census.forEach((entry) => {
    const key = entry.owner ?? "(hub/shared)";
    const bucket = out[key] ?? (out[key] = { geometries: 0, textures: 0 });
    if (entry.kind === "geometry") bucket.geometries++;
    else bucket.textures++;
  });
  return out;
}

type Disposable = { dispose: () => void };

/** Resources owned by shared caches — never disposed on scene exit. */
const shared = new WeakSet<object>();

/** Marks a resource as shared/persistent so `disposeObject3D` skips it. */
export function markShared<T extends object>(resource: T): T {
  shared.add(resource);
  return resource;
}

export const isShared = (resource: object) => shared.has(resource);

const disposeMaterial = (m: Material) => {
  if (isShared(m)) return;
  for (const key of Object.keys(m) as (keyof Material)[]) {
    const value = m[key] as unknown;
    if (value instanceof Texture && !isShared(value)) value.dispose();
  }
  m.dispose();
};

/**
 * Frees every geometry, material and texture under `root` that is not shared.
 * Safe to call twice.
 */
export function disposeObject3D(root: Object3D): void {
  root.traverse((obj) => {
    const mesh = obj as Object3D & { geometry?: BufferGeometry; material?: Material | Material[] };
    if (mesh.geometry && !isShared(mesh.geometry)) mesh.geometry.dispose();
    if (Array.isArray(mesh.material)) mesh.material.forEach(disposeMaterial);
    else if (mesh.material) disposeMaterial(mesh.material);
  });
  root.clear();
}

/**
 * A per-scene bag of disposables. Create one per game, register everything it makes,
 * call `release()` on unmount.
 */
export class DisposalBag {
  private items: Disposable[] = [];
  private cleanups: (() => void)[] = [];

  add<T extends Disposable>(item: T): T {
    this.items.push(item);
    return item;
  }

  /** Registers an arbitrary teardown (listener removal, RAF cancel, timer clear). */
  onRelease(fn: () => void): void {
    this.cleanups.push(fn);
  }

  release(): void {
    for (const fn of this.cleanups) {
      try {
        fn();
      } catch {
        /* teardown must never throw during unmount */
      }
    }
    for (const item of this.items) {
      if (!isShared(item as unknown as object)) item.dispose();
    }
    this.cleanups.length = 0;
    this.items.length = 0;
  }
}

/* ------------------------------------------------------------------ */
/* Scene-scoped shared caches                                          */
/* ------------------------------------------------------------------ */

/**
 * `geometry.ts`, `materials.ts` and `textures.ts` each memoise their output in a
 * module-level `Map`. That is right for the entries the hub and several games share, and
 * wrong for the ones a single game builds and nothing else ever asks for: those pin
 * geometry, programs and textures for the life of the tab, so `renderer.info` never comes
 * back to the hub baseline that `3D-SPEC §5` requires after hub → game → hub.
 *
 * So each cache registers here and tags every lookup. Ownership is inferred, never
 * declared:
 *
 *  - an entry first built while a game's scene is live belongs to that game;
 *  - the moment any *other* scene — including the hub, which is "no scene" — asks for the
 *    same key, it is promoted to the shared tier and is never evicted again;
 *  - leaving a game frees everything still owned by it, minus anything a surviving cache
 *    entry still points at (a shared material holding a game-built texture, say), which is
 *    promoted instead of freed.
 *
 * Eviction is deferred to the moment the game's `<View>` actually unmounts, because that
 * is the first instant at which nothing can still be drawing with these resources.
 * Freeing them a frame early would make three re-upload them behind our back and turn a
 * cache entry into an untracked orphan — strictly worse than the drift we are fixing.
 *
 * ## The ordering contract, stated because it is load-bearing and was invisible
 *
 * **`enterScene(id)` must run before the incoming scene's subtree renders.** Every cache
 * lookup a game makes happens in `useMemo` during render, which is earlier than any effect;
 * an attribution window opened from a mount effect would stamp all of it `owner = null` —
 * the genuinely-shared tier — and eviction would then skip it forever.
 *
 * Today that holds because `GamesCollection.open()` calls `markSceneEnter` from the pointer
 * handler, *before* `setActive(game)`, and `markSceneEnter` calls `enterScene`. That is one
 * statement order in a file this module cannot see, so it is not asserted here — it is
 * *counted*. `cacheOwnership()` splits first-tags into `taggedOwned` and `taggedUnowned`, and
 * a game whose entries land in `taggedUnowned` is exactly this contract broken. The round-3
 * audit filed the breakage as a blocker (A1); the artefacts it filed with contradict it —
 * `caches` returns to `{texture: 1, material: 14, geometry: 21}`, the hub baseline, after
 * every one of nine games across two loops, which cannot happen if nothing is ever evicted.
 * The counter exists so the next round settles it by reading a number rather than the code.
 *
 * Note also that `flushSceneEviction()` runs from `enterScene`, so an entry owned by scene A
 * is gone before scene B can ask for its key. The promotion branch in `tagCacheEntry` is
 * therefore a safety net for the backstop-timer ordering, not the common path; the promotion
 * that does fire routinely is the `retained` check in `flushSceneEviction`, which spares a
 * texture a surviving cache entry still points at.
 */
export type SceneCache = {
  /** Stable identifier, used as the ownership namespace. */
  readonly name: string;
  /** Every live entry, key → resource. */
  entries: () => Iterable<[string, object]>;
  /** Frees the entry stored under `key` and forgets it. */
  evict: (key: string) => void;
  /** Live entry count. */
  size: () => number;
};

const sceneCaches = new Map<string, SceneCache>();

/** cache name → (key → owning scene id, or null once the entry is genuinely shared). */
const cacheOwners = new Map<string, Map<string, string | null>>();

/**
 * Lookups tagged since the last `enterScene`, split by whether the ownership window was
 * open at the time.
 *
 * This exists because the round-3 audit asserted that the window opened too late and every
 * entry was therefore stamped `null` — a claim that cannot be settled by reading the code,
 * only by counting. `cacheOwnership()` reports both, so a capture proves attribution
 * happened instead of a comment promising it.
 */
let taggedOwned = 0;
let taggedUnowned = 0;

/** The scene whose lookups are being attributed right now. `null` means the hub. */
let activeScene: string | null = null;
/** A scene that has been left but whose view may still be on screen. */
let pendingScene: string | null = null;
let pendingTimer = 0;

/**
 * Backstop only. The real trigger is `flushSceneEviction()` from the view's unmount; this
 * exists so a scene that somehow never unmounts its view cannot pin its cache forever.
 */
const EVICT_BACKSTOP_MS = 4000;

export function registerSceneCache(cache: SceneCache): void {
  sceneCaches.set(cache.name, cache);
  if (!cacheOwners.has(cache.name)) cacheOwners.set(cache.name, new Map());
}

/**
 * Records who a cached entry belongs to. Called on *every* lookup, hit or miss — a hit
 * from a second scene is exactly what promotes an entry to the shared tier.
 */
export function tagCacheEntry(cacheName: string, key: string): void {
  const owners = cacheOwners.get(cacheName);
  if (owners === undefined) return;
  const owner = owners.get(key);
  if (owner === undefined) {
    owners.set(key, activeScene);
    // Only a *first* tag decides ownership, so only a first tag is evidence about the
    // window. A later hit from a second scene is a promotion, not a miss.
    if (activeScene === null) taggedUnowned++;
    else taggedOwned++;
  } else if (owner !== null && owner !== activeScene) {
    owners.set(key, null);
  }
}

/**
 * Per-cache ownership tally: how many live entries each scene owns, how many are in the
 * genuinely-shared tier, and how the first-tag counts split since the last scene entry.
 *
 * `unowned` growing while a game is on screen is the exact signature of the attribution
 * window being closed when a game populates a cache. `owned` growing is proof it is open.
 */
export type CacheOwnership = {
  /** cache name → { sceneId → entries it owns }. */
  byCache: Record<string, Record<string, number>>;
  /** cache name → entries promoted to the shared tier. */
  sharedByCache: Record<string, number>;
  /** First-tags made with a scene live, since the last `enterScene`. */
  taggedOwned: number;
  /** First-tags made with no scene live (hub, or a closed window), since the same point. */
  taggedUnowned: number;
  activeScene: string | null;
  pendingScene: string | null;
};

export function cacheOwnership(): CacheOwnership {
  const byCache: Record<string, Record<string, number>> = {};
  const sharedByCache: Record<string, number> = {};
  cacheOwners.forEach((owners, name) => {
    const counts: Record<string, number> = {};
    let sharedCount = 0;
    owners.forEach((owner) => {
      if (owner === null) sharedCount++;
      else counts[owner] = (counts[owner] ?? 0) + 1;
    });
    byCache[name] = counts;
    sharedByCache[name] = sharedCount;
  });
  return {
    byCache,
    sharedByCache,
    taggedOwned,
    taggedUnowned,
    activeScene,
    pendingScene,
  };
}

/** The game whose scene is live, or null for the hub. Read by the memory snapshot. */
export const currentCacheScene = (): string | null => activeScene;

/** A scene has been left but its cache has not been reclaimed yet. */
export const pendingCacheScene = (): string | null => pendingScene;

/** Called from `markSceneEnter`. Reclaims the previous scene first. */
export function enterScene(scene: string): void {
  if (activeScene === scene && pendingScene === null) return;
  flushSceneEviction();
  activeScene = scene;
  taggedOwned = 0;
  taggedUnowned = 0;
}

/**
 * Called from `markSceneExit`. Arms the reclaim; `flushSceneEviction` performs it.
 * `activeScene` deliberately stays put until then, so lookups made while the outgoing
 * view finishes its exit animation are still attributed to the scene that is leaving.
 */
export function exitScene(scene: string): void {
  // Only the live scene can arm a reclaim. A game that mirrors `markSceneExit` in its own
  // unmount cleanup fires this a second time, after the view has already been reclaimed;
  // re-arming there would leave a stale pending scene behind.
  if (activeScene !== scene) return;
  pendingScene = scene;
  if (pendingTimer !== 0) clearTimeout(pendingTimer);
  if (typeof window !== "undefined") {
    pendingTimer = window.setTimeout(flushSceneEviction, EVICT_BACKSTOP_MS);
  }
}

const collectTextures = (resource: object, out: Set<object>): void => {
  for (const key of Object.keys(resource)) {
    const value = (resource as Record<string, unknown>)[key];
    if (value instanceof Texture) out.add(value);
  }
};

/**
 * Frees every cache entry still owned by the scene that was left. Safe to call at any
 * time and from anywhere: with nothing pending it is a no-op.
 *
 * Returns the number of entries freed, so the caller — and `__perf.memory()` — can show
 * that the reclaim actually happened rather than asserting it.
 */
export function flushSceneEviction(): number {
  const scene = pendingScene;
  // Nothing armed: return *before* touching `activeScene`. Entering a game unmounts the
  // hub's view, and clearing the incoming scene's attribution there would tag everything it
  // then builds as shared — which is exactly the drift this exists to stop.
  if (scene === null) return 0;
  if (pendingTimer !== 0) {
    clearTimeout(pendingTimer);
    pendingTimer = 0;
  }
  pendingScene = null;
  activeScene = null;
  // The first-tag counters are *since the last scene change*, and the scene has just ended.
  // Leaving them set is how the round-4 audit read `taggedOwned: 17, activeScene: null` as
  // "17 shared materials owned by a scene that no longer exists, which would block
  // eviction" — a live-ownership claim about a counter that has never been one. Live
  // ownership is `byCache`; these two are attribution evidence for the window that just
  // closed, so they close with it.
  taggedOwned = 0;
  taggedUnowned = 0;

  // 1. Everything this scene owns, and the resource objects behind those keys.
  const plan: { cache: SceneCache; key: string; resource: object }[] = [];
  const doomed = new Set<object>();
  cacheOwners.forEach((owners, name) => {
    const cache = sceneCaches.get(name);
    if (cache === undefined) return;
    for (const [key, resource] of cache.entries()) {
      if (owners.get(key) !== scene) continue;
      plan.push({ cache, key, resource });
      doomed.add(resource);
    }
  });
  if (plan.length === 0) return 0;

  // 2. Textures a *surviving* cache entry still points at. Freeing one of those would
  //    leave three to silently re-upload it with nothing left tracking it.
  const retained = new Set<object>();
  sceneCaches.forEach((cache) => {
    for (const [, resource] of cache.entries()) {
      if (doomed.has(resource)) continue;
      collectTextures(resource, retained);
    }
  });

  let freed = 0;
  for (const item of plan) {
    const owners = cacheOwners.get(item.cache.name);
    if (owners === undefined) continue;
    if (retained.has(item.resource)) {
      owners.set(item.key, null);
      continue;
    }
    item.cache.evict(item.key);
    owners.delete(item.key);
    freed++;
  }
  return freed;
}

/**
 * The live keys held by one registered cache.
 *
 * Exposed because a cache key is the only description some shared resources carry: the text
 * atlas encodes `text|size|weight|color|background|padding|maxWidth`, which is what
 * `?selftest=text-contrast` reads its ink and plate colours out of. Nothing here mutates.
 */
export function sceneCacheKeys(name: string): string[] {
  const cache = sceneCaches.get(name);
  if (cache === undefined) return [];
  const out: string[] = [];
  for (const [key] of cache.entries()) out.push(key);
  return out;
}

/** Live entry counts per registered cache — evidence for the memory budget. */
export function sceneCacheSizes(): Record<string, number> {
  const out: Record<string, number> = {};
  sceneCaches.forEach((cache, name) => {
    out[name] = cache.size();
  });
  return out;
}

export type MemorySnapshot = {
  geometries: number;
  textures: number;
  programs: number;
  renderTargets: number;
  heapMB: number | null;
  /** Live entries in each shared cache, by cache name. */
  caches: Record<string, number>;
  /**
   * Non-null when a scene has been left but its cache has not been reclaimed yet — i.e.
   * the numbers above are a mid-transition reading, not a settled one.
   */
  pendingEviction: string | null;
  /**
   * Who owns what, right now. Carried in every snapshot because the interesting question
   * about a drift is never "how much" but "which tier is it sitting in": a `geometries`
   * count above baseline while `caches.geometry` is back *at* baseline says the residue is
   * outside every registered cache, and no amount of eviction work will ever reach it.
   */
  ownership: CacheOwnership;
};

const liveTargets = new Set<WebGLRenderTarget>();
export const trackRenderTarget = (rt: WebGLRenderTarget) => {
  liveTargets.add(rt);
  return rt;
};
export const untrackRenderTarget = (rt: WebGLRenderTarget) => {
  liveTargets.delete(rt);
  rt.dispose();
};

/** Objective snapshot used by the memory critic — hub baseline vs. after nine games. */
export function memorySnapshot(renderer: WebGLRenderer): MemorySnapshot {
  const perf = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
  return {
    geometries: renderer.info.memory.geometries,
    textures: renderer.info.memory.textures,
    programs: renderer.info.programs?.length ?? 0,
    renderTargets: liveTargets.size,
    heapMB: perf ? Math.round((perf.usedJSHeapSize / 1048576) * 10) / 10 : null,
    caches: sceneCacheSizes(),
    pendingEviction: pendingScene,
    ownership: cacheOwnership(),
  };
}
