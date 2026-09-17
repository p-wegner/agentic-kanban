import { eq } from "drizzle-orm";
import { workspaceTrainSiding } from "@agentic-kanban/shared/schema";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

/** The one owner of merge-train siding persistence (#1192). */
export interface TrainSidingRow {
  workspaceId: string;
  sidings: number;
  sidedBranchSha: string | null;
  conflictTrainTipSha: string | null;
  lastSidedAt: string | null;
  cappedAt: string | null;
}

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
