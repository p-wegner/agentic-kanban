import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as schema from "@agentic-kanban/shared/schema";
import { gitExecSync } from "@agentic-kanban/shared/lib/git-exec";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { createPluginService, stopAllPluginViewsAsync } from "../services/plugin.service.js";
import type { Database } from "../db/index.js";

/**
 * #442 — manifest drift must reach the board's plugin panel, not only the Settings
 * marketplace. The cached manifest row is what the board RUNS; the file on disk is what
 * the author EDITED, and they only reconcile on `POST /plugins/:id/update`. Drift has been
 * DETECTED since #295, but only ever rendered in `PluginMarketplacePanel` — and an operator
 * driving a converging loop lives in the plugin panel and never opens Settings.
 *
 * Measured instance: the pm-pipeline plugin ran a manifest whose skill list still named
 * `.claude/skills/pm-pipeline-operate`, a directory renamed to `pm-round` on disk, through
 * an entire six-step pipeline run with no indication anywhere the operator was looking.
 */

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

const MANIFEST = {
  id: "drift-probe",
  name: "Drift Probe",
  version: "0.1.0",
  skills: [{ dir: "skills/prober", description: "Probe things." }],
  scripts: [{ name: "noop", command: "node -e \"\"", cwd: "plugin" as const }],
};

function makePluginDir(): string {
  const dir = makeTempDir("drift-plugin-");
  writeFileSync(join(dir, "kanban-plugin.json"), JSON.stringify(MANIFEST, null, 2));
  const skillDir = join(dir, "skills", "prober");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), "# prober\nProbe.");
  return dir;
}

function makeProjectRepo(): string {
  const parent = makeTempDir("drift-parent-");
  const repo = join(parent, "product-repo");
  mkdirSync(repo, { recursive: true });
  gitExecSync(["init"], { cwd: repo });
  return repo;
}

