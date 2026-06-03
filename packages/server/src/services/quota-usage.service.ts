import { request } from "node:http";

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

export interface QuotaUsageResult {
  providers: QuotaProviderEntry[];
  scrapedAt: string;
}

export interface QuotaUsageProvider {
  fetchUsage(): Promise<QuotaUsageResult>;
}

// Fetches live quota usage from a tampermonkey-direct compatible service.
// The base URL is configurable so the provider can be swapped for a different
// source without changing call sites.
export class TampermonkeyQuotaProvider implements QuotaUsageProvider {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(baseUrl = "http://127.0.0.1:8742", timeoutMs = 10_000) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.timeoutMs = timeoutMs;
  }

  async fetchUsage(): Promise<QuotaUsageResult> {
    const raw = await this.get("/api/usage");
    const parsed = JSON.parse(raw) as QuotaUsageResult;
    return parsed;
  }

  private get(path: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const url = new URL(this.baseUrl + path);
      const req = request(
        {
          hostname: url.hostname,
          port: url.port ? Number(url.port) : 80,
          path: url.pathname + url.search,
          method: "GET",
          headers: { Accept: "application/json" },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            if (res.statusCode && res.statusCode >= 400) {
              reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
            } else {
              resolve(body);
            }
          });
        },
      );
      req.on("error", reject);
      req.setTimeout(this.timeoutMs, () => {
        req.destroy(new Error(`Request to ${path} timed out after ${this.timeoutMs}ms`));
      });
      req.end();
    });
  }
}

// Default singleton — points at the local tampermonkey-direct service.
// Replace this instance (or inject a different QuotaUsageProvider) to swap the source.
let _provider: QuotaUsageProvider = new TampermonkeyQuotaProvider();

export function getQuotaUsageProvider(): QuotaUsageProvider {
  return _provider;
}

export function setQuotaUsageProvider(provider: QuotaUsageProvider): void {
  _provider = provider;
}

export async function fetchLiveQuotaUsage(): Promise<QuotaUsageResult> {
  return _provider.fetchUsage();
}
