import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";

/**
 * Open a REAL, visible terminal window running `codex login` with `CODEX_HOME` set
 * to the given license dir. The OAuth callback server codex starts on
 * localhost:1455 needs a foreground process — a hidden/background spawn (or the
 * agent harness's `!` shell) tears the callback down and the login is cancelled.
 * So we deliberately pop a window the user can complete the browser flow from.
 *
 * Returns the equivalent manual command (for the UI's copy button) — actual
 * spawning is fire-and-forget; failures to launch a terminal are non-fatal because
 * the user can always run the manual command.
 */
export function spawnCodexLogin(codexHome: string): { command: string } {
  const home = codexHome.trim();
  mkdirSync(home, { recursive: true });

  if (process.platform === "win32") {
    // `start "title" cmd /k ...` opens a new console that stays open after login
    // so the user can read the result. windowsHide:false to actually show it.
    const inner = `set "CODEX_HOME=${home}" && codex login`;
    spawn(`start "Codex Login" cmd /k "${inner}"`, {
      shell: true,
      detached: true,
      windowsHide: false,
      stdio: "ignore",
    }).unref();
    return { command: `$env:CODEX_HOME='${home}'; codex login` };
  }

  // macOS / Linux: best-effort open of the user's terminal emulator.
  const manual = `CODEX_HOME='${home}' codex login`;
  spawn("sh", ["-c", `x-terminal-emulator -e ${JSON.stringify(manual)} || open -a Terminal`], {
    detached: true,
    stdio: "ignore",
  }).unref();
  return { command: manual };
}
