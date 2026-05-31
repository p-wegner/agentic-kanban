import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { issues, sessions, workspaces } from "@agentic-kanban/shared/schema";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { db, type Database } from "../db/index.js";
import { auditProcessEvent, guardProcessKill, protectedPids } from "./process-guard.js";

const execFileAsync = promisify(execFile);
const DEFAULT_BOARD_SERVER_PORT = 3001;
const DEFAULT_BOARD_CLIENT_PORT = 5173;

export interface ProcessRecord {
  pid: number;
  ppid: number;
  name: string;
  commandLine: string;
}

export interface SnapshotProcessRecord extends ProcessRecord {
  parentAlive: boolean;
}

export interface PortListener {
  pid: number;
  port: number;
  address: string;
  protocol: "tcp" | "udp";
}

export interface ActiveWorkspaceResource {
  workspaceId: string;
  issueId: string;
  issueNumber: number | null;
  workingDir: string | null;
  sessionPid: number | null;
  ports: number[];
}

export interface ProcessTreeDecision {
  rootPid: number;
  pids: number[];
  commandLine: string;
  listenerPorts: number[];
  associatedWorkspaceIds: string[];
  action: "kept" | "cleaned" | "cleanup_failed";
  reason: string;
}

export interface BoardMonitorResourceSnapshot {
  at: string;
  protectedPorts: number[];
  processes: SnapshotProcessRecord[];
  listeners: PortListener[];
  activeWorkspaces: ActiveWorkspaceResource[];
  kept: ProcessTreeDecision[];
  cleaned: ProcessTreeDecision[];
}

export interface StaleDevProcessDeps {
  listProcesses?: () => Promise<ProcessRecord[]>;
  listListeners?: () => Promise<PortListener[]>;
  killTree?: (pid: number) => Promise<void>;
  now?: () => Date;
}

interface RuntimeSnapshotInput {
  processes: ProcessRecord[];
  listeners: PortListener[];
  activeWorkspaces: ActiveWorkspaceResource[];
  cleanupScopePaths?: string[];
  protectedPorts: Set<number>;
  protectedPidSet: Set<number>;
  now: Date;
}

function normalizePath(value: string | null | undefined): string {
  return (value ?? "").replace(/\\/g, "/").toLowerCase();
}

function worktreeScopeRoot(value: string | null | undefined): string | null {
  const normalized = normalizePath(value);
  const marker = "/.worktrees/";
  const markerIndex = normalized.indexOf(marker);
  if (markerIndex < 0) return null;
  return normalized.slice(0, markerIndex + marker.length - 1);
}

function branchHash(branchName: string): number {
  let hash = 0;
  for (let i = 0; i < branchName.length; i++) {
    hash = (hash * 31 + branchName.charCodeAt(i)) & 0xffff;
  }
  return (hash % 900) + 101;
}

export function resolveWorktreeDevPorts(workingDir: string | null, issueNumber: number | null): number[] {
  if (issueNumber && Number.isInteger(issueNumber) && issueNumber > 0) {
    return [DEFAULT_BOARD_SERVER_PORT + issueNumber, DEFAULT_BOARD_CLIENT_PORT + issueNumber];
  }
  const normalized = normalizePath(workingDir);
  if (!normalized.includes("/.worktrees/")) return [];
  const leaf = normalized.split("/").filter(Boolean).at(-1) ?? "";
  const issueMatch = leaf.match(/(?:^|[_/-])ak-(\d+)-/i) ?? leaf.match(/^feature[_/-](\d+)-/i);
  const offset = issueMatch ? Number(issueMatch[1]) : branchHash(leaf);
  return [DEFAULT_BOARD_SERVER_PORT + offset, DEFAULT_BOARD_CLIENT_PORT + offset];
}

function parsePort(value: string | undefined): number | null {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 ? port : null;
}

function envProtectedPorts(): Set<number> {
  return new Set(
    [
      DEFAULT_BOARD_SERVER_PORT,
      DEFAULT_BOARD_CLIENT_PORT,
      parsePort(process.env.KANBAN_BOARD_SERVER_PORT),
      parsePort(process.env.KANBAN_BOARD_CLIENT_PORT),
      parsePort(process.env.KANBAN_SERVER_PORT),
      parsePort(process.env.KANBAN_CLIENT_PORT),
      parsePort(process.env.PORT),
      parsePort(process.env.SERVER_PORT),
      parsePort(process.env.VITE_PORT),
    ].filter((port): port is number => typeof port === "number"),
  );
}

