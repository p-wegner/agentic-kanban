// Where a verify chain runs, and whether a worker's verdict may be believed (#1428).
//
// The board host is the only place that runs pre-merge gates, implement-exit checks, train gates
// and the rc sweep `pnpm promote` waits for, and a host with 1-3 GB free HOLDS them (#1057). This
// module is the POLICY half of moving them to a fleet worker: pure decisions, no socket, no db,
// so every rule is a table of cheap cases.
//
// Three rules, each load-bearing:
//   1. DEFAULT IS `host` — an unset or unparseable setting changes nothing (a typo must not move
//      gates onto another machine).
//   2. ONLY ALLOWLISTED WORKERS RUN GATES. A verdict authorizes a merge or a promotion, so a
//      worker that merely carries the right labels is not enough; the project names who may.
//      An EMPTY allowlist means no worker is trusted — fail closed, unlike worker dispatch.
//   3. A VERDICT IS PINNED TO THE SHA THE BOARD SENT. `acceptWorkerVerdict` refuses a green for
//      any other tree, and refuses a green with no sha at all.
import { projectPref } from "@agentic-kanban/shared/lib/dynamic-preference-keys";

export const VERIFY_PLACEMENTS = ["host", "worker", "prefer-worker"] as const;
export type VerifyPlacement = (typeof VERIFY_PLACEMENTS)[number];

/** The four kinds of verify chain that can be placed. */
export type VerifyChainKind = "workspace-gate" | "implement-exit" | "train-gate" | "rc-sweep";

export const verifyPlacementPrefKey = (projectId: string): string => projectPref("verify_placement").key(projectId);
export const verifyWorkersPrefKey = (projectId: string): string => projectPref("verify_workers").key(projectId);

/** Unset, empty or unrecognised reads as `host`: today's behaviour. */
export function parseVerifyPlacement(raw: string | undefined | null): VerifyPlacement {
  const v = raw?.trim().toLowerCase();
  return (VERIFY_PLACEMENTS as readonly string[]).includes(v ?? "") ? (v as VerifyPlacement) : "host";
}

/** CSV of worker names or ids → a lower-cased set. Empty = nobody is trusted. */
export function parseVerifyWorkerAllowlist(raw: string | undefined | null): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** A connected worker as the placement sees it. */
export type VerifyWorkerCandidate = {
  id: string;
  name: string;
  /** Free verify-chain slots (cap − load); a worker with none is not offered. */
  freeSlots: number;
  freeRamGb?: number;
  thrashing?: boolean;
};

export type VerifyPlacementDecision =
  | { target: "host"; reason: string }
  | { target: "worker"; workerId: string; workerName: string; reason: string }
  /** `worker` placement with nobody eligible: the chain waits (held) rather than running on the host. */
  | { target: "hold"; reason: string };

export function isWorkerTrusted(allowlist: Set<string>, worker: Pick<VerifyWorkerCandidate, "id" | "name">): boolean {
  return allowlist.has(worker.id.toLowerCase()) || allowlist.has(worker.name.toLowerCase());
}

/** Eligible = allowlisted, has a free slot. Best first: calm, then most free RAM, then name (stable). */
export function rankVerifyWorkers(allowlist: Set<string>, workers: VerifyWorkerCandidate[]): VerifyWorkerCandidate[] {
  return workers
    .filter((w) => w.freeSlots > 0 && isWorkerTrusted(allowlist, w))
    .sort(
      (a, b) =>
        Number(a.thrashing ?? false) - Number(b.thrashing ?? false) ||
        (b.freeRamGb ?? -1) - (a.freeRamGb ?? -1) ||
        a.name.localeCompare(b.name),
    );
}

/**
 * Decide where one chain runs.
 *  - `host`: always the host (no behaviour change).
 *  - `prefer-worker`: a worker when the host would hold the chain for memory; otherwise the host.
 *    With no eligible worker it falls back to the host's own admission (hold or run) — it never
 *    makes things worse than `host`.
 *  - `worker`: always a worker; with none eligible the chain is held, never run on the host.
 */
export function decideVerifyPlacement(input: {
  placement: VerifyPlacement;
  kind: VerifyChainKind;
  /** The host's own admission said "held for memory" (#1057). */
  hostHeld: boolean;
  allowlist: Set<string>;
  workers: VerifyWorkerCandidate[];
}): VerifyPlacementDecision {
  const { placement, kind, hostHeld, allowlist, workers } = input;
  if (placement === "host") return { target: "host", reason: "verify_placement=host" };
  if (placement === "prefer-worker" && !hostHeld) {
    return { target: "host", reason: "verify_placement=prefer-worker, host has room" };
  }
  const best = rankVerifyWorkers(allowlist, workers)[0];
  if (best) {
    return {
      target: "worker",
      workerId: best.id,
      workerName: best.name,
      reason: `${kind} placed on ${best.name} (verify_placement=${placement}${hostHeld ? ", host held for memory" : ""})`,
    };
  }
  const why =
    allowlist.size === 0
      ? "no worker is allowlisted (verify_workers is empty)"
      : "no allowlisted worker is online with a free slot";
  return placement === "worker"
    ? { target: "hold", reason: `verify_placement=worker but ${why}` }
    : { target: "host", reason: `verify_placement=prefer-worker but ${why}; host admission applies` };
}

/** What a worker reports for one verify run it was sent. */
export type WorkerVerifyReport = {
  requestId: string;
  workerId: string;
  /** The tree the worker says it verified. */
  sha: string;
  tier: string;
  passed: boolean;
  log?: string;
};

/** What the board sent. The report is judged against THIS, never against itself. */
export type VerifyRequest = {
  requestId: string;
  workerId: string;
  sha: string;
  tier: string;
};

export type VerdictAcceptance = { accepted: true; verdict: "green" | "red" } | { accepted: false; reason: string };

/**
 * Trust boundary for a worker verdict. A report is accepted only from the worker the request went
 * to, for the request it answers, with the sha the board sent and the tier it asked for. A mismatch
 * is refused outright — in BOTH directions: a "red" for another tree proves nothing either, and
 * accepting it would let a worker park a merge it should not be able to touch.
 */
export function acceptWorkerVerdict(request: VerifyRequest, report: WorkerVerifyReport, allowlist: Set<string>, workerName: string): VerdictAcceptance {
  if (!isWorkerTrusted(allowlist, { id: request.workerId, name: workerName })) {
    return { accepted: false, reason: `worker ${workerName} is not on the verify_workers allowlist` };
  }
  if (report.requestId !== request.requestId) return { accepted: false, reason: "verdict answers a different request" };
  if (report.workerId !== request.workerId) return { accepted: false, reason: "verdict came from a worker the request was not sent to" };
  if (!report.sha || report.sha.toLowerCase() !== request.sha.toLowerCase()) {
    return { accepted: false, reason: `verdict is for ${report.sha || "no sha"}, the board sent ${request.sha}` };
  }
  if (report.tier !== request.tier) return { accepted: false, reason: `verdict ran tier ${report.tier}, the board asked for ${request.tier}` };
  return { accepted: true, verdict: report.passed ? "green" : "red" };
}

/** How a placed chain reads on the watch view and in /api/workers. */
export type PlacedChain = { chainId: string; kind: VerifyChainKind; sha: string; tier: string; startedAt: string };

export function describePlacedChain(chain: PlacedChain, workerName: string): string {
  return `${chain.kind} ${chain.sha.slice(0, 9)} (${chain.tier}) on ${workerName}`;
}
