// @covers client.createIssue.optimisticFlow [ui-state, error-handling, state-transition]
//
// #729: characterization tests for `runCreateIssueFlow`, one of the client's
// zero-safety-net / high-rework modules. It was extracted verbatim from BoardPage's
// `handleCreateIssue`, which is the single most-reworked client file in the repo, so the
// point of these tests is to make the NEXT edit to it safe — not to describe its shape.
//
// What is pinned here is the user-visible contract of "create an issue":
//   * a card appears immediately in the target column (optimistic insert) and is marked
//     pending, so the board does not look frozen while the POST is in flight;
//   * if the POST fails, that card DISAPPEARS again and the user is told — a stuck
//     phantom card is the failure mode this flow exists to avoid;
//   * "create and start working" launches a workspace for the CREATED id and reports
//     partial failure honestly ("issue created, but workspace creation failed") rather
//     than as an outright failure;
//   * the busy flag is always released.
//
// Deliberately NOT pinned: the order of setter calls, the temp id format, or which of the
// two board refetches supplies the issue. Asserting those would make BoardPage harder to
// refactor, which is the opposite of this ticket's purpose.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IssueWithStatus, StatusWithIssues } from "@agentic-kanban/shared";
import { runCreateIssueFlow, type CreateIssueFlowDeps, type CreateIssuePayload } from "./createIssueService.js";
import { subscribeToasts, type Toast } from "./toast.js";

function column(id: string, name: string, issues: IssueWithStatus[] = []): StatusWithIssues {
  return { id, name, projectId: "proj-1", sortOrder: 0, issues, count: issues.length } as StatusWithIssues;
}

interface Harness {
  deps: CreateIssueFlowDeps;
  /** The columns the board would actually render, i.e. the last value handed to setColumns. */
  rendered: () => StatusWithIssues[];
  pendingIssueIds: () => Set<string>;
  pendingWorkspaceIssueIds: () => Set<string>;
  mutating: () => boolean;
  workspaceOpened: () => { issueId: string; workspaceId?: string; sessionId?: string } | null;
  panelClosed: () => boolean;
}

function apply<T>(next: T | ((prev: T) => T), prev: T): T {
  return typeof next === "function" ? (next as (p: T) => T)(prev) : next;
}

function harness(overrides: Partial<CreateIssueFlowDeps> = {}): Harness {
  let columns = [column("todo", "Todo"), column("doing", "In Progress")];
  const columnsRef = { current: columns };
  const pendingBoardRefreshRef = { current: true };
  let pendingIssueIds = new Set<string>();
  let pendingWorkspaceIssueIds = new Set<string>();
  let mutating = false;
  let opened: { issueId: string; workspaceId?: string; sessionId?: string } | null = null;
  let panelClosed = false;

  const deps = {
    columns,
    columnsRef,
    pendingBoardRefreshRef,
    activeProject: { defaultBranch: "master" },
    setMutating: (v: boolean) => { mutating = v; },
    setError: () => {},
    setColumns: (next: StatusWithIssues[] | ((p: StatusWithIssues[]) => StatusWithIssues[])) => {
      columns = apply(next, columns);
    },
    setCreatingInColumnId: (v: string | null) => { if (v === null) panelClosed = true; },
    setExpandedCreatePanel: () => {},
    setPendingIssueIds: (next: Set<string> | ((p: Set<string>) => Set<string>)) => {
      pendingIssueIds = apply(next, pendingIssueIds);
    },
    setPendingWorkspaceIssueIds: (next: Set<string> | ((p: Set<string>) => Set<string>)) => {
      pendingWorkspaceIssueIds = apply(next, pendingWorkspaceIssueIds);
    },
    setWorkspaceIssue: (issue: IssueWithStatus) => { opened = { ...(opened ?? {}), issueId: issue.id }; },
    setWorkspaceInitial: (v: { workspaceId: string; sessionId: string }) => {
      opened = { issueId: opened?.issueId ?? "", ...v };
    },
    refetchBoard: async () => columnsRef.current,
    ...overrides,
  } as unknown as CreateIssueFlowDeps;

  return {
    deps,
    rendered: () => columns,
    pendingIssueIds: () => pendingIssueIds,
    pendingWorkspaceIssueIds: () => pendingWorkspaceIssueIds,
    mutating: () => mutating,
    workspaceOpened: () => opened,
    panelClosed: () => panelClosed,
  };
}

const payload = {
  title: "Add a rate limiter",
  projectId: "proj-1",
  statusId: "todo",
} as CreateIssuePayload;

