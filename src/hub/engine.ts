/**
 * The hub's layout + interaction state.
 *
 * The nine hub cards are real 3D clay slabs, but the *truth* about where they are is the
 * DOM: nine transparent `<button>`s laid out by CSS grid. This module is the bridge. It
 * measures those buttons on layout and resize — never per frame — converts their rects into
 * world space, and holds one spring set per card so `useFrame` can write instance matrices
 * without allocating and without ever touching React.
 *
 * The projection is exact, not approximate. The hub camera looks straight down -Z at the
 * plane the slabs live on, so world units and CSS pixels are related by a single scalar:
 *
 *     worldPerPixel = (2 * distance * tan(fov / 2)) / gridHeightInPixels
 *
 * Everything else — slab thickness, bevel radius, prop size, lift and press travel — is
 * expressed as a fraction of a card's measured height, so the hub looks identical whether
 * the grid is one column tall on a phone or three columns wide on a tablet.
 */
import { Spring, anticipate, clamp01 } from "../three/anim";
import { isReduced } from "../three/store";

/* ------------------------------------------------------------------ */
/* Framing                                                             */
/* ------------------------------------------------------------------ */

/** Long-lens miniature framing (3D-SPEC §2): inside the 26–32 fov band, 8–16 unit band. */
export const HUB_FOV = 28;
export const HUB_DISTANCE = 12;

/** World height of the tracked grid rect. Constant, because the camera never dollies. */
export const HUB_WORLD_HEIGHT = 2 * HUB_DISTANCE * Math.tan((HUB_FOV * Math.PI) / 360);

export const HUB_CAMERA_POSITION: [number, number, number] = [0, 0, HUB_DISTANCE];
export const HUB_CAMERA_TARGET: [number, number, number] = [0, 0, 0];

/* ------------------------------------------------------------------ */
/* Slab proportions — all in units of one card's measured height        */
/* ------------------------------------------------------------------ */

export const SLAB = {
  /** Real depth. A 140px card is a 26 mm thick slab of clay at product scale. */
  thickness: 0.185,
  /** Bevel radius. Matches the 30px CSS radius the cards used to carry. */
  corner: 0.2,
  /** Leaned back like a plaque propped on a shelf, so the key rakes across the top face. */
  tilt: -0.1,
  /**
   * Gap between a resting slab's back face and the backdrop it shadows onto. Wide enough
   * that the key throws a readable drop shadow down and to the right, tight enough that a
   * pressed slab never reaches the backdrop.
   */
  panelGap: 0.12,
  /** Hover / focus travel toward the camera. */
  lift: 0.085,
  /** Press travel into the surface. Strictly less than `panelGap` — a slab never clips. */
  press: 0.058,
  /** How far outside the slab the focus halo shows. */
  ringPad: 0.075,
  ringThickness: 0.055,
  /** Accent inlay thickness, as a fraction of the *inlay's* own size. */
  tileThickness: 0.13,
  tileCorner: 0.29,
  /** Prop size as a fraction of the inlay it stands on. */
  propFill: 0.86,
} as const;

/**
 * Entry: each slab starts small and flat against the backdrop, then swells and lifts off it.
 * `ENTER_FROM` deliberately stays shallower than `panelGap` — a slab that started *behind*
 * the backdrop would spend three quarters of its animation hidden and then pop.
 */
const ENTER_FROM = -0.06;
const ENTER_SCALE = 0.86;
/** Stagger between neighbouring cards on a cold hub. Zero under reduced motion. */
const ENTER_STAGGER = 0.035;
/** Coming back from a game is a re-settle, not an arrival — a third of the stagger. */
const RETURN_STAGGER = 0.016;

/** The selected slab's dive toward the camera when a game opens. */
const DIVE_DURATION = 0.24;
const DIVE_TRAVEL = 2.4;
const DIVE_SCALE = 0.34;
/**
 * Everything the child did not pick steps quietly back out of the way. Mostly scale, barely
 * any travel: pushing them a long way back would drive them straight through the backdrop
 * and print a hard intersection line across the grid.
 */
const RECEDE_TRAVEL = 0.07;
const RECEDE_SCALE = 0.1;
const RECEDE_LAMBDA = 12;

export type HubCardState = {
  /* ---- layout, world units, written by `measureHub` ---- */
  x: number;
  y: number;
  /** Card width and height in world units. `h` is the unit every proportion above scales by. */
  w: number;
  h: number;
  /** Accent-inlay centre, offset from the card centre, in card-height units. */
  tx: number;
  ty: number;
  /** Accent-inlay side length, in card-height units. */
  tsize: number;

  /* ---- interaction, driven by DOM events, integrated per frame ---- */
  press: Spring;
  lift: Spring;
  ring: Spring;
  enter: Spring;
  /** Seconds after the hub appears before this card starts arriving. */
  delay: number;
  started: boolean;
  hovered: boolean;
  focused: boolean;
  held: boolean;
  /** 0..1 recede for the cards the child did not pick. */
  recede: number;
};

