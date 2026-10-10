// Windows: put an agent's whole process tree in a kill-on-close Job Object (#1336).
//
// Node has no Job Object API, so a small PowerShell helper owns the job. It creates the job
// with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, assigns the agent's pid to it, then blocks on its
// own stdin. The stdin pipe is the daemon's lifeline: when the daemon dies, however it dies
// (`Stop-Process -Force` included), the OS closes the pipe, the helper reads EOF and exits,
// its job handle closes, and Windows kills every process in the job — the agent AND the
// `bash.exe` it started. A line `release` clears the kill-on-close flag first, which is how
// `--leave-agents` keeps its meaning (the tree survives on purpose).
//
// The helper also exits when the agent does; that closes the job too, so a child the agent
// left behind dies with it instead of becoming an ownerless orphan.

import { spawn, type ChildProcess } from "node:child_process";

const HELPER_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class AkJob {
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr CreateJobObject(IntPtr a, string n);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool SetInformationJobObject(IntPtr h, int c, IntPtr p, uint l);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool AssignProcessToJobObject(IntPtr j, IntPtr p);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(uint a, bool i, uint pid);
  public static bool SetKillOnClose(IntPtr job, bool on) {
    IntPtr p = Marshal.AllocHGlobal(144);
    try {
      for (int i = 0; i < 144; i += 8) Marshal.WriteInt64(p, i, 0);
      Marshal.WriteInt32(p, 16, on ? 0x2000 : 0);
      return SetInformationJobObject(job, 9, p, 144);
    } finally { Marshal.FreeHGlobal(p); }
  }
}
'@
$job = [AkJob]::CreateJobObject([IntPtr]::Zero, $null)
if ($job -eq [IntPtr]::Zero) { [Console]::Error.WriteLine('job-create-failed'); exit 2 }
if (-not [AkJob]::SetKillOnClose($job, $true)) { [Console]::Error.WriteLine('job-limit-failed'); exit 2 }
$h = [AkJob]::OpenProcess(0x0101, $false, [uint32]$env:AK_JOB_PID)
if ($h -eq [IntPtr]::Zero) { [Console]::Error.WriteLine('job-open-failed'); exit 2 }
if (-not [AkJob]::AssignProcessToJobObject($job, $h)) { [Console]::Error.WriteLine('job-assign-failed'); exit 2 }
[Console]::Out.WriteLine('job-ready')
$agent = [System.Diagnostics.Process]::GetProcessById([int]$env:AK_JOB_PID)
$line = [Console]::In.ReadLineAsync()
while (-not $agent.HasExited) {
  if ($line.Wait(500)) { break }
}
if ($line.IsCompleted -and $line.Result -eq 'release') { [void][AkJob]::SetKillOnClose($job, $false) }
exit 0
`;

const ENCODED_HELPER = Buffer.from(HELPER_SCRIPT, "utf16le").toString("base64");

export interface AgentJob {
  /** Clear kill-on-close so the agent tree outlives the daemon (`--leave-agents`). */
  release(): void;
  /** Resolves with the helper's first status line (`job-ready` or an error tag); mainly for tests. */
  ready: Promise<string>;
}

/**
 * Attach a kill-on-close job to an already-spawned agent. Win32 only; returns null elsewhere.
 * Best-effort: the agent is already running, so a failure here is logged by the caller via
 * `ready` and degrades to the startup sweep rather than blocking the launch.
 */
export function attachAgentJob(agentPid: number, log: (line: string) => void): AgentJob | null {
  if (process.platform !== "win32") return null;
  let helper: ChildProcess;
  try {
    helper = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", ENCODED_HELPER], {
      env: { ...process.env, AK_JOB_PID: String(agentPid) },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (err) {
    log(`[worker] could not start the job-object helper for pid=${agentPid}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  helper.stdin?.on("error", () => { /* helper already gone */ });
  helper.on("error", () => { /* surfaced through `ready` */ });
  const ready = new Promise<string>((resolve) => {
    let out = "";
    let err = "";
    helper.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      if (out.includes("job-ready")) resolve("job-ready");
    });
    helper.stderr?.on("data", (chunk: Buffer) => { err += chunk.toString(); });
    helper.on("exit", () => resolve(err.trim().split(/\r?\n/)[0] || out.trim() || "helper-exited"));
    helper.on("error", (e) => resolve(`helper-error: ${e.message}`));
  });
  void ready.then((status) => {
    if (status === "job-ready") log(`[worker] agent pid=${agentPid} is in a kill-on-close job object`);
    else log(`[worker] no job object for agent pid=${agentPid} (${status}); relying on the startup sweep`);
  });
  return {
    ready,
    release() {
      try {
        helper.stdin?.write("release\n");
        helper.stdin?.end();
      } catch { /* helper already gone */ }
    },
  };
}
