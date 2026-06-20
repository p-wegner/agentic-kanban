import { describe, it, expect } from "vitest";
import type { IssueWithStatus, StatusWithIssues } from "@agentic-kanban/shared";
import type { TodoItem } from "./useBoardEvents.js";
import {
  formatDuration,
  formatTokens,
  resolveCardConfig,
  summarizeTodos,
  resolveContextTokens,
  buildDisplayHistory,
  resolveActivityText,
  isAttentionAgent,
  selectVisibleAgents,
  partitionAgents,
  computeAgentCounts,
  computeEmptySlotCount,
  computeGridSizing,
  WS_STATUS_CONFIG,
} from "./agentGridView.js";

type WsMain = Partial<NonNullable<NonNullable<IssueWithStatus["workspaceSummary"]>["main"]>>;
function agent(id: string, ws: WsMain | null): IssueWithStatus {
  return { id, statusId: "s", workspaceSummary: ws ? { main: ws } : undefined } as unknown as IssueWithStatus;
}
function todo(status: TodoItem["status"], content = "x"): TodoItem {
  return { content, status } as TodoItem;
}

describe("formatters", () => {
  it("formatDuration", () => {
    expect(formatDuration(5_000)).toBe("5s");
    expect(formatDuration(65_000)).toBe("1m 5s");
    expect(formatDuration(3_725_000)).toBe("1h 2m");
  });
  it("formatTokens", () => {
    expect(formatTokens(500)).toBe("500");
    expect(formatTokens(1500)).toBe("1.5k");
    expect(formatTokens(2_500_000)).toBe("2.5M");
  });
});

describe("resolveCardConfig", () => {
  it("returns the status config, falling back to idle for unknown status", () => {
    expect(resolveCardConfig("active").label).toBe("Active");
    expect(resolveCardConfig("nonsense")).toBe(WS_STATUS_CONFIG.idle);
  });
  it("overlays attention config (label/dot/ring/header) but keeps the base tier", () => {
    const cfg = resolveCardConfig("idle", "merge");
    expect(cfg.label).toBe("Ready to merge");
    expect(cfg.dot).toBe("bg-emerald-500");
    expect(cfg.tier).toBe("background");
  });
});

describe("summarizeTodos", () => {
  it("counts done/total and picks in-progress + pending", () => {
    const s = summarizeTodos([todo("completed"), todo("completed"), todo("in_progress", "now"), todo("pending", "next")]);
    expect(s).toMatchObject({ done: 2, total: 4 });
    expect(s.inProgress?.content).toBe("now");
    expect(s.pending.map((t) => t.content)).toEqual(["next"]);
  });
  it("handles undefined", () => {
    expect(summarizeTodos()).toEqual({ done: 0, total: 0, inProgress: undefined, pending: [] });
  });
});

describe("resolveContextTokens", () => {
  it("prefers live stats, then summary, then 0", () => {
    expect(resolveContextTokens({ contextTokens: 10 } as never, { contextTokens: 20 })).toBe(10);
    expect(resolveContextTokens(undefined, { contextTokens: 20 })).toBe(20);
    expect(resolveContextTokens(undefined, { contextTokens: null })).toBe(0);
  });
});

describe("buildDisplayHistory / resolveActivityText", () => {
  it("history prefers live lines, then last message, then last tool", () => {
    expect(buildDisplayHistory(["a", "b"], { lastAssistantMessage: "m", lastTool: "Edit" })).toEqual(["a", "b"]);
    expect(buildDisplayHistory([], { lastAssistantMessage: "m", lastTool: "Edit" })).toEqual(["m"]);
    expect(buildDisplayHistory([], { lastAssistantMessage: null, lastTool: "Edit" })).toEqual(["Last: Edit"]);
    expect(buildDisplayHistory([], { lastAssistantMessage: null, lastTool: null })).toEqual([]);
  });
  it("activity text prefers current, then message, then tool, else null", () => {
    expect(resolveActivityText("live", { lastAssistantMessage: "m", lastTool: "Edit" })).toBe("live");
    expect(resolveActivityText(undefined, { lastAssistantMessage: "m", lastTool: "Edit" })).toBe("m");
    expect(resolveActivityText(undefined, { lastAssistantMessage: null, lastTool: "Edit" })).toBe("Last: Edit");
    expect(resolveActivityText(undefined, { lastAssistantMessage: null, lastTool: null })).toBeNull();
  });
});

