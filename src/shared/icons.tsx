/**
 * The chrome's glyphs.
 *
 * ## Why these are not hairlines any more (A21)
 *
 * The chips and buttons they sit on are good: neumorphic clay pills on `#faf6ee`, warm
 * `rgba(64,54,42,…)` occlusion, warm-white inset highlight, inside the page's own value
 * range. The glyphs on them were 2.4-unit strokes on a 24-unit grid — 1.7 device pixels at
 * the 17 px the HUD chips actually render them — so in a product whose first paragraph is
 * "there is no hard edge anywhere", every piece of chrome furniture was made of the thinnest
 * possible hard edges.
 *
 * Two rules, applied to all ten:
 *
 *  1. **Anything that encloses is a fill.** The clock dial, the trophy cup, the speaker
 *     waves and the restart arrowhead are areas now, not outlines, so they carry the same
 *     optical weight as the clay they sit on.
 *  2. **Anything that is a bar stays a stroke, at 3.4 with round caps and round joins.** A
 *     round-capped stroke is exactly a swept stadium: every terminal is a semicircle and
 *     every corner a fillet, so it has no hard edge to give away, and 3.4/24 lands at 2.4
 *     device pixels on a chip instead of 1.7. Authoring those as explicit `<path fill>`
 *     outlines would produce the identical rasterisation and four times the path data.
 *
 * `currentColor` throughout, 24-unit grid throughout, so nothing at a call site changes.
 */

type IconProps = { className?: string; style?: React.CSSProperties };

/** Bars: swept stadiums. See rule 2 above. */
const bar = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 3.4,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

/** Areas: no stroke at all, so there is no outline to go thin. */
const area = { fill: "currentColor", stroke: "none" } as const;

/** The speaker body, shared by both sound states. */
const CONE = "M11 4.6 6.3 8.3H3.6a1 1 0 0 0-1 1v5.4a1 1 0 0 0 1 1h2.7L11 19.4Z";

export const SoundOnIcon = ({ className, style }: IconProps) => (
  <svg viewBox="0 0 24 24" className={className} style={style} aria-hidden>
    <path d={CONE} {...area} />
    {/*
      The two waves are filled crescents — an outer arc and an inner arc closed at both
      ends — rather than 2.4-unit arcs. Same silhouette, ~1.7 units of real area each.
    */}
    <path
      d="M14.4 8.6a5.2 5.2 0 0 1 0 6.8l-1.7-1.4a3 3 0 0 0 0-4Z"
      {...area}
    />
    <path
      d="M17.1 5.9a9 9 0 0 1 0 12.2l-1.7-1.4a6.8 6.8 0 0 0 0-9.4Z"
      {...area}
    />
  </svg>
);

export const SoundOffIcon = ({ className, style }: IconProps) => (
  <svg viewBox="0 0 24 24" className={className} style={style} aria-hidden>
    <path d={CONE} {...area} />
    <g {...bar}>
      <path d="m15.2 9.6 4.6 4.8" />
      <path d="M19.8 9.6l-4.6 4.8" />
    </g>
  </svg>
);

export const RestartIcon = ({ className, style }: IconProps) => (
  <svg viewBox="0 0 24 24" className={className} style={style} aria-hidden>
    {/* The sweep: a fat round-capped arc, open at the eight-o'clock position. */}
    <path d="M4.9 12.4A7.2 7.2 0 1 1 7.3 17.6" {...bar} />
    {/* The head: a filled rounded wedge, not two meeting strokes with a mitre at the elbow. */}
    <path
      d="M3.6 11.2a1.3 1.3 0 0 1 1.9-.6l4.6 3a1.3 1.3 0 0 1-.2 2.3l-5 2a1.3 1.3 0 0 1-1.8-1.3Z"
      {...area}
    />
  </svg>
);

export const BackIcon = ({ className, style }: IconProps) => (
  <svg viewBox="0 0 24 24" className={className} style={style} aria-hidden>
    <path d="M14.6 5.6 8.4 12l6.2 6.4" {...bar} />
  </svg>
);

