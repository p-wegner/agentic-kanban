import { useMemo } from "react";
import { HEATMAP_SCALE, ACCENT } from "../lib/chartColors.js";
import { chartBox } from "../lib/chartGeometry.js";
import { useWindowedChartData } from "../hooks/useWindowedChartData.js";
import { ChartCard, ChartFrame, ChartStatTile, ChartStatTiles } from "./ChartFrame.js";
import { ChartAxes, ChartLegend, SimpleBars, type SimpleBar } from "./ChartPrimitives.js";

interface Bucket {
  range: string;
  count: number;
}

interface DistributionData {
  buckets: Bucket[];
  total: number;
}

const BUCKET_COLORS = [
  HEATMAP_SCALE[1],
  HEATMAP_SCALE[2],
  HEATMAP_SCALE[2],
  HEATMAP_SCALE[3],
  ACCENT,
] as const;

const WINDOWS = [30, 90, 180] as const;
type ScoreWindow = (typeof WINDOWS)[number];

const EMPTY_ICON =
  "M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z";

export function ScorecardDistributionChart({ projectId }: { projectId: string }) {
  const { data, loading, error, days, setDays, retry } = useWindowedChartData<DistributionData, ScoreWindow>(
    "/api/workspaces/scorecard-distribution",
    projectId,
    90,
    "Failed to load scorecard data",
  );

  const box = chartBox({ svgW: 480, svgH: 200, padX: 44 });
  const chart = useMemo(() => {
    if (!data || data.total === 0) return null;
    const maxCount = Math.max(...data.buckets.map((b) => b.count), 1);
    // Bucket i spans [i*20, i*20+20); its midpoint approximates the scores inside it.
    const avg = data.buckets.reduce((s, b, i) => s + b.count * (i * 20 + 10), 0) / data.total;
    const bars: SimpleBar[] = data.buckets.map((b, i) => ({
      id: b.range,
      label: b.range,
      value: b.count,
      color: BUCKET_COLORS[i],
    }));
    return { maxCount, avg: avg.toFixed(1), bars };
  }, [data]);

  return (
    <ChartFrame
      title="Score Distribution"
      subtitle="Workspace scorecard scores binned into 20-point buckets."
      windows={WINDOWS}
      days={days}
      onDaysChange={setDays}
      loading={loading}
      loadingLabel="Loading score distribution..."
      error={error}
      onRetry={retry}
      empty={!data || !chart}
      emptyIconPath={EMPTY_ICON}
      emptyLabel={`No scored workspaces in the last ${days} days`}
      maxWidth="max-w-3xl"
    >
      {() => {
        const d = data!;
        const c = chart!;
        return (
          <>
            <ChartStatTiles columns={3}>
              <ChartStatTile label="Total Scored" value={d.total} hint={`last ${days} days`} />
              <ChartStatTile label="Avg Score" value={c.avg} hint="out of 100" />
              <ChartStatTile
                label="High Quality"
                value={d.buckets.slice(3).reduce((s, b) => s + b.count, 0)}
                hint="scored 60+"
              />
            </ChartStatTiles>

            <ChartCard>
              <svg viewBox={`0 0 ${box.svgW} ${box.svgH}`} className="h-52 w-full overflow-visible">
                <ChartAxes box={box} max={c.maxCount} formatTick={(v) => String(Math.round(v))} />
                <SimpleBars
                  box={box}
                  bars={c.bars}
                  max={c.maxCount}
                  valueLabels
                  tooltip={(bar) => `${bar.label}: ${bar.value} workspace${bar.value !== 1 ? "s" : ""}`}
                />
              </svg>
              <ChartLegend items={c.bars.map((b) => ({ label: b.label, color: b.color }))} />
            </ChartCard>
          </>
        );
      }}
    </ChartFrame>
  );
}
