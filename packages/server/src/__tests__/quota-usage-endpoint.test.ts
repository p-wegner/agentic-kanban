/**
 * Contract test for GET /api/preferences/quota-usage.
 *
 * The route reads live provider quota from an injectable QuotaUsageProvider
 * (default: TampermonkeyQuotaProvider hitting the local :8742 service). It must:
 *  - return 200 + the documented {providers, scrapedAt} shape when the provider
 *    yields data, and
 *  - degrade to 503 + {error, providers:[], scrapedAt} when the provider throws
 *    (e.g. the external :8742 service is down) — never propagate the throw as a
 *    500 nor falsely report 200.
 *
 * The provider is swapped via setQuotaUsageProvider(), so no real network call
 * to :8742 is made. The original provider is restored in afterAll.
 */
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { createRoutes } from "../routes/index.js";
import { createTestApp as _createTestApp } from "./helpers/test-app.js";
import { createMockSessionManager } from "./helpers/mocks.js";
import {
  getQuotaUsageProvider,
  setQuotaUsageProvider,
  type QuotaUsageProvider,
  type QuotaUsageResult,
} from "../services/quota-usage.service.js";

function createTestApp() {
  return _createTestApp((app, db) => {
    app.route("/api", createRoutes(db, () => createMockSessionManager()));
  });
}

describe("GET /api/preferences/quota-usage", () => {
  // @covers preferences-config.read.quota-usage [api, error]
  const { app } = createTestApp();
  const originalProvider = getQuotaUsageProvider();

  afterAll(() => {
    setQuotaUsageProvider(originalProvider);
  });

  describe("when the provider returns data", () => {
    const stubResult: QuotaUsageResult = {
      providers: [
        {
          id: "claude",
          label: "Claude",
          accent: "#cc785c",
          loginUrl: "https://claude.ai",
          transport: "browser",
          hasCreds: true,
          status: "ok",
          plan: "Max",
          metrics: [
            {
              label: "5h window",
              percent: 42,
              detail: "42% used",
              resetAt: 1700000000000,
              resetIso: "2023-11-14T22:13:20.000Z",
              resetInSeconds: 3600,
              periodMs: 18000000,
            },
          ],
        },
      ],
      scrapedAt: "2026-06-27T00:00:00.000Z",
    };

    beforeAll(() => {
      const stub: QuotaUsageProvider = {
        fetchUsage: async () => stubResult,
      };
      setQuotaUsageProvider(stub);
    });

    it("returns 200 with the documented {providers, scrapedAt} shape", async () => {
      const res = await app.request("/api/preferences/quota-usage", { method: "GET" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as QuotaUsageResult;
      expect(Array.isArray(body.providers)).toBe(true);
      expect(body.providers).toHaveLength(1);
      expect(body.providers[0]?.id).toBe("claude");
      expect(body.providers[0]?.status).toBe("ok");
      expect(body.providers[0]?.metrics?.[0]?.percent).toBe(42);
      expect(body.scrapedAt).toBe("2026-06-27T00:00:00.000Z");
    });
  });

  describe("when the provider throws (external :8742 down)", () => {
    beforeAll(() => {
      const throwing: QuotaUsageProvider = {
        fetchUsage: async () => {
          throw new Error("connect ECONNREFUSED 127.0.0.1:8742");
        },
      };
      setQuotaUsageProvider(throwing);
    });

    it("degrades to 503 with the {error, providers:[], scrapedAt} body — not 500/200", async () => {
      const res = await app.request("/api/preferences/quota-usage", { method: "GET" });
      // The route must translate the provider throw into a graceful 503.
      // If the catch block were removed / changed, this would be 500 (uncaught)
      // or 200 (no error path) and the test would go RED.
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error?: string; providers: unknown[]; scrapedAt: string };
      expect(body.providers).toEqual([]);
      expect(body.error).toContain("ECONNREFUSED");
      expect(typeof body.scrapedAt).toBe("string");
    });
  });
});
