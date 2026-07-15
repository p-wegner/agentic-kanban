// @covers project-registration.dedup.sameGitRoot [workflow,state-transition,regression]
//
// Why this test exists (coverage gap P1, ROI 4.5):
//   deduplicateProjects() runs on EVERY server boot, but every test that imports the
//   startup path mocks it away (`vi.mock(".../project-registration.js", () => ({
//   deduplicateProjects: vi.fn() }))` in startup-tasks.test.ts). The actual merge — group
//   projects by resolved git root, pick the survivor, move issues/skills/repos/scheduled-runs,
//   remap issue statuses by name, redirect the active-project pointer, then delete the
//   duplicate — is therefore UNVERIFIED. A bug here fragments or LOSES a repo's issues on a
//   silent background pass. This exercises the real function against a real git repo + a
//   file-backed migrated DB.
//
// SCOPE OF THIS TEST — read before trusting it as a "dedup is lossless" proof (it is NOT):
//   This pins the behaviour that deduplicateProjects ACTUALLY implements today:
//     (a) winner selection — the root-path project wins over a more-recently-updated subdir dup;
//     (b) reassignment of the FOUR child types the function currently moves — issues,
//         agent_skills, repos, scheduled_runs;
//     (c) same-NAMED status remap — the moved issue is repointed to the survivor's identically
//         named ("Todo") status before the dup's statuses are deleted;
//     (d) active-project pointer redirect.
//   It deliberately seeds ONLY those four handled child tables and gives both projects a status
//   literally named "Todo", so "no orphans afterward" holds. It does NOT prove dedup is lossless.
//   Completeness across ALL project-child tables — milestones / drives / drive_obstacles
//   (cascade children silently DELETED), workflow_templates / quality_metrics /
//   board_health_events / flaky_tests / project_script_shortcuts / scheduled_run_history
//   (orphaned or merge-aborting), and the name-MISMATCHED status path (leaves a dangling
//   issues.status_id) — is a real data-integrity defect tracked by product ticket #929 and is
//   intentionally NOT asserted here (those assertions belong with the #929 fix and would, today,
//   correctly fail). See the TODO(#929) marker in the test body.
//
// Winner rule under test (project-registration.ts:88-95): prefer the project whose repoPath
// already EQUALS the git root, breaking ties by recency. We deliberately make the duplicate
// (the non-root subdir registration) the MORE-RECENTLY-updated row, so a survivor chosen by
// recency alone would pick the WRONG one — the test pins "root path wins over recency".
//
// File-backed (not :memory:) DB: deduplicateProjects wraps its per-duplicate merge in
// db.transaction(), and the libsql native binding loses an in-memory database across a
// transaction on newer Node runtimes (a fresh connection sees an empty DB → "no such table").
// A file DB is connection-stable, mirroring createFileTestDb() in
// issue-cascade-completeness.repo.test.ts.
//
// Orphan backstop = the post-hoc `PRAGMA foreign_key_check`, NOT live FK enforcement.
// The `PRAGMA foreign_keys=ON` issued at setup is best-effort and per-connection (fire-and-
// forget — its promise is not awaited), so we do NOT rely on FK constraints firing mid-
// transaction. The reliable, connection-independent check is the post-merge `PRAGMA
// foreign_key_check` asserted at the end: it scans every table and reports any row pointing at
// a now-deleted parent. That catches the two ways this merge could orphan rows among the
// tables it handles — (a) deleting the duplicate project while an issue still references it
// (issues.project_id), and (b) deleting the dup's statuses while the moved issue still points
// at one (issues.status_id) — for a mutant that skips moveIssuesToProject or the status remap.
// (It does NOT, and cannot, flag cascade children the function silently deletes — see #929.)

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { eq } from "drizzle-orm";
import * as schema from "@agentic-kanban/shared/schema";
import { applyMigrationsToClient } from "./helpers/test-db.js";

type TestDb = ReturnType<typeof drizzle<typeof schema>>;

