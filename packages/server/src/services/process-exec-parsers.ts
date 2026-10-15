import type { OsPortListener, OsProcessRecord } from "./process-exec.js";

/**
 * Is this split netstat row a TCP row in the LISTENING state? (#1035)
 *
 * Windows LOCALIZES the state column — German prints `ABHÖREN` — so the English literal
 * alone matches nothing on a non-English box. The locale-independent signal is the FOREIGN
 * address: a listening socket carries the wildcard, an established/waiting row a real peer.
 * Mirrors `isNetstatListeningRow` in `scripts/dev-port-guard.mjs`; that copy serves the
 * `.mjs` launcher scripts, which cannot import from this package.
 */
function isTcpListeningRow(parts: string[]): boolean {
  if (/^LISTEN/i.test(parts[3] ?? "")) return true;
  const foreign = parts[2] ?? "";
  return foreign === "0.0.0.0:0" || foreign === "[::]:0" || foreign === "*:*";
}

export function parseNetstatListeners(stdout: string): OsPortListener[] {
  const listeners: OsPortListener[] = [];
  for (const line of stdout.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) continue;
    const proto = parts[0]?.toLowerCase();
    if (proto !== "tcp" && proto !== "udp") continue;
    if (proto === "tcp" && !isTcpListeningRow(parts)) continue;
    const local = parts[1] ?? "";
    const pidText = proto === "tcp" ? parts[4] : parts[3];
    const port = Number(local.match(/:(\d+)$/)?.[1]);
    const pid = Number(pidText);
    if (!Number.isInteger(port) || port <= 0 || !Number.isInteger(pid) || pid <= 0) continue;
    listeners.push({ pid, port, address: local, protocol: proto });
  }
  return listeners;
}

export function parseNetstatListenerPids(stdout: string, port: number): number[] {
  const pids = new Set<number>();
  for (const listener of parseNetstatListeners(stdout)) {
    if (listener.protocol === "tcp" && listener.port === port) pids.add(listener.pid);
  }
  return [...pids];
}

export function parseLsofPids(stdout: string): number[] {
  return stdout.trim().split("\n").map(Number).filter((pid) => Number.isInteger(pid) && pid > 0);
}

export function parseWmicProcessList(stdout: string): OsProcessRecord[] {
  const records: OsProcessRecord[] = [];
  let currentPid = 0;
  let currentPpid = 0;
  let currentCmd = "";

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    const [key, ...valueParts] = trimmed.split("=");
    const value = valueParts.join("=");
    if (key === "ProcessId") currentPid = Number(value);
    if (key === "ParentProcessId") currentPpid = Number(value);
    if (key === "CommandLine") currentCmd = value;

    if (currentPid && currentCmd) {
      records.push({ pid: currentPid, ppid: currentPpid, name: "", commandLine: currentCmd });
      currentPid = 0;
      currentPpid = 0;
      currentCmd = "";
    }
  }

  return records;
}

/**
 * Parse the JSON emitted by PowerShell ConvertTo-Json. Some Windows process command
 * lines contain raw control characters, and those make strict JSON.parse throw.
 */
export function safeParsePowerShellJson(stdout: string): Array<Record<string, unknown>> | Record<string, unknown> {
  const raw = stdout || "[]";
  const tryParse = (value: string) => JSON.parse(value) as Array<Record<string, unknown>> | Record<string, unknown>;
  try {
    return tryParse(raw);
  } catch {
    try {
      // eslint-disable-next-line no-control-regex
      return tryParse(raw.replace(/[\u0000-\u001f]/g, " "));
    } catch {
      return [];
    }
  }
}

export function parsePowerShellProcessList(stdout: string): OsProcessRecord[] {
  const parsed = safeParsePowerShellJson(stdout);
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows.map((row) => ({
    pid: Number(row.ProcessId),
    ppid: Number(row.ParentProcessId ?? 0),
    name: String((row.Name as string | null | undefined) ?? ""),
    commandLine: String((row.CommandLine as string | null | undefined) ?? ""),
  })).filter((row) => Number.isInteger(row.pid) && row.pid > 0);
}

export function parsePsProcessList(stdout: string): OsProcessRecord[] {
  return stdout.split("\n").map((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (!match) return null;
    return { pid: Number(match[1]), ppid: Number(match[2]), name: match[3] ?? "", commandLine: match[4] ?? "" };
  }).filter((row): row is OsProcessRecord => !!row);
}

