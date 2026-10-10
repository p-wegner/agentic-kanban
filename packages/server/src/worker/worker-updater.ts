// Worker self-update (#1338): fetch the board's worker build, install it SIDE BY SIDE, restart.
//
// Db-free on purpose — this module is part of the standalone `agentic-kanban-worker` binary
// (worker-cli-isolation.test.ts). It splits in two:
//
//  * the FILE/NET helpers (download + sha256 verify, install into a versioned directory, the
//    on-disk pointers, pruning, relaunch) — each small and individually testable;
//  * `createWorkerUpdater`, the orchestration (drain → wait for sessions → fetch → install →
//    switch → restart, rolling back on ANY failure) over injected deps, so the ordering rules
//    the ticket cares about are testable without a daemon, a network or a process exit.
//
// Why a versioned directory and not `npm i -g` over the running package: on Windows the files
// of the package the daemon runs from are in use, so a global reinstall fails or half-installs
// (the ticket's "install trap"). `<worker-home>/versions/<build>` is a fresh prefix nothing is
// running from; the daemon then relaunches FROM it and the previous version stays for rollback.

import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import {
  WORKER_UPDATE_EXIT_CODE,
  buildRelaunchCommand,
  sameBuild,
  type WorkerBuildManifest,
  type WorkerUpdateReport,
} from "../lib/worker-update.js";

/** How many installed versions to keep besides the two that are protected (current + previous). */
export const DEFAULT_KEPT_VERSIONS = 3;
/** How long a freshly-switched build gets to connect to the board before it rolls itself back. */
export const DEFAULT_CONFIRM_TIMEOUT_MS = 120 * 1000;
/** A switched build that restarts this many times without ever connecting is rolled back. */
export const MAX_UNCONFIRMED_STARTS = 3;

export class BuildChecksumError extends Error {
  constructor(expected: string, actual: string) {
    super(`checksum mismatch: the board advertised sha256 ${expected} but the download hashed to ${actual}`);
    this.name = "BuildChecksumError";
  }
}

import { entryForBuild, removeQuietly } from "./worker-versions.js";
export * from "./worker-versions.js";


// --- download + install ----------------------------------------------------------------------

export interface DownloadOptions {
  boardUrl: string;
  workerToken: string;
  manifest: WorkerBuildManifest;
  destFile: string;
  fetchImpl?: typeof fetch;
}

/**
 * Stream the board's tarball to `destFile` and verify it against the manifest's sha256 (and
 * size). A mismatch DELETES the file and throws `BuildChecksumError` — a corrupt or tampered
 * archive is never handed to npm.
 */
export async function downloadBuild(opts: DownloadOptions): Promise<void> {
  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch(`${opts.boardUrl.replace(/\/+$/, "")}/api/workers/build/tarball`, {
    headers: { authorization: `Bearer ${opts.workerToken}` },
  });
  if (!res.ok || !res.body) throw new Error(`tarball download failed: HTTP ${res.status}`);
  mkdirSync(dirname(opts.destFile), { recursive: true });
  const hash = createHash("sha256");
  let size = 0;
  const source = Readable.fromWeb(res.body as unknown as import("node:stream/web").ReadableStream<Uint8Array>);
  source.on("data", (chunk: Buffer) => {
    hash.update(chunk);
    size += chunk.length;
  });
  try {
    await pipeline(source, createWriteStream(opts.destFile));
  } catch (err) {
    removeQuietly(opts.destFile);
    throw new Error(`tarball download interrupted: ${errorMessage(err)}`);
  }
  const actual = hash.digest("hex");
  if (actual.toLowerCase() !== opts.manifest.sha256.toLowerCase()) {
    removeQuietly(opts.destFile);
    throw new BuildChecksumError(opts.manifest.sha256, actual);
  }
  if (opts.manifest.size > 0 && size !== opts.manifest.size) {
    removeQuietly(opts.destFile);
    throw new Error(`size mismatch: the board advertised ${opts.manifest.size} bytes, received ${size}`);
  }
}

export type NpmRunner = (args: string[], cwd: string) => Promise<void>;

/** `npm` is a .cmd shim on Windows, which execFile cannot spawn without a shell. */
export const runNpm: NpmRunner = (args, cwd) =>
  new Promise((resolve, reject) => {
    const win = process.platform === "win32";
    const quoted = win ? args.map((a) => (/\s/.test(a) ? `"${a}"` : a)) : args;
    execFile(
      "npm",
      quoted,
      { cwd, windowsHide: true, shell: win, timeout: 10 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 },
      (err, _stdout, stderr) => {
        if (err) reject(new Error(`npm ${args[0]} failed: ${(stderr || err.message).toString().trim().split("\n").slice(-5).join(" | ")}`));
        else resolve();
      },
    );
  });

