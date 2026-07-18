import { describe, it, expect } from "vitest";
import type { CrossRepoActivityEntry } from "./crossRepoActivity.js";
import type { AgentStallSignal } from "./detectAgentStall.js";
import {
  normalizeCrossRepoEntry,
  normalizeStallSignal,
  normalizeAgentQuestion,
  normalizeStatusTransition,
  mergeFlightRecorderEvents,
  filterFlightRecorderEvents,
  collectFlightRecorderFacets,
  type FlightRecorderEvent,
} from "./flightRecorderEvents.js";

const T0 = Date.parse("2026-07-18T10:00:00.000Z");
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();

function crossRepo(over: Partial<CrossRepoActivityEntry> = {}): CrossRepoActivityEntry {
  return {
    id: "ws1:auth-svc:repo_merged",
    timestamp: at(1),
    repo: "auth-svc",
    kind: "repo_merged",
    summary: "#42 auth-svc merged into main",
    workspaceId: "ws1",
    issueId: "issue-42",
    issueNumber: 42,
    ...over,
  };
}

describe("normalizeCrossRepoEntry", () => {
  it("maps a merge to an info 'merge' event with a transcript target", () => {
    const ev = normalizeCrossRepoEntry(crossRepo());
    expect(ev).toMatchObject({
      id: "crossrepo:ws1:auth-svc:repo_merged",
      kind: "merge",
      severity: "info",
      repo: "auth-svc",
      workspaceId: "ws1",
      issueNumber: 42,
      summary: "#42 auth-svc merged into main",
    });
    expect(ev.transcript).toEqual({ workspaceId: "ws1", issueId: "issue-42", sessionId: null });
  });

  it("maps stranded → warn merge_failure and conflict appeared → error conflict", () => {
    const stranded = normalizeCrossRepoEntry(
      crossRepo({ id: "ws1:api:repo_stranded", kind: "repo_stranded", repo: "api" }),
    );
    expect(stranded).toMatchObject({ kind: "merge_failure", severity: "warn" });

    const conflict = normalizeCrossRepoEntry(
      crossRepo({ id: "ws1:api:conflict_appeared", kind: "conflict_appeared", repo: "api" }),
    );
    expect(conflict).toMatchObject({ kind: "conflict", severity: "error" });
  });
});

describe("normalizeStallSignal", () => {
  const base = { workspaceId: "ws1", issueId: "issue-7", issueNumber: 7, issueTitle: "Fix login", at: at(2) };

  it("returns null for a healthy agent", () => {
    const ok: AgentStallSignal = { state: "ok", idleSec: 3 };
    expect(normalizeStallSignal({ ...base, signal: ok })).toBeNull();
  });

  it("normalizes a stalled agent to a warn 'stall' event", () => {
    const signal: AgentStallSignal = { state: "stalled", idleSec: 300 };
    const ev = normalizeStallSignal({ ...base, signal, sessionId: "sess-1" });
    expect(ev).toMatchObject({ kind: "stall", severity: "warn", id: "stall:ws1:stall" });
    expect(ev?.summary).toContain("#7 Fix login");
    expect(ev?.summary).toContain("5m");
    expect(ev?.transcript?.sessionId).toBe("sess-1");
  });

  it("normalizes a looping agent to a warn 'loop' event naming the repeated tool", () => {
    const signal: AgentStallSignal = { state: "looping", idleSec: 10, repeatedTool: "Bash(ls)", repeatCount: 5 };
    const ev = normalizeStallSignal({ ...base, signal });
    expect(ev).toMatchObject({ kind: "loop", severity: "warn" });
    expect(ev?.summary).toContain("Bash(ls)");
    expect(ev?.summary).toContain("×5");
  });
});

describe("normalizeAgentQuestion", () => {
  it("maps a pending question to a warn 'agent_question' event and links to the session", () => {
    const ev = normalizeAgentQuestion(
      {
        toolUseId: "tool-9",
        workspaceId: "ws2",
        sessionId: "sess-9",
        issueId: "issue-9",
        issueNumber: 9,
        issueTitle: "Add search",
        header: "Pick a strategy",
        question: "Which index?",
        questionCount: 2,
        askedAt: at(3),
      },
      at(5),
    );
    expect(ev).toMatchObject({
      id: "question:tool-9",
      kind: "agent_question",
      severity: "warn",
      timestamp: at(3),
    });
    expect(ev.summary).toContain("#9 Add search");
    expect(ev.summary).toContain("Pick a strategy");
    expect(ev.summary).toContain("+1 more");
    expect(ev.transcript).toEqual({ workspaceId: "ws2", issueId: "issue-9", sessionId: "sess-9" });
  });

  it("uses fallbackAt when askedAt is missing and drops stale asks to info", () => {
    const ev = normalizeAgentQuestion(
      {
        toolUseId: "tool-1",
        workspaceId: "ws2",
        issueId: null,
        issueNumber: null,
        question: "Proceed?",
        isApproval: true,
        askedAt: null,
        staleLabel: "stale — workspace merged",
      },
      at(8),
    );
    expect(ev.timestamp).toBe(at(8));
    expect(ev.severity).toBe("info");
    expect(ev.kind).toBe("approval_request");
    expect(ev.summary).toContain("approval request");
    expect(ev.summary).toContain("stale — workspace merged");
  });
});

