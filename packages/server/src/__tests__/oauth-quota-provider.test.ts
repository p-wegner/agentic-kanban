/**
 * The OAuth quota provider (#1023).
 *
 * Every test drives a FAKE fetch — the real endpoint is rate-limited and shared with
 * claude-pick and the statusline on a dev box, so a suite that touched it would be the
 * exact defect this provider is written to avoid. No test here makes a network call.
 *
 * What is pinned, and why each one is a property someone could plausibly break:
 *  - ONE request per tick, round-robin. The throttle is the whole reason this logic was
 *    ported rather than reinvented; a "refresh them all" convenience would look harmless.
 *  - A 429 backs off and does NOT mark the profile exhausted. Marking it would take a
 *    usable subscription out of the Bullseye's rotation — worse than having no quota data.
 *  - A measurement older than one reset window reads `unknown`, with the metrics still
 *    present. Neither exhausted nor empty.
 *  - The DTO shape the client and `isPolicyBlockedByQuota` actually read.
 */
import { describe, it, expect, vi } from "vitest";
import {
  OAuthQuotaProvider,
  MEASUREMENT_STALE_MS,
  backoffMs,
  refreshIntervalMs,
  parseRetryAfter,
  tierOf,
  buildProviderEntry,
  mergeRecord,
  type OAuthProfileRef,
  type QuotaCacheRecord,
} from "../services/oauth-quota-provider.js";

const T0 = Date.parse("2026-09-04T10:00:00.000Z");

const PROFILES: OAuthProfileRef[] = [
  { profile: "anth", configDir: "/home/u/.claude-anth" },
  { profile: "team", configDir: "/home/u/.claude-team" },
];

/** A usage-endpoint body in the shape the real one returns. */
function usageBody(fiveH: number, sevenD: number) {
  return {
    five_hour: { utilization: fiveH, resets_at: "2026-09-04T13:00:00.000Z" },
    seven_day: { utilization: sevenD, resets_at: "2026-09-08T00:00:00.000Z" },
  };
}

function okResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => body,
  } as unknown as Response;
}

function errorResponse(status: number, retryAfter?: string): Response {
  return {
    ok: false,
    status,
    headers: { get: (k: string) => (k.toLowerCase() === "retry-after" ? retryAfter ?? null : null) },
    json: async () => ({}),
  } as unknown as Response;
}

interface Harness {
  provider: OAuthQuotaProvider;
  /** One tick at the harness clock — `fetchUsage` takes the time, the provider holds none. */
  tick: () => Promise<Awaited<ReturnType<OAuthQuotaProvider["fetchUsage"]>>>;
  calls: string[];
  logs: string[];
  setNow: (ms: number) => void;
  responses: Response[];
}

function makeProvider(opts: { profiles?: OAuthProfileRef[]; responses?: Response[] } = {}): Harness {
  const calls: string[] = [];
  const logs: string[] = [];
  const profiles = opts.profiles ?? PROFILES;
  const responses = opts.responses ?? [];
  let now = T0;
  let served = 0;

  // The fake resolves per CALL, so a test can queue a 200 then a 429 for the same profile.
  const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const auth = (init?.headers as Record<string, string> | undefined)?.authorization ?? "";
    calls.push(auth.replace("Bearer token-", ""));
    const res = responses[served] ?? okResponse(usageBody(10, 20));
    served++;
    return res;
  }) as unknown as typeof fetch;

  const provider = new OAuthQuotaProvider({
    fetchImpl,
    listProfiles: () => profiles,
    readCredentials: (dir) => ({ token: `token-${dir.split("-").pop()}`, tier: "max 20x" }),
    log: (line) => logs.push(line),
  });

  return {
    provider,
    tick: () => provider.fetchUsage(now),
    calls,
    logs,
    setNow: (ms) => { now = ms; },
    responses,
  };
}

