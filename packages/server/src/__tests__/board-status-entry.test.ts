import { describe, it, expect } from "vitest";
import {
  parseSessionStats,
  selectLatestRelevantSession,
  buildBoardStatusEntry,
  type BoardStatusEntryIssue,
  type BoardStatusEntryWorkspace,
  type BoardStatusEntrySession,
} from "../lib/board-status-entry.js";

const isNoise = (s: { triggerType?: string | null }) => s.triggerType === "noise";

describe("parseSessionStats", () => {
  it("returns null on malformed JSON", () => {
    expect(parseSessionStats("{bad")).toBeNull();
  });

  it("applies defaults (numTurns 1, model empty string, success false)", () => {
    expect(parseSessionStats("{}")).toEqual({
      durationMs: 0,
      totalCostUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      numTurns: 1,
      model: "",
      success: false,
      agentSummary: undefined,
    });
  });

  it("passes through provided fields incl. agentSummary", () => {
    expect(parseSessionStats(JSON.stringify({ durationMs: 5, model: "opus", success: true, agentSummary: "did x" })))
      .toMatchObject({ durationMs: 5, model: "opus", success: true, agentSummary: "did x" });
  });
});

describe("selectLatestRelevantSession", () => {
  const s = (id: string, triggerType: string | null) => ({ id, triggerType });

  it("prefers the first non-noise session", () => {
    expect(selectLatestRelevantSession([s("noise", "noise"), s("real", null)], isNoise)?.id).toBe("real");
  });

  it("falls back to the first session when all are noise", () => {
    expect(selectLatestRelevantSession([s("n1", "noise"), s("n2", "noise")], isNoise)?.id).toBe("n1");
  });

  it("returns null for an empty list", () => {
    expect(selectLatestRelevantSession([], isNoise)).toBeNull();
  });
});

const issue: BoardStatusEntryIssue = { id: "i1", issueNumber: 7, title: "T", priority: "high", issueType: "feature" };
const ws: BoardStatusEntryWorkspace = {
  id: "w1", branch: "feature/x", status: "idle", workingDir: "/wd", baseBranch: "main", isDirect: false, readyForMerge: false,
};
const sess: BoardStatusEntrySession = { id: "s1", status: "stopped", startedAt: "S", endedAt: "E", stats: null };

describe("buildBoardStatusEntry", () => {
  it("uses the effective status name and starts enriched fields empty/null", () => {
    const e = buildBoardStatusEntry(issue, "In Review", null, null);
    expect(e.statusName).toBe("In Review");
    expect(e.workspace).toBeNull();
    expect(e.session).toBeNull();
    expect(e.sessionStats).toBeNull();
    expect(e.diffStats).toBeNull();
    expect(e.conflicts).toBeNull();
    expect(e.lastOutput).toEqual([]);
    expect(e.attention).toBeNull();
    expect(e.mergeState).toBeNull();
  });

  it("projects workspace and session when present", () => {
    const e = buildBoardStatusEntry(issue, "In Progress", ws, sess);
    expect(e.workspace).toMatchObject({ id: "w1", branch: "feature/x", readyForMerge: false });
    expect(e.session).toEqual({ id: "s1", status: "stopped", startedAt: "S", endedAt: "E" });
  });

  it("parses sessionStats only when the session has a stats blob", () => {
    expect(buildBoardStatusEntry(issue, "x", ws, sess).sessionStats).toBeNull();
    const withStats = buildBoardStatusEntry(issue, "x", ws, { ...sess, stats: JSON.stringify({ numTurns: 4 }) });
    expect(withStats.sessionStats?.numTurns).toBe(4);
  });
});
