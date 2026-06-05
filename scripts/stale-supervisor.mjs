/**
 * Stale same-checkout supervisor detection and reaping for dev.mjs.
 *
 * Before launching a new supervisor this module:
 * 1. Lists all running `node … scripts/dev.mjs` processes.
 * 2. Filters to those whose command line references THIS checkout (same directory).
 * 3. Checks whether each candidate is actually serving the expected server port.
 *    - Serving and healthy → exit early ("already running").
 *    - Running but NOT serving → stale orphan → kill its process tree.
 * 4. Never touches supervisors bound to a different checkout or worktree port.
 */

import { execFileSync, execSync } from "node:child_process";
import { commandLineBelongsToCheckout } from "./dev-port-guard.mjs";
import { writeProcessAudit } from "./process-audit.mjs";

/**
 * List all processes whose command line contains "scripts/dev.mjs".
 * Returns [{pid, commandLine}] excluding the current process.
 *
 * @param {() => Array<{pid: number, commandLine: string}>} [listProcs]
 *   Injected for testing. Defaults to the real OS query.
 */
export function listDevMjsSupervisors(listProcs) {
  if (listProcs) {
    return listProcs().filter(({ pid }) => pid !== process.pid);
  }

  if (process.platform === "win32") {
    try {
      const script =
        "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*scripts/dev.mjs*' -or $_.CommandLine -like '*scripts\\dev.mjs*' } | " +
        "Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress";
      const out = execFileSync("powershell.exe", ["-NoProfile", "-Command", script], {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        timeout: 10000,
      }).trim();
      if (!out) return [];
      const parsed = JSON.parse(out);
      const rows = Array.isArray(parsed) ? parsed : [parsed];
      return rows
        .map((row) => ({ pid: Number(row.ProcessId), commandLine: String(row.CommandLine ?? "") }))
        .filter(({ pid }) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
    } catch {
      return [];
    }
  }

  // Unix: grep /proc or use ps
  try {
    const out = execSync("ps -eo pid=,args=", {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 10000,
    });
    return out
      .split("\n")
      .map((line) => {
        const match = line.trim().match(/^(\d+)\s+(.*)$/);
        if (!match) return null;
        return { pid: Number(match[1]), commandLine: match[2] };
      })
      .filter(
        (row) =>
          row &&
          Number.isInteger(row.pid) &&
          row.pid > 0 &&
          row.pid !== process.pid &&
          (row.commandLine.includes("scripts/dev.mjs") || row.commandLine.includes("scripts\\dev.mjs")),
      );
  } catch {
    return [];
  }
}

/**
 * Check whether a TCP port is actively listening (has a LISTENING entry in netstat).
 * Returns true if the port is bound and listening.
 *
 * @param {number} port
 * @param {(port: number) => boolean} [checkPort]  Injected for testing.
 */
export function isPortListening(port, checkPort) {
  if (checkPort) return checkPort(port);
  try {
    if (process.platform === "win32") {
      const out = execSync("netstat -ano", {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        timeout: 5000,
      });
      return out.split("\n").some((line) => {
        const parts = line.trim().split(/\s+/);
        return (
          parts[0]?.toLowerCase() === "tcp" &&
          parts[3] === "LISTENING" &&
          (parts[1]?.endsWith(`:${port}`) ?? false)
        );
      });
    }
    // Unix
    const out = execSync(`ss -tlnp 'sport = :${port}'`, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 5000,
    });
    return out.split("\n").some((line) => line.includes("LISTEN") && line.includes(`:${port}`));
  } catch {
    return false;
  }
}

/**
 * List process IDs actively listening on `port`.
 *
 * @param {number} port
 */
export function listListeningPidsOnPort(port) {
  const pids = new Set();
  try {
    if (process.platform === "win32") {
      const out = execSync("netstat -ano", {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        timeout: 5000,
      });
      for (const line of out.split("\n")) {
        const parts = line.trim().split(/\s+/);
        if (parts[0]?.toLowerCase() !== "tcp") continue;
        if (parts[3] !== "LISTENING") continue;
        if (!(parts[1]?.endsWith(`:${port}`) ?? false)) continue;
        const pid = Number(parts[4]);
        if (!Number.isInteger(pid) || pid <= 0) continue;
        pids.add(pid);
      }
      return pids;
    }

    const out = execSync(`ss -tlnp 'sport = :${port}'`, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 5000,
    });
    for (const match of out.matchAll(/pid=(\d+)/g)) {
      const pid = Number(match[1]);
      if (Number.isInteger(pid) && pid > 0) pids.add(pid);
    }
    return pids;
  } catch {
    return pids;
  }
}

/**
 * Kill a process tree by PID.
 * Windows: taskkill /PID <pid> /T /F
 * Unix: kill -9 <pid>
 *
 * @param {number} pid
 */
