// Board half of install-on-request (#1371). When a worker is out of a placement ONLY because it lacks
// toolchains, ask it (a `toolchain_install` frame) to install them through mise — if ITS OWN policy allows.
// The board never forces: the policy matrix is evaluated here to explain and to avoid pointless requests,
// and again on the worker, which has the last word. Pure over its inputs (registry views + a send function).
import { randomUUID } from "node:crypto";
import { decideToolchainInstall, type ToolchainInstallRecord } from "@agentic-kanban/shared/lib/worker-toolchain-install";
import {
  formatToolchainRequirement,
  parseRequiredToolchains,
  splitRequirements,
  toolchainSatisfies,
  type ToolchainRequirement,
} from "@agentic-kanban/shared/lib/worker-toolchains";
import type { WorkerView } from "./worker-registry.service.js";

/** A failed install is not re-requested for the same toolchains until this long has passed. */
export const TOOLCHAIN_INSTALL_RETRY_MS = 15 * 60_000;
/** How long a `done` report may lag the worker's refreshed toolchain heartbeat before it is re-requested. */
export const TOOLCHAIN_DONE_GRACE_MS = 2 * 60_000;

export interface ToolchainInstallOutcome {
  /** A worker that is installing (or waiting on its owner's approval): the launch should wait for it. */
  active?: { workerId: string; state: "pending" | "installing" };
  /** Why a worker that lacks toolchains will NOT be asked / cannot install, for the refusal message. */
  blocked: Array<{ workerId: string; name: string; reason: string }>;
}

export interface ToolchainInstallDeps {
  /** Send the frame; false when the worker's socket is gone. */
  send: (workerId: string, frame: { type: "toolchain_install"; requestId: string; toolchains: string[] }) => boolean;
  record: (workerId: string, requestId: string, toolchains: string[], nowMs: number) => void;
  /** Connected + responsive? Only a worker that can hear the request is worth asking. */
  reachable: (workerId: string) => boolean;
  nowMs?: number;
}

/** The requirements this worker still lacks (it reported toolchains and misses some). */
function lacking(view: WorkerView, required: readonly ToolchainRequirement[]): ToolchainRequirement[] {
  const have = view.toolchains;
  if (!have) return [];
  return required.filter((r) => !toolchainSatisfies(have, r));
}

function sameSet(record: ToolchainInstallRecord, wanted: string[]): boolean {
  return record.toolchains.length === wanted.length && wanted.every((w) => record.toolchains.includes(w));
}

/**
 * Walk the workers that failed a placement only on toolchains (the caller passes workers that already
 * pass provider + plain labels) and ask the ones whose policy allows it. Idempotent: a request already
 * in flight for the same toolchains is not repeated.
 */
export function requestToolchainInstalls(
  candidates: readonly WorkerView[],
  requirements: readonly string[],
  deps: ToolchainInstallDeps,
): ToolchainInstallOutcome {
  const nowMs = deps.nowMs ?? Date.now();
  const { toolchains: required } = splitRequirements(requirements);
  const outcome: ToolchainInstallOutcome = { blocked: [] };
  for (const view of candidates) {
    const missing = lacking(view, required);
    if (missing.length === 0 || !deps.reachable(view.id)) continue;
    const wanted = missing.map(formatToolchainRequirement);
    const record = view.toolchainInstall;
    if (record && sameSet(record, wanted)) {
      if (record.state === "pending" || record.state === "installing") {
        outcome.active ??= { workerId: view.id, state: record.state };
        continue;
      }
      // done but still lacking = the worker's toolchain report has not refreshed yet: it is about to be eligible.
      // A `done` that stays stale (install since removed, worker restarted) must not hold forever: re-request.
      if (record.state === "done") {
        if (nowMs - record.updatedAtMs < TOOLCHAIN_DONE_GRACE_MS) {
          outcome.active ??= { workerId: view.id, state: "installing" };
          continue;
        }
      } else if (nowMs - record.updatedAtMs < TOOLCHAIN_INSTALL_RETRY_MS) {
        outcome.blocked.push({ workerId: view.id, name: view.name, reason: `toolchain install failed: ${record.reason ?? "unknown reason"}` });
        continue;
      }
    }
    const decision = decideToolchainInstall(view.toolchainInstallPolicy, missing);
    if (decision.action === "blocked") {
      outcome.blocked.push({ workerId: view.id, name: view.name, reason: decision.reason });
      continue;
    }
    const requestId = randomUUID();
    if (!deps.send(view.id, { type: "toolchain_install", requestId, toolchains: wanted })) continue;
    deps.record(view.id, requestId, wanted, nowMs);
    outcome.active ??= { workerId: view.id, state: "pending" };
  }
  return outcome;
}

/** A short suffix for explain/refusal text: why this worker's missing toolchains will or will not be installed. */
export function describeInstallOutlook(
  view: Pick<WorkerView, "toolchainInstallPolicy" | "toolchainInstall">,
  missing: string[],
): string {
  const r = view.toolchainInstall;
  if (r && (r.state === "pending" || r.state === "installing")) {
    return ` (install ${r.state}${r.state === "pending" && r.reason ? `: ${r.reason}` : ""})`;
  }
  if (r && r.state === "failed") return ` (install failed: ${r.reason ?? "unknown reason"})`;
  const decision = decideToolchainInstall(view.toolchainInstallPolicy, parseRequiredToolchains(missing.join(",")));
  if (decision.action === "blocked") return ` (cannot install: ${decision.reason})`;
  return decision.action === "await-approval" ? " (install needs the worker owner's approval)" : " (install on request)";
}
