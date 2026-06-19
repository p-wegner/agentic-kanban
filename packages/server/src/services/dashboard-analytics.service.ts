// Pure analytics computations for the project dashboard. Kept out of the route
// handlers (which only parse params, run the repository query, and serialize) so
// the aggregation logic is unit-testable without HTTP or a database.

/** One merged-issue attribution row, as returned by getDoneIssueProviderAttribution. */
export interface ThroughputAttributionRow {
  issueId: string;
  issueCreatedAt: string | null;
  statusChangedAt: string | null;
  provider: string | null;
  claudeProfile: string | null;
  mergedAt: string | null;
}

export interface ProviderThroughput {
  provider: string;
  profile: string;
  count: number;
  medianLeadTimeMs: number | null;
}

export interface ThroughputByProvider {
  providers: ProviderThroughput[];
  window: string;
  overallMedianLeadTimeMs: number | null;
}

/** Linear-interpolated percentile of an ascending-sorted numeric array. */
export function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/**
 * Rank providers/profiles by issues merged to master, with median lead time.
 *
 * An issue counts once (first merged workspace per issue wins — rows must arrive
 * ordered so the winner is seen first). Rows without a merge, without the
 * timestamps needed for lead time, or with a negative lead time are skipped.
 * Lead time = statusChangedAt (moved to Done) − issueCreatedAt.
 */
export function computeThroughputByProvider(
  rows: ThroughputAttributionRow[],
  days: number,
): ThroughputByProvider {
  const groups = new Map<string, { count: number; leadTimes: number[] }>();
  const seenIssueIds = new Set<string>();
  const allLeadTimes: number[] = [];

  for (const r of rows) {
    if (!r.mergedAt) continue;
    if (!r.statusChangedAt || !r.issueCreatedAt) continue;

    // Deduplicate: each issue counts only once.
    if (seenIssueIds.has(r.issueId)) continue;
    seenIssueIds.add(r.issueId);

    const provider = r.provider ?? "unknown";
    const profile = r.claudeProfile ?? "";
    const key = profile ? `${provider}:${profile}` : provider;

    const leadMs = new Date(r.statusChangedAt).getTime() - new Date(r.issueCreatedAt).getTime();
    if (leadMs < 0) continue;

    allLeadTimes.push(leadMs);

    let g = groups.get(key);
    if (!g) {
      g = { count: 0, leadTimes: [] };
      groups.set(key, g);
    }
    g.count++;
    g.leadTimes.push(leadMs);
  }

  const providers = [...groups.entries()]
    .map(([key, data]) => {
      const sorted = [...data.leadTimes].sort((a, b) => a - b);
      const parts = key.split(":");
      return {
        provider: parts[0],
        profile: parts.length > 1 ? parts.slice(1).join(":") : "",
        count: data.count,
        medianLeadTimeMs: percentile(sorted, 50),
      };
    })
    .sort((a, b) => b.count - a.count);

  const sortedAll = [...allLeadTimes].sort((a, b) => a - b);
  return { providers, window: `${days}d`, overallMedianLeadTimeMs: percentile(sortedAll, 50) };
}
