/**
 * The queue-pressure signal assembled (#1246): ready-for-merge workspaces from the DB, joined
 * with the gate-run ledger (#1234) off a repo checkout, through the pure `computeQueuePressure`.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { issues, projectStatuses, projects, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { getQueuePressure } from "../services/queue-pressure.service.js";

const NOW = Date.parse("2026-09-26T12:00:00.000Z");
const isoAgo = (ms: number) => new Date(NOW - ms).toISOString();

async function seedProjectWithReadyWorkspaces(db: TestDb, readySinceOffsets: number[]): Promise<string> {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const statusId = randomUUID();
  await db.insert(projects).values({
    id: projectId, name: "P", repoPath: "/tmp/queue-pressure-repo", repoName: "queue-pressure-repo",
    defaultBranch: "main", createdAt: now, updatedAt: now,
  });
  await db.insert(projectStatuses).values({
    id: statusId, projectId, name: "In Review", sortOrder: 0, isDefault: true, createdAt: now,
  });
  for (const [index, offsetMs] of readySinceOffsets.entries()) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId, issueNumber: index + 1, title: "T", statusId, projectId, createdAt: now, updatedAt: now,
    });
    await db.insert(workspaces).values({
      id: randomUUID(), issueId, branch: "feature/x", status: "idle",
      workingDir: "/tmp/x", isDirect: false, readyForMerge: true,
      createdAt: now, updatedAt: isoAgo(offsetMs),
    });
  }
  return projectId;
}

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length) {
    try { rmSync(tempDirs.pop()!, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

describe("getQueuePressure", () => {
  it("reads queue depth and oldest-waiting age off the DB, with no repo path", async () => {
    const { db } = createTestDb();
    const projectId = await seedProjectWithReadyWorkspaces(db, [10 * 60_000, 48 * 60_000]);
    const summary = await getQueuePressure(projectId, null, db, NOW);
    expect(summary.queueDepth).toBe(2);
    expect(summary.oldestWaitingMs).toBe(48 * 60_000);
    expect(summary.arrivalsPerHour).toBe(0);
    expect(summary.gateRunsPerHour).toBe(0);
  });

  it("reads an empty queue for a project with no ready workspaces", async () => {
    const { db } = createTestDb();
    const projectId = await seedProjectWithReadyWorkspaces(db, []);
    const summary = await getQueuePressure(projectId, null, db, NOW);
    expect(summary.queueDepth).toBe(0);
    expect(summary.oldestWaitingMs).toBeNull();
  });

  it("joins the gate-run ledger when the repo has one, excluding suspect rows", async () => {
    const { db } = createTestDb();
    const projectId = await seedProjectWithReadyWorkspaces(db, []);
    const repoPath = mkdtempSync(join(tmpdir(), "ak-queue-pressure-repo-"));
    tempDirs.push(repoPath);
    mkdirSync(join(repoPath, ".test-impact"), { recursive: true });
    const rows = [
      { at: new Date(NOW - 10 * 60_000).toISOString(), source: "ci" },
      { at: new Date(NOW - 20 * 60_000).toISOString(), source: "ci" },
      { at: new Date(NOW - 15 * 60_000).toISOString(), source: "ci-nochange" }, // suspect — excluded
      { at: new Date(NOW - 90 * 60_000).toISOString(), source: "ci" }, // outside the 1h window
    ];
    writeFileSync(join(repoPath, ".test-impact", "outcomes.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
    const summary = await getQueuePressure(projectId, repoPath, db, NOW);
    expect(summary.gateRunsPerHour).toBe(2);
    expect(summary.arrivalsPerHour).toBe(2);
  });

  it("reads a repo with no ledger file as zero arrivals, never throwing", async () => {
    const { db } = createTestDb();
    const projectId = await seedProjectWithReadyWorkspaces(db, []);
    const repoPath = mkdtempSync(join(tmpdir(), "ak-queue-pressure-repo-"));
    tempDirs.push(repoPath);
    const summary = await getQueuePressure(projectId, repoPath, db, NOW);
    expect(summary.arrivalsPerHour).toBe(0);
    expect(summary.gateRunsPerHour).toBe(0);
  });
});
