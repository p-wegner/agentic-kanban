// Where the pre-merge gate's verify script runs: the host, or a fleet worker (#1437).
//
// Its own module because `runPreMergeGate` sits on the god-module branch ceiling: every decision
// here is a branch it must not grow, so the gate asks ONE question (`planGateRun`) and reads the
// answer as data — `proceed` (run it) or a ready-made hold message — plus an optional runner for
// the verify script that it substitutes for the host's `runSetupScript`.
import type { SetupScriptResult } from "@agentic-kanban/shared/lib/setup-script";
import type { Database } from "../db/index.js";
import { describeGateHold, type GateHostAdmission } from "./gate-quiesce.js";
import { runOffHostVerifyChainTimed } from "./verify-chain-off-host.js";
import { runUnderVerifyChainSemaphoreTimed, type VerifyChainPriority } from "./verify-chain-semaphore.js";
import { planVerifyPlacement, readHeadSha, runOnPlannedWorker, type PlacedVerifyResult } from "./verify-job-placement.js";
import { listShardableSuites, mergeShardReports, pickShardWorkers, shardByDuration } from "./verify-shards.js";

/**
 * #1497: the chain slot a verify chain waits for follows WHERE its script runs. A host run takes
 * the host's RAM-sized verify-chain slot; a worker run (`workerName` set) does not — it is bounded
 * by the worker's own verify slots (#1496) and shows in the chain list as "on <worker>".
 */
export function runVerifyChainForPlacement<T>(
  workerName: string | undefined,
  chain: () => Promise<T>,
  label: string,
  opts?: { priority?: VerifyChainPriority },
): Promise<{ result: T; queueWaitMs: number; lockNote: string | null }> {
  return workerName
    ? runOffHostVerifyChainTimed(chain, label, workerName, opts)
    : runUnderVerifyChainSemaphoreTimed(chain, label, opts);
}

/**
 * #1555: the host's build semaphore bounds BUILDS ON THIS HOST. A gate placed on a worker must not
 * queue behind it: #1550's worker-placed gate sat in phase `verify` for 40 min, never reaching
 * `runOnPlannedWorker` (no `[verify-placement]` line), because the host's build slots were held by
 * other work. A worker run is bounded by the worker's own verify slots (#1496), so it skips the
 * host semaphore and starts at once.
 */
export function runInHostBuildSlotUnlessOnWorker<T>(
  workerRun: unknown,
  task: () => Promise<T>,
  hostSemaphore: (task: () => Promise<T>) => Promise<T>,
): Promise<T> {
  return workerRun ? task() : hostSemaphore(task);
}

export type GateScriptRunner =(env: Record<string, string>) => Promise<SetupScriptResult>;

export interface GateRunPlan {
  /** False = the gate is HELD (not red): nothing runs, the merge retries next cycle. */
  proceed: boolean;
  /** Set when a worker runs the script; absent = the host's own `runSetupScript`. */
  run?: GateScriptRunner;
  workerName?: string;
  /** The held message + phase note, already worded for the reason it is held. */
  hold: { phaseNote: string; message: string };
  /** Maps a failed gate result to HELD when the worker REFUSED the job (nothing was verified, so it must not read as red). Identity otherwise. */
  holdIfRefused: <R extends object>(result: R) => R | (R & { held: true; message: string });
}

/** A worker that REFUSED the job (sha mismatch, no slot, unreachable) verified nothing: not red, not green. */
function refusedAsHeld(workerName: string, reason: string): SetupScriptResult {
  return { exitCode: -1, stdout: "", stderr: `verify on worker ${workerName} was refused (${reason}); nothing was verified`, timedOut: false };
}

