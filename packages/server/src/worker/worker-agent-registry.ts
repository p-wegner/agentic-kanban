// Worker-side record of the agents a daemon launched, and the startup sweep that kills
// what a PREVIOUS daemon left behind (#1336).
//
// Why a file: a daemon killed with `Stop-Process -Force` runs no shutdown code, so the
// only thing that can find its agents' leftover children afterwards is what it wrote down
// BEFORE dying. The Windows Job Object (worker-job-holder.ts) and the POSIX process group
// are the first line; this is the net under them for whatever escaped (a job that could
// not be created, a child that broke away, a SIGKILLed POSIX daemon whose group lives on).
//
// Entries live in `<workRoot>/agents/<sessionId>.json`. A graceful stop with
// `--leave-agents` marks every live entry `leftOnPurpose` so the sweep leaves it alone.

import { workerLog } from "./worker-updater.js";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { uptime } from "node:os";
import { join, resolve } from "node:path";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import { killProcessTree, listOsProcesses, type OsProcessRecord } from "../services/process-exec.js";

export interface AgentRecord {
  sessionId: string;
  /** The pid the daemon spawned (the shell on a `useShell` launch). On POSIX also the pgid when detached. */
  pid: number;
  /** The agent's working directory — the checkout, and the command-line marker for stragglers. */
  cwd?: string;
  /** ISO timestamp of the launch. */
  startedAt: string;
  /** The daemon that launched it. */
  daemonPid: number;
  /** `--leave-agents`: the tree survives on purpose, the sweep must not touch it. */
  leftOnPurpose?: boolean;
}

export interface SweepReport {
  /** Records examined. */
  scanned: number;
  /** Leftover process pids killed (agent roots and descendants). */
  killed: number[];
  /** Sessions whose record was skipped because `--leave-agents` left them on purpose. */
  leftOnPurpose: string[];
}

function agentsDir(workRoot: string): string {
  return join(workRoot, "agents");
}

function recordPath(workRoot: string, sessionId: string): string {
  return join(agentsDir(workRoot), `${sessionId.replace(/[^\w.-]/g, "_")}.json`);
}

/** Best-effort: a registry write failure must never stop an agent from launching. */
export function recordAgent(workRoot: string, record: AgentRecord): void {
  try {
    mkdirSync(agentsDir(workRoot), { recursive: true });
    writeFileSync(recordPath(workRoot, record.sessionId), JSON.stringify(record));
  } catch (err) {
    workerLog(`[worker] could not record agent ${record.sessionId}: ${errorMessage(err)}`);
  }
}

export function forgetAgent(workRoot: string, sessionId: string): void {
  try {
    rmSync(recordPath(workRoot, sessionId), { force: true });
  } catch { /* best-effort */ }
}

export function readAgentRecords(workRoot: string): AgentRecord[] {
  const dir = agentsDir(workRoot);
  if (!existsSync(dir)) return [];
  const records: AgentRecord[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(dir, name), "utf8")) as Partial<AgentRecord>;
      if (typeof parsed.sessionId === "string" && Number.isInteger(parsed.pid) && (parsed.pid as number) > 0) {
        records.push(parsed as AgentRecord);
      }
    } catch { /* unreadable record — ignored */ }
  }
  return records;
}

/** Mark every recorded agent as deliberately left running (`--leave-agents`). */
export function markAgentsLeftOnPurpose(workRoot: string, sessionIds: string[]): void {
  for (const sessionId of sessionIds) {
    const record = readAgentRecords(workRoot).find((r) => r.sessionId === sessionId);
    if (record) recordAgent(workRoot, { ...record, leftOnPurpose: true });
  }
}

function normalizePath(p: string): string {
  // A Windows drive path recorded by a Windows daemon must not be rebased onto a POSIX cwd.
  const abs = /^[a-zA-Z]:[\\/]/.test(p) ? p : resolve(p);
  return abs.replace(/\\/g, "/").toLowerCase();
}

/**
 * Pids to kill for one record on win32: the agent root if it is still alive, every process
 * whose parent chain leads to the recorded pid (Windows keeps a dead parent's pid in the
 * child's ParentProcessId, which is what makes an orphan findable), and anything whose
 * command line names the checkout.
 */
