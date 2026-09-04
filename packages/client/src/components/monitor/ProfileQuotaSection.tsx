import { useEffect, useState } from "react";
import type { QuotaProviderEntry, QuotaUsageResult } from "@agentic-kanban/shared";
import { getQuotaUsage } from "../../lib/settingsStore.js";

/**
 * Per-profile quota, from the OAuth usage endpoint (#1023).
 *
 * The Monitor view is where an operator asks "why did it pick that profile?", and until
 * now the answer to "how much is left on each" was nowhere on the board — the quota
 * source was a Tampermonkey path that was never filled, so the Bullseye's provider policy
 * silently degraded to the static order.
 *
 * Deliberately a COMPACT read-out, not a roster table (that is #1028): profile, the two
 * window percentages, and the AGE of the measurement. The age is the part that makes the
 * numbers trustworthy — an `unknown` row means "older than one reset window", which is
 * neither exhausted nor empty and must not read as either.
 *
 * Lives in its own module because it OWNS ITS DATA SOURCE: it fetches (through
 * `settingsStore.getQuotaUsage`, since that module owns every preferences URL — the
 * client-conventions guard counts a raw one here as a settings-cache bypass), and it is the
 * only reader of `quotaPercentLabel`/`measurementAgeLabel`. Adding it to `MonitorSections.tsx`
 * is what pushed that file past the 1000-line god-module ceiling.
 */
export function ProfileQuotaSection() {
  const [result, setResult] = useState<QuotaUsageResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getQuotaUsage()
      .then((res) => { if (!cancelled) { setResult(res); setError(null); } })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : "unavailable"); });
    return () => { cancelled = true; };
  }, []);

  const providers = result?.providers ?? [];
  if (error) {
    return (
      <div className="px-3 py-2.5 border-b border-gray-100 dark:border-gray-800">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500 mb-1.5">Profile quota</div>
        <div className="text-[11px] text-gray-500 dark:text-gray-400">Quota source unavailable — {error}</div>
      </div>
    );
  }
  if (providers.length === 0) return null;

  return (
    <div className="px-3 py-2.5 border-b border-gray-100 dark:border-gray-800">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500 mb-1.5">Profile quota</div>
      <div className="space-y-1">
        {providers.map((p) => (
          <div key={p.id} className="flex items-center justify-between gap-2 text-[11px]">
            <span className="text-gray-600 dark:text-gray-300 truncate" title={p.label}>{p.id}</span>
            <span className="flex items-center gap-2 shrink-0 tabular-nums">
              {p.status === "auth" ? (
                <span className="text-amber-600 dark:text-amber-400">not logged in</span>
              ) : (
                <>
                  <span className="text-gray-700 dark:text-gray-200" title="5-hour window">{quotaPercentLabel(p, "5-hour window")}</span>
                  <span className="text-gray-400 dark:text-gray-500">/</span>
                  <span className="text-gray-700 dark:text-gray-200" title="7-day window">{quotaPercentLabel(p, "7-day window")}</span>
                </>
              )}
              <span
                className={`text-gray-400 dark:text-gray-500${p.status === "unknown" ? " italic" : ""}`}
                title={p.status === "unknown"
                  ? "Older than one reset window — counted as unknown, never as exhausted"
                  : `Measured ${p.measuredAt ?? "—"}`}
              >
                {measurementAgeLabel(p)}
              </span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function quotaPercentLabel(entry: QuotaProviderEntry, label: string): string {
  const metric = entry.metrics?.find((m) => m.label === label);
  return metric?.percent == null ? "—" : `${Math.round(metric.percent)}%`;
}

/** Age is the trust signal, so "never measured" says so rather than showing nothing. */
function measurementAgeLabel(entry: QuotaProviderEntry): string {
  if (entry.ageSeconds == null) return "never";
  if (entry.ageSeconds < 60) return `${entry.ageSeconds}s ago`;
  if (entry.ageSeconds < 3600) return `${Math.round(entry.ageSeconds / 60)}m ago`;
  return `${Math.round(entry.ageSeconds / 3600)}h ago`;
}
