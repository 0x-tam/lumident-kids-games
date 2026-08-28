/**
 * Sliding Puzzle — the 3D board.
 *
 * The shape of this file follows Tooth Match, which is the product's reference game:
 *
 *  • It takes ONE prop, the engine, and that prop never changes identity. Nothing about a
 *    tile's motion travels through React.
 *  • It subscribes to the engine once and mutates plain `TileAnim` structs from that
 *    callback. The component re-renders on exactly one engine event — `deal` — because
 *    that is the only one that changes how many tiles exist or what they show.
 *  • `useFrame` reads those structs, writes instance matrices and `Object3D.matrix`
 *    through module-level scratch, and allocates nothing.
 *
 * What is on screen:
 *
 *  • A `clayTray` with a real rim and an inner well, and a lattice of raised clay bars
 *    standing in the grooves — so every cell, the empty one included, is a *pressed-in
 *    well* rather than a hole. When the picture is finished the lattice sinks into the
 *    floor and the tiles pull together, closing every groove: the board becomes one slab.
 *  • Tile bodies and their printed face panels are two `InstancedMesh`es. The face carries
 *    that tile's patch of sky as a per-instance albedo (`materials.ts::ALBEDO_ATTRIBUTE` —
 *    *not* `setColorAt`, see the note in the deal effect), so a scrambled board scrambles the
 *    sky exactly the way it scrambles everything else. It is inset far enough that the tile
 *    body's own rim reads as a frame around the picture.
 *  • The picture itself is real extruded clay — one merged relief geometry per tile, cut
 *    from one continuous composition by `reliefMesh.ts`. A tile that happens to show only
 *    sky builds no geometry and costs no draw call.
 *  • The empty cell is a real socket pressed into the tray, with a rolled lip, sliding to
 *    wherever the gap is.
 *  • A reference plaque stands on a clay ledge behind the tray, centred over the board and
 *    carrying the same relief: the 3D replacement for the 2D game's thumbnail, and the only
 *    thing on screen that says what the child is building.
 *
 * Motion (3D-SPEC §4): a tile never slides flat. It presses *into* the tray for 55 ms,
 * lifts clear of the rim on `easeOutBack`, is thrown across on `anticipate` (which pulls it
 * back before it goes), banks into its direction of travel, then drops on `easeInCubic` —
 * gravity, not an ease-in-out — and lands with a squash spring and a clack. A tap on a tile
 * that cannot move gets a shrug: a hop and an underdamped tilt wobble, never an error.
 *
 * Reduced motion: no lift, no bank, no wobble, no overshoot and no idle. A tile crosses to
 * its new cell on `easeOutCubic` in 150 ms, a blocked tap answers with a 150 ms scale pop,
 * and the closing beat is two short cross-fades. `Scene3D`'s `CameraRig` is already static.
 */
import { createRef, memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useFrame } from "@react-three/fiber";
import {
  Color,
  DynamicDrawUsage,
  Euler,
  Matrix4,
  PlaneGeometry,
  Quaternion,
  Vector3,
  type BufferGeometry,
  type Group,
  type InstancedMesh,
  type Mesh,
} from "three";

import {
  FEEL,
  Spring,
  anticipate,
  clamp01,
  easeInCubic,
  easeOutBack,
  easeOutCubic,
  safeDelta,
  squashFor,
} from "../../three/anim";
import { cachedGeometry, clayTray, roundedBox, roundedPlate } from "../../three/geometry";
import { HitTarget, useFocusGroup } from "../../three/hit";
import {
  clay,
  clayIvory,
  clayPainted,
  ensureInstanceAlbedo,
  shadowBlobMaterial,
  writeAlbedo,
} from "../../three/materials";
import { ContactBlob, Rig, contactOpacityFor, contactRadiusFor } from "../../three/Rig";
import { BUDGETS } from "../../three/quality";
import { celebrationHeroScale, isReduced } from "../../three/store";
import { ACCENTS, CLAY } from "../../three/tokens";
import { sounds } from "../../shared/audio";
import type { SlidingPuzzleEngine } from "./engine";
import {
  BAR_H,
  BAR_W,
  BOARD,
  FACE_DY,
  FACE_PROUD,
  FACE_T,
  GRAIN_SCALE,
  MAX_BARS,
  MAX_TILES,
  LEDGE_D,
  LEDGE_H,
  LEDGE_POS,
  LEDGE_W,
  PLAQUE_CORNER,
  PLAQUE_POS,
  PLAQUE_T,
  PLAQUE_TILT,
  PLAQUE_W,
  PLATE_DETAIL,
  REST_Y,
  RISE,
  SHADOW_AREA,
  TILE_T,
  TRAY_H,
  TRAY_W,
  WALL,
  WELL_Y,
  cellSize,
  cellV,
  cellX,
  cellZ,
  convergeFactor,
  faceCorner,
  faceRim,
  faceSize,
  tileCorner,
  tileRim,
  tileSize,
} from "./layout";
import { SCENES, bgSample } from "./relief";
import { boardRelief, plaqueRelief } from "./reliefMesh";

/* ------------------------------------------------------------------ */
/* Tuning                                                              */
/* ------------------------------------------------------------------ */

const HOP_DUR = 0.34;
/** The wind-up: the tile presses into the tray before it leaves it. */
const DIP_END = 0.16;
const DIP = 0.035;
const LIFT_END = 0.5;
const HOLD_END = 0.74;
/** Horizontal travel window inside the hop — it settles just as the drop begins. */
const GLIDE_START = 0.08;
const GLIDE_SPAN = 0.7;
/** Kicked when the tile hits the tray floor. Peak squash ~0.25 of its thickness. */
const LAND_IMPULSE = -7;
const LIFT_STRETCH = 2.4;
const BANK = 0.17;

const NUDGE_TILT = 4.6;
const NUDGE_HOP = 1.8;

/** The closing beat, in seconds: the last piece drops, then the grooves close. */
const DROP_IN_END = 0.42;
const CLOSE_START = 0.4;
const CLOSE_END = 0.82;
const DROP_HEIGHT = 0.55;

/**
 * The shadow under a tile.
 *
 * Round 2 wrote this blob at the tile's own x/z and scaled it to `tileSize x (1.22 + 0.9 x
 * lift)`, so as the tile rose 3 cm the only dark thing under it got 74% *wider*, stayed dead
 * centred, and nothing moved toward the key at (-4, 7, 5). A shadow that grows and stays put
 * as an object rises is the single clearest "this has no weight" signal there is.
 *
 * Round 3 answered that by making it **translate** — the key's ground projection is exactly
 * `(4/7, -5/7)` per unit of height, which is kept below — and by making it *tighten and
 * darken* as the tile rose, so it would read as a cast shadow rather than a smear.
 *
 * **That second half is now deleted, and round 4's A3 is why.** The blob is a *contact*
 * term: it supplies the near-black pinch a 1024-texel shadow map cannot resolve where two
 * surfaces touch, and that pinch is an occlusion of proximity — it vanishes as they
 * separate. A blob that instead grows *denser* as the caster lifts is a decal sitting on top
 * of the real cast shadow, in exactly the place the real one is, and A3 measured what that
 * costs product-wide: round 4's penumbra measurement had to force all sixteen blobs
 * invisible before there was anything left to measure. Since A3 the PCSS filter compiles on
 * every tier and the shadow it draws has a real widening penumbra; a lifted tile's shadow is
 * that, not this.
 *
 * So both curves now come from `Rig.tsx`, which is where the shared contract puts them —
 * `contactRadiusFor` for the radius (a penumbra allowance taken from the key's angular size)
 * and `contactOpacityFor` for the density (1 at contact, 0 by `CONTACT_FADE_LIFT`). The
 * radius is unchanged in practice: the shared law resolves to **1.209 x tileSize** of quad at
 * rest against the hand-set `BLOB_BASE` of 1.2 it replaces, i.e. within 0.8 %.
 *
 * The translation stays. Inside the fade window it is only ~4 screen px, but it is the right
 * 4 px: the blob slides *toward* where the shadow map is already drawing as it hands over,
 * so the two agree rather than crossing.
 */
