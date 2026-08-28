/**
 * Foundation smoke scene — `?probe=1`.
 *
 * The nine game agents inherit a foundation whose most dangerous failure modes are silent:
 * `materials.ts` patches three's physical shader by string surgery, and a patch that
 * produces invalid GLSL shows up as a black prop and a console warning nobody reads, not
 * as an exception. `geometry.ts` welds and re-projects UVs, and a broken weld shows up as
 * a crease. Neither is caught by `tsc`, by the build, or by "the canvas exists".
 *
 * So this scene exercises every foundation module on a real GPU in one frame: a prop for
 * each geometry builder, a material from each factory, the studio PMREM, the shadow rig,
 * the camera rig, in-world text, a keyboard-reachable hit target, live physics with soft
 * wobble, and the celebration. If it renders, the foundation renders.
 *
 * It is dev-only and lazily imported from `App.tsx`, so none of it reaches a production
 * bundle unless someone puts `?probe=1` in the URL.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { advance, useFrame, useThree } from "@react-three/fiber";
import {
  DoubleSide,
  MeshBasicMaterial,
  PlaneGeometry,
  Shape,
  Vector3,
  type BufferGeometry,
  type Group,
  type Mesh,
} from "three";

import { Rig, ContactBlob } from "../three/Rig";
import { Scene3D } from "../three/Scene3D";
import { Celebration } from "../three/celebrate";
import { HitTarget, announce } from "../three/hit";
import { DisposalBag } from "../three/dispose";
import { PhysicsWorld, SoftWobble, type Body } from "../three/physics";
import { ensureManrope, textTexture } from "../three/text";
import { getQuality } from "../three/quality";
import { ACCENTS, CLAY } from "../three/tokens";
import {
  beveledExtrude,
  clayTray,
  latheProfile,
  roundedBox,
  roundedCylinder,
  roundedPlate,
  softCapsule,
  softSphere,
  toothGeometry,
  torusSoft,
} from "../three/geometry";
import {
  clayAccent,
  clayEnamel,
  clayGum,
  clayIvory,
  clayPainted,
  clayRubber,
  softGlass,
} from "../three/materials";

/* ------------------------------------------------------------------ */
/* Static scene description                                            */
/* ------------------------------------------------------------------ */

const TRAY = { w: 7.4, d: 4.2, h: 0.55, rim: 0.34 } as const;
/** Top of the tray's inner well — everything on the tray sits on this plane. */
const FLOOR_Y = 0.16;

/** A rounded pentagon for `beveledExtrude`, built once at module load. */
const badgeShape = (() => {
  const s = new Shape();
  const r = 0.44;
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 - Math.PI / 2;
    const x = Math.cos(a) * r;
    const y = Math.sin(a) * r;
    if (i === 0) s.moveTo(x, y);
    else s.lineTo(x, y);
  }
  s.closePath();
  return s;
})();

/** Lathe profile for a little glass beaker: [radius, height] pairs, bottom to top. */
const BEAKER_PROFILE: [number, number][] = [
  [0, 0],
  [0.3, 0],
  [0.32, 0.08],
  [0.3, 0.5],
  [0.34, 0.62],
  [0.31, 0.66],
];

/* ------------------------------------------------------------------ */
/* Props row                                                           */
/* ------------------------------------------------------------------ */

/**
 * One entry per geometry builder crossed with one material factory, so a single glance at
 * the render tells you which pair is broken. Built inside a `useMemo` rather than at module
 * scope because every builder reads the quality tier, which is only settled after the
 * device probe has run.
 */
type Prop = {
  key: string;
  geometry: BufferGeometry;
  material: ReturnType<typeof clayIvory>;
  x: number;
  y: number;
  blob: number;
};

function buildProps(): Prop[] {
  const row: Prop[] = [];
  const at = (i: number) => -2.9 + i * 0.95;

  row.push({
    key: "roundedBox/clayIvory",
    geometry: roundedBox(0.78, 0.62, 0.7, 0.16),
    material: clayIvory(),
    x: at(0),
    y: FLOOR_Y + 0.31,
    blob: 0.5,
  });
  row.push({
    key: "toothGeometry/clayEnamel",
    geometry: toothGeometry("baby"),
    material: clayEnamel(),
    x: at(1),
    y: FLOOR_Y,
    blob: 0.42,
  });
  row.push({
    key: "softSphere/clayGum",
    geometry: softSphere(0.34),
    material: clayGum("main"),
    x: at(2),
    y: FLOOR_Y + 0.34,
    blob: 0.44,
  });
  row.push({
    key: "torusSoft/clayAccent(peach)",
    geometry: torusSoft(0.3, 0.13),
    material: clayAccent("peach", "main"),
    x: at(3),
    y: FLOOR_Y + 0.13,
    blob: 0.46,
  });
  row.push({
    key: "roundedCylinder/clayPainted",
    geometry: roundedCylinder(0.3, 0.56, 0.09),
    material: clayPainted(ACCENTS.mauve.main),
    x: at(4),
    y: FLOOR_Y + 0.28,
    blob: 0.42,
  });
  row.push({
    key: "softCapsule/clayRubber",
    geometry: softCapsule(0.19, 0.42),
    material: clayRubber(ACCENTS.rose.deep),
    x: at(5),
    y: FLOOR_Y + 0.4,
    blob: 0.34,
  });
  row.push({
    key: "latheProfile/softGlass",
    geometry: latheProfile(BEAKER_PROFILE),
    material: softGlass(),
    x: at(6),
    y: FLOOR_Y,
    blob: 0.4,
  });
  row.push({
    key: "beveledExtrude/clayAccent(red)",
    geometry: beveledExtrude(badgeShape, { depth: 0.2, bevel: 0.05 }),
    material: clayAccent("red", "main"),
    x: at(7),
    y: FLOOR_Y + 0.1,
    blob: 0.44,
  });

  return row;
}

