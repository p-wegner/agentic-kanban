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
  status: "ok" | "auth" | "error";
  plan?: string;
  metrics?: QuotaMetric[];
  error?: string;
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
