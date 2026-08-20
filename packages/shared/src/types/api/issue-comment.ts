/**
 * Issue-comment wire types (#569).
 *
 * `IssueComment` was declared in `server/src/services/issue-comments.service.ts` and
 * again in `client/src/components/IssueDetailComments.tsx`, both with `kind: string`,
 * although the repository has had a six-member `IssueCommentKind` union all along. The
 * consequence is visible in the UI: the client's label map lists four kinds, so
 * `preflight-verdict` and `gate-decision` render as their raw slug.
 */

// The runtime array lives in `lib/issue-comment-kind.ts` — `types/` is an
// `export type *` barrel and cannot carry a value.
import type { IssueCommentKind } from "../../lib/issue-comment-kind.js";
export type { IssueCommentKind };

export interface IssueComment {
  id: string;
  issueId: string;
  workspaceId: string | null;
  kind: IssueCommentKind;
  author: string;
  body: string;
  /** Parsed structured payload (null when none / unparseable). */
  payload: unknown;
  createdAt: string;
}
