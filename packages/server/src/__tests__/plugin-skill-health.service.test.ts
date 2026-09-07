import { describe, expect, it, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as schema from "@agentic-kanban/shared/schema";
import { gitExecSync } from "@agentic-kanban/shared/lib/git-exec";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { createPluginService } from "../services/plugin.service.js";
import { checkPluginSkillHealth } from "../services/plugin-skill-health.service.js";
import type { Database } from "../db/index.js";

/**
 * #1053 — #1039 fixed the healing INSIDE workspace provisioning, but that only runs when a
 * workspace is created. The live board went a full day with the main checkout's junction gone
 * and NOTHING noticing, because nothing re-ran the check outside that path. This is the
 * independent, provisioning-free check: it must heal and report the exact #1039 shape without
 * needing a worktree in flight.
 */

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeProjectRepo(): string {
  const repo = makeTempDir("ak-skill-health-repo-");
  gitExecSync(["init"], { cwd: repo });
  return repo;
}

function makePluginDir(): string {
  const dir = makeTempDir("ak-skill-health-plugin-");
  const manifest = {
    id: "test-safety-net",
    name: "Test Safety Net",
    version: "0.1.0",
    skills: [{ dir: "skills/requirement-extraction" }],
  };
  writeFileSync(join(dir, "kanban-plugin.json"), JSON.stringify(manifest, null, 2));
  const skillDir = join(dir, "skills", "requirement-extraction");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), "# requirement-extraction\nExtract requirements.");
  return dir;
}

async function insertProject(testDb: TestDb, repoPath: string): Promise<string> {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  await testDb.insert(schema.projects).values({
    id: projectId,
    name: "Skill Health Project",
    repoPath,
    repoName: "skill-health-project",
    defaultBranch: "main",
    createdAt: now,
    updatedAt: now,
  });
  return projectId;
}

describe("plugin-skill-health.service checkPluginSkillHealth", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* Windows file locks — temp cleanup is best-effort */
      }
    }
  });

  it("reports nothing when an enabled plugin's skill already resolves in the main checkout", async () => {
    const { db } = createTestDb();
    const pluginDir = makePluginDir();
    const repo = makeProjectRepo();
    const pluginService = createPluginService({ database: db as unknown as Database });
    const plugin = await pluginService.installPlugin({ source: pluginDir });
    const projectId = await insertProject(db, repo);
    await pluginService.enableForProject(plugin.id, projectId);

    const result = await checkPluginSkillHealth(projectId, repo, db as unknown as Database);

    expect(result.healed).toEqual([]);
    expect(result.missing).toEqual([]);
  });

  it("HEALS and REPORTS a skill the main checkout has lost, without any worktree in flight (#1053)", async () => {
    const { db } = createTestDb();
    const pluginDir = makePluginDir();
    const repo = makeProjectRepo();
    const pluginService = createPluginService({ database: db as unknown as Database });
    const plugin = await pluginService.installPlugin({ source: pluginDir });
    const projectId = await insertProject(db, repo);
    await pluginService.enableForProject(plugin.id, projectId);

    // The live #1053 shape: pref says enabled, but the junction is gone from the main checkout —
    // no workspace creation involved, so #1039's provisioning-time heal never runs.
    const mainSkill = join(repo, ".claude", "skills", "requirement-extraction");
    expect(existsSync(mainSkill)).toBe(true);
    rmSync(mainSkill, { recursive: true, force: true });
    expect(existsSync(mainSkill)).toBe(false);

    const result = await checkPluginSkillHealth(projectId, repo, db as unknown as Database);

    expect(result.missing).toEqual([]);
    expect(result.healed).toHaveLength(1);
    expect(result.healed[0]).toMatchObject({ pluginSlug: "test-safety-net", skillName: "requirement-extraction" });
    // Healed means healed — the main checkout has it again.
    expect(existsSync(join(mainSkill, "SKILL.md"))).toBe(true);

    // A repeat check now sees it already resolving — the ONE-time heal is not reported forever.
    const again = await checkPluginSkillHealth(projectId, repo, db as unknown as Database);
    expect(again.healed).toEqual([]);
    expect(again.missing).toEqual([]);
  });

  it("REPORTS an unfixable skill (gone from the plugin checkout too) as missing, never silently", async () => {
    const { db } = createTestDb();
    const pluginDir = makePluginDir();
    const repo = makeProjectRepo();
    const pluginService = createPluginService({ database: db as unknown as Database });
    const plugin = await pluginService.installPlugin({ source: pluginDir });
    const projectId = await insertProject(db, repo);
    await pluginService.enableForProject(plugin.id, projectId);

    rmSync(join(repo, ".claude", "skills", "requirement-extraction"), { recursive: true, force: true });
    rmSync(join(pluginDir, "skills", "requirement-extraction"), { recursive: true, force: true });

    const result = await checkPluginSkillHealth(projectId, repo, db as unknown as Database);

    expect(result.healed).toEqual([]);
    expect(result.missing).toHaveLength(1);
    expect(result.missing[0]).toMatchObject({ pluginSlug: "test-safety-net", skillName: "requirement-extraction" });
  });

  it("reports nothing for a project with no enabled plugins", async () => {
    const { db } = createTestDb();
    const repo = makeProjectRepo();
    const projectId = await insertProject(db, repo);

    const result = await checkPluginSkillHealth(projectId, repo, db as unknown as Database);

    expect(result.healed).toEqual([]);
    expect(result.missing).toEqual([]);
  });
});
