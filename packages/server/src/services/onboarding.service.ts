import {
  ONBOARDING_CONFIG_STEPS,
  ONBOARDING_TICKET_CATALOG,
  emptyOnboardingState,
  onboardingUnitKey,
  parseOnboardingUnitKey,
  dbInitSkillStepId,
  pluginInitSkillStepId,
  type OnboardingConfigKey,
  type OnboardingPlan,
  type OnboardingState,
  type OnboardingStep,
  type OnboardingStepStatus,
} from "@agentic-kanban/shared/lib/onboarding-plan";
import { START_MODE_VALUES } from "@agentic-kanban/shared/lib/dynamic-preference-keys";
import { setPreferenceChecked } from "@agentic-kanban/shared/lib/checked-preference-write";
import { pluginSkillName } from "@agentic-kanban/shared/lib/plugin-manifest";
import type { Database } from "../db/index.js";
import { getProjectById } from "../repositories/project.repository.js";
import { getPreference, getAllPreferences } from "../repositories/preferences.repository.js";
import { resolveStartPolicy } from "./start-policy.service.js";
import { listProjectRepos } from "../repositories/repo.repository.js";
import { listOnboardingUnitExternalKeys } from "../repositories/onboarding.repository.js";
import { getStackProfile, verifyScriptPrefKey } from "./stack-profile.service.js";
import { createProjectService } from "./project.service.js";
import type { PluginService } from "./plugin.service.js";
import type { createAgentSkillService } from "./agent-skill.service.js";
import type { CreateIssueInput, CreateIssueResult } from "./issue.service.js";

import { toPrefMap } from "@agentic-kanban/shared/lib/preference-map";
import { strategyPrefKey } from "@agentic-kanban/shared/lib/strategy-policy";
export class OnboardingError extends Error {
  constructor(
    message: string,
    public readonly code: "NOT_FOUND" | "BAD_REQUEST" | "CONFLICT" = "BAD_REQUEST",
  ) {
    super(message);
    this.name = "OnboardingError";
  }
}

/** The per-project onboarding-state preference key (registered in `PROJECT_SCOPED_KEY_PREFIXES`). */
export function onboardingStatePreferenceKey(projectId: string): string {
  return `onboarding_state_${projectId}`;
}

type MarketplaceEntry = Awaited<ReturnType<PluginService["listMarketplace"]>>["entries"][number];
type ListedPlugin = Awaited<ReturnType<PluginService["listPlugins"]>>[number];
type ListedSkill = Awaited<ReturnType<ReturnType<typeof createAgentSkillService>["listSkills"]>>[number];

export interface OnboardingServiceDeps {
  database: Database;
  pluginService: Pick<
    PluginService,
    "listMarketplace" | "listPlugins" | "installPlugin" | "enableForProject" | "getScaffoldForm"
  >;
  agentSkillService: Pick<ReturnType<typeof createAgentSkillService>, "listSkills">;
  createIssuesBatch: (
    projectId: string,
    inputs: Omit<CreateIssueInput, "projectId">[],
  ) => Promise<{ issues: CreateIssueResult[] }>;
}

/**
 * The model + apply API behind the onboarding wizard (#463): a per-project plan of steps, each
 * either applied instantly by the board (`config`/`plugin`) or filed as a suggested ticket
 * (`init-skill`/`ticket`). Status is DERIVED from the world every time the plan is built — only
 * explicit skips and a dismissal timestamp are persisted (`onboarding_state_<projectId>`), the
 * same reasoning that keeps plugin-loop convergence restart-safe: state that can be recomputed
 * must not be duplicated, or it drifts from reality.
 */
