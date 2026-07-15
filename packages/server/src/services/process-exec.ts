import { execFile, spawn, type ChildProcess, type SpawnOptions, type StdioOptions } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ExecCommandOptions {
  cwd?: string;
  timeout?: number;
  maxBuffer?: number;
  env?: NodeJS.ProcessEnv;
}

export interface ShellCommandOptions extends ExecCommandOptions {
  mergeEnv?: Record<string, string>;
}

export interface SpawnShellCommandOptions {
  cwd?: string;
  detached?: boolean;
  stdio?: StdioOptions;
  env?: NodeJS.ProcessEnv;
  mergeEnv?: Record<string, string>;
}

export interface OsProcessRecord {
  pid: number;
  ppid: number;
  name: string;
  commandLine: string;
}

export interface OsPortListener {
  pid: number;
  port: number;
  address: string;
  protocol: "tcp" | "udp";
}

function mergedEnv(options: Pick<ShellCommandOptions, "env" | "mergeEnv">): NodeJS.ProcessEnv {
  if (options.mergeEnv) return { ...(options.env ?? process.env), ...options.mergeEnv };
  return options.env ?? process.env;
}

export function shellCommandSpec(command: string): { command: string; args: string[] } {
  if (process.platform === "win32") return { command: "cmd.exe", args: ["/d", "/s", "/c", command] };
  return { command: "/bin/sh", args: ["-c", command] };
}

export async function execCommand(
  command: string,
  args: string[],
  options: ExecCommandOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync(command, args, {
    cwd: options.cwd,
    timeout: options.timeout,
    maxBuffer: options.maxBuffer,
    windowsHide: true,
    env: options.env,
  });
  return { stdout: String(stdout ?? ""), stderr: String(stderr ?? "") };
}

export async function execShellCommand(
  command: string,
  options: ShellCommandOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  const spec = shellCommandSpec(command);
  return execCommand(spec.command, spec.args, {
    cwd: options.cwd,
    timeout: options.timeout,
    maxBuffer: options.maxBuffer,
    env: mergedEnv(options),
  });
}

export function spawnShellCommand(command: string, options: SpawnShellCommandOptions = {}): ChildProcess {
  const spec = shellCommandSpec(command);
  return spawn(spec.command, spec.args, {
    cwd: options.cwd,
    detached: options.detached,
    windowsHide: true,
    stdio: options.stdio,
    env: mergedEnv(options),
  } satisfies SpawnOptions);
}

export async function taskkillTree(pid: number, options: { timeout?: number } = {}): Promise<void> {
  await execCommand("taskkill", ["/pid", String(pid), "/T", "/F"], { timeout: options.timeout ?? 5000 });
}

export function parseNetstatListeners(stdout: string): OsPortListener[] {
  const listeners: OsPortListener[] = [];
  for (const line of stdout.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) continue;
    const proto = parts[0]?.toLowerCase();
    if (proto !== "tcp" && proto !== "udp") continue;
    if (proto === "tcp" && !/^LISTENING$/i.test(parts[3] ?? "")) continue;
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

export async function listOsProcesses(): Promise<OsProcessRecord[]> {
  if (process.platform === "win32") {
    const script = "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress";
    const { stdout } = await execCommand("powershell.exe", ["-NoProfile", "-Command", script], { timeout: 10000 });
    return parsePowerShellProcessList(stdout);
  }

  try {
    const { stdout } = await execCommand("ps", ["-eo", "pid=,ppid=,comm=,args="], { timeout: 10000 });
    return parsePsProcessList(stdout);
  } catch (err) {
    // procps ("ps") is not installed in every runtime image (e.g. node:*-slim Docker
    // images). Resource-sweep hygiene is best-effort, not load-bearing, so degrade to
    // "no processes found" instead of throwing and spamming [resource-sweep] warnings
    // every monitor cycle.
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw err;
  }
}

export async function listOsPortListeners(): Promise<OsPortListener[]> {
  const { stdout } = await execCommand("netstat", ["-ano"], { timeout: 10000 });
  return parseNetstatListeners(stdout);
}

export async function listenerPidsForPort(port: number): Promise<number[]> {
  if (process.platform === "win32") {
    const { stdout } = await execCommand("netstat", ["-ano", "-p", "TCP"], { timeout: 10000 });
    return parseNetstatListenerPids(stdout, port);
  }

  try {
    const { stdout } = await execCommand("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], { timeout: 10000 });
    return parseLsofPids(stdout);
  } catch {
    return [];
  }
}
