import { describe, expect, it, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as schema from "@agentic-kanban/shared/schema";
import { gitExecSync } from "@agentic-kanban/shared/lib/git-exec";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { createPluginService } from "../services/plugin.service.js";
import { provisionTrainGateSelector } from "../services/merge-train-gate-selector.js";
import { IMPACT_TOOL_RELATIVE_PATH } from "../services/test-impact-outcome.service.js";
import { IMPACT_MAP_PATH } from "../services/test-impact-map.service.js";
import type { Database } from "../db/index.js";

/**
 * A merge train's staging worktree (full train, bisect half, control arm — all made by
 * `runTrainStagingGate`) got neither the enabled plugin skills nor the gitignored impact map, so
 * every impact-tier train gate spawned a selector that was not there, fell back to `vitest related`
 * and ran ~950 files. Measured on the stable board 2026-09-27: 43 skills in the train worktree,
 * no `test-impact`. These run the train's own provisioning step against a REAL detached worktree
 * of a temp repo — the shape `createWorktree(repo, ref, undefined, { pathNamespace: "train" })`
 * produces — and check the selector resolves there.
 */

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function git(cwd: string, args: string[]): void {
  gitExecSync(args, { cwd });
}

/** A repo with one commit, the gitignored impact map in its main checkout, and a detached train worktree. */
function makeRepoWithTrainWorktree(): { repo: string; trainWorktree: string } {
  const repo = makeTempDir("ak-train-selector-repo-");
  git(repo, ["init"]);
  git(repo, ["config", "user.email", "t@example.com"]);
  git(repo, ["config", "user.name", "t"]);
  writeFileSync(join(repo, ".gitignore"), "docs/tests/impact-map.json\n.claude/skills/\n");
  writeFileSync(join(repo, "README.md"), "x\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "init"]);
  mkdirSync(join(repo, "docs", "tests"), { recursive: true });
  writeFileSync(join(repo, ...IMPACT_MAP_PATH.split("/")), JSON.stringify({ version: 1, edges: {} }));
  const trainWorktree = join(makeTempDir("ak-train-selector-wt-"), "train-2026-09-27-06");
  git(repo, ["worktree", "add", "--detach", trainWorktree, "HEAD"]);
  return { repo, trainWorktree };
}

function makeTestImpactPlugin(): string {
  const dir = makeTempDir("ak-train-selector-plugin-");
  const manifest = { id: "test-impact", name: "Test Impact", version: "0.1.0", skills: [{ dir: "skills/test-impact" }] };
  writeFileSync(join(dir, "kanban-plugin.json"), JSON.stringify(manifest, null, 2));
  const skillDir = join(dir, "skills", "test-impact");
  mkdirSync(join(skillDir, "tools"), { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), "# test-impact\nSelect tests.");
  writeFileSync(join(skillDir, "tools", "impact.mjs"), "console.log('select');");
  return dir;
}

async function insertProject(db: TestDb, repoPath: string): Promise<string> {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  await db.insert(schema.projects).values({
    id: projectId, name: "Train Selector Project", repoPath, repoName: "train-selector-project",
    defaultBranch: "master", createdAt: now, updatedAt: now,
  });
  return projectId;
}

async function setup() {
  const { db } = createTestDb();
  const pluginDir = makeTestImpactPlugin();
  const { repo, trainWorktree } = makeRepoWithTrainWorktree();
  const pluginService = createPluginService({ database: db as unknown as Database });
  const plugin = await pluginService.installPlugin({ source: pluginDir });
  const projectId = await insertProject(db, repo);
  await pluginService.enableForProject(plugin.id, projectId);
  return { db, pluginDir, repo, trainWorktree, projectId };
}

describe("provisionTrainGateSelector — a train staging worktree gets the selector by the builder's road", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* Windows file locks — temp cleanup is best-effort */
      }
    }
  });

  it("puts the enabled test-impact skill AND the impact map into the train worktree", async () => {
    const { db, repo, trainWorktree, projectId } = await setup();
    // The state measured on the live board: a fresh train worktree has neither.
    expect(existsSync(join(trainWorktree, IMPACT_TOOL_RELATIVE_PATH))).toBe(false);
    expect(existsSync(join(trainWorktree, ...IMPACT_MAP_PATH.split("/")))).toBe(false);

    const logs: string[] = [];
    const result = await provisionTrainGateSelector({
      database: db as unknown as Database, repoPath: repo, projectId, worktreePath: trainWorktree,
      attemptLabel: "train/2026-09-27-06", log: (m) => logs.push(m),
    });

    expect(result.selectorPresent).toBe(true);
    expect(result.materialization?.materialized).toContain("test-impact");
    expect(readFileSync(join(trainWorktree, IMPACT_TOOL_RELATIVE_PATH), "utf8")).toContain("select");
    expect(existsSync(join(trainWorktree, ...IMPACT_MAP_PATH.split("/")))).toBe(true);
    expect(logs.join("\n")).not.toContain("selector ABSENT");
  });

  it("says `selector ABSENT` loudly when the enabled skill cannot be materialized, instead of widening silently", async () => {
    const { db, pluginDir, repo, trainWorktree, projectId } = await setup();
    // Gone from the main checkout AND the plugin checkout: nothing to heal from.
    rmSync(join(repo, ".claude", "skills", "test-impact"), { recursive: true, force: true });
    rmSync(join(pluginDir, "skills", "test-impact"), { recursive: true, force: true });

    const logs: string[] = [];
    const result = await provisionTrainGateSelector({
      database: db as unknown as Database, repoPath: repo, projectId, worktreePath: trainWorktree,
      attemptLabel: "train/2026-09-27-06a", log: (m) => logs.push(m),
    });

    expect(result.selectorPresent).toBe(false);
    expect(logs.join("\n")).toContain("train/2026-09-27-06a: selector ABSENT");
    expect(logs.join("\n")).toContain(IMPACT_TOOL_RELATIVE_PATH);
  });
});
