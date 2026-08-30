import { projectPref } from "@agentic-kanban/shared/lib/dynamic-preference-keys";
import { resolveRiskPosture, type RiskPosture } from "./risk-posture.service.js";

/**
 * Merge train review mode (#907), now fanned out from the risk-posture dial (#937,
 * decision 017). `resolveProjectReviewMode` below is the resolver every consumer reads;
 * `review_mode_<projectId>` stays as the operator's finer-grained per-project override,
 * exactly as `file_contention_<projectId>` does for `contentionMode` (#911).
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
 *
 * **Placement (#946)**: this is a prefMap resolver over `resolveRiskPosture`, so it lives in
 * `services/` beside its siblings of the same shape (`merge-train-window.ts`,
 * `pre-merge-gate-tier.ts`, `placement-evaluators.ts`) — not in `lib/`, whose contract is
 * "imports no services". It was in `lib/` and imported `risk-posture.service.ts`, which is the
 * `server-lib→server-service` violation the pattern-language spec forbids. Purity is unchanged:
 * `resolveProjectReviewMode` is still sync and touches no DB, exactly as
 * `prefmap-resolver-purity.test.ts` requires of a `resolveX(prefMap, …)`.
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

/**
 * The review DECISION for a project, as a pure prefMap resolver (#937) — the whole of what
 * decision 017's `reviewMode` field means, in one place:
 *
 *  - `run`      — should a per-ticket auto-review be launched at all? `sprint`'s
 *                 `reviewMode: "none"` is the one posture that says no. (A workspace's own
 *                 `requiresReview` flag and `skipAutoReview` still decide independently; this
 *                 is the POSTURE's contribution, applied by the exit workflow beside them.)
 *  - `mode`     — `per-ticket` vs `per-train` assembly of the reviewed diff. `fast`'s
 *                 `train-only` maps to `per-train`; every other posture to `per-ticket`.
 *  - `thorough` — `strict`'s `reviewMode: "thorough"` selects the `code-review-thorough`
 *                 skill, the same escalation `workspace.thoroughReview` already asks for.
 *
 * `review_mode_<projectId>` is the finer-grained override and wins for `mode` only when set —
 * an operator who pinned per-train batching keeps it under any posture. It says nothing about
 * `run`/`thorough`, so those always come from the posture.
 *
 * `standard` reproduces today's behaviour exactly: `run: true`, `mode: "per-ticket"`,
 * `thorough: false`.
 */
export interface ReviewDecision {
  run: boolean;
  mode: ReviewMode;
  thorough: boolean;
  posture: RiskPosture;
}

export function resolveProjectReviewMode(prefMap: Map<string, string>, projectId: string): ReviewDecision {
  const posture = resolveRiskPosture(prefMap, projectId);
  const explicit = prefMap.get(reviewModePref.key(projectId));
  const mode: ReviewMode = explicit !== undefined
    ? resolveReviewMode(explicit)
    : posture.reviewMode === "train-only"
      ? "per-train"
      : REVIEW_MODE_DEFAULT;
  return {
    run: posture.reviewMode !== "none",
    mode,
    thorough: posture.reviewMode === "thorough",
    posture,
  };
}
