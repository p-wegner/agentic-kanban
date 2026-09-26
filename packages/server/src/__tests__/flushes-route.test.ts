// #1246 — GET /api/projects/:id/flushes: latest + history of a project's queue flushes,
// read off the stable checkout's `.kanban/flush-state.json`.
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { projects } from "@agentic-kanban/shared/schema";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { createBoardMonitorRoute } from "../routes/board-monitor.js";
import { FLUSH_STATE_RELPATH, type FlushRecord } from "../services/flush-state.js";
import type { FlushesResponse } from "@agentic-kanban/shared/types";

function makeApp(db: TestDb) {
  const app = new Hono();
  app.route("/api/projects", createBoardMonitorRoute(db as never));
  return app;
}

async function seedProject(db: TestDb, repoPath: string): Promise<string> {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  await db.insert(projects).values({
    id: projectId, name: "P", repoPath, repoName: "flushes-repo",
    defaultBranch: "main", createdAt: now, updatedAt: now,
  });
  return projectId;
}

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

describe("GET /api/projects/:id/flushes", () => {
  it("returns latest: null, history: [] for a project that never flushed", async () => {
    const { db } = createTestDb();
    const mainCheckout = mkdtempSync(join(tmpdir(), "ak-flushes-main-"));
    tempDirs.push(mainCheckout);
    const projectId = await seedProject(db, mainCheckout);

    const app = makeApp(db);
    const res = await app.request(`/api/projects/${projectId}/flushes`);
    expect(res.status).toBe(200);
    const body = await res.json() as FlushesResponse;
    expect(body).toEqual({ projectId, latest: null, history: [] });
  });

  it("reads latest + history off the stable checkout, newest first", async () => {
    const { db } = createTestDb();
    const mainCheckout = mkdtempSync(join(tmpdir(), "ak-flushes-main-"));
    tempDirs.push(mainCheckout);
    const stableCheckout = resolve(mainCheckout, "..", "agentic-kanban-stable");
    tempDirs.push(stableCheckout);
    mkdirSync(join(stableCheckout, ".kanban"), { recursive: true });
    const older = record({ id: "flush/20260925-1", at: "2026-09-25T10:00:00.000Z", state: "healed" });
    const newer = record({ id: "flush/20260926-1", at: "2026-09-26T10:00:00.000Z", state: "flushed" });
    writeFileSync(
      join(stableCheckout, FLUSH_STATE_RELPATH),
      JSON.stringify({ version: 1, flushes: [older, newer] }),
      "utf8",
    );
    const projectId = await seedProject(db, mainCheckout);

    const app = makeApp(db);
    const res = await app.request(`/api/projects/${projectId}/flushes`);
    expect(res.status).toBe(200);
    const body = await res.json() as FlushesResponse;
    expect(body.latest?.id).toBe("flush/20260926-1");
    expect(body.history.map((f) => f.id)).toEqual(["flush/20260926-1", "flush/20260925-1"]);
  });

  it("404s for an unknown project", async () => {
    const { db } = createTestDb();
    const app = makeApp(db);
    const res = await app.request(`/api/projects/${randomUUID()}/flushes`);
    expect(res.status).toBe(404);
  });
});
