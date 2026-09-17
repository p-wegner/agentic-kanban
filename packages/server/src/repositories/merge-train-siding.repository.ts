import { eq } from "drizzle-orm";
import { issues, workspaces, workspaceTrainSiding } from "@agentic-kanban/shared/schema";
import type { MergeTrainSidingDto } from "@agentic-kanban/shared";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

/**
 * The one owner of merge-train siding persistence (#1192). The row IS the wire shape
 * (#1198: `GET /api/merge-queue/trains` lists a project's sidings), so it is the shared DTO
 * rather than a second declaration of the same six fields.
 */
export type TrainSidingRow = MergeTrainSidingDto;

export async function getTrainSidingState(
  workspaceId: string,
  database: Database = db,
): Promise<TrainSidingRow | undefined> {
  const [row] = await database
    .select()
    .from(workspaceTrainSiding)
    .where(eq(workspaceTrainSiding.workspaceId, workspaceId))
    .limit(1);
  return row;
}

export async function setTrainSidingState(
  workspaceId: string,
  state: {
    sidings: number;
    sidedBranchSha: string | null;
    conflictTrainTipSha: string | null;
    lastSidedAt: string;
    cappedAt: string | null;
  },
  database: Database = db,
): Promise<void> {
  const values = { workspaceId, ...state };
  await database
    .insert(workspaceTrainSiding)
    .values(values)
    .onConflictDoUpdate({
      target: workspaceTrainSiding.workspaceId,
      set: {
        sidings: values.sidings,
        sidedBranchSha: values.sidedBranchSha,
        conflictTrainTipSha: values.conflictTrainTipSha,
        lastSidedAt: values.lastSidedAt,
        cappedAt: values.cappedAt,
      },
    });
}

/** Drop the siding record — the branch moved (rebased) or the member finally landed. */
export async function clearTrainSidingState(workspaceId: string, database: Database = db): Promise<void> {
  await database.delete(workspaceTrainSiding).where(eq(workspaceTrainSiding.workspaceId, workspaceId));
}

/**
 * Every live siding in a project (#1198), via workspace -> issue -> project: the siding table
 * carries only the workspace id. Oldest siding first, so a member held the longest is listed
 * first.
 */
export async function listTrainSidingStatesForProject(
  projectId: string,
  database: Database = db,
): Promise<TrainSidingRow[]> {
  const rows = await database
    .select({
      workspaceId: workspaceTrainSiding.workspaceId,
      sidings: workspaceTrainSiding.sidings,
      sidedBranchSha: workspaceTrainSiding.sidedBranchSha,
      conflictTrainTipSha: workspaceTrainSiding.conflictTrainTipSha,
      lastSidedAt: workspaceTrainSiding.lastSidedAt,
      cappedAt: workspaceTrainSiding.cappedAt,
    })
    .from(workspaceTrainSiding)
    .innerJoin(workspaces, eq(workspaces.id, workspaceTrainSiding.workspaceId))
    .innerJoin(issues, eq(issues.id, workspaces.issueId))
    .where(eq(issues.projectId, projectId))
    .orderBy(workspaceTrainSiding.lastSidedAt);
  return rows;
}
