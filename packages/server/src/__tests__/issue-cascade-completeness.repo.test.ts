// @covers persistence-schema.cascade.delete-issue [completeness-vs-unseeded-table]
//
// Why this test exists (coverage gap P1, ROI 6.0):
//   issue-cascade-and-dep.repo.test.ts seeds the *known* child tables and asserts
//   `PRAGMA foreign_key_check` is clean. That catches UNDER-deletion of any table it
//   happens to seed — but `foreign_key_check` only reports an orphan for a row that
//   actually EXISTS. A NEW table that references issues/workspaces/sessions, added to
//   the schema but forgotten in the hand-coded cascade walk AND never seeded by a test,
//   escapes both the walk and the assertion. Deletion completeness rests on a manual
//   walk the schema cannot enforce.
//
// This test closes that by deriving the child-table set from the Drizzle FK graph
// itself (the transitive DELETION subtree of `issues`) and asserting two things:
//   (A) the set of tables this test EXERCISES equals the schema-derived deletion-subtree
//       set — so adding a new issue/workspace/session-referencing table to the schema (via
//       a deletion-propagating FK) turns this test RED until someone seeds it here (and, in
//       practice, teaches the walk);
//   (B) seeding one row in every deletion-subtree table and then running deleteIssueCascade
//       removes every subtree row and leaves zero FK violations, while the sibling issue and
//       shared parents stay whole.
//
// Scope: the subtree follows only FK edges that PROPAGATE deletion (cascade / no-action /
// restrict) — exactly the walk's responsibility. A `set null` / `set default` referrer
// (e.g. drives.meta_issue_id) is NOT in the subtree: the DB nulls it and the row survives,
// so it is the database's job, not the hand-coded walk's.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { eq, is } from "drizzle-orm";
import { getTableConfig, SQLiteTable } from "drizzle-orm/sqlite-core";
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "@agentic-kanban/shared/schema";
import { expectedForeignKeyActions } from "@agentic-kanban/shared/lib/fk-actions";
import { applyMigrationsToClient } from "./helpers/test-db.js";
import { deleteIssueCascade } from "../repositories/issue-service.repository.js";

type TestDb = ReturnType<typeof drizzle<typeof schema>>;

/**
 * A FILE-backed migrated test DB. Mirrors `createTestDb()` but uses a temp file instead
 * of `:memory:`. `deleteIssueCascade` runs its deletes inside a `db.transaction()`, and
 * the libsql native binding loses an in-memory database across a transaction on newer
 * Node runtimes (a fresh connection sees an empty DB → "no such table"). A file-backed
 * DB is connection-stable, so the cascade behaviour under test is exercised honestly and
 * deterministically. Returns a disposer that closes the client and removes the file.
 */
function createFileTestDb(): { client: Client; db: TestDb; dispose: () => void } {
  const file = join(tmpdir(), `cascade-completeness-${randomUUID()}.db`);
  const client = createClient({ url: `file:${file}` });
  applyMigrationsToClient(client);
  client.execute("PRAGMA foreign_keys=ON");
  const db = drizzle(client, { schema });
  const dispose = (): void => {
    try {
      client.close();
    } catch {
      /* ignore */
    }
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        rmSync(`${file}${suffix}`, { force: true });
      } catch {
        /* best-effort temp cleanup */
      }
    }
  };
  return { client, db, dispose };
}

/**
 * Transitive DELETION subtree of `issues`, derived from the Drizzle schema FK graph.
 * A table joins the subtree if it has an FK that (a) references a table already in the
 * subtree (or `issues` itself) and (b) PROPAGATES deletion — i.e. the FK's onDelete is
 * cascade / no-action / restrict, NOT `set null` / `set default`. That is precisely the
 * set the hand-coded walk is responsible for: cascade edges the DB clears, no-action /
 * restrict edges the walk MUST clear first or the parent delete FK-fails. A set-null
 * referrer is excluded because the DB nulls it and the row survives.
 *
 * Computed from the schema, NOT hand-listed, so it grows the moment a new such child
 * table is added — which is the whole point (it then fails assertion (A)).
 */
function issueDeletionSubtree(): Set<string> {
  const fkByTable = expectedForeignKeyActions(); // Map<tableName, ForeignKeySpec[]>
  const propagates = (action: string): boolean => action !== "set null" && action !== "set default";
  const closure = new Set<string>(["issues"]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [table, specs] of fkByTable) {
      if (closure.has(table)) continue;
      if (specs.some((s) => closure.has(s.refTable) && propagates(s.onDelete))) {
        closure.add(table);
        changed = true;
      }
    }
  }
  closure.delete("issues"); // the root itself is not a child
  return closure;
}

/** Pre-allocated ids so seeders are independent of insertion order for references. */
interface SeedCtx {
  db: TestDb;
  projectId: string;
  statusId: string;
  issueId: string;
  otherIssueId: string;
  workspaceId: string;
  sessionId: string;
  tagId: string;
  now: string;
}

/**
 * One seeder per descendant table. The KEYS of this map are the tables this test
 * exercises; assertion (A) pins them to the schema-derived descendant set. Each seeder
 * inserts exactly one row wired into the issue's subtree so deletion must account for it.
 * Ordered so FK parents are inserted before their children.
 */
