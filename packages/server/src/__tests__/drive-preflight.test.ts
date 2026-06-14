/**
 * #807 — Drive preflight: assert hands-off prerequisites before a drive starts.
 *
 * Verifies the preflight reports EXACTLY what's missing on an unprepared project (instead of
 * stalling silently mid-drive), that `autoRepair` fixes the one-switch-fixable blockers and
 * re-evaluates to ready, and that human-only blockers (no statuses, null defaultBranch,
 * exhausted provider) are reported and never silently worked around.
 */
import { describe, it, expect } from "vitest";
import { createRoutes } from "../routes/index.js";
import * as schema from "@agentic-kanban/shared/schema";
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestApp as _createTestApp } from "./helpers/test-app.js";
import { createMockSessionManager } from "./helpers/mocks.js";
import { runDrivePreflight } from "../services/drive-preflight.service.js";
import { cooldownKey as claudeCooldownKey } from "../services/claude-subscription-ring.js";

function createTestApp() {
  return _createTestApp((app, db) => {
    app.route("/api", createRoutes(db, () => createMockSessionManager()));
  });
}

const now = new Date().toISOString();

/** A throwaway node project so offline stack detection succeeds and auto-repair artifacts land in temp. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "preflight-test-"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "preflight-fixture", scripts: { test: "echo test", build: "echo build" } }),
  );
  return dir;
}

const STATUS_COLUMNS = [
  { name: "Backlog", sortOrder: -1 },
  { name: "Todo", sortOrder: 0 },
  { name: "In Progress", sortOrder: 1 },
  { name: "In Review", sortOrder: 2 },
  { name: "Done", sortOrder: 4 },
];

describe("Drive preflight", () => {
  const { db: database } = createTestApp();

  async function seedProject(opts: { defaultBranch?: string | null; withStatuses?: boolean } = {}) {
    const projectId = randomUUID();
    await database.insert(schema.projects).values({
      id: projectId,
      name: "preflight-test",
      repoPath: makeRepo(),
      repoName: "preflight-test",
      defaultBranch: opts.defaultBranch === undefined ? "main" : opts.defaultBranch,
      createdAt: now,
      updatedAt: now,
    });
    if (opts.withStatuses !== false) {
      for (const col of STATUS_COLUMNS) {
        await database.insert(schema.projectStatuses).values({
          id: randomUUID(),
          projectId,
          name: col.name,
          sortOrder: col.sortOrder,
          createdAt: now,
        });
      }
    }
    return projectId;
  }

  function check(result: Awaited<ReturnType<typeof runDrivePreflight>>, id: string) {
    const c = result.checks.find((x) => x.id === id);
    if (!c) throw new Error(`no check ${id}`);
    return c;
  }

  it("blocks on a freshly-registered (undriven) project and lists what's missing", async () => {
    const projectId = await seedProject();
    const result = await runDrivePreflight(projectId, database);

    expect(result.ready).toBe(false);
    // Stack profile + verify gate + incoherent autodrive prefs are the missing pieces.
    expect(check(result, "stackProfile").severity).toBe("block");
    expect(check(result, "verifyGate").severity).toBe("block");
    expect(check(result, "autodrivePrefs").severity).toBe("block");
    // ...and they are all auto-repairable, so the result advertises repairable=true.
    expect(result.repairable).toBe(true);
    // Project basics that ARE satisfied report ok.
    expect(check(result, "project").severity).toBe("ok");
    expect(check(result, "defaultBranch").severity).toBe("ok");
    expect(check(result, "statuses").severity).toBe("ok");
  });

  it("autoRepair flips Drive on, fixes the repairable blockers, and reports ready", async () => {
    const projectId = await seedProject();
    const result = await runDrivePreflight(projectId, database, { autoRepair: true });

    expect(result.repaired).toBe(true);
    expect(result.ready).toBe(true);
    expect(check(result, "stackProfile").severity).toBe("ok");
    expect(check(result, "verifyGate").severity).toBe("ok");
    expect(check(result, "autodrivePrefs").severity).toBe("ok");
    expect(result.drive.enabled).toBe(true);
  });

  it("reports a null defaultBranch as a hard (non-auto-repairable) blocker", async () => {
    const projectId = await seedProject({ defaultBranch: null });
    const result = await runDrivePreflight(projectId, database, { autoRepair: true });

    const branch = check(result, "defaultBranch");
    expect(branch.severity).toBe("block");
    expect(branch.autoRepairable).toBe(false);
    // A human-only blocker means the whole preflight is not auto-repairable, so no repair was attempted.
    expect(result.repaired).toBe(false);
    expect(result.ready).toBe(false);
  });

  it("reports a missing status set as a hard blocker", async () => {
    const projectId = await seedProject({ withStatuses: false });
    const result = await runDrivePreflight(projectId, database);

    const statuses = check(result, "statuses");
    expect(statuses.severity).toBe("block");
    expect(statuses.autoRepairable).toBe(false);
  });

  it("flags a credit-exhausted Claude profile as a hard blocker", async () => {
    const projectId = await seedProject();
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await setPref("provider", "claude");
    await setPref("claude_profile", "anth");
    await setPref(claudeCooldownKey("anth"), future);

    const result = await runDrivePreflight(projectId, database);
    const provider = check(result, "provider");
    expect(provider.severity).toBe("block");
    expect(provider.message).toContain("rate-limited");
    expect(result.ready).toBe(false);
  });

  async function setPref(key: string, value: string) {
    await database
      .insert(schema.preferences)
      .values({ key, value })
      .onConflictDoUpdate({ target: schema.preferences.key, set: { value } });
  }

  it("flags a mock Claude profile as a hard blocker (would run the mock agent)", async () => {
    const projectId = await seedProject();
    await setPref("provider", "claude");
    await setPref("claude_profile", "mock");

    const provider = check(await runDrivePreflight(projectId, database), "provider");
    expect(provider.severity).toBe("block");
    expect(provider.message).toContain("mock");
  });

  it("warns (does not block) when the WIP target is 1 — no real parallelism", async () => {
    const projectId = await seedProject();
    await setPref("nudge_wip_limit", "1");

    const result = await runDrivePreflight(projectId, database);
    expect(check(result, "wipTarget").severity).toBe("warn");
  });

  it("exposes both preflight endpoints", async () => {
    const { app, db } = createTestApp();
    const projectId = randomUUID();
    await db.insert(schema.projects).values({
      id: projectId,
      name: "preflight-route",
      repoPath: makeRepo(),
      repoName: "preflight-route",
      defaultBranch: "main",
      createdAt: now,
      updatedAt: now,
    });

    const getRes = await app.request(`/api/projects/${projectId}/drive/preflight`);
    expect(getRes.status).toBe(200);
    expect((await getRes.json()).checks.length).toBeGreaterThan(0);

    const postRes = await app.request(`/api/projects/${projectId}/drive/preflight`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ autoRepair: false }),
    });
    expect(postRes.status).toBe(200);
    expect((await postRes.json()).repaired).toBe(false);
  });
});