/**
 * Install the verified tarball into `<versionsDir>/<buildId>` (a fresh prefix — nothing is
 * running from it) and return the entry to relaunch on. A half-finished prefix from an earlier
 * failed attempt is wiped first, and removed again if THIS install fails.
 */
export async function installBuild(opts: {
  versionsDir: string;
  buildId: string;
  tarball: string;
  npm?: NpmRunner;
}): Promise<string> {
  const prefix = join(opts.versionsDir, opts.buildId);
  rmSync(prefix, { recursive: true, force: true });
  mkdirSync(prefix, { recursive: true });
  try {
    await (opts.npm ?? runNpm)(["install", "--prefix", prefix, "--no-audit", "--no-fund", "--loglevel=error", opts.tarball], prefix);
    const entry = entryForBuild(opts.versionsDir, opts.buildId);
    if (!existsSync(entry)) throw new Error(`installed package has no worker entry at ${entry}`);
    return entry;
  } catch (err) {
    rmSync(prefix, { recursive: true, force: true });
    throw err;
  }
}

/** Remove installed versions beyond `keep` (newest first by mtime), never a protected build. */
export function pruneVersions(versionsDir: string, keep: number, protect: readonly (string | undefined)[]): string[] {
  const removed: string[] = [];
  let names: string[];
  try {
    names = readdirSync(versionsDir, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name !== "downloads").map((d) => d.name);
  } catch {
    return removed;
  }
  const dated = names
    .map((name) => ({ name, mtime: statSync(join(versionsDir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  const protectedIds = protect.filter((p): p is string => !!p);
  let kept = 0;
  for (const { name } of dated) {
    const isProtected = protectedIds.some((p) => sameBuild(p, name));
    if (isProtected || kept < keep) {
      kept += 1;
      continue;
    }
    try {
      rmSync(join(versionsDir, name), { recursive: true, force: true });
      removed.push(name);
    } catch {
      /* in use (Windows) — pruned on a later update */
    }
  }
  return removed;
}

// --- restart ---------------------------------------------------------------------------------

/** True when ak-worker-run.ps1 launched this process: it relaunches us after exit code 75. */
export function isSupervised(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.KANBAN_WORKER_SUPERVISED === "1";
}

export interface RelaunchDeps {
  argv: readonly string[];
  execPath: string;
  supervised: boolean;
  spawnImpl?: typeof spawn;
  exit: (code: number) => void;
}

/**
 * Hand over to `entry`. Supervised: exit with the dedicated code and let the supervisor start
 * the new build. Unsupervised: spawn it detached + hidden with the original argv minus
 * `--token`, then exit. Returns the command it spawned (undefined when supervised).
 */
export function relaunchWorker(entry: string, deps: RelaunchDeps): { command: string; args: string[] } | undefined {
  if (deps.supervised) {
    deps.exit(WORKER_UPDATE_EXIT_CODE);
    return undefined;
  }
  const cmd = buildRelaunchCommand(deps.argv, entry, deps.execPath);
  const child = (deps.spawnImpl ?? spawn)(cmd.command, cmd.args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: process.env,
  });
  child.unref();
  deps.exit(0);
  return cmd;
}

// --- orchestration ---------------------------------------------------------------------------

export type ManifestResult = WorkerBuildManifest | "building";

export interface WorkerUpdaterDeps {
  /** This build's commit id; undefined = an unstamped build, which never self-updates. */
  ownBuildId: string | undefined;
  /** Opt-in (`--auto-update`): act on an advertised build without being asked. */
  auto: boolean;
  log: (line: string) => void;
  /** Sessions this daemon is still running. */
  runningCount: () => number;
  /** Stop being a placement candidate (and refuse `assign`). */
  drain: () => Promise<void>;
  /** Back in rotation — a failed update must never leave the worker out of it. */
  undrain: () => Promise<void>;
  /** Runs once no session is running: let finished sessions' result pushes land first. */
  settle?: () => Promise<void>;
  fetchManifest: () => Promise<ManifestResult>;
  download: (manifest: WorkerBuildManifest) => Promise<string>;
  install: (manifest: WorkerBuildManifest, tarball: string) => Promise<string>;
  /** Persist the switch (pointer + pending marker). Throws → treated as an install failure. */
  activate: (manifest: WorkerBuildManifest, entry: string) => void;
  restart: (entry: string) => void | Promise<void>;
  /** Called on every state change so the next heartbeat carries it. */
  onState?: (report: WorkerUpdateReport) => void;
  sleep?: (ms: number) => Promise<void>;
  /** How often to re-check for the last session finishing. */
  pollMs?: number;
  /** How long to wait for the board to finish packing the build. */
  manifestWaitMs?: number;
  /** A build id a previous attempt already failed on — not retried automatically. */
  failedBuild?: { buildId: string; reason: string };
}

export interface WorkerUpdater {
  /** The board's advertised build id, from a heartbeat. `force` = a board-side `worker update`. */
  onBoardBuild(buildId: string | undefined, force?: boolean): void;
  state(): WorkerUpdateReport;
  /** Resolves when no update attempt is in flight (tests, graceful shutdown). */
  idle(): Promise<void>;
}

export function createWorkerUpdater(deps: WorkerUpdaterDeps): WorkerUpdater {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollMs = deps.pollMs ?? 2000;
  const manifestWaitMs = deps.manifestWaitMs ?? 15 * 60 * 1000;
  let report: WorkerUpdateReport = deps.failedBuild
    ? { state: "failed", reason: deps.failedBuild.reason, targetBuild: deps.failedBuild.buildId }
    : { state: "current" };
  let failedFor: string | undefined = deps.failedBuild?.buildId;
  let inFlight: Promise<void> | null = null;
  let warnedUnstamped = false;

  const set = (next: WorkerUpdateReport): void => {
    report = next;
    deps.onState?.(next);
  };

  async function waitForIdle(target: string): Promise<void> {
    for (;;) {
      const running = deps.runningCount();
      if (running === 0) return;
      set({ state: "updating", reason: `waiting for ${running} running session(s) to finish`, targetBuild: target });
      await sleep(pollMs);
    }
  }

  async function waitForManifest(): Promise<WorkerBuildManifest> {
    const deadline = manifestWaitMs;
    let waited = 0;
    for (;;) {
      const result = await deps.fetchManifest();
      if (result !== "building") return result;
      if (waited >= deadline) throw new Error(`the board did not finish building its worker tarball within ${Math.round(deadline / 1000)}s`);
      await sleep(pollMs);
      waited += pollMs;
    }
  }

  async function run(target: string): Promise<void> {
    set({ state: "updating", reason: "draining", targetBuild: target });
    deps.log(`[worker] update to build ${target}: draining (the board stops assigning; running sessions finish first)`);
    let drained = false;
    try {
      await deps.drain();
      drained = true;
      await waitForIdle(target);
      await deps.settle?.();
      set({ state: "updating", reason: "fetching the board's build", targetBuild: target });
      const manifest = await waitForManifest();
      set({ state: "updating", reason: "downloading", targetBuild: target });
      const tarball = await deps.download(manifest);
      set({ state: "updating", reason: "installing", targetBuild: target });
      const entry = await deps.install(manifest, tarball);
      deps.activate(manifest, entry);
      set({ state: "updating", reason: "restarting on the new build", targetBuild: target });
      deps.log(`[worker] update to build ${manifest.buildId}: installed, restarting`);
      await deps.restart(entry);
    } catch (err) {
      const reason = errorMessage(err);
      failedFor = target;
      set({ state: "failed", reason, targetBuild: target });
      deps.log(`[worker] update to build ${target} FAILED (staying on the current build): ${reason}`);
      if (drained) {
        try {
          await deps.undrain();
        } catch (undrainErr) {
          deps.log(`[worker] could not leave draining after the failed update: ${errorMessage(undrainErr)}`);
        }
      }
    }
  }

  return {
    onBoardBuild(buildId, force = false) {
      if (inFlight) return;
      if (!buildId || sameBuild(buildId, deps.ownBuildId)) {
        if (report.state === "failed" && report.targetBuild && sameBuild(report.targetBuild, deps.ownBuildId)) {
          set({ state: "current" });
        }
        return;
      }
      if (!deps.ownBuildId) {
        if (force || deps.auto) {
          if (!warnedUnstamped) {
            warnedUnstamped = true;
            deps.log("[worker] cannot self-update: this build carries no commit stamp (not from scripts/pack-worker.mjs)");
          }
          set({ state: "failed", reason: "this build is not stamped with a commit id, so it cannot tell it is behind", targetBuild: buildId });
        }
        return;
      }
      if (!force && !deps.auto) return;
      // A build that already failed here is retried only when explicitly asked: re-trying a
      // broken download every 30 s forever is the loop this guards against.
      if (!force && failedFor && sameBuild(failedFor, buildId)) return;
      inFlight = run(buildId).finally(() => {
        inFlight = null;
      });
    },
    state: () => report,
    idle: () => inFlight ?? Promise.resolve(),
  };
}
