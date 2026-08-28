/**
 * The two rules about the product's *DOM* chrome that nobody was measuring.
 *
 * `selftest.ts`'s `hit-targets` projects 3D colliders and is thorough about them. It cannot
 * see a `<button>`, so the level pills shipped at 35 px against a 48 px floor for two
 * rounds. And `index.css`'s `@theme` block audits the ink ramp carefully, but nobody had
 * ever run `contrastRatio()` on `#ffffff` over the five accent gradients — every primary
 * button in the product was between 1.8:1 and 3.6:1 at its light stop.
 *
 * Both of those are arithmetic over values that are already in the page, so both are
 * testable without a screenshot, a device or a human. That is the whole point: *a rule
 * nobody measures is a rule that decays.*
 *
 * These read the **computed** values off real elements rather than re-declaring the
 * constants, so editing `index.css` cannot pass the test while failing the render.
 *
 * Registered from `GameShell` and from `GamesCollection`, both of which already import the
 * harness lazily under `?selftest`. Nothing here is reachable in a normal session.
 */
import { contrastRatio, registerSelfTest, type SelfTestResult } from "./selftest";

/** The five accent families `3D-SPEC §1.2` allows, in the order `index.css` declares them. */
const GRADIENT_CLASSES = ["grad-red", "grad-coral", "grad-peach", "grad-rose", "grad-mauve"];

/**
 * WCAG 2.1 AA for text that is not "large".
 *
 * Held at 4.5 for **every** `.grad-btn`, including "Play again", even though at 20 px/800 it
 * qualifies for the 3:1 large-text allowance: the same class also draws the active level
 * pill at 14 px/800, which does not, and one class cannot have two floors.
 */
const AA_TEXT = 4.5;

/** `3D-SPEC §1.5 / §8`. The same number `HitTarget` enforces for 3D colliders. */
const TAP_MIN_PX = 48;

/** `rgb(r, g, b)` / `rgba(r, g, b, a)` / `#rgb` / `#rrggbb` → `#rrggbb`. */
function toHex(value: string): string | null {
  const text = value.trim();
  if (text.startsWith("#")) return text;
  const match = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(text);
  if (!match) return null;
  const channel = (raw: string) => {
    const n = Math.round(Number.parseFloat(raw));
    const clamped = n < 0 ? 0 : n > 255 ? 255 : n;
    return clamped.toString(16).padStart(2, "0");
  };
  return `#${channel(match[1])}${channel(match[2])}${channel(match[3])}`;
}

/**
 * A `.grad-btn` of each family, laid out but never painted, so `getComputedStyle` resolves
 * the custom properties exactly as it does for the real thing.
 *
 * `visibility: hidden` rather than `display: none`: a `display: none` element still resolves
 * custom properties, but not everything else about it is honest, and this costs one layout.
 */
function withGradientProbes<T>(fn: (probe: HTMLElement, family: string) => T): T[] {
  const host = document.createElement("div");
  host.setAttribute("aria-hidden", "true");
  host.style.cssText =
    "position:fixed;left:0;top:0;width:0;height:0;overflow:hidden;visibility:hidden;pointer-events:none;";
  document.body.appendChild(host);
  try {
    return GRADIENT_CLASSES.map((family) => {
      const probe = document.createElement("button");
      probe.type = "button";
      probe.className = `grad-btn ${family}`;
      host.appendChild(probe);
      return fn(probe, family);
    });
  } finally {
    host.remove();
  }
}

type GradientRow = {
  family: string;
  ink: string;
  from: string;
  to: string;
  atFrom: number;
  atTo: number;
};

/**
 * Both stops is the whole ramp.
 *
 * `linear-gradient` interpolates each channel linearly between the stops, and WCAG's
 * per-channel transfer curve is monotone increasing, so relative luminance is monotone
 * along the ramp: no point between the two stops can be lighter than both or darker than
 * both. Checking the endpoints therefore bounds every pixel of the button, which is why
 * this test does not have to sample the gradient.
 */
function auditGradients(): GradientRow[] {
  return withGradientProbes((probe, family) => {
    const style = window.getComputedStyle(probe);
    const ink = toHex(style.color) ?? "#000000";
    const from = toHex(style.getPropertyValue("--g-from")) ?? "#ffffff";
    const to = toHex(style.getPropertyValue("--g-to")) ?? "#ffffff";
    return {
      family,
      ink,
      from,
      to,
      atFrom: contrastRatio(ink, from),
      atTo: contrastRatio(ink, to),
    };
  });
}

