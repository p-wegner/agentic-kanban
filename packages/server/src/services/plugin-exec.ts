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

/**
 * A structured stdout payload (a loop plan) must survive whole or the caller cannot parse it.
 * A tail-truncated JSON document is not "most of a plan" — it is unparseable at every offset,
 * and the resulting error blames the plugin's JSON rather than this truncation. So callers that
 * read stdout as DATA raise the cap; the tail heuristic stays for output read as DIAGNOSTICS.
 */
export const STRUCTURED_STDOUT_CAP = 4 * 1024 * 1024;

/** Keep only the last `cap` characters — the tail is what diagnoses a failure. */
export function tailOutput(text: string, cap: number = OUTPUT_TAIL_CAP): string {
  return text.length > cap ? text.slice(text.length - cap) : text;
}

export interface PluginCommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /**
   * True when stdout exceeded the cap and its FRONT was discarded. Callers that parse stdout
   * must report this instead of attributing the failure to the command's output format.
   */
  stdoutTruncated: boolean;
}

export interface PluginCommandOptions {
  cwd: string;
  env: Record<string, string>;
  timeoutMs?: number;
  /**
   * Cap for captured stdout, in characters. Defaults to the diagnostics-sized tail. Pass
   * `STRUCTURED_STDOUT_CAP` when stdout is a payload to be parsed rather than shown.
   */
  maxStdoutChars?: number;
}

export function runPluginCommand(command: string, options: PluginCommandOptions): Promise<PluginCommandResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PLUGIN_COMMAND_TIMEOUT_MS;
  return new Promise<PluginCommandResult>((resolveRun, rejectRun) => {
    const child = spawnShellCommand(command, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      mergeEnv: options.env,
    });
    const stdoutCap = options.maxStdoutChars ?? OUTPUT_TAIL_CAP;
    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    child.stdout?.on("data", (c: Buffer) => {
      const grown = stdout + c.toString("utf8");
      if (grown.length > stdoutCap) stdoutTruncated = true;
      stdout = tailOutput(grown, stdoutCap);
    });
    child.stderr?.on("data", (c: Buffer) => { stderr = tailOutput(stderr + c.toString("utf8")); });

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      if (process.platform === "win32" && child.pid) void taskkillTree(child.pid).catch(() => {});
      try { child.kill(); } catch { /* already gone */ }
      resolveRun({ code: null, stdout, stderr, timedOut: true, stdoutTruncated });
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
      resolveRun({ code, stdout, stderr, timedOut: false, stdoutTruncated });
    });
  });
}