/* ------------------------------------------------------------------ */
/* Per-frame scratch — nothing below this line may allocate            */
/* ------------------------------------------------------------------ */

const _spawn = new Vector3();
const _vel = new Vector3();

/** Where the falling chips are released, above the right half of the tray. */
const DROP_X = 2.1;
const DROP_Y = 2.6;
const DROP_COUNT = 6;

/* ------------------------------------------------------------------ */
/* Scene                                                               */
/* ------------------------------------------------------------------ */

function ProbeScene({ onCelebrate }: { onCelebrate: () => void }) {
  const props = useMemo(buildProps, []);
  const trayGeo = useMemo(() => clayTray(TRAY.w, TRAY.d, TRAY.h, TRAY.rim), []);
  const trayMat = useMemo(() => clayPainted(CLAY.ivoryDeep, { roughness: 0.78 }), []);

  // One chip geometry + one material shared by every falling body: six draw calls of the
  // same program, which is what a real game would do before it reached for instancing.
  const chipGeo = useMemo(() => roundedPlate(0.34, 0.34, 0.16, 0.07), []);
  const chipMat = useMemo(() => clayAccent("coral", "main"), []);

  const trayRef = useRef<Group>(null);
  const chipRefs = useRef<(Mesh | null)[]>([]);
  if (chipRefs.current.length !== DROP_COUNT) chipRefs.current = new Array(DROP_COUNT).fill(null);

  /**
   * The engine object: created once, never re-created, never in React state. This is the
   * shape §5 of the spec asks every game to use.
   */
  const engine = useMemo(() => {
    const world = new PhysicsWorld({ gravity: 22 });
    // The tray's inner well floor, plus four rim walls so chips bounce off the edge rather
    // than sliding off into the void.
    world.addPlane(FLOOR_Y, 0.34, "tray-floor");
    const hw = TRAY.w * 0.5;
    const hd = TRAY.d * 0.5;
    world.addBox(new Vector3(hw, FLOOR_Y + 0.3, 0), new Vector3(0.2, 0.3, hd), 0.5, "rim");
    world.addBox(new Vector3(-hw, FLOOR_Y + 0.3, 0), new Vector3(0.2, 0.3, hd), 0.5, "rim");
    world.addBox(new Vector3(0, FLOOR_Y + 0.3, hd), new Vector3(hw, 0.3, 0.2), 0.5, "rim");
    world.addBox(new Vector3(0, FLOOR_Y + 0.3, -hd), new Vector3(hw, 0.3, 0.2), 0.5, "rim");

    const bodies: Body[] = [];
    for (let i = 0; i < DROP_COUNT; i++) {
      _spawn.set(DROP_X + (i % 3) * 0.42 - 0.42, DROP_Y + i * 0.5, -0.6 + (i % 2) * 0.7);
      _vel.set(0, 0, 0);
      bodies.push(
        world.addBody({
          position: _spawn,
          velocity: _vel,
          radius: 0.19,
          restitution: 0.34,
          friction: 0.6,
          kind: "chip",
        })
      );
    }

    const wobble = new SoftWobble({ maxTilt: 0.09 });
    // A catch is what a landing feels like from the tray's point of view.
    world.onCollision((_body, kind, speed) => {
      if (kind === "tray-floor") wobble.impulse(0, -Math.min(1, speed / 14), 0);
    });

    return {
      world,
      bodies,
      wobble,
      frames: 0,
      lastDt: 0,
      /** Renderer + scene handles, published below for console inspection. */
      gl: null as unknown,
      scene: null as unknown,
      advance: null as unknown,
    };
  }, []);

  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);

  /**
   * A live handle for the browser console: the renderer, the scene, and the solver, so the
   * foundation can be interrogated from a real page instead of asserted. Deliberately
   * captured from `useThree` rather than from the first `useFrame` — a hidden tab throttles
   * rAF to nothing, and a debug handle that only exists once the tab is visible is useless
   * exactly when you need it.
   */
  useEffect(() => {
    engine.gl = gl;
    engine.scene = scene;
    // `advance` drives one full R3F frame — every subscriber, then the view render — without
    // waiting for rAF. A hidden or throttled tab (headless drivers, CI, a background pane)
    // gets no rAF at all, so this is the only way to verify the loop end to end there.
    engine.advance = advance;
    (window as unknown as { __probe?: unknown }).__probe = engine;
  }, [engine, gl, scene]);

  useEffect(() => {
    const bag = new DisposalBag();
    bag.onRelease(() => engine.world.clear());
    return () => bag.release();
  }, [engine]);

  useFrame((_state, dt) => {
    engine.frames++;
    engine.lastDt = dt;
    engine.world.step(dt);

    const bodies = engine.bodies;
    const meshes = chipRefs.current;
    for (let i = 0; i < bodies.length; i++) {
      const m = meshes[i];
      if (!m) continue;
      const b = bodies[i];
      m.position.copy(b.position);
      m.quaternion.copy(b.quaternion);
    }

    const tray = trayRef.current;
    if (tray) {
      engine.wobble.update(dt);
      engine.wobble.apply(tray);
    }
  });

  return (
    <Rig shadowArea={11} groundY={-0.02}>
      <group ref={trayRef}>
        <mesh geometry={trayGeo} material={trayMat} castShadow receiveShadow />
      </group>

      {props.map((p) => (
        <group key={p.key} position-x={p.x} position-z={-0.75}>
          <mesh geometry={p.geometry} material={p.material} position-y={p.y} castShadow receiveShadow />
          <ContactBlob position={[0, FLOOR_Y + 0.006, 0]} radius={p.blob} opacity={0.4} />
        </group>
      ))}

      {engine.bodies.map((_b, i) => (
        <mesh
          key={i}
          ref={(m) => {
            chipRefs.current[i] = m;
          }}
          geometry={chipGeo}
          material={chipMat}
          castShadow
        />
      ))}

      <ProbeLabel />

      {/* Keyboard-reachable, 48px-minimum in screen space, and it fires the celebration. */}
      <HitTarget
        ariaLabel="Run the celebration"
        position={[-2.9, FLOOR_Y + 0.35, 1.3]}
        radius={0.42}
        group="probe"
        focusOrder={0}
        onSelect={onCelebrate}
      >
        <mesh geometry={props[1].geometry} material={props[1].material} castShadow />
        <ContactBlob position={[0, -0.34, 0]} radius={0.42} opacity={0.4} />
      </HitTarget>
    </Rig>
  );
}

