/**
 * The hub's 3D layer: nine clay slabs standing exactly where the DOM cards are.
 *
 * One `<Scene3D>` spans the whole card grid. The slabs, the accent inlays and the focus
 * halos are three `InstancedMesh`es — nine cards, three draw calls — and the nine props add
 * one small mesh group each. Every transform is composed from the engine's springs inside a
 * single `useFrame` with module-level scratch objects, so the hub renders at 60fps and
 * causes exactly zero React work while a child moves their finger across it.
 *
 * The camera looks straight down -Z, which is what makes the DOM/3D registration exact
 * rather than approximate: at that angle world units and CSS pixels differ by one scalar,
 * so a measured DOM rect converts to a slab position with no perspective correction. The
 * slabs are then leaned back a few degrees on their own axis, which is where the depth
 * comes from — the key light rakes across the top bevel and each slab drops a real shadow
 * onto the backdrop behind it.
 *
 * This component is deliberately not lazy: it is the first thing a child sees, so its
 * geometry is a handful of cached builders and its materials are the shared clay factories.
 */
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import {
  Euler,
  Matrix4,
  PlaneGeometry,
  Quaternion,
  Vector3,
  type Group,
  type InstancedMesh,
  type Mesh,
} from "three";

import { safeDelta, squashFor } from "../three/anim";
import { cachedGeometry, roundedPlate } from "../three/geometry";
import {
  clay,
  clayGround,
  clayIvory,
  ensureInstanceAlbedo,
  writeAlbedo,
} from "../three/materials";
import { Rig } from "../three/Rig";
import { quality } from "../three/quality";
import { useStore } from "../three/store";
import { ACCENTS, CLAY, color, type AccentFamily } from "../three/tokens";
import { SLAB, type HubEngine } from "./engine";
import { HUB_DETAIL_MAX, HubProp } from "./props";

/* ------------------------------------------------------------------ */
/* Per-frame scratch — this file allocates nothing inside useFrame      */
/* ------------------------------------------------------------------ */

const _pos = new Vector3();
const _scale = new Vector3();
const _mat = new Matrix4();
const _squash = { x: 1, y: 1, z: 1 };

/**
 * The slabs' constant lean, built once and shared by every instance. Leaning shortens the
 * projected height by cos(tilt), so the scale is pre-multiplied to put it back and keep the
 * slab registered with its DOM cell to within a rounding error.
 */
const TILT_QUAT = new Quaternion().setFromEuler(new Euler(SLAB.tilt, 0, 0));
const TILT_FIT = 1 / Math.cos(SLAB.tilt);

/* ------------------------------------------------------------------ */
/* Shared resources                                                    */
/* ------------------------------------------------------------------ */

/**
 * The backdrop quad — a cyclorama, not a wall.
 *
 * One unit quad, cached and marked shared so nothing has to dispose it, with **every normal
 * rewritten to `+Y`**. That is the whole fix for a defect the audit measured twice: the hub's
 * backdrop rendered `#e8d8c1`, **dE2000 6.2** from `NEUTRAL.page`, so the 3D region read as a
 * visible rectangle pasted onto the page — while the identical material on a game's floor
 * renders `#ece6da`, dE 0.5.
 *
 * The cause is not the colour, it is the orientation. `clayGround`'s albedo is not the page
 * cream: it is the page cream divided by a *measured* render of an **up-facing** plane under
 * this studio (`materials.ts::GROUND_WHITE_BALANCE`), because a warm key on warm cream
 * multiplies. That calibration is only valid for a `+Y` normal, and this plane faces the
 * camera. Two things change with it:
 *
 *  - the key arrives at `N·L = 0.53` instead of `0.74`, so the direct term loses ~19%;
 *  - and, decisively, the hemisphere it integrates the environment over is the *front* one.
 *    The studio is warm everywhere except one cool rim strip, and that strip sits **behind**
 *    the subject (`STUDIO.rim.position.z = -3.4`) precisely so it can act as the white-balance
 *    control. A camera-facing plane sees the warm bounce card and none of the rim, which is
 *    the exact failure mode `STUDIO.skyTop`'s own note records: an all-warm studio rendered
 *    the page cream as `#E9D9C1`. The measured backdrop was `#e8d8c1` — one code value off.
 *
 * Compensating with a second white-balance vector would mean a second calibration to
 * re-measure whenever the studio moves. Shading the plane as what it *is* needs none: the hub
 * camera looks straight down `-Z`, so the surface the slabs stand on and the surface behind
 * them are the same table, and a stage cyclorama sweeps floor into backdrop with exactly this
 * continuity. With a `+Y` shading normal the plane takes the calibrated ground's irradiance,
 * its direct term and its rendered colour, by construction rather than by another
 * measurement. Shadow lookups are position-based and unaffected; `shadowNormalBias` displaces
 * by 0.006 units, which is nothing at this scale.
 */
