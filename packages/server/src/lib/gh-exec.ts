import { execFile, type ExecFileException } from "node:child_process";
import type { ExecResult } from "@agentic-kanban/shared/lib/exec-result";

/**
 * The server's only spawn point for the `gh` CLI (#1562), read-only use: `gh run list` / `gh run
 * view` with the operator's existing auth. Same shape as `docker-exec.ts`: never rejects, a spawn
 * failure (gh not installed, timeout) is `code: null`, so the caller can skip cleanly.
 */
export function ghExec(args: string[], opts: { cwd?: string; timeoutMs?: number } = {}): Promise<ExecResult> {
  const { cwd, timeoutMs = 30_000 } = opts;
  return new Promise((resolve) => {
    execFile("gh", args, { cwd, timeout: timeoutMs, maxBuffer: 5 * 1024 * 1024, windowsHide: true, env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" } }, (err, stdout, stderr) => {
      const out = stdout == null ? "" : stdout.toString();
      const errOut = stderr == null ? "" : stderr.toString();
      if (err) {
        const rawCode = (err as ExecFileException).code;
        resolve({ stdout: out, stderr: errOut, code: typeof rawCode === "number" ? rawCode : null, error: err });
        return;
      }
      resolve({ stdout: out, stderr: errOut, code: 0, error: null });
    });
  });
}
