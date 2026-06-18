// Runtime provider/model option lists + validation logic.
//
// These live OUTSIDE types/api.ts (the hand-authored wire CONTRACT) so that file can
// stay PURE types and be re-exported as `export type *` — guaranteeing it can never
// poison the client bundle. This module is pure (no imports, no node builtins), so it
// is safe to re-export through the client-reachable lib barrel.

/**
 * Selectable Claude model tiers. The value (`""` = profile default) is passed to the
 * `claude` CLI via `--model`. Only applies to Claude profiles; for profiles that define a
 * custom `ANTHROPIC_BASE_URL` (e.g. z.ai/glm), `--model` is omitted server-side so the
 * profile's own `ANTHROPIC_MODEL` env wins.
 */
export const CLAUDE_MODEL_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "", label: "Profile default" },
  { value: "opus", label: "Opus" },
  { value: "sonnet", label: "Sonnet" },
  { value: "haiku", label: "Haiku" },
];

/**
 * Selectable Codex models. Empty means the Codex profile/config default is used.
 */
export const CODEX_MODEL_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "", label: "Profile default" },
  { value: "gpt-5.5", label: "GPT-5.5" },
  { value: "gpt-5.4", label: "GPT-5.4" },
  { value: "gpt-5.4-mini", label: "GPT-5.4 Mini" },
  { value: "gpt-5.3-codex", label: "GPT-5.3 Codex" },
  { value: "gpt-5.3-codex-spark", label: "GPT-5.3 Codex Spark" },
  { value: "gpt-5.2", label: "GPT-5.2" },
];

/**
 * Decide whether a stored `default_model` id belongs to the given provider's model
 * family. The `default_model` preference is a single, provider-agnostic value, so a
 * leftover Codex id (e.g. `gpt-5.5`) can survive a switch to Claude and then get passed
 * as `--model gpt-5.5` to `claude.exe`, which dies in ~5s with an invalid-model error.
 * Callers use this to drop a mismatched model rather than launch a doomed agent.
 *
 * Claude model ids are the short tier names (`opus`/`sonnet`/`haiku`, plus dated/explicit
 * `claude-*` ids); Codex ids are the `gpt-*` family. Empty/unknown ids return `true` so we
 * never strip a value we don't recognize (e.g. a custom profile model).
 */
export function modelBelongsToProvider(
  model: string | undefined | null,
  provider: "claude" | "codex" | "copilot" | "pi",
): boolean {
  const id = (model ?? "").trim().toLowerCase();
  if (!id) return true;
  const isCodexModel = id.startsWith("gpt-") || id.startsWith("o1") || id.startsWith("o3") || id.startsWith("o4");
  const isClaudeModel = id === "opus" || id === "sonnet" || id === "haiku" || id.startsWith("claude-");
  if (provider === "claude") {
    // Reject anything that clearly belongs to Codex; otherwise allow (unknown/custom ids pass through).
    return !isCodexModel;
  }
  if (provider === "codex") {
    return !isClaudeModel;
  }
  if (provider === "pi") {
    // Pi routes through provider-scoped profiles (for example openai/* or anthropic/*),
    // so both known Claude/Codex model families and custom ids are valid here.
    return true;
  }
  // copilot has no model flag; nothing to validate.
  return true;
}
