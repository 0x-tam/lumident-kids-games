/**
 * Lumident 3D brand tokens.
 *
 * Everything visual in the 3D layer derives from here. Colours are declared as sRGB hex
 * strings exactly as they appear in `src/index.css`; three's ColorManagement converts
 * them to linear on assignment, so never pre-convert by hand.
 */
import { Color } from "three";

/** 1 world unit = 10 cm. A hero tooth prop is ~1.0 unit tall. */
export const UNIT = 1;

export type AccentFamily = "red" | "coral" | "peach" | "rose" | "mauve";
export type AccentTone = "soft" | "main" | "deep";

/** The five departmental accent families, mirroring the CSS tokens 1:1. */
export const ACCENTS: Record<AccentFamily, Record<AccentTone, string>> = {
  red: { soft: "#f7d9dc", main: "#e8474f", deep: "#c21e25" },
  coral: { soft: "#fae1d9", main: "#e8604c", deep: "#c74430" },
  peach: { soft: "#f8ead9", main: "#efa160", deep: "#c97a34" },
  rose: { soft: "#f2c6cb", main: "#cf4a55", deep: "#b2343f" },
  mauve: { soft: "#efdfda", main: "#c08475", deep: "#9c6355" },
};

/**
 * Neutrals — page, surfaces, ink. Identical to the CSS tokens in `src/index.css`, and
 * `assertTokensMatchCSS()` below now *proves* it on every dev boot instead of claiming it.
 *
 * `inkMid` and `inkSoft` were the reason that claim needed proving. The CSS moved both for
 * WCAG — `#6b675f` and `#8f897d` measured 2.82:1 against the page, failing AA on all eleven
 * of `ink-soft`'s usages — and recorded the fix in its own comment; this file kept the
 * abandoned values. Nothing in the 3D layer read them yet, so it was a landmine rather than a
 * live bug: the first in-world label reaching for `NEUTRAL.inkSoft` would have shipped a
 * 2.8:1 failure with a comment overhead saying the two files agreed.
 */
export const NEUTRAL = {
  page: "#ede7dc",
  surface: "#faf6ee",
  well: "#e3dccd",
  line: "#d9d2c2",
  ink: "#2f3237",
  inkMid: "#575349",
  inkSoft: "#67635a",
} as const;

/**
 * Clay body colours. Ivory is the hero material: a warm off-white that must never read
 * as chalk. `sss` is the colour light picks up travelling through the thin parts.
 */
export const CLAY = {
  ivory: "#fbf6ec",
  ivoryDeep: "#eadfcd",
  /** Warm back-scatter tint for the fake subsurface term. */
  sss: "#e9a389",
  enamel: "#fdfaf3",
  enamelShadow: "#e6dccb",
  gum: "#e8604c",
  gumDeep: "#c74430",
  gumSoft: "#f0806e",
  /** Warm crevice colour used by the curvature-AO term. */
  crevice: "#8a6a58",
  /** Slight lightening on worn, exposed edges. */
  wear: "#fffaf1",
  /**
   * What the indirect lobe is multiplied by where the key is fully blocked. A shadow on
   * cream is filled only by the environment, and the environment is the cool half of this
   * studio — so without this a cream-on-cream shadow lands lavender-grey, which is exactly
   * the "3D viewport" tell `3D-SPEC §2` forbids.
   *
   * **Derived from the shipped frame, not chosen** — round 4 measured the shadow this used
   * to produce and found it grey: on `healthy-or-not-rest.png` the lit floor reads
   * `C 6.55 h 90.1` and its cast shadow `C 6.47 h 93.9`, i.e. chroma unchanged and hue
   * rotated *away* from red. Two things were wrong and both are fixed:
   *
   *  1. `materials.ts`' capture divided by nothing, so `gClayShadow` topped out at
   *     `shadowIntensity` (0.52) and only half of this tint was ever applied. It is now the
   *     geometric occlusion, 0..1.
   *  2. The value itself was far too weak to beat the mechanism it fights. The direct term
   *     it replaces is `KEY_LIGHT.color` — `#FFF0DC`, linear `(1.00, 0.87, 0.72)` — carrying
   *     **68 %** of the light on the lit floor (measured, by decomposing the lit and shadowed
   *     pixels of that same frame). Removing 52 % of a strongly warm light *cools* what is
   *     left; a 6 %/14 %/28 % pullback on the 32 % that remains cannot turn that around.
   *
   * Solved against the decomposition rather than dialled (`scratchpad/shadowtint.mjs`), the
   * value below puts the umbra at `L* 76.8, C 9.33, h 77.8` against a lit floor of
   * `L* 92.2, C 6.27, h 90.2` — 49 % *more* chroma than the surface it falls on and 12.4°
   * **toward** red, at the same darkness the shipped frame already had. A shadow that warms
   * and deepens, which is what a bounce card under a warm key physically does.
   */
  shadowTint: "#f9e1d0",
} as const;

