import { projectPref } from "./dynamic-preference-keys.js";

/**
 * Merge train review mode (#907): a project-scoped stand-in for the risk-posture
 * resolver (#911, not yet landed). `fast` posture will select train review by
 * default once the resolver exists; until then this is the one pref an operator
 * flips per project.
 *
 * `per-ticket` (default) reviews each workspace's own diff, one session per ticket —
 * today's behaviour, unchanged. `per-train` reviews the ASSEMBLED diff of a
 * ticket-group workspace (lead + `workspace_issue_members`) in a single session that
 * lists every member's number, title and acceptance criteria — see
 * `{{members}}` in the `code-review` skill.
 *
 * A workspace with no members behaves identically under either mode: there is
 * nothing to assemble, so `per-train` degrades to the same single-ticket review
 * `per-ticket` would run.
 */
export const REVIEW_MODES = ["per-ticket", "per-train"] as const;
export type ReviewMode = (typeof REVIEW_MODES)[number];

export const reviewModePref = projectPref("review_mode");

export const REVIEW_MODE_DEFAULT: ReviewMode = "per-ticket";

/**
 * Resolve a project's review mode from a raw preference value. Any value other than
 * the exact string `"per-train"` resolves to `"per-ticket"` — unset, unrecognized, or
 * mistyped all fail closed to the reviewed-every-ticket default rather than silently
 * skipping per-ticket review.
 */
export function resolveReviewMode(value: string | null | undefined): ReviewMode {
  return value === "per-train" ? "per-train" : REVIEW_MODE_DEFAULT;
}
