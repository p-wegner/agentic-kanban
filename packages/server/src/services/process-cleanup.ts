import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function killProcessesInDir(dir: string): Promise<number> {
  let killed = 0;
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
          try {
            await execFileAsync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { timeout: 5000 });
            console.log(`[process-cleanup] killed PID ${proc.pid} (CWD match: ${dir})`);
            killed++;
          } catch {
            // Process may have already exited
          }
        }
      }
    } else {
      try {
        const { stdout } = await execFileAsync("lsof", ["+D", dir, "-t"], { timeout: 10000 });
        const pids = stdout.trim().split("\n").filter(Boolean);
        for (const pid of pids) {
          try {
            process.kill(Number(pid), "SIGTERM");
            console.log(`[process-cleanup] killed PID ${pid} (CWD: ${dir})`);
            killed++;
          } catch {
            // Already gone
          }
        }
      } catch {
        // lsof not found or no processes
      }
    }
  } catch (err) {
    console.warn(`[process-cleanup] error killing processes in ${dir}:`, err instanceof Error ? err.message : String(err));
  }
  return killed;
}