/**
 * Studio environment description — consumed by `env.ts` to build the PMREM in code.
 *
 * **The single most important number in this file is `skyIntensity`.** A code-built studio
 * naturally comes out as a near-white dome, and a near-white dome is uniform irradiance:
 * every normal on a prop receives the same light, the key light becomes a rounding error on
 * top of it, and a sphere renders as a flat disc. The sky here is therefore a *dim* warm
 * ambient (about a fifth of the panel brightness) whose job is to keep shadow sides warm and
 * coloured — never to light the prop. The modelling comes from the key softbox and the
 * `directionalLight` that shares its direction.
 *
 * Calibration anchor: with these values the `clayGround` plane (albedo `NEUTRAL.page`,
 * facing up under the key) renders back to ≈ `#EDE7DC` after NeutralToneMapping at
 * `TONE.exposure`, so the canvas melts into the DOM page. Change any of these and re-check
 * that pixel before shipping — it is what stops the whole product drifting bright or dark.
 */
export const STUDIO = {
  /** Big warm key softbox, upper-left. Carries the env's directionality. */
  key: { color: "#fff1de", intensity: 3.1, position: [-3.4, 4.6, 3.2] as const, size: [4.4, 3.2] as const },
  /** Cream bounce card below — the ground return that keeps shadows warm, never black. */
  bounce: { color: "#f6ead6", intensity: 0.95, position: [0.4, -2.6, 1.6] as const, size: [7, 5] as const },
  /**
   * Cool-ish rim strip behind-right, separates silhouettes from the cream page — and it is
   * the only cool light in the studio, which makes it the white-balance control. Every other
   * emitter here is warm and every albedo in the product is warm too; warm light on warm clay
   * multiplies into jaundice, and the cream floor stops matching `#EDE7DC`. Raising the rim
   * pulls the composite illuminant back toward neutral without taking a single degree of
   * warmth out of the key, which is where the warmth is supposed to come from.
   */
  rim: { color: "#dce7f0", intensity: 3.4, position: [3.6, 2.1, -3.4] as const, size: [3.0, 2.2] as const },
  /**
   * Gradient sky — the ambient dome, and the *cool* half of a warm-key/cool-fill studio.
   *
   * It is the widest-area emitter here, so its tint lands on every surface at every
   * orientation. Warm sky + warm key + warm clay albedo multiplies into jaundice: measured,
   * a fully warm studio rendered the `#EDE7DC` page cream as `#E9D9C1`, twenty-seven points
   * of blue short of the brand. Cooling the dome (and only the dome — the key softbox, the
   * bounce card and the `directionalLight` all stay warm) restores the brand cream, and the
   * warm/cool split between key and fill is what gives a clay form its coloured terminator
   * instead of a grey one.
   */
  skyTop: "#eef1f3",
  skyBottom: "#e8e5df",
  /**
   * Scalar on the sky dome only, applied in `env.ts`. Keeps the *hue* of the two sky
   * tokens (they are the brand cream) while dropping the *level* far enough that the dome
   * reads as fill rather than as a floodlight.
   */
  skyIntensity: 0.34,
  /** Applied to `scene.environment`. */
  envIntensity: 0.9,
} as const;

