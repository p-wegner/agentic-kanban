// @covers workspaces.nonBlockingSetupRetry.sweep [recovery, db]
//
// #1125 ask 3 — a project with setup_blocking=false never blocks a workspace on a failed
// setup, so born-blocked-reconciler never sees it. This is the non-blocking path's own
// repair-then-retry, scoped to the classified I/O fault only.
import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

vi.mock("../db/index.js", async () => {
  const { createTestDb } = await import("./helpers/test-db.js");
  const schemaMod = await import("@agentic-kanban/shared/schema");
  const { db } = createTestDb();
  return { db, writeDb: db, rawClient: undefined, rawWriteClient: undefined, schema: schemaMod, withDbRetry: <T>(fn: () => Promise<T>) => fn() };
});

import { eq } from "drizzle-orm";
import { issues, projectStatuses, projects, workspaceSetupRun, workspaces } from "@agentic-kanban/shared/schema";
import { db } from "../db/index.js";
import {
  listFailedNonBlockingSetups,
  reconcileNonBlockingSetupRetries,
} from "../startup/non-blocking-setup-retry-reconciler.js";

const OLD = new Date(Date.now() - 60 * 60 * 1000).toISOString();

async function seed(opts: {
  setupBlocking: boolean;
  workspaceStatus?: string;
  setupState?: string | null;
  setupStdoutTail?: string | null;
  setupStderrTail?: string | null;
}) {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const statusId = randomUUID();
  const issueId = randomUUID();
  const workspaceId = randomUUID();
  await db.insert(projects).values({
    id: projectId, name: `p-${projectId.slice(0, 8)}`, repoPath: `/tmp/${projectId}`, repoName: "repo",
    defaultBranch: "main", setupScript: "pnpm install -r", setupBlocking: opts.setupBlocking,
    createdAt: now, updatedAt: now,
  });
  await db.insert(projectStatuses).values({ id: statusId, projectId, name: "In Progress", sortOrder: 1, isDefault: false, createdAt: now });
  await db.insert(issues).values({
    id: issueId, issueNumber: 1125, title: "non-blocking setup retry", priority: "medium", sortOrder: 0,
    statusId, projectId, createdAt: now, updatedAt: now,
  });
  await db.insert(workspaces).values({
    id: workspaceId, issueId, branch: `feature/ak-1125-${workspaceId.slice(0, 8)}`, workingDir: `/repo/.worktrees/${workspaceId.slice(0, 8)}`, baseBranch: "main",
    isDirect: false, status: opts.workspaceStatus ?? "active", provider: "claude",
    createdAt: now, updatedAt: now,
  });
  await db.insert(workspaceSetupRun).values({
    workspaceId,
    state: opts.setupState === undefined ? "failed" : opts.setupState,
    endedAt: OLD,
    stdoutTail: opts.setupStdoutTail ?? null,
    stderrTail: opts.setupStderrTail ?? null,
  });
  return { projectId, issueId, workspaceId };
}

describe("listFailedNonBlockingSetups (#1125)", () => {
  it("finds a failed setup on an ACTIVE, non-blocking-project workspace", async () => {
    const { workspaceId } = await seed({ setupBlocking: false });
    const found = await listFailedNonBlockingSetups(db);
    expect(found.map((r) => r.workspaceId)).toContain(workspaceId);
  });

  it("ignores a blocking project — that one is born-blocked-reconciler's territory", async () => {
    const { workspaceId } = await seed({ setupBlocking: true, workspaceStatus: "blocked" });
    const found = await listFailedNonBlockingSetups(db);
    expect(found.map((r) => r.workspaceId)).not.toContain(workspaceId);
  });

  it("ignores a closed workspace — nothing left to repair the environment for", async () => {
    const { workspaceId } = await seed({ setupBlocking: false, workspaceStatus: "closed" });
    const found = await listFailedNonBlockingSetups(db);
    expect(found.map((r) => r.workspaceId)).not.toContain(workspaceId);
  });

  it("ignores a workspace whose setup did not fail", async () => {
    const { workspaceId } = await seed({ setupBlocking: false, setupState: "succeeded" });
    const found = await listFailedNonBlockingSetups(db);
    expect(found.map((r) => r.workspaceId)).not.toContain(workspaceId);
  });
});

describe("reconcileNonBlockingSetupRetries (#1125)", () => {
  it("repairs the classified I/O fault, retries, and leaves the workspace's status untouched", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kanban-pnpm-store-"));
    const storeDir = path.join(dir, ".pnpm-store", "v10", "files", "42");
    mkdirSync(storeDir, { recursive: true });
    const filePath = path.join(storeDir, "a81d86");
    writeFileSync(filePath, "corrupt");

    const { workspaceId } = await seed({
      setupBlocking: false,
      setupStdoutTail: `ERR_PNPM_UNKNOWN  UNKNOWN: unknown error, stat '${filePath}'`,
    });
    const result = await reconcileNonBlockingSetupRetries({
      database: db, log: () => {},
      runSetup: async () => ({ exitCode: 0, stderr: "" }),
    });

    expect(existsSync(filePath)).toBe(false);
    expect(result.retried).toContain(workspaceId);
    const statusRows = await db.select({ status: workspaces.status }).from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(statusRows[0].status).toBe("active");
    const runRows = await db.select({ tail: workspaceSetupRun.stderrTail })
      .from(workspaceSetupRun).where(eq(workspaceSetupRun.workspaceId, workspaceId));
    expect(runRows[0].tail).toContain("io-fault");
    expect(runRows[0].tail).toContain("repaired");
  });

  it("leaves an unclassified non-blocking failure alone — not this reconciler's job", async () => {
    const { workspaceId } = await seed({
      setupBlocking: false,
      setupStderrTail: "ERR_PNPM_FETCH_404 Not Found",
    });
    const ranIn: string[] = [];
    const result = await reconcileNonBlockingSetupRetries({
      database: db, log: () => {},
      runSetup: async (dir) => { ranIn.push(dir); return { exitCode: 0, stderr: "" }; },
    });
    expect(ranIn).not.toContain(`/repo/.worktrees/${workspaceId.slice(0, 8)}`);
    expect(result.retried).not.toContain(workspaceId);
  });
});
