import { useMemo } from "react";
import { STATUS_COLORS } from "../lib/chartColors.js";
import { chartBox, fmtChartDate } from "../lib/chartGeometry.js";
import { useWindowedChartData } from "../hooks/useWindowedChartData.js";
import { ChartCard, ChartFrame, ChartStatTile, ChartStatTiles } from "./ChartFrame.js";
import { ChartAxes, ChartLegend, SimpleBars, type SimpleBar } from "./ChartPrimitives.js";

interface ThroughputPoint {
  date: string;
  count: number;
}

interface ThroughputData {
  points: ThroughputPoint[];
}

const BAR_COLOR = STATUS_COLORS["Done"];

const WINDOWS = [14, 30] as const;
type ThroughputWindow = (typeof WINDOWS)[number];

const EMPTY_ICON = "M3 12h4v7H3zM10 8h4v11h-4zM17 4h4v15h-4zM3 19h18";

export function ThroughputChart({ projectId }: { projectId: string }) {
  const { data, loading, error, days, setDays, retry } = useWindowedChartData<ThroughputData, ThroughputWindow>(
    "/api/issues/throughput",
    projectId,
    14,
    "Failed to load throughput data",
  );

  const box = chartBox({ svgW: 760, svgH: 220, padX: 44 });
  const chart = useMemo(() => {
    if (!data || data.points.length === 0) return null;
    const maxCount = Math.max(...data.points.map((p) => p.count), 1);
    const total = data.points.reduce((s, p) => s + p.count, 0);
    if (total === 0) return null;
    const bars: SimpleBar[] = data.points.map((p) => ({
      id: p.date,
      label: fmtChartDate(p.date),
      value: p.count,
      color: BAR_COLOR,
    }));
    return { maxCount, total, avg: (total / data.points.length).toFixed(1), bars };
  }, [data]);

  return (
    <ChartFrame
      title="Throughput"
      subtitle="Issues moved to Done per calendar day."
      windows={WINDOWS}
      days={days}
      onDaysChange={setDays}
      loading={loading}
      loadingLabel="Loading throughput data..."
      error={error}
      onRetry={retry}
      empty={!data || !chart}
      emptyIconPath={EMPTY_ICON}
      emptyLabel={`No issues completed in the last ${days} days`}
    >
      {() => {
        const c = chart!;
        return (
          <>
            <ChartStatTiles columns={3}>
              <ChartStatTile label="Total Done" value={c.total} hint={`last ${days} days`} />
              <ChartStatTile label="Daily Avg" value={c.avg} hint="issues / day" />
              <ChartStatTile label="Best Day" value={c.maxCount} hint="issues completed" />
            </ChartStatTiles>

            <ChartCard>
              <svg viewBox={`0 0 ${box.svgW} ${box.svgH}`} className="h-56 w-full overflow-visible">
                <ChartAxes box={box} max={c.maxCount} formatTick={(v) => String(Math.round(v))} />
                <SimpleBars
                  box={box}
                  bars={c.bars}
                  max={c.maxCount}
                  labelEvery={days === 14 ? 2 : 4}
                  fillOpacity={0.85}
                  barWidthRatio={0.6}
                  tooltip={(bar) => `${bar.label}: ${bar.value} issue${bar.value !== 1 ? "s" : ""} completed`}
                />
              </svg>
              <ChartLegend items={[{ label: "Done", color: BAR_COLOR }]} />
            </ChartCard>
          </>
        );
      }}
    </ChartFrame>
  );
}
