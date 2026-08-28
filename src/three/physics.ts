/**
 * A small, honest rigid-body solver — spheres against static planes and static boxes.
 *
 * It exists because Tooth Rescue needs a *caught* tooth to land with weight and a candy to
 * ping off the basket rim and skitter away laughing. Nothing here tries to be a physics
 * engine; it tries to sell those two moments at a locked 60fps with zero per-frame
 * allocation.
 *
 * Scale note: 1 world unit = 10 cm (tokens.ts). Earth gravity would be 98 u/s², which in a
 * 10 cm-tall diorama looks like a dropped marble — over before a child can react. Miniature
 * photography has the same problem and solves it by over-cranking the camera; we solve it by
 * under-cranking gravity. `DEFAULT_GRAVITY` is ~2.6 m/s², which reads as "heavy object,
 * filmed slightly slow" rather than "floaty moon gravity". Games may override per level.
 */
import { Quaternion, Vector3 } from "three";
import type { Object3D } from "three";
import { safeDelta, Spring, squashFor } from "./anim";
import { isReduced } from "./store";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export type Body = {
  position: Vector3;
  velocity: Vector3;
  quaternion: Quaternion;
  angularVelocity: Vector3;
  radius: number;
  mass: number;
  /**
   * Bounciness of the *body*. Combined with the collider's by multiplication, so a
   * collider restitution of 1 is neutral and a soft-lined basket floor (0.35) can deaden
   * a body that is bouncy elsewhere.
   */
  restitution: number;
  friction: number;
  sleeping: boolean;
  alive: boolean;
  kind: string;
  userData: Record<string, unknown>;
};

export type BoxCollider = {
  center: Vector3;
  halfExtents: Vector3;
  restitution: number;
  kind: string;
  enabled: boolean;
};

type PlaneCollider = { y: number; restitution: number; kind: string };

/** Per-body solver bookkeeping, kept out of `Body` so games never see or corrupt it. */
type Internal = {
  sleepTimer: number;
  /** Seconds since the last contact — a body must be supported before it may sleep. */
  contactAge: number;
  /** One collision event per body per substep, whichever pass detects it. */
  reported: boolean;
};

export type CollisionCallback = (body: Body, withKind: string, impactSpeed: number) => void;

/* ------------------------------------------------------------------ */
/* Tuning                                                              */
/* ------------------------------------------------------------------ */

const DEFAULT_GRAVITY = 26;
const DEFAULT_FIXED_STEP = 1 / 120;

/**
 * A long frame (tab restore, GC pause, a slow first render) must never be replayed in full
 * or bodies teleport through the world. We clamp the frame, cap the substeps, and then
 * *drop* whatever backlog remains — a dropped 40 ms of simulation is invisible; a tunnelled
 * tooth is a bug report.
 */
const MAX_SUBSTEPS = 8;
const MAX_FRAME = 0.25;

/** Exponential per-second drag. Small: enough to settle sleep, not enough to look syrupy. */
const LINEAR_DAMPING = 0.35;
const ANGULAR_DAMPING = 1.1;

/**
 * Below this normal speed a contact does not bounce at all. Without it, low restitution
 * still produces an infinite series of ever-smaller hops and the landing reads as jittery
 * rather than heavy. 1.1 u/s ≈ the speed a tooth still has after its first small bounce.
 */
const REST_SPEED = 1.1;

/** How hard tangential velocity is scrubbed per unit of normal impact. */
const FRICTION_GAIN = 1.6;
/** How much of the scrubbed tangential velocity becomes tumble. */
const SPIN_GAIN = 0.55;

/** Resting contacts must not spam the game with "thud" events. */
const CONTACT_EVENT_SPEED = 0.5;

const SLEEP_ENERGY = 0.045;
const SLEEP_TIME = 0.28;
/** A body counts as supported for this long after its last contact. */
const CONTACT_MEMORY = 0.12;

const EPS = 1e-4;