describe("isAttentionAgent", () => {
  it("is true only for idle + ready-to-merge or conflicting", () => {
    expect(isAttentionAgent(agent("a", { status: "idle", readyForMerge: true }))).toBe(true);
    expect(isAttentionAgent(agent("a", { status: "idle", conflicts: { hasConflicts: true, conflictingFiles: [] } }))).toBe(true);
    expect(isAttentionAgent(agent("a", { status: "idle" }))).toBe(false);
    expect(isAttentionAgent(agent("a", { status: "active", readyForMerge: true }))).toBe(false);
  });
});

describe("selectVisibleAgents", () => {
  const cols = (issues: IssueWithStatus[]): StatusWithIssues[] => [{ id: "c", name: "C", issues } as unknown as StatusWithIssues];

  it("drops closed and plan-only-noise workspaces", () => {
    const out = selectVisibleAgents(cols([
      agent("keep", { status: "active" }),
      agent("closed", { status: "closed" }),
      agent("noise", { status: "idle", planOnlyWarning: true }),
      agent("none", null),
    ]), {});
    expect(out.map((i) => i.id)).toEqual(["keep"]);
  });

  it("keeps a plan-only idle workspace that still needs a merge", () => {
    const out = selectVisibleAgents(cols([agent("merge", { status: "idle", planOnlyWarning: true, readyForMerge: true })]), {});
    expect(out.map((i) => i.id)).toEqual(["merge"]);
  });

  it("sorts by status order, then by live activity", () => {
    const out = selectVisibleAgents(cols([
      agent("idle", { status: "idle" }),
      agent("active", { status: "active" }),
      agent("fixing", { status: "fixing" }),
    ]), {});
    expect(out.map((i) => i.id)).toEqual(["active", "fixing", "idle"]);
  });
});

describe("partitionAgents + counts", () => {
  const agents = [
    agent("merge", { status: "idle", readyForMerge: true }),
    agent("active", { status: "active" }),
    agent("fixing", { status: "fixing" }),
    agent("reviewing", { status: "reviewing" }),
    agent("idle", { status: "idle" }),
  ];
  it("partitions attention > live > background", () => {
    const p = partitionAgents(agents);
    expect(p.attention.map((i) => i.id)).toEqual(["merge"]);
    expect(p.live.map((i) => i.id)).toEqual(["active", "fixing"]);
    expect(p.background.map((i) => i.id)).toEqual(["reviewing", "idle"]);
  });
  it("computes section counts", () => {
    expect(computeAgentCounts(partitionAgents(agents))).toEqual({ attentionCount: 1, liveCount: 2, reviewingCount: 1, idleCount: 1 });
  });
});

describe("computeEmptySlotCount", () => {
  const active = [agent("a", { status: "active" }), agent("b", { status: "fixing" })];
  it("is 0 without a drop handler or target", () => {
    expect(computeEmptySlotCount(active, 5, false)).toBe(0);
    expect(computeEmptySlotCount(active, undefined, true)).toBe(0);
  });
  it("is capacity minus active, capped at 3", () => {
    expect(computeEmptySlotCount(active, 4, true)).toBe(2);
    expect(computeEmptySlotCount(active, 20, true)).toBe(3);
    expect(computeEmptySlotCount(active, 2, true)).toBe(0);
  });
});

describe("computeGridSizing", () => {
  const mk = (n: number, status: string) => Array.from({ length: n }, (_, i) => agent(`${status}${i}`, { status }));
  it("scales featured/compact min px by counts", () => {
    const s1 = computeGridSizing({ attention: [], live: mk(2, "active"), background: [] }, 0);
    expect(s1).toMatchObject({ featuredCount: 2, featuredMinPx: 320 });
    const s2 = computeGridSizing({ attention: [], live: mk(5, "active"), background: mk(13, "idle") }, 0);
    expect(s2).toMatchObject({ featuredMinPx: 240, compactMinPx: 165 });
  });
  it("includes empty slots in the featured count", () => {
    expect(computeGridSizing({ attention: [], live: mk(1, "active"), background: [] }, 4).featuredCount).toBe(5);
  });
});
