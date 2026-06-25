/**
 * Pure exit state machine for a session's `exit` event (issue #910).
 *
 * The session-lifecycle `onOutput` closure used to inline ~225 lines that did
 * dedup, in-memory teardown, usage-limit + launch-failure classification,
 * finalization, HANDOFF.md and plan-mode continuation all at once — and it was
 * where every provider special-case accreted. That made the ordering invariant
 * (drain output to EOF BEFORE classifying "substantive output"; check
 * already-stopped BEFORE classifying a launch failure; check usage-limit BEFORE
 * the generic launch-failure window) invisible and untestable.
 *
 * This module follows the same pattern that worked for `classifySessionExit`
 * (session-exit-classification.ts): the DECISION is a pure function over an
 * explicit `SessionExitContext`, returning a `SessionExitRoute` that names the
 * phase the exit lands in and carries the data each terminal handler needs. The
 * lifecycle keeps every side effect (DB writes, HANDOFF.md, relaunch) — it only
 * asks here for the verdict. The provider-specific knowledge (which usage limit
 * was hit) is supplied by the caller via the provider's exit behavior, so this
 * core stays provider-neutral.
 */
import type { AgentOutputMessage } from "@agentic-kanban/shared";
import type { ProviderUsageLimit } from "../agent-provider/provider-exit-behavior.js";

/** The window within which a fast provider exit is treated as a failed launch (not real work). */
export const ZERO_OUTPUT_LAUNCH_FAILURE_WINDOW_MS = 10_000;

/**
 * The explicit inputs the exit decision depends on — computed once by the
 * lifecycle from the in-memory session state and the agent process event, AFTER
 * the output file has been drained to EOF (#909). Pure: no Maps/Sets, no DB.
 */
export interface SessionExitContext {
  /** The exit code from the agent process (null when undeterminable → treated as a failure for the window check). */
  exitCode: number | null;
  /** Wall-clock duration of the session in ms. */
  durationMs: number;
  /** True if the agent produced real assistant text / tool activity (NOT just an error line). */
  hadSubstantiveOutput: boolean;
  /** The session was explicitly stopped by the user — stopSession already wrote "stopped". */
  stoppedByUser: boolean;
  /** A provider usage-limit hit detected on the exit output (null when none / provider has no concept). */
  usageLimit: ProviderUsageLimit | null;
  /** The session's final plan/assistant text, if any (used as the error text for a non-zero-exit failure). */
  planText: string | null;
  /** Provider stderr captured at exit (detached agents drain their .err file on exit — #779). */
  capturedStderr: string;
}

/**
 * The terminal phase a session exit routes to, highest-priority first. Mirrors the
 * original control flow in the lifecycle exit closure EXACTLY:
 *
 *  1. stopped        — the user stopped it; DB already says "stopped", just fire the callback.
 *  2. usage-limit    — a provider quota was hit; persist rate-limit stats, block the workspace.
 *  3. launch-failure — a fast exit with zero output OR a non-zero exit inside the window.
 *  4. completed      — a real run finished; finalize, write HANDOFF.md, run continuations.
 */
export type SessionExitRoute =
  | { phase: "stopped" }
  | { phase: "usage-limit"; usageLimit: ProviderUsageLimit; effectiveExitCode: number }
  | {
      phase: "launch-failure";
      /** Zero-output (classic crash) vs a non-zero exit with error text. */
      isZeroOutput: boolean;
      /** True when the process exited non-zero (vs zero-output on a 0/clean exit code). */
      isNonZeroExit: boolean;
      /** The exit code to persist (the real non-zero code, or 1 for a zero-output crash). */
      effectiveExitCode: number;
      /** The error text to surface (plan text, then captured stderr). */
      errorText: string;
    }
  | { phase: "completed"; exitCode: number | null };

/**
 * Decide which terminal phase a session exit lands in. This is the `classify` phase
 * of the drain → classify → finalize → continue machine; `drain` (output-to-EOF) has
 * already happened in the caller, and `finalize`/`continue` are the side effects the
 * caller runs based on this route.
 *
 * Priority — earlier wins:
 *  1. stopped (the user's explicit stop must never be reclassified as a failure).
 *  2. usage-limit (a quota hit must be recognized before the generic launch-failure
 *     window swallows it as a plain crash).
 *  3. launch-failure (a fast zero-output exit, or a fast non-zero exit with an error
 *     message that is NOT real agent work).
 *  4. completed (a real run).
 */
export function classifySessionExit(ctx: SessionExitContext): SessionExitRoute {
  if (ctx.stoppedByUser) return { phase: "stopped" };

  if (ctx.usageLimit) {
    const effectiveExitCode = ctx.exitCode && ctx.exitCode !== 0 ? ctx.exitCode : 1;
    return { phase: "usage-limit", usageLimit: ctx.usageLimit, effectiveExitCode };
  }

  const withinWindow = ctx.durationMs <= ZERO_OUTPUT_LAUNCH_FAILURE_WINDOW_MS;
  const isZeroOutput = !ctx.hadSubstantiveOutput;
  const isNonZeroExit = ctx.exitCode !== 0 && ctx.exitCode !== null;
  if (withinWindow && (isZeroOutput || isNonZeroExit)) {
    const errorText = ctx.planText?.trim() || ctx.capturedStderr || "";
    const effectiveExitCode = isNonZeroExit ? (ctx.exitCode as number) : 1;
    return { phase: "launch-failure", isZeroOutput, isNonZeroExit, effectiveExitCode, errorText };
  }

  return { phase: "completed", exitCode: ctx.exitCode };
}

/**
 * Extract the provider stderr captured at exit from the session's buffered messages
 * (#779). Detached agents drain their `.err` file into stderr messages on exit; this
 * is the diagnostic for an otherwise-opaque zero-output crash and the fallback error
 * text for a non-zero-exit failure when no assistant/plan text was produced.
 */
export function extractCapturedStderr(messages: AgentOutputMessage[]): string {
  return messages
    .filter((m) => m.type === "stderr")
    .map((m) => m.data ?? "")
    .join("")
    .trim();
}