/* ------------------------------------------------------------------ */
/* Module-scope scratch — step() must not allocate                     */
/* ------------------------------------------------------------------ */

const _from = new Vector3();
const _move = new Vector3();
const _normal = new Vector3();
const _hitNormal = new Vector3();
const _tangent = new Vector3();
const _spin = new Vector3();
const _closest = new Vector3();
const _contact = new Vector3();
const _spinQ = new Quaternion();

/* ------------------------------------------------------------------ */
/* World                                                               */
/* ------------------------------------------------------------------ */

export class PhysicsWorld {
  gravity = new Vector3(0, -DEFAULT_GRAVITY, 0);

  private bodies: Body[] = [];
  /** Parallel to `bodies` — index-aligned so the hot loop never hashes. */
  private internals: Internal[] = [];
  private planes: PlaneCollider[] = [];
  private boxes: BoxCollider[] = [];
  /** Previous centre of each box, index-aligned, so we can wake sleepers a mover reaches. */
  private boxPrev: Vector3[] = [];
  private callbacks: CollisionCallback[] = [];

  private fixedStep: number;
  private accumulator = 0;

  /* Scratch owned by the current contact resolution, so `emit` needs no arguments. */
  private hitKind = "";
  private hitRestitution = 1;

  constructor(opts?: { gravity?: number; fixedStep?: number }) {
    if (opts?.gravity !== undefined) this.gravity.set(0, -opts.gravity, 0);
    this.fixedStep = opts?.fixedStep ?? DEFAULT_FIXED_STEP;
  }

  addBody(init: Partial<Body>): Body {
    const body: Body = {
      position: new Vector3(),
      velocity: new Vector3(),
      quaternion: new Quaternion(),
      angularVelocity: new Vector3(),
      radius: init.radius ?? 0.35,
      mass: init.mass ?? 1,
      restitution: init.restitution ?? 0.3,
      friction: init.friction ?? 0.5,
      sleeping: false,
      alive: true,
      kind: init.kind ?? "body",
      userData: init.userData ?? {},
    };
    // Copy rather than alias: the caller's vectors stay theirs, ours stay stable.
    if (init.position) body.position.copy(init.position);
    if (init.velocity) body.velocity.copy(init.velocity);
    if (init.quaternion) body.quaternion.copy(init.quaternion);
    if (init.angularVelocity) body.angularVelocity.copy(init.angularVelocity);

    this.bodies.push(body);
    this.internals.push({ sleepTimer: 0, contactAge: CONTACT_MEMORY * 2, reported: false });
    return body;
  }

  removeBody(b: Body): void {
    const i = this.bodies.indexOf(b);
    if (i < 0) return;
    b.alive = false;
    // Swap-remove keeps both arrays index-aligned without shifting.
    const last = this.bodies.length - 1;
    this.bodies[i] = this.bodies[last];
    this.internals[i] = this.internals[last];
    this.bodies.pop();
    this.internals.pop();
  }

  /** An infinite up-facing floor at `y`. Bodies rest on top of it. */
  addPlane(y: number, restitution = 1, kind = "ground"): void {
    this.planes.push({ y, restitution, kind });
    this.wakeAll();
  }

  addBox(center: Vector3, halfExtents: Vector3, restitution = 1, kind = "box"): BoxCollider {
    const c: BoxCollider = {
      center: center.clone(),
      halfExtents: halfExtents.clone(),
      restitution,
      kind,
      enabled: true,
    };
    this.boxes.push(c);
    this.boxPrev.push(c.center.clone());
    this.wakeAll();
    return c;
  }

  removeBox(c: BoxCollider): void {
    const i = this.boxes.indexOf(c);
    if (i < 0) return;
    const last = this.boxes.length - 1;
    this.boxes[i] = this.boxes[last];
    this.boxPrev[i] = this.boxPrev[last];
    this.boxes.pop();
    this.boxPrev.pop();
    this.wakeAll();
  }

