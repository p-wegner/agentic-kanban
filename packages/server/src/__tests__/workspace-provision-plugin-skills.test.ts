import { describe, expect, it, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
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
