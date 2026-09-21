// #1206 — reopenWorkspace: re-create the worktree for a CLOSED workspace whose
// branch is still live and unmerged. Uses real temp git repos (like
// workspace-close-multirepo.test.ts) since branch-existence is checked via a real
// `git rev-parse`, which a fake git service would trivially fake past.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { projects, workspaces, issues, projectStatuses } from "@agentic-kanban/shared/schema";
import * as gitService from "../services/git.service.js";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { createWorkspaceCrudService } from "../services/workspace-crud.service.js";

function exec(cmd: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout.toString());
    });
  });
}

async function createTempRepo(prefix: string): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), prefix));
  const dir = join(parent, "repo");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(dir);
  await exec("git", ["init"], dir);
  await writeFile(join(dir, "README.md"), "# Test\n");
  await exec("git", ["add", "."], dir);
  await exec("git", ["commit", "-m", "Initial commit"], dir);
  await exec("git", ["branch", "-M", "main"], dir);
  return dir;
}

let db: TestDb;
let repo: string;
let projectId: string;

beforeAll(async () => {
  ({ db } = createTestDb());
  repo = await createTempRepo("kanban-reopen-");
  projectId = randomUUID();
  await db.insert(projects).values({ id: projectId, name: "p", repoPath: repo, repoName: "repo", defaultBranch: "main" });
  const statusId = randomUUID();
  await db.insert(projectStatuses).values({ id: statusId, projectId, name: "In Review", sortOrder: 0 });
}, 60000);

afterAll(async () => {
  try { await rm(join(repo, ".."), { recursive: true, force: true }); } catch { /* best effort */ }
});

async function seedClosedWorkspace(opts: {
  branch: string;
  createBranch?: boolean;
  isDirect?: boolean;
  mergedAt?: string | null;
  wsStatus?: string;
} = { branch: "feature/ak-x" }): Promise<{ workspaceId: string; issueId: string }> {
  const issueId = randomUUID();
  const statusId = (await db.select().from(projectStatuses).where(eq(projectStatuses.projectId, projectId)))[0].id;
  await db.insert(issues).values({ id: issueId, projectId, statusId, title: "t", issueNumber: Math.floor(Math.random() * 1_000_000) });

  if (opts.createBranch !== false && !opts.isDirect) {
    await exec("git", ["branch", opts.branch], repo);
  }

  const workspaceId = randomUUID();
  await db.insert(workspaces).values({
    id: workspaceId, issueId, branch: opts.branch, baseBranch: "main",
    isDirect: opts.isDirect ?? false,
    status: opts.wsStatus ?? "closed",
    mergedAt: opts.mergedAt ?? null,
    workingDir: null,
  });
  return { workspaceId, issueId };
}

describe("reopenWorkspace (#1206)", () => {
  it("re-creates the worktree and sets status back to idle", async () => {
    const { workspaceId } = await seedClosedWorkspace({ branch: `feature/ak-${randomUUID().slice(0, 8)}` });
    const service = createWorkspaceCrudService({ database: db, gitService });

    const result = await service.reopenWorkspace(workspaceId);

    expect(existsSync(result.workingDir)).toBe(true);
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(ws.status).toBe("idle");
    expect(ws.workingDir).toBe(result.workingDir);
  });

  it("refuses when the workspace is not closed", async () => {
    const { workspaceId } = await seedClosedWorkspace({ branch: `feature/ak-${randomUUID().slice(0, 8)}`, wsStatus: "idle" });
    const service = createWorkspaceCrudService({ database: db, gitService });

    await expect(service.reopenWorkspace(workspaceId)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("refuses a direct workspace", async () => {
    const { workspaceId } = await seedClosedWorkspace({ branch: "main", isDirect: true });
    const service = createWorkspaceCrudService({ database: db, gitService });

    await expect(service.reopenWorkspace(workspaceId)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("refuses an already-merged workspace", async () => {
    const { workspaceId } = await seedClosedWorkspace({ branch: `feature/ak-${randomUUID().slice(0, 8)}`, mergedAt: new Date().toISOString() });
    const service = createWorkspaceCrudService({ database: db, gitService });

    await expect(service.reopenWorkspace(workspaceId)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("refuses when the branch no longer exists", async () => {
    const { workspaceId } = await seedClosedWorkspace({ branch: `feature/ak-gone-${randomUUID().slice(0, 8)}`, createBranch: false });
    const service = createWorkspaceCrudService({ database: db, gitService });

    await expect(service.reopenWorkspace(workspaceId)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("refuses when another open workspace already holds the issue", async () => {
    const branch = `feature/ak-${randomUUID().slice(0, 8)}`;
    const { workspaceId, issueId } = await seedClosedWorkspace({ branch });

    const otherId = randomUUID();
    await db.insert(workspaces).values({
      id: otherId, issueId, branch: `feature/ak-other-${randomUUID().slice(0, 8)}`, baseBranch: "main",
      isDirect: false, status: "idle", workingDir: null,
    });

    const service = createWorkspaceCrudService({ database: db, gitService });
    await expect(service.reopenWorkspace(workspaceId)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("refuses for a nonexistent workspace", async () => {
    const service = createWorkspaceCrudService({ database: db, gitService });
    await expect(service.reopenWorkspace(randomUUID())).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
