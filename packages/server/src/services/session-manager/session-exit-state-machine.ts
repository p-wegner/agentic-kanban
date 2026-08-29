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
  /**
   * The error text of the session's last FAILED terminal result event, when it had one (#934).
   *
   * A provider can fail having produced NO assistant text and NOTHING on stderr: Claude's
   * stale-`--resume` failure is a single `{"type":"result","subtype":"error_during_execution",
   * "is_error":true,"errors":["No conversation found with session ID: …"]}` line on stdout.
   * That event sets `turnComplete`/`stats`, so `hadSubstantiveOutput` reads TRUE and the exit
   * routed to `completed` with an empty error text — the workspace went back to idle with the
   * turn content silently dropped, and the #26 missing-transcript recovery (which keys off the
   * error text on the launch-failure route) never saw the reason.
   */
  resultErrorText?: string;
  /**
   * The agent emitted work — assistant text, a tool call/result, live stats (#934). Narrower
   * than `hadSubstantiveOutput`, which also counts the terminal result event. Defaults to
   * `hadSubstantiveOutput` when the caller does not distinguish the two, so an omitted value
   * can never turn a run that DID work into a launch failure.
   */
  hadAgentWork?: boolean;
  /**
   * Whether the exit code is a genuinely OBSERVED value (default: true). The live process
   * `exit` handler always observes the real code (possibly null-on-signal), so it leaves this
   * unset. The external/reattach PID-poll path can NOT observe the exit code — a surviving
   * detached agent whose PID simply vanishes after a `tsx watch` restart. When this is `false`,
   * a `null` exitCode is INDETERMINATE (not a clean success), and — absent a usage-limit or
   * fast-crash signal — the exit routes to `unknown-exit` instead of being silently recorded
   * as a completed "0" (issue: external exit bypassed the state machine — review §3.2).
   */
  exitCodeKnown?: boolean;
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
  | {
      /**
       * The exit code was never observed (external/reattach PID poll) and no usage-limit or
       * fast-crash signal was seen — the exit is INDETERMINATE. Must be recorded as a distinct
       * terminal state, NOT a clean completed "0", so a post-restart crash/quota-exhaustion is
       * never misfiled as success (review §3.2).
       */
      phase: "unknown-exit";
      /** Whether any substantive output was seen before the process vanished (for diagnostics). */
      hadSubstantiveOutput: boolean;
      /** Provider stderr captured before the process vanished, if any. */
      capturedStderr: string;
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
  // #859/#895 — a NON-ZERO exit with ZERO substantive output is a launch failure at ANY
  // duration: nothing ran, and the exit code says so explicitly. The 10s window assumed the
  // agent starts when the session does, which stopped being true when placement moved
  // off-host — a remote dispatch spends ~a minute on clone+checkout BEFORE the agent's
  // instant "Not logged in" exit, so the discarded diagnosis routed to `completed` and the
  // workspace reset to a bare idle. The window still bounds the two HEURISTIC cases, which
  // genuinely need a time bound: zero-output-with-clean-exit (a long legitimate run can be
  // quiet) and fast-non-zero-with-output (a long run that fails late is a failed run, not a
  // launch failure — it keeps the completed path, which persists its real exit code).
  // #934 — a non-zero exit whose ONLY output was a FAILED result event carrying an error
  // message is a failed launch at any duration, for the same reason as the clause above: the
  // provider said explicitly that nothing ran. It is NOT covered by that clause, because such
  // a result event sets stats/turnComplete and so counts as substantive output. Without this,
  // a stale `--resume` outside the 10s window (the observed case: a follow-up turn against a
  // ~10h-old workspace) routed to `completed` and the missing-transcript recovery never ran.
  //
  // Gated on `hadAgentWork` and NOT on `hadSubstantiveOutput`: a long run that did real work
  // and then failed is a failed RUN, keeps the completed route, and keeps its real exit code.
  const resultErrorText = ctx.resultErrorText?.trim() ?? "";
  const hadAgentWork = ctx.hadAgentWork ?? ctx.hadSubstantiveOutput;
  const failedWithoutWorking = isNonZeroExit && !hadAgentWork && Boolean(resultErrorText);
  if ((isNonZeroExit && isZeroOutput) || failedWithoutWorking || (withinWindow && (isZeroOutput || isNonZeroExit))) {
    const errorText = ctx.planText?.trim() || resultErrorText || ctx.capturedStderr || "";
    const effectiveExitCode = isNonZeroExit ? (ctx.exitCode as number) : 1;
    return { phase: "launch-failure", isZeroOutput, isNonZeroExit, effectiveExitCode, errorText };
  }

  // Exit code genuinely undeterminable (external/reattach PID poll — the process survived a
  // server restart and its PID simply vanished, so no `exit` event with a code was ever seen).
  // With no usage-limit and no fast-crash signal, we CANNOT claim a clean "0" success — that
  // was the bug (a post-restart crash/quota-exhaustion logged as completed/"0", review §3.2).
  // Surface it as an explicit indeterminate terminal instead. The live process exit path never
  // sets `exitCodeKnown`, so it defaults to `true` and this branch is unreachable there.
  if (ctx.exitCodeKnown === false) {
    return { phase: "unknown-exit", hadSubstantiveOutput: ctx.hadSubstantiveOutput, capturedStderr: ctx.capturedStderr };
  }

  return { phase: "completed", exitCode: ctx.exitCode };
}

/**
 * The four per-session output signals `classifySessionExit` reads, lifted out of the
 * in-memory state in ONE place (#934).
 *
 * Both exit paths — the live process `exit` handler and the external/reattach PID poll —
 * derive these from the same `SessionState` maps, and the derivation had already drifted
 * once (the live path folds in plan text, the external path does not). Keeping it here,
 * beside the context type it feeds, means a new signal is added to the classifier and to
 * both readers in one edit instead of three.
 *
 * `finalText` is the caller's already-resolved final/plan text — the live path substitutes
 * a plan-marker scan for it in plan mode, which is the one thing the two paths genuinely
 * differ on, so it stays an argument rather than another state read here.
 */
export interface SessionExitSignals {
  hadSubstantiveOutput: boolean;
  hadAgentWork: boolean;
  resultErrorText: string;
}

export function readSessionExitSignals(
  state: {
    sessionSubstantiveOutput: Set<string>;
    sessionAgentWork: Set<string>;
    sessionResultError: Map<string, string>;
  },
  sessionId: string,
  finalText: string | null,
): SessionExitSignals {
  const hasText = Boolean(finalText?.trim().length);
  return {
    hadSubstantiveOutput: state.sessionSubstantiveOutput.has(sessionId) || hasText,
    hadAgentWork: state.sessionAgentWork.has(sessionId) || hasText,
    resultErrorText: state.sessionResultError.get(sessionId) ?? "",
  };
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
