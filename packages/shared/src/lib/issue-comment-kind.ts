/**
 * The issue-comment kind vocabulary as a runtime array (#569).
 *
 * Lives in `lib`, not `types`, because `types/api.ts` is an `export type *` barrel and
 * cannot carry a value — and the route needs a membership test. It had one, hand-listed
 * and four members short: `routes/issues.ts` re-listed a 4-member `validKinds` while the
 * repository union has six, so `preflight-verdict` and `gate-decision` — both of which
 * the server itself writes — were rejected on the user-facing POST.
 */

export const ISSUE_COMMENT_KINDS = [
  "preflight-verdict",
  "preflight-clarification",
  "agent-question",
  "merge-attempt",
  "note",
  "gate-decision",
] as const;

export type IssueCommentKind = (typeof ISSUE_COMMENT_KINDS)[number];

export function isIssueCommentKind(value: unknown): value is IssueCommentKind {
  return typeof value === "string" && (ISSUE_COMMENT_KINDS as readonly string[]).includes(value);
}
