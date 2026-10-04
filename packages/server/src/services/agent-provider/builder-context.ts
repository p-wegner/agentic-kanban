import { projectPref } from "@agentic-kanban/shared/lib/dynamic-preference-keys";
import type { BuilderContext, BuilderEffort } from "./types.js";

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

/**
 * Session tuning the board pins on a Claude builder's command line, so it is a board decision
 * and not whatever `effortLevel` / `autoCompactWindow` the operator's user settings carry.
 * Isolation drops the user settings, so without these an isolated builder silently ran on the
 * CLI defaults instead of the values the user scope used to supply. Under `isolated` the
 * defaults below apply; under `inherit` only a pref the operator set is passed, so the default
 * inherit launch stays byte-identical to the pre-#1302 one.
 */
export const builderEffortPref = projectPref("builder_effort");
export const builderAutocompactPref = projectPref("builder_autocompact");
export const BUILDER_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const satisfies readonly BuilderEffort[];
export const DEFAULT_BUILDER_EFFORT: BuilderEffort = "medium";
export const DEFAULT_BUILDER_AUTOCOMPACT = "500000";
// The types live in `types.ts`, which the worker binary imports: declaring them here would pull
// this module (and its shared import) into the worker's graph (worker-cli-isolation.test.ts).
export type { BuilderContext, BuilderEffort };

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
): Promise<BuilderContext | undefined> {
  if (!applies) return undefined;
  const read = async (key: string) => (projectId ? await readPref(key) : undefined);
  const policy = parseBuilderContextPolicy(await read(builderContextPref.key(projectId)));
  const isolated = policy === "isolated";
  const effort = parseBuilderEffort(await read(builderEffortPref.key(projectId))) ?? (isolated ? DEFAULT_BUILDER_EFFORT : undefined);
  const autocompact = parseBuilderAutocompact(await read(builderAutocompactPref.key(projectId))) ?? (isolated ? DEFAULT_BUILDER_AUTOCOMPACT : undefined);
  console.log(`[session] builder context: ${policy} effort=${effort ?? "-"} autocompact=${autocompact ?? "-"} workspaceId=${workspaceId}`);
  return { policy, ...(effort ? { effort } : {}), ...(autocompact ? { autocompact } : {}) };
}

/** A recognised effort level, or undefined (unset or unknown: the default decides). */
export function parseBuilderEffort(value: string | null | undefined): BuilderEffort | undefined {
  const v = (value ?? "").trim().toLowerCase();
  return (BUILDER_EFFORT_LEVELS as readonly string[]).includes(v) ? (v as BuilderEffort) : undefined;
}

/** `auto` or an integer token count in the CLI's 100k–1M range, or undefined. */
export function parseBuilderAutocompact(value: string | null | undefined): string | undefined {
  const v = (value ?? "").trim().toLowerCase();
  if (v === "auto") return v;
  const n = Number(v);
  return v !== "" && Number.isInteger(n) && n >= 100_000 && n <= 1_000_000 ? String(n) : undefined;
}

/** Unset or unrecognised values fall back to the default, never to a surprise. */
export function parseBuilderContextPolicy(value: string | null | undefined): BuilderContextPolicy {
  const v = (value ?? "").trim().toLowerCase();
  return (BUILDER_CONTEXT_POLICIES as readonly string[]).includes(v)
    ? (v as BuilderContextPolicy)
    : DEFAULT_BUILDER_CONTEXT_POLICY;
}
