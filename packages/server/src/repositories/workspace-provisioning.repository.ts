import { eq, ne } from "drizzle-orm";
import { workspaceProvisioning } from "@agentic-kanban/shared/schema";
import { db } from "../db/index.js";
import type { Database, TransactionClient } from "../db/index.js";

export type ProvisioningPhase = "worktree" | "siblings" | "context" | "committing";

export interface ProvisioningRecord {
  id: string;
  issueId: string;
  projectId: string;
  branch: string | null;
  worktreePath: string | null;
  serverPid: number;
  phase: string;
  startedAt: string;
}

/**
 * Mark a workspace create as in flight (#630). Written BEFORE the worktree is provisioned,
 * so an interrupted create is visible rather than silent debris. See the table's own doc.
 */
export async function beginProvisioning(
  record: Omit<ProvisioningRecord, "serverPid" | "phase" | "startedAt"> & { phase?: ProvisioningPhase },
  database: Database = db,
): Promise<void> {
  await database
    .insert(workspaceProvisioning)
    .values({
      id: record.id,
      issueId: record.issueId,
      projectId: record.projectId,
      branch: record.branch,
      worktreePath: record.worktreePath,
      serverPid: process.pid,
      phase: record.phase ?? "worktree",
      startedAt: new Date().toISOString(),
    })
    .onConflictDoNothing();
}

/** Advance the marker so an abandoned create can report WHERE it died, not just that it did. */
export async function updateProvisioning(
  id: string,
  patch: { phase?: ProvisioningPhase; branch?: string | null; worktreePath?: string | null },
  database: Database = db,
): Promise<void> {
  await database.update(workspaceProvisioning).set(patch).where(eq(workspaceProvisioning.id, id));
}

/**
 * Clear the marker. Called inside the transaction that inserts the real workspace row, and
 * on the failure path after the compensating worktree rollback — so a surviving row always
 * means "died mid-create", never "finished" or "cleanly failed".
 */
export async function finishProvisioning(id: string, database: Database | TransactionClient = db): Promise<void> {
  await database.delete(workspaceProvisioning).where(eq(workspaceProvisioning.id, id));
}

/**
 * Records left behind by a process that is no longer this one — i.e. abandoned creates.
 * Read at startup; scoping by pid (rather than taking every row) keeps a second board
 * process on another port from reporting a live create as abandoned.
 */
export async function listAbandonedProvisioning(database: Database = db): Promise<ProvisioningRecord[]> {
  return database
    .select()
    .from(workspaceProvisioning)
    .where(ne(workspaceProvisioning.serverPid, process.pid)) as Promise<ProvisioningRecord[]>;
}
