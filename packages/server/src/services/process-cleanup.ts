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
        "get", "ProcessId,CommandLine", "/format:list",
      ], { timeout: 10000, windowsHide: true });

      const dirNormalized = dir.replace(/\\/g, "/");
      const pidRegex = /ProcessId=(\d+)/;
      const cmdRegex = /CommandLine=(.*)/;

      const procs: { pid: string; cmd: string }[] = [];
      let currentPid = "";
      let currentCmd = "";

      for (const line of stdout.split("\n")) {
        const trimmed = line.trim();
        const pidMatch = trimmed.match(pidRegex);
        if (pidMatch) currentPid = pidMatch[1];
        const cmdMatch = trimmed.match(cmdRegex);
        if (cmdMatch) currentCmd = cmdMatch[1];

        if (currentPid && currentCmd) {
          procs.push({ pid: currentPid, cmd: currentCmd });
          currentPid = "";
          currentCmd = "";
        }
      }

      for (const proc of procs) {
        const cmdNormalized = proc.cmd.replace(/\\/g, "/");
        if (cmdNormalized.includes(dirNormalized)) {
          try {
            await execFileAsync("taskkill", ["/pid", proc.pid, "/T", "/F"], { timeout: 5000, windowsHide: true });
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