  /** Listeners survive `clear()` — games register once and restart many times. */
  onCollision(cb: CollisionCallback): void {
    this.callbacks.push(cb);
  }

  step(dt: number): void {
    if (!Number.isFinite(dt) || dt <= 0) return;
    this.accumulator += dt > MAX_FRAME ? MAX_FRAME : dt;

    this.trackMovedColliders();

    const h = this.fixedStep;
    let steps = 0;
    while (this.accumulator >= h && steps < MAX_SUBSTEPS) {
      this.substep(h);
      this.accumulator -= h;
      steps++;
    }
    // Whatever is left after the cap is thrown away rather than owed forever.
    if (this.accumulator >= h) this.accumulator = 0;
  }

  clear(): void {
    for (let i = 0; i < this.bodies.length; i++) this.bodies[i].alive = false;
    this.bodies.length = 0;
    this.internals.length = 0;
    this.planes.length = 0;
    this.boxes.length = 0;
    this.boxPrev.length = 0;
    this.accumulator = 0;
  }

  /* ---------------------------------------------------------------- */
  /* Internals                                                         */
  /* ---------------------------------------------------------------- */

  private wakeAll(): void {
    for (let i = 0; i < this.bodies.length; i++) this.bodies[i].sleeping = false;
  }

  /**
   * A basket slides under sleeping teeth every frame. Colliders are mutated in place by the
   * game, so we diff their centres and wake anything a moved collider can now reach —
   * otherwise a settled tooth would be left hanging in mid-air when the basket walks away.
   */
  private trackMovedColliders(): void {
    for (let i = 0; i < this.boxes.length; i++) {
      const c = this.boxes[i];
      const prev = this.boxPrev[i];
      if (c.center.distanceToSquared(prev) < 1e-8) continue;
      for (let b = 0; b < this.bodies.length; b++) {
        const body = this.bodies[b];
        if (!body.sleeping) continue;
        const reach = body.radius + 0.25;
        const hx = c.halfExtents.x + reach;
        const hy = c.halfExtents.y + reach;
        const hz = c.halfExtents.z + reach;
        // Test both centres: the body needs waking whether the collider has arrived at it
        // or just walked out from under it. Only checking the new centre leaves a settled
        // tooth hanging in mid-air when the basket slides away.
        const nearNew =
          Math.abs(body.position.x - c.center.x) <= hx &&
          Math.abs(body.position.y - c.center.y) <= hy &&
          Math.abs(body.position.z - c.center.z) <= hz;
        const nearOld =
          Math.abs(body.position.x - prev.x) <= hx &&
          Math.abs(body.position.y - prev.y) <= hy &&
          Math.abs(body.position.z - prev.z) <= hz;
        if (nearNew || nearOld) body.sleeping = false;
      }
      prev.copy(c.center);
    }
  }

  private substep(h: number): void {
    const bodies = this.bodies;
    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i];
      if (!b.alive || b.sleeping) continue;
      const info = this.internals[i];
      info.reported = false;
      info.contactAge += h;

      // Semi-implicit Euler: velocity first, then position from the *new* velocity.
      b.velocity.addScaledVector(this.gravity, h);
      const drag = Math.exp(-LINEAR_DAMPING * h);
      b.velocity.multiplyScalar(drag);

      this.sweep(b, info, h);
      this.resolveOverlaps(b, info);

      // Angular integration. dq = 0.5 * ω ⊗ q, then renormalise so drift never accumulates.
      const spinDrag = Math.exp(-ANGULAR_DAMPING * h);
      b.angularVelocity.multiplyScalar(spinDrag);
      const w = b.angularVelocity;
      if (w.lengthSq() > 1e-8) {
        _spinQ.set(w.x, w.y, w.z, 0);
        _spinQ.multiply(b.quaternion);
        const k = 0.5 * h;
        b.quaternion.x += _spinQ.x * k;
        b.quaternion.y += _spinQ.y * k;
        b.quaternion.z += _spinQ.z * k;
        b.quaternion.w += _spinQ.w * k;
        b.quaternion.normalize();
      }

