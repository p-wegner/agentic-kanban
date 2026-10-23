// The board half of running verify jobs on a fleet worker (#1437): implements #1430's
// `VerifyWorkerRunner` seam over the worker WebSocket. `verify-placement.ts` decides WHETHER a chain
// goes to a worker and whether a verdict is believed; this file is only the transport — send a
// `verify_job`, follow its `verify_progress`, assemble the `verify_log_chunk`s, hand back ONE report.
//
// It never decides trust: the caller feeds the report through `acceptWorkerVerdict`, which judges it
// against the request the BOARD built (sha, tier, worker), not against anything in the frame. This
// service also never invents a verdict: a worker that vanishes or goes silent yields a refusal.
import { noteMergeTrainGateProgress, noteMergeTrainGateResultReceived } from "./merge-train-live-registry.js";
import { workerBelowRamFloor } from "@agentic-kanban/shared/lib/worker-settings";
import type { VerifyJobFrame, VerifyStage, WorkerVerifyCapability } from "@agentic-kanban/shared/lib/worker-verify-protocol";
import { writeFileSync } from "node:fs";
import type { Database } from "../db/index.js";
import { verifyLogPath } from "./verify-failure-summary.js";
import { listActiveMergeTrainsForProject, recordMergeTrainWorkerVerify } from "../repositories/merge-train.repository.js";
import { getProjectSetupScript } from "../repositories/stack-profile.repository.js";
import { ensureGitHttpServer } from "./git-http.service.js";
import type { VerifyRunRequest, VerifyWorkerRunner } from "./verify-job-placement.js";
import { isTimeoutOnlyFailure, workerAdmitsAnotherChain, workerWasAtCapacity, type VerifyChainKind, type VerifyWorkerCandidate, type WorkerVerifyReport } from "./verify-placement.js";
import { active, listActiveVerifyJobs, type ActiveVerifyJob } from "./verify-active-jobs.js";
import { getWorkerFleet } from "./worker-fleet.service.js";
import { isWorkerBuildStale } from "./worker-auto-update.service.js";

export { listActiveVerifyJobs, type ActiveVerifyJob } from "./verify-active-jobs.js";

/** How long past the script's own timeout the board waits for a worker's result before refusing. */
const RESULT_GRACE_MS = 10 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 45 * 60 * 1000;
/** #1465: how long a placed job survives its worker's socket being down (a 1 s blip must not cost a 65 min sweep). */
export const VERIFY_RECONNECT_GRACE_MS = 2 * 60 * 1000;

export interface VerifyRunnerDeps {
  database: Database;
  /** Injected for tests; defaults to the board's fleet singleton. */
  fleet?: Pick<ReturnType<typeof getWorkerFleet>, "registry"> & {
    connections: Omit<ReturnType<typeof getWorkerFleet>["connections"], "onConnect"> & { onConnect?: ReturnType<typeof getWorkerFleet>["connections"]["onConnect"] };
  };
  /** Injected for tests; defaults to a read-only token on the board's git transport. */
  issueGitAuth?: (input: { workerId: string; projectId: string; jobId: string }) => Promise<{ gitPort: number; gitToken: string }>;
  /** Injected for tests; the project's setup script. */
  readSetupScript?: (projectId: string) => Promise<string | null>;
  nowMs?: number;
  /** #1465: injected for tests; defaults to VERIFY_RECONNECT_GRACE_MS. */
  reconnectGraceMs?: number;
  /** #1571: injected for tests; where failed-output logs go (defaults to the OS temp dir). */
  logDir?: string;
}

const LOGGED_SUITE_CAP = 10;

/** #1544: ` [a, b, … +N more]` for the verify_result log line; empty when no suite was named. Pure. */
export function describeFailingSuites(suites: readonly string[] | undefined): string {
  if (!suites || suites.length === 0) return "";
  const shown = suites.slice(0, LOGGED_SUITE_CAP).join(", ");
  return ` [${shown}${suites.length > LOGGED_SUITE_CAP ? `, … +${suites.length - LOGGED_SUITE_CAP} more` : ""}]`;
}

