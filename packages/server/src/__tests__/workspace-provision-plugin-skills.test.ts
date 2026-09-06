import { describe, expect, it, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as schema from "@agentic-kanban/shared/schema";
import { gitExecSync } from "@agentic-kanban/shared/lib/git-exec";
import { onboardingUnitKey, dbInitSkillStepId, pluginInitSkillStepId } from "@agentic-kanban/shared/lib/onboarding-plan";
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
  const repo = makeTempDir("ak-provision-test-repo-");
  gitExecSync(["init"], { cwd: repo });
  return repo;
}

function makePluginDir(): string {
  const dir = makeTempDir("ak-provision-test-plugin-");
  const manifest = {
    id: "test-safety-net",
    name: "Test Safety Net",
    version: "0.1.0",
    skills: [{ dir: "skills/requirement-extraction" }],
    // #321 — the loop names the skill its unit tickets must launch with.
    loops: [{
      name: "extraction",
      skill: "requirement-extraction",
      plan: { command: "node tools/loop-plan.mjs --json", cwd: "plugin" },
    }],
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
    const worktreePath = makeTempDir("ak-provision-test-worktree-");
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

    const worktreePath = makeTempDir("ak-provision-test-worktree-");
    const provision = createWorkspaceProvisionService({
      database: db as unknown as Database,
      gitService: {} as GitService,
    });
    await provision.materializeEnabledPluginSkills(worktreePath, repo, projectId);

    expect(existsSync(join(worktreePath, ".claude", "skills", "requirement-extraction"))).toBe(false);
  });

  /**
   * #1039 — the state found on the live board: `plugin_enabled_test-impact_<id>` = true, the plugin
   * checkout intact, and NO `.claude/skills/test-impact` in the main checkout. `copySkillToWorktree`
   * returned false, so every worktree got the impact MAP and not the tool that reads it, and
   * nothing said so. The enable-time junction is the only bridge from a plugin to a worktree, and
   * it can go missing without any pref changing (the checkout moved, the dir was deleted, the pref
   * was flipped by hand). Provisioning must therefore heal it, not just read it.
   */
  it("re-materializes a plugin skill the main checkout has LOST, into the checkout and the worktree (#1039)", async () => {
    const { db } = createTestDb();
    const pluginDir = makePluginDir();
    const repo = makeProjectRepo();
    const pluginService = createPluginService({ database: db as unknown as Database });
    const plugin = await pluginService.installPlugin({ source: pluginDir });
    const projectId = await insertProject(db, repo);
    await pluginService.enableForProject(plugin.id, projectId);

    // Enabling put the skill into the main checkout — the precondition the ticket's acceptance
    // names ("existing in the main checkout AND in each newly provisioned worktree").
    const mainSkill = join(repo, ".claude", "skills", "requirement-extraction");
    expect(existsSync(join(mainSkill, "tools", "ground.mjs"))).toBe(true);

    // Now lose it, the way the live board had: the junction is gone, the pref still says enabled.
    rmSync(mainSkill, { recursive: true, force: true });
    expect(existsSync(mainSkill)).toBe(false);

    const worktreePath = makeTempDir("ak-provision-test-worktree-");
    const provision = createWorkspaceProvisionService({
      database: db as unknown as Database,
      gitService: {} as GitService,
    });
    const result = await provision.materializeEnabledPluginSkills(worktreePath, repo, projectId);

    // Healed, and SAID so — not a silent copy, not a silent skip.
    expect(result.healed).toEqual(["requirement-extraction"]);
    expect(result.materialized).toEqual(["requirement-extraction"]);
    expect(result.missing).toEqual([]);
    // The main checkout has the skill again (so the NEXT worktree does not need healing) …
    expect(existsSync(join(mainSkill, "tools", "ground.mjs"))).toBe(true);
    // … and this worktree has the full bundle, the tool included.
    const materialized = join(worktreePath, ".claude", "skills", "requirement-extraction");
    expect(readFileSync(join(materialized, "tools", "ground.mjs"), "utf8")).toContain("ground");
  });

  it("re-links a DANGLING skill junction instead of skipping it as existing (#1039)", async () => {
    // `isLinkPath` is true for a junction whose target is gone, and the old skip check treated
    // that as "already materialized" — which made the missing-skill state permanent: every
    // re-enable and every update said `skipped-existing` about a link that led nowhere.
    const { db } = createTestDb();
    const pluginDir = makePluginDir();
    const repo = makeProjectRepo();
    const pluginService = createPluginService({ database: db as unknown as Database });
    const plugin = await pluginService.installPlugin({ source: pluginDir });
    const projectId = await insertProject(db, repo);
    const first = await pluginService.enableForProject(plugin.id, projectId);
    const mainSkill = join(repo, ".claude", "skills", "requirement-extraction");
    if (first.skills[0]?.mode !== "junction") {
      // On a box that cannot create junctions the copy fallback is real files, and a dangling
      // link cannot be staged; the assertion below would be about the wrong mechanism.
      return;
    }

    // Drop the junction and put a DANGLING one in its place — the "plugin checkout moved" shape.
    rmSync(mainSkill, { recursive: true, force: true });
    const { symlinkSync } = await import("node:fs");
    symlinkSync(join(pluginDir, "skills", "does-not-exist"), mainSkill, "junction");
    expect(lstatSync(mainSkill).isSymbolicLink()).toBe(true);
    expect(existsSync(mainSkill)).toBe(false);

    const again = await pluginService.enableForProject(plugin.id, projectId);
    expect(again.skills).toEqual([{ name: "requirement-extraction", mode: "junction" }]);
    expect(again.warnings.join("\n")).toContain("dangling");
    expect(existsSync(join(mainSkill, "tools", "ground.mjs"))).toBe(true);
  });

  it("REPORTS a skill that is enabled on paper but cannot be materialized, rather than silently skipping it (#1039)", async () => {
    const { db } = createTestDb();
    const pluginDir = makePluginDir();
    const repo = makeProjectRepo();
    const pluginService = createPluginService({ database: db as unknown as Database });
    const plugin = await pluginService.installPlugin({ source: pluginDir });
    const projectId = await insertProject(db, repo);
    await pluginService.enableForProject(plugin.id, projectId);

    // The skill is gone from BOTH the main checkout and the plugin's own checkout: nothing to heal from.
    rmSync(join(repo, ".claude", "skills", "requirement-extraction"), { recursive: true, force: true });
    rmSync(join(pluginDir, "skills", "requirement-extraction"), { recursive: true, force: true });

    const worktreePath = makeTempDir("ak-provision-test-worktree-");
    const provision = createWorkspaceProvisionService({
      database: db as unknown as Database,
      gitService: {} as GitService,
    });
    const result = await provision.materializeEnabledPluginSkills(worktreePath, repo, projectId);

    expect(result.materialized).toEqual([]);
    expect(result.healed).toEqual([]);
    expect(result.missing).toHaveLength(1);
    expect(result.missing[0]).toMatchObject({ pluginSlug: "test-safety-net", skillName: "requirement-extraction" });
    expect(result.missing[0]?.reason).toContain("skills/requirement-extraction");
    expect(existsSync(join(worktreePath, ".claude", "skills", "requirement-extraction"))).toBe(false);
  });
});

