/**
 * CLI issue commands — list / create / move / delete / dependency (split out of `cli.test.ts`
 * in #1236; harness in `helpers/cli-harness.ts`). Every case spawns the bundled CLI as a child
 * process (`spawnSync` in the harness), which is why `scripts/test-mine.mjs` excludes this
 * file from the gate. Every case that seeds or mutates takes a fresh template copy; the
 * error path that never reaches an insert shares one DB.
 */
import { GIT_HEAVY_TEST_TIMEOUT_MS } from "./helpers/timeouts.js";
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import * as schema from "@agentic-kanban/shared/schema";
import {
  runCli, createCliTestDb, sharedReadOnlyDb, seedProject, seedIssue, seedWorkspace, openDb,
  type CliTestDb,
} from "./helpers/cli-harness.js";

// ── issue commands ────────────────────────────────────────────────────────────

describe("CLI issue list", () => {
  let empty: CliTestDb;
  let ctx: CliTestDb;

  beforeAll(() => { empty = sharedReadOnlyDb(); });
  afterAll(() => { empty.cleanup(); });
  beforeEach(() => { ctx = createCliTestDb(); });
  afterEach(() => { ctx.cleanup(); });

  it("errors when no active project", () => {
    const result = runCli(["issue", "list"], empty.dbPath);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("No active project");
  });

  it("shows message when no issues", async () => {
    await seedProject(ctx.dbPath);
    const result = runCli(["issue", "list"], ctx.dbPath);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("No issues found");
  });

  it("lists issues", async () => {
    const { id: projectId } = await seedProject(ctx.dbPath);
    await seedIssue(ctx.dbPath, projectId, { title: "My Test Issue" });
    const result = runCli(["issue", "list"], ctx.dbPath);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("My Test Issue");
    expect(result.stdout).toContain("#1");
  });

  it("prints JSON when --json is forwarded through the pnpm wrapper separator", async () => {
    const { id: projectId } = await seedProject(ctx.dbPath);
    await seedIssue(ctx.dbPath, projectId, { title: "JSON Test Issue", priority: "high" });

    const result = runCli(["--", "issue", "list", "--json"], ctx.dbPath);

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toEqual([
      expect.objectContaining({
        issueNumber: 1,
        title: "JSON Test Issue",
        priority: "high",
        statusName: "Todo",
      }),
    ]);
  });

  it("filters by status", async () => {
    const { id: projectId } = await seedProject(ctx.dbPath);
    await seedIssue(ctx.dbPath, projectId, { title: "Todo Issue", statusName: "Todo" });
    const result = runCli(["issue", "list", "--status", "In Progress"], ctx.dbPath);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("No issues found");
  });
});

describe("CLI issue create", () => {
  let ctx: CliTestDb;

  beforeEach(() => { ctx = createCliTestDb(); });
  afterEach(() => { ctx.cleanup(); });

  it("creates an issue", async () => {
    await seedProject(ctx.dbPath);
    const result = runCli(["issue", "create", "My New Issue"], ctx.dbPath);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Created issue #1");
    expect(result.stdout).toContain("My New Issue");
    // `issue create` has no --project flag: the project came from the global mutable
    // activeProjectId preference. It must NAME the board it filed into (#335), or a
    // mis-filing stays invisible.
    expect(result.stdout).toMatch(/project: Test Project \([0-9a-f-]{36}\)/);
  });

  it("creates with description and priority", async () => {
    await seedProject(ctx.dbPath);
    const result = runCli([
      "issue", "create", "Important Issue",
      "--description", "Very important",
      "--priority", "high",
    ], ctx.dbPath);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Created issue #1");
  });

  it("errors for invalid status", async () => {
    await seedProject(ctx.dbPath);
    const result = runCli(["issue", "create", "Test", "--status", "NonExistent"], ctx.dbPath);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("not found");
  });
});

