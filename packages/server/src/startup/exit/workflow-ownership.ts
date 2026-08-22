/**
 * WHO owns a workflow-managed workspace when its agent session exits — the graph, or the
 * legacy `triggerType:"review"` pipeline? (#757, reconciling #997 with #678.)
 *
 * #997 established the right principle: a workspace parked on a workflow-template node is
 * owned by the GRAPH, so the legacy auto-review pipeline must not arm `readyForMerge` on a
 * branch the workflow never meant to merge yet. It implemented that as "any non-terminal node
 * => do nothing", and that is too broad: **the graph has no stage that launches a review.**
 * `onWorkspaceEnteredNode` (workflow-fork.service) only acts on `parallel-fork`/`parallel-join`
 * nodes and on spec-driven phase nodes that carry a skill; a plain node mapped to the
 * "In Review" status launches nothing at all. So for that node "the graph owns it" means
 * nobody owns it, and the workspace is left parked at `idle` — no review, no transition, no
 * error (the #757 regression, which broke #678's exit-0 → In Review guarantee).
 *
 * The line drawn here: a node whose `statusName` IS the review stage is the graph explicitly
 * SAYING "this workspace is now in review". The graph has already made its decision and has no
 * machinery to act on it, so the legacy pipeline is the correct executor of that decision —
 * and `readyForMerge` armed there is armed on a branch the workflow DID mean to review. Every
 * other non-terminal node (a Prepare/plan stage, a fork arm, any stage the graph has not yet
 * advanced out of) keeps #997's behaviour: hands off.
 */
import { isTerminalNodeType } from "@agentic-kanban/shared/lib/workflow-engine";

/** The project-status name a workflow node maps to when that node IS the review stage. */
export const REVIEW_STAGE_STATUS_NAME = "In Review";

export interface WorkflowOwnershipNode {
  nodeType: string | null;
  statusName: string | null;
}

/**
 * True when the workflow graph — not the legacy auto-review pipeline — owns what happens next
 * for a workspace parked on `node`. Pass `null`/`undefined` for a workspace that is not
 * workflow-managed (no `currentNodeId`, or a dangling one): never graph-owned.
 */
export function graphOwnsPostExitReview(node: WorkflowOwnershipNode | null | undefined): boolean {
  if (!node) return false;
  // A terminal ("end") node is where #997 itself hands back: the workflow is finished, so the
  // legacy pipeline reviews/lands the result.
  if (isTerminalNodeType(node.nodeType)) return false;
  // The graph advanced this workspace ONTO its review stage. That is a decision, not ownership
  // of the execution — nothing in the graph launches a review session for such a node.
  if (node.statusName === REVIEW_STAGE_STATUS_NAME) return false;
  return true;
}
