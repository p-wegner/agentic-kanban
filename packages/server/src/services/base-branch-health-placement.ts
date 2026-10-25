// Running the base-branch probe / rc sweep on a fleet worker (#1437).
//
// `runBaseBranchProbe` clones, installs and runs the verify script ON THE HOST under the host's
// verify-chain slot. When the project's `verify_placement` sends the sweep to an allowlisted worker,
// none of that happens here: the worker checks the swept sha out of the board's git transport,
// installs and runs the script, and its verdict (judged by `acceptWorkerVerdict`) becomes the SAME
// `BaseBranchVerifyResult` a host run produces — same outcome vocabulary, same red wording, same
// `base_branch_health` row, rc-state and heal tickets (all of that is `finishBaseProbe`, the one
// tail both paths share). The only addition is the worker's name in the row's message.
import { classifyHeavyProbeSaturation, readCpuBusyPct, readTier0Capacity } from "@agentic-kanban/shared/lib/machine-capacity";
import type { SetupScriptResult } from "@agentic-kanban/shared/lib/setup-script";
import type { Database } from "../db/index.js";
import { projectPref } from "@agentic-kanban/shared/lib/dynamic-preference-keys";
import { getPreference, setPreference } from "../repositories/preferences.repository.js";
import { verifyHonoursSuiteScope } from "./self-project.js";
import { CONTENTION_RETRY_ENV } from "./verify-flake-retry.js";
import { resolveRedProbeOutcome } from "./base-branch-red-outcome.js";
import type { BaseBranchVerifyResult } from "./base-branch-health.service.js";
import { failedSuitesForOutcome } from "./failed-suite-parse.js";
import { planVerifyPlacement, runOnPlannedWorker, type VerifyPlan } from "./verify-job-placement.js";
import { isRuntimeRefusalLog, rankVerifyWorkers, type VerifyChainKind } from "./verify-placement.js";
import {
  checkShardCoverage, DEFAULT_SWEEP_PACKAGES, formatSweepProgress, mergeShardVerdicts, parseShardTimings, planSweepShards, recordShardTimings, runShardedSweep,
  type ShardResult,
} from "./sweep-shards.js";

type WorkerPlan = Extract<VerifyPlan, { target: "worker" }>;

/** Is the host too tight to run a heavy probe right now? The same two thresholds the reprobe due-check uses (#1009/#1173). */
export async function hostTooTightForProbe(): Promise<string | null> {
  const cap = readTier0Capacity();
  const sat = classifyHeavyProbeSaturation({ freeGb: cap.freeGb, cpuPct: await readCpuBusyPct().catch(() => null) });
  return sat.hold ? sat.reason : null;
}

/**
 * The reprobe due-check's `hostSaturated` input, placement-aware (#1437): a saturated host does NOT
 * defer the probe when an allowlisted worker can take it, and `verify_placement=worker` with nobody
 * eligible defers it (reported through the same field) rather than running it on the host.
 */
export async function placementAwareSaturation(saturated: string | null, projectId: string, database: Database): Promise<string | null> {
  const plan = await planVerifyPlacement({ kind: "base-probe", projectId, database, hostHeld: saturated !== null }).catch(() => null);
  return plan?.target === "hold" ? plan.reason : plan?.target === "worker" ? null : saturated;
}

/** Host / worker / hold for one probe or sweep. Reads host load only when the project opted into placement. */
export async function planProbePlacement(args: { projectId: string; database: Database; isBaseLane: boolean; gateActive?: boolean }): Promise<VerifyPlan> {
  const kind: VerifyChainKind = args.isBaseLane ? "base-probe" : "rc-sweep";
  const first = await planVerifyPlacement({ kind, projectId: args.projectId, database: args.database, hostHeld: false, gateActive: args.gateActive });
  if (first.target !== "host") return first; // `worker` / `hold` do not depend on host load
  // `prefer-worker` answers "host" while the host has room: ask again with the real load.
  const saturated = await hostTooTightForProbe().catch(() => null);
  return saturated === null ? first : planVerifyPlacement({ kind, projectId: args.projectId, database: args.database, hostHeld: true, gateActive: args.gateActive });
}