const makeCard = (): HubCardState => ({
  x: 0,
  y: 0,
  w: 1,
  h: 1,
  tx: 0,
  ty: 0,
  tsize: 0.6,
  // Heavy-ish: a slab of clay has mass, so it settles rather than twanging.
  press: new Spring(0, 460, 30),
  lift: new Spring(0, 300, 24),
  ring: new Spring(0, 420, 26),
  enter: new Spring(0, 300, 24),
  delay: 0,
  started: false,
  hovered: false,
  focused: false,
  held: false,
  recede: 0,
});

export class HubEngine {
  readonly cards: HubCardState[];

  /** World units per CSS pixel on the slab plane. 0 until the first measurement lands. */
  scale = 0;
  /**
   * One card's height in world units — the unit every SLAB proportion multiplies by.
   * Zero until the first measurement, which is what keeps the scene from drawing nine
   * unit-sized slabs stacked on the origin for the frame before the DOM has been read.
   */
  unit = 0;
  /** Slab aspect (width / height), quantised so the shared geometry cache stays bounded. */
  aspect = 2;
  /** Grid size in world units, used to size the backdrop. */
  viewW = 12;
  viewH = HUB_WORLD_HEIGHT;
  /** Side of the square the single shadow map has to cover. */
  shadowArea = 12;
  /** Bumped by every successful measurement so the scene knows to re-place static objects. */
  layout = 0;
  measured = false;

  private clock = 0;
  private diveIndex = -1;
  private diveClock = -1;

  constructor(count: number) {
    this.cards = [];
    for (let i = 0; i < count; i++) this.cards.push(makeCard());
  }

  /* ---------------- entry / exit ---------------- */

  /**
   * Restarts the arrival. `returning` shortens the stagger to almost nothing, because
   * coming back from a game should feel like the shelf is already there.
   */
  begin(returning: boolean): void {
    const reduced = isReduced();
    const stagger = reduced ? 0 : returning ? RETURN_STAGGER : ENTER_STAGGER;
    this.clock = 0;
    this.diveIndex = -1;
    this.diveClock = -1;
    for (let i = 0; i < this.cards.length; i++) {
      const c = this.cards[i];
      c.delay = i * stagger;
      c.started = false;
      c.recede = 0;
      c.held = false;
      c.hovered = false;
      c.focused = false;
      c.enter.set(returning ? 0.45 : 0);
      c.press.set(0);
      c.lift.set(0);
      c.ring.set(0);
    }
  }

  /** The child picked a card. Everything else steps back; this one dives at the camera. */
  select(index: number): void {
    if (isReduced()) return;
    this.diveIndex = index;
    this.diveClock = 0;
  }

  /* ---------------- pointer / keyboard ---------------- */

  setHover(index: number, on: boolean): void {
    const c = this.cards[index];
    if (!c || c.hovered === on) return;
    c.hovered = on;
    if (!on) c.held = false;
    this.refresh(c);
  }

  setFocus(index: number, on: boolean): void {
    const c = this.cards[index];
    if (!c || c.focused === on) return;
    c.focused = on;
    c.ring.to(on ? 1 : 0);
    this.refresh(c);
  }

  setHeld(index: number, on: boolean): void {
    const c = this.cards[index];
    if (!c || c.held === on) return;
    c.held = on;
    // Anticipation on release: the slab is kicked back out rather than eased out, so the
    // pop is visible in the very next frame.
    if (!on) c.press.impulse(-2.4);
    this.refresh(c);
  }

  private refresh(c: HubCardState): void {
    c.press.to(c.held ? 1 : 0);
    c.lift.to(!c.held && (c.hovered || c.focused) ? 1 : 0);
  }

  /* ---------------- per-frame ---------------- */

  /** Integrates every spring. Allocation-free; safe to call from `useFrame`. */
  step(dt: number): void {
    this.clock += dt;
    const diving = this.diveIndex >= 0;
    if (diving) this.diveClock += dt;

    for (let i = 0; i < this.cards.length; i++) {
      const c = this.cards[i];
      if (!c.started && this.clock >= c.delay) {
        c.started = true;
        c.enter.to(1);
      }
      c.enter.step(dt);
      c.press.step(dt);
      c.lift.step(dt);
      c.ring.step(dt);

      const target = diving && i !== this.diveIndex ? 1 : 0;
      c.recede += (target - c.recede) * (1 - Math.exp(-RECEDE_LAMBDA * dt));
    }
  }