/**
 * Regression for #321: a plugin-loop unit ticket was launched with the PROJECT DEFAULT skill.
 *
 * Measured on the live board — workspace fc679902 for issue #12
 * (`plugin-loop:pm-pipeline:pipeline:step-9:v2`) held `skillId` = board-navigator and its session's
 * `trigger_type` was `skill:board-navigator`, while the loop declares `skill: "pm-step-runner"`. No
 * start path passes a skill for a loop ticket (`startPlannedLoopTickets` calls `createWorkspace`
 * with only `issueId`; so does the monitor's auto-start), so the fix resolves it from the ticket's
 * own `externalKey` — which covers every start path at once.
 */
describe("workspace-provision.service loop-ticket skill resolution (#321)", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* Windows file locks — temp cleanup is best-effort */
      }
    }
  });

  async function setup() {
    const { db } = createTestDb();
    const pluginDir = makePluginDir();
    const repo = makeProjectRepo();
    const pluginService = createPluginService({ database: db as unknown as Database });
    const plugin = await pluginService.installPlugin({ source: pluginDir });
    const projectId = await insertProject(db, repo);
    const provision = createWorkspaceProvisionService({
      database: db as unknown as Database,
      gitService: {} as GitService,
    });
    return { db, repo, plugin, projectId, pluginService, provision };
  }

  const defaultSkillId = randomUUID();

  async function seedDefaultSkill(db: TestDb): Promise<void> {
    const now = new Date().toISOString();
    await db.insert(schema.agentSkills).values({
      id: defaultSkillId,
      name: "board-navigator",
      description: "the project default",
      prompt: "# board-navigator\nUse the board.",
      isBuiltin: true,
      createdAt: now,
      updatedAt: now,
    });
  }

  function loopIssue(projectId: string, externalKey: string | null) {
    return {
      projectId,
      issueNumber: 12,
      title: "Extraction round 1",
      description: "one unit of the loop",
      priority: "medium" as string | null,
      externalKey,
    };
  }

  it("launches a loop unit ticket with the LOOP's skill, not the project default", async () => {
    const { db, repo, plugin, projectId, pluginService, provision } = await setup();
    await pluginService.enableForProject(plugin.id, projectId);
    await seedDefaultSkill(db);
    const worktreePath = makeTempDir("ak-provision-test-worktree-");

    const out = await provision.resolveAgentPromptAndSkill({
      issue: loopIssue(projectId, "plugin-loop:test-safety-net:extraction:auth-service-r1"),
      input: { issueId: randomUUID() },
      includeVisualProof: false,
      workspaceId: randomUUID(),
      worktreePath,
      project: { repoPath: repo, defaultSkillId },
      skillId: null,
    });

    expect(out.skillName).toBe("requirement-extraction");
    // The DB-skill slot stays empty on purpose: a plugin skill is a DISK skill with no
    // `agent_skills` row, and pointing `skillId` at board-navigator is the bug being fixed.
    expect(out.effectiveSkillId).toBeNull();
  });

  it("still falls back to the project default for a NON-loop ticket", async () => {
    const { db, repo, plugin, projectId, pluginService, provision } = await setup();
    await pluginService.enableForProject(plugin.id, projectId);
    await seedDefaultSkill(db);
    const worktreePath = makeTempDir("ak-provision-test-worktree-");

    const out = await provision.resolveAgentPromptAndSkill({
      issue: loopIssue(projectId, null),
      input: { issueId: randomUUID() },
      includeVisualProof: false,
      workspaceId: randomUUID(),
      worktreePath,
      project: { repoPath: repo, defaultSkillId },
      skillId: null,
    });

    expect(out.effectiveSkillId).toBe(defaultSkillId);
    expect(out.skillName).toBe("board-navigator");
  });

  it("does not override an explicitly chosen skill", async () => {
    const { db, repo, plugin, projectId, pluginService, provision } = await setup();
    await pluginService.enableForProject(plugin.id, projectId);
    await seedDefaultSkill(db);
    const worktreePath = makeTempDir("ak-provision-test-worktree-");

    const out = await provision.resolveAgentPromptAndSkill({
      issue: loopIssue(projectId, "plugin-loop:test-safety-net:extraction:auth-service-r1"),
      input: { issueId: randomUUID() },
      includeVisualProof: false,
      workspaceId: randomUUID(),
      worktreePath,
      project: { repoPath: repo, defaultSkillId },
      skillId: defaultSkillId,
    });

    expect(out.effectiveSkillId).toBe(defaultSkillId);
    expect(out.skillName).toBe("board-navigator");
  });

  it("leaves the project default in place when the loop's plugin is not enabled here", async () => {
    // Not enabled → its skills are never materialized into the worktree, so naming the loop's
    // skill would point the agent at a file that isn't there.
    const { db, repo, projectId, provision } = await setup();
    await seedDefaultSkill(db);
    const worktreePath = makeTempDir("ak-provision-test-worktree-");

    const out = await provision.resolveAgentPromptAndSkill({
      issue: loopIssue(projectId, "plugin-loop:test-safety-net:extraction:auth-service-r1"),
      input: { issueId: randomUUID() },
      includeVisualProof: false,
      workspaceId: randomUUID(),
      worktreePath,
      project: { repoPath: repo, defaultSkillId },
      skillId: null,
    });

    expect(out.effectiveSkillId).toBe(defaultSkillId);
    expect(out.skillName).toBe("board-navigator");
  });
});

