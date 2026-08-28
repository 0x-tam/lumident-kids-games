/**
 * CameraRig — the only thing allowed to write to a scene camera's transform.
 *
 * Three jobs, in order of how much they matter to a five-year-old:
 *
 *  1. **Framing moves.** Hub -> game is a spring move with a wind-up, not a cut (§5).
 *  2. **Breathing.** A miniature diorama shot on a long lens is never dead-still, but a
 *     child holding a tablet 30 cm from their face gets motion sick fast. §4 caps the
 *     breathe at 0.35 degrees and 0.06 units — here both caps are enforced *by
 *     construction* rather than by a clamp that someone can later tune past.
 *  3. **Shake.** Same problem, worse: this fires on impacts, so it must be impossible for
 *     it to swing the horizon. It is implemented as a pure translation of camera *and*
 *     aim point together, which means its angular velocity is mathematically zero.
 *
 * `update()` allocates nothing: every intermediate is a local number, `Spring` integrates
 * in place, and `Object3D.lookAt` reuses three's own module temps.
 */
import type { PerspectiveCamera } from "three";
import { Spring3, safeDelta } from "./anim";
import { isReduced } from "./store";

const DEG = Math.PI / 180;

/** §4 breathe caps. */
const BREATHE_UNITS = 0.06;
const BREATHE_RADIANS = 0.35 * DEG;
/** Split across three axes so the *vector* magnitude, not each component, obeys the cap. */
const BREATHE_COMPONENT = BREATHE_UNITS / Math.sqrt(3);
/**
 * Two axes of angular breathe combine, so each gets 0.7 of the budget:
 * sqrt(0.7^2 + 0.7^2) = 0.99 of the cap in the worst case.
 */
const BREATHE_ANGULAR_SHARE = 0.7;

/** Absolute ceiling on shake travel. A caller may ask for less, never for more. */
const SHAKE_CEILING = 0.08;
const SHAKE_DEFAULT_MAX = 0.05;
/** e-fold in ~62 ms; effectively silent by 300 ms. */
const SHAKE_DECAY = 16;

/**
 * ~0.85 critical damping: arrives in roughly 450 ms with a whisper of overshoot, which is
 * the §5 transition feel. Slower and softer than the object springs in `FEEL` on purpose —
 * a camera that snaps like a button press reads as a glitch.
 */
const FOCUS_STIFFNESS = 120;
const FOCUS_DAMPING = 19;

/** Fraction of the move distance fired backwards as the wind-up (§4). */
const WINDUP = 0.55;

/**
 * Two detuned sines, |result| <= 1 by construction. Deterministic on `elapsed`, so the
 * breathe is identical on every device and never calls Math.random in the frame path.
 */
const wave = (t: number, a: number, b: number, phase: number) =>
  0.6 * Math.sin(t * a + phase) + 0.4 * Math.sin(t * b + phase * 1.7);

export class CameraRig {
  private camera: PerspectiveCamera | null;
  private readonly pos: Spring3;
  private readonly aim: Spring3;
  private readonly breathe: boolean;
  private readonly maxShake: number;

  /** Current shake amplitude in world units. Decays, never grows past `maxShake`. */
  private shakeAmp = 0;

  /** The resting frame. Reduced motion snaps here and stays. */
  private bpx = 0;
  private bpy = 0;
  private bpz = 0;
  private btx = 0;
  private bty = 0;
  private btz = 0;

  constructor(camera: PerspectiveCamera, opts?: { breathe?: boolean; maxShake?: number }) {
    this.camera = camera;
    this.breathe = opts?.breathe ?? true;
    this.maxShake = Math.min(Math.max(opts?.maxShake ?? SHAKE_DEFAULT_MAX, 0), SHAKE_CEILING);

    this.bpx = camera.position.x;
    this.bpy = camera.position.y;
    this.bpz = camera.position.z;
    this.pos = new Spring3(this.bpx, this.bpy, this.bpz, FOCUS_STIFFNESS, FOCUS_DAMPING);
    this.aim = new Spring3(0, 0, 0, FOCUS_STIFFNESS, FOCUS_DAMPING);
  }

  /**
   * Declares where the camera lives. `immediate` (and reduced motion) snaps; otherwise the
   * springs travel there. Use this for configuration; use `focus` for a dramatic move.
   */
  setBase(
    px: number,
    py: number,
    pz: number,
    tx: number,
    ty: number,
    tz: number,
    immediate = false
  ): void {
    this.bpx = px;
    this.bpy = py;
    this.bpz = pz;
    this.btx = tx;
    this.bty = ty;
    this.btz = tz;
    if (immediate || isReduced()) {
      this.pos.set(px, py, pz);
      this.aim.set(tx, ty, tz);
    } else {
      this.pos.to(px, py, pz);
      this.aim.to(tx, ty, tz);
    }
  }

