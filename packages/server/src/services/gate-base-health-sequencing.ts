/**
 * SEQUENCE the base-branch health run against a merge gate's own verify (#1009).
 *
 * Observed on #999 (three failed attempts): the gate found the stored base verdict stale
 * (checked 25h ago, master had moved) and a fresh base-health probe of master ran in a temp
 * clone WHILE the branch's verify_script was running — two full server suites plus two
 * typechecks on a host fleet reported at 0.6-1.7 GB usable and swapping. The base run took 24
 * minutes and produced six load-induced failures; the branch gate hit its 90-minute budget and
 * never reached a verdict; and a NEW base-health run then started on its own, so the next
 * attempt collided again.
 *
 * Three rules, applied BEFORE the gate takes the verify-chain slot:
 *  1. A probe already in flight for the project is JOINED with foreground demand registered.
 *     It can yield within its starvation budget; the gate waits for process-tree termination
 *     and cleanup before proceeding, or for the full verdict when that budget is exhausted.
 *  2. A base whose verdict is DUE — by the same posture-driven cadence the sweep uses, so this
 *     launches nothing the sweep would not have — is measured FIRST, then the branch. One suite
 *     at a time is the point; the ordering follows from the base verdict being what a failing
 *     gate is attributed against.
 *  3. A host below the Tier-0 floor the monitor applies to auto-starts DEFERS the probe with a
 *     visible message instead of starting a second full run (`isBaseHealthProbeDue`'s
 *     `host_saturated`).
 *
 * Every outcome is reported in the gate's tier message, because an operator otherwise sees ONE
 * job in `verify` and cannot tell the machine is running two suites. Total by construction: the
 * gate's verdict must never depend on this, so every failure path resolves to a note (or none)
 * and the gate carries on.
 */
import type { Database } from "../db/index.js";
import { toPrefMap } from "@agentic-kanban/shared/lib/preference-map";
import { getAllPreferencesCached } from "../repositories/preferences.repository.js";
import { resolveRiskPosture, resolveBaseSweepIntervalMs } from "./risk-posture.service.js";
import {
  inFlightBaseBranchProbe,
  verifyBaseBranchHealth,
  type BaseBranchVerifyResult,
} from "./base-branch-health.service.js";
import { resolveBaseHealthProbeDue, type BaseHealthDueVerdict } from "./base-branch-health-reprobe.service.js";
import { noteMergeGatePhase } from "./merge-job.service.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import { registerVerifyChainGateDemand } from "./verify-chain-semaphore.js";

export type BaseHealthSequenceAction =
  /** A probe was already running for this project; the gate waited for it. */
  | "joined"
  /** The base was due, so the gate ran the probe to completion before its own verify. */
  | "ran_first"
  /** The base was due but the host is below the Tier-0 floor; nothing launched, said so. */
  | "deferred"
  /** Nothing to sequence: no cadence configured, verdict fresh, or another gate is busy. */
  | "not_due"
  /** The sequencing itself errored; the gate proceeds as if nothing was due. */
  | "error";

export interface BaseHealthSequenceOutcome {
  action: BaseHealthSequenceAction;
  /** What the gate message should say, or null when there is nothing worth saying. */
  note: string | null;
  /** How long the gate waited on a base-health run (0 when it did not). */
  waitedMs: number;
}

/** Injection seams for tests; every field defaults to the live service. */
export interface BaseHealthSequenceDeps {
  inFlight: (projectId: string) => Promise<BaseBranchVerifyResult | null> | null;
  sweepIntervalMs: (projectId: string, database: Database) => Promise<number | null>;
  resolveDue: (projectId: string, database: Database, intervalMs: number, nowMs: number) => Promise<BaseHealthDueVerdict>;
  runProbe: (projectId: string, database: Database) => Promise<BaseBranchVerifyResult | null>;
  notePhase: (workspaceId: string, detail: string) => void;
}

async function liveSweepIntervalMs(projectId: string, database: Database): Promise<number | null> {
  const prefMap = toPrefMap(await getAllPreferencesCached(database).catch(() => []));
  return resolveBaseSweepIntervalMs(resolveRiskPosture(prefMap, projectId));
}