/**
 * Regression for #474: an onboarding init-skill ticket carries no `skillId` either — same class
 * of bug as #321, just for the OTHER caller of a ticket-body-only skill name
 * (`applyOnboardingStep`). The fix resolves the skill from the ticket's own `external_key`
 * (`onboarding:<projectId>:init-skill:...`), for both a DB-row init skill and a plugin
 * manifest-declared `skills[].init` entry.
 */
describe("workspace-provision.service onboarding init-skill ticket resolution (#474)", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* Windows file locks — temp cleanup is best-effort */
      }
    }
  });

  async function setup() {
    const { db } = createTestDb();
    const pluginDir = makePluginDir();
    const repo = makeProjectRepo();
    const pluginService = createPluginService({ database: db as unknown as Database });
    const plugin = await pluginService.installPlugin({ source: pluginDir });
    const projectId = await insertProject(db, repo);
    const provision = createWorkspaceProvisionService({
      database: db as unknown as Database,
      gitService: {} as GitService,
    });
    return { db, repo, plugin, projectId, pluginService, provision };
  }

  const defaultSkillId = randomUUID();

  async function seedDefaultSkill(db: TestDb): Promise<void> {
    const now = new Date().toISOString();
    await db.insert(schema.agentSkills).values({
      id: defaultSkillId,
      name: "board-navigator",
      description: "the project default",
      prompt: "# board-navigator\nUse the board.",
      isBuiltin: true,
      createdAt: now,
      updatedAt: now,
    });
  }

  const dbInitSkillId = randomUUID();

  async function seedDbInitSkill(db: TestDb): Promise<void> {
    const now = new Date().toISOString();
    await db.insert(schema.agentSkills).values({
      id: dbInitSkillId,
      name: "project-context-init",
      description: "Write project context docs.",
      prompt: "# project-context-init\nWrite CLAUDE.md.",
      isBuiltin: true,
      isInit: true,
      createdAt: now,
      updatedAt: now,
    });
  }

  function onboardingIssue(projectId: string, externalKey: string | null) {
    return {
      projectId,
      issueNumber: 30,
      title: "Onboarding step",
      description: "onboarding-filed ticket",
      priority: "medium" as string | null,
      externalKey,
    };
  }

  it("launches a plugin init-skill ticket with the plugin's disk skill, not the project default", async () => {
    const { repo, plugin, projectId, pluginService, provision, db } = await setup();
    await pluginService.enableForProject(plugin.id, projectId);
    await seedDefaultSkill(db);
    const worktreePath = makeTempDir("ak-provision-test-worktree-");

    const stepId = pluginInitSkillStepId("test-safety-net", "requirement-extraction");
    const externalKey = onboardingUnitKey(projectId, stepId);

    const out = await provision.resolveAgentPromptAndSkill({
      issue: onboardingIssue(projectId, externalKey),
      input: { issueId: randomUUID() },
      includeVisualProof: false,
      workspaceId: randomUUID(),
      worktreePath,
      project: { repoPath: repo, defaultSkillId },
      skillId: null,
    });

    expect(out.skillName).toBe("requirement-extraction");
    expect(out.effectiveSkillId).toBeNull();
    // The bundle, not just the name — materialized into the worktree, not just referenced.
    expect(existsSync(join(worktreePath, ".claude", "skills", "requirement-extraction", "SKILL.md"))).toBe(true);
  });

  it("launches a DB init-skill ticket with that DB skill, not the project default", async () => {
    const { repo, projectId, provision, db } = await setup();
    await seedDefaultSkill(db);
    await seedDbInitSkill(db);
    const worktreePath = makeTempDir("ak-provision-test-worktree-");

    const stepId = dbInitSkillStepId(dbInitSkillId);
    const externalKey = onboardingUnitKey(projectId, stepId);

    const out = await provision.resolveAgentPromptAndSkill({
      issue: onboardingIssue(projectId, externalKey),
      input: { issueId: randomUUID() },
      includeVisualProof: false,
      workspaceId: randomUUID(),
      worktreePath,
      project: { repoPath: repo, defaultSkillId },
      skillId: null,
    });

    expect(out.skillName).toBe("project-context-init");
    expect(out.effectiveSkillId).toBe(dbInitSkillId);
    expect(existsSync(join(worktreePath, ".claude", "skills", "project-context-init", "SKILL.md"))).toBe(true);
  });

  it("leaves the project default in place when the plugin init skill's plugin is not enabled here", async () => {
    const { repo, projectId, provision, db } = await setup();
    // Deliberately not enabled.
    await seedDefaultSkill(db);
    const worktreePath = makeTempDir("ak-provision-test-worktree-");

    const stepId = pluginInitSkillStepId("test-safety-net", "requirement-extraction");
    const externalKey = onboardingUnitKey(projectId, stepId);

    const out = await provision.resolveAgentPromptAndSkill({
      issue: onboardingIssue(projectId, externalKey),
      input: { issueId: randomUUID() },
      includeVisualProof: false,
      workspaceId: randomUUID(),
      worktreePath,
      project: { repoPath: repo, defaultSkillId },
      skillId: null,
    });

    expect(out.effectiveSkillId).toBe(defaultSkillId);
    expect(out.skillName).toBe("board-navigator");
  });

  it("does not override an explicitly chosen skill", async () => {
    const { repo, plugin, projectId, pluginService, provision, db } = await setup();
    await pluginService.enableForProject(plugin.id, projectId);
    await seedDefaultSkill(db);
    const worktreePath = makeTempDir("ak-provision-test-worktree-");

    const stepId = pluginInitSkillStepId("test-safety-net", "requirement-extraction");
    const externalKey = onboardingUnitKey(projectId, stepId);

    const out = await provision.resolveAgentPromptAndSkill({
      issue: onboardingIssue(projectId, externalKey),
      input: { issueId: randomUUID() },
      includeVisualProof: false,
      workspaceId: randomUUID(),
      worktreePath,
      project: { repoPath: repo, defaultSkillId },
      skillId: defaultSkillId,
    });

    expect(out.effectiveSkillId).toBe(defaultSkillId);
    expect(out.skillName).toBe("board-navigator");
  });
});
