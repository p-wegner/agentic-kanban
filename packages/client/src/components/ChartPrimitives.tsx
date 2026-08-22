import type { ChartBox, StackPoint, StackSummary } from "../lib/chartGeometry.js";
import { fmtChartDate, showsTick, stackSegments, stackTotal } from "../lib/chartGeometry.js";

/**
 * The SVG parts every windowed dashboard chart drew by hand (#732).
 *
 * Axes + gridlines, the legend chip row, and — for the two provider charts — the whole
 * stacked-bar body were copied between files, which is why a fix to the tooltip or the
 * label-collision rule had to be applied three times. `ChartAxes` and `ChartLegend` have
 * four callers; `StackedBars` has two (the mix and cost charts), which is what makes it an
 * extraction rather than a relocation.
 *
 * These deliberately take a `ChartBox` (see `lib/chartGeometry.ts`) instead of loose
 * numbers: the box IS the shared arithmetic, and passing it whole means a chart cannot
 * hand the axes one plot height and the bars another.
 */

/** Axis lines plus the three horizontal gridlines and their y-labels. */
export function ChartAxes({
  box,
  max,
  formatTick,
  /** Right-align labels inside the left padding (needed once the label is wide, e.g. currency). */
  labelsInsidePadding = false,
}: {
  box: ChartBox;
  max: number;
  formatTick: (value: number) => string;
  labelsInsidePadding?: boolean;
}) {
  const { svgW, padX, padTop, plotH } = box;
  return (
    <>
      <line x1={padX} y1={padTop + plotH} x2={svgW - padX} y2={padTop + plotH} stroke="#d1d5db" />
      <line x1={padX} y1={padTop} x2={padX} y2={padTop + plotH} stroke="#d1d5db" />
      {[0, 0.5, 1].map((tick) => {
        const yTick = padTop + plotH - tick * plotH;
        return (
          <g key={tick}>
            <line x1={padX} x2={svgW - padX} y1={yTick} y2={yTick} stroke="#e5e7eb" />
            <text
              x={labelsInsidePadding ? padX - 6 : 8}
              y={yTick + 4}
              textAnchor={labelsInsidePadding ? "end" : undefined}
              className="fill-gray-500 text-[11px] dark:fill-gray-400"
            >
              {formatTick(max * tick)}
            </text>
          </g>
        );
      })}
    </>
  );
}

/** Colour-chip legend under a chart. */
export function ChartLegend({
  items,
  capitalize = false,
}: {
  items: readonly { label: string; color: string }[];
  capitalize?: boolean;
}) {
  return (
    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
      {items.map((item) => (
        <div key={item.label} className="flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-300">
          <span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: item.color }} />
          <span className={capitalize ? "capitalize" : undefined}>{item.label}</span>
        </div>
      ))}
    </div>
  );
}

/** One bar in a single-series bar chart. */
export interface SimpleBar {
  /** Stable React key — a date key or bucket range, not the rendered label. */
  id: string;
  /** x-axis label. */
  label: string;
  value: number;
  color: string;
}

/**
 * A single-series bar chart body: `ScorecardDistributionChart` (score buckets) and
 * `ThroughputChart` (issues done per day) had byte-identical copies of this loop, differing
 * only in the tooltip sentence and whether the value is printed above the bar.
 */
export function SimpleBars({
  box,
  bars,
  max,
  tooltip,
  labelEvery = 1,
  valueLabels = false,
  fillOpacity = 0.9,
  barWidthRatio = 0.65,
}: {
  box: ChartBox;
  bars: readonly SimpleBar[];
  max: number;
  tooltip: (bar: SimpleBar) => string;
  /** Print an x-label every nth slot (the last slot is always labelled). */
  labelEvery?: number;
  /** Print the value just above each bar. */
  valueLabels?: boolean;
  fillOpacity?: number;
  barWidthRatio?: number;
}) {
  const { svgH, padX, padTop, plotW, plotH } = box;
  return (
    <>
      {bars.map((bar, i) => {
        const slotW = plotW / bars.length;
        const barW = Math.max(slotW * barWidthRatio, 2);
        const cx = padX + (i + 0.5) * slotW;
        const barH = max === 0 ? 0 : (bar.value / max) * plotH;
        const barY = padTop + plotH - barH;
        return (
          <g key={bar.id}>
            {bar.value > 0 && (
              <rect
                x={cx - barW / 2}
                y={barY}
                width={barW}
                height={barH}
                fill={bar.color}
                fillOpacity={fillOpacity}
                rx={2}
              >
                <title>{tooltip(bar)}</title>
              </rect>
            )}
            {valueLabels && bar.value > 0 && (
              <text x={cx} y={barY - 4} textAnchor="middle" className="fill-gray-600 text-[10px] dark:fill-gray-300">
                {bar.value}
              </text>
            )}
            {showsTick(i, bars.length, labelEvery) && (
              <text x={cx} y={svgH - 8} textAnchor="middle" className="fill-gray-500 text-[11px] dark:fill-gray-400">
                {bar.label}
              </text>
            )}
          </g>
        );
      })}
    </>
  );
}

/**
 * A stacked bar per point, one segment per series, with a per-segment `<title>` tooltip,
 * the stack total printed above the bar, and every `labelEvery`-th x-label.
 *
 * The two provider charts differ only in what a value MEANS — a count or a dollar amount —
 * which is now the single `format` prop rather than two near-identical 60-line bodies.
 */
export function StackedBars({
  box,
  series,
  points,
  summary,
  color,
  format,
  labelEvery,
}: {
  box: ChartBox;
  series: readonly string[];
  points: readonly StackPoint[];
  summary: StackSummary;
  color: (seriesKey: string) => string;
  /** Renders a value in the tooltip and above the bar. */
  format: (value: number) => string;
  /** Print an x-label every nth slot (the last slot is always labelled). */
  labelEvery: number;
}) {
  const { svgH, padX, padTop, plotW, plotH } = box;
  return (
    <>
      {points.map((pt, i) => {
        const slotW = plotW / points.length;
        const barW = Math.max(slotW * 0.6, 2);
        const cx = padX + (i + 0.5) * slotW;
        const totalDay = stackTotal(series, pt.values);
        const segments = stackSegments(series, pt.values, summary.maxStack, box);
        return (
          <g key={pt.date}>
            {segments.map(({ key, value, height, y }) =>
              value > 0 ? (
                <rect
                  key={key}
                  x={cx - barW / 2}
                  y={y}
                  width={barW}
                  height={height}
                  fill={color(key)}
                  fillOpacity={0.85}
                  rx={1}
                >
                  <title>{`${fmtChartDate(pt.date)} — ${key}: ${format(value)}`}</title>
                </rect>
              ) : null,
            )}
            {showsTick(i, points.length, labelEvery) && (
              <text x={cx} y={svgH - 8} textAnchor="middle" className="fill-gray-500 text-[11px] dark:fill-gray-400">
                {fmtChartDate(pt.date)}
              </text>
            )}
            {totalDay > 0 && (
              <text
                x={cx}
                y={padTop + plotH - (totalDay / summary.maxStack) * plotH - 3}
                textAnchor="middle"
                className="fill-gray-500 text-[9px] dark:fill-gray-400"
              >
                {format(totalDay)}
              </text>
            )}
          </g>
        );
      })}
    </>
  );
}
