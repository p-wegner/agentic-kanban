/**
 * Stale same-checkout supervisor detection and reaping for dev.mjs.
 *
 * Before launching a new supervisor this module:
 * 1. Lists running processes and finds `node ... scripts/dev.mjs` supervisors.
 * 2. Filters to supervisors whose command line references THIS checkout.
 * 3. Checks whether each candidate's process tree owns the expected server port.
 *    - Serving and healthy: exit early ("already running").
 *    - Running but not serving that port: stale orphan, kill its process tree.
 * 4. Never touches supervisors bound to a different checkout or worktree port.
 */

import { execFileSync, execSync } from "node:child_process";
import { commandLineBelongsToCheckout } from "./dev-port-guard.mjs";
import { writeProcessAudit } from "./process-audit.mjs";

function normalizeProcessRecord(row) {
  return {
    pid: Number(row.pid ?? row.ProcessId),
    ppid: Number(row.ppid ?? row.ParentProcessId ?? 0),
    commandLine: String(row.commandLine ?? row.CommandLine ?? ""),
  };
}

function isUsableProcessRecord(proc) {
  return Number.isInteger(proc.pid) && proc.pid > 0;
}

function isDevMjsSupervisorCommand(commandLine) {
  return commandLine.toLowerCase().replace(/\\/g, "/").includes("scripts/dev.mjs");
}

/**
 * List process records that can be used for supervisor tree checks.
 *
 * @param {() => Array<{pid: number, ppid?: number, commandLine: string}>} [listProcs]
 *   Injected for testing. Defaults to the real OS query.
 */
export function listProcessRecords(listProcs) {
  if (listProcs) {
    return listProcs().map(normalizeProcessRecord).filter(isUsableProcessRecord);
  }

  if (process.platform === "win32") {
    try {
      const script =
        "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress";
      const out = execFileSync("powershell.exe", ["-NoProfile", "-Command", script], {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        timeout: 10000,
      }).trim();
      if (!out) return [];
      const parsed = JSON.parse(out);
      const rows = Array.isArray(parsed) ? parsed : [parsed];
      return rows.map(normalizeProcessRecord).filter(isUsableProcessRecord);
    } catch {
      return [];
    }
  }

  try {
    const out = execSync("ps -eo pid=,ppid=,args=", {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 10000,
    });
    return out
      .split("\n")
      .map((line) => {
        const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
        if (!match) return null;
        return { pid: Number(match[1]), ppid: Number(match[2]), commandLine: match[3] };
      })
      .filter((row) => row && isUsableProcessRecord(row));
  } catch {
    return [];
  }
}

/**
 * List all processes whose command line contains "scripts/dev.mjs".
 * Returns [{pid, ppid, commandLine}] excluding the current process.
 */
export function listDevMjsSupervisors(listProcs) {
  return listProcessRecords(listProcs)
    .filter(({ pid }) => pid !== process.pid)
    .filter(({ commandLine }) => isDevMjsSupervisorCommand(commandLine));
}

/**
 * Check whether a TCP port is actively listening (has a LISTENING entry in netstat).
 * Returns true if the port is bound and listening.
 *
 * @param {number} port
 * @param {(port: number) => boolean} [checkPort] Injected for testing.
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

function processTreeIncludesPid(processes, rootPid, targetPid) {
  if (rootPid === targetPid) return true;
  const parentByPid = new Map(processes.map(({ pid, ppid }) => [pid, ppid]));
  const seen = new Set();
  let current = targetPid;

  for (let depth = 0; depth < 64; depth++) {
    const parent = parentByPid.get(current);
    if (!parent || seen.has(parent)) return false;
    if (parent === rootPid) return true;
    seen.add(parent);
    current = parent;
  }

  return false;
}

function supervisorServesPort(supervisor, processes, servingPids, isServingPid) {
  if (typeof isServingPid === "function" && isServingPid(supervisor.pid)) return true;
  for (const servingPid of servingPids) {
    if (processTreeIncludesPid(processes, supervisor.pid, servingPid)) return true;
  }
  return false;
}

/**
 * Build a dry-run plan for the dev.mjs startup preflight. A supervisor is only
 * healthy when its own process tree owns the expected server port; an unrelated
 * listener on the same port is not enough to protect a stale supervisor. The
 * checkout-root filter is the process-signature guard that keeps other worktree
 * and unrelated node processes outside the reap set.
 */