// --- Build the file-backed DB inside a hoisted block so the module-under-test's `db` import
//     resolves to IT. deduplicateProjects and the project-registration repository both read
//     the singleton `db` from ../db/index.js; mocking that module routes every read/write and
//     the db.transaction() call onto this connection-stable file DB.
//
// The vi.mock(...) factory below runs ONCE, on first import of "../db/index.js" — NOT once per
// test. Recreating h.client/h.db in beforeEach (see per-describe setup) is therefore not enough
// on its own: a static `export { db }` would keep pointing at the FIRST client forever, so by the
// 3rd test (after the 2nd afterEach closes it) every DB call would throw CLIENT_CLOSED. Instead
// the factory exports live-binding proxies that always resolve to the CURRENT h.client/h.db, so
// swapping the underlying client each test is enough — no vi.resetModules()/re-import required.
const h = vi.hoisted(() => {
  return { file: undefined as string | undefined, client: undefined as Client | undefined, db: undefined as TestDb | undefined };
});

function liveProxy<T extends object>(getCurrent: () => T): T {
  return new Proxy({} as T, {
    get(_target, prop, _receiver) {
      const current = getCurrent() as Record<PropertyKey, unknown>;
      const value = current[prop];
      return typeof value === "function" ? value.bind(current) : value;
    },
  });
}

vi.mock("../db/index.js", () => {
  const db = liveProxy<TestDb>(() => h.db!);
  const client = liveProxy<Client>(() => h.client!);
  return {
    db,
    writeDb: db,
    rawClient: client,
    rawWriteClient: client,
    schema,
    withDbRetry: <T>(fn: () => Promise<T>) => fn(),
    withTransaction: <T>(database: TestDb, fn: (tx: unknown) => Promise<T>) => database.transaction(fn),
  };
});

/** Creates a fresh file-backed, migrated client and points h.client/h.db at it. */
function openTestDb(): void {
  const dir = process.env.TEMP || process.env.TMP || process.cwd();
  const file = `${dir}/dedup-same-root-${randomUUID()}.db`;
  const c = createClient({ url: `file:${file}` });
  applyMigrationsToClient(c);
  c.execute("PRAGMA foreign_keys=ON");
  h.file = file;
  h.client = c;
  h.db = drizzle(c, { schema });
}

function closeTestDb(): void {
  try { h.client?.close(); } catch { /* ignore */ }
  for (const suffix of ["", "-wal", "-shm"]) {
    try { rmSync(`${h.file}${suffix}`, { force: true }); } catch { /* best-effort */ }
  }
}

const client = (): Client => h.client!;
const db = (): TestDb => h.db!;

// Imported AFTER the mock is registered (vi.mock is hoisted above all imports anyway).
import { deduplicateProjects } from "../services/project-registration.js";
import { projectChildEdges } from "../repositories/project-registration.repository.js";

function makeGitRepo(): { root: string; sub: string; dispose: () => void } {
  const root = join(tmpdir(), `dedup-repo-${randomUUID()}`);
  mkdirSync(root, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: root });
  const sub = join(root, "packages", "app");
  mkdirSync(sub, { recursive: true });
  // The path deduplicateProjects compares against: resolve(git rev-parse --show-toplevel).
  const top = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: root }).toString().trim();
  const resolvedRoot = resolve(top);
  return {
    root: resolvedRoot,
    sub,
    dispose: () => {
      try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
    },
  };
}

interface Seeded {
  keepId: string;
  dupId: string;
  keepStatusId: string;
  dupStatusId: string;
  keepIssueId: string;
  dupIssueId: string;
  dupSkillId: string;
  dupRepoId: string;
  dupRunId: string;
}

/**
 * Seed two projects resolving to the SAME git root:
 *  - keep: repoPath === gitRoot, updated EARLIER (the documented survivor by root-path rule)
 *  - dup:  repoPath === a subdir, updated LATER  (would win on recency — it must NOT)
 * Both have a same-named "Todo" status; the dup owns one issue (on its own status), a
 * project-scoped skill, a repo and a scheduled run. activeProjectId points at the dup.
 */