/** `KEY_LIGHT.position` is (-4, 7, 5); a point at height h shadows to (4h/7, -5h/7). */
const KEY_SHADOW_X = 4 / 7;
const KEY_SHADOW_Z = -5 / 7;
/** Below this the blob cannot move an 8-bit code; collapse the instance instead of drawing it. */
const BLOB_MIN_FADE = 0.02;

/**
 * The roving-focus group's name is set verbatim as the `aria-label` of the hidden container
 * (`hit.tsx:231`), so VoiceOver read the raw dev string "sliding-puzzle-cells" out loud. It
 * is also the only place the Shift+arrow scheme can be stated: plain arrows are claimed for
 * play in the capture phase (see `SlidingPuzzle.tsx`), which leaves a keyboard player with no
 * documented way to move the focus ring at all.
 */
const GROUP = "Sliding Puzzle tiles. Arrow keys slide a piece. Shift and an arrow moves between slots.";

/* ------------------------------------------------------------------ */
/* Per-frame scratch — nothing in `useFrame` may allocate              */
/* ------------------------------------------------------------------ */

const _pos = new Vector3();
const _scl = new Vector3();
const _quat = new Quaternion();
const _euler = new Euler();
const _tile = new Matrix4();
const _part = new Matrix4();
const _squash = { x: 1, y: 1, z: 1 };
/** Blob tint, written per instance. Never a token colour — this is a density multiplier. */
const _tint = new Color();

/** roundedPlate lies in XY with its thickness along Z; this lays it flat, face up. */
const TILE_PART = new Matrix4().makeRotationX(-Math.PI / 2);
const FACE_PART = new Matrix4().makeRotationX(-Math.PI / 2).setPosition(0, FACE_DY, 0);
const BLOB_QUAT = new Quaternion().setFromEuler(new Euler(-Math.PI / 2, 0, 0));

/* ------------------------------------------------------------------ */
/* Tile animation                                                      */
/* ------------------------------------------------------------------ */

type TileAnim = {
  /** Cell the tile is travelling to, in unconverged world units. */
  toX: number;
  toZ: number;
  fromX: number;
  fromZ: number;
  t: number;
  moving: boolean;
  /** 0 = on the floor, 1 = lifted, 2 = landed. Drives the one-shot impulses. */
  phase: number;
  x: number;
  y: number;
  z: number;
  squash: Spring;
  tiltX: Spring;
  tiltZ: Spring;
  bump: Spring;
  /** Bank into the direction of travel. Recomputed every frame, never integrated. */
  bankX: number;
  bankZ: number;
  /** Height the tile was at when its current hop began, so a re-tap cannot snap it down. */
  startY: number;
  /**
   * Reduced-motion scale pop. Springs are deliberately inert under reduced motion (they
   * zero their velocity every step), so an `impulse` there does nothing at all — the pop
   * path has to be an explicit clock or a blocked tap gives no feedback whatsoever.
   */
  popT: number;
  sign: number;
  /** Hidden until the picture is finished — this is the piece the puzzle is missing. */
  hidden: boolean;
};

function createTileAnim(): TileAnim {
  return {
    toX: 0,
    toZ: 0,
    fromX: 0,
    fromZ: 0,
    t: 0,
    moving: false,
    phase: 0,
    x: 0,
    y: 0,
    z: 0,
    squash: new Spring(0, FEEL.snappy.stiffness, FEEL.snappy.damping),
    /*
     * `tiltX` / `tiltZ` / `bump` are **§4.1 Exception 1 — comic wobble**, named here because
     * the exception requires naming.
     *
     *   tiltX, tiltZ  ζ 0.260, 42.9 % overshoot, 889 ms   the tile's lean as it slides
     *   bump          ζ 0.395, 25.9 % overshoot, 533 ms   the nudge on an illegal move
     *
     * All three sit inside the exception's ζ 0.25–0.44 / ≤45 % / ≤900 ms envelope, and all
     * three are flourishes nobody waits on: the tile has already arrived and the board is
     * already accepting the next tap while they ring down. §6.3 asks for the bump by name
     * ("misses give a soft comic wobble"), and a bump damped into §4's band does not read as
     * comic. The tile's *travel*, which a child does wait on, is `FEEL.snappy` above and is
     * in the band.
     */
    tiltX: new Spring(0, 300, 9),
    tiltZ: new Spring(0, 300, 9),
    bump: new Spring(0, 360, 15),
    bankX: 0,
    bankZ: 0,
    startY: 0,
    popT: 1,
    sign: 1,
    hidden: false,
  };
}

/** Places a tile at a cell with no motion — used on a deal and on a resize. */
function placeTile(a: TileAnim, x: number, z: number): void {
  a.toX = x;
  a.toZ = z;
  a.fromX = x;
  a.fromZ = z;
  a.x = x;
  a.z = z;
  a.y = 0;
  a.t = 0;
  a.moving = false;
  a.phase = 0;
  a.bankX = 0;
  a.bankZ = 0;
  a.startY = 0;
  a.popT = 1;
  a.squash.set(0);
  a.tiltX.set(0);
  a.tiltZ.set(0);
  a.bump.set(0);
}

function startHop(a: TileAnim, x: number, z: number): void {
  a.fromX = a.x;
  a.fromZ = a.z;
  a.toX = x;
  a.toZ = z;
  a.t = 0;
  a.moving = true;
  a.phase = 0;
  // Re-tapping a tile that is still in the air must not snap it to the floor: whatever
  // height it is at is blended out across the new hop's wind-up.
  a.startY = a.y;
}

function nudge(a: TileAnim, reduced: boolean): void {
  if (reduced) {
    // A 150 ms scale pop instead of a wobble: still an unmistakable "not that one".
    a.popT = 0;
    return;
  }
  a.tiltZ.impulse(NUDGE_TILT * a.sign);
  a.tiltX.impulse(NUDGE_TILT * 0.45 * -a.sign);
  a.bump.impulse(NUDGE_HOP);
  a.squash.impulse(-2.2);
}

/** Vertical profile of a hop: press in, lift clear of the rim, hold, drop. */
function hopY(p: number): number {
  if (p < DIP_END) return -DIP * Math.sin((p / DIP_END) * Math.PI);
  if (p < LIFT_END) return RISE * easeOutBack((p - DIP_END) / (LIFT_END - DIP_END), 1.5);
  if (p < HOLD_END) return RISE;
  return RISE * (1 - easeInCubic((p - HOLD_END) / (1 - HOLD_END)));
}

