import { describe, it, expect, vi } from "vitest";
import { classifyQuotaBlock, QUOTA_BLOCK_PROBE_FALLBACK_MS } from "../services/monitor-cycle-rules.js";
import { buildUsageLimitStats } from "@agentic-kanban/shared/lib/session-stats-blob";

/**
 * #1139: a `retryAfter` that is unparseable, or parses to a time already in the past, used
 * to be handled silently — the monitor log then showed a fresh 6h deadline with nothing
 * distinguishing it from a genuine provider-reported reset. Both cases now warn, so the
 * evidence behind a quota block is visible instead of reading identically to a real one.
 */
describe("classifyQuotaBlock evidence logging (#1139)", () => {
  it("warns and releases immediately when retryAfter parses but is already in the past", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const stats = JSON.stringify(buildUsageLimitStats("codex", {
      executor: "codex", durationMs: 1000, exitCode: 1, message: "usage limit reached",
      retryAfter: "2020-01-01T00:00:00.000Z",
    }));
    const nowMs = Date.now();
    const block = classifyQuotaBlock({ stats, startedAt: new Date(nowMs).toISOString() }, nowMs);
    expect(block?.expired).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("already in the past"));
    warn.mockRestore();
  });

  it("warns and falls back to the probe window when retryAfter does not parse as a time", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const stats = JSON.stringify(buildUsageLimitStats("codex", {
      executor: "codex", durationMs: 1000, exitCode: 1, message: "usage limit reached",
      retryAfter: "not a real date",
    }));
    const nowMs = Date.now();
    const startedAt = new Date(nowMs).toISOString();
    const block = classifyQuotaBlock({ stats, startedAt }, nowMs);
    expect(block?.releaseAt).toBe(new Date(nowMs + QUOTA_BLOCK_PROBE_FALLBACK_MS).toISOString());
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("did not parse as a time"));
    warn.mockRestore();
  });

  it("does not warn for a genuine future retryAfter", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const nowMs = Date.now();
    const future = new Date(nowMs + 60_000).toISOString();
    const stats = JSON.stringify(buildUsageLimitStats("codex", {
      executor: "codex", durationMs: 1000, exitCode: 1, message: "usage limit reached", retryAfter: future,
    }));
    const block = classifyQuotaBlock({ stats, startedAt: new Date(nowMs).toISOString() }, nowMs);
    expect(block?.expired).toBe(false);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
