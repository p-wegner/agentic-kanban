// #1774: is the Windows systray indicator running? Neither `setup` nor `doctor` said so, and the
// tray was silently absent on a worker machine. Db-free: ships in the standalone worker binary.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DoctorCheck } from "./worker-doctor.js";

const NAME = "systray";

/** Probe for a powershell process running ak-worker-tray.ps1. null = could not tell. */
export function probeTrayRunning(): boolean | null {
  const ps = "(Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | Where-Object { $_.CommandLine -like '*ak-worker-tray.ps1*' -and $_.CommandLine -notlike '*Win32_Process*' } | Measure-Object).Count";
  const res = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8", windowsHide: true, timeout: 15_000 });
  if (res.status !== 0) return null;
  const n = Number.parseInt(String(res.stdout ?? "").trim(), 10);
  return Number.isNaN(n) ? null : n > 0;
}

/** The hidden launcher that ships next to the tray script, or null when this install lacks it. */
export function trayLauncherPath(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const up of ["../../..", "../.."]) {
    const p = join(here, up, "tools", "worker-windows", "ak-worker-tray-launch.vbs");
    if (existsSync(p)) return p;
  }
  return null;
}

export const TRAY_REMEDY = "Start it: wscript tools\worker-windows\ak-worker-tray-launch.vbs (or `agentic-kanban-worker setup` offers to).";

/** Pure: Windows-only; `running` null (probe failed) is `unknown`, never a pass. */
export function describeTray(platform: string, running: boolean | null): DoctorCheck | null {
  if (platform !== "win32") return null;
  if (running === null) return { name: NAME, status: "unknown", detail: "could not tell whether the worker tray is running" };
  if (running) return { name: NAME, status: "pass", detail: "the worker tray indicator is running" };
  return {
    name: NAME,
    status: "warn",
    detail: "the worker tray indicator is not running: no at-a-glance state, and no way to toggle attested profiles from the menu",
    remedy: TRAY_REMEDY,
  };
}

export function checkTray(platform: string = process.platform, running?: boolean | null): DoctorCheck | null {
  if (platform !== "win32") return null;
  return describeTray(platform, running === undefined ? probeTrayRunning() : running);
}

/** Start the tray hidden and detached. Returns false when the launcher is not in this install. */
export function startTray(): boolean {
  const vbs = trayLauncherPath();
  if (!vbs) return false;
  spawn("wscript.exe", [vbs], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  return true;
}
