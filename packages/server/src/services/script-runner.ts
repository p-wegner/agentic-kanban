import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const SCRIPT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Run a setup or teardown script in a directory.
 * Returns { ok, output } — never throws.
 */
export async function runScript(
  script: string,
  cwd: string,
  label: string = "script",
): Promise<{ ok: boolean; output: string }> {
  try {
    const isWindows = process.platform === "win32";
    const shell = isWindows ? "cmd.exe" : "/bin/sh";
    const shellArgs = isWindows ? ["/c", script] : ["-c", script];

    const { stdout, stderr } = await execFileAsync(shell, shellArgs, {
      cwd,
      timeout: SCRIPT_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });

    const output = (stdout || "") + (stderr || "");
    console.log(`[${label}] completed: ${output.trim().slice(0, 200)}`);
    return { ok: true, output };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[${label}] failed: ${msg}`);
    return { ok: false, output: msg };
  }
}
