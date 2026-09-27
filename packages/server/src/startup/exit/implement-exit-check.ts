/**
 * The implement-exit check at the phase transition (the board side of what the builder's
 * `scoped-typecheck.js` / `scoped-vitest.js` Stop hooks used to do).
 *
 * `handleBuilderSessionExit` calls this once a builder session has ended with committed work,
 * BEFORE the issue moves to In Review and before any review is launched. It:
 *
 *  1. decides whether this exit ends an IMPLEMENTATION phase at all. A fork child (consolidated by
 *     its join) and a workspace parked on a review-stage or terminal workflow node run no check;
 *  2. resolves the level from the ticket's risk posture (`RiskPosture.implementExitCheck`);
 *  3. runs the check through `runImplementExitCheck` (admitted verify chain, ledgered);
 *  4. acts on the verdict (`decideImplementExitAction`):
 *     - green, skipped or held: proceed to review exactly as before;
 *     - red, under the cap: send the builder ONE follow-up turn naming the failures, and stop.
 *       That turn's session exits through this same path, so the check re-runs then;
 *     - red at the cap (or the turn could not be delivered): mark the workspace for attention —
 *       `blocked`, an issue comment with the reason, a butler event — and stop.
 *
 * A ticket group (#661) is one workspace and one builder session that implements every member
 * in turn, so this runs once, after the last member, never per member.
 *
 * While the check runs the workspace is `idle` and In Progress, which the monitor would otherwise
 * read as a stalled builder and relaunch; `implement-exit-check-state.ts` holds it off.
 */
import type { ImplementExitCheckLevel, RiskPosture } from "@agentic-kanban/shared/types";
import { isTerminalNodeType } from "@agentic-kanban/shared/lib/workflow-engine";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import type { Database } from "../../db/index.js";
import type { createBoardEvents } from "../../services/board-events.js";
import { emitButlerSystemEvent } from "../../services/butler-event-feed.js";
import { resolveIssueRiskPosture, resolveRiskPosture } from "../../services/risk-posture.service.js";
import {
  runImplementExitCheck,
  type ImplementExitCheckResult,
  type RunImplementExitCheckArgs,
} from "../../services/implement-exit-check.service.js";
import {
  clearImplementExitCheckInFlight,
  implementExitFeedbackTurns,
  markImplementExitAttention,
  markImplementExitCheckInFlight,
  noteImplementExitFeedbackTurn,
  resetImplementExitCheckState,
} from "../../services/implement-exit-check-state.js";
import { getWorkspaceCurrentWorkflowNode } from "../../repositories/workflow.repository.js";
import { listMemberIssueIds } from "../../repositories/workspace-issue-members.repository.js";
import { insertIssueComment } from "../../repositories/issue-comments.repository.js";
import { setWorkspaceStatus } from "../../repositories/workspace-status.repository.js";
import type { ExitContext } from "./exit-context.js";
import { REVIEW_STAGE_STATUS_NAME, type WorkflowOwnershipNode } from "./workflow-ownership.js";

/** How many feedback turns a red check may send before the board stops and asks for attention. */
export const IMPLEMENT_EXIT_MAX_FEEDBACK_TURNS = 2;

export type ImplementExitAction = "launch-review" | "feedback" | "needs-attention";

/**
 * DECISION (pure): what the board does with a check verdict. `feedbackTurnsSent` counts the turns
 * already sent since the last green. A check that did not run (skipped, held) counts as green:
 * it is an early signal, the merge gate still runs.
 */
export function decideImplementExitAction(
  result: Pick<ImplementExitCheckResult, "passed">,
  feedbackTurnsSent: number,
  cap: number = IMPLEMENT_EXIT_MAX_FEEDBACK_TURNS,
): ImplementExitAction {
  if (result.passed) return "launch-review";
  return feedbackTurnsSent < cap ? "feedback" : "needs-attention";
}

/**
 * Does this builder exit end an implementation phase? Not on a review-stage or terminal node
 * (the graph already put it past implementation); yes with no workflow node, on the start node,
 * and on any other in-flight stage a builder works on.
 */
export function isImplementPhaseExit(node: WorkflowOwnershipNode | null | undefined): boolean {
  if (!node) return true;
  if (isTerminalNodeType(node.nodeType)) return false;
  return node.statusName !== REVIEW_STAGE_STATUS_NAME;
}

/** The follow-up turn a red check sends the builder. */
export function buildImplementExitFeedbackPrompt(input: {
  result: ImplementExitCheckResult;
  postureLevel: string;
  attempt: number;
  cap: number;
}): string {
  const { result } = input;
  return [
    `The board ran its implement-exit check on your branch before sending it to review, and it failed (posture \`${input.postureLevel}\`, check \`${result.level}\`).`,
    "",
    result.message,
    "",
    result.failureDetail ?? "(the run named no failing suite; read the output above)",
    "",
    "Fix these failures, commit, and end your turn. The board re-runs the same check when this session ends and sends the branch to review when it is green.",
    `This is feedback turn ${input.attempt} of ${input.cap}; after that the workspace is marked for attention instead.`,
    "A red suite your change cannot affect is not yours to fix: say so in your summary rather than widening the run.",
  ].join("\n");
}

