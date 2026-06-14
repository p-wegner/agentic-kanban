/**
 * #804 — per-drive retro auto-generation.
 *
 * Completing a drive writes `docs/board-runs/<project>.md` from the event log
 * (telemetry): N/N done, providers, cost, cold-build result, obstacles, cascade
 * events — scoped to the drive's window. These tests exercise the shared generator
 * directly (telemetry gather + markdown render + injectable write) and the
 * end-to-end finish path through the drive service.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as schema from "@agentic-kanban/shared/schema";
import {
  gatherDriveTelemetry,
  renderDriveRetro,
  generateDriveRetro,
  driveRetroPath,
  projectSlug,
} from "@agentic-kanban/shared/lib/drive-retro";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { createDriveService } from "../services/drive.service.js";

const DONE = "Done";

async function seed(db: TestDb, repoPath = "/tmp/pulse-crm") {
  const t0 = "2026-06-14T00:00:00.000Z"; // drive start
  const t1 = "2026-06-14T01:00:00.000Z"; // within window
  const t2 = "2026-06-14T02:00:00.000Z"; // drive finish

  const projectId = randomUUID();
  await db.insert(schema.projects).values({
    id: projectId, name: "Pulse CRM", repoPath, repoName: "pulse-crm",
    defaultBranch: "main", createdAt: t0, updatedAt: t0,
  });

  const doneStatusId = randomUUID();
  const backlogStatusId = randomUUID();
  await db.insert(schema.projectStatuses).values([
    { id: backlogStatusId, projectId, name: "Backlog", sortOrder: 0 },
    { id: doneStatusId, projectId, name: DONE, sortOrder: 1 },
  ]);

  // 3 issues: 2 Done, 1 not. One Done is the meta/epic.
  const metaId = randomUUID();
  const issA = randomUUID();
  const issB = randomUUID();
  await db.insert(schema.issues).values([
    { id: metaId, issueNumber: 1, title: "Epic: build PulseCRM", statusId: doneStatusId, projectId, createdAt: t0, updatedAt: t0 },
    { id: issA, issueNumber: 2, title: "Contacts module", statusId: doneStatusId, projectId, createdAt: t0, updatedAt: t0 },
    { id: issB, issueNumber: 3, title: "Reports module", statusId: backlogStatusId, projectId, createdAt: t0, updatedAt: t0 },
  ]);

  // Workspaces + sessions: two claude, one codex; with cost stats.
  const wsA = randomUUID();
  const wsB = randomUUID();
  await db.insert(schema.workspaces).values([
    { id: wsA, issueId: issA, branch: "feature/a", status: "closed", createdAt: t0, updatedAt: t0 },
    { id: wsB, issueId: issB, branch: "feature/b", status: "idle", createdAt: t0, updatedAt: t0 },
  ]);
  await db.insert(schema.sessions).values([
    { id: randomUUID(), workspaceId: wsA, executor: "claude-code", status: "stopped", startedAt: t1, stats: JSON.stringify({ totalCostUsd: 1.25 }) },
    { id: randomUUID(), workspaceId: wsA, executor: "claude-code", status: "stopped", startedAt: t1, stats: JSON.stringify({ totalCostUsd: 0.75 }) },
    { id: randomUUID(), workspaceId: wsB, executor: "codex", status: "stopped", startedAt: t1, stats: JSON.stringify({ totalCostUsd: 0.5 }) },
    // Out-of-window session (after finish) must NOT be counted.
    { id: randomUUID(), workspaceId: wsB, executor: "codex", status: "stopped", startedAt: "2026-06-20T00:00:00.000Z", stats: JSON.stringify({ totalCostUsd: 99 }) },
  ]);

  // Board-health events in the window: a cascade launch, a merge, an error obstacle, a smoke pass.
  await db.insert(schema.boardHealthEvents).values([
    { id: randomUUID(), projectId, cycleId: "c1", eventType: "action", category: "launch", issueNumber: 2, summary: "Started #2 contacts", createdAt: t1 },
    { id: randomUUID(), projectId, cycleId: "c1", eventType: "action", category: "merge", issueNumber: 2, summary: "Merged #2 to main", createdAt: t1 },
    { id: randomUUID(), projectId, cycleId: "c1", eventType: "error", category: "merge", issueNumber: 3, summary: "Conflict merging #3", createdAt: t1 },
    { id: randomUUID(), projectId, cycleId: "c1", eventType: "observation", category: "smoke_check", summary: "Smoke check passed (HTTP 200)", createdAt: t1 },
    // Out-of-window event must NOT be counted.
    { id: randomUUID(), projectId, cycleId: "c2", eventType: "error", category: "launch", summary: "Later unrelated error", createdAt: "2026-06-20T00:00:00.000Z" },
  ]);

  const drive = {
    id: randomUUID(),
    projectId,
    metaIssueId: metaId,
    target: "Build PulseCRM hands-off",
    completionContract: "All children Done",
    status: "completed",
    startedAt: t0,
    finishedAt: t2,
  };

  return { projectId, drive };
}

describe("drive retro telemetry", () => {
  let db: TestDb;
  beforeEach(() => { db = createTestDb().db; });

  it("gathers N/N, providers, cost, cold-build, obstacles and cascade — scoped to the window", async () => {
    const { drive } = await seed(db);
    const t = await gatherDriveTelemetry(drive, db);
    expect(t).not.toBeNull();
    if (!t) return;

    expect(t.projectSlug).toBe("pulse-crm");
    expect(t.issuesTotal).toBe(3);
    expect(t.issuesDone).toBe(2);
    expect(t.meta).toEqual({ issueNumber: 1, title: "Epic: build PulseCRM", done: true });

    // providers: claude-code (2 in-window sessions) ranks above codex (1 in-window); out-of-window excluded
    expect(t.providers).toEqual([
      { name: "claude-code", sessions: 2 },
      { name: "codex", sessions: 1 },
    ]);
    expect(t.sessionCount).toBe(3);
    expect(t.totalCostUsd).toBeCloseTo(2.5, 5); // 1.25 + 0.75 + 0.5 (99 excluded)

    expect(t.coldBuild).toEqual({ result: "passed", summary: "Smoke check passed (HTTP 200)" });
    expect(t.obstacles).toEqual([{ issueNumber: 3, summary: "Conflict merging #3" }]);
    expect(t.cascadeEvents).toHaveLength(2); // launch + merge action; the error-merge is an obstacle, not cascade
    expect(t.cascadeEvents.map((e) => e.category).sort()).toEqual(["launch", "merge"]);
  });

  it("reports cold build FAILED when the latest smoke_check is an observation describing failure", async () => {
    const { drive } = await seed(db);
    // A smoke failure can render the board yet still time out — recorded as an
    // `observation`, not an `error`. It must NOT be classified as "passed".
    await db.insert(schema.boardHealthEvents).values({
      id: randomUUID(), projectId: drive.projectId, cycleId: "c1", eventType: "observation",
      category: "smoke_check", summary: "Board content rendered but request timed out after 30s",
      createdAt: "2026-06-14T01:30:00.000Z",
    });
    const t = await gatherDriveTelemetry(drive, db);
    expect(t!.coldBuild).toEqual({
      result: "FAILED",
      summary: "Board content rendered but request timed out after 30s",
    });
  });

  it("renders markdown with every telemetry section", async () => {
    const { drive } = await seed(db);
    const t = await gatherDriveTelemetry(drive, db);
    const md = renderDriveRetro(t!);

    expect(md).toContain("# Board run — Pulse CRM");
    expect(md).toContain("**2/3 Done.**");
    expect(md).toContain("Meta/epic ticket #1 (Epic: build PulseCRM): Done.");
    expect(md).toContain("`claude-code` — 2 sessions");
    expect(md).toContain("`codex` — 1 session");
    expect(md).toContain("**Total agent cost:** $2.50 across 3 sessions");
    expect(md).toContain("**Cold build:** passed");
    expect(md).toContain("Conflict merging #3");
    expect(md).toContain("## Cascade events");
  });

  it("generates and writes the retro to docs/board-runs/<slug>.md (injectable write)", async () => {
    const { drive } = await seed(db);
    const writes: Array<{ path: string; content: string }> = [];
    const result = await generateDriveRetro(drive, db, {
      writeFile: async (path, content) => { writes.push({ path, content }); },
      mkdir: async () => {},
    });

    expect(result).not.toBeNull();
    expect(result!.path).toBe(driveRetroPath("/tmp/pulse-crm", "pulse-crm"));
    expect(writes).toHaveLength(1);
    expect(writes[0].path).toBe(result!.path);
    expect(writes[0].content).toContain("# Board run — Pulse CRM");
  });

  it("returns null when the project/repo can't be resolved", async () => {
    const result = await generateDriveRetro(
      { id: "x", projectId: "missing", metaIssueId: null, target: "t", completionContract: null, status: "completed", startedAt: "2026-06-14T00:00:00.000Z", finishedAt: null },
      db,
    );
    expect(result).toBeNull();
  });

  it("projectSlug handles spaces, punctuation and empties", () => {
    expect(projectSlug("Pulse CRM")).toBe("pulse-crm");
    expect(projectSlug("Star Raider (HTML5)!")).toBe("star-raider-html5");
    expect(projectSlug("   ")).toBe("project");
  });
});

describe("drive service finish → auto-writes retro (#804)", () => {
  it("completing a drive writes docs/board-runs/<slug>.md; abandoning does not", async () => {
    const { db } = createTestDb();
    const repoPath = mkdtempSync(join(tmpdir(), "drive-retro-"));
    try {
      const { projectId, drive } = await seed(db, repoPath);
      const service = createDriveService({ database: db });

      // Abandon path: no retro file written.
      const abandonDrive = { ...drive, id: randomUUID() };
      await db.insert(schema.drives).values({ ...abandonDrive, status: "active", finishedAt: null });
      const abandoned = await service.finish(projectId, abandonDrive.id, "abandoned");
      expect(abandoned.status).toBe("abandoned");
      expect(existsSync(join(repoPath, "docs", "board-runs", "pulse-crm.md"))).toBe(false);

      // Completed path: retro doc written from telemetry.
      const completeDrive = { ...drive, id: randomUUID() };
      await db.insert(schema.drives).values({ ...completeDrive, status: "active", finishedAt: null });
      const completed = await service.finish(projectId, completeDrive.id, "completed");
      expect(completed.status).toBe("completed");

      const retroFile = join(repoPath, "docs", "board-runs", "pulse-crm.md");
      expect(existsSync(retroFile)).toBe(true);
      const content = readFileSync(retroFile, "utf8");
      expect(content).toContain("# Board run — Pulse CRM");
      expect(content).toContain("**2/3 Done.**");
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });
});
