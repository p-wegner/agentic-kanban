/**
 * Pure board-column projection for `getBoard`.
 *
 * The service fetches issues, statuses, workspace summaries, blocked/tag maps
 * and the staleness preferences from the DB, then projects them into the
 * grouped-by-column board view. That projection — the terminal-status override,
 * backlog/in-progress staleness, the column-age, and the terminal-column cap —
 * is pure given those inputs, so it lives here and can be unit-tested without a
 * database. The HTTP/service layer owns the I/O and the clock; this owns the math.
 *
 * Generic over the issue and workspace-summary row types so the projection
 * preserves whatever extra fields the caller's rows carry into the output.
 */

/** A project status (column) — only the fields the projection reads/emits. */
export interface BoardStatusRow {
  id: string;
  name: string;
  projectId: string;
  sortOrder: number;
}

/** The issue-row fields the projection reads (callers pass richer rows). */
export interface BoardIssueRowBase {
  id: string;
  statusId: string;
  statusName: string | null;
  statusChangedAt: string | null;
  updatedAt: string;
  createdAt: string;
  checklistJson?: string | null;
}

/** Blocked-state rollup per issue (from `buildBlockedMap`). */
export interface BlockedInfo {
  isBlocked: boolean;
  dependencyCount: number;
}

/** A tag attached to an issue (from `buildTagMap`). */
export interface BoardIssueTag {
  id: string;
  name: string;
  color: string | null;
}

/** The workspace-summary fields the terminal-status override reads. */
export interface BoardWorkspaceSummaryShape {
  main?: {
    status?: string | null;
    workflow?: { currentNodeStatusName?: string | null } | null;
  } | null;
}

export interface BuildBoardColumnsParams<
  TIssue extends BoardIssueRowBase,
  TSummary extends BoardWorkspaceSummaryShape,
> {
  /** All project statuses in display order (for name/id lookups). */
  statuses: BoardStatusRow[];
  /** Statuses to render as columns (statuses minus Archived unless includeArchived). */
  visibleStatuses: BoardStatusRow[];
  /** Issues to place on the board. */
  projectIssues: TIssue[];
  workspaceSummaryMap: Map<string, TSummary>;
  blockedMap: Map<string, BlockedInfo>;
  issueTagMap: Map<string, BoardIssueTag[]>;
  /** Reference time in ms (already resolved from any nowOverride). */
  now: number;
  /** Backlog staleness threshold in days. */
  staleDays: number;
  /** In-progress column staleness threshold in days. */
  inProgressStaleDays: number;
}

/**
 * Project issues into the grouped-by-column board view, applying the
 * terminal-status workflow override, staleness flags, column age, and the
 * terminal-column cap. Pure: same inputs → same output.
 */
export function buildBoardColumns<
  TIssue extends BoardIssueRowBase,
  TSummary extends BoardWorkspaceSummaryShape,
