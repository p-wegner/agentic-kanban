import { useMemo } from "react";
import { providerColor } from "../lib/chartColors.js";
import { chartBox, summarizeStacks, type StackPoint } from "../lib/chartGeometry.js";
import { useWindowedChartData } from "../hooks/useWindowedChartData.js";
import { ChartCard, ChartFrame, ChartStatTile, ChartStatTiles } from "./ChartFrame.js";
import { ChartAxes, ChartLegend, StackedBars } from "./ChartPrimitives.js";

/**
 * One stacked-by-provider daily chart (#732).
 *
 * `ProviderMixChart` and `ProviderCostOverTimeChart` are the SAME chart over two different
 * measures: workspaces created per day, and estimated token cost per day. Clone detection
 * scored them at 78 % / 72 % duplicated; splitting the frame, the axes and the bars out
 * still left 59 % / 56 %, because what remained duplicated was the composition itself — the
 * `Total` tile plus one percentage tile per provider, the axis + bars + legend inside a
 * card, and the four-state frame around it.
 *
 * So the composition is the extraction, and the two charts are now the CONFIGURATION of
 * it. Every prop below is a real difference between them; nothing here is parameterised
 * speculatively.
 */
export interface ProviderStackedChartProps<P extends { date: string }, W extends number> {
  projectId: string;
  /** Endpoint without query string; `useWindowedChartData` appends `projectId` + `days`. */
  path: string;
  title: string;
  subtitle: string;
  windows: readonly W[];
  initialDays: W;
  loadingLabel: string;
  fallbackError: string;
  /** SVG path for the empty-state glyph. */
  emptyIconPath: string;
  emptyLabel: (days: W) => string;
  /** Label of the leading (all-providers) stat tile, e.g. "Total" / "Total Cost". */
  totalLabel: string;
  /** Left/right SVG padding — a currency axis label needs more room than a count. */
  padX: number;
  /** Pull the per-provider values out of one point (`counts` vs `costs`). */
  valuesOf: (point: P) => Record<string, number>;
  /** Renders a measure in the tiles, the axis, the tooltips and above the bars. */
  format: (value: number) => string;
  /** Print an x-label every nth day, for the selected window. */
  labelEvery: (days: W) => number;
  /**
   * Treat an all-zero window as empty. True for cost (a $0 window means only uncosted
   * providers ran, so there is nothing to plot); false for counts (a run of zero-workspace
   * days is itself the answer).
   */
  requireNonZeroTotal?: boolean;
  /** Floor for the y-axis maximum, so an all-zero count window still reads `0 … 1`. */
  minMaxStack?: number;
  /** Right-align the y tick labels inside the left padding (needed for currency). */
  axisLabelsInsidePadding?: boolean;
}

export function ProviderStackedChart<P extends { date: string }, W extends number>({
  projectId,
  path,
  title,
  subtitle,
  windows,
  initialDays,
  loadingLabel,
  fallbackError,
  emptyIconPath,
  emptyLabel,
  totalLabel,
  padX,
  valuesOf,
  format,
  labelEvery,
  requireNonZeroTotal,
  minMaxStack,
  axisLabelsInsidePadding,
}: ProviderStackedChartProps<P, W>) {
  const { data, loading, error, days, setDays, retry } = useWindowedChartData<
    { series: string[]; points: P[] },
    W
  >(path, projectId, initialDays, fallbackError);

  const box = chartBox({ svgW: 760, svgH: 220, padX });
  const points: StackPoint[] = useMemo(
    () => (data?.points ?? []).map((pt) => ({ date: pt.date, values: valuesOf(pt) })),
    [data, valuesOf],
  );
  const summary = useMemo(
    () => summarizeStacks(data?.series ?? [], points, { requireNonZeroTotal, minMaxStack }),
    [data, points, requireNonZeroTotal, minMaxStack],
  );

  return (
    <ChartFrame
      title={title}
      subtitle={subtitle}
      windows={windows}
      days={days}
      onDaysChange={setDays}
      loading={loading}
      loadingLabel={loadingLabel}
      error={error}
      onRetry={retry}
      empty={!data || !summary}
      emptyIconPath={emptyIconPath}
      emptyLabel={emptyLabel(days)}
    >
      {() => {
        const series = data!.series;
        const stats = summary!;
        return (
          <>
            <ChartStatTiles columns={Math.min(series.length + 1, 4)}>
              <ChartStatTile label={totalLabel} value={format(stats.grandTotal)} hint={`last ${days} days`} />
              {series.map((s) => (
                <ChartStatTile
                  key={s}
                  label={s}
                  swatch={providerColor(s)}
                  value={format(stats.totals[s])}
                  hint={stats.grandTotal > 0 ? `${Math.round((stats.totals[s] / stats.grandTotal) * 100)}%` : "0%"}
                />
              ))}
            </ChartStatTiles>

            <ChartCard>
              <svg viewBox={`0 0 ${box.svgW} ${box.svgH}`} className="h-56 w-full overflow-visible">
                <ChartAxes
                  box={box}
                  max={stats.maxStack}
                  formatTick={format}
                  labelsInsidePadding={axisLabelsInsidePadding}
                />
                <StackedBars
                  box={box}
                  series={series}
                  points={points}
                  summary={stats}
                  color={providerColor}
                  format={format}
                  labelEvery={labelEvery(days)}
                />
              </svg>
              <ChartLegend items={series.map((s) => ({ label: s, color: providerColor(s) }))} capitalize />
            </ChartCard>
          </>
        );
      }}
    </ChartFrame>
  );
}
