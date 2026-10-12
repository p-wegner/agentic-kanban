import type { Database } from "../db/index.js";
import { findRecentMergeTrainsForWorkspaces } from "../repositories/merge-train.repository.js";
import { resolveProjectId } from "../repositories/workspace.repository.js";
import { isMergeTrainLive } from "./merge-train-live-registry.js";
import { WorkspaceError } from "./workspace-error.js";

/**
 * #1418 — the live merge train this workspace's branch is aboard, if any.
 *
 * A launch or send-back moves the member's branch under the train, and the train's ancestry
 * invariant then throws and discards its (possibly already green) fix-agent work. "Live" means
 * the row is active AND a job in THIS process is running it: a stranded `gating` row with no job
 * behind it is the reconciler's to clean up and must not lock the workspace out forever.
 */
export async function findLiveTrainForWorkspace(
  database: Database,
  workspaceId: string,
): Promise<{ trainId: string; label: string } | null> {
  const projectId = await resolveProjectId(workspaceId, database);
  if (!projectId) return null;
  const trains = await findRecentMergeTrainsForWorkspaces(projectId, [workspaceId], database);
  const train = trains.get(workspaceId);
  if (!train) return null;
  const active = train.state === "assembling" || train.state === "gating" || train.state === "landing";
  if (!active || !isMergeTrainLive(train.id)) return null;
  return { trainId: train.id, label: train.label };
}

/** Refuse a launch/send-back that would move a live train member's branch (#1418). `force` bypasses. */
export async function assertNotInLiveTrain(
  database: Database,
  workspaceId: string,
  action: "launch" | "send-back",
  force = false,
): Promise<void> {
  if (force) return;
  const train = await findLiveTrainForWorkspace(database, workspaceId);
  if (!train) return;
  console.warn(`[workspace-session] ${action} refused, live train member: workspaceId=${workspaceId} train=${train.label}`);
  throw new WorkspaceError(
    `Workspace is in train ${train.label}, which is still running: a ${action} would move its branch under the train ` +
      `and discard the train's work. Wait for the train to finish (or cancel it), then retry. Pass force=true to override.`,
    "CONFLICT",
    { reason: "IN_LIVE_TRAIN", trainId: train.trainId, trainLabel: train.label },
  );
}