// Records every toast raised during a test by subscribing to the real toast store rather
// than mocking it — the toast IS the user-visible outcome here, so faking it would remove
// the assertion's meaning. The store is module-global and its entries linger for 4s, so
// toasts are de-duplicated by their (monotonic) id to keep each test's log its own.
let toastLog: Toast[] = [];
let unsubscribe: (() => void) | undefined;
const seenToastIds = new Set<number>();

function toastMessages(): string[] {
  return toastLog.map((t) => `${t.type}: ${t.message}`);
}

beforeEach(() => {
  toastLog = [];
  unsubscribe = subscribeToasts((list) => {
    for (const t of list) {
      if (seenToastIds.has(t.id)) continue;
      seenToastIds.add(t.id);
      toastLog.push(t);
    }
  });
});

afterEach(() => {
  unsubscribe?.();
  vi.unstubAllGlobals();
});

/** Route-aware fetch stub: one response body per API path, or an Error to fail with. */
function stubFetch(routes: Record<string, unknown>): { calls: { path: string; body: unknown }[] } {
  const calls: { path: string; body: unknown }[] = [];
  vi.stubGlobal("fetch", async (path: string, init?: RequestInit) => {
    calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const hit = routes[path];
    if (hit === undefined) throw new Error(`unexpected request to ${path}`);
    if (hit instanceof Error) {
      return { ok: false, status: 500, statusText: "Server Error", json: async () => ({ error: hit.message }) };
    }
    return { ok: true, status: 200, statusText: "OK", json: async () => hit };
  });
  return { calls };
}

describe("runCreateIssueFlow — optimistic insert", () => {
  it("shows the new card in its column before the POST resolves", async () => {
    let resolvePost: (v: unknown) => void = () => {};
    const inFlight = new Promise((r) => { resolvePost = r; });
    vi.stubGlobal("fetch", async () => ({
      ok: true, status: 200, statusText: "OK",
      json: () => inFlight,
    }));
    const h = harness();

    const flow = runCreateIssueFlow(payload, h.deps);
    // The optimistic insert is synchronous — before the request settles the user already
    // sees their card at the top of the target column.
    const todo = h.rendered().find((c) => c.id === "todo")!;
    expect(todo.issues.map((i) => i.title)).toEqual(["Add a rate limiter"]);
    expect(h.pendingIssueIds().size).toBe(1);
    expect(h.mutating()).toBe(true);

    resolvePost!({ id: "issue-1", issueNumber: 42, title: "Add a rate limiter" });
    await flow;
  });

  it("puts the card in the column the user created it in, not the first column", async () => {
    stubFetch({ "/api/issues": { id: "issue-1", issueNumber: 42, title: "Add a rate limiter" } });
    const h = harness();

    await runCreateIssueFlow({ ...payload, statusId: "doing" }, h.deps);

    expect(h.rendered().find((c) => c.id === "doing")!.issues).toHaveLength(1);
    expect(h.rendered().find((c) => c.id === "todo")!.issues).toHaveLength(0);
  });

  it("sorts the new card above the existing top card of the column", async () => {
    stubFetch({ "/api/issues": { id: "issue-1", issueNumber: 42, title: "x" } });
    const h = harness();
    const top = { id: "issue-old", title: "Existing", sortOrder: 500 } as IssueWithStatus;
    h.deps.columnsRef.current = [column("todo", "Todo", [top])];

    await runCreateIssueFlow(payload, h.deps);

    const issues = h.rendered().find((c) => c.id === "todo")!.issues;
    expect(issues[0].title).toBe("Add a rate limiter");
    expect(issues[0].sortOrder).toBeLessThan(top.sortOrder);
  });

  it("creates nothing optimistically when the target column is unknown, but still posts", async () => {
    const { calls } = stubFetch({ "/api/issues": { id: "issue-1", issueNumber: 42, title: "x" } });
    const h = harness();

    await runCreateIssueFlow({ ...payload, statusId: "no-such-column" }, h.deps);

    expect(h.rendered().flatMap((c) => c.issues)).toHaveLength(0);
    expect(calls.map((c) => c.path)).toContain("/api/issues");
    expect(toastMessages()).toEqual(["success: Issue created"]);
  });

  it("does not send the launch-only fields to the issue endpoint", async () => {
    const { calls } = stubFetch({
      "/api/issues": { id: "issue-1", issueNumber: 42, title: "x" },
      "/api/workspaces": { id: "ws-1", sessionId: "sess-1" },
    });
    const h = harness();

    await runCreateIssueFlow({ ...payload, startWorkspace: true, planMode: true, model: "m" }, h.deps);

    const issueBody = calls.find((c) => c.path === "/api/issues")!.body as Record<string, unknown>;
    // These describe how to LAUNCH, not what the issue is; leaking them would make the
    // issue payload unvalidatable server-side.
    for (const key of ["startWorkspace", "planMode", "model", "profile", "isDirect", "skillId"]) {
      expect(issueBody).not.toHaveProperty(key);
    }
    expect(issueBody.title).toBe("Add a rate limiter");
  });
});

