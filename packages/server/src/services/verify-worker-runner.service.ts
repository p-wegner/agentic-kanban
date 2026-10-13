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
import { getWorkerFleet } from "./worker-fleet.service.js";

/** One verify job as the watch view and /api/workers show it. */
export interface ActiveVerifyJob {
  jobId: string;
  workerId: string;
  workerName: string;
  kind: VerifyChainKind;
  sha: string;
  tier: string;
  stage: VerifyStage;
  filesDone?: number;
  filesTotal?: number;
  startedAt: string;
}

const active = new Map<string, ActiveVerifyJob>();

/** Verify jobs in flight on workers right now (#1437). */
export function listActiveVerifyJobs(): ActiveVerifyJob[] {
  return [...active.values()];
}

/** How long past the script's own timeout the board waits for a worker's result before refusing. */
const RESULT_GRACE_MS = 10 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 45 * 60 * 1000;

export interface VerifyRunnerDeps {
  database: Database;
  /** Injected for tests; defaults to the board's fleet singleton. */
  fleet?: Pick<ReturnType<typeof getWorkerFleet>, "connections" | "registry">;
  /** Injected for tests; defaults to a read-only token on the board's git transport. */
  issueGitAuth?: (input: { workerId: string; projectId: string; jobId: string }) => Promise<{ gitPort: number; gitToken: string }>;
  /** Injected for tests; the project's setup script. */
  readSetupScript?: (projectId: string) => Promise<string | null>;
  nowMs?: number;
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
      .map((w) => {
        const cap = w.verify as WorkerVerifyCapability;
        const inFlight = listActiveVerifyJobs().filter((j) => j.workerId === w.id).length;
        return {
          id: w.id,
          name: w.name,
          // Our own in-flight count wins over a heartbeat that predates the job's first frame.
          freeSlots: Math.max(0, Math.min(cap.freeSlots, cap.slots - inFlight)),
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
        let timer: NodeJS.Timeout | undefined;
        const end = (report: WorkerVerifyReport): void => { off?.(); offDisconnect?.(); if (timer) clearTimeout(timer); resolve(report); };
        off = connections.onMessage((workerId, message) => {
          if (workerId !== req.workerId || !("jobId" in message) || message.jobId !== jobId) return;
          if (message.type === "verify_progress") {
            Object.assign(job, { stage: message.stage, filesDone: message.filesDone ?? job.filesDone, filesTotal: message.filesTotal ?? job.filesTotal });
          } else if (message.type === "verify_log_chunk") {
            chunks.set(message.seq, message.data);
          } else if (message.type === "verify_result") {
            const log = [...chunks.entries()].sort(([a], [b]) => a - b).map(([, d]) => d).join("") || message.logTail;
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
        offDisconnect = connections.onDisconnect((id) => { if (id === req.workerId) end(refuse(`${workerName} disconnected mid-run`)); });
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
        if (!connections.send(req.workerId, frame)) end(refuse(`${workerName} is not connected`));
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
