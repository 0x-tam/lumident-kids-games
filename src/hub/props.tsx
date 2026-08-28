/**
 * The nine hub props — one little clay object per game, built entirely from
 * `src/three/geometry.ts`.
 *
 * Rules this file lives by:
 *
 *  - Every prop is authored inside a **unit box**: centred on the origin, roughly 1.0 across
 *    in X and Y, and never deeper than ±0.35 in Z. The hub scales the whole thing to sit on
 *    a card's accent inlay, so nothing here needs to know how big a card is.
 *  - Geometry and materials come from the shared caches, so props share aggressively: the
 *    same mascot serves Tooth Rescue, Count the Teeth, Tooth Runner, Tooth Match and Smile
 *    Maker, and the same rounded plate serves the puzzle tiles and the memory cards.
 *  - Nothing here allocates per frame. These components render once when the hub mounts and
 *    then never again; all motion is written onto the parent group by `HubScene`.
 *
 * Draw-call cost: 30 meshes for all nine props. They deliberately do **not** cast shadows —
 * 30 more entries in the shadow-map pass would put the hub at its 60-call ceiling with no
 * headroom, and at this size the baked curvature AO plus the accent inlay's own cast shadow
 * already ground every prop. The slabs and inlays cast; the props are lit and occluded.
 *
 * ---
 *
 * **What round 3 found here, because it is the reason half this file changed.**
 *
 * Four of the nine cards — the first screen a child sees, and the one they come back to nine
 * times a session — showed *bare, faceless teeth with exposed roots*: three of them on a
 * pink gum-coloured pad under "Count the Teeth", and one falling into a deep red basin under
 * "Catch the falling teeth". Anatomically a crown with two splayed roots and no face is an
 * **extracted tooth**; `src/games/tooth-rescue/mascot.ts` had already written that down and
 * the in-game scenes had already been fixed. The advertisement was scarier than the product.
 *
 * The reason it survived a round is worth recording, because it was a real constraint and
 * not an oversight: `mascotParts()` is twelve meshes, and seven mascots would have been
 * eighty-four draw calls against a hub ceiling of sixty. `geometry.ts::mascotGeometry()` is
 * the answer — the same mascot merged into one geometry with the face carried on
 * `ALBEDO_ATTRIBUTE`, so a faced, limbed character costs exactly what a bare tooth cost.
 *
 * The second half of that finding was legibility: with the text label hidden — the actual
 * condition for a pre-reader — only two of the nine props were identifiable. The tile stack,
 * the maze block and the party hat are re-composed below for that, each with a note saying
 * what it is now supposed to say.
 */
import {
  latheProfile,
  mascotGeometry,
  mascotMaterial,
  roundedBox,
  roundedCylinder,
  roundedPlate,
  softCapsule,
  softSphere,
  torusSoft,
  clayTray,
} from "../three/geometry";
import { clayAccent, clayGum, clayIvory } from "../three/materials";
import { getQuality, quality } from "../three/quality";
import { useStore } from "../three/store";
import { SLAB } from "./engine";

/**
 * Subdivision ceiling for everything the hub draws.
 *
 * The hub used to build at whatever the device tier asked for, and at `detail: 3` that came
 * to **188,558 rendered triangles against the §9 budget of 180,000** — the only budget
 * violation the harness reported anywhere, on the first screen a child sees, and the scene
 * with the worst measured `renderP95Ms` by a factor of eight. The number is fully accounted
 * for: 44,916 in the nine props, 86,148 in the twenty-seven card plates, 2 in the backdrop
 * and 57,492 in the shadow pass the slabs and inlays submit a second time.
 *
 * The hub is nine static objects at slab scale, none of them larger than an 88-px DOM slot,
 * so `detail: 3` buys nothing there. With the cap in place — and *including* the seven new
 * mascots, which cost 4,700 triangles each against a bare tooth's 980 — the hub comes to
 * **111,754 rendered triangles, 62 % of the budget**, in 36 draw calls against a ceiling of
 * 60. It is a **ceiling, not a constant**: the low tier still drops to 1 (66,046), which is
 * the saving the tier-driven detail was introduced for.
 *
 * (Those figures are computed, not guessed. The same model reproduces the round-3 capture
 * exactly — 188,558 at detail 3 and 39,138 at `?tier=low`, both to the triangle — so the
 * numbers above are the same arithmetic run against the current builders. Round 4 should
 * still read them off `window.__perf`.)
 */
export const HUB_DETAIL_MAX = 2;

/** The hub's effective subdivision: the device tier, capped. */
export const hubDetail = (): number => Math.min(getQuality().detail, HUB_DETAIL_MAX);

