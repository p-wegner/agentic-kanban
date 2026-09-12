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
// cmd.exe treats a bare space, quote, or one of `&|<>^%` as significant when it appears
// unquoted on the joined command line. The target here (`pnpm`) resolves to `pnpm.cmd`, a
// BATCH FILE — and batch parameter substitution (%1, %2, ...) additionally splits an
// unquoted argument on comma, semicolon and `=` (treating them like a space) before %1 is
// even assigned, independently of cmd.exe's own tokenizing. An issue title containing a
// comma ("Fix bug, retry") would silently become two arguments to the batch file without
// this. Wrapping such an argument in double quotes (doubling any embedded `"`) keeps it as
// one token and stops it being parsed as a second command or split into extra params —
// load-bearing since #1109's `cli-json.mjs` forwards arbitrary user text (issue titles/
// descriptions) through this join.
function quoteForCmdShell(arg) {
  if (arg === "") return '""';
  if (!/[\s"&|<>^%,;=]/.test(arg)) return arg;
  const doubledQuotes = arg.replace(/"/g, '""');
  // Quoting alone does NOT stop cmd.exe expanding a literal %VAR% - that expansion happens
  // regardless of quotes, and is why an issue title containing "%WINDIR%" was silently
  // replaced with the real path before ever reaching the CLI. Toggle out of the quoted
  // string for each `%` (close quote, caret-escape the `%` unquoted, reopen quote) so no
  // contiguous "%NAME%" ever appears in a form cmd.exe's variable lookup can match.
  const percentEscaped = doubledQuotes.replace(/%/g, '"^%"');
  return `"${percentEscaped}"`;
}

export function resolvePnpmInvocation(pnpmArgs, env = process.env, platform = process.platform) {
  const execpath = env.npm_execpath;
  if (execpath && /\.[cm]?js$/i.test(execpath)) {
    return { cmd: process.execPath, args: [execpath, ...pnpmArgs], shell: false };
  }
  if (platform === "win32") {
    // No pnpm.exe guarantee — go through the shell so pnpm.cmd resolves.
    // Args are joined ourselves and individually quoted (see `quoteForCmdShell`);
    // passing an args array together with shell:true is deprecated (DEP0190).
    return { cmd: ["pnpm", ...pnpmArgs].map(quoteForCmdShell).join(" "), args: [], shell: true };
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
