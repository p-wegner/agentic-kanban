import { describe, expect, it } from "vitest";
import { planInboxNavigation, type InboxLink } from "./inboxNavigation";

/**
 * MEASURED: the #411 header "waiting on you" chip for `#28 Requirement extraction:
 * badging` — a live `plugin-merge` item whose link is
 * `{view:"board", workspaceId:"6ed242cb-…", issueNumber:28}` — landed on
 * `/p/eventhub/board` with no panel open and no `/issue/28` in the URL. The
 * operator is told WHICH ticket is blocked, clicks it, and arrives at a board.
 */
function item(link: InboxLink, projectId = "44beaae2") {
  return { projectId, link };
}

describe("planInboxNavigation — a click opens what the item names", () => {
  it("opens the workspace drawer for a merge that never landed", () => {
    expect(
      planInboxNavigation(
        item({ view: "board", workspaceId: "6ed242cb-f8b7-42c2-a7f0-09e9011b5505", issueNumber: 28 }),
      ),
    ).toEqual({
      projectId: "44beaae2",
      view: "kanban",
      focusLoop: null,
      focusIssue: {
        issueNumber: 28,
        panel: "workspace",
        workspaceId: "6ed242cb-f8b7-42c2-a7f0-09e9011b5505",
      },
    });
  });

  it("opens the detail panel when the item names an issue but no workspace", () => {
    expect(planInboxNavigation(item({ view: "board", issueNumber: 12 })).focusIssue).toEqual({
      issueNumber: 12,
      panel: "issue",
    });
  });

  it("still routes a plugin gate to its loop pane, with no issue focus", () => {
    const nav = planInboxNavigation(
      item({ view: "plugin-views", pluginSlug: "pm-pipeline", loopName: "pipeline" }, "4f1afbd7"),
    );
    expect(nav).toEqual({
      projectId: "4f1afbd7",
      view: "plugin-views",
      focusLoop: { pluginSlug: "pm-pipeline", loopName: "pipeline" },
      focusIssue: null,
    });
  });

  it("does not yank a butler/gate item onto the board because it carries an issue", () => {
    // The butler link (agent question) names an issue for context; the thing to
    // land on is still the butler view.
    const nav = planInboxNavigation(item({ view: "butler", workspaceId: "w1", issueNumber: 5 }));
    expect(nav.view).toBe("butler");
    expect(nav.focusIssue).toBeNull();
  });

  it("navigates without an issue focus when the link names none", () => {
    // A tool-approval item carries only a workspace id.
    expect(planInboxNavigation(item({ view: "board", workspaceId: "w9" })).focusIssue).toBeNull();
    expect(planInboxNavigation(item({ view: "board", issueNumber: null })).focusIssue).toBeNull();
    expect(planInboxNavigation(item({ view: "board" })).view).toBe("kanban");
  });
});