function isRelevantProcess(proc: ProcessRecord): boolean {
  const haystack = `${proc.name} ${proc.commandLine}`.toLowerCase().replace(/\\/g, "/");
  return (
    haystack.includes("node") ||
    haystack.includes("pnpm") ||
    haystack.includes("tsx") ||
    haystack.includes("vite") ||
    haystack.includes("codex") ||
    haystack.includes("claude")
  );
}

function isDevTreeProcess(proc: ProcessRecord): boolean {
  const cmd = proc.commandLine.toLowerCase().replace(/\\/g, "/");
  return (
    (cmd.includes("pnpm") && /\sdev(?:\s|$)/.test(cmd)) ||
    cmd.includes("scripts/dev.mjs") ||
    cmd.includes("tsx") && cmd.includes("src/index.ts") ||
    cmd.includes("vite/bin/vite") ||
    cmd.includes(" vite ")
  );
}

function buildChildren(processes: ProcessRecord[]): Map<number, ProcessRecord[]> {
  const children = new Map<number, ProcessRecord[]>();
  for (const proc of processes) {
    const list = children.get(proc.ppid) ?? [];
    list.push(proc);
    children.set(proc.ppid, list);
  }
  for (const list of children.values()) list.sort((a, b) => a.pid - b.pid);
  return children;
}

function descendants(root: ProcessRecord, children: Map<number, ProcessRecord[]>): ProcessRecord[] {
  const out: ProcessRecord[] = [];
  const stack = [root];
  const seen = new Set<number>();
  while (stack.length > 0) {
    const proc = stack.pop()!;
    if (seen.has(proc.pid)) continue;
    seen.add(proc.pid);
    out.push(proc);
    const childList = children.get(proc.pid) ?? [];
    for (let i = childList.length - 1; i >= 0; i--) stack.push(childList[i]);
  }
  return out.sort((a, b) => a.pid - b.pid);
}

function treeRoots(processes: ProcessRecord[]): ProcessRecord[] {
  const byPid = new Map(processes.map((proc) => [proc.pid, proc]));
  return processes
    .filter(isDevTreeProcess)
    .filter((proc) => {
      let parent = byPid.get(proc.ppid);
      for (let i = 0; parent && i < 20; i++) {
        if (isDevTreeProcess(parent)) return false;
        parent = byPid.get(parent.ppid);
      }
      return true;
    })
    .sort((a, b) => a.pid - b.pid);
}

function workspaceAssociations(tree: ProcessRecord[], activeWorkspaces: ActiveWorkspaceResource[]): string[] {
  const pids = new Set(tree.map((proc) => proc.pid));
  const command = normalizePath(tree.map((proc) => proc.commandLine).join("\n"));
  const associated: string[] = [];
  for (const ws of activeWorkspaces) {
    const dir = normalizePath(ws.workingDir);
    if ((ws.sessionPid && pids.has(ws.sessionPid)) || (ws.sessionPid && dir && command.includes(dir))) {
      associated.push(ws.workspaceId);
    }
  }
  return associated.sort();
}