const FAILED_LOG_TAIL_BYTES = 64 * 1024;
const EVIDENCE_TAIL_LINES = 40;
// eslint-disable-next-line no-control-regex -- ESC is the point
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/**
 * #1571: persist a failed worker verdict's output tail (last 64 KB, ANSI stripped) to a PER-ATTEMPT file
 * (`kanban-verify-worker-<kind>-<jobId>.log`; the job id is unique per attempt, so a retry never overwrites
 * it). Returns the path plus the last ~40 lines for the evidence row; never throws.
 */
export function persistFailedWorkerLog(kind: string, jobId: string, log: string, dir?: string): { logPath: string | null; tailLines: string } {
  const clean = log.replace(ANSI_RE, "");
  const tailLines = clean.split(/\r?\n/).filter((l, i, all) => l.trim() || i < all.length - 1).slice(-EVIDENCE_TAIL_LINES).join("\n");
  let logPath: string | null = null;
  try {
    logPath = verifyLogPath(`worker-${kind}-${jobId}`, dir);
    writeFileSync(logPath, clean.slice(-FAILED_LOG_TAIL_BYTES), "utf8");
  } catch (err) {
    logPath = null;
    console.warn(`[verify-worker] could not write the failed-verify log (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  }
  return { logPath, tailLines };
}

/** #1544: stamp a red worker verdict on the project's live (gating) train row; never throws. */
async function persistTrainWorkerVerify(database: Database, projectId: string, entry: Record<string, unknown>): Promise<void> {
  try {
    const live = await listActiveMergeTrainsForProject(projectId, ["gating"], database);
    for (const train of live) await recordMergeTrainWorkerVerify(train.id, entry, database);
  } catch (err) {
    console.warn(`[verify-worker] could not persist failing suites on the train row (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** #1456: on an auto worker verify jobs share the session budget: sessions + verify jobs <= derived slots. */
function budgetSlots(w: { maxConcurrency: number; concurrency?: { mode: string } }, sessions: () => number, inFlight: number): number[] {
  if (w.concurrency?.mode !== "auto") return [];
  return [w.maxConcurrency - sessions() - inFlight];
}

export function createVerifyWorkerRunner(deps: VerifyRunnerDeps): VerifyWorkerRunner {
  const fleet = () => deps.fleet ?? getWorkerFleet(deps.database);

  async function listWorkers(): Promise<VerifyWorkerCandidate[]> {
    const { registry, connections } = fleet();
    const views = await registry.listWorkersView();
    return views
      .filter((w) => w.effectiveStatus === "online" && connections.isConnected(w.id) && w.verify)
      // #1451: under its own minFreeRamGb floor a worker takes no new verify job
      .filter((w) => !workerBelowRamFloor(w.desiredSettings?.settings, w.capacity?.freeRamGb).below)
      // #1456: an auto worker in live back-off takes no new verify job either
      .filter((w) => !w.concurrency?.hold)
      .map((w) => {
        const cap = w.verify as WorkerVerifyCapability;
        const inFlight = listActiveVerifyJobs().filter((j) => j.workerId === w.id).length;
        const freeRamGb = w.capacity?.freeRamGb ?? cap.ramGb;
        // #1589: the host's RAM admission, applied here: a worker already running a chain needs RAM for another.
        const busy = Math.max(inFlight, cap.slots - cap.freeSlots);
        const ramAdmits = workerAdmitsAnotherChain(busy, w.capacity?.freeRamGb);
        return {
          id: w.id,
          name: w.name,
          // Our own in-flight count wins over a heartbeat that predates the job's first frame.
          freeSlots: ramAdmits ? Math.max(0, Math.min(cap.freeSlots, cap.slots - inFlight, ...budgetSlots(w, () => connections.assignedSessionIds(w.id).length, inFlight))) : 0,
          freeRamGb,
          thrashing: w.capacity ? w.capacity.thrashing !== "none" : undefined,
          builderSessions: connections.assignedSessionIds?.(w.id).length ?? 0,
          buildStale: isWorkerBuildStale(w.workerVersion),
        };
      });
  }

  async function run(req: VerifyRunRequest): Promise<WorkerVerifyReport> {
    const { connections, registry } = fleet();
    const jobId = req.requestId;
    const refuse = (reason: string, refused = "worker_unreachable"): WorkerVerifyReport => ({
      requestId: req.requestId, workerId: req.workerId, sha: "", tier: req.tier, passed: false, refused, reason,
    });
    if (!req.projectId) return refuse("the job carries no project to fetch from", "fetch_failed");
    const workerName = (await registry.listWorkersView()).find((w) => w.id === req.workerId)?.name ?? req.workerId;
    const auth = await (deps.issueGitAuth ?? defaultIssueGitAuth(deps.database))({ workerId: req.workerId, projectId: req.projectId, jobId }).catch(() => null);
    if (!auth) return refuse("could not issue a git credential for the worker", "fetch_failed");
    const setupScript = await (deps.readSetupScript ?? ((id: string) => getProjectSetupScript(id, deps.database)))(req.projectId).catch(() => null);
    const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const job: ActiveVerifyJob = {
      jobId, workerId: req.workerId, workerName, kind: req.kind, sha: req.sha, tier: req.tier, stage: "queued", startedAt: new Date(deps.nowMs ?? Date.now()).toISOString(),
    };
    // #1589: was this worker over capacity when the chain started (another chain beside it, or RAM under the reserve)?
    const startView = (await registry.listWorkersView()).find((w) => w.id === req.workerId);
    const atCapacity = workerWasAtCapacity(listActiveVerifyJobs().filter((j) => j.workerId === req.workerId).length, startView?.capacity?.freeRamGb);
    active.set(jobId, job);
    const chunks = new Map<number, string>();
    try {
      return await new Promise<WorkerVerifyReport>((resolve) => {
        let off: (() => void) | undefined;
        let offDisconnect: (() => void) | undefined;
        let offConnect: (() => void) | undefined;
        let timer: NodeJS.Timeout | undefined;
        let graceTimer: NodeJS.Timeout | undefined;
        const graceMs = deps.reconnectGraceMs ?? VERIFY_RECONNECT_GRACE_MS;
        const clearGrace = (): void => { if (graceTimer) clearTimeout(graceTimer); graceTimer = undefined; };
        const end = (report: WorkerVerifyReport): void => { req.signal?.removeEventListener("abort", onAbort); off?.(); offDisconnect?.(); offConnect?.(); clearGrace(); if (timer) clearTimeout(timer); resolve(report); };
        // #1489: the owner no longer wants the job (train cancelled/abandoned): tell the worker to kill its tree and drop the checkout.
        const onAbort = (): void => {
          connections.send(req.workerId, { type: "verify_cancel", jobId });
          end(refuse("cancelled: the owner of this verify job stopped waiting", "cancelled"));
        };
        off = connections.onMessage((workerId, message) => {
          if (workerId !== req.workerId || !("jobId" in message) || message.jobId !== jobId) return;
          // #1465: after a reconnect, any frame for this job proves the worker still knows it.
          if (job.reattached) clearGrace();
          if (req.kind === "train-gate" && req.projectId && (message.type === "verify_progress" || message.type === "verify_log_chunk")) noteMergeTrainGateProgress(req.projectId, deps.nowMs);
          if (message.type === "verify_progress") {
            // #1669: a frame carrying a count is authoritative for the total too — absent means "unknown now",
            // not "keep the last one" (that left 581/20). A stage-only frame keeps both; done > total drops the total.
            const filesDone = message.filesDone ?? job.filesDone;
            const filesTotal = message.filesDone !== undefined ? message.filesTotal : (message.filesTotal ?? job.filesTotal);
            Object.assign(job, { stage: message.stage, filesDone, filesTotal: filesTotal !== undefined && filesDone !== undefined && filesDone > filesTotal ? undefined : filesTotal });
          } else if (message.type === "verify_log_chunk") {
            chunks.set(message.seq, message.data);
          } else if (message.type === "verify_result") {
            const log = [...chunks.entries()].sort(([a], [b]) => a - b).map(([, d]) => d).join("") || message.logTail;
            // #1495: the verdict's receipt (placement and refusals were logged, the verdict was not).
            console.log(`[verify-worker] ${req.kind} verify_result from ${workerName} sha ${message.sha.slice(0, 9)}: ${message.refused ? `refused (${message.refused})` : message.passed ? "passed" : "failed"}, ${message.failingSuites?.length ?? 0} failing suite(s)${describeFailingSuites(message.failingSuites)}, ${Math.round((message.durationMs ?? 0) / 1000)}s`);
            // #1571: the output must hit disk BEFORE any retry decision sees the verdict.
            const failed = !message.passed && !message.refused;
            const saved = failed ? persistFailedWorkerLog(req.kind, jobId, log, deps.logDir) : null;
            if (saved?.logPath) console.log(`[verify-worker] failed output of ${jobId} saved to ${saved.logPath}`);
            if (req.kind === "train-gate" && req.projectId) noteMergeTrainGateResultReceived(req.projectId, deps.nowMs);
            if (req.kind === "train-gate" && req.projectId && failed) {
              const suites = message.failingSuites ?? [];
              void persistTrainWorkerVerify(deps.database, req.projectId, {
                workerName, sha: message.sha, failingSuites: suites, durationMs: message.durationMs ?? 0, at: new Date(deps.nowMs ?? Date.now()).toISOString(),
                ...(saved?.logPath ? { logPath: saved.logPath } : {}),
                ...(suites.length === 0 && saved?.tailLines ? { outputTail: saved.tailLines } : {}),
              });
            }
            end({
              requestId: req.requestId,
              workerId: req.workerId,
              sha: message.sha,
              tier: message.tier,
              passed: message.passed,
              log,
              exitCode: message.exitCode,
              timedOut: message.timedOut,
              failingSuites: message.failingSuites,
              durationMs: message.durationMs,
              ...(failed && atCapacity && isTimeoutOnlyFailure(log) ? { loadSuspect: true } : {}),
              ...(message.refused ? { refused: message.refused, reason: message.reason } : {}),
            });
          }
        });
        timer = setTimeout(() => end(refuse(`no verify_result from ${workerName} within ${Math.round((timeoutMs + RESULT_GRACE_MS) / 60000)} min`)), timeoutMs + RESULT_GRACE_MS);
        timer.unref?.();
        // #1465: a dropped socket only starts a grace period. The worker's process keeps running and it
        // re-announces its jobs (and delivers buffered results) on reconnect; only a worker that does not
        // come back, or comes back without the job, is unreachable.
        offDisconnect = connections.onDisconnect((id) => {
          if (id !== req.workerId) return;
          if (!connections.onConnect || graceMs <= 0) return end(refuse(`${workerName} disconnected mid-run`));
          job.disconnectedAt = new Date(deps.nowMs ?? Date.now()).toISOString();
          clearGrace();
          graceTimer = setTimeout(() => end(refuse(`${workerName} disconnected mid-run and did not reconnect within ${Math.round(graceMs / 1000)} s`)), graceMs);
          graceTimer.unref?.();
        });
        offConnect = connections.onConnect?.((id) => {
          if (id !== req.workerId || !job.disconnectedAt) return;
          delete job.disconnectedAt;
          job.reattached = true;
          clearGrace();
          // The worker must announce the job (progress or result) within the grace; a restarted worker lost it.
          graceTimer = setTimeout(() => end(refuse(`${workerName} reconnected but no longer knows this verify job (lost with the worker process)`)), graceMs);
          graceTimer.unref?.();
        });
        const frame: VerifyJobFrame = {
          type: "verify_job",
          jobId,
          sha: req.sha,
          branch: req.branch ?? "",
          kind: req.kind,
          tier: req.tier,
          script: req.command,
          ...(setupScript ? { setupScript } : {}),
          timeoutMs,
          ...(req.maxWorkers ? { maxWorkers: req.maxWorkers } : {}),
          ...(req.env ? { env: req.env } : {}),
          auth: { projectId: req.projectId!, gitPort: auth.gitPort, gitToken: auth.gitToken, branch: req.branch || "verify", incomingRef: `refs/verify/${jobId}` },
        };
        if (!connections.send(req.workerId, frame)) return end(refuse(`${workerName} is not connected`));
        if (req.signal?.aborted) onAbort(); else req.signal?.addEventListener("abort", onAbort, { once: true });
      });
    } finally {
      active.delete(jobId);
    }
  }

  return { listWorkers, run };
}

/** A READ-ONLY token (no incoming ref: no push can match) on the board's git transport. */
function defaultIssueGitAuth(database: Database) {
  return async (input: { workerId: string; projectId: string; jobId: string }): Promise<{ gitPort: number; gitToken: string }> => {
    const git = await ensureGitHttpServer(database);
    return { gitPort: git.port, gitToken: git.issueToken({ workerId: input.workerId, projectId: input.projectId }) };
  };
}
