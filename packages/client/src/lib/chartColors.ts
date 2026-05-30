/**
 * Editorial chart / data-viz palette (ticket #133).
 *
 * The board chrome was migrated to the warm "paper" editorial theme in #103,
 * but the dashboard/data-viz views (Metrics, Graph, Swimlane, Digest, Focus,
 * Insights, Timeline) each hard-coded the original saturated AI-dashboard hues
 * (blue #3b82f6, violet #8b5cf6, cyan #06b6d4). That made the same status read
 * blue in a chart but terracotta everywhere else.
 *
 * This module is the single source of truth for those hues, re-tuned to sit in
 * the editorial family: warm terracotta + sage + muted complements instead of
 * cold primary blue/violet. Re-tune the whole data-viz layer from here.
 *
 * These values intentionally mirror the `@theme` tokens in `app.css`
 * (brand-* / accent-*) where a status maps onto the brand/accent identity, and
 * use calmer, desaturated complements for the remaining categories so a chart
 * with 5+ series still reads as "designed" rather than "rainbow dashboard".
 */

/** Brand terracotta — primary "active/working" hue (mirrors --color-brand-500). */
export const BRAND = "#c25f36";
/** Accent sage — secondary/calm hue (mirrors --color-accent-500). */
export const ACCENT = "#547446";

/** Status -> chart color. Drives donut segments, legend dots, graph nodes,
 *  swimlane headers. Backlog/Todo/Cancelled stay neutral; the workflow states
 *  carry warm identity; Done is the sage "good" state. */
export const STATUS_COLORS: Record<string, string> = {
  Backlog:       "#a8a195", // warm gray (ink-faint family)
  Todo:          "#8a8175", // --color-ink-faint
  "In Progress": "#c25f36", // brand terracotta — actively worked
  "In Review":   "#d17d54", // lighter brand (brand-400) — distinct but same family
  "AI Reviewed": "#719161", // accent-400 sage — nearly done, calm
  Done:          "#547446", // accent-500 sage — the "good/complete" state
  Cancelled:     "#b3a89a", // muted warm gray
};

/** Issue-type -> chart color (By Type bars, graph node fill, timeline dots). */
export const TYPE_COLORS: Record<string, string> = {
  task:    "#5b7a8c", // muted slate-teal — neutral default work
  feature: "#c25f36", // brand terracotta — the headline category
  bug:     "#b4453a", // warm brick red (kept clearly "alert", but warmer)
  chore:   "#c79a3e", // warm ochre/gold
};

/** Priority -> chart color + soft backgrounds (Metrics priority bars). */
export const PRIORITY_META: Array<{
  key: string;
  label: string;
  color: string;
  lightBg: string;
  darkBg: string;
}> = [
  { key: "critical", label: "Critical", color: "#b4453a", lightBg: "#f6e3df", darkBg: "#3a1512" },
  { key: "high",     label: "High",     color: "#c25f36", lightBg: "#f5e1d6", darkBg: "#3a1c10" },
  { key: "medium",   label: "Medium",   color: "#c79a3e", lightBg: "#f4ead2", darkBg: "#352a12" },
  { key: "low",      label: "Low",      color: "#8a8175", lightBg: "#efe9df", darkBg: "#26231f" },
];

/** Semantic accents for digest/focus stat cards & sections. */
export const SEMANTIC = {
  created: "#5b7a8c", // muted slate-teal (was blue #3b82f6)
  merged:  "#547446", // sage (was cyan #06b6d4)
  agent:   "#c25f36", // brand terracotta (was violet #8b5cf6)
} as const;

/** Single primary line/series color (Insights cost trend, Focus score). */
export const PRIMARY_SERIES = BRAND;

/** Activity-heatmap intensity ramp (low -> high), sage/accent family instead of
 *  GitHub green. Index 0 is the "empty cell" surface. */
export const HEATMAP_SCALE = ["#efe9df", "#c0d0b5", "#98b288", "#719161", "#415c37"] as const;
