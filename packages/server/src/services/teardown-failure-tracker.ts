// In-memory streak of consecutive teardownScript failures (#1657). A teardown failure is
// deliberately non-fatal, so a script that fails on EVERY run (e.g. POSIX `rm -rf` under
// cmd.exe) was visible only as a log line while worktree dependency trees piled up on disk.
// Keyed by script text: teardown has no project id, and project health knows the script.

/** Consecutive failures before project health raises a warning. */
export const TEARDOWN_FAILURE_WARN_THRESHOLD = 3;

interface Streak {
  count: number;
  lastOutput: string;
}

const streaks = new Map<string, Streak>();

export function recordTeardownResult(script: string, ok: boolean, output = ""): void {
  if (ok) {
    streaks.delete(script);
    return;
  }
  const prev = streaks.get(script);
  streaks.set(script, { count: (prev?.count ?? 0) + 1, lastOutput: output.slice(0, 200) });
}

/** A health warning when `script` has failed `threshold`+ times in a row, else null. */
export function teardownFailureWarning(
  script: string | null | undefined,
  threshold = TEARDOWN_FAILURE_WARN_THRESHOLD,
): string | null {
  if (!script) return null;
  const s = streaks.get(script);
  if (!s || s.count < threshold) return null;
  return `Teardown script failed ${s.count} times in a row — merged worktrees keep their node_modules/dist on disk. Last error: ${s.lastOutput.replace(/\s+/g, " ").trim()}`;
}

export function resetTeardownFailuresForTest(): void {
  streaks.clear();
}