export async function planGateRun(args: {
  projectId: string;
  /** `train:<label>` for a merge-train staging gate (placed as `train-gate`), a workspace id otherwise. */
  workspaceId: string;
  database: Database;
  admission: GateHostAdmission;
  workingDir: string;
  verifyScript: string;
  timeoutMs: number;
  tier: string;
  maxWorkers?: number;
  /** #1489: the gate's cancel signal; a worker run is cancelled on the worker when it fires. */
  signal?: AbortSignal;
}): Promise<GateRunPlan> {
  const { admission, projectId, database } = args;
  const kind = args.workspaceId.startsWith("train:") ? "train-gate" : "workspace-gate";
  const hostHold = admission.admit ? { phaseNote: "", message: "" } : describeGateHold(admission, projectId);
  const sha = await readHeadSha(args.workingDir);
  const plan = await planVerifyPlacement({ kind, projectId, database, hostHeld: !admission.admit });
  // No readable HEAD means a worker verdict could never be pinned to a tree: the host decides.
  const onWorker = plan.target === "worker" && sha !== "";
  const heldForWorker = plan.target === "hold" || (plan.target === "worker" && sha === "");
  const hold = heldForWorker
    ? { phaseNote: `waiting for a verify worker — ${plan.reason}`, message: `pre-merge gate HELD — no verify worker is available (${plan.reason}). Nothing was verified and nothing failed; the merge is deferred and will be retried on the next cycle.` }
    : hostHold;
  const proceed = !heldForWorker && (onWorker || admission.admit);
  const keep = <R extends object>(result: R): R => result;
  if (!onWorker || plan.target !== "worker") return { proceed, hold, holdIfRefused: keep };
  const placed = plan;
  let refusal: string | null = null;
  // #1578: a full-suite TRAIN gate with no suite scope already set shards across every free verify worker.
  const shardWorkers = kind === "train-gate" && args.tier === "full"
    ? pickShardWorkers(placed.allowlist, await Promise.resolve(placed.active.listWorkers()).catch(() => []))
    : [];
  const suites = shardWorkers.length >= 2 ? listShardableSuites(args.workingDir) : null;
  const shardPlans = suites ? shardWorkers.map((w) => ({ ...placed, workerId: w.id, workerName: w.name })) : [];
  const runOne = (p: typeof placed, env: Record<string, string>): Promise<PlacedVerifyResult> =>
    runOnPlannedWorker(p, {
      kind, projectId, database, command: args.verifyScript, workingDir: args.workingDir, sha, tier: args.tier,
      timeoutMs: args.timeoutMs, env, maxWorkers: args.maxWorkers, signal: args.signal, runOnHost: async () => refusedAsHeld(p.workerName, "ran on host"),
    });
  const run: GateScriptRunner = async (env) => {
    if (suites && !env.KANBAN_RETRY_TEST_FILES) {
      const slices = shardByDuration(suites, shardPlans.length);
      console.log(`[verify-shards] train gate ${sha.slice(0, 9)} split into ${slices.length} shards: ${shardPlans.map((p, i) => `${p.workerName}=${slices[i]!.length} suites`).join(", ")}`);
      const outs = await Promise.all(shardPlans.map((p, i) => runOne(p, { ...env, KANBAN_RETRY_TEST_FILES: slices[i]!.map((f) => f.entry).join(",") })));
      const named = outs.map((o, i) => ({ workerName: shardPlans[i]!.workerName, report: { ...o.report!, ...(o.refused ? { refused: o.refused, passed: false } : {}) } }));
      const merged = mergeShardReports(named);
      refusal = merged.refused ?? null;
      if (refusal) return refusedAsHeld(shardPlans.map((p) => p.workerName).join("+"), refusal);
      return { exitCode: merged.passed ? 0 : merged.exitCode || 1, stdout: merged.log ?? "", stderr: "", timedOut: merged.timedOut === true };
    }
    const out = await runOne(placed, env);
    refusal = out.refused ?? null;
    return out.refused ? refusedAsHeld(placed.workerName, out.refused) : out.result;
  };
  const holdIfRefused = <R extends object>(result: R): R | (R & { held: true; message: string }) =>
    refusal === null ? result : { ...result, held: true, message: `pre-merge gate HELD — verify worker ${placed.workerName} refused the job (${refusal}). Nothing was verified and nothing failed; the merge is deferred and will be retried on the next cycle.` };
  // The chain line reads "on a+b (2 shards)"; each shard's stage and files done/total show as its own active job.
  const workerName = shardPlans.length >= 2 ? `${shardPlans.map((p) => p.workerName).join("+")} (${shardPlans.length} shards)` : placed.workerName;
  return { proceed, run, workerName, hold, holdIfRefused };
}