>(params: BuildBoardColumnsParams<TIssue, TSummary>) {
  const {
    statuses,
    visibleStatuses,
    projectIssues,
    workspaceSummaryMap,
    blockedMap,
    issueTagMap,
    now,
    staleDays,
    inProgressStaleDays,
  } = params;

  const staleMs = staleDays * 24 * 60 * 60 * 1000;
  const inProgressStaleMs = inProgressStaleDays * 24 * 60 * 60 * 1000;
  const backlogStatusNames = new Set(statuses.filter((s) => s.name.toLowerCase() === "backlog").map((s) => s.id));
  const inProgressStatusNames = new Set(statuses.filter((s) => s.name.toLowerCase() === "in progress").map((s) => s.id));

  const statusByName = new Map(statuses.map((status) => [status.name.toLowerCase(), status]));
  const TERMINAL_STATUS_NAMES = new Set(["done", "cancelled"]);
  const issuesWithBlocked = projectIssues.map((issue) => {
    const wsSummary = workspaceSummaryMap.get(issue.id);
    const blocked = blockedMap.get(issue.id);
    // Never let a stale workspace workflow node override an issue that is already in a
    // terminal status (Done/Cancelled). The issue's DB statusId is the canonical source
    // of truth; a workspace's currentNodeStatusName reflects where the workspace was in
    // its workflow, but if the issue has been moved to Done the board must honour that.
    const issueIsTerminal = TERMINAL_STATUS_NAMES.has(issue.statusName?.toLowerCase() ?? "");
    const workflowStatusName = !issueIsTerminal && wsSummary?.main?.status !== "closed"
      ? wsSummary?.main?.workflow?.currentNodeStatusName
      : null;
    const workflowStatus = workflowStatusName
      ? statusByName.get(workflowStatusName.toLowerCase())
      : null;
    const effectiveStatusId = workflowStatus ? workflowStatus.id : issue.statusId;
    const isInBacklog = backlogStatusNames.has(effectiveStatusId);
    const isInProgress = inProgressStatusNames.has(effectiveStatusId);
    let isStale: boolean | undefined;
    let staleDaysActual: number | undefined;
    if (isInBacklog) {
      const lastActivity = new Date(issue.statusChangedAt ?? issue.updatedAt).getTime();
      const elapsed = now - lastActivity;
      if (elapsed >= staleMs) {
        isStale = true;
        staleDaysActual = Math.floor(elapsed / (24 * 60 * 60 * 1000));
      }
    }
    const columnEnteredAt = new Date(issue.statusChangedAt ?? issue.createdAt).getTime();
    const columnElapsed = now - columnEnteredAt;
    const columnAgeDays = Math.floor(columnElapsed / (24 * 60 * 60 * 1000));
    const isColumnStale = isInProgress && columnElapsed >= inProgressStaleMs;
    return {
      ...issue,
      ...(workflowStatus ? { statusId: workflowStatus.id, statusName: workflowStatus.name } : {}),
      ...(wsSummary ? { workspaceSummary: wsSummary } : {}),
      ...(blocked ? { isBlocked: blocked.isBlocked, dependencyCount: blocked.dependencyCount } : {}),
      ...(isStale ? { isStale: true, staleDays: staleDaysActual } : {}),
      columnAgeDays,
      ...(isColumnStale ? { isColumnStale: true } : {}),
    };
  });

  const TERMINAL_COLUMN_NAMES = new Set(["done", "cancelled"]);
  const TERMINAL_COLUMN_CAP = 50;

  return visibleStatuses.map((s) => {
    const isTerminal = TERMINAL_COLUMN_NAMES.has(s.name.toLowerCase());
    let columnIssues = issuesWithBlocked.filter((i) => i.statusId === s.id);
    const totalCount = columnIssues.length;

    if (isTerminal && columnIssues.length > TERMINAL_COLUMN_CAP) {
      // Sort by statusChangedAt desc, falling back to updatedAt, then take top N
      columnIssues = columnIssues
        .slice()
        .sort((a, b) => {
          const ta = new Date(a.statusChangedAt ?? a.updatedAt).getTime();
          const tb = new Date(b.statusChangedAt ?? b.updatedAt).getTime();
          return tb - ta;
        })
        .slice(0, TERMINAL_COLUMN_CAP);
    }

    return {
      id: s.id,
      name: s.name,
      projectId: s.projectId,
      sortOrder: s.sortOrder,
      count: totalCount,
      issues: columnIssues.map((i) => {
        const { checklistJson, ...rest } = i;
        let checklist: { id: string; text: string; completed: boolean }[] | undefined;
        if (checklistJson) {
          try { checklist = JSON.parse(checklistJson) as { id: string; text: string; completed: boolean }[]; } catch { checklist = undefined; }
        }
        return {
          ...rest,
          tags: issueTagMap.get(i.id) ?? [],
          ...(checklist && checklist.length > 0 ? { checklist } : {}),
        };
      }),
    };
  });
}
