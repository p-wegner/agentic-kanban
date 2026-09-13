import { describe, it, expect, vi } from "vitest";
import { buildUsageLimitStats } from "@agentic-kanban/shared/lib/session-stats-blob";
import { findUsageLimitProvider } from "../startup/exit/usage-limit-exit.js";

/**
 * #1139: `findUsageLimitProvider` reads the `rateLimitKind` discriminant off a session's
 * stats blob and, until this fix, trusted it unconditionally — so a `codex-usage-limit`
 * kind persisted on a session that was actually launched as `claude-code` (a misfired
 * detector, not a real quota hit — see broadcast-usage-limit-provider-gate.test.ts for the
 * write-side bug that produced exactly this shape) was honoured, parking the workspace
 * `blocked` for a provider whose account was never touched.
 *
 * The launch's own `launch.provider` field (written once at session insert time and
 * preserved verbatim through every exit-time stats merge) is the ground truth this checks
 * the kind against.
 */
function statsWithLaunchProvider(kind: "codex" | "claude", launchProvider: string): string {
  const built = buildUsageLimitStats(kind, {
    executor: launchProvider,
    durationMs: 1000,
    exitCode: 1,
    message: "usage limit reached",
    retryAfter: null,
  });
  return JSON.stringify({ launch: { provider: launchProvider }, ...built });
}

describe("findUsageLimitProvider provider-consistency guard (#1139)", () => {
  it("honours a codex-usage-limit kind on a session actually launched as codex", () => {
    const cfg = findUsageLimitProvider(statsWithLaunchProvider("codex", "codex"));
    expect(cfg?.kind).toBe("codex");
  });

  it("honours a claude-usage-limit kind on a session actually launched as claude-code", () => {
    const cfg = findUsageLimitProvider(statsWithLaunchProvider("claude", "claude-code"));
    expect(cfg?.kind).toBe("claude");
  });

  it("refuses a codex-usage-limit kind on a session launched as claude-code", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cfg = findUsageLimitProvider(statsWithLaunchProvider("codex", "claude-code"));
    expect(cfg).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("refusing codex-usage-limit classification"));
    warn.mockRestore();
  });

  it("refuses a claude-usage-limit kind on a session launched as codex", () => {
    const cfg = findUsageLimitProvider(statsWithLaunchProvider("claude", "codex"));
    expect(cfg).toBeUndefined();
  });

  it("still classifies when the blob predates the launch.provider field (no ground truth to contradict it)", () => {
    const built = buildUsageLimitStats("codex", {
      executor: "codex", durationMs: 1000, exitCode: 1, message: "usage limit reached", retryAfter: null,
    });
    const cfg = findUsageLimitProvider(JSON.stringify(built));
    expect(cfg?.kind).toBe("codex");
  });

  it("returns undefined for stats that are not a usage-limit death at all", () => {
    expect(findUsageLimitProvider(JSON.stringify({ success: true }))).toBeUndefined();
    expect(findUsageLimitProvider(null)).toBeUndefined();
  });
});
