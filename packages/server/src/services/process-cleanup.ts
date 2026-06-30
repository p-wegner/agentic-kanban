import { auditProcessEvent, guardProcessKill } from "./process-guard.js";
import { execCommand, listOsProcesses, listenerPidsForPort, parseLsofPids, parseWmicProcessList, taskkillTree } from "./process-exec.js";

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
          await taskkillTree(pid, { timeout: 5000 });
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

/**
 * Kill the `scripts/dev.mjs` SUPERVISOR that owns the dev servers on the given ports,
 * if one exists. dev.mjs respawns killed children, so killing only a port listener
 * (killProcessesOnPorts) makes the port reappear within ~1s and leaves the supervised
 * backend alive. We start from THIS dev server's port listener(s) and walk UP the
 * parent chain, so the only dev.mjs we can reach is the supervisor of the server we're
 * stopping — never another worktree's. Killing it with `/T` cascades to ALL its
 * children (proxy + vite + the tsx backend). No-op (returns 0) when no dev.mjs ancestor
 * is found — i.e. for generic, non-agentic-kanban projects with a plain dev command.
 * Every kill still routes through guardProcessKill (protected board PIDs are spared).
 */
export async function killDevServerSupervisorOnPorts(ports: number[]): Promise<number> {
  const unique = [...new Set(ports.filter((p) => Number.isInteger(p) && p > 0))];
  if (unique.length === 0) return 0;

  let processes: Awaited<ReturnType<typeof listOsProcesses>>;
  try {
    processes = await listOsProcesses();
  } catch {
    return 0;
  }
  const byPid = new Map(processes.map((p) => [p.pid, p]));

  const supervisorPids = new Set<number>();
  for (const port of unique) {
    let listeners: number[] = [];
    try {
      listeners = await listenerPidsForPort(port);
    } catch {
      continue;
    }
    for (const listenerPid of listeners) {
      // Climb the parent chain (bounded) to the topmost dev.mjs ancestor.
      let cursor = byPid.get(listenerPid);
      let supervisor: number | null = null;
      for (let depth = 0; depth < 10 && cursor; depth++) {
        if (/dev\.mjs/i.test(cursor.commandLine)) supervisor = cursor.pid;
        const parent = byPid.get(cursor.ppid);
        if (!parent || parent.pid === cursor.pid) break;
        cursor = parent;
      }
      if (supervisor != null) supervisorPids.add(supervisor);
    }
  }

  let killed = 0;
  for (const pid of supervisorPids) {
    if (!guardProcessKill(pid, { reason: "dev-server-supervisor-port-match" })) continue;
    auditProcessEvent({ action: "dev-server-supervisor-candidate", pid });
    try {
      if (process.platform === "win32") {
        await taskkillTree(pid, { timeout: 5000 });
      } else {
        process.kill(pid, "SIGTERM");
      }
      console.log(`[process-cleanup] killed dev.mjs supervisor PID ${pid} (cascades to its dev-server children)`);
      auditProcessEvent({ action: "dev-server-supervisor-killed", pid });
      killed++;
    } catch (err) {
      auditProcessEvent({ action: "dev-server-supervisor-kill-failed", pid, error: err instanceof Error ? err.message : String(err) });
      // Process may have already exited.
    }
  }
  return killed;
}

export async function killProcessesInDir(dir: string): Promise<number> {
  let killed = 0;
  auditProcessEvent({ action: "process-cleanup-start", dir });
  try {
    if (process.platform === "win32") {
      const { stdout } = await execCommand("wmic", [
        "process", "where",
        `ExecutablePath is not null and CommandLine is not null`,
        "get", "ProcessId,ParentProcessId,CommandLine", "/format:list",
      ], { timeout: 10000 });

      const dirNormalized = dir.replace(/\\/g, "/");
      const procs = parseWmicProcessList(stdout).map((proc) => ({ pid: proc.pid, ppid: proc.ppid, cmd: proc.commandLine }));

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
            await taskkillTree(proc.pid, { timeout: 5000 });
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
        const { stdout } = await execCommand("lsof", ["+D", dir, "-t"], { timeout: 10000 });
        const pids = parseLsofPids(stdout);
        for (const pid of pids) {
          const numericPid = pid;
          if (!guardProcessKill(numericPid, { reason: "process-cleanup-dir-match", dir })) continue;
          try {
            process.kill(numericPid, "SIGTERM");
            console.log(`[process-cleanup] killed PID ${numericPid} (CWD: ${dir})`);
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