const backdropGeometry = () =>
  cachedGeometry("hub/backdrop-cyclorama", () => {
    const geo = new PlaneGeometry(1, 1);
    const normals = geo.getAttribute("normal");
    for (let i = 0; i < normals.count; i++) normals.setXYZ(i, 0, 1, 0);
    normals.needsUpdate = true;
    return geo;
  });

/**
 * The inlay and halo materials are near-white clay bodies tinted per instance, so all nine
 * accent families cost one material each instead of ten.
 */
const inlayMaterial = () =>
  clay("hub/inlay", {
    color: CLAY.enamel,
    roughness: 0.7,
    wrap: 0.4,
    sss: CLAY.sss,
    sssStrength: 0.42,
    sheen: 0.3,
    grain: 0.13,
  });

const haloMaterial = () =>
  clay("hub/halo", {
    color: CLAY.enamel,
    roughness: 0.62,
    wrap: 0.36,
    sss: CLAY.sss,
    sssStrength: 0.36,
    sheen: 0.36,
    grain: 0.1,
  });

export type HubSceneCard = { id: string; accent: AccentFamily };

/* ------------------------------------------------------------------ */
/* Scene                                                               */
/* ------------------------------------------------------------------ */

export function HubScene({
  engine,
  cards,
  aspect,
  shadowArea,
}: {
  engine: HubEngine;
  cards: readonly HubSceneCard[];
  aspect: number;
  shadowArea: number;
}): JSX.Element {
  const count = cards.length;
  // Subscribed rather than sampled, so a runtime tier degrade actually rebuilds the plates —
  // and capped at `HUB_DETAIL_MAX`, because these twenty-seven plates were 86,148 of the
  // 188,558 triangles that put the hub over the §9 budget, and they are 88-px DOM slots.
  // See the note on that constant: it is a ceiling, so the low tier still drops to 1.
  const detail = Math.min(useStore(quality).detail, HUB_DETAIL_MAX);

  const slabRef = useRef<InstancedMesh>(null);
  const inlayRef = useRef<InstancedMesh>(null);
  const haloRef = useRef<InstancedMesh>(null);
  const backdropRef = useRef<Mesh>(null);
  const propRefs = useRef<(Group | null)[]>([]);
  if (propRefs.current.length !== count) propRefs.current = new Array(count).fill(null);

  /* ---------------- geometry ---------------- */

  // Built from the *measured* card aspect, so the bevel radius is genuinely circular on
  // every corner instead of the ellipse a non-uniform scale would produce.
  const slabGeo = useMemo(
    () => roundedPlate(aspect, 1, SLAB.thickness, SLAB.corner, detail),
    [aspect, detail]
  );
  // Cloned, not shared. `roundedPlate` returns a `cachedGeometry`, which lives for the life
  // of the WebGL context and is handed to every caller asking for the same size — and this
  // mesh hangs a per-instance `aAlbedo` attribute off its geometry. Attaching an
  // `InstancedBufferAttribute` to the shared plate would leak the hub's nine accent colours
  // into every other consumer of a same-size plate.
  const haloGeo = useMemo(
    () =>
      roundedPlate(
        aspect + SLAB.ringPad * 2,
        1 + SLAB.ringPad * 2,
        SLAB.ringThickness,
        SLAB.corner + SLAB.ringPad,
        detail
      ).clone(),
    [aspect, detail]
  );
  useEffect(() => {
    const geo = haloGeo;
    return () => geo.dispose();
  }, [haloGeo]);
  // The inlay is a unit square scaled to whatever the DOM reserved, so it never needs
  // rebuilding when the grid reflows.
  // Cloned for the same reason as `haloGeo` above.
  const inlayGeo = useMemo(
    () => roundedPlate(1, 1, SLAB.tileThickness, SLAB.tileCorner, detail).clone(),
    [detail]
  );
  useEffect(() => {
    const geo = inlayGeo;
    return () => geo.dispose();
  }, [inlayGeo]);

  /* ---------------- per-instance colour ---------------- */

  // Written to `aAlbedo`, **never** to `setColorAt`.
  //
  // three folds `instanceColor` into the same `vColor` the clay shader reads as a signed
  // curvature map centred on 1.0, and extrapolates by `uClayAO = 1.45`. A token written
  // there is an albedo (always <= 1), so it came out driven *down* from neutral and every
  // channel under ~0.31 linear clamped to black: `peach.main` rendered (227,74,9), and the
  // nine card icon plates — the first surface a child sees — were all off-token. See
  // `materials.ts::ALBEDO_ATTRIBUTE`.
  //
  // `haloGeo` and `inlayGeo` are deps because a geometry change rebuilds the whole
  // InstancedMesh through r3f's `args`, and the albedo buffer hangs off the geometry.
  useLayoutEffect(() => {
    const inlay = ensureInstanceAlbedo(inlayGeo, count);
    const halo = ensureInstanceAlbedo(haloGeo, count);
    for (let i = 0; i < count; i++) {
      const family = cards[i].accent;
      writeAlbedo(inlay, i, color(ACCENTS[family].soft));
      writeAlbedo(halo, i, color(ACCENTS[family].deep));
    }
    inlay.needsUpdate = true;
    halo.needsUpdate = true;
  }, [cards, count, haloGeo, inlayGeo]);

  /* ---------------- per-frame ---------------- */

  const lastLayout = useRef(-1);

  useFrame((_state, rawDt) => {
    const slabs = slabRef.current;
    const inlays = inlayRef.current;
    const halos = haloRef.current;
    if (!slabs || !inlays || !halos) return;

    engine.step(safeDelta(rawDt));

    const unit = engine.unit;
    if (unit <= 0) return;

    // The backdrop only moves when the grid does — a layout event, never a frame event.
    if (engine.layout !== lastLayout.current) {
      lastLayout.current = engine.layout;
      const back = backdropRef.current;
      if (back) {
        back.scale.set(engine.viewW * 1.6, engine.viewH * 1.6, 1);
        back.position.z = -SLAB.panelGap * unit;
      }
    }

    const halfT = SLAB.thickness * 0.5;
    // Guard rather than assume: writing past an InstancedMesh's capacity throws, and the
    // engine's card count and the scene's instance count come from two different places.
    const n = Math.min(engine.cards.length, slabs.count, propRefs.current.length);

    for (let i = 0; i < n; i++) {
      const card = engine.cards[i];
      const cz = engine.centreZ(i);
      const s = engine.scaleOf(i) * unit * TILT_FIT;

      /* Slab ------------------------------------------------------- */
      _pos.set(card.x, card.y, cz);
      _scale.setScalar(s);
      _mat.compose(_pos, TILT_QUAT, _scale);
      slabs.setMatrixAt(i, _mat);

      /* Focus halo — sits just behind the slab and grows out from under it */
      const ring = card.ring.value;
      const haloScale = ring < 0.004 ? 0 : s * (0.93 + 0.07 * ring);
      _pos.set(card.x, card.y, cz - (halfT + SLAB.ringThickness * 0.5 + 0.012) * unit);
      _scale.setScalar(haloScale);
      _mat.compose(_pos, TILT_QUAT, _scale);
      halos.setMatrixAt(i, _mat);

      /* Accent inlay — lies on the slab's front face, where the DOM reserved room */
      const tileSize = card.tsize;
      _pos
        .set(card.tx, card.ty, halfT + tileSize * SLAB.tileThickness * 0.5)
        .multiplyScalar(s)
        .applyQuaternion(TILT_QUAT);
      _pos.x += card.x;
      _pos.y += card.y;
      _pos.z += cz;
      _scale.setScalar(tileSize * s);
      _mat.compose(_pos, TILT_QUAT, _scale);
      inlays.setMatrixAt(i, _mat);

      /* Prop — stands on the inlay and squashes when the slab is pressed */
      const prop = propRefs.current[i];
      if (prop) {
        _pos
          .set(
            card.tx,
            card.ty,
            halfT + tileSize * (SLAB.tileThickness + SLAB.propFill * 0.34)
          )
          .multiplyScalar(s)
          .applyQuaternion(TILT_QUAT);
        prop.position.set(_pos.x + card.x, _pos.y + card.y, _pos.z + cz);
        prop.quaternion.copy(TILT_QUAT);
        squashFor(_squash, engine.squashOf(i), tileSize * s * SLAB.propFill, 0.22);
        prop.scale.set(_squash.x, _squash.y, _squash.z);
      }
    }

    slabs.instanceMatrix.needsUpdate = true;
    inlays.instanceMatrix.needsUpdate = true;
    halos.instanceMatrix.needsUpdate = true;
  });

  /* ---------------- graph ---------------- */

  return (
    <Rig ground={false} shadowArea={shadowArea} groundY={0}>
      <mesh
        ref={backdropRef}
        geometry={backdropGeometry()}
        material={clayGround()}
        receiveShadow
      />

      <instancedMesh
        ref={haloRef}
        args={[haloGeo, haloMaterial(), count]}
        frustumCulled={false}
      />
      <instancedMesh
        ref={slabRef}
        args={[slabGeo, clayIvory(), count]}
        frustumCulled={false}
        castShadow
        receiveShadow
      />
      <instancedMesh
        ref={inlayRef}
        args={[inlayGeo, inlayMaterial(), count]}
        frustumCulled={false}
        castShadow
      />

      {cards.map((card, i) => (
        <group
          key={card.id}
          // Zero until the first frame writes a measured transform, so nine unit-sized props
          // can never flash stacked on the origin before the DOM has been read.
          scale={0}
          ref={(node) => {
            propRefs.current[i] = node;
          }}
        >
          <HubProp id={card.id} />
        </group>
      ))}
    </Rig>
  );
}