  /**
   * A framing change the player is meant to notice — hub <-> game. Identical destination
   * handling to `setBase`, plus the §4 wind-up: a short kick against the direction of
   * travel before the spring pulls, so the move reads as authored rather than lerped.
   * Under reduced motion it snaps with no travel at all.
   */
  focus(px: number, py: number, pz: number, tx: number, ty: number, tz: number): void {
    if (isReduced()) {
      this.setBase(px, py, pz, tx, ty, tz, true);
      return;
    }
    this.pos.x.impulse(-(px - this.pos.x.value) * WINDUP);
    this.pos.y.impulse(-(py - this.pos.y.value) * WINDUP);
    this.pos.z.impulse(-(pz - this.pos.z.value) * WINDUP);
    this.aim.x.impulse(-(tx - this.aim.x.value) * WINDUP);
    this.aim.y.impulse(-(ty - this.aim.y.value) * WINDUP);
    this.aim.z.impulse(-(tz - this.aim.z.value) * WINDUP);
    this.setBase(px, py, pz, tx, ty, tz, false);
  }

  /**
   * `strength` is 0..1 of this rig's shake budget. Impacts add to whatever is still
   * ringing, saturating at `maxShake` — twenty candies landing at once cannot stack into
   * an earthquake. No-op under reduced motion.
   */
  shake(strength: number): void {
    if (isReduced()) return;
    const next = this.shakeAmp + Math.abs(strength) * this.maxShake;
    this.shakeAmp = next > this.maxShake ? this.maxShake : next;
  }

  /** Call once per frame from a `useFrame` at a priority below the view that renders. */
  update(dt: number, elapsed: number): void {
    const cam = this.camera;
    if (!cam) return;

    if (isReduced()) {
      // §4: completely static. Reduced motion gets the framing, never the movement.
      cam.position.set(this.bpx, this.bpy, this.bpz);
      cam.lookAt(this.btx, this.bty, this.btz);
      return;
    }

    const d = safeDelta(dt);
    this.pos.step(d);
    this.aim.step(d);

    let px = this.pos.x.value;
    let py = this.pos.y.value;
    let pz = this.pos.z.value;
    let tx = this.aim.x.value;
    let ty = this.aim.y.value;
    let tz = this.aim.z.value;

    if (this.breathe) {
      // Positional breathe moves the camera and the aim point by the same vector, so the
      // view direction is bit-for-bit unchanged and the only thing to cap is travel.
      const bx = BREATHE_COMPONENT * wave(elapsed, 0.91, 1.43, 0);
      const by = BREATHE_COMPONENT * wave(elapsed, 0.77, 1.21, 2.1);
      const bz = BREATHE_COMPONENT * wave(elapsed, 1.03, 1.57, 4.3);
      px += bx;
      tx += bx;
      py += by;
      ty += by;
      pz += bz;
      tz += bz;

      // Angular breathe slides the aim point along the camera's own right/up axes by
      // dist * tan(theta). Doing it in camera space rather than world space is what makes
      // the swing exactly theta whether the shot is a low hero angle or a top-down maze.
      let fx = tx - px;
      let fy = ty - py;
      let fz = tz - pz;
      const dist = Math.sqrt(fx * fx + fy * fy + fz * fz);
      if (dist > 1e-4) {
        fx /= dist;
        fy /= dist;
        fz /= dist;

        // right = forward x worldUp. Degenerate when looking straight down, so fall back
        // to world X — the top-down maze camera hits this every frame.
        let rx = -fz;
        let rz = fx;
        const rl = Math.sqrt(rx * rx + rz * rz);
        if (rl > 1e-4) {
          rx /= rl;
          rz /= rl;
        } else {
          rx = 1;
          rz = 0;
        }
        // up = right x forward, with right.y known to be 0.
        const ux = -rz * fy;
        const uy = rz * fx - rx * fz;
        const uz = rx * fy;

        const swing = dist * Math.tan(BREATHE_RADIANS) * BREATHE_ANGULAR_SHARE;
        const a1 = swing * wave(elapsed, 0.63, 1.09, 1.4);
        const a2 = swing * wave(elapsed, 0.87, 1.33, 3.2);
        tx += rx * a1 + ux * a2;
        ty += uy * a2;
        tz += rz * a1 + uz * a2;
      }
    }

    if (this.shakeAmp > 0) {
      this.shakeAmp *= Math.exp(-SHAKE_DECAY * d);
      if (this.shakeAmp < 1e-4) this.shakeAmp = 0;
      const s = this.shakeAmp;
      // Translation only, camera and aim together: angular velocity is exactly zero, so
      // the "hard clamp on angular velocity" is structural rather than a magic number.
      const sx = s * Math.sin(elapsed * 26.1);
      const sy = s * Math.sin(elapsed * 31.7 + 1.1);
      const sz = s * Math.sin(elapsed * 37.3 + 2.4);
      px += sx;
      tx += sx;
      py += sy;
      ty += sy;
      pz += sz;
      tz += sz;
    }

    cam.position.set(px, py, pz);
    cam.lookAt(tx, ty, tz);
  }

  /**
   * The rig owns no GPU resources — it only writes to a camera someone else owns. Dropping
   * the reference makes any stray `update()` from an in-flight frame a no-op instead of
   * resurrecting a camera the view has already torn down.
   */
  dispose(): void {
    this.camera = null;
    this.shakeAmp = 0;
  }
}
