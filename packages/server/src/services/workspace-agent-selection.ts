/**
 * Which agent, provider and profile a workspace actually launches on.
 *
 * Split out of `workspace-internals.ts` when #1047's launch-time profile override pushed
 * that file past the god-module ceiling. It is a cohesive concern rather than a slice taken
 * to hit a line count: these three functions are the whole answer to "who runs this
 * workspace", they are the only readers of the provider/profile columns on the workspace
 * row, and every other caller reaches them through the `workspace-internals` barrel, which
 * re-exports them so no import site had to move.
 */
import type { workspaces } from "@agentic-kanban/shared/schema";
import { isProfileCooling } from "@agentic-kanban/shared/lib/profile-roster";
import type { Database } from "../db/index.js";
import type { ProviderName } from "./agent-provider.js";
import type { AgentSettings } from "./agent-settings.service.js";
import { loadProjectRuntimeConfig } from "./project-runtime-config.service.js";
import { WorkspaceError } from "./workspace-error.js";

/**
 * #1048: the pinned profile still wins unconditionally when the ring reports it cooling —
 * a default relaunch (monitor auto-relaunch, the UI button, `workspace resume` with no
 * flag) would then launch straight into the same exhausted account it just failed on and
 * exit in ~6 seconds. `prefMap` carries the `<provider>_cooldown_<profile>` stamps the
 * rotation rings write (`auth-rotation-ring.ts`); when it is absent (a caller with no
 * prefs at hand) the pin is honored exactly as before — this only NARROWS the pin, it
 * never invents a new one.
 */
export function applyWorkspaceAgentSelection(
  settings: AgentSettings,
  workspace: typeof workspaces.$inferSelect,
  prefMap?: Map<string, string>,
  nowMs: number = Date.now(),
): AgentSettings {
  const provider = workspace.provider;
  if (provider !== "claude" && provider !== "codex" && provider !== "copilot" && provider !== "pi") return settings;

  // A profile pinned on the RECORD wins; otherwise inherit the board's current default
  // (which `resolveAgentSettings` already resolved from `claude_profile`) instead of
  // dropping it. Overwriting unconditionally meant a workspace row with a null profile —
  // the normal case, since nothing pins one — silently erased the configured default, so
  // the launch fell through to whatever CLAUDE_CONFIG_DIR the SERVER process happened to
  // inherit. Symptom: setting the default profile had no effect on builders at all, and
  // the resulting agent ran under a different (possibly quota-exhausted) subscription
  // than the one configured. `profile` is what `resolveProviderRotation` keys off to set
  // CLAUDE_CONFIG_DIR, so erasing it also disabled OAuth-subscription selection entirely.
  //
  // Only inherit a selection tagged for THIS workspace's provider — a claude profile name
  // must never leak into a codex/copilot/pi launch.
  const inheritedProfile = settings.profile?.provider === provider ? settings.profile.name : undefined;
  const pinnedProfile = workspace.claudeProfile || undefined;
  const pinnedIsCooling = Boolean(
    pinnedProfile && prefMap && isProfileCooling({ provider, name: pinnedProfile }, prefMap, nowMs),
  );
  const profileName = (pinnedIsCooling ? undefined : pinnedProfile) ?? inheritedProfile;
  const agentArgs = provider === "claude"
    ? settings.agentArgs
    : settings.agentArgs
      ?.split(/\s+/)
      .filter((arg) => arg && arg !== "--dangerously-skip-permissions")
      .join(" ") || undefined;
  return {
    ...settings,
    agentArgs,
    provider,
    profile: profileName ? { provider: provider as ProviderName, name: profileName } : undefined,
  };
}

/**
 * The profile a launch body names, or `null` when it names none (#1047).
 *
 * Two spellings, both already in the create-workspace vocabulary so a caller does not have
 * to learn a third: `profile: { provider?, name }` and the legacy `claudeProfile: "<name>"`.
 * The bare string inherits the workspace's own provider — a claude profile name must never
 * be handed to a codex/copilot/pi launch.
 *
 * A blank or non-string name is NOT an override: it must fall through to today's resolution
 * rather than be read as "no profile", which would erase the selection entirely.
 */
