/**
 * The STATIC guard tier (#1514): `pnpm check:static` (`check:arch` + the `@gate:static` ratchet
 * suites) run on the HOST, outside verify placement.
 *
 * These guards are file scans — no install, no DB, no verify slot, seconds of work — but they rode
 * in the verify chain with the test suites, so they reached the builder last (at the train) and a
 * `held` placement meant they never ran at all (train 22: `merge-queue-train.ts` 1011 lines, the
 * builder's implement-exit check was `held`). Two callers use this module:
 *  - the implement-exit check, BEFORE it plans placement, so a red reaches the builder's one
 *    feedback turn even when the test part is held;
 *  - the train staging gate, BEFORE the suite run, so a combination red (two branches each fine,
 *    together over a ceiling) costs seconds and the fix agent gets the guard's own message.
 *
 * Fails OPEN on anything that is not a verdict: no script (another project), a hang, a spawn
 * error. A tree with no installed dependencies (a worker built it, #1603) still runs the
 * dependency-free god-module ceiling, and says it ran only that. Only a completed non-zero exit is red.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { runSetupScript, type SetupScriptResult } from "@agentic-kanban/shared/lib/setup-script";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import { getChangedFileNames } from "./git.service.js";
import type { PreMergeGateResult } from "./pre-merge-gate.types.js";
import { withFailedSuites } from "./verify-failed-suites.js";

export const STATIC_TIER_COMMAND = "node scripts/check-static.mjs";
/** #1603: the dependency-free slice (line ceiling + cohesion), run when the tree has no node_modules. */
export const STATIC_TIER_LITE_COMMAND = "node scripts/check-god-modules.mjs";
const STATIC_TIER_TIMEOUT_MS = 5 * 60 * 1000;
/** Enough of the guard's own output to carry the rule and the fix (check:arch prints both). */
const DETAIL_TAIL_CHARS = 4000;

export interface StaticTierVerdict {
  /** False when nothing ran (no script, no deps, errored). */
  ran: boolean;
  /** True when green, or when nothing ran (fail open). */
  passed: boolean;
  /** #1603: true when only the dependency-free slice (god-modules) ran because the tree has no deps. */
  degraded?: boolean;
  /** One line for the log. */
  message: string;
  /** On red: the guard's own output, tail-trimmed. */
  detail: string | null;
}

export type StaticTierRunner = (workingDir: string, env: Record<string, string>, signal?: AbortSignal, command?: string) => Promise<SetupScriptResult>;

const runOnHost: StaticTierRunner = (workingDir, env, signal, command = STATIC_TIER_COMMAND) =>
  runSetupScript(workingDir, command, { timeoutMs: STATIC_TIER_TIMEOUT_MS, env, signal });

function notRun(message: string): StaticTierVerdict {
  return { ran: false, passed: true, message, detail: null };
}

/** DECISION (pure): why the static tier cannot run in this tree, or null when it can. */
export function staticTierSkipReason(input: { hasScript: boolean; hasDeps: boolean }): string | null {
  if (!input.hasScript) return "the project has no scripts/check-static.mjs";
  if (!input.hasDeps) return "the worktree has no installed dependencies (a worker built it)";
  return null;
}

/** Run the static tier in `workingDir`. Total: never throws. */
export async function runStaticTier(args: {
  workingDir: string;
  baseBranch: string | null;
  signal?: AbortSignal;
  run?: StaticTierRunner;
  /** The diff, when the caller already has it; read from git otherwise. */
  changedFiles?: string[];
  /** #1575: also run the `when:`-matched guard suites for the diff (the member's own ratchets). */
  memberGuards?: boolean;
}): Promise<StaticTierVerdict> {
  const { workingDir, baseBranch, signal } = args;
  const hasScript = existsSync(join(workingDir, "scripts", "check-static.mjs"));
  const hasDeps = existsSync(join(workingDir, "node_modules"));
  const skip = staticTierSkipReason({ hasScript, hasDeps });
  // #1603: a remote builder's host tree has no install, but the line ceiling needs none - run that slice.
  const degraded = !skip ? false : hasScript && !hasDeps && existsSync(join(workingDir, "scripts", "check-god-modules.mjs"));
  if (skip && !degraded) return notRun(`static tier skipped: ${skip}`);
  const label = degraded ? "static tier (degraded: god-module ceiling only, no installed dependencies)" : "static tier";
  try {
    const changed = args.changedFiles ?? (baseBranch ? await getChangedFileNames(workingDir, baseBranch).catch(() => [] as string[]) : []);
    const result = await (args.run ?? runOnHost)(workingDir, {
      KANBAN_ARCH_CHANGED_FILES: changed.join(","),
      ...(args.memberGuards && !degraded ? { KANBAN_STATIC_MEMBER_GUARDS: "1" } : {}),
    }, signal, degraded ? STATIC_TIER_LITE_COMMAND : STATIC_TIER_COMMAND);
    if (result.timedOut) return notRun(`${label} timed out (inconclusive, not red)`);
    if (result.exitCode === 0) return { ran: true, passed: true, ...(degraded ? { degraded } : {}), message: `${label} passed (${degraded ? "check-god-modules" : "check:static"})`, detail: null };
    // exit 3 is check:arch's "could not verify" (no typescript here), a missing runtime — not a finding.
    if (result.exitCode === 3 || result.exitCode < 0) return notRun(`${label} could not verify (exit ${result.exitCode})`);
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
    return { ran: true, passed: false, ...(degraded ? { degraded } : {}), message: `${label} FAILED (${degraded ? "check-god-modules" : "check:static"}, exit ${result.exitCode})`, detail: output.slice(-DETAIL_TAIL_CHARS) };
  } catch (err) {
    return notRun(`static tier errored (not red): ${errorMessage(err)}`);
  }
}

/**
 * The train staging gate's static pre-step: a red verdict shaped as the gate result the suite run
 * would have produced (so the fix agent gets the guard's message), or null to carry on to the suites.
 * A flush's own gate script already is `check:arch` + typecheck, so it passes through.
 */
export async function runStaticTierGate(
  workingDir: string,
  baseBranch: string,
  signal: AbortSignal | undefined,
  verifyScriptOverride: string | undefined,
): Promise<PreMergeGateResult | null> {
  if (verifyScriptOverride) return null;
  const verdict = await runStaticTier({ workingDir, baseBranch, signal });
  if (verdict.passed) return null;
  // Name the offenders (a red check:arch names files) so the train log names them, the red goes
  // back to the builder as a deterministic guard failure, and the two never disagree.
  return withFailedSuites({
    passed: false,
    skipped: false,
    stage: "verify" as const,
    message: `${verdict.message} - the suite run was skipped. Fix the static guard first:\n${verdict.detail ?? ""}`,
  }, {});
}
