// The board's own worker build, served to workers (#1338, subsumes #1327).
//
// `GET /api/workers/build` (manifest) and `GET /api/workers/build/tarball` hand a paired worker
// the exact tarball `scripts/pack-worker.mjs` would produce from THIS board's tree, so a worker
// that updates from it always matches the board. It is built ONCE per board commit and cached
// under `<data-dir>/worker-builds/<sha>/`; concurrent requests share one in-flight build, and a
// failed build is reported (not retried in a tight loop — the next request after the failure
// window tries again).
//
// The build id is the commit sha. A dirty tree is NOT distinguished: uncommitted edits do not
// change the id, so the cached tarball reflects the commit — commit before you expect a worker
// to pick it up. A board without a source checkout (an npm-installed board has no
// `scripts/pack-worker.mjs`) answers "unavailable" with the reason instead of pretending.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gitExec } from "@agentic-kanban/shared/lib/git-exec";
import { WORKER_PROTOCOL_VERSION } from "@agentic-kanban/shared/lib/worker-protocol";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import { resolveOwnPackageVersion } from "../lib/worker-build.js";
import { parseBuildId, sameBuild, type WorkerBuildManifest } from "../lib/worker-update.js";

/** How long after a failed build before the next request may try again. */
export const BUILD_FAILURE_RETRY_MS = 60 * 1000;

export type WorkerBuildLookup =
  | { state: "ready"; manifest: WorkerBuildManifest; tarballPath: string }
  | { state: "building" }
  | { state: "unavailable"; reason: string };

export interface PackResult {
  tarball: string;
  version: string;
}

export interface WorkerBuildService {
  /** The commit a worker would be updated to, or null when the board has no source tree. */
  currentBuildId(): Promise<string | null>;
  /** The cached build for the current commit — starting one (once) when there is none. */
  getBuild(): Promise<WorkerBuildLookup>;
  /** Start packing the current commit before any worker asks (#1352). Never throws. */
  prewarm(): Promise<void>;
}

export interface WorkerBuildServiceDeps {
  /** The board's source checkout, or null (no `scripts/pack-worker.mjs`). */
  repoRoot: string | null;
  cacheDir: string;
  /** Test seam: the commit sha. Defaults to `git rev-parse HEAD` in `repoRoot`. */
  resolveBuildId?: () => Promise<string | null>;
  /** Test seam: produce the tarball into `outDir`. Defaults to running scripts/pack-worker.mjs. */
  pack?: (outDir: string) => Promise<PackResult>;
  /** Test seam for the retry window after a failed build. */
  nowMs?: number;
}

/** The nearest ancestor of this module holding `scripts/pack-worker.mjs`, else null. */
export function findBoardRepoRoot(startDir: string = dirname(fileURLToPath(import.meta.url))): string | null {
  let dir = startDir;
  for (let up = 0; up < 8; up++) {
    if (existsSync(join(dir, "scripts", "pack-worker.mjs"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function sha256File(file: string): Promise<string> {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolveHash(hash.digest("hex")))
      .on("error", reject);
  });
}

function runPackScript(repoRoot: string, outDir: string): Promise<PackResult> {
  const skipBuild = process.env.KANBAN_WORKER_BUILD_SKIP_BUILD === "1";
  const args = [join(repoRoot, "scripts", "pack-worker.mjs"), "--out-dir", outDir, "--json", ...(skipBuild ? ["--skip-build"] : [])];
  return new Promise((resolvePack, reject) => {
    execFile(
      process.execPath,
      args,
      { cwd: repoRoot, windowsHide: true, timeout: 20 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`pack-worker failed: ${(stderr || err.message).toString().trim().split("\n").slice(-4).join(" | ")}`));
          return;
        }
        const line = stdout.toString().split("\n").find((l) => l.startsWith("[pack-worker-json] "));
        if (!line) {
          reject(new Error("pack-worker produced no result line"));
          return;
        }
        try {
          resolvePack(JSON.parse(line.slice("[pack-worker-json] ".length)) as PackResult);
        } catch (parseErr) {
          reject(new Error(`pack-worker result unreadable: ${errorMessage(parseErr)}`));
        }
      },
    );
  });
}

