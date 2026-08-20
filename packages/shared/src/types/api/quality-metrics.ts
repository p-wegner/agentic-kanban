// Quality-metrics wire-contract types (pure DTOs). See ../api.ts barrel.

export interface QualityMetricRecord {
  id: string;
  projectId: string;
  metricKey: string;
  value: number;
  unit: string | null;
  meta: unknown;
  collectedAt: string;
  commitSha: string | null;
}

export interface QualityMetricsResponse {
  latest: QualityMetricRecord[];
  trend: QualityMetricRecord[];
}

export interface CreateQualityMetricsRequest {
  commitSha?: string | null;
  collectedAt?: string | null;
  metrics: Array<{
    metricKey: string;
    value: number;
    unit?: string | null;
    meta?: unknown;
  }>;
}
