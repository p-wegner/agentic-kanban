// Quota-usage wire DTOs (#704). See ../api.ts barrel.

export interface QuotaUsageResult {
  providers: QuotaProviderEntry[];
  scrapedAt: string;
}

export interface QuotaProviderEntry {
  id: string;
  label: string;
  accent: string;
  loginUrl: string;
  transport: "browser" | "http";
  hasCreds: boolean;
  /**
   * `unknown` (#1023) is neither exhausted nor empty: the measurement is older than one
   * reset window (or was never taken), so the number describes a window that has since
   * reset. Quota gating (`isPolicyBlockedByQuota`) only blocks on `ok`, so an `unknown`
   * profile degrades to the static priority order instead of being dropped.
   */
  status: "ok" | "auth" | "error" | "unknown";
  plan?: string;
  metrics?: QuotaMetric[];
  error?: string;
  /** ISO instant at which the metrics below were measured; null if never. */
  measuredAt?: string | null;
  /** Age of that measurement in seconds — the reason a reader can trust or discount it. */
  ageSeconds?: number | null;
  /** True when `ageSeconds` exceeds one reset window (or nothing has been measured). */
  stale?: boolean;
}

export interface QuotaMetric {
  label: string;
  percent: number | null;
  detail: string | null;
  resetAt: number | null;
  resetIso: string | null;
  resetInSeconds: number | null;
  periodMs: number | null;
  fractionElapsed?: number;
  expectedPercent?: number;
  pace?: number;
  projectedAtReset?: number;
}
