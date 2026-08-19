import { describe, it, expect } from "vitest";
import {
  readUsageLimitStats,
  isUsageLimitStatsOf,
  buildUsageLimitStats,
  USAGE_LIMIT_KINDS,
} from "../src/lib/session-stats-blob.js";

describe("usage-limit stats (#542)", () => {
  it("round-trips every provider through build → read", () => {
    for (const kind of USAGE_LIMIT_KINDS) {
      const blob = JSON.stringify(buildUsageLimitStats(kind, {
        executor: "claude-code",
        durationMs: 1234,
        exitCode: 1,
        message: "usage limit reached",
        retryAfter: "2026-06-20T00:00:00.000Z",
      }));
      expect(readUsageLimitStats(blob)).toEqual({ kind, retryAfter: "2026-06-20T00:00:00.000Z" });
      expect(isUsageLimitStatsOf(blob, kind)).toBe(true);
      for (const other of USAGE_LIMIT_KINDS.filter((k) => k !== kind)) {
        expect(isUsageLimitStatsOf(blob, other)).toBe(false);
      }
    }
  });

  it("marks the blob as a failed launch so the existing readers still see it", () => {
    const stats = buildUsageLimitStats("codex", {
      executor: "codex", durationMs: 0, exitCode: null, message: "quota", retryAfter: null,
    });
    expect(stats.launchFailure).toBe(true);
    expect(stats.success).toBe(false);
    expect(stats.rateLimited).toBe(true);
    expect(stats.failureReason).toBe("quota");
    expect(stats.retryAfter).toBeNull();
  });

  it("is null for anything that is not a usage-limit death", () => {
    expect(readUsageLimitStats(null)).toBeNull();
    expect(readUsageLimitStats("not json")).toBeNull();
    expect(readUsageLimitStats(JSON.stringify({ success: true }))).toBeNull();
    // rateLimited without a recognised kind: a provider we do not model yet.
    expect(readUsageLimitStats(JSON.stringify({ rateLimited: true, rateLimitKind: "gemini-usage-limit" }))).toBeNull();
    // A kind without the flag: never written, and not treated as a limit.
    expect(readUsageLimitStats(JSON.stringify({ rateLimitKind: "codex-usage-limit" }))).toBeNull();
  });

  it("reports a missing or non-string reset time as null rather than passing it through", () => {
    const blob = JSON.stringify({ rateLimited: true, rateLimitKind: "claude-usage-limit", retryAfter: 12345 });
    expect(readUsageLimitStats(blob)).toEqual({ kind: "claude", retryAfter: null });
  });
});