export function classifyStaleDevProcessTrees(input: RuntimeSnapshotInput): BoardMonitorResourceSnapshot {
  const allPids = new Set(input.processes.map((proc) => proc.pid));
  const cleanupScopePaths = [...new Set((input.cleanupScopePaths ?? []).map(normalizePath).filter(Boolean))];
  const relevantProcesses = input.processes
    .filter(isRelevantProcess)
    .map((proc) => ({ ...proc, parentAlive: proc.ppid > 0 && allPids.has(proc.ppid) }))
    .sort((a, b) => a.pid - b.pid);
  const listeners = input.listeners
    .filter((listener) => relevantProcesses.some((proc) => proc.pid === listener.pid))
    .sort((a, b) => a.port - b.port || a.pid - b.pid);
  const children = buildChildren(input.processes);
  const kept: ProcessTreeDecision[] = [];
  const cleaned: ProcessTreeDecision[] = [];

  for (const root of treeRoots(input.processes)) {
    const tree = descendants(root, children);
    const treeCommand = normalizePath(tree.map((proc) => proc.commandLine).join("\n"));
    const treePids = new Set(tree.map((proc) => proc.pid));
    const listenerPorts = listeners
      .filter((listener) => treePids.has(listener.pid))
      .map((listener) => listener.port)
      .sort((a, b) => a - b);
    const associatedWorkspaceIds = workspaceAssociations(tree, input.activeWorkspaces);
    const inCleanupScope = cleanupScopePaths.some((scope) => treeCommand.includes(scope));
    const protectedTreePids = tree.filter((proc) => input.protectedPidSet.has(proc.pid)).map((proc) => proc.pid);
    const protectedTreePorts = listenerPorts.filter((port) => input.protectedPorts.has(port));
    const decisionBase = {
      rootPid: root.pid,
      pids: [...treePids].sort((a, b) => a - b),
      commandLine: root.commandLine,
      listenerPorts,
      associatedWorkspaceIds,
    };

    if (protectedTreePids.length > 0) {
      kept.push({ ...decisionBase, action: "kept", reason: `protected-pid:${protectedTreePids.join(",")}` });
    } else if (protectedTreePorts.length > 0) {
      kept.push({ ...decisionBase, action: "kept", reason: `protected-port:${protectedTreePorts.join(",")}` });
    } else if (associatedWorkspaceIds.length > 0) {
      kept.push({ ...decisionBase, action: "kept", reason: "active-workspace-session" });
    } else if (!inCleanupScope) {
      kept.push({ ...decisionBase, action: "kept", reason: "outside-cleanup-scope" });
    } else if (listenerPorts.length > 0) {
      kept.push({ ...decisionBase, action: "kept", reason: `listener-port:${listenerPorts.join(",")}` });
    } else {
      cleaned.push({ ...decisionBase, action: "cleaned", reason: "stale-dev-tree-no-listeners" });
    }
  }

  return {
    at: input.now.toISOString(),
    protectedPorts: [...input.protectedPorts].sort((a, b) => a - b),
    processes: relevantProcesses,
    listeners,
    activeWorkspaces: input.activeWorkspaces
      .map((ws) => ({ ...ws, ports: [...ws.ports].sort((a, b) => a - b) }))
      .sort((a, b) => a.workspaceId.localeCompare(b.workspaceId)),
    kept,
    cleaned,
  };
}

async function getWorkspaceCleanupScopePaths(database: Database): Promise<string[]> {
  const rows = await database.select({ workingDir: workspaces.workingDir }).from(workspaces);
  const paths = new Set<string>();
  for (const row of rows) {
    const dir = normalizePath(row.workingDir);
    if (!dir) continue;
    paths.add(dir);
    const root = worktreeScopeRoot(dir);
    if (root) paths.add(root);
  }
  return [...paths].sort();
}

async function defaultKillTree(pid: number): Promise<void> {
  if (!guardProcessKill(pid, { reason: "monitor-stale-dev-tree" })) return;
  if (process.platform === "win32") {
    await execFileAsync("taskkill", ["/PID", String(pid), "/T", "/F"], { timeout: 5000, windowsHide: true });
  } else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      process.kill(pid, "SIGKILL");
    }
  }
}

export async function listProcesses(): Promise<ProcessRecord[]> {
  if (process.platform === "win32") {
    const script = "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress";
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", script], { timeout: 10000, windowsHide: true });
    const parsed = JSON.parse(stdout || "[]") as Array<Record<string, unknown>> | Record<string, unknown>;
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows.map((row) => ({
      pid: Number(row.ProcessId),
      ppid: Number(row.ParentProcessId ?? 0),
      name: String(row.Name ?? ""),
      commandLine: String(row.CommandLine ?? ""),
    })).filter((row) => Number.isInteger(row.pid) && row.pid > 0);
  }

  const { stdout } = await execFileAsync("ps", ["-eo", "pid=,ppid=,comm=,args="], { timeout: 10000 });
  return stdout.split("\n").map((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (!match) return null;
    return { pid: Number(match[1]), ppid: Number(match[2]), name: match[3], commandLine: match[4] };
  }).filter((row): row is ProcessRecord => !!row);
}

