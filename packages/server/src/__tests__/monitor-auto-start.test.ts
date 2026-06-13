import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db/index.js", () => ({
  db: {
    select: vi.fn(),
  },
}));

import { db } from "../db/index.js";
import { runAutoStart, type AutoStartDeps } from "../startup/monitor-auto-start.js";

function makeSelectChain(result: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const fn of ["from", "where", "innerJoin", "leftJoin", "orderBy"]) {
    chain[fn] = () => chain;
  }
  chain.limit = () => Promise.resolve(result);
  chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  chain.catch = (fn: (e: unknown) => unknown) => Promise.resolve(result).catch(fn);
  return chain;
}

function makeDeps(overrides: Partial<AutoStartDeps> = {}): AutoStartDeps {
  return {
    serverPort: 3001,
    boardEvents: { broadcast: vi.fn() } as unknown as AutoStartDeps["boardEvents"],
    logMonitorAction: vi.fn(),
    allowProject: () => true,
    ...overrides,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.stubGlobal("fetch", vi.fn());
});

describe("runAutoStart dependency resolution (blocker must be MERGED, not just terminal)", () => {
  // Mock prefix for: 1 In-Progress status, 0 In-Progress issues, 1 Todo issue with 1 blocker.
  // The final two mocks are blockerIssues + the open-workspace check.
  function mockUpToDepCheck(blockerRow: Record<string, unknown>, openWsRows: unknown[]) {
    vi.mocked(db.select)
      .mockReturnValueOnce(makeSelectChain([{ id: "ip-1", projectId: "proj-1" }]) as ReturnType<typeof db.select>) // inProgressStatuses
      .mockReturnValueOnce(makeSelectChain([{ count: 0 }]) as ReturnType<typeof db.select>) // loop1 activeWip
      .mockReturnValueOnce(makeSelectChain([]) as ReturnType<typeof db.select>) // loop1 inProgressIssues (none)
      .mockReturnValueOnce(makeSelectChain([{ count: 0 }]) as ReturnType<typeof db.select>) // loop2 inProgressCount
      .mockReturnValueOnce(makeSelectChain([{ id: "todo-1" }]) as ReturnType<typeof db.select>) // todoStatus
      .mockReturnValueOnce(makeSelectChain([{ id: "issue-1", title: "Dependent", projectId: "proj-1", issueNumber: 42 }]) as ReturnType<typeof db.select>) // todoIssues
      .mockReturnValueOnce(makeSelectChain([{ id: "done-1" }]) as ReturnType<typeof db.select>) // doneStatuses
      .mockReturnValueOnce(makeSelectChain([]) as ReturnType<typeof db.select>) // existingWs (none)
      .mockReturnValueOnce(makeSelectChain([]) as ReturnType<typeof db.select>) // no-auto-start tag (none)
      .mockReturnValueOnce(makeSelectChain([{ dependsOnId: "blocker-1" }]) as ReturnType<typeof db.select>) // deps
      .mockReturnValueOnce(makeSelectChain([blockerRow]) as ReturnType<typeof db.select>) // blockerIssues
      .mockReturnValueOnce(makeSelectChain(openWsRows) as ReturnType<typeof db.select>); // open-workspace check
  }

  it("does NOT start a dependent whose blocker is Done but not yet merged (open workspace)", async () => {
    mockUpToDepCheck({ id: "blocker-1", statusId: "done-1", currentNodeId: null, currentNodeType: null }, [{ issueId: "blocker-1" }]);
    await runAutoStart(new Map([["nudge_auto_start", "true"], ["nudge_wip_limit", "5"]]), makeDeps());
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("starts a dependent once its blocker is terminal AND merged (no open workspace)", async () => {
    mockUpToDepCheck({ id: "blocker-1", statusId: "done-1", currentNodeId: null, currentNodeType: null }, []);
    vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({ id: "ws-new" }) } as Response);
    await runAutoStart(new Map([["nudge_auto_start", "true"], ["nudge_wip_limit", "5"]]), makeDeps());
    expect(vi.mocked(fetch)).toHaveBeenCalledWith("http://127.0.0.1:3001/api/workspaces", expect.any(Object));
  });

  it("does not start a dependent whose workflow blocker is on a non-end node and non-terminal status", async () => {
    mockUpToDepCheck({ id: "blocker-1", statusId: "inprog-1", currentNodeId: "node-build", currentNodeType: "normal" }, []);
    await runAutoStart(new Map([["nudge_auto_start", "true"], ["nudge_wip_limit", "5"]]), makeDeps());
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  // Regression for #537: a workflow-driven blocker (currentNodeId != null) whose node
  // was never advanced to `end` (node desync) but whose STATUS is terminal MUST still
  // unblock its dependent once merged.
  it("starts a dependent whose workflow blocker is Done-STATUS but stuck on a non-end node (node desync)", async () => {
    mockUpToDepCheck({ id: "blocker-1", statusId: "done-1", currentNodeId: "node-review", currentNodeType: "normal" }, []);
    vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({ id: "ws-new" }) } as Response);
    await runAutoStart(new Map([["nudge_auto_start", "true"], ["nudge_wip_limit", "5"]]), makeDeps());
    expect(vi.mocked(fetch)).toHaveBeenCalledWith("http://127.0.0.1:3001/api/workspaces", expect.any(Object));
  });
});

