// One seam for placing a single verify COMMAND (#1430): implement-exit typecheck, review-exit
// typecheck, cold-clone build, bisect step, impact-map build. It is the caller-facing half of
// verify-placement.ts (#1428's policy) and the ONLY place those jobs decide host vs worker, so
// there is never a second remote-execution path.
//
// The transport is injected: until the worker verify runner registers itself via
// `setVerifyWorkerRunner`, no worker is offered and every job runs on the host exactly as before
// (`prefer-worker`) or is held (`worker`). A worker's verdict is only believed through
// `acceptWorkerVerdict` (sha/tier/request pinned); a refused verdict is a failed run, never a pass.
import { randomUUID } from "node:crypto";
import { gitExecOrThrow } from "@agentic-kanban/shared/lib/git-exec";
import type { SetupScriptResult } from "@agentic-kanban/shared/lib/setup-script";
import type { Database } from "../db/index.js";
import { getPreference } from "../repositories/preferences.repository.js";
import {
  acceptWorkerVerdict,
  decideVerifyPlacement,
  parseVerifyPlacement,
  parseVerifyWorkerAllowlist,
  verifyPlacementPrefKey,
  verifyWorkersPrefKey,
  type VerifyChainKind,
  type VerifyRequest,
  type VerifyWorkerCandidate,
  type WorkerVerifyReport,
} from "./verify-placement.js";

/** What the board tells a worker beyond the sha: the project (to fetch + read scripts), the timeout and env (#1437). */
export interface VerifyRunRequest extends VerifyRequest {
  kind: VerifyChainKind;
  command: string;
  workingDir: string;
  projectId?: string;
  branch?: string;
  timeoutMs?: number;
  /** Env the host run would carry that the worker should reproduce (e.g. `KANBAN_RETRY_TEST_FILES`). */
  env?: Record<string, string>;
  maxWorkers?: number;
  /** #1489: aborting it (a train/gate cancel) tells the worker to kill the job's process tree and remove its checkout. */
  signal?: AbortSignal;
}

export interface VerifyWorkerRunner {
  listWorkers(): VerifyWorkerCandidate[] | Promise<VerifyWorkerCandidate[]>;
  run(request: VerifyRunRequest): Promise<WorkerVerifyReport>;
}

let runner: VerifyWorkerRunner | null = null;

/** Registered by the worker verify runner (#1428 transport); `null` unregisters. */
export function setVerifyWorkerRunner(next: VerifyWorkerRunner | null): void {
  runner = next;
}

/** The registered runner, for callers that narrow its worker list (e.g. `train land-local --on-worker <name>`). */
export function getVerifyWorkerRunner(): VerifyWorkerRunner | null {
  return runner;
}

/** `worker` placement with nobody eligible: the job waits, it never silently runs on the host. */
export class VerifyJobHeldError extends Error {
  constructor(reason: string) {
    super(`verify job held: ${reason}`);
    this.name = "VerifyJobHeldError";
  }
}

export interface PlaceVerifyCommandArgs {
  kind: VerifyChainKind;
  projectId: string;
  database: Database;
  command: string;
  workingDir: string;
  /** The tree being verified; a worker verdict is pinned to it. */
  sha: string;
  tier: string;
  runOnHost: () => Promise<SetupScriptResult>;
  /** The host's own admission said "held for memory" (#1057). */
  hostHeld?: boolean;
  /** Injectable for tests; defaults to the registered runner. */
  workerRunner?: VerifyWorkerRunner | null;
  log?: (line: string) => void;
  /** What a worker run needs beyond the command (#1437); ignored on the host. */
  branch?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  maxWorkers?: number;
  /** #1489: the cancel signal of the owner (a train's abort, the gate's own); forwarded to the worker run. */
  signal?: AbortSignal;
}

export interface PlacedVerifyResult {
  result: SetupScriptResult;
  target: "host" | "worker";
  workerName?: string;
  /** The worker REFUSED (sha mismatch, no slot, ...): nothing was verified, so callers hold/retry rather than record red. */
  refused?: string;
  /** What the worker reported (#1437), so a caller can store the verdict like a host run's. */
  report?: WorkerVerifyReport;
}

export type VerifyPlan =
  | { target: "host"; reason: string }
  | { target: "hold"; reason: string }
  | { target: "worker"; reason: string; workerId: string; workerName: string; active: VerifyWorkerRunner; allowlist: Set<string> };

