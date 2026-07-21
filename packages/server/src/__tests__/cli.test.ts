import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { drizzle } from "drizzle-orm/libsql";
import { createClient } from "@libsql/client";
import * as schema from "@agentic-kanban/shared/schema";
import { eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { MIGRATIONS_DIR } from "./helpers/migrations.js";
import { applyMigrationsToClient } from "./helpers/test-db.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = resolve(__dirname, "../cli/index.ts");
const PKG_DIR = resolve(__dirname, "../..");
const REPO_ROOT = resolve(PKG_DIR, "../..");

const TSX_LOADER = pathToFileURL(
  resolve(PKG_DIR, "node_modules/tsx/dist/loader.mjs")
).href;

const DEFAULT_STATUSES = [
  { name: "Todo", sortOrder: 0, isDefault: true },
  { name: "In Progress", sortOrder: 1, isDefault: false },
  { name: "In Review", sortOrder: 2, isDefault: false },
  { name: "AI Reviewed", sortOrder: 3, isDefault: false },
  { name: "Done", sortOrder: 4, isDefault: false },
  { name: "Cancelled", sortOrder: 5, isDefault: false },
];

function applyMigrations(dbPath: string) {
  const client = createClient({ url: `file:${dbPath}` });
  applyMigrationsToClient(client);

  // Populate __drizzle_migrations so the CLI's own runMigrations() is a no-op.
  // manual-migrate.ts tracks applied migrations BY TAG (it skips on
  // `appliedTags.has(entry.tag)` and records `hash = entry.tag`, see #954), so the
  // seed MUST use the tag — not a sha256 of the file content. Seeding sha256 here
  // (the pre-#954 drizzle-kit format) left every tag unmatched, so the CLI re-ran
  // all migrations on the already-migrated temp DB and died on the FK-toggling 0010.
  client.execute("CREATE TABLE IF NOT EXISTS __drizzle_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT NOT NULL UNIQUE, created_at BIGINT NOT NULL)");
  const journal = JSON.parse(readFileSync(resolve(MIGRATIONS_DIR, "meta/_journal.json"), "utf-8"));
  for (const entry of journal.entries) {
    client.execute({ sql: "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)", args: [entry.tag, entry.when] });
  }

  client.close();
}

function createTestDb() {
  const tmpDir = mkdtempSync(join(tmpdir(), "cli-test-"));
  const dbPath = join(tmpDir, "test.db");
  applyMigrations(dbPath);
  return { dbPath, cleanup: () => { try { rmSync(tmpDir, { recursive: true, force: true }); } catch {} } };
}

function runCli(args: string[], dbPath: string) {
  const result = spawnSync(process.execPath, ["--import", TSX_LOADER, CLI_PATH, ...args], {
    env: { ...process.env, DB_URL: `file:${dbPath}` },
    cwd: PKG_DIR,
    encoding: "utf-8",
  });
  return {
    stdout: (result.stdout || "").trim(),
    stderr: (result.stderr || "").trim(),
    status: result.status ?? 1,
  };
}

function runPnpmCli(args: string[], dbPath: string) {
  const pnpm = "pnpm";
  if (!existsSync(resolve(REPO_ROOT, "packages/shared/dist/index.js"))) {
    const build = spawnSync(pnpm, ["--filter", "shared", "build"], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
    });
    if (build.status !== 0) {
      return {
        stdout: build.stdout || "",
        stderr: build.stderr || "",
        status: build.status ?? 1,
      };
    }
  }
  const result = spawnSync(pnpm, ["cli", "--", ...args], {
    env: { ...process.env, DB_URL: `file:${dbPath}` },
    cwd: REPO_ROOT,
    encoding: "utf-8",
  });
  return {
    stdout: (result.stdout || "").trim(),
    stderr: (result.stderr || "").trim(),
    error: result.error?.message,
    status: result.status ?? 1,
  };
}

async function seedProject(dbPath: string, overrides: { name?: string; repoPath?: string } = {}) {
  const client = createClient({ url: `file:${dbPath}` });
  const database = drizzle(client, { schema });
  const now = new Date().toISOString();
  const id = randomUUID();
  const name = overrides.name || "Test Project";
  const repoPath = overrides.repoPath || "/tmp/test-repo";

  await database.insert(schema.projects).values({
    id, name, repoPath, repoName: "test-repo", defaultBranch: "main", createdAt: now, updatedAt: now,
  });

  for (const s of DEFAULT_STATUSES) {
    await database.insert(schema.projectStatuses).values({
      id: randomUUID(), projectId: id, name: s.name, sortOrder: s.sortOrder, isDefault: s.isDefault, createdAt: now,
    });
  }

  await database.insert(schema.preferences).values({ key: "activeProjectId", value: id, updatedAt: now })
    .onConflictDoUpdate({ target: schema.preferences.key, set: { value: id, updatedAt: now } });

  client.close();
  return { id, name };
}