describe("CLI issue move", () => {
  let ctx: CliTestDb;
  let issueId: string;

  beforeEach(async () => {
    ctx = createCliTestDb();
    const { id: projectId } = await seedProject(ctx.dbPath);
    const issue = await seedIssue(ctx.dbPath, projectId, { title: "Move Me" });
    issueId = issue.id;
  });
  afterEach(() => { ctx.cleanup(); });

  it("moves an issue to a new status", () => {
    const result = runCli(["issue", "move", issueId, "In Progress"], ctx.dbPath);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("In Progress");
  });

  it("errors for invalid issue ID", () => {
    const result = runCli(["issue", "move", "nonexistent-id", "Todo"], ctx.dbPath);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("not found");
  });

  it("errors for invalid status name", () => {
    const result = runCli(["issue", "move", issueId, "NonExistent"], ctx.dbPath);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("not found");
  });
});

// ── issue dependency commands ─────────────────────────────────────────────────

describe("CLI issue dependency", () => {
  let ctx: CliTestDb;
  let projectId: string;
  let issueAId: string;
  let issueBId: string;

  beforeEach(async () => {
    ctx = createCliTestDb();
    const project = await seedProject(ctx.dbPath);
    projectId = project.id;
    const issueA = await seedIssue(ctx.dbPath, projectId, { title: "Issue A" });
    const issueB = await seedIssue(ctx.dbPath, projectId, { title: "Issue B" });
    issueAId = issueA.id;
    issueBId = issueB.id;
  });
  afterEach(() => { ctx.cleanup(); });

  it("adds a dependency between issues", () => {
    const result = runCli(["issue", "dependency", "add", issueAId, issueBId], ctx.dbPath);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("depends_on");
    expect(result.stdout).toContain(issueAId);
    expect(result.stdout).toContain(issueBId);
  });

  it("rejects a duplicate dependency with a friendly message, not a raw driver error (#857)", { timeout: GIT_HEAVY_TEST_TIMEOUT_MS }, () => {
    const first = runCli(["issue", "dependency", "add", issueAId, issueBId], ctx.dbPath);
    expect(first.status).toBe(0);

    const dup = runCli(["issue", "dependency", "add", issueAId, issueBId], ctx.dbPath);
    expect(dup.status).toBe(1);
    expect(dup.stderr).toContain("This dependency already exists.");
    // Regression: libsql's error message lacks "UNIQUE constraint", so the old
    // string-match leaked the raw "Failed query: ..." instead of this message.
    expect(dup.stderr).not.toContain("Failed query");
  });

  it("adds dependency with custom type", () => {
    const result = runCli(["issue", "dependency", "add", issueAId, issueBId, "--type", "related_to"], ctx.dbPath);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("related_to");
  });

  it("rejects self-dependency", () => {
    const result = runCli(["issue", "dependency", "add", issueAId, issueAId], ctx.dbPath);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("cannot depend on itself");
  });

  it("rejects invalid type", () => {
    const result = runCli(["issue", "dependency", "add", issueAId, issueBId, "--type", "invalid_type"], ctx.dbPath);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Invalid type");
  });

  it("lists dependencies", { timeout: GIT_HEAVY_TEST_TIMEOUT_MS }, () => {
    runCli(["issue", "dependency", "add", issueAId, issueBId], ctx.dbPath);
    const result = runCli(["issue", "dependency", "list", issueAId], ctx.dbPath);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Issue B");
  });

  it("removes a dependency", { timeout: GIT_HEAVY_TEST_TIMEOUT_MS }, () => {
    const addResult = runCli(["issue", "dependency", "add", issueAId, issueBId], ctx.dbPath);
    const idMatch = addResult.stdout.match(/id: ([a-f0-9-]+)/);
    expect(idMatch).toBeTruthy();
    const depId = idMatch![1];

    const result = runCli(["issue", "dependency", "remove", depId], ctx.dbPath);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Removed dependency");
  });
});

