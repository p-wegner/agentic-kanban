import { describe, it, expect } from "vitest";
import {
  createInsightsAccumulator,
  accumulateInsightsRow,
  type InsightsAccumulator,
  type AccumulateContext,
} from "../services/insights.service.js";

// Build a session row matching getInsightsSessionRows' projection. `stats` is the
// raw JSON string the accumulator parses, mirroring what the DB column holds.
function row(overrides: {
  sessionId?: string;
  issueId?: string;
  issueType?: string;
  issuePriority?: string;
  model?: string;
  provider?: string;
  profile?: string;
  startedAt?: string;
  exitCode?: string | null;
  success?: boolean;
  cost?: number;
  inputTokens?: number;
  outputTokens?: number;
  contextTokens?: number;
  friction?: { totalToolCalls: number; failedToolCalls: number; errorCount: number; tools?: { tool: string; count: number; failedCount: number }[]; repeatedCommands?: { command: string; count: number }[] };
  stats?: string | null;
}) {
  const stats = overrides.stats !== undefined
    ? overrides.stats
    : JSON.stringify({
        durationMs: 1000,
        totalCostUsd: overrides.cost ?? 0,
        inputTokens: overrides.inputTokens ?? 0,
        outputTokens: overrides.outputTokens ?? 0,
        numTurns: 1,
        model: overrides.model ?? "claude",
        success: overrides.success ?? true,
        ...(overrides.contextTokens !== undefined ? { contextTokens: overrides.contextTokens } : {}),
        ...(overrides.friction ? { friction: overrides.friction } : {}),
      });
  return {
    sessionId: overrides.sessionId ?? "s1",
    workspaceId: "w1",
    stats,
    startedAt: overrides.startedAt ?? "2026-06-20T10:00:00.000Z",
    exitCode: overrides.exitCode ?? null,
    wsModel: null,
    wsSkillId: null,
    wsProvider: overrides.provider ?? "claude",
    wsClaudeProfile: overrides.profile ?? "anth",
    sessionSkillId: null,
    sessionSkillName: null,
    issueType: overrides.issueType ?? "feature",
    issuePriority: overrides.issuePriority ?? "medium",
    issueTitle: "Title",
    issueNumber: 1,
    issueId: overrides.issueId ?? "i1",
    skillName: null,
  };
}

const ctx: AccumulateContext = {
  fallbackStartedAtIso: "2026-06-20T23:59:59.000Z",
  contextWindowFromIso: "2026-06-14T00:00:00.000Z",
};

function fold(rows: ReturnType<typeof row>[]): InsightsAccumulator {
  const acc = createInsightsAccumulator();
  for (const r of rows) accumulateInsightsRow(acc, r, ctx);
  return acc;
}

