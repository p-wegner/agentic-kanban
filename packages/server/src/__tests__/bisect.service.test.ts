import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { sessionMessages, sessions } from "@agentic-kanban/shared/schema";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { buildBisectTestCommand, createBisectService } from "../services/bisect.service.js";

function execGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout.toString().trim());
    });
  });
}

async function commit(repo: string, message: string): Promise<string> {
  await execGit(["add", "."], repo);
  await execGit(["commit", "-m", message], repo);
  return execGit(["rev-parse", "HEAD"], repo);
}

async function seedWorkspace(db: TestDb, repoPath: string, baseCommitSha: string): Promise<string> {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const statusId = randomUUID();
  const issueId = randomUUID();
  const workspaceId = randomUUID();

  await db.run(sql`
    insert into projects (id, name, repo_path, repo_name, default_branch, created_at, updated_at)
    values (${projectId}, 'Bisect Project', ${repoPath}, 'bisect-project', 'main', ${now}, ${now})
  `);
  await db.run(sql`
    insert into project_statuses (id, project_id, name, sort_order, is_default, created_at)
    values (${statusId}, ${projectId}, 'In Progress', 0, 1, ${now})
  `);
  await db.run(sql`
    insert into issues (id, issue_number, title, priority, sort_order, status_id, project_id, created_at, updated_at)
    values (${issueId}, 1, 'Find break', 'medium', 0, ${statusId}, ${projectId}, ${now}, ${now})
  `);
  await db.run(sql`
    insert into workspaces (id, issue_id, branch, working_dir, base_branch, base_commit_sha, status, created_at, updated_at)
    values (${workspaceId}, ${issueId}, 'feature/bisect', ${repoPath}, 'main', ${baseCommitSha}, 'active', ${now}, ${now})
  `);
  return workspaceId;
}

function repoRoot(): string {
  return process.cwd().replace(/\\/g, "/").endsWith("/packages/server")
    ? join(process.cwd(), "..", "..")
    : process.cwd();
}

