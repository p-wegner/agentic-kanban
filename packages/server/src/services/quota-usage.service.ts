import type { QuotaMetric, QuotaProviderEntry, QuotaUsageResult } from "@agentic-kanban/shared";
// #704: moved to shared/src/types/api/. Re-exported so importers of this module are unchanged.
export type { QuotaMetric, QuotaProviderEntry, QuotaUsageResult };
import { request } from "node:http";
import { OAuthQuotaProvider } from "./oauth-quota-provider.js";







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

/**
 * The default source (#1023): the OAuth usage endpoint, read per Claude profile with
 * that profile's own token.
 *
 * `TampermonkeyQuotaProvider` was the default and is not the default any more. It is
 * bound to a local browser-extension service on :8742 which is effectively never
 * running, so `fetchLiveQuotaUsage()` threw on every call and the Bullseye's quota
 * gating degraded to the static priority order. The class stays exported and
 * selectable — nothing about it was wrong, it just cannot be the thing the board
 * assumes is there.
 *
 * Selection is by env, not by preference, deliberately: this is a source-of-truth
 * choice for the whole process, not per project, and a preference read here would make
 * a module that must construct at import time DB-bound.
 *   KANBAN_QUOTA_SOURCE=tampermonkey  → the old :8742 path
 *   KANBAN_QUOTA_SOURCE=none          → measure nothing (see `NullQuotaProvider`)
 *   anything else / unset             → the OAuth provider
 * `setQuotaUsageProvider()` still overrides all three, which is what tests use.
 */
export function createDefaultQuotaUsageProvider(): QuotaUsageProvider {
  if (process.env.KANBAN_QUOTA_SOURCE === "none") return new NullQuotaProvider();
  if (process.env.KANBAN_QUOTA_SOURCE === "tampermonkey") return new TampermonkeyQuotaProvider();
  return new OAuthQuotaProvider();
}

/**
 * A source that measures nothing — every profile reads as `unknown`, which is exactly the
 * state of a board with no quota source at all, and never counts as exhausted.
 *
 * It exists for the UNIT SUITE (`test-setup/quota-neutral.ts`). Without it every test that
 * reaches `loadProjectRuntimeConfig` made a live `api/oauth/usage` request with the
 * developer's own OAuth token and then let that account's 5-hour percentage decide which
 * provider the code under test selected. That is ambient state no test controls: master's
 * sweep went red on two provider-selection suites purely because the reading crossed the
 * pool-exhausted threshold, and green again later with no commit in between.
 */
export class NullQuotaProvider implements QuotaUsageProvider {
  async fetchUsage(): Promise<QuotaUsageResult> {
    return { providers: [], scrapedAt: new Date().toISOString() };
  }
}

let _provider: QuotaUsageProvider | null = null;

export function getQuotaUsageProvider(): QuotaUsageProvider {
  if (!_provider) _provider = createDefaultQuotaUsageProvider();
  return _provider;
}

export function setQuotaUsageProvider(provider: QuotaUsageProvider): void {
  _provider = provider;
}

export async function fetchLiveQuotaUsage(): Promise<QuotaUsageResult> {
  return getQuotaUsageProvider().fetchUsage();
}
