/**
 * A red PRE-MERGE gate goes back to the builder (#1293).
 *
 * Measured 2026-10-04 on #1292: the implement-exit check was green, review ran, and the pre-merge
 * gate then failed on a `@gate:always-run` guard. The board logged `merge backoff active` and did
 * nothing else until a human sent the builder a turn; the builder fixed it in one commit. The
 * implement-exit check already hands ITS red back to the builder
 * (`startup/exit/implement-exit-check.ts`); this is the same loop for the gate.
 *
 * Rules, all of them decided by {@link decideGateRedFeedback} (pure):
 *  - only a gate red that NAMED failing suites is the builder's to fix. `verify_timeout`,
 *    `verify_infra_missing` and a process-kill exit with no suite name carry no `failedSuites`,
 *    so they get no turn;
 *  - ONE turn per branch head: re-gating the same head with backoff never re-sends. The builder's
 *    new commit is a new head, goes through implement-exit, review and the gate again, and a red
 *    there earns the next turn;
 *  - at most {@link GATE_RED_MAX_FEEDBACK_TURNS} turns per workspace; after that the caller keeps
 *    today's escalation (clear readyForMerge, comment, drive obstacle);
 *  - a green gate (a landing) resets the count.
 *
 * In memory on purpose, like `implement-exit-check-state.ts`: a restart forgets the count, so a
 * workspace gets at most one more round of turns per board process.
 *
 * This NEVER merges and never routes to fix-and-merge (#638): it only talks to the builder.
 */
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import { describeFailedSuites } from "./verify-failed-suites.js";
import { verifyLogPath } from "./verify-failure-summary.js";

/** How many feedback turns a red gate may send before the board escalates to a human. */
export const GATE_RED_MAX_FEEDBACK_TURNS = 2;

export type GateRedFeedbackDecision =
  /** Send the builder a turn now. */
  | "send"
  /** A turn for this very head is out; the builder is working, so neither send nor escalate. */
  | "await-builder"
  /** The cap is spent and the head moved without going green: escalate. */
  | "cap-reached"
  /** Nothing named a failing suite (infra class): not the builder's to fix. */
  | "not-actionable";

/** DECISION (pure): what a red gate does about the builder. */
export function decideGateRedFeedback(input: {
  failedSuites: readonly string[];
  headSha: string | null;
  turnsSent: number;
  lastTurnHeadSha: string | null;
  cap?: number;
}): GateRedFeedbackDecision {
  if (input.failedSuites.length === 0) return "not-actionable";
  if (input.headSha !== null && input.headSha === input.lastTurnHeadSha) return "await-builder";
  return input.turnsSent < (input.cap ?? GATE_RED_MAX_FEEDBACK_TURNS) ? "send" : "cap-reached";
}

interface GateRedFeedbackState {
  turns: number;
  lastTurnHeadSha: string | null;
}

const states = new Map<string, GateRedFeedbackState>();

export function gateRedFeedbackState(workspaceId: string): GateRedFeedbackState {
  return states.get(workspaceId) ?? { turns: 0, lastTurnHeadSha: null };
}

/** A green gate (a landing): forget the count. */
export function resetGateRedFeedback(workspaceId: string): void {
  states.delete(workspaceId);
}

/** Test seam: drop all state. */
export function resetAllGateRedFeedbackForTests(): void {
  states.clear();
}

/** The follow-up turn a red gate sends the builder (same shape as the implement-exit prompt). */
export function buildGateRedFeedbackPrompt(input: {
  workspaceId: string;
  failedSuites: readonly string[];
  guardFailure: boolean;
  attempt: number;
  cap: number;
  logPath?: string;
}): string {
  const named = describeFailedSuites({ files: input.failedSuites, guardFailure: input.guardFailure });
  return [
    "The board's pre-merge gate ran on your branch after review and it failed, so the branch was NOT merged.",
    "",
    named,
    `Full verify log: ${input.logPath ?? verifyLogPath(input.workspaceId)}`,
    "",
    "Fix these failures, commit, and end your turn. The board runs its implement-exit check, review and the gate again on your new commit.",
    `This is feedback turn ${input.attempt} of ${input.cap}; after that the workspace is marked for attention instead.`,
    "A red suite your change cannot affect is not yours to fix: say so in your summary rather than widening the run.",
  ].join("\n");
}

export interface GateRedFeedbackResult {
  decision: GateRedFeedbackDecision | "send-failed";
  /** The turn number sent, when `decision` is `send`. */
  attempt?: number;
}

/**
 * Apply {@link decideGateRedFeedback} and, on `send`, deliver the turn. A turn that could not be
 * delivered (builder busy, no channel) is not counted, so the next tick tries again. Never throws.
 */
export async function sendGateRedFeedback(
  input: { workspaceId: string; headSha: string | null; failedSuites: readonly string[]; guardFailure: boolean },
  deps: { sendBuilderTurn?: (workspaceId: string, content: string) => Promise<unknown>; cap?: number },
): Promise<GateRedFeedbackResult> {
  const cap = deps.cap ?? GATE_RED_MAX_FEEDBACK_TURNS;
  const state = gateRedFeedbackState(input.workspaceId);
  const decision = decideGateRedFeedback({
    failedSuites: input.failedSuites,
    headSha: input.headSha,
    turnsSent: state.turns,
    lastTurnHeadSha: state.lastTurnHeadSha,
    cap,
  });
  if (decision !== "send") return { decision };
  const attempt = state.turns + 1;
  try {
    if (!deps.sendBuilderTurn) throw new Error("no builder-turn channel is wired");
    await deps.sendBuilderTurn(
      input.workspaceId,
      buildGateRedFeedbackPrompt({
        workspaceId: input.workspaceId,
        failedSuites: input.failedSuites,
        guardFailure: input.guardFailure,
        attempt,
        cap,
      }),
    );
  } catch (err) {
    console.warn(`[gate-feedback] could not send the red-gate turn to workspace ${input.workspaceId}: ${errorMessage(err)}`);
    return { decision: "send-failed" };
  }
  states.set(input.workspaceId, { turns: attempt, lastTurnHeadSha: input.headSha });
  console.log(`[gate-feedback] workspace ${input.workspaceId}: sent red-gate feedback turn ${attempt}/${cap}`);
  return { decision: "send", attempt };
}
