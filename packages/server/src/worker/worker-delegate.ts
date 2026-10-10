// Delegation to the current self-updated build (#1346). After a #1338 self-update the daemon runs
// from `<worker-home>/versions/<sha>/…/bin/worker.js`, while the globally installed
// `agentic-kanban-worker` is still the bootstrap build. A manual restart through the global
// binary must land on the CURRENT build, not the stale one (which would just self-update again).

import { workerLog } from "./worker-updater.js";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { readPointer, versionsDirFor } from "./worker-versions.js";

/** Set on the delegated child so a pointer that names a build which itself delegates cannot loop. */
export const DELEGATED_ENV = "KANBAN_WORKER_DELEGATED";

export interface DelegationTarget {
  buildId: string;
  entry: string;
}

export interface BuildComparison {
  /** `bin/worker.js` this process runs from; null when unknown. */
  runningEntry: string | null;
  /** What `versions/current.json` points at; null when absent/unreadable. */
  current: { buildId: string; entry: string; installed: boolean } | null;
  /** True when current.json names an installed build other than the running one. */
  differs: boolean;
}

const samePath = (a: string, b: string): boolean => {
  const norm = (p: string) => (process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p));
  return norm(a) === norm(b);
};

/** Compare this process's build with the one `current.json` selects. Pure apart from fs reads. */
export function compareBuilds(stateFile: string, runningEntry: string | null): BuildComparison {
  const pointer = readPointer(versionsDirFor(stateFile));
  if (!pointer?.entry) return { runningEntry, current: null, differs: false };
  const installed = existsSync(pointer.entry);
  const differs = installed && (!runningEntry || !samePath(pointer.entry, runningEntry));
  return { runningEntry, current: { buildId: pointer.buildId, entry: pointer.entry, installed }, differs };
}

/** The build `start` should hand over to, or null to run this one. */
export function resolveDelegation(opts: {
  stateFile: string;
  runningEntry: string | null;
  noDelegate?: boolean;
  env?: NodeJS.ProcessEnv;
}): DelegationTarget | null {
  if (opts.noDelegate) return null;
  if ((opts.env ?? process.env)[DELEGATED_ENV] === "1") return null;
  const cmp = compareBuilds(opts.stateFile, opts.runningEntry);
  if (!cmp.differs || !cmp.current) return null;
  return { buildId: cmp.current.buildId, entry: cmp.current.entry };
}

/** argv for the delegated build: the same args, minus the `worker` prefix and `--no-delegate`. */
export function delegatedArgv(argv: readonly string[]): string[] {
  const rest = argv[0] === "worker" ? argv.slice(1) : [...argv];
  return rest.filter((a) => a !== "--no-delegate");
}

/**
 * Run `target` in the foreground with the same argv and mirror its exit code, so a supervisor
 * or terminal sees one process. Returns the child's exit code.
 */
export function runDelegated(
  target: DelegationTarget,
  argv: readonly string[],
  deps: { execPath?: string; spawnImpl?: typeof spawn; log?: (line: string) => void } = {},
): Promise<number> {
  const log = deps.log ?? ((line: string) => workerLog(line));
  log(
    `[worker] delegating to the current build ${target.buildId.slice(0, 12)} (${target.entry}) - ` +
      "pass --no-delegate to run this install instead",
  );
  return new Promise((resolveCode) => {
    const child = (deps.spawnImpl ?? spawn)(deps.execPath ?? process.execPath, [target.entry, ...delegatedArgv(argv)], {
      stdio: "inherit",
      windowsHide: true,
      env: { ...process.env, [DELEGATED_ENV]: "1" },
    });
    const forward = (sig: NodeJS.Signals) => () => {
      try {
        child.kill(sig);
      } catch {
        /* already gone */
      }
    };
    process.on("SIGINT", forward("SIGINT"));
    process.on("SIGTERM", forward("SIGTERM"));
    child.on("error", (err: Error) => {
      log(`[worker] delegation failed (${err.message}) - running this install instead`);
      resolveCode(-1);
    });
    child.on("exit", (code: number | null) => resolveCode(code ?? 1));
  });
}