describe("runAutoStart URL construction", () => {
  it("uses 127.0.0.1 for monitor self-fetches", async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(makeSelectChain([{ id: "ip-1", projectId: "proj-1" }]) as ReturnType<typeof db.select>)
      .mockReturnValueOnce(makeSelectChain([{ count: 0 }]) as ReturnType<typeof db.select>)
      .mockReturnValueOnce(makeSelectChain([{ id: "issue-1", title: "Ready", description: "", issueNumber: 7 }]) as ReturnType<typeof db.select>)
      .mockReturnValueOnce(makeSelectChain([]) as ReturnType<typeof db.select>)
      .mockReturnValueOnce(makeSelectChain([]) as ReturnType<typeof db.select>) // no-auto-start tag check (none)
      .mockReturnValueOnce(makeSelectChain([{ count: 1 }]) as ReturnType<typeof db.select>);
    vi.mocked(fetch).mockResolvedValue({ ok: true } as Response);

    await runAutoStart(new Map([
      ["nudge_auto_start", "true"],
      ["nudge_wip_limit", "1"],
    ]), makeDeps());

    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      "http://127.0.0.1:3001/api/workspaces",
      expect.any(Object),
    );
  });
});

describe("runAutoStart Backlog promotion for auto-driven projects", () => {
  it("starts a Backlog issue for an auto-driven project (no manual Backlog→Todo move needed)", async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(makeSelectChain([{ id: "ip-1", projectId: "proj-1" }]) as ReturnType<typeof db.select>) // inProgressStatuses
      .mockReturnValueOnce(makeSelectChain([{ count: 0 }]) as ReturnType<typeof db.select>) // loop1 activeWip
      .mockReturnValueOnce(makeSelectChain([]) as ReturnType<typeof db.select>) // loop1 inProgressIssues (none)
      .mockReturnValueOnce(makeSelectChain([{ count: 0 }]) as ReturnType<typeof db.select>) // loop2 inProgressCount
      .mockReturnValueOnce(makeSelectChain([{ id: "todo-1" }]) as ReturnType<typeof db.select>) // todoStatus
      .mockReturnValueOnce(makeSelectChain([{ id: "backlog-1" }]) as ReturnType<typeof db.select>) // backlogStatus (auto-driven)
      .mockReturnValueOnce(makeSelectChain([{ id: "issue-1", title: "New Feature", projectId: "proj-1", issueNumber: 5 }]) as ReturnType<typeof db.select>) // todoIssues (includes backlog)
      .mockReturnValueOnce(makeSelectChain([{ id: "done-1" }]) as ReturnType<typeof db.select>) // doneStatuses
      .mockReturnValueOnce(makeSelectChain([]) as ReturnType<typeof db.select>) // existingWs (none)
      .mockReturnValueOnce(makeSelectChain([]) as ReturnType<typeof db.select>) // no-auto-start tag (none)
      .mockReturnValueOnce(makeSelectChain([]) as ReturnType<typeof db.select>); // deps (none)
    vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({ id: "ws-new" }) } as Response);

    await runAutoStart(
      new Map([["nudge_wip_limit", "5"]]),
      makeDeps({ isAutoDrivenProject: () => true }),
    );

    expect(vi.mocked(fetch)).toHaveBeenCalledWith("http://127.0.0.1:3001/api/workspaces", expect.any(Object));
  });

  it("skips feature and enhancement candidates and starts the next eligible non-feature issue", async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(makeSelectChain([{ id: "ip-1", projectId: "proj-1" }]) as ReturnType<typeof db.select>) // inProgressStatuses
      .mockReturnValueOnce(makeSelectChain([{ count: 0 }]) as ReturnType<typeof db.select>) // loop1 activeWip
      .mockReturnValueOnce(makeSelectChain([]) as ReturnType<typeof db.select>) // loop1 inProgressIssues (none)
      .mockReturnValueOnce(makeSelectChain([{ count: 0 }]) as ReturnType<typeof db.select>) // loop2 inProgressCount
      .mockReturnValueOnce(makeSelectChain([{ id: "todo-1" }]) as ReturnType<typeof db.select>) // todoStatus
      .mockReturnValueOnce(makeSelectChain([
        { id: "feature-1", title: "Feature: command center", description: "", issueType: "feature", projectId: "proj-1", issueNumber: 8 },
        { id: "enhancement-1", title: "card polish", description: "", issueType: "enhancement", projectId: "proj-1", issueNumber: 9 },
        { id: "bug-1", title: "bug: restore monitor capacity", description: "", issueType: "bug", projectId: "proj-1", issueNumber: 10 },
      ]) as ReturnType<typeof db.select>) // todoIssues
      .mockReturnValueOnce(makeSelectChain([{ id: "done-1" }]) as ReturnType<typeof db.select>) // doneStatuses
      .mockReturnValueOnce(makeSelectChain([]) as ReturnType<typeof db.select>) // feature existingWs
      .mockReturnValueOnce(makeSelectChain([]) as ReturnType<typeof db.select>) // enhancement existingWs
      .mockReturnValueOnce(makeSelectChain([]) as ReturnType<typeof db.select>) // bug existingWs
      .mockReturnValueOnce(makeSelectChain([]) as ReturnType<typeof db.select>) // bug no-auto-start tag
      .mockReturnValueOnce(makeSelectChain([]) as ReturnType<typeof db.select>); // bug deps
    vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({ id: "ws-bug" }) } as Response);

    await runAutoStart(new Map([["nudge_wip_limit", "5"]]), makeDeps());

    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
    expect(body.issueId).toBe("bug-1");
  });

  it("does NOT start a Backlog issue for a non-auto-driven project (Backlog stays triage)", async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(makeSelectChain([{ id: "ip-1", projectId: "proj-1" }]) as ReturnType<typeof db.select>) // inProgressStatuses
      .mockReturnValueOnce(makeSelectChain([{ count: 0 }]) as ReturnType<typeof db.select>) // loop1 activeWip
      .mockReturnValueOnce(makeSelectChain([]) as ReturnType<typeof db.select>) // loop1 inProgressIssues (none)
      .mockReturnValueOnce(makeSelectChain([{ count: 0 }]) as ReturnType<typeof db.select>) // loop2 inProgressCount
      .mockReturnValueOnce(makeSelectChain([{ id: "todo-1" }]) as ReturnType<typeof db.select>) // todoStatus
      // no backlogStatus lookup (isAutoDrivenProject = false)
      .mockReturnValueOnce(makeSelectChain([]) as ReturnType<typeof db.select>) // todoIssues (empty — only Todo queried, nothing there)
      .mockReturnValueOnce(makeSelectChain([{ id: "done-1" }]) as ReturnType<typeof db.select>); // doneStatuses

    await runAutoStart(
      new Map([["nudge_wip_limit", "5"]]),
      makeDeps({ isAutoDrivenProject: () => false }),
    );

    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("honors no-auto-start tag on a Backlog issue for an auto-driven project", async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(makeSelectChain([{ id: "ip-1", projectId: "proj-1" }]) as ReturnType<typeof db.select>) // inProgressStatuses
      .mockReturnValueOnce(makeSelectChain([{ count: 0 }]) as ReturnType<typeof db.select>) // loop1 activeWip
      .mockReturnValueOnce(makeSelectChain([]) as ReturnType<typeof db.select>) // loop1 inProgressIssues (none)
      .mockReturnValueOnce(makeSelectChain([{ count: 0 }]) as ReturnType<typeof db.select>) // loop2 inProgressCount
      .mockReturnValueOnce(makeSelectChain([{ id: "todo-1" }]) as ReturnType<typeof db.select>) // todoStatus
      .mockReturnValueOnce(makeSelectChain([{ id: "backlog-1" }]) as ReturnType<typeof db.select>) // backlogStatus
      .mockReturnValueOnce(makeSelectChain([{ id: "issue-1", title: "Tagged Backlog Issue", projectId: "proj-1", issueNumber: 6 }]) as ReturnType<typeof db.select>) // todoIssues
      .mockReturnValueOnce(makeSelectChain([{ id: "done-1" }]) as ReturnType<typeof db.select>) // doneStatuses
      .mockReturnValueOnce(makeSelectChain([]) as ReturnType<typeof db.select>) // existingWs (none)
      .mockReturnValueOnce(makeSelectChain([{ id: "tag-1" }]) as ReturnType<typeof db.select>); // no-auto-start tag PRESENT

    await runAutoStart(
      new Map([["nudge_wip_limit", "5"]]),
      makeDeps({ isAutoDrivenProject: () => true }),
    );

    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("does NOT start a dep-blocked Backlog issue for an auto-driven project", async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(makeSelectChain([{ id: "ip-1", projectId: "proj-1" }]) as ReturnType<typeof db.select>) // inProgressStatuses
      .mockReturnValueOnce(makeSelectChain([{ count: 0 }]) as ReturnType<typeof db.select>) // loop1 activeWip
      .mockReturnValueOnce(makeSelectChain([]) as ReturnType<typeof db.select>) // loop1 inProgressIssues (none)
      .mockReturnValueOnce(makeSelectChain([{ count: 0 }]) as ReturnType<typeof db.select>) // loop2 inProgressCount
      .mockReturnValueOnce(makeSelectChain([{ id: "todo-1" }]) as ReturnType<typeof db.select>) // todoStatus
      .mockReturnValueOnce(makeSelectChain([{ id: "backlog-1" }]) as ReturnType<typeof db.select>) // backlogStatus
      .mockReturnValueOnce(makeSelectChain([{ id: "issue-1", title: "Blocked Backlog", projectId: "proj-1", issueNumber: 7 }]) as ReturnType<typeof db.select>) // todoIssues
      .mockReturnValueOnce(makeSelectChain([{ id: "done-1" }]) as ReturnType<typeof db.select>) // doneStatuses
      .mockReturnValueOnce(makeSelectChain([]) as ReturnType<typeof db.select>) // existingWs (none)
      .mockReturnValueOnce(makeSelectChain([]) as ReturnType<typeof db.select>) // no-auto-start tag (none)
      .mockReturnValueOnce(makeSelectChain([{ dependsOnId: "blocker-1" }]) as ReturnType<typeof db.select>) // deps
      .mockReturnValueOnce(makeSelectChain([{ id: "blocker-1", statusId: "inprog-1", currentNodeId: null, currentNodeType: null }]) as ReturnType<typeof db.select>) // blockerIssues (not terminal)
      .mockReturnValueOnce(makeSelectChain([]) as ReturnType<typeof db.select>); // open-workspace check

    await runAutoStart(
      new Map([["nudge_wip_limit", "5"]]),
      makeDeps({ isAutoDrivenProject: () => true }),
    );

    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});

describe("runAutoStart #773 feature tickets on auto-driven projects", () => {
  it("auto-starts a feature-typed Backlog issue on an auto-driven project (exclusion skipped)", async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(makeSelectChain([{ id: "ip-1", projectId: "proj-1" }]) as ReturnType<typeof db.select>) // inProgressStatuses
      .mockReturnValueOnce(makeSelectChain([{ count: 0 }]) as ReturnType<typeof db.select>) // loop1 activeWip
      .mockReturnValueOnce(makeSelectChain([]) as ReturnType<typeof db.select>) // loop1 inProgressIssues (none)
      .mockReturnValueOnce(makeSelectChain([{ count: 0 }]) as ReturnType<typeof db.select>) // loop2 inProgressCount
      .mockReturnValueOnce(makeSelectChain([{ id: "todo-1" }]) as ReturnType<typeof db.select>) // todoStatus
      .mockReturnValueOnce(makeSelectChain([{ id: "backlog-1" }]) as ReturnType<typeof db.select>) // backlogStatus (auto-driven)
      .mockReturnValueOnce(makeSelectChain([
        { id: "feature-1", title: "Feature: epic step 1", description: "", issueType: "feature", projectId: "proj-1", issueNumber: 11 },
      ]) as ReturnType<typeof db.select>) // todoIssues — SQL would exclude this for a non-auto-driven project
      .mockReturnValueOnce(makeSelectChain([{ id: "done-1" }]) as ReturnType<typeof db.select>) // doneStatuses
      .mockReturnValueOnce(makeSelectChain([]) as ReturnType<typeof db.select>) // existingWs (none)
      .mockReturnValueOnce(makeSelectChain([]) as ReturnType<typeof db.select>) // no-auto-start tag (none)
      .mockReturnValueOnce(makeSelectChain([]) as ReturnType<typeof db.select>); // deps (none)
    vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({ id: "ws-feat" }) } as Response);

    await runAutoStart(
      new Map([["nudge_wip_limit", "5"]]),
      makeDeps({ isAutoDrivenProject: () => true }),
    );

    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
    expect(body.issueId).toBe("feature-1");
  });
});

