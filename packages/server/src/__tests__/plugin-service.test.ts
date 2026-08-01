import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import * as schema from "@agentic-kanban/shared/schema";
import { gitExecSync } from "@agentic-kanban/shared/lib/git-exec";
import { pluginEnabledPreferenceKey } from "@agentic-kanban/shared/lib/plugin-manifest";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { createPluginService, PluginError, stopAllPluginViews } from "../services/plugin.service.js";
import type { Database } from "../db/index.js";

/**
 * Plugin service integration tests against real temp dirs: a temp git repo as
 * the project repo, a temp plugin dir with manifest + skill dir + fragment +
 * scaffold template. Asserts the enable fan-out (junction/copy, scaffold,
 * pref) and the disable cleanup safety (real dirs are NEVER deleted).
 */

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeProjectRepo(): string {
  const repo = makeTempDir("plugin-test-repo-");
  gitExecSync(["init"], { cwd: repo });
  return repo;
}

const MANIFEST = {
  id: "test-safety-net",
  name: "Test Safety Net",
  version: "0.1.0",
  skills: [{ dir: "skills/requirement-extraction" }],
  views: [
    {
      id: "coverage",
      label: "Coverage",
      kind: "iframe",
      serve: { command: "node serve.mjs", portEnv: "PORT", env: { COVERAGE_ROOT: "{{repoPath}}" } },
    },
  ],
  scripts: [
    { name: "print-env", command: "node print-env.mjs", cwd: "plugin", env: { COVERAGE_ROOT: "{{repoPath}}", PLUGIN_HOME: "{{pluginPath}}" } },
  ],
  butler: { promptFragment: "butler-fragment.md" },
  scaffold: { profileTemplate: "profile-template.md", targetPath: "docs/analysis/_project-profile.md" },
};

function makePluginDir(manifest: Record<string, unknown> = MANIFEST): string {
  const dir = makeTempDir("plugin-test-plugin-");
  writeFileSync(join(dir, "kanban-plugin.json"), JSON.stringify(manifest, null, 2));
  const skillDir = join(dir, "skills", "requirement-extraction");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), "# requirement-extraction\nExtract requirements.");
  writeFileSync(join(dir, "butler-fragment.md"), "Coverage docs live in {{repoPath}}/docs/analysis.");
  writeFileSync(join(dir, "profile-template.md"), "# Profile for {{projectName}}\nRepo: {{repoPath}}\nPlugin: {{pluginPath}}");
  writeFileSync(join(dir, "print-env.mjs"), "console.log(process.env.COVERAGE_ROOT + '|' + process.env.PLUGIN_HOME);");
  return dir;
}

async function insertProject(db: TestDb, repoPath: string, name = "Plugin Project"): Promise<string> {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  await db.insert(schema.projects).values({
    id: projectId,
    name,
    repoPath,
    repoName: "plugin-project",
    defaultBranch: "main",
    createdAt: now,
    updatedAt: now,
  });
  return projectId;
}

async function getPref(db: TestDb, key: string): Promise<string | null> {
  const rows = await db.select().from(schema.preferences).where(eq(schema.preferences.key, key));
  return rows[0]?.value ?? null;
}