export async function listPortListeners(): Promise<PortListener[]> {
  const { stdout } = await execFileAsync("netstat", ["-ano"], { timeout: 10000, windowsHide: true });
  const listeners: PortListener[] = [];
  for (const line of stdout.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) continue;
    const proto = parts[0]?.toLowerCase();
    if (proto !== "tcp" && proto !== "udp") continue;
    if (proto === "tcp" && parts[3] !== "LISTENING") continue;
    const local = parts[1] ?? "";
    const pidText = proto === "tcp" ? parts[4] : parts[3];
    const port = Number(local.match(/:(\d+)$/)?.[1]);
    const pid = Number(pidText);
    if (!Number.isInteger(port) || !Number.isInteger(pid) || pid <= 0) continue;
    listeners.push({ pid, port, address: local, protocol: proto });
  }
  return listeners;
}

async function getActiveWorkspaceResources(database: Database): Promise<ActiveWorkspaceResource[]> {
  const rows = await database
    .select({
      workspaceId: workspaces.id,
      issueId: issues.id,
      issueNumber: issues.issueNumber,
      workingDir: workspaces.workingDir,
      sessionPid: sessions.pid,
    })
    .from(workspaces)
    .innerJoin(issues, eq(workspaces.issueId, issues.id))
    .leftJoin(sessions, and(eq(sessions.workspaceId, workspaces.id), eq(sessions.status, "running")))
    .where(and(sql`${workspaces.status} != 'closed'`, or(isNull(workspaces.closedAt), sql`${workspaces.closedAt} = ''`)));

  const byWorkspace = new Map<string, ActiveWorkspaceResource>();
  for (const row of rows) {
    const existing = byWorkspace.get(row.workspaceId);
    const ports = resolveWorktreeDevPorts(row.workingDir, row.issueNumber);
    if (!existing) {
      byWorkspace.set(row.workspaceId, {
        workspaceId: row.workspaceId,
        issueId: row.issueId,
        issueNumber: row.issueNumber,
        workingDir: row.workingDir,
        sessionPid: row.sessionPid ?? null,
        ports,
      });
    } else if (!existing.sessionPid && row.sessionPid) {
      existing.sessionPid = row.sessionPid;
    }
  }
  return [...byWorkspace.values()];
}

export async function snapshotAndCleanStaleDevProcesses(
  database: Database = db,
  deps: StaleDevProcessDeps = {},
): Promise<BoardMonitorResourceSnapshot> {
  const activeWorkspaces = await getActiveWorkspaceResources(database);
  const cleanupScopePaths = await getWorkspaceCleanupScopePaths(database);
  const protectedPorts = envProtectedPorts();
  for (const ws of activeWorkspaces) for (const port of ws.ports) protectedPorts.add(port);

  const snapshot = classifyStaleDevProcessTrees({
    processes: await (deps.listProcesses ?? listProcesses)(),
    listeners: await (deps.listListeners ?? listPortListeners)(),
    activeWorkspaces,
    cleanupScopePaths,
    protectedPorts,
    protectedPidSet: protectedPids(),
    now: deps.now?.() ?? new Date(),
  });

  auditProcessEvent({
    action: "monitor-resource-snapshot",
    protectedPorts: snapshot.protectedPorts,
    processCount: snapshot.processes.length,
    listenerCount: snapshot.listeners.length,
    kept: snapshot.kept.map(({ rootPid, pids, listenerPorts, associatedWorkspaceIds, reason }) => ({ rootPid, pids, listenerPorts, associatedWorkspaceIds, reason })),
    cleaned: snapshot.cleaned.map(({ rootPid, pids, reason }) => ({ rootPid, pids, reason })),
  });

  await cleanStaleDevProcessSnapshot(snapshot, deps.killTree ?? defaultKillTree);

  return snapshot;
}

export async function cleanStaleDevProcessSnapshot(
  snapshot: BoardMonitorResourceSnapshot,
  killTree: (pid: number) => Promise<void> = defaultKillTree,
): Promise<void> {
  for (const decision of snapshot.cleaned) {
    try {
      await killTree(decision.rootPid);
      auditProcessEvent({ action: "monitor-stale-dev-tree-cleaned", rootPid: decision.rootPid, pids: decision.pids, reason: decision.reason });
    } catch (err) {
      decision.action = "cleanup_failed";
      decision.reason = `cleanup-failed:${err instanceof Error ? err.message : String(err)}`;
      auditProcessEvent({ action: "monitor-stale-dev-tree-cleanup-failed", rootPid: decision.rootPid, pids: decision.pids, error: err instanceof Error ? err.message : String(err) });
    }
  }
}