      this.updateSleep(b, info, h);
    }
  }

  /**
   * Continuous integration: instead of teleporting the body and hoping, we walk the segment
   * from the old position to the new one, stop at the first surface it crosses, respond, and
   * spend whatever fraction of the step is left along the new velocity. Three passes is
   * enough for a corner without letting a pathological case run away.
   */
  private sweep(b: Body, info: Internal, h: number): void {
    let remaining = 1;
    _from.copy(b.position);

    for (let pass = 0; pass < 3 && remaining > 1e-4; pass++) {
      _move.copy(b.velocity).multiplyScalar(h * remaining);
      if (_move.lengthSq() < 1e-12) break;

      let bestT = 1;
      let hit = false;
      this.hitKind = "";
      this.hitRestitution = 1;

      for (let i = 0; i < this.planes.length; i++) {
        const p = this.planes[i];
        const surface = p.y + b.radius;
        const dy = _move.y;
        if (dy >= 0) continue;
        const startAbove = _from.y - surface;
        if (startAbove < -EPS) continue; // already below: the overlap pass owns this
        if (startAbove + dy > 0) continue;
        const t = startAbove <= 0 ? 0 : startAbove / -dy;
        if (t < bestT) {
          bestT = t;
          hit = true;
          _hitNormal.set(0, 1, 0);
          this.hitKind = p.kind;
          this.hitRestitution = p.restitution;
        }
      }

      for (let i = 0; i < this.boxes.length; i++) {
        const c = this.boxes[i];
        if (!c.enabled) continue;
        const t = sweepSphereBox(_from, _move, b.radius, c);
        if (t >= 0 && t < bestT) {
          bestT = t;
          hit = true;
          _hitNormal.copy(_normal);
          this.hitKind = c.kind;
          this.hitRestitution = c.restitution;
        }
      }

      if (!hit) {
        b.position.copy(_from).add(_move);
        return;
      }

      // Land a hair off the surface so the next pass starts outside it.
      b.position.copy(_from).addScaledVector(_move, bestT).addScaledVector(_hitNormal, EPS * 4);
      this.respond(b, info, _hitNormal, this.hitRestitution, this.hitKind);
      remaining *= 1 - bestT;
      _from.copy(b.position);
    }

    if (remaining > 1e-4) {
      // Ran out of passes inside a crevice — stop cleanly rather than squeeze through.
      b.position.copy(_from);
    }
  }

  /**
   * Static pass. Catches resting contacts (where the swept test finds nothing because the
   * body never crosses the surface) and anything a moving collider has swallowed since the
   * last substep.
   */
  private resolveOverlaps(b: Body, info: Internal): void {
    for (let i = 0; i < this.planes.length; i++) {
      const p = this.planes[i];
      const surface = p.y + b.radius;
      if (b.position.y >= surface) continue;
      b.position.y = surface;
      _normal.set(0, 1, 0);
      this.respond(b, info, _normal, p.restitution, p.kind);
    }

    for (let i = 0; i < this.boxes.length; i++) {
      const c = this.boxes[i];
      if (!c.enabled) continue;
      if (!closestPointOnBox(b.position, c, _closest)) continue;
      _normal.copy(b.position).sub(_closest);
      const distSq = _normal.lengthSq();
      if (distSq >= b.radius * b.radius) continue;

      if (distSq < 1e-10) {
        // Centre is inside the box: escape along the shallowest face.
        pushOutOfBox(b.position, c, _normal);
        b.position.addScaledVector(_normal, b.radius);
      } else {
        const dist = Math.sqrt(distSq);
        _normal.multiplyScalar(1 / dist);
        b.position.copy(_closest).addScaledVector(_normal, b.radius);
      }
      this.respond(b, info, _normal, c.restitution, c.kind);
    }
  }

  /** Normal restitution + Coulomb-ish friction + the tumble that friction implies. */
  private respond(b: Body, info: Internal, n: Vector3, colliderRestitution: number, kind: string): void {
    info.contactAge = 0;

    const vn = b.velocity.dot(n);
    if (vn >= 0) return;
    const impact = -vn;

    // Tangential component: everything that is not travelling along the normal.
    _tangent.copy(b.velocity).addScaledVector(n, -vn);
    const tSpeed = _tangent.length();
    const scrub = Math.min(tSpeed, b.friction * impact * FRICTION_GAIN);
    if (tSpeed > 1e-6) _tangent.multiplyScalar((tSpeed - scrub) / tSpeed);

    const e = b.restitution * colliderRestitution;
    let bounce = impact * e;
    if (bounce < REST_SPEED) bounce = 0;

    b.velocity.copy(_tangent).addScaledVector(n, bounce);

    // The velocity friction removed has to go somewhere: it becomes spin.
    // cross(normal, tangential) is the rolling axis — a ball sliding +x on the ground
    // (n=+Y, vt=+X) gets ω = -Z, which is exactly "rolling forwards".
    if (scrub > 1e-5) {
      _spin.crossVectors(n, _tangent).normalize();
      const spinMag = (scrub * SPIN_GAIN) / Math.max(b.radius, 0.05);
      b.angularVelocity.addScaledVector(_spin, spinMag);
    }

    if (!info.reported && impact >= CONTACT_EVENT_SPEED) {
      info.reported = true;
      for (let i = 0; i < this.callbacks.length; i++) this.callbacks[i](b, kind, impact);
    }
  }

  private updateSleep(b: Body, info: Internal, h: number): void {
    const spin = b.angularVelocity.lengthSq() * b.radius * b.radius;
    const energy = b.velocity.lengthSq() + spin;
    const supported = info.contactAge <= CONTACT_MEMORY;
    if (energy < SLEEP_ENERGY && supported) info.sleepTimer += h;
    else info.sleepTimer = 0;

    if (info.sleepTimer >= SLEEP_TIME) {
      b.sleeping = true;
      b.velocity.set(0, 0, 0);
      b.angularVelocity.set(0, 0, 0);
      info.sleepTimer = 0;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Collision primitives (free functions — no `this`, no allocation)    */
/* ------------------------------------------------------------------ */

/**
 * Swept sphere vs static AABB, done as a segment against the box inflated by the radius.
 * Returns the entry time in 0..1 and writes the contact normal into `_normal`, or -1.
 *
 * The inflated-box trick makes corners boxy, which for a basket rim is exactly the wrong
 * place to be wrong — a candy landing on the rim would bounce straight up instead of
 * flicking outwards. So after finding the entry time we recompute the normal from the true
 * box: if the contact point is outside on more than one axis we are on an edge or corner and
 * the honest normal is radial. That is what sends candy skittering off the rim.
 */
function sweepSphereBox(from: Vector3, move: Vector3, radius: number, c: BoxCollider): number {
  let tmin = 0;
  let tmax = 1;
  let axis = -1;
  let sign = -1;

  for (let a = 0; a < 3; a++) {
    const centre = a === 0 ? c.center.x : a === 1 ? c.center.y : c.center.z;
    const half = (a === 0 ? c.halfExtents.x : a === 1 ? c.halfExtents.y : c.halfExtents.z) + radius;
    const o = a === 0 ? from.x : a === 1 ? from.y : from.z;
    const d = a === 0 ? move.x : a === 1 ? move.y : move.z;
    const lo = centre - half;
    const hi = centre + half;

    if (d > -1e-9 && d < 1e-9) {
      if (o < lo || o > hi) return -1;
      continue;
    }
    let t1 = (lo - o) / d;
    let t2 = (hi - o) / d;
    let s = -1;
    if (t1 > t2) {
      const swap = t1;
      t1 = t2;
      t2 = swap;
      s = 1;
    }
    if (t1 > tmin) {
      tmin = t1;
      axis = a;
      sign = s;
    }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return -1;
  }

  // axis === -1 means the sphere already overlapped at t=0; the static pass owns that case.
  if (axis === -1 || tmin > 1 || tmin < 0) return -1;

  _contact.copy(from).addScaledVector(move, tmin);
  if (closestPointOnBox(_contact, c, _closest)) {
    _normal.copy(_contact).sub(_closest);
    const lenSq = _normal.lengthSq();
    // Two or more axes clamped ⇒ edge/corner ⇒ radial normal is the truthful one.
    if (lenSq > 1e-10) {
      _normal.multiplyScalar(1 / Math.sqrt(lenSq));
      return tmin;
    }
  }
  _normal.set(axis === 0 ? sign : 0, axis === 1 ? sign : 0, axis === 2 ? sign : 0);
  return tmin;
}

/** Writes the closest point on the box to `p` into `out`. Returns false if `p` is inside. */
function closestPointOnBox(p: Vector3, c: BoxCollider, out: Vector3): boolean {
  const dx = p.x - c.center.x;
  const dy = p.y - c.center.y;
  const dz = p.z - c.center.z;
  const cx = dx < -c.halfExtents.x ? -c.halfExtents.x : dx > c.halfExtents.x ? c.halfExtents.x : dx;
  const cy = dy < -c.halfExtents.y ? -c.halfExtents.y : dy > c.halfExtents.y ? c.halfExtents.y : dy;
  const cz = dz < -c.halfExtents.z ? -c.halfExtents.z : dz > c.halfExtents.z ? c.halfExtents.z : dz;
  out.set(c.center.x + cx, c.center.y + cy, c.center.z + cz);
  return cx !== dx || cy !== dy || cz !== dz;
}

/** Deepest-point escape: writes the shallowest face normal into `out` and snaps `p` to it. */
function pushOutOfBox(p: Vector3, c: BoxCollider, out: Vector3): void {
  const dx = p.x - c.center.x;
  const dy = p.y - c.center.y;
  const dz = p.z - c.center.z;
  const px = c.halfExtents.x - Math.abs(dx);
  const py = c.halfExtents.y - Math.abs(dy);
  const pz = c.halfExtents.z - Math.abs(dz);

  if (px <= py && px <= pz) {
    const s = dx >= 0 ? 1 : -1;
    out.set(s, 0, 0);
    p.x = c.center.x + s * c.halfExtents.x;
  } else if (py <= pz) {
    const s = dy >= 0 ? 1 : -1;
    out.set(0, s, 0);
    p.y = c.center.y + s * c.halfExtents.y;
  } else {
    const s = dz >= 0 ? 1 : -1;
    out.set(0, 0, s);
    p.z = c.center.z + s * c.halfExtents.z;
  }
}

/* ------------------------------------------------------------------ */
/* SoftWobble — jelly for the basket                                   */
/* ------------------------------------------------------------------ */

/**
 * Units, because a wobble with mismatched drives either never moves or is permanently
 * pinned to its clamp:
 *   `applyAcceleration` takes world units/s² — the carrier's real acceleration. At 60 u/s²
 *   (a fast flick of the basket) the steady-state lean is ~6°.
 *   `impulse` takes a normalised kick where 1.0 is a firm catch. Games scale their impact
 *   speed into that range rather than passing raw u/s.
 */
const SW_ACCEL_GAIN = 0.4;
const SW_IMPULSE_GAIN = 0.6;
const SW_TILT_GAIN = 1.35;
const SW_SQUASH_GAIN = 2.2;
const SW_SQUASH_LIMIT = 0.22;
/** How much a sideways lean also flattens the body. Small — it must not cancel a catch. */
const SW_LATERAL_SQUASH = 0.25;

/**
 * Two horizontal degrees of freedom of damped, driven oscillation — the basket's body
 * lagging behind its handle — plus a vertical channel that turns the same lag into a
 * volume-preserving squash. Reused `Spring` from anim.ts so the whole product shares one
 * integrator, and so the reduced-motion path (Spring damps to target with no overshoot and
 * discards velocity) makes the wobble go quiet for free.
 *
 * `apply()` owns the object's rotation and scale. Do not animate those elsewhere on the same
 * node — give the wobble its own child group if you need to.
 */
export class SoftWobble {
  private sx: Spring;
  private sz: Spring;
  private sy: Spring;

  private ax = 0;
  private ay = 0;
  private az = 0;

  private maxTilt: number;

  /** Authored scale of the target, captured on first `apply` so we multiply rather than overwrite. */
  private baseX = 1;
  private baseY = 1;
  private baseZ = 1;
  private captured = false;

  private readonly squash = { x: 1, y: 1, z: 1 };

  constructor(opts?: { stiffness?: number; damping?: number; maxTilt?: number }) {
    const k = opts?.stiffness ?? 300;
    const d = opts?.damping ?? 17;
    this.sx = new Spring(0, k, d);
    this.sz = new Spring(0, k, d);
    // The vertical channel is stiffer: a squash should snap back faster than a lean.
    this.sy = new Spring(0, k * 1.35, d * 1.15);
    this.maxTilt = opts?.maxTilt ?? 0.14;
  }

  /** Feed the carrier's current acceleration (world units/s²) every frame. */
  applyAcceleration(ax: number, ay: number, az: number): void {
    this.ax = ax;
    this.ay = ay;
    this.az = az;
  }

  /** A discrete kick — a catch landing, a rim strike. */
  impulse(x: number, y: number, z: number): void {
    this.sx.impulse(-x * SW_IMPULSE_GAIN);
    this.sy.impulse(-y * SW_IMPULSE_GAIN);
    this.sz.impulse(-z * SW_IMPULSE_GAIN);
  }

  update(dt: number): void {
    const h = safeDelta(dt);
    // The body lags the carrier, so the forcing term opposes acceleration.
    this.sx.impulse(-this.ax * SW_ACCEL_GAIN * h);
    this.sy.impulse(-this.ay * SW_ACCEL_GAIN * h);
    this.sz.impulse(-this.az * SW_ACCEL_GAIN * h);
    this.sx.step(h);
    this.sy.step(h);
    this.sz.step(h);
  }

  apply(obj: Object3D): void {
    if (!this.captured) {
      this.baseX = obj.scale.x;
      this.baseY = obj.scale.y;
      this.baseZ = obj.scale.z;
      this.captured = true;
    }

    const gain = isReduced() ? 0.25 : 1;
    const limit = this.maxTilt;
    const dx = this.sx.value * SW_TILT_GAIN * gain;
    const dz = this.sz.value * SW_TILT_GAIN * gain;

    // Rotation about +Z carries +Y towards -X, so a top leaning towards +x is -Z.
    obj.rotation.z = dx > limit ? -limit : dx < -limit ? limit : -dx;
    obj.rotation.x = dz > limit ? limit : dz < -limit ? -limit : dz;

    // Horizontal lag squashes a little too — a jelly leaning is also a jelly flattening.
    const lateral = Math.sqrt(this.sx.value * this.sx.value + this.sz.value * this.sz.value);
    let amount = (this.sy.value - lateral * SW_LATERAL_SQUASH) * SW_SQUASH_GAIN * gain;
    if (amount > SW_SQUASH_LIMIT) amount = SW_SQUASH_LIMIT;
    else if (amount < -SW_SQUASH_LIMIT) amount = -SW_SQUASH_LIMIT;

    squashFor(this.squash, amount, 1, SW_SQUASH_LIMIT);
    obj.scale.set(this.baseX * this.squash.x, this.baseY * this.squash.y, this.baseZ * this.squash.z);
  }

  reset(): void {
    this.sx.set(0);
    this.sy.set(0);
    this.sz.set(0);
    this.ax = 0;
    this.ay = 0;
    this.az = 0;
    this.captured = false;
  }
}