export function createWorkerBuildService(deps: WorkerBuildServiceDeps): WorkerBuildService {
  const { repoRoot, cacheDir } = deps;
  let inFlight: { buildId: string; promise: Promise<void> } | null = null;
  let lastFailure: { buildId: string; reason: string; atMs: number } | null = null;

  async function currentBuildId(): Promise<string | null> {
    if (deps.resolveBuildId) return deps.resolveBuildId();
    if (!repoRoot) return null;
    const result = await gitExec(["rev-parse", "HEAD"], { cwd: repoRoot });
    const sha = result.stdout.trim();
    return result.error || !/^[0-9a-f]{40}$/i.test(sha) ? null : sha.toLowerCase();
  }

  function readCached(buildId: string): { manifest: WorkerBuildManifest; tarballPath: string } | null {
    const dir = join(cacheDir, buildId);
    try {
      const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as WorkerBuildManifest;
      const tarballPath = join(dir, "worker.tgz");
      if (manifest.buildId !== buildId || !existsSync(tarballPath)) return null;
      return { manifest, tarballPath };
    } catch {
      return null;
    }
  }

  async function build(buildId: string): Promise<void> {
    const dir = join(cacheDir, buildId);
    const packDir = join(dir, "pack");
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(packDir, { recursive: true });
    const packed = await (deps.pack ? deps.pack(packDir) : runPackScript(repoRoot!, packDir));
    // The stamped version carries the sha pack-worker saw. If HEAD moved while it built, this
    // tarball is not the commit we are about to advertise — refuse rather than serve a mismatch.
    const stamped = parseBuildId(packed.version);
    if (stamped && !sameBuild(stamped, buildId)) {
      throw new Error(`the tree moved while packing (packed ${stamped}, expected ${buildId.slice(0, 7)}); will retry`);
    }
    const tarballPath = join(dir, "worker.tgz");
    renameSync(packed.tarball, tarballPath);
    const manifest: WorkerBuildManifest = {
      version: packed.version,
      buildId,
      sha256: await sha256File(tarballPath),
      size: statSync(tarballPath).size,
      boardWorkerVersion: resolveOwnPackageVersion() ?? null,
      protocolVersion: WORKER_PROTOCOL_VERSION,
    };
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
    rmSync(packDir, { recursive: true, force: true });
    pruneCache(buildId);
  }

  /** Keep the three newest builds; a board that lives for months must not hoard tarballs. */
  function pruneCache(keepId: string): void {
    try {
      const dirs = readdirSync(cacheDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => ({ name: d.name, mtime: statSync(join(cacheDir, d.name)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      for (const { name } of dirs.slice(3)) {
        if (name !== keepId) rmSync(join(cacheDir, name), { recursive: true, force: true });
      }
    } catch {
      /* best effort */
    }
  }

  async function getBuild(): Promise<WorkerBuildLookup> {
    if (!deps.pack && !repoRoot) {
      return { state: "unavailable", reason: "this board has no source checkout (scripts/pack-worker.mjs), so it cannot build a worker tarball" };
    }
    const buildId = await currentBuildId();
    if (!buildId) return { state: "unavailable", reason: "could not determine the board's commit" };
    const cached = readCached(buildId);
    if (cached) return { state: "ready", ...cached };
    // ONE pack at a time, even when HEAD moved mid-build: pack-worker rewrites package.json and
    // runs the build in the board's own tree, so two overlapping runs corrupt each other (the
    // second can capture the first's stamped version as the "original" and leave it behind).
    // The stale build fails its own sha check; the next request starts the current commit.
    if (inFlight) return { state: "building" };
    const nowMs = deps.nowMs ?? Date.now();
    if (lastFailure && lastFailure.buildId === buildId && nowMs - lastFailure.atMs < BUILD_FAILURE_RETRY_MS) {
      return { state: "unavailable", reason: `the last build failed: ${lastFailure.reason}` };
    }
    const startedMs = Date.now();
    const promise = build(buildId)
      .then(() => {
        lastFailure = null;
        const ready = readCached(buildId);
        const size = ready ? formatBytes(ready.manifest.size) : "?";
        console.log(`[worker-build] worker build ${buildId.slice(0, 7)} ready in ${Math.round((Date.now() - startedMs) / 1000)}s (${size})`);
      })
      .catch((err: unknown) => {
        lastFailure = { buildId, reason: errorMessage(err), atMs: deps.nowMs ?? Date.now() };
        console.warn(`[worker-build] build for ${buildId.slice(0, 7)} failed: ${lastFailure.reason}`);
      })
      .finally(() => {
        if (inFlight?.buildId === buildId) inFlight = null;
      });
    inFlight = { buildId, promise };
    console.log(`[worker-build] building the worker tarball for ${buildId.slice(0, 7)} (once per commit)`);
    return { state: "building" };
  }

  /**
   * #1352: start packing the current commit NOW (boot / a new HEAD) instead of on the first
   * worker request, which left the worker draining behind a 202 for minutes. A no-op when the
   * build is cached or already in flight; never throws (a failure is logged by `getBuild`).
   */
  async function prewarm(): Promise<void> {
    try {
      await getBuild();
    } catch (err) {
      console.warn(`[worker-build] prewarm failed: ${errorMessage(err)}`);
    }
  }

  return { currentBuildId, getBuild, prewarm };
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/** Re-check the board's commit on an interval and pack a new one eagerly. Returns the stopper. */
export function startWorkerBuildPrewarm(service: WorkerBuildService, intervalMs = 60_000, firstDelayMs = 10_000): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const tick = (): void => {
    void service.prewarm().finally(() => {
      if (stopped) return;
      timer = setTimeout(tick, intervalMs);
      timer.unref?.();
    });
  };
  timer = setTimeout(tick, firstDelayMs);
  timer.unref?.();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

let singleton: WorkerBuildService | null = null;

/** The board's process-wide service, cached under `<data-dir>/worker-builds`. */
export async function getWorkerBuildService(): Promise<WorkerBuildService> {
  if (!singleton) {
    const { DATA_DIR } = await import("../db/data-dir.js");
    singleton = createWorkerBuildService({
      repoRoot: findBoardRepoRoot(),
      cacheDir: resolve(DATA_DIR, "worker-builds"),
    });
  }
  return singleton;
}
