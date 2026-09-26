// #1253 (#1246 follow-up) — every flush and every heal-state transition appears as a
// board_health_events entry.
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { projects } from "@agentic-kanban/shared/schema";
import { createTestDb, type TestDb } from "../__tests__/helpers/test-db.js";
import { reconcileFlushActivityLog } from "./flush-activity-log-reconciler.js";
import { listBoardHealthEvents } from "../repositories/board-health-events.repository.js";
import { getPreference } from "../repositories/preferences.repository.js";
import { FLUSH_STATE_RELPATH, type FlushRecord } from "../services/flush-state.js";

function record(overrides: Partial<FlushRecord>): FlushRecord {
  return {
    id: "flush/20260926-1",
    at: "2026-09-26T10:00:00.000Z",
    triggeredBy: "auto",
    memberIssueNumbers: [1200],
    memberBranches: ["feature/ak-1200-x"],
    landingSha: "abc123",
    tag: "flush/20260926-1",
    sweepTarget: "master",
    state: "flushed",
    openHealTickets: [],
    updatedAt: "2026-09-26T10:00:00.000Z",
    ...overrides,
  };
}

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length) {
    try { rmSync(tempDirs.pop()!, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

async function seedProjectWithFlushes(db: TestDb, flushes: FlushRecord[]): Promise<{ projectId: string; mainCheckout: string }> {
  const mainCheckout = mkdtempSync(join(tmpdir(), "ak-flush-activity-main-"));
  tempDirs.push(mainCheckout);
  const stableCheckout = resolve(mainCheckout, "..", "agentic-kanban-stable");
  tempDirs.push(stableCheckout);
  mkdirSync(join(stableCheckout, ".kanban"), { recursive: true });
  writeFileSync(join(stableCheckout, FLUSH_STATE_RELPATH), JSON.stringify({ version: 1, flushes }), "utf8");

  const now = new Date().toISOString();
  const projectId = randomUUID();
  await db.insert(projects).values({
    id: projectId, name: "P", repoPath: mainCheckout, repoName: "flush-activity-repo",
    defaultBranch: "main", createdAt: now, updatedAt: now,
  });
  return { projectId, mainCheckout };
}

describe("reconcileFlushActivityLog", () => {
  it("logs a new flush's first appearance", async () => {
    const { db } = createTestDb();
    const { projectId } = await seedProjectWithFlushes(db, [record({})]);

    const result = await reconcileFlushActivityLog({ database: db });
    expect(result.logged).toEqual([{ projectId, flushId: "flush/20260926-1", state: "flushed" }]);

    const events = await listBoardHealthEvents({ projectId }, db);
    expect(events).toHaveLength(1);
    expect(events[0].category).toBe("flush");
    expect(events[0].summary).toContain("flush/20260926-1 started");
  });

  it("logs nothing on a second sweep with no state change", async () => {
    const { db } = createTestDb();
    const { projectId } = await seedProjectWithFlushes(db, [record({})]);

    await reconcileFlushActivityLog({ database: db });
    const second = await reconcileFlushActivityLog({ database: db });
    expect(second.logged).toEqual([]);

    const events = await listBoardHealthEvents({ projectId }, db);
    expect(events).toHaveLength(1);
  });

  it("logs a heal-state transition as its own entry", async () => {
    const { db } = createTestDb();
    const { projectId, mainCheckout } = await seedProjectWithFlushes(db, [record({ state: "flushed" })]);
    await reconcileFlushActivityLog({ database: db });

    // The flush record moved to "red" — same as a future writer calling applyFlushTransition.
    const stableCheckout = resolve(mainCheckout, "..", "agentic-kanban-stable");
    writeFileSync(
      join(stableCheckout, FLUSH_STATE_RELPATH),
      JSON.stringify({ version: 1, flushes: [record({ state: "red", updatedAt: "2026-09-26T11:00:00.000Z" })] }),
      "utf8",
    );

    const result = await reconcileFlushActivityLog({ database: db });
    expect(result.logged).toEqual([{ projectId, flushId: "flush/20260926-1", state: "red" }]);

    const events = await listBoardHealthEvents({ projectId }, db);
    expect(events).toHaveLength(2);
    expect(events[0].summary).toBe("flush flush/20260926-1 -> red");
  });

  it("persists the cursor as a per-project preference", async () => {
    const { db } = createTestDb();
    const { projectId } = await seedProjectWithFlushes(db, [record({ state: "healing" })]);
    await reconcileFlushActivityLog({ database: db });

    const stored = await getPreference(`flush_activity_log_state_${projectId}`, db);
    expect(stored).not.toBeNull();
    expect(JSON.parse(stored!)).toEqual({ loggedStates: { "flush/20260926-1": "healing" } });
  });

  it("skips a project with no flushes, without error", async () => {
    const { db } = createTestDb();
    const mainCheckout = mkdtempSync(join(tmpdir(), "ak-flush-activity-empty-"));
    tempDirs.push(mainCheckout);
    const now = new Date().toISOString();
    const projectId = randomUUID();
    await db.insert(projects).values({
      id: projectId, name: "P", repoPath: mainCheckout, repoName: "no-flush-repo",
      defaultBranch: "main", createdAt: now, updatedAt: now,
    });

    const result = await reconcileFlushActivityLog({ database: db });
    expect(result.logged).toEqual([]);
    expect(result.skipped).toBe(1);
  });
});
