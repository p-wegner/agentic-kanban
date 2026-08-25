import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { relations } from "drizzle-orm";
import { workspaces } from "./workspaces.js";

/**
 * The pre-merge gate's EVIDENCE for a workspace, extracted out of `workspaces` (#815, the
 * fifth family after `merge_backoff_*` in #781 and `review_preflight_*` / `code_metrics_*` /
 * `latest_symlink_*` in #798).
 *
 * The five `merge_gate_*` columns record when and how the gate last ACTUALLY ran and passed —
 * deliberately distinct from `readyForMerge`/`updatedAt`, which say nothing about whether a
 * gate ran (#182), and from a bare timestamp, because the branch/base tips make the proof
 * verifiable by CONTENT rather than by age (0108). Only three code paths touch them: the
 * writer (`startup/exit-workflow.ts`, arming `readyForMerge`), the clear
 * (`startup/exit/fix-and-merge-exit.ts`, when a fix-and-merge run invalidates the proof) and
 * the monitor's candidate read (`startup/monitor-setup.ts`), which aliases them straight back
 * to the same field names so `startup/monitor-cycle.ts` — which reads them off the projected
 * ROW, not the table — is untouched.
 *
 * The row is ABSENT rather than nulled when there is no trustworthy evidence, which is the
 * same distinction the columns carried: `resolveMergeGate` re-runs the gate when the evidence
 * is missing, so "no row" and "all five null" mean the identical thing, and deleting is how
 * the clear is spelled. The reads therefore LEFT JOIN from `workspaces` — an inner join would
 * make every never-gated workspace invisible to the monitor.
 *
 * `onDelete: "cascade"`, so the evidence dies with its workspace; the FK's leading index is
 * the primary key's own automatic index (#740).
 */
export const workspaceMergeGate = sqliteTable("workspace_merge_gate", {
  /** The workspace this evidence belongs to. PK: one gate proof per workspace. */
  workspaceId: text("workspace_id")
    .primaryKey()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  /** When the gate FINISHED — never the exit-handler's `now`, which predates it by the whole run. */
  ranAt: text("ran_at"),
  /** The gate stage the run reached, e.g. `verify`. */
  stage: text("stage"),
  /** Which path produced the proof, e.g. `review-exit gate`. */
  source: text("source"),
  /** The branch tip the gate ran against; a moved tip voids the proof however fresh it looks. */
  branchSha: text("branch_sha"),
  /** The base tip the gate ran against. Same role as `branchSha` (0108). */
  baseSha: text("base_sha"),
  /**
   * Fingerprint of WHAT verification the pass bought — `gateVerificationKey(strategy,
   * verifyCommand)`, the same key the in-memory tree memo is scoped by (#893). A pass earned
   * under a weaker tier (or an older verify_script) must not be reused after the operator
   * tightens either one, and unlike the tips, "the tier changed" is invisible to content.
   * Nullable: evidence written before #893 (or by a writer that did not resolve it) simply
   * cannot be reused by the bounded cross-restart reuse path, which fails safe into a re-run.
   */
  verificationKey: text("verification_key"),
});

export const workspaceMergeGateRelations = relations(workspaceMergeGate, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [workspaceMergeGate.workspaceId],
    references: [workspaces.id],
  }),
}));