describe("CLI issue delete (#858 — FK-safe cascade)", () => {
  let ctx: CliTestDb;
  let projectId: string;

  beforeEach(async () => {
    ctx = createCliTestDb();
    const project = await seedProject(ctx.dbPath);
    projectId = project.id;
  });
  afterEach(() => { ctx.cleanup(); });

  it("deletes an issue with a direct artifact, issue-level comment, time entry, showdown and an incoming dependency", { timeout: GIT_HEAVY_TEST_TIMEOUT_MS }, async () => {
    const issue = await seedIssue(ctx.dbPath, projectId, { title: "Has children" });
    const other = await seedIssue(ctx.dbPath, projectId, { title: "Other" });

    const { db: database, close } = openDb(ctx.dbPath);
    const now = new Date().toISOString();
    // All attached directly to the issue (no workspace) — the rows the old cascade leaked.
    await database.insert(schema.issueArtifacts).values({ id: randomUUID(), issueId: issue.id, workspaceId: null, type: "text", content: "x", createdAt: now });
    await database.insert(schema.issueComments).values({ id: randomUUID(), issueId: issue.id, workspaceId: null, kind: "note", author: "user", body: "x", createdAt: now });
    await database.insert(schema.issueTimeEntries).values({ id: randomUUID(), issueId: issue.id, minutes: 10, note: null, createdAt: now });
    await database.insert(schema.showdowns).values({ id: randomUUID(), issueId: issue.id, status: "active", createdAt: now, updatedAt: now });
    // Incoming edge: another issue depends on the one being deleted (dependsOnId target).
    await database.insert(schema.issueDependencies).values({ id: randomUUID(), issueId: other.id, dependsOnId: issue.id, type: "blocked_by", createdAt: now });
    close();

    const result = runCli(["issue", "delete", String(issue.issueNumber), "--force"], ctx.dbPath);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`Deleted issue #${issue.issueNumber}`);
    // The cascade target project was resolved implicitly (no --project flag), so the
    // destructive path must NAME the board it hit — even under --force, which
    // suppresses the warning (#335).
    expect(result.stdout).toMatch(new RegExp(`project: .+ \\(${projectId}\\)`));
    // Regression: the old cascade FK-failed with a raw "Failed query: delete from issues ...".
    expect(result.stderr).not.toContain("Failed query");

    const verify = openDb(ctx.dbPath);
    expect(await verify.db.select().from(schema.issues).where(eq(schema.issues.id, issue.id))).toHaveLength(0);
    // The other issue (and only its now-dangling edge removed) survives.
    expect(await verify.db.select().from(schema.issues).where(eq(schema.issues.id, other.id))).toHaveLength(1);
    verify.close();
  });
});

describe("CLI issue move terminal-move guard (#854)", () => {
  let ctx: CliTestDb;
  let projectId: string;

  beforeEach(async () => {
    ctx = createCliTestDb();
    const project = await seedProject(ctx.dbPath);
    projectId = project.id;
  });
  afterEach(() => { ctx.cleanup(); });

  it("blocks 'issue move <n> Done' while a non-direct workspace is open + unmerged", { timeout: GIT_HEAVY_TEST_TIMEOUT_MS }, async () => {
    const issue = await seedIssue(ctx.dbPath, projectId, { title: "Has open ws" });
    await seedWorkspace(ctx.dbPath, issue.id, { branch: "feature/ak-x", workingDir: "/tmp/g/.worktrees/x", status: "idle", isDirect: false });

    const result = runCli(["issue", "move", issue.id, "Done"], ctx.dbPath);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("has not been merged");

    // The move was a no-op — the issue did not enter Done.
    const { db: database, close } = openDb(ctx.dbPath);
    const [row] = await database
      .select({ statusName: schema.projectStatuses.name })
      .from(schema.issues)
      .innerJoin(schema.projectStatuses, eq(schema.issues.statusId, schema.projectStatuses.id))
      .where(eq(schema.issues.id, issue.id))
      .limit(1);
    expect(row.statusName).not.toBe("Done");
    close();
  });

  it("allows 'issue move <n> Done' when no workspace is open", { timeout: GIT_HEAVY_TEST_TIMEOUT_MS }, async () => {
    const issue = await seedIssue(ctx.dbPath, projectId, { title: "No ws" });
    const result = runCli(["issue", "move", issue.id, "Done"], ctx.dbPath);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Moved issue to 'Done'");
  });

  it("allows a non-terminal move even with an open workspace", { timeout: GIT_HEAVY_TEST_TIMEOUT_MS }, async () => {
    const issue = await seedIssue(ctx.dbPath, projectId, { title: "Open ws, non-terminal move" });
    await seedWorkspace(ctx.dbPath, issue.id, { branch: "feature/ak-x", workingDir: "/tmp/g/.worktrees/x", status: "active", isDirect: false });
    const result = runCli(["issue", "move", issue.id, "In Progress"], ctx.dbPath);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Moved issue to 'In Progress'");
  });
});
