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

export interface VerifyWorkerRunner {
  listWorkers(): VerifyWorkerCandidate[] | Promise<VerifyWorkerCandidate[]>;
  run(request: VerifyRequest & { kind: VerifyChainKind; command: string; workingDir: string }): Promise<WorkerVerifyReport>;
}

let runner: VerifyWorkerRunner | null = null;

/** Registered by the worker verify runner (#1428 transport); `null` unregisters. */
export function setVerifyWorkerRunner(next: VerifyWorkerRunner | null): void {
  runner = next;
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
}

export interface PlacedVerifyResult {
  result: SetupScriptResult;
  target: "host" | "worker";
  workerName?: string;
}

export async function runPlacedVerifyCommand(args: PlaceVerifyCommandArgs): Promise<PlacedVerifyResult> {
  const { kind, projectId, database, log = (l) => console.log(`[verify-placement] ${l}`) } = args;
  const [rawPlacement, rawAllow] = await Promise.all([
    getPreference(verifyPlacementPrefKey(projectId), database).catch(() => null),
    getPreference(verifyWorkersPrefKey(projectId), database).catch(() => null),
  ]);
  const placement = parseVerifyPlacement(rawPlacement);
  if (placement === "host") return { result: await args.runOnHost(), target: "host" };

  const active = args.workerRunner === undefined ? runner : args.workerRunner;
  const allowlist = parseVerifyWorkerAllowlist(rawAllow);
  const workers = active ? await Promise.resolve(active.listWorkers()).catch(() => []) : [];
  const decision = decideVerifyPlacement({ placement, kind, hostHeld: args.hostHeld ?? false, allowlist, workers });
  if (decision.target === "hold") throw new VerifyJobHeldError(decision.reason);
  if (decision.target === "host" || !active) return { result: await args.runOnHost(), target: "host" };

  const request: VerifyRequest = { requestId: randomUUID(), workerId: decision.workerId, sha: args.sha, tier: args.tier };
  log(`${decision.reason} (worker ${decision.workerName})`);
  const report = await active.run({ ...request, kind, command: args.command, workingDir: args.workingDir });
  const verdict = acceptWorkerVerdict(request, report, allowlist, decision.workerName);
  if (!verdict.accepted) {
    log(`${kind} verdict from ${decision.workerName} refused: ${verdict.reason}`);
    return { result: { exitCode: -1, stdout: "", stderr: `worker verdict refused: ${verdict.reason}` }, target: "worker", workerName: decision.workerName };
  }
  return {
    result: { exitCode: verdict.verdict === "green" ? 0 : 1, stdout: report.log ?? "", stderr: "" },
    target: "worker",
    workerName: decision.workerName,
  };
}

/** The tree a worker verdict is pinned to; empty when unreadable (a worker verdict is then refused). */
export async function readHeadSha(workingDir: string): Promise<string> {
  return (await gitExecOrThrow(["rev-parse", "HEAD"], { cwd: workingDir }).catch(() => "")).trim();
}