/**
 * Every `<button>` a child can actually put a finger on.
 *
 * Excluded, with a reason each:
 *  - anything inside `#lumident-a11y` — those are the 1 px screen-reader proxies for 3D
 *    colliders, and the colliders themselves are measured by `hit-targets`;
 *  - `disabled` and `inert` subtrees — not hittable, so not a tap target;
 *  - zero-box elements — not laid out at all (a `display: none` branch, a closed dialog).
 */
function tappableButtons(): HTMLButtonElement[] {
  const all = Array.from(document.querySelectorAll<HTMLButtonElement>("button"));
  return all.filter((el) => {
    if (el.disabled) return false;
    if (el.closest("#lumident-a11y") !== null) return false;
    if (el.closest("[inert]") !== null) return false;
    // A `display: none` branch lays out to nothing; `offsetWidth`, to match the measurement
    // below, so a control is judged on exactly the box the assertion reads.
    return el.offsetWidth > 0 && el.offsetHeight > 0;
  });
}

/**
 * `offsetWidth` / `offsetHeight`, i.e. the **layout** box.
 *
 * This is what the 48 px rule is actually about: a control's own size, independent of where
 * it happens to be in the hub → game flip. `getBoundingClientRect` would report the panel's
 * transient CSS scale (the flip starts at ~0.34) and turn a correct control into a failure
 * for the ~400 ms the entry spring is running, which would make this test noise.
 *
 * The limitation that leaves is real and is stated rather than papered over: **this does not
 * prove a target is 48 px on the glass mid-transition.** Nothing in the product measures
 * that yet; closing it needs a press-latency capture during the flip, not more arithmetic.
 */
function auditTapTargets(): { label: string; w: number; h: number }[] {
  return tappableButtons().map((el) => {
    const explicit = el.getAttribute("aria-label");
    const text = (el.textContent ?? "").trim();
    const label = explicit ?? (text.length > 0 ? text.slice(0, 24) : "(unlabelled)");
    return { label, w: el.offsetWidth, h: el.offsetHeight };
  });
}

let registered = false;

/** Idempotent — both the hub and every shell call it, and only one registration is wanted. */
export function registerChromeSelfTests(): void {
  if (registered || typeof document === "undefined") return;
  registered = true;

  registerSelfTest("chrome-contrast", (): SelfTestResult => {
    const rows = auditGradients();
    const failing = rows.filter((r) => r.atFrom < AA_TEXT || r.atTo < AA_TEXT);
    const worst = rows.reduce(
      (lo, r) => Math.min(lo, r.atFrom, r.atTo),
      Number.POSITIVE_INFINITY
    );
    return {
      name: "chrome-contrast",
      pass: rows.length === GRADIENT_CLASSES.length && failing.length === 0,
      detail:
        failing.length === 0
          ? `${rows.length} accent gradients, label vs both stops, worst ${worst.toFixed(2)}:1 against ${AA_TEXT}`
          : failing
              .map(
                (r) =>
                  `${r.family}: ${r.ink} on ${r.from} ${r.atFrom.toFixed(2)}:1, on ${r.to} ${r.atTo.toFixed(2)}:1`
              )
              .join(" · "),
      data: { need: AA_TEXT, rows },
    };
  });

  registerSelfTest("dom-hit-targets", (): SelfTestResult => {
    const rows = auditTapTargets();
    const undersized = rows.filter((r) => r.w < TAP_MIN_PX || r.h < TAP_MIN_PX);
    return {
      name: "dom-hit-targets",
      pass: rows.length > 0 && undersized.length === 0,
      detail:
        rows.length === 0
          ? "no tappable buttons in the document — nothing asserted, which is itself wrong"
          : undersized.length === 0
            ? `${rows.length} buttons, all >= ${TAP_MIN_PX}px in both axes`
            : undersized
                .map((r) => `"${r.label}" ${r.w.toFixed(0)}x${r.h.toFixed(0)}`)
                .join(" · "),
      data: { need: TAP_MIN_PX, total: rows.length, undersized },
    };
  });
}