/** The single key light. Everything else is environment + bounce. */
export const KEY_LIGHT = {
  color: "#fff0dc",
  /**
   * The key now carries the form. It is roughly 60% of the light on an up-facing surface;
   * the environment supplies the other 40% as warm fill. Below ~2.2 the terminator washes
   * out under the env; above ~2.7 ivory clips into the tone-map shoulder and goes chalk.
   */
  intensity: 2.6,
  /** Direction the light comes *from*, in world units, scaled per scene. */
  position: [-4, 7, 5] as const,
  shadowBias: -0.0004,
  /**
   * Normal bias is measured in world units and pushes the shadow lookup *off* the surface —
   * it is the classic cause of a contact shadow that floats away from the thing casting it.
   * 0.02 units is nearly two texels at a 12-unit frustum on a 1024 map, which detached every
   * prop in the product from its own shadow. 0.006 still kills acne on the bevels.
   */
  shadowNormalBias: 0.006,
  shadowRadius: 4,
  /**
   * How much of the key a cast shadow is allowed to take away, `0..1`, fed straight to
   * `DirectionalLightShadow.intensity`.
   *
   * At the stock 1.0 a shadowed cream surface keeps nothing but the environment, and round 2
   * measured what that looks like on a cream page: the hub gutter fell **38 L\*** below the
   * lit ground and then held one byte for 900 px — an occlusion slab, not a shadow. This is a
   * warm studio with a bounce card, and in a warm studio a shadow on cream is filled by
   * bounce off the lit cream around it; it is a *tint and a deepening*, not a hole.
   *
   * The number is derived, not dialled. With the key carrying ~60% of the light on an
   * up-facing surface, the measured shadowed/lit ratio at intensity 1 was 0.58, so
   * `ratio(i) = 0.58 + 0.42 * (1 - i)`. The look target the audit set is 0.78–0.85, i.e. a
   * shadow that removes a fifth of the light rather than half of it; `i = 0.52` lands at
   * **0.80**. It also halves the value step between the 17-tap PCF kernel's plateaus, which
   * is what made the terminator read as banding rather than as a penumbra.
   */
  shadowIntensity: 0.52,
} as const;

/** Long-lens miniature look. Per-game fov overrides must stay inside FOV_RANGE. */
export const CAMERA = {
  fov: 28,
  fovRange: [26, 32] as const,
  near: 1,
  far: 60,
} as const;

/** Cream fog — depth separation without grey haze. */
export const FOG = { color: NEUTRAL.page, density: 0.014 } as const;

export const TONE = { exposure: 1.05 } as const;

/** Pre-built Color instances for hot paths (never allocate a Color inside useFrame). */
const colorCache = new Map<string, Color>();
export const color = (hex: string): Color => {
  let c = colorCache.get(hex);
  if (!c) {
    c = new Color(hex);
    colorCache.set(hex, c);
  }
  return c;
};

/** Accent lookup helper used by materials + hub cards. */
export const accent = (family: AccentFamily, tone: AccentTone = "main") => ACCENTS[family][tone];

/* ------------------------------------------------------------------ */
/* "This scene is that game's colour" — measurable, not asserted        */
/* ------------------------------------------------------------------ */

/**
 * Hue angle in CIE Lab, and chroma, for a colour. Enough to answer "which accent family is
 * this nearest" without dragging a full colour-difference implementation into a token file.
 */
function labHueChroma(hex: string): { L: number; C: number; h: number } {
  const c = color(hex);
  // `Color` holds linear-sRGB after ColorManagement; that is what the matrix below wants.
  const X = c.r * 0.4124564 + c.g * 0.3575761 + c.b * 0.1804375;
  const Y = c.r * 0.2126729 + c.g * 0.7151522 + c.b * 0.072175;
  const Z = c.r * 0.0193339 + c.g * 0.119192 + c.b * 0.9503041;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
  const fx = f(X / 0.95047);
  const fy = f(Y);
  const fz = f(Z / 1.08883);
  const a = 500 * (fx - fy);
  const b = 200 * (fy - fz);
  return { L: 116 * fy - 16, C: Math.hypot(a, b), h: ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360 };
}

