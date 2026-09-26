import { describe, expect, it, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as schema from "@agentic-kanban/shared/schema";
import { gitExecSync } from "@agentic-kanban/shared/lib/git-exec";
import { pluginSkillListingPreferenceKey } from "@agentic-kanban/shared/lib/plugin-skill-listing";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { createPluginService } from "../services/plugin.service.js";
import { createWorkspaceProvisionService } from "../services/workspace-provision.service.js";
import { syncPluginSkillOverrides } from "../services/plugin-skill-overrides.service.js";
import { readModelHiddenSkills, SKILL_OVERRIDES_SETTINGS_FILE } from "../lib/model-hidden-skills.js";
import type { Database } from "../db/index.js";
import type { GitService } from "../services/workspace-internals.js";

/**
 * #1251 — an enabled plugin's skills are listed to the model the way the BOARD decides (default
 * `name-only`), written as Claude Code `skillOverrides` into `.claude/settings.local.json` next to
 * the materialized skills. The plugin's own SKILL.md files are never touched.
 */

const tempDirs: string[] = [];
const SLUG = "test-listing-plugin";

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeRepo(): string {
  const repo = makeTempDir("ak-listing-test-repo-");
  gitExecSync(["init"], { cwd: repo });
  return repo;
}

function makePluginDir(hint?: string): string {
  const dir = makeTempDir("ak-listing-test-plugin-");
  const skills = [
    { dir: "skills/miner", ...(hint ? { listing: hint } : {}) },
    { dir: "skills/navigator" },
  ];
  writeFileSync(join(dir, "kanban-plugin.json"), JSON.stringify({ id: SLUG, name: "Listing", skills }, null, 2));
  for (const name of ["miner", "navigator"]) {
    mkdirSync(join(dir, "skills", name), { recursive: true });
    writeFileSync(join(dir, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: A long description.\n---\n# ${name}\n`);
  }
  return dir;
}

async function insertProject(db: TestDb, repoPath: string): Promise<string> {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  await db.insert(schema.projects).values({
    id: projectId, name: "Listing Project", repoPath, repoName: "listing-project",
    defaultBranch: "main", createdAt: now, updatedAt: now,
  });
  return projectId;
}

async function setPref(db: TestDb, key: string, value: string): Promise<void> {
  await db.insert(schema.preferences).values({ key, value }).onConflictDoUpdate({
    target: schema.preferences.key, set: { value },
  });
}

function readSettings(dir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, SKILL_OVERRIDES_SETTINGS_FILE), "utf8"));
}

async function enabledSetup(hint?: string) {
  const { db } = createTestDb();
  const repo = makeRepo();
  const pluginService = createPluginService({ database: db as unknown as Database });
  const plugin = await pluginService.installPlugin({ source: makePluginDir(hint) });
  const projectId = await insertProject(db, repo);
  const report = await pluginService.enableForProject(plugin.id, projectId);
  return { db, repo, pluginService, plugin, projectId, report };
}

describe("plugin skill listings (#1251)", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* Windows file locks — temp cleanup is best-effort */
      }
    }
  });

  it("enabling writes name-only for every plugin skill and keeps the file out of git", async () => {
    const { repo, report } = await enabledSetup();
    expect(report.warnings).toEqual([]);
    expect(readSettings(repo).skillOverrides).toEqual({ miner: "name-only", navigator: "name-only" });
    const status = gitExecSync(["status", "--porcelain", "--untracked-files=all"], { cwd: repo });
    expect(status).not.toContain("settings.local.json");
    // The skill itself is untouched — the lever is the settings file, never the SKILL.md.
    expect(readFileSync(join(repo, ".claude", "skills", "miner", "SKILL.md"), "utf8")).not.toContain(
      "disable-model-invocation",
    );
  });

  it("manifest hint beats the board-wide default; the project override beats both", async () => {
    const { db, repo, projectId } = await enabledSetup("on");
    await setPref(db, "plugin_skill_listing_default", "off");
    await syncPluginSkillOverrides(db as unknown as Database, projectId, repo);
    expect(readSettings(repo).skillOverrides).toEqual({ miner: "on", navigator: "off" });

    await setPref(db, pluginSkillListingPreferenceKey(SLUG, projectId), JSON.stringify({ miner: "user-invocable-only" }));
    await syncPluginSkillOverrides(db as unknown as Database, projectId, repo);
    expect(readSettings(repo).skillOverrides).toEqual({ miner: "user-invocable-only", navigator: "off" });
  });

  it("an invalid override entry is reported, not applied, and not fatal", async () => {
    const { db, repo, projectId } = await enabledSetup();
    await setPref(db, pluginSkillListingPreferenceKey(SLUG, projectId), JSON.stringify({ miner: "loud" }));
    const result = await syncPluginSkillOverrides(db as unknown as Database, projectId, repo);
    expect(result.warnings.join(" ")).toContain("miner");
    expect(readSettings(repo).skillOverrides).toEqual({ miner: "name-only", navigator: "name-only" });
  });

  it("disabling removes only the board's keys; hand-written overrides and other settings survive", async () => {
    const { repo, pluginService, plugin, projectId } = await enabledSetup();
    const settings = readSettings(repo);
    writeFileSync(
      join(repo, SKILL_OVERRIDES_SETTINGS_FILE),
      JSON.stringify({ ...settings, permissions: { allow: ["Bash(ls)"] }, skillOverrides: { ...(settings.skillOverrides as object), mine: "off" } }),
    );
    await pluginService.disableForProject(plugin.id, projectId);
    expect(readSettings(repo)).toEqual({ permissions: { allow: ["Bash(ls)"] }, skillOverrides: { mine: "off" } });
  });

  it("a settings.local.json tracked by git is left untouched and reported", async () => {
    const { db } = createTestDb();
    const repo = makeRepo();
    mkdirSync(join(repo, ".claude"), { recursive: true });
    const original = JSON.stringify({ spinnerTipsEnabled: true }, null, 2);
    writeFileSync(join(repo, SKILL_OVERRIDES_SETTINGS_FILE), original);
    gitExecSync(["add", "-f", SKILL_OVERRIDES_SETTINGS_FILE], { cwd: repo });
    gitExecSync(["-c", "user.email=t@example.invalid", "-c", "user.name=t", "commit", "-qm", "track"], { cwd: repo });
    const pluginService = createPluginService({ database: db as unknown as Database });
    const plugin = await pluginService.installPlugin({ source: makePluginDir() });
    const projectId = await insertProject(db, repo);
    const report = await pluginService.enableForProject(plugin.id, projectId);
    expect(report.warnings.join(" ")).toContain("tracked by git");
    expect(readFileSync(join(repo, SKILL_OVERRIDES_SETTINGS_FILE), "utf8")).toBe(original);
  });

  it("provisioning writes the listings into the worktree, and Pi reads which skills to omit", async () => {
    const { db, repo, projectId } = await enabledSetup();
    await setPref(db, pluginSkillListingPreferenceKey(SLUG, projectId), JSON.stringify({ navigator: "off" }));
    const worktreePath = makeTempDir("ak-listing-test-worktree-");
    const provision = createWorkspaceProvisionService({
      database: db as unknown as Database,
      gitService: {} as GitService,
    });
    await provision.materializeEnabledPluginSkills(worktreePath, repo, projectId);
    expect(readSettings(worktreePath).skillOverrides).toEqual({ miner: "name-only", navigator: "off" });
    expect([...readModelHiddenSkills(worktreePath)]).toEqual(["navigator"]);
  });
});
