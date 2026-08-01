import { spawn } from "node:child_process";

export interface SetupScriptResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /**
   * True when the process was killed for exceeding its timeout budget rather than
   * exiting on its own. Callers MUST check this before treating a non-zero exit as a
   * verdict (#192) — a timeout means "didn't finish in time" (cache-temperature-
   * dependent, retryable), not "the build/tests are broken".
   */
  timedOut?: boolean;
}

/** Fallback timeout when a caller doesn't pass `timeoutMs` (#192 — was a non-configurable constant). */
export const DEFAULT_SETUP_SCRIPT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * The container a setup script must run inside, when the workspace's builder is
 * containerized. Structurally identical to `DevcontainerHandle`; declared
 * locally so this module stays free of a devcontainer-exec import.
 */
export interface SetupScriptContainer {
  containerId: string;
  remoteUser: string;
  remoteWorkspaceFolder: string;
}

/**
 * Rewrite a leading/chained POSIX wrapper invocation (`./gradlew`, `./mvnw`) into the
 * form cmd.exe can actually run (#181).
 *
 * `cmd.exe` parses `./gradlew` as the command `.` (a Windows drive-relative path
 * separator, not "current directory" like POSIX shells) and fails with "'.' is not
 * recognized" — so a `verify_script`/`setup_script` of `./gradlew build` (the profile's
 * own testCommand/buildCommand text, or a hand-set override, or an older project
 * predating the platform-aware wrapper detection in gradle-detect.service.ts) fails the
 * merge gate outright on Windows, regardless of where that POSIX-style text came from.
 * The explicit `.\` prefix is required too — a bare `gradlew.bat`/`mvnw.cmd` is not
 * resolved from the cwd under `cmd /c`.
 */
export function translatePosixWrapperForWindows(script: string): string {
  return script
    .replace(/(^|&&\s*)\.\/gradlew\b/g, "$1.\\gradlew.bat")
    .replace(/(^|&&\s*)\.\/mvnw\b/g, "$1.\\mvnw.cmd");
}

export interface RunSetupScriptOptions {
  /**
   * When present, the script runs INSIDE this container instead of on the host.
   *
   * This is not an optimization — it is required for correctness (#135). A
   * host-run `pnpm install` materializes node_modules as symlinks into the host
   * package store, so on Windows every link target is a Windows path and NOTHING
   * resolves inside a Linux container: the agent could write code but not run
   * tests (`Cannot find module .../vitest.mjs`). The same breakage hits any
   * native module or platform-specific binary.
   */
  container?: SetupScriptContainer;
  /**
   * Wall-clock budget in ms before the process is killed. Defaults to
   * {@link DEFAULT_SETUP_SCRIPT_TIMEOUT_MS} (#192 — was hardcoded to exactly 5 minutes with
   * no override, which became a hard ceiling on project size: any compiled-stack build that
   * exceeds it from a cold cache gets killed and misreported as a failure).
   */
  timeoutMs?: number;
}

/**
 * Build the argv that runs `script` inside a container.
 *
 * `/bin/sh -c` mirrors the POSIX host branch, so a setup script sees the same
 * shell semantics whether it runs on a POSIX host or in a container. `-w` is the
 * container's view of the worktree, never the host path.
 */
export function buildContainerSetupSpec(
  script: string,
  container: SetupScriptContainer,
): { command: string; args: string[] } {
  return {
    command: "docker",
    args: [
      "exec",
      "-u",
      container.remoteUser,
      "-w",
      container.remoteWorkspaceFolder,
      container.containerId,
      "/bin/sh",
      "-c",
      script,
    ],
  };
}

export function runSetupScript(
  worktreePath: string,
  script: string,
  options: RunSetupScriptOptions = {},
): Promise<SetupScriptResult> {
  return new Promise((resolve, reject) => {
    const isWindows = process.platform === "win32";
    const container = options.container;
    // On Windows, pass the command to cmd.exe VERBATIM. With the default
    // windowsVerbatimArguments:false, Node re-quotes/escapes the single `script`
    // arg and corrupts embedded double-quotes before cmd.exe sees them, so a
    // legitimately-quoted setupScript (e.g. `node -e "..."`) silently no-ops (#111).
    // The `/d /s /c` + verbatim form matches process-exec.ts `shellCommandSpec`.
    const hostShell = isWindows ? "cmd.exe" : "/bin/sh";
    const hostScript = isWindows ? translatePosixWrapperForWindows(script) : script;
    const hostArgs = isWindows ? ["/d", "/s", "/c", hostScript] : ["-c", script];
    const spec = container
      ? buildContainerSetupSpec(script, container)
      : { command: hostShell, args: hostArgs };

    const proc = spawn(spec.command, spec.args, {
      cwd: worktreePath,
      env: { ...process.env },
      windowsHide: true,
      // Verbatim quoting is a cmd.exe concern only. `docker` is a real
      // executable receiving a normal argv, so re-quoting must stay OFF for it
      // or the script would be corrupted on the way into the container.
      windowsVerbatimArguments: isWindows && !container,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    const timeoutMs = options.timeoutMs ?? DEFAULT_SETUP_SCRIPT_TIMEOUT_MS;
    const timeout = setTimeout(() => {
      proc.kill();
      // Resolve (never reject) on timeout — a kill is NOT the same verdict as a
      // script that ran to completion and failed (#192). `timedOut: true` lets
      // callers report "didn't finish in time" instead of "failed (exit 1)".
      resolve({ exitCode: 124, stdout, stderr, timedOut: true });
    }, timeoutMs);

    proc.on("exit", (code: number | null) => {
      clearTimeout(timeout);
      resolve({ exitCode: code ?? 1, stdout, stderr, timedOut: false });
    });

    proc.on("error", (err: Error) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}
