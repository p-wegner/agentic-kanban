// The daemon's half of self-update (#1338): wires `createWorkerUpdater` to a live daemon's
// drain/heartbeat/runner, and owns the post-switch safety net — a freshly-installed build must
// reach the board within a deadline or it rolls the worker back to the build it came from, so
// an update can never leave the worker offline.

import { rmSync } from "node:fs";
import { join } from "node:path";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import { parseBuildId, sameBuild, type WorkerBuildManifest, type WorkerUpdateReport } from "../lib/worker-update.js";
import {
  DEFAULT_CONFIRM_TIMEOUT_MS,
  DEFAULT_KEPT_VERSIONS,
  MAX_UNCONFIRMED_STARTS,
  clearFailure,
  clearPending,
  TransientUpdateError,
  createWorkerUpdater,
  describeFetchError,
  downloadBuild,
  isTransientStatus,
  installBuild,
  pruneVersions,
  readFailure,
  readPending,
  readPointer,
  versionsDirFor,
  writeFailure,
  writePending,
  writePointer,
  type WorkerUpdater,
} from "./worker-updater.js";
import { installShim } from "./worker-shim.js";
import type { UpdateNowResult, WorkerControlStatus } from "./worker-control.js";
import type { WorkerSelfUpdateOptions } from "./worker-daemon.js";

export interface DaemonSelfUpdateDeps {
  opts: WorkerSelfUpdateOptions;
  stateFile: string;
  boardUrl: string;
  workerToken: () => string;
  workerVersion: string | undefined;
  log: (line: string) => void;
  runningCount: () => number;
  /** Let finished sessions' result pushes land before the switch. */
  settle: () => Promise<void>;
  drain: () => Promise<void>;
  undrain: () => Promise<void>;
  /** Test seams. */
  pollMs?: number;
  now?: string;
}

export interface DaemonSelfUpdate {
  updater: WorkerUpdater;
  state(): WorkerUpdateReport;
  /** #1355: ask the board for its current build and update to it now (the local control endpoint). */
  updateNow(): Promise<UpdateNowResult>;
  controlStatus(): WorkerControlStatus;
  /** Feed a heartbeat response body: `{ boardBuildId?, updateNow? }`. */
  onHeartbeatResponse(body: unknown): void;
  /** The first socket to the board opened: a pending switch is confirmed. */
  onConnected(): void;
  /** Startup: count this start against a pending switch, arm its rollback deadline. */
  begin(): void;
  dispose(): void;
}

