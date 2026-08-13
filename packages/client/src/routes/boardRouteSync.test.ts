import { describe, expect, it } from "vitest";
import { parseAppPath } from "../lib/appRoutes";
import {
  createNavigationBurst,
  createPendingDeepLink,
  isDeepLinkSettled,
  planDeepLinkIssue,
  planDeepLinkProject,
  planUrlSync,
  type PendingDeepLink,
} from "./boardRouteSync";

const PROJECTS = [
  { id: "aaaa1111-2222-3333", name: "Agentic Kanban" },
  { id: "bbbb4444-5555-6666", name: "Pantry" },
];
const AK = PROJECTS[0].id;
const PANTRY = PROJECTS[1].id;

function pendingFor(path: string): PendingDeepLink {
  return createPendingDeepLink(parseAppPath(path));
}

describe("inbound deep links — project half", () => {
  it("waits while the projects query is in flight", () => {
    const pending = pendingFor("/p/pantry/board");
    expect(planDeepLinkProject(pending, [], AK)).toEqual({ kind: "wait" });
    // Nothing is settled by a wait — the link is still held.
    expect(isDeepLinkSettled(pending)).toBe(false);
  });

  it("switches the active project once the projects resolve", () => {
    expect(planDeepLinkProject(pendingFor("/p/pantry/board"), PROJECTS, AK)).toEqual({
      kind: "switch",
      projectId: PANTRY,
    });
  });

  it("resolves a raw project id in the slug position", () => {
    expect(planDeepLinkProject(pendingFor(`/p/${PANTRY}/graph`), PROJECTS, AK)).toEqual({
      kind: "switch",
      projectId: PANTRY,
    });
  });

  it("reports already-active rather than re-switching", () => {
    expect(planDeepLinkProject(pendingFor("/p/agentic-kanban/board"), PROJECTS, AK)).toEqual({
      kind: "already-active",
      projectId: AK,
    });
  });

  it("reports an unresolvable slug instead of blanking the board", () => {
    expect(planDeepLinkProject(pendingFor("/p/does-not-exist/board"), PROJECTS, AK)).toEqual({
      kind: "unresolved",
    });
  });

  it("has nothing to do for a legacy flat path", () => {
    const pending = pendingFor("/board");
    expect(pending.projectSettled).toBe(true);
    expect(planDeepLinkProject(pending, PROJECTS, AK)).toEqual({ kind: "none" });
  });
});

describe("inbound deep links — issue half", () => {
  it("holds the issue until the project half has been applied", () => {
    const pending = pendingFor("/p/pantry/board/issue/42");
    expect(planDeepLinkIssue(pending, { boardLoaded: true, activeProjectId: AK })).toEqual({ kind: "wait" });
  });

  it("holds the issue until the TARGET project's board has arrived", () => {
    const pending = pendingFor("/p/pantry/board/issue/42");
    pending.projectSettled = true;
    pending.targetProjectId = PANTRY;
    // Switch dispatched, but the active project has not flipped yet.
    expect(planDeepLinkIssue(pending, { boardLoaded: true, activeProjectId: AK })).toEqual({ kind: "wait" });
    // Active project flipped, columns cleared for the incoming board.
    expect(planDeepLinkIssue(pending, { boardLoaded: false, activeProjectId: PANTRY })).toEqual({ kind: "wait" });
    // Columns arrived.
    expect(planDeepLinkIssue(pending, { boardLoaded: true, activeProjectId: PANTRY })).toEqual({
      kind: "open",
      issueNumber: 42,
    });
  });

  it("opens an unscoped issue link as soon as the board is loaded", () => {
    const pending = pendingFor("/issues/7");
    expect(pending.issueNumber).toBe(7);
    expect(planDeepLinkIssue(pending, { boardLoaded: true, activeProjectId: AK })).toEqual({
      kind: "open",
      issueNumber: 7,
    });
  });

  it("never re-applies once settled — a refetch cannot reopen a closed panel", () => {
    const pending = pendingFor("/p/pantry/board/issue/42");
    pending.projectSettled = true;
    pending.targetProjectId = PANTRY;
    const ctx = { boardLoaded: true, activeProjectId: PANTRY };
    expect(planDeepLinkIssue(pending, ctx).kind).toBe("open");
    pending.issueSettled = true; // what the hook does the moment it applies
    expect(planDeepLinkIssue(pending, ctx)).toEqual({ kind: "none" });
    expect(isDeepLinkSettled(pending)).toBe(true);
  });
});