export function killSupervisorTree(pid) {
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        timeout: 5000,
      });
    } else {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        process.kill(pid, "SIGKILL");
      }
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect and reap stale same-checkout dev.mjs supervisors before launching a new one.
 *
 * Algorithm:
 *   1. Find all live `dev.mjs` supervisor PIDs whose command line references this checkout.
 *   2. If one is actually serving `serverPort` → it is healthy → exit(0) (already running).
 *   3. All others that belong to this checkout but are NOT serving the port are stale → kill.
 *
 * @param {{
 *   checkoutRoot: string,
 *   serverPort: number,
 *   listProcs?: () => Array<{pid: number, commandLine: string}>,
 *   isServingPid?: (pid: number) => boolean,
 *   checkPort?: (port: number) => boolean,
 *   kill?: (pid: number) => boolean,
 *   exitProcess?: (code: number) => never,
 * }} opts
 */
export function reapStaleSupervisors({
  checkoutRoot,
  serverPort,
  listProcs,
  checkPort,
  isServingPid,
  kill = killSupervisorTree,
  exitProcess = (code) => process.exit(code),
}) {
  const candidates = listDevMjsSupervisors(listProcs).filter(({ commandLine }) =>
    commandLineBelongsToCheckout(commandLine, checkoutRoot),
  );

  if (candidates.length === 0) return;

  if (typeof isServingPid === "function") {
    let servingCandidatePid = null;

    for (const { pid, commandLine } of candidates) {
      if (isServingPid(pid)) {
        servingCandidatePid = pid;
        continue;
      }

      writeProcessAudit({
        action: "dev-stale-supervisor-found",
        stalePid: pid,
        serverPort,
        checkoutRoot,
        commandLine,
      });
      console.warn(
        `[dev] Stale supervisor found (pid ${pid}) — not serving port ${serverPort}. Reaping...`,
      );
      const killed = kill(pid);
      if (killed) {
        writeProcessAudit({
          action: "dev-stale-supervisor-reaped",
          stalePid: pid,
          serverPort,
          checkoutRoot,
        });
        console.warn(`[dev] Stale supervisor (pid ${pid}) reaped.`);
      } else {
        writeProcessAudit({
          action: "dev-stale-supervisor-reap-failed",
          stalePid: pid,
          serverPort,
          checkoutRoot,
        });
        console.error(`[dev] Failed to reap stale supervisor (pid ${pid}).`);
      }
    }

    if (servingCandidatePid !== null) {
      writeProcessAudit({
        action: "dev-supervisor-already-running",
        existingPid: servingCandidatePid,
        serverPort,
        checkoutRoot,
      });
      console.log(
        `[dev] Server already running on port ${serverPort} (pid ${servingCandidatePid}). Exiting — no second supervisor needed.`,
      );
      exitProcess(0);
      return;
    }

    if (isPortListening(serverPort, checkPort)) {
      writeProcessAudit({
        action: "dev-supervisor-blocked-by-port",
        serverPort,
        checkoutRoot,
      });
      console.log(`[dev] Port ${serverPort} is already in use. Exiting without starting another dev supervisor.`);
      exitProcess(0);
    }
    return;
  }

  const serving = isPortListening(serverPort, checkPort);

  for (const { pid, commandLine } of candidates) {
    if (serving) {
      // A healthy supervisor is already serving — exit early instead of stacking.
      writeProcessAudit({
        action: "dev-supervisor-already-running",
        existingPid: pid,
        serverPort,
        checkoutRoot,
        commandLine,
      });
      console.log(
        `[dev] Server already running on port ${serverPort} (pid ${pid}). Exiting — no second supervisor needed.`,
      );
      exitProcess(0);
      return; // unreachable in production; allows testing with a mock exitProcess
    }

    // Stale supervisor: belongs to this checkout but not serving the expected port.
    writeProcessAudit({
      action: "dev-stale-supervisor-found",
      stalePid: pid,
      serverPort,
      checkoutRoot,
      commandLine,
    });
    console.warn(
      `[dev] Stale supervisor found (pid ${pid}) — not serving port ${serverPort}. Reaping...`,
    );
    const killed = kill(pid);
    if (killed) {
      writeProcessAudit({
        action: "dev-stale-supervisor-reaped",
        stalePid: pid,
        serverPort,
        checkoutRoot,
      });
      console.warn(`[dev] Stale supervisor (pid ${pid}) reaped.`);
    } else {
      writeProcessAudit({
        action: "dev-stale-supervisor-reap-failed",
        stalePid: pid,
        serverPort,
        checkoutRoot,
      });
      console.error(`[dev] Failed to reap stale supervisor (pid ${pid}).`);
    }
  }
}


