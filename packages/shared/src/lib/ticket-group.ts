import { projectPref } from "./dynamic-preference-keys.js";

/**
 * Ticket groups (#661): N coupled tickets served by ONE workspace/agent/review/gate.
 *
 * The GROUPING SIGNAL is the existing `coupled_with` dependency edge ("touch the same
 * code, best implemented together") — humans set it in the dependency UI, the analyzer
 * proposes it, `create_issues_batch` seeds it, and the group-scan pass writes it in bulk.
 * This module only holds the policy knobs shared by the monitor (auto-group on start)
 * and the create path; the membership rows live in `workspace_issue_members`.
 *
 * Relationship to `auto_contract_coupled` (#918): contraction is the DESTRUCTIVE
 * consolidation (one merged ticket, members cancelled); grouping is the non-destructive
 * one (every ticket keeps its identity, they share a worktree). A project running
 * contract-in-apply-mode simply leaves nothing for grouping to pick up.
 */

/** Lead + members. Groups above this are split across cycles rather than one giant branch. */
export const MAX_TICKET_GROUP_SIZE = 4;

export const autoGroupPref = projectPref("auto_group_coupled");

/**
 * Whether the monitor may expand an auto-started issue into a ticket group along its
 * `coupled_with` edges. Default ON — a `coupled_with` edge is an explicit declaration
 * that the tickets belong together, and starting them separately is exactly the
 * throughput failure the feature exists to fix. `auto_group_coupled_<projectId>` set to
 * "false"/"off" disables it per project.
 */
export function isAutoGroupEnabled(prefMap: Map<string, string>, projectId: string): boolean {
  const value = (prefMap.get(autoGroupPref.key(projectId)) ?? "").trim().toLowerCase();
  return value !== "false" && value !== "off";
}
