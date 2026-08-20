import { execShellCommand } from "./process-exec.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";

const SCRIPT_TIMEOUT_MS = 5 * 60 * 1000;

export async function runScript(
  script: string,
  cwd: string,
  label: string = "script",
  extraEnv?: Record<string, string>,
): Promise<{ ok: boolean; output: string }> {
  try {
    const { stdout, stderr } = await execShellCommand(script, {
      cwd,
      timeout: SCRIPT_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      mergeEnv: extraEnv,
    });

    const output = (stdout || "") + (stderr || "");
    console.log(`[${label}] completed: ${output.trim().slice(0, 200)}`);
    return { ok: true, output };
  } catch (err) {
    const msg = errorMessage(err);
    console.error(`[${label}] failed: ${msg}`);
    return { ok: false, output: msg };
  }
}
