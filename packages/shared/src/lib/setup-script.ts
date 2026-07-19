import { spawn } from "node:child_process";

export interface SetupScriptResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export function runSetupScript(worktreePath: string, script: string): Promise<SetupScriptResult> {
  return new Promise((resolve, reject) => {
    const isWindows = process.platform === "win32";
    const shell = isWindows ? "cmd.exe" : "/bin/sh";
    // On Windows, pass the command to cmd.exe VERBATIM. With the default
    // windowsVerbatimArguments:false, Node re-quotes/escapes the single `script`
    // arg and corrupts embedded double-quotes before cmd.exe sees them, so a
    // legitimately-quoted setupScript (e.g. `node -e "..."`) silently no-ops (#111).
    // The `/d /s /c` + verbatim form matches process-exec.ts `shellCommandSpec`.
    const shellArgs = isWindows ? ["/d", "/s", "/c", script] : ["-c", script];

    const proc = spawn(shell, shellArgs, {
      cwd: worktreePath,
      env: { ...process.env },
      windowsHide: true,
      windowsVerbatimArguments: isWindows,
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
