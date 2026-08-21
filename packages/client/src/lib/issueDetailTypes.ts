import type { ActivityEvent, ActivityEventType, StatusDuration, TimeEntry, TouchedFile } from "@agentic-kanban/shared";
// #704: moved to shared/src/types/api/. Re-exported so importers of this module are unchanged.
export type { ActivityEvent, ActivityEventType, StatusDuration, TimeEntry, TouchedFile };
/**
 * DTO shapes for the issue-detail surface (#610).
 *
 * Each of these was declared in the COMPONENT that renders it, and
 * `hooks/useIssueDetailData.ts`, `useIssueActions.ts` and `useIssueDetailUiState.ts`
 * imported them UPWARD — nine edges from three hooks into six components.
 *
 * `.dependency-cruiser.cjs` enforces `client-hooks-not-up-to-components-or-routes`, and
 * every one of the client's 24 draft violations was this shape: a type-only import pointing
 * up the layering. Type-only imports are erased at compile time, so nothing ever failed
 * while the DTO describing a HOOK'S RETURN VALUE lived in whichever leaf happened to render
 * it. The cost is not the edge, it is what the edge permits: with no module that owns the
 * shape, `Project` ended up declared three times and `WorkspaceInitial` twice with a real
 * drift between the copies.
 *
 * Every component still re-exports its own names, so their existing importers are untouched.
 * Follows the `lib/<feature>Types.ts` convention set by `projectTypes.ts`.
 */









export interface CycleTimeData {
  totalAgeMs: number;
  createdAt: string;
  closedAt: string | null;
  isOpen: boolean;
  statusBreakdowns: StatusDuration[];
}



export interface TimeEntriesData {
  entries: TimeEntry[];
  totalMinutes: number;
}

export interface RelatedIssue {
  id: string;
  issueNumber: number | null;
  title: string;
  sharedFileCount: number;
}

/** A pending move-to-Done awaiting confirmation. */
export interface MoveToDonePending {
  confirm: () => Promise<void>;
}

/** A pending status change whose dependency impact must be confirmed first. */
export interface DependencyImpactPending {
  toStatusId: string;
  toStatusName: string;
  confirm: () => Promise<void>;
}
