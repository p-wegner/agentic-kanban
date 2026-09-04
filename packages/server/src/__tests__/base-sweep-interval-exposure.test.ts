/**
 * #1031 — the EFFECTIVE base-sweep cadence is on the wire, so an operator can see which
 * projects run the full suite on a schedule and how often, rather than inferring it from the
 * posture table. Two surfaces: `GET /api/projects/:id/base-branch-health` (`sweep`) and the
 * per-project `baseSweep` on `GET /api/projects/health`.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preferences, projects } from "@agentic-kanban/shared/schema";
import { gitExecSync } from "@agentic-kanban/shared/lib/git-exec";
import type { BaseSweepInfo } from "@agentic-kanban/shared/types";
import { createTestDb } from "./helpers/test-db.js";
import { createProjectHealthRoute } from "../routes/project-health.js";
import { getProjectHealth } from "../services/project-health.service.js";
import { recordBaseBranchHealth } from "../repositories/base-branch-health.repository.js";
import { invalidatePreferencesCache } from "../repositories/preferences.repository.js";
import { riskPosturePrefKey } from "../services/risk-posture.service.js";

const tempRepos: string[] = [];
function makeRealRepoPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "ak-base-sweep-exposure-"));
  const git = (...args: string[]) => gitExecSync(args, { cwd: dir });
  git("init", "-q", "-b", "master");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("commit", "--allow-empty", "-q", "-m", "init");
  tempRepos.push(dir);
  return dir;
}

type Db = ReturnType<typeof createTestDb>["db"];

async function seedProject(db: Db, name: string, posture?: string): Promise<string> {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  await db.insert(projects).values({
    id: projectId,
    name,
    repoPath: makeRealRepoPath(),
    repoName: "repo",
    defaultBranch: "master",
    createdAt: now,
    updatedAt: now,
  });
  if (posture) {
    await db.insert(preferences).values({ key: riskPosturePrefKey(projectId), value: posture, updatedAt: now });
  }
  invalidatePreferencesCache();
  return projectId;
}

describe("effective base-sweep cadence on the wire (#1031)", () => {
  let db: Db;

  beforeEach(() => {
    ({ db } = createTestDb());
    invalidatePreferencesCache();
  });

  afterEach(() => {
    invalidatePreferencesCache();
    for (const dir of tempRepos.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("GET /projects/:id/base-branch-health reports the posture's interval and the next due time", async () => {
    const projectId = await seedProject(db, "standard project", "standard");
    await recordBaseBranchHealth({ projectId, sha: "abc", branch: "master", outcome: "green" }, db);

    const app = new Hono();
    app.route("/projects", createProjectHealthRoute(db));
    const res = await app.request(`/projects/${projectId}/base-branch-health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { latest: { createdAt: string } | null; sweep: BaseSweepInfo };

    expect(body.sweep).toMatchObject({
      scheduled: true,
      intervalMs: 12 * 60 * 60 * 1000,
      postureLevel: "standard",
      postureSource: "risk_posture",
    });
    expect(body.sweep.reason).toContain("12 h");
    expect(body.latest).not.toBeNull();
    expect(body.sweep.nextDueAt).toBe(
      new Date(Date.parse(body.latest!.createdAt) + 12 * 60 * 60 * 1000).toISOString(),
    );
  });

  it("GET /projects/:id/base-branch-health says NOT scheduled for a project with no posture", async () => {
    const projectId = await seedProject(db, "unchosen project");

    const app = new Hono();
    app.route("/projects", createProjectHealthRoute(db));
    const body = (await (await app.request(`/projects/${projectId}/base-branch-health`)).json()) as {
      sweep: BaseSweepInfo;
    };

    expect(body.sweep.scheduled).toBe(false);
    expect(body.sweep.intervalMs).toBeNull();
    expect(body.sweep.nextDueAt).toBeNull();
    expect(body.sweep.postureSource).toBe("default");
    expect(body.sweep.reason).toContain("opt-in");
  });

  it("GET /projects/health lists every project's effective cadence in one response", async () => {
    const fast = await seedProject(db, "fast project", "fast");
    const iterate = await seedProject(db, "iterate project", "iterate");
    const unchosen = await seedProject(db, "unchosen project");

    const result = await getProjectHealth(db);
    const byId = new Map(result.projects.map((p) => [p.id, p.baseSweep]));

    expect(byId.get(fast)).toMatchObject({ scheduled: true, intervalMs: 6 * 60 * 60 * 1000, postureLevel: "fast" });
    expect(byId.get(iterate)).toMatchObject({ scheduled: true, intervalMs: 24 * 60 * 60 * 1000, postureLevel: "iterate" });
    expect(byId.get(unchosen)).toMatchObject({ scheduled: false, intervalMs: null, postureSource: "default" });

    // The acceptance criterion in one assertion: no listed project sweeps the full suite on a
    // 30-minute cadence.
    for (const p of result.projects) {
      if (p.baseSweep.intervalMs !== null) expect(p.baseSweep.intervalMs).toBeGreaterThanOrEqual(6 * 60 * 60 * 1000);
    }
  });
});
