// @gate:always-run when:packages/server/plugins/jira-sync/kanban-plugin.json,packages/server/src/services/plugin-lifecycle.service.ts
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as schema from "@agentic-kanban/shared/schema";
import { gitExecSync } from "@agentic-kanban/shared/lib/git-exec";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { createPluginService } from "../services/plugin.service.js";
import type { Database } from "../db/index.js";

/**
 * #1630: a promote ships new bundled-plugin code but the board cached the manifest at install
 * time; startup must re-read it. Enable on a settings-driven sync plugin must not demand the
 * profile. The jira-sync version is pinned to its manifest so a manifest edit forces a bump.
 */
const tempDirs: string[] = [];
function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

const SYNC = {
  provider: "demo",
  pull: { command: "node pull.mjs", cwd: "plugin" },
  config: [{ key: "siteUrl", label: "Site", required: true }],
};

function writeManifest(dir: string, extra: Record<string, unknown>) {
  writeFileSync(join(dir, "kanban-plugin.json"), JSON.stringify({ id: "demo-sync", name: "Demo Sync", version: "0.1.0", ...extra }, null, 2));
}

describe("bundled plugin manifest refresh + sync scaffold (#1630)", () => {
  let db: TestDb;
  let savedBundled: string | undefined;

  beforeEach(() => {
    db = createTestDb().db;
    savedBundled = process.env.AGENTIC_KANBAN_BUNDLED_PLUGINS_DIR;
  });
  afterEach(() => {
    if (savedBundled === undefined) delete process.env.AGENTIC_KANBAN_BUNDLED_PLUGINS_DIR;
    else process.env.AGENTIC_KANBAN_BUNDLED_PLUGINS_DIR = savedBundled;
    for (const dir of tempDirs.splice(0)) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });

  it("startup refreshes a bundled plugin whose manifest file changed, and leaves others alone", async () => {
    const bundledRoot = makeTempDir("ak-plugin-bundled-root-");
    process.env.AGENTIC_KANBAN_BUNDLED_PLUGINS_DIR = bundledRoot;
    const bundled = join(bundledRoot, "demo-sync");
    mkdirSync(bundled);
    writeManifest(bundled, { sync: SYNC });
    const outside = makeTempDir("ak-plugin-outside-");
    writeFileSync(join(outside, "kanban-plugin.json"), JSON.stringify({ id: "outside", name: "Outside", version: "1.0.0" }));

    const service = createPluginService({ database: db as unknown as Database });
    await service.installPlugin({ source: bundled });
    await service.installPlugin({ source: outside });

    expect(await service.refreshBundledPlugins()).toEqual([]);

    writeManifest(bundled, {
      version: "0.2.0",
      sync: { ...SYNC, config: [...SYNC.config, { key: "pullEveryMinutes", label: "Pull every" }] },
    });
    writeFileSync(join(outside, "kanban-plugin.json"), JSON.stringify({ id: "outside", name: "Outside", version: "2.0.0" }));

    expect(await service.refreshBundledPlugins()).toEqual(["demo-sync"]);
    const listed = await service.listPlugins();
    const demo = listed.find((p) => p.pluginId === "demo-sync")!;
    expect(demo.version).toBe("0.2.0");
    expect(demo.manifest?.sync?.config?.map((c) => c.key)).toContain("pullEveryMinutes");
    expect(listed.find((p) => p.pluginId === "outside")!.version).toBe("1.0.0");
    expect(await service.refreshBundledPlugins()).toEqual([]);
  });

  it("refreshes a row reaching the bundled dir through a symlink/junction and canonicalises localPath (#1637)", async () => {
    const bundledRoot = makeTempDir("ak-plugin-bundled-root-");
    process.env.AGENTIC_KANBAN_BUNDLED_PLUGINS_DIR = bundledRoot;
    const bundled = join(bundledRoot, "demo-sync");
    mkdirSync(bundled);
    writeManifest(bundled, { sync: SYNC });
    const linkParent = makeTempDir("ak-plugin-link-");
    const link = join(linkParent, "alias");
    symlinkSync(bundled, link, "junction");

    const service = createPluginService({ database: db as unknown as Database });
    await service.installPlugin({ source: link });
    writeManifest(bundled, { version: "0.2.0", sync: SYNC });

    expect(await service.refreshBundledPlugins()).toEqual(["demo-sync"]);
    const demo = (await service.listPlugins()).find((p) => p.pluginId === "demo-sync")!;
    expect(demo.version).toBe("0.2.0");
    expect(demo.localPath).toBe(realpathSync.native(bundled));
  });

  it("leaves a row outside the bundled dir alone and logs it once (#1637)", async () => {
    const bundledRoot = makeTempDir("ak-plugin-bundled-root-");
    process.env.AGENTIC_KANBAN_BUNDLED_PLUGINS_DIR = bundledRoot;
    const outside = makeTempDir("ak-plugin-outside-");
    writeFileSync(join(outside, "kanban-plugin.json"), JSON.stringify({ id: "outside", name: "Outside", version: "1.0.0" }));
    const service = createPluginService({ database: db as unknown as Database });
    await service.installPlugin({ source: outside });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await service.refreshBundledPlugins()).toEqual([]);
      const lines = warn.mock.calls.filter((c) => String(c[0]).includes("outside"));
      expect(lines).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("enable on a sync plugin with settings fields returns no placeholder warning", async () => {
    const dir = makeTempDir("ak-plugin-sync-enable-");
    writeManifest(dir, { sync: SYNC, scaffold: { profileTemplate: "profile-template.md", targetPath: "docs/demo/_profile.md" } });
    writeFileSync(join(dir, "profile-template.md"), "# Profile\n\nProject key: TODO: e.g. ENG\n");
    const parent = makeTempDir("ak-plugin-sync-parent-");
    const repo = join(parent, "product-repo");
    mkdirSync(repo);
    gitExecSync(["init"], { cwd: repo });
    const projectId = randomUUID();
    const now = new Date().toISOString();
    await db.insert(schema.projects).values({
      id: projectId, name: "P", repoPath: repo, repoName: "p", defaultBranch: "main", createdAt: now, updatedAt: now,
    });

    const service = createPluginService({ database: db as unknown as Database });
    const plugin = await service.installPlugin({ source: dir });
    const report = await service.enableForProject(plugin.id, projectId);
    expect(report.scaffoldWritten).toBe(true);
    expect(report.warnings.filter((w) => /placeholder/i.test(w))).toEqual([]);
  });

  it("jira-sync's version is pinned to its manifest: edit the manifest, bump the version", () => {
    const raw = readFileSync(join(import.meta.dirname, "../../plugins/jira-sync/kanban-plugin.json"), "utf8");
    const manifest = JSON.parse(raw) as { version: string };
    const { version, ...rest } = manifest;
    const digest = createHash("sha256").update(JSON.stringify(rest)).digest("hex").slice(0, 16);
    // When this fails: you changed the manifest. Bump `version` there, then add a NEW entry here
    // (keep the old ones out: a version must map to exactly one manifest shape).
    const PINNED: Record<string, string> = { "0.3.0": "681c97ae6d36c1a8", "0.4.0": "144d5c73d2c88d8a", "0.4.1": "9178890a457520d5" };
    expect(PINNED[version], `jira-sync manifest changed; version ${version} needs a new pin (digest ${digest})`).toBe(digest);
  });
});
