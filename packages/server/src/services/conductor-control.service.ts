// Start/stop control for the detached board-monitor *Conductor* loop
// (scripts/board-monitor/loop.sh). Complements the read-only orchestrator-monitor
// service: that one reports "is the loop alive?"; this one lets the Start Mode UI
// actually start/stop it.
//
// Conductor mode = the external loop is the sole driver. Selecting "conductor" in the
// Start Mode control starts this loop; selecting manual/monitor stops it.
//
// Naturally gated to the dogfood board: only a repo that ships scripts/board-monitor/loop.sh
// can run a Conductor (every other project uses the in-process monitor).

import { spawn, execFile } from "child_process";
import { existsSync, writeFileSync, readFileSync, unlinkSync } from "fs";
import { join } from "path";
import { readOrchestratorStatus } from "./orchestrator-monitor.service.js";

function boardMonitorDir(repoPath: string): string {
  return join(repoPath, "scripts", "board-monitor");
}
// loop.sh writes its git-bash `$$` to loop.pid — unusable for a Windows kill. So when the
// SERVER spawns the loop we record the real OS PID separately and kill by that.
function serverPidPath(repoPath: string): string {
  return join(boardMonitorDir(repoPath), "loop.server.pid");
}

export function conductorAvailable(repoPath: string): boolean {
  return !!repoPath && existsSync(join(boardMonitorDir(repoPath), "loop.sh"));
}

export interface ConductorActionResult {
  ok: boolean;
  pid: number | null;
  error?: string;
}

/**
 * Spawn the detached Conductor loop with extra env knobs. Survives a server hot-reload
 * (like agent subprocesses) and records its OS PID so stop can tree-kill it. No-op if a
 * Conductor is already alive — the caller never gets two drivers on one board.
 */
function spawnConductorLoop(
  repoPath: string,
  agent: "claude" | "codex",
  extraEnv: NodeJS.ProcessEnv,
): ConductorActionResult {
  if (!conductorAvailable(repoPath)) return { ok: false, pid: null, error: "no scripts/board-monitor/loop.sh in this project" };
  if (readOrchestratorStatus(repoPath).alive) return { ok: false, pid: null, error: "conductor already running" };
  try {
    const child = spawn("bash", ["scripts/board-monitor/loop.sh"], {
      cwd: repoPath,
      env: { ...process.env, MONITOR_AGENT: agent, ...extraEnv },
      detached: true,
      windowsHide: true,
      stdio: "ignore",
    });
    child.unref();
    const pid = child.pid ?? null;
    if (pid) {
      try { writeFileSync(serverPidPath(repoPath), String(pid), "utf8"); } catch { /* non-fatal */ }
    }
    return { ok: true, pid };
  } catch (err) {
    return { ok: false, pid: null, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Start the continuous Conductor loop (the always-on driver for `conductor` Start Mode).
 */
export function startConductor(repoPath: string, agent: "claude" | "codex" = "claude"): ConductorActionResult {
  return spawnConductorLoop(repoPath, agent, {});
}

/**
 * Fire exactly ONE off-process board-monitor cycle then exit (cron-driven, ticket #841).
 * `MONITOR_MAX_ITERS=1` runs a single iteration; `MONITOR_SLEEP=0` skips the loop's trailing
 * inter-cycle sleep so the detached process exits promptly instead of lingering ~30 min.
 */
export function runConductorCycleOnce(repoPath: string, agent: "claude" | "codex" = "claude"): ConductorActionResult {
  return spawnConductorLoop(repoPath, agent, { MONITOR_MAX_ITERS: "1", MONITOR_SLEEP: "0" });
}

/**
 * Stop the Conductor loop (and its current cycle's agent child). Kills by the OS PID we
 * recorded at start; on Windows that means a scoped `taskkill /T` of the loop's own tree —
 * NOT a broad kill (it never touches the board server or workspace builders, which are
 * children of the server, not the loop).
 */
export function stopConductor(repoPath: string): ConductorActionResult {
  const pidPath = serverPidPath(repoPath);
  let pid: number | null = null;
  if (existsSync(pidPath)) {
    const parsed = Number.parseInt(readFileSync(pidPath, "utf8").trim(), 10);
    if (Number.isInteger(parsed) && parsed > 0) pid = parsed;
  }
  try {
    if (pid) {
      if (process.platform === "win32") {
        execFile("taskkill", ["/F", "/T", "/PID", String(pid)], () => { /* best-effort */ });
      } else {
        try { process.kill(-pid, "SIGTERM"); } catch { try { process.kill(pid, "SIGTERM"); } catch { /* gone */ } }
      }
    }
    // Robust backstop: kill EVERY loop.sh process (+ its agent-child tree), not just the
    // recorded PID. Repeated start/stop can overwrite loop.server.pid and orphan an earlier
    // loop whose in-flight cycle keeps driving the board — this reaps those too.
    if (process.platform === "win32") {
      const ps =
        "Get-CimInstance Win32_Process -Filter \"Name='bash.exe'\" -ErrorAction SilentlyContinue | " +
        "Where-Object { $_.CommandLine -match 'board-monitor.loop\\.sh' } | " +
        "ForEach-Object { Start-Process -NoNewWindow taskkill -ArgumentList '/F','/T','/PID',$_.ProcessId }";
      execFile("powershell", ["-NoProfile", "-Command", ps], () => { /* best-effort */ });
    }
    // Clear the pid files so the status reader reports stopped on its next poll.
    try { unlinkSync(pidPath); } catch { /* already gone */ }
    try { unlinkSync(join(boardMonitorDir(repoPath), "loop.pid")); } catch { /* already gone */ }
    return { ok: true, pid };
  } catch (err) {
    return { ok: false, pid, error: err instanceof Error ? err.message : String(err) };
  }
}
