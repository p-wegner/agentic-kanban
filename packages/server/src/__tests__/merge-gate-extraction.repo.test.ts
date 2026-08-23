// @gate:always-run — the backfill assertion reads the 0138 migration .sql off disk, which is
// not in this file's import graph (#815).
// @covers workspaces.merge.gate-evidence [persistence,migration]
/**
 * #815 — the pre-merge gate's evidence lives in `workspace_merge_gate`, not in five
 * `merge_gate_*` columns on `workspaces`.
 *
 * What must hold after the move:
 *  - the writer/clear round-trip still expresses the two states the columns expressed
 *    ("gated, here is the proof" and "the proof is void");
 *  - a workspace with NO evidence still reads (LEFT JOIN) — an inner join would drop every
 *    never-gated workspace out of the monitor's candidate walk and stop every first merge;
 *  - the evidence dies with its workspace;
 *  - the migration backfills every existing proof and drops nothing else.
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "@agentic-kanban/shared/schema";
import { issues, projectStatuses, projects, workspaceMergeGate, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { MIGRATION_FILES, MIGRATIONS_DIR, readMigrationStatements } from "./helpers/migrations.js";
import {
  clearMergeGateEvidence,
  getMergeGateEvidence,
  setMergeGateEvidence,
} from "../repositories/merge-gate.repository.js";

const T0 = "2026-08-23T00:00:00.000Z";
const MIGRATION_0138 = "0138_workspace_merge_gate.sql";

const EVIDENCE = {
  ranAt: T0,
  stage: "verify",
  source: "review-exit gate",
  branchSha: "aaaaaaaaaaaa",
  baseSha: "bbbbbbbbbbbb",
};

type Db = ReturnType<typeof createTestDb>["db"];

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
    id: statusId, projectId, name: "In Review", sortOrder: 1, isDefault: false, createdAt: T0,
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

describe("merge-gate extraction (#815)", () => {
  it("the five merge_gate_* columns are gone from workspaces", async () => {
    const { client } = createTestDb();
    const info = await client.execute('PRAGMA table_info("workspaces")');
    expect(columnNames(info.rows).filter((n) => n.startsWith("merge_gate_"))).toEqual([]);
    const moved = await client.execute('PRAGMA table_info("workspace_merge_gate")');
    expect(columnNames(moved.rows).sort()).toEqual([
      "base_sha", "branch_sha", "ran_at", "source", "stage", "workspace_id",
    ]);
  });

  it("round-trips the proof, and re-gating replaces it rather than duplicating it", async () => {
    const { db } = createTestDb();
    const workspaceId = await seedWorkspace(db);

    await setMergeGateEvidence(workspaceId, EVIDENCE, db);
    expect(await getMergeGateEvidence(workspaceId, db)).toEqual({ workspaceId, ...EVIDENCE });

    // A second gate run on the same workspace: the record is LATEST-value, as the columns were.
    const regated = { ...EVIDENCE, ranAt: "2026-08-23T01:00:00.000Z", branchSha: "cccccccccccc" };
    await setMergeGateEvidence(workspaceId, regated, db);
    expect(await db.select().from(workspaceMergeGate).where(eq(workspaceMergeGate.workspaceId, workspaceId)))
      .toEqual([{ workspaceId, ...regated }]);
  });

  it("clearing deletes the row — the same state five nulled columns held", async () => {
    const { db } = createTestDb();
    const workspaceId = await seedWorkspace(db);
    await setMergeGateEvidence(workspaceId, EVIDENCE, db);

    await clearMergeGateEvidence(workspaceId, db);

    // Missing row == no trustworthy evidence == `resolveMergeGate` re-runs the gate.
    expect(await getMergeGateEvidence(workspaceId, db)).toBeUndefined();
    expect(await db.select().from(workspaceMergeGate)).toHaveLength(0);
  });

  it("a never-gated workspace still reads back through a LEFT JOIN", async () => {
    const { db } = createTestDb();
    const workspaceId = await seedWorkspace(db);

    // This is the monitor's candidate shape. An INNER join here would silently drop every
    // workspace that has never been gated — i.e. every first merge.
    const rows = await db.select({
      wsId: workspaces.id,
      mergeGateRanAt: workspaceMergeGate.ranAt,
      mergeGateStage: workspaceMergeGate.stage,
    })
      .from(workspaces)
      .leftJoin(workspaceMergeGate, eq(workspaceMergeGate.workspaceId, workspaces.id))
      .where(eq(workspaces.id, workspaceId));
    expect(rows).toEqual([{ wsId: workspaceId, mergeGateRanAt: null, mergeGateStage: null }]);
  });

  it("the evidence dies with its workspace (ON DELETE CASCADE)", async () => {
    const { db, client } = createTestDb();
    const workspaceId = await seedWorkspace(db);
    await setMergeGateEvidence(workspaceId, EVIDENCE, db);

    await client.execute("PRAGMA foreign_keys = ON");
    await client.execute({ sql: "DELETE FROM workspaces WHERE id = ?", args: [workspaceId] });

    expect(await db.select().from(workspaceMergeGate)).toHaveLength(0);
  });
});

describe("migration 0138 backfills the extracted family (#815)", () => {
  it("carries the evidence into workspace_merge_gate, and drops nothing else", async () => {
    const client = createClient({ url: ":memory:" });
    const upTo = MIGRATION_FILES.indexOf(MIGRATION_0138);
    expect(upTo, `${MIGRATION_0138} must be in the journal`).toBeGreaterThan(0);
    for (const file of MIGRATION_FILES.slice(0, upTo)) {
      for (const stmt of readMigrationStatements(file, MIGRATIONS_DIR)) await client.execute(stmt);
    }
    const db = drizzle(client, { schema });

    const projectId = randomUUID();
    const statusId = randomUUID();
    const issueId = randomUUID();
    const gated = randomUUID();
    const untouched = randomUUID();
    await db.insert(projects).values({
      id: projectId, name: "Test", repoPath: "/repo", repoName: "repo",
      defaultBranch: "master", createdAt: T0, updatedAt: T0,
    });
    await db.insert(projectStatuses).values({
      id: statusId, projectId, name: "In Review", sortOrder: 1, isDefault: false, createdAt: T0,
    });
    await db.insert(issues).values({
      id: issueId, issueNumber: 1, title: "Issue 1", priority: "medium", sortOrder: 0,
      statusId, projectId, createdAt: T0, updatedAt: T0,
    });
    // Raw SQL on purpose: the Drizzle schema no longer knows these columns.
    for (const [id, branch] of [[gated, "feature/gated"], [untouched, "feature/clean"]]) {
      await client.execute({
        sql: "INSERT INTO workspaces (id, issue_id, branch, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        args: [id, issueId, branch, "idle", T0, T0],
      });
    }
    await client.execute({
      sql: `UPDATE workspaces SET merge_gate_ran_at = ?, merge_gate_stage = ?,
            merge_gate_source = ?, merge_gate_branch_sha = ?, merge_gate_base_sha = ?
            WHERE id = ?`,
      args: [EVIDENCE.ranAt, EVIDENCE.stage, EVIDENCE.source, EVIDENCE.branchSha, EVIDENCE.baseSha, gated],
    });

    for (const stmt of readMigrationStatements(MIGRATION_0138, MIGRATIONS_DIR)) await client.execute(stmt);

    expect(await db.select().from(workspaceMergeGate)).toEqual([{ workspaceId: gated, ...EVIDENCE }]);
    // The never-gated workspace gets NO row — the reads reconstruct that state anyway.
    const names = columnNames((await client.execute('PRAGMA table_info("workspaces")')).rows);
    expect(names.filter((n) => n.startsWith("merge_gate_"))).toEqual([]);
    // The neighbouring families are untouched.
    expect(names).toContain("summary_head_sha");
    expect(names).toContain("ready_for_merge");
    // And left the rows whole.
    const both = await client.execute("SELECT id FROM workspaces ORDER BY branch");
    expect(both.rows.map((r) => String(r[0]))).toEqual([untouched, gated]); // ordered by branch
    client.close();
  });
});