describe("runCreateIssueFlow — the POST fails", () => {
  it("removes the optimistic card again and tells the user", async () => {
    stubFetch({ "/api/issues": new Error("db is locked") });
    const h = harness();

    await runCreateIssueFlow(payload, h.deps);

    // The whole point of the rollback: no phantom card the user cannot click, move or delete.
    expect(h.rendered().flatMap((c) => c.issues)).toHaveLength(0);
    expect(h.pendingIssueIds().size).toBe(0);
    expect(h.pendingWorkspaceIssueIds().size).toBe(0);
    expect(toastMessages()).toEqual(["error: Failed to create issue"]);
  });

  it("leaves other columns' cards untouched while rolling back", async () => {
    stubFetch({ "/api/issues": new Error("boom") });
    const existing = { id: "issue-old", title: "Existing" } as IssueWithStatus;
    const h = harness();
    const seeded = [column("todo", "Todo"), column("doing", "In Progress", [existing])];
    h.deps.columnsRef.current = seeded;
    h.deps.setColumns(seeded);

    await runCreateIssueFlow(payload, h.deps);

    expect(h.rendered().find((c) => c.id === "doing")!.issues.map((i) => i.id)).toEqual(["issue-old"]);
  });

  it("releases the busy flag even on failure", async () => {
    stubFetch({ "/api/issues": new Error("boom") });
    const h = harness();

    await runCreateIssueFlow(payload, h.deps);

    // A stuck `mutating` flag disables the whole board's mutation UI.
    expect(h.mutating()).toBe(false);
  });
});