/** Every family's three tones, pre-measured once. */
const FAMILY_HUES: ReadonlyArray<readonly [AccentFamily, number]> = (
  Object.keys(ACCENTS) as AccentFamily[]
).flatMap((f) =>
  (["soft", "main", "deep"] as AccentTone[]).map((t) => [f, labHueChroma(ACCENTS[f][t]).h] as const)
);

/**
 * Chroma below which a colour is a neutral, not an accent. `3D-SPEC §1.2`'s five families are
 * all well above it; the cream, the ink and the clay ivories are all well below.
 *
 * 25 is the audit's own threshold — round 4's A15 classified "every saturated pixel
 * (C\* > 25) in each play area to its nearest family token" — kept identical so a dev-time
 * check and the next audit are measuring the same population.
 */
export const ACCENT_CHROMA_FLOOR = 25;

/**
 * Which of the five families a colour belongs to, by nearest hue among the fifteen tones.
 * `null` for anything under `ACCENT_CHROMA_FLOOR` — a neutral has no family, and forcing one
 * on it is how a cream highlight gets counted as "peach".
 *
 * Verified with `scratchpad/accents.mjs`: all ten `main`/`deep` tones classify to their own
 * family, and all five `soft` tones return `null` — they are pale tints sitting at C\* 9-19,
 * under the floor, which is the right answer and the same answer the auditor's pixel
 * classification gives them.
 */
export function classifyAccent(hex: string): AccentFamily | null {
  const { C, h } = labHueChroma(hex);
  if (C < ACCENT_CHROMA_FLOOR) return null;
  let best: AccentFamily | null = null;
  let bestD = Infinity;
  for (const [family, fh] of FAMILY_HUES) {
    const d = Math.abs(((h - fh + 540) % 360) - 180);
    if (d < bestD) {
      bestD = d;
      best = family;
    }
  }
  return best;
}

/** What `auditSceneAccents` found: a family histogram over the saturated colours it was given. */
export type AccentAudit = {
  /** Colours at or above `ACCENT_CHROMA_FLOOR`. Zero means nothing to judge. */
  saturated: number;
  /** Fraction of `saturated` nearest each family, 0..1. */
  share: Record<AccentFamily, number>;
  /** The family with the largest share, or null when nothing was saturated. */
  dominant: AccentFamily | null;
  /** True when `dominant` is the family the registry says this game is. */
  matchesRegistry: boolean;
};

/**
 * **The shared half of round 4's A15, and the contract the nine scenes owe it.**
 *
 * A15 measured the five families against `GAMES[id].accent` and found four scenes
 * contradicting their own registry entry inside a single frame: Healthy or Not? is registered
 * `peach` and **0.1 %** of its saturated pixels are nearest peach (mauve 64.3, red 21.6);
 * Count the Teeth is registered `coral` and is 75.0 % red; Tooth Rescue is registered `red`
 * and is 76.9 % coral; Spot the Difference is registered `rose` at 23.3 % against a dominant
 * peach at 40.9. The CSS chrome reads the registry correctly, so a child sees a coral
 * difficulty pill 250 px above a red mat.
 *
 * The cause is a literal hex in a scene file, and the fix is one line per scene — pull the
 * hero colour from `accent(GAMES[id].accent, tone)` — which is the scene owners' change, not
 * this file's. What this file owes them is a way to *prove* it afterwards instead of asserting
 * it, measured the same way the auditor measured it. Call it in DEV with every hex a scene
 * builds a material from:
 *
 * ```ts
 * if (import.meta.env.DEV) {
 *   const report = auditSceneAccents(SCENE_HEXES, GAMES["tooth-rescue"].accent);
 *   if (!report.matchesRegistry) console.error(...);
 * }
 * ```
 *
 * It deliberately takes the family as an argument rather than importing `GAMES`:
 * `src/games/index.ts` imports the scenes, and the scenes import this file.
 */
