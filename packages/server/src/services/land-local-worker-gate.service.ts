import type { Database } from "../db/index.js";
import { getVerifyWorkerRunner, planVerifyPlacement, runOnPlannedWorker, type VerifyWorkerRunner } from "./verify-job-placement.js";
import { parseFailedSuites } from "./train-land-local.service.js";

/**
 * `train land-local --on-worker` (#1612): the gate (install + check:arch + typecheck + scoped tests) of a
 * locally assembled train, placed on a verify worker through the NORMAL placement seam. The runner lives in
 * the board server process, so the CLI reaches this through `POST /projects/:id/land-local/worker-gate`.
 */

export const LAND_LOCAL_STEP_MARKER = "::land-local-step ";
// A land-local train diff usually trips the full server suite; 45 min cut a green gate off mid-mcp-server on ao-pf38.
export const WORKER_GATE_TIMEOUT_MS = 90 * 60 * 1000;

export interface WorkerGateStep { name: string; command: string }

export interface WorkerGateRequest {
  projectId: string;
  /** The assembled branch, present in the project repo (the worker fetches it from the board's git transport). */
  branch: string;
  sha: string;
  steps: WorkerGateStep[];
  changedFiles: string[];
  /** Pin a worker by name or id; absent = the normal ranking picks one. */
  workerName?: string;
}

export type WorkerGateResult =
  | { status: "ran"; workerName: string; passed: boolean; exitCode: number; log: string; timedOut?: boolean; failedStep?: string; failedSuites: string[] }
  | { status: "unavailable"; reason: string };

/** One shell line that announces each step before running it, so the log says which step failed. */
export function buildWorkerGateScript(steps: readonly WorkerGateStep[]): string {
  return steps.map((s) => `echo "${LAND_LOCAL_STEP_MARKER}${s.name}" && ${s.command}`).join(" && ");
}

/** The step a failed run died in: the last announced marker. */
export function failedStepFromLog(log: string, steps: readonly WorkerGateStep[]): string | undefined {
  let last: string | undefined;
  for (const m of log.matchAll(/::land-local-step (\S+)/g)) last = m[1];
  return last ?? steps[0]?.name;
}

export function narrowRunnerToWorker(base: VerifyWorkerRunner, workerName: string): VerifyWorkerRunner {
  return {
    listWorkers: async () => (await Promise.resolve(base.listWorkers())).filter((w) => w.name === workerName || w.id === workerName),
    run: (req) => base.run(req),
  };
}

export async function runLandLocalWorkerGate(
  req: WorkerGateRequest,
  deps: { database: Database; workerRunner?: VerifyWorkerRunner | null; log?: (line: string) => void },
): Promise<WorkerGateResult> {
  const base = deps.workerRunner === undefined ? getVerifyWorkerRunner() : deps.workerRunner;
  if (!base) return { status: "unavailable", reason: "no verify worker runner is registered on the board server" };
  const workerRunner = req.workerName ? narrowRunnerToWorker(base, req.workerName) : base;
  // hostHeld: the operator asked for a worker, so `prefer-worker` must not answer "host has room".
  const placement = { kind: "workspace-gate" as const, projectId: req.projectId, database: deps.database, hostHeld: true, workerRunner };
  const plan = await planVerifyPlacement(placement);
  if (plan.target !== "worker") {
    return { status: "unavailable", reason: `${plan.reason}${req.workerName ? ` (requested worker: ${req.workerName})` : ""}` };
  }
  const placed = await runOnPlannedWorker(plan, {
    ...placement,
    command: buildWorkerGateScript(req.steps),
    workingDir: ".",
    sha: req.sha,
    tier: "land-local",
    branch: req.branch,
    timeoutMs: WORKER_GATE_TIMEOUT_MS,
    env: { KANBAN_TEST_FILES: req.changedFiles.join(",") },
    runOnHost: async () => ({ exitCode: -1, stdout: "", stderr: "ran on host" }),
    log: deps.log,
  });
  const workerName = placed.workerName ?? plan.workerName;
  if (placed.refused) return { status: "unavailable", reason: `worker ${workerName} refused the job (${placed.refused}); nothing was verified` };
  const log = placed.result.stdout;
  const passed = placed.result.exitCode === 0;
  return {
    status: "ran", workerName, passed, exitCode: placed.result.exitCode ?? 1, log,
    ...(placed.result.timedOut ? { timedOut: true } : {}),
    ...(passed ? { failedSuites: [] } : { failedStep: failedStepFromLog(log, req.steps), failedSuites: placed.report?.failingSuites?.length ? placed.report.failingSuites : parseFailedSuites(log) }),
  } as WorkerGateResult;
}