function stepTile(a: TileAnim, dt: number, reduced: boolean): void {
  if (a.moving) {
    a.t += dt;
    const dur = reduced ? FEEL.reducedFade : HOP_DUR;
    const p = clamp01(a.t / dur);

    if (reduced) {
      const k = easeOutCubic(p);
      a.x = a.fromX + (a.toX - a.fromX) * k;
      a.z = a.fromZ + (a.toZ - a.fromZ) * k;
      a.y = 0;
    } else {
      const k = anticipate(clamp01((p - GLIDE_START) / GLIDE_SPAN), 0.1);
      a.x = a.fromX + (a.toX - a.fromX) * k;
      a.z = a.fromZ + (a.toZ - a.fromZ) * k;
      a.y = hopY(p) + (p < DIP_END ? a.startY * (1 - p / DIP_END) : 0);

      if (a.phase === 0 && p >= DIP_END) {
        a.phase = 1;
        a.squash.impulse(LIFT_STRETCH);
      }
      if (a.phase === 1 && p >= 0.985) {
        a.phase = 2;
        a.squash.impulse(LAND_IMPULSE);
        sounds.pop();
      }

      // Bank into the direction of travel: the leading edge tips down mid-flight.
      const bell = Math.sin(p * Math.PI) * BANK;
      const dx = a.toX - a.fromX;
      const dz = a.toZ - a.fromZ;
      const inv = 1 / (Math.abs(dx) + Math.abs(dz) || 1);
      a.bankZ = -dx * inv * bell;
      a.bankX = dz * inv * bell;
    }

    if (p >= 1) {
      a.moving = false;
      a.x = a.toX;
      a.z = a.toZ;
      a.y = 0;
      a.startY = 0;
      a.bankX = 0;
      a.bankZ = 0;
      if (reduced) a.squash.set(0);
    }
  } else {
    a.y = 0;
    a.bankX = 0;
    a.bankZ = 0;
  }

  if (a.popT < 1) a.popT += dt / FEEL.reducedFade;
  a.squash.step(dt);
  a.tiltX.step(dt);
  a.tiltZ.step(dt);
  a.bump.step(dt);
}

/* ------------------------------------------------------------------ */
/* Scene                                                               */
/* ------------------------------------------------------------------ */

type TileNode = {
  id: number;
  geometry: BufferGeometry | null;
  ref: RefObject<Group>;
};

type CellNode = {
  pos: number;
  label: string;
  hit: [number, number, number];
};

const RELIEF_ROT: [number, number, number] = [Math.PI / 2, 0, 0];
const PLAQUE_ROT: [number, number, number] = [-PLAQUE_TILT, 0, 0];

