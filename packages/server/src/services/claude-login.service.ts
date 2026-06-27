import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";

/**
 * Open a REAL, visible terminal window running `claude /login` with
 * `CLAUDE_CONFIG_DIR` set to the given subscription dir. The OAuth browser flow
 * needs a foreground process — a hidden/background spawn (or the agent harness's
 * `!` shell) tears the callback down and the login is cancelled. So we deliberately
 * pop a window the user can complete the browser flow from. This mirrors
 * `spawnCodexLogin` for Codex licenses.
 *
 * Returns the equivalent manual command (for the UI's copy button) — actual
 * spawning is fire-and-forget; failures to launch a terminal are non-fatal because
 * the user can always run the manual command.
 */
export function spawnClaudeLogin(configDir: string): { command: string } {
  const dir = configDir.trim();
  mkdirSync(dir, { recursive: true });

  if (process.platform === "win32") {
    // `start "title" cmd /k ...` opens a new console that stays open after login
    // so the user can read the result. windowsHide:false to actually show it.
    const inner = `set "CLAUDE_CONFIG_DIR=${dir}" && claude /login`;
    // Fire-and-forget; a synchronous spawn throw (e.g. ENOENT/bad shell) must stay
    // NON-FATAL — the manual command below is still returned for the UI copy button.
    try {
      spawn(`start "Claude Login" cmd /k "${inner}"`, {
        shell: true,
        detached: true,
        windowsHide: false,
        stdio: "ignore",
      }).unref();
    } catch (err) {
      console.warn("[claude-login] failed to launch login terminal (non-fatal):", err);
    }
    return { command: `$env:CLAUDE_CONFIG_DIR='${dir}'; claude /login` };
  }

  // macOS / Linux: best-effort open of the user's terminal emulator.
  const manual = `CLAUDE_CONFIG_DIR='${dir}' claude /login`;
  try {
    spawn("sh", ["-c", `x-terminal-emulator -e ${JSON.stringify(manual)} || open -a Terminal`], {
      detached: true,
      stdio: "ignore",
    }).unref();
  } catch (err) {
    console.warn("[claude-login] failed to launch login terminal (non-fatal):", err);
  }
  return { command: manual };
}