export function createOnboardingService(deps: OnboardingServiceDeps) {
  const { database, pluginService, agentSkillService, createIssuesBatch } = deps;
  const projectService = createProjectService({ database });

  async function requireProject(projectId: string) {
    const project = await getProjectById(projectId, database);
    if (!project) throw new OnboardingError("Project not found", "NOT_FOUND");
    return project;
  }

  async function readOnboardingState(projectId: string): Promise<OnboardingState> {
    const raw = await getPreference(onboardingStatePreferenceKey(projectId), database);
    if (!raw) return emptyOnboardingState();
    try {
      const parsed = JSON.parse(raw) as Partial<OnboardingState>;
      return {
        version: 1,
        skippedStepIds: Array.isArray(parsed.skippedStepIds)
          ? parsed.skippedStepIds.filter((id): id is string => typeof id === "string")
          : [],
        dismissedAt: typeof parsed.dismissedAt === "string" ? parsed.dismissedAt : undefined,
      };
    } catch {
      return emptyOnboardingState();
    }
  }

  async function writeOnboardingState(projectId: string, state: OnboardingState): Promise<void> {
    await setPreferenceChecked(database, [
      { key: onboardingStatePreferenceKey(projectId), value: JSON.stringify(state) },
    ]);
  }

  function resolveStatus(stepId: string, done: boolean, skipped: ReadonlySet<string>): OnboardingStepStatus {
    if (done) return "done";
    if (skipped.has(stepId)) return "skipped";
    return "pending";
  }

  async function isConfigStepDone(configKey: OnboardingConfigKey, projectId: string, project: { setupScript: string | null }): Promise<boolean> {
    switch (configKey) {
      case "stack-profile":
        return (await getStackProfile(projectId, database)) !== null;
      case "setup-verify-scripts": {
        const verify = await getPreference(verifyScriptPrefKey(projectId), database);
        return Boolean(project.setupScript?.trim()) && Boolean(verify?.trim());
      }
      case "start-mode": {
        // #600 / decision 008: ask the RESOLVER, never the raw pref. A project driven by
        // the legacy `board_autodrive_<id>` flag has no `start_mode_` key, so the raw read
        // returned undefined and this step nagged "not configured" at a project that is in
        // fact auto-driven. resolveStartPolicy derives that case.
        const rows = await getAllPreferences(database);
        const prefMap = toPrefMap(rows);
        return resolveStartPolicy(prefMap, projectId).mode !== "manual";
      }
      case "wip-limit": {
        const value = await getPreference(`wip_limit_${projectId}`, database);
        return Boolean(value?.trim());
      }
      case "strategy-bullseye": {
        const value = await getPreference(strategyPrefKey(projectId), database);
        return Boolean(value?.trim());
      }
      case "extra-repos": {
        const repos = await listProjectRepos(projectId, database);
        return repos.length > 0;
      }
      default:
        return false;
    }
  }

  /** Stable across a plan rebuild: the manifest slug when known, else the (unique) git URL. */
  function pluginStepId(entry: MarketplaceEntry): string {
    return `plugin:${entry.slug ?? entry.gitUrl ?? entry.name}`;
  }

  /** Unfilled `TODO:` markers in an enabled plugin's live scaffold file, for this project. */
  async function pluginScaffoldPlaceholders(entry: MarketplaceEntry, projectId: string): Promise<number> {
    if (!entry.installed || !entry.installedId || !entry.enabled) return 0;
    try {
      const form = await pluginService.getScaffoldForm(entry.installedId, projectId);
      return form.exists ? form.fields.length : 0;
    } catch {
      return 0; // plugin declares no scaffold, or it can't be read — nothing to surface
    }
  }

  function initSkillStepId(skill: ListedSkill): string {
    return dbInitSkillStepId(skill.id);
  }

  function ticketStepId(catalogId: string): string {
    return `ticket:${catalogId}`;
  }

  async function buildOnboardingPlan(projectId: string): Promise<OnboardingPlan> {
    const project = await requireProject(projectId);
    const state = await readOnboardingState(projectId);
    const skipped = new Set(state.skippedStepIds);
    const ticketedStepIds = new Set(
      [...await listOnboardingUnitExternalKeys(projectId, database)]
        .map((key) => parseOnboardingUnitKey(key)?.stepId)
        .filter((id): id is string => Boolean(id)),
    );

    const steps: OnboardingStep[] = [];

    for (const def of ONBOARDING_CONFIG_STEPS) {
      const done = await isConfigStepDone(def.configKey, projectId, project);
      steps.push({
        id: def.id,
        kind: "config",
        title: def.title,
        rationale: def.rationale,
        optional: def.optional,
        configKey: def.configKey,
        status: resolveStatus(def.id, done, skipped),
      });
    }

    // Marketplace, not just installed rows (#473): a plugin never installed on this machine
    // is exactly what a freshly imported project should be offered — the panel's "Available"
    // section already knows about it, so the wizard would otherwise hide it entirely.
    const { entries: marketplace } = await pluginService.listMarketplace(projectId);
    for (const entry of marketplace) {
      const id = pluginStepId(entry);
      steps.push({
        id,
        kind: "plugin",
        title: `Enable "${entry.name}"`,
        rationale: entry.description || `Turns on the "${entry.name}" plugin's skills/loops/scaffold for this project.`,
        optional: true,
        pluginRowId: entry.installedId,
        pluginSlug: entry.slug,
        installSource: entry.installed ? null : entry.gitUrl,
        scaffoldPlaceholders: await pluginScaffoldPlaceholders(entry, projectId),
        status: resolveStatus(id, entry.enabled, skipped),
      });
    }

    const initSkills = await agentSkillService.listSkills(projectId, false, true);
    for (const skill of initSkills) {
      const id = initSkillStepId(skill);
      steps.push({
        id,
        kind: "init-skill",
        title: `Run "${skill.name}"`,
        rationale: skill.description || "A one-time init skill for a freshly imported project.",
        optional: true,
        source: "db",
        skillId: skill.id,
        skillName: skill.name,
        status: resolveStatus(id, ticketedStepIds.has(id), skipped),
      });
    }

    // A plugin's own manifest-declared entry skill (`skills[].init: true`, #462) is read by
    // NOTHING today — `listSkills(projectId, false, true)` above deliberately returns only DB
    // rows, so a plugin's init skill (e.g. refactor-safety-net's API-documenting entry skill)
    // could never surface here. Merge it in for every ENABLED plugin, alongside the DB-backed
    // init skills above — a disabled plugin's skill is not materialized into any worktree
    // (`materializeEnabledPluginSkills`), so it would resolve to a file that isn't there.
    // `listMarketplace`'s entries don't carry the full manifest (just a description), so the
    // installed rows are fetched separately here for their `manifest.skills`.
    const installedPlugins: ListedPlugin[] = await pluginService.listPlugins(projectId);
    for (const plugin of installedPlugins) {
      if (!(plugin as { enabled?: boolean }).enabled) continue;
      for (const skillDef of plugin.manifest?.skills ?? []) {
        if (!skillDef.init) continue;
        const skillName = pluginSkillName(skillDef.dir);
        const id = pluginInitSkillStepId(plugin.pluginId, skillName);
        steps.push({
          id,
          kind: "init-skill",
          title: `Run "${skillName}"`,
          rationale: skillDef.description || `The "${plugin.name}" plugin's entry skill for a freshly imported project.`,
          optional: true,
          source: "plugin",
          pluginSlug: plugin.pluginId,
          skillName,
          status: resolveStatus(id, ticketedStepIds.has(id), skipped),
        });
      }
    }

    for (const entry of ONBOARDING_TICKET_CATALOG) {
      const id = ticketStepId(entry.id);
      const applicable = entry.appliesWhen(await getStackProfile(projectId, database));
      steps.push({
        id,
        kind: "ticket",
        title: entry.title,
        rationale: entry.description,
        optional: entry.optional,
        catalogId: entry.id,
        status: !applicable ? "not-applicable" : resolveStatus(id, ticketedStepIds.has(id), skipped),
      });
    }

    return { projectId, steps, dismissedAt: state.dismissedAt ?? null };
  }

  /** File a ticket for a `ticket`/`init-skill` step, deduped by its unit key (idempotent). */
  async function fileOnboardingTicket(
    projectId: string,
    stepId: string,
    ticket: { title: string; description: string; priority?: "low" | "medium" | "high" | "critical" },
  ): Promise<void> {
    const externalKey = onboardingUnitKey(projectId, stepId);
    const existing = await listOnboardingUnitExternalKeys(projectId, database);
    if (existing.has(externalKey)) return;
    await createIssuesBatch(projectId, [{
      title: ticket.title,
      description: ticket.description,
      priority: ticket.priority ?? "medium",
      externalKey,
    }]);
  }

  async function applyConfigStep(
    projectId: string,
    configKey: OnboardingConfigKey,
    input: Record<string, unknown> | undefined,
  ): Promise<void> {
    switch (configKey) {
      case "stack-profile": {
        // Nothing to write: this step just reflects that scaffolding has already computed a
        // profile. Confirming with nothing to confirm yet is a mistake, not a no-op.
        if (!(await getStackProfile(projectId, database))) {
          throw new OnboardingError("No detected stack profile to confirm yet", "BAD_REQUEST");
        }
        return;
      }
      case "setup-verify-scripts": {
        const setupScript = typeof input?.setupScript === "string" ? input.setupScript : undefined;
        const verifyScript = typeof input?.verifyScript === "string" ? input.verifyScript : undefined;
        if (setupScript === undefined && verifyScript === undefined) {
          throw new OnboardingError("setupScript and/or verifyScript is required", "BAD_REQUEST");
        }
        if (setupScript !== undefined) await projectService.updateProject(projectId, { setupScript });
        if (verifyScript !== undefined) {
          await setPreferenceChecked(database, [
            { key: verifyScriptPrefKey(projectId), value: verifyScript },
          ]);
        }
        return;
      }
      case "start-mode": {
        const value = input?.value;
        if (typeof value !== "string" || !START_MODE_VALUES.includes(value as (typeof START_MODE_VALUES)[number])) {
          throw new OnboardingError(`value must be one of ${START_MODE_VALUES.join(", ")}`, "BAD_REQUEST");
        }
        await setPreferenceChecked(database, [
          { key: `start_mode_${projectId}`, value },
        ]);
        return;
      }
      case "wip-limit": {
        const value = input?.value;
        if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
          throw new OnboardingError("value must be a positive number", "BAD_REQUEST");
        }
        await setPreferenceChecked(database, [
          { key: `wip_limit_${projectId}`, value: String(value) },
        ]);
        return;
      }
      case "strategy-bullseye": {
        const value = input?.value;
        if (typeof value !== "string" || !value.trim()) {
          throw new OnboardingError("value must be a non-empty JSON string", "BAD_REQUEST");
        }
        await setPreferenceChecked(database, [
          { key: strategyPrefKey(projectId), value },
        ]);
        return;
      }
      case "extra-repos":
        throw new OnboardingError("extra-repos is managed via POST /api/projects/:id/repos", "BAD_REQUEST");
    }
  }

  async function applyOnboardingStep(
    projectId: string,
    stepId: string,
    input?: Record<string, unknown>,
  ): Promise<OnboardingPlan> {
    await requireProject(projectId);
    const plan = await buildOnboardingPlan(projectId);
    const step = plan.steps.find((s) => s.id === stepId);
    if (!step) throw new OnboardingError(`Unknown onboarding step "${stepId}"`, "BAD_REQUEST");

    switch (step.kind) {
      case "config":
        await applyConfigStep(projectId, step.configKey, input);
        break;
      case "plugin": {
        // #473: enabling scaffolds immediately (#318), so the leading/sidecar choice must
        // arrive WITH the enable call, exactly like the plugin panel — never defaulted here.
        const location = input?.location;
        if (location !== "leading" && location !== "sidecar") {
          throw new OnboardingError("input.location must be \"leading\" or \"sidecar\"", "BAD_REQUEST");
        }
        let pluginRowId = step.pluginRowId;
        if (!pluginRowId) {
          if (!step.installSource) {
            throw new OnboardingError("This plugin has no install source", "BAD_REQUEST");
          }
          pluginRowId = (await pluginService.installPlugin({ source: step.installSource })).id;
        }
        await pluginService.enableForProject(pluginRowId, projectId, location);
        break;
      }
      case "init-skill":
        await fileOnboardingTicket(projectId, step.id, {
          title: `Run skill: ${step.skillName}`,
          description: `Run the "${step.skillName}" init skill against this freshly imported project — a one-time pass a codebase that has never used this skill needs before its other work is useful. The workspace launched from this ticket is bound to this skill automatically (via its external key); no manual skill selection is needed.`,
        });
        break;
      case "ticket": {
        const entry = ONBOARDING_TICKET_CATALOG.find((e) => e.id === step.catalogId);
        if (!entry) throw new OnboardingError("Unknown ticket catalog entry", "BAD_REQUEST");
        await fileOnboardingTicket(projectId, step.id, {
          title: entry.title,
          description: entry.description,
          priority: entry.priority,
        });
        break;
      }
    }

    return buildOnboardingPlan(projectId);
  }

  async function skipOnboardingStep(projectId: string, stepId: string): Promise<OnboardingPlan> {
    await requireProject(projectId);
    const state = await readOnboardingState(projectId);
    if (!state.skippedStepIds.includes(stepId)) state.skippedStepIds.push(stepId);
    await writeOnboardingState(projectId, state);
    return buildOnboardingPlan(projectId);
  }

  async function dismissOnboarding(projectId: string): Promise<OnboardingPlan> {
    await requireProject(projectId);
    const state = await readOnboardingState(projectId);
    state.dismissedAt = new Date().toISOString();
    await writeOnboardingState(projectId, state);
    return buildOnboardingPlan(projectId);
  }

  return { buildOnboardingPlan, applyOnboardingStep, skipOnboardingStep, dismissOnboarding };
}

export type OnboardingService = ReturnType<typeof createOnboardingService>;
