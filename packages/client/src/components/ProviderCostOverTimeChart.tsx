import { fmtUsd } from "../lib/chartGeometry.js";
import { ProviderStackedChart } from "./ProviderStackedChart.js";

/** Estimated token cost per day, stacked by agent provider. */
interface CostPoint {
  date: string;
  costs: Record<string, number>;
}

const WINDOWS = [7, 30, 90] as const;
type CostWindow = (typeof WINDOWS)[number];

const EMPTY_ICON = "M3 13l4-3 4 2 4-5 4 3M3 19h18";
/** Every day at 7d, weekly at 30d, ~10-daily at 90d. */
const LABEL_EVERY: Record<CostWindow, number> = { 7: 1, 30: 4, 90: 10 };

const valuesOf = (pt: CostPoint) => pt.costs;
const labelEvery = (days: CostWindow) => LABEL_EVERY[days];

export function ProviderCostOverTimeChart({ projectId }: { projectId: string }) {
  return (
    <ProviderStackedChart<CostPoint, CostWindow>
      projectId={projectId}
      path="/api/workspaces/cost-over-time"
      title="Provider Cost Over Time"
      subtitle="Estimated token cost per day, grouped by agent provider."
      windows={WINDOWS}
      initialDays={30}
      loadingLabel="Loading cost data..."
      fallbackError="Failed to load cost data"
      emptyIconPath={EMPTY_ICON}
      emptyLabel={(days) => `No recorded token cost in the last ${days} days`}
      totalLabel="Total Cost"
      // Wider than the mix chart: a currency tick label needs the room.
      padX={52}
      valuesOf={valuesOf}
      format={fmtUsd}
      labelEvery={labelEvery}
      // A $0 window means only uncosted providers ran — nothing meaningful to plot.
      requireNonZeroTotal
      axisLabelsInsidePadding
    />
  );
}
