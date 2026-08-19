/**
 * The ONE result shape for every external-CLI adapter (#591).
 *
 * The repo has a named adapter kind — `lib/<system>-exec.ts` exporting `<system>Exec(args, opts)`
 * and `<system>Available()`, wrapping exactly one external system so the Windows quirks
 * (`windowsHide`), buffer limits, timeouts and error normalisation live in one place. What it did
 * not have is one RESULT: git reported a spawn failure as `code: null` with an `Error`, while
 * docker and devcontainer reported the same failure as `code: -1` with a message string.
 *
 * That divergence is not cosmetic. `-1` is a value the `code` channel also uses for real exit
 * codes on some platforms, so "did this command run at all?" could not be asked the same way of
 * two adapters, and a caller that learned one convention read the other one wrong. `null` is the
 * only value a process can never exit WITH, which is why it is the one kept.
 *
 * Pure: no `node:` import, so this module is safe in the client barrel — the adapters that
 * produce it are not (#791).
 */

export interface ExecResult {
  stdout: string;
  stderr: string;
  /**
   * Process exit code. `0` on success, the numeric exit code on a non-zero exit, and `null`
   * when the process never produced one — killed by a signal, or failed to spawn (ENOENT,
   * timeout). `null` therefore means "no verdict", never "failed with -1".
   */
  code: number | null;
  /** The child_process error when the command could not run or exited non-zero, else `null`. */
  error: Error | null;
}

/** True when the command ran and exited 0. */
export function execSucceeded(result: ExecResult): boolean {
  return result.code === 0;
}

/** True when the command never produced an exit code — signal-killed, or never spawned. */
export function execFailedToRun(result: ExecResult): boolean {
  return result.code === null;
}

/**
 * The human-readable failure cause: trimmed stderr if the command said anything, else the error
 * message, else a last-resort description of the exit code.
 *
 * stderr comes first because a CLI that ran and complained explains the failure better than the
 * wrapper's "Command failed" — the order `gitExecOrThrow` already used. Callers used to
 * interpolate `${result.error}` directly, which printed a bare message for the string-carrying
 * adapters and `Error: <message>` for the Error-carrying one; one accessor makes the log line
 * identical whichever adapter produced the result, and never yields an empty string.
 */
export function execErrorMessage(result: ExecResult): string {
  const stderr = result.stderr.trim();
  if (stderr) return stderr;
  if (result.error) return result.error.message;
  return result.code === null ? "process produced no exit code" : `exit ${result.code}`;
}
