/**
 * The PATCH-body field vocabulary for an issue update: which keys land on the row, how each one
 * lands, and therefore which keys nobody reads.
 *
 * Extracted from `issue.service.ts`. #987 added the table and the two derived key sets to that
 * file and pushed it from 987 to 1044 lines, past the 1000-line god-module ceiling — so this
 * split is the gate's own prescription rather than a shuffle to get under a number. It is also
 * the right seam independently: `routes/issues.ts` needs the recognized key SET without needing
 * the issue service at all, and everything here is pure (no DB, no events, no board caches), so
 * it is unit-testable without standing anything up.
 *
 * The external-tracker normalisers come along because they are the field normalisers for two of
 * these very keys (`externalKey`/`externalUrl`). Splitting a field's validation from its entry in
 * the table is exactly what lets the two drift.
 */
import { IssueError } from "./issue-error.js";


/**
 * Validate an optional external-tracker URL: must be absent/null/empty, or a
 * well-formed http(s) URL. Returns the trimmed URL (or null). Throws IssueError
 * (BAD_REQUEST) for any other scheme or malformed value so links can be opened
 * safely in a new tab without smuggling javascript:/data: payloads.
 */
export function validateExternalUrl(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new IssueError("externalUrl must be a string", "BAD_REQUEST");
  }
  const trimmed = value.trim();
  if (trimmed === "") return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new IssueError("externalUrl must be a valid URL", "BAD_REQUEST");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new IssueError("externalUrl must use http or https", "BAD_REQUEST");
  }
  return trimmed;
}

export function normalizeExternalKey(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new IssueError("externalKey must be a string", "BAD_REQUEST");
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Build the column updates SHARED by single-issue and bulk-issue updates from a PATCH
 * body. Pure (no DB) so it is unit-testable and so the two write paths can never drift
 * on these fields again — previously this block was duplicated verbatim in updateIssue
 * and updateIssuesBulk. Caller-specific fields stay with the caller: updateIssue layers
 * on checklist/pinned/milestoneId after calling this; those are intentionally NOT part
 * of bulk update.
 */
/**
 * Body key -> how it lands on the row. A TABLE rather than the `if` chain this used to be
 * (#987), because the key set is now needed in a second place: the route has to know which
 * fields it recognises in order to say when it recognised none of them.
 *
 * The table IS that list. A hand-written `RECOGNIZED_KEYS` beside an `if` chain is two
 * descriptions of one thing, and the one that drifts is the one that 422s a field that works.
 */
const SHARED_ISSUE_UPDATE_FIELDS: Record<
  string,
  (value: unknown, updates: Record<string, unknown>, now: string) => void
> = {
  title: (v, u) => { u.title = v; },
  description: (v, u) => { u.description = v; },
  priority: (v, u) => { u.priority = v; },
  issueType: (v, u) => { u.issueType = v; },
  statusId: (v, u, now) => { u.statusId = v; u.statusChangedAt = now; },
  sortOrder: (v, u) => { u.sortOrder = v; },
  estimate: (v, u) => { u.estimate = v; },
  skipAutoReview: (v, u) => { u.skipAutoReview = v; },
  dueDate: (v, u) => { u.dueDate = v; },
  externalKey: (v, u) => { u.externalKey = normalizeExternalKey(v); },
  externalUrl: (v, u) => { u.externalUrl = validateExternalUrl(v); },
  workflowTemplateId: (v, u) => { u.workflowTemplateId = v; },
};

/**
 * The keys `updateIssue` and `updateIssuesBulk` actually read (#987).
 *
 * `PATCH /api/issues/:id` forwards its whole body to a service that picks fields out of it and
 * ignores the rest, and it returned **200 with the full issue object** either way. Measured
 * live 2026-09-01: three tickets closed with `{"status":"Done"}` (the field is `statusId`)
 * were still `Todo` hours later, and the UI's own card context menu had been PATCHing
 * `{statusName}` — a "Move to status" action that did nothing, silently, with no error toast
 * because the request succeeded.
 *
 * The three the table above does not cover are handled directly in `updateIssue`; they are
 * listed here rather than added to the table because each writes a column the shared/bulk path
 * deliberately does not (`checklist` serialises, `milestoneId` normalises undefined to null).
 */
export const RECOGNIZED_ISSUE_UPDATE_KEYS: ReadonlySet<string> = new Set([
  ...Object.keys(SHARED_ISSUE_UPDATE_FIELDS),
  "checklist",
  "pinned",
  "milestoneId",
]);

/** The subset of {@link RECOGNIZED_ISSUE_UPDATE_KEYS} a BULK update can apply. */
export const RECOGNIZED_BULK_ISSUE_UPDATE_KEYS: ReadonlySet<string> = new Set(
  Object.keys(SHARED_ISSUE_UPDATE_FIELDS),
);

/**
 * Which of `body`'s keys nobody will read (#987). Empty means every field will be applied.
 *
 * Returned rather than thrown so the caller decides the status code — the route 422s (the
 * #874 precedent: a write that reports success for work it did not do is the defect), while
 * an internal caller assembling its own body can simply assert it is empty.
 */
export function unrecognizedIssueUpdateKeys(
  body: Record<string, unknown>,
  recognized: ReadonlySet<string> = RECOGNIZED_ISSUE_UPDATE_KEYS,
): string[] {
  return Object.keys(body).filter((key) => !recognized.has(key));
}

export function buildSharedIssueUpdate(
  body: Record<string, unknown>,
  now: string,
): Record<string, unknown> {
  const updates: Record<string, unknown> = { updatedAt: now };
  for (const [key, apply] of Object.entries(SHARED_ISSUE_UPDATE_FIELDS)) {
    if (body[key] !== undefined) apply(body[key], updates, now);
  }
  return updates;
}
