import { ProviderStackedChart } from "./ProviderStackedChart.js";

/** Workspaces created per day, stacked by agent provider. */
interface MixPoint {
  date: string;
  counts: Record<string, number>;
}

const WINDOWS = [14, 30] as const;
type MixWindow = (typeof WINDOWS)[number];

const EMPTY_ICON = "M3 12h4v7H3zM10 8h4v11h-4zM17 4h4v15h-4zM3 19h18";
/** Every 2nd day over a fortnight; weekly over a month. */
const LABEL_EVERY: Record<MixWindow, number> = { 14: 2, 30: 4 };

const valuesOf = (pt: MixPoint) => pt.counts;
const format = (v: number) => String(v);
const labelEvery = (days: MixWindow) => LABEL_EVERY[days];

export function ProviderMixChart({ projectId }: { projectId: string }) {
  return (
    <ProviderStackedChart<MixPoint, MixWindow>
      projectId={projectId}
      path="/api/workspaces/provider-mix"
      title="Provider Mix"
      subtitle="Workspaces created per day, grouped by agent provider."
      windows={WINDOWS}
      initialDays={14}
      loadingLabel="Loading provider mix data..."
      fallbackError="Failed to load data"
      emptyIconPath={EMPTY_ICON}
      emptyLabel={(days) => `No workspaces created in the last ${days} days`}
      totalLabel="Total"
      padX={44}
      valuesOf={valuesOf}
      format={format}
      labelEvery={labelEvery}
      // A run of zero-workspace days is itself the answer, so an all-zero window is NOT
      // empty here — but the axis is floored at 1 so it reads `0 … 1`, not three zeroes.
      minMaxStack={1}
    />
  );
}
