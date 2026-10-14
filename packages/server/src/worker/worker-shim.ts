// The stable launcher (#1350). The global `agentic-kanban-worker` is whatever was `npm i -g`-ed at
// bootstrap and a #1338 self-update never touches it, so a bootstrap build that predates #1346 can
// never delegate. This shim lives at a FIXED path beside the state file —
// `<worker-home>/bin/agentic-kanban-worker.{cmd,ps1,sh}` — and always resolves
// `versions/current.json`, so the documented manual restart starts the current build whatever the
// global install is. Db-free: it is part of the standalone worker binary.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const SHIM_NAME = "agentic-kanban-worker";
const RESOLVER = "worker-shim.cjs";

/** `<worker-home>/bin` — beside the state file, like `versions/`. */
export function shimDirFor(stateFile: string): string {
  return join(dirname(stateFile), "bin");
}

/** What a user runs: `.cmd` on Windows, the extensionless sh script elsewhere. */
export function shimCommandFor(stateFile: string, platform: NodeJS.Platform = process.platform): string {
  return join(shimDirFor(stateFile), platform === "win32" ? `${SHIM_NAME}.cmd` : SHIM_NAME);
}

/**
 * Resolves the entry (current.json's, else the baked fallback) and runs it with the caller's args,
 * mirroring the exit code. Plain CJS with no dependencies so it runs under any Node.
 */
export function resolverSource(fallbackEntry: string | null, fallbackVersion: string | null = null): string {
  return `"use strict";
const { existsSync, readFileSync } = require("node:fs");
const { dirname, join } = require("node:path");
const { spawnSync } = require("node:child_process");
const fallback = ${JSON.stringify(fallbackEntry)};
const fallbackVersion = ${JSON.stringify(fallbackVersion)};
// #1400: the fallback is a path into a global install that another board's runbook may overwrite.
// Only run it if it is still the build this shim was written for.
function installedVersion(file) {
  let dir = dirname(file);
  for (let up = 0; up < 6; up++) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      if (pkg && pkg.name === "agentic-kanban" && pkg.version) return pkg.version;
    } catch { /* none at this level */ }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
let entry = null;
try {
  const p = JSON.parse(readFileSync(join(__dirname, "..", "versions", "current.json"), "utf8"));
  if (p && typeof p.entry === "string" && existsSync(p.entry)) entry = p.entry;
} catch { /* no self-update yet */ }
if (!entry && fallback && existsSync(fallback)) {
  const now = fallbackVersion ? installedVersion(fallback) : null;
  if (fallbackVersion && now && now !== fallbackVersion) {
    console.error("[worker-shim] the fallback install " + fallback + " is now build " + now + ", not " + fallbackVersion +
      " (the global agentic-kanban was replaced, e.g. by another board's npm i -g). Refusing to run a different build; " +
      "re-run 'agentic-kanban-worker start' from an install of the right build to re-pin this shim.");
    process.exit(1);
  }
  entry = fallback;
}
if (!entry) {
  console.error("[worker-shim] no installed worker build found (versions/current.json missing and no fallback)");
  process.exit(1);
}
const r = spawnSync(process.execPath, [entry, ...process.argv.slice(2)], { stdio: "inherit", windowsHide: true });
process.exit(r.status === null ? 1 : r.status);
`;
}

function writeIfChanged(file: string, content: string): boolean {
  try {
    if (readFileSync(file, "utf8") === content) return false;
  } catch {
    /* absent */
  }
  writeFileSync(file, content);
  return true;
}

/**
 * Write (idempotently) the shim files. `nodePath` is baked in so the shim runs under the same Node
 * the worker does even when the shell's PATH has none. Returns the command to document, or null
 * when the directory cannot be written (best effort — never blocks a start or an update).
 */
export function installShim(opts: {
  stateFile: string;
  fallbackEntry: string | null;
  /** Package version of the fallback install, baked so a later overwrite of it is detected (#1400). */
  fallbackVersion?: string | null;
  nodePath?: string;
  platform?: NodeJS.Platform;
}): string | null {
  const dir = shimDirFor(opts.stateFile);
  const node = opts.nodePath ?? process.execPath;
  try {
    mkdirSync(dir, { recursive: true });
    writeIfChanged(join(dir, RESOLVER), resolverSource(opts.fallbackEntry, opts.fallbackVersion ?? null));
    // #1461: the Node on PATH wins, so an operator who puts another Node first gets the daemon on
    // it too; the Node recorded by `setup`/start is the fallback when the shell's PATH has none.
    writeIfChanged(
      join(dir, `${SHIM_NAME}.cmd`),
      `@echo off\r\nwhere node >nul 2>nul\r\nif errorlevel 1 goto baked\r\nnode "%~dp0${RESOLVER}" %*\r\nexit /b %ERRORLEVEL%\r\n` +
        `:baked\r\n"${node}" "%~dp0${RESOLVER}" %*\r\nexit /b %ERRORLEVEL%\r\n`,
    );
    writeIfChanged(
      join(dir, `${SHIM_NAME}.ps1`),
      `$n = Get-Command node -ErrorAction SilentlyContinue\r\n` +
        `if ($n) { & $n.Source (Join-Path $PSScriptRoot '${RESOLVER}') @args } ` +
        `else { & '${node.replace(/'/g, "''")}' (Join-Path $PSScriptRoot '${RESOLVER}') @args }\r\nexit $LASTEXITCODE\r\n`,
    );
    const sh = join(dir, SHIM_NAME);
    writeIfChanged(
      sh,
      `#!/bin/sh\nif command -v node >/dev/null 2>&1; then exec node "$(dirname "$0")/${RESOLVER}" "$@"; fi\n` +
        `exec "${node}" "$(dirname "$0")/${RESOLVER}" "$@"\n`,
    );
    try {
      chmodSync(sh, 0o755);
    } catch {
      /* not a POSIX fs */
    }
    return shimCommandFor(opts.stateFile, opts.platform);
  } catch {
    return null;
  }
}

export const shimInstalled = (stateFile: string, platform: NodeJS.Platform = process.platform): boolean =>
  existsSync(shimCommandFor(stateFile, platform));