describe("planUrlSync", () => {
  const base = { projects: PROJECTS, activeProjectId: AK, view: "kanban" as const, issueNumber: null };

  it("writes nothing before the projects have loaded", () => {
    expect(
      planUrlSync({ ...base, projects: [], currentPath: "/p/pantry/board/issue/42" }).action,
    ).toBe("none");
  });

  it("writes nothing when the URL already says the right thing", () => {
    expect(planUrlSync({ ...base, currentPath: "/p/agentic-kanban/board" })).toEqual({
      path: "/p/agentic-kanban/board",
      action: "none",
    });
    // Trailing slash is not a difference.
    expect(planUrlSync({ ...base, currentPath: "/p/agentic-kanban/board/" }).action).toBe("none");
  });

  it("upgrades a legacy flat path in place (replace, no history entry)", () => {
    expect(planUrlSync({ ...base, currentPath: "/board" })).toEqual({
      path: "/p/agentic-kanban/board",
      action: "replace",
    });
    expect(planUrlSync({ ...base, currentPath: "/" }).action).toBe("replace");
  });

  it("canonicalises a raw-id path to the slug without a history entry", () => {
    expect(planUrlSync({ ...base, currentPath: `/p/${AK}/board` })).toEqual({
      path: "/p/agentic-kanban/board",
      action: "replace",
    });
  });

  it("pushes a real view change", () => {
    expect(planUrlSync({ ...base, view: "graph", currentPath: "/p/agentic-kanban/board" })).toEqual({
      path: "/p/agentic-kanban/graph",
      action: "push",
    });
  });

  it("pushes a project change", () => {
    expect(
      planUrlSync({ ...base, activeProjectId: PANTRY, currentPath: "/p/agentic-kanban/board" }),
    ).toEqual({ path: "/p/pantry/board", action: "push" });
  });

  it("pushes opening and closing an issue panel", () => {
    expect(planUrlSync({ ...base, issueNumber: 446, currentPath: "/p/agentic-kanban/board" })).toEqual({
      path: "/p/agentic-kanban/board/issue/446",
      action: "push",
    });
    expect(planUrlSync({ ...base, currentPath: "/p/agentic-kanban/board/issue/446" })).toEqual({
      path: "/p/agentic-kanban/board",
      action: "push",
    });
  });

  it("replaces instead of pushing when told to coalesce", () => {
    expect(
      planUrlSync({ ...base, view: "graph", currentPath: "/p/agentic-kanban/board", preferReplace: true }),
    ).toEqual({ path: "/p/agentic-kanban/graph", action: "replace" });
  });

  it("replaces an unresolvable slug with where the user actually is", () => {
    // The unresolved fallback keeps the active project and corrects the bar.
    expect(
      planUrlSync({ ...base, currentPath: "/p/does-not-exist/board", preferReplace: true }),
    ).toEqual({ path: "/p/agentic-kanban/board", action: "replace" });
  });

  it("falls back to the flat path when the active project has no slug", () => {
    // Projects loaded, but the active id is not among them (e.g. archived).
    expect(planUrlSync({ ...base, activeProjectId: "gone", view: "graph", currentPath: "/board" })).toEqual({
      path: "/graph",
      action: "push",
    });
  });

  it("keeps a legacy tab route's view when reflecting it back", () => {
    // /burndown resolves to the analytics view; the URL it syncs to is the
    // container's canonical path, so the tab request is not re-triggered.
    const parsed = parseAppPath("/p/agentic-kanban/burndown");
    expect(parsed.view).toBe("analytics");
    expect(parsed.tab).toBe("burndown");
    expect(planUrlSync({ ...base, view: "analytics", currentPath: "/p/agentic-kanban/burndown" })).toEqual({
      path: "/p/agentic-kanban/analytics",
      action: "replace",
    });
  });
});

describe("navigation bursts — one logical navigation, one back-step", () => {
  it("lets the first write push and coalesces the rest", () => {
    const burst = createNavigationBurst(1000);
    burst.mark(0);
    expect(burst.isCoalescing(0)).toBe(false); // first write pushes
    burst.notePush(0);
    expect(burst.isCoalescing(10)).toBe(true); // view step
    expect(burst.isCoalescing(50)).toBe(true); // issue step
  });

  it("re-marking inside an open burst does not hand out a second push", () => {
    const burst = createNavigationBurst(1000);
    burst.mark(0);
    burst.notePush(5);
    burst.mark(10); // the view step marks too
    burst.mark(20); // and the issue step
    expect(burst.isCoalescing(25)).toBe(true);
  });

  it("closes after the window so the next user navigation pushes again", () => {
    const burst = createNavigationBurst(1000);
    burst.mark(0);
    burst.notePush(0);
    expect(burst.isCoalescing(1500)).toBe(false);
  });

  it("is inert when no burst was ever started", () => {
    const burst = createNavigationBurst(1000);
    expect(burst.isCoalescing(0)).toBe(false);
  });

  it("a silent burst (popstate restore) never allows a push", () => {
    const burst = createNavigationBurst(1000);
    burst.markSilent(0);
    expect(burst.isCoalescing(0)).toBe(true);
    expect(burst.isCoalescing(500)).toBe(true);
    expect(burst.isCoalescing(1500)).toBe(false);
  });
});