async function seedIssue(dbPath: string, projectId: string, overrides: { title?: string; statusName?: string; priority?: string } = {}) {
  const client = createClient({ url: `file:${dbPath}` });
  const database = drizzle(client, { schema });
  const now = new Date().toISOString();
  const id = randomUUID();

  const statusRows = await database.select().from(schema.projectStatuses)
    .where(eq(schema.projectStatuses.projectId, projectId));
  const targetStatus = overrides.statusName
    ? statusRows.find(s => s.name === overrides.statusName)
    : statusRows.find(s => s.name === "Todo");

  if (!targetStatus) throw new Error(`Status not found for project ${projectId}`);

  const maxResult = await database.select({ maxNum: sql<number | null>`max(${schema.issues.issueNumber})` })
    .from(schema.issues).where(eq(schema.issues.projectId, projectId));
  const issueNumber = (maxResult[0]?.maxNum ?? 0) + 1;

  await database.insert(schema.issues).values({
    id, issueNumber, title: overrides.title || "Test Issue", description: null,
    priority: (overrides.priority as any) || "medium", sortOrder: 0,
    statusId: targetStatus.id, projectId, createdAt: now, updatedAt: now,
  });

  client.close();
  return { id, issueNumber };
}

// ── dispatch gate (regression: AK-47) ─────────────────────────────────────────
// `pnpm cli -- <subcommand>` must dispatch to commander, not fall through to the
// default action (auto-init + start server). Regression for AK-47, where the
// hand-maintained subcommand list missed --help/--version and other args.

describe("CLI dispatch gate", () => {
  let ctx: ReturnType<typeof createTestDb>;

  beforeEach(() => { ctx = createTestDb(); });
  afterEach(() => { ctx.cleanup(); });

  it("does not start the server when a subcommand is passed", () => {
    const result = runCli(["list"], ctx.dbPath);
    expect(result.status).toBe(0);
    // Server startup banner from cli/index.ts default action — must NOT appear.
    expect(result.stdout).not.toContain("Agentic Kanban is running");
    expect(result.stdout).not.toContain("UI:  http://");
  });

  it("--help prints help and exits without starting the server", () => {
    const result = runCli(["--help"], ctx.dbPath);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage:");
    expect(result.stdout).not.toContain("Agentic Kanban is running");
  });

  it("--version prints version and exits without starting the server", () => {
    const result = runCli(["--version"], ctx.dbPath);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("Agentic Kanban is running");
  });
});

// ── register ──────────────────────────────────────────────────────────────────

describe("CLI warning output", () => {
  let ctx: ReturnType<typeof createTestDb>;

  beforeEach(() => { ctx = createTestDb(); });
  afterEach(() => { ctx.cleanup(); });

  it("does not emit the DEP0205 module.register warning through the pnpm status wrapper", async () => {
    await seedProject(ctx.dbPath);
    const result = runPnpmCli(["status"], ctx.dbPath);

    expect(result).toMatchObject({ status: 0 });
    expect(result.stdout).toContain("Board Status: Test Project");
    expect(result.stderr).not.toContain("DEP0205");
  });
});

describe("CLI register", () => {
  let ctx: ReturnType<typeof createTestDb>;

  beforeEach(() => { ctx = createTestDb(); });
  afterEach(() => { ctx.cleanup(); });

  it("registers a git repo as a project", () => {
    const result = runCli(["register", PKG_DIR], ctx.dbPath);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Registered project");
    expect(result.stdout).toContain("Set as active project");
  });

  it("is idempotent for same repo path", { timeout: 30_000 }, () => {
    runCli(["register", PKG_DIR], ctx.dbPath);
    const result = runCli(["register", PKG_DIR], ctx.dbPath);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("already registered");
  });

  it("registers with custom name", { timeout: 30_000 }, () => {
    const result = runCli(["register", PKG_DIR, "--name", "my-custom-name"], ctx.dbPath);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Registered project "my-custom-name"');
  });

  it("errors for non-git path", { timeout: 30_000 }, () => {
    const result = runCli(["register", "C:\\Windows"], ctx.dbPath);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Error:");
  });
});

// ── list ──────────────────────────────────────────────────────────────────────

