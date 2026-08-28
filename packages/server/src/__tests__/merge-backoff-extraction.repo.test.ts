// @gate:always-run — the backfill assertion reads the 0131 migration .sql off disk, which is
// not in this file's import graph (#781).
// @covers review-merge.merge.retry-backoff [persistence,state-transition,migration]
/**
 * #781 — merge-backoff state lives in `workspace_merge_backoff`, not in seven
 * `merge_backoff_*` columns on `workspaces`.
 *
 * The extraction of the first of #739's eleven column families. Every assertion here fails
 * BEFORE the extraction (the columns still exist, the table does not, the reads select from
 * the row) and the interesting ones fail on a NAIVE extraction too:
 *
 *  - `getMergeBackoffState` must return `failures: 0` for a workspace with no backoff row,
 *    and `undefined` only for a workspace that does not exist. `recordMergeFailure` returns
 *    early on `undefined`, so an extraction that selected straight from the new table would
 *    silently drop every FIRST merge failure — the circuit breaker would never arm.
 *  - The migration must BACKFILL. 659 live rows carry this state; losing it would silently
 *    reset every active block. Verified by migrating to 0130, writing the old columns, then
 *    applying 0131 and reading the new table.
 */
import { describe, it, expect } from "vitest";
import type { Row } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "@agentic-kanban/shared/schema";
import { issues, projectStatuses, projects, workspaceMergeBackoff, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { MIGRATION_FILES, MIGRATIONS_DIR, readMigrationStatements } from "./helpers/migrations.js";
import {
  clearMergeBackoffState,
  getMergeBackoffSignatureState,
  getMergeBackoffState,
  setMergeBackoffState,
} from "../repositories/merge-backoff.repository.js";

const T0 = "2026-08-23T00:00:00.000Z";
const MIGRATION_0131 = "0131_workspace_merge_backoff.sql";

type Db = ReturnType<typeof createTestDb>["db"];

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

const STATE = {
  failures: 3,
  signature: "generic|0123456789abcdef",
  error: "Merge conflicts detected (branch is 3 commits behind master)",
  branchSha: "head1",
  verifyHash: "vh1",
  nextRetryAt: "2026-08-23T01:00:00.000Z",
  since: "2026-08-22T23:00:00.000Z",
  updatedAt: "2026-08-23T00:30:00.000Z",
};

const NEVER_BLOCKED = {
  failures: 0, signature: null, branchSha: null, verifyHash: null, nextRetryAt: null,
};

function columnNames(rows: Row[]): string[] {
  return rows.map((r) => String(r.name));
}

describe("merge-backoff extraction (#781)", () => {
  it("the seven merge_backoff_* columns are gone from workspaces", async () => {
    const { client } = createTestDb();
    const info = await client.execute('PRAGMA table_info("workspaces")');
    expect(columnNames(info.rows).filter((n) => n.startsWith("merge_backoff_"))).toEqual([]);
    // The concern moved rather than vanished.
    const moved = await client.execute('PRAGMA table_info("workspace_merge_backoff")');
    expect(columnNames(moved.rows).sort()).toEqual([
      "branch_sha", "error", "failures", "next_retry_at", "signature", "since", "verify_hash", "workspace_id",
    ]);
  });

  it("a write is stored in workspace_merge_backoff and read back through it", async () => {
    const { db } = createTestDb();
    const workspaceId = await seedWorkspace(db);

    await setMergeBackoffState(workspaceId, STATE, db);

    // Stored where the extraction says it is — one row, keyed by workspace.
    const rows = await db.select().from(workspaceMergeBackoff)
      .where(eq(workspaceMergeBackoff.workspaceId, workspaceId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      failures: STATE.failures, signature: STATE.signature, error: STATE.error,
      branchSha: STATE.branchSha, verifyHash: STATE.verifyHash,
      nextRetryAt: STATE.nextRetryAt, since: STATE.since,
    });

    // And read back through the repository the service actually calls.
    expect(await getMergeBackoffState(workspaceId, db)).toEqual({
      failures: STATE.failures, signature: STATE.signature,
      branchSha: STATE.branchSha, verifyHash: STATE.verifyHash, nextRetryAt: STATE.nextRetryAt,
    });
    expect(await getMergeBackoffSignatureState(workspaceId, db)).toEqual({
      failures: STATE.failures, signature: STATE.signature, since: STATE.since,
    });
  });

  it("a repeat failure UPDATES the one row rather than inserting a second", async () => {
    const { db } = createTestDb();
    const workspaceId = await seedWorkspace(db);
    await setMergeBackoffState(workspaceId, STATE, db);
    await setMergeBackoffState(workspaceId, { ...STATE, failures: 4, nextRetryAt: "2026-08-23T02:00:00.000Z" }, db);

    const rows = await db.select().from(workspaceMergeBackoff)
      .where(eq(workspaceMergeBackoff.workspaceId, workspaceId));
    expect(rows).toHaveLength(1);
    expect(rows[0].failures).toBe(4);
    expect(rows[0].nextRetryAt).toBe("2026-08-23T02:00:00.000Z");
  });

  it("a recorded failure still moves the workspace's updatedAt", async () => {
    const { db } = createTestDb();
    const workspaceId = await seedWorkspace(db);
    await setMergeBackoffState(workspaceId, STATE, db);
    const [ws] = await db.select({ updatedAt: workspaces.updatedAt }).from(workspaces)
      .where(eq(workspaces.id, workspaceId));
    expect(ws.updatedAt).toBe(STATE.updatedAt);
  });

  /**
   * The behaviour-preservation core. `shouldSkipMergeForBackoff` treats a falsy `failures`
   * as "no block", and `recordMergeFailure` returns early — recording NOTHING — when the
   * read is `undefined`. Before the extraction those two cases were distinguishable for
   * free, because the columns lived on the workspace row. The LEFT JOIN is what keeps them
   * distinguishable now.
   */
  it("no backoff row reads as failures 0, while an unknown workspace reads as undefined", async () => {
    const { db } = createTestDb();
    const workspaceId = await seedWorkspace(db);

    expect(await getMergeBackoffState(workspaceId, db)).toEqual(NEVER_BLOCKED);
    expect(await getMergeBackoffSignatureState(workspaceId, db)).toEqual({
      failures: 0, signature: null, since: null,
    });

    expect(await getMergeBackoffState(randomUUID(), db)).toBeUndefined();
    expect(await getMergeBackoffSignatureState(randomUUID(), db)).toBeUndefined();
  });

  it("clearing deletes the row, and the cleared state reads exactly like never-blocked", async () => {
    const { db } = createTestDb();
    const workspaceId = await seedWorkspace(db);
    await setMergeBackoffState(workspaceId, STATE, db);
    await clearMergeBackoffState(workspaceId, db);

    expect(await db.select().from(workspaceMergeBackoff)
      .where(eq(workspaceMergeBackoff.workspaceId, workspaceId))).toEqual([]);
    expect(await getMergeBackoffState(workspaceId, db)).toEqual(NEVER_BLOCKED);
  });

  it("the first failure after a clear is recorded again, not mistaken for a missing workspace", async () => {
    const { db } = createTestDb();
    const workspaceId = await seedWorkspace(db);
    await setMergeBackoffState(workspaceId, STATE, db);
    await clearMergeBackoffState(workspaceId, db);

    // What recordMergeFailure does: read, decide, write. A read of `undefined` here would
    // make it bail and the workspace would never accumulate a block again.
    expect(await getMergeBackoffSignatureState(workspaceId, db)).toBeDefined();
    await setMergeBackoffState(workspaceId, { ...STATE, failures: 1 }, db);
    expect((await getMergeBackoffState(workspaceId, db))?.failures).toBe(1);
  });

  it("the row dies with its workspace (FK cascade, not an orphaned block)", async () => {
    const { db, client } = createTestDb();
    await client.execute("PRAGMA foreign_keys=ON");
    const workspaceId = await seedWorkspace(db);
    await setMergeBackoffState(workspaceId, STATE, db);

    await db.delete(workspaces).where(eq(workspaces.id, workspaceId));

    expect(await db.select().from(workspaceMergeBackoff)).toEqual([]);
    const violations = await client.execute("PRAGMA foreign_key_check");
    expect(violations.rows).toEqual([]);
  });
});

describe("migration 0131 backfills the extracted family (#781)", () => {
  it("carries a non-default merge_backoff_* row into workspace_merge_backoff, and drops nothing else", async () => {
    // Migrate to the state just BEFORE 0131 — the seven columns still exist there.
    const client = createClient({ url: ":memory:" });
    const upTo = MIGRATION_FILES.indexOf(MIGRATION_0131);
    expect(upTo, `${MIGRATION_0131} must be in the journal`).toBeGreaterThan(0);
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
      sql: `UPDATE workspaces SET merge_backoff_failures = ?, merge_backoff_signature = ?,
            merge_backoff_error = ?, merge_backoff_branch_sha = ?, merge_backoff_verify_hash = ?,
            merge_backoff_next_retry_at = ?, merge_backoff_since = ? WHERE id = ?`,
      args: [STATE.failures, STATE.signature, STATE.error, STATE.branchSha, STATE.verifyHash,
        STATE.nextRetryAt, STATE.since, blocked],
    });

    for (const stmt of readMigrationStatements(MIGRATION_0131, MIGRATIONS_DIR)) await client.execute(stmt);

    // The blocked workspace's state survived, value for value.
    const rows = await db.select().from(workspaceMergeBackoff);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      workspaceId: blocked, failures: STATE.failures, signature: STATE.signature,
      error: STATE.error, branchSha: STATE.branchSha, verifyHash: STATE.verifyHash,
      nextRetryAt: STATE.nextRetryAt, since: STATE.since,
    });
    // The all-defaults workspace gets no row — the reads reconstruct that state anyway,
    // so a row would be noise, and its absence must still read as "not blocked".
    expect(await getMergeBackoffState(untouched, db)).toEqual(NEVER_BLOCKED);
    // The drop took only the seven columns.
    const names = columnNames((await client.execute('PRAGMA table_info("workspaces")')).rows);
    expect(names.filter((n) => n.startsWith("merge_backoff_"))).toEqual([]);
    expect(names).toContain("review_preflight_failures");
    expect(names).toContain("merge_gate_ran_at");
    // And left the rows whole.
    const both = await client.execute("SELECT id FROM workspaces ORDER BY branch");
    expect(both.rows.map((r) => String(r[0]))).toEqual([blocked, untouched]); // ordered by branch
    client.close();
  });
});