describe("runAutoStart #775 launch failure visibility", () => {
  it("records a failure action and warns when the launch returns a non-ok response", async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(makeSelectChain([{ id: "ip-1", projectId: "proj-1" }]) as ReturnType<typeof db.select>) // inProgressStatuses
      .mockReturnValueOnce(makeSelectChain([{ count: 0 }]) as ReturnType<typeof db.select>) // loop1 activeWip
      .mockReturnValueOnce(makeSelectChain([]) as ReturnType<typeof db.select>) // loop1 inProgressIssues (none)
      .mockReturnValueOnce(makeSelectChain([{ count: 0 }]) as ReturnType<typeof db.select>) // loop2 inProgressCount
      .mockReturnValueOnce(makeSelectChain([{ id: "todo-1" }]) as ReturnType<typeof db.select>) // todoStatus
      .mockReturnValueOnce(makeSelectChain([{ id: "issue-1", title: "Ready", description: "", projectId: "proj-1", issueNumber: 12 }]) as ReturnType<typeof db.select>) // todoIssues
      .mockReturnValueOnce(makeSelectChain([{ id: "done-1" }]) as ReturnType<typeof db.select>) // doneStatuses
      .mockReturnValueOnce(makeSelectChain([]) as ReturnType<typeof db.select>) // existingWs (none)
      .mockReturnValueOnce(makeSelectChain([]) as ReturnType<typeof db.select>) // no-auto-start tag (none)
      .mockReturnValueOnce(makeSelectChain([]) as ReturnType<typeof db.select>); // deps (none)
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 400, text: async () => "No default branch" } as Response);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logMonitorAction = vi.fn();

    await runAutoStart(
      new Map([["nudge_auto_start", "true"], ["nudge_wip_limit", "5"]]),
      makeDeps({ logMonitorAction }),
    );

    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    expect(logMonitorAction).toHaveBeenCalledWith("auto_start", "failed", "issue-1");
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("HTTP 400"));
    warnSpy.mockRestore();
  });
});

