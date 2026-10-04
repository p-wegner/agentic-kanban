import { projectPref } from "@agentic-kanban/shared/lib/dynamic-preference-keys";

/**
 * Builder context policy (#1302): what a Claude Code builder inherits from the operator's
 * personal profile.
 *
 * - `isolated` (default): `--setting-sources project,local`. Measured on the board's Claude
 *   Code: user skills drop out of the init message (122 -> 90 here), the user `CLAUDE.md` is
 *   not loaded, and user hooks are not registered. The project's `.claude/settings.json`
 *   (safety hooks, permissions), its skills and `CLAUDE.md` stay. Credentials are not a
 *   settings source, so OAuth profiles (`CLAUDE_CONFIG_DIR`) keep authenticating, and
 *   `--settings settings_<profile>.json` is a separate flag source that still applies.
 * - `inherit`: the previous launch args, unchanged.
 *
 * Provider scope: Claude CLI builders only. Codex, Copilot and Pi have no settings-source
 * lever (declared unsupported, see `BUILDER_CONTEXT_SUPPORT`); the Butler and other
 * in-process Agent SDK sessions are out of scope (they are not builders and own their
 * `settingSources`).
 */
export const BUILDER_CONTEXT_POLICIES = ["isolated", "inherit"] as const;
export type BuilderContextPolicy = (typeof BUILDER_CONTEXT_POLICIES)[number];
export const DEFAULT_BUILDER_CONTEXT_POLICY: BuilderContextPolicy = "isolated";

export const BUILDER_CONTEXT_SETTING_SOURCES = "project,local";

export const builderContextPref = projectPref("builder_context");

export const BUILDER_CONTEXT_SUPPORT: Record<string, "supported" | string> = {
  claude: "supported",
  codex: "unsupported: context comes from AGENTS.md and CODEX_HOME as a whole, no per-source switch",
  copilot: "unsupported: no settings-source switch",
  pi: "unsupported: skills and extensions are already passed explicitly by the board",
  herdr: "unsupported: Herdr hosts a pane, it is not a builder provider",
};

/**
 * The effective policy for one launch, logged so the operator can see it. Undefined when the
 * launch is not a Claude builder (the policy does not apply to it).
 */
export async function resolveBuilderContext(
  applies: boolean,
  projectId: string,
  workspaceId: string,
  readPref: (key: string) => Promise<string | null | undefined>,
): Promise<BuilderContextPolicy | undefined> {
  if (!applies) return undefined;
  const policy = parseBuilderContextPolicy(projectId ? await readPref(builderContextPref.key(projectId)) : undefined);
  console.log(`[session] builder context: ${policy} workspaceId=${workspaceId}`);
  return policy;
}

/** Unset or unrecognised values fall back to the default, never to a surprise. */
export function parseBuilderContextPolicy(value: string | null | undefined): BuilderContextPolicy {
  const v = (value ?? "").trim().toLowerCase();
  return (BUILDER_CONTEXT_POLICIES as readonly string[]).includes(v)
    ? (v as BuilderContextPolicy)
    : DEFAULT_BUILDER_CONTEXT_POLICY;
}