describe("accumulateInsightsRow", () => {
  it("counts sessions, successes, cost and tokens", () => {
    const acc = fold([
      row({ success: true, cost: 1.5, inputTokens: 100, outputTokens: 50 }),
      row({ success: false, cost: 0.5, inputTokens: 10, outputTokens: 5 }),
      row({ success: false, exitCode: "0", cost: 0.25 }), // exitCode 0 counts as success
    ]);
    expect(acc.sessionCount).toBe(3);
    expect(acc.successCount).toBe(2);
    expect(acc.totalCostUsd).toBeCloseTo(2.25);
    expect(acc.totalTokens).toBe(165);
  });

  it("groups by model and de-duplicated issue-type / priority buckets", () => {
    const acc = fold([
      row({ model: "opus", issueType: "feature", issuePriority: "high", cost: 1 }),
      row({ model: "opus", issueType: "bug", issuePriority: "high", cost: 2 }),
      row({ model: "haiku", issueType: "feature", issuePriority: "low", cost: 3 }),
    ]);
    expect(acc.byModel.get("opus")?.sessionCount).toBe(2);
    expect(acc.byModel.get("haiku")?.sessionCount).toBe(1);
    expect(acc.byIssueType.get("feature")?.sessionCount).toBe(2);
    expect(acc.byIssueType.get("bug")?.totalCostUsd).toBe(2);
    expect(acc.byPriority.get("high")?.sessionCount).toBe(2);
    expect(acc.byPriority.get("low")?.totalCostUsd).toBe(3);
  });

  it("rolls up friction across sessions that carry it", () => {
    const acc = fold([
      row({
        friction: {
          totalToolCalls: 10, failedToolCalls: 2, errorCount: 1,
          tools: [{ tool: "Bash", count: 6, failedCount: 2 }],
          repeatedCommands: [{ command: "pnpm test", count: 3 }],
        },
      }),
      row({ friction: { totalToolCalls: 5, failedToolCalls: 1, errorCount: 0, tools: [{ tool: "Bash", count: 5, failedCount: 1 }] } }),
      row({}), // no friction
    ]);
    expect(acc.sessionsWithFriction).toBe(2);
    expect(acc.frictionTotalToolCalls).toBe(15);
    expect(acc.frictionFailedToolCalls).toBe(3);
    expect(acc.frictionByTool.get("Bash")).toEqual({ calls: 11, failed: 3 });
    expect(acc.repeatedCommandAgg.get("pnpm test")).toEqual({ count: 3, sessions: 1 });
  });

  it("counts context tokens only for sessions inside the 7-day window", () => {
    const acc = fold([
      row({ issueId: "i1", startedAt: "2026-06-20T10:00:00.000Z", contextTokens: 1000 }),
      row({ issueId: "i1", startedAt: "2026-06-19T10:00:00.000Z", contextTokens: 500 }),
      row({ issueId: "i2", startedAt: "2026-06-01T10:00:00.000Z", contextTokens: 9999 }), // before window
    ]);
    expect(acc.contextWindowTotalTokens).toBe(1500);
    expect(acc.contextByIssue.get("i1")?.contextTokens).toBe(1500);
    expect(acc.contextByIssue.get("i1")?.sessionCount).toBe(2);
    expect(acc.contextByIssue.has("i2")).toBe(false);
  });

  it("ignores rows with unparseable stats for cost/token totals", () => {
    const acc = fold([row({ stats: null }), row({ stats: "not json" })]);
    expect(acc.sessionCount).toBe(2);
    expect(acc.successCount).toBe(0);
    expect(acc.totalCostUsd).toBe(0);
  });

  it("buckets the time series by UTC date and rolls up cost per day", () => {
    const acc = fold([
      row({ startedAt: "2026-06-20T01:00:00.000Z", cost: 1, success: true }),
      row({ startedAt: "2026-06-20T23:30:00.000Z", cost: 2, success: false }),
      row({ startedAt: "2026-06-19T12:00:00.000Z", cost: 4, success: true }),
    ]);
    expect(acc.timeSeries.get("2026-06-20")).toMatchObject({ sessionCount: 2, successCount: 1, totalCostUsd: 3 });
    expect(acc.timeSeries.get("2026-06-19")).toMatchObject({ sessionCount: 1, successCount: 1, totalCostUsd: 4 });
  });

  it("captures only stat-bearing sessions in the top-expensive list", () => {
    const acc = fold([
      row({ sessionId: "a", cost: 5, inputTokens: 10, outputTokens: 5, model: "opus" }),
      row({ sessionId: "b", stats: null }), // no stats -> not captured
    ]);
    expect(acc.topExpensive).toHaveLength(1);
    expect(acc.topExpensive[0]).toMatchObject({ sessionId: "a", totalCostUsd: 5, totalTokens: 15, model: "opus" });
  });

  it("groups provider/profile pairs into one bucket", () => {
    const acc = fold([
      row({ provider: "claude", profile: "anth", cost: 1 }),
      row({ provider: "claude", profile: "anth", cost: 2 }),
      row({ provider: "codex", profile: "default", cost: 4 }),
    ]);
    expect(acc.byProviderProfile.get("claude::anth")?.sessionCount).toBe(2);
    expect(acc.byProviderProfile.get("claude::anth")?.totalCostUsd).toBe(3);
    expect(acc.byProviderProfile.get("codex::default")?.sessionCount).toBe(1);
  });
});