function SlidingPuzzleSceneImpl({ engine }: { engine: SlidingPuzzleEngine }): JSX.Element {
  /** Bumped by the `deal` event — the only engine event that re-renders this component. */
  const [dealId, setDealId] = useState(0);

  const size = engine.size;
  const count = engine.count;
  const scene = engine.scene;

  const anims = useMemo(() => {
    const out: TileAnim[] = [];
    for (let i = 0; i < MAX_TILES; i++) out.push(createTileAnim());
    return out;
  }, []);

  /* ---------------- shared, cached board resources ---------------- */

  const trayGeo = useMemo(() => clayTray(TRAY_W, TRAY_W, TRAY_H, WALL), []);
  const tileGeo = useMemo(
    () => roundedPlate(tileSize(size), tileSize(size), TILE_T, tileCorner(size), PLATE_DETAIL),
    [size]
  );
  /**
   * The printed panel.
   *
   * Cloned, not shared. `roundedPlate` returns a `cachedGeometry`, which lives for the life
   * of the WebGL context and is handed to whoever asks for the same size — and this mesh has
   * to hang a per-instance attribute off its geometry (see `faceAlbedo`). Attaching an
   * `InstancedBufferAttribute` to a shared geometry would leak this game's sky colours into
   * every other consumer of a plate that happens to be the same size.
   *
   * Sized by `faceSize`, which lands its **flat top on the tile's flat top** at every level.
   * It used to be a flat `tileSize - 0.09` at all three, while the tile's own rim roll is
   * `2 x 0.0665 / 0.1012 / 0.0737` — so the panel spilled onto the roll at 2x2 and 3x3 and
   * left a 0.008-unit ring of bare ivory under the picture at 4x4. That ring is what round 4's
   * SP3 measured as the relief "running past the panel"; the panel was the thing that was
   * mis-registered, and it is now derived from the same numbers `roundedPlate` uses. The dev
   * assertion below measures both built plates rather than trusting the arithmetic.
   */
  const faceGeo = useMemo(() => {
    const w = faceSize(size);
    return roundedPlate(w, w, FACE_T, faceCorner(size), PLATE_DETAIL).clone();
  }, [size]);
  useEffect(() => {
    const geo = faceGeo;
    return () => geo.dispose();
  }, [faceGeo]);
  /** Per-instance sky colour, on the attribute the clay shader treats as an albedo. */
  const faceAlbedo = useMemo(() => ensureInstanceAlbedo(faceGeo, MAX_TILES), [faceGeo]);
  const barGeo = useMemo(() => roundedBox(BOARD, BAR_H, BAR_W, 0.022), []);
  const blobGeo = useMemo(
    () => cachedGeometry("sliding-puzzle/quad", () => new PlaneGeometry(1, 1)),
    []
  );
  const plaqueGeo = useMemo(
    () => roundedPlate(PLAQUE_W, PLAQUE_W, PLAQUE_T, PLAQUE_CORNER, PLATE_DETAIL),
    []
  );
  const ledgeGeo = useMemo(() => roundedBox(LEDGE_W, LEDGE_H, LEDGE_D, 0.07), []);
  /**
   * The empty cell.
   *
   * It used to be nothing but the contact blob at 0.78x tile size, which renders as a blurred
   * mud ellipse on the tray floor — three of the captured frames show it and none of them say
   * "put a piece here". A real shallow dish with a rolled lip does: `clayTray` is exactly that
   * prop, at one tile's size, and the blob then lives *inside* it as the well's own darkness.
   */
  const socketGeo = useMemo(() => {
    const w = tileSize(size) * 0.98;
    return clayTray(w, w, 0.075, 0.05);
  }, [size]);

  const trayMat = useMemo(() => clayPainted(ACCENTS.mauve.soft, { roughness: 0.74, grain: 0.14 }), []);
  const barMat = useMemo(() => clayPainted(ACCENTS.mauve.main, { roughness: 0.7, grain: 0.13 }), []);
  const tileMat = useMemo(() => clayIvory(), []);
  /**
   * White-based on purpose: the printed panel's colour arrives entirely as a per-instance
   * linear multiply, so one material paints sixteen different patches of sky.
   */
  const faceMat = useMemo(
    () =>
      clay("sliding-puzzle/face", {
        color: "#ffffff",
        roughness: 0.68,
        sheen: 0.28,
        grain: 0.1,
        grainScale: GRAIN_SCALE,
      }),
    []
  );
  /**
   * Same trick for the relief: the palette rides in the baked vertex colours.
   *
   * `grainScale` on both surfaces is round 4's A14 half of SP4. The shared grain map tiles
   * every 0.75 world units, which puts **one** period across a 3x3 tile — a gradient, not the
   * fingerprinted clay §3 asks for, and the reason the relief measured as a uniform field.
   * See `layout.ts::GRAIN_SCALE` for why it is one constant rather than a function of `size`.
   */
  const reliefMat = useMemo(
    () =>
      clay("sliding-puzzle/relief", {
        color: "#ffffff",
        roughness: 0.64,
        wrap: 0.36,
        sss: CLAY.sss,
        sssStrength: 0.44,
        sheen: 0.3,
        grain: 0.11,
        grainScale: GRAIN_SCALE,
      }),
    []
  );
  const blobMat = useMemo(() => shadowBlobMaterial(), []);
  /**
   * How to write a *faded* blob into a per-instance colour.
   *
   * `materials.ts::blobMaterial` blends to `dst * mix(1, tint, a)`, and `a` is a property of
   * the material — one number for all sixteen instances, so an instanced blob cannot fade by
   * opacity the way `ContactBlob` does. It can fade by tint, and exactly: solving
   * `mix(1, tintEff, a) = mix(1, tint, a * fade)` gives `tintEff = mix(1, tint, fade)`, so the
   * per-instance multiplier is `((1 - fade) + fade * tint) / tint` per channel. At `fade = 1`
   * that is 1 (the material's own density, which is what the deal effect writes) and as
   * `fade` falls it rises toward `1 / tint`, i.e. toward a multiply by white.
   *
   * The reciprocal is taken once, here, off the material's own colour — never a copy of the
   * hex, which would be a second place for `BLOB_TINT` to be wrong.
   *
   * Checked against the law it is standing in for (`scratchpad/sp/blob.mjs`): over the whole
   * fade window the receiver ends up multiplied by 0.66437 -> 1.00000, matching
   * `mix(1, tint, a * fade)` to **2.2e-16**, with the instance multiplier staying inside
   * 1.0 .. 3.85 rather than running off toward a reciprocal of zero.
   */
  const blobInvTint = useMemo(
    () =>
      [
        1 / Math.max(1e-4, blobMat.color.r),
        1 / Math.max(1e-4, blobMat.color.g),
        1 / Math.max(1e-4, blobMat.color.b),
      ] as const,
    [blobMat]
  );
  /**
   * The socket reads as a slot because it is the accent **one** step deeper than the tray.
   *
   * It used to say that and use `mauve.deep`, which is two. Sampled off the shipped frame,
   * the empty well rendered `#97563f` — a chocolate brown at L* 43.6, C* 35.0, hue 45.5°: the
   * darkest large surface on screen and 3.4 % of the play area, on a board whose own tray is
   * `mauve.soft`. A recess does not have to be painted dark to read as a recess: this one is
   * already a `clayTray` with a rolled lip and a shadow blob pooled inside it, and both of
   * those survive a lighter clay. `mauve.main` is the tone the comment always claimed, it is
   * still a 29-point L* step below the tray floor (`#efdfda` L* 89.9 against `#c08475` L*
   * 60.8), and it is the one clay in this scene whose *rendered* value has been measured on
   * token: the ledge and the lattice bars carry the same `mauve.main` and sample `#c0816a`
   * out of the shipped frame, **3.1 dE2000** from `#c08475`, against the well's **5.6** from
   * its own `mauve.deep`. It is kept as its own material rather than shared with `barMat`
   * only for the roughness — a recess must not catch the key the way a lit ledge does — and
   * roughness is a uniform, not a define, so it costs no extra shader program.
   */
  const socketMat = useMemo(
    () => clayPainted(ACCENTS.mauve.main, { roughness: 0.76, grain: 0.14 }),
    []
  );
  /**
   * The plaque's sky: the ramp **stop** nearest the middle of the picture.
   *
   * It used to be the interpolated colour there, and `clayPainted` derives its cache key from
   * the colour it is handed — so the material cache gained an entry per *distinct picture*,
   * and its boundedness was an accident of there being five scenes rather than a property of
   * the key. Snapping to the nearer stop makes the key a **brand token**, so the entry count
   * is bounded by the palette (18 hexes) no matter how many pictures this game grows, and a
   * second consumer of the same token promotes it into `dispose.ts`'s shared tier instead of
   * duplicating it.
   *
   * Keying on `sceneIdx` was the other candidate and is weaker: it is still one private entry
   * per picture, it just spells the number differently.
   *
   * The snap is free. Measured over the five ramps, the largest difference between the lerp
   * and the nearer stop is **5 codes of 255** (`brush`, `#f8f1ea` → `#faf6ee`, and `dentist`,
   * `#f8dedf` → `#f7d9dc`); two scenes differ by 0–1. This is the flat panel *behind* the
   * relief, not the relief, and the tiles themselves still carry the exact interpolated ramp
   * per instance.
   */
  const sceneIdx = engine.sceneIdx;
  const plaqueMat = useMemo(() => {
    const mid = bgSample(SCENES[sceneIdx].bg, 0);
    return clayPainted(mid.t < 0.5 ? mid.a : mid.b, {
      roughness: 0.72,
      sheen: 0.24,
      grain: 0.12,
    });
  }, [sceneIdx]);

  /* ---------------- the relief: cached per (picture, size, bevel) ---------------- */

  /**
   * Quarter-round segments per relief bevel. Two, at every tier and every board size.
   *
   * Round 4's SP2 asked for `detail <= 1 || size >= 4 ? 1 : 2` to bring the scene under §9's
   * 180,000-triangle budget. Three things are wrong with that and all three are measurable:
   *
   *  1. `getQuality().detail` is now **2 at every tier** (A4 raised the low tier off `1`), so
   *     the left-hand arm is dead code and the board already builds at 2 on the target device.
   *  2. The relief is not where the triangles are. Built and counted, the worst picture's
   *     whole relief at 4x4 is 23,688 of the captured 187,764 — **5 %** — and K=1 saves
   *     12,112, against a real overshoot of **28,586** on the worst picture (`family` at the
   *     high tier totals 208,586, not 187,764: the capture was of `dentist`). It does not
   *     close the gap it was proposed to close. `PLATE_DETAIL` is what closes it.
   *  3. K=1 does not just soften a bevel, it **deletes the edge gloss**: the wear peak is
   *     sampled at `theta = PI/4` and K=1 puts the top bevel's rings at 0 and PI/2 only.
   *     That is the one shading term a dark relief piece can be read by (`reliefMesh.ts::WEAR`),
   *     so the cheap path would have shipped exactly the flat black SP4 is about.
   */
  const bevelSteps = 2;

  const tiles = useMemo<TileNode[]>(() => {
    const geometries = boardRelief(sceneIdx, size, bevelSteps);
    const out: TileNode[] = [];
    for (let id = 0; id < count; id++) {
      out.push({ id, geometry: geometries[id] ?? null, ref: createRef<Group>() });
    }
    return out;
    // `dealId` is the dependency that matters: it changes exactly when the picture or the
    // board size does. The geometries themselves are cached and owned by `reliefMesh.ts`
    // (`boardRelief`), so a re-deal onto a picture the child has already seen allocates
    // nothing at all — and nothing here may dispose them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dealId, sceneIdx, size, count, bevelSteps]);

  const plaque = useMemo(() => plaqueRelief(sceneIdx, bevelSteps), [sceneIdx, bevelSteps]);

  /* ---------------- dev: the two things this scene has to keep honest ---------------- */

  /**
   * Counts the triangles this scene actually built, and checks the printed panel is still
   * registered to the tile it is printed on. Both exist because round 4 caught this file
   * claiming numbers it had not measured.
   *
   * **Triangles.** §9's budget is 180,000 and `sliding-puzzle-perf.json` self-flagged 187,764
   * at 4x4. `renderer.info.render.triangles` sums the whole rAF frame, so a caster is counted
   * twice — once for the shadow pass and once for the beauty pass — and this sum does the
   * same. Modelled against the shipped capture it lands within **0.14 %** (187,498 against a
   * measured 187,764), so a number here is a number about the frame, not about a subset of it.
   * It fires at 90 % of budget rather than at 100: an assertion that only trips once the
   * product is already broken is not a guard.
   *
   * **Registration.** `layout.ts::faceSize` mirrors `geometry.ts::roundedPlate`'s private
   * bevel clamp, so it can drift. This measures the flat top of both plates as actually built
   * — `roundedPlate` lies in XY with its thickness along Z, so the flat top is the widest
   * ring at maximum Z — and reports the moment they stop agreeing.
   */
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const tri = (g: BufferGeometry | null): number =>
      g ? (g.index ? g.index.count : g.attributes.position.count) / 3 : 0;
    /** Half-width of a `roundedPlate`'s flat top face, measured off the built geometry. */
    const flatHalf = (g: BufferGeometry): number => {
      const p = g.attributes.position;
      let maxZ = -Infinity;
      for (let i = 0; i < p.count; i++) if (p.getZ(i) > maxZ) maxZ = p.getZ(i);
      let half = 0;
      for (let i = 0; i < p.count; i++) {
        if (p.getZ(i) < maxZ - 1e-5) continue;
        const x = Math.abs(p.getX(i));
        if (x > half) half = x;
      }
      return half;
    };

    let board = 0;
    for (const node of tiles) board += tri(node.geometry);
    const bars = 2 * (size - 1);
    // [what, triangles each, how many, does it cast]
    const parts: [string, number, number, boolean][] = [
      ["tray", tri(trayGeo), 1, true],
      ["tile bodies", tri(tileGeo), count, true],
      ["face panels", tri(faceGeo), count, false],
      ["lattice bars", tri(barGeo), bars, false],
      ["shadow blobs", tri(blobGeo), count + 2, false],
      ["empty socket", tri(socketGeo), 1, false],
      ["ledge", tri(ledgeGeo), 1, false],
      ["plaque slab", tri(plaqueGeo), 1, false],
      ["board relief", board, 1, true],
      ["plaque relief", tri(plaque), 1, false],
    ];
    let total = 0;
    for (const [, each, n, casts] of parts) total += each * n * (casts ? 2 : 1);
    if (total > BUDGETS.triangles * 0.9) {
      const rows = parts
        .map(([what, each, n, casts]) =>
          `  ${what}: ${each} x ${n}${casts ? " x2 (casts)" : ""} = ${each * n * (casts ? 2 : 1)}`
        )
        .join("\n");
      console.error(
        `[sliding-puzzle] ${size}x${size} builds ${total} triangles, over 90 % of §9's ` +
          `${BUDGETS.triangles}:\n${rows}`
      );
    }

    const tileFlat = flatHalf(tileGeo);
    const faceFlat = flatHalf(faceGeo);
    if (Math.abs(tileFlat - faceFlat) > 1e-3) {
      console.error(
        `[sliding-puzzle] the printed panel's flat top is ${(faceFlat * 2).toFixed(4)} across ` +
          `and the tile's is ${(tileFlat * 2).toFixed(4)} — ${((faceFlat - tileFlat) * 2).toFixed(4)} ` +
          `apart. \`layout.ts::faceSize\` mirrors \`roundedPlate\`'s rim bevel and one of them ` +
          `has moved; the picture is no longer registered to the paper it is printed on.`
      );
    }
    /**
     * …and that the panel still *fits*. Its widest band sits at `FACE_PROUD - faceRim` above
     * the tile's flat top, where the tile has already begun to roll away; at 4x4 the two rims
     * pass within 1.5 mm. Positive at every level today (9.9 / 6.5 / 1.5 mm), and this is what
     * says so if `TILE_T`, `FACE_PROUD` or `FACE_T` ever moves.
     *
     * Interpolated between the two rings that bracket the height, not snapped to the nearer
     * one: the tile's rim is only `filletSegments(2) = 3` rings of quarter-round, so the mesh
     * *is* the chord between them and that chord is the surface the rasteriser draws. Snapping
     * to the ring above reports the 4x4 clearance as -1.6 mm and would fire on a board that is
     * correct — a self-check that does not measure the thing it names is what A12 is about.
     */
    const panelWidestY = TILE_T / 2 + FACE_PROUD - faceRim(size);
    const tp = tileGeo.attributes.position;
    let loZ = -Infinity;
    let loHalf = 0;
    let hiZ = Infinity;
    let hiHalf = 0;
    for (let i = 0; i < tp.count; i++) {
      const z = tp.getZ(i);
      const x = Math.abs(tp.getX(i));
      if (z <= panelWidestY + 1e-6) {
        if (z > loZ + 1e-5) {
          loZ = z;
          loHalf = 0;
        }
        if (z > loZ - 1e-5) loHalf = Math.max(loHalf, x);
      }
      if (z >= panelWidestY - 1e-6) {
        if (z < hiZ - 1e-5) {
          hiZ = z;
          hiHalf = 0;
        }
        if (z < hiZ + 1e-5) hiHalf = Math.max(hiHalf, x);
      }
    }
    const span = hiZ - loZ;
    const bodyThere =
      Number.isFinite(loZ) && Number.isFinite(hiZ)
        ? span > 1e-6
          ? loHalf + ((panelWidestY - loZ) / span) * (hiHalf - loHalf)
          : loHalf
        : NaN;
    if (Number.isFinite(bodyThere) && faceSize(size) / 2 >= bodyThere) {
      console.error(
        `[sliding-puzzle] at ${size}x${size} the printed panel's widest band ` +
          `(${(faceSize(size) / 2).toFixed(4)}) is not inside the tile there ` +
          `(${bodyThere.toFixed(4)}) — the panel's rim is cutting through the tile's.`
      );
    }

    // The skirt is derived from the same rim, so this is the other half of the same claim.
    const rim = tileRim(size);
    if (Math.abs(tileSize(size) / 2 - rim - tileFlat) > 1e-3) {
      console.error(
        `[sliding-puzzle] \`layout.ts::tileRim(${size})\` says ${rim.toFixed(4)} but the built ` +
          `tile's rim is ${(tileSize(size) / 2 - tileFlat).toFixed(4)} — \`reliefSkirt\` is ` +
          `sizing the relief's skirt against the wrong number.`
      );
    }
  }, [
    tiles,
    plaque,
    trayGeo,
    tileGeo,
    faceGeo,
    barGeo,
    blobGeo,
    socketGeo,
    ledgeGeo,
    plaqueGeo,
    count,
    size,
  ]);

  /**
   * Build the picture "Next picture" will land on, while nothing is happening.
   *
   * This is the other half of the cache. A board costs 0.8–3.8 ms to build and the button
   * that triggers it is the one control a child presses mid-run, so the build is done now,
   * on idle, rather than inside the render that follows the press. `nextPicture()` steps to
   * `(sceneIdx + 1) % SCENES.length`, so that is exactly the key prefetched; a restart picks
   * a random picture and may still miss, which is a full re-deal where a build is hidden
   * anyway.
   *
   * `requestIdleCallback` where it exists (not Safari before 17), a macrotask otherwise —
   * never a microtask, which would land inside the same frame it was scheduled from. The
   * handle is cancelled on unmount so a game left during the idle window does not populate
   * a cache the eviction pass has already walked.
   */
  useEffect(() => {
    const next = (sceneIdx + 1) % SCENES.length;
    const run = () => {
      boardRelief(next, size, bevelSteps);
    };
    // Called on `window`, not detached: `requestIdleCallback` is a Window operation and a
    // bare call throws "Illegal invocation".
    if (typeof window.requestIdleCallback === "function") {
      const handle = window.requestIdleCallback(run, { timeout: 2000 });
      return () => window.cancelIdleCallback(handle);
    }
    const handle = window.setTimeout(run, 400);
    return () => window.clearTimeout(handle);
  }, [sceneIdx, size, bevelSteps]);

  /* ---------------- cells (the tap targets never move) ---------------- */

  const cells = useMemo<CellNode[]>(() => {
    const out: CellNode[] = [];
    for (let pos = 0; pos < count; pos++) {
      out.push({
        pos,
        // Deliberately stable: a label that changed as tiles moved would recreate the
        // hidden button and steal keyboard focus mid-game. State goes through announce().
        label: `Slot row ${Math.floor(pos / size) + 1}, column ${(pos % size) + 1} of ${size}`,
        hit: [cellX(pos, size), REST_Y + TILE_T * 0.6, cellZ(pos, size)],
      });
    }
    return out;
  }, [count, size]);

  /* ---------------- refs ---------------- */

  const tileRef = useRef<InstancedMesh>(null);
  const faceRef = useRef<InstancedMesh>(null);
  const barRef = useRef<InstancedMesh>(null);
  const blobRef = useRef<InstancedMesh>(null);
  const latticeRef = useRef<Group>(null);
  const socketRef = useRef<Mesh>(null);
  /**
   * The celebration hand-off, split in two — and the split is round 4's SP1.
   *
   * `celebrationHeroScale()` exists so a game's **hero prop** gets out of the arriving
   * mascot's way (`store.ts::celebration`). Until now this scene put *everything* inside one
   * group and scaled that: the tiles, their relief, their shadows, the socket and the plaque.
   * So the frame the child got for finishing a jigsaw was an **empty tray** — measured across
   * the whole capture, `sliding-puzzle-4x4-payoff-f04` onward and every one of the 25
   * `celebration-f*` frames: the completed picture is deleted between two frames, a third of
   * a second after it is completed, and the headline and score chip are then drawn on the bare
   * clay where it used to be. The closing beat this game is built around — the last piece
   * drops in, the grooves sink, the board becomes one slab — never survives to be looked at.
   *
   * So:
   *
   *  - **`workRef` is the child's work and it never scales.** Tiles, faces, relief, tile
   *    shadows, the socket. `GameShell`'s own §2 note says the point of rendering the burst
   *    inside the game's view is that "the child's work is still on screen"; this is that.
   *  - **`heroRef` is the reference plaque, and it yields.** The plaque stands at
   *    `z = -2.41`, centred, above the ledge — which is measurably where the celebration puts
   *    its mascot (solving the capture's mascot silhouette back through the camera puts its
   *    feet at `z ~ -2.27`, behind the tray and inside the ledge). It is also the one prop
   *    whose job is finished the moment the picture is: it exists to say what the child is
   *    building. It takes `celebrationHeroScale()`; nothing else does.
   *
   * The tray, its grooves and the ledge were already outside the group and still are: that is
   * the room the celebration is deliberately still rendering. The finished board now sits in
   * it, which is the whole point.
   */
  const workRef = useRef<Group>(null);
  const heroRef = useRef<Group>(null);

  const marker = useMemo(
    () => ({
      x: new Spring(0, FEEL.settle.stiffness, FEEL.settle.damping),
      z: new Spring(0, FEEL.settle.stiffness, FEEL.settle.damping),
      // **§4.1 Exception 1 (comic wobble)**: ζ 0.434 / 22.0 % / 500 ms. The marker's pulse is
      // an invitation, not a landing — it plays while the board waits for the child.
      pulse: new Spring(0, 340, 16),
      /** The reduced-motion path, for the same reason as `TileAnim.popT`. */
      popT: 1,
    }),
    []
  );
  const solve = useMemo(() => ({ active: false, t: 0, dropped: false }), []);

  /* ---------------- instance buffers, reset on every deal ---------------- */

  useLayoutEffect(() => {
    const tileMesh = tileRef.current;
    const faceMesh = faceRef.current;
    const barMesh = barRef.current;
    const blobMesh = blobRef.current;
    const lattice = latticeRef.current;

    solve.active = false;
    solve.t = 0;
    solve.dropped = false;
    if (lattice) lattice.position.y = 0;

    for (let pos = 0; pos < count; pos++) {
      const id = engine.tiles[pos];
      placeTile(anims[id], cellX(pos, size), cellZ(pos, size));
      anims[id].sign = pos % 2 === 0 ? 1 : -1;
      anims[id].hidden = id === engine.blankId;
    }

    marker.x.set(cellX(engine.blankPos, size));
    marker.z.set(cellZ(engine.blankPos, size));
    marker.pulse.set(0);
    marker.popT = 1;

    if (tileMesh) {
      tileMesh.count = count;
      tileMesh.instanceMatrix.setUsage(DynamicDrawUsage);
    }
    if (faceMesh) {
      faceMesh.count = count;
      faceMesh.instanceMatrix.setUsage(DynamicDrawUsage);
      // `aAlbedo`, never `setColorAt`. three multiplies `instanceColor` into `vColor`, and
      // `materials.ts` reads `vColor` as signed curvature and extrapolates it by 1.45 — which
      // is what turned this game's peach sky into `(227, 74, 9)` and its ink into black.
      const c = new Color();
      const c2 = new Color();
      for (let id = 0; id < count; id++) {
        const sample = bgSample(scene.bg, cellV(id, size));
        c.set(sample.a);
        c2.set(sample.b);
        writeAlbedo(faceAlbedo, id, c.lerp(c2, sample.t));
      }
      faceAlbedo.needsUpdate = true;
    }
    if (blobMesh) {
      blobMesh.count = count + 1;
      blobMesh.instanceMatrix.setUsage(DynamicDrawUsage);
      // Density, not colour: this is a `MeshBasicMaterial`, so `instanceColor` is a plain
      // multiply on the blob's tint and none of S2's curvature reinterpretation applies.
      // Allocated once, here, so `useFrame` only ever writes into it.
      _tint.setScalar(1);
      for (let i = 0; i <= count; i++) blobMesh.setColorAt(i, _tint);
      if (blobMesh.instanceColor) {
        blobMesh.instanceColor.setUsage(DynamicDrawUsage);
        blobMesh.instanceColor.needsUpdate = true;
      }
    }
    if (barMesh) {
      const bars = 2 * (size - 1);
      barMesh.count = bars;
      const cell = cellSize(size);
      const m = new Matrix4();
      const q = new Quaternion();
      const p = new Vector3();
      const s = new Vector3(1, 1, 1);
      for (let i = 0; i < size - 1; i++) {
        const offset = (i + 1 - size / 2) * cell;
        q.identity();
        p.set(0, WELL_Y + BAR_H / 2, offset);
        m.compose(p, q, s);
        barMesh.setMatrixAt(i, m);
        q.setFromEuler(new Euler(0, Math.PI / 2, 0));
        p.set(offset, WELL_Y + BAR_H / 2, 0);
        m.compose(p, q, s);
        barMesh.setMatrixAt(size - 1 + i, m);
      }
      barMesh.instanceMatrix.needsUpdate = true;
    }
  }, [engine, anims, count, size, scene, marker, solve, dealId, faceAlbedo]);

  /* ---------------- engine events ---------------- */

  useEffect(
    () =>
      engine.on((event) => {
        const reduced = isReduced();
        switch (event.type) {
          case "deal":
            setDealId((v) => v + 1);
            break;
          case "move":
            startHop(anims[event.tile], cellX(event.to, size), cellZ(event.to, size));
            break;
          case "blocked":
            if (event.reason !== "far") {
              if (reduced) marker.popT = 0;
              else marker.pulse.impulse(3.2);
            } else {
              const id = engine.tiles[event.pos];
              if (id !== undefined && anims[id]) nudge(anims[id], reduced);
              if (reduced) marker.popT = 0;
              else marker.pulse.impulse(2.0);
            }
            break;
          case "solve":
            // The missing piece has been parked at its deal-time cell all game — the engine
            // never emits a `move` for it — so put it on its home cell before it drops in.
            placeTile(
              anims[engine.blankId],
              cellX(engine.blankPos, size),
              cellZ(engine.blankPos, size)
            );
            anims[engine.blankId].hidden = true;
            solve.active = true;
            solve.t = 0;
            solve.dropped = false;
            break;
          default:
            break;
        }
      }),
    // `size` is read inside the callback; the subscription is re-bound on a deal, which is
    // the only time it changes, so the closure can never see a stale board.
    [engine, anims, marker, solve, size]
  );

  /* ---------------- keyboard ---------------- */

  /*
   * `MAX_TILES`, not `cells.length`, and that is deliberate — copy it from Tooth Match.
   * `useFocusGroup` releases and re-takes its reference whenever `count` changes, and a
   * re-deal *also* unmounts every `HitTarget` before the new ones mount. If the hook let go
   * in the same commit the group's reference count would touch zero, its hidden container
   * would leave the DOM, and the new cells would register into a detached node — arrow keys
   * and VoiceOver would go quiet with nothing in the console.
   *
   * Each cell's own `HitTarget` owns activation, so `onActivate` only ever fires for the
   * indices above the current board size; it is guarded rather than left to throw.
   */
  useFocusGroup(GROUP, MAX_TILES, (index) => {
    if (index < engine.count) engine.tapAt(index);
  });

  /* ---------------- the frame ---------------- */

  useFrame((_state, delta) => {
    const tileMesh = tileRef.current;
    const faceMesh = faceRef.current;
    const blobMesh = blobRef.current;
    if (!tileMesh || !faceMesh || !blobMesh) return;

    const blobInk = blobMesh.instanceColor;
    const dt = safeDelta(delta);
    const reduced = isReduced();

    // The hand-off. 1 for the whole run, then eased to exactly 0 across the shared window —
    // and it reaches the reference plaque only. See `heroRef`.
    const hero = heroRef.current;
    if (hero) {
      const exit = celebrationHeroScale();
      hero.scale.set(exit, exit, exit);
    }

    /* --- the closing beat --- */
    let converge = 1;
    let dropK = 1;
    if (solve.active) {
      solve.t += dt;
      const dropEnd = reduced ? FEEL.reducedFade : DROP_IN_END;
      const closeFrom = reduced ? FEEL.reducedFade : CLOSE_START;
      const closeTo = reduced ? FEEL.reducedFade * 2 : CLOSE_END;
      dropK = clamp01(solve.t / dropEnd);
      const closeP = clamp01((solve.t - closeFrom) / (closeTo - closeFrom));
      const closeK = reduced ? easeOutCubic(closeP) : easeOutBack(closeP, 1.35);
      converge = 1 + (convergeFactor(size) - 1) * closeK;
      if (!solve.dropped && dropK >= 1) {
        solve.dropped = true;
        if (!reduced) anims[engine.blankId].squash.impulse(LAND_IMPULSE);
        sounds.pop();
      }
      const lattice = latticeRef.current;
      // The grooves have to go before the tiles close over them, or a bar would end up
      // inside a tile. Sinking them reads as the picture becoming one object.
      if (lattice) lattice.position.y = -(BAR_H + 0.02) * closeK;
    }

    /* --- tiles --- */
    for (let id = 0; id < count; id++) {
      const a = anims[id];
      stepTile(a, dt, reduced);

      let y = REST_Y + a.y + a.bump.value;
      let scale = 1;
      if (a.hidden) {
        if (!solve.active) {
          scale = 0;
        } else if (reduced) {
          scale = easeOutCubic(dropK);
        } else {
          // The missing piece drops in from above: the same vocabulary as every other tile.
          y = REST_Y + DROP_HEIGHT * (1 - easeInCubic(dropK));
          scale = easeOutBack(clamp01(solve.t / 0.14), 1.8);
        }
      }

      const group = tiles[id]?.ref.current;
      if (scale <= 0.0005) {
        _pos.set(0, -50, 0);
        _scl.set(0, 0, 0);
        _quat.identity();
        _tile.compose(_pos, _quat, _scl);
        _part.multiplyMatrices(_tile, TILE_PART);
        tileMesh.setMatrixAt(id, _part);
        faceMesh.setMatrixAt(id, _part);
        if (group) group.visible = false;
        _scl.set(1e-4, 1e-4, 1);
        _part.compose(_pos, BLOB_QUAT, _scl);
        blobMesh.setMatrixAt(id, _part);
        continue;
      }

      if (a.popT < 1) scale *= 1 + Math.sin(a.popT * Math.PI) * 0.11;
      squashFor(_squash, a.squash.value, 1, 0.3);
      _pos.set(a.x * converge, y, a.z * converge);
      _euler.set(a.tiltX.value + a.bankX, 0, a.tiltZ.value + a.bankZ);
      _quat.setFromEuler(_euler);
      _scl.set(_squash.x * scale, _squash.y * scale, _squash.z * scale);
      _tile.compose(_pos, _quat, _scl);

      _part.multiplyMatrices(_tile, TILE_PART);
      tileMesh.setMatrixAt(id, _part);
      _part.multiplyMatrices(_tile, FACE_PART);
      faceMesh.setMatrixAt(id, _part);

      if (group) {
        group.visible = true;
        group.matrix.copy(_tile);
        group.matrixWorldNeedsUpdate = true;
      }

      // The shadow: a contact term that hands over to the real cast shadow as the tile
      // leaves the floor. `rise` is the tile's height above its rest, which is also its
      // height above the well floor, because REST_Y is WELL_Y + TILE_T / 2 — so it is the
      // gap `Rig.tsx`'s two laws are written against. See the note by `KEY_SHADOW_X`.
      const rise = y - REST_Y;
      const fade = contactOpacityFor(1, rise);
      const w = fade < BLOB_MIN_FADE ? 0 : contactRadiusFor(tileSize(size) / 2, rise) * 2 * scale;
      _pos.set(
        a.x * converge + rise * KEY_SHADOW_X,
        WELL_Y + 0.006,
        a.z * converge + rise * KEY_SHADOW_Z
      );
      _scl.set(w < 1e-4 ? 1e-4 : w, w < 1e-4 ? 1e-4 : w, 1);
      _part.compose(_pos, BLOB_QUAT, _scl);
      blobMesh.setMatrixAt(id, _part);
      if (blobInk) {
        // `((1 - fade) + fade * tint) / tint`, per channel — see `blobInvTint`.
        const rest = 1 - fade;
        blobInk.setXYZ(
          id,
          rest * blobInvTint[0] + fade,
          rest * blobInvTint[1] + fade,
          rest * blobInvTint[2] + fade
        );
      }
    }

    /* --- the empty slot --- */
    const targetX = cellX(engine.blankPos, size);
    const targetZ = cellZ(engine.blankPos, size);
    if (reduced) {
      marker.x.set(targetX);
      marker.z.set(targetZ);
    } else {
      marker.x.to(targetX);
      marker.z.to(targetZ);
    }
    marker.x.step(dt);
    marker.z.step(dt);
    marker.pulse.step(dt);
    if (marker.popT < 1) marker.popT += dt / FEEL.reducedFade;
    const markerPop = marker.popT < 1 ? Math.sin(marker.popT * Math.PI) * 0.16 : 0;
    /**
     * How settled the empty slot is, 0 while the gap is still travelling and 1 once it has
     * arrived. Both halves of the slot are gated on it, for two reasons: it is the motion the
     * slot wants anyway — the socket *opens* where the gap lands rather than a hole sliding
     * around the tray — and it is what keeps a 7.5 mm dish from poking up through a tile that
     * has not finished leaving the cell it is opening in.
     */
    const travel = Math.abs(marker.x.value - targetX) + Math.abs(marker.z.value - targetZ);
    const seated = clamp01(1 - travel / (cellSize(size) * 0.6));
    const settle = reduced ? seated : easeOutBack(seated, 1.6);
    // Tighter than it was: the blob is now the *inside* of the socket below, not the whole
    // marker, so it has to stay within the socket's well rather than bleeding over its lip.
    const markerScale = solve.active
      ? 0
      : tileSize(size) * settle * (0.6 + marker.pulse.value * 0.45 + markerPop);
    _pos.set(marker.x.value, WELL_Y + 0.005, marker.z.value);
    _scl.set(
      markerScale < 1e-4 ? 1e-4 : markerScale,
      markerScale < 1e-4 ? 1e-4 : markerScale,
      1
    );
    _part.compose(_pos, BLOB_QUAT, _scl);
    blobMesh.setMatrixAt(count, _part);

    // The socket the empty cell is. It rides the same spring as the marker, opens on
    // `settle`, and collapses entirely during the closing beat.
    const socket = socketRef.current;
    if (socket) {
      const open = solve.active
        ? 0
        : settle * (1 + marker.pulse.value * 0.1 + markerPop * 0.4);
      socket.visible = open > 0.01;
      socket.position.set(marker.x.value, WELL_Y, marker.z.value);
      const k = open <= 0.01 ? 0.01 : open;
      socket.scale.set(k, k, k);
    }

    tileMesh.instanceMatrix.needsUpdate = true;
    faceMesh.instanceMatrix.needsUpdate = true;
    blobMesh.instanceMatrix.needsUpdate = true;
    if (blobInk) blobInk.needsUpdate = true;
  });

  /* ---------------- graph ---------------- */

  return (
    <Rig shadowArea={SHADOW_AREA} groundY={0}>
      {/*
        The set: the table dressing the celebration keeps. `GameShell` draws the shared burst
        over a scene that is still rendering, deliberately, so the child stays in the room
        they were playing in rather than getting a cream plate. The tray and its grooves are
        that room — and since SP1, so is everything in `workRef`: the finished picture stays
        in it. The only thing that leaves is the reference plaque (`heroRef`).
      */}
      <ContactBlob position={[0, 0.004, 0]} radius={TRAY_W * 0.66} opacity={0.3} />

      <mesh geometry={trayGeo} material={trayMat} castShadow receiveShadow />

      <group ref={latticeRef}>
        <instancedMesh
          ref={barRef}
          args={[barGeo, barMat, MAX_BARS]}
          frustumCulled={false}
          receiveShadow
        />
      </group>

      <group ref={workRef}>
        {/*
          Only the body casts. The face panel sits inside the body's own outline, so its
          shadow would be identical to one already being drawn — a shadow-pass draw call for
          nothing. The relief does cast: that shadow falling across the printed panel is most
          of what makes it read as clay standing off the tile rather than as a picture.
        */}
        <instancedMesh
          ref={tileRef}
          args={[tileGeo, tileMat, MAX_TILES]}
          frustumCulled={false}
          castShadow
          receiveShadow
        />
        <instancedMesh
          ref={faceRef}
          args={[faceGeo, faceMat, MAX_TILES]}
          frustumCulled={false}
          receiveShadow
        />
        <instancedMesh
          ref={blobRef}
          args={[blobGeo, blobMat, MAX_TILES + 1]}
          frustumCulled={false}
          renderOrder={2}
        />

        {tiles.map((node) =>
          node.geometry ? (
            <group key={node.id} ref={node.ref} matrixAutoUpdate={false}>
              <mesh
                geometry={node.geometry}
                material={reliefMat}
                castShadow
                receiveShadow
              />
            </group>
          ) : null
        )}

        {/*
          The empty cell, as a real pressed-in socket with a rolled lip rather than a smudge.
          `matrixAutoUpdate` stays on: this is one mesh whose transform is written from the
          marker spring every frame, and letting three compose it is cheaper than doing it by
          hand into `Object3D.matrix` and flagging the world matrix.
        */}
        <mesh ref={socketRef} geometry={socketGeo} material={socketMat} receiveShadow />

      </group>

      {/*
        The reference picture, and the only thing in this scene that yields to the celebration.
        It stands centred above the board, which is exactly where the mascot arrives, and its
        job is over the moment the picture is finished. See `heroRef`.
      */}
      <group ref={heroRef}>
        <group position={PLAQUE_POS} rotation={PLAQUE_ROT}>
          <mesh geometry={plaqueGeo} material={plaqueMat} />
          {plaque ? (
            <group rotation={RELIEF_ROT}>
              <mesh geometry={plaque} material={reliefMat} />
            </group>
          ) : null}
        </group>
      </group>

      {/*
        The ledge, and the ledge's own shadow. Set, not piece: it stays.

        `ContactBlob` is square, and a square blob under a 4.6 x 0.5 ledge pools two units of
        shadow behind it. This is the same quad and the same shared material, scaled to the
        shape the ledge actually casts. Depth-tested like every other blob, so the part of it
        that runs under the tray is hidden by the tray rather than doubling up with its blob.
        Both are outside the shadow frustum on purpose (see `SHADOW_AREA`).
      */}
      <mesh
        geometry={blobGeo}
        material={blobMat}
        position={[0, 0.005, LEDGE_POS[2] + 0.08]}
        quaternion={BLOB_QUAT}
        scale={[LEDGE_W * 1.06, LEDGE_D * 2.1, 1]}
        renderOrder={2}
      />
      <mesh geometry={ledgeGeo} material={barMat} position={LEDGE_POS} />

      {/*
        Outside the hand-off group on purpose: a `HitTarget`'s collider is sized in screen
        space from its own world radius, and shrinking one to nothing mid-frame would make
        the roving focus group's geometry meaningless. The shell marks the whole play area
        `inert` while the celebration is up, which is what actually retires these.
      */}
      {cells.map((cell) => (
        <HitTarget
          key={cell.pos}
          ariaLabel={cell.label}
          group={GROUP}
          focusOrder={cell.pos}
          position={cell.hit}
          radius={tileSize(size) * 0.5}
          minScreenPx={48}
          onSelect={() => engine.tapAt(cell.pos)}
        />
      ))}
    </Rig>
  );
}

/**
 * Memoised on `engine`, which never changes identity — so the shell re-rendering its HUD
 * once a second does not touch the 3D tree at all.
 */
export const SlidingPuzzleScene = memo(SlidingPuzzleSceneImpl);
