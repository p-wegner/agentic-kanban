/**
 * Onboarding plan model (#463): the step catalog and pure key derivations shared by the
 * server (which builds/applies the plan) and the client (which renders it, sibling ticket).
 * Pure strings + data, no Node builtins — safe as a value export for the client bundle.
 *
 * A project registered today is only half board-ready — `scaffoldAndPopulateProject` derives
 * the stack profile and stops; Start Mode, WIP, the Strategy Bullseye, plugins and an initial
 * backlog are left for the user to find in Settings or never happen. This plan surfaces that
 * remaining setup as a checklist: a `config`/`plugin` step is applied by the board instantly, an
 * `init-skill`/`ticket` step files a ticket instead (every agent-shaped step goes through the
 * normal workspace/review/merge flow — nothing here auto-runs an agent).
 */
import type { StackProfile } from "../types/api/project.js";

export type OnboardingStepKind = "config" | "plugin" | "init-skill" | "ticket";

export type OnboardingStepStatus = "done" | "pending" | "skipped" | "not-applicable";

/**
 * The fixed set of instant, board-applied config steps. `configKey` is what the server's plan
 * builder reads the world by (a preference key or project column) to derive `status` — status is
 * never persisted, only computed, so it can never drift from reality (same reasoning as plugin
 * loop convergence).
 */
export type OnboardingConfigKey =
  | "stack-profile"
  | "setup-verify-scripts"
  | "start-mode"
  | "wip-limit"
  | "strategy-bullseye"
  | "extra-repos";

interface OnboardingStepCommon {
  id: string;
  title: string;
  /** One line — why this matters for THIS project. */
  rationale: string;
  status: OnboardingStepStatus;
  optional: boolean;
}

export interface OnboardingConfigStep extends OnboardingStepCommon {
  kind: "config";
  configKey: OnboardingConfigKey;
}

export interface OnboardingPluginStep extends OnboardingStepCommon {
  kind: "plugin";
  /** The installed plugin's DB row id — null when this is a marketplace-only entry
   *  never installed on this machine (applying it installs first). */
  pluginRowId: string | null;
  /** The plugin's manifest id — null for a catalog entry that declares no slug. */
  pluginSlug: string | null;
  /** Install source (git URL) for a not-yet-installed marketplace entry; null once installed. */
  installSource: string | null;
  /** Unfilled `TODO:` markers left in this plugin's scaffold file for this project —
   *  0 when not enabled yet, the plugin declares no scaffold, or nothing is unfilled. */
  scaffoldPlaceholders: number;
}

export interface OnboardingInitSkillStep extends OnboardingStepCommon {
  kind: "init-skill";
  skillName: string;
  /**
   * Where this init skill comes from (#474): `"db"` is a DB-row skill (a builtin or a
   * user-created one flagged `isInit`); `"plugin"` is a manifest-declared `skills[].init`
   * entry of an ENABLED plugin, which has no `agent_skills` row at all — it is a disk skill
   * materialized from the plugin's checkout. The launch-time resolver needs to tell these
   * apart to know whether to resolve `skillId` against the DB or `pluginSlug`+`skillName`
   * against the plugin's manifest.
   */
  source: "db" | "plugin";
  /** DB row id — set only when `source === "db"`. */
  skillId?: string;
  /** Owning plugin slug — set only when `source === "plugin"`. */
  pluginSlug?: string;
}

export interface OnboardingTicketStep extends OnboardingStepCommon {
  kind: "ticket";
  catalogId: string;
}

export type OnboardingStep =
  | OnboardingConfigStep
  | OnboardingPluginStep
  | OnboardingInitSkillStep
  | OnboardingTicketStep;

export interface OnboardingPlan {
  projectId: string;
  steps: OnboardingStep[];
  dismissedAt: string | null;
}

export const ONBOARDING_STATE_VERSION = 1 as const;

/** Persisted in `onboarding_state_<projectId>` — everything else is derived, never stored. */
export interface OnboardingState {
  version: typeof ONBOARDING_STATE_VERSION;
  skippedStepIds: string[];
  dismissedAt?: string;
}

export function emptyOnboardingState(): OnboardingState {
  return { version: ONBOARDING_STATE_VERSION, skippedStepIds: [] };
}