  /**
   * Slab centre Z for card `i`, in world units. The slab's resting back face sits at z = 0,
   * `SLAB.panelGap` in front of the backdrop it drops its shadow onto.
   */
  centreZ(i: number): number {
    const c = this.cards[i];
    // `enter` runs 0 -> 1; at 0 the slab is still behind the backdrop, arriving.
    let z = SLAB.thickness * 0.5 + (1 - c.enter.value) * ENTER_FROM;
    z += c.lift.value * SLAB.lift - c.press.value * SLAB.press - c.recede * RECEDE_TRAVEL;
    if (i === this.diveIndex && this.diveClock >= 0) {
      z += anticipate(clamp01(this.diveClock / DIVE_DURATION), 0.1) * DIVE_TRAVEL;
    }
    return z * this.unit;
  }

  /** Uniform scale multiplier for card `i` (1 = at rest). */
  scaleOf(i: number): number {
    const c = this.cards[i];
    let s = ENTER_SCALE + (1 - ENTER_SCALE) * c.enter.value;
    s += c.lift.value * 0.018 - c.press.value * 0.03 - c.recede * RECEDE_SCALE;
    if (i === this.diveIndex && this.diveClock >= 0) {
      s += clamp01(this.diveClock / DIVE_DURATION) * DIVE_SCALE;
    }
    return s;
  }

  /** How hard card `i` is being squashed right now: 0 at rest, negative while pressed. */
  squashOf(i: number): number {
    const c = this.cards[i];
    return -c.press.value * 0.16;
  }
}

/* ------------------------------------------------------------------ */
/* Measurement                                                         */
/* ------------------------------------------------------------------ */

/** Quantised so a few pixels of reflow never build a second copy of the slab geometry. */
const quantiseAspect = (a: number) => {
  const clamped = a < 1.05 ? 1.05 : a > 4.6 ? 4.6 : a;
  return Math.round(clamped * 20) / 20;
};

/**
 * Reads the DOM grid and writes world-space layout into the engine.
 *
 * Runs on mount, on `ResizeObserver`, on window resize and once the webfont lands — never
 * per frame, and never on scroll: drei's `<View>` re-reads the tracked rect every frame, so
 * the rendered slabs and the DOM cells move together by construction.
 *
 * @returns the quantised slab aspect, or 0 when the grid is not laid out yet.
 */
export function measureHub(
  engine: HubEngine,
  grid: HTMLElement,
  cards: readonly (HTMLElement | null)[],
  slots: readonly (HTMLElement | null)[]
): number {
  const g = grid.getBoundingClientRect();
  if (g.width < 4 || g.height < 4) return 0;

  const s = HUB_WORLD_HEIGHT / g.height;
  engine.scale = s;
  engine.viewW = g.width * s;
  engine.viewH = HUB_WORLD_HEIGHT;

  let sumW = 0;
  let sumH = 0;
  let seen = 0;

  for (let i = 0; i < engine.cards.length; i++) {
    const el = cards[i];
    const state = engine.cards[i];
    if (!el) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;

    state.x = (r.left + r.width * 0.5 - g.left - g.width * 0.5) * s;
    state.y = -(r.top + r.height * 0.5 - g.top - g.height * 0.5) * s;
    state.w = r.width * s;
    state.h = r.height * s;

    // The accent inlay and the prop stand exactly where the DOM reserves space for them,
    // so the 3D and the text can never drift apart on a reflow.
    const slot = slots[i];
    if (slot) {
      const q = slot.getBoundingClientRect();
      state.tx = (q.left + q.width * 0.5 - (r.left + r.width * 0.5)) / r.height;
      state.ty = -(q.top + q.height * 0.5 - (r.top + r.height * 0.5)) / r.height;
      state.tsize = Math.min(q.width, q.height) / r.height;
    }

    sumW += r.width;
    sumH += r.height;
    seen++;
  }

  if (seen === 0) return 0;

  engine.unit = (sumH / seen) * s;
  engine.aspect = quantiseAspect(sumW / sumH);
  // The shadow frustum is axis-aligned to the light, not to the grid, so it has to hold the
  // grid's diagonal or the corner cards fall outside the map and lose their shadow.
  // Quantised: a window drag fires ResizeObserver continuously, and re-rendering the rig
  // on every pixel of it would rebuild the shadow frustum dozens of times a second.
  engine.shadowArea = Math.round(Math.hypot(engine.viewW, engine.viewH) * 1.12 * 2) / 2;
  engine.layout++;
  engine.measured = true;
  return engine.aspect;
}