const SUBTREE_SEEDERS: Record<string, (c: SeedCtx) => Promise<void>> = {
  workspaces: async (c) => {
    await c.db.insert(schema.workspaces).values({
      id: c.workspaceId, issueId: c.issueId, branch: `feature/${c.workspaceId}`,
      status: "active", createdAt: c.now, updatedAt: c.now,
    });
  },
  sessions: async (c) => {
    await c.db.insert(schema.sessions).values({
      id: c.sessionId, workspaceId: c.workspaceId, status: "running", startedAt: c.now,
    });
  },
  session_messages: async (c) => {
    await c.db.insert(schema.sessionMessages).values({
      sessionId: c.sessionId, type: "stdout", data: "hello", createdAt: c.now,
    });
  },
  test_runs: async (c) => {
    await c.db.insert(schema.testRuns).values({
      sessionId: c.sessionId, testName: "passes sometimes", passed: true, recordedAt: c.now,
    });
  },
  test_retry_decisions: async (c) => {
    await c.db.insert(schema.testRetryDecisions).values({
      id: randomUUID(), sessionId: c.sessionId, workspaceId: c.workspaceId,
      testName: "fails sometimes", decision: "flake", confidence: 0.9,
      createdAt: c.now, updatedAt: c.now,
    });
  },
  diff_comments: async (c) => {
    await c.db.insert(schema.diffComments).values({
      id: randomUUID(), workspaceId: c.workspaceId, filePath: "src/file.ts",
      side: "new", body: "comment", createdAt: c.now, updatedAt: c.now,
    });
  },
  repos: async (c) => {
    await c.db.insert(schema.repos).values({
      id: randomUUID(), workspaceId: c.workspaceId, projectId: c.projectId,
      path: `C:/tmp/${c.workspaceId}`, createdAt: c.now,
    });
  },
  workflow_transitions: async (c) => {
    await c.db.insert(schema.workflowTransitions).values({
      id: randomUUID(), workspaceId: c.workspaceId, toNodeId: "review",
      summary: "advanced", triggeredBy: "agent", createdAt: c.now,
    });
  },
  issue_artifacts: async (c) => {
    await c.db.insert(schema.issueArtifacts).values({
      id: randomUUID(), issueId: c.issueId, workspaceId: c.workspaceId,
      type: "text", content: "artifact", createdAt: c.now,
    });
  },
  issue_comments: async (c) => {
    await c.db.insert(schema.issueComments).values({
      id: randomUUID(), issueId: c.issueId, workspaceId: c.workspaceId,
      kind: "note", author: "agent", body: "comment", createdAt: c.now,
    });
  },
  issue_time_entries: async (c) => {
    await c.db.insert(schema.issueTimeEntries).values({
      id: randomUUID(), issueId: c.issueId, minutes: 15, note: null, createdAt: c.now,
    });
  },
  issue_dependencies: async (c) => {
    await c.db.insert(schema.issueDependencies).values({
      id: randomUUID(), issueId: c.issueId, dependsOnId: c.otherIssueId,
      type: "depends_on", createdAt: c.now,
    });
  },
  issue_tags: async (c) => {
    await c.db.insert(schema.issueTags).values({
      id: randomUUID(), issueId: c.issueId, tagId: c.tagId,
    });
  },
  showdowns: async (c) => {
    await c.db.insert(schema.showdowns).values({
      id: randomUUID(), issueId: c.issueId, status: "active", createdAt: c.now, updatedAt: c.now,
    });
  },
};

async function seedParents(c: SeedCtx): Promise<void> {
  await c.db.insert(schema.projects).values({
    id: c.projectId, name: "Cascade Project", repoPath: `C:/tmp/${c.projectId}`,
    repoName: "cascade-project", defaultBranch: "main", createdAt: c.now, updatedAt: c.now,
  });
  await c.db.insert(schema.projectStatuses).values({
    id: c.statusId, projectId: c.projectId, name: "Todo", sortOrder: 0, isDefault: true, createdAt: c.now,
  });
  await c.db.insert(schema.issues).values({
    id: c.issueId, issueNumber: 1, title: "Issue 1", description: null,
    priority: "medium", sortOrder: 0, statusId: c.statusId, projectId: c.projectId,
    createdAt: c.now, updatedAt: c.now,
  });
  await c.db.insert(schema.issues).values({
    id: c.otherIssueId, issueNumber: 2, title: "Issue 2", description: null,
    priority: "medium", sortOrder: 0, statusId: c.statusId, projectId: c.projectId,
    createdAt: c.now, updatedAt: c.now,
  });
  await c.db.insert(schema.tags).values({
    id: c.tagId, name: "urgent", color: null, isBuiltin: false, createdAt: c.now,
  });
}

function makeCtx(db: TestDb): SeedCtx {
  return {
    db,
    projectId: randomUUID(),
    statusId: randomUUID(),
    issueId: randomUUID(),
    otherIssueId: randomUUID(),
    workspaceId: randomUUID(),
    sessionId: randomUUID(),
    tagId: randomUUID(),
    now: new Date().toISOString(),
  };
}

