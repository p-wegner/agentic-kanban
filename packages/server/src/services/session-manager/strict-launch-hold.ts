// HOLD a strict-dispatch launch while the worker that would take it is briefly away (#1347).
//
// With `--auto-update` every base-branch change drains the fleet's workers for a couple of
// minutes. A strict project cannot fall back to the host, so a launch landing in that window
// used to create a host session row and fail it (`exit 1`), and nothing retried. Now the launch
// waits — BEFORE any session row exists — and goes ahead when the worker is back; if none
// returns within the bound it fails exactly as it always did.
import type { Database } from "../../db/index.js";
import type { ProviderName } from "../agent-provider.js";
import { checkStrictLaunchReadiness, type StrictHoldReason } from "../worker-fleet.service.js";
import { WorkspaceError } from "../workspace-internals.js";

/** How long a held launch waits for its worker. A self-update takes ~2 min; this is generous. */
export const STRICT_HOLD_TIMEOUT_MS = 5 * 60_000;
export const STRICT_HOLD_POLL_MS = 2_000;

export interface LaunchHold {
  reason: StrictHoldReason;
  workerId: string;
  /** ISO time the hold began. */
  since: string;
}

const holds = new Map<string, LaunchHold>();

/** The hold a workspace's pending launch is under, for the surfaces that show it. */
export function getLaunchHold(workspaceId: string): LaunchHold | undefined {
  return holds.get(workspaceId);
}

export interface StrictHoldDeps {
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  pollMs?: number;
}

/**
 * Resolve once a strict launch may proceed; throw `NO_AVAILABLE_WORKER` (before any session row)
 * when no worker is eligible and none is about to be, or when the hold times out.
 */
export async function awaitStrictLaunchWorker(
  args: {
    database: Database;
    workspaceId: string;
    projectId: string;
    providerName: ProviderName;
    /** An explicit placement was supplied: nothing to wait for. */
    explicitPlacement?: boolean;
  },
  deps: StrictHoldDeps = {},
): Promise<void> {
  const { database, workspaceId, projectId, providerName } = args;
  if (args.explicitPlacement || !projectId) return;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const timeoutMs = deps.timeoutMs ?? STRICT_HOLD_TIMEOUT_MS;
  const pollMs = deps.pollMs ?? STRICT_HOLD_POLL_MS;
  const since = new Date().toISOString();
  // The bound is counted in polls, not read off a clock: the wait is made of `sleep(pollMs)`
  // calls, so the time spent is exactly polls * pollMs and a test needs no fake timers.
  let waitedMs = 0;
  try {
    for (;;) {
      const verdict = await checkStrictLaunchReadiness({ database, projectId, providerName });
      if (verdict.kind === "proceed") return;
      if (verdict.kind === "refuse") {
        throw new WorkspaceError(verdict.reason, "CONFLICT", { code: "NO_AVAILABLE_WORKER" });
      }
      if (waitedMs >= timeoutMs) {
        throw new WorkspaceError(
          `${verdict.reason} for ${Math.round(timeoutMs / 1000)}s (worker ${verdict.workerId} did not return) and worker dispatch is strict`,
          "CONFLICT",
          { code: "NO_AVAILABLE_WORKER", heldFor: verdict.reason },
        );
      }
      if (!holds.has(workspaceId)) {
        console.log(`[session] holding strict launch for workspace ${workspaceId}: ${verdict.reason} (worker ${verdict.workerId})`);
      }
      holds.set(workspaceId, { reason: verdict.reason, workerId: verdict.workerId, since });
      await sleep(pollMs);
      waitedMs += pollMs;
    }
  } finally {
    holds.delete(workspaceId);
  }
}
