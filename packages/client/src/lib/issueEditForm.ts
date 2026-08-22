import type { IssueWithStatus, UpdateIssueRequest } from "@agentic-kanban/shared";
import { mergeDescriptionWithImages } from "./pastedImages.js";
import { isHttpUrl } from "./url.js";

/**
 * The pure half of `hooks/useIssueEditForm` (#782).
 *
 * The hook owns React state; the two things worth testing in it were never stateful —
 * a nine-field dirty comparison and the save-payload construction (title trimming,
 * pasted-image markdown, the external-URL guard, the `"" → null` normalisations).
 * `packages/client` has no jsdom by design, so logic living inside a hook is logic no
 * test can reach; `lib/` is where a pure client module belongs (#589), so it moved here
 * rather than a browser harness moving in.
 */

/** The nine editable fields the issue edit form owns. */
export interface IssueEditFields {
  title: string;
  description: string;
  issueType: string;
  estimate: string;
  dueDate: string;
  externalKey: string;
  externalUrl: string;
  skipAutoReview: boolean;
  milestoneId: string | null;
}

/**
 * The saved issue projected onto the editable-field shape — the form's initial state AND
 * the baseline the dirty check compares against, so "what the fields start as" and "what
 * counts as unchanged" cannot drift apart (they were two separate nine-line literals).
 */
export function issueEditBaseline(issue: IssueWithStatus): IssueEditFields {
  return {
    title: issue.title,
    description: issue.description ?? "",
    issueType: issue.issueType ?? "task",
    estimate: issue.estimate ?? "",
    dueDate: issue.dueDate ?? "",
    externalKey: issue.externalKey ?? "",
    externalUrl: issue.externalUrl ?? "",
    skipAutoReview: issue.skipAutoReview ?? false,
    milestoneId: issue.milestoneId ?? null,
  };
}

/**
 * True when any editable field differs from the saved issue. Drives the
 * unsaved-changes confirm on cancel, so a false negative silently discards edits.
 */
export function hasIssueEditChanges(fields: IssueEditFields, issue: IssueWithStatus): boolean {
  const baseline = issueEditBaseline(issue);
  return (
    fields.title !== baseline.title ||
    fields.description !== baseline.description ||
    fields.issueType !== baseline.issueType ||
    fields.estimate !== baseline.estimate ||
    fields.dueDate !== baseline.dueDate ||
    fields.externalKey !== baseline.externalKey ||
    fields.externalUrl !== baseline.externalUrl ||
    fields.skipAutoReview !== baseline.skipAutoReview ||
    fields.milestoneId !== baseline.milestoneId
  );
}

/** Message shown when the external-tracker URL is not an absolute http(s) URL. */
export const EXTERNAL_URL_ERROR = "External URL must start with http:// or https://";

/**
 * Validate the fields before a save. Returns the message to surface, or null when the
 * save may proceed. An empty external URL is valid (it clears the link).
 */
export function validateIssueEditFields(fields: IssueEditFields): string | null {
  const trimmedUrl = fields.externalUrl.trim();
  if (trimmedUrl && !isHttpUrl(trimmedUrl)) return EXTERNAL_URL_ERROR;
  return null;
}

/**
 * Build the `PATCH /api/issues/:id` body from the form fields plus any pasted images.
 *
 * The `"" → null` normalisations are the contract with the server: null CLEARS a column,
 * `undefined` leaves it alone — so an emptied due date must serialize as null, while an
 * emptied description stays undefined (the panel has no "delete the description" affordance
 * and an empty string would blank it on every save of an image-only edit).
 */
export function buildIssueUpdatePayload(fields: IssueEditFields, pastedImages: string[]): UpdateIssueRequest {
  const fullDescription = mergeDescriptionWithImages(fields.description, pastedImages);
  return {
    title: fields.title.trim(),
    description: fullDescription || undefined,
    issueType: fields.issueType as UpdateIssueRequest["issueType"],
    estimate: (fields.estimate || null) as UpdateIssueRequest["estimate"],
    skipAutoReview: fields.skipAutoReview,
    dueDate: fields.dueDate || null,
    externalKey: fields.externalKey.trim() || null,
    externalUrl: fields.externalUrl.trim() || null,
    milestoneId: fields.milestoneId || null,
  };
}
