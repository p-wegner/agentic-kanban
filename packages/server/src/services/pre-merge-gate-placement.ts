// Where the pre-merge gate's verify script runs: the host, or a fleet worker (#1437).
//
// Its own module because `runPreMergeGate` sits on the god-module branch ceiling: every decision
// here is a branch it must not grow, so the gate asks ONE question (`planGateRun`) and reads the
// answer as data — `proceed` (run it) or a ready-made hold message — plus an optional runner for
// the verify script that it substitutes for the host's `runSetupScript`.
import type { SetupScriptResult } from "@agentic-kanban/shared/lib/setup-script";
import type { Database } from "../db/index.js";
import { describeGateHold, type GateHostAdmission } from "./gate-quiesce.js";
import { planVerifyPlacement, readHeadSha, runOnPlannedWorker } from "./verify-job-placement.js";

export type GateScriptRunner = (env: Record<string, string>) => Promise<SetupScriptResult>;

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
  const run: GateScriptRunner = async (env) => {
    const out = await runOnPlannedWorker(placed, {
      kind, projectId, database, command: args.verifyScript, workingDir: args.workingDir, sha, tier: args.tier,
      timeoutMs: args.timeoutMs, env, maxWorkers: args.maxWorkers, signal: args.signal, runOnHost: async () => refusedAsHeld(placed.workerName, "ran on host"),
    });
    refusal = out.refused ?? null;
    return out.refused ? refusedAsHeld(placed.workerName, out.refused) : out.result;
  };
  const holdIfRefused = <R extends object>(result: R): R | (R & { held: true; message: string }) =>
    refusal === null ? result : { ...result, held: true, message: `pre-merge gate HELD — verify worker ${placed.workerName} refused the job (${refusal}). Nothing was verified and nothing failed; the merge is deferred and will be retried on the next cycle.` };
  return { proceed, run, workerName: placed.workerName, hold, holdIfRefused };
}
