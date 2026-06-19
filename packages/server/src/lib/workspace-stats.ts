/**
 * Pure aggregation logic for the workspace analytics dashboard endpoints.
 *
 * The repository reads return flat rows; the HTTP route owns the clock-dependent
 * date-axis (`dates`) and then delegates the rollup to these pure functions. Keeping
 * the math here — out of the Hono handlers — makes it unit-testable without a server
 * or a database and keeps the route a thin adapter.
 */

/** One workspace row for the provider-mix chart (share-of-work over time). */
export interface ProviderMixRow {
  provider: string | null;
  createdAt: string | null;
}

/** One session row for the cost-over-time chart (cost trend over time). */
export interface CostOverTimeRow {
  provider: string | null;
  startedAt: string | null;
  stats: string | null;
}

/** One workspace row for the scorecard histogram. */
export interface ScorecardScoreRow {
  score: number | null;
}

/** A per-day stacked series: stable sorted `series` keys + one point per date. */
export interface DayCountSeries {
  series: string[];
  points: Array<{ date: string; counts: Record<string, number> }>;
}

export interface DayCostSeries {
  series: string[];
  points: Array<{ date: string; costs: Record<string, number> }>;
}

export interface ScorecardDistribution {
  buckets: Array<{ range: string; count: number }>;
  total: number;
}

const UNKNOWN_PROVIDER = "unknown";

/** Stable, sorted set of provider keys present in the rows. */
function collectProviderSeries(rows: Array<{ provider: string | null }>): string[] {
  const seriesSet = new Set<string>();
  for (const r of rows) seriesSet.add(r.provider ?? UNKNOWN_PROVIDER);
  return [...seriesSet].sort();
}

/** Build a zeroed `date -> series -> number` grid over the given day axis. */
function zeroGrid(dates: string[], series: string[]): Record<string, Record<string, number>> {
  const grid: Record<string, Record<string, number>> = {};
  for (const date of dates) {
    grid[date] = {};
    for (const s of series) grid[date][s] = 0;
  }
  return grid;
}

/** Count workspaces per day per provider over the `dates` axis (provider-mix chart). */
export function aggregateProviderMix(rows: ProviderMixRow[], dates: string[]): DayCountSeries {
  const series = collectProviderSeries(rows);
  const counts = zeroGrid(dates, series);
  for (const r of rows) {
    if (!r.createdAt) continue;
    const day = r.createdAt.slice(0, 10);
    if (!counts[day]) continue;
    const key = r.provider ?? UNKNOWN_PROVIDER;
    counts[day][key] = (counts[day][key] ?? 0) + 1;
  }
  const points = dates.map((date) => ({ date, counts: counts[date] ?? {} }));
  return { series, points };
}

/**
 * Sum session cost (`stats.totalCostUsd`) per day per provider over the `dates` axis
 * (cost-over-time chart). Rows with no start/stats, unparseable stats, or zero cost
 * are skipped.
 */
export function aggregateCostOverTime(rows: CostOverTimeRow[], dates: string[]): DayCostSeries {
  const series = collectProviderSeries(rows);
  const costs = zeroGrid(dates, series);
  for (const r of rows) {
    if (!r.startedAt || !r.stats) continue;
    let sessionCost = 0;
    try {
      const parsed = JSON.parse(r.stats) as { totalCostUsd?: unknown };
      const value = Number(parsed.totalCostUsd ?? 0);
      if (Number.isFinite(value)) sessionCost = value;
    } catch {
      continue;
    }
    if (sessionCost === 0) continue;
    const day = r.startedAt.slice(0, 10);
    if (!costs[day]) continue; // session outside the axis window (shouldn't happen post-filter)
    const key = r.provider ?? UNKNOWN_PROVIDER;
    costs[day][key] = (costs[day][key] ?? 0) + sessionCost;
  }
  const points = dates.map((date) => ({ date, costs: costs[date] ?? {} }));
  return { series, points };
}

/** Bucket scorecard scores into 5 ranges (0-20 … 80-100); 100 lands in the top bucket. */
export function bucketScorecardScores(rows: ScorecardScoreRow[]): ScorecardDistribution {
  const buckets = [
    { range: "0-20", count: 0 },
    { range: "20-40", count: 0 },
    { range: "40-60", count: 0 },
    { range: "60-80", count: 0 },
    { range: "80-100", count: 0 },
  ];
  for (const row of rows) {
    const score = row.score ?? 0;
    const idx = score >= 100 ? 4 : Math.min(Math.floor(score / 20), 4);
    buckets[idx].count++;
  }
  return { buckets: buckets.map(({ range, count }) => ({ range, count })), total: rows.length };
}