describe("bisect.service", () => {
  let db: TestDb;
  let repoDir: string;

  beforeEach(async () => {
    ({ db } = createTestDb());
    repoDir = await mkdtemp(join(tmpdir(), "ak-bisect-"));
    await execGit(["init", "-b", "main"], repoDir);
    await execGit(["config", "user.email", "test@example.com"], repoDir);
    await execGit(["config", "user.name", "Test User"], repoDir);
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it("identifies commit 3 as the first breaking commit on a synthetic 5-commit branch", async () => {
    await writeFile(join(repoDir, "package.json"), JSON.stringify({
      name: "agentic-kanban",
      version: "0.0.0",
      scripts: { test: "node test.mjs" },
    }, null, 2));
    await writeFile(join(repoDir, "test.mjs"), [
      "import { readFileSync } from 'node:fs';",
      "const value = readFileSync('src/value.txt', 'utf8').trim();",
      "if (value === 'bad') {",
      "  console.error('FAIL value.test > keeps value passing');",
      "  process.exit(1);",
      "}",
      "console.log('PASS value.test > keeps value passing');",
    ].join("\n"));
    await mkdir(join(repoDir, "src"));
    await writeFile(join(repoDir, "src/value.txt"), "good\n");
    const baseCommit = await commit(repoDir, "commit 1: base passing");

    await writeFile(join(repoDir, "src/notes.txt"), "still passing\n");
    await commit(repoDir, "commit 2: unrelated passing change");

    await writeFile(join(repoDir, "src/value.txt"), "bad\n");
    const breakingCommit = await commit(repoDir, "commit 3: break value");

    await writeFile(join(repoDir, "src/notes.txt"), "still broken\n");
    await commit(repoDir, "commit 4: keep branch moving");

    await writeFile(join(repoDir, "README.md"), "still broken\n");
    await commit(repoDir, "commit 5: final broken state");

    const workspaceId = await seedWorkspace(db, repoDir, baseCommit);
    const sessionId = randomUUID();
    await db.insert(sessions).values({
      id: sessionId,
      workspaceId,
      executor: "auto-bisect",
      status: "running",
      startedAt: new Date().toISOString(),
      triggerType: "bisect",
    });

    const service = createBisectService({ database: db });
    await service.runBisect(workspaceId, sessionId, "full");

    const rows = await db.select().from(sessionMessages).where(eq(sessionMessages.sessionId, sessionId));
    const resultMessage = rows.find((row) => row.type === "bisect");
    expect(resultMessage).toBeTruthy();
    const result = JSON.parse(resultMessage!.data!);
    expect(result.status).toBe("found");
    expect(result.breakingCommitSha).toBe(breakingCommit);
    expect(result.failingTestName).toBe("value.test > keeps value passing");
  }, 60_000);

  it("uses Vitest's related subcommand for server files in this monorepo", () => {
    const command = buildBisectTestCommand(
      repoRoot(),
      "related",
      ["packages/server/src/services/bisect.service.ts"],
    );

    expect(command.args).toEqual([
      "--filter",
      "agentic-kanban",
      "exec",
      "vitest",
      "related",
      "src/services/bisect.service.ts",
      "--reporter=verbose",
    ]);
    expect(command.args).not.toContain("--related");
  });

  it("falls back to the full server suite when related mode has no server files", () => {
    const command = buildBisectTestCommand(
      repoRoot(),
      "related",
      ["packages/client/src/components/WorkspacePanel.tsx"],
    );

    expect(command.args).toEqual([
      "--filter",
      "agentic-kanban",
      "test",
      "--",
      "--reporter=verbose",
    ]);
    expect(command.args).not.toContain("--related");
  });

  it("does not use Vitest's removed --related flag for unknown repo shapes", () => {
    const command = buildBisectTestCommand(repoDir, "related", ["src/value.txt"]);

    expect(command.args).toEqual([
      "--filter",
      "agentic-kanban",
      "test",
      "--",
      "--reporter=verbose",
    ]);
    expect(command.args).not.toContain("--related");
  });

  it("treats import and build failures as bad commits instead of skipping them", async () => {
    await writeFile(join(repoDir, "package.json"), JSON.stringify({
      name: "agentic-kanban",
      version: "0.0.0",
      scripts: { test: "node test.mjs" },
    }, null, 2));
    await writeFile(join(repoDir, "test.mjs"), "console.log('PASS module.test > loads module');\n");
    const baseCommit = await commit(repoDir, "commit 1: base passing");

    await writeFile(join(repoDir, "README.md"), "still passing\n");
    await commit(repoDir, "commit 2: unrelated passing change");

    await writeFile(join(repoDir, "test.mjs"), [
      "console.error('Cannot find module ./missing.js');",
      "process.exit(1);",
    ].join("\n"));
    const breakingCommit = await commit(repoDir, "commit 3: break import");

    await writeFile(join(repoDir, "README.md"), "still broken\n");
    await commit(repoDir, "commit 4: final broken state");

    const workspaceId = await seedWorkspace(db, repoDir, baseCommit);
    const sessionId = randomUUID();
    await db.insert(sessions).values({
      id: sessionId,
      workspaceId,
      executor: "auto-bisect",
      status: "running",
      startedAt: new Date().toISOString(),
      triggerType: "bisect",
    });

    const service = createBisectService({ database: db });
    await service.runBisect(workspaceId, sessionId, "full");

    const rows = await db.select().from(sessionMessages).where(eq(sessionMessages.sessionId, sessionId));
    const resultMessage = rows.find((row) => row.type === "bisect");
    expect(resultMessage).toBeTruthy();
    const result = JSON.parse(resultMessage!.data!);
    expect(result.status).toBe("found");
    expect(result.breakingCommitSha).toBe(breakingCommit);
    expect(result.skippedCommits).toEqual([]);
  }, 60_000);
});