describe("plugin.service", () => {
  let db: TestDb;
  let service: ReturnType<typeof createPluginService>;

  beforeEach(() => {
    db = createTestDb().db;
    service = createPluginService({ database: db as unknown as Database });
  });

  afterEach(() => {
    stopAllPluginViews();
    for (const dir of tempDirs.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* Windows file locks — temp cleanup is best-effort */
      }
    }
  });

  it("installs a local directory plugin in place and lists it with its manifest", async () => {
    const pluginDir = makePluginDir();
    const row = await service.installPlugin({ source: pluginDir });
    expect(row.pluginId).toBe("test-safety-net");
    expect(row.localPath).toBe(pluginDir);
    expect(row.sourceUrl).toBeNull();
    expect(row.version).toBe("0.1.0");

    const listed = await service.listPlugins();
    expect(listed).toHaveLength(1);
    expect(listed[0].manifest?.views?.[0].id).toBe("coverage");
  });

  it("install is an idempotent upsert keyed on the manifest slug", async () => {
    const pluginDir = makePluginDir();
    const first = await service.installPlugin({ source: pluginDir });
    const second = await service.installPlugin({ source: pluginDir });
    expect(second.pluginId).toBe(first.pluginId);
    expect(await service.listPlugins()).toHaveLength(1);
  });

  it("rejects a source that is neither a directory nor a git URL, and a dir without a manifest", async () => {
    await expect(service.installPlugin({ source: "not-a-real-thing" })).rejects.toThrow(PluginError);
    const empty = makeTempDir("plugin-test-empty-");
    await expect(service.installPlugin({ source: empty })).rejects.toThrow(/No kanban-plugin.json/);
  });

  it("enableForProject fans out pref + skill link + scaffold + git exclude", async () => {
    const pluginDir = makePluginDir();
    const repo = makeProjectRepo();
    const plugin = await service.installPlugin({ source: pluginDir });
    const projectId = await insertProject(db, repo);

    const report = await service.enableForProject(plugin.id, projectId);

    // Preference set via the checked write.
    const prefKey = pluginEnabledPreferenceKey("test-safety-net", projectId);
    expect(report.prefKey).toBe(prefKey);
    expect(await getPref(db, prefKey)).toBe("true");

    // Skill materialized (junction preferred, copy fallback) and readable.
    expect(report.skills).toEqual([{ name: "requirement-extraction", mode: expect.stringMatching(/^(junction|copy)$/) }]);
    const skillTarget = join(repo, ".claude", "skills", "requirement-extraction");
    expect(readFileSync(join(skillTarget, "SKILL.md"), "utf8")).toContain("requirement-extraction");

    // Ignored via .git/info/exclude, not a tracked .gitignore edit.
    const exclude = readFileSync(join(repo, ".git", "info", "exclude"), "utf8");
    expect(exclude).toContain(".claude/skills/requirement-extraction");

    // Scaffold written with substituted placeholders.
    expect(report.scaffoldWritten).toBe(true);
    const profile = readFileSync(join(repo, "docs", "analysis", "_project-profile.md"), "utf8");
    expect(profile).toContain("# Profile for Plugin Project");
    expect(profile).toContain(`Repo: ${repo}`);
    expect(profile).toContain(`Plugin: ${pluginDir}`);

    // Enabled flag shows up in the project-scoped listing.
    const listed = await service.listPlugins(projectId);
    expect(listed[0]).toMatchObject({ enabled: true });

    // Second enable is idempotent: skill already there → skipped, scaffold not rewritten.
    const again = await service.enableForProject(plugin.id, projectId);
    expect(again.skills).toEqual([{ name: "requirement-extraction", mode: "skipped-existing" }]);
    expect(again.scaffoldWritten).toBe(false);
  });

  it("disableForProject unsets the pref and removes ONLY link paths — a real dir survives", async () => {
    const pluginDir = makePluginDir();
    const repo = makeProjectRepo();
    const plugin = await service.installPlugin({ source: pluginDir });
    const projectId = await insertProject(db, repo);

    // Pre-create the skill target as a REAL directory (a project-owned skill).
    const realDir = join(repo, ".claude", "skills", "requirement-extraction");
    mkdirSync(realDir, { recursive: true });
    writeFileSync(join(realDir, "SKILL.md"), "project-owned — do not touch");

    const report = await service.enableForProject(plugin.id, projectId);
    expect(report.skills).toEqual([{ name: "requirement-extraction", mode: "skipped-existing" }]);

    const result = await service.disableForProject(plugin.id, projectId);
    expect(result.skillsRemoved).toEqual([]);
    expect(await getPref(db, pluginEnabledPreferenceKey("test-safety-net", projectId))).toBe("false");
    // The real dir and its content are untouched.
    expect(readFileSync(join(realDir, "SKILL.md"), "utf8")).toContain("project-owned");
  });

  it("disableForProject removes an actual junction/symlink skill", async () => {
    const pluginDir = makePluginDir();
    const repo = makeProjectRepo();
    const plugin = await service.installPlugin({ source: pluginDir });
    const projectId = await insertProject(db, repo);

    await service.enableForProject(plugin.id, projectId);
    const target = join(repo, ".claude", "skills", "requirement-extraction");
    const wasLink = lstatSync(target).isSymbolicLink();

    const result = await service.disableForProject(plugin.id, projectId);
    if (wasLink) {
      expect(result.skillsRemoved).toEqual(["requirement-extraction"]);
      expect(existsSync(target)).toBe(false);
      // The plugin's own skill source is untouched.
      expect(existsSync(join(pluginDir, "skills", "requirement-extraction", "SKILL.md"))).toBe(true);
    } else {
      // Copy fallback platform: copies are project files now — never deleted.
      expect(result.skillsRemoved).toEqual([]);
      expect(existsSync(target)).toBe(true);
    }
  });

  it("getButlerFragments returns delimited, substituted sections for enabled plugins only", async () => {
    const pluginDir = makePluginDir();
    const repo = makeProjectRepo();
    const plugin = await service.installPlugin({ source: pluginDir });
    const projectId = await insertProject(db, repo);

    expect(await service.getButlerFragments(projectId)).toEqual([]);

    await service.enableForProject(plugin.id, projectId);
    const fragments = await service.getButlerFragments(projectId);
    expect(fragments).toHaveLength(1);
    expect(fragments[0]).toContain("## Plugin: Test Safety Net");
    expect(fragments[0]).toContain(`Coverage docs live in ${repo}/docs/analysis.`);

    await service.disableForProject(plugin.id, projectId);
    expect(await service.getButlerFragments(projectId)).toEqual([]);
  });

  it("runScript runs with plugin cwd and substituted env, capturing output", async () => {
    const pluginDir = makePluginDir();
    const repo = makeProjectRepo();
    const plugin = await service.installPlugin({ source: pluginDir });
    const projectId = await insertProject(db, repo);

    const result = await service.runScript(plugin.id, "print-env", projectId);
    expect(result.timedOut).toBe(false);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(`${repo}|${pluginDir}`);
  });

  it("runScript rejects an unknown script name with NOT_FOUND", async () => {
    const plugin = await service.installPlugin({ source: makePluginDir() });
    const projectId = await insertProject(db, makeProjectRepo());
    await expect(service.runScript(plugin.id, "nope", projectId)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("removePlugin drops the row and flips enable prefs off, keeping files on disk", async () => {
    const pluginDir = makePluginDir();
    const repo = makeProjectRepo();
    const plugin = await service.installPlugin({ source: pluginDir });
    const projectId = await insertProject(db, repo);
    await service.enableForProject(plugin.id, projectId);

    await service.removePlugin(plugin.id);
    expect(await service.listPlugins()).toHaveLength(0);
    expect(await getPref(db, pluginEnabledPreferenceKey("test-safety-net", projectId))).toBe("false");
    expect(existsSync(join(pluginDir, "kanban-plugin.json"))).toBe(true);
  });

  it("listProjectViews lists only enabled plugins' views with running state", async () => {
    const pluginDir = makePluginDir();
    const repo = makeProjectRepo();
    const plugin = await service.installPlugin({ source: pluginDir });
    const projectId = await insertProject(db, repo);

    expect(await service.listProjectViews(projectId)).toEqual([]);

    await service.enableForProject(plugin.id, projectId);
    const views = await service.listProjectViews(projectId);
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({ pluginSlug: "test-safety-net", id: "coverage", kind: "iframe", running: false });
  });

  it("startView allocates a port, tracks the child, and stopView kills it", async () => {
    const pluginDir = makePluginDir();
    // A tiny HTTP server honoring the manifest's portEnv.
    writeFileSync(
      join(pluginDir, "serve.mjs"),
      "import http from 'node:http'; http.createServer((req, res) => res.end('ok')).listen(process.env.PORT, '127.0.0.1');",
    );
    const repo = makeProjectRepo();
    const plugin = await service.installPlugin({ source: pluginDir });
    const projectId = await insertProject(db, repo);

    const started = await service.startView(plugin.id, "coverage", projectId);
    expect(started.port).toBeGreaterThan(0);
    expect(started.url).toBe(`http://localhost:${started.port}`);

    // Double-start guard: same instance, same port.
    const again = await service.startView(plugin.id, "coverage", projectId);
    expect(again.port).toBe(started.port);

    const status = await service.getViewStatus(plugin.id, "coverage", projectId);
    expect(status.running).toBe(true);

    expect(await service.stopView(plugin.id, "coverage", projectId)).toEqual({ stopped: true });
    const after = await service.getViewStatus(plugin.id, "coverage", projectId);
    expect(after.running).toBe(false);
  });
});
