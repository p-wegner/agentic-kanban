/**
 * The pure half of the dashboard charts (#732).
 *
 * The four windowed charts (`ProviderMixChart`, `ProviderCostOverTimeChart`,
 * `ScorecardDistributionChart`, `ThroughputChart`) each re-derived the same SVG box
 * arithmetic, the same date formatter, and — for the two stacked ones — the same
 * per-series totals/max-stack reduction. Token-windowed clone detection scored the
 * ProviderMix/ProviderCost pair at 78 % / 72 % duplicated, and this module plus
 * `ChartPrimitives.tsx` is where the shared half now lives once.
 *
 * Pure by construction, per the client's `lib/<feature>.ts` convention (#589): no React,
 * no DOM, so the geometry and the stacking are testable without rendering a chart.
 */

/** An SVG chart's outer box plus the derived plot area. */
export interface ChartBox {
  svgW: number;
  svgH: number;
  padX: number;
  padTop: number;
  padBottom: number;
  /** Width of the plotting area (inside both x-paddings). */
  plotW: number;
  /** Height of the plotting area (inside the top and bottom paddings). */
  plotH: number;
}

/**
 * Derive the plot area from the outer box. `padX` is the only dimension that differs
 * between the charts (a currency axis needs more room than a count axis), which is
 * exactly why the arithmetic is worth having in one place.
 */
export function chartBox(opts: {
  svgW: number;
  svgH: number;
  padX: number;
  padTop?: number;
  padBottom?: number;
}): ChartBox {
  const { svgW, svgH, padX, padTop = 12, padBottom = 32 } = opts;
  return { svgW, svgH, padX, padTop, padBottom, plotW: svgW - padX * 2, plotH: svgH - padTop - padBottom };
}

/** `2026-08-22` -> `Aug 22`, in the charts' shared axis format. */
export function fmtChartDate(dateKey: string): string {
  return new Date(`${dateKey}T00:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/**
 * Currency with adaptive precision: enough decimals to surface sub-cent spend, which a
 * plain 2-decimal format renders as a misleading `$0.00`.
 */
export function fmtUsd(value: number): string {
  if (!Number.isFinite(value) || value === 0) return "$0";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return value.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
}

/** One x-position in a stacked chart: a date key and one value per series. */
export interface StackPoint {
  date: string;
  values: Record<string, number>;
}

/** Per-series totals over the whole window, plus the tallest single stack. */
export interface StackSummary {
  totals: Record<string, number>;
  grandTotal: number;
  /** Tallest stacked total across all points — the y-axis maximum. */
  maxStack: number;
}

/**
 * Reduce a stacked series to its axis-and-tiles summary.
 *
 * Returns `null` when there is nothing meaningful to plot, so a caller can feed it
 * straight into the frame's `empty` decision: no points, no series, or — the case the
 * cost chart needs — a window whose every value is zero because only uncosted providers
 * ran. `requireNonZeroTotal` is what distinguishes the two: a count of zero workspaces
 * per day is still a chart worth drawing, a cost of exactly $0 is not.
 *
 * `minMaxStack` floors the y-axis maximum, so a count chart whose every bar is zero still
 * prints a `0 … 1` axis instead of three zeroes.
 */
export function summarizeStacks(
  series: readonly string[],
  points: readonly StackPoint[],
  opts: { requireNonZeroTotal?: boolean; minMaxStack?: number } = {},
): StackSummary | null {
  if (points.length === 0 || series.length === 0) return null;
  const totals: Record<string, number> = {};
  for (const s of series) totals[s] = 0;
  let grandTotal = 0;
  for (const pt of points) {
    for (const s of series) {
      const v = pt.values[s] ?? 0;
      totals[s] += v;
      grandTotal += v;
    }
  }
  if (opts.requireNonZeroTotal && grandTotal === 0) return null;
  const maxStack = Math.max(
    ...points.map((pt) => series.reduce((sum, k) => sum + (pt.values[k] ?? 0), 0)),
    opts.minMaxStack ?? 0,
  );
  return { totals, grandTotal, maxStack };
}

/** One drawn rectangle within a stack, in SVG user units. */
export interface StackSegment {
  key: string;
  value: number;
  height: number;
  /** Top edge, already stacked above the segments below it. */
  y: number;
}

/**
 * Lay one point's stack out bottom-up. Kept separate from the rendering so the stacking
 * order (and the `maxStack === 0` guard that would otherwise divide by zero) is testable.
 */
export function stackSegments(
  series: readonly string[],
  values: Record<string, number>,
  maxStack: number,
  box: Pick<ChartBox, "padTop" | "plotH">,
): StackSegment[] {
  let yOffset = box.padTop + box.plotH;
  return series.map((key) => {
    const value = values[key] ?? 0;
    const height = maxStack === 0 ? 0 : (value / maxStack) * box.plotH;
    yOffset -= height;
    return { key, value, height, y: yOffset };
  });
}

/** Sum one point's stack — the number rendered above the bar. */
export function stackTotal(series: readonly string[], values: Record<string, number>): number {
  return series.reduce((sum, k) => sum + (values[k] ?? 0), 0);
}

/**
 * Whether the i-th of `count` x-axis slots gets a printed label.
 *
 * Every chart wants "every nth tick, and always the last one" but each had spelled the
 * modulus inline against its own window union, so a new window silently got no labels at
 * all. `every` is chosen by the caller from its window; the last slot is always labelled.
 */
export function showsTick(i: number, count: number, every: number): boolean {
  return i % every === 0 || i === count - 1;
}
