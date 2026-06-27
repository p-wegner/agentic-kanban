// @covers project-registration.seed.statuses [workflow]
//
// The STATUS-SEEDING WORKFLOW of registration (not the read-back, and not the
// repository helper in isolation).
//
// Scope vs. neighbours — deliberately disjoint:
//   - packages/e2e/tests/api/projects.test.ts asserts GET .../statuses on the
//     long-lived E2E *fixture* project (read-back of an already-seeded project).
//   - registration-default-statuses.test.ts calls initializeProjectStatuses()
//     DIRECTLY (the repository helper, no registration).
//   - This test drives the REAL registerProject() create workflow end-to-end and
//     asserts that registration ITSELF seeds the canonical status set with the
//     correct WORKFLOW shape: the full default set, board ordering by sortOrder,
//     the single entry (default) lane, the pre-board Backlog lane, and the two
//     terminal lanes (Done, Cancelled) sitting at the END of the ordering.
//
// "Terminal" is positional here: project_statuses has no boolean terminal column
// (schema/project-statuses.ts), so a status is terminal by being the last lanes
// of the board — Done/Cancelled carry the highest sortOrders, after every
// active-work lane. Asserting that position is what locks the workflow contract.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Swap the global db for a fresh in-memory libsql db so registerProject() (which
// writes through the default-arg `db` of its repository functions) hits a
// throwaway database — no real kanban.db is touched.
vi.mock("../db/index.js", async () => {
  const { createTestDb } = await import("./helpers/test-db.js");
  const schemaMod = await import("@agentic-kanban/shared/schema");
  const { db } = createTestDb();
  return {
    db,
    writeDb: db,
    rawClient: undefined,
    rawWriteClient: undefined,
    schema: schemaMod,
    withDbRetry: <T>(fn: () => Promise<T>) => fn(),
    withTransaction: <T>(database: { transaction: (fn: unknown) => Promise<T> }, fn: unknown) =>
      database.transaction(fn),
  };
});

import { describe, it, expect, vi, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { projectStatuses } from "@agentic-kanban/shared/schema";
import { db } from "../db/index.js";
import { registerProject } from "../services/project-registration.js";

/** Create a real git repo on `main` with one commit, return its path. */
function makeGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "kanban-seedstatuses-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Seed Status Test");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "README.md"), "# fixture\n");
  git("add", "README.md");
  git("commit", "-m", "initial");
  return dir;
}

describe("registerProject — seeds the canonical status workflow", () => {
  const dirs: string[] = [];

  afterAll(() => {
    for (const d of dirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* best-effort temp cleanup */
      }
    }
  });

  it("seeds the full canonical status set, in board order, as a consequence of registration", async () => {
    const repo = makeGitRepo();
    dirs.push(repo);

    const { project, created } = await registerProject(repo);
    expect(created).toBe(true);

    // The statuses exist ONLY because registration seeded them — read the rows
    // the create workflow produced for this freshly-registered project.
    const rows = await db
      .select()
      .from(projectStatuses)
      .where(eq(projectStatuses.projectId, project.id));

    // 1) Count: the canonical 7-lane set, no duplicates, no omissions.
    expect(rows).toHaveLength(7);

    // 2) Names: exactly the canonical set (compared order-insensitively).
    const names = rows.map((r) => r.name).sort();
    expect(names).toEqual(
      ["AI Reviewed", "Backlog", "Cancelled", "Done", "In Progress", "In Review", "Todo"].sort(),
    );

    // 3) Ordering: laid out in board order by sortOrder. This is the exact
    //    canonical sequence (Backlog at -1 before the board, terminals last).
    const ordered = [...rows].sort((a, b) => a.sortOrder - b.sortOrder);
    expect(ordered.map((r) => r.name)).toEqual([
      "Backlog",
      "Todo",
      "In Progress",
      "In Review",
      "AI Reviewed",
      "Done",
      "Cancelled",
    ]);
    // sortOrders are strictly ascending — no ties that would make the board lane
    // order non-deterministic.
    for (let i = 1; i < ordered.length; i++) {
      expect(ordered[i].sortOrder).toBeGreaterThan(ordered[i - 1].sortOrder);
    }
  });

  it("seeds a single default entry lane (Todo) and the pre-board Backlog(-1) lane", async () => {
    const repo = makeGitRepo();
    dirs.push(repo);

    const { project } = await registerProject(repo);
    const rows = await db
      .select()
      .from(projectStatuses)
      .where(eq(projectStatuses.projectId, project.id));

    // Exactly one default status, and it is Todo — the lane new issues land on
    // (resolveNewIssueDefaults throws if a project has no statuses at all).
    const defaults = rows.filter((r) => r.isDefault);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].name).toBe("Todo");

    // Backlog is the pre-board lane at sortOrder -1 so auto-driven Backlog-pull
    // sees a column that sorts before everything (and is NOT the default).
    const backlog = rows.find((r) => r.name === "Backlog");
    expect(backlog).toBeDefined();
    expect(backlog?.sortOrder).toBe(-1);
    expect(backlog?.isDefault).toBe(false);
  });

  it("places the terminal lanes (Done, Cancelled) at the END of the workflow", async () => {
    const repo = makeGitRepo();
    dirs.push(repo);

    const { project } = await registerProject(repo);
    const rows = await db
      .select()
      .from(projectStatuses)
      .where(eq(projectStatuses.projectId, project.id));

    const byName = new Map(rows.map((r) => [r.name, r.sortOrder]));
    const done = byName.get("Done")!;
    const cancelled = byName.get("Cancelled")!;

    // project_statuses has no boolean terminal flag; terminality is positional.
    // Every active-work / pre-terminal lane must sort BEFORE both terminal lanes,
    // i.e. Done and Cancelled are the two highest sortOrders on the board.
    const terminalFloor = Math.min(done, cancelled);
    for (const name of ["Backlog", "Todo", "In Progress", "In Review", "AI Reviewed"]) {
      expect(byName.get(name)!).toBeLessThan(terminalFloor);
    }
    // Cancelled is the very last lane, Done immediately before it.
    expect(cancelled).toBeGreaterThan(done);
    const maxSort = Math.max(...rows.map((r) => r.sortOrder));
    expect(cancelled).toBe(maxSort);
  });
});