const hostRefused = (name: string): (() => Promise<SetupScriptResult>) => async () => ({
  exitCode: -1, stdout: "", stderr: `worker ${name}: verify ran on the host instead`, timedOut: false,
});

export async function runProbeOnWorker(args: {
  plan: WorkerPlan;
  kind: VerifyChainKind;
  projectId: string;
  database: Database;
  repoPath: string;
  branch: string;
  sha: string;
  verifyScript: string;
  timeoutMs: number;
  /** The shared tail: stamps scope, records the row, files heal tickets (`finishBaseProbe`). */
  finish: (result: BaseBranchVerifyResult, combined: string) => Promise<BaseBranchVerifyResult>;
  stampKey: string;
  startedAtIso?: string;
}): Promise<BaseBranchVerifyResult> {
  const { plan, projectId, database, branch, sha, kind } = args;
  const startedAt = Date.now();
  const run = (env?: Record<string, string>) =>
    runOnPlannedWorker(plan, {
      kind, projectId, database, command: args.verifyScript, workingDir: args.repoPath, sha, tier: "full", branch, timeoutMs: args.timeoutMs, env,
      runOnHost: hostRefused(plan.workerName),
    });
  // Persisted start stamp, like a host probe's: a restart mid-run must not launch a rival verify.
  await setPreference(args.stampKey, args.startedAtIso ?? new Date().toISOString(), database).catch(() => {});
  try {
    const out = await run();
    const stamp = `[verified on worker ${plan.workerName}] `;
    const durationMs = out.report?.durationMs ?? Date.now() - startedAt;
    const combined = out.result.stdout;
    let result: BaseBranchVerifyResult;
    if (out.refused) {
      // UNVERIFIED, not red: the worker never judged this tree (sha mismatch, no slot, unreachable).
      result = { outcome: "unverified", sha, branch, durationMs, message: `${stamp}the worker refused the sweep: ${out.refused}. The tree was NOT verified; this says nothing about whether it is green.` };
    } else if (out.result.timedOut) {
      result = {
        outcome: "timeout", sha, branch, durationMs, failedSuites: failedSuitesForOutcome("timeout", combined),
        message: `${stamp}verify_script timed out after ${args.timeoutMs}ms on the worker. This is NOT a verdict about the tree: the probe could not answer, so its health is UNKNOWN.`,
      };
    } else if (out.result.exitCode !== 0 && isRuntimeRefusalLog(combined)) {
      // #1710: the toolchain refused the worker's runtime (and no other worker took the re-run): the worker's fault, not the tree's.
      result = { outcome: "unverified", sha, branch, durationMs, message: `${stamp}the verify toolchain refused this worker's runtime. The tree was NOT verified; this says nothing about whether it is green.` };
    } else if (out.result.exitCode !== 0) {
      result = await resolveRedProbeOutcome({
        projectId, sha, branch, exitCode: out.result.exitCode, combined, stdout: combined, stderr: "", startedAt, scoped: verifyHonoursSuiteScope({ repoPath: args.repoPath, verifyScript: args.verifyScript }), workingDir: args.repoPath,
        runRetry: async (scope) => (await run({ ...CONTENTION_RETRY_ENV, KANBAN_RETRY_TEST_FILES: scope })).result,
      });
      result.message = `${stamp}${result.message ?? ""}`;
      result.failedSuites = result.failedSuites ?? (out.report?.failingSuites?.length ? out.report.failingSuites : null);
    } else {
      result = { outcome: "green", sha, branch, durationMs, failedSuites: failedSuitesForOutcome("green", combined), message: stamp.trim() };
    }
    return await args.finish(result, combined);
  } finally {
    await setPreference(args.stampKey, "", database).catch(() => {});
  }
}

/** #1632: is sharding the full sweep switched on for this project (opt-in)? */
export async function sweepShardingEnabled(projectId: string, database: Database): Promise<boolean> {
  return (await getPreference(projectPref("rc_sweep_shards").key(projectId), database).catch(() => null))?.trim().toLowerCase() === "true";
}

/**
 * #1632: the full sweep as shards over every eligible worker's free verify slots. One verdict: green only if
 * every shard is green; a shard lost to a worker drop is retried once elsewhere, then the sweep is `unverified`
 * (never green). Shard timings are banked so the next plan balances on them. Also usable by a full train gate.
 * Returns null when sharding cannot help (fewer than two slots on offer): the caller runs the single job.
 */
