import { spawn } from "node:child_process";

export interface SetupScriptResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

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
    const hostArgs = isWindows ? ["/d", "/s", "/c", script] : ["-c", script];
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

    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error("Setup script timed out after 5 minutes"));
    }, 5 * 60 * 1000);

    proc.on("exit", (code: number | null) => {
      clearTimeout(timeout);
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });

    proc.on("error", (err: Error) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}