/** Decide host / worker / hold for one chain WITHOUT running it (#1437): callers that must act on a hold (the gate, the sweep) use this. */
export async function planVerifyPlacement(args: Pick<PlaceVerifyCommandArgs, "kind" | "projectId" | "database" | "hostHeld" | "workerRunner"> & { gateActive?: boolean }): Promise<VerifyPlan> {
  const [rawPlacement, rawAllow] = await Promise.all([
    getPreference(verifyPlacementPrefKey(args.projectId), args.database).catch(() => null),
    getPreference(verifyWorkersPrefKey(args.projectId), args.database).catch(() => null),
  ]);
  const placement = parseVerifyPlacement(rawPlacement);
  if (placement === "host") return { target: "host", reason: "verify_placement=host" };
  const active = args.workerRunner === undefined ? runner : args.workerRunner;
  const allowlist = parseVerifyWorkerAllowlist(rawAllow);
  const workers = active ? await Promise.resolve(active.listWorkers()).catch(() => []) : [];
  const decision = decideVerifyPlacement({ placement, kind: args.kind, hostHeld: args.hostHeld ?? false, allowlist, workers, gateActive: args.gateActive });
  if (decision.target === "hold") return { target: "hold", reason: decision.reason };
  if (decision.target === "host" || !active) return { target: "host", reason: decision.reason };
  return { target: "worker", reason: decision.reason, workerId: decision.workerId, workerName: decision.workerName, active, allowlist };
}

/** Run on the worker a plan chose and judge its report through `acceptWorkerVerdict`. */
export async function runOnPlannedWorker(plan: Extract<VerifyPlan, { target: "worker" }>, args: PlaceVerifyCommandArgs, isLoadRetry = false): Promise<PlacedVerifyResult> {
  const log = args.log ?? ((l: string) => console.log(`[verify-placement] ${l}`));
  const request: VerifyRequest = { requestId: randomUUID(), workerId: plan.workerId, sha: args.sha, tier: args.tier };
  log(`${plan.reason} (worker ${plan.workerName})`);
  const report = await plan.active
    .run({ ...request, kind: args.kind, command: args.command, workingDir: args.workingDir, projectId: args.projectId, branch: args.branch, timeoutMs: args.timeoutMs, env: args.env, maxWorkers: args.maxWorkers, signal: args.signal })
    .catch((e: unknown): WorkerVerifyReport => ({ ...request, passed: false, refused: "worker_unreachable", reason: e instanceof Error ? e.message : String(e) }));
  const verdict = acceptWorkerVerdict(request, report, plan.allowlist, plan.workerName);
  if (!verdict.accepted) {
    log(`${args.kind} verdict from ${plan.workerName} refused: ${verdict.reason}`);
    return { result: { exitCode: -1, stdout: "", stderr: `worker verdict refused: ${verdict.reason}` }, target: "worker", workerName: plan.workerName, refused: verdict.reason, report };
  }
  // #1589: red on timeouts only from a run where the worker was at capacity is load-suspect, not proof: re-run it
  // ONCE on a worker with a free slot (the plan already excludes busy / low-RAM workers) before declaring red.
  if (verdict.verdict === "red" && report.loadSuspect && !isLoadRetry) {
    const replan = await planVerifyPlacement(args).catch((): VerifyPlan => ({ target: "host", reason: "replan failed" }));
    if (replan.target === "worker") {
      log(`${args.kind} red on ${plan.workerName} is load-suspect (timeouts only, worker at capacity); re-running once on ${replan.workerName}`);
      const second = await runOnPlannedWorker(replan, args, true);
      if (!second.refused) return { ...second, result: { ...second.result, stdout: `[load-suspect first run on ${plan.workerName}: timeouts only, worker at capacity]\n${second.result.stdout}` } };
    }
    log(`${args.kind} red on ${plan.workerName} is load-suspect but no free worker is available for a re-run; recording the red with that evidence`);
  }
  return {
    result: { exitCode: verdict.verdict === "green" ? 0 : report.exitCode || 1, stdout: report.log ?? "", stderr: "", timedOut: report.timedOut === true },
    target: "worker",
    workerName: plan.workerName,
    report,
  };
}

export async function runPlacedVerifyCommand(args: PlaceVerifyCommandArgs): Promise<PlacedVerifyResult> {
  const plan = await planVerifyPlacement(args);
  if (plan.target === "hold") throw new VerifyJobHeldError(plan.reason);
  if (plan.target === "host") return { result: await args.runOnHost(), target: "host" };
  return runOnPlannedWorker(plan, args);
}

/** The tree a worker verdict is pinned to; empty when unreadable (a worker verdict is then refused). */
export async function readHeadSha(workingDir: string): Promise<string> {
  return (await gitExecOrThrow(["rev-parse", "HEAD"], { cwd: workingDir }).catch(() => "")).trim();
}

/**
 * The seam for jobs whose host path is NOT a plain command (clone + install + build, a bisect
 * step, an impact-map build) (#1440): `null` means "placement says host, run your own way";
 * a worker run returns its judged result; a hold, or a worker that REFUSED (nothing verified),
 * throws `VerifyJobHeldError` so the caller holds with a reason instead of recording red/green.
 */
export async function tryRunOnWorker(args: PlaceVerifyCommandArgs): Promise<PlacedVerifyResult | null> {
  const plan = await planVerifyPlacement(args);
  if (plan.target === "hold") throw new VerifyJobHeldError(plan.reason);
  if (plan.target === "host") return null;
  const out = await runOnPlannedWorker(plan, args);
  if (out.refused) throw new VerifyJobHeldError(`worker ${plan.workerName} refused the ${args.kind} job (${out.refused}); nothing was verified`);
  return out;
}