/* ------------------------------------------------------------------ */
/* In-world label                                                      */
/* ------------------------------------------------------------------ */

const LABEL_QUAD = new PlaneGeometry(1, 1);

/**
 * `text.ts` renders on a canvas the moment Manrope is usable, so the label mounts as a
 * one-shot state flip rather than a per-frame poll — a discrete event, per §4.
 */
function ProbeLabel() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let live = true;
    void ensureManrope().then(() => {
      if (live) setReady(true);
    });
    return () => {
      live = false;
    };
  }, []);

  const label = useMemo(() => {
    if (!ready) return null;
    const t = textTexture(`foundation · ${getQuality().tier}`, {
      fontSize: 44,
      weight: 700,
      color: ACCENTS.mauve.deep,
    });
    // A caption, not a clay prop: unlit on purpose so it reads at any angle. The texture is
    // owned by `text.ts`'s cache; only this material belongs to us.
    const material = new MeshBasicMaterial({ map: t.texture, transparent: true, side: DoubleSide });
    return { material, aspect: t.aspect };
  }, [ready]);

  useEffect(() => {
    if (!label) return;
    return () => label.material.dispose();
  }, [label]);

  if (!label) return null;
  const h = 0.34;
  return (
    <mesh
      geometry={LABEL_QUAD}
      material={label.material}
      position={[0, 0.004, 3.1]}
      rotation={[-Math.PI / 2, 0, 0]}
      scale={[h * label.aspect, h, 1]}
      renderOrder={3}
    />
  );
}

/* ------------------------------------------------------------------ */
/* Host                                                                */
/* ------------------------------------------------------------------ */

/**
 * Same layer the hub's DOM sits on. The rect is what `<View>` tracks; the pixels still come
 * from the one canvas at z-index 0 underneath.
 */
const HOST_STYLE: React.CSSProperties = { position: "fixed", inset: 0, zIndex: 10 };

const PROBE_CAMERA = { position: [0, 4.6, 12.4] as [number, number, number], fov: 28 };

/**
 * Default export so `App.tsx` can `React.lazy` it. Owns its own DOM rect instead of going
 * through `GameShell`, because the probe has to work on the welcome screen too.
 */
export default function Probe() {
  const host = useRef<HTMLDivElement>(null);
  const [celebrating, setCelebrating] = useState(false);

  const [handlers] = useState(() => ({
    start: () => {
      setCelebrating(true);
      announce("Celebration running");
    },
    done: () => setCelebrating(false),
  }));

  return (
    <div ref={host} style={HOST_STYLE}>
      <Scene3D track={host} camera={PROBE_CAMERA}>
        <ProbeScene onCelebrate={handlers.start} />
        <group position={[2.6, FLOOR_Y, 1.2]}>
          <Celebration active={celebrating} accent="coral" onDone={handlers.done} />
        </group>
      </Scene3D>
    </div>
  );
}