export function collectLeftoverPids(record: AgentRecord, processes: OsProcessRecord[], ownPid: number): number[] {
  const wanted = new Set<number>();
  const byParent = new Map<number, OsProcessRecord[]>();
  for (const proc of processes) {
    const list = byParent.get(proc.ppid) ?? [];
    list.push(proc);
    byParent.set(proc.ppid, list);
  }
  const queue = [record.pid];
  while (queue.length > 0) {
    const parent = queue.pop() as number;
    for (const child of byParent.get(parent) ?? []) {
      if (wanted.has(child.pid) || child.pid === ownPid) continue;
      wanted.add(child.pid);
      queue.push(child.pid);
    }
  }
  if (processes.some((p) => p.pid === record.pid) && record.pid !== ownPid) wanted.add(record.pid);
  if (record.cwd) {
    const marker = normalizePath(record.cwd);
    for (const proc of processes) {
      if (proc.pid === ownPid) continue;
      if (proc.commandLine && proc.commandLine.replace(/\\/g, "/").toLowerCase().includes(marker)) wanted.add(proc.pid);
    }
  }
  return [...wanted];
}

export interface SweepDeps {
  listProcesses?: () => Promise<OsProcessRecord[]>;
  kill?: (pid: number, group: boolean) => Promise<void>;
  platform?: NodeJS.Platform;
  ownPid?: number;
}

/**
 * Kill the agent trees a previous daemon recorded and never cleaned up, then drop the
 * records. Runs BEFORE checkouts are reaped so nothing is holding files in them. Logs every
 * kill; never throws.
 */
export async function sweepLeftoverAgents(
  workRoot: string,
  log: (line: string) => void,
  deps: SweepDeps = {},
): Promise<SweepReport> {
  const report: SweepReport = { scanned: 0, killed: [], leftOnPurpose: [] };
  const platform = deps.platform ?? process.platform;
  const ownPid = deps.ownPid ?? process.pid;
  const bootTimeMs = Date.now() - uptime() * 1000;
  const kill = deps.kill ?? (async (pid: number, group: boolean) => {
    await killProcessTree(pid, { timeout: 5000, group });
  });
  let records: AgentRecord[];
  try {
    records = readAgentRecords(workRoot);
  } catch (err) {
    log(`[worker] leftover-agent sweep could not read the registry: ${errorMessage(err)}`);
    return report;
  }
  report.scanned = records.length;
  if (records.length === 0) return report;

  let processes: OsProcessRecord[] | null = null;
  for (const record of records) {
    if (record.leftOnPurpose) {
      report.leftOnPurpose.push(record.sessionId);
      log(`[worker] leaving agent tree of session ${record.sessionId} (pid ${record.pid}) running: it was left on purpose (--leave-agents)`);
      continue;
    }
    if (record.daemonPid === ownPid) continue; // ours, not a predecessor's
    // A record older than the last boot names pids the OS has since recycled: killing them
    // (or their "children") would hit unrelated processes. Everything it started died with the boot.
    const startedMs = Date.parse(record.startedAt);
    if (Number.isFinite(startedMs) && startedMs < bootTimeMs) {
      log(`[worker] dropping stale agent record of session ${record.sessionId}: it predates the last boot`);
      forgetAgent(workRoot, record.sessionId);
      continue;
    }
    try {
      if (platform === "win32") {
        processes ??= await (deps.listProcesses ?? listOsProcesses)();
        // Children first, root last: killing the root first would orphan them further.
        const pids = collectLeftoverPids(record, processes, ownPid).sort((a, b) => (a === record.pid ? 1 : 0) - (b === record.pid ? 1 : 0));
        for (const pid of pids) {
          try {
            await kill(pid, false);
            report.killed.push(pid);
            const cmd = processes.find((p) => p.pid === pid)?.commandLine ?? "";
            log(`[worker] killed leftover process of previous daemon: pid=${pid} session=${record.sessionId} cmd=${cmd.slice(0, 120)}`);
          } catch { /* already gone */ }
        }
      } else {
        try {
          await kill(record.pid, true);
          report.killed.push(record.pid);
          log(`[worker] killed leftover process group of previous daemon: pgid=${record.pid} session=${record.sessionId}`);
        } catch (err) {
          if ((err as NodeJS.ErrnoException)?.code !== "ESRCH") throw err;
        }
      }
    } catch (err) {
      log(`[worker] could not kill leftovers of session ${record.sessionId}: ${errorMessage(err)}`);
      continue; // keep the record: the next start tries again
    }
    forgetAgent(workRoot, record.sessionId);
  }
  if (report.killed.length === 0) log(`[worker] leftover-agent sweep: nothing to kill (${records.length} stale record(s) dropped)`);
  return report;
}
