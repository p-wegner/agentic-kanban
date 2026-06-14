import { and, eq, inArray } from "drizzle-orm";
import {
  drives,
  issueDependencies,
  issues,
  projectStatuses,
} from "@agentic-kanban/shared/schema";
import { syncCurrentNodeToStatus } from "@agentic-kanban/shared/lib/workflow-engine";
import { LEGACY_TERMINAL_STATUS_NAMES, isTerminalStatusView } from "@agentic-kanban/shared/lib/status-view";
import type { Database } from "../db/index.js";
import type { BoardEvents } from "../services/board-events.js";

/**
 * Encode the `drive-new-project` COMPLETION CONTRACT in the autodrive engine (#801).
 *
 * The contract was prose in the skill: "don't drop the meta/epic to Review until N/N
 * children are Done; drive the meta itself to Done only when the epic is complete."
 * A run that follows the skill by hand can still drop the meta to Review early and exit
 * (the #664 Star Raider failure: the epic exited at Review with children unfinished).
 * Encoding it here makes it a deterministic engine invariant rather than agent discipline.
 *
 * For every ACTIVE drive that has a meta issue:
 *  - While ANY child remains OPEN (not in a terminal status), the engine REFUSES to let
 *    the meta sit in In Review or Done — it pulls the meta back to In Progress so ownership
 *    of "finish the epic" is never dropped.
 *  - When ALL children are terminal (Done/Cancelled — N/N), the engine drives the meta
 *    itself to Done and marks the drive `completed`.
 *
 * Children are linked to the meta via `child_of` dependency edges
 * (`issue_dependencies.dependsOnId == metaIssueId AND type == "child_of"`), the same
 * linkage `create_sub_issue` / `create_issues_batch` write. A drive with no meta issue
 * or a meta with no children is a no-op (the contract has nothing to enforce yet).
 *
 * Runs each auto-merge-orchestrator tick, alongside reconcileCompletionStates. Returns the
 * number of drives whose meta status (or drive status) it changed.
 */
export async function reconcileDriveCompletion(
  database: Database,
  opts: {
    boardEvents?: BoardEvents;
    /** Current time override for testing. */
    now?: string;
  } = {},
): Promise<number> {
  const now = opts.now ?? new Date().toISOString();

  const activeDrives = await database
    .select({
      driveId: drives.id,
      projectId: drives.projectId,
      metaIssueId: drives.metaIssueId,
    })
    .from(drives)
    .where(eq(drives.status, "active"));

  const drivesWithMeta = activeDrives.filter(
    (d): d is typeof d & { metaIssueId: string } => d.metaIssueId != null,
  );
  if (drivesWithMeta.length === 0) return 0;

  let changed = 0;

  for (const drive of drivesWithMeta) {
    // Resolve the meta issue and its current status.
    const metaRows = await database
      .select({
        id: issues.id,
        projectId: issues.projectId,
        statusId: issues.statusId,
        statusName: projectStatuses.name,
        currentNodeId: issues.currentNodeId,
      })
      .from(issues)
      .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
      .where(eq(issues.id, drive.metaIssueId))
      .limit(1);
    const meta = metaRows[0];
    // Meta was deleted (the FK is `set null`, but the drive row may lag) — nothing to drive.
    if (!meta) continue;

    // Find the meta's children (issues with a `child_of` edge pointing at the meta).
    const childEdges = await database
      .select({ childId: issueDependencies.issueId })
      .from(issueDependencies)
      .where(
        and(
          eq(issueDependencies.dependsOnId, drive.metaIssueId),
          eq(issueDependencies.type, "child_of"),
        ),
      );
    const childIds = childEdges.map((e) => e.childId);
    // No children linked yet — the contract has nothing to enforce.
    if (childIds.length === 0) continue;

    const children = await database
      .select({
        id: issues.id,
        statusName: projectStatuses.name,
        currentNodeId: issues.currentNodeId,
      })
      .from(issues)
      .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
      .where(inArray(issues.id, childIds));

    const openChildren = children.filter(
      (c) => !isTerminalStatusView({ statusName: c.statusName, currentNodeId: c.currentNodeId }),
    );
    const allChildrenDone = openChildren.length === 0;

    // Resolve this project's status rows once for the moves we may need to make.
    const statuses = await database
      .select({ id: projectStatuses.id, name: projectStatuses.name })
      .from(projectStatuses)
      .where(eq(projectStatuses.projectId, drive.projectId));
    const findStatus = (name: string) => statuses.find((s) => s.name === name);

    const metaIsTerminal = LEGACY_TERMINAL_STATUS_NAMES.has(meta.statusName);
    const metaInReview = meta.statusName === "In Review" || meta.statusName === "AI Reviewed";

    if (!allChildrenDone) {
      // The contract: while children remain open, the meta must NOT sit in Review or Done.
      // Pull it back to In Progress so the drive keeps ownership of finishing the epic.
      if (metaIsTerminal || metaInReview) {
        const inProgress = findStatus("In Progress");
        if (!inProgress) {
          console.warn(
            `[drive-completion] drive ${drive.driveId}: meta ${meta.id} is in '${meta.statusName}' with ${openChildren.length}/${children.length} children still open, but project ${drive.projectId} has no 'In Progress' status — cannot enforce contract`,
          );
          continue;
        }
        await database
          .update(issues)
          .set({ statusId: inProgress.id, updatedAt: now })
          .where(eq(issues.id, meta.id));
        await syncCurrentNodeToStatus(database, meta.id).catch((err) =>
          console.warn("[drive-completion] syncCurrentNodeToStatus failed (non-fatal):", err),
        );
        console.log(
          `[drive-completion] drive ${drive.driveId}: refused to leave meta ${meta.id} in '${meta.statusName}' — ${openChildren.length}/${children.length} children still open; pulled back to In Progress`,
        );
        opts.boardEvents?.broadcast(drive.projectId, "issue_updated");
        changed++;
      }
      continue;
    }

    // N/N children terminal — drive the meta itself to Done (not Review) and finish the drive.
    if (!metaIsTerminal) {
      const done = findStatus("Done");
      if (!done) {
        console.warn(
          `[drive-completion] drive ${drive.driveId}: all ${children.length} children done but project ${drive.projectId} has no 'Done' status — cannot complete the meta`,
        );
        continue;
      }
      await database
        .update(issues)
        .set({ statusId: done.id, updatedAt: now })
        .where(eq(issues.id, meta.id));
      await syncCurrentNodeToStatus(database, meta.id).catch((err) =>
        console.warn("[drive-completion] syncCurrentNodeToStatus failed (non-fatal):", err),
      );
      console.log(
        `[drive-completion] drive ${drive.driveId}: all ${children.length} children done — drove meta ${meta.id} to Done`,
      );
      opts.boardEvents?.broadcast(drive.projectId, "issue_updated");
      changed++;
    }

    // Mark the drive completed once the meta is Done (whether we just moved it or it
    // already was). finishedAt is stamped so the drive is observably complete.
    await database
      .update(drives)
      .set({ status: "completed", finishedAt: now })
      .where(eq(drives.id, drive.driveId));
    console.log(`[drive-completion] drive ${drive.driveId} marked completed (meta ${meta.id} Done, ${children.length}/${children.length} children)`);
    changed++;
  }

  return changed;
}
