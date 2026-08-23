import type { SVGProps } from "react";

/**
 * The client's single inline-SVG primitive (#810, follow-up to #772).
 *
 * Before this existed, every icon in the client was hand-written heroicons boilerplate —
 * `<svg xmlns=… className=… fill="none" viewBox="0 0 24 24" stroke="currentColor"
 * strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d=… /></svg>` — repeated
 * at ~350 sites. That wrapper is ~15 tokens of pure ceremony, which is exactly the window the
 * duplication scanner measures, so it is why files like `WorkspacePanelHeader.tsx` measured
 * 62 % duplicated while sharing no actual behaviour with anything. The only part of an icon
 * that carries information is its `d` path; everything else is this component.
 *
 * Two variants, matching the two heroicons sets:
 *  - default (outline) — `fill="none"`, stroked with `currentColor`, round caps/joins.
 *  - `solid` — `fill="currentColor"`, no stroke; pass `fillRule`/`clipRule` through for the
 *    heroicons solid paths that need them.
 *
 * Multi-element art (a spinner's circle + path, a chart's rects) passes `children` instead of
 * `d` and keeps the wrapper. Every other SVG attribute is forwarded, so a site that needs
 * `style`, `role`, `aria-label` or an event handler is not forced back to a raw `<svg>`.
 *
 * `xmlns` is deliberately not emitted: React renders JSX `<svg>` in the SVG namespace already,
 * and the attribute was inert at all ~64 sites that carried it.
 *
 * A raw `<svg>` carrying `strokeWidth` is held down-only by
 * `__tests__/icon-primitive-ratchet.test.ts` — reach for this component, not a copy.
 */
export interface IconProps extends Omit<SVGProps<SVGSVGElement>, "d"> {
  /** The icon's single path. Omit it and pass `children` for multi-element art. */
  d?: string;
  /** Filled rather than stroked — the heroicons "solid" set. */
  solid?: boolean;
}

export function Icon({
  d,
  solid = false,
  className = "h-4 w-4",
  viewBox = "0 0 24 24",
  strokeWidth = 2,
  children,
  ...rest
}: IconProps) {
  const stroked = !solid;
  return (
    <svg
      className={className}
      viewBox={viewBox}
      fill={solid ? "currentColor" : "none"}
      {...(stroked ? { stroke: "currentColor", strokeWidth } : {})}
      {...rest}
    >
      {d !== undefined && (stroked ? <path strokeLinecap="round" strokeLinejoin="round" d={d} /> : <path d={d} />)}
      {children}
    </svg>
  );
}
