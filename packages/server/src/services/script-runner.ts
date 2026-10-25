import { existsSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { execCommand, execShellCommand } from "./process-exec.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";

const SCRIPT_TIMEOUT_MS = 5 * 60 * 1000;

export const NO_GIT_BASH_MESSAGE = "teardownScript is POSIX shell but no Git Bash was found; set KANBAN_GIT_BASH";

/** Bash next to the git on PATH (#1716): `<root>\bin\bash.exe`, then `<root>\usr\bin\bash.exe`, for a git in `<root>\cmd|bin|mingw64\bin`. */
function bashBesideGitOnPath(env: NodeJS.ProcessEnv, exists: (p: string) => boolean): string | null {
  const pathVar = env.PATH ?? env.Path ?? "";
  const dirs = pathVar.split(pathVar.includes(";") ? ";" : delimiter).filter(Boolean);
  for (const dir of dirs) {
    if (!["git.exe", "git.cmd"].some((n) => exists(join(dir, n)))) continue;
    for (const root of [dirname(dir), dirname(dirname(dir))]) {
      for (const sub of [["bin"], ["usr", "bin"]]) {
        const bash = join(root, ...sub, "bash.exe");
        if (exists(bash)) return bash;
      }
    }
  }
  return null;
}

/** Git Bash on Windows (#1657): `KANBAN_GIT_BASH` override, the git on PATH (#1716: scoop, winget, portable), then the standard install dirs. */
export function findGitBash(env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = existsSync): string | null {
  if (env.KANBAN_GIT_BASH && exists(env.KANBAN_GIT_BASH)) return env.KANBAN_GIT_BASH;
  const beside = bashBesideGitOnPath(env, exists);
  if (beside) return beside;
  const candidates = [
    env.ProgramFiles && join(env.ProgramFiles, "Git", "bin", "bash.exe"),
    env["ProgramFiles(x86)"] && join(env["ProgramFiles(x86)"], "Git", "bin", "bash.exe"),
    env.LOCALAPPDATA && join(env.LOCALAPPDATA, "Programs", "Git", "bin", "bash.exe"),
  ];
  for (const c of candidates) if (c && exists(c)) return c;
  return null;
}

/** One-line startup diagnostic: the resolved Git Bash path, or its absence (#1716). */
export function describeGitBash(platform: NodeJS.Platform = process.platform, bash: string | null = findGitBash()): string {
  if (platform !== "win32") return "Git Bash: not needed (non-Windows host)";
  return bash ? `Git Bash for POSIX scripts: ${bash}` : `Git Bash for POSIX scripts: NOT FOUND — ${NO_GIT_BASH_MESSAGE}`;
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
    const needsBash = !!opts.posix && (opts.platform ?? process.platform) === "win32";
    const bash = needsBash ? (opts.gitBash === undefined ? findGitBash() : opts.gitBash) : null;
    if (needsBash && !bash) {
      console.error(`[${label}] failed: ${NO_GIT_BASH_MESSAGE}`);
      return { ok: false, output: NO_GIT_BASH_MESSAGE };
    }
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