async function seed(d: TestDb, root: string, sub: string): Promise<Seeded> {
  const ids: Seeded = {
    keepId: randomUUID(), dupId: randomUUID(),
    keepStatusId: randomUUID(), dupStatusId: randomUUID(),
    keepIssueId: randomUUID(), dupIssueId: randomUUID(),
    dupSkillId: randomUUID(), dupRepoId: randomUUID(), dupRunId: randomUUID(),
  };
  const earlier = new Date(Date.now() - 60_000).toISOString();
  const later = new Date().toISOString();

  await d.insert(schema.projects).values([
    { id: ids.keepId, name: "app", repoPath: root, repoName: "app", defaultBranch: "main", createdAt: earlier, updatedAt: earlier },
    { id: ids.dupId, name: "app-sub", repoPath: sub, repoName: "app-sub", defaultBranch: "main", createdAt: earlier, updatedAt: later },
  ]);
  await d.insert(schema.projectStatuses).values([
    { id: ids.keepStatusId, projectId: ids.keepId, name: "Todo", sortOrder: 0, isDefault: true, createdAt: earlier },
    { id: ids.dupStatusId, projectId: ids.dupId, name: "Todo", sortOrder: 0, isDefault: true, createdAt: earlier },
  ]);
  await d.insert(schema.issues).values([
    { id: ids.keepIssueId, issueNumber: 1, title: "Keep issue", description: null, priority: "medium", sortOrder: 0, statusId: ids.keepStatusId, projectId: ids.keepId, createdAt: earlier, updatedAt: earlier },
    { id: ids.dupIssueId, issueNumber: 2, title: "Dup issue", description: null, priority: "medium", sortOrder: 0, statusId: ids.dupStatusId, projectId: ids.dupId, createdAt: earlier, updatedAt: earlier },
  ]);
  await d.insert(schema.agentSkills).values({
    id: ids.dupSkillId, name: "dup-skill", description: "d", prompt: "p", projectId: ids.dupId, createdAt: earlier, updatedAt: earlier,
  });
  await d.insert(schema.repos).values({
    id: ids.dupRepoId, workspaceId: null, projectId: ids.dupId, path: sub, createdAt: earlier,
  });
  await d.insert(schema.scheduledRuns).values({
    id: ids.dupRunId, name: "nightly", projectId: ids.dupId, intervalMinutes: 60, enabled: true, createdAt: earlier, updatedAt: earlier,
  });
  await d.insert(schema.preferences).values({ key: "activeProjectId", value: ids.dupId, updatedAt: later });
  return ids;
}