describe("runCreateIssueFlow — create and start working", () => {
  const created = { id: "issue-1", issueNumber: 42, title: "Add a rate limiter" };

  function boardWithCreatedIssue(): StatusWithIssues[] {
    return [column("todo", "Todo", [{ id: "issue-1", title: created.title } as IssueWithStatus])];
  }

  it("launches a workspace on a branch derived from the created issue and opens it", async () => {
    const { calls } = stubFetch({
      "/api/issues": created,
      "/api/workspaces": { id: "ws-1", sessionId: "sess-1" },
    });
    const h = harness({ refetchBoard: async () => boardWithCreatedIssue() });

    await runCreateIssueFlow({ ...payload, startWorkspace: true }, h.deps);

    const wsBody = calls.find((c) => c.path === "/api/workspaces")!.body as Record<string, unknown>;
    expect(wsBody.issueId).toBe("issue-1");
    // The branch must carry the SERVER-assigned issue number — the optimistic card has none.
    expect(String(wsBody.branch)).toContain("ak-42");
    expect(wsBody.baseBranch).toBe("master");
    // The user lands in the new workspace rather than back on the board.
    expect(h.workspaceOpened()).toEqual({ issueId: "issue-1", workspaceId: "ws-1", sessionId: "sess-1" });
    expect(toastMessages()).toEqual(["success: Issue and workspace created"]);
  });

  it("opens the workspace even when the server returns no session to attach to", async () => {
    stubFetch({ "/api/issues": created, "/api/workspaces": { id: "ws-1" } });
    const h = harness({ refetchBoard: async () => boardWithCreatedIssue() });

    await runCreateIssueFlow({ ...payload, startWorkspace: true }, h.deps);

    // The panel still opens on the issue; it just has no session to stream yet.
    expect(h.workspaceOpened()).toEqual({ issueId: "issue-1" });
  });

  it("#973: does not open the workspace panel when the user moved on during the launch", async () => {
    stubFetch({ "/api/issues": created, "/api/workspaces": { id: "ws-1", sessionId: "sess-1" } });
    const h = harness({
      refetchBoard: async () => boardWithCreatedIssue(),
      shouldOpenWorkspacePanel: () => false,
    });

    await runCreateIssueFlow({ ...payload, startWorkspace: true }, h.deps);

    // The workspace was still created and reported — only the focus steal is gone.
    expect(h.workspaceOpened()).toBeNull();
    expect(toastMessages()).toEqual(["success: Issue and workspace created"]);
  });

  it("#973: still opens the panel when the guard says the user has not moved", async () => {
    stubFetch({ "/api/issues": created, "/api/workspaces": { id: "ws-1", sessionId: "sess-1" } });
    const h = harness({
      refetchBoard: async () => boardWithCreatedIssue(),
      shouldOpenWorkspacePanel: () => true,
    });

    await runCreateIssueFlow({ ...payload, startWorkspace: true }, h.deps);

    expect(h.workspaceOpened()).toEqual({ issueId: "issue-1", workspaceId: "ws-1", sessionId: "sess-1" });
  });

  it("asks for a direct-on-master workspace without a branch or base branch", async () => {
    const { calls } = stubFetch({ "/api/issues": created, "/api/workspaces": { id: "ws-1" } });
    const h = harness({ refetchBoard: async () => boardWithCreatedIssue() });

    await runCreateIssueFlow({ ...payload, startWorkspace: true, isDirect: true }, h.deps);

    const wsBody = calls.find((c) => c.path === "/api/workspaces")!.body as Record<string, unknown>;
    expect(wsBody.isDirect).toBe(true);
    expect(wsBody.branch).toBeUndefined();
    expect(wsBody.baseBranch).toBeUndefined();
  });

  it("reports a failed launch as partial success and keeps the issue", async () => {
    stubFetch({ "/api/issues": created, "/api/workspaces": new Error("no worktree slots") });
    const h = harness({ refetchBoard: async () => boardWithCreatedIssue() });

    await runCreateIssueFlow({ ...payload, startWorkspace: true }, h.deps);

    // The issue DID land, so this must not read as "Failed to create issue" — and the
    // card must stop showing a workspace spinner it will never get.
    expect(toastMessages()).toEqual(["error: Issue created, but workspace creation failed"]);
    expect(h.pendingWorkspaceIssueIds().has("issue-1")).toBe(false);
    expect(h.mutating()).toBe(false);
  });

  it("moves the awaiting-workspace marker from the temporary card to the created issue", async () => {
    let sampled: string[] = [];
    stubFetch({ "/api/issues": created, "/api/workspaces": { id: "ws-1" } });
    const h: Harness = harness({
      refetchBoard: async () => {
        // Sampled between the POST and the launch: the spinner has moved off the temp id
        // onto the real one, so the refetched card keeps showing it.
        sampled = [...h.pendingWorkspaceIssueIds()];
        return boardWithCreatedIssue();
      },
    });

    await runCreateIssueFlow({ ...payload, startWorkspace: true }, h.deps);

    expect(sampled).toEqual(["issue-1"]);
  });

  it("does not launch anything when no project is active", async () => {
    const { calls } = stubFetch({ "/api/issues": created });
    const h = harness({ activeProject: undefined });

    await runCreateIssueFlow({ ...payload, startWorkspace: true }, h.deps);

    expect(calls.map((c) => c.path)).not.toContain("/api/workspaces");
    expect(toastMessages()).toEqual(["success: Issue created"]);
  });

  it("still closes the create panel and clears the busy flag after a successful launch", async () => {
    stubFetch({ "/api/issues": created, "/api/workspaces": { id: "ws-1" } });
    const h = harness({ refetchBoard: async () => boardWithCreatedIssue() });

    await runCreateIssueFlow({ ...payload, startWorkspace: true }, h.deps);

    expect(h.panelClosed()).toBe(true);
    expect(h.mutating()).toBe(false);
  });

  it("survives a board refetch that fails after the workspace was created", async () => {
    let call = 0;
    stubFetch({ "/api/issues": created, "/api/workspaces": { id: "ws-1", sessionId: "sess-1" } });
    const h = harness({
      refetchBoard: async () => {
        call += 1;
        // The second refetch (post-launch) is the one the flow guards; a failure there
        // must not turn a created workspace into a reported failure.
        if (call > 1) throw new Error("network blip");
        return boardWithCreatedIssue();
      },
    });

    await runCreateIssueFlow({ ...payload, startWorkspace: true }, h.deps);

    expect(toastMessages()).toEqual(["success: Issue and workspace created"]);
    expect(h.workspaceOpened()).toEqual({ issueId: "issue-1", workspaceId: "ws-1", sessionId: "sess-1" });
  });
});