describe("OAuthQuotaProvider throttling", () => {
  it("sends at most one usage request per tick, round-robin over the due profiles", async () => {
    const h = makeProvider();

    await h.tick();
    expect(h.calls).toEqual(["anth"]);

    await h.tick();
    expect(h.calls).toEqual(["anth", "team"]);

    // Both are now fresh (10% used → a 10-minute interval), so the third tick sends nothing.
    await h.tick();
    expect(h.calls).toEqual(["anth", "team"]);
  });

  it("logs every outbound request, so a 429 the board caused is attributable", async () => {
    const h = makeProvider();
    await h.tick();
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]).toContain("anth");
    expect(h.logs[0]).toContain("200");
  });

  it("still renders EVERY profile from cache on a tick that refreshed one of them", async () => {
    const h = makeProvider();
    const result = await h.tick();
    expect(result.providers.map((p) => p.id)).toEqual(["anth", "team"]);
    // The one that was not polled is `unknown`, never absent and never 0%.
    const team = result.providers.find((p) => p.id === "team")!;
    expect(team.status).toBe("unknown");
    expect(team.ageSeconds).toBeNull();
  });

  it("refreshes a near-cap profile sooner than an idle one", () => {
    const base: QuotaCacheRecord = {
      ts: T0, ok: true, err: null, dataTs: T0, nextTry: 0, tier: null,
      fiveH: 0, fiveHReset: null, sevenD: 0, sevenDReset: null,
    };
    expect(refreshIntervalMs({ ...base, fiveH: 4 })).toBe(600_000);
    expect(refreshIntervalMs({ ...base, fiveH: 55 })).toBe(300_000);
    expect(refreshIntervalMs({ ...base, fiveH: 92 })).toBe(120_000);
    // The 7-day window counts too — whichever is closer to its cap wins.
    expect(refreshIntervalMs({ ...base, fiveH: 4, sevenD: 85 })).toBe(120_000);
  });
});

describe("OAuthQuotaProvider 429 handling", () => {
  it("backs off without marking the profile exhausted, keeping the last good gauges", async () => {
    const h = makeProvider({
      profiles: [PROFILES[0]],
      responses: [okResponse(usageBody(42, 17)), errorResponse(429, "1200")],
    });

    const first = await h.tick();
    expect(first.providers[0].status).toBe("ok");
    expect(first.providers[0].metrics?.[0].percent).toBe(42);

    // Push past the refresh interval so the second tick is genuinely due, then 429.
    h.setNow(T0 + 11 * 60_000);
    const second = await h.tick();
    expect(h.calls).toEqual(["anth", "anth"]);

    const entry = second.providers[0];
    // Not exhausted: the percentages are the last good ones, not 100 and not null.
    expect(entry.metrics?.[0].percent).toBe(42);
    expect(entry.metrics?.[1].percent).toBe(17);
    // Still `ok` (the measurement is 11 minutes old, well inside a reset window) and the
    // failure is disclosed rather than hidden.
    expect(entry.status).toBe("ok");
    expect(entry.error).toContain("http-429");

    // The Retry-After window holds the next request back even once the normal refresh
    // interval (10 minutes at 42% used) has elapsed — the backoff is what keeps the board
    // off a rate-limited endpoint, so it has to outrank the TTL rather than merely match it.
    h.setNow(T0 + 11 * 60_000 + 11 * 60_000);
    await h.tick();
    expect(h.calls).toHaveLength(2);

    h.setNow(T0 + 11 * 60_000 + 1201 * 1000);
    await h.tick();
    expect(h.calls).toHaveLength(3);
  });

  it("honours Retry-After in both the seconds and the HTTP-date form", () => {
    expect(parseRetryAfter("120", T0)).toBe(120);
    expect(parseRetryAfter(new Date(T0 + 90_000).toUTCString(), T0)).toBe(90);
    expect(parseRetryAfter(null, T0)).toBe(0);
    expect(parseRetryAfter("garbage", T0)).toBe(0);
  });

  it("uses a 5-minute default backoff for a 429 with no Retry-After", () => {
    expect(backoffMs("http-429")).toBe(300_000);
    expect(backoffMs("http-429", 45)).toBe(45_000);
    expect(backoffMs("http-503")).toBe(120_000);
    expect(backoffMs("expired")).toBe(120_000);
    expect(backoffMs("net")).toBe(60_000);
  });

  it("never spends a request on a token it already knows is expired", async () => {
    const calls: string[] = [];
    const logs: string[] = [];
    const provider = new OAuthQuotaProvider({
      fetchImpl: (async () => { calls.push("sent"); return okResponse(usageBody(1, 1)); }) as unknown as typeof fetch,
      listProfiles: () => [PROFILES[0]],
      readCredentials: () => ({ err: "expired", tier: "max 5x" }),
      log: (line) => logs.push(line),
    });

    const result = await provider.fetchUsage(T0);
    expect(calls).toEqual([]);
    expect(logs[0]).toContain("no request sent");
    // A dead login is an auth problem the operator can fix, not an exhausted quota.
    expect(result.providers[0].status).toBe("auth");
    expect(result.providers[0].metrics).toEqual([]);
  });
});