describe("deduplicateProjects — two rows on one git root collapse to a single survivor", () => {
  let repo: ReturnType<typeof makeGitRepo>;

  beforeEach(() => {
    repo = makeGitRepo();
    openTestDb();
  });

  afterEach(() => {
    closeTestDb();
    repo.dispose();
  });

  it("keeps the root-path project, moves the duplicate's children, remaps statuses, redirects active pointer", async () => {
    const ids = await seed(db(), repo.root, repo.sub);

    await deduplicateProjects();

    // (1) Exactly one project survives — the root-path one (NOT the more-recently-updated dup).
    const survivors = await db().select().from(schema.projects);
    expect(survivors).toHaveLength(1);
    expect(survivors[0]?.id).toBe(ids.keepId);
    // Its repoPath is (already) the git root.
    expect(survivors[0]?.repoPath).toBe(repo.root);

    // (2) Both issues now belong to the survivor — the dup's issue was MOVED, not lost.
    const allIssues = await db().select().from(schema.issues);
    expect(allIssues).toHaveLength(2);
    expect(allIssues.every((i) => i.projectId === ids.keepId)).toBe(true);

    // (3) The moved issue's status was remapped by NAME to the survivor's "Todo" status
    //     (the dup's own status row is gone), so it points at a live status.
    const movedIssue = allIssues.find((i) => i.id === ids.dupIssueId);
    expect(movedIssue?.statusId).toBe(ids.keepStatusId);
    const dupStatusRows = await db().select().from(schema.projectStatuses).where(eq(schema.projectStatuses.id, ids.dupStatusId));
    expect(dupStatusRows).toHaveLength(0);

    // (4) Skill / repo / scheduled-run owned by the dup were reassigned to the survivor.
    const skill = await db().select().from(schema.agentSkills).where(eq(schema.agentSkills.id, ids.dupSkillId));
    expect(skill[0]?.projectId).toBe(ids.keepId);
    const repoRow = await db().select().from(schema.repos).where(eq(schema.repos.id, ids.dupRepoId));
    expect(repoRow[0]?.projectId).toBe(ids.keepId);
    const run = await db().select().from(schema.scheduledRuns).where(eq(schema.scheduledRuns.id, ids.dupRunId));
    expect(run[0]?.projectId).toBe(ids.keepId);

    // (5) The active-project pointer, which referenced the removed dup, now points at the survivor.
    const active = await db().select().from(schema.preferences).where(eq(schema.preferences.key, "activeProjectId"));
    expect(active[0]?.value).toBe(ids.keepId);

    // (6) Hard invariant: no row anywhere references a now-deleted parent.
    const fk = await client().execute("PRAGMA foreign_key_check");
    expect(fk.rows).toEqual([]);

    // The FULL project-child completeness + name-mismatched-status assertions (the #929 fix)
    // live in the dedicated test below.
  });
});

