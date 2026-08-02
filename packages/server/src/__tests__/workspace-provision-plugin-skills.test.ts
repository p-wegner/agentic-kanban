import { describe, expect, it, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as schema from "@agentic-kanban/shared/schema";
import { gitExecSync } from "@agentic-kanban/shared/lib/git-exec";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { createPluginService } from "../services/plugin.service.js";
import { createWorkspaceProvisionService } from "../services/workspace-provision.service.js";
import type { Database } from "../db/index.js";
import type { GitService } from "../services/workspace-internals.js";

/**
 * Regression for #204: a manifest `loops` entry declares `skill: "<name>"`, but
 * that skill was never materialized into the WORKTREE of tickets the loop
 * creates — only `resolveSkillFile`'s single project-default skill was.
 * `enableForProject` fans a plugin's skills out into the project's LEADING repo
 * only (junctioned + git-excluded), so a fresh worktree checkout never sees
 * them. `materializeEnabledPluginSkills` closes that gap by copying every
 * skill of every plugin enabled for the project into the worktree.
 */

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeProjectRepo(): string {
  const repo = makeTempDir("provision-test-repo-");
  gitExecSync(["init"], { cwd: repo });
  return repo;
}

function makePluginDir(): string {
  const dir = makeTempDir("provision-test-plugin-");
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
  mkdirSync(join(skillDir, "tools"), { recursive: true });
  writeFileSync(join(skillDir, "tools", "ground.mjs"), "console.log('ground');");
  return dir;
}

async function insertProject(db: TestDb, repoPath: string): Promise<string> {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  await db.insert(schema.projects).values({
    id: projectId,
    name: "Provision Plugin Project",
    repoPath,
    repoName: "provision-plugin-project",
    defaultBranch: "main",
    createdAt: now,
    updatedAt: now,
  });
  return projectId;
}

describe("workspace-provision.service materializeEnabledPluginSkills", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* Windows file locks — temp cleanup is best-effort */
      }
    }
  });

  it("copies every skill of every plugin ENABLED for the project into the worktree", async () => {
    const { db } = createTestDb();
    const pluginDir = makePluginDir();
    const repo = makeProjectRepo();
    const pluginService = createPluginService({ database: db as unknown as Database });
    const plugin = await pluginService.installPlugin({ source: pluginDir });
    const projectId = await insertProject(db, repo);
    await pluginService.enableForProject(plugin.id, projectId);

    // A worktree is a SEPARATE checkout — it must not already carry the
    // leading repo's junctioned/gitignored plugin skill.
    const worktreePath = makeTempDir("provision-test-worktree-");
    expect(existsSync(join(worktreePath, ".claude", "skills", "requirement-extraction"))).toBe(false);

    const provision = createWorkspaceProvisionService({
      database: db as unknown as Database,
      gitService: {} as GitService,
    });
    await provision.materializeEnabledPluginSkills(worktreePath, repo, projectId);

    const materialized = join(worktreePath, ".claude", "skills", "requirement-extraction");
    expect(readFileSync(join(materialized, "SKILL.md"), "utf8")).toContain("requirement-extraction");
    // The full bundle, not just the prose — a skill's tools/ are useless without it.
    expect(readFileSync(join(materialized, "tools", "ground.mjs"), "utf8")).toContain("ground");
  });

  it("materializes nothing for a plugin that is installed but NOT enabled for the project", async () => {
    const { db } = createTestDb();
    const pluginDir = makePluginDir();
    const repo = makeProjectRepo();
    const pluginService = createPluginService({ database: db as unknown as Database });
    await pluginService.installPlugin({ source: pluginDir });
    const projectId = await insertProject(db, repo);
    // Deliberately not enabled.

    const worktreePath = makeTempDir("provision-test-worktree-");
    const provision = createWorkspaceProvisionService({
      database: db as unknown as Database,
      gitService: {} as GitService,
    });
    await provision.materializeEnabledPluginSkills(worktreePath, repo, projectId);

    expect(existsSync(join(worktreePath, ".claude", "skills", "requirement-extraction"))).toBe(false);
  });
});