describe("normalizeStatusTransition", () => {
  it("returns null when the status did not change", () => {
    expect(
      normalizeStatusTransition({ workspaceId: "ws1", issueId: null, issueNumber: null, from: "active", to: "active", at: at(1) }),
    ).toBeNull();
  });

  it("surfaces a transition into an error status as a red tool_error", () => {
    const ev = normalizeStatusTransition({
      workspaceId: "ws1", issueId: "i1", issueNumber: 1, from: "active", to: "error", at: at(1),
    });
    expect(ev).toMatchObject({ kind: "tool_error", severity: "error" });
    expect(ev?.summary).toContain("active → error");
  });

  it("surfaces a blocked status as a warn status_transition and others as info", () => {
    expect(
      normalizeStatusTransition({ workspaceId: "ws1", issueId: null, issueNumber: null, from: "active", to: "blocked", at: at(1) }),
    ).toMatchObject({ kind: "status_transition", severity: "warn" });
    expect(
      normalizeStatusTransition({ workspaceId: "ws1", issueId: null, issueNumber: null, from: "active", to: "reviewing", at: at(1) }),
    ).toMatchObject({ kind: "status_transition", severity: "info" });
  });
});

describe("mergeFlightRecorderEvents", () => {
  it("merges heterogeneous sources into one newest-first timeline", () => {
    const cross = normalizeCrossRepoEntry(crossRepo({ timestamp: at(1) }));
    const stall = normalizeStallSignal({
      workspaceId: "ws1", issueId: "i", issueNumber: 1, at: at(5),
      signal: { state: "stalled", idleSec: 300 },
    })!;
    const question = normalizeAgentQuestion(
      { toolUseId: "t", workspaceId: "ws2", issueId: null, issueNumber: null, question: "?", askedAt: at(3) },
      at(3),
    );
    const merged = mergeFlightRecorderEvents([[cross], [stall], [question]]);
    expect(merged.map((e) => e.timestamp)).toEqual([at(5), at(3), at(1)]);
  });

  it("dedupes a repeated id, keeping the newest observation", () => {
    const older = normalizeStallSignal({
      workspaceId: "ws1", issueId: "i", issueNumber: 1, at: at(1),
      signal: { state: "stalled", idleSec: 60 },
    })!;
    const newer = normalizeStallSignal({
      workspaceId: "ws1", issueId: "i", issueNumber: 1, at: at(9),
      signal: { state: "stalled", idleSec: 540 },
    })!;
    expect(older.id).toBe(newer.id);
    const merged = mergeFlightRecorderEvents([[older], [newer]]);
    expect(merged).toHaveLength(1);
    expect(merged[0].timestamp).toBe(at(9));
    expect(merged[0].summary).toContain("9m");
  });

  it("caps the timeline to the requested window", () => {
    const many: FlightRecorderEvent[] = Array.from({ length: 10 }, (_, i) =>
      normalizeCrossRepoEntry(crossRepo({ id: `ws1:r${i}:repo_merged`, timestamp: at(i) })),
    );
    expect(mergeFlightRecorderEvents([many], 3)).toHaveLength(3);
  });
});

describe("filterFlightRecorderEvents", () => {
  const events = mergeFlightRecorderEvents([
    [
      normalizeCrossRepoEntry(crossRepo({ id: "ws1:auth:conflict_appeared", kind: "conflict_appeared", repo: "auth", timestamp: at(4), workspaceId: "ws1" })),
      normalizeCrossRepoEntry(crossRepo({ id: "ws2:api:repo_merged", kind: "repo_merged", repo: "api", timestamp: at(3), workspaceId: "ws2", issueNumber: 2 })),
    ],
    [
      normalizeStallSignal({ workspaceId: "ws1", issueId: "i1", issueNumber: 1, at: at(2), signal: { state: "stalled", idleSec: 300 } })!,
    ],
  ]);

  it("filters by workspace", () => {
    const out = filterFlightRecorderEvents(events, { workspaceId: "ws1" });
    expect(out.map((e) => e.id).sort()).toEqual(["crossrepo:ws1:auth:conflict_appeared", "stall:ws1:stall"]);
  });

  it("filters by repo, excluding workspace-wide (null-repo) events", () => {
    const out = filterFlightRecorderEvents(events, { repo: "auth" });
    expect(out).toHaveLength(1);
    expect(out[0].repo).toBe("auth");
    // The ws1 stall (repo === null) is excluded by a repo filter.
    expect(out.some((e) => e.kind === "stall")).toBe(false);
  });

  it("filters by severity", () => {
    expect(filterFlightRecorderEvents(events, { severity: "error" }).map((e) => e.kind)).toEqual(["conflict"]);
    expect(filterFlightRecorderEvents(events, { severity: "warn" }).map((e) => e.kind)).toEqual(["stall"]);
  });

  it("combines dimensions and treats null/undefined as unconstrained", () => {
    expect(filterFlightRecorderEvents(events, { workspaceId: "ws1", severity: "warn" }).map((e) => e.id)).toEqual(["stall:ws1:stall"]);
    expect(filterFlightRecorderEvents(events, {})).toHaveLength(3);
    expect(filterFlightRecorderEvents(events, { workspaceId: null, repo: null, severity: null })).toHaveLength(3);
  });
});

describe("collectFlightRecorderFacets", () => {
  it("derives distinct workspaces, repos, and severities present", () => {
    const events = mergeFlightRecorderEvents([
      [
        normalizeCrossRepoEntry(crossRepo({ id: "ws1:auth:conflict_appeared", kind: "conflict_appeared", repo: "auth", workspaceId: "ws1", issueNumber: 1 })),
        normalizeCrossRepoEntry(crossRepo({ id: "ws2:api:repo_merged", kind: "repo_merged", repo: "api", workspaceId: "ws2", issueNumber: 2 })),
      ],
    ]);
    const facets = collectFlightRecorderFacets(events);
    expect(facets.repos).toEqual(["api", "auth"]);
    expect(facets.workspaces.map((w) => w.id).sort()).toEqual(["ws1", "ws2"]);
    expect(facets.severities).toEqual(["error", "info"]);
  });
});
