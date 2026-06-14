/**
 * #806 — one-switch "Drive this project" toggle.
 *
 * Verifies that flipping the single Drive switch sets the whole coherent bundle of
 * preferences (autodrive opt-in, auto-merge kill-switch, global review+merge, planMode-off,
 * stack profile + verify gate) — and that turning it off restores triage mode without
 * destroying the non-destructive artifacts.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createRoutes } from "../routes/index.js";
import * as schema from "@agentic-kanban/shared/schema";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestApp as _createTestApp } from "./helpers/test-app.js";
import { createMockSessionManager } from "./helpers/mocks.js";

function createTestApp() {
  return _createTestApp((app, db) => {
    app.route("/api", createRoutes(db, () => createMockSessionManager()));
  });
}

const now = new Date().toISOString();
// A throwaway node project so stack detection (offline, skipLlm) succeeds and any artifacts
// Drive seeds (smart-hooks rules, test scaffold) land in temp — never in the real repo.
const REPO_PATH = mkdtempSync(join(tmpdir(), "drive-test-"));
writeFileSync(
  join(REPO_PATH, "package.json"),
  JSON.stringify({ name: "drive-fixture", scripts: { test: "echo test", build: "echo build" } }),
);

describe("Drive toggle — POST flips the whole coherent bundle", () => {
  const { app, db: database } = createTestApp();
  let projectId: string;

  async function pref(key: string): Promise<string | undefined> {
    const rows = await database.select().from(schema.preferences);
    return rows.find((r) => r.key === key)?.value;
  }

  beforeAll(async () => {
    projectId = randomUUID();
    await database.insert(schema.projects).values({
      id: projectId,
      name: "drive-test",
      repoPath: REPO_PATH,
      repoName: "drive-test",
      defaultBranch: "main",
      createdAt: now,
      updatedAt: now,
    });
  });

  afterAll(() => {
    rmSync(REPO_PATH, { recursive: true, force: true });
  });

  it("reports disabled by default", async () => {
    const res = await app.request(`/api/projects/${projectId}/drive`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.enabled).toBe(false);
  });

  it("rejects a PUT without a boolean enabled", async () => {
    const res = await app.request(`/api/projects/${projectId}/drive`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("enabling Drive sets every owned preference coherently", async () => {
    const res = await app.request(`/api/projects/${projectId}/drive`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;

    expect(body.enabled).toBe(true);
    expect(body.details.autodrive).toBe(true);
    expect(body.details.autoMergeDisabled).toBe(false);
    expect(body.details.autoReview).toBe(true);
    expect(body.details.autoMerge).toBe(true);

    // Persisted coherently.
    expect(await pref(`board_autodrive_${projectId}`)).toBe("true");
    expect(await pref(`auto_merge_disabled_${projectId}`)).toBe("false");
    expect(await pref("auto_review")).toBe("true");
    expect(await pref("auto_merge")).toBe("true");
    // planMode-off for every harness.
    expect(await pref("harness.claude.plan_auto_continue")).toBe("true");
    expect(await pref("harness.codex.plan_auto_continue")).toBe("true");
    expect(await pref("harness.copilot.plan_auto_continue")).toBe("true");
    // Stack profile + verify gate seeded.
    expect(await pref(`project_stack_profile_${projectId}`)).toBeTruthy();
    expect(body.details.hasStackProfile).toBe(true);
  });

  it("disabling Drive restores triage mode and re-arms the kill-switch", async () => {
    const res = await app.request(`/api/projects/${projectId}/drive`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;

    expect(body.enabled).toBe(false);
    expect(await pref(`board_autodrive_${projectId}`)).toBe("false");
    // Kill-switch re-armed so nothing merges hands-off in triage.
    expect(await pref(`auto_merge_disabled_${projectId}`)).toBe("true");
    // Non-destructive artifacts survive the flip-off.
    expect(await pref(`project_stack_profile_${projectId}`)).toBeTruthy();
  });

  it("does not clobber a user's existing verify-script override on enable", async () => {
    const custom = "echo custom-verify";
    await database
      .insert(schema.preferences)
      .values({ key: `verify_script_${projectId}`, value: custom })
      .onConflictDoUpdate({ target: schema.preferences.key, set: { value: custom } });

    await app.request(`/api/projects/${projectId}/drive`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });

    expect(await pref(`verify_script_${projectId}`)).toBe(custom);
  });
});