export function parseOnboardingState(raw: string | null | undefined): OnboardingState {
  if (!raw) return emptyOnboardingState();
  try {
    const parsed = JSON.parse(raw) as Partial<OnboardingState>;
    if (!Array.isArray(parsed.skippedStepIds)) return emptyOnboardingState();
    return {
      version: ONBOARDING_STATE_VERSION,
      skippedStepIds: parsed.skippedStepIds.filter((id): id is string => typeof id === "string"),
      dismissedAt: typeof parsed.dismissedAt === "string" ? parsed.dismissedAt : undefined,
    };
  } catch {
    return emptyOnboardingState();
  }
}

/**
 * Dedupe key stamped onto every ticket an onboarding step files, and matched against on the
 * next plan build so a step already ticketed is never re-ticketed (idempotence). `:`-joined,
 * mirroring `pluginLoopUnitKey` (plugin-keys.ts) — the project id is a UUID (colon-free), so the
 * split is unambiguous; the tail (`stepId`) is unconstrained.
 */
/** The `LIKE`-safe prefix of every unit key for a project, before the step id tail. */
export function onboardingUnitKeyPrefix(projectId: string): string {
  return `onboarding:${projectId}:`;
}

export function onboardingUnitKey(projectId: string, stepId: string): string {
  return `${onboardingUnitKeyPrefix(projectId)}${stepId}`;
}

/** Inverse of {@link onboardingUnitKey}. Returns null for anything that is not an onboarding key. */
export function parseOnboardingUnitKey(
  externalKey: string | null | undefined,
): { projectId: string; stepId: string } | null {
  if (!externalKey || !externalKey.startsWith("onboarding:")) return null;
  const rest = externalKey.slice("onboarding:".length);
  const firstColon = rest.indexOf(":");
  if (firstColon <= 0) return null;
  const projectId = rest.slice(0, firstColon);
  const stepId = rest.slice(firstColon + 1);
  if (!stepId) return null;
  return { projectId, stepId };
}

/**
 * Step id of a DB-row init-skill step (a builtin or user-created skill flagged `isInit`).
 * Unchanged from #463/#462 — a UUID skill id, so it can never collide with the `"plugin:"`
 * prefix a manifest-declared init skill's step id below starts with.
 */
export function dbInitSkillStepId(skillId: string): string {
  return `init-skill:${skillId}`;
}

/**
 * Step id of a plugin manifest-declared init skill (`skills[].init: true`, #474) — a disk
 * skill with no `agent_skills` row, so it can't be identified by a DB id. `pluginSlug` matches
 * `PLUGIN_ID_PATTERN` (colon-free), so the first-colon split in {@link parseInitSkillStepId}
 * is unambiguous; `skillName` (a `skills[].dir` basename) is the unconstrained tail.
 */
export function pluginInitSkillStepId(pluginSlug: string, skillName: string): string {
  return `init-skill:plugin:${pluginSlug}:${skillName}`;
}

/**
 * Inverse of {@link dbInitSkillStepId} / {@link pluginInitSkillStepId} — recognises an
 * init-skill step id (as embedded in an onboarding ticket's `external_key` via
 * {@link onboardingUnitKey}) and identifies which skill it names. Returns null for anything
 * that is not an init-skill step id.
 */
export function parseInitSkillStepId(
  stepId: string,
): { source: "db"; skillId: string } | { source: "plugin"; pluginSlug: string; skillName: string } | null {
  if (!stepId.startsWith("init-skill:")) return null;
  const rest = stepId.slice("init-skill:".length);
  if (!rest) return null;
  if (rest.startsWith("plugin:")) {
    const tail = rest.slice("plugin:".length);
    const firstColon = tail.indexOf(":");
    if (firstColon <= 0) return null;
    const pluginSlug = tail.slice(0, firstColon);
    const skillName = tail.slice(firstColon + 1);
    if (!skillName) return null;
    return { source: "plugin", pluginSlug, skillName };
  }
  return { source: "db", skillId: rest };
}

export interface OnboardingConfigStepDef {
  id: string;
  configKey: OnboardingConfigKey;
  title: string;
  rationale: string;
  optional: boolean;
}

