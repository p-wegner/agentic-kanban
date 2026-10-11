// #1372 — the worker's default display name. Under WSL the hostname IS the Windows host's, so a
// worker on the board laptop's own WSL distro registered under the board machine's name.
import { readFileSync } from "node:fs";
import { hostname } from "node:os";

export interface NameProbe {
  hostname: string;
  /** Contents of /proc/sys/kernel/osrelease, or null when absent (not Linux). */
  osRelease: string | null;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
}

function liveProbe(): NameProbe {
  let osRelease: string | null = null;
  try {
    osRelease = readFileSync("/proc/sys/kernel/osrelease", "utf8");
  } catch {
    /* not Linux, or no procfs */
  }
  return { hostname: hostname(), osRelease, env: process.env, platform: process.platform };
}

/** The WSL distro name, or null when this is not WSL. `WSL_DISTRO_NAME` wins; else the kernel string says it is WSL. */
export function wslDistro(probe: NameProbe = liveProbe()): string | null {
  if (probe.platform !== "linux") return null;
  const distro = probe.env.WSL_DISTRO_NAME?.trim();
  if (distro) return distro;
  return /microsoft/i.test(probe.osRelease ?? "") ? "wsl" : null;
}

/** `<hostname>` normally; `<hostname>-wsl-<distro>` under WSL so it cannot collide with the host. */
export function defaultWorkerName(probe: NameProbe = liveProbe()): string {
  const distro = wslDistro(probe);
  if (!distro) return probe.hostname;
  const slug = distro.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  // Kernel string says WSL but no distro name known: `<host>-wsl` is still distinct from the host.
  return !slug || slug === "wsl" ? `${probe.hostname}-wsl` : `${probe.hostname}-wsl-${slug}`;
}

/** #1390: the board already lists other workers under this name; the Runners tab cannot tell them apart. */
export function sameNamedNotice(name: string, others: { id: string }[]): string {
  return `[pair] note: the board already lists ${others.length} other worker(s) named '${name}' ` +
    `(${others.map((w) => w.id.slice(0, 8)).join(", ")}). If those are stale, revoke them ` +
    `in the Runners tab, or pair again with --name <unique name>.`;
}
