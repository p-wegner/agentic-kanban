// Spawn-and-reap harness for tests that need a REAL MCP server over stdio.
//
// Why this exists (#46): the old call sites did `spawn("pnpm", ["--filter", …, "dev"])`
// and reaped with a bare `proc.kill()`. On Windows that chain is
//
//     pnpm.cmd  ->  tsx/dist/cli.mjs  ->  node … loader.mjs src/index.ts
//                                          ^ the actual stdio listener
//
// `proc.kill()` only reaches the `pnpm` shim, so BOTH descendants survived every run.
// The orphans keep running (and holding their temp DB open), burning CPU. A later
// `vitest run` is then starved by them and its 5s-budget tests time out — producing a
// wall of *false* red that has nothing to do with the code under test.
//
// Two defences, because either alone is insufficient:
//   1. Spawn the server as a SINGLE node process (`node --import tsx <entry>`), so the
//      listener IS the direct child and `kill()` can actually reach it. This is the
//      pattern disabled-tools.test.ts already proved out.
//   2. Tree-kill (`taskkill /F /T`) + a process-exit reaper as a backstop, so an
//      interrupted/crashed run — where no `afterAll` ever executes — still leaves
//      nothing behind.
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";

// helpers -> __tests__ -> src -> mcp-server
const MCP_PKG_DIR = resolve(import.meta.dirname, "../../..");
const SERVER_ENTRY = resolve(MCP_PKG_DIR, "src/index.ts");

/** Every server we spawned that hasn't been confirmed dead yet. */
const live = new Set<ChildProcess>();

/**
 * Kill a process AND its descendants. A plain `child.kill()` on Windows signals only
 * the named pid; tsx/node grandchildren survive it. `taskkill /T` walks the tree.
 */
function treeKill(pid: number): void {
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/F", "/T", "/PID", String(pid)], {
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      // Already gone, or never started — nothing to reap.
    }
  } else {
    try {
      process.kill(-pid, "SIGKILL"); // process group
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }
}

// Backstop: if the run is interrupted (Ctrl-C, vitest bail, an uncaught throw) no
// afterAll runs, so reap whatever is still registered. `exit` handlers must be
// synchronous — execFileSync/process.kill both qualify.
let reaperInstalled = false;
function installReaper(): void {
  if (reaperInstalled) return;
  reaperInstalled = true;
  const reapAll = () => {
    for (const proc of live) {
      if (proc.pid !== undefined && proc.exitCode === null) treeKill(proc.pid);
    }
    live.clear();
  };
  process.once("exit", reapAll);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      reapAll();
      process.exit(1);
    });
  }
}

/**
 * Start the MCP server against `dbPath` and resolve once it reports "running on stdio".
 * The process is tracked for reaping; if startup times out it is torn down here rather
 * than leaked (the old inline versions leaked on exactly that path).
 */
export function startMcpServer(
  dbPath: string,
  opts: { env?: NodeJS.ProcessEnv; startupTimeoutMs?: number } = {},
): Promise<ChildProcess> {
  installReaper();
  const proc = spawn(
    process.execPath,
    ["--conditions=development", "--import", "tsx", SERVER_ENTRY],
    {
      cwd: MCP_PKG_DIR,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      // detached:false keeps it in our job/tree so a hard abort takes it with us.
      env: { ...process.env, DB_URL: `file:${dbPath}`, ...opts.env },
    },
  );
  live.add(proc);
  proc.once("exit", () => live.delete(proc));

  return new Promise<ChildProcess>((resolveP, reject) => {
    // Process launch on a loaded Windows box is not a 5s operation; this budget is
    // about catching a genuine hang, not about measuring machine load.
    const timeoutMs = opts.startupTimeoutMs ?? 30_000;
    let stderr = "";
    const timer = setTimeout(() => {
      void stopMcpServer(proc);
      reject(
        new Error(
          `MCP server didn't report "running on stdio" within ${timeoutMs}ms.\nstderr so far:\n${stderr}`,
        ),
      );
    }, timeoutMs);

    proc.stderr!.on("data", (data: Buffer) => {
      stderr += data.toString();
      if (stderr.includes("running on stdio")) {
        clearTimeout(timer);
        resolveP(proc);
      }
    });
    proc.once("error", (err) => {
      clearTimeout(timer);
      live.delete(proc);
      reject(err);
    });
    proc.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`MCP server exited early (code ${code}).\nstderr:\n${stderr}`));
    });
  });
}

/**
 * Kill the server and its descendants, then AWAIT its exit so the temp DB handle is
 * released before the caller rmSync's the directory.
 */
export async function stopMcpServer(proc: ChildProcess | undefined): Promise<void> {
  if (!proc || proc.pid === undefined) return;
  if (proc.exitCode !== null) {
    live.delete(proc);
    return;
  }
  const exited = new Promise<void>((res) => proc.once("exit", () => res()));
  treeKill(proc.pid);
  await Promise.race([exited, new Promise<void>((res) => setTimeout(res, 5000))]);
  live.delete(proc);
}
