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
 * Fails OPEN on anything that is not a verdict: no script (another project), no installed
 * dependencies (a worker built the tree), a hang, a spawn error. Only a completed non-zero exit is red.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { runSetupScript, type SetupScriptResult } from "@agentic-kanban/shared/lib/setup-script";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import { getChangedFileNames } from "./git.service.js";
import type { PreMergeGateResult } from "./pre-merge-gate.types.js";

export const STATIC_TIER_COMMAND = "node scripts/check-static.mjs";
const STATIC_TIER_TIMEOUT_MS = 5 * 60 * 1000;
/** Enough of the guard's own output to carry the rule and the fix (check:arch prints both). */
const DETAIL_TAIL_CHARS = 4000;

export interface StaticTierVerdict {
  /** False when nothing ran (no script, no deps, errored). */
  ran: boolean;
  /** True when green, or when nothing ran (fail open). */
  passed: boolean;
  /** One line for the log. */
  message: string;
  /** On red: the guard's own output, tail-trimmed. */
  detail: string | null;
}

export type StaticTierRunner = (workingDir: string, env: Record<string, string>, signal?: AbortSignal) => Promise<SetupScriptResult>;

const runOnHost: StaticTierRunner = (workingDir, env, signal) =>
  runSetupScript(workingDir, STATIC_TIER_COMMAND, { timeoutMs: STATIC_TIER_TIMEOUT_MS, env, signal });

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
}): Promise<StaticTierVerdict> {
  const { workingDir, baseBranch, signal } = args;
  const skip = staticTierSkipReason({
    hasScript: existsSync(join(workingDir, "scripts", "check-static.mjs")),
    hasDeps: existsSync(join(workingDir, "node_modules")),
  });
  if (skip) return notRun(`static tier skipped: ${skip}`);
  try {
    const changed = args.changedFiles ?? (baseBranch ? await getChangedFileNames(workingDir, baseBranch).catch(() => [] as string[]) : []);
    const result = await (args.run ?? runOnHost)(workingDir, { KANBAN_ARCH_CHANGED_FILES: changed.join(",") }, signal);
    if (result.timedOut) return notRun("static tier timed out (inconclusive, not red)");
    if (result.exitCode === 0) return { ran: true, passed: true, message: "static tier passed (check:static)", detail: null };
    // exit 3 is check:arch's "could not verify" (no typescript here), a missing runtime — not a finding.
    if (result.exitCode === 3 || result.exitCode < 0) return notRun(`static tier could not verify (exit ${result.exitCode})`);
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
    return { ran: true, passed: false, message: `static tier FAILED (check:static, exit ${result.exitCode})`, detail: output.slice(-DETAIL_TAIL_CHARS) };
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
  return {
    passed: false,
    skipped: false,
    stage: "verify",
    message: `${verdict.message} - the suite run was skipped. Fix the static guard first:\n${verdict.detail ?? ""}`,
  };
}
