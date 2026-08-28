// @gate:always-run — the backfill assertion reads the 0134 migration .sql off disk, which is
// not in this file's import graph (#798).
// @covers review-merge.reconcile.stranded-review [persistence,state-transition,migration]
/**
 * #798 — review-preflight backoff lives in `workspace_review_preflight`, not in four
 * `review_preflight_*` columns on `workspaces`.
 *
 * The second of #739's eleven column families, extracted after #781 did `merge_backoff_*`.
 * Every assertion here fails BEFORE the extraction (the columns exist, the table does not),
 * and the interesting ones fail on a NAIVE extraction too:
 *
 *  - `getReviewPreflightBlock` must return `failures: 0` for a workspace with no block and
 *    `undefined` only for a workspace that does not exist. That distinction was free while
 *    the columns sat on the row; selecting straight from the new table collapses it. It is
 *    the same trap #781 measured, and it is preserved here by the same LEFT JOIN.
 *  - The migration must BACKFILL. Losing it would un-block every workspace the reconciler
 *    had given up on, and the next cycle would re-run the most expensive git operation the
 *    board runs against each of them — the exact incident #283 exists to prevent.
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "@agentic-kanban/shared/schema";
import { issues, projectStatuses, projects, workspaceReviewPreflight, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { MIGRATION_FILES, MIGRATIONS_DIR, readMigrationStatements } from "./helpers/migrations.js";
import {
  clearReviewPreflightBlockRow,
  getReviewPreflightBlock,
  setReviewPreflightBlock,
} from "../repositories/review-preflight.repository.js";

const T0 = "2026-08-23T00:00:00.000Z";
const MIGRATION_0134 = "0134_workspace_review_preflight.sql";

type Db = ReturnType<typeof createTestDb>["db"];

const STATE = {
  failures: 3,
  error: "Rebase conflict during review preflight: 2 file(s) conflict.",
  signature: "head1..base1",
  blockedAt: "2026-08-23T00:30:00.000Z",
};

const NEVER_BLOCKED = { failures: 0, error: null, signature: null, blockedAt: null };

function columnNames(rows: readonly unknown[]): string[] {
  return rows.map((r) => String((r as { name: string }).name));
}

async function seedWorkspace(db: Db): Promise<string> {
  const projectId = randomUUID();
  const statusId = randomUUID();
  const issueId = randomUUID();
  const workspaceId = randomUUID();
  await db.insert(projects).values({
    id: projectId, name: "Test", repoPath: "/repo", repoName: "repo",
    defaultBranch: "master", createdAt: T0, updatedAt: T0,
  });
  await db.insert(projectStatuses).values({
    id: statusId, projectId, name: "In Review", sortOrder: 2, isDefault: false, createdAt: T0,
  });
  await db.insert(issues).values({
    id: issueId, issueNumber: 1, title: "Issue 1", priority: "medium", sortOrder: 0,
    statusId, projectId, createdAt: T0, updatedAt: T0,
  });
  await db.insert(workspaces).values({
    id: workspaceId, issueId, branch: "feature/ak-1", workingDir: "/repo/.worktrees/ws",
    baseBranch: "master", status: "idle", provider: "claude", createdAt: T0, updatedAt: T0,
  });
  return workspaceId;
}

describe("review-preflight extraction (#798)", () => {
  it("the four review_preflight_* columns are gone from workspaces", async () => {
    const { client } = createTestDb();
    const info = await client.execute('PRAGMA table_info("workspaces")');
    expect(columnNames(info.rows).filter((n) => n.startsWith("review_preflight_"))).toEqual([]);
    // The concern moved rather than vanished.
    const moved = await client.execute('PRAGMA table_info("workspace_review_preflight")');
    expect(columnNames(moved.rows).sort()).toEqual([
      "blocked_at", "error", "failures", "signature", "workspace_id",
    ]);
  });

  it("a block is stored in workspace_review_preflight and read back through the repository", async () => {
    const { db } = createTestDb();
    const workspaceId = await seedWorkspace(db);

    await setReviewPreflightBlock(workspaceId, STATE, db);

    const rows = await db.select().from(workspaceReviewPreflight)
      .where(eq(workspaceReviewPreflight.workspaceId, workspaceId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject(STATE);
    expect(await getReviewPreflightBlock(workspaceId, db)).toEqual(STATE);
  });

  it("re-recording a failure updates the one row rather than adding a second", async () => {
    const { db } = createTestDb();
    const workspaceId = await seedWorkspace(db);

    await setReviewPreflightBlock(workspaceId, { ...STATE, failures: 1, blockedAt: null }, db);
    await setReviewPreflightBlock(workspaceId, STATE, db);

    expect(await db.select().from(workspaceReviewPreflight)).toHaveLength(1);
    expect(await getReviewPreflightBlock(workspaceId, db)).toEqual(STATE);
  });

  it("distinguishes 'no block' from 'no such workspace' — the trap #781 measured", async () => {
    const { db } = createTestDb();
    const workspaceId = await seedWorkspace(db);

    // A real workspace that never failed a preflight: not blocked, but it EXISTS.
    expect(await getReviewPreflightBlock(workspaceId, db)).toEqual(NEVER_BLOCKED);
    // A workspace id that is not in the table at all: unknown.
    expect(await getReviewPreflightBlock(randomUUID(), db)).toBeUndefined();
  });

  it("clearing deletes the row, and the cleared state reads back as all-defaults", async () => {
    const { db } = createTestDb();
    const workspaceId = await seedWorkspace(db);
    await setReviewPreflightBlock(workspaceId, STATE, db);

    await clearReviewPreflightBlockRow(workspaceId, db);

    expect(await db.select().from(workspaceReviewPreflight)).toHaveLength(0);
    // Absence IS the cleared state — the same values the four columns held after a clear.
    expect(await getReviewPreflightBlock(workspaceId, db)).toEqual(NEVER_BLOCKED);
  });

  it("the block dies with its workspace (ON DELETE CASCADE)", async () => {
    const { db, client } = createTestDb();
    const workspaceId = await seedWorkspace(db);
    await setReviewPreflightBlock(workspaceId, STATE, db);

    await client.execute("PRAGMA foreign_keys = ON");
    await client.execute({ sql: "DELETE FROM workspaces WHERE id = ?", args: [workspaceId] });

    expect(await db.select().from(workspaceReviewPreflight)).toHaveLength(0);
  });
});

describe("migration 0134 backfills the extracted family (#798)", () => {
  it("carries a non-default review_preflight_* row into workspace_review_preflight, and drops nothing else", async () => {
    // Migrate to the state just BEFORE 0134 — the four columns still exist there.
    const client = createClient({ url: ":memory:" });
    const upTo = MIGRATION_FILES.indexOf(MIGRATION_0134);
    expect(upTo, `${MIGRATION_0134} must be in the journal`).toBeGreaterThan(0);
    for (const file of MIGRATION_FILES.slice(0, upTo)) {
      for (const stmt of readMigrationStatements(file, MIGRATIONS_DIR)) await client.execute(stmt);
    }
    const db = drizzle(client, { schema });

    const projectId = randomUUID();
    const statusId = randomUUID();
    const issueId = randomUUID();
    const blocked = randomUUID();
    const untouched = randomUUID();
    // Raw SQL on purpose: the live Drizzle schema binds every column it declares (including
    // ones added to `issues` after this migration's cutoff, e.g. #917's start-score columns),
    // so `db.insert(issues)` here would fail with "table issues has no column named ...".
    await client.execute({
      sql: `INSERT INTO projects (id, name, repo_path, repo_name, default_branch, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [projectId, "Test", "/repo", "repo", "master", T0, T0],
    });
    await client.execute({
      sql: `INSERT INTO project_statuses (id, project_id, name, sort_order, is_default, created_at)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [statusId, projectId, "In Review", 2, 0, T0],
    });
    await client.execute({
      sql: `INSERT INTO issues (id, issue_number, title, priority, sort_order, status_id, project_id, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [issueId, 1, "Issue 1", "medium", 0, statusId, projectId, T0, T0],
    });
    for (const [id, branch] of [[blocked, "feature/blocked"], [untouched, "feature/clean"]]) {
      await client.execute({
        sql: "INSERT INTO workspaces (id, issue_id, branch, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        args: [id, issueId, branch, "idle", T0, T0],
      });
    }
    await client.execute({
      sql: `UPDATE workspaces SET review_preflight_failures = ?, review_preflight_error = ?,
            review_preflight_signature = ?, review_preflight_blocked_at = ? WHERE id = ?`,
      args: [STATE.failures, STATE.error, STATE.signature, STATE.blockedAt, blocked],
    });

    for (const stmt of readMigrationStatements(MIGRATION_0134, MIGRATIONS_DIR)) await client.execute(stmt);

    // The blocked workspace's state survived, value for value.
    const rows = await db.select().from(workspaceReviewPreflight);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ workspaceId: blocked, ...STATE });
    // The all-defaults workspace gets no row — the reads reconstruct that state anyway.
    expect(await getReviewPreflightBlock(untouched, db)).toEqual(NEVER_BLOCKED);
    // The drop took only the four columns.
    const names = columnNames((await client.execute('PRAGMA table_info("workspaces")')).rows);
    expect(names.filter((n) => n.startsWith("review_preflight_"))).toEqual([]);
    expect(names).toContain("merge_gate_ran_at");
    expect(names).toContain("summary_head_sha");
    // And left the rows whole.
    const both = await client.execute("SELECT id FROM workspaces ORDER BY branch");
    expect(both.rows.map((r) => String(r[0]))).toEqual([blocked, untouched]); // ordered by branch
    client.close();
  });
});
