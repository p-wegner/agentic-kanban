import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@agentic-kanban/shared/schema";
import { setPreference } from "../repositories/preferences.repository.js";
import { saveStackProfile } from "../services/stack-profile.service.js";
import { insertProjectRepo } from "../repositories/repo.repository.js";
import { upsertPluginRow } from "../repositories/plugins.repository.js";
import { createIssueService } from "../services/issue.service.js";
import { getPluginService } from "../services/plugin.service.js";
import { createAgentSkillService } from "../services/agent-skill.service.js";
import { createOnboardingService, OnboardingError } from "../services/onboarding.service.js";
import { createTestDb, type TestDb } from "./helpers/test-db.js";

const NOW = "2026-08-14T00:00:00.000Z";

async function seedProject(database: TestDb, repoPath = "C:/tmp/onboarding-project") {
  const projectId = randomUUID();
  await database.insert(schema.projects).values({
    id: projectId,
    name: "Onboarding Project",
    repoPath,
    repoName: "onboarding-project",
    defaultBranch: "main",
    createdAt: NOW,
    updatedAt: NOW,
  });
  const statusId = randomUUID();
  await database.insert(schema.projectStatuses).values({
    id: statusId, projectId, name: "Todo", sortOrder: 0, isDefault: true, createdAt: NOW,
  });
  return { projectId, statusId };
}

function buildOnboardingServiceFor(database: TestDb) {
  const issueService = createIssueService({ database });
  const pluginService = getPluginService(database);
  const agentSkillService = createAgentSkillService({ database });
  return createOnboardingService({
    database,
    pluginService,
    agentSkillService,
    createIssuesBatch: issueService.createIssuesBatch,
  });
}