export function createDaemonSelfUpdate(d: DaemonSelfUpdateDeps): DaemonSelfUpdate {
  const { opts } = d;
  const versionsDir = opts.versionsDir ?? versionsDirFor(d.stateFile);
  const ownBuildId = parseBuildId(d.workerVersion);
  let confirmTimer: ReturnType<typeof setTimeout> | null = null;

  const previousFailure = readFailure(versionsDir);
  const failedBuild =
    previousFailure && !previousFailure.transient && !sameBuild(previousFailure.buildId, ownBuildId)
      ? { buildId: previousFailure.buildId, reason: previousFailure.reason }
      : undefined;

  const rollback = async (reason: string): Promise<void> => {
    const pending = readPending(versionsDir);
    if (!pending) return;
    d.log(`[worker] build ${pending.buildId} did not come up (${reason}); rolling back to the previous build`);
    writeFailure(versionsDir, { buildId: pending.buildId, reason, at: d.now ?? new Date().toISOString(), phase: "no-connect" });
    writePointer(versionsDir, {
      buildId: pending.previousBuildId ?? "previous",
      entry: pending.previousEntry,
    });
    clearPending(versionsDir);
    // The failed install is dead weight, and keeping it would let the supervisor's
    // "newest installed version" rule pick it again.
    try {
      rmSync(join(versionsDir, pending.buildId), { recursive: true, force: true });
    } catch {
      /* in use — pruned later */
    }
    await opts.restart(pending.previousEntry);
  };

  async function fetchManifest(): Promise<WorkerBuildManifest | "building"> {
    const url = `${d.boardUrl}/api/workers/build`;
    let res: Response;
    try {
      res = await (opts.fetchImpl ?? fetch)(url, { headers: { authorization: `Bearer ${d.workerToken()}` } });
    } catch (err) {
      throw new TransientUpdateError(`GET ${url} failed: ${describeFetchError(err)}`);
    }
    if (res.status === 202) return "building";
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      const msg = `GET ${url} -> HTTP ${res.status}${body.error ? ` (${body.error})` : ""}`;
      // 5xx = the board is starting / restarting / cannot pack right now: worth retrying.
      throw isTransientStatus(res.status) ? new TransientUpdateError(msg) : new Error(msg);
    }
    return (await res.json()) as WorkerBuildManifest;
  }
  /** The build the board last advertised on a heartbeat — the target when its tarball is still packing. */
  let lastBoardBuild: string | undefined;

  const updater = createWorkerUpdater({
    ownBuildId,
    auto: opts.auto,
    log: d.log,
    runningCount: d.runningCount,
    drain: d.drain,
    undrain: d.undrain,
    settle: d.settle,
    pollMs: d.pollMs,
    failedBuild,
    recordFailure: (f) => writeFailure(versionsDir, { ...f, at: d.now ?? new Date().toISOString() }),
    fetchManifest,
    async download(manifest) {
      const destFile = join(versionsDir, "downloads", `${manifest.buildId}.tgz`);
      await downloadBuild({
        boardUrl: d.boardUrl,
        workerToken: d.workerToken(),
        manifest,
        destFile,
        fetchImpl: opts.fetchImpl,
        log: d.log,
      });
      return destFile;
    },
    async install(manifest, tarball) {
      const startedMs = Date.now();
      try {
        const entry = await installBuild({ versionsDir, buildId: manifest.buildId, tarball, npm: opts.npm });
        d.log(`[worker] update to build ${manifest.buildId}: npm install ${Math.round((Date.now() - startedMs) / 1000)}s`);
        return entry;
      } finally {
        try {
          rmSync(tarball, { force: true });
        } catch {
          /* best effort */
        }
      }
    },
    activate(manifest, entry) {
      const current = readPointer(versionsDir);
      writePointer(versionsDir, {
        buildId: manifest.buildId,
        entry,
        previousBuildId: ownBuildId,
        previousEntry: opts.entry,
      });
      writePending(versionsDir, {
        buildId: manifest.buildId,
        previousEntry: opts.entry,
        ...(ownBuildId ? { previousBuildId: ownBuildId } : {}),
        startedAt: d.now ?? new Date().toISOString(),
        attempts: 0,
      });
      clearFailure(versionsDir);
      // #1350: (re)write the stable launcher beside the state file so the restart path is
      // available even where the global install predates delegation.
      installShim({ stateFile: d.stateFile, fallbackEntry: opts.entry, fallbackVersion: d.workerVersion ?? null });
      const pruned = pruneVersions(versionsDir, opts.keepVersions ?? DEFAULT_KEPT_VERSIONS, [
        manifest.buildId,
        ownBuildId,
        current?.buildId,
        current?.previousBuildId,
      ]);
      if (pruned.length > 0) d.log(`[worker] pruned old version(s): ${pruned.join(", ")}`);
    },
    restart: opts.restart,
  });

  return {
    updater,
    state: () => updater.state(),
    onHeartbeatResponse(body) {
      if (typeof body !== "object" || body === null) return;
      const rec = body as { boardBuildId?: unknown; updateNow?: unknown };
      if (typeof rec.boardBuildId === "string") lastBoardBuild = rec.boardBuildId;
      updater.onBoardBuild(typeof rec.boardBuildId === "string" ? rec.boardBuildId : undefined, rec.updateNow === true);
    },
    async updateNow() {
      const from = ownBuildId;
      let to: string | undefined;
      try {
        const manifest = await fetchManifest();
        to = manifest === "building" ? lastBoardBuild : manifest.buildId;
      } catch (err) {
        return { result: "failed", from, phase: "manifest", reason: errorMessage(err) };
      }
      if (!to) {
        return { result: "failed", from, phase: "manifest", reason: "the board is still building its worker tarball and has not advertised a build id yet; retry in a minute" };
      }
      const outcome = updater.requestUpdate(to);
      if (outcome === "failed") {
        const s = updater.state();
        return { result: "failed", from, to, phase: "start", reason: s.reason ?? "could not start the update" };
      }
      return { result: outcome, from, to };
    },
    controlStatus() {
      return {
        pid: process.pid,
        boardUrl: d.boardUrl,
        workerVersion: d.workerVersion,
        update: updater.state(),
        failurePhase: readFailure(versionsDir)?.phase,
      };
    },
    onConnected() {
      if (confirmTimer) {
        clearTimeout(confirmTimer);
        confirmTimer = null;
      }
      const pending = readPending(versionsDir);
      if (!pending || !sameBuild(pending.buildId, ownBuildId)) return;
      clearPending(versionsDir);
      clearFailure(versionsDir);
      d.log(`[worker] update confirmed: build ${pending.buildId} is connected to the board`);
    },
    begin() {
      const pending = readPending(versionsDir);
      if (!pending || !sameBuild(pending.buildId, ownBuildId)) return;
      const attempts = pending.attempts + 1;
      writePending(versionsDir, { ...pending, attempts });
      if (attempts > MAX_UNCONFIRMED_STARTS) {
        // The supervisor restarts a crashing build forever; this is the in-process half of the
        // same guard (ak-worker-run.ps1 has the other) for the starts that DO reach this line.
        void rollback(`started ${attempts - 1} times without ever connecting`).catch((err: unknown) => {
          d.log(`[worker] rollback failed: ${errorMessage(err)}`);
        });
        return;
      }
      const deadline = opts.confirmTimeoutMs ?? DEFAULT_CONFIRM_TIMEOUT_MS;
      confirmTimer = setTimeout(() => {
        confirmTimer = null;
        void rollback(`the new build did not connect to the board within ${Math.round(deadline / 1000)}s`).catch((err: unknown) => {
          d.log(`[worker] rollback failed: ${errorMessage(err)}`);
        });
      }, deadline);
      if (confirmTimer.unref) confirmTimer.unref();
    },
    dispose() {
      if (confirmTimer) clearTimeout(confirmTimer);
      confirmTimer = null;
    },
  };
}
