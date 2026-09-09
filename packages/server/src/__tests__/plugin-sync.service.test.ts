import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as schema from "@agentic-kanban/shared/schema";
import { gitExecSync } from "@agentic-kanban/shared/lib/git-exec";
import { pluginSyncConfigPreferenceKey, pluginSyncStatusPreferenceKey } from "@agentic-kanban/shared/lib/plugin-manifest";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { createPluginService, PluginError, stopAllPluginViewsAsync } from "../services/plugin.service.js";
import type { Database } from "../db/index.js";

/**
 * Board-side surfaces over the #1076 manifest `sync` capability (#1081): config round-trip,
 * validate's fail-closed verdicts, and trigger's dry-run/real pull — plus the status record the
 * sync-status plugin view reads. Integration style, like `plugin-service.test.ts`: a real temp
 * plugin dir with an actual `node <file>.mjs` pull/push command, run through the real service.
 */

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeProjectRepo(): string {
  const parent = makeTempDir("ak-plugin-sync-test-parent-");
  const repo = join(parent, "product-repo");
  mkdirSync(repo, { recursive: true });
  gitExecSync(["init"], { cwd: repo });
  return repo;
}

const SYNC_MANIFEST = {
  id: "jira-sync-test",
  name: "Jira Sync Test",
  version: "0.1.0",
  sync: {
    provider: "jira",
    pull: { command: "node sync-pull.mjs" },
    // No "push" declared — used to assert the "does not declare push" refusal.
    config: [
      { key: "siteUrl", label: "Site URL", required: true },
      { key: "projectKey", label: "Project key", required: true },
      { key: "jql", label: "JQL filter" },
    ],
    secrets: ["JIRA_API_TOKEN_TEST_1081"],
  },
};

const SYNC_MANIFEST_FAILING_PUSH = {
  ...SYNC_MANIFEST,
  id: "jira-sync-test-failing",
  sync: { ...SYNC_MANIFEST.sync, push: { command: "node sync-fail.mjs" } },
};

function makeSyncPluginDir(manifest: Record<string, unknown> = SYNC_MANIFEST): string {
  const dir = makeTempDir("ak-plugin-sync-test-plugin-");
  writeFileSync(join(dir, "kanban-plugin.json"), JSON.stringify(manifest, null, 2));
  // Prints a run summary the service should parse: counts + one linked issue + no conflicts.
  writeFileSync(
    join(dir, "sync-pull.mjs"),
    [
      "console.log(JSON.stringify({",
      "  counts: { created: 2, updated: 1, skipped: 0, failed: 0 },",
      "  issues: [{ externalKey: 'JIRA-1', externalUrl: process.env.SYNC_CONFIG_SITEURL + '/browse/JIRA-1', status: 'Done' }],",
      "  conflicts: [],",
      "}));",
    ].join("\n"),
  );
  writeFileSync(join(dir, "sync-fail.mjs"), "process.exit(1);");
  return dir;
}

async function insertProject(db: TestDb, repoPath: string): Promise<string> {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  await db.insert(schema.projects).values({
    id: projectId, name: "Sync Project", repoPath, repoName: "sync-project",
    defaultBranch: "main", createdAt: now, updatedAt: now,
  });
  return projectId;
}

const SECRET_NAME = "JIRA_API_TOKEN_TEST_1081";