describe("measurement age", () => {
  it("reads as `unknown` past one reset window — never exhausted, never empty", async () => {
    const h = makeProvider({ profiles: [PROFILES[0]], responses: [okResponse(usageBody(73, 61))] });
    await h.tick();

    h.setNow(T0 + MEASUREMENT_STALE_MS + 60_000);
    // No further response queued → the fake falls through to a 200, so force staleness by
    // reading the cache through the DTO builder instead of granting a fresh measurement.
    const entry = buildProviderEntry("anth", {
      ts: T0, ok: true, err: null, dataTs: T0, nextTry: 0, tier: "max 20x",
      fiveH: 73, fiveHReset: null, sevenD: 61, sevenDReset: null,
    }, T0 + MEASUREMENT_STALE_MS + 1000);

    expect(entry.status).toBe("unknown");
    expect(entry.stale).toBe(true);
    expect(entry.ageSeconds).toBe(Math.round((MEASUREMENT_STALE_MS + 1000) / 1000));
    // "Never empty": the last-known numbers are still there for a human to judge.
    expect(entry.metrics).toHaveLength(2);
    expect(entry.metrics?.[0].percent).toBe(73);
  });

  it("is `ok` while the measurement is inside the window", () => {
    const entry = buildProviderEntry("anth", {
      ts: T0, ok: true, err: null, dataTs: T0, nextTry: 0, tier: null,
      fiveH: 5, fiveHReset: null, sevenD: 9, sevenDReset: null,
    }, T0 + MEASUREMENT_STALE_MS - 1000);
    expect(entry.status).toBe("ok");
    expect(entry.stale).toBe(false);
  });

  it("is `unknown` when nothing has ever been measured", () => {
    const entry = buildProviderEntry("anth", undefined, T0);
    expect(entry.status).toBe("unknown");
    expect(entry.ageSeconds).toBeNull();
    expect(entry.measuredAt).toBeNull();
    expect(entry.metrics).toEqual([]);
  });
});

describe("wire DTO shape", () => {
  it("carries the fields the client and the Bullseye gate read", async () => {
    const h = makeProvider({ profiles: [PROFILES[0]], responses: [okResponse(usageBody(42, 17))] });
    const result = await h.tick();

    expect(result.scrapedAt).toBe(new Date(T0).toISOString());
    const entry = result.providers[0];
    expect(entry).toMatchObject({
      id: "anth",
      label: "Claude: anth",
      transport: "http",
      hasCreds: true,
      status: "ok",
      plan: "max 20x",
      stale: false,
      ageSeconds: 0,
      measuredAt: new Date(T0).toISOString(),
    });
    expect(typeof entry.accent).toBe("string");
    expect(typeof entry.loginUrl).toBe("string");

    const [fiveH, sevenD] = entry.metrics!;
    expect(fiveH).toMatchObject({
      label: "5-hour window",
      percent: 42,
      resetIso: "2026-09-04T13:00:00.000Z",
      resetInSeconds: 3 * 3600,
      periodMs: 5 * 3600 * 1000,
    });
    expect(sevenD.label).toBe("7-day window");
    expect(sevenD.percent).toBe(17);
  });

  it("`id` is the profile name, so a Bullseye policy pins a profile rather than a browser tab", async () => {
    const h = makeProvider();
    const result = await h.tick();
    expect(result.providers.map((p) => p.id)).toEqual(["anth", "team"]);
  });

  it("derives the plan label from the credential's subscription + rate-limit tier", () => {
    expect(tierOf({ subscriptionType: "max", rateLimitTier: "default_claude_20x" })).toBe("max 20x");
    expect(tierOf({ subscriptionType: "pro" })).toBe("pro");
    expect(tierOf({ rateLimitTier: "something_5x" })).toBe("5x");
    expect(tierOf(null)).toBeNull();
  });
});

describe("mergeRecord", () => {
  it("keeps the last-known gauges and their ORIGINAL measurement time across a failure", () => {
    const prev: QuotaCacheRecord = {
      ts: T0, ok: true, err: null, dataTs: T0, nextTry: 0, tier: "max 20x",
      fiveH: 42, fiveHReset: "x", sevenD: 17, sevenDReset: "y",
    };
    const merged = mergeRecord(prev, {
      ok: false, err: "http-429", retryAfterSec: 30, tier: "max 20x",
      fiveH: null, fiveHReset: null, sevenD: null, sevenDReset: null,
    }, T0 + 60_000);

    expect(merged.fiveH).toBe(42);
    // The AGE anchor must not advance on a failed refresh — otherwise a permanently
    // failing profile would look freshly measured forever.
    expect(merged.dataTs).toBe(T0);
    expect(merged.nextTry).toBe(T0 + 60_000 + 30_000);
  });

  it("does not invent data when the very first fetch fails", () => {
    const merged = mergeRecord(undefined, {
      ok: false, err: "net", retryAfterSec: 0, tier: null,
      fiveH: null, fiveHReset: null, sevenD: null, sevenDReset: null,
    }, T0);
    expect(merged.fiveH).toBeNull();
    expect(merged.dataTs).toBeNull();
  });
});
