/**
 * #1772 - the VERDICT side of a train gate: when a red is really infrastructure (a full disk, a worker
 * that never ran a test), and which files the shepherd may never edit to "fix" one. Pure.
 */

/** More failing suites than this share of the scoped suites is the environment, not the code. */
export const INFRA_RED_FAILING_RATIO = 0.5;
/** Below this many failing suites the ratio says nothing (a 2-of-3 red is a real red). */
export const INFRA_RED_MIN_FAILING = 20;

const INFRA_SIGNATURE = /SQLITE_FULL|ENOSPC|No space left on device|database or disk is full|Auf dem Datentr\S+ ist nicht gen\S+ Speicherplatz|Die Befehlszeile ist zu lang|The command line is too long|Argument list too long/i;
// A zero-suite red that still names a real check failure (typecheck, arch, an assertion) is a red.
const REAL_FAILURE_MARKER = /error TS\d+|check:arch|dependency-cruiser|AssertionError|\bFAIL\b|violation|ERR_PNPM_RECURSIVE_RUN|✗|×/i;

export interface InfraRedInput {
  passed: boolean;
  message: string;
  failedSuites?: readonly string[];
}

/** Why a failed gate is infrastructure rather than red, or null when it is a real red. */
export function classifyInfraRed(gate: InfraRedInput, scopedSuiteCount?: number): string | null {
  if (gate.passed) return null;
  const sig = INFRA_SIGNATURE.exec(gate.message);
  if (sig) return `infra signature "${sig[0]}" in the gate output`;
  const failing = gate.failedSuites?.length ?? 0;
  if (failing === 0) {
    return REAL_FAILURE_MARKER.test(gate.message) ? null : "gate failed with 0 failing suite(s) and no recognisable failure - the runner produced no verdict";
  }
  if (scopedSuiteCount && scopedSuiteCount > 0 && failing >= INFRA_RED_MIN_FAILING && failing / scopedSuiteCount > INFRA_RED_FAILING_RATIO) {
    return `${failing} of ${scopedSuiteCount} scoped suites failed (> ${Math.round(INFRA_RED_FAILING_RATIO * 100)}%) - the environment, not the code`;
  }
  return null;
}

/** A test the shepherd must not edit: a ratchet, or any suite marked `@gate:always-run`. */
export function isGuardTestPath(file: string, content?: string): boolean {
  const f = file.replace(/\\/g, "/");
  if (/(?:^|\/)__tests__\/[^/]*ratchet[^/]*\.test\.[cm]?[jt]sx?$/.test(f)) return true;
  return content !== undefined && /\.test\.[cm]?[jt]sx?$/.test(f) && /^\s*\/\/\s*@gate:always-run\b/m.test(content);
}

/** The guard files among `files`; `readFile` supplies content for the marker check (omit to match by name only). */
export function findGuardEdits(files: readonly string[], readFile?: (file: string) => string | undefined): string[] {
  return files.filter((f) => isGuardTestPath(f, readFile?.(f)));
}
