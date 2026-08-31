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
 *
 * #960 adds a second exception, and it belongs to a DIFFERENT caller — see
 * `graphOwnsReviewSessionExit` below. "Does the graph own what happens next?" has two answers on
 * a `start` node depending on WHO exited: a builder there is genuinely mid-flow (it proposes the
 * transition itself), a reviewer there is proof the transition never happened.
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

/** The structural node type of a template's entry node — where the BUILDER works. */
export const START_NODE_TYPE = "start";

/**
 * The same question, asked when a REVIEW session exits (#960).
 *
 * `graphOwnsPostExitReview` is correct for a BUILDER exit: a builder finishing on the graph's
 * start node is exactly mid-flow, and the graph advances it (the agent calls
 * `propose_transition`). It is wrong for a review exit, and that asymmetry is what stranded
 * #954 and #959.
 *
 * `workspaces.currentNodeId` tracks the ISSUE's status. When the issue never transitioned to
 * "In Review", the node is still the START node — non-terminal, `statusName` "In Progress" —
 * so the shared predicate says "the graph owns it" and `readyForMerge` is withheld on the
 * theory that the graph will drive the next stage. Nothing does: a start node is where the
 * BUILDER works, so a REVIEW session exiting there means the issue transition was missed, not
 * that the graph is mid-flow. Both observed cases (#954 `Implement`, #959 `Reproduce & Fix`)
 * were clean review exits on a start node that needed a hand `POST /ready-for-merge` to move.
 *
 * So: on a start node the legacy pipeline owns the review exit, exactly as it does for the
 * #757 In-Review node. Every other non-terminal node keeps #997's hands-off behaviour.
 */
export function graphOwnsReviewSessionExit(node: WorkflowOwnershipNode | null | undefined): boolean {
  if (node?.nodeType === START_NODE_TYPE) return false;
  return graphOwnsPostExitReview(node);
}

/**
 * Did the REVIEWER put this issue in "In Progress", or was it already there?
 *
 * The exit engine reads "In Progress after a review" as the reviewer's changes-requested
 * signal — in non-auto-fix mode that IS the whole signal, because the review prompt tells a
 * reviewer that finds CRITICAL/MAJOR issues to `move_issue(..., 'In Progress')` and edit
 * nothing. On the #960 start-node shape the issue was ALREADY In Progress, so status alone
 * cannot tell the two apart, and treating every start-node exit as "never transitioned"
 * would arm — and auto-merge — a branch whose reviewer had just requested changes.
 *
 * `transitionIssueStatus` (and the PATCH path's `buildSharedIssueUpdate`) stamp
 * `statusChangedAt` on EVERY status write, including a re-move to the status the issue is
 * already in. So a stamp at or after the review session started is the reviewer's move;
 * anything older is the original status the builder left behind.
 *
 * Fails CLOSED: a missing/unparseable `statusChangedAt` or `sessionStartedAt` counts as
 * "the reviewer may have moved it", which keeps the pre-#960 withhold rather than arming a
 * branch on no evidence.
 */
export function reviewerMovedIssueToInProgress(
  statusChangedAt: string | null | undefined,
  sessionStartedAt: string | null | undefined,
): boolean {
  const changed = statusChangedAt ? Date.parse(statusChangedAt) : NaN;
  const started = sessionStartedAt ? Date.parse(sessionStartedAt) : NaN;
  if (Number.isNaN(changed) || Number.isNaN(started)) return true;
  return changed >= started;
}

/**
 * Why a review exit's `readyForMerge` arm was withheld, phrased for the server log — the
 * silent case is what made #960 invisible without a DB query (#960's "Done when").
 */
export function describeWithheldReviewArm(node: WorkflowOwnershipNode & { name?: string | null }): string {
  return `node "${node.name ?? "?"}" (type=${node.nodeType ?? "?"}, status=${node.statusName ?? "none"})`;
}
