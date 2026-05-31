import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { auditProcessEvent, guardProcessKill } from "./process-guard.js";

const execFileAsync = promisify(execFile);

/**
 * Kill the process (tree) listening on each of the given ports. Used to free the
 * deterministic dev-server ports the app assigns to a worktree, since those dev
 * servers resolve vite/tsx from the SHARED main-checkout node_modules and so never
 * match a worktree-dir command-line filter (killProcessesInDir misses them).
 *
 * Targets the EXACT ports given — never a range — so it can't hit unrelated OS
 * services. Every kill still passes through guardProcessKill (protected board PIDs /
 * ports are spared).
 */
export async function killProcessesOnPorts(ports: number[]): Promise<number> {
  const unique = [...new Set(ports.filter((p) => Number.isInteger(p) && p > 0))];
  if (unique.length === 0) return 0;
  let killed = 0;
  for (const port of unique) {
    let pids: number[] = [];
    try {
      pids = await listenerPidsForPort(port);
    } catch {
      continue;
    }
    for (const pid of pids) {
      if (!guardProcessKill(pid, { reason: "process-cleanup-port-match", port })) continue;
      auditProcessEvent({ action: "process-cleanup-candidate", pid, port });
      try {
        if (process.platform === "win32") {
          await execFileAsync("taskkill", ["/pid", String(pid), "/T", "/F"], { timeout: 5000 });
        } else {
          process.kill(pid, "SIGTERM");
        }
        console.log(`[process-cleanup] killed PID ${pid} (listening on port ${port})`);
        auditProcessEvent({ action: "process-cleanup-killed", pid, port });
        killed++;
      } catch (err) {
        auditProcessEvent({ action: "process-cleanup-kill-failed", pid, port, error: err instanceof Error ? err.message : String(err) });
        // Process may have already exited.
      }
    }
  }
  return killed;
}

/** PIDs currently LISTENING on a specific TCP port (best-effort, cross-platform). */
async function listenerPidsForPort(port: number): Promise<number[]> {
  if (process.platform === "win32") {
    const { stdout } = await execFileAsync("netstat", ["-ano", "-p", "TCP"], { timeout: 10000 });
    const pids = new Set<number>();
    for (const line of stdout.split("\n")) {
      // e.g. "  TCP    0.0.0.0:3180   0.0.0.0:0   LISTENING   12345"
      if (!/\bLISTENING\b/i.test(line)) continue;
      const cols = line.trim().split(/\s+/);
      const local = cols[1] ?? "";
      const localPort = Number(local.split(":").pop());
      if (localPort !== port) continue;
      const pid = Number(cols[cols.length - 1]);
      if (Number.isInteger(pid) && pid > 0) pids.add(pid);
    }
    return [...pids];
  }
  try {
    const { stdout } = await execFileAsync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], { timeout: 10000 });
    return stdout.trim().split("\n").map(Number).filter((n) => Number.isInteger(n) && n > 0);
  } catch {
    return [];
  }
}

export async function killProcessesInDir(dir: string): Promise<number> {
  let killed = 0;
  auditProcessEvent({ action: "process-cleanup-start", dir });
  try {
    if (process.platform === "win32") {
      const { stdout } = await execFileAsync("wmic", [
        "process", "where",
        `ExecutablePath is not null and CommandLine is not null`,
        "get", "ProcessId,ParentProcessId,CommandLine", "/format:list",
      ], { timeout: 10000 });

      const dirNormalized = dir.replace(/\\/g, "/");
      const pidRegex = /ProcessId=(\d+)/;
      const ppidRegex = /ParentProcessId=(\d+)/;
      const cmdRegex = /CommandLine=(.*)/;

      const procs: { pid: number; ppid: number; cmd: string }[] = [];
      let currentPid = 0;
      let currentPpid = 0;
      let currentCmd = "";

      for (const line of stdout.split("\n")) {
        const trimmed = line.trim();
        const pidMatch = trimmed.match(pidRegex);
        if (pidMatch) currentPid = Number(pidMatch[1]);
        const ppidMatch = trimmed.match(ppidRegex);
        if (ppidMatch) currentPpid = Number(ppidMatch[1]);
        const cmdMatch = trimmed.match(cmdRegex);
        if (cmdMatch) currentCmd = cmdMatch[1];

        if (currentPid && currentCmd) {
          procs.push({ pid: currentPid, ppid: currentPpid, cmd: currentCmd });
          currentPid = 0; currentPpid = 0; currentCmd = "";
        }
      }

      // Build ancestor set for the current process so we never kill our own server.
      const ppidMap = new Map(procs.map(p => [p.pid, p.ppid]));
      const ancestors = new Set<number>([process.pid]);
      let ancestor = process.pid;
      for (let i = 0; i < 10; i++) {
        const parent = ppidMap.get(ancestor);
        if (!parent || parent === 0 || parent === ancestor) break;
        ancestors.add(parent);
        ancestor = parent;
      }

      for (const proc of procs) {
        if (ancestors.has(proc.pid)) continue;
        const cmdNormalized = proc.cmd.replace(/\\/g, "/");
        if (cmdNormalized.includes(dirNormalized)) {
          auditProcessEvent({ action: "process-cleanup-candidate", pid: proc.pid, ppid: proc.ppid, dir, commandLine: proc.cmd });
          if (!guardProcessKill(proc.pid, { reason: "process-cleanup-dir-match", dir, commandLine: proc.cmd })) continue;
          try {
            await execFileAsync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { timeout: 5000 });
            console.log(`[process-cleanup] killed PID ${proc.pid} (CWD match: ${dir})`);
            auditProcessEvent({ action: "process-cleanup-killed", pid: proc.pid, dir });
            killed++;
          } catch (err) {
            auditProcessEvent({ action: "process-cleanup-kill-failed", pid: proc.pid, dir, error: err instanceof Error ? err.message : String(err) });
            // Process may have already exited
          }
        }
      }
    } else {
      try {
        const { stdout } = await execFileAsync("lsof", ["+D", dir, "-t"], { timeout: 10000 });
        const pids = stdout.trim().split("\n").filter(Boolean);
        for (const pid of pids) {
          const numericPid = Number(pid);
          if (!guardProcessKill(numericPid, { reason: "process-cleanup-dir-match", dir })) continue;
          try {
            process.kill(numericPid, "SIGTERM");
            console.log(`[process-cleanup] killed PID ${pid} (CWD: ${dir})`);
            auditProcessEvent({ action: "process-cleanup-killed", pid: numericPid, dir });
            killed++;
          } catch (err) {
            auditProcessEvent({ action: "process-cleanup-kill-failed", pid: numericPid, dir, error: err instanceof Error ? err.message : String(err) });
            // Already gone
          }
        }
      } catch {
        // lsof not found or no processes
      }
    }
  } catch (err) {
    auditProcessEvent({ action: "process-cleanup-error", dir, error: err instanceof Error ? err.message : String(err) });
    console.warn(`[process-cleanup] error killing processes in ${dir}:`, err instanceof Error ? err.message : String(err));
  }
  auditProcessEvent({ action: "process-cleanup-finished", dir, killed });
  return killed;
}
