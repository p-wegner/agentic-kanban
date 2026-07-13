// Portable pnpm invocation for the repo's own launcher/preflight scripts.
//
// Why this exists: `spawn("pnpm", args, { shell: false })` on Windows only
// resolves a real `pnpm.exe`. The two most common install methods (npm -g,
// corepack) create only `pnpm.cmd`/`pnpm.ps1` shims, so every bare spawn died
// with `spawn pnpm ENOENT` unless pnpm came from Scoop or the standalone
// installer. These scripts always run *under* pnpm (`pnpm dev`, `pnpm test:mine`,
// ...), so pnpm exports `npm_execpath` pointing at its own JS entry — running
// that through the current Node binary needs no PATH lookup at all and works
// identically on every platform and install method.

import { spawn, spawnSync } from "node:child_process";

/**
 * Resolve how to invoke pnpm with the given CLI args.
 * Returns `{ cmd, args, shell }` ready for spawn/spawnSync.
 */
export function resolvePnpmInvocation(pnpmArgs, env = process.env, platform = process.platform) {
  const execpath = env.npm_execpath;
  if (execpath && /\.[cm]?js$/i.test(execpath)) {
    return { cmd: process.execPath, args: [execpath, ...pnpmArgs], shell: false };
  }
  if (platform === "win32") {
    // No pnpm.exe guarantee — go through the shell so pnpm.cmd resolves.
    // Args are joined ourselves (none of our callers pass args with spaces);
    // passing an args array together with shell:true is deprecated (DEP0190).
    return { cmd: ["pnpm", ...pnpmArgs].join(" "), args: [], shell: true };
  }
  return { cmd: "pnpm", args: pnpmArgs, shell: false };
}

export function spawnPnpm(pnpmArgs, opts = {}) {
  const inv = resolvePnpmInvocation(pnpmArgs);
  return spawn(inv.cmd, inv.args, { shell: inv.shell, windowsHide: true, ...opts });
}

export function spawnSyncPnpm(pnpmArgs, opts = {}) {
  const inv = resolvePnpmInvocation(pnpmArgs);
  return spawnSync(inv.cmd, inv.args, { shell: inv.shell, windowsHide: true, ...opts });
}
