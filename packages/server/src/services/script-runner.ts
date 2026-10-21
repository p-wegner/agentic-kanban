import { existsSync } from "node:fs";
import { join } from "node:path";
import { execCommand, execShellCommand } from "./process-exec.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";

const SCRIPT_TIMEOUT_MS = 5 * 60 * 1000;

/** Git Bash on Windows (#1657): `KANBAN_GIT_BASH` override, then the standard install dirs. */
export function findGitBash(env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = existsSync): string | null {
  const candidates = [
    env.KANBAN_GIT_BASH,
    env.ProgramFiles && join(env.ProgramFiles, "Git", "bin", "bash.exe"),
    env["ProgramFiles(x86)"] && join(env["ProgramFiles(x86)"], "Git", "bin", "bash.exe"),
    env.LOCALAPPDATA && join(env.LOCALAPPDATA, "Programs", "Git", "bin", "bash.exe"),
  ];
  for (const c of candidates) if (c && exists(c)) return c;
  return null;
}

export interface RunScriptOptions {
  /** The script is POSIX shell: on Windows run it through Git Bash instead of cmd.exe. */
  posix?: boolean;
  platform?: NodeJS.Platform;
  gitBash?: string | null;
}

export async function runScript(
  script: string,
  cwd: string,
  label: string = "script",
  extraEnv?: Record<string, string>,
  opts: RunScriptOptions = {},
): Promise<{ ok: boolean; output: string }> {
  try {
    const bash = opts.posix && (opts.platform ?? process.platform) === "win32"
      ? (opts.gitBash === undefined ? findGitBash() : opts.gitBash)
      : null;
    const { stdout, stderr } = bash
      ? await execCommand(bash, ["-c", script], {
          cwd,
          timeout: SCRIPT_TIMEOUT_MS,
          maxBuffer: 1024 * 1024,
          env: { ...process.env, ...extraEnv },
        })
      : await execShellCommand(script, {
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
