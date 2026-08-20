// What clicking an inbox item should DO (#446 follow-up), as a pure decision so
// it can be unit-tested without a DOM.
//
// MEASURED defect this fixes: the header "waiting on you" chip for
// `#28 Requirement extraction: badging` (a `plugin-merge` item whose link names
// `{view:"board", workspaceId, issueNumber:28}`) navigated to `/p/eventhub/board`
// with NO panel open and no `/issue/28` in the URL. The operator is told exactly
// which ticket is blocked, clicks it, and lands on a board.
//
// The item's link already carries everything needed; it was simply dropped.
import type { ViewMode } from "./viewRegistry.js";

/** The link half of an inbox item (see InboxItem in ../hooks/useInbox.ts). */
export interface InboxLink {
  view: "plugin-views" | "butler" | "board";
  pluginId?: string;
  pluginSlug?: string;
  loopName?: string;
  workspaceId?: string;
  issueNumber?: number | null;
}

export interface InboxNavigation {
  /** The project to make active first — an item may belong to another one (#323). */
  projectId: string;
  /** The view to land on. */
  view: ViewMode;
  /** The plugin loop pane to focus, when the item is a plugin gate. */
  focusLoop: { pluginSlug: string; loopName: string } | null;
  /**
   * The issue panel to open, when the link names an issue. `panel: "workspace"`
   * means the workspace drawer — that is what a `plugin-merge` item ("finished,
   * waiting to land") is actually about, and it is the panel that holds the
   * merge action.
   */
  focusIssue: {
    issueNumber: number;
    panel: "issue" | "workspace";
    workspaceId?: string;
  } | null;
}

/**
 * Map an inbox item's link to the navigation it names. Everything the link
 * carries is used: project, view, loop, issue, and (for the panel choice) the
 * workspace id.
 */
export function planInboxNavigation(item: { projectId: string; link: InboxLink }): InboxNavigation {
  const link = item.link;
  const view: ViewMode = link.view === "plugin-views" ? "plugin-views" : link.view === "butler" ? "butler" : "kanban";

  const focusLoop =
    link.view === "plugin-views" && link.pluginSlug && link.loopName
      ? { pluginSlug: link.pluginSlug, loopName: link.loopName }
      : null;

  // Only the board view has issue panels; a gate/butler item that happens to
  // carry an issue number must not yank the user onto the board.
  const issueNumber = typeof link.issueNumber === "number" && link.issueNumber > 0 ? link.issueNumber : null;
  const focusIssue =
    link.view === "board" && issueNumber !== null
      ? {
          issueNumber,
          panel: link.workspaceId ? ("workspace" as const) : ("issue" as const),
          ...(link.workspaceId ? { workspaceId: link.workspaceId } : {}),
        }
      : null;

  return { projectId: item.projectId, view, focusLoop, focusIssue };
}
