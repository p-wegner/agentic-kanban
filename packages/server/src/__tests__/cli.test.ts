import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { drizzle } from "drizzle-orm/libsql";
import { createClient } from "@libsql/client";
import * as schema from "@agentic-kanban/shared/schema";
import { eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = resolve(__dirname, "../cli.ts");
const PKG_DIR = resolve(__dirname, "../..");

const TSX_LOADER = pathToFileURL(
  resolve(PKG_DIR, "node_modules/tsx/dist/loader.mjs")
).href;

const MIGRATION_FILES = [
  "../../../shared/drizzle/0000_flawless_trauma.sql",
  "../../../shared/drizzle/0001_magical_johnny_storm.sql",
  "../../../shared/drizzle/0002_bent_may_parker.sql",
  "../../../shared/drizzle/0003_tough_lightspeed.sql",
  "../../../shared/drizzle/0004_boring_wind_dancer.sql",
  "../../../shared/drizzle/0005_silky_frog_thor.sql",
  "../../../shared/drizzle/0006_wide_ogun.sql",
  "../../../shared/drizzle/0007_diff_comments.sql",
  "../../../shared/drizzle/0008_direct_workspace.sql",
  "../../../shared/drizzle/0009_requires_review.sql",
  "../../../shared/drizzle/0010_session_messages_cascade.sql",
  "../../../shared/drizzle/0011_timestamps.sql",
  "../../../shared/drizzle/0012_session_stats.sql",
  "../../../shared/drizzle/0013_plan_mode.sql",
  "../../../shared/drizzle/0014_issue_dependencies.sql",
  "../../../shared/drizzle/0015_ai_reviewed_status.sql",
  "../../../shared/drizzle/0016_skip_auto_review.sql",
  "../../../shared/drizzle/0017_agent_config.sql",
  "../../../shared/drizzle/0018_agent_skills.sql",
  "../../../shared/drizzle/0023_dependency_types.sql",
  "../../../shared/drizzle/0019_workspace_skill.sql",
  "../../../shared/drizzle/0020_setup_script.sql",
  "../../../shared/drizzle/0021_project_skills.sql",
  "../../../shared/drizzle/0022_teardown_script.sql",
  "../../../shared/drizzle/0024_setup_enabled.sql",
  "../../../shared/drizzle/0025_provider_session_id.sql",
  "../../../shared/drizzle/0026_ready_for_merge.sql",
  "../../../shared/drizzle/0027_estimate_field.sql",
  "../../../shared/drizzle/0028_perf_indexes_conflict_cache.sql",
  "../../../shared/drizzle/0029_issue_artifacts.sql",
  "../../../shared/drizzle/0030_thorough_review.sql",
  "../../../shared/drizzle/0031_scheduled_runs.sql",
  "../../../shared/drizzle/0032_diff_stat_cache.sql",
  "../../../shared/drizzle/0033_backlog_status.sql",
  "../../../shared/drizzle/0034_session_pid.sql",
  "../../../shared/drizzle/0035_session_trigger.sql",
  "../../../shared/drizzle/0036_scheduled_runs_cron.sql",
  "../../../shared/drizzle/0037_workspace_provider.sql",
  "../../../shared/drizzle/0038_pending_plan_path.sql",
  "../../../shared/drizzle/0039_nullable_default_branch.sql",
  "../../../shared/drizzle/0040_direct_workspace_base_commit.sql",
];

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
  for (const file of MIGRATION_FILES) {
    const sqlText = readFileSync(resolve(__dirname, file), "utf-8");
    const statements = sqlText
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const stmt of statements) {
      client.execute(stmt);
    }
  }

  // Populate __drizzle_migrations so CLI's runMigrations() is a no-op
  client.execute("CREATE TABLE IF NOT EXISTS __drizzle_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT NOT NULL UNIQUE, created_at BIGINT NOT NULL)");
  const journal = JSON.parse(readFileSync(resolve(__dirname, "../../../shared/drizzle/meta/_journal.json"), "utf-8"));
  for (const entry of journal.entries) {
    const sqlFile = resolve(__dirname, `../../../shared/drizzle/${entry.tag}.sql`);
    const sqlContent = readFileSync(sqlFile, "utf-8");
    const hash = createHash("sha256").update(sqlContent).digest("hex");
    client.execute({ sql: "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)", args: [hash, entry.when] });
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

// â”€â”€ register â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

  it("is idempotent for same repo path", { timeout: 15_000 }, () => {
    runCli(["register", PKG_DIR], ctx.dbPath);
    const result = runCli(["register", PKG_DIR], ctx.dbPath);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("already registered");
  });

  it("registers with custom name", { timeout: 15_000 }, () => {
    const result = runCli(["register", PKG_DIR, "--name", "my-custom-name"], ctx.dbPath);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Registered project "my-custom-name"');
  });

  it("errors for non-git path", { timeout: 15_000 }, () => {
    const result = runCli(["register", "C:\\Windows"], ctx.dbPath);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Error:");
  });
});

// â”€â”€ list â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

// â”€â”€ unregister â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

// â”€â”€ cleanup â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

// â”€â”€ issue commands â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

// â”€â”€ workspace commands â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

// â”€â”€ skill commands â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe("CLI skill list", () => {
  let ctx: ReturnType<typeof createTestDb>;

  beforeEach(() => { ctx = createTestDb(); });
  afterEach(() => { ctx.cleanup(); });

  it("shows message when no skills", () => {
    const result = runCli(["skill", "list"], ctx.dbPath);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("No agent skills found");
  });

  it("lists skills after creation", () => {
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

  it("creates a project-scoped skill", async () => {
    const { id: projectId } = await seedProject(ctx.dbPath);
    const result = runCli(["skill", "create", "scoped-skill", "-d", "Scoped", "-p", "Prompt", "--project", projectId], ctx.dbPath);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Created skill 'scoped-skill'");
    expect(result.stdout).toContain("project:");
  });

  it("rejects duplicate names in same scope", () => {
    runCli(["skill", "create", "dup-skill", "-p", "Prompt 1"], ctx.dbPath);
    const result = runCli(["skill", "create", "dup-skill", "-p", "Prompt 2"], ctx.dbPath);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("already exists");
  });

  it("allows same name in different scopes", async () => {
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

  it("gets a skill by name", () => {
    runCli(["skill", "create", "findable-skill", "-d", "Can be found", "-p", "Test prompt content"], ctx.dbPath);
    const result = runCli(["skill", "get", "findable-skill"], ctx.dbPath);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("findable-skill");
    expect(result.stdout).toContain("Test prompt content");
  });

  it("gets a skill by ID", () => {
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

// â”€â”€ issue dependency commands â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

  it("lists dependencies", { timeout: 15_000 }, () => {
    runCli(["issue", "dependency", "add", issueAId, issueBId], ctx.dbPath);
    const result = runCli(["issue", "dependency", "list", issueAId], ctx.dbPath);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Issue B");
  });

  it("removes a dependency", { timeout: 15_000 }, () => {
    const addResult = runCli(["issue", "dependency", "add", issueAId, issueBId], ctx.dbPath);
    const idMatch = addResult.stdout.match(/id: ([a-f0-9-]+)/);
    expect(idMatch).toBeTruthy();
    const depId = idMatch![1];

    const result = runCli(["issue", "dependency", "remove", depId], ctx.dbPath);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Removed dependency");
  });
});