describe("plugin sync (#1076/#1081)", () => {
  let db: TestDb;
  let service: ReturnType<typeof createPluginService>;

  beforeEach(() => {
    db = createTestDb().db;
    service = createPluginService({ database: db as unknown as Database });
    delete process.env[SECRET_NAME];
  });

  afterEach(async () => {
    delete process.env[SECRET_NAME];
    await stopAllPluginViewsAsync();
    for (const dir of tempDirs.splice(0)) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows file locks */ }
    }
  });

  it("getSyncConfig reflects the manifest's declared fields and secret PRESENCE, never a value", async () => {
    const plugin = await service.installPlugin({ source: makeSyncPluginDir() });
    const projectId = await insertProject(db, makeProjectRepo());

    const empty = await service.getSyncConfig(plugin.id, projectId);
    expect(empty.provider).toBe("jira");
    expect(empty.direction).toEqual({ pull: true, push: false });
    expect(empty.fields).toEqual([
      { key: "siteUrl", label: "Site URL", description: undefined, required: true, value: "" },
      { key: "projectKey", label: "Project key", description: undefined, required: true, value: "" },
      { key: "jql", label: "JQL filter", description: undefined, required: false, value: "" },
    ]);
    expect(empty.secrets).toEqual([{ name: SECRET_NAME, present: false }]);

    process.env[SECRET_NAME] = "super-secret-value";
    const withSecret = await service.getSyncConfig(plugin.id, projectId);
    expect(withSecret.secrets).toEqual([{ name: SECRET_NAME, present: true }]);
    expect(JSON.stringify(withSecret)).not.toContain("super-secret-value");
  });

  it("setSyncConfig round-trips values through the checked preference write, keyed by plugin+project", async () => {
    const plugin = await service.installPlugin({ source: makeSyncPluginDir() });
    const projectId = await insertProject(db, makeProjectRepo());

    const updated = await service.setSyncConfig(plugin.id, projectId, {
      siteUrl: "https://example.atlassian.net",
      projectKey: "KAN",
    });
    expect(updated.fields.find((f) => f.key === "siteUrl")?.value).toBe("https://example.atlassian.net");
    expect(updated.fields.find((f) => f.key === "projectKey")?.value).toBe("KAN");
    expect(updated.fields.find((f) => f.key === "jql")?.value).toBe("");

    // Persisted under the documented pref key, as a plain JSON string map (no secrets in it).
    const raw = (await db.select().from(schema.preferences)).find(
      (r) => r.key === pluginSyncConfigPreferenceKey("jira-sync-test", projectId),
    );
    expect(raw && JSON.parse(raw.value)).toEqual({ siteUrl: "https://example.atlassian.net", projectKey: "KAN" });

    // A follow-up call touching only ONE field MERGES onto the existing config rather than
    // wiping it — the CLI's `config-set <plugin> <key> <value>` sets one field per call.
    const merged = await service.setSyncConfig(plugin.id, projectId, { siteUrl: "https://other.atlassian.net" });
    expect(merged.fields.find((f) => f.key === "siteUrl")?.value).toBe("https://other.atlassian.net");
    expect(merged.fields.find((f) => f.key === "projectKey")?.value).toBe("KAN");
  });

  it("setSyncConfig rejects an undeclared key and a non-string value", async () => {
    const plugin = await service.installPlugin({ source: makeSyncPluginDir() });
    const projectId = await insertProject(db, makeProjectRepo());

    await expect(service.setSyncConfig(plugin.id, projectId, { notDeclared: "x" }))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(service.setSyncConfig(plugin.id, projectId, { siteUrl: 7 as unknown as string }))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("getSyncConfig/setSyncConfig/validateSync throw when the plugin declares no sync capability", async () => {
    const noSyncManifest = { id: "no-sync-plugin", name: "No Sync", version: "0.1.0" };
    const dir = makeTempDir("ak-plugin-sync-test-nosync-");
    writeFileSync(join(dir, "kanban-plugin.json"), JSON.stringify(noSyncManifest));
    const plugin = await service.installPlugin({ source: dir });
    const projectId = await insertProject(db, makeProjectRepo());

    await expect(service.getSyncConfig(plugin.id, projectId)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(service.validateSync(plugin.id, projectId)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(service.triggerSync(plugin.id, projectId, { direction: "pull" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  describe("validateSync — fails closed with a readable, by-name reason", () => {
    it("reports missing required config AND missing secrets when nothing is set", async () => {
      const plugin = await service.installPlugin({ source: makeSyncPluginDir() });
      const projectId = await insertProject(db, makeProjectRepo());

      const result = await service.validateSync(plugin.id, projectId);
      expect(result.ok).toBe(false);
      expect(result.provider).toBe("jira");
      expect(result.missingConfig.sort()).toEqual(["projectKey", "siteUrl"]);
      expect(result.missingSecrets).toEqual([SECRET_NAME]);
      expect(result.error).toContain("siteUrl");
      expect(result.error).toContain(SECRET_NAME);
      // Never the secret's value — there is none set, but the message must name only the KEY.
      expect(result.error).not.toMatch(/=|value/i);
    });

    it("is ok once every required field and every declared secret resolve", async () => {
      const plugin = await service.installPlugin({ source: makeSyncPluginDir() });
      const projectId = await insertProject(db, makeProjectRepo());
      await service.setSyncConfig(plugin.id, projectId, { siteUrl: "https://example.atlassian.net", projectKey: "KAN" });
      process.env[SECRET_NAME] = "super-secret-value";

      const result = await service.validateSync(plugin.id, projectId);
      expect(result).toMatchObject({ ok: true, provider: "jira", missingConfig: [], missingSecrets: [] });
      expect(result.error).toBeUndefined();
    });

    it("an OPTIONAL config field (jql) never blocks validation", async () => {
      const plugin = await service.installPlugin({ source: makeSyncPluginDir() });
      const projectId = await insertProject(db, makeProjectRepo());
      await service.setSyncConfig(plugin.id, projectId, { siteUrl: "https://example.atlassian.net", projectKey: "KAN" });
      process.env[SECRET_NAME] = "super-secret-value";

      const result = await service.validateSync(plugin.id, projectId);
      expect(result.ok).toBe(true);
    });
  });

  describe("triggerSync — fail-closed refusal, real run, and the status record", () => {
    it("refuses to run pull/push when unconfigured, recording the refusal as the last run", async () => {
      const plugin = await service.installPlugin({ source: makeSyncPluginDir() });
      const projectId = await insertProject(db, makeProjectRepo());

      const record = await service.triggerSync(plugin.id, projectId, { direction: "pull" });
      expect(record.ok).toBe(false);
      expect(record.code).toBeUndefined(); // the command never ran
      expect(record.error).toMatch(/missing required config/);

      const status = await service.getSyncStatus(plugin.id, projectId);
      expect(status.configured).toBe(false);
      expect(status.lastRun).toMatchObject({ ok: false, direction: "pull" });
    });

    it("refuses a direction the manifest does not declare a command for", async () => {
      const plugin = await service.installPlugin({ source: makeSyncPluginDir() });
      const projectId = await insertProject(db, makeProjectRepo());
      await expect(service.triggerSync(plugin.id, projectId, { direction: "push" }))
        .rejects.toMatchObject({ code: "BAD_REQUEST" });
    });

    it("runs pull, parses the command's own summary, and records it — never leaking the secret", async () => {
      const plugin = await service.installPlugin({ source: makeSyncPluginDir() });
      const projectId = await insertProject(db, makeProjectRepo());
      await service.setSyncConfig(plugin.id, projectId, { siteUrl: "https://example.atlassian.net", projectKey: "KAN" });
      process.env[SECRET_NAME] = "super-secret-value";

      const record = await service.triggerSync(plugin.id, projectId, { direction: "pull" });
      expect(record.ok).toBe(true);
      expect(record.code).toBe(0);
      expect(record.summary?.counts).toEqual({ created: 2, updated: 1, skipped: 0, failed: 0 });
      expect(record.summary?.issues).toEqual([
        { externalKey: "JIRA-1", externalUrl: "https://example.atlassian.net/browse/JIRA-1", localIssueNumber: undefined, status: "Done" },
      ]);
      expect(record.summary?.conflicts).toEqual([]);
      expect(JSON.stringify(record)).not.toContain("super-secret-value");

      const status = await service.getSyncStatus(plugin.id, projectId);
      expect(status.configured).toBe(true);
      expect(status.lastRun).toMatchObject({ ok: true, direction: "pull" });
      expect(status.lastRun?.summary?.issues?.[0].externalKey).toBe("JIRA-1");
    });

    it("records a non-zero exit as a failed run with the exit code, not a thrown error", async () => {
      const plugin = await service.installPlugin({ source: makeSyncPluginDir(SYNC_MANIFEST_FAILING_PUSH) });
      const projectId = await insertProject(db, makeProjectRepo());
      await service.setSyncConfig(plugin.id, projectId, { siteUrl: "https://example.atlassian.net", projectKey: "KAN" });
      process.env[SECRET_NAME] = "super-secret-value";

      const record = await service.triggerSync(plugin.id, projectId, { direction: "push", dryRun: true });
      expect(record.ok).toBe(false);
      expect(record.code).toBe(1);
      expect(record.dryRun).toBe(true);
      expect(record.error).toMatch(/exited with code 1/);
    });

    it("persists the status record under the documented pref key", async () => {
      const plugin = await service.installPlugin({ source: makeSyncPluginDir() });
      const projectId = await insertProject(db, makeProjectRepo());
      await service.triggerSync(plugin.id, projectId, { direction: "pull" }); // refused, still recorded

      const raw = (await db.select().from(schema.preferences)).find(
        (r) => r.key === pluginSyncStatusPreferenceKey("jira-sync-test", projectId),
      );
      expect(raw).toBeTruthy();
      expect(JSON.parse(raw!.value)).toMatchObject({ ok: false, direction: "pull" });
    });
  });

  describe("getSyncStatus — empty and error states for the sync-status plugin view", () => {
    it("is empty (no run yet, not configured) right after install/enable", async () => {
      const plugin = await service.installPlugin({ source: makeSyncPluginDir() });
      const projectId = await insertProject(db, makeProjectRepo());

      const status = await service.getSyncStatus(plugin.id, projectId);
      expect(status).toEqual({ provider: "jira", configured: false, lastRun: null });
    });

    it("throws for a plugin id that does not exist (view's error state)", async () => {
      const projectId = await insertProject(db, makeProjectRepo());
      await expect(service.getSyncStatus(randomUUID(), projectId)).rejects.toBeInstanceOf(PluginError);
    });

    it("throws for a project id that does not exist", async () => {
      const plugin = await service.installPlugin({ source: makeSyncPluginDir() });
      await expect(service.getSyncStatus(plugin.id, randomUUID())).rejects.toBeInstanceOf(PluginError);
    });
  });
});