async function insertProject(db: TestDb, repoPath: string): Promise<string> {
  const id = randomUUID();
  const now = new Date().toISOString();
  await db.insert(schema.projects).values({
    id,
    name: "drift-project",
    repoPath,
    repoName: "drift-project",
    defaultBranch: "main",
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

describe("plugin surface — manifest drift (#442)", () => {
  let db: TestDb;
  let service: ReturnType<typeof createPluginService>;

  beforeEach(() => {
    db = createTestDb().db;
    service = createPluginService({ database: db as unknown as Database });
  });

  afterEach(async () => {
    await stopAllPluginViewsAsync();
    for (const dir of tempDirs.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* Windows file locks — temp cleanup is best-effort */
      }
    }
  });

  it("reports no drift for a freshly installed plugin", async () => {
    const pluginDir = makePluginDir();
    const projectId = await insertProject(db, makeProjectRepo());
    const plugin = await service.installPlugin({ source: pluginDir });
    await service.enableForProject(plugin.id, projectId);

    const surface = await service.listProjectSurface(projectId);
    expect(surface.drifted).toEqual([]);
    // The plugin is genuinely on the surface — an empty `drifted` must not be
    // the vacuous consequence of an empty surface.
    expect(surface.skills.map((s) => s.name)).toContain("prober");
  });

  it("flags the enabled plugin once its on-disk manifest moves ahead of the cached row", async () => {
    const pluginDir = makePluginDir();
    const projectId = await insertProject(db, makeProjectRepo());
    const plugin = await service.installPlugin({ source: pluginDir });
    await service.enableForProject(plugin.id, projectId);

    // The author edits the manifest on disk. The board keeps running the cached row —
    // this is the state that ran silently for a whole pipeline.
    writeFileSync(
      join(pluginDir, "kanban-plugin.json"),
      JSON.stringify({ ...MANIFEST, skills: [{ dir: "skills/renamed" }] }, null, 2),
    );

    const surface = await service.listProjectSurface(projectId);
    expect(surface.drifted).toEqual([
      { pluginId: plugin.id, pluginSlug: "drift-probe", pluginName: "Drift Probe" },
    ]);
    // The surface still describes the OLD manifest — which is the point of warning.
    expect(surface.skills.map((s) => s.name)).toContain("prober");
  });

  it("clears the flag after update reconciles the row with disk", async () => {
    const pluginDir = makePluginDir();
    const projectId = await insertProject(db, makeProjectRepo());
    const plugin = await service.installPlugin({ source: pluginDir });
    await service.enableForProject(plugin.id, projectId);

    writeFileSync(
      join(pluginDir, "kanban-plugin.json"),
      JSON.stringify({ ...MANIFEST, version: "0.2.0" }, null, 2),
    );
    expect((await service.listProjectSurface(projectId)).drifted).toHaveLength(1);

    // Re-install is the same upsert `POST /plugins/:id/update` performs.
    await service.installPlugin({ source: pluginDir });
    expect((await service.listProjectSurface(projectId)).drifted).toEqual([]);
  });

  it("materializes a skill the update newly declares, into every enabled project (#443)", async () => {
    const pluginDir = makePluginDir();
    const repo = makeProjectRepo();
    const projectId = await insertProject(db, repo);
    const plugin = await service.installPlugin({ source: pluginDir });
    await service.enableForProject(plugin.id, projectId);
    expect(existsSync(join(repo, ".claude", "skills", "prober"))).toBe(true);

    // The author renames the skill dir — exactly what pm-pipeline did
    // (`pm-pipeline-operate` → `pm-round`).
    const renamedDir = join(pluginDir, "skills", "renamed");
    mkdirSync(renamedDir, { recursive: true });
    writeFileSync(join(renamedDir, "SKILL.md"), "# renamed\nStill here.");
    writeFileSync(
      join(pluginDir, "kanban-plugin.json"),
      JSON.stringify({ ...MANIFEST, skills: [{ dir: "skills/renamed" }] }, null, 2),
    );

    const result = await service.updatePlugin(plugin.id);

    // Without the fan-out the panel would offer `renamed` with no bundle behind it, and
    // copySkillToWorktree would return false silently at launch (#204's failure mode).
    expect(existsSync(join(repo, ".claude", "skills", "renamed", "SKILL.md"))).toBe(true);
    const refreshed = result.skillsRefreshed.find((r) => r.projectId === projectId);
    expect(refreshed?.skills).toEqual([{ name: "renamed", mode: expect.stringMatching(/^(junction|copy)$/) }]);
  });

  it("skill refresh on update is idempotent and skips projects where the plugin is disabled", async () => {
    const pluginDir = makePluginDir();
    const enabledRepo = makeProjectRepo();
    const enabledProject = await insertProject(db, enabledRepo);
    const otherRepo = makeProjectRepo();
    const otherProject = await insertProject(db, otherRepo);

    const plugin = await service.installPlugin({ source: pluginDir });
    await service.enableForProject(plugin.id, enabledProject);

    const result = await service.updatePlugin(plugin.id);
    expect(result.skillsRefreshed.map((r) => r.projectId)).toEqual([enabledProject]);
    // Already materialized by enable — re-running must not duplicate or re-copy it.
    expect(result.skillsRefreshed[0].skills).toEqual([{ name: "prober", mode: "skipped-existing" }]);
    // The disabled project is neither reported nor written into.
    expect(result.skillsRefreshed.some((r) => r.projectId === otherProject)).toBe(false);
    expect(existsSync(join(otherRepo, ".claude", "skills", "prober"))).toBe(false);
  });

  it("does not flag a plugin that is installed but not enabled for this project", async () => {
    const pluginDir = makePluginDir();
    const projectId = await insertProject(db, makeProjectRepo());
    await service.installPlugin({ source: pluginDir });
    writeFileSync(
      join(pluginDir, "kanban-plugin.json"),
      JSON.stringify({ ...MANIFEST, version: "0.3.0" }, null, 2),
    );

    // The panel only ever shows enabled plugins, so a drifted-but-disabled one would be
    // a warning about something this project cannot run.
    expect((await service.listProjectSurface(projectId)).drifted).toEqual([]);
  });
});
