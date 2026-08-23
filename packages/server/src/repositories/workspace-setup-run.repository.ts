import { eq } from "drizzle-orm";
import { workspaceSetupRun } from "@agentic-kanban/shared/schema";
import { db } from "../db/index.js";
import type { Database, TransactionClient } from "../db/index.js";

/**
 * The one owner of setup-script run persistence, over its own table (#815).
 *
 * The eight `latest_setup_*` columns used to sit on `workspaces`. Re-derived on the column
 * names AND the camelCase fields, six non-test files named them against the table: the
 * schema, the creation write (`services/workspace-create.service.ts`), the post-run update
 * (`repositories/workspace-crud.repository.ts`), the born-blocked restamp
 * (`startup/born-blocked-reconciler.ts`) and the two reads (`issue.repository.ts`,
 * `workspace-reads.repository.ts`). Both reads alias the new columns back to the old
 * `latestSetup*` field names, so the projection, the DTO, the timeline service, the
 * launch-failure classifier and the five client components are untouched.
 *
 * This follows `workspace-symlink-run.repository.ts` (#798) almost verbatim: written once at
 * creation inside the workspace's own transaction — including the `state: "skipped"` run a
 * project with no setup script produces, because that is what the columns held and the
 * projection distinguishes it from "no record at all".
 *
 * An ABSENT row means "no setup run recorded", which is what a NULL `latest_setup_state`
 * meant; the projection maps it to `latestSetup: null`. The reads therefore LEFT JOIN.
 */

/** The run record as the create path builds it (`workspace-run-records.ts`). */
export interface SetupRunValues {
  command: string | null;
  state: string;
  startedAt: string | null;
  endedAt: string | null;
  exitCode: number | null;
  durationMs: number | null;
  stdoutTail: string | null;
  stderrTail: string | null;
}

export async function insertWorkspaceSetupRun(
  workspaceId: string,
  values: SetupRunValues,
  database: Database | TransactionClient = db,
): Promise<void> {
  await database.insert(workspaceSetupRun).values({ workspaceId, ...values });
}

/**
 * Replace the whole record after a re-run.
 *
 * Upsert, not update: the columns were always present on the workspace row, so a write could
 * never miss. A workspace whose eight columns were all NULL got no backfill row, and this
 * must still record its first run rather than silently no-op.
 */
export async function updateWorkspaceSetupRun(
  workspaceId: string,
  values: SetupRunValues,
  database: Database | TransactionClient = db,
): Promise<void> {
  await database.insert(workspaceSetupRun).values({ workspaceId, ...values })
    .onConflictDoUpdate({ target: workspaceSetupRun.workspaceId, set: { ...values } });
}

/**
 * The born-blocked reconciler's partial restamp: a fresh verdict for a retried setup, leaving
 * `command` / `startedAt` / `durationMs` / `stdoutTail` as they were.
 *
 * Kept separate from `updateWorkspaceSetupRun` because it is genuinely a PARTIAL write — the
 * four columns it used to set are the four that make the verdict dated and readable, and
 * widening it to the full record would invent values for the other four. On a workspace with
 * no record at all it inserts one, which is what the four-column UPDATE effectively did.
 */
export async function restampWorkspaceSetupRun(
  workspaceId: string,
  verdict: { state: string; endedAt: string; exitCode: number; stderrTail: string },
  database: Database | TransactionClient = db,
): Promise<void> {
  await database.insert(workspaceSetupRun).values({ workspaceId, ...verdict })
    .onConflictDoUpdate({ target: workspaceSetupRun.workspaceId, set: { ...verdict } });
}

/** The run for one workspace, or `undefined` when none was ever recorded. */
export async function getWorkspaceSetupRun(
  workspaceId: string,
  database: Database = db,
): Promise<typeof workspaceSetupRun.$inferSelect | undefined> {
  const [row] = await database.select().from(workspaceSetupRun)
    .where(eq(workspaceSetupRun.workspaceId, workspaceId)).limit(1);
  return row;
}