export function planStaleSupervisorReap({
  checkoutRoot,
  processes,
  servingPids = new Set(),
  isServingPid,
  portListening = false,
}) {
  const candidates = processes
    .filter(({ pid }) => pid !== process.pid)
    .filter(({ commandLine }) => isDevMjsSupervisorCommand(commandLine))
    .filter(({ commandLine }) => commandLineBelongsToCheckout(commandLine, checkoutRoot));

  if (candidates.length === 0) {
    return { candidates, stale: [], serving: null, portBlocked: false };
  }

  const stale = [];
  let serving = null;
  for (const candidate of candidates) {
    if (supervisorServesPort(candidate, processes, servingPids, isServingPid)) {
      serving = candidate;
    } else {
      stale.push(candidate);
    }
  }

  return {
    candidates,
    stale,
    serving,
    portBlocked: serving === null && portListening,
  };
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

function resolvePortState({ serverPort, listProcs, checkPort, listeningPids }) {
  const servingPids = listeningPids ?? (listProcs ? new Set() : listListeningPidsOnPort(serverPort));
  const portListening = checkPort
    ? isPortListening(serverPort, checkPort)
    : servingPids.size > 0 || (!listProcs && isPortListening(serverPort));
  return { servingPids, portListening };
}

function logAndKillStaleSupervisor({ pid, commandLine, serverPort, checkoutRoot, kill }) {
  writeProcessAudit({
    action: "dev-stale-supervisor-found",
    stalePid: pid,
    serverPort,
    checkoutRoot,
    commandLine,
  });
  console.warn(`[dev] Stale supervisor found (pid ${pid}) - not serving port ${serverPort}. Reaping...`);
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

/**
 * Detect and reap stale same-checkout dev.mjs supervisors before launching a new one.
 *
 * Algorithm:
 *   1. Find all live `dev.mjs` supervisor PIDs whose command line references this checkout.
 *   2. If one has a descendant serving `serverPort`, it is healthy, so exit(0).
 *   3. All others that belong to this checkout but are not serving that port are stale, so kill.
 *
 * @param {{
 *   checkoutRoot: string,
 *   serverPort: number,
 *   listProcs?: () => Array<{pid: number, ppid?: number, commandLine: string}>,
 *   listeningPids?: Set<number>,
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
  listeningPids,
  isServingPid,
  kill = killSupervisorTree,
  exitProcess = (code) => process.exit(code),
}) {
  const processes = listProcessRecords(listProcs);
  const { servingPids, portListening } = resolvePortState({ serverPort, listProcs, checkPort, listeningPids });
  const plan = planStaleSupervisorReap({
    checkoutRoot,
    processes,
    servingPids,
    isServingPid,
    portListening,
  });

  if (plan.candidates.length === 0) return;

  for (const stale of plan.stale) {
    logAndKillStaleSupervisor({ ...stale, serverPort, checkoutRoot, kill });
  }

  if (plan.serving) {
    writeProcessAudit({
      action: "dev-supervisor-already-running",
      existingPid: plan.serving.pid,
      serverPort,
      checkoutRoot,
      commandLine: plan.serving.commandLine,
    });
    console.log(
      `[dev] Server already running on port ${serverPort} (pid ${plan.serving.pid}). Exiting - no second supervisor needed.`,
    );
    exitProcess(0);
    return;
  }

  if (plan.portBlocked) {
    writeProcessAudit({
      action: "dev-supervisor-blocked-by-port",
      serverPort,
      checkoutRoot,
    });
    console.log(`[dev] Port ${serverPort} is already in use. Exiting without starting another dev supervisor.`);
    exitProcess(0);
  }
}