// --- #929: dedup must be LOSSLESS across EVERY project-child table, and must not leave a
//     dangling issues.status_id when the duplicate owns a status the survivor lacks.
//
// This mirrors issue-cascade-completeness.repo.test.ts: the set of project-child tables is
// DERIVED from the Drizzle FK graph (projectChildEdges()), not hand-listed, so adding a new
// table that FK-references projects.id turns the completeness guard RED until it is seeded here
// (and, because deduplicateProjects reassigns generically off the same graph, it is handled
// automatically). project_statuses is the one intentional exclusion — the dup's statuses are
// remapped-by-name then deleted, never moved (moving them would duplicate the survivor's columns).
describe("deduplicateProjects — lossless across the FULL project-child FK graph (#929)", () => {
  let repo: ReturnType<typeof makeGitRepo>;

  beforeEach(() => {
    repo = makeGitRepo();
    openTestDb();
  });

  afterEach(() => {
    closeTestDb();
    repo.dispose();
  });

  /**
   * Seed two projects on one git root, the dup owning ONE row in every project-child table
   * (cascade AND non-cascade), plus a NAME-MISMATCHED status ("Backlog") the survivor lacks,
   * with an issue pointing at it. Returns the ids needed to assert survival/remap.
   */
  async function seedFull(d: TestDb, root: string, sub: string) {
    const ids = {
      keepId: randomUUID(), dupId: randomUUID(),
      keepTodoId: randomUUID(), dupTodoId: randomUUID(), dupBacklogId: randomUUID(),
      dupIssueId: randomUUID(), dupBacklogIssueId: randomUUID(),
      skillId: randomUUID(), repoId: randomUUID(), runId: randomUUID(),
      runHistoryId: randomUUID(), milestoneId: randomUUID(), driveId: randomUUID(),
      obstacleId: randomUUID(), templateId: randomUUID(), healthId: randomUUID(),
      flakyId: randomUUID(), shortcutId: randomUUID(), metricId: randomUUID(),
    };
    const earlier = new Date(Date.now() - 60_000).toISOString();
    const later = new Date().toISOString();

    await d.insert(schema.projects).values([
      { id: ids.keepId, name: "app", repoPath: root, repoName: "app", defaultBranch: "main", createdAt: earlier, updatedAt: earlier },
      { id: ids.dupId, name: "app-sub", repoPath: sub, repoName: "app-sub", defaultBranch: "main", createdAt: earlier, updatedAt: later },
    ]);
    // keep has only "Todo"; dup has "Todo" (matched) AND "Backlog" (NAME-MISMATCH — keep lacks it).
    await d.insert(schema.projectStatuses).values([
      { id: ids.keepTodoId, projectId: ids.keepId, name: "Todo", sortOrder: 0, isDefault: true, createdAt: earlier },
      { id: ids.dupTodoId, projectId: ids.dupId, name: "Todo", sortOrder: 0, isDefault: true, createdAt: earlier },
      { id: ids.dupBacklogId, projectId: ids.dupId, name: "Backlog", sortOrder: -1, isDefault: false, createdAt: earlier },
    ]);
    await d.insert(schema.issues).values([
      { id: ids.dupIssueId, issueNumber: 1, title: "Dup issue (matched status)", description: null, priority: "medium", sortOrder: 0, statusId: ids.dupTodoId, projectId: ids.dupId, createdAt: earlier, updatedAt: earlier },
      { id: ids.dupBacklogIssueId, issueNumber: 2, title: "Dup issue (mismatched status)", description: null, priority: "medium", sortOrder: 0, statusId: ids.dupBacklogId, projectId: ids.dupId, createdAt: earlier, updatedAt: earlier },
    ]);
    await d.insert(schema.agentSkills).values({ id: ids.skillId, name: "dup-skill", description: "d", prompt: "p", projectId: ids.dupId, createdAt: earlier, updatedAt: earlier });
    await d.insert(schema.repos).values({ id: ids.repoId, workspaceId: null, projectId: ids.dupId, path: sub, createdAt: earlier });
    await d.insert(schema.scheduledRuns).values({ id: ids.runId, name: "nightly", projectId: ids.dupId, intervalMinutes: 60, enabled: true, createdAt: earlier, updatedAt: earlier });
    await d.insert(schema.scheduledRunHistory).values({ id: ids.runHistoryId, scheduledRunId: ids.runId, projectId: ids.dupId, status: "completed", startedAt: earlier, createdAt: earlier });
    // Cascade children — these were SILENTLY DELETED before #929.
    await d.insert(schema.milestones).values({ id: ids.milestoneId, projectId: ids.dupId, name: "v1", createdAt: earlier });
    await d.insert(schema.drives).values({ id: ids.driveId, projectId: ids.dupId, target: "ship it", status: "active", startedAt: earlier });
    await d.insert(schema.driveObstacles).values({ id: ids.obstacleId, projectId: ids.dupId, driveId: ids.driveId, kind: "stall", severity: "warning", summary: "stuck", detectedAt: earlier });
    // Non-cascade children — these orphaned or ABORTED the merge before #929.
    await d.insert(schema.workflowTemplates).values({ id: ids.templateId, projectId: ids.dupId, name: "Custom Flow", isDefault: false, isBuiltin: false, createdAt: earlier, updatedAt: earlier });
    await d.insert(schema.boardHealthEvents).values({ id: ids.healthId, projectId: ids.dupId, cycleId: "c1", eventType: "observation", summary: "all good", createdAt: earlier });
    await d.insert(schema.flakyTests).values({ id: ids.flakyId, projectId: ids.dupId, testName: "sometimes fails", createdAt: earlier });
    await d.insert(schema.projectScriptShortcuts).values({ id: ids.shortcutId, projectId: ids.dupId, name: "build", command: "pnpm build", cwdMode: "project", sortOrder: 0, createdAt: earlier, updatedAt: earlier });
    await d.insert(schema.qualityMetrics).values({ id: ids.metricId, projectId: ids.dupId, metricKey: "coverage", value: 0.9, collectedAt: earlier });
    await d.insert(schema.preferences).values({ key: "activeProjectId", value: ids.dupId, updatedAt: later });
    return ids;
  }

  it("seeds + verifies EVERY schema-declared project-child table (completeness guard)", () => {
    // Future-proof guard: the tables seedFull() exercises must equal the schema's project-child
    // set (minus project_statuses, the intentional special-case). Add a new projects-referencing
    // table to the schema and this goes RED until it is seeded here — exactly like the issue
    // cascade-completeness guard. Source of truth: projectChildEdges() (derived from the FK graph).
    const schemaChildren = new Set(projectChildEdges().map((e) => e.table));
    schemaChildren.delete("project_statuses"); // remapped-by-name + deleted, never moved
    const exercised = new Set([
      "issues", "agent_skills", "repos", "scheduled_runs", "scheduled_run_history",
      "milestones", "drives", "drive_obstacles", "workflow_templates",
      "board_health_events", "flaky_tests", "project_script_shortcuts", "quality_metrics",
    ]);
    expect(exercised).toEqual(schemaChildren);
  });

  it("reassigns every project-child row to the survivor (no cascade-child data loss, no orphans) and rehomes a name-mismatched status", async () => {
    const ids = await seedFull(db(), repo.root, repo.sub);

    await deduplicateProjects();

    // Exactly one project survives — the root-path one.
    const survivors = await db().select().from(schema.projects);
    expect(survivors).toHaveLength(1);
    expect(survivors[0]?.id).toBe(ids.keepId);

    // EVERY child table: every surviving row points at the survivor — nothing was orphaned to
    // the deleted dup, and (for cascade children) nothing was silently deleted. We assert both
    // "row still exists" (count) and "belongs to keep" generically off the FK graph.
    for (const edge of projectChildEdges()) {
      if (edge.table === "project_statuses") continue; // special-cased
      const col = edge.column;
      const total = await client().execute(`SELECT COUNT(*) AS n FROM "${edge.table}"`);
      const wrong = await client().execute({
        sql: `SELECT COUNT(*) AS n FROM "${edge.table}" WHERE "${col}" IS NOT NULL AND "${col}" != ?`,
        args: [ids.keepId],
      });
      expect(Number(wrong.rows[0]?.n)).toBe(0);
      // Each table we seeded must still have its row(s) — proves cascade children were NOT deleted.
      expect(Number(total.rows[0]?.n)).toBeGreaterThan(0);
    }

    // Name-MATCHED status: the dup's "Todo" issue was remapped to the survivor's "Todo".
    const matchedIssue = (await db().select().from(schema.issues).where(eq(schema.issues.id, ids.dupIssueId)))[0];
    expect(matchedIssue?.statusId).toBe(ids.keepTodoId);

    // Name-MISMATCHED status: the survivor had no "Backlog" status. The issue must NOT dangle —
    // a "Backlog" status was created on the survivor and the issue repointed onto it.
    const mismatchIssue = (await db().select().from(schema.issues).where(eq(schema.issues.id, ids.dupBacklogIssueId)))[0];
    expect(mismatchIssue).toBeDefined();
    expect(mismatchIssue?.statusId).not.toBe(ids.dupBacklogId); // dup's status row is gone
    const rehomedStatusId = mismatchIssue?.statusId ?? "";
    const newStatus = (await db().select().from(schema.projectStatuses).where(eq(schema.projectStatuses.id, rehomedStatusId)))[0];
    expect(newStatus).toBeDefined();
    expect(newStatus?.projectId).toBe(ids.keepId);
    expect(newStatus?.name).toBe("Backlog");
    // The created status must not have stolen the survivor's default flag.
    expect(newStatus?.isDefault).toBe(false);

    // The dup's own status rows are gone.
    expect(await db().select().from(schema.projectStatuses).where(eq(schema.projectStatuses.id, ids.dupTodoId))).toHaveLength(0);
    expect(await db().select().from(schema.projectStatuses).where(eq(schema.projectStatuses.id, ids.dupBacklogId))).toHaveLength(0);

    // Active-project pointer redirected to the survivor.
    const active = await db().select().from(schema.preferences).where(eq(schema.preferences.key, "activeProjectId"));
    expect(active[0]?.value).toBe(ids.keepId);

    // Hard invariant: no row anywhere references a now-deleted parent.
    const fk = await client().execute("PRAGMA foreign_key_check");
    expect(fk.rows).toEqual([]);
  });
});
