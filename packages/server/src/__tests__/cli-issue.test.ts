/**
 * CLI issue commands — list / create / move / delete / dependency (split out of `cli.test.ts`
 * in #1236; harness in `helpers/cli-harness.ts`). Every case spawns the bundled CLI as a child
 * process (`spawnSync` in the harness), which is why `scripts/test-mine.mjs` excludes this
 * file from the gate. Every case that seeds or mutates takes a fresh template copy; the
 * error path that never reaches an insert shares one DB.
 */
import { GIT_HEAVY_TEST_TIMEOUT_MS } from "./helpers/timeouts.js";
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import * as schema from "@agentic-kanban/shared/schema";
import { spawn } from "node:child_process";
import { writeFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  runCli, createCliTestDb, sharedReadOnlyDb, seedProject, seedIssue, seedWorkspace, openDb,
  builtCliPath, PKG_DIR, type CliTestDb, type CliResult,
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

  it("applies --tag no-auto-start atomically with the issue insert (#1254)", async () => {
    await seedProject(ctx.dbPath);
    const result = runCli(["issue", "create", "Maintenance ticket", "--tag", "no-auto-start"], ctx.dbPath);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Created issue #1");

    const { db: database, close } = openDb(ctx.dbPath);
    try {
      const issue = (await database.select().from(schema.issues).where(eq(schema.issues.issueNumber, 1)))[0];
      const rows = await database.select({ name: schema.tags.name })
        .from(schema.issueTags)
        .innerJoin(schema.tags, eq(schema.issueTags.tagId, schema.tags.id))
        .where(eq(schema.issueTags.issueId, issue.id));
      expect(rows.map((r) => r.name)).toEqual(["no-auto-start"]);
    } finally {
      close();
    }
  });

  it("accepts --tag repeated for multiple tags", async () => {
    await seedProject(ctx.dbPath);
    const result = runCli(["issue", "create", "Multi-tag ticket", "--tag", "no-auto-start", "--tag", "urgent"], ctx.dbPath);
    expect(result.status).toBe(0);

    const { db: database, close } = openDb(ctx.dbPath);
    try {
      const issue = (await database.select().from(schema.issues).where(eq(schema.issues.issueNumber, 1)))[0];
      const rows = await database.select({ name: schema.tags.name })
        .from(schema.issueTags)
        .innerJoin(schema.tags, eq(schema.issueTags.tagId, schema.tags.id))
        .where(eq(schema.issueTags.issueId, issue.id));
      expect(rows.map((r) => r.name).sort()).toEqual(["no-auto-start", "urgent"]);
    } finally {
      close();
    }
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

// ── issue writes go through a running board server (so an open board shows them) ──

interface SeenRequest { method: string; url: string; body: unknown }

/**
 * A FAKE board on listen(0) — never the real 3001. Its /api/health reports `dbPath` as the DB
 * it serves, which is what the CLI matches against its own before routing a write here.
 */
type FakeAnswer = { status: number; body: unknown };
async function startFakeBoard(dbPath: string, answer: (r: SeenRequest) => FakeAnswer | Promise<FakeAnswer>) {
  const seen: SeenRequest[] = [];
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => { raw += c.toString("utf8"); });
    req.on("end", async () => {
      const r: SeenRequest = { method: req.method ?? "", url: req.url ?? "", body: raw ? JSON.parse(raw) : null };
      const out = r.url === "/api/health"
        ? { status: 200, body: { status: "ok", db: { path: dbPath } } }
        : (seen.push(r), await answer(r));
      res.writeHead(out.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(out.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  return { port, seen, close: () => new Promise<void>((r) => server.close(() => r())) };
}

/** Async spawn: `runCli`'s spawnSync would block the fake server in this same process. */
function runCliAsync(args: string[], dbPath: string, port: number): Promise<CliResult> {
  const env: Record<string, string | undefined> = { ...process.env, DB_URL: `file:${dbPath}`, KANBAN_BOARD_SERVER_PORT: String(port) };
  delete env.KANBAN_CLI_WRITE_TRANSPORT;
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [builtCliPath(), ...args], { env, cwd: PKG_DIR, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => { stdout += c.toString("utf8"); });
    child.stderr.on("data", (c: Buffer) => { stderr += c.toString("utf8"); });
    child.on("close", (code) => resolveRun({ stdout: stdout.trim(), stderr: stderr.trim(), status: code ?? 1 }));
  });
}

describe("CLI issue writes route through a running board server", () => {
  let ctx: CliTestDb;
  let projectId: string;
  let board: Awaited<ReturnType<typeof startFakeBoard>> | null = null;

  beforeEach(async () => {
    ctx = createCliTestDb();
    projectId = (await seedProject(ctx.dbPath)).id;
  });
  afterEach(async () => {
    if (board) await board.close();
    board = null;
    ctx.cleanup();
  });

  async function statusId(name: string): Promise<string> {
    const { db: database, close } = openDb(ctx.dbPath);
    try {
      const [row] = await database.select({ id: schema.projectStatuses.id }).from(schema.projectStatuses)
        .where(and(eq(schema.projectStatuses.projectId, projectId), eq(schema.projectStatuses.name, name))).limit(1);
      return row.id;
    } finally { close(); }
  }

  it("issue create POSTs /api/issues (tags included) and keeps the 'Created issue #N' output", async () => {
    board = await startFakeBoard(ctx.dbPath, () => ({ status: 201, body: { id: "srv-id-1", issueNumber: 42 } }));
    const result = await runCliAsync(["issue", "create", "Via server", "--tag", "no-auto-start", "--tag", "urgent", "-p", "high", "-s", "Todo"], ctx.dbPath, board.port);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Created issue #42: Via server");
    expect(result.stdout).toContain("id: srv-id-1");
    expect(result.stderr).not.toContain("wrote to the database directly");
    expect(board.seen).toEqual([{
      method: "POST",
      url: "/api/issues",
      body: expect.objectContaining({ projectId, statusId: await statusId("Todo"), title: "Via server", priority: "high", tags: ["no-auto-start", "urgent"] }),
    }]);
    // The server owns the write: nothing landed in the DB behind its back.
    const { db: database, close } = openDb(ctx.dbPath);
    try {
      expect(await database.select().from(schema.issues)).toHaveLength(0);
    } finally { close(); }
  });

  it("issue move PATCHes statusId (not a name), and prints the server's refusal on a 409", async () => {
    const issue = await seedIssue(ctx.dbPath, projectId, { title: "Move me" });
    // A 200 means the server applied the write; #1284's read-back checks that it did, so the
    // fake applies it too, exactly as the real PATCH route would.
    board = await startFakeBoard(ctx.dbPath, async (r) => {
      const { db: database, close } = openDb(ctx.dbPath);
      try {
        await database.update(schema.issues).set({ statusId: (r.body as { statusId: string }).statusId }).where(eq(schema.issues.id, issue.id));
      } finally { close(); }
      return { status: 200, body: { id: issue.id } };
    });
    const moved = await runCliAsync(["issue", "move", issue.id, "In Progress"], ctx.dbPath, board.port);
    expect(moved.status, moved.stderr).toBe(0);
    expect(moved.stdout).toContain("Moved issue to 'In Progress'");
    expect(board.seen).toEqual([{ method: "PATCH", url: `/api/issues/${issue.id}`, body: { statusId: await statusId("In Progress") } }]);

    await board.close();
    board = await startFakeBoard(ctx.dbPath, () => ({ status: 409, body: { error: "Cannot move to Done: branch has not been merged" } }));
    const refused = await runCliAsync(["issue", "move", issue.id, "Done"], ctx.dbPath, board.port);
    expect(refused.status, refused.stderr).toBe(1);
    expect(refused.stderr).toContain("Cannot move to Done: branch has not been merged");
    expect(refused.stdout).not.toContain("Moved issue");
  });

  it("issue update PATCHes only the recognised fields it was given", async () => {
    const issue = await seedIssue(ctx.dbPath, projectId, { title: "Old" });
    board = await startFakeBoard(ctx.dbPath, () => ({ status: 200, body: { id: issue.id } }));
    const result = await runCliAsync(["issue", "update", issue.id, "--title", "New", "-p", "low"], ctx.dbPath, board.port);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("(title, priority)");
    expect(board.seen).toEqual([{ method: "PATCH", url: `/api/issues/${issue.id}`, body: { title: "New", priority: "low" } }]);
  });

  it("issue dependency add POSTs /api/issues/:id/dependencies; update-batch POSTs the batch route", async () => {
    const a = await seedIssue(ctx.dbPath, projectId, { title: "A" });
    const b = await seedIssue(ctx.dbPath, projectId, { title: "B" });
    board = await startFakeBoard(ctx.dbPath, (r) => r.url.endsWith("/batch")
      ? { status: 200, body: { added: 1, removed: 0, skipped: [] } }
      : { status: 201, body: { id: "dep-srv-1", type: "blocked_by" } });
    const added = await runCliAsync(["issue", "dependency", "add", a.id, b.id, "-t", "blocked_by"], ctx.dbPath, board.port);
    expect(added.status, added.stderr).toBe(0);
    expect(added.stdout).toContain(`Added 'blocked_by' dependency: ${a.id} -> ${b.id}`);
    expect(added.stdout).toContain("id: dep-srv-1");

    const edgesFile = `${ctx.dbPath}.edges.json`;
    writeFileSync(edgesFile, JSON.stringify([{ issueId: b.id, dependsOnId: a.id, type: "related_to", action: "add" }]));
    const batch = await runCliAsync(["issue", "dependency", "update-batch", edgesFile], ctx.dbPath, board.port)
      .finally(() => rmSync(edgesFile, { force: true }));
    expect(batch.status, batch.stderr).toBe(0);
    expect(batch.stdout).toContain("Added: 1, Removed: 0, Skipped: 0");
    expect(board.seen).toEqual([
      { method: "POST", url: `/api/issues/${a.id}/dependencies`, body: { dependsOnId: b.id, type: "blocked_by" } },
      { method: "POST", url: "/api/issues/dependencies/batch", body: { edges: [{ issueId: b.id, dependsOnId: a.id, type: "related_to", action: "add" }] } },
    ]);
  });

  it("falls back to the direct DB write, with ONE notice, when the server serves a different database", async () => {
    board = await startFakeBoard("/some/other/kanban.db", () => ({ status: 500, body: { error: "must not be called" } }));
    const result = await runCliAsync(["issue", "create", "Direct"], ctx.dbPath, board.port);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Created issue #1: Direct");
    expect(board.seen).toEqual([]);
    const notices = result.stderr.split(/\r?\n/).filter((l) => l.includes("will not show this change until it is reloaded"));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("serves a different database");
  });
});