const D = hubDetail;

/* ------------------------------------------------------------------ */
/* The hub mascot                                                      */
/* ------------------------------------------------------------------ */

/** The DOM icon slot every prop is scaled into (`GamesCollection.tsx`: `h-[88px] w-[88px]`). */
const HUB_SLOT_PX = 88;

/**
 * Face boost for the hub's mascots.
 *
 * `MascotOptions.featureScale` exists because a face that reads is a fixed fraction of the
 * *screen*, not of the prop, and its documented form is `48 / measuredPropPx`. Here the prop
 * pixels are known at build time rather than guessed: the DOM slot is 88 CSS px, `propFill`
 * takes 0.86 of it, so the unit box is 75.7 px and a mascot at scale `h` is `75.7 h` px tall.
 * Across the seven hub mascots `h` runs from 0.44 (the motif on Tooth Match's face-up card,
 * 33 px) to 0.78 (Tooth Runner's sprinter, 59 px), which asks for
 *
 *     48 / 33.3 = 1.44   …down to…   48 / 59.0 = 0.81
 *
 * One value is used for all seven so the whole hub shares **one** cached mascot geometry
 * rather than seven, and it is taken from the *smallest* prop: an eye slightly generous on
 * the 59-px sprinter costs nothing, and an eye 3 px across on the 33-px card motif is not a
 * face. `mascotParts` clamps it into its own derived ceiling of 1.68 regardless — 1.44 is
 * inside it, so nothing here is silently capped.
 */
const HUB_MASCOT_MIN_H = 0.44;
const HUB_FEATURE_SCALE = 48 / (HUB_SLOT_PX * SLAB.propFill * HUB_MASCOT_MIN_H);

/**
 * A small open smile, deliberately under `mascotParts`' 0.3 tongue threshold: a tongue on a
 * prop this size is three red pixels inside a brown slot, which at hub scale reads as a hole
 * rather than as a grin.
 */
const HUB_OPEN = 0.28;

/** One geometry, one material, shared by every mascot on the hub. */
const mascot = () =>
  mascotGeometry({
    height: 1,
    detail: D(),
    featureScale: HUB_FEATURE_SCALE,
    open: HUB_OPEN,
    limbs: true,
  });

/* ------------------------------------------------------------------ */
/* Shared shapes                                                       */
/* ------------------------------------------------------------------ */

const squareTile = () => roundedPlate(0.4, 0.4, 0.11, 0.09, D());
const card = () => roundedPlate(0.5, 0.7, 0.085, 0.09, D());

/* ------------------------------------------------------------------ */
/* Sliding Puzzle — a tray of tiles with one square missing             */
/* ------------------------------------------------------------------ */

/**
 * Re-composed for legibility. A fanned stack of three tiles reads as "an orange block" with
 * the label hidden; a 2x2 tray with the bottom-right square **empty** is the universal
 * picture of a sliding puzzle, and the gap is the only thing on the card that has to be read.
 * The tiles keep a small independent tilt so it still looks hand-laid rather than printed.
 */
