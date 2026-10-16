// The board half of running verify jobs on a fleet worker (#1437): implements #1430's
// `VerifyWorkerRunner` seam over the worker WebSocket. `verify-placement.ts` decides WHETHER a chain
// goes to a worker and whether a verdict is believed; this file is only the transport — send a
// `verify_job`, follow its `verify_progress`, assemble the `verify_log_chunk`s, hand back ONE report.
//
// It never decides trust: the caller feeds the report through `acceptWorkerVerdict`, which judges it
// against the request the BOARD built (sha, tier, worker), not against anything in the frame. This
// service also never invents a verdict: a worker that vanishes or goes silent yields a refusal.
import { workerBelowRamFloor } from "@agentic-kanban/shared/lib/worker-settings";
import type { VerifyJobFrame, VerifyStage, WorkerVerifyCapability } from "@agentic-kanban/shared/lib/worker-verify-protocol";
import type { Database } from "../db/index.js";
import { getProjectSetupScript } from "../repositories/stack-profile.repository.js";
import { ensureGitHttpServer } from "./git-http.service.js";
import type { VerifyRunRequest, VerifyWorkerRunner } from "./verify-job-placement.js";
import type { VerifyChainKind, VerifyWorkerCandidate, WorkerVerifyReport } from "./verify-placement.js";
import { active, listActiveVerifyJobs, type ActiveVerifyJob } from "./verify-active-jobs.js";
import { getWorkerFleet } from "./worker-fleet.service.js";

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
        return {
          id: w.id,
          name: w.name,
          // Our own in-flight count wins over a heartbeat that predates the job's first frame.
          freeSlots: Math.max(0, Math.min(cap.freeSlots, cap.slots - inFlight, ...budgetSlots(w, () => connections.assignedSessionIds(w.id).length, inFlight))),
          freeRamGb: w.capacity?.freeRamGb ?? cap.ramGb,
          thrashing: w.capacity ? w.capacity.thrashing !== "none" : undefined,
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
          if (message.type === "verify_progress") {
            Object.assign(job, { stage: message.stage, filesDone: message.filesDone ?? job.filesDone, filesTotal: message.filesTotal ?? job.filesTotal });
          } else if (message.type === "verify_log_chunk") {
            chunks.set(message.seq, message.data);
          } else if (message.type === "verify_result") {
            const log = [...chunks.entries()].sort(([a], [b]) => a - b).map(([, d]) => d).join("") || message.logTail;
            // #1495: the verdict's receipt (placement and refusals were logged, the verdict was not).
            console.log(`[verify-worker] ${req.kind} verify_result from ${workerName} sha ${message.sha.slice(0, 9)}: ${message.refused ? `refused (${message.refused})` : message.passed ? "passed" : "failed"}, ${message.failingSuites?.length ?? 0} failing suite(s), ${Math.round((message.durationMs ?? 0) / 1000)}s`);
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