export function auditSceneAccents(hexes: readonly string[], registered: AccentFamily): AccentAudit {
  const counts: Record<AccentFamily, number> = { red: 0, coral: 0, peach: 0, rose: 0, mauve: 0 };
  let saturated = 0;
  for (const hex of hexes) {
    const family = classifyAccent(hex);
    if (family === null) continue;
    counts[family]++;
    saturated++;
  }
  const share: Record<AccentFamily, number> = { red: 0, coral: 0, peach: 0, rose: 0, mauve: 0 };
  let dominant: AccentFamily | null = null;
  let bestShare = 0;
  for (const family of Object.keys(counts) as AccentFamily[]) {
    share[family] = saturated === 0 ? 0 : counts[family] / saturated;
    if (counts[family] > bestShare) {
      bestShare = counts[family];
      dominant = family;
    }
  }
  return { saturated, share, dominant, matchesRegistry: dominant === registered };
}

/* ------------------------------------------------------------------ */
/* "Identical to the CSS tokens" — enforced, not asserted               */
/* ------------------------------------------------------------------ */

/** `NEUTRAL`/`ACCENTS` key -> the CSS custom property it must equal. */
const CSS_TOKEN_MAP: ReadonlyArray<readonly [string, string]> = [
  ["--color-page", NEUTRAL.page],
  ["--color-surface", NEUTRAL.surface],
  ["--color-well", NEUTRAL.well],
  ["--color-line", NEUTRAL.line],
  ["--color-ink", NEUTRAL.ink],
  ["--color-ink-mid", NEUTRAL.inkMid],
  ["--color-ink-soft", NEUTRAL.inkSoft],
  ...(Object.keys(ACCENTS) as AccentFamily[]).flatMap((f) =>
    (["soft", "main", "deep"] as AccentTone[]).map(
      (t) => [`--color-${f}-${t}`, ACCENTS[f][t]] as const
    )
  ),
];

/**
 * Reads the live stylesheet and reports every token whose 3D copy has drifted from its CSS
 * source. Returns the mismatches; empty means the two files agree.
 *
 * Exported so an in-page test can call it, and run automatically in dev (below) so a drift
 * cannot survive a single boot unnoticed. It has to read `getComputedStyle` rather than
 * import the CSS, because the CSS is the source of truth and Vite hands it to the browser,
 * not to the module graph.
 */
export function assertTokensMatchCSS(): { token: string; css: string; ts: string }[] {
  const bad: { token: string; css: string; ts: string }[] = [];
  if (typeof document === "undefined" || typeof getComputedStyle !== "function") return bad;
  const style = getComputedStyle(document.documentElement);
  for (const [prop, ts] of CSS_TOKEN_MAP) {
    const raw = style.getPropertyValue(prop).trim();
    // Not present at all is not a drift — a stylesheet that has not loaded yet, or a token
    // the CSS legitimately does not carry, must not be reported as a mismatch.
    if (raw === "") continue;
    // Compare through THREE.Color so `#FFF`, `#ffffff` and `rgb(255 255 255)` all normalise.
    const cssHex = `#${new Color(raw).getHexString()}`;
    if (cssHex !== ts.toLowerCase()) bad.push({ token: prop, css: cssHex, ts: ts.toLowerCase() });
  }
  return bad;
}

if (import.meta.env.DEV && typeof window !== "undefined") {
  // After the first paint: at module-evaluation time Vite has not necessarily injected the
  // stylesheet yet, and an empty read would be a false negative either way.
  window.requestAnimationFrame(() => {
    const bad = assertTokensMatchCSS();
    if (bad.length > 0) {
      console.error(
        "[lumident/tokens] the 3D brand tokens have drifted from src/index.css. The CSS is " +
          "the source of truth — 3D-SPEC §1.2 allows exactly one palette:\n" +
          bad.map((b) => `  ${b.token}: css ${b.css} vs tokens.ts ${b.ts}`).join("\n")
      );
    }
  });
}