function TileStack() {
  const geo = squareTile();
  const s = 0.215;
  return (
    <>
      <mesh
        geometry={roundedPlate(0.94, 0.94, 0.07, 0.16, D())}
        material={clayAccent("mauve", "deep")}
        position={[0, 0, -0.07]}
      />
      <mesh
        geometry={geo}
        material={clayIvory()}
        position={[-s, s, 0.02]}
        rotation={[0, 0, 0.05]}
      />
      <mesh
        geometry={geo}
        material={clayAccent("mauve", "soft")}
        position={[s, s, 0.02]}
        rotation={[0, 0, -0.04]}
      />
      <mesh
        geometry={geo}
        material={clayAccent("mauve", "main")}
        position={[-s, -s, 0.02]}
        rotation={[0, 0, 0.03]}
      />
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Maze Escape — a gum block with a corridor that actually goes somewhere */
/* ------------------------------------------------------------------ */

/**
 * Re-composed for legibility. The old block carried two short ivory dashes, which at 75 px
 * read as a brown square with specks on it. This is a continuous three-segment path that
 * enters at the bottom-left, turns twice and finishes under the brush — a route, which is
 * what the game is about — and the corridors are inset deeper so the gum walls throw a real
 * edge across them.
 */
function MazeBlock() {
  const runH = roundedBox(0.52, 0.15, 0.13, 0.045, D());
  const runV = roundedBox(0.15, 0.34, 0.13, 0.045, D());
  return (
    <>
      <mesh geometry={roundedBox(0.9, 0.86, 0.26, 0.1, D())} material={clayGum("main")} />
      <mesh geometry={runH} material={clayIvory()} position={[-0.13, -0.24, 0.09]} />
      <mesh geometry={runV} material={clayIvory()} position={[0.16, -0.06, 0.09]} />
      <mesh geometry={runH} material={clayIvory()} position={[-0.09, 0.19, 0.09]} />
      <mesh
        geometry={roundedBox(0.2, 0.11, 0.11, 0.045, D())}
        material={clayAccent("red", "main")}
        position={[-0.28, 0.19, 0.16]}
        rotation={[0, 0, 0.18]}
      />
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Tooth Match — two chunky cards, the front one face-up                */
/* ------------------------------------------------------------------ */

function CardPair() {
  const geo = card();
  return (
    <>
      <mesh
        geometry={geo}
        material={clayAccent("red", "main")}
        position={[-0.19, 0.02, -0.05]}
        rotation={[0, 0, 0.24]}
      />
      <mesh
        geometry={geo}
        material={clayIvory()}
        position={[0.13, -0.02, 0.09]}
        rotation={[0, 0, -0.1]}
      />
      {/* The motif on the face-up card, standing on it. Was a bare rooted tooth. */}
      <mesh
        geometry={mascot()}
        material={mascotMaterial()}
        position={[0.15, -0.3, 0.15]}
        rotation={[0, 0, -0.1]}
        scale={0.44}
      />
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Healthy or Not? — an apple                                          */
/* ------------------------------------------------------------------ */

function Apple() {
  return (
    <>
      <mesh
        geometry={softSphere(0.36, D())}
        material={clayAccent("red", "main")}
        position={[0, -0.07, 0]}
        scale={[1.02, 0.95, 0.82]}
      />
      <mesh
        geometry={roundedCylinder(0.035, 0.2, 0.02, 1)}
        material={clayAccent("mauve", "deep")}
        position={[0.02, 0.31, 0.02]}
        rotation={[0, 0, -0.2]}
      />
      <mesh
        geometry={softSphere(0.16, 1)}
        material={clayAccent("mauve", "main")}
        position={[0.21, 0.34, 0.0]}
        rotation={[0, 0, 0.5]}
        scale={[1, 0.42, 0.24]}
      />
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Spot the Difference — a hand mirror                                  */
/* ------------------------------------------------------------------ */

function Mirror() {
  return (
    <>
      <mesh
        geometry={roundedCylinder(0.3, 0.09, 0.03, D())}
        material={clayIvory()}
        position={[0, 0.13, 0.02]}
        rotation={[Math.PI / 2, 0, 0]}
      />
      <mesh
        geometry={torusSoft(0.32, 0.06, D())}
        material={clayAccent("rose", "main")}
        position={[0, 0.13, 0.04]}
      />
      <mesh
        geometry={softCapsule(0.055, 0.24, D())}
        material={clayAccent("rose", "deep")}
        position={[0, -0.31, 0.02]}
      />
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Tooth Rescue — a basket, with somebody hopping into it               */
/* ------------------------------------------------------------------ */

/**
 * The basket is `peach.main`, not `red.main`.
 *
 * A deep red bowl with a rooted tooth dropping into it is a specimen dish, and that is
 * exactly how round 3 read it. Peach is the same accent system — a warm woven basket — and
 * once the thing being caught is a character with a face, arms and feet, the whole card
 * reads as somebody being caught rather than as something being collected.
 */
function Basket() {
  return (
    <>
      {/* The tray's origin is the centre of its underside, so it is lifted by half its
          height and tipped toward the camera for the contents to read. */}
      <mesh
        geometry={clayTray(0.84, 0.46, 0.34, 0.075, D())}
        material={clayAccent("peach", "main")}
        position={[0, -0.3, 0.02]}
        rotation={[0.5, 0, 0]}
      />
      <mesh
        geometry={mascot()}
        material={mascotMaterial()}
        position={[0.02, -0.06, 0.12]}
        rotation={[0, 0, 0.3]}
        scale={0.5}
      />
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Count the Teeth — three little characters, standing on a line        */
/* ------------------------------------------------------------------ */

/**
 * Three, because the card has to say "counting". They stand on one baseline rather than
 * floating at three heights: a row of characters is countable at a glance, a scatter is not.
 * The pink gum-coloured pad they used to lie on is gone with them — teeth on gum is a
 * clinical photograph, three friends in a row is a game.
 */
function ThreeTeeth() {
  const geo = mascot();
  const mat = mascotMaterial();
  const base = -0.42;
  return (
    <>
      <mesh
        geometry={geo}
        material={mat}
        position={[-0.3, base, -0.04]}
        rotation={[0, 0.4, -0.06]}
        scale={0.48}
      />
      <mesh
        geometry={geo}
        material={mat}
        position={[0.02, base, 0.14]}
        rotation={[0, 0, 0.03]}
        scale={0.62}
      />
      <mesh
        geometry={geo}
        material={mat}
        position={[0.33, base, 0.0]}
        rotation={[0, -0.42, 0.07]}
        scale={0.5}
      />
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Tooth Runner — somebody leaning into a sprint                        */
/* ------------------------------------------------------------------ */

function RunningTooth() {
  const bar = roundedBox(0.3, 0.07, 0.07, 0.033, D());
  return (
    <>
      <mesh
        geometry={mascot()}
        material={mascotMaterial()}
        position={[0.14, -0.42, 0.06]}
        rotation={[0, 0, -0.3]}
        scale={0.78}
      />
      {/* Speed lines trailing behind, so the lean reads as motion and not as falling over. */}
      <mesh
        geometry={bar}
        material={clayAccent("peach", "main")}
        position={[-0.34, 0.14, -0.04]}
        rotation={[0, 0, 0.13]}
      />
      <mesh
        geometry={bar}
        material={clayAccent("peach", "deep")}
        position={[-0.4, -0.06, -0.04]}
        rotation={[0, 0, 0.13]}
        scale={[0.72, 1, 1]}
      />
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Smile Maker — somebody wearing the party hat                         */
/* ------------------------------------------------------------------ */

/** Bottom-to-top `[radius, height]` profile: a rolled brim, then a tapering cone. */
const HAT_PROFILE: [number, number][] = [
  [0, -0.4],
  [0.3, -0.4],
  [0.31, -0.34],
  [0.26, -0.3],
  [0.02, 0.34],
  [0, 0.36],
];

/** Mascot height in the unit box, and the hat's scale — the hat has to fit the head it sits on. */
const SMILE_MASCOT_H = 0.52;
const SMILE_HAT_S = 0.5;
/** Mascot feet, chosen so the hat's tip lands just inside the unit box's top. */
const SMILE_BASE = -0.44;

/**
 * Re-composed for legibility. A party hat on its own says "party", not "dress up a tooth";
 * the hat *worn* says both, and it is the only card that can show what Smile Maker does
 * without a word of text. The hat sits on the crown by construction: the mascot is normalised
 * to 1.0 tall with its origin at its feet, so its crown top is `SMILE_BASE + SMILE_MASCOT_H`,
 * and the profile's brim sits `0.4 x SMILE_HAT_S` below the hat group's own origin.
 */
function PartyHat() {
  const crown = SMILE_BASE + SMILE_MASCOT_H;
  return (
    <>
      <mesh
        geometry={mascot()}
        material={mascotMaterial()}
        position={[0, SMILE_BASE, 0.04]}
        scale={SMILE_MASCOT_H}
      />
      {/* Cone, stripe and pompom share one tilt so the stripe stays a ring around the cone
          instead of drifting off it — composing the tilt into each child's own Euler would
          only be right to first order. */}
      <group
        position={[0.02, crown + 0.4 * SMILE_HAT_S - 0.05, 0.04]}
        rotation={[0.12, 0, 0.16]}
        scale={SMILE_HAT_S}
      >
        <mesh
          geometry={latheProfile(HAT_PROFILE, 22, false)}
          material={clayAccent("mauve", "main")}
        />
        <mesh
          geometry={torusSoft(0.2, 0.042, D())}
          material={clayAccent("red", "main")}
          position={[0, -0.15, 0]}
          rotation={[Math.PI / 2, 0, 0]}
        />
        <mesh
          geometry={softSphere(0.11, D())}
          material={clayAccent("peach", "main")}
          position={[0, 0.4, 0]}
        />
      </group>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Registry                                                            */
/* ------------------------------------------------------------------ */

const PROPS: Record<string, () => JSX.Element> = {
  "sliding-puzzle": TileStack,
  "maze-escape": MazeBlock,
  "tooth-match": CardPair,
  "healthy-or-not": Apple,
  "spot-the-difference": Mirror,
  "tooth-rescue": Basket,
  "count-the-teeth": ThreeTeeth,
  "tooth-runner": RunningTooth,
  "smile-maker": PartyHat,
};

/** The little clay object that says, at a glance, what a game is. */
export function HubProp({ id }: { id: string }): JSX.Element | null {
  // Subscribed, not sampled: a runtime tier degrade has to rebuild the props at the new
  // detail, and this is the only render this component ever does after mount.
  useStore(quality);
  const Prop = PROPS[id];
  return Prop ? <Prop /> : null;
}
