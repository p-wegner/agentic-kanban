import { describe, expect, it } from "vitest";
import { parseAppPath } from "../lib/appRoutes";
import {
  createNavigationBurst,
  createPendingDeepLink,
  isDeepLinkSettled,
  planDeepLinkIssue,
  planDeepLinkProject,
  planUrlSync,
  resolveSyncTab,
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
      panel: "issue",
    });
  });

  it("carries the panel the link names, so a reload reopens the SAME panel", () => {
    const pending = pendingFor("/p/pantry/board/issue/28/workspace");
    expect(pending.panel).toBe("workspace");
    pending.projectSettled = true;
    pending.targetProjectId = PANTRY;
    expect(planDeepLinkIssue(pending, { boardLoaded: true, activeProjectId: PANTRY })).toEqual({
      kind: "open",
      issueNumber: 28,
      panel: "workspace",
    });
  });

  it("opens an unscoped issue link as soon as the board is loaded", () => {
    const pending = pendingFor("/issues/7");
    expect(pending.issueNumber).toBe(7);
    expect(planDeepLinkIssue(pending, { boardLoaded: true, activeProjectId: AK })).toEqual({
      kind: "open",
      issueNumber: 7,
      panel: "issue",
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

  it("puts the workspace drawer in the URL, and switching panels is a navigation", () => {
    // MEASURED: opening the drawer left the bar on /p/<slug>/board — a full
    // panel on screen that the URL denied and a reload could not restore.
    expect(
      planUrlSync({ ...base, issueNumber: 28, panel: "workspace", currentPath: "/p/agentic-kanban/board" }),
    ).toEqual({ path: "/p/agentic-kanban/board/issue/28/workspace", action: "push" });
    // Detail -> workspace on the SAME issue is a different panel, so a real
    // history entry (back returns to the detail panel).
    expect(
      planUrlSync({
        ...base,
        issueNumber: 28,
        panel: "workspace",
        currentPath: "/p/agentic-kanban/board/issue/28",
      }).action,
    ).toBe("push");
    // Already correct: no write at all.
    expect(
      planUrlSync({
        ...base,
        issueNumber: 28,
        panel: "workspace",
        currentPath: "/p/agentic-kanban/board/issue/28/workspace",
      }).action,
    ).toBe("none");
    // A scoped upgrade of the workspace URL is still an in-place replace.
    expect(
      planUrlSync({ ...base, issueNumber: 28, panel: "workspace", currentPath: "/board/issue/28/workspace" }),
    ).toEqual({ path: "/p/agentic-kanban/board/issue/28/workspace", action: "replace" });
  });

  it("omits the panel segment when no issue panel is open", () => {
    expect(
      planUrlSync({ ...base, issueNumber: null, panel: "workspace", currentPath: "/p/agentic-kanban/graph" }),
    ).toEqual({ path: "/p/agentic-kanban/board", action: "push" });
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
    // The canonical form carries the tab (#446), so the legacy path upgrades in
    // place to /p/<slug>/analytics/burndown rather than losing the chart.
    expect(planUrlSync({ ...base, view: "analytics", currentPath: "/p/agentic-kanban/burndown" })).toEqual({
      path: "/p/agentic-kanban/analytics/burndown",
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

/**
 * The tab dimension (#446). MEASURED: `/p/taskflow/burndown` rendered Burndown
 * but the URL became `/p/taskflow/analytics`, and switching tabs inside a
 * container never changed the URL at all.
 */
describe("planUrlSync — the tab dimension", () => {
  const base = { projects: PROJECTS, activeProjectId: AK, view: "analytics" as const, issueNumber: null };
  const SLUG = "/p/agentic-kanban";

  it("names the active tab in the canonical path", () => {
    expect(planUrlSync({ ...base, tab: "burndown", currentPath: `${SLUG}/analytics/throughput` })).toEqual({
      path: `${SLUG}/analytics/burndown`,
      action: "push",
    });
  });

  it("gives a tab switch its own history entry", () => {
    // Same view, same issue — only the tab moved, and that is a navigation.
    expect(
      planUrlSync({ ...base, tab: "provider-mix", currentPath: `${SLUG}/analytics/burndown` }).action,
    ).toBe("push");
    // …unless it is one step of a coalesced programmatic navigation.
    expect(
      planUrlSync({
        ...base,
        tab: "provider-mix",
        currentPath: `${SLUG}/analytics/burndown`,
        preferReplace: true,
      }).action,
    ).toBe("replace");
  });

  it("upgrades a legacy flat tab path in place, keeping the tab", () => {
    expect(planUrlSync({ ...base, tab: null, currentPath: "/burndown" })).toEqual({
      path: `${SLUG}/analytics/burndown`,
      action: "replace",
    });
    expect(planUrlSync({ ...base, tab: null, currentPath: `${SLUG}/burndown` })).toEqual({
      path: `${SLUG}/analytics/burndown`,
      action: "replace",
    });
  });

  it("keeps the URL's tab while the container has not mounted yet", () => {
    // active tab unknown (null): the inbound link, not the default, wins.
    expect(planUrlSync({ ...base, tab: null, currentPath: `${SLUG}/analytics/provider-cost` }).path).toBe(
      `${SLUG}/analytics/provider-cost`,
    );
    // Nothing names a tab at all -> the default, as a replace (in-place upgrade).
    expect(planUrlSync({ ...base, tab: null, currentPath: `${SLUG}/analytics` })).toEqual({
      path: `${SLUG}/analytics/throughput`,
      action: "replace",
    });
  });

  it("ignores a tab that the view does not have", () => {
    expect(planUrlSync({ ...base, tab: "nonsense", currentPath: `${SLUG}/analytics/burndown` }).path).toBe(
      `${SLUG}/analytics/burndown`,
    );
    // A tab from ANOTHER container view is just as invalid.
    expect(planUrlSync({ ...base, tab: "health-events", currentPath: `${SLUG}/analytics` }).path).toBe(
      `${SLUG}/analytics/throughput`,
    );
  });

  it("never puts a tab on a view that has none", () => {
    expect(planUrlSync({ ...base, view: "kanban", tab: "burndown", currentPath: `${SLUG}/board` })).toEqual({
      path: `${SLUG}/board`,
      action: "none",
    });
  });

  it("keeps the tab beside an open issue panel", () => {
    expect(
      planUrlSync({
        ...base,
        tab: "burndown",
        issueNumber: 12,
        panel: "workspace",
        currentPath: `${SLUG}/analytics/burndown`,
      }),
    ).toEqual({ path: `${SLUG}/analytics/burndown/issue/12/workspace`, action: "push" });
  });

  it("resolveSyncTab is the single decision the sync makes about tabs", () => {
    expect(resolveSyncTab("kanban", "burndown", "burndown")).toBeNull();
    expect(resolveSyncTab("analytics", "burndown", "throughput")).toBe("burndown");
    expect(resolveSyncTab("analytics", null, "provider-mix")).toBe("provider-mix");
    expect(resolveSyncTab("analytics", "nope", null)).toBe("throughput");
    expect(resolveSyncTab("runtime", null, null)).toBe("flight-recorder");
  });
});