describe("CLI list", () => {
  let ctx: ReturnType<typeof createTestDb>;

  beforeEach(() => { ctx = createTestDb(); });
  afterEach(() => { ctx.cleanup(); });

  it("shows message when no projects registered", () => {
    const result = runCli(["list"], ctx.dbPath);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("No projects registered");
  });

  it("lists registered projects with active marker", async () => {
    await seedProject(ctx.dbPath, { name: "Active Project" });
    const result = runCli(["list"], ctx.dbPath);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Active Project");
    expect(result.stdout).toContain("(active)");
  });
});

// ── unregister ────────────────────────────────────────────────────────────────

describe("CLI unregister", () => {
  let ctx: ReturnType<typeof createTestDb>;
  let project: { id: string; name: string };

  beforeEach(async () => {
    ctx = createTestDb();
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
  let ctx: ReturnType<typeof createTestDb>;

  beforeEach(() => { ctx = createTestDb(); });
  afterEach(() => { ctx.cleanup(); });

  it("shows message when no stale worktrees", () => {
    const result = runCli(["cleanup"], ctx.dbPath);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("No stale worktrees found");
  });

  it("lists closed workspaces with worktrees", async () => {
    const { id: projectId } = await seedProject(ctx.dbPath);
    const { id: issueId } = await seedIssue(ctx.dbPath, projectId, { title: "WS Issue" });

    const client = createClient({ url: `file:${ctx.dbPath}` });
    const database = drizzle(client, { schema });
    const now = new Date().toISOString();
    await database.insert(schema.workspaces).values({
      id: randomUUID(), issueId, branch: "feature/test", workingDir: "/tmp/worktree",
      baseBranch: "main", isDirect: false, status: "closed", createdAt: now, updatedAt: now,
    });
    client.close();

    const result = runCli(["cleanup"], ctx.dbPath);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("closed workspace(s) with worktrees");
    expect(result.stdout).toContain("feature/test");
  });
});

// ── issue commands ────────────────────────────────────────────────────────────

describe("CLI issue list", () => {
  let ctx: ReturnType<typeof createTestDb>;

  beforeEach(() => { ctx = createTestDb(); });
  afterEach(() => { ctx.cleanup(); });

  it("errors when no active project", () => {
    const result = runCli(["issue", "list"], ctx.dbPath);
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
  let ctx: ReturnType<typeof createTestDb>;

  beforeEach(() => { ctx = createTestDb(); });
  afterEach(() => { ctx.cleanup(); });

  it("creates an issue", async () => {
    await seedProject(ctx.dbPath);
    const result = runCli(["issue", "create", "My New Issue"], ctx.dbPath);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Created issue #1");
    expect(result.stdout).toContain("My New Issue");
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
  let ctx: ReturnType<typeof createTestDb>;
  let issueId: string;

  beforeEach(async () => {
    ctx = createTestDb();
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

// ── workspace commands ────────────────────────────────────────────────────────

describe("CLI workspace list", () => {
  let ctx: ReturnType<typeof createTestDb>;

  beforeEach(() => { ctx = createTestDb(); });
  afterEach(() => { ctx.cleanup(); });

  it("errors when no active project", () => {
    const result = runCli(["workspace", "list"], ctx.dbPath);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("No active project");
  });

  it("shows message when no issues in project", async () => {
    await seedProject(ctx.dbPath);
    const result = runCli(["workspace", "list"], ctx.dbPath);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("No workspaces found");
  });

  it("lists workspaces", async () => {
    const { id: projectId } = await seedProject(ctx.dbPath);
    const { id: issueId } = await seedIssue(ctx.dbPath, projectId);

    const client = createClient({ url: `file:${ctx.dbPath}` });
    const database = drizzle(client, { schema });
    const now = new Date().toISOString();
    await database.insert(schema.workspaces).values({
      id: randomUUID(), issueId, branch: "feature/ws-test", workingDir: "/tmp/ws",
      baseBranch: "main", isDirect: false, status: "active", createdAt: now, updatedAt: now,
    });
    client.close();

    const result = runCli(["workspace", "list"], ctx.dbPath);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("feature/ws-test");
  });
});

// ── skill commands ────────────────────────────────────────────────────────────

describe("CLI skill list", () => {
  let ctx: ReturnType<typeof createTestDb>;

  beforeEach(() => { ctx = createTestDb(); });
  afterEach(() => { ctx.cleanup(); });

  it("shows message when no skills", () => {
    const result = runCli(["skill", "list"], ctx.dbPath);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("No agent skills found");
  });

  it("lists skills after creation", { timeout: 30_000 }, () => {
    runCli(["skill", "create", "my-skill", "-d", "A test skill", "-p", "Do the thing"], ctx.dbPath);
    const result = runCli(["skill", "list"], ctx.dbPath);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("my-skill");
    expect(result.stdout).toContain("A test skill");
  });
});

describe("CLI skill create", () => {
  let ctx: ReturnType<typeof createTestDb>;

  beforeEach(() => { ctx = createTestDb(); });
  afterEach(() => { ctx.cleanup(); });

  it("creates a global skill", () => {
    const result = runCli(["skill", "create", "test-skill", "-d", "Test description", "-p", "Test prompt"], ctx.dbPath);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Created skill 'test-skill'");
    expect(result.stdout).toContain("(global)");
  });

  it("creates a project-scoped skill", { timeout: 30_000 }, async () => {
    const { id: projectId } = await seedProject(ctx.dbPath);
    const result = runCli(["skill", "create", "scoped-skill", "-d", "Scoped", "-p", "Prompt", "--project", projectId], ctx.dbPath);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Created skill 'scoped-skill'");
    expect(result.stdout).toContain("project:");
  });

  it("rejects duplicate names in same scope", { timeout: 30_000 }, () => {
    runCli(["skill", "create", "dup-skill", "-p", "Prompt 1"], ctx.dbPath);
    const result = runCli(["skill", "create", "dup-skill", "-p", "Prompt 2"], ctx.dbPath);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("already exists");
  });

  it("allows same name in different scopes", { timeout: 30_000 }, async () => {
    const { id: projectId } = await seedProject(ctx.dbPath);
    runCli(["skill", "create", "scope-test", "-p", "Global prompt"], ctx.dbPath);
    const result = runCli(["skill", "create", "scope-test", "-p", "Project prompt", "--project", projectId], ctx.dbPath);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Created skill 'scope-test'");
  });

  it("rejects unsafe names with slashes", () => {
    const result = runCli(["skill", "create", "evil/skill", "-p", "Prompt"], ctx.dbPath);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("cannot contain");
  });

  it("rejects unsafe names with ..", () => {
    const result = runCli(["skill", "create", "..traversal", "-p", "Prompt"], ctx.dbPath);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("cannot contain");
  });
});

describe("CLI skill get", () => {
  let ctx: ReturnType<typeof createTestDb>;

  beforeEach(() => { ctx = createTestDb(); });
  afterEach(() => { ctx.cleanup(); });

  it("gets a skill by name", { timeout: 30_000 }, () => {
    runCli(["skill", "create", "findable-skill", "-d", "Can be found", "-p", "Test prompt content"], ctx.dbPath);
    const result = runCli(["skill", "get", "findable-skill"], ctx.dbPath);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("findable-skill");
    expect(result.stdout).toContain("Test prompt content");
  });

  it("gets a skill by ID", { timeout: 30_000 }, () => {
    const createResult = runCli(["skill", "create", "by-id-skill", "-p", "Prompt"], ctx.dbPath);
    const idMatch = createResult.stdout.match(/id: ([a-f0-9-]+)/);
    expect(idMatch).toBeTruthy();
    const skillId = idMatch![1];

    const result = runCli(["skill", "get", skillId], ctx.dbPath);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("by-id-skill");
  });

  it("errors for non-existent skill", () => {
    const result = runCli(["skill", "get", "no-such-skill"], ctx.dbPath);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("not found");
  });
});

// ── issue dependency commands ─────────────────────────────────────────────────

describe("CLI issue dependency", () => {
  let ctx: ReturnType<typeof createTestDb>;
  let projectId: string;
  let issueAId: string;
  let issueBId: string;

  beforeEach(async () => {
    ctx = createTestDb();
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

  it("rejects a duplicate dependency with a friendly message, not a raw driver error (#857)", { timeout: 30_000 }, () => {
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

  it("lists dependencies", { timeout: 30_000 }, () => {
    runCli(["issue", "dependency", "add", issueAId, issueBId], ctx.dbPath);
    const result = runCli(["issue", "dependency", "list", issueAId], ctx.dbPath);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Issue B");
  });

  it("removes a dependency", { timeout: 30_000 }, () => {
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
  let ctx: ReturnType<typeof createTestDb>;
  let projectId: string;

  beforeEach(async () => {
    ctx = createTestDb();
    const project = await seedProject(ctx.dbPath);
    projectId = project.id;
  });
  afterEach(() => { ctx.cleanup(); });

  it("deletes an issue with a direct artifact, issue-level comment, time entry, showdown and an incoming dependency", { timeout: 30_000 }, async () => {
    const issue = await seedIssue(ctx.dbPath, projectId, { title: "Has children" });
    const other = await seedIssue(ctx.dbPath, projectId, { title: "Other" });

    const client = createClient({ url: `file:${ctx.dbPath}` });
    const database = drizzle(client, { schema });
    const now = new Date().toISOString();
    // All attached directly to the issue (no workspace) — the rows the old cascade leaked.
    await database.insert(schema.issueArtifacts).values({ id: randomUUID(), issueId: issue.id, workspaceId: null, type: "text", content: "x", createdAt: now });
    await database.insert(schema.issueComments).values({ id: randomUUID(), issueId: issue.id, workspaceId: null, kind: "note", author: "user", body: "x", createdAt: now });
    await database.insert(schema.issueTimeEntries).values({ id: randomUUID(), issueId: issue.id, minutes: 10, note: null, createdAt: now });
    await database.insert(schema.showdowns).values({ id: randomUUID(), issueId: issue.id, status: "active", createdAt: now, updatedAt: now });
    // Incoming edge: another issue depends on the one being deleted (dependsOnId target).
    await database.insert(schema.issueDependencies).values({ id: randomUUID(), issueId: other.id, dependsOnId: issue.id, type: "blocked_by", createdAt: now });
    client.close();

    const result = runCli(["issue", "delete", String(issue.issueNumber), "--force"], ctx.dbPath);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`Deleted issue #${issue.issueNumber}`);
    // Regression: the old cascade FK-failed with a raw "Failed query: delete from issues ...".
    expect(result.stderr).not.toContain("Failed query");

    const verifyClient = createClient({ url: `file:${ctx.dbPath}` });
    const verifyDb = drizzle(verifyClient, { schema });
    expect(await verifyDb.select().from(schema.issues).where(eq(schema.issues.id, issue.id))).toHaveLength(0);
    // The other issue (and only its now-dangling edge removed) survives.
    expect(await verifyDb.select().from(schema.issues).where(eq(schema.issues.id, other.id))).toHaveLength(1);
    verifyClient.close();
  });
});

describe("CLI issue move terminal-move guard (#854)", () => {
  let ctx: ReturnType<typeof createTestDb>;
  let projectId: string;

  async function seedWorkspace(issueId: string, opts: { status?: string; isDirect?: boolean } = {}) {
    const client = createClient({ url: `file:${ctx.dbPath}` });
    const database = drizzle(client, { schema });
    const now = new Date().toISOString();
    await database.insert(schema.workspaces).values({
      id: randomUUID(), issueId, branch: "feature/ak-x", workingDir: "/tmp/g/.worktrees/x",
      baseBranch: "main", status: opts.status ?? "idle", isDirect: opts.isDirect ?? false,
      createdAt: now, updatedAt: now,
    });
    client.close();
  }

  beforeEach(async () => {
    ctx = createTestDb();
    const project = await seedProject(ctx.dbPath);
    projectId = project.id;
  });
  afterEach(() => { ctx.cleanup(); });

  it("blocks 'issue move <n> Done' while a non-direct workspace is open + unmerged", { timeout: 30_000 }, async () => {
    const issue = await seedIssue(ctx.dbPath, projectId, { title: "Has open ws" });
    await seedWorkspace(issue.id, { status: "idle", isDirect: false });

    const result = runCli(["issue", "move", issue.id, "Done"], ctx.dbPath);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("has not been merged");

    // The move was a no-op — the issue did not enter Done.
    const client = createClient({ url: `file:${ctx.dbPath}` });
    const database = drizzle(client, { schema });
    const [row] = await database
      .select({ statusName: schema.projectStatuses.name })
      .from(schema.issues)
      .innerJoin(schema.projectStatuses, eq(schema.issues.statusId, schema.projectStatuses.id))
      .where(eq(schema.issues.id, issue.id))
      .limit(1);
    expect(row.statusName).not.toBe("Done");
    client.close();
  });

  it("allows 'issue move <n> Done' when no workspace is open", { timeout: 30_000 }, async () => {
    const issue = await seedIssue(ctx.dbPath, projectId, { title: "No ws" });
    const result = runCli(["issue", "move", issue.id, "Done"], ctx.dbPath);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Moved issue to 'Done'");
  });

  it("allows a non-terminal move even with an open workspace", { timeout: 30_000 }, async () => {
    const issue = await seedIssue(ctx.dbPath, projectId, { title: "Open ws, non-terminal move" });
    await seedWorkspace(issue.id, { status: "active", isDirect: false });
    const result = runCli(["issue", "move", issue.id, "In Progress"], ctx.dbPath);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Moved issue to 'In Progress'");
  });
});

