import type { CreateIssueRequest, IssueEstimate } from "@agentic-kanban/shared";

/**
 * DTO shapes for the board surface (#610).
 *
 * `routes/BoardPage.tsx` had become the board's de-facto DTO module — the container page
 * declaring the types its hooks return, so `hooks/useBoardDataQueries.ts` and
 * `hooks/createBoardIssueActions.ts` imported UPWARD out of a route. Type-only, therefore
 * erased and invisible, therefore never caught.
 *
 * `Tag` is the reason this is worth doing rather than tidying: it was declared TWICE — here
 * (from `BoardPage`) and in `hooks/useBulkOperations.ts` — the same drift that had already
 * produced two incompatible `WorkspaceInitial` definitions.
 *
 * `BoardPage` and `CreateIssueForm` re-export these, so their existing importers are
 * unchanged.
 */

export interface Tag {
  id: string;
  name: string;
  color: string | null;
}

/** The inline create-issue form's own state, lifted so hooks can name it. */
export interface CreateIssueFormState {
  title: string;
  description: string;
  pastedImages: string[];
  issueType: CreateIssueRequest["issueType"];
  estimate?: IssueEstimate | "";
  startWorkspace: boolean;
  planMode: boolean;
  skipAutoReview: boolean;
  skillId?: string;
}

/** Inline create-issue panel expanded under a column. */
export type ExpandedCreatePanel =
  | { statusId: string; statusName: string; state: Partial<CreateIssueFormState> }
  | null;
