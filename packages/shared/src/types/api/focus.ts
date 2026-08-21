// Focus-view and inbox wire DTOs (#704). See ../api.ts barrel.

export interface FocusData {
  now: string;
  /** Ready-to-start issues, highest focusScore first. */
  ready: FocusIssue[];
  /** Open issues with at least one unresolved blocker, highest leverage first. */
  blocked: FocusIssue[];
  headline: {
    openCount: number;
    readyCount: number;
    blockedCount: number;
    inFlightCount: number;
    topScore: number;
  };
}

export interface FocusIssue {
  issueId: string;
  issueNumber: number | null;
  title: string;
  statusName: string;
  priority: string;
  issueType: string;
  estimate: string | null;
  /** IDs of still-open issues directly blocking this one. */
  blockedBy: Array<{ issueId: string; issueNumber: number | null; title: string }>;
  /** Count of still-open issues this one transitively unblocks. */
  unblocks: number;
  focusScore: number;
  /** Short human-readable reasons explaining the score (for the UI). */
  reasons: string[];
}

/**
 * Cross-project "Waiting on you" inbox (#302) — the union of every decision that is
 * blocked on a human, across ALL projects: pending plugin-loop gates, unanswered agent
 * questions, and un-decided tool approvals. Nothing like this existed at any layer:
 * each of those was project-scoped and lived in its own pane, so a gate on a project
 * whose tab wasn't open was invisible once its 4-second toast faded.
 *
 * Read-only aggregation — every item carries what a client needs to DEEP-LINK to the
 * surface that can actually resolve it. Plan approvals (spec-planning workspaces) are
 * a known follow-up; they need a cheap cross-project "planning awaiting approval"
 * query that doesn't exist yet.
 */

export interface InboxItem {
  /**
   * `plugin-merge` (#440) is a loop whose builder finished but whose merge never
   * landed. It waits on a human exactly as a gate does — nothing advances the loop
   * until someone lands or discards it — but it was omitted here for months while
   * `list_plugin_gates` reported it, so the two surfaces disagreed on what
   * "waiting on you" means.
   */
  kind: "plugin-gate" | "plugin-merge" | "agent-question" | "tool-approval";
  projectId: string;
  projectName: string;
  title: string;
  detail: string | null;
  /** Client-side navigation hints — which surface resolves this item. */
  link: {
    view: "plugin-views" | "butler" | "board";
    pluginId?: string;
    pluginSlug?: string;
    loopName?: string;
    workspaceId?: string;
    issueNumber?: number | null;
  };
  createdAt: string | null;
}