export function readLaunchProfileOverride(
  body: Record<string, unknown>,
  workspaceProvider: string | null | undefined,
): { provider?: string; name: string } | null {
  const structured = body.profile;
  if (structured && typeof structured === "object" && !Array.isArray(structured)) {
    const { provider, name } = structured as { provider?: unknown; name?: unknown };
    if (typeof name === "string" && name.trim()) {
      return {
        provider: typeof provider === "string" && provider.trim() ? provider.trim() : (workspaceProvider ?? undefined),
        name: name.trim(),
      };
    }
  }
  const legacy = body.claudeProfile;
  if (typeof legacy === "string" && legacy.trim()) {
    return { provider: workspaceProvider ?? undefined, name: legacy.trim() };
  }
  return null;
}

/**
 * Resolve the agent selection for a *relaunched* session (fix-and-merge / conflict
 * resolver) honoring the board's CURRENT default rather than the provider baked
 * into the workspace record at original creation time (#762).
 *
 * A fresh-workspace POST resolves its provider from the Strategy Bullseye default
 * (`selectProviderFromStrategy`); a relaunch historically read only
 * `workspace.provider`, so after changing the board default, resolver sessions
 * still ran under the stale provider and needed a manual stop → PATCH → relaunch.
 *
 * This re-reads the current strategy default at launch time, the same fan-out the
 * POST uses. When no strategy default is configured (selection is `null`) it falls
 * back to the workspace's baked provider via `applyWorkspaceAgentSelection`, which
 * also preserves any provider explicitly pinned on the record.
 */
export async function resolveRelaunchAgentSelection(
  database: Database,
  projectId: string | null | undefined,
  workspace: typeof workspaces.$inferSelect,
  commandOverride?: string,
  profileOverride?: { provider?: string; name?: string } | null,
): Promise<AgentSettings> {
  const runtime = await loadProjectRuntimeConfig(database, {
    projectId: projectId ?? "",
    workspaceSelection: {
      provider: workspace.provider,
      profileName: workspace.claudeProfile,
    },
    commandOverride,
    // #1047: an explicit profile named by the caller outranks the profile baked onto the
    // workspace row. Without it a builder whose pinned account hit its usage limit could
    // only ever be relaunched onto that same exhausted account — the row pin wins in
    // `applyWorkspaceAgentSelection`, no endpoint re-pins it, and the only escape was
    // delete + recreate, which destroys the uncommitted work that is the reason to relaunch.
    // It is an override, NOT a bypass: `resolveProjectRuntimeConfig` is still the one
    // enforcement seam, so a `forbidden` profile is refused here exactly as anywhere else.
    profileOverride: profileOverride ?? null,
    // A caller naming a profile IS the explicit operator start that grants `reserve` —
    // the same grant a human pressing start gets, and the reason to name one at all.
    operatorStart: Boolean(profileOverride?.name),
  });
  if (runtime.provider.source === "strategy" || runtime.provider.source === "explicit-profile") {
    console.log(`[relaunch] ${runtime.provider.source} provider selection: ${runtime.provider.provider}:${runtime.provider.profileName ?? ""} (workspace baked=${workspace.provider}:${workspace.claudeProfile})`);
  }

  // #1047: the roster's verdict is only ACTED ON for an explicit override. The resolver has
  // always computed `profileHold` here and this helper has always ignored it, so the other
  // relaunch paths (fix-and-merge, conflict resolver, batch reconciler) keep the behaviour
  // they have today — narrowing that is its own change, and doing it in passing would turn
  // a relaunch that works into a refusal. What must NOT happen is the new override becoming
  // the one door that walks past the seam: a `forbidden` account has to stay unreachable
  // however the caller asks for it, or the global roster is liftable by anyone who can POST
  // a launch. Same two-way split as `workspace-create.service.ts` — refused vs. wait.
  if (profileOverride?.name && runtime.provider.profileHold) {
    throw new WorkspaceError(
      runtime.provider.profileRefused
        ? `Profile roster refuses this launch: ${runtime.provider.profileHold}. Pick a permitted profile, or change the project's roster.`
        : `Profile allowlist blocks this launch: ${runtime.provider.profileHold}. Wait for an allowed profile to become available, or change the project's allowed profiles.`,
      "CONFLICT",
      { code: runtime.provider.profileRefused ? "PROFILE_FORBIDDEN" : "PROFILE_ALLOWLIST_HOLD" },
    );
  }

  return {
    agentCommand: runtime.provider.agentCommand,
    agentArgs: runtime.provider.agentArgs,
    profile: runtime.provider.profileSelection,
    provider: runtime.provider.provider,
    resumeWithNewModel: runtime.provider.resumeWithNewModel,
    permissionPromptTool: runtime.provider.permissionPromptTool,
    model: runtime.provider.model,
  };
}