export const TrophyIcon = ({ className, style }: IconProps) => (
  <svg viewBox="0 0 24 24" className={className} style={style} aria-hidden>
    {/* Cup, stem and foot as one filled body — the cup was an outline with a 2.4 rim. */}
    <path
      d="M7.6 3.6h8.8a1 1 0 0 1 1 1v5.1a5.4 5.4 0 0 1-3.6 5.1v1.9h2a1.3 1.3 0 0 1 0 2.6H8.2a1.3 1.3 0 0 1 0-2.6h2v-1.9A5.4 5.4 0 0 1 6.6 9.7V4.6a1 1 0 0 1 1-1Z"
      {...area}
    />
    {/* Handles: crescents, so they read at chip size instead of dropping out. */}
    <path d="M6.3 5.2v2.5a2.6 2.6 0 0 0 1.7 2.4v2.3A4.9 4.9 0 0 1 4 7.7V5.2Z" {...area} />
    <path d="M17.7 5.2v2.5a2.6 2.6 0 0 1-1.7 2.4v2.3A4.9 4.9 0 0 0 20 7.7V5.2Z" {...area} />
  </svg>
);

export const SwitchIcon = ({ className, style }: IconProps) => (
  <svg viewBox="0 0 24 24" className={className} style={style} aria-hidden>
    <g {...bar}>
      <path d="M15.8 4.6 19.4 8.1 15.8 11.6" />
      <path d="M19.4 8.1H8.6" />
      <path d="M8.2 12.6 4.6 16.1 8.2 19.6" />
      <path d="M4.6 16.1h10.8" />
    </g>
  </svg>
);

export const StarIcon = ({
  className,
  style,
  filled = true,
}: IconProps & { filled?: boolean }) => (
  <svg
    viewBox="0 0 24 24"
    className={className}
    style={style}
    fill={filled ? "currentColor" : "none"}
    stroke="currentColor"
    strokeWidth={filled ? 0 : 3.4}
    strokeLinejoin="round"
    strokeLinecap="round"
    aria-hidden
  >
    <path d="M12 3.2 14.6 8.6 20.5 9.4 16.2 13.5 17.3 19.4 12 16.5 6.7 19.4 7.8 13.5 3.5 9.4 9.4 8.6 Z" />
  </svg>
);

export const SparkleIcon = ({ className, style }: IconProps) => (
  <svg viewBox="0 0 24 24" className={className} style={style} fill="currentColor" aria-hidden>
    <path d="M12 2.5c.9 5 2.6 6.7 7.5 7.5-4.9.8-6.6 2.5-7.5 7.5-.9-5-2.6-6.7-7.5-7.5 4.9-.8 6.6-2.5 7.5-7.5Z" />
    <path d="M19 15c.4 2.2 1.1 2.9 3 3.2-1.9.3-2.6 1-3 3.2-.4-2.2-1.1-2.9-3-3.2 1.9-.3 2.6-1 3-3.2Z" opacity={0.7} />
  </svg>
);

export const ClockIcon = ({ className, style }: IconProps) => (
  <svg viewBox="0 0 24 24" className={className} style={style} aria-hidden>
    {/*
      The dial is a filled annulus (`fill-rule: evenodd`, outer r 9.4, inner r 6.2), i.e. a
      3.2-unit-thick ring of real area. It was a 2.4-unit `<circle>` stroke, which on the
      17 px HUD chip resolved to 1.7 device pixels of hairline.
    */}
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M12 2.6a9.4 9.4 0 1 0 0 18.8 9.4 9.4 0 0 0 0-18.8Zm0 3.2a6.2 6.2 0 1 1 0 12.4 6.2 6.2 0 0 1 0-12.4Z"
      {...area}
    />
    <path d="M12 8.2V12l2.5 2.1" fill="none" stroke="currentColor" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const CheckIcon = ({ className, style }: IconProps) => (
  <svg viewBox="0 0 24 24" className={className} style={style} aria-hidden>
    <path d="m5 12.6 4.6 4.6L19.2 7.4" {...bar} />
  </svg>
);