/**
 * The fixed catalog of instant config steps. Order is presentation order. `stack-profile` and
 * `setup-verify-scripts` are required (a project the board can't safely provision/verify isn't
 * really board-ready); the rest are optional — a project can be driven hands-off without ever
 * touching Start Mode/WIP/Bullseye/extra repos.
 */
export const ONBOARDING_CONFIG_STEPS: readonly OnboardingConfigStepDef[] = [
  {
    id: "stack-profile",
    configKey: "stack-profile",
    title: "Confirm the detected stack profile",
    rationale: "The board runs your setup/verify/test commands from this profile — an unconfirmed guess can be wrong for a repo it just cloned.",
    optional: false,
  },
  {
    id: "setup-verify-scripts",
    configKey: "setup-verify-scripts",
    title: "Set the setup and verify scripts",
    rationale: "Setup provisions a fresh worktree and verify is the pre-merge gate — without both, the board can't safely install deps or block a broken merge.",
    optional: false,
  },
  {
    id: "start-mode",
    configKey: "start-mode",
    title: "Choose a Start Mode",
    rationale: "Start Mode decides whether anything auto-starts from the backlog — it defaults to manual, so nothing runs hands-off until you pick one.",
    optional: true,
  },
  {
    id: "wip-limit",
    configKey: "wip-limit",
    title: "Set a WIP limit",
    rationale: "Caps how many tickets the monitor starts at once, so a freshly-populated backlog doesn't launch a flood of agents together.",
    optional: true,
  },
  {
    id: "strategy-bullseye",
    configKey: "strategy-bullseye",
    title: "Set the Strategy Bullseye",
    rationale: "Picks the provider/profile the monitor and Conductor launch agents with for this project.",
    optional: true,
  },
  {
    id: "extra-repos",
    configKey: "extra-repos",
    title: "Register any extra repos",
    rationale: "A multi-repo project needs its sibling repos registered before a ticket can touch them.",
    optional: true,
  },
] as const;

export interface OnboardingTicketCatalogEntry {
  id: string;
  title: string;
  description: string;
  priority: "low" | "medium" | "high" | "critical";
  optional: boolean;
  /** Whether this suggestion is worth filing for a project with this stack profile (or none yet). */
  appliesWhen: (profile: StackProfile | null) => boolean;
}

/**
 * The small, static catalog of stack-aware ticket suggestions. Deliberately short — this is a
 * starter set for an empty backlog, not a taxonomy of everything a project could ever need.
 */
export const ONBOARDING_TICKET_CATALOG: readonly OnboardingTicketCatalogEntry[] = [
  {
    id: "document-context",
    title: "Document the project context (CLAUDE.md / AGENTS.md)",
    description: "Write a CLAUDE.md (or AGENTS.md) capturing what this project is, its architecture, and any hard constraints an agent driving tickets here needs to know up front.",
    priority: "medium",
    optional: true,
    appliesWhen: () => true,
  },
  {
    id: "add-verify-gate",
    title: "Add a verify gate and a first test",
    description: "This project has no detected test command. Add a minimal test setup and a first passing test, then wire it into the verify script so the merge gate has something real to check.",
    priority: "high",
    optional: false,
    appliesWhen: (profile) => !profile?.testCommand,
  },
  {
    id: "write-readme",
    title: "Write a README",
    description: "Add a README covering what the project does, how to install it, and how to run it — the front door for anyone (human or agent) landing here cold.",
    priority: "low",
    optional: true,
    appliesWhen: () => true,
  },
  {
    id: "setup-ci",
    title: "Set up CI",
    description: "Add a CI workflow that runs the project's build/lint/test commands on every push, so regressions are caught before they reach a reviewer.",
    priority: "medium",
    optional: true,
    appliesWhen: () => true,
  },
  {
    id: "explore-and-file-followups",
    title: "Explore the codebase and file follow-up tickets",
    description: "Spend a pass exploring the codebase (structure, hotspots, obvious gaps) and file well-scoped follow-up tickets for what you find — a starter pass so the backlog isn't empty.",
    priority: "low",
    optional: true,
    appliesWhen: () => true,
  },
] as const;