export interface ImplementExitGateDeps {
  database: Database;
  boardEvents: Pick<ReturnType<typeof createBoardEvents>, "broadcast">;
  /** Deliver a follow-up turn to the workspace's builder (`workspaceSessionService.sendTurn`). */
  sendBuilderTurn?: (workspaceId: string, content: string) => Promise<unknown>;
  /** Injectable seams, so a test needs no repo, no spawn and no posture tag read. */
  runCheck?: (args: RunImplementExitCheckArgs) => Promise<ImplementExitCheckResult>;
  resolvePosture?: (issueId: string, projectId: string, prefMap: Map<string, string>, database: Database) => Promise<RiskPosture>;
  readWorkflowNode?: (workspaceId: string, database: Database) => Promise<WorkflowOwnershipNode | null | undefined>;
  listGroupMembers?: (workspaceId: string, database: Database) => Promise<string[]>;
  cap?: number;
}

/** "proceed" = go on to In Review / review as before; "stop" = the board took the exit over. */
export type ImplementExitGateOutcome = "proceed" | "stop";

export function createImplementExitGate(deps: ImplementExitGateDeps) {
  const { database, boardEvents } = deps;
  const runCheck = deps.runCheck ?? runImplementExitCheck;
  const readNode = deps.readWorkflowNode ?? getWorkspaceCurrentWorkflowNode;
  const listMembers = deps.listGroupMembers ?? listMemberIssueIds;
  const cap = deps.cap ?? IMPLEMENT_EXIT_MAX_FEEDBACK_TURNS;

  async function resolveLevel(ctx: ExitContext): Promise<{ posture: RiskPosture; level: ImplementExitCheckLevel }> {
    const posture = await (deps.resolvePosture ?? resolveIssueRiskPosture)(ctx.issueId, ctx.projectId, ctx.prefMap, database)
      .catch(() => resolveRiskPosture(ctx.prefMap, ctx.projectId));
    return { posture, level: posture.implementExitCheck };
  }

  async function markForAttention(ctx: ExitContext, why: string, reason: string): Promise<void> {
    const workspaceId = ctx.workspace.id;
    markImplementExitAttention(workspaceId, { reason, markedAt: ctx.now });
    await setWorkspaceStatus(database, workspaceId, "blocked", { now: ctx.now }).catch(() => false);
    const body = `Needs attention: ${why}, so the board did not launch review. ${reason}`;
    await insertIssueComment(
      { issueId: ctx.issueId, workspaceId, kind: "note", author: "system", body, createdAt: ctx.now },
      database,
    ).catch((err) => console.warn(`[implement-exit] could not comment on issue ${ctx.issueId}: ${errorMessage(err)}`));
    emitButlerSystemEvent({ projectId: ctx.projectId, kind: "workspace_error", workspaceId, text: body.slice(0, 600) });
    boardEvents.broadcast(ctx.projectId, "workflow_error");
    console.warn(`[implement-exit] workspace ${workspaceId} marked for attention: ${reason.split("\n")[0]}`);
  }

  return async function gateImplementExit(ctx: ExitContext): Promise<ImplementExitGateOutcome> {
    const { workspace, projectId } = ctx;
    // A fork child is consolidated by its join, and a direct workspace has no branch of its own.
    if (workspace.parentWorkspaceId || workspace.forkStatus || workspace.isDirect) return "proceed";
    const node = await readNode(workspace.id, database).catch(() => null);
    if (!isImplementPhaseExit(node)) return "proceed";

    const { posture, level } = await resolveLevel(ctx);
    const members = await listMembers(workspace.id, database).catch(() => [] as string[]);
    const groupNote = members.length > 0 ? `, ticket group of ${members.length + 1}` : "";
    let result: ImplementExitCheckResult;
    markImplementExitCheckInFlight(workspace.id);
    try {
      result = await runCheck({
        workspace: { id: workspace.id, workingDir: workspace.workingDir, baseBranch: workspace.baseBranch },
        projectId,
        level,
        database,
      });
    } finally {
      clearImplementExitCheckInFlight(workspace.id);
    }
    const verdict = !result.ran ? (result.held ? "held" : "skipped") : result.passed ? "green" : "red";
    const selection = result.selectionSize === null ? "n/a" : String(result.selectionSize);
    console.log(
      `[implement-exit] workspace ${workspace.id}${groupNote}: posture ${posture.level}, level ${level}, ` +
        `selection ${selection}, verdict ${verdict} (${Math.round(result.durationMs / 1000)}s) — ${result.message}`,
    );

    const action = decideImplementExitAction(result, implementExitFeedbackTurns(workspace.id), cap);
    if (action === "launch-review") {
      resetImplementExitCheckState(workspace.id);
      return "proceed";
    }
    if (action === "needs-attention") {
      await markForAttention(ctx, `the implement-exit check is still red after ${cap} feedback turn(s)`, `${result.message}\n\n${result.failureDetail ?? ""}`.trim());
      return "stop";
    }
    const attempt = noteImplementExitFeedbackTurn(workspace.id);
    const prompt = buildImplementExitFeedbackPrompt({ result, postureLevel: posture.level, attempt, cap });
    try {
      if (!deps.sendBuilderTurn) throw new Error("no builder-turn channel is wired");
      await deps.sendBuilderTurn(workspace.id, prompt);
      console.log(`[implement-exit] workspace ${workspace.id}: sent feedback turn ${attempt}/${cap}; review waits for a green check`);
      boardEvents.broadcast(projectId, "issue_updated");
    } catch (err) {
      await markForAttention(ctx, "the implement-exit check is red and its feedback turn could not be delivered", `${result.message} (${errorMessage(err)})`);
    }
    return "stop";
  };
}
