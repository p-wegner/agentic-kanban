import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import * as schema from "@agentic-kanban/shared/schema";
import { gitExecSync } from "@agentic-kanban/shared/lib/git-exec";
import { pluginEnabledPreferenceKey } from "@agentic-kanban/shared/lib/plugin-manifest";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { createPluginService, PluginError, stopAllPluginViewsAsync } from "../services/plugin.service.js";
import type { PluginSkillRunProgress } from "../services/plugin.service.js";
import type { Database } from "../db/index.js";
import { reapOrphanedPluginViewProcesses } from "../startup/startup-tasks.js";

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
  // Give every product repo its OWN parent directory. `setOutputLocation(..., "sidecar")`
  // creates the output repo as a SIBLING of this one, and that sibling's name is derived
  // from the manifest id — so it is FIXED, not randomized. With the repo sitting directly
  // in the OS temp root, the sibling landed in a shared parent, survived the run, and every
  // later run then died in createSiblingRepoDir with "Directory already exists" — a one-shot
  // test that permanently reddened `pnpm test:mine`, i.e. the merge gate, for everyone.
  // Nesting under a unique parent keeps the sibling per-run and lets afterEach reap both.
  const parent = makeTempDir("plugin-test-parent-");
  const repo = join(parent, "product-repo");
  mkdirSync(repo, { recursive: true });
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
    { name: "print-roots", command: "node print-roots.mjs", cwd: "plugin", env: { LEADING: "{{leadingRepoPath}}", OUTPUT: "{{repoPath}}" } },
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
  writeFileSync(join(dir, "print-roots.mjs"), "console.log(process.env.LEADING + '|' + process.env.OUTPUT);");
  return dir;
}

const MANIFEST_WITH_LOOP = {
  ...MANIFEST,
  loops: [{ name: "identify-modules", skill: "requirement-extraction", plan: { command: "node plan.mjs", cwd: "plugin" } }],
};

