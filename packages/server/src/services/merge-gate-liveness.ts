/**
 * #1525: a WORKSPACE pre-merge gate is only worth its slot while the workspace is still open and
 * the branch head is the sha the gate started on. A gate that outlives either (the workspace
 * merged/closed, or a newer commit superseded it) verifies nothing anyone will use, and its
 * failure would be retried for a workspace that no longer exists. This watcher polls both and
 * cancels the gate through the same registry `merge/cancel` uses (#1164), which also cancels a
 * worker-placed job (#1489).
 */
import type { Database } from "../db/index.js";
import { getWorkspaceStatus } from "../repositories/merge-queue.repository.js";
import { requestMergeGateCancellation } from "./merge-cancellation.js";
import { readHeadSha } from "./verify-job-placement.js";

export const GATE_LIVENESS_CLOSED_STATUSES: ReadonlySet<string> = new Set(["closed", "merged"]);
export const GATE_LIVENESS_INTERVAL_MS = 30_000;

export interface GateLivenessDeps {
  readStatus?: (workspaceId: string, database: Database) => Promise<string | undefined>;
  readHead?: (workingDir: string) => Promise<string>;
  intervalMs?: number;
  cancel?: (workspaceId: string) => boolean;
}

/** Why the gate is no longer wanted, or null while it still is. */
export async function gateObsoleteReason(
  args: { workspaceId: string; workingDir: string | null; startSha: string; database: Database },
  deps: GateLivenessDeps = {},
): Promise<string | null> {
  const status = await (deps.readStatus ?? getWorkspaceStatus)(args.workspaceId, args.database);
  if (status && GATE_LIVENESS_CLOSED_STATUSES.has(status)) return `its workspace is now ${status}`;
  if (args.startSha && args.workingDir) {
    const head = await (deps.readHead ?? readHeadSha)(args.workingDir);
    if (head && head !== args.startSha) return `the branch head moved on from ${args.startSha.slice(0, 8)} to ${head.slice(0, 8)}`;
  }
  return null;
}

/** Starts the watcher for a workspace gate (train gates are skipped); returns its stop function. */
export function watchGateLiveness(
  args: { workspaceId: string; workingDir: string | null; database: Database },
  deps: GateLivenessDeps = {},
): () => void {
  if (args.workspaceId.startsWith("train:")) return () => undefined;
  let startSha = "";
  let ready = false;
  const init = (deps.readHead ?? readHeadSha)(args.workingDir ?? "").then((s) => { startSha = s; }, () => undefined).finally(() => { ready = true; });
  void init;
  let done = false;
  const timer = setInterval(() => {
    if (!ready || done) return;
    void gateObsoleteReason({ ...args, startSha }, deps).then((reason) => {
      if (!reason || done) return;
      done = true;
      console.warn(`[pre-merge-gate] cancelling the gate for workspace ${args.workspaceId}: ${reason}`);
      (deps.cancel ?? requestMergeGateCancellation)(args.workspaceId);
    }).catch(() => undefined);
  }, deps.intervalMs ?? GATE_LIVENESS_INTERVAL_MS);
  timer.unref?.();
  return () => { done = true; clearInterval(timer); };
}