export async function runShardedProbeOnWorkers(args: {
  plan: WorkerPlan;
  kind: VerifyChainKind;
  projectId: string;
  database: Database;
  repoPath: string;
  branch: string;
  sha: string;
  timeoutMs: number;
  finish: (result: BaseBranchVerifyResult, combined: string) => Promise<BaseBranchVerifyResult>;
  stampKey: string;
  startedAtIso?: string;
  log?: (line: string) => void;
}): Promise<BaseBranchVerifyResult | null> {
  const { plan, projectId, database, sha, branch, kind } = args;
  const log = args.log ?? ((l: string) => console.log(`[sweep-shards] ${l}`));
  const workers = rankVerifyWorkers(plan.allowlist, await Promise.resolve(plan.active.listWorkers()).catch(() => []));
  if (workers.reduce((n, w) => n + w.freeSlots, 0) < 2) return null;

  const timingKey = projectPref("sweep_shard_timings").key(projectId);
  const timings = parseShardTimings(await getPreference(timingKey, database).catch(() => null));
  const shards = planSweepShards({ timings });
  const problems = checkShardCoverage(shards, [...DEFAULT_SWEEP_PACKAGES.map((p) => p.pkg), "static"]);
  if (problems.length > 0) {
    log(`shard plan rejected (${problems.join("; ")}); running the sweep as one job`);
    return null;
  }
  const startedAt = Date.now();
  await setPreference(args.stampKey, args.startedAtIso ?? new Date().toISOString(), database).catch(() => {});
  try {
    const results = await runShardedSweep({
      shards,
      workers,
      onProgress: (done, total) => log(formatSweepProgress(done, total, Date.now() - startedAt)),
      runShard: async (shard, worker) => {
        const t0 = Date.now();
        const out = await runOnPlannedWorker({ ...plan, workerId: worker.id, workerName: worker.name }, {
          kind, projectId, database, command: shard.command, workingDir: args.repoPath, sha, tier: "full", branch, timeoutMs: args.timeoutMs,
          runOnHost: hostRefused(worker.name),
        });
        const durationMs = out.report?.durationMs ?? Date.now() - t0;
        // Refused / timed out: nothing was answered for this shard, so it is lost (retried once), never green.
        if (out.refused || out.result.timedOut) return { outcome: "lost" as const, durationMs, reason: out.refused ?? "timed out" };
        if (out.result.exitCode !== 0) {
          const failedSuites = out.report?.failingSuites?.length ? out.report.failingSuites : failedSuitesForOutcome("red", out.result.stdout) ?? [];
          return { outcome: "red" as const, durationMs, failedSuites };
        }
        return { outcome: "green" as const, durationMs };
      },
    });
    await setPreference(timingKey, JSON.stringify(recordShardTimings(timings, results)), database).catch(() => {});
    const verdict = mergeShardVerdicts(results, shards);
    const durationMs = Date.now() - startedAt;
    const names = [...new Set(results.map((r: ShardResult) => r.workerName).filter(Boolean))].join(", ");
    const answered = results.filter((r) => r.outcome !== "lost").length;
    const stamp = `[verified in ${shards.length} shards on ${names || "workers"}] ${formatSweepProgress(answered, shards.length, durationMs)}. `;
    const combined = results.map((r) => `${r.shard.id}: ${r.outcome}${r.attempts > 1 ? " (retried)" : ""} ${Math.round(r.durationMs / 1000)}s${r.workerName ? ` on ${r.workerName}` : ""}`).join("\n");
    let result: BaseBranchVerifyResult;
    if (verdict.outcome === "green") result = { outcome: "green", sha, branch, durationMs, failedSuites: [], message: `${stamp}${verdict.message}` };
    else if (verdict.outcome === "red") result = { outcome: "red", sha, branch, durationMs, failedSuites: verdict.failedSuites.length ? verdict.failedSuites : null, message: `${stamp}${verdict.message}` };
    else result = { outcome: "unverified", sha, branch, durationMs, message: `${stamp}${verdict.message}. This says nothing about whether the tree is green.` };
    return await args.finish(result, combined);
  } finally {
    await setPreference(args.stampKey, "", database).catch(() => {});
  }
}
