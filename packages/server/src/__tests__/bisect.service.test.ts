import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { issues, projects, projectStatuses, sessionMessages, sessions, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { createBisectService } from "../services/bisect.service.js";

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

  await db.insert(projects).values({
    id: projectId,
    name: "Bisect Project",
    repoPath,
    repoName: "bisect-project",
    defaultBranch: "main",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(projectStatuses).values({
    id: statusId,
    projectId,
    name: "In Progress",
    sortOrder: 0,
    isDefault: true,
    createdAt: now,
  });
  await db.insert(issues).values({
    id: issueId,
    issueNumber: 1,
    title: "Find break",
    priority: "medium",
    sortOrder: 0,
    statusId,
    projectId,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(workspaces).values({
    id: workspaceId,
    issueId,
    branch: "feature/bisect",
    workingDir: repoPath,
    baseBranch: "main",
    baseCommitSha,
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
  return workspaceId;
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
    await service.runBisect(workspaceId, sessionId, "related");

    const rows = await db.select().from(sessionMessages).where(eq(sessionMessages.sessionId, sessionId));
    const resultMessage = rows.find((row) => row.type === "bisect");
    expect(resultMessage).toBeTruthy();
    const result = JSON.parse(resultMessage!.data!);
    expect(result.status).toBe("found");
    expect(result.breakingCommitSha).toBe(breakingCommit);
    expect(result.failingTestName).toBe("value.test > keeps value passing");
  }, 60_000);
});