/** A plugin whose scaffold template still has unfilled TODO markers, like refactor-safety-net's. */
function makePluginDirWithTodoScaffold(): string {
  const dir = makePluginDir(MANIFEST_WITH_LOOP);
  writeFileSync(
    join(dir, "profile-template.md"),
    "# Profile for {{projectName}}\n\nSource dirs: TODO: e.g. src\nBuild command: TODO: e.g. npm run build\n",
  );
  writeFileSync(join(dir, "plan.mjs"), "console.log(JSON.stringify({ units: [] }));");
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

/** A global (project-less) workflow template, like the board's builtins. */
async function seedTemplate(db: TestDb, opts: { name: string; builtinKey: string }): Promise<string> {
  const now = new Date().toISOString();
  const id = randomUUID();
  await db.insert(schema.workflowTemplates).values({
    id,
    projectId: null,
    name: opts.name,
    description: null,
    ticketType: null,
    isDefault: false,
    isBuiltin: true,
    builtinKey: opts.builtinKey,
    createdAt: now,
    updatedAt: now,
  });
  return id;
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

  // ASYNC + awaited (#352): the sync `stopAllPluginViews()` fire-and-forgets the Windows tree
  // kill, so this hook used to `rmSync` the temp dir while the real `node serve.mjs` grandchild
  // was still alive holding it as `cwd` — EBUSY, swallowed as "best effort", and 330 stale dirs
  // plus 22 live orphans accumulated. Wait for the kills, THEN remove.
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
    // The stock template has no TODO markers, so nothing to flag.
    expect(report.scaffoldPlaceholders).toBe(0);
    expect(report.warnings).toEqual([]);

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

  it("getButlerFragments appends a DERIVED capability roster so the butler knows what the plugin can be asked to do", async () => {
    // A plugin's own fragment explains how to CONSUME its output; it rarely lists what the plugin can
    // be told to do, and drifts when loops are added. The roster is derived from the manifest so it
    // cannot go stale, and it names skills by the same basename `loops[].skill` uses.
    const pluginDir = makePluginDir(MANIFEST_WITH_LOOP);
    const repo = makeProjectRepo();
    const plugin = await service.installPlugin({ source: pluginDir });
    const projectId = await insertProject(db, repo);
    await service.enableForProject(plugin.id, projectId);

    const [fragment] = await service.getButlerFragments(projectId);
    expect(fragment).toContain("Coverage docs live in"); // the author's fragment survives
    expect(fragment).toContain("**Skills it provides**");
    expect(fragment).toContain("`requirement-extraction`");
    expect(fragment).toContain("**Converging loops**");
    expect(fragment).toContain("`identify-modules`");
    expect(fragment).toContain("hands out `requirement-extraction`");
  });

  it("a plugin with no butler fragment still announces its capabilities instead of being invisible", async () => {
    const { promptFragment: _dropped, ...noButler } = { ...MANIFEST_WITH_LOOP, butler: undefined } as Record<string, unknown>;
    const manifest = { ...noButler };
    delete (manifest as { butler?: unknown }).butler;
    const pluginDir = makePluginDir(manifest);
    const repo = makeProjectRepo();
    const plugin = await service.installPlugin({ source: pluginDir });
    const projectId = await insertProject(db, repo);
    await service.enableForProject(plugin.id, projectId);

    const fragments = await service.getButlerFragments(projectId);
    expect(fragments).toHaveLength(1);
    expect(fragments[0]).toContain("**Skills it provides**");
    expect(fragments[0]).not.toContain("Coverage docs live in");
  });

  it("a butler fragment's {{repoPath}} is the OUTPUT repo in sidecar mode, like every other site", async () => {
    const pluginDir = makePluginDir();
    const repo = makeProjectRepo();
    const plugin = await service.installPlugin({ source: pluginDir });
    const projectId = await insertProject(db, repo);
    await service.enableForProject(plugin.id, projectId);
    // Creates the sidecar, so the fragment has a real output repo to name.
    const { repoPath: sidecar } = await service.setOutputLocation(plugin.id, projectId, "sidecar");

    const fragments = await service.getButlerFragments(projectId);
    // The stock fragment is "Coverage docs live in {{repoPath}}/docs/analysis."
    expect(fragments[0]).toContain(`Coverage docs live in ${sidecar}/docs/analysis`);
    expect(fragments[0]).not.toContain(`Coverage docs live in ${repo}/docs/analysis`);
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

  it("runScript in sidecar output mode still exposes the product repo via {{leadingRepoPath}}", async () => {
    const pluginDir = makePluginDir();
    const repo = makeProjectRepo();
    const plugin = await service.installPlugin({ source: pluginDir });
    const projectId = await insertProject(db, repo);

    await service.setOutputLocation(plugin.id, projectId, "sidecar");
    const result = await service.runScript(plugin.id, "print-roots", projectId);
    expect(result.timedOut).toBe(false);
    expect(result.code).toBe(0);
    const [leading, output] = result.stdout.trim().split("|");
    // {{leadingRepoPath}} must still name the product repo...
    expect(leading).toBe(repo);
    // ...even though {{repoPath}} (output) now points at the sidecar, not the product repo.
    expect(output).not.toBe(repo);
    expect(existsSync(output)).toBe(true);
  });

  it("runScript substitutes {{boardUrl}} and {{projectId}} into script env (#236)", async () => {
    const manifest = {
      ...MANIFEST,
      scripts: [
        ...MANIFEST.scripts,
        { name: "print-board", command: "node print-board.mjs", cwd: "plugin", env: { BOARD: "{{boardUrl}}", PROJECT: "{{projectId}}" } },
      ],
    };
    const pluginDir = makePluginDir(manifest);
    writeFileSync(join(pluginDir, "print-board.mjs"), "console.log(process.env.BOARD + '|' + process.env.PROJECT);");
    const withBoardUrl = createPluginService({ database: db as unknown as Database, boardUrl: "http://localhost:3123" });
    const plugin = await withBoardUrl.installPlugin({ source: pluginDir });
    const projectId = await insertProject(db, makeProjectRepo());

    const result = await withBoardUrl.runScript(plugin.id, "print-board", projectId);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(`http://localhost:3123|${projectId}`);
  });

  it("advanceLoop substitutes {{boardUrl}} and {{projectId}} into the planner's env (#236)", async () => {
    const manifest = {
      ...MANIFEST,
      loops: [{
        name: "identify-modules",
        skill: "requirement-extraction",
        plan: { command: "node plan.mjs", cwd: "plugin", env: { BOARD: "{{boardUrl}}", PROJECT: "{{projectId}}" } },
      }],
    };
    const pluginDir = makePluginDir(manifest);
    // The planner echoes its substituted env back through the plan's `note`, which
    // `advanceLoop` surfaces verbatim — no ticket creation needed to observe it.
    writeFileSync(
      join(pluginDir, "plan.mjs"),
      "console.log(JSON.stringify({ units: [], converged: false, note: process.env.BOARD + '|' + process.env.PROJECT }));",
    );
    const withBoardUrl = createPluginService({
      database: db as unknown as Database,
      boardUrl: "http://localhost:3123",
      createIssue: vi.fn(),
    });
    const plugin = await withBoardUrl.installPlugin({ source: pluginDir });
    const projectId = await insertProject(db, makeProjectRepo());

    const result = await withBoardUrl.advanceLoop(plugin.id, "identify-modules", projectId);
    expect(result.note).toBe(`http://localhost:3123|${projectId}`);
  });

  it("runScript rejects an unknown script name with NOT_FOUND", async () => {
    const plugin = await service.installPlugin({ source: makePluginDir() });
    const projectId = await insertProject(db, makeProjectRepo());
    await expect(service.runScript(plugin.id, "nope", projectId)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  // #318 — the enable flow must be able to make the output-location choice, because
  // enabling SCAFFOLDS. Setting the location afterwards moved the preference but left
  // the already-written scaffold in the leading repo, which is why the operator docs
  // had to say "decide first".
  it("enableForProject with location 'sidecar' scaffolds into the SIDECAR, not the leading repo", async () => {
    const pluginDir = makePluginDir();
    const repo = makeProjectRepo();
    const plugin = await service.installPlugin({ source: pluginDir });
    const projectId = await insertProject(db, repo);

    const report = await service.enableForProject(plugin.id, projectId, "sidecar");

    expect(report.scaffoldWritten).toBe(true);
    const { location, repoPath: sidecar } = await service.getOutputLocation(plugin.id, projectId);
    expect(location).toBe("sidecar");
    expect(sidecar).not.toBe(repo);
    // The decisive assertion: the scaffold is in the sidecar and NOT in the leading repo.
    expect(existsSync(join(sidecar!, "docs", "analysis", "_project-profile.md"))).toBe(true);
    expect(existsSync(join(repo, "docs", "analysis", "_project-profile.md"))).toBe(false);
  });

  it("enableForProject without a location is unchanged — leading repo, as before", async () => {
    // The non-breaking half, and the one that matters: omitting the param must behave
    // exactly as it did before #318.
    const pluginDir = makePluginDir();
    const repo = makeProjectRepo();
    const plugin = await service.installPlugin({ source: pluginDir });
    const projectId = await insertProject(db, repo);

    const report = await service.enableForProject(plugin.id, projectId);

    expect(report.scaffoldWritten).toBe(true);
    expect(existsSync(join(repo, "docs", "analysis", "_project-profile.md"))).toBe(true);
    expect((await service.getOutputLocation(plugin.id, projectId)).location).toBe("leading");
  });

  it("enableForProject rejects a bogus location instead of silently defaulting", async () => {
    const pluginDir = makePluginDir();
    const repo = makeProjectRepo();
    const plugin = await service.installPlugin({ source: pluginDir });
    const projectId = await insertProject(db, repo);

    await expect(service.enableForProject(plugin.id, projectId, "elsewhere")).rejects.toThrow(/location must be one of/);
    // And it must not have half-enabled: the pref write happens after validation.
    expect(await getPref(db, pluginEnabledPreferenceKey("test-safety-net", projectId))).toBeFalsy();
  });

  it("enableForProject flags an unfilled scaffold's TODO placeholders in warnings", async () => {
    const pluginDir = makePluginDirWithTodoScaffold();
    const plugin = await service.installPlugin({ source: pluginDir });
    const projectId = await insertProject(db, makeProjectRepo());

    const report = await service.enableForProject(plugin.id, projectId);
    expect(report.scaffoldWritten).toBe(true);
    expect(report.scaffoldPlaceholders).toBe(2);
    expect(report.warnings).toEqual([
      expect.stringContaining("2 placeholders need filling in docs/analysis/_project-profile.md"),
    ]);
  });

  it("runScript and advanceLoop refuse to run with a clear error while scaffold TODOs are unfilled", async () => {
    const pluginDir = makePluginDirWithTodoScaffold();
    const repo = makeProjectRepo();
    const plugin = await service.installPlugin({ source: pluginDir });
    const projectId = await insertProject(db, repo);
    await service.enableForProject(plugin.id, projectId);

    await expect(service.runScript(plugin.id, "print-env", projectId)).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("2 unresolved TODO: placeholders"),
    });

    const createIssue = vi.fn();
    const withDeps = createPluginService({ database: db as unknown as Database, createIssue });
    await expect(withDeps.advanceLoop(plugin.id, "identify-modules", projectId)).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("2 unresolved TODO: placeholders"),
    });
    expect(createIssue).not.toHaveBeenCalled();

    // Once the human fills in the scaffold, the same script runs normally again.
    const target = join(repo, "docs", "analysis", "_project-profile.md");
    writeFileSync(target, readFileSync(target, "utf8").replace(/TODO:[^\n]*/g, "filled in"));
    const result = await service.runScript(plugin.id, "print-env", projectId);
    expect(result.code).toBe(0);
  });

  it("runSkill creates a ticket and launches a workspace against the named skill", async () => {
    const plugin = await service.installPlugin({ source: makePluginDir() });
    const projectId = await insertProject(db, makeProjectRepo());

    const createIssue = vi.fn().mockResolvedValue({ id: "issue-1", issueNumber: 42 });
    const createWorkspace = vi.fn().mockResolvedValue({ id: "ws-1", branch: "feature/ak-42-run-skill" });
    const withDeps = createPluginService({ database: db as unknown as Database, createIssue, createWorkspace });

    const result = await withDeps.runSkill(plugin.id, "requirement-extraction", projectId, {
      title: "Custom title",
      description: "Custom description",
    });

    expect(createIssue).toHaveBeenCalledWith(expect.objectContaining({
      projectId,
      title: "Custom title",
      description: "Custom description",
      skipAutoReview: true,
    }));
    expect(createWorkspace).toHaveBeenCalledWith({ issueId: "issue-1", skillName: "requirement-extraction" });
    expect(result).toEqual({ issueId: "issue-1", issueNumber: 42, workspaceId: "ws-1", branch: "feature/ak-42-run-skill" });
  });

  it("runSkill appends the launcher's prompt to the skill brief instead of replacing it", async () => {
    const plugin = await service.installPlugin({ source: makePluginDir() });
    const projectId = await insertProject(db, makeProjectRepo());
    const createIssue = vi.fn().mockResolvedValue({ id: "issue-1", issueNumber: 42 });
    const createWorkspace = vi.fn().mockResolvedValue({ id: "ws-1", branch: "b" });
    const withDeps = createPluginService({ database: db as unknown as Database, createIssue, createWorkspace });

    await withDeps.runSkill(plugin.id, "requirement-extraction", projectId, {
      prompt: "Only the billing module, and skip the UI lenses.",
    });

    const description = createIssue.mock.calls[0][0].description as string;
    // The brief names the skill to run — dropping it would leave the agent guessing.
    expect(description).toContain("requirement-extraction");
    expect(description).toContain("Only the billing module, and skip the UI lenses.");
  });

  it("runSkill reports the ticket BEFORE the slow workspace provisioning", async () => {
    const plugin = await service.installPlugin({ source: makePluginDir() });
    const projectId = await insertProject(db, makeProjectRepo());
    const seen: string[] = [];
    const createIssue = vi.fn().mockResolvedValue({ id: "issue-1", issueNumber: 42 });
    // Provisioning is the minutes-long part (worktree + setup script + agent launch); the
    // launcher must have the ticket number long before it finishes.
    const createWorkspace = vi.fn().mockImplementation(async () => {
      seen.push("provisioning");
      return { id: "ws-1", branch: "feature/ak-42" };
    });
    const withDeps = createPluginService({ database: db as unknown as Database, createIssue, createWorkspace });

    const events: string[] = [];
    await withDeps.runSkill(plugin.id, "requirement-extraction", projectId, {
      onProgress: (e) => { events.push(e.stage); seen.push(e.stage); },
    });

    expect(events).toEqual(["ticket", "workspace", "done"]);
    expect(seen.indexOf("ticket")).toBeLessThan(seen.indexOf("provisioning"));
    expect(seen.indexOf("done")).toBeGreaterThan(seen.indexOf("provisioning"));
  });

  it("runSkill's workspace stage names the setup script, the usual reason a launch is slow", async () => {
    const plugin = await service.installPlugin({ source: makePluginDir() });
    const projectId = await insertProject(db, makeProjectRepo());
    await db.update(schema.projects).set({ setupScript: "npm install", setupEnabled: true })
      .where(eq(schema.projects.id, projectId));
    const withDeps = createPluginService({
      database: db as unknown as Database,
      createIssue: vi.fn().mockResolvedValue({ id: "issue-1", issueNumber: 42 }),
      createWorkspace: vi.fn().mockResolvedValue({ id: "ws-1", branch: "b" }),
    });

    const events: PluginSkillRunProgress[] = [];
    await withDeps.runSkill(plugin.id, "requirement-extraction", projectId, {
      onProgress: (e) => events.push(e),
    });

    const workspaceStage = events.find((e) => e.stage === "workspace");
    expect(workspaceStage).toMatchObject({ setupScript: "npm install" });
  });

  it("runSkill uses the manifest's declared workflow, and the launcher's choice overrides it", async () => {
    // A skill that only writes analysis docs should not be routed through implement → review →
    // done just because that is the board's default for a task.
    const manifest = {
      ...MANIFEST,
      skills: [{ dir: "skills/requirement-extraction", workflow: "research-task" }],
    };
    const plugin = await service.installPlugin({ source: makePluginDir(manifest) });
    const projectId = await insertProject(db, makeProjectRepo());
    const research = await seedTemplate(db, { name: "Research Task", builtinKey: "research-task" });
    const other = await seedTemplate(db, { name: "Hard Bug", builtinKey: "hard-bug" });

    const createIssue = vi.fn().mockResolvedValue({ id: "issue-1", issueNumber: 42 });
    const withDeps = createPluginService({
      database: db as unknown as Database,
      createIssue,
      createWorkspace: vi.fn().mockResolvedValue({ id: "ws-1", branch: "b" }),
    });

    await withDeps.runSkill(plugin.id, "requirement-extraction", projectId);
    expect(createIssue.mock.calls[0][0].workflowTemplateId).toBe(research);

    await withDeps.runSkill(plugin.id, "requirement-extraction", projectId, { workflowTemplateId: other });
    expect(createIssue.mock.calls[1][0].workflowTemplateId).toBe(other);
  });

  it("runSkill falls back to the board default when the manifest names an unknown workflow", async () => {
    const manifest = {
      ...MANIFEST,
      skills: [{ dir: "skills/requirement-extraction", workflow: "no-such-workflow" }],
    };
    const plugin = await service.installPlugin({ source: makePluginDir(manifest) });
    const projectId = await insertProject(db, makeProjectRepo());
    const createIssue = vi.fn().mockResolvedValue({ id: "issue-1", issueNumber: 42 });
    const withDeps = createPluginService({
      database: db as unknown as Database,
      createIssue,
      createWorkspace: vi.fn().mockResolvedValue({ id: "ws-1", branch: "b" }),
    });

    // Degrades rather than blocking: a plugin naming a workflow this board has never heard of
    // must not make the skill unlaunchable.
    await expect(withDeps.runSkill(plugin.id, "requirement-extraction", projectId)).resolves.toBeTruthy();
    expect(createIssue.mock.calls[0][0].workflowTemplateId).toBeNull();
  });

  it("runSkill matches a declared workflow by template NAME as well as builtin key", async () => {
    const manifest = {
      ...MANIFEST,
      skills: [{ dir: "skills/requirement-extraction", workflow: "Research Task" }],
    };
    const plugin = await service.installPlugin({ source: makePluginDir(manifest) });
    const projectId = await insertProject(db, makeProjectRepo());
    const research = await seedTemplate(db, { name: "Research Task", builtinKey: "research-task" });
    const createIssue = vi.fn().mockResolvedValue({ id: "issue-1", issueNumber: 42 });
    const withDeps = createPluginService({
      database: db as unknown as Database,
      createIssue,
      createWorkspace: vi.fn().mockResolvedValue({ id: "ws-1", branch: "b" }),
    });

    await withDeps.runSkill(plugin.id, "requirement-extraction", projectId);
    expect(createIssue.mock.calls[0][0].workflowTemplateId).toBe(research);
  });

  it("runSkill rejects an unknown skill name with NOT_FOUND", async () => {
    const plugin = await service.installPlugin({ source: makePluginDir() });
    const projectId = await insertProject(db, makeProjectRepo());
    const withDeps = createPluginService({
      database: db as unknown as Database,
      createIssue: vi.fn(),
      createWorkspace: vi.fn(),
    });
    await expect(withDeps.runSkill(plugin.id, "nope", projectId)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("runSkill rejects when createIssue/createWorkspace were not injected (script-only route)", async () => {
    const plugin = await service.installPlugin({ source: makePluginDir() });
    const projectId = await insertProject(db, makeProjectRepo());
    await expect(service.runSkill(plugin.id, "requirement-extraction", projectId)).rejects.toMatchObject({ code: "BAD_REQUEST" });
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

  it("startView substitutes {{boardUrl}} and {{projectId}} into the view server's env (#236)", async () => {
    const manifest = {
      ...MANIFEST,
      views: [{
        id: "coverage",
        label: "Coverage",
        kind: "iframe",
        serve: { command: "node serve.mjs", portEnv: "PORT", env: { BOARD: "{{boardUrl}}", PROJECT: "{{projectId}}" } },
      }],
    };
    const pluginDir = makePluginDir(manifest);
    // The child answers with its substituted env — proving a plugin view server can be
    // handed the board's API URL and project id, i.e. can actually show board data.
    writeFileSync(
      join(pluginDir, "serve.mjs"),
      "import http from 'node:http'; http.createServer((req, res) => res.end(process.env.BOARD + '|' + process.env.PROJECT)).listen(process.env.PORT, '127.0.0.1');",
    );
    const withBoardUrl = createPluginService({ database: db as unknown as Database, boardUrl: "http://localhost:3123" });
    const plugin = await withBoardUrl.installPlugin({ source: pluginDir });
    const projectId = await insertProject(db, makeProjectRepo());

    const started = await withBoardUrl.startView(plugin.id, "coverage", projectId);
    expect(started.ready).toBe(true);
    const body = await (await fetch(`http://127.0.0.1:${started.port}/`)).text();
    expect(body).toBe(`http://localhost:3123|${projectId}`);
    await withBoardUrl.stopView(plugin.id, "coverage", projectId);
  });

  it("startView persists the child's PID, stopView drops it (#228)", async () => {
    const pluginDir = makePluginDir();
    writeFileSync(
      join(pluginDir, "serve.mjs"),
      "import http from 'node:http'; http.createServer((req, res) => res.end('ok')).listen(process.env.PORT, '127.0.0.1');",
    );
    const repo = makeProjectRepo();
    const plugin = await service.installPlugin({ source: pluginDir });
    const projectId = await insertProject(db, repo);

    const started = await service.startView(plugin.id, "coverage", projectId);
    expect(started.pid).toBeGreaterThan(0);

    const rows = await db.select().from(schema.pluginViewProcesses);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ pluginRowId: plugin.id, viewId: "coverage", projectId, pid: started.pid });

    await service.stopView(plugin.id, "coverage", projectId);
    expect(await db.select().from(schema.pluginViewProcesses)).toHaveLength(0);
  });

  it("reapOrphanedPluginViewProcesses kills a view server left behind by a previous server generation and drops its record (#228)", async () => {
    // Reproduces the bug: a backend restart (tsx watch) leaves the previously-spawned
    // view server running with nothing left in-process to reap it. The only surviving
    // record is the DB row `startView` persisted at spawn time — this is what the next
    // server generation's startup reconciliation reads.
    const pluginDir = makePluginDir();
    writeFileSync(
      join(pluginDir, "serve.mjs"),
      "import http from 'node:http'; http.createServer((req, res) => res.end('ok')).listen(process.env.PORT, '127.0.0.1');",
    );
    const repo = makeProjectRepo();
    const plugin = await service.installPlugin({ source: pluginDir });
    const projectId = await insertProject(db, repo);

    const started = await service.startView(plugin.id, "coverage", projectId);
    const pid = started.pid;
    expect(pid).toBeGreaterThan(0);
    // Confirm the process is really alive before reaping it.
    expect(() => process.kill(pid as number, 0)).not.toThrow();

    // Simulate the fresh server generation's startup sweep — it never called
    // stopView, it only has the persisted PID row to go on.
    await reapOrphanedPluginViewProcesses(db as unknown as Database);

    expect(await db.select().from(schema.pluginViewProcesses)).toHaveLength(0);
    await vi.waitFor(() => {
      expect(() => process.kill(pid as number, 0)).toThrow();
    });
    // The command-line cross-check enumerates all OS processes (Get-CimInstance on
    // Windows), which routinely takes longer than vitest's 5s default.
  }, 30000);

  /** Child server processes can take a moment to bind under load; poll instead of asserting on the first check. */
  async function waitForHealthy(pluginRowId: string, viewId: string, projectId: string) {
    let status: Awaited<ReturnType<typeof service.getViewStatus>> | undefined;
    for (let attempt = 0; attempt < 20; attempt++) {
      status = await service.getViewStatus(pluginRowId, viewId, projectId);
      if (status.running && status.healthy) return status;
      await new Promise((r) => setTimeout(r, 250));
    }
    return status;
  }

  it("getViewStatus falls back to \"/\" when the default \"/health\" 404s (no dedicated endpoint)", async () => {
    const pluginDir = makePluginDir();
    // Realistic router: only "/" is handled, anything else 404s — as a plugin with no
    // dedicated health endpoint would behave.
    writeFileSync(
      join(pluginDir, "serve.mjs"),
      "import http from 'node:http';" +
        "http.createServer((req, res) => {" +
        "  if (req.url === '/') { res.end('ok'); return; }" +
        "  res.writeHead(404); res.end();" +
        "}).listen(process.env.PORT, '127.0.0.1');",
    );
    const repo = makeProjectRepo();
    const plugin = await service.installPlugin({ source: pluginDir });
    const projectId = await insertProject(db, repo);

    await service.startView(plugin.id, "coverage", projectId);
    const status = await waitForHealthy(plugin.id, "coverage", projectId);
    expect(status).toMatchObject({ running: true, healthy: true });
  });

  it("getViewStatus honors a manifest healthPath and reports unhealthy on a 500 index page", async () => {
    const manifest = {
      ...MANIFEST,
      views: [
        {
          id: "coverage",
          label: "Coverage",
          kind: "iframe",
          serve: { command: "node serve.mjs", portEnv: "PORT", healthPath: "/health" },
        },
      ],
    };
    const pluginDir = makePluginDir(manifest);
    // Index legitimately 5xxs while the server is otherwise up — the dedicated
    // /health endpoint is the source of truth, not the (expensive/erroring) index.
    writeFileSync(
      join(pluginDir, "serve.mjs"),
      "import http from 'node:http';" +
        "http.createServer((req, res) => {" +
        "  if (req.url === '/health') { res.end('ok'); return; }" +
        "  res.writeHead(500); res.end();" +
        "}).listen(process.env.PORT, '127.0.0.1');",
    );
    const repo = makeProjectRepo();
    const plugin = await service.installPlugin({ source: pluginDir });
    const projectId = await insertProject(db, repo);

    await service.startView(plugin.id, "coverage", projectId);
    const status = await waitForHealthy(plugin.id, "coverage", projectId);
    expect(status).toMatchObject({ running: true, healthy: true });
  });

  it("startView honors serve.cwd: 'repo' — the view process runs in the project repo, not the plugin checkout", async () => {
    const manifest = {
      ...MANIFEST,
      views: [
        {
          id: "coverage",
          label: "Coverage",
          kind: "iframe",
          serve: { command: "node {{pluginPath}}/serve.mjs", portEnv: "PORT", cwd: "repo" },
        },
      ],
    };
    const pluginDir = makePluginDir(manifest);
    // Writes a marker into ITS OWN cwd, then serves — proves which directory it actually ran in.
    writeFileSync(
      join(pluginDir, "serve.mjs"),
      "import http from 'node:http'; import fs from 'node:fs'; " +
        "fs.writeFileSync('cwd-marker.txt', process.cwd()); " +
        "http.createServer((req, res) => res.end('ok')).listen(process.env.PORT, '127.0.0.1');",
    );
    const repo = makeProjectRepo();
    const plugin = await service.installPlugin({ source: pluginDir });
    const projectId = await insertProject(db, repo);

    await service.startView(plugin.id, "coverage", projectId);

    // Small poll: the child needs a moment to write its marker after spawn.
    const deadline = Date.now() + 2000;
    while (!existsSync(join(repo, "cwd-marker.txt")) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }

    expect(existsSync(join(repo, "cwd-marker.txt"))).toBe(true);
    expect(existsSync(join(pluginDir, "cwd-marker.txt"))).toBe(false);

    await service.stopView(plugin.id, "coverage", projectId);
  });
});
