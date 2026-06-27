// @covers project-registration.register.create [workflow]
//
// The register-create WORKFLOW: registering a git repo is not a bare row INSERT — it
// runs a chain of side-effects that together make the project DRIVEABLE. Existing tests
// cover the API surface (POST /api/projects → 201 {id,name,repoPath}) and the UI modal,
// and other tests cover the seeded-status SHAPE (registration-default-statuses.test.ts) and
// the never-null branch (registration-resolve-default-branch.test.ts) in isolation. What is
// NOT asserted is the create WORKFLOW as a journey through the real registerProject():
// the same call that inserts the row ALSO seeds the canonical statuses, attaches the
// default (board-navigator) skill, and activates the project — and those consequences
// are what let the very next step (create an issue) succeed.
//
// This drives the REAL registerProject() against a REAL temp git repo, with the global db
// swapped for an in-memory test db, and asserts every create-time side-effect plus the
// downstream consequence that issue creation no longer 400s "No statuses found".

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Swap the global db for a fresh in-memory libsql db so registerProject() (which writes
// through the default-arg `db` of its repository functions) hits a throwaway database.
// Mirrors registration-resolve-default-branch.test.ts.
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

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { projects, projectStatuses, preferences, agentSkills } from "@agentic-kanban/shared/schema";
import { db } from "../db/index.js";
import { registerProject } from "../services/project-registration.js";
import { resolveNewIssueDefaults } from "../repositories/issue.repository.js";

/** Create a real git repo on `main` with one commit, return its path. */
function makeGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "kanban-regcreate-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Registration Test");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "README.md"), "# fixture\n");
  git("add", "README.md");
  git("commit", "-m", "initial");
  return dir;
}

describe("registerProject — create workflow side-effects", () => {
  const dirs: string[] = [];
  // The default skill registration looks up by name; seed it so the attach side-effect
  // can be observed (without it, defaultSkillId falls back to null by design).
  const navSkillId = randomUUID();

  beforeAll(async () => {
    await db.insert(agentSkills).values({
      id: navSkillId,
      name: "board-navigator",
      description: "How to use the board",
      prompt: "use the board",
      isBuiltin: true,
      type: "skill",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  });

  afterAll(() => {
    for (const d of dirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* best-effort temp cleanup */
      }
    }
  });

  it("seeds canonical statuses, attaches the default skill, and activates the project — all in one create", async () => {
    const repo = makeGitRepo();
    dirs.push(repo);

    const { project, created } = await registerProject(repo);

    // 1) The row is created (not an idempotent hit) and persisted.
    expect(created).toBe(true);
    const [row] = await db.select().from(projects).where(eq(projects.id, project.id));
    expect(row).toBeDefined();
    expect(row.repoPath).toBe(project.repoPath);

    // 2) The SAME create call seeded the canonical 7-status set for THIS project,
    //    including the Backlog(-1) lane that Backlog-pull auto-start depends on.
    const statuses = await db
      .select()
      .from(projectStatuses)
      .where(eq(projectStatuses.projectId, project.id));
    const names = statuses.map((s) => s.name).sort();
    expect(names).toEqual(
      ["AI Reviewed", "Backlog", "Cancelled", "Done", "In Progress", "In Review", "Todo"].sort(),
    );
    const backlog = statuses.find((s) => s.name === "Backlog");
    expect(backlog?.sortOrder).toBe(-1);

    // 3) The default (board-navigator) skill was attached so the first Builder isn't blind (#531).
    expect(project.defaultSkillId).toBe(navSkillId);
    expect(row.defaultSkillId).toBe(navSkillId);

    // 4) The freshly-registered project is activated (activeProjectId pref points at it).
    const [activePref] = await db
      .select()
      .from(preferences)
      .where(eq(preferences.key, "activeProjectId"));
    expect(activePref?.value).toBe(project.id);

    // 5) Downstream consequence of the workflow: because statuses were seeded, the very
    //    next step a real operator takes — create an issue — resolves a default status
    //    instead of throwing "No statuses found for project". This is what the seeding is FOR.
    const defaults = await resolveNewIssueDefaults(project.id, undefined, db);
    expect(defaults.issueNumber).toBe(1);
    expect(defaults.statusId).toBeTruthy();
    // The resolved default issue status is one of the project's own seeded statuses.
    expect(statuses.map((s) => s.id)).toContain(defaults.statusId);
  });
});