describe("runAutoStart opt-out + scoping", () => {
  it("skips an In-Progress issue tagged no-auto-start", async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(makeSelectChain([{ id: "ip-1", projectId: "proj-1" }]) as ReturnType<typeof db.select>) // inProgressStatuses
      .mockReturnValueOnce(makeSelectChain([{ count: 0 }]) as ReturnType<typeof db.select>) // activeWip
      .mockReturnValueOnce(makeSelectChain([{ id: "issue-1", title: "Tagged", description: "", issueNumber: 9 }]) as ReturnType<typeof db.select>) // inProgressIssues
      .mockReturnValueOnce(makeSelectChain([]) as ReturnType<typeof db.select>) // openWs (none)
      .mockReturnValueOnce(makeSelectChain([{ id: "tag-1" }]) as ReturnType<typeof db.select>) // no-auto-start tag PRESENT
      .mockReturnValueOnce(makeSelectChain([{ count: 0 }]) as ReturnType<typeof db.select>) // Todo loop inProgressCount
      .mockReturnValueOnce(makeSelectChain([]) as ReturnType<typeof db.select>); // todoStatus (none) -> loop ends

    await runAutoStart(new Map([["nudge_auto_start", "true"], ["nudge_wip_limit", "5"]]), makeDeps());
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("does not auto-start projects the allowProject predicate rejects", async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(makeSelectChain([{ id: "ip-1", projectId: "proj-1" }]) as ReturnType<typeof db.select>); // inProgressStatuses (filtered out)
    await runAutoStart(new Map([["nudge_auto_start", "true"]]), makeDeps({ allowProject: () => false }));
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});

describe("runAutoStart planMode override for auto-driven projects (#666)", () => {
  /**
   * Regression: an auto-driven project with a high-priority ticket was stalling
   * because the workspace launched in plan-only mode and no human was there to
   * approve the plan. The monitor must pass `planMode: false` for auto-driven
   * projects so the agent goes straight to implementation.
   */

  it("passes planMode:false for a Todo issue in an auto-driven project", async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(makeSelectChain([{ id: "ip-1", projectId: "proj-1" }]) as ReturnType<typeof db.select>) // inProgressStatuses
      .mockReturnValueOnce(makeSelectChain([{ count: 0 }]) as ReturnType<typeof db.select>) // loop1 activeWip
      .mockReturnValueOnce(makeSelectChain([]) as ReturnType<typeof db.select>) // loop1 inProgressIssues (none)
      .mockReturnValueOnce(makeSelectChain([{ count: 0 }]) as ReturnType<typeof db.select>) // loop2 inProgressCount
      .mockReturnValueOnce(makeSelectChain([{ id: "todo-1" }]) as ReturnType<typeof db.select>) // todoStatus
      .mockReturnValueOnce(makeSelectChain([{ id: "backlog-1" }]) as ReturnType<typeof db.select>) // backlogStatus (auto-driven)
      .mockReturnValueOnce(makeSelectChain([{ id: "issue-1", title: "High prio feature", projectId: "proj-1", issueNumber: 2 }]) as ReturnType<typeof db.select>) // todoIssues
      .mockReturnValueOnce(makeSelectChain([{ id: "done-1" }]) as ReturnType<typeof db.select>) // doneStatuses
      .mockReturnValueOnce(makeSelectChain([]) as ReturnType<typeof db.select>) // existingWs (none)
      .mockReturnValueOnce(makeSelectChain([]) as ReturnType<typeof db.select>) // no-auto-start tag (none)
      .mockReturnValueOnce(makeSelectChain([]) as ReturnType<typeof db.select>); // deps (none)
    vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({ id: "ws-new" }) } as Response);

    await runAutoStart(
      new Map([["nudge_wip_limit", "5"]]),
      makeDeps({ isAutoDrivenProject: () => true }),
    );

    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
    expect(body.planMode).toBe(false);
  });

  it("passes planMode:false for an In-Progress issue in an auto-driven project", async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(makeSelectChain([{ id: "ip-1", projectId: "proj-1" }]) as ReturnType<typeof db.select>) // inProgressStatuses
      .mockReturnValueOnce(makeSelectChain([{ count: 0 }]) as ReturnType<typeof db.select>) // activeWip
      .mockReturnValueOnce(makeSelectChain([{ id: "issue-1", title: "Stuck", description: "Fix it", issueNumber: 3 }]) as ReturnType<typeof db.select>) // inProgressIssues
      .mockReturnValueOnce(makeSelectChain([]) as ReturnType<typeof db.select>) // openWs (none)
      .mockReturnValueOnce(makeSelectChain([]) as ReturnType<typeof db.select>) // no-auto-start tag (none)
      .mockReturnValueOnce(makeSelectChain([{ count: 0 }]) as ReturnType<typeof db.select>) // Todo loop inProgressCount
      .mockReturnValueOnce(makeSelectChain([]) as ReturnType<typeof db.select>); // todoStatus (none) → loop ends
    vi.mocked(fetch).mockResolvedValue({ ok: true } as Response);

    await runAutoStart(
      new Map([["nudge_wip_limit", "5"]]),
      makeDeps({ isAutoDrivenProject: () => true }),
    );

    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
    expect(body.planMode).toBe(false);
  });

  it("does NOT pass planMode for a non-auto-driven project (priority default preserved)", async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(makeSelectChain([{ id: "ip-1", projectId: "proj-1" }]) as ReturnType<typeof db.select>) // inProgressStatuses
      .mockReturnValueOnce(makeSelectChain([{ count: 0 }]) as ReturnType<typeof db.select>) // loop1 activeWip
      .mockReturnValueOnce(makeSelectChain([]) as ReturnType<typeof db.select>) // loop1 inProgressIssues (none)
      .mockReturnValueOnce(makeSelectChain([{ count: 0 }]) as ReturnType<typeof db.select>) // loop2 inProgressCount
      .mockReturnValueOnce(makeSelectChain([{ id: "todo-1" }]) as ReturnType<typeof db.select>) // todoStatus
      .mockReturnValueOnce(makeSelectChain([{ id: "issue-1", title: "Regular issue", projectId: "proj-1", issueNumber: 4 }]) as ReturnType<typeof db.select>) // todoIssues
      .mockReturnValueOnce(makeSelectChain([{ id: "done-1" }]) as ReturnType<typeof db.select>) // doneStatuses
      .mockReturnValueOnce(makeSelectChain([]) as ReturnType<typeof db.select>) // existingWs (none)
      .mockReturnValueOnce(makeSelectChain([]) as ReturnType<typeof db.select>) // no-auto-start tag (none)
      .mockReturnValueOnce(makeSelectChain([]) as ReturnType<typeof db.select>); // deps (none)
    vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({ id: "ws-new" }) } as Response);

    await runAutoStart(
      new Map([["nudge_wip_limit", "5"]]),
      makeDeps({ isAutoDrivenProject: () => false }),
    );

    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
    // planMode must NOT be in the body — the route-level default should apply
    expect(body).not.toHaveProperty("planMode");
  });
});