describe("onboarding.service", () => {
  let db: TestDb;
  let dispose: () => void;

  beforeEach(() => {
    const created = createTestDb();
    db = created.db;
    dispose = created.dispose;
  });

  afterEach(() => dispose());

  it("throws NOT_FOUND for an unknown project", async () => {
    const service = buildOnboardingServiceFor(db);
    await expect(service.buildOnboardingPlan(randomUUID())).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("a bare, freshly-imported project has every required config step pending", async () => {
    const { projectId } = await seedProject(db);
    const service = buildOnboardingServiceFor(db);
    const plan = await service.buildOnboardingPlan(projectId);

    expect(plan.projectId).toBe(projectId);
    expect(plan.dismissedAt).toBeNull();

    const byId = new Map(plan.steps.map((s) => [s.id, s]));
    expect(byId.get("stack-profile")?.status).toBe("pending");
    expect(byId.get("setup-verify-scripts")?.status).toBe("pending");
    expect(byId.get("start-mode")?.status).toBe("pending");
    expect(byId.get("wip-limit")?.status).toBe("pending");
    expect(byId.get("strategy-bullseye")?.status).toBe("pending");
    expect(byId.get("extra-repos")?.status).toBe("pending");

    // No stack profile yet: the "no test command" suggestion still applies (appliesWhen(null) === true).
    expect(byId.get("ticket:add-verify-gate")?.status).toBe("pending");
    // Generic starter suggestions always apply.
    expect(byId.get("ticket:document-context")?.status).toBe("pending");
  });

  it("a fully-configured project reports every config step done and drops the applicable-only suggestion", async () => {
    const { projectId } = await seedProject(db);

    await saveStackProfile(projectId, {
      stack: "node",
      packageManager: "pnpm",
      isMonorepo: false,
      workspaces: [],
      installCommand: "pnpm install",
      buildCommand: "pnpm build",
      testCommand: "pnpm test",
      quickTestCommand: null,
      lintCommand: null,
      typecheckCommand: null,
      devCommand: null,
      isWeb: false,
      devHealthUrl: null,
      devPort: null,
      testDir: null,
      testRunner: "vitest",
      source: "detected",
      detectedMarkers: [],
      updatedAt: NOW,
    }, db);
    // Direct column write — this test only cares about DERIVED plan status, not the apply path.
    await db.update(schema.projects).set({ setupScript: "pnpm install" }).where(eq(schema.projects.id, projectId));
    await setPreference("verify_script_" + projectId, "pnpm test", db);
    await setPreference("start_mode_" + projectId, "monitor", db);
    await setPreference("wip_limit_" + projectId, "3", db);
    await setPreference("board_strategy_" + projectId, JSON.stringify({ provider: "claude_code" }), db);
    await insertProjectRepo({ projectId, path: "C:/tmp/sibling", name: "sibling", defaultBranch: "main" }, db);

    const service = buildOnboardingServiceFor(db);
    const plan = await service.buildOnboardingPlan(projectId);
    const byId = new Map(plan.steps.map((s) => [s.id, s]));

    expect(byId.get("stack-profile")?.status).toBe("done");
    expect(byId.get("start-mode")?.status).toBe("done");
    expect(byId.get("wip-limit")?.status).toBe("done");
    expect(byId.get("strategy-bullseye")?.status).toBe("done");
    expect(byId.get("extra-repos")?.status).toBe("done");
    // The profile now has a test command, so the "add a verify gate" suggestion no longer applies.
    expect(byId.get("ticket:add-verify-gate")?.status).toBe("not-applicable");
  });

  it("applying a ticket step files a ticket, and re-applying it is idempotent", async () => {
    const { projectId } = await seedProject(db);
    const service = buildOnboardingServiceFor(db);

    const plan1 = await service.applyOnboardingStep(projectId, "ticket:write-readme");
    const step1 = plan1.steps.find((s) => s.id === "ticket:write-readme");
    expect(step1?.status).toBe("done");

    const issuesAfterFirst = await db.select().from(schema.issues).where(eq(schema.issues.projectId, projectId));
    expect(issuesAfterFirst.length).toBe(1);

    const plan2 = await service.applyOnboardingStep(projectId, "ticket:write-readme");
    const step2 = plan2.steps.find((s) => s.id === "ticket:write-readme");
    expect(step2?.status).toBe("done");

    const issuesAfterSecond = await db.select().from(schema.issues).where(eq(schema.issues.projectId, projectId));
    expect(issuesAfterSecond.length).toBe(1);
  });

  it("rejects an unknown step id", async () => {
    const { projectId } = await seedProject(db);
    const service = buildOnboardingServiceFor(db);
    await expect(service.applyOnboardingStep(projectId, "not-a-real-step")).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(OnboardingError).toBeDefined();
  });

  it("skip / dismiss round-trip and survive a plan rebuild", async () => {
    const { projectId } = await seedProject(db);
    const service = buildOnboardingServiceFor(db);

    const skipped = await service.skipOnboardingStep(projectId, "wip-limit");
    expect(skipped.steps.find((s) => s.id === "wip-limit")?.status).toBe("skipped");

    // Rebuilding the plan from scratch still reports the skip (persisted, not in-memory only).
    const rebuilt = await service.buildOnboardingPlan(projectId);
    expect(rebuilt.steps.find((s) => s.id === "wip-limit")?.status).toBe("skipped");
    expect(rebuilt.dismissedAt).toBeNull();

    const dismissed = await service.dismissOnboarding(projectId);
    expect(dismissed.dismissedAt).not.toBeNull();

    // A step that is later actually configured reports done, not skipped — done wins.
    await setPreference("wip_limit_" + projectId, "5", db);
    const afterConfigure = await service.buildOnboardingPlan(projectId);
    expect(afterConfigure.steps.find((s) => s.id === "wip-limit")?.status).toBe("done");
  });

  it("applying a plugin step enables it for the project", async () => {
    const { projectId } = await seedProject(db);
    const pluginRow = await upsertPluginRow({
      id: randomUUID(),
      pluginId: "test-plugin",
      name: "Test Plugin",
      sourceUrl: null,
      localPath: "C:/tmp/test-plugin",
      version: "0.1.0",
      manifestJson: JSON.stringify({ id: "test-plugin", name: "Test Plugin", version: "0.1.0" }),
    }, db);

    const service = buildOnboardingServiceFor(db);
    const before = await service.buildOnboardingPlan(projectId);
    expect(before.steps.find((s) => s.id === "plugin:test-plugin")?.status).toBe("pending");

    const after = await service.applyOnboardingStep(projectId, "plugin:test-plugin");
    expect(after.steps.find((s) => s.id === "plugin:test-plugin")?.status).toBe("done");
    expect(pluginRow.pluginId).toBe("test-plugin");
  });

  it("surfaces a plugin manifest's `init: true` skill as an init-skill step, only when the plugin is enabled", async () => {
    const { projectId } = await seedProject(db);
    await upsertPluginRow({
      id: randomUUID(),
      pluginId: "safety-net",
      name: "Safety Net",
      sourceUrl: null,
      localPath: "C:/tmp/safety-net",
      version: "0.1.0",
      manifestJson: JSON.stringify({
        id: "safety-net",
        name: "Safety Net",
        version: "0.1.0",
        skills: [{ dir: ".claude/skills/requirement-extraction", init: true, description: "Document the API surface." }],
      }),
    }, db);

    const service = buildOnboardingServiceFor(db);

    // Not enabled yet — the manifest's init skill must not appear as a step (its bundle isn't
    // materialized into any worktree until the plugin is enabled for this project).
    const before = await service.buildOnboardingPlan(projectId);
    expect(before.steps.find((s) => s.kind === "init-skill" && s.skillName === "requirement-extraction")).toBeUndefined();

    await service.applyOnboardingStep(projectId, "plugin:safety-net");

    const after = await service.buildOnboardingPlan(projectId);
    const step = after.steps.find((s) => s.kind === "init-skill" && s.skillName === "requirement-extraction");
    expect(step).toBeDefined();
    expect(step?.status).toBe("pending");
    if (step?.kind === "init-skill") {
      expect(step.source).toBe("plugin");
      expect(step.pluginSlug).toBe("safety-net");
      expect(step.id).toBe("init-skill:plugin:safety-net:requirement-extraction");
    }

    const applied = await service.applyOnboardingStep(projectId, step!.id);
    expect(applied.steps.find((s) => s.id === step!.id)?.status).toBe("done");
  });

  it("applying an init-skill step files a ticket carrying that skill", async () => {
    const { projectId } = await seedProject(db);
    await db.insert(schema.agentSkills).values({
      id: randomUUID(),
      name: "bootstrap-docs",
      description: "Write initial docs for a freshly imported project.",
      prompt: "Write CLAUDE.md.",
      projectId: null,
      isBuiltin: false,
      isInit: true,
      createdAt: NOW,
      updatedAt: NOW,
    });

    const service = buildOnboardingServiceFor(db);
    const plan = await service.buildOnboardingPlan(projectId);
    const step = plan.steps.find((s) => s.kind === "init-skill" && s.skillName === "bootstrap-docs");
    expect(step).toBeDefined();
    expect(step?.status).toBe("pending");

    const after = await service.applyOnboardingStep(projectId, step!.id);
    const afterStep = after.steps.find((s) => s.id === step!.id);
    expect(afterStep?.status).toBe("done");
  });
});
