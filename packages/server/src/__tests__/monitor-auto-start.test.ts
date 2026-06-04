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
