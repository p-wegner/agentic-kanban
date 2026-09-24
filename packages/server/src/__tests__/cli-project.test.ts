/**
 * CLI project commands — register / list / unregister / cleanup (split out of `cli.test.ts`
 * in #1236; harness in `helpers/cli-harness.ts`). Every case spawns the bundled CLI as a child
 * process (`spawnSync` in the harness), which is why `scripts/test-mine.mjs` excludes this
 * file from the gate. Cases that only read share one DB per describe; anything that
 * registers, seeds or removes rows takes a fresh template copy.
 */
import { GIT_HEAVY_TEST_TIMEOUT_MS } from "./helpers/timeouts.js";
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@agentic-kanban/shared/schema";
import {
  runCli, createCliTestDb, sharedReadOnlyDb, seedProject, seedIssue, seedWorkspace, openDb, fixtureMainRepo,
  type CliTestDb,
} from "./helpers/cli-harness.js";

// ── register ──────────────────────────────────────────────────────────────────

describe("CLI register", () => {
  let ctx: CliTestDb;
  // A real `git init` main checkout in temp (see `fixtureMainRepo`): `register` refuses a
  // linked worktree, which is where these suites run on this board.
  let repo: string;

  beforeAll(() => { repo = fixtureMainRepo(); });
  beforeEach(() => { ctx = createCliTestDb(); });
  afterEach(() => { ctx.cleanup(); });

  it("registers a git repo as a project", () => {
    const result = runCli(["register", repo], ctx.dbPath);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Registered project");
    expect(result.stdout).toContain("Set as active project");
  });

  it("is idempotent for same repo path", { timeout: GIT_HEAVY_TEST_TIMEOUT_MS }, () => {
    runCli(["register", repo], ctx.dbPath);
    const result = runCli(["register", repo], ctx.dbPath);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("already registered");
  });

  it("registers with custom name", { timeout: GIT_HEAVY_TEST_TIMEOUT_MS }, () => {
    const result = runCli(["register", repo, "--name", "my-custom-name"], ctx.dbPath);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Registered project "my-custom-name"');
  });

  it("errors for non-git path", { timeout: GIT_HEAVY_TEST_TIMEOUT_MS }, () => {
    const result = runCli(["register", "C:\\Windows"], ctx.dbPath);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Error:");
  });
});

// ── list ──────────────────────────────────────────────────────────────────────

describe("CLI list", () => {
  let empty: CliTestDb;

  beforeAll(() => { empty = sharedReadOnlyDb(); });
  afterAll(() => { empty.cleanup(); });

  it("shows message when no projects registered", () => {
    const result = runCli(["list"], empty.dbPath);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("No projects registered");
  });

  it("lists registered projects with active marker", async () => {
    const ctx = createCliTestDb();
    try {
      await seedProject(ctx.dbPath, { name: "Active Project" });
      const result = runCli(["list"], ctx.dbPath);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Active Project");
      expect(result.stdout).toContain("(active)");
    } finally {
      ctx.cleanup();
    }
  });
});

// ── unregister ────────────────────────────────────────────────────────────────

describe("CLI unregister", () => {
  let ctx: CliTestDb;
  let project: { id: string; name: string };

  beforeEach(async () => {
    ctx = createCliTestDb();
    project = await seedProject(ctx.dbPath, { name: "ToRemove" });
  });
  afterEach(() => { ctx.cleanup(); });

  it("removes a project by name", () => {
    const result = runCli(["unregister", "ToRemove"], ctx.dbPath);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Unregistered project");
    expect(result.stdout).toContain("ToRemove");
  });

  it("removes a project by ID", () => {
    const result = runCli(["unregister", project.id], ctx.dbPath);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Unregistered project");
  });

  it("errors for non-existent project", () => {
    const result = runCli(["unregister", "nonexistent"], ctx.dbPath);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("not found");
  });
});

// ── cleanup ───────────────────────────────────────────────────────────────────

describe("CLI cleanup", () => {
  let empty: CliTestDb;

  beforeAll(() => { empty = sharedReadOnlyDb(); });
  afterAll(() => { empty.cleanup(); });

  it("shows message when no stale worktrees", () => {
    const result = runCli(["cleanup"], empty.dbPath);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("No stale worktrees found");
  });

  it("lists closed workspaces with worktrees", async () => {
    const ctx = createCliTestDb();
    try {
      const { id: projectId } = await seedProject(ctx.dbPath);
      const { id: issueId } = await seedIssue(ctx.dbPath, projectId, { title: "WS Issue" });
      await seedWorkspace(ctx.dbPath, issueId, { branch: "feature/test", workingDir: "/tmp/worktree", status: "closed" });

      const result = runCli(["cleanup"], ctx.dbPath);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("closed workspace(s) with worktrees");
      expect(result.stdout).toContain("feature/test");
    } finally {
      ctx.cleanup();
    }
  });

  it("--dry-run lists worktrees without making changes", async () => {
    const ctx = createCliTestDb();
    try {
      const { id: projectId } = await seedProject(ctx.dbPath);
      const { id: issueId } = await seedIssue(ctx.dbPath, projectId, { title: "WS Issue" });
      const { id: workspaceId } = await seedWorkspace(ctx.dbPath, issueId, {
        branch: "feature/test", workingDir: "/tmp/worktree", status: "closed",
      });

      const result = runCli(["cleanup", "--dry-run"], ctx.dbPath);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("would be removed");
      expect(result.stdout).toContain("1 worktree(s)");
      expect(result.stdout).toContain("feature/test");
      expect(result.stdout).toContain(workspaceId);
      expect(result.stdout).not.toContain("git worktree remove --force");

      const verify = openDb(ctx.dbPath);
      const rows = await verify.db.select().from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
      verify.close();

      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("closed");
      expect(rows[0].workingDir).toBe("/tmp/worktree");
    } finally {
      ctx.cleanup();
    }
  });

  it("--dry-run shows dry-run message when no stale worktrees", () => {
    const result = runCli(["cleanup", "--dry-run"], empty.dbPath);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("0 worktree(s) would be removed");
  });
});