async function fkViolations(client: Client): Promise<unknown[]> {
  const result = await client.execute("PRAGMA foreign_key_check");
  return result.rows;
}

describe("deleteIssueCascade — completeness vs the schema FK graph", () => {
  let db: TestDb;
  let client: Client;
  let dispose: () => void;
  beforeEach(() => {
    ({ client, db, dispose } = createFileTestDb());
  });
  afterEach(() => {
    dispose();
  });

  it("exercises every table the schema declares as a deletion-subtree child of issues", () => {
    // Future-proof guard: the set of tables we seed/verify below must equal the set the
    // Drizzle schema says is in the issue deletion subtree. Add a new issue/workspace/
    // session child table (via a deletion-propagating FK) to the schema and this goes RED
    // — forcing it into both this test and the hand-coded walk.
    const schemaSubtree = issueDeletionSubtree();
    const exercised = new Set(Object.keys(SUBTREE_SEEDERS));
    expect(exercised).toEqual(schemaSubtree);
  });

  it("every session/workspace/issue/project-id-named column declares an FK reference", () => {
    // A table can only enter the deletion-subtree checks above if it has a DECLARED FK —
    // a parent-id column WITHOUT `.references()` is invisible to the whole gate (that was
    // #948: test_runs.session_id orphaned rows forever, silently). This check makes the
    // next FK-less parent-id column turn the gate red instead.
    //
    // Allowlist: scheduled_run_history.{issue_id,workspace_id} are HISTORICAL log
    // references, intentionally FK-less so run history survives issue/workspace deletion.
    const ALLOWED_FKLESS = new Set(["scheduled_run_history.issue_id", "scheduled_run_history.workspace_id"]);
    const offenders: string[] = [];
    for (const value of Object.values(schema)) {
      if (!is(value, SQLiteTable)) continue;
      const config = getTableConfig(value);
      const fkColumns = new Set(
        config.foreignKeys.flatMap((fk) => fk.reference().columns.map((col) => col.name)),
      );
      for (const column of config.columns) {
        if (!/^(session|workspace|issue|project)_id$/.test(column.name)) continue;
        if (fkColumns.has(column.name)) continue;
        const key = `${config.name}.${column.name}`;
        if (ALLOWED_FKLESS.has(key)) continue;
        offenders.push(key);
      }
    }
    expect(offenders, "parent-id columns missing a .references() FK declaration").toEqual([]);
  });

  it("deletes an issue seeded across EVERY deletion-subtree table with no orphan or FK violation", async () => {
    const c = makeCtx(db);
    await seedParents(c);
    for (const table of Object.keys(SUBTREE_SEEDERS)) {
      await SUBTREE_SEEDERS[table](c);
    }

    // Sanity: FK enforcement on and the subtree is fully populated before we delete.
    const fkPragma = await client.execute("PRAGMA foreign_keys");
    expect(Number(fkPragma.rows[0]?.foreign_keys ?? 0)).toBe(1);
    expect(await fkViolations(client)).toEqual([]);

    await expect(deleteIssueCascade(c.issueId, db)).resolves.toBeUndefined();

    // The single strongest invariant: no row anywhere references a now-deleted parent.
    // foreign_key_check scans ALL tables, so an unhandled child row would surface here.
    expect(await fkViolations(client)).toEqual([]);

    // The issue and every cascade-child subtree row are gone.
    expect(await db.select().from(schema.issues).where(eq(schema.issues.id, c.issueId))).toHaveLength(0);
    expect(await db.select().from(schema.workspaces).where(eq(schema.workspaces.issueId, c.issueId))).toHaveLength(0);
    expect(await db.select().from(schema.sessions).where(eq(schema.sessions.workspaceId, c.workspaceId))).toHaveLength(0);
    expect(await db.select().from(schema.sessionMessages).where(eq(schema.sessionMessages.sessionId, c.sessionId))).toHaveLength(0);
    expect(await db.select().from(schema.testRuns).where(eq(schema.testRuns.sessionId, c.sessionId))).toHaveLength(0);
    expect(await db.select().from(schema.testRetryDecisions)).toHaveLength(0);
    expect(await db.select().from(schema.diffComments)).toHaveLength(0);
    expect(await db.select().from(schema.repos)).toHaveLength(0);
    expect(await db.select().from(schema.workflowTransitions)).toHaveLength(0);
    expect(await db.select().from(schema.issueArtifacts)).toHaveLength(0);
    expect(await db.select().from(schema.issueComments)).toHaveLength(0);
    expect(await db.select().from(schema.issueTimeEntries)).toHaveLength(0);
    expect(await db.select().from(schema.issueDependencies)).toHaveLength(0);
    expect(await db.select().from(schema.issueTags)).toHaveLength(0);
    expect(await db.select().from(schema.showdowns)).toHaveLength(0);

    // The sibling issue and shared parents are untouched.
    expect(await db.select().from(schema.issues).where(eq(schema.issues.id, c.otherIssueId))).toHaveLength(1);
    expect(await db.select().from(schema.tags)).toHaveLength(1);
  });
});
