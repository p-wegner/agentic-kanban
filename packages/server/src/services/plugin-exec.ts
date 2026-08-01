import { spawnShellCommand, taskkillTree } from "./process-exec.js";

/**
 * One-shot execution of a plugin-declared shell command.
 *
 * Shared by plugin SCRIPTS (`runScript`) and the loop PLANNER (`advanceLoop`) so
 * both inherit the same guarantees: windowsHide spawn through the sanctioned shell
 * spec, a bounded output tail (a chatty script must not pin the server's heap), a
 * hard timeout that kills the whole process tree on Windows, and a promise that
 * settles exactly once regardless of which of error/close/timeout fires first.
 */

const OUTPUT_TAIL_CAP = 16_384;
export const DEFAULT_PLUGIN_COMMAND_TIMEOUT_MS = 5 * 60 * 1000;

/** Keep only the last `OUTPUT_TAIL_CAP` characters — the tail is what diagnoses a failure. */
export function tailOutput(text: string): string {
  return text.length > OUTPUT_TAIL_CAP ? text.slice(text.length - OUTPUT_TAIL_CAP) : text;
}

export interface PluginCommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface PluginCommandOptions {
  cwd: string;
  env: Record<string, string>;
  timeoutMs?: number;
}

export function runPluginCommand(command: string, options: PluginCommandOptions): Promise<PluginCommandResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PLUGIN_COMMAND_TIMEOUT_MS;
  return new Promise<PluginCommandResult>((resolveRun, rejectRun) => {
    const child = spawnShellCommand(command, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      mergeEnv: options.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (c: Buffer) => { stdout = tailOutput(stdout + c.toString("utf8")); });
    child.stderr?.on("data", (c: Buffer) => { stderr = tailOutput(stderr + c.toString("utf8")); });

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      if (process.platform === "win32" && child.pid) void taskkillTree(child.pid).catch(() => {});
      try { child.kill(); } catch { /* already gone */ }
      resolveRun({ code: null, stdout, stderr, timedOut: true });
    }, timeoutMs);
    timer.unref();

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectRun(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveRun({ code, stdout, stderr, timedOut: false });
    });
  });
}