const LIVE_DEPS: BaseHealthSequenceDeps = {
  inFlight: inFlightBaseBranchProbe,
  sweepIntervalMs: liveSweepIntervalMs,
  resolveDue: (projectId, database, intervalMs, nowMs) => resolveBaseHealthProbeDue(projectId, database, intervalMs, nowMs),
  runProbe: (projectId, database) => verifyBaseBranchHealth(projectId, database),
  notePhase: (workspaceId, detail) => noteMergeGatePhase(workspaceId, "queued", detail),
};

function describeResult(result: BaseBranchVerifyResult | null): string {
  if (!result) return "no verdict recorded";
  return `base ${result.outcome}`;
}

function seconds(ms: number): string {
  return `${Math.round(ms / 1000)}s`;
}

export async function sequenceBaseHealthBeforeVerify(args: {
  projectId: string;
  database: Database;
  workspaceId: string;
  deps?: Partial<BaseHealthSequenceDeps>;
}): Promise<BaseHealthSequenceOutcome> {
  const deps: BaseHealthSequenceDeps = { ...LIVE_DEPS, ...args.deps };
  const { projectId, database, workspaceId } = args;
  try {
    // 1. Reuse a run that is already under way.
    const running = deps.inFlight(projectId);
    if (running) {
      deps.notePhase(workspaceId, "waiting for the base-health run already in flight (#1009)");
      console.log(`[pre-merge-gate] workspace ${workspaceId}: a base-health run is already in flight for project ${projectId} — joining it before the branch verify (#1009)`);
      const startedAt = Date.now();
      // Demand is separate from admission: holding a slot while joining could deadlock a
      // probe that is still installing. Await its completion, including cancellation cleanup.
      const releaseDemand = registerVerifyChainGateDemand();
      const result = await running.catch(() => null).finally(releaseDemand);
      const waitedMs = Date.now() - startedAt;
      return {
        action: "joined",
        waitedMs,
        note: `base-health: joined an in-flight run before the branch verify (waited ${seconds(waitedMs)}, ${describeResult(result)})`,
      };
    }

    // 2. Launch only what the sweep would have launched: the posture-driven cadence, where
    //    null means the project never opted in (#983).
    const intervalMs = await deps.sweepIntervalMs(projectId, database);
    if (intervalMs === null) return { action: "not_due", note: null, waitedMs: 0 };

    const verdict = await deps.resolveDue(projectId, database, intervalMs, Date.now());
    if (verdict.reason === "host_saturated") {
      // 3. Below the floor: say so instead of starting a second full run.
      console.log(`[pre-merge-gate] workspace ${workspaceId}: base-health run for project ${projectId} DEFERRED — host below the Tier-0 floor (#1009)`);
      return {
        action: "deferred",
        waitedMs: 0,
        note: "base-health: DEFERRED, host below the free-RAM floor the monitor holds auto-starts at — the branch verify ran alone, the base was not re-measured",
      };
    }
    if (!verdict.due) return { action: "not_due", note: null, waitedMs: 0 };

    deps.notePhase(workspaceId, `running the base-health check first (${verdict.reason}, #1009)`);
    console.log(`[pre-merge-gate] workspace ${workspaceId}: base verdict for project ${projectId} is due (${verdict.reason}) — running base-health FIRST, then the branch verify, so the host sees one suite at a time (#1009)`);
    const startedAt = Date.now();
    const result = await deps.runProbe(projectId, database).catch(() => null);
    const waitedMs = Date.now() - startedAt;
    return {
      action: "ran_first",
      waitedMs,
      note: `base-health: ran FIRST (${verdict.reason}, ${seconds(waitedMs)}, ${describeResult(result)}) before the branch verify`,
    };
  } catch (err) {
    console.warn(`[pre-merge-gate] workspace ${workspaceId}: base-health sequencing failed (non-fatal, gate proceeds):`, errorMessage(err));
    return { action: "error", note: null, waitedMs: 0 };
  }
}
